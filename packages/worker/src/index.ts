import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { Redis } from "ioredis";
import type { WorkerControlSignal, WorkerResponse, WorkerTask } from "pi-protocol";
import { consumerGroup, consumerName, controlChannel, inputQueue, outputQueue, redisUrl } from "./config.js";
import { error, log } from "./logger.js";

async function main() {
	// Configuration directories from environment or defaults
	const stateDir = process.env["PI-STATE-DIR"] || join(homedir(), ".pi");
	const agentDir = join(stateDir, "agent");
	const workspaceDir = process.env["PI-WORKSPACE-DIR"] || join(agentDir, "workspace");

	log(`State directory: ${stateDir}`);
	log(`Workspace directory: ${workspaceDir}`);

	// Initialize agent session (loads settings, auth, tools, and system prompt)
	const { session } = await createAgentSession({
		cwd: workspaceDir,
		agentDir: agentDir,
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
	await redisSubscriber.subscribe(controlChannel);
	redisSubscriber.on("message", async (_channel, rawSignal) => {
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
				const payload = {
					id: taskId,
					source: "internal",
					prompt: "向用户发出你的问候",
				};
				await redisPublisher.xadd(inputQueue, "*", "payload", JSON.stringify(payload));
			}
		} catch (_e) {
			error(`[Control] Failed to parse control signal as JSON: ${rawSignal}`);
		}
	});

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

			const { id, prompt } = payload;
			currentTaskId = id;

			if (!prompt) {
				error("Message missing prompt:", payload);
				currentTaskId = undefined;
				continue;
			}

			log(`Processing task ${id || ""}: ${prompt}`);

			// Subscribe to session events to collect the response and emit progress
			let responseText = "";
			const unsubscribe = session.subscribe((event: any) => {
				// Collect response text
				if (event.type === "message_end" && event.message.role === "assistant") {
					for (const block of event.message.content) {
						if (block.type === "text") {
							responseText += block.text;
						}
					}
				}

				// Emit progress events
				let progress: WorkerResponse | null = null;
				switch (event.type) {
					case "message_start":
						if (event.message.role === "assistant") {
							progress = { id, status: "progress", event: "llm_start" };
						}
						break;
					case "message_end":
						if (event.message.role === "assistant") {
							progress = { id, status: "progress", event: "llm_end" };
						}
						break;
					case "tool_execution_start":
						progress = {
							id,
							status: "progress",
							event: "tool_start",
							data: { tool: event.toolName, args: event.args },
						};
						break;
					case "tool_execution_end":
						progress = {
							id,
							status: "progress",
							event: "tool_end",
							data: { tool: event.toolName, result: event.result, isError: event.isError },
						};
						break;
				}

				if (progress) {
					redisPublisher.xadd(outputQueue, "*", "payload", JSON.stringify(progress)).catch((err) => {
						error("Failed to publish progress event:", err);
					});
				}
			});

			try {
				await session.prompt(prompt);
				log(`Task ${id} completed.`);

				const resultPayload: WorkerResponse = {
					id,
					response: responseText,
					status: "success",
				};

				await redisPublisher.xadd(outputQueue, "*", "payload", JSON.stringify(resultPayload));
			} catch (err: any) {
				if (err.message === "Aborted") {
					log(`Task ${id} was aborted by user.`);
				} else {
					error(`Error processing task ${id}:`, err);
				}
				const errorPayload: WorkerResponse = {
					id,
					error: err.message === "Aborted" ? "Task aborted by user" : err.message,
					status: "error",
				};
				await redisPublisher.xadd(outputQueue, "*", "payload", JSON.stringify(errorPayload));
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
