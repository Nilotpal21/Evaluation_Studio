# Conversation Outcome Classification — Design

> Extends the quality evaluation pipeline to classify conversation outcomes into 5 categories, enabling containment rate metrics and ~15 blocked customer queries.

---

## Problem

The platform collects rich trace data (22 event types, ClickHouse storage, OTEL metrics) but cannot answer the #1 customer question: **"What's our containment rate?"** A simple heuristic (`outcome-classification.ts`) exists that maps `session.status + hasEscalation` to `contained | escalated | abandoned`, but it cannot distinguish between sessions that truly resolved the customer's issue and those where the bot said goodbye without solving anything.

This single gap blocks ~15 queries across C1 and C2 categories (see `metrics/customer-queries-by-data-source.md`), including containment rate (#1), per-agent containment (#25), per-intent containment (#117-119), FCR trends (#11, #16), and drop-off analysis (#34).

---

## Approach: Extend Quality Pipeline (Hybrid Classification)

Rather than creating a standalone pipeline, outcome classification is added to the existing **quality evaluation pipeline**. This saves an LLM call per session — the quality prompt is extended to also produce outcome classification in the same response.

### Why Not Standalone?

- Quality pipeline already triggers on `session.ended`, reads conversation, and calls LLM
- Outcome and quality are complementary assessments of the same conversation
- Single LLM call produces both quality scores and outcome classification

### Hybrid Logic

The classification uses a **heuristic fast-path** for clear-cut cases and **LLM evaluation** for ambiguous ones:

1. **Escalated** (heuristic): Session has escalation traces OR `status = 'escalated'` → `escalated`
2. **Abandoned** (heuristic): Session ended with `timeout` / `user_exit` OR `status = 'abandoned'` → `abandoned`
3. **Completed sessions** (LLM): Send transcript to LLM for goal-achievement classification → `contained_resolved` | `contained_partial` | `contained_unresolved`

---

## Outcome Categories (5)

| Outcome                | Definition                                                  | Classification Method          |
| ---------------------- | ----------------------------------------------------------- | ------------------------------ |
| `contained_resolved`   | Customer's goal was fully achieved by the AI agent          | LLM evaluation                 |
| `contained_partial`    | Some progress was made but issue not fully resolved         | LLM evaluation                 |
| `contained_unresolved` | Conversation completed but customer's problem not addressed | LLM evaluation                 |
| `escalated`            | Conversation was handed off to a human agent                | Heuristic (trace events)       |
| `abandoned`            | Customer left or session timed out before resolution        | Heuristic (session end reason) |

---

## Modified Quality Pipeline

### Execution Flow

```
session.ended (Kafka: abl.session.ended)
    │
    ▼
Pipeline Trigger Service (existing)
    │
    ▼
Quality Pipeline Definition (existing, unchanged)
    ├── Step 1: read-conversation (existing, unchanged)
    │   → Returns: messages[], traces[], metadata{}
    │
    └── Step 2: compute-quality (EXTENDED)
            │
            ├── Heuristic fast-path:
            │   Has escalation traces? → outcome = 'escalated'
            │   End reason = timeout/user_exit? → outcome = 'abandoned'
            │   → Write to conversation_outcomes (method='heuristic')
            │   → Continue to LLM for quality scores only
            │
            └── LLM evaluation (completed sessions):
                → Extended prompt: quality dimensions + outcome classification
                → Parse combined JSON response
                → Write to quality_evaluations (existing, unchanged)
                → Write to conversation_outcomes (method='llm_evaluated')
                → Update session.outcome in MongoDB
```

### Extended LLM Prompt (addition to existing quality prompt)

```
## Outcome Classification

Based on the full conversation, classify the session outcome:

- "contained_resolved": The customer's goal was fully achieved by the AI agent.
  The customer got what they needed without human intervention.
- "contained_partial": Some progress was made toward the customer's goal, but the
  issue was not fully resolved. The customer may need to follow up.
- "contained_unresolved": The conversation completed (no escalation, no timeout)
  but the customer's actual problem was not addressed. The agent may have
  misunderstood the request or lacked the capability.

Provide:
- outcome: one of "contained_resolved", "contained_partial", "contained_unresolved"
- goal_detected: what was the customer trying to accomplish (1 sentence)
- goal_achieved: true if the goal was fully met, false otherwise
- outcome_reasoning: brief explanation of your classification (1-2 sentences)
```

### Fallback Behavior

| Scenario                             | Behavior                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Quality pipeline disabled            | Heuristic classifier runs independently, writes coarser 3-category outcome (contained/escalated/abandoned) |
| Quality pipeline sampled (e.g., 20%) | 20% get LLM-evaluated 5-category outcomes; 80% get heuristic 3-category outcomes                           |
| LLM returns invalid outcome          | Validate against enum; fall back to heuristic, log warning                                                 |
| LLM call fails after retries         | Write heuristic outcome with `outcome_method='heuristic_fallback'`                                         |

---

## ClickHouse Schema

### conversation_outcomes Table

```sql
CREATE TABLE IF NOT EXISTS abl_platform.conversation_outcomes (
  tenant_id          LowCardinality(String),
  project_id         LowCardinality(String),
  session_id         String,
  session_started_at DateTime64(3),
  processed_at       DateTime64(3),

  -- Core classification
  outcome            LowCardinality(String),   -- contained_resolved | contained_partial | contained_unresolved | escalated | abandoned
  outcome_method     LowCardinality(String),   -- 'heuristic' | 'llm_evaluated' | 'heuristic_fallback'
  confidence         Float32,

  -- LLM-evaluated fields (null for heuristic-classified)
  goal_detected      Nullable(String),
  goal_achieved      Nullable(UInt8),
  outcome_reasoning  Nullable(String),

  -- Session context (denormalized for fast queries without JOINs)
  agent_name         LowCardinality(String),
  channel            LowCardinality(String),
  message_count      UInt16,
  handoff_count      UInt8,
  escalation_reason  Nullable(String),
  duration_ms        UInt32,

  -- Processing metadata
  model_id           LowCardinality(String),
  config_version     LowCardinality(String),
  processing_ms      UInt32

) ENGINE = ReplacingMergeTree(processed_at)
  PARTITION BY (tenant_id, toYYYYMM(session_started_at))
  ORDER BY (tenant_id, project_id, session_id)
  TTL session_started_at + INTERVAL 730 DAY DELETE
```

### Daily Materialized View

Pre-aggregated for containment rate dashboards:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_outcomes
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(day))
ORDER BY (tenant_id, project_id, day, agent_name, channel, outcome)
AS SELECT
  tenant_id,
  project_id,
  toDate(session_started_at) AS day,
  agent_name,
  channel,
  outcome,
  count()              AS session_count,
  avg(duration_ms)     AS avg_duration_ms,
  avg(message_count)   AS avg_message_count
