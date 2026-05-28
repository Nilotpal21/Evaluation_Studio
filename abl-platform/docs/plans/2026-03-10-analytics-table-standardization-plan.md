# Analytics Table Standardization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Standardize all ClickHouse analytics tables with pipeline provenance columns, fill missing common columns, create dedicated tables for goal-completion and toxicity, and plumb `pipelineId`/`pipelineType` through all compute services.

**Architecture:** Add `pipeline_id` + `pipeline_type` to all 13 existing analytics tables via ALTER TABLE migrations. Create 3 new tables (`goal_completions`, `toxicity_evaluations`, `message_toxicity`). Add `pipelineId` + `pipelineType` to `PipelineStepContext`, thread through `ActivityRouterInput` → `PipelineStepContext`, and update every compute service's ClickHouse write to include them.

**Tech Stack:** ClickHouse (ALTER TABLE DDL), TypeScript, Restate SDK, Vitest

**Design doc:** `docs/plans/2026-03-10-analytics-table-standardization-design.md`

---

## Phase 1: Schema Migration

### Task 1: Add `pipeline_id` and `pipeline_type` to all existing analytics tables

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (append to `ANALYTICS_MIGRATIONS` array)

**Step 1: Add migration statements**

Append these to the `ANALYTICS_MIGRATIONS` array (after the existing entries, before the closing `]`):

```typescript
  // ── Pipeline provenance columns (2026-03-10) ────────────────────────────
  // Add pipeline_id + pipeline_type to all analytics tables
  `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.quality_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.quality_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_outcomes ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_outcomes ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.knowledge_gap_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.knowledge_gap_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.context_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.context_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
```

**Step 2: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git add packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "[ABLP-2] feat(schema): add pipeline_id and pipeline_type to all analytics tables"
```

---

### Task 2: Add missing common columns (`project_id`, `channel`)

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (append to `ANALYTICS_MIGRATIONS` array)

**Step 1: Add migration statements**

Append these to the `ANALYTICS_MIGRATIONS` array (after the pipeline provenance entries from Task 1):

```typescript
  // ── Missing common columns (2026-03-10) ─────────────────────────────────
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS project_id String DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,
```

