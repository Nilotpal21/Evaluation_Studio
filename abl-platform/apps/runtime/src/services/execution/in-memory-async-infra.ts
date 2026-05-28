import crypto from 'crypto';
import type { PendingDeliveryRedisClient } from './pending-delivery-store.js';
import type { ResumeData } from '@agent-platform/execution';
import type { LockPort, ResumeDispatcher } from './resumption-service.js';

interface InMemoryPendingDeliveryRedisClientOptions {
  maxKeys?: number;
  maxEntriesPerKey?: number;
  cleanupIntervalMs?: number;
  ttlGraceMs?: number;
}

interface StoredPendingDeliveries {
  values: string[];
  expiresAt: number | null;
  touchedAt: number;
}

interface InMemoryLockPortOptions {
  maxLocks?: number;
  cleanupIntervalMs?: number;
}

interface StoredLock {
  owner: string;
  expiresAt: number;
}

const DEFAULT_PENDING_DELIVERY_KEYS = 1_000;
const DEFAULT_PENDING_DELIVERY_ENTRIES_PER_KEY = 100;
const DEFAULT_PENDING_DELIVERY_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_PENDING_DELIVERY_TTL_GRACE_MS = 300_000;

const DEFAULT_MAX_IN_MEMORY_LOCKS = 2_000;
const DEFAULT_LOCK_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Inline queue/dispatcher bridge for test/dev async callbacks.
 *
 * Lets callback routers enqueue resume jobs while parent-resume dispatch
 * reuses the same implementation inside ResumptionService.
 */
export class InlineResumeDispatcher implements ResumeDispatcher {
  private handler: ((suspensionId: string, data: ResumeData) => Promise<void>) | undefined =
    undefined;

  bind(handler: (suspensionId: string, data: ResumeData) => Promise<void>): void {
    this.handler = handler;
  }

  async enqueueResume(suspensionId: string, data: ResumeData): Promise<void> {
    if (!this.handler) {
      throw new Error('Inline resume dispatcher not bound');
    }
    await this.handler(suspensionId, data);
  }

  async add(_name: string, data: unknown): Promise<void> {
    const payload = data as ResumeData & { suspensionId?: string };
    if (!payload.suspensionId) {
      throw new Error('Inline resume queue missing suspensionId');
    }

    const { suspensionId, ...resumeData } = payload;
    await this.enqueueResume(suspensionId, resumeData);
  }
}

/**
 * Small in-memory backend that satisfies PendingDeliveryStore's Redis shape.
 * Used only for test/dev async harnesses when Redis is intentionally absent.
 */
export class InMemoryPendingDeliveryRedisClient implements PendingDeliveryRedisClient {
  private readonly store = new Map<string, StoredPendingDeliveries>();
  private readonly maxKeys: number;
  private readonly maxEntriesPerKey: number;
  private readonly ttlGraceMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: InMemoryPendingDeliveryRedisClientOptions = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_PENDING_DELIVERY_KEYS;
    this.maxEntriesPerKey = options.maxEntriesPerKey ?? DEFAULT_PENDING_DELIVERY_ENTRIES_PER_KEY;
    this.ttlGraceMs = options.ttlGraceMs ?? DEFAULT_PENDING_DELIVERY_TTL_GRACE_MS;
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired(),
      options.cleanupIntervalMs ?? DEFAULT_PENDING_DELIVERY_CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref?.();
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    this.cleanupExpired();
    const entry = this.ensureEntry(key);
    entry.values.push(...values);
    if (entry.values.length > this.maxEntriesPerKey) {
      entry.values.splice(0, entry.values.length - this.maxEntriesPerKey);
    }
    entry.touchedAt = Date.now();
    return entry.values.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) {
      this.store.delete(key);
      return [];
    }

    const normalizedStart = start < 0 ? Math.max(entry.values.length + start, 0) : start;
    const normalizedStop =
      stop < 0 ? entry.values.length + stop : Math.min(stop, entry.values.length - 1);
    return entry.values.slice(normalizedStart, normalizedStop + 1);
  }

  async del(key: string | string[]): Promise<number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) {
        deleted += this.store.delete(item) ? 1 : 0;
      }
      return deleted;
    }

    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) {
      return 0;
    }

    entry.expiresAt = Date.now() + seconds * 1000;
    entry.touchedAt = Date.now();
    return 1;
  }

  private ensureEntry(key: string): StoredPendingDeliveries {
    let entry = this.store.get(key);
    if (entry && this.isExpired(entry)) {
      this.store.delete(key);
      entry = undefined;
    }

    if (!entry) {
      this.evictOverflow();
      entry = {
        values: [],
        expiresAt: null,
        touchedAt: Date.now(),
      };
      this.store.set(key, entry);
    }

    return entry;
  }

  private isExpired(entry: StoredPendingDeliveries, now = Date.now()): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= now;
  }

  private cleanupExpired(now = Date.now()): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt + this.ttlGraceMs <= now) {
        this.store.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    if (this.store.size < this.maxKeys) {
      return;
    }

    const oldest = [...this.store.entries()].sort((left, right) => {
      const leftTime = left[1].expiresAt ?? left[1].touchedAt;
      const rightTime = right[1].expiresAt ?? right[1].touchedAt;
      return leftTime - rightTime;
    })[0];

    if (oldest) {
      this.store.delete(oldest[0]);
    }
  }
}

/**
 * Single-process lock implementation for callback/resumption tests.
 *
 * Not safe for multi-pod production use; it exists so the real resumption
 * flow can run in the full HTTP harness without Redis.
 */
export class InMemoryLockPort implements LockPort {
  private readonly locks = new Map<string, StoredLock>();
  private readonly maxLocks: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: InMemoryLockPortOptions = {}) {
    this.maxLocks = options.maxLocks ?? DEFAULT_MAX_IN_MEMORY_LOCKS;
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired(),
      options.cleanupIntervalMs ?? DEFAULT_LOCK_CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref?.();
  }

  async acquire(
    key: string,
    options: { keyPrefix: string; ttlMs: number; retryAttempts: number; retryDelayMs: number },
  ): Promise<{ key: string; owner: string } | null> {
    this.cleanupExpired();
    const namespacedKey = `${options.keyPrefix}:${key}`;
    const existing = this.locks.get(namespacedKey);
    if (existing && existing.expiresAt > Date.now()) {
      return null;
    }

    if (!existing && this.locks.size >= this.maxLocks) {
      return null;
    }

    const owner = crypto.randomUUID();
    this.locks.set(namespacedKey, {
      owner,
      expiresAt: Date.now() + options.ttlMs,
    });
    return { key: namespacedKey, owner };
  }

  async release(lock: { key: string; owner: string }): Promise<void> {
    const existing = this.locks.get(lock.key);
    if (existing?.owner === lock.owner) {
      this.locks.delete(lock.key);
    }
  }

  async extend(lock: { key: string; owner: string }, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(lock.key);
    if (!existing || existing.owner !== lock.owner || existing.expiresAt <= Date.now()) {
      this.locks.delete(lock.key);
      return false;
    }

    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  private cleanupExpired(now = Date.now()): void {
    for (const [key, entry] of this.locks.entries()) {
      if (entry.expiresAt <= now) {
        this.locks.delete(key);
      }
    }
  }
}
