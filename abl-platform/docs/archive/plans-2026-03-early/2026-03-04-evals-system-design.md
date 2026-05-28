# ABL Platform — Evals System Design

**Date:** 2026-03-04
**Status:** Draft
**Scope:** Full system — data layer, pipeline engine integration, API routes, UI architecture, all 12 research-backed improvements
**Builds on:** [Evals Research Report](./2026-03-04-evals-research-report.md), [COPILOT_ARCHITECT_EVALS_SPEC](../COPILOT_ARCHITECT_EVALS_SPEC.md), Pipeline Engine (`packages/pipeline-engine/`)

---

## Design Decisions

| Decision                | Choice                              | Rationale                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eval runner             | Pipeline engine (Restate workflows) | Reuses existing `packages/pipeline-engine/` with durable execution, parallel fan-out, activity registry. Add 3-4 new activity types instead of building a separate service                                                  |
| Conversation simulation | In-process agent execution          | Import agent executor directly. Faster than Runtime API calls. Acceptable for eval (not production traffic)                                                                                                                 |
| Config storage          | MongoDB (Mongoose)                  | Personas, scenarios, evaluators, eval sets — standard CRUD entities following existing model patterns                                                                                                                       |
| Results storage         | ClickHouse primary                  | Run results and scores in ClickHouse. Optimized for analytical queries, time-series, aggregations on large result sets                                                                                                      |
| Research scope          | All 12 recommendations              | Bias mitigation, structured rubrics, CI/CD, cost estimation, trajectory eval, online/offline separation, dataset versioning, statistical significance, human review, adversarial personas, production monitoring, DSL block |

---

## Table of Contents

