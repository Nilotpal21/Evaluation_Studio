/**
 * Redis Session Store
 *
 * Cluster-ready SessionStore backed by Redis.
 * Uses pipelining for minimal round-trips and Lua scripts for atomic operations.
 *
 * Redis key layout (tenant-prefixed for isolation):
 *   sess:{tenantId}:{id}       HASH   - Session mutable state (30min TTL)
 *   sess:{tenantId}:{id}:conv  LIST   - Conversation history (30min TTL)
 *   sess-tid:{id}              STRING - Reverse lookup: sessionId → tenantId (30min TTL)
 *   ir:{hash}                  STRING - AgentIR gzipped JSON (2h TTL, tenant-agnostic)
 *   comp:{hash}                STRING - CompilationOutput gzipped JSON (2h TTL, tenant-agnostic)
 *   registry:{tenantId}:{id}   HASH   - Agent registry for handoff (30min TTL)
 *   lock:exec:{tenantId}:{id}  STRING - Execution mutex (5s TTL)
 *   resolve:{tenantId}:{channelId}:{hash}  STRING - Session resolution key (configurable TTL)
 */

import crypto from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { compressFieldToBase64 } from './gzip-pool.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
import type { AgentIR, CompilationOutput } from '@abl/compiler';
import type { SessionStore } from './session-store.js';
import type { SessionLocator } from './execution-scope.js';
import type { ConversationMessage, SessionData } from './types.js';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import { getTraceStore } from '../trace-store.js';
import type { TraceEventWithId } from '../../types/index.js';

const log = createLogger('redis-session-store');
type TenantEncryptionService = {
  encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
  decryptForTenant(ciphertext: string, tenantId: string): Promise<string>;
};

// =============================================================================
// LUA SCRIPTS
// =============================================================================

/**
 * Atomic version-check-then-save.
 * KEYS[1] = sess:{id}
 * ARGV[1] = expected version
 * ARGV[2] = session TTL in seconds
 * ARGV[3..N] = alternating field, value pairs to HSET
 * Returns 1 on success, 0 on version conflict.
 */
const LUA_SAVE: LuaScript = {
  name: 'session-save',
  body: `
local current = redis.call('HGET', KEYS[1], 'version')
if current and tonumber(current) ~= tonumber(ARGV[1]) then
  return 0
end
local ttl = tonumber(ARGV[2])
if #ARGV > 2 then
  local args = {}
  for i = 3, #ARGV, 2 do
    args[#args + 1] = ARGV[i]
    args[#args + 1] = ARGV[i + 1]
  end
  redis.call('HMSET', KEYS[1], unpack(args))
end
redis.call('HINCRBY', KEYS[1], 'version', 1)
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`,
  numberOfKeys: 1,
};

/**
 * Append messages to conversation and trim to window.
 * KEYS[1] = sess:{id}:conv
 * ARGV[1] = TTL in seconds
 * ARGV[2] = max messages
 * ARGV[3..N] = JSON-encoded messages to append
 */
const LUA_APPEND_CONV: LuaScript = {
  name: 'session-append-conv',
  body: `
for i = 3, #ARGV do
  redis.call('RPUSH', KEYS[1], ARGV[i])
end
local maxLen = tonumber(ARGV[2])
local len = redis.call('LLEN', KEYS[1])
if len > maxLen then
  -- Preserve first message (system context) while trimming oldest non-first messages
  local first = redis.call('LINDEX', KEYS[1], 0)
  redis.call('LTRIM', KEYS[1], len - maxLen + 1, -1)
  redis.call('LPUSH', KEYS[1], first)
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return redis.call('LLEN', KEYS[1])
`,
  numberOfKeys: 1,
};

/**
 * Owner-only lock release (CAS).
 * KEYS[1] = lock:exec:{id}
 * ARGV[1] = owner (pod name)
 */
const LUA_RELEASE_LOCK: LuaScript = {
  name: 'session-release-lock',
  body: `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`,
  numberOfKeys: 1,
};

// =============================================================================
// REDIS SESSION STORE
// =============================================================================

/** Fields stored in the session hash (non-JSON primitive fields) */
const SESSION_HASH_FIELDS = [
  'id',
  'agentName',
  'irSourceHash',
  'compilationHash',
  'version',
  'isComplete',
  'isEscalated',
  'transferInitiated',
  'escalationReason',
  'recentTransferEndedAt',
  'currentFlowStep',
  'pendingResponse',
  'createdAt',
  'lastActivityAt',
  'activeThreadIndex',
  // Lifecycle
  'initialized',
  // Auth/identity context (needed for cross-pod rehydration)
  'tenantId',
  'projectId',
  'deploymentId',
  'authToken',
  'userId',
  'executionScopeKind',
  // Deployment-aware version tracking
  'environment',
  // Dynamic TTL
  'maxAgeSeconds',
  'idleSeconds',
] as const;

/** Fields stored as JSON in the session hash */
const SESSION_JSON_FIELDS = [
  'state',
  'handoffStack',
  'delegateStack',
  'handoffReturnInfo',
  'dataValues',
  'dataGatheredKeys',
  'executionTreeValues',
  'permissions',
  'waitingForInput',
  'gatherFieldsCollected',
  'pendingRichContent',
  'pendingVoiceConfig',
  'pendingActions',
  'threads',
  'threadStack',
  // Deployment-aware version tracking
  'agentVersions',
  // Session identity
  'callerContext',
  // Custom dimensions for analytics
  'customDimensions',
  // PII vault serialized data
  'piiVaultData',
  'piiRedactionConfig',
  // Raw version strings for AgentRegistryStore composite key
  'agentRawVersions',
  // Loop prevention counters
  'backtrackCounts',
  // Active constraint-collect state
  'constraintCollectState',
  // Module provenance map (potentially large, compressible)
  'moduleProvenance',
] as const;

