# Pipeline Trigger Analysis

## Current Event System

The platform emits these Kafka events (defined in `apps/runtime/src/services/event-bus/types.ts`):

| Event Type           | Kafka Topic              | When Fired                      |
| -------------------- | ------------------------ | ------------------------------- |
| `session.created`    | `abl.session.created`    | New conversation session starts |
| `session.ended`      | `abl.session.ended`      | Session is closed/completed     |
| `session.handoff`    | `abl.session.handoff`    | Agent-to-agent handoff          |
| `session.escalation` | `abl.session.escalation` | Escalation to human/supervisor  |
| `message.user`       | `abl.message.user`       | User sends a message            |
| `message.agent`      | `abl.message.agent`      | Agent sends a response          |
| `tool.called`        | `abl.tool.called`        | Tool invocation begins          |
| `tool.completed`     | `abl.tool.completed`     | Tool invocation finishes        |

Plus three trigger mechanisms: **kafka** (event-driven), **schedule** (cron), **manual** (API call).

---

## Pipeline-by-Pipeline Analysis

### 1. Sentiment Analysis (`builtin:sentiment-analysis`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Partially. Post-session is the safe default (full conversation available).
- **Better triggers**:
  - `abl.session.ended` — batch scoring of entire conversation (current, correct)
  - `abl.message.user` — **real-time per-message scoring** would enable live frustration alerts and agent coaching mid-conversation. The pipeline already computes per-message sentiment + shift detection + frustration threshold. Triggering on each user message would unlock live dashboards.
  - `abl.message.agent` — less useful but could score agent tone in real-time

### 2. Intent Classification (`builtin:intent-classification`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Depends on the use case.
- **Better triggers**:
  - `abl.session.ended` — final classification with full context (current, correct for analytics)
  - `abl.message.user` with `inputMessageStrategy: 'first_n_user'` — **early intent detection** after first 1-3 user messages would enable smart routing, proactive suggestions. The config already supports `first_n_user`/`last_n_user` strategies suggesting this was designed with early classification in mind.
  - `abl.session.created` — too early (no messages yet), **not useful**

### 3. Quality Evaluation (`builtin:quality-evaluation`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Yes, this is the right trigger.
- **Why**: Quality evaluation (helpfulness, accuracy, professionalism) requires the full conversation arc. Evaluating mid-conversation is premature — you can't judge "did the agent resolve the issue?" until it's over.
- **Alternative**: Manual trigger for re-evaluation after config changes (backfill). Already supported.

### 4. Hallucination Detection (`builtin:hallucination-detection`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Partially — this is the **least ideal** pipeline for post-session only.
- **Better triggers**:
  - `abl.message.agent` — **this is the ideal trigger**. Hallucinations happen in agent responses. Detecting them per-message enables real-time guardrails: block/flag the response before the user sees it, or annotate it for human review.
  - `abl.tool.completed` — agent responses that synthesize tool results are the highest-risk for hallucination. Triggering after tool completion + next agent message would focus analysis on the most vulnerable moments.
  - `abl.session.ended` — acceptable for batch analytics/reporting, but misses the prevention opportunity.

### 5. Knowledge Gap Analysis (`builtin:knowledge-gap-analysis`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Yes, this is the right trigger.
- **Why**: Knowledge gaps are identified by analyzing patterns across the full conversation — retrieval precision, citation rates, uncovered topics. These are inherently retrospective metrics. Individual messages don't have enough signal.
- **Alternative**: Schedule-based (daily/weekly aggregation across sessions) would be even more useful for identifying systemic gaps rather than per-session.

### 6. Guardrail Analysis (`builtin:guardrail-analysis`)

- **Current trigger**: `abl.session.ended`
- **Correct?** No, this is **suboptimal**.
- **Better triggers**:
  - `abl.message.agent` — detecting guardrail bypass attempts and false negatives in real-time would allow intervention before unsafe content reaches users.
  - `abl.message.user` — detecting jailbreak attempts / adversarial prompts on input would enable pre-emptive blocking.
  - `abl.session.ended` — useful for false-positive analysis (were guardrails too aggressive?) but this is a reporting concern, not prevention.

