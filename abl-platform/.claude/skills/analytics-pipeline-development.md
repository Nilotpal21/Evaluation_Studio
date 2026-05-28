---
name: analytics-pipeline-development
description: Use when designing, implementing, or reviewing any analytics pipeline for the ABL Platform — intent classification, sentiment analysis, LLM-as-judge quality evaluation, anomaly detection, knowledge gap analysis, hallucination detection, drift detection, NL-to-SQL, or any new derived-metric pipeline. Covers the 5-phase checklist from input data audit through presentation and indexing.
---

# Analytics Pipeline Development

Every analytics pipeline in ABL Platform follows a **5-phase design checklist** before implementation begins. Do NOT skip phases — each feeds the next. The output of this checklist is a pipeline specification document that guides implementation.

## Reference Documents

- Pipeline catalog and query mapping: `/abl-review/metrics/simple-query-vs-pipeline-analysis.md`
- Data readiness audit: `/abl-review/metrics/pipeline-input-data-readiness.md`
- Query classification: `/abl-review/metrics/customer-queries-by-data-source.md`

## Platform Data Architecture (Quick Reference)

| Store                                        | Tables / Collections   | Key Fields                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ClickHouse** `abl_platform.messages`       | Full conversation text | `tenant_id`, `session_id`, `message_id`, `role` (user/assistant/system/tool), `content` (AES-256 encrypted), `channel`, `created_at`, `trace_id`, `has_pii`, `metadata` (JSON: tokens, model, latency)                 |
| **ClickHouse** `abl_platform.traces`         | 22 trace event types   | `tenant_id`, `session_id`, `trace_id`, `span_id`, `parent_span_id`, `event_type`, `agent_name`, `data` (JSON, encrypted), `duration_ms`, `has_error`, `error_message`                                                  |
| **ClickHouse** `abl_platform.llm_metrics`    | LLM call metrics       | `tenant_id`, `session_id`, `model_id`, `provider`, `agent_name`, `input_tokens`, `output_tokens`, `estimated_cost`, `latency_ms`, `success` — with hourly + daily MVs                                                  |
| **ClickHouse** `abl_platform.search_queries` | SearchAI queries       | `tenant_id`, `session_id`, `query_text`, `query_type`, `result_count`, `results_json`, `feedback_score`, `click_position`, latency breakdown fields                                                                    |
| **ClickHouse** `abl_platform.audit_events`   | Audit trail            | `tenant_id`, actor, resource, action, timestamp                                                                                                                                                                        |
| **MongoDB** `sessions`                       | Session metadata       | `tenantId`, `projectId`, `channel`, `currentAgent`, `agentVersion`, `status` (active/completed/abandoned/escalated), `disposition`, `messageCount`, `tokenCount`, `estimatedCost`, `contactId`, `customerId`, `tags[]` |
| **MongoDB** `search_chunks`                  | KB chunk content       | `content`, `tokenCount`, `vectorId`, `canonicalMetadata`, `classification`                                                                                                                                             |
| **MongoDB** `search_documents`               | KB document metadata   | `extractedText`, `entities[]`, `summary`, `classification`, `sourceUrl`                                                                                                                                                |

### Trace Event Payloads Available

| Event Type          | Key Data Fields                                                               |
| ------------------- | ----------------------------------------------------------------------------- |
| `llm_call`          | `model`, `prompt`, `response`, `inputTokens`, `outputTokens`, `temperature`   |
| `tool_call`         | `toolName`, `arguments`, `result`, `success`, `errorMessage`, `retryCount`    |
| `decision`          | `decisionType`, `options`, `chosen`, `reasoning`, `confidence`                |
| `constraint_check`  | `constraintName`, `constraintType`, `passed`, `value`, `message`              |
| `handoff`           | `fromAgent`, `toAgent`, `reason`, `context`                                   |
| `escalation`        | `reason`, `severity` (low/medium/high/critical), `context`                    |
| `entity_extraction` | `entities[{name, value, source, confidence}]`, `rawInput`                     |
| `flow_step_enter`   | `stepId`, `stepType` (respond/wait_input/if/goto/action/signal)               |
| `flow_step_exit`    | `stepId`, `outcome` (success/condition_false/error)                           |
| `flow_transition`   | `fromStep`, `toStep`, `trigger`, `matchedIntent`, `condition`                 |
| `session_start`     | `userId`, `channel`, `initialContext`                                         |
| `session_end`       | `reason` (completed/timeout/error/user_exit), `totalDurationMs`, `totalTurns` |
| `agent_enter`       | `mode` (scripted/reasoning), `trigger`, `inputMessage`                        |
| `agent_exit`        | `mode`, `result` (complete/handoff/escalate/error), `response`                |

### Encryption & Tenant Isolation

- `messages.content` and `traces.data` are AES-256-GCM encrypted per tenant
- Decryption: `EncryptionService.decryptAndDecompressForTenant(data, tenantId)`
- **Every query MUST include `tenant_id`** — this is a core invariant
- TTLs: Messages 90 days, Traces 90 days (7d warm / 30d cold), LLM metrics 730 days
- Pipeline processing must respect TTLs — don't assume data older than 90 days exists

