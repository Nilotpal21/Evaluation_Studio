import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeAuthOps } from '../auth-ops';
import type { ToolPermissionContext } from '../../guards';

function makeTestCtx(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    user: {
      tenantId: 't1',
      userId: 'u1',
      permissions: ['auth_profile:read', 'auth_profile:write', 'auth_profile:delete'],
    },
    projectId: 'p1',
    authToken: 'tok',
    ...overrides,
  };
}

describe('executeAuthOps — extended auth types', () => {
  describe('first-call needsSecrets contract', () => {
    it.each(['basic', 'custom_header', 'digest', 'azure_ad'])(
      'requests secrets for %s auth type',
      async (authType) => {
        const result = await executeAuthOps(
          { action: 'create', authType, profileName: `test-${authType}` },
          makeTestCtx(),
        );
        // First call (no flowId) returns needsSecrets contract at the top level.
        expect(result.needsSecrets).toBe(true);
        expect(result.flowId).toEqual(expect.any(String));
        expect(result.requiredSecrets).toBeDefined();
        expect(Array.isArray(result.requiredSecrets)).toBe(true);
        expect((result.requiredSecrets ?? []).length).toBeGreaterThan(0);
      },
    );

    it('requires username + password for basic auth', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'basic', profileName: 'test-basic' },
        makeTestCtx(),
      );
      expect(result.requiredSecrets).toEqual(['username', 'password']);
    });

    it('requires username + password for digest auth', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'digest', profileName: 'test-digest' },
        makeTestCtx(),
      );
      expect(result.requiredSecrets).toEqual(['username', 'password']);
    });

    it('requires clientId + clientSecret for azure_ad auth', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'azure_ad', profileName: 'test-azure' },
        makeTestCtx(),
      );
      expect(result.requiredSecrets).toEqual(['clientId', 'clientSecret']);
    });

    it('requires headerValues for custom_header auth', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'custom_header', profileName: 'test-headers' },
        makeTestCtx(),
      );
      expect(result.requiredSecrets).toEqual(['headerValues']);
    });
  });

  describe('none auth type', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                id: 'profile-none-1',
                name: 'test-none',
                authType: 'none',
                status: 'active',
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('creates none-auth profile in a single call (no secrets)', async () => {
      // Omit sessionId so syncActiveDraftFromAuthProfile early-returns
      // without touching the DB.
      const result = await executeAuthOps(
        { action: 'create', authType: 'none', profileName: 'test-none' },
        makeTestCtx({ sessionId: undefined }),
      );

      // 'none' should not require secrets — succeed on first call.
      expect(result.success).toBe(true);
      expect(result.needsSecrets).not.toBe(true);
      expect(result.flowId).toBeUndefined();
      expect((result.data as { id: string }).id).toBe('profile-none-1');

      // Confirm we POSTed straight to /auth-profiles with empty secrets.
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/projects/p1/auth-profiles');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body.authType).toBe('none');
      expect(body.secrets).toEqual({});
    });
  });

  describe('oauth2_token rejection', () => {
    it('rejects oauth2_token (system-managed) and points to OAuthLaunch', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'oauth2_token', profileName: 'test' },
        makeTestCtx(),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNSUPPORTED_AUTH_TYPE');
      expect(result.error?.message).toContain('OAuthLaunch');
    });
  });

  describe('unsupported / unknown auth types', () => {
    it('rejects truly unsupported auth types (e.g. saml) with UNSUPPORTED_AUTH_TYPE', async () => {
      const result = await executeAuthOps(
        { action: 'create', authType: 'saml', profileName: 'test-saml' },
        makeTestCtx(),
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNSUPPORTED_AUTH_TYPE');
      // Should NOT mention OAuthLaunch — that text is only for oauth2_token.
      expect(result.error?.message).not.toContain('OAuthLaunch');
    });
  });

  describe('PROFILE_NAME_COLLISION recovery', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      // Studio route returns 409 when the unique-index rejects a duplicate name.
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'DUPLICATE', message: 'Profile name already exists' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('returns structured collision error with existing profile summary', async () => {
      // Spy on the AuthProfile model's findOne so the collision lookup
      // returns a deterministic existing profile without hitting Mongo.
      const { AuthProfile } = await import('@agent-platform/database/models');
      const existingDoc = {
        _id: 'profile-existing-1',
        name: 'Slack OAuth App',
        authType: 'oauth2_app',
        createdBy: 'other-user',
        createdAt: new Date('2026-05-01T12:34:56Z'),
      };
      // findOne returns a query with .select(...).lean() chain — return a
      // thenable-shaped object so awaiting it resolves to the existing doc.
      const findOneSpy = vi.spyOn(AuthProfile, 'findOne').mockReturnValue({
        select: () => ({
          lean: async () => existingDoc,
        }),
      } as unknown as ReturnType<typeof AuthProfile.findOne>);

      // Provide a flowId so the create handler skips the needsSecrets first call
      // and goes straight to the POST (which our fetch mock returns 409 for).
      // Pre-populate the in-memory secret store for that flowId.
      const { setFlowSecrets } = await import('../secret-store');
      const flowId = 'collision-flow-1';
      await setFlowSecrets(flowId, { clientId: 'cid', clientSecret: 'csec' });

      const result = await executeAuthOps(
        {
          action: 'create',
          authType: 'oauth2_app',
          profileName: 'Slack OAuth App',
          flowId,
        },
        makeTestCtx({ sessionId: undefined }),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROFILE_NAME_COLLISION');
      expect(
        (result.data as { existingProfileSummary?: Record<string, unknown> } | undefined)
          ?.existingProfileSummary,
      ).toMatchObject({
        name: 'Slack OAuth App',
        authType: 'oauth2_app',
        createdBy: 'other-user',
      });
      expect((result.data as { existingProfileId?: string } | undefined)?.existingProfileId).toBe(
        'profile-existing-1',
      );
      expect(findOneSpy).toHaveBeenCalledTimes(1);

      // Confirm the lookup used findOne with the expected scoping fields —
      // never findById, and always tenant + project + visibility scoped.
      const filter = findOneSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(filter).toMatchObject({
        tenantId: 't1',
        projectId: 'p1',
        name: 'Slack OAuth App',
        visibility: 'shared',
      });
    });

    it('falls back to a generic collision message when lookup finds nothing', async () => {
      const { AuthProfile } = await import('@agent-platform/database/models');
      vi.spyOn(AuthProfile, 'findOne').mockReturnValue({
        select: () => ({
          lean: async () => null,
        }),
      } as unknown as ReturnType<typeof AuthProfile.findOne>);

      const { setFlowSecrets } = await import('../secret-store');
      const flowId = 'collision-flow-2';
      await setFlowSecrets(flowId, { clientId: 'cid', clientSecret: 'csec' });

      const result = await executeAuthOps(
        {
          action: 'create',
          authType: 'oauth2_app',
          profileName: 'Ghost Profile',
          flowId,
        },
        makeTestCtx({ sessionId: undefined }),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROFILE_NAME_COLLISION');
      expect(result.error?.message).toContain('Ghost Profile');
      expect(result.data).toBeUndefined();
    });
  });
});
