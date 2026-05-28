# Custom Pipeline Engine — Design Document

## Date: 2026-02-26

---

## 1. Problem Statement

### 1.1 Current State — Hardcoded Workflows

AMP has 3 hardcoded Temporal workflows. The orchestration logic is fixed at compile time:

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

### 1.4 What This Design Solves

- Tenant admins can design custom evaluation pipelines without deploying code
- Developers can add new activity types (building blocks) that admins immediately use
- Both AMP and abl-platform share the same pipeline engine with different output routing
- System workflows remain unchanged — battle-tested, no risk of regression
- Custom pipelines can wrap system workflows as steps, extending rather than replacing them

---

## 2. Design Decisions

| Decision                    | Choice                                                           | Alternatives Considered                                              | Rationale                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Who creates pipelines?      | Developers build activity types, tenant admins compose pipelines | Developers only; admins only                                         | Developers control capabilities (security, performance). Admins control behavior (flexibility, self-service).                   |
| Workflow scope              | Evaluation pipelines                                             | General automation (Zapier-like); data processing (ETL)              | Primary use case. General automation and ETL are future extensions.                                                             |
| DAG complexity              | Full DAG — parallel groups, conditions, skip/stop/jump           | Linear chains only; branching + conditions                           | Users need parallel metric evaluation and conditional alerting.                                                                 |
| Step ordering               | Array position (top-to-bottom sequential)                        | Explicit `dependsOn` graph edges                                     | `dependsOn` adds complexity without benefit — array order is natural and sufficient. `parallel` tag handles concurrency.        |
| Execution model             | Interpreted DAG at runtime                                       | Code-generated Temporal workflows; Temporal child workflows per step | No deployment per pipeline change. True self-service. Single generic workflow is simpler to maintain.                           |
| Multi-platform              | Single engine, output routing via step config                    | Separate engines per platform; separate task queues                  | Simpler. Same activity types serve both platforms. Step config controls destination. Separate queues available as escape hatch. |
| Expression evaluator        | Safe subset (comparisons + logical ops)                          | Full JavaScript eval; embedded scripting engine (Lua, WASM)          | Security. No arbitrary code execution. Simple expressions cover evaluation pipeline conditions.                                 |
| System workflow coexistence | Unchanged, referenced via bridge activity                        | Migrate system workflows to custom engine; duplicate logic           | Zero risk to existing workflows. Bridge activity lets custom pipelines compose system workflows as steps.                       |

---

## 3. Architecture Overview

### 3.1 Temporal Server Layout

All workflows — system and custom — run on the same single Temporal server instance (`temporalio/auto-setup:1.24.2` at `temporal:7233`). They are differentiated by task queues.

```
┌───────────────────────────────────────────────────────────────────┐
│                     Temporal Server (temporal:7233)                │
│                     Namespace: acp                                │
├───────────────────────────────────────────────────────────────────┤
│                                                                    │
│  SYSTEM WORKFLOWS (hardcoded, unchanged)                           │
│  ├── processingPipeline         → acp-processing-queue             │
│  │   Worker: processing-service (NestJS, NativeConnection)         │
│  │                                                                 │
│  ├── evaluateSessionMetrics     → metrics-evaluation               │
│  │   Worker: metrics-evaluation-service (NestJS, NativeConnection) │
│  │                                                                 │
│  ├── evaluateSessionPolicies    → policy-evaluation                │
│  │   Worker: policy-evaluation-service (NestJS, NativeConnection)  │
│  │                                                                 │
│  └── emailDigestWorkflow        → email-digest                     │
│      Worker: alert-service (NestJS, NativeConnection)              │
│                                                                    │
│  CUSTOM PIPELINE ENGINE (new)                                      │
│  └── executeCustomPipeline      → custom-pipeline                  │
│      Worker: pipeline-worker (new, NativeConnection)               │
│      ├── reads pipeline definition (JSON DAG)                      │
│      ├── resolves activity types from PipelineActivityRegistry     │
│      ├── executes steps in array order                             │
│      ├── handles parallel groups (Promise.all)                     │
│      ├── evaluates conditions (safe expression evaluator)          │
│      └── applies flow control (skip / stop / jump-to-step)        │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                         Tenant Admin                                │
│                    (API / UI Pipeline Builder)                       │
└──────────┬─────────────────────────────────────────────────────────┘
           │  CRUD pipelines, manual trigger
           ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Pipeline Service (API)                         │
│  ├── POST /pipelines          → validate + save to MongoDB         │
│  ├── POST /pipelines/:id/execute → start Temporal workflow         │
│  ├── GET  /pipeline-activities → list registered activity types    │
│  └── Pipeline Trigger Service → listen Kafka events + match        │
└──────────┬─────────────────────┬───────────────────────────────────┘
           │                     │
           │  start workflow     │  read definition
           ▼                     ▼
┌─────────────────────┐  ┌─────────────────────────────────────────┐
│   Temporal Server    │  │   MongoDB                                │
│                      │  │   ├── pipeline_definitions (DAG JSON)    │
│   workflow:          │  │   └── pipeline_executions (run history)  │
│   executeCustom      │  └─────────────────────────────────────────┘
│   Pipeline           │
└──────────┬───────────┘
           │  dispatches activities
           ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Pipeline Worker                                   │
│                                                                      │
│  PipelineActivityRegistry                                            │
│  ├── 'evaluate-metrics'    → EvaluateMetricsActivity.execute()      │
│  ├── 'evaluate-policy'     → EvaluatePolicyActivity.execute()       │
│  ├── 'store-results'       → StoreResultsActivity.execute()         │
│  ├── 'send-notification'   → SendNotificationActivity.execute()     │
│  ├── 'transform'           → TransformActivity.execute()            │
│  └── 'run-system-workflow' → RunSystemWorkflowActivity.execute()    │
│                                                                      │
│  Each activity wraps existing service logic.                         │
│  New types added by developers via PipelineActivityType interface.   │
└──────────┬────────────┬──────────────┬──────────────┬──────────────┘
           │            │              │              │
           ▼            ▼              ▼              ▼
      ClickHouse    MongoDB      Kafka Topics    HTTP Callback
      (AMP tables)  (any coll)   (events)        (abl-platform)
```

### 3.3 Key Principle — System Workflows as Building Blocks

Custom pipelines can reference existing system workflows as steps via the `run-system-workflow` activity type. This means a custom pipeline can say "run the system metrics evaluation as step 1, then do my custom logic in steps 2-5." The bridge activity starts the system workflow as a Temporal child workflow and waits for its result. This lets admins extend the platform's capabilities without reimplementing them.

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
  // Defines what starts this pipeline.
  trigger: {
    type: 'event' | 'schedule' | 'manual',

    // Event trigger — fires when a matching Kafka/internal event occurs
    // Only active pipelines matching tenantId + eventType are triggered.
    eventType?: string,          // 'session.processed'
                                 // 'metrics.evaluated'
                                 // 'telemetry.ingested'
                                 // 'policy.violated'

    // Schedule trigger — cron expression, registered as Temporal Schedule
    schedule?: string,           // '0 */6 * * *' (every 6 hours)
                                 // '0 0 * * MON' (every Monday midnight)

    // Manual — no auto-trigger. Started via POST /pipelines/:id/execute
    // (type: 'manual' needs no additional fields)
  },

  // ── Input Schema ──
  // Describes what data this pipeline expects when triggered.
  // For event triggers, the event payload is validated against this.
  // For manual triggers, the request body is validated against this.
  inputSchema?: {
    required: string[],          // ['tenantId', 'projectId', 'sessionId']
    properties: Record<string, {
      type: string,              // 'string', 'number', 'boolean', 'object', 'array'
      description?: string,
    }>,
  },

  // ── Task Queue ──
  // Which Temporal task queue to run on. Defaults to 'custom-pipeline'.
  // Can be overridden for platform-specific workers (e.g., 'custom-pipeline-abl').
  taskQueue?: string,            // default: 'custom-pipeline'

  // ── Steps ──
  // The DAG — ordered array of steps. Executed top-to-bottom.
  // See Section 4.2 for step definition.
  steps: PipelineStep[],

  // ── Pipeline-Level Output ──
  // Optional. If set, defines where the overall pipeline result is sent
  // after all steps complete. Individual steps can also have their own output.
  output?: {
    destination: 'clickhouse' | 'mongodb' | 'callback',
    table?: string,              // ClickHouse table name
    collection?: string,         // MongoDB collection name
    callbackUrl?: string,        // HTTP POST endpoint for callback
    kafkaTopic?: string,         // Kafka topic to publish completion event
  },

  // ── Audit ──
  createdBy: string,             // userId who created this pipeline
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes:**

