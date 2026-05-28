/**
 * External Agent Registry — fast contract tests.
 *
 * These tests intentionally avoid Runtime server harnesses, MongoMemoryServer,
 * and mock remote HTTP agents. Fast lane coverage owns the registry wire
 * contract, payload masking, protocol values, and injected A2A client selection.
 * Full remote connectivity remains covered by the integration/e2e lanes.
 */

import { describe, expect, it } from 'vitest';
import {
  testExternalAgentConnection,
  type ExternalAgentAuthConfig,
  type NormalizedExternalAgentConfig,
  type TestConnectionDeps,
} from '@agent-platform/shared/repos';
import {
  composeAuthConfigForTest,
  externalAgentCreateBodySchema,
  externalAgentUpdateBodySchema,
  maskExternalAgentResponse,
} from '../routes/external-agents.js';

const FIXED_TIME = '2026-05-09T00:00:00.000Z';

function makeExternalAgentDoc(
  overrides: Partial<NormalizedExternalAgentConfig> = {},
): NormalizedExternalAgentConfig {
  return {
    id: 'agent-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'partner_support',
    displayName: 'Partner Support',
    endpoint: 'https://partner.example.com/a2a',
    protocol: 'a2a',
    authType: 'bearer',
    encryptedAuthConfig: JSON.stringify({ value: 'secret-token' }),
    lastDiscoveredCard: null,
    lastConnectionStatus: null,
    lastConnectionAt: null,
    lastConnectionLatencyMs: null,
    lastConnectionError: null,
    createdBy: 'user-1',
    modifiedBy: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  };
}

function makeConnectionDeps(options: { reject?: Error } = {}) {
  const validatorCalls: Array<{ url: string; allowPrivate?: boolean }> = [];
  const plainClientCalls: string[] = [];
  const authClientCalls: Array<{ baseUrl: string; auth: ExternalAgentAuthConfig }> = [];
  const discoveredClients: unknown[] = [];

  const deps: TestConnectionDeps = {
    createValidator: () => ({
      validate: (url: string, allowPrivate?: boolean) => {
        validatorCalls.push({ url, allowPrivate });
      },
    }),
    createClient: (baseUrl: string) => {
      plainClientCalls.push(baseUrl);
      return { kind: 'plain-client', baseUrl };
    },
    createClientWithAuth: (baseUrl: string, auth: ExternalAgentAuthConfig) => {
      authClientCalls.push({ baseUrl, auth });
      return { kind: 'auth-client', baseUrl, auth };
    },
    discoverAgent: async (params, runtimeDeps) => {
      runtimeDeps.validator.validate(params.endpoint, params.allowPrivate);
      const client = runtimeDeps.createClient(params.endpoint);
      discoveredClients.push(client);
      if (options.reject) {
        throw options.reject;
      }
      return {
        name: 'Partner Support',
        protocolVersion: '0.3.0',
        capabilities: { streaming: true },
      };
    },
  };

  return { deps, validatorCalls, plainClientCalls, authClientCalls, discoveredClients };
}

describe('external agent route request contracts', () => {
  it('accepts A2A and REST registry payloads without contacting a remote endpoint', () => {
    const a2aResult = externalAgentCreateBodySchema.safeParse({
      name: 'partner_support',
      displayName: 'Partner Support',
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'a2a',
      authType: 'bearer',
      authConfig: { value: 'bearer-secret' },
    });
    const restResult = externalAgentCreateBodySchema.safeParse({
      name: 'rest_support',
      endpoint: 'https://partner.example.com/api/messages',
      protocol: 'rest',
      authType: 'api_key',
      authConfig: { value: 'api-key-secret', header: 'X-Agent-Key' },
    });

    expect(a2aResult.success).toBe(true);
    expect(restResult.success).toBe(true);
  });

  it('rejects unsupported protocols and unknown fields at the boundary', () => {
    const badProtocol = externalAgentCreateBodySchema.safeParse({
      name: 'bad_protocol',
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'grpc',
      authType: 'none',
    });
    const unknownField = externalAgentCreateBodySchema.safeParse({
      name: 'unknown_field',
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'a2a',
      authType: 'none',
      token: 'must-not-be-accepted',
    });

    expect(badProtocol.success).toBe(false);
    expect(unknownField.success).toBe(false);
  });

  it('allows credential rotation and explicit credential clearing in PATCH payloads', () => {
    const rotate = externalAgentUpdateBodySchema.safeParse({
      authType: 'api_key',
      authConfig: { value: 'rotated-secret', header: 'X-Rotated-Key' },
    });
    const clear = externalAgentUpdateBodySchema.safeParse({
      authType: 'none',
      authConfig: null,
    });

    expect(rotate.success).toBe(true);
    expect(clear.success).toBe(true);
  });
});

