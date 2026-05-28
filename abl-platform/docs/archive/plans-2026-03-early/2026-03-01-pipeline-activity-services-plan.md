# Pipeline Activity Services Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all stub activity services in the pipeline engine with real implementations that evaluate metrics, enforce policies, send webhooks, and persist results to MongoDB.

**Architecture:** Each activity service is a Restate service that receives a `PipelineStepContext` (tenantId, config, previousSteps, pipelineInput) and returns a `StepOutput`. Services use the expression evaluator to resolve dynamic values from step outputs and pipeline input. The ActivityRouter dispatches to these services by calling their handler functions directly.

**Tech Stack:** Restate SDK, Mongoose (MongoDB), Node.js native `fetch`, custom expression evaluator

---

## Task 1: Expression Evaluator — Add `pipelineInput.*` Support

The expression evaluator currently only supports `steps.<stepId>.output.<path>` expressions. All activity services need to reference the original trigger event data via `pipelineInput.<path>` expressions. This is the foundation task — every subsequent task depends on it.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/expression-evaluator.ts`
- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`
- Modify: `packages/pipeline-engine/src/pipeline/services/transform.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/expression-evaluator.test.ts`

### Step 1: Update `resolveExpression` signature and implementation

**File:** `packages/pipeline-engine/src/pipeline/expression-evaluator.ts`

Add an optional third parameter `pipelineInput` and handle the `pipelineInput.*` prefix before the existing `steps.*` logic.

Current signature (line 77):

```typescript
export function resolveExpression(path: string, stepOutputs: Record<string, StepOutput>): unknown;
```

New signature:

```typescript
export function resolveExpression(
  path: string,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): unknown;
```

Add this block at the top of the function body, before the existing `steps` check:

```typescript
const segments = splitDotPath(path);

// Handle pipelineInput.* prefix — uses simple dot splitting (no hyphenated IDs)
if (segments[0] === 'pipelineInput') {
  if (!pipelineInput) return undefined;
  const parts = path.split('.');
  let current: unknown = pipelineInput;
  for (let i = 1; i < parts.length; i++) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[parts[i]];
  }
  return current;
}

// Existing steps.* logic continues unchanged...
```

**Important:** For `pipelineInput.*` paths, use `path.split('.')` directly instead of `splitDotPath()`. The `splitDotPath` function has special handling for hyphenated step IDs at position 1, which doesn't apply to `pipelineInput` paths. Pipeline input field names don't contain dots, so simple splitting works correctly.

### Step 2: Update `evaluateExpression` signature

Same file. Add optional `pipelineInput` parameter and forward it through the AST evaluator:

```typescript
export function evaluateExpression(
  expression: string,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): boolean {
  try {
    const tokens = tokenize(expression);
    const ast = parseExpression(tokens, 0);
    return Boolean(evaluate(ast.node, stepOutputs, pipelineInput));
  } catch {
    return false;
  }
}
```

### Step 3: Update internal `evaluate()` function

The private `evaluate()` function (line 498) needs to accept and forward `pipelineInput`:

```typescript
function evaluate(
  node: ASTNode,
  stepOutputs: Record<string, StepOutput>,
  pipelineInput?: Record<string, unknown>,
): unknown {
  switch (node.type) {
    // ... string_literal, number_literal, boolean_literal unchanged ...

    case 'dot_path':
      return resolveExpression(node.value, stepOutputs, pipelineInput);

    case 'not':
      return !evaluate(node.operand, stepOutputs, pipelineInput);

    case 'comparison': {
      const left = evaluate(node.left, stepOutputs, pipelineInput);
      const right = evaluate(node.right, stepOutputs, pipelineInput);
      return applyComparison(node.op, left, right);
    }

    case 'logical': {
      const left = evaluate(node.left, stepOutputs, pipelineInput);
      if (node.op === '&&') {
        if (!left) return false;
        return Boolean(evaluate(node.right, stepOutputs, pipelineInput));
      }
      if (node.op === '||') {
        if (left) return true;
        return Boolean(evaluate(node.right, stepOutputs, pipelineInput));
      }
      return false;
    }

    default:
      return undefined;
  }
}
```

### Step 4: Update callers

**File:** `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts` (line 72)

Change:

