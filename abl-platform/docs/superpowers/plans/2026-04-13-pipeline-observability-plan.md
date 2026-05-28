# Pipeline Observability & Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the observability and data-preview capabilities for pipelines described in [ABLP-280](https://koreteam.atlassian.net/browse/ABLP-280) — Recent Runs tab, Run Detail drawer, Data tab, and health indicators. (Test drawer + Re-run deferred to v2.)

**Architecture:** The feature is read-heavy with no new write paths in v1 (manual test trigger deferred to v2). The existing `PipelineTrigger.triggerManual` Restate handler was extended with projectId/triggerInput persistence + trigger-input validation + activeTriggers gating (engine-side work done; Studio route deferred). ClickHouse output tables gain `run_id` + `pipeline_id` columns. Studio gains six new read routes. All UI lives in `apps/studio/src/components/pipelines/`.

**Tech Stack:** TypeScript, Next.js App Router, Restate SDK, Mongoose, ClickHouse HTTP client, Vitest, React, Tailwind, Zod.

**Ticket prefix for every commit:** `[ABLP-280]`. Use `npx prettier --write <files>` before every commit. Max 40 non-doc files per commit, max 3 packages.

---

## Spec Reference

Design: `docs/superpowers/specs/2026-04-13-pipeline-observability-design.md`

**Deviation from spec §6.1:** The spec described a _new_ `manualRun` handler. In reality `PipelineTrigger.triggerManual` already exists at `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts:170`. We **extend** it rather than add a new method. Behavior change stays identical to the spec; only the method name differs.

---

## File Structure

### Created

```
packages/database/clickhouse/migrations/
  └── 2026-04-13-add-run-id-to-analytics-tables.sql

apps/studio/src/lib/pipeline-data/
  ├── query-builder.ts
  ├── query-builder.test.ts
  ├── schema-resolver.ts
  └── schema-resolver.test.ts

apps/studio/src/app/api/projects/[projectId]/pipeline-runs/route.ts
apps/studio/src/app/api/projects/[projectId]/pipeline-runs/health/route.ts
apps/studio/src/app/api/projects/[projectId]/pipeline-data/query/route.ts
apps/studio/src/app/api/projects/[projectId]/pipeline-data/export/route.ts
apps/studio/src/app/api/projects/[projectId]/pipeline-data/previewable-pipelines/route.ts
apps/studio/src/app/api/pipelines/[pipelineId]/output-schema/route.ts

apps/studio/src/components/pipelines/runs/
  ├── RecentRunsPanel.tsx
  ├── RunDetailDrawer.tsx
  ├── RunStatusIcon.tsx
  ├── HealthStrip.tsx
  ├── RunFilters.tsx
  └── useRunPolling.ts

apps/studio/src/components/pipelines/data/
  ├── PipelineDataPanel.tsx
  ├── ClickHousePreviewTable.tsx
  ├── DataFilterRow.tsx
  └── useOutputSchema.ts

apps/studio/src/store/pipeline-runs-store.ts

apps/studio/e2e/pipelines/
  ├── pipeline-data-query.e2e.ts
  └── pipeline-isolation.e2e.ts

packages/pipeline-engine/src/__tests__/
  ├── trigger-manual-validation.test.ts
  └── run-record-project-isolation.test.ts
```

### Deferred to v2

```
packages/pipeline-engine/src/pipeline/trigger-templates/   # 8 JSON template files + index.ts
apps/studio/src/app/api/pipelines/[pipelineId]/test/route.ts
apps/studio/src/app/api/pipelines/[pipelineId]/trigger-templates/route.ts
apps/studio/src/components/pipelines/test/TestDrawer.tsx
apps/studio/src/components/pipelines/test/useTriggerTemplates.ts
apps/studio/e2e/pipelines/pipeline-test-run.e2e.ts
packages/database/clickhouse/users.xml                     # studio_reader user
```

### Modified

```
packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts   # add projectId, triggerInput, triggerInputTruncated
packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts   # extend triggerManual + add projectId/triggerInput on handleEvent
packages/pipeline-engine/src/pipeline/services/store-results.service.ts      # write run_id + pipeline_id to ClickHouse
packages/pipeline-engine/src/pipeline/types.ts                               # add outputSchema column metadata types
packages/pipeline-engine/src/pipeline/definitions/*.ts                       # (10 files) annotate outputSchema filterable/exportable
packages/pipeline-engine/src/index.ts                                        # export new types + helpers

packages/database/seed-mongo.ts                                              # ensure project_id gets populated on seeded configs

apps/studio/src/lib/pipeline-service.ts                                      # add listProjectRuns, getProjectHealth, getPreviewableForProject

apps/studio/src/components/pipelines/PipelinesListPage.tsx                   # add Recent Runs and Data tabs
apps/studio/src/components/pipelines/PipelineConfigPage.tsx                  # add Config | Runs tabs + Test button
apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx                # health badge
apps/studio/src/components/pipelines/CustomPipelinesList.tsx                 # health badge
apps/studio/src/components/pipelines/PipelineCard.tsx                        # health badge prop
apps/studio/src/store/pipeline-list-store.ts                                 # add 'runs' and 'data' tab ids

apps/studio/messages/en.json                                                 # i18n strings for new UI
```

---

## Phase Map & Exit Criteria

| Phase  | Title                                                              | Primary package(s)        | Exit criteria                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | Data model: `PipelineRunRecord` gets projectId + triggerInput      | pipeline-engine           | Schema compiled, unit tests for new indexes green, no migrations needed.                                                                                                                              |
| 2      | Engine: extend `triggerManual` + update `handleEvent`              | pipeline-engine           | Both trigger paths write projectId + triggerInput. Integration test covers active-trigger gate + Zod validation.                                                                                      |
| 3      | ClickHouse: add `run_id` + `pipeline_id` columns                   | pipeline-engine, database | Migration runs on dev. `storeResultsService` writes `run_id`. Compute services write `run_id`.                                                                                                        |
| 4      | Studio APIs: runs list, health, schema, previewable pipelines      | studio                    | All read routes return correctly for seeded data. Unit tests on aggregation.                                                                                                                          |
| ~~5~~  | ~~Studio APIs: test trigger + re-run wiring~~ — **DEFERRED to v2** | studio                    | ~~POST /test returns 202 with runId.~~                                                                                                                                                                |
| 6      | Studio APIs: data query + export + query builder                   | studio                    | Query builder unit tests green. Parameter-binding verified. Export streams CSV. E2E: session-id filter returns expected rows.                                                                         |
| 7      | UI: Recent Runs tab + Run Detail drawer                            | studio                    | Tab renders, auto-polls, drawer shows steps/input/output/raw. Playwright check: click row → drawer opens.                                                                                             |
| ~~8~~  | ~~UI: Test drawer + re-run~~ — **DEFERRED to v2**                  | studio                    | ~~Drawer opens from card + run row, templates populate, Zod validation inline.~~                                                                                                                      |
| 9      | UI: Data tab                                                       | studio                    | Pipeline dropdown, filters, table, CSV export. Empty-state and error states rendered.                                                                                                                 |
| 10     | UI: Health badges + PipelineConfigPage Runs tab                    | studio                    | Cards show colored dot + count. PipelineConfigPage has `Config \| Runs` tabs.                                                                                                                         |
| ~~11~~ | ~~Stuck-run watchdog~~ — **REMOVED 2026-04-15**                    | pipeline-engine           | ~~Seeded `pending` run older than 5 min → `failed`, trace event emitted.~~ Handler was never bootstrapped; Restate's own delivery guarantees + 90-day `PipelineRunRecord` TTL cover the failure mode. |
| 12     | Docs + post-impl-sync                                              | docs                      | Feature spec, HLD, LLD, testing matrix updated. Status set to ALPHA.                                                                                                                                  |

---

## Phase 1 — PipelineRunRecord schema

### Task 1.1: Update the Mongoose schema

**Files:**

- Modify: `packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts`

- [ ] **Step 1: Read the current schema to confirm starting state**

Run: `pnpm tsx -e "import('./packages/pipeline-engine/src/schemas/pipeline-run-record.schema.js').then(m => console.log(Object.keys(m)))"`
Expected: prints `['PipelineRunRecordModel']` or similar.

- [ ] **Step 2: Extend the interface and schema**

Replace the interface block with:

```ts
export interface IPipelineRunRecord {
  _id: string;
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  projectId?: string; // NEW
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
    triggerId: string;
    executionMode: 'batch' | 'realtime';
  };
  input: Record<string, any>;
  triggerInput?: Record<string, any>; // NEW
  triggerInputTruncated?: boolean; // NEW
  steps: Array<{
    id: string;
    name: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    output?: Record<string, any>;
  }>;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: {
    stepId: string;
    message: string;
  };
}
```

In the `PipelineRunRecordSchema` object literal add these fields:

```ts
projectId: { type: String, index: true },
triggerInput: { type: Schema.Types.Mixed },
triggerInputTruncated: { type: Boolean },
```

After the existing indexes, add:

```ts
PipelineRunRecordSchema.index({ tenantId: 1, projectId: 1, startedAt: -1 });
PipelineRunRecordSchema.index({ tenantId: 1, projectId: 1, pipelineId: 1, startedAt: -1 });
```

- [ ] **Step 3: Build and typecheck**

Run: `pnpm build --filter=@agent-platform/pipeline-engine`
Expected: build succeeds, no new type errors.

- [ ] **Step 4: Write a unit test for the new fields**

Create: `packages/pipeline-engine/src/__tests__/run-record-project-isolation.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';

describe('PipelineRunRecord — projectId + triggerInput', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await PipelineRunRecordModel.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it('persists projectId and triggerInput', async () => {
    await PipelineRunRecordModel.create({
      _id: 'run-1',
      runId: 'run-1',
      pipelineId: 'pipe-1',
      pipelineVersion: 1,
      tenantId: 'tenant-a',
      projectId: 'project-x',
      status: 'pending',
      trigger: { type: 'manual', triggerId: 't1', executionMode: 'realtime' },
      input: {},
      triggerInput: { sessionId: 'sess-1', hello: 'world' },
      startedAt: new Date(),
      steps: [],
    });

    const found = await PipelineRunRecordModel.findOne({ runId: 'run-1' }).lean();
    expect(found?.projectId).toBe('project-x');
    expect(found?.triggerInput).toEqual({ sessionId: 'sess-1', hello: 'world' });
    expect(found?.triggerInputTruncated).toBeUndefined();
  });

  it('filters by tenantId + projectId composite index', async () => {
    await PipelineRunRecordModel.create([
      {
        _id: 'r-a',
        runId: 'r-a',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tenant-a',
        projectId: 'project-x',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't1', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
      {
        _id: 'r-b',
        runId: 'r-b',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tenant-a',
        projectId: 'project-y',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't1', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
    ]);

    const xRuns = await PipelineRunRecordModel.find({
      tenantId: 'tenant-a',
      projectId: 'project-x',
    }).lean();
    expect(xRuns).toHaveLength(2); // includes run-1 from first test + r-a
    expect(xRuns.every((r) => r.projectId === 'project-x')).toBe(true);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `pnpm test --filter=@agent-platform/pipeline-engine -- run-record-project-isolation`
Expected: 2 passing.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts \
  packages/pipeline-engine/src/__tests__/run-record-project-isolation.test.ts
git add \
  packages/pipeline-engine/src/schemas/pipeline-run-record.schema.ts \
  packages/pipeline-engine/src/__tests__/run-record-project-isolation.test.ts
git commit -m "[ABLP-280] feat(pipeline-engine): add projectId + triggerInput to PipelineRunRecord

Adds projectId (denormalized from PipelineConfig) and triggerInput
(raw trigger payload, for Re-run) to PipelineRunRecord. Adds
composite indexes for project-scoped Recent Runs queries."
```

