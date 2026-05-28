# Unified Trigger Type System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 3 parallel trigger type systems with a single unified `triggerType` enum (`webhook | cron | event | studio | agent`) and add webhook-specific `webhookMode` / `webhookDelivery` fields.

**Architecture:** Define shared constants in `packages/shared`, update Mongoose schemas in `packages/database`, then propagate to all consumers (workflow-engine, runtime, connectors, studio). Each task is one package boundary. Migration script remaps existing MongoDB documents.

**Tech Stack:** TypeScript, Zod, Mongoose, React (Studio UI)

**Design spec:** `docs/superpowers/specs/2026-04-14-unified-trigger-types-design.md`

---

## File Structure

**Modify:**

| File                                                                | Responsibility                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/shared/src/types/workflow-schemas.ts`                     | Add shared trigger constants + Zod schemas               |
| `packages/shared/src/types/index.ts`                                | Re-export new types                                      |
| `packages/database/src/models/workflow-execution.model.ts`          | Update enum + add webhook fields                         |
| `packages/database/src/models/trigger-registration.model.ts`        | `strategy` → `triggerType`, drop `polling`/`connector`   |
| `packages/database/src/models/index.ts`                             | Update re-exports (remove old `TRIGGER_TYPES`)           |
| `packages/connectors/src/triggers/types.ts`                         | Align `WorkflowTriggerInput` + `TriggerRegistration`     |
| `packages/connectors/src/types.ts`                                  | `ConnectorTrigger.strategy` → `.triggerType`             |
| `packages/connectors/src/triggers/trigger-engine.ts`                | Switch on new types                                      |
| `packages/connectors/src/triggers/webhook-handler.ts`               | `triggerType: 'event'`                                   |
| `packages/connectors/src/triggers/cron-scheduler.ts`                | `triggerType: 'cron'`                                    |
| `packages/connectors/src/triggers/polling-scheduler.ts`             | `triggerType: 'cron'`                                    |
| `packages/connectors/src/executor/workflow-tool-executor.ts`        | `triggerType: 'agent'`                                   |
| `apps/workflow-engine/src/services/trigger-engine.ts`               | Update type + webhook fields                             |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`            | `triggerType: 'cron'`                                    |
| `apps/workflow-engine/src/routes/triggers.ts`                       | Zod enum update                                          |
| `apps/workflow-engine/src/routes/workflow-executions.ts`            | Use shared types, default `studio`                       |
| `apps/runtime/src/routes/process-api.ts`                            | `webhook` + mode/delivery from query param               |
| `apps/runtime/src/services/workflow/workflow-tool-executor.ts`      | `triggerType: 'agent'`                                   |
| `apps/studio/src/api/workflows.ts`                                  | Typed trigger fields                                     |
| `apps/studio/src/hooks/useWorkflows.ts`                             | Fix trigger type derivation (`strategy` → `triggerType`) |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` | 3 registration types + webhook form                      |
| `apps/studio/src/components/workflows/WorkflowCard.tsx`             | 5-type trigger styles                                    |
| `apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx` | 3-type labels                                            |
| `packages/i18n/locales/en/studio.json`                              | Add/remove trigger keys                                  |

**Create:**

| File                                                                 | Responsibility           |
| -------------------------------------------------------------------- | ------------------------ |
| `packages/database/src/migrations/20260414-unified-trigger-types.ts` | MongoDB migration script |

---

### Task 1: Shared Constants & Zod Schemas (`packages/shared`)

**Files:**

- Modify: `packages/shared/src/types/workflow-schemas.ts:410-418`
- Modify: `packages/shared/src/types/index.ts:90-96`

- [ ] **Step 1: Add trigger type constants to workflow-schemas.ts**

Before the `WorkflowExecutionInputSchema` (line 410), add:

```ts
// ─── Trigger Type Constants ────────────────────────────────────────────
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];

/** Trigger types valid for registrations (not studio/agent) */
export const REGISTRATION_TRIGGER_TYPES = ['webhook', 'cron', 'event'] as const;
export type RegistrationTriggerType = (typeof REGISTRATION_TRIGGER_TYPES)[number];
```

- [ ] **Step 2: Update WorkflowExecutionInputSchema**

Replace the existing `WorkflowExecutionInputSchema` at line 412-418:

```ts
export const WorkflowExecutionInputSchema = z
  .object({
    workflowId: z.string().min(1),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    triggerType: z.enum(TRIGGER_TYPES).default('studio'),
    webhookMode: z.enum(WEBHOOK_MODES).optional(),
    webhookDelivery: z.enum(WEBHOOK_DELIVERIES).optional(),
    callbackUrl: z.string().url().optional(),
    accessToken: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.triggerType !== 'webhook') {
      if (data.webhookMode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'webhookMode is only valid when triggerType is webhook',
          path: ['webhookMode'],
        });
      }
      return;
    }
    if (!data.webhookMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookMode is required when triggerType is webhook',
        path: ['webhookMode'],
      });
      return;
    }
    if (data.webhookMode === 'sync' && data.webhookDelivery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookDelivery must be absent when webhookMode is sync',
        path: ['webhookDelivery'],
      });
    }
    if (data.webhookMode === 'async' && !data.webhookDelivery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'webhookDelivery is required when webhookMode is async',
        path: ['webhookDelivery'],
      });
    }
    if (data.webhookDelivery === 'push' && !data.callbackUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'callbackUrl is required when webhookDelivery is push',
        path: ['callbackUrl'],
      });
    }
  });