```typescript
const shouldRun = evaluateExpression(step.condition.expression, stepOutputs);
```

To:

```typescript
const shouldRun = evaluateExpression(step.condition.expression, stepOutputs, pipelineInput);
```

**File:** `packages/pipeline-engine/src/pipeline/services/transform.service.ts` (line 31)

Change:

```typescript
result[outputKey] = resolveExpression(expression, input.previousSteps);
```

To:

```typescript
result[outputKey] = resolveExpression(expression, input.previousSteps, input.pipelineInput);
```

### Step 5: Write tests

**File:** `packages/pipeline-engine/src/__tests__/expression-evaluator.test.ts`

Add a new `describe` block for pipelineInput support:

```typescript
describe('resolveExpression — pipelineInput prefix', () => {
  test('resolves top-level pipelineInput field', () => {
    expect(resolveExpression('pipelineInput.sessionId', stepOutputs, { sessionId: 'sess-1' })).toBe(
      'sess-1',
    );
  });

  test('resolves nested pipelineInput field', () => {
    expect(
      resolveExpression('pipelineInput.payload.score', stepOutputs, {
        payload: { score: 0.8 },
      }),
    ).toBe(0.8);
  });

  test('returns undefined for missing pipelineInput field', () => {
    expect(resolveExpression('pipelineInput.missing', stepOutputs, {})).toBeUndefined();
  });

  test('returns undefined when pipelineInput not provided', () => {
    expect(resolveExpression('pipelineInput.x', stepOutputs)).toBeUndefined();
  });
});

describe('evaluateExpression — pipelineInput prefix', () => {
  test('compares pipelineInput field to string literal', () => {
    expect(
      evaluateExpression("pipelineInput.channel == 'whatsapp'", stepOutputs, {
        channel: 'whatsapp',
      }),
    ).toBe(true);
  });

  test('compares pipelineInput field to number', () => {
    expect(
      evaluateExpression('pipelineInput.payload.score > 0.5', stepOutputs, {
        payload: { score: 0.8 },
      }),
    ).toBe(true);
  });

  test('mixes pipelineInput and steps references', () => {
    expect(
      evaluateExpression(
        "pipelineInput.channel == 'whatsapp' && steps.eval-safety.output.scores.toxicity > 0.5",
        stepOutputs,
        { channel: 'whatsapp' },
      ),
    ).toBe(true);
  });
});
```

### Step 6: Run tests

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
```

Expected: All existing tests still pass, new pipelineInput tests pass.

### Step 7: Commit

```bash
git add packages/pipeline-engine/src/pipeline/expression-evaluator.ts \
  packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts \
  packages/pipeline-engine/src/pipeline/services/transform.service.ts \
  packages/pipeline-engine/src/__tests__/expression-evaluator.test.ts
git commit -m "feat(pipeline-engine): add pipelineInput.* support to expression evaluator"
```

---

## Task 2: EvaluateMetrics — Threshold-Based Scoring

Replace the stub that returns `{ metricName: 0 }` with configurable metric evaluation using expression-resolved values compared against thresholds.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/evaluate-metrics.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

### Step 1: Write the failing tests

**File:** `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

Update the `EvaluateMetrics service` describe block. Keep existing validation tests. Replace the "valid metrics config returns success with scores" test and add new ones:

```typescript
describe('EvaluateMetrics service', () => {
  const execute = getExecute(evaluateMetricsService);

  // --- Existing validation tests (keep as-is) ---
  // missing metrics, empty array, non-array

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
```

### Step 2: Run tests to verify they fail

```bash
cd packages/pipeline-engine && pnpm build && pnpm test -- --reporter=verbose 2>&1 | grep -A2 'EvaluateMetrics'
```

Expected: New tests fail (stub returns `{ metricName: 0 }` not `{ scores: { metricName: { passed, value, score } } }`).

### Step 3: Implement the service

**File:** `packages/pipeline-engine/src/pipeline/services/evaluate-metrics.service.ts`

