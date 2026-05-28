/**
 * Connector Tool Execution E2E Tests (E2E-2 + E2E-7)
 *
 * Tests connector tool execution and scope resolution via HTTP API:
 * - E2E-2: Tool execution with credential decryption through full chain
 * - E2E-7: User-scoped vs tenant-scoped connection resolution
 *
 * Uses real Express server with full middleware chain. Real encryption,
 * real MongoDB, real ConnectionResolver. No mocks of codebase components.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import crypto from 'crypto';
import { type Request, type Response, type Router as RouterType, Router } from 'express';
import {
  ConnectorRegistry,
  ConnectionService,
  ConnectorToolExecutor,
  ConnectionResolver,
} from '@agent-platform/connectors';
import { createAuthProfileResolver } from '@agent-platform/connectors/services';
import type { Connector, ActionContext } from '@agent-platform/connectors';
import type { ConnectorConnectionModel } from '@agent-platform/connectors';
import { AuthProfile, ConnectorConnection } from '@agent-platform/database/models';
import { decryptForTenantAuto, isTenantEncryptionReady } from '@agent-platform/shared/encryption';
import { requireProjectScope } from '@agent-platform/shared-auth';
import authRouter from '../routes/auth.js';
import { authProfileRoutes } from '../routes/auth-profiles.js';
import connectionsRouter, {
  resetConnectionService,
  setConnectionService,
} from '../routes/connections.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import { authMiddleware } from '../middleware/auth.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  devLogin,
  addMember,
  type BootstrapProjectResult,
} from './helpers/channel-e2e-bootstrap.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TIMEOUT = 90_000;

// ─── Credential Tracking ────────────────────────────────────────────────────

/** Records what credentials/scope each action invocation received */
interface CredentialRecord {
  apiKey: string;
  scope: string;
}

const receivedCredentials: CredentialRecord[] = [];

function clearCredentials(): void {
  receivedCredentials.length = 0;
}

// ─── Test Connector (inline) ────────────────────────────────────────────────