---

## Phase 1: Input Data Readiness Audit

**Goal**: Determine if the platform currently captures enough data for this pipeline to produce meaningful output. Identify gaps that block implementation vs gaps that degrade quality.

### Checklist

```
□ 1.1  List every input field the pipeline needs (exact table.column references)
□ 1.2  For each field, verify it exists and is populated (not just schema-defined)
□ 1.3  Check data volume — is there enough historical data for meaningful analysis?
□ 1.4  Check data freshness — what's the latency from event to queryable?
□ 1.5  Identify BLOCKING gaps (pipeline cannot run without this data)
□ 1.6  Identify DEGRADING gaps (pipeline runs but with lower quality)
□ 1.7  For each gap, determine: instrument at write-time vs derive from existing data
□ 1.8  Check trace verbosity impact — which inputs are only available at standard+ verbosity?
□ 1.9  Check encryption impact — does the pipeline need to decrypt data? At what scale?
□ 1.10 Check TTL impact — will data expire before the pipeline processes it?
```

### Input Data Categories

Every pipeline consumes one or more of these data types:

| Category                   | Description                                                    | Typical Source                           |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| **Conversation Text**      | Full user + agent message content                              | `messages` table (encrypted)             |
| **Trace Spans**            | Execution events with timing and payloads                      | `traces` table (encrypted `data` field)  |
| **Aggregated Metrics**     | Pre-computed rollups (token counts, latency P95)               | `llm_metrics` MVs, OTEL exports          |
| **Session Metadata**       | Session-level attributes (channel, agent, status)              | MongoDB `sessions` collection            |
| **Knowledge Base Content** | Document chunks, embeddings, search results                    | `search_chunks`, `search_queries`        |
| **Pipeline Outputs**       | Results from other pipelines (intent labels, sentiment scores) | Pipeline output tables (see Phase 3)     |
| **Customer Configuration** | Thresholds, taxonomies, rubrics, cost inputs                   | Pipeline config collection (see Phase 2) |

### Dependency Analysis

Before building, determine if this pipeline depends on another pipeline's output:

```
Pipeline dependency graph:
  Intent Classification  ← no dependencies (reads messages directly)
  Sentiment Analysis     ← no dependencies (reads messages directly)
  LLM-as-Judge Quality   ← no dependencies (reads messages + traces directly)
  Anomaly Detection      ← depends on: Phase 1 outcome heuristic, optionally Intent + Quality
  NL-to-SQL              ← enriched by: all other pipeline output tables
  Knowledge Gap Analysis ← depends on: Intent Classification (for topic grouping)
  Hallucination Detection← no hard dependencies (reads messages + traces)
  Predictive ML          ← depends on: Intent + Quality + Sentiment + Phase 1 outcomes
  Embedding/Drift        ← no dependencies (reads messages directly)
  Simulation             ← no dependencies (reads agent definitions + runtime)
  Guardrail FP/FN        ← depends on: guardrail system existing
```

### Data Volume Estimation

For each pipeline, estimate processing load:

```
conversations_per_day = daily session count (from traces)
messages_per_conversation = avg ~8-12 turns
llm_calls_per_conversation = avg ~3-5

Example for Intent Classification:
  Input: ~1 message per conversation (first user message)
  Volume: conversations_per_day × 1 LLM call (or embedding + classifier)
  Cost: ~$0.001-0.01 per classification (depending on model)
  Latency: <2s per classification

Example for LLM-as-Judge Quality:
  Input: full transcript (~8-12 messages) per conversation
  Volume: conversations_per_day × 1 LLM call per evaluation dimension
  Cost: ~$0.01-0.05 per conversation (depending on rubric complexity)
  Latency: ~5-15s per evaluation
```

### Readiness Assessment Template

Produce a table like this for every pipeline:

```markdown
| Input Field       | Source           | Available? | Populated? | Gap Type  | Mitigation                               |
| ----------------- | ---------------- | ---------- | ---------- | --------- | ---------------------------------------- |
| user_message_text | messages.content | YES        | YES (100%) | —         | —                                        |
| session_outcome   | sessions.status  | YES        | PARTIAL    | DEGRADING | Add heuristic: no escalation = contained |
| intent_label      | pipeline_output  | NO         | —          | BLOCKING  | Must build Intent pipeline first         |
```

---

## Phase 2: Customer Configuration Schema

**Goal**: Identify every parameter the customer should be able to customize. Design the configuration schema. Store it per-tenant (and optionally per-project) in MongoDB.

### Checklist

```
□ 2.1  List all tunable parameters for this pipeline
□ 2.2  Classify each: REQUIRED (customer must set) vs OPTIONAL (platform provides default)
□ 2.3  Define sensible platform defaults for all OPTIONAL parameters
□ 2.4  Design the MongoDB schema for pipeline configuration
□ 2.5  Define validation rules (min/max, enum values, required fields)
□ 2.6  Determine scope: tenant-level, project-level, or agent-level configuration
□ 2.7  Plan configuration versioning (when customer changes config, do we re-run?)
□ 2.8  Identify parameters that require pipeline re-processing when changed
□ 2.9  Identify parameters that only affect future processing (no backfill needed)
□ 2.10 Design the Studio UI for configuration (inputs, defaults, help text)
```