```typescript
/**
 * EvaluateMetrics — Restate activity service for threshold-based metric evaluation.
 *
 * Supports two config formats:
 * - Legacy: metrics: string[] → records metric names with default pass
 * - Structured: metrics: MetricRule[] → evaluates expressions against thresholds
 *
 * MetricRule shape:
 *   { name, field (expression), operator (gt|lt|eq|gte|lte), threshold, weight? }
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

interface MetricRule {
  name: string;
  field: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  weight?: number;
}

interface MetricResult {
  value: number;
  passed: boolean;
  score: number;
}

function applyOperator(op: string, value: number, threshold: number): boolean {
  if (isNaN(value)) return false;
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'eq':
      return value === threshold;
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    default:
      return false;
  }
}

export const evaluateMetricsService = restate.service({
  name: 'EvaluateMetrics',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const metrics = input.config.metrics as (string | MetricRule)[];

      if (!metrics || !Array.isArray(metrics) || metrics.length === 0) {
        return {
          status: 'fail',
          data: {
            error: "EvaluateMetrics requires a non-empty 'metrics' array in config",
          },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const result = await ctx.run('evaluate-metrics', async () => {
          const scores: Record<string, MetricResult> = {};
          let totalWeight = 0;
          let weightedSum = 0;

          for (const metric of metrics) {
            if (typeof metric === 'string') {
              // Legacy string format — record name, default pass
              scores[metric] = { value: 0, passed: true, score: 1.0 };
              totalWeight += 1;
              weightedSum += 1;
              continue;
            }

            const rule = metric as MetricRule;
            const resolved = resolveExpression(
              rule.field,
              input.previousSteps,
              input.pipelineInput,
            );
            const numericValue = Number(resolved);
            const passed = applyOperator(rule.operator, numericValue, rule.threshold);
            const score = passed ? 1.0 : 0.0;
            const weight = rule.weight ?? 1.0;

            scores[rule.name] = { value: numericValue, passed, score };
            totalWeight += weight;
            weightedSum += score * weight;
          }

          const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
          return { scores, overallScore };
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type EvaluateMetricsService = typeof evaluateMetricsService;
```

### Step 4: Run tests to verify they pass

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
```

### Step 5: Commit

```bash
git add packages/pipeline-engine/src/pipeline/services/evaluate-metrics.service.ts \
  packages/pipeline-engine/src/__tests__/activity-services.test.ts
git commit -m "feat(pipeline-engine): implement threshold-based metric evaluation"
```

---

## Task 3: EvaluatePolicy — Rule-Based Evaluation

Replace the stub returning `{ status: 'PASS' }` with inline policy rule evaluation that checks expressions against expected values.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/evaluate-policy.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

### Step 1: Write the failing tests

**File:** `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

Update the `EvaluatePolicy service` describe block. Keep existing validation tests:

```typescript
describe('EvaluatePolicy service', () => {
  const execute = getExecute(evaluatePolicyService);

  // --- Existing validation tests (keep as-is) ---
  // missing policyId, empty string policyId

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
```

### Step 2: Implement the service

**File:** `packages/pipeline-engine/src/pipeline/services/evaluate-policy.service.ts`