FROM abl_platform.conversation_outcomes
GROUP BY tenant_id, project_id, day, agent_name, channel, outcome
```

---

## One Row Per Session

- `quality_evaluations`: 1 row per session — quality dimension scores as columns (helpfulness, accuracy, etc.)
- `conversation_outcomes`: 1 row per session — single categorical outcome + supporting fields
- `ReplacingMergeTree(processed_at)` ensures idempotent upserts on re-evaluation or backfill

---

## Downstream Query Unlocks

### Direct Queries on conversation_outcomes

| Query # | Query                                           | SQL Pattern                                                 |
| ------- | ----------------------------------------------- | ----------------------------------------------------------- |
| 1       | "What's our containment rate?"                  | `countIf(outcome LIKE 'contained%') / count()`              |
| 11      | "Containment trend over 90 days"                | `SELECT day, outcome, session_count FROM mv_daily_outcomes` |
| 25      | "Which agent has lowest containment?"           | `GROUP BY agent_name` on outcomes table                     |
| 58      | "Tasks completed end-to-end without human help" | `WHERE outcome = 'contained_resolved'`                      |
| 164     | "How many conversations yesterday?"             | `count() WHERE toDate(session_started_at) = yesterday()`    |

### Cross-Pipeline Joins (via shared session_id)

| Query # | Query                                        | Join Pattern                                                       |
| ------- | -------------------------------------------- | ------------------------------------------------------------------ |
| 117     | "Plan change requests completed by AI"       | `outcomes JOIN intent_classifications`                             |
| 118     | "Coverage inquiries resulting in escalation" | `outcomes JOIN intent_classifications WHERE outcome = 'escalated'` |
| 119     | "Billing requests: AI vs human resolution"   | `outcomes JOIN intent_classifications WHERE intent = 'billing'`    |
| 34      | "Drop-off by flow step"                      | `outcomes(abandoned) JOIN traces(last flow_step)`                  |
| 96      | "Intents with declining deflection"          | `outcomes JOIN intent_classifications, time-series`                |

### Example: Per-Intent Containment Rate

```sql
SELECT
  i.intent_label,
  countIf(o.outcome = 'contained_resolved') AS resolved,
  countIf(o.outcome LIKE 'contained%')      AS total_contained,
  count()                                    AS total,
  round(countIf(o.outcome LIKE 'contained%') / count(), 3) AS containment_rate
