/**
 * Paused Execution Store (Phase 5 — JIT Auth)
 *
 * Manages tool executions that are paused waiting for user authentication.
 * When a tool with `jit_auth: true` needs credentials, execution is paused
 * and an `auth_challenge` message is sent to the client. The paused state
 * is tracked here until the user completes auth or the timeout expires.
 *
 * Storage:
 * - In-memory Map for pending Promises (pod-local, since the WS connection
 *   is sticky to one pod)
 * - Redis keys `paused-exec:{sessionId}:{toolCallId}` for cross-pod visibility
 *   and TTL-based cleanup
 *
 * TTL: Configurable via `JIT_AUTH_TIMEOUT_MS` env var (default 600000 = 10min)
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@abl/compiler/platform';
import { getRedisClient, getRedisHandle, isRedisAvailable } from '../redis/redis-client.js';
import { createSubscriber, scanKeys } from '@agent-platform/redis';

const log = createLogger('paused-execution-store');

/** Default timeout for JIT auth (10 minutes) */
const DEFAULT_JIT_AUTH_TIMEOUT_MS = 600_000;

/** Redis key prefix */
const REDIS_KEY_PREFIX = 'paused-exec:';
const JIT_SIGNAL_CHANNEL = 'jit-auth:signal';
const JIT_SIGNAL_ACK_CHANNEL = 'jit-auth:signal-ack';
const JIT_SIGNAL_RESULT_PREFIX = 'jit-auth:signal-result:';

/** Max tracked paused executions to prevent memory leaks */
const MAX_PAUSED_EXECUTIONS = 1000;

/** Periodic sweep interval for expired entries (60 seconds) */
const SWEEP_INTERVAL_MS = 60_000;
const SIGNAL_ACK_TIMEOUT_MS = 1_500;
const SIGNAL_RESULT_TTL_MS = 30_000;

export interface PausedExecutionData {
  sessionId: string;
  toolCallId: string;
  authProfileRef: string;
  toolName: string;
  pausedAt: number;
  timeoutMs: number;
}

