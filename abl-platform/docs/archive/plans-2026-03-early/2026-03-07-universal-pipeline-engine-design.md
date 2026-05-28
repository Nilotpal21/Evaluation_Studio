# Universal Pipeline Engine — Design Document

## Date: 2026-03-07

## Status: Draft

---

## 1. Problem Statement

### 1.1 Current State

The platform has a working pipeline engine (`packages/pipeline-engine/`) built on Restate with 21 activity services, 11 built-in pipeline definitions, and support for sequential + parallel execution with conditional steps. However, it is **purpose-built for analytics/insights pipelines**. The execution model is a linear step array — steps execute top-to-bottom with parallel groups and condition skips.

Customers can configure **what** each step does (thresholds, prompts, models) but cannot change **how** the pipeline flows. There is no way to:

- Branch execution based on a node's output (if/else, switch/case)
- Connect a node to a non-adjacent node (skip ahead, jump)
- Revisit a previously executed node (retry loops, approval cycles)
- Pause execution and wait for an external event (human approval, webhook callback)
- Fan out to parallel paths where each path has its own continuation logic
- Compose pipelines from building blocks across domains (analytics, ingestion, agent runtime, integrations)

### 1.2 What This Design Solves

- **Universal pipeline engine**: A single engine that serves any domain — analytics, ingestion, agent runtime, custom workflows, ETL, automation
- **Customer-defined pipelines**: Customers compose pipelines from platform-provided building blocks (nodes) without deploying code
- **Graph-based execution**: Nodes with transitions replace the linear step array — enabling branching, loops, non-adjacent connections, and parallel groups
- **Pause & resume**: Nodes can suspend execution and wait for external signals (approvals, webhooks, timers)
- **Self-describing node catalog**: Every node type declares its configuration schema, enabling API-first pipeline building and future visual builders
- **Zero migration**: All existing pipeline definitions and activity services continue working unchanged

### 1.3 Design Principles

| Principle                        | Implication                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| **Evolve, don't replace**        | Extend the existing `packages/pipeline-engine/` — no new packages, no migration          |
| **Nodes are the universal unit** | Every building block — analytics, logic, integration — is a node with the same interface |
| **Self-documenting flows**       | Each node carries its own transitions — look at a node, see where it goes                |
| **Contained parallelism**        | Parallel execution only inside node groups — prevents branching explosion                |
| **Tenant-isolated**              | Every query includes `tenantId`, every execution respects quotas                         |
| **API-first, visual later**      | Pipeline CRUD and node catalog via REST API now, visual builder in Studio as follow-on   |

---

## 2. Design Decisions

| Decision               | Choice                                                    | Alternatives Considered                                       | Rationale                                                                                                       |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Architecture approach  | Evolve existing `pipeline-engine`                         | New generic engine layer; config-driven nodes                 | Builds on production-tested Restate infra. Zero migration. All 21 activity services become nodes instantly.     |
| Flow model             | Graph: nodes with embedded transitions                    | Separate nodes + edges arrays; linear step array with jumps   | Self-documenting — look at a node, see where it goes. No cross-referencing separate edge arrays.                |
| Parallel execution     | Node groups (special node type)                           | Fan-out from transitions; explicit fork/join gateways         | Contained parallelism — children can't have transitions, preventing branching explosion. Clean merge semantics. |
| Branching              | Conditional transitions on nodes                          | Separate if/else node types; condition expressions on edges   | Natural — a node produces output, its transitions decide where to go based on that output.                      |
| Loop support           | Back-edge transitions + maxVisits guard                   | Explicit loop node type; for-each iterator                    | Back-edges are just transitions pointing to earlier nodes. maxVisits prevents infinite loops. Simple, general.  |
| Pause & resume         | Restate durable promises via wait-for-event node          | Polling steps; event-driven callbacks; external state machine | Native Restate support. Workflow suspends with zero resource consumption. Resumes exactly where it paused.      |
| Node metadata          | NodeTypeDefinition with configSchema                      | Dynamic DB-stored definitions; code-only registration         | Static registry is simpler, type-safe, testable. configSchema enables API-driven pipeline building.             |
| Expression evaluator   | Safe subset (comparisons + logical ops + property access) | Full JavaScript eval; embedded scripting engine               | Security — no arbitrary code execution. Simple expressions cover all condition patterns.                        |
| Backward compatibility | Auto-convert steps[] to nodes+edges at runtime            | Require migration; dual execution paths                       | Zero disruption to existing pipelines. Engine detects format and handles both.                                  |

---

## 3. Architecture Overview

### 3.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Event Sources                                │
│                                                                      │
│  Kafka Topics              Programmatic (SDK)      Schedules         │
│  (session.ended,           (Restate client)        (cron via Restate │
│   message.user, ...)                                delayed calls)   │
└──────┬──────────────────────────┬────────────────────────┬──────────┘
       │                         │                        │
       ▼                         ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Restate Server                                  │
│                      (durable execution engine)                      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  PipelineTrigger (service)                                      │  │
│  │  • Receives Kafka events via Restate native subscription        │  │
│  │  • Looks up matching active pipeline definitions in MongoDB     │  │
│  │  • Checks tenant quotas (maxActiveRuns, maxRunsPerHour)         │  │
│  │  • Starts PipelineRun workflows for each match                  │  │
│  └──────────────────────────┬─────────────────────────────────────┘  │
│                              │ starts                                 │
│                              ▼                                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  PipelineRun (workflow) — Graph Walker                          │  │
│  │  • Reads pipeline definition (nodes + transitions)              │  │
│  │  • Starts at entryNodeId                                        │  │
│  │  • For each node:                                               │  │
│  │    ├── node-group → execute children in parallel                │  │
│  │    ├── wait-for-event → suspend on durable promise              │  │
│  │    ├── sub-pipeline → start nested PipelineRun                  │  │
│  │    └── otherwise → dispatch to NodeExecutor                     │  │
│  │  • Evaluates transitions in order, follows first match          │  │
│  │  • Guards: maxVisits (loop), maxExecutionTimeMs (timeout)       │  │
│  │  • Persists run result to MongoDB on completion                 │  │
│  └──────┬──────────┬──────────┬──────────┬──────────┬────────────┘  │
│         │          │          │          │          │                  │
│         ▼          ▼          ▼          ▼          ▼                  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  NodeExecutor (service) — formerly ActivityRouter               │  │
│  │  • Dispatches node execution by type via SERVICE_HANDLERS       │  │
│  │  • Merges config layers (pipeline > step overrides > trigger)   │  │
│  │  • Returns StepOutput to workflow                               │  │
│  │                                                                  │  │
│  │  Built-in Nodes:                                                │  │
│  │  ├── DATA:        db-query, http-fetch, read-conversation,      │  │
│  │  │                read-message-window, transform, filter        │  │
│  │  ├── COMPUTE:     compute-sentiment, compute-toxicity,          │  │
│  │  │                compute-quality, call-llm, ... (21 existing)  │  │
│  │  ├── LOGIC:       node-group, wait-for-event, delay,            │  │
│  │  │                sub-pipeline, switch                          │  │
│  │  ├── INTEGRATION: http-request, send-email, send-slack,         │  │
│  │  │                publish-kafka, webhook-callback               │  │
│  │  └── ACTION:      store-insight, store-results,                 │  │
│  │                   send-notification                             │  │
│  └──────┬──────────┬──────────┬──────────┬──────────┬────────────┘  │
│         │          │          │          │          │                  │
└─────────┼──────────┼──────────┼──────────┼──────────┼────────────────┘
          ▼          ▼          ▼          ▼          ▼
      ClickHouse  MongoDB   Kafka Topics  HTTP/Webhook  Email/Slack
      (analytics) (defs,    (events)      (external     (notifications)
                   runs)                   APIs)
```

### 3.2 Node Registry

```
┌──────────────────────────────────────────────────────────────────┐
│                        NodeRegistry                                │
│                        (singleton, populated at startup)            │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  registerAnalyticsNodes()                                     │  │
│  │  Auto-registers all 21 existing ACTIVITY_TYPES entries as     │  │
│  │  NodeTypeDefinitions with inferred categories                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  registerBuiltinNodes()                                       │  │
│  │  Registers logic, data, and integration node types            │  │
│  │  (node-group, wait-for-event, http-request, etc.)             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  API:                                                              │
│  ├── register(definition: NodeTypeDefinition)                     │
│  ├── get(type: string) → NodeTypeDefinition | undefined           │
│  ├── list(filters?) → NodeTypeDefinition[]                        │
│  └── validateConfig(type, config) → ValidationResult              │
│                                                                    │
│  Used by:                                                          │
│  ├── Pipeline CRUD API — validate node configs at save time       │
│  ├── Pipeline builder API — list available nodes + configSchemas  │
│  └── NodeExecutor — resolve handler for node type                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. Node Type System

### 4.1 NodeTypeDefinition — Platform Seed Catalog

Every building block the platform offers is described by a `NodeTypeDefinition`. This is the metadata that tells the pipeline builder what nodes exist, what each node needs, and what it produces. It is seed data shipped with the platform.

