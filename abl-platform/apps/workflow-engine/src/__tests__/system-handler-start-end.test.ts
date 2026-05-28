/**
 * System tests for the first-class Start/End boundary step lifecycle
 * (LLD phases 4, 5, and 8 — end-to-end coverage).
 *
 * Real MongoDB via setup-mongo.ts, real ExecutionStore, captured publisher.
 * No vi.mock of internal packages. External HTTP is stubbed via
 * globalThis.fetch per the system-*.test.ts convention.
 *
 * Covers:
 *  - Start lifecycle: valid input coercion, validation failure, SSE order,
 *    ctx.vars typing, undeclared field pass-through, no-declarations pass.
 *  - End lifecycle: happy path (with/without mappings), single mapping
 *    failure, multi-mapping partial failure (fail-on-any per HLD D-17).
 *  - End-to-end: declared inputs coerced → typed {{vars.*}} resolves in
 *    a real user step → End mapping outputs post-coerced values (E2E-1).
 *  - Anchor: validator unit contract matches what the handler reports.
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
  type StartInputVariable,
} from '../handlers/workflow-handler.js';
import { validateAndCoerceInput } from '../validation/start-input-validator.js';

// SSRF allowlist — tests use example.com URLs
vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: () => {},
}));

vi.mock('@agent-platform/shared-kernel/security/safe-fetch', () => ({
  assertUrlSafeForFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

let store: ExecutionStore;

interface CapturedEvent {
  channel: string;
  type: string;
  stepId?: string;
  stepType?: string;
  errorCode?: string;
  durationMs?: number;
  error?: string;
}

function makeCapturingPublisher(): { publisher: StatusPublisher; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const publisher: StatusPublisher = {
    publish: vi.fn(async (channel: string, message: string) => {
      const parsed = JSON.parse(message) as CapturedEvent;
      events.push({ channel, ...parsed });
    }),
  };
  return { publisher, events };
}

function makeDeps(publisher: StatusPublisher): WorkflowHandlerDeps {
  return {
    persistence: store,
    publisher,
    dispatcherDeps: {},
  };
}

function baseInput(overrides: Partial<WorkflowExecutionInput> = {}): WorkflowExecutionInput {
  return {
    workflowId: 'wf-1',
    workflowName: 'StartEndTest',
    tenantId: 't1',
    projectId: 'p1',
    triggerType: 'studio',
    triggerPayload: {},
    steps: [],
    ...overrides,
  };
}

// Deterministic encryption stub for `ExecutionStore` — this suite does
// not exercise the async-webhook callback flow, so the encrypt path is
// never reached. Stub keeps the ExecutionStore constructor happy.
const testEncryptSecret = async (plaintext: string): Promise<string> => `cipher:${plaintext}`;

beforeAll(async () => {
  await setupTestMongo();
  store = new ExecutionStore(WorkflowExecution, testEncryptSecret);
});

afterEach(async () => {
  await clearCollections();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await teardownTestMongo();
});

// ─── Suite 1: Start phase — valid input (coercion succeeds) ──────────────

describe('Start phase: valid input', () => {
  const declared: StartInputVariable[] = [
    { name: 'email', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true },
  ];

  it('coerces the payload and persists Start step as completed', async ({ skip }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { email: 'a@b', amount: '100' }, // amount as string — coerces to number
    });
    const result = await runWorkflow(input, 'exec-start-1', makeDeps(publisher));

    expect(result.status).toBe('completed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-start-1' }).lean();
    expect(doc!.status).toBe('completed');
    const start = (doc as any).context?.steps?.start;
    expect(start).toBeTruthy();
    expect(start!.status).toBe('completed');
    expect(start!.nodeType).toBe('start');
    // input = raw payload; output = coerced values
    expect(start!.input).toEqual({ email: 'a@b', amount: '100' });
    expect(start!.output).toEqual({ email: 'a@b', amount: 100 });
    // metrics carry processing time for the validation/coercion pass
    expect(start!.metrics?.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(start!.durationMs).toBeGreaterThanOrEqual(0);
    // Mongoose defaults a Mixed-array schema field to []; happy path writes
    // nothing, so the persisted value is an empty array (not undefined).
    expect(start!.mappingErrors ?? []).toEqual([]);
  });

  it('emits step.started and step.completed before workflow.started', async ({ skip }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { email: 'a@b', amount: '100' },
    });
    await runWorkflow(input, 'exec-start-2', makeDeps(publisher));

    const startRelated = events
      .filter(
        (e) =>
          (e.stepId === 'start' && e.type.startsWith('step.')) || e.type.startsWith('workflow.'),
      )
      .map((e) => e.type);

    // Natural order: step.started(start) → step.completed(start) → workflow.started → ... → workflow.completed
    expect(startRelated[0]).toBe('step.started');
    expect(startRelated[1]).toBe('step.completed');
    expect(startRelated[2]).toBe('workflow.started');
    expect(startRelated[startRelated.length - 1]).toBe('workflow.completed');
  });

  it('coerced variables are available in ctx.vars for downstream expressions', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { email: 'a@b', amount: '42' },
    });
    const result = await runWorkflow(input, 'exec-start-3', makeDeps(publisher));

    expect(result.status).toBe('completed');
    // ctx.vars carries typed values (number, not string)
    expect(result.context.vars.email).toBe('a@b');
    expect(result.context.vars.amount).toBe(42);
    // ctx.steps.start.output matches the coerced vars map
    expect(result.context.steps.start.output).toEqual({ email: 'a@b', amount: 42 });
  });

  it('preserves undeclared payload fields in ctx.vars', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { email: 'a@b', amount: '100', traceId: 'tr-1', meta: { src: 'webhook' } },
    });
    const result = await runWorkflow(input, 'exec-start-4', makeDeps(publisher));

    expect(result.status).toBe('completed');
    // Declared-and-coerced + undeclared both present in vars
    expect(result.context.vars).toEqual({
      email: 'a@b',
      amount: 100,
      traceId: 'tr-1',
      meta: { src: 'webhook' },
    });
  });
});

// ─── Suite 2: Start phase — validation failure ───────────────────────────

describe('Start phase: validation failure', () => {
  it('fails the workflow when a required input variable is missing', async ({ skip }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const declared: StartInputVariable[] = [
      { name: 'email', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true },
    ];
    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { amount: '100' }, // missing email
      steps: [
        // Would-be-executed user step; MUST NOT run when Start fails.
        { id: 'never-runs', type: 'http', method: 'GET', url: 'https://example.com' },
      ],
    });
    const result = await runWorkflow(input, 'exec-start-fail-1', makeDeps(publisher));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKFLOW_FAILED');
    expect(result.error?.message).toContain('1 input field');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-start-fail-1' }).lean();
    expect(doc!.status).toBe('failed');

    const start = (doc as any).context?.steps?.start;
    expect(start!.status).toBe('failed');
    expect(start!.error).toEqual(
      expect.objectContaining({
        code: 'INPUT_VALIDATION_FAILED',
        message: expect.stringContaining('1 input field'),
      }),
    );
    // Per-field error details land on mappingErrors
    expect(start!.mappingErrors).toEqual([
      { name: 'email', error: expect.stringContaining('REQUIRED') },
    ]);
    // input is still the raw payload (for debug visibility)
    expect(start!.input).toEqual({ amount: '100' });

    // User step never ran → still pending
    const userStep = (doc as any).context?.steps?.['never-runs'];
    expect(userStep!.status).toBe('pending');

    // Workflow-level output uses the {_status:1, _reason} shape
    expect(doc!.output).toEqual(expect.objectContaining({ _status: 1 }));
  });

  it('emits step.started → step.failed (start) → workflow.failed (no workflow.started)', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const declared: StartInputVariable[] = [{ name: 'email', type: 'string', required: true }];
    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: {},
    });
    await runWorkflow(input, 'exec-start-fail-2', makeDeps(publisher));

    const types = events.map((e) => e.type);
    expect(types).toEqual(['step.started', 'step.failed', 'workflow.failed']);

    // step.failed carries errorCode = INPUT_VALIDATION_FAILED
    const failed = events.find((e) => e.type === 'step.failed');
    expect(failed?.stepId).toBe('start');
    expect(failed?.errorCode).toBe('INPUT_VALIDATION_FAILED');
  });

  it('accumulates multiple field errors into mappingErrors', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const declared: StartInputVariable[] = [
      { name: 'email', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true },
      { name: 'config', type: 'json', required: true },
    ];
    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { amount: 'abc', config: 'not json' }, // email missing + amount mismatch + config parse fail
    });
    const result = await runWorkflow(input, 'exec-start-fail-3', makeDeps(publisher));

    expect(result.status).toBe('failed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-start-fail-3' }).lean();
    const start = (doc as any).context?.steps?.start;
    expect(start!.mappingErrors).toHaveLength(3);
    const names = start!.mappingErrors!.map((e) => e.name).sort();
    expect(names).toEqual(['amount', 'config', 'email']);
  });
});

// ─── Suite 3: Start phase — no declared inputs (pass-through) ────────────

describe('Start phase: no declared inputs', () => {
  it('runs successfully when startInputVariables is empty or undefined', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      triggerPayload: { anything: 'kept' },
    });
    const result = await runWorkflow(input, 'exec-start-passthru', makeDeps(publisher));

    expect(result.status).toBe('completed');
    expect(result.context.vars).toEqual({ anything: 'kept' });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-start-passthru' }).lean();
    const start = (doc as any).context?.steps?.start;
    expect(start!.status).toBe('completed');
    expect(start!.output).toEqual({ anything: 'kept' });
  });
});

// ─── Suite 4: End phase — happy path ─────────────────────────────────────

describe('End phase: happy path', () => {
  it('persists End step with resolved output mappings and metrics', async ({ skip }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const input = baseInput({
      startInputVariables: [{ name: 'amount', type: 'number', required: true }],
      triggerPayload: { amount: '250' },
      outputMappings: [
        { name: 'total', expression: '{{vars.amount}}' },
        { name: 'note', expression: 'workflow complete' },
      ],
    });
    const result = await runWorkflow(input, 'exec-end-1', makeDeps(publisher));

    expect(result.status).toBe('completed');
    // Workflow-level output carries _status:0 + resolved mappings
    expect(result.output).toEqual({ _status: 0, total: 250, note: 'workflow complete' });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-1' }).lean();
    const end = (doc as any).context?.steps?.end;
    expect(end).toBeTruthy();
    expect(end!.status).toBe('completed');
    expect(end!.nodeType).toBe('end');
    // input = mapping config; output = resolved values with _status:0
    expect(end!.input).toEqual(input.outputMappings);
    expect(end!.output).toEqual({ _status: 0, total: 250, note: 'workflow complete' });
    expect(end!.metrics?.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(end!.durationMs).toBeGreaterThanOrEqual(0);
    // No mapping errors on happy path (Mongoose defaults Mixed array to [])
    expect(end!.mappingErrors ?? []).toEqual([]);

    // SSE: step.started(end) → step.completed(end) → workflow.completed
    const endEvents = events
      .filter((e) => e.stepId === 'end' || e.type === 'workflow.completed')
      .map((e) => e.type);
    expect(endEvents).toEqual(['step.started', 'step.completed', 'workflow.completed']);
  });

  it('persists End step as completed when outputMappings is empty', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({ triggerPayload: { src: 'x' } });
    const result = await runWorkflow(input, 'exec-end-empty', makeDeps(publisher));

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ _status: 0 });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-empty' }).lean();
    const end = (doc as any).context?.steps?.end;
    expect(end!.status).toBe('completed');
    expect(end!.output).toEqual({ _status: 0 });
  });

  it('mirrors End into ctx.steps.end so context snapshot exposes the boundary step', async ({
    skip,
  }) => {
    // Regression guard: the context snapshot persisted on the execution
    // record (execution.context.steps) was showing every user step but not
    // End — making the Raw JSON panel's `context.steps` list incomplete.
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      triggerPayload: { amount: 77 },
      outputMappings: [{ name: 'echoed', expression: '{{trigger.payload.amount}}' }],
    });
    const result = await runWorkflow(input, 'exec-end-ctx-mirror', makeDeps(publisher));

    expect(result.status).toBe('completed');
    // Returned ctx and persisted context both carry steps.end
    expect(result.context.steps.end).toBeTruthy();
    expect(result.context.steps.end.status).toBe('completed');
    expect(result.context.steps.end.output).toEqual({ _status: 0, echoed: 77 });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-ctx-mirror' }).lean();
    const persistedCtx = doc!.context as Record<string, unknown>;
    const persistedSteps = persistedCtx.steps as Record<string, unknown>;
    expect(persistedSteps.end).toBeTruthy();
    expect((persistedSteps.end as Record<string, unknown>).status).toBe('completed');
  });
});

// ─── Suite 5: End phase — mapping failure (HLD D-17 fail-the-workflow) ──

describe('End phase: mapping failure', () => {
  it('fails the workflow when a mapping value does not match its configured type', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { publisher, events } = makeCapturingPublisher();

    const input = baseInput({
      outputMappings: [
        { name: 'ok', expression: 'literal-value' }, // no {{}} — resolver returns string as-is
        { name: 'bad', expression: 'not-a-number', type: 'number' },
      ],
    });
    const result = await runWorkflow(input, 'exec-end-fail-1', makeDeps(publisher));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKFLOW_FAILED');
    expect(result.error?.message).toContain(
      'bad: Output mapping "bad" type mismatch: expected number, got string',
    );
    // Workflow-level output uses the {_status:1,_reason} failure contract.
    expect(result.output).toEqual(
      expect.objectContaining({
        _status: 1,
        _reason: expect.stringContaining(
          'bad: Output mapping "bad" type mismatch: expected number, got string',
        ),
      }),
    );

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-fail-1' }).lean();
    const end = (doc as any).context?.steps?.end;
    expect(end!.status).toBe('failed');
    expect(end!.error).toEqual(
      expect.objectContaining({
        code: 'OUTPUT_MAPPING_FAILED',
        message: expect.stringContaining(
          'bad: Output mapping "bad" type mismatch: expected number, got string',
        ),
      }),
    );
    // Per-mapping detail persisted with expression + error string
    expect(end!.mappingErrors).toHaveLength(1);
    expect(end!.mappingErrors![0].name).toBe('bad');
    expect(end!.mappingErrors![0]).toEqual(
      expect.objectContaining({
        expression: 'not-a-number',
        expected: 'number',
        got: 'string',
        error: 'Output mapping "bad" type mismatch: expected number, got string',
      }),
    );
    // Partially-resolved output still persisted on the step (for debug),
    // even though the workflow-level output is buildFailureOutput.
    expect(end!.output).toEqual({ _status: 0, ok: 'literal-value', bad: null });

    // SSE: step.started(end) → step.failed(end) → workflow.failed
    const endEvents = events
      .filter((e) => e.stepId === 'end' || e.type === 'workflow.failed')
      .map((e) => e.type);
    expect(endEvents).toEqual(['step.started', 'step.failed', 'workflow.failed']);
  });

  it('accumulates all output type errors before failing (no short-circuit)', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      outputMappings: [
        { name: 'a', expression: 'abc', type: 'number' },
        { name: 'b', expression: 'preserved-string' }, // no {{}} — passes through
        { name: 'c', expression: 'true', type: 'boolean' },
      ],
    });
    const result = await runWorkflow(input, 'exec-end-fail-2', makeDeps(publisher));

    expect(result.status).toBe('failed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-fail-2' }).lean();
    const end = (doc as any).context?.steps?.end;
    // Both failing mappings captured; successful mapping preserved in output.
    expect(end!.mappingErrors).toHaveLength(2);
    const failingNames = end!.mappingErrors!.map((e) => e.name).sort();
    expect(failingNames).toEqual(['a', 'c']);
    expect(end!.output).toEqual({ _status: 0, a: null, b: 'preserved-string', c: null });
  });

  it('resolves blank or missing output expressions to null without failing', async ({ skip }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    const input = baseInput({
      outputMappings: [
        { name: 'blank', expression: '', type: 'string' },
        { name: 'missing', expression: '{{steps.missing.output.x}}', type: 'number' },
      ],
    });
    const result = await runWorkflow(input, 'exec-end-null-1', makeDeps(publisher));

    expect(result.status).toBe('completed');

    const doc = await WorkflowExecution.findOne({ _id: 'exec-end-null-1' }).lean();
    const end = (doc as any).context?.steps?.end;
    expect(end!.status).toBe('completed');
    expect(end!.mappingErrors ?? []).toEqual([]);
    expect(end!.output).toEqual({ _status: 0, blank: null, missing: null });
  });
});

// ─── Suite 6: End-to-end — declared inputs through to output (E2E-1) ────

describe('End-to-end: declared inputs → typed vars → output mapping', () => {
  it('coerces declared inputs, propagates typed vars to a user step, emits in End output', async ({
    skip,
  }) => {
    requireMongo(skip);
    const { publisher } = makeCapturingPublisher();

    // Capture what the user HTTP step sees — proves coercion reaches dispatch.
    const capturedUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const declared: StartInputVariable[] = [
      { name: 'email', type: 'string', required: true },
      { name: 'amount', type: 'number', required: true },
    ];
    const input = baseInput({
      startInputVariables: declared,
      triggerPayload: { email: 'a@b', amount: '250' }, // amount as string
      steps: [
        // Real user step whose URL interpolates the coerced number. The
        // expression resolver reads `vars.amount` which must be 250 (not "250").
        {
          id: 'http-1',
          type: 'http',
          method: 'GET',
          url: 'https://api.example.com/q?amount={{vars.amount}}',
        },
      ],
      outputMappings: [
        { name: 'typedAmount', expression: '{{vars.amount}}' },
        { name: 'doubled', expression: '{{vars.amount}}' }, // same expression, different name
      ],
    });
    const result = await runWorkflow(input, 'exec-e2e-1', makeDeps(publisher));

    expect(result.status).toBe('completed');
    // URL interpolation used the coerced number
    expect(capturedUrls).toEqual(['https://api.example.com/q?amount=250']);
    // Workflow-level output carries typed values
    expect(result.output).toEqual({ _status: 0, typedAmount: 250, doubled: 250 });

    const doc = await WorkflowExecution.findOne({ _id: 'exec-e2e-1' }).lean();
    const ctxSteps = (doc as any).context?.steps ?? {};
    // Start + http-1 + End = 3 context.steps entries, all completed.
    expect(Object.keys(ctxSteps)).toHaveLength(3);
    expect(ctxSteps.start).toBeDefined();
    expect(ctxSteps.start.output).toEqual({ email: 'a@b', amount: 250 });
    expect(ctxSteps.end).toBeDefined();
    expect(ctxSteps.end.output).toEqual({
      _status: 0,
      typedAmount: 250,
      doubled: 250,
    });
    for (const step of Object.values(ctxSteps)) {
      expect((step as any).status).toBe('completed');
    }
  });
});

// ─── Suite 7: Validator-contract anchor (LLD Phase 8 Task 8.3) ──────────

describe('Validator-contract anchor', () => {
  // Pins the unit-level validator contract (validateAndCoerceInput) to the
  // same shape the system tests rely on. If the validator ever diverges
  // from the handler's usage, this fails before the E2E cases mask it.
  it('REQUIRED surfaces for a declared required field when missing', () => {
    const r = validateAndCoerceInput([{ name: 'x', type: 'string', required: true }], {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toEqual({ name: 'x', reason: 'REQUIRED' });
    }
  });

  it('number coercion — string "250" becomes 250', () => {
    const r = validateAndCoerceInput([{ name: 'amount', type: 'number', required: true }], {
      amount: '250',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.coerced.amount).toBe(250);
  });

  it('TYPE_MISMATCH with expected/got for un-coercible string', () => {
    const r = validateAndCoerceInput([{ name: 'n', type: 'number', required: true }], {
      n: 'abc',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toEqual({
        name: 'n',
        reason: 'TYPE_MISMATCH',
        expected: 'number',
        got: 'string',
      });
    }
  });
});
