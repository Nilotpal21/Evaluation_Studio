import type { CallbackRegistry, CallbackRegistryEntry } from './callback-registry.js';

interface InMemoryCallbackRegistryOptions {
  maxEntries?: number;
  cleanupIntervalMs?: number;
}

interface StoredCallbackEntry {
  entry: CallbackRegistryEntry;
  registeredAt: number;
}

const DEFAULT_MAX_CALLBACK_ENTRIES = 5_000;
const DEFAULT_CALLBACK_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Test/dev callback registry with bounded in-memory storage.
 *
 * Mirrors the Redis registry semantics closely enough for single-process
 * harnesses: TTL expiry, claim-and-remove, and NX-style registration.
 */
export class InMemoryCallbackRegistry implements CallbackRegistry {
  private readonly entries = new Map<string, StoredCallbackEntry>();
  private readonly maxEntries: number;
  private readonly cleanupIntervalMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options: InMemoryCallbackRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CALLBACK_ENTRIES;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CALLBACK_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.sweepExpired(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async register(entry: CallbackRegistryEntry): Promise<void> {
    const now = Date.now();
    if (entry.expiresAt <= now) {
      return;
    }

    this.sweepExpired(now);
    const existing = this.entries.get(entry.callbackId);
    if (existing && existing.entry.expiresAt > now) {
      return;
    }

    this.evictOverflow(this.maxEntries - 1);
    this.entries.set(entry.callbackId, {
      entry: { ...entry },
      registeredAt: now,
    });
  }

  async lookup(callbackId: string): Promise<CallbackRegistryEntry | null> {
    const stored = this.entries.get(callbackId);
    if (!stored) {
      return null;
    }

    if (stored.entry.expiresAt <= Date.now()) {
      this.entries.delete(callbackId);
      return null;
    }

    return { ...stored.entry };
  }

  async claim(callbackId: string): Promise<CallbackRegistryEntry | null> {
    const stored = this.entries.get(callbackId);
    if (!stored) {
      return null;
    }

    if (stored.entry.expiresAt <= Date.now()) {
      this.entries.delete(callbackId);
      return null;
    }

    this.entries.delete(callbackId);
    return { ...stored.entry };
  }

  async remove(callbackId: string): Promise<void> {
    this.entries.delete(callbackId);
  }

  private sweepExpired(now = Date.now()): void {
    for (const [callbackId, stored] of this.entries.entries()) {
      if (stored.entry.expiresAt <= now) {
        this.entries.delete(callbackId);
      }
    }
  }

  private evictOverflow(targetSize: number): void {
    if (this.entries.size <= targetSize) {
      return;
    }

    const entriesByExpiry = [...this.entries.entries()].sort((left, right) => {
      if (left[1].entry.expiresAt !== right[1].entry.expiresAt) {
        return left[1].entry.expiresAt - right[1].entry.expiresAt;
      }
      return left[1].registeredAt - right[1].registeredAt;
    });

    while (this.entries.size > targetSize && entriesByExpiry.length > 0) {
      const next = entriesByExpiry.shift();
      if (!next) {
        break;
      }
      this.entries.delete(next[0]);
    }
  }
}