---

## Phase 2 — Engine handler updates

### Task 2.1: Extend `triggerManual` with validation, isolation, and run-record fields

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`

- [ ] **Step 1: Write the failing test**

Create: `packages/pipeline-engine/src/__tests__/trigger-manual-validation.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { PipelineDefinitionModel } from '../schemas/pipeline-definition.schema.js';
import { PipelineConfigModel } from '../schemas/pipeline-config.schema.js';
import { PipelineRunRecordModel } from '../schemas/pipeline-run-record.schema.js';

// Import the pure helper we will extract from the handler for testing:
import {
  validateManualTriggerInput,
  ManualTriggerValidationError,
} from '../handlers/pipeline-trigger.service.js';

describe('triggerManual — input validation (unit)', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all([
      PipelineDefinitionModel.syncIndexes(),
      PipelineConfigModel.syncIndexes(),
      PipelineRunRecordModel.syncIndexes(),
    ]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      PipelineDefinitionModel.deleteMany({}),
      PipelineConfigModel.deleteMany({}),
      PipelineRunRecordModel.deleteMany({}),
    ]);
  });

  const seedPipeline = async () => {
    await PipelineDefinitionModel.create({
      _id: 'def-1',
      tenantId: '__platform__',
      name: 'Sentiment',
      version: 1,
      status: 'active',
      pipelineType: 'sentiment_analysis',
      supportedTriggers: [
        {
          id: 't-kafka',
          type: 'kafka',
          kafkaTopic: 'abl.session.ended',
          inputSchema: { required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
        },
      ],
      nodes: [{ id: 'n1', type: 'noop', label: 'Start' }],
      entryNodeId: 'n1',
    });
    await PipelineConfigModel.create({
      _id: 'cfg-1',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      pipelineType: 'sentiment_analysis',
      enabled: true,
      activeTriggers: ['t-kafka'],
    });
  };

  it('rejects when trigger is not active on config', async () => {
    await seedPipeline();
    await PipelineConfigModel.updateOne({ _id: 'cfg-1' }, { $set: { activeTriggers: [] } });

    await expect(
      validateManualTriggerInput({
        pipelineId: 'def-1',
        tenantId: 'tenant-a',
        projectId: 'project-x',
        triggerId: 't-kafka',
        data: { sessionId: 'sess-1' },
      }),
    ).rejects.toMatchObject({ code: 'TRIGGER_NOT_ACTIVE' });
  });

  it('rejects when projectId does not match config', async () => {
    await seedPipeline();

    await expect(
      validateManualTriggerInput({
        pipelineId: 'def-1',
        tenantId: 'tenant-a',
        projectId: 'project-OTHER',
        triggerId: 't-kafka',
        data: { sessionId: 'sess-1' },
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  });

  it('rejects when input fails inputSchema', async () => {
    await seedPipeline();

    await expect(
      validateManualTriggerInput({
        pipelineId: 'def-1',
        tenantId: 'tenant-a',
        projectId: 'project-x',
        triggerId: 't-kafka',
        data: {}, // missing required sessionId
      }),
    ).rejects.toMatchObject({ code: 'INPUT_VALIDATION_FAILED' });
  });

  it('accepts valid input', async () => {
    await seedPipeline();

    const result = await validateManualTriggerInput({
      pipelineId: 'def-1',
      tenantId: 'tenant-a',
      projectId: 'project-x',
      triggerId: 't-kafka',
      data: { sessionId: 'sess-1' },
    });

    expect(result.pipeline._id).toBe('def-1');
    expect(result.trigger.id).toBe('t-kafka');
  });
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `pnpm test --filter=@agent-platform/pipeline-engine -- trigger-manual-validation`
Expected: FAIL — `validateManualTriggerInput` not exported.

- [ ] **Step 3: Implement the extracted validator**

At the bottom of `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`, add:

```ts
export class ManualTriggerValidationError extends Error {
  constructor(
    public code:
      | 'PIPELINE_NOT_FOUND'
      | 'PROJECT_MISMATCH'
      | 'TRIGGER_NOT_FOUND'
      | 'TRIGGER_NOT_ACTIVE'
      | 'INPUT_VALIDATION_FAILED',
    public details?: unknown,
  ) {
    super(code);
    this.name = 'ManualTriggerValidationError';
  }
}

export async function validateManualTriggerInput(args: {
  pipelineId: string;
  tenantId: string;
  projectId: string;
  triggerId: string;
  data: Record<string, unknown>;
}): Promise<{
  pipeline: PipelineDefinition;
  config: IPipelineConfig;
  trigger: TriggerEntry;
}> {
  const pipeline = await loadActivePipeline(args.pipelineId, args.tenantId);
  if (!pipeline) {
    throw new ManualTriggerValidationError('PIPELINE_NOT_FOUND');
  }

  const config = pipeline.pipelineType
    ? ((await PipelineConfigModel.findOne({
        tenantId: args.tenantId,
        pipelineType: pipeline.pipelineType,
      }).lean()) as unknown as IPipelineConfig | null)
    : null;

  if (!config) {
    throw new ManualTriggerValidationError('PIPELINE_NOT_FOUND');
  }
  if (config.projectId && config.projectId !== args.projectId) {
    throw new ManualTriggerValidationError('PROJECT_MISMATCH');
  }

  const trigger = (pipeline.supportedTriggers ?? []).find((t) => t.id === args.triggerId);
  if (!trigger) {
    throw new ManualTriggerValidationError('TRIGGER_NOT_FOUND');
  }

  const activeIds = resolveActiveTriggers(config, pipeline);
  if (!activeIds.includes(args.triggerId)) {
    throw new ManualTriggerValidationError('TRIGGER_NOT_ACTIVE');
  }

  if (trigger.inputSchema) {
    const ok = validateInput(args.data, trigger.inputSchema);
    if (!ok) {
      throw new ManualTriggerValidationError('INPUT_VALIDATION_FAILED', {
        required: trigger.inputSchema.required,
      });
    }
  }

  return { pipeline, config, trigger };
}
```

- [ ] **Step 4: Update `triggerManual` to call the validator and persist new fields**

Replace the `triggerManual` handler body (line ~170) with:

```ts
triggerManual: async (
  ctx: restate.Context,
  input: {
    pipelineId: string;
    tenantId: string;
    projectId: string;                    // NEW — required
    triggeredBy: string;
    triggerId: string;                    // no longer optional
    data: Record<string, unknown>;
  },
): Promise<{ runId: string }> => {
  const { pipeline, trigger } = await ctx.run('validate-manual-trigger', async () => {
    try {
      return await validateManualTriggerInput(input);
    } catch (err) {
      if (err instanceof ManualTriggerValidationError) {
        throw new restate.TerminalError(err.code, { errorCode: 400 });
      }
      throw err;
    }
  });

  const strategyKey = trigger.strategy ?? 'default';
  const strategy = pipeline.strategies?.[strategyKey];
  const executionMode = strategy?.executionMode ?? 'batch';
  const steps: PipelineStep[] = strategy?.steps ?? pipeline.steps ?? [];

  const runId = `${pipeline._id}-${ctx.rand.uuidv4()}`;

  ctx.workflowSendClient(pipelineRun, runId).run({
    pipelineDefinition: pipeline,
    matchedTriggerId: trigger.id,
    executionMode,
    steps,
    pipelineInput: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      pipelineId: pipeline._id,
      runId,
      ...input.data,
    },
  });

  // Enforce 256 KB triggerInput cap
  const serialized = JSON.stringify(input.data);
  const truncated = serialized.length > 256 * 1024;

  await ctx.run('create-run-record', async () => {
    await createRunRecord({
      runId,
      pipelineId: pipeline._id,
      pipelineVersion: pipeline.version,
      tenantId: input.tenantId,
      projectId: input.projectId,                                    // NEW
      status: 'running',
      trigger: {
        type: 'manual',
        triggeredBy: input.triggeredBy,
        triggerId: trigger.id,
        executionMode,
      },
      input: input.data,
      triggerInput: truncated ? { note: 'truncated' } : input.data,   // NEW
      triggerInputTruncated: truncated,                               // NEW
      steps: buildRunRecordSteps(pipeline, steps),
      startedAt: new Date(),
    });
  });

  return { runId };
},
```

- [ ] **Step 5: Update `handleEvent` to persist projectId + triggerInput on Kafka-originated runs**

Inside the `for (const { definition: pipeline, matchedTrigger, samplingRate, config }` loop, replace the `createRunRecord` call (line ~145-162) with:

```ts
// Size-cap the raw event for triggerInput storage
const eventSerialized = JSON.stringify(event);
const eventTruncated = eventSerialized.length > 256 * 1024;

await ctx.run('create-run-record', async () => {
  await createRunRecord({
    runId,
    pipelineId: pipeline._id,
    pipelineVersion: pipeline.version,
    tenantId,
    projectId: config?.projectId ?? null, // NEW — denormalize from config
    status: 'running',
    trigger: {
      type: 'kafka',
      kafkaTopic,
      triggerId,
      executionMode,
    },
    input: event,
    triggerInput: eventTruncated ? { note: 'truncated' } : event, // NEW
    triggerInputTruncated: eventTruncated, // NEW
    steps: buildRunRecordSteps(pipeline, steps),
    startedAt: new Date(),
  });
});
```

Also thread `projectId` into `pipelineInput` on line ~142:

```ts
pipelineInput: { tenantId, projectId: config?.projectId, pipelineId: pipeline._id, runId, ...event },
```

- [ ] **Step 6: Run the unit tests**

Run: `pnpm test --filter=@agent-platform/pipeline-engine -- trigger-manual-validation`
Expected: 4 passing.

- [ ] **Step 7: Run existing handler tests to ensure no regression**

Run: `pnpm test --filter=@agent-platform/pipeline-engine -- pipeline-trigger`
Expected: all existing tests still pass. If any test passed `triggerId` as optional, update it to pass explicit triggerId; previously they used `'default'` fallback and the test should be updated to either seed a trigger with id `'default'` or use the real trigger id.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write \
  packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts \
  packages/pipeline-engine/src/__tests__/trigger-manual-validation.test.ts
git add \
  packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts \
  packages/pipeline-engine/src/__tests__/trigger-manual-validation.test.ts
git commit -m "[ABLP-280] feat(pipeline-engine): extend triggerManual with projectId + input validation

Extends PipelineTrigger.triggerManual to require projectId, validate
it against the pipeline config, enforce that the trigger is in the
config's activeTriggers list, and validate triggerInput against the
trigger's inputSchema. handleEvent also denormalizes projectId and
stores triggerInput on the RunRecord so Re-run can replay."
```

---

## Phase 3 — ClickHouse schema + store-results updates

### Task 3.1: Add `run_id` + `pipeline_id` columns to analytics tables

**Files:**

- Create: `packages/database/clickhouse/migrations/2026-04-13-add-run-id-to-analytics-tables.sql`

- [ ] **Step 1: Find the current analytics table names**

Run: `grep -rn "CREATE TABLE" packages/database/clickhouse/ | grep -v backup`
Expected: a list of `CREATE TABLE analytics.*` statements — tables written by compute-\* and store-results services.

Record the exact table names for:

- `analytics.sentiment_scores`
- `analytics.intent_classifications`
- `analytics.quality_scores`
- `analytics.hallucination_scores`
- `analytics.knowledge_gaps`
- `analytics.guardrail_events`
- `analytics.friction_events`
- `analytics.anomalies`
- `analytics.drift_scores`
- `analytics.eval_results`

(Note: actual table names may differ; use the output of the grep above as the authoritative list. If a pipeline doesn't have an output table yet, skip it; the query-builder will return `NO_OUTPUT_TABLE`.)

- [ ] **Step 2: Write the migration**

Create: `packages/database/clickhouse/migrations/2026-04-13-add-run-id-to-analytics-tables.sql`

```sql
-- ABLP-280 — Add run_id + pipeline_id columns to analytics tables
-- so Studio Data tab and Run Detail drawer can link rows to runs.

-- Repeat per table. DEFAULT '' ensures backward compatibility with rows
-- already written without these fields.

ALTER TABLE analytics.sentiment_scores
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '',
  ADD INDEX IF NOT EXISTS idx_sentiment_run_id run_id TYPE minmax GRANULARITY 1,
  ADD INDEX IF NOT EXISTS idx_sentiment_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

ALTER TABLE analytics.intent_classifications
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '',
  ADD INDEX IF NOT EXISTS idx_intent_run_id run_id TYPE minmax GRANULARITY 1,
  ADD INDEX IF NOT EXISTS idx_intent_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;

-- ... repeat for each table from Step 1 ...

ALTER TABLE analytics.eval_results
  ADD COLUMN IF NOT EXISTS run_id String DEFAULT '',
  ADD COLUMN IF NOT EXISTS pipeline_id String DEFAULT '',
  ADD INDEX IF NOT EXISTS idx_eval_run_id run_id TYPE minmax GRANULARITY 1,
  ADD INDEX IF NOT EXISTS idx_eval_pipeline_id pipeline_id TYPE minmax GRANULARITY 1;
```

Note: if the table doesn't exist yet in a fresh dev environment, `ADD COLUMN IF NOT EXISTS` is a no-op when the column is part of the `CREATE TABLE`. Also add the columns to the canonical `CREATE TABLE` DDL (in the file where the table is originally defined) so fresh installs get them from scratch.

- [ ] **Step 3: Update the canonical `CREATE TABLE` statements**

In each table's DDL file under `packages/database/clickhouse/` (path determined by Step 1 grep), add these columns in the schema:

```sql
run_id String DEFAULT '',
pipeline_id String DEFAULT '',
INDEX idx_run_id run_id TYPE minmax GRANULARITY 1,
INDEX idx_pipeline_id pipeline_id TYPE minmax GRANULARITY 1,
```

- [ ] **Step 4: Run the migration against local ClickHouse**

Run:

```bash
docker compose up -d clickhouse
cat packages/database/clickhouse/migrations/2026-04-13-add-run-id-to-analytics-tables.sql \
  | docker compose exec -T clickhouse clickhouse-client --multiquery
```

Expected: no errors.

- [ ] **Step 5: Verify columns exist**

Run:

```bash
docker compose exec clickhouse clickhouse-client \
  --query "DESCRIBE analytics.sentiment_scores" | grep run_id
```

Expected: `run_id String DEFAULT ''` visible in output.

- [ ] **Step 6: Format and commit**

```bash
git add packages/database/clickhouse/
git commit -m "[ABLP-280] feat(database): add run_id + pipeline_id to analytics tables

Adds run_id and pipeline_id columns with minmax indexes to all
ClickHouse analytics tables written by pipeline compute + store-results
services. Enables Data tab row → Run Detail drawer linking and
pipeline-scoped queries."
```

### Task 3.2: Write `run_id` + `pipeline_id` from `store-results.service`

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/store-results.service.ts` (lines 108-120 area)

- [ ] **Step 1: Update the row-building block**

In the ClickHouse destination branch (around line 112 based on the current file), update the `row` object literal:

```ts
const row: Record<string, unknown> = {
  ...stepData,
  tenant_id: input.tenantId,
  project_id: input.projectId ?? '',
  session_id: input.sessionId ?? '',
  run_id: (input.pipelineInput?.runId as string) ?? '', // NEW
  pipeline_id: (input.pipelineInput?.pipelineId as string) ?? '', // NEW
  source,
  created_at: new Date().toISOString(),
};
```

- [ ] **Step 2: Add tests for run_id propagation**

Append to `packages/pipeline-engine/src/__tests__/activity-services.test.ts` (existing file) a new `describe('store-results — run_id propagation', ...)`:

```ts
it('includes run_id and pipeline_id in the ClickHouse row', async () => {
  const inserted: any[] = [];
  const mockClient = {
    insert: async (args: any) => {
      inserted.push(args);
    },
  };
  // ... existing di pattern from activity-services.test.ts to inject mockClient ...

  await executeStoreResults({
    config: {
      destination: 'clickhouse',
      table: 'analytics.sentiment_scores',
      sourceStep: 'classify',
    },
    previousSteps: { classify: { data: { score: 0.9 } } },
    tenantId: 't',
    projectId: 'p',
    sessionId: 's',
    pipelineInput: { runId: 'run-xyz', pipelineId: 'pipe-1' },
    executionMode: 'batch',
  });

  expect(inserted[0].values[0]).toMatchObject({
    tenant_id: 't',
    project_id: 'p',
    session_id: 's',
    run_id: 'run-xyz',
    pipeline_id: 'pipe-1',
    score: 0.9,
  });
});
```

(If `activity-services.test.ts` uses a different pattern for DI, adapt to that pattern. Read it first to confirm the calling convention.)

- [ ] **Step 3: Run the test**

Run: `pnpm test --filter=@agent-platform/pipeline-engine -- activity-services`
Expected: new test passes, existing tests unaffected.

- [ ] **Step 4: Audit compute-\* services that write to ClickHouse directly**

Read each of these files and add `run_id` + `pipeline_id` to the row objects they `insert`:

- `packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-goal-completion.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-llm-evaluation.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-mentions.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-predictive-features.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-statistical.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-tool-effectiveness.service.ts`
- `packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts`

For each: find the `client.insert({ values: [row] })` call, ensure `run_id: (input.pipelineInput?.runId as string) ?? ''` and `pipeline_id: (input.pipelineInput?.pipelineId as string) ?? ''` are in the row.

- [ ] **Step 5: Run all pipeline-engine tests**

Run: `pnpm test --filter=@agent-platform/pipeline-engine`
Expected: all pass.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/*.ts packages/pipeline-engine/src/__tests__/activity-services.test.ts
git add packages/pipeline-engine/src/pipeline/services/ packages/pipeline-engine/src/__tests__/activity-services.test.ts
git commit -m "[ABLP-280] feat(pipeline-engine): write run_id + pipeline_id to ClickHouse

All compute-* services and store-results now include run_id and
pipeline_id in every analytics row. Enables Data tab row → Run
Detail drawer linking and per-run output slicing."
```

### Task 3.3: ~~Add `studio_reader` ClickHouse user~~ — DEFERRED to v2

Runtime reuses the shared `getClickHouseClient()` from `@agent-platform/database`. Studio never opens a ClickHouse connection — it proxies the query/export POSTs to runtime. A dedicated read-only `studio_reader` user with server-side caps is deferred to v2. The runtime query builder enforces execution time and scan caps via `SETTINGS` clauses in the meantime.

---

## Phase 4 — Studio read APIs

> **Architecture note (post-implementation):** The `listProjectRuns`,
> `getProjectRunHealth`, `output-schema`, and `previewable-pipelines`
> helpers described below were ultimately placed in **runtime**
> (`apps/runtime/src/services/pipeline-observability/`). Studio's routes
> at `/api/projects/:id/pipeline-runs[/health]`, `/api/pipelines/:id/output-schema`,
> and `/api/projects/:id/pipeline-data/previewable-pipelines` are thin
> proxies to the canonical runtime endpoints under
> `/api/projects/:projectId/pipeline-observability/*`. The pseudocode
> below reflects the original Studio-owned design — the actual
> implementation moved MongoDB access into runtime so Studio never
> queries Mongo directly. See §4.3 Ownership in the design doc.

### Task 4.1: Extend `pipeline-service.ts` with project-scoped helpers

**Files:**

- Modify: `apps/studio/src/lib/pipeline-service.ts`

- [ ] **Step 1: Add the `listProjectRuns` helper**

Append to `apps/studio/src/lib/pipeline-service.ts`:

```ts
export interface RunSummary {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  pipelineKind: 'builtin' | 'custom';
  status: IPipelineRunRecord['status'];
  trigger: IPipelineRunRecord['trigger'];
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  error?: { message: string };
}

export interface ListProjectRunsArgs {
  tenantId: string;
  projectId: string;
  type?: 'builtin' | 'custom' | 'all';
  pipelineId?: string;
  status?: IPipelineRunRecord['status'];
  since?: Date;
  until?: Date;
  limit: number;
  offset: number;
}

export async function listProjectRuns(args: ListProjectRunsArgs): Promise<{
  data: RunSummary[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}> {
  const filter: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
  };
  if (args.pipelineId) filter.pipelineId = args.pipelineId;
  if (args.status) filter.status = args.status;
  if (args.since || args.until) {
    filter.startedAt = {};
    if (args.since) (filter.startedAt as any).$gte = args.since;
    if (args.until) (filter.startedAt as any).$lte = args.until;
  }

  const [rows, total] = await Promise.all([
    PipelineRunRecordModel.aggregate([
      { $match: filter },
      { $sort: { startedAt: -1 } },
      { $skip: args.offset },
      { $limit: args.limit },
      {
        $lookup: {
          from: 'pipeline_definitions',
          localField: 'pipelineId',
          foreignField: '_id',
          as: 'def',
        },
      },
      { $unwind: { path: '$def', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          runId: 1,
          pipelineId: 1,
          pipelineName: { $ifNull: ['$def.name', '$pipelineId'] },
          pipelineKind: {
            $cond: [{ $eq: ['$def.tenantId', '__platform__'] }, 'builtin', 'custom'],
          },
          status: 1,
          trigger: 1,
          startedAt: 1,
          completedAt: 1,
          durationMs: 1,
          error: { message: '$error.message' },
        },
      },
    ]),
    PipelineRunRecordModel.countDocuments(filter),
  ]);

  let data = rows as RunSummary[];
  if (args.type && args.type !== 'all') {
    data = data.filter((r) => r.pipelineKind === args.type);
  }

  return {
    data,
    pagination: {
      total,
      limit: args.limit,
      offset: args.offset,
      hasMore: args.offset + data.length < total,
    },
  };
}

export async function getProjectRunHealth(args: {
  tenantId: string;
  projectId: string;
  window: '1h' | '24h' | '7d';
  pipelineId?: string;
}): Promise<{
  total: number;
  completed: number;
  failed: number;
  running: number;
  cancelled: number;
  successRate: number;
  avgDurationMs: number;
  byPipeline?: Array<{ pipelineId: string; total: number; failed: number; successRate: number }>;
}> {
  const windowMs = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[args.window];
  const since = new Date(Date.now() - windowMs);

  const match: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
    startedAt: { $gte: since },
  };
  if (args.pipelineId) match.pipelineId = args.pipelineId;

  const [totals, byPipelineRaw] = await Promise.all([
    PipelineRunRecordModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          running: {
            $sum: {
              $cond: [{ $in: ['$status', ['running', 'pending']] }, 1, 0],
            },
          },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          avgDurationMs: { $avg: '$durationMs' },
        },
      },
    ]),
    args.pipelineId
      ? Promise.resolve([])
      : PipelineRunRecordModel.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$pipelineId',
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            },
          },
        ]),
  ]);

  const t = totals[0] ?? {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    cancelled: 0,
    avgDurationMs: 0,
  };
  const terminal = t.completed + t.failed + t.cancelled;
  const successRate = terminal === 0 ? 1 : t.completed / terminal;

  return {
    ...t,
    successRate,
    avgDurationMs: t.avgDurationMs ?? 0,
    ...(args.pipelineId
      ? {}
      : {
          byPipeline: (
            byPipelineRaw as Array<{
              _id: string;
              total: number;
              failed: number;
              completed: number;
            }>
          ).map((p) => ({
            pipelineId: p._id,
            total: p.total,
            failed: p.failed,
            successRate: p.total === 0 ? 1 : p.completed / p.total,
          })),
        }),
  };
}
```

- [ ] **Step 2: Write unit tests for both helpers**

Create: `apps/studio/src/lib/__tests__/pipeline-service-project.test.ts` using MongoMemoryServer. Seed 5 run records across 2 projects and 2 pipeline kinds (1 `__platform__` definition, 1 tenant-owned definition); assert `listProjectRuns` returns only current-project rows, filter `type=builtin` returns only the `__platform__` runs, and `getProjectRunHealth` returns correct counts and successRate. (Follow the pattern from `packages/pipeline-engine/src/__tests__/run-record-project-isolation.test.ts`.)

- [ ] **Step 3: Run tests**

Run: `pnpm test --filter=@agent-platform/studio -- pipeline-service-project`
Expected: all pass.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/pipeline-service.ts apps/studio/src/lib/__tests__/pipeline-service-project.test.ts
git add apps/studio/src/lib/pipeline-service.ts apps/studio/src/lib/__tests__/pipeline-service-project.test.ts
git commit -m "[ABLP-280] feat(studio): add listProjectRuns + getProjectRunHealth helpers

Project-scoped run aggregation for the Recent Runs tab and Health
strip. Joins pipeline_definitions to attach name + kind
(builtin|custom) in a single query."
```

### Task 4.2: Route `GET /api/projects/[projectId]/pipeline-runs`

**Files:**

- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-runs/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, requireProjectAccess } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { listProjectRuns } from '@/lib/pipeline-service';

const QuerySchema = z.object({
  type: z.enum(['builtin', 'custom', 'all']).default('all'),
  pipelineId: z.string().min(1).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

type RouteParams = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { projectId } = await params;
  const projectCheck = await requireProjectAccess(user, projectId);
  if (isAuthError(projectCheck)) return projectCheck;

  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return errorJson(parsed.error.message, 400, ErrorCode.VALIDATION_ERROR);
  }

  try {
    const since = parsed.data.since ?? new Date(Date.now() - 24 * 3600e3);
    const until = parsed.data.until ?? new Date();
    const result = await listProjectRuns({
      tenantId: user.tenantId,
      projectId,
      type: parsed.data.type,
      pipelineId: parsed.data.pipelineId,
      status: parsed.data.status,
      since,
      until,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return handleApiError(error, 'GET /api/projects/:projectId/pipeline-runs');
  }
}
```

If `requireProjectAccess` does not yet exist in `@/lib/auth`, use the existing equivalent — read `apps/studio/src/lib/auth.ts` and pick the correct helper. If none exists, create one that validates the user is a member of the given project and returns a `NextResponse` 404 on mismatch (404, not 403).

- [ ] **Step 2: Add a lightweight E2E test**

Create: `apps/studio/e2e/pipelines/pipeline-isolation.e2e.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestServer, createTestUser } from '../helpers'; // existing helpers
import { PipelineRunRecordModel } from '@agent-platform/pipeline-engine';

describe('project-scoped runs list isolation', () => {
  const { server, baseUrl, port } = createTestServer();

  beforeAll(async () => {
    await server.start();
    // Seed 1 run for project-x, 1 run for project-y under the same tenant
    await PipelineRunRecordModel.create([
      {
        _id: 'r1',
        runId: 'r1',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tA',
        projectId: 'project-x',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
      {
        _id: 'r2',
        runId: 'r2',
        pipelineId: 'p1',
        pipelineVersion: 1,
        tenantId: 'tA',
        projectId: 'project-y',
        status: 'completed',
        trigger: { type: 'kafka', triggerId: 't', executionMode: 'batch' },
        input: {},
        steps: [],
        startedAt: new Date(),
      },
    ]);
  });
  afterAll(() => server.stop());

  it('user in project-x cannot see runs from project-y', async () => {
    const token = await createTestUser({ tenantId: 'tA', projectIds: ['project-x'] });
    const res = await fetch(`${baseUrl}/api/projects/project-x/pipeline-runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.map((r: any) => r.runId)).toEqual(['r1']);
  });

  it('user not in project-y gets 404', async () => {
    const token = await createTestUser({ tenantId: 'tA', projectIds: ['project-x'] });
    const res = await fetch(`${baseUrl}/api/projects/project-y/pipeline-runs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `pnpm test --filter=@agent-platform/studio -- pipeline-isolation.e2e`
Expected: 2 passing.

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[projectId\]/pipeline-runs/route.ts apps/studio/e2e/pipelines/pipeline-isolation.e2e.ts
git add apps/studio/src/app/api/projects/\[projectId\]/pipeline-runs/route.ts apps/studio/e2e/pipelines/pipeline-isolation.e2e.ts
git commit -m "[ABLP-280] feat(studio): GET /api/projects/:projectId/pipeline-runs

Project-scoped runs list with type/pipelineId/status/time filters.
Cross-project access returns 404 (no existence leak)."
```

### Task 4.3: Route `GET /api/projects/[projectId]/pipeline-runs/health`

**Files:**

- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-runs/health/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, requireProjectAccess } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { getProjectRunHealth } from '@/lib/pipeline-service';

const QuerySchema = z.object({
  window: z.enum(['1h', '24h', '7d']).default('24h'),
  pipelineId: z.string().min(1).optional(),
});

type RouteParams = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const { projectId } = await params;
  const projectCheck = await requireProjectAccess(user, projectId);
  if (isAuthError(projectCheck)) return projectCheck;

  const parsed = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) return errorJson(parsed.error.message, 400, ErrorCode.VALIDATION_ERROR);

  try {
    const data = await getProjectRunHealth({
      tenantId: user.tenantId,
      projectId,
      window: parsed.data.window,
      pipelineId: parsed.data.pipelineId,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return handleApiError(error, 'GET /api/projects/:projectId/pipeline-runs/health');
  }
}
```

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[projectId\]/pipeline-runs/health/route.ts
git add apps/studio/src/app/api/projects/\[projectId\]/pipeline-runs/health/route.ts
git commit -m "[ABLP-280] feat(studio): GET /api/projects/:projectId/pipeline-runs/health

Aggregated status counts for the Recent Runs health strip and
pipeline card health badges."
```

### Task 4.4: Output-schema, previewable-pipelines routes

**Files:**

- Create: `apps/studio/src/app/api/pipelines/[pipelineId]/output-schema/route.ts`
- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-data/previewable-pipelines/route.ts`

> **Note:** Trigger-templates route deferred to v2 (requires Test drawer UI).

- [ ] **Step 1: Output-schema + previewable-pipelines routes**

Create `apps/studio/src/app/api/pipelines/[pipelineId]/output-schema/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { resolveOutputSchema } from '@/lib/pipeline-data/schema-resolver';

type RouteParams = { params: Promise<{ pipelineId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const { pipelineId } = await params;

  try {
    const schema = await resolveOutputSchema(pipelineId, user.tenantId);
    return NextResponse.json({ success: true, data: schema });
  } catch (error: any) {
    if (error?.code === 'NO_OUTPUT_TABLE') return errorJson(error.message, 400, 'NO_OUTPUT_TABLE');
    if (error?.code === 'NOT_FOUND')
      return errorJson('Pipeline not found', 404, ErrorCode.NOT_FOUND);
    return handleApiError(error, 'GET /api/pipelines/:pipelineId/output-schema');
  }
}
```

Create `apps/studio/src/app/api/projects/[projectId]/pipeline-data/previewable-pipelines/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, requireProjectAccess } from '@/lib/auth';
import { handleApiError } from '@/lib/api-response';
import { PipelineDefinitionModel, PipelineConfigModel } from '@agent-platform/pipeline-engine';

type RouteParams = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const { projectId } = await params;
  const projectCheck = await requireProjectAccess(user, projectId);
  if (isAuthError(projectCheck)) return projectCheck;

  try {
    const configs = await PipelineConfigModel.find({
      tenantId: user.tenantId,
      $or: [{ projectId }, { projectId: null }],
      enabled: true,
    }).lean();

    const pipelineTypes = configs.map((c) => c.pipelineType);
    const defs = await PipelineDefinitionModel.find({
      tenantId: { $in: ['__platform__', user.tenantId] },
      $or: [{ pipelineType: { $in: pipelineTypes } }, { projectId }],
      status: 'active',
    }).lean();

    const data = defs
      .map((d) => {
        const storeNode = (d.nodes ?? []).find(
          (n: any) => n.type === 'store-results' || n.type === 'store-insight',
        );
        if (!storeNode) return null;
        const table = (storeNode as any).config?.table as string | undefined;
        if (!table) return null;
        return {
          pipelineId: d._id,
          name: d.name,
          kind: d.tenantId === '__platform__' ? 'builtin' : 'custom',
          table,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return handleApiError(
      error,
      'GET /api/projects/:projectId/pipeline-data/previewable-pipelines',
    );
  }
}
```

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write \
  apps/studio/src/app/api/pipelines/\[pipelineId\]/output-schema/route.ts \
  apps/studio/src/app/api/projects/\[projectId\]/pipeline-data/previewable-pipelines/route.ts
git add \
  apps/studio/src/app/api/pipelines/\[pipelineId\]/output-schema/route.ts \
  apps/studio/src/app/api/projects/\[projectId\]/pipeline-data/previewable-pipelines/route.ts
git commit -m "[ABLP-280] feat(studio): output schema + previewable pipelines routes

- GET /api/pipelines/:pipelineId/output-schema returns columns + filterable/exportable flags.
- GET /api/projects/:projectId/pipeline-data/previewable-pipelines lists pipelines with a store-results node."
```

---

## Phase 5 — ~~Test trigger route~~ DEFERRED to v2

Manual test trigger route (`POST /api/pipelines/:pipelineId/test`), trigger-templates route, and the associated E2E test (`pipeline-test-run.e2e.ts`) are deferred to v2 along with the Test Drawer UI. The engine-side `triggerManual` handler (Phase 2) is already extended and ready.

---

## Phase 6 — Data query + export

> **Architecture note (post-implementation):** The schema resolver, query
> builder, and ClickHouse client described in Tasks 6.1–6.3 were
> ultimately placed in **runtime** (`apps/runtime/src/services/pipeline-observability/`)
> rather than Studio. Studio's `pipeline-data/query` and `pipeline-data/export`
> routes are thin proxies to `/api/projects/:projectId/pipeline-observability/data/*`.
> The pseudocode below reflects the original Studio-owned design — the actual
> implementation moved MongoDB + ClickHouse access into runtime so Studio
> never holds those credentials. See §4.3 Ownership in the design doc.

### Task 6.1: Schema resolver

**Files:**

- Create: `apps/studio/src/lib/pipeline-data/schema-resolver.ts`
- Create: `apps/studio/src/lib/pipeline-data/schema-resolver.test.ts`

- [ ] **Step 1: Implement the resolver**

```ts
import { PipelineDefinitionModel, PipelineConfigModel } from '@agent-platform/pipeline-engine';

export interface ColumnMeta {
  name: string;
  type: string;
  filterable: boolean;
  exportable: boolean;
  description?: string;
}

export interface OutputSchema {
  table: string;
  columns: ColumnMeta[];
}

export class OutputSchemaError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'NO_OUTPUT_TABLE',
    message: string,
  ) {
    super(message);
    this.name = 'OutputSchemaError';
  }
}

// Simple in-process TTL cache.
const cache = new Map<string, { expires: number; schema: OutputSchema }>();
const TTL_MS = 60_000;

export async function resolveOutputSchema(
  pipelineId: string,
  tenantId: string,
): Promise<OutputSchema> {
  const key = `${tenantId}:${pipelineId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.schema;

  const def = await PipelineDefinitionModel.findOne({
    _id: pipelineId,
    tenantId: { $in: ['__platform__', tenantId] },
    status: 'active',
  }).lean();
  if (!def) throw new OutputSchemaError('NOT_FOUND', 'Pipeline not found');

  const storeNode = (def.nodes ?? []).find(
    (n: any) => n.type === 'store-results' || n.type === 'store-insight',
  ) as any;
  if (!storeNode) {
    throw new OutputSchemaError(
      'NO_OUTPUT_TABLE',
      `Pipeline "${def.name}" has no store-results node — nothing to preview`,
    );
  }

  const config = storeNode.config ?? {};
  const table = config.table as string;
  const declared = (config.outputSchema?.columns ?? []) as ColumnMeta[];

  // Always include tenant/project/session/run/pipeline metadata columns
  const baseCols: ColumnMeta[] = [
    { name: 'run_id', type: 'String', filterable: true, exportable: true },
    { name: 'pipeline_id', type: 'String', filterable: false, exportable: true },
    { name: 'session_id', type: 'String', filterable: true, exportable: true },
    { name: 'created_at', type: 'DateTime', filterable: false, exportable: true },
  ];

  // Merge by name — declared takes precedence
  const byName = new Map<string, ColumnMeta>();
  for (const c of baseCols) byName.set(c.name, c);
  for (const c of declared) byName.set(c.name, c);

  const schema: OutputSchema = {
    table,
    columns: [...byName.values()],
  };

  cache.set(key, { expires: Date.now() + TTL_MS, schema });
  return schema;
}

export function clearSchemaCache() {
  cache.clear();
}
```

- [ ] **Step 2: Unit tests**

Create: `apps/studio/src/lib/pipeline-data/schema-resolver.test.ts`
Cover: resolves canonical schema, caches within TTL, throws `NO_OUTPUT_TABLE` when graph lacks store-results, throws `NOT_FOUND` for unknown pipelineId, declared columns override base metadata. Use MongoMemoryServer.

- [ ] **Step 3: Run tests**

Run: `pnpm test --filter=@agent-platform/studio -- schema-resolver`
Expected: all pass.

### Task 6.2: Query builder

**Files:**

- Create: `apps/studio/src/lib/pipeline-data/query-builder.ts`
- Create: `apps/studio/src/lib/pipeline-data/query-builder.test.ts`

- [ ] **Step 1: Write failing tests first**

Create: `apps/studio/src/lib/pipeline-data/query-builder.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildPipelineDataQuery, QueryBuilderError } from './query-builder.js';
import type { ColumnMeta } from './schema-resolver.js';

const COLUMNS: ColumnMeta[] = [
  { name: 'run_id', type: 'String', filterable: true, exportable: true },
  { name: 'session_id', type: 'String', filterable: true, exportable: true },
  { name: 'created_at', type: 'DateTime', filterable: false, exportable: true },
  { name: 'score', type: 'Float64', filterable: true, exportable: true },
  { name: 'label', type: 'String', filterable: true, exportable: true },
  { name: 'raw', type: 'String', filterable: false, exportable: false },
];

describe('buildPipelineDataQuery', () => {
  const base = {
    tenantId: 'tA',
    projectId: 'pX',
    pipelineId: 'def-1',
    tableName: 'analytics.sentiment_scores',
    columns: COLUMNS,
    timeRange: { from: new Date('2026-04-12T00:00:00Z'), to: new Date('2026-04-13T00:00:00Z') },
    filters: [],
    limit: 50,
    offset: 0,
  };

  it('builds a valid query with default filters', () => {
    const { sql, params } = buildPipelineDataQuery(base);
    expect(sql).toContain('FROM analytics.sentiment_scores');
    expect(sql).toContain('tenant_id = {tenantId:String}');
    expect(sql).toContain('project_id = {projectId:String}');
    expect(sql).toContain('created_at >= {from:DateTime}');
    expect(params.tenantId).toBe('tA');
    expect(params.projectId).toBe('pX');
  });

  it('rejects non-filterable columns', () => {
    expect(() =>
      buildPipelineDataQuery({
        ...base,
        filters: [{ column: 'raw', op: '=', value: 'anything' }],
      }),
    ).toThrowError(/not filterable/);
  });

  it('rejects invalid table names', () => {
    expect(() =>
      buildPipelineDataQuery({ ...base, tableName: 'analytics; DROP TABLE' }),
    ).toThrowError();
  });

  it("supports 'in' operator with array parameter", () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      filters: [{ column: 'label', op: 'in', value: ['pos', 'neg'] }],
    });
    expect(sql).toMatch(/label IN \{f0:Array\(String\)\}/);
    expect(params.f0).toEqual(['pos', 'neg']);
  });

  it("supports 'contains' only on String columns", () => {
    expect(() =>
      buildPipelineDataQuery({
        ...base,
        filters: [{ column: 'score', op: 'contains', value: '1' }],
      }),
    ).toThrowError(/only valid on String/);
  });

  it('enforces a maximum limit of 500', () => {
    const { sql, params } = buildPipelineDataQuery({ ...base, limit: 9999 });
    expect(params.limit).toBe(500);
  });

  it('optionally includes run_id and session_id filters', () => {
    const { sql, params } = buildPipelineDataQuery({
      ...base,
      sessionId: 'sess-1',
      runId: 'run-xyz',
    } as any);
    expect(sql).toContain('session_id = {sessionId:String}');
    expect(sql).toContain('run_id = {runId:String}');
    expect(params.sessionId).toBe('sess-1');
    expect(params.runId).toBe('run-xyz');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@agent-platform/studio -- query-builder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the query builder**

Create: `apps/studio/src/lib/pipeline-data/query-builder.ts`

```ts
import type { ColumnMeta } from './schema-resolver.js';

export class QueryBuilderError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/;
const COL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface BuildQueryArgs {
  tenantId: string;
  projectId: string;
  pipelineId: string;
  tableName: string;
  columns: ColumnMeta[];
  sessionId?: string;
  runId?: string;
  timeRange: { from: Date; to: Date };
  filters: Array<{ column: string; op: '=' | 'in' | 'contains'; value: unknown }>;
  limit: number;
  offset: number;
}

export function buildPipelineDataQuery(args: BuildQueryArgs): {
  sql: string;
  params: Record<string, unknown>;
} {
  if (!TABLE_RE.test(args.tableName)) {
    throw new QueryBuilderError(`Invalid table name: ${args.tableName}`, 'INVALID_TABLE');
  }

  const colByName = new Map(args.columns.map((c) => [c.name, c]));
  const filterable = new Set(args.columns.filter((c) => c.filterable).map((c) => c.name));

  const where: string[] = [
    'tenant_id = {tenantId:String}',
    'project_id = {projectId:String}',
    'pipeline_id = {pipelineId:String}',
    'created_at >= {from:DateTime}',
    'created_at <= {to:DateTime}',
  ];
  const params: Record<string, unknown> = {
    tenantId: args.tenantId,
    projectId: args.projectId,
    pipelineId: args.pipelineId,
    from: args.timeRange.from,
    to: args.timeRange.to,
  };

  if (args.sessionId) {
    where.push('session_id = {sessionId:String}');
    params.sessionId = args.sessionId;
  }
  if (args.runId) {
    where.push('run_id = {runId:String}');
    params.runId = args.runId;
  }

  args.filters.forEach((f, i) => {
    if (!COL_RE.test(f.column)) {
      throw new QueryBuilderError(`Invalid column name: ${f.column}`, 'INVALID_COLUMN');
    }
    if (!filterable.has(f.column)) {
      throw new QueryBuilderError(`Column "${f.column}" is not filterable`, 'INVALID_FILTER');
    }
    const col = colByName.get(f.column)!;
    const p = `f${i}`;
    switch (f.op) {
      case '=':
        where.push(`${f.column} = {${p}:${col.type}}`);
        params[p] = f.value;
        break;
      case 'in':
        where.push(`${f.column} IN {${p}:Array(${col.type})}`);
        params[p] = f.value;
        break;
      case 'contains':
        if (col.type !== 'String') {
          throw new QueryBuilderError('"contains" only valid on String columns', 'INVALID_FILTER');
        }
        where.push(`positionCaseInsensitive(${f.column}, {${p}:String}) > 0`);
        params[p] = f.value;
        break;
    }
  });

  const selectCols = args.columns.map((c) => c.name).join(', ');
  const limit = Math.min(args.limit, 500);
  const offset = Math.max(args.offset, 0);

  const sql = `
    SELECT ${selectCols}
    FROM ${args.tableName}
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    SETTINGS max_execution_time = 10, max_rows_to_read = 1000000, max_result_rows = 500
  `.trim();

  params.limit = limit;
  params.offset = offset;

  return { sql, params };
}
```

- [ ] **Step 4: Run tests again**

Run: `pnpm test --filter=@agent-platform/studio -- query-builder`
Expected: 7 passing.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write apps/studio/src/lib/pipeline-data/
git add apps/studio/src/lib/pipeline-data/
git commit -m "[ABLP-280] feat(studio): schema resolver + ClickHouse query builder

Resolves output schema from pipeline definition's store-results node.
Builds parameterized ClickHouse queries with column allowlist,
forced tenant/project isolation, 500-row cap, and 10s execution
cap. SETTINGS clause enforces row-scan limit on the server as
defence-in-depth."
```

### Task 6.3: Query + export routes

**Files:**

- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-data/query/route.ts`
- Create: `apps/studio/src/app/api/projects/[projectId]/pipeline-data/export/route.ts`

- [ ] **Step 1: Implement query route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, requireProjectAccess } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveOutputSchema, OutputSchemaError } from '@/lib/pipeline-data/schema-resolver';
import { buildPipelineDataQuery, QueryBuilderError } from '@/lib/pipeline-data/query-builder';
import { getClickHouseStudioReader } from '@/lib/pipeline-data/clickhouse-client';

const BodySchema = z.object({
  pipelineId: z.string().min(1),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  timeRange: z.object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  }),
  filters: z
    .array(
      z.object({
        column: z.string().min(1),
        op: z.enum(['=', 'in', 'contains']),
        value: z.unknown(),
      }),
    )
    .optional()
    .default([]),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
});

type RouteParams = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const { projectId } = await params;
  const projectCheck = await requireProjectAccess(user, projectId);
  if (isAuthError(projectCheck)) return projectCheck;

  const limited = await checkRateLimit(`pipeline-data-query:${user.userId}`, 60, 60);
  if (limited.exceeded) {
    return errorJson('Rate limit exceeded', 429, 'RATE_LIMITED');
  }

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return errorJson(parsed.error.message, 400, ErrorCode.VALIDATION_ERROR);

  try {
    const schema = await resolveOutputSchema(parsed.data.pipelineId, user.tenantId);
    const { sql, params: p } = buildPipelineDataQuery({
      tenantId: user.tenantId,
      projectId,
      pipelineId: parsed.data.pipelineId,
      tableName: schema.table,
      columns: schema.columns,
      sessionId: parsed.data.sessionId,
      runId: parsed.data.runId,
      timeRange: parsed.data.timeRange,
      filters: parsed.data.filters,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    const client = getClickHouseStudioReader();
    const result = await client.query({ query: sql, query_params: p, format: 'JSONEachRow' });
    const rows: unknown[] = await result.json();

    return NextResponse.json({
      success: true,
      data: { table: schema.table, columns: schema.columns, rows },
      pagination: {
        total: null, // count is computed separately (phase 2 of this route)
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        hasMore: rows.length === parsed.data.limit,
      },
    });
  } catch (error: any) {
    if (error instanceof OutputSchemaError && error.code === 'NO_OUTPUT_TABLE') {
      return errorJson(error.message, 400, 'NO_OUTPUT_TABLE');
    }
    if (error instanceof OutputSchemaError && error.code === 'NOT_FOUND') {
      return errorJson('Pipeline not found', 404, ErrorCode.NOT_FOUND);
    }
    if (error instanceof QueryBuilderError) {
      return errorJson(error.message, 400, error.code);
    }
    const msg = String(error?.message ?? '');
    if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('exceeded max_execution_time')) {
      return errorJson('Query exceeded 10-second limit', 504, 'QUERY_TIMEOUT');
    }
    if (msg.includes('max_rows_to_read')) {
      return errorJson('Query scan limit hit — narrow filters', 413, 'SCAN_LIMIT');
    }
    return handleApiError(error, 'POST /api/projects/:projectId/pipeline-data/query');
  }
}
```

- [ ] **Step 2: Implement export route**

```ts
// apps/studio/src/app/api/projects/[projectId]/pipeline-data/export/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, requireProjectAccess } from '@/lib/auth';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveOutputSchema, OutputSchemaError } from '@/lib/pipeline-data/schema-resolver';
import { buildPipelineDataQuery, QueryBuilderError } from '@/lib/pipeline-data/query-builder';
import { getClickHouseStudioReader } from '@/lib/pipeline-data/clickhouse-client';
import { auditLog } from '@/lib/audit-log';

const BodySchema = z.object({
  pipelineId: z.string().min(1),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  timeRange: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
  filters: z
    .array(
      z.object({
        column: z.string().min(1),
        op: z.enum(['=', 'in', 'contains']),
        value: z.unknown(),
      }),
    )
    .optional()
    .default([]),
});

const EXPORT_CAP = 10_000;

type RouteParams = { params: Promise<{ projectId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;
  const { projectId } = await params;
  const projectCheck = await requireProjectAccess(user, projectId);
  if (isAuthError(projectCheck)) return projectCheck;

  const limited = await checkRateLimit(`pipeline-data-export:${user.userId}`, 5, 60);
  if (limited.exceeded) return errorJson('Rate limit exceeded', 429, 'RATE_LIMITED');

  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) return errorJson(parsed.error.message, 400, ErrorCode.VALIDATION_ERROR);

  try {
    const schema = await resolveOutputSchema(parsed.data.pipelineId, user.tenantId);
    const exportable = schema.columns.filter((c) => c.exportable);

    const { sql, params: p } = buildPipelineDataQuery({
      tenantId: user.tenantId,
      projectId,
      pipelineId: parsed.data.pipelineId,
      tableName: schema.table,
      columns: exportable,
      sessionId: parsed.data.sessionId,
      runId: parsed.data.runId,
      timeRange: parsed.data.timeRange,
      filters: parsed.data.filters,
      limit: EXPORT_CAP,
      offset: 0,
    });
    // Override result cap for export:
    const overriddenSql = sql.replace(
      'SETTINGS max_execution_time = 10, max_rows_to_read = 1000000, max_result_rows = 500',
      'SETTINGS max_execution_time = 30, max_rows_to_read = 10000000, max_result_rows = 10000',
    );

    const client = getClickHouseStudioReader();
    const stream = await client
      .query({ query: overriddenSql, query_params: p, format: 'CSVWithNames' })
      .stream();

    await auditLog('pipeline.data.export', {
      pipelineId: parsed.data.pipelineId,
      userId: user.userId,
      tenantId: user.tenantId,
      projectId,
      filters: parsed.data.filters,
    });

    const filename = `${parsed.data.pipelineId}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(stream as any, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: any) {
    if (error instanceof OutputSchemaError) {
      return errorJson(error.message, error.code === 'NOT_FOUND' ? 404 : 400, error.code);
    }
    if (error instanceof QueryBuilderError) return errorJson(error.message, 400, error.code);
    return handleApiError(error, 'POST /api/projects/:projectId/pipeline-data/export');
  }
}
```

- [ ] **Step 3: ClickHouse client**

ClickHouse access lives in **runtime**, not Studio. Runtime uses the shared `getClickHouseClient()` from `@agent-platform/database`. Studio's `pipeline-data/query` and `pipeline-data/export` routes are thin proxies that forward to runtime's `/api/projects/:projectId/pipeline-observability/data/*` endpoints and stream the response back. No dedicated studio_reader user (deferred to v2). Runtime import:

```ts
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
```

- [ ] **Step 4: E2E test**

Create: `apps/studio/e2e/pipelines/pipeline-data-query.e2e.ts`

Pattern:

1. Seed a row in `analytics.sentiment_scores` with `tenant_id='tA'`, `project_id='pX'`, `session_id='sess-1'`, `run_id='run-xyz'`, `score=0.9`, `label='positive'`, `created_at=now()`.
2. Seed a matching PipelineDefinition with a `store-results` node configured for that table.
3. Seed a second row under a _different_ project → assert it does not appear.
4. POST `/api/projects/pX/pipeline-data/query` with filter `{ column: 'label', op: '=', value: 'positive' }`.
5. Assert `rows.length === 1`, `rows[0].run_id === 'run-xyz'`.
6. POST with filter `{ column: 'raw', op: '=', value: 'x' }` (non-filterable) → expect 400 `INVALID_FILTER`.
7. POST `/api/projects/pX/pipeline-data/export` with the same filters → assert `Content-Type: text/csv` and CSV body contains header row + 1 data row.
8. Attempt with pipelineId that has no store-results node → expect 400 `NO_OUTPUT_TABLE`.

- [ ] **Step 5: Run tests**

Run: `pnpm test --filter=@agent-platform/studio -- pipeline-data-query.e2e`
Expected: all pass.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[projectId\]/pipeline-data/ apps/studio/e2e/pipelines/pipeline-data-query.e2e.ts
git add apps/studio/src/app/api/projects/\[projectId\]/pipeline-data/ apps/studio/e2e/pipelines/pipeline-data-query.e2e.ts
git commit -m "[ABLP-280] feat(studio): ClickHouse data query and export proxy routes

Query route: parameterized query, 500-row cap, error codes for
timeout/scan-limit. Export route: streams CSV, non-exportable
columns dropped, 5/min rate limit, audit-logged. Routes are thin
proxies to runtime's /api/projects/:projectId/pipeline-observability
/data/* endpoints; runtime owns ClickHouse access via the shared
getClickHouseClient() from @agent-platform/database."
```

---

## Phase 7 — UI: Recent Runs tab + Run Detail drawer

### Task 7.1: `RecentRunsPanel` + supporting components

**Files:**

- Create: `apps/studio/src/components/pipelines/runs/RecentRunsPanel.tsx`
- Create: `apps/studio/src/components/pipelines/runs/RunStatusIcon.tsx`
- Create: `apps/studio/src/components/pipelines/runs/HealthStrip.tsx`
- Create: `apps/studio/src/components/pipelines/runs/RunFilters.tsx`
- Create: `apps/studio/src/store/pipeline-runs-store.ts`
- Modify: `apps/studio/src/components/pipelines/PipelinesListPage.tsx`
- Modify: `apps/studio/src/store/pipeline-list-store.ts` (add 'runs' and 'data' tab ids)

- [ ] **Step 1: Add tab IDs to the store**

In `apps/studio/src/store/pipeline-list-store.ts` extend the existing `PipelineListTab` type:

```ts
export type PipelineListTab = 'builtin' | 'custom' | 'runs' | 'data';
```

- [ ] **Step 2: Runs store for filters**

Create `apps/studio/src/store/pipeline-runs-store.ts` with a Zustand store exposing:

```ts
type RunsStoreState = {
  typeFilter: 'all' | 'builtin' | 'custom';
  pipelineFilter: string | null; // pipelineId
  statusFilter: 'all' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  timeWindow: '1h' | '24h' | '7d';
  openRunId: string | null; // for the drawer
  setTypeFilter: (t: 'all' | 'builtin' | 'custom') => void;
  setPipelineFilter: (id: string | null) => void;
  setStatusFilter: (s: RunsStoreState['statusFilter']) => void;
  setTimeWindow: (w: RunsStoreState['timeWindow']) => void;
  openRun: (id: string) => void;
  closeRun: () => void;
};
```

Use `create` from `zustand` (existing pattern in the project).

- [ ] **Step 3: `RunStatusIcon`**

Trivial component mapping status → Lucide icon + colour token. Four cases: `completed` (CheckCircle, success), `failed` (XCircle, error), `running|pending` (Loader, warning, animate-spin), `cancelled` (MinusCircle, muted).

- [ ] **Step 4: `HealthStrip`**

SWR-fetches `/api/projects/{projectId}/pipeline-runs/health?window={window}` and renders a horizontal strip:

```
Last 24h:  12 runs  |  10 ✓  |  1 ✗  |  1 running  |  Avg 4.2s
```

Revalidates every 10 s. Loading skeleton: matching-height stripe.

- [ ] **Step 5: `RunFilters`**

Renders four controls (Type, Pipeline, Status, Time window) bound to the runs store. Pipeline dropdown fetches `/api/projects/{projectId}/pipelines` (existing route) and lists all pipelines plus an "All pipelines" option.

- [ ] **Step 6: `RecentRunsPanel` main component**

Pseudocode:

```tsx
export function RecentRunsPanel({
  projectId,
  pipelineIdOverride,
}: {
  projectId: string;
  pipelineIdOverride?: string;
}) {
  const { typeFilter, pipelineFilter, statusFilter, timeWindow, openRun } = useRunsStore();
  const effectivePipeline = pipelineIdOverride ?? pipelineFilter;
  const key = buildRunsListKey({
    projectId,
    typeFilter,
    effectivePipeline,
    statusFilter,
    timeWindow,
  });
  const { data, mutate, isLoading } = useSWR(key, swrFetcher, {
    refreshInterval: 5000, // auto-poll
    revalidateOnFocus: true,
  });

  return (
    <div className="space-y-4">
      <HealthStrip projectId={projectId} window={timeWindow} />
      <RunFilters projectId={projectId} hidePipelineFilter={!!pipelineIdOverride} />
      <RunsTable data={data?.data} loading={isLoading} onRowClick={openRun} onRefresh={mutate} />
      <RunDetailDrawer projectId={projectId} />
    </div>
  );
}
```

`buildRunsListKey` constructs a URL-encoded querystring for `/api/projects/{projectId}/pipeline-runs`.

`RunsTable` is a plain table component — status icon, pipeline name (append `(B)`/`(C)`), trigger type badge, started (relative), duration, and a row-level actions menu (`View` = `openRun(runId)`, `Re-run`, `Cancel`). Use existing Studio UI components (Badge, Button).

- [ ] **Step 7: Wire into `PipelinesListPage`**

Extend the `tabs` array:

```tsx
const tabs = useMemo(
  () => [
    { id: 'builtin' as const, label: t('tab_builtin') },
    { id: 'custom' as const, label: t('tab_custom') },
    { id: 'runs' as const, label: t('tab_recent_runs') },
    { id: 'data' as const, label: t('tab_data') },
  ],
  [t],
);
```

Conditional render:

```tsx
{
  activeTab === 'runs' && projectId && <RecentRunsPanel projectId={projectId} />;
}
{
  activeTab === 'data' && projectId && <PipelineDataPanel projectId={projectId} />;
}
```

Hide the `Create Pipeline` primary action on `runs` and `data` tabs.

- [ ] **Step 8: i18n strings**

In `apps/studio/messages/en.json`, under the `pipelines` key add:

```json
"tab_recent_runs": "Recent Runs",
"tab_data": "Data",
"health_strip": {
  "last_24h": "Last 24h",
  "total": "{n} runs",
  "completed": "{n} ✓",
  "failed": "{n} ✗",
  "running": "{n} running",
  "avg_duration": "Avg {ms}"
},
"filters": {
  "type_all": "All types",
  "type_builtin": "Built-in",
  "type_custom": "Custom",
  "pipeline_all": "All pipelines",
  "status_all": "All statuses",
  "window_1h": "Last 1h",
  "window_24h": "Last 24h",
  "window_7d": "Last 7d"
},
"empty_no_runs": "No runs match these filters",
"empty_no_runs_hint": "Change filters or trigger a test run to see results here."
```

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/runs/ apps/studio/src/components/pipelines/PipelinesListPage.tsx apps/studio/src/store/pipeline-list-store.ts apps/studio/src/store/pipeline-runs-store.ts apps/studio/messages/en.json
git add apps/studio/src/components/pipelines/runs/ apps/studio/src/components/pipelines/PipelinesListPage.tsx apps/studio/src/store/pipeline-list-store.ts apps/studio/src/store/pipeline-runs-store.ts apps/studio/messages/en.json
git commit -m "[ABLP-280] feat(studio): Recent Runs tab + Health strip + filters

New third tab on PipelinesListPage. Auto-polls every 5s. Health
strip shows last-24h aggregates. Row click opens Run Detail drawer
(next commit)."
```

### Task 7.2: `RunDetailDrawer`

**Files:**

- Create: `apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx`
- Create: `apps/studio/src/components/pipelines/runs/useRunPolling.ts`

- [ ] **Step 1: `useRunPolling` hook**

```ts
import useSWR from 'swr';
import { swrFetcher } from '@/lib/swr-config';

const TERMINAL = ['completed', 'failed', 'cancelled'];

export function useRunPolling(runId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    runId ? `/api/pipelines/runs/${runId}` : null,
    swrFetcher,
    {
      refreshInterval: (latest) => {
        if (!latest?.run) return 2000;
        return TERMINAL.includes(latest.run.status) ? 0 : 2000;
      },
      revalidateOnFocus: false,
    },
  );
  return { run: data?.run, error, isLoading, refresh: mutate };
}
```

- [ ] **Step 2: `RunDetailDrawer` — four tabs**

Use the existing Studio Drawer primitive (verify the exact import — probably `<SlideOver>` or similar under `components/ui`).

```tsx
export function RunDetailDrawer({ projectId }: { projectId: string }) {
  const openRunId = useRunsStore((s) => s.openRunId);
  const closeRun = useRunsStore((s) => s.closeRun);
  const { run, isLoading, error } = useRunPolling(openRunId);
  const [tab, setTab] = useState<'steps' | 'input' | 'output' | 'raw'>('steps');

  return (
    <SlideOver open={!!openRunId} onClose={closeRun} title={run?.pipelineId ?? 'Run'}>
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}
      {run && (
        <>
          <RunMetaHeader run={run} />
          <Tabs
            tabs={[
              { id: 'steps', label: 'Steps' },
              { id: 'input', label: 'Input' },
              { id: 'output', label: 'Output Data' },
              { id: 'raw', label: 'Raw JSON' },
            ]}
            activeTab={tab}
            onTabChange={setTab as any}
          />
          {tab === 'steps' && <StepsList steps={run.steps} failedStepId={run.error?.stepId} />}
          {tab === 'input' && <JsonView data={run.triggerInput ?? run.input} />}
          {tab === 'output' && (
            <ClickHousePreviewTable
              projectId={projectId}
              pipelineId={run.pipelineId}
              runId={run.runId}
              variant="drawer"
            />
          )}
          {tab === 'raw' && <JsonView data={run} />}
          {/* Re-run button deferred to v2 (requires Test drawer) */}
        </>
      )}
    </SlideOver>
  );
}
```

`StepsList` renders each step with an icon, name, duration, and expandable output. Failed step is expanded by default.

`ClickHousePreviewTable` is built in Phase 9 — for now, stub it as `<div>Loading…</div>` and revisit in Task 9.1.

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx apps/studio/src/components/pipelines/runs/useRunPolling.ts
git add apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx apps/studio/src/components/pipelines/runs/useRunPolling.ts
git commit -m "[ABLP-280] feat(studio): Run Detail drawer with steps/input/output/raw tabs

Polls /api/pipelines/runs/:runId every 2s until terminal. Embeds
ClickHousePreviewTable (stub; wired in Phase 9) for the Output Data
tab. Re-run button disabled when triggerInput truncated."
```

