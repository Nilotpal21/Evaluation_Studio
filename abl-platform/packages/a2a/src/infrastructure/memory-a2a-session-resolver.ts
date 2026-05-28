/**
 * MemoryA2ASessionResolver — In-memory A2A session resolver.
 *
 * Suitable for development, testing, and single-pod deployments.
 * Follows the InMemoryRateLimiter pattern: max entries, TTL, periodic cleanup.
 */

import type { A2ASessionResolverPort, ResolvedA2ASession } from '../domain/ports.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('a2a:memory-session-resolver');

interface SessionEntry {
  sessionId: string;
  lastAccessed: number;
}

export interface MemorySessionResolverOptions {
  /** Maximum number of entries before eviction (default: 10000) */
  maxEntries?: number;
  /** TTL in milliseconds (default: 86400000 = 24h) */
  ttlMs?: number;
  /** Cleanup interval in milliseconds (default: 60000 = 1 minute) */
  cleanupIntervalMs?: number;
}

export class MemoryA2ASessionResolver implements A2ASessionResolverPort {
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options?: MemorySessionResolverOptions) {
    this.maxEntries = options?.maxEntries ?? 10_000;
    this.ttlMs = options?.ttlMs ?? 86_400_000;
    const cleanupIntervalMs = options?.cleanupIntervalMs ?? 60_000;

    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  private key(tenantId: string, contextId: string): string {
    const safeTenantId = tenantId.replace(/:/g, '_');
    const safeContextId = contextId.replace(/:/g, '_');
    return `${safeTenantId}:${safeContextId}`;
  }

  async resolveSession(contextId: string, tenantId: string): Promise<ResolvedA2ASession> {
    const entry = this.sessions.get(this.key(tenantId, contextId));
    if (entry && Date.now() - entry.lastAccessed < this.ttlMs) {
      return { sessionId: entry.sessionId, isNew: false };
    }
    return { sessionId: '', isNew: true };
  }

  async registerSession(contextId: string, tenantId: string, sessionId: string): Promise<void> {
    this.evictIfNeeded();
    this.sessions.set(this.key(tenantId, contextId), {
      sessionId,
      lastAccessed: Date.now(),
    });
    log.debug('Registered session mapping', { tenantId, contextId, sessionId });
  }

  async touchSession(contextId: string, tenantId: string): Promise<void> {
    const k = this.key(tenantId, contextId);
    const entry = this.sessions.get(k);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
  }

  async closeSession(contextId: string, tenantId: string): Promise<void> {
    this.sessions.delete(this.key(tenantId, contextId));
    log.debug('Closed session mapping', { tenantId, contextId });
  }

  /**
   * Atomic register-if-absent. In single-threaded JS, the synchronous Map check
   * is inherently atomic within a single event loop tick. However, the async
   * resolve→create→register sequence in the adapter spans multiple ticks,
   * so this method provides the atomic check-and-set that the adapter needs.
   */
  async registerSessionIfAbsent(
    contextId: string,
    tenantId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; alreadyExisted: boolean }> {
    const k = this.key(tenantId, contextId);
    const existing = this.sessions.get(k);
    if (existing && Date.now() - existing.lastAccessed < this.ttlMs) {
      log.debug('Session already registered by concurrent request', {
        tenantId,
        contextId,
        requestedSessionId: sessionId,
        existingSessionId: existing.sessionId,
      });
      return { sessionId: existing.sessionId, alreadyExisted: true };
    }

    this.evictIfNeeded();
    this.sessions.set(k, { sessionId, lastAccessed: Date.now() });
    log.debug('Atomically registered session mapping', { tenantId, contextId, sessionId });
    return { sessionId, alreadyExisted: false };
  }

  /** Test-only: returns all current session entries. */
  getAllSessions(): Map<string, SessionEntry> {
    return new Map(this.sessions);
  }

  /** Clears the cleanup interval and all entries. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.sessions.entries()) {
      if (now - entry.lastAccessed >= this.ttlMs) {
        this.sessions.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug('Cleanup evicted stale sessions', { evicted, remaining: this.sessions.size });
    }
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxEntries) return;

    // Evict the oldest entries to make room
    const entries = [...this.sessions.entries()].sort(
      (a, b) => a[1].lastAccessed - b[1].lastAccessed,
    );
    const toEvict = Math.max(1, Math.floor(this.maxEntries * 0.1));
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      this.sessions.delete(entries[i][0]);
    }
    log.debug('Capacity eviction', { evicted: toEvict, remaining: this.sessions.size });
  }
}
