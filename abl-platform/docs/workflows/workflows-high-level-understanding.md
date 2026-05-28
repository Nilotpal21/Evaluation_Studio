# Workflows — High-Level Understanding

This document provides a comprehensive overview of the workflow system: its database schema, components, execution data flow, context resolution, and how users consume data across nodes.

---

## 1. Database Schema

### 1.1 Core Collections

```
Workflow (workflows)
  │
  ├── 1:N ──▶ WorkflowVersion (workflow_versions)         [workflowId]
  ├── 1:N ──▶ WorkflowExecution (workflow_executions)      [workflowId]
  ├── 1:N ──▶ WorkflowApiKey (workflow_api_keys)           [workflowId]
  ├── 1:N ──▶ TriggerRegistration (trigger_registrations)  [workflowId]
  └── 1:N ──▶ Session (sessions)                           [workflowId, optional]

WorkflowExecution
  ├── 1:N ──▶ HumanTask (human_tasks)   [source.workflowId + source.executionId]
  ├── embedded ──▶ NodeExecution[]       [inline array per execution]
  └── optional ──▶ restateWorkflowId     [Restate durable execution link]
```

### 1.2 Workflow (workflows)

The primary definition document. Stores the visual graph as nodes + edges.

| Field          | Type                     | Description                                                 |
| -------------- | ------------------------ | ----------------------------------------------------------- |
| `_id`          | UUIDv7                   | Primary key                                                 |
| `tenantId`     | string                   | Tenant scope                                                |
| `projectId`    | string                   | Project scope                                               |
| `name`         | string                   | Unique within (tenant, project)                             |
| `description`  | string                   | Human-readable description                                  |
| `nodes`        | `IWorkflowNode[]`        | Array of graph nodes (id, nodeType, name, position, config) |
| `edges`        | `IWorkflowEdge[]`        | Directed edges (id, source, sourceHandle, target, label)    |
| `envVars`      | `Record<string, string>` | Environment variables                                       |
| `inputSchema`  | JSON Schema              | Expected trigger input shape                                |
| `outputSchema` | JSON Schema              | Expected output shape                                       |
| `status`       | enum                     | `draft` / `active` / `archived`                             |
| `deployment`   | object                   | Endpoint slug, mode (sync/async), timeout, deployed version |
| `_v`           | number                   | Optimistic concurrency version                              |

**Indexes:** unique `(tenantId, projectId, name)`, `(tenantId, projectId, status)`, unique sparse on `deployment.endpointSlug`.

### 1.3 WorkflowVersion (workflow_versions)

Immutable snapshots for rollback/audit.

| Field        | Type          | Description                                                       |
| ------------ | ------------- | ----------------------------------------------------------------- |
| `workflowId` | FK → Workflow | Parent workflow                                                   |
| `version`    | number        | Monotonically increasing                                          |
| `definition` | object        | Full snapshot of nodes, edges, envVars, inputSchema, outputSchema |
| `changelog`  | string        | Description of what changed                                       |

### 1.4 WorkflowExecution (workflow_executions)

Runtime execution tracking — one record per workflow run.

| Field                                      | Type                      | Description                                                                                   |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------- |
| `workflowId`                               | FK → Workflow             | Which workflow was executed                                                                   |
| `status`                                   | enum                      | `running` / `waiting_human` / `completed` / `failed` / `cancelled`                            |
| `triggerType`                              | enum                      | `manual` / `api` / `trigger` / `schedule`                                                     |
| `input`                                    | object                    | Trigger payload                                                                               |
| `output`                                   | object                    | Final workflow output                                                                         |
| `nodeExecutions`                           | `INodeExecution[]`        | Per-node tracking (nodeId, nodeName, nodeType, status, input, output, error, timing, metrics) |
| `context`                                  | `Record<string, unknown>` | Final `WorkflowContextData` snapshot                                                          |
| `restateWorkflowId`                        | string                    | Link to Restate durable execution                                                             |
| `startedAt` / `completedAt` / `durationMs` | dates/number              | Timing                                                                                        |

### 1.5 Supporting Collections

- **WorkflowApiKey** — Per-workflow API key auth (keyHash, keyPrefix, TTL via `expiresAt`).
- **TriggerRegistration** — Webhook/polling/cron/event/connector subscriptions that auto-start executions.
- **HumanTask** — Human-in-the-loop tasks (approval, data_entry, review, decision, escalation) with form schemas, SLA tracking, and ITSM integration.

