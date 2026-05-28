import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityVerifier, VerificationProof } from '../../../../contexts/identity/index.js';
import { CompleteVerification } from '../../../../contexts/identity/index.js';
import type { StoredVerificationAttempt } from '../../../../contexts/identity/infrastructure/verification-token-store.js';

function makeAttempt(
  overrides: Partial<StoredVerificationAttempt> = {},
): StoredVerificationAttempt {
  return {
    id: 'attempt-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    sessionPrincipalId: 'principal-1',
    method: 'otp',
    identityValue: 'user@example.com',
    identityType: 'email_thread',
    policySource: 'identity_verification_route',
    grantScope: 'session',
    traceId: 'trace-1',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: new Date('2026-04-23T10:00:00.000Z'),
    expiresAt: new Date('2026-04-23T11:00:00.000Z'),
    codeHash: 'hash-1',
    ...overrides,
  };
}

const baseProof: VerificationProof = {
  type: 'otp_code',
  value: '123456',
  metadata: {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionPrincipalId: 'principal-1',
  },
};

describe('CompleteVerification', () => {
  const tokenStoreGet = vi.fn();
  const verifierComplete = vi.fn();
  const loadSession = vi.fn();
  const promoteAndLinkExecute = vi.fn();
  const onPostVerificationFailure = vi.fn();

  let useCase: CompleteVerification;
  let verifier: IdentityVerifier;

  beforeEach(() => {
    vi.clearAllMocks();

    verifier = {
      method: 'otp',
      supports: vi.fn(() => true),
      initiate: vi.fn(),
      complete: verifierComplete,
    };

    useCase = new CompleteVerification({
      tokenStore: {
        create: vi.fn(),
        get: tokenStoreGet,
        incrementAttempts: vi.fn(),
        markVerified: vi.fn(),
      },
      verifiers: new Map([['otp', verifier]]),
      loadSession,
      promoteAndLink: {
        execute: promoteAndLinkExecute,
      },
      onPostVerificationFailure,
    });
  });

  it('returns not found when the stored attempt does not exist', async () => {
    tokenStoreGet.mockResolvedValue(null);

    const result = await useCase.execute('attempt-1', baseProof);

    expect(result).toEqual({
      success: false,
      error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
    });
    expect(verifierComplete).not.toHaveBeenCalled();
  });

  it('fails closed when the project scope does not match the stored attempt', async () => {
    tokenStoreGet.mockResolvedValue(makeAttempt());

    const result = await useCase.execute('attempt-1', {
      ...baseProof,
      metadata: {
        ...baseProof.metadata,
        projectId: 'project-other',
      },
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
    });
    expect(verifierComplete).not.toHaveBeenCalled();
  });

  it('fails closed when the session principal does not match the stored attempt', async () => {
    tokenStoreGet.mockResolvedValue(makeAttempt());

    const result = await useCase.execute('attempt-1', {
      ...baseProof,
      metadata: {
        ...baseProof.metadata,
        sessionPrincipalId: 'principal-other',
      },
    });

    expect(result).toEqual({
      success: false,
      error: { code: 'ATTEMPT_NOT_FOUND', message: 'Verification attempt not found' },
    });
    expect(verifierComplete).not.toHaveBeenCalled();
  });

  it('runs post-verification linking with session-derived provenance', async () => {
    tokenStoreGet.mockResolvedValue(makeAttempt());
    verifierComplete.mockResolvedValue({
      success: true,
      identityTier: 2,
      verifiedIdentity: 'verified@example.com',
    });
    loadSession.mockResolvedValue({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionPrincipalId: 'principal-1',
      channel: 'sms',
      channelId: null,
      channelArtifact: 'artifact-hash-1',
      identityTier: 1,
    });
    promoteAndLinkExecute.mockResolvedValue({
      promoted: true,
      newTier: 2,
      contactId: 'contact-1',
    });

    const result = await useCase.execute('attempt-1', baseProof);

    expect(result.success).toBe(true);
    expect(verifierComplete).toHaveBeenCalledWith('attempt-1', baseProof);
    expect(loadSession).toHaveBeenCalledWith('tenant-1', 'session-1');
    expect(promoteAndLinkExecute).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionPrincipalId: 'principal-1',
      currentTier: 1,
      verificationMethod: 'otp',
      verificationTier: 2,
      verificationAttemptId: 'attempt-1',
      identityType: 'email_thread',
      identityValue: 'verified@example.com',
      artifactHash: 'artifact-hash-1',
      channelType: 'twilio_sms',
      channelId: 'session-1',
      policySource: 'identity_verification_route',
      grantScope: 'session',
      traceId: 'trace-1',
      verifiedAt: expect.any(Date),
    });
  });

  it('reports post-verification orchestration failures without masking successful verification', async () => {
    tokenStoreGet.mockResolvedValue(makeAttempt());
    verifierComplete.mockResolvedValue({
      success: true,
      identityTier: 2,
      verifiedIdentity: 'verified@example.com',
    });
    loadSession.mockResolvedValue({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      sessionPrincipalId: 'principal-1',
      channel: 'web_chat',
      channelId: 'channel-1',
      channelArtifact: 'artifact-hash-1',
      identityTier: 0,
    });
    promoteAndLinkExecute.mockRejectedValue(new Error('link failed'));

    const result = await useCase.execute('attempt-1', baseProof);

    expect(result).toEqual({
      success: true,
      identityTier: 2,
      verifiedIdentity: 'verified@example.com',
    });
    expect(onPostVerificationFailure).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      verificationMethod: 'otp',
      error: 'link failed',
    });
  });
});
