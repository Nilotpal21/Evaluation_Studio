# Workflow Engine — Design Document

## Date: 2026-02-27

**Package**: `@agent-platform/workflow-engine` (`packages/workflow-engine/`)

---

## 1. Problem Statement

### 1.1 Current State — Hardcoded Temporal Workflows

The platform has 4 hardcoded Temporal workflows. The orchestration logic is fixed at compile time:

| Workflow                  | Task Queue             | What It Does                                                                                                 |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `processingPipeline`      | `acp-processing-queue` | Ingest → validate → enrich → PII mask → store to ClickHouse                                                  |
| `evaluateSessionMetrics`  | `metrics-evaluation`   | Load metrics → run LLM eval → cache Redis → store ClickHouse → publish Kafka                                 |
| `evaluateSessionPolicies` | `policy-evaluation`    | Load policies → fetch metrics → evaluate → store ClickHouse → broadcast WebSocket → publish violations Kafka |
| `emailDigestWorkflow`     | `email-digest`         | Fetch schedules → fetch users → fetch stats → send batch email → update schedule                             |

Users can configure **what** gets evaluated — custom metrics, policies, LLM prompts — but cannot change **how** the pipeline runs. There is no way to:

- Reorder evaluation steps
- Add conditional branching (alert only if a policy fails)
- Compose existing capabilities into new sequences
- Skip steps based on prior results
- Route outputs to different destinations per pipeline
- Trigger different pipelines for different event types within the same tenant

### 1.2 Current Output Pipeline — Where Results Go

Each workflow's final activities write to hardcoded destinations:

**Metrics Evaluation outputs:**

```
evaluateSessionMetrics workflow completes
  ├── Redis         → cacheEvaluationResult (cached metric scores, TTL)
  ├── ClickHouse    → trace_metrics table (permanent metric scores, values, confidence)
  ├── ClickHouse    → trace_attributes table (dashboard-queryable metric measures)
  └── Kafka         → acp.metrics.evaluated.standard (triggers policy evaluation downstream)
```

**Policy Evaluation outputs:**

```
evaluateSessionPolicies workflow completes
  ├── ClickHouse    → policy_results table (pass/fail/inconclusive per policy)
  ├── ClickHouse    → session_attributes table (dashboard-queryable policy measures)
  ├── WebSocket     → policy_results_update via Redis pub/sub → connected UI clients
  └── Kafka         → acp.policy.violations.standard (triggers alert/notification services)
```

**Processing outputs:**

```
processingPipeline workflow completes
  ├── ClickHouse    → telemetry_normalized table (source of truth for all spans)
  ├── ClickHouse    → span_attributes table (dashboard-queryable span measures)
  ├── Kafka         → acp.telemetry.processed.standard (triggers metrics + policy eval)
  ├── Redis         → deduplication tracking (markProcessed)
  └── Mixpanel      → newly_added_runs event (product analytics)
```

These destinations are baked into the activity implementations. There is no way to redirect outputs without modifying source code.

### 1.3 The abl-platform Problem

abl-platform needs to trigger evaluation workflows but route results to its own stores. Today, if abl-platform starts an AMP workflow on the same task queue, the AMP worker executes it and writes results to AMP's ClickHouse tables, AMP's Kafka topics, AMP's Redis keys. abl-platform has no way to intercept or redirect because **the activities determine the destination, not the caller**.

### 1.4 The Temporal Operational Burden

Temporal adds significant infrastructure complexity:

- Requires a dedicated Temporal server container (`temporalio/auto-setup:1.24.2`)
- Requires a PostgreSQL database solely for Temporal state
- 4 separate worker services, each with its own Temporal `NativeConnection`
- Temporal's workflow determinism constraints complicate development (no direct I/O, no Date.now(), special handling of non-deterministic code)
- Separate workflow and activity code paths with explicit `proxyActivities` registration

### 1.5 What This Design Solves

- **Custom pipelines**: Tenant admins compose evaluation pipelines from building blocks without deploying code
- **Output routing**: Same evaluation logic, different destinations per pipeline definition
- **Simpler operations**: Restate replaces Temporal — lighter server, no separate database, no determinism constraints
- **Phased migration**: New pipeline engine on Restate first, existing system workflows migrated incrementally
- **Fewer services**: Post-migration, one pipeline-worker replaces 4 system workers + Temporal server + PostgreSQL

---

## 2. Design Decisions

| Decision                | Choice                                          | Alternatives Considered                         | Rationale                                                                                                                                                |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow engine         | Restate                                         | Temporal (current); custom engine               | Simpler ops (no separate DB), durable execution via journal replay, native Kafka subscriptions, code-first model without determinism constraints.        |
| Migration strategy      | Phased — new pipelines first                    | Clean break; new-only coexistence               | Lowest risk. Temporal bridge activity lets custom pipelines compose existing system workflows. Migrate system workflows one at a time.                   |
| Kafka integration       | Both Restate native subscription + programmatic | Restate-only; KafkaJS consumer-only             | Native subscription for simple event→pipeline routing. Programmatic triggering for complex matching and manual execution.                                |
| Deployment model        | Agnostic (self-hosted or cloud)                 | Self-hosted only; Restate Cloud only            | No code changes needed to switch. Service endpoint pattern works with both.                                                                              |
| Pipeline model          | Simplified: sequential + parallel + skip        | Full DAG with jump-to-step                      | Jump-to-step adds complexity for an edge case. Sequential + parallel + conditional skip covers 95% of use cases.                                         |
| Activity implementation | Restate service handlers                        | External HTTP calls; separate services          | Durable RPC with automatic retry, timeout, and observability. Aligns with eventual full migration to Restate.                                            |
| Execution state         | Workflow durable state (journal)                | Separate virtual object; Redis; MongoDB polling | Restate journals every `ctx.*` call. Workflow state survives crashes natively. Shared handler exposes state for queries. No parallel state store needed. |
| Execution history       | MongoDB (persisted on completion)               | ClickHouse; Restate state only                  | MongoDB for document queries (list runs, filter by status). Restate state is for live runs only — cleaned up after workflow completes.                   |
| Schedule triggers       | Restate sleep + self-invocation                 | External cron; Temporal Schedules; node-cron    | Durable sleep survives crashes. No external scheduler. Idiomatic Restate pattern.                                                                        |
| Activity metadata       | Static registry object                          | Dynamic registry class; database-stored         | Config schemas, output schemas, and defaults don't change at runtime. Static object is simpler, testable, and type-safe.                                 |
| Pipeline invocation     | Internal only (Kafka, schedule, SDK)            | REST API for execution                          | No external execution API needed. Kafka subscriptions and Restate SDK cover all trigger paths. Simpler surface area.                                     |
| Pipeline CRUD           | Studio Next.js API routes                       | Dedicated API service; runtime routes           | Studio is where admins manage pipelines via UI. CRUD routes co-located with the pipeline builder UI. No extra container.                                 |

---

## 3. Architecture Overview

### 3.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Event Sources                                    │
│                                                                          │
│  Kafka Topics              Programmatic (SDK)      Schedules             │
│  (session.processed,       (Restate client)        (cron via Restate     │
│   metrics.evaluated, ...)                           delayed calls)       │
└──────┬──────────────────────────┬────────────────────────┬──────────────┘
       │                         │                        │
       ▼                         ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Restate Server                                      │
│                      (durable execution engine)                          │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  PipelineTrigger (service)                                       │    │
│  │  • Receives Kafka events via Restate native subscription         │    │
│  │  • Looks up matching active pipeline definitions in MongoDB      │    │
│  │  • Starts PipelineRun workflows for each match                   │    │
│  └──────────────────────────┬──────────────────────────────────────┘    │
│                              │ starts                                    │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  PipelineRun (workflow)                                          │    │
│  │  • Interprets pipeline definition JSON (steps array)             │    │
│  │  • Executes steps sequentially or in parallel                    │    │
│  │  • Evaluates conditions (run or skip)                            │    │
│  │  • Calls activity services via Restate durable RPC               │    │
│  │  • Tracks step progress in durable state (queryable)             │    │
│  └──────┬──────────┬──────────┬──────────┬──────────┬─────────────┘    │
│         │          │          │          │          │                     │
│         ▼          ▼          ▼          ▼          ▼                     │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  Activity Services (Restate services)                           │     │
│  │                                                                  │     │
│  │  EvaluateMetrics    — wraps MetricsEvaluationService logic      │     │
│  │  EvaluatePolicy     — wraps PolicyEvaluationService logic       │     │
│  │  StoreResults       — writes to ClickHouse / MongoDB / callback │     │
│  │  SendNotification   — Slack / email / webhook / WebSocket       │     │
│  │  TransformData      — reshape data between steps                │     │
│  │  RunLegacyWorkflow  — bridge: calls Temporal child workflow     │     │
│  └──────┬──────────┬──────────┬──────────┬─────────────────────────┘     │
│         │          │          │          │                                │
└─────────┼──────────┼──────────┼──────────┼───────────────────────────────┘
          ▼          ▼          ▼          ▼
      ClickHouse  MongoDB   Kafka Topics  HTTP Callbacks
      (analytics) (defs,    (events)      (abl-platform)
                   runs)