---

## 2. Components Involved

### 2.1 Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Studio (Next.js, port 5173)                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ WorkflowCanvas│  │  ConfigPanel │  │  DebugPanel   │  │
│  │  (ReactFlow)  │  │  (per-node)  │  │  (execution)  │  │
│  └──────┬────────┘  └──────┬───────┘  └──────┬────────┘  │
│         │  Next.js API Routes (BFF proxy)     │          │
└─────────┼─────────────────────────────────────┼──────────┘
          │                                     │
          ▼                                     ▼
┌──────────────────────────────────────────────────────────┐
│  Runtime (Express, port 3112)                            │
│  ┌──────────────┐  ┌────────────────────────────────┐   │
│  │ Workflow CRUD │  │ Workflow Engine Proxy           │   │
│  │ Routes        │  │ (executions, triggers, approvals)│  │
│  └──────┬────────┘  └──────────────┬─────────────────┘   │
│         │ MongoDB                   │ HTTP proxy          │
└─────────┼───────────────────────────┼────────────────────┘
          │                           │
          ▼                           ▼
┌──────────────────────────────────────────────────────────┐
│  Workflow Engine (port 9080)                             │
│  ┌────────────────┐  ┌───────────────┐  ┌────────────┐  │
│  │ Canvas-to-Steps│  │ Workflow      │  │ Step       │  │
│  │ Converter      │→ │ Handler       │→ │ Executors  │  │
│  └────────────────┘  └───────┬───────┘  └────────────┘  │
│                              │                           │
│  ┌───────────────┐  ┌───────┴───────┐  ┌────────────┐  │
│  │ Expression    │  │ Execution     │  │ Status     │  │
│  │ Resolver      │  │ Store (Mongo) │  │ Publisher  │  │
│  └───────────────┘  └───────────────┘  │ (Redis)    │  │
│                                         └────────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Restate (Durable Execution Framework)             │   │
│  │ — exactly-once, replay, durable sleep/promise     │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 2.2 Studio Components

| Component               | File                                                                 | Role                                                                 |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `WorkflowCanvasPage`    | `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` | Main page — fetches workflow, composes canvas + panels               |
| `WorkflowCanvas`        | `.../canvas/WorkflowCanvas.tsx`                                      | ReactFlow canvas — drag-drop, pan/zoom, node selection               |
| `AssetsSidebar`         | `.../canvas/panels/AssetsSidebar.tsx`                                | Node palette grouped by category                                     |
| `ConfigPanel`           | `.../canvas/panels/ConfigPanel.tsx`                                  | Right panel — dispatches to type-specific config editors             |
| `RunDialog`             | `.../canvas/panels/RunDialog.tsx`                                    | Execution input form                                                 |
| `WorkflowDebugPanel`    | `.../canvas/panels/WorkflowDebugPanel.tsx`                           | Debug panel — Input, Flow Log, Context, Output accordions            |
| `DebugFlowLog`          | `.../canvas/panels/DebugFlowLog.tsx`                                 | Step-by-step flow log with synthetic Start/End nodes                 |
| `StepLogItem`           | `.../canvas/panels/StepLogItem.tsx`                                  | Individual step detail — input, output, error, metrics               |
| `CanvasToolbar`         | `.../canvas/panels/CanvasToolbar.tsx`                                | Top toolbar — Run/Stop button (derives state from `executionStatus`) |
| `useExecutionPolling`   | `.../canvas/useExecutionPolling.ts`                                  | Polls execution API, updates overlay + `executionStatus` in store    |
| `workflow-canvas-store` | `apps/studio/src/store/workflow-canvas-store.ts`                     | Zustand store — node/edge state, execution state, serialization      |

**Node config editors** (one per type): `StartNodeConfig`, `EndNodeConfig`, `TextToTextNodeConfig`, `ApiNodeConfig`, `FunctionNodeConfig`, `ConditionNodeConfig`, `HumanNodeConfig`, `LoopNodeConfig`, `GenericNodeConfig`.

### 2.3 Workflow Engine Components