### Common Configuration Categories

Every pipeline has some combination of these:

#### A. Processing Scope & Filters

```typescript
interface PipelineScopeConfig {
  // Which conversations to process
  channels?: string[]; // ['web_chat', 'voice'] — empty = all
  agents?: string[]; // ['BillingAgent'] — empty = all
  minMessageCount?: number; // Skip very short conversations (default: 2)
  excludeTags?: string[]; // Skip conversations with these tags
  sampleRate?: number; // 0.0-1.0 — process a sample (default: 1.0 = all)

  // Time window
  lookbackDays?: number; // For initial backfill (default: 30)
  processingDelay?: number; // Wait N minutes after session_end before processing (default: 5)
}
```

#### B. Model & Provider Selection

```typescript
interface PipelineModelConfig {
  // LLM selection (for LLM-based pipelines)
  provider?: string; // 'anthropic' | 'openai' | 'gemini'
  model?: string; // 'claude-haiku-4-5' | 'gpt-4o-mini' — platform provides default
  temperature?: number; // Default varies by pipeline
  maxTokens?: number; // For output

  // Embedding model (for embedding-based pipelines)
  embeddingProvider?: string; // Default: platform BGE-M3
  embeddingModel?: string;

  // Cost control
  maxCostPerDay?: number; // USD — pause processing if exceeded
  maxCostPerConversation?: number; // USD — skip expensive conversations
}
```

#### C. Pipeline-Specific Parameters

Design per pipeline. Examples:

**Intent Classification**:

```typescript
interface IntentClassificationConfig extends PipelineScopeConfig, PipelineModelConfig {
  // Customer-defined taxonomy
  taxonomy?: IntentTaxonomy; // Hierarchical: Billing > Refunds > Partial Refund
  autoDiscovery?: boolean; // Discover new intents not in taxonomy (default: true)
  autoDiscoveryMergeThreshold?: number; // Similarity threshold to merge clusters (default: 0.85)
  classificationPrompt?: string; // Custom prompt override (advanced)
  multiLabel?: boolean; // Allow multiple intents per conversation (default: false)
  confidenceThreshold?: number; // Below this = 'unknown' (default: 0.7)
}

interface IntentTaxonomy {
  categories: IntentCategory[];
}

interface IntentCategory {
  name: string; // 'billing_refund'
  displayName: string; // 'Billing - Refund Request'
  description?: string; // 'Customer requesting a refund for a charge'
  examples?: string[]; // Few-shot examples for classification
  children?: IntentCategory[]; // Sub-categories
}
```

**LLM-as-Judge Quality Evaluation**:

```typescript
interface QualityEvaluationConfig extends PipelineScopeConfig, PipelineModelConfig {
  // Evaluation rubric
  dimensions: EvaluationDimension[]; // REQUIRED — at least one
  overallScoreMethod?: 'average' | 'weighted' | 'minimum'; // default: 'weighted'

  // Flagging thresholds (for Watchtower)
  flagThreshold?: number; // Score below this = flagged (default: 3.0 on 1-5 scale)
  criticalThreshold?: number; // Score below this = critical (default: 2.0)

  // Custom instructions
  evaluatorSystemPrompt?: string; // Additional context for the judge LLM
  domainContext?: string; // 'We are a telecom company...' — helps judge accuracy

  // What to include in evaluation context
  includeToolCalls?: boolean; // Send tool call details to judge (default: true)
  includeFlowSteps?: boolean; // Send flow step trace to judge (default: false)
  includeAgentDefinition?: boolean; // Send agent persona/constraints to judge (default: true)
}

interface EvaluationDimension {
  name: string; // 'helpfulness'
  displayName: string; // 'Helpfulness'
  description: string; // 'Did the agent address the customer's actual need?'
  scale: { min: number; max: number }; // { min: 1, max: 5 }
  weight?: number; // For weighted overall score (default: 1.0)
  criteria?: string[]; // Specific rubric points
  // e.g., ['Agent identified the core issue', 'Provided a concrete resolution', 'Confirmed customer satisfaction']
}
```

**Sentiment Analysis**:

```typescript
interface SentimentAnalysisConfig extends PipelineScopeConfig, PipelineModelConfig {
  granularity?: 'message' | 'conversation' | 'both'; // default: 'both'
  scale?: 'binary' | 'ternary' | 'continuous'; // default: 'continuous' (-1.0 to 1.0)

  // Trajectory detection
  detectTrajectory?: boolean; // Compute improving/declining/stable (default: true)
  pivotDetection?: boolean; // Detect sentiment shift points (default: true)
  pivotThreshold?: number; // Min score change to count as pivot (default: 0.3)

  // Frustration signals (beyond sentiment)
  detectFrustration?: boolean; // ALL CAPS, repetition, explicit keywords (default: true)
  frustrationKeywords?: string[]; // Additional domain-specific keywords

  // Roles to analyze
  analyzeRoles?: ('user' | 'assistant')[]; // default: ['user']
}
```