```

### 3.2 Restate Handler Types

| Restate Concept    | Our Usage                                               | Why                                                                                                                                                    |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workflow**       | `PipelineRun`                                           | Runs exactly once per invocation ID. Each pipeline execution is a unique workflow. Durable state survives crashes. Shared handler exposes live status. |
| **Service**        | `PipelineTrigger`, `ActivityRouter`, all activity types | Stateless handlers. Restate handles retries and timeouts. Kafka events land on PipelineTrigger. Activity types receive step execution requests.        |
| **Virtual Object** | `PipelineScheduler`                                     | Keyed by pipeline ID. Manages cron schedule loops via durable sleep + self-invocation. Single-writer guarantee prevents duplicate schedules.           |

### 3.3 Restate's Durable Execution Model

Restate records every `ctx.*` call in a **durable journal** stored on the Restate server. On crash recovery:

1. The code re-runs from the beginning
2. Every `ctx.*` call checks the journal
3. If the journal has a completed entry → returns the journaled result instantly (no re-execution)
4. Once it reaches the journal's end (the crash point) → resumes live execution

This means:

- **No external state management for in-flight executions.** Local variables (`stepOutputs`, loop counter `i`) are rebuilt naturally by replaying journaled results.
- **No determinism constraints.** Unlike Temporal, Restate doesn't require workflow code to be deterministic. Any code that goes through `ctx.*` is journaled; plain JavaScript runs normally.
- **One rule: all side effects must go through `ctx`.** Raw `fetch()`, `db.insert()`, or `Date.now()` outside of `ctx.run()` would re-execute on replay. Wrap them in `ctx.run("label", async () => { ... })`.

**Example — crash recovery in the step loop:**

```
Before crash: steps 0, 1, 2 completed. Crash during step 3.

Replay:
  i=0: ctx.serviceClient().execute(step0) → journal hit → instant return
  i=1: ctx.serviceClient().execute(step1) → journal hit → instant return
  i=2: ctx.serviceClient().execute(step2) → journal hit → instant return
  i=3: ctx.serviceClient().execute(step3) → NO journal entry → live execution resumes