| Component                | File                                                      | Role                                                                              |
| ------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `convertCanvasToSteps()` | `apps/workflow-engine/src/handlers/canvas-to-steps.ts`    | Converts canvas graph → linear step array + nameToIdMap + outputMappings          |
| `runWorkflow()`          | `apps/workflow-engine/src/handlers/workflow-handler.ts`   | Core orchestrator — builds context, walks steps, resolves output mappings         |
| `dispatchStep()`         | `apps/workflow-engine/src/handlers/step-dispatcher.ts`    | Routes each step to its executor                                                  |
| `resolveExpression()`    | `apps/workflow-engine/src/context/expression-resolver.ts` | `{{path}}` template resolution with `context.` prefix and custom vars fallthrough |
| `ExecutionStore`         | `apps/workflow-engine/src/persistence/execution-store.ts` | MongoDB persistence for execution state (output, startTime, endTime)              |
| `StatusPublisher`        | (Redis Pub/Sub)                                           | Real-time events: `step.started`, `step.completed`, etc.                          |

### 2.4 Node Types (19 canvas types → 12 engine step types)

| Canvas Type        | Engine Step Type   | Category      | Description                        |
| ------------------ | ------------------ | ------------- | ---------------------------------- |
| `start`            | _(skipped)_        | flow_control  | Entry point                        |
| `end`              | _(skipped)_        | flow_control  | Exit point                         |
| `api`              | `http`             | action        | HTTP requests                      |
| `condition`        | `condition`        | flow_control  | Boolean branching                  |
| `delay`            | `delay`            | flow_control  | Durable sleep                      |
| `loop`             | `loop`             | flow_control  | Iterate over arrays                |
| `function`         | `transform`        | data          | Evaluate expression, store in vars |
| `integration`      | `connector_action` | action        | Third-party integrations           |
| `human`            | `human_task`       | human_in_loop | Approval, data entry, review       |
| `text_to_text`     | `agent_invocation` | ai            | LLM text generation                |
| `text_to_image`    | `agent_invocation` | ai            | Image generation                   |
| `audio_to_text`    | `agent_invocation` | ai            | Speech-to-text                     |
| `image_to_text`    | `agent_invocation` | ai            | Image understanding                |
| `agentic_app`      | `agent_invocation` | agent         | Invoke an agent                    |
| `agent`            | `agent_invocation` | agent         | Invoke an agent (alias)            |
| `tool`             | `tool_call`        | action        | Call a tool                        |
| `browser`          | _(stub)_           | action        | Browser automation                 |
| `doc_search`       | _(stub)_           | data          | Document search                    |
| `doc_intelligence` | _(stub)_           | data          | Document intelligence              |

---

## 3. Execution Data Flow

### 3.1 End-to-End Execution Sequence

```
1. USER clicks "Run" in Studio
   │
2. Studio sends POST /api/projects/:projectId/workflows/:workflowId/execute
   │  with { payload: { ... } }
   │
3. Runtime proxies to Workflow Engine → POST /execute
   │
4. Workflow Engine:
   │
   ├─ a) Reads workflow from MongoDB (nodes + edges)
   │     Validates unique node names (returns 400 DUPLICATE_NODE_NAMES if not)
   │
   ├─ b) convertCanvasToSteps(nodes, edges, { full: true })
   │      - Topological sort from Start node
   │      - Maps canvas nodeType → engine step type
   │      - Derives condition branches from edge sourceHandles
   │      - Attaches onSuccess/onFailure routing
   │      - Builds nameToIdMap (nodeName → nodeId for name-based step references)
   │      - Extracts outputMappings from End node config
   │      - Extracts startInputVariables from Start node config
   │
   ├─ c) Submits to Restate: restateClient.startWorkflow(executionId, input)
   │
   ├─ d) runWorkflow(input, restateCtx)
   │      - buildWorkflowContext(input, executionId)  →  initial ctx
   │        - ctx.steps['start'] = { input: triggerPayload }
   │      - Prepends synthetic "Start" step to nodeExecutions
   │      - For each step in queue:
   │          1. Mark step 'running' in MongoDB
   │          2. Publish 'step.started' via Redis
   │          3. dispatchStep(step, ctx) → executor
   │          4. Executor resolves {{expressions}} from ctx (supports context. prefix)
   │          5. Executor performs its work (HTTP call, LLM call, etc.)
   │          6. setStepContext(ctx, step, data)
   │             → writes to BOTH ctx.steps[step.id] AND ctx.steps[step.name]
   │          7. Mark step 'completed' in MongoDB
   │          8. Publish 'step.completed' via Redis
   │          9. Handle control flow (branching, loops, suspension)
   │
   └─ e) Final:
         - Resolve End node outputMappings against final ctx → execution.output
         - updateExecutionStatus('completed', { output, startTime, endTime })
         - Publish 'workflow.completed'
   │
5. POST /execute polls for completion (up to 30s):
   │  If completed: returns { success, executionId, startTime, endTime, output, status }
   │  If still running: returns 202 { success: true, executionId }
   │
6. Studio Debug Panel:
   - Polls GET /executions/:executionId every 2s during execution
   - Shows Flow Log: Start → step nodes → End (with resolved output)
   - Output accordion shows resolved output payload with copy icon
   - Panel stays open after completion until user closes it or starts a new run
```

