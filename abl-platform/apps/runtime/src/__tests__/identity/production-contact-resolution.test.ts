import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveOrCreateContactExecute = vi.fn();

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('production-contact-resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveOrCreateContactExecute.mockResolvedValue({
      id: 'contact-1',
      displayName: null,
    });
  });

  it('prefers channelArtifact over sessionPrincipalId for anonymous sdk callers', async () => {
    const { resolveCanonicalContactForProductionScope } =
      await import('../../services/identity/production-contact-resolution.js');

    await resolveCanonicalContactForProductionScope(
      {
        tenantId: 'tenant-1',
        channelType: 'sdk_http',
        sessionId: 'sess-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_http',
          anonymousId: 'anon-device-session',
          sessionPrincipalId: 'sdk-session-ephemeral-1',
          channelArtifact: 'artifact-hash-stable-1',
          channelArtifactType: 'cookie',
          identityTier: 0,
          verificationMethod: 'none',
        },
      },
      {
        resolveOrCreateContact: {
          execute: mockResolveOrCreateContactExecute,
        },
      } as any,
    );

    expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'external',
      'artifact-hash-stable-1',
      'sdk_http',
      {
        contactAuditSource: 'channel_artifact',
        suppressContactCreatedAudit: false,
      },
    );
  });

  it('treats email_thread channel artifacts as email identities', async () => {
    const { resolveCanonicalContactForProductionScope } =
      await import('../../services/identity/production-contact-resolution.js');

    await resolveCanonicalContactForProductionScope(
      {
        tenantId: 'tenant-1',
        channelType: 'email',
        sessionId: 'sess-email-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'email',
          anonymousId: 'fallback-anon',
          channelArtifact: 'customer@example.com',
          channelArtifactType: 'email_thread',
          identityTier: 1,
          verificationMethod: 'none',
        },
      },
      {
        resolveOrCreateContact: {
          execute: mockResolveOrCreateContactExecute,
        },
      } as any,
    );

    expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'email',
      'customer@example.com',
      'email',
      {
        contactAuditSource: 'channel_artifact',
        suppressContactCreatedAudit: false,
      },
    );
  });

  it('treats caller_id channel artifacts as phone identities', async () => {
    const { resolveCanonicalContactForProductionScope } =
      await import('../../services/identity/production-contact-resolution.js');

    await resolveCanonicalContactForProductionScope(
      {
        tenantId: 'tenant-1',
        channelType: 'voice_vxml',
        sessionId: 'sess-phone-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'voice_vxml',
          anonymousId: 'fallback-anon',
          channelArtifact: '+14155550199',
          channelArtifactType: 'caller_id',
          identityTier: 1,
          verificationMethod: 'none',
        },
      },
      {
        resolveOrCreateContact: {
          execute: mockResolveOrCreateContactExecute,
        },
      } as any,
    );

    expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'phone',
      '+14155550199',
      'voice_vxml',
      {
        contactAuditSource: 'channel_artifact',
        suppressContactCreatedAudit: false,
      },
    );
  });

  it('suppresses contact.created audit for session principal fallback contacts', async () => {
    const { resolveCanonicalContactForProductionScope } =
      await import('../../services/identity/production-contact-resolution.js');

    await resolveCanonicalContactForProductionScope(
      {
        tenantId: 'tenant-1',
        channelType: 'sdk_http',
        sessionId: 'sess-principal-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_http',
          sessionPrincipalId: 'sdk-session-ephemeral-1',
          identityTier: 2,
          verificationMethod: 'token',
        },
      },
      {
        resolveOrCreateContact: {
          execute: mockResolveOrCreateContactExecute,
        },
      } as any,
    );

    expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'external',
      'sdk-session-ephemeral-1',
      'sdk_http',
      {
        contactAuditSource: 'session_principal',
        suppressContactCreatedAudit: true,
      },
    );
  });

  it('suppresses contact.created audit for anonymous fallback contacts', async () => {
    const { resolveCanonicalContactForProductionScope } =
      await import('../../services/identity/production-contact-resolution.js');

    await resolveCanonicalContactForProductionScope(
      {
        tenantId: 'tenant-1',
        channelType: 'sdk_http',
        sessionId: 'sess-anon-1',
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'sdk_http',
          anonymousId: 'anon-device-session',
          identityTier: 2,
          verificationMethod: 'token',
        },
      },
      {
        resolveOrCreateContact: {
          execute: mockResolveOrCreateContactExecute,
        },
      } as any,
    );

    expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
      'tenant-1',
      'external',
      'anon-device-session',
      'sdk_http',
      {
        contactAuditSource: 'anonymous_id',
        suppressContactCreatedAudit: true,
      },
    );
  });
});