interface PendingExecution {
  data: PausedExecutionData;
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PausedExecutionWaiter extends Promise<void> {
  ready: Promise<void>;
}

/**
 * Custom error types for JIT auth failures
 */
export class AuthTimeoutError extends Error {
  constructor(profileName: string, timeoutMs: number) {
    super(
      `Authorization timed out. The user did not authorize ${profileName} within ${Math.round(timeoutMs / 1000 / 60)} minutes.`,
    );
    this.name = 'AuthTimeoutError';
  }
}

export class AuthCancelledError extends Error {
  constructor() {
    super('Authorization was cancelled by the user.');
    this.name = 'AuthCancelledError';
  }
}

export class SessionDisconnectedError extends Error {
  constructor() {
    super('Session disconnected before authorization completed.');
    this.name = 'SessionDisconnectedError';
  }
}

type CleanupReason = 'disconnect';
type ResumeSignal =
  | {
      action: 'resolve';
      sessionId: string;
      toolCallId: string;
      requestId?: string;
    }
  | {
      action: 'reject';
      sessionId: string;
      toolCallId: string;
      reason: CleanupReason | 'cancelled' | 'error';
      message?: string;
      requestId?: string;
    };

interface ResumeSignalAck {
  requestId: string;
  sessionId: string;
  toolCallId: string;
}

export type DistributedSignalResult = 'handled' | 'missing' | 'delivery_failed' | 'unavailable';
type RedisKeyPresence = 'present' | 'missing' | 'unavailable';

interface PendingSignalAck {
  resolve: (ack: ResumeSignalAck | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PausedExecutionStore {
  private pending = new Map<string, PendingExecution>();
  private pendingSignalAcks = new Map<string, PendingSignalAck>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private redisSubscriber: any | null = null;
  private subscriberInitPromise: Promise<void> | null = null;

  constructor() {
    // Periodic sweep removes entries whose timeout has passed but whose
    // rejection was not consumed (e.g. the setTimeout fired but the Promise
    // was never awaited and the entry lingered).
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    if (this.sweepTimer && typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }

    void this.ensureRedisSubscriber();
  }

  /** Get the configured JIT auth timeout */
  getTimeoutMs(): number {
    const envVal = process.env.JIT_AUTH_TIMEOUT_MS;
    if (envVal) {
      const parsed = parseInt(envVal, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_JIT_AUTH_TIMEOUT_MS;
  }

  /**
   * Pause a tool execution and return a Promise that resolves when
   * the user completes auth or rejects on timeout/cancel.
   */
  pause(data: PausedExecutionData): PausedExecutionWaiter {
    if (this.pending.size >= MAX_PAUSED_EXECUTIONS) {
      throw new Error('Too many paused executions — possible leak. Max: ' + MAX_PAUSED_EXECUTIONS);
    }

    const key = data.toolCallId;
    let resolveWaiter: () => void = () => {};
    let rejectWaiter: (err: Error) => void = () => {};

    const waiter = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    }) as PausedExecutionWaiter;

    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.deleteRedisKey(data.sessionId, data.toolCallId).catch((err: unknown) => {
        log.warn('Redis key cleanup failed', {
          sessionId: data.sessionId,
          toolCallId: data.toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      rejectWaiter(new AuthTimeoutError(data.authProfileRef, data.timeoutMs));
    }, data.timeoutMs);

    // Ensure timer doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref();
    }

    this.pending.set(key, {
      data,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer,
    });

    log.info('Tool execution paused for JIT auth', {
      toolCallId: data.toolCallId,
      sessionId: data.sessionId,
      toolName: data.toolName,
      authProfileRef: data.authProfileRef,
      timeoutMs: data.timeoutMs,
    });

    waiter.ready = (async () => {
      try {
        await this.ensureRedisSubscriber();
        await this.writeRedisKey(data);
      } catch (err) {
        const entry = this.pending.get(key);
        const error = err instanceof Error ? err : new Error(String(err));
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(key);
          this.deleteRedisKey(data.sessionId, data.toolCallId).catch((cleanupErr: unknown) => {
            log.warn('Redis key cleanup failed', {
              sessionId: data.sessionId,
              toolCallId: data.toolCallId,
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          });
          entry.reject(error);
        }
        throw error;
      }
    })();

    return waiter;
  }

  /**
   * Resolve a paused execution (user completed auth successfully).
   */
  resolve(toolCallId: string): void {
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      log.warn('No paused execution found for toolCallId', { toolCallId });
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    this.deleteRedisKey(entry.data.sessionId, toolCallId).catch((err: unknown) => {
      log.warn('Redis key cleanup failed', {
        sessionId: entry.data.sessionId,
        toolCallId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    entry.resolve();

    log.info('Paused execution resolved', {
      toolCallId,
      sessionId: entry.data.sessionId,
    });
  }

  /**
   * Reject a paused execution (user cancelled or error).
   */
  reject(toolCallId: string, error: Error): void {
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      log.warn('No paused execution found for toolCallId', { toolCallId });
      return;
    }

    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    this.deleteRedisKey(entry.data.sessionId, toolCallId).catch((err: unknown) => {
      log.warn('Redis key cleanup failed', {
        sessionId: entry.data.sessionId,
        toolCallId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    entry.reject(error);

    log.info('Paused execution rejected', {
      toolCallId,
      sessionId: entry.data.sessionId,
      reason: error.message,
    });
  }

  async resolveDistributed(
    sessionId: string,
    toolCallId: string,
  ): Promise<DistributedSignalResult> {
    return this.signalDistributed({
      action: 'resolve',
      sessionId,
      toolCallId,
    });
  }

  async rejectDistributed(
    sessionId: string,
    toolCallId: string,
    reason: CleanupReason | 'cancelled',
  ): Promise<DistributedSignalResult> {
    return this.signalDistributed({
      action: 'reject',
      sessionId,
      toolCallId,
      reason,
    });
  }

  async rejectDistributedError(
    sessionId: string,
    toolCallId: string,
    message: string,
  ): Promise<DistributedSignalResult> {
    return this.signalDistributed({
      action: 'reject',
      sessionId,
      toolCallId,
      reason: 'error',
      message,
    });
  }

  /**
   * Check if a toolCallId has a paused execution.
   */
  has(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  /**
   * Get data for a paused execution.
   */
  get(toolCallId: string): PausedExecutionData | null {
    return this.pending.get(toolCallId)?.data ?? null;
  }

  /**
   * Clean up all paused executions for a session (on disconnect).
   */
  async cleanupSession(sessionId: string, reason: CleanupReason = 'disconnect'): Promise<void> {
    let cleanedLocal = 0;
    const localToolCallIds = new Set<string>();
    for (const [key, entry] of this.pending) {
      if (entry.data.sessionId === sessionId) {
        this.reject(key, this.buildCleanupError(reason));
        localToolCallIds.add(key);
        cleanedLocal++;
      }
    }

    let cleanedRemote = 0;
    const remoteToolCallIds = await this.listRedisToolCallIds(sessionId);
    for (const toolCallId of remoteToolCallIds) {
      if (localToolCallIds.has(toolCallId)) {
        continue;
      }

      const result = await this.rejectDistributed(sessionId, toolCallId, reason);
      if (result === 'handled') {
        cleanedRemote++;
        continue;
      }

      if (result === 'delivery_failed' || result === 'unavailable') {
        log.warn('Failed to propagate paused execution cleanup to owning pod', {
          sessionId,
          toolCallId,
          reason,
          result,
        });
      }
    }

    try {
      const { getToolOAuthService } = await import('../tool-oauth-service-singleton.js');
      const oauthService = getToolOAuthService();
      if (oauthService) {
        const deletedArtifacts =
          await oauthService.cleanupSessionScopedArtifactsBySessionId(sessionId);
        if (deletedArtifacts > 0) {
          log.info('Cleaned up session-scoped OAuth artifacts', {
            sessionId,
            count: deletedArtifacts,
          });
        }
      }
    } catch (err) {
      log.warn('Failed to cleanup session-scoped OAuth artifacts', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (cleanedLocal > 0 || cleanedRemote > 0) {
      log.info('Cleaned up paused executions for disconnected session', {
        sessionId,
        count: cleanedLocal + cleanedRemote,
      });
    }
  }

  private async signalDistributed(signal: ResumeSignal): Promise<DistributedSignalResult> {
    const localEntry = this.pending.get(signal.toolCallId);
    if (localEntry?.data.sessionId === signal.sessionId) {
      if (signal.action === 'resolve') {
        this.resolve(signal.toolCallId);
      } else if (signal.reason === 'error') {
        this.reject(
          signal.toolCallId,
          new Error(signal.message ?? 'Authorization failed. Please retry the tool call.'),
        );
      } else if (signal.reason === 'cancelled') {
        this.reject(signal.toolCallId, new AuthCancelledError());
      } else {
        this.reject(signal.toolCallId, this.buildCleanupError(signal.reason));
      }

      return 'handled';
    }

    const redisKeyPresence = await this.getRedisKeyPresence(signal.sessionId, signal.toolCallId);
    if (redisKeyPresence === 'unavailable') {
      return 'unavailable';
    }
    if (redisKeyPresence === 'missing') {
      return 'missing';
    }

    if (!isRedisAvailable()) {
      return 'unavailable';
    }

    await this.ensureRedisSubscriber();

    const requestId = randomUUID();
    const ackPromise = this.waitForSignalAck(requestId);

    let subscriberCount = 0;
    try {
      subscriberCount = await this.publishSignal({
        ...signal,
        requestId,
      });
    } catch (err) {
      this.clearPendingSignalAck(requestId);
      log.warn('Failed to publish paused execution signal', {
        error: err instanceof Error ? err.message : String(err),
        toolCallId: signal.toolCallId,
        sessionId: signal.sessionId,
        action: signal.action,
      });
      return 'delivery_failed';
    }

    if (subscriberCount === 0) {
      this.clearPendingSignalAck(requestId);
      const remainingPresence = await this.getRedisKeyPresence(signal.sessionId, signal.toolCallId);
      if (remainingPresence === 'unavailable') {
        return 'unavailable';
      }
      return remainingPresence === 'present' ? 'delivery_failed' : 'missing';
    }

    const ack = await ackPromise;
    if (ack) {
      await this.deleteSignalResult(requestId);
      return 'handled';
    }

    const recordedResult = await this.readSignalResult(requestId);
    await this.deleteSignalResult(requestId);
    if (recordedResult === 'handled') {
      return 'handled';
    }

    const remainingPresence = await this.getRedisKeyPresence(signal.sessionId, signal.toolCallId);
    if (remainingPresence === 'unavailable') {
      return 'unavailable';
    }
    return remainingPresence === 'present' ? 'delivery_failed' : 'missing';
  }

  /**
   * Get count of pending executions (for monitoring).
   */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Sweep expired entries that may have lingered past their timeout.
   * The setTimeout in pause() should handle most cases, but this is a
   * safety net for entries whose rejection was not consumed.
   */
  private sweepExpired(): void {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of this.pending) {
      const expiresAt = entry.data.pausedAt + entry.data.timeoutMs;
      if (now > expiresAt) {
        clearTimeout(entry.timer);
        entry.reject(new AuthTimeoutError(entry.data.authProfileRef, entry.data.timeoutMs));
        this.pending.delete(key);
        swept++;
      }
    }
    if (swept > 0) {
      log.info('Swept expired paused executions', { count: swept, remaining: this.pending.size });
    }
  }

  /**
   * Stop the periodic sweep timer (for graceful shutdown / testing).
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.redisSubscriber) {
      void this.redisSubscriber.quit?.().catch((err: unknown) => {
        log.warn('Redis subscriber quit failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.redisSubscriber = null;
      this.subscriberInitPromise = null;
    }
    for (const [requestId, pendingAck] of this.pendingSignalAcks) {
      clearTimeout(pendingAck.timer);
      pendingAck.resolve(null);
      this.pendingSignalAcks.delete(requestId);
    }
    // Reject all remaining paused executions
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('PausedExecutionStore shutting down'));
      this.pending.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Redis operations
  // ---------------------------------------------------------------------------

  private async writeRedisKey(data: PausedExecutionData): Promise<void> {
    if (!isRedisAvailable()) return;
    try {
      const redis = getRedisClient();
      if (!redis) {
        throw new Error('Redis client unavailable for paused execution persistence');
      }
      const key = `${REDIS_KEY_PREFIX}${data.sessionId}:${data.toolCallId}`;
      const ttlSeconds = Math.ceil(data.timeoutMs / 1000);
      await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
    } catch (err) {
      log.warn('Failed to write paused execution to Redis', {
        error: err instanceof Error ? err.message : String(err),
        toolCallId: data.toolCallId,
      });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private buildCleanupError(_reason: CleanupReason): Error {
    return new SessionDisconnectedError();
  }

  private async ensureRedisSubscriber(): Promise<void> {
    if (this.redisSubscriber || this.subscriberInitPromise) {
      await this.subscriberInitPromise;
      return;
    }
    if (!isRedisAvailable()) return;

    const handle = getRedisHandle();
    if (!handle) {
      throw new Error('Redis subscriber unavailable for paused execution coordination');
    }

    this.subscriberInitPromise = (async () => {
      try {
        const subscriber = createSubscriber(handle);
        subscriber.on('message', (channel: string, message: string) => {
          if (channel === JIT_SIGNAL_CHANNEL) {
            this.handleSignalMessage(message);
            return;
          }

          if (channel === JIT_SIGNAL_ACK_CHANNEL) {
            this.handleSignalAck(message);
          }
        });
        subscriber.on('error', (err: Error) => {
          log.warn('Paused execution Redis subscriber error', {
            error: err.message,
          });
        });
        await subscriber.subscribe(JIT_SIGNAL_CHANNEL);
        await subscriber.subscribe(JIT_SIGNAL_ACK_CHANNEL);
        this.redisSubscriber = subscriber;
      } catch (err) {
        this.redisSubscriber = null;
        log.warn('Failed to initialize paused execution Redis subscriber', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        this.subscriberInitPromise = null;
      }
    })();

    await this.subscriberInitPromise;
  }

  private handleSignalMessage(rawMessage: string): void {
    let signal: ResumeSignal | null = null;
    try {
      signal = JSON.parse(rawMessage) as ResumeSignal;
    } catch {
      return;
    }

    if (!signal?.toolCallId || !signal.sessionId) {
      return;
    }

    const entry = this.pending.get(signal.toolCallId);
    if (!entry || entry.data.sessionId !== signal.sessionId) {
      return;
    }

    if (signal.action === 'resolve') {
      this.resolve(signal.toolCallId);
    } else if (signal.reason === 'error') {
      this.reject(
        signal.toolCallId,
        new Error(signal.message ?? 'Authorization failed. Please retry the tool call.'),
      );
    } else if (signal.reason === 'cancelled') {
      this.reject(signal.toolCallId, new AuthCancelledError());
    } else {
      this.reject(signal.toolCallId, this.buildCleanupError(signal.reason));
    }

    if (signal.requestId) {
      void this.recordSignalResult(signal.requestId, 'handled');
      void this.publishSignalAck({
        requestId: signal.requestId,
        sessionId: signal.sessionId,
        toolCallId: signal.toolCallId,
      });
    }
  }

  private handleSignalAck(rawMessage: string): void {
    let ack: ResumeSignalAck | null = null;
    try {
      ack = JSON.parse(rawMessage) as ResumeSignalAck;
    } catch {
      return;
    }

    if (!ack?.requestId) {
      return;
    }

    const pendingAck = this.pendingSignalAcks.get(ack.requestId);
    if (!pendingAck) {
      return;
    }

    clearTimeout(pendingAck.timer);
    this.pendingSignalAcks.delete(ack.requestId);
    pendingAck.resolve(ack);
  }

  private waitForSignalAck(requestId: string): Promise<ResumeSignalAck | null> {
    return new Promise<ResumeSignalAck | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSignalAcks.delete(requestId);
        resolve(null);
      }, SIGNAL_ACK_TIMEOUT_MS);

      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }

      this.pendingSignalAcks.set(requestId, { resolve, timer });
    });
  }

  private clearPendingSignalAck(requestId: string): void {
    const pendingAck = this.pendingSignalAcks.get(requestId);
    if (!pendingAck) {
      return;
    }

    clearTimeout(pendingAck.timer);
    this.pendingSignalAcks.delete(requestId);
    pendingAck.resolve(null);
  }

  private async publishSignal(signal: ResumeSignal): Promise<number> {
    if (!isRedisAvailable()) {
      throw new Error('Redis is unavailable');
    }

    const redis = getRedisClient();
    if (!redis?.publish) {
      throw new Error('Redis publish is unavailable');
    }

    return redis.publish(JIT_SIGNAL_CHANNEL, JSON.stringify(signal));
  }

  private async publishSignalAck(ack: ResumeSignalAck): Promise<void> {
    if (!isRedisAvailable()) {
      return;
    }

    try {
      const redis = getRedisClient();
      if (!redis?.publish) {
        return;
      }
      await redis.publish(JIT_SIGNAL_ACK_CHANNEL, JSON.stringify(ack));
    } catch (err) {
      log.warn('Failed to publish paused execution signal ack', {
        error: err instanceof Error ? err.message : String(err),
        requestId: ack.requestId,
        toolCallId: ack.toolCallId,
      });
    }
  }

  private async recordSignalResult(requestId: string, result: 'handled'): Promise<void> {
    if (!isRedisAvailable()) {
      return;
    }

    try {
      const redis = getRedisClient();
      if (!redis) {
        return;
      }
      await redis.set(
        `${JIT_SIGNAL_RESULT_PREFIX}${requestId}`,
        result,
        'PX',
        SIGNAL_RESULT_TTL_MS,
      );
    } catch (err) {
      log.warn('Failed to record paused execution signal result', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  private async deleteRedisKey(sessionId: string, toolCallId: string): Promise<void> {
    if (!isRedisAvailable()) return;
    try {
      const redis = getRedisClient();
      if (!redis) return;
      await redis.del(`${REDIS_KEY_PREFIX}${sessionId}:${toolCallId}`);
    } catch (err) {
      log.warn('Failed to delete paused execution from Redis', {
        error: err instanceof Error ? err.message : String(err),
        toolCallId,
      });
    }
  }

  private async readSignalResult(requestId: string): Promise<string | null> {
    if (!isRedisAvailable()) {
      return null;
    }

    try {
      const redis = getRedisClient();
      if (!redis) {
        return null;
      }
      return redis.get(`${JIT_SIGNAL_RESULT_PREFIX}${requestId}`);
    } catch (err) {
      log.warn('Failed to read paused execution signal result', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return null;
    }
  }

  private async deleteSignalResult(requestId: string): Promise<void> {
    if (!isRedisAvailable()) {
      return;
    }

    try {
      const redis = getRedisClient();
      if (!redis) {
        return;
      }
      await redis.del(`${JIT_SIGNAL_RESULT_PREFIX}${requestId}`);
    } catch (err) {
      log.warn('Failed to delete paused execution signal result', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  private async getRedisKeyPresence(
    sessionId: string,
    toolCallId: string,
  ): Promise<RedisKeyPresence> {
    if (!isRedisAvailable()) {
      return 'unavailable';
    }

    try {
      const redis = getRedisClient();
      if (!redis?.get) {
        return 'unavailable';
      }
      const existing = await redis.get(`${REDIS_KEY_PREFIX}${sessionId}:${toolCallId}`);
      return existing !== null ? 'present' : 'missing';
    } catch (err) {
      log.warn('Failed to check paused execution Redis key', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
        toolCallId,
      });
      return 'unavailable';
    }
  }

  private async listRedisToolCallIds(sessionId: string): Promise<string[]> {
    if (!isRedisAvailable()) return [];
    try {
      const redis = getRedisClient();
      if (!redis) return [];
      const pattern = `${REDIS_KEY_PREFIX}${sessionId}:*`;
      const keys: string[] = [];
      // Use cluster-safe scanKeys to iterate all nodes in cluster mode
      for await (const key of scanKeys(redis, pattern, 100)) {
        keys.push(key);
      }

      return keys.map((key) => key.slice(`${REDIS_KEY_PREFIX}${sessionId}:`.length));
    } catch (err) {
      log.warn('Failed to list Redis paused execution keys', {
        error: err instanceof Error ? err.message : String(err),
        sessionId,
      });
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: PausedExecutionStore | null = null;

export function getPausedExecutionStore(): PausedExecutionStore {
  if (!instance) {
    instance = new PausedExecutionStore();
  }
  return instance;
}

/** Reset for testing */
export function resetPausedExecutionStore(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

// ---------------------------------------------------------------------------
// DEFERRED: Session-scoped token revocation (Task 5.18)
// ---------------------------------------------------------------------------
// When `auth_scope: session` is set on an auth profile, tokens obtained
// during a JIT auth flow should be revoked when the session ends.
// This requires:
// 1. Tracking which tokens were obtained via JIT auth (per session)
// 2. On session end, revoking those tokens via the OAuth provider's revoke URL
// 3. Revoking provider-side tokens after local artifact deletion
//
// This is deferred because:
// - It needs the auth_scope DSL property (not yet in compiler)
// - Token revocation is provider-specific and needs careful error handling
// - Runtime now deletes local session-scoped OAuth artifacts on session end
// - Provider-side revocation is still best-effort and needs careful error handling
// ---------------------------------------------------------------------------
