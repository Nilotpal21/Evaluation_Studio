/**
 * Integration Test: Executor → Resolver Chain (INT-2)
 *
 * Tests the full execution chain:
 * ConnectorToolExecutor.execute() → ConnectionResolver.resolve()
 * → ConnectionResolver.resolveAuth() → auth profile resolver
 * → pass credentials to connector action → return result.
 *
 * Uses MongoMemoryServer for real DB, a real ConnectorRegistry with
 * test-connector, and a fake HTTP provider server via
 * startProviderServerHarness().
 *
 * ConnectionResolver delegates credential resolution to an auth profile
 * resolver. Connections are pure binding records with authProfileId.
 *
 * No mocks of codebase components. Only external services (provider HTTP
 * server) are simulated via the provider-server-harness fixture.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import crypto from 'crypto';
import { ConnectorToolExecutor } from '../../executor/connector-tool-executor.js';
import { ConnectionResolver } from '../../auth/connection-resolver.js';
import type {
  ConnectorConnectionModel,
  AuthProfileResolverLike,
} from '../../auth/connection-resolver.js';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectionService } from '../../services/connection-service.js';
import { registerTestConnector } from '../fixtures/test-connector.js';
import { wrapActivepiecesPiece } from '../../adapters/activepieces/runtime-adapter.js';
import {
  startProviderServerHarness,
  type ProviderServerHarness,
} from '../fixtures/provider-server-harness.js';
import { setupIntegrationContext, type IntegrationTestContext } from '../helpers/setup-mongo.js';
import type { IConnectorConnection } from '@agent-platform/database/models';

// ─── Constants ──────────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-exec-chain';
const PROJECT_ID = 'project-exec-chain';
const USER_ID = 'user-exec-chain';
const TIMEOUT_MS = 10_000;

// ─── State ──────────────────────────────────────────────────────────────────

let ctx: IntegrationTestContext;
let mongoAvailable = false;
let providerServer: ProviderServerHarness;

// ─── Auth Profile Resolver (external dependency — OK to provide test impl) ─

/** Test auth profile resolver that returns credentials based on authProfileId */
const authCredentials: Record<string, Record<string, unknown>> = {};

const authProfileResolver: AuthProfileResolverLike = {
  async resolve(opts: { authProfileId: string }) {
    return authCredentials[opts.authProfileId] ?? { apiKey: 'default-key' };
  },
};

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    ctx = await setupIntegrationContext();
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }

  providerServer = await startProviderServerHarness();
}, 30_000);

afterEach(async () => {
  if (mongoAvailable) {
    await ctx.cleanup();
  }
  providerServer.reset();
  // Clear auth credentials between tests
  for (const key of Object.keys(authCredentials)) {
    delete authCredentials[key];
  }
});