```typescript
/**
 * Metadata that describes a node type — registered once at startup,
 * queried by the pipeline builder API and validation layer.
 */
interface NodeTypeDefinition {
  // ── Identity ──
  type: string; // unique key: 'http-request', 'compute-sentiment', 'if-else'
  category: NodeCategory; // which drawer/group this belongs to

  // ── Display ──
  label: string; // human-readable: 'HTTP Request'
  description: string; // what this node does
  icon?: string; // icon key for visual builder: 'globe', 'git-branch', 'database'

  // ── Configuration Contract ──
  // Describes every config field the customer must/can fill in when
  // adding this node to a pipeline. The pipeline builder uses this
  // to render config forms. The engine validates against this at save time.
  configSchema: {
    fields: ConfigField[];
  };

  // ── Data Contract ──
  // Describes what data this node expects from previous nodes (input)
  // and what data it produces (output). Used for validation and
  // wiring hints in the visual builder.
  inputSchema?: PortSchema;
  outputSchema?: PortSchema;

  // ── Execution ──
  executionModel: 'sync' | 'async' | 'control-flow';
  defaultTimeout?: number; // ms, default per-node timeout
  defaultRetries?: number; // default retry count
  retryable?: boolean; // safe to retry on failure? (idempotent)

  // ── Access Control ──
  // Tenant must have these capabilities enabled to use this node.
  // Checked at pipeline save time and at execution time.
  requiredCapabilities?: string[]; // e.g., ['llm-credentials', 'external-http']
}

type NodeCategory = 'data' | 'logic' | 'integration' | 'compute' | 'action';

interface PortSchema {
  properties: Record<
    string,
    {
      type: string; // 'string', 'number', 'boolean', 'object', 'array'
      description?: string;
    }
  >;
}
```

### 4.2 ConfigField — Node Configuration Schema

The `ConfigField` type already exists in `packages/pipeline-engine/src/pipeline/types.ts`. It describes a single configuration field with type, validation, defaults, and whether it's required.

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
  values?: string[]; // for enum type — allowed values
  items?: // for array type — item schema
    | ConfigField
    | {
        type: string;
        properties: Record<string, ConfigField>;
      };
  reprocessOnChange?: boolean; // if true, changing this triggers reprocessing
}
```

### 4.3 Node Categories

| Category        | Purpose                         | Execution Model | Examples                                                                                                                                                                                                                  |
| --------------- | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **data**        | Read, write, and transform data | sync            | `db-query`, `http-fetch`, `read-conversation`, `read-message-window`, `transform`, `filter`, `aggregate`                                                                                                                  |
| **logic**       | Control pipeline flow           | control-flow    | `node-group`, `wait-for-event`, `delay`, `sub-pipeline`, `switch`                                                                                                                                                         |
| **integration** | Call external systems           | async           | `http-request`, `send-email`, `send-slack`, `publish-kafka`, `webhook-callback`                                                                                                                                           |
| **compute**     | Analyze and score data          | sync            | `compute-sentiment`, `compute-toxicity`, `compute-quality`, `call-llm`, `compute-intent`, `compute-statistical`, `compute-predictive-features`, `compute-mentions`, `conversation-analyzer`, `compute-tool-effectiveness` |
| **action**      | Persist results, notify         | sync            | `store-insight`, `store-results`, `send-notification`                                                                                                                                                                     |

### 4.4 Built-in Node Type Definitions

#### 4.4.1 Existing Analytics Nodes (Auto-Registered from ACTIVITY_TYPES)

All 21 existing activity services are auto-registered as node types. Their `ACTIVITY_TYPES` metadata entries are wrapped in `NodeTypeDefinition` with inferred categories:

| Node Type                     | Category | Existing Service                   |
| ----------------------------- | -------- | ---------------------------------- |
| `compute-sentiment`           | compute  | `computeSentimentService`          |
| `compute-toxicity`            | compute  | `computeToxicityService`           |
| `compute-quality`             | compute  | `computeQualityService`            |
| `compute-intent`              | compute  | `computeIntentService`             |
| `compute-tool-effectiveness`  | compute  | `computeToolEffectivenessService`  |
| `conversation-analyzer`       | compute  | `conversationAnalyzerService`      |
| `compute-statistical`         | compute  | `computeStatisticalService`        |
| `compute-predictive-features` | compute  | `computePredictiveFeaturesService` |
| `compute-mentions`            | compute  | `computeMentionsService`           |
| `call-llm`                    | compute  | `callLLMService`                   |
| `read-conversation`           | data     | `readConversationService`          |
| `read-message-window`         | data     | `readMessageWindowService`         |
| `transform`                   | data     | `transformService`                 |
| `evaluate-metrics`            | compute  | `evaluateMetricsService`           |
| `evaluate-policy`             | compute  | `evaluatePolicyService`            |
| `store-results`               | action   | `storeResultsService`              |
| `store-insight`               | action   | `storeInsightService`              |
| `send-notification`           | action   | `sendNotificationService`          |
| `run-legacy-workflow`         | action   | `runLegacyWorkflowService`         |
| `simulate-persona`            | compute  | `simulatePersonaService`           |
| `execute-agent-turn`          | compute  | `executeAgentTurnService`          |
| `run-eval-conversation`       | compute  | `runEvalConversationService`       |
| `judge-conversation`          | compute  | `judgeConversationService`         |
| `aggregate-eval-run`          | compute  | `aggregateEvalRunService`          |

#### 4.4.2 New Logic Nodes

**node-group** — Execute child nodes in parallel

```typescript
{
  type: 'node-group',
  category: 'logic',
  label: 'Parallel Group',
  description: 'Execute multiple nodes in parallel. All children must complete before transitions are evaluated.',
  configSchema: { fields: [] },  // no config needed — children are defined in the node itself
  executionModel: 'control-flow',
}
```

**wait-for-event** — Pause and wait for external signal

```typescript
{
  type: 'wait-for-event',
  category: 'logic',
  label: 'Wait for Event',
  description: 'Pause pipeline execution until an external signal is received (approval, webhook, callback).',
  configSchema: {
    fields: [
      { name: 'eventName', type: 'string', required: true,
        description: 'Name of the event to wait for. Used as the durable promise key. Must be unique within the pipeline.' },
      { name: 'timeoutMs', type: 'number', required: false,
        default: 86400000,
        validation: { min: 1000, max: 604800000 },
        description: 'Maximum time to wait in milliseconds. Default: 24 hours. Max: 7 days.' },
      { name: 'timeoutAction', type: 'enum', required: false,
        values: ['fail', 'skip', 'default-value'], default: 'fail',
        description: 'What to do when the timeout expires. fail: mark node as failed. skip: mark as skipped. default-value: use defaultValue as output.' },
      { name: 'defaultValue', type: 'object', required: false,
        description: 'Output to use when timeoutAction is default-value. Ignored for other timeout actions.' },
    ]
  },
  executionModel: 'control-flow',
}
```

**delay** — Wait a fixed duration

```typescript
{
  type: 'delay',
  category: 'logic',
  label: 'Delay',
  description: 'Wait for a specified duration before continuing. Uses Restate durable sleep — survives crashes.',
  configSchema: {
    fields: [
      { name: 'durationMs', type: 'number', required: true,
        validation: { min: 1000, max: 86400000 },
        description: 'Duration to wait in milliseconds. Max: 24 hours.' },
    ]
  },
  executionModel: 'control-flow',
}
```

**sub-pipeline** — Call another pipeline as a node

```typescript
{
  type: 'sub-pipeline',
  category: 'logic',
  label: 'Sub-Pipeline',
  description: 'Execute another pipeline as a node. The sub-pipeline runs to completion and its output becomes this node output.',
  configSchema: {
    fields: [
      { name: 'pipelineId', type: 'string', required: true,
        description: 'ID of the pipeline to execute. Must belong to the same tenant.' },
      { name: 'inputMapping', type: 'object', required: false,
        description: 'Map current context fields to the sub-pipeline input. If omitted, passes the full pipeline input.' },
    ]
  },
  executionModel: 'control-flow',
  requiredCapabilities: [],
}
```

**switch** — Multi-way branching (syntactic sugar)

```typescript
{
  type: 'switch',
  category: 'logic',
  label: 'Switch',
  description: 'Route execution to different targets based on a value. Syntactic sugar over multiple conditional transitions.',
  configSchema: {
    fields: [
      { name: 'expression', type: 'string', required: true,
        description: 'Expression to evaluate. Example: "context.intent" or "output.category"' },
      { name: 'cases', type: 'array', required: true,
        items: {
          type: 'object',
          properties: {
            value: { name: 'value', type: 'string', required: true, description: 'Value to match against' },
            target: { name: 'target', type: 'string', required: true, description: 'Target node ID' },
          }
        },
        description: 'List of value → target mappings' },
      { name: 'default', type: 'string', required: true,
        description: 'Default target node ID when no case matches' },
    ]
  },
  executionModel: 'control-flow',
}
```

#### 4.4.3 New Data Nodes

**db-query** — Query a database

```typescript
{
  type: 'db-query',
  category: 'data',
  label: 'Database Query',
  description: 'Execute a query against ClickHouse or MongoDB. Results become the node output.',
  configSchema: {
    fields: [
      { name: 'database', type: 'enum', required: true,
        values: ['clickhouse', 'mongodb'],
        description: 'Which database to query' },
      { name: 'query', type: 'string', required: true,
        description: 'Query string. ClickHouse: SQL. MongoDB: JSON filter. Supports {{variable}} substitution from pipeline context.' },
      { name: 'collection', type: 'string', required: false,
        description: 'MongoDB collection name. Required when database is mongodb.' },
      { name: 'limit', type: 'number', required: false,
        default: 1000, validation: { min: 1, max: 10000 },
        description: 'Maximum rows/documents to return' },
    ]
  },
  executionModel: 'sync',
  requiredCapabilities: ['database-access'],
}
```

**filter** — Filter data from previous nodes

```typescript
{
  type: 'filter',
  category: 'data',
  label: 'Filter',
  description: 'Filter an array from a previous node output using an expression.',
  configSchema: {
    fields: [
      { name: 'source', type: 'string', required: true,
        description: 'Path to the array to filter. Example: "nodeOutputs.read.data.messages"' },
      { name: 'expression', type: 'string', required: true,
        description: 'Filter expression evaluated per item. Example: "item.role == \'user\'"' },
    ]
  },
  executionModel: 'sync',
}
```

**aggregate** — Aggregate data from previous nodes

```typescript
{
  type: 'aggregate',
  category: 'data',
  label: 'Aggregate',
  description: 'Aggregate values from previous node outputs. Supports count, sum, avg, min, max, collect.',
  configSchema: {
    fields: [
      { name: 'source', type: 'string', required: true,
        description: 'Path to the array to aggregate' },
      { name: 'operations', type: 'array', required: true,
        items: {
          type: 'object',
          properties: {
            field: { name: 'field', type: 'string', required: true, description: 'Field to aggregate' },
            op: { name: 'op', type: 'enum', required: true, values: ['count', 'sum', 'avg', 'min', 'max', 'collect'], description: 'Aggregation operation' },
            as: { name: 'as', type: 'string', required: true, description: 'Output field name' },
          }
        },
        description: 'List of aggregation operations' },
    ]
  },
  executionModel: 'sync',
}
```

#### 4.4.4 New Integration Nodes

**http-request** — Make an HTTP request to an external API

```typescript
{
  type: 'http-request',
  category: 'integration',
  label: 'HTTP Request',
  description: 'Make an HTTP request to an external API. Supports template substitution in URL, headers, and body.',
  configSchema: {
    fields: [
      { name: 'url', type: 'string', required: true,
        description: 'URL to call. Supports {{variable}} substitution from pipeline context.' },
      { name: 'method', type: 'enum', required: true,
        values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET',
        description: 'HTTP method' },
      { name: 'headers', type: 'object', required: false,
        description: 'Request headers as key-value pairs. Supports {{variable}} substitution.' },
      { name: 'body', type: 'string', required: false,
        description: 'Request body template. Supports {{variable}} substitution.' },
      { name: 'timeoutMs', type: 'number', required: false,
        default: 30000, validation: { min: 1000, max: 120000 },
        description: 'Request timeout in milliseconds' },
      { name: 'retryOnStatus', type: 'array', required: false,
        items: { type: 'number', description: 'HTTP status code' },
        default: [429, 502, 503, 504],
        description: 'HTTP status codes that trigger a retry' },
    ]
  },
  executionModel: 'async',
  retryable: true,
  defaultTimeout: 30000,
  defaultRetries: 3,
  requiredCapabilities: ['external-http'],
}
```

**send-email** — Send an email

```typescript
{
  type: 'send-email',
  category: 'integration',
  label: 'Send Email',
  description: 'Send an email via the platform email service.',
  configSchema: {
    fields: [
      { name: 'to', type: 'string', required: true,
        description: 'Recipient email address. Supports {{variable}} substitution.' },
      { name: 'subject', type: 'string', required: true,
        description: 'Email subject. Supports {{variable}} substitution.' },
      { name: 'body', type: 'string', required: true,
        description: 'Email body (HTML supported). Supports {{variable}} substitution.' },
      { name: 'cc', type: 'string', required: false,
        description: 'CC recipient(s), comma-separated.' },
    ]
  },
  executionModel: 'async',
  retryable: true,
  defaultRetries: 2,
  requiredCapabilities: ['email-send'],
}
```

**send-slack** — Send a Slack message

```typescript
{
  type: 'send-slack',
  category: 'integration',
  label: 'Send Slack Message',
  description: 'Send a message to a Slack channel or user via webhook or Slack API.',
  configSchema: {
    fields: [
      { name: 'channel', type: 'string', required: true,
        description: 'Slack channel name or ID' },
      { name: 'message', type: 'string', required: true,
        description: 'Message text. Supports {{variable}} substitution and Slack markdown.' },
      { name: 'webhookUrl', type: 'string', required: false,
        description: 'Slack webhook URL. If omitted, uses the tenant Slack integration.' },
    ]
  },
  executionModel: 'async',
  retryable: true,
  defaultRetries: 2,
  requiredCapabilities: ['slack-integration'],
}
```

**publish-kafka** — Publish an event to a Kafka topic

```typescript
{
  type: 'publish-kafka',
  category: 'integration',
  label: 'Publish to Kafka',
  description: 'Publish an event to a Kafka topic.',
  configSchema: {
    fields: [
      { name: 'topic', type: 'string', required: true,
        description: 'Kafka topic to publish to' },
      { name: 'key', type: 'string', required: false,
        description: 'Message key. Supports {{variable}} substitution.' },
      { name: 'payload', type: 'object', required: true,
        description: 'Message payload. Can reference pipeline context via {{variable}}.' },
    ]
  },
  executionModel: 'async',
  retryable: true,
  defaultRetries: 3,
}
```

---

## 5. Pipeline Definition Model

### 5.1 PipelineNode — Instance in a Customer's Pipeline

A `PipelineNode` is a concrete instance of a `NodeTypeDefinition` placed in a customer's pipeline. It carries the filled-in config and its outgoing transitions.

```typescript
/**
 * A node in the pipeline graph.
 * Each node has a type (from NodeTypeDefinition registry),
 * filled-in config, and transitions defining where to go next.
 */