### 7. Friction Detection (`builtin:friction-detection`)

- **Current trigger**: `abl.session.ended`
- **Correct?** Partially.
- **Better triggers**:
  - `abl.message.user` — **ideal for live detection**. The pipeline already looks for: rephrased questions, caps/exclamation patterns, message escalation. These signals are available per-message and are most useful in real-time (route to human agent, change strategy).
  - `abl.session.ended` — good for aggregate reporting and trend analysis.
  - **Dual trigger** would be ideal: per-message for live alerts, post-session for full trajectory analysis.

### 8. Anomaly Detection (`builtin:anomaly-detection`)

- **Current trigger**: Schedule `0 * * * *` (hourly cron)
- **Correct?** Yes, this is the right trigger.
- **Why**: Anomaly detection uses z-score and SPC control charts over materialized views (`mv_daily_sentiment`). It needs aggregated data, not individual events. Hourly is appropriate for detecting sudden shifts.
- **Alternative**: Could add a secondary event-driven trigger that fires when a metric crosses a threshold in a single session, but the current approach is statistically sound.

### 9. Drift Detection (`builtin:drift-detection`)

- **Current trigger**: Schedule `0 0 * * *` (daily at midnight)
- **Correct?** Yes, this is the right trigger.
- **Why**: Drift detection compares baseline and current windows of quality scores. This is inherently a trend analysis that needs days of data. Daily is the right cadence.

### 10. Eval Run (`eval-run-pipeline`)

- **Current trigger**: Manual
- **Correct?** Yes.
- **Why**: Evaluations are deliberate operations triggered by users from Studio. They run persona×scenario matrices — there's no event that should auto-trigger this.

---

## Summary: Recommended Trigger Matrix

| Pipeline                | `session.created` | `message.user`    | `message.agent` | `tool.called` | `tool.completed` | `session.handoff` | `session.escalation` | `session.ended` | Schedule   | Manual      |
| ----------------------- | ----------------- | ----------------- | --------------- | ------------- | ---------------- | ----------------- | -------------------- | --------------- | ---------- | ----------- |
| Sentiment Analysis      | -                 | **live**          | -               | -             | -                | -                 | -                    | **batch**       | -          | backfill    |
| Intent Classification   | -                 | **early routing** | -               | -             | -                | -                 | -                    | **final**       | -          | backfill    |
| Quality Evaluation      | -                 | -                 | -               | -             | -                | -                 | -                    | **primary**     | -          | backfill    |
| Hallucination Detection | -                 | -                 | **primary**     | -             | secondary        | -                 | -                    | batch           | -          | backfill    |
| Knowledge Gap           | -                 | -                 | -               | -             | -                | -                 | -                    | **primary**     | weekly agg | backfill    |
| Guardrail Analysis      | -                 | **input**         | **output**      | -             | -                | -                 | -                    | reporting       | -          | backfill    |
| Friction Detection      | -                 | **live**          | -               | -             | -                | -                 | escalation           | **batch**       | -          | backfill    |
| Anomaly Detection       | -                 | -                 | -               | -             | -                | -                 | -                    | -               | **hourly** | -           |
| Drift Detection         | -                 | -                 | -               | -             | -                | -                 | -                    | -               | **daily**  | -           |
| Eval Run                | -                 | -                 | -               | -             | -                | -                 | -                    | -               | -          | **primary** |

**Bold** = recommended primary trigger. Non-bold = useful secondary trigger.

---

## Key Insight

The biggest gap is that **safety-critical pipelines** (hallucination, guardrail, friction) are all post-session today, but their highest value is **real-time per-message**. The event bus already emits `message.user` and `message.agent` events — the infrastructure supports it. The pipeline definitions just need to be wired to those topics instead of (or in addition to) `session.ended`.

---