FROM abl_platform.conversation_outcomes o
JOIN abl_platform.intent_classifications i
  USING (tenant_id, session_id)
WHERE o.tenant_id = {tenantId:String}
  AND o.session_started_at >= now() - INTERVAL 30 DAY
GROUP BY i.intent_label
ORDER BY containment_rate ASC
```

---

## Edge Cases

| Scenario                                             | Handling                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Ghost sessions (0 messages)                          | Skip classification — `endSession()` deletes ghost sessions before emitting event                |
| System-only messages (no user messages)              | Classify as `abandoned`                                                                          |
| Multiple escalation + de-escalation (returned to AI) | Check final state: if AI resolved after return → `contained_*`; if still escalated → `escalated` |
| Very long conversations (>100 messages)              | Truncate to first 10 + last 20 messages for LLM prompt; note truncation                          |
| MongoDB update fails                                 | Non-critical — ClickHouse is source of truth for analytics; log error, don't fail pipeline       |

---

## Backfill

For historical sessions without outcome classification:

- Trigger: Manual pipeline execution via API
- Scope: Sessions where `outcome IS NULL AND status IN ('ended', 'completed', 'escalated', 'abandoned')`
- Rate limiting: Batch processing with configurable concurrency to control LLM cost
- Reuses the same quality pipeline with `trigger.type = 'manual'`

---

## Reused Components

| Component                   | Location                                        | Reuse Type                               |
| --------------------------- | ----------------------------------------------- | ---------------------------------------- |
| Quality pipeline definition | `pipeline/definitions/quality-pipeline.ts`      | Extended (add outcome to prompt)         |
| compute-quality service     | `pipeline/services/compute-quality.service.ts`  | Extended (parse outcome from response)   |
| read-conversation activity  | `pipeline/services/conversation-reader.ts`      | Unchanged                                |
| outcome-classification.ts   | `pipeline/services/outcome-classification.ts`   | Unchanged (used for heuristic fast-path) |
| Pipeline trigger service    | `pipeline/handlers/pipeline-trigger.service.ts` | Unchanged                                |
| Pipeline run workflow       | `pipeline/handlers/pipeline-run.workflow.ts`    | Unchanged                                |
| Activity router             | `pipeline/handlers/activity-router.service.ts`  | Unchanged                                |
| ClickHouse client           | `getClickHouseClient()`                         | Unchanged                                |
| LLM client                  | `createPipelineLLMClient()`                     | Unchanged                                |
| init-analytics-tables.ts    | `pipeline/schemas/init-analytics-tables.ts`     | Extended (add new table DDL)             |

---

## Files to Modify

1. **`packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts`** — Extend LLM prompt, parse outcome, write to `conversation_outcomes`
2. **`packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`** — Add `conversation_outcomes` table + `mv_daily_outcomes` MV DDL
3. **`packages/database/src/models/session.model.ts`** — Ensure `outcome` field accepts 5-category enum (currently 3-category)

## Files Unchanged (Reused As-Is)

- Pipeline trigger, workflow, activity router — no changes needed
- Conversation reader — already extracts escalation data
- Outcome classification heuristic — used directly for fast-path
- All other pipeline definitions — unaffected

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the quality evaluation pipeline to classify conversation outcomes into 5 categories (`contained_resolved`, `contained_partial`, `contained_unresolved`, `escalated`, `abandoned`), writing results to a new `conversation_outcomes` ClickHouse table with a daily materialized view.

**Architecture:** The existing `compute-quality` Restate service is extended with hybrid outcome classification — heuristic fast-path for escalated/abandoned sessions (no LLM cost), LLM evaluation for completed sessions (added to the same prompt). Results write to a separate `conversation_outcomes` ClickHouse table alongside the existing `quality_evaluations` write.

**Tech Stack:** Restate SDK, ClickHouse, Vitest, existing pipeline LLM client factory

**Design doc:** `docs/plans/2026-03-04-conversation-outcome-classification-design.md`

---

### Task 1: Add `conversation_outcomes` ClickHouse Table DDL

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`