1. [Data Layer — MongoDB Models](#1-data-layer--mongodb-models)
2. [Data Layer — ClickHouse Tables](#2-data-layer--clickhouse-tables)
3. [Pipeline Architecture](#3-pipeline-architecture)
4. [API Routes](#4-api-routes)
5. [UI Architecture](#5-ui-architecture)
6. [Research-Backed Features](#6-research-backed-features)
7. [Production Readiness](#7-production-readiness)
8. [Query Optimization & Ingestion Performance](#8-query-optimization--ingestion-performance)
9. [Implementation Phases](#9-implementation-phases)

---

## 1. Data Layer — MongoDB Models

All models live in `packages/database/src/models/`. Follow existing patterns: `uuidv7` IDs, `tenantIsolationPlugin`, compound indexes with `tenantId` leading.

### 1.1 EvalPersona

```typescript
export interface IEvalPersona {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  communicationStyle: 'casual' | 'formal' | 'technical' | 'terse' | 'verbose';
  domainKnowledge: 'beginner' | 'intermediate' | 'expert';
  behaviorTraits: string[]; // ["impatient", "detail-oriented", "hostile"]
  goals: string; // What the persona wants to achieve
  constraints: string; // What limits the persona
  systemPrompt?: string; // Custom LLM prompt override for persona simulation
  source: 'ai-generated' | 'custom' | 'template' | 'adversarial';
  templateId?: string; // Built-in template reference
  version: number; // Auto-increment on edit (R7: dataset versioning)
  isAdversarial: boolean; // R10: adversarial persona flag
  adversarialType?:
    | 'prompt_injection'
    | 'social_engineering'
    | 'off_topic'
    | 'abusive'
    | 'edge_case';
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Schema
const EvalPersonaSchema = new Schema<IEvalPersona>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    communicationStyle: {
      type: String,
      enum: ['casual', 'formal', 'technical', 'terse', 'verbose'],
      default: 'casual',
    },
    domainKnowledge: {
      type: String,
      enum: ['beginner', 'intermediate', 'expert'],
      default: 'intermediate',
    },
    behaviorTraits: { type: [String], default: [] },
    goals: { type: String, default: '' },
    constraints: { type: String, default: '' },
    systemPrompt: String,
    source: {
      type: String,
      enum: ['ai-generated', 'custom', 'template', 'adversarial'],
      default: 'custom',
    },
    templateId: String,
    version: { type: Number, default: 1 },
    isAdversarial: { type: Boolean, default: false },
    adversarialType: {
      type: String,
      enum: ['prompt_injection', 'social_engineering', 'off_topic', 'abusive', 'edge_case'],
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'eval_personas' },
);

EvalPersonaSchema.plugin(tenantIsolationPlugin);
EvalPersonaSchema.index({ tenantId: 1, projectId: 1 });
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
```

### 1.2 EvalScenario

```typescript
export interface IEvalScenario {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  category?: string; // "billing", "support", "onboarding"
  difficulty: 'easy' | 'medium' | 'hard';
  entryAgent?: string; // Agent to start conversation with
  initialMessage?: string; // First message from persona (if not LLM-generated)
  expectedOutcome?: string; // Natural language description of success
  maxTurns: number;
  tags: string[];
  agentPath: string[]; // Expected agent handoff sequence
  // R5: Trajectory evaluation
  expectedMilestones: string[]; // Ordered checkpoints e.g. ["verify_identity", "lookup_account"]
  maxToolCalls?: number; // Efficiency threshold
  version: number; // R7: dataset versioning
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Schema
const EvalScenarioSchema = new Schema<IEvalScenario>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    category: String,
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    entryAgent: String,
    initialMessage: String,
    expectedOutcome: String,
    maxTurns: { type: Number, default: 10 },
    tags: { type: [String], default: [] },
    agentPath: { type: [String], default: [] },
    expectedMilestones: { type: [String], default: [] },
    maxToolCalls: Number,
    version: { type: Number, default: 1 },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'eval_scenarios' },
);

EvalScenarioSchema.plugin(tenantIsolationPlugin);
EvalScenarioSchema.index({ tenantId: 1, projectId: 1 });
EvalScenarioSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
```

### 1.3 EvalEvaluator

```typescript
export interface IScoringRubricPoint {
  value: number; // 1, 2, 3, 4, 5
  label: string; // "Excellent", "Good", "Adequate", "Poor", "Failing"
  criteria: string; // Behavioral anchor
  examples?: string[]; // Example evidence
}

export interface IScoringRubric {
  scaleType: '1-5' | 'pass-fail';
  points: IScoringRubricPoint[];
}

export interface IBiasSettings {
  positionSwapEnabled: boolean; // R1: evaluate twice with swapped order, average
  blindEvaluation: boolean; // R1: strip model/source attribution
  crossModelJudge: boolean; // R1: use different model family than agent
  evidenceFirstMode: boolean; // R1: RULERS — extract evidence before scoring
}

export interface IEvalEvaluator {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  type: 'llm_judge' | 'code_scorer' | 'trajectory' | 'human_review';
  category: 'quality' | 'safety' | 'efficiency' | 'empathy' | 'tool_correctness' | 'custom';
  // LLM judge config
  judgeModel?: string; // e.g. "claude-sonnet-4-6"
  judgePrompt?: string; // System prompt for judge
  chainOfThought: boolean;
  temperature: number;
  // R2: Structured rubric (replaces free-text)
  scoringRubric?: IScoringRubric;
  // R1: Bias mitigation
  biasSettings: IBiasSettings;
  // Code scorer config
  scorerName?: string; // Built-in scorer name (e.g. "toolSuccessScorer")
  scorerConfig?: Record<string, unknown>;
  // Trajectory config (R5)
  trajectoryMetrics?: (
    | 'milestone_completion'
    | 'handoff_correctness'
    | 'path_efficiency'
    | 'tool_sequence'
  )[];
  // Human review config (R9)
  humanReviewThreshold?: number; // Confidence below this → route to human
  // Metadata
  isBuiltIn: boolean;
  templateId?: string;
  version: number; // R7: dataset versioning
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Schema
const ScoringRubricPointSchema = new Schema(
  {
    value: { type: Number, required: true },
    label: { type: String, required: true },
    criteria: { type: String, required: true },
    examples: [String],
  },
  { _id: false },
);

const ScoringRubricSchema = new Schema(
  {
    scaleType: { type: String, enum: ['1-5', 'pass-fail'], required: true },
    points: { type: [ScoringRubricPointSchema], required: true },
  },
  { _id: false },
);

const BiasSettingsSchema = new Schema(
  {
    positionSwapEnabled: { type: Boolean, default: true },
    blindEvaluation: { type: Boolean, default: true },
    crossModelJudge: { type: Boolean, default: false },
    evidenceFirstMode: { type: Boolean, default: true },
  },
  { _id: false },
);

const EvalEvaluatorSchema = new Schema<IEvalEvaluator>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    type: {
      type: String,
      enum: ['llm_judge', 'code_scorer', 'trajectory', 'human_review'],
      required: true,
    },
    category: {
      type: String,
      enum: ['quality', 'safety', 'efficiency', 'empathy', 'tool_correctness', 'custom'],
      default: 'custom',
    },
    judgeModel: String,
    judgePrompt: String,
    chainOfThought: { type: Boolean, default: true },
    temperature: { type: Number, default: 0 },
    scoringRubric: ScoringRubricSchema,
    biasSettings: { type: BiasSettingsSchema, default: () => ({}) },
    scorerName: String,
    scorerConfig: { type: Schema.Types.Mixed },
    trajectoryMetrics: [
      {
        type: String,
        enum: ['milestone_completion', 'handoff_correctness', 'path_efficiency', 'tool_sequence'],
      },
    ],
    humanReviewThreshold: Number,
    isBuiltIn: { type: Boolean, default: false },
    templateId: String,
    version: { type: Number, default: 1 },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'eval_evaluators' },
);

EvalEvaluatorSchema.plugin(tenantIsolationPlugin);
EvalEvaluatorSchema.index({ tenantId: 1, projectId: 1 });
EvalEvaluatorSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
```

### 1.4 EvalSet

```typescript
export interface IEvalSet {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  personaIds: string[];
  scenarioIds: string[];
  evaluatorIds: string[];
  variants: number; // Default 3
  maxConcurrency: number; // Default 5
  // R3: CI/CD integration
  regressionThreshold?: number; // Max acceptable score drop (e.g., 0.5)
  baselineRunId?: string; // Run to compare against
  ciEnabled: boolean; // Triggerable from CI
  // R4: Cost controls
  estimatedCostPerRun?: number; // Last computed estimate
  // RD3: Persona simulation model
  personaModel?: string; // LLM for persona sim. null = agent's model
  personaModelConfig?: {
    temperature?: number; // Default: 0.7
    maxTokens?: number; // Default: 512
  };
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const EvalSetSchema = new Schema<IEvalSet>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    personaIds: { type: [String], default: [] },
    scenarioIds: { type: [String], default: [] },
    evaluatorIds: { type: [String], default: [] },
    variants: { type: Number, default: 3, min: 1, max: 10 },
    maxConcurrency: { type: Number, default: 5, min: 1, max: 20 },
    regressionThreshold: Number,
    baselineRunId: String,
    ciEnabled: { type: Boolean, default: false },
    estimatedCostPerRun: Number,
    personaModel: { type: String, default: null },
    personaModelConfig: {
      type: new Schema(
        {
          temperature: { type: Number, default: 0.7 },
          maxTokens: { type: Number, default: 512 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'eval_sets' },
);

EvalSetSchema.plugin(tenantIsolationPlugin);
EvalSetSchema.index({ tenantId: 1, projectId: 1 });
EvalSetSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });
```

### 1.5 EvalRun (MongoDB — metadata only)

Run metadata lives in MongoDB. Scores and conversation results live in ClickHouse (Section 2).

```typescript
export interface IEvalRun {
  _id: string;
  tenantId: string;
  projectId: string;
  evalSetId: string;
  name?: string;
  notes?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerSource: 'manual' | 'ci' | 'scheduled';
  triggeredBy: string;
  // Pipeline integration
  pipelineRunId?: string; // Restate workflow run ID
  // Versioning snapshot (R7)
  snapshot: {
    personaVersions: Record<string, number>; // personaId → version at run time
    scenarioVersions: Record<string, number>;
    evaluatorVersions: Record<string, number>;
  };
  // Aggregates (computed after completion)
  summary?: {
    totalConversations: number;
    totalEvaluations: number;
    avgScore: number;
    scoresByEvaluator: Record<string, number>;
    durationMs: number;
    // R4: Cost tracking
    estimatedCost: number;
    actualCost: number;
    // R8: Statistical significance
    stdDev: number;
    confidenceInterval: [number, number]; // 95% CI
    passAtK: number; // At least 1 variant passes threshold
    passExpK: number; // All variants pass threshold
  };
  // R3: Regression detection
  regressionDetected: boolean;
  baselineRunId?: string;
  regressionDetails?: Array<{
    evaluatorId: string;
    personaId: string;
    scenarioId: string;
    baselineScore: number;
    currentScore: number;
    delta: number;
  }>;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

const EvalRunSchema = new Schema<IEvalRun>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    evalSetId: { type: String, required: true },
    name: String,
    notes: String,
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    triggerSource: { type: String, enum: ['manual', 'ci', 'scheduled'], default: 'manual' },
    triggeredBy: { type: String, required: true },
    pipelineRunId: String,
    snapshot: {
      type: Schema.Types.Mixed,
      default: () => ({ personaVersions: {}, scenarioVersions: {}, evaluatorVersions: {} }),
    },
    summary: Schema.Types.Mixed,
    regressionDetected: { type: Boolean, default: false },
    baselineRunId: String,
    regressionDetails: [Schema.Types.Mixed],
    startedAt: Date,
    completedAt: Date,
  },
  { timestamps: true, collection: 'eval_runs' },
);

EvalRunSchema.plugin(tenantIsolationPlugin);
EvalRunSchema.index({ tenantId: 1, projectId: 1 });
EvalRunSchema.index({ evalSetId: 1, createdAt: -1 });
EvalRunSchema.index({ tenantId: 1, status: 1 });
```

### 1.6 EvalHumanReview (R9)

When an evaluator with `type: 'human_review'` runs in `judge-conversation`, the activity:

1. Sets a pending ClickHouse score row (`score=0`, `needs_human_review=1`)
2. **Creates an `EvalHumanReview` MongoDB document** (`status: 'pending'`) so human reviewers can retrieve and score it via `GET /api/projects/:id/evals/reviews`

```typescript
export interface IEvalHumanReview {
  _id: string;
  tenantId: string;
  projectId: string;
  runId: string;
  evaluatorId: string;
  personaId: string;
  scenarioId: string;
  variantIndex: number;
  // What the LLM judge scored
  llmScore: number;
  llmReasoning: string;
  llmConfidence: number;
  // Human override
  humanScore?: number;
  humanReasoning?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  status: 'pending' | 'reviewed' | 'dismissed';
  createdAt: Date;
}
```

---

## 2. Data Layer — ClickHouse Tables

### 2.1 eval_conversations

Stores the full conversation transcript + trace data for each persona×scenario×variant cell.

```sql
CREATE TABLE IF NOT EXISTS abl_platform.eval_conversations
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    run_id            String               CODEC(ZSTD(1)),
    persona_id        String               CODEC(ZSTD(1)),
    scenario_id       String               CODEC(ZSTD(1)),
    variant_index     UInt8                CODEC(T64, ZSTD(1)),

    -- Conversation data
    conversation      String               CODEC(ZSTD(3)),     -- JSON: [{role, content, timestamp}]
    trace_events      String               CODEC(ZSTD(3)),     -- JSON: PlatformEvent[]
    tool_calls        String               DEFAULT '[]' CODEC(ZSTD(3)),

    -- Metrics
    turn_count        UInt16               CODEC(T64, ZSTD(1)),
    duration_ms       UInt32               CODEC(T64, ZSTD(1)),
    token_usage       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    estimated_cost    Float32              DEFAULT 0,

    -- Trajectory (R5)
    milestones_hit    Array(String)        CODEC(ZSTD(1)),     -- Which expectedMilestones were achieved
    actual_agent_path Array(String)        CODEC(ZSTD(1)),     -- Actual handoff sequence
    tool_call_count   UInt16               DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Status
    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),

    -- Versioning snapshot (R7)
    persona_version   UInt16               DEFAULT 1,
    scenario_version  UInt16               DEFAULT 1,

    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_run     run_id               TYPE bloom_filter GRANULARITY 4,
    INDEX idx_persona persona_id           TYPE bloom_filter GRANULARITY 4,
    INDEX idx_scenario scenario_id         TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.eval_conversations', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, run_id, persona_id, scenario_id, variant_index)
TTL toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192
```

### 2.2 eval_scores

Individual evaluator scores per conversation cell.

```sql
CREATE TABLE IF NOT EXISTS abl_platform.eval_scores
(
    tenant_id           String               CODEC(ZSTD(1)),
    project_id          String               CODEC(ZSTD(1)),
    run_id              String               CODEC(ZSTD(1)),
    persona_id          String               CODEC(ZSTD(1)),
    scenario_id         String               CODEC(ZSTD(1)),
    variant_index       UInt8                CODEC(T64, ZSTD(1)),
    evaluator_id        String               CODEC(ZSTD(1)),

    -- Score
    score               Float32              CODEC(ZSTD(1)),
    passed              UInt8                DEFAULT 0,           -- For pass/fail evaluators
    reasoning           String               CODEC(ZSTD(3)),
    evidence            String               DEFAULT '' CODEC(ZSTD(3)),  -- R1: evidence-first mode
    confidence          Float32              DEFAULT 1.0,

    -- Bias mitigation (R1)
    score_original      Float32              DEFAULT 0,           -- Score with original order
    score_swapped       Float32              DEFAULT 0,           -- Score with swapped order (position bias)
    was_position_swapped UInt8               DEFAULT 0,

    -- Trajectory scores (R5)
    milestone_completion_rate Float32        DEFAULT 0,
    handoff_correctness_rate  Float32        DEFAULT 0,
    path_efficiency_score     Float32        DEFAULT 0,

    -- Human review (R9)
    needs_human_review  UInt8                DEFAULT 0,
    human_score         Nullable(Float32),
    human_reviewed_at   Nullable(DateTime64(3)),

    -- Cost
    judge_tokens_used   UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    judge_cost          Float32              DEFAULT 0,
    judge_latency_ms    UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Versioning (R7)
    evaluator_version   UInt16               DEFAULT 1,

    created_at          DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_run       run_id               TYPE bloom_filter GRANULARITY 4,
    INDEX idx_evaluator evaluator_id         TYPE bloom_filter GRANULARITY 4,
    INDEX idx_review    needs_human_review   TYPE set(2) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.eval_scores', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id, variant_index)
TTL toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192
```

### 2.3 eval_production_scores (R6/R12: Online evaluation)

Stores scores from the eventstore `EvaluationDispatcher` running on production traffic.

```sql
CREATE TABLE IF NOT EXISTS abl_platform.eval_production_scores
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    agent_name        String               CODEC(ZSTD(1)),
    evaluator_name    LowCardinality(String) CODEC(ZSTD(1)),
    evaluator_type    LowCardinality(String) CODEC(ZSTD(1)),

    score             Float32              CODEC(ZSTD(1)),
    passed            UInt8                DEFAULT 0,
    reasoning         String               CODEC(ZSTD(3)),
    confidence        Float32              DEFAULT 1.0,

    tokens_used       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    cost              Float32              DEFAULT 0,
    latency_ms        UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_session session_id           TYPE bloom_filter GRANULARITY 4,
    INDEX idx_agent   agent_name           TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.eval_production_scores', '{replica}')
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, project_id, evaluator_name, timestamp)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192
```

---

## 3. Pipeline Architecture

### 3.0 Triggering & Orchestration Decision

**Orchestrator:** Restate (via `packages/pipeline-engine/`) — NOT BullMQ.

| Concern               | Decision                                               | Rationale                                                                                                                                                              |
| --------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration         | Restate durable workflows                              | Multi-step DAG (resolve → converse → judge → aggregate → store) maps to pipeline steps. Durable execution survives crashes. Live status via `getStatus` shared handler |
| Trigger mechanism     | `PipelineTrigger.triggerManual()`                      | Evals are manual or CI-triggered, not event-driven. No Kafka subscription needed                                                                                       |
| Concurrency control   | Restate `CombineablePromise.all` with `maxConcurrency` | Fan-out 75 conversations with bounded parallelism. Respects LLM rate limits                                                                                            |
| Status polling        | Restate `getStatus` shared handler                     | UI polls `GET /runs/:id/status` which queries Restate workflow state. No custom status infrastructure                                                                  |
| Why not BullMQ        | BullMQ is for single-step job queues                   | Eval is a DAG, not a queue. BullMQ can't express "run conversations, then judge all of them, then aggregate" without custom orchestration code                         |
| Why not Kafka trigger | Evals are demand-driven                                | Kafka topics (`abl.session.ended`) trigger analytics pipelines. Eval runs are user-initiated or CI-initiated, not triggered by production events                       |

**Triggering flow:**

```
Studio UI "Start Run" → POST /api/projects/:id/evals/runs
  → Create EvalRun record in MongoDB (status: 'pending')
  → Call PipelineTrigger.triggerManual({
      pipelineId: EVAL_PIPELINE_ID,
      tenantId,
      triggeredBy: userId,
      data: { runId, evalSetId, personas, scenarios, evaluators, variants, maxConcurrency }
    })
  → Restate creates durable PipelineRun workflow
  → Returns { runId, pipelineRunId }
  → Update EvalRun.status = 'running', EvalRun.pipelineRunId = pipelineRunId

CI/CD trigger → same POST endpoint with triggerSource: 'ci'

UI polls GET /runs/:runId/status
  → Calls Restate getStatus shared handler on PipelineRun workflow
  → Returns { status, stepsCompleted, stepsTotal, currentStep }
```

**Runtime agent execution (in-process):**

The `run-eval-conversation` activity invokes agents via the `@abl/compiler` package directly — not through the Runtime HTTP API. This mirrors how the A2A `AgentExecutorAdapter` works:

```
run-eval-conversation activity
  → Import SessionService from @abl/compiler
  → Create fresh session per (persona, scenario, variant) — isolated state
  → Loop: generatePersonaMessage() → SessionService.executeMessage() → collect traces
  → Return conversation + traceEvents + milestones
```

Each conversation gets its own `SessionService` instance with fresh state — no state leakage between variants.

### 3.1 New Activity Types

Register in `packages/pipeline-engine/src/pipeline/activity-metadata.ts`:

| Activity Type           | Purpose                                                                                                                                                                                        | Input                                             | Output                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `simulate-persona`      | Generate next persona message given conversation context                                                                                                                                       | personaConfig, conversationHistory, agentResponse | `{ message, personaFidelityScore }`                                |
| `execute-agent-turn`    | Run one agent turn via Runtime HTTP API (`POST /api/v1/chat/agent`); forwards `agentId` from `scenario.entryAgent` on first turn (no sessionId) so the runtime selects the correct entry agent | projectId, message, sessionId?, entryAgent?       | `{ response, sessionId, traceEvents, toolCalls, sessionEnded }`    |
| `run-eval-conversation` | Orchestrate a full multi-turn persona↔agent conversation                                                                                                                                       | persona, scenario, variant                        | `{ conversation, traceEvents, milestones, turnCount, durationMs }` |
| `judge-conversation`    | Score a conversation with an evaluator (LLM judge, code scorer, or trajectory)                                                                                                                 | conversation, evaluator, biasSettings             | `{ score, reasoning, evidence, confidence, cost }`                 |
| `aggregate-eval-run`    | Compute run-level aggregates and regression detection                                                                                                                                          | runId, scores[], baselineRunId?                   | `{ summary, regressionDetected, regressionDetails }`               |

### 3.2 Eval Pipeline Definition

```typescript
// packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.ts

export const EVAL_PIPELINE_ID = 'eval-run-pipeline';

export const evalPipelineDefinition: Omit<PipelineDefinition, '_id'> = {
  tenantId: '__platform__',
  name: 'Eval Run Pipeline',
  description: 'Execute persona×scenario×evaluator matrix evaluation',
  version: 1,
  status: 'active',

  trigger: { type: 'manual' },

  inputSchema: {
    required: ['tenantId', 'projectId', 'runId', 'evalSetId'],
    properties: {
      tenantId: { type: 'string' },
      projectId: { type: 'string' },
      runId: { type: 'string' },
      evalSetId: { type: 'string' },
    },
  },

  steps: [
    // Step 1: Resolve the matrix — load personas, scenarios, evaluators
    {
      id: 'resolve-matrix',
      name: 'Resolve Eval Matrix',
      type: 'call-llm', // Actually a data-fetch step — we'll use a custom activity
      config: { sourceStep: 'pipelineInput' },
      timeout: 10_000,
    },

    // Step 2: Run conversations (parallel fan-out per cell)
    // Each cell = (persona, scenario, variant)
    // The run-eval-conversation activity handles the multi-turn loop internally
    {
      id: 'run-conversations',
      name: 'Run Eval Conversations',
      type: 'run-eval-conversation',
      parallel: 'conversation-group',
      config: {
        maxConcurrency: '{{pipelineInput.maxConcurrency}}',
      },
      timeout: 600_000, // 10 min per conversation
      retries: 1,
    },

    // Step 3: Judge conversations (parallel fan-out per conversation×evaluator)
    {
      id: 'judge-conversations',
      name: 'Judge Conversations',
      type: 'judge-conversation',
      parallel: 'judge-group',
      config: {
        sourceStep: 'run-conversations',
      },
      timeout: 120_000,
      retries: 2,
    },

    // Step 4: Aggregate scores and detect regressions
    {
      id: 'aggregate-results',
      name: 'Aggregate Results',
      type: 'aggregate-eval-run',
      config: {
        sourceStep: 'judge-conversations',
      },
      timeout: 30_000,
    },

    // Step 5: Store results to ClickHouse
    {
      id: 'store-results',
      name: 'Store Eval Results',
      type: 'store-results',
      config: {
        destination: 'clickhouse',
        table: 'eval_scores',
      },
      timeout: 30_000,
    },
  ],

  createdBy: 'platform',
  createdAt: new Date(),
  updatedAt: new Date(),
};
```

### 3.3 Conversation Execution Flow (In-Process)

The `run-eval-conversation` activity imports the agent executor directly:

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts

export const runEvalConversationService = restate.service({
  name: 'RunEvalConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { persona, scenario, variantIndex, projectId, tenantId } = input.config;

      // 1. Initialize in-process agent executor
      const executor = await createAgentExecutor({
        tenantId,
        projectId,
        agentName: scenario.entryAgent,
      });

      // 2. Build persona system prompt
      const personaPrompt = buildPersonaPrompt(persona);

      // 3. Generate initial message (from scenario.initialMessage or LLM)
      let personaMessage =
        scenario.initialMessage ?? (await generatePersonaMessage(personaPrompt, scenario, []));

      const conversation: ConversationTurn[] = [];
      const allTraceEvents: PlatformEvent[] = [];
      const milestonesHit: string[] = [];
      const agentPath: string[] = [];

      // 4. Multi-turn conversation loop
      for (let turn = 0; turn < scenario.maxTurns; turn++) {
        // Send persona message to agent
        const agentResult = await executor.processMessage(personaMessage);

        conversation.push(
          { role: 'user', content: personaMessage, timestamp: new Date() },
          { role: 'agent', content: agentResult.response, timestamp: new Date() },
        );
        allTraceEvents.push(...agentResult.traceEvents);

        // Track agent path (handoffs)
        if (agentResult.currentAgent && !agentPath.includes(agentResult.currentAgent)) {
          agentPath.push(agentResult.currentAgent);
        }

        // Check milestones from trace events
        checkMilestones(agentResult.traceEvents, scenario.expectedMilestones, milestonesHit);

        // Check if conversation naturally ended
        if (agentResult.sessionEnded) break;

        // Generate next persona message
        personaMessage = await generatePersonaMessage(personaPrompt, scenario, conversation);

        // Check if persona decides conversation is done
        if (personaMessage === '__END__') break;
      }

      return {
        status: 'success',
        data: {
          conversation,
          traceEvents: allTraceEvents,
          milestonesHit,
          actualAgentPath: agentPath,
          turnCount: conversation.length / 2,
          toolCallCount: allTraceEvents.filter((e) => e.type === 'tool_call').length,
        },
      };
    },
  },
});
```

### 3.4 Judge Execution (with Bias Mitigation — R1)

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/judge-conversation.service.ts

export const judgeConversationService = restate.service({
  name: 'JudgeConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { conversation, evaluator, biasSettings } = input.config;

      // Handle evaluator types
      switch (evaluator.type) {
        case 'llm_judge':
          return await runLLMJudge(conversation, evaluator, biasSettings);
        case 'code_scorer':
          return await runCodeScorer(conversation, evaluator);
        case 'trajectory':
          return await runTrajectoryScorer(conversation, input.config);
        case 'human_review':
          // Sets judgeResult with score=0 and creates an EvalHumanReview MongoDB document
          // (status: 'pending') for human reviewers to retrieve and score later.
          return await queueForHumanReview(conversation, evaluator, input.config);
      }
    },
  },
});

async function runLLMJudge(
  conversation: ConversationTurn[],
  evaluator: IEvalEvaluator,
  biasSettings: IBiasSettings,
): Promise<StepOutput> {
  // R1: Blind evaluation — strip model attribution
  const transcript = biasSettings.blindEvaluation
    ? stripAttribution(conversation)
    : formatTranscript(conversation);

  // R1: Evidence-first mode (RULERS)
  const judgePrompt = biasSettings.evidenceFirstMode
    ? buildEvidenceFirstPrompt(evaluator, transcript)
    : buildStandardJudgePrompt(evaluator, transcript);

  // R1: Position swap — run twice with swapped order
  if (biasSettings.positionSwapEnabled) {
    const [scoreOriginal, scoreSwapped] = await Promise.all([
      callJudgeLLM(judgePrompt, evaluator),
      callJudgeLLM(swapConversationOrder(judgePrompt), evaluator),
    ]);

    const avgScore = (scoreOriginal.score + scoreSwapped.score) / 2;

    return {
      status: 'success',
      data: {
        score: avgScore,
        scoreOriginal: scoreOriginal.score,
        scoreSwapped: scoreSwapped.score,
        wasPositionSwapped: true,
        reasoning: scoreOriginal.reasoning,
        evidence: scoreOriginal.evidence,
        confidence: scoreOriginal.confidence,
        judgeCost: scoreOriginal.cost + scoreSwapped.cost,
        judgeTokensUsed: scoreOriginal.tokensUsed + scoreSwapped.tokensUsed,
        judgeLatencyMs: Math.max(scoreOriginal.latencyMs, scoreSwapped.latencyMs),
        needsHumanReview: avgScore < (evaluator.humanReviewThreshold ?? 0),
      },
    };
  }

  // Standard single-pass judging
  const result = await callJudgeLLM(judgePrompt, evaluator);
  return {
    status: 'success',
    data: {
      score: result.score,
      reasoning: result.reasoning,
      evidence: result.evidence,
      confidence: result.confidence,
      judgeCost: result.cost,
      judgeTokensUsed: result.tokensUsed,
      judgeLatencyMs: result.latencyMs,
      needsHumanReview: result.confidence < (evaluator.humanReviewThreshold ?? 0),
    },
  };
}
```

---

## 4. API Routes

All routes under `apps/studio/src/app/api/projects/[id]/evals/`.

### 4.1 Route Map

```
PERSONAS
  GET    /api/projects/:id/evals/personas               — List personas
  POST   /api/projects/:id/evals/personas               — Create persona
  GET    /api/projects/:id/evals/personas/:personaId     — Get persona
  PUT    /api/projects/:id/evals/personas/:personaId     — Update persona (bumps version)
  DELETE /api/projects/:id/evals/personas/:personaId     — Delete persona
  GET    /api/projects/:id/evals/personas/templates      — List built-in persona templates

SCENARIOS
  GET    /api/projects/:id/evals/scenarios               — List scenarios
  POST   /api/projects/:id/evals/scenarios               — Create scenario
  GET    /api/projects/:id/evals/scenarios/:scenarioId   — Get scenario
  PUT    /api/projects/:id/evals/scenarios/:scenarioId   — Update scenario (bumps version)
  DELETE /api/projects/:id/evals/scenarios/:scenarioId   — Delete scenario

EVALUATORS
  GET    /api/projects/:id/evals/evaluators              — List evaluators
  POST   /api/projects/:id/evals/evaluators              — Create evaluator
  GET    /api/projects/:id/evals/evaluators/:evaluatorId — Get evaluator
  PUT    /api/projects/:id/evals/evaluators/:evaluatorId — Update evaluator (bumps version)
  DELETE /api/projects/:id/evals/evaluators/:evaluatorId — Delete evaluator
  GET    /api/projects/:id/evals/evaluators/templates    — List built-in rubric templates

EVAL SETS
  GET    /api/projects/:id/evals/sets                    — List eval sets
  POST   /api/projects/:id/evals/sets                    — Create eval set
  GET    /api/projects/:id/evals/sets/:setId             — Get eval set
  PUT    /api/projects/:id/evals/sets/:setId             — Update eval set
  DELETE /api/projects/:id/evals/sets/:setId             — Delete eval set

RUNS
  GET    /api/projects/:id/evals/runs                    — List runs
  POST   /api/projects/:id/evals/runs                    — Start run (triggers pipeline)
  GET    /api/projects/:id/evals/runs/:runId             — Get run metadata
  GET    /api/projects/:id/evals/runs/:runId/scores      — Get scores from ClickHouse
  GET    /api/projects/:id/evals/runs/:runId/heatmap     — Get heat map data (aggregated)
  POST   /api/projects/:id/evals/runs/:runId/cancel      — Cancel running eval
  GET    /api/projects/:id/evals/runs/:runId/status      — Poll status (R3: CI/CD)

COMPARISON & ANALYTICS
  GET    /api/projects/:id/evals/runs/compare            — Compare two runs (R3)
         ?baseline=:runId&current=:runId&format=json|markdown
  POST   /api/projects/:id/evals/estimate                — Pre-run cost estimate (R4)
  GET    /api/projects/:id/evals/coverage                — Path coverage analysis

AI GENERATION
  POST   /api/projects/:id/evals/generate/personas       — AI-generate personas from agent analysis
  POST   /api/projects/:id/evals/generate/scenarios       — AI-generate scenarios from agent topology
  POST   /api/projects/:id/evals/quick                    — One-click: create set + run

HUMAN REVIEW (R9)
  GET    /api/projects/:id/evals/reviews                  — List pending reviews
  PUT    /api/projects/:id/evals/reviews/:reviewId        — Submit human review

PRODUCTION MONITORING (R6/R12)
  GET    /api/projects/:id/evals/production/scores        — Query production eval scores
  GET    /api/projects/:id/evals/production/trends        — Score trends over time
  GET    /api/projects/:id/evals/production/anomalies     — Anomaly alerts
```

### 4.2 Route Pattern (Example: POST /runs)

```typescript
// apps/studio/src/app/api/projects/[id]/evals/runs/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { EvalRun, EvalSet, EvalPersona, EvalScenario, EvalEvaluator } from '@abl/database';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const body = await request.json();
  const { evalSetId, name, notes, triggerSource = 'manual' } = body;

  // Load eval set with tenant isolation
  const evalSet = await EvalSet.findOne({
    _id: evalSetId,
    tenantId: access.project.tenantId,
    projectId,
  });
  if (!evalSet) return NextResponse.json({ error: 'Eval set not found' }, { status: 404 });

  // Snapshot entity versions (R7)
  const [personas, scenarios, evaluators] = await Promise.all([
    EvalPersona.find({ _id: { $in: evalSet.personaIds }, tenantId: access.project.tenantId }),
    EvalScenario.find({ _id: { $in: evalSet.scenarioIds }, tenantId: access.project.tenantId }),
    EvalEvaluator.find({ _id: { $in: evalSet.evaluatorIds }, tenantId: access.project.tenantId }),
  ]);

  const snapshot = {
    personaVersions: Object.fromEntries(personas.map((p) => [p._id, p.version])),
    scenarioVersions: Object.fromEntries(scenarios.map((s) => [s._id, s.version])),
    evaluatorVersions: Object.fromEntries(evaluators.map((e) => [e._id, e.version])),
  };

  // Create run record
  const run = await EvalRun.create({
    tenantId: access.project.tenantId,
    projectId,
    evalSetId,
    name: name ?? `Run ${new Date().toISOString()}`,
    notes,
    status: 'pending',
    triggerSource,
    triggeredBy: user.id,
    snapshot,
    startedAt: new Date(),
  });

  // Trigger pipeline
  const pipelineRunId = await triggerEvalPipeline({
    tenantId: access.project.tenantId,
    projectId,
    runId: run._id,
    evalSetId,
    personas: personas.map((p) => p.toObject()),
    scenarios: scenarios.map((s) => s.toObject()),
    evaluators: evaluators.map((e) => e.toObject()),
    variants: evalSet.variants,
    maxConcurrency: evalSet.maxConcurrency,
    baselineRunId: evalSet.baselineRunId,
    regressionThreshold: evalSet.regressionThreshold,
  });

  // Update with pipeline run ID
  await EvalRun.findOneAndUpdate(
    { _id: run._id, tenantId: access.project.tenantId },
    { pipelineRunId, status: 'running' },
  );

  return NextResponse.json({ success: true, run: { ...run.toObject(), pipelineRunId } });
}
```

### 4.3 Heat Map Query (ClickHouse)

```typescript
// GET /api/projects/:id/evals/runs/:runId/heatmap

export async function GET(request: NextRequest, { params }: RouteParams) {
  // ... auth + access checks ...

  const { runId } = await params;

  // Aggregate scores into heat map cells
  const query = `
    SELECT
      persona_id,
      scenario_id,
      evaluator_id,
      avg(score) AS avg_score,
      min(score) AS min_score,
      max(score) AS max_score,
      stddevPop(score) AS std_dev,
      count() AS variant_count,
      sum(needs_human_review) AS pending_reviews,
      sum(judge_cost) AS total_cost
    FROM abl_platform.eval_scores
    WHERE tenant_id = {tenantId:String}
      AND project_id = {projectId:String}
      AND run_id = {runId:String}
    GROUP BY persona_id, scenario_id, evaluator_id
    ORDER BY persona_id, scenario_id, evaluator_id
  `;

  const rows = await clickhouseQuery(query, { tenantId, projectId, runId });

  // Build heat map matrix
  const heatmap = buildHeatMap(rows);

  return NextResponse.json({ success: true, heatmap });
}
```

### 4.4 Run Comparison (R3: CI/CD)

```typescript
// GET /api/projects/:id/evals/runs/compare?baseline=X&current=Y&format=json|markdown

export async function GET(request: NextRequest, { params }: RouteParams) {
  // ... auth + access checks ...

  const url = new URL(request.url);
  const baselineId = url.searchParams.get('baseline');
  const currentId = url.searchParams.get('current');
  const format = url.searchParams.get('format') ?? 'json';

  const query = `
    SELECT
      b.persona_id,
      b.scenario_id,
      b.evaluator_id,
      avg(b.score) AS baseline_score,
      avg(c.score) AS current_score,
      avg(c.score) - avg(b.score) AS delta
    FROM abl_platform.eval_scores b
    JOIN abl_platform.eval_scores c
      ON b.persona_id = c.persona_id
      AND b.scenario_id = c.scenario_id
      AND b.evaluator_id = c.evaluator_id
    WHERE b.tenant_id = {tenantId:String}
      AND b.run_id = {baselineId:String}
      AND c.run_id = {currentId:String}
    GROUP BY b.persona_id, b.scenario_id, b.evaluator_id
    ORDER BY delta ASC
  `;

  const rows = await clickhouseQuery(query, { tenantId, baselineId, currentId });

  if (format === 'markdown') {
    // R3: Markdown for PR comments
    const md = renderComparisonMarkdown(rows, baselineId, currentId);
    return new Response(md, { headers: { 'Content-Type': 'text/markdown' } });
  }

  return NextResponse.json({ success: true, comparison: rows });
}
```

---

## 5. UI Architecture

### 5.1 Component Tree

```
apps/studio/src/components/evals/
├── EvalsPage.tsx                    — Main page with tab routing
├── tabs/
│   ├── PersonasTab.tsx              — Grid of persona cards
│   ├── ScenariosTab.tsx             — Table of scenarios
│   ├── EvaluatorsTab.tsx            — Grid of evaluator cards
│   ├── EvalSetsTab.tsx              — Matrix builder cards
│   ├── RunsTab.tsx                  — Heat map results view
│   └── ProductionMonitorTab.tsx     — R12: live production scores
├── dialogs/
│   ├── CreatePersonaDialog.tsx      — Create/edit persona form
│   ├── CreateScenarioDialog.tsx     — Create/edit scenario form
│   ├── CreateEvaluatorDialog.tsx    — Create/edit evaluator with rubric builder
│   ├── CreateEvalSetDialog.tsx      — Matrix builder with live preview
│   ├── StartRunDialog.tsx           — Run config + cost estimate
│   └── HumanReviewDialog.tsx        — R9: review interface
├── heatmap/
│   ├── HeatMap.tsx                  — Persona×Scenario score grid
│   ├── HeatMapCell.tsx              — Individual clickable cell
│   ├── HeatMapLegend.tsx            — Color scale legend
│   ├── ScoreDetail.tsx              — Expanded cell: per-evaluator breakdown
│   └── ConversationViewer.tsx       — Full transcript + traces
├── comparison/
│   ├── RunComparison.tsx            — Side-by-side delta heat maps
│   └── ScoreTrend.tsx               — Score history chart
├── production/
│   ├── ProductionScoreChart.tsx     — R12: time-series quality chart
│   ├── AnomalyAlert.tsx             — R12: anomaly notifications
│   └── ProductionDrillDown.tsx      — R12: conversation inspector
└── shared/
    ├── RubricBuilder.tsx            — R2: visual rubric point editor
    ├── BiasSettingsPanel.tsx         — R1: bias mitigation toggles
    ├── CostEstimate.tsx             — R4: pre-run cost breakdown
    ├── StatisticalSummary.tsx        — R8: confidence intervals, Pass@k
    └── EvalBadge.tsx                — Score badge with color coding
```

### 5.2 Zustand Store

```typescript
// apps/studio/src/store/evals-store.ts

interface EvalsState {
  // Active tab
  activeTab: EvalTab;
  setActiveTab: (tab: EvalTab) => void;

  // Selected run for heat map
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;

  // Selected heat map cell
  selectedCell: { personaId: string; scenarioId: string } | null;
  setSelectedCell: (cell: { personaId: string; scenarioId: string } | null) => void;

  // Run comparison
  compareBaselineId: string | null;
  compareCurrentId: string | null;
  setCompare: (baseline: string | null, current: string | null) => void;

  // Production monitoring (R12)
  productionTimeRange: '1h' | '6h' | '24h' | '7d' | '30d';
  setProductionTimeRange: (range: string) => void;
}

export const useEvalsStore = create<EvalsState>()(
  persist(
    (set) => ({
      activeTab: 'runs',
      setActiveTab: (activeTab) => set({ activeTab }),

      selectedRunId: null,
      setSelectedRunId: (selectedRunId) => set({ selectedRunId, selectedCell: null }),

      selectedCell: null,
      setSelectedCell: (selectedCell) => set({ selectedCell }),

      compareBaselineId: null,
      compareCurrentId: null,
      setCompare: (compareBaselineId, compareCurrentId) =>
        set({ compareBaselineId, compareCurrentId }),

      productionTimeRange: '24h',
      setProductionTimeRange: (productionTimeRange) => set({ productionTimeRange }),
    }),
    {
      name: 'kore-evals-storage',
      partialize: (state) => ({
        activeTab: state.activeTab,
        productionTimeRange: state.productionTimeRange,
      }),
    },
  ),
);
```

### 5.3 SWR Hooks

```typescript
// apps/studio/src/hooks/useEvalPersonas.ts
export function useEvalPersonas(projectId: string | null) {
  const key = projectId ? `/api/projects/${projectId}/evals/personas` : null;
  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; personas: IEvalPersona[] }>(key);
  const personas = useMemo(() => data?.personas ?? [], [data]);
  return { personas, isLoading, error: error ? String(error) : null, refresh: () => mutate() };
}

// apps/studio/src/hooks/useEvalScenarios.ts — same pattern

// apps/studio/src/hooks/useEvalEvaluators.ts — same pattern

// apps/studio/src/hooks/useEvalSets.ts — same pattern

// apps/studio/src/hooks/useEvalRuns.ts
export function useEvalRuns(projectId: string | null) {
  const key = projectId ? `/api/projects/${projectId}/evals/runs` : null;
  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; runs: IEvalRun[] }>(key);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  return { runs, isLoading, error: error ? String(error) : null, refresh: () => mutate() };
}

// apps/studio/src/hooks/useEvalHeatMap.ts
export function useEvalHeatMap(projectId: string | null, runId: string | null) {
  const key = projectId && runId
    ? `/api/projects/${projectId}/evals/runs/${runId}/heatmap`
    : null;
  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; heatmap: HeatMapData }>(
    key,
    { revalidateOnFocus: false },
  );
  return { heatmap: data?.heatmap ?? null, isLoading, error: error ? String(error) : null, refresh: () => mutate() };
}

// apps/studio/src/hooks/useEvalRunStatus.ts — polls running eval
export function useEvalRunStatus(projectId: string | null, runId: string | null) {
  const isRunning = /* check if run status is 'running' */;
  const key = projectId && runId && isRunning
    ? `/api/projects/${projectId}/evals/runs/${runId}/status`
    : null;
  const { data } = useSWR(key, {
    refreshInterval: 2000, // Poll every 2s while running
  });
  return data;
}

// apps/studio/src/hooks/useEvalComparison.ts
export function useEvalComparison(projectId: string | null, baselineId: string | null, currentId: string | null) {
  const key = projectId && baselineId && currentId
    ? `/api/projects/${projectId}/evals/runs/compare?baseline=${baselineId}&current=${currentId}`
    : null;
  const { data, isLoading } = useSWR(key, { revalidateOnFocus: false });
  return { comparison: data?.comparison ?? null, isLoading };
}

// apps/studio/src/hooks/useEvalProductionScores.ts (R12)
export function useEvalProductionScores(projectId: string | null, timeRange: string) {
  const key = projectId
    ? `/api/projects/${projectId}/evals/production/trends?range=${timeRange}`
    : null;
  const { data, isLoading } = useSWR(key, { refreshInterval: 30_000 }); // Refresh every 30s
  return { trends: data?.trends ?? null, isLoading };
}
```

### 5.4 Tab Specifications

#### Personas Tab

- **Layout:** 2-column card grid (matches spec-mock)
- **Card content:** Name, source badge (AI/Custom/Template/Adversarial), communication style + domain knowledge badges, behavior traits chips, collapsible goals/constraints, "Used in N sets" footer
- **Actions:** Create, edit, delete, duplicate, "Generate with AI" button
- **AI generation:** "Generate Personas" button → calls `/generate/personas` → returns 3-5 suggestions based on agent topology analysis

#### Scenarios Tab

- **Layout:** Table view (matches spec-mock)
- **Columns:** Name+description, category badge, difficulty badge (easy/medium/hard with color), agent path flow arrows, tags chips, max turns
- **Actions:** Create, edit, delete, "Generate from Agent Topology" button
- **New (R5):** Expected milestones column (collapsible), max tool calls

#### Evaluators Tab

- **Layout:** 3-column card grid (matches spec-mock)
- **Card content:** Icon + name, description, category + scale type badges, judge model, built-in/custom badge
- **New (R1):** Bias mitigation status badge ("Bias-Mitigated" when position swap + blind eval enabled)
- **New (R2):** Rubric preview — show scale points inline on card
- **Dialog:** Full rubric builder with per-point behavioral anchors, bias settings panel, judge model selector

#### Eval Sets Tab

- **Layout:** 2-column cards with matrix preview (matches spec-mock)
- **Card content:** Name, dimension string (P×S×E×V), total evaluations count, persona/scenario/evaluator chip lists, last run score, "Run"/"Run Again" button
- **New (R3):** CI badge when `ciEnabled`, regression threshold display
- **New (R4):** Estimated cost per run
- **Dialog:** Multi-select for personas/scenarios/evaluators, variants slider, live matrix preview, concurrency config, CI settings

#### Runs Tab

- **Layout:** Run selector dropdown + heat map (matches spec-mock)
- **Heat map:** Persona rows × scenario columns, cells colored by avg score, click to expand per-evaluator detail with reasoning
- **Run summary:** Status, avg score, duration, cost (R4)
- **New (R1):** Cells with dashed border = position swap detected inconsistency
- **New (R5):** Trajectory metrics in detail panel (milestones hit, path efficiency)
- **New (R8):** Statistical summary panel: mean, std dev, 95% CI, Pass@k, Pass^k
- **New (R9):** "Pending reviews" badge when human reviews are queued
- **Actions:** Re-run, compare with baseline, export, "Fix in Architect →"

#### Production Monitor Tab (R6/R12)

- **Layout:** Time-series chart + anomaly alerts + conversation drill-down
- **Chart:** Score trends by evaluator over selected time range (1h/6h/24h/7d/30d)
- **Alerts:** Cards showing score drops below threshold with "Investigate" action
- **Drill-down:** Click alert → view production conversation + scores
- **Connection:** "Run Offline Eval" button when anomaly detected → pre-fills an eval set targeting the affected agent

---

## 6. Research-Backed Features — Implementation Details

### R1: Bias Mitigation

- `BiasSettingsPanel.tsx` component with 4 toggles
- `IBiasSettings` embedded in evaluator model (default: position swap ON, blind eval ON)
- Judge service runs twice when position swap enabled (parallel `Promise.all`)
- `score_original` and `score_swapped` stored in ClickHouse for transparency
- Heat map cells with >1.0 score delta between original/swapped get visual indicator

### R2: Structured Rubrics

- `RubricBuilder.tsx` component: add/remove/reorder rubric points with label, criteria, examples
- Only `1-5` and `pass-fail` scales (no `1-10`)
- Ship 6 built-in templates: Task Completion, Response Quality, Safety, Empathy, Tool Correctness, Handoff Quality
- Templates stored in code (`eval-rubric-templates.ts`), not DB

### R3: CI/CD Integration

- `POST /runs` accepts `triggerSource: 'ci'` with optional `baselineRunId`
- `GET /runs/:id/status` for polling (returns `{ status, progress, scores }`)
- `GET /runs/compare?format=markdown` returns PR-ready diff table
- `EvalSet.ciEnabled` + `regressionThreshold` fields
- Auto-compare against `baselineRunId` when run completes; flag regressions

### R4: Cost Estimation

- `POST /estimate` computes: conversations (P×S×V×avgTurns×costPerTurn) + judging (P×S×V×E×costPerJudge)
- `CostEstimate.tsx` component in StartRunDialog showing breakdown + monthly budget remaining
- `estimatedCost` and `actualCost` tracked per run in summary
- Project-level `monthlyEvalBudget` field (optional)

### R5: Trajectory Evaluation

- `EvalScenario.expectedMilestones` and `EvalScenario.maxToolCalls` fields
- `run-eval-conversation` activity tracks milestones from trace events
- 4 built-in trajectory scorers: `milestoneCompletionScorer`, `handoffCorrectnessScorer`, `pathEfficiencyScorer`, `toolSequenceScorer`
- Trajectory scores stored in ClickHouse `eval_scores` alongside judge scores

### R6: Online/Offline Separation

- **Offline** (this design): Studio UI matrix evaluation with synthetic personas
- **Online** (existing eventstore): `EvaluationDispatcher` on production `session.ended` events
- Both share evaluator definitions (same `IEvalEvaluator` model)
- Online scores → `eval_production_scores` ClickHouse table
- Production Monitor tab surfaces online scores

### R7: Dataset Versioning

- `version` field on Persona, Scenario, Evaluator (auto-incremented on PUT)
- `EvalRun.snapshot` records versions used at run time
- ClickHouse rows carry `persona_version`, `scenario_version`, `evaluator_version`
- Run detail view shows "Persona v2, Scenario v1, Evaluator v3"

### R8: Statistical Significance

- Run summary computes: mean, stdDev, 95% CI, Pass@k, Pass^k
- `StatisticalSummary.tsx` component shows these metrics
- Run comparison: delta shown with significance indicator (solid = significant, dashed = inconclusive)
- Minimum 3 variants enforced (5 recommended for high-stakes)

### R9: Human Review

- `human_review` evaluator type queues items via `EvalHumanReview` MongoDB collection
- `HumanReviewDialog.tsx`: shows transcript + LLM score + reasoning, human confirms/overrides
- Triggered when LLM judge confidence < `humanReviewThreshold`
- Human score written back to ClickHouse `eval_scores.human_score`
- Dashboard shows human-vs-LLM agreement rate as meta-metric

### R10: Adversarial Personas

- 5 built-in templates: Prompt Injector, Social Engineer, Off-Topic Derailer, Abusive User, Edge Case Explorer
- `isAdversarial: true` flag with `adversarialType` enum
- Persona card shows red "Adversarial" badge
- Adversarial results surface in a separate section of heat map

### R11: ABL DSL `EVALUATIONS` Block (Phase 5)

```yaml
EVALUATIONS:
  builtin: [task_completion, safety, tool_correctness]
  custom:
    - name: 'empathy_check'
      type: llm_judge
      rubric:
        scale: 1-5
        points:
          5: 'Exceptionally empathetic...'
          1: 'Dismissive or cold...'
```

- Compiler extracts evaluator configs → registers with project
- Lower priority — Studio UI sufficient for most users

### R12: Production Monitoring

- New tab in EvalsPage: "Production"
- Queries `eval_production_scores` ClickHouse table
- Time-series chart (score by evaluator over time)
- Anomaly detection: score drops >2 std dev from 7-day rolling average
- Alert cards with "Investigate" → drill into production conversation
- "Run Offline Eval" button → pre-fills eval set for affected agent

---

## 7. Production Readiness

### 7.1 Circuit Breakers

The eval pipeline makes external LLM calls for persona simulation and judging. These are wrapped in circuit breakers following the existing three-state pattern (`packages/circuit-breaker/`).

**Breaker instances:**

| Breaker               | Wraps                        | Failure Threshold | Reset Timeout | Fallback                                   |
| --------------------- | ---------------------------- | ----------------- | ------------- | ------------------------------------------ |
| `eval-persona-llm`    | Persona simulation LLM calls | 5 failures in 60s | 30s           | Skip variant, mark conversation as `error` |
| `eval-judge-llm`      | Judge LLM calls              | 5 failures in 60s | 30s           | Queue for retry, mark score as `pending`   |
| `eval-agent-executor` | In-process agent execution   | 3 failures in 60s | 15s           | Abort conversation, mark as `error`        |

**Registration in `HybridCircuitBreakerRegistry`:**

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts

import { HybridCircuitBreakerRegistry } from '@abl/circuit-breaker';

export function registerEvalCircuitBreakers(registry: HybridCircuitBreakerRegistry): void {
  registry.register('eval-persona-llm', {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
    onOpen: (breakerName) => {
      log.warn('Eval persona LLM circuit opened', { breakerName });
      evalMetrics.circuitBreakerOpened.add(1, { breaker: 'persona-llm' });
    },
  });

  registry.register('eval-judge-llm', {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30_000,
    windowMs: 60_000,
    onOpen: (breakerName) => {
      log.warn('Eval judge LLM circuit opened', { breakerName });
      evalMetrics.circuitBreakerOpened.add(1, { breaker: 'judge-llm' });
    },
  });

  registry.register('eval-agent-executor', {
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeoutMs: 15_000,
    windowMs: 60_000,
    onOpen: (breakerName) => {
      log.error('Eval agent executor circuit opened — agent may be broken', { breakerName });
      evalMetrics.circuitBreakerOpened.add(1, { breaker: 'agent-executor' });
    },
  });
}
```

**Usage in activities:**

```typescript
// Inside run-eval-conversation activity
const result = await registry.execute('eval-agent-executor', async () => {
  return sessionService.executeMessage(sessionId, personaMessage);
});

// Inside judge-conversation activity
const result = await registry.execute('eval-judge-llm', async () => {
  return callJudgeLLM(judgePrompt, evaluator);
});
```

**Cascading behavior:** When `eval-agent-executor` opens, the entire eval run transitions to `degraded` status. Remaining conversations are skipped. Completed scores are preserved — partial results are still valuable. When `eval-judge-llm` opens, conversations continue but judging is deferred to a retry queue.

### 7.2 Observability & Metrics

Extend the existing OpenTelemetry Meter API (`apps/runtime/src/observability/metrics.ts`) with eval-specific instruments.

**New metric instruments:**

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-metrics.ts

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('abl-eval');

export const evalMetrics = {
  // Run lifecycle
  runsStarted: meter.createCounter('eval.run.started', { description: 'Eval runs initiated' }),
  runsCompleted: meter.createCounter('eval.run.completed', { description: 'Eval runs finished' }),
  runsFailed: meter.createCounter('eval.run.failed', { description: 'Eval runs failed' }),
  runDuration: meter.createHistogram('eval.run.duration_ms', {
    description: 'End-to-end run duration',
  }),

  // Conversation generation
  conversationsStarted: meter.createCounter('eval.conversation.started'),
  conversationsCompleted: meter.createCounter('eval.conversation.completed'),
  conversationsFailed: meter.createCounter('eval.conversation.failed'),
  conversationDuration: meter.createHistogram('eval.conversation.duration_ms'),
  conversationTurns: meter.createHistogram('eval.conversation.turns'),

  // Judging
  judgeCallsStarted: meter.createCounter('eval.judge.started'),
  judgeCallsCompleted: meter.createCounter('eval.judge.completed'),
  judgeCallsFailed: meter.createCounter('eval.judge.failed'),
  judgeDuration: meter.createHistogram('eval.judge.duration_ms'),
  judgeTokensUsed: meter.createCounter('eval.judge.tokens_used'),

  // Cost tracking
  runCost: meter.createHistogram('eval.run.cost_usd', { description: 'Total run cost in USD' }),
  judgeCost: meter.createHistogram('eval.judge.cost_usd'),
  personaCost: meter.createHistogram('eval.persona.cost_usd'),

  // Scores
  scoreValue: meter.createHistogram('eval.score.value', {
    description: 'Distribution of eval scores',
  }),
  regressionCount: meter.createCounter('eval.regression.detected', {
    description: 'Regression detections',
  }),

  // Circuit breakers
  circuitBreakerOpened: meter.createCounter('eval.circuit_breaker.opened'),

  // Rate limiting (RD2)
  rateLimitRejections: meter.createCounter('eval.rate_limit.rejected'),
  rateLimitQueueDepth: meter.createUpDownCounter('eval.rate_limit.queue_depth'),

  // Active state
  activeRuns: meter.createUpDownCounter('eval.active_runs'),
  activeConversations: meter.createUpDownCounter('eval.active_conversations'),
};
```

**Metric labels (attributes):**

All eval metrics carry these attributes for slicing:

- `tenant_id` — per-tenant dashboards
- `project_id` — per-project drill-down
- `eval_set_id` — compare eval sets
- `evaluator_type` — `llm_judge` vs `code_scorer` vs `trajectory`

**Example instrumentation in activities:**

```typescript
// run-eval-conversation activity
evalMetrics.conversationsStarted.add(1, { tenant_id: tenantId, project_id: projectId });
evalMetrics.activeConversations.add(1, { tenant_id: tenantId });

const start = Date.now();
try {
  const result = await executeConversation(...);
  evalMetrics.conversationsCompleted.add(1, { tenant_id: tenantId });
  evalMetrics.conversationDuration.record(Date.now() - start, { tenant_id: tenantId });
  evalMetrics.conversationTurns.record(result.turnCount, { tenant_id: tenantId });
} catch (err) {
  evalMetrics.conversationsFailed.add(1, { tenant_id: tenantId });
  throw err;
} finally {
  evalMetrics.activeConversations.add(-1, { tenant_id: tenantId });
}
```

### 7.3 Structured Logging

Use `createLogger` from `@abl/compiler/platform` following the existing Pino pattern. Sensitive data (conversation content, persona prompts) is redacted automatically via the Pino redaction config.

**Logger instances:**

```typescript
// One logger per eval module
const log = createLogger('eval:run'); // Run orchestration
const log = createLogger('eval:conversation'); // Conversation generation
const log = createLogger('eval:judge'); // LLM judging
const log = createLogger('eval:aggregate'); // Score aggregation
const log = createLogger('eval:rate-limiter'); // Rate limiting
```

**Log points and levels:**

| Event                   | Level   | Context Fields                                                                       |
| ----------------------- | ------- | ------------------------------------------------------------------------------------ |
| Run started             | `info`  | `{ runId, evalSetId, tenantId, projectId, matrix: '3P×5S×3V', triggerSource }`       |
| Run completed           | `info`  | `{ runId, durationMs, avgScore, totalConversations, totalCost, regressionDetected }` |
| Run failed              | `error` | `{ runId, error, failedStep, completedCells, totalCells }`                           |
| Conversation started    | `debug` | `{ runId, personaId, scenarioId, variantIndex }`                                     |
| Conversation completed  | `debug` | `{ runId, personaId, scenarioId, turnCount, durationMs }`                            |
| Conversation error      | `warn`  | `{ runId, personaId, scenarioId, error, turnReached }`                               |
| Judge call started      | `debug` | `{ runId, evaluatorId, evaluatorType, judgeModel }`                                  |
| Judge score produced    | `debug` | `{ runId, evaluatorId, score, confidence, durationMs, tokensUsed }`                  |
| Judge call failed       | `warn`  | `{ runId, evaluatorId, error, retryAttempt }`                                        |
| Bias inconsistency      | `warn`  | `{ runId, evaluatorId, scoreOriginal, scoreSwapped, delta }`                         |
| Circuit breaker opened  | `warn`  | `{ breakerName, failureCount, windowMs }`                                            |
| Circuit breaker closed  | `info`  | `{ breakerName, successCount }`                                                      |
| Rate limit hit          | `warn`  | `{ tenantId, limitType, currentValue, maxValue }`                                    |
| Run queued (rate limit) | `info`  | `{ runId, tenantId, queuePosition, reason }`                                         |
| Regression detected     | `warn`  | `{ runId, evaluatorId, personaId, scenarioId, baseline, current, delta }`            |
| Cost budget exceeded    | `warn`  | `{ tenantId, projectId, monthlyBudget, currentSpend, runCost }`                      |
| Human review queued     | `info`  | `{ runId, evaluatorId, llmScore, confidence, threshold }`                            |

**Sensitive data handling:**

- Conversation content is NOT logged (already handled by Pino redaction paths)
- Persona system prompts are NOT logged (may contain PII instructions)
- Only metadata (IDs, scores, durations, counts) appears in logs
- Full transcripts available only via ClickHouse query with tenant-scoped access

### 7.4 System Health

#### Health Check Endpoint

Register eval-specific health probes with the existing service registry (`apps/runtime/src/health/service-registry.ts`).

**New service entries:**

```typescript
// Add to service-registry.ts
{
  id: 'eval-pipeline',
  name: 'Eval Pipeline Engine',
  group: 'agent-execution',
  check: async () => {
    // Probe Restate: can we reach the PipelineRun workflow?
    const restateHealth = await fetch(`${RESTATE_ADMIN_URL}/health`);
    return restateHealth.ok ? 'healthy' : 'down';
  },
  dependsOn: ['restate', 'mongodb', 'clickhouse'],
},
{
  id: 'eval-rate-limiter',
  name: 'Eval Rate Limiter',
  group: 'agent-execution',
  check: async () => {
    // Redis ping for rate limiter keys
    const pong = await redis.ping();
    return pong === 'PONG' ? 'healthy' : 'degraded';
  },
  dependsOn: ['redis'],
},
```

#### Resilience Dashboard

Extend `/api/platform/admin/resilience` to expose eval circuit breaker states:

```json
{
  "circuitBreakers": {
    "eval-persona-llm": { "state": "closed", "failures": 0, "lastFailure": null },
    "eval-judge-llm": { "state": "half-open", "failures": 3, "lastFailure": "2026-03-04T..." },
    "eval-agent-executor": { "state": "closed", "failures": 0, "lastFailure": null }
  },
  "rateLimits": {
    "tenant-acme": {
      "concurrentRuns": { "current": 2, "max": 3 },
      "concurrentConversations": { "current": 8, "max": 20 },
      "llmCallsPerMinute": { "current": 45, "max": 60 }
    }
  },
  "activeRuns": [
    {
      "runId": "run-123",
      "tenantId": "acme",
      "status": "running",
      "progress": "12/45 cells",
      "startedAt": "..."
    }
  ]
}
```

#### Eval-Specific Health API

```
GET /api/projects/:id/evals/health
```

Returns eval subsystem status for a project:

```json
{
  "status": "healthy",
  "pipeline": { "restate": "healthy", "latencyMs": 12 },
  "storage": {
    "mongodb": "healthy",
    "clickhouse": "healthy",
    "clickhouseRowCount": 15234
  },
  "circuitBreakers": {
    "eval-persona-llm": "closed",
    "eval-judge-llm": "closed",
    "eval-agent-executor": "closed"
  },
  "rateLimits": {
    "concurrentRuns": { "current": 1, "max": 3 },
    "monthlyBudget": { "spent": 45.2, "max": 100.0 }
  },
  "activeRuns": 1,
  "lastRunAt": "2026-03-04T10:30:00Z",
  "lastRunStatus": "completed"
}
```

### 7.5 Scaling

#### Horizontal Scaling Model

```
                     ┌──────────────┐
  Studio UI ────────▶│  Studio API  │──── MongoDB (config CRUD)
                     └──────┬───────┘
                            │ triggerManual()
                            ▼
                     ┌──────────────┐
                     │   Restate    │──── Durable workflow state
                     │  (stateless) │
                     └──────┬───────┘
                            │ fan-out
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
       ┌────────────┐┌────────────┐┌────────────┐
       │  Activity   ││  Activity   ││  Activity   │
       │  Worker 1   ││  Worker 2   ││  Worker N   │  ← Stateless, horizontally scalable
       └──────┬─────┘└──────┬─────┘└──────┬─────┘
              │             │             │
              ▼             ▼             ▼
       ┌─────────────────────────────────────┐
       │       LLM Provider API Pool         │  ← Rate-limited per tenant
       └─────────────────────────────────────┘
              │             │             │
              ▼             ▼             ▼
       ┌────────────┐ ┌────────────┐
       │  ClickHouse │ │  MongoDB   │  ← Scores + conversations / Run metadata
       └────────────┘ └────────────┘
```

**Scaling characteristics:**

| Component        | Scaling Strategy                                                        | Bottleneck                                                    |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Studio API       | Stateless pods behind LB. Scale with request count                      | Unlikely bottleneck — eval API is low-RPS                     |
| Restate          | Stateless orchestrator. Scale with concurrent workflows                 | Memory proportional to active workflow state                  |
| Activity Workers | Stateless. Scale with concurrent conversations                          | Primary scaling lever. Each worker runs N activities          |
| LLM Provider     | External. Cannot scale — rate-limited                                   | The real bottleneck. Rate limiter (RD2) prevents overload     |
| MongoDB          | Existing cluster. Eval adds light write load (run metadata only)        | Not a bottleneck — few writes per run                         |
| ClickHouse       | Existing cluster. Eval adds moderate write load (scores, conversations) | Buffered writes. Not a bottleneck unless >100 concurrent runs |

**Scaling triggers:**

| Metric                        | Threshold                    | Action                                                            |
| ----------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `eval.active_conversations`   | > 50 per worker              | Scale activity workers horizontally                               |
| `eval.rate_limit.queue_depth` | > 10 queued runs             | Alert: tenant hitting limits, consider plan upgrade               |
| `eval.judge.duration_ms` p95  | > 30s                        | Check LLM provider health, open circuit if degraded               |
| `eval.run.duration_ms`        | > 30 min for standard matrix | Investigate: agent may be looping, check conversation turn counts |

#### Backpressure Handling

When the system is overloaded, backpressure propagates cleanly:

1. **LLM rate limit hit** → Rate limiter blocks `acquire()` → activity pauses → Restate workflow suspends (durable, no resource waste)
2. **Too many concurrent runs** → New runs stay `pending` in MongoDB → scheduler promotes when slots free → UI shows queue position
3. **ClickHouse write buffer full** → `BufferedClickHouseWriter` rejects inserts → scores queued in Restate workflow state → retry on next flush
4. **Circuit breaker opens** → Activities return immediately with fallback → partial results preserved → run marked `degraded`

#### Resource Limits

```typescript
// Per-eval-run resource guards
const EVAL_RESOURCE_LIMITS = {
  maxConversationsPerRun: 500, // Safety cap: 10P × 10S × 5V
  maxTurnsPerConversation: 50, // Prevent infinite loops
  maxTokensPerConversation: 100_000, // Cost guard
  maxJudgeTokensPerScore: 10_000, // Judge prompt size guard
  maxRunDurationMs: 60 * 60 * 1000, // 1 hour hard timeout
  maxConcurrentRunsPerTenant: 5, // From RD2
};
```

Enforced at the pipeline step level. Exceeding any limit aborts the conversation/run with a descriptive error, not a silent failure.

### 7.6 Error Recovery & Retry

#### Retry Strategy Per Activity

| Activity                | Retries | Backoff                     | Retryable Errors                                 |
| ----------------------- | ------- | --------------------------- | ------------------------------------------------ |
| `run-eval-conversation` | 1       | 5s fixed                    | Agent compilation failure, transient LLM error   |
| `judge-conversation`    | 2       | Exponential (1s, 2s)        | LLM timeout, rate limit (429), transient network |
| `simulate-persona`      | 2       | Exponential (1s, 2s)        | LLM timeout, rate limit (429)                    |
| `aggregate-eval-run`    | 3       | Exponential (500ms, 1s, 2s) | ClickHouse query timeout, MongoDB write conflict |
| `store-results`         | 3       | Exponential (1s, 2s, 4s)    | ClickHouse insert failure, buffer full           |

**Non-retryable errors** (immediate failure):

- Agent DSL compilation error (agent is broken, retrying won't help)
- Invalid evaluator config (rubric parse failure)
- Authentication/authorization failure
- Budget exceeded

#### Dead Letter Handling

Failed eval activities after max retries are written to the existing dead letter table (`event_dead_letter` in ClickHouse):

```typescript
// After max retries exhausted
await deadLetterWriter.write({
  event_type: 'eval.judge.failed',
  tenant_id: tenantId,
  session_id: runId,
  payload: JSON.stringify({ evaluatorId, personaId, scenarioId, variantIndex }),
  error_message: err instanceof Error ? err.message : String(err),
  retry_count: maxRetries,
});
```

**Recovery:** Admin can query dead letter events, fix the root cause (e.g., fix evaluator prompt, increase timeout), and re-run the eval set.

#### Partial Run Completion

When a run fails partway through (some conversations or scores missing):

1. Run status → `completed` (not `failed`) if ≥50% of cells have scores
2. Run status → `failed` if <50% of cells have scores
3. `EvalRun.summary.completedCells` and `totalCells` track partial completion
4. Heat map renders completed cells with scores, missing cells show "—" with tooltip "Evaluation failed"
5. "Resume" button on failed runs → re-runs only the missing cells (checks ClickHouse for existing scores, skips completed ones)

```typescript
// In aggregate-eval-run activity
const completionRate = completedCells / totalCells;
const status = completionRate >= 0.5 ? 'completed' : 'failed';
const summary = {
  ...scores,
  completedCells,
  totalCells,
  completionRate,
  partialResults: completionRate < 1.0,
};
```

### 7.7 Alert Rules for Evals

Pre-configured alert rules that fire via the existing alert delivery system (`apps/runtime/src/services/alert-delivery.ts`):

| Alert                     | Condition                                    | Severity   | Channel                   |
| ------------------------- | -------------------------------------------- | ---------- | ------------------------- |
| Eval run failed           | `eval.run.failed` count > 0 in 5min          | `error`    | Webhook + admin dashboard |
| All circuit breakers open | Any `eval.circuit_breaker.opened`            | `critical` | Webhook + admin dashboard |
| Cost budget >80%          | Monthly eval spend > 80% of budget           | `warning`  | Admin dashboard only      |
| Cost budget exceeded      | Monthly eval spend > 100% of budget          | `error`    | Webhook + admin dashboard |
| Regression detected       | `eval.regression.detected` count > 0         | `warning`  | Webhook + admin dashboard |
| Run duration exceeded     | `eval.run.duration_ms` > 30 min              | `warning`  | Admin dashboard only      |
| Judge latency spike       | `eval.judge.duration_ms` p95 > 30s for 5min  | `warning`  | Admin dashboard only      |
| Rate limit saturation     | `eval.rate_limit.queue_depth` > 10 for 10min | `info`     | Admin dashboard only      |

---

## 8. Query Optimization & Ingestion Performance

### 8.1 ClickHouse Materialized Views (Pre-Aggregated Rollups)

The heat map is the most expensive eval query — it aggregates scores across the full persona×scenario×evaluator matrix for a run. Instead of computing this on every UI load, we use ClickHouse materialized views that incrementally maintain rollups as scores are inserted.

**MV 1: Per-Cell Average (powers the heat map)**

```sql
-- Pre-aggregates scores per cell: avg score, count, stddev — no raw table scan needed for heatmap
CREATE MATERIALIZED VIEW abl_platform.mv_eval_heatmap_dest
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(min_created_at)
ORDER BY (tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id)
AS SELECT
    tenant_id,
    project_id,
    run_id,
    evaluator_id,
    persona_id,
    scenario_id,
    avgState(score)              AS avg_score,
    countState()                 AS variant_count,
    varSampState(score)          AS score_variance,
    minState(score)              AS min_score,
    maxState(score)              AS max_score,
    sumState(judge_cost)         AS total_judge_cost,
    sumState(judge_tokens_used)  AS total_judge_tokens,
    minState(created_at)         AS min_created_at
FROM abl_platform.eval_scores
GROUP BY tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id;
```

**MV 2: Per-Evaluator Run Summary (powers the run overview)**

```sql
-- Aggregates all scores per evaluator within a run — drives the run summary cards
CREATE MATERIALIZED VIEW abl_platform.mv_eval_run_evaluator_summary_dest
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(min_created_at)
ORDER BY (tenant_id, project_id, run_id, evaluator_id)
AS SELECT
    tenant_id,
    project_id,
    run_id,
    evaluator_id,
    avgState(score)               AS avg_score,
    countState()                  AS total_scores,
    countIfState(passed = 1)      AS passed_count,
    varSampState(score)           AS score_variance,
    quantileState(0.05)(score)    AS p5_score,
    quantileState(0.50)(score)    AS p50_score,
    quantileState(0.95)(score)    AS p95_score,
    sumState(judge_cost)          AS total_cost,
    minState(created_at)          AS min_created_at
FROM abl_platform.eval_scores
GROUP BY tenant_id, project_id, run_id, evaluator_id;
```

**MV 3: Score Trend Over Time (powers the trend chart)**

```sql
-- Daily score trend per project+evaluator — drives the "quality over time" chart
CREATE MATERIALIZED VIEW abl_platform.mv_eval_score_trend_dest
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, evaluator_id, day)
AS SELECT
    tenant_id,
    project_id,
    evaluator_id,
    toDate(created_at) AS day,
    run_id,
    avgState(score)          AS avg_score,
    countState()             AS score_count,
    varSampState(score)      AS score_variance,
    minState(created_at)     AS min_created_at
FROM abl_platform.eval_scores
GROUP BY tenant_id, project_id, evaluator_id, day, run_id;
```

**MV 4: Production Score Hourly Rollup (powers the production monitoring tab)**

```sql
-- Hourly aggregation of production scores — drives the production monitoring dashboard
CREATE MATERIALIZED VIEW abl_platform.mv_eval_production_hourly_dest
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, evaluator_name, agent_name, hour)
TTL hour + INTERVAL 365 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    evaluator_name,
    agent_name,
    toStartOfHour(timestamp)     AS hour,
    avgState(score)              AS avg_score,
    countState()                 AS eval_count,
    countIfState(passed = 0)     AS failed_count,
    quantileState(0.05)(score)   AS p5_score,
    sumState(cost)               AS total_cost,
    avgState(latency_ms)         AS avg_latency,
    minState(timestamp)          AS min_timestamp
FROM abl_platform.eval_production_scores
GROUP BY tenant_id, project_id, evaluator_name, agent_name, hour;
```

**Query pattern — heat map reads the MV, not the raw table:**

```typescript
// Before (raw table scan — slow for large runs):
// SELECT avg(score) FROM eval_scores WHERE run_id = ? GROUP BY persona_id, scenario_id, evaluator_id

// After (reads pre-aggregated MV — sub-100ms):
const heatmapQuery = `
  SELECT
    persona_id,
    scenario_id,
    evaluator_id,
    avgMerge(avg_score)       AS score,
    countMerge(variant_count) AS variants,
    varSampMerge(score_variance) AS variance,
    minMerge(min_score)       AS min_score,
    maxMerge(max_score)       AS max_score
  FROM abl_platform.mv_eval_heatmap_dest
  WHERE tenant_id = {tenantId:String}
    AND project_id = {projectId:String}
    AND run_id = {runId:String}
  GROUP BY persona_id, scenario_id, evaluator_id
`;
```

### 8.2 ClickHouse Table Enhancements

**Additional skip indexes on eval_conversations:**

```sql
-- Add to eval_conversations for trajectory and error queries
INDEX idx_error     has_error          TYPE set(2) GRANULARITY 4,
INDEX idx_turns     turn_count         TYPE minmax GRANULARITY 4,
INDEX idx_duration  duration_ms        TYPE minmax GRANULARITY 4
```

**Additional skip indexes on eval_scores:**

```sql
-- Add to eval_scores for score range queries and pass/fail filtering
INDEX idx_score     score              TYPE minmax GRANULARITY 4,
INDEX idx_passed    passed             TYPE set(2) GRANULARITY 4,
INDEX idx_persona   persona_id         TYPE bloom_filter GRANULARITY 4,
INDEX idx_scenario  scenario_id        TYPE bloom_filter GRANULARITY 4
```

**LowCardinality optimization for repeated string columns:**

```sql
-- In eval_scores: evaluator_id has low cardinality within a run (5-10 unique values)
-- But globally unbounded across tenants. Use LowCardinality only for production_scores:
evaluator_name    LowCardinality(String)  -- Already in design ✓
evaluator_type    LowCardinality(String)  -- Already in design ✓
agent_name        LowCardinality(String)  -- Already in design ✓
```

**Projection for run-scoped queries (ClickHouse 22.6+):**

```sql
-- Add projection to eval_scores for fast per-run lookups ordered by evaluator
ALTER TABLE abl_platform.eval_scores
ADD PROJECTION proj_by_run_evaluator (
    SELECT *
    ORDER BY (tenant_id, project_id, run_id, evaluator_id)
);

-- Populate for existing data
ALTER TABLE abl_platform.eval_scores MATERIALIZE PROJECTION proj_by_run_evaluator;
```

### 8.3 Ingestion Performance

**Batched writes via BufferedClickHouseWriter:**

All eval ClickHouse writes go through the platform's `BufferedClickHouseWriter` with eval-specific tuning:

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-clickhouse-writers.ts

import { BufferedClickHouseWriter } from '@abl/database';

export const evalConversationWriter = new BufferedClickHouseWriter<EvalConversationRow>({
  table: 'abl_platform.eval_conversations',
  batchSize: 500, // Smaller than platform default (10K) — eval rows are much larger (gzipped transcripts)
  flushIntervalMs: 2_000, // Faster flush — UI needs near-real-time progress during runs
  maxBufferSize: 5_000, // Lower ceiling — each row is 10-50KB gzipped
  onError: (err, batch) => {
    evalMetrics.ingestionErrors.add(1, { table: 'eval_conversations' });
    log.error('Failed to write eval conversations', {
      err: err instanceof Error ? err.message : String(err),
      batchSize: batch.length,
    });
  },
});

export const evalScoreWriter = new BufferedClickHouseWriter<EvalScoreRow>({
  table: 'abl_platform.eval_scores',
  batchSize: 2_000, // Score rows are small (~500 bytes each)
  flushIntervalMs: 1_000, // Fast flush — heatmap polls during run
  maxBufferSize: 20_000,
  onError: (err, batch) => {
    evalMetrics.ingestionErrors.add(1, { table: 'eval_scores' });
    log.error('Failed to write eval scores', {
      err: err instanceof Error ? err.message : String(err),
      batchSize: batch.length,
    });
  },
});
```

**Write ordering within the pipeline:**

```
conversation completes → write eval_conversations (fire-and-forget to buffer)
                       ↓
judge completes       → write eval_scores (fire-and-forget to buffer)
                       ↓
all cells done        → flush both writers (await drain)
                       → compute aggregates from ClickHouse (reads hit MVs)
                       → update EvalRun summary in MongoDB
```

**Flush-before-read guarantee:**

```typescript
// In aggregate-eval-run activity — must flush ALL buffered rows before reading aggregates.
// Uses flushAll() (not flush()) to drain the entire buffer even when it exceeds batchSize.
async function aggregateEvalRun(
  runId: string,
  tenantId: string,
  projectId: string,
): Promise<RunSummary> {
  // Force flush ALL outstanding buffers so aggregation reads complete data.
  // flushAll() loops until the buffer is empty (unlike flush() which drains one batchSize).
  await Promise.all([evalConversationWriter.flushAll(), evalScoreWriter.flushAll()]);

  // Wait for ClickHouse MV merge (async inserts may lag)
  // The MV is incrementally updated on insert, but we add a small safety margin
  await sleep(500);

  // Now read from MVs — guaranteed complete
  const summary = await queryRunSummaryFromMV(runId, tenantId, projectId);
  return summary;
}
```

**Async insert settings (ClickHouse server-side safety net):**

The platform's ClickHouse client already enables `async_insert=1` with `wait_for_async_insert=1`. This means even if our buffer flushes a small batch, ClickHouse server-side will accumulate before writing to disk. The two-tier buffering (app-side `BufferedClickHouseWriter` + server-side `async_insert`) minimizes part count growth.

### 8.4 MongoDB Query Optimizations

**Additional indexes for eval-specific access patterns:**

```typescript
// EvalRun — most queried eval model
EvalRunSchema.index({ tenantId: 1, projectId: 1, status: 1, createdAt: -1 }); // Active runs dashboard
EvalRunSchema.index({ tenantId: 1, evalSetId: 1, createdAt: -1 }); // Run history per eval set
EvalRunSchema.index({ pipelineRunId: 1 }, { sparse: true, unique: true }); // Pipeline status lookup

// EvalPersona — filtered lists
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, isBuiltIn: 1 }); // Separate built-in from custom
EvalPersonaSchema.index({ tenantId: 1, projectId: 1, communicationStyle: 1 }); // Filter by style

// EvalHumanReview — review queue
EvalHumanReviewSchema.index({ tenantId: 1, projectId: 1, status: 1 }); // Pending reviews queue
EvalHumanReviewSchema.index({ tenantId: 1, runId: 1 }); // All reviews for a run
```

**Lean queries for list endpoints:**

```typescript
// API list endpoints return lean documents (no Mongoose overhead)
const personas = await EvalPersonaModel.find({ tenantId, projectId })
  .select('_id name communicationStyle domainKnowledge isBuiltIn version createdAt')
  .sort({ createdAt: -1 })
  .limit(100)
  .lean();
```

**Populate avoidance — denormalize names into EvalSet:**

The eval set references personaIds, scenarioIds, evaluatorIds. Instead of populating these on every load (3 extra queries), store denormalized names:

```typescript
// On EvalSet create/update, snapshot names
export interface IEvalSet {
  // ... existing fields ...
  // Denormalized for list display — updated on entity rename via change stream or middleware
  _personaNames?: Record<string, string>; // { personaId: "Impatient Beginner" }
  _scenarioNames?: Record<string, string>;
  _evaluatorNames?: Record<string, string>;
}
```

This avoids 3×N populate calls on the eval sets list page. Names are refreshed via Mongoose post-save middleware on the referenced entities.

### 8.5 Redis Caching for Expensive Queries

**Cache layer for heat map aggregates:**

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-cache.ts

const CACHE_KEYS = {
  heatmap: (runId: string) => `eval:heatmap:${runId}`,
  runSummary: (runId: string) => `eval:summary:${runId}`,
  trend: (projectId: string, evaluatorId: string) => `eval:trend:${projectId}:${evaluatorId}`,
} as const;

const CACHE_TTL = {
  completedRunHeatmap: 3600, // 1h — completed runs are immutable
  activeRunHeatmap: 5, // 5s — active runs refresh frequently
  runSummary: 3600, // 1h — immutable after completion
  trend: 300, // 5min — new runs may shift trend
} as const;

async function getCachedHeatmap(
  redis: RedisClient,
  runId: string,
  runStatus: string,
  fetchFn: () => Promise<HeatmapData>,
): Promise<HeatmapData> {
  const key = CACHE_KEYS.heatmap(runId);
  const cached = await redis.get(key);

  if (cached) return JSON.parse(cached);

  const data = await fetchFn();
  const ttl =
    runStatus === 'completed' ? CACHE_TTL.completedRunHeatmap : CACHE_TTL.activeRunHeatmap;
  await redis.set(key, JSON.stringify(data), ttl);
  return data;
}
```

**Cache invalidation:**

- Completed run heatmap: never invalidated (immutable data, 1h TTL is safety)
- Active run heatmap: 5s TTL (auto-expires, no explicit invalidation needed)
- Trend: invalidated when a new run completes (`redis.del(CACHE_KEYS.trend(...))`)

**SWR configuration for eval hooks:**

```typescript
// apps/studio/src/hooks/useEvalHeatmap.ts
export function useEvalHeatmap(runId: string, status: string) {
  return useSWR(
    runId ? `/api/projects/${projectId}/evals/runs/${runId}/heatmap` : null,
    swrFetcher,
    {
      refreshInterval: status === 'running' ? 3_000 : 0, // Poll every 3s while running, stop when done
      revalidateOnFocus: status !== 'completed', // Don't refetch completed runs on tab focus
      dedupingInterval: 2_000, // Dedup rapid requests
    },
  );
}

// apps/studio/src/hooks/useEvalRuns.ts
export function useEvalRuns(projectId: string) {
  return useSWR(`/api/projects/${projectId}/evals/runs`, swrFetcher, {
    refreshInterval: 10_000, // Poll every 10s for new run status changes
    revalidateOnFocus: true,
  });
}
```

### 8.6 Query Performance Summary

| Query                                      | Source                                  | Optimization                               | Expected Latency            |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------ | --------------------------- |
| Heat map (75 cells)                        | MV `mv_eval_heatmap_dest`               | Pre-aggregated, Redis-cached               | <50ms (cached), <200ms (MV) |
| Run summary                                | MV `mv_eval_run_evaluator_summary_dest` | Pre-aggregated                             | <100ms                      |
| Score trend (30 days)                      | MV `mv_eval_score_trend_dest`           | Pre-aggregated, Redis-cached 5min          | <100ms                      |
| Production monitoring (hourly)             | MV `mv_eval_production_hourly_dest`     | Pre-aggregated                             | <200ms                      |
| Single cell detail (scores + conversation) | Raw table with bloom_filter skip index  | Bloom filter skips 99%+ granules           | <300ms                      |
| Run comparison (2 runs)                    | Two MV reads + client-side diff         | Cached after first load                    | <200ms                      |
| Active runs list                           | MongoDB with compound index             | `{tenantId, projectId, status, createdAt}` | <20ms                       |
| Eval set with names                        | MongoDB lean + denormalized names       | No populate, no joins                      | <15ms                       |
| Pending human reviews                      | MongoDB with status index               | `{tenantId, projectId, status}`            | <10ms                       |

---

## 9. Implementation Phases

### Phase 1 — Data Foundation (1 sprint)

| #   | Change                                                                                  | Files                                                                |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Mongoose models: EvalPersona, EvalScenario, EvalEvaluator, EvalSet, EvalRun             | `packages/database/src/models/eval-*.model.ts`                       |
| 2   | ClickHouse tables: eval_conversations, eval_scores + skip indexes + projections         | `packages/eventstore/src/stores/clickhouse/`                         |
| 3   | ClickHouse materialized views (4 MVs: heatmap, run-evaluator, trend, production-hourly) | `scripts/clickhouse-init/`                                           |
| 4   | Built-in rubric templates (6)                                                           | `packages/database/src/templates/eval-rubric-templates.ts`           |
| 5   | Built-in adversarial persona templates (5)                                              | `packages/database/src/templates/eval-persona-templates.ts`          |
| 6   | CRUD API routes for all 5 entity types                                                  | `apps/studio/src/app/api/projects/[id]/evals/`                       |
| 7   | Eval structured loggers (6 instances)                                                   | `packages/pipeline-engine/src/pipeline/services/eval/eval-logger.ts` |
| 8   | Additional MongoDB indexes (run status, persona filters, human review queue)            | `packages/database/src/models/eval-*.model.ts`                       |

### Phase 2 — Pipeline Activities (2 sprints)

| #   | Change                                                                            | Files                                                                            |
| --- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 9   | `simulate-persona` activity type                                                  | `packages/pipeline-engine/src/pipeline/services/eval/`                           |
| 10  | `execute-agent-turn` activity (in-process executor)                               | `packages/pipeline-engine/src/pipeline/services/eval/`                           |
| 11  | `run-eval-conversation` activity (multi-turn loop)                                | `packages/pipeline-engine/src/pipeline/services/eval/`                           |
| 12  | `judge-conversation` activity (LLM judge + bias mitigation)                       | `packages/pipeline-engine/src/pipeline/services/eval/`                           |
| 13  | `aggregate-eval-run` activity (stats + regression + flush-before-read)            | `packages/pipeline-engine/src/pipeline/services/eval/`                           |
| 14  | Eval pipeline definition + registration                                           | `packages/pipeline-engine/src/pipeline/definitions/eval-pipeline.ts`             |
| 15  | Trajectory scorers (4 built-in)                                                   | `packages/pipeline-engine/src/pipeline/services/eval/trajectory-scorers.ts`      |
| 16  | Circuit breaker registration (3 breakers: persona-llm, judge-llm, agent-executor) | `packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts`   |
| 17  | Per-tenant eval rate limiter (Redis token bucket)                                 | `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts`       |
| 18  | OpenTelemetry metrics instrumentation (20+ instruments)                           | `packages/pipeline-engine/src/pipeline/services/eval/eval-metrics.ts`            |
| 19  | Gzip compress/decompress helpers for ClickHouse payloads                          | `packages/pipeline-engine/src/pipeline/services/eval/eval-compression.ts`        |
| 20  | BufferedClickHouseWriter instances (conversation: 500/2s, scores: 2K/1s)          | `packages/pipeline-engine/src/pipeline/services/eval/eval-clickhouse-writers.ts` |
| 21  | Redis cache layer for heatmap + trend queries                                     | `packages/pipeline-engine/src/pipeline/services/eval/eval-cache.ts`              |
| 22  | Run API: start, cancel, status, heatmap, compare                                  | `apps/studio/src/app/api/projects/[id]/evals/runs/`                              |

### Phase 3 — UI (2 sprints)

| #   | Change                                                                    | Files                                                 |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| 23  | Zustand evals store                                                       | `apps/studio/src/store/evals-store.ts`                |
| 24  | SWR hooks with adaptive polling (7 hooks, running vs completed config)    | `apps/studio/src/hooks/useEval*.ts`                   |
| 25  | PersonasTab + CreatePersonaDialog                                         | `apps/studio/src/components/evals/tabs/`              |
| 26  | ScenariosTab + CreateScenarioDialog                                       | `apps/studio/src/components/evals/tabs/`              |
| 27  | EvaluatorsTab + CreateEvaluatorDialog + RubricBuilder + BiasSettingsPanel | `apps/studio/src/components/evals/tabs/`              |
| 28  | EvalSetsTab + CreateEvalSetDialog (matrix preview + denormalized names)   | `apps/studio/src/components/evals/tabs/`              |
| 29  | RunsTab + HeatMap + ScoreDetail + ConversationViewer                      | `apps/studio/src/components/evals/heatmap/`           |
| 30  | StartRunDialog + CostEstimate                                             | `apps/studio/src/components/evals/dialogs/`           |
| 31  | RunComparison + ScoreTrend + StatisticalSummary                           | `apps/studio/src/components/evals/comparison/`        |
| 32  | Eval health status API + health check registration                        | `apps/studio/src/app/api/projects/[id]/evals/health/` |

### Phase 4 — AI Generation + Connected Journey (1 sprint)

| #   | Change                                              | Files                                                                |
| --- | --------------------------------------------------- | -------------------------------------------------------------------- |
| 33  | AI persona generation endpoint                      | `apps/studio/src/app/api/projects/[id]/evals/generate/`              |
| 34  | AI scenario generation from topology                | `apps/studio/src/app/api/projects/[id]/evals/generate/`              |
| 35  | Quick Eval (one-click) flow                         | `apps/studio/src/app/api/projects/[id]/evals/quick/`                 |
| 36  | "Fix in Architect →" button (cross-module link)     | `apps/studio/src/components/evals/heatmap/ScoreDetail.tsx`           |
| 37  | Post-modification eval suggestion toast             | `apps/studio/src/components/evals/shared/`                           |
| 38  | Alert rules configuration (8 pre-configured alerts) | `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts` |

### Phase 5 — Advanced (2 sprints)

| #   | Change                                                    | Files                                                   |
| --- | --------------------------------------------------------- | ------------------------------------------------------- |
| 39  | Human review workflow (R9)                                | Model, routes, HumanReviewDialog                        |
| 40  | Production monitoring tab (R12)                           | ClickHouse table, routes, ProductionMonitorTab          |
| 41  | Production anomaly detection                              | `packages/pipeline-engine/` anomaly pipeline            |
| 42  | CI/CD markdown comparison API (R3)                        | Compare route + markdown renderer                       |
| 43  | Coverage analysis endpoint                                | `apps/studio/src/app/api/projects/[id]/evals/coverage/` |
| 44  | ABL DSL `EVALUATIONS` block (R11)                         | `packages/compiler/` grammar + extraction               |
| 45  | Grafana dashboard template (eval-specific panels)         | `docs/grafana/eval-dashboard.json`                      |
| 46  | Dead letter queue + manual retry UI for failed activities | Routes + DLQ management panel                           |

---

## Resolved Decisions

### RD1: Gzip Compression Before ClickHouse Storage

Conversation transcripts (10-50KB) and trace events are gzipped at the application layer before writing to ClickHouse. ClickHouse still applies its own ZSTD codec on top, but pre-gzipping reduces network transfer and gives us control over decompression at read time.

**Implementation in `store-eval-results` activity:**

```typescript
import { gzipSync, gunzipSync } from 'node:zlib';

// Write path — compress before insert
function compressField(data: unknown): string {
  const json = JSON.stringify(data);
  if (json.length < 1024) return json; // Skip compression for small payloads
  return 'gz:' + gzipSync(json).toString('base64');
}

// Read path — decompress on fetch
function decompressField(stored: string): unknown {
  if (stored.startsWith('gz:')) {
    const buf = Buffer.from(stored.slice(3), 'base64');
    return JSON.parse(gunzipSync(buf).toString());
  }
  return JSON.parse(stored); // Backward compat for uncompressed rows
}
```

**Applied to ClickHouse columns:**

- `eval_conversations.conversation` — gzipped JSON array of turns
- `eval_conversations.trace_events` — gzipped PlatformEvent array
- `eval_conversations.tool_calls` — gzipped tool call array
- `eval_scores.reasoning` — only if > 1KB (most are short)

**Threshold:** 1KB — payloads under 1KB stored as plain JSON (gzip overhead not worth it). The `gz:` prefix enables backward-compatible reads.

### RD2: Per-Tenant Eval Rate Limiting

Large eval matrices can strain LLM API rate limits. Rate limiting operates at two levels:

**Level 1 — Pipeline concurrency (`maxConcurrency` on EvalSet):**
Already in the design. Controls how many conversations run in parallel within a single eval run. Default: 5, max: 20.

**Level 2 — Per-tenant eval rate limiter (new):**
Prevents a single tenant from monopolizing LLM capacity across multiple concurrent eval runs.

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts

interface TenantEvalLimits {
  maxConcurrentRuns: number; // How many eval runs can execute simultaneously
  maxConcurrentConversations: number; // Total conversations across all runs
  maxLLMCallsPerMinute: number; // Rate limit on judge + persona LLM calls
}

const DEFAULT_LIMITS: Record<string, TenantEvalLimits> = {
  free: { maxConcurrentRuns: 1, maxConcurrentConversations: 3, maxLLMCallsPerMinute: 10 },
  team: { maxConcurrentRuns: 2, maxConcurrentConversations: 10, maxLLMCallsPerMinute: 30 },
  business: { maxConcurrentRuns: 3, maxConcurrentConversations: 20, maxLLMCallsPerMinute: 60 },
  enterprise: { maxConcurrentRuns: 5, maxConcurrentConversations: 50, maxLLMCallsPerMinute: 120 },
};
```

**Enforcement point — inside `run-eval-conversation` and `judge-conversation` activities:**

```typescript
// Before starting a conversation or judge call:
const limiter = await getEvalRateLimiter(tenantId);
await limiter.acquire('conversation'); // Blocks until slot available

try {
  // ... execute conversation or judge call ...
} finally {
  limiter.release('conversation');
}
```

**Redis-backed token bucket:**

- Key: `eval:rate:{tenantId}:conversations` — sliding window counter
- Key: `eval:rate:{tenantId}:llm_calls` — token bucket with per-minute refill
- TTL: 120s (auto-cleanup after idle)

**Mongo config override:** Tenants can customize limits via `TenantLimits`:

```typescript
interface TenantLimits {
  // existing...
  evalMaxConcurrentRuns?: number;
  evalMaxConcurrentConversations?: number;
  evalMaxLLMCallsPerMinute?: number;
}
```

**Run queueing:** When `maxConcurrentRuns` is reached, new runs stay in `pending` status. A lightweight Restate scheduled handler polls every 10s and promotes pending runs when slots free up.

### RD3: Persona Simulation Model — Configurable Per Eval Set

The persona simulation LLM is configurable at the eval set level, defaulting to the agent's own model.

**New field on `EvalSet`:**

```typescript
export interface IEvalSet {
  // ... existing fields ...
  personaModel?: string; // LLM model for persona simulation. null = use agent's model
  personaModelConfig?: {
    temperature?: number; // Default: 0.7 (more creative than judge)
    maxTokens?: number; // Default: 512
  };
}
```

**Schema addition:**

```typescript
// In EvalSetSchema
personaModel: { type: String, default: null },  // null = agent's model
personaModelConfig: {
  type: new Schema({
    temperature: { type: Number, default: 0.7 },
    maxTokens: { type: Number, default: 512 },
  }, { _id: false }),
  default: () => ({}),
},
```

**Resolution in `simulate-persona` activity:**

```typescript
async function resolvePersonaModel(evalSet: IEvalSet, agentConfig: AgentConfig): Promise<string> {
  // Explicit override wins
  if (evalSet.personaModel) return evalSet.personaModel;
  // Default: agent's own model
  return agentConfig.model ?? 'claude-sonnet-4-6';
}
```

**UI — in CreateEvalSetDialog:**

```
Persona Simulation Model
┌─────────────────────────────────────────────────────────────┐
│  ○ Use agent's model (default)                              │
│    Persona uses the same model the agent is configured with │
│                                                             │
│  ○ Custom model                                             │
│    [claude-sonnet-4-6      ▾]                               │
│    Temperature: [0.7]  Max tokens: [512]                    │
│                                                             │
│  ⚠ Note: Using the same model family as the agent may      │
│    introduce self-enhancement bias (R1). For high-stakes    │
│    evals, consider using a different model family.          │
└─────────────────────────────────────────────────────────────┘
```

**Bias warning logic:** When `personaModel` is null (agent's model) AND `biasSettings.crossModelJudge` is false on any evaluator in the set, show an amber warning: "Both persona and judge use the same model family as the agent. Consider enabling cross-model judge or setting a different persona model."

---

### RD4: Fresh SessionService Instance Per Conversation

Each eval conversation gets its own `SessionService` instance with fresh state. Correctness over speed — eval results must be reproducible and isolated.

**Implementation in `run-eval-conversation` activity:**

```typescript
async function executeEvalConversation(
  persona: IEvalPersona,
  scenario: IEvalScenario,
  variantIndex: number,
  projectId: string,
  tenantId: string,
): Promise<ConversationResult> {
  // Fresh instance per conversation — no shared state
  const sessionService = new SessionService({
    tenantId,
    projectId,
    agentName: scenario.entryAgent,
    sessionStore: createMemorySessionStore(), // In-memory, not Redis — ephemeral eval session
    traceManager: createEvalTraceManager(), // Collect traces without emitting to Kafka
  });

  const sessionId = `eval-${uuidv7()}`; // Prefixed to distinguish from production sessions
  await sessionService.createSession(sessionId);

  try {
    // ... multi-turn conversation loop ...
  } finally {
    // Dispose — no cleanup needed (memory store is GC'd)
    await sessionService.endSession(sessionId, 'completed');
  }
}
```

**Key decisions:**

- **Memory session store** (not Redis) — eval sessions are ephemeral, never resumed, and should not pollute the production Redis keyspace
- **Eval trace manager** — collects `PlatformEvent[]` in-memory for scoring, does not emit to Kafka or EventStore (no production side effects)
- **Session ID prefix** `eval-` — prevents collision with production sessions if any shared lookup path exists
- **No L1/L2 cache sharing** — each instance compiles the agent IR independently. Cost: ~10-50ms per conversation for compilation. Acceptable given conversations take seconds
- **GC cleanup** — no explicit teardown needed. The memory store and trace collector are GC'd when the activity function returns

**Tradeoff:** For a 75-conversation matrix, this means 75 independent IR compilations. At ~30ms each, that's ~2.2s total — negligible compared to the minutes spent on LLM calls. If profiling shows this is a bottleneck, we can share a read-only compiled IR cache across conversations (IR is immutable after compilation) without sharing session state.

---

### RD5: MongoDB + ClickHouse Split for Run Data

Run metadata in MongoDB, scores and conversation results in ClickHouse. This matches the platform's existing dual-write pattern.

| Data                                          | Store      | Why                                                                                                                  |
| --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `EvalRun` (status, summary, regression flags) | MongoDB    | Mutated frequently during execution (pending → running → completed). CRUD operations. Status polling.                |
| `eval_conversations` (transcripts, traces)    | ClickHouse | Write-once after conversation completes. Large payloads (gzipped). Analytical queries (filter by persona, scenario). |
| `eval_scores` (per-evaluator scores)          | ClickHouse | Write-once after judging. Aggregation queries (heat map, averages, std dev). Time-series trending across runs.       |
| `eval_production_scores` (online monitoring)  | ClickHouse | High-volume append-only from production traffic. Time-partitioned with TTL tiers.                                    |

**Write flow during a run:**

1. Pipeline starts → `EvalRun.status = 'running'` (MongoDB update)
2. Each conversation completes → insert to `eval_conversations` (ClickHouse, buffered)
3. Each judge score completes → insert to `eval_scores` (ClickHouse, buffered)
4. All steps done → compute aggregates from ClickHouse → write `EvalRun.summary` (MongoDB update)
5. Regression check → write `EvalRun.regressionDetected` + `regressionDetails` (MongoDB update)
6. `EvalRun.status = 'completed'` (MongoDB update)

**Read flow for heat map:**

- `GET /runs/:runId` → MongoDB (run metadata, summary)
- `GET /runs/:runId/heatmap` → ClickHouse aggregate query (GROUP BY persona, scenario, evaluator)
- `GET /runs/:runId/scores?personaId=X&scenarioId=Y` → ClickHouse filtered query (per-cell detail)

---

## Open Questions

No open questions remain. All design decisions resolved.

---

## Phase 4: AI Generation + Connected Journey

**Date:** 2026-03-05
**Status:** Approved
**Builds on:** [Evals System Design](./2026-03-04-evals-system-design.md) (Phases 1-3 complete)

---

## Overview

Phase 4 adds six capabilities: AI-powered persona/scenario generation, a one-click Quick Eval flow, cross-module integration with the Architect, post-modification eval suggestion toasts, and pre-configured alert rules.

---

## 1. AI Persona Generation

### Endpoint

`POST /api/projects/:id/evals/generate/personas`

### Input

```typescript
{
  count?: number;       // default 3
  focusAreas?: string[]; // optional: e.g. ["adversarial", "edge-case"]
}
```

### Flow

1. Auth + project access check (standard `requireTenantAuth` + `requireProjectAccess`)
2. Fetch project topology (agents, tools, connections) via existing repo pattern
3. Build per-agent summaries: name, type, goals, tool names, execution mode, handoff targets
4. Call LLM via `resolveArchLLMClient(tenantId)` with structured prompt
5. LLM returns JSON array of persona definitions
6. Return suggestions to UI — user reviews and selects which to save
7. Selected personas created via existing `createPersona()` repo function

### LLM Context

Topology graph + per-agent summaries (goals, tools list, execution mode, handoff targets). Not full DSL source — balances quality with token cost.

### Prompt Strategy

System prompt explains what eval personas are, provides agent topology context, asks for diverse personas covering:

- Happy path users with varying communication styles
- Edge case users (domain novices, verbose/terse)
- Adversarial users (prompt injection, off-topic, abusive) when requested

Response format: strict JSON array matching the EvalPersona schema fields (name, communicationStyle, domainKnowledge, behaviorTraits, goals, constraints, isAdversarial, adversarialType).

---

## 2. AI Scenario Generation

### Endpoint

`POST /api/projects/:id/evals/generate/scenarios`

### Input

```typescript
{
  count?: number;        // default 3
  personaIds?: string[]; // optional: include persona context for alignment
}
```

### Flow

Same auth pattern. Fetch topology + agent summaries. If persona IDs provided, include persona details so scenarios align with persona capabilities.

### Key Constraint

Scenarios reference actual agent names from the topology for `entryAgent` and `agentPath`. The LLM prompt includes the list of valid agent names so generated paths are valid.

### LLM Output

JSON array matching EvalScenario schema: name, description, category, difficulty, entryAgent, maxTurns, expectedMilestones, agentPath, tags.

---

## 3. Quick Eval (One-Click)

### Endpoint

`POST /api/projects/:id/evals/quick`

### Input

```typescript
{
  name?: string; // optional custom name
}
```

### Flow

1. Auth + project access
2. Generate 3 personas (calls generate/personas logic internally)
3. Generate 3 scenarios (passes generated persona IDs for alignment)
4. Pick 3 built-in evaluators from templates: `task_completion`, `communication_quality`, `safety`
5. Create all 9 entities via existing repo functions
6. Create EvalSet (3P x 3S x 3E = 27 evaluations, 1 variant)
7. Create + start EvalRun
8. Return `202` with `{ evalSetId, runId, personas, scenarios, evaluators }`

### Error Handling

- LLM generation fails: return 503 with clear message
- Template evaluators missing: fall back to creating basic evaluators with default rubrics

### UI Integration

- "Quick Eval" button on EvalsPage empty state and RunsTab header
- Shows loading state during generation
- On success, navigates to RunsTab with the new run selected

---

## 4. "Fix in Architect" Cross-Module Link

### Location

`ScoreDetail.tsx` — button appears for cells with score < 3.0

### Behavior

On click:

1. Build context: `{ agentName, evaluatorName, score, reasoning, evidence }`
2. Navigate to agent page: `/projects/:id/agents/:agentName`
3. Open Architect panel via `useArchStore` (set `isOpen: true`)
4. Pre-populate chat with formatted eval failure context

### Implementation

- Add `prefillMessage` field to `arch-store.ts`
- ArchChat reads `prefillMessage` on mount, auto-sends it, then clears the field
- Uses Next.js router for navigation + Zustand for cross-component state

### Pre-filled Message Format

```
Eval failure on [evaluatorName]: score [score]/5.
Reasoning: [reasoning]
Evidence: [evidence]
Suggest improvements to this agent.
```

---

## 5. Post-Modification Eval Suggestion Toast

### Trigger

After Architect workflow applies changes successfully (execution completes).

### Implementation

- In Arch workflow completion handler, check if project has eval sets (lightweight SWR check)
- If eval sets exist, show toast: "Agent modified — re-run evals to check for regressions?"
- Toast has action button "Run Evals" that navigates to `/projects/:id/evals` with RunsTab active
- Uses `sonner` toast with `action` prop — no new component needed

### Scoping

Only triggers for projects that have at least one eval set. No toast for projects without evals configured.

---

## 6. Alert Rules Configuration

### File

`packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`

### Pre-Configured Rules (8)

| Alert                     | Metric                        | Condition          | Severity |
| ------------------------- | ----------------------------- | ------------------ | -------- |
| Eval run failed           | `eval.run.failed`             | count > 0 in 5min  | error    |
| All circuit breakers open | `eval.circuit_breaker.opened` | any fired          | critical |
| Cost budget >80%          | Monthly eval spend            | > 80% budget       | warning  |
| Cost budget exceeded      | Monthly eval spend            | > 100% budget      | error    |
| Regression detected       | `eval.regression.detected`    | count > 0          | warning  |
| Run duration exceeded     | `eval.run.duration_ms`        | > 30min            | warning  |
| Judge latency spike       | `eval.judge.duration_ms`      | p95 > 30s for 5min | warning  |
| Rate limit saturation     | `eval.rate_limit.queue_depth` | > 10 for 10min     | info     |

### Implementation

- Export `registerEvalAlertRules(tenantId, projectId)` function
- Creates rules using existing `AlertRule` interface from `packages/eventstore/src/alerting/interfaces.ts`
- Called during eval set creation (first eval set triggers registration)
- Uses existing `AlertScheduler` for evaluation and webhook delivery
- No UI for Phase 4 — rules are auto-registered

---

## Design Decisions

| Decision                   | Choice                          | Rationale                                                            |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| LLM context for generation | Topology + agent summaries      | Balances quality with token cost. Full DSL too expensive per call.   |
| Quick Eval matrix size     | 3P x 3S x 3E = 27 evals         | Good coverage without being overwhelming. Fast enough for one-click. |
| Architect integration      | Navigate + pre-fill chat        | Direct context handoff. User sees eval failure and can act on it.    |
| Eval suggestion trigger    | Toast after Arch execution      | Non-intrusive. Only shown when evals are configured.                 |
| Alert rule registration    | Auto on first eval set creation | Zero config. Users get alerting without manual setup.                |
| Alert UI                   | Deferred to Phase 5             | Rules are useful without UI. Configuration panel adds complexity.    |

---

## Files to Create/Modify

### New Files

| File                                                                      | Purpose                         |
| ------------------------------------------------------------------------- | ------------------------------- |
| `apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts`  | AI persona generation endpoint  |
| `apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts` | AI scenario generation endpoint |
| `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`              | Quick eval one-click endpoint   |
| `apps/studio/src/components/evals/shared/QuickEvalButton.tsx`             | Quick eval UI button + loading  |
| `apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx`         | Toast utility function          |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`      | Alert rule definitions          |

### Modified Files

| File                                                       | Change                                        |
| ---------------------------------------------------------- | --------------------------------------------- |
| `apps/studio/src/components/evals/heatmap/ScoreDetail.tsx` | Add "Fix in Architect" button                 |
| `apps/studio/src/store/arch-store.ts`                      | Add `prefillMessage` field                    |
| `apps/studio/src/components/arch/ArchChat.tsx`             | Read + auto-send prefillMessage               |
| `apps/studio/src/components/evals/EvalsPage.tsx`           | Add QuickEvalButton to empty state + header   |
| `apps/studio/src/components/evals/tabs/RunsTab.tsx`        | Add QuickEvalButton to header                 |
| `apps/studio/src/components/evals/tabs/PersonasTab.tsx`    | Add "Generate with AI" button                 |
| `apps/studio/src/components/evals/tabs/ScenariosTab.tsx`   | Add "Generate with AI" button                 |
| `apps/studio/src/hooks/useEvalData.ts`                     | Add useGeneratePersonas, useGenerateScenarios |
| `apps/studio/src/repos/eval-repo.ts`                       | Add hasEvalSets() lightweight check           |

---

## Phase 4: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add AI-powered persona/scenario generation, Quick Eval one-click flow, Architect cross-module integration, post-modification eval suggestion, and pre-configured alert rules.

**Architecture:** Server-side API routes call `resolveArchLLMClient(tenantId)` for AI generation, returning JSON suggestions that the UI saves via existing CRUD repos. Alert rules plug into the existing `AlertRule` interface from `packages/eventstore/src/alerting/`. The Architect integration uses Zustand store cross-communication (`arch-store.ts` ↔ evals components).

**Tech Stack:** Next.js 15 API routes, Vercel AI SDK (via `arch-llm.ts`), Zustand, SWR, sonner toasts, existing AlertRule interfaces

---

### Task 1: AI Persona Generation — API Route

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts`

**Step 1: Create the route directory**

```bash
mkdir -p apps/studio/src/app/api/projects/\[id\]/evals/generate/personas
```

**Step 2: Write the endpoint**

````typescript
// apps/studio/src/app/api/projects/[id]/evals/generate/personas/route.ts
/**
 * POST /api/projects/:id/evals/generate/personas
 *
 * AI-generates eval persona suggestions using project topology context.
 * Returns persona definitions for the user to review and selectively save.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { resolveArchLLMClient, ARCH_GENERATE_MAX_TOKENS, ARCH_TIMEOUT_MS } from '@/lib/arch-llm';

const inputSchema = z.object({
  count: z.number().int().min(1).max(10).optional().default(3),
  focusAreas: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are an expert at designing test personas for AI agent evaluation.

Given a description of an agent system (its agents, tools, handoffs, and goals), generate diverse eval personas that would exercise the system thoroughly.

Each persona should have:
- name: A descriptive name (e.g., "Impatient Tech Expert", "Confused First-Timer")
- communicationStyle: One of "formal", "casual", "terse", "verbose", "technical", "non-technical"
- domainKnowledge: One of "expert", "intermediate", "novice", "none"
- behaviorTraits: Array of 2-4 traits (e.g., ["impatient", "detail-oriented", "skeptical"])
- goals: What this persona is trying to accomplish
- constraints: Limitations or quirks (e.g., "Only speaks in short sentences", "Gets frustrated after 3 turns")
- isAdversarial: boolean — true for personas designed to test edge cases or break the system
- adversarialType: If adversarial, one of "prompt_injection", "social_engineering", "off_topic", "abusive", "edge_case"

Generate diverse personas covering:
1. Happy path users with varying communication styles
2. Edge case users (domain novices, very verbose/terse users)
3. Adversarial users when requested

Respond with ONLY a JSON array of persona objects. No markdown, no explanation.`;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { count, focusAreas } = parsed.data;

  try {
    // Fetch project topology for context
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, user.tenantId);

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agents found in project. Create agents first.' },
        { status: 400 },
      );
    }

    // Build agent summaries for LLM context
    const agentSummaries = agents.map((a: any) => ({
      name: a.name,
      type: a.agentType ?? 'agent',
      description: a.description ?? '',
      goal: a.goal ?? '',
      tools: (a.tools ?? []).map((t: any) => t.name ?? t).slice(0, 10),
      executionMode: a.executionMode ?? 'reasoning',
      handoffTargets: a.handoffTargets ?? [],
    }));

    // Build user message
    const focusStr = focusAreas?.length ? `\nFocus areas: ${focusAreas.join(', ')}` : '';

    const userMessage = `Here is the agent system topology:

${JSON.stringify(agentSummaries, null, 2)}
${focusStr}
Generate exactly ${count} diverse eval personas as a JSON array.`;

    // Call LLM
    const resolution = await resolveArchLLMClient(user.tenantId);
    if (!resolution.client) {
      return NextResponse.json(
        { success: false, error: resolution.error ?? 'LLM not configured' },
        { status: 503 },
      );
    }

    const result = await resolution.client.chat(
      SYSTEM_PROMPT,
      [{ role: 'user', content: userMessage }],
      {
        model: resolution.model,
        maxTokens: resolution.maxTokensGenerate,
        timeoutMs: ARCH_TIMEOUT_MS,
      },
    );

    // Parse LLM response
    let personas: unknown[];
    try {
      const cleaned = result.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      personas = JSON.parse(cleaned);
      if (!Array.isArray(personas)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to parse AI response. Please try again.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, personas });
  } catch (error) {
    return handleApiError(error, 'EvalGenerate.personas');
  }
}
````

**Step 3: Run prettier**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[id\]/evals/generate/personas/route.ts
```

**Step 4: TypeScript check**

```bash
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep -i "generate/personas" | head -10
```

**Step 5: Commit**

```bash
git add apps/studio/src/app/api/projects/\[id\]/evals/generate/personas/route.ts
git commit -m "[ABLP-2] feat(studio): add AI persona generation endpoint"
```

---

### Task 2: AI Scenario Generation — API Route

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts`

**Step 1: Create the route directory**

```bash
mkdir -p apps/studio/src/app/api/projects/\[id\]/evals/generate/scenarios
```

**Step 2: Write the endpoint**

Same pattern as persona generation but with scenario-specific prompt. The prompt includes valid agent names from topology so `entryAgent` and `agentPath` reference real agents. If `personaIds` are provided, fetch those personas and include them in the LLM context for scenario-persona alignment.

````typescript
// apps/studio/src/app/api/projects/[id]/evals/generate/scenarios/route.ts
/**
 * POST /api/projects/:id/evals/generate/scenarios
 *
 * AI-generates eval scenario suggestions using project topology + optional persona context.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { resolveArchLLMClient, ARCH_TIMEOUT_MS } from '@/lib/arch-llm';

const inputSchema = z.object({
  count: z.number().int().min(1).max(10).optional().default(3),
  personaIds: z.array(z.string()).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

const SYSTEM_PROMPT = `You are an expert at designing test scenarios for AI agent evaluation.

Given an agent system topology and optionally personas, generate conversation scenarios that would thoroughly test the system.

Each scenario should have:
- name: A descriptive name (e.g., "Multi-Agent Billing Dispute", "Simple FAQ Query")
- description: 1-2 sentence description of what happens in this scenario
- category: One of "happy_path", "edge_case", "error_handling", "multi_turn", "handoff", "adversarial"
- difficulty: One of "easy", "medium", "hard"
- entryAgent: The agent name (from the topology) where the conversation starts
- maxTurns: Number between 3-20
- expectedMilestones: Array of 2-5 milestones (e.g., ["User greeted", "Problem identified", "Solution proposed"])
- agentPath: Expected agent path if handoffs occur (e.g., ["triage_agent", "billing_agent"])
- tags: Array of 1-3 tags (e.g., ["billing", "escalation"])

IMPORTANT: entryAgent and agentPath values MUST use exact agent names from the provided topology.

Respond with ONLY a JSON array of scenario objects. No markdown, no explanation.`;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { count, personaIds } = parsed.data;

  try {
    // Fetch project topology
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, user.tenantId);

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agents found in project. Create agents first.' },
        { status: 400 },
      );
    }

    const agentSummaries = agents.map((a: any) => ({
      name: a.name,
      type: a.agentType ?? 'agent',
      description: a.description ?? '',
      goal: a.goal ?? '',
      tools: (a.tools ?? []).map((t: any) => t.name ?? t).slice(0, 10),
      executionMode: a.executionMode ?? 'reasoning',
      handoffTargets: a.handoffTargets ?? [],
    }));

    const validAgentNames = agentSummaries.map((a: any) => a.name);

    // Optionally fetch persona context
    let personaContext = '';
    if (personaIds && personaIds.length > 0) {
      const { findPersonaById } = await import('@/repos/eval-repo');
      const personas = await Promise.all(
        personaIds.map((id) => findPersonaById(id, user.tenantId, projectId)),
      );
      const validPersonas = personas.filter(Boolean);
      if (validPersonas.length > 0) {
        personaContext = `\n\nPersonas that will use these scenarios:\n${JSON.stringify(
          validPersonas.map((p: any) => ({
            name: p.name,
            communicationStyle: p.communicationStyle,
            domainKnowledge: p.domainKnowledge,
            isAdversarial: p.isAdversarial,
          })),
          null,
          2,
        )}`;
      }
    }

    const userMessage = `Agent system topology:

${JSON.stringify(agentSummaries, null, 2)}

Valid agent names: ${JSON.stringify(validAgentNames)}
${personaContext}
Generate exactly ${count} diverse eval scenarios as a JSON array.`;

    const resolution = await resolveArchLLMClient(user.tenantId);
    if (!resolution.client) {
      return NextResponse.json(
        { success: false, error: resolution.error ?? 'LLM not configured' },
        { status: 503 },
      );
    }

    const result = await resolution.client.chat(
      SYSTEM_PROMPT,
      [{ role: 'user', content: userMessage }],
      {
        model: resolution.model,
        maxTokens: resolution.maxTokensGenerate,
        timeoutMs: ARCH_TIMEOUT_MS,
      },
    );

    let scenarios: unknown[];
    try {
      const cleaned = result.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      scenarios = JSON.parse(cleaned);
      if (!Array.isArray(scenarios)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to parse AI response. Please try again.' },
        { status: 502 },
      );
    }

    // Validate entryAgent references
    for (const s of scenarios as any[]) {
      if (s.entryAgent && !validAgentNames.includes(s.entryAgent)) {
        s.entryAgent = validAgentNames[0] ?? null;
      }
      if (s.agentPath) {
        s.agentPath = (s.agentPath as string[]).filter((name) => validAgentNames.includes(name));
      }
    }

    return NextResponse.json({ success: true, scenarios });
  } catch (error) {
    return handleApiError(error, 'EvalGenerate.scenarios');
  }
}
````

**Step 3: Run prettier + typecheck**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[id\]/evals/generate/scenarios/route.ts
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep -i "generate/scenarios" | head -10
```

**Step 4: Commit**

```bash
git add apps/studio/src/app/api/projects/\[id\]/evals/generate/scenarios/route.ts
git commit -m "[ABLP-2] feat(studio): add AI scenario generation endpoint"
```

---

### Task 3: Quick Eval — API Route

**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/evals/quick/route.ts`

**Step 1: Create directory and write endpoint**

```bash
mkdir -p apps/studio/src/app/api/projects/\[id\]/evals/quick
```

The quick eval endpoint:

1. Calls the persona generation route logic internally (3 personas)
2. Calls the scenario generation route logic internally (3 scenarios with persona IDs)
3. Creates 3 evaluators from built-in templates (task_completion, communication_quality, safety)
4. Creates an EvalSet combining all 9 entities
5. Creates + starts an EvalRun

````typescript
// apps/studio/src/app/api/projects/[id]/evals/quick/route.ts
/**
 * POST /api/projects/:id/evals/quick
 *
 * One-click eval: AI-generates personas + scenarios, picks built-in evaluators,
 * creates an eval set, and starts a run. Returns 202 with run details.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { resolveArchLLMClient, ARCH_TIMEOUT_MS } from '@/lib/arch-llm';
import {
  createPersona,
  createScenario,
  createEvaluator,
  createEvalSet,
  createRun,
} from '@/repos/eval-repo';

const inputSchema = z.object({
  name: z.string().max(100).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

/** Built-in evaluator template IDs to use for quick eval */
const QUICK_EVAL_TEMPLATE_IDS = ['task_completion', 'communication_quality', 'safety'];

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const customName = parsed.data.name;

  try {
    // 1. Generate personas via internal LLM call (same logic as generate/personas)
    const { getProjectAgents } = await import('@/services/project-service');
    const agents = await getProjectAgents(projectId, user.tenantId);

    if (!agents || agents.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No agents found in project. Create agents first.' },
        { status: 400 },
      );
    }

    const agentSummaries = agents.map((a: any) => ({
      name: a.name,
      type: a.agentType ?? 'agent',
      description: a.description ?? '',
      goal: a.goal ?? '',
      tools: (a.tools ?? []).map((t: any) => t.name ?? t).slice(0, 10),
      executionMode: a.executionMode ?? 'reasoning',
      handoffTargets: a.handoffTargets ?? [],
    }));

    const resolution = await resolveArchLLMClient(user.tenantId);
    if (!resolution.client) {
      return NextResponse.json(
        { success: false, error: resolution.error ?? 'LLM not configured' },
        { status: 503 },
      );
    }

    // Generate personas
    const personaPrompt = `You are an expert at designing test personas for AI agent evaluation.
Given this agent system, generate 3 diverse eval personas as a JSON array.
Each persona: { name, communicationStyle, domainKnowledge, behaviorTraits, goals, constraints, isAdversarial, adversarialType? }
communicationStyle: "formal"|"casual"|"terse"|"verbose"|"technical"|"non-technical"
domainKnowledge: "expert"|"intermediate"|"novice"|"none"
Include 1 happy-path, 1 edge-case, and 1 adversarial persona.
Respond with ONLY a JSON array.`;

    const personaResult = await resolution.client.chat(
      personaPrompt,
      [{ role: 'user', content: `Agent topology:\n${JSON.stringify(agentSummaries, null, 2)}` }],
      {
        model: resolution.model,
        maxTokens: resolution.maxTokensGenerate,
        timeoutMs: ARCH_TIMEOUT_MS,
      },
    );

    let personaDefs: any[];
    try {
      const cleaned = personaResult.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      personaDefs = JSON.parse(cleaned);
      if (!Array.isArray(personaDefs)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'AI persona generation failed. Please try again.' },
        { status: 502 },
      );
    }

    // Save personas
    const createdPersonas = await Promise.all(
      personaDefs.slice(0, 3).map((p) =>
        createPersona({
          tenantId: user.tenantId,
          projectId,
          name: p.name ?? 'Generated Persona',
          description: `Auto-generated for Quick Eval`,
          communicationStyle: p.communicationStyle ?? 'casual',
          domainKnowledge: p.domainKnowledge ?? 'intermediate',
          behaviorTraits: p.behaviorTraits ?? [],
          goals: p.goals ?? '',
          constraints: p.constraints ?? '',
          isAdversarial: p.isAdversarial ?? false,
          adversarialType: p.adversarialType,
          source: 'ai-generated',
          isBuiltIn: false,
          version: 1,
        }),
      ),
    );

    // Generate scenarios (with persona context)
    const validAgentNames = agentSummaries.map((a: any) => a.name);
    const scenarioPrompt = `You are an expert at designing test scenarios for AI agent evaluation.
Generate 3 diverse scenarios as a JSON array.
Each scenario: { name, description, category, difficulty, entryAgent, maxTurns, expectedMilestones, agentPath, tags }
category: "happy_path"|"edge_case"|"error_handling"|"multi_turn"|"handoff"|"adversarial"
difficulty: "easy"|"medium"|"hard"
IMPORTANT: entryAgent and agentPath must use these exact agent names: ${JSON.stringify(validAgentNames)}
Respond with ONLY a JSON array.`;

    const scenarioResult = await resolution.client.chat(
      scenarioPrompt,
      [
        {
          role: 'user',
          content: `Agent topology:\n${JSON.stringify(agentSummaries, null, 2)}\n\nPersonas:\n${JSON.stringify(
            personaDefs.map((p: any) => ({
              name: p.name,
              communicationStyle: p.communicationStyle,
            })),
            null,
            2,
          )}`,
        },
      ],
      {
        model: resolution.model,
        maxTokens: resolution.maxTokensGenerate,
        timeoutMs: ARCH_TIMEOUT_MS,
      },
    );

    let scenarioDefs: any[];
    try {
      const cleaned = scenarioResult.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      scenarioDefs = JSON.parse(cleaned);
      if (!Array.isArray(scenarioDefs)) throw new Error('Not an array');
    } catch {
      return NextResponse.json(
        { success: false, error: 'AI scenario generation failed. Please try again.' },
        { status: 502 },
      );
    }

    // Save scenarios
    const createdScenarios = await Promise.all(
      scenarioDefs.slice(0, 3).map((s) =>
        createScenario({
          tenantId: user.tenantId,
          projectId,
          name: s.name ?? 'Generated Scenario',
          description: s.description ?? 'Auto-generated for Quick Eval',
          category: s.category ?? 'happy_path',
          difficulty: s.difficulty ?? 'medium',
          entryAgent: validAgentNames.includes(s.entryAgent) ? s.entryAgent : validAgentNames[0],
          maxTurns: Math.min(Math.max(s.maxTurns ?? 10, 3), 20),
          expectedMilestones: s.expectedMilestones ?? [],
          agentPath: (s.agentPath ?? []).filter((n: string) => validAgentNames.includes(n)),
          tags: s.tags ?? [],
          version: 1,
        }),
      ),
    );

    // 3. Create evaluators from built-in templates
    const { RUBRIC_TEMPLATES } =
      await import('@agent-platform/database/templates/eval-rubric-templates');

    const createdEvaluators = await Promise.all(
      QUICK_EVAL_TEMPLATE_IDS.map(async (templateId) => {
        const template = RUBRIC_TEMPLATES.find((t: any) => t.id === templateId);
        if (!template) {
          // Fallback: create a basic evaluator
          return createEvaluator({
            tenantId: user.tenantId,
            projectId,
            name: templateId.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
            description: `Built-in ${templateId} evaluator`,
            type: 'llm_judge',
            category: 'quality',
            isBuiltIn: false,
            version: 1,
          });
        }
        return createEvaluator({
          tenantId: user.tenantId,
          projectId,
          name: template.name,
          description: template.description,
          type: 'llm_judge',
          category: template.category,
          scoringRubric: template.rubric,
          judgePrompt: template.defaultJudgePrompt,
          isBuiltIn: false,
          version: 1,
        });
      }),
    );

    // 4. Create eval set
    const evalSet = await createEvalSet({
      tenantId: user.tenantId,
      projectId,
      name: customName ?? `Quick Eval — ${new Date().toLocaleDateString()}`,
      description: 'Auto-generated by Quick Eval',
      personaIds: createdPersonas.map((p) => p.id),
      scenarioIds: createdScenarios.map((s) => s.id),
      evaluatorIds: createdEvaluators.map((e) => e.id),
      variants: 1,
      ciEnabled: false,
    });

    // 5. Create run
    const run = await createRun({
      tenantId: user.tenantId,
      projectId,
      evalSetId: evalSet.id,
      name: `Quick Run — ${new Date().toLocaleTimeString()}`,
      status: 'pending',
      triggerSource: 'quick_eval',
      triggeredBy: user.email ?? user.userId,
    });

    // 6. Start the run (fire-and-forget via Restate)
    const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL ?? 'http://localhost:8080';
    fetch(`${RESTATE_INGRESS_URL}/PipelineTrigger/triggerManual/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: 'eval-run-pipeline',
        tenantId: user.tenantId,
        triggeredBy: user.email ?? user.userId,
        data: { tenantId: user.tenantId, projectId, runId: run.id, evalSetId: evalSet.id },
      }),
    }).catch((err) => {
      process.stderr.write(
        `[QuickEval] Failed to trigger pipeline for run ${run.id}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });

    return NextResponse.json(
      {
        success: true,
        evalSetId: evalSet.id,
        runId: run.id,
        personas: createdPersonas,
        scenarios: createdScenarios,
        evaluators: createdEvaluators,
      },
      { status: 202 },
    );
  } catch (error) {
    return handleApiError(error, 'EvalQuick');
  }
}
````