describe('external agent response payload contract', () => {
  it('masks stored credentials while preserving executor-facing fields', () => {
    const view = maskExternalAgentResponse(
      makeExternalAgentDoc({
        encryptedAuthConfig: JSON.stringify({ value: 'secret-token', header: 'X-Agent-Key' }),
        lastDiscoveredCard: { name: 'Partner Support', version: '1.0.0' },
        lastConnectionStatus: 'connected',
        lastConnectionAt: new Date(FIXED_TIME),
        lastConnectionLatencyMs: 12,
      }),
    );
    const rawView = view as unknown as Record<string, unknown>;

    expect(view).toMatchObject({
      id: 'agent-1',
      name: 'partner_support',
      displayName: 'Partner Support',
      endpoint: 'https://partner.example.com/a2a',
      protocol: 'a2a',
      authType: 'bearer',
      authConfigured: true,
      lastConnectionStatus: 'connected',
      lastConnectionAt: FIXED_TIME,
      lastConnectionLatencyMs: 12,
      createdBy: 'user-1',
    });
    expect(rawView.encryptedAuthConfig).toBeUndefined();
    expect(rawView.authConfig).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('secret-token');
  });

  it('preserves REST protocol and reports authConfigured=false for no-auth entries', () => {
    const view = maskExternalAgentResponse(
      makeExternalAgentDoc({
        endpoint: 'https://partner.example.com/api/messages',
        protocol: 'rest',
        authType: 'none',
        encryptedAuthConfig: null,
      }),
    );

    expect(view.protocol).toBe('rest');
    expect(view.authType).toBe('none');
    expect(view.authConfigured).toBe(false);
  });
});

describe('external agent auth config composition', () => {
  it('rebuilds bearer and api_key auth configs from persisted payloads', async () => {
    await expect(
      composeAuthConfigForTest(
        makeExternalAgentDoc({
          authType: 'bearer',
          encryptedAuthConfig: JSON.stringify({ value: 'bearer-secret' }),
        }),
        'tenant-1',
      ),
    ).resolves.toEqual({ type: 'bearer', value: 'bearer-secret' });

    await expect(
      composeAuthConfigForTest(
        makeExternalAgentDoc({
          authType: 'api_key',
          encryptedAuthConfig: JSON.stringify({
            value: 'api-key-secret',
            header: 'X-Agent-Key',
          }),
        }),
        'tenant-1',
      ),
    ).resolves.toEqual({
      type: 'api_key',
      value: 'api-key-secret',
      header: 'X-Agent-Key',
    });
  });

  it('omits auth for no-auth entries and the rollback switch', async () => {
    await expect(
      composeAuthConfigForTest(
        makeExternalAgentDoc({ authType: 'none', encryptedAuthConfig: null }),
        'tenant-1',
      ),
    ).resolves.toBeUndefined();

    const originalEnv = process.env.EXTERNAL_AGENT_TEST_AUTH;
    process.env.EXTERNAL_AGENT_TEST_AUTH = 'false';
    try {
      await expect(
        composeAuthConfigForTest(
          makeExternalAgentDoc({
            authType: 'bearer',
            encryptedAuthConfig: JSON.stringify({ value: 'bearer-secret' }),
          }),
          'tenant-1',
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.EXTERNAL_AGENT_TEST_AUTH;
      } else {
        process.env.EXTERNAL_AGENT_TEST_AUTH = originalEnv;
      }
    }
  });
});

describe('external agent protocol client selection', () => {
  it('uses the injected auth-aware A2A client for bearer test_connection', async () => {
    const { deps, plainClientCalls, authClientCalls, validatorCalls } = makeConnectionDeps();

    const result = await testExternalAgentConnection(
      'https://partner.example.com/a2a',
      'tenant-1',
      false,
      deps,
      { type: 'bearer', value: 'bearer-secret' },
    );

    expect(result.reachable).toBe(true);
    expect(plainClientCalls).toEqual([]);
    expect(authClientCalls).toEqual([
      {
        baseUrl: 'https://partner.example.com/a2a',
        auth: { type: 'bearer', value: 'bearer-secret' },
      },
    ]);
    expect(validatorCalls).toEqual([
      { url: 'https://partner.example.com/a2a', allowPrivate: false },
    ]);
  });

  it('uses the configured api_key header without opening a socket', async () => {
    const { deps, authClientCalls, discoveredClients } = makeConnectionDeps();

    const result = await testExternalAgentConnection(
      'https://partner.example.com/a2a',
      'tenant-1',
      true,
      deps,
      { type: 'api_key', value: 'api-key-secret', header: 'X-Agent-Key' },
    );

    expect(result.reachable).toBe(true);
    expect(authClientCalls).toEqual([
      {
        baseUrl: 'https://partner.example.com/a2a',
        auth: { type: 'api_key', value: 'api-key-secret', header: 'X-Agent-Key' },
      },
    ]);
    expect(discoveredClients).toEqual([
      {
        kind: 'auth-client',
        baseUrl: 'https://partner.example.com/a2a',
        auth: { type: 'api_key', value: 'api-key-secret', header: 'X-Agent-Key' },
      },
    ]);
  });

  it('falls back to the unauthenticated client when no auth config is supplied', async () => {
    const { deps, plainClientCalls, authClientCalls } = makeConnectionDeps();

    const result = await testExternalAgentConnection(
      'https://partner.example.com/a2a',
      'tenant-1',
      false,
      deps,
    );

    expect(result.reachable).toBe(true);
    expect(plainClientCalls).toEqual(['https://partner.example.com/a2a']);
    expect(authClientCalls).toEqual([]);
  });

  it('returns a failed connection result from injected discovery errors', async () => {
    const { deps } = makeConnectionDeps({ reject: new Error('contract failure') });

    const result = await testExternalAgentConnection(
      'https://partner.example.com/a2a',
      'tenant-1',
      false,
      deps,
    );

    expect(result.reachable).toBe(false);
    expect(result.error).toBe('contract failure');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