## Appendix: Pipeline Infrastructure Details

### Trigger Mechanisms

#### A. Kafka-based Triggers (Event-driven)

The pipeline engine listens to Kafka topics via Restate subscriptions. All events conform to the `PlatformEvent<T, P>` envelope defined in `apps/runtime/src/services/event-bus/types.ts`.

**PlatformEvent Envelope Structure**:

```typescript
interface PlatformEvent<T extends string, P> {
  eventId: string;
  type: T;
  tenantId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  channel: string;
  timestamp: string;
  payload: P; // Type-specific payload
}
```

**Event Filter Mechanism**: Pipeline definitions can include optional `eventFilter` (field matching):

```typescript
eventFilter?: { field: string; equals: string }
```

#### B. Schedule-based Triggers (Cron)

Via `PipelineScheduler` (Restate virtual object):

- Uses cron expressions (e.g., `0 * * * *` for hourly, `0 0 * * *` for daily)
- Single-writer guarantee per pipeline ID prevents duplicates
- Durable sleep survives crashes
- Fires `PipelineTrigger.triggerManual()` at scheduled times

#### C. Manual Triggers

Via `PipelineTrigger.triggerManual()` handler:

- Called programmatically from Studio API or other services
- Input: `{ pipelineId, tenantId, triggeredBy, data }`
- Used for eval runs and on-demand analysis

#### D. Sampling & Filtering

Within `PipelineTrigger.handleEvent()`:

1. **Sampling**: Events are sampled based on `samplingRate` from `PipelineConfig` (0–1, default 1.0)
2. **Input Schema Validation**: Required fields checked (e.g., `tenantId`, `sessionId`)
3. **Event Filter**: Nested field matching via `getNestedField()` (supports dot notation like `payload.field`)
4. **Multi-tenant/Platform Isolation**: Only `__platform__` pipelines + tenant-specific pipelines are eligible

### Pipeline Configuration Schemas (Zod)

Location: `packages/pipeline-engine/src/pipeline/config-schemas.ts`

#### Shared Base Schema (all pipelines):

```typescript
{
  model?: string;             // LLM model override (e.g., 'gpt-4o', 'claude-sonnet')
  provider?: string;          // LLM provider override
  samplingRate: 0–1;          // Default: 1.0 (process all events)
  stepOverrides: {};          // Per-step config overrides, keyed by step ID
  timeoutOverrides: {};       // Per-step timeout overrides in ms
}
```

#### Pipeline-Specific Config Schemas:

**Sentiment Analysis** (`sentiment_analysis`):

```typescript
{
  ...SharedBase,
  shiftThreshold: 0–1,                   // Default: 0.3
  frustrationThreshold: -1–0,            // Default: -0.3
  defaultConfidence: 0–1,                // Default: 0.85
}
```

**Intent Classification** (`intent_classification`):

```typescript
{
  ...SharedBase,
  taxonomy: Array<{                      // Default: [] (auto-discovery)
    name: string;
    description: string;
    displayName?: string;
    examples?: string[];
    subCategories?: Array<{ name; description; displayName? }>;
  }>;
  confidenceThreshold: 0–1;              // Default: 0.6
  inputMessageStrategy: 'first_n_user' | 'last_n_user' | 'all_user' | 'all'; // Default: 'first_n_user'
  inputMessageCount: positive int;       // Default: 3
  unknownIntentLabel: string;            // Default: 'unknown'
  classificationPrompt?: string;
}
```

**Quality Evaluation** (`quality_evaluation`):

```typescript
{
  ...SharedBase,
  dimensions?: Array<{                   // Default: platform defaults
    name: string;
    displayName: string;
    description: string;
    scale: { min: number; max: number };
    weight: number;
    criteria?: string[];
  }>;
  domainContext?: string;
  flagThreshold: 0–5;                    // Default: 2.5
}
```

**LLM Evaluation Pipelines** (`hallucination_detection`, `knowledge_gap`, `guardrail_analysis`):

