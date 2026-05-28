# Workflow Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a configurable pipeline engine using Restate for durable workflow execution, with Kafka event triggers and Studio UI for pipeline management.

**Architecture:** `packages/workflow-engine/` contains Restate handlers (workflow, services, virtual objects), types, validation, and expression evaluator. Pipeline CRUD lives in Studio Next.js API routes. Pipelines are invoked internally via Kafka subscriptions, schedules, or Restate SDK — no REST execution API.

**Tech Stack:** Restate SDK (`@restatedev/restate-sdk` + `@restatedev/restate-sdk-clients`), Mongoose (MongoDB), Vitest, TypeScript (NodeNext ESM), Next.js API routes (Studio)

**Design Doc:** `docs/plans/2026-02-27-restate-pipeline-engine-design.md`

---

## Task 1: Package Scaffold

Create the `packages/workflow-engine/` package with correct monorepo structure.

**Files:**

- Create: `packages/workflow-engine/package.json`
- Create: `packages/workflow-engine/tsconfig.json`
- Create: `packages/workflow-engine/vitest.config.ts`
- Create: `packages/workflow-engine/src/index.ts`

**Step 1: Create `packages/workflow-engine/package.json`**

```json
{
  "name": "@agent-platform/workflow-engine",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./client": {
      "import": "./dist/client.js",
      "types": "./dist/client.d.ts"
    },
    "./validation": {
      "import": "./dist/pipeline/validation.js",
      "types": "./dist/pipeline/validation.d.ts"
    },
    "./metadata": {
      "import": "./dist/pipeline/activity-metadata.js",
      "types": "./dist/pipeline/activity-metadata.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "dev": "tsx watch src/pipeline/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@restatedev/restate-sdk": "^1.4",
    "@restatedev/restate-sdk-clients": "^1.4"
  },
  "devDependencies": {
    "vitest": "^1.6.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Create `packages/workflow-engine/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create `packages/workflow-engine/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    testTimeout: 30_000,
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```

**Step 4: Create `packages/workflow-engine/src/index.ts`**

```typescript
// Core types
export type {
  PipelineStepContext,
  StepOutput,
  PipelineRunInput,
  PipelineStep,
  PipelineDefinition,
  PipelineRunState,
} from './pipeline/types.js';

// Validation
export { validatePipeline } from './pipeline/validation.js';
export type { ValidationError } from './pipeline/validation.js';

// Activity metadata
export {
  ACTIVITY_TYPES,
  listActivityTypes,
  getActivityMetadata,
} from './pipeline/activity-metadata.js';
export type { ActivityTypeMetadata } from './pipeline/activity-metadata.js';

// Expression evaluator
export {
  evaluateExpression,
  resolveExpression,
  isSafeExpression,
  extractStepReferences,
} from './pipeline/expression-evaluator.js';

// Restate client
export { getRestateClient } from './client.js';

// Restate handler references (for SDK invocation)
export { pipelineRun } from './pipeline/handlers/pipeline-run.workflow.js';
export { pipelineTrigger } from './pipeline/handlers/pipeline-trigger.service.js';
export { pipelineScheduler } from './pipeline/handlers/pipeline-scheduler.js';
```

