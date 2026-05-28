/**
 * System Tests: ExecutionStore + Real MongoDB
 *
 * Tests the ExecutionStore persistence layer against a real MongoDB instance
 * (MongoMemoryServer) to validate Mongoose schema enforcement, positional
 * array updates, tenant isolation at the index level, and full round-trips.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { WorkflowExecution } from '@agent-platform/database/models';
import { ExecutionStore } from '../persistence/execution-store.js';

// Deterministic encryption stub for `callbackSecret` — this suite never
// exercises the async-webhook callback flow, so the encrypt path is
// inert. The stub keeps the ExecutionStore constructor happy without
// pulling in the DEK facade.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

let store: ExecutionStore;

beforeAll(async () => {
  await setupTestMongo();
  store = new ExecutionStore(WorkflowExecution as any, testEncryptSecret);
});

afterEach(async () => {
  await clearCollections();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ─── Suite 1: Execution CRUD ─────────────────────────────────────────────

describe('Execution CRUD', () => {
  it('createExecution persists all fields', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-crud-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      triggerType: 'webhook',
      triggerPayload: { orderId: 'ord-123' },
      steps: [
        { stepId: 's1', name: 'Step1', type: 'http', status: 'pending' },
        { stepId: 's2', name: 'Step2', type: 'condition', status: 'pending' },
      ],
    });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-crud-1' }).lean();
    expect(doc).toBeTruthy();
    expect(doc!.tenantId).toBe('t1');
    expect(doc!.projectId).toBe('p1');
    expect(doc!.workflowId).toBe('wf-1');
    expect(doc!.status).toBe('running');
    expect(doc!.triggerType).toBe('webhook');
    expect(doc!.input).toEqual({ orderId: 'ord-123' });
    expect(doc!.startedAt).toBeInstanceOf(Date);
    // Step data lives in context.steps (not nodeExecutions)
    const ctxSteps = (doc as any).context?.steps ?? {};
    expect(Object.keys(ctxSteps)).toHaveLength(2);
    expect(ctxSteps.Step1?.stepId).toBe('s1');
    expect(ctxSteps.Step1?.nodeType).toBe('http');
    expect(ctxSteps.Step1?.status).toBe('pending');
  });

  it('updateStepStatus writes context.steps when context is provided', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-crud-2',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-2',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const ctx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-2', name: 'WF', executionId: 'exec-crud-2' },
      tenant: { tenantId: 't1', projectId: 'p1' },
      steps: {
        Step1: { nodeType: 'http', status: 'pending', stepId: 's1' },
        Step2: {
          nodeType: 'condition',
          status: 'completed',
          stepId: 's2',
          output: { conditionMet: true },
          durationMs: 5,
        },
        Step3: { nodeType: 'delay', status: 'pending', stepId: 's3' },
      },
      vars: {},
    };

    await store.updateStepStatus('exec-crud-2', 't1', 'p1', 's2', 'completed', { context: ctx });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-crud-2' }).lean();
    const ctxSteps = (doc as any).context?.steps ?? {};
    expect(ctxSteps.Step1?.status).toBe('pending');
    expect(ctxSteps.Step2?.status).toBe('completed');
    expect(ctxSteps.Step2?.output).toEqual({ conditionMet: true });
    expect(ctxSteps.Step2?.durationMs).toBe(5);
    expect(ctxSteps.Step3?.status).toBe('pending');
  });

  it('updateExecutionStatus sets status and context', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-crud-3',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-3',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const ctx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-3', name: 'Test', executionId: 'exec-crud-3' },
      tenant: { tenantId: 't1', projectId: 'p1' },
      steps: {},
      vars: { total: 42 },
    };

    await store.updateExecutionStatus('exec-crud-3', 't1', 'p1', 'completed', {
      context: ctx,
      completedAt: new Date('2026-03-01T12:00:00Z'),
    });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-crud-3' }).lean();
    expect(doc!.status).toBe('completed');
    expect(doc!.context).toEqual(ctx);
    expect(doc!.completedAt).toEqual(new Date('2026-03-01T12:00:00Z'));
  });

  it('getByTenant returns only matching tenant+project', async ({ skip }) => {
    requireMongo(skip);

    // 2 for t1/p1
    await store.createExecution({
      executionId: 'exec-crud-4a',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-4',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });
    await store.createExecution({
      executionId: 'exec-crud-4b',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-4',
      status: 'completed',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });
    // 1 for t2/p1
    await store.createExecution({
      executionId: 'exec-crud-4c',
      tenantId: 't2',
      projectId: 'p1',
      workflowId: 'wf-4',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const results = await store.getByTenant('t1', 'p1');
    expect(results).toHaveLength(2);
  });

  it('getById returns null for wrong tenant', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-crud-5',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-5',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const result = await store.getById('exec-crud-5', 't2', 'p1');
    expect(result).toBeNull();
  });
});

// ─── Suite 2: Schema Validation ──────────────────────────────────────────

describe('Schema Validation', () => {
  it('rejects missing tenantId', async ({ skip }) => {
    requireMongo(skip);

    await expect(
      WorkflowExecution.create({
        _id: 'exec-val-1',
        // tenantId omitted
        projectId: 'p1',
        workflowId: 'wf-1',
        restateWorkflowId: 'exec-val-1',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: {},
        steps: [],
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/tenantId/i);
  });

  it('rejects invalid triggerType', async ({ skip }) => {
    requireMongo(skip);

    await expect(
      WorkflowExecution.create({
        _id: 'exec-val-2',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        restateWorkflowId: 'exec-val-2',
        status: 'running',
        triggerType: 'invalid',
        triggerPayload: {},
        steps: [],
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/triggerType/i);
  });

  it('rejects invalid nodeExecution status enum', async ({ skip }) => {
    requireMongo(skip);

    // NodeExecutionSchema.status is the only enum-enforced field on a nested
    // node — nodeType is a free-form string. Use `.create()` (which runs
    // validators) so the enum check fires; ExecutionStore uses `updateOne`
    // with upsert, which skips validators by default.
    await expect(
      WorkflowExecution.create({
        _id: 'exec-val-3',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        restateWorkflowId: 'exec-val-3',
        status: 'running',
        triggerType: 'studio',
        input: {},
        nodeExecutions: [
          { nodeId: 's1', nodeName: 'Step 1', nodeType: 'http', status: 'bogus-status' },
        ],
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/status/i);
  });

  it('unique restateWorkflowId per tenant enforced', async ({ skip }) => {
    requireMongo(skip);

    await WorkflowExecution.create({
      _id: 'exec-val-4a',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      restateWorkflowId: 'restate-dup',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
      startedAt: new Date(),
    });

    await expect(
      WorkflowExecution.create({
        _id: 'exec-val-4b',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        restateWorkflowId: 'restate-dup',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: {},
        steps: [],
        startedAt: new Date(),
      }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });
});

// ─── Suite 3: Step Status Transitions ────────────────────────────────────

describe('Step Status Transitions', () => {
  it('running → completed writes context.steps with timestamps and output', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-trans-1',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const startedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    const ctx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-trans-1' },
      tenant: { tenantId: 't1', projectId: 'p1' },
      steps: {
        Step1: {
          nodeType: 'http',
          stepId: 's1',
          status: 'completed',
          startedAt,
          completedAt,
          durationMs: 120,
          output: { statusCode: 200, body: { ok: true } },
        },
      },
      vars: {},
    };
    await store.updateStepStatus('exec-trans-1', 't1', 'p1', 's1', 'completed', { context: ctx });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-trans-1' }).lean();
    const step = (doc as any).context?.steps?.Step1;
    expect(step.status).toBe('completed');
    expect(step.startedAt).toBe(startedAt);
    expect(step.completedAt).toBe(completedAt);
    expect(step.durationMs).toBe(120);
    expect(step.output).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it('running → failed writes context.steps with error', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-trans-2',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-2',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    const completedAt = new Date().toISOString();
    const ctx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-2', name: 'WF', executionId: 'exec-trans-2' },
      tenant: { tenantId: 't1', projectId: 'p1' },
      steps: {
        Step1: {
          nodeType: 'http',
          stepId: 's1',
          status: 'failed',
          completedAt,
          error: { code: 'HTTP_ERROR', message: 'Connection refused' },
          durationMs: 50,
        },
      },
      vars: {},
    };
    await store.updateStepStatus('exec-trans-2', 't1', 'p1', 's1', 'failed', { context: ctx });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-trans-2' }).lean();
    const step = (doc as any).context?.steps?.Step1;
    expect(step.status).toBe('failed');
    expect(step.error).toEqual({ code: 'HTTP_ERROR', message: 'Connection refused' });
    expect(step.completedAt).toBe(completedAt);
  });

  it('context.steps reflects all steps when written atomically', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-trans-3',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-3',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    // Write context snapshot with step 2 completed and others pending
    const ctx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-3', name: 'WF', executionId: 'exec-trans-3' },
      tenant: { tenantId: 't1', projectId: 'p1' },
      steps: {
        Step1: { nodeType: 'http', stepId: 's1', status: 'pending' },
        Step2: {
          nodeType: 'condition',
          stepId: 's2',
          status: 'completed',
          output: { conditionMet: false },
          durationMs: 2,
        },
        Step3: { nodeType: 'delay', stepId: 's3', status: 'pending' },
      },
      vars: {},
    };
    await store.updateStepStatus('exec-trans-3', 't1', 'p1', 's2', 'completed', { context: ctx });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-trans-3' }).lean();
    const ctxSteps = (doc as any).context?.steps ?? {};
    expect(ctxSteps.Step1?.status).toBe('pending');
    expect(ctxSteps.Step1?.output).toBeUndefined();
    expect(ctxSteps.Step2?.status).toBe('completed');
    expect(ctxSteps.Step2?.output).toEqual({ conditionMet: false });
    expect(ctxSteps.Step3?.status).toBe('pending');
    expect(ctxSteps.Step3?.output).toBeUndefined();
  });
});

// ─── Suite 4: Tenant Isolation ───────────────────────────────────────────

describe('Tenant Isolation', () => {
  it('same restateWorkflowId allowed for different tenants', async ({ skip }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-iso-1a',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
    });

    // Same restateWorkflowId (executionId) but different tenant — should succeed
    // Note: ExecutionStore sets restateWorkflowId = executionId, so we need
    // to use the model directly to test the unique index with same restateWorkflowId
    await WorkflowExecution.create({
      _id: 'exec-iso-1b',
      tenantId: 't2',
      projectId: 'p1',
      workflowId: 'wf-1',
      restateWorkflowId: 'exec-iso-1a', // same restateWorkflowId as t1's doc
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [],
      startedAt: new Date(),
    });

    const t1Doc = await WorkflowExecution.findOne({ _id: 'exec-iso-1a' });
    const t2Doc = await WorkflowExecution.findOne({ _id: 'exec-iso-1b' });
    expect(t1Doc).toBeTruthy();
    expect(t2Doc).toBeTruthy();
  });

  it('cross-tenant updateStepStatus is a no-op (wrong tenant filter does not match)', async ({
    skip,
  }) => {
    requireMongo(skip);

    await store.createExecution({
      executionId: 'exec-iso-2',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-2',
      status: 'running',
      triggerType: 'studio',
      triggerPayload: {},
      steps: [{ stepId: 's1', name: 'Step1', type: 'http', status: 'pending' }],
    });

    const hackedCtx = {
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-2', name: 'WF', executionId: 'exec-iso-2' },
      tenant: { tenantId: 't2', projectId: 'p1' },
      steps: {
        Step1: { nodeType: 'http', stepId: 's1', status: 'completed', output: { hacked: true } },
      },
      vars: {},
    };

    // Wrong tenant — findOneAndUpdate filter { tenantId: 't2' } won't match the doc
    await store.updateStepStatus('exec-iso-2', 't2', 'p1', 's1', 'completed', {
      context: hackedCtx,
    });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-iso-2' }).lean();
    const ctxSteps = (doc as any).context?.steps ?? {};
    // The initial context.steps from createExecution should be unchanged
    expect(ctxSteps.Step1?.status).toBe('pending');
    expect(ctxSteps.Step1?.output).toBeUndefined();
  });
});
