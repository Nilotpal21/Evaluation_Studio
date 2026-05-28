# High-Level Design: Workflows & Human Tasks

> **Feature ID**: #48
> **Status**: BETA
> **Created**: 2026-03-23
> **Last Updated**: 2026-04-14

---

## 1. Overview

The Workflows & Human Tasks system provides durable, multi-step workflow orchestration with human-in-the-loop (HITL) capabilities for the ABL Platform. It enables enterprises to define automation workflows that combine agent invocations, connector actions, HTTP calls, tool executions, conditional logic, parallel processing, and human checkpoints (approvals, data entry, reviews, decisions).

### Key Design Decisions

1. **Restate for durable execution**: Workflows survive pod restarts with exactly-once step semantics. Restate manages the execution journal, replay, and durable promises -- the workflow-engine is stateless.
2. **Separate workflow-engine service**: Decoupled from the main runtime (port 9080 vs 3112) to allow independent scaling and deployment.
3. **Unified HumanTask collection**: A single MongoDB collection stores all human tasks regardless of source (workflow approval, workflow human_task, agent escalation) using a discriminated union source field.
4. **Step dispatcher pattern**: A central dispatcher routes steps to type-specific executors, keeping each executor single-responsibility and independently testable.
5. **Expression templating**: `{{path}}` expressions are resolved at execution time against a WorkflowContextData object, enabling dynamic parameterization without pre-compilation.

---

## 2. Architecture

### System Context Diagram

```
                    Studio UI (port 5173)
                         |
               [Workflow Canvas Builder]
               [Human Task Inbox]
               [Execution Monitor]
                         |
                    Studio BFF (Next.js API routes)
                         |
          +--------------+---------------+
          |                              |
    Runtime (port 3112)           Workflow Engine
    [Workflow CRUD]               (port 9080)
    [Human Task Routes]           [Execution]
    [Version Service]             [Triggers]
    [SLA Checker]                 [Connectors]
    [WF Engine Proxy] ---------> [Restate Endpoint]
          |                              |
          +-----+------+         +------+------+
                |                |             |
             MongoDB          Restate        Redis
             (workflows,      (port 9070)    (Pub/Sub,
              versions,        HTTP/2         BullMQ)
              executions,
              human_tasks,
              api_keys)
```

### Component Architecture

```
workflow-engine/
  index.ts                          -- Express + Restate entry point
  handlers/
    workflow-handler.ts             -- Core execution loop (runWorkflow)
    step-dispatcher.ts              -- Step type routing
  executors/
    approval-executor.ts            -- Approval request/timeout builder
    human-task-executor.ts          -- Human task request/timeout builder
    http-executor.ts                -- HTTP step execution
    connector-action-executor.ts    -- Connector action via ConnectorToolExecutor
    tool-call-executor.ts           -- Tool execution via runtime API
    agent-invocation-executor.ts    -- Agent invocation via runtime API
    async-webhook-executor.ts       -- Outbound webhook + callback
    condition-executor.ts           -- Expression evaluation
    delay-executor.ts               -- Duration resolution
    parallel-executor.ts            -- Branch execution with strategies
    loop-executor.ts                -- Item iteration
    transform-executor.ts           -- Data transformation
  context/
    expression-resolver.ts          -- {{path}} template resolution
  persistence/
    execution-store.ts              -- WorkflowExecution MongoDB ops
    human-task-store.ts             -- HumanTask MongoDB ops
  services/
    restate-endpoint.ts             -- HTTP/2 Restate service definition
    restate-client.ts               -- Client for starting/cancelling/resolving
    trigger-engine.ts               -- Trigger registration and resolution
    trigger-scheduler.ts            -- BullMQ scheduler for polling/cron
    database.ts                     -- MongoDB connection
    redis.ts                        -- Redis connection
  routes/
    workflow-executions.ts          -- Execution CRUD routes
    workflow-approvals.ts           -- Approval resolution route
    human-task-resolution.ts        -- Human task resolution route
    workflow-callbacks.ts           -- Webhook callback route (HMAC)
    triggers.ts                     -- Trigger CRUD routes
    connections.ts                  -- Connection CRUD routes
    connectors.ts                   -- Connector catalog routes
    notification-rules.ts           -- Notification rule CRUD
  notifications/
    notification-dispatcher.ts      -- Event matching + channel dispatch
  observability/
    otel-setup.ts                   -- OpenTelemetry instrumentation
```

