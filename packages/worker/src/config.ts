export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
export const inputQueue = "agent_in";
export const outputQueue = "agent_out";
export const controlChannel = "agent_ctl";
export const consumerGroup = "agent-group";
export const consumerName = "agent-0";
