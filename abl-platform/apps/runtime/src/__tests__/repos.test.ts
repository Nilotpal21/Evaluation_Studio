/**
 * Repository Layer Tests
 *
 * Tests the actual repo functions (project-repo, session-repo, cascade-repo)
 * with mocked database models, cascade functions, and audit store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mock Mongoose model methods
// =============================================================================

// Each model gets its own set of chainable mocks so we can configure them
// independently per test without cross-contamination.

function createChainableFindById() {
  const chain: any = {
    lean: vi.fn().mockResolvedValue(null),
    select: vi.fn().mockReturnThis(),
  };
  const fn = vi.fn().mockReturnValue(chain);
  fn._chain = chain;
  return fn;
}

function createChainableFindOne() {
  const chain: any = {
    lean: vi.fn().mockResolvedValue(null),
    sort: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
  };
  const fn = vi.fn().mockReturnValue(chain);
  fn._chain = chain;
  return fn;
}

function createChainableFind() {
  const chain: any = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue([]),
  };
  const fn = vi.fn().mockReturnValue(chain);
  fn._chain = chain;
  return fn;
}

// --- Project model ---
const projectFindById = createChainableFindById();
const projectFindOne = createChainableFindOne();
const projectFind = createChainableFind();

// --- ProjectAgent model ---
const projectAgentFindOne = createChainableFindOne();
const projectAgentFind = createChainableFind();

// --- Session model ---
const sessionFindById = createChainableFindById();
const sessionFindOne = createChainableFindOne();
const sessionFind = createChainableFind();
const sessionFindByIdAndUpdate = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
const sessionFindOneAndUpdate = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
const sessionUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const sessionCountDocuments = vi.fn().mockResolvedValue(0);

vi.mock('@agent-platform/database/models', () => ({
  Project: {
    findById: (...args: any[]) => projectFindById(...args),
    findOne: (...args: any[]) => projectFindOne(...args),
    find: (...args: any[]) => projectFind(...args),
  },
  ProjectAgent: {
    findOne: (...args: any[]) => projectAgentFindOne(...args),
    find: (...args: any[]) => projectAgentFind(...args),
  },
  Session: {
    findById: (...args: any[]) => sessionFindById(...args),
    findOne: (...args: any[]) => sessionFindOne(...args),
    find: (...args: any[]) => sessionFind(...args),
    findByIdAndUpdate: (...args: any[]) => sessionFindByIdAndUpdate(...args),
    findOneAndUpdate: (...args: any[]) => sessionFindOneAndUpdate(...args),
    updateOne: (...args: any[]) => sessionUpdateOne(...args),
    countDocuments: (...args: any[]) => sessionCountDocuments(...args),
  },
}));

// =============================================================================
// Mock cascade functions
// =============================================================================

const mockDeleteTenant = vi.fn().mockResolvedValue({
  counts: { Project: 2, Session: 3 },
  total: 5,
  anonymized: {},
});
const mockDeleteProject = vi.fn().mockResolvedValue({
  counts: { ProjectAgent: 1, Session: 2 },
  total: 3,
  anonymized: {},
});
const mockDeleteUser = vi.fn().mockResolvedValue({
  counts: { OrgMember: 1 },
  total: 1,
  anonymized: { AuditLog: 1 },
});
const mockDeleteSession = vi.fn().mockResolvedValue({
  counts: { Message: 2 },
  total: 2,
  anonymized: {},
});

vi.mock('@agent-platform/database/cascade', () => ({
  deleteTenant: (...args: any[]) => mockDeleteTenant(...args),
  deleteProject: (...args: any[]) => mockDeleteProject(...args),
  deleteUser: (...args: any[]) => mockDeleteUser(...args),
  deleteSession: (...args: any[]) => mockDeleteSession(...args),
}));

// =============================================================================
// Mock ClickHouse (used by cleanClickHouseForTenant inside cascade-repo)
// =============================================================================

const mockClickHouseCommand = vi.fn().mockResolvedValue(undefined);
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: vi.fn(() => ({
    command: (...args: any[]) => mockClickHouseCommand(...args),
  })),
}));

// =============================================================================
// Mock audit store
// =============================================================================

const mockAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(() => ({
    log: (...args: any[]) => mockAuditLog(...args),
  })),
}));

// =============================================================================
// Mock logger
// =============================================================================

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// Import actual repo functions (AFTER mocks are declared)
// =============================================================================

import {
  findProjectByIdAndTenant,
  findProjectWithAgents,
  findProjectAgentByPath,
  findProjectAgentByName,
} from '../repos/project-repo.js';

import {
  findSessionById,
  listSessions,
  countSessions,
  updateSession,
  updateSessionActivity,
  incrementSessionTokens,
} from '../repos/session-repo.js';

import {
  cascadeDeleteTenant,
  cascadeDeleteProject,
  cascadeDeleteUser,
  cascadeDeleteSession,
} from '../repos/cascade-repo.js';

// =============================================================================
// Reset all mocks between tests
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockClickHouseCommand.mockResolvedValue(undefined);

  // Reset default return values for chainable mocks
  projectFindById._chain.lean.mockResolvedValue(null);
  projectFindById._chain.select.mockReturnValue(projectFindById._chain);
  projectFindOne._chain.lean.mockResolvedValue(null);
  projectAgentFindOne._chain.lean.mockResolvedValue(null);
  projectAgentFind._chain.lean.mockResolvedValue([]);
  sessionFindById._chain.lean.mockResolvedValue(null);
  sessionFindOne._chain.lean.mockResolvedValue(null);
  sessionFind._chain.lean.mockResolvedValue([]);
  sessionFindByIdAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  sessionFindOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  sessionCountDocuments.mockResolvedValue(0);
});

// #############################################################################
// project-repo
// #############################################################################

describe('project-repo', () => {
  describe('findProjectByIdAndTenant', () => {
    it('returns project doc when found with matching tenant', async () => {
      const projectDoc = { _id: 'proj-1', tenantId: 'tenant-1', name: 'My Project' };
      projectFindOne._chain.lean.mockResolvedValue(projectDoc);

      const result = await findProjectByIdAndTenant('proj-1', 'tenant-1');

      expect(projectFindOne).toHaveBeenCalledWith({ _id: 'proj-1', tenantId: 'tenant-1' });
      expect(result).toEqual(projectDoc);
    });

    it('returns null when project not found for tenant', async () => {
      projectFindOne._chain.lean.mockResolvedValue(null);

      const result = await findProjectByIdAndTenant('proj-1', 'wrong-tenant');

      expect(result).toBeNull();
    });
  });

  describe('findProjectWithAgents', () => {
    it('returns project with agents array when found', async () => {
      const projectDoc = { _id: 'proj-1', name: 'My Project', tenantId: 'tenant-1' };
      const agentDocs = [
        { _id: 'agent-1', name: 'booking_agent', projectId: 'proj-1' },
        { _id: 'agent-2', name: 'search_agent', projectId: 'proj-1' },
      ];
      projectFindOne._chain.lean.mockResolvedValue(projectDoc);
      projectAgentFind._chain.lean.mockResolvedValue(agentDocs);

      const result = await findProjectWithAgents('proj-1', 'tenant-1');

      expect(projectFindOne).toHaveBeenCalledWith({ _id: 'proj-1', tenantId: 'tenant-1' });
      expect(result).toEqual({ ...projectDoc, agents: agentDocs });
    });

    it('returns null when project is not found', async () => {
      projectFindOne._chain.lean.mockResolvedValue(null);

      const result = await findProjectWithAgents('nonexistent', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('findProjectAgentByPath', () => {
    it('returns agent doc when found (tenant-scoped)', async () => {
      const agentDoc = {
        _id: 'agent-1',
        agentPath: 'hotel-booking/booking_agent',
        name: 'booking_agent',
        tenantId: 'tenant-1',
      };
      projectAgentFindOne._chain.lean.mockResolvedValue(agentDoc);

      const result = await findProjectAgentByPath('hotel-booking/booking_agent', 'tenant-1');

      expect(projectAgentFindOne).toHaveBeenCalledWith({
        agentPath: 'hotel-booking/booking_agent',
        tenantId: 'tenant-1',
      });
      expect(result).toEqual(agentDoc);
    });

    it('returns null when no tenantId provided (cross-tenant guard)', async () => {
      const result = await findProjectAgentByPath('hotel-booking/booking_agent');
      expect(result).toBeNull();
    });

    it('returns null when agent not found', async () => {
      projectFind._chain.lean.mockResolvedValue([{ _id: 'proj-1' }]);
      projectAgentFindOne._chain.lean.mockResolvedValue(null);

      const result = await findProjectAgentByPath('nonexistent/path', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('findProjectAgentByName', () => {
    it('returns null when called without tenantId (cross-tenant guard)', async () => {
      const result = await findProjectAgentByName('booking_agent');
      expect(result).toBeNull();
    });

    it('scopes to tenant when tenantId option provided', async () => {
      const agentDoc = {
        _id: 'agent-1',
        name: 'booking_agent',
        projectId: 'proj-1',
        tenantId: 'tenant-1',
      };
      projectAgentFindOne._chain.lean.mockResolvedValue(agentDoc);

      const result = await findProjectAgentByName('booking_agent', { tenantId: 'tenant-1' });

      // Direct tenant-scoped query on ProjectAgent
      expect(projectAgentFindOne).toHaveBeenCalledWith({
        name: 'booking_agent',
        tenantId: 'tenant-1',
      });
      expect(result).toEqual(agentDoc);
    });
  });
});

// #############################################################################
// session-repo
// #############################################################################

describe('session-repo', () => {
  describe('findSessionById', () => {
    it('returns session with normalized id when found', async () => {
      const sessionDoc = {
        _id: 'sess-1',
        status: 'active',
        agentName: 'booking_agent',
        tenantId: 'tenant-1',
      };
      sessionFindOne._chain.lean.mockResolvedValue(sessionDoc);

      const result = await findSessionById('sess-1', 'tenant-1');

      expect(sessionFindOne).toHaveBeenCalledWith({ _id: 'sess-1', tenantId: 'tenant-1' });
      expect(result).toEqual({ ...sessionDoc, id: 'sess-1' });
    });

    it('always includes tenantId in filter', async () => {
      const sessionDoc = { _id: 'sess-1', status: 'active', tenantId: 'tenant-1' };
      sessionFindOne._chain.lean.mockResolvedValue(sessionDoc);

      const result = await findSessionById('sess-1', 'tenant-1');

      expect(sessionFindOne).toHaveBeenCalledWith({ _id: 'sess-1', tenantId: 'tenant-1' });
      expect(result).toEqual({ ...sessionDoc, id: 'sess-1' });
    });

    it('returns null when session not found', async () => {
      sessionFindOne._chain.lean.mockResolvedValue(null);

      const result = await findSessionById('nonexistent', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('applies where filter and returns docs with normalized ids', async () => {
      const docs = [
        { _id: 'sess-1', status: 'active' },
        { _id: 'sess-2', status: 'active' },
      ];
      sessionFind._chain.lean.mockResolvedValue(docs);

      const result = await listSessions({ projectId: 'proj-1', status: 'active' });

      expect(sessionFind).toHaveBeenCalledWith({ projectId: 'proj-1', status: 'active' });
      expect(result).toEqual([
        { _id: 'sess-1', status: 'active', id: 'sess-1' },
        { _id: 'sess-2', status: 'active', id: 'sess-2' },
      ]);
    });

    it('applies pagination with skip and take', async () => {
      sessionFind._chain.lean.mockResolvedValue([]);

      await listSessions({ projectId: 'proj-1' }, { skip: 10, take: 5 });

      expect(sessionFind._chain.skip).toHaveBeenCalledWith(10);
      expect(sessionFind._chain.limit).toHaveBeenCalledWith(5);
    });

    it('applies sort order from orderBy option', async () => {
      sessionFind._chain.lean.mockResolvedValue([]);

      await listSessions({ projectId: 'proj-1' }, { orderBy: { createdAt: 'desc', name: 'asc' } });

      expect(sessionFind._chain.sort).toHaveBeenCalledWith({ createdAt: -1, name: 1 });
    });

    it('applies select projection and maps id to _id', async () => {
      sessionFind._chain.lean.mockResolvedValue([]);

      await listSessions(
        { projectId: 'proj-1' },
        { select: { id: true, status: true, agentName: true } },
      );

      expect(sessionFind._chain.select).toHaveBeenCalledWith({
        _id: 1,
        status: 1,
        agentName: 1,
      });
    });
  });

  describe('countSessions', () => {
    it('returns count from countDocuments', async () => {
      sessionCountDocuments.mockResolvedValue(42);

      const result = await countSessions({ projectId: 'proj-1' });

      expect(sessionCountDocuments).toHaveBeenCalledWith({ projectId: 'proj-1' });
      expect(result).toBe(42);
    });
  });

  describe('updateSession', () => {
    it('calls findOneAndUpdate with $set and tenantId filter', async () => {
      const updatedDoc = { _id: 'sess-1', status: 'completed', tenantId: 'tenant-1' };
      sessionFindOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(updatedDoc) });

      const result = await updateSession('sess-1', { status: 'completed' }, 'tenant-1');

      expect(sessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', tenantId: 'tenant-1' },
        { $set: { status: 'completed' } },
        { new: true },
      );
      expect(result).toEqual(updatedDoc);
    });

    it('always includes tenantId in filter', async () => {
      const updatedDoc = { _id: 'sess-1', status: 'completed', tenantId: 'tenant-1' };
      sessionFindOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(updatedDoc) });

      const result = await updateSession('sess-1', { status: 'completed' }, 'tenant-1');

      expect(sessionFindOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'sess-1', tenantId: 'tenant-1' },
        { $set: { status: 'completed' } },
        { new: true },
      );
      expect(result).toEqual(updatedDoc);
    });
  });

  describe('updateSessionActivity', () => {
    it('updates lastActivityAt and increments messageCount', async () => {
      await updateSessionActivity('sess-1', 3, 'tenant-1');

      expect(sessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'sess-1', tenantId: 'tenant-1' },
        {
          $set: { lastActivityAt: expect.any(Date) },
          $inc: { messageCount: 3 },
        },
      );
    });
  });

  describe('incrementSessionTokens', () => {
    it('increments tokenCount and estimatedCost atomically', async () => {
      await incrementSessionTokens('sess-1', 150, 0.003, 'tenant-1');

      expect(sessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'sess-1', tenantId: 'tenant-1' },
        { $inc: { tokenCount: 150, estimatedCost: 0.003 } },
      );
    });
  });
});

// #############################################################################
// cascade-repo
// #############################################################################

describe('cascade-repo', () => {
  describe('cascadeDeleteTenant', () => {
    it('calls deleteTenant and returns the result', async () => {
      const result = await cascadeDeleteTenant('tenant-1', 'admin@test.com');

      expect(mockDeleteTenant).toHaveBeenCalledWith('tenant-1');
      expect(result).toEqual({
        counts: { Project: 2, Session: 3 },
        total: 5,
        anonymized: {},
      });
    });

    it('logs audit start and completion events', async () => {
      await cascadeDeleteTenant('tenant-1', 'admin@test.com');

      // Should log at least 2 audit events: start + completion
      expect(mockAuditLog).toHaveBeenCalledTimes(2);

      // Start event
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.cascade_delete_started',
          actor: 'admin@test.com',
          resourceId: 'tenant-1',
          metadata: { tenantId: 'tenant-1' },
        }),
      );

      // Completion event
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.cascade_delete_completed',
          actor: 'admin@test.com',
          resourceId: 'tenant-1',
          metadata: expect.objectContaining({ tenantId: 'tenant-1', total: 5 }),
        }),
      );
    });

    it('fires ClickHouse cleanup for tenant', async () => {
      await cascadeDeleteTenant('tenant-1', 'admin@test.com');

      // Should have called command for each ClickHouse table
      expect(mockClickHouseCommand).toHaveBeenCalled();
      expect(mockClickHouseCommand.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          query_params: { tenantId: 'tenant-1' },
        }),
      );
      const queries = mockClickHouseCommand.mock.calls.map(
        ([arg]) => (arg as { query: string }).query,
      );
      expect(
        queries.some((query) => query.includes('ALTER TABLE abl_platform.pii_audit_log DELETE')),
      ).toBe(true);
      for (const query of queries) {
        expect(query).toContain('SETTINGS mutations_sync = 1');
      }
    });
  });

  describe('cascadeDeleteProject', () => {
    it('calls deleteProject and returns the result', async () => {
      const result = await cascadeDeleteProject('proj-1', 'user@test.com');

      expect(mockDeleteProject).toHaveBeenCalledWith('proj-1');
      expect(result).toEqual({
        counts: { ProjectAgent: 1, Session: 2 },
        total: 3,
        anonymized: {},
      });
    });

    it('logs audit start and completion events', async () => {
      await cascadeDeleteProject('proj-1', 'user@test.com');

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'project.cascade_delete_started',
          actor: 'user@test.com',
          resourceId: 'proj-1',
        }),
      );

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'project.cascade_delete_completed',
          actor: 'user@test.com',
          resourceId: 'proj-1',
          metadata: expect.objectContaining({ projectId: 'proj-1', total: 3 }),
        }),
      );
    });
  });

  describe('cascadeDeleteUser', () => {
    it('calls deleteUser and returns the result', async () => {
      const result = await cascadeDeleteUser('user-1', 'admin@test.com');

      expect(mockDeleteUser).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({
        counts: { OrgMember: 1 },
        total: 1,
        anonymized: { AuditLog: 1 },
      });
    });
  });

  describe('cascadeDeleteSession', () => {
    it('calls deleteSession and returns the result', async () => {
      const result = await cascadeDeleteSession('sess-1');

      expect(mockDeleteSession).toHaveBeenCalledWith('sess-1');
      expect(result).toEqual({
        counts: { Message: 2 },
        total: 2,
        anonymized: {},
      });
    });

    it('fires session-scoped ClickHouse cleanup for experiment assignments and pii audit rows', async () => {
      await cascadeDeleteSession('sess-1');

      const queries = mockClickHouseCommand.mock.calls.map(
        ([arg]) => (arg as { query: string }).query,
      );
      expect(
        queries.some((query) =>
          query.includes('ALTER TABLE abl_platform.experiment_assignments DELETE'),
        ),
      ).toBe(true);
      expect(
        queries.some((query) => query.includes('ALTER TABLE abl_platform.pii_audit_log DELETE')),
      ).toBe(true);
      for (const query of queries) {
        expect(query).toContain('SETTINGS mutations_sync = 1');
      }
    });
  });

  describe('resilience', () => {
    it('continues even if ClickHouse cleanup fails', async () => {
      mockClickHouseCommand.mockRejectedValue(new Error('ClickHouse down'));

      // Should NOT throw — ClickHouse cleanup failures are caught.
      const result = await cascadeDeleteTenant('tenant-1', 'admin@test.com');

      expect(result.total).toBe(5);
    });

    it('continues even if audit logging fails', async () => {
      mockAuditLog.mockRejectedValue(new Error('Audit store down'));

      // Should NOT throw — audit log failures are caught
      const result = await cascadeDeleteTenant('tenant-1', 'admin@test.com');

      expect(result.total).toBe(5);
    });

    it('continues even if audit logging fails for project cascade', async () => {
      mockAuditLog.mockRejectedValue(new Error('Audit store down'));

      const result = await cascadeDeleteProject('proj-1', 'user@test.com');

      expect(result.total).toBe(3);
    });
  });
});