**Anomaly Detection**:

```typescript
interface AnomalyDetectionConfig extends PipelineScopeConfig {
  // Metrics to monitor
  metrics: AnomalyMetricConfig[]; // REQUIRED — at least one

  // Detection parameters
  method?: 'zscore' | 'iqr' | 'spc' | 'auto'; // default: 'auto'
  sensitivity?: 'low' | 'medium' | 'high'; // default: 'medium'
  windowSize?: string; // Rolling window: '1h', '6h', '24h' (default: '1h')
  minDataPoints?: number; // Min data points before detection starts (default: 100)

  // Alerting
  alertChannels?: AlertChannel[]; // Where to send notifications
  cooldownMinutes?: number; // Don't re-alert within this window (default: 60)

  // Root cause
  decomposeDimensions?: string[]; // Dimensions for factor decomposition: ['agent', 'intent', 'channel']
}

interface AnomalyMetricConfig {
  metric: string; // 'containment_rate' | 'escalation_rate' | 'error_rate' | 'p95_latency' | ...
  thresholdAbsolute?: number; // Alert if value exceeds this
  thresholdRelative?: number; // Alert if % change from baseline exceeds this
  direction?: 'above' | 'below' | 'both'; // Which direction is anomalous
}

interface AlertChannel {
  type: 'email' | 'slack' | 'webhook' | 'in_app';
  target: string; // Email address, Slack channel, webhook URL
  severity?: 'all' | 'critical'; // Filter by severity
}
```

### Storage Schema

Pipeline configurations are stored in MongoDB, scoped by tenant and optionally by project:

```typescript
// MongoDB collection: pipeline_configs
interface PipelineConfig {
  _id: ObjectId;
  tenantId: string; // REQUIRED — tenant isolation
  projectId?: string; // Optional — project-level override

  pipelineType: PipelineType; // 'intent_classification' | 'quality_evaluation' | 'sentiment_analysis' | ...
  version: number; // Auto-increment on save — for change tracking

  enabled: boolean; // Master switch
  config: Record<string, unknown>; // Pipeline-specific config (typed per pipelineType)

  // Processing state
  lastBackfillAt?: Date; // When the last historical backfill completed
  backfillStatus?: 'idle' | 'running' | 'completed' | 'failed';
  lastProcessedAt?: Date; // Last conversation processed

  // Metadata
  createdBy: string; // User who created the config
  updatedBy: string; // User who last modified
  createdAt: Date;
  updatedAt: Date;

  // Change tracking
  configHistory?: ConfigChange[]; // Last N changes for audit
}

interface ConfigChange {
  version: number;
  changedBy: string;
  changedAt: Date;
  diff: Record<string, { old: unknown; new: unknown }>;
  reprocessingRequired: boolean; // Did this change require backfill?
}
```

### Configuration Resolution Chain

When a pipeline runs, resolve config in this order:

```
1. Project-level config   (pipeline_configs WHERE tenantId AND projectId)
2. Tenant-level config    (pipeline_configs WHERE tenantId AND projectId IS NULL)
3. Platform defaults      (hardcoded in pipeline implementation)
```

### Parameters That Require Re-processing

When the customer changes configuration, some changes require re-processing historical data:

| Change Type            | Requires Backfill? | Example                                             |
| ---------------------- | ------------------ | --------------------------------------------------- |
| Taxonomy change        | YES                | Added new intent category                           |
| Rubric dimension added | YES                | New evaluation dimension                            |
| Model change           | YES (recommended)  | Switched from GPT-4o-mini to Claude Haiku           |
| Threshold change       | NO                 | Changed flag threshold from 3.0 to 2.5              |
| Alert channel change   | NO                 | Added Slack notification                            |
| Scope filter change    | PARTIAL            | Added agent filter — only re-process for that agent |
| Sample rate change     | NO (future only)   | Changed from 1.0 to 0.5                             |

---

## Phase 3: Output Schema Design

**Goal**: Design the storage schema for pipeline results. Think backwards from how results will be presented to the customer (Phase 4) to determine what to store.

### Checklist

```
□ 3.1  Define the primary output record (one per conversation? per message? per time bucket?)
□ 3.2  Define all output fields with types and descriptions
□ 3.3  Include provenance fields (model_version, config_version, processed_at)
□ 3.4  Include confidence/quality indicators
□ 3.5  Design for both per-record queries AND aggregation queries
□ 3.6  Choose storage: ClickHouse (analytics) vs MongoDB (config/lookup) vs both
□ 3.7  Define ClickHouse table engine, partitioning, and ORDER BY
□ 3.8  Define TTL policy aligned with source data TTLs
□ 3.9  Design materialized views for common aggregation patterns
□ 3.10 Ensure tenant isolation (tenant_id in every table, every query)
□ 3.11 Plan for re-processing: how to replace old results when config changes
```

### Storage Decision: ClickHouse vs MongoDB

