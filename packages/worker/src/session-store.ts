import type { Redis } from "ioredis";
import type { SessionEntry, SessionHeader } from "@mariozechner/pi-coding-agent";

type Logger = (message: string, ...args: unknown[]) => void;

interface RedisSessionStoreOptions {
	owner: string;
	maxEntries: number;
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

function parsePositiveInt(name: string, value: string | undefined): number {
	if (!value) {
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
	private readonly log: Logger;

	constructor(private readonly redis: Redis, opts: RedisSessionStoreOptions) {
		this.owner = opts.owner;
		this.maxEntries = opts.maxEntries;
		this.log = opts.log;
	}

	static fromEnv(redis: Redis, owner: string, log: Logger): RedisSessionStore {
		const maxEntries = parsePositiveInt("PI_SESSION_KEEP_SIZE", process.env.PI_SESSION_KEEP_SIZE);
		return new RedisSessionStore(redis, { owner, maxEntries, log });
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

		// Keep only last N entries to avoid Redis bloat
		const toPersist = entries.slice(-this.maxEntries);
		const lastModified = new Date().toISOString();

		const metadata: SessionMetadata = {
			id: sessionId,
			title: header.cwd || "New Session",
			lastModified,
			messageCount: entries.filter((e) => e.type === "message").length,
		};

		const tx = this.redis.multi();
		tx.set(currentKey, sessionId);
		tx.set(headerKey, JSON.stringify(header));
		tx.del(entriesKey);
		if (toPersist.length > 0) {
			tx.rpush(entriesKey, ...toPersist.map((m) => JSON.stringify(m)));
			tx.ltrim(entriesKey, -this.maxEntries, -1);
		}
		// Update session index for listing
		tx.zadd(indexKey, Date.now(), sessionId);
		// Update hash with metadata if we want more details in list (optional, but good for performance)
		tx.hset(`user:${this.owner}:agent:session:${sessionId}:meta`, metadata as any);

		await tx.exec();
	}

	async listSessions(): Promise<SessionMetadata[]> {
		const indexKey = this.getSessionIndexKey();
		const sessionIds = await this.redis.zrevrange(indexKey, 0, 50);

		const result: SessionMetadata[] = [];
		for (const id of sessionIds) {
			const meta = await this.redis.hgetall(`user:${this.owner}:agent:session:${id}:meta`);
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
		const headerKey = `user:${this.owner}:agent:session:${previousSessionId}:header`;
		const entriesKey = `user:${this.owner}:agent:session:${previousSessionId}:entries`;

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
		const tx = this.redis.multi();
		tx.set(currentKey, sessionId);
		tx.del(headerKey);
		tx.del(entriesKey);
		await tx.exec();
		this.log(`[SessionStore] Reset to fresh session: ${sessionId}`);
	}
}
