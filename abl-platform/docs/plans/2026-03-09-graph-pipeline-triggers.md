# Graph Pipeline Triggers — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable custom graph-based pipelines to be triggered by platform Kafka events (with project-scoped eventFilter) and manual execution, reusing the existing `trigger` field.

**Architecture:** The DB query in `PipelineTrigger.handleEvent` already matches `trigger.kafkaTopic` alongside `supportedTriggers.kafkaTopic`. The subscription registry in `pipeline-repo.ts` needs to include tenant-owned pipelines that don't have a `PipelineConfig` record. Graph trigger validation is added to `validateGraphPipeline`. Run record creation maps `nodes[]` to the `steps` array for progress tracking.

**Tech Stack:** TypeScript, Vitest, Mongoose, Restate SDK

**Design doc:** `docs/plans/2026-03-09-graph-pipeline-triggers-design.md`

---

## Task 1: Add Trigger Validation to `validateGraphPipeline`

**Files:**

- Test: `packages/pipeline-engine/src/__tests__/validation.test.ts`
- Modify: `packages/pipeline-engine/src/pipeline/validation.ts:294-416`

**Step 1: Write the failing tests**

Add to the existing test file, after the `validatePipeline with registry` describe block:

```typescript
import { validateGraphPipeline } from '../pipeline/validation.js';

// Helper for graph pipeline tests (add near the top, after makePipeline)
function makeGraphPipeline(overrides: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    _id: 'pip-graph-1',
    tenantId: 't-1',
    name: 'Test Graph Pipeline',
    version: 1,
    status: 'draft',
    entryNodeId: 'node-1',
    nodes: [
      {
        id: 'node-1',
        type: 'read-conversation',
        config: {},
        transitions: [],
      },
    ],
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineDefinition;
}

describe('validateGraphPipeline trigger validation', () => {
  // Create a registry with the node types used in tests
  const registry = new NodeRegistry();
  registry.register({
    type: 'read-conversation',
    category: 'data',
    label: 'Read Conversation',
    description: 'Read conversation',
    configSchema: { fields: [] },
    executionModel: 'async',
  });

  test('graph pipeline with valid kafka trigger and eventFilter passes', () => {
    const result = validateGraphPipeline(
      makeGraphPipeline({
        trigger: {
          type: 'kafka',
          kafkaTopic: 'abl.session.ended',
          eventFilter: { field: 'projectId', equals: 'proj-1' },
        },
      }),
      registry,
    );
    expect(result.errors.filter((e) => e.field === 'trigger')).toHaveLength(0);
  });

  test('graph pipeline with manual trigger passes', () => {
    const result = validateGraphPipeline(
      makeGraphPipeline({ trigger: { type: 'manual' } }),
      registry,
    );
    expect(result.errors.filter((e) => e.field === 'trigger')).toHaveLength(0);
  });

  test('graph pipeline with no trigger passes (manual-only)', () => {
    const result = validateGraphPipeline(makeGraphPipeline(), registry);
    expect(result.errors.filter((e) => e.field === 'trigger')).toHaveLength(0);
  });

  test('kafka trigger without kafkaTopic returns error', () => {
    const result = validateGraphPipeline(
      makeGraphPipeline({ trigger: { type: 'kafka' } }),
      registry,
    );
    expect(result.errors.some((e) => e.message.includes('kafkaTopic'))).toBe(true);
  });

  test('abl.* topic without eventFilter returns error', () => {
    const result = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'kafka', kafkaTopic: 'abl.session.ended' },
      }),
      registry,
    );
    expect(result.errors.some((e) => e.message.includes('eventFilter'))).toBe(true);
  });

  test('schedule trigger returns error (not yet supported)', () => {
    const result = validateGraphPipeline(
      makeGraphPipeline({
        trigger: { type: 'schedule', schedule: '0 2 * * *' },
      }),
      registry,
    );
    expect(result.errors.some((e) => e.message.includes('schedule'))).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/validation.test.ts`
Expected: FAIL — the trigger validation tests fail because `validateGraphPipeline` doesn't validate triggers.

**Step 3: Implement trigger validation in `validateGraphPipeline`**

In `packages/pipeline-engine/src/pipeline/validation.ts`, add trigger validation at the end of `validateGraphPipeline`, before the `return` statement (around line 411):

```typescript
// ── Trigger validation (graph pipelines) ──
if (definition.trigger) {
  const trigger = definition.trigger;

  if (trigger.type === 'schedule') {
    errors.push({
      field: 'trigger',
      message: 'Schedule triggers are not yet supported for graph pipelines',
    });
  }

  if (trigger.type === 'kafka') {
    if (!trigger.kafkaTopic) {
      errors.push({
        field: 'trigger',
        message: 'Kafka trigger requires kafkaTopic',
      });
    } else if (trigger.kafkaTopic.startsWith('abl.') && !trigger.eventFilter) {
      errors.push({
        field: 'trigger',
        message:
          'Platform event topics (abl.*) require an eventFilter for scoping (e.g., projectId)',
      });
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/validation.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/__tests__/validation.test.ts packages/pipeline-engine/src/pipeline/validation.ts
git commit -m "feat(pipeline-engine): add trigger validation for graph pipelines"
```