| Use ClickHouse When                              | Use MongoDB When                               |
| ------------------------------------------------ | ---------------------------------------------- |
| High-volume append (millions of records)         | Low-volume config/lookup                       |
| Time-series aggregation (GROUP BY day/week)      | Document-level metadata                        |
| Analytics queries (COUNT, SUM, AVG, percentiles) | Flexible schema that changes often             |
| Cross-session analysis                           | Per-record updates (ClickHouse is append-only) |
| Dashboard backing                                | Workflow state (e.g., human review queue)      |

**Most pipeline outputs go to ClickHouse** because the primary use case is aggregation and time-series analysis. MongoDB is used for pipeline configuration and human-review workflows.

### Output Schema Templates

#### Per-Conversation Output (Intent, Quality, Outcome)

```sql
CREATE TABLE abl_platform.{pipeline}_results (
    -- Identity
    tenant_id        String,
    project_id       String,
    session_id       String,

    -- Timing
    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    -- Context dimensions (for GROUP BY)
    agent_name       LowCardinality(String),
    agent_version    LowCardinality(String),
    channel          LowCardinality(String),

    -- Pipeline output (varies per pipeline)
    -- ... pipeline-specific fields ...

    -- Provenance
    model_id         LowCardinality(String),   -- Model used for this evaluation
    model_version    LowCardinality(String),
    config_version   UInt32,                     -- Pipeline config version at time of processing
    pipeline_version LowCardinality(String),     -- Code version of the pipeline

    -- Quality indicators
    confidence       Float32,                    -- Pipeline's confidence in its output
    processing_ms    UInt32,                     -- How long processing took
    input_tokens     UInt32,                     -- LLM tokens consumed (for cost tracking)
    output_tokens    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)        -- Latest result wins on re-processing
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;
```

#### Per-Message Output (Sentiment)

```sql
CREATE TABLE abl_platform.message_sentiment (
    tenant_id        String,
    session_id       String,
    message_id       String,

    message_at       DateTime64(3),
    processed_at     DateTime64(3),

    role             LowCardinality(String),      -- user | assistant
    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    -- Sentiment output
    sentiment_score  Float32,                      -- -1.0 to +1.0
    sentiment_label  LowCardinality(String),       -- positive | neutral | negative
    frustration_detected  UInt8,                   -- 0 | 1
    frustration_signals   Array(String),            -- ['ALL_CAPS', 'repetition', 'keyword:cancel']

    -- Provenance
    model_id         LowCardinality(String),
    config_version   UInt32,
    confidence       Float32,
    processing_ms    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL message_at + INTERVAL 730 DAY DELETE;
```

#### Conversation-Level Sentiment Aggregation

```sql
CREATE TABLE abl_platform.conversation_sentiment (
    tenant_id        String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    -- Aggregated sentiment
    avg_sentiment           Float32,
    start_sentiment         Float32,               -- First user message
    end_sentiment           Float32,               -- Last user message
    min_sentiment           Float32,
    max_sentiment           Float32,
    sentiment_trajectory    LowCardinality(String), -- improving | declining | stable | volatile
    sentiment_shift_count   UInt16,                 -- Number of significant shifts

    -- Frustration
    frustration_turn_count  UInt16,
    frustration_detected    UInt8,                  -- Any turn had frustration

    -- Pivot points
    pivot_count             UInt16,
    worst_pivot_at          Nullable(DateTime64(3)),
    worst_pivot_delta       Nullable(Float32),

    -- Provenance
    model_id         LowCardinality(String),
    config_version   UInt32,
    message_count    UInt16,                        -- Number of messages analyzed

    processing_ms    UInt32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;
```

#### Time-Bucket Anomaly Events

```sql
CREATE TABLE abl_platform.anomaly_events (
    tenant_id        String,
    project_id       String,

    detected_at      DateTime64(3),

    metric_name      LowCardinality(String),        -- 'containment_rate', 'escalation_rate', ...
    metric_value     Float64,
    baseline_value   Float64,
    deviation_pct    Float32,                        -- % deviation from baseline
    severity         LowCardinality(String),         -- info | warning | critical

    -- Decomposition
    contributing_factors  String,                    -- JSON: [{dimension: 'agent', value: 'BillingAgent', contribution: 0.45}]

    -- Window
    window_start     DateTime64(3),
    window_end       DateTime64(3),
    data_point_count UInt32,

    -- Alert state
    alert_sent       UInt8,
    alert_channels   Array(String),

    -- Provenance
    config_version   UInt32,
    detection_method LowCardinality(String)          -- zscore | iqr | spc
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(detected_at))
ORDER BY (tenant_id, project_id, metric_name, detected_at)
TTL detected_at + INTERVAL 365 DAY DELETE;
```

### ReplacingMergeTree for Re-processing

Use `ReplacingMergeTree(processed_at)` for pipeline outputs. When a pipeline re-processes a conversation (due to config change or model update), it inserts a new row with a newer `processed_at`. ClickHouse deduplicates by ORDER BY key, keeping the latest.

