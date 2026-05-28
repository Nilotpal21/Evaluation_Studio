/**
 * Trace Store
 *
 * Production-ready bounded trace storage with:
 * - Ring buffer per session (fixed size, oldest dropped when full)
 * - Time-based expiry (traces older than maxAgeMinutes removed)
 * - Session subscriptions for real-time streaming
 * - Replay on subscribe (catch up on buffered traces)
 * - Automatic cleanup of inactive sessions
 */

import type { WebSocket } from 'ws';
import { OtelTraceStore } from '../observability/otel-trace-bridge.js';

// =============================================================================
// TYPES
// =============================================================================

import type { TraceEvent as BaseTraceEvent } from '@agent-platform/shared-kernel';

/** Stored trace event — extends canonical with storage fields */
export interface TraceEvent extends Omit<BaseTraceEvent, 'type'> {
  id: string;
  sessionId: string;
  type: string;
  timestamp: Date;
  data: Record<string, unknown>;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase?: string;
  reasonCode?: string;
  decisionKind?: string;
  tenantId?: string;
}

export interface TraceStoreConfig {
  /** Maximum events to keep per session (ring buffer size) */
  maxEventsPerSession: number;
  /** Maximum age of traces in minutes */
  maxAgeMinutes: number;
  /** Session timeout in minutes (inactive sessions get purged) */
  sessionTimeoutMinutes: number;
  /** Cleanup interval in seconds */
  cleanupIntervalSeconds: number;
  /** Maximum number of sessions to track in memory (default: 50000) */
  maxSessions: number;
}

interface SessionTraceData {
  events: TraceEvent[];
  subscribers: Set<WebSocket>;
  lastActivity: Date;
  agentName?: string;
  isLive: boolean;
}

export interface TraceReplayResult {
  events: TraceEvent[];
  totalBuffered: number;
  afterEventId?: string;
  snapshotRequired: boolean;
}

export interface TraceReadOptions {
  tenantId?: string;
}

// =============================================================================
// TRACE STORE INTERFACE (for Memory/Redis implementations)
// =============================================================================

export interface TraceStoreInterface {
  addEvent(sessionId: string, event: TraceEvent): void | Promise<void>;
  readSince(
    sessionId: string,
    afterEventId?: string,
    options?: TraceReadOptions,
  ): TraceReplayResult | Promise<TraceReplayResult>;
  subscribe(
    sessionId: string,
    ws: WebSocket,
    options?: TraceReadOptions,
  ): { success: boolean; eventCount: number } | Promise<{ success: boolean; eventCount: number }>;
  unsubscribe(sessionId: string, ws: WebSocket): void;
  unsubscribeAll(ws: WebSocket): void;
  getEvents(sessionId: string, options?: TraceReadOptions): TraceEvent[] | Promise<TraceEvent[]>;
  getActiveSessions(): string[];
  getSessionInfo?(sessionId: string): {
    eventCount: number;
    subscriberCount: number;
    lastActivity: Date | null;
    agentName?: string;
  } | null;
  touchSession?(sessionId: string): void;
  clearSession?(sessionId: string): void;
  finalizeSession?(sessionId: string): void | Promise<void>;
  setSessionAgent(sessionId: string, agentName: string): void;
  removeSession(sessionId: string): void | Promise<void>;
  stop(): void | Promise<void>;
  getStats?(): {
    sessionCount: number;
    totalEvents: number;
    totalSubscribers: number;
    config: TraceStoreConfig;
  };
}

// =============================================================================
// DEFAULT CONFIGURATION
// =============================================================================

const DEFAULT_CONFIG: TraceStoreConfig = {
  maxEventsPerSession: parseInt(process.env.TRACE_MAX_EVENTS_PER_SESSION || '2000', 10),
  maxAgeMinutes: parseInt(process.env.TRACE_MAX_AGE_MINUTES || '120', 10),
  sessionTimeoutMinutes: parseInt(process.env.TRACE_SESSION_TIMEOUT_MINUTES || '120', 10),
  cleanupIntervalSeconds: 60,
  maxSessions: 50000,
};

// =============================================================================
// TRACE STORE
// =============================================================================

export class TraceStore implements TraceStoreInterface {
  private sessions: Map<string, SessionTraceData> = new Map();
  private config: TraceStoreConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private otelBridge: OtelTraceStore | null = null;

