export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
if (!process.env.OWNER) {
	throw new Error("Environment variable OWNER is required but not set.");
}
export const owner = process.env.OWNER;
export const inputQueue = `agent:${owner}:agent:in`;
export const outputQueue = `agent:${owner}:agent:out`;
export const controlChannel = `agent:${owner}:agent:cmd`;
export const consumerGroup = `agent:${owner}:agent-group`;
export const consumerName = `agent:${owner}:agent-0`;
