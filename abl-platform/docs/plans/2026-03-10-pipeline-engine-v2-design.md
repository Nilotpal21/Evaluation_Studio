# Pipeline Engine v2 — Architecture Design

> Consolidated architecture reference for the ABL Platform Pipeline Engine.
> Captures the as-built system on the `feature/pipeline-engine-v2` branch.

## 1. Overview

The Pipeline Engine is a Restate-backed analytics execution system that processes conversation events from Kafka, runs them through configurable analysis pipelines (sentiment, intent, quality, etc.), and stores results in ClickHouse.

**v2** introduces graph-based pipeline execution alongside the existing linear (step-array) model. The core innovation is an **execution context** system that decouples data flow from node IDs, enabling user-defined graph topologies without manual data plumbing.

### Key Properties

- **Durable execution** via Restate workflows (survives crashes, queryable state)
- **Graph and linear modes** coexist with full backward compatibility
- **Implicit data flow** via well-known context keys (no `sourceStep` config)
- **Parallel fan-out** via node-groups with automatic context extraction
- **Config-driven node types** backed by MongoDB with trait-based field injection
- **Pipeline provenance** — every activity receives `pipelineId` and `pipelineType` for ClickHouse lineage
- **Provider-neutral LLM client** with 3-step credential resolution from MongoDB
- **Comprehensive validation** — structural, graph, trigger, and model-provider compatibility checks
- **25+ activity types** with static metadata registry for schema introspection

---

## 2. Architecture

### Three-Tier Execution Model

```
PipelineRun (Restate Workflow)
    │  orchestrates node execution via transitions
    ▼
ActivityRouter (Restate Service)
    │  dispatches to the correct activity handler
    ▼
Activity Services (compute-sentiment, read-conversation, store-results, ...)
```

**PipelineRun** (`pipeline-run.workflow.ts`) is the durable workflow entry point. It determines execution mode (graph or linear), walks the pipeline, accumulates the execution context, and tracks overall status.

**ActivityRouter** (`activity-router.service.ts`) receives each node/step, merges configuration layers (pipeline-wide → step overrides → trigger overrides → node type definition), builds the `PipelineStepContext`, and calls the appropriate activity handler. Special node types (`node-group`, `wait-for-event`, `delay`) are handled inline.

**Activity Services** are stateless Restate services — each implements a single `execute` handler that receives `PipelineStepContext` and returns `StepOutput`.

### Key Files

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `pipeline/handlers/pipeline-run.workflow.ts`   | Durable workflow orchestrator                               |
| `pipeline/handlers/activity-router.service.ts` | Activity dispatcher + node-group fan-out                    |
| `pipeline/execution-context.ts`                | Context utilities (derive, resolve, build)                  |
| `pipeline/graph-walker.ts`                     | Pure graph traversal (reference/testing)                    |
| `pipeline/graph-utils.ts`                      | Graph analysis, expression evaluator                        |
| `pipeline/types.ts`                            | Core types                                                  |
| `pipeline/trait-merger.ts`                     | Trait-based field injection                                 |
| `pipeline/node-registry.ts`                    | In-memory registry (loaded from MongoDB)                    |
| `pipeline/activity-metadata.ts`                | Static metadata registry for all activity types             |
| `pipeline/validation.ts`                       | Pipeline validation (linear, graph, triggers, model compat) |
| `pipeline/services/llm-client-factory.ts`      | Provider-neutral LLM client with credential resolution      |
| `pipeline/schemas/init-analytics-tables.ts`    | ClickHouse analytics table DDL + materialized views         |
| `schemas/node-type-definition.schema.ts`       | Mongoose schema for node types                              |

All paths relative to `packages/pipeline-engine/src/`.

---

## 3. Execution Modes

### Graph Mode (New)

Pipelines define a DAG of `PipelineNode[]` with an `entryNodeId`. Traversal is condition-driven via `NodeTransition[]`.