**Step 2: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git add packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "[ABLP-2] feat(schema): add missing project_id and channel columns"
```

---

### Task 3: Create `goal_completions` table

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (add to `ANALYTICS_TABLE_DDL` array)

**Step 1: Add table DDL**

Add a new entry to the `ANALYTICS_TABLE_DDL` array:

```typescript
  {
    name: 'goal_completions',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.goal_completions (
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    overall_score         Float64,
    goal_detected         String DEFAULT '',
    goal_achieved         UInt8 DEFAULT 0,
    summary               String DEFAULT '',
    criteria              String DEFAULT '{}',

    model_id              LowCardinality(String),
    config_version        UInt32 DEFAULT 0,
    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT '',
    source                LowCardinality(String) DEFAULT 'batch',
    processing_ms         UInt32 DEFAULT 0,
    input_tokens          UInt32 DEFAULT 0,
    output_tokens         UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id, processed_at)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
```

Also add `'goal_completions'` to the `ANALYTICS_TABLES` array if one exists.

**Step 2: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git add packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "[ABLP-2] feat(schema): create goal_completions ClickHouse table"
```

---

### Task 4: Create `toxicity_evaluations` and `message_toxicity` tables

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` (add to `ANALYTICS_TABLE_DDL` array)

**Step 1: Add table DDLs**

Add two entries to the `ANALYTICS_TABLE_DDL` array:

```typescript
  {
    name: 'toxicity_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.toxicity_evaluations (
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    avg_toxicity          Float64,
    max_toxicity          Float64,
    flagged               UInt8 DEFAULT 0,
    status                LowCardinality(String) DEFAULT 'pass',
    threshold             Float64 DEFAULT 0.7,
    message_count         UInt16 DEFAULT 0,

    model_id              LowCardinality(String),
    config_version        UInt32 DEFAULT 0,
    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT '',
    source                LowCardinality(String) DEFAULT 'batch',
    processing_ms         UInt32 DEFAULT 0,
    input_tokens          UInt32 DEFAULT 0,
    output_tokens         UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id, processed_at)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'message_toxicity',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.message_toxicity (
    tenant_id             String,
    project_id            String,
    session_id            String,
    message_id            String,
    message_at            DateTime64(3),
    processed_at          DateTime64(3),
    role                  LowCardinality(String),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    toxicity_score        Float64,
    status                LowCardinality(String) DEFAULT 'pass',
    content_length        UInt32 DEFAULT 0,

    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL toDateTime(message_at) + INTERVAL 730 DAY DELETE
`,
  },
```

**Step 2: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git add packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
git commit -m "[ABLP-2] feat(schema): create toxicity_evaluations and message_toxicity tables"
```

---

### Task 5: Build and verify schema migration

**Step 1: Build**

```bash
pnpm --filter @agent-platform/pipeline-engine build
```

Expected: clean build, no errors.

**Step 2: Verify tables are created**

Restart the runtime (or the pipeline engine server) so `initAnalyticsTables()` runs. Then verify in ClickHouse:

```bash
# Check new tables exist
docker exec -i <clickhouse-container> clickhouse-client --query "SHOW TABLES FROM abl_platform LIKE '%toxicity%'"
docker exec -i <clickhouse-container> clickhouse-client --query "SHOW TABLES FROM abl_platform LIKE '%goal%'"

# Check new columns exist on existing tables
docker exec -i <clickhouse-container> clickhouse-client --query "DESCRIBE TABLE abl_platform.conversation_sentiment" | grep pipeline
docker exec -i <clickhouse-container> clickhouse-client --query "DESCRIBE TABLE abl_platform.message_sentiment" | grep project_id
```

---

## Phase 2: Types & Plumbing

### Task 6: Add `pipelineId` and `pipelineType` to `PipelineStepContext`

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/types.ts` (add fields to `PipelineStepContext`)

**Step 1: Add fields to `PipelineStepContext` interface**

In `packages/pipeline-engine/src/pipeline/types.ts`, find the `PipelineStepContext` interface and add after `triggerId`:

```typescript
  /** ID of the pipeline definition that owns this run */
  pipelineId?: string;

  /** Whether this is a 'builtin' or 'custom' pipeline */
  pipelineType?: 'builtin' | 'custom';
```

**Step 2: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/types.ts
git add packages/pipeline-engine/src/pipeline/types.ts
git commit -m "[ABLP-2] feat(types): add pipelineId and pipelineType to PipelineStepContext"
```

---

### Task 7: Thread `pipelineId`/`pipelineType` through `ActivityRouterInput` and step context

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (add to `ActivityRouterInput`, pass to `stepContext`)
- Modify: `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts` (pass when calling `activityRouter.execute`)

**Step 1: Add to `ActivityRouterInput`**

In `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`, find the `ActivityRouterInput` interface (line ~49) and add:

```typescript
  pipelineId?: string;
  pipelineType?: 'builtin' | 'custom';
```

**Step 2: Pass to `stepContext`**

In the same file, find where `stepContext` is built (line ~181). Add after `pipelineInput`:

```typescript
        pipelineId: input.pipelineId,
        pipelineType: input.pipelineType,
```

**Step 3: Thread from `pipeline-run.workflow.ts`**

In `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`, find every call to `ctx.serviceClient(activityRouter).execute({...})`. There are multiple call sites (linear steps, parallel fan-out, graph walker). Add to each:

```typescript
  pipelineId: pipelineDefinition._id,
  pipelineType: pipelineDefinition.tenantId === '__platform__' ? 'builtin' : 'custom',
```

Search for all occurrences of `activityRouter).execute(` and add the two fields to each call's input object.

Also check the `executeNodeGroup` helper in activity-router — it recursively calls `activityRouter.execute` for child nodes. Ensure `pipelineId`/`pipelineType` are forwarded from the parent input.

**Step 4: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts
git add packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts
git commit -m "[ABLP-2] feat(core): thread pipelineId/pipelineType through activity router"
```

---

## Phase 3: Compute Service Updates

### Task 8: Update `compute-sentiment` to write provenance columns

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts`

**Step 1: Write the failing test**

In `packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts`, add a test:

```typescript
test('includes pipeline_id and pipeline_type in ClickHouse rows', async () => {
  mockChat.mockResolvedValue({
    content: JSON.stringify({
      scores: [
        {
          index: 0,
          sentiment_score: 0.5,
          sentiment_label: 'positive',
          frustration_detected: false,
          frustration_signals: [],
        },
      ],
    }),
    inputTokens: 100,
    outputTokens: 50,
    model: 'claude-haiku-4-5',
  });

  const result = await execute(
    ctx(),
    makeInput({
      pipelineId: 'test-pipeline-123',
      pipelineType: 'custom',
    }),
  );

  expect(result.status).toBe('success');

  // Check message_sentiment row
  const msgInsert = mockInsert.mock.calls[0][0];
  expect(msgInsert.values[0].pipeline_id).toBe('test-pipeline-123');
  expect(msgInsert.values[0].pipeline_type).toBe('custom');

  // Check conversation_sentiment row
  const convInsert = mockInsert.mock.calls[1][0];
  expect(convInsert.values[0].pipeline_id).toBe('test-pipeline-123');
  expect(convInsert.values[0].pipeline_type).toBe('custom');
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- --testPathPattern compute-sentiment
```

Expected: FAIL — `pipeline_id` and `pipeline_type` not present in row objects.

**Step 3: Update the service**

In `compute-sentiment.service.ts`, find the `MessageSentimentRow` and `ConversationSentimentRow` interfaces. Add to both:

```typescript
pipeline_id: string;
pipeline_type: string;
```

Then find where rows are built. Add to each row object:

```typescript
  pipeline_id: input.pipelineId ?? '',
  pipeline_type: input.pipelineType ?? '',
```

Also add `project_id` to `MessageSentimentRow` if missing (this table was missing it):

```typescript
  project_id: input.projectId ?? '',
```

**Step 4: Run test to verify it passes**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- --testPathPattern compute-sentiment
```

Expected: PASS

**Step 5: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts
git add packages/pipeline-engine/src/pipeline/services/compute-sentiment.service.ts packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts
git commit -m "[ABLP-2] feat(sentiment): add pipeline provenance and project_id to ClickHouse writes"
```

---

### Task 9: Update `compute-quality` to write provenance columns

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-quality.test.ts`

**Step 1: Write the failing test**

Add a test in `compute-quality.test.ts` asserting `pipeline_id` and `pipeline_type` appear in both `quality_evaluations` and `conversation_outcomes` ClickHouse inserts.

**Step 2: Run test — expect FAIL**

**Step 3: Update the service**

Add `pipeline_id` and `pipeline_type` to `QualityEvaluationRow` and `ConversationOutcomeRow` interfaces and to the row-building code:

```typescript
  pipeline_id: input.pipelineId ?? '',
  pipeline_type: input.pipelineType ?? '',
```

**Step 4: Run test — expect PASS**

**Step 5: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts packages/pipeline-engine/src/__tests__/compute-quality.test.ts
git add packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts packages/pipeline-engine/src/__tests__/compute-quality.test.ts
git commit -m "[ABLP-2] feat(quality): add pipeline provenance to ClickHouse writes"
```

---

### Task 10: Update `compute-intent` to write provenance columns

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-intent.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-intent.test.ts`

Same pattern as Task 8. Add `pipeline_id` and `pipeline_type` to the `IntentClassificationRow` interface and row-building code.

**Commit message:** `[ABLP-2] feat(intent): add pipeline provenance to ClickHouse writes`

---

### Task 11: Update `compute-mentions` to write provenance columns + `channel`

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-mentions.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-mentions.test.ts`

Same pattern. Add `pipeline_id`, `pipeline_type`, AND `channel` (this table was missing it) to the mention row interface and row-building code.

**Commit message:** `[ABLP-2] feat(mentions): add pipeline provenance and channel to ClickHouse writes`

---

### Task 12: Update `conversation-analyzer` to write provenance columns

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/conversation-analyzer.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/conversation-analyzer.test.ts`

This service handles 4 evaluation types (hallucination, knowledge-gap, guardrail, context). Each writes to its own table. Add `pipeline_id` and `pipeline_type` to the shared row-building logic so all 4 tables get provenance.

**Commit message:** `[ABLP-2] feat(llm-eval): add pipeline provenance to all evaluation tables`

---

### Task 13: Update `compute-statistical` to write provenance columns + `channel`

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-statistical.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-statistical.test.ts`

This service handles 3 types (friction, anomaly, drift). Add `pipeline_id`, `pipeline_type` to all three. Also add `channel` to anomaly and drift rows (these tables were missing it).

**Commit message:** `[ABLP-2] feat(statistical): add pipeline provenance and channel to ClickHouse writes`

---

### Task 14: Migrate `compute-toxicity` to write to dedicated tables

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts`
- Modify: `packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts`

**Step 1: Write the failing test**

Add test asserting `mockInsert` is called twice (once for `abl_platform.toxicity_evaluations`, once for `abl_platform.message_toxicity`) instead of returning `InsightResult`:

```typescript
test('writes to dedicated toxicity tables instead of InsightResult', async () => {
  // ... mock LLM response with toxicity scores ...

  const result = await execute(
    ctx(),
    makeInput({
      pipelineId: 'builtin:toxicity',
      pipelineType: 'builtin',
    }),
  );

  expect(result.status).toBe('success');

  // Should NOT return InsightResult format
  expect(result.data.insightType).toBeUndefined();

  // Should write to dedicated tables
  expect(mockInsert).toHaveBeenCalledTimes(2);

  const sessionInsert = mockInsert.mock.calls[0][0];
  expect(sessionInsert.table).toBe('abl_platform.toxicity_evaluations');
  expect(sessionInsert.values[0].pipeline_id).toBe('builtin:toxicity');

  const msgInsert = mockInsert.mock.calls[1][0];
  expect(msgInsert.table).toBe('abl_platform.message_toxicity');
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Update the service**

Replace the `InsightResult` return with direct ClickHouse writes, following the same pattern as `compute-sentiment`:

```typescript
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

const TOXICITY_TABLE = 'abl_platform.toxicity_evaluations';
const MESSAGE_TOXICITY_TABLE = 'abl_platform.message_toxicity';
```

Build `ToxicityEvaluationRow` (session aggregate) and `MessageToxicityRow` (per-message) interfaces. Write both with `client.insert({ table, values, format: 'JSONEachRow' })`.

The return `data` should contain summary fields (avgToxicity, maxToxicity, flagged, messageCount) but NOT `InsightResult` format.

**Step 4: Run test — expect PASS**

**Step 5: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts
git add packages/pipeline-engine/src/pipeline/services/compute-toxicity.service.ts packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts
git commit -m "[ABLP-2] refactor(toxicity): migrate from InsightResult to dedicated ClickHouse tables"
```

---

### Task 15: Create `compute-goal-completion` service

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/compute-goal-completion.service.ts`
- Create: `packages/pipeline-engine/src/__tests__/compute-goal-completion.test.ts`
- Modify: `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts` (add to dispatch table)
- Modify: `packages/pipeline-engine/src/pipeline/activity-metadata.ts` (add metadata entry)
- Modify: `packages/pipeline-engine/src/index.ts` (export)

**Step 1: Write the failing test**

Create `packages/pipeline-engine/src/__tests__/compute-goal-completion.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

const mockChat = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  createPipelineLLMClient: () => Promise.resolve({ chat: mockChat }),
}));

const mockInsert = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ insert: mockInsert }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { computeGoalCompletionService } =
  await import('../pipeline/services/compute-goal-completion.service.js');

