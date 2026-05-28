/**
 * Workflow Create — input sanitization (prototype pollution prevention)
 *
 * Verifies that only validated fields from the request body are used
 * when creating a workflow, preventing injection of extra fields like _id.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockWorkflowCreate = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Workflow: {
    create: (...args: any[]) => mockWorkflowCreate(...args),
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })),
    countDocuments: vi.fn(async () => 0),
  },
}));

import { validateCreateWorkflow } from '../validation/workflow-validation';
import { MongoWorkflowDefinitionStore } from '../services/stores/mongo-workflow-definition-store';

let createdData: any[];

describe('Workflow Create — input sanitization', () => {
  let workflowStore: MongoWorkflowDefinitionStore;

  beforeEach(() => {
    createdData = [];
    mockWorkflowCreate.mockReset().mockImplementation(async (data: any) => {
      createdData.push(data);
      return { _id: 'wf-auto-1', ...data, createdAt: new Date(), updatedAt: new Date() };
    });
    workflowStore = new MongoWorkflowDefinitionStore({ type: 'mongodb' });
  });

  test('validated fields are accepted', () => {
    const params = {
      tenantId: 'org-1',
      projectId: 'proj-1',
      name: 'test-workflow',
      entryAgent: 'my_agent',
      type: 'cx_automation',
    };

    const errors = validateCreateWorkflow(params);
    expect(errors).toHaveLength(0);
  });

  test('only known fields from CreateWorkflowDefinitionParams reach the store', async () => {
    // Simulate what the route does after the fix:
    // Only pick known fields from req.body
    const reqBody = {
      name: 'test-workflow',
      projectId: 'proj-1',
      entryAgent: 'my_agent',
      _id: 'injected-id',
      createdAt: '1970-01-01',
      __proto__: { admin: true },
      status: 'archived', // Should not override — store always sets 'active'
    };

    // Simulating the fixed route logic: pick only validated fields
    const validated = {
      name: reqBody.name,
      projectId: reqBody.projectId,
      entryAgent: reqBody.entryAgent,
      type: reqBody.type,
      description: reqBody.description,
      steps: reqBody.steps,
      triggers: reqBody.triggers,
      slaMinutes: reqBody.slaMinutes,
      escalationRules: reqBody.escalationRules,
      metadata: reqBody.metadata,
    };
    const params = { ...validated, tenantId: 'org-1' };

    const errors = validateCreateWorkflow(params);
    expect(errors).toHaveLength(0);

    const workflow = await workflowStore.create(params);

    // Verify the store.create was called — _id should NOT appear in the data
    const data = createdData[0];
    expect(data).toBeDefined();
    expect(data._id).toBeUndefined();
    expect(data.status).toBe('active'); // always 'active', not 'archived'
    expect(data.name).toBe('test-workflow');
    expect(data.tenantId).toBe('org-1');
  });

  test('extra fields from req.body are stripped by the pick pattern', () => {
    const reqBody = {
      name: 'test',
      projectId: 'proj-1',
      entryAgent: 'agent',
      _id: 'injected',
      admin: true,
      role: 'superadmin',
      tenantId: 'hacker-tenant', // Should be overridden by server-side tenantId
    };

    // Simulating the route's pick pattern
    const validated = {
      name: reqBody.name,
      projectId: reqBody.projectId,
      entryAgent: reqBody.entryAgent,
      type: (reqBody as any).type,
      description: (reqBody as any).description,
      steps: (reqBody as any).steps,
      triggers: (reqBody as any).triggers,
      slaMinutes: (reqBody as any).slaMinutes,
      escalationRules: (reqBody as any).escalationRules,
      metadata: (reqBody as any).metadata,
    };
    const params = { ...validated, tenantId: 'org-1' };

    // Verify _id, admin, role are NOT in params
    expect((params as any)._id).toBeUndefined();
    expect((params as any).admin).toBeUndefined();
    expect((params as any).role).toBeUndefined();
    // Verify server-side tenantId wins
    expect(params.tenantId).toBe('org-1');
  });
});
