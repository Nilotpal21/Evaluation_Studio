import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockEnsureDb = vi.fn();
const mockEnsureConnected = vi.fn();
const mockRequireAuth = vi.fn();
const mockRequireTenantAuth = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockServiceNodeFind = vi.fn();
const mockAgentLockFind = vi.fn();
const mockAgentLockFindOne = vi.fn();
const mockAgentLockCreate = vi.fn();

function sortLeanResult(value: unknown) {
  return {
    sort: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  };
}

function leanResult(value: unknown) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (value: unknown) => value instanceof NextResponse,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ensureConnected: (...args: unknown[]) => mockEnsureConnected(...args),
  ServiceNode: {
    find: (...args: unknown[]) => mockServiceNodeFind(...args),
  },
  AgentLock: {
    find: (...args: unknown[]) => mockAgentLockFind(...args),
    findOne: (...args: unknown[]) => mockAgentLockFindOne(...args),
    findOneAndUpdate: vi.fn().mockReturnValue(leanResult(null)),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    create: (...args: unknown[]) => mockAgentLockCreate(...args),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  },
}));

import { findServiceNodes } from '@/repos/service-node-repo';
import { GET as ProjectLocksGET } from '@/app/api/projects/[id]/locks/route';
import { POST as AgentLockPOST } from '@/app/api/projects/[id]/agents/[agentId]/lock/route';

describe('Studio tenant isolation regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnsureDb.mockResolvedValue(undefined);
    mockEnsureConnected.mockResolvedValue(undefined);
    mockRequireAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['*:*'],
    });
    mockRequireTenantAuth.mockResolvedValue({
      id: 'user-1',
      tenantId: 'tenant-1',
      permissions: ['*:*'],
    });
    mockRequireProjectAccess.mockResolvedValue({
      project: { id: 'proj-1', tenantId: 'tenant-1' },
    });
  });

  describe('service-node repo', () => {
    it('threads tenantId into list filters instead of degrading to an empty query', async () => {
      mockServiceNodeFind.mockReturnValue(
        sortLeanResult([
          {
            _id: 'svc-1',
            tenantId: 'tenant-1',
            projectId: 'proj-1',
            name: 'billing_api',
            displayName: 'Billing API',
          },
        ]),
      );

      const nodes = await findServiceNodes({
        tenantId: 'tenant-1',
        projectId: { in: ['proj-1'] },
      });

      expect(nodes).toEqual([
        expect.objectContaining({
          id: 'svc-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
        }),
      ]);
      expect(mockServiceNodeFind).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: { $in: ['proj-1'] },
      });
    });

    it('fails closed when a caller omits tenantId', async () => {
      await expect(findServiceNodes({} as never)).rejects.toThrow(
        'ServiceNode queries require tenantId',
      );
      expect(mockServiceNodeFind).not.toHaveBeenCalled();
    });
  });

  describe('project lock routes', () => {
    it('does not leak foreign-tenant locks from the project lock list route', async () => {
      mockAgentLockFind.mockImplementation((filter: { tenantId?: string }) =>
        leanResult(
          filter.tenantId === 'tenant-1'
            ? []
            : [{ _id: 'lock-foreign', tenantId: 'tenant-2', lockedBy: 'user-2' }],
        ),
      );

      const response = await ProjectLocksGET(
        new NextRequest('http://localhost:3000/api/projects/proj-1/locks'),
        { params: Promise.resolve({ id: 'proj-1' }) },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.locks).toEqual([]);
      expect(mockAgentLockFind).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        expiresAt: expect.any(Object),
      });
    });

    it('creates a fresh lock instead of colliding with a foreign-tenant lock', async () => {
      mockAgentLockFindOne.mockImplementation((filter: { tenantId?: string }) =>
        leanResult(
          filter.tenantId === 'tenant-1'
            ? null
            : {
                _id: 'lock-foreign',
                tenantId: 'tenant-2',
                projectId: 'proj-1',
                agentId: 'agent-1',
                lockedBy: 'user-2',
                lockedAt: new Date('2026-04-26T10:00:00.000Z'),
                expiresAt: new Date('2026-04-26T10:30:00.000Z'),
                lockType: 'edit',
              },
        ),
      );
      mockAgentLockCreate.mockResolvedValue({
        _id: 'lock-1',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        agentName: 'agent-1',
        lockedBy: 'user-1',
        lockedAt: new Date('2026-04-26T10:00:00.000Z'),
        expiresAt: new Date('2026-04-26T10:30:00.000Z'),
        lockType: 'edit',
      });

      const response = await AgentLockPOST(
        new NextRequest('http://localhost:3000/api/projects/proj-1/agents/agent-1/lock', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentName: 'agent-1' }),
        }),
        { params: Promise.resolve({ id: 'proj-1', agentId: 'agent-1' }) },
      );

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.lock).toEqual(
        expect.objectContaining({
          _id: 'lock-1',
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          agentId: 'agent-1',
        }),
      );
      expect(mockAgentLockFindOne).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        agentId: 'agent-1',
        lockType: 'edit',
        expiresAt: expect.any(Object),
      });
      expect(mockAgentLockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          agentId: 'agent-1',
        }),
      );
    });
  });
});