  constructor(config: Partial<TraceStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupJob();

    // Instantiate OtelTraceStore when OTEL is configured
    const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otelEndpoint) {
      try {
        const envMap: Record<string, 'dev' | 'staging' | 'production'> = {
          development: 'dev',
          staging: 'staging',
          production: 'production',
        };
        const nodeEnv = process.env.NODE_ENV || 'development';
        this.otelBridge = new OtelTraceStore({
          type: 'memory',
          environment: envMap[nodeEnv] || 'dev',
        });
        console.log(
          '[TraceStore] OTEL trace bridge enabled — spans will be forwarded to collector',
        );
      } catch (error) {
        console.warn('[TraceStore] Failed to initialize OTEL trace bridge:', error);
      }
    }
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Add a trace event to a session
   * Broadcasts to all subscribers and stores in ring buffer
   */
  addEvent(sessionId: string, event: TraceEvent): void {
    const session = this.getOrCreateSession(sessionId);

    // Update activity timestamp
    session.lastActivity = new Date();
    session.isLive = true;

    // Add to ring buffer (drop oldest if full)
    if (session.events.length >= this.config.maxEventsPerSession) {
      session.events.shift();
    }
    session.events.push(event);

    // Forward to OTEL trace bridge (fire-and-forget)
    if (this.otelBridge) {
      this.otelBridge
        .appendEvent(sessionId, {
          type: event.type as any,
          timestamp: event.timestamp,
          data: event.data,
          durationMs: (event.data?.durationMs as number) ?? undefined,
        })
        .catch(() => {
          /* swallow OTEL errors */
        });
    }

    // Broadcast to all subscribers
    this.broadcastToSubscribers(sessionId, {
      type: 'trace_event',
      sessionId,
      event,
    });
  }

  /**
   * Subscribe to a session's traces
   * Immediately replays buffered traces, then streams live
   */
  subscribe(
    sessionId: string,
    ws: WebSocket,
    _options?: TraceReadOptions,
  ): { success: boolean; eventCount: number } {
    const session = this.getOrCreateSession(sessionId);

    // Add subscriber
    session.subscribers.add(ws);
    session.isLive = true;

    // Get events within the time window
    const replay = this.readSince(sessionId);

    // Send replay message with buffered traces
    this.sendToClient(ws, {
      type: 'trace_replay',
      sessionId,
      events: replay.events,
      totalBuffered: replay.totalBuffered,
      source: 'subscribe',
      afterEventId: replay.afterEventId,
      snapshotRequired: replay.snapshotRequired,
    });

    console.log(
      `[TraceStore] Client subscribed to session ${sessionId}, replayed ${replay.events.length} events`,
    );

    return { success: true, eventCount: replay.events.length };
  }

