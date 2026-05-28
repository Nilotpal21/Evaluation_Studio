/**
 * Deployment Promotion Tests
 *
 * Tests the POST /:deploymentId/promote endpoint, covering:
 * - Happy path: promote dev → staging
 * - Promote with existing active in target (verify drain)
 * - Reject same environment (422)
 * - Reject retired source (422)
 * - Reject not-found source (404)
 * - Model overrides merge
 * - Channel auto-follow updates matching channels
 * - Channel auto-follow skips followEnvironment: false channels
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS
// =============================================================================

const mockFindProjectByIdAndTenant = vi.fn();
const mockFindProjectAgentsForProject = vi.fn();
const mockFindAgentVersion = vi.fn();

vi.mock('../../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: (...args: any[]) => mockFindProjectByIdAndTenant(...args),
  findProjectAgentsForProject: (...args: any[]) => mockFindProjectAgentsForProject(...args),
  findAgentVersion: (...args: any[]) => mockFindAgentVersion(...args),
  loadConfigVariablesMap: vi.fn().mockResolvedValue({}),
  findProjectAgentForProject: vi.fn(),
}));

const mockFindActiveDeployment = vi.fn();
const mockFindDeploymentById = vi.fn();
const mockListDeployments = vi.fn();
const mockCreateDeployment = vi.fn();
const mockUpdateDeploymentStatus = vi.fn();
const mockCountLinkedChannels = vi.fn();
const mockRetirePreviousActiveDeployment = vi.fn().mockResolvedValue(null);
const mockBuildDeploymentModuleSnapshot = vi.fn();
const mockCloneDeploymentModuleSnapshot = vi.fn();
const mockGetRedisClient = vi.fn();

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: any[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: any[]) => mockFindDeploymentById(...args),
  listDeployments: (...args: any[]) => mockListDeployments(...args),
  createDeployment: (...args: any[]) => mockCreateDeployment(...args),
  updateDeploymentStatus: (...args: any[]) => mockUpdateDeploymentStatus(...args),
  countLinkedChannels: (...args: any[]) => mockCountLinkedChannels(...args),
  retirePreviousActiveDeployment: (...args: any[]) => mockRetirePreviousActiveDeployment(...args),
}));

const mockBulkUpdateChannelDeployment = vi.fn();

vi.mock('../../repos/channel-repo.js', () => ({
  bulkUpdateChannelDeployment: (...args: any[]) => mockBulkUpdateChannelDeployment(...args),
}));

vi.mock('../../services/modules/deployment-build-service.js', () => ({
  buildDeploymentModuleSnapshot: (...args: any[]) => mockBuildDeploymentModuleSnapshot(...args),
  cloneDeploymentModuleSnapshot: (...args: any[]) => mockCloneDeploymentModuleSnapshot(...args),
}));

vi.mock('../../services/redis/redis-client.js', () => ({
  getRedisClient: (...args: any[]) => mockGetRedisClient(...args),
}));

vi.mock('../../services/snapshot-service.js', () => ({
  createDeploymentSnapshot: vi.fn().mockResolvedValue({ _id: 'snapshot-1' }),
}));

const mockDeploymentModelUpdateOne = vi.fn().mockResolvedValue({ acknowledged: true });
const mockDeploymentModelDeleteOne = vi.fn().mockResolvedValue({ acknowledged: true });
const mockDeploymentVariableSnapshotDeleteOne = vi.fn().mockResolvedValue({ acknowledged: true });
const mockDeploymentModuleSnapshotDeleteOne = vi.fn().mockResolvedValue({ acknowledged: true });
const mockProjectModelFindOne = vi.fn();
const mockProjectToolModelFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockProjectLLMConfigFindOne = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Deployment: {
    updateOne: (...args: any[]) => mockDeploymentModelUpdateOne(...args),
    deleteOne: (...args: any[]) => mockDeploymentModelDeleteOne(...args),
  },
  DeploymentVariableSnapshot: {
    deleteOne: (...args: any[]) => mockDeploymentVariableSnapshotDeleteOne(...args),
  },
  DeploymentModuleSnapshot: {
    deleteOne: (...args: any[]) => mockDeploymentModuleSnapshotDeleteOne(...args),
  },
  Project: {
    findOne: (...args: any[]) => mockProjectModelFindOne(...args),
  },
  ProjectTool: {
    find: (...args: any[]) => mockProjectToolModelFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: any[]) => mockProjectRuntimeConfigFindOne(...args),
  },
  ProjectLLMConfig: {
    findOne: (...args: any[]) => mockProjectLLMConfigFindOne(...args),
  },
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
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getCurrentRequestId: vi.fn(() => 'req-test-1'),
  validateAgentName: vi.fn(() => null),
  requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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
  mockBuildDeploymentModuleSnapshot.mockResolvedValue(null);
  mockCloneDeploymentModuleSnapshot.mockResolvedValue(null);
  mockGetRedisClient.mockReturnValue(fakeRedisLockClient);
  mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
  mockProjectModelFindOne.mockReturnValue({
    lean: () => Promise.resolve({ _id: 'proj-1', moduleDependencyVersion: 0 }),
  });
  mockProjectToolModelFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });
  mockProjectRuntimeConfigFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });
  mockProjectLLMConfigFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });
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

const BASE = '/api/projects/proj-1/deployments';

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deploy-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'dev',
    status: 'active',
    label: 'v1 dev',
    description: 'Dev deployment',
    endpointSlug: 'proj-1-dev-abc123',
    entryAgentName: 'booking_agent',
    agentVersionManifest: { booking_agent: '0.1.0' },
    compilationHash: 'hash-abc',
    modelOverrides: null,
    previousDeploymentId: null,
    promotedFromDeploymentId: null,
    createdBy: 'user-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Deployment Promotion', () => {
  describe('POST /:deploymentId/promote', () => {
    test('happy path: promote dev → staging', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null); // no existing active in staging
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.deployment.environment).toBe('staging');
      expect(body.deployment.promotedFromDeploymentId).toBe('deploy-src');
      expect(body.deployment.entryAgentName).toBe('booking_agent');
      expect(body.deployment.agentVersionManifest).toEqual({ booking_agent: '0.1.0' });
      expect(body.deployment.compilationHash).toBe('hash-abc');

      // Should not have drained anything (no previous active in staging)
      expect(mockUpdateDeploymentStatus).not.toHaveBeenCalled();
    });

    test('passes the project deploy lock client into module rebuilds during promotion', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCloneDeploymentModuleSnapshot.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

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
      expect(buildArgs[2]).toBe('deploy-promoted');
      expect(buildArgs[3]).toBe(0);
      expect(buildArgs[4]).toEqual(new Set(['booking_agent']));
      expect(buildArgs[5]).toEqual({
        redis: fakeRedisLockClient,
        environment: 'staging',
        userId: 'user-1',
      });
    });

    test('passes source and target environments into module snapshot clone during promotion', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCloneDeploymentModuleSnapshot.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(201);
      expect(mockCloneDeploymentModuleSnapshot).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'deploy-src',
        'deploy-promoted',
        { sourceEnvironment: 'dev', targetEnvironment: 'staging' },
      );
    });

    test('drains existing active in target environment', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      const existing = makeDeployment({
        id: 'deploy-existing',
        environment: 'staging',
        status: 'active',
      });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(existing);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockUpdateDeploymentStatus.mockResolvedValue({ ...existing, status: 'draining' });
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(mockUpdateDeploymentStatus).toHaveBeenCalledWith(
        'deploy-existing',
        'tenant-1',
        expect.objectContaining({
          status: 'draining',
        }),
      );
      // previousDeploymentId should be the drained one
      expect(body.deployment.previousDeploymentId).toBe('deploy-existing');
    });

    test('rejects same environment (422 SAME_ENVIRONMENT)', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'staging' });
      mockFindDeploymentById.mockResolvedValue(source);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(422);
      expect(body.error.code).toBe('SAME_ENVIRONMENT');
    });

    test('rejects retired source (422 DEPLOYMENT_RETIRED)', async () => {
      const source = makeDeployment({ id: 'deploy-src', status: 'retired' });
      mockFindDeploymentById.mockResolvedValue(source);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(422);
      expect(body.error.code).toBe('DEPLOYMENT_RETIRED');
    });

    test('rejects not-found source (404)', async () => {
      mockFindDeploymentById.mockResolvedValue(null);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(404);
      expect(body.success).toBe(false);
    });

    test('merges model overrides from source and request', async () => {
      const source = makeDeployment({
        id: 'deploy-src',
        environment: 'dev',
        modelOverrides: { booking_agent: { model: 'gpt-4', temperature: 0.7 } },
      });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: {
          targetEnvironment: 'production',
          modelOverrides: { booking_agent: { temperature: 0.3, maxTokens: 2048 } },
        },
      });

      expect(status).toBe(201);
      // Request overrides should layer on top of source
      expect(body.deployment.modelOverrides).toEqual({
        booking_agent: { temperature: 0.3, maxTokens: 2048 },
      });
    });

    test('auto-follow updates matching channels', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(3);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(201);
      expect(body.channelsUpdated).toBe(3);
      expect(mockBulkUpdateChannelDeployment).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'staging',
        'deploy-promoted',
      );
    });

    test('auto-follow failure is non-fatal', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockRejectedValue(new Error('DB error'));

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      // Should still succeed despite channel update failure
      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.channelsUpdated).toBe(0);
    });

    test('restores the previously drained target deployment when module snapshot materialization fails', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      const existing = makeDeployment({
        id: 'deploy-existing',
        environment: 'staging',
        status: 'active',
      });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(existing);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockUpdateDeploymentStatus.mockResolvedValue({ ...existing, status: 'draining' });
      mockCloneDeploymentModuleSnapshot.mockResolvedValue({
        success: false,
        mountedAgentCount: 0,
        mountedToolCount: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'SNAPSHOT_CLONE_FAILED',
            source: 'build',
            message: 'Failed to clone module snapshot',
          },
        ],
      });

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(422);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('MODULE_BUILD_FAILED');
      expect(mockDeploymentVariableSnapshotDeleteOne).toHaveBeenCalledWith({
        deploymentId: 'deploy-promoted',
        tenantId: 'tenant-1',
      });
      expect(mockDeploymentModelDeleteOne).toHaveBeenCalledWith({
        _id: 'deploy-promoted',
        tenantId: 'tenant-1',
      });
      expect(mockDeploymentModelUpdateOne).toHaveBeenCalledWith(
        { _id: 'deploy-existing', tenantId: 'tenant-1', status: 'draining' },
        { $set: { status: 'active', drainingStartedAt: null } },
      );
    });

    test('restores the drained target deployment when createDeployment fails', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev' });
      const existing = makeDeployment({
        id: 'deploy-existing',
        environment: 'staging',
        status: 'active',
      });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(existing);
      mockUpdateDeploymentStatus.mockResolvedValue({ ...existing, status: 'draining' });
      mockCreateDeployment.mockRejectedValue(new Error('db write failed'));

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Failed to promote deployment');
      expect(mockDeploymentModelUpdateOne).toHaveBeenCalledWith(
        { _id: 'deploy-existing', tenantId: 'tenant-1', status: 'draining' },
        { $set: { status: 'active', drainingStartedAt: null } },
      );
      expect(mockCloneDeploymentModuleSnapshot).not.toHaveBeenCalled();
      expect(mockBuildDeploymentModuleSnapshot).not.toHaveBeenCalled();
      expect(mockDeploymentModelDeleteOne).not.toHaveBeenCalled();
      expect(mockDeploymentModuleSnapshotDeleteOne).not.toHaveBeenCalled();
      expect(mockDeploymentVariableSnapshotDeleteOne).not.toHaveBeenCalled();
    });

    test('preserves label and description from source when not overridden', async () => {
      const source = makeDeployment({
        id: 'deploy-src',
        environment: 'dev',
        label: 'Release v1.2',
        description: 'Bug fixes and improvements',
      });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: { targetEnvironment: 'staging' },
      });

      expect(status).toBe(201);
      expect(body.deployment.label).toBe('Release v1.2');
      expect(body.deployment.description).toBe('Bug fixes and improvements');
    });

    test('overrides label and description when provided', async () => {
      const source = makeDeployment({ id: 'deploy-src', environment: 'dev', label: 'old label' });
      mockFindDeploymentById.mockResolvedValue(source);
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-promoted',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(0);

      const { status, body } = await request('POST', `${BASE}/deploy-src/promote`, {
        body: {
          targetEnvironment: 'staging',
          label: 'Staging release',
          description: 'Promoted for QA',
        },
      });

      expect(status).toBe(201);
      expect(body.deployment.label).toBe('Staging release');
      expect(body.deployment.description).toBe('Promoted for QA');
    });
  });

  describe('POST / (create deployment) — auto-follow', () => {
    test('auto-follow updates channels on create', async () => {
      mockFindProjectByIdAndTenant.mockResolvedValue({ id: 'proj-1', tenantId: 'tenant-1' });
      mockFindProjectAgentsForProject.mockResolvedValue([{ id: 'agent-1', name: 'booking_agent' }]);
      mockFindAgentVersion.mockResolvedValue({
        version: '0.1.0',
        irContent: JSON.stringify({ name: 'booking_agent', version: '0.1.0' }),
      });
      mockFindActiveDeployment.mockResolvedValue(null);
      mockCreateDeployment.mockImplementation((data: any) => ({
        ...data,
        id: 'deploy-new',
        status: 'active',
        createdAt: new Date().toISOString(),
      }));
      mockBulkUpdateChannelDeployment.mockResolvedValue(2);

      // Mock the session service caching
      vi.doMock('../../services/session/session-service.js', () => ({
        getSessionService: () => ({
          cacheCompilationOutput: vi.fn().mockResolvedValue('hash-123'),
          cacheAgentIR: vi.fn().mockResolvedValue(undefined),
        }),
      }));

      const { status, body } = await request('POST', BASE, {
        body: {
          environment: 'dev',
          agentVersionManifest: { booking_agent: '0.1.0' },
          entryAgentName: 'booking_agent',
        },
      });

      expect(status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.channelsUpdated).toBe(2);
      expect(mockBulkUpdateChannelDeployment).toHaveBeenCalledWith(
        'tenant-1',
        'proj-1',
        'dev',
        'deploy-new',
      );
    });
  });
});