function ctx(): any {
  return { run: async (_label: string, fn: () => any) => fn() };
}

function getExecute(svc: any) {
  return (svc as any).service.execute;
}

const execute = getExecute(computeGoalCompletionService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      systemPrompt: 'Evaluate goal completion.',
      criteria: ['issue_diagnosed', 'solution_provided'],
    },
    previousSteps: {
      'read-conversation': {
        status: 'success',
        data: {
          messages: [
            {
              messageId: 'msg-1',
              role: 'user',
              content: 'My Mac overheats',
              timestamp: '2025-01-01T00:00:00Z',
              channel: 'web_chat',
            },
            {
              messageId: 'msg-2',
              role: 'assistant',
              content: 'Try quitting Docker',
              timestamp: '2025-01-01T00:01:00Z',
              channel: 'web_chat',
            },
          ],
          metadata: {
            agentName: 'SupportBot',
            channel: 'web_chat',
            messageCount: 2,
            durationMs: 60000,
          },
        },
      },
    },
    pipelineInput: { tenantId: 'acme-corp', projectId: 'support-bot', sessionId: 'sess-001' },
    ...overrides,
  };
}

describe('ComputeGoalCompletion service', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('writes goal completion to ClickHouse', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        criteria: {
          issue_diagnosed: { score: 1, evidence: 'Identified Docker CPU issue' },
          solution_provided: { score: 0.9, evidence: 'Suggested quitting Docker' },
        },
        overall_goal_completion: 0.95,
        summary: 'Issue resolved successfully',
      }),
      inputTokens: 300,
      outputTokens: 150,
      model: 'claude-haiku-4-5',
    });

    const result = await execute(
      ctx(),
      makeInput({
        pipelineId: 'custom-pipeline-1',
        pipelineType: 'custom',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.overallScore).toBe(0.95);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insert = mockInsert.mock.calls[0][0];
    expect(insert.table).toBe('abl_platform.goal_completions');
    expect(insert.values[0].overall_score).toBe(0.95);
    expect(insert.values[0].pipeline_id).toBe('custom-pipeline-1');
    expect(insert.values[0].pipeline_type).toBe('custom');
    expect(insert.values[0].goal_achieved).toBe(1);
  });

  test('handles LLM parse failure gracefully', async () => {
    mockChat.mockResolvedValue({
      content: 'Not JSON',
      inputTokens: 300,
      outputTokens: 50,
      model: 'claude-haiku-4-5',
    });

    const result = await execute(ctx(), makeInput());
    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('parse');
  });
});
```

**Step 2: Run test — expect FAIL (module not found)**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- --testPathPattern compute-goal-completion
```