```

### 3.4 Key Principle — System Workflows as Building Blocks

During the migration period, custom pipelines can reference existing Temporal system workflows as steps via the `run-legacy-workflow` activity type. A custom pipeline can say "run the system metrics evaluation as step 1, then do my custom logic in steps 2-5." The bridge activity starts the Temporal workflow via the Temporal client and waits for its result.

As system workflows are migrated to Restate services, the step `type` changes from `run-legacy-workflow` to the direct Restate service (e.g., `evaluate-metrics`). No pipeline definition restructuring needed — just swap the activity type.

---

## 4. Pipeline Definition Model

### 4.1 MongoDB Schema — `pipeline_definitions` Collection

```typescript
{
  _id: ObjectId,
  tenantId: string,              // tenant isolation — all queries include this
  projectId?: string,            // if set, scoped to project; if null, account-level

  // ── Metadata ──
  name: string,                  // "Post-Session Safety Evaluation"
  description?: string,          // optional human-readable description
  version: number,               // auto-incremented on every update
  status: 'draft' | 'active' | 'archived',
                                 // draft: being edited, not triggerable
                                 // active: live, responds to triggers
                                 // archived: soft-deleted, preserved for audit

  // ── Trigger ──
  trigger: {
    type: 'kafka' | 'schedule' | 'manual',

    // Kafka trigger — Restate native subscription or programmatic matching
    // Only active pipelines matching tenantId + kafkaTopic are triggered.
    kafkaTopic?: string,         // 'acp.session.processed.standard'
                                 // 'acp.metrics.evaluated.standard'
                                 // 'acp.telemetry.processed.standard'

    // Optional event filter — only trigger on events matching a field value
    eventFilter?: {
      field: string,             // 'data.projectId'
      equals: string,            // 'proj-123'
    },

    // Schedule trigger — cron expression
    schedule?: string,           // '0 */6 * * *' (every 6 hours)
                                 // '0 0 * * MON' (every Monday midnight)

    // Manual — no auto-trigger. Started programmatically via Restate SDK
  },

  // ── Input Schema ──
  // Describes what data this pipeline expects when triggered.
  // For Kafka triggers, the event payload is validated against this.
  // For manual triggers, the request body is validated against this.
  inputSchema?: {
    required: string[],          // ['tenantId', 'projectId', 'sessionId']
    properties: Record<string, {
      type: string,              // 'string', 'number', 'boolean', 'object', 'array'
      description?: string,
    }>,
  },

  // ── Steps ──
  // Ordered array of steps. Executed top-to-bottom.
  steps: PipelineStep[],

  // ── Audit ──
  createdBy: string,             // userId who created this pipeline
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes:**

```
{ tenantId: 1, status: 1 }                              — list active pipelines
{ tenantId: 1, projectId: 1, status: 1 }                — project-scoped queries
{ tenantId: 1, 'trigger.kafkaTopic': 1, status: 1 }     — Kafka event matching
```

### 4.2 Step Definition

```typescript
interface PipelineStep {
  // ── Identity ──
  id: string; // unique within this pipeline: 'eval-toxicity'
  // used in condition expressions and execution tracking
  name: string; // human-readable label: 'Evaluate Toxicity'

  // ── Activity Type ──
  type: string; // key from ACTIVITY_TYPES: 'evaluate-metrics'
  // must match a registered activity type

  // ── Parallel Execution ──
  // Steps with the same `parallel` tag run concurrently.
  // All steps in a parallel group must be contiguous in the array.
  // The engine waits for ALL steps in the group to complete before
  // moving to the next step after the group.
  parallel?: string; // group tag: 'eval-group'
  // omitted = sequential (waits for previous step)

  // ── Conditional Execution ──
  // Controls whether this step runs based on outputs of previous steps.
  // If omitted, the step always runs (unconditional).
  // If the expression evaluates to FALSE, the step is skipped.
  condition?: {
    expression: string; // "steps.check-policy.output.status == 'FAIL'"
    // "steps.eval-safety.output.scores.toxicity > 0.7"
  };

  // ── Step Config ──
  // Passed to the activity service's execute() handler.
  // Validated against the activity type's configSchema when the pipeline is saved.
  config: Record<string, any>;

  // ── Per-Step Overrides ──
  timeout?: number; // ms. If omitted, uses activity type's defaultTimeout
  retries?: number; // If omitted, uses activity type's defaultRetries
}
```

### 4.3 Simplifications from the Original Design

| Feature                       | Original Design                                            | This Design                                                 | Rationale                                                                                   |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `onFalse: 'stop'`             | Implicit pipeline stop via condition                       | Explicit: step returns `pipelineShouldStop: true` in output | More explicit. The workflow checks this flag after each step.                               |
| `onFalse: '<step-id>'` (jump) | Skip to a named step                                       | Removed                                                     | Adds complexity for an edge case. Sequential + parallel + skip covers 95% of use cases.     |
| Per-step `output` routing     | Each step could route to ClickHouse/MongoDB/callback       | Removed                                                     | Use a `store-results` step instead. Steps produce data; storage steps route it.             |
| Pipeline-level `output`       | Pipeline definition could specify final output destination | Removed                                                     | Add a `store-results` step at the end instead. One mechanism, not two.                      |
| `taskQueue` field             | Temporal task queue per pipeline                           | Removed                                                     | Restate doesn't use task queues. Service routing is handled by Restate's service discovery. |
| `trigger.type: 'event'`       | Generic event type string                                  | `trigger.type: 'kafka'` with explicit `kafkaTopic`          | More precise. Maps directly to Restate's Kafka subscription model.                          |

### 4.4 Execution Order Rules

Steps execute **top to bottom** in array order. Array position defines sequence.

**Sequential (default):**

```
steps[0]  → runs first
steps[1]  → runs after steps[0] completes
steps[2]  → runs after steps[1] completes
```

**Parallel groups:**
Steps with the same `parallel` tag run concurrently. All steps in a group must be contiguous. The engine waits for ALL steps in the group to complete before advancing.

```
steps[0]                       → runs first (sequential)
steps[1]  parallel: "eval"     ─┐
steps[2]  parallel: "eval"     ─┼── run concurrently, engine waits for all 3
steps[3]  parallel: "eval"     ─┘
steps[4]                       → runs after entire "eval" group completes
```

**Conditions:**

```
steps[0]  eval-safety          → runs
steps[1]  check-policy         → runs
steps[2]  alert                → condition: "steps.check-policy.output.status == 'FAIL'"
steps[3]  store                → runs (unconditional)

When policy FAILS (condition TRUE):
  eval-safety → check-policy → alert (runs) → store

When policy PASSES (condition FALSE):
  eval-safety → check-policy → alert (skipped) → store
```

**Early stop:**
Any step can return `{ data: { pipelineShouldStop: true } }` in its output. The workflow checks this flag after each step completes. If set, all remaining steps are marked `skipped` and the pipeline completes normally.

### 4.5 Example Pipeline — Custom Safety Evaluation

```json
{
  "name": "Custom Safety Evaluation",
  "description": "Evaluate safety and quality metrics in parallel, check policy, alert on failure",
  "status": "active",
  "trigger": {
    "type": "kafka",
    "kafkaTopic": "acp.session.processed.standard"
  },
  "inputSchema": {
    "required": ["tenantId", "projectId", "sessionId"],
    "properties": {
      "tenantId": { "type": "string" },
      "projectId": { "type": "string" },
      "sessionId": { "type": "string" }
    }
  },
  "steps": [
    {
      "id": "eval-safety",
      "name": "Evaluate Safety Metrics",
      "type": "evaluate-metrics",
      "config": { "metrics": ["toxicity", "bias", "pii-detection"] }
    },
    {
      "id": "eval-quality",
      "name": "Evaluate Quality Metrics",
      "type": "evaluate-metrics",
      "parallel": "eval-group",
      "config": { "metrics": ["coherence", "relevance"] }
    },
    {
      "id": "eval-cost",
      "name": "Evaluate Cost Metrics",
      "type": "evaluate-metrics",
      "parallel": "eval-group",
      "config": { "metrics": ["token-cost", "latency"] }
    },
    {
      "id": "check-policy",
      "name": "Run Safety Policy",
      "type": "evaluate-policy",
      "config": { "policyId": "pol-safety-001" }
    },
    {
      "id": "alert",
      "name": "Send Slack Alert",
      "type": "send-notification",
      "condition": {
        "expression": "steps.check-policy.output.status == 'FAIL'"
      },
      "config": {
        "channel": "slack",
        "webhookUrl": "https://hooks.slack.com/services/T00/B00/xxx"
      }
    },
    {
      "id": "store",
      "name": "Store All Results",
      "type": "store-results",
      "config": {
        "destination": "clickhouse",
        "table": "trace_metrics"
      }
    }
  ]
}
```

**Execution trace when policy FAILS:**

```
1. eval-safety     → runs    → { scores: { toxicity: 0.9, bias: 0.3, pii: 0.1 } }
2. eval-quality  ──┐ parallel
3. eval-cost     ──┘ parallel → both run concurrently, engine waits for both
4. check-policy    → runs    → { status: 'FAIL', summary: { passed: 2, failed: 1 } }
5. alert           → condition TRUE → runs → sends Slack notification
6. store           → runs    → writes all step outputs to trace_metrics
```

**Execution trace when policy PASSES:**

```
1. eval-safety     → runs    → { scores: { toxicity: 0.1, bias: 0.05, pii: 0.0 } }
2. eval-quality  ──┐ parallel
3. eval-cost     ──┘ parallel → both run concurrently
4. check-policy    → runs    → { status: 'PASS', summary: { passed: 3, failed: 0 } }
5. alert           → condition FALSE → SKIPPED
6. store           → runs    → writes all step outputs to trace_metrics
```

### 4.6 Example Pipeline — Legacy Workflow Bridge + Custom Logic

```json
{
  "name": "Full Session Analysis with Custom Scoring",
  "trigger": { "type": "kafka", "kafkaTopic": "acp.session.processed.standard" },
  "steps": [
    {
      "id": "system-metrics",
      "name": "Run System Metrics Evaluation",
      "type": "run-legacy-workflow",
      "config": { "workflow": "evaluateSessionMetrics" }
    },
    {
      "id": "custom-scoring",
      "name": "Run My Custom Metrics",
      "type": "evaluate-metrics",
      "config": { "metrics": ["my-custom-metric-1", "my-custom-metric-2"] }
    },
    {
      "id": "aggregate",
      "name": "Combine System + Custom Results",
      "type": "transform",
      "config": {
        "mapping": {
          "systemScore": "steps.system-metrics.output.data.overallScore",
          "customScore": "steps.custom-scoring.output.scores"
        }
      }
    },
    {
      "id": "store",
      "name": "Store Combined Results",
      "type": "store-results",
      "config": { "destination": "clickhouse", "table": "trace_metrics" }
    }
  ]
}
```

This pipeline runs the existing Temporal metrics evaluation, adds custom metrics on top, combines results, and stores everything. The admin composed this without writing code. When the system metrics workflow is eventually migrated to Restate, the step type changes from `run-legacy-workflow` to `evaluate-metrics` — no other changes needed.

---

## 5. Core Types

### 5.1 Shared Types

```typescript
// packages/workflow-engine/src/pipeline/types.ts

/**
 * Context passed to every activity service execution.
 * Contains everything the activity needs to do its work.
 */
export interface PipelineStepContext {
  /** Tenant ID — always present, used for multi-tenant isolation */
  tenantId: string;

  /** Project ID — present for project-scoped pipelines */
  projectId?: string;

  /** Session ID — present for session-triggered pipelines */
  sessionId?: string;

  /**
   * The step's config from the pipeline definition.
   * Already validated against the activity's configSchema at save time.
   */
  config: Record<string, any>;

  /**
   * Outputs from all previously completed steps, keyed by step ID.
   * Steps that were skipped have { status: 'skipped', data: {} }.
   */
  previousSteps: Record<string, StepOutput>;

  /**
   * Pipeline-level input — from the trigger event payload or manual execute request body.
   */
  pipelineInput: Record<string, any>;
}

/**
 * Output from a single step execution.
 */
export interface StepOutput {
  /** Whether the step succeeded, failed, or was skipped */
  status: 'success' | 'fail' | 'skipped';

  /**
   * Arbitrary output data. Shape depends on activity type.
   * Available to subsequent steps via context.previousSteps[stepId].data
   * Available in condition expressions via steps.<stepId>.output.<field>
   *
   * Special field: if data.pipelineShouldStop === true, the workflow
   * stops after this step and marks remaining steps as skipped.
   */
  data: Record<string, any>;

  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Input to the PipelineRun workflow.
 */
export interface PipelineRunInput {
  pipelineDefinition: PipelineDefinition;
  pipelineInput: Record<string, any>;
}

/**
 * Step definition within a pipeline.
 */
export interface PipelineStep {
  id: string;
  name: string;
  type: string;
  parallel?: string;
  condition?: { expression: string };
  config: Record<string, any>;
  timeout?: number;
  retries?: number;
}

/**
 * Full pipeline definition (as stored in MongoDB).
 */
export interface PipelineDefinition {
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
  steps: PipelineStep[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Execution state tracked in workflow durable state and persisted to MongoDB.
 */
export interface PipelineRunState {
  runId: string;
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string;
  };
  input: Record<string, any>;
  steps: Array<{
    id: string;
    name: string;
    type: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
  }>;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: {
    stepId: string;
    message: string;
  };
}
```

---

## 6. Restate Handlers

### 6.1 PipelineRun — Workflow

The DAG interpreter. One workflow instance per pipeline execution.

```typescript
// packages/workflow-engine/src/pipeline/handlers/pipeline-run.workflow.ts

import * as restate from '@restatedev/restate-sdk';
import { evaluateExpression } from '../expression-evaluator';
import type { PipelineRunInput, PipelineStep, StepOutput, PipelineRunState } from '../types';

export const pipelineRun = restate.workflow({
  name: 'PipelineRun',
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      input: PipelineRunInput,
    ): Promise<{ status: string; stepOutputs: Record<string, StepOutput> }> => {
      const { pipelineDefinition, pipelineInput } = input;
      const steps = pipelineDefinition.steps;
      const stepOutputs: Record<string, StepOutput> = {};

      // Initialize durable state — survives crashes, queryable via getStatus
      ctx.set('status', 'running');
      ctx.set(
        'steps',
        steps.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: 'pending',
        })),
      );
      ctx.set('startedAt', Date.now());

      let i = 0;

      while (i < steps.length) {
        const step = steps[i];

        // ── 1. Evaluate condition ──
        if (step.condition) {
          const shouldRun = evaluateExpression(step.condition.expression, stepOutputs);

          if (!shouldRun) {
            stepOutputs[step.id] = { status: 'skipped', data: {} };
            await updateStepState(ctx, step.id, 'skipped');
            i++;
            continue;
          }
        }

        // ── 2. Parallel group ──
        if (step.parallel) {
          const groupTag = step.parallel;
          const parallelSteps: PipelineStep[] = [];

          while (i < steps.length && steps[i].parallel === groupTag) {
            parallelSteps.push(steps[i]);
            i++;
          }

          // Mark all as running
          for (const ps of parallelSteps) {
            await updateStepState(ctx, ps.id, 'running');
          }

          // Fan-out: call activity services concurrently via durable RPC
          const results = await restate.CombineablePromise.all(
            parallelSteps.map((ps) =>
              ctx.serviceClient(activityRouter).execute({
                step: ps,
                previousSteps: stepOutputs,
                pipelineInput,
              }),
            ),
          );

          // Fan-in: collect outputs, update state
          for (let j = 0; j < parallelSteps.length; j++) {
            stepOutputs[parallelSteps[j].id] = results[j];
            await updateStepState(
              ctx,
              parallelSteps[j].id,
              results[j].status,
              results[j].durationMs,
            );
          }

          continue;
        }

        // ── 3. Sequential step ──
        await updateStepState(ctx, step.id, 'running');

        const result = await ctx.serviceClient(activityRouter).execute({
          step,
          previousSteps: stepOutputs,
          pipelineInput,
        });

        stepOutputs[step.id] = result;
        await updateStepState(ctx, step.id, result.status, result.durationMs);

        // ── 4. Check for early stop ──
        if (result.data?.pipelineShouldStop === true) {
          for (let j = i + 1; j < steps.length; j++) {
            stepOutputs[steps[j].id] = { status: 'skipped', data: {} };
            await updateStepState(ctx, steps[j].id, 'skipped');
          }
          break;
        }

        i++;
      }

      // ── 5. Finalize ──
      const overallStatus = Object.values(stepOutputs).some((o) => o.status === 'fail')
        ? 'failed'
        : 'completed';

      ctx.set('status', overallStatus);
      ctx.set('completedAt', Date.now());

      // Persist to MongoDB for long-term history
      await ctx.run('persist-to-mongo', async () => {
        await persistRunToMongo(ctx.key, {
          pipelineId: pipelineDefinition._id,
          pipelineVersion: pipelineDefinition.version,
          tenantId: pipelineInput.tenantId,
          status: overallStatus,
          stepOutputs,
        });
      });

      return { status: overallStatus, stepOutputs };
    },

    // ── Shared handler: query live execution status ──
    // Called by the API layer. Does not block the workflow.
    getStatus: restate.handlers.workflow.shared(async (ctx: restate.WorkflowSharedContext) => ({
      status: await ctx.get('status'),
      steps: await ctx.get('steps'),
      startedAt: await ctx.get('startedAt'),
      completedAt: await ctx.get('completedAt'),
    })),
  },
});

/**
 * Helper: update a step's status in the workflow's durable state.
 * This makes step progress queryable via the getStatus shared handler.
 */
async function updateStepState(
  ctx: restate.WorkflowContext,
  stepId: string,
  status: string,
  durationMs?: number,
): Promise<void> {
  const steps = (await ctx.get<any[]>('steps')) ?? [];
  const step = steps.find((s) => s.id === stepId);
  if (step) {
    step.status = status;
    if (status === 'running') step.startedAt = Date.now();
    if (status !== 'running' && status !== 'pending') {
      step.completedAt = Date.now();
      if (durationMs !== undefined) step.durationMs = durationMs;
    }
  }
  ctx.set('steps', steps);
}
```

### 6.2 ActivityRouter — Service

Single entry point that dispatches to the correct activity service.

```typescript
// packages/workflow-engine/src/pipeline/handlers/activity-router.service.ts

import * as restate from '@restatedev/restate-sdk';
import { ACTIVITY_TYPES } from '../activity-metadata';
import type { PipelineStepContext, StepOutput } from '../types';

// Import activity service references for ctx.serviceClient()
import { evaluateMetricsService } from '../services/evaluate-metrics.service';
import { evaluatePolicyService } from '../services/evaluate-policy.service';
import { storeResultsService } from '../services/store-results.service';
import { sendNotificationService } from '../services/send-notification.service';
import { transformService } from '../services/transform.service';
import { runLegacyWorkflowService } from '../services/run-legacy-workflow.service';

export const activityRouter = restate.service({
  name: 'ActivityRouter',
  handlers: {
    execute: async (
      ctx: restate.Context,
      input: {
        step: PipelineStep;
        previousSteps: Record<string, StepOutput>;
        pipelineInput: Record<string, any>;
      },
    ): Promise<StepOutput> => {
      const { step, previousSteps, pipelineInput } = input;

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
        switch (step.type) {
          case 'evaluate-metrics':
            return await ctx.serviceClient(evaluateMetricsService).execute(stepContext);
          case 'evaluate-policy':
            return await ctx.serviceClient(evaluatePolicyService).execute(stepContext);
          case 'store-results':
            return await ctx.serviceClient(storeResultsService).execute(stepContext);
          case 'send-notification':
            return await ctx.serviceClient(sendNotificationService).execute(stepContext);
          case 'transform':
            return await ctx.serviceClient(transformService).execute(stepContext);
          case 'run-legacy-workflow':
            return await ctx.serviceClient(runLegacyWorkflowService).execute(stepContext);
          default:
            return {
              status: 'fail',
              data: { error: `Unhandled activity type: '${step.type}'` },
            };
        }
      } catch (error) {
        return {
          status: 'fail',
          data: {
            error: error instanceof Error ? error.message : String(error),
            type: step.type,
          },
        };
      }
    },
  },
});
```

### 6.3 PipelineTrigger — Service (Kafka Subscription + Manual)

Receives Kafka events and starts pipeline runs.

```typescript
// packages/workflow-engine/src/pipeline/handlers/pipeline-trigger.service.ts

import * as restate from '@restatedev/restate-sdk';
import { pipelineRun } from './pipeline-run.workflow';
import type { PipelineDefinition } from '../types';

export const pipelineTrigger = restate.service({
  name: 'PipelineTrigger',
  handlers: {
    /**
     * Kafka event handler.
     * Restate routes Kafka messages to this handler via subscription config.
     * Each Kafka message triggers this handler once.
     */
    handleEvent: async (
      ctx: restate.Context,
      event: {
        type: string;
        tenantId: string;
        data: Record<string, any>;
      },
    ): Promise<void> => {
      // Find all active pipelines matching this event's topic + tenant
      const matchingPipelines = await ctx.run('find-pipelines', async () =>
        findActivePipelinesForEvent(event.tenantId, event.type),
      );

      for (const pipeline of matchingPipelines) {
        // Apply event filter if defined
        if (pipeline.trigger.eventFilter) {
          const fieldValue = getNestedField(event.data, pipeline.trigger.eventFilter.field);
          if (fieldValue !== pipeline.trigger.eventFilter.equals) {
            continue;
          }
        }

        // Validate input against pipeline's inputSchema
        if (pipeline.inputSchema) {
          const valid = validateInput(event.data, pipeline.inputSchema);
          if (!valid) continue;
        }

        // Generate unique run ID
        const runId = await ctx.run(
          'generate-run-id',
          () => `${pipeline._id}-${Date.now()}-${randomSuffix()}`,
        );

        // Start the pipeline workflow
        ctx.workflowClient(pipelineRun, runId).run({
          pipelineDefinition: pipeline,
          pipelineInput: { tenantId: event.tenantId, ...event.data },
        });

        // Create initial run record in MongoDB
        await ctx.run('create-run-record', async () => {
          await createRunRecord({
            runId,
            pipelineId: pipeline._id,
            pipelineVersion: pipeline.version,
            tenantId: event.tenantId,
            status: 'running',
            trigger: { type: 'kafka', kafkaTopic: event.type },
            input: event.data,
            steps: pipeline.steps,
            startedAt: new Date(),
          });
        });
      }
    },

    /**
     * Manual trigger — called by the API layer.
     */
    triggerManual: async (
      ctx: restate.Context,
      input: {
        pipelineId: string;
        tenantId: string;
        triggeredBy: string;
        data: Record<string, any>;
      },
    ): Promise<{ runId: string }> => {
      const pipeline = await ctx.run('load-pipeline', async () =>
        loadActivePipeline(input.pipelineId, input.tenantId),
      );

      if (!pipeline) {
        throw new restate.TerminalError('Pipeline not found or not active');
      }

      const runId = await ctx.run(
        'generate-run-id',
        () => `${pipeline._id}-${Date.now()}-${randomSuffix()}`,
      );

      ctx.workflowClient(pipelineRun, runId).run({
        pipelineDefinition: pipeline,
        pipelineInput: { tenantId: input.tenantId, ...input.data },
      });

      await ctx.run('create-run-record', async () => {
        await createRunRecord({
          runId,
          pipelineId: pipeline._id,
          pipelineVersion: pipeline.version,
          tenantId: input.tenantId,
          status: 'running',
          trigger: { type: 'manual', triggeredBy: input.triggeredBy },
          input: input.data,
          steps: pipeline.steps,
          startedAt: new Date(),
        });
      });

      return { runId };
    },
  },
});
```

### 6.4 PipelineScheduler — Virtual Object

Manages cron schedules via Restate's durable sleep.

```typescript
// packages/workflow-engine/src/pipeline/handlers/pipeline-scheduler.ts

import * as restate from '@restatedev/restate-sdk';
import { pipelineTrigger } from './pipeline-trigger.service';
import { getNextCronTime } from '../utils/cron';

/**
 * Virtual object keyed by pipeline ID.
 * Manages cron schedule loops via durable sleep + self-invocation.
 * Single-writer guarantee prevents duplicate schedules.
 */
export const pipelineScheduler = restate.object({
  name: 'PipelineScheduler',
  handlers: {
    /**
     * Start the schedule loop.
     * Called when a schedule-triggered pipeline is activated.
     * Re-invokes itself after each execution to create a durable loop.
     */
    start: async (
      ctx: restate.ObjectContext,
      input: {
        pipelineId: string;
        tenantId: string;
        cronExpression: string;
      },
    ): Promise<void> => {
      ctx.set('active', true);
      ctx.set('config', input);

      // Calculate delay until next scheduled time
      const now = await ctx.run('now', () => Date.now());
      const nextRun = getNextCronTime(input.cronExpression, now);
      const delayMs = nextRun - now;

      // Durable sleep — survives crashes and restarts
      await ctx.sleep(delayMs);

      // Check if still active (may have been deactivated during sleep)
      const active = await ctx.get<boolean>('active');
      if (!active) return;

      // Trigger the pipeline via the PipelineTrigger service
      await ctx.serviceClient(pipelineTrigger).triggerManual({
        pipelineId: input.pipelineId,
        tenantId: input.tenantId,
        triggeredBy: 'schedule',
        data: { triggeredBy: 'schedule' },
      });

      // Re-invoke self for the next iteration
      ctx.objectClient(pipelineScheduler, ctx.key).start(input);
    },

    /**
     * Stop the schedule loop.
     * Called when a schedule-triggered pipeline is deactivated.
     * Sets active=false so the next wake-up exits without triggering.
     */
    stop: async (ctx: restate.ObjectContext): Promise<void> => {
      ctx.set('active', false);
    },

    /**
     * Query current schedule status.
     */
    getScheduleStatus: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => ({
      active: await ctx.get<boolean>('active'),
      config: await ctx.get('config'),
    })),
  },
});
```

---

## 7. Activity Type Services

### 7.1 Activity Metadata Registry

Static registry for validation (at pipeline save time) and UI (pipeline builder palette). Separate from execution — no class hierarchy, no dynamic registration.

```typescript
// packages/workflow-engine/src/pipeline/activity-metadata.ts

export interface ActivityTypeMetadata {
  type: string;
  name: string;
  description: string;
  configSchema: object; // JSON Schema — validates step.config at save time
  outputSchema: object; // JSON Schema — documents output shape for UI
  defaultTimeout: number; // ms
  defaultRetries: number;
}

export const ACTIVITY_TYPES: Record<string, ActivityTypeMetadata> = {
  'evaluate-metrics': {
    type: 'evaluate-metrics',
    name: 'Evaluate Metrics',
    description: 'Run LLM or quantitative metric evaluation on a session',
    configSchema: {
      type: 'object',
      properties: {
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metric IDs or metric keys to evaluate',
        },
        model: {
          type: 'string',
          description: 'LLM model override. If omitted, uses metric default.',
        },
      },
      required: ['metrics'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        scores: { type: 'object', description: 'metricId → numeric score' },
        details: { type: 'array', description: 'Per-metric evaluation details' },
        status: { type: 'string', enum: ['success', 'fail'] },
      },
    },
    defaultTimeout: 300_000, // 5 minutes (LLM calls can be slow)
    defaultRetries: 2,
  },

  'evaluate-policy': {
    type: 'evaluate-policy',
    name: 'Evaluate Policy',
    description: 'Check policy rules against metric results for the session',
    configSchema: {
      type: 'object',
      properties: {
        policyId: {
          type: 'string',
          description: 'ID of the policy to evaluate',
        },
      },
      required: ['policyId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['PASS', 'FAIL', 'INCONCLUSIVE'] },
        summary: {
          type: 'object',
          properties: {
            passed: { type: 'number' },
            failed: { type: 'number' },
            inconclusive: { type: 'number' },
          },
        },
        violations: { type: 'array' },
      },
    },
    defaultTimeout: 120_000, // 2 minutes
    defaultRetries: 2,
  },

  'store-results': {
    type: 'store-results',
    name: 'Store Results',
    description: 'Write pipeline step outputs to ClickHouse, MongoDB, or an HTTP callback',
    configSchema: {
      type: 'object',
      properties: {
        destination: {
          type: 'string',
          enum: ['clickhouse', 'mongodb', 'callback'],
          description: 'Where to write results',
        },
        table: { type: 'string', description: 'ClickHouse table name' },
        collection: { type: 'string', description: 'MongoDB collection name' },
        callbackUrl: { type: 'string', description: 'HTTP POST URL for callback' },
        includeSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Step IDs to include. If omitted, includes all.',
        },
      },
      required: ['destination'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        rowsWritten: { type: 'number' },
        destination: { type: 'string' },
      },
    },
    defaultTimeout: 60_000, // 1 minute
    defaultRetries: 3,
  },

  'send-notification': {
    type: 'send-notification',
    name: 'Send Notification',
    description: 'Send an alert via Slack, email, webhook, or WebSocket broadcast',
    configSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['slack', 'email', 'webhook', 'websocket'],
        },
        webhookUrl: { type: 'string', description: 'Slack/generic webhook URL' },
        to: { type: 'string', description: 'Email address(es)' },
        subject: { type: 'string', description: 'Email subject or title' },
        messageTemplate: {
          type: 'string',
          description: 'Template with {{steps.stepId.output.field}} interpolation',
        },
      },
      required: ['channel'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        channel: { type: 'string' },
      },
    },
    defaultTimeout: 30_000, // 30 seconds
    defaultRetries: 2,
  },

  transform: {
    type: 'transform',
    name: 'Transform Data',
    description: 'Reshape data between steps — combine, extract, or rename fields',
    configSchema: {
      type: 'object',
      properties: {
        mapping: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Output field → expression mapping',
        },
      },
      required: ['mapping'],
    },
    outputSchema: {
      type: 'object',
      description: 'Shape determined by the mapping config',
    },
    defaultTimeout: 10_000, // 10 seconds
    defaultRetries: 1,
  },

  'run-legacy-workflow': {
    type: 'run-legacy-workflow',
    name: 'Run Legacy Temporal Workflow',
    description:
      'Bridge: start an existing Temporal workflow and wait for result (migration period)',
    configSchema: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          enum: ['evaluateSessionMetrics', 'evaluateSessionPolicies'],
          description: 'System workflow to execute',
        },
        taskQueue: {
          type: 'string',
          description: 'Temporal task queue override',
        },
      },
      required: ['workflow'],
    },
    outputSchema: {
      type: 'object',
      description: 'Output shape depends on which system workflow is executed',
    },
    defaultTimeout: 1_800_000, // 30 minutes
    defaultRetries: 1,
  },
};

/** Get metadata for a specific activity type. Used for validation. */
export function getActivityMetadata(type: string): ActivityTypeMetadata | undefined {
  return ACTIVITY_TYPES[type];
}

/** List all activity types. Used by GET /pipeline-activities API. */
export function listActivityTypes(): ActivityTypeMetadata[] {
  return Object.values(ACTIVITY_TYPES);
}
```

### 7.2 EvaluateMetrics Service

```typescript
// packages/workflow-engine/src/pipeline/services/evaluate-metrics.service.ts

import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types';

export const evaluateMetricsService = restate.service({
  name: 'EvaluateMetrics',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      // All external I/O wrapped in ctx.run() for journal durability
      const results = await ctx.run('evaluate', async () => {
        const svc = getMetricsEvaluationService();
        return svc.evaluate({
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          metrics: input.config.metrics,
          model: input.config.model,
        });
      });

      return {
        status: 'success',
        data: {
          scores: results.scores,
          details: results.details,
          status: 'success',
        },
      };
    },
  },
});
```

### 7.3 EvaluatePolicy Service

```typescript
// packages/workflow-engine/src/pipeline/services/evaluate-policy.service.ts

import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types';

export const evaluatePolicyService = restate.service({
  name: 'EvaluatePolicy',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const result = await ctx.run('evaluate-policy', async () => {
        const svc = getPolicyEvaluationService();
        return svc.evaluatePolicy({
          tenantId: input.tenantId,
          projectId: input.projectId,
          sessionId: input.sessionId,
          policyId: input.config.policyId,
          metricScores: extractMetricScores(input.previousSteps),
        });
      });

      return {
        status: result.summary.failed > 0 ? 'fail' : 'success',
        data: {
          status: result.status,
          summary: result.summary,
          violations: result.violations,
        },
      };
    },
  },
});

/**
 * Collect scores from any previous evaluate-metrics steps.
 * Avoids re-fetching from ClickHouse when policy evaluation follows metrics.
 */
function extractMetricScores(
  previousSteps: Record<string, StepOutput>,
): Record<string, number> | undefined {
  const scores: Record<string, number> = {};
  for (const output of Object.values(previousSteps)) {
    if (output.data?.scores) {
      Object.assign(scores, output.data.scores);
    }
  }
  return Object.keys(scores).length > 0 ? scores : undefined;
}
```

### 7.4 StoreResults Service

```typescript
// packages/workflow-engine/src/pipeline/services/store-results.service.ts

import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types';

export const storeResultsService = restate.service({
  name: 'StoreResults',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { destination, includeSteps, table, collection, callbackUrl } = input.config;

      // Filter step outputs if includeSteps is specified
      const stepsToInclude = includeSteps
        ? Object.fromEntries(
            Object.entries(input.previousSteps).filter(([id]) => includeSteps.includes(id)),
          )
        : input.previousSteps;

      const payload = {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        pipelineInput: input.pipelineInput,
        stepOutputs: stepsToInclude,
        timestamp: new Date().toISOString(),
      };

      switch (destination) {
        case 'clickhouse': {
          const rowsWritten = await ctx.run('write-clickhouse', async () => {
            const ch = getClickHouseService();
            const rows = transformForClickHouse(payload, table);
            await ch.insert(table, rows);
            return rows.length;
          });
          return {
            status: 'success',
            data: { rowsWritten, destination: 'clickhouse' },
          };
        }

        case 'mongodb': {
          await ctx.run('write-mongodb', async () => {
            const db = getMongoDb();
            await db.collection(collection).insertOne(payload);
          });
          return {
            status: 'success',
            data: { rowsWritten: 1, destination: 'mongodb' },
          };
        }

        case 'callback': {
          await ctx.run('post-callback', async () => {
            const response = await fetch(callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              throw new Error(`Callback failed: ${response.status} ${response.statusText}`);
            }
          });
          return {
            status: 'success',
            data: { rowsWritten: 1, destination: 'callback' },
          };
        }

        default:
          return {
            status: 'fail',
            data: { error: `Unknown destination: ${destination}` },
          };
      }
    },
  },
});
```

### 7.5 SendNotification Service

```typescript
// packages/workflow-engine/src/pipeline/services/send-notification.service.ts

import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types';

export const sendNotificationService = restate.service({
  name: 'SendNotification',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { channel } = input.config;
      const message = buildMessage(input);

      await ctx.run(`send-${channel}`, async () => {
        switch (channel) {
          case 'slack':
            await sendSlack(input.config.webhookUrl, message);
            break;
          case 'email':
            await sendEmail(input.config.to, input.config.subject, message);
            break;
          case 'webhook':
            await sendWebhook(input.config.webhookUrl, {
              ...input.pipelineInput,
              stepOutputs: input.previousSteps,
            });
            break;
          case 'websocket':
            await broadcastWebSocket(input.config.websocketChannel ?? input.sessionId, {
              type: 'pipeline-notification',
              data: input.previousSteps,
            });
            break;
        }
      });

      return { status: 'success', data: { sent: true, channel } };
    },
  },
});

function buildMessage(input: PipelineStepContext): string {
  if (input.config.messageTemplate) {
    return interpolateTemplate(input.config.messageTemplate, input.previousSteps);
  }
  // Auto-generate summary from step outputs
  const stepSummaries = Object.entries(input.previousSteps)
    .filter(([_, o]) => o.status !== 'skipped')
    .map(([id, o]) => `${id}: ${o.status}`)
    .join('\n');
  return `Pipeline completed.\n${stepSummaries}`;
}
```

### 7.6 Transform Service

```typescript
// packages/workflow-engine/src/pipeline/services/transform.service.ts

import * as restate from '@restatedev/restate-sdk';
import { resolveExpression } from '../expression-evaluator';
import type { PipelineStepContext, StepOutput } from '../types';

export const transformService = restate.service({
  name: 'Transform',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const result: Record<string, any> = {};

      for (const [outputField, expression] of Object.entries(input.config.mapping)) {
        result[outputField] = resolveExpression(expression as string, input.previousSteps);
      }

      return { status: 'success', data: result };
    },
  },
});
```

### 7.7 RunLegacyWorkflow Service (Temporal Bridge)

```typescript
// packages/workflow-engine/src/pipeline/services/run-legacy-workflow.service.ts

import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types';

const SYSTEM_TASK_QUEUES: Record<string, string> = {
  evaluateSessionMetrics: 'metrics-evaluation',
  evaluateSessionPolicies: 'policy-evaluation',
};

/**
 * Bridge activity: starts an existing Temporal workflow and waits for result.
 * Used during the migration period to compose system workflows into custom pipelines.
 *
 * Once a system workflow is migrated to a Restate service, steps using this
 * activity type get replaced with the direct Restate service type.
 */
export const runLegacyWorkflowService = restate.service({
  name: 'RunLegacyWorkflow',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { workflow, taskQueue } = input.config;

      // Start Temporal workflow and wait for result.
      // Wrapped in ctx.run() — this is a side effect that must be journaled.
      const result = await ctx.run('run-temporal-workflow', async () => {
        const client = getTemporalClient();
        const handle = await client.workflow.start(workflow, {
          args: [
            {
              tenantId: input.tenantId,
              projectId: input.projectId,
              sessionId: input.sessionId,
            },
          ],
          taskQueue: taskQueue ?? SYSTEM_TASK_QUEUES[workflow],
          workflowId: `bridge-${workflow}-${Date.now()}`,
          workflowExecutionTimeout: '30m',
        });
        return handle.result();
      });

      return { status: 'success', data: result };
    },
  },
});
```

### 7.8 Adding New Activity Types

Adding a new activity type is a 3-step process:

**Step 1:** Add metadata to `ACTIVITY_TYPES` in `activity-metadata.ts`:

```typescript
"http-request": {
  type: "http-request",
  name: "HTTP Request",
  description: "Call an external API",
  configSchema: { /* ... */ },
  outputSchema: { /* ... */ },
  defaultTimeout: 30_000,
  defaultRetries: 2,
},
```

**Step 2:** Create a Restate service in `services/`:

```typescript
export const httpRequestService = restate.service({
  name: 'HttpRequest',
  handlers: {
    execute: async (ctx, input) => {
      /* ... */
    },
  },
});
```

**Step 3:** Register it in `server.ts` and add a case to `ActivityRouter`:

```typescript
// server.ts
server.bind(httpRequestService);

// activity-router.service.ts
case "http-request":
  return await ctx.serviceClient(httpRequestService).execute(stepContext);
```

Deploy. Tenant admins can immediately use `"type": "http-request"` in pipeline definitions. The UI pipeline builder automatically shows it in the activity palette.

---

## 8. Expression Evaluator

Safe evaluator for condition expressions. No `eval()`, no `new Function()`, no arbitrary code execution.

### 8.1 Supported Syntax

```
Property access:  steps.stepId.output.field
                  steps.stepId.output.nested.deep.field
Comparison:       ==  !=  >  <  >=  <=
Logical:          &&  ||  !
Literals:         'string'  42  3.14  true  false  null
Grouping:         ( ... )
```

### 8.2 Not Supported (Rejected at Save Time)

```
Assignment:       =
Function calls:   foo()
Keywords:         new, delete, typeof, void, import, require, eval
Bracket access:   obj['key']  (dot notation only)
Arithmetic:       +  -  *  /  % (conditions are boolean, not arithmetic)
Bitwise:          &  |  ^  ~  <<  >>
```

### 8.3 Implementation

```typescript
// packages/workflow-engine/src/pipeline/expression-evaluator.ts

import type { StepOutput } from './types';

/**
 * Evaluate a condition expression against step outputs.
 * Returns true if the step should run, false if it should be skipped.
 */
export function evaluateExpression(
  expression: string,
  stepOutputs: Record<string, StepOutput>,
): boolean {
  const context = {
    steps: Object.fromEntries(
      Object.entries(stepOutputs).map(([id, output]) => [
        id,
        { output: { ...output.data, status: output.status } },
      ]),
    ),
  };

  return safeEval(expression, context);
}

/**
 * Resolve a dot-path expression to a value.
 * Used by the Transform activity to map fields between steps.
 *
 * "steps.eval-safety.output.scores.toxicity" → 0.9
 */
export function resolveExpression(
  expression: string,
  stepOutputs: Record<string, StepOutput>,
): any {
  const context = {
    steps: Object.fromEntries(
      Object.entries(stepOutputs).map(([id, output]) => [
        id,
        { output: { ...output.data, status: output.status } },
      ]),
    ),
  };

  return resolveDotPath(expression, context);
}

/**
 * Validate that an expression only uses supported operations.
 * Called at pipeline save time — rejects expressions before execution.
 */
export function isSafeExpression(expression: string): boolean {
  const forbidden = [
    /\bfunction\b/,
    /\bnew\b/,
    /\bdelete\b/,
    /\btypeof\b/,
    /\bvoid\b/,
    /\bimport\b/,
    /\brequire\b/,
    /\beval\b/,
    /\bwindow\b/,
    /\bglobal\b/,
    /\bprocess\b/,
    /\bconstructor\b/,
    /\b__proto__\b/,
    /\bprototype\b/,
    /\[/,
    /\]/, // no bracket access
    /[+\-*/%](?!=)/, // no arithmetic (but allow !=, >=, <=)
    /[&|^~](?![&|])/, // no bitwise (but allow && and ||)
    /<</,
    />>/, // no bit shift
  ];

  for (const pattern of forbidden) {
    if (pattern.test(expression)) {
      return false;
    }
  }
  return true;
}

/**
 * Extract step IDs referenced in an expression.
 * Used at validation time to ensure referenced steps exist
 * and appear earlier in the array.
 *
 * "steps.check-policy.output.status == 'FAIL'" → ['check-policy']
 */
export function extractStepReferences(expression: string): string[] {
  const matches = expression.matchAll(/steps\.([a-zA-Z0-9_-]+)\./g);
  return [...new Set(Array.from(matches, (m) => m[1]))];
}
```

---

## 9. Validation

### 9.1 Pipeline Validation on Save

```typescript
// packages/workflow-engine/src/pipeline/validation.ts

import { ACTIVITY_TYPES } from './activity-metadata';
import { isSafeExpression, extractStepReferences } from './expression-evaluator';

export interface ValidationError {
  step?: string;
  index?: number;
  message: string;
}

/**
 * Validate a pipeline definition before saving.
 * Called on POST (create) and PATCH (update).
 * Returns an array of errors. Empty array = valid.
 */
export function validatePipeline(definition: PipelineDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const stepIds = new Set<string>();
  const stepIdOrder: string[] = [];

  // 1. Must have at least one step
  if (!definition.steps || definition.steps.length === 0) {
    errors.push({ message: 'Pipeline must have at least one step' });
    return errors;
  }

  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i];

    // 2. Step IDs must be unique
    if (stepIds.has(step.id)) {
      errors.push({
        step: step.id,
        index: i,
        message: `Duplicate step ID: '${step.id}'`,
      });
    }
    stepIds.add(step.id);
    stepIdOrder.push(step.id);

    // 3. Activity type must exist
    if (!ACTIVITY_TYPES[step.type]) {
      errors.push({
        step: step.id,
        index: i,
        message: `Unknown activity type: '${step.type}'. Available: ${Object.keys(ACTIVITY_TYPES).join(', ')}`,
      });
      continue; // skip config validation if type unknown
    }

    // 4. Step config must match activity's configSchema
    const metadata = ACTIVITY_TYPES[step.type];
    const configErrors = validateJsonSchema(step.config, metadata.configSchema);
    for (const err of configErrors) {
      errors.push({
        step: step.id,
        index: i,
        message: `Config: ${err}`,
      });
    }

    // 5. Condition validation
    if (step.condition) {
      // 5a. Expression must be safe
      if (!isSafeExpression(step.condition.expression)) {
        errors.push({
          step: step.id,
          index: i,
          message: 'Condition expression contains unsupported operations',
        });
      }

      // 5b. Referenced step IDs must exist and appear EARLIER
      const referencedIds = extractStepReferences(step.condition.expression);
      for (const refId of referencedIds) {
        if (!stepIds.has(refId)) {
          errors.push({
            step: step.id,
            index: i,
            message: `Condition references unknown step: '${refId}'`,
          });
        }
        const refIndex = stepIdOrder.indexOf(refId);
        if (refIndex >= i) {
          errors.push({
            step: step.id,
            index: i,
            message: `Condition references step '${refId}' which is not before this step`,
          });
        }
      }
    }
  }

  // 6. Parallel groups must be contiguous
  const parallelGroups = new Map<string, number[]>();
  definition.steps.forEach((step, i) => {
    if (step.parallel) {
      if (!parallelGroups.has(step.parallel)) {
        parallelGroups.set(step.parallel, []);
      }
      parallelGroups.get(step.parallel)!.push(i);
    }
  });

  for (const [group, indices] of parallelGroups) {
    for (let j = 1; j < indices.length; j++) {
      if (indices[j] !== indices[j - 1] + 1) {
        errors.push({
          message: `Parallel group '${group}' is not contiguous — steps must be adjacent`,
        });
        break;
      }
    }
  }

  // 7. Trigger validation
  if (definition.trigger) {
    if (definition.trigger.type === 'kafka' && !definition.trigger.kafkaTopic) {
      errors.push({ message: 'Kafka trigger requires kafkaTopic' });
    }
    if (definition.trigger.type === 'schedule' && !definition.trigger.schedule) {
      errors.push({ message: 'Schedule trigger requires schedule (cron)' });
    }
  }

  return errors;
}
```

---

## 10. Pipeline Management & Invocation

### 10.1 Invocation Model — Internal Only

Pipelines are **not** invoked via REST APIs. All invocation is internal:

| Trigger          | How It Works                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Kafka events** | Restate's native Kafka subscription routes messages to `PipelineTrigger.handleEvent`. No custom consumer code. |
| **Schedules**    | `PipelineScheduler` virtual object uses Restate's durable sleep + self-invocation. No external cron.           |
| **Programmatic** | Any service imports `@agent-platform/workflow-engine` and calls the Restate client SDK directly.               |

**Programmatic invocation example:**

```typescript
import { getRestateClient, pipelineRun } from '@agent-platform/workflow-engine';

// Start a pipeline run directly via Restate SDK
const client = getRestateClient();
const runId = `${pipelineId}-${Date.now()}`;

await client.workflowClient(pipelineRun, runId).run({
  pipelineDefinition: pipeline,
  pipelineInput: { tenantId, projectId, sessionId },
});
```

**Querying run status:**

```typescript
// Live status from Restate (running workflows)
const status = await client.workflowClient(pipelineRun, runId).getStatus();
// Returns: { status, steps, startedAt, completedAt }

// Completed runs from MongoDB (persisted after workflow finishes)
const record = await PipelineRunRecord.findOne({ runId, tenantId });
```

### 10.2 Pipeline CRUD — Studio API Routes

Pipeline definitions are managed through Studio's Next.js API routes. This is where admins create, edit, activate, and monitor pipelines via the UI pipeline builder.

**Routes:**

```
apps/studio/src/app/api/pipelines/

POST   /api/pipelines
  Create a new pipeline definition.
  Body: { name, description?, trigger, steps, inputSchema?, projectId? }
  Status defaults to 'draft'.
  Validates using validatePipeline() from @agent-platform/workflow-engine.

GET    /api/pipelines
  List pipeline definitions for the tenant (from auth context).
  Query params: status, projectId, trigger.type, page, limit

GET    /api/pipelines/:pipelineId
  Get a single pipeline definition.

PATCH  /api/pipelines/:pipelineId
  Update a pipeline definition.
  Auto-increments version. Re-validates.
  Cannot update 'active' pipeline — deactivate first, or clone.

DELETE /api/pipelines/:pipelineId
  Soft delete → status: 'archived'.

POST   /api/pipelines/:pipelineId/activate
  draft → active.
  Re-validates before activating.
  Kafka triggers: registers Restate Kafka subscription via admin API.
  Schedule triggers: starts PipelineScheduler virtual object via Restate SDK.

POST   /api/pipelines/:pipelineId/deactivate
  active → archived.
  Removes Kafka subscriptions / stops scheduler.
  Running executions continue to completion.

POST   /api/pipelines/:pipelineId/clone
  Clone as new draft. New name: "Copy of {original}".

GET    /api/pipelines/:pipelineId/runs
  List runs for a pipeline.
  Completed runs from MongoDB. Running runs queried from Restate.

GET    /api/pipelines/runs/:runId
  Get run detail (hybrid: Restate for live, MongoDB for completed).

POST   /api/pipelines/runs/:runId/cancel
  Cancel a running execution via Restate's workflow cancel.

GET    /api/pipelines/activities
  Returns listActivityTypes() from the static metadata registry.
  Used by the UI pipeline builder for the activity palette + config forms.
```

### 10.3 Studio → Workflow Engine Integration

Studio imports from `@agent-platform/workflow-engine` for validation, metadata, and Restate client access:

```typescript
// apps/studio/src/app/api/pipelines/route.ts

import {
  validatePipeline,
  listActivityTypes,
  getRestateClient,
  pipelineScheduler,
} from '@agent-platform/workflow-engine';

export async function POST(req: Request) {
  const body = await req.json();
  const { tenantId } = getAuthContext(req);

  // Validate using the workflow engine's validation
  const errors = validatePipeline(body);
  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  // Save to MongoDB
  const pipeline = await PipelineDefinition.create({
    ...body,
    tenantId,
    version: 1,
    status: 'draft',
    createdBy: getUserId(req),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return Response.json(pipeline, { status: 201 });
}
```

```typescript
// apps/studio/src/app/api/pipelines/[pipelineId]/activate/route.ts

export async function POST(req: Request, { params }) {
  const { tenantId } = getAuthContext(req);
  const pipeline = await PipelineDefinition.findOne({
    _id: params.pipelineId,
    tenantId,
  });

  // Re-validate before activating
  const errors = validatePipeline(pipeline);
  if (errors.length > 0) {
    return Response.json({ errors }, { status: 400 });
  }

  // For schedule triggers, start the Restate scheduler
  if (pipeline.trigger.type === 'schedule') {
    const client = getRestateClient();
    await client.objectClient(pipelineScheduler, pipeline._id.toString()).start({
      pipelineId: pipeline._id.toString(),
      tenantId,
      cronExpression: pipeline.trigger.schedule,
    });
  }

  // For Kafka triggers, register Restate subscription via admin API
  if (pipeline.trigger.type === 'kafka') {
    await registerKafkaSubscription(pipeline.trigger.kafkaTopic);
  }

  await PipelineDefinition.updateOne(
    { _id: params.pipelineId, tenantId },
    { status: 'active', updatedAt: new Date() },
  );

  return Response.json({ status: 'active' });
}
```

### 10.4 Run Status Query (Hybrid: Restate + MongoDB)

```typescript
// Shared utility used by Studio API routes

import { getRestateClient, pipelineRun } from '@agent-platform/workflow-engine';

async function getRunStatus(tenantId: string, runId: string): Promise<PipelineRunState | null> {
  // Try MongoDB first (completed runs are persisted here)
  const record = await PipelineRunRecord.findOne({ runId, tenantId });

  if (record && record.status !== 'running') {
    return record;
  }

  // Still running — query Restate for live state
  try {
    const client = getRestateClient();
    const status = await client.workflowClient(pipelineRun, runId).getStatus();

    return {
      runId,
      tenantId,
      status: status.status,
      steps: status.steps,
      startedAt: status.startedAt,
      completedAt: status.completedAt,
      ...(record ? { trigger: record.trigger, input: record.input } : {}),
    };
  } catch {
    // Workflow not found in Restate (already cleaned up)
    return record ?? null;
  }
}
```

### 10.5 Permissions

| Action                                      | Permission Key             | Typical Roles                |
| ------------------------------------------- | -------------------------- | ---------------------------- |
| Create, update, delete pipeline definitions | `MANAGE_PIPELINES`         | Project Admin, Account Admin |
| Activate / deactivate pipelines             | `MANAGE_PIPELINES`         | Project Admin, Account Admin |
| View pipeline definitions and runs          | `VIEW_PIPELINES`           | All project members          |
| Cancel running executions                   | `MANAGE_PIPELINES`         | Project Admin, Account Admin |
| View activity registry                      | _(any authenticated user)_ | Everyone                     |

---

## 11. Infrastructure & Deployment

### 11.1 Docker Compose — Restate Dev Environment

```yaml
# apps/amp-docker/docker-compose.restate.yml

services:
  restate:
    image: docker.io/restatedev/restate:1.3
    container_name: restate
    ports:
      - '8080:8080' # Ingress (clients call this)
      - '9070:9070' # Admin (service registration, subscriptions)
      - '9071:9071' # Admin HTTP/2
    volumes:
      - restate-data:/target/restate-data
      - ./infrastructure/restate/restate.toml:/restate.toml
    environment:
      - RESTATE_OBSERVABILITY__LOG__FORMAT=Json
    networks:
      - amp-network
    restart: unless-stopped

  pipeline-worker:
    build:
      context: ../..
      dockerfile: apps/amp-docker/Dockerfile-pipeline-worker
    container_name: pipeline-worker
    ports:
      - '9080:9080' # Restate service endpoint
    environment:
      - RESTATE_INGRESS_URL=http://restate:8080
      - MONGODB_URI=mongodb://mongodb:27017/acp
      - CLICKHOUSE_HOST=clickhouse
      - CLICKHOUSE_PORT=8123
      - TEMPORAL_ADDRESS=temporal:7233 # bridge to legacy workflows
      - KAFKA_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092
      - REDIS_URL=redis://redis-node-1:6379
    depends_on:
      - restate
      - mongodb
      - clickhouse
      - kafka-1
    networks:
      - amp-network
    restart: unless-stopped

volumes:
  restate-data:
```

### 11.2 Restate Kafka Cluster Configuration

```toml
# apps/amp-docker/infrastructure/restate/restate.toml

[kafka-clusters.acp-cluster]
brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"]
```

### 11.3 Service Registration Script

```bash
#!/bin/bash
# scripts/restate/register.sh

RESTATE_ADMIN="${RESTATE_ADMIN_URL:-http://restate:9070}"
PIPELINE_WORKER="${PIPELINE_WORKER_URL:-http://pipeline-worker:9080}"

echo "Registering pipeline worker with Restate..."

# 1. Register the service endpoint (discovers all bound services)
curl -s -X POST "$RESTATE_ADMIN/deployments" \
  -H "content-type: application/json" \
  -d "{\"uri\": \"$PIPELINE_WORKER\"}"

echo "Service endpoint registered."

# 2. Add Kafka subscriptions for pipeline triggering
TOPICS=(
  "acp.session.processed.standard"
  "acp.metrics.evaluated.standard"
  "acp.policy.violations.standard"
  "acp.telemetry.processed.standard"
)

for TOPIC in "${TOPICS[@]}"; do
  echo "Adding Kafka subscription: $TOPIC → PipelineTrigger/handleEvent"
  curl -s -X POST "$RESTATE_ADMIN/subscriptions" \
    -H "content-type: application/json" \
    -d "{
      \"source\": \"kafka://acp-cluster/$TOPIC\",
      \"sink\": \"service://PipelineTrigger/handleEvent\",
      \"options\": {\"auto.offset.reset\": \"latest\"}
    }"
done

echo "Kafka subscriptions registered."
```

### 11.4 Migration Period Architecture

During migration, Temporal and Restate coexist:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Network                            │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Temporal      │    │ Restate       │    │ Kafka Cluster │      │
│  │ (legacy)      │    │ (new)         │    │ (shared)      │      │
│  │ :7233         │    │ :8080 ingress │    │ :9092         │      │
│  │               │    │ :9070 admin   │    │               │      │
│  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘      │
│          │                    │                     │              │
│          │                    │        subscribes   │              │
│          │                    │◄────────────────────┘              │
│          │                    │                                    │
│  ┌───────┴───────┐    ┌──────┴────────┐                          │
│  │ System Workers │    │ Pipeline      │                          │
│  │ (legacy)       │    │ Worker        │                          │
│  │                │    │ (Restate svc) │                          │
│  │ • metrics-eval │    │ :9080         │                          │
│  │ • policy-eval  │    │               │─── bridge call ─────┐   │
│  │ • processing   │    │ • PipelineRun │                     │   │
│  │ • alert        │    │ • Activities  │                     │   │
│  └────────────────┘    │ • Trigger     │                     │   │
│          ▲             │ • Scheduler   │                     │   │
│          │             └───────────────┘                     │   │
│          │                                                   │   │
│          └───────────────────────────────────────────────────┘   │
│       RunLegacyWorkflow calls Temporal                           │
│       during migration period                                    │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ MongoDB   │  │ClickHouse│  │ Redis     │  │ Studio    │       │
│  │ (defs,    │  │ (metrics,│  │ (cache)   │  │ (CRUD UI) │       │
│  │  runs)    │  │  traces) │  │           │  │           │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### 11.5 Post-Migration Architecture

After all system workflows are migrated to Restate services:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Network                            │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐                          │
│  │ Restate       │    │ Kafka Cluster │                          │
│  │ :8080 ingress │    │ :9092         │                          │
│  │ :9070 admin   │    │               │                          │
│  └───────┬───────┘    └───────┬───────┘                          │
│          │                     │                                  │
│          │        subscribes   │                                  │
│          │◄────────────────────┘                                  │
│          │                                                        │
│  ┌───────┴─────────────────────────────────┐                    │
│  │ Pipeline Worker (Restate service)        │                    │
│  │ :9080                                    │                    │
│  │                                          │                    │
│  │ Workflows:                               │                    │
│  │ • PipelineRun (custom DAG interpreter)   │                    │
│  │                                          │                    │
│  │ Services (all evaluation logic):         │                    │
│  │ • EvaluateMetrics (ex-system workflow)   │                    │
│  │ • EvaluatePolicy  (ex-system workflow)   │                    │
│  │ • ProcessTelemetry (ex-system workflow)  │                    │
│  │ • EmailDigest (ex-system workflow)       │                    │
│  │ • StoreResults                           │                    │
│  │ • SendNotification                       │                    │
│  │ • Transform                              │                    │
│  │                                          │                    │
│  │ Handlers:                                │                    │
│  │ • PipelineTrigger (Kafka events)         │                    │
│  │ • PipelineScheduler (cron loops)         │                    │
│  └──────────────────────────────────────────┘                    │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ MongoDB   │  │ClickHouse│  │ Redis     │  │ Studio    │       │
│  │           │  │           │  │           │  │ (CRUD UI) │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

**Removed**: Temporal server, PostgreSQL (Temporal backend), 4 system workers.
**Net result**: -5 containers, -1 database, -1 package.

---

## 12. Multi-Platform Consumption

### 12.1 The Problem

AMP workflows write to AMP's stores. abl-platform needs to trigger evaluation but route results to its own stores. The activities determine the destination, not the caller.

### 12.2 How the Pipeline Engine Solves This

The pipeline definition itself controls output routing via the `store-results` step config. Two pipelines can run the same evaluation logic but write to different destinations.

**AMP tenant's pipeline — stores to ClickHouse:**

```json
{
  "tenantId": "amp-tenant-001",
  "trigger": { "type": "kafka", "kafkaTopic": "acp.session.processed.standard" },
  "steps": [
    { "id": "eval", "type": "evaluate-metrics", "config": { "metrics": ["toxicity"] } },
    {
      "id": "store",
      "type": "store-results",
      "config": { "destination": "clickhouse", "table": "trace_metrics" }
    }
  ]
}
```

**abl-platform's pipeline — stores via HTTP callback:**

```json
{
  "tenantId": "abl-tenant-001",
  "trigger": { "type": "manual" },
  "steps": [
    { "id": "eval", "type": "evaluate-metrics", "config": { "metrics": ["accuracy"] } },
    {
      "id": "store",
      "type": "store-results",
      "config": { "destination": "callback", "callbackUrl": "http://runtime:3100/api/eval-results" }
    }
  ]
}
```

Same `evaluate-metrics` service. Same `store-results` service. Same pipeline worker. Different config → different destination.

### 12.3 How abl-platform Triggers Pipelines

**Via Restate client SDK (internal):**

```typescript
import { getRestateClient, pipelineRun } from '@agent-platform/workflow-engine';

// Load pipeline definition from MongoDB
const pipeline = await PipelineDefinition.findOne({
  _id: pipelineId,
  tenantId: 'abl-tenant-001',
  status: 'active',
});

// Start directly via Restate SDK — no REST API needed
const client = getRestateClient();
const runId = `${pipeline._id}-${Date.now()}`;

await client.workflowClient(pipelineRun, runId).run({
  pipelineDefinition: pipeline,
  pipelineInput: {
    tenantId: 'abl-tenant-001',
    projectId: 'p-456',
    sessionId: 's-789',
  },
});
```

**Receiving results via HTTP callback:**

```typescript
// abl-platform route handler
app.post('/api/eval-results', async (req, res) => {
  const { tenantId, projectId, sessionId, stepOutputs } = req.body;

  await ablDatabase.insert('evaluation_results', {
    tenantId,
    projectId,
    sessionId,
    results: stepOutputs,
    evaluatedAt: new Date(),
  });

  ablEventBus.emit('evaluation:complete', { tenantId, projectId, sessionId });
  res.sendStatus(200);
});
```

---

## 13. File Locations

```
packages/workflow-engine/
  ├── package.json
  ├── tsconfig.json
  ├── src/
  │   ├── index.ts                              # Public exports
  │   ├── client.ts                             # getRestateClient() for API layer
  │   │
  │   ├── pipeline/
  │   │   ├── types.ts                          # PipelineStepContext, StepOutput,
  │   │   │                                     # PipelineStep, PipelineRunInput,
  │   │   │                                     # PipelineDefinition, PipelineRunState
  │   │   │
  │   │   ├── activity-metadata.ts              # ACTIVITY_TYPES registry (static)
  │   │   │                                     # ActivityTypeMetadata interface
  │   │   │                                     # listActivityTypes(), getActivityMetadata()
  │   │   │
  │   │   ├── expression-evaluator.ts           # evaluateExpression()
  │   │   │                                     # resolveExpression()
  │   │   │                                     # isSafeExpression()
  │   │   │                                     # extractStepReferences()
  │   │   │
  │   │   ├── validation.ts                     # validatePipeline()
  │   │   │
  │   │   ├── handlers/
  │   │   │   ├── pipeline-run.workflow.ts       # PipelineRun workflow (DAG interpreter)
  │   │   │   ├── pipeline-trigger.service.ts    # PipelineTrigger (Kafka + manual)
  │   │   │   ├── pipeline-scheduler.ts          # PipelineScheduler (cron via sleep)
  │   │   │   └── activity-router.service.ts     # ActivityRouter (step dispatch)
  │   │   │
  │   │   ├── services/
  │   │   │   ├── evaluate-metrics.service.ts    # EvaluateMetrics
  │   │   │   ├── evaluate-policy.service.ts     # EvaluatePolicy
  │   │   │   ├── store-results.service.ts       # StoreResults
  │   │   │   ├── send-notification.service.ts   # SendNotification
  │   │   │   ├── transform.service.ts           # Transform
  │   │   │   └── run-legacy-workflow.service.ts  # Temporal bridge (migration)
  │   │   │
  │   │   ├── server.ts                         # Restate endpoint — binds all handlers
  │   │   │
  │   │   └── utils/
  │   │       └── cron.ts                       # getNextCronTime() helper
  │   │
  │   └── __tests__/
  │       ├── expression-evaluator.test.ts
  │       ├── validation.test.ts
  │       ├── pipeline-run.test.ts
  │       └── activity-router.test.ts
  │
  └── schemas/
      ├── pipeline-definition.schema.ts         # Mongoose schema
      └── pipeline-run-record.schema.ts         # Mongoose schema

apps/studio/src/app/api/pipelines/
  ├── route.ts                                  # GET (list), POST (create)
  ├── activities/
  │   └── route.ts                              # GET /api/pipelines/activities (registry)
  ├── runs/
  │   └── [runId]/
  │       ├── route.ts                          # GET run detail
  │       └── cancel/route.ts                   # POST cancel
  └── [pipelineId]/
      ├── route.ts                              # GET, PATCH, DELETE
      ├── activate/route.ts                     # POST activate
      ├── deactivate/route.ts                   # POST deactivate
      ├── clone/route.ts                        # POST clone
      └── runs/route.ts                         # GET runs for pipeline

apps/studio/src/lib/
  └── pipeline-service.ts                       # Shared service: validation, Restate client,
                                                # hybrid run queries (Restate + MongoDB)

apps/amp-docker/
  ├── docker-compose.restate.yml                # Restate server + pipeline worker
  ├── infrastructure/restate/
  │   └── restate.toml                          # Kafka cluster config
  └── scripts/restate/
      └── register.sh                           # Service + subscription registration
```

---

## 14. Migration Plan (High-Level)

### Phase 1: Pipeline Engine on Restate

1. Create `packages/workflow-engine/` package
2. Implement core handlers: PipelineRun, ActivityRouter, PipelineTrigger
3. Implement activity services with Temporal bridge
4. Add pipeline CRUD API routes to Studio (`apps/studio/src/app/api/pipelines/`)
5. Add docker-compose.restate.yml
6. Integration tests with Restate test utilities

### Phase 2: Migrate System Workflows

For each system workflow (metrics → policy → processing → alert):

1. Extract business logic from Temporal activities into shared functions
2. Create Restate service handler that calls the shared functions
3. Update pipeline definitions: `run-legacy-workflow` → direct service type
4. Verify with integration tests
5. Remove Temporal worker for that workflow

### Phase 3: Remove Temporal

1. Remove `packages/amp-temporal/` (legacy)
2. Remove `run-legacy-workflow` service and activity metadata
3. Remove Temporal server + PostgreSQL from docker-compose
4. Remove `@temporalio/client` dependency from `@agent-platform/workflow-engine`
5. Update deployment configs

### Phase 4: v2 Activity Types

Add new activity types as needed:

- `http-request` — call external APIs
- `filter` — complex gating logic
- `aggregate` — combine multiple step outputs
- `delay` — rate limiting / eventual consistency
- `fan-out` — run same activity N times with different inputs