```typescript
{
  ...SharedBase,
  flagThreshold?: number;
  systemPromptOverride?: string;
}
```

**Statistical Pipelines** (`friction_detection`, `anomaly_detection`, `drift_detection`):

```typescript
{
  ...SharedBase,
  metricTable?: string;
  metricColumn?: string;
  lookbackDays: positive int;            // Default: 30
}
```

**Simulation/Eval** (`simulation`):

```typescript
{
  ...SharedBase,
}
```

#### Pipeline Type Enum:

```typescript
type PipelineType =
  | 'sentiment_analysis'
  | 'intent_classification'
  | 'quality_evaluation'
  | 'anomaly_detection'
  | 'nl_to_sql' // Not yet implemented
  | 'knowledge_gap'
  | 'hallucination_detection'
  | 'embedding_drift' // Not yet implemented
  | 'predictive_ml' // Not yet implemented
  | 'simulation'
  | 'guardrail_analysis'
  | 'friction_detection'
  | 'drift_detection';
```

### Configuration Resolution Chain

Location: `packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts`

Config resolution follows a **3-tier fallback**:

1. **Project-level config** (highest priority) — Query: `{ tenantId, pipelineType, projectId }`
2. **Tenant-level config** — Query: `{ tenantId, pipelineType, projectId: null }`
3. **Platform defaults** (lowest priority) — Synthetic config generated by Zod parsing empty `{}` through each schema

**Version Tracking**: Each config has an auto-incrementing `version` field (incremented on update). Config history tracks last 20 changes with diffs.

**Reprocessing Detection**: When config changes, the service marks `reprocessingRequired: true` if key fields change (taxonomy, dimensions, model, provider, prompts, scale, etc.)

### MongoDB Schemas

#### Pipeline Definition Schema

Location: `packages/pipeline-engine/src/schemas/pipeline-definition.schema.ts`
Collection: `pipeline_definitions`

