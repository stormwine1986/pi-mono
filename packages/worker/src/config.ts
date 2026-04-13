export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
if (!process.env.OWNER) {
	throw new Error("Environment variable OWNER is required but not set.");
}
export const owner = process.env.OWNER;
export const inputQueue = `user:${owner}:agent:in`;
export const outputQueue = `user:${owner}:agent:out`;
export const controlChannel = `user:${owner}:agent:cmd`;
export const consumerGroup = `user:${owner}:agent-group`;
export const consumerName = `user:${owner}:agent-0`;
