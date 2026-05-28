/**
 * Unit tests for the 6 Restate activity services.
 *
 * Access pattern: Restate wraps service definitions so that the raw handler
 * functions are exposed at `serviceDefinition.service.execute`, NOT at
 * `serviceDefinition.handlers.execute`. The `handlers` property on the
 * returned object is an empty object; the actual handler lives on `.service`.
 *
 * We mock restate.Context with two methods:
 *   - ctx.run(label, fn) → calls fn() and returns its result
 *   - ctx.console.log → no-op
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { transformService } from '../pipeline/services/transform.service.js';
import { evaluateMetricsService } from '../pipeline/services/evaluate-metrics.service.js';
import { evaluatePolicyService } from '../pipeline/services/evaluate-policy.service.js';
import { sendNotificationService } from '../pipeline/services/send-notification.service.js';
import { storeResultsService } from '../pipeline/services/store-results.service.js';
import { runLegacyWorkflowService } from '../pipeline/services/run-legacy-workflow.service.js';
import {
  CUSTOM_PIPELINE_RESULTS_COLLECTION,
  CUSTOM_PIPELINE_RESULTS_TABLE,
} from '../pipeline/contracts/destination-contract.js';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

const {
  mockUpdateOne,
  mockCollection,
  mockMessageFind,
  mockSessionFindOne,
  mockEvalHumanReviewCreate,
  mockTenantModelFindOne,
  mockModelConfigFindOne,
  mockLLMCredentialFindOne,
  mockResolveTenantPlaintextValue,
} = vi.hoisted(() => {
  const mockUpdateOne = vi.fn().mockResolvedValue({});
  const mockCollection = vi.fn().mockReturnValue({ updateOne: mockUpdateOne });
  const mockMessageFind = vi.fn();
  const mockSessionFindOne = vi.fn();
  const mockEvalHumanReviewCreate = vi.fn();
  const mockTenantModelFindOne = vi.fn();
  const mockModelConfigFindOne = vi.fn();
  const mockLLMCredentialFindOne = vi.fn();
  const mockResolveTenantPlaintextValue = vi.fn();
  return {
    mockUpdateOne,
    mockCollection,
    mockMessageFind,
    mockSessionFindOne,
    mockEvalHumanReviewCreate,
    mockTenantModelFindOne,
    mockModelConfigFindOne,
    mockLLMCredentialFindOne,
    mockResolveTenantPlaintextValue,
  };
});

vi.mock('mongoose', () => ({
  default: {
    plugin: vi.fn(),
    connection: {
      collection: mockCollection,
    },
  },
}));

vi.mock('@agent-platform/database/models', () => ({
  Message: { find: (...args: unknown[]) => mockMessageFind(...args) },
  Session: { findOne: (...args: unknown[]) => mockSessionFindOne(...args) },
  EvalHumanReview: { create: (...args: unknown[]) => mockEvalHumanReviewCreate(...args) },
  TenantModel: { findOne: (...args: unknown[]) => mockTenantModelFindOne(...args) },
  ModelConfig: { findOne: (...args: unknown[]) => mockModelConfigFindOne(...args) },
  LLMCredential: { findOne: (...args: unknown[]) => mockLLMCredentialFindOne(...args) },
  ensureConnected: vi.fn(),
  setMasterKey: vi.fn(),
}));

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

const mockClickHouseInsert = vi.fn().mockResolvedValue({});

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    insert: mockClickHouseInsert,
    query: vi.fn().mockResolvedValue({ json: () => Promise.resolve([]) }),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal restate.Context mock: ctx.run executes fn() directly. */
function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

/** Build a PipelineStepContext with sensible defaults. */
function makeContext(
  config: Record<string, any>,
  previousSteps: Record<string, StepOutput> = {},
): PipelineStepContext {
  return {
    tenantId: 'test-tenant',
    projectId: 'test-project',
    sessionId: 'test-session',
    config,
    previousSteps,
    pipelineInput: { tenantId: 'test-tenant', projectId: 'test-project' },
  };
}

