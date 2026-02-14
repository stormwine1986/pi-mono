import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@mariozechner/pi-coding-agent";
import { Redis } from "ioredis";
import { controlChannel, inputQueue, outputQueue, redisUrl } from "./config.js";
import type { WorkerControlSignal, WorkerResponse, WorkerTask } from "./types.js";

async function main() {
	// Configuration directories from environment or defaults
	const stateDir = process.env["PI-STATE-DIR"] || join(homedir(), ".pi");
	const agentDir = join(stateDir, "agent");
	const workspaceDir = process.env["PI-WORKSPACE-DIR"] || join(agentDir, "workspace");

	console.log(`State directory: ${stateDir}`);
	console.log(`Workspace directory: ${workspaceDir}`);

	// Initialize agent session (loads settings, auth, tools, and system prompt)
	const { session } = await createAgentSession({
		cwd: workspaceDir,
		agentDir: agentDir,
	});
	const agent = session.agent;

	console.log(`Connecting to Redis at ${redisUrl}...`);
	const redis = new Redis(redisUrl);
	const redisPublisher = new Redis(redisUrl);
	const redisSubscriber = new Redis(redisUrl);

	// Keep track of current task ID for filtering control signals
	let currentTaskId: string | undefined;

	console.log(`Subscribing to shared control channel: ${controlChannel}`);
	await redisSubscriber.subscribe(controlChannel);
	redisSubscriber.on("message", async (_channel, rawSignal) => {
		try {
			const signal: WorkerControlSignal = JSON.parse(rawSignal);
			if (signal.command === "stop") {
				console.log(`[Interrupt] Received stop for current task (${currentTaskId || "none"})`);
				agent.abort();
			} else if (signal.command === "steer" && signal.message) {
				console.log(`[Steer] Received steer for current task (${currentTaskId || "none"}): ${signal.message}`);
				await session.steer(signal.message);
			} else if (signal.command === "reset") {
				console.log(`[Reset] Received reset command for current session`);
				await session.newSession();
				const taskId = signal.id;
				const payload = {
					id: taskId,
					source: "internal",
					prompt: "发出你的问候。",
				};
				await redisPublisher.rpush(inputQueue, JSON.stringify(payload));
			}
		} catch (_e) {
			console.error(`[Control] Failed to parse control signal as JSON: ${rawSignal}`);
		}
	});

	console.log(`Listening for messages on queue: ${inputQueue}`);
	console.log(
		`Using model: ${agent.state.model?.provider}:${agent.state.model?.id} (Thinking: ${agent.state.thinkingLevel})`,
	);

	while (true) {
		try {
			// BLPOP returns [queueName, message]
			const result = await redis.blpop(inputQueue, 0);
			if (!result) continue;

			const [_, rawMessage] = result;
			console.log(`Received message: ${rawMessage}`);

			let payload: WorkerTask;
			try {
				payload = JSON.parse(rawMessage);
			} catch (_e) {
				console.error("Failed to parse message as JSON:", rawMessage);
				continue;
			}

			const { id, prompt } = payload;
			currentTaskId = id;

			if (!prompt) {
				console.error("Message missing prompt:", payload);
				currentTaskId = undefined;
				continue;
			}

			console.log(`Processing task ${id || ""}: ${prompt}`);

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
					redisPublisher.rpush(outputQueue, JSON.stringify(progress)).catch((err) => {
						console.error("Failed to publish progress event:", err);
					});
				}
			});

			try {
				await session.prompt(prompt);
				console.log(`Task ${id || ""} completed.`);

				const resultPayload: WorkerResponse = {
					id,
					response: responseText,
					status: "success",
				};

				await redisPublisher.rpush(outputQueue, JSON.stringify(resultPayload));
			} catch (err: any) {
				if (err.message === "Aborted") {
					console.log(`Task ${id || ""} was aborted by user.`);
				} else {
					console.error(`Error processing task ${id || ""}:`, err);
				}
				const errorPayload: WorkerResponse = {
					id,
					error: err.message === "Aborted" ? "Task aborted by user" : err.message,
					status: "error",
				};
				await redisPublisher.rpush(outputQueue, JSON.stringify(errorPayload));
			} finally {
				unsubscribe();
				currentTaskId = undefined;
			}
		} catch (err) {
			console.error("Worker loop error:", err);
			// Wait a bit before retrying if there's a connection issue
			await new Promise((resolve) => setTimeout(resolve, 5000));
		}
	}
}

main().catch((err) => {
	console.error("Fatal worker error:", err);
	process.exit(1);
});