**Step 2: Run prettier + typecheck**

```bash
npx prettier --write apps/studio/src/app/api/projects/\[id\]/evals/quick/route.ts
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep -i "evals/quick" | head -10
```

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/projects/\[id\]/evals/quick/route.ts
git commit -m "[ABLP-2] feat(studio): add Quick Eval one-click endpoint"
```

---

### Task 4: UI — "Generate with AI" Buttons + QuickEvalButton

**Files:**

- Create: `apps/studio/src/components/evals/shared/QuickEvalButton.tsx`
- Modify: `apps/studio/src/components/evals/tabs/PersonasTab.tsx`
- Modify: `apps/studio/src/components/evals/tabs/ScenariosTab.tsx`
- Modify: `apps/studio/src/components/evals/EvalsPage.tsx`
- Modify: `apps/studio/src/components/evals/tabs/RunsTab.tsx`

**Step 1: Create QuickEvalButton component**

A button that calls POST `/api/projects/:id/evals/quick`, shows loading state, and navigates to RunsTab on success.

```typescript
// apps/studio/src/components/evals/shared/QuickEvalButton.tsx
/**
 * QuickEvalButton — One-click button to AI-generate personas, scenarios,
 * evaluators and immediately start an eval run.
 */

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '@/store/project-store';
import { useEvalsStore } from '@/store/evals-store';
import { apiFetch } from '@/lib/api-client';
import { Button } from '../../ui/Button';