```typescript
interface PipelineNode {
  id: string;
  type: string; // Activity type (e.g., 'compute-sentiment')
  label?: string;
  config: Record<string, any>;
  transitions: NodeTransition[]; // Where to go next
  children?: GroupChildNode[]; // For node-group: parallel children
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
  maxVisits?: number; // Loop guard
  position?: { x: number; y: number };
}

interface NodeTransition {
  target: string; // Next node ID
  condition?: string; // Expression to evaluate
  order?: number; // Evaluation order
  label?: string;
}
```

**Data flow:** Execution context (well-known keys). Nodes read from context keys, not node IDs.

### Linear Mode (Legacy)

Pipelines define a `PipelineStep[]` array. Steps execute sequentially by array index. Parallel steps share a `parallel` tag and are collapsed into a `node-group` at runtime via `stepsToGraph()`.

**Data flow:** `previousSteps[stepId].data`. Services locate upstream data via `config.sourceStep`.

### Coexistence

Both modes share `PipelineDefinition`:

```typescript
interface PipelineDefinition {
  // Graph mode
  nodes?: PipelineNode[];
  entryNodeId?: string;
  onNodeFailure?: 'stop' | 'skip' | 'continue';

  // Linear mode
  steps?: PipelineStep[];
  onStepFailure?: 'stop' | 'skip' | 'continue';

  // Shared
  _id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  trigger?: {
    type: string;
    kafkaTopic?: string;
    eventFilter?: Record<string, any>;
    schedule?: string;
  };
  // ...
}
```

Mode detection: if `nodes` and `entryNodeId` are present → graph mode; otherwise → linear mode.

---

## 4. Execution Context

### Problem

In linear pipelines, compute services read upstream data via `config.sourceStep`:

```typescript
// OLD: tight coupling to node IDs
const sourceStep = input.config.sourceStep ?? 'read-conversation';
const data = input.previousSteps[sourceStep]?.data;
```

In graph pipelines with user-defined node IDs (`read-conv`, `my-reader`, etc.), users would have to manually set `sourceStep` in every node's config — defeating the purpose of a visual graph editor.

### Solution: Well-Known Context Keys

Each node type declares a **context key** — a well-known string that it writes its output to. Downstream nodes read from this key, not from node IDs.

```
read-conversation  → writes to context['conversation']
compute-sentiment  → reads context['conversation'], writes to context['sentiment']
compute-intent     → reads context['conversation'], writes to context['intent']
store-results      → reads context['sentiment'], context['intent']
```

The execution context is a flat `Record<string, Record<string, any>>` accumulated as nodes execute.

### Context Key Registry

Stored in `NodeTypeDefinitionDoc.contextKey` (MongoDB):

| Node Type                                | contextKey             |
| ---------------------------------------- | ---------------------- |
| `read-conversation`                      | `conversation`         |
| `read-message-window`                    | `messageWindow`        |
| `compute-sentiment`                      | `sentiment`            |
| `compute-intent`                         | `intent`               |
| `compute-quality`                        | `quality`              |
| `compute-mentions`                       | `mentions`             |
| `conversation-analyzer`                  | `conversationAnalyzer` |
| `compute-toxicity`                       | `toxicity`             |
| `compute-tool-effectiveness`             | `toolEffectiveness`    |
| `compute-statistical`                    | `statistical`          |
| `compute-predictive-features`            | `predictiveFeatures`   |
| `evaluate-metrics`                       | `metrics`              |
| `evaluate-policy`                        | `policy`               |
| `call-llm`                               | `llmResult`            |
| Consumer nodes (`store-*`, `node-group`) | `null`                 |

### Core Functions

All in `pipeline/execution-context.ts`.

#### `deriveContextKey(nodeType: string): string | null`

Implicit derivation when no explicit `contextKey` is set. Strips verb prefix (`read-`, `compute-`, `evaluate-`, `call-`) and converts kebab-case to camelCase:

```typescript
'read-conversation'          → 'conversation'
'conversation-analyzer'     → 'conversationAnalyzer'
'compute-tool-effectiveness' → 'toolEffectiveness'
'store-results'              → null  // non-producer
```

#### `resolveContextInput(input: PipelineStepContext, contextKey: string): Record<string, any> | undefined`

Two-tier resolution for backward compatibility:

1. **Graph mode:** Check `input.executionContext[contextKey]`
2. **Linear fallback:** Check `input.previousSteps[input.config.sourceStep ?? 'read-conversation'].data`

Returns `undefined` if unavailable. Returns empty objects `{}` when they exist in context (distinguishes "not present" from "present but empty").

#### `buildExecutionContext(context, nodeType, result, contextKey, children?): void`

Writes node outputs into the shared execution context after each node executes.

**Regular nodes:** Writes `result.data` under the node's context key (explicit or derived). Only writes on `status: 'success'`.

**Node-group nodes:** Extracts each child's output from `result.data.children[childId]`, derives each child's context key from its type, and writes each child's data under its key. This makes child outputs available to downstream nodes via the execution context.

### Service Migration Pattern

All compute services were migrated from `sourceStep` lookup to `resolveContextInput`:

```typescript
// BEFORE
const sourceStep = (input.config.sourceStep as string) ?? 'read-conversation';
const conversationStep = input.previousSteps[sourceStep];
if (!conversationStep || conversationStep.status !== 'success') { ... }
let messages = conversationStep.data.messages;

// AFTER
const conversationData = resolveContextInput(input, 'conversation');
if (!conversationData) { ... }
let messages = conversationData.messages;
```

Migrated services: `compute-sentiment`, `compute-intent`, `compute-quality`, `compute-mentions`, `compute-statistical`, `conversation-analyzer`.

---

## 5. Graph Walker & Traversal

### Pure Graph Walker

`walkGraph()` in `graph-walker.ts` is a pure function (no Restate dependency) used for testing and as a reference implementation:

```typescript
async function walkGraph(
  nodes: PipelineNode[],
  entryNodeId: string,
  pipelineInput: Record<string, any>,
  executeNode: NodeExecutorFn,
  options?: { defaultOnFailure?: 'stop' | 'skip' | 'continue'; maxVisitsHardCap?: number },
): Promise<GraphWalkResult>;
```

**Algorithm:**

1. Build node map (`id → PipelineNode`)
2. Start at `entryNodeId`
3. For each node: check visit count → execute → handle failure strategy → resolve next transition → continue or exit

**Loop guards:**

- Default: 1 visit per node
- Configurable via `node.maxVisits`
- Hard cap: `maxVisitsHardCap` (default 100)
- Violations → `fail` status + break

### Restate Integration

The actual production implementation in `runGraphMode()` (`pipeline-run.workflow.ts`) integrates with Restate:

```typescript
async function runGraphMode(ctx: restate.WorkflowContext, input: PipelineRunInput) {
  const nodeOutputs: Record<string, StepOutput> = {};
  const executionContext: Record<string, Record<string, any>> = {};
  const visitCounts: Record<string, number> = {};

  let currentNodeId: string | null = entryNodeId;

  while (currentNodeId) {
    const node = nodeMap.get(currentNodeId);
    // ... loop guard checks ...

    // Execute via ActivityRouter (durable call)
    const result = await ctx.serviceClient(activityRouter).execute({
      step: { id, type, config, ...(node.children ? { children } : {}) },
      previousSteps: nodeOutputs,
      executionContext,
      pipelineInput,
      resolvedConfig,
      executionMode,
      triggerId,
      pipelineId: pipelineDefinition._id,
      pipelineType: pipelineDefinition.tenantId === '__platform__' ? 'builtin' : 'custom',
    });

    nodeOutputs[node.id] = result;
    buildExecutionContext(executionContext, node.type, result, undefined, node.children);

    currentNodeId = resolveTransition(node.transitions, result, context);
  }
}
```

