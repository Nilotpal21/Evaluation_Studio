# Workflow System Replacement — Kore.ai Aligned Design

**Date:** 2026-03-17
**Status:** Review (spec review passed — awaiting user review)
**Branch:** feat/integrations
**Scope:** Full replacement of the existing workflow system (engine, data model, Studio UI, API endpoints) with a Kore.ai-aligned visual node-based workflow builder.

---

## 1. Overview

Replace the existing step-list-based workflow system with a visual, node-based workflow builder modeled after [Kore.ai AI for Process](https://docs.kore.ai/ai-for-process/workflows/overview/). This is a full replacement — new data models, new engine architecture, new Studio UI, and new per-workflow API endpoint generation.

### Goals

- Visual drag-and-drop canvas using XY Flow for workflow design
- 16 Kore.ai-aligned node types (3 deferred/stubbed)
- Per-workflow API endpoint generation with dedicated API keys (sync, async-poll, async-push)
- Centralized Inbox for human-in-the-loop approvals
- Retain Restate for durable execution guarantees
- No migration needed — existing workflow data is pre-production

### Non-Goals

- Browser Node executor (stubbed — UI and type defined, no runtime)
- DocSearch Node executor (stubbed — UI and type defined, no runtime)
- Doc Intelligence Node executor (stubbed — UI and type defined, no runtime)
- Python support in Function Node (JS only in initial build, Python later)
- Guardrails on AI nodes (future phase)

---

## 2. Node Type System

### 2.1 Complete Node Type Inventory

All 16 node types as a discriminated union on `nodeType`:

#### Flow Control

| Node Type   | Shape        | Color                 | Description                                                                                                         |
| ----------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `start`     | Pill/rounded | Green (#4CAF50)       | Entry point. Defines workflow input variables. Auto-placed, one per workflow.                                       |
| `end`       | Pill/rounded | Dark gray (#616161)   | Exit point. Collects workflow output. Multiple allowed.                                                             |
| `condition` | Diamond      | Light brown (#A1887F) | Evaluates expressions, routes to branches (If / Else If / Else). Per-node re-visit limit of 10 for cycle detection. |
| `loop`      | Rounded rect | Gray (#9E9E9E)        | Iterates over an array, executes child subgraph per item, collects results.                                         |
| `delay`     | Rounded rect | Amber (#FFB300)       | Suspends execution for a configured duration.                                                                       |

#### AI Nodes

| Node Type       | Shape        | Color            | Description                                                                                   |
| --------------- | ------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `text_to_text`  | Rounded rect | Purple (#7E57C2) | LLM text generation — system prompt, human prompt, hyperparameters, structured output schema. |
| `text_to_image` | Rounded rect | Purple (#7E57C2) | Image generation from text prompt (DALL-E, Stable Diffusion, etc.).                           |
| `audio_to_text` | Rounded rect | Purple (#7E57C2) | Speech-to-text transcription (Whisper, etc.).                                                 |
| `image_to_text` | Rounded rect | Purple (#7E57C2) | Vision model — describe/analyze image input.                                                  |

#### Action Nodes

| Node Type     | Shape        | Color               | Description                                                                               |
| ------------- | ------------ | ------------------- | ----------------------------------------------------------------------------------------- |
| `api`         | Rounded rect | Dark blue (#1565C0) | HTTP request — REST/SOAP, configurable method/headers/body/auth, sync and async modes.    |
| `function`    | Rounded rect | Cyan (#00ACC1)      | Inline JavaScript execution in a sandboxed VM. Input variable mapping with type coercion. |
| `integration` | Rounded rect | Orange (#FF7043)    | Execute a connector action via the platform's ConnectorRegistry.                          |
| `browser`     | Rounded rect | Blue (#42A5F5)      | Browser automation (STUB — not implemented in initial build).                             |

#### Data Nodes

| Node Type          | Shape        | Color           | Description                                                      |
| ------------------ | ------------ | --------------- | ---------------------------------------------------------------- |
| `doc_search`       | Rounded rect | Green (#66BB6A) | Document search (DEFERRED — not implemented in initial build).   |
| `doc_intelligence` | Rounded rect | Green (#66BB6A) | Document analysis (DEFERRED — not implemented in initial build). |

#### Human-in-the-Loop

| Node Type | Shape        | Color               | Description                                                                                                                                                          |
| --------- | ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`   | Rounded rect | Warm gray (#8D6E63) | Pauses workflow, creates inbox task for approval/decline. Configurable timeout with terminate/skip behavior. Four output paths: approval, decline, timeout, failure. |

#### Agent

| Node Type     | Shape        | Color          | Description                                                                                                   |
| ------------- | ------------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `agentic_app` | Rounded rect | Teal (#26A69A) | Invokes a deployed agent from the same project. Single-turn: passes input text, receives structured response. |

### 2.2 Node Configuration Schemas

Each node type has a Zod-validated configuration schema.

#### Start Node

```typescript
const StartNodeConfigSchema = z.object({
  inputVariables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['string', 'number', 'boolean', 'json']),
        required: z.boolean().default(true),
        defaultValue: z.unknown().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
});
```

#### End Node

```typescript
const EndNodeConfigSchema = z.object({
  outputMapping: z.record(z.string(), z.string()).optional(),
  // keys = output field names, values = context expressions e.g. "{{context.steps.AI1.output}}"
});
```

#### Text-to-Text Node

```typescript
const TextToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1), // configured model reference
  connectionId: z.string().min(1).optional(), // LLM connection/credential
  systemPrompt: z.string().optional(),
  humanPrompt: z.string().min(1), // supports {{context...}} expressions
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  timeout: z.number().int().min(30).max(180).default(60),
  outputSchema: z.record(z.string(), z.unknown()).optional(), // JSON Schema for structured output
});
```

#### Text-to-Image Node

```typescript
const TextToImageNodeConfigSchema = z.object({
  modelId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  prompt: z.string().min(1), // supports {{context...}} expressions
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  numImages: z.number().int().min(1).max(4).default(1),
  timeout: z.number().int().min(30).max(300).default(120),
});
```

#### Audio-to-Text Node

```typescript
const AudioToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  audioSource: z.string().min(1), // context expression or URL
  language: z.string().optional(),
  timeout: z.number().int().min(30).max(300).default(120),
});
```

#### Image-to-Text Node

```typescript
const ImageToTextNodeConfigSchema = z.object({
  modelId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  imageSource: z.string().min(1), // context expression or URL
  prompt: z.string().min(1), // what to analyze/describe
  maxTokens: z.number().int().positive().optional(),
  timeout: z.number().int().min(30).max(180).default(60),
});
```

#### API Node

```typescript
const ApiNodeConfigSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().min(1), // supports {{context...}} expressions
  headers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.string(),
      }),
    )
    .default([]),
  body: z
    .object({
      type: z.enum(['none', 'json', 'form', 'xml', 'custom']),
      content: z.string().optional(), // supports {{context...}} expressions
    })
    .default({ type: 'none' }),
  auth: z
    .object({
      type: z.enum(['none', 'pre_authorized', 'user_level']),
      profileId: z.string().min(1).optional(),
    })
    .default({ type: 'none' }),
  mode: z.enum(['sync', 'async']).default('sync'),
  timeout: z.number().int().min(5).max(300).default(60),
});
```

#### Function Node

```typescript
const FunctionNodeConfigSchema = z.object({
  language: z.literal('javascript'), // Python deferred
  mode: z.enum(['inline', 'custom_script']), // inline code or reference deployed script
  code: z.string().optional(), // for inline mode
  scriptId: z.string().min(1).optional(), // for custom_script mode
  functionName: z.string().min(1).optional(), // for custom_script mode
  inputVariables: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(['string', 'number', 'json', 'boolean']),
        value: z.string(), // context expression
      }),
    )
    .default([]),
  timeout: z.number().int().min(5).max(60).default(10),
});
```

#### Integration Node

```typescript
const IntegrationNodeConfigSchema = z.object({
  connectionId: z.string().min(1), // pre-configured integration connection
  action: z.string().min(1), // action identifier from connector
  inputMapping: z.record(z.string(), z.string()).default({}), // param name -> context expression
});
```

#### Condition Node

```typescript
const ConditionNodeConfigSchema = z.object({
  conditions: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().default('If'), // "If", "Else If"
        expression: z.string().min(1), // e.g. "{{context.steps.API1.output.status}} === 200"
        operator: z
          .enum([
            'equals',
            'not_equals',
            'greater_than',
            'less_than',
            'contains',
            'not_contains',
            'is_empty',
            'is_not_empty',
            'matches_regex',
          ])
          .optional(),
        // simplified mode: field + operator + value
        field: z.string().optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1),
  logic: z.enum(['and', 'or']).default('and'), // combine multiple criteria within a condition
});
// Note: the "Else" path is implicit — the edge not matched by any condition
```

#### Loop Node

```typescript
const LoopNodeConfigSchema = z.object({
  source: z.string().min(1), // context expression resolving to an array
  itemAlias: z.string().default('currentItem'), // reference current item as {{currentItem}}
  outputField: z.string().min(1), // field name to collect results into
  onError: z.enum(['continue', 'terminate', 'remove_failed']).default('continue'),
  maxIterations: z.number().int().positive().default(1000), // safety limit
});
```

#### Human Node

```typescript
const HumanNodeConfigSchema = z.object({
  subject: z.string().min(1), // supports {{context...}} expressions
  message: z.string().min(1), // rich text with context vars
  assignTo: z.enum(['everyone', 'specific']),
  assignees: z.array(z.string().email()).optional(), // required if assignTo === 'specific'
  contextFields: z.array(z.string()).optional(), // context paths to include as visible data
  timeout: z
    .object({
      duration: z.number().int().positive(),
      unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
    })
    .optional(), // undefined = no timeout (wait indefinitely)
  onTimeout: z.enum(['terminate', 'skip']).default('terminate'),
});
```

#### Agentic App Node

```typescript
const AgenticAppNodeConfigSchema = z.object({
  agentId: z.string().min(1),
  deploymentEnv: z.string().min(1).optional(), // deployment environment
  input: z.string().min(1), // text with {{context...}} expressions
  timeout: z.number().int().min(30).max(600).default(120),
});
```

#### Delay Node

```typescript
const DelayNodeConfigSchema = z.object({
  duration: z.number().int().positive(),
  unit: z.enum(['seconds', 'minutes', 'hours', 'days']),
});
```

#### Browser Node (Stub)

```typescript
const BrowserNodeConfigSchema = z.object({
  automationId: z.string().min(1).optional(),
  inputMapping: z.record(z.string(), z.string()).default({}),
});
// Executor returns: { error: { code: 'NOT_IMPLEMENTED', message: 'Browser node is not yet available' } }
```

#### DocSearch Node (Stub)

```typescript
const DocSearchNodeConfigSchema = z.object({
  query: z.string().min(1).optional(),
});
// Executor returns: { error: { code: 'NOT_IMPLEMENTED', message: 'DocSearch node is not yet available' } }
```

#### Doc Intelligence Node (Stub)

```typescript
const DocIntelligenceNodeConfigSchema = z.object({
  documentSource: z.string().min(1).optional(),
});
// Executor returns: { error: { code: 'NOT_IMPLEMENTED', message: 'Doc Intelligence node is not yet available' } }
```

---

## 3. Data Model

### 3.1 MongoDB Collections

Four collections replace the existing three. All use `tenantIsolationPlugin`.

#### `workflows` — Workflow Definitions

```typescript
interface WorkflowDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;

  // Canvas state (persisted for XY Flow)
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];

  // Workflow-level configuration
  envVars: Record<string, string>;
  inputSchema?: JsonSchemaDefinition;
  outputSchema?: JsonSchemaDefinition;

  status: 'draft' | 'active' | 'archived';

  // Deployment (null if not deployed)
  deployment?: WorkflowDeployment;

  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  _v: number;
}

