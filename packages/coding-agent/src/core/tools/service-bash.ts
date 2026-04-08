import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

// Reuse the same env for REDIS_URL if possible, fallback to localhost.
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// We keep a single connection or create when needed
let redisClient: Redis | null = null;
function getRedisClient() {
    if (!redisClient) {
        redisClient = new Redis(redisUrl);
    }
    return redisClient;
}

const serviceBashSchema = Type.Object({
    service: Type.String({ description: "Target service/container to execute in (e.g. 'console', 'ontology', 'backlog')" }),
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, default 60)" })),
});

export type ServiceBashInput = Static<typeof serviceBashSchema>;

export const serviceBashTool: AgentTool<typeof serviceBashSchema> = {
    name: "service-bash",
    label: "Service Bash",
    description: "Execute a bash command in a specific target service container via Redis RPC. The underlying system will run docker exec on the target container.",
    parameters: serviceBashSchema,
    execute: async (
        _toolCallId: string,
        { service, command, timeout = 60 }: ServiceBashInput,
        signal?: AbortSignal,
        _onUpdate?: (update: any) => void
    ) => {
        const taskId = randomUUID();
        const client = getRedisClient();
        
        const requestPayload = {
            taskId,
            service,
            command,
            timeout
        };
        
        try {
            await client.xadd(
                "agent:tool:requests",
                "MAXLEN",
                "~",
                1000,
                "*", // auto-generated ID
                "payload",
                JSON.stringify(requestPayload)
            );
            
            const responseKey = `agent:tool:response:${taskId}`;
            
            // BLPOP returns conceptually [key, value] or null if timeout
            const result = await client.blpop(responseKey, timeout);
            
            if (!result) {
                // Timeout occurred
                throw new Error(`Tool Execution Timeout: The target container '${service}' took longer than ${timeout}s to respond.`);
            }
            
            const rawValue = result[1];
            let response;
            try {
                response = JSON.parse(rawValue);
            } catch (e) {
                throw new Error(`Failed to parse response from service-bash: ${rawValue}`);
            }
            
            const exitCode = response.exitCode || 0;
            const stdout = response.stdout || "";
            const stderr = response.stderr || "";
            
            let outputText = stdout;
            if (stderr) {
                outputText += (outputText ? "\n" : "") + "---- STDERR ----\n" + stderr;
            }
            
            if (exitCode !== 0) {
                outputText += `\n\nCommand exited with code ${exitCode}`;
                throw new Error(outputText);
            }
            
            return { content: [{ type: "text", text: outputText || "(no output)" }], details: {} };
        } catch (err: any) {
            if (err.message.includes("aborted") || signal?.aborted) {
                throw new Error("Command aborted");
            }
            throw err;
        }
    }
};