> **Note:** The execute endpoint expects `{ "payload": {...} }`, not `{ "input": {...} }`. The field is `req.body.payload`.

### 3.2 Canvas-to-Steps Conversion

The canvas stores a graph (nodes + edges). Before execution, `convertCanvasToSteps()` linearizes this:

1. **Build edge lookup** — `Map<sourceNodeId, [{ sourceHandle, targetNodeId }]>`
2. **Find start node** — `nodeType === 'start'`
3. **BFS from start** — walk edges, skip `start`/`end` nodes (they're markers, not executable)
4. **Map each node** — `api` → `http`, `function` → `transform`, etc.
5. **Derive branching** — condition nodes: edges with `sourceHandle === 'else'` go to `elseSteps`, others to `thenSteps`
6. **Attach failure routing** — edges with `sourceHandle === 'on_failure'` / `'on_decline'` / `'on_timeout'` become `onFailureSteps`

---

## 4. Execution Context — The Central Data Structure

### 4.1 WorkflowContextData

Every workflow execution maintains a single mutable context object that accumulates data as steps execute:

```typescript
interface WorkflowContextData {
  trigger: {
    type: string; // 'manual' | 'api' | 'trigger' | 'schedule'
    payload: Record<string, unknown>; // The input data that started the execution
    metadata?: Record<string, unknown>;
  };
  workflow: {
    id: string; // Workflow definition ID
    name: string; // Workflow name
    executionId: string; // This execution's unique ID
  };
  tenant: {
    tenantId: string;
    projectId: string;
  };
  steps: Record<
    string,
    {
      // Populated as each step completes
      output: unknown; // The step's return value (object, string, array, etc.)
      status: string; // 'completed' | 'failed'
      durationMs?: number;
      completedAt?: string;
      error?: { code: string; message: string };
    }
  >;
  vars: Record<string, unknown>; // Workflow-level variables (set by transform/loop steps)
}
```

### 4.2 How Context Gets Populated

| Event                     | What happens to `ctx`                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow starts           | `trigger`, `workflow`, `tenant` are populated. `steps = { start: { input: triggerPayload } }`, `vars = {}`                                                |
| Step completes            | `ctx.steps[step.id]` AND `ctx.steps[step.name]` are both set to `{ output, status: 'completed', durationMs, completedAt }`                                |
| Step fails                | `ctx.steps[step.id]` AND `ctx.steps[step.name]` are both set to `{ output: null, status: 'failed', error: { code, message } }`                            |
| Transform (function) step | Additionally sets `ctx.vars[outputVariable] = evaluatedValue`                                                                                             |
| Loop step                 | Sets `ctx.vars[itemVariable] = currentItem` for each iteration                                                                                            |
| Workflow completes        | End node `outputMapping` expressions are resolved against `ctx`. Result stored as `execution.output`. Response includes `startTime`, `endTime`, `output`. |

### 4.3 Dual-Keyed Step References (Name + UUID)

Steps are indexed in `ctx.steps` by **both their UUID and their canvas node name**. The `setStepContext()` helper writes to both keys simultaneously:

```typescript
// After a step completes, both of these reference the same data:
ctx.steps['a1b2c3d4-...']; // UUID key
ctx.steps['API0001']; // name key (from the canvas node label)
```

This enables expressions like `{{context.steps.API0001.output.body}}` without knowing the UUID.

> **Note:** `Object.keys(ctx.steps)` includes both UUIDs and names. Tests checking step count must account for this doubling plus the synthetic `start` entry.

### 4.4 Start Node Input in Context

The `buildWorkflowContext()` function populates a synthetic `start` entry so that workflow input is accessible within expressions:

```typescript
ctx.steps['start'] = { input: triggerPayload };
```

Any node can reference the workflow input via `{{context.steps.start.input.orderId}}`.

### 4.5 End Node Output Mappings

The End node's config defines output variable mappings that are resolved when the workflow completes:

```json
// End node config (Studio EndNodeConfig panel)
{
  "outputMapping": {
    "result": "{{context.steps.API0001.output.body}}",
    "customerId": "{{context.steps.API0001.output.body.userId}}"
  }
}
```

Each expression is resolved against the final `ctx` using `resolveExpressionTyped()` (preserving types). The resolved output is:

- Persisted on the `WorkflowExecution` document as `output`
- Returned in the `POST /execute` response as `{ success, executionId, startTime, endTime, output, status }`
- Shown in the Debug Panel's Output accordion and End node in the Flow Log

### 4.6 Node Name Uniqueness

Node names **must be unique** within a workflow. This is enforced at two levels:

1. **Studio store** — `updateNodeName()` silently rejects duplicate names
2. **Server-side** — the execute route validates unique names and returns `400 DUPLICATE_NODE_NAMES` if violated

The `useWorkflowValidation` hook also flags duplicates as errors in the UI.

---

## 5. Expression Resolution — Dynamic Data Access

### 5.1 Syntax

Expressions use **mustache-style** `{{path}}` templates. The path is a dot-separated traversal into the `WorkflowContextData` object.

An optional `context.` prefix is supported — it is stripped before resolution, making both forms equivalent:

```
// Without prefix (original form — still works)
{{trigger.payload.orderId}}
{{steps.API0001.output.body}}
{{vars.retryCount}}

// With context. prefix (recommended for clarity)
{{context.trigger.payload.orderId}}
{{context.steps.API0001.output.body}}
{{context.steps.start.input.orderId}}
{{context.vars.retryCount}}

// Custom variables via context prefix
{{context.myCustomVar}}   →  resolves to ctx.vars.myCustomVar

// Standard paths (always available)
{{workflow.executionId}}
{{tenant.tenantId}}
```

**Custom vars fallthrough:** When the first segment after `context.` is not a known top-level key (`trigger`, `workflow`, `tenant`, `steps`, `vars`), the resolver prepends `vars.` automatically. So `{{context.myCustomVar}}` resolves to `ctx.vars.myCustomVar`.

**Name-based step references:** Steps are keyed by both UUID and canvas node name. Use the human-readable name: `{{context.steps.API0001.output.body}}` instead of `{{steps.a1b2c3d4-....output.body}}`.

### 5.2 Resolution Functions

| Function                                    | Behavior                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveExpression(template, ctx)`          | Replaces all `{{path}}` with `String(value)`. Always returns a string.                                                                                                                   |
| `resolveExpressionTyped(template, ctx)`     | If the template is **exactly** one `{{path}}` with no surrounding text, returns the **typed value** (preserving objects, arrays, numbers). Otherwise falls back to string interpolation. |
| `resolveExpressionMap(map, ctx)`            | Resolves all values in a `Record<string, string>` (used for HTTP headers).                                                                                                               |
| `resolveExpressionWithTrace(template, ctx)` | Returns both the resolved value AND an array of `ExpressionTrace` objects for debugging.                                                                                                 |

### 5.3 How Resolution Works Internally

```typescript
// 1. Regex finds all {{...}} patterns
const EXPRESSION_PATTERN = /\{\{(.+?)\}\}/g;

// 2. For each match, traverse the context object
const KNOWN_TOP_LEVEL_KEYS = new Set(['trigger', 'workflow', 'tenant', 'steps', 'vars']);

function getNestedValue(obj: unknown, path: string): unknown {
  // Strip optional `context.` prefix
  const normalizedPath = path.startsWith('context.') ? path.slice(8) : path;
  const parts = normalizedPath.split('.');

  // Unknown top-level key → treat as custom var (prepend 'vars')
  if (!KNOWN_TOP_LEVEL_KEYS.has(parts[0])) {
    parts.unshift('vars');
  }

  let current = obj;
  for (const part of parts) {
    current = current[part];  // walk down the tree
  }
  return current;
}

// 3. String templates: interpolate all expressions into text
"Hello {{context.steps.API0001.output.name}}"  →  "Hello Alice"

// 4. Typed templates: single expression returns raw value
"{{context.steps.FetchData.output.items}}"  →  [{ id: 1 }, { id: 2 }]  // actual array, not string

// 5. Custom vars via context prefix
"{{context.myCustomVar}}"  →  ctx.vars.myCustomVar
```

### 5.4 Where Expressions Are Resolved

Each executor resolves expressions from its configuration fields:

| Executor                        | Fields that support `{{expressions}}` |
| ------------------------------- | ------------------------------------- |
| **HTTP** (`api` node)           | `url`, `headers` (all values), `body` |
| **Condition**                   | `expression` (the condition itself)   |
| **Transform** (`function` node) | The expression being evaluated        |
| **Loop**                        | The source array expression           |
| **Agent Invocation**            | `message`                             |
| **Connector Action**            | `params` (all values)                 |
| **Approval**                    | `title`, `description`                |
| **Human Task**                  | `title`, `description`                |
| **Async Webhook**               | `url`, `headers`, `body`              |

---

## 6. Consuming Node Data in Subsequent Nodes

### 6.1 The Pattern

Every node's output is stored at both `ctx.steps[<nodeId>]` and `ctx.steps[<nodeName>]`. Subsequent nodes reference it via name:

```
{{context.steps.<nodeName>.output.<path>}}
```

Using the human-readable node name (e.g., `API0001`, `FetchOrder`) is the recommended approach. UUID-based references still work but are harder to read.

### 6.2 Concrete Example — Order Processing Workflow

Consider a workflow with these nodes:

```
[Start] → [Fetch Order] → [Check Status] → [Send Notification] → [End]
                                ↘ (else)
                            [Log Error] → [End]
```

**Node 1: Start**

- Input schema defines: `{ orderId: string }`
- The trigger payload becomes: `ctx.trigger.payload = { orderId: "ORD-123" }`
- Also available as: `ctx.steps['start'] = { input: { orderId: "ORD-123" } }`
- Access in expressions: `{{context.steps.start.input.orderId}}` or `{{context.trigger.payload.orderId}}`

**Node 2: FetchOrder** (api node, name: `FetchOrder`)

- Config:
  ```json
  {
    "method": "GET",
    "url": "https://api.example.com/orders/{{context.trigger.payload.orderId}}",
    "headers": { "Authorization": "Bearer {{context.vars.apiToken}}" }
  }
  ```
- At execution: URL resolves to `https://api.example.com/orders/ORD-123`
- Output stored at both `ctx.steps["<uuid>"]` and `ctx.steps["FetchOrder"]`:
  ```json
  ctx.steps["FetchOrder"] = {
    "output": {
      "statusCode": 200,
      "body": {
        "id": "ORD-123",
        "status": "shipped",
        "customer": { "name": "Alice", "email": "alice@example.com" },
        "items": [{ "sku": "WIDGET-1", "qty": 3 }]
      }
    },
    "status": "completed"
  }
  ```

**Node 3: CheckStatus** (condition node, name: `CheckStatus`)

- Config:
  ```json
  {
    "conditions": [
      {
        "field": "{{context.steps.FetchOrder.output.body.status}}",
        "operator": "equals",
        "value": "shipped"
      }
    ]
  }
  ```
- `{{context.steps.FetchOrder.output.body.status}}` resolves to `"shipped"` → condition is true → follows `thenSteps` edge

**Node 4: SendNotification** (api node, name: `SendNotification`)

- Config:
  ```json
  {
    "method": "POST",
    "url": "https://api.example.com/notifications",
    "headers": { "Content-Type": "application/json" },
    "body": "{\"to\": \"{{context.steps.FetchOrder.output.body.customer.email}}\", \"message\": \"Order {{context.trigger.payload.orderId}} has been shipped!\"}"
  }
  ```
- Body resolves to: `{"to": "alice@example.com", "message": "Order ORD-123 has been shipped!"}`

**Node 5: End** (end node)

- Config:
  ```json
  {
    "outputMapping": {
      "customerEmail": "{{context.steps.FetchOrder.output.body.customer.email}}",
      "orderStatus": "{{context.steps.FetchOrder.output.body.status}}"
    }
  }
  ```
- After workflow completes, execution output is resolved to:
  ```json
  { "customerEmail": "alice@example.com", "orderStatus": "shipped" }
  ```
- Returned in `POST /execute` response: `{ success: true, executionId, startTime, endTime, output: { customerEmail: "...", orderStatus: "..." }, status: "completed" }`

### 6.3 Using Transform (Function) Nodes to Create Variables

Transform nodes evaluate an expression and store the result in `ctx.vars`:

**Node: ExtractCustomer** (function node, name: `ExtractCustomer`)

- Config:
  ```json
  {
    "expression": "{{context.steps.FetchOrder.output.body.customer}}",
    "outputVariable": "customer"
  }
  ```
- After execution: `ctx.vars.customer = { name: "Alice", email: "alice@example.com" }`
- Subsequent nodes can use: `{{context.vars.customer.name}}` or `{{context.customer.name}}` → `"Alice"`

This is particularly useful for:

- Extracting deeply nested values into convenient short-hand variables
- Preparing data for multiple downstream nodes

### 6.4 Using Loop Nodes to Iterate

**Node: ProcessItems** (loop node, name: `ProcessItems`)

- Config:
  ```json
  {
    "source": "{{context.steps.FetchItems.output.body.items}}",
    "itemVariable": "currentItem"
  }
  ```
- For each iteration: `ctx.vars.currentItem = { sku: "WIDGET-1", qty: 3 }`
- Body nodes within the loop can use: `{{context.vars.currentItem.sku}}` or `{{context.currentItem.sku}}` → `"WIDGET-1"`

---

## 7. Context Variable Scopes — Summary

All paths below can optionally be prefixed with `context.` (e.g., `{{context.trigger.payload.orderId}}`).

| Expression Path                      | What it accesses                                                   | When it's available               |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------------- |
| `{{trigger.payload.<field>}}`        | The input data that started the workflow                           | From the first node onward        |
| `{{trigger.type}}`                   | How the workflow was triggered (`manual`, `api`, `schedule`, etc.) | From the first node onward        |
| `{{trigger.metadata.<field>}}`       | Trigger metadata (webhook headers, cron info, etc.)                | From the first node onward        |
| `{{workflow.id}}`                    | The workflow definition ID                                         | Always                            |
| `{{workflow.name}}`                  | The workflow name                                                  | Always                            |
| `{{workflow.executionId}}`           | This execution's unique ID                                         | Always                            |
| `{{tenant.tenantId}}`                | Current tenant                                                     | Always                            |
| `{{tenant.projectId}}`               | Current project                                                    | Always                            |
| `{{steps.start.input}}`              | The full workflow trigger input                                    | Always (synthetic start entry)    |
| `{{steps.start.input.<field>}}`      | A specific field from the workflow input                           | Always (synthetic start entry)    |
| `{{steps.<nodeName>.output}}`        | A completed node's full output (by name)                           | After that node completes         |
| `{{steps.<nodeName>.output.<path>}}` | A specific field from a node's output (by name)                    | After that node completes         |
| `{{steps.<nodeName>.status}}`        | A node's execution status                                          | After that node completes         |
| `{{steps.<nodeName>.error.message}}` | Error message from a failed node                                   | After that node fails             |
| `{{steps.<nodeId>.output}}`          | Same as above, but referenced by UUID (still works)                | After that node completes         |
| `{{vars.<name>}}`                    | Workflow variable set by transform/loop nodes                      | After the transform/loop executes |
| `{{context.<customVar>}}`            | Custom variable (shorthand for `vars.<customVar>`)                 | After set by a transform node     |

---

## 8. Advanced Examples

### 8.1 Chaining Multiple API Calls

```
[Start] → [GetUser] → [GetOrders] → [Summarize] → [End]
```

- **GetUser** (api node): `GET https://api.example.com/users/{{context.steps.start.input.userId}}`
  - Output: `{ body: { id: "U-1", name: "Bob", tier: "premium" } }`

- **GetOrders** (api node): `GET https://api.example.com/users/{{context.steps.GetUser.output.body.id}}/orders`
  - Uses `{{context.steps.GetUser.output.body.id}}` → resolves to `"U-1"`
  - Output: `{ body: { orders: [...] } }`

- **Summarize** (text_to_text node):

  ```
  message: "Summarize these orders for {{context.steps.GetUser.output.body.name}}: {{context.steps.GetOrders.output.body.orders}}"
  ```

  - Resolves to: `"Summarize these orders for Bob: [...]"`

### 8.2 Conditional Branching with Error Handling

```
[Start] → [CallAPI] ─── (on_success) ──→ [ProcessResponse] → [End]
                    └── (on_failure) ──→ [LogFailure] → [NotifyAdmin] → [End]
```

- If **CallAPI** fails, the engine follows `onFailureSteps` instead of aborting.
- **LogFailure** can access: `{{context.steps.CallAPI.error.message}}` → `"HTTP 500: Internal Server Error"`
- **NotifyAdmin** can use: `{{context.steps.CallAPI.error.code}}` → `"HTTP_ERROR"`

### 8.3 Loop with Accumulation

```
[Start] → [FetchItems] → [Loop: ProcessEach] → [Aggregate] → [End]
                              ↓ (body)
                          [EnrichItem]
```

- **FetchItems** output: `{ body: { items: [{id: 1}, {id: 2}, {id: 3}] } }`
- **Loop** config: `source: "{{context.steps.FetchItems.output.body.items}}"`, `itemVariable: "item"`
- **EnrichItem** (inside loop body): `GET https://api.example.com/items/{{context.vars.item.id}}/details`
- Each iteration, `{{context.vars.item}}` is the current array element

### 8.4 Human-in-the-Loop Approval

```
[Start] → [PrepareRequest] → [ApprovalGate] ─── (approved) ──→ [ExecuteAction] → [End]
                                             └── (on_decline) ──→ [NotifyRequester] → [End]
```

- **ApprovalGate** (human node): suspends execution, creates a HumanTask in MongoDB
- A human reviews and approves/rejects via the Studio inbox or API
- The Restate durable promise resolves, execution continues down the appropriate path
- **ExecuteAction** can reference: `{{context.steps.ApprovalGate.output.decision}}` → `"approved"`

---

## 9. Real-Time Monitoring

During execution, the engine publishes events to Redis Pub/Sub on channel:

```
workflow:{tenantId}:execution:{executionId}:status
```

Event types: `step.started`, `step.completed`, `step.failed`, `step.waiting_approval`, `step.waiting_human_task`, `workflow.started`, `workflow.completed`, `workflow.failed`, `workflow.cancelled`.

The Studio's `WorkflowDebugPanel` polls execution status via `useExecutionPolling` and overlays per-node status (running/completed/failed) on the canvas in real-time.

**Debug Panel behavior:**

- Opens immediately when the user clicks Run (shows "Starting execution..." while API call is in-flight)
- Flow Log shows: synthetic Start node → executed step nodes → synthetic End node (with resolved output)
- Output accordion shows the resolved `execution.output` from End node mappings, with copy/fullscreen support via `JsonViewer`
- Panel **stays open** after execution completes — the Run/Stop button resets to Run based on `executionStatus`, not panel visibility
- User explicitly closes the panel via the X button (which resets `currentExecutionId`), or starts a new run (which replaces it)

---

## 10. Durable Execution (Restate)

The workflow engine uses **Restate** for exactly-once execution guarantees:

- **Replay safety** — if the engine crashes mid-execution, Restate replays from the last checkpoint
- **Durable sleep** — delay nodes use `ctx.sleep()`, surviving restarts
- **Durable promises** — approval, human task, and webhook callback nodes await named promises (`sys:approval:{stepId}`, `sys:human_task:{stepId}`, `sys:callback:{stepId}`) that are resolved externally
- **Exactly-once side effects** — step execution is wrapped in `ctx.run()`, ensuring HTTP calls and DB writes are not duplicated on replay

---

## Key Takeaways

1. **The context is the bus** — `WorkflowContextData` is the single shared state that flows through all nodes. Every node reads from it and writes back to it.
2. **Expressions are the glue** — `{{context.path}}` templates let any node reference any prior node's output, the trigger input, or workflow variables. The `context.` prefix is optional but recommended.
3. **Name-based references** — use node names (`{{context.steps.API0001.output.body}}`) instead of UUIDs. Names must be unique within a workflow.
4. **Type preservation matters** — use a single `{{expression}}` (not embedded in text) to get typed values (objects, arrays). Mixed text + expressions always produce strings.
5. **Steps accumulate, vars are set** — `ctx.steps` grows automatically (dual-keyed by UUID and name) as nodes complete; `ctx.vars` is set explicitly by transform and loop nodes. `ctx.steps.start.input` provides the workflow input.
6. **Custom vars shorthand** — `{{context.myVar}}` resolves to `ctx.vars.myVar` when `myVar` isn't a known top-level key.
7. **Failure is data too** — failed step errors are accessible via `{{context.steps.CallAPI.error.message}}`, enabling error-handling branches.
8. **End node defines output** — the End node's `outputMapping` config maps expression paths to named output variables, resolved at completion and returned in the execution response.
9. **Synchronous execute** — `POST /execute` polls up to 30s for completion and returns `{ startTime, endTime, output, status }` inline. Falls back to 202 for long-running workflows.
