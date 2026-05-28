/**
 * System Tests: runWorkflow() + Real ExecutionStore + Real MongoDB
 *
 * Tests the full workflow handler with a real ExecutionStore backed by
 * MongoMemoryServer. HTTP calls are mocked via globalThis.fetch, but
 * persistence is real — we verify database state after each workflow run.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  requireMongo,
} from './helpers/setup-mongo.js';
import { WorkflowExecution } from '@agent-platform/database/models';
import { ExecutionStore } from '../persistence/execution-store.js';
import {
  runWorkflow,
  type WorkflowExecutionInput,
  type WorkflowHandlerDeps,
  type StatusPublisher,
} from '../handlers/workflow-handler.js';
import type { StepDispatcherDeps } from '../handlers/step-dispatcher.js';

// ─── Mock SSRF validator to allow all URLs in tests ──────────────────────

vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: () => {},
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

// ─── Setup ───────────────────────────────────────────────────────────────

let store: ExecutionStore;
let publisher: StatusPublisher;

function makePublisher(): StatusPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function makeDeps(overrides?: Partial<StepDispatcherDeps>): WorkflowHandlerDeps {
  return {
    persistence: store,
    publisher,
    dispatcherDeps: { ...overrides },
  };
}

function makeHttpInput(overrides?: Partial<WorkflowExecutionInput>): WorkflowExecutionInput {
  return {
    workflowId: 'wf-1',
    workflowName: 'Test Workflow',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'studio',
    triggerPayload: { source: 'test' },
    steps: [
      {
        id: 'step-http-1',
        type: 'http' as const,
        method: 'GET' as const,
        url: 'https://api.example.com/data',
      },
    ],
    ...overrides,
  };
}

// Deterministic encryption stub for `ExecutionStore` — this suite does
// not exercise the async-webhook callback flow, so the encrypt path is
// never reached. Stub keeps the ExecutionStore constructor happy.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

beforeAll(async () => {
  await setupTestMongo();
  store = new ExecutionStore(WorkflowExecution as any, testEncryptSecret);
});

afterEach(async () => {
  await clearCollections();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ─── Suite 1: End-to-End Persistence ─────────────────────────────────────

describe('End-to-End Persistence', () => {
  it('single HTTP step persisted', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await runWorkflow(makeHttpInput(), 'exec-h-1', makeDeps());

    expect(result.status).toBe('completed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-h-1' }).lean();
    expect(doc).toBeTruthy();
    expect(doc!.status).toBe('completed');
    // Start + input step + End = 3 nodeExecutions (both boundary steps are
    // first-class records with the full lifecycle).
    expect(doc!.nodeExecutions).toHaveLength(3);
    expect(doc!.nodeExecutions[0].nodeId).toBe('start');
    expect(doc!.nodeExecutions[doc!.nodeExecutions.length - 1].nodeId).toBe('end');
    const httpStep = doc!.nodeExecutions[1];
    expect(httpStep.status).toBe('completed');
    expect(httpStep.durationMs).toBeGreaterThanOrEqual(0);
    expect(httpStep.completedAt).toBeInstanceOf(Date);
    expect(httpStep.output).toEqual(
      expect.objectContaining({ statusCode: 200, body: { ok: true } }),
    );
  });

  it('multi-step workflow context persisted', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: 99 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const input = makeHttpInput({
      steps: [
        {
          id: 'step-cond-1',
          type: 'condition' as const,
          expression: '{{trigger.payload.source}}',
          thenSteps: [],
          elseSteps: [],
        },
        {
          id: 'step-delay-1',
          type: 'delay' as const,
          duration: 'PT0S',
        },
        {
          id: 'step-http-1',
          type: 'http' as const,
          method: 'GET' as const,
          url: 'https://api.example.com/data',
        },
      ],
    });

    const result = await runWorkflow(input, 'exec-h-2', makeDeps());

    expect(result.status).toBe('completed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-h-2' }).lean();
    // Start + 3 input steps + End = 5 nodeExecutions, all completed.
    expect(doc!.nodeExecutions).toHaveLength(5);
    expect(doc!.nodeExecutions[0].nodeId).toBe('start');
    expect(doc!.nodeExecutions[0].status).toBe('completed');
    expect(doc!.nodeExecutions[1].status).toBe('completed');
    expect(doc!.nodeExecutions[2].status).toBe('completed');
    expect(doc!.nodeExecutions[3].status).toBe('completed');
    expect(doc!.nodeExecutions[4].nodeId).toBe('end');
    expect(doc!.nodeExecutions[4].status).toBe('completed');
    expect(doc!.context).toBeTruthy();
    expect((doc!.context as any).steps).toBeTruthy();
  });

  it('failed workflow persisted with error', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    const result = await runWorkflow(makeHttpInput(), 'exec-h-3', makeDeps());

    expect(result.status).toBe('failed');
    expect(result.error!.code).toBe('WORKFLOW_FAILED');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-h-3' }).lean();
    expect(doc!.status).toBe('failed');
    expect(doc!.error).toEqual(
      expect.objectContaining({ code: 'WORKFLOW_FAILED', message: 'Connection refused' }),
    );
  });

  it('empty workflow creates and completes', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    const input = makeHttpInput({ steps: [] });
    const result = await runWorkflow(input, 'exec-h-4', makeDeps());

    expect(result.status).toBe('completed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-h-4' }).lean();
    expect(doc!.status).toBe('completed');
    // Start + End records — both are first-class boundary steps even when
    // the workflow has zero user steps.
    expect(doc!.nodeExecutions).toHaveLength(2);
    expect(doc!.nodeExecutions[0].nodeId).toBe('start');
    expect(doc!.nodeExecutions[1].nodeId).toBe('end');
    expect(doc!.completedAt).toBeInstanceOf(Date);
  });
});

// ─── Suite 2: Real Tenant Isolation ──────────────────────────────────────

describe('Real Tenant Isolation', () => {
  it('execution stored with correct tenantId', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const input = makeHttpInput({ tenantId: 'tenant-abc', projectId: 'proj-xyz' });
    await runWorkflow(input, 'exec-t-1', makeDeps());

    const doc = await WorkflowExecution.findOne({ _id: 'exec-t-1' }).lean();
    expect(doc!.tenantId).toBe('tenant-abc');
    expect(doc!.projectId).toBe('proj-xyz');
  });

  it('two tenants run same workflowId independently', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const input1 = makeHttpInput({ tenantId: 't1', projectId: 'p1' });
    const input2 = makeHttpInput({ tenantId: 't2', projectId: 'p1' });

    await runWorkflow(input1, 'exec-t-2a', makeDeps());

    // Need fresh publisher for second run
    publisher = makePublisher();
    await runWorkflow(input2, 'exec-t-2b', makeDeps());

    const docs = await WorkflowExecution.find({ workflowId: 'wf-1' }).lean();
    expect(docs).toHaveLength(2);

    const tenants = docs.map((d: any) => d.tenantId).sort();
    expect(tenants).toEqual(['t1', 't2']);
  });

  it('getById scoped to tenant', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const input = makeHttpInput({ tenantId: 't1', projectId: 'p1' });
    await runWorkflow(input, 'exec-t-3', makeDeps());

    // Same execution, wrong tenant
    const wrongTenant = await store.getById('exec-t-3', 't2', 'p1');
    expect(wrongTenant).toBeNull();

    // Correct tenant
    const correctTenant = await store.getById('exec-t-3', 't1', 'p1');
    expect(correctTenant).toBeTruthy();
  });
});

// ─── Suite 3: Step Array Updates ─────────────────────────────────────────

describe('Step Array Updates', () => {
  it('step transitions visible in MongoDB', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    // Return a fresh Response per call — Response bodies can only be read
    // once, so mockResolvedValue with a single instance fails on the 2nd fetch.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: 'value' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const input = makeHttpInput({
      steps: [
        { id: 's1', type: 'http' as const, method: 'GET' as const, url: 'https://a.com/1' },
        { id: 's2', type: 'http' as const, method: 'GET' as const, url: 'https://a.com/2' },
      ],
    });

    await runWorkflow(input, 'exec-a-1', makeDeps());

    const doc = await WorkflowExecution.findOne({ _id: 'exec-a-1' }).lean();
    // Start + 2 input steps + End = 4 nodeExecutions, all completed.
    expect(doc!.nodeExecutions).toHaveLength(4);
    expect(doc!.nodeExecutions[0].nodeId).toBe('start');
    for (const step of doc!.nodeExecutions) {
      expect(step.status).toBe('completed');
      expect(step.completedAt).toBeInstanceOf(Date);
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(doc!.nodeExecutions[doc!.nodeExecutions.length - 1].nodeId).toBe('end');
  });

  it('partial failure leaves completed steps intact', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error('Third step failed');
    });

    const input = makeHttpInput({
      steps: [
        { id: 's1', type: 'http' as const, method: 'GET' as const, url: 'https://a.com/1' },
        { id: 's2', type: 'http' as const, method: 'GET' as const, url: 'https://a.com/2' },
        { id: 's3', type: 'http' as const, method: 'GET' as const, url: 'https://a.com/3' },
      ],
    });

    const result = await runWorkflow(input, 'exec-a-2', makeDeps());
    expect(result.status).toBe('failed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-a-2' }).lean();
    // Index 0 is the synthetic start node; input steps s1/s2/s3 are 1/2/3.
    expect(doc!.nodeExecutions[0].nodeId).toBe('start');
    expect(doc!.nodeExecutions[0].status).toBe('completed');
    expect(doc!.nodeExecutions[1].status).toBe('completed');
    expect(doc!.nodeExecutions[2].status).toBe('completed');
    expect(doc!.nodeExecutions[3].status).toBe('failed');
    expect(doc!.nodeExecutions[3].error).toEqual(
      expect.objectContaining({ code: 'STEP_FAILED', message: 'Third step failed' }),
    );
  });

  it('nested JSON output round-trips through MongoDB', async ({ skip }) => {
    requireMongo(skip);
    publisher = makePublisher();

    const nestedPayload = {
      nested: {
        deep: {
          value: 42,
          array: [1, 2, { key: 'val' }],
          nullField: null,
          boolField: true,
        },
      },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(nestedPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await runWorkflow(makeHttpInput(), 'exec-a-3', makeDeps());

    const doc = await WorkflowExecution.findOne({ _id: 'exec-a-3' }).lean();
    // nodeExecutions[0] is the synthetic start node; the HTTP step is at [1].
    const output = doc!.nodeExecutions[1].output as any;
    expect(output.body).toEqual(nestedPayload);
    expect(output.body.nested.deep.value).toBe(42);
    expect(output.body.nested.deep.array[2]).toEqual({ key: 'val' });
    expect(output.body.nested.deep.nullField).toBeNull();
    expect(output.body.nested.deep.boolField).toBe(true);
  });
});