**Step 3: Create the service**

Create `packages/pipeline-engine/src/pipeline/services/compute-goal-completion.service.ts`:

Follow the same structure as `compute-quality.service.ts`:

- Import `restate`, `getClickHouseClient`, `createPipelineLLMClient`, `createLogger`
- Define `GoalCompletionRow` interface matching the table schema
- Define `GoalCompletionLLMResponse` for the expected LLM JSON shape
- Extract conversation from `previousSteps['read-conversation']` (or via `resolveContextInput`)
- Build system + user prompt from `input.config.systemPrompt` and `input.config.criteria`
- Call LLM with `responseFormat: 'json'`
- Parse response, strip markdown fences if needed
- Build row with all fields including `pipeline_id`, `pipeline_type`
- Insert into `abl_platform.goal_completions`
- Return `StepOutput` with summary data

```typescript
const GOAL_COMPLETION_TABLE = 'abl_platform.goal_completions';

interface GoalCompletionRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  agent_name: string;
  channel: string;
  overall_score: number;
  goal_detected: string;
  goal_achieved: number;
  summary: string;
  criteria: string; // JSON
  model_id: string;
  config_version: number;
  pipeline_id: string;
  pipeline_type: string;
  source: string;
  processing_ms: number;
  input_tokens: number;
  output_tokens: number;
}
```

