# Workflow Node Reference Guide

**Scope:** All node types, trigger types, execution mechanics, and convergence rules for the workflow system.
**Relates to:** `docs/features/workflows.md`, `docs/features/sub-features/workflow-parallel-graph-execution.md`, `docs/features/sub-features/workflow-triggers.md`, `docs/features/sub-features/workflow-function-node.md`, `docs/features/sub-features/workflow-async-completion.md`

---

## Table of Contents

1. [Execution Lifecycle Overview](#1-execution-lifecycle-overview)
2. [Triggers](#2-triggers)
3. [Flow Control Nodes](#3-flow-control-nodes)
   - [Start](#31-start)
   - [End](#32-end)
   - [Condition](#33-condition)
   - [Delay](#34-delay)
   - [Loop](#35-loop)
4. [Action Nodes](#4-action-nodes)
   - [API](#41-api)
   - [Function](#42-function)
   - [Integration](#43-integration)
5. [AI Nodes](#5-ai-nodes)
   - [Text-to-Text](#51-text-to-text)
6. [Human-in-the-Loop Nodes](#6-human-in-the-loop-nodes)
   - [Approval (Human)](#61-approval-human)
   - [Data Entry](#62-data-entry)
7. [Agent and Tool Nodes](#7-agent-and-tool-nodes)
   - [Agent](#71-agent)
   - [Tool](#72-tool)
8. [Edge Types and Routing](#8-edge-types-and-routing)
9. [DAG Execution Model](#9-dag-execution-model)
   - [Sequential vs. Parallel Dispatch](#91-sequential-vs-parallel-dispatch)
   - [Fan-out](#92-fan-out)
   - [Convergence — What It Takes to Start a Join Node](#93-convergence--what-it-takes-to-start-a-join-node)
   - [Required Predecessors Contract](#94-required-predecessors-contract)
   - [Failure Semantics](#95-failure-semantics)
10. [Loop Execution Modes](#10-loop-execution-modes)
    - [Sequential Mode](#101-sequential-mode)
    - [Parallel Mode](#102-parallel-mode)
11. [Expression System](#11-expression-system)
12. [Node Status Lifecycle](#12-node-status-lifecycle)
13. [Stub and Hidden Nodes](#13-stub-and-hidden-nodes)
14. [Adding a New Node Type — File Checklist](#14-adding-a-new-node-type--file-checklist)

---

## 1. Execution Lifecycle Overview

```
Trigger fires
    │
    ▼
WorkflowExecutionInput built
 (includes inDegreeMap, edgeMap, triggerData)
    │
    ▼
canvas-to-steps.ts  ──►  WorkflowStep[] (flat list)
                           + inDegreeMap (fan-in counts)
                           + edgeMap (edge descriptors)
    │
    ▼
workflow-handler.ts
  │
  ├─ inDegreeMap non-empty? ──► executeDag()       ← parallel topology
  │                                   │
  │                               dag-executor.ts
  │                               (barrier counting,
  │                                fan-out dispatch,
  │                                skip-cascade)
  │
  └─ inDegreeMap empty? ──► sequential step loop   ← linear topology
         │
         ▼
  executeStepWithSuspension(step)
     │
     ▼
  step-dispatcher.ts  ──►  executor (by stepType)
     │
     ▼
  StepOutcome { completed | terminal_no_successors | failed | workflow_terminated }
     │
     ▼
  next steps resolved from activatedSuccessors
```

Every step executes inside Restate's durable execution context. Failures at the executor level are automatically retried by Restate unless the executor returns `{ status: 'failed' }` as an intentional terminal outcome.

---

## 2. Triggers

Triggers are external events or schedules that create a new workflow execution. They feed data into the workflow as the initial `triggerData` context variable.

### Trigger types

| Type      | When it fires                                              | Config                                                                 |
| --------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `webhook` | HTTP POST to a generated endpoint                          | URL pattern, sync vs. async response mode, delivery mode (push / poll) |
| `cron`    | Scheduled schedule (cron expression)                       | Cron schedule string, timezone                                         |
| `event`   | Platform event emitted by a connector or runtime component | Event topic, connector, filter expressions                             |
| `studio`  | Manual run from the Studio canvas UI                       | No external config — Studio sends a one-off trigger                    |
| `agent`   | An agent invokes the workflow programmatically             | Agent ID, input payload                                                |

Only `webhook`, `cron`, and `event` are **registration triggers** — they persist a trigger registration in the engine and survive restarts. `studio` and `agent` fire ephemerally.

### Trigger data access in expressions

Trigger payload is accessible in any expression as:

```
{{triggerData.<field>}}
{{triggerData.body.<field>}}    -- for webhook triggers
{{triggerData.event.<field>}}   -- for event triggers
```

### Trigger lifecycle

1. `trigger-engine.ts` registers listeners on engine startup.
2. An incoming request or scheduled event is matched to a workflow version.
3. The engine resolves the workflow definition (canvas → steps conversion if not cached).
4. A `WorkflowExecutionInput` is assembled with `inDegreeMap`, `edgeMap`, and trigger payload.
5. Restate starts a durable workflow handler run.

---

## 3. Flow Control Nodes

### 3.1 Start

**Category:** Flow control
**Palette:** Visible (always present — one per workflow)
**Engine step:** Skipped (no executor)

The **Start** node is the single entry point of every workflow. It declares **input variables** — named slots that the trigger or caller must populate before execution begins.

**Config:**

```
inputVariables:
  - name: string          // variable name, e.g. "orderId"
    type: string | number | boolean | object | array
    required: boolean
    defaultValue?: any
    description?: string
```

**Output handle:** `on_success` — the single edge leaving Start is the first step to execute.

**Execution:**

- Not dispatched as a step. The engine skips Start and begins from its `on_success` successor.
- Input variables are resolved from `triggerData` or the caller's payload and placed into the execution context under `{{steps.Start.<varName>}}`.

---

### 3.2 End

**Category:** Flow control
**Palette:** Visible (always present — one per workflow)
**Engine step:** Skipped (no executor)

The **End** node marks workflow completion and defines the **output shape** — how internal step results are projected into the final workflow result object.

**Config:**

```
outputMapping:
  fieldName: "{{steps.SomeNode.output.value}}"   // string expression
  fieldName:
    expression: "{{steps.SomeNode.output.value}}"
    type: string | number | boolean | object | array
    description: string
```

**Input:** Any node can connect to End. Multiple paths may reach End.
**Output handles:** None.

**Execution:**

- Not dispatched as a step. When a step's `activatedSuccessors` includes End's ID, the engine resolves all `outputMapping` expressions and sets the workflow result.
- Reaching End causes a `{ status: 'workflow_terminated'; result: ... }` outcome which drains the DAG and halts execution.

---

### 3.3 Condition

**Category:** Flow control
**Palette:** Visible
**Engine step type:** `condition`

The **Condition** node is a multi-branch router. It evaluates one or more **If / Else If** branches in declaration order. The first branch whose condition is truthy fires its outgoing edge. If no branch matches, the **Else** edge fires.

**Config:**

```
conditions:
  - id: "if_0"         // always present, first branch
    label: "If"
    field?: string     // expression to evaluate, e.g. "{{steps.Api.output.status}}"
    operator?: equals | not_equals | greater_than | less_than
               | contains | not_contains | is_empty | is_not_empty | matches_regex
    value?: string     // comparison value
    expression?: string  // raw boolean expression (alternative to field/operator/value)
  - id: "if_1"
    label: "Else If"
    ...
logic: "and" | "or"    // how multiple conditions within a branch combine
```

**Output handles:** Dynamic — one handle per declared branch (`if_0`, `if_1`, ...) plus an `else` handle.

**Execution:**

1. Evaluates each branch condition in declaration order.
2. First truthy branch: routes to its `targetSteps`.
3. No truthy branch: routes to `elseSteps`.
4. Non-activated branches' successors receive a `signalSkipped` in the DAG, advancing their barrier counts.

**Routing in expressions:** The winning branch's successor steps receive `{{steps.Condition.activatedBranch}}` set to the winning branch ID.

---

### 3.4 Delay

**Category:** Flow control
**Palette:** Visible
**Engine step type:** `delay`

The **Delay** node pauses execution for a fixed duration before routing to its successor. Uses Restate's `ctx.sleep()` for durable suspension — the workflow process does not hold a thread during the wait.

**Config:**

```
duration: number    // 30–86400 seconds
unit: seconds | minutes | hours | days
```

Duration is compiled to ISO 8601 format (e.g., `PT30S`, `PT2H`) before passing to the executor.

**Output handles:** `on_success` (always), optionally `on_failure`.
**Failure conditions:** None in normal operation. `on_failure` is available for downstream routing if needed.

---

### 3.5 Loop

**Category:** Flow control
**Palette:** Visible
**Engine step type:** `loop`

The **Loop** node iterates over a collection expression, running its **body** (a sub-graph of steps) once per item. It is a **group node** — it visually contains its body steps as children on the canvas.

**Structure on canvas:**

```
Loop container  (nodeType: 'loop')
  ├── Loop Start  (nodeType: 'loop_start') — entry socket, not executed
  ├── Body step A
  ├── Body step B
  └── Loop End   (nodeType: 'loop_end')  — exit socket, not executed
```

**Config:**

```
source: string            // expression resolving to an array, e.g. "{{steps.Api.output.items}}"
itemAlias: string         // name for the current item, default "currentItem"
outputField?: string      // variable name to accumulate per-iteration results
bodyOutputMapping?:       // expressions evaluated after each iteration
  fieldName: expression
onError: continue | terminate   // what to do when an iteration fails
maxIterations: number           // safety cap, default 1000
mode: sequential | parallel     // see §10
concurrencyLimit: number        // parallel mode only, default 5
stagger?: number                // parallel mode: ms delay between batch starts
preserveOrder?: boolean         // parallel mode: keep result order
```

**Output handles:** `on_complete` (all iterations finished) and `on_failure` (loop terminated by error).

**Execution lifecycle:**

1. `source` expression is resolved to an array.
2. The body sub-graph is extracted and converted to its own step list with its own `bodyInDegreeMap`.
3. The loop executor iterates over the array. For each item:
   - The item is bound to `{{currentItem}}` (or the configured alias) in the body context.
   - The body is executed — sequentially or in parallel batches (see §10).
   - `bodyOutputMapping` is evaluated and collected.
4. On completion, accumulated results are stored and `on_complete` routes to the next outer node.

**Data access inside the body:**

```
{{currentItem}}                      // current iteration item
{{currentItem.fieldName}}            // field on the item
{{steps.BodyStep.output.value}}      // output from a body step
```

**Data access after the loop:**

```
{{steps.Loop.output.results}}        // array of per-iteration collected outputs
{{steps.Loop.output.failedCount}}    // number of iterations that failed (if onError: continue)
```

---

## 4. Action Nodes

### 4.1 API

**Category:** Action
**Palette:** Hidden (functionally available; use Integration node for connector-based HTTP)
**Engine step type:** `http` (sync) or `async_webhook` (async mode)

The **API** node makes an HTTP request to an arbitrary URL. Supports all standard HTTP methods, custom headers, request bodies in multiple formats, and optional auth profiles.

**Config:**

```
method: GET | POST | PUT | PATCH | DELETE
url: string                // supports expressions: "https://api.example.com/{{steps.Start.orderId}}"
headers:
  - key: string
    value: string          // supports expressions
body:
  type: none | json | form | xml | custom
  content?: string         // body payload, supports expressions
auth:
  type: none | pre_authorized | user_level
  profileId?: string       // credential profile ID
mode: sync | async         // async: waits for a webhook callback before continuing
timeout: number            // 5–300 seconds
```

**Async mode:** When `mode: async`, the engine registers a durable promise keyed to the execution. The API response is ignored; execution suspends until an external system calls the callback endpoint with a result.

**Output handles:** `on_success`, optionally `on_failure`.

**Data access after:**

```
{{steps.ApiNode.output.status}}     // HTTP status code
{{steps.ApiNode.output.body}}       // parsed response body
{{steps.ApiNode.output.headers}}    // response headers
```

---

### 4.2 Function

**Category:** Action
**Palette:** Visible
**Engine step type:** `function`

The **Function** node runs user-written **JavaScript** in an isolated V8 sandbox (`isolated-vm`). It has access to a `context` object containing all upstream step outputs and can return any serializable value.

**Sandbox constraints:**

- Heap: 128 MB
- Output size: 1 MB max
- Console log buffer: 100 entries max
- Execution timeout: 5–60 seconds (config)
- No network, no filesystem access

**Config:**

```
code: string        // JavaScript source, must assign to `context.output` or return a value
timeout: number     // 5–60 seconds, default 10
```

**Writing the function body:**

```javascript
// Read upstream data
const items = context.steps.ApiNode.output.body.items;

// Process
const result = items.filter((item) => item.active);

// Return value becomes {{steps.FunctionNode.output}}
context.output = { filtered: result, count: result.length };
```

**Output handles:** `on_success`, optionally `on_failure`.

**Data access after:**

```
{{steps.FunctionNode.output.filtered}}   // whatever was assigned to context.output
{{steps.FunctionNode.output.count}}
```

---

### 4.3 Integration

**Category:** Action
**Palette:** Visible
**Engine step type:** `connector_action`

The **Integration** node executes a named action from a registered connector (e.g., Slack → Send Message, Jira → Create Issue, HubSpot → Create Contact). Auth is handled by a stored **connection** linked to the node.

**Config:**

```
connectorId: string     // e.g. "slack", "jira", "hubspot"
actionName: string      // e.g. "send_message", "create_issue"
connectionId: string    // stored OAuth / API-key credential
params:                 // named parameters required by the action
  channelId: "{{steps.Start.channelId}}"
  message: "Order {{steps.Start.orderId}} is ready"
paramModes:             // per-param: static value or expression
  channelId: static
  message: expression
timeout: number         // 5–300 seconds, default 60
```

**Available connectors** are listed in the connector registry. Each connector declares its available actions and their parameter schemas.

**Output handles:** `on_success`, optionally `on_failure`.

**Data access after:**

```
{{steps.IntegrationNode.output}}   // action-specific response shape
```

---

## 5. AI Nodes

### 5.1 Text-to-Text

**Category:** AI
**Palette:** Hidden (internal use)
**Engine step type:** `agent_invocation`

The **Text-to-Text** node invokes an LLM with a system prompt and human prompt. Used internally when a workflow step needs a generative AI call without a full agent setup.

**Config:**

```
modelId?: string          // e.g. "claude-sonnet-4-6"
connectionId?: string     // credential profile for the LLM provider
systemPrompt?: string     // supports expressions
humanPrompt?: string      // supports expressions
temperature?: number      // 0–1
topP?: number
topK?: number
maxTokens?: number
timeout: number           // seconds
outputSchema?: object     // JSON schema for structured output
```

**Output handles:** `on_success`, optionally `on_failure`.

> **Note:** `text_to_image`, `audio_to_text`, and `image_to_text` exist as node types but are stubs — they have no production implementation yet. See §13.

---

## 6. Human-in-the-Loop Nodes

Both human-in-the-loop node types compile to the `human_task` engine step type. Execution **suspends** the workflow using a Restate durable promise until a human actor responds via the inbox UI.

### 6.1 Approval (Human)

**Category:** Human-in-the-loop
**Palette:** Visible
**Engine step type:** `human_task` (taskType: `approval`)

The **Approval** node sends a review/approval request to one or more assignees. Execution is suspended until an assignee approves or rejects the request, or the timeout elapses.

**Config:**

```
subject?: string        // message title, supports expressions
message?: string        // body text, supports expressions
assignTo: everyone | specific
assignees: string[]     // user IDs (if assignTo: specific)
timeout?:
  duration: number
  unit: seconds | minutes | hours | days
onTimeout: terminate | skip
```

**Output handles:**

- `on_approve` — routed when any assignee approves
- `on_reject` — routed when any assignee rejects
- `on_failure` (optional) — routed on system errors

**Execution:**

1. Engine creates a human task record in the inbox.
2. Workflow suspends (Restate durable promise).
3. Assignee opens inbox → reviews context → approves or rejects.
4. Engine resolves the durable promise with the decision.
5. Workflow resumes on the appropriate output handle.

**Data access after:**

```
{{steps.ApprovalNode.output.decision}}   // "approved" | "rejected"
{{steps.ApprovalNode.output.comment}}    // reviewer's comment
{{steps.ApprovalNode.output.reviewer}}   // user ID of the reviewer
```

---

### 6.2 Data Entry

**Category:** Human-in-the-loop
**Palette:** Visible
**Engine step type:** `human_task` (taskType: `data_entry`)

The **Data Entry** node presents a form to a human assignee. Execution suspends until the form is submitted. The submitted field values are then available to downstream steps.

**Config:**

```
subject?: string
message?: string
fields:
  - name: string
    type: text | number | boolean | select | textarea | date
    label?: string
    required?: boolean
    options?: string[]           // static select options
    optionsExpression?: string   // dynamic options from an expression
    defaultValue?: any
assignTo: everyone | specific
assignees: string[]
timeout?:
  duration: number
  unit: seconds | minutes | hours | days
onTimeout: terminate | skip
```

**Output handles:** `on_approve` (form submitted), `on_reject` (form dismissed), optionally `on_failure`.

**Data access after:**

```
{{steps.DataEntryNode.output.formData.fieldName}}   // submitted field values
{{steps.DataEntryNode.output.submittedBy}}          // user ID
```

---

## 7. Agent and Tool Nodes

### 7.1 Agent

**Category:** Agent
**Palette:** Visible
**Engine step type:** `agent_invocation`

The **Agent** node invokes a named agent from the project's agent registry via the Runtime API. The workflow suspends until the agent produces a response.

**Config:**

```
agentId?: string       // internal agent ID
agentName?: string     // display name (resolved to ID at runtime)
input?: string         // message/payload expression sent to the agent
sessionId?: string     // optional: attach to an existing agent session
timeout: number        // 30–600 seconds, default 120
```

**Output handles:** `on_success`, optionally `on_failure`.

**Data access after:**

```
{{steps.AgentNode.output.response}}    // agent's text response
{{steps.AgentNode.output.metadata}}    // response metadata
```

---

### 7.2 Tool

**Category:** Tool
**Palette:** Visible
**Engine step type:** `tool_call`

The **Tool** node invokes a registered tool by name with a set of named parameters. Tools are discrete operations registered in the project's tool registry (e.g., database lookups, custom API wrappers, computed utilities).

**Config:**

```
toolId?: string              // internal tool ID
toolName?: string            // display name
params:                      // key-value pairs matching the tool's DSL schema
  paramName: "{{steps.Start.value}}"
timeout: number              // 5–300 seconds, default 30
```

Required parameters are auto-prefilled in the config panel from the tool's DSL schema.

**Output handles:** `on_success`, optionally `on_failure`.

**Data access after:**

```
{{steps.ToolNode.output}}           // tool-specific result shape
{{steps.ToolNode.output.fieldName}}
```

---

## 8. Edge Types and Routing

Every edge in the workflow canvas carries a **handle ID** that determines when it fires. The table below shows handle IDs, which nodes emit them, and how the engine resolves them.

| Handle ID     | Emitted by                                                                 | Fires when                                          |
| ------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `on_success`  | API, Function, Integration, Loop, Delay, Agent, Tool, Text-to-Text         | Step completed without error                        |
| `on_failure`  | API, Function, Integration, Loop, Delay, Agent, Tool, Approval, Data Entry | Step or loop encountered an error                   |
| `on_approve`  | Approval, Data Entry                                                       | Human approved / submitted                          |
| `on_reject`   | Approval, Data Entry                                                       | Human rejected / dismissed                          |
| `on_complete` | Loop                                                                       | All iterations finished                             |
| `if_<n>`      | Condition                                                                  | Condition branch `n` evaluated truthy               |
| `else`        | Condition                                                                  | No condition branch matched                         |
| `loop_body`   | Loop Start                                                                 | Loop Start's single outgoing edge (first body step) |

**Non-activated edges:** When a condition's `if_1` branch fires, all other branches' `if_0`, `if_2`, and `else` targets receive a `signalSkipped`. This is how the DAG executor learns that a predecessor settled without routing to a particular successor, allowing it to advance that successor's barrier count.

**Multiple targets per handle:** A single handle can connect to multiple target nodes (fan-out). The engine dispatches all targets concurrently up to the `MAX_PARALLEL_BRANCHES = 10` cap.

---

## 9. DAG Execution Model

### 9.1 Sequential vs. Parallel Dispatch

**Sequential** execution applies when every node has at most one incoming edge and one outgoing edge — a simple chain. The engine walks steps in order.

**Parallel (DAG)** execution applies whenever:

- A node has two or more outgoing edges (fan-out), OR
- A node has two or more incoming edges (fan-in / join), OR
- Both.

The DAG executor is selected when `inDegreeMap` is non-empty after canvas conversion. It dispatches root nodes first, then waves of nodes whose barriers are satisfied.

---

### 9.2 Fan-out

When a step's output routes to multiple successors (e.g., a Condition emitting `if_0` and `if_1` branches simultaneously, or a start node connected to two parallel API nodes), the DAG executor dispatches all activated successors concurrently using `Promise.all` semantics.

**Cap:** A single node may have at most **10 outgoing edges** (`MAX_PARALLEL_BRANCHES`). The Studio canvas silently drops the 11th connection. The engine enforces `MAX_FAN_OUT_EXCEEDED` at runtime.

---

### 9.3 Convergence — What It Takes to Start a Join Node

A **join node** (also called a convergence or merge node) is any node with `inDegreeMap[nodeId] >= 2`. It cannot execute until all predecessors have settled.

**Three-phase barrier algorithm:**

**Phase 1 — Wait for all predecessors**
Every predecessor that completes (whether it routed to this node or not) calls `notifyTerminal(predecessorId, activatedSuccessors)`. For each activated successor, `incrementBarrier` is called; for each non-activated successor, `signalSkipped` is called.

The join node fires `evaluateAndDispatch` only when:

```
terminalCount[nodeId] === inDegreeMap[nodeId]
```

**Phase 2 — Evaluate skip-cascade**
If all predecessors signaled skip:

```
skippedCount[nodeId] === inDegreeMap[nodeId]
```

The join node itself skip-cascades to all its successors. It does not execute.

Otherwise (at least one predecessor arrived), the join node is dispatched.

**Phase 3 — Required predecessors check (post-dispatch)**
After the join node is dispatched, `executeStepWithSuspension` checks `requiredPredecessors` if the node's config declares any. If any listed predecessor was in the skipped state, the step fails immediately with `REQUIRED_PREDECESSOR_NOT_COMPLETED`.

**Summary table:**

| Predecessor states                              | Join node outcome                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| All completed, routed to join                   | Dispatched                                                                   |
| Mix of routed and skipped                       | Dispatched (SimpleMerge — OR semantics)                                      |
| All predecessors signaled skip                  | Skip-cascaded (not dispatched)                                               |
| One branch failed (no routing), another arrived | Dispatched — DAG still records `firstError` for re-throw after drain         |
| Required predecessor skipped                    | Dispatched, then immediately fails with `REQUIRED_PREDECESSOR_NOT_COMPLETED` |

---

### 9.4 Required Predecessors Contract

When a join node's config declares `requiredPredecessors: [stepId, ...]`, the semantics shift from **OR-join** to **AND-join** for those specific predecessors.

1. The DAG still uses barrier counting — the join fires when ANY sufficient set of predecessors arrives.
2. After the join fires, `executeStepWithSuspension` reads `requiredPredecessors` and checks whether each listed predecessor was in the skipped state.
3. If any required predecessor was skipped: fail with `REQUIRED_PREDECESSOR_NOT_COMPLETED`.
4. If all required predecessors arrived: execute normally.

> The `MergerNodeConfig` UI panel (required predecessors checklist) is currently disabled in the Studio canvas config panel. The engine logic is complete and functional.

---

### 9.5 Failure Semantics

| What happens                            | Engine behavior                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executor returns `{ status: 'failed' }` | Nonfatal to the DAG. Calls `notifyTerminal(id, [])`. No activated successors → all successors receive `signalSkipped`. `firstError` is NOT set.    |
| Executor throws an unhandled exception  | Fatal. `trackDispatch` catch sets `firstError`. DAG drain-wait loop completes, then `executeDag` re-throws.                                        |
| `MAX_FAN_OUT_EXCEEDED`                  | Fatal. `firstError` set immediately.                                                                                                               |
| All branches of a parallel section fail | All join node predecessors settle → join dispatched with skip-cascade or `REQUIRED_PREDECESSOR_NOT_COMPLETED`. `executeDag` re-throws after drain. |

The key principle: **`{ status: 'failed' }` is a settled terminal state, not an exception.** The DAG continues draining. The overall workflow execution fails only after all in-flight branches complete.

---

## 10. Loop Execution Modes

### 10.1 Sequential Mode

Each iteration of the body executes fully before the next begins.

```
Collection: [A, B, C]

Iteration 1: A → body steps → collect output
Iteration 2: B → body steps → collect output
Iteration 3: C → body steps → collect output
         └──► on_complete
```

The body can itself be a DAG (fan-out within the body is supported). `bodyInDegreeMap` drives a nested `executeDag` call for each iteration.

---

### 10.2 Parallel Mode

Items are dispatched in **concurrency-limited batches**. All items within a batch start simultaneously; the next batch starts when the previous batch completes.

```
Collection: [A, B, C, D, E]   concurrencyLimit: 2

Batch 1: A, B → body steps (parallel)
Batch 2: C, D → body steps (parallel)  ← starts after Batch 1 finishes
Batch 3: E    → body steps
         └──► on_complete
```

**Config fields for parallel mode:**

- `concurrencyLimit` — items per batch (default 5)
- `stagger` — millisecond delay between items within a batch start
- `preserveOrder` — whether to preserve input order in collected results

**Studio iteration overlay:** The `LoopNodeComponent` shows a batch/iteration selector dropdown after execution completes. Edge highlighting reflects the selected iteration's execution path via `iterationEdgePathState` in the canvas store.

---

## 11. Expression System

Step configs support **Handlebars-style expressions** for dynamic values. Expressions are evaluated at step execution time against the current execution context.

**Namespace:**

```
{{triggerData.<field>}}                    // trigger payload
{{steps.<NodeId>.output.<field>}}          // step output
{{steps.<NodeId>.output}}                  // full output object
{{currentItem}}                            // current loop iteration item
{{currentItem.<field>}}
{{env.<VAR>}}                              // environment variables (allow-listed)
```

**Supported in:** url, headers, body, params, subject, message, systemPrompt, humanPrompt, source (loop collection), and any expression field in Condition.

**Operators available in Condition expressions:**

| Operator        | Meaning                           |
| --------------- | --------------------------------- |
| `equals`        | Strict equality                   |
| `not_equals`    | Strict inequality                 |
| `greater_than`  | Numeric `>`                       |
| `less_than`     | Numeric `<`                       |
| `contains`      | String includes or array includes |
| `not_contains`  | Negation of contains              |
| `is_empty`      | Null, undefined, `""`, `[]`, `{}` |
| `is_not_empty`  | Negation of is_empty              |
| `matches_regex` | RegExp test                       |

---

## 12. Node Status Lifecycle

During execution, every node transitions through the following states (reflected in the canvas execution overlay):

| Status      | Meaning                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `pending`   | Node has not yet been dispatched. Predecessors still settling.                                                    |
| `running`   | Node is actively executing (or suspended waiting for a human / async callback).                                   |
| `completed` | Node finished successfully. Successors dispatched.                                                                |
| `failed`    | Node finished with an error. `on_failure` edge activated if present, otherwise `signalSkipped` to all successors. |
| `rejected`  | Human-task node: assignee rejected the request. `on_reject` edge activated.                                       |
| `skipped`   | Node was not reached because all predecessors routed away from it.                                                |
| `cancelled` | Workflow was cancelled while this node was pending or running.                                                    |

Status is stored per-step in `executionOverlay` in the canvas store and is piped from execution event trace events.

---

## 13. Stub and Hidden Nodes

Several node types exist in the type system but are not fully implemented.

**Stub nodes** (shown in palette as "Coming soon"):

| Node type          | Display name     | Status             |
| ------------------ | ---------------- | ------------------ |
| `browser`          | Browser          | No executor        |
| `doc_search`       | DocSearch        | No executor        |
| `doc_intelligence` | Doc Intelligence | No executor        |
| `text_to_image`    | Text-to-Image    | Executor stub only |
| `audio_to_text`    | Audio-to-Text    | Executor stub only |
| `image_to_text`    | Image-to-Text    | Executor stub only |
| `agentic_app`      | Agentic App      | Executor stub only |

**Hidden nodes** (not shown in palette, but functional or internal):

| Node type      | Notes                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| `api`          | Fully functional. Superseded in palette by Integration node for connector-based use. |
| `text_to_text` | Functional via `agent_invocation`. Hidden to avoid confusion with Agent node.        |
| `loop_start`   | Internal loop canvas marker. Not an executable step.                                 |
| `loop_end`     | Internal loop canvas marker. Not an executable step.                                 |

**Programmatic-only step types** (no canvas node, only callable from code or engine internals):

| Step type   | Purpose                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `parallel`  | Explicit parallel branch grouping. Used internally by some engine paths. |
| `transform` | Pure data transformation step. No canvas representation.                 |
| `approval`  | Separate from `human_task`; used for programmatic approval flows.        |

---

## 14. Adding a New Node Type — File Checklist

When introducing a new canvas node type end-to-end, update all of the following:

| File                                                                          | Change                                                                                                          |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/shared-kernel/src/types/workflow-types.ts`                          | Add to `NodeType` union; add to `NODE_CATEGORY_MAP`, `NODE_COLOR_MAP`, `NODE_DISPLAY_NAMES`, `getOutputHandles` |
| `packages/shared/src/types/workflow-schemas.ts`                               | Add enum value, config Zod schema, entry in `NODE_CONFIG_SCHEMAS`                                               |
| `apps/workflow-engine/src/handlers/canvas-to-steps.ts`                        | Add to `NODE_TYPE_TO_STEP_TYPE`; add `case` in `convertNodeToStep`                                              |
| `apps/workflow-engine/src/handlers/step-dispatcher.ts`                        | Add to `BaseWorkflowStep` union; add `case` in `dispatchStep` and `resolveStepInput`                            |
| `apps/workflow-engine/src/executors/<type>-executor.ts`                       | Create executor (new file)                                                                                      |
| `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` | Add to `NODE_ICON_MAP`                                                                                          |
| `apps/studio/src/components/workflows/canvas/panels/ConfigPanel.tsx`          | Add config panel dispatch case                                                                                  |
| `apps/studio/src/components/workflows/canvas/config/<Type>NodeConfig.tsx`     | Create config panel (new file)                                                                                  |

If the node is a **group node** (like Loop), also register a dedicated component in `WorkflowCanvas.tsx`'s `workflowNodeTypes` map and create a `<Type>NodeComponent.tsx`.

If the node introduces a **new output handle**, update `getOutputHandles` in `workflow-types.ts` and add the handle rendering in `WorkflowNodeComponent.tsx`.

---

_This document is maintained alongside implementation. When node behavior changes, update the relevant section and the corresponding feature spec in `docs/features/`._