**Important**: `ReplacingMergeTree` deduplication is eventual (happens during merges). For queries, use `FINAL` keyword or filter by `max(processed_at)` when exact deduplication is needed:

```sql
-- Option 1: FINAL (slower, exact)
SELECT * FROM quality_evaluations FINAL WHERE tenant_id = ? AND session_id = ?

-- Option 2: argMax (faster for aggregations)
SELECT
    agent_name,
    avg(argMax(overall_score, processed_at)) as avg_quality
FROM quality_evaluations
WHERE tenant_id = ?
GROUP BY agent_name
```

---

## Phase 4: Presentation Design

**Goal**: Define how the pipeline output will be presented to the customer. Even if the UI is not built yet, the presentation design drives the output schema (Phase 3) and index design (Phase 5).

### Checklist

```
□ 4.1  Identify the primary dashboard/widget this pipeline powers
□ 4.2  Define the "At a Glance" metric (single number the exec sees)
□ 4.3  Define the time-series chart (trend over time)
□ 4.4  Define the breakdown/distribution view (by agent, by intent, by channel)
□ 4.5  Define the drill-down path (from metric → conversations → single conversation)
□ 4.6  Define the comparison view (this week vs last, agent A vs agent B, experiment vs control)
□ 4.7  Define export/report format (CSV, scheduled email)
□ 4.8  Define alert presentation (in-app notification, email, Slack)
□ 4.9  Specify the API endpoints needed to serve each view
□ 4.10 For each view, write the ClickHouse query that backs it (validates schema + index design)
```

### Presentation Pattern Library

Most pipeline outputs follow a consistent set of presentation patterns:

#### Pattern 1: Scorecard (At a Glance)

```
┌─────────────────────────────────────────────────────┐
│  Quality Score    Sentiment     Containment Rate     │
│     3.8/5.0      72% positive      68.3%            │
│    ▲ +0.3        ▼ -5pp           ▲ +2.1pp          │
│   vs last week   vs last week     vs last week      │
└─────────────────────────────────────────────────────┘
```

**Backing query pattern**:

```sql
SELECT
    avg(overall_score) AS current_score,
    -- Compare with prior period
    avg(CASE WHEN session_started_at >= now() - INTERVAL 14 DAY
              AND session_started_at < now() - INTERVAL 7 DAY
         THEN overall_score END) AS prior_score
FROM quality_evaluations FINAL
WHERE tenant_id = ? AND session_started_at >= now() - INTERVAL 14 DAY
```

#### Pattern 2: Time Series (Trend)

```
Score
5.0 ┤
4.0 ┤    ╭─╮  ╭──╮
3.0 ┤╭──╯  ╰─╯    ╰──╮
2.0 ┤╯                 ╰──
1.0 ┤
    └──────────────────────
     Mon  Tue  Wed  Thu  Fri
```

**Backing query pattern**:

```sql
SELECT
    toDate(session_started_at) AS date,
    avg(overall_score) AS avg_score,
    count() AS conversation_count
FROM quality_evaluations FINAL
WHERE tenant_id = ? AND session_started_at >= now() - INTERVAL 30 DAY
GROUP BY date
ORDER BY date
```

#### Pattern 3: Breakdown / Distribution (By Dimension)

```
┌────────────────────────────────────────────┐
│ Quality Score by Agent                      │
│                                             │
│ BillingAgent     ████████████████  4.2      │
│ NetworkAgent     ██████████████    3.8      │
│ AccountAgent     ████████████      3.5      │
│ CoverageAgent    ████████          2.9  ⚠   │
└────────────────────────────────────────────┘
```

**Backing query pattern**:

```sql
SELECT
    agent_name,
    avg(overall_score) AS avg_score,
    count() AS conversation_count,
    quantile(0.25)(overall_score) AS p25,
    quantile(0.75)(overall_score) AS p75
FROM quality_evaluations FINAL
WHERE tenant_id = ? AND session_started_at >= now() - INTERVAL 7 DAY
GROUP BY agent_name
ORDER BY avg_score ASC
```

#### Pattern 4: Drill-Down (Metric → Conversations → Transcript)

```
Level 1: Metric overview       → "Quality score is 3.8"
Level 2: Filtered conversation list → "42 conversations scored below 3.0"
Level 3: Single conversation   → Full transcript with per-turn scores
Level 4: Trace detail          → LLM calls, tool executions, flow steps
```

**Backing queries**:

```sql
-- Level 2: Conversation list
SELECT session_id, overall_score, agent_name, session_started_at,
       helpfulness, accuracy, professionalism
FROM quality_evaluations FINAL
WHERE tenant_id = ? AND overall_score < 3.0 AND session_started_at >= now() - INTERVAL 7 DAY
ORDER BY overall_score ASC
LIMIT 50

-- Level 3: Per-message detail (join with message_sentiment)
SELECT m.message_id, m.role, m.created_at,
       s.sentiment_score, s.sentiment_label, s.frustration_detected
FROM messages m
LEFT JOIN message_sentiment s ON m.message_id = s.message_id AND m.tenant_id = s.tenant_id
WHERE m.tenant_id = ? AND m.session_id = ?
ORDER BY m.created_at ASC
```