---

## Task 2: Map Nodes to Run Record Steps in PipelineTrigger

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts:137-176` (handleEvent) and `:202-242` (triggerManual)

When `PipelineTrigger` creates the initial run record for a graph pipeline, `steps` is empty because graph pipelines use `nodes[]` not `steps[]`. This means the MongoDB run record shows no progress entries until the workflow completes. Fix: detect graph pipelines and map `nodes` to the run record's `steps` array.

**Step 1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/pipeline-trigger-graph.test.ts`:

```typescript
import { describe, test, expect } from 'vitest';
import type { PipelineDefinition, PipelineNode } from '../pipeline/types.js';

/**
 * Pure function extracted from PipelineTrigger to map graph nodes
 * to run record step entries. Testable without Restate context.
 */
import { buildRunRecordSteps } from '../pipeline/handlers/pipeline-trigger.service.js';

describe('buildRunRecordSteps', () => {
  test('maps nodes to steps for graph pipelines', () => {
    const nodes: PipelineNode[] = [
      { id: 'read', type: 'read-conversation', config: {}, transitions: [{ target: 'store' }] },
      { id: 'store', type: 'store-results', config: {}, transitions: [] },
    ];

    const result = buildRunRecordSteps(
      { nodes, entryNodeId: 'read', steps: [] } as unknown as PipelineDefinition,
      [],
    );

    expect(result).toEqual([
      { id: 'read', name: 'read', type: 'read-conversation', status: 'pending' },
      { id: 'store', name: 'store', type: 'store-results', status: 'pending' },
    ]);
  });

  test('maps nodes with labels to steps', () => {
    const nodes: PipelineNode[] = [
      {
        id: 'read',
        type: 'read-conversation',
        label: 'Read Customer Conversation',
        config: {},
        transitions: [],
      },
    ];

    const result = buildRunRecordSteps(
      { nodes, entryNodeId: 'read', steps: [] } as unknown as PipelineDefinition,
      [],
    );

    expect(result).toEqual([
      {
        id: 'read',
        name: 'Read Customer Conversation',
        type: 'read-conversation',
        status: 'pending',
      },
    ]);
  });

  test('falls back to steps array for non-graph pipelines', () => {
    const steps = [{ id: 's1', name: 'Step 1', type: 'evaluate-metrics', config: {} }];

    const result = buildRunRecordSteps({ steps } as unknown as PipelineDefinition, steps);

    expect(result).toEqual([
      { id: 's1', name: 'Step 1', type: 'evaluate-metrics', status: 'pending' },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/pipeline-trigger-graph.test.ts`
Expected: FAIL — `buildRunRecordSteps` does not exist yet.

**Step 3: Extract and implement `buildRunRecordSteps`**

In `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`, add the helper function and export it. Add near the bottom with the other internal helpers (before `getNestedField`):

```typescript
/**
 * Build the `steps` array for a PipelineRunRecord.
 * For graph pipelines, maps nodes[] to step entries.
 * For linear pipelines, maps the resolved steps array.
 */
export function buildRunRecordSteps(
  pipeline: PipelineDefinition,
  resolvedSteps: PipelineStep[],
): Array<{ id: string; name: string; type: string; status: string }> {
  // Graph pipeline: use nodes[]
  const isGraph = pipeline.nodes && pipeline.nodes.length > 0 && pipeline.entryNodeId;

  if (isGraph) {
    return pipeline.nodes!.map((n) => ({
      id: n.id,
      name: n.label ?? n.id,
      type: n.type,
      status: 'pending',
    }));
  }

  // Linear pipeline: use resolved steps
  return resolvedSteps.map((s) => ({
    id: s.id,
    name: s.name ?? s.id,
    type: s.activity ?? s.type ?? 'unknown',
    status: 'pending',
  }));
}
```

Then update `handleEvent` (around line 168) to use it. Replace the inline `steps.map(...)`:

```typescript
// Before (line 168):
          steps: steps.map((s) => ({
            id: s.id,
            name: s.name ?? s.id,
            type: s.activity ?? s.type ?? 'unknown',
            status: 'pending',
          })),

// After:
          steps: buildRunRecordSteps(pipeline, steps),
```

And update `triggerManual` (around line 234) similarly:

```typescript
// Before (line 234):
          steps: steps.map((s) => ({
            id: s.id,
            name: s.name ?? s.id,
            type: s.activity ?? s.type ?? 'unknown',
            status: 'pending',
          })),

// After:
          steps: buildRunRecordSteps(pipeline, steps),
```

**Step 4: Run test to verify it passes**

Run: `cd packages/pipeline-engine && pnpm vitest run src/__tests__/pipeline-trigger-graph.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/pipeline-engine/src/__tests__/pipeline-trigger-graph.test.ts packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts
git commit -m "feat(pipeline-engine): map graph nodes to run record steps for progress tracking"
```

