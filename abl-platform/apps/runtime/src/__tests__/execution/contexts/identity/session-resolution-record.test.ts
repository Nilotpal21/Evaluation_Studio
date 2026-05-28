import { describe, expect, it } from 'vitest';

import { normalizeSessionResolutionRecord } from '../../../../contexts/identity/domain/session-resolution-record.js';

describe('normalizeSessionResolutionRecord', () => {
  it('normalizes a legacy sessionId-only write into a full provenance record', () => {
    const record = normalizeSessionResolutionRecord({
      tenantId: 'tenant-1',
      channelId: 'channel-1',
      artifactHash: 'artifact-1',
      sessionId: 'session-1',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });

    expect(record).toMatchObject({
      tenantId: 'tenant-1',
      projectId: '',
      channelId: 'channel-1',
      artifactHash: 'artifact-1',
      sessionLocator: {
        tenantId: 'tenant-1',
        projectId: '',
        sessionId: 'session-1',
      },
      sessionPrincipalId: 'session-1',
      verificationMethod: 'none',
      identityTier: 0,
      policySource: 'session_resolution_write',
      grantScope: 'session',
    });
  });

  it('preserves explicit project-safe provenance fields when provided', () => {
    const verifiedAt = new Date('2026-04-23T12:00:00.000Z');
    const record = normalizeSessionResolutionRecord({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      artifactHash: 'artifact-1',
      sessionLocator: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
      sessionPrincipalId: 'principal-1',
      verificationAttemptId: 'attempt-1',
      verificationMethod: 'otp',
      identityTier: 2,
      policySource: 'identity_verification_route',
      grantScope: 'user',
      verifiedAt,
      traceId: 'trace-1',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });

    expect(record).toEqual({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      artifactHash: 'artifact-1',
      sessionLocator: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
      sessionPrincipalId: 'principal-1',
      verificationAttemptId: 'attempt-1',
      verificationMethod: 'otp',
      identityTier: 2,
      policySource: 'identity_verification_route',
      grantScope: 'user',
      verifiedAt,
      traceId: 'trace-1',
      expiresAt: new Date('2026-12-31T23:59:59Z'),
    });
  });
});