**Step 1: Add table DDL to ANALYTICS_TABLE_DDL array**

In `init-analytics-tables.ts`, add a new entry to the `ANALYTICS_TABLE_DDL` array (after the `conversation_mentions` entry, before the closing `]` at line 521):

```typescript
  {
    name: 'conversation_outcomes',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.conversation_outcomes (
    tenant_id          LowCardinality(String),
    project_id         LowCardinality(String),
    session_id         String,

    session_started_at DateTime64(3),
    processed_at       DateTime64(3),

    outcome            LowCardinality(String),
    outcome_method     LowCardinality(String),
    confidence         Float32,

    goal_detected      Nullable(String),
    goal_achieved      Nullable(UInt8),
    outcome_reasoning  Nullable(String),

    agent_name         LowCardinality(String),
    channel            LowCardinality(String),
    message_count      UInt16,
    handoff_count      UInt8,
    escalation_reason  Nullable(String),
    duration_ms        UInt32,

    model_id           LowCardinality(String),
    config_version     UInt32,
    processing_ms      UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE
`,
  },
```

**Step 2: Add skip index for outcome column**

Add to the `ANALYTICS_SKIP_INDICES` array:

```typescript
  `ALTER TABLE ${DATABASE}.conversation_outcomes
    ADD INDEX IF NOT EXISTS idx_outcome outcome TYPE set(10) GRANULARITY 4`,
```

**Step 3: Add daily MV to ANALYTICS_MV_DDL array**

Add to the `ANALYTICS_MV_DDL` array:

```typescript
  {
    name: 'mv_daily_outcomes',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_outcomes
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(day))
ORDER BY (tenant_id, project_id, day, agent_name, channel, outcome)
TTL day + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS day,
    agent_name,
    channel,
    outcome,
    count()              AS session_count,
    sum(duration_ms)     AS total_duration_ms,
    sum(message_count)   AS total_message_count
FROM ${DATABASE}.conversation_outcomes
GROUP BY tenant_id, project_id, day, agent_name, channel, outcome
`,
  },
```

