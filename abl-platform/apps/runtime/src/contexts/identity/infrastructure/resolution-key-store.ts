/**
 * Redis Resolution Key Store
 *
 * Infrastructure implementation of the SessionResolutionStore port.
 * Stores resolution keys in Redis with tenant-scoped key format and TTL-based expiry.
 *
 * Key pattern: session_resolution:{tenantId}:{channelId}:{artifactHash}
 * Value: JSON-serialized SessionResolutionRecord
 *
 * Uses lazy Redis access via a getter function so it can be injected/mocked in tests.
 */

import { createLogger } from '@abl/compiler/platform';
import type { SessionResolutionStore } from '../use-cases/resolve-session.js';
import { buildResolutionKeyId } from '../domain/session-resolution-key.js';
import {
  normalizeSessionResolutionRecord,
  type SessionResolutionRecord,
  type SessionResolutionWriteInput,
} from '../domain/session-resolution-record.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default TTL in seconds when expiresAt is missing or in the past. */
const DEFAULT_TTL_SECONDS = 86_400; // 24 hours

/** Minimum TTL in seconds to prevent zero/negative expiry. */
const MIN_TTL_SECONDS = 1;

const log = createLogger('redis-resolution-key-store');

// =============================================================================
// REDIS CLIENT INTERFACE (minimal surface used by this store)
// =============================================================================

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<string | null>;
  del(key: string): Promise<number>;
}

interface SerializedSessionResolutionRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly artifactHash: string;
  readonly sessionLocator: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly sessionId: string;
  };
  readonly sessionPrincipalId: string;
  readonly verificationAttemptId?: string;
  readonly verificationMethod: string;
  readonly identityTier: number;
  readonly policySource: string;
  readonly grantScope: string;
  readonly verifiedAt: string;
  readonly traceId: string;
  readonly expiresAt: string;
}

function serialize(record: SessionResolutionRecord): string {
  const serialized: SerializedSessionResolutionRecord = {
    tenantId: record.tenantId,
    projectId: record.projectId,
    channelId: record.channelId,
    artifactHash: record.artifactHash,
    sessionLocator: record.sessionLocator,
    sessionPrincipalId: record.sessionPrincipalId,
    ...(record.verificationAttemptId
      ? { verificationAttemptId: record.verificationAttemptId }
      : {}),
    verificationMethod: record.verificationMethod,
    identityTier: record.identityTier,
    policySource: record.policySource,
    grantScope: record.grantScope,
    verifiedAt: record.verifiedAt.toISOString(),
    traceId: record.traceId,
    expiresAt: record.expiresAt.toISOString(),
  };

  return JSON.stringify(serialized);
}

function deserialize(params: {
  tenantId: string;
  channelId: string;
  artifactHash: string;
  raw: string;
}): SessionResolutionRecord | null {
  try {
    const parsed = JSON.parse(params.raw) as Partial<SerializedSessionResolutionRecord>;
    if (parsed.sessionLocator?.sessionId) {
      return normalizeSessionResolutionRecord({
        tenantId: parsed.tenantId ?? params.tenantId,
        projectId: parsed.projectId ?? parsed.sessionLocator.projectId ?? '',
        channelId: parsed.channelId ?? params.channelId,
        artifactHash: parsed.artifactHash ?? params.artifactHash,
        sessionLocator: {
          tenantId: parsed.sessionLocator.tenantId ?? params.tenantId,
          projectId: parsed.sessionLocator.projectId ?? parsed.projectId ?? '',
          sessionId: parsed.sessionLocator.sessionId,
        },
        sessionPrincipalId: parsed.sessionPrincipalId,
        verificationAttemptId: parsed.verificationAttemptId,
        verificationMethod:
          typeof parsed.verificationMethod === 'string'
            ? (parsed.verificationMethod as SessionResolutionRecord['verificationMethod'])
            : undefined,
        identityTier:
          parsed.identityTier === 0 || parsed.identityTier === 1 || parsed.identityTier === 2
            ? parsed.identityTier
            : undefined,
        policySource: parsed.policySource,
        grantScope: parsed.grantScope,
        verifiedAt: parsed.verifiedAt ? new Date(parsed.verifiedAt) : undefined,
        traceId: parsed.traceId,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : new Date(),
      });
    }
  } catch {
    // Legacy path handled below.
  }

  log.warn('Using legacy sessionId-only resolution key compatibility read', {
    tenantId: params.tenantId,
    channelId: params.channelId,
  });

  return normalizeSessionResolutionRecord({
    tenantId: params.tenantId,
    channelId: params.channelId,
    artifactHash: params.artifactHash,
    sessionId: params.raw,
    sessionPrincipalId: params.raw,
    policySource: 'legacy_resolution_key',
    grantScope: 'session',
    traceId: `legacy-resolution:${params.tenantId}:${params.channelId}`,
    verifiedAt: new Date(0),
    expiresAt: new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000),
  });
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RedisResolutionKeyStore implements SessionResolutionStore {
  constructor(private readonly getRedis: () => RedisLike) {}

  async findByKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<SessionResolutionRecord | null> {
    const redis = this.getRedis();
    const key = buildResolutionKeyId(tenantId, channelId, artifactHash);
    const raw = await redis.get(key);

    if (!raw) {
      return null;
    }

    return deserialize({ tenantId, channelId, artifactHash, raw });
  }

  async save(resolutionKey: SessionResolutionWriteInput): Promise<void> {
    const redis = this.getRedis();
    const record = normalizeSessionResolutionRecord(resolutionKey);
    const key = buildResolutionKeyId(record.tenantId, record.channelId, record.artifactHash);

    const ttlSeconds = Math.max(
      MIN_TTL_SECONDS,
      Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000),
    );

    await redis.set(key, serialize(record), 'EX', ttlSeconds);
  }

  async remove(tenantId: string, channelId: string, artifactHash: string): Promise<void> {
    const redis = this.getRedis();
    const key = buildResolutionKeyId(tenantId, channelId, artifactHash);
    await redis.del(key);
  }
}
