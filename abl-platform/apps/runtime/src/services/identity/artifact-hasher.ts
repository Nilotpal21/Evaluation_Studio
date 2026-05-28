/**
 * Artifact Hasher & HMAC Verifier
 *
 * Pure utility module for session identity operations:
 * - SHA-256 hashing of channel artifacts (cookies, device IDs, caller IDs)
 * - HMAC-SHA256 verification for userId authentication
 * - CallerContext construction from edge-layer inputs
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  TenantContextData,
  VerificationMethod,
} from '@agent-platform/shared-auth';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum age (in seconds) for HMAC timestamps before rejection */
export const HMAC_MAX_AGE_SECONDS = 300;

/** Default session resolution window (24 hours) */
export const DEFAULT_RESUME_WINDOW_SECONDS = 86_400;

/** Maximum allowed string length for CallerContext identity fields */
const MAX_ID_LENGTH = 256;

/** Maximum allowed length for artifact raw values before hashing */
const MAX_ARTIFACT_LENGTH = 2048;

/** Maximum allowed length for sourceIp */
const MAX_IP_LENGTH = 45; // IPv6 max

/** Maximum allowed length for userAgent */
const MAX_USER_AGENT_LENGTH = 512;

/** Domain separator for verified SDK continuity artifacts. */
const VERIFIED_SDK_CHANNEL_ARTIFACT_NAMESPACE = 'sdk:verified-channel-artifact:v1';

// =============================================================================
// INPUT SANITIZATION
// =============================================================================

/** Truncate a string to a max length, returning undefined if input is falsy */
function truncate(value: string | undefined, maxLen: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

// =============================================================================
// ARTIFACT HASHING
// =============================================================================

/**
 * Hash a raw channel artifact value using SHA-256.
 * The hashed value is stored on sessions and used as resolution keys.
 * Raw values are never persisted.
 *
 * @throws {Error} if rawValue exceeds MAX_ARTIFACT_LENGTH
 */
export function hashArtifact(rawValue: string): string {
  if (rawValue.length > MAX_ARTIFACT_LENGTH) {
    throw new Error(`Artifact value exceeds maximum length (${MAX_ARTIFACT_LENGTH})`);
  }
  return createHash('sha256').update(rawValue).digest('hex');
}

export interface DeriveVerifiedSdkChannelArtifactInput {
  tenantId: string;
  projectId: string;
  channelId: string;
  verifiedUserId: string;
  secretKey: string;
}

/**
 * Derive a stable, opaque continuity artifact for a verified SDK identity.
 *
 * The artifact is scoped to tenant + project + channel and does not trust
 * caller-supplied unsigned metadata as the source of continuity.
 */
export function deriveVerifiedSdkChannelArtifact(
  input: DeriveVerifiedSdkChannelArtifactInput,
): string {
  return createHmac('sha256', input.secretKey)
    .update(
      [
        VERIFIED_SDK_CHANNEL_ARTIFACT_NAMESPACE,
        input.tenantId,
        input.projectId,
        input.channelId,
        input.verifiedUserId,
      ].join(':'),
    )
    .digest('hex');
}

// =============================================================================
// HMAC VERIFICATION
// =============================================================================

export interface HMACVerifyInput {
  userId: string;
  hmac: string;
  timestamp: number;
}

export interface HMACVerifyResult {
  success: boolean;
  error?: { code: string; message: string };
}

/**
 * Verify an HMAC-SHA256 signature for userId authentication.
 *
 * The client computes: HMAC-SHA256(secretKey, userId + ":" + timestamp)
 * and sends { userId, hmac, timestamp } in the SDK init request.
 *
 * Verification checks:
 * 1. Timestamp is within HMAC_MAX_AGE_SECONDS of current time
 * 2. HMAC signature matches (timing-safe comparison)
 */
export function verifyHMAC(input: HMACVerifyInput, secretKey: string): HMACVerifyResult {
  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - input.timestamp);

  if (age > HMAC_MAX_AGE_SECONDS) {
    return {
      success: false,
      error: {
        code: 'HMAC_EXPIRED',
        message: `HMAC timestamp expired (age: ${age}s, max: ${HMAC_MAX_AGE_SECONDS}s)`,
      },
    };
  }

  // Validate HMAC format: must be a 64-char hex string (SHA-256 output)
  if (!/^[0-9a-fA-F]{64}$/.test(input.hmac)) {
    return {
      success: false,
      error: { code: 'HMAC_INVALID', message: 'Invalid HMAC format — expected 64 hex characters' },
    };
  }

  const message = `${input.userId}:${input.timestamp}`;
  const expected = createHmac('sha256', secretKey).update(message).digest('hex');

  // Timing-safe comparison using hex decoding (case-insensitive, 32-byte buffers)
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(input.hmac.toLowerCase(), 'hex');

  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return {
      success: false,
      error: { code: 'HMAC_INVALID', message: 'Invalid HMAC signature' },
    };
  }

  return { success: true };
}

