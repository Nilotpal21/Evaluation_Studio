# Inbox (Unified Human-in-the-Loop System)

The Inbox is a unified human-in-the-loop (HITL) system that surfaces tasks requiring human attention: workflow approvals, data entry forms, reviews, multi-choice decisions, and agent escalations.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Data Schema](#data-schema)
  - [Collection: `human_tasks`](#collection-human_tasks)
  - [Sub-Schemas](#sub-schemas)
  - [Indexes](#indexes)
  - [RBAC Permissions](#rbac-permissions)
- [Source Types](#source-types)
  - [Workflow Approval](#1-workflow-approval-sourcetype-workflow_approval)
  - [Workflow Human Task](#2-workflow-human-task-sourcetype-workflow_human_task)
  - [Agent Escalation](#3-agent-escalation-sourcetype-agent_escalation)
- [How Tasks Land in the Inbox](#how-tasks-land-in-the-inbox)
  - [Approval Step Field Mapping](#approval-step-field-mapping)
  - [Human Task Step Field Mapping](#human-task-step-field-mapping)
  - [Escalation Bridge Field Mapping](#escalation-bridge-field-mapping)
  - [Side-by-Side Comparison](#side-by-side-comparison)
- [Task Lifecycle: Create, Assign/Claim, Resolve](#task-lifecycle-create-assignclaim-resolve)
  - [Lifecycle State Machine](#lifecycle-state-machine)
  - [Step 1: Task Creation (Multiple Approvers)](#step-1-task-creation-multiple-approvers)
  - [Step 2: Assign or Claim (Self-Assignment)](#step-2-assign-or-claim-self-assignment)
  - [Step 3: Resolve (Triggers Workflow Resume)](#step-3-resolve-triggers-workflow-resume)
  - [Complete Lifecycle Example: Approval with Multiple Approvers](#complete-lifecycle-example-approval-with-multiple-approvers)
  - [Complete Lifecycle Example: Human Task (Data Entry)](#complete-lifecycle-example-human-task-data-entry)
- [Resolution Flow](#resolution-flow)
  - [Workflow Approval Resolution (`/approve`)](#workflow-approval-resolution-approve)
  - [Workflow Human Task Resolution (`/resolve`)](#workflow-human-task-resolution-resolve)
  - [Agent Escalation Resolution](#agent-escalation-resolution)
  - [Resolution Comparison Table](#resolution-comparison-table)
- [API Routes](#api-routes)
  - [Unified Human Tasks API (Runtime)](#unified-human-tasks-api-runtime)
  - [Workflow Approvals API (Workflow Engine, Legacy)](#workflow-approvals-api-workflow-engine-legacy)
  - [Human Task Resolution API (Workflow Engine)](#human-task-resolution-api-workflow-engine)
- [Frontend Components](#frontend-components)
- [Data Flow Diagrams](#data-flow-diagrams)
- [Key File Paths](#key-file-paths)

---

## Architecture Overview

The system has two generations:

1. **Legacy approval system** -- `workflow-approvals.ts` routes in the workflow-engine query `WorkflowExecution` documents directly. The `InboxPage.tsx` component and `useApprovals` hook consume this. Handles only `waiting_approval` steps.

2. **Unified HITL system** -- The `HumanTask` model in `packages/database` is a dedicated collection supporting five task types. The `human-tasks.ts` routes in the runtime provide full CRUD with RBAC. The `UnifiedInboxPage.tsx` and `useHumanTasks` hook consume this. The `escalation-bridge.ts` creates tasks from agent escalation events. The `human-task-executor.ts` in the workflow engine builds task payloads for workflow-driven human tasks.

### Architectural Layers

| Layer                      | Location                                                   | Responsibility                                                   |
| -------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| **Database Model**         | `packages/database/src/models/human-task.model.ts`         | Mongoose model with `tenantIsolationPlugin`, RBAC migration      |
| **Persistence Store**      | `apps/workflow-engine/src/persistence/human-task-store.ts` | `MongoHumanTaskStore` -- CRUD for tasks within workflow engine   |
| **Service Layer**          | `apps/runtime/src/services/escalation-bridge.ts`           | EventBus subscriber creating tasks from agent escalations        |
| **API Routes**             | `apps/runtime/src/routes/human-tasks.ts`                   | Unified CRUD with RBAC (`/api/projects/:projectId/human-tasks`)  |
| **Workflow Engine Routes** | `apps/workflow-engine/src/routes/workflow-approvals.ts`    | Legacy approval listing and resolution                           |
| **Workflow Engine Routes** | `apps/workflow-engine/src/routes/human-task-resolution.ts` | Human task resolution endpoint                                   |
| **Frontend**               | `apps/studio/src/components/inbox/`                        | `UnifiedInboxPage`, `TaskCard`, `DynamicForm`, `EscalationPanel` |

---

## Data Schema

### Collection: `human_tasks`

| Field                    | Type               | Required | Default       | Description                                                                           |
| ------------------------ | ------------------ | -------- | ------------- | ------------------------------------------------------------------------------------- |
| `_id`                    | `String`           | Yes      | UUIDv7 (auto) | Primary key                                                                           |
| `tenantId`               | `String`           | Yes      | --            | Multi-tenant scoping                                                                  |
| `projectId`              | `String`           | Yes      | --            | Project scoping                                                                       |
| `type`                   | `String` enum      | Yes      | --            | `'approval'`, `'data_entry'`, `'review'`, `'decision'`, `'escalation'`                |
| `status`                 | `String` enum      | Yes      | `'pending'`   | `'pending'`, `'assigned'`, `'in_progress'`, `'completed'`, `'expired'`, `'cancelled'` |
| `priority`               | `String` enum      | Yes      | `'medium'`    | `'low'`, `'medium'`, `'high'`, `'critical'`                                           |
| `title`                  | `String`           | Yes      | --            | Display title                                                                         |
| `description`            | `String`           | No       | --            | Detailed description                                                                  |
| `source`                 | `SourceSchema`     | Yes      | --            | Discriminated union linking to origin system                                          |
| `assignedTo`             | `String`           | No       | --            | User ID assigned to this task                                                         |
| `assignedToTeam`         | `String`           | No       | --            | Team assigned to this task                                                            |
| `claimedBy`              | `String`           | No       | --            | User ID who claimed the task                                                          |
| `fields`                 | `[FieldDefSchema]` | No       | `[]`          | Dynamic form field definitions                                                        |
| `context`                | `Mixed`            | No       | `{}`          | Arbitrary workflow/session context data                                               |
| `response`               | `ResponseSchema`   | No       | --            | Filled when task is resolved                                                          |
| `dueAt`                  | `Date`             | No       | --            | SLA deadline                                                                          |
| `slaBreachedAt`          | `Date`             | No       | --            | When SLA was breached                                                                 |
| `escalationChain`        | `[String]`         | No       | `[]`          | Escalation chain of teams/users                                                       |
| `currentEscalationLevel` | `Number`           | No       | `0`           | Current level in escalation chain                                                     |
| `connectorTicketId`      | `String`           | No       | --            | ITSM connector ticket ID                                                              |
| `connectorTicketUrl`     | `String`           | No       | --            | ITSM connector ticket URL                                                             |
| `connectorActionName`    | `String`           | No       | --            | Connector action used to create ticket                                                |
| `createdAt`              | `Date`             | Auto     | --            | Mongoose timestamps                                                                   |
| `updatedAt`              | `Date`             | Auto     | --            | Mongoose timestamps                                                                   |

### Sub-Schemas

#### `source` (discriminated union, `_id: false`)

Three variants based on `source.type`:

**Variant 1: `workflow_approval`**

| Field         | Type                  | Description                          |
| ------------- | --------------------- | ------------------------------------ |
| `type`        | `'workflow_approval'` | Discriminator                        |
| `workflowId`  | `String`              | Workflow definition ID               |
| `executionId` | `String`              | Restate execution ID                 |
| `stepId`      | `String`              | Approval step ID within the workflow |

**Variant 2: `workflow_human_task`**

| Field         | Type                    | Description                            |
| ------------- | ----------------------- | -------------------------------------- |
| `type`        | `'workflow_human_task'` | Discriminator                          |
| `workflowId`  | `String`                | Workflow definition ID                 |
| `executionId` | `String`                | Restate execution ID                   |
| `stepId`      | `String`                | Human task step ID within the workflow |

**Variant 3: `agent_escalation`**

| Field       | Type                 | Description                      |
| ----------- | -------------------- | -------------------------------- |
| `type`      | `'agent_escalation'` | Discriminator                    |
| `sessionId` | `String`             | Agent runtime session ID         |
| `agentName` | `String`             | Name of the agent that escalated |

#### `fields[]` (dynamic form definition, `_id: false`)

| Field          | Type          | Required | Default | Description                                                           |
| -------------- | ------------- | -------- | ------- | --------------------------------------------------------------------- |
| `name`         | `String`      | Yes      | --      | Field identifier (used as key in response)                            |
| `type`         | `String` enum | Yes      | --      | `'text'`, `'number'`, `'boolean'`, `'select'`, `'textarea'`, `'date'` |
| `label`        | `String`      | Yes      | --      | Display label                                                         |
| `required`     | `Boolean`     | No       | `false` | Whether field must be filled                                          |
| `options`      | `[String]`    | No       | --      | Options for `'select'` type                                           |
| `validation`   | `Mixed`       | No       | --      | Custom validation rules                                               |
| `defaultValue` | `Mixed`       | No       | --      | Pre-filled value                                                      |

#### `response` (filled on resolution, `_id: false`)

| Field         | Type     | Required          | Description                                  |
| ------------- | -------- | ----------------- | -------------------------------------------- |
| `respondedBy` | `String` | Yes               | User ID of responder                         |
| `respondedAt` | `Date`   | Yes               | Timestamp of response                        |
| `fields`      | `Mixed`  | No (default `{}`) | Key-value pairs matching field names         |
| `notes`       | `String` | No                | Free-text notes from responder               |
| `decision`    | `String` | No                | Decision value (for approval/decision types) |

### Indexes

| Name             | Fields                                                              | Purpose                                        |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| Primary listing  | `{ tenantId: 1, projectId: 1, status: 1, createdAt: -1 }`           | Paginated inbox feed with status filtering     |
| Source lookup    | `{ 'source.type': 1, 'source.executionId': 1, 'source.stepId': 1 }` | Find task by originating workflow step         |
| SLA check        | `{ status: 1, dueAt: 1 }`                                           | Query for expired/breached tasks               |
| Escalation dedup | `{ 'source.sessionId': 1, tenantId: 1 }`                            | Prevent duplicate escalation tasks per session |

### RBAC Permissions

Seeded via migration `20260307_010_create_human_tasks_collection.ts`:

| Role     | Permissions                                                                      |
| -------- | -------------------------------------------------------------------------------- |
| ADMIN    | `human_task:*` (all operations)                                                  |
| OPERATOR | `human_task:read`, `human_task:assign`, `human_task:claim`, `human_task:resolve` |
| MEMBER   | `human_task:read`, `human_task:claim`, `human_task:resolve`                      |
| VIEWER   | `human_task:read`                                                                |

---

## Source Types

### 1. Workflow Approval (`source.type: 'workflow_approval'`)

A workflow execution hits an **approval node** step. The approval step is a binary yes/no decision point in a workflow.

**Step Definition (`ApprovalStep`):**

```typescript
interface ApprovalStep {
  id: string;
  type: 'approval';
  message: string; // Shown in the inbox as the task title
  approvers: string[]; // User IDs or group names
  timeout?: number; // Timeout in ms (default: 72 hours)
  onTimeout?: 'approve' | 'reject' | 'escalate'; // Default: 'reject'
}
```

**Executor Output (`ApprovalRequest`):**

```typescript
interface ApprovalRequest {
  approvalId: string; // '{executionId}:{stepId}'
  executionId: string;
  stepId: string;
  message: string; // Expression-resolved from step.message
  approvers: string[]; // Expression-resolved from step.approvers
  tenantId: string;
  projectId: string;
  timeoutMs: number;
  onTimeout: 'approve' | 'reject' | 'escalate';
}
```

### 2. Workflow Human Task (`source.type: 'workflow_human_task'`)

A workflow execution hits a **human task node** (`data_entry`, `review`, or `decision`). These are richer than approvals -- they include dynamic form schemas.

**Step Definition (`HumanTaskStep`):**

```typescript
interface HumanTaskStep {
  id: string;
  type: 'human_task';
  taskType: 'data_entry' | 'review' | 'decision';
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  fields?: HumanTaskFieldDef[]; // Dynamic form schema
  assignTo?: string[];
  timeout?: number; // Default: 72 hours
  onTimeout?: 'expire' | 'escalate' | 'auto_complete'; // Default: 'expire'
}
```

**Executor Output (`HumanTaskRequest`):**

```typescript
interface HumanTaskRequest {
  taskId: string; // '{executionId}:{stepId}'
  executionId: string;
  stepId: string;
  taskType: 'data_entry' | 'review' | 'decision';
  title: string; // Expression-resolved
  description: string; // Expression-resolved
  priority: 'low' | 'medium' | 'high' | 'critical';
  fields: HumanTaskFieldDef[];
  assignTo: string[]; // Expression-resolved
  tenantId: string;
  projectId: string;
  timeoutMs: number;
  onTimeout: 'expire' | 'escalate' | 'auto_complete';
  context: Record<string, unknown>;
}
```

### 3. Agent Escalation (`source.type: 'agent_escalation'`)

An agent runtime session emits a `session.escalation` event on the EventBus when it determines human intervention is needed.

**Event Payload (`SessionEscalationPayload`):**

```typescript
interface SessionEscalationPayload {
  reason: string; // Why the agent escalated
  agent: string; // Agent name
  priority?: 'low' | 'medium' | 'high' | 'critical';
  targetTeam?: string; // Team to assign to
}
```

---

## How Tasks Land in the Inbox

### Approval Step Field Mapping

**Caller:** `workflow-handler.ts` lines 718-739
**Input built by:** `buildApprovalRequest()` in `approval-executor.ts`

| `human_tasks` field      | Value                                | Source                                       |
| ------------------------ | ------------------------------------ | -------------------------------------------- |
| `_id`                    | (auto UUIDv7)                        | Mongoose default                             |
| `tenantId`               | `ctx.tenant.tenantId`                | `WorkflowContextData`                        |
| `projectId`              | `ctx.tenant.projectId`               | `WorkflowContextData`                        |
| `type`                   | `'approval'`                         | Hardcoded                                    |
| `status`                 | `'pending'`                          | Default in `createTask()`                    |
| `priority`               | `'medium'`                           | Hardcoded                                    |
| `title`                  | `approvalReq.message`                | `ApprovalStep.message` (expression-resolved) |
| `description`            | _(not set)_                          | --                                           |
| `source.type`            | `'workflow_approval'`                | Hardcoded                                    |
| `source.workflowId`      | `input.workflowId`                   | `WorkflowExecutionInput`                     |
| `source.executionId`     | `executionId`                        | Restate `ctx.key`                            |
| `source.stepId`          | `step.id`                            | Workflow step definition                     |
| `assignedTo`             | `approvalReq.approvers[0]`           | First approver only                          |
| `assignedToTeam`         | _(not set)_                          | --                                           |
| `fields`                 | `[]`                                 | Hardcoded empty (approvals are binary)       |
| `context.workflowName`   | `input.workflowName`                 | `WorkflowExecutionInput`                     |
| `context.approvers`      | `approvalReq.approvers`              | Full approver list                           |
| `dueAt`                  | `Date.now() + approvalReq.timeoutMs` | `ApprovalStep.timeout` (default 72h)         |
| `escalationChain`        | `[]`                                 | Default in `createTask()`                    |
| `currentEscalationLevel` | `0`                                  | Default in `createTask()`                    |

**Example document:**

```json
{
  "_id": "019e1a2b-3c4d-7000-8000-abcdef123456",
  "tenantId": "tenant-001",
  "projectId": "proj-042",
  "type": "approval",
  "status": "pending",
  "priority": "medium",
  "title": "Approve deployment to production for v2.1.0",
  "source": {
    "type": "workflow_approval",
    "workflowId": "wf-deploy-pipeline",
    "executionId": "exec-789",
    "stepId": "step-approve-deploy"
  },
  "assignedTo": "user-jane",
  "fields": [],
  "context": {
    "workflowName": "Deploy Pipeline",
    "approvers": ["user-jane", "user-bob"]
  },
  "dueAt": "2026-04-12T10:00:00.000Z",
  "escalationChain": [],
  "currentEscalationLevel": 0,
  "createdAt": "2026-04-09T10:00:00.000Z",
  "updatedAt": "2026-04-09T10:00:00.000Z"
}
```

### Human Task Step Field Mapping

**Caller:** `workflow-handler.ts` lines 849-875
**Input built by:** `buildHumanTaskRequest()` in `human-task-executor.ts`

| `human_tasks` field      | Value                            | Source                                                          |
| ------------------------ | -------------------------------- | --------------------------------------------------------------- |
| `_id`                    | (auto UUIDv7)                    | Mongoose default                                                |
| `tenantId`               | `taskReq.tenantId`               | `ctx.tenant.tenantId` (via executor)                            |
| `projectId`              | `taskReq.projectId`              | `ctx.tenant.projectId` (via executor)                           |
| `type`                   | `taskReq.taskType`               | `HumanTaskStep.taskType` (`data_entry` / `review` / `decision`) |
| `status`                 | `'pending'`                      | Default in `createTask()`                                       |
| `priority`               | `taskReq.priority`               | `HumanTaskStep.priority` (default `'medium'`)                   |
| `title`                  | `taskReq.title`                  | `HumanTaskStep.title` (expression-resolved)                     |
| `description`            | `taskReq.description`            | `HumanTaskStep.description` (expression-resolved)               |
| `source.type`            | `'workflow_human_task'`          | Hardcoded                                                       |
| `source.workflowId`      | `input.workflowId`               | `WorkflowExecutionInput`                                        |
| `source.executionId`     | `executionId`                    | Restate `ctx.key`                                               |
| `source.stepId`          | `step.id`                        | Workflow step definition                                        |
| `assignedTo`             | `taskReq.assignTo?.[0]`          | `HumanTaskStep.assignTo[0]` (expression-resolved)               |
| `assignedToTeam`         | _(not set)_                      | --                                                              |
| `fields`                 | `taskReq.fields`                 | `HumanTaskStep.fields[]` (dynamic form schema)                  |
| `context.workflowName`   | `ctx.workflow.name`              | `WorkflowContextData`                                           |
| `context.workflowId`     | `ctx.workflow.id`                | `WorkflowContextData`                                           |
| `context.variables`      | `ctx.vars`                       | Current workflow variable state                                 |
| `dueAt`                  | `Date.now() + taskReq.timeoutMs` | `HumanTaskStep.timeout` (default 72h)                           |
| `escalationChain`        | `[]`                             | Default in `createTask()`                                       |
| `currentEscalationLevel` | `0`                              | Default in `createTask()`                                       |

**Example document (data_entry):**

```json
{
  "_id": "019e1a2b-5e6f-7000-8000-abcdef789012",
  "tenantId": "tenant-001",
  "projectId": "proj-042",
  "type": "data_entry",
  "status": "pending",
  "priority": "high",
  "title": "Enter shipping details for order #4521",
  "description": "Please fill in the delivery address and preferred shipping method.",
  "source": {
    "type": "workflow_human_task",
    "workflowId": "wf-order-fulfillment",
    "executionId": "exec-456",
    "stepId": "step-shipping-details"
  },
  "assignedTo": "user-warehouse-lead",
  "fields": [
    { "name": "address", "type": "textarea", "label": "Delivery Address", "required": true },
    {
      "name": "shipping_method",
      "type": "select",
      "label": "Shipping Method",
      "required": true,
      "options": ["standard", "express", "overnight"]
    },
    {
      "name": "special_instructions",
      "type": "text",
      "label": "Special Instructions",
      "required": false
    }
  ],
  "context": {
    "workflowName": "Order Fulfillment",
    "workflowId": "wf-order-fulfillment",
    "variables": { "orderId": "4521", "customerName": "Acme Corp" }
  },
  "dueAt": "2026-04-12T10:00:00.000Z",
  "escalationChain": [],
  "currentEscalationLevel": 0,
  "createdAt": "2026-04-09T10:00:00.000Z",
  "updatedAt": "2026-04-09T10:00:00.000Z"
}
```

### Escalation Bridge Field Mapping

**Caller:** `escalation-bridge.ts` lines 49-73
**Trigger:** EventBus `session.escalation` event

| `human_tasks` field        | Value                                                        | Source                                |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `_id`                      | (auto UUIDv7)                                                | Mongoose default                      |
| `tenantId`                 | `event.tenantId`                                             | EventBus event                        |
| `projectId`                | `event.projectId`                                            | EventBus event                        |
| `type`                     | `'escalation'`                                               | Hardcoded                             |
| `status`                   | `'pending'`                                                  | Hardcoded                             |
| `priority`                 | `payload.priority ?? 'high'`                                 | Escalation payload (default `'high'`) |
| `title`                    | `'Agent escalation: {reason}'`                               | Constructed from `payload.reason`     |
| `description`              | `'Session {id} escalated by agent {name}. Reason: {reason}'` | Constructed string                    |
| `source.type`              | `'agent_escalation'`                                         | Hardcoded                             |
| `source.sessionId`         | `event.sessionId`                                            | EventBus event                        |
| `source.agentName`         | `payload.agent`                                              | Escalation payload                    |
| `assignedTo`               | _(not set)_                                                  | --                                    |
| `assignedToTeam`           | `payload.targetTeam`                                         | Escalation payload                    |
| `fields`                   | `[]`                                                         | Hardcoded empty                       |
| `context.sessionId`        | `event.sessionId`                                            | EventBus event                        |
| `context.agentName`        | `payload.agent`                                              | Escalation payload                    |
| `context.channel`          | `event.channel`                                              | EventBus event                        |
| `context.escalationReason` | `payload.reason`                                             | Escalation payload                    |
| `dueAt`                    | `Date.now() + 24 hours`                                      | Hardcoded 24h                         |
| `escalationChain`          | `[payload.targetTeam]` or `[]`                               | From target team                      |
| `currentEscalationLevel`   | `0`                                                          | Hardcoded                             |

**Idempotency:** Before creating, checks for an existing active task (`status` in `pending`/`assigned`/`in_progress`) on the same `source.sessionId` + `tenantId`. Skips creation if one exists.

**Example document:**

```json
{
  "_id": "019e1a2b-7a8b-7000-8000-abcdef345678",
  "tenantId": "tenant-001",
  "projectId": "proj-042",
  "type": "escalation",
  "status": "pending",
  "priority": "high",
  "title": "Agent escalation: Customer requesting refund for damaged item",
  "description": "Session sess-abc123 escalated by agent order-support. Reason: Customer requesting refund for damaged item",
  "source": {
    "type": "agent_escalation",
    "sessionId": "sess-abc123",
    "agentName": "order-support"
  },
  "assignedToTeam": "customer-success",
  "fields": [],
  "context": {
    "sessionId": "sess-abc123",
    "agentName": "order-support",
    "channel": "web-chat",
    "escalationReason": "Customer requesting refund for damaged item"
  },
  "dueAt": "2026-04-10T10:00:00.000Z",
  "escalationChain": ["customer-success"],
  "currentEscalationLevel": 0,
  "createdAt": "2026-04-09T10:00:00.000Z",
  "updatedAt": "2026-04-09T10:00:00.000Z"
}
```

### Side-by-Side Comparison

| Aspect               | Approval                                   | Human Task                                 | Escalation                                            |
| -------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- |
| **Created by**       | `workflow-handler.ts` via `humanTaskStore` | `workflow-handler.ts` via `humanTaskStore` | `escalation-bridge.ts` via `HumanTask.create()`       |
| **`type`**           | Always `'approval'`                        | `taskReq.taskType`                         | Always `'escalation'`                                 |
| **`priority`**       | Hardcoded `'medium'`                       | From step config                           | `payload.priority` (default `'high'`)                 |
| **`title`**          | `approvalReq.message`                      | `taskReq.title` (resolved)                 | `'Agent escalation: {reason}'`                        |
| **`description`**    | Never set                                  | `taskReq.description` (resolved)           | Constructed string                                    |
| **`source.type`**    | `'workflow_approval'`                      | `'workflow_human_task'`                    | `'agent_escalation'`                                  |
| **`assignedTo`**     | `approvers[0]`                             | `assignTo?.[0]`                            | Not set                                               |
| **`assignedToTeam`** | Not set                                    | Not set                                    | `payload.targetTeam`                                  |
| **`fields`**         | Always `[]`                                | Dynamic form schema                        | Always `[]`                                           |
| **`context`**        | `{ workflowName, approvers }`              | `{ workflowName, workflowId, variables }`  | `{ sessionId, agentName, channel, escalationReason }` |
| **`dueAt`**          | `now + timeoutMs` (default 72h)            | `now + timeoutMs` (default 72h)            | `now + 24h`                                           |
| **Suspension**       | Restate durable promise                    | Restate durable promise                    | None (EventBus)                                       |
| **Idempotency**      | None (each step creates one)               | None (each step creates one)               | Yes (checks existing active task)                     |
| **Error handling**   | `log.warn` (non-fatal)                     | `log.error` (non-fatal)                    | `try/catch` with `log.error`                          |

---

## Task Lifecycle: Create, Assign/Claim, Resolve

This section traces the full end-to-end lifecycle of a task through all status transitions, focusing on scenarios with multiple approvers and how `/resolve` triggers workflow resumption.

### Lifecycle State Machine

```
                          ┌──────────────────────┐
                          │      CREATION         │
                          │  (workflow-handler or  │
                          │   escalation-bridge)   │
                          └──────────┬─────────────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │   pending    │ ← initial status for all tasks
                              └──┬──────┬───┘
                                 │      │
                    POST /assign │      │ POST /claim
                                 │      │
                                 ▼      ▼
                          ┌──────────┐ ┌─────────────┐
                          │ assigned │ │ in_progress  │
                          └────┬─────┘ └──────┬───────┘
                               │              │
                  POST /claim  │              │
                               ▼              │
                        ┌─────────────┐       │
                        │ in_progress  │      │
                        └──────┬───────┘      │
                               │              │
                               ▼              ▼
                      ┌──────────────────────────┐
                      │     POST /resolve         │
                      │  1. Validate required fields │
                      │  2. Update status → completed │
                      │  3. Dispatch to upstream      │
                      └──────────┬────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
              ▼                  ▼                   ▼
    ┌─────────────────┐ ┌───────────────┐ ┌──────────────────┐
    │ resolveApproval │ │resolveHumanTask│ │resolveEscalation │
    │ (workflow_approval)│ (workflow_human_task)│ (agent_escalation)│
    └────────┬────────┘ └───────┬───────┘ └────────┬─────────┘
             │                  │                   │
             ▼                  ▼                   ▼
    ┌─────────────────┐ ┌───────────────┐ ┌──────────────────┐
    │ Restate promise │ │ Restate promise│ │ Session flag     │
    │ sys:approval:X  │ │ sys:human_task:X│ │ cleared, response│
    │ resolved        │ │ resolved       │ │ injected         │
    └────────┬────────┘ └───────┬───────┘ └──────────────────┘
             │                  │
             ▼                  ▼
    ┌─────────────────────────────────┐
    │   Workflow execution RESUMES    │
    │   (next step begins)            │
    └─────────────────────────────────┘


    Other terminal states (not via /resolve):
    ──────────────────────────────────────────
    • expired   ← timeout fires (Restate timeout or SLA breach)
    • cancelled ← workflow cancelled via Restate cancel handler
```

**Valid status transitions:**

| From                                   | To            | Triggered By                       |
| -------------------------------------- | ------------- | ---------------------------------- |
| `pending`                              | `assigned`    | `POST /:taskId/assign`             |
| `pending`                              | `in_progress` | `POST /:taskId/claim`              |
| `assigned`                             | `assigned`    | `POST /:taskId/assign` (re-assign) |
| `assigned`                             | `in_progress` | `POST /:taskId/claim`              |
| `pending` / `assigned` / `in_progress` | `completed`   | `POST /:taskId/resolve`            |
| `pending` / `in_progress`              | `expired`     | Timeout (Restate or SLA)           |
| any active                             | `cancelled`   | Workflow cancellation              |

### Step 1: Task Creation (Multiple Approvers)

When a workflow approval step defines multiple approvers, the task is created as follows:

**Workflow step definition (example):**

```json
{
  "id": "step-deploy-approval",
  "type": "approval",
  "message": "Approve deployment to production for v2.1.0",
  "approvers": ["user-jane", "user-bob", "user-alice"],
  "timeout": 259200000
}
```

**What happens in `workflow-handler.ts` (lines 718-739):**

```
buildApprovalRequest(step, ctx)
  → resolves expressions in message and approvers
  → returns ApprovalRequest {
      approvers: ["user-jane", "user-bob", "user-alice"],
      message: "Approve deployment to production for v2.1.0",
      timeoutMs: 259200000
    }

humanTaskStore.createTask({
  tenantId: ctx.tenant.tenantId,
  projectId: ctx.tenant.projectId,
  type: 'approval',
  priority: 'medium',
  title: approvalReq.message,
  source: {
    type: 'workflow_approval',
    workflowId: input.workflowId,
    executionId,
    stepId: step.id,
  },
  assignedTo: approvalReq.approvers[0],   ← ONLY first approver
  fields: [],
  context: {
    workflowName: input.workflowName,
    approvers: approvalReq.approvers,      ← ALL approvers stored here
  },
  dueAt: new Date(Date.now() + approvalReq.timeoutMs),
})
```

**Key behavior with multiple approvers:**

| Aspect                 | Behavior                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assignedTo`           | Set to `approvers[0]` only (`"user-jane"`)                                                                                                                                  |
| `context.approvers`    | Stores the full list (`["user-jane", "user-bob", "user-alice"]`)                                                                                                            |
| Visibility             | Non-admin users only see tasks where they are `assignedTo`, `claimedBy`, or `createdBy` (GET `/` filter at line 87-89). So only `user-jane` sees it initially unless admin. |
| Any approver can claim | Any user with `human_task:claim` permission who can see the task can call `POST /claim`. Once re-assigned via `POST /assign`, other approvers can see it.                   |
| Single resolution      | Only **one** resolution is needed. The first person to resolve it wins. The task moves to `completed` and the Restate promise is resolved once.                             |

**Resulting `human_tasks` document:**

```json
{
  "_id": "019e1a2b-3c4d-7000-8000-abcdef123456",
  "tenantId": "tenant-001",
  "projectId": "proj-042",
  "type": "approval",
  "status": "pending",
  "priority": "medium",
  "title": "Approve deployment to production for v2.1.0",
  "source": {
    "type": "workflow_approval",
    "workflowId": "wf-deploy-pipeline",
    "executionId": "exec-789",
    "stepId": "step-deploy-approval"
  },
  "assignedTo": "user-jane",
  "claimedBy": null,
  "fields": [],
  "context": {
    "workflowName": "Deploy Pipeline",
    "approvers": ["user-jane", "user-bob", "user-alice"]
  },
  "response": null,
  "dueAt": "2026-04-12T10:00:00.000Z",
  "escalationChain": [],
  "currentEscalationLevel": 0,
  "createdAt": "2026-04-09T10:00:00.000Z",
  "updatedAt": "2026-04-09T10:00:00.000Z"
}
```

**Meanwhile, the workflow is SUSPENDED:**

```
restateCtx.promise<ApprovalDecision>('sys:approval:step-deploy-approval').get()
  ← blocks here until resolveApproval is called or timeout fires
```

### Step 2: Assign or Claim (Self-Assignment)

There are two ways a user can take ownership of a task:

#### Option A: `POST /:taskId/assign` — Assign to a specific user or team

**Permission required:** `human_task:assign` (ADMIN, OPERATOR)

**Request:**

```http
POST /api/projects/proj-042/human-tasks/019e1a2b-3c4d.../assign
Content-Type: application/json

{ "assignedTo": "user-bob" }
```

**What happens** (`human-tasks.ts` lines 150-190):

```javascript
// Only tasks in 'pending' or 'assigned' can be assigned
HumanTask.findOneAndUpdate(
  {
    _id: taskId,
    tenantId,
    projectId,
    status: { $in: ['pending', 'assigned'] }, // guard: can't assign completed/expired
  },
  {
    $set: {
      status: 'assigned', // pending → assigned, or assigned → assigned (re-assign)
      assignedTo: 'user-bob', // overwrites previous assignedTo
    },
  },
  { new: true },
);
```

**Document after assign:**

```json
{
  "status": "assigned",
  "assignedTo": "user-bob",
  "claimedBy": null
}
```

**Use case:** An admin or team lead reassigns from `user-jane` (the default first approver) to `user-bob` who is available.

#### Option B: `POST /:taskId/claim` — Self-assign (claim for yourself)

**Permission required:** `human_task:claim` (ADMIN, OPERATOR, MEMBER)

**Request:**

```http
POST /api/projects/proj-042/human-tasks/019e1a2b-3c4d.../claim
```

No request body needed — the user identity comes from the authenticated context (`req.tenantContext.userId`).

**What happens** (`human-tasks.ts` lines 192-220):

```javascript
// userId is derived from auth context, NOT from request body
const userId = req.tenantContext.userId; // e.g., "user-bob"

HumanTask.findOneAndUpdate(
  {
    _id: taskId,
    tenantId,
    projectId,
    status: { $in: ['pending', 'assigned'] }, // guard: can't claim completed/in_progress
  },
  {
    $set: {
      status: 'in_progress', // pending → in_progress, or assigned → in_progress
      claimedBy: userId, // "user-bob" — always from auth, never from body
    },
  },
  { new: true },
);
```

**Document after claim:**

```json
{
  "status": "in_progress",
  "assignedTo": "user-jane",
  "claimedBy": "user-bob"
}
```

**Key points:**

- `assignedTo` is **not changed** — it still shows the original assignee for audit purposes
- `claimedBy` is the user who is actively working on it
- Status jumps directly to `in_progress` (not `assigned`)
- The `claimedBy` user now sees this task in their filtered list (`$or: [{ claimedBy: userId }]`)

#### Assign vs Claim Comparison

| Aspect                    | `POST /assign`                                      | `POST /claim`                                |
| ------------------------- | --------------------------------------------------- | -------------------------------------------- |
| **Permission**            | `human_task:assign` (ADMIN, OPERATOR)               | `human_task:claim` (ADMIN, OPERATOR, MEMBER) |
| **Who can do it**         | Anyone with assign permission (on behalf of others) | Only the authenticated user (for themselves) |
| **Request body**          | `{ assignedTo }` or `{ assignedToTeam }` required   | No body — uses auth context                  |
| **Status transition**     | → `assigned`                                        | → `in_progress`                              |
| **Field updated**         | `assignedTo` or `assignedToTeam`                    | `claimedBy`                                  |
| **Overwrites assignedTo** | Yes                                                 | No (preserves original)                      |
| **Allowed from statuses** | `pending`, `assigned`                               | `pending`, `assigned`                        |
| **Typical use**           | Admin reassigns to available team member            | User picks up a task from the queue          |

### Step 3: Resolve (Triggers Workflow Resume)

This is the critical step — `/resolve` both completes the inbox task AND resumes the suspended workflow.

**Permission required:** `human_task:resolve` (ADMIN, OPERATOR, MEMBER)

**Request (approval example):**

```http
POST /api/projects/proj-042/human-tasks/019e1a2b-3c4d.../resolve
Content-Type: application/json

{
  "decision": "approved",
  "notes": "Looks good, deployment approved for production"
}
```

**What happens** (`human-tasks.ts` lines 222-313) — three sequential phases:

#### Phase 1: Load and Validate

```javascript
// 1a. Load task — only active tasks can be resolved
const task = await HumanTask.findOne({
  _id: taskId,
  tenantId,
  projectId,
  status: { $in: ['pending', 'assigned', 'in_progress'] }, // guard: can't resolve completed/expired
});
// Returns 404 if not found or already resolved

// 1b. Validate required fields (for human_task types with form schemas)
const missingFields = task.fields
  .filter((f) => f.required && (fields == null || fields[f.name] == null))
  .map((f) => f.name);
// Returns 400 with "Missing required fields: ..." if any required field is empty
```

#### Phase 2: Update Task to Completed

```javascript
// Build response object
const response = {
  respondedBy, // from req.tenantContext.userId (auth context)
  respondedAt: new Date(),
  fields: fields ?? {}, // form field values (empty for approvals)
  notes, // free-text notes
  decision, // 'approved'/'rejected' for approvals, or custom for decisions
};

// Atomically update to completed
await HumanTask.findOneAndUpdate(
  { _id: taskId, tenantId },
  { $set: { status: 'completed', response } },
);
```

**Document after resolve:**

```json
{
  "status": "completed",
  "assignedTo": "user-jane",
  "claimedBy": "user-bob",
  "response": {
    "respondedBy": "user-bob",
    "respondedAt": "2026-04-09T14:30:00.000Z",
    "fields": {},
    "notes": "Looks good, deployment approved for production",
    "decision": "approved"
  }
}
```

#### Phase 3: Dispatch to Upstream Source (Resume Workflow)

Based on `task.source.type`, the runtime routes to the appropriate handler:

**For `workflow_approval`:**

```
runtime /resolve handler
  │
  │ deps.resolveApproval(source.executionId, source.stepId, {
  │   approved: decision === 'approved',   // boolean from string comparison
  │   decidedBy: respondedBy,              // "user-bob"
  │   reason: notes                        // "Looks good, deployment approved..."
  │ })
  │
  ▼
runtime server.ts (lines 522-538) — HTTP proxy:
  │
  │ POST ${workflowEngineBaseUrl}/api/v1/projects/_/approvals/_/
  │       executions/${executionId}/steps/${stepId}/approve
  │ Body: { decision: 'approve', reason: '...' }
  │
  ▼
workflow-approvals.ts route handler:
  │ 1. Validates execution exists (tenant + project scoped)
  │ 2. Checks step.status === 'waiting_approval'
  │ 3. Calls restateClient.resolveApproval(executionId, stepId, decision)
  │ 4. Updates step metadata in MongoDB:
  │      steps.$.approvalDecision = 'approve'
  │      steps.$.approvalDecidedBy = 'user-bob'
  │      steps.$.approvalDecidedAt = new Date()
  │      steps.$.approvalReason = '...'
  │
  ▼
restate-client.ts (lines 134-159):
  │
  │ POST ${restateIngressUrl}/workflow-runner/${executionId}/resolveApproval
  │ Body: { executionId, stepId, decision: { approved: true, decidedBy, reason } }
  │
  ▼
restate-endpoint.ts resolveApproval shared handler (line 145):
  │
  │ ctx.promise('sys:approval:step-deploy-approval').resolve(decision)
  │
  ▼
workflow-handler.ts — the suspended .get() UNBLOCKS:
  │
  │ const decision = await restateCtx.promise('sys:approval:step-deploy-approval').get()
  │ // decision = { approved: true, decidedBy: 'user-bob', reason: '...' }
  │
  ▼
Workflow continues to next step
```

**For `workflow_human_task`:**

```
runtime /resolve handler
  │
  │ deps.resolveHumanTask(source.executionId, source.stepId, {
  │   respondedBy,
  │   fields: fields ?? {},    // form data from the dynamic form
  │   notes,
  │   decision
  │ })
  │
  ▼
runtime server.ts (lines 539-552) — HTTP proxy:
  │
  │ POST ${workflowEngineBaseUrl}/api/v1/projects/_/human-tasks/
  │       executions/${executionId}/steps/${stepId}/resolve
  │ Body: { respondedBy, fields, notes, decision }
  │
  ▼
human-task-resolution.ts route handler:
  │ 1. Derives respondedBy from auth context (ignores body.respondedBy)
  │ 2. Validates execution exists (tenant + project scoped)
  │ 3. Checks step.status === 'waiting_human_task'
  │ 4. Calls restateClient.resolveHumanTask(executionId, stepId, response)
  │
  ▼
restate-client.ts (lines 165-202):
  │
  │ POST ${restateIngressUrl}/workflow-runner/${executionId}/resolveHumanTask
  │ Body: { executionId, stepId, response: { respondedBy, fields, notes, decision } }
  │
  ▼
restate-endpoint.ts resolveHumanTask shared handler (line 164):
  │
  │ ctx.promise('sys:human_task:step-shipping-details').resolve(response)
  │
  ▼
workflow-handler.ts — the suspended .get() UNBLOCKS:
  │
  │ const response = await restateCtx.promise('sys:human_task:step-shipping-details').get()
  │ // response = { respondedBy: '...', fields: { address: '...', ... }, notes, decision }
  │
  ▼
Workflow continues to next step
```

**For `agent_escalation`:**

```
runtime /resolve handler
  │
  │ deps.resolveEscalation(source.sessionId, {
  │   respondedBy,
  │   message: notes ?? decision ?? 'Resolved via inbox'
  │ })
  │
  ▼
runtime server.ts (lines 553-555):
  │
  │ getRuntimeExecutor().resolveEscalation(sessionId, data)
  │
  ▼
runtime-executor.ts:
  │ 1. Clears escalation flag on the session
  │ 2. Injects human response into conversation history
  │
  ▼
Session resumes normal agent operation (no Restate involved)
```

**Important: Error handling on upstream dispatch**

```javascript
// From human-tasks.ts lines 297-305
} catch (upstreamErr) {
  log.error('Failed to resolve upstream source', {
    taskId,
    sourceType: source.type,
    error: msg,
  });
  // Task is already marked complete — log but don't fail the response
}
```

The task is marked `completed` in MongoDB **before** the upstream dispatch. If the Restate call fails, the task is still `completed` but the workflow remains suspended. This is a fire-and-forget pattern — the task status and the workflow state can become inconsistent if the upstream call fails.

### Complete Lifecycle Example: Approval with Multiple Approvers

```
Timeline: Workflow execution with 3 approvers
──────────────────────────────────────────────

T0: Workflow hits approval step
    ├── buildApprovalRequest() → { approvers: [jane, bob, alice], message: "Approve deploy" }
    ├── updateStepStatus(executionId, stepId, 'waiting_approval')
    ├── humanTaskStore.createTask({
    │     type: 'approval', assignedTo: 'user-jane',       ← only first approver
    │     context: { approvers: ['jane', 'bob', 'alice'] }  ← all stored here
    │   })
    └── restateCtx.promise('sys:approval:step-1').get()     ← SUSPENDED

    human_tasks document:
    { status: 'pending', assignedTo: 'user-jane', claimedBy: null }

T1: user-jane sees task in her inbox (she is assignedTo)
    user-bob and user-alice do NOT see it (non-admin filter)
    Admin users see ALL tasks regardless

T2: Admin reassigns to user-bob (jane is unavailable)
    POST /human-tasks/{taskId}/assign { "assignedTo": "user-bob" }
    ├── status: 'pending' → 'assigned'
    └── assignedTo: 'user-jane' → 'user-bob'

    human_tasks document:
    { status: 'assigned', assignedTo: 'user-bob', claimedBy: null }

T3: user-bob claims the task (self-assignment)
    POST /human-tasks/{taskId}/claim
    ├── status: 'assigned' → 'in_progress'
    └── claimedBy: 'user-bob'  (assignedTo unchanged)

    human_tasks document:
    { status: 'in_progress', assignedTo: 'user-bob', claimedBy: 'user-bob' }

T4: user-bob resolves (approves)
    POST /human-tasks/{taskId}/resolve { "decision": "approved", "notes": "LGTM" }
    │
    ├── Phase 1: Load task, validate (no required fields for approvals)
    │
    ├── Phase 2: Update MongoDB
    │   { status: 'completed', response: { respondedBy: 'user-bob', decision: 'approved', ... } }
    │
    └── Phase 3: Dispatch upstream
        ├── runtime detects source.type === 'workflow_approval'
        ├── HTTP proxy → workflow-engine /approve
        ├── workflow-engine → restateClient.resolveApproval()
        ├── Restate → ctx.promise('sys:approval:step-1').resolve({ approved: true, ... })
        └── workflow-handler.ts → promise unblocks → WORKFLOW RESUMES
```

### Complete Lifecycle Example: Human Task (Data Entry)

```
Timeline: Workflow execution with data entry form
──────────────────────────────────────────────────

T0: Workflow hits human_task step
    ├── buildHumanTaskRequest() → {
    │     taskType: 'data_entry',
    │     title: 'Enter shipping details for order #4521',
    │     fields: [
    │       { name: 'address', type: 'textarea', required: true },
    │       { name: 'shipping_method', type: 'select', required: true,
    │         options: ['standard', 'express', 'overnight'] },
    │       { name: 'notes', type: 'text', required: false }
    │     ],
    │     assignTo: ['user-warehouse']
    │   }
    ├── humanTaskStore.createTask({ type: 'data_entry', fields: [...], ... })
    └── restateCtx.promise('sys:human_task:step-2').get()  ← SUSPENDED

    human_tasks document:
    { status: 'pending', type: 'data_entry', assignedTo: 'user-warehouse',
      fields: [{ name: 'address', required: true }, ...] }

T1: user-warehouse sees task → claims it
    POST /human-tasks/{taskId}/claim
    { status: 'in_progress', claimedBy: 'user-warehouse' }

T2: user-warehouse submits the form
    POST /human-tasks/{taskId}/resolve
    {
      "fields": {
        "address": "123 Main St, Springfield, IL 62701",
        "shipping_method": "express",
        "notes": "Gate code: 4421"
      }
    }
    │
    ├── Phase 1: Validate required fields
    │   ✓ address: provided
    │   ✓ shipping_method: provided
    │   ✓ notes: not required, OK if missing
    │
    ├── Phase 2: Update MongoDB
    │   {
    │     status: 'completed',
    │     response: {
    │       respondedBy: 'user-warehouse',
    │       respondedAt: '2026-04-09T14:30:00.000Z',
    │       fields: { address: '123 Main St...', shipping_method: 'express', notes: 'Gate code: 4421' }
    │     }
    │   }
    │
    └── Phase 3: Dispatch upstream
        ├── runtime detects source.type === 'workflow_human_task'
        ├── HTTP proxy → workflow-engine /resolve
        │   (respondedBy enforced from auth context, not body)
        ├── workflow-engine → restateClient.resolveHumanTask()
        ├── Restate → ctx.promise('sys:human_task:step-2').resolve(response)
        └── workflow-handler.ts → promise unblocks → WORKFLOW RESUMES
            │
            └── response.fields available in workflow context:
                ctx.steps['step-2'].output.fields.address = "123 Main St..."
                ctx.steps['step-2'].output.fields.shipping_method = "express"
```

---

## Resolution Flow

### Workflow Approval Resolution (`/approve`)

```
User clicks Approve/Reject in Inbox UI
  |
  v
POST /api/projects/:projectId/human-tasks/:taskId/resolve
  (runtime route, body: { decision: 'approve'|'reject', notes? })
  |
  v
Runtime detects source.type === 'workflow_approval'
  |
  v
Proxies to workflow-engine:
  POST /api/v1/projects/_/approvals/_/executions/{executionId}/steps/{stepId}/approve
  (body: { decision: 'approve'|'reject', reason? })
  |
  v
workflow-approvals.ts route handler:
  1. Validates execution exists with tenant+project scoping
  2. Checks step.status === 'waiting_approval'
  3. Calls restateClient.resolveApproval(executionId, stepId, { approved, decidedBy, reason })
  4. Updates step metadata in MongoDB (approvalDecision, approvalDecidedBy, approvalDecidedAt)
  |
  v
Restate resolveApproval shared handler:
  ctx.promise('sys:approval:{stepId}').resolve(decision)
  |
  v
Workflow run handler unblocks, receives ApprovalDecision:
  { approved: boolean, decidedBy: string, reason?: string, decidedAt: string }
```

**Timeout behavior:** If no response within `timeoutMs`, `buildTimeoutDecision()` fires based on `onTimeout`:

- `'approve'` -- auto-approves
- `'reject'` -- auto-rejects (default)
- `'escalate'` -- escalates (not yet implemented)

### Workflow Human Task Resolution (`/resolve`)

```
User fills form / makes decision in Inbox UI
  |
  v
POST /api/projects/:projectId/human-tasks/:taskId/resolve
  (runtime route, body: { fields: {...}, notes?, decision? })
  |
  v
Runtime detects source.type === 'workflow_human_task'
  |
  v
Proxies to workflow-engine:
  POST /api/v1/projects/_/human-tasks/executions/{executionId}/steps/{stepId}/resolve
  (body: { fields, notes?, decision? })
  |
  v
human-task-resolution.ts route handler:
  1. Derives respondedBy from authenticated context (ignores client-supplied value)
  2. Validates execution exists with tenant+project scoping
  3. Checks step.status === 'waiting_human_task'
  4. Calls restateClient.resolveHumanTask(executionId, stepId, { respondedBy, fields, notes, decision })
  |
  v
Restate resolveHumanTask shared handler:
  ctx.promise('sys:human_task:{stepId}').resolve(response)
  |
  v
Workflow run handler unblocks, receives HumanTaskResponse:
  { respondedBy: string, respondedAt: string, fields: Record<string, unknown>, notes?: string, decision?: string }
```

**Timeout behavior:** If no response within `timeoutMs`, `buildTimeoutResponse()` fires based on `onTimeout`:

- `'expire'` -- marks task as expired (default)
- `'escalate'` -- escalates
- `'auto_complete'` -- auto-completes with system response

**Security:** `respondedBy` is always derived from the authenticated user context, not the request body. If the client provides a different `respondedBy`, it is logged as a warning and ignored.

### Agent Escalation Resolution

```
User writes resolution notes in Inbox UI (EscalationPanel)
  |
  v
POST /api/projects/:projectId/human-tasks/:taskId/resolve
  (runtime route, body: { fields: {}, notes: '...' })
  |
  v
Runtime detects source.type === 'agent_escalation'
  |
  v
Calls runtimeExecutor.resolveEscalation(sessionId, response)
  1. Clears escalation flag on the session
  2. Injects human response into the conversation history
  |
  v
Session resumes normal agent operation
```

### Resolution Comparison Table

| Aspect                     | `/approve`                                 | `/resolve`                                 | Escalation                      |
| -------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------- |
| **Route**                  | `workflow-approvals.ts`                    | `human-task-resolution.ts`                 | `runtime-executor.ts`           |
| **Step status expected**   | `waiting_approval`                         | `waiting_human_task`                       | N/A (no Restate)                |
| **Restate promise key**    | `sys:approval:{stepId}`                    | `sys:human_task:{stepId}`                  | N/A                             |
| **Response shape**         | `{ approved, decidedBy, reason }`          | `{ respondedBy, fields, notes, decision }` | `{ notes }`                     |
| **Identity enforcement**   | Trusts `req.tenantContext.userId`          | Enforced from auth context (ignores body)  | From auth context               |
| **MongoDB update**         | Writes approval metadata to execution step | Does not update step directly              | Clears session escalation flag  |
| **Default timeout action** | `reject`                                   | `expire`                                   | N/A (24h dueAt, no auto-action) |

---

## API Routes

### Unified Human Tasks API (Runtime)

**Base:** `POST /api/projects/:projectId/human-tasks`
**Mounted in:** `apps/runtime/src/server.ts` line 520

| Method | Path               | Permission           | Description                                                                                                                                                       |
| ------ | ------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                | `human_task:read`    | List tasks with filters (`status`, `type`, `assignedTo`, `priority`, `limit`, `offset`). Returns `countsByType` aggregation. Non-admin users scoped to own tasks. |
| `GET`  | `/:taskId`         | `human_task:read`    | Get single task detail                                                                                                                                            |
| `POST` | `/:taskId/assign`  | `human_task:assign`  | Assign to user or team                                                                                                                                            |
| `POST` | `/:taskId/claim`   | `human_task:claim`   | Claim task (sets `claimedBy`)                                                                                                                                     |
| `POST` | `/:taskId/resolve` | `human_task:resolve` | Submit response, validate required fields, update status to `completed`, dispatch to upstream source                                                              |

### Workflow Approvals API (Workflow Engine, Legacy)

**Base:** `/api/projects/:projectId/approvals`
**Mounted in:** `apps/workflow-engine/`

| Method | Path                                                         | Description                                                                                         |
| ------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `GET`  | `/`                                                          | List pending approvals by querying `WorkflowExecution` docs with `steps.status: 'waiting_approval'` |
| `POST` | `/:workflowId/executions/:executionId/steps/:stepId/approve` | Approve or reject. Body: `{ decision: 'approve'\|'reject', reason? }`                               |

### Human Task Resolution API (Workflow Engine)

**Base:** `/api/projects/:projectId/human-tasks`
**Mounted in:** `apps/workflow-engine/`

| Method | Path                                             | Description                                                 |
| ------ | ------------------------------------------------ | ----------------------------------------------------------- |
| `POST` | `/executions/:executionId/steps/:stepId/resolve` | Resolve a human task. Body: `{ fields, notes?, decision? }` |

---

## Frontend Components

| Component            | File                                                    | Purpose                                                                                                                      |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `UnifiedInboxPage`   | `apps/studio/src/components/inbox/UnifiedInboxPage.tsx` | Main inbox page with filter tabs (All, Approvals, Data Entry, Reviews, Decisions, Escalations) and counts. 5-second polling. |
| `TaskCard`           | `apps/studio/src/components/inbox/TaskCard.tsx`         | Expandable card with type-specific action panels                                                                             |
| `DynamicForm`        | `apps/studio/src/components/inbox/DynamicForm.tsx`      | Renders fields from `HumanTaskFieldDef[]` (text, number, boolean, select, textarea, date)                                    |
| `EscalationPanel`    | `apps/studio/src/components/inbox/EscalationPanel.tsx`  | Shows escalation reason, agent name, resolution textarea                                                                     |
| `InboxPage` (legacy) | `apps/studio/src/components/workflows/InboxPage.tsx`    | Older approval-only queue (10-second polling)                                                                                |
| `useHumanTasks`      | `apps/studio/src/hooks/useHumanTasks.ts`                | SWR hook, 5s polling, filters by status/type/assignedTo                                                                      |
| `useApprovals`       | `apps/studio/src/hooks/useApprovals.ts`                 | SWR hook, 10s polling, legacy approval endpoint                                                                              |

### TaskCard: Type-Specific UI Wireframes

Every task card has a **common header** (collapsed view) and a **type-specific action panel** (expanded view).

#### Common Header (all types)

```
┌──────────────────────────────────────────────────────────────────┐
│ task.title                                                       │
│ [Type badge] [Priority badge] [🕐 SLA countdown]                │
│ [👤 task.assignedTo]                                             │
│ "3h ago"                                        [▼ expand/collapse] │
└──────────────────────────────────────────────────────────────────┘
```

- **Title:** `task.title` (truncated, semibold)
- **Badges:** Type (Approval/Data Entry/Review/Decision/Escalation), Priority (Low/Medium/High/Critical), SLA countdown (e.g., "12h left", "Overdue", "SLA Breached")
- **Assignment:** Shows `task.assignedTo` with user icon
- **Timestamp:** Relative time since creation ("Just now", "3h ago", "2d ago")
- **Completed tasks:** Greyed out (opacity 60%), non-expandable, shows status badge instead of chevron

#### Type 1: Approval (`task.type === 'approval'`)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "Approve deployment to production for v2.1.0"]          │
│ [Approval] [Medium] [🕐 48h left] [👤 user-jane]                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ task.description (if present)                                    │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Optional notes...                                  (textarea)│ │
│ │                                              2 rows, optional│ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [✓ Approve]  [✗ Reject]                                         │
│  (primary)    (secondary)                                        │
└──────────────────────────────────────────────────────────────────┘
```

**UI Elements:**

1. `task.description` — optional descriptive text (if set on the task)
2. **Notes textarea** — 2 rows, placeholder "Optional notes...", maps to `decisionNotes` state
3. **Approve button** — primary variant, `CheckCircle` icon
4. **Reject button** — secondary variant, `XCircle` icon

**Handler:** `handleApproval(approved: boolean)` (TaskCard.tsx line 130)

```typescript
handleResolve({
  decision: approved ? 'approved' : 'rejected',
  notes: decisionNotes || undefined,
});
```

**Resolve payload sent to `POST /human-tasks/:taskId/resolve`:**

```json
{
  "decision": "approved",
  "notes": "Looks good, deployment approved for production",
  "fields": {}
}
```

**Key points:**

- `fields` is always `{}` (no form schema for approvals, `task.fields` is `[]`)
- `decision` is a **string** (`"approved"` / `"rejected"`), not a boolean
- Notes are optional — the user can approve/reject without writing anything
- The `title` serves as the approval message (set from `ApprovalStep.message`)

#### Type 2: Data Entry (`task.type === 'data_entry'`)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "Enter shipping details for order #4521"]               │
│ [Data Entry] [High] [🕐 24h left] [👤 user-warehouse]           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ task.description (if present)                                    │
│                                                                  │
│ Delivery Address *                                               │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Enter delivery address...                          (textarea)│ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ Shipping Method *                                                │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Select...                                   ▼       (select) │ │
│ │   ├── standard                                               │ │
│ │   ├── express                                                │ │
│ │   └── overnight                                              │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ Special Instructions                                             │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Enter special instructions...                        (text)  │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [Submit Data]                                                    │
│  (full-width, accent)                                            │
└──────────────────────────────────────────────────────────────────┘
```

**UI Elements:** Rendered by `DynamicForm` component from `task.fields[]`. Each field renders based on its `type`:

| Field `type` | HTML Element               | Notes                           |
| ------------ | -------------------------- | ------------------------------- |
| `text`       | `<input type="text">`      | Single-line text input          |
| `number`     | `<input type="number">`    | Numeric input                   |
| `boolean`    | `<Toggle>`                 | On/off toggle switch            |
| `select`     | `<select>` with `<option>` | Dropdown from `field.options[]` |
| `textarea`   | `<textarea rows={3}>`      | Multi-line text, non-resizable  |
| `date`       | `<input type="date">`      | Date picker                     |

**Validation:**

- Required fields show red asterisk (`*`) after label
- On submit, `DynamicForm` validates required fields client-side (line 59-70)
- Error message shown below field: `"{label} is required"`
- Server also validates required fields in `POST /resolve` handler (line 251-259)

**Handler:** `handleFormSubmit(values)` (TaskCard.tsx line 140)

```typescript
handleResolve({ fields: values });
```

**Resolve payload:**

```json
{
  "fields": {
    "address": "123 Main St, Springfield, IL 62701",
    "shipping_method": "express",
    "special_instructions": "Gate code: 4421"
  }
}
```

**Key points:**

- No `decision` or `notes` — only form field values
- Field names in the response match `field.name` from the schema
- Default values from `field.defaultValue` are pre-populated
- Boolean fields default to `false`

#### Type 3: Review (`task.type === 'review'`)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "Review data quality for batch import #78"]             │
│ [Review] [Medium] [🕐 36h left] [👤 user-qa-lead]               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ task.description (if present)                                    │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Context                                                      │ │
│ │ {                                                            │ │
│ │   "workflowName": "Data Import Pipeline",                   │ │
│ │   "variables": {                                             │ │
│ │     "batchId": "78",                                         │ │
│ │     "recordCount": 1523                                      │ │
│ │   }                                                          │ │
│ │ }                                                            │ │
│ │                                  (scrollable, max-h-32)      │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Review notes...                                    (textarea)│ │
│ │                                              3 rows, optional│ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [✓ Approve]  [✗ Reject]                                         │
│  (primary)    (secondary)                                        │
└──────────────────────────────────────────────────────────────────┘
```

**UI Elements:**

1. **Context panel** — displays `task.context` as formatted JSON in a scrollable `<pre>` block (max-height 128px). Only shown if `task.context` has keys.
2. **Notes textarea** — 3 rows, placeholder "Review notes..."
3. **Approve / Reject buttons** — same as approval type

**Handler:** Same `handleApproval(approved)` as approval type (TaskCard.tsx line 130)

**Resolve payload:**

```json
{
  "decision": "approved",
  "notes": "Data quality looks good, 1523 records validated"
}
```

**Key difference from Approval:** Review shows the `task.context` JSON so the reviewer can inspect workflow variables, batch data, or other contextual information before making a decision. The textarea has 3 rows (vs 2 for approval) since reviews typically require more detailed notes.

#### Type 4: Decision (`task.type === 'decision'`)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "Select deployment environment for v2.1.0"]             │
│ [Decision] [High] [🕐 12h left] [👤 user-devops]                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ task.description (if present)                                    │
│                                                                  │
│ Environment                                                      │
│   ○ staging                                                      │
│   ○ production                                                   │
│   ○ canary                                                       │
│                                           (RadioGroup component) │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Decision notes...                                  (textarea)│ │
│ │                                              2 rows, optional│ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [Submit Decision]                                                │
│  (disabled until a radio option is selected)                     │
└──────────────────────────────────────────────────────────────────┘
```

**UI Elements:**

1. **RadioGroup** — rendered from the **first** `select`-type field in `task.fields[]` (line 309-321: `.filter(f => f.type === 'select' && f.options).slice(0, 1)`). Each `field.options` value becomes a radio option.
2. **Notes textarea** — 2 rows, placeholder "Decision notes..."
3. **Submit Decision button** — disabled until `selectedDecision` is non-empty

**Handler:** `handleDecisionSubmit()` (TaskCard.tsx line 147)

```typescript
handleResolve({
  decision: selectedDecision, // the selected radio value, e.g., "production"
  notes: decisionNotes || undefined,
});
```

**Resolve payload:**

```json
{
  "decision": "production",
  "notes": "Canary passed all checks, promoting to production"
}
```

**Key points:**

- Only the **first** `select` field is rendered as radio buttons — additional fields are ignored in the decision UI
- The selected radio value goes to `decision`, not to `fields`
- Button is disabled until a selection is made (guard at line 339: `disabled={!selectedDecision}`)

#### Type 5: Escalation (`task.type === 'escalation'`)

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "Agent escalation: Customer requesting refund"]         │
│ [Escalation] [High] [🕐 18h left] [👤 customer-success team]    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ task.description (if present)                                    │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Escalation Reason                                            │ │
│ │ Customer requesting refund for damaged item                  │ │
│ │                                                              │ │
│ │ Agent: order-support                                         │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Enter your response to resolve this escalation...  (textarea)│ │
│ │                                                    4 rows    │ │
│ │                                                    REQUIRED  │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [Resolve Escalation]                                             │
│  (disabled until notes are non-empty)                            │
└──────────────────────────────────────────────────────────────────┘
```

**UI Elements (rendered by `EscalationPanel` component):**

1. **Escalation reason panel** — shows `task.context.escalationReason` (falls back to `task.description`, then "No reason provided"). Shows `task.context.agentName` if present.
2. **Resolution textarea** — 4 rows, placeholder "Enter your response to resolve this escalation...". **Required** — button is disabled when empty.
3. **Resolve Escalation button** — disabled until `notes.trim()` is non-empty (guard at line 27 and line 62)

**Handler:** `handleEscalationResolve(notes)` (TaskCard.tsx line 152)

```typescript
handleResolve({ notes, decision: 'resolved' });
```

**Resolve payload:**

```json
{
  "decision": "resolved",
  "notes": "Issued full refund of $89.99 to customer's original payment method. Replacement item shipped via express."
}
```

**Key points:**

- Notes are **required** for escalation (unlike optional for approval/review/decision)
- `decision` is always `"resolved"` (hardcoded in handler)
- The response text is what gets injected into the agent session's conversation history (via `runtimeExecutor.resolveEscalation()`)

### Task Type UI Summary

| Type         | UI Elements                                               | `decision` value                            | `notes`                         | `fields`                          | Resolve Action                   |
| ------------ | --------------------------------------------------------- | ------------------------------------------- | ------------------------------- | --------------------------------- | -------------------------------- |
| `approval`   | Notes textarea + Approve/Reject buttons                   | `"approved"` or `"rejected"`                | Optional (textarea, 2 rows)     | `{}` (always empty)               | `handleApproval(bool)`           |
| `data_entry` | `DynamicForm` rendered from `task.fields[]`               | Not set                                     | Not set                         | Form values keyed by `field.name` | `handleFormSubmit(values)`       |
| `review`     | Context JSON display + Notes textarea + Approve/Reject    | `"approved"` or `"rejected"`                | Optional (textarea, 3 rows)     | `{}` (always empty)               | `handleApproval(bool)`           |
| `decision`   | RadioGroup (first select field) + Notes textarea + Submit | Selected radio value (e.g., `"production"`) | Optional (textarea, 2 rows)     | Not set                           | `handleDecisionSubmit()`         |
| `escalation` | Escalation reason panel + Notes textarea + Resolve        | `"resolved"` (hardcoded)                    | **Required** (textarea, 4 rows) | Not set                           | `handleEscalationResolve(notes)` |

---

## Data Flow Diagrams

### Task Creation Flow

```
APPROVAL STEP                           HUMAN TASK STEP                       AGENT ESCALATION
-------------                           ---------------                       ----------------
ApprovalStep def                        HumanTaskStep def                     session.escalation event
  |                                       |                                     |
  v                                       v                                     v
buildApprovalRequest()                  buildHumanTaskRequest()               escalation-bridge.ts handler
  | resolves: message, approvers          | resolves: title, desc, assignTo     | idempotency check
  v                                       v                                     v
ApprovalRequest                         HumanTaskRequest                      HumanTask.create({
  |                                       |                                     type: 'escalation',
  v                                       v                                     source: { type: 'agent_escalation' }
workflow-handler.ts                     workflow-handler.ts                   })
  | 1. updateStepStatus                   | 1. updateStepStatus                 |
  |    ('waiting_approval')               |    ('waiting_human_task')            v
  | 2. publish event                      | 2. humanTaskStore.createTask()     human_tasks collection
  | 3. humanTaskStore.createTask()        | 3. publish event                    |
  | 4. ctx.promise                        | 4. ctx.promise                      v
  |    ('sys:approval:X').get()           |    ('sys:human_task:X').get()      Inbox UI polls
  v                                       v                                   GET /human-tasks
MongoHumanTaskStore                     MongoHumanTaskStore
  |                                       |
  v                                       v
HumanTask.create()                      HumanTask.create()
  |                                       |
  v                                       v
human_tasks collection                  human_tasks collection
  |                                       |
  v                                       v
Inbox UI polls                          Inbox UI polls
GET /human-tasks                        GET /human-tasks
```

### Task Resolution Flow

```
Inbox UI (UnifiedInboxPage)
  |
  v
POST /api/projects/:projectId/human-tasks/:taskId/resolve
  |
  +-- source.type === 'workflow_approval'
  |     |
  |     v
  |   Proxy to workflow-engine /approve
  |     |
  |     v
  |   restateClient.resolveApproval()
  |     |
  |     v
  |   Restate: ctx.promise('sys:approval:{stepId}').resolve()
  |     |
  |     v
  |   Workflow continues with ApprovalDecision
  |
  +-- source.type === 'workflow_human_task'
  |     |
  |     v
  |   Proxy to workflow-engine /resolve
  |     |
  |     v
  |   restateClient.resolveHumanTask()
  |     |
  |     v
  |   Restate: ctx.promise('sys:human_task:{stepId}').resolve()
  |     |
  |     v
  |   Workflow continues with HumanTaskResponse
  |
  +-- source.type === 'agent_escalation'
        |
        v
      runtimeExecutor.resolveEscalation()
        |
        v
      Session escalation flag cleared, response injected into conversation
```

---

## Key File Paths

| Purpose                             | File                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Mongoose model + interfaces         | `packages/database/src/models/human-task.model.ts`                                       |
| Model barrel export                 | `packages/database/src/models/index.ts` (lines 258-267)                                  |
| Migration (collection + RBAC)       | `packages/database/src/migrations/scripts/20260307_010_create_human_tasks_collection.ts` |
| Persistence store                   | `apps/workflow-engine/src/persistence/human-task-store.ts`                               |
| Approval executor                   | `apps/workflow-engine/src/executors/approval-executor.ts`                                |
| Human task executor                 | `apps/workflow-engine/src/executors/human-task-executor.ts`                              |
| Workflow handler (creates tasks)    | `apps/workflow-engine/src/handlers/workflow-handler.ts`                                  |
| Restate endpoint (durable promises) | `apps/workflow-engine/src/services/restate-endpoint.ts`                                  |
| Restate client (resolve calls)      | `apps/workflow-engine/src/services/restate-client.ts`                                    |
| Escalation bridge                   | `apps/runtime/src/services/escalation-bridge.ts`                                         |
| Unified API routes                  | `apps/runtime/src/routes/human-tasks.ts`                                                 |
| Route wiring + proxy callbacks      | `apps/runtime/src/server.ts` (lines 516-557)                                             |
| Legacy approval routes              | `apps/workflow-engine/src/routes/workflow-approvals.ts`                                  |
| Human task resolution routes        | `apps/workflow-engine/src/routes/human-task-resolution.ts`                               |
| Frontend inbox page                 | `apps/studio/src/components/inbox/UnifiedInboxPage.tsx`                                  |
| Frontend task card                  | `apps/studio/src/components/inbox/TaskCard.tsx`                                          |
| Frontend dynamic form               | `apps/studio/src/components/inbox/DynamicForm.tsx`                                       |
| Frontend escalation panel           | `apps/studio/src/components/inbox/EscalationPanel.tsx`                                   |
| Frontend API client                 | `apps/studio/src/api/human-tasks.ts`                                                     |
| Frontend hooks                      | `apps/studio/src/hooks/useHumanTasks.ts`                                                 |
| Legacy inbox page                   | `apps/studio/src/components/workflows/InboxPage.tsx`                                     |
| Legacy hooks                        | `apps/studio/src/hooks/useApprovals.ts`                                                  |
| Navigation config                   | `apps/studio/src/config/navigation.ts` (line 103)                                        |
| Suspension link                     | `packages/execution/src/suspension.ts` (line 179)                                        |
| Tests                               | `apps/workflow-engine/src/__tests__/workflow-approvals.test.ts`                          |
