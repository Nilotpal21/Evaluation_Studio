import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  clearOAuth2TokenCache,
  resolveAuthHeaders,
  resolveAuthHeadersFromProfile,
  resolveAuthHeadersFromProfileDetailed,
} from '../services/mcp-auth-resolver.js';

const mockAuthProfileFindOne: Mock = vi.fn();
const mockOAuthGrantFindOne: Mock = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  AuthProfile: {
    findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
  },
  EndUserOAuthToken: {
    findOne: (...args: unknown[]) => mockOAuthGrantFindOne(...args),
  },
}));

function makeLeanQuery(result: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(result),
  };
}

describe('mcp-auth-resolver', () => {
  beforeEach(() => {
    clearOAuth2TokenCache();
    vi.restoreAllMocks();
    mockAuthProfileFindOne.mockReset();
    mockOAuthGrantFindOne.mockReset();
    process.env.REDIS_URL = '';
  });

  describe('resolveAuthHeaders (legacy MCP auth config)', () => {
    it('returns empty headers for none', async () => {
      await expect(resolveAuthHeaders({ type: 'none' }, 'tenant-1')).resolves.toEqual({});
    });

    it('returns Authorization header for bearer', async () => {
      await expect(
        resolveAuthHeaders({ type: 'bearer', token: 'token-1' }, 'tenant-1'),
      ).resolves.toEqual({
        Authorization: 'Bearer token-1',
      });
    });

    it('returns named header for api_key', async () => {
      await expect(
        resolveAuthHeaders(
          {
            type: 'api_key',
            headerName: 'X-API-Key',
            value: 'secret',
          },
          'tenant-1',
        ),
      ).resolves.toEqual({ 'X-API-Key': 'secret' });
    });

    it('sanitizes CRLF in header names/values', async () => {
      await expect(
        resolveAuthHeaders(
          {
            type: 'custom_headers',
            headers: {
              'X-Test\r\n': 'value\n',
            },
          },
          'tenant-1',
        ),
      ).resolves.toEqual({ 'X-Test': 'value' });
    });

    it('resolves oauth2_client_credentials and reuses in-memory fallback cache', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'cc-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const config = {
        type: 'oauth2_client_credentials' as const,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenEndpoint: 'https://auth.example.com/token',
        scope: 'read write',
      };

      const first = await resolveAuthHeaders(config, 'tenant-1');
      const second = await resolveAuthHeaders(config, 'tenant-1');

      expect(first).toEqual({ Authorization: 'Bearer cc-token' });
      expect(second).toEqual({ Authorization: 'Bearer cc-token' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveAuthHeadersFromProfile (auth-profile-backed MCP auth)', () => {
    it('resolves api_key profile into headers', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'api_key',
          profileVersion: 3,
          connectionMode: 'shared',
          config: { headerName: 'X-API-Key' },
          encryptedSecrets: JSON.stringify({ apiKey: 'abc123' }),
          updatedAt: new Date(),
        }),
      );

      const headers = await resolveAuthHeadersFromProfile({
        authProfileId: 'profile-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        transport: 'http',
      });

      expect(headers).toEqual({ 'X-API-Key': 'abc123' });
    });

    it('rejects all MCP-incompatible auth profile types', async () => {
      const incompatibleAuthTypes = [
        'aws_iam',
        'digest',
        'hawk',
        'ssh_key',
        'ws_security',
      ] as const;

      for (const authType of incompatibleAuthTypes) {
        mockAuthProfileFindOne.mockReturnValue(
          makeLeanQuery({
            _id: `profile-${authType}`,
            tenantId: 'tenant-1',
            projectId: 'project-1',
            authType,
            profileVersion: 1,
            config: {},
            encryptedSecrets: JSON.stringify({}),
            updatedAt: new Date(),
          }),
        );

        await expect(
          resolveAuthHeadersFromProfile({
            authProfileId: `profile-${authType}`,
            tenantId: 'tenant-1',
            projectId: 'project-1',
            transport: 'http',
          }),
        ).rejects.toMatchObject({ code: 'AUTH_TYPE_NOT_MCP_COMPATIBLE' });
      }
    });

    it('resolves oauth2_client_credentials profile using legacy config.scope string', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'cc-token-profile', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-cc-scope',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'oauth2_client_credentials',
          profileVersion: 7,
          connectionMode: 'shared',
          config: {
            tokenUrl: 'https://auth.example.com/token',
            scope: 'read write',
          },
          encryptedSecrets: JSON.stringify({
            clientId: 'client-id',
            clientSecret: 'client-secret',
          }),
          updatedAt: new Date(),
        }),
      );

      const headers = await resolveAuthHeadersFromProfile({
        authProfileId: 'profile-cc-scope',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        transport: 'http',
      });

      expect(headers).toEqual({ Authorization: 'Bearer cc-token-profile' });
      const requestInit = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const body = requestInit?.body;
      const encodedBody = body instanceof URLSearchParams ? body.toString() : String(body ?? '');
      expect(encodedBody).toContain('scope=read+write');
    });

    it('rejects api_key profile with query placement for MCP auth', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-2b',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'api_key',
          profileVersion: 1,
          connectionMode: 'shared',
          config: { headerName: 'api_key', placement: 'query' },
          encryptedSecrets: JSON.stringify({ apiKey: 'secret' }),
          updatedAt: new Date(),
        }),
      );

      await expect(
        resolveAuthHeadersFromProfile({
          authProfileId: 'profile-2b',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          transport: 'http',
        }),
      ).rejects.toMatchObject({ code: 'AUTH_TYPE_NOT_MCP_COMPATIBLE' });
    });

    it('rejects mtls profile for sse transport', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-3',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'mtls',
          profileVersion: 1,
          config: {},
          encryptedSecrets: JSON.stringify({}),
          updatedAt: new Date(),
        }),
      );

      await expect(
        resolveAuthHeadersFromProfile({
          authProfileId: 'profile-3',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          transport: 'sse',
        }),
      ).rejects.toMatchObject({ code: 'MCP_TRANSPORT_NOT_TLS_CAPABLE' });
    });

    it('returns TLS options for mtls profile on HTTP transport', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-3-http',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'mtls',
          profileVersion: 4,
          connectionMode: 'shared',
          config: {},
          encryptedSecrets: JSON.stringify({
            clientCert: '---CERT---',
            clientKey: '---KEY---',
            caCert: '---CA---',
          }),
          updatedAt: new Date(),
        }),
      );

      const resolved = await resolveAuthHeadersFromProfileDetailed({
        authProfileId: 'profile-3-http',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        transport: 'http',
      });

      expect(resolved).toEqual({
        headers: {},
        authType: 'mtls',
        profileVersion: 4,
        expiresAt: undefined,
        tlsOptions: {
          cert: '---CERT---',
          key: '---KEY---',
          ca: '---CA---',
        },
      });
    });

    it('rejects per-user auth profiles for MCP bindings', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-3b',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'api_key',
          profileVersion: 1,
          connectionMode: 'per_user',
          config: { headerName: 'X-API-Key' },
          encryptedSecrets: JSON.stringify({ apiKey: 'secret' }),
          updatedAt: new Date(),
        }),
      );

      await expect(
        resolveAuthHeadersFromProfile({
          authProfileId: 'profile-3b',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          transport: 'http',
        }),
      ).rejects.toMatchObject({ code: 'AUTH_PROFILE_PER_USER_IN_MCP' });
      expect(mockOAuthGrantFindOne).not.toHaveBeenCalled();
    });

    it('resolves oauth2_app grant-backed profile', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'app-profile-1',
          tenantId: 'tenant-1',
          projectId: null,
          authType: 'oauth2_app',
          profileVersion: 2,
          connectionMode: 'shared',
          config: {},
          encryptedSecrets: JSON.stringify({}),
          updatedAt: new Date(),
        }),
      );

      mockOAuthGrantFindOne.mockReturnValue(
        makeLeanQuery({
          tenantId: 'tenant-1',
          userId: '__tenant__',
          encryptedAccessToken: 'oauth-grant-token',
          encryptedRefreshToken: 'refresh-token',
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      );

      const headers = await resolveAuthHeadersFromProfile({
        authProfileId: 'app-profile-1',
        tenantId: 'tenant-1',
        transport: 'http',
      });

      expect(headers).toEqual({ Authorization: 'Bearer oauth-grant-token' });
      expect(mockOAuthGrantFindOne).toHaveBeenCalled();
    });

    it('checks __tenant__ principal before caller principal for shared oauth2_app profiles', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'app-profile-shared-priority',
          tenantId: 'tenant-1',
          projectId: null,
          authType: 'oauth2_app',
          profileVersion: 2,
          connectionMode: 'shared',
          createdBy: 'owner-user',
          config: {},
          encryptedSecrets: JSON.stringify({}),
          updatedAt: new Date(),
        }),
      );

      mockOAuthGrantFindOne.mockReturnValueOnce(makeLeanQuery(null)).mockReturnValueOnce(
        makeLeanQuery({
          tenantId: 'tenant-1',
          userId: 'caller-user',
          encryptedAccessToken: 'caller-token',
          encryptedRefreshToken: null,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      );

      const headers = await resolveAuthHeadersFromProfile({
        authProfileId: 'app-profile-shared-priority',
        tenantId: 'tenant-1',
        principalUserId: 'caller-user',
        transport: 'http',
      });

      expect(headers).toEqual({ Authorization: 'Bearer caller-token' });
      expect(mockOAuthGrantFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
      expect(mockOAuthGrantFindOne.mock.calls[1][0]).toMatchObject({ userId: 'caller-user' });
    });

    it('uses profile owner as shared compatibility fallback when tenant grant is missing', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'app-profile-owner-fallback',
          tenantId: 'tenant-1',
          projectId: null,
          authType: 'oauth2_app',
          profileVersion: 2,
          connectionMode: 'shared',
          createdBy: 'owner-user',
          config: {},
          encryptedSecrets: JSON.stringify({}),
          updatedAt: new Date(),
        }),
      );

      mockOAuthGrantFindOne.mockReturnValueOnce(makeLeanQuery(null)).mockReturnValueOnce(
        makeLeanQuery({
          tenantId: 'tenant-1',
          userId: 'owner-user',
          encryptedAccessToken: 'owner-token',
          encryptedRefreshToken: null,
          expiresAt: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      );

      const headers = await resolveAuthHeadersFromProfile({
        authProfileId: 'app-profile-owner-fallback',
        tenantId: 'tenant-1',
        transport: 'http',
      });

      expect(headers).toEqual({ Authorization: 'Bearer owner-token' });
      expect(mockOAuthGrantFindOne.mock.calls[0][0]).toMatchObject({ userId: '__tenant__' });
      expect(mockOAuthGrantFindOne.mock.calls[1][0]).toMatchObject({ userId: 'owner-user' });
    });

    it('returns OAUTH_REAUTH_REQUIRED when oauth grant is missing', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'app-profile-2',
          tenantId: 'tenant-1',
          projectId: null,
          authType: 'oauth2_app',
          profileVersion: 2,
          connectionMode: 'shared',
          config: {},
          encryptedSecrets: JSON.stringify({}),
          updatedAt: new Date(),
        }),
      );

      mockOAuthGrantFindOne.mockReturnValue(makeLeanQuery(null));

      await expect(
        resolveAuthHeadersFromProfile({
          authProfileId: 'app-profile-2',
          tenantId: 'tenant-1',
          transport: 'http',
        }),
      ).rejects.toMatchObject({ code: 'OAUTH_REAUTH_REQUIRED' });
    });

    it('normalizes malformed secret payload failures to AUTH_PROFILE_SECRETS_DECRYPTION_FAILED', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-bad-secrets',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'api_key',
          profileVersion: 1,
          connectionMode: 'shared',
          config: { headerName: 'X-API-Key' },
          encryptedSecrets: 'not-json',
          previousEncryptedSecrets: undefined,
          rotationGracePeriodMs: undefined,
          updatedAt: new Date(),
        }),
      );

      await expect(
        resolveAuthHeadersFromProfile({
          authProfileId: 'profile-bad-secrets',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          transport: 'http',
        }),
      ).rejects.toMatchObject({ code: 'AUTH_PROFILE_SECRETS_DECRYPTION_FAILED' });
    });

    it('returns detailed metadata for profile-backed auth resolution', async () => {
      mockAuthProfileFindOne.mockReturnValue(
        makeLeanQuery({
          _id: 'profile-4',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          authType: 'api_key',
          profileVersion: 7,
          connectionMode: 'shared',
          config: { headerName: 'X-API-Key' },
          encryptedSecrets: JSON.stringify({ apiKey: 'detailed-key' }),
          updatedAt: new Date(),
        }),
      );

      const resolved = await resolveAuthHeadersFromProfileDetailed({
        authProfileId: 'profile-4',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        transport: 'http',
      });

      expect(resolved).toEqual({
        headers: { 'X-API-Key': 'detailed-key' },
        authType: 'api_key',
        profileVersion: 7,
        expiresAt: undefined,
      });
    });
  });
});