---

## Phase 8 — ~~UI: Test drawer + Re-run~~ DEFERRED to v2

Test drawer (TestDrawer.tsx, useTriggerTemplates.ts), PipelineCard Test button, PipelineConfigPage Test button, and RunDetailDrawer Re-run button are deferred to v2. These require the Phase 5 test route and trigger-templates route to be implemented first.

---

## Phase 9 — UI: Data tab

### Task 9.1: `PipelineDataPanel` + `ClickHousePreviewTable`

**Files:**

- Create: `apps/studio/src/components/pipelines/data/PipelineDataPanel.tsx`
- Create: `apps/studio/src/components/pipelines/data/ClickHousePreviewTable.tsx`
- Create: `apps/studio/src/components/pipelines/data/DataFilterRow.tsx`
- Create: `apps/studio/src/components/pipelines/data/useOutputSchema.ts`

- [ ] **Step 1: `useOutputSchema`**

```ts
import useSWR from 'swr';
import { swrFetcher } from '@/lib/swr-config';
export function useOutputSchema(pipelineId: string | null) {
  const { data, error, isLoading } = useSWR(
    pipelineId ? `/api/pipelines/${pipelineId}/output-schema` : null,
    swrFetcher,
  );
  return { schema: data?.data, error, isLoading };
}
```

