import type { IdentityTier, VerificationMethod } from '@agent-platform/shared-auth';
import type { ChannelType } from '../../../channels/types.js';
import type {
  IdentityVerifier,
  VerificationProof,
  VerificationResult,
} from '../domain/identity-verifier.js';
import type { VerificationTokenStore } from '../infrastructure/verification-token-store.js';

function notFoundResult(): VerificationResult {
  return {
    success: false,
    error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toIdentityTier(value: unknown): IdentityTier | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

function mapSessionChannelToChannelType(channel: string | null | undefined): ChannelType {
  switch (channel) {
    case 'api':
      return 'api';
    case 'email':
      return 'email';
    case 'http_async':
      return 'http_async';
    case 'sms':
      return 'twilio_sms';
    case 'voice':
      return 'voice';
    case 'whatsapp':
      return 'whatsapp';
    case 'web_debug':
      return 'web_debug';
    case 'web_chat':
      return 'web_chat';
    case 'sdk':
      return 'sdk_websocket';
    case 'web':
    default:
      return 'web_chat';
  }
}

export interface CompleteVerificationSessionSnapshot {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly sessionId: string;
  readonly sessionPrincipalId?: string | null;
  readonly channel?: string | null;
  readonly channelId?: string | null;
  readonly channelArtifact?: string | null;
  readonly identityTier?: number | null;
}

export interface CompleteVerificationPostFailure {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly verificationMethod: VerificationMethod;
  readonly error: string;
}

export interface CompleteVerificationDeps {
  readonly tokenStore: VerificationTokenStore;
  readonly verifiers: Map<VerificationMethod, IdentityVerifier>;
  readonly loadSession?: (
    tenantId: string,
    sessionId: string,
  ) => Promise<CompleteVerificationSessionSnapshot | null>;
  readonly promoteAndLink?: {
    execute(input: {
      tenantId: string;
      projectId?: string;
      sessionId: string;
      sessionPrincipalId?: string;
      currentTier: IdentityTier;
      verificationMethod: VerificationMethod;
      verificationTier?: IdentityTier;
      verificationAttemptId?: string;
      identityType: string;
      identityValue: string;
      artifactHash?: string;
      channelType: ChannelType;
      channelId: string;
      policySource?: string;
      grantScope?: string;
      traceId?: string;
      verifiedAt?: Date;
    }): Promise<{
      promoted: boolean;
      newTier?: IdentityTier;
      contactId?: string;
      error?: { code: string; message: string };
    }>;
  };
  readonly onPostVerificationFailure?: (
    failure: CompleteVerificationPostFailure,
  ) => Promise<void> | void;
}

export class CompleteVerification {
  constructor(private readonly deps: CompleteVerificationDeps) {}

  async execute(attemptId: string, proof: VerificationProof): Promise<VerificationResult> {
    const tenantId = normalizeOptionalString(proof.metadata?.tenantId);
    if (!tenantId) {
      return notFoundResult();
    }

    const storedAttempt = await this.deps.tokenStore.get(tenantId, attemptId);
    if (!storedAttempt) {
      return notFoundResult();
    }

    const projectId = normalizeOptionalString(proof.metadata?.projectId);
    const sessionPrincipalId = normalizeOptionalString(proof.metadata?.sessionPrincipalId);
    const storedProjectId = normalizeOptionalString(storedAttempt.projectId);
    const storedPrincipalId = normalizeOptionalString(storedAttempt.sessionPrincipalId);

    if (
      (storedProjectId && storedProjectId !== projectId) ||
      (storedPrincipalId && storedPrincipalId !== sessionPrincipalId)
    ) {
      return notFoundResult();
    }

    const verifier = this.deps.verifiers.get(storedAttempt.method);
    if (!verifier) {
      return {
        success: false,
        error: { code: 'NO_VERIFIER', message: 'No verifier for verification method' },
      };
    }

    const result = await verifier.complete(attemptId, proof);
    if (
      !result.success ||
      !result.verifiedIdentity ||
      !this.deps.promoteAndLink ||
      !this.deps.loadSession
    ) {
      return result;
    }

    try {
      const session = await this.deps.loadSession(tenantId, storedAttempt.sessionId);
      if (!session) {
        return result;
      }

      const promotion = await this.deps.promoteAndLink.execute({
        tenantId,
        projectId: storedProjectId ?? normalizeOptionalString(session.projectId),
        sessionId: storedAttempt.sessionId,
        sessionPrincipalId:
          storedPrincipalId ??
          normalizeOptionalString(session.sessionPrincipalId) ??
          storedAttempt.sessionId,
        currentTier: toIdentityTier(session.identityTier) ?? 0,
        verificationMethod: storedAttempt.method,
        verificationTier: toIdentityTier(result.identityTier),
        verificationAttemptId: storedAttempt.id,
        identityType: storedAttempt.identityType,
        identityValue: result.verifiedIdentity,
        artifactHash: normalizeOptionalString(session.channelArtifact),
        channelType: mapSessionChannelToChannelType(session.channel),
        channelId: normalizeOptionalString(session.channelId) ?? storedAttempt.sessionId,
        policySource: storedAttempt.policySource,
        grantScope: storedAttempt.grantScope,
        traceId: storedAttempt.traceId,
        verifiedAt: new Date(),
      });

      if (!promotion.promoted && promotion.error) {
        await this.deps.onPostVerificationFailure?.({
          tenantId,
          attemptId: storedAttempt.id,
          sessionId: storedAttempt.sessionId,
          verificationMethod: storedAttempt.method,
          error: promotion.error.message,
        });
      }
    } catch (error) {
      await this.deps.onPostVerificationFailure?.({
        tenantId,
        attemptId: storedAttempt.id,
        sessionId: storedAttempt.sessionId,
        verificationMethod: storedAttempt.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return result;
  }
}