// =============================================================================
// CALLER CONTEXT BUILDER
// =============================================================================

export interface CallerContextInput {
  tenantId: string;
  channel: string;
  channelId?: string;
  contactId?: string;
  customerId?: string;
  anonymousId?: string;
  initiatedById?: string;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  /** Raw (unhashed) channel artifact — will be hashed before storage */
  rawArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  sourceIp?: string;
  userAgent?: string;
}

/**
 * Build a CallerContext from edge-layer inputs.
 * Hashes the raw artifact if provided — callers never need to hash manually.
 * All string fields are truncated to safe maximum lengths.
 */
export function buildCallerContext(input: CallerContextInput): CallerContext {
  return {
    tenantId: input.tenantId.slice(0, MAX_ID_LENGTH),
    channel: input.channel.slice(0, MAX_ID_LENGTH),
    channelId: truncate(input.channelId, MAX_ID_LENGTH),
    contactId: truncate(input.contactId, MAX_ID_LENGTH),
    customerId: truncate(input.customerId, MAX_ID_LENGTH),
    anonymousId: truncate(input.anonymousId, MAX_ID_LENGTH),
    initiatedById: truncate(input.initiatedById, MAX_ID_LENGTH),
    identityTier: input.identityTier,
    verificationMethod: input.verificationMethod,
    channelArtifact: input.rawArtifact ? hashArtifact(input.rawArtifact) : undefined,
    channelArtifactType: input.channelArtifactType,
    sourceIp: truncate(input.sourceIp, MAX_IP_LENGTH),
    userAgent: truncate(input.userAgent, MAX_USER_AGENT_LENGTH),
  };
}

// =============================================================================
// HTTP CALLER CONTEXT BUILDER
// =============================================================================

/**
 * Build CallerContext from TenantContextData for HTTP chat routes.
 *
 * Reads identity fields from the tenant context (populated by unified auth
 * middleware). SDK session tokens carry identityTier, verificationMethod,
 * and userContext; user JWTs and API keys default to tier 0 / 'none'.
 *
 * This is a pure function — no side effects, fully testable in isolation.
 */
export function buildCallerContextFromTenantContext(
  tenantId: string,
  tenantContext: TenantContextData | undefined,
): CallerContext {
  const isSDK = tenantContext?.authType === 'sdk_session';
  const tier: IdentityTier = isSDK ? (tenantContext.identityTier ?? 0) : 0;
  const method: VerificationMethod = isSDK ? (tenantContext.verificationMethod ?? 'none') : 'none';
  const authScope = isSDK
    ? (tenantContext.authScope ?? (tenantContext.verifiedUserId ? 'user' : 'session'))
    : undefined;
  const sessionPrincipal = isSDK
    ? (tenantContext.sessionPrincipal ?? tenantContext.sessionId)
    : undefined;

  const input: CallerContextInput = {
    tenantId,
    channel: isSDK ? 'sdk_http' : 'api',
    channelId: isSDK ? tenantContext.channelId : undefined,
    customerId: isSDK ? tenantContext.verifiedUserId : undefined,
    anonymousId: isSDK && authScope === 'session' ? sessionPrincipal : undefined,
    initiatedById: tenantContext?.userId,
    identityTier: tier,
    verificationMethod: method,
  };

  const ctx = buildCallerContext(input);

  // If the SDK token carries a pre-hashed channelArtifact, merge it directly.
  // The artifact was hashed during sdk/init — we must not double-hash.
  if (isSDK && tenantContext.channelArtifact) {
    return {
      ...ctx,
      channelArtifact: tenantContext.channelArtifact,
      ...(sessionPrincipal ? { sessionPrincipalId: sessionPrincipal } : {}),
      ...(authScope ? { authScope } : {}),
    };
  }

  return {
    ...ctx,
    ...(sessionPrincipal ? { sessionPrincipalId: sessionPrincipal } : {}),
    ...(authScope ? { authScope } : {}),
  };
}