- [ ] **Step 2: `ClickHousePreviewTable`**

Props:

```ts
interface Props {
  projectId: string;
  pipelineId: string;
  runId?: string; // pre-filter for Run Detail drawer usage
  sessionIdInput?: string;
  timeRange: { from: Date; to: Date };
  filters: Array<{ column: string; op: '=' | 'in' | 'contains'; value: unknown }>;
  variant?: 'full' | 'drawer';
}
```

Implementation:

- `useOutputSchema(pipelineId)` to render columns.
- POST to `/api/projects/{projectId}/pipeline-data/query` with the filter payload; render the result.
- Handle 6 error states from §5.7 of the spec — each maps to a toast + empty-state with a specific hint.
- Pagination: `[Load more]` appends pages; `limit=50` default.
- `runId` row value, when present, is a link that calls `useRunsStore().openRun(rowRunId)` — only in `variant='full'` (not recursive from the drawer itself).

- [ ] **Step 3: `DataFilterRow`**

UI for selecting `column`, `op`, `value`. Column dropdown source: `schema.columns.filter(c => c.filterable)`. Op dropdown depends on column type (String: `= | in | contains`, numeric/date: `= | in`).

- [ ] **Step 4: `PipelineDataPanel`**

Composes:

- Pipeline type + name selectors (fetching `/api/projects/{projectId}/pipeline-data/previewable-pipelines`).
- Session ID text input.
- Time range picker.
- List of `DataFilterRow`s with `+ Add filter` button.
- `[Query ▶]` and `[Export CSV]` buttons.
- `<ClickHousePreviewTable variant="full" ... />` with the current filter state.

