import { describe, expect, it } from 'vitest';
import { SessionOAuthArtifact } from '../models/session-oauth-artifact.model.js';

function validArtifact() {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    provider: 'google',
    sessionPrincipal: 'sdk-session-1',
    // Legacy storage field; service contracts map this to canonical sessionId.
    runtimeSessionId: 'runtime-session-1',
    encryptedAccessToken: 'enc-access-token',
    scope: 'calendar.readonly',
    sessionExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consentedAt: new Date(),
  };
}

describe('SessionOAuthArtifact', () => {
  it('sets defaults on instantiation', () => {
    const artifact = new SessionOAuthArtifact(validArtifact());

    expect(artifact._id).toBeDefined();
    expect(artifact.tenantId).toBe('tenant-1');
    expect(artifact.projectId).toBe('project-1');
    expect(artifact.provider).toBe('google');
    expect(artifact.sessionPrincipal).toBe('sdk-session-1');
    expect(artifact.runtimeSessionId).toBe('runtime-session-1');
    expect(artifact.encryptedAccessToken).toBe('enc-access-token');
    expect(artifact.encryptedRefreshToken).toBeNull();
    expect(artifact.scope).toBe('calendar.readonly');
    expect(artifact.expiresAt).toBeNull();
    expect(artifact.channelId).toBeNull();
    expect(artifact.authProfileId).toBeNull();
    expect(artifact.authProfileRef).toBeNull();
    expect(artifact.lastUsedAt).toBeNull();
    expect(artifact._v).toBe(1);
  });

  it('requires sessionPrincipal', () => {
    const data = validArtifact();
    delete (data as Partial<typeof data>).sessionPrincipal;

    const err = new SessionOAuthArtifact(data).validateSync();

    expect(err).toBeDefined();
    expect(err?.errors.sessionPrincipal).toBeDefined();
  });

  it('defines a TTL index on sessionExpiresAt', () => {
    const ttlIndex = SessionOAuthArtifact.schema
      .indexes()
      .find(
        ([fields, options]) => fields.sessionExpiresAt === 1 && options?.expireAfterSeconds === 0,
      );

    expect(ttlIndex).toBeDefined();
  });
});