// Convenience: extract the raw execute handler from a Restate service definition.
// Restate exposes handler functions at <service>.service.<handlerName>.
function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

// ---------------------------------------------------------------------------
// transform.service
// ---------------------------------------------------------------------------

describe('TransformData service', () => {
  const execute = getExecute(transformService);

  test('valid mapping resolves expressions correctly from previousSteps data', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-step': {
        status: 'success',
        data: { scores: { toxicity: 0.85, bias: 0.2 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      { mapping: { toxicityScore: 'steps.eval-step.output.scores.toxicity' } },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.toxicityScore).toBe(0.85);
  });

  test('missing mapping config returns fail status', async () => {
    const ctx = createMockContext();
    const input = makeContext({});

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('mapping');
  });

  test('non-object mapping (string value) returns fail status', async () => {
    const ctx = createMockContext();
    const input = makeContext({ mapping: 'not-an-object' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('mapping');
  });

  test('empty mapping returns success with empty data', async () => {
    const ctx = createMockContext();
    const input = makeContext({ mapping: {} });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data).toEqual({});
  });

  test('missing step reference in expression returns undefined for that field', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      { mapping: { missingField: 'steps.nonexistent-step.output.value' } },
      {},
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.missingField).toBeUndefined();
  });

  test('mapping resolves multiple fields from different steps', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'step-a': {
        status: 'success',
        data: { count: 42 },
      },
      'step-b': {
        status: 'success',
        data: { label: 'approved' },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        mapping: {
          total: 'steps.step-a.output.count',
          status: 'steps.step-b.output.label',
        },
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.total).toBe(42);
    expect(result.data.status).toBe('approved');
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ mapping: {} });

    const result = await execute(ctx, input);

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// evaluate-metrics.service
// ---------------------------------------------------------------------------

