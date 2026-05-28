/**
 * Unit test: ExecutionStore session threading.
 *
 * Uses a recording test double injected via the `WorkflowExecutionModel`
 * interface (constructor DI), not `vi.mock()`. Verifies that when
 * `options.session` is passed into `createExecution`, `updateStepStatus`,
 * and `updateExecutionStatus`, the session is forwarded into the
 * underlying `updateOne`/`findOneAndUpdate` options object without
 * dropping the existing options (e.g., `upsert: true`).
 *
 * LLD §1.5 — Phase 1, task 1.5.
 */

import { describe, expect, it } from 'vitest';
import { ExecutionStore, type WorkflowExecutionModel } from '../execution-store.js';

type UpdateOneCall = {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  options?: Record<string, unknown>;
};

type FindOneAndUpdateCall = {
  filter: Record<string, unknown>;
  update: Record<string, unknown> | Record<string, unknown>[];
  options?: Record<string, unknown>;
};

const noopEncryptSecret = async (plaintext: string) => plaintext;

function makeRecordingModel(): {
  model: WorkflowExecutionModel;
  updateOneCalls: UpdateOneCall[];
  findOneAndUpdateCalls: FindOneAndUpdateCall[];
} {
  const updateOneCalls: UpdateOneCall[] = [];
  const findOneAndUpdateCalls: FindOneAndUpdateCall[] = [];

  const model: WorkflowExecutionModel = {
    async create() {
      return {};
    },
    async updateOne(filter, update, options) {
      updateOneCalls.push({ filter, update, options });
      return { acknowledged: true };
    },
    async findOneAndUpdate(filter, update, options) {
      findOneAndUpdateCalls.push({ filter, update, options });
      return {};
    },
    async findOne() {
      return null;
    },
    find() {
      return {
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit() {
          return this;
        },
        async lean() {
          return [];
        },
      };
    },
  };

  return { model, updateOneCalls, findOneAndUpdateCalls };
}

describe('ExecutionStore session threading', () => {
  it('createExecution merges session into upsert options without clobbering { upsert: true }', async () => {
    const { model, updateOneCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);
    const session = { id: 'session-abc' } as unknown as Parameters<
      typeof store.createExecution
    >[1] extends infer O
      ? O
      : never;

    await store.createExecution(
      {
        executionId: 'exec-1',
        tenantId: 't1',
        projectId: 'p1',
        workflowId: 'wf-1',
        status: 'running',
        triggerType: 'api',
        triggerPayload: {},
        steps: [],
      },
      { session: session as never },
    );

    expect(updateOneCalls).toHaveLength(1);
    const call = updateOneCalls[0];
    expect(call.options).toMatchObject({ upsert: true });
    expect(call.options?.session).toBeDefined();
    // Critical: upsert MUST survive the merge — see LLD §3.1.
    expect(call.options?.upsert).toBe(true);
  });

  it('createExecution omits session key when options.session is undefined', async () => {
    const { model, updateOneCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);

    await store.createExecution({
      executionId: 'exec-2',
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      triggerType: 'api',
      triggerPayload: {},
      steps: [],
    });

    expect(updateOneCalls).toHaveLength(1);
    const call = updateOneCalls[0];
    expect(call.options?.upsert).toBe(true);
    expect(call.options).not.toHaveProperty('session');
  });

  it('updateStepStatus forwards session when provided', async () => {
    const { model, findOneAndUpdateCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);
    const fakeSession = { sessionId: 's-1' };
    const ctx = {
      steps: { 'step-1': { nodeType: 'api', status: 'completed', stepId: 'step-1' } },
      vars: {},
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
      tenant: { tenantId: 't1', projectId: 'p1' },
    } as never;

    await store.updateStepStatus(
      'exec-1',
      't1',
      'p1',
      'step-1',
      'completed',
      { context: ctx },
      { session: fakeSession as never },
    );

    expect(findOneAndUpdateCalls).toHaveLength(1);
    expect(findOneAndUpdateCalls[0].options?.session).toBe(fakeSession);
  });

  it('updateStepStatus passes undefined options when session omitted', async () => {
    const { model, findOneAndUpdateCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);
    const ctx = {
      steps: { 'step-1': { nodeType: 'api', status: 'running', stepId: 'step-1' } },
      vars: {},
      trigger: { type: 'studio', payload: {} },
      workflow: { id: 'wf-1', name: 'WF', executionId: 'exec-1' },
      tenant: { tenantId: 't1', projectId: 'p1' },
    } as never;

    await store.updateStepStatus('exec-1', 't1', 'p1', 'step-1', 'running', { context: ctx });

    expect(findOneAndUpdateCalls).toHaveLength(1);
    expect(findOneAndUpdateCalls[0].options).toBeUndefined();
  });

  it('updateExecutionStatus forwards session to both primary update and terminal duration update', async () => {
    const { model, findOneAndUpdateCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);
    const fakeSession = { sessionId: 's-2' };

    await store.updateExecutionStatus('exec-1', 't1', 'p1', 'completed', undefined, {
      session: fakeSession as never,
    });

    // One for the primary $set, one for the loop scratch key cleanup (fire-and-forget),
    // and one for the terminal durationMs aggregation.
    expect(findOneAndUpdateCalls).toHaveLength(3);
    expect(findOneAndUpdateCalls[0].options?.session).toBe(fakeSession);
    expect(findOneAndUpdateCalls[1].options?.session).toBe(fakeSession);
    expect(findOneAndUpdateCalls[2].options?.session).toBe(fakeSession);
  });

  it('updateExecutionStatus with non-terminal status performs only the primary update', async () => {
    const { model, findOneAndUpdateCalls } = makeRecordingModel();
    const store = new ExecutionStore(model, noopEncryptSecret);

    await store.updateExecutionStatus('exec-1', 't1', 'p1', 'running');

    expect(findOneAndUpdateCalls).toHaveLength(1);
  });
});