interface WorkflowNode {
  id: string; // unique within workflow
  nodeType: NodeType; // discriminated union key
  name: string; // user-editable display name (e.g. "Function0001")
  position: { x: number; y: number }; // canvas position for XY Flow
  config: NodeConfig; // type-specific config (see Section 2.2)
}

interface WorkflowEdge {
  id: string;
  source: string; // source node id
  sourceHandle: string; // "on_success" | "on_failure" | "on_approval" | "on_decline" | "on_timeout" | "if_0" | "if_1" | "else"
  target: string; // target node id
  label?: string; // display label on canvas
}

type NodeType =
  | 'start'
  | 'end'
  | 'condition'
  | 'loop'
  | 'delay'
  | 'text_to_text'
  | 'text_to_image'
  | 'audio_to_text'
  | 'image_to_text'
  | 'api'
  | 'function'
  | 'integration'
  | 'browser'
  | 'doc_search'
  | 'doc_intelligence'
  | 'human'
  | 'agentic_app';

interface WorkflowDeployment {
  endpointSlug: string;
  mode: 'sync' | 'async_poll' | 'async_push';
  asyncPushConfig?: {
    webhookUrl: string;
    accessToken: string; // encrypted at rest
  };
  timeout: number; // seconds, 60-600
  deployedAt: Date;
  deployedBy: string;
  deployedVersion: number;
}
```

**Indexes:**

- `{ tenantId: 1, projectId: 1, name: 1 }` — unique
- `{ tenantId: 1, projectId: 1, status: 1 }`
- `{ 'deployment.endpointSlug': 1 }` — unique sparse (only deployed workflows)

#### `workflow_executions` — Execution Tracking

```typescript
interface WorkflowExecutionDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;

  status: 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled';
  triggerType: 'manual' | 'api' | 'trigger' | 'schedule';

  input: Record<string, unknown>;
  output?: Record<string, unknown>;

  nodeExecutions: NodeExecution[];
  context: Record<string, unknown>; // runtime context

  // Restate correlation
  restateWorkflowId?: string;

  startedAt: Date;
  completedAt?: Date;
  error?: { code: string; message: string };

  // Performance
  durationMs?: number;
}