```
{ tenantId: 1, status: 1 }                    — trigger service lookup
{ tenantId: 1, projectId: 1, status: 1 }      — project-scoped queries
{ tenantId: 1, 'trigger.eventType': 1, status: 1 } — event matching
```

### 4.2 Step Definition

```typescript
interface PipelineStep {
  // ── Identity ──
  id: string; // unique within this pipeline: 'eval-toxicity'
  // used in condition expressions and execution tracking
  name: string; // human-readable label: 'Evaluate Toxicity'

  // ── Activity Type ──
  type: string; // key from PipelineActivityRegistry: 'evaluate-metrics'
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
  condition?: {
    // Expression evaluated against previous step outputs.
    // Supports: property access, comparison (==, !=, >, <, >=, <=),
    // logical operators (&&, ||, !), and literals (string, number, boolean, null).
    // Example: "steps.check-policy.output.status == 'FAIL'"
    // Example: "steps.eval-safety.output.scores.toxicity > 0.7"
    // Example: "steps.eval-a.output.status == 'success' && steps.eval-b.output.status == 'success'"
    expression: string;

    // What to do when the expression evaluates to FALSE.
    // Default: 'skip'
    //
    // 'skip'      — Skip this step only. Continue to next step.
    //               Downstream steps receive null for this step's output.
    //
    // 'stop'      — Stop the entire pipeline immediately.
    //               All remaining steps are marked 'skipped'.
    //               Pipeline completes with status 'completed' (intentional stop, not failure).
    //
    // '<step-id>' — Skip this step AND all intermediate steps until the target step.
    //               Resume execution at the target step ID.
    //               All skipped intermediate steps are marked 'skipped'.
    //               Target must be a step that appears LATER in the array.
    //
    // When expression is TRUE: the step runs normally regardless of onFalse value.
    onFalse?: 'skip' | 'stop' | string; // default: 'skip'
  };

  // ── Step Config ──
  // Passed to the activity's execute() method.
  // Validated against the activity type's configSchema when the pipeline is saved.
  config: Record<string, any>;

  // ── Output Routing (per-step) ──
  // Optional. Overrides where THIS step's results are sent.
  // If omitted, step output is only available to subsequent steps via previousSteps.
  output?: {
    destination: 'clickhouse' | 'mongodb' | 'callback' | 'next-step';
    table?: string; // ClickHouse table
    collection?: string; // MongoDB collection
    callbackUrl?: string; // HTTP POST endpoint
    // 'next-step' is the default — output only flows to subsequent steps
  };

  // ── Per-Step Overrides ──
  // Override the activity type's defaults for this specific step.
  timeout?: number; // ms. If omitted, uses activity type's defaultTimeout
  retries?: number; // If omitted, uses activity type's defaultRetries
}
```

### 4.3 Execution Order Rules

Steps execute **top to bottom** in array order. Array position defines sequence. No `dependsOn` edges.

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
steps[5]                       → runs after steps[4] completes
```

**Conditions and flow control:**

```
steps[0]  eval-safety          → runs
steps[1]  eval-quality         → runs
steps[2]  check-policy         → runs
steps[3]  alert                → condition: "steps.check-policy.output.status == 'FAIL'"
                                  onFalse: "store"
steps[4]  escalate             → (skipped if alert was skipped via jump)
steps[5]  store                → jump target — always runs

When policy FAILS (condition TRUE):
  eval-safety → eval-quality → check-policy → alert → escalate → store

When policy PASSES (condition FALSE, onFalse: "store"):
  eval-safety → eval-quality → check-policy → [skip alert] → [skip escalate] → store
