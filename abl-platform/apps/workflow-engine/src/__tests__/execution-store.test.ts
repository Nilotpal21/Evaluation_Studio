import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionStore, type WorkflowExecutionModel } from '../persistence/execution-store.js';

function makeMockModel(): WorkflowExecutionModel {
  return {
    create: vi.fn().mockResolvedValue({}),
    updateOne: vi.fn().mockResolvedValue({}),
    findOneAndUpdate: vi.fn().mockResolvedValue({}),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
}

const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

describe('ExecutionStore', () => {
  let model: WorkflowExecutionModel;
  let store: ExecutionStore;

  beforeEach(() => {
    model = makeMockModel();
    store = new ExecutionStore(model, testEncryptSecret);
  });

  describe('createExecution', () => {
    it('creates a document with initial context trigger, vars, and steps (not nodeExecutions)', async () => {
      await store.createExecution({
        executionId: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: { key: 'value' },
        triggerMetadata: { firedAt: '2026-04-29T00:00:00.000Z' },
        steps: [
          { stepId: 'start', name: 'Start', type: 'start', status: 'completed' },
          { stepId: 's1', name: 'Step 1', type: 'api', status: 'pending' },
        ],
      });

      expect(model.updateOne).toHaveBeenCalledWith(
        { _id: 'exec-1', tenantId: 't1', projectId: 'p1' },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            tenantId: 't1',
            projectId: 'p1',
            workflowId: 'wf-1',
            restateWorkflowId: 'exec-1',
            status: 'running',
            triggerType: 'studio',
            input: { key: 'value' },
            triggerMetadata: { firedAt: '2026-04-29T00:00:00.000Z' },
            context: {
              trigger: {
                type: 'studio',
                payload: { key: 'value' },
                metadata: { firedAt: '2026-04-29T00:00:00.000Z' },
              },
              steps: {
                start: {
                  nodeType: 'start',
                  status: 'completed',
                  stepId: 'start',
                  completedAt: expect.any(String),
                  durationMs: 0,
                  input: { key: 'value' },
                  output: { key: 'value' },
                },
                'Step 1': { nodeType: 'api', status: 'pending', stepId: 's1' },
              },
            },
            startedAt: expect.any(Date),
          }),
        }),
        { upsert: true },
      );
    });

    it('does not include nodeExecutions in the insert', async () => {
      await store.createExecution({
        executionId: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: {},
        steps: [],
      });

      const call = (model.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      const setOnInsert = (call[1] as { $setOnInsert: Record<string, unknown> }).$setOnInsert;
      expect(setOnInsert).not.toHaveProperty('nodeExecutions');
    });

    it('persists loopConfig mode and concurrencyLimit in the initial step context', async () => {
      await store.createExecution({
        executionId: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: {},
        steps: [
          { stepId: 'start', name: 'Start', type: 'start', status: 'completed' },
          {
            stepId: 'loop-1',
            name: 'MyLoop',
            type: 'loop',
            status: 'pending',
            loopConfig: { mode: 'parallel', concurrencyLimit: 3 },
          },
        ],
      });

      const call = (model.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      const setOnInsert = (call[1] as { $setOnInsert: Record<string, unknown> }).$setOnInsert;
      const context = setOnInsert.context as {
        steps: Record<string, { nodeType: string; input?: Record<string, unknown> }>;
      };
      expect(context.steps['MyLoop'].input).toEqual({ mode: 'parallel', concurrencyLimit: 3 });
    });

    it('omits input field for non-loop steps in initial context', async () => {
      await store.createExecution({
        executionId: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'running',
        triggerType: 'studio',
        triggerPayload: {},
        steps: [
          { stepId: 'start', name: 'Start', type: 'start', status: 'completed' },
          { stepId: 'api-1', name: 'CallAPI', type: 'http', status: 'pending' },
        ],
      });

      const call = (model.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      const setOnInsert = (call[1] as { $setOnInsert: Record<string, unknown> }).$setOnInsert;
      const context = setOnInsert.context as {
        steps: Record<string, { input?: unknown }>;
      };
      expect(context.steps['CallAPI']).not.toHaveProperty('input');
    });
  });

  describe('updateStepStatus', () => {
    it('does nothing when no context is provided', async () => {
      await store.updateStepStatus('exec-1', 't1', 'p1', 's1', 'running');
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('writes context when provided, scoped to tenant+project', async () => {
      const ctx = {
        steps: { Start: { nodeType: 'start', status: 'running', stepId: 'start' } },
        vars: {},
        trigger: { type: 'studio', payload: {} },
        workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
        tenant: { tenantId: 't1', projectId: 'p1' },
      } as any;

      await store.updateStepStatus('exec-1', 't1', 'p1', 'start', 'running', { context: ctx });

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          status: { $nin: ['completed', 'failed', 'rejected', 'cancelled'] },
        },
        {
          $set: {
            context: {
              steps: { Start: { nodeType: 'start', status: 'running', stepId: 'start' } },
              vars: {},
              trigger: { type: 'studio', payload: {} },
            },
          },
        },
        undefined,
      );
    });

    it('writes step patch and root public context when both are provided', async () => {
      const ctx = {
        steps: {
          Loop: { nodeType: 'loop', status: 'running', stepId: 'loop-1' },
          Other: { nodeType: 'http', status: 'pending', stepId: 'other-1' },
        },
        vars: { loopResults: [{ ok: true }] },
        trigger: { type: 'studio', payload: { items: [1] } },
        workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
        tenant: { tenantId: 't1', projectId: 'p1' },
      } as any;

      await store.updateStepStatus('exec-1', 't1', 'p1', 'loop-1', 'running', {
        stepKey: 'Loop',
        stepData: ctx.steps.Loop,
        context: ctx,
      });

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          status: { $nin: ['completed', 'failed', 'rejected', 'cancelled'] },
        },
        {
          $set: {
            'context.steps.Loop': { nodeType: 'loop', status: 'running', stepId: 'loop-1' },
            'context.vars': { loopResults: [{ ok: true }] },
            'context.trigger': { type: 'studio', payload: { items: [1] } },
          },
        },
        undefined,
      );
    });

    it('strips workflow and tenant sub-objects from context before persisting', async () => {
      const ctx = {
        steps: {},
        vars: {},
        trigger: { type: 'studio', payload: {} },
        workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
        tenant: { tenantId: 't1', projectId: 'p1' },
      } as any;

      await store.updateStepStatus('exec-1', 't1', 'p1', 's1', 'running', { context: ctx });

      const call = (model.findOneAndUpdate as ReturnType<typeof vi.fn>).mock.calls[0];
      const setCtx = (call[1] as { $set: { context: unknown } }).$set.context as Record<
        string,
        unknown
      >;
      expect(setCtx).not.toHaveProperty('workflow');
      expect(setCtx).not.toHaveProperty('tenant');
    });

    it('does not let late step writes mutate terminal executions', async () => {
      const ctx = {
        steps: { Loop: { nodeType: 'loop', status: 'running', stepId: 'loop-1' } },
        trigger: { type: 'studio', payload: {} },
        workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
        tenant: { tenantId: 't1', projectId: 'p1' },
      } as any;

      await store.updateStepStatus('exec-1', 't1', 'p1', 'loop-1', 'running', {
        stepKey: 'Loop',
        stepData: ctx.steps.Loop,
        context: ctx,
      });

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: { $nin: ['completed', 'failed', 'rejected', 'cancelled'] },
        }),
        expect.any(Object),
        undefined,
      );
    });

    it('callbackSecret is accepted but does not write to nodeExecutions (dead code path)', async () => {
      const ctx = {
        steps: {},
        vars: {},
        trigger: { type: 'studio', payload: {} },
        workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
        tenant: { tenantId: 't1', projectId: 'p1' },
      } as any;

      await store.updateStepStatus('exec-1', 't1', 'p1', 's1', 'waiting_callback', {
        context: ctx,
        callbackSecret: 'whsec_plaintext-material',
      });

      const call = (model.findOneAndUpdate as ReturnType<typeof vi.fn>).mock.calls[0];
      const setPayload = (call[1] as { $set: Record<string, unknown> }).$set;
      expect(setPayload).not.toHaveProperty('nodeExecutions.$.callbackSecret');
    });
  });

  describe('updateExecutionStatus', () => {
    it('updates execution status with tenant+project scoped query', async () => {
      await store.updateExecutionStatus('exec-1', 't1', 'p1', 'completed', {
        completedAt: new Date('2026-02-28'),
      });

      // completed writes guard against overwriting an authoritative cancelled/failed/rejected
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          status: { $nin: ['cancelled', 'failed', 'rejected'] },
        },
        {
          $set: expect.objectContaining({
            status: 'completed',
            completedAt: new Date('2026-02-28'),
          }),
        },
        undefined,
      );
    });

    it('includes error on failure', async () => {
      await store.updateExecutionStatus('exec-1', 't1', 'p1', 'failed', {
        error: { code: 'WF_FAILED', message: 'Step failed' },
      });

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'exec-1', tenantId: 't1', projectId: 'p1' },
        {
          $set: expect.objectContaining({
            status: 'failed',
            error: { code: 'WF_FAILED', message: 'Step failed' },
          }),
        },
        undefined,
      );
    });

    it('includes context, output, startTime, and endTime when provided', async () => {
      const ctx = { foo: 'bar' } as any;
      await store.updateExecutionStatus('exec-1', 't1', 'p1', 'completed', {
        context: ctx,
        output: { result: 'ok' },
        startTime: '2026-02-28T10:00:00.000Z',
        endTime: '2026-02-28T10:05:00.000Z',
      });

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: 'exec-1',
          tenantId: 't1',
          projectId: 'p1',
          status: { $nin: ['cancelled', 'failed', 'rejected'] },
        },
        {
          $set: expect.objectContaining({
            status: 'completed',
            // updateExecutionStatus uses per-field $set to preserve context.loopData.
            // ctx = { foo: 'bar' } → emits 'context.foo': 'bar' (workflow/tenant stripped).
            'context.foo': 'bar',
            output: { result: 'ok' },
            startTime: '2026-02-28T10:00:00.000Z',
            endTime: '2026-02-28T10:05:00.000Z',
          }),
        },
        undefined,
      );
    });

    it('omits optional fields when not supplied (only status is set)', async () => {
      await store.updateExecutionStatus('exec-1', 't1', 'p1', 'running');
      const call = (model.findOneAndUpdate as any).mock.calls[0];
      const setDoc = call[1].$set as Record<string, unknown>;
      expect(setDoc).toEqual({ status: 'running' });
    });
  });

  describe('getByTenant', () => {
    it('queries with tenantId and projectId scope', async () => {
      await store.getByTenant('t1', 'p1');
      expect(model.find).toHaveBeenCalledWith({ tenantId: 't1', projectId: 'p1' });
    });

    it('uses default limit of 50', async () => {
      await store.getByTenant('t1', 'p1');
      const sortResult = (model.find as ReturnType<typeof vi.fn>).mock.results[0].value;
      const limitResult = sortResult.sort.mock.results[0].value;
      expect(limitResult.limit).toHaveBeenCalledWith(50);
    });

    it('accepts custom limit', async () => {
      await store.getByTenant('t1', 'p1', 10);
      const sortResult = (model.find as ReturnType<typeof vi.fn>).mock.results[0].value;
      const limitResult = sortResult.sort.mock.results[0].value;
      expect(limitResult.limit).toHaveBeenCalledWith(10);
    });
  });

  describe('getById', () => {
    it('queries with _id, tenantId, and projectId scope', async () => {
      await store.getById('exec-1', 't1', 'p1');
      expect(model.findOne).toHaveBeenCalledWith({
        _id: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
      });
    });
  });
});