interface PipelineNode {
  // ── Identity ──
  id: string; // unique within pipeline: 'check-toxicity', 'send-alert'
  type: string; // from NodeTypeDefinition registry: 'compute-toxicity'
  label?: string; // display name: 'Check Toxicity Score'

  // ── Configuration ──
  // Filled-in config per NodeTypeDefinition.configSchema.
  // Validated against the schema at pipeline save time.
  config: Record<string, any>;

  // ── Transitions ──
  // Where to go after this node completes.
  // Evaluated in order (by `order` field). First matching condition wins.
  // A transition with no condition is the default/else path.
  // Empty array = terminal node (pipeline path ends here).
  transitions: NodeTransition[];

  // ── Node Group Children ──
  // Only for nodes with type: 'node-group'.
  // Children execute in parallel within the group.
  // Children CANNOT have transitions — only the group has transitions.
  children?: GroupChildNode[];

  // ── Execution Overrides ──
  timeout?: number; // ms. Overrides NodeTypeDefinition.defaultTimeout
  retries?: number; // Overrides NodeTypeDefinition.defaultRetries
  onFailure?: 'stop' | 'skip' | 'continue';
  // stop: halt pipeline, mark remaining nodes skipped
  // skip: mark this node skipped, continue to next via transitions
  // continue: keep fail status, proceed via transitions

  // ── Loop Protection ──
  maxVisits?: number; // how many times this node can be visited. default: 1
  // set > 1 to allow back-edge loops (retry, approval cycles)
  // platform enforces hard cap per tenant quota

  // ── Visual Builder Metadata ──
  // Ignored by the execution engine. Used by future visual builder.
  position?: { x: number; y: number };
}
```

### 5.2 NodeTransition — Outgoing Connection

```typescript
/**
 * A transition from one node to another.
 * Embedded in the source node's `transitions` array.
 */
interface NodeTransition {
  // ── Target ──
  target: string; // target node ID within the same pipeline

  // ── Condition ──
  // Expression evaluated against the source node's output and pipeline context.
  // If omitted, this is the default/fallback transition (always matches).
  //
  // Available variables in expressions:
  //   output.*         — the source node's output data
  //   context.*        — pipeline-wide execution context (all previous node outputs)
  //   input.*          — original pipeline trigger input (tenantId, sessionId, etc.)
  //
  // Operators: ==, !=, >, <, >=, <=, &&, ||, !
  // Literals: strings ('value'), numbers (42, 0.7), booleans (true, false), null
  //
  // Examples:
  //   "output.score > 0.7"
  //   "output.status == 'FAIL'"
  //   "output.category == 'billing' && input.priority == 'high'"
  //   "context.nodeOutputs.check.data.approved == true"
  condition?: string;

  // ── Evaluation Order ──
  // Lower number = evaluated first. When multiple transitions match,
  // the one with the lowest order wins.
  // Default transitions (no condition) should have the highest order.
  order?: number;

  // ── Display ──
  label?: string; // edge label for visual builder: 'toxic', 'clean', 'approved'
}
```

### 5.3 GroupChildNode — Parallel Execution Unit

```typescript
/**
 * A child node inside a node-group.
 * Executes in parallel with other children.
 * Cannot have transitions — only the parent group has transitions.
 */
interface GroupChildNode {
  id: string; // unique within pipeline: 'toxicity-check'
  type: string; // from NodeTypeDefinition registry
  label?: string; // display name
  config: Record<string, any>; // filled-in config

  // Execution overrides
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
  // stop: fail the entire group
  // skip: mark this child as skipped, other children continue
  // continue: keep fail status, other children continue
}
```

### 5.4 PipelineDefinition — Complete Pipeline

```typescript
/**
 * Full pipeline definition as stored in MongoDB.
 */
interface PipelineDefinition {
  _id: string;
  tenantId: string; // tenant isolation — all queries include this
  projectId?: string; // if set, scoped to project; if null, account-level