**Step 5: Install dependencies**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm install`

**Step 6: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/workflow-engine`
Expected: Compilation succeeds (with missing import errors — expected, files don't exist yet)

**Step 7: Commit**

```
feat(workflow-engine): scaffold package structure
```

---

## Task 2: Core Types

Define all TypeScript interfaces used across the workflow engine.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/types.ts`
- Create: `packages/workflow-engine/src/client.ts`

**Step 1: Create `packages/workflow-engine/src/pipeline/types.ts`**

Full type definitions from the design doc Section 5.1. Copy the complete `types.ts` content from the design doc — it contains:

- `PipelineStepContext`
- `StepOutput`
- `PipelineRunInput`
- `PipelineStep`
- `PipelineDefinition`
- `PipelineRunState`

**Step 2: Create `packages/workflow-engine/src/client.ts`**

```typescript
import * as restate from '@restatedev/restate-sdk-clients';

export function getRestateClient() {
  return restate.connect({
    url: process.env.RESTATE_INGRESS_URL ?? 'http://localhost:8080',
  });
}
```

**Step 3: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 4: Commit**

```
feat(workflow-engine): add core types and Restate client
```

---

## Task 3: Expression Evaluator (TDD)

Pure functions with no external dependencies — ideal for TDD.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/expression-evaluator.ts`
- Create: `packages/workflow-engine/src/__tests__/expression-evaluator.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, test, expect } from 'vitest';
import {
  evaluateExpression,
  resolveExpression,
  isSafeExpression,
  extractStepReferences,
} from '../pipeline/expression-evaluator.js';
import type { StepOutput } from '../pipeline/types.js';

const stepOutputs: Record<string, StepOutput> = {
  'eval-safety': {
    status: 'success',
    data: { scores: { toxicity: 0.9, bias: 0.3 }, status: 'success' },
  },
  'check-policy': {
    status: 'fail',
    data: { status: 'FAIL', summary: { passed: 2, failed: 1 } },
  },
  'skipped-step': {
    status: 'skipped',
    data: {},
  },
};

describe('evaluateExpression', () => {
  test('string equality — true', () => {
    expect(evaluateExpression("steps.check-policy.output.status == 'FAIL'", stepOutputs)).toBe(
      true,
    );
  });

  test('string equality — false', () => {
    expect(evaluateExpression("steps.check-policy.output.status == 'PASS'", stepOutputs)).toBe(
      false,
    );
  });

  test('numeric comparison — greater than', () => {
    expect(evaluateExpression('steps.eval-safety.output.scores.toxicity > 0.7', stepOutputs)).toBe(
      true,
    );
  });

  test('numeric comparison — less than', () => {
    expect(evaluateExpression('steps.eval-safety.output.scores.toxicity < 0.5', stepOutputs)).toBe(
      false,
    );
  });

  test('logical AND', () => {
    expect(
      evaluateExpression(
        "steps.eval-safety.output.status == 'success' && steps.check-policy.output.status == 'FAIL'",
        stepOutputs,
      ),
    ).toBe(true);
  });

  test('logical OR', () => {
    expect(
      evaluateExpression(
        "steps.check-policy.output.status == 'PASS' || steps.eval-safety.output.scores.toxicity > 0.5",
        stepOutputs,
      ),
    ).toBe(true);
  });

  test('negation', () => {
    expect(evaluateExpression("!steps.skipped-step.output.status == 'success'", stepOutputs)).toBe(
      true,
    );
  });

  test('nested property access', () => {
    expect(evaluateExpression('steps.check-policy.output.summary.failed > 0', stepOutputs)).toBe(
      true,
    );
  });

  test('missing step returns false safely', () => {
    expect(evaluateExpression("steps.nonexistent.output.x == 'y'", stepOutputs)).toBe(false);
  });
});

describe('resolveExpression', () => {
  test('resolves nested dot path', () => {
    expect(resolveExpression('steps.eval-safety.output.scores.toxicity', stepOutputs)).toBe(0.9);
  });

  test('resolves object', () => {
    expect(resolveExpression('steps.check-policy.output.summary', stepOutputs)).toEqual({
      passed: 2,
      failed: 1,
    });
  });

  test('returns undefined for missing path', () => {
    expect(resolveExpression('steps.nonexistent.output.x', stepOutputs)).toBeUndefined();
  });
});

describe('isSafeExpression', () => {
  test('allows comparison expressions', () => {
    expect(isSafeExpression("steps.x.output.status == 'FAIL'")).toBe(true);
  });

  test('allows logical operators', () => {
    expect(isSafeExpression('steps.a.output.x > 0 && steps.b.output.y == true')).toBe(true);
  });

  test('rejects function keyword', () => {
    expect(isSafeExpression('function() {}')).toBe(false);
  });

  test('rejects eval', () => {
    expect(isSafeExpression("eval('code')")).toBe(false);
  });

  test('rejects bracket access', () => {
    expect(isSafeExpression("steps['x'].output")).toBe(false);
  });

  test('rejects require', () => {
    expect(isSafeExpression("require('fs')")).toBe(false);
  });

  test('rejects constructor', () => {
    expect(isSafeExpression('constructor.prototype')).toBe(false);
  });

  test('rejects __proto__', () => {
    expect(isSafeExpression('__proto__')).toBe(false);
  });

  test('rejects arithmetic', () => {
    expect(isSafeExpression('steps.x.output.a + steps.x.output.b')).toBe(false);
  });
});

describe('extractStepReferences', () => {
  test('extracts single reference', () => {
    expect(extractStepReferences("steps.check-policy.output.status == 'FAIL'")).toEqual([
      'check-policy',
    ]);
  });

  test('extracts multiple references', () => {
    expect(
      extractStepReferences('steps.eval-a.output.x > 0 && steps.eval-b.output.y == true'),
    ).toEqual(['eval-a', 'eval-b']);
  });

  test('deduplicates references', () => {
    expect(
      extractStepReferences('steps.eval-a.output.x > 0 && steps.eval-a.output.y == true'),
    ).toEqual(['eval-a']);
  });

  test('returns empty for no references', () => {
    expect(extractStepReferences('true')).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: FAIL — module not found

**Step 3: Implement `expression-evaluator.ts`**

Copy the full implementation from the design doc Section 8.3. The `safeEval` function needs a simple recursive descent parser or a safe subset evaluator. Implement a minimal tokenizer + evaluator that supports only the allowed operations. Do NOT use `eval()` or `new Function()`.

**Step 4: Run tests to verify they pass**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: All tests PASS

**Step 5: Commit**

```
feat(workflow-engine): add expression evaluator with safe subset parser
```

---

## Task 4: Activity Metadata Registry

Static registry — no external dependencies, pure data.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/activity-metadata.ts`

**Step 1: Create `activity-metadata.ts`**

Copy the full `ACTIVITY_TYPES` registry, `ActivityTypeMetadata` interface, `getActivityMetadata()`, and `listActivityTypes()` from the design doc Section 7.1.

All 6 activity types:

- `evaluate-metrics`
- `evaluate-policy`
- `store-results`
- `send-notification`
- `transform`
- `run-legacy-workflow`

**Step 2: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 3: Commit**

```
feat(workflow-engine): add activity type metadata registry
```

---

## Task 5: Pipeline Validation (TDD)

**Files:**

- Create: `packages/workflow-engine/src/pipeline/validation.ts`
- Create: `packages/workflow-engine/src/__tests__/validation.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, test, expect } from 'vitest';
import { validatePipeline } from '../pipeline/validation.js';
import type { PipelineDefinition } from '../pipeline/types.js';

function makePipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    _id: 'pip-1',
    tenantId: 't-1',
    name: 'Test Pipeline',
    version: 1,
    status: 'draft',
    trigger: { type: 'manual' },
    steps: [
      { id: 'step-1', name: 'Step 1', type: 'evaluate-metrics', config: { metrics: ['toxicity'] } },
    ],
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineDefinition;
}

describe('validatePipeline', () => {
  test('valid pipeline returns no errors', () => {
    expect(validatePipeline(makePipeline())).toEqual([]);
  });

  test('empty steps array returns error', () => {
    const errors = validatePipeline(makePipeline({ steps: [] }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('at least one step');
  });

  test('duplicate step IDs returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          { id: 'dup', name: 'A', type: 'evaluate-metrics', config: { metrics: ['x'] } },
          { id: 'dup', name: 'B', type: 'evaluate-metrics', config: { metrics: ['y'] } },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('Duplicate step ID'))).toBe(true);
  });

  test('unknown activity type returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [{ id: 's1', name: 'S1', type: 'nonexistent-type', config: {} }],
      }),
    );
    expect(errors.some((e) => e.message.includes('Unknown activity type'))).toBe(true);
  });

  test('unsafe expression returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          { id: 's1', name: 'S1', type: 'evaluate-metrics', config: { metrics: ['x'] } },
          {
            id: 's2',
            name: 'S2',
            type: 'transform',
            config: { mapping: {} },
            condition: { expression: "eval('code')" },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('unsupported operations'))).toBe(true);
  });

  test('condition referencing unknown step returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            config: { metrics: ['x'] },
            condition: { expression: "steps.nonexistent.output.status == 'ok'" },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('unknown step'))).toBe(true);
  });

  test('condition referencing later step returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            config: { metrics: ['x'] },
            condition: { expression: "steps.s2.output.status == 'ok'" },
          },
          { id: 's2', name: 'S2', type: 'evaluate-metrics', config: { metrics: ['y'] } },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('not before this step'))).toBe(true);
  });

  test('non-contiguous parallel group returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['x'] },
          },
          { id: 's2', name: 'S2', type: 'evaluate-metrics', config: { metrics: ['y'] } },
          {
            id: 's3',
            name: 'S3',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['z'] },
          },
        ],
      }),
    );
    expect(errors.some((e) => e.message.includes('not contiguous'))).toBe(true);
  });

  test('contiguous parallel group passes', () => {
    const errors = validatePipeline(
      makePipeline({
        steps: [
          {
            id: 's1',
            name: 'S1',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['x'] },
          },
          {
            id: 's2',
            name: 'S2',
            type: 'evaluate-metrics',
            parallel: 'group-a',
            config: { metrics: ['y'] },
          },
          {
            id: 's3',
            name: 'S3',
            type: 'store-results',
            config: { destination: 'clickhouse', table: 't' },
          },
        ],
      }),
    );
    expect(errors).toEqual([]);
  });

  test('kafka trigger without topic returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'kafka' },
      }),
    );
    expect(errors.some((e) => e.message.includes('kafkaTopic'))).toBe(true);
  });

  test('schedule trigger without cron returns error', () => {
    const errors = validatePipeline(
      makePipeline({
        trigger: { type: 'schedule' },
      }),
    );
    expect(errors.some((e) => e.message.includes('schedule'))).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: FAIL

**Step 3: Implement `validation.ts`**

Copy the full `validatePipeline()` implementation from the design doc Section 9.1. For `validateJsonSchema()`, use a minimal inline validator that checks `required` fields exist and field `type` matches — a full JSON Schema library (like ajv) can be added later if needed.

**Step 4: Run tests to verify they pass**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: All tests PASS

**Step 5: Commit**

```
feat(workflow-engine): add pipeline definition validation
```

---

## Task 6: Restate Handlers — PipelineRun Workflow

The DAG interpreter workflow. This is the core of the engine.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/handlers/pipeline-run.workflow.ts`

**Step 1: Implement the PipelineRun workflow**

Copy the full workflow implementation from the design doc Section 6.1. Key pieces:

- `run` handler: the while loop that processes steps sequentially/parallel with conditions
- `getStatus` shared handler: returns durable state for external queries
- `updateStepState` helper function

**Step 2: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`
Expected: Type errors for missing `activityRouter` import — that's expected, we build it next.

**Step 3: Commit**

```
feat(workflow-engine): add PipelineRun workflow handler
```

---

## Task 7: Restate Handlers — ActivityRouter Service

**Files:**

- Create: `packages/workflow-engine/src/pipeline/handlers/activity-router.service.ts`

**Step 1: Implement the ActivityRouter**

Copy from the design doc Section 6.2. The switch statement dispatches to activity services by `step.type`.

**Step 2: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 3: Commit**

```
feat(workflow-engine): add ActivityRouter service handler
```

---

## Task 8: Restate Handlers — PipelineTrigger + PipelineScheduler

**Files:**

- Create: `packages/workflow-engine/src/pipeline/handlers/pipeline-trigger.service.ts`
- Create: `packages/workflow-engine/src/pipeline/handlers/pipeline-scheduler.ts`
- Create: `packages/workflow-engine/src/pipeline/utils/cron.ts`

**Step 1: Implement PipelineTrigger**

Copy from the design doc Section 6.3. Two handlers:

- `handleEvent`: Kafka event handler — finds matching pipelines, starts workflows
- `triggerManual`: programmatic trigger — loads pipeline, starts workflow

The MongoDB query functions (`findActivePipelinesForEvent`, `loadActivePipeline`, `createRunRecord`) should be stubbed as module-level functions that will be connected to real Mongoose models later.

**Step 2: Implement PipelineScheduler**

Copy from the design doc Section 6.4. Virtual object keyed by pipeline ID with:

- `start`: durable sleep loop
- `stop`: sets `active = false`
- `getScheduleStatus`: shared query handler

**Step 3: Implement cron utility**

`packages/workflow-engine/src/pipeline/utils/cron.ts` — a `getNextCronTime(cronExpression: string, now: number): number` function. Use the `cron-parser` npm package or implement a minimal cron parser.

**Step 4: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 5: Commit**

```
feat(workflow-engine): add PipelineTrigger and PipelineScheduler handlers
```

---

## Task 9: Activity Services — Transform + StoreResults

Start with the two simplest activity services.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/services/transform.service.ts`
- Create: `packages/workflow-engine/src/pipeline/services/store-results.service.ts`

**Step 1: Implement Transform service**

Copy from the design doc Section 7.6. Uses `resolveExpression()` from the expression evaluator.

**Step 2: Implement StoreResults service**

Copy from the design doc Section 7.4. Three destinations: `clickhouse`, `mongodb`, `callback`. The ClickHouse and MongoDB clients should be stubbed as module-level getters (`getClickHouseService()`, `getMongoDb()`) to be wired up during deployment.

**Step 3: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 4: Commit**

```
feat(workflow-engine): add Transform and StoreResults activity services
```

---

## Task 10: Activity Services — EvaluateMetrics + EvaluatePolicy + SendNotification + RunLegacyWorkflow

**Files:**

- Create: `packages/workflow-engine/src/pipeline/services/evaluate-metrics.service.ts`
- Create: `packages/workflow-engine/src/pipeline/services/evaluate-policy.service.ts`
- Create: `packages/workflow-engine/src/pipeline/services/send-notification.service.ts`
- Create: `packages/workflow-engine/src/pipeline/services/run-legacy-workflow.service.ts`

**Step 1: Implement all four services**

Copy from the design doc Sections 7.2, 7.3, 7.5, 7.7. Each wraps existing service logic via `ctx.run()` for journal durability.

All external service dependencies should be accessed via module-level getter functions (e.g., `getMetricsEvaluationService()`, `getPolicyEvaluationService()`, `getTemporalClient()`). These will be wired to real implementations during deployment integration.

**Step 2: Verify typecheck**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine typecheck`

**Step 3: Commit**

```
feat(workflow-engine): add evaluation, notification, and legacy bridge services
```

---

## Task 11: Restate Server Entrypoint

Bind all handlers into a single Restate endpoint.

**Files:**

- Create: `packages/workflow-engine/src/pipeline/server.ts`

**Step 1: Implement server.ts**

```typescript
import * as restate from '@restatedev/restate-sdk';

import { pipelineRun } from './handlers/pipeline-run.workflow.js';
import { pipelineTrigger } from './handlers/pipeline-trigger.service.js';
import { pipelineScheduler } from './handlers/pipeline-scheduler.js';
import { activityRouter } from './handlers/activity-router.service.js';
import { evaluateMetricsService } from './services/evaluate-metrics.service.js';
import { evaluatePolicyService } from './services/evaluate-policy.service.js';
import { storeResultsService } from './services/store-results.service.js';
import { sendNotificationService } from './services/send-notification.service.js';
import { transformService } from './services/transform.service.js';
import { runLegacyWorkflowService } from './services/run-legacy-workflow.service.js';

const port = parseInt(process.env.RESTATE_SERVICE_PORT ?? '9080', 10);

restate
  .endpoint()
  .bind(pipelineRun)
  .bind(pipelineTrigger)
  .bind(pipelineScheduler)
  .bind(activityRouter)
  .bind(evaluateMetricsService)
  .bind(evaluatePolicyService)
  .bind(storeResultsService)
  .bind(sendNotificationService)
  .bind(transformService)
  .bind(runLegacyWorkflowService)
  .listen(port);
```

**Step 2: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/workflow-engine`
Expected: Build succeeds

**Step 3: Commit**

```
feat(workflow-engine): add Restate server entrypoint
```

---

## Task 12: Mongoose Schemas

**Files:**

- Create: `packages/workflow-engine/src/schemas/pipeline-definition.schema.ts`
- Create: `packages/workflow-engine/src/schemas/pipeline-run-record.schema.ts`

**Step 1: Implement PipelineDefinition schema**

Follow the `user.model.ts` pattern from `packages/database/`. Use `uuidv7` for `_id`. Include tenant-scoped indexes. Schema matches the definition in design doc Section 4.1.

```typescript
import { Schema, model } from 'mongoose';

export interface IPipelineDefinition {
  _id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  description?: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    eventFilter?: { field: string; equals: string };
    schedule?: string;
  };
  inputSchema?: {
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
  steps: Array<{
    id: string;
    name: string;
    type: string;
    parallel?: string;
    condition?: { expression: string };
    config: Record<string, any>;
    timeout?: number;
    retries?: number;
  }>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const PipelineDefinitionSchema = new Schema<IPipelineDefinition>(
  {
    // ... full schema following project patterns
  },
  { timestamps: true, collection: 'pipeline_definitions' },
);

PipelineDefinitionSchema.index({ tenantId: 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, projectId: 1, status: 1 });
PipelineDefinitionSchema.index({ tenantId: 1, 'trigger.kafkaTopic': 1, status: 1 });

export const PipelineDefinition = model<IPipelineDefinition>(
  'PipelineDefinition',
  PipelineDefinitionSchema,
);
```

**Step 2: Implement PipelineRunRecord schema**

Similar pattern for execution history. Fields: `runId`, `pipelineId`, `pipelineVersion`, `tenantId`, `status`, `trigger`, `input`, `steps` (array with per-step status/timing), `startedAt`, `completedAt`, `durationMs`, `error`.

Indexes: `{ tenantId: 1, pipelineId: 1, startedAt: -1 }`, `{ runId: 1 }`, `{ tenantId: 1, status: 1 }`.

**Step 3: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/workflow-engine`

**Step 4: Commit**

```
feat(workflow-engine): add Mongoose schemas for pipeline definitions and runs
```

---

## Task 13: Docker Compose — Restate Dev Environment

**Files:**

- Create: `apps/amp-docker/docker-compose.restate.yml`
- Create: `apps/amp-docker/infrastructure/restate/restate.toml`
- Create: `apps/amp-docker/scripts/restate/register.sh`

**Step 1: Create `docker-compose.restate.yml`**

Copy from the design doc Section 11.1. Restate server on `:8080`/`:9070` + pipeline-worker on `:9080`.

**Step 2: Create `restate.toml`**

Copy from the design doc Section 11.2. Kafka cluster config pointing to the existing brokers.

**Step 3: Create `register.sh`**

Copy from the design doc Section 11.3. Service registration + Kafka subscription setup. Make it executable: `chmod +x`.

**Step 4: Commit**

```
feat(workflow-engine): add Restate docker-compose and infra config
```

---

## Task 14: Studio API Routes — Pipeline CRUD

**Files:**

- Create: `apps/studio/src/app/api/pipelines/route.ts`
- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/route.ts`
- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/activate/route.ts`
- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/deactivate/route.ts`
- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/clone/route.ts`
- Create: `apps/studio/src/app/api/pipelines/activities/route.ts`

**Step 1: Implement list + create route (`/api/pipelines/route.ts`)**

Follow existing Studio API patterns:

- `requireAuth(request)` for authentication
- `isAuthError(result)` guard
- Tenant-scoped MongoDB queries
- `validatePipeline()` from `@agent-platform/workflow-engine/validation`
- Return `NextResponse.json()`

**Step 2: Implement get + update + delete route (`/api/pipelines/[pipelineId]/route.ts`)**

- GET: load by `_id` + `tenantId`
- PATCH: validate, increment version, update
- DELETE: soft delete → set status to `archived`

**Step 3: Implement activate route**

- Validate pipeline
- For kafka triggers: call Restate admin API to register subscription
- For schedule triggers: call `pipelineScheduler.start()` via Restate client SDK
- Set status to `active`

**Step 4: Implement deactivate route**

- For kafka triggers: remove Restate subscription
- For schedule triggers: call `pipelineScheduler.stop()` via Restate client SDK
- Set status to `archived`

**Step 5: Implement clone route**

- Load original, copy all fields, set new name = "Copy of {name}", status = `draft`, new `_id`, version = 1

**Step 6: Implement activities route**

- `GET /api/pipelines/activities` — returns `listActivityTypes()` from `@agent-platform/workflow-engine/metadata`

**Step 7: Add `@agent-platform/workflow-engine` dependency to Studio**

Update `apps/studio/package.json`:

```json
"@agent-platform/workflow-engine": "workspace:*"
```

Run: `pnpm install`

**Step 8: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build`

**Step 9: Commit**

```
feat(studio): add pipeline CRUD API routes
```

---

## Task 15: Studio API Routes — Pipeline Runs

**Files:**

- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/runs/route.ts`
- Create: `apps/studio/src/app/api/pipelines/runs/[runId]/route.ts`
- Create: `apps/studio/src/app/api/pipelines/runs/[runId]/cancel/route.ts`
- Create: `apps/studio/src/lib/pipeline-service.ts`

**Step 1: Implement shared pipeline-service.ts**

The hybrid query function from the design doc Section 10.4 — `getRunStatus()`. Checks MongoDB first for completed runs, falls back to Restate `getStatus` shared handler for running workflows.

**Step 2: Implement list runs route**

`GET /api/pipelines/[pipelineId]/runs` — query MongoDB `PipelineRunRecord` with tenant isolation + pagination.

**Step 3: Implement get run detail route**

`GET /api/pipelines/runs/[runId]` — uses `getRunStatus()` from pipeline-service.

**Step 4: Implement cancel route**

`POST /api/pipelines/runs/[runId]/cancel` — calls Restate workflow cancel API.

**Step 5: Verify build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build`

**Step 6: Commit**

```
feat(studio): add pipeline run query and cancel routes
```

---

## Task 16: Integration Test — Full Pipeline Run

End-to-end test that starts a Restate test server, registers handlers, and runs a simple pipeline.

**Files:**

- Create: `packages/workflow-engine/src/__tests__/pipeline-run.test.ts`

**Step 1: Write integration test**

Use Restate's test utilities (`@restatedev/restate-sdk/testing` if available) or spin up a test server. Test a simple 3-step pipeline: sequential step → parallel group → conditional step.

Verify:

- All steps execute in order
- Parallel steps run concurrently (both complete)
- Conditional step is skipped when expression is false
- `getStatus` shared handler returns correct step statuses
- Final result has correct `status` and `stepOutputs`

**Step 2: Run test**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: PASS

**Step 3: Commit**

```
test(workflow-engine): add integration test for pipeline execution
```

---

## Task 17: Full Build Verification + Update Index Exports

**Files:**

- Modify: `packages/workflow-engine/src/index.ts` (ensure all exports resolve)

**Step 1: Run full monorepo build**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build`
Expected: Build succeeds with no errors

**Step 2: Run all workflow-engine tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm --filter=@agent-platform/workflow-engine test`
Expected: All tests PASS

**Step 3: Fix any remaining import/export issues**

Ensure `packages/workflow-engine/src/index.ts` correctly re-exports everything that Studio needs.

**Step 4: Commit**

```
chore(workflow-engine): verify full build and fix exports
```

---

## Summary

| Task | What                        | Files   | TDD? |
| ---- | --------------------------- | ------- | ---- |
| 1    | Package scaffold            | 4 files | -    |
| 2    | Core types + client         | 2 files | -    |
| 3    | Expression evaluator        | 2 files | Yes  |
| 4    | Activity metadata           | 1 file  | -    |
| 5    | Pipeline validation         | 2 files | Yes  |
| 6    | PipelineRun workflow        | 1 file  | -    |
| 7    | ActivityRouter service      | 1 file  | -    |
| 8    | Trigger + Scheduler         | 3 files | -    |
| 9    | Transform + StoreResults    | 2 files | -    |
| 10   | Eval/Notify/Legacy services | 4 files | -    |
| 11   | Restate server entrypoint   | 1 file  | -    |
| 12   | Mongoose schemas            | 2 files | -    |
| 13   | Docker compose + infra      | 3 files | -    |
| 14   | Studio CRUD routes          | 6 files | -    |
| 15   | Studio run routes           | 4 files | -    |
| 16   | Integration test            | 1 file  | Yes  |
| 17   | Full build verification     | 1 file  | -    |

**Total: 17 tasks, ~40 files, 3 TDD tasks**

Dependency order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 (can parallel with 14-15) → 14 → 15 → 16 → 17