For CSV export: `fetch('/api/projects/{projectId}/pipeline-data/export', {...}).then(r => r.blob())` → `URL.createObjectURL` → trigger download via a synthetic `<a>` click.

Empty states:

- No pipeline selected: "Pick a pipeline to preview its data."
- Zero rows: "No rows match your filters."
- No output table: "This pipeline has no store-results node — nothing to preview."

- [ ] **Step 5: Unstub the drawer preview**

In `RunDetailDrawer.tsx` replace the stubbed `ClickHousePreviewTable` with the real import. Pass `runId={run.runId}` and default `timeRange = { from: new Date(run.startedAt - 1h), to: new Date(run.completedAt ?? now + 1h) }`.

- [ ] **Step 6: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/data/ apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx
git add apps/studio/src/components/pipelines/data/ apps/studio/src/components/pipelines/runs/RunDetailDrawer.tsx
git commit -m "[ABLP-280] feat(studio): Data tab and ClickHousePreviewTable

Filter-driven ClickHouse query UI. Pipeline dropdown (builtin/
custom), session ID, time range, per-column filters (filterable
columns only). CSV export. Row click on runId opens Run Detail
drawer. Reused inside the Run Detail drawer pre-filtered to the
current run."
```

---

## Phase 10 — Health badges + PipelineConfigPage tabs

### Task 10.1: Health badge on pipeline cards

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineCard.tsx`
- Modify: `apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx`
- Modify: `apps/studio/src/components/pipelines/CustomPipelinesList.tsx`