describe('EvaluateMetrics service', () => {
  const execute = getExecute(evaluateMetricsService);

  test('missing metrics config returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({});

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('metrics');
  });

  test('empty metrics array returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ metrics: [] });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('metrics');
  });

  test('non-array metrics value returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ metrics: 'toxicity' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('metrics');
  });

  test('structured metric rules evaluate against previous step outputs', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-safety': {
        status: 'success',
        data: { scores: { toxicity: 0.3, bias: 0.8 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        metrics: [
          {
            name: 'toxicity-check',
            field: 'steps.eval-safety.output.scores.toxicity',
            operator: 'lte',
            threshold: 0.7,
            weight: 2.0,
          },
          {
            name: 'bias-check',
            field: 'steps.eval-safety.output.scores.bias',
            operator: 'lte',
            threshold: 0.5,
            weight: 1.0,
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    // toxicity 0.3 <= 0.7 → passed
    expect(result.data.scores['toxicity-check'].passed).toBe(true);
    expect(result.data.scores['toxicity-check'].value).toBe(0.3);
    // bias 0.8 <= 0.5 → failed
    expect(result.data.scores['bias-check'].passed).toBe(false);
    expect(result.data.scores['bias-check'].value).toBe(0.8);
  });

  test('overall score is weighted average of individual scores', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-step': {
        status: 'success',
        data: { scores: { a: 0.3, b: 0.8 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        metrics: [
          {
            name: 'a',
            field: 'steps.eval-step.output.scores.a',
            operator: 'lte',
            threshold: 0.5,
            weight: 2.0,
          },
          {
            name: 'b',
            field: 'steps.eval-step.output.scores.b',
            operator: 'lte',
            threshold: 0.5,
            weight: 1.0,
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    // a passes (score=1.0, weight=2.0), b fails (score=0.0, weight=1.0)
    // overallScore = (1.0*2 + 0.0*1) / (2+1) = 0.667
    expect(result.data.overallScore).toBeCloseTo(2 / 3);
  });

  test('missing field resolves to NaN and fails gracefully', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      {
        metrics: [
          { name: 'missing', field: 'steps.nonexistent.output.x', operator: 'gt', threshold: 0.5 },
        ],
      },
      {},
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.scores['missing'].passed).toBe(false);
  });

  test('legacy string metric names still work', async () => {
    const ctx = createMockContext();
    const input = makeContext({ metrics: ['toxicity', 'bias'] });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.scores).toHaveProperty('toxicity');
    expect(result.data.scores).toHaveProperty('bias');
  });

  test('pipelineInput expressions work in metric fields', async () => {
    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'test-tenant',
      config: {
        metrics: [
          {
            name: 'input-score',
            field: 'pipelineInput.payload.score',
            operator: 'gte',
            threshold: 0.5,
          },
        ],
      },
      previousSteps: {},
      pipelineInput: { tenantId: 'test-tenant', payload: { score: 0.9 } },
    };

    const result = await execute(ctx, input);

    expect(result.data.scores['input-score'].passed).toBe(true);
    expect(result.data.scores['input-score'].value).toBe(0.9);
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ metrics: ['toxicity'] });

    const result = await execute(ctx, input);
    expect(typeof result.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// evaluate-policy.service
// ---------------------------------------------------------------------------

describe('EvaluatePolicy service', () => {
  const execute = getExecute(evaluatePolicyService);

  test('missing policyId returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({});

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('policyId');
  });

  test('empty string policyId returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ policyId: '' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('policyId');
  });

  test('no rules returns default PASS', async () => {
    const ctx = createMockContext();
    const input = makeContext({ policyId: 'my-policy' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.status).toBe('PASS');
    expect(result.data.violations).toEqual([]);
  });

  test('all rules passing returns PASS', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-step': {
        status: 'success',
        data: { scores: { toxicity: 0.2, bias: 0.1 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        policyId: 'safety-policy',
        rules: [
          {
            name: 'toxicity',
            condition: 'steps.eval-step.output.scores.toxicity',
            operator: 'lte',
            expected: 0.7,
            severity: 'critical',
          },
          {
            name: 'bias',
            condition: 'steps.eval-step.output.scores.bias',
            operator: 'lte',
            expected: 0.5,
            severity: 'warning',
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.data.status).toBe('PASS');
    expect(result.data.summary.passed).toBe(2);
    expect(result.data.summary.failed).toBe(0);
    expect(result.data.violations).toEqual([]);
  });

  test('critical violation returns FAIL', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-step': {
        status: 'success',
        data: { scores: { toxicity: 0.9 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        policyId: 'safety-policy',
        rules: [
          {
            name: 'toxicity',
            condition: 'steps.eval-step.output.scores.toxicity',
            operator: 'lte',
            expected: 0.7,
            severity: 'critical',
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.data.status).toBe('FAIL');
    expect(result.data.violations).toHaveLength(1);
    expect(result.data.violations[0].rule).toBe('toxicity');
    expect(result.data.violations[0].severity).toBe('critical');
  });

  test('only warning violations returns WARN', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'eval-step': {
        status: 'success',
        data: { scores: { bias: 0.8 } },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        policyId: 'quality-policy',
        rules: [
          {
            name: 'bias',
            condition: 'steps.eval-step.output.scores.bias',
            operator: 'lte',
            expected: 0.5,
            severity: 'warning',
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.data.status).toBe('WARN');
    expect(result.data.violations).toHaveLength(1);
  });

  test('string equality comparison works', async () => {
    const previousSteps: Record<string, StepOutput> = {
      'check-step': {
        status: 'success',
        data: { label: 'approved' },
      },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        policyId: 'approval-policy',
        rules: [
          {
            name: 'approval',
            condition: 'steps.check-step.output.label',
            operator: 'eq',
            expected: 'approved',
          },
        ],
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.data.status).toBe('PASS');
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ policyId: 'test-policy' });
    const result = await execute(ctx, input);
    expect(typeof result.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// send-notification.service
// ---------------------------------------------------------------------------

describe('SendNotification service', () => {
  const execute = getExecute(sendNotificationService);

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('missing channel returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({});

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('channel');
  });

  test('empty string channel returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: '' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('channel');
  });

  test('unknown channel returns fail with error message', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: 'carrier-pigeon' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('carrier-pigeon');
  });

  test('webhook calls fetch with correct URL and body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const ctx = createMockContext();
    const input = makeContext({
      channel: 'webhook',
      webhookUrl: 'https://hooks.example.com/pipeline',
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://hooks.example.com/pipeline');
  });

  test('webhook without URL returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: 'webhook' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('url');
  });

  test('webhook non-2xx response returns fail', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const ctx = createMockContext();
    const input = makeContext({
      channel: 'webhook',
      webhookUrl: 'https://hooks.example.com/fail',
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('500');
  });

  test('webhook non-2xx response stays terminal under ctx.run replay semantics', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const replayingCtx = {
      console: { log: () => {} },
      run: async (_label: string, fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch (error) {
          throw new Error(
            `ctx.run should not receive thrown webhook delivery errors: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    };

    const input = makeContext({
      channel: 'webhook',
      webhookUrl: 'https://hooks.example.com/rate-limited',
    });

    const result = await execute(replayingCtx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('429');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('slack calls fetch with webhookUrl', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const ctx = createMockContext();
    const input = makeContext({
      channel: 'slack',
      webhookUrl: 'https://hooks.slack.com/services/xxx',
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('body template resolves expressions', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const previousSteps: Record<string, StepOutput> = {
      'eval-step': { status: 'success', data: { score: 0.95 } },
    };
    const ctx = createMockContext();
    const input = makeContext(
      {
        channel: 'webhook',
        webhookUrl: 'https://hooks.example.com/hook',
        body: {
          score: 'steps.eval-step.output.score',
          label: 'static-value',
        },
      },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.score).toBe(0.95);
    expect(sentBody.label).toBe('static-value');
  });

  test('email channel returns success (stub)', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: 'email' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
  });

  test('websocket channel returns success (stub)', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: 'websocket' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ channel: 'email' });

    const result = await execute(ctx, input);

    expect(typeof result.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// store-results.service
// ---------------------------------------------------------------------------

describe('StoreResults service', () => {
  const execute = getExecute(storeResultsService);

  const previousSteps: Record<string, StepOutput> = {
    'step-a': { status: 'success', data: { value: 1 } },
    'step-b': { status: 'success', data: { value: 2 } },
  };

  beforeEach(() => {
    mockUpdateOne.mockClear();
    mockCollection.mockClear();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('unknown destination returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'ftp-server' }, previousSteps);

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('ftp-server');
  });

  test('missing destination skips gracefully', async () => {
    const ctx = createMockContext();
    const input = makeContext({}, previousSteps);

    const result = await execute(ctx, input);

    expect(result.status).toBe('skipped');
  });

  test('mongodb destination writes to correct collection', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      { destination: 'mongodb', collection: 'pipeline_results' },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
    expect(mockCollection).toHaveBeenCalledWith('pipeline_results');
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  test('mongodb uses "table" as fallback for collection name', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb', table: 'run_outputs' }, previousSteps);

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(mockCollection).toHaveBeenCalledWith('run_outputs');
  });

  test('mongodb always includes tenantId in stored document', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb', collection: 'results' }, previousSteps);

    await execute(ctx, input);

    // updateOne(filter, { $setOnInsert: document }, { upsert: true })
    const insertedDoc = mockUpdateOne.mock.calls[0][1].$setOnInsert;
    expect(insertedDoc.tenantId).toBe('test-tenant');
  });

  test('mongodb document template resolves expressions', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      {
        destination: 'mongodb',
        collection: 'results',
        document: {
          score: 'steps.step-a.output.value',
          label: 'static-label',
        },
      },
      previousSteps,
    );

    await execute(ctx, input);

    // updateOne(filter, { $setOnInsert: document }, { upsert: true })
    const insertedDoc = mockUpdateOne.mock.calls[0][1].$setOnInsert;
    expect(insertedDoc.score).toBe(1);
    expect(insertedDoc.label).toBe('static-label');
    expect(insertedDoc.tenantId).toBe('test-tenant');
  });

  test('mongodb invalid collection name returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      { destination: 'mongodb', collection: '../../../etc/passwd' },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
  });

  test('mongodb defaults to shared custom pipeline results collection when collection is omitted', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb', sourceStep: 'step-b' }, previousSteps);
    input.pipelineId = 'pipeline-123';
    input.pipelineName = 'Quality Evaluator';
    input.pipelineType = 'custom';
    input.stepId = 'store-results';
    input.executionMode = 'batch';
    input.pipelineInput.runId = 'run-123';

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(mockCollection).toHaveBeenCalledWith(CUSTOM_PIPELINE_RESULTS_COLLECTION);

    const insertedDoc = mockUpdateOne.mock.calls[0][1].$setOnInsert;
    expect(insertedDoc).toMatchObject({
      tenantId: 'test-tenant',
      projectId: 'test-project',
      pipelineId: 'pipeline-123',
      pipelineName: 'Quality Evaluator',
      pipelineKind: 'custom',
      runId: 'run-123',
      sessionId: 'test-session',
      storeStepId: 'store-results',
      sourceStepId: 'step-b',
      sourceStepStatus: 'success',
      source: 'batch',
      output: { value: 2 },
    });
  });

  test('callback with URL calls fetch', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const ctx = createMockContext();
    const input = makeContext(
      { destination: 'callback', callbackUrl: 'https://api.example.com/results' },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('callback without URL returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'callback' }, previousSteps);

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('callbackUrl');
  });

  test('callback non-2xx response stays terminal under ctx.run replay semantics', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const replayingCtx = {
      console: { log: () => {} },
      run: async (_label: string, fn: () => Promise<unknown>) => {
        try {
          return await fn();
        } catch (error) {
          throw new Error(
            `ctx.run should not receive thrown callback delivery errors: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    };
    const input = makeContext(
      { destination: 'callback', callbackUrl: 'https://api.example.com/results' },
      previousSteps,
    );

    const result = await execute(replayingCtx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('429');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('clickhouse destination returns success (stub)', async () => {
    const ctx = createMockContext();
    const input = makeContext(
      { destination: 'clickhouse', table: 'pipeline_results' },
      previousSteps,
    );

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.destination).toBe('clickhouse');
  });

  test('clickhouse destination defaults to shared custom pipeline results table', async () => {
    mockClickHouseInsert.mockClear();
    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Quality Evaluator',
      pipelineType: 'custom',
      stepId: 'store-results',
      stepType: 'store-results',
      config: {
        destination: 'clickhouse',
        sourceStep: 'evaluate',
      },
      previousSteps: {
        evaluate: { status: 'success', data: { score: 0.9, label: 'pass' } },
      },
      pipelineInput: { runId: 'run-xyz' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(mockClickHouseInsert).toHaveBeenCalledTimes(1);

    const insertCall = mockClickHouseInsert.mock.calls[0][0];
    expect(insertCall.table).toBe(CUSTOM_PIPELINE_RESULTS_TABLE);

    const insertedRow = insertCall.values[0];
    expect(insertedRow).toMatchObject({
      tenant_id: 'tenant-1',
      project_id: 'project-1',
      pipeline_id: 'pipe-1',
      pipeline_name: 'Quality Evaluator',
      pipeline_kind: 'custom',
      run_id: 'run-xyz',
      session_id: 'session-1',
      store_step_id: 'store-results',
      source_step_id: 'evaluate',
      source_step_status: 'success',
      score_name: 'score',
      score_path: 'score',
      score_value: 0.9,
    });
    expect(JSON.parse(insertedRow.output_json)).toEqual({ score: 0.9 });
  });

  test('score_and_document stores one ClickHouse score and full MongoDB document', async () => {
    mockClickHouseInsert.mockClear();
    mockCollection.mockClear();
    mockUpdateOne.mockClear();

    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      pipelineId: 'pipe-1',
      pipelineName: 'Quality Evaluator',
      pipelineType: 'custom',
      stepId: 'store-results',
      stepType: 'store-results',
      config: {
        storageStrategy: 'score_and_document',
        destination: 'clickhouse',
        sourceStep: 'evaluate',
        scorePath: 'steps.evaluate.output.overallScore',
        scoreName: 'overallScore',
        documentPath: 'steps.evaluate.output',
      },
      previousSteps: {
        evaluate: {
          status: 'success',
          data: {
            overallScore: 4.2,
            dimensions: { accuracy: 3.9, helpfulness: 4.5 },
            reasoning: 'Useful answer with one missed detail.',
          },
        },
      },
      pipelineInput: { runId: 'run-xyz' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.recordsWritten).toBe(2);

    const insertedRow = mockClickHouseInsert.mock.calls[0][0].values[0];
    expect(insertedRow).toMatchObject({
      score_name: 'overallScore',
      score_path: 'steps.evaluate.output.overallScore',
      score_value: 4.2,
      output_json: JSON.stringify({ overallScore: 4.2 }),
    });

    expect(mockCollection).toHaveBeenCalledWith(CUSTOM_PIPELINE_RESULTS_COLLECTION);
    const insertedDoc = mockUpdateOne.mock.calls[0][1].$setOnInsert;
    expect(insertedDoc.output).toEqual({
      overallScore: 4.2,
      dimensions: { accuracy: 3.9, helpfulness: 4.5 },
      reasoning: 'Useful answer with one missed detail.',
    });
  });

  test('clickhouse destination includes run_id and pipeline_id in row', async () => {
    mockClickHouseInsert.mockClear();
    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      config: {
        destination: 'clickhouse',
        table: 'abl_platform.sentiment_scores',
        sourceStep: 'classify',
      },
      previousSteps: {
        classify: { status: 'success', data: { score: 0.9 } },
      },
      pipelineInput: { runId: 'run-xyz', pipelineId: 'pipe-1' },
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(mockClickHouseInsert).toHaveBeenCalledTimes(1);

    const insertedRow = mockClickHouseInsert.mock.calls[0][0].values[0];
    expect(insertedRow).toMatchObject({
      tenant_id: 'tenant-1',
      project_id: 'project-1',
      session_id: 'session-1',
      run_id: 'run-xyz',
      pipeline_id: 'pipe-1',
      score: 0.9,
    });
  });

  test('clickhouse created_at uses ClickHouse DateTime64 format (no T or Z)', async () => {
    mockClickHouseInsert.mockClear();
    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      config: {
        destination: 'clickhouse',
        table: 'abl_platform.test_table',
        sourceStep: 'step-a',
      },
      previousSteps: {
        'step-a': { status: 'success', data: { value: 1 } },
      },
      pipelineInput: { runId: 'run-1', pipelineId: 'pipe-1' },
    };

    await execute(ctx, input);

    const insertedRow = mockClickHouseInsert.mock.calls[0][0].values[0];
    // Must be 'YYYY-MM-DD HH:MM:SS.mmm' — no 'T', no 'Z'
    expect(insertedRow.created_at).not.toContain('T');
    expect(insertedRow.created_at).not.toContain('Z');
    expect(insertedRow.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  test('clickhouse destination defaults run_id and pipeline_id to empty string', async () => {
    mockClickHouseInsert.mockClear();
    const ctx = createMockContext();
    const input: PipelineStepContext = {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      config: {
        destination: 'clickhouse',
        table: 'abl_platform.test_table',
        sourceStep: 'step-a',
      },
      previousSteps: {
        'step-a': { status: 'success', data: { value: 42 } },
      },
      pipelineInput: {},
    };

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const insertedRow = mockClickHouseInsert.mock.calls[0][0].values[0];
    expect(insertedRow.run_id).toBe('');
    expect(insertedRow.pipeline_id).toBe('');
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb', table: 'runs' }, previousSteps);

    const result = await execute(ctx, input);
    expect(typeof result.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// run-legacy-workflow.service
// ---------------------------------------------------------------------------

describe('RunLegacyWorkflow service', () => {
  const execute = getExecute(runLegacyWorkflowService);

  test('missing workflow name returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({});

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('workflow');
  });

  test('empty string workflow name returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ workflow: '' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('workflow');
  });

  test('valid workflow name returns success', async () => {
    const ctx = createMockContext();
    const input = makeContext({ workflow: 'evaluateSessionMetrics' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
  });

  test('success result data contains workflow name and status', async () => {
    const ctx = createMockContext();
    const input = makeContext({ workflow: 'generateComplianceReport' });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data).toHaveProperty('data');
    expect(result.data.data).toHaveProperty('workflow', 'generateComplianceReport');
    expect(result.data.data).toHaveProperty('status', 'completed');
  });

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ workflow: 'syncTenantData' });

    const result = await execute(ctx, input);

    expect(typeof result.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Functional integration: EvaluateMetrics → EvaluatePolicy chaining
// ---------------------------------------------------------------------------

describe('Functional: toxicity evaluation of 2 consecutive user messages', () => {
  const executeMetrics = getExecute(evaluateMetricsService);
  const executePolicy = getExecute(evaluatePolicyService);

  /**
   * Scenario: An upstream scoring step has analyzed 2 consecutive user messages
   * and produced per-message toxicity scores. We run EvaluateMetrics to check
   * each against a threshold, then feed those results into EvaluatePolicy to
   * determine overall safety compliance.
   */
  test('safe messages pass both metrics and policy', async () => {
    const ctx = createMockContext();

    // Upstream scoring step produced toxicity scores for 2 messages
    const scoringOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'Hello, can you help me?', toxicity: 0.05 },
            msg2: { text: 'Thanks for the explanation!', toxicity: 0.02 },
          },
        },
      },
    };

    // Step 1: EvaluateMetrics — check each message's toxicity against threshold
    const metricsInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-001',
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: 0.7,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: 0.7,
          },
        ],
      },
      previousSteps: scoringOutput,
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-001' },
    };

    const metricsResult = await executeMetrics(ctx, metricsInput);

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(true);
    expect(metricsResult.data.overallScore).toBe(1.0);

    // Step 2: EvaluatePolicy — check metrics output against safety policy
    const policyInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-001',
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'overall-score-threshold',
            condition: 'steps.metrics-step.output.overallScore',
            operator: 'gte',
            expected: 0.8,
            severity: 'critical',
          },
          {
            name: 'msg1-must-pass',
            condition: 'steps.metrics-step.output.scores.msg1-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
          {
            name: 'msg2-must-pass',
            condition: 'steps.metrics-step.output.scores.msg2-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
        ],
      },
      previousSteps: {
        ...scoringOutput,
        'metrics-step': metricsResult,
      },
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-001' },
    };

    const policyResult = await executePolicy(ctx, policyInput);

    expect(policyResult.status).toBe('success');
    expect(policyResult.data.status).toBe('PASS');
    expect(policyResult.data.policyId).toBe('content-safety-v1');
    expect(policyResult.data.summary.passed).toBe(3);
    expect(policyResult.data.summary.failed).toBe(0);
    expect(policyResult.data.violations).toEqual([]);
  });

  test('toxic message fails metrics, triggers policy FAIL', async () => {
    const ctx = createMockContext();

    // Message 1 is safe, message 2 is toxic
    const scoringOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'What is your refund policy?', toxicity: 0.08 },
            msg2: { text: 'This is terrible, you are useless!', toxicity: 0.85 },
          },
        },
      },
    };

    // Step 1: EvaluateMetrics
    const metricsInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-002',
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: 0.7,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: 0.7,
          },
        ],
      },
      previousSteps: scoringOutput,
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-002' },
    };

    const metricsResult = await executeMetrics(ctx, metricsInput);

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg1-toxicity'].value).toBe(0.08);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(false);
    expect(metricsResult.data.scores['msg2-toxicity'].value).toBe(0.85);
    expect(metricsResult.data.overallScore).toBe(0.5); // 1 pass, 1 fail

    // Step 2: EvaluatePolicy — policy requires overallScore >= 0.8
    const policyInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-002',
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'overall-score-threshold',
            condition: 'steps.metrics-step.output.overallScore',
            operator: 'gte',
            expected: 0.8,
            severity: 'critical',
          },
          {
            name: 'no-toxic-messages',
            condition: 'steps.metrics-step.output.scores.msg2-toxicity.passed',
            operator: 'eq',
            expected: true,
            severity: 'critical',
          },
        ],
      },
      previousSteps: {
        ...scoringOutput,
        'metrics-step': metricsResult,
      },
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-002' },
    };

    const policyResult = await executePolicy(ctx, policyInput);

    expect(policyResult.status).toBe('success');
    expect(policyResult.data.status).toBe('FAIL');
    expect(policyResult.data.violations).toHaveLength(2);

    // Both rules failed: overallScore 0.5 < 0.8, msg2 passed = false
    const violationNames = policyResult.data.violations.map((v: any) => v.rule);
    expect(violationNames).toContain('overall-score-threshold');
    expect(violationNames).toContain('no-toxic-messages');

    // Both are critical severity → FAIL (not WARN)
    expect(policyResult.data.violations.every((v: any) => v.severity === 'critical')).toBe(true);
  });

  test('borderline toxicity triggers policy WARN with warning severity', async () => {
    const ctx = createMockContext();

    // Both messages are moderately toxic but below the critical threshold
    const scoringOutput: Record<string, StepOutput> = {
      'toxicity-scorer': {
        status: 'success',
        data: {
          messages: {
            msg1: { text: 'I am frustrated with your service', toxicity: 0.45 },
            msg2: { text: 'This wait time is ridiculous', toxicity: 0.55 },
          },
        },
      },
    };

    // Step 1: EvaluateMetrics — strict threshold 0.4 (both fail), lenient threshold 0.7 (both pass)
    const metricsInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-003',
      config: {
        metrics: [
          {
            name: 'msg1-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            threshold: 0.7,
            weight: 1.0,
          },
          {
            name: 'msg2-toxicity',
            field: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            threshold: 0.7,
            weight: 1.0,
          },
        ],
      },
      previousSteps: scoringOutput,
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-003' },
    };

    const metricsResult = await executeMetrics(ctx, metricsInput);

    expect(metricsResult.status).toBe('success');
    expect(metricsResult.data.scores['msg1-toxicity'].passed).toBe(true);
    expect(metricsResult.data.scores['msg2-toxicity'].passed).toBe(true);
    expect(metricsResult.data.overallScore).toBe(1.0);

    // Step 2: EvaluatePolicy — warning-level rule checks raw toxicity values
    const policyInput: PipelineStepContext = {
      tenantId: 'acme-corp',
      projectId: 'proj-safety',
      sessionId: 'sess-003',
      config: {
        policyId: 'content-safety-v1',
        rules: [
          {
            name: 'metrics-pass',
            condition: 'steps.metrics-step.output.overallScore',
            operator: 'gte',
            expected: 0.8,
            severity: 'critical',
          },
          {
            name: 'msg1-raw-toxicity-low',
            condition: 'steps.toxicity-scorer.output.messages.msg1.toxicity',
            operator: 'lte',
            expected: 0.3,
            severity: 'warning',
          },
          {
            name: 'msg2-raw-toxicity-low',
            condition: 'steps.toxicity-scorer.output.messages.msg2.toxicity',
            operator: 'lte',
            expected: 0.3,
            severity: 'warning',
          },
        ],
      },
      previousSteps: {
        ...scoringOutput,
        'metrics-step': metricsResult,
      },
      pipelineInput: { tenantId: 'acme-corp', projectId: 'proj-safety', sessionId: 'sess-003' },
    };

    const policyResult = await executePolicy(ctx, policyInput);

    expect(policyResult.status).toBe('success');
    // Critical rule passes (overallScore 1.0 >= 0.8), but warning rules fail
    expect(policyResult.data.status).toBe('WARN');
    expect(policyResult.data.summary.passed).toBe(1);
    expect(policyResult.data.summary.failed).toBe(2);
    expect(policyResult.data.summary.warnings).toBe(2);
    expect(policyResult.data.violations).toHaveLength(2);
    expect(policyResult.data.violations.every((v: any) => v.severity === 'warning')).toBe(true);
  });
});