#### Pattern 5: Comparison (A vs B)

```
┌──────────────────────────────────────┐
│ Experiment vs Control                 │
│                                       │
│              Experiment   Control     │
│ Quality        4.1         3.8        │
│ Containment    72%         68%        │
│ Avg Turns      5.2         6.8        │
│                                       │
│ Significance: p=0.023 ✓              │
└──────────────────────────────────────┘
```

### API Endpoint Pattern

Each pipeline should expose a consistent API:

```
GET /api/projects/:projectId/analytics/{pipeline}/summary
    ?period=7d&granularity=daily

GET /api/projects/:projectId/analytics/{pipeline}/breakdown
    ?period=7d&dimension=agent_name

GET /api/projects/:projectId/analytics/{pipeline}/conversations
    ?period=7d&filter=score_lt:3.0&page=1&pageSize=50

GET /api/projects/:projectId/analytics/{pipeline}/conversation/:sessionId

GET /api/projects/:projectId/analytics/{pipeline}/export
    ?period=30d&format=csv
```

---

## Phase 5: Index & Performance Design

**Goal**: Design indices on both input and output tables to serve the presentation queries from Phase 4 with sub-second latency. Also design materialized views for pre-aggregated common queries.

### Checklist

```
□ 5.1  For each Phase 4 query, verify the ClickHouse ORDER BY covers the WHERE + GROUP BY
□ 5.2  Design materialized views for high-frequency aggregation queries
□ 5.3  Design projection tables for alternative query patterns
□ 5.4  Verify partition pruning — every query must filter by tenant_id + time range
□ 5.5  Add skip indices for low-cardinality filter columns
□ 5.6  Estimate storage size (rows × row size × retention period)
□ 5.7  Plan data lifecycle (warm → cold → delete TTLs)
□ 5.8  For MongoDB pipeline_configs: add compound index on (tenantId, pipelineType)
□ 5.9  Test query performance with realistic data volume
□ 5.10 Design cache strategy (Redis cache for dashboard queries, TTL-based invalidation)
```

### ClickHouse ORDER BY Design

ClickHouse stores data sorted by ORDER BY. Queries that filter on the ORDER BY prefix are fast (index scan). Queries that filter on non-prefix columns require full partition scan.

**Rule**: The ORDER BY must start with `tenant_id` (for isolation) and include the most common filter/group dimensions.

```sql
-- For per-conversation pipeline outputs
ORDER BY (tenant_id, project_id, session_id)
-- Fast: WHERE tenant_id = ? AND session_id = ?
-- Slow: WHERE agent_name = ? (not in ORDER BY prefix)

-- For time-series queries, add a date projection:
ORDER BY (tenant_id, project_id, toDate(session_started_at), agent_name)
-- Fast: WHERE tenant_id = ? AND session_started_at >= ? GROUP BY agent_name
```

### Materialized Views for Common Aggregations

Create MVs for queries that run on every dashboard load:

```sql
-- Daily quality score aggregation (backs the time-series chart)
CREATE MATERIALIZED VIEW abl_platform.mv_daily_quality_scores
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    count() AS conversation_count,
    sum(overall_score) AS total_score,
    sum(helpfulness) AS total_helpfulness,
    sum(accuracy) AS total_accuracy,
    sum(CASE WHEN overall_score < 3.0 THEN 1 ELSE 0 END) AS flagged_count
FROM abl_platform.quality_evaluations
GROUP BY tenant_id, project_id, date, agent_name, channel;

-- Usage: avg quality = total_score / conversation_count
-- Flagged rate = flagged_count / conversation_count
```

```sql
-- Daily intent distribution (backs the intent breakdown chart)
CREATE MATERIALIZED VIEW abl_platform.mv_daily_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    intent,
    count() AS conversation_count,
    sum(confidence) AS total_confidence
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent;
```

```sql
-- Daily sentiment aggregation
CREATE MATERIALIZED VIEW abl_platform.mv_daily_sentiment
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    count() AS conversation_count,
    sum(avg_sentiment) AS total_sentiment,
    sum(CASE WHEN sentiment_trajectory = 'declining' THEN 1 ELSE 0 END) AS declining_count,
    sum(CASE WHEN frustration_detected = 1 THEN 1 ELSE 0 END) AS frustrated_count
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, date, agent_name;
```

### Skip Indices for Filter Columns

For columns not in ORDER BY but frequently filtered:

```sql
-- On quality_evaluations: filter by score threshold
ALTER TABLE abl_platform.quality_evaluations
    ADD INDEX idx_overall_score overall_score TYPE minmax GRANULARITY 4;

-- On intent_classifications: filter by specific intent
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_intent intent TYPE set(100) GRANULARITY 4;

-- On conversation_sentiment: filter by trajectory
ALTER TABLE abl_platform.conversation_sentiment
    ADD INDEX idx_trajectory sentiment_trajectory TYPE set(10) GRANULARITY 4;

-- On message_sentiment: filter by frustration
ALTER TABLE abl_platform.message_sentiment
    ADD INDEX idx_frustration frustration_detected TYPE set(2) GRANULARITY 4;
```