interface NodeExecution {
  nodeId: string;
  nodeName: string;
  nodeType: NodeType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  // Loop-specific
  iteration?: number;
  iterationResults?: unknown[];
}
```

**Indexes:**

- `{ tenantId: 1, restateWorkflowId: 1 }` — unique sparse
- `{ tenantId: 1, workflowId: 1, status: 1 }`
- `{ tenantId: 1, projectId: 1, startedAt: -1 }`
- `{ status: 1, startedAt: 1 }` — for cleanup TTL queries

#### `workflow_api_keys` — Per-Workflow API Keys

```typescript
interface WorkflowApiKeyDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  name: string;
  keyHash: string; // SHA-256 hash (hex)
  keyPrefix: string; // first 8 chars for display ("wfk_a1b2...")
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdBy: string;
  createdAt: Date;
}
```

**Indexes:**

- `{ tenantId: 1, workflowId: 1 }`
- `{ keyPrefix: 1 }` — for quick lookup
- `{ expiresAt: 1 }` — TTL index for auto-cleanup of expired keys

#### Inbox — Reuses Existing `human_tasks` Collection

Instead of a new collection, the Inbox UI queries the existing `HumanTask` model (`packages/database/src/models/human-task.model.ts`). The Human node executor creates `HumanTask` records with `source.type = 'workflow_human_task'` (for general human tasks) or `source.type = 'workflow_approval'` (for approval-specific tasks).

The existing `HumanTask` model already supports:

- `assignedTo` (specific user) and `assignedToTeam` (group assignment)
- `claimedBy` for group task claiming
- `status`: pending, assigned, in_progress, completed, expired, cancelled
- `fields` array for form schema (data collection)
- `response` with `decision`, `fields`, `notes`, `respondedBy`, `respondedAt`
- `dueAt` for timeout/expiry
- `priority` levels (low, medium, high, critical)
- `escalationChain` and `currentEscalationLevel`
- `context` for passing workflow context data
- `source` discriminated union linking back to workflow/execution/node

**Mapping from Human node config to HumanTask:**

```typescript
{
  type: 'approval',                              // or 'data_entry', 'review' based on use case
  title: resolvedSubject,                        // from human node subject with expressions resolved
  description: resolvedMessage,                  // from human node message
  source: {
    type: 'workflow_human_task',
    workflowId: workflow._id,
    executionId: execution._id,
    stepId: node.id,                             // node ID, not name
  },
  assignedTo: config.assignTo === 'specific' ? config.assignees[0] : undefined,
  assignedToTeam: config.assignTo === 'everyone' ? 'all' : undefined,
  context: extractedContextData,
  dueAt: calculateExpiryDate(config.timeout),
  priority: 'medium',                            // default, can be made configurable later
}
```

**Existing indexes on `human_tasks` are sufficient:**

- `{ tenantId: 1, projectId: 1, status: 1, createdAt: -1 }`
- `{ 'source.type': 1, 'source.executionId': 1, 'source.stepId': 1 }`
- `{ status: 1, dueAt: 1 }`

#### `workflow_versions` — Version Snapshots (simplified)

```typescript
interface WorkflowVersionDocument {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  version: number;
  definition: {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    envVars: Record<string, string>;
    inputSchema?: JsonSchemaDefinition;
    outputSchema?: JsonSchemaDefinition;
  };
  changelog?: string;
  createdBy: string;
  createdAt: Date;
}
```

**Indexes:**

- `{ tenantId: 1, projectId: 1, workflowId: 1, version: 1 }` — unique

---

## 4. Workflow Engine Architecture

### 4.1 Overview

The workflow engine remains a standalone Express service on port 9080 with a Restate HTTP/2 endpoint on port 9081. The internal architecture changes from a step-queue model to a graph-walker model.

### 4.2 Component Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Workflow Engine                           │
│                                                             │
│  ┌─────────────────┐     ┌──────────────────────────────┐  │
│  │   Express API    │     │      Restate Endpoint         │  │
│  │   (port 9080)    │     │      (port 9081)              │  │
│  │                  │     │                               │  │
│  │  - executions    │     │  workflow-runner service:     │  │
│  │  - inbox         │     │    run()  — graph execution   │  │
│  │  - deployment    │     │    cancel()                   │  │
│  │  - api-keys      │     │    resolveHuman()             │  │
│  │  - connectors    │     │                               │  │
│  └────────┬─────────┘     └──────────────┬───────────────┘  │
│           │                              │                   │
│           ▼                              ▼                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  Graph Walker                        │    │
│  │                                                      │    │
│  │  1. Load workflow definition (nodes + edges)         │    │
│  │  2. Find start node                                  │    │
│  │  3. Execute current node via Node Dispatcher         │    │
│  │  4. Update context with node output                  │    │
│  │  5. Follow edge based on result (success/failure)    │    │
│  │  6. Repeat until end node or failure                 │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                    │
│                         ▼                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                Node Dispatcher                       │    │
│  │                                                      │    │
│  │  Routes to executor by nodeType:                     │    │
│  │                                                      │    │
│  │  start          → StartExecutor                      │    │
│  │  end            → EndExecutor                        │    │
│  │  text_to_text   → TextToTextExecutor                 │    │
│  │  text_to_image  → TextToImageExecutor                │    │
│  │  audio_to_text  → AudioToTextExecutor                │    │
│  │  image_to_text  → ImageToTextExecutor                │    │
│  │  api            → ApiExecutor                        │    │
│  │  function       → FunctionExecutor                   │    │
│  │  integration    → IntegrationExecutor                │    │
│  │  condition      → ConditionExecutor                  │    │
│  │  loop           → LoopExecutor                       │    │
│  │  human          → HumanExecutor                      │    │
│  │  agentic_app    → AgenticAppExecutor                 │    │
│  │  delay          → DelayExecutor                      │    │
│  │  browser        → StubExecutor                       │    │
│  │  doc_search     → StubExecutor                       │    │
│  │  doc_intelligence → StubExecutor                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Context Store    │  │ Exec Store   │  │ Redis PubSub │  │
│  │  (runtime ctx)    │  │ (MongoDB)    │  │ (events)     │  │
│  └──────────────────┘  └──────────────┘  └──────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### 4.3 Graph Walker Algorithm

```
function walkGraph(workflowDef, input, restateCtx):
  context = { input, steps: {}, env: workflowDef.envVars }
  nodeMap = buildNodeMap(workflowDef.nodes)
  edgeMap = buildEdgeMap(workflowDef.edges)

  currentNode = findStartNode(workflowDef.nodes)

  while currentNode is not null:
    updateNodeExecution(executionId, currentNode.id, 'running')
    publishEvent('node:started', currentNode)

    result = restateCtx.run(() =>
      nodeDispatcher.execute(currentNode, context)
    )

    if result.success:
      context.steps[currentNode.name] = { output: result.output }
      updateNodeExecution(executionId, currentNode.id, 'completed', result)
      publishEvent('node:completed', currentNode)

      if currentNode.nodeType === 'end':
        return { status: 'completed', output: result.output }

      if currentNode.nodeType === 'condition':
        nextEdge = findEdgeByHandle(edgeMap, currentNode.id, result.branchId)
      else:
        nextEdge = findEdgeByHandle(edgeMap, currentNode.id, 'on_success')

      currentNode = nextEdge ? nodeMap[nextEdge.target] : null

    else if result.suspend:
      // Human node, delay, async webhook
      updateNodeExecution(executionId, currentNode.id, 'waiting')

      if result.suspend.type === 'human':
        createInboxTask(currentNode, context, executionId)
        resolution = await restateCtx.promise('sys:human:' + currentNode.id)
        context.steps[currentNode.name] = { output: resolution }
        // Route based on resolution
        handle = resolution.decision === 'approved' ? 'on_approval'
               : resolution.decision === 'declined' ? 'on_decline'
               : 'on_timeout'
        nextEdge = findEdgeByHandle(edgeMap, currentNode.id, handle)

      else if result.suspend.type === 'delay':
        await restateCtx.sleep(result.suspend.durationMs)
        nextEdge = findEdgeByHandle(edgeMap, currentNode.id, 'on_success')

      updateNodeExecution(executionId, currentNode.id, 'completed')
      currentNode = nextEdge ? nodeMap[nextEdge.target] : null

    else: // failure
      context.steps[currentNode.name] = { error: result.error }
      updateNodeExecution(executionId, currentNode.id, 'failed', result)
      publishEvent('node:failed', currentNode)

      failureEdge = findEdgeByHandle(edgeMap, currentNode.id, 'on_failure')
      if failureEdge:
        currentNode = nodeMap[failureEdge.target]
      else:
        return { status: 'failed', error: result.error }

  return { status: 'completed', output: context }