```

### 4.4 Example Pipeline — Custom Safety Evaluation

```json
{
  "name": "Custom Safety Evaluation",
  "description": "Evaluate safety and quality metrics in parallel, check policy, alert on failure",
  "status": "active",
  "trigger": {
    "type": "event",
    "eventType": "session.processed"
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
        "expression": "steps.check-policy.output.status == 'FAIL'",
        "onFalse": "store"
      },
      "config": {
        "channel": "slack",
        "webhookUrl": "https://hooks.slack.com/services/T00/B00/xxx"
      }
    },
    {
      "id": "escalate",
      "name": "Escalate to Manager",
      "type": "send-notification",
      "config": {
        "channel": "email",
        "to": "safety-team@company.com"
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
1. eval-safety     → runs    → output: { scores: { toxicity: 0.9, bias: 0.3, pii: 0.1 } }
2. eval-quality  ──┐ parallel
3. eval-cost     ──┘ parallel → both run concurrently, engine waits for both
4. check-policy    → runs    → output: { status: 'FAIL', summary: { passed: 2, failed: 1 } }
5. alert           → condition TRUE → runs → sends Slack notification
6. escalate        → runs    → sends email to safety-team@company.com
7. store           → runs    → writes all step outputs to trace_metrics
```

**Execution trace when policy PASSES:**

```
1. eval-safety     → runs    → output: { scores: { toxicity: 0.1, bias: 0.05, pii: 0.0 } }
2. eval-quality  ──┐ parallel
3. eval-cost     ──┘ parallel → both run concurrently
4. check-policy    → runs    → output: { status: 'PASS', summary: { passed: 3, failed: 0 } }
5. alert           → condition FALSE, onFalse: "store" → SKIPPED
6. escalate        → SKIPPED (intermediate step between alert and store)
7. store           → runs    → writes all step outputs to trace_metrics
```

### 4.5 Example Pipeline — System Workflow Bridge + Custom Logic

```json
{
  "name": "Full Session Analysis with Custom Scoring",
  "trigger": { "type": "event", "eventType": "session.processed" },
  "steps": [
    {
      "id": "system-metrics",
      "name": "Run System Metrics Evaluation",
      "type": "run-system-workflow",
      "config": { "workflow": "evaluateSessionMetrics" }
    },
    {
      "id": "system-policy",
      "name": "Run System Policy Evaluation",
      "type": "run-system-workflow",
      "config": { "workflow": "evaluateSessionPolicies" }
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
          "customScore": "steps.custom-scoring.output.scores",
          "policyStatus": "steps.system-policy.output.data.summary.status"
        }
      }
    },
    {
      "id": "alert-on-fail",
      "name": "Alert on Policy Failure",
      "type": "send-notification",
      "condition": {
        "expression": "steps.system-policy.output.data.summary.failed > 0",
        "onFalse": "skip"
      },
      "config": {
        "channel": "slack",
        "webhookUrl": "https://hooks.slack.com/services/T00/B00/xxx"
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

This pipeline runs the existing system evaluation (preserving all existing behavior), adds custom metrics on top, combines results, conditionally alerts, and stores everything. The admin composed this without writing code.

---

## 5. Activity Type Registry

### 5.1 Core Interfaces

```typescript
// packages/amp-temporal/src/pipeline/pipeline-activity.interface.ts

/**
 * Interface that all activity types must implement.
 * Developers create classes implementing this interface.
 * The registry maps type keys to implementations.
 * Tenant admins reference type keys in pipeline step definitions.
 */
export interface PipelineActivityType {
  /**
   * Unique type key — what admins use in step.type.
   * Convention: lowercase-kebab-case.
   * Examples: 'evaluate-metrics', 'store-results', 'send-notification'
   */
  readonly type: string;

  /**
   * Human-readable name for display in UI pipeline builder.
   * Example: 'Evaluate Metrics'
   */
  readonly name: string;

  /**
   * Description of what this activity does.
   * Shown in the activity palette in the UI.
   * Example: 'Run LLM or quantitative metric evaluation on a session'
   */
  readonly description: string;

  /**
   * JSON Schema describing what config this activity accepts.
   * Used for:
   *   1. Validation at pipeline save time (reject invalid configs before execution)
   *   2. UI form generation in the pipeline builder (auto-render config fields)
   *
   * Example:
   * {
   *   type: 'object',
   *   properties: {
   *     metrics: { type: 'array', items: { type: 'string' }, description: 'Metric IDs to evaluate' },
   *     model: { type: 'string', description: 'LLM model override (optional)' },
   *   },
   *   required: ['metrics'],
   * }
   */
  readonly configSchema: object;

  /**
   * JSON Schema describing what this activity outputs.
   * Used for:
   *   1. Condition expression autocomplete in the UI (what fields can be referenced)
   *   2. Documentation for downstream steps (what data is available)
   *
   * Example:
   * {
   *   type: 'object',
   *   properties: {
   *     scores: { type: 'object', description: 'metricId → score mapping' },
   *     status: { type: 'string', enum: ['success', 'fail'] },
   *   },
   * }
   */
  readonly outputSchema: object;

  /** Default timeout in ms. Can be overridden per-step in the pipeline definition. */
  readonly defaultTimeout: number;

  /** Default retry count. Can be overridden per-step in the pipeline definition. */
  readonly defaultRetries: number;

  /**
   * Execute the activity.
   *
   * Receives the step's config, outputs from all previously completed steps,
   * and the pipeline-level input (from trigger event or manual start).
   *
   * Returns a StepOutput with status and arbitrary data.
   * The data is available to subsequent steps via previousSteps[stepId].
   */
  execute(context: PipelineStepContext): Promise<StepOutput>;
}

/**
 * Context passed to every activity execution.
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
   * Example: { metrics: ['toxicity', 'bias'], model: 'gpt-4o' }
   */
  config: Record<string, any>;

  /**
   * Outputs from all previously completed steps, keyed by step ID.
   * Steps that were skipped have { status: 'skipped', data: {} }.
   *
   * Example:
   * {
   *   'eval-safety': { status: 'success', data: { scores: { toxicity: 0.9 } } },
   *   'eval-quality': { status: 'success', data: { scores: { coherence: 0.8 } } },
   * }
   */
  previousSteps: Record<string, StepOutput>;

  /**
   * Pipeline-level input — from the trigger event payload or manual execute request body.
   * Example: { tenantId: 't-123', projectId: 'p-456', sessionId: 's-789' }
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
   */
  data: Record<string, any>;
}
```

### 5.2 Registry Implementation

```typescript
// packages/amp-temporal/src/pipeline/activity-registry.ts

/**
 * Info returned by listTypes() — everything the UI needs to render the activity palette.
 * Does NOT include the execute() method — this is metadata only.
 */
export interface ActivityTypeInfo {
  type: string;
  name: string;
  description: string;
  configSchema: object;
  outputSchema: object;
  defaultTimeout: number;
  defaultRetries: number;
}

/**
 * Central registry of all available pipeline activity types.
 *
 * Populated at worker startup:
 *   - AMP (NestJS): Activity types are @Injectable() classes, registered via module providers
 *   - abl-platform (Express): Activity types are plain classes, registered via initPipelineEngine()
 *
 * Queried at:
 *   - Pipeline save time: validate step.type exists, validate step.config against configSchema
 *   - Pipeline execution time: resolve step.type → activity instance → call execute()
 *   - API GET /pipeline-activities: return all types for UI pipeline builder
 */
export class PipelineActivityRegistry {
  private activities = new Map<string, PipelineActivityType>();

  /**
   * Register an activity type. Called at startup.
   * Throws if a type with the same key is already registered (prevents silent overwrite).
   */
  register(activity: PipelineActivityType): void {
    if (this.activities.has(activity.type)) {
      throw new Error(`Activity type '${activity.type}' already registered`);
    }
    this.activities.set(activity.type, activity);
  }

  /**
   * Get an activity type by key. Called at execution time.
   * Throws if not found — this should never happen for active pipelines
   * because validation at save time ensures the type exists.
   */
  get(type: string): PipelineActivityType {
    const activity = this.activities.get(type);
    if (!activity) {
      throw new Error(
        `Unknown activity type: '${type}'. Registered types: ${[...this.activities.keys()].join(', ')}`,
      );
    }
    return activity;
  }

  /** Check if a type is registered. Used at pipeline validation time. */
  has(type: string): boolean {
    return this.activities.has(type);
  }

  /**
   * List all registered activity types with their schemas.
   * Used by:
   *   - GET /pipeline-activities API endpoint
   *   - UI pipeline builder to render the activity palette and config forms
   */
  listTypes(): ActivityTypeInfo[] {
    return Array.from(this.activities.values()).map((a) => ({
      type: a.type,
      name: a.name,
      description: a.description,
      configSchema: a.configSchema,
      outputSchema: a.outputSchema,
      defaultTimeout: a.defaultTimeout,
      defaultRetries: a.defaultRetries,
    }));
  }
}
```

### 5.3 Developer Workflow — Adding a New Activity Type

Adding a new activity type is a 3-step process:

**Step 1:** Write a class implementing `PipelineActivityType` (~30-80 lines depending on complexity).

```typescript
// Example: a new activity type that calls an external ML model
@Injectable()
export class ExternalMlScoringActivity implements PipelineActivityType {
  readonly type = 'external-ml-scoring';
  readonly name = 'External ML Scoring';
  readonly description = 'Send session data to an external ML model API for scoring';
  readonly configSchema = {
    type: 'object',
    properties: {
      modelEndpoint: { type: 'string', description: 'ML model API URL' },
      modelName: { type: 'string', description: 'Model identifier' },
      features: {
        type: 'array',
        items: { type: 'string' },
        description: 'Feature keys to extract',
      },
    },
    required: ['modelEndpoint', 'modelName'],
  };
  readonly outputSchema = {
    type: 'object',
    properties: {
      score: { type: 'number' },
      confidence: { type: 'number' },
      label: { type: 'string' },
    },
  };
  readonly defaultTimeout = 60000; // 1 minute
  readonly defaultRetries = 2;

  constructor(private readonly httpClient: HttpClientService) {}

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const response = await this.httpClient.post(context.config.modelEndpoint, {
      urlSource: 'config',
      body: {
        tenantId: context.tenantId,
        sessionId: context.sessionId,
        model: context.config.modelName,
        features: context.config.features,
      },
    });
    return {
      status: 'success',
      data: { score: response.score, confidence: response.confidence, label: response.label },
    };
  }
}
```

**Step 2:** Register it in the pipeline module.

```typescript
// In the pipeline module's providers or startup code
registry.register(new ExternalMlScoringActivity(httpClient));
```

**Step 3:** Deploy. Tenant admins can now use `"type": "external-ml-scoring"` in their pipeline definitions. The UI pipeline builder automatically shows it in the activity palette with its config form generated from `configSchema`.

---

## 6. Built-in Activity Types (v1)

These are the activity types that ship with the platform. They wrap existing AMP service logic so that custom pipelines can reuse proven capabilities.

### 6.1 Core Activities

#### `evaluate-metrics` — Evaluate Metrics

Wraps existing metrics evaluation logic from the metrics-evaluation-service.

```typescript
@Injectable()
export class EvaluateMetricsActivity implements PipelineActivityType {
  readonly type = 'evaluate-metrics';
  readonly name = 'Evaluate Metrics';
  readonly description = 'Run LLM or quantitative metric evaluation on a session';
  readonly configSchema = {
    type: 'object',
    properties: {
      metrics: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Metric IDs or metric keys to evaluate. Can reference system metrics (e.g., "toxicity") or custom metrics created by the tenant.',
      },
      model: {
        type: 'string',
        description:
          'LLM model override. If omitted, uses the model configured on each metric definition.',
      },
    },
    required: ['metrics'],
  };
  readonly outputSchema = {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        description:
          'Map of metricId → numeric score. Example: { "toxicity": 0.92, "coherence": 0.45 }',
      },
      details: {
        type: 'array',
        description: 'Per-metric evaluation details including reasoning, confidence, token usage',
      },
      status: { type: 'string', enum: ['success', 'fail'] },
    },
  };
  readonly defaultTimeout = 300000; // 5 minutes (LLM calls can be slow)
  readonly defaultRetries = 2;

  constructor(private readonly metricsService: MetricsEvaluationService) {}

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const results = await this.metricsService.evaluate({
      tenantId: context.tenantId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      metrics: context.config.metrics,
      model: context.config.model,
    });
    return {
      status: 'success',
      data: {
        scores: results.scores,
        details: results.details,
        status: 'success',
      },
    };
  }
}
```

#### `evaluate-policy` — Evaluate Policy

Wraps existing policy evaluation logic from the policy-evaluation-service.

```typescript
@Injectable()
export class EvaluatePolicyActivity implements PipelineActivityType {
  readonly type = 'evaluate-policy';
  readonly name = 'Evaluate Policy';
  readonly description = 'Check a policy rules against metric results for the session';
  readonly configSchema = {
    type: 'object',
    properties: {
      policyId: {
        type: 'string',
        description:
          'ID of the policy to evaluate. Must be an active policy in the tenant/project.',
      },
    },
    required: ['policyId'],
  };
  readonly outputSchema = {
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
      violations: {
        type: 'array',
        description: 'List of rule violations with policy name, severity, and reason',
      },
    },
  };
  readonly defaultTimeout = 120000; // 2 minutes
  readonly defaultRetries = 2;

  constructor(private readonly policyService: PolicyEvaluationService) {}

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const result = await this.policyService.evaluatePolicy({
      tenantId: context.tenantId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      policyId: context.config.policyId,
      // If previous steps produced metric scores, pass them so the policy
      // doesn't need to re-fetch from ClickHouse
      metricScores: this.extractMetricScores(context.previousSteps),
    });
    return {
      status: result.summary.failed > 0 ? 'fail' : 'success',
      data: {
        status: result.status,
        summary: result.summary,
        violations: result.violations,
      },
    };
  }

  private extractMetricScores(
    previousSteps: Record<string, StepOutput>,
  ): Record<string, number> | undefined {
    // Collect scores from any previous evaluate-metrics steps
    const scores: Record<string, number> = {};
    for (const output of Object.values(previousSteps)) {
      if (output.data?.scores) {
        Object.assign(scores, output.data.scores);
      }
    }
    return Object.keys(scores).length > 0 ? scores : undefined;
  }
}
```

#### `store-results` — Store Results

Writes step outputs to a configurable destination. This is the key activity for multi-platform output routing.

```typescript
@Injectable()
export class StoreResultsActivity implements PipelineActivityType {
  readonly type = 'store-results';
  readonly name = 'Store Results';
  readonly description =
    'Write pipeline step outputs to ClickHouse, MongoDB, or an HTTP callback endpoint';
  readonly configSchema = {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        enum: ['clickhouse', 'mongodb', 'callback'],
        description: 'Where to write results',
      },
      table: {
        type: 'string',
        description: 'ClickHouse table name. Required when destination is "clickhouse".',
      },
      collection: {
        type: 'string',
        description: 'MongoDB collection name. Required when destination is "mongodb".',
      },
      callbackUrl: {
        type: 'string',
        description:
          'HTTP POST URL. Required when destination is "callback". Response body is ignored.',
      },
      includeSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Step IDs to include in output. If omitted, includes all previous steps.',
      },
    },
    required: ['destination'],
  };
  readonly outputSchema = {
    type: 'object',
    properties: {
      rowsWritten: { type: 'number' },
      destination: { type: 'string' },
    },
  };
  readonly defaultTimeout = 60000; // 1 minute
  readonly defaultRetries = 3;

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly httpClient: HttpClientService,
  ) {}

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const { destination } = context.config;
    const stepsToInclude = context.config.includeSteps
      ? Object.fromEntries(
          Object.entries(context.previousSteps).filter(([id]) =>
            context.config.includeSteps.includes(id),
          ),
        )
      : context.previousSteps;

    const payload = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      sessionId: context.sessionId,
      pipelineInput: context.pipelineInput,
      stepOutputs: stepsToInclude,
      timestamp: new Date().toISOString(),
    };

    switch (destination) {
      case 'clickhouse':
        const rows = this.transformForClickHouse(payload, context.config.table);
        await this.clickhouse.insert(context.config.table, rows);
        return { status: 'success', data: { rowsWritten: rows.length, destination: 'clickhouse' } };

      case 'mongodb':
        // Insert into the specified collection
        await this.mongoInsert(context.config.collection, payload);
        return { status: 'success', data: { rowsWritten: 1, destination: 'mongodb' } };

      case 'callback':
        await this.httpClient.post(context.config.callbackUrl, {
          urlSource: 'config',
          body: payload,
        });
        return { status: 'success', data: { rowsWritten: 1, destination: 'callback' } };

      default:
        return { status: 'fail', data: { error: `Unknown destination: ${destination}` } };
    }
  }
}
```

#### `send-notification` — Send Notification

Sends alerts through various channels.

```typescript
@Injectable()
export class SendNotificationActivity implements PipelineActivityType {
  readonly type = 'send-notification';
  readonly name = 'Send Notification';
  readonly description = 'Send an alert via Slack, email, webhook, or WebSocket broadcast';
  readonly configSchema = {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        enum: ['slack', 'email', 'webhook', 'websocket'],
        description: 'Notification channel',
      },
      webhookUrl: {
        type: 'string',
        description:
          'Slack webhook URL or generic webhook URL. Required for slack/webhook channels.',
      },
      to: {
        type: 'string',
        description: 'Email address or comma-separated list. Required for email channel.',
      },
      subject: {
        type: 'string',
        description: 'Email subject or notification title. Optional.',
      },
      messageTemplate: {
        type: 'string',
        description:
          'Message template. Supports {{steps.stepId.output.field}} interpolation. Optional — auto-generates summary if omitted.',
      },
      websocketChannel: {
        type: 'string',
        description:
          'WebSocket channel name (e.g., sessionId or projectId). Required for websocket channel.',
      },
    },
    required: ['channel'],
  };
  readonly outputSchema = {
    type: 'object',
    properties: {
      sent: { type: 'boolean' },
      channel: { type: 'string' },
    },
  };
  readonly defaultTimeout = 30000; // 30 seconds
  readonly defaultRetries = 2;

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const { channel } = context.config;
    const message = this.buildMessage(context);

    switch (channel) {
      case 'slack':
        await this.sendSlack(context.config.webhookUrl, message);
        break;
      case 'email':
        await this.sendEmail(context.config.to, context.config.subject, message);
        break;
      case 'webhook':
        await this.sendWebhook(context.config.webhookUrl, context);
        break;
      case 'websocket':
        await this.broadcastWebSocket(context.config.websocketChannel, context);
        break;
    }
    return { status: 'success', data: { sent: true, channel } };
  }
}
```

#### `transform` — Transform Data

Reshapes data between steps. Useful for combining outputs from multiple steps or extracting specific fields for downstream steps.

```typescript
export class TransformActivity implements PipelineActivityType {
  readonly type = 'transform';
  readonly name = 'Transform Data';
  readonly description = 'Reshape data between steps — combine, extract, or rename fields';
  readonly configSchema = {
    type: 'object',
    properties: {
      mapping: {
        type: 'object',
        description:
          'Output field name → expression mapping. Expressions use the same syntax as conditions: steps.stepId.output.field',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['mapping'],
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Shape determined by the mapping config',
  };
  readonly defaultTimeout = 10000; // 10 seconds (pure data transformation)
  readonly defaultRetries = 1;

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    const result: Record<string, any> = {};
    for (const [outputField, expression] of Object.entries(context.config.mapping)) {
      result[outputField] = resolveExpression(expression as string, context.previousSteps);
    }
    return { status: 'success', data: result };
  }
}
```

### 6.2 Bridge Activity

#### `run-system-workflow` — Run System Workflow

Starts an existing hardcoded Temporal workflow as a child workflow and waits for its result. This bridges custom pipelines with system workflows.

```typescript
export class RunSystemWorkflowActivity implements PipelineActivityType {
  readonly type = 'run-system-workflow';
  readonly name = 'Run System Workflow';
  readonly description =
    'Start an existing system workflow (metrics evaluation, policy evaluation, etc.) and wait for its result. Lets custom pipelines reuse proven system logic.';
  readonly configSchema = {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        enum: ['evaluateSessionMetrics', 'evaluateSessionPolicies'],
        description: 'System workflow to execute',
      },
      taskQueue: {
        type: 'string',
        description:
          'Task queue for the system workflow. Defaults to the system workflow default queue.',
      },
      timeout: {
        type: 'number',
        description: 'Workflow execution timeout in ms. Default: 1800000 (30 min).',
      },
    },
    required: ['workflow'],
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Output shape depends on which system workflow is executed',
  };
  readonly defaultTimeout = 1800000; // 30 minutes (system workflows can be long)
  readonly defaultRetries = 1; // system workflows handle their own retries

  async execute(context: PipelineStepContext): Promise<StepOutput> {
    // This activity is special — it starts a Temporal CHILD WORKFLOW
    // rather than doing work directly. The child workflow runs on
    // the system workflow's own task queue with its own worker.
    const result = await executeChild(context.config.workflow, {
      args: [
        {
          tenantId: context.tenantId,
          projectId: context.projectId,
          sessionId: context.sessionId,
        },
      ],
      taskQueue: context.config.taskQueue || SYSTEM_TASK_QUEUES[context.config.workflow],
      workflowExecutionTimeout: context.config.timeout || 1800000,
    });
    return { status: 'success', data: result };
  }
}
```

### 6.3 v2 Activities (Future)

These can be added post-launch. Each is just a new class implementing `PipelineActivityType` — no engine changes needed.

| Type           | Name              | Description                                                                                                                               |
| -------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `http-request` | HTTP Request      | Call an external API, use response data in subsequent steps. Useful for fetching external context or triggering external systems.         |
| `filter`       | Filter / Gate     | Evaluate a complex condition with richer logic than step-level conditions. Can inspect multiple step outputs and apply multi-field logic. |
| `aggregate`    | Aggregate Results | Combine outputs from multiple previous steps into a single summary object. Useful for reporting and dashboard writes.                     |
| `delay`        | Wait / Delay      | Pause the pipeline for a configured duration. Useful for rate limiting external APIs or waiting for eventual consistency.                 |
| `fan-out`      | Fan Out           | Run the same activity type N times with different inputs (e.g., evaluate 10 sessions in parallel). Returns array of results.              |

---

## 7. DAG Execution Engine

### 7.1 The Generic Temporal Workflow

A single workflow function that interprets any pipeline definition. This is the heart of the engine.

```typescript
// packages/amp-temporal/src/pipeline/workflows/execute-custom-pipeline.workflow.ts

import { proxyActivities } from '@temporalio/workflow';

// Temporal workflow — pure orchestration, deterministic, no side effects.
// All actual work happens in the executeStep activity.
export async function executeCustomPipeline(
  input: PipelineExecutionInput,
): Promise<PipelineExecutionResult> {
  const { pipelineDefinition, pipelineInput } = input;
  const steps = pipelineDefinition.steps;

  // Accumulates outputs from all completed steps.
  // Keyed by step ID. Available to conditions and downstream steps.
  const stepOutputs: Record<string, StepOutput> = {};

  let i = 0;

  while (i < steps.length) {
    const step = steps[i];

    // ── 1. Evaluate Condition ──
    // If the step has a condition, evaluate it against previous step outputs.
    // If false, apply the onFalse flow control (skip / stop / jump).
    if (step.condition) {
      const shouldRun = evaluateExpression(step.condition.expression, stepOutputs);

      if (!shouldRun) {
        const onFalse = step.condition.onFalse || 'skip';

        // SKIP: skip this step only, continue to next
        if (onFalse === 'skip') {
          stepOutputs[step.id] = { status: 'skipped', data: {} };
          i++;
          continue;
        }

        // STOP: stop the entire pipeline, mark all remaining steps as skipped
        if (onFalse === 'stop') {
          for (let j = i; j < steps.length; j++) {
            stepOutputs[steps[j].id] = { status: 'skipped', data: {} };
          }
          break;
        }

        // JUMP TO STEP ID: skip this step and all intermediate steps
        // Resume execution at the target step
        const targetIndex = steps.findIndex((s) => s.id === onFalse);
        if (targetIndex === -1) {
          // Should never happen — validated at save time
          throw new Error(`onFalse target step '${onFalse}' not found`);
        }

        // Mark current step and all intermediate steps as skipped
        stepOutputs[step.id] = { status: 'skipped', data: {} };
        for (let j = i + 1; j < targetIndex; j++) {
          stepOutputs[steps[j].id] = { status: 'skipped', data: {} };
        }
        i = targetIndex;
        continue;
      }
    }

    // ── 2. Collect Parallel Group ──
    // If this step has a parallel tag, gather all contiguous steps with the same tag.
    if (step.parallel) {
      const groupTag = step.parallel;
      const parallelSteps: typeof steps = [];

      while (i < steps.length && steps[i].parallel === groupTag) {
        parallelSteps.push(steps[i]);
        i++;
      }

      // ── 3. Execute Parallel Group ──
      // Fan out: start all steps concurrently. Fan in: wait for all to complete.
      const results = await Promise.all(
        parallelSteps.map((ps) =>
          activities.executeStep({
            step: ps,
            previousSteps: stepOutputs,
            pipelineInput,
          }),
        ),
      );

      // ── 4. Collect Parallel Outputs ──
      parallelSteps.forEach((ps, idx) => {
        stepOutputs[ps.id] = results[idx];
      });

      // i is already advanced past the group by the while loop
      continue;
    }

    // ── 5. Execute Single Step ──
    stepOutputs[step.id] = await activities.executeStep({
      step,
      previousSteps: stepOutputs,
      pipelineInput,
    });

    i++;
  }

  // ── 6. Return Final Result ──
  return {
    pipelineId: pipelineDefinition._id,
    status: deriveOverallStatus(stepOutputs),
    stepOutputs,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Derive overall pipeline status from step outputs.
 * - If any step failed → 'failed'
 * - If all steps completed or skipped → 'completed'
 */
function deriveOverallStatus(stepOutputs: Record<string, StepOutput>): 'completed' | 'failed' {
  const statuses = Object.values(stepOutputs).map((o) => o.status);
  if (statuses.some((s) => s === 'fail')) return 'failed';
  return 'completed';
}
```

### 7.2 Step Executor Activity

The single Temporal activity that dispatches to the right activity type via the registry. This is where framework-specific dependencies are resolved.

```typescript
// packages/amp-temporal/src/pipeline/activities/execute-step.activity.ts

/**
 * Temporal activity that executes a single pipeline step.
 *
 * This function is registered as a Temporal activity on the pipeline worker.
 * It resolves the step's activity type from the registry and calls execute().
 *
 * Temporal handles retries, timeouts, and heartbeating around this function.
 */
export async function executeStep(input: {
  step: PipelineStep;
  previousSteps: Record<string, StepOutput>;
  pipelineInput: Record<string, any>;
}): Promise<StepOutput> {
  const { step, previousSteps, pipelineInput } = input;

  // 1. Resolve activity type from registry
  const registry = getPipelineActivityRegistry();
  const activityType = registry.get(step.type);

  // 2. Build execution context
  const context: PipelineStepContext = {
    tenantId: pipelineInput.tenantId,
    projectId: pipelineInput.projectId,
    sessionId: pipelineInput.sessionId,
    config: step.config,
    previousSteps,
    pipelineInput,
  };

  // 3. Execute
  try {
    const result = await activityType.execute(context);
    return result;
  } catch (error) {
    // If retries are exhausted (or set to 0), return a fail output
    // instead of throwing — this lets the pipeline continue if the
    // workflow has downstream error handling.
    // If retries remain, re-throw to let Temporal retry.
    if (step.retries === 0) {
      return {
        status: 'fail',
        data: { error: error.message, type: step.type },
      };
    }
    throw error;
  }
}
```

### 7.3 Expression Evaluator

Safe evaluator for condition expressions. No `eval()`, no `new Function()`, no arbitrary code execution. Supports only a restricted subset of operations.

```typescript
// packages/amp-temporal/src/pipeline/expression-evaluator.ts

/**
 * Safe expression evaluator for pipeline conditions.
 *
 * Supported syntax:
 *   Property access:  steps.stepId.output.field
 *                     steps.stepId.output.nested.deep.field
 *   Comparison:       ==  !=  >  <  >=  <=
 *   Logical:          &&  ||  !
 *   Literals:         'string'  42  3.14  true  false  null
 *   Grouping:         ( ... )
 *
 * NOT supported (rejected at pipeline save time):
 *   Assignment:       =
 *   Function calls:   foo()
 *   Keywords:         new, delete, typeof, void, import, require
 *   Bracket access:   obj['key']  (use dot notation only)
 *   Arithmetic:       +  -  *  /  % (conditions are boolean, not arithmetic)
 *   Bitwise:          &  |  ^  ~  <<  >>
 *
 * Examples:
 *   "steps.check-policy.output.status == 'FAIL'"
 *   "steps.eval-safety.output.scores.toxicity > 0.7"
 *   "steps.eval-a.output.status == 'success' && steps.eval-b.output.status == 'success'"
 *   "!steps.check.output.passed"
 *   "steps.eval.output.score >= 0.5 || steps.eval.output.override == true"
 */
export function evaluateExpression(
  expression: string,
  stepOutputs: Record<string, StepOutput>,
): boolean {
  // Build context: steps.stepId.output → stepOutputs[stepId]
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
 * Validate that an expression only uses supported operations.
 * Called at pipeline save time — rejects expressions before they can be executed.
 * Returns true if safe, throws with description if not.
 */
export function isSafeExpression(expression: string): boolean {
  // Reject dangerous patterns
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
 * Used at validation time to ensure referenced steps exist and appear earlier in the array.
 *
 * "steps.check-policy.output.status == 'FAIL'" → ['check-policy']
 * "steps.a.output.x > 0 && steps.b.output.y == true" → ['a', 'b']
 */
export function extractStepReferences(expression: string): string[] {
  const matches = expression.matchAll(/steps\.([a-zA-Z0-9_-]+)\./g);
  return [...new Set(Array.from(matches, (m) => m[1]))];
}
```

### 7.4 Execution Tracking

Every pipeline execution is tracked in MongoDB for visibility, debugging, and audit.

```typescript
// MongoDB collection: pipeline_executions
{
  _id: ObjectId,
  pipelineId: ObjectId,           // ref → pipeline_definitions._id
  pipelineVersion: number,        // which version of the definition was used
  tenantId: string,               // tenant isolation
  workflowId: string,             // Temporal workflow ID — links to Temporal UI

  status: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled',

  // What triggered this execution
  trigger: {
    type: 'event' | 'schedule' | 'manual',
    eventType?: string,           // for event triggers
    triggeredBy?: string,         // userId for manual triggers
  },

  // Pipeline input data
  input: Record<string, any>,

  // Per-step execution details — updated in real-time via Temporal signals
  steps: [
    {
      id: string,                 // matches step.id from definition
      name: string,               // matches step.name
      type: string,               // activity type
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
      startedAt?: Date,
      completedAt?: Date,
      duration?: number,          // ms
      output?: StepOutput,        // full output (available after completion)
      error?: string,             // error message if failed
    },
  ],

  // Overall timing
  startedAt: Date,
  completedAt?: Date,
  duration?: number,              // ms

  // Error info (if status is 'failed')
  error?: {
    stepId: string,               // which step failed
    message: string,
    stack?: string,
  },
}
```

**Real-time updates:** The workflow emits Temporal signals as each step transitions (`pending` → `running` → `completed`/`failed`/`skipped`). A signal listener (running alongside the API) receives these signals and updates the `pipeline_executions` document. This enables the UI to show live pipeline progress.

**Indexes:**

```
{ tenantId: 1, pipelineId: 1, startedAt: -1 }    — list executions per pipeline
{ tenantId: 1, status: 1 }                         — find running executions
{ workflowId: 1 }                                  — lookup by Temporal workflow ID
```

---

## 8. API Layer

### 8.1 Pipeline Definition APIs

```
POST   /api/v1/accounts/:tenantId/pipelines
  Create a new pipeline definition.
  Body: { name, description?, trigger, steps, inputSchema?, output?, projectId? }
  Returns: 201 with the created pipeline definition.
  Status is set to 'draft' by default.
  Validates: step types exist, config matches schemas, expressions are safe,
             parallel groups contiguous, step IDs unique, onFalse targets valid.

GET    /api/v1/accounts/:tenantId/pipelines
  List pipeline definitions for the tenant.
  Query params: status, projectId, trigger.type, page, limit, sort
  Returns: paginated list with metadata (total, page, limit).

GET    /api/v1/accounts/:tenantId/pipelines/:pipelineId
  Get a single pipeline definition by ID.
  Returns: full pipeline definition including all steps and config.

PATCH  /api/v1/accounts/:tenantId/pipelines/:pipelineId
  Update a pipeline definition.
  Body: partial update (any field except _id, tenantId, createdBy, createdAt).
  Auto-increments version. Re-validates entire definition.
  Cannot update an 'active' pipeline — must deactivate first, or clone.

DELETE /api/v1/accounts/:tenantId/pipelines/:pipelineId
  Soft delete — sets status to 'archived'.
  Archived pipelines are preserved for audit but no longer triggerable.
  Cannot delete a pipeline with running executions — must cancel them first.

POST   /api/v1/accounts/:tenantId/pipelines/:pipelineId/activate
  Transition status: draft → active.
  Validates the full definition one more time before activating.
  If trigger.type is 'schedule', registers a Temporal Schedule.
  If trigger.type is 'event', the trigger service starts matching events.

POST   /api/v1/accounts/:tenantId/pipelines/:pipelineId/deactivate
  Transition status: active → archived.
  If trigger.type is 'schedule', removes the Temporal Schedule.
  Running executions continue to completion — deactivation only stops NEW triggers.

POST   /api/v1/accounts/:tenantId/pipelines/:pipelineId/clone
  Clone an existing pipeline as a new draft.
  Copies all steps and config. New name = "Copy of {original name}".
  Useful for iterating on a production pipeline without modifying it.
```

### 8.2 Pipeline Execution APIs

```
POST   /api/v1/accounts/:tenantId/pipelines/:pipelineId/execute
  Manually trigger a pipeline execution.
  Body: pipeline input data (validated against inputSchema).
  Returns: 202 with { executionId, workflowId }.
  The pipeline must be 'active' to execute.

GET    /api/v1/accounts/:tenantId/pipelines/:pipelineId/executions
  List executions for a pipeline.
  Query params: status, startedAfter, startedBefore, page, limit
  Returns: paginated list of executions with step-level status summary.

GET    /api/v1/accounts/:tenantId/executions/:executionId
  Get full execution detail including per-step status, outputs, timing.
  Returns: complete execution record from pipeline_executions collection.

POST   /api/v1/accounts/:tenantId/executions/:executionId/cancel
  Cancel a running execution.
  Sends a cancellation request to the Temporal workflow.
  Running step completes, remaining steps are marked 'skipped'.
  Execution status transitions to 'cancelled'.
```

### 8.3 Activity Registry API (read-only)

```
GET    /api/v1/pipeline-activities
  List all registered activity types.
  Returns: array of { type, name, description, configSchema, outputSchema,
           defaultTimeout, defaultRetries }
  Used by the UI pipeline builder to render the activity palette.
  No authentication required beyond basic auth (any tenant user can see available types).

GET    /api/v1/pipeline-activities/:type
  Get a single activity type with full schemas.
  Returns: same fields as above for a single type.
  Used by the UI when configuring a specific step.
```

### 8.4 Validation on Save

When a pipeline is created or updated, the API validates the entire definition before saving. Invalid pipelines are rejected with detailed error messages.

```typescript
function validatePipeline(definition: PipelineDefinition): ValidationError[] {
  const errors: ValidationError[] = [];
  const registry = getPipelineActivityRegistry();
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
      errors.push({ step: step.id, index: i, message: `Duplicate step ID: '${step.id}'` });
    }
    stepIds.add(step.id);
    stepIdOrder.push(step.id);

    // 3. Activity type must exist in registry
    if (!registry.has(step.type)) {
      errors.push({
        step: step.id,
        index: i,
        message: `Unknown activity type: '${step.type}'. Available types: ${registry
          .listTypes()
          .map((t) => t.type)
          .join(', ')}`,
      });
      continue; // skip config validation if type is unknown
    }

    // 4. Step config must match activity's configSchema
    const activityType = registry.get(step.type);
    const configErrors = validateJsonSchema(step.config, activityType.configSchema);
    for (const err of configErrors) {
      errors.push({ step: step.id, index: i, message: `Config validation: ${err}` });
    }

    // 5. Condition validation
    if (step.condition) {
      // 5a. Expression must be safe (no injection)
      if (!isSafeExpression(step.condition.expression)) {
        errors.push({
          step: step.id,
          index: i,
          message: 'Condition expression contains unsupported operations',
        });
      }

      // 5b. Referenced step IDs must exist and appear EARLIER in the array
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

      // 5c. onFalse step ID target must exist and be LATER in the array
      const onFalse = step.condition.onFalse;
      if (onFalse && onFalse !== 'skip' && onFalse !== 'stop') {
        const targetIndex = definition.steps.findIndex((s) => s.id === onFalse);
        if (targetIndex === -1) {
          errors.push({
            step: step.id,
            index: i,
            message: `onFalse target step '${onFalse}' not found`,
          });
        } else if (targetIndex <= i) {
          errors.push({
            step: step.id,
            index: i,
            message: `onFalse target '${onFalse}' must be a later step (would create backward jump)`,
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
          message: `Parallel group '${group}' is not contiguous — steps must be adjacent in the array`,
        });
        break;
      }
    }
  }

  return errors;
}
```

### 8.5 Trigger Wiring

#### Event Triggers

A lightweight Kafka consumer in the pipeline service listens on relevant topics and matches incoming events against active pipeline definitions.

```typescript
// Pipeline trigger service — runs in the project-service (or standalone)

/**
 * Called when a Kafka event arrives (session.processed, metrics.evaluated, etc.)
 *
 * 1. Find all active pipelines for this tenant triggered by this event type
 * 2. Start a Temporal workflow for each matching pipeline
 * 3. Create a pipeline_execution record for tracking
 */
async function onEvent(event: {
  type: string; // 'session.processed', 'metrics.evaluated', etc.
  tenantId: string;
  data: Record<string, any>; // { projectId, sessionId, ... }
}): Promise<void> {
  // Find all active pipelines matching this event
  const matchingPipelines = await PipelineDefinition.find({
    tenantId: event.tenantId,
    status: 'active',
    'trigger.type': 'event',
    'trigger.eventType': event.type,
  }).lean();

  for (const pipeline of matchingPipelines) {
    // Validate input against pipeline's inputSchema (if defined)
    if (pipeline.inputSchema) {
      const valid = validateJsonSchema(event.data, pipeline.inputSchema);
      if (!valid) {
        logger.warn('Event data does not match pipeline inputSchema', {
          pipelineId: pipeline._id,
          eventType: event.type,
        });
        continue; // skip this pipeline, don't fail
      }
    }

    // Start the Temporal workflow
    const workflowId = `pipeline-${pipeline._id}-${Date.now()}`;
    await getTemporalClient().startWorkflowByName(
      'executeCustomPipeline',
      [
        {
          pipelineDefinition: pipeline,
          pipelineInput: {
            tenantId: event.tenantId,
            ...event.data,
          },
        },
      ],
      {
        workflowId,
        taskQueue: pipeline.taskQueue || 'custom-pipeline',
        workflowExecutionTimeout: 3600000, // 1 hour max
      },
    );

    // Create execution tracking record
    await PipelineExecution.create({
      pipelineId: pipeline._id,
      pipelineVersion: pipeline.version,
      tenantId: event.tenantId,
      workflowId,
      status: 'running',
      trigger: { type: 'event', eventType: event.type },
      input: event.data,
      steps: pipeline.steps.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        status: 'pending',
      })),
      startedAt: new Date(),
    });
  }
}
```

#### Schedule Triggers

When a pipeline with `trigger.type: 'schedule'` is activated, the system registers a Temporal Schedule. Temporal has native cron support — no custom scheduler needed.

```typescript
// Called when POST /pipelines/:id/activate is called for a schedule-triggered pipeline

async function registerSchedule(pipeline: PipelineDefinition): Promise<void> {
  const client = getTemporalClient();
  const scheduleId = `pipeline-schedule-${pipeline._id}`;

  await client.schedule.create({
    scheduleId,
    spec: {
      cronExpressions: [pipeline.trigger.schedule],
    },
    action: {
      type: 'startWorkflow',
      workflowType: 'executeCustomPipeline',
      args: [
        {
          pipelineDefinition: pipeline,
          pipelineInput: {
            tenantId: pipeline.tenantId,
            projectId: pipeline.projectId,
            triggeredBy: 'schedule',
          },
        },
      ],
      taskQueue: pipeline.taskQueue || 'custom-pipeline',
    },
  });
}

// Called when POST /pipelines/:id/deactivate is called
async function removeSchedule(pipelineId: string): Promise<void> {
  const client = getTemporalClient();
  const scheduleId = `pipeline-schedule-${pipelineId}`;

  try {
    const handle = client.schedule.getHandle(scheduleId);
    await handle.delete();
  } catch (error) {
    // Schedule may not exist if it was never activated
    logger.warn('Schedule not found for deletion', { scheduleId });
  }
}
```

#### Manual Triggers

The `POST /pipelines/:id/execute` endpoint starts the workflow directly with the request body as `pipelineInput`. No Kafka consumer or schedule needed.

### 8.6 Permissions

Follows the existing AMP RBAC pattern. New permissions are added to the permission system.

| Action                                      | Permission Key             | Who Typically Has It                   |
| ------------------------------------------- | -------------------------- | -------------------------------------- |
| Create, update, delete pipeline definitions | `MANAGE_PIPELINES`         | Project Admin, Account Admin           |
| Activate / deactivate pipelines             | `MANAGE_PIPELINES`         | Project Admin, Account Admin           |
| Execute pipelines manually                  | `EXECUTE_PIPELINES`        | Project Admin, Account Admin, Operator |
| View pipeline definitions and executions    | `VIEW_PIPELINES`           | All project members                    |
| Cancel running executions                   | `EXECUTE_PIPELINES`        | Project Admin, Account Admin, Operator |
| View activity registry                      | _(any authenticated user)_ | Everyone                               |

---

## 9. Multi-Platform Consumption

### 9.1 The Problem Restated

AMP workflows write to AMP's stores (ClickHouse tables, Kafka topics, Redis, WebSocket). abl-platform needs to trigger evaluation workflows but store results in its own stores. The activities determine the destination, not the caller — so if abl-platform starts an AMP workflow on the same task queue, results still go to AMP's ClickHouse.

### 9.2 How the Custom Pipeline Engine Solves This

The pipeline definition itself controls output routing via the `store-results` step config. Two pipelines can run the same evaluation logic but write to different destinations:

**AMP tenant's pipeline — stores to ClickHouse:**

```json
{
  "name": "AMP Safety Evaluation",
  "tenantId": "amp-tenant-001",
  "trigger": { "type": "event", "eventType": "session.processed" },
  "steps": [
    {
      "id": "eval",
      "type": "evaluate-metrics",
      "config": { "metrics": ["toxicity", "bias"] }
    },
    {
      "id": "store",
      "type": "store-results",
      "config": {
        "destination": "clickhouse",
        "table": "trace_metrics"
      }
    }
  ]
}
```

**abl-platform's pipeline — stores via HTTP callback:**

```json
{
  "name": "abl Evaluation Pipeline",
  "tenantId": "abl-tenant-001",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "eval",
      "type": "evaluate-metrics",
      "config": { "metrics": ["accuracy", "relevance"] }
    },
    {
      "id": "store",
      "type": "store-results",
      "config": {
        "destination": "callback",
        "callbackUrl": "http://runtime:3100/api/eval-results"
      }
    }
  ]
}
```

Same `evaluate-metrics` activity type. Same `store-results` activity type. Same pipeline worker. Different config → different destination.

### 9.3 Architecture — Single Worker, Shared Registry

```
┌───────────────────────────────────────────────────────────────────┐
│                     Temporal Server (temporal:7233)                │
│                                                                    │
│  System workflows (unchanged)                                      │
│  ├── metrics-evaluation queue  → AMP metrics-eval worker           │
│  ├── policy-evaluation queue   → AMP policy-eval worker            │
│  ├── acp-processing queue      → AMP processing worker             │
│  └── email-digest queue        → AMP alert worker                  │
│                                                                    │
│  Custom pipeline engine                                            │
│  └── custom-pipeline queue     → Pipeline worker (shared)          │
│       ├── AMP pipelines → evaluate → store to ClickHouse           │
│       └── abl pipelines → evaluate → store via HTTP callback       │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

One pipeline worker serves both platforms. The activity types are the same. The pipeline definitions are tenant-isolated — each tenant's pipelines live in their own MongoDB documents, scoped by `tenantId`.

### 9.4 How abl-platform Creates and Triggers Pipelines

abl-platform already has `TemporalClientBase` wired into its Express runtime (from the merge work). It can interact with the pipeline engine in three ways:

**Option A: Create pipelines via the Pipeline API**

abl-platform calls the AMP pipeline service's REST API to create and manage pipelines:

```typescript
// abl-platform route handler — create a pipeline
const response = await fetch(
  'http://project-service:3001/api/v1/accounts/abl-tenant-001/pipelines',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_KEY },
    body: JSON.stringify({
      name: 'abl Evaluation Pipeline',
      trigger: { type: 'manual' },
      steps: [
        { id: 'eval', type: 'evaluate-metrics', config: { metrics: ['accuracy'] } },
        {
          id: 'store',
          type: 'store-results',
          config: { destination: 'callback', callbackUrl: 'http://runtime:3100/api/eval-results' },
        },
      ],
    }),
  },
);
const pipeline = await response.json();

// Later — trigger execution
await fetch(
  `http://project-service:3001/api/v1/accounts/abl-tenant-001/pipelines/${pipeline._id}/execute`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_KEY },
    body: JSON.stringify({ tenantId: 'abl-tenant-001', projectId: 'p-123', sessionId: 's-456' }),
  },
);
```

**Option B: Start the workflow directly via Temporal client**

abl-platform can bypass the API and start the Temporal workflow directly with a pipeline definition inline:

```typescript
import { getTemporalClient } from './services/temporal-service.js';