**Step 4: Build to verify no syntax errors**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/pipeline-engine`

Expected: Build succeeds

**Step 5: Commit**

```
feat(pipeline-engine): add conversation_outcomes ClickHouse table and daily MV
```

---

### Task 2: Write Failing Tests for Outcome Classification in Quality Service

**Files:**

- Modify: `packages/pipeline-engine/src/__tests__/compute-quality.test.ts`

**Step 1: Add test for heuristic escalated outcome**

Add a new `describe` block after the existing tests (after line 309):

```typescript
describe('ComputeQuality outcome classification', () => {
  beforeEach(() => {
    mockChat.mockReset();
    mockInsert.mockReset();
    mockInsert.mockResolvedValue(undefined);
  });

  test('classifies escalated sessions via heuristic (no LLM outcome call)', async () => {
    mockChat.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const input = makeInput({
      previousSteps: {
        'read-conversation': {
          status: 'success',
          data: {
            messages: [
              {
                messageId: 'msg-1',
                role: 'user',
                content: 'I need help',
                timestamp: '2025-01-01T00:00:00Z',
              },
              {
                messageId: 'msg-2',
                role: 'assistant',
                content: 'Let me transfer you',
                timestamp: '2025-01-01T00:00:01Z',
              },
            ],
            toolCalls: [],
            escalations: [
              {
                reason: 'Customer requested human agent',
                severity: 'medium',
                timestamp: '2025-01-01T00:00:02Z',
              },
            ],
            metadata: {
              agentName: 'SupportBot',
              channel: 'web_chat',
              messageCount: 2,
              durationMs: 2000,
            },
          },
        },
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('escalated');
    expect(result.data.outcomeMethod).toBe('heuristic');

    // Should write to both quality_evaluations AND conversation_outcomes
    expect(mockInsert).toHaveBeenCalledTimes(2);
    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    );
    expect(outcomeInsert).toBeDefined();
    const outcomeRow = outcomeInsert![0].values[0];
    expect(outcomeRow.outcome).toBe('escalated');
    expect(outcomeRow.outcome_method).toBe('heuristic');
    expect(outcomeRow.escalation_reason).toBe('Customer requested human agent');
  });

  test('classifies abandoned sessions via heuristic', async () => {
    mockChat.mockResolvedValue(STANDARD_LLM_RESPONSE);

    const input = makeInput({
      pipelineInput: {
        tenantId: 'acme-corp',
        projectId: 'support-bot',
        sessionId: 'sess-001',
        endReason: 'timeout',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('abandoned');
    expect(result.data.outcomeMethod).toBe('heuristic');
  });

  test('classifies completed sessions via LLM with extended prompt', async () => {
    const llmResponseWithOutcome = {
      content: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 4.5, rationale: 'Addressed the user need' },
          { name: 'accuracy', score: 4.0, rationale: 'Information was correct' },
          { name: 'professionalism', score: 4.8, rationale: 'Professional tone' },
          { name: 'instruction_following', score: 4.2, rationale: 'Followed workflow' },
        ],
        overall_reasoning: 'Good quality conversation',
        confidence: 0.9,
        flag_reasons: [],
        outcome: {
          outcome: 'contained_resolved',
          goal_detected: 'Check order status',
          goal_achieved: true,
          outcome_reasoning: 'Customer asked about order, agent provided tracking info',
        },
      }),
      inputTokens: 400,
      outputTokens: 180,
      model: 'claude-haiku-4-5',
    };
    mockChat.mockResolvedValue(llmResponseWithOutcome);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.outcome).toBe('contained_resolved');
    expect(result.data.outcomeMethod).toBe('llm_evaluated');

    // Verify LLM prompt includes outcome classification section
    const chatArgs = mockChat.mock.calls[0][0];
    const systemPrompt = chatArgs.messages.find((m: any) => m.role === 'system')?.content;
    expect(systemPrompt).toContain('Outcome Classification');
    expect(systemPrompt).toContain('contained_resolved');

    // Verify conversation_outcomes ClickHouse write
    const outcomeInsert = mockInsert.mock.calls.find(
      (c: any) => c[0].table === 'abl_platform.conversation_outcomes',
    );
    expect(outcomeInsert).toBeDefined();
    const row = outcomeInsert![0].values[0];
    expect(row.outcome).toBe('contained_resolved');
    expect(row.goal_detected).toBe('Check order status');
    expect(row.goal_achieved).toBe(1);
  });

  test('falls back to heuristic when LLM returns invalid outcome', async () => {
    const llmResponseBadOutcome = {
      content: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 4.0, rationale: 'Good' },
          { name: 'accuracy', score: 4.0, rationale: 'OK' },
          { name: 'professionalism', score: 4.0, rationale: 'Fine' },
          { name: 'instruction_following', score: 4.0, rationale: 'Yes' },
        ],
        overall_reasoning: 'OK conversation',
        confidence: 0.8,
        flag_reasons: [],
        outcome: {
          outcome: 'invalid_value',
          goal_detected: 'Something',
          goal_achieved: true,
          outcome_reasoning: 'Reasoning',
        },
      }),
      inputTokens: 300,
      outputTokens: 150,
      model: 'claude-haiku-4-5',
    };
    mockChat.mockResolvedValue(llmResponseBadOutcome);

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    // Falls back to heuristic 'contained' (completed + no escalation)
    expect(result.data.outcome).toBe('contained');
    expect(result.data.outcomeMethod).toBe('heuristic_fallback');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/pipeline-engine && pnpm --filter=@agent-platform/pipeline-engine test -- --run src/__tests__/compute-quality.test.ts`

Expected: 4 new tests FAIL (outcome-related fields not yet in service output)

**Step 3: Commit**

```
test(pipeline-engine): add failing tests for outcome classification in quality service
```

---

### Task 3: Extend `compute-quality.service.ts` with Outcome Classification

**Files:**

- Modify: `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts`

**Step 1: Add outcome constants, types, and the outcomes table name**

After the existing constants (line 33), add:

```typescript
const OUTCOMES_TABLE = 'abl_platform.conversation_outcomes';