Key differences from the pure walker:

- Node execution goes through Restate's `ctx.serviceClient()` for durability
- Execution context is passed to the ActivityRouter and propagated to activity services
- State survives crashes; execution is queryable via `getStatus()` shared handler

### Transition Resolution

`resolveTransition()` in `graph-utils.ts` evaluates transitions in order:

1. Sort transitions by `.order` (undefined → end)
2. For each transition: if no `.condition` → unconditional match; if condition matches → return target
3. If no match → return `null` (end of graph)

**Condition expression evaluator** supports:

- Comparisons: `==`, `!=`, `>`, `<`, `>=`, `<=`
- Logical: `&&`, `||`, `!`
- Dot-path access: `output.score`, `context.input.x`
- Literals: strings, numbers, booleans, null
- Parentheses for grouping

Example:

```typescript
transitions: [
  { target: 'store-results', condition: 'output.confidence >= 0.8', order: 1 },
  { target: 'retry-node', condition: 'output.confidence > 0.5', order: 2 },
  { target: 'fail-handler' }, // unconditional fallback
];
```

---

## 6. Node Type System

### Config-Driven Registry

Node type definitions are stored in MongoDB (`node_type_definitions` collection) instead of hardcoded TypeScript. This enables:

- Studio rendering accurate config forms dynamically
- Tenant-level type overrides
- Runtime registration without code changes

```typescript
interface NodeTypeDefinitionDoc {
  _id: string; // e.g., 'compute-sentiment'
  tenantId: string; // 'SYSTEM' or tenant ID
  label: string;
  description: string;
  category: 'data' | 'logic' | 'integration' | 'compute' | 'action';
  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout: number;
  defaultRetries: number;
  retryable?: boolean;
  requiredCapabilities?: string[];
  contextKey?: string; // Well-known output key
  traits: NodeTrait[]; // 'compute' | 'llm' | 'storage'
  configSchema: ConfigFieldDefinition[];
  outputSchema?: Record<string, { type: string; description: string }>;
  storageSchema?: { tables: StorageTableDefinition[] };
  version: number;
  isActive: boolean;
}
```

### Trait System

Traits auto-inject standard fields into node type config schemas. Three traits exist:

| Trait     | Auto-Injected Fields                                               | Applied To                       |
| --------- | ------------------------------------------------------------------ | -------------------------------- |
| `compute` | _(none — execution context replaced `sourceStep`)_                 | All `compute-*` nodes            |
| `llm`     | `model` (string, optional) — LLM model override                    | Nodes that call an LLM           |
| `storage` | `skipDirectWrite` (boolean, default false) — skip ClickHouse write | `store-results`, `store-insight` |

### Trait Merger

`mergeTraitFields()` in `trait-merger.ts` combines trait fields into `configSchema`, deduplicating by field name:

```typescript
function mergeTraitFields(doc: NodeTypeDefinitionDoc): ConfigFieldDefinition[] {
  const existingNames = new Set(doc.configSchema.map((f) => f.name));
  const merged = [...doc.configSchema];

  for (const trait of doc.traits) {
    const traitFields = TRAIT_FIELDS[trait];
    if (!traitFields) continue;
    for (const field of traitFields) {
      if (!existingNames.has(field.name)) {
        merged.push(field);
        existingNames.add(field.name);
      }
    }
  }
  return merged;
}
```

### Node Registry

In-memory `Map<string, NodeTypeDefinition>` loaded from MongoDB docs with trait merger applied. Bounded to 200 entries (practical upper bound: ~35 SYSTEM types + tenant overrides).

```typescript
class NodeRegistry {
  loadFromDocs(docs: NodeTypeDefinitionDoc[]): void; // Bulk load with trait merging
  get(type: string): NodeTypeDefinition | undefined;
  list(filters?: { category?; capabilities? }): NodeTypeDefinition[];
  validateConfig(type: string, config: Record<string, unknown>): ValidationResult;
}
```