```typescript
/**
 * EvaluatePolicy — Restate activity service for rule-based policy evaluation.
 *
 * Evaluates inline policy rules against step outputs and pipeline input.
 * Each rule specifies a condition (expression), operator, and expected value.
 *
 * Returns PASS / WARN / FAIL based on violation severities:
 * - FAIL: any critical violation
 * - WARN: only warning/info violations
 * - PASS: all rules satisfied
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

interface PolicyRule {
  name: string;
  condition: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte';
  expected: string | number | boolean;
  severity?: 'critical' | 'warning' | 'info';
}

interface Violation {
  rule: string;
  actual: unknown;
  expected: unknown;
  severity: string;
}

function applyPolicyOperator(
  op: string,
  actual: unknown,
  expected: string | number | boolean,
): boolean {
  if (typeof expected === 'number') {
    const numActual = Number(actual);
    if (isNaN(numActual)) return false;
    switch (op) {
      case 'gt':
        return numActual > expected;
      case 'lt':
        return numActual < expected;
      case 'eq':
        return numActual === expected;
      case 'neq':
        return numActual !== expected;
      case 'gte':
        return numActual >= expected;
      case 'lte':
        return numActual <= expected;
      default:
        return false;
    }
  }
  // String/boolean comparison
  switch (op) {
    case 'eq':
      return String(actual) === String(expected);
    case 'neq':
      return String(actual) !== String(expected);
    default:
      return false;
  }
}

export const evaluatePolicyService = restate.service({
  name: 'EvaluatePolicy',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const policyId = input.config.policyId as string;

      if (!policyId) {
        return {
          status: 'fail',
          data: { error: "EvaluatePolicy requires 'policyId' in config" },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const rules = input.config.rules as PolicyRule[] | undefined;

        const result = await ctx.run('evaluate-policy', async () => {
          if (!rules || !Array.isArray(rules) || rules.length === 0) {
            return {
              status: 'PASS' as const,
              policyId,
              summary: { passed: 0, failed: 0, warnings: 0, total: 0 },
              violations: [] as Violation[],
            };
          }

          const violations: Violation[] = [];
          let passed = 0;
          let failed = 0;
          let warnings = 0;

          for (const rule of rules) {
            const actual = resolveExpression(
              rule.condition,
              input.previousSteps,
              input.pipelineInput,
            );
            const meets = applyPolicyOperator(rule.operator, actual, rule.expected);

            if (meets) {
              passed++;
            } else {
              const severity = rule.severity ?? 'warning';
              violations.push({
                rule: rule.name,
                actual,
                expected: rule.expected,
                severity,
              });
              failed++;
              if (severity === 'warning') warnings++;
            }
          }

          const hasCritical = violations.some((v) => v.severity === 'critical');
          const status = hasCritical ? 'FAIL' : failed > 0 ? 'WARN' : 'PASS';

          return {
            status,
            policyId,
            summary: { passed, failed, warnings, total: rules.length },
            violations,
          };
        });

        return {
          status: 'success',
          data: result,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type EvaluatePolicyService = typeof evaluatePolicyService;
```

### Step 3: Run tests

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
```

### Step 4: Commit

```bash
git add packages/pipeline-engine/src/pipeline/services/evaluate-policy.service.ts \
  packages/pipeline-engine/src/__tests__/activity-services.test.ts
git commit -m "feat(pipeline-engine): implement rule-based policy evaluation"
```

---

## Task 4: SendNotification — HTTP Webhook Dispatch

Replace stub `webhook` and `slack` channels with real `fetch()` calls. Keep `email` and `websocket` as stubs.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/send-notification.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

### Step 1: Write the failing tests

**File:** `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

Update the `SendNotification service` describe block. We need to mock global `fetch`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// At top of file or in describe block:
const mockFetch = vi.fn();

describe('SendNotification service', () => {
  const execute = getExecute(sendNotificationService);

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- Existing validation tests (keep) ---
  // missing channel, empty channel, unknown channel

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
});
```

### Step 2: Implement the service

**File:** `packages/pipeline-engine/src/pipeline/services/send-notification.service.ts`

```typescript
/**
 * SendNotification — Restate activity service for dispatching notifications.
 *
 * Channels:
 * - webhook / slack: Real HTTP POST via fetch() with SSRF protection
 * - email: Stub (requires SMTP service)
 * - websocket: Stub (requires Redis pub/sub)
 */
import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

const WEBHOOK_TIMEOUT_MS = 10_000;

/** Validate webhook URL: protocol check + basic SSRF protection. */
function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal';
  if (blocked && process.env.NODE_ENV === 'production') {
    throw new Error(`Webhook URL blocked: private/reserved address: ${hostname}`);
  }
}

/** Build notification payload. If body template provided, resolve expressions. */
function buildNotificationBody(input: PipelineStepContext): Record<string, unknown> {
  const bodyTemplate = input.config.body as Record<string, string> | undefined;

  if (bodyTemplate && typeof bodyTemplate === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bodyTemplate)) {
      if (
        typeof value === 'string' &&
        (value.startsWith('steps.') || value.startsWith('pipelineInput.'))
      ) {
        resolved[key] = resolveExpression(value, input.previousSteps, input.pipelineInput);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    stepOutputs: input.previousSteps,
    timestamp: new Date().toISOString(),
  };
}