```

- [ ] **Step 3: Update re-exports in index.ts**

In `packages/shared/src/types/index.ts`, add to the workflow-schemas re-export block:

```ts
export {
  // ... existing exports ...
  TRIGGER_TYPES,
  type TriggerType,
  WEBHOOK_MODES,
  type WebhookMode,
  WEBHOOK_DELIVERIES,
  type WebhookDelivery,
  REGISTRATION_TRIGGER_TYPES,
  type RegistrationTriggerType,
  WorkflowExecutionInputSchema,
} from './workflow-schemas.js';
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter=@abl/shared`
Expected: Clean build, no errors.

- [ ] **Step 5: Run prettier and commit**

```bash
npx prettier --write packages/shared/src/types/workflow-schemas.ts packages/shared/src/types/index.ts
git add packages/shared/src/types/workflow-schemas.ts packages/shared/src/types/index.ts
git commit -m "[ABLP-2] feat(shared): add unified trigger type constants and Zod schemas"
```

---

### Task 2: Database Models (`packages/database`)

**Files:**

- Modify: `packages/database/src/models/workflow-execution.model.ts:27-28, 73-94, 143-181`
- Modify: `packages/database/src/models/trigger-registration.model.ts:15-40, 44-81`
- Modify: `packages/database/src/models/index.ts:288-298`

- [ ] **Step 1: Update workflow-execution.model.ts — imports and constants**

Replace lines 27-28:

```ts
// OLD:
export const TRIGGER_TYPES = ['manual', 'api', 'trigger', 'schedule'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

// NEW:
import {
  TRIGGER_TYPES,
  type TriggerType,
  WEBHOOK_MODES,
  type WebhookMode,
  WEBHOOK_DELIVERIES,
  type WebhookDelivery,
} from '@abl/shared';

export { TRIGGER_TYPES, type TriggerType };
```

- [ ] **Step 2: Update IWorkflowExecution interface**

Add webhook fields after `triggerType` (line 79):

```ts
export interface IWorkflowExecution {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  status: ExecutionStatus;
  triggerType: TriggerType;
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
  accessToken?: string;
  input: unknown;
  output?: unknown;
  nodeExecutions: INodeExecution[];
  context: Record<string, unknown>;
  restateWorkflowId?: string;
  startTime?: string;
  endTime?: string;
  startedAt: Date;
  completedAt?: Date;
  error?: { code: string; message: string };
  triggerMetadata?: Record<string, unknown>;
  durationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Update WorkflowExecutionSchema fields**

In the Mongoose schema (around line 155), update `triggerType` and add webhook fields after it:

```ts
    triggerType: {
      type: String,
      required: true,
      enum: [...TRIGGER_TYPES],
    },
    webhookMode: {
      type: String,
      enum: [...WEBHOOK_MODES],
    },
    webhookDelivery: {
      type: String,
      enum: [...WEBHOOK_DELIVERIES],
    },
    callbackUrl: { type: String },
    accessToken: { type: String },
```

- [ ] **Step 4: Update trigger-registration.model.ts — interface**

Replace the `ITriggerRegistration` interface (lines 15-40):

```ts
import {
  REGISTRATION_TRIGGER_TYPES,
  type RegistrationTriggerType,
  WEBHOOK_MODES,
  type WebhookMode,
  WEBHOOK_DELIVERIES,
  type WebhookDelivery,
} from '@abl/shared';

export interface ITriggerRegistration {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  connectorName?: string;
  triggerName: string;
  triggerType: RegistrationTriggerType;
  connectionId?: string;
  config: Record<string, unknown>;
  status: 'active' | 'paused' | 'error' | 'deleted';
  deletedAt?: Date;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
  authProfileId: string | null;
  pollingIntervalMs?: number;
  bullmqJobId?: string;
  cronExpression?: string;
  missedFirePolicy?: 'fire_once' | 'fire_all' | 'skip';
  lastFiredAt?: Date;
  lastErrorAt?: Date;
  consecutiveErrors: number;
  environment?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 5: Update trigger-registration.model.ts — Mongoose schema**

Replace the `strategy` field (line 52-55) with:

```ts
    triggerType: {
      type: String,
      enum: [...REGISTRATION_TRIGGER_TYPES],
      required: true,
    },
```

Add webhook fields after `webhookSecret`:

```ts
    webhookMode: { type: String, enum: [...WEBHOOK_MODES] },
    webhookDelivery: { type: String, enum: [...WEBHOOK_DELIVERIES] },
    callbackUrl: { type: String },
```

- [ ] **Step 6: Update database index.ts re-exports**

In `packages/database/src/models/index.ts` at lines 288-298, remove `TRIGGER_TYPES` and `TriggerType` from the workflow-execution re-export (they now come from `@abl/shared`):

```ts
export {
  WorkflowExecution,
  type IWorkflowExecution,
  type INodeExecution,
  type ExecutionStatus,
  type NodeExecutionStatus,
  EXECUTION_STATUSES,
  NODE_EXECUTION_STATUSES,
} from './workflow-execution.model.js';
```

Note: `TRIGGER_TYPES` and `TriggerType` are still re-exported from the model file itself for backward compat, but the canonical source is now `@abl/shared`.

- [ ] **Step 7: Build and verify**

Run: `pnpm build --filter=@agent-platform/database`
Expected: Clean build. Any consumer importing `TRIGGER_TYPES` from database still works.

- [ ] **Step 8: Run prettier and commit**

```bash
npx prettier --write packages/database/src/models/workflow-execution.model.ts packages/database/src/models/trigger-registration.model.ts packages/database/src/models/index.ts
git add packages/database/src/models/workflow-execution.model.ts packages/database/src/models/trigger-registration.model.ts packages/database/src/models/index.ts
git commit -m "[ABLP-2] feat(database): update trigger type enums and add webhook fields to models"
```

---

### Task 3: Connector Package Types (`packages/connectors`)

**Files:**

- Modify: `packages/connectors/src/triggers/types.ts:1-93`
- Modify: `packages/connectors/src/types.ts:108-120`

- [ ] **Step 1: Update connectors/triggers/types.ts**

Replace the full `TriggerRegistration` interface (lines 9-26):

```ts
import type {
  TriggerType,
  WebhookMode,
  WebhookDelivery,
  RegistrationTriggerType,
} from '@abl/shared';

/** Persisted trigger registration record */
export interface TriggerRegistration {
  _id: string;
  tenantId: string;
  projectId: string;
  workflowId: string;
  connectorName: string;
  triggerName: string;
  connectionId: string;
  triggerType: RegistrationTriggerType;
  status: 'active' | 'paused' | 'error';
  config: Record<string, unknown>;
  webhookSecret?: string;
  cronExpression?: string;
  pollingIntervalMs?: number;
  consecutiveErrors: number;
  lastFiredAt?: Date;
  lastErrorAt?: Date;
}
```

Replace the `WorkflowTriggerInput` interface (lines 58-66):

```ts
/** Input to start a workflow execution from a trigger */
export interface WorkflowTriggerInput {
  workflowId: string;
  workflowName?: string;
  tenantId: string;
  projectId: string;
  triggerType: TriggerType;
  webhookMode?: WebhookMode;
  webhookDelivery?: WebhookDelivery;
  callbackUrl?: string;
  triggerPayload: Record<string, unknown>;
  triggerMetadata: Record<string, unknown>;
}
```

- [ ] **Step 2: Update connectors/types.ts — ConnectorTrigger**

Replace `strategy` in `ConnectorTrigger` interface at line 112:

```ts
export interface ConnectorTrigger {
  name: string;
  displayName: string;
  description: string;
  triggerType: 'webhook' | 'cron' | 'event';
  props: ConnectorProperty[];
  sampleData?: unknown;
  onEnable(ctx: TriggerContext): Promise<void>;
  onDisable(ctx: TriggerContext): Promise<void>;
  run(ctx: TriggerRunContext): Promise<unknown[]>;
  verify?(ctx: WebhookVerifyContext): Promise<boolean>;
  pollingIntervalMs?: number;
}
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@agent-platform/connectors`
Expected: Build errors from consumers referencing `strategy` — those are fixed in Tasks 4-5.

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write packages/connectors/src/triggers/types.ts packages/connectors/src/types.ts
git add packages/connectors/src/triggers/types.ts packages/connectors/src/types.ts
git commit -m "[ABLP-2] refactor(connectors): align trigger types with unified enum"
```

---

### Task 4: Connector Trigger Implementations (`packages/connectors`)

**Files:**

- Modify: `packages/connectors/src/triggers/trigger-engine.ts:80-134, 139-142`
- Modify: `packages/connectors/src/triggers/webhook-handler.ts:262`
- Modify: `packages/connectors/src/triggers/cron-scheduler.ts:105`
- Modify: `packages/connectors/src/triggers/polling-scheduler.ts:127`
- Modify: `packages/connectors/src/executor/workflow-tool-executor.ts:92`

- [ ] **Step 1: Update connector trigger-engine.ts — registerTrigger**

In `registerTrigger` method (line 80-134), replace `trigger.strategy` references with `trigger.triggerType`:

```ts
  async registerTrigger(input: RegisterTriggerInput): Promise<{ triggerType: string }> {
    const trigger = this.deps.registry.getTrigger(input.connectorName, input.triggerName);
    if (!trigger) {
      throw new Error(`Unknown trigger: ${input.connectorName}/${input.triggerName}`);
    }

    const triggerType = trigger.triggerType;

    switch (triggerType) {
      case 'webhook':
        return { triggerType: 'webhook' };

      case 'cron':
        if (!input.cronExpression) {
          throw new Error('Cron triggers require a cronExpression');
        }
        await registerCronTrigger(
          {
            _id: input.registrationId,
            tenantId: input.tenantId,
            projectId: input.projectId,
            workflowId: input.workflowId,
            connectorName: input.connectorName,
            triggerName: input.triggerName,
            connectionId: input.connectionId,
            cronExpression: input.cronExpression,
          },
          this.cronDeps,
        );
        return { triggerType: 'cron' };

      case 'event':
        // Event triggers are passive push-based — no scheduled jobs needed.
        return { triggerType: 'event' };

      default: {
        const _exhaustive: never = triggerType;
        throw new Error(`Unknown trigger type: ${_exhaustive}`);
      }
    }
  }
```

- [ ] **Step 2: Update deregisterTrigger signature**

At line 139-142, change `strategy` parameter to `triggerType`:

```ts
  async deregisterTrigger(
    registrationId: string,
    triggerType: 'webhook' | 'cron' | 'event',
    config?: { pollingIntervalMs?: number; cronExpression?: string },
  ): Promise<void> {
    switch (triggerType) {
      case 'webhook':
        return;

      case 'cron':
        // ... existing cron cleanup code ...
        return;

      case 'event':
        // Event triggers are passive — nothing to clean up
        return;

      default: {
        const _exhaustive: never = triggerType;
        throw new Error(`Unknown trigger type: ${_exhaustive}`);
      }
    }
  }
```

- [ ] **Step 3: Update webhook-handler.ts**

At line 262, change:

```ts
// OLD:
triggerType: 'webhook',

// NEW:
triggerType: 'event' as const,
```

- [ ] **Step 4: Update cron-scheduler.ts**

At line 105, keep as-is (already `'cron'`):

```ts
triggerType: 'cron' as const,
```

- [ ] **Step 5: Update polling-scheduler.ts**

At line 127, change:

```ts
// OLD:
triggerType: 'polling',

// NEW:
triggerType: 'cron' as const,
```

- [ ] **Step 6: Update workflow-tool-executor.ts (connectors)**

At line 92, keep as-is (already `'agent'`):

```ts
triggerType: 'agent',
```

- [ ] **Step 7: Build and verify**

Run: `pnpm build --filter=@agent-platform/connectors`
Expected: Clean build.

- [ ] **Step 8: Run prettier and commit**

```bash
npx prettier --write packages/connectors/src/triggers/trigger-engine.ts packages/connectors/src/triggers/webhook-handler.ts packages/connectors/src/triggers/cron-scheduler.ts packages/connectors/src/triggers/polling-scheduler.ts packages/connectors/src/executor/workflow-tool-executor.ts
git add packages/connectors/src/triggers/trigger-engine.ts packages/connectors/src/triggers/webhook-handler.ts packages/connectors/src/triggers/cron-scheduler.ts packages/connectors/src/triggers/polling-scheduler.ts packages/connectors/src/executor/workflow-tool-executor.ts
git commit -m "[ABLP-2] refactor(connectors): use unified trigger types in trigger implementations"
```

---

### Task 5: Workflow Engine Services & Routes (`apps/workflow-engine`)

**Files:**

- Modify: `apps/workflow-engine/src/services/trigger-engine.ts:18-30, 404-419`
- Modify: `apps/workflow-engine/src/services/trigger-scheduler.ts:221`
- Modify: `apps/workflow-engine/src/routes/triggers.ts:43-48`
- Modify: `apps/workflow-engine/src/routes/workflow-executions.ts:79`

- [ ] **Step 1: Update workflow-engine trigger-engine.ts — TriggerRegistration interface**

Replace the `TriggerRegistration` interface (lines 18-30):

```ts
import type { RegistrationTriggerType } from '@abl/shared';

export interface TriggerRegistration {
  workflowId: string;
  tenantId: string;
  projectId: string;
  triggerType: RegistrationTriggerType;
  config: Record<string, unknown>;
  environment?: string;
}
```

- [ ] **Step 2: Update trigger-engine.ts — fireWebhookTrigger**

At lines 404-419, update the triggerType and add webhook fields:

```ts
await this.deps.restateClient.startWorkflow(executionId, {
  workflowId: trigger.workflowId as string,
  workflowName: workflow.name,
  tenantId: trigger.tenantId as string,
  projectId: trigger.projectId as string,
  triggerType: 'webhook',
  webhookMode: 'async',
  webhookDelivery: 'poll',
  triggerPayload: payload,
  triggerMetadata: {
    registrationId,
    firedAt: new Date().toISOString(),
  },
  steps,
  workflowVersion,
  deploymentId,
});
```

- [ ] **Step 3: Update trigger-scheduler.ts**

At line 221, change:

```ts
// OLD:
triggerType: 'schedule' as const,

// NEW:
triggerType: 'cron' as const,
```

- [ ] **Step 4: Update triggers.ts route — Zod schema**

At line 45, change:

```ts
// OLD:
type: z.enum(['webhook', 'cron', 'polling', 'event', 'connector']),

// NEW:
triggerType: z.enum(['webhook', 'cron', 'event']),
```

Also update any references from `type` to `triggerType` in the route handler body that reads from the validated schema.

- [ ] **Step 5: Update workflow-executions.ts — ALLOWED_TRIGGER_TYPES**

At line 79, replace:

```ts
// OLD:
const ALLOWED_TRIGGER_TYPES = new Set(['manual', 'api', 'trigger', 'schedule']);

// NEW:
import { TRIGGER_TYPES } from '@abl/shared';
const ALLOWED_TRIGGER_TYPES = new Set(TRIGGER_TYPES);
```

Also update the default triggerType for the manual execute endpoint from `'manual'` to `'studio'`.

- [ ] **Step 6: Build and verify**

Run: `pnpm build --filter=workflow-engine`
Expected: Clean build.

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write apps/workflow-engine/src/services/trigger-engine.ts apps/workflow-engine/src/services/trigger-scheduler.ts apps/workflow-engine/src/routes/triggers.ts apps/workflow-engine/src/routes/workflow-executions.ts
git add apps/workflow-engine/src/services/trigger-engine.ts apps/workflow-engine/src/services/trigger-scheduler.ts apps/workflow-engine/src/routes/triggers.ts apps/workflow-engine/src/routes/workflow-executions.ts
git commit -m "[ABLP-2] refactor(workflow-engine): use unified trigger types in services and routes"
```

---

### Task 6: Runtime (`apps/runtime`)

**Files:**

- Modify: `apps/runtime/src/routes/process-api.ts:238`
- Modify: `apps/runtime/src/services/workflow/workflow-tool-executor.ts:107`

- [ ] **Step 1: Update process-api.ts**

At line 234-240, replace the triggerType assignment and add webhook fields:

```ts
const mode = (req.query.mode as string) || 'sync';
const isAsyncPush = mode === 'async_push';
const isAsync = mode === 'async' || isAsyncPush;

const enginePayload = {
  executionId,
  payload: input,
  triggerType: 'webhook',
  webhookMode: isAsync ? 'async' : 'sync',
  webhookDelivery: isAsyncPush ? 'push' : isAsync ? 'poll' : undefined,
  callbackUrl: isAsyncPush ? callbackUrl : undefined,
  accessToken: isAsyncPush ? (req.body as Record<string, unknown>).accessToken : undefined,
  triggerMetadata,
};
```

Note: `callbackUrl` and `isAsync` likely already exist in the function from the current mode handling code. Read the full function context before editing to avoid duplicating variables.

- [ ] **Step 2: Update runtime workflow-tool-executor.ts**

At line 107, change:

```ts
// OLD:
triggerType: 'api',

// NEW:
triggerType: 'agent',
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=runtime`
Expected: Clean build.

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/routes/process-api.ts apps/runtime/src/services/workflow/workflow-tool-executor.ts
git add apps/runtime/src/routes/process-api.ts apps/runtime/src/services/workflow/workflow-tool-executor.ts
git commit -m "[ABLP-2] refactor(runtime): use unified trigger types in process API and tool executor"
```

---

### Task 7: Studio Frontend (`apps/studio`)

**Files:**

- Modify: `apps/studio/src/api/workflows.ts:44-55`
- Modify: `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx:64-89`
- Modify: `apps/studio/src/components/workflows/WorkflowCard.tsx:56-71`
- Modify: `apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx:37-44`

- [ ] **Step 1: Update Studio API types**

In `apps/studio/src/api/workflows.ts`, replace `WorkflowTrigger` interface (lines 44-49):

```ts
export interface WorkflowTrigger {
  id: string;
  triggerType: 'webhook' | 'cron' | 'event';
  config: Record<string, unknown>;
  status: 'active' | 'paused' | 'error' | 'deleted';
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
  callbackUrl?: string;
}

export interface WorkflowTriggerPayload {
  workflowId: string;
  triggerType: WorkflowTrigger['triggerType'];
  config: Record<string, unknown>;
  webhookMode?: 'sync' | 'async';
  webhookDelivery?: 'poll' | 'push';
  callbackUrl?: string;
}
```

- [ ] **Step 2: Update WorkflowTriggersTab**

In `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`, replace the constants (lines 64-89):

```tsx
const TRIGGER_TYPE_CONFIG: Record<
  string,
  { label: string; icon: React.ReactNode; variant: 'info' | 'accent' | 'warning' }
> = {
  webhook: { label: 'Webhook', icon: <Webhook className="w-4 h-4" />, variant: 'info' },
  cron: { label: 'Cron Schedule', icon: <Clock className="w-4 h-4" />, variant: 'accent' },
  event: { label: 'Event', icon: <Zap className="w-4 h-4" />, variant: 'accent' },
};

const DEFAULT_TRIGGER_CONFIG = {
  label: 'Trigger',
  icon: <Zap className="w-4 h-4" />,
  variant: 'info' as const,
};

type TriggerType = 'webhook' | 'cron' | 'event';

const TRIGGER_TYPES: { value: TriggerType; label: string }[] = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'cron', label: 'Cron Schedule' },
  { value: 'event', label: 'Event' },
];
```

- [ ] **Step 3: Update WorkflowCard**

In `apps/studio/src/components/workflows/WorkflowCard.tsx`, replace `triggerStyles` (lines 61-66):

```tsx
const triggerStyles: Record<string, TriggerConfig> = {
  webhook: { label: 'Webhook', icon: <Webhook className="w-3.5 h-3.5" /> },
  cron: { label: 'Cron', icon: <Clock className="w-3.5 h-3.5" /> },
  event: { label: 'Event', icon: <Zap className="w-3.5 h-3.5" /> },
  studio: { label: 'Studio', icon: <Play className="w-3.5 h-3.5" /> },
  agent: { label: 'Agent', icon: <Bot className="w-3.5 h-3.5" /> },
};

const defaultTrigger: TriggerConfig = {
  label: 'Studio',
  icon: <Play className="w-3.5 h-3.5" />,
};
```

Note: Import `Bot` from `lucide-react` if not already imported. Check the existing imports first.

- [ ] **Step 4: Update WorkflowOverviewTab**

In `apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx`, replace `triggerTypeLabel` (lines 37-44):

```tsx
const triggerTypeLabel: Record<string, string> = {
  webhook: 'Webhook',
  cron: 'Cron Schedule',
  event: 'Event',
};
```

- [ ] **Step 5: Update useWorkflows hook**

In `apps/studio/src/hooks/useWorkflows.ts`, replace line 44:

```ts
// OLD:
triggerType = (first.strategy as string) ?? (first.type as string) ?? undefined;

// NEW:
triggerType = (first.triggerType as string) ?? undefined;
```

- [ ] **Step 6: Build and verify**

Run: `pnpm build --filter=studio`
Expected: Clean build.

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write apps/studio/src/api/workflows.ts apps/studio/src/hooks/useWorkflows.ts apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx apps/studio/src/components/workflows/WorkflowCard.tsx apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx
git add apps/studio/src/api/workflows.ts apps/studio/src/hooks/useWorkflows.ts apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx apps/studio/src/components/workflows/WorkflowCard.tsx apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx
git commit -m "[ABLP-2] feat(studio): update trigger type UI for unified enum"
```

---

### Task 8: i18n Keys (`packages/i18n`)

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

- [ ] **Step 1: Update trigger i18n keys**

In `packages/i18n/locales/en/studio.json`, find the trigger keys (around line 10548) and update:

```json
"trigger_webhook": "Webhook",
"trigger_cron": "Schedule",
"trigger_event": "Event",
"trigger_studio": "Studio",
"trigger_agent": "Agent",
```

Remove `"trigger_manual"` and `"trigger_polling"`.

- [ ] **Step 2: Run prettier and commit**

```bash
npx prettier --write packages/i18n/locales/en/studio.json
git add packages/i18n/locales/en/studio.json
git commit -m "[ABLP-2] feat(i18n): add studio and agent trigger type labels"
```

---

### Task 9: MongoDB Migration Script

**Files:**

- Create: `packages/database/src/migrations/20260414-unified-trigger-types.ts`

- [ ] **Step 1: Create the migration script**

```ts
/**
 * Migration: Unified Trigger Types
 *
 * Remaps old trigger type values to the new unified enum:
 *   - workflow_executions.triggerType: manual→studio, api→webhook, trigger→webhook, schedule→cron
 *   - trigger_registrations.strategy → triggerType: polling→cron, connector→event
 *
 * Run with: npx tsx packages/database/src/migrations/20260414-unified-trigger-types.ts
 */

import mongoose from 'mongoose';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('migration:unified-trigger-types');

async function migrate(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI or MONGO_URI must be set');
  }

  await mongoose.connect(mongoUri);
  log.info('Connected to MongoDB');

  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');

  // ─── 1. Migrate workflow_executions.triggerType ─────────────────────
  const executions = db.collection('workflow_executions');

  const executionMappings: Array<{
    filter: Record<string, string>;
    update: Record<string, unknown>;
    label: string;
  }> = [
    {
      filter: { triggerType: 'manual' },
      update: { $set: { triggerType: 'studio' } },
      label: 'manual → studio',
    },
    {
      filter: { triggerType: 'api' },
      update: { $set: { triggerType: 'webhook', webhookMode: 'sync' } },
      label: 'api → webhook(sync)',
    },
    {
      filter: { triggerType: 'trigger' },
      update: { $set: { triggerType: 'webhook', webhookMode: 'async', webhookDelivery: 'poll' } },
      label: 'trigger → webhook(async/poll)',
    },
    {
      filter: { triggerType: 'schedule' },
      update: { $set: { triggerType: 'cron' } },
      label: 'schedule → cron',
    },
    {
      filter: { triggerType: 'polling' },
      update: { $set: { triggerType: 'cron' } },
      label: 'polling (leaked) → cron',
    },
  ];

  for (const mapping of executionMappings) {
    const result = await executions.updateMany(mapping.filter, mapping.update);
    log.info(`Executions: ${mapping.label}`, { modified: result.modifiedCount });
  }

  // Backfill webhook fields for leaked 'webhook' docs (created before webhook fields existed)
  // Must run AFTER the api→webhook and trigger→webhook mappings (which set webhookMode)
  const leakedWebhookResult = await executions.updateMany(
    { triggerType: 'webhook', webhookMode: { $exists: false } },
    { $set: { webhookMode: 'async', webhookDelivery: 'poll' } },
  );
  log.info('Executions: webhook (leaked) → add async/poll fields', {
    modified: leakedWebhookResult.modifiedCount,
  });

  // ─── 2. Migrate trigger_registrations: strategy → triggerType ──────
  const registrations = db.collection('trigger_registrations');

  // Step A: Rename field strategy → triggerType
  const renameResult = await registrations.updateMany(
    { strategy: { $exists: true } },
    { $rename: { strategy: 'triggerType' } },
  );
  log.info('Registrations: renamed strategy → triggerType', {
    modified: renameResult.modifiedCount,
  });

  // Step B: Remap values
  const registrationMappings: Array<{
    filter: Record<string, string>;
    update: Record<string, unknown>;
    label: string;
  }> = [
    {
      filter: { triggerType: 'polling' },
      update: { $set: { triggerType: 'cron' } },
      label: 'polling → cron',
    },
    {
      filter: { triggerType: 'connector' },
      update: { $set: { triggerType: 'event' } },
      label: 'connector → event',
    },
  ];

  for (const mapping of registrationMappings) {
    const result = await registrations.updateMany(mapping.filter, mapping.update);
    log.info(`Registrations: ${mapping.label}`, { modified: result.modifiedCount });
  }

  // ─── 3. Verify no old values remain ────────────────────────────────
  const oldExecValues = await executions
    .distinct('triggerType')
    .then((vals) =>
      vals.filter((v) => !['webhook', 'cron', 'event', 'studio', 'agent'].includes(v as string)),
    );

  const oldRegValues = await registrations
    .distinct('triggerType')
    .then((vals) => vals.filter((v) => !['webhook', 'cron', 'event'].includes(v as string)));

  if (oldExecValues.length > 0) {
    log.warn('Unmigrated execution triggerType values', { values: oldExecValues });
  }
  if (oldRegValues.length > 0) {
    log.warn('Unmigrated registration triggerType values', { values: oldRegValues });
  }

  // Check for any documents still using 'strategy' field
  const strategyCount = await registrations.countDocuments({ strategy: { $exists: true } });
  if (strategyCount > 0) {
    log.warn('Documents still have strategy field', { count: strategyCount });
  }

  log.info('Migration complete');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run prettier and commit**

```bash
npx prettier --write packages/database/src/migrations/20260414-unified-trigger-types.ts
git add packages/database/src/migrations/20260414-unified-trigger-types.ts
git commit -m "[ABLP-2] feat(database): add MongoDB migration for unified trigger types"
```

---

### Task 10: Update Tests

**Files:**

- Modify: `packages/shared/src/__tests__/workflow-types.test.ts`
- Modify: `packages/database/src/__tests__/model-workflow-execution.test.ts`
- Modify: `packages/database/src/__tests__/model-trigger-registration.test.ts`
- Modify: `packages/connectors/src/__tests__/webhook-handler.test.ts`
- Modify: `packages/connectors/src/__tests__/cron-scheduler.test.ts`
- Modify: `packages/connectors/src/__tests__/polling-scheduler.test.ts`
- Modify: `packages/connectors/src/__tests__/trigger-engine.test.ts`
- Modify: `packages/connectors/src/__tests__/workflow-tool-executor.test.ts`
- Modify: `packages/connectors/src/__tests__/integration/webhook-dispatch.integration.test.ts`
- Modify: `packages/connectors/src/__tests__/integration/polling-trigger.integration.test.ts`
- Modify: `packages/connectors/src/__tests__/e2e/webhook-trigger.e2e.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/route-integration.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/execution-store.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/system-handler.test.ts`
- Modify: `apps/workflow-engine/src/__tests__/system-persistence.test.ts`
- Modify: `apps/runtime/src/__tests__/process-api.e2e.test.ts`

This task is large — split into sub-commits per package.

- [ ] **Step 1: Read each test file to identify exact lines that reference old trigger values**

For each test file, search for:

- `'manual'` → `'studio'`
- `'api'` → `'webhook'` (in triggerType context only)
- `'trigger'` → `'webhook'`
- `'schedule'` → `'cron'`
- `'polling'` → `'cron'`
- `'connector'` → `'event'`
- `strategy` → `triggerType` (in trigger registration context)
- Add `webhookMode`/`webhookDelivery` assertions where appropriate

**IMPORTANT:** Read each test file before editing. Do not blindly replace `'api'` — it appears in many non-trigger contexts (e.g., node types, API URLs). Only replace in `triggerType` context.

- [ ] **Step 2: Update packages/shared tests**

In `packages/shared/src/__tests__/workflow-types.test.ts`, update any `WorkflowExecutionInputSchema` parse tests:

- Replace `triggerType: 'manual'` with `triggerType: 'studio'`
- Add test cases for webhook validation rules (sync without delivery, async with delivery, push with callbackUrl)

- [ ] **Step 3: Update packages/database tests**

In `packages/database/src/__tests__/model-workflow-execution.test.ts`:

- Replace old triggerType values with new ones
- Add test for webhook fields

In `packages/database/src/__tests__/model-trigger-registration.test.ts`:

- Replace `strategy` with `triggerType`
- Remove `polling` and `connector` test cases
- Add `event` test case

- [ ] **Step 4: Build and run database/shared tests**

```bash
pnpm build --filter=@abl/shared --filter=@agent-platform/database
pnpm test --filter=@abl/shared --filter=@agent-platform/database
```

- [ ] **Step 5: Run prettier and commit shared/database tests**

```bash
npx prettier --write packages/shared/src/__tests__/workflow-types.test.ts packages/database/src/__tests__/model-workflow-execution.test.ts packages/database/src/__tests__/model-trigger-registration.test.ts
git add packages/shared/src/__tests__/ packages/database/src/__tests__/
git commit -m "[ABLP-2] test(shared,database): update trigger type test assertions"
```

- [ ] **Step 6: Update packages/connectors tests**

In each connector test file:

- `webhook-handler.test.ts`: `triggerType: 'webhook'` → `triggerType: 'event'`
- `cron-scheduler.test.ts`: keep `triggerType: 'cron'`
- `polling-scheduler.test.ts`: `triggerType: 'polling'` → `triggerType: 'cron'`
- `trigger-engine.test.ts`: `strategy` → `triggerType`, update switch expectations
- `workflow-tool-executor.test.ts`: keep `triggerType: 'agent'`
- `integration/webhook-dispatch.integration.test.ts`: `triggerType: 'webhook'` → `triggerType: 'event'`
- `integration/polling-trigger.integration.test.ts`: `triggerType: 'polling'` → `triggerType: 'cron'`
- `e2e/webhook-trigger.e2e.test.ts`: `triggerType: 'webhook'` → `triggerType: 'event'`

- [ ] **Step 7: Build and run connector tests**

```bash
pnpm build --filter=@agent-platform/connectors
pnpm test --filter=@agent-platform/connectors
```

- [ ] **Step 8: Run prettier and commit connector tests**

```bash
npx prettier --write packages/connectors/src/__tests__/
git add packages/connectors/src/__tests__/
git commit -m "[ABLP-2] test(connectors): update trigger type test assertions"
```

- [ ] **Step 9: Update workflow-engine tests**

In each workflow-engine test file:

- `workflow-executions-routes.test.ts`: `'manual'` → `'studio'`, `'api'` → `'webhook'`
- `trigger-scheduler-timezone.test.ts`: `'schedule'` → `'cron'`
- `execution-store.test.ts`: update trigger type values
- `system-handler.test.ts`: update trigger type values
- `system-persistence.test.ts`: update trigger type values
- `route-integration.test.ts`: update trigger type values

- [ ] **Step 10: Build and run workflow-engine tests**

```bash
pnpm build --filter=workflow-engine
pnpm test --filter=workflow-engine
```

- [ ] **Step 11: Run prettier and commit workflow-engine tests**

```bash
npx prettier --write apps/workflow-engine/src/__tests__/
git add apps/workflow-engine/src/__tests__/
git commit -m "[ABLP-2] test(workflow-engine): update trigger type test assertions"
```

- [ ] **Step 12: Update runtime tests**

In `apps/runtime/src/__tests__/process-api.e2e.test.ts`:

- `triggerType: 'api'` → `triggerType: 'webhook'`
- Add assertions for `webhookMode` and `webhookDelivery`

- [ ] **Step 13: Build and run runtime tests**

```bash
pnpm build --filter=runtime
pnpm test --filter=runtime
```

- [ ] **Step 14: Run prettier and commit runtime tests**

```bash
npx prettier --write apps/runtime/src/__tests__/process-api.e2e.test.ts
git add apps/runtime/src/__tests__/process-api.e2e.test.ts
git commit -m "[ABLP-2] test(runtime): update trigger type test assertions"
```

---

### Task 11: Full Build & Test Verification

- [ ] **Step 1: Full build**

```bash
pnpm build
```

Expected: All packages build cleanly.

- [ ] **Step 2: Full test run**

```bash
pnpm test:report
```

Review `test-reports/SUMMARY.md` for any failures.

- [ ] **Step 3: Fix any remaining issues**

Address any build or test failures found. Common issues:

- Files referencing `strategy` that were missed (grep for `strategy` in non-test TypeScript files)
- Files referencing old trigger type string literals that were missed
- Import path issues from the shared package

```bash
# Verify no old values remain in source code (excluding tests, which were updated in Task 10):
grep -r "'manual'" --include="*.ts" --exclude-dir="__tests__" --exclude-dir="node_modules" | grep -i trigger
grep -r "strategy" --include="*.ts" --exclude-dir="__tests__" --exclude-dir="node_modules" | grep -i trigger | grep -v "// "
```

- [ ] **Step 4: Run prettier on all changed files and final commit if needed**

```bash
npx prettier --write $(git diff --name-only HEAD~10 -- '*.ts' '*.tsx')
```