### Execution Flow

1. **Trigger fires** (webhook/polling/cron/manual/agent) -> Restate `startWorkflow` called
2. **Restate invokes** `runWorkflow` handler with execution input
3. **Handler iterates** through step queue, calling `dispatchStep` for each
4. **Non-suspension steps** (http, tool_call, connector_action, agent_invocation, condition, loop, transform, parallel) execute immediately
5. **Suspension steps** (delay, approval, human_task, async_webhook):
   - Persist waiting status to MongoDB
   - Publish waiting event to Redis
   - Await Restate durable promise (survives restarts)
6. **External signal resolves promise** (approval decision, human task response, webhook callback)
7. **Handler resumes** from the resolved step, continuing the queue
8. **Completion/failure** persisted to MongoDB, published to Redis

---

## 3. 12 Architectural Concerns

### 3.1 Tenant Isolation

**Approach**: Every MongoDB query includes `tenantId` in the filter. The `tenantIsolationPlugin` is applied to all three models (Workflow, WorkflowExecution, HumanTask). Routes derive tenantId from the authenticated JWT context, never from request parameters.

**Implementation**:

- `Workflow.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true })`
- `WorkflowExecution.findOne({ _id: executionId, tenantId, projectId })`
- `HumanTask.findOne({ _id: taskId, tenantId })`
- Cross-tenant access returns 404 (not 403)

**Gap**: Human task assign/claim/resolve routes do not enforce project-level RBAC -- any authenticated user in the tenant can operate on tasks.

### 3.2 Authentication & Authorization

**Approach**: Unified auth middleware (`createUnifiedAuthMiddleware`) with JWT verification. Applied globally to all API routes except health checks and HMAC-verified callback routes.

**Implementation**:

- `const authMiddleware = [unifiedAuth, requireAuth()]`
- Callback routes use HMAC signature verification instead of JWT
- Human task resolution derives respondedBy from `tenantContext.userId`, ignoring client-supplied values (identity spoofing prevention)

**Gap**: No `requireProjectPermission()` calls in workflow routes -- project-level authorization is not enforced.

### 3.3 Data Model & Storage

**Approach**: Three MongoDB collections with Mongoose schemas, UUIDv7 primary keys, and comprehensive indexing.

**Collections**:

- `workflows`: Definition storage. Indexes on `{tenantId, projectId, name}` (unique), `{tenantId, type, status}`.
- `workflow_executions`: Execution state snapshots. Indexes on `{tenantId, workflowId, status}`, `{tenantId, restateWorkflowId}` (unique).
- `human_tasks`: Unified task store. Indexes on `{tenantId, projectId, status, createdAt}`, `{source.type, source.executionId, source.stepId}`.

**Design choice**: Execution state is stored in both Restate (journal, authoritative) and MongoDB (queryable snapshots). Restate is the source of truth for in-flight executions; MongoDB provides query access and historical records.

### 3.4 API Design

**Approach**: RESTful Express routes with standard error envelope `{ success, data?, error?: { code, message } }`. Project-scoped routes under `/api/v1/projects/:projectId/...`.

**Key routes**:

- Execution lifecycle: start (POST), list (GET), get (GET)
- Human task lifecycle: list, get, assign, claim, resolve
- Approval: accept/reject
- Triggers: register, list, enable/disable
- Connections: CRUD with encrypted credentials
- Notifications: rule CRUD with test dispatch

### 3.5 Observability

**Approach**: OTel instrumentation initialized before any other import (monkey-patches HTTP/Express). Redis Pub/Sub for real-time execution status events.

**Implementation**:

- `otel-setup.ts` loaded first in entry point
- Status events published to `workflow:{tenantId}:execution:{executionId}:status` channel
- Events: `workflow.started`, `step.started`, `step.completed`, `step.failed`, `workflow.completed`, `workflow.failed`, `workflow.rejected`, `workflow.cancelled`
- Step-level duration tracking (`durationMs`)