---

## Task 3: Include Tenant-Owned Pipelines in Subscription Registry

**Files:**

- Modify: `apps/runtime/src/repos/pipeline-repo.ts:20-123`

The `findKafkaSubscriptions()` function builds a `tenantId → Set<eventType>` map by joining definitions with `PipelineConfig` records. System/platform pipelines require a config with `enabled: true` per tenant. But tenant-owned custom pipelines don't need a `PipelineConfig` — they're active based on `status: 'active'` alone. Currently these pipelines are found in the definitions query but never appear in the result because no config matches their `pipelineType` (which defaults to the pipeline ID).

**Step 1: Understand the gap**

Current flow:

1. Query definitions with kafka triggers → finds tenant-owned graph pipelines (good)
2. Build `pipelineType → topics` map using `def.pipelineType ?? def._id` → maps pipeline ID to topics (good)
3. Query `PipelineConfig` with `enabled: true` → no config exists for custom pipelines (gap)
4. Loop through configs → custom pipeline never matched → not in result (bug)

Fix: After the config-based loop, add tenant-owned pipelines directly.

**Step 2: Implement the fix**

In `apps/runtime/src/repos/pipeline-repo.ts`, add a new block after the config-based loop (after line 119, before `return result`):

```typescript
// Step 3: Include tenant-owned pipelines with direct kafka triggers
// These don't need a PipelineConfig — they are self-managed via status: 'active'.
// Platform definitions (__platform__) still require a config per tenant.
for (const def of definitions) {
  const tenantId = (def as any).tenantId as string | undefined;
  if (!tenantId || tenantId === '__platform__') continue;

  const pipelineType = (def as any).pipelineType ?? def._id;
  const topics = pipelineTopics.get(pipelineType as string);
  if (!topics || topics.size === 0) continue;

  if (!result.has(tenantId)) {
    result.set(tenantId, new Set());
  }
  const tenantSubs = result.get(tenantId)!;
  for (const topic of topics) {
    tenantSubs.add(topic.replace(/^abl\./, ''));
  }
}
```

Also update the definitions query projection (line 33) to include `tenantId`:

```typescript
    {
      _id: 1,
      tenantId: 1,  // Add this
      pipelineType: 1,
      'trigger.kafkaTopic': 1,
      'supportedTriggers.id': 1,
      'supportedTriggers.type': 1,
      'supportedTriggers.kafkaTopic': 1,
      defaultTriggerIds: 1,
    },
```

**Step 3: Run full test suite to verify no regressions**

Run: `cd packages/pipeline-engine && pnpm vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/repos/pipeline-repo.ts
git commit -m "fix(runtime): include tenant-owned pipelines in kafka subscription registry"
```

---

## Task 4: End-to-End Verification with Apple Pipeline

**Step 1: Create the pipeline with trigger via curl**

Use the Studio API to create a new pipeline (or PATCH the existing one) with the trigger:

```bash
curl -X POST http://localhost:5173/api/pipelines \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{
    "name": "Apple Customer Care Analytics",
    "projectId": "proj-apple-care",
    "onNodeFailure": "continue",
    "entryNodeId": "read-conv",
    "trigger": {
      "type": "kafka",
      "kafkaTopic": "abl.session.ended",
      "eventFilter": { "field": "projectId", "equals": "proj-apple-care" }
    },
    "nodes": [
      {
        "id": "read-conv",
        "type": "read-conversation",
        "config": { "enrichWithTraces": true },
        "transitions": [
          { "target": "sentiment", "order": 1 },
          { "target": "intent", "order": 2 }
        ]
      },
      {
        "id": "sentiment",
        "type": "compute-sentiment",
        "config": { "model": "gpt-4o-mini", "sourceStep": "read-conv" },
        "transitions": [{ "target": "store" }]
      },
      {
        "id": "intent",
        "type": "compute-intent",
        "config": { "model": "gpt-4o-mini", "sourceStep": "read-conv" },
        "transitions": [{ "target": "store" }]
      },
      {
        "id": "store",
        "type": "store-results",
        "config": { "destination": "clickhouse", "source": "batch" },
        "transitions": []
      }
    ]
  }'
```

**Step 2: Verify the pipeline was created with trigger**

```bash
curl http://localhost:5173/api/pipelines/<pipelineId> \
  -H 'Authorization: Bearer <token>'
```

Expected: Response includes `trigger.kafkaTopic: "abl.session.ended"` and `trigger.eventFilter`.

**Step 3: Activate the pipeline**

```bash
curl -X PATCH http://localhost:5173/api/pipelines/<pipelineId> \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{ "status": "active" }'
```

**Step 4: Verify subscription registry picks it up**

Check runtime logs after the next sync cycle for the tenant's subscription to `session.ended`.

**Step 5: Commit all changes together if not already committed**

```bash
git add docs/plans/2026-03-09-graph-pipeline-triggers-design.md docs/plans/2026-03-09-graph-pipeline-triggers.md
git commit -m "docs: add graph pipeline triggers design and implementation plan"
```
