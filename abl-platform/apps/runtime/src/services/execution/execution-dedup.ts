import crypto from 'crypto';
import type { InteractionContextInput } from '@agent-platform/shared-kernel';
import type { SdkMessageMetadata } from '../identity/sdk-message-metadata.js';

export interface DedupStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Atomic check-and-set: returns existing value if key exists, or sets new value and returns null */
  checkAndSet(key: string, value: string, ttlMs: number): Promise<string | null>;
}

import type { RedisClient } from '@agent-platform/redis';

/**
 * Redis-backed dedup store for production distributed use.
 * Uses SET with PX (millisecond TTL) and NX (set-if-not-exists) for atomic dedup.
 */
export class RedisDedupStore implements DedupStore {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async checkAndSet(key: string, value: string, ttlMs: number): Promise<string | null> {
    // Try to SET with NX — if key exists, this returns null (not set)
    const result = await this.redis.set(key, value, 'PX', ttlMs, 'NX');
    if (result === 'OK') return null; // We set it, no existing value
    // Key existed, return the current value
    return this.redis.get(key);
  }
}

/**
 * In-memory dedup store for testing. Production uses Redis via RedisDedupStore.
 */
export class InMemoryDedupStore implements DedupStore {
  private entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.entries.has(key)) {
      const existing = this.entries.get(key)!;
      if (Date.now() <= existing.expiresAt) return false; // Key exists and not expired
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async checkAndSet(key: string, value: string, ttlMs: number): Promise<string | null> {
    const existing = await this.get(key);
    if (existing) return existing;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return null;
  }
}

const DEFAULT_DEDUP_TTL_MS = 5_000;

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (key) =>
          JSON.stringify(key) + ':' + stableStringify((value as Record<string, unknown>)[key]),
      )
      .join(',') +
    '}'
  );
}

export class ExecutionDedup {
  constructor(
    private store: DedupStore,
    private ttlMs: number = DEFAULT_DEDUP_TTL_MS,
  ) {}

  async check(
    sessionId: string,
    message: string,
    attachmentIds: string[] | undefined,
    messageMetadata?: SdkMessageMetadata,
    interactionContext?: InteractionContextInput,
    dedupKey?: string,
  ): Promise<string | null> {
    const hash = this.computeHash(
      sessionId,
      message,
      attachmentIds,
      messageMetadata,
      interactionContext,
      dedupKey,
    );
    return this.store.get(`exec:dedup:${hash}`);
  }

  async record(
    sessionId: string,
    message: string,
    attachmentIds: string[] | undefined,
    messageMetadata: SdkMessageMetadata | undefined,
    executionId: string,
    interactionContext?: InteractionContextInput,
    dedupKey?: string,
  ): Promise<void> {
    const hash = this.computeHash(
      sessionId,
      message,
      attachmentIds,
      messageMetadata,
      interactionContext,
      dedupKey,
    );
    await this.store.set(`exec:dedup:${hash}`, executionId, this.ttlMs);
  }

  /**
   * Atomic check-and-record: returns existing executionId if duplicate,
   * or records the new executionId and returns null. Thread-safe for distributed use.
   */
  async checkAndRecord(
    sessionId: string,
    message: string,
    attachmentIds: string[] | undefined,
    messageMetadata: SdkMessageMetadata | undefined,
    executionId: string,
    interactionContext?: InteractionContextInput,
    dedupKey?: string,
  ): Promise<string | null> {
    const hash = this.computeHash(
      sessionId,
      message,
      attachmentIds,
      messageMetadata,
      interactionContext,
      dedupKey,
    );
    return this.store.checkAndSet(`exec:dedup:${hash}`, executionId, this.ttlMs);
  }

  private computeHash(
    sessionId: string,
    message: string,
    attachmentIds: string[] | undefined,
    messageMetadata: SdkMessageMetadata | undefined,
    interactionContext: InteractionContextInput | undefined,
    dedupKey: string | undefined,
  ): string {
    const payload =
      sessionId +
      '\0' +
      (dedupKey ?? '') +
      '\0' +
      message +
      '\0' +
      JSON.stringify(attachmentIds ?? []) +
      '\0' +
      stableStringify(messageMetadata ?? {}) +
      '\0' +
      stableStringify(interactionContext ?? {});
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
}
