import { randomUUID } from 'node:crypto';
import type { IdentityTier, VerificationMethod } from '@agent-platform/shared-auth';

export interface SessionLocatorRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface SessionResolutionRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly channelId: string;
  readonly artifactHash: string;
  readonly sessionLocator: SessionLocatorRecord;
  readonly sessionPrincipalId: string;
  readonly verificationAttemptId?: string;
  readonly verificationMethod: VerificationMethod;
  readonly identityTier: IdentityTier;
  readonly policySource: string;
  readonly grantScope: string;
  readonly verifiedAt: Date;
  readonly traceId: string;
  readonly expiresAt: Date;
}

export interface SessionResolutionWriteInput {
  readonly tenantId: string;
  readonly channelId: string;
  readonly artifactHash: string;
  readonly expiresAt: Date;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly sessionPrincipalId?: string;
  readonly sessionLocator?: {
    readonly tenantId?: string;
    readonly projectId?: string;
    readonly sessionId: string;
  };
  readonly verificationAttemptId?: string;
  readonly verificationMethod?: VerificationMethod;
  readonly identityTier?: IdentityTier;
  readonly policySource?: string;
  readonly grantScope?: string;
  readonly verifiedAt?: Date;
  readonly traceId?: string;
}

export function normalizeSessionResolutionRecord(
  input: SessionResolutionWriteInput,
): SessionResolutionRecord {
  const sessionId = input.sessionLocator?.sessionId ?? input.sessionId;
  if (!sessionId) {
    throw new Error('sessionId is required for session resolution records');
  }

  const projectId = input.sessionLocator?.projectId ?? input.projectId ?? '';
  const sessionLocator: SessionLocatorRecord = {
    tenantId: input.sessionLocator?.tenantId ?? input.tenantId,
    projectId,
    sessionId,
  };
  const verificationMethod = input.verificationMethod ?? 'none';
  const identityTier = input.identityTier ?? 0;

  return {
    tenantId: input.tenantId,
    projectId,
    channelId: input.channelId,
    artifactHash: input.artifactHash,
    sessionLocator,
    sessionPrincipalId: input.sessionPrincipalId ?? sessionId,
    ...(input.verificationAttemptId ? { verificationAttemptId: input.verificationAttemptId } : {}),
    verificationMethod,
    identityTier,
    policySource: input.policySource ?? 'session_resolution_write',
    grantScope: input.grantScope ?? (identityTier >= 2 ? 'user' : 'session'),
    verifiedAt: input.verifiedAt ?? new Date(),
    traceId:
      input.traceId ?? `session-resolution:${input.tenantId}:${input.channelId}:${randomUUID()}`,
    expiresAt: input.expiresAt,
  };
}
