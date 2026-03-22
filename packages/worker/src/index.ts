import { homedir } from "node:os";
import { join, extname } from "node:path";
import { readFile } from "node:fs/promises";
import { createAgentSession, SessionManager, SettingsManager, AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Redis } from "ioredis";
import { consumerGroup, consumerName, controlChannel, inputQueue, outputQueue, redisUrl } from "./config.js";
import { error, log } from "./logger.js";
import type { WorkerControlSignal, WorkerResponse, WorkerTask } from "./types.js";

async function main() {
	// Configuration directories from environment or defaults
	const stateDir = process.env["PI-STATE-DIR"] || join(homedir(), ".pi");
	const agentDir = join(stateDir, "agent");
	const workspaceDir = process.env["PI-WORKSPACE-DIR"] || join(agentDir, "workspace");
	const agentId = process.env["AGENT_ID"] || "0";

	log(`State directory: ${stateDir}`);
	log(`Workspace directory: ${workspaceDir}`);

	const safePath = `--${workspaceDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	const sessionManager = SessionManager.continueRecent(workspaceDir, sessionDir);

	// Load settings to get default model and thinking level
	const settingsManager = SettingsManager.create(workspaceDir, agentDir);
	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModelId = settingsManager.getDefaultModel();
	const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel();

	// Resolve model registry to find the actual model object
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const model = (defaultProvider && defaultModelId) ? modelRegistry.find(defaultProvider, defaultModelId) : undefined;

	// Initialize agent session (loads settings, auth, tools, and system prompt)
	const { session } = await createAgentSession({
		cwd: workspaceDir,
		agentDir: agentDir,
		sessionManager: sessionManager,
		settingsManager: settingsManager,
		modelRegistry: modelRegistry,
		authStorage: authStorage,
		model: model,
		thinkingLevel: defaultThinkingLevel,
	});
	const agent = session.agent;

	log(`Connecting to Redis at ${redisUrl}...`);
	const redis = new Redis(redisUrl);
	const redisPublisher = new Redis(redisUrl);
	const redisSubscriber = new Redis(redisUrl);

	// Ensure consumer group exists
	try {
		await redis.xgroup("CREATE", inputQueue, consumerGroup, "$", "MKSTREAM");
		log(`Created consumer group ${consumerGroup} for stream ${inputQueue}`);
	} catch (err: any) {
		if (!err.message.includes("BUSYGROUP")) {
			error(`Failed to create consumer group: ${err.message}`);
		}
	}

	// Keep track of current task ID for filtering control signals
	let currentTaskId: string | undefined;

	log(`Subscribing to shared control channel: ${controlChannel}`);
	redisSubscriber.on("message", async (channel, rawSignal) => {
		log(`[Control] Received message on channel ${channel}: ${rawSignal}`);
		try {
			const signal: WorkerControlSignal = JSON.parse(rawSignal);
			if (signal.command === "stop") {
				log(`[Interrupt] Received stop for current task (${currentTaskId || "none"})`);
				agent.abort();
			} else if (signal.command === "steer" && signal.message) {
				log(`[Steer] Received steer for current task (${currentTaskId || "none"}): ${signal.message}`);
				await session.steer(signal.message);
			} else if (signal.command === "reset") {
				log(`[Reset] Received reset command for current session`);
				await session.newSession();

				const taskId = signal.id;
				const modelInfo = `${agent.state.model?.provider}:${agent.state.model?.id} (思维层级: ${agent.state.thinkingLevel})`;
				const payload = {
					id: taskId,
					user_id: signal.user_id || "internal",
					source: signal.source || "internal",
					prompt: `新会话已经开启。\n当前模型设定：${modelInfo}。\n会话所属用户ID：${signal.user_id}。\n\n从记忆里检索有关用户的基本信息，请向用户发出简短问候，并在问候中包含模型设定信息。\n如果需要答复当前系统时间，请执行 \`date\` 命令后在答复，禁止编造当前时间。`,
				};
				await (redisPublisher as any).xadd(inputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(payload));
				log(`[Reset] Pushed new session greeting to ${inputQueue}`);
			}
		} catch (e: any) {
			error(`[Control] Failed to process control signal: ${e.message}. Raw: ${rawSignal}`);
		}
	});

	await redisSubscriber.subscribe(controlChannel);
	log(`Successfully subscribed to ${controlChannel}`);

	log(`Listening for messages on queue: ${inputQueue}`);
	log(`Using model: ${agent.state.model?.provider}:${agent.state.model?.id} (Thinking: ${agent.state.thinkingLevel})`);


	while (true) {
		try {
			// XREADGROUP returns [ [streamName, [ [id, [field, value, ...]], ... ]], ... ]
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
			if (!messages || messages.length === 0) continue;

			const [messageId, fields] = messages[0];
			// The payload is in the 'payload' field
			let rawMessage = "";
			for (let i = 0; i < fields.length; i += 2) {
				if (fields[i] === "payload") {
					rawMessage = fields[i + 1];
					break;
				}
			}

			if (!rawMessage) {
				log(`Received message ${messageId} with no payload fields`);
				await redis.xack(inputQueue, consumerGroup, messageId);
				continue;
			}

			log(`Received message ${messageId}: ${rawMessage}`);

			let payload: WorkerTask;
			try {
				payload = JSON.parse(rawMessage);
			} catch (_e) {
				error("Failed to parse message as JSON:", rawMessage);
				continue;
			}

			const { id, user_id, source, prompt, images: imagePaths } = payload;
			currentTaskId = id;
			const sessionId = sessionManager.getSessionId();

			if (!prompt) {
				error("Message missing prompt:", payload);
				currentTaskId = undefined;
				continue;
			}

			log(`Processing task ${id || ""}: ${prompt}`);
			process.env["PI_TASK_ID"] = id;

			// Build ImageContent[] from image paths if present
			const imageContents: Array<{ type: "image"; data: string; mimeType: string }> = [];
			if (imagePaths && imagePaths.length > 0) {
				for (const relPath of imagePaths) {
					try {
						const fullPath = join(workspaceDir, relPath);
						const buffer = await readFile(fullPath);
						const ext = extname(relPath).toLowerCase();
						const mimeMap: Record<string, string> = {
							".jpg": "image/jpeg",
							".jpeg": "image/jpeg",
							".png": "image/png",
							".gif": "image/gif",
							".webp": "image/webp",
						};
						const mimeType = mimeMap[ext] || "image/jpeg";
						imageContents.push({
							type: "image",
							data: buffer.toString("base64"),
							mimeType,
						});
						log(`Loaded image: ${relPath} (${buffer.length} bytes, ${mimeType})`);
					} catch (imgErr) {
						error(`Failed to load image ${relPath}:`, imgErr);
					}
				}
			}

			// Subscribe to session events to collect the response and emit progress
			let responseText = "";
			const toolArgsMap = new Map<string, any>();
			const unsubscribe = session.subscribe(async (event: any) => {
				log(`[Session Event] Type: ${event.type}`);
				// Collect response text
				if (event.type === "message_end" && event.message.role === "assistant") {
					for (const block of event.message.content) {
						if (block.type === "text") {
							responseText += block.text;
						}
					}
					log(`[Worker] Collected text from message_end: ${responseText.length} chars accumulated`);
				}

				// Emit progress events
				let progress: any = {
					id,
					user_id,
					source,
					agent_id: agentId,
					session_id: session.sessionId,
					status: "progress",
					event: event.type,
				};

				switch (event.type) {
					case "message_start":
						if (event.message?.role === "assistant") {
							progress.event = "llm_start";
						}
						break;
					case "message_end":
						if (event.message?.role === "assistant") {
							progress.event = "llm_end";
						}
						break;
					case "tool_execution_start":
						toolArgsMap.set(event.toolCallId, event.args);
						progress.event = "tool_start";
						progress.data = { tool: event.toolName, args: event.args };
						break;
					case "tool_execution_end":
						const args = toolArgsMap.get(event.toolCallId);
						progress.event = "tool_end";
						progress.data = { tool: event.toolName, args: args, result: event.result, isError: event.isError };
						toolArgsMap.delete(event.toolCallId);
						break;
				}

				// Publish progress event and await to maintain order
				await (redisPublisher as any).xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(progress)).catch((err: any) => {
					error("Failed to publish progress event:", err);
				});
			});

			try {
				await session.prompt(prompt, imageContents.length > 0 ? { images: imageContents } : undefined);

				// Re-check for abortion if session.prompt() didn't throw
				const lastAssistant = agent.state.messages
					.filter((m) => m.role === "assistant")
					.slice(-1)[0] as any;
				if (lastAssistant?.stopReason === "aborted") {
					throw new Error("Aborted");
				}

				log(`Task ${id} completed.`);

				const resultPayload: WorkerResponse = {
					id,
					user_id,
					source,
					agent_id: agentId,
					session_id: session.sessionId,
					response: responseText,
					usage: lastAssistant?.usage,
					status: "success",
				};

				await (redisPublisher as any).xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(resultPayload));
			} catch (err: any) {
				const isAborted = err.message === "Aborted";
				if (isAborted) {
					log(`Task ${id} was aborted by user.`);
				} else {
					error(`Error processing task ${id}:`, err);
				}
				const errorPayload: WorkerResponse = {
					id,
					user_id,
					source,
					agent_id: agentId,
					session_id: session.sessionId,
					error: isAborted ? "Task aborted by user" : err.message,
					status: isAborted ? "aborted" : "error",
				};
				await (redisPublisher as any).xadd(outputQueue, "MAXLEN", "~", 1000, "*", "payload", JSON.stringify(errorPayload));
			} finally {
				unsubscribe();
				currentTaskId = undefined;
				// ACK the message after processing
				await redis.xack(inputQueue, consumerGroup, messageId);
			}
		} catch (err) {
			error("Worker loop error:", err);
			// Wait a bit before retrying if there's a connection issue
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
	}
}

main().catch((err) => {
	error("Fatal worker error:", err);
	process.exit(1);
});