```typescript
interface IPipelineDefinition {
  _id: string; // Unique pipeline ID
  tenantId: string; // '__platform__' for builtin, or tenant ID
  projectId?: string;
  name: string;
  description?: string;
  pipelineType?: string; // Links to PipelineConfig pipelineType
  version: number;
  status: 'draft' | 'active' | 'archived';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string; // e.g., 'abl.session.ended'
    eventFilter?: { field: string; equals: string };
    schedule?: string; // Cron expression
  };
  inputSchema?: {
    required: string[];
    properties: Record<string, { type; description? }>;
  };
  outputSchema?: { properties: Record<string, { type; description? }> };
  steps: PipelineStep[];
  onStepFailure?: 'stop' | 'skip' | 'continue';
  tags?: string[];
  maxConcurrency?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes**:

- `{ tenantId, status }`
- `{ tenantId, projectId, status }`
- `{ tenantId, 'trigger.kafkaTopic', status }` (for event-based lookup)
- `{ tenantId, tags }`

#### Pipeline Config Schema

Location: `packages/pipeline-engine/src/schemas/pipeline-config.schema.ts`
Collection: `pipeline_configs`

```typescript
interface IPipelineConfig extends Document {
  tenantId: string;
  projectId?: string | null; // null for tenant-level
  pipelineType: PipelineType;
  version: number; // Auto-incremented on save
  enabled: boolean;
  config: Record<string, unknown>; // Validated against Zod schema
  lastBackfillAt?: Date;
  backfillStatus?: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date;
  createdBy: string;
  updatedBy: string;
  configHistory?: Array<{
    // Last 20 entries
    version: number;
    changedBy: string;
    changedAt: Date;
    diff: Record<string, { old; new }>;
    reprocessingRequired: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
}
```

**Unique Index**: `{ tenantId, pipelineType, projectId }`
**Query Index**: `{ tenantId, enabled }`

### Pipeline Execution Flow

Restate Services/Workflows located in `packages/pipeline-engine/src/pipeline/handlers/`:

1. **PipelineTrigger** (Service)
   - **Entry Points**:
     - `handleEvent(event)` — Kafka event handler; finds matching pipelines, applies sampling/filtering, starts runs
     - `triggerManual(input)` — Programmatic trigger from API/scheduler
   - **Internal Process**:
     - Cache pipeline definitions (5-min TTL, max 50 keys)
     - Find active pipelines for event topic + tenant
     - Apply event filter + input schema validation
     - Apply sampling rate (probabilistic)
     - For each matching pipeline: create run record + send to `PipelineRun` workflow

2. **PipelineRun** (Workflow)
   - **Input**: `PipelineRunInput` containing definition + input data
   - **Execution**:
     - Resolve pipeline config (once per run)
     - Walk through steps array (while loop)
     - Evaluate conditions (skip if false)
     - Handle parallel groups (fan-out/fan-in via `RestatePromise.all()`)
     - Execute each step via `ActivityRouter` service
     - Handle step failures (stop/skip/continue strategies)
     - Check for early stop signals (`pipelineShouldStop`)
     - Persist final result to MongoDB
   - **Output**: Overall status + step outputs

3. **PipelineScheduler** (Virtual Object, keyed by pipeline ID)
   - **Handlers**:
     - `start(input)` — Begin cron loop
     - `stop()` — Stop schedule
     - `getScheduleStatus()` — Query status (shared handler)
   - **Process**:
     - Compute next cron time
     - Durable sleep until execution time
     - Fire-and-forget call to `PipelineTrigger.triggerManual()`
     - Loop until stopped

### Supported Activity Types

Activity steps are executed by a central `ActivityRouter` service. Common activity types include:

- `read-conversation` — Load session messages/traces from MongoDB
- `compute-sentiment` — LLM-based sentiment analysis
- `compute-intent` — Intent classification
- `compute-quality` — Quality evaluation
- `conversation-analyzer` — Generic LLM evaluator (hallucination/knowledge-gap/guardrail)
- `compute-statistical` — Statistical analysis (anomaly/drift/friction)
- `run-eval-conversation` — Execute persona conversation
- `judge-conversation` — Judge conversation results
- `aggregate-eval-run` — Aggregate eval results
- Plus: `store-insight`, `send-notification`, `transform`, etc.

Activity metadata: `packages/pipeline-engine/src/pipeline/activity-metadata.ts`

### Key Files Reference

| File                                                                         | Purpose                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/types.ts`                             | Core type definitions                         |
| `packages/pipeline-engine/src/pipeline/config-schemas.ts`                    | Zod validation schemas for all pipeline types |
| `packages/pipeline-engine/src/pipeline/config-defaults.ts`                   | Platform defaults generated from Zod schemas  |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts` | Kafka + manual trigger handler                |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`    | Pipeline DAG execution engine                 |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-scheduler.ts`       | Cron-based scheduler                          |
| `packages/pipeline-engine/src/pipeline/services/pipeline-config.service.ts`  | Config resolution + versioning                |
| `packages/pipeline-engine/src/schemas/pipeline-definition.schema.ts`         | MongoDB definition schema                     |
| `packages/pipeline-engine/src/schemas/pipeline-config.schema.ts`             | MongoDB config schema                         |
| `packages/pipeline-engine/src/pipeline/definitions/*.ts`                     | 9 builtin pipeline definitions                |
| `apps/runtime/src/routes/pipeline-config.ts`                                 | Config management API                         |
| `apps/runtime/src/routes/pipeline-analytics.ts`                              | Analytics query API                           |
| `packages/database/seed-pipelines.ts`                                        | Internal helper to seed definitions + configs |

### Custom Pipeline Support

The system supports **custom, user-defined pipelines** (not just the 9 builtins):

- Users can create pipeline definitions via MongoDB or API
- Any `pipelineType` value is accepted (not restricted to enum)
- If custom type has no schema in `PIPELINE_CONFIG_SCHEMAS`, config passes through without validation
- Definitions must specify trigger (kafka/schedule/manual) and steps