**Gap**: No structured trace events via TraceStore (workflow-engine uses OTel, not the platform TraceStore pattern).

### 3.6 Performance

**Approach**: Step-level parallelism via parallel steps with configurable concurrency. Expression resolution is lightweight string interpolation. BullMQ for async job scheduling.

**Implementation**:

- Parallel steps support `maxConcurrency` to limit concurrent branches
- Step retry with exponential backoff prevents thundering herd on failures
- BullMQ scheduler for polling/cron triggers (Redis-backed, distributed)
- Expression resolver uses simple dot-path traversal (O(depth))

**Gap**: No connection pooling configuration for the runtime/tool HTTP clients. No request body size limits on Restate endpoint.

### 3.7 Error Handling

**Approach**: Discriminated error types (CancellationError, TimeoutError) with structured error objects `{ code, message }` in execution records.

**Implementation**:

- Step failures recorded with `STEP_FAILED` error code
- Workflow failures recorded with `WORKFLOW_FAILED` or `WORKFLOW_CANCELLED`
- Approval rejections use `APPROVAL_REJECTED` status (not generic failure)
- Human task expiry uses `HUMAN_TASK_EXPIRED` error code
- `raceCancel` and `raceTimeout` patterns for durable promise racing
- Global Express error handler returns 500 with generic message

### 3.8 Scalability

**Approach**: Stateless service design -- all state in Restate (execution journal) and MongoDB (queryable snapshots). Horizontal scaling by adding workflow-engine replicas.

**Implementation**:

- Restate manages distributed execution -- no pod-local state
- BullMQ workers are distributed across replicas (Redis-backed locks)
- MongoDB indexes support efficient queries at scale
- Each execution is independent -- no shared in-memory state between executions