**Step 4: Register in activity-router**

In `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`:

- Import the new service
- Add to the dispatch table: `'compute-goal-completion': (computeGoalCompletionService as any).service.execute`

**Step 5: Add to activity-metadata**

In `packages/pipeline-engine/src/pipeline/activity-metadata.ts`, add an entry for `compute-goal-completion` with its config schema (systemPrompt, criteria, model).

**Step 6: Export from index**

In `packages/pipeline-engine/src/index.ts`, add:

```typescript
export { computeGoalCompletionService } from './pipeline/services/compute-goal-completion.service.js';
```

**Step 7: Run test — expect PASS**

```bash
pnpm --filter @agent-platform/pipeline-engine test -- --testPathPattern compute-goal-completion
```

**Step 8: Commit**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-goal-completion.service.ts packages/pipeline-engine/src/__tests__/compute-goal-completion.test.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/activity-metadata.ts packages/pipeline-engine/src/index.ts
git add packages/pipeline-engine/src/pipeline/services/compute-goal-completion.service.ts packages/pipeline-engine/src/__tests__/compute-goal-completion.test.ts packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts packages/pipeline-engine/src/pipeline/activity-metadata.ts packages/pipeline-engine/src/index.ts
git commit -m "[ABLP-2] feat(goal-completion): create compute-goal-completion service with ClickHouse persistence"
```

---

## Phase 4: Build & Test

### Task 16: Full build and test

**Step 1: Build pipeline-engine**

```bash
pnpm --filter @agent-platform/pipeline-engine build
```

Expected: clean build.

**Step 2: Run all pipeline-engine tests**

```bash
pnpm --filter @agent-platform/pipeline-engine test
```

Expected: all new tests pass, no regressions in existing tests.

**Step 3: Fix any issues and commit**

---

## Phase 5: End-to-End Verification

### Task 17: Verify with a live conversation

**Step 1: Restart the pipeline engine**

Restart so `initAnalyticsTables()` runs the new DDL and migrations.

**Step 2: End a test conversation** for `proj-apple-care` to trigger the custom pipeline.

**Step 3: Verify in ClickHouse**

```sql
-- Check provenance columns are populated
SELECT pipeline_id, pipeline_type, overall_score
FROM abl_platform.quality_evaluations
WHERE session_id = '<test-session-id>'
ORDER BY processed_at DESC LIMIT 5;