```

### 4.4 Node Executor Interface

All executors implement the same interface:

```typescript
interface NodeExecutorResult {
  success: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  // Control flow signals
  suspend?: {
    type: 'human' | 'delay';
    durationMs?: number; // for delay
    inboxTask?: InboxTaskInput; // for human
  };
  branchId?: string; // for condition nodes — which edge to follow
  loopResults?: unknown[]; // for loop nodes — collected iteration results
}

interface NodeExecutor {
  execute(
    node: WorkflowNode,
    context: WorkflowContext,
    deps: ExecutorDependencies,
  ): Promise<NodeExecutorResult>;
}
```

### 4.5 Executor Details

#### StartExecutor

Validates input against `inputVariables` schema. Seeds `context.input`. Always succeeds unless validation fails.

#### EndExecutor

Resolves `outputMapping` expressions against context. Returns the collected output. Marks execution as complete.

#### TextToTextExecutor

1. Resolve `systemPrompt` and `humanPrompt` expressions against context
2. Look up model and connection from platform config
3. Call LLM via provider-neutral interface (existing `@abl/compiler` model chain)
4. If `outputSchema` is defined, request structured output (JSON mode)
5. Return response text (or parsed JSON) as output

#### TextToImageExecutor

1. Resolve prompt expressions
2. Call image generation API (route through model chain)
3. Return image URL(s) as output

#### AudioToTextExecutor

1. Resolve audio source (URL or base64 from context)
2. Call speech-to-text model
3. Return transcribed text as output

#### ImageToTextExecutor

1. Resolve image source (URL or base64 from context)
2. Resolve analysis prompt
3. Call vision model
4. Return analysis text as output

#### ApiExecutor

1. Resolve URL, headers, body expressions
2. Apply auth profile if configured
3. Make HTTP request (sync mode: await response; async mode: fire and return)
4. Timeout handling per node config
5. Return response body as output, HTTP status in metadata

#### FunctionExecutor

1. Resolve input variable values from context
2. **Inline mode**: Execute JS code in `isolated-vm` sandbox with 128MB memory limit and configured timeout
3. **Custom script mode**: Load deployed script, invoke named function with mapped arguments
4. Sandbox has access to: input variables, `JSON`, `Math`, `Date`, `console.log` (captured to logs)
5. Sandbox does NOT have access to: `require`, `import`, `fetch`, `fs`, `process`, `global`
6. Return the value of `result` variable as output; capture `console.log` output to execution logs

#### IntegrationExecutor

1. Look up connection by `connectionId`
2. Resolve input mapping expressions
3. Execute connector action via `ConnectorToolExecutor` (existing infrastructure)
4. Return action result as output

#### ConditionExecutor

1. Evaluate each condition in order:
   - Resolve field expressions against context
   - Apply operator comparison
   - Combine with AND/OR logic
2. Return `branchId` of first matching condition
3. If none match, return `'else'`

#### LoopExecutor

1. Resolve `source` expression to get the array
2. **Identify loop body subgraph**: Follow the `loop_body` edge from the loop node. All nodes reachable from that edge, up to (but not including) any node that has an edge back to the loop node or to a node outside the loop, constitute the loop body. Concretely:
   - The loop node has two output handles: `loop_body` (connects to the first node of the body) and `on_complete` (connects to the next node after the loop)
   - The last node(s) in the body subgraph connect back to a special `loop_return` input handle on the loop node, signaling "iteration complete"
   - The graph walker detects loop body boundaries by tracking nodes between the `loop_body` edge and the `loop_return` back-edge
3. For each item (up to `maxIterations`):
   - Set `context[itemAlias]` = current item
   - Set `context[itemAlias + 'Index']` = current iteration index
   - Execute the body subgraph using the same graph walker algorithm (recursive call)
   - Collect the last node's output into `outputField` array
4. Handle errors per `onError` config (continue / terminate / remove_failed)
5. Return collected results array as output

#### HumanExecutor

1. Resolve `subject` and `message` expressions
2. Extract `contextFields` from context for display
3. Return suspend signal with inbox task data
4. Graph walker handles the actual inbox task creation and durable promise

#### AgenticAppExecutor

1. Resolve `input` expression
2. Call runtime API: `POST /api/v1/chat` with agent ID and input
3. Await response (with timeout)
4. Return agent response as output

#### DelayExecutor

1. Calculate duration in milliseconds from config (duration + unit)
2. Return suspend signal with `durationMs`
3. Graph walker handles the actual `ctx.sleep()`

#### StubExecutor (Browser, DocSearch, DocIntelligence)

Returns `{ success: false, error: { code: 'NOT_IMPLEMENTED', message: '<NodeType> node is not yet available' } }`.

### 4.6 Expression Resolver

Reuse and adapt the existing expression resolver from `apps/workflow-engine/src/context/expression-resolver.ts`.

**Supported expression syntax:**

- `{{context.input.fieldName}}` — workflow input
- `{{context.steps.NodeName.output}}` — full node output
- `{{context.steps.NodeName.output.field.nested}}` — nested field access
- `{{context.steps.NodeName.error}}` — node error
- `{{context.env.VAR_NAME}}` — environment variable
- `{{currentItem}}` — current loop iteration item (inside loop body)
- `{{currentItem.fieldName}}` — nested access on loop item

Template literals with mixed text: `"Hello {{context.steps.Start.output.name}}, your order {{context.steps.API0001.output.orderId}} is confirmed."`

**Node naming and context keys:**

- Context keys use the node's `name` property (e.g., `TextToText0001`, `API0001`)
- Node names are auto-generated on creation, must be unique within the workflow
- **Allowed characters:** `[A-Za-z0-9_]` only — no spaces, dots, or special characters
- **Rename refactoring:** Renaming a node in the canvas triggers an automatic update of all `{{context.steps.OldName...}}` expressions in downstream nodes. The UI shows a confirmation dialog listing affected expressions before applying.
- The engine maintains an internal `nodeId → nodeName` map so context is resolvable by either identifier during execution

### 4.7 Timeout Hierarchy

```
Workflow timeout (deployment.timeout, 60-600s)
  └─ Node timeout (per-node config)
      └─ Model timeout (for AI nodes, per-model config)
