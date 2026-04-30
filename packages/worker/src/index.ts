import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { metadataClient } from "@mariozechner/pi-metadata-client";
import { Redis } from "ioredis";
import { consumerGroup, consumerName, controlChannel, inputQueue, outputQueue, owner, redisUrl } from "./config.js";
import { error, log } from "./logger.js";
import { RedisSessionStore } from "./session-store.js";
import type { WorkerControlSignal, WorkerResponse, WorkerTask } from "./types.js";

async function main() {
	const stateDir = process.env["PI-STATE-DIR"] || join(homedir(), ".pi");
	const agentDir = join(stateDir, "agent");
	const workspaceDir = process.env["PI-WORKSPACE-DIR"] || join(agentDir, "workspace");

	log(`State directory: ${stateDir}`);
	log(`Workspace directory: ${workspaceDir}`);

	const redis = new Redis(redisUrl);
	const redisPublisher = new Redis(redisUrl);
	const redisSubscriber = new Redis(redisUrl);
	const redisSessionStore = RedisSessionStore.fromEnv(redisPublisher, owner, log);

	const settingsManager = SettingsManager.create(workspaceDir, agentDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));

	// Ensure consumer group exists
	try {
		await redis.xgroup("CREATE", inputQueue, consumerGroup, "$", "MKSTREAM");
		log(`Created consumer group ${consumerGroup} for stream ${inputQueue}`);
	} catch (err: any) {
		if (!err.message.includes("BUSYGROUP")) {
			error(`Failed to create consumer group: ${err.message}`);
		}
	}

	let currentTaskId: string | undefined;
	let currentAgent: any = null;

	redisSubscriber.on("message", async (_channel, rawSignal) => {
		try {
			const signal: WorkerControlSignal = JSON.parse(rawSignal);
			if (signal.command === "stop" && currentAgent) {
				currentAgent.abort();
			}
		} catch (_e) {}
	});
	await redisSubscriber.subscribe(controlChannel);

	while (true) {
		try {
			const result = await redis.xreadgroup(
				"GROUP",
				consumerGroup,
				consumerName,
				"COUNT",
				1,
				"BLOCK",
				0,
				"STREAMS",
				inputQueue,
				">",
			);

			if (!result || (result as any).length === 0) continue;

			const [_, messages] = (result as any)[0];
			const [messageId, fields] = messages[0];
			const payloadRaw = fields[fields.indexOf("payload") + 1];
			const payload = JSON.parse(payloadRaw) as WorkerTask;

			const { task_id, receiver, submitter, source, prompt, session_id, images: imagePaths } = payload;
			const taskSource = source || "web";
			currentTaskId = task_id;

			// Idempotency check: check if task is already finished in metadata service
			let dedupKey: string | undefined;
			if (task_id) {
				dedupKey = `agent:${owner}:worker:dedup:${task_id}`;
				const acquired = await redis.set(dedupKey, "1", "EX", 300, "NX"); // 5-minute lock
				if (!acquired) {
					log(`Task ${task_id} is currently locked/processing. Skipping duplicate message.`);
					await redis.xack(inputQueue, consumerGroup, messageId);
					continue;
				}

				try {
					const existingTask = await metadataClient.getTask(task_id);
					if (existingTask && ["success", "error", "aborted"].includes(existingTask.status)) {
						log(`Task ${task_id} already finished with status ${existingTask.status}. Skipping.`);
						await redis.del(dedupKey);
						await redis.xack(inputQueue, consumerGroup, messageId);
						continue;
					}
				} catch (err) {
					error(`Failed to check idempotency for task ${task_id}: ${err}`);
					// Continue processing if check fails to avoid blocking the queue
				}
			}

			if (!prompt) {
				await redis.xack(inputQueue, consumerGroup, messageId);
				continue;
			}

			// Context-aware resource loader
			const _resourceLoader = new DefaultResourceLoader({
				cwd: workspaceDir,
				agentDir: agentDir,
				settingsManager: settingsManager,
				agentsFilesOverride: (base) => ({
					agentsFiles:
						taskSource === "acp"
							? base.agentsFiles.filter((f) => !f.path.endsWith("MEMORY.md"))
							: base.agentsFiles,
				}),
			});

			const currentSessionId = session_id || randomUUID();
			const sessionManager = SessionManager.inMemory(workspaceDir, currentSessionId);

			// Load session only if session_id was explicitly provided (Standard ACP isolation)
			if (session_id) {
				const restored = await redisSessionStore.getSession(currentSessionId);
				if (restored.entries.length > 0) {
					sessionManager.loadEntries(restored.entries as any);
				}
			}

			const defaultProvider = settingsManager.getDefaultProvider();
			const defaultModelId = settingsManager.getDefaultModel();
			const model =
				defaultProvider && defaultModelId ? modelRegistry.find(defaultProvider, defaultModelId) : undefined;

			const { session } = await createAgentSession({
				cwd: workspaceDir,
				agentDir: agentDir,
				sessionManager: sessionManager,
				settingsManager: settingsManager,
				modelRegistry: modelRegistry,
				authStorage: authStorage,
				model: model,
				thinkingLevel: settingsManager.getDefaultThinkingLevel(),
			});

			const agent = session.agent;
			currentAgent = agent;

			// Process images
			const imageContents: any[] = [];
			if (imagePaths) {
				for (const relPath of imagePaths) {
					try {
						const buffer = await readFile(join(workspaceDir, relPath));
						const ext = extname(relPath).toLowerCase();
						const mime = ext === ".png" ? "image/png" : "image/jpeg";
						imageContents.push({ type: "image", data: buffer.toString("base64"), mimeType: mime });
					} catch (_e) {}
				}
			}

			let responseText = "";
			const unsubscribe = session.subscribe(async (event: any) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					for (const block of event.message.content) {
						if (block.type === "text") responseText += block.text;
					}
				}

				// Map Mario library events to legacy stack format for compatibility
				// WebUI: status-bar.js, Ontology: auditor_logic.py
				let mappedEvent = event.type;
				const mappedData = { ...event };

				if (event.type === "tool_execution_start") {
					mappedEvent = "tool_start";
					(mappedData as any).tool = event.toolName;
				} else if (event.type === "tool_execution_end") {
					mappedEvent = "tool_end";
					(mappedData as any).tool = event.toolName;
				}

				const progress = {
					task_id: currentTaskId,
					receiver,
					submitter,
					source: taskSource,
					session_id: currentSessionId,
					status: "progress",
					event: mappedEvent,
					data: mappedData,
				};
				await redisPublisher.xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(progress));
			});

			try {
				await session.prompt(prompt, imageContents.length > 0 ? { images: imageContents } : undefined);

				const resultPayload: WorkerResponse = {
					task_id: currentTaskId,
					receiver,
					submitter,
					source: taskSource,
					session_id: currentSessionId,
					response: responseText,
					status: "success",
				};
				await redisPublisher.xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(resultPayload));

				// Persist
				await redisSessionStore.persistSnapshot(
					currentSessionId,
					sessionManager.getHeader()!,
					sessionManager.getEntries(),
					{ source: taskSource },
				);
			} catch (err: any) {
				const errorPayload: WorkerResponse = {
					task_id: currentTaskId,
					receiver,
					submitter,
					source: taskSource,
					session_id: currentSessionId,
					error: err.message,
					status: "error",
				};
				await redisPublisher.xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(errorPayload));
			} finally {
				unsubscribe();
				currentAgent = null;
				currentTaskId = undefined;
				await redis.xack(inputQueue, consumerGroup, messageId);
			}
		} catch (err) {
			error("Loop error", err);
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
}

main().catch((err) => {
	error("Fatal", err);
	process.exit(1);
});