const VALID_LLM_OUTCOMES = new Set([
  'contained_resolved',
  'contained_partial',
  'contained_unresolved',
]);

const ABANDONED_END_REASONS = new Set(['timeout', 'user_exit', 'user_left']);
```

Add a new response type after `QualityLLMResponse` (after line 134):

```typescript
interface OutcomeLLMResponse {
  outcome: string;
  goal_detected: string;
  goal_achieved: boolean;
  outcome_reasoning: string;
}

interface ConversationOutcomeRow {
  tenant_id: string;
  project_id: string;
  session_id: string;
  session_started_at: string;
  processed_at: string;
  outcome: string;
  outcome_method: string;
  confidence: number;
  goal_detected: string | null;
  goal_achieved: number | null;
  outcome_reasoning: string | null;
  agent_name: string;
  channel: string;
  message_count: number;
  handoff_count: number;
  escalation_reason: string | null;
  duration_ms: number;
  model_id: string;
  config_version: number;
  processing_ms: number;
}
```

**Step 2: Add the outcome prompt extension**

After the existing `buildJudgePrompt` function (after line 110), add:

```typescript
const OUTCOME_PROMPT_SECTION = `

## Outcome Classification

Based on the full conversation, classify the session outcome:

- "contained_resolved": The customer's goal was fully achieved by the AI agent.
  The customer got what they needed without human intervention.
- "contained_partial": Some progress was made toward the customer's goal, but the
  issue was not fully resolved. The customer may need to follow up.
- "contained_unresolved": The conversation completed (no escalation, no timeout)
  but the customer's actual problem was not addressed. The agent may have
  misunderstood the request or lacked the capability.

Add an "outcome" field to your JSON response:
{
  ...existing dimensions and fields...,
  "outcome": {
    "outcome": "contained_resolved",
    "goal_detected": "What the customer was trying to accomplish (1 sentence)",
    "goal_achieved": true,
    "outcome_reasoning": "Brief explanation of classification (1-2 sentences)"
  }
}`;
```

**Step 3: Add heuristic classification helper**

After the outcome prompt section, add:

```typescript
function classifyOutcomeHeuristic(
  escalations: Array<{ reason?: string }>,
  endReason?: string,
): { outcome: string; escalationReason: string | null } | null {
  // Escalation takes priority
  if (escalations.length > 0) {
    return {
      outcome: 'escalated',
      escalationReason: escalations[0]?.reason ?? null,
    };
  }

  // Abandoned = timeout or user left
  if (endReason && ABANDONED_END_REASONS.has(endReason)) {
    return { outcome: 'abandoned', escalationReason: null };
  }

  // Cannot determine heuristically — needs LLM
  return null;
}
```

**Step 4: Modify the execute handler to include outcome classification**

In the `execute` handler, make these changes:

a) After extracting `metadata` (line 234), also extract escalations and endReason:

```typescript
const escalations =
  (conversationStep.data.escalations as Array<{
    reason?: string;
    severity?: string;
    timestamp?: string;
  }>) ?? [];
