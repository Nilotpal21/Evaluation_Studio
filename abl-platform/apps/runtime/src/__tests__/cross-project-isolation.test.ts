/**
 * Cross-Project Isolation Tests
 *
 * Verifies that the requireProjectScope middleware prevents users with
 * API key project scoping from accessing resources in other projects.
 *
 * When tenantContext.projectScope is set (e.g., from an API key scoped
 * to specific projects), the middleware checks the route's :projectId
 * param against the allowed list.
 *
 * Strategy:
 * - Inject tenantContext with projectScope: ['project-A']
 * - Request resources for project-B → expect 403
 * - Request resources for project-A → expect non-403
 */

import { describe, test, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// =============================================================================
// MOCKS — declared before route imports
// =============================================================================

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// DO NOT mock @agent-platform/shared — use real requireProjectScope

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi
    .fn()
    .mockResolvedValue({ _id: 'project-A', tenantId: 'tenant-A', ownerId: 'api-key-user' }),
  findProjectMember: vi.fn().mockResolvedValue(null),
  findProjectAgentsForProject: vi.fn().mockResolvedValue([]),
  findProjectAgentForProject: vi.fn().mockResolvedValue({ agentName: 'test-agent' }),
  findAgentVersion: vi.fn().mockResolvedValue(null),
  findAgentModelConfig: vi.fn().mockResolvedValue(null),
  upsertAgentModelConfig: vi.fn().mockResolvedValue({ _id: 'config-1' }),
  updateProjectAgentDsl: vi.fn().mockResolvedValue(null),
}));

vi.mock('../repos/deployment-repo.js', () => ({
  findDeploymentById: vi.fn().mockResolvedValue(null),
  findActiveDeployment: vi.fn().mockResolvedValue(null),
  listDeployments: vi.fn().mockResolvedValue([]),
  createDeployment: vi.fn().mockResolvedValue({ id: 'deploy-1' }),
  updateDeploymentStatus: vi.fn(),
  countLinkedChannels: vi.fn().mockResolvedValue(0),
}));

vi.mock('../repos/channel-repo.js', () => ({
  findPublicApiKey: vi.fn().mockResolvedValue(null),
  createSDKChannel: vi.fn().mockResolvedValue({ _id: 'ch-1' }),
  findSDKChannels: vi.fn().mockResolvedValue([]),
  findSDKChannelById: vi.fn().mockResolvedValue(null),
  updateSDKChannel: vi.fn().mockResolvedValue(null),
  deleteSDKChannel: vi.fn().mockResolvedValue(true),
  bulkUpdateChannelDeployment: vi.fn().mockResolvedValue(0),
}));

