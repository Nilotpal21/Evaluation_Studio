/**
 * Regression coverage for the runPieceAuthValidate bridge between auth-profile
 * validate routes and Activepieces piece-level `auth.validate` hooks.
 *
 * Verifies:
 * 1. When the connector exposes a `validateAuth` function, the helper invokes
 *    it with normalized auth and returns its outcome.
 * 2. When the connector has no `validateAuth`, the helper returns null so the
 *    caller falls back to optimistic valid=true (preserves prior UX).
 * 3. When the validate hook throws, the error is caught and surfaced as
 *    `{ valid: false, error }` — never crashes the route.
 * 4. When the profile has no connector slug or the connector isn't registered,
 *    the helper returns null without exploding.
 *
 * Per CLAUDE.md "Test Architecture", this test passes registry + normalizer as
 * injected dependencies via the public `RunPieceAuthValidateDeps` parameter —
 * no `vi.mock()` of `@agent-platform/*` or `@/lib/*` modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAuthProfile } from '@agent-platform/database/models';
import {
  runPieceAuthValidate,
  type PieceValidatorRegistry,
  type RunPieceAuthValidateDeps,
} from '@/app/api/auth-profiles/_piece-auth-validator';

function makeProfile(overrides: Partial<IAuthProfile> = {}): IAuthProfile {
  return {
    _id: 'ap-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Test',
    authType: 'api_key',
    usageMode: 'preconfigured',
    visibility: 'shared',
    status: 'active',
    scope: 'project',
    connectionMode: 'shared',
    environment: null,
    createdBy: 'user-1',
    config: {},
    encryptedSecrets: '{}',
    encryptionKeyVersion: 1,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    connector: 'slack',
    ...overrides,
  } as unknown as IAuthProfile;
}

function makeRegistry(
  connectors: Record<string, { auth: { validateAuth?: unknown } }>,
): PieceValidatorRegistry {
  return {
    has: (name: string) => name in connectors,
    get: (name: string) => connectors[name],
  };
}

function makeDeps(
  registry: PieceValidatorRegistry | Promise<PieceValidatorRegistry> | (() => never),
  normalizeSpy = vi.fn((_name: string, auth: Record<string, unknown>) => auth as unknown),
): RunPieceAuthValidateDeps & { normalizeSpy: ReturnType<typeof vi.fn> } {
  const getRegistry = async (): Promise<PieceValidatorRegistry> => {
    if (typeof registry === 'function') return registry();
    return registry;
  };
  return {
    getRegistry,
    normalizeAuth: normalizeSpy,
    normalizeSpy,
  };
}

describe('runPieceAuthValidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes the connector validateAuth and returns valid:true on success', async () => {
    const validateAuth = vi.fn().mockResolvedValue({ valid: true });
    const deps = makeDeps(makeRegistry({ slack: { auth: { validateAuth } } }));

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack' }),
        decryptedSecrets: { apiKey: 'xoxb-123' },
      },
      deps,
    );

    expect(result).toEqual({ valid: true });
    expect(validateAuth).toHaveBeenCalledTimes(1);
    expect(validateAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ apiKey: 'xoxb-123' }),
        server: expect.objectContaining({
          apiUrl: expect.any(String),
          publicUrl: expect.any(String),
        }),
      }),
    );
  });

  it('returns valid:false with the upstream error message when the piece rejects', async () => {
    const validateAuth = vi.fn().mockResolvedValue({ valid: false, error: 'invalid_auth' });
    const deps = makeDeps(makeRegistry({ slack: { auth: { validateAuth } } }));

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack' }),
        decryptedSecrets: { apiKey: 'wrong-token' },
      },
      deps,
    );

    expect(result).toEqual({ valid: false, error: 'invalid_auth' });
  });

  it('catches thrown errors from validateAuth and surfaces them as {valid:false}', async () => {
    const validateAuth = vi.fn().mockRejectedValue(new Error('network down'));
    const deps = makeDeps(makeRegistry({ slack: { auth: { validateAuth } } }));

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack' }),
        decryptedSecrets: { apiKey: 'token' },
      },
      deps,
    );

    expect(result).toEqual({ valid: false, error: 'network down' });
  });

  it('returns null when the connector has no validateAuth and no liveChecks entry', async () => {
    const deps = { ...makeDeps(makeRegistry({ slack: { auth: {} } })), liveChecks: {} };

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack' }),
        decryptedSecrets: { apiKey: 'token' },
      },
      deps,
    );

    expect(result).toBeNull();
  });

  it('uses injected liveChecks when the connector has no validateAuth', async () => {
    const liveCheck = vi.fn().mockResolvedValue({ valid: true });
    const deps = {
      ...makeDeps(makeRegistry({ discord: { auth: {} } })),
      liveChecks: { discord: liveCheck },
    };

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'discord', authType: 'api_key' }),
        decryptedSecrets: { apiKey: 'Bot.token.here' },
      },
      deps,
    );

    expect(result).toEqual({ valid: true });
    expect(liveCheck).toHaveBeenCalledTimes(1);
    expect(liveCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: expect.objectContaining({ apiKey: 'Bot.token.here' }),
      }),
    );
  });

  it('liveChecks failure is surfaced as {valid:false}', async () => {
    const liveCheck = vi.fn().mockResolvedValue({ valid: false, error: 'Invalid bot token' });
    const deps = {
      ...makeDeps(makeRegistry({ discord: { auth: {} } })),
      liveChecks: { discord: liveCheck },
    };

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'discord', authType: 'api_key' }),
        decryptedSecrets: { apiKey: 'wrong-token' },
      },
      deps,
    );

    expect(result).toEqual({ valid: false, error: 'Invalid bot token' });
  });

  it('liveChecks thrown error is caught and surfaced as {valid:false}', async () => {
    const liveCheck = vi.fn().mockRejectedValue(new Error('network timeout'));
    const deps = {
      ...makeDeps(makeRegistry({ discord: { auth: {} } })),
      liveChecks: { discord: liveCheck },
    };

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'discord', authType: 'api_key' }),
        decryptedSecrets: { apiKey: 'token' },
      },
      deps,
    );

    expect(result).toEqual({ valid: false, error: 'network timeout' });
  });

  it('returns null when the profile has no connector slug', async () => {
    const getRegistry = vi.fn();
    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: undefined }),
        decryptedSecrets: { apiKey: 'token' },
      },
      { getRegistry, normalizeAuth: vi.fn() },
    );

    expect(result).toBeNull();
    expect(getRegistry).not.toHaveBeenCalled();
  });

  it('returns null when the connector slug is not registered', async () => {
    const deps = makeDeps(makeRegistry({}));

    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'unknown-piece' }),
        decryptedSecrets: { apiKey: 'token' },
      },
      deps,
    );

    expect(result).toBeNull();
  });

  it('returns null gracefully if the registry singleton fails to initialise', async () => {
    const result = await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack' }),
        decryptedSecrets: { apiKey: 'token' },
      },
      {
        getRegistry: () => {
          throw new Error('boot failed');
        },
      },
    );

    expect(result).toBeNull();
  });

  it('forwards the OAuth access token under access_token when provided', async () => {
    const validateAuth = vi.fn().mockResolvedValue({ valid: true });
    const deps = makeDeps(makeRegistry({ slack: { auth: { validateAuth } } }));

    await runPieceAuthValidate(
      {
        profile: makeProfile({ connector: 'slack', authType: 'oauth2_app' }),
        decryptedSecrets: { clientId: 'id', clientSecret: 'secret' },
        oauthAccessToken: 'xoxp-real-token',
      },
      deps,
    );

    const call = deps.normalizeSpy.mock.calls[0];
    expect(call[1]).toMatchObject({
      access_token: 'xoxp-real-token',
      clientId: 'id',
    });
  });

  // ── Built-in live check routing — credential forwarding ───────────────────
  // Each test injects a mock liveCheck for the connector under test and asserts
  // that runPieceAuthValidate routes the correct secrets/config to it.
  // No real HTTP calls are made — the BUILT_IN_LIVE_CHECKS map is bypassed by
  // the injected `liveChecks` dep.

  describe('claude — routes apiKey to liveCheck secrets', () => {
    it('returns valid:true when the liveCheck succeeds', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ claude: { auth: {} } })),
        liveChecks: { claude: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'claude', authType: 'api_key' }),
          decryptedSecrets: { apiKey: 'sk-ant-abc123' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({ secrets: expect.objectContaining({ apiKey: 'sk-ant-abc123' }) }),
      );
    });

    it('surfaces liveCheck failure as {valid:false}', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: false, error: 'Invalid API key' });
      const deps = {
        ...makeDeps(makeRegistry({ claude: { auth: {} } })),
        liveChecks: { claude: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'claude', authType: 'api_key' }),
          decryptedSecrets: { apiKey: 'bad-key' },
        },
        deps,
      );

      expect(result).toEqual({ valid: false, error: 'Invalid API key' });
    });
  });

  describe('twilio — routes username/password to liveCheck secrets', () => {
    it('passes accountSid as username and authToken as password', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ twilio: { auth: {} } })),
        liveChecks: { twilio: liveCheck },
      };

      await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'twilio', authType: 'basic_auth' }),
          decryptedSecrets: { username: 'ACabc123', password: 'token456' },
        },
        deps,
      );

      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ username: 'ACabc123', password: 'token456' }),
        }),
      );
    });
  });

  describe('servicenow — routes access_token + subdomain config to liveCheck', () => {
    it('passes access_token from secrets and subdomain from config.connectionConfig', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ servicenow: { auth: {} } })),
        liveChecks: { servicenow: liveCheck },
      };

      await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'servicenow',
            authType: 'oauth2_token',
            config: { connectionConfig: { subdomain: 'myinstance' } },
          }),
          decryptedSecrets: { access_token: 'sn-token-xyz' },
        },
        deps,
      );

      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'sn-token-xyz' }),
          config: expect.objectContaining({ connectionConfig: { subdomain: 'myinstance' } }),
        }),
      );
    });
  });

  describe('microsoft-outlook-calendar — routes access_token to liveCheck', () => {
    it('forwards access_token to liveCheck secrets', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-outlook-calendar': { auth: {} } })),
        liveChecks: { 'microsoft-outlook-calendar': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'microsoft-outlook-calendar',
            authType: 'oauth2_token',
          }),
          decryptedSecrets: { access_token: 'eyJhbGc.ms.token' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'eyJhbGc.ms.token' }),
        }),
      );
    });
  });

  describe('microsoft-sharepoint — routes access_token to liveCheck', () => {
    it('forwards access_token and returns valid:true', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-sharepoint': { auth: {} } })),
        liveChecks: { 'microsoft-sharepoint': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'microsoft-sharepoint', authType: 'oauth2_token' }),
          decryptedSecrets: { access_token: 'sp-token-xyz' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
    });
  });

  describe('microsoft-power-bi — routes access_token to liveCheck', () => {
    it('surfaces liveCheck failure', async () => {
      const liveCheck = vi
        .fn()
        .mockResolvedValue({ valid: false, error: 'Invalid or expired access token' });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-power-bi': { auth: {} } })),
        liveChecks: { 'microsoft-power-bi': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'microsoft-power-bi', authType: 'oauth2_token' }),
          decryptedSecrets: { access_token: 'expired-token' },
        },
        deps,
      );

      expect(result).toEqual({ valid: false, error: 'Invalid or expired access token' });
    });
  });

  describe('microsoft-onedrive — cloud-aware live check', () => {
    it('routes access_token and defaults to commercial Graph endpoint', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-onedrive': { auth: {} } })),
        liveChecks: { 'microsoft-onedrive': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'microsoft-onedrive', authType: 'oauth2_token' }),
          decryptedSecrets: { access_token: 'od-token-xyz' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'od-token-xyz' }),
        }),
      );
    });

    it('forwards US Gov cloud config to live check', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-onedrive': { auth: {} } })),
        liveChecks: { 'microsoft-onedrive': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'microsoft-onedrive',
            authType: 'oauth2_token',
            config: { props: { cloud: 'login.microsoftonline.us' } },
          }),
          decryptedSecrets: { access_token: 'od-gov-token' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ props: { cloud: 'login.microsoftonline.us' } }),
        }),
      );
    });

    it('surfaces rejection as {valid:false}', async () => {
      const liveCheck = vi
        .fn()
        .mockResolvedValue({ valid: false, error: 'Invalid or expired access token' });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-onedrive': { auth: {} } })),
        liveChecks: { 'microsoft-onedrive': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'microsoft-onedrive', authType: 'oauth2_token' }),
          decryptedSecrets: { access_token: 'bad-token' },
        },
        deps,
      );

      expect(result).toEqual({ valid: false, error: 'Invalid or expired access token' });
    });
  });

  describe('AWS SigV4 connectors — route IAM credentials to liveChecks', () => {
    const awsSecrets = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
    };

    for (const connector of ['amazon-s3', 'amazon-ses', 'amazon-sns', 'amazon-sqs'] as const) {
      it(`${connector}: forwards IAM credentials to liveCheck and returns valid:true`, async () => {
        const liveCheck = vi.fn().mockResolvedValue({ valid: true });
        const deps = {
          ...makeDeps(makeRegistry({ [connector]: { auth: {} } })),
          liveChecks: { [connector]: liveCheck },
        };

        const result = await runPieceAuthValidate(
          {
            profile: makeProfile({ connector, authType: 'custom' }),
            decryptedSecrets: { ...awsSecrets },
          },
          deps,
        );

        expect(result).toEqual({ valid: true });
        expect(liveCheck).toHaveBeenCalledWith(
          expect.objectContaining({
            secrets: expect.objectContaining({
              accessKeyId: awsSecrets.accessKeyId,
              secretAccessKey: awsSecrets.secretAccessKey,
              region: 'us-east-1',
            }),
          }),
        );
      });

      it(`${connector}: surfaces invalid-credentials failure as {valid:false}`, async () => {
        const liveCheck = vi.fn().mockResolvedValue({
          valid: false,
          error: `Invalid AWS credentials or insufficient ${connector.replace('amazon-', '').toUpperCase()} permissions`,
        });
        const deps = {
          ...makeDeps(makeRegistry({ [connector]: { auth: {} } })),
          liveChecks: { [connector]: liveCheck },
        };

        const result = await runPieceAuthValidate(
          {
            profile: makeProfile({ connector, authType: 'custom' }),
            decryptedSecrets: { accessKeyId: 'bad', secretAccessKey: 'bad', region: 'us-east-1' },
          },
          deps,
        );

        expect(result).toMatchObject({ valid: false });
        expect(result?.error).toBeTruthy();
      });
    }
  });

  describe('zendesk — routes access_token + subdomain to liveCheck', () => {
    it('forwards token and subdomain config to the live check', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ zendesk: { auth: {} } })),
        liveChecks: { zendesk: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'zendesk',
            authType: 'oauth2_token',
            config: { connectionConfig: { subdomain: 'mycompany' } },
          }),
          decryptedSecrets: { access_token: 'zd-token-xyz' },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'zd-token-xyz' }),
          config: expect.objectContaining({ connectionConfig: { subdomain: 'mycompany' } }),
        }),
      );
    });

    it('surfaces liveCheck failure with the upstream error', async () => {
      const liveCheck = vi
        .fn()
        .mockResolvedValue({ valid: false, error: 'Invalid or expired access token' });
      const deps = {
        ...makeDeps(makeRegistry({ zendesk: { auth: {} } })),
        liveChecks: { zendesk: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'zendesk',
            authType: 'oauth2_token',
            config: { connectionConfig: { subdomain: 'mycompany' } },
          }),
          decryptedSecrets: { access_token: 'expired-token' },
        },
        deps,
      );

      expect(result).toEqual({ valid: false, error: 'Invalid or expired access token' });
    });
  });

  // amazon-s3 has an AP validate hook but it requires `auth.bucket` — a
  // per-action field, not a credential. Auth profiles don't carry bucket names,
  // so the AP hook always false-negatives. The built-in live check (SigV4 service
  // call, no bucket needed) must take precedence.
  describe('amazon-s3 — built-in live check overrides AP hook that needs non-credential params', () => {
    it('uses the injected liveCheck even when validateAuth is present on the connector', async () => {
      const apHook = vi.fn().mockResolvedValue({ valid: false, error: 'bucket required' });
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });

      // Registry has a validateAuth hook (simulates the real AP piece)
      const deps = {
        ...makeDeps(makeRegistry({ 'amazon-s3': { auth: { validateAuth: apHook } } })),
        liveChecks: { 'amazon-s3': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'amazon-s3', authType: 'custom' }),
          decryptedSecrets: {
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI',
            region: 'us-east-1',
          },
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledTimes(1);
      // The AP hook must NOT be called — it would false-negative on missing bucket.
      expect(apHook).not.toHaveBeenCalled();
    });

    it('returns null when neither the AP hook nor a liveCheck is available', async () => {
      const apHook = vi.fn().mockResolvedValue({ valid: false, error: 'bucket required' });

      const deps = {
        ...makeDeps(makeRegistry({ 'amazon-s3': { auth: { validateAuth: apHook } } })),
        liveChecks: {}, // no built-in check injected
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'amazon-s3', authType: 'custom' }),
          decryptedSecrets: { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' },
        },
        deps,
      );

      expect(result).toBeNull();
      expect(apHook).not.toHaveBeenCalled();
    });
  });

  // ── OAuth2 connector live checks ────────────────────────────────────────────
  // For oauth2_app profiles the access token reaches runPieceAuthValidate via
  // oauthAccessToken → buildAuthPayload → secrets.access_token.

  describe('OAuth2 connector live checks — access_token routing', () => {
    const oauthToken = 'gho_oauth_access_token_xyz';

    for (const connector of [
      'github',
      'gmail',
      'google-calendar',
      'google-drive',
      'google-sheets',
      'slack',
      'hubspot',
      'asana',
      'clickup',
      'pipedrive',
      'microsoft-outlook',
    ] as const) {
      it(`${connector}: routes access_token to liveCheck and returns valid:true`, async () => {
        const liveCheck = vi.fn().mockResolvedValue({ valid: true });
        const deps = {
          ...makeDeps(makeRegistry({ [connector]: { auth: {} } })),
          liveChecks: { [connector]: liveCheck },
        };

        const result = await runPieceAuthValidate(
          {
            profile: makeProfile({ connector, authType: 'oauth2_app' }),
            decryptedSecrets: {},
            oauthAccessToken: oauthToken,
          },
          deps,
        );

        expect(result).toEqual({ valid: true });
        expect(liveCheck).toHaveBeenCalledTimes(1);
        expect(liveCheck).toHaveBeenCalledWith(
          expect.objectContaining({
            secrets: expect.objectContaining({ access_token: oauthToken }),
          }),
        );
      });

      it(`${connector}: surfaces liveCheck rejection as {valid:false}`, async () => {
        const liveCheck = vi
          .fn()
          .mockResolvedValue({ valid: false, error: 'Invalid or expired token' });
        const deps = {
          ...makeDeps(makeRegistry({ [connector]: { auth: {} } })),
          liveChecks: { [connector]: liveCheck },
        };

        const result = await runPieceAuthValidate(
          {
            profile: makeProfile({ connector, authType: 'oauth2_app' }),
            decryptedSecrets: {},
            oauthAccessToken: 'revoked-token',
          },
          deps,
        );

        expect(result).toEqual({ valid: false, error: 'Invalid or expired token' });
      });
    }
  });

  describe('salesforce — environment-aware live check', () => {
    it('routes access_token and defaults to login (production) environment', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ salesforce: { auth: {} } })),
        liveChecks: { salesforce: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'salesforce',
            authType: 'oauth2_app',
            config: { props: { environment: 'login' } },
          }),
          decryptedSecrets: {},
          oauthAccessToken: 'sf-access-token-xyz',
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'sf-access-token-xyz' }),
          config: expect.objectContaining({ props: { environment: 'login' } }),
        }),
      );
    });

    it('forwards sandbox environment config for test orgs', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ salesforce: { auth: {} } })),
        liveChecks: { salesforce: liveCheck },
      };

      await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'salesforce',
            authType: 'oauth2_app',
            config: { props: { environment: 'test' } },
          }),
          decryptedSecrets: {},
          oauthAccessToken: 'sf-sandbox-token',
        },
        deps,
      );

      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ props: { environment: 'test' } }),
        }),
      );
    });

    it('surfaces rejection as {valid:false}', async () => {
      const liveCheck = vi
        .fn()
        .mockResolvedValue({ valid: false, error: 'Invalid or expired Salesforce token' });
      const deps = {
        ...makeDeps(makeRegistry({ salesforce: { auth: {} } })),
        liveChecks: { salesforce: liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({ connector: 'salesforce', authType: 'oauth2_app' }),
          decryptedSecrets: {},
          oauthAccessToken: 'revoked',
        },
        deps,
      );

      expect(result).toEqual({ valid: false, error: 'Invalid or expired Salesforce token' });
    });
  });

  describe('microsoft-dynamics-365-business-central — environment + cloud routing', () => {
    it('routes access_token with default commercial cloud and Production environment', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-dynamics-365-business-central': { auth: {} } })),
        liveChecks: { 'microsoft-dynamics-365-business-central': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'microsoft-dynamics-365-business-central',
            authType: 'oauth2_app',
            config: { props: { environment: 'Production', cloud: 'login.microsoftonline.com' } },
          }),
          decryptedSecrets: {},
          oauthAccessToken: 'bc-access-token-xyz',
        },
        deps,
      );

      expect(result).toEqual({ valid: true });
      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          secrets: expect.objectContaining({ access_token: 'bc-access-token-xyz' }),
          config: expect.objectContaining({
            props: { environment: 'Production', cloud: 'login.microsoftonline.com' },
          }),
        }),
      );
    });

    it('forwards US Gov cloud config', async () => {
      const liveCheck = vi.fn().mockResolvedValue({ valid: true });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-dynamics-365-business-central': { auth: {} } })),
        liveChecks: { 'microsoft-dynamics-365-business-central': liveCheck },
      };

      await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'microsoft-dynamics-365-business-central',
            authType: 'oauth2_app',
            config: { props: { environment: 'Sandbox', cloud: 'login.microsoftonline.us' } },
          }),
          decryptedSecrets: {},
          oauthAccessToken: 'bc-gov-token',
        },
        deps,
      );

      expect(liveCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            props: { environment: 'Sandbox', cloud: 'login.microsoftonline.us' },
          }),
        }),
      );
    });

    it('surfaces rejection as {valid:false}', async () => {
      const liveCheck = vi
        .fn()
        .mockResolvedValue({ valid: false, error: 'Invalid or expired Business Central token' });
      const deps = {
        ...makeDeps(makeRegistry({ 'microsoft-dynamics-365-business-central': { auth: {} } })),
        liveChecks: { 'microsoft-dynamics-365-business-central': liveCheck },
      };

      const result = await runPieceAuthValidate(
        {
          profile: makeProfile({
            connector: 'microsoft-dynamics-365-business-central',
            authType: 'oauth2_app',
          }),
          decryptedSecrets: {},
          oauthAccessToken: 'expired-token',
        },
        deps,
      );

      expect(result).toEqual({
        valid: false,
        error: 'Invalid or expired Business Central token',
      });
    });
  });
});
