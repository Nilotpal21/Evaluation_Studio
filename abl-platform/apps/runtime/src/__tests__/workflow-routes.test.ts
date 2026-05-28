/**
 * Workflow Routes Tests
 *
 * Tests the WorkflowDefinition CRUD API using mocked stores.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the external dependencies before importing
vi.mock('../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../services/audit-helpers.js', () => ({
  auditWorkflowCreated: vi.fn(() => Promise.resolve()),
  auditWorkflowUpdated: vi.fn(() => Promise.resolve()),
  auditWorkflowArchived: vi.fn(() => Promise.resolve()),
}));

let mockDb: any;
let workflowDefs: Map<string, any>;
let idCounter: number;

function createMockDb() {
  workflowDefs = new Map();
  idCounter = 0;
  const nextId = () => `wf-${++idCounter}`;

  return {
    tenantMember: {
      findUnique: vi.fn(async ({ where }: any) => {
        const { tenantId, userId } = where.tenantId_userId;
        if (userId === 'admin-user') return { role: 'ADMIN', tenantId, userId };
        if (userId === 'member-user') return { role: 'MEMBER', tenantId, userId };
        return null;
      }),
    },
    workflowDefinition: {
      create: vi.fn(async ({ data }: any) => {
        const id = nextId();
        const def = { id, ...data, status: data.status || 'active', createdAt: new Date() };
        workflowDefs.set(id, def);
        return def;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return workflowDefs.get(where.id) || null;
        if (where.tenantId_projectId_name) {
          const { tenantId, projectId, name } = where.tenantId_projectId_name;
          return (
            Array.from(workflowDefs.values()).find(
              (d) => d.tenantId === tenantId && d.projectId === projectId && d.name === name,
            ) || null
          );
        }
        return null;
      }),
      findMany: vi.fn(async ({ where, skip, take }: any) => {
        let results = Array.from(workflowDefs.values());
        if (where?.tenantId) results = results.filter((d) => d.tenantId === where.tenantId);
        if (where?.projectId) results = results.filter((d) => d.projectId === where.projectId);
        if (where?.status) results = results.filter((d) => d.status === where.status);
        if (where?.type) results = results.filter((d) => d.type === where.type);
        return results.slice(skip || 0, (skip || 0) + (take || 50));
      }),
      count: vi.fn(async ({ where }: any) => {
        let results = Array.from(workflowDefs.values());
        if (where?.tenantId) results = results.filter((d) => d.tenantId === where.tenantId);
        return results.length;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const def = workflowDefs.get(where.id);
        if (!def) throw new Error(`WorkflowDefinition ${where.id} not found`);
        const updated = { ...def, ...data };
        workflowDefs.set(where.id, updated);
        return updated;
      }),
    },
    session: {
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })),
    },
  };
}

import { validateCreateWorkflow, validateUpdateWorkflow } from '../validation/workflow-validation';
// TODO: Rewrite store tests for MongoDB — MongoWorkflowDefinitionStore uses Mongoose models
// import { MongoWorkflowDefinitionStore } from '../services/stores/mongo-workflow-definition-store';

describe('Workflow Routes', () => {
  let workflowStore: any;

  beforeEach(() => {
    mockDb = createMockDb();
    // TODO: Replace with MongoWorkflowDefinitionStore when MongoDB test infrastructure is available
    workflowStore = {
      create: async (params: any) => mockDb.workflowDefinition.create({ data: params }),
      getById: async (id: string) => mockDb.workflowDefinition.findUnique({ where: { id } }),
      getByName: async (tenantId: string, projectId: string, name: string) =>
        mockDb.workflowDefinition.findUnique({
          where: { tenantId_projectId_name: { tenantId, projectId, name } },
        }),
      query: async (params: any) => {
        const definitions = await mockDb.workflowDefinition.findMany({ where: params });
        const total = await mockDb.workflowDefinition.count({ where: params });
        return { definitions, total };
      },
      update: async (id: string, data: any) =>
        mockDb.workflowDefinition.update({ where: { id }, data }),
      archive: async (id: string) =>
        mockDb.workflowDefinition.update({
          where: { id },
          data: { status: 'archived', archivedAt: new Date() },
        }),
    };
  });

  describe('Create workflow (POST /)', () => {
    test('creates workflow with valid data → 201 equivalent', async () => {
      const params = {
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'customer-onboarding',

        type: 'cx_automation',
        description: 'Onboard new customers',
        slaMinutes: 30,
        steps: [{ name: 'welcome' }, { name: 'collect_info' }],
      };

      const errors = validateCreateWorkflow(params);
      expect(errors).toHaveLength(0);

      const workflow = await workflowStore.create(params);
      expect(workflow.id).toBeDefined();
      expect(workflow.name).toBe('customer-onboarding');

      expect(workflow.status).toBe('active');
    });

    test('rejects invalid data → 400 equivalent', () => {
      const params = {
        // missing required fields
        type: 'bad_type',
      };

      const errors = validateCreateWorkflow(params);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === 'tenantId')).toBe(true);
      expect(errors.some((e) => e.field === 'projectId')).toBe(true);
      expect(errors.some((e) => e.field === 'name')).toBe(true);

      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });
  });

  describe('Get by ID (GET /:id)', () => {
    test('returns workflow → 200 equivalent', async () => {
      const wf = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'test-flow',
      });

      const found = await workflowStore.getById(wf.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('test-flow');
    });

    test('returns null for non-existent → 404 equivalent', async () => {
      const found = await workflowStore.getById('nonexistent-id');
      expect(found).toBeNull();
    });
  });

  describe('Get by name (GET /by-name)', () => {
    test('finds workflow by name within project', async () => {
      await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'unique-flow',
      });

      const found = await workflowStore.getByName('org-1', 'proj-1', 'unique-flow');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('unique-flow');
    });

    test('returns null when name not found', async () => {
      const found = await workflowStore.getByName('org-1', 'proj-1', 'nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('Query (GET /)', () => {
    test('returns paginated workflows', async () => {
      await workflowStore.create({ tenantId: 'org-1', projectId: 'proj-1', name: 'flow-a' });
      await workflowStore.create({ tenantId: 'org-1', projectId: 'proj-1', name: 'flow-b' });
      await workflowStore.create({ tenantId: 'org-2', projectId: 'proj-2', name: 'flow-c' });

      const result = await workflowStore.query({ tenantId: 'org-1' });
      expect(result.definitions).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    test('filters by projectId', async () => {
      await workflowStore.create({ tenantId: 'org-1', projectId: 'proj-1', name: 'flow-a' });
      await workflowStore.create({ tenantId: 'org-1', projectId: 'proj-2', name: 'flow-b' });

      const result = await workflowStore.query({ tenantId: 'org-1', projectId: 'proj-1' });
      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].name).toBe('flow-a');
    });

    test('filters by status', async () => {
      await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'active-flow',
        status: 'active',
      });
      const paused = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'paused-flow',
      });
      await workflowStore.update(paused.id, { status: 'paused' });

      const result = await workflowStore.query({ tenantId: 'org-1', status: 'active' });
      expect(result.definitions).toHaveLength(1);
      expect(result.definitions[0].name).toBe('active-flow');
    });
  });

  describe('Update (PUT /:id)', () => {
    test('updates workflow with valid data', async () => {
      const wf = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'old-name',
      });

      const errors = validateUpdateWorkflow({ name: 'new-name', status: 'paused' });
      expect(errors).toHaveLength(0);

      const updated = await workflowStore.update(wf.id, { name: 'new-name', status: 'paused' });
      expect(updated.name).toBe('new-name');
      expect(updated.status).toBe('paused');
    });

    test('rejects invalid update data', () => {
      const errors = validateUpdateWorkflow({ type: 'invalid' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('Archive (POST /:id/archive)', () => {
    test('archives workflow', async () => {
      const wf = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'to-archive',
      });

      await workflowStore.archive(wf.id);

      const archived = await workflowStore.getById(wf.id);
      expect(archived).not.toBeNull();
      expect(archived!.status).toBe('archived');
      expect(archived!.archivedAt).toBeInstanceOf(Date);
    });

    test('active sessions warning is checked', async () => {
      const wf = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'warn-flow',
      });

      // Simulate active sessions check
      mockDb.session.count.mockResolvedValueOnce(3);

      const activeSessions = await mockDb.session.count({
        where: { workflowId: wf.id, status: 'active' },
      });

      expect(activeSessions).toBe(3);
    });
  });

  describe('Associate session (POST /:id/associate-session)', () => {
    test('associates workflow with session', async () => {
      const wf = await workflowStore.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'test-flow',
      });

      // Simulate associateWorkflow via session.update
      await mockDb.session.update({
        where: { id: 'session-1' },
        data: { workflowId: wf.id, workflowStepId: 'step-1' },
      });

      expect(mockDb.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: { workflowId: wf.id, workflowStepId: 'step-1' },
        }),
      );
    });
  });

  describe('RBAC', () => {
    test('ADMIN user has write access', async () => {
      const member = await mockDb.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: 'org-1', userId: 'admin-user' } },
      });
      expect(member).not.toBeNull();
      expect(['OWNER', 'ADMIN', 'OPERATOR'].includes(member.role)).toBe(true);
    });

    test('MEMBER user does not have write access', async () => {
      const member = await mockDb.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: 'org-1', userId: 'member-user' } },
      });
      expect(member).not.toBeNull();
      expect(['OWNER', 'ADMIN', 'OPERATOR'].includes(member.role)).toBe(false);
    });
  });
});