SELECT pipeline_id, pipeline_type, avg_sentiment
FROM abl_platform.conversation_sentiment
WHERE session_id = '<test-session-id>'
ORDER BY processed_at DESC LIMIT 5;

-- Check goal_completions table has data (once pipeline uses compute-goal-completion)
SELECT * FROM abl_platform.goal_completions
WHERE session_id = '<test-session-id>'
ORDER BY processed_at DESC LIMIT 5;

-- Check no new rows in insight_results (toxicity should go to dedicated table)
SELECT count() FROM abl_platform.insight_results
WHERE evaluated_at > now() - INTERVAL 1 HOUR;
```

**Step 4: Update custom pipeline definition**

Replace `eval-goal-completion` node (currently type `call-llm`) with type `compute-goal-completion` in the pipeline definition, so goal completion results go to ClickHouse.

---

## Summary

| Task | What                                                           | Phase        |
| ---- | -------------------------------------------------------------- | ------------ |
| 1    | ALTER TABLE: add `pipeline_id`/`pipeline_type` to 13 tables    | Schema       |
| 2    | ALTER TABLE: add missing `project_id`/`channel`                | Schema       |
| 3    | CREATE TABLE: `goal_completions`                               | Schema       |
| 4    | CREATE TABLE: `toxicity_evaluations` + `message_toxicity`      | Schema       |
| 5    | Build + verify schema                                          | Schema       |
| 6    | Add fields to `PipelineStepContext`                            | Types        |
| 7    | Thread through `ActivityRouterInput` → `pipeline-run.workflow` | Plumbing     |
| 8    | Update `compute-sentiment` (TDD)                               | Services     |
| 9    | Update `compute-quality` (TDD)                                 | Services     |
| 10   | Update `compute-intent` (TDD)                                  | Services     |
| 11   | Update `compute-mentions` + channel (TDD)                      | Services     |
| 12   | Update `conversation-analyzer` (TDD)                           | Services     |
| 13   | Update `compute-statistical` + channel (TDD)                   | Services     |
| 14   | Migrate `compute-toxicity` to dedicated tables (TDD)           | Services     |
| 15   | Create `compute-goal-completion` service (TDD)                 | Services     |
| 16   | Full build + test                                              | Verification |
| 17   | Live end-to-end verification                                   | Verification |