### MongoDB Indices for Pipeline Config

```javascript
// Pipeline configuration lookup
db.pipeline_configs.createIndex({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });

// Find all enabled pipelines for a tenant
db.pipeline_configs.createIndex({ tenantId: 1, enabled: 1 });
```

### Redis Cache Strategy

For dashboard queries that run frequently:

```typescript
interface CacheStrategy {
  // Scorecard (At a Glance) — cached per tenant+project+period
  key: `analytics:${tenantId}:${projectId}:${pipeline}:summary:${period}`;
  ttl: 300; // 5 minutes — balance freshness vs query cost

  // Time series — cached per tenant+project+period+granularity
  key: `analytics:${tenantId}:${projectId}:${pipeline}:timeseries:${period}:${granularity}`;
  ttl: 600; // 10 minutes — time series doesn't change rapidly

  // Breakdown — cached per tenant+project+period+dimension
  key: `analytics:${tenantId}:${projectId}:${pipeline}:breakdown:${period}:${dimension}`;
  ttl: 300; // 5 minutes

  // Conversation list — NOT cached (pagination, filters vary)
  // Single conversation — cached for 1 hour (immutable once processed)
}
```

### Cache Invalidation

Invalidate cache when:

1. Pipeline processes new conversations (on batch completion, invalidate summary + timeseries + breakdown)
2. Customer changes pipeline config (invalidate all cache for that tenant + pipeline)
3. TTL expires (automatic)

```typescript
async function invalidatePipelineCache(
  tenantId: string,
  projectId: string,
  pipeline: string,
): Promise<void> {
  const pattern = `analytics:${tenantId}:${projectId}:${pipeline}:*`;
  // Use Redis SCAN + DEL (not KEYS — KEYS blocks)
}
```

### Storage Size Estimation

```
Per pipeline output table:
  Row size ≈ 200-500 bytes (depending on pipeline)

  Example: 10,000 conversations/day × 365 days × 300 bytes
         = 10,000 × 365 × 300 = ~1.1 GB/year (uncompressed)

  ClickHouse compression ratio ≈ 5-10x
  Actual disk: ~110-220 MB/year per tenant

  With 100 tenants: ~11-22 GB/year per pipeline

  Materialized views add ~20-30% overhead
```

### Query Performance Targets

| Query Type                  | Target Latency | Strategy                                          |
| --------------------------- | -------------- | ------------------------------------------------- |
| Scorecard (single number)   | < 100ms        | Materialized view + Redis cache                   |
| Time series (30 days daily) | < 200ms        | Materialized view                                 |
| Breakdown by dimension      | < 300ms        | MV or ORDER BY-aligned query                      |
| Conversation list (page)    | < 500ms        | ORDER BY-aligned, LIMIT/OFFSET                    |
| Single conversation detail  | < 200ms        | Primary key lookup + Redis cache                  |
| Export (30 days CSV)        | < 10s          | Streaming query, background job for large exports |

---

## Pipeline Processing Architecture

### Trigger Mechanisms

```
1. Real-time (on event):
   Kafka consumer → pipeline processor → ClickHouse insert
   Trigger: session.ended event
   Latency: seconds
   Use for: Intent classification, sentiment analysis

2. Near-real-time (micro-batch):
   Scheduler (every 5 min) → query unprocessed sessions → batch process → insert
   Trigger: cron
   Latency: minutes
   Use for: Quality evaluation (LLM-as-judge is expensive, batch for efficiency)

3. Batch (daily):
   Scheduler (daily) → compute aggregations → insert
   Trigger: daily cron
   Latency: hours
   Use for: Anomaly detection, drift detection, trend computation

4. On-demand (backfill):
   API trigger → query historical sessions → batch process → insert
   Trigger: config change or manual
   Latency: hours to days
   Use for: Re-processing after config change, initial setup
```

### Processing Pipeline Template

```typescript
interface PipelineProcessor<TConfig, TInput, TOutput> {
  // Phase 1: Load configuration
  loadConfig(tenantId: string, projectId?: string): Promise<TConfig>;

  // Phase 2: Fetch input data
  fetchInput(sessionId: string, config: TConfig): Promise<TInput>;

  // Phase 3: Process (LLM call, ML inference, statistical computation)
  process(input: TInput, config: TConfig): Promise<TOutput>;

  // Phase 4: Store output
  store(output: TOutput): Promise<void>;

  // Phase 5: Invalidate cache
  invalidateCache(tenantId: string, projectId: string): Promise<void>;
}
```

### Error Handling

- If LLM call fails: retry with exponential backoff (max 3 retries), then mark session as `processing_failed`
- If input data is missing: skip session, log warning, do not block batch
- If cost limit exceeded: pause processing, emit alert, resume next day
- Never fail silently — every skipped session must be traceable

### Cost Control

- Track `input_tokens` and `output_tokens` per pipeline output record
- Aggregate daily cost per tenant per pipeline
- Compare against `maxCostPerDay` from config
- Emit alert at 80% of budget, pause at 100%