---

## 7. Node-Group Parallel Execution

Node-groups represent parallel execution as a single node with `children`:

```typescript
{
  id: "parallel-analysis",
  type: "node-group",
  children: [
    { id: "sentiment", type: "compute-sentiment", config: {} },
    { id: "intent", type: "compute-intent", config: {} },
  ],
  transitions: [{ target: "store-all" }],
}
```

### Fan-Out Execution

`executeNodeGroup()` in the ActivityRouter:

1. Maps children to individual step descriptors
2. Fans out all children in parallel via `restate.CombineablePromise.all()`
3. Each child receives the same `executionContext` (read-only for children)
4. Collects results into `{ children: { [childId]: StepOutput } }`
5. Overall status: `fail` if any child failed, `success` otherwise

### Context Extraction

After a node-group completes, `buildExecutionContext()` in the graph walker:

1. Iterates `result.data.children`
2. For each child, derives its context key from its type
3. Writes each child's data under its derived key

This makes child outputs available to all downstream nodes via the execution context, as if they had executed as top-level nodes.

---

## 8. Graph Utilities

All in `pipeline/graph-utils.ts`.

### `stepsToGraph(steps: PipelineStep[]): { nodes, entryNodeId }`

Converts legacy step arrays to graph structure for unified execution:

- Sequences steps with unconditional transitions
- Collapses steps sharing a `parallel` tag into `node-group` nodes with children
- Enables linear pipelines to run through the graph walker

### `findReachableNodes(nodes, entryNodeId): Set<string>`

BFS traversal returning all reachable node IDs. Includes node-group children. Used for validation (detecting orphan nodes).

### `detectBackEdges(nodes, entryNodeId): Array<{ from, to }>`

DFS-based cycle detection. Returns back-edges (cyclic transitions). Used for validation warnings — cycles are allowed when nodes have `maxVisits > 1`, but flagged for review.

### Pipeline Validation

`validateGraphPipeline()` checks:

- `entryNodeId` exists and references a valid node
- All transition targets reference valid nodes
- No duplicate node IDs
- No multiple unconditional transitions from a single node
- Reachability analysis (warn on orphans)
- Trigger validation (kafka requires `kafkaTopic`, platform topics require `eventFilter`)

---

## 9. Validation

All in `pipeline/validation.ts`.

The validation system operates in layers, each checking different concerns:

### Structural Validation (`validatePipeline`)

Validates both old-format (single trigger + steps) and new-format (supportedTriggers + strategies) pipelines:

- **Step validation:** Duplicate IDs, unknown activity types (checked against `ACTIVITY_TYPES` or `NodeRegistry`), condition expression safety, step reference ordering, contiguous parallel groups
- **Trigger validation:** Kafka requires `kafkaTopic`, schedule requires cron expression, platform event topics (`abl.*`) require `eventFilter` for scoping
- **Strategy validation:** Each strategy has at least one step, trigger → strategy references resolve

### Graph Validation (`validateGraphPipeline`)

Validates graph-based pipelines against a `NodeRegistry`:

- **Node types:** All types (including node-group children) exist in registry
- **Config schemas:** Node configs validated against registry-defined schemas
- **Transitions:** All targets reference existing nodes, no multiple unconditional transitions
- **Reachability:** BFS from `entryNodeId` — unreachable nodes produce warnings
- **Cycle detection:** DFS back-edge detection — warns if loop targets lack `maxVisits > 1`
- **Trigger rules:** Schedule triggers rejected (not yet supported for graph pipelines)

### Model-Provider Compatibility (`validateNodeModels`)

Async validation that resolves the tenant's LLM provider from MongoDB and checks that any `config.model` overrides are compatible:

```typescript
// Prevents saving a pipeline with "gpt-4o-mini" on an Anthropic-configured tenant
await validateNodeModels(definition, tenantId);
```