afterAll(async () => {
  if (mongoAvailable) {
    await ctx.teardown();
  }
  await providerServer.close();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createResolverModelAdapter(): ConnectorConnectionModel {
  return {
    async findOne(filter: Record<string, unknown>): Promise<IConnectorConnection | null> {
      const result = await ctx.connectionModel.findOne(filter).lean();
      return result as unknown as IConnectorConnection | null;
    },
  };
}

function createExecutor(opts?: { userId?: string }): {
  executor: ConnectorToolExecutor;
  registry: ConnectorRegistry;
  connectionService: ConnectionService;
} {
  const registry = new ConnectorRegistry();
  registerTestConnector(registry);

  const resolverModel = createResolverModelAdapter();
  const connectionResolver = new ConnectionResolver(resolverModel, authProfileResolver);

  const executor = new ConnectorToolExecutor(registry, connectionResolver, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    userId: opts?.userId,
  });

  const connectionService = new ConnectionService({
    connectionModel: ctx.connectionModel,
    registry,
  });

  return { executor, registry, connectionService };
}

async function insertConnectionDirect(
  overrides: Partial<IConnectorConnection> = {},
): Promise<string> {
  const id = crypto.randomUUID();

  await ctx.connectionModel.create({
    _id: id,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    connectorName: 'test-connector',
    displayName: 'Direct Insert Connection',
    scope: 'tenant',
    authProfileId: 'ap-default',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  return id;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('INT-2: Executor → Resolver Chain', () => {
  it('skips if MongoDB unavailable', ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');
  });

  it('executes test-connector.echo through the full chain with auth profile', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor, connectionService } = createExecutor();

    authCredentials['ap-echo'] = { apiKey: 'test-secret-key-123' };

    await connectionService.create(TENANT_ID, PROJECT_ID, {
      connectorName: 'test-connector',
      displayName: 'API Key Connection',
      authProfileId: 'ap-echo',
    });

    providerServer.setResponse('/', {
      status: 200,
      body: { echoed: true, message: 'hello from provider' },
    });

    const result = await executor.execute(
      'test-connector.echo',
      { message: 'hello', providerUrl: `${providerServer.baseUrl}/` },
      TIMEOUT_MS,
    );

    const requests = providerServer.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe('Bearer test-secret-key-123');
    expect(requests[0].body).toEqual({ message: 'hello' });

    expect(result).toEqual({ echoed: true, message: 'hello from provider' });
  });

  it('throws "Action not found" for test-connector.nonexistent', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor, connectionService } = createExecutor();

    await connectionService.create(TENANT_ID, PROJECT_ID, {
      connectorName: 'test-connector',
      displayName: 'Valid Connection',
      authProfileId: 'ap-default',
    });

    await expect(
      executor.execute('test-connector.nonexistent', { message: 'test' }, TIMEOUT_MS),
    ).rejects.toThrow('Action "nonexistent" not found on connector "test-connector"');
  });

  it('throws "Unknown connector" for unknown-connector.echo', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor } = createExecutor();

    await expect(
      executor.execute('unknown-connector.echo', { message: 'test' }, TIMEOUT_MS),
    ).rejects.toThrow('Unknown connector: unknown-connector');
  });

  it('throws when no connection is configured for the tenant', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor } = createExecutor();

    await expect(
      executor.execute('test-connector.echo', { message: 'test' }, TIMEOUT_MS),
    ).rejects.toThrow('No connection configured for this connector');
  });

  it('user-scoped connection takes priority over tenant-scoped', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor } = createExecutor({ userId: USER_ID });

    authCredentials['ap-tenant'] = { apiKey: 'tenant-level-key' };
    authCredentials['ap-user'] = { apiKey: 'user-level-key' };

    await insertConnectionDirect({
      scope: 'tenant',
      authProfileId: 'ap-tenant',
      displayName: 'Tenant Connection',
    } as Partial<IConnectorConnection>);

    await insertConnectionDirect({
      scope: 'user',
      userId: USER_ID,
      authProfileId: 'ap-user',
      displayName: 'User Connection',
    } as Partial<IConnectorConnection>);

    providerServer.setResponse('/', {
      status: 200,
      body: { ok: true },
    });

    await executor.execute(
      'test-connector.echo',
      { message: 'priority-test', providerUrl: `${providerServer.baseUrl}/` },
      TIMEOUT_MS,
    );

    const requests = providerServer.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe('Bearer user-level-key');
  });

  it('executes with explicit connectionId to select a specific connection', async ({ skip }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    const { executor } = createExecutor();

    authCredentials['ap-first'] = { apiKey: 'first-connection-key' };
    authCredentials['ap-second'] = { apiKey: 'second-connection-key' };

    const _firstId = await insertConnectionDirect({
      authProfileId: 'ap-first',
      displayName: 'First Connection',
    } as Partial<IConnectorConnection>);

    const secondId = await insertConnectionDirect({
      authProfileId: 'ap-second',
      displayName: 'Second Connection',
    } as Partial<IConnectorConnection>);

    providerServer.setResponse('/', {
      status: 200,
      body: { selected: true },
    });

    const result = await executor.execute(
      'test-connector.echo',
      { message: 'explicit-id-test', providerUrl: `${providerServer.baseUrl}/` },
      TIMEOUT_MS,
      secondId,
    );

    const requests = providerServer.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe('Bearer second-connection-key');

    expect(result).toEqual({ selected: true });
  });

  it('INT-5: normalizes Zendesk OAuth2 auth through the full executor → resolver → normalizeAuthForAP chain', async ({
    skip,
  }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    let capturedAuth: unknown;
    const stubZendeskModule = {
      zendesk: {
        displayName: 'Zendesk Stub',
        actions: {
          capture_auth: {
            name: 'capture_auth',
            displayName: 'Capture Auth',
            description: 'Returns auth passed by AP context',
            props: {},
            run: async (apCtx: { auth: unknown }) => {
              capturedAuth = apCtx.auth;
              return { captured: true };
            },
          },
        },
        triggers: {},
      },
    };

    const { executor, registry, connectionService } = createExecutor();
    const wrappedZendesk = wrapActivepiecesPiece('zendesk', stubZendeskModule);
    registry.register(wrappedZendesk);

    authCredentials['ap-zendesk-oauth2'] = {
      access_token: 'bearer-123',
      connectionConfig: { subdomain: 'testdomain' },
    };

    await connectionService.create(TENANT_ID, PROJECT_ID, {
      connectorName: 'zendesk',
      displayName: 'Zendesk OAuth2 Connection',
      authProfileId: 'ap-zendesk-oauth2',
    });

    await executor.execute('zendesk.capture_auth', {}, TIMEOUT_MS);

    expect(capturedAuth).toEqual({
      props: { subdomain: 'testdomain', accessToken: 'bearer-123' },
    });
  });

  it('INT-5b: normalizes ServiceNow OAuth2 auth — instanceUrl is built from subdomain', async ({
    skip,
  }) => {
    if (!mongoAvailable) skip('MongoMemoryServer unavailable');

    let capturedAuth: unknown;
    const stubServiceNowModule = {
      serviceNow: {
        displayName: 'ServiceNow Stub',
        actions: {
          capture_auth: {
            name: 'capture_auth',
            displayName: 'Capture Auth',
            description: 'Returns auth passed by AP context',
            props: {},
            run: async (apCtx: { auth: unknown }) => {
              capturedAuth = apCtx.auth;
              return { captured: true };
            },
          },
        },
        triggers: {},
      },
    };

    const { executor, registry, connectionService } = createExecutor();
    const wrappedServiceNow = wrapActivepiecesPiece('servicenow', stubServiceNowModule);
    registry.register(wrappedServiceNow);

    authCredentials['ap-sn-oauth2'] = {
      access_token: 'sn-token-456',
      connectionConfig: { subdomain: 'dev12345' },
    };

    await connectionService.create(TENANT_ID, PROJECT_ID, {
      connectorName: 'servicenow',
      displayName: 'ServiceNow OAuth2 Connection',
      authProfileId: 'ap-sn-oauth2',
    });

    await executor.execute('servicenow.capture_auth', {}, TIMEOUT_MS);

    expect(capturedAuth).toEqual({
      props: {
        instanceUrl: 'https://dev12345.service-now.com',
        accessToken: 'sn-token-456',
      },
    });
  });
});
