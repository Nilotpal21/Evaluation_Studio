/**
 * Redis Trace Store
 *
 * Cross-pod trace delivery using Redis Streams + Pub/Sub.
 *
 * - XADD to trace:stream:{sessionId} for durable buffering (up to 500 events)
 * - PUBLISH to trace:channel:{sessionId} for real-time fan-out
 * - Subscriber receives buffered replay from Stream, then live from Pub/Sub
 * - Dedicated subscriber connection via createSubscriber(handle) — cluster-aware
 * - Anti-duplicate: skip local broadcast when event originated on same pod
 */

import type { WebSocket } from 'ws';
import type { TraceEvent, TraceReplayResult, TraceReadOptions } from '../trace-store.js';

export type { TraceEvent };

export interface TraceStoreConfig {
  maxEventsPerSession: number;
  maxAgeMinutes: number;
  sessionTimeoutMinutes: number;
  cleanupIntervalSeconds: number;
}

// =============================================================================
// REDIS TRACE STORE
// =============================================================================

import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { createSubscriber } from '@agent-platform/redis';
import { getRedisHandle } from '../redis/redis-client.js';

const log = createLogger('redis-trace-store');

import type { RedisClient } from '@agent-platform/redis';

const POD_ID = `pod_${crypto.randomUUID()}`;

export class RedisTraceStore {
  private redis: RedisClient;
  private subscriber: RedisClient | null = null;
  private localSubscribers = new Map<string, Set<WebSocket>>();
  private subscribedChannels = new Set<string>();
  private config: TraceStoreConfig;
  private streamTtlSeconds: number;
  /** In-memory cache: sessionId → tenantId (avoids repeated Redis lookups).
   *  Bounded to prevent unbounded growth in long-lived pods. */
  private tenantCache = new Map<string, string>();
  private static readonly MAX_TENANT_CACHE = 10_000;

  // =========================================================================
  // Memory high-water-mark circuit breaker
  // =========================================================================

  /** Fraction of maxmemory at which stream writes are shed (default 0.8). */
  private memoryThreshold: number;
  /** Cached result of the last memory pressure check. */
  private memoryPressureActive = false;
  /** Timestamp (ms) of the last INFO memory fetch. */
  private lastMemoryCheckMs = 0;
  /** How often to re-check Redis memory (ms). */
  private static readonly MEMORY_CHECK_INTERVAL_MS = 30_000;
  /** Timer handle for periodic memory check. */
  private memoryCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Count of events shed since last log (avoid log spam). */
  private shedCount = 0;

  constructor(redisClient: RedisClient, config: Partial<TraceStoreConfig> = {}) {
    this.redis = redisClient;
    this.config = {
      maxEventsPerSession: config.maxEventsPerSession || 2000,
      maxAgeMinutes: config.maxAgeMinutes || 15,
      sessionTimeoutMinutes: config.sessionTimeoutMinutes || 30,
      cleanupIntervalSeconds: config.cleanupIntervalSeconds || 60,
    };
    this.streamTtlSeconds = this.config.maxAgeMinutes * 60;

    const envThreshold = parseFloat(process.env.REDIS_TRACE_MEMORY_THRESHOLD || '');
    this.memoryThreshold =
      !isNaN(envThreshold) && envThreshold > 0 && envThreshold <= 1 ? envThreshold : 0.8;

    // Start periodic memory check
    this.startMemoryCheck();
  }

