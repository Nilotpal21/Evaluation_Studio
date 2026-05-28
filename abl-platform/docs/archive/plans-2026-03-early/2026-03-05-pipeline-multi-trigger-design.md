# Pipeline Multi-Trigger & Real-Time Execution Design

**Date**: 2026-03-05
**Status**: Draft
**Branch**: feature/custom-pipeline-fixes

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Design Decisions](#2-design-decisions)
3. [Complete Data Model](#3-complete-data-model)
4. [Pipeline Definition Schema](#4-pipeline-definition-schema)
5. [Pipeline Config Schema](#5-pipeline-config-schema)
6. [Trigger Matching & Execution Flow](#6-trigger-matching--execution-flow)
7. [New Activity: read-message-window](#7-new-activity-read-message-window)
8. [Existing Activity Changes](#8-existing-activity-changes)
9. [ClickHouse Schema Changes](#9-clickhouse-schema-changes)
10. [All Builtin Pipeline Definitions](#10-all-builtin-pipeline-definitions)
11. [Config Schema in Definitions](#11-config-schema-in-definitions)
12. [API Changes](#12-api-changes)
13. [EventSubscriptionRegistry Changes](#13-eventsubscriptionregistry-changes)
14. [Migration Script](#14-migration-script)
15. [Files Affected](#15-files-affected)

---

## 1. Problem Statement

### Current State

All 7 session-based analytics pipelines (sentiment, intent, quality, hallucination, knowledge gap, guardrail, friction) trigger exclusively on `abl.session.ended`. While the Kafka event bus already emits per-message events (`abl.message.user`, `abl.message.agent`, `abl.tool.called`, `abl.tool.completed`) and all 8 topics are subscribed in Restate, no pipeline is wired to these real-time events.

### Why This Matters

Safety-critical pipelines deliver their highest value in real-time:

| Pipeline                | Current Trigger | Ideal Real-Time Trigger              | Value of Real-Time                                             |
| ----------------------- | --------------- | ------------------------------------ | -------------------------------------------------------------- |
| Hallucination Detection | session.ended   | **message.agent**                    | Flag hallucinated responses before user sees them              |
| Guardrail Analysis      | session.ended   | **message.user** + **message.agent** | Detect jailbreak attempts on input, bypass on output           |
| Friction Detection      | session.ended   | **message.user**                     | Live frustration alerts, route to human agent mid-conversation |
| Sentiment Analysis      | session.ended   | **message.user**                     | Live frustration scoring, agent coaching dashboards            |
| Intent Classification   | session.ended   | **message.user**                     | Early intent detection for smart routing after first messages  |

### Structural Problems

1. **Single trigger per definition**: The `trigger` field is a single object — a pipeline cannot respond to multiple events.
2. **No execution mode concept**: All pipelines run the same step chain regardless of context. Real-time (single message + window) and batch (full conversation) need fundamentally different data-fetching and compute strategies.
3. **Customer cannot choose triggers**: The trigger is hardcoded in the definition. Customers cannot opt-in to real-time or select which events to process.
4. **Config schema disconnected from definition**: A pipeline's configuration requirements (taxonomy, thresholds, dimensions) live only in Zod schemas in `config-schemas.ts`, completely separate from the definition. The definition cannot describe what config it needs.
5. **No explicit persistence step**: Compute activities write to ClickHouse as a side effect. Persistence is invisible in the step chain.

---

## 2. Design Decisions

These decisions were made during the design process:

| #   | Decision                                                                                                         | Rationale                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Observational only** — real-time results write to ClickHouse async, never block/delay messages                 | Simpler, no latency impact on conversations. Blocking/inline mode is a future extension.                                         |
| 2   | **Triggers and strategies are separate concepts** — `supportedTriggers` declares when, `strategies` declares how | Avoids conflating event sources with execution plans. Multiple triggers can share a strategy.                                    |
| 3   | **Per-trigger step chains** — each strategy has its own steps, not shared steps with mode-aware branching        | Explicit, no runtime branching, each chain optimized for its execution mode.                                                     |
| 4   | **Single message + recent window** for real-time context                                                         | Pass triggering message from event payload + fetch last N messages for context. Bounded cost, sufficient for real-time analysis. |
| 5   | **Keep both real-time and batch results independently** — `source` column distinguishes them                     | Enables comparing RT accuracy against batch ground truth. No dedup complexity.                                                   |
| 6   | **All pipelines default to session.ended only**                                                                  | Backward compatible. Customers explicitly opt-in to real-time triggers. No surprise LLM cost increases.                          |
| 7   | **Config schema embedded in definition** — definitions are fully self-describing                                 | Single source of truth. Enables dynamic Zod generation, Studio UI rendering, custom pipeline config.                             |
| 8   | **Explicit store-results step** in every step chain                                                              | Persistence is visible in the definition. Source column (batch/realtime) set via step config.                                    |
| 9   | **Clean migration via script** — no backward-compat normalization layer                                          | Brand new application, no need for read-time fallback or dual-index support.                                                     |

---

## 3. Complete Data Model

### Pipeline Definition (fully self-describing)

```typescript
interface PipelineDefinition {
  // ── Identity ──
  _id: string; // e.g., 'builtin:sentiment-analysis'
  tenantId: string; // '__platform__' for builtins, tenant ID for custom
  projectId?: string;
  name: string;
  description?: string;
  pipelineType: string; // Links to config, ClickHouse tables, analytics routes
  version: number;
  status: 'draft' | 'active' | 'archived';
  tags?: string[];
  maxConcurrency?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;

  // ── What config this pipeline needs ──
  configSchema: {
    fields: ConfigField[]; // Pipeline-specific fields
  }; // Shared fields (model, provider, samplingRate, etc.) injected automatically

  // ── When can this pipeline fire ──
  supportedTriggers: TriggerEntry[]; // All possible trigger points
  defaultTriggerIds: string[]; // Active by default if customer doesn't configure

  // ── How does it execute ──
  strategies: Record<string, ExecutionStrategy>; // Keyed by strategy name
}
```

### Supporting Types

```typescript
interface ConfigField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
  required: boolean;
  default?: unknown;
  description: string;
  validation?: {
    min?: number;
    max?: number;
  };
  values?: string[]; // For enum type — allowed values
  items?:
    | ConfigField
    | {
        // For array type — item schema
        type: string;
        properties: Record<string, ConfigField>;
      };
  reprocessOnChange?: boolean; // When true, changing this field triggers backfill
}

interface TriggerEntry {
  id: string; // e.g., 'batch', 'realtime-user', 'realtime-agent'
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string; // For kafka type
  eventFilter?: {
    // Optional nested field match
    field: string;
    equals: string;
  };
  schedule?: string; // For schedule type — cron expression
  strategy: string; // References key in strategies map
  label: string; // UI display name (e.g., 'On session end')
  description: string; // UI description of what this trigger does
  inputSchema?: {
    // Validates the incoming event envelope
    required: string[];
    properties: Record<string, { type: string; description?: string }>;
  };
}

interface ExecutionStrategy {
  executionMode: 'batch' | 'realtime';
  steps: PipelineStep[];
  onStepFailure?: 'stop' | 'skip' | 'continue';
}

interface PipelineStep {
  id: string; // Unique within the strategy
  activity: string; // Activity type from activity registry
  config?: Record<string, unknown>; // Static config passed to the activity
  condition?: string; // Expression — skip step if evaluates to false
  parallel?: boolean; // Group with adjacent parallel steps for fan-out
}
```

### Pipeline Config (customer-owned)

```typescript
interface IPipelineConfig {
  tenantId: string;
  projectId?: string | null; // null for tenant-level
  pipelineType: string;
  version: number; // Auto-incremented on save
  enabled: boolean;

  // ── Trigger selection ──
  activeTriggers?: string[]; // Subset of definition.supportedTriggers[].id
  // If omitted → falls back to definition.defaultTriggerIds

  triggerConfigs?: Record<
    string,
    {
      // Per-trigger overrides, keyed by trigger ID
      samplingRate?: number; // Override sampling for this trigger
      stepOverrides?: Record<string, Record<string, unknown>>; // Per-step config for this trigger
    }
  >;

  // ── Pipeline config values ──
  config: Record<string, unknown>; // Validated against definition.configSchema at save time

  // ── Backfill state ──
  lastBackfillAt?: Date;
  backfillStatus?: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date;

  // ── Audit ──
  createdBy: string;
  updatedBy: string;
  configHistory?: Array<{
    // Last 20 entries
    version: number;
    changedBy: string;
    changedAt: Date;
    diff: Record<string, { old: unknown; new: unknown }>;
    reprocessingRequired: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
}
```

### Pipeline Run Record

```typescript
interface IPipelineRunRecord {
  _id: string; // Run ID
  pipelineId: string;
  tenantId: string;
  projectId?: string;
  status: 'running' | 'completed' | 'failed';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggerId: string; // Which supportedTrigger fired
    executionMode: 'batch' | 'realtime';
  };
  input: Record<string, unknown>; // Full event envelope
  steps: Array<{
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    output?: Record<string, unknown>;
    durationMs?: number;
    error?: string;
  }>;
  durationMs?: number;
  startedAt: Date;
  completedAt?: Date;
}
```

---

## 4. Pipeline Definition Schema

### MongoDB Schema Changes

**Collection**: `pipeline_definitions`

**Removed fields**:

- `trigger` (single object)
- `steps` (top-level array)
- `inputSchema` (top-level)
- `onStepFailure` (top-level — moved into each strategy)

**Added fields**:

- `configSchema` (object with fields array)
- `supportedTriggers` (array of TriggerEntry)
- `defaultTriggerIds` (array of strings)
- `strategies` (map of strategy name → ExecutionStrategy)

**Indexes**:

```javascript
// Remove old indexes
// { tenantId: 1, 'trigger.kafkaTopic': 1, status: 1 }

// Add new indexes
{ tenantId: 1, 'supportedTriggers.kafkaTopic': 1, status: 1 }   // Event-based lookup
{ tenantId: 1, status: 1 }                                        // Tenant listing (unchanged)
{ tenantId: 1, projectId: 1, status: 1 }                          // Project listing (unchanged)
{ tenantId: 1, tags: 1 }                                          // Tag-based lookup (unchanged)
```

### Mongoose Schema Definition

```typescript
const TriggerEntrySchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: ['kafka', 'schedule', 'manual'], required: true },
    kafkaTopic: { type: String },
    eventFilter: {
      field: { type: String },
      equals: { type: String },
    },
    schedule: { type: String },
    strategy: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    inputSchema: {
      required: [{ type: String }],
      properties: { type: Schema.Types.Mixed },
    },
  },
  { _id: false },
);

const PipelineStepSchema = new Schema(
  {
    id: { type: String, required: true },
    activity: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: {} },
    condition: { type: String },
    parallel: { type: Boolean },
  },
  { _id: false },
);

const ExecutionStrategySchema = new Schema(
  {
    executionMode: { type: String, enum: ['batch', 'realtime'], required: true },
    steps: [PipelineStepSchema],
    onStepFailure: { type: String, enum: ['stop', 'skip', 'continue'], default: 'stop' },
  },
  { _id: false },
);

const ConfigFieldSchema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ['string', 'number', 'boolean', 'enum', 'array', 'object'],
      required: true,
    },
    required: { type: Boolean, required: true },
    default: { type: Schema.Types.Mixed },
    description: { type: String, required: true },
    validation: {
      min: { type: Number },
      max: { type: Number },
    },
    values: [{ type: String }],
    items: { type: Schema.Types.Mixed },
    reprocessOnChange: { type: Boolean, default: false },
  },
  { _id: false },
);

const PipelineDefinitionSchema = new Schema(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    projectId: { type: String },
    name: { type: String, required: true },
    description: { type: String },
    pipelineType: { type: String },
    version: { type: Number, default: 1 },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' },
    tags: [{ type: String }],
    maxConcurrency: { type: Number },

    configSchema: {
      fields: [ConfigFieldSchema],
    },

    supportedTriggers: [TriggerEntrySchema],
    defaultTriggerIds: [{ type: String }],

    strategies: { type: Map, of: ExecutionStrategySchema },

    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);
```

---

## 5. Pipeline Config Schema

### MongoDB Schema Changes

**Collection**: `pipeline_configs`

**Added fields**:

- `activeTriggers` (array of strings, optional)
- `triggerConfigs` (map of trigger ID → overrides, optional)

**Unique index unchanged**: `{ tenantId, pipelineType, projectId }`

### Mongoose Schema Additions

```typescript
// Add to existing PipelineConfigSchema
activeTriggers: [{ type: String }],

triggerConfigs: {
  type: Map,
  of: new Schema({
    samplingRate: { type: Number, min: 0, max: 1 },
    stepOverrides: { type: Map, of: Schema.Types.Mixed },
  }, { _id: false }),
},
```

### Config Resolution (updated)

The 3-tier fallback remains: project → tenant → platform defaults. Additional resolution logic:

```typescript
// Resolve which triggers are active
function resolveActiveTriggers(
  config: IPipelineConfig | null,
  definition: IPipelineDefinition,
): string[] {
  const active = config?.activeTriggers ?? definition.defaultTriggerIds;
  const supportedIds = new Set(definition.supportedTriggers.map((t) => t.id));

  // Validate: active must be subset of supported
  const valid = active.filter((id) => supportedIds.has(id));
  const invalid = active.filter((id) => !supportedIds.has(id));
  if (invalid.length > 0) {
    logger.warn('Invalid trigger IDs in config, ignoring', {
      invalid,
      pipelineType: definition.pipelineType,
    });
  }

  return valid;
}

// Resolve sampling rate for a specific trigger
function resolveSamplingRate(triggerId: string, config: IPipelineConfig | null): number {
  return (
    config?.triggerConfigs?.get(triggerId)?.samplingRate ??
    (config?.config?.samplingRate as number) ??
    1.0
  );
}
```

### Dynamic Zod Schema Generation

Replace static `PIPELINE_CONFIG_SCHEMAS` registry with runtime generation from `configSchema`:

```typescript
function buildZodSchema(configSchema: { fields: ConfigField[] }): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of configSchema.fields) {
    let zodField: z.ZodTypeAny;

    switch (field.type) {
      case 'string':
        zodField = z.string();
        break;
      case 'number':
        zodField = z.number();
        if (field.validation?.min !== undefined)
          zodField = (zodField as z.ZodNumber).min(field.validation.min);
        if (field.validation?.max !== undefined)
          zodField = (zodField as z.ZodNumber).max(field.validation.max);
        break;
      case 'boolean':
        zodField = z.boolean();
        break;
      case 'enum':
        zodField = z.enum(field.values as [string, ...string[]]);
        break;
      case 'array':
        zodField = z.array(buildItemSchema(field.items));
        break;
      case 'object':
        zodField = z.record(z.string(), z.unknown());
        break;
    }

    if (!field.required) {
      zodField = zodField.optional();
    }
    if (field.default !== undefined) {
      zodField = zodField.default(field.default);
    }

    shape[field.name] = zodField;
  }

  // Inject shared fields
  return z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    samplingRate: z.number().min(0).max(1).default(1.0),
    stepOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    timeoutOverrides: z.record(z.string(), z.number()).default({}),
    ...shape,
  });
}
```

### Reprocessing Detection (updated)

No longer a hardcoded list of field names. Driven by `reprocessOnChange` flag:

```typescript
function requiresReprocessing(
  definition: IPipelineDefinition,
  oldConfig: Record<string, unknown>,
  newConfig: Record<string, unknown>,
): boolean {
  const sensitiveFields = definition.configSchema.fields
    .filter((f) => f.reprocessOnChange)
    .map((f) => f.name);

  // Shared fields that always trigger reprocessing
  sensitiveFields.push('model', 'provider');

  return sensitiveFields.some(
    (field) => JSON.stringify(oldConfig[field]) !== JSON.stringify(newConfig[field]),
  );
}
```

### Platform Defaults (updated)

No longer a pre-computed `PLATFORM_DEFAULTS` object. Defaults come from the definition's `configSchema`:

```typescript
function getPlatformDefaults(definition: IPipelineDefinition): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    samplingRate: 1.0,
    stepOverrides: {},
    timeoutOverrides: {},
  };

  for (const field of definition.configSchema.fields) {
    if (field.default !== undefined) {
      defaults[field.name] = field.default;
    }
  }

  return defaults;
}
```

---

## 6. Trigger Matching & Execution Flow

### Updated PipelineTrigger.handleEvent

```
Event arrives (e.g., abl.message.user from Kafka via Restate)
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. Extract tenantId, eventType          │
│    Resolve kafkaTopic from eventType    │
│    e.g., 'message.user' → 'abl.message.user' │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ 2. Query matching definitions (cached)  │
│    Find active definitions where ANY    │
│    supportedTriggers[].kafkaTopic       │
│    matches the incoming topic           │
│    Filter: tenantId = '__platform__'    │
│    OR tenantId = incoming tenantId      │
│    Cache: 5-min TTL, max 50 keys (LRU) │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ 3. For each matching definition:        │
│                                         │
│  a. Find the specific TriggerEntry      │
│     that matched (by kafkaTopic)        │
│                                         │
│  b. Load PipelineConfig for             │
│     (tenantId, pipelineType, projectId) │
│                                         │
│  c. Resolve active triggers:            │
│     config.activeTriggers               │
│     ?? definition.defaultTriggerIds     │
│                                         │
│  d. Is this trigger's ID in the active  │
│     set? If NO → skip this definition   │
│                                         │
│  e. Apply trigger.eventFilter           │
│     (nested field match if defined)     │
│                                         │
│  f. Validate trigger.inputSchema        │
│     against event envelope              │
│                                         │
│  g. Apply sampling rate:                │
│     triggerConfigs[triggerId].samplingRate │
│     ?? config.samplingRate ?? 1.0       │
│     Random < rate → proceed, else skip  │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ 4. Resolve strategy:                    │
│    strategyName = trigger.strategy      │
│    strategy = definition.strategies     │
│                     [strategyName]      │
│                                         │
│    Steps come from strategy.steps       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ 5. Start PipelineRun workflow:          │
│    {                                    │
│      pipelineDefinition,               │
│      matchedTriggerId: trigger.id,     │
│      executionMode: strategy            │
│                      .executionMode,    │
│      steps: strategy.steps,            │
│      pipelineInput: event,             │
│      resolvedConfig                     │
│    }                                    │
│                                         │
│ 6. Create PipelineRunRecord in MongoDB  │
│    with trigger.id + executionMode      │
└─────────────────────────────────────────┘
```

### PipelineRun Workflow Changes

The workflow itself is largely unchanged — it still walks a `steps` array sequentially, resolves config, calls `ActivityRouter`. The differences:

```typescript
// PipelineRunInput (updated)
interface PipelineRunInput {
  pipelineDefinition: PipelineDefinition;
  matchedTriggerId: string; // NEW: which trigger fired
  executionMode: 'batch' | 'realtime'; // NEW: from strategy
  steps: PipelineStep[]; // NEW: from strategy (not definition top-level)
  pipelineInput: Record<string, unknown>;
  resolvedConfig?: Record<string, unknown>;
}
```

The `executionMode` is passed through to `PipelineStepContext` so activities can access it:

```typescript
// PipelineStepContext (updated)
interface PipelineStepContext {
  tenantId: string;
  projectId?: string;
  sessionId?: string;
  executionMode: 'batch' | 'realtime'; // NEW
  triggerId: string; // NEW
  config: Record<string, unknown>; // Merged: step.config + triggerConfig stepOverrides + pipeline config
  previousSteps: Record<string, StepOutput>;
  pipelineInput: Record<string, unknown>;
}
```

### Definition Cache Update

The existing 5-min LRU cache keyed by `kafkaTopic` still works. A single definition may appear in **multiple** cache buckets (one per supported topic). Cache query changes from:

```typescript
// Before
PipelineDefinitionModel.find({
  status: 'active',
  'trigger.kafkaTopic': kafkaTopic,
});

// After
PipelineDefinitionModel.find({
  status: 'active',
  'supportedTriggers.kafkaTopic': kafkaTopic,
});
```

Cache invalidation logic is unchanged (TTL-based).

---

## 7. New Activity: read-message-window

### Purpose

Lightweight data-fetching activity for real-time trigger step chains. Fetches the triggering message (from event payload) plus a configurable sliding window of recent messages for context.

### Registration

```typescript
// In activity-metadata.ts
{
  id: 'read-message-window',
  name: 'Read Message Window',
  description: 'Fetches triggering message and recent context window for real-time processing',
  category: 'data',
  configSchema: {
    windowSize: { type: 'number', default: 5, description: 'Number of prior messages to fetch for context' },
    includeToolCalls: { type: 'boolean', default: false, description: 'Enrich with recent tool call traces' },
  },
}
```

### Input

From `pipelineInput` (the event payload):

```typescript
{
  sessionId: string;
  tenantId: string;
  payload: {
    messageId: string;
    content: string;
    messageIndex: number;
    // MessageUserPayload or MessageAgentPayload fields
  }
}
```

From step `config`:

```typescript
{
  windowSize: number; // Default: 5
  includeToolCalls: boolean; // Default: false
}
```

### Behavior

1. **Triggering message** comes directly from the event payload — **no DB fetch needed** for it.
2. **Fetch prior messages** from ClickHouse:

```sql
SELECT *
FROM abl_platform.messages
WHERE tenant_id = {tenantId}
  AND session_id = {sessionId}
  AND message_index < {triggeringMessageIndex}
ORDER BY message_index DESC
LIMIT {windowSize}
```

3. **Decrypt + decompress** the window messages using the same `decryptAndDecompress` logic as `read-conversation` (tenant-scoped AES-256-GCM).
4. **Optionally fetch tool call traces** if `includeToolCalls: true`:

```sql
SELECT *
FROM abl_platform.traces
WHERE tenant_id = {tenantId}
  AND session_id = {sessionId}
  AND event_type = 'tool_call'
  AND created_at <= {triggeringMessageTimestamp}
ORDER BY created_at DESC
LIMIT {windowSize}
```

5. **Fetch total message count** for the session (so compute steps know conversation depth):

```sql
SELECT count() as total
FROM abl_platform.messages
WHERE tenant_id = {tenantId}
  AND session_id = {sessionId}
```

### Output

```typescript
interface ReadMessageWindowOutput {
  triggeringMessage: {
    role: 'user' | 'assistant';
    content: string;
    messageIndex: number;
    messageId: string;
  };
  windowMessages: ConversationMessage[]; // Prior context, oldest first
  toolCalls?: ConversationToolCall[]; // If includeToolCalls
  metadata: {
    sessionId: string;
    agentName?: string;
    channel?: string;
    windowSize: number; // Actual window size (may be < config if early in conversation)
    totalSessionMessages: number; // Total messages in session so far
  };
}
```

### Why Not Reuse read-conversation with a Limit Parameter

- `read-conversation` returns a `transcript` string and `messages[]` assuming the full arc — different output contract.
- Compute activities for real-time need `triggeringMessage` separated from context — different data shape.
- `read-conversation` does not extract the triggering message from the event payload — it always fetches from DB.
- Keeping them separate means batch and real-time step chains are independently evolvable.

---

## 8. Existing Activity Changes

### store-results (new explicit activity)

Currently, compute activities write to ClickHouse as a side effect. This is replaced by an explicit `store-results` step in every chain.

**Registration:**

```typescript
{
  id: 'store-results',
  name: 'Store Results',
  description: 'Writes pipeline computation results to ClickHouse',
  category: 'storage',
  configSchema: {
    source: { type: 'enum', values: ['batch', 'realtime'], required: true, description: 'Source label for the results' },
  },
}
```

**Behavior:**

1. Reads output from the previous compute step via `previousSteps`
2. Determines the ClickHouse target table from `pipelineType` using the existing table mapping
3. Sets the `source` column from step config (`'batch'` or `'realtime'`)
4. For real-time runs: also sets `trigger_id`, `message_index`, `window_size` metadata columns
5. Writes to ClickHouse using the existing ClickHouse client

**Table mapping** (unchanged, just referenced by store-results):

```typescript
const PIPELINE_TABLE_MAP: Record<string, string> = {
  sentiment_analysis: 'abl_platform.conversation_sentiment',
  intent_classification: 'abl_platform.intent_classifications',
  quality_evaluation: 'abl_platform.quality_evaluations',
  hallucination_detection: 'abl_platform.hallucination_evaluations',
  knowledge_gap: 'abl_platform.knowledge_gap_evaluations',
  guardrail_analysis: 'abl_platform.guardrail_evaluations',
  friction_detection: 'abl_platform.friction_detections',
  anomaly_detection: 'abl_platform.anomaly_detections',
  drift_detection: 'abl_platform.drift_detections',
};
```

### Compute Activity Changes

Compute activities (compute-sentiment, compute-intent, conversation-analyzer, compute-statistical) need to:

1. **Remove internal ClickHouse writes** — persistence is now handled by `store-results`
2. **Support `mode` config parameter** — differentiates batch vs real-time behavior:

| Activity                | Batch Mode (default)                                          | Real-Time Mode                                                                                                                       |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `compute-sentiment`     | Scores all messages + trajectory + shift detection            | Scores single triggering message, uses window for shift detection                                                                    |
| `compute-intent`        | Classifies using full conversation with configured strategy   | `early-detection` mode: classifies using triggering message + window only                                                            |
| `conversation-analyzer` | Full conversation hallucination/guardrail/knowledge-gap audit | `single-message` mode: evaluates triggering message only. `input-check`/`output-check` for guardrail direction.                      |
| `compute-statistical`   | Full session friction trajectory                              | `single-message` mode: check triggering message for frustration signals (caps, rephrasing, escalation keywords) using window context |

3. **Accept both input shapes** — batch steps receive `read-conversation` output (transcript + messages), real-time steps receive `read-message-window` output (triggeringMessage + windowMessages). The `mode` config tells the activity which shape to expect.

### read-conversation (unchanged)

No changes needed. Continues to fetch the full session for batch strategies.

---

## 9. ClickHouse Schema Changes

### source column on all output tables

```sql
-- Applied to all 9 output tables
ALTER TABLE abl_platform.conversation_sentiment
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.message_sentiment
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.intent_classifications
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.quality_evaluations
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.hallucination_evaluations
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.knowledge_gap_evaluations
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.guardrail_evaluations
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.friction_detections
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.anomaly_detections
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';

ALTER TABLE abl_platform.drift_detections
  ADD COLUMN source LowCardinality(String) DEFAULT 'batch';
```

### Real-time metadata columns

For tables that receive per-message real-time results:

```sql
-- Tables: message_sentiment, intent_classifications, hallucination_evaluations,
--         guardrail_evaluations, friction_detections

ALTER TABLE abl_platform.<table>
  ADD COLUMN trigger_id LowCardinality(String) DEFAULT '',
  ADD COLUMN message_index UInt32 DEFAULT 0,
  ADD COLUMN window_size UInt8 DEFAULT 0;
```

- `trigger_id`: which trigger fired (e.g., `'realtime-user'`, `'batch'`)
- `message_index`: position in conversation at time of analysis
- `window_size`: how many context messages were available (enables accuracy analysis — scores with less context may differ from batch)

### Materialized view updates

Existing MVs that feed anomaly/drift detection filter to batch-only so they aren't polluted by high-frequency real-time rows:

```sql
-- Update existing MVs to filter on batch source
-- mv_daily_sentiment, mv_daily_quality_scores, etc.
-- Add WHERE source = 'batch' to each MV query
```

New real-time MVs can be added later if needed (e.g., `mv_realtime_friction_alerts` for live dashboards).

---

## 10. All Builtin Pipeline Definitions

### 10.1 Sentiment Analysis

```typescript
{
  _id: 'builtin:sentiment-analysis',
  tenantId: '__platform__',
  name: 'Sentiment Analysis',
  description: 'Per-message sentiment scoring with conversation-level trajectory analysis',
  pipelineType: 'sentiment_analysis',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'shiftThreshold', type: 'number', required: false, default: 0.3,
        validation: { min: 0, max: 1 },
        description: 'Score delta to count as a sentiment shift between consecutive messages' },
      { name: 'frustrationThreshold', type: 'number', required: false, default: -0.3,
        validation: { min: -1, max: 0 },
        description: 'Score at or below which a message is considered frustrated' },
      { name: 'defaultConfidence', type: 'number', required: false, default: 0.85,
        validation: { min: 0, max: 1 },
        description: 'Default confidence assigned to LLM sentiment results' },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Scores full conversation with trajectory analysis',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-user', type: 'kafka', kafkaTopic: 'abl.message.user', strategy: 'realtime',
      label: 'On each user message',
      description: 'Live frustration detection and per-message sentiment',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-sentiment', activity: 'compute-sentiment' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window', config: { windowSize: 5 } },
        { id: 'compute-sentiment-rt', activity: 'compute-sentiment', config: { mode: 'single-message' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.2 Intent Classification

```typescript
{
  _id: 'builtin:intent-classification',
  tenantId: '__platform__',
  name: 'Intent Classification',
  description: 'Classifies conversation intent using LLM analysis with customer-defined taxonomy or auto-discovery',
  pipelineType: 'intent_classification',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'taxonomy', type: 'array', required: false, default: [],
        description: 'Customer-defined intent taxonomy. Empty for auto-discovery mode.',
        reprocessOnChange: true,
        items: { type: 'object', properties: {
          name: { name: 'name', type: 'string', required: true, description: 'Intent identifier' },
          description: { name: 'description', type: 'string', required: true, description: 'When this intent applies' },
          displayName: { name: 'displayName', type: 'string', required: false, description: 'UI display label' },
          examples: { name: 'examples', type: 'array', required: false, description: 'Example phrases',
            items: { name: 'item', type: 'string', required: true, description: 'Example phrase' } },
          subCategories: { name: 'subCategories', type: 'array', required: false, description: 'Sub-intents',
            items: { type: 'object', properties: {
              name: { name: 'name', type: 'string', required: true, description: 'Sub-intent identifier' },
              description: { name: 'description', type: 'string', required: true, description: 'When this sub-intent applies' },
              displayName: { name: 'displayName', type: 'string', required: false, description: 'UI label' },
            }}},
        }}},
      { name: 'confidenceThreshold', type: 'number', required: false, default: 0.6,
        validation: { min: 0, max: 1 },
        description: 'Minimum confidence for a classification to be accepted' },
      { name: 'inputMessageStrategy', type: 'enum', required: false, default: 'first_n_user',
        values: ['first_n_user', 'last_n_user', 'all_user', 'all'],
        description: 'Which messages to send to the LLM for classification' },
      { name: 'inputMessageCount', type: 'number', required: false, default: 3,
        validation: { min: 1 },
        description: 'Number of messages when using first_n/last_n strategies' },
      { name: 'unknownIntentLabel', type: 'string', required: false, default: 'unknown',
        description: 'Label assigned when no intent matches the threshold' },
      { name: 'classificationPrompt', type: 'string', required: false,
        description: 'Custom system prompt override for intent classification',
        reprocessOnChange: true },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Final classification with full conversation context',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-user', type: 'kafka', kafkaTopic: 'abl.message.user', strategy: 'realtime',
      label: 'On each user message',
      description: 'Early intent detection for smart routing after first messages',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-intent', activity: 'compute-intent' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window', config: { windowSize: 3 } },
        { id: 'compute-intent-rt', activity: 'compute-intent', config: { mode: 'early-detection' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.3 Quality Evaluation (Batch Only)

```typescript
{
  _id: 'builtin:quality-evaluation',
  tenantId: '__platform__',
  name: 'Quality Evaluation',
  description: 'LLM-as-judge quality evaluation with configurable rubric dimensions',
  pipelineType: 'quality_evaluation',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'dimensions', type: 'array', required: false,
        description: 'Custom evaluation dimensions. Empty uses platform defaults.',
        reprocessOnChange: true,
        items: { type: 'object', properties: {
          name: { name: 'name', type: 'string', required: true, description: 'Dimension identifier' },
          displayName: { name: 'displayName', type: 'string', required: true, description: 'UI label' },
          description: { name: 'description', type: 'string', required: true, description: 'What this dimension measures' },
          scale: { name: 'scale', type: 'object', required: true, description: 'Score range',
            items: { type: 'object', properties: {
              min: { name: 'min', type: 'number', required: true, description: 'Minimum score' },
              max: { name: 'max', type: 'number', required: true, description: 'Maximum score' },
            }}},
          weight: { name: 'weight', type: 'number', required: true, description: 'Relative weight in aggregate score' },
          criteria: { name: 'criteria', type: 'array', required: false, description: 'Scoring criteria',
            items: { name: 'criterion', type: 'string', required: true, description: 'A criterion' } },
        }}},
      { name: 'domainContext', type: 'string', required: false,
        description: 'Additional domain context injected into the quality evaluation prompt' },
      { name: 'flagThreshold', type: 'number', required: false, default: 2.5,
        validation: { min: 0, max: 5 },
        description: 'Average score at or below which a conversation is flagged' },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Evaluates full conversation quality after session completes',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-quality', activity: 'compute-quality' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.4 Hallucination Detection

```typescript
{
  _id: 'builtin:hallucination-detection',
  tenantId: '__platform__',
  name: 'Hallucination Detection',
  description: 'Detects unsupported claims, self-contradictions, and factual accuracy issues in agent responses',
  pipelineType: 'hallucination_detection',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'flagThreshold', type: 'number', required: false,
        description: 'Score threshold for flagging a response as hallucinated' },
      { name: 'systemPromptOverride', type: 'string', required: false,
        description: 'Override the system prompt for hallucination evaluation',
        reprocessOnChange: true },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Full conversation hallucination audit',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-agent', type: 'kafka', kafkaTopic: 'abl.message.agent', strategy: 'realtime',
      label: 'On each agent response',
      description: 'Per-response hallucination detection with tool call context',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-hallucination', activity: 'conversation-analyzer',
          config: { evaluationType: 'hallucination' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window',
          config: { windowSize: 5, includeToolCalls: true } },
        { id: 'compute-hallucination-rt', activity: 'conversation-analyzer',
          config: { evaluationType: 'hallucination', mode: 'single-message' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.5 Knowledge Gap Analysis (Batch Only)

```typescript
{
  _id: 'builtin:knowledge-gap-analysis',
  tenantId: '__platform__',
  name: 'Knowledge Gap Analysis',
  description: 'Identifies gaps in knowledge base coverage by analyzing retrieval precision and uncovered topics',
  pipelineType: 'knowledge_gap',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'flagThreshold', type: 'number', required: false,
        description: 'Score threshold for flagging a knowledge gap' },
      { name: 'systemPromptOverride', type: 'string', required: false,
        description: 'Override the system prompt for knowledge gap evaluation',
        reprocessOnChange: true },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Analyzes full conversation for knowledge gaps',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-knowledge-gap', activity: 'conversation-analyzer',
          config: { evaluationType: 'knowledge_gap' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.6 Guardrail Analysis

```typescript
{
  _id: 'builtin:guardrail-analysis',
  tenantId: '__platform__',
  name: 'Guardrail Analysis',
  description: 'Evaluates guardrail effectiveness — detects false positives, false negatives, and bypass attempts',
  pipelineType: 'guardrail_analysis',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'flagThreshold', type: 'number', required: false,
        description: 'Score threshold for flagging a guardrail violation' },
      { name: 'systemPromptOverride', type: 'string', required: false,
        description: 'Override the system prompt for guardrail evaluation',
        reprocessOnChange: true },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Full session guardrail effectiveness analysis',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-user', type: 'kafka', kafkaTopic: 'abl.message.user', strategy: 'realtime-input',
      label: 'On each user message',
      description: 'Detect jailbreak attempts and adversarial inputs',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-agent', type: 'kafka', kafkaTopic: 'abl.message.agent', strategy: 'realtime-output',
      label: 'On each agent response',
      description: 'Detect guardrail bypass in agent outputs',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-guardrail', activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    'realtime-input': {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window', config: { windowSize: 3 } },
        { id: 'compute-guardrail-input', activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail', mode: 'input-check' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
    'realtime-output': {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window', config: { windowSize: 3 } },
        { id: 'compute-guardrail-output', activity: 'conversation-analyzer',
          config: { evaluationType: 'guardrail', mode: 'output-check' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.7 Friction Detection

```typescript
{
  _id: 'builtin:friction-detection',
  tenantId: '__platform__',
  name: 'Friction Detection',
  description: 'Detects user frustration signals — rephrased questions, message escalation, caps, exclamation patterns',
  pipelineType: 'friction_detection',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'metricTable', type: 'string', required: false,
        description: 'ClickHouse table to read metrics from' },
      { name: 'metricColumn', type: 'string', required: false,
        description: 'Column name containing the metric value' },
      { name: 'lookbackDays', type: 'number', required: false, default: 30,
        validation: { min: 1 },
        description: 'Number of days to look back for baseline calculation' },
    ]
  },

  supportedTriggers: [
    { id: 'batch', type: 'kafka', kafkaTopic: 'abl.session.ended', strategy: 'batch',
      label: 'On session end',
      description: 'Full trajectory friction analysis',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
    { id: 'realtime-user', type: 'kafka', kafkaTopic: 'abl.message.user', strategy: 'realtime',
      label: 'On each user message',
      description: 'Live frustration signal detection (rephrasing, caps, escalation keywords)',
      inputSchema: { required: ['tenantId', 'sessionId'], properties: {
        tenantId: { type: 'string' }, sessionId: { type: 'string' } } } },
  ],
  defaultTriggerIds: ['batch'],

  strategies: {
    batch: {
      executionMode: 'batch',
      steps: [
        { id: 'read-conversation', activity: 'read-conversation' },
        { id: 'compute-friction', activity: 'compute-statistical',
          config: { analysisType: 'friction_detection' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
    realtime: {
      executionMode: 'realtime',
      steps: [
        { id: 'read-window', activity: 'read-message-window', config: { windowSize: 5 } },
        { id: 'compute-friction-rt', activity: 'compute-statistical',
          config: { analysisType: 'friction_detection', mode: 'single-message' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'realtime' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.8 Anomaly Detection (Schedule Only)

```typescript
{
  _id: 'builtin:anomaly-detection',
  tenantId: '__platform__',
  name: 'Anomaly Detection',
  description: 'Monitors analytics metrics for statistical anomalies using z-score and SPC control charts',
  pipelineType: 'anomaly_detection',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'metricTable', type: 'string', required: false,
        description: 'ClickHouse table to read metrics from' },
      { name: 'metricColumn', type: 'string', required: false,
        description: 'Column name containing the metric value' },
      { name: 'lookbackDays', type: 'number', required: false, default: 30,
        validation: { min: 1 },
        description: 'Number of days to look back for baseline calculation' },
    ]
  },

  supportedTriggers: [
    { id: 'hourly', type: 'schedule', schedule: '0 * * * *', strategy: 'scheduled',
      label: 'Hourly',
      description: 'Hourly anomaly scan over aggregated metrics' },
  ],
  defaultTriggerIds: ['hourly'],

  strategies: {
    scheduled: {
      executionMode: 'batch',
      steps: [
        { id: 'detect-anomalies', activity: 'compute-statistical',
          config: { analysisType: 'anomaly_detection' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.9 Drift Detection (Schedule Only)

```typescript
{
  _id: 'builtin:drift-detection',
  tenantId: '__platform__',
  name: 'Drift Detection',
  description: 'Monitors analytics metrics for gradual performance drift by comparing baseline and current windows',
  pipelineType: 'drift_detection',
  version: 1,
  status: 'active',

  configSchema: {
    fields: [
      { name: 'metricTable', type: 'string', required: false,
        description: 'ClickHouse table to read metrics from' },
      { name: 'metricColumn', type: 'string', required: false,
        description: 'Column name containing the metric value' },
      { name: 'lookbackDays', type: 'number', required: false, default: 30,
        validation: { min: 1 },
        description: 'Number of days to look back for baseline calculation' },
    ]
  },

  supportedTriggers: [
    { id: 'daily', type: 'schedule', schedule: '0 0 * * *', strategy: 'scheduled',
      label: 'Daily',
      description: 'Daily drift analysis comparing baseline vs current windows' },
  ],
  defaultTriggerIds: ['daily'],

  strategies: {
    scheduled: {
      executionMode: 'batch',
      steps: [
        { id: 'detect-drift', activity: 'compute-statistical',
          config: { analysisType: 'drift_detection' } },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  createdBy: 'system',
}
```

### 10.10 Eval Run (Manual Only)

```typescript
{
  _id: 'eval-run-pipeline',
  tenantId: '__platform__',
  name: 'Evaluation Run',
  description: 'Execute persona x scenario x evaluator matrix evaluation with bias mitigation and trajectory scoring',
  pipelineType: 'simulation',
  version: 1,
  status: 'active',

  configSchema: {
    fields: []  // Shared fields only (model, provider, samplingRate)
  },

  supportedTriggers: [
    { id: 'manual', type: 'manual', strategy: 'eval',
      label: 'Manual',
      description: 'Triggered from Studio or API for evaluation runs' },
  ],
  defaultTriggerIds: ['manual'],

  strategies: {
    eval: {
      executionMode: 'batch',
      steps: [
        { id: 'run-conversations', activity: 'run-eval-conversation', parallel: true },
        { id: 'judge-conversations', activity: 'judge-conversation', parallel: true },
        { id: 'aggregate-results', activity: 'aggregate-eval-run' },
        { id: 'store-results', activity: 'store-results', config: { source: 'batch' } },
      ],
    },
  },

  createdBy: 'system',
}
```

---

## 11. Config Schema in Definitions

### How It Replaces Existing Infrastructure

| Before                                                    | After                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `config-schemas.ts` — static Zod schemas per pipelineType | `definition.configSchema` — schema embedded in definition                        |
| `PIPELINE_CONFIG_SCHEMAS` registry — hardcoded map        | Dynamic lookup: load definition → `buildZodSchema(definition.configSchema)`      |
| `PLATFORM_DEFAULTS` — pre-computed default objects        | `getPlatformDefaults(definition)` — derived from `configSchema.fields[].default` |
| Hardcoded reprocessing field lists                        | `configSchema.fields.filter(f => f.reprocessOnChange)`                           |
| Studio must hardcode config forms per pipeline type       | Studio reads `configSchema.fields` and renders dynamically                       |
| Custom pipelines cannot declare config needs              | Custom definitions include their own `configSchema`                              |

### Shared Config Fields (Auto-Injected)

Every pipeline implicitly has these fields — they do not need to be declared in `configSchema.fields`:

```typescript
const SHARED_CONFIG_FIELDS: ConfigField[] = [
  {
    name: 'model',
    type: 'string',
    required: false,
    description: 'LLM model override (e.g., gpt-4o, claude-sonnet)',
    reprocessOnChange: true,
  },
  {
    name: 'provider',
    type: 'string',
    required: false,
    description: 'LLM provider override',
    reprocessOnChange: true,
  },
  {
    name: 'samplingRate',
    type: 'number',
    required: false,
    default: 1.0,
    validation: { min: 0, max: 1 },
    description: 'Fraction of events to process (1.0 = all)',
  },
  {
    name: 'stepOverrides',
    type: 'object',
    required: false,
    default: {},
    description: 'Per-step config overrides keyed by step ID',
  },
  {
    name: 'timeoutOverrides',
    type: 'object',
    required: false,
    default: {},
    description: 'Per-step timeout overrides in ms keyed by step ID',
  },
];
```

### Dynamic Zod Schema Builder

```typescript
function buildZodSchema(configSchema: { fields: ConfigField[] }): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of configSchema.fields) {
    let zodField: z.ZodTypeAny;

    switch (field.type) {
      case 'string':
        zodField = z.string();
        break;
      case 'number': {
        let numField = z.number();
        if (field.validation?.min !== undefined) numField = numField.min(field.validation.min);
        if (field.validation?.max !== undefined) numField = numField.max(field.validation.max);
        zodField = numField;
        break;
      }
      case 'boolean':
        zodField = z.boolean();
        break;
      case 'enum':
        zodField = z.enum(field.values as [string, ...string[]]);
        break;
      case 'array':
        zodField = z.array(buildItemSchema(field.items));
        break;
      case 'object':
        zodField = z.record(z.string(), z.unknown());
        break;
    }

    if (!field.required) zodField = zodField.optional();
    if (field.default !== undefined) zodField = zodField.default(field.default);

    shape[field.name] = zodField;
  }

  // Inject shared fields
  return z.object({
    model: z.string().optional(),
    provider: z.string().optional(),
    samplingRate: z.number().min(0).max(1).default(1.0),
    stepOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    timeoutOverrides: z.record(z.string(), z.number()).default({}),
    ...shape,
  });
}

function buildItemSchema(items: ConfigField['items']): z.ZodTypeAny {
  if (!items) return z.unknown();

  if ('properties' in items) {
    // Object items with defined properties
    const objShape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propField] of Object.entries(items.properties)) {
      let propZod = buildFieldSchema(propField);
      if (!propField.required) propZod = propZod.optional();
      objShape[key] = propZod;
    }
    return z.object(objShape);
  }

  // Simple typed items
  return buildFieldSchema(items as ConfigField);
}

function buildFieldSchema(field: ConfigField): z.ZodTypeAny {
  switch (field.type) {
    case 'string':
      return z.string();
    case 'number': {
      let n = z.number();
      if (field.validation?.min !== undefined) n = n.min(field.validation.min);
      if (field.validation?.max !== undefined) n = n.max(field.validation.max);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(field.values as [string, ...string[]]);
    case 'array':
      return z.array(buildItemSchema(field.items));
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
```

### Config Validation Flow (Updated)

```
Customer saves config via PUT /pipeline-config/:pipelineType
    │
    ▼
1. Load pipeline definition by pipelineType
    │
    ▼
2. Build Zod schema: buildZodSchema(definition.configSchema)
    │
    ▼
3. Validate incoming config against Zod schema
   - Invalid → 400 with Zod error details
   - Valid → apply defaults from schema
    │
    ▼
4. Validate activeTriggers (if provided):
   - Must be subset of definition.supportedTriggers[].id
   - Invalid IDs → 400 with list of valid trigger IDs
    │
    ▼
5. Check reprocessing:
   - Compare old vs new config
   - Check fields with reprocessOnChange: true
   - Set configHistory entry with reprocessingRequired flag
    │
    ▼
6. Save to MongoDB with version increment
```

---

## 12. API Changes

### Existing Endpoints (Updated)

**`GET /api/projects/:projectId/pipeline-config/:pipelineType`**

Response now includes `activeTriggers` and `triggerConfigs`:

```typescript
{
  tenantId: string;
  pipelineType: string;
  enabled: boolean;
  activeTriggers: string[];              // Resolved: config value or definition defaults
  triggerConfigs: Record<string, { samplingRate?: number; stepOverrides?: Record<string, unknown> }>;
  config: Record<string, unknown>;       // Pipeline-specific config values
  // ... existing fields
}
```

**`PUT /api/projects/:projectId/pipeline-config/:pipelineType`**

Request body accepts new fields:

```typescript
{
  config: Record<string, unknown>;       // Validated against definition.configSchema
  activeTriggers?: string[];             // Validated as subset of definition.supportedTriggers[].id
  triggerConfigs?: Record<string, {
    samplingRate?: number;
    stepOverrides?: Record<string, unknown>;
  }>;
}
```

### New Endpoints

**`GET /api/projects/:projectId/pipeline-config/:pipelineType/triggers`**

Returns available triggers with their active/inactive state. For Studio UI to render trigger toggles.

```typescript
// Response
{
  triggers: Array<{
    id: string;
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    schedule?: string;
    label: string;
    description: string;
    strategy: string;
    executionMode: 'batch' | 'realtime';
    active: boolean;                     // Is this trigger currently enabled?
    samplingRate: number;                // Effective sampling rate for this trigger
  }>;
  defaultTriggerIds: string[];           // Definition defaults
}
```

**`GET /api/projects/:projectId/pipeline-config/:pipelineType/schema`**

Returns the config schema for Studio to render dynamic config forms.

```typescript
// Response
{
  fields: ConfigField[];                 // Pipeline-specific fields
  sharedFields: ConfigField[];           // model, provider, samplingRate, etc.
}
```

---

## 13. EventSubscriptionRegistry Changes

### Current Behavior

`findKafkaSubscriptions()` queries definitions by `trigger.kafkaTopic` and joins with enabled configs to build `Map<tenantId, Set<kafkaTopic>>`. The RuntimeEventBus only produces events to Kafka for topics in this map.

### Updated Behavior

Query changes to use `supportedTriggers.kafkaTopic` and cross-reference with `activeTriggers`:

```typescript
async function findKafkaSubscriptions(): Promise<Map<string, Set<string>>> {
  // 1. Get all active definitions with kafka triggers
  const definitions = await PipelineDefinitionModel.find({
    status: 'active',
    'supportedTriggers.type': 'kafka',
  }).lean();

  // 2. Get all enabled configs
  const configs = await PipelineConfigModel.find({ enabled: true }).lean();

  // 3. Build tenant → topics map
  const subscriptions = new Map<string, Set<string>>();

  for (const config of configs) {
    const definition = definitions.find(
      (d) =>
        d.pipelineType === config.pipelineType &&
        (d.tenantId === '__platform__' || d.tenantId === config.tenantId),
    );
    if (!definition) continue;

    // Resolve which triggers are active for this tenant
    const activeTriggerIds = config.activeTriggers ?? definition.defaultTriggerIds;
    const activeTriggers = definition.supportedTriggers.filter(
      (t) => t.type === 'kafka' && activeTriggerIds.includes(t.id),
    );

    // Add each active trigger's topic to the subscription set
    const tenantId = config.tenantId;
    if (!subscriptions.has(tenantId)) {
      subscriptions.set(tenantId, new Set());
    }
    for (const trigger of activeTriggers) {
      if (trigger.kafkaTopic) {
        subscriptions.get(tenantId)!.add(trigger.kafkaTopic);
      }
    }
  }

  return subscriptions;
}
```

This ensures:

- Only topics with active triggers produce events to Kafka
- If a customer enables `realtime-user` trigger, `abl.message.user` gets added to their subscription set
- If no customer has real-time triggers active, those events are never produced — zero wasted Kafka traffic

---

## 14. Migration Script

### scripts/migrate-pipeline-triggers.ts

```typescript
/**
 * One-time migration from old pipeline format to new multi-trigger format.
 *
 * Run: npx ts-node scripts/migrate-pipeline-triggers.ts
 *
 * Steps:
 * 1. Fetch all pipeline definitions
 * 2. Convert old format (trigger + steps) to new format (supportedTriggers + strategies)
 * 3. Update documents in MongoDB
 * 4. Fetch all pipeline configs
 * 5. Set activeTriggers to definition's defaultTriggerIds
 * 6. Save configs
 */
```

### Migration logic for definitions

```typescript
// For each definition with old format:
if (definition.trigger && definition.steps && !definition.supportedTriggers) {
  const newDef = {
    ...definition,

    supportedTriggers: [
      {
        id: 'default',
        type: definition.trigger.type,
        kafkaTopic: definition.trigger.kafkaTopic,
        eventFilter: definition.trigger.eventFilter,
        schedule: definition.trigger.schedule,
        strategy: 'default',
        label: triggerTypeToLabel(definition.trigger),
        description: `Migrated from legacy single-trigger format`,
        inputSchema: definition.inputSchema,
      },
    ],

    defaultTriggerIds: ['default'],

    strategies: {
      default: {
        executionMode: 'batch',
        steps: definition.steps,
        onStepFailure: definition.onStepFailure ?? 'stop',
      },
    },

    configSchema: {
      fields: getConfigFieldsForPipelineType(definition.pipelineType),
    },
  };

  // Remove old fields
  delete newDef.trigger;
  delete newDef.steps;
  delete newDef.inputSchema;
  delete newDef.onStepFailure;

  await PipelineDefinitionModel.replaceOne({ _id: definition._id }, newDef);
}
```

### Migration logic for configs

```typescript
// For each config without activeTriggers:
if (!config.activeTriggers) {
  const definition = definitions.find((d) => d.pipelineType === config.pipelineType);
  if (definition) {
    await PipelineConfigModel.updateOne(
      { _id: config._id },
      { $set: { activeTriggers: definition.defaultTriggerIds } },
    );
  }
}
```

### Order of Operations

1. Stop pipeline-engine service
2. Run migration script: `npx ts-node scripts/migrate-pipeline-triggers.ts`
3. Deploy new code (new types, new schema, new indexes)
4. Run seed script to update builtin definitions with full multi-trigger definitions
5. Start pipeline-engine service

---

## 15. Files Affected

### packages/pipeline-engine/

| File                                                | Change                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/pipeline/types.ts`                             | Replace `PipelineDefinition.trigger` + `steps` with `supportedTriggers` + `strategies` + `configSchema`. Add `TriggerEntry`, `ExecutionStrategy`, `ConfigField` types. Update `PipelineRunInput` with `matchedTriggerId`, `executionMode`, `steps`. Update `PipelineStepContext` with `executionMode`, `triggerId`. |
| `src/schemas/pipeline-definition.schema.ts`         | New Mongoose schemas for `TriggerEntry`, `ExecutionStrategy`, `ConfigField`. Remove old `trigger`/`steps`/`inputSchema`/`onStepFailure` fields. New index on `supportedTriggers.kafkaTopic`.                                                                                                                        |
| `src/schemas/pipeline-config.schema.ts`             | Add `activeTriggers: [String]` and `triggerConfigs: Map` fields.                                                                                                                                                                                                                                                    |
| `src/schemas/pipeline-run-record.schema.ts`         | Add `triggerId` and `executionMode` to `trigger` sub-document.                                                                                                                                                                                                                                                      |
| `src/pipeline/config-schemas.ts`                    | **Replace entirely** with `buildZodSchema()` dynamic builder that reads from `definition.configSchema`. Remove `PIPELINE_CONFIG_SCHEMAS` static registry.                                                                                                                                                           |
| `src/pipeline/config-defaults.ts`                   | **Replace entirely** with `getPlatformDefaults(definition)` that derives defaults from `configSchema.fields[].default`. Remove `PLATFORM_DEFAULTS` static object.                                                                                                                                                   |
| `src/pipeline/services/pipeline-config.service.ts`  | Update `resolveConfig()` to use dynamic Zod schemas. Add `resolveActiveTriggers()` and `resolveSamplingRate()`. Update `requiresReprocessing()` to use `reprocessOnChange` flag from `configSchema`.                                                                                                                |
| `src/pipeline/handlers/pipeline-trigger.service.ts` | Update `handleEvent()`: query by `supportedTriggers.kafkaTopic`, resolve active triggers from config, resolve strategy from matched trigger, pass `matchedTriggerId` + `executionMode` + `strategy.steps` to `PipelineRun`. Update `findActivePipelinesForEvent()` for new query pattern.                           |
| `src/pipeline/handlers/pipeline-run.workflow.ts`    | Accept `steps` from input (not from `definition.steps`). Pass `executionMode` and `triggerId` through to `PipelineStepContext`.                                                                                                                                                                                     |
| `src/pipeline/handlers/activity-router.service.ts`  | Add `executionMode` and `triggerId` to `PipelineStepContext` assembly. Merge `triggerConfigs[triggerId].stepOverrides` into step config.                                                                                                                                                                            |
| `src/pipeline/handlers/pipeline-scheduler.ts`       | Update to read schedule from `supportedTriggers` instead of `trigger.schedule`.                                                                                                                                                                                                                                     |
| `src/pipeline/validation.ts`                        | Update trigger validation for new `supportedTriggers` array shape. Add `activeTriggers` subset validation.                                                                                                                                                                                                          |
| `src/pipeline/definitions/*.ts`                     | **Rewrite all 10 definitions** to new format with `supportedTriggers`, `strategies`, `configSchema`, `defaultTriggerIds`. Add real-time triggers + strategies where applicable. Add explicit `store-results` step to all strategies.                                                                                |
| `src/pipeline/activity-metadata.ts`                 | Register `read-message-window` and `store-results` activities.                                                                                                                                                                                                                                                      |
| `src/pipeline/activities/read-message-window.ts`    | **New file.** Implements `read-message-window` activity.                                                                                                                                                                                                                                                            |
| `src/pipeline/activities/store-results.ts`          | **New file.** Implements `store-results` activity.                                                                                                                                                                                                                                                                  |
| `src/pipeline/activities/compute-sentiment.ts`      | Add `mode: 'single-message'` support. Remove internal ClickHouse writes.                                                                                                                                                                                                                                            |
| `src/pipeline/activities/compute-intent.ts`         | Add `mode: 'early-detection'` support. Remove internal ClickHouse writes.                                                                                                                                                                                                                                           |
| `src/pipeline/activities/conversation-analyzer.ts`  | Add `mode: 'single-message'`, `'input-check'`, `'output-check'` support. Remove internal ClickHouse writes.                                                                                                                                                                                                         |
| `src/pipeline/activities/compute-statistical.ts`    | Add `mode: 'single-message'` support for friction. Remove internal ClickHouse writes.                                                                                                                                                                                                                               |

### apps/runtime/

| File                                                    | Change                                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/event-bus/event-subscription-registry.ts` | Update `findKafkaSubscriptions()` to query `supportedTriggers.kafkaTopic` and cross-reference with config `activeTriggers`.                                                  |
| `src/routes/pipeline-config.ts`                         | Add `activeTriggers` and `triggerConfigs` to PUT handler. Add new `GET /:pipelineType/triggers` and `GET /:pipelineType/schema` endpoints. Validate `activeTriggers` subset. |

### scripts/

| File                                   | Change                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `scripts/seed-pipelines.ts`            | Update to seed new-format definitions with `supportedTriggers`, `strategies`, `configSchema`. |
| `scripts/migrate-pipeline-triggers.ts` | **New file.** One-time migration from old to new format.                                      |

### ClickHouse migrations

| Change                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add `source LowCardinality(String) DEFAULT 'batch'` to all 10 output tables                                                                                                                                                                                  |
| Add `trigger_id LowCardinality(String) DEFAULT ''`, `message_index UInt32 DEFAULT 0`, `window_size UInt8 DEFAULT 0` to per-message tables (message_sentiment, intent_classifications, hallucination_evaluations, guardrail_evaluations, friction_detections) |
| Update materialized views (mv_daily_sentiment, mv_daily_quality_scores) to add `WHERE source = 'batch'` filter                                                                                                                                               |