const pipelineDefinition = {
  steps: [
    { id: 'eval', type: 'evaluate-metrics', config: { metrics: ['accuracy'] } },
    {
      id: 'store',
      type: 'store-results',
      config: { destination: 'callback', callbackUrl: 'http://runtime:3100/api/eval-results' },
    },
  ],
};

const client = getTemporalClient();
await client.startWorkflowByName(
  'executeCustomPipeline',
  [
    {
      pipelineDefinition,
      pipelineInput: { tenantId: 'abl-tenant-001', projectId: 'p-123', sessionId: 's-456' },
    },
  ],
  {
    workflowId: `pipeline-abl-${Date.now()}`,
    taskQueue: 'custom-pipeline',
  },
);
```

**Option C: Receive results via HTTP callback**

When the `store-results` step uses `destination: 'callback'`, it POSTs the results to abl-platform's endpoint:

```typescript
// abl-platform route handler — receive pipeline results
app.post('/api/eval-results', async (req, res) => {
  const { tenantId, projectId, sessionId, stepOutputs, timestamp } = req.body;

  // Store in abl-platform's own database
  await ablDatabase.insert('evaluation_results', {
    tenantId,
    projectId,
    sessionId,
    results: stepOutputs,
    evaluatedAt: timestamp,
  });

  // Update abl-platform UI (WebSocket, server-sent events, etc.)
  ablEventBus.emit('evaluation:complete', { tenantId, projectId, sessionId });

  res.sendStatus(200);
});
```

### 9.5 Side-by-Side Flow Comparison

**AMP tenant admin's pipeline:**

```
1. Tenant admin creates pipeline via AMP UI
2. Session is processed → Kafka event 'session.processed'
3. Pipeline trigger service matches event → finds active pipeline
4. Starts Temporal workflow: executeCustomPipeline
5. Pipeline worker runs steps:
   a. evaluate-metrics → calls MetricsEvaluationService
   b. evaluate-policy → calls PolicyEvaluationService
   c. send-notification (conditional) → sends Slack alert
   d. store-results → inserts into ClickHouse trace_metrics