- [ ] **Step 1: Extend `PipelineCard` props**

```ts
interface PipelineCardProps {
  // existing
  health?: { total: number; failed: number; successRate: number } | null;
}
```

Render a dot: green if `total > 0 && successRate > 0.95`, amber if `0.5–0.95`, red if `<0.5 || lastStatus === 'failed'`, gray if `total === 0`. Position top-right of the card.

- [ ] **Step 2: Fetch once per list, hand down to cards**

In each list component:

```tsx
const { data: healthData } = useSWR(
  projectId ? `/api/projects/${projectId}/pipeline-runs/health?window=24h` : null,
  swrFetcher,
);
const healthByPipeline = useMemo(() => {
  const map = new Map<string, any>();
  healthData?.data?.byPipeline?.forEach((p: any) => map.set(p.pipelineId, p));
  return map;
}, [healthData]);
// pass: health={healthByPipeline.get(pipeline.pipelineId)}
```

- [ ] **Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineCard.tsx apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx apps/studio/src/components/pipelines/CustomPipelinesList.tsx
git add apps/studio/src/components/pipelines/PipelineCard.tsx apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx apps/studio/src/components/pipelines/CustomPipelinesList.tsx
git commit -m "[ABLP-280] feat(studio): health badges on pipeline cards

