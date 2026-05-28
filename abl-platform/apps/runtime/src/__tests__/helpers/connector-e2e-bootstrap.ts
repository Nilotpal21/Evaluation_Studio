/**
 * Connector E2E Bootstrap Helper
 *
 * Wraps RuntimeApiHarness with connector-specific setup for E2E testing of
 * the Connector Connection CRUD and binding lifecycle features.
 *
 * Mounts connection routes and auth routes on a real Express server with
 * full middleware chain (auth, rate limiting, tenant isolation, validation).
 * Registers test connectors in the ConnectorRegistry at bootstrap time.
 *
 * Connections are pure binding records (connectorName + authProfileId).
 * All credential storage is in auth profiles — connections never hold secrets.
 */

import { ConnectorRegistry, ConnectionService } from '@agent-platform/connectors';
import { ConnectorConnection } from '@agent-platform/database/models';
import authRouter from '../../routes/auth.js';
import connectionsRouter, {
  resetConnectionService,
  setConnectionService,
} from '../../routes/connections.js';
import platformAdminTenantsRouter from '../../routes/platform-admin-tenants.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './runtime-api-harness.js';
import {
  authHeaders,
  bootstrapProject,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
  devLogin,
  createTenant,
  createProject,
  addMember,
  type BootstrapProjectResult,
  type ApiResponse,
} from './channel-e2e-bootstrap.js';
// ─── Test Connector Inline ──────────────────────────────────────────────
// The test connector fixtures live in packages/connectors/src/__tests__/fixtures/
// but cannot be imported cross-package at runtime. We define minimal test
// connectors inline using the public Connector type.

import type { Connector, ActionContext } from '@agent-platform/connectors';

const testConnector: Connector = {
  name: 'test-connector',
  displayName: 'Test Connector',
  version: '1.0.0',
  description: 'Test connector for E2E testing',
  auth: {
    type: 'api_key',
    fields: [{ name: 'apiKey', displayName: 'API Key', required: true, sensitive: true }],
  },
  actions: [
    {
      name: 'echo',
      displayName: 'Echo',
      description: 'Echoes input and validates auth',
      props: [{ name: 'message', displayName: 'Message', type: 'string' as const, required: true }],
      async run(ctx: ActionContext) {
        return { echo: ctx.params.message, auth: 'present' };
      },
    },
  ],
  triggers: [],
};

const oauth2TestConnector: Connector = {
  name: 'test-connector-oauth',
  displayName: 'Test Connector OAuth',
  version: '1.0.0',
  description: 'OAuth2 test connector for E2E testing',
  auth: {
    type: 'oauth2',
    oauth2: {
      authorizationUrl: 'http://localhost/oauth/authorize',
      tokenUrl: 'http://localhost/oauth/token',
      scopes: ['read', 'write'],
      pkce: false,
    },
    fields: [{ name: 'clientId', displayName: 'Client ID', required: true, sensitive: true }],
  },
  actions: [
    {
      name: 'echo',
      displayName: 'Echo',
      description: 'Echoes input',
      props: [{ name: 'message', displayName: 'Message', type: 'string' as const, required: true }],
      async run(ctx: ActionContext) {
        return { echo: ctx.params.message, auth: 'present' };
      },
    },
  ],
  triggers: [],
};

// ─── Types ──────────────────────────────────────────────────────────────