6. Results visible in AMP dashboard
```

**abl-platform:**

```
1. abl-platform creates pipeline via API or uses inline definition
2. abl-platform triggers pipeline manually via API or Temporal client
3. Starts Temporal workflow: executeCustomPipeline (same workflow)
4. Pipeline worker runs steps (same worker, same activity types):
   a. evaluate-metrics → calls MetricsEvaluationService (same logic)
   b. store-results → HTTP POST to http://runtime:3100/api/eval-results
5. abl-platform receives callback, stores in its own database
6. Results visible in abl-platform UI
```

### 9.6 Optional: Separate Task Queues Per Platform

If abl-platform needs activity types that don't exist in AMP (or vice versa), each platform can run its own pipeline worker on a separate task queue:

```
custom-pipeline       → shared pipeline worker (default)
custom-pipeline-abl   → abl-platform pipeline worker (abl-specific activities)
```

The `taskQueue` field on the pipeline definition controls which worker picks it up:

```json
{
  "name": "abl-specific Pipeline",
  "taskQueue": "custom-pipeline-abl",
  "steps": [...]
}
```

This is an escape hatch — not needed for v1. The shared worker covers both platforms because activity types are universal (evaluate, store, notify). Separate queues become useful when platforms diverge in capabilities.

---

## 10. File Locations (Planned)

```
packages/amp-temporal/src/pipeline/
  ├── pipeline-activity.interface.ts       # PipelineActivityType, PipelineStepContext, StepOutput
  ├── activity-registry.ts                 # PipelineActivityRegistry, ActivityTypeInfo
  ├── expression-evaluator.ts              # evaluateExpression(), isSafeExpression(), extractStepReferences()
  ├── workflows/
  │   └── execute-custom-pipeline.workflow.ts  # The generic DAG interpreter workflow
  ├── activities/
  │   ├── execute-step.activity.ts         # Step executor — dispatches to registry
  │   ├── evaluate-metrics.activity.ts     # Built-in: wraps MetricsEvaluationService
  │   ├── evaluate-policy.activity.ts      # Built-in: wraps PolicyEvaluationService
  │   ├── store-results.activity.ts        # Built-in: ClickHouse / MongoDB / HTTP callback
  │   ├── send-notification.activity.ts    # Built-in: Slack / email / webhook / WebSocket
  │   ├── transform.activity.ts            # Built-in: data reshaping between steps
  │   └── run-system-workflow.activity.ts  # Built-in: bridge to system workflows
  └── schemas/
      ├── pipeline-definition.schema.ts    # Mongoose schema for pipeline_definitions
      └── pipeline-execution.schema.ts     # Mongoose schema for pipeline_executions

apps/amp/project-service/src/modules/pipeline/
  ├── pipeline.module.ts                   # NestJS module — imports, providers, controllers
  ├── controllers/
  │   ├── pipeline.controller.ts           # CRUD + activate/deactivate/clone
  │   ├── pipeline-execution.controller.ts # Execute + list/get/cancel executions
  │   └── pipeline-activity.controller.ts  # GET /pipeline-activities (read-only registry)
  ├── services/
  │   ├── pipeline.service.ts              # Business logic + validation
  │   ├── pipeline-execution.service.ts    # Execution lifecycle management
  │   └── pipeline-trigger.service.ts      # Kafka event matching + Temporal schedule registration
  └── dto/
      ├── create-pipeline.dto.ts           # Validation DTO for POST
      ├── update-pipeline.dto.ts           # Validation DTO for PATCH
      └── execute-pipeline.dto.ts          # Validation DTO for manual execution input
```