/** Fields encrypted at rest when EncryptionService is provided */
const ENCRYPTED_FIELDS = [
  'authToken',
  'state',
  'dataValues',
  'executionTreeValues',
  'callerContext',
  'customDimensions',
  'threads',
  'piiVaultData',
  'agentRawVersions',
] as const;
const ENCRYPTED_PREFIX = 'enc:';
const COMPRESSED_PREFIX = 'gz:';

/** Minimum payload size (bytes) before compression is applied */
const COMPRESSION_THRESHOLD = 1024;

// Sessions that have initiated an agent transfer must survive long enough for the
// transfer to complete and the post-transfer conversation to continue — 8 hours
// gives ample headroom beyond the typical session idle TTL (30 min).
export const TRANSFER_SESSION_MIN_TTL_SECONDS = 8 * 60 * 60;

/** Fields eligible for gzip compression before encryption */
const COMPRESSIBLE_FIELDS = [
  'threads',
  'dataValues',
  'executionTreeValues',
  'moduleProvenance',
] as const;

export class RedisSessionStore implements SessionStore {
  private redis: RedisClient;
  private sessionTtlSeconds: number;
  private irTtlSeconds: number;
  private lockOwner: string;
  private encryptionService?: TenantEncryptionService;

  constructor(
    redisClient: RedisClient,
    options: {
      sessionTtlMinutes?: number;
      irTtlMinutes?: number;
      lockOwner?: string;
      encryptionService?: TenantEncryptionService;
    } = {},
  ) {
    this.redis = redisClient;
    this.sessionTtlSeconds = (options.sessionTtlMinutes || 30) * 60;
    this.irTtlSeconds = (options.irTtlMinutes || 1440) * 60;
    this.lockOwner = options.lockOwner || `pod_${process.pid}_${Date.now()}`;
    this.encryptionService = options.encryptionService;
  }

  // =========================================================================
  // Tenant-scoped key helpers
  // =========================================================================

  /** Build tenant-prefixed session key. tenantId is required for writes. */
  private sessionKey(tenantId: string, sessionId: string): string {
    return `sess:${tenantId}:${sessionId}`;
  }

  private convKey(tenantId: string, sessionId: string): string {
    return `sess:${tenantId}:${sessionId}:conv`;
  }

  private registryKey(tenantId: string, sessionId: string): string {
    return `registry:${tenantId}:${sessionId}`;
  }

  private lockKey(tenantId: string, sessionId: string): string {
    return `lock:exec:${tenantId}:${sessionId}`;
  }

  private lookupKey(sessionId: string): string {
    return `sess-tid:${sessionId}`;
  }

  private resolveKey(tenantId: string, channelId: string, artifactHash: string): string {
    return `resolve:${tenantId}:${channelId}:${artifactHash}`;
  }

  /**
   * Falls back to empty string for backward compatibility with pre-migration sessions.
   *
   * Cluster-mode race mitigation (GAP-003): the reverse-lookup key
   * `sess-tid:<id>` and the session hash `sess:<tid>:<id>` may live on
   * different cluster slots. Pipeline reordering or slot migration can make
   * the reverse-lookup key visible briefly after the session-hash key.
   * Single retry-on-miss after 50 ms covers the gap. Standalone mode never
   * hits the retry because both keys arrive in-order on a single instance.
   */
  private async resolveTenantId(sessionId: string): Promise<string | null> {
    const lookupKey = this.lookupKey(sessionId);
    const tid = await this.redis.get(lookupKey);
    if (tid) return tid;
    // Cluster-mode retry — single attempt, fixed 50ms delay. Returns null when
    // the session genuinely doesn't exist (pre-migration sessions or expired).
    // Returns '' (empty string) when the key exists but has no tenant prefix
    // (backward compat with pre-migration sessions that used an empty tenantId).
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retried = await this.redis.get(lookupKey);
    return retried !== null && retried !== undefined ? retried : null;
  }

  private async loadByTenantId(sessionId: string, tenantId: string): Promise<SessionData | null> {
    const key = this.sessionKey(tenantId, sessionId);
    const convKey = this.convKey(tenantId, sessionId);

    // sess:{tid}:{id} and sess:{tid}:{id}:conv may live on different slots in
    // cluster mode; ioredis Cluster pipelines require same-slot keys, so we
    // issue both reads in parallel as individual commands. Standalone is
    // unaffected — Promise.all is one round of concurrent calls.
    const [hashData, convData] = (await Promise.all([
      this.redis.hgetall(key),
      this.redis.lrange(convKey, 0, -1),
    ])) as [Record<string, string>, string[]];

    if (!hashData || Object.keys(hashData).length === 0) {
      return null;
    }

    return this.hashToSession(hashData, convData || []);
  }

  private async getVersionByTenantId(sessionId: string, tenantId: string): Promise<number | null> {
    const key = this.sessionKey(tenantId, sessionId);
    const raw = await this.redis.hget(key, 'version');
    if (raw === null || raw === undefined) {
      return null;
    }
    return parseInt(raw, 10);
  }