**Gap**: No per-tenant rate limiting on execution starts. No configurable max concurrent executions per tenant at the API level (only exists in compiler's WorkflowRuntime).

### 3.9 Security

**Approach**: Encrypted credentials at rest, HMAC signature verification for callbacks, identity enforcement on task resolution.

**Implementation**:

- `EncryptionService.encryptForTenant` / `decryptForTenant` for connection secrets
- Webhook callback routes verify HMAC signatures using decrypted secrets
- Human task resolution uses `tenantContext.userId` not client body
- Raw body captured for HMAC verification (`captureRawBody` middleware)

**Gap**: Expression resolver does not guard against prototype pollution (`__proto__`, `constructor`) in path traversal. No input sanitization for step parameters beyond Zod type checking.

### 3.10 Durability & Reliability

**Approach**: Restate provides the core durability guarantee -- exactly-once step execution, durable sleep, durable promises that survive pod restarts and replays.

**Implementation**:

- Each step wrapped in `restateCtx.run(name, fn)` for exactly-once execution
- Durable promises for approval (`sys:approval:{stepId}`), human task (`sys:human_task:{stepId}`), callback (`sys:callback:{stepId}`), cancel (`sys:cancel`)
- Retry logic per step with configurable `maxAttempts`, `delayMs`, `backoffMultiplier`
- Graceful shutdown with timeout and force exit

### 3.11 Compliance & Audit

**Approach**: Execution records serve as audit trail. Workflow definitions have versioning support (`_v` field). Human task responses record respondedBy and respondedAt.

**Implementation**:

- `WorkflowExecution` records capture full execution history with step-level status
- `HumanTask.response.respondedBy` tracks who resolved each task
- `timestamps: true` on all schemas provides createdAt/updatedAt
- Workflow definitions have `archivedAt` for soft deletion

**Gap**: No dedicated audit log entries for workflow lifecycle events in the workflow-engine (compiler's WorkflowRuntime has audit logging but it's a separate system). No right-to-erasure cascade for workflow data.

### 3.12 Extensibility

**Approach**: Step dispatcher pattern with discriminated union types. New step types require: (1) executor implementation, (2) type addition to union, (3) dispatcher case.

**Implementation**:

- `WorkflowStep` union type with exhaustive switch in `dispatchStep`
- `StepDispatcherDeps` interface for dependency injection
- `ConnectorDepsFactory` for per-execution connector context
- `BranchRunner` callback for parallel step execution
- Notification rules support custom templates and multiple channels

---

## 4. Alternatives Considered

### Alternative 1: BullMQ Flows Instead of Restate

**Description**: Use BullMQ Flows (already used for trigger scheduling) as the workflow execution engine instead of Restate.

**Pros**:

- Single dependency (Redis) instead of Redis + Restate
- Team already has BullMQ expertise (pipeline-engine, trigger scheduler)
- Simpler deployment topology

**Cons**:

- BullMQ does not provide durable promises (approval/human task waiting requires polling)
- No built-in exactly-once execution -- need manual idempotency
- No durable sleep that survives worker restarts -- stalled job recovery is approximate
- Complex workflows (conditions, parallel, loops) would require custom DAG execution on top of BullMQ

**Decision**: Rejected. Restate's durable execution model (journal, replay, durable promises, durable sleep) is a better fit for long-running workflows with human-in-the-loop suspension points.

### Alternative 2: Embedded Workflow Engine in Runtime

**Description**: Run workflow execution logic inside the main runtime service (port 3112) instead of a separate workflow-engine service.

**Pros**:

- Simpler deployment -- one less service to manage
- Direct access to agent runtime, tool registry, and session store
- No inter-service HTTP calls for agent invocation and tool execution

**Cons**:

- Conflates real-time agent chat with long-running workflow execution
- Cannot scale independently -- workflow load affects chat latency
- Restate HTTP/2 endpoint conflicts with runtime's HTTP/1.1 Express server
- Harder to apply different resource limits and restart policies

**Decision**: Rejected. Workflow execution is fundamentally different from real-time chat -- it needs independent scaling, separate resource limits, and its own Restate endpoint.

### Alternative 3: Generic Task Queue Instead of Unified HumanTask Collection

**Description**: Use separate collections for different task types (approvals, data_entry, reviews) instead of a unified HumanTask collection with discriminated source.

**Pros**:

- Simpler per-type schemas -- no need for optional fields
- Type-specific indexes optimized for each query pattern

**Cons**:

- Fragmented task inbox -- UI must query multiple collections
- Duplicate code for assignment, claiming, SLA tracking, escalation
- Harder to add new task types -- each needs a full collection + routes

**Decision**: Rejected. The unified HumanTask collection with discriminated union source provides a single inbox view, shared lifecycle management, and easy extensibility. The optional fields trade-off is acceptable.

---

## 5. Data Flow

### Workflow Execution Data Flow

```
Trigger -> Restate startWorkflow -> runWorkflow handler
  |
  +-> For each step:
  |     |
  |     +-> dispatchStep (type routing)
  |     |     |
  |     |     +-> [executor] -> output
  |     |
  |     +-> Update WorkflowContextData (steps, vars)
  |     +-> Persist step status to MongoDB
  |     +-> Publish event to Redis Pub/Sub
  |
  +-> On suspension (approval/human_task/webhook/delay):
  |     |
  |     +-> Persist waiting status
  |     +-> Create HumanTask record (if applicable)
  |     +-> Await Restate durable promise
  |     +-> External signal resolves promise
  |     +-> Handler resumes
  |
  +-> On completion/failure:
        |
        +-> Persist final status to MongoDB
        +-> Publish terminal event
```

### Human Task Data Flow

```
Workflow Handler
  |
  +-> buildHumanTaskRequest (executor)
  +-> humanTaskStore.createTask (MongoDB)
  +-> Restate promise await: sys:human_task:{stepId}
  |
  |   [Human operator in Studio]
  |     |
  |     +-> GET /human-tasks (list pending)
  |     +-> POST /human-tasks/:id/claim
  |     +-> POST /human-tasks/:id/resolve
  |           |
  |           +-> restateClient.resolveHumanTask
  |           +-> Promise resolved
  |
  +-> Handler resumes with response
  +-> Response fields merged into WorkflowContextData
```

---

## 6. Migration & Compatibility

- **No breaking changes**: This is a new subsystem with no existing users to migrate.
- **Runtime compatibility**: The workflow-engine communicates with the runtime via HTTP API (`/api/v1/chat`, `/api/internal/tools/execute`), maintaining loose coupling.
- **Schema evolution**: Mongoose schemas use `Schema.Types.Mixed` for flexible step definitions. New step types can be added without schema migration.
- **Backward compatibility**: The `packages/shared-kernel` types define 9 step types; the `packages/database` model supports 12 (adding human_task, loop, transform). The Zod schemas in `packages/shared` validate 9. The step dispatcher handles all 12. These should be aligned.

---

## 7. Deployment Topology

```
[Kubernetes]
  |
  +-> workflow-engine (Deployment, port 9080)
  |     +-> Express API server
  |     +-> Restate HTTP/2 endpoint (port 9071)
  |     +-> BullMQ workers (trigger scheduler)
  |
  +-> restate-server (StatefulSet, ports 8080/9070)
  |     +-> Admin API (9070)
  |     +-> Ingress (8080)
  |
  +-> runtime (Deployment, port 3112)
  |     +-> Agent execution, tool registry
  |
  +-> mongodb (StatefulSet)
  +-> redis (StatefulSet)
  +-> studio (Deployment, port 5173)
```

---

## 8. Risk Assessment

| Risk                                                 | Probability | Impact | Mitigation                                                                            |
| ---------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------- |
| Restate unavailability blocks all workflow execution | Medium      | High   | Health check reports Restate status; fallback to BullMQ for simple workflows (future) |
| Human task starvation (tasks never claimed)          | Medium      | Medium | SLA tracking + escalation chains + notification rules                                 |
| Expression injection via template manipulation       | Low         | High   | Validate expressions against allowlist of paths; sanitize **proto**/constructor       |
| MongoDB write pressure from high-volume workflows    | Medium      | Medium | Batch step status updates; configurable persistence interval                          |
| Step executor failures cascade to workflow failure   | High        | Medium | Per-step retry with exponential backoff; parallel step ignore_errors strategy         |

---

## 9. Post-Implementation Notes (2026-04-14)

### Deviations from Original Design

1. **Canvas-based model replaced step-based model**: The original HLD described 12 step types in a linear/tree structure. Implementation evolved to a 20 node-type canvas system with nodes/edges (ReactFlow-based), visual drag-and-drop builder, and a `canvas-to-steps` handler that converts the graph to executable steps.

2. **Workflow CRUD lives in Runtime, not Workflow Engine**: The original design assumed workflow-engine handles both definition CRUD and execution. In practice, CRUD routes are in `apps/runtime/src/routes/workflows.ts` (with audit logging, project isolation, OpenAPI docs), while workflow-engine handles execution only. Runtime proxies execution/trigger/notification requests to workflow-engine via `workflow-engine-proxy.ts`.

3. **Service JWT for internal calls**: The original design assumed JWT auth on all routes. In practice, workflow-engine now mints short-lived service JWTs via `createServiceToken` for runtime API calls (agent invocation, tool execution), replacing the initial x-tenant-id header approach that caused 401s.

4. **SLA checker scoped to agent-escalation only**: The original design implied a universal SLA checker. Implementation correctly scoped the runtime SLA checker to `agent_escalation` tasks only, since workflow-sourced tasks use Restate durable timers for timeout enforcement.

5. **Synchronous upstream dispatch**: Human task resolution now awaits upstream dispatch before marking the task complete, preventing the inbox from showing resolved while the workflow stays stuck. This was a critical data-flow audit finding.

6. **Workflow versioning added**: Not in original HLD scope. Version snapshots capture nodes/edges/envVars/schemas with a draft/testing/staged/active/deprecated promotion lifecycle.

7. **Function node and Integration node**: Two significant node types not in original 12 step types. Function node uses isolated-vm V8 sandbox; integration node uses OAuth grant resolver with distributed locks.

### Resolved Architecture Gaps

- Approval route now syncs mirrored HumanTask status after Restate resolution (data-flow audit C1)
- NotificationDispatcher aligned with CRUD route contract shape (data-flow audit C2)
- Canvas-to-steps propagates priority through human_task config (data-flow audit H1)
- Cancellable statuses use correct `waiting_human_task` string (data-flow audit H2)
- Condition node branches labeled `if / if 1 / else` in studio canvas
- Connector actions routed through runtime proxy with CSRF x-api-key exemption