const endReason = input.pipelineInput.endReason as string | undefined;
```

b) Before the LLM call (line 277), determine outcome heuristic:

```typescript
const heuristicOutcome = classifyOutcomeHeuristic(escalations, endReason);
```

c) When building `systemPrompt` (line 277), conditionally include outcome section:

```typescript
const systemPrompt =
  buildJudgePrompt(dimensions, domainContext) + (heuristicOutcome ? '' : OUTCOME_PROMPT_SECTION);
```

d) After parsing the LLM response (line 303), extract outcome:

```typescript
// Determine outcome
let outcomeValue: string;
let outcomeMethod: string;
let outcomeData: OutcomeLLMResponse | null = null;

if (heuristicOutcome) {
  outcomeValue = heuristicOutcome.outcome;
  outcomeMethod = 'heuristic';
} else {
  const rawOutcome = (parsed as any).outcome as OutcomeLLMResponse | undefined;
  if (rawOutcome && VALID_LLM_OUTCOMES.has(rawOutcome.outcome)) {
    outcomeValue = rawOutcome.outcome;
    outcomeMethod = 'llm_evaluated';
    outcomeData = rawOutcome;
  } else {
    // Fallback: completed + no escalation = contained
    outcomeValue = 'contained';
    outcomeMethod = 'heuristic_fallback';
    log.warn('Invalid LLM outcome, falling back to heuristic', {
      sessionId,
      rawOutcome: rawOutcome?.outcome,
    });
  }
}
```

e) After writing to the quality table (after line 376), write the outcome row:

```typescript
// Write outcome to conversation_outcomes table
const outcomeRow: ConversationOutcomeRow = {
  tenant_id: input.tenantId,
  project_id: input.projectId ?? '',
  session_id: sessionId,
  session_started_at: sessionStartedAt,
  processed_at: processedAt,
  outcome: outcomeValue,
  outcome_method: outcomeMethod,
  confidence: outcomeData ? Math.round((parsed.confidence ?? 0.8) * 1000) / 1000 : 1.0,
  goal_detected: outcomeData?.goal_detected ?? null,
  goal_achieved: outcomeData ? (outcomeData.goal_achieved ? 1 : 0) : null,
  outcome_reasoning: outcomeData?.outcome_reasoning ?? null,
  agent_name: metadata?.agentName ?? '',
  channel: metadata?.channel ?? '',
  message_count: messages.length,
  handoff_count: escalations.length,
  escalation_reason: heuristicOutcome?.escalationReason ?? null,
  duration_ms: metadata?.durationMs ?? 0,
  model_id: outcomeMethod === 'llm_evaluated' ? llmResult.model : '',
  config_version: CONFIG_VERSION,
  processing_ms: Date.now() - startTime,
};

await ctx.run('store-outcome-results', async () => {
  const client = getClickHouseClient();
  await client.insert({
    table: OUTCOMES_TABLE,
    values: [outcomeRow],
    format: 'JSONEachRow',
  });
});
```

f) Extend the return value (line 386) to include outcome data:

```typescript
return {
  status: 'success',
  data: {
    overallScore,
    dimensions: Object.fromEntries(scoreMap),
    flagged: isFlagged,
    flagReasons: parsed.flag_reasons,
    confidence: parsed.confidence,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
    outcome: outcomeValue,
    outcomeMethod,
    goalDetected: outcomeData?.goal_detected ?? null,
    goalAchieved: outcomeData?.goal_achieved ?? null,
  },
  durationMs: Date.now() - startTime,
};
```

**Step 5: Run tests**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/pipeline-engine && pnpm --filter=@agent-platform/pipeline-engine test -- --run src/__tests__/compute-quality.test.ts`