```

If a node exceeds its timeout, execution fails for that node and follows the `on_failure` edge. If the workflow timeout is reached, the entire execution is cancelled.

### 4.8 Cancellation

Same mechanism as current engine — race a `sys:cancel` durable promise against the main execution. When cancelled:

1. Mark current node as `failed` with code `CANCELLED`
2. Mark execution as `cancelled`
3. Publish cancellation event
4. Do not follow any edges

---

## 5. Visual Canvas (Studio UI)

### 5.1 Layout — Three Panel Design

Matching the Kore.ai reference screenshot:

**Top Bar:**

- Left: Back arrow, Run button (play icon), Grab/pan tool, Search
- Center: Workflow name + "Flow versions" dropdown + warning count badge
- Right: "Manage I/O" button, Zoom percentage dropdown, Change log (clock icon), Deploy button

**Left Panel — Assets Sidebar (~200px):**

- Flat list of node types, each with icon and chevron expander
- Order: AI, Integration, Doc, API, DocSearch, Function, Browser, Human, Condition, Loop, Agentic app, Delay, End
- Start node is NOT in the palette (auto-placed on workflow creation)
- Chevron expands to show sub-types (e.g., AI expands to: Text-to-Text, Text-to-Image, Audio-to-Text, Image-to-Text)
- Drag from palette onto canvas to add a node
- Deferred/stub nodes shown with "Coming soon" badge

**Center — XY Flow Canvas:**

- Light gray background with subtle dot grid
- Nodes rendered as cards (see Section 5.2)
- Edges rendered as curved Bezier arrows
- Supports: zoom (mouse wheel), pan (click+drag background), select (click node), multi-select (shift+click), delete (Delete key)
- Minimap in bottom-right corner
- Undo/Redo via Ctrl+Z / Ctrl+Y

**Right Panel — Config Panel (~380px):**

- Opens when a node is selected, closes on background click or X button
- Header: Node type icon + node name (editable) + close button
- Left icon sidebar: vertical strip of small icons for config sections (settings, input/output, timing, connections)
- Input/Output toggle tabs at top
- Node-specific configuration form below
- Context autocomplete: typing `{{context.` shows dropdown of available upstream node outputs

**Bottom Bar — Quick-Add Toolbar:**

- Horizontal scrollable strip of node type icons with labels
- Icons: AI, Integration, Doc, API, DocSearch, Function, Browser, Human, Condition, Loop, Agentic app, Delay, End
- Click to add node at default canvas position

### 5.2 Node Card Visual Design

**Start Node:**

```
┌─────────────────────┐
│ 🏁  Start         ● │  (green pill, single right output handle)
└─────────────────────┘
```

**End Node:**

```
┌─────────────────────┐
│ ●  ⊙  End           │  (dark gray pill, single left input handle)
└─────────────────────┘
```

**Standard Nodes (API, Function, Integration, AI, etc.):**

```
┌─[colored header]────────┐
│  <icon>  NodeName0001   │
├─────────────────────────┤
│  on success           ● │  (small dot, output handle)
│  on failure           ● │  (small dot, output handle, red)
└─────────────────────────┘
Input handle on left edge (implicit, no dot shown until hover/connect)
```

**Condition Node:**

```
┌─[brown header]──────────┐
│  ◇  Condition0001       │
├─────────────────────────┤
│  If: status == 200    ● │
│  Else If: ...         ● │
│  Else                 ● │
└─────────────────────────┘
```

**Human Node:**

```
┌─[warm gray header]──────┐
│  👤  Human0001          │
├─────────────────────────┤
│  on approval          ● │
│  on decline           ● │
│  on timeout           ● │
│  on failure           ● │
└─────────────────────────┘
```

**Loop Node:**

```
┌─[gray header]───────────┐
│  ∞  Loop0001            │
├─────────────────────────┤
│  loop body            ● │  (connects to child subgraph)
│  on complete          ● │
│  on failure           ● │
└─────────────────────────┘
```

### 5.3 Edge Rendering

- **Default edge**: Curved gray Bezier arrow with arrowhead at target
- **Failure edge**: Dashed, red-tinted
- **Condition branches**: Labeled with condition text ("If: ...", "Else")
- **Human resolution edges**: Labeled ("Approved", "Declined", "Timeout")
- Edge creation: drag from output handle dot to target node
- Edge deletion: select edge + Delete key, or right-click > Delete

### 5.4 Config Panel Sections

#### Input Tab (all node types)

- List of input variables with name, type, and value (context expression)
- "Add input variable" button
- Auto-populated from node config schema where applicable

#### Output Tab (all node types)

- Shows what this node produces
- Output field name and type
- Preview of output path: `{{context.steps.<NodeName>.output}}`

#### Settings Tab (node-type-specific)

**Text-to-Text:**

- Model selector dropdown (from configured models)
- Connection selector (LLM credentials)
- System prompt textarea
- Human prompt textarea (with {{context}} autocomplete)
- Hyperparameters: Temperature slider, Top-p, Top-k, Max tokens
- Timeout slider (30-180s)
- Output schema toggle + JSON schema editor

**API:**

- Method dropdown (GET/POST/PUT/PATCH/DELETE)
- URL input (with {{context}} autocomplete)
- Headers key-value editor
- Body type selector + content editor
- Auth type selector + profile dropdown
- Mode toggle (sync/async)
- Timeout slider

**Function:**

- Mode toggle: Inline / Custom Script
- Code editor (Monaco editor, JavaScript syntax highlighting)
- Input variables table: name, type dropdown, value (context expression)
- Test panel: Context Input tab, Context Output tab, Log tab
- Run button for in-node testing

**Condition:**

- Condition builder: field input + operator dropdown + value input
- AND/OR toggle for multiple criteria
- "Add Else If" button
- Visual preview of branches

**Human:**

- Subject input (with {{context}} autocomplete)
- Message textarea
- Assign to: Everyone / Specific users radio
- User email multi-select (when Specific)
- Timeout: None / Custom duration
- On timeout: Terminate / Skip radio

**Integration:**

- Connection selector dropdown (from configured integrations)
- Action selector (populated from connector definition)
- Input parameter mapping table
- JSON preview toggle

### 5.5 Toolbar Actions

| Button            | Action                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **Back arrow**    | Navigate back to workflows list                                                               |
| **Run (▶)**       | Open run dialog — enter input values, execute workflow, show live execution overlay on canvas |
| **Grab tool**     | Toggle pan mode                                                                               |
| **Search**        | Search nodes by name/type                                                                     |
| **Flow versions** | Dropdown: list versions, create new version, switch to version (read-only for deployed)       |
| **Warning badge** | Click to see validation errors/warnings list                                                  |
| **Manage I/O**    | Open workflow-level input/output schema editor                                                |
| **Zoom**          | Zoom dropdown (50%, 75%, 100%, 125%, 150%, Fit)                                               |
| **Change log**    | Show canvas change history                                                                    |
| **Deploy**        | Open deploy panel (see Section 6)                                                             |

### 5.6 Run/Test Overlay

When the user clicks Run:

1. Modal dialog to enter input variable values
2. Click "Run" to execute
3. Canvas shows live execution state:
   - Currently executing node: pulsing border animation
   - Completed nodes: green checkmark badge
   - Failed nodes: red X badge
   - Skipped nodes: gray skip badge
4. Execution log panel slides up from bottom showing real-time node execution logs
5. On completion: output displayed in the log panel

### 5.7 Auto-Naming Convention

New nodes get auto-generated names following Kore.ai pattern:

- `Start` (fixed, single instance)
- `TextToText0001`, `TextToText0002`, ...
- `API0001`, `Function0001`, `Integration0001`, ...
- `End0001`, `End0002`, ...

Users can rename via the config panel header.

### 5.8 Validation

Real-time validation with warning badge count in toolbar:

| Rule                                                       | Severity                  |
| ---------------------------------------------------------- | ------------------------- |
| No start node                                              | Error                     |
| No end node                                                | Error                     |
| Disconnected nodes (no incoming or outgoing edges)         | Warning                   |
| Node missing required config                               | Error                     |
| Condition node with no conditions defined                  | Error                     |
| Loop node with no body edge                                | Error                     |
| Circular edge without loop node                            | Error                     |
| Human node with 'specific' assignTo but no assignees       | Error                     |
| Stub node used (browser, doc_search, doc_intelligence)     | Error (blocks deployment) |
| Duplicate node names                                       | Error                     |
| Node name contains invalid characters (not `[A-Za-z0-9_]`) | Error                     |

---

## 6. API Endpoint Generation & Deployment

### 6.1 Deployment Flow

1. User clicks Deploy in toolbar
2. Deploy panel opens (right side or modal):
   - Validation status (must pass before deploy)
   - Endpoint slug (auto-generated from workflow name, editable)
   - Mode selector: Sync / Async Poll / Async Push
   - Async Push config (if selected): Webhook URL + Access Token
   - Timeout slider (60-600s, default 180s)
   - API Keys section: list, create, revoke
   - Generated endpoint URL display with copy button
3. Click "Deploy" to activate
4. Current definition is snapshotted as a new version
5. Endpoint becomes live

### 6.2 Public Execution Routes

These routes live on the workflow engine service, completely separate from the platform auth flow:

```
POST   /api/v1/run/:slug                         — Execute workflow
GET    /api/v1/run/:slug/status/:executionId      — Poll execution status (async-poll only)
```

#### Execute Workflow

```
POST /api/v1/run/:slug
Authorization: Bearer wfk_a1b2c3d4e5f6g7h8...
Content-Type: application/json

{
  "input": {
    "customerName": "Jane Doe",
    "orderId": "ORD-12345"
  }
}
```

**Sync response (200):**

```json
{
  "executionId": "exec_abc123",
  "status": "completed",
  "output": {
    "confirmation": "Order ORD-12345 processed for Jane Doe",
    "estimatedDelivery": "2026-03-20"
  },
  "durationMs": 3420
}
```

**Async-poll response (202):**

```json
{
  "executionId": "exec_abc123",
  "status": "running",
  "statusUrl": "/api/v1/run/travel-reimbursement/status/exec_abc123"
}
```

**Async-push response (202):**

```json
{
  "executionId": "exec_abc123",
  "status": "running"
}
// Later, engine POSTs to webhook:
// POST <webhookUrl>
// Authorization: Bearer <accessToken>
// { "executionId": "exec_abc123", "status": "completed", "output": { ... } }
```

#### Poll Status

```
GET /api/v1/run/:slug/status/:executionId
Authorization: Bearer wfk_a1b2c3d4e5f6g7h8...
```

**Response:**

```json
{
  "executionId": "exec_abc123",
  "status": "running",
  "nodeExecutions": [
    { "nodeName": "Start", "status": "completed", "durationMs": 5 },
    { "nodeName": "TextToText0001", "status": "running" }
  ],
  "startedAt": "2026-03-17T15:30:00Z",
  "output": null
}
```

### 6.3 API Key Auth Middleware

```typescript
async function workflowApiKeyAuth(req, res, next) {
  const slug = req.params.slug;
  const token = extractBearerToken(req);

  if (!token)
    return res.status(401).json({
      success: false,
      error: { code: 'MISSING_API_KEY', message: 'Authorization header required' },
    });

  // Find workflow by slug
  const workflow = await WorkflowModel.findOne({ 'deployment.endpointSlug': slug });
  if (!workflow)
    return res.status(404).json({
      success: false,
      error: { code: 'WORKFLOW_NOT_FOUND', message: 'No deployed workflow found' },
    });

  // Find matching API key (tenantId scoped per Core Invariant #1, SHA-256 direct lookup)
  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const matchedKey = await WorkflowApiKeyModel.findOne({
    tenantId: workflow.tenantId,
    workflowId: workflow._id,
    keyHash,
  });

  if (!matchedKey)
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_API_KEY', message: 'Invalid API key' },
    });

  if (matchedKey.expiresAt && matchedKey.expiresAt < new Date()) {
    return res.status(401).json({
      success: false,
      error: { code: 'EXPIRED_API_KEY', message: 'API key has expired' },
    });
  }

  // Update last used timestamp (fire-and-forget)
  WorkflowApiKeyModel.updateOne({ _id: matchedKey._id }, { lastUsedAt: new Date() });

  req.workflow = workflow;
  req.tenantId = workflow.tenantId;
  next();
}
```

### 6.4 Management Routes (Platform-Authenticated)

```
POST   /api/projects/:projectId/workflows/:id/deploy
DELETE /api/projects/:projectId/workflows/:id/deploy
GET    /api/projects/:projectId/workflows/:id/deployment
POST   /api/projects/:projectId/workflows/:id/api-keys
GET    /api/projects/:projectId/workflows/:id/api-keys
DELETE /api/projects/:projectId/workflows/:id/api-keys/:keyId
```

All require `requireProjectPermission(req, res, 'workflow:deploy')`.

---

## 7. Inbox Page (Studio UI)

### 7.1 Page Location

New top-level route in Studio: `/projects/:projectId/inbox`

Accessible from the project sidebar navigation alongside Workflows, Agents, etc.

### 7.2 Layout

```
┌─────────────────────────────────────────────────────┐
│  Inbox                                    🔍 Search │
├────────────┬────────────┐                           │
│  Personal  │   Group    │                           │
├────────────┴────────────┴───────────────────────────┤
│  Status: [All ▾]   Sort: [Newest ▾]                │
├─────────────────────────────────┬───────────────────┤
│                                 │                   │
│  Task list (scrollable)         │  Detail panel     │
│                                 │                   │
│  ┌───────────────────────────┐  │  Subject          │
│  │ 🟡 Expense Approval       │  │  Message body     │
│  │   Travel Reimbursement    │  │  Context data     │
│  │   2 hours ago | Due: 24h  │  │                   │
│  └───────────────────────────┘  │  Comment: [     ] │
│  ┌───────────────────────────┐  │                   │
│  │ 🟡 Contract Review        │  │  [Approve][Decline│
│  │   Vendor Onboarding       │  │                   │
│  │   5 hours ago | Due: 48h  │  │  ─────────────── │
│  └───────────────────────────┘  │  Workflow: <link> │
│                                 │  Execution: <link>│
│                                 │                   │
└─────────────────────────────────┴───────────────────┘
```

### 7.3 Features

- **Personal tab**: Tasks assigned to the current user or claimed by them
- **Group tab**: Tasks assigned to `everyone` (via `assignedToTeam: 'all'`) — user must click "Claim" to take ownership, which moves it to Personal
- **Status filter**: All, Pending, Approved, Declined, Expired
- **Detail panel**: Click a task to see full details, context data, and action buttons
- **Approve/Decline**: Submits decision with optional comment, resolves the Restate durable promise, task disappears from pending list
- **Workflow/Execution links**: Navigate directly to the workflow definition or execution monitor
- **Real-time updates**: WebSocket or polling for new tasks, status changes
- **Badge count**: Show unread/pending count in sidebar navigation

### 7.4 Inbox Data Source

The Inbox queries the existing `human_tasks` collection (see Section 3.1). No new collection is created.

**Personal tab query:**

```typescript
HumanTask.find({
  tenantId,
  projectId,
  'source.type': { $in: ['workflow_approval', 'workflow_human_task'] },
  $or: [{ assignedTo: currentUserId }, { claimedBy: currentUserId }],
  status: { $in: statusFilter },
}).sort({ createdAt: -1 });
```

**Group tab query:**

```typescript
HumanTask.find({
  tenantId,
  projectId,
  'source.type': { $in: ['workflow_approval', 'workflow_human_task'] },
  assignedToTeam: 'all',
  claimedBy: { $exists: false },
  status: 'pending',
}).sort({ createdAt: -1 });
```

### 7.5 Inbox API Routes

```
GET    /api/projects/:projectId/inbox                      — list tasks for current user
GET    /api/projects/:projectId/inbox/:taskId              — get task detail
POST   /api/projects/:projectId/inbox/:taskId/claim        — claim a group task
POST   /api/projects/:projectId/inbox/:taskId/resolve      — approve or decline
```

All require `requireProjectPermission(req, res, 'workflow:read')`. The resolve endpoint additionally verifies the current user is either the `assignedTo` user or the `claimedBy` user.

**Resolve request body:**

```json
{
  "decision": "approved",
  "comment": "Looks good, approved for Q2 budget."
}
```

### 7.6 Expiry Worker

A BullMQ repeatable job runs every 60 seconds to expire timed-out human tasks:

1. Query `human_tasks` where `status === 'pending'` and `dueAt < now()` and `source.type` is workflow-related
2. Update status to `expired`
3. Resolve the Restate durable promise with `{ decision: 'timeout' }`
4. The graph walker follows the `on_timeout` edge

---

## 8. Monitoring Tab (Workflow Detail Page)

### 8.1 Overview

The existing `WorkflowMonitorTab` in Studio is enhanced to provide Kore.ai-level monitoring.

### 8.2 Metrics Dashboard

Top-level metrics cards:

- **Total Runs** (in selected time period)
- **Success Rate** (percentage)
- **Avg Duration** (P50)
- **P90 Duration**
- **P99 Duration**
- **Currently Running** count

### 8.3 Execution List

Table of executions with columns:

- Execution ID (link to detail)
- Status (badge: running/completed/failed/cancelled)
- Trigger type
- Duration
- Started at
- Node count (completed/total)

Filters: status, trigger type, date range

### 8.4 Execution Detail View

When clicking into an execution:

- **Canvas overlay**: The workflow canvas with execution state overlaid (green/red badges on nodes, timing annotations)
- **Node execution timeline**: Gantt-style chart showing when each node started/completed
- **Node detail**: Click a node to see its input, output, error, duration
- **Logs**: Execution logs (Function node console output, HTTP request/response, etc.)

---

## 9. Files to Create / Replace

### 9.1 Delete (existing workflow system)

```
apps/workflow-engine/src/handlers/workflow-handler.ts
apps/workflow-engine/src/handlers/step-dispatcher.ts
apps/workflow-engine/src/executors/  (all existing executors)
apps/workflow-engine/src/services/restate-endpoint.ts
packages/shared-kernel/src/types/workflow-types.ts
packages/shared/src/types/workflow-schemas.ts
packages/shared/src/types/workflow-types.ts
packages/database/src/models/workflow.model.ts
packages/database/src/models/workflow-execution.model.ts
packages/database/src/models/workflow-version.model.ts
```

### 9.2 Create / Replace

**Shared types & schemas:**

```
packages/shared-kernel/src/types/workflow-types.ts        — new node type union, interfaces
packages/shared/src/types/workflow-schemas.ts             — new Zod schemas for all 16 node types
packages/database/src/models/workflow.model.ts            — new model with nodes/edges
packages/database/src/models/workflow-execution.model.ts  — new model with nodeExecutions
packages/database/src/models/workflow-version.model.ts    — simplified version model
packages/database/src/models/workflow-api-key.model.ts    — NEW
(workflow_inbox NOT needed — reuses existing human_tasks collection via HumanTask model)
```

**Workflow engine:**

```
apps/workflow-engine/src/services/restate-endpoint.ts     — updated for graph walker
apps/workflow-engine/src/engine/graph-walker.ts            — NEW: core graph traversal
apps/workflow-engine/src/engine/node-dispatcher.ts         — NEW: routes to executors by type
apps/workflow-engine/src/engine/context-store.ts           — NEW: runtime context management
apps/workflow-engine/src/executors/start-executor.ts       — NEW
apps/workflow-engine/src/executors/end-executor.ts         — NEW
apps/workflow-engine/src/executors/text-to-text-executor.ts — NEW
apps/workflow-engine/src/executors/text-to-image-executor.ts — NEW
apps/workflow-engine/src/executors/audio-to-text-executor.ts — NEW
apps/workflow-engine/src/executors/image-to-text-executor.ts — NEW
apps/workflow-engine/src/executors/api-executor.ts         — NEW (replaces http-executor)
apps/workflow-engine/src/executors/function-executor.ts    — NEW
apps/workflow-engine/src/executors/integration-executor.ts — NEW (replaces connector-action-executor)
apps/workflow-engine/src/executors/condition-executor.ts   — rewrite
apps/workflow-engine/src/executors/loop-executor.ts        — rewrite
apps/workflow-engine/src/executors/human-executor.ts       — rewrite
apps/workflow-engine/src/executors/agentic-app-executor.ts — NEW (replaces agent-invocation-executor)
apps/workflow-engine/src/executors/delay-executor.ts       — rewrite
apps/workflow-engine/src/executors/stub-executor.ts        — NEW (browser, doc_search, doc_intelligence)
apps/workflow-engine/src/routes/workflow-api-keys.ts       — NEW
apps/workflow-engine/src/routes/workflow-public.ts         — NEW: /api/v1/run/:slug routes
apps/workflow-engine/src/middleware/api-key-auth.ts        — NEW
apps/workflow-engine/src/services/inbox-expiry-worker.ts   — NEW
```

**Studio UI:**

```
apps/studio/src/components/workflows/WorkflowCanvas.tsx           — NEW: XY Flow canvas
apps/studio/src/components/workflows/canvas/NodePalette.tsx       — NEW: left sidebar
apps/studio/src/components/workflows/canvas/QuickAddBar.tsx       — NEW: bottom bar
apps/studio/src/components/workflows/canvas/ConfigPanel.tsx       — NEW: right config panel
apps/studio/src/components/workflows/canvas/CanvasToolbar.tsx     — NEW: top bar
apps/studio/src/components/workflows/canvas/nodes/               — NEW: XY Flow custom node components
  StartNode.tsx
  EndNode.tsx
  StandardNode.tsx         (used for API, Function, Integration, AI, etc.)
  ConditionNode.tsx
  LoopNode.tsx
  HumanNode.tsx
apps/studio/src/components/workflows/canvas/edges/
  DefaultEdge.tsx
  FailureEdge.tsx
apps/studio/src/components/workflows/canvas/config/              — NEW: per-node config forms
  StartNodeConfig.tsx
  EndNodeConfig.tsx
  TextToTextConfig.tsx
  TextToImageConfig.tsx
  AudioToTextConfig.tsx
  ImageToTextConfig.tsx
  ApiNodeConfig.tsx
  FunctionNodeConfig.tsx
  IntegrationNodeConfig.tsx
  ConditionNodeConfig.tsx
  LoopNodeConfig.tsx
  HumanNodeConfig.tsx
  AgenticAppNodeConfig.tsx
  DelayNodeConfig.tsx
  BrowserNodeConfig.tsx      (stub placeholder)
  DocSearchNodeConfig.tsx    (stub placeholder)
  DocIntelligenceNodeConfig.tsx (stub placeholder)
apps/studio/src/components/workflows/canvas/RunDialog.tsx        — NEW: test execution dialog
apps/studio/src/components/workflows/canvas/DeployPanel.tsx      — NEW: deployment config
apps/studio/src/components/workflows/canvas/VersionSelector.tsx  — NEW
apps/studio/src/components/workflows/canvas/ValidationPanel.tsx  — NEW
apps/studio/src/components/workflows/canvas/ExecutionOverlay.tsx — NEW: live execution on canvas
apps/studio/src/components/workflows/InboxPage.tsx               — NEW: centralized inbox
apps/studio/src/components/workflows/InboxDetail.tsx             — NEW
apps/studio/src/components/workflows/MonitorDashboard.tsx        — rewrite with metrics
apps/studio/src/components/workflows/ExecutionDetail.tsx         — rewrite with canvas overlay
apps/studio/src/stores/workflow-canvas-store.ts                  — NEW: Zustand store for canvas state
apps/studio/src/api/workflows.ts                                 — rewrite for new API shape
apps/studio/src/api/inbox.ts                                     — NEW
apps/studio/src/app/api/projects/[id]/inbox/                     — NEW: Studio proxy routes
apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/deploy/route.ts  — NEW
apps/studio/src/app/api/projects/[id]/workflows/[workflowId]/api-keys/route.ts — NEW
```

**Runtime:**

```
apps/runtime/src/routes/workflows.ts                     — update for new schema
apps/runtime/src/middleware/workflow-engine-proxy.ts      — update routes
apps/runtime/src/validation/workflow-validation.ts        — rewrite for node/edge validation
```

### 9.3 New Dependencies

```
@xyflow/react          — XY Flow canvas library
@xyflow/system         — XY Flow core
@monaco-editor/react   — Code editor for Function node
isolated-vm            — Sandboxed JS execution for Function node
dagre                  — Auto-layout algorithm for canvas
(bcryptjs NOT needed — using SHA-256 for API key hashing)
```

---

## 10. Security Considerations

### 10.1 Function Node Sandboxing

The Function node executes user-provided JavaScript. This MUST be sandboxed:

- Use `isolated-vm` with a separate V8 isolate per execution
- Memory limit: 128MB per isolate
- CPU timeout: per node config (default 10s, max 60s)
- No access to: Node.js APIs, `require`, `import`, file system, network, `process`, `global`
- Allowed: `JSON`, `Math`, `Date`, `String`, `Array`, `Object`, `console.log` (captured)
- Each execution gets a fresh isolate — no state leakage between executions

### 10.2 API Key Security

- Keys generated with cryptographically secure random bytes (32 bytes, base64url encoded)
- Stored as SHA-256 hashes (hex). API keys are high-entropy random strings (not user passwords), so a fast cryptographic hash is appropriate and avoids the ~250ms-per-comparison cost of bcrypt at scale.
- Full key shown once on creation, never retrievable after
- Key prefix stored for UI identification
- `keyHash` is indexed for O(1) lookup — no iteration over multiple keys needed
- Rate limiting on public endpoints: 100 requests/minute per API key (Redis-based distributed counter, returns 429 on limit exceeded)
- API keys scoped to a single workflow — cannot access other workflows

### 10.3 Expression Injection Prevention

- Expression resolver only allows property access on the context object
- No `eval()`, no `Function()` constructor
- Template expressions are resolved via string interpolation only — not evaluated as code
- Input validation on all expression strings

### 10.4 Async Push Webhook Security

- Webhook URL validated (must be HTTPS in production)
- Access token sent as Bearer token
- **Payload signed with HMAC-SHA-256**: Each webhook delivery includes an `X-Workflow-Signature` header containing `sha256=<hex>` computed over the JSON body using a per-workflow signing secret. Receivers can verify payload integrity.
- Outbound webhook timeout: 30 seconds
- Retry on failure: 3 attempts with exponential backoff
- No sensitive context data in webhook payload unless explicitly mapped in End node output

### 10.5 Rate Limiting (Public Endpoints)

- Distributed rate limiter using Redis `INCR` + `EXPIRE` (sliding window)
- Limit: 100 requests/minute per API key
- Response on limit exceeded: `429 Too Many Requests` with `Retry-After` header
- Rate limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- In-flight executions are NOT affected when rate limited — only new requests are rejected

### 10.6 Logging

All workflow engine code uses `createLogger('workflow-engine')` from `@abl/compiler/platform`. No `console.log` in server code (per CLAUDE.md).

Log levels:

- `info`: Workflow started, node completed, workflow completed, deployment created
- `warn`: Node timeout, retry attempt, rate limit approaching
- `error`: Node failed, workflow failed, sandbox crash, webhook delivery failure
- `debug`: Expression resolution, context updates, edge traversal decisions

---

## 11. Performance Considerations

- **Canvas rendering**: XY Flow virtualizes nodes — only visible nodes are rendered in DOM. Tested to 1000+ nodes.
- **Execution storage**: `nodeExecutions` array is embedded in the execution document. For workflows with 100+ nodes, this stays within MongoDB's 16MB document limit.
- **Function node**: `isolated-vm` creates V8 isolates in ~5ms, significantly faster than `vm2`. Isolate pool can be warmed if needed.
- **API key lookup**: `keyHash` is indexed — SHA-256 hash computed once, single indexed query, O(1) lookup.
- **Inbox queries**: Reuses existing `human_tasks` indexes: `(tenantId, projectId, status, createdAt)` and `(source.type, source.executionId, source.stepId)`.
- **Context size**: Runtime context grows with each node execution. For large workflows, implement context size limit (default 10MB) with clear error on overflow. For AI nodes returning large payloads (e.g., base64 images), store in object storage and put a reference URL in context.
- **Execution cleanup**: BullMQ repeatable job runs daily. Completed/failed executions older than 30 days are archived (moved to a TTL-indexed `workflow_executions_archive` collection or simply deleted, configurable per project). Running executions are never touched.
- **Dockerfile updates**: `isolated-vm` requires native compilation. The `apps/workflow-engine/Dockerfile` must include `python3`, `make`, and `g++` in the build stage for node-gyp. All Dockerfiles under `apps/` must be updated if new workspace packages are added (per CLAUDE.md).

---

## 12. Testing Strategy

### 12.1 Unit Tests

Every executor gets its own test file:

- `text-to-text-executor.test.ts` — mock LLM call, verify prompt resolution, structured output
- `api-executor.test.ts` — mock HTTP, test all methods, auth, timeout
- `function-executor.test.ts` — test sandbox isolation, timeout, input/output
- `condition-executor.test.ts` — test all operators, AND/OR logic, edge routing
- `loop-executor.test.ts` — test iteration, error strategies, max iterations
- `human-executor.test.ts` — test inbox task creation, suspend signal
- `graph-walker.test.ts` — test traversal, branching, failure paths, cancellation

### 12.2 Integration Tests

- Full workflow execution: Start → AI → Condition → API → End
- Human node: execute → suspend → inbox resolve → resume
- Loop with nested nodes
- API endpoint: deploy → execute via API key → poll status
- Cancellation mid-execution
- Timeout at workflow and node levels

### 12.3 Studio UI Tests

- Canvas: add node, connect nodes, delete node, configure node
- Deploy panel: deploy, generate API key, copy endpoint
- Inbox: view tasks, claim, approve/decline
- Run dialog: enter input, execute, view results
- Validation: verify warnings shown for invalid configurations

---

## 13. Migration / Cutover Plan

Since no production workflows exist:

1. Delete existing workflow collections (workflows, workflow_executions, workflow_versions)
2. Drop existing Mongoose model registrations
3. Create new collections with new schemas and indexes
4. Update seed scripts if any exist
5. No data migration needed

---

## 14. Open Questions

1. **LLM credential resolution for AI nodes**: Should AI nodes use the project-level model configuration, or should each node configure its own model/connection explicitly? (Current design: per-node config with project defaults as fallback.)

2. **Custom scripts for Function node**: Where are deployed custom scripts stored? Should we create a `workflow_scripts` collection, or reuse an existing script management system?

3. **Integration connections**: The Integration node references `connectionId`. Should this use the existing connector connection infrastructure from the `feat/integrations` branch?

4. **Agentic App node async handling**: Kore.ai notes the response "may take time." Should we set a hard timeout, or allow the node to wait indefinitely (with workflow-level timeout as the backstop)?

5. **Trigger system**: The current BullMQ-based trigger system is not covered in this spec. Should triggers be rebuilt as part of this work, or kept as-is and adapted to the new node types?