export const sendNotificationService = restate.service({
  name: 'SendNotification',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const channel = input.config.channel as string;

      if (!channel) {
        return {
          status: 'fail',
          data: { error: "SendNotification requires 'channel' in config" },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const sent = await ctx.run(`send-${channel}`, async () => {
          switch (channel) {
            case 'webhook':
            case 'slack': {
              const url = (input.config.webhookUrl ?? input.config.url) as string;
              if (!url) {
                throw new Error(`${channel} channel requires 'webhookUrl' or 'url' in config`);
              }

              validateWebhookUrl(url);

              const body = buildNotificationBody(input);

              const response = await fetch(url, {
                method: (input.config.method as string) ?? 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...((input.config.headers as Record<string, string>) ?? {}),
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
              });

              if (!response.ok) {
                throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
              }

              return true;
            }

            case 'email':
              // Stub — requires SMTP service integration
              ctx.console.log(`[SendNotification] Email notification (stub)`);
              return true;

            case 'websocket':
              // Stub — requires Redis pub/sub integration
              ctx.console.log(`[SendNotification] WebSocket notification (stub)`);
              return true;

            default:
              throw new Error(`Unknown notification channel: '${channel}'`);
          }
        });

        return {
          status: 'success',
          data: { sent, channel },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type SendNotificationService = typeof sendNotificationService;
```

### Step 3: Run tests

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
```

### Step 4: Commit

```bash
git add packages/pipeline-engine/src/pipeline/services/send-notification.service.ts \
  packages/pipeline-engine/src/__tests__/activity-services.test.ts
git commit -m "feat(pipeline-engine): implement webhook notification dispatch"
```

---

## Task 5: StoreResults — MongoDB Persistence

Replace stub `mongodb` destination with real writes via `mongoose.connection.collection()`. Implement `callback` with real `fetch()`. Keep `clickhouse` as stub.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/store-results.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

### Step 1: Write the failing tests

**File:** `packages/pipeline-engine/src/__tests__/activity-services.test.ts`

```typescript
import { vi } from 'vitest';

// Mock mongoose at file level (before imports)
const mockInsertOne = vi.fn().mockResolvedValue({});
const mockCollection = vi.fn().mockReturnValue({ insertOne: mockInsertOne });

vi.mock('mongoose', () => ({
  default: {
    connection: {
      collection: mockCollection,
    },
  },
}));

describe('StoreResults service', () => {
  const execute = getExecute(storeResultsService);

  const previousSteps: Record<string, StepOutput> = {
    'step-a': { status: 'success', data: { value: 1 } },
    'step-b': { status: 'success', data: { value: 2 } },
  };

  beforeEach(() => {
    mockInsertOne.mockClear();
    mockCollection.mockClear();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- Existing validation tests (keep) ---
  // unknown destination, missing destination

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
    expect(mockInsertOne).toHaveBeenCalledTimes(1);
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

    const insertedDoc = mockInsertOne.mock.calls[0][0];
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

    const insertedDoc = mockInsertOne.mock.calls[0][0];
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

  test('mongodb missing collection name returns fail', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb' }, previousSteps);

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
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

  test('result includes durationMs', async () => {
    const ctx = createMockContext();
    const input = makeContext({ destination: 'mongodb', table: 'runs' }, previousSteps);

    const result = await execute(ctx, input);
    expect(typeof result.durationMs).toBe('number');
  });
});
```

### Step 2: Implement the service

**File:** `packages/pipeline-engine/src/pipeline/services/store-results.service.ts`

```typescript
/**
 * StoreResults — Restate activity service for persisting pipeline step outputs.
 *
 * Destinations:
 * - mongodb: Real write via mongoose.connection.collection()
 * - callback: Real HTTP POST via fetch()
 * - clickhouse: Stub (requires ClickHouse client dependency)
 */
import * as restate from '@restatedev/restate-sdk';
import mongoose from 'mongoose';
import { resolveExpression } from '../expression-evaluator.js';
import type { PipelineStepContext, StepOutput } from '../types.js';

const CALLBACK_TIMEOUT_MS = 10_000;

/** Alphanumeric, underscores, hyphens. 1-64 chars. Must start with letter or underscore. */
const COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/** Validate callback URL (same SSRF protection as SendNotification). */
function validateCallbackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid callback URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Callback URL must use http or https: ${url}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname === '169.254.169.254' ||
    hostname === 'metadata.google.internal';
  if (blocked && process.env.NODE_ENV === 'production') {
    throw new Error(`Callback URL blocked: private/reserved address: ${hostname}`);
  }
}

/** Build document from template (resolve expressions) or default (all step outputs). */
function buildDocument(
  input: PipelineStepContext,
  template?: Record<string, string>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  if (template && typeof template === 'object') {
    for (const [key, value] of Object.entries(template)) {
      if (
        typeof value === 'string' &&
        (value.startsWith('steps.') || value.startsWith('pipelineInput.'))
      ) {
        doc[key] = resolveExpression(value, input.previousSteps, input.pipelineInput);
      } else {
        doc[key] = value;
      }
    }
  } else {
    doc.stepOutputs = input.previousSteps;
    doc.pipelineInput = input.pipelineInput;
    doc.projectId = input.projectId;
    doc.sessionId = input.sessionId;
  }

  // Always include tenantId and timestamp for isolation and auditability
  doc.tenantId = input.tenantId;
  doc.createdAt = new Date();
  return doc;
}

export const storeResultsService = restate.service({
  name: 'StoreResults',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const { destination, callbackUrl } = input.config;

      try {
        let recordsWritten = 0;

        switch (destination) {
          case 'clickhouse':
            recordsWritten = await ctx.run('store-clickhouse', async () => {
              // TODO: Requires ClickHouse client dependency
              ctx.console.log(
                `[StoreResults] Writing to ClickHouse table=${input.config.table} (stub)`,
              );
              return Object.keys(input.previousSteps).length;
            });
            break;

          case 'mongodb':
            recordsWritten = await ctx.run('store-mongodb', async () => {
              const collectionName =
                (input.config.collection as string) ?? (input.config.table as string);
              if (!collectionName) {
                throw new Error("MongoDB destination requires 'collection' or 'table' in config");
              }
              if (!COLLECTION_NAME_RE.test(collectionName)) {
                throw new Error(`Invalid collection name: '${collectionName}'`);
              }

              const document = buildDocument(
                input,
                input.config.document as Record<string, string> | undefined,
              );

              const collection = mongoose.connection.collection(collectionName);
              await collection.insertOne(document);
              return 1;
            });
            break;

          case 'callback':
            recordsWritten = await ctx.run('store-callback', async () => {
              if (!callbackUrl) {
                throw new Error('Callback destination requires callbackUrl');
              }
              validateCallbackUrl(callbackUrl as string);

              const body = {
                tenantId: input.tenantId,
                projectId: input.projectId,
                sessionId: input.sessionId,
                stepOutputs: input.previousSteps,
                timestamp: new Date().toISOString(),
              };

              const response = await fetch(callbackUrl as string, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
              });

              if (!response.ok) {
                throw new Error(`Callback returned ${response.status}: ${response.statusText}`);
              }
              return 1;
            });
            break;

          default:
            return {
              status: 'fail',
              data: { error: `Unknown destination: '${destination}'` },
              durationMs: Date.now() - startTime,
            };
        }

        return {
          status: 'success',
          data: { recordsWritten, destination },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type StoreResultsService = typeof storeResultsService;
```

### Step 3: Run tests, commit

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
git add packages/pipeline-engine/src/pipeline/services/store-results.service.ts \
  packages/pipeline-engine/src/__tests__/activity-services.test.ts
git commit -m "feat(pipeline-engine): implement mongodb persistence and callback dispatch"
```

---

## Task 6: ActivityRouter — Wire Real Service Dispatch

Replace the `executeActivity()` stub with a dispatch table that calls real service handler functions.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`
- Test: `packages/pipeline-engine/src/__tests__/activity-router.test.ts`

### Step 1: Update the router implementation

**File:** `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`

```typescript
/**
 * ActivityRouter — Restate service that routes step execution to activity services.
 *
 * Dispatches to the real activity service handler based on step.type.
 * Handlers are called directly (not via ctx.serviceClient) since:
 * 1. The workflow already calls ActivityRouter via ctx.serviceClient (durability boundary)
 * 2. Each handler manages its own ctx.run() blocks for journal durability
 * 3. Nested ctx.run() calls would violate Restate's journal model
 */
import * as restate from '@restatedev/restate-sdk';
import { ACTIVITY_TYPES } from '../activity-metadata.js';
import type { PipelineStep, PipelineStepContext, StepOutput } from '../types.js';

// Import real service modules
import { evaluateMetricsService } from '../services/evaluate-metrics.service.js';
import { evaluatePolicyService } from '../services/evaluate-policy.service.js';
import { sendNotificationService } from '../services/send-notification.service.js';
import { storeResultsService } from '../services/store-results.service.js';
import { transformService } from '../services/transform.service.js';
import { runLegacyWorkflowService } from '../services/run-legacy-workflow.service.js';

/** Input shape for the execute handler. */
export interface ActivityRouterInput {
  step: PipelineStep;
  previousSteps: Record<string, StepOutput>;
  pipelineInput: Record<string, any>;
}

/**
 * Dispatch table: maps activity type → raw handler function.
 *
 * Restate wraps service definitions so handlers are at .service.execute,
 * not .handlers.execute. Using `as any` because the Restate SDK types
 * don't expose the internal service property.
 */
const SERVICE_HANDLERS: Record<
  string,
  (ctx: restate.Context, input: PipelineStepContext) => Promise<StepOutput>
> = {
  'evaluate-metrics': (evaluateMetricsService as any).service.execute,
  'evaluate-policy': (evaluatePolicyService as any).service.execute,
  'send-notification': (sendNotificationService as any).service.execute,
  'store-results': (storeResultsService as any).service.execute,
  transform: (transformService as any).service.execute,
  'run-legacy-workflow': (runLegacyWorkflowService as any).service.execute,
};

export const activityRouter = restate.service({
  name: 'ActivityRouter',
  handlers: {
    execute: async (ctx: restate.Context, input: ActivityRouterInput): Promise<StepOutput> => {
      const { step, previousSteps, pipelineInput } = input;
      const startTime = Date.now();

      const metadata = ACTIVITY_TYPES[step.type];
      if (!metadata) {
        return {
          status: 'fail',
          data: { error: `Unknown activity type: '${step.type}'` },
        };
      }

      const stepContext: PipelineStepContext = {
        tenantId: pipelineInput.tenantId,
        projectId: pipelineInput.projectId,
        sessionId: pipelineInput.sessionId,
        config: step.config,
        previousSteps,
        pipelineInput,
      };

      try {
        const handler = SERVICE_HANDLERS[step.type];
        if (!handler) {
          return {
            status: 'fail',
            data: { error: `No handler registered for activity type: '${step.type}'` },
            durationMs: Date.now() - startTime,
          };
        }

        // Call handler directly — it manages its own ctx.run() blocks.
        // Do NOT wrap in ctx.run() (would nest ctx.run calls, breaking Restate journal).
        const result = await handler(ctx, stepContext);

        return { ...result, durationMs: Date.now() - startTime };
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
            type: step.type,
          },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ActivityRouterService = typeof activityRouter;
```

### Step 2: Update router tests

**File:** `packages/pipeline-engine/src/__tests__/activity-router.test.ts`

Update the tests that rely on the stub returning generic success. Now the router dispatches to real handlers, so:

- `evaluate-metrics` with `{ metrics: ['toxicity'] }` → returns real metric scores (legacy string format)
- `evaluate-policy` with `{ policyId: 'pci-dss' }` → returns PASS (no rules = default pass)
- `send-notification` with `{ channel: 'email' }` → returns success (email is still a stub)
- `store-results` with `{ destination: 'clickhouse', table: 'x' }` → returns success (CH is still stub)
- `transform` with `{ mapping: {} }` → returns success with empty data
- `run-legacy-workflow` with `{ workflow: 'myWorkflow' }` → returns success (stub)

Most existing tests should still pass since the real handlers follow the same contract. Update any that check for stub-specific responses.

Add test verifying real metric evaluation through the router:

```typescript
test('router dispatches evaluate-metrics to real handler with structured rules', async () => {
  const ctx = createMockRouterContext();
  const previousSteps: Record<string, StepOutput> = {
    'eval-step': { status: 'success', data: { scores: { toxicity: 0.3 } } },
  };
  const input = makeRouterInput(
    {
      type: 'evaluate-metrics',
      config: {
        metrics: [
          {
            name: 'toxicity',
            field: 'steps.eval-step.output.scores.toxicity',
            operator: 'lte',
            threshold: 0.7,
          },
        ],
      },
    },
    previousSteps,
  );

  const result = await execute(ctx, input);

  expect(result.status).toBe('success');
  expect(result.data.scores['toxicity'].passed).toBe(true);
});
```

### Step 3: Run tests, commit

```bash
cd packages/pipeline-engine && pnpm build && pnpm test
git add packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts \
  packages/pipeline-engine/src/__tests__/activity-router.test.ts
git commit -m "feat(pipeline-engine): wire activity router to real service handlers"
```

---

## Task 7: Activity Metadata Schema Updates

Update the config and output schemas in `activity-metadata.ts` to reflect the new structured config options.

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts`

### Changes:

**`evaluate-metrics`:** Update configSchema to document structured rule format:

```typescript
configSchema: {
  required: ['metrics'],
  properties: {
    metrics: {
      type: 'array',
      description: 'Metric rules: string names (legacy) or { name, field, operator, threshold, weight? }',
    },
  },
},
outputSchema: {
  properties: {
    scores: { type: 'object', description: 'Metric name → { value, passed, score } mapping' },
    overallScore: { type: 'number', description: 'Weighted average score (0.0 to 1.0)' },
  },
},
```

**`evaluate-policy`:** Add rules property:

```typescript
configSchema: {
  required: ['policyId'],
  properties: {
    policyId: { type: 'string', description: 'Policy identifier (label)' },
    rules: {
      type: 'array',
      description: 'Policy rules: { name, condition, operator, expected, severity? }',
    },
  },
},
outputSchema: {
  properties: {
    status: { type: 'string', description: 'PASS | WARN | FAIL' },
    policyId: { type: 'string', description: 'Policy identifier' },
    summary: { type: 'object', description: '{ passed, failed, warnings, total }' },
    violations: { type: 'array', description: 'Rule violations with details' },
  },
},
```

**`send-notification`:** Add URL, method, headers, body properties:

```typescript
configSchema: {
  required: ['channel'],
  properties: {
    channel: { type: 'string', description: 'Notification channel: slack | email | webhook | websocket' },
    webhookUrl: { type: 'string', description: 'Webhook/Slack incoming webhook URL' },
    url: { type: 'string', description: 'Alternative to webhookUrl' },
    method: { type: 'string', description: 'HTTP method (default: POST)' },
    headers: { type: 'object', description: 'Additional HTTP headers' },
    body: { type: 'object', description: 'Body template with expression values' },
    to: { type: 'array', description: 'Email recipients (for email channel)' },
    template: { type: 'string', description: 'Message template with {{variable}} placeholders' },
  },
},
```

**`store-results`:** Add collection, document properties:

```typescript
configSchema: {
  required: ['destination'],
  properties: {
    destination: { type: 'string', description: 'Target: clickhouse | mongodb | callback' },
    table: { type: 'string', description: 'Table/collection name (for clickhouse/mongodb)' },
    collection: { type: 'string', description: 'MongoDB collection name (alias for table)' },
    document: { type: 'object', description: 'Document template with expression field values' },
    callbackUrl: { type: 'string', description: 'HTTP callback URL (for callback destination)' },
  },
},
```

### Commit:

```bash
git add packages/pipeline-engine/src/pipeline/activity-metadata.ts
git commit -m "docs(pipeline-engine): update activity metadata schemas for new config options"
```

---

## Implementation Order & Dependencies

```
Task 1 (expression evaluator) ← foundation, all tasks depend on this
  ├── Task 2 (evaluate-metrics)  ← independent
  ├── Task 3 (evaluate-policy)   ← independent
  ├── Task 4 (send-notification) ← independent
  └── Task 5 (store-results)     ← independent
Task 6 (activity router)         ← depends on Tasks 2-5
Task 7 (metadata schemas)        ← can be done alongside any task
```

Tasks 2-5 are independent of each other and can be implemented in any order after Task 1.

---

## Verification

1. **Unit tests:** `cd packages/pipeline-engine && pnpm build && pnpm test`
2. **E2E test:** Start pipeline worker (`pnpm dev` in pipeline-engine), trigger via runtime SDK message:
   - Verify pipeline runs with real service logic (not stubs)
   - Check MongoDB run record shows real step output data
   - Verify `pipelineInput.*` expressions resolve correctly in conditions
3. **Seed data:** The test pipeline definition (`pip-competitor-mention-001`) should be updated to use structured metric rules and policy rules for meaningful E2E validation