Green/amber/red/gray dot per card driven by the health summary
endpoint. Single aggregation per list, not N+1."
```

### Task 10.2: `PipelineConfigPage` tabs

**Files:**

- Modify: `apps/studio/src/components/pipelines/PipelineConfigPage.tsx`

- [ ] **Step 1: Add `Config | Runs` tabs**

Wrap existing content in a `<Tabs>` component with two tabs. Runs tab renders:

```tsx
<RecentRunsPanel projectId={projectId} pipelineIdOverride={pipelineId} />
```

Test button deferred to v2 (Phase 8).

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write apps/studio/src/components/pipelines/PipelineConfigPage.tsx
git add apps/studio/src/components/pipelines/PipelineConfigPage.tsx
git commit -m "[ABLP-280] feat(studio): PipelineConfigPage gets Config | Runs tabs"
```

---

## Phase 11 — Stuck-run watchdog — **REMOVED 2026-04-15**

The stuck-run watchdog (`promoteStuckRuns` service + `runWatchdog` handler on `PipelineScheduler`) was deleted before landing. The `runWatchdog` handler was defined but never bootstrapped — no caller sent the initial invocation on the dedicated `__watchdog__` key, so the durable loop never started. Restate's own at-least-once delivery guarantees on the fire-and-forget workflow sends from `pipeline-trigger.service.ts` cover the failure mode this watchdog claimed to protect, and the 90-day `PipelineRunRecord` TTL remains as the final garbage-collection path for any orphaned runs.