  /**
   * Start a periodic timer that refreshes Redis memory pressure status.
   * Runs every 30 seconds to keep the cached flag up to date even when
   * no addEvent() calls are in flight.
   */
  private startMemoryCheck(): void {
    // Fire immediately on construction (non-blocking)
    this.refreshMemoryPressure().catch(() => {
      /* ignore initial failure */
    });

    this.memoryCheckTimer = setInterval(() => {
      this.refreshMemoryPressure().catch((err: unknown) => {
        log.warn('Redis memory pressure check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, RedisTraceStore.MEMORY_CHECK_INTERVAL_MS);

    // Allow the process to exit even if the timer is still running
    if (this.memoryCheckTimer && typeof this.memoryCheckTimer.unref === 'function') {
      this.memoryCheckTimer.unref();
    }
  }

  /**
   * Fetch Redis INFO memory and update the cached pressure flag.
   * Parses used_memory and maxmemory from the INFO response.
   */
  private async refreshMemoryPressure(): Promise<void> {
    const now = Date.now();
    // Guard against concurrent/redundant refreshes within the interval
    if (now - this.lastMemoryCheckMs < RedisTraceStore.MEMORY_CHECK_INTERVAL_MS) return;
    this.lastMemoryCheckMs = now;

    try {
      const info: string = await this.redis.info('memory');
      const usedMemory = this.parseInfoField(info, 'used_memory');
      const maxMemory = this.parseInfoField(info, 'maxmemory');

      if (maxMemory <= 0) {
        // maxmemory=0 means no limit configured — cannot compute ratio
        this.memoryPressureActive = false;
        return;
      }

      const ratio = usedMemory / maxMemory;
      const wasPressured = this.memoryPressureActive;
      this.memoryPressureActive = ratio >= this.memoryThreshold;

      if (this.memoryPressureActive && !wasPressured) {
        log.warn('Redis memory pressure detected — trace stream writes will be shed', {
          usedMemory,
          maxMemory,
          ratio: ratio.toFixed(3),
          threshold: this.memoryThreshold,
        });
      } else if (!this.memoryPressureActive && wasPressured) {
        log.info('Redis memory pressure resolved — trace stream writes resumed', {
          usedMemory,
          maxMemory,
          ratio: ratio.toFixed(3),
          threshold: this.memoryThreshold,
          shedCount: this.shedCount,
        });
        this.shedCount = 0;
      }
    } catch {
      // If we can't check, stay with the last known state
    }
  }

  /**
   * Parse a numeric field from Redis INFO output.
   * INFO format is `key:value\r\n` per line.
   */
  private parseInfoField(info: string, field: string): number {
    const regex = new RegExp(`^${field}:(\\d+)`, 'm');
    const match = info.match(regex);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Check whether Redis memory pressure is active (cached, non-blocking).
   */
  private isMemoryPressure(): boolean {
    return this.memoryPressureActive;
  }

  // =========================================================================
  // Tenant-scoped key helpers
  // =========================================================================

  private streamKey(tenantId: string, sessionId: string): string {
    return `trace:stream:${tenantId}:${sessionId}`;
  }

  private channelKey(tenantId: string, sessionId: string): string {
    return `trace:channel:${tenantId}:${sessionId}`;
  }

  /**
   * Resolve tenantId for a session. Uses in-memory cache, then falls back to
   * the session store's reverse-lookup key, then to empty string.
   */
  private async resolveTenantId(sessionId: string, eventTenantId?: string): Promise<string> {
    if (eventTenantId) {
      this.cacheTenant(sessionId, eventTenantId);
      return eventTenantId;
    }
    const cached = this.tenantCache.get(sessionId);
    if (cached !== undefined) return cached;
    // Fall back to session store lookup key
    const tid = (await this.redis.get(`sess-tid:${sessionId}`)) || '';
    this.cacheTenant(sessionId, tid);
    return tid;
  }

  /** Bounded cache insertion — evicts oldest entry when at capacity. */
  private cacheTenant(sessionId: string, tenantId: string): void {
    if (this.tenantCache.size >= RedisTraceStore.MAX_TENANT_CACHE) {
      const firstKey = this.tenantCache.keys().next().value;
      if (firstKey) this.tenantCache.delete(firstKey);
    }
    this.tenantCache.set(sessionId, tenantId);
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Add a trace event. Writes to Redis Stream + publishes to Pub/Sub channel.
   * Single pipeline round-trip (~0.5ms).
   */
  async addEvent(sessionId: string, event: TraceEvent): Promise<void> {
    const tenantId = await this.resolveTenantId(sessionId, event.tenantId);
    const streamKey = this.streamKey(tenantId, sessionId);
    const channelKey = this.channelKey(tenantId, sessionId);

    const payload = JSON.stringify({ ...event, _pod: POD_ID });

    // Circuit breaker: skip Redis Stream write when memory pressure is active.
    // The event still reaches the WAL-backed EventStore → ClickHouse path,
    // and Pub/Sub publish is lightweight (no persistence), so we keep it.
    if (this.isMemoryPressure()) {
      this.shedCount++;
      if (this.shedCount % 1000 === 1) {
        log.warn('Trace stream write shed due to Redis memory pressure', {
          sessionId,
          shedCount: this.shedCount,
          threshold: this.memoryThreshold,
        });
      }
      // Still publish to Pub/Sub for real-time delivery (no stream persistence)
      await this.redis.publish(channelKey, payload);
      this.broadcastLocal(sessionId, event);
      return;
    }

    // Cluster-safe: streamKey and channelKey hash to different slots, so a
    // single pipeline would CROSSSLOT in cluster mode. Group ops by slot:
    // (xadd + expire) target streamKey and pipeline cleanly; publish goes
    // to channelKey on its own. We lose all-or-nothing atomicity across the
    // two keys, but xadd+expire still pipeline together (same slot), and
    // publish-after-write preserves the "subscribers never see an event
    // before it lands in the stream" ordering.
    const streamPipeline = this.redis.pipeline();
    streamPipeline.xadd(
      streamKey,
      'MAXLEN',
      '~',
      String(this.config.maxEventsPerSession),
      '*',
      'data',
      payload,
    );
    streamPipeline.expire(streamKey, this.streamTtlSeconds);
    await streamPipeline.exec();
    await this.redis.publish(channelKey, payload);

    // Also broadcast to local subscribers (immediate, no Redis round-trip)
    this.broadcastLocal(sessionId, event);
  }

  /**
   * Subscribe to a session's traces.
   * 1. Replay buffered events from Redis Stream
   * 2. Subscribe to Pub/Sub channel for live events
   * Returns { success, eventCount } of replayed events.
   */
  async subscribe(
    sessionId: string,
    ws: WebSocket,
    options?: TraceReadOptions,
  ): Promise<{ success: boolean; eventCount: number }> {
    // Add to local subscribers
    let subs = this.localSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.localSubscribers.set(sessionId, subs);
    }
    subs.add(ws);

    const tenantId = await this.resolveTenantId(sessionId, options?.tenantId);
    const replay = await this.readSince(sessionId, undefined, options);

    // Send replay message
    this.sendToClient(ws, {
      type: 'trace_replay',
      sessionId,
      events: replay.events,
      totalBuffered: replay.totalBuffered,
      source: 'subscribe',
      afterEventId: replay.afterEventId,
      snapshotRequired: replay.snapshotRequired,
    });

    // Subscribe to Pub/Sub channel if this is the first local subscriber
    const channelKey = this.channelKey(tenantId, sessionId);
    if (!this.subscribedChannels.has(channelKey)) {
      await this.ensureSubscriber();
      if (this.subscriber) {
        try {
          await this.subscriber.subscribe(channelKey);
          this.subscribedChannels.add(channelKey);
        } catch (err) {
          console.error(`[RedisTraceStore] Failed to subscribe to ${channelKey}:`, err);
        }
      }
    }

    console.log(
      `[RedisTraceStore] Client subscribed to ${sessionId}, replayed ${replay.events.length} events`,
    );

    return { success: true, eventCount: replay.events.length };
  }

  /**
   * Unsubscribe from a session.
   * Unsubscribes from Pub/Sub when last local WebSocket leaves.
   */
  unsubscribe(sessionId: string, ws: WebSocket): void {
    const subs = this.localSubscribers.get(sessionId);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) {
        this.localSubscribers.delete(sessionId);
        // Unsubscribe from Pub/Sub channel — use cached tenantId
        const tenantId = this.tenantCache.get(sessionId) || '';
        const channelKey = this.channelKey(tenantId, sessionId);
        if (this.subscribedChannels.has(channelKey) && this.subscriber) {
          this.subscriber.unsubscribe(channelKey).catch((err: unknown) =>
            log.warn('Redis trace unsubscribe failed', {
              error: err instanceof Error ? err.stack : String(err),
            }),
          );
          this.subscribedChannels.delete(channelKey);
        }
        this.tenantCache.delete(sessionId);
      }
    }
  }

  /**
   * Unsubscribe a client from all sessions.
   */
  unsubscribeAll(ws: WebSocket): void {
    for (const [sessionId, subs] of this.localSubscribers) {
      if (subs.has(ws)) {
        subs.delete(ws);
        if (subs.size === 0) {
          this.localSubscribers.delete(sessionId);
          const tenantId = this.tenantCache.get(sessionId) || '';
          const channelKey = this.channelKey(tenantId, sessionId);
          if (this.subscribedChannels.has(channelKey) && this.subscriber) {
            this.subscriber.unsubscribe(channelKey).catch((err: unknown) =>
              log.warn('Redis trace unsubscribe failed', {
                error: err instanceof Error ? err.stack : String(err),
              }),
            );
            this.subscribedChannels.delete(channelKey);
          }
          this.tenantCache.delete(sessionId);
        }
      }
    }
  }

  /**
   * Get all events for a session (from Redis Stream).
   */
  async getEvents(sessionId: string, options?: TraceReadOptions): Promise<TraceEvent[]> {
    const replay = await this.readSince(sessionId, undefined, options);
    return replay.events;
  }

  async readSince(
    sessionId: string,
    afterEventId?: string,
    options?: TraceReadOptions,
  ): Promise<TraceReplayResult> {
    const tenantId = await this.resolveTenantId(sessionId, options?.tenantId);
    const streamKey = this.streamKey(tenantId, sessionId);
    try {
      const entries = await this.redis.xrange(streamKey, '-', '+');
      if (!entries) {
        return {
          events: [],
          totalBuffered: 0,
          ...(afterEventId ? { afterEventId } : {}),
          snapshotRequired: false,
        };
      }

      const events = entries
        .map(([_id, fields]: [string, string[]]) => {
          try {
            const parsed = JSON.parse(fields[1]);
            delete parsed._pod;
            return { ...parsed, timestamp: new Date(parsed.timestamp) } as TraceEvent;
          } catch {
            return null;
          }
        })
        .filter((e: TraceEvent | null): e is TraceEvent => e !== null);

      if (!afterEventId) {
        return {
          events,
          totalBuffered: events.length,
          snapshotRequired: false,
        };
      }

      if (events.length === 0) {
        return {
          events: [],
          totalBuffered: 0,
          afterEventId,
          snapshotRequired: false,
        };
      }

      const lastSeenIndex = events.findIndex((event: TraceEvent) => event.id === afterEventId);
      if (lastSeenIndex === -1) {
        return {
          events: [],
          totalBuffered: events.length,
          afterEventId,
          snapshotRequired: true,
        };
      }

      return {
        events: events.slice(lastSeenIndex + 1),
        totalBuffered: events.length,
        afterEventId,
        snapshotRequired: false,
      };
    } catch {
      return {
        events: [],
        totalBuffered: 0,
        ...(afterEventId ? { afterEventId } : {}),
        snapshotRequired: false,
      };
    }
  }

  /**
   * Get active session IDs (sessions with local subscribers).
   */
  getActiveSessions(): string[] {
    return Array.from(this.localSubscribers.keys());
  }

  /**
   * Set agent name for a session (metadata stored locally + in stream).
   */
  setSessionAgent(sessionId: string, agentName: string): void {
    // Store as a metadata event in the stream
    this.addEvent(sessionId, {
      id: `meta_${Date.now()}`,
      sessionId,
      type: 'agent_enter',
      timestamp: new Date(),
      data: { agentName },
      agentName,
    }).catch((err: unknown) =>
      log.warn('Redis trace metadata event failed', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );
  }

  /**
   * Remove a session's traces.
   */
  async removeSession(sessionId: string): Promise<void> {
    const tenantId = await this.finalizeSession(sessionId);

    // Delete stream
    await this.redis.del(this.streamKey(tenantId, sessionId)).catch((err: unknown) =>
      log.warn('Redis trace stream delete failed', {
        error: err instanceof Error ? err.stack : String(err),
      }),
    );
    this.tenantCache.delete(sessionId);
  }

  /**
   * Finalize a session's live fan-out while preserving the Redis stream for
   * historical replay until TTL expiry or explicit deletion.
   */
  async finalizeSession(sessionId: string): Promise<string> {
    // Notify local subscribers
    const subs = this.localSubscribers.get(sessionId);
    if (subs) {
      for (const ws of subs) {
        this.sendToClient(ws, { type: 'session_ended', sessionId });
      }
      this.localSubscribers.delete(sessionId);
    }

    // Clean up Pub/Sub, but keep the buffered stream intact.
    const tenantId = this.tenantCache.get(sessionId) || (await this.resolveTenantId(sessionId));
    const channelKey = this.channelKey(tenantId, sessionId);
    if (this.subscribedChannels.has(channelKey) && this.subscriber) {
      this.subscriber.unsubscribe(channelKey).catch((err: unknown) =>
        log.warn('Redis trace unsubscribe failed', {
          error: err instanceof Error ? err.stack : String(err),
        }),
      );
      this.subscribedChannels.delete(channelKey);
    }

    return tenantId;
  }

  /**
   * Stop and clean up (for graceful shutdown).
   */
  async stop(): Promise<void> {
    // Stop periodic memory check
    if (this.memoryCheckTimer) {
      clearInterval(this.memoryCheckTimer);
      this.memoryCheckTimer = null;
    }

    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        // ignore
      }
      this.subscriber = null;
    }
    this.subscribedChannels.clear();
    this.localSubscribers.clear();
    this.tenantCache.clear();
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  /**
   * Ensure the dedicated subscriber Redis connection exists.
   */
  private async ensureSubscriber(): Promise<void> {
    if (this.subscriber) return;

    try {
      const handle = getRedisHandle();
      if (!handle) {
        // Fallback for standalone/test environments: use redis.duplicate() if available.
        if (typeof (this.redis as any).duplicate === 'function') {
          this.subscriber = (this.redis as any).duplicate() as RedisClient;
          await (this.subscriber as any).connect?.();
        } else {
          return;
        }
      } else {
        this.subscriber = createSubscriber(handle);
        await this.subscriber.connect();
      }

      // Handle messages from subscribed channels
      this.subscriber.on('message', (channel: string, message: string) => {
        this.handlePubSubMessage(channel, message);
      });

      this.subscriber.on('error', (err: Error) => {
        console.error('[RedisTraceStore] Subscriber error:', err.message);
      });
    } catch (err) {
      console.error('[RedisTraceStore] Failed to create subscriber:', err);
      this.subscriber = null;
    }
  }

  /**
   * Handle incoming Pub/Sub message.
   * Anti-duplicate: skip if event originated on this pod.
   */
  private handlePubSubMessage(channel: string, message: string): void {
    // Extract sessionId from channel: trace:channel:{tenantId}:{sessionId}
    // The sessionId is the last segment after the tenant prefix
    const parts = channel.split(':');
    const sessionId = parts[parts.length - 1];

    try {
      const event = JSON.parse(message);

      // Anti-duplicate: skip events from this pod (already broadcast locally)
      if (event._pod === POD_ID) return;

      delete event._pod;
      event.timestamp = new Date(event.timestamp);

      // Broadcast to local subscribers
      this.broadcastLocal(sessionId, event);
    } catch {
      // Ignore malformed messages
    }
  }

  /**
   * Broadcast to all local WebSocket subscribers for a session.
   */
  private broadcastLocal(sessionId: string, event: TraceEvent): void {
    const subs = this.localSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;

    const deadSockets: WebSocket[] = [];

    for (const ws of subs) {
      if (!this.sendToClient(ws, { type: 'trace_event', sessionId, event })) {
        deadSockets.push(ws);
      }
    }

    for (const ws of deadSockets) {
      subs.delete(ws);
    }
  }

  /**
   * Send a message to a WebSocket client.
   */
  private sendToClient(ws: WebSocket, message: unknown): boolean {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }
}