vi.mock('@agent-platform/shared/encryption', () => ({
  getEncryptionService: vi.fn(() => ({
    encryptForTenant: vi.fn(() => 'encrypted'),
    decryptForTenant: vi.fn(() => 'decrypted'),
  })),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('../repos/security-repo.js', () => ({
  createEnvironmentVariable: vi.fn().mockResolvedValue({ _id: 'env-1' }),
  findEnvironmentVariables: vi.fn().mockResolvedValue([]),
  countEnvironmentVariables: vi.fn().mockResolvedValue(0),
  findEnvironmentVariableById: vi.fn().mockResolvedValue(null),
  findEnvironmentVariableByKey: vi.fn().mockResolvedValue(null),
  updateEnvironmentVariable: vi.fn().mockResolvedValue(null),
  deleteEnvironmentVariable: vi.fn().mockResolvedValue(true),
  bulkUpsertEnvironmentVariables: vi.fn().mockResolvedValue({ created: 0, updated: 0 }),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/version-service.js', () => ({
  VersionService: { validateDslContent: vi.fn().mockResolvedValue({ valid: true }) },
  safeParseJSON: vi.fn(() => null),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditDslUpdated: vi.fn().mockResolvedValue(undefined),
}));

// validateAgentName is imported from @agent-platform/shared (main export)
// No separate mock needed — it's preserved by not mocking @agent-platform/shared

// =============================================================================
// IMPORTS
// =============================================================================

import express from 'express';

// =============================================================================
// HELPERS
// =============================================================================

async function createScopedServer(
  projectScope: string[],
  mountFn: (app: express.Express) => Promise<void>,
): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext('tenant-A', 'api-key-user', 'OWNER', {
    projectScope,
  });
  app.use(injectTenantContext(ctx));
  await mountFn(app);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  opts?: { body?: any },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// TESTS: Channels — cross-project
// =============================================================================

describe('Cross-project isolation — Channels', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createScopedServer(['project-A'], async (app) => {
      const router = (await import('../routes/sdk-channels.js')).default;
      app.use('/api/projects/:projectId/sdk-channels', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET for project-A passes (in scope)', async () => {
    const { status } = await req(baseUrl, 'GET', '/api/projects/project-A/sdk-channels');
    expect(status).not.toBe(403);
  });

  test('GET for project-B returns 403 (out of scope)', async () => {
    const { status, body } = await req(baseUrl, 'GET', '/api/projects/project-B/sdk-channels');
    expect(status).toBe(403);
    expect(body.message).toBe('API key does not have access to this project');
  });

  test('POST for project-B returns 403 (out of scope)', async () => {
    const { status, body } = await req(baseUrl, 'POST', '/api/projects/project-B/sdk-channels', {
      body: { name: 'hijack-channel' },
    });
    expect(status).toBe(403);
    expect(body.message).toBe('API key does not have access to this project');
  });
});

// =============================================================================
// TESTS: Environment Variables — cross-project
// =============================================================================

describe('Cross-project isolation — Environment Variables', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createScopedServer(['project-A'], async (app) => {
      const router = (await import('../routes/environment-variables.js')).default;
      app.use('/api/projects/:projectId/env-vars', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET for project-A passes (in scope)', async () => {
    const { status } = await req(baseUrl, 'GET', '/api/projects/project-A/env-vars');
    expect(status).not.toBe(403);
  });

  test('GET for project-B returns 403 (out of scope)', async () => {
    const { status, body } = await req(baseUrl, 'GET', '/api/projects/project-B/env-vars');
    expect(status).toBe(403);
    expect(body.message).toBe('API key does not have access to this project');
  });

  test('POST for project-B returns 403 (out of scope)', async () => {
    const { status, body } = await req(baseUrl, 'POST', '/api/projects/project-B/env-vars', {
      body: { key: 'HIJACK_KEY', value: 'stolen', environment: 'dev' },
    });
    expect(status).toBe(403);
    expect(body.message).toBe('API key does not have access to this project');
  });
});

// =============================================================================
// TESTS: Project Agents — cross-project
// =============================================================================

describe('Cross-project isolation — Project Agents', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const result = await createScopedServer(['project-A'], async (app) => {
      const router = (await import('../routes/project-agents.js')).default;
      app.use('/api/projects/:projectId/agents', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET for project-A passes (in scope)', async () => {
    const { status } = await req(baseUrl, 'GET', '/api/projects/project-A/agents');
    expect(status).not.toBe(403);
  });

  test('GET for project-B returns 403 (out of scope)', async () => {
    const { status, body } = await req(baseUrl, 'GET', '/api/projects/project-B/agents');
    expect(status).toBe(403);
    expect(body.message).toBe('API key does not have access to this project');
  });
});

// =============================================================================
// TESTS: Non-scoped context passes through
// =============================================================================

describe('Cross-project isolation — Non-scoped context passes through', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // No projectScope set — should pass through
    const result = await createScopedServer([], async (app) => {
      const router = (await import('../routes/sdk-channels.js')).default;
      app.use('/api/projects/:projectId/sdk-channels', router);
    });
    server = result.server;
    baseUrl = result.baseUrl;
  });

  afterAll(() => server?.close());
  beforeEach(() => vi.clearAllMocks());

  test('GET for any project passes when no projectScope is set', async () => {
    const { status } = await req(baseUrl, 'GET', '/api/projects/any-project/sdk-channels');
    expect(status).not.toBe(403);
  });
});
