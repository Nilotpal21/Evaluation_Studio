/**
 * Redis Verification Token Store
 *
 * Infrastructure implementation of the VerificationTokenStore port.
 * Stores verification attempts in Redis with tenant-scoped keys and TTL-based expiry.
 *
 * Key pattern: verify:{tenantId}:{attemptId}
 * Value: JSON-serialized StoredVerificationAttempt (Date fields as ISO strings)
 *
 * Uses lazy Redis access via a getter function so it can be injected/mocked in tests.
 */

import { createLogger } from '@abl/compiler/platform';
import { runLuaScript, type LuaScript } from '@agent-platform/redis';
import type {
  VerificationTokenStore,
  StoredVerificationAttempt,
} from './verification-token-store.js';

const log = createLogger('redis-verification-token-store');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Redis key prefix for verification attempts. */
const KEY_PREFIX = 'verify';

/** Minimum TTL in seconds to prevent zero/negative expiry. */
const MIN_TTL_SECONDS = 1;

/** Milliseconds per second (used for TTL computation). */
const MS_PER_SECOND = 1000;

/**
 * Lua script: atomically increment the "attempts" field in a JSON-encoded verification attempt.
 * Preserves existing TTL. No-op if key does not exist.
 */
const INCREMENT_ATTEMPTS_LUA: LuaScript = {
  name: 'verification-increment-attempts',
  body: `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local obj = cjson.decode(raw)
obj['attempts'] = (obj['attempts'] or 0) + 1
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], cjson.encode(obj), 'EX', ttl)
return obj['attempts']
`,
  numberOfKeys: 1,
};

/**
 * Lua script: atomically set status to "verified" in a JSON-encoded verification attempt.
 * Preserves existing TTL. No-op if key does not exist.
 */
const MARK_VERIFIED_LUA: LuaScript = {
  name: 'verification-mark-verified',
  body: `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local obj = cjson.decode(raw)
obj['status'] = 'verified'
local ttl = redis.call('TTL', KEYS[1])
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], cjson.encode(obj), 'EX', ttl)
return 1
`,
  numberOfKeys: 1,
};

// =============================================================================
// REDIS CLIENT INTERFACE (minimal surface used by this store)
// =============================================================================

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  del(key: string): Promise<number>;
  // eval exposed via runLuaScript() wrapper for cluster-safe EVALSHA+NOSCRIPT handling
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// =============================================================================
// SERIALIZATION TYPES
// =============================================================================

/** JSON-safe shape where Date fields are serialized as ISO strings. */
interface SerializedVerificationAttempt {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly sessionPrincipalId: string;
  readonly method: string;
  readonly identityValue: string;
  readonly identityType: string;
  readonly policySource: string;
  readonly grantScope: string;
  readonly traceId: string;
  status: string;
  attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly codeHash: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Build a tenant-scoped Redis key for a verification attempt. */
function buildKey(tenantId: string, attemptId: string): string {
  return `${KEY_PREFIX}:${tenantId}:${attemptId}`;
}

/** Compute the TTL in seconds from now until the given expiry date. */
function computeTtlSeconds(expiresAt: Date): number {
  const remainingMs = expiresAt.getTime() - Date.now();
  const remainingSeconds = Math.ceil(remainingMs / MS_PER_SECOND);
  return Math.max(MIN_TTL_SECONDS, remainingSeconds);
}

/** Serialize a StoredVerificationAttempt to a JSON string (Dates become ISO strings). */
function serialize(attempt: StoredVerificationAttempt): string {
  const serialized: SerializedVerificationAttempt = {
    id: attempt.id,
    tenantId: attempt.tenantId,
    projectId: attempt.projectId,
    sessionId: attempt.sessionId,
    sessionPrincipalId: attempt.sessionPrincipalId,
    method: attempt.method,
    identityValue: attempt.identityValue,
    identityType: attempt.identityType,
    policySource: attempt.policySource,
    grantScope: attempt.grantScope,
    traceId: attempt.traceId,
    status: attempt.status,
    attempts: attempt.attempts,
    maxAttempts: attempt.maxAttempts,
    createdAt: attempt.createdAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    codeHash: attempt.codeHash,
  };
  return JSON.stringify(serialized);
}

/** Deserialize a JSON string back to a StoredVerificationAttempt (ISO strings become Dates). */
function deserialize(json: string): StoredVerificationAttempt | null {
  try {
    const parsed: SerializedVerificationAttempt = JSON.parse(json);
    return {
      id: parsed.id,
      tenantId: parsed.tenantId,
      projectId: parsed.projectId ?? '',
      sessionId: parsed.sessionId,
      sessionPrincipalId: parsed.sessionPrincipalId ?? parsed.sessionId,
      method: parsed.method,
      identityValue: parsed.identityValue,
      identityType: parsed.identityType,
      policySource: parsed.policySource ?? 'verification_attempt',
      grantScope: parsed.grantScope ?? 'session',
      traceId: parsed.traceId ?? parsed.id,
      status: parsed.status,
      attempts: parsed.attempts,
      maxAttempts: parsed.maxAttempts,
      createdAt: new Date(parsed.createdAt),
      expiresAt: new Date(parsed.expiresAt),
      codeHash: parsed.codeHash,
    } as StoredVerificationAttempt;
  } catch (error) {
    log.warn('Failed to deserialize verification attempt from Redis', {
      error: error instanceof Error ? error.message : String(error),
      rawPreview: json.slice(0, 200),
    });
    return null;
  }
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RedisVerificationTokenStore implements VerificationTokenStore {
  constructor(private readonly getRedis: () => RedisLike) {}

  async create(attempt: StoredVerificationAttempt): Promise<void> {
    const redis = this.getRedis();
    const key = buildKey(attempt.tenantId, attempt.id);
    const ttl = computeTtlSeconds(attempt.expiresAt);
    const value = serialize(attempt);

    await redis.set(key, value, 'EX', ttl);
  }

  async get(tenantId: string, attemptId: string): Promise<StoredVerificationAttempt | null> {
    const redis = this.getRedis();
    const key = buildKey(tenantId, attemptId);
    const raw = await redis.get(key);

    if (raw === null) {
      return null;
    }

    return deserialize(raw);
  }

  async incrementAttempts(tenantId: string, attemptId: string): Promise<void> {
    const redis = this.getRedis();
    const key = buildKey(tenantId, attemptId);

    // Atomic increment via Lua: parse JSON, increment attempts, write back with preserved TTL
    await runLuaScript(
      redis as unknown as Parameters<typeof runLuaScript>[0],
      INCREMENT_ATTEMPTS_LUA,
      [key],
      [],
    );
  }

  async markVerified(tenantId: string, attemptId: string): Promise<void> {
    const redis = this.getRedis();
    const key = buildKey(tenantId, attemptId);

    // Atomic status update via Lua: parse JSON, set status='verified', write back with preserved TTL
    await runLuaScript(
      redis as unknown as Parameters<typeof runLuaScript>[0],
      MARK_VERIFIED_LUA,
      [key],
      [],
    );
  }
}