If `status: 'running'` rows with no progress ever appear in production, the watchdog can be revived from git history (commit removing `packages/pipeline-engine/src/pipeline/services/stuck-run-watchdog.ts`) and wired into an explicit scheduler bootstrap path.

---

## Phase 12 — Docs + post-impl-sync

### Task 12.1: Update feature spec, HLD, and LLD

- [ ] **Step 1: Run `/post-impl-sync pipeline-observability`**

This skill updates `docs/features/pipeline-engine.md`, testing matrix, HLD, LLD status, and `agents.md` files.

- [ ] **Step 2: Add `docs/features/pipeline-observability.md` if none exists**

Use the template and fill in: problem (from ABLP-280), scope (from the design doc), status = ALPHA, test matrix (from Phase 6 E2E + integration tests).

- [ ] **Step 3: Append to `packages/pipeline-engine/agents.md`**

```markdown
## 2026-04-13 — Pipeline Observability

**Category**: architecture
**Learning**: PipelineTrigger.triggerManual was extended (not duplicated) to own manual-run creation. handleEvent and triggerManual both denormalize projectId onto PipelineRunRecord — one-line change, avoids a Mongo lookup on every Recent Runs query.
**Files**: src/pipeline/handlers/pipeline-trigger.service.ts, src/schemas/pipeline-run-record.schema.ts
**Impact**: Any new trigger path must continue to populate projectId + triggerInput.

**Category**: pattern
**Learning**: ClickHouse analytics tables gained run*id + pipeline_id columns with minmax indexes. All compute-* services and store-results write these fields. Query builder in Studio includes them in every WHERE clause.
**Files**: packages/database/clickhouse/migrations/2026-04-13-add-run-id-to-analytics-tables.sql, packages/pipeline-engine/src/pipeline/services/compute-\_.service.ts
**Impact**: New ClickHouse output tables must include run_id + pipeline_id + tenant_id + project_id columns.
```

- [ ] **Step 4: Append to `apps/studio/agents.md`**

```markdown
## 2026-04-13 — Pipeline Observability UI

**Category**: architecture
**Learning**: Pipeline runs and data preview live under four tabs on PipelinesListPage (Built-in, Custom, Recent Runs, Data). Run Detail is a drawer. Data preview is filter-driven — no free-form SQL — gated by the pipeline's declared outputSchema.columns.filterable flag. Test drawer + Re-run deferred to v2.
**Files**: apps/studio/src/components/pipelines/runs/, apps/studio/src/components/pipelines/data/
**Impact**: New surfaces should reuse RecentRunsPanel/ClickHousePreviewTable rather than duplicate the filter + table logic.

**Category**: pattern
**Learning**: ClickHouse queries use parameter binding via @clickhouse/client query_params. Never string-concatenate user filters. Column allowlist checked against schema.columns.filterable. Table name server-resolved from pipelineId — never from request body.
**Files**: apps/studio/src/lib/pipeline-data/query-builder.ts
**Impact**: Any expansion of the Data tab (new operators, free-form SQL) must go through the same allowlist + parameter-binding path.
```

- [ ] **Step 5: Commit docs**

```bash
git add docs/ apps/studio/agents.md packages/pipeline-engine/agents.md
git commit -m "[ABLP-280] docs: post-impl-sync for pipeline observability"
```

---

## Final Checks

Before merging:

- [ ] `pnpm build` succeeds across the workspace.
- [ ] `pnpm test:report` shows zero failures in affected packages.
- [ ] `./tools/run-semgrep.sh` clean on changed files (security scan).
- [ ] All commits have `[ABLP-280]` prefix.
- [ ] No commit exceeds 40 non-doc files or 3 packages.
- [ ] No commit has >30% deletion ratio on a `feat()` type.
- [ ] No `vi.mock()` of `@agent-platform/*` or `@abl/*` in any test.
- [ ] No `console.log`/`console.error` in server code.
- [ ] No `readFileSync`/`writeFileSync` in server code.
- [ ] Add ticket comment on ABLP-280 with the commit SHAs + short summary.

---

## Self-Review Notes

- **Spec coverage:** Three of the four ABLP-280 acceptance criteria shipped in v1 (logs → Phase 4+7, preview → Phase 6+9, health → Phase 4+10). Test → Phase 5+8 deferred to v2.
- **Placeholder scan:** no `TBD`/`TODO`/`fill in details`. Where a task requires reading the repo for details (e.g., existing rate-limit helper naming), the step explicitly instructs which file to read.
- **Type consistency:** `RunSummary`, `ColumnMeta`, `OutputSchema`, `BuildQueryArgs` defined once and referenced consistently across tasks. `pipelineKind` is `'builtin' | 'custom'` everywhere.
- **Open items the engineer will encounter:** (a) if `requireProjectAccess` or `requirePermission` helpers in `apps/studio/src/lib/auth.ts` have different names, adapt — a Step explicitly flags this. (b) Existing `pipeline-trigger.test.ts` may pass `triggerId` implicitly; that step covers updating it.