function buildTestConnector(connectorName: string): Connector {
  return {
    name: connectorName,
    displayName: `Test Connector ${connectorName}`,
    version: '1.0.0',
    description: 'Test connector for tool execution E2E',
    auth: {
      type: 'api_key',
      fields: [
        {
          name: 'apiKey',
          displayName: 'API Key',
          required: true,
          sensitive: true,
        },
      ],
    },
    actions: [
      {
        name: 'echo',
        displayName: 'Echo',
        description: 'Echoes input and records credentials',
        props: [
          {
            name: 'message',
            displayName: 'Message',
            type: 'string' as const,
            required: true,
          },
        ],
        async run(ctx: ActionContext) {
          receivedCredentials.push({
            apiKey: (ctx.auth as Record<string, unknown>)?.apiKey as string,
            scope: ctx.connectionScope || 'unknown',
          });
          return { echo: ctx.params.message, hasAuth: !!ctx.auth };
        },
      },
    ],
    triggers: [],
  };
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Connector Tool Execution E2E', () => {
  let harness: RuntimeApiHarness;
  let primary: BootstrapProjectResult;
  let registry: ConnectorRegistry;
  let connectionResolver: ConnectionResolver;

  beforeAll(async () => {
    // Create registry used by injected routes and executor
    registry = new ConnectorRegistry();

    // Reset route singleton for injection
    resetConnectionService();

    // Build tool-execute route
    const toolExecuteRouter: RouterType = Router({ mergeParams: true });
    toolExecuteRouter.use(authMiddleware);
    toolExecuteRouter.use(requireProjectScope('projectId'));

    toolExecuteRouter.post('/', async (req: Request, res: Response) => {
      const { projectId } = req.params;
      const tenantId = req.tenantContext?.tenantId || '';
      const userId = req.tenantContext?.userId || '';
      const { toolName, params, connectionId } = req.body;

      if (!toolName || typeof toolName !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'toolName is required' },
        });
        return;
      }

      const executor = new ConnectorToolExecutor(registry, connectionResolver, {
        tenantId,
        projectId,
        userId: userId || undefined,
      });

      try {
        const result = await executor.execute(
          toolName,
          (params as Record<string, unknown>) || {},
          30_000,
          connectionId as string | undefined,
        );
        res.json({ success: true, data: result });
      } catch (err) {
        res.status(400).json({
          success: false,
          error: {
            code: 'EXECUTION_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });

    // Start harness with all needed routes
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/auth-profiles', authMiddleware, authProfileRoutes);
      app.use('/api/projects/:projectId/connections', connectionsRouter);
      app.use('/api/projects/:projectId/tools/execute', toolExecuteRouter);
    });

    if (!isTenantEncryptionReady()) {
      throw new Error('Tenant encryption not available in test environment');
    }

    const authProfileResolver = createAuthProfileResolver({
      authProfileModel: AuthProfile as any,
      decrypt: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
    });

    // Mongoose model wrapper for ConnectionService (returns POJOs)
    const connectionModel = {
      find(filter: Record<string, unknown>) {
        return ConnectorConnection.find(filter) as any;
      },
      async findOne(filter: Record<string, unknown>) {
        return ConnectorConnection.findOne(filter).lean();
      },
      async create(data: Record<string, unknown>) {
        const doc = await ConnectorConnection.create(data);
        return doc.toObject();
      },
      async findOneAndUpdate(
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) {
        return ConnectorConnection.findOneAndUpdate(filter, update, {
          ...options,
          new: true,
        }).lean();
      },
      async findOneAndDelete(filter: Record<string, unknown>) {
        return ConnectorConnection.findOneAndDelete(filter).lean();
      },
    };

    // Inject ConnectionService into connection routes
    setConnectionService(
      new ConnectionService({
        connectionModel: connectionModel as any,
        authProfileResolver,
        registry,
      }),
    );

    // Build ConnectionResolver for the tool executor
    const resolverModel: ConnectorConnectionModel = {
      async findOne(filter: Record<string, unknown>) {
        return ConnectorConnection.findOne(filter).lean() as any;
      },
    };

    connectionResolver = new ConnectionResolver(resolverModel, authProfileResolver);

    // Bootstrap primary tenant + project
    primary = await bootstrapProject(
      harness,
      uniqueEmail('tool-exec-admin'),
      uniqueSlug('tenant-tool'),
      uniqueSlug('project-tool'),
    );
  }, TIMEOUT);

  afterAll(async () => {
    resetConnectionService();
    await harness?.close();
  }, TIMEOUT);

  // ─── Helpers ────────────────────────────────────────────────────────────

  function connectionsPath(): string {
    return `/api/projects/${primary.projectId}/connections`;
  }

  function toolExecutePath(): string {
    return `/api/projects/${primary.projectId}/tools/execute`;
  }

  function registerTestConnector(label: string): string {
    const connectorName = `test-connector-${label}-${crypto.randomUUID().slice(0, 8)}`;
    registry.register(buildTestConnector(connectorName));
    return connectorName;
  }

  async function createAuthProfileViaApi(input: { apiKey: string; connectorName: string }) {
    const response = await requestJson<any>(harness, '/api/auth-profiles', {
      method: 'POST',
      headers: authHeaders(primary.token),
      body: {
        name: `${input.connectorName}-profile-${crypto.randomUUID().slice(0, 8)}`,
        authType: 'api_key',
        scope: 'tenant',
        visibility: 'shared',
        config: {
          headerName: 'Authorization',
        },
        connector: input.connectorName,
        secrets: { apiKey: input.apiKey },
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    return response.body.data.id as string;
  }

  async function createConnectionViaApiAs(
    token: string,
    input: {
      connectorName: string;
      displayName: string;
      authProfileId: string;
      scope?: 'tenant' | 'user';
    },
  ) {
    return requestJson<any>(harness, connectionsPath(), {
      method: 'POST',
      headers: authHeaders(token),
      body: input,
    });
  }

  async function createConnectionViaApi(input: {
    connectorName: string;
    displayName: string;
    scope?: 'tenant' | 'user';
    authProfileId: string;
  }) {
    return createConnectionViaApiAs(primary.token, input);
  }

  async function deleteConnectionViaApi(connectionId: string) {
    return requestJson<any>(harness, `${connectionsPath()}/${connectionId}`, {
      method: 'DELETE',
      headers: authHeaders(primary.token),
    });
  }

  async function executeTool(body: {
    toolName: string;
    params?: Record<string, unknown>;
    connectionId?: string;
  }) {
    return requestJson<any>(harness, toolExecutePath(), {
      method: 'POST',
      headers: authHeaders(primary.token),
      body,
    });
  }

  async function executeToolAs(
    token: string,
    projectId: string,
    body: { toolName: string; params?: Record<string, unknown>; connectionId?: string },
  ) {
    return requestJson<any>(harness, `/api/projects/${projectId}/tools/execute`, {
      method: 'POST',
      headers: authHeaders(token),
      body,
    });
  }

  // ─── E2E-2: Tool Execution Through HTTP ─────────────────────────────────

  describe('E2E-2: Connector Tool Execution', () => {
    test('executes tool through full chain: registry -> resolve -> decrypt -> action', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('full-chain');
      const authProfileId = await createAuthProfileViaApi({
        apiKey: 'test-secret-key-e2e',
        connectorName,
      });

      // Step 1: Create a connection binding with auth profile via HTTP
      const createRes = await createConnectionViaApi({
        connectorName,
        displayName: 'Tool Exec Connection',
        authProfileId,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);

      // Step 2: Execute tool via HTTP
      const execRes = await executeTool({
        toolName: `${connectorName}.echo`,
        params: { message: 'hello-e2e' },
      });

      expect(execRes.status).toBe(200);
      expect(execRes.body.success).toBe(true);
      expect(execRes.body.data.echo).toBe('hello-e2e');
      expect(execRes.body.data.hasAuth).toBe(true);

      // Step 3: Verify the action received the correct decrypted credentials
      expect(receivedCredentials).toHaveLength(1);
      expect(receivedCredentials[0].apiKey).toBe('test-secret-key-e2e');
    });

    test('returns error for unknown tool name', async () => {
      clearCredentials();

      const execRes = await executeTool({
        toolName: 'unknown-connector.echo',
        params: { message: 'test' },
      });

      expect(execRes.status).toBe(400);
      expect(execRes.body.success).toBe(false);
      expect(execRes.body.error.code).toBe('EXECUTION_ERROR');
      expect(execRes.body.error.message).toContain('Unknown connector');
    });

    test('returns error for invalid tool name format (no dot separator)', async () => {
      clearCredentials();

      const execRes = await executeTool({
        toolName: 'invalidtoolname',
        params: { message: 'test' },
      });

      expect(execRes.status).toBe(400);
      expect(execRes.body.success).toBe(false);
      expect(execRes.body.error.code).toBe('EXECUTION_ERROR');
      expect(execRes.body.error.message).toContain('expected format');
    });

    test('returns error for unknown action on known connector', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('unknown-action');

      const execRes = await executeTool({
        toolName: `${connectorName}.nonexistent`,
        params: { message: 'test' },
      });

      expect(execRes.status).toBe(400);
      expect(execRes.body.success).toBe(false);
      expect(execRes.body.error.code).toBe('EXECUTION_ERROR');
      expect(execRes.body.error.message).toContain('Action "nonexistent" not found');
    });

    test('returns error when toolName is missing from request body', async () => {
      const execRes = await requestJson<any>(harness, toolExecutePath(), {
        method: 'POST',
        headers: authHeaders(primary.token),
        body: { params: { message: 'test' } },
      });

      expect(execRes.status).toBe(400);
      expect(execRes.body.success).toBe(false);
      expect(execRes.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('requires authentication', async () => {
      const execRes = await requestJson<any>(harness, toolExecutePath(), {
        method: 'POST',
        body: { toolName: 'test-connector.echo', params: { message: 'test' } },
      });

      // Should be 401 without auth token
      expect(execRes.status).toBe(401);
    });
  });

  // ─── E2E-7: Scope Resolution ────────────────────────────────────────────

  describe('E2E-7: Scope Resolution', () => {
    test('user-scoped connection takes priority over tenant-scoped', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('scope-priority');
      const tenantAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'tenant-key-scope-test',
        connectorName,
      });
      const userAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'user-key-scope-test',
        connectorName,
      });

      // Step 1: Create tenant-scoped connection via HTTP
      const tenantConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'Tenant Scoped Connection',
        scope: 'tenant',
        authProfileId: tenantAuthProfileId,
      });
      expect(tenantConnection.status).toBe(201);
      expect(tenantConnection.body.success).toBe(true);

      // Step 2: Create user-scoped connection via HTTP as the primary user
      const userConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'User Scoped Connection',
        scope: 'user',
        authProfileId: userAuthProfileId,
      });
      expect(userConnection.status).toBe(201);
      expect(userConnection.body.success).toBe(true);

      // Step 3: Execute tool — should use user-scoped connection
      const execRes = await executeTool({
        toolName: `${connectorName}.echo`,
        params: { message: 'scope-priority-test' },
      });

      expect(execRes.status).toBe(200);
      expect(execRes.body.success).toBe(true);
      expect(execRes.body.data.echo).toBe('scope-priority-test');

      // Step 4: Verify user-key was used (not tenant-key)
      expect(receivedCredentials.length).toBeGreaterThanOrEqual(1);
      const lastCred = receivedCredentials[receivedCredentials.length - 1];
      expect(lastCred.apiKey).toBe('user-key-scope-test');
      expect(lastCred.scope).toBe('user');
    });

    test('falls back to tenant-scoped when no user-scoped connection exists', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('tenant-fallback');

      // Create a second user in the same tenant/project
      const secondLogin = await devLogin(harness, uniqueEmail('tool-exec-second'));
      await setSuperAdmins([primary.userId, secondLogin.user.id]);
      await addMember(harness, primary.token, primary.tenantId, secondLogin.user.email, 'ADMIN');

      const tenantAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'tenant-key-fallback',
        connectorName,
      });
      const primaryUserAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'primary-user-key-fallback',
        connectorName,
      });

      const tenantConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'Tenant Fallback Connection',
        scope: 'tenant',
        authProfileId: tenantAuthProfileId,
      });
      expect(tenantConnection.status).toBe(201);
      expect(tenantConnection.body.success).toBe(true);

      const primaryUserConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'Primary User Scoped Connection',
        scope: 'user',
        authProfileId: primaryUserAuthProfileId,
      });
      expect(primaryUserConnection.status).toBe(201);
      expect(primaryUserConnection.body.success).toBe(true);

      // Execute tool as the second user — should fall back to tenant-scoped
      const execRes = await executeToolAs(secondLogin.accessToken, primary.projectId, {
        toolName: `${connectorName}.echo`,
        params: { message: 'fallback-test' },
      });

      expect(execRes.status).toBe(200);
      expect(execRes.body.success).toBe(true);
      expect(execRes.body.data.echo).toBe('fallback-test');

      // Verify tenant-scope was used, not the primary user's user-scoped connection
      const lastCred = receivedCredentials[receivedCredentials.length - 1];
      expect(lastCred.apiKey).toBe('tenant-key-fallback');
      expect(lastCred.scope).toBe('tenant');
    });

    test('falls back to tenant-scoped after user-scoped connection is deleted', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('delete-fallback');
      const tenantKey = 'tenant-key-delete-test';
      const tenantAuthProfileId = await createAuthProfileViaApi({
        apiKey: tenantKey,
        connectorName,
      });
      const userAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'user-key-delete-test',
        connectorName,
      });

      const tenantConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'Tenant Connection For Delete Test',
        scope: 'tenant',
        authProfileId: tenantAuthProfileId,
      });
      expect(tenantConnection.status).toBe(201);
      expect(tenantConnection.body.success).toBe(true);

      const userConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'User Connection To Delete',
        scope: 'user',
        authProfileId: userAuthProfileId,
      });
      expect(userConnection.status).toBe(201);
      expect(userConnection.body.success).toBe(true);

      // Execute — should use user-scoped connection
      const execRes1 = await executeTool({
        toolName: `${connectorName}.echo`,
        params: { message: 'before-delete' },
      });
      expect(execRes1.status).toBe(200);
      const cred1 = receivedCredentials[receivedCredentials.length - 1];
      expect(cred1.apiKey).toBe('user-key-delete-test');
      expect(cred1.scope).toBe('user');

      // Delete the user-scoped connection
      const deleteRes = await deleteConnectionViaApi(userConnection.body.data._id as string);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Execute again — should fall back to tenant-scoped
      clearCredentials();
      const execRes2 = await executeTool({
        toolName: `${connectorName}.echo`,
        params: { message: 'after-delete' },
      });
      expect(execRes2.status).toBe(200);
      expect(execRes2.body.data.echo).toBe('after-delete');

      const cred2 = receivedCredentials[receivedCredentials.length - 1];
      expect(cred2.apiKey).toBe(tenantKey);
      expect(cred2.scope).toBe('tenant');
    });

    test('different users see their own user-scoped connections', async () => {
      clearCredentials();
      const connectorName = registerTestConnector('different-users');

      // Create a third user in the same tenant
      const thirdLogin = await devLogin(harness, uniqueEmail('tool-exec-third'));
      await setSuperAdmins([primary.userId, thirdLogin.user.id]);
      await addMember(harness, primary.token, primary.tenantId, thirdLogin.user.email, 'ADMIN');

      const primaryAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'primary-user-key',
        connectorName,
      });
      const thirdAuthProfileId = await createAuthProfileViaApi({
        apiKey: 'third-user-key',
        connectorName,
      });

      const primaryConnection = await createConnectionViaApi({
        connectorName,
        displayName: 'Primary User Connection',
        scope: 'user',
        authProfileId: primaryAuthProfileId,
      });
      expect(primaryConnection.status).toBe(201);
      expect(primaryConnection.body.success).toBe(true);

      const thirdConnection = await createConnectionViaApiAs(thirdLogin.accessToken, {
        connectorName,
        displayName: 'Third User Connection',
        scope: 'user',
        authProfileId: thirdAuthProfileId,
      });
      expect(thirdConnection.status).toBe(201);
      expect(thirdConnection.body.success).toBe(true);

      // Execute as primary user — should see primary-user-key
      const execRes1 = await executeTool({
        toolName: `${connectorName}.echo`,
        params: { message: 'primary-exec' },
      });
      expect(execRes1.status).toBe(200);
      const cred1 = receivedCredentials[receivedCredentials.length - 1];
      expect(cred1.apiKey).toBe('primary-user-key');
      expect(cred1.scope).toBe('user');

      // Execute as third user — should see third-user-key
      clearCredentials();
      const execRes2 = await executeToolAs(thirdLogin.accessToken, primary.projectId, {
        toolName: `${connectorName}.echo`,
        params: { message: 'third-exec' },
      });
      expect(execRes2.status).toBe(200);
      const cred2 = receivedCredentials[receivedCredentials.length - 1];
      expect(cred2.apiKey).toBe('third-user-key');
      expect(cred2.scope).toBe('user');
    });
  });
});