Resolution chain: `TenantModel(isDefault, isActive, inferenceEnabled)` → provider detection via model name patterns (`/^claude-/i` → anthropic, `/^(gpt-|o[134])/i` → openai).

---

## 10. LLM Client Factory

`pipeline/services/llm-client-factory.ts` provides a provider-neutral LLM client for all compute services that need LLM inference.

### Interface

```typescript
interface PipelineLLMClient {
  chat(request: PipelineChatRequest): Promise<PipelineChatResponse>;
}

interface PipelineChatRequest {
  messages: PipelineChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}
```

### 3-Step Credential Resolution

```
1. Project-scoped: ModelConfig(projectId, isDefault) → tenantModelId → TenantModel → LLMCredential
2. Tenant fallback: TenantModel(tenantId, isDefault, isActive, inferenceEnabled) → LLMCredential
3. FAIL: throw (no env var fallback)
```

Credentials are resolved from MongoDB at client creation time, not per-call. The `LLMCredential` document is fetched without `.lean()` so the encryption plugin auto-decrypts `encryptedApiKey`.

### Provider Support

- **Anthropic:** System prompt extracted as separate field, markdown code fences stripped from responses, JSON mode is prompt-enforced (no API-level `response_format`)
- **OpenAI:** Standard chat completions API, `response_format: { type: 'json_object' }` for JSON mode

Model-provider compatibility is enforced at call time — sending `gpt-4o-mini` to the Anthropic API throws immediately.

---

## 11. Activity Metadata Registry

`pipeline/activity-metadata.ts` is a static registry of all 25+ activity types with their config schemas, output schemas, timeouts, and retry counts.

### Activity Categories

| Category              | Activity Types                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Data**              | `read-conversation`, `read-message-window`                                                                                       |
| **Compute (LLM)**     | `compute-sentiment`, `compute-intent`, `compute-quality`, `compute-mentions`, `conversation-analyzer`, `compute-goal-completion` |
| **Compute (non-LLM)** | `compute-toxicity` (keyword/pattern), `compute-statistical` (friction/anomaly/drift), `compute-predictive-features`              |
| **Integration**       | `call-llm`, `http-request`                                                                                                       |
| **Evaluation**        | `evaluate-metrics`, `evaluate-policy`                                                                                            |
| **Storage**           | `store-results`, `store-insight`                                                                                                 |
| **Action**            | `send-notification`, `transform`                                                                                                 |
| **Bridge**            | `run-legacy-workflow` (Temporal bridge)                                                                                          |
| **Eval Pipeline**     | `simulate-persona`, `execute-agent-turn`, `run-eval-conversation`, `judge-conversation`, `aggregate-eval-run`                    |

Each entry defines `configSchema` (required fields, property types) and `outputSchema` (what the service returns). Used by `validatePipeline()` to check unknown types and by Studio for config form rendering.

---

## 12. Pipeline Provenance

Every node execution carries `pipelineId` and `pipelineType` through the full chain:

```
PipelineRun → ActivityRouter → PipelineStepContext → Activity Service → ClickHouse write
```

**`pipelineType`** is derived from `tenantId`:

- `'__platform__'` → `'builtin'` (system-seeded pipelines)
- anything else → `'custom'` (tenant-created pipelines)

All analytics ClickHouse tables include `pipeline_id` and `pipeline_type` columns (added via idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations). This enables:

- Filtering analytics results by which pipeline produced them
- Distinguishing built-in vs custom pipeline outputs in dashboards
- Tracing data lineage from ClickHouse rows back to pipeline definitions

---

## 13. Analytics Storage (ClickHouse)

`pipeline/schemas/init-analytics-tables.ts` manages all analytics output tables, materialized views, and schema migrations. Called once at pipeline engine startup; fully idempotent via `IF NOT EXISTS`.

### Output Tables (20+)