  // ── Metadata ──
  name: string; // 'Post-Session Safety Evaluation'
  description?: string;
  version: number; // auto-incremented on every update
  status: 'draft' | 'active' | 'archived';
  tags?: string[]; // categorization tags for filtering

  // ── Graph-Based Flow (new) ──
  nodes: PipelineNode[]; // all nodes in the pipeline
  entryNodeId: string; // which node starts execution

  // ── Triggers ──
  supportedTriggers?: TriggerEntry[];
  defaultTriggerIds?: string[];
  strategies?: Record<string, ExecutionStrategy>;

  // ── Configuration ──
  pipelineType?: string; // links to PipelineConfig for config resolution
  configSchema?: {
    // self-describing config schema
    fields: ConfigField[];
  };

  // ── Execution ──
  maxConcurrency?: number; // max concurrent runs for this pipeline
  onNodeFailure?: 'stop' | 'skip' | 'continue'; // default failure strategy for all nodes

  // ── Backward Compat (legacy step array format) ──
  steps?: PipelineStep[]; // old format — engine auto-converts to nodes+edges

  // ── Audit ──
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### 5.5 MongoDB Indexes

```
{ tenantId: 1, status: 1 }                              — list active pipelines
{ tenantId: 1, projectId: 1, status: 1 }                — project-scoped queries
{ tenantId: 1, 'supportedTriggers.kafkaTopic': 1, status: 1 } — Kafka event matching
{ tenantId: 1, tags: 1 }                                — filter by tags
```

---

## 6. Execution Engine

### 6.1 Graph Walker — PipelineRun Workflow

The `PipelineRun` Restate workflow evolves from a `while(i < steps.length)` loop to a graph walker. It traverses nodes following transitions, handling node groups, pause/resume, sub-pipelines, and loop guards.

```typescript
// Pseudocode — PipelineRun graph walker
async function run(ctx: WorkflowContext, input: PipelineRunInput) {
  const { pipelineDefinition, pipelineInput } = input;

  // Auto-convert legacy step arrays to graph format
  const { nodes, entryNodeId } = pipelineDefinition.nodes
    ? { nodes: pipelineDefinition.nodes, entryNodeId: pipelineDefinition.entryNodeId }
    : stepsToGraph(pipelineDefinition.steps);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const context = {
    input: pipelineInput,
    nodeOutputs: {},           // accumulated outputs from all visited nodes
  };
  const visitCounts = {};      // track visits per node (loop protection)
  const tenantQuota = await loadTenantQuota(pipelineInput.tenantId);

  // Initialize durable state
  ctx.set('status', 'running');
  ctx.set('startedAt', await ctx.run('ts-start', () => Date.now()));

  let currentNodeId = entryNodeId;

  while (currentNodeId) {
    const node = nodeMap.get(currentNodeId);
    if (!node) {
      // Dangling reference — should have been caught at save time
      break;
    }

    // ── Loop guard ──
    visitCounts[node.id] = (visitCounts[node.id] || 0) + 1;
    const maxVisits = Math.min(
      node.maxVisits ?? 1,
      tenantQuota.maxNodeVisits  // hard cap from tenant quota
    );
    if (visitCounts[node.id] > maxVisits) {
      // Max visits exceeded — terminate this path
      context.nodeOutputs[node.id] = {
        status: 'fail',
        data: { error: `Max visits (${maxVisits}) exceeded for node '${node.id}'` }
      };
      break;
    }

    // ── Execute the node ──
    await updateNodeState(ctx, node.id, 'running');

    let output: StepOutput;

    switch (node.type) {
      case 'node-group':
        output = await executeNodeGroup(ctx, node, context);
        break;

      case 'wait-for-event':
        output = await executeWaitForEvent(ctx, node, context);
        break;

      case 'delay':
        output = await executeDelay(ctx, node);
        break;

      case 'sub-pipeline':
        output = await executeSubPipeline(ctx, node, context, tenantQuota);
        break;

      case 'switch':
        output = await executeSwitch(node, context);
        // Switch node handles its own transition resolution — sets currentNodeId directly
        currentNodeId = output.data._nextNodeId;
        context.nodeOutputs[node.id] = output;
        await updateNodeState(ctx, node.id, output.status, output.durationMs);
        continue;  // skip normal transition resolution

      default:
        // Regular node — dispatch to NodeExecutor
        output = await ctx.serviceClient(nodeExecutor).execute({
          step: node,  // NodeExecutor accepts PipelineNode (superset of PipelineStep)
          previousSteps: context.nodeOutputs,
          pipelineInput,
          resolvedConfig,
          executionMode,
          triggerId,
        });
        break;
    }

    context.nodeOutputs[node.id] = output;
    await updateNodeState(ctx, node.id, output.status, output.durationMs);

    // ── Handle failure ──
    if (output.status === 'fail') {
      const failureStrategy = node.onFailure ?? pipelineDefinition.onNodeFailure ?? 'stop';
      if (failureStrategy === 'stop') {
        break;  // terminate pipeline
      }
      // 'skip' or 'continue' — proceed to transitions
    }

    // ── Resolve next node via transitions ──
    currentNodeId = resolveTransition(node.transitions, output, context);
    // returns null if no transitions match → path terminates
  }

  // ── Finalize ──
  const overallStatus = determineOverallStatus(context.nodeOutputs);
  ctx.set('status', overallStatus);
  await persistRunToMongo(ctx.key, { ... });

  return { status: overallStatus, nodeOutputs: context.nodeOutputs };
}
```

### 6.2 Transition Resolution

```typescript
/**
 * Evaluate a node's transitions in order and return the target node ID.
 * Returns null if no transition matches (terminal node).
 */
function resolveTransition(
  transitions: NodeTransition[],
  output: StepOutput,
  context: ExecutionContext,
): string | null {
  if (!transitions || transitions.length === 0) {
    return null; // terminal node
  }

  // Sort by order (lower first), then by position in array
  const sorted = [...transitions].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));

  for (const transition of sorted) {
    if (!transition.condition) {
      // Default/fallback transition — always matches
      return transition.target;
    }

    // Evaluate condition expression
    const result = evaluateExpression(transition.condition, {
      output: output.data,
      context: context.nodeOutputs,
      input: context.input,
    });

    if (result) {
      return transition.target;
    }
  }

  return null; // no transition matched, no default — terminal
}
```

### 6.3 Node Group Execution

```typescript
/**
 * Execute a node-group: run all children in parallel, collect outputs.
 * Group output = { [childId]: childOutput }
 */
async function executeNodeGroup(
  ctx: WorkflowContext,
  node: PipelineNode,
  context: ExecutionContext,
): Promise<StepOutput> {
  const children = node.children ?? [];
  if (children.length === 0) {
    return { status: 'success', data: {} };
  }

  const startTime = Date.now();

  // Fan-out: execute all children in parallel via Restate durable RPC
  const results = await CombineablePromise.all(
    children.map((child) =>
      ctx.serviceClient(nodeExecutor).execute({
        step: child,
        previousSteps: context.nodeOutputs,
        pipelineInput: context.input,
      }),
    ),
  );

  // Fan-in: collect outputs keyed by child ID
  const groupOutput: Record<string, any> = {};
  let hasFailure = false;

  for (let i = 0; i < children.length; i++) {
    const childId = children[i].id;
    groupOutput[childId] = results[i].data;
    context.nodeOutputs[childId] = results[i]; // also available in global context

    if (results[i].status === 'fail') {
      const failStrategy = children[i].onFailure ?? 'stop';
      if (failStrategy === 'stop') {
        hasFailure = true;
      }
    }
  }

  return {
    status: hasFailure ? 'fail' : 'success',
    data: groupOutput,
    durationMs: Date.now() - startTime,
  };
}
```

### 6.4 Wait-For-Event Execution (Pause & Resume)

```typescript
/**
 * Pause execution and wait for an external signal via Restate durable promise.
 * The workflow suspends with zero resource consumption until the promise is resolved.
 */
async function executeWaitForEvent(
  ctx: WorkflowContext,
  node: PipelineNode,
  context: ExecutionContext,
): Promise<StepOutput> {
  const { eventName, timeoutMs, timeoutAction, defaultValue } = node.config;
  const startTime = Date.now();

  const promise = ctx.promise<Record<string, any>>(eventName);

  try {
    // Race between the durable promise and a timeout
    const eventData = await withTimeout(promise.get(), timeoutMs ?? 86400000);

    return {
      status: 'success',
      data: eventData,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    // Timeout expired
    switch (timeoutAction ?? 'fail') {
      case 'skip':
        return { status: 'skipped', data: {}, durationMs: Date.now() - startTime };
      case 'default-value':
        return {
          status: 'success',
          data: defaultValue ?? {},
          durationMs: Date.now() - startTime,
        };
      case 'fail':
      default:
        return {
          status: 'fail',
          data: { error: `Wait for event '${eventName}' timed out after ${timeoutMs}ms` },
          durationMs: Date.now() - startTime,
        };
    }
  }
}

// External resume — called by the API endpoint:
// POST /api/projects/:projectId/pipeline-runs/:runId/events/:eventName
//
// Under the hood:
//   const client = restate.connect(RESTATE_URL);
//   await client.workflow(PipelineRun).resolve(runId, eventName, eventPayload);
```

### 6.5 Sub-Pipeline Execution

```typescript
/**
 * Execute another pipeline as a node.
 * Starts a nested PipelineRun workflow and waits for its result.
 */
async function executeSubPipeline(
  ctx: WorkflowContext,
  node: PipelineNode,
  context: ExecutionContext,
  tenantQuota: TenantPipelineQuota,
): Promise<StepOutput> {
  const { pipelineId, inputMapping } = node.config;
  const startTime = Date.now();

  // Depth guard — prevent infinite nesting
  const currentDepth = context.input._subPipelineDepth ?? 0;
  if (currentDepth >= tenantQuota.maxSubPipelineDepth) {
    return {
      status: 'fail',
      data: { error: `Max sub-pipeline depth (${tenantQuota.maxSubPipelineDepth}) exceeded` },
      durationMs: Date.now() - startTime,
    };
  }

  // Load sub-pipeline definition
  const subPipeline = await ctx.run('load-sub-pipeline', async () => {
    return PipelineDefinitionModel.findOne({
      _id: pipelineId,
      tenantId: context.input.tenantId,
      status: 'active',
    }).lean();
  });

  if (!subPipeline) {
    return {
      status: 'fail',
      data: { error: `Sub-pipeline '${pipelineId}' not found or not active` },
      durationMs: Date.now() - startTime,
    };
  }

  // Map input
  const subInput = inputMapping
    ? applyMapping(inputMapping, context)
    : { ...context.input, _subPipelineDepth: currentDepth + 1 };

  // Start nested PipelineRun workflow
  const subRunId = `${ctx.key}-sub-${node.id}`;
  const result = await ctx.serviceClient(pipelineRun).run({
    pipelineDefinition: subPipeline,
    pipelineInput: subInput,
  });

  return {
    status: result.status === 'completed' ? 'success' : 'fail',
    data: result.nodeOutputs ?? result.stepOutputs ?? {},
    durationMs: Date.now() - startTime,
  };
}
```

### 6.6 Backward Compatibility — Steps to Graph Conversion

```typescript
/**
 * Auto-convert legacy steps[] format to nodes + edges graph format.
 * Existing pipeline definitions continue working without modification.
 */
function stepsToGraph(steps: PipelineStep[]): {
  nodes: PipelineNode[];
  entryNodeId: string;
} {
  if (!steps || steps.length === 0) {
    return { nodes: [], entryNodeId: '' };
  }

  const nodes: PipelineNode[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];

    // Check for parallel group
    if (step.parallel) {
      const groupTag = step.parallel;
      const children: GroupChildNode[] = [];

      while (i < steps.length && steps[i].parallel === groupTag) {
        children.push({
          id: steps[i].id,
          type: steps[i].activity ?? steps[i].type ?? 'unknown',
          label: steps[i].name,
          config: steps[i].config ?? {},
          timeout: steps[i].timeout,
          retries: steps[i].retries,
          onFailure: steps[i].onFailure,
        });
        i++;
      }

      const groupId = `group-${groupTag}`;
      nodes.push({
        id: groupId,
        type: 'node-group',
        label: `Parallel: ${groupTag}`,
        config: {},
        children,
        transitions: [], // filled below
      });
    } else {
      // Sequential step
      nodes.push({
        id: step.id,
        type: step.activity ?? step.type ?? 'unknown',
        label: step.name,
        config: step.config ?? {},
        transitions: [], // filled below
        timeout: step.timeout,
        retries: step.retries,
        onFailure: step.onFailure,
        maxVisits: 1,
      });

      // Handle condition
      if (step.condition) {
        const condExpr =
          typeof step.condition === 'string' ? step.condition : step.condition.expression;
        // Condition is applied as a conditional transition from the PREVIOUS node
        // In the legacy model, conditions skip the step. In graph model,
        // we add the condition as a transition check on the current node.
        // For simplicity, we keep the node and add a self-skip mechanism.
      }

      i++;
    }
  }

  // Wire transitions: each node points to the next
  for (let j = 0; j < nodes.length - 1; j++) {
    nodes[j].transitions = [{ target: nodes[j + 1].id }];
  }

  return { nodes, entryNodeId: nodes[0].id };
}
```

---

## 7. Node Registry

### 7.1 Registry Implementation

```typescript
/**
 * Singleton registry of all available node types.
 * Populated at server startup, queried by API and validation.
 */
class NodeRegistry {
  private static instance: NodeRegistry;
  private nodes: Map<string, NodeTypeDefinition> = new Map();

  static getInstance(): NodeRegistry {
    if (!NodeRegistry.instance) {
      NodeRegistry.instance = new NodeRegistry();
    }
    return NodeRegistry.instance;
  }

  /**
   * Register a node type. Called at startup by domain registration functions.
   * Validates the definition before accepting it.
   */
  register(definition: NodeTypeDefinition): void {
    if (this.nodes.has(definition.type)) {
      throw new Error(`Node type '${definition.type}' is already registered`);
    }
    validateNodeTypeDefinition(definition);
    this.nodes.set(definition.type, definition);
  }

  /**
   * Get a single node type definition.
   * Used by the engine for handler dispatch and config validation.
   */
  get(type: string): NodeTypeDefinition | undefined {
    return this.nodes.get(type);
  }

  /**
   * List all available node types, optionally filtered.
   * Used by the pipeline builder API.
   */
  list(filters?: { category?: NodeCategory; capabilities?: string[] }): NodeTypeDefinition[] {
    let results = [...this.nodes.values()];

    if (filters?.category) {
      results = results.filter((n) => n.category === filters.category);
    }

    if (filters?.capabilities) {
      // Only return nodes whose required capabilities are satisfied
      results = results.filter((n) => {
        if (!n.requiredCapabilities || n.requiredCapabilities.length === 0) return true;
        return n.requiredCapabilities.every((cap) => filters.capabilities!.includes(cap));
      });
    }

    return results;
  }

  /**
   * Validate a node's config against its type's configSchema.
   * Called at pipeline save time.
   */
  validateConfig(type: string, config: Record<string, any>): ValidationResult {
    const definition = this.nodes.get(type);
    if (!definition) {
      return { valid: false, errors: [`Unknown node type: '${type}'`] };
    }
    return validateAgainstSchema(config, definition.configSchema);
  }

  /**
   * Check if a node type exists in the registry.
   */
  has(type: string): boolean {
    return this.nodes.has(type);
  }
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}
```

### 7.2 Registration at Server Startup

```typescript
// pipeline-engine/src/registry/index.ts

import { NodeRegistry } from './node-registry.js';
import { registerAnalyticsNodes } from './register-analytics-nodes.js';
import { registerBuiltinNodes } from './register-builtin-nodes.js';

/**
 * Initialize the node registry with all available node types.
 * Called once at pipeline-engine server startup.
 */
export function initializeNodeRegistry(): NodeRegistry {
  const registry = NodeRegistry.getInstance();

  // 1. Auto-register all existing activity types (21 analytics nodes)
  registerAnalyticsNodes(registry);

  // 2. Register built-in logic, data, and integration nodes
  registerBuiltinNodes(registry);

  return registry;
}

// register-analytics-nodes.ts
export function registerAnalyticsNodes(registry: NodeRegistry): void {
  for (const [type, metadata] of Object.entries(ACTIVITY_TYPES)) {
    registry.register({
      type,
      category: inferCategory(type),
      label: metadata.label,
      description: metadata.description,
      configSchema: metadata.configSchema ?? { fields: [] },
      executionModel: 'sync',
      defaultTimeout: metadata.defaultTimeout,
      defaultRetries: metadata.defaultRetries,
      retryable: true,
    });
  }
}

/**
 * Infer category from activity type name.
 * compute-* → compute, store-* → action, read-* → data, etc.
 */
function inferCategory(type: string): NodeCategory {
  if (type.startsWith('compute-') || type.startsWith('evaluate-') || type.startsWith('call-'))
    return 'compute';
  if (type.startsWith('store-') || type.startsWith('send-')) return 'action';
  if (type.startsWith('read-') || type === 'transform') return 'data';
  if (type.startsWith('run-')) return 'action';
  // Eval pipeline services
  if (
    [
      'simulate-persona',
      'execute-agent-turn',
      'run-eval-conversation',
      'judge-conversation',
      'aggregate-eval-run',
    ].includes(type)
  )
    return 'compute';
  return 'compute'; // safe default
}

// register-builtin-nodes.ts
export function registerBuiltinNodes(registry: NodeRegistry): void {
  // Logic nodes
  registry.register(nodeGroupDefinition);
  registry.register(waitForEventDefinition);
  registry.register(delayDefinition);
  registry.register(subPipelineDefinition);
  registry.register(switchDefinition);

  // Data nodes
  registry.register(dbQueryDefinition);
  registry.register(filterDefinition);
  registry.register(aggregateDefinition);

  // Integration nodes
  registry.register(httpRequestDefinition);
  registry.register(sendEmailDefinition);
  registry.register(sendSlackDefinition);
  registry.register(publishKafkaDefinition);
}
```

---

## 8. Pipeline Validation

### 8.1 Validation at Save Time

When a customer creates or updates a pipeline, the engine validates the entire definition before persisting. This prevents invalid pipelines from being saved or activated.

```typescript
/**
 * Validate a pipeline definition.
 * Called at POST/PUT /pipelines and POST /pipelines/:id/activate.
 */
function validatePipeline(
  definition: PipelineDefinition,
  registry: NodeRegistry,
  tenantQuota: TenantPipelineQuota,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set(definition.nodes.map((n) => n.id));

  // 1. Entry node exists
  if (!nodeIds.has(definition.entryNodeId)) {
    errors.push(`Entry node '${definition.entryNodeId}' not found in nodes`);
  }

  // 2. Node count within quota
  if (definition.nodes.length > tenantQuota.maxNodesPerPipeline) {
    errors.push(
      `Pipeline has ${definition.nodes.length} nodes, max allowed: ${tenantQuota.maxNodesPerPipeline}`,
    );
  }

  // 3. Validate each node
  for (const node of definition.nodes) {
    // 3a. Node type exists in registry
    if (!registry.has(node.type)) {
      errors.push(`Node '${node.id}': unknown type '${node.type}'`);
      continue;
    }

    // 3b. Node config valid against configSchema
    const configResult = registry.validateConfig(node.type, node.config);
    if (!configResult.valid) {
      errors.push(...configResult.errors.map((e) => `Node '${node.id}': ${e}`));
    }

    // 3c. All transition targets exist
    for (const transition of node.transitions) {
      if (!nodeIds.has(transition.target)) {
        errors.push(`Node '${node.id}': transition target '${transition.target}' not found`);
      }
    }

    // 3d. Node-group children validation
    if (node.type === 'node-group' && node.children) {
      for (const child of node.children) {
        if (!registry.has(child.type)) {
          errors.push(`Node '${node.id}', child '${child.id}': unknown type '${child.type}'`);
        } else {
          const childConfigResult = registry.validateConfig(child.type, child.config);
          if (!childConfigResult.valid) {
            errors.push(
              ...childConfigResult.errors.map(
                (e) => `Node '${node.id}', child '${child.id}': ${e}`,
              ),
            );
          }
        }
      }
    }

    // 3e. maxVisits within tenant hard cap
    if (node.maxVisits && node.maxVisits > tenantQuota.maxNodeVisits) {
      errors.push(
        `Node '${node.id}': maxVisits (${node.maxVisits}) exceeds tenant limit (${tenantQuota.maxNodeVisits})`,
      );
    }
  }

  // 4. Orphan detection — nodes unreachable from entryNodeId
  const reachable = findReachableNodes(definition.nodes, definition.entryNodeId);
  for (const node of definition.nodes) {
    if (!reachable.has(node.id)) {
      warnings.push(`Node '${node.id}' is unreachable from entry node`);
    }
  }

  // 5. Back-edge detection — warn if loop nodes don't set maxVisits > 1
  const backEdges = detectBackEdges(definition.nodes, definition.entryNodeId);
  for (const { from, to } of backEdges) {
    const targetNode = definition.nodes.find((n) => n.id === to);
    if (targetNode && (!targetNode.maxVisits || targetNode.maxVisits <= 1)) {
      warnings.push(
        `Node '${to}' is a back-edge target from '${from}' but maxVisits is 1 (loop will execute only once). Set maxVisits > 1 to enable looping.`,
      );
    }
  }

  // 6. Required capabilities check
  for (const node of definition.nodes) {
    const def = registry.get(node.type);
    if (def?.requiredCapabilities) {
      // Check against tenant capabilities (loaded separately)
      // This is a warning at save time, error at activate time
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
```

### 8.2 Graph Analysis Utilities

```typescript
/**
 * Find all nodes reachable from the entry node via BFS.
 */
function findReachableNodes(nodes: PipelineNode[], entryNodeId: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [entryNodeId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);

    const node = nodes.find((n) => n.id === nodeId);
    if (!node) continue;

    // Follow transitions
    for (const t of node.transitions) {
      if (!reachable.has(t.target)) {
        queue.push(t.target);
      }
    }

    // Include group children
    if (node.children) {
      for (const child of node.children) {
        reachable.add(child.id);
      }
    }
  }

  return reachable;
}

/**
 * Detect back-edges (transitions that point to a previously visited node in DFS order).
 * These indicate loops in the graph.
 */
function detectBackEdges(
  nodes: PipelineNode[],
  entryNodeId: string,
): Array<{ from: string; to: string }> {
  const backEdges: Array<{ from: string; to: string }> = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  function dfs(nodeId: string) {
    visited.add(nodeId);
    inStack.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    for (const t of node.transitions) {
      if (inStack.has(t.target)) {
        backEdges.push({ from: nodeId, to: t.target });
      } else if (!visited.has(t.target)) {
        dfs(t.target);
      }
    }

    inStack.delete(nodeId);
  }

  dfs(entryNodeId);
  return backEdges;
}
```

---

## 9. Tenant Isolation & Quotas

### 9.1 Quota Model

```typescript
/**
 * Per-tenant pipeline quotas.
 * Stored in MongoDB (tenant_pipeline_quotas collection) or tenant settings.
 * Platform defaults applied when no tenant-specific quota exists.
 */
interface TenantPipelineQuota {
  tenantId: string;

  // ── Pipeline Limits ──
  maxPipelines: number; // max pipeline definitions. Default: 50
  maxNodesPerPipeline: number; // max nodes in a single pipeline. Default: 100
  maxActiveRuns: number; // max concurrent pipeline runs. Default: 10

  // ── Execution Limits ──
  maxExecutionTimeMs: number; // per-run timeout. Default: 1,800,000 (30 minutes)
  maxNodeVisits: number; // hard cap on loop iterations per node. Default: 100
  maxSubPipelineDepth: number; // max nested sub-pipeline depth. Default: 3

  // ── Integration Limits ──
  maxHttpRequestsPerRun: number; // outbound HTTP calls per run. Default: 50
  allowedHttpDomains?: string[]; // whitelist for http-request nodes. null = any

  // ── Rate Limits ──
  maxRunsPerHour: number; // throttle trigger rate. Default: 500
  maxRunsPerDay: number; // daily limit. Default: 5000
}
```

### 9.2 Platform Defaults

```typescript
const PLATFORM_DEFAULT_QUOTA: Omit<TenantPipelineQuota, 'tenantId'> = {
  maxPipelines: 50,
  maxNodesPerPipeline: 100,
  maxActiveRuns: 10,
  maxExecutionTimeMs: 1_800_000, // 30 minutes
  maxNodeVisits: 100,
  maxSubPipelineDepth: 3,
  maxHttpRequestsPerRun: 50,
  allowedHttpDomains: undefined, // no restriction by default
  maxRunsPerHour: 500,
  maxRunsPerDay: 5000,
};
```

### 9.3 Quota Enforcement Points

| Check                   | When                   | Enforcement                                           |
| ----------------------- | ---------------------- | ----------------------------------------------------- |
| `maxPipelines`          | Pipeline CRUD (create) | Reject if tenant already has max pipelines            |
| `maxNodesPerPipeline`   | Pipeline CRUD (save)   | Reject if node count exceeds limit                    |
| `maxActiveRuns`         | Trigger fires          | Skip trigger if tenant has max active runs            |
| `maxRunsPerHour`        | Trigger fires          | Rate-limit via sliding window counter in Redis        |
| `maxRunsPerDay`         | Trigger fires          | Rate-limit via daily counter in Redis                 |
| `maxExecutionTimeMs`    | During run             | Workflow timeout — Restate cancels if exceeded        |
| `maxNodeVisits`         | Each node visit        | Graph walker checks before executing node             |
| `maxSubPipelineDepth`   | Sub-pipeline node      | Check depth counter before starting nested run        |
| `maxHttpRequestsPerRun` | http-request node      | Counter incremented per HTTP call, reject if exceeded |
| `allowedHttpDomains`    | http-request node      | URL domain checked against whitelist                  |

---

## 10. REST API

### 10.1 Pipeline Node Catalog API

```
GET /api/projects/:projectId/pipeline-nodes
  Query params:
    ?category=compute               Filter by category
    ?capabilities=llm-credentials   Filter by tenant capabilities
  Response: {
    success: true,
    data: NodeTypeDefinition[]
  }

GET /api/projects/:projectId/pipeline-nodes/:type
  Response: {
    success: true,
    data: NodeTypeDefinition         Full definition with configSchema
  }
```

### 10.2 Pipeline CRUD API

```
POST /api/projects/:projectId/pipelines
  Body: {
    name: string,
    description?: string,
    nodes: PipelineNode[],
    entryNodeId: string,
    supportedTriggers?: TriggerEntry[],
    tags?: string[],
  }
  Response: {
    success: true,
    data: {
      pipeline: PipelineDefinition,
      validation: { warnings?: string[] }
    }
  }
  Errors:
    400 — validation failed (unknown node types, bad config, dangling transitions)
    429 — maxPipelines quota exceeded

GET /api/projects/:projectId/pipelines
  Query params:
    ?status=active                   Filter by status
    ?tags=analytics,safety           Filter by tags
    ?page=1&limit=20                 Pagination
  Response: {
    success: true,
    data: PipelineDefinition[],
    pagination: { page, limit, total }
  }

GET /api/projects/:projectId/pipelines/:id
  Response: {
    success: true,
    data: PipelineDefinition
  }

PUT /api/projects/:projectId/pipelines/:id
  Body: { ... same as POST ... }
  Response: {
    success: true,
    data: {
      pipeline: PipelineDefinition,   // version auto-incremented
      validation: { warnings?: string[] }
    }
  }

DELETE /api/projects/:projectId/pipelines/:id
  Response: { success: true }
  Note: Soft-delete (status → 'archived'). In-flight runs continue.

POST /api/projects/:projectId/pipelines/:id/activate
  Response: { success: true, data: PipelineDefinition }
  Note: Sets status to 'active'. Registers triggers. Validates capabilities.

POST /api/projects/:projectId/pipelines/:id/deactivate
  Response: { success: true, data: PipelineDefinition }
  Note: Sets status to 'draft'. Deregisters triggers. In-flight runs continue.

POST /api/projects/:projectId/pipelines/:id/validate
  Response: {
    success: true,
    data: { valid: boolean, errors: string[], warnings?: string[] }
  }
  Note: Validates without saving. Useful for draft pipelines.

POST /api/projects/:projectId/pipelines/:id/clone
  Body: { name?: string }
  Response: { success: true, data: PipelineDefinition }
  Note: Creates a copy in 'draft' status with incremented name.
```

### 10.3 Pipeline Execution API

```
POST /api/projects/:projectId/pipelines/:id/execute
  Body: {
    input?: Record<string, any>,     Pipeline input (for manual triggers)
    triggerId?: string,              Which trigger strategy to use
  }
  Response: {
    success: true,
    data: {
      runId: string,
      status: 'pending',
    }
  }
  Errors:
    429 — maxActiveRuns or maxRunsPerHour quota exceeded

GET /api/projects/:projectId/pipeline-runs
  Query params:
    ?pipelineId=...                  Filter by pipeline
    ?status=running                  Filter by status
    ?page=1&limit=20                 Pagination
  Response: {
    success: true,
    data: PipelineRunRecord[],
    pagination: { page, limit, total }
  }

GET /api/projects/:projectId/pipeline-runs/:runId
  Response: {
    success: true,
    data: {
      runId: string,
      pipelineId: string,
      status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
      nodes: Array<{
        id: string,
        type: string,
        status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
        startedAt?: number,
        completedAt?: number,
        durationMs?: number,
        output?: Record<string, any>,
      }>,
      startedAt: number,
      completedAt?: number,
      durationMs?: number,
    }
  }

POST /api/projects/:projectId/pipeline-runs/:runId/cancel
  Response: { success: true }
  Note: Cancels the Restate workflow. Remaining nodes marked 'skipped'.

POST /api/projects/:projectId/pipeline-runs/:runId/events/:eventName
  Body: Record<string, any>          Event payload to resume the waiting node
  Response: { success: true }
  Note: Resolves the Restate durable promise. Pipeline resumes from the wait node.
```

---

## 11. Expression Evaluator

### 11.1 Supported Syntax

The expression evaluator is a safe subset of comparison and logical operations. No arbitrary code execution.

| Feature           | Syntax                           | Example                                                 |
| ----------------- | -------------------------------- | ------------------------------------------------------- |
| Property access   | dot notation                     | `output.score`, `context.nodeOutputs.check.data.status` |
| Comparison        | `==`, `!=`, `>`, `<`, `>=`, `<=` | `output.score > 0.7`                                    |
| Logical operators | `&&`, `\|\|`, `!`                | `output.a == true && output.b == true`                  |
| String literals   | single quotes                    | `output.status == 'FAIL'`                               |
| Number literals   | integers and floats              | `output.score >= 0.85`                                  |
| Boolean literals  | `true`, `false`                  | `output.approved == true`                               |
| Null check        | `null`                           | `output.result != null`                                 |
| Nested access     | chained dots                     | `output.scores.toxicity > 0.7`                          |

### 11.2 Available Variables in Expressions

| Variable              | Description                                 | Available In            |
| --------------------- | ------------------------------------------- | ----------------------- |
| `output`              | The current (source) node's output data     | Transition conditions   |
| `context.nodeOutputs` | All previous node outputs, keyed by node ID | Transition conditions   |
| `input`               | Original pipeline trigger input             | Transition conditions   |
| `item`                | Current item in iteration                   | Filter node expressions |

### 11.3 Security

- **No function calls** — `output.toString()` is not allowed
- **No assignment** — `output.x = 5` is not allowed
- **No object construction** — `{ key: value }` is not allowed
- **Property access only on known roots** — `output`, `context`, `input`, `item`
- **Max expression length** — 500 characters
- **Max nesting depth** — 10 levels of property access

---

## 12. Data Flow

### 12.1 Execution Context

Every pipeline run maintains an execution context that accumulates node outputs as the graph is traversed:

```typescript
interface ExecutionContext {
  /** Original pipeline trigger input (tenantId, sessionId, etc.) */
  input: Record<string, any>;

  /** Accumulated outputs from all visited nodes, keyed by node ID */
  nodeOutputs: Record<string, StepOutput>;
}
```

### 12.2 How Nodes Access Data

| Data Source             | How to Access                                    | Example                                  |
| ----------------------- | ------------------------------------------------ | ---------------------------------------- |
| Pipeline trigger input  | `input.*`                                        | `input.sessionId`, `input.tenantId`      |
| Previous node's output  | `context.nodeOutputs.<nodeId>.data.*`            | `context.nodeOutputs.read.data.messages` |
| Node group child output | `output.<childId>.*` (within group transitions)  | `output.toxicity.score`                  |
| Config values           | Available via `config.*` inside the node handler | `config.threshold`, `config.model`       |

### 12.3 Template Substitution

Config fields that support `{{variable}}` substitution can reference:

```
{{input.tenantId}}                          — pipeline trigger input
{{input.sessionId}}                         — pipeline trigger input
{{nodeOutputs.read.data.messages[0].text}}  — previous node output
{{config.customField}}                      — pipeline-level config
```

Template substitution is performed by the NodeExecutor before passing config to the handler.

### 12.4 Data Flow Through Branches

When execution branches (multiple transitions from a condition), each branch accumulates its own outputs into the shared `nodeOutputs` map. If branches converge at a common node:

```
        ┌──► A (writes nodeOutputs.A) ──┐
Start ──┤                                ├──► Merge
        └──► B (writes nodeOutputs.B) ──┘
```

The `Merge` node can access both `nodeOutputs.A` and `nodeOutputs.B` in its context. Since only one branch executes (conditional transitions take the first match), there's no conflict — only one of A or B will have output.

### 12.5 Data Flow Through Loops

When a back-edge causes a node to be revisited, its output in `nodeOutputs` is **overwritten** with the latest execution result. Previous iteration outputs are not preserved. If iteration history is needed, the loop body should accumulate results explicitly (e.g., via a `transform` node that appends to an array).

---

## 13. Pipeline Execution State

### 13.1 PipelineRunRecord — MongoDB Persistence

```typescript
interface PipelineRunRecord {
  runId: string; // unique run ID (Restate workflow key)
  pipelineId: string;
  pipelineVersion: number;
  tenantId: string;
  projectId?: string;

  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  trigger: {
    type: 'kafka' | 'schedule' | 'manual';
    kafkaTopic?: string;
    triggeredBy?: string; // userId for manual triggers
    triggerId?: string;
    executionMode?: 'batch' | 'realtime';
  };

  input: Record<string, any>;

  nodes: Array<{
    id: string;
    type: string;
    label?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
    output?: Record<string, any>; // stored for completed nodes
    error?: string; // stored for failed nodes
    visitCount?: number; // how many times this node was visited (for loops)
  }>;

  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;

  error?: {
    nodeId: string;
    message: string;
  };

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}
```

### 13.2 MongoDB Indexes for Run Records

```
{ tenantId: 1, pipelineId: 1, status: 1 }    — list runs per pipeline
{ tenantId: 1, status: 1, startedAt: -1 }     — list active/recent runs
{ runId: 1, tenantId: 1 }                      — unique run lookup
{ tenantId: 1, startedAt: 1 }                  — TTL index for run cleanup
```

---

## 14. Versioning & Safe Updates

### 14.1 Pipeline Versioning

- Every update to a pipeline definition auto-increments the `version` field
- When a trigger fires, the **current version** of the pipeline definition is snapshot into the run
- In-flight runs continue executing the version they started with, even if the pipeline is updated or deactivated mid-run
- Previous versions are not stored separately — the run record contains the version number, and the pipeline definition at that version is embedded in the Restate workflow's durable journal

### 14.2 Safe Activation/Deactivation

| Action                | Effect on Triggers                                  | Effect on In-Flight Runs                 |
| --------------------- | --------------------------------------------------- | ---------------------------------------- |
| Activate              | Registers triggers (Kafka subscriptions, schedules) | N/A                                      |
| Deactivate            | Deregisters triggers — no new runs will start       | Existing runs continue to completion     |
| Archive (delete)      | Deregisters triggers                                | Existing runs continue to completion     |
| Update (while active) | Triggers continue — new runs use latest version     | Existing runs use their snapshot version |

---

## 15. Example Pipelines

### 15.1 Simple Analytics Pipeline (Equivalent to Current)

```typescript
{
  name: 'Session Safety Evaluation',
  entryNodeId: 'read',
  nodes: [
    {
      id: 'read',
      type: 'read-conversation',
      config: {},
      transitions: [{ target: 'eval-group' }],
    },
    {
      id: 'eval-group',
      type: 'node-group',
      config: {},
      children: [
        { id: 'toxicity', type: 'compute-toxicity', config: { threshold: 0.7 } },
        { id: 'sentiment', type: 'compute-sentiment', config: { granularity: 'session' } },
      ],
      transitions: [{ target: 'store' }],
    },
    {
      id: 'store',
      type: 'store-insight',
      config: {},
      transitions: [],
    },
  ],
}
```

### 15.2 Branching Pipeline with Conditional Alerts

```typescript
{
  name: 'Toxicity Detection with Alerting',
  entryNodeId: 'read',
  nodes: [
    {
      id: 'read',
      type: 'read-conversation',
      config: {},
      transitions: [{ target: 'check-toxicity' }],
    },
    {
      id: 'check-toxicity',
      type: 'compute-toxicity',
      config: { threshold: 0.7, categories: ['toxicity', 'hate_speech'] },
      transitions: [
        { target: 'alert-and-store', condition: "output.score > 0.7", order: 1, label: 'toxic' },
        { target: 'store-only', order: 2, label: 'clean' },
      ],
    },
    {
      id: 'alert-and-store',
      type: 'node-group',
      config: {},
      children: [
        { id: 'slack-alert', type: 'send-slack',
          config: { channel: '#safety-alerts', message: 'Toxic content detected: score={{nodeOutputs.check-toxicity.data.score}}' } },
        { id: 'store-toxic', type: 'store-insight', config: { tags: ['toxic'] } },
      ],
      transitions: [],
    },
    {
      id: 'store-only',
      type: 'store-insight',
      config: {},
      transitions: [],
    },
  ],
}
```

### 15.3 Approval Workflow with Pause & Resume

```typescript
{
  name: 'Report Generation with Approval',
  entryNodeId: 'generate',
  nodes: [
    {
      id: 'generate',
      type: 'call-llm',
      config: {
        systemPrompt: 'Generate a weekly analytics summary report.',
        userPromptTemplate: 'Summarize the following data: {{nodeOutputs.fetch-data.data}}',
      },
      transitions: [{ target: 'notify-reviewer' }],
    },
    {
      id: 'notify-reviewer',
      type: 'send-email',
      config: {
        to: '{{input.reviewerEmail}}',
        subject: 'Report ready for review',
        body: 'A new report has been generated. <a href="{{input.approvalUrl}}">Review and approve</a>',
      },
      transitions: [{ target: 'wait-approval' }],
    },
    {
      id: 'wait-approval',
      type: 'wait-for-event',
      config: {
        eventName: 'report-approval',
        timeoutMs: 172800000,
        timeoutAction: 'default-value',
        defaultValue: { approved: false, reason: 'timeout' },
      },
      transitions: [
        { target: 'publish', condition: "output.approved == true", order: 1, label: 'approved' },
        { target: 'archive', order: 2, label: 'rejected' },
      ],
    },
    {
      id: 'publish',
      type: 'http-request',
      config: { url: 'https://internal.api/reports', method: 'POST' },
      transitions: [],
    },
    {
      id: 'archive',
      type: 'store-results',
      config: { destination: 'mongodb', collection: 'archived_reports' },
      transitions: [],
    },
  ],
}
```

### 15.4 Retry Loop with Back-Edge

```typescript
{
  name: 'Data Enrichment with Validation Loop',
  entryNodeId: 'fetch',
  nodes: [
    {
      id: 'fetch',
      type: 'http-request',
      maxVisits: 3,
      config: {
        url: 'https://api.example.com/enrich',
        method: 'POST',
        body: '{"query": "{{input.query}}"}',
      },
      transitions: [{ target: 'validate' }],
    },
    {
      id: 'validate',
      type: 'call-llm',
      maxVisits: 3,
      config: {
        systemPrompt: 'Validate the following data. Return { valid: true/false, issues: [...] }',
        userPromptTemplate: '{{nodeOutputs.fetch.data}}',
      },
      transitions: [
        { target: 'store', condition: "output.valid == true", order: 1, label: 'valid' },
        { target: 'fetch', condition: "output.valid == false", order: 2, label: 'retry' },
      ],
    },
    {
      id: 'store',
      type: 'store-results',
      config: { destination: 'mongodb', collection: 'enriched_data' },
      transitions: [],
    },
  ],
}
```

### 15.5 Multi-Domain Pipeline (Ingestion + Analytics)

```typescript
{
  name: 'Ingest and Analyze Customer Feedback',
  entryNodeId: 'fetch-feedback',
  nodes: [
    {
      id: 'fetch-feedback',
      type: 'http-request',
      config: {
        url: 'https://api.zendesk.com/tickets/recent',
        method: 'GET',
        headers: { 'Authorization': 'Bearer {{config.zendeskToken}}' },
      },
      transitions: [{ target: 'analyze-group' }],
    },
    {
      id: 'analyze-group',
      type: 'node-group',
      config: {},
      children: [
        { id: 'sentiment', type: 'compute-sentiment', config: { granularity: 'message' } },
        { id: 'intent', type: 'compute-intent', config: {} },
        { id: 'toxicity', type: 'compute-toxicity', config: { threshold: 0.5 } },
      ],
      transitions: [{ target: 'route' }],
    },
    {
      id: 'route',
      type: 'switch',
      config: {
        expression: 'context.nodeOutputs.sentiment.data.sentiment',
        cases: [
          { value: 'negative', target: 'escalate' },
          { value: 'positive', target: 'store' },
        ],
        default: 'store',
      },
      transitions: [],
    },
    {
      id: 'escalate',
      type: 'node-group',
      config: {},
      children: [
        { id: 'alert-team', type: 'send-slack',
          config: { channel: '#escalations', message: 'Negative feedback detected' } },
        { id: 'create-ticket', type: 'http-request',
          config: { url: 'https://internal.api/tickets', method: 'POST' } },
      ],
      transitions: [{ target: 'store' }],
    },
    {
      id: 'store',
      type: 'store-insight',
      config: {},
      transitions: [],
    },
  ],
}
```

---

## 16. What Stays Untouched

| Component                            | Status        | Notes                                                          |
| ------------------------------------ | ------------- | -------------------------------------------------------------- |
| All 21 existing activity services    | **Unchanged** | Auto-registered as nodes in the registry                       |
| All 11 existing pipeline definitions | **Unchanged** | `steps[]` format auto-converted to graph at runtime            |
| PipelineConfigService                | **Unchanged** | Same config resolution hierarchy (project > tenant > platform) |
| Existing Kafka triggers              | **Unchanged** | Same event matching logic via EventSubscriptionRegistry        |
| PipelineTrigger service              | **Extended**  | Adds quota checks, otherwise same                              |
| PipelineRunRecord schema             | **Extended**  | Adds `visitCount`, `waiting` status for pause nodes            |
| Expression evaluator                 | **Extended**  | Adds `output.*` and `context.*` variable roots                 |
| ACTIVITY_TYPES metadata              | **Unchanged** | Wrapped by NodeRegistry at startup                             |
| SERVICE_HANDLERS dispatch table      | **Unchanged** | Used by NodeExecutor (renamed from ActivityRouter)             |

---

## 17. Implementation Phases

### Phase 1: Foundation (Graph Model + Node Registry)

- `NodeTypeDefinition` interface and `NodeRegistry` class
- Auto-registration of existing 21 activity types
- `PipelineNode` and `NodeTransition` types
- `stepsToGraph()` backward compatibility converter
- Graph walker in PipelineRun (replaces step array loop)
- Pipeline validation (node types, configs, transitions, orphans, back-edges)
- Pipeline CRUD API updates to accept `nodes` + `entryNodeId`
- Pipeline node catalog API (`GET /pipeline-nodes`)

### Phase 2: Control Flow Nodes

- `node-group` node type (parallel execution of children)
- `wait-for-event` node type (pause & resume via Restate durable promises)
- `delay` node type (Restate durable sleep)
- `sub-pipeline` node type (nested pipeline execution)
- `switch` node type (multi-way branching sugar)
- Resume API endpoint (`POST /pipeline-runs/:runId/events/:eventName`)
- Loop protection (maxVisits enforcement, back-edge detection)

### Phase 3: Data & Integration Nodes

- `db-query` node type (ClickHouse + MongoDB)
- `filter` and `aggregate` node types
- `http-request` node type (external API calls with template substitution)
- `send-email` and `send-slack` node types
- `publish-kafka` node type
- Template substitution engine (`{{variable}}` in config fields)

### Phase 4: Tenant Quotas & Production Hardening

- `TenantPipelineQuota` model and enforcement
- Rate limiting (maxRunsPerHour, maxRunsPerDay via Redis)
- HTTP domain whitelisting for integration nodes
- Execution timeout enforcement
- Run cancellation support
- Pipeline cloning
- Comprehensive integration tests

### Phase 5: Visual Builder (Future)

- Studio canvas component for drag-and-drop pipeline building
- Node palette organized by category
- Config forms auto-generated from `configSchema`
- Transition drawing with condition editors
- Live run visualization (node status updates via WebSocket)
- Pipeline templates / marketplace

---

## 18. Open Questions

| Question                                                                          | Options                                                | Recommendation                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Should node groups support sequential mode (children run in order, not parallel)? | Yes — add `mode: 'parallel' \| 'sequential'` to config | No for now — sequential is just regular nodes chained by transitions. Keep groups simple.                          |
| Should we support conditional children within a group?                            | Yes — child has a condition field                      | No — conditions are a graph concern, not a group concern. Move the child out of the group if it needs a condition. |
| How should template substitution handle missing variables?                        | Error, empty string, or leave as-is                    | Empty string with a warning in run output — fail-safe over fail-fast for templates.                                |
| Should pipeline definitions support comments/annotations?                         | Yes — `notes` field on nodes                           | Yes — add optional `notes: string` to PipelineNode for documentation purposes.                                     |
| Should the run API return node outputs by default or require opt-in?              | Always include, opt-out                                | Include by default for small outputs, truncate large outputs with a `?full=true` option.                           |
