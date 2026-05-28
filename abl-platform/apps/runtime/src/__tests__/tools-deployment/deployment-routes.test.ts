/**
 * Deployment Route Integration Tests
 *
 * Mounts the deployments router on a real Express app and exercises
 * all 5 endpoints via Node's built-in fetch against an http.createServer listener.
 *
 * Endpoints under test:
 *   POST   /api/projects/:projectId/deployments           — create deployment
 *   GET    /api/projects/:projectId/deployments            — list deployments
 *   GET    /api/projects/:projectId/deployments/:id        — get deployment detail
 *   POST   /api/projects/:projectId/deployments/:id/retire — retire deployment
 *   POST   /api/projects/:projectId/deployments/:id/rollback — rollback deployment
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

const mockFindProjectByIdAndTenant = vi.fn();
const mockFindProjectAgentsForProject = vi.fn();
const mockFindAgentVersion = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();

vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: (...args: any[]) => mockFindProjectByIdAndTenant(...args),
  findProjectAgentsForProject: (...args: any[]) => mockFindProjectAgentsForProject(...args),
  findAgentVersion: (...args: any[]) => mockFindAgentVersion(...args),
  findProjectAgentForProject: vi.fn(),
  loadConfigVariablesMap: (...args: any[]) => mockLoadConfigVariablesMap(...args),
}));

const mockFindActiveDeployment = vi.fn();
const mockFindDeploymentById = vi.fn();
const mockListDeployments = vi.fn();
const mockCreateDeployment = vi.fn();
const mockUpdateDeploymentStatus = vi.fn();
const mockCountLinkedChannels = vi.fn();
const mockRetirePreviousActiveDeployment = vi.fn().mockResolvedValue(null);
const mockRunPreflightValidation = vi.fn();
const mockBuildDeploymentModuleSnapshot = vi.fn();
const mockCloneDeploymentModuleSnapshot = vi.fn();
const mockGetRedisClient = vi.fn();
const mockCacheCompilationOutput = vi.fn();
const mockCacheAgentIR = vi.fn();
const mockVersionServiceInstance = {
  nextVersion: vi.fn(),
  createVersion: vi.fn(),
};

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: any[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: any[]) => mockFindDeploymentById(...args),
  listDeployments: (...args: any[]) => mockListDeployments(...args),
  createDeployment: (...args: any[]) => mockCreateDeployment(...args),
  updateDeploymentStatus: (...args: any[]) => mockUpdateDeploymentStatus(...args),
  countLinkedChannels: (...args: any[]) => mockCountLinkedChannels(...args),
  retirePreviousActiveDeployment: (...args: any[]) => mockRetirePreviousActiveDeployment(...args),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  bulkUpdateChannelDeployment: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requireWriteAccess: vi.fn(async () => true),
  requirePermissionInline: vi.fn(() => true),
  requireProjectPermission: vi.fn(async () => true),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AGENT_NAME_MAX_LENGTH: 100,
  AGENT_NAME_PATTERN: /^[A-Za-z][A-Za-z0-9_]*$/,
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getCurrentRequestId: vi.fn(() => 'req-test-1'),
  validateAgentName: vi.fn(() => null),
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireAuth: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
  requireProjectScope: vi
    .fn()
    .mockImplementation(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../services/preflight-validation-service.js', () => ({
  runPreflightValidation: (...args: any[]) => mockRunPreflightValidation(...args),
}));

vi.mock('../../services/version-service.js', () => ({
  getVersionService: vi.fn(() => mockVersionServiceInstance),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: (...args: any[]) => mockGetRedisClient(...args),
}));

vi.mock('../../services/modules/deployment-build-service.js', () => ({
  buildDeploymentModuleSnapshot: (...args: any[]) => mockBuildDeploymentModuleSnapshot(...args),
  cloneDeploymentModuleSnapshot: (...args: any[]) => mockCloneDeploymentModuleSnapshot(...args),
}));

vi.mock('../../services/snapshot-service.js', () => ({
  createDeploymentSnapshot: vi.fn().mockResolvedValue({ id: 'snap-1', _id: 'snap-1' }),
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn().mockReturnValue({
    cacheCompilationOutput: (...args: any[]) => mockCacheCompilationOutput(...args),
    cacheAgentIR: (...args: any[]) => mockCacheAgentIR(...args),
  }),
}));

vi.mock('../../repos/security-repo.js', () => ({
  loadEnvironmentVariables: vi.fn().mockResolvedValue([]),
  findEnvironmentVariables: vi.fn().mockResolvedValue([]),
}));

const mockDeploymentVariableSnapshotDeleteOne = vi.fn().mockResolvedValue({});
const mockDeploymentModuleSnapshotDeleteOne = vi.fn().mockResolvedValue({});
const mockDeploymentModelUpdateOne = vi.fn().mockResolvedValue({});
const mockDeploymentModelDeleteOne = vi.fn().mockResolvedValue({});
const mockProjectModelFindOne = vi.fn();
const mockProjectToolModelFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();
const mockRouteLogError = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  DeploymentVariableSnapshot: {
    deleteOne: (...args: any[]) => mockDeploymentVariableSnapshotDeleteOne(...args),
  },
  DeploymentModuleSnapshot: {
    deleteOne: (...args: any[]) => mockDeploymentModuleSnapshotDeleteOne(...args),
  },
  Deployment: {
    updateOne: (...args: any[]) => mockDeploymentModelUpdateOne(...args),
    deleteOne: (...args: any[]) => mockDeploymentModelDeleteOne(...args),
  },
  Project: {
    findOne: (...args: any[]) => mockProjectModelFindOne(...args),
  },
  ProjectTool: {
    find: (...args: any[]) => mockProjectToolModelFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: any[]) => ({
      lean: () => mockProjectRuntimeConfigFindOne(...args),
    }),
  },
  ProjectLLMConfig: {
    findOne: (...args: any[]) => ({
      lean: () => mockProjectLLMConfigFindOne(...args),
    }),
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockRouteLogError(...args),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';
import { requireWriteAccess } from '../../middleware/rbac.js';

let baseUrl: string;
let server: http.Server;
const fakeRedisLockClient = {
  set: vi.fn(),
  eval: vi.fn(),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Inject tenantContext for every request
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1', permissions: ['*:*'] };
    req.user = { id: 'user-1', email: 'test@test.com' };
    next();
  });

  const deploymentsRouter = (await import('../../routes/deployments.js')).default;
  app.use('/api/projects/:projectId/deployments', deploymentsRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireWriteAccess).mockResolvedValue(true);
  mockVersionServiceInstance.nextVersion.mockResolvedValue('0.2.0');
  mockVersionServiceInstance.createVersion.mockResolvedValue({
    version: '0.2.0',
    versionId: 'ver-auto-1',
    sourceHash: 'hash-auto-1',
    deduplicated: false,
  });
  mockRunPreflightValidation.mockResolvedValue({
    status: 'ready',
    agents: [],
    summary: {
      total: 0,
      passed: 0,
      warnings: 0,
      errors: 0,
      canonicalIssues: [],
    },
  });
  mockBuildDeploymentModuleSnapshot.mockResolvedValue(null);
  mockCloneDeploymentModuleSnapshot.mockResolvedValue(null);
  mockGetRedisClient.mockReturnValue(fakeRedisLockClient);
  mockLoadConfigVariablesMap.mockResolvedValue({});
  mockCacheCompilationOutput.mockResolvedValue('compilation-hash-1');
  mockCacheAgentIR.mockResolvedValue(undefined);
  mockProjectModelFindOne.mockReturnValue({
    lean: () => Promise.resolve({ _id: 'proj-1', moduleDependencyVersion: 0 }),
  });
  mockProjectToolModelFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
  mockProjectRuntimeConfigFindOne.mockResolvedValue(null);
  mockProjectLLMConfigFindOne.mockResolvedValue(null);
});

// =============================================================================
// HELPERS
// =============================================================================

async function request(method: string, path: string, opts?: { body?: any }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

const DEPLOYS_BASE = '/api/projects/proj-1/deployments';

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deploy-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'staging',
    status: 'active',
    label: 'v1 staging',
    description: 'First staging deployment',
    endpointSlug: 'proj-1-staging-abc123',
    entryAgentName: 'booking_agent',
    agentVersionManifest: { booking_agent: '0.1.0' },
    compilationHash: null,
    previousDeploymentId: null,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Deployment Routes', () => {
  // ---------------------------------------------------------------------------
  // GET / — list deployments
  // ---------------------------------------------------------------------------
  describe('GET / (list deployments)', () => {
    test('returns 200 with deployments list', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockListDeployments.mockResolvedValue([makeDeployment()]);

      const { status, body } = await request('GET', DEPLOYS_BASE);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deployments).toHaveLength(1);
      expect(body.deployments[0].environment).toBe('staging');
    });

    test('returns empty list when no deployments', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockListDeployments.mockResolvedValue([]);

      const { status, body } = await request('GET', DEPLOYS_BASE);

      expect(status).toBe(200);
      expect(body.deployments).toHaveLength(0);
    });

    test('passes environment filter to repo', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockListDeployments.mockResolvedValue([]);

      await request('GET', `${DEPLOYS_BASE}?environment=production`);

      expect(mockListDeployments).toHaveBeenCalledWith('proj-1', 'tenant-1', {
        environment: 'production',
        status: undefined,
      });
    });

    test('passes status filter to repo', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockListDeployments.mockResolvedValue([]);

      await request('GET', `${DEPLOYS_BASE}?status=draining`);

      expect(mockListDeployments).toHaveBeenCalledWith('proj-1', 'tenant-1', {
        environment: undefined,
        status: 'draining',
      });
    });

    // NOTE: "project not found" is now handled by requireProjectPermission (tested in deployments-authz.test.ts)
  });

  // ---------------------------------------------------------------------------
  // POST / — create deployment
  // ---------------------------------------------------------------------------
  describe('POST / (create deployment)', () => {
    const validBody = {
      environment: 'staging',
      agentVersionManifest: { booking_agent: '0.1.0' },
      entryAgentName: 'booking_agent',
      label: 'v1 staging',
    };

    test('returns 201 on successful deployment creation', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockResolvedValue(makeDeployment());

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.deployment.environment).toBe('staging');
    });

    test('rejects deployment creation when canonical LLM model policy is not execution-ready', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Book travel"\nRESPOND: "ok"',
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
        },
      ]);
      mockProjectLLMConfigFindOne.mockResolvedValue({
        _id: 'llm-config-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        operationTierOverrides: {
          response_gen: 'voice',
        },
      });

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(422);
      expect(body).toMatchObject({
        success: false,
        error:
          'Project DSL has validation errors. Fix the draft or runtime config before starting a runtime session.',
        issues: [{ kind: 'model_policy' }],
      });
      expect(mockFindAgentVersion).not.toHaveBeenCalled();
      expect(mockCreateDeployment).not.toHaveBeenCalled();
    });

    test('passes the project deploy lock client into module snapshot builds', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockResolvedValue(makeDeployment());

      const { status } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      expect(mockBuildDeploymentModuleSnapshot).toHaveBeenCalledTimes(1);
      const buildArgs = mockBuildDeploymentModuleSnapshot.mock.calls[0] as [
        string,
        string,
        string,
        number,
        Set<string>,
        { redis?: typeof fakeRedisLockClient; environment?: string; userId?: string } | undefined,
      ];
      expect(buildArgs[0]).toBe('tenant-1');
      expect(buildArgs[1]).toBe('proj-1');
      expect(buildArgs[2]).toBe('deploy-1');
      expect(buildArgs[3]).toBe(0);
      expect(buildArgs[4]).toEqual(new Set(['booking_agent']));
      expect(buildArgs[5]).toEqual({
        redis: fakeRedisLockClient,
        environment: 'staging',
        userId: 'user-1',
      });
    });

    test('includes local project tool names in the module snapshot collision set', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockProjectToolModelFind.mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve([{ name: 'search_catalog' }, { name: 'lookup_orders' }]),
        }),
      });
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockResolvedValue(makeDeployment());

      const { status } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      const buildArgs = mockBuildDeploymentModuleSnapshot.mock.calls[0] as [
        string,
        string,
        string,
        number,
        Set<string>,
        { redis?: typeof fakeRedisLockClient; environment?: string } | undefined,
      ];
      expect(buildArgs[4]).toEqual(new Set(['booking_agent', 'lookup_orders', 'search_catalog']));
      expect(mockProjectToolModelFind).toHaveBeenCalledWith({
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      });
    });

    test('preserves explicitly pinned versions even when working copy has drifted', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Working copy changed"\nRESPOND: "new"',
        },
      ]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation(async (data) =>
        makeDeployment({
          agentVersionManifest: (data as { agentVersionManifest: Record<string, string> })
            .agentVersionManifest,
        }),
      );

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      expect(mockVersionServiceInstance.nextVersion).not.toHaveBeenCalled();
      expect(mockVersionServiceInstance.createVersion).not.toHaveBeenCalled();
      expect(mockCreateDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          agentVersionManifest: { booking_agent: '0.1.0' },
        }),
      );
      expect(body.deployment.agentVersionManifest).toEqual({ booking_agent: '0.1.0' });
    });

    test('passes prompt-library refs into deployment auto-versioning', async () => {
      const promptLibraryRef = {
        promptId: 'prompt-1',
        versionId: 'prompt-version-1',
        resolvedHash: 'prompt-hash-1',
      };
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([
        {
          id: 'agent-1',
          name: 'booking_agent',
          dslContent: 'AGENT: booking_agent\nGOAL: "Book travel"\nRESPOND: "ok"',
          systemPromptLibraryRef: promptLibraryRef,
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
        },
      ]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-auto-1',
        version: '0.2.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation(async (data) =>
        makeDeployment({
          agentVersionManifest: (data as { agentVersionManifest: Record<string, string> })
            .agentVersionManifest,
        }),
      );

      const { status, body } = await request('POST', DEPLOYS_BASE, {
        body: {
          ...validBody,
          agentVersionManifest: { booking_agent: 'auto' },
        },
      });

      expect(status).toBe(201);
      expect(mockVersionServiceInstance.createVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'booking_agent',
          libraryRef: promptLibraryRef,
        }),
      );
      expect(body.deployment.agentVersionManifest).toEqual({ booking_agent: '0.2.0' });
    });

    test('preserves namespace-scoped runtime binding placeholders before caching deployment IR', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockLoadConfigVariablesMap.mockResolvedValue({
        API_BASE: 'https://runtime.example.com',
        TIMEOUT_MS: '45000',
      });
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({
          metadata: { name: 'booking_agent' },
          tools: [
            {
              name: 'lookup_ticket',
              variable_namespace_ids: ['ns-default'],
              hints: { timeout: '{{config.TIMEOUT_MS}}' },
              http_binding: {
                endpoint: '{{config.API_BASE}}/tickets',
                method: 'GET',
                timeout_ms: '{{config.TIMEOUT_MS}}',
              },
            },
          ],
        }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockResolvedValue(makeDeployment());

      const { status } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      const cachedCompilation = mockCacheCompilationOutput.mock.calls[0][0];
      const cachedTool = cachedCompilation.agents.booking_agent.tools[0];
      expect(cachedTool.http_binding.endpoint).toBe('{{config.API_BASE}}/tickets');
      expect(cachedTool.http_binding.timeout_ms).toBe('{{config.TIMEOUT_MS}}');
      expect(cachedTool.hints.timeout).toBe(45000);
    });

    test('returns 400 when unscoped runtime config placeholders are unresolved', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockLoadConfigVariablesMap.mockResolvedValue({});
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({
          metadata: { name: 'booking_agent' },
          tools: [
            {
              name: 'lookup_ticket',
              http_binding: {
                method: 'GET',
                endpoint: 'https://api.example.com/tickets',
                timeout_ms: '{{config.TIMEOUT_MS}}',
              },
            },
          ],
        }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(400);
      expect(body).toMatchObject({
        success: false,
        error: 'Deployment config validation failed',
      });
      expect(body.details).toContain(
        'Undefined config variable "TIMEOUT_MS" referenced in deployment agent "booking_agent"',
      );
      expect(mockCreateDeployment).not.toHaveBeenCalled();
      expect(mockCacheCompilationOutput).not.toHaveBeenCalled();
    });

    test('returns 400 when agentVersionManifest is empty', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });

      const { status, body } = await request('POST', DEPLOYS_BASE, {
        body: { ...validBody, agentVersionManifest: {} },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('agentVersionManifest');
    });

    test('returns 400 for invalid environment', async () => {
      const { status, body } = await request('POST', DEPLOYS_BASE, {
        body: { ...validBody, environment: 'banana' },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Invalid environment');
    });

    test('returns 400 when entryAgentName not in manifest', async () => {
      const { status, body } = await request('POST', DEPLOYS_BASE, {
        body: {
          ...validBody,
          entryAgentName: 'missing_agent',
        },
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('entryAgentName');
    });

    test('returns 400 when agent not found in project', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([]); // no agents

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    test('returns 400 when agent version not found', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue(null);

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Version');
    });

    // NOTE: "project not found" is now handled by requireProjectPermission (tested in deployments-authz.test.ts)

    test('retires previous active deployment on create', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: null,
      });
      const previousDeploy = makeDeployment({ id: 'old-deploy' });
      mockRetirePreviousActiveDeployment.mockResolvedValue(previousDeploy);
      mockCreateDeployment.mockResolvedValue(
        makeDeployment({ previousDeploymentId: 'old-deploy' }),
      );

      const { status } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(201);
      expect(mockRetirePreviousActiveDeployment).toHaveBeenCalledWith(
        'proj-1',
        'tenant-1',
        'staging',
      );
    });

    test('returns canonical preflight issue summary when validation fails', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      mockRunPreflightValidation.mockResolvedValue({
        status: 'errors',
        agents: [],
        summary: {
          total: 1,
          passed: 0,
          warnings: 0,
          errors: 1,
          canonicalIssues: [
            {
              severity: 'error',
              category: 'llm',
              code: 'LLM_CREDENTIAL_MISSING',
              count: 1,
              agentNames: ['booking_agent'],
            },
          ],
        },
      });

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('PREFLIGHT_FAILED');
      expect(body.preflightReport.summary.canonicalIssues).toEqual([
        {
          severity: 'error',
          category: 'llm',
          code: 'LLM_CREDENTIAL_MISSING',
          count: 1,
          agentNames: ['booking_agent'],
        },
      ]);
    });

    test('returns 422 and restores the previous active deployment when module build fails', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      const previousDeploy = makeDeployment({ id: 'old-deploy' });
      mockRetirePreviousActiveDeployment.mockResolvedValue(previousDeploy);
      mockCreateDeployment.mockResolvedValue(makeDeployment({ id: 'deploy-new' }));
      mockBuildDeploymentModuleSnapshot.mockResolvedValue({
        success: false,
        mountedAgentCount: 0,
        mountedToolCount: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'SELECTOR_RESOLUTION_FAILED',
            source: 'dependency:payments',
            message: 'Version 1.0.0 not found or archived',
          },
        ],
      });

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('MODULE_BUILD_FAILED');
      expect(body.moduleBuild.diagnostics[0].code).toBe('SELECTOR_RESOLUTION_FAILED');
      expect(mockDeploymentVariableSnapshotDeleteOne).toHaveBeenCalledWith({
        deploymentId: 'deploy-new',
        tenantId: 'tenant-1',
      });
      expect(mockDeploymentModelDeleteOne).toHaveBeenCalledWith({
        _id: 'deploy-new',
        tenantId: 'tenant-1',
      });
      expect(mockDeploymentModelUpdateOne).toHaveBeenCalledWith(
        { _id: 'old-deploy', tenantId: 'tenant-1', status: 'retired' },
        { $set: { status: 'active', retiredAt: null } },
      );
    });

    test('restores the previous active deployment when createDeployment fails after retirement', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        id: 'ver-1',
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent' }),
      });
      const previousDeploy = makeDeployment({ id: 'old-deploy' });
      mockRetirePreviousActiveDeployment.mockResolvedValue(previousDeploy);
      mockCreateDeployment.mockRejectedValue(new Error('db write failed'));

      const { status, body } = await request('POST', DEPLOYS_BASE, { body: validBody });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Failed to create deployment');
      expect(mockDeploymentModelUpdateOne).toHaveBeenCalledWith(
        { _id: 'old-deploy', tenantId: 'tenant-1', status: 'retired' },
        { $set: { status: 'active', retiredAt: null } },
      );
      expect(mockBuildDeploymentModuleSnapshot).not.toHaveBeenCalled();
      expect(mockDeploymentModelDeleteOne).not.toHaveBeenCalled();
      expect(mockDeploymentModuleSnapshotDeleteOne).not.toHaveBeenCalled();
      expect(mockDeploymentVariableSnapshotDeleteOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /:deploymentId — get deployment detail
  // ---------------------------------------------------------------------------
  describe('GET /:deploymentId (get detail)', () => {
    test('returns 200 with deployment detail and channel count', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment());
      mockCountLinkedChannels.mockResolvedValue(5);

      const { status, body } = await request('GET', `${DEPLOYS_BASE}/deploy-1`);

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deployment.id).toBe('deploy-1');
      expect(body.deployment.channelCount).toBe(5);
    });

    test('returns 404 when deployment not found', async () => {
      mockFindDeploymentById.mockResolvedValue(null);

      const { status, body } = await request('GET', `${DEPLOYS_BASE}/nonexistent`);

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:deploymentId/retire — retire deployment
  // ---------------------------------------------------------------------------
  describe('POST /:deploymentId/retire', () => {
    test('transitions active deployment to draining', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment({ status: 'active' }));
      mockUpdateDeploymentStatus.mockResolvedValue(makeDeployment({ status: 'draining' }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/retire`, {
        body: {},
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deployment.status).toBe('draining');
    });

    test('transitions draining deployment to retired', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment({ status: 'draining' }));
      mockUpdateDeploymentStatus.mockResolvedValue(makeDeployment({ status: 'retired' }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/retire`, {
        body: {},
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('force retires active deployment immediately', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment({ status: 'active' }));
      mockUpdateDeploymentStatus.mockResolvedValue(makeDeployment({ status: 'retired' }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/retire`, {
        body: { force: true },
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('returns 404 when deployment not found', async () => {
      mockFindDeploymentById.mockResolvedValue(null);

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/nonexistent/retire`, {
        body: {},
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 422 when deployment already retired', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment({ status: 'retired' }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/retire`, {
        body: {},
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Cannot retire');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /:deploymentId/rollback — rollback deployment
  // ---------------------------------------------------------------------------
  describe('POST /:deploymentId/rollback', () => {
    test('retires current and reactivates previous deployment', async () => {
      mockFindDeploymentById
        .mockResolvedValueOnce(makeDeployment({ previousDeploymentId: 'old-deploy' }))
        .mockResolvedValueOnce(makeDeployment({ id: 'old-deploy', status: 'draining' }));
      mockUpdateDeploymentStatus
        .mockResolvedValueOnce(makeDeployment({ status: 'retired' }))
        .mockResolvedValueOnce(makeDeployment({ id: 'old-deploy', status: 'active' }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/rollback`, {
        body: {},
      });

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      // Second updateDeploymentStatus call reactivates previous
      expect(mockUpdateDeploymentStatus).toHaveBeenCalledTimes(2);
    });

    test('returns 404 when deployment not found', async () => {
      mockFindDeploymentById.mockResolvedValue(null);

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/nonexistent/rollback`, {
        body: {},
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('returns 422 when no previous deployment', async () => {
      mockFindDeploymentById.mockResolvedValue(makeDeployment({ previousDeploymentId: null }));

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/rollback`, {
        body: {},
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error).toContain('No previous deployment');
    });

    test('returns 404 when previous deployment no longer exists', async () => {
      mockFindDeploymentById
        .mockResolvedValueOnce(makeDeployment({ previousDeploymentId: 'deleted-deploy' }))
        .mockResolvedValueOnce(null);

      const { status, body } = await request('POST', `${DEPLOYS_BASE}/deploy-1/rollback`, {
        body: {},
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Previous deployment not found');
    });
  });
});