  /**
   * Unsubscribe from a session
   */
  unsubscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscribers.delete(ws);
      console.log(`[TraceStore] Client unsubscribed from session ${sessionId}`);
    }
  }

  /**
   * Unsubscribe a client from all sessions (on disconnect)
   */
  unsubscribeAll(ws: WebSocket): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.subscribers.has(ws)) {
        session.subscribers.delete(ws);
        console.log(`[TraceStore] Client auto-unsubscribed from session ${sessionId}`);
      }
    }
  }

  /**
   * Get all events for a session (within time window)
   */
  getEvents(sessionId: string, _options?: TraceReadOptions): TraceEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return this.getValidEvents(session);
  }

  readSince(
    sessionId: string,
    afterEventId?: string,
    _options?: TraceReadOptions,
  ): TraceReplayResult {
    const session = this.sessions.get(sessionId);
    const validEvents = session ? this.getValidEvents(session) : [];

    if (!afterEventId) {
      return {
        events: validEvents,
        totalBuffered: validEvents.length,
        snapshotRequired: false,
      };
    }

    if (validEvents.length === 0) {
      return {
        events: [],
        totalBuffered: 0,
        afterEventId,
        snapshotRequired: false,
      };
    }

    const lastSeenIndex = validEvents.findIndex((event) => event.id === afterEventId);
    if (lastSeenIndex === -1) {
      return {
        events: [],
        totalBuffered: validEvents.length,
        afterEventId,
        snapshotRequired: true,
      };
    }

    return {
      events: validEvents.slice(lastSeenIndex + 1),
      totalBuffered: validEvents.length,
      afterEventId,
      snapshotRequired: false,
    };
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => session.isLive)
      .map(([sessionId]) => sessionId);
  }

  /**
   * Get session info
   */
  getSessionInfo(sessionId: string): {
    eventCount: number;
    subscriberCount: number;
    lastActivity: Date | null;
    agentName?: string;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      eventCount: this.getValidEvents(session).length,
      subscriberCount: session.subscribers.size,
      lastActivity: session.lastActivity,
      agentName: session.agentName,
    };
  }

  /**
   * Set agent name for a session
   */
  setSessionAgent(sessionId: string, agentName: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.agentName = agentName;
  }

  /**
   * Touch a session to update its activity timestamp
   */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  /**
   * Clear all traces for a session (but keep it active)
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.events = [];
      session.lastActivity = new Date();
      session.isLive = true;
      console.log(`[TraceStore] Cleared traces for session ${sessionId}`);
    }
  }

  /**
   * Finalize a session's live fan-out while preserving the buffered trace snapshot.
   * This keeps just-completed sessions debuggable until TTL cleanup or explicit deletion.
   */
  finalizeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.broadcastToSubscribers(sessionId, {
      type: 'session_ended',
      sessionId,
    });
    session.subscribers.clear();
    session.isLive = false;
    session.lastActivity = new Date();
  }

  /**
   * Remove a session entirely
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Notify subscribers that session is ending
      this.broadcastToSubscribers(sessionId, {
        type: 'session_ended',
        sessionId,
      });
      this.sessions.delete(sessionId);
      console.log(`[TraceStore] Removed session ${sessionId}`);
    }
  }

  /**
   * Stop the cleanup job (for shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get store statistics
   */
  getStats(): {
    sessionCount: number;
    totalEvents: number;
    totalSubscribers: number;
    config: TraceStoreConfig;
  } {
    let totalEvents = 0;
    let totalSubscribers = 0;

    for (const session of this.sessions.values()) {
      totalEvents += session.events.length;
      totalSubscribers += session.subscribers.size;
    }

    return {
      sessionCount: this.sessions.size,
      totalEvents,
      totalSubscribers,
      config: this.config,
    };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  private getOrCreateSession(sessionId: string): SessionTraceData {
    let session = this.sessions.get(sessionId);
    if (!session) {
      // Evict oldest session if at capacity
      if (this.sessions.size >= this.config.maxSessions) {
        const oldestKey = this.sessions.keys().next().value;
        if (oldestKey) {
          this.sessions.delete(oldestKey);
        }
      }
      session = {
        events: [],
        subscribers: new Set(),
        lastActivity: new Date(),
        isLive: true,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private getValidEvents(session: SessionTraceData): TraceEvent[] {
    const cutoff = new Date(Date.now() - this.config.maxAgeMinutes * 60 * 1000);
    return session.events.filter((e) => e.timestamp >= cutoff);
  }

  private broadcastToSubscribers(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const deadSockets: WebSocket[] = [];

    for (const ws of session.subscribers) {
      if (!this.sendToClient(ws, message)) {
        deadSockets.push(ws);
      }
    }

    // Clean up dead sockets
    for (const ws of deadSockets) {
      session.subscribers.delete(ws);
    }
  }

  private sendToClient(ws: WebSocket, message: unknown): boolean {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
        return true;
      }
    } catch (error) {
      console.error('[TraceStore] Failed to send to client:', error);
    }
    return false;
  }

  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalSeconds * 1000);
    // Don't hold the event loop open for background cleanup
    this.cleanupInterval.unref();
  }

  private cleanup(): void {
    const now = new Date();
    const sessionTimeout = this.config.sessionTimeoutMinutes * 60 * 1000;
    const maxAge = this.config.maxAgeMinutes * 60 * 1000;
    let sessionsRemoved = 0;
    let eventsRemoved = 0;

    for (const [sessionId, session] of this.sessions) {
      // Remove inactive sessions
      if (now.getTime() - session.lastActivity.getTime() > sessionTimeout) {
        // Notify subscribers before removal
        this.broadcastToSubscribers(sessionId, {
          type: 'session_expired',
          sessionId,
          reason: 'inactive',
        });
        this.sessions.delete(sessionId);
        sessionsRemoved++;
        continue;
      }

      // Remove old events from active sessions
      const cutoff = new Date(now.getTime() - maxAge);
      const beforeCount = session.events.length;
      session.events = session.events.filter((e) => e.timestamp >= cutoff);
      eventsRemoved += beforeCount - session.events.length;
    }

    if (sessionsRemoved > 0 || eventsRemoved > 0) {
      console.log(
        `[TraceStore] Cleanup: removed ${sessionsRemoved} sessions, ${eventsRemoved} events`,
      );
    }
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let traceStoreInstance: TraceStoreInterface | null = null;

/**
 * Get the trace store singleton.
 * Uses RedisTraceStore when Redis is available, otherwise MemoryTraceStore (TraceStore).
 */
export function getTraceStore(): TraceStoreInterface {
  if (!traceStoreInstance) {
    let useRedis = false;
    try {
      const { getRedisClient, isRedisAvailable } = require('./redis/redis-client.js');
      const redisClient = getRedisClient();
      if (redisClient && isRedisAvailable()) {
        const { RedisTraceStore } = require('./trace/redis-trace-store.js');
        traceStoreInstance = new RedisTraceStore(redisClient, {
          maxAgeMinutes: parseInt(process.env.TRACE_MAX_AGE_MINUTES || '120', 10),
        });
        useRedis = true;
        console.log('[TraceStore] Initialized with RedisTraceStore');
      }
    } catch {
      // Redis not available, fall through to memory store
    }

    if (!useRedis) {
      traceStoreInstance = new TraceStore();
      console.log('[TraceStore] Initialized with MemoryTraceStore');
    }
  }
  return traceStoreInstance!;
}

/**
 * Get the trace store, guaranteed to return the memory implementation.
 * Used by callers that need TraceStore-specific methods (getSessionInfo, getStats, etc.).
 */
export function getMemoryTraceStore(): TraceStore {
  const store = getTraceStore();
  if (store instanceof TraceStore) {
    return store;
  }
  // If Redis is being used, create a separate memory store for local-only needs
  return new TraceStore();
}

export function resetTraceStore(): void {
  if (traceStoreInstance) {
    if ('stop' in traceStoreInstance) {
      (traceStoreInstance as any).stop();
    }
  }
  traceStoreInstance = null;
}