| Table                          | Written By                  | Engine             |
| ------------------------------ | --------------------------- | ------------------ |
| `message_sentiment`            | compute-sentiment           | ReplacingMergeTree |
| `conversation_sentiment`       | compute-sentiment           | ReplacingMergeTree |
| `intent_classifications`       | compute-intent              | ReplacingMergeTree |
| `quality_evaluations`          | compute-quality             | ReplacingMergeTree |
| `hallucination_evaluations`    | conversation-analyzer       | ReplacingMergeTree |
| `knowledge_gap_evaluations`    | conversation-analyzer       | ReplacingMergeTree |
| `guardrail_evaluations`        | conversation-analyzer       | ReplacingMergeTree |
| `context_evaluations`          | conversation-analyzer       | ReplacingMergeTree |
| `friction_detections`          | compute-statistical         | ReplacingMergeTree |
| `anomaly_detections`           | compute-statistical         | ReplacingMergeTree |
| `drift_detections`             | compute-statistical         | ReplacingMergeTree |
| `toxicity_evaluations`         | compute-toxicity            | ReplacingMergeTree |
| `message_toxicity`             | compute-toxicity            | ReplacingMergeTree |
| `goal_completions`             | compute-goal-completion     | ReplacingMergeTree |
| `conversation_mentions`        | compute-mentions            | ReplacingMergeTree |
| `conversation_outcomes`        | store-results               | ReplacingMergeTree |
| `customer_predictive_features` | compute-predictive-features | ReplacingMergeTree |
| `churn_risk_scores`            | compute-predictive-features | ReplacingMergeTree |
| `custom_events`                | store-results               | ReplacingMergeTree |
| `conversation_tags`            | store-results               | ReplacingMergeTree |
| `external_events`              | store-results               | ReplacingMergeTree |
| `experiment_assignments`       | store-results               | ReplacingMergeTree |

All tables use non-replicated engines — analytics outputs are derived data that can be recomputed from source tables. All have 730-day TTLs and are partitioned by `(tenant_id, toYYYYMM(...))`.

### Materialized Views (5)

| View                           | Aggregation                                            |
| ------------------------------ | ------------------------------------------------------ |
| `mv_daily_sentiment`           | Daily conversation sentiment rollup (SummingMergeTree) |
| `mv_daily_intent_distribution` | Daily intent distribution (SummingMergeTree)           |
| `mv_daily_quality_scores`      | Daily quality score rollup (SummingMergeTree)          |
| `mv_daily_custom_events`       | Daily custom event counts (SummingMergeTree)           |
| `mv_daily_outcomes`            | Daily conversation outcome rollup (SummingMergeTree)   |

MVs filter on `source = 'batch' OR source = ''` to exclude real-time per-message writes from daily aggregates.

### Schema Migrations

Idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements handle:

- `source` column on all output tables (default `'batch'` for backward compat)
- Real-time metadata (`trigger_id`, `message_index`, `window_size`) on per-message tables
- Pipeline provenance (`pipeline_id`, `pipeline_type`) across all tables
- Missing common columns (`project_id` on `message_sentiment`, `channel` on mentions/anomaly/drift)

---

## 14. Data Flow Example

Complete execution trace for a graph pipeline:

```
Pipeline:
  entryNodeId: "read-data"
  nodes:
    read-data (read-conversation) → parallel-group
    parallel-group (node-group)   → store-all
      children: [sentiment (compute-sentiment), intent (compute-intent)]
    store-all (store-results)     → (end)
```

**Step 1 — Initialize:**

```
nodeOutputs = {}
executionContext = {}
```

**Step 2 — Execute `read-data`:**

```
result = { status: 'success', data: { messages: [...], metadata: {...} } }
buildExecutionContext(ctx, 'read-conversation', result, 'conversation')
→ executionContext = { conversation: { messages: [...], metadata: {...} } }
```

**Step 3 — Transition:** `read-data` → `parallel-group`