Expected: All tests PASS (both existing 7 tests + new 4 outcome tests)

Note: The existing 7 tests should still pass because:

- They don't check `mockInsert` call count strictly for === 1 (they use `toHaveBeenCalledTimes(1)` — this will need updating to `toHaveBeenCalledTimes(2)` since we now write to both tables)
- The `STANDARD_LLM_RESPONSE` doesn't include an `outcome` field, so the completed-session tests will use `heuristic_fallback` for those

**Step 5a: Fix existing tests if needed**

If existing tests fail due to the new second ClickHouse insert, update the `mockInsert` call count assertions. In the existing tests that check `toHaveBeenCalledTimes(1)`, change to `toHaveBeenCalledTimes(2)`. Update the `insertCall` references to specifically find the quality table insert:

```typescript
const qualityInsert = mockInsert.mock.calls.find(
  (c: any) => c[0].table === 'abl_platform.quality_evaluations',
);
expect(qualityInsert).toBeDefined();
const row = qualityInsert![0].values[0];
```

**Step 6: Format and commit**

Run: `npx prettier --write packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts packages/pipeline-engine/src/__tests__/compute-quality.test.ts`

```
feat(pipeline-engine): add outcome classification to quality evaluation service
```

---

### Task 4: Update Session Model Outcome Enum

**Files:**

- Modify: `packages/database/src/models/session.model.ts`

**Step 1: Extend the ISession outcome type**

Change line 35:

```typescript
// Before:
outcome: 'contained' | 'escalated' | 'abandoned' | null;

// After:
outcome: 'contained' |
  'contained_resolved' |
  'contained_partial' |
  'contained_unresolved' |
  'escalated' |
  'abandoned' |
  null;
```

**Step 2: Extend the schema enum**

Change line 111:

```typescript
// Before:
enum: ['contained', 'escalated', 'abandoned', null],

// After:
enum: ['contained', 'contained_resolved', 'contained_partial', 'contained_unresolved', 'escalated', 'abandoned', null],
```

**Step 3: Build to verify**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build --filter=@agent-platform/database`

Expected: Build succeeds

**Step 4: Format and commit**

Run: `npx prettier --write packages/database/src/models/session.model.ts`

```
feat(database): extend session outcome enum with 5-category classification
```

---

### Task 5: Run Full Test Suite and Verify

**Step 1: Build all packages**

Run: `cd /Users/Thiru/researchWS/abl-platform && pnpm build`

Expected: Full build succeeds

**Step 2: Run pipeline-engine tests**

Run: `pnpm --filter=@agent-platform/pipeline-engine test`

Expected: All tests pass (existing + new outcome tests)

**Step 3: Run outcome-classification unit tests (existing)**

Run: `pnpm --filter=@agent-platform/pipeline-engine test -- --run src/__tests__/outcome-classification.test.ts`

Expected: All 11 existing heuristic tests still pass (unchanged module)

**Step 4: Run database package tests if any**

Run: `pnpm --filter=@agent-platform/database test 2>/dev/null || echo "No tests"`

Expected: Pass or no tests

**Step 5: Commit (if any fixups needed)**

```
fix(pipeline-engine): address test failures from outcome classification integration
```

---

## Summary of Changes

| File                                                                        | Change                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts`    | Add `conversation_outcomes` table DDL, skip index, `mv_daily_outcomes` MV                                             |
| `packages/pipeline-engine/src/__tests__/compute-quality.test.ts`            | Add 4 outcome classification tests + update existing insert count assertions                                          |
| `packages/pipeline-engine/src/pipeline/services/compute-quality.service.ts` | Add outcome constants, types, heuristic helper, extended LLM prompt, outcome ClickHouse write, outcome in return data |
| `packages/database/src/models/session.model.ts`                             | Extend `outcome` enum from 3 to 5 values                                                                              |

**Total: 4 files modified, 0 new files created.**