export interface ConnectorE2EBootstrap {
  harness: RuntimeApiHarness;
  registry: ConnectorRegistry;
  connectionService: ConnectionService;
  /** Primary context — tenant + project + user with admin permissions */
  primary: BootstrapProjectResult;
  /** Request helpers scoped to primary context */
  get(path: string): Promise<ApiResponse<any>>;
  post(path: string, body?: unknown): Promise<ApiResponse<any>>;
  put(path: string, body?: unknown): Promise<ApiResponse<any>>;
  del(path: string): Promise<ApiResponse<any>>;
  /** Connection-specific convenience methods */
  createConnection(input: {
    connectorName: string;
    displayName: string;
    authProfileId: string;
    scope?: 'tenant' | 'user';
  }): Promise<ApiResponse<any>>;
  listConnections(): Promise<ApiResponse<any>>;
  getConnection(id: string): Promise<ApiResponse<any>>;
  updateConnection(
    id: string,
    input: { displayName?: string; status?: string },
  ): Promise<ApiResponse<any>>;
  deleteConnection(id: string): Promise<ApiResponse<any>>;
  testConnection(id: string): Promise<ApiResponse<any>>;
  /** Create a second tenant context for isolation testing */
  createCrossTenantContext(): Promise<BootstrapProjectResult>;
  /** Request with explicit auth token */
  requestAs(
    token: string,
    projectId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<any>>;
  /** Teardown */
  close(): Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────

export async function createConnectorE2EBootstrap(): Promise<ConnectorE2EBootstrap> {
  // Create connector registry and register test connectors
  const registry = new ConnectorRegistry();
  registry.register(testConnector);
  registry.register(oauth2TestConnector);

  // Reset the singleton so we inject our own
  resetConnectionService();

  const harness = await startRuntimeApiHarness((app) => {
    app.use('/api/auth', authRouter);
    app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
    app.use('/api/projects/:projectId/connections', connectionsRouter);
  });

  // Wrap the Mongoose model to return plain objects (not Mongoose Documents)
  const connectionModel = {
    find(filter: Record<string, unknown>) {
      const q = ConnectorConnection.find(filter);
      return {
        sort(sortOpts: Record<string, number>) {
          return { lean: () => q.sort(sortOpts).lean() };
        },
        lean: () => q.lean(),
      };
    },
    findOne(filter: Record<string, unknown>) {
      return { lean: () => ConnectorConnection.findOne(filter).lean() };
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

  // Connections are pure binding records — no encrypt/decrypt needed.
  // No auth profile resolver for basic CRUD E2E (test-connection will fail
  // gracefully with VALIDATION_ERROR since resolver is not configured).
  const connectionService = new ConnectionService({
    connectionModel: connectionModel as any,
    registry,
  });

  // Inject our ConnectionService into the route singleton
  setConnectionService(connectionService);

  // Bootstrap primary tenant + project
  const primary = await bootstrapProject(
    harness,
    uniqueEmail('connector-e2e-admin'),
    uniqueSlug('tenant-conn'),
    uniqueSlug('project-conn'),
  );

  const connectionsBasePath = `/api/projects/${primary.projectId}/connections`;

  return {
    harness,
    registry,
    connectionService,
    primary,

    async get(path: string) {
      return requestJson(harness, path, {
        method: 'GET',
        headers: authHeaders(primary.token),
      });
    },

    async post(path: string, body?: unknown) {
      return requestJson(harness, path, {
        method: 'POST',
        headers: authHeaders(primary.token),
        body,
      });
    },

    async put(path: string, body?: unknown) {
      return requestJson(harness, path, {
        method: 'PUT',
        headers: authHeaders(primary.token),
        body,
      });
    },

    async del(path: string) {
      return requestJson(harness, path, {
        method: 'DELETE',
        headers: authHeaders(primary.token),
      });
    },

    async createConnection(input) {
      return requestJson(harness, connectionsBasePath, {
        method: 'POST',
        headers: authHeaders(primary.token),
        body: input,
      });
    },

    async listConnections() {
      return requestJson(harness, connectionsBasePath, {
        method: 'GET',
        headers: authHeaders(primary.token),
      });
    },

    async getConnection(id: string) {
      return requestJson(harness, `${connectionsBasePath}/${id}`, {
        method: 'GET',
        headers: authHeaders(primary.token),
      });
    },

    async updateConnection(id: string, input) {
      return requestJson(harness, `${connectionsBasePath}/${id}`, {
        method: 'PUT',
        headers: authHeaders(primary.token),
        body: input,
      });
    },

    async deleteConnection(id: string) {
      return requestJson(harness, `${connectionsBasePath}/${id}`, {
        method: 'DELETE',
        headers: authHeaders(primary.token),
      });
    },

    async testConnection(id: string) {
      return requestJson(harness, `${connectionsBasePath}/${id}/test`, {
        method: 'POST',
        headers: authHeaders(primary.token),
      });
    },

    async createCrossTenantContext(): Promise<BootstrapProjectResult> {
      const login = await devLogin(harness, uniqueEmail('connector-e2e-other'));
      await setSuperAdmins([primary.userId, login.user.id]);

      const tenant = await createTenant(
        harness,
        login.accessToken,
        `Other Tenant`,
        uniqueSlug('tenant-other'),
      );
      const project = await createProject(
        harness,
        login.accessToken,
        tenant._id,
        'Other Project',
        uniqueSlug('project-other'),
      );

      return {
        token: login.accessToken,
        userId: login.user.id,
        tenantId: tenant._id,
        projectId: project._id,
      };
    },

    async requestAs(
      token: string,
      projectId: string,
      method: string,
      path: string,
      body?: unknown,
    ) {
      return requestJson(harness, `/api/projects/${projectId}/${path}`, {
        method,
        headers: authHeaders(token),
        body,
      });
    },

    async close() {
      resetConnectionService();
      await harness.close();
    },
  };
}