interface QuickEvalButtonProps {
  size?: 'sm' | 'xs';
  onStarted?: () => void;
}

export function QuickEvalButton({ size = 'sm', onStarted }: QuickEvalButtonProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const setActiveTab = useEvalsStore((s) => s.setActiveTab);
  const setSelectedRunId = useEvalsStore((s) => s.setSelectedRunId);
  const [isRunning, setIsRunning] = useState(false);

  const handleQuickEval = async () => {
    if (!currentProject || isRunning) return;
    setIsRunning(true);
    try {
      const res = await apiFetch(`/api/projects/${currentProject.id}/evals/quick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Quick eval failed');

      toast.success('Quick Eval started — generating personas, scenarios, and running evaluations');
      setSelectedRunId(data.runId);
      setActiveTab('runs');
      onStarted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Button
      size={size}
      variant="secondary"
      onClick={handleQuickEval}
      loading={isRunning}
      disabled={isRunning}
      icon={<Sparkles className="w-3.5 h-3.5" />}
    >
      {isRunning ? 'Generating...' : 'Quick Eval'}
    </Button>
  );
}
```

**Step 2: Add "Generate with AI" button to PersonasTab**

In `PersonasTab.tsx`, add a `Sparkles` button next to "Create Persona" that calls `/api/projects/:id/evals/generate/personas`, shows the results in a dialog, and lets the user select which to save.

For brevity in this plan: add the button with an `onClick` that calls the generate endpoint, then for each returned persona calls `createPersona` via POST to the personas API, and refreshes.

```typescript
// In PersonasTab.tsx header area, after the Create Persona button:
<Button
  size="sm"
  variant="secondary"
  onClick={handleGenerate}
  loading={isGenerating}
  disabled={isGenerating}
  icon={<Sparkles className="w-3.5 h-3.5" />}
>
  Generate with AI
</Button>
```

The `handleGenerate` function:

1. POST to `/api/projects/:id/evals/generate/personas` with `{ count: 3 }`
2. For each persona in the response, POST to `/api/projects/:id/evals/personas` to save it
3. Call `refresh()` and show toast

**Step 3: Same pattern for ScenariosTab**

Add identical "Generate with AI" button that calls `/api/projects/:id/evals/generate/scenarios`.

**Step 4: Add QuickEvalButton to EvalsPage empty state and RunsTab header**

In `EvalsPage.tsx`: import and render `<QuickEvalButton />` next to the tab buttons.
In `RunsTab.tsx`: add `<QuickEvalButton />` next to the "New Run" button.

**Step 5: Run prettier on all modified files + typecheck**

```bash
npx prettier --write \
  apps/studio/src/components/evals/shared/QuickEvalButton.tsx \
  apps/studio/src/components/evals/tabs/PersonasTab.tsx \
  apps/studio/src/components/evals/tabs/ScenariosTab.tsx \
  apps/studio/src/components/evals/EvalsPage.tsx \
  apps/studio/src/components/evals/tabs/RunsTab.tsx
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep -i "eval" | head -20
```

**Step 6: Commit**

```bash
git add \
  apps/studio/src/components/evals/shared/QuickEvalButton.tsx \
  apps/studio/src/components/evals/tabs/PersonasTab.tsx \
  apps/studio/src/components/evals/tabs/ScenariosTab.tsx \
  apps/studio/src/components/evals/EvalsPage.tsx \
  apps/studio/src/components/evals/tabs/RunsTab.tsx
git commit -m "[ABLP-2] feat(studio): add Quick Eval button and Generate with AI to eval tabs"
```

---

### Task 5: "Fix in Architect" Button — ScoreDetail + Arch Store Integration

**Files:**

- Modify: `apps/studio/src/components/evals/heatmap/ScoreDetail.tsx`
- Modify: `apps/studio/src/store/arch-store.ts`

**Step 1: Add `prefillMessage` to arch-store.ts**

In the `ArchState` interface, add:

```typescript
  prefillMessage: string | null;
  setPrefillMessage: (msg: string | null) => void;
```

In the store initial state add `prefillMessage: null`.
Add the action:

```typescript
setPrefillMessage: (msg) => set({ prefillMessage: msg }),
```

Add `prefillMessage` to the `partialize` exclusion (it should NOT be persisted — ephemeral only).

**Step 2: Add "Fix in Architect" button to ScoreDetail.tsx**

Import `useArchStore`, `useRouter`, `useProjectStore`, `Wrench` icon from lucide.

After the evaluator rows, when `overallAvg < 3.0`, render:

```tsx
{
  overallAvg < 3.0 && (
    <div className="mt-3 pt-3 border-t border-default">
      <Button
        size="xs"
        variant="secondary"
        onClick={handleFixInArchitect}
        icon={<Wrench className="w-3 h-3" />}
      >
        Fix in Architect
      </Button>
    </div>
  );
}
```

The `handleFixInArchitect` function:

1. Build prefill message from eval context (persona name, scenario name, overall score, evaluator details)
2. Call `useArchStore.getState().setPrefillMessage(message)`
3. Call `useArchStore.getState().openPanel()`
4. Navigate to the agent page (use scenario's entryAgent if available, otherwise stay on current page)

**Step 3: Read prefillMessage in ArchChat**

In `ArchChat.tsx`, add a `useEffect` that checks `store.prefillMessage` on mount. If non-null, call `onSendMessage(store.prefillMessage)` and then `store.setPrefillMessage(null)`.

```typescript
// In ArchChat component:
useEffect(() => {
  const prefill = store.prefillMessage;
  if (prefill) {
    onSendMessage(prefill);
    store.setPrefillMessage(null);
  }
}, [store.prefillMessage, onSendMessage, store]);
```

**Step 4: Run prettier + typecheck**

```bash
npx prettier --write \
  apps/studio/src/components/evals/heatmap/ScoreDetail.tsx \
  apps/studio/src/store/arch-store.ts \
  apps/studio/src/components/arch/ArchChat.tsx
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep -E "ScoreDetail|arch-store|ArchChat" | head -10
```

**Step 5: Commit**

```bash
git add \
  apps/studio/src/components/evals/heatmap/ScoreDetail.tsx \
  apps/studio/src/store/arch-store.ts \
  apps/studio/src/components/arch/ArchChat.tsx
git commit -m "[ABLP-2] feat(studio): add Fix in Architect button with prefill message"
```

---

### Task 6: Post-Modification Eval Suggestion Toast

**Files:**

- Create: `apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx`
- Modify: `apps/studio/src/store/arch-store.ts` (in applyDiff success handler)

**Step 1: Create the toast utility**

```typescript
// apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx
/**
 * Eval suggestion toast — shown after Architect applies agent modifications
 * when the project has eval sets configured.
 */

import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';

/**
 * Show an eval re-run suggestion toast if the project has eval sets.
 * Call this after Architect successfully modifies an agent.
 */
export async function showEvalSuggestionIfNeeded(
  projectId: string,
  navigateToEvals: () => void,
): Promise<void> {
  try {
    const res = await apiFetch(`/api/projects/${projectId}/evals/sets`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.sets || data.sets.length === 0) return;

    toast('Agent modified — re-run evals to check for regressions?', {
      action: {
        label: 'Run Evals',
        onClick: navigateToEvals,
      },
      duration: 8000,
    });
  } catch {
    // Silently ignore — eval suggestion is non-critical
  }
}
```

**Step 2: Wire into arch-store's applyDiff success path**

In `arch-store.ts`, after the successful `applyDiff` (after `set({ ... lastAgentEditTimestamp: Date.now() })`), import and call the toast.

Since the store doesn't have access to Next.js router, we'll instead wire this in the component that calls `applyDiff` — which is the ArchChat/ProposalMessage component. After calling `store.applyDiff(diffId)`, check `store.lastAgentEditTimestamp` changed and call the toast.

Alternative: Add a listener in the EvalsPage or a higher-level component that watches `lastAgentEditTimestamp` and fires the toast. This is cleaner.

In `EvalsPage.tsx` or the main App layout, add:

```typescript
// Watch for agent edits and suggest eval re-run
const lastEdit = useArchStore((s) => s.lastAgentEditTimestamp);
const router = useRouter();
const projectId = useProjectStore((s) => s.currentProject?.id);

useEffect(() => {
  if (lastEdit && projectId) {
    showEvalSuggestionIfNeeded(projectId, () => {
      router.push(`/projects/${projectId}`);
      // The evals page will be accessible from project nav
    });
  }
}, [lastEdit, projectId, router]);
```

**Step 3: Prettier + typecheck + commit**

```bash
npx prettier --write \
  apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep "EvalSuggestion" | head -5
git add apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx
git commit -m "[ABLP-2] feat(studio): add post-modification eval suggestion toast"
```

---

### Task 7: Alert Rules Configuration

**Files:**

- Create: `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`

**Step 1: Write the alert rules module**

```typescript
// packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts
/**
 * Eval Alert Rules
 *
 * 8 pre-configured alert rules for eval monitoring. Registered automatically
 * when the first eval set is created for a project.
 * Plugs into the existing AlertRule interface from packages/eventstore/src/alerting/.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AlertRule, AlertSeverity, AlertWindow } from '@agent-platform/eventstore/alerting';

const log = createLogger('eval-alerts');

interface EvalAlertTemplate {
  /** Suffix appended to make the rule ID unique per tenant/project */
  idSuffix: string;
  name: string;
  description: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  window: AlertWindow;
  severity: AlertSeverity;
  cooldownSeconds: number;
}

const EVAL_ALERT_TEMPLATES: EvalAlertTemplate[] = [
  {
    idSuffix: 'eval-run-failed',
    name: 'Eval run failed',
    description: 'Fires when any eval run fails within a 5-minute window',
    metric: 'eval.run.failed',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'critical',
    cooldownSeconds: 300,
  },
  {
    idSuffix: 'eval-circuit-breaker-open',
    name: 'Eval circuit breaker opened',
    description: 'Fires when any eval circuit breaker opens',
    metric: 'eval.circuit_breaker.opened',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'critical',
    cooldownSeconds: 600,
  },
  {
    idSuffix: 'eval-cost-warning',
    name: 'Eval cost budget >80%',
    description: 'Monthly eval spend exceeds 80% of budget',
    metric: 'eval.monthly_cost',
    operator: 'gt',
    threshold: 0.8,
    window: { value: 1, unit: 'days' },
    severity: 'warning',
    cooldownSeconds: 3600,
  },
  {
    idSuffix: 'eval-cost-exceeded',
    name: 'Eval cost budget exceeded',
    description: 'Monthly eval spend exceeds 100% of budget',
    metric: 'eval.monthly_cost',
    operator: 'gt',
    threshold: 1.0,
    window: { value: 1, unit: 'days' },
    severity: 'critical',
    cooldownSeconds: 3600,
  },
  {
    idSuffix: 'eval-regression',
    name: 'Eval regression detected',
    description: 'A regression was detected in an eval run',
    metric: 'eval.regression.detected',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'warning',
    cooldownSeconds: 600,
  },
  {
    idSuffix: 'eval-run-duration',
    name: 'Eval run duration exceeded',
    description: 'An eval run took longer than 30 minutes',
    metric: 'eval.run.duration_ms',
    operator: 'gt',
    threshold: 1_800_000,
    window: { value: 1, unit: 'hours' },
    severity: 'warning',
    cooldownSeconds: 1800,
  },
  {
    idSuffix: 'eval-judge-latency',
    name: 'Eval judge latency spike',
    description: 'Judge call p95 latency exceeds 30 seconds over a 5-minute window',
    metric: 'eval.judge.duration_ms.p95',
    operator: 'gt',
    threshold: 30_000,
    window: { value: 5, unit: 'minutes' },
    severity: 'warning',
    cooldownSeconds: 300,
  },
  {
    idSuffix: 'eval-rate-limit-saturation',
    name: 'Eval rate limit saturation',
    description: 'Rate limit queue depth exceeds 10 for 10 minutes',
    metric: 'eval.rate_limit.queue_depth',
    operator: 'gt',
    threshold: 10,
    window: { value: 10, unit: 'minutes' },
    severity: 'info',
    cooldownSeconds: 600,
  },
];

/**
 * Build AlertRule objects for a tenant/project from templates.
 */
export function buildEvalAlertRules(tenantId: string, projectId: string): AlertRule[] {
  const now = new Date();
  return EVAL_ALERT_TEMPLATES.map((t) => ({
    id: `${projectId}-${t.idSuffix}`,
    tenantId,
    projectId,
    name: t.name,
    description: t.description,
    enabled: true,
    metric: t.metric,
    operator: t.operator,
    threshold: t.threshold,
    window: t.window,
    severity: t.severity,
    cooldownSeconds: t.cooldownSeconds,
    channels: [], // No webhook channels by default — admin dashboard only
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * Register eval alert rules for a project.
 * Idempotent — skips rules that already exist.
 *
 * @param ruleStore - The alert rule store implementation (injected)
 * @param tenantId - Tenant scope
 * @param projectId - Project scope
 */
export async function registerEvalAlertRules(
  ruleStore: {
    getActiveRules: (t: string, p: string) => Promise<AlertRule[]>;
    createRule: (r: AlertRule) => Promise<void>;
  },
  tenantId: string,
  projectId: string,
): Promise<number> {
  const existing = await ruleStore.getActiveRules(tenantId, projectId);
  const existingIds = new Set(existing.map((r) => r.id));

  const rules = buildEvalAlertRules(tenantId, projectId);
  let created = 0;

  for (const rule of rules) {
    if (!existingIds.has(rule.id)) {
      await ruleStore.createRule(rule);
      created++;
    }
  }

  if (created > 0) {
    log.info('Registered eval alert rules', { tenantId, projectId, created });
  }

  return created;
}
```

**Step 2: Run prettier + typecheck**

```bash
npx prettier --write packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts
npx tsc --noEmit -p packages/pipeline-engine/tsconfig.json 2>&1 | grep "eval-alerts" | head -10
```

**Step 3: Commit**

```bash
git add packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts
git commit -m "[ABLP-2] feat(pipeline): add pre-configured eval alert rules"
```

---

### Task 8: Build Verification + Final Commit

**Files:** All files from Tasks 1-7

**Step 1: Run full TypeScript check**

```bash
npx tsc --noEmit -p apps/studio/tsconfig.json 2>&1 | grep "error TS" | head -20
npx tsc --noEmit -p packages/pipeline-engine/tsconfig.json 2>&1 | grep "error TS" | head -20
```

**Step 2: Run prettier on all changed files**

```bash
npx prettier --write \
  apps/studio/src/app/api/projects/\[id\]/evals/generate/personas/route.ts \
  apps/studio/src/app/api/projects/\[id\]/evals/generate/scenarios/route.ts \
  apps/studio/src/app/api/projects/\[id\]/evals/quick/route.ts \
  apps/studio/src/components/evals/shared/QuickEvalButton.tsx \
  apps/studio/src/components/evals/shared/EvalSuggestionToast.tsx \
  apps/studio/src/components/evals/tabs/PersonasTab.tsx \
  apps/studio/src/components/evals/tabs/ScenariosTab.tsx \
  apps/studio/src/components/evals/EvalsPage.tsx \
  apps/studio/src/components/evals/tabs/RunsTab.tsx \
  apps/studio/src/components/evals/heatmap/ScoreDetail.tsx \
  apps/studio/src/store/arch-store.ts \
  apps/studio/src/components/arch/ArchChat.tsx \
  packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts
```

**Step 3: Run full build**

```bash
pnpm build
```

Expected: All tasks pass, zero errors.

**Step 4: Fix any issues found during build, then commit**

```bash
git add -A
git commit -m "[ABLP-2] fix(studio): resolve build errors from Phase 4 implementation"
```
