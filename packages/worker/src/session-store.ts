import type { SessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";
import type { Redis } from "ioredis";

type Logger = (message: string, ...args: unknown[]) => void;

interface RedisSessionStoreOptions {
	owner: string;
	maxEntries: number; // Entries per session
	maxSessions: number; // Max number of sessions to keep
	log: Logger;
}

interface SessionLoadResult {
	previousSessionId?: string;
	header?: SessionHeader;
	entries: SessionEntry[];
}

interface SessionMetadata {
	id: string;
	title: string;
	lastModified: string;
	messageCount: number;
}

function parsePositiveInt(name: string, value: string | undefined, defaultValue?: number): number {
	if (!value) {
		if (defaultValue !== undefined) return defaultValue;
		throw new Error(`Environment variable ${name} is required but not set.`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Environment variable ${name} must be a positive integer, got: ${value}`);
	}
	return parsed;
}

function safeParse<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

export class RedisSessionStore {
	private readonly owner: string;
	private readonly maxEntries: number;
	private readonly maxSessions: number;
	private readonly log: Logger;

	constructor(
		private readonly redis: Redis,
		opts: RedisSessionStoreOptions,
	) {
		this.owner = opts.owner;
		this.maxEntries = opts.maxEntries;
		this.maxSessions = opts.maxSessions;
		this.log = opts.log;
	}

	static fromEnv(redis: Redis, owner: string, log: Logger): RedisSessionStore {
		const maxEntries = parsePositiveInt("PI_SESSION_KEEP_SIZE", process.env.PI_SESSION_KEEP_SIZE);
		const maxSessions = parsePositiveInt("PI_MAX_SESSIONS", process.env.PI_MAX_SESSIONS, 50);
		return new RedisSessionStore(redis, { owner, maxEntries, maxSessions, log });
	}

	private getCurrentSessionKey(): string {
		return `user:${this.owner}:agent:session:current_id`;
	}

	private getSessionIndexKey(): string {
		return `user:${this.owner}:agent:sessions`;
	}

	private getHeaderKey(sessionId: string): string {
		return `user:${this.owner}:agent:session:${sessionId}:header`;
	}

	private getEntriesKey(sessionId: string): string {
		return `user:${this.owner}:agent:session:${sessionId}:entries`;
	}

	private getMetaKey(sessionId: string): string {
		return `user:${this.owner}:agent:session:${sessionId}:meta`;
	}

	async restoreAndBind(runtimeSessionId: string): Promise<SessionLoadResult> {
		const currentKey = this.getCurrentSessionKey();
		const previousSessionId = await this.redis.get(currentKey);

		if (!previousSessionId) {
			await this.redis.set(currentKey, runtimeSessionId);
			this.log(`[SessionStore] Initialized current session: ${runtimeSessionId}`);
			return { entries: [] };
		}

		const previousEntriesKey = this.getEntriesKey(previousSessionId);
		const previousHeaderKey = this.getHeaderKey(previousSessionId);

		const [rawHeader, rawEntries] = await Promise.all([
			this.redis.get(previousHeaderKey),
			this.redis.lrange(previousEntriesKey, 0, -1),
		]);

		const header = rawHeader ? safeParse<SessionHeader>(rawHeader) : undefined;
		const entries = rawEntries.map(safeParse<SessionEntry>).filter((m): m is SessionEntry => m !== null);

		if (previousSessionId !== runtimeSessionId) {
			const runtimeEntriesKey = this.getEntriesKey(runtimeSessionId);
			const runtimeHeaderKey = this.getHeaderKey(runtimeSessionId);

			const exists = await this.redis.exists(previousEntriesKey);
			if (exists) {
				await this.redis.del(runtimeEntriesKey);
				await this.redis.rename(previousEntriesKey, runtimeEntriesKey);
			}

			if (header) {
				await this.redis.set(runtimeHeaderKey, JSON.stringify({ ...header, id: runtimeSessionId }));
				await this.redis.del(previousHeaderKey);
			}

			await this.redis.set(currentKey, runtimeSessionId);
			this.log(`[SessionStore] Rebound session ${previousSessionId} -> ${runtimeSessionId}`);
		}

		return {
			previousSessionId,
			header: header ? (header as SessionHeader) : undefined,
			entries,
		};
	}

	async persistSnapshot(sessionId: string, header: SessionHeader, entries: SessionEntry[]): Promise<void> {
		const currentKey = this.getCurrentSessionKey();
		const indexKey = this.getSessionIndexKey();
		const headerKey = this.getHeaderKey(sessionId);
		const entriesKey = this.getEntriesKey(sessionId);
		const metaKey = this.getMetaKey(sessionId);

		// Keep only last N entries to avoid Redis bloat
		const toPersist = entries.slice(-this.maxEntries);
		const lastModified = new Date().toISOString();

		const metadata: SessionMetadata = {
			id: sessionId,
			title: header.cwd || "New Session",
			lastModified,
			messageCount: entries.filter((e) => e.type === "message").length,
		};

		const now = Date.now();

		const tx = this.redis.multi();
		tx.set(currentKey, sessionId);
		tx.set(headerKey, JSON.stringify(header));
		tx.del(entriesKey);
		if (toPersist.length > 0) {
			tx.rpush(entriesKey, ...toPersist.map((m) => JSON.stringify(m)));
			tx.ltrim(entriesKey, -this.maxEntries, -1);
		}
		// Update session index for listing
		tx.zadd(indexKey, now, sessionId);
		tx.hset(metaKey, metadata as any);

		await tx.exec();

		// Cleanup old sessions beyond maxSessions limit
		await this.cleanupOldSessions();
	}

	private async cleanupOldSessions(): Promise<void> {
		const indexKey = this.getSessionIndexKey();
		const count = await this.redis.zcard(indexKey);
		if (count <= this.maxSessions) return;

		const overLimit = count - this.maxSessions;
		// Oldest sessions are at the beginning of the Sorted Set (low scores)
		const toRemove = await this.redis.zrange(indexKey, 0, overLimit - 1);

		if (toRemove.length > 0) {
			this.log(`[SessionStore] Cleaning up ${toRemove.length} old sessions beyond limit of ${this.maxSessions}`);
			const tx = this.redis.multi();
			for (const id of toRemove) {
				tx.del(this.getHeaderKey(id));
				tx.del(this.getEntriesKey(id));
				tx.del(this.getMetaKey(id));
			}
			tx.zremrangebyrank(indexKey, 0, overLimit - 1);
			await tx.exec();
		}
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const indexKey = this.getSessionIndexKey();
		const sessionIds = await this.redis.zrevrange(indexKey, 0, 50);

		const result: SessionMetadata[] = [];
		for (const id of sessionIds) {
			const meta = await this.redis.hgetall(this.getMetaKey(id));
			if (meta && meta.id) {
				result.push({
					id: meta.id,
					title: meta.title,
					lastModified: meta.lastModified,
					messageCount: Number.parseInt(meta.messageCount, 10),
				});
			}
		}
		return result;
	}

	async getSession(previousSessionId: string): Promise<{ entries: any[] }> {
		const headerKey = this.getHeaderKey(previousSessionId);
		const entriesKey = this.getEntriesKey(previousSessionId);

		const [headerStr, entriesRaw] = await Promise.all([
			this.redis.get(headerKey),
			this.redis.lrange(entriesKey, 0, -1),
		]);

		const entries: any[] = entriesRaw.map((e) => JSON.parse(e));
		if (headerStr) {
			entries.unshift(JSON.parse(headerStr));
		}

		return { entries };
	}

	async resetToSession(sessionId: string): Promise<void> {
		const currentKey = this.getCurrentSessionKey();
		const headerKey = this.getHeaderKey(sessionId);
		const entriesKey = this.getEntriesKey(sessionId);
		const metaKey = this.getMetaKey(sessionId);

		const tx = this.redis.multi();
		tx.set(currentKey, sessionId);
		tx.del(headerKey);
		tx.del(entriesKey);
		tx.del(metaKey);
		await tx.exec();
		this.log(`[SessionStore] Reset to fresh session: ${sessionId}`);
	}
}