  private async deleteByTenantId(sessionId: string, tenantId: string): Promise<void> {
    const keys = [
      this.sessionKey(tenantId, sessionId),
      this.convKey(tenantId, sessionId),
      this.registryKey(tenantId, sessionId),
      this.lockKey(tenantId, sessionId),
      this.lookupKey(sessionId),
    ];

    try {
      const ctxRaw = await this.redis.hget(this.sessionKey(tenantId, sessionId), 'callerContext');
      if (ctxRaw) {
        const decrypted = (await this.decryptField(ctxRaw, tenantId)) || ctxRaw;
        const ctx = JSON.parse(decrypted);
        if (ctx?.channelArtifact && ctx?.channelId) {
          keys.push(this.resolveKey(tenantId, ctx.channelId, ctx.channelArtifact));
        }
      }
    } catch (err) {
      log.warn('resolution key cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Keys span different cluster slots — delete individually to avoid CROSSSLOT.
    await Promise.all(keys.map((k) => this.redis.del(k)));
  }

  private async acquireLockByTenantId(
    sessionId: string,
    tenantId: string,
    ttlMs?: number,
  ): Promise<boolean> {
    const key = this.lockKey(tenantId, sessionId);
    const result = await this.redis.set(key, this.lockOwner, 'PX', ttlMs || 5000, 'NX');
    return result === 'OK';
  }

  private async releaseLockByTenantId(sessionId: string, tenantId: string): Promise<void> {
    const key = this.lockKey(tenantId, sessionId);
    await runLuaScript(this.redis, LUA_RELEASE_LOCK, [key], [this.lockOwner]);
  }

  private async touchByTenantId(sessionId: string, tenantId: string): Promise<void> {
    const sessKey = this.sessionKey(tenantId, sessionId);

    const fields = await this.redis.hmget(
      sessKey,
      'createdAt',
      'maxAgeSeconds',
      'idleSeconds',
      'transferInitiated',
    );
    const createdAt = fields?.[0] ? parseInt(fields[0], 10) : 0;
    const maxAgeSeconds = fields?.[1] ? parseInt(fields[1], 10) : undefined;
    const idleSeconds = fields?.[2] ? parseInt(fields[2], 10) : undefined;
    const transferInitiated = fields?.[3] === 'true';

    const effectiveTtl = this.computeEffectiveTtl(
      createdAt,
      maxAgeSeconds,
      idleSeconds,
      transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );
    if (effectiveTtl <= 0) {
      return;
    }

    // sessKey, convKey, registryKey, and lookupKey live on different cluster
    // slots, so issue the EXPIREs as individual commands. ioredis Cluster
    // pipelines require same-slot keys; standalone is unaffected.
    await Promise.all([
      this.redis.expire(sessKey, effectiveTtl),
      this.redis.expire(this.convKey(tenantId, sessionId), effectiveTtl),
      this.redis.expire(this.registryKey(tenantId, sessionId), effectiveTtl),
      this.redis.expire(this.lookupKey(sessionId), effectiveTtl),
    ]);
  }

  private async serializeConversationMessage(
    message: SessionData['conversationHistory'][number],
    tenantId: string,
  ): Promise<string> {
    const serialized = JSON.stringify(message);
    if (!this.encryptionService) {
      return serialized;
    }

    if (!tenantId) {
      throw new Error('tenantId is required for encrypted conversation history writes');
    }

    const encrypted = await this.encryptionService.encryptForTenant(serialized, tenantId);
    return ENCRYPTED_PREFIX + encrypted;
  }

  private async serializeConversationMessages(
    messages: SessionData['conversationHistory'],
    tenantId: string,
  ): Promise<string[]> {
    const serializedMessages: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      serializedMessages.push(await this.serializeConversationMessage(messages[i], tenantId));
      // Yield every 5 messages to spread AES work across CFS windows.
      // Without this, 15-19 sequential encrypt calls execute in one macrotask.
      if (i > 0 && i % 5 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return serializedMessages;
  }

  // =========================================================================
  // Session CRUD
  // =========================================================================

  async create(session: SessionData): Promise<void> {
    if (!session.tenantId) {
      throw new Error(`create() requires tenantId — session ${session.id} has none`);
    }
    const tenantId = session.tenantId;
    const key = this.sessionKey(tenantId, session.id);
    const convKey = this.convKey(tenantId, session.id);
    log.debug('[REDIS] create — writing new session to Redis', {
      sessionId: session.id,
      agentName: session.agentName,
      tenantId,
      threadCount: session.threads?.length,
      convMessages: session.conversationHistory?.length,
      version: session.version,
    });

    // Compute effective TTL: cap to maxAgeSeconds and/or idleSeconds if provided.
    // Apply a minimum floor for sessions that have initiated an agent transfer so
    // the session survives until the transfer completes.
    const effectiveTtl = this.computeEffectiveTtl(
      session.createdAt,
      session.maxAgeSeconds,
      session.idleSeconds,
      session.transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    const hashData = await this.sessionToHash(session);

    // The session keys (hash, lookup, conv list, resolution) intentionally
    // span different cluster slots so tenants don't pile onto a single hot
    // slot. ioredis Cluster's pipeline() requires same-slot keys, so we
    // issue the writes as individual commands — each auto-routes to its
    // node. Promise.all means failures abort (consistent with the previous
    // pipeline.exec() throw-on-error semantics).
    const writes: Array<Promise<unknown>> = [];

    // Session hash + its TTL.
    writes.push(this.redis.hmset(key, hashData));
    writes.push(this.redis.expire(key, effectiveTtl));

    // Reverse lookup: sessionId → tenantId. GAP-003 retry-on-miss in
    // resolveTenantId covers the brief window where this key is visible
    // before the session hash on a different slot.
    writes.push(this.redis.set(this.lookupKey(session.id), tenantId, 'EX', effectiveTtl));

    // Conversation list. Encryption failures abort the whole write below so
    // raw conversation content is never persisted as a plaintext fallback.
    if (session.conversationHistory.length > 0) {
      const serializedMessages = await this.serializeConversationMessages(
        session.conversationHistory,
        tenantId,
      );
      // RPUSH supports a variadic value list — one round-trip per call.
      writes.push(this.redis.rpush(convKey, ...serializedMessages));
      writes.push(this.redis.expire(convKey, effectiveTtl));
    }

    // Resolution key (channel-artifact → sessionId). Only set when present.
    const ctx = session.callerContext;
    if (ctx?.channelArtifact && ctx.channelId) {
      const rKey = this.resolveKey(tenantId, ctx.channelId, ctx.channelArtifact);
      writes.push(this.redis.set(rKey, session.id, 'EX', effectiveTtl));
    }

    await Promise.all(writes);
  }

  async load(sessionId: string): Promise<SessionData | null> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (!tenantId) {
      return null;
    }
    const key = this.sessionKey(tenantId, sessionId);
    const convKey = this.convKey(tenantId, sessionId);

    // sess:{tid}:{id} and sess:{tid}:{id}:conv may live on different slots in
    // cluster mode; ioredis Cluster pipelines require same-slot keys, so we
    // issue both reads in parallel as individual commands. Standalone is
    // unaffected — Promise.all is one round of concurrent calls.
    const [hashData, convData] = (await Promise.all([
      this.redis.hgetall(key),
      this.redis.lrange(convKey, 0, -1),
    ])) as [Record<string, string>, string[]];

    if (!hashData || Object.keys(hashData).length === 0) {
      return null;
    }

    return this.hashToSession(hashData, convData || []);
  }

  async loadScoped(locator: SessionLocator): Promise<SessionData | null> {
    return this.loadByTenantId(locator.sessionId, locator.tenantId);
  }

  async getVersion(sessionId: string, knownTenantId?: string): Promise<number | null> {
    const tenantId = knownTenantId ?? (await this.resolveTenantId(sessionId));
    if (tenantId === null) {
      return null;
    }
    return this.getVersionByTenantId(sessionId, tenantId);
  }

  async getVersionScoped(locator: SessionLocator): Promise<number | null> {
    return this.getVersionByTenantId(locator.sessionId, locator.tenantId);
  }

  async save(session: SessionData): Promise<boolean> {
    if (!session.tenantId) {
      throw new Error(`save() requires tenantId — session ${session.id} has none`);
    }
    const tenantId = session.tenantId;
    const key = this.sessionKey(tenantId, session.id);
    log.debug('[REDIS] save — updating session in Redis', {
      sessionId: session.id,
      agentName: session.agentName,
      version: session.version,
      convMessages: session.conversationHistory?.length,
    });
    const hashData = await this.sessionToHash(session);

    // Compute dynamic TTL: cap to remaining max-age lifetime and/or idle timeout.
    // Apply a minimum floor for sessions that have initiated an agent transfer.
    const effectiveTtl = this.computeEffectiveTtl(
      session.createdAt,
      session.maxAgeSeconds,
      session.idleSeconds,
      session.transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    // Session has exceeded its max age — refuse to extend
    if (effectiveTtl <= 0) {
      return false;
    }

    // Build ARGV: expected version (before increment), TTL, then field/value pairs
    // SessionService.saveSession() already incremented version, so expected = version - 1
    // runLuaScript wraps redis.eval — Lua script runs on the Redis server, not JS eval
    const argv: (string | number)[] = [session.version - 1, effectiveTtl];
    for (const [field, value] of Object.entries(hashData)) {
      if (field !== 'version') {
        // version is incremented by Lua
        argv.push(field, value);
      }
    }

    const result = await runLuaScript(this.redis, LUA_SAVE, [key], argv);
    return result === 1;
  }

  async delete(sessionId: string): Promise<void> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    await this.deleteByTenantId(sessionId, tenantId);
  }

  async deleteScoped(locator: SessionLocator): Promise<void> {
    await this.deleteByTenantId(locator.sessionId, locator.tenantId);
  }

  // =========================================================================
  // Conversation History
  // =========================================================================

  async appendMessages(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      log.warn('appendMessages: tenantId not found — messages dropped', { sessionId });
      try {
        const event: TraceEventWithId = {
          id: crypto.randomUUID(),
          sessionId,
          type: 'warning',
          timestamp: new Date(),
          data: {
            reason: 'append_messages_tenant_unresolved',
            sessionId,
            droppedCount: messages.length,
          },
        };
        getTraceStore().addEvent(sessionId, event);
      } catch {
        // trace store may not be initialised in all environments
      }
      return;
    }
    const sessKey = this.sessionKey(tenantId, sessionId);
    const convKey = this.convKey(tenantId, sessionId);

    // Read session's createdAt, maxAgeSeconds, idleSeconds, and transferInitiated for TTL
    const fields = await this.redis.hmget(
      sessKey,
      'createdAt',
      'maxAgeSeconds',
      'idleSeconds',
      'transferInitiated',
    );
    const createdAt = fields?.[0] ? parseInt(fields[0], 10) : 0;
    const maxAgeSeconds = fields?.[1] ? parseInt(fields[1], 10) : undefined;
    const idleSeconds = fields?.[2] ? parseInt(fields[2], 10) : undefined;
    const transferInitiated = fields?.[3] === 'true';
    const effectiveTtl = this.computeEffectiveTtl(
      createdAt,
      maxAgeSeconds,
      idleSeconds,
      transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    // Session has exceeded its max age — don't append or extend
    if (effectiveTtl <= 0) return;

    const serializedMessages = await this.serializeConversationMessages(messages, tenantId);
    const pipeline = this.redis.pipeline();
    for (const serialized of serializedMessages) {
      pipeline.rpush(convKey, serialized);
    }
    pipeline.expire(convKey, effectiveTtl);
    await pipeline.exec();
  }

  async replaceConversation(sessionId: string, messages: ConversationMessage[]): Promise<void> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    const sessKey = this.sessionKey(tenantId, sessionId);
    const convKey = this.convKey(tenantId, sessionId);

    // Compute dynamic TTL
    const fields = await this.redis.hmget(
      sessKey,
      'createdAt',
      'maxAgeSeconds',
      'idleSeconds',
      'transferInitiated',
    );
    const createdAt = fields?.[0] ? parseInt(fields[0], 10) : 0;
    const maxAgeSeconds = fields?.[1] ? parseInt(fields[1], 10) : undefined;
    const idleSeconds = fields?.[2] ? parseInt(fields[2], 10) : undefined;
    const transferInitiated = fields?.[3] === 'true';
    const effectiveTtl = this.computeEffectiveTtl(
      createdAt,
      maxAgeSeconds,
      idleSeconds,
      transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    if (effectiveTtl <= 0) return;

    const serializedMessages = await this.serializeConversationMessages(messages, tenantId);
    const pipeline = this.redis.pipeline();
    // Delete existing list
    pipeline.del(convKey);
    for (const serialized of serializedMessages) {
      pipeline.rpush(convKey, serialized);
    }
    pipeline.expire(convKey, effectiveTtl);
    await pipeline.exec();
  }

  /**
   * Save session hash and replace conversation list in a batched operation.
   * Note: The session hash save (Lua) and conversation replace (pipeline) are
   * two separate Redis round-trips. If the process crashes between them, the
   * session hash will have the new version but the conversation list will be
   * stale. The next saveSessionSnapshot call will overwrite both, resolving
   * the inconsistency.
   *
   * Returns false on version conflict (same semantics as save()).
   */
  async saveAndReplaceConversation(
    session: SessionData,
    messages: ConversationMessage[],
  ): Promise<boolean> {
    const tenantId = session.tenantId || '';
    const sessKey = this.sessionKey(tenantId, session.id);
    const convKey = this.convKey(tenantId, session.id);
    const hashData = await this.sessionToHash(session);

    // Compute dynamic TTL
    const effectiveTtl = this.computeEffectiveTtl(
      session.createdAt,
      session.maxAgeSeconds,
      session.idleSeconds,
      session.transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    if (effectiveTtl <= 0) {
      return false;
    }

    const serializedMessages = await this.serializeConversationMessages(messages, tenantId);

    // Build ARGV for Lua save script: expected version, TTL, field/value pairs
    // SessionService.saveSession() already incremented version, so expected = version - 1
    const argv: (string | number)[] = [session.version - 1, effectiveTtl];
    for (const [field, value] of Object.entries(hashData)) {
      if (field !== 'version') {
        argv.push(field, value);
      }
    }

    // Run Lua save atomically first — if version conflicts, skip conversation replace
    const saveResult = await runLuaScript(this.redis, LUA_SAVE, [sessKey], argv);
    if (saveResult !== 1) {
      return false;
    }

    // Save succeeded — replace conversation in a single pipeline (1 round-trip)
    const pipeline = this.redis.pipeline();
    pipeline.del(convKey);
    for (const serialized of serializedMessages) {
      pipeline.rpush(convKey, serialized);
    }
    pipeline.expire(convKey, effectiveTtl);
    await pipeline.exec();

    return true;
  }

  async getConversationHistory(sessionId: string, limit?: number): Promise<ConversationMessage[]> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return [];
    }
    const convKey = this.convKey(tenantId, sessionId);
    const raw = await this.redis.lrange(convKey, 0, -1);
    const messages = await Promise.all(
      (raw || []).map(async (s: string) => {
        const decrypted = (await this.decryptField(s, tenantId)) || s;
        return JSON.parse(decrypted) as ConversationMessage;
      }),
    );
    if (limit && messages.length > limit) {
      if (limit === 1) return [messages[0]];
      return [messages[0], ...messages.slice(-(limit - 1))];
    }
    return messages;
  }

  async trimConversation(sessionId: string, maxMessages: number): Promise<void> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    const sessKey = this.sessionKey(tenantId, sessionId);
    const convKey = this.convKey(tenantId, sessionId);

    // Dynamic TTL (same pattern as appendMessages) — avoid fixed sessionTtlSeconds mismatch
    const fields = await this.redis.hmget(
      sessKey,
      'createdAt',
      'maxAgeSeconds',
      'idleSeconds',
      'transferInitiated',
    );
    const createdAt = fields?.[0] ? parseInt(fields[0], 10) : 0;
    const maxAgeSeconds = fields?.[1] ? parseInt(fields[1], 10) : undefined;
    const idleSeconds = fields?.[2] ? parseInt(fields[2], 10) : undefined;
    const transferInitiated = fields?.[3] === 'true';
    const effectiveTtl = this.computeEffectiveTtl(
      createdAt,
      maxAgeSeconds,
      idleSeconds,
      transferInitiated ? TRANSFER_SESSION_MIN_TTL_SECONDS : undefined,
    );

    if (effectiveTtl <= 0) return;

    // runLuaScript wraps redis.eval — Lua script runs on the Redis server, not JS eval
    await runLuaScript(
      this.redis,
      LUA_APPEND_CONV,
      [convKey],
      [
        effectiveTtl,
        maxMessages,
        // no new messages to append, just trim
      ],
    );
  }

  // =========================================================================
  // AgentIR Cache (gzipped)
  // =========================================================================

  async getAgentIR(sourceHash: string): Promise<AgentIR | null> {
    const key = `ir:${sourceHash}`;
    const compressed = await this.redis.getBuffer(key);
    if (!compressed) return null;
    try {
      const decompressed = await gunzipAsync(compressed);
      return JSON.parse(decompressed.toString());
    } catch (err) {
      log.warn('AgentIR decompression failed', {
        sourceHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async setAgentIR(sourceHash: string, ir: AgentIR): Promise<void> {
    const key = `ir:${sourceHash}`;
    const compressed = await gzipAsync(JSON.stringify(ir));
    await this.redis.set(key, compressed, 'EX', this.irTtlSeconds);
  }

  // =========================================================================
  // CompilationOutput Cache (gzipped)
  // =========================================================================

  async getCompilationOutput(hash: string): Promise<CompilationOutput | null> {
    const key = `comp:${hash}`;
    const compressed = await this.redis.getBuffer(key);
    if (!compressed) return null;
    try {
      const decompressed = await gunzipAsync(compressed);
      return JSON.parse(decompressed.toString());
    } catch (err) {
      log.warn('CompilationOutput decompression failed', {
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async setCompilationOutput(hash: string, output: CompilationOutput): Promise<void> {
    const key = `comp:${hash}`;
    const compressed = await gzipAsync(JSON.stringify(output));
    await this.redis.set(key, compressed, 'EX', this.irTtlSeconds);
  }

  // =========================================================================
  // Agent Registry
  // =========================================================================

  async setAgentRegistry(sessionId: string, registry: Record<string, string>): Promise<void> {
    if (Object.keys(registry).length === 0) return;
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    const key = this.registryKey(tenantId, sessionId);
    await this.redis.hmset(key, registry);
    await this.redis.expire(key, this.sessionTtlSeconds);
  }

  async setAgentRegistryScoped(
    locator: SessionLocator,
    registry: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(registry).length === 0) return;
    const key = this.registryKey(locator.tenantId, locator.sessionId);
    await this.redis.hmset(key, registry);
    await this.redis.expire(key, this.sessionTtlSeconds);
  }

  async getAgentRegistry(sessionId: string): Promise<Record<string, string> | null> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return null;
    }
    const key = this.registryKey(tenantId, sessionId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  }

  async getAgentRegistryScoped(locator: SessionLocator): Promise<Record<string, string> | null> {
    const key = this.registryKey(locator.tenantId, locator.sessionId);
    const data = await this.redis.hgetall(key);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  }

  // =========================================================================
  // Execution Lock
  // =========================================================================

  async acquireLock(sessionId: string, ttlMs?: number): Promise<boolean> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return false;
    }
    return this.acquireLockByTenantId(sessionId, tenantId, ttlMs);
  }

  async acquireLockScoped(locator: SessionLocator, ttlMs?: number): Promise<boolean> {
    return this.acquireLockByTenantId(locator.sessionId, locator.tenantId, ttlMs);
  }

  async releaseLock(sessionId: string): Promise<void> {
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    await this.releaseLockByTenantId(sessionId, tenantId);
  }

  async releaseLockScoped(locator: SessionLocator): Promise<void> {
    await this.releaseLockByTenantId(locator.sessionId, locator.tenantId);
  }

  // =========================================================================
  // TTL Management
  // =========================================================================

  async touch(sessionId: string, _lastActivityAt?: Date): Promise<void> {
    // lastActivityAt is unused — Redis touch only refreshes TTL via EXPIRE.
    // The parameter exists to satisfy the SessionStore interface contract.
    const tenantId = await this.resolveTenantId(sessionId);
    if (tenantId === null) {
      return;
    }
    await this.touchByTenantId(sessionId, tenantId);
  }

  async touchScoped(locator: SessionLocator, _lastActivityAt?: Date): Promise<void> {
    // lastActivityAt is unused — Redis touch only refreshes TTL via EXPIRE.
    await this.touchByTenantId(locator.sessionId, locator.tenantId);
  }

  // =========================================================================
  // Session Resolution Keys
  // =========================================================================

  async setResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
    sessionId: string,
    ttlSeconds: number,
  ): Promise<void> {
    const key = this.resolveKey(tenantId, channelId, artifactHash);
    await this.redis.set(key, sessionId, 'EX', ttlSeconds);
  }

  async getResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<string | null> {
    const key = this.resolveKey(tenantId, channelId, artifactHash);
    return this.redis.get(key);
  }

  async deleteResolutionKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<void> {
    const key = this.resolveKey(tenantId, channelId, artifactHash);
    await this.redis.del(key);
  }

  // =========================================================================
  // TTL COMPUTATION
  // =========================================================================

  /**
   * Compute effective TTL for a session.
   *
   * When maxAgeSeconds is set, the TTL is capped to the remaining lifetime:
   *   remainingLifetime = maxAgeSeconds - (nowSeconds - createdAtSeconds)
   *   effectiveTtl = min(sessionTtlSeconds, remainingLifetime)
   *
   * When idleSeconds is set, the TTL is further capped so the key expires
   * after `idleSeconds` of inactivity (each touch resets to this value).
   *
   * Returns 0 or negative when the session has exceeded its max age.
   */
  private computeEffectiveTtl(
    createdAt: number,
    maxAgeSeconds?: number,
    idleSeconds?: number,
    minTtlSeconds?: number,
  ): number {
    let effectiveTtl = this.sessionTtlSeconds;

    if (maxAgeSeconds != null && maxAgeSeconds > 0) {
      // createdAt is stored as epoch milliseconds
      const createdAtSeconds = createdAt / 1000;
      const nowSeconds = Date.now() / 1000;
      const elapsedSeconds = nowSeconds - createdAtSeconds;
      const remainingLifetime = maxAgeSeconds - elapsedSeconds;
      effectiveTtl = Math.max(0, Math.min(effectiveTtl, Math.ceil(remainingLifetime)));
      // Hard stop: session has exceeded its operator-set max age.
      // The transfer floor must not revive an expired session.
      if (effectiveTtl === 0) return 0;
    }

    if (idleSeconds != null && idleSeconds > 0) {
      effectiveTtl = Math.min(effectiveTtl, idleSeconds);
    }

    if (minTtlSeconds != null && minTtlSeconds > 0) {
      effectiveTtl = Math.max(effectiveTtl, minTtlSeconds);
    }

    return effectiveTtl;
  }

  // =========================================================================
  // SERIALIZATION HELPERS
  // =========================================================================

  private async sessionToHash(session: SessionData): Promise<Record<string, string>> {
    const hash: Record<string, string> = {};
    const tenantId = session.tenantId || '';

    // Primitive fields
    for (const field of SESSION_HASH_FIELDS) {
      const value = session[field as keyof SessionData];
      if (value !== undefined && value !== null) {
        let strValue = String(value);
        // Encrypt sensitive primitive fields (authToken)
        if (
          this.encryptionService &&
          tenantId &&
          (ENCRYPTED_FIELDS as readonly string[]).includes(field)
        ) {
          strValue =
            ENCRYPTED_PREFIX + (await this.encryptionService.encryptForTenant(strValue, tenantId));
        }
        hash[field] = strValue;
      }
    }

    // JSON fields
    let encryptedFieldCount = 0;
    for (const field of SESSION_JSON_FIELDS) {
      const value = session[field as keyof SessionData];
      if (value !== undefined && value !== null) {
        let jsonValue = JSON.stringify(value);

        // Compress large compressible fields before encryption
        // Uses sync gzip at level 1 to minimize allocation pressure (see gzip-pool.ts)
        let compressed = false;
        if ((COMPRESSIBLE_FIELDS as readonly string[]).includes(field)) {
          const compressedValue = compressFieldToBase64(jsonValue);
          if (compressedValue !== null) {
            jsonValue = compressedValue;
            compressed = true;
          }
        }

        // Encrypt sensitive JSON fields (state, dataValues)
        if (
          this.encryptionService &&
          tenantId &&
          (ENCRYPTED_FIELDS as readonly string[]).includes(field)
        ) {
          jsonValue =
            ENCRYPTED_PREFIX + (await this.encryptionService.encryptForTenant(jsonValue, tenantId));
          encryptedFieldCount++;
          // Yield every 4 encrypted fields to spread gzip+AES work across CFS windows
          if (encryptedFieldCount % 4 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }

        // Prepend gz: prefix after encryption so read path can detect layering
        if (compressed) {
          jsonValue = COMPRESSED_PREFIX + jsonValue;
        }
        hash[field] = jsonValue;
      }
    }

    return hash;
  }

  /**
   * Decrypt and decompress a field value based on prefix layering.
   *
   * Prefix layering (outermost first):
   *   gz:enc:base64data → strip gz: → decrypt → gunzip base64 → JSON
   *   gz:base64data     → strip gz: → gunzip base64 → JSON
   *   enc:base64data    → decrypt → JSON
   *   raw JSON          → JSON (legacy)
   */
  private async decryptField(
    value: string | undefined,
    tenantId: string,
  ): Promise<string | undefined> {
    if (!value) return value;

    let current = value;

    // Strip gz: prefix — decompression happens after decryption
    const wasCompressed = current.startsWith(COMPRESSED_PREFIX);
    if (wasCompressed) {
      current = current.slice(COMPRESSED_PREFIX.length);
    }

    // Decrypt if enc: prefix is present
    if (this.encryptionService && tenantId && current.startsWith(ENCRYPTED_PREFIX)) {
      try {
        current = await this.encryptionService.decryptForTenant(
          current.slice(ENCRYPTED_PREFIX.length),
          tenantId,
        );
      } catch (err) {
        log.warn('Decryption failed for field', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    // Decompress if gz: was present — current is now base64-encoded gzip data
    if (wasCompressed) {
      try {
        const decompressed = await gunzipAsync(Buffer.from(current, 'base64'));
        current = (decompressed as Buffer).toString('utf-8');
      } catch (err) {
        log.warn('Decompression failed for field', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    return current;
  }

  private async hashToSession(
    hash: Record<string, string>,
    convRaw: string[],
  ): Promise<SessionData> {
    // Read tenantId first (stored as plaintext for decryption lookups)
    const tenantId = hash.tenantId || '';

    // Decrypt conversation messages
    const decryptedConv = await Promise.all(
      convRaw.map(async (s, i) => {
        try {
          const decrypted = (await this.decryptField(s, tenantId)) || s;
          return JSON.parse(decrypted) as ConversationMessage;
        } catch (err) {
          log.warn('corrupted conversation message, skipping', {
            sessionId: hash.id ?? 'unknown',
            index: i,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      }),
    );
    const conversationHistory = decryptedConv.filter(
      (msg): msg is ConversationMessage => msg !== null,
    );

    const defaultState = { gatherProgress: {}, conversationPhase: 'start', context: {} };
    const safeJsonParse = async <T>(
      raw: string | undefined,
      fallback: T,
      field: string,
    ): Promise<T> => {
      if (!raw) return fallback;
      // Decrypt if needed before parsing
      const decrypted = (await this.decryptField(raw, tenantId)) || raw;
      try {
        return JSON.parse(decrypted);
      } catch (err) {
        const sessionId = hash.id ?? 'unknown';
        log.warn('corrupted JSON field, using default', {
          sessionId,
          field,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          const event: TraceEventWithId = {
            id: crypto.randomUUID(),
            sessionId,
            type: 'warning',
            timestamp: new Date(),
            data: {
              reason: 'session_field_corrupt',
              field,
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          };
          getTraceStore().addEvent(sessionId, event);
        } catch {
          // trace store may not be initialised in all environments
        }
        return fallback;
      }
    };

    // Decrypt authToken
    const authToken = (await this.decryptField(hash.authToken, tenantId)) || undefined;

    return {
      id: hash.id,
      agentName: hash.agentName,
      irSourceHash: hash.irSourceHash || '',
      compilationHash: hash.compilationHash || null,
      conversationHistory,
      state: await safeJsonParse(hash.state, defaultState, 'state'),
      version: parseInt(hash.version || '0', 10),
      isComplete: hash.isComplete === 'true',
      isEscalated: hash.isEscalated === 'true',
      transferInitiated: hash.transferInitiated === 'true',
      initialized: hash.initialized !== undefined ? hash.initialized === 'true' : false,
      escalationReason: hash.escalationReason || undefined,
      recentTransferEndedAt:
        hash.recentTransferEndedAt !== undefined
          ? parseInt(hash.recentTransferEndedAt, 10)
          : undefined,
      handoffStack: await safeJsonParse(hash.handoffStack, [], 'handoffStack'),
      delegateStack: await safeJsonParse(hash.delegateStack, [], 'delegateStack'),
      handoffReturnInfo: await safeJsonParse(
        hash.handoffReturnInfo,
        undefined,
        'handoffReturnInfo',
      ),
      dataValues: await safeJsonParse(hash.dataValues, {}, 'dataValues'),
      dataGatheredKeys: await safeJsonParse(hash.dataGatheredKeys, [], 'dataGatheredKeys'),
      executionTreeValues: await safeJsonParse(
        hash.executionTreeValues,
        undefined,
        'executionTreeValues',
      ),
      currentFlowStep: hash.currentFlowStep || undefined,
      waitingForInput: await safeJsonParse(hash.waitingForInput, undefined, 'waitingForInput'),
      gatherFieldsCollected: await safeJsonParse(
        hash.gatherFieldsCollected,
        undefined,
        'gatherFieldsCollected',
      ),
      pendingResponse: hash.pendingResponse || undefined,
      pendingRichContent: await safeJsonParse(
        hash.pendingRichContent,
        undefined,
        'pendingRichContent',
      ),
      pendingVoiceConfig: await safeJsonParse(
        hash.pendingVoiceConfig,
        undefined,
        'pendingVoiceConfig',
      ),
      pendingActions: await safeJsonParse(hash.pendingActions, undefined, 'pendingActions'),
      // Auth/identity context (cross-pod rehydration)
      tenantId: tenantId || undefined,
      projectId: hash.projectId || undefined,
      deploymentId: hash.deploymentId || undefined,
      authToken,
      userId: hash.userId || undefined,
      permissions: await safeJsonParse(hash.permissions, undefined, 'permissions'),
      executionScopeKind:
        (hash.executionScopeKind as SessionData['executionScopeKind'] | undefined) || undefined,
      // Deployment-aware version tracking
      environment: hash.environment || undefined,
      agentVersions: await safeJsonParse(hash.agentVersions, undefined, 'agentVersions'),
      createdAt: parseInt(hash.createdAt || '0', 10),
      lastActivityAt: parseInt(hash.lastActivityAt || '0', 10),
      maxAgeSeconds: hash.maxAgeSeconds ? parseInt(hash.maxAgeSeconds, 10) : undefined,
      idleSeconds: hash.idleSeconds ? parseInt(hash.idleSeconds, 10) : undefined,
      // Thread model fields (default to empty for sessions created before thread model)
      threads: await safeJsonParse(hash.threads, [], 'threads'),
      activeThreadIndex: hash.activeThreadIndex ? parseInt(hash.activeThreadIndex, 10) : 0,
      threadStack: await safeJsonParse(hash.threadStack, [], 'threadStack'),
      // Session identity
      callerContext: await safeJsonParse(hash.callerContext, undefined, 'callerContext'),
      // Custom dimensions for analytics
      customDimensions: await safeJsonParse(hash.customDimensions, undefined, 'customDimensions'),
      // PII vault persistence
      piiVaultData: hash.piiVaultData || undefined,
      piiRedactionConfig: await safeJsonParse(
        hash.piiRedactionConfig,
        undefined,
        'piiRedactionConfig',
      ),
      // Backtrack loop prevention and constraint-collect state
      backtrackCounts: await safeJsonParse(hash.backtrackCounts, undefined, 'backtrackCounts'),
      constraintCollectState: await safeJsonParse(
        hash.constraintCollectState,
        undefined,
        'constraintCollectState',
      ),
      // Module provenance map
      moduleProvenance: await safeJsonParse(hash.moduleProvenance, undefined, 'moduleProvenance'),
      // Raw version strings (complement to agentVersions numeric map)
      agentRawVersions: await safeJsonParse(hash.agentRawVersions, undefined, 'agentRawVersions'),
    };
  }
}