**Step 4 — Execute `parallel-group` (node-group):**

Fan-out children in parallel. Both receive `executionContext = { conversation: {...} }`.

```
Child: sentiment (compute-sentiment)
  resolveContextInput(input, 'conversation') → { messages: [...] }
  result = { status: 'success', data: { avg: 0.8, trajectory: 'improving' } }

Child: intent (compute-intent)
  resolveContextInput(input, 'conversation') → { messages: [...] }
  result = { status: 'success', data: { intent: 'billing', confidence: 0.95 } }

Group result = { status: 'success', data: { children: { sentiment: {...}, intent: {...} } } }
```

**Step 5 — Extract children into context:**

```
buildExecutionContext(ctx, 'node-group', groupResult, null, children)
→ executionContext = {
    conversation: { messages: [...], metadata: {...} },
    sentiment: { avg: 0.8, trajectory: 'improving' },
    intent: { intent: 'billing', confidence: 0.95 },
  }
```

**Step 6 — Transition:** `parallel-group` → `store-all`

**Step 7 — Execute `store-all`:**

```
resolveContextInput(input, 'sentiment') → { avg: 0.8, ... }
resolveContextInput(input, 'intent')    → { intent: 'billing', ... }
result = { status: 'success', data: { written: 2 } }
```

**Step 8 — No transitions → graph complete.**

---

## 15. File Organization

```
packages/pipeline-engine/src/
├── pipeline/
│   ├── execution-context.ts              # deriveContextKey, resolveContextInput, buildExecutionContext
│   ├── graph-walker.ts                   # Pure graph traversal (reference/testing)
│   ├── graph-utils.ts                    # stepsToGraph, reachability, cycle detection, expression eval
│   ├── types.ts                          # PipelineNode, PipelineStepContext, StepOutput, NodeTypeDefinition, etc.
│   ├── trait-merger.ts                   # Trait-based config field injection
│   ├── node-registry.ts                  # In-memory registry loaded from MongoDB
│   ├── activity-metadata.ts              # Static metadata for 25+ activity types
│   ├── validation.ts                     # Pipeline validation (linear, graph, triggers, model compat)
│   ├── handlers/
│   │   ├── pipeline-run.workflow.ts      # Restate workflow (graph + linear modes)
│   │   └── activity-router.service.ts    # Activity dispatcher + node-group fan-out
│   ├── services/
│   │   ├── llm-client-factory.ts         # Provider-neutral LLM client + credential resolution
│   │   ├── compute-sentiment.service.ts  # Uses resolveContextInput
│   │   ├── compute-intent.service.ts     # Uses resolveContextInput
│   │   ├── compute-quality.service.ts    # Uses resolveContextInput
│   │   ├── compute-mentions.service.ts   # Uses resolveContextInput
│   │   ├── compute-statistical.service.ts    # Uses resolveContextInput
│   │   ├── conversation-analyzer.service.ts # Uses resolveContextInput
│   │   ├── compute-toxicity.service.ts   # Keyword/pattern scoring (zero AI cost)
│   │   ├── compute-goal-completion.service.ts # LLM-based goal completion eval
│   │   ├── read-conversation.service.ts
│   │   ├── store-results.service.ts
│   │   └── ...
│   ├── schemas/
│   │   └── init-analytics-tables.ts      # ClickHouse DDL, MVs, migrations (20+ tables)
│   └── seed-data/
│       └── node-type-definitions.json    # 35 SYSTEM node types with contextKey
├── schemas/
│   └── node-type-definition.schema.ts    # Mongoose schema
├── __tests__/
│   ├── execution-context.test.ts
│   ├── graph-walker.test.ts
│   ├── graph-utils.test.ts
│   ├── compute-*.test.ts                 # Per-service tests (sentiment, intent, quality, etc.)
│   ├── validation.test.ts
│   └── ...
└── index.ts                              # Public exports
```
