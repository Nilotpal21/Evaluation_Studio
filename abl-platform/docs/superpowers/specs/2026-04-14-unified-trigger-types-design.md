# Unified Trigger Type System

**Date:** 2026-04-14
**Status:** Approved
**Scope:** packages/shared, packages/database, packages/connectors, apps/workflow-engine, apps/runtime, apps/studio, packages/i18n

## Problem

The codebase has 3 parallel trigger type systems with inconsistent values:

1. **Execution triggerType**: `manual | api | trigger | schedule` — recorded on each workflow run
2. **Registration strategy**: `webhook | polling | cron | event | connector` — on trigger registrations
3. **Pipeline trigger type**: `kafka | schedule | manual` — pipeline engine only

These systems are defined as scattered string literals across 10+ files in 5 packages. Connector code paths send invalid values (`webhook`, `polling`, `cron`, `agent`) that are not in the execution model's Mongoose enum. The generic value `trigger` exists but nothing ever sets it.

## Solution

Replace all three workflow trigger type systems with a single unified `triggerType` enum. Pipeline engine types (`kafka | schedule | manual`) are a separate domain and remain unchanged.

### Trigger Types

```ts
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
```

| Trigger Type | Description                                                            | Has Registration? |
| ------------ | ---------------------------------------------------------------------- | ----------------- |
| `webhook`    | External HTTP call (Process API, registered webhook URL)               | Yes               |
| `cron`       | Time-interval scheduled (cron expressions, presets, polling intervals) | Yes               |
| `event`      | Push-based connector events (Slack, GitHub, Jira webhook callbacks)    | Yes               |
| `studio`     | User clicks Run in Studio UI                                           | No                |
| `agent`      | Agent invokes workflow-as-tool during conversation                     | No                |

### Webhook-Specific Fields

Only when `triggerType = 'webhook'`:

```ts
export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];
```

| Field             | Type                | Required When                                  |
| ----------------- | ------------------- | ---------------------------------------------- |
| `webhookMode`     | `'sync' \| 'async'` | `triggerType = 'webhook'`                      |
| `webhookDelivery` | `'poll' \| 'push'`  | `webhookMode = 'async'`                        |
| `callbackUrl`     | `string (URL)`      | `webhookDelivery = 'push'`                     |
| `accessToken`     | `string`            | Optional, only when `webhookDelivery = 'push'` |

### Webhook Mode Examples

**sync** — caller waits for execution result:

```bash
curl -X POST '.../executions/execute?mode=sync' \
  -H 'x-api-key: abl_...' \
  -d '{"input": {}}'
```

**async + poll** — caller gets executionId, polls for result:

```bash
# 1. Start
curl -X POST '.../executions/execute?mode=async' \
  -H 'x-api-key: abl_...' \
  -d '{"input": {}}'

# 2. Poll
curl '.../executions/{executionId}' \
  -H 'x-api-key: abl_...'
```

**async + push** — system pushes result to callback URL:

```bash
curl -X POST '.../executions/execute?mode=async_push' \
  -H 'x-api-key: abl_...' \
  -d '{"input": {}, "callbackUrl": "https://your-server.com/callback", "accessToken": "your-token"}'
```

### Validation Rules

- `triggerType !== 'webhook'` → all webhook fields must be absent
- `webhookMode = 'sync'` → `webhookDelivery` must be absent
- `webhookMode = 'async'` → `webhookDelivery` required (`poll` or `push`)
- `webhookDelivery = 'push'` → `callbackUrl` required

## Shared Constants

Single source of truth in `packages/shared/src/types/workflow-schemas.ts`:

```ts
export const TRIGGER_TYPES = ['webhook', 'cron', 'event', 'studio', 'agent'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const WEBHOOK_MODES = ['sync', 'async'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export const WEBHOOK_DELIVERIES = ['poll', 'push'] as const;
export type WebhookDelivery = (typeof WEBHOOK_DELIVERIES)[number];
```

Imported by all consumers. No more scattered string literals.

## Database Model Changes

### WorkflowExecution Model

```ts
// Replace:
//   TRIGGER_TYPES = ['manual', 'api', 'trigger', 'schedule']
// With import from @abl/shared, add webhook fields:

triggerType: { type: String, enum: TRIGGER_TYPES, required: true },
webhookMode: { type: String, enum: WEBHOOK_MODES },
webhookDelivery: { type: String, enum: WEBHOOK_DELIVERIES },
callbackUrl: { type: String },
accessToken: { type: String },
```

### TriggerRegistration Model

```ts
// Replace strategy field:
//   OLD: strategy: 'webhook' | 'polling' | 'cron' | 'event' | 'connector'
//   NEW:
triggerType: { type: String, enum: ['webhook', 'cron', 'event'], required: true },
webhookMode: { type: String, enum: WEBHOOK_MODES },
webhookDelivery: { type: String, enum: WEBHOOK_DELIVERIES },
callbackUrl: { type: String },
```

Only `webhook | cron | event` for registrations. `studio` and `agent` are execution-time only.

## Migration Mapping

### Execution Records

| Old `triggerType`  | New `triggerType` | `webhookMode` | `webhookDelivery` |
| ------------------ | ----------------- | ------------- | ----------------- |
| `manual`           | `studio`          | —             | —                 |
| `api`              | `webhook`         | `sync`        | —                 |
| `trigger`          | `webhook`         | `async`       | `poll`            |
| `schedule`         | `cron`            | —             | —                 |
| `webhook` (leaked) | `webhook`         | `async`       | `poll`            |
| `polling` (leaked) | `cron`            | —             | —                 |
| `cron` (leaked)    | `cron`            | —             | —                 |
| `agent` (leaked)   | `agent`           | —             | —                 |

### Trigger Registrations

| Old `strategy` | New `triggerType` | Notes                                    |
| -------------- | ----------------- | ---------------------------------------- |
| `webhook`      | `webhook`         | —                                        |
| `cron`         | `cron`            | —                                        |
| `polling`      | `cron`            | Polling absorbed into cron               |
| `event`        | `event`           | —                                        |
| `connector`    | `event`           | Connector triggers are push-based events |

Also rename field `strategy` → `triggerType` in all registration documents.

## API Layer Changes

### Process API (`apps/runtime/src/routes/process-api.ts`)

Derive trigger fields from query param `?mode=sync|async|async_push`:

```ts
triggerType: 'webhook',
webhookMode: mode === 'async_push' ? 'async' : mode,
webhookDelivery: mode === 'async_push' ? 'push' : mode === 'async' ? 'poll' : undefined,
callbackUrl: mode === 'async_push' ? req.body.callbackUrl : undefined,
accessToken: mode === 'async_push' ? req.body.accessToken : undefined,
```

### Workflow Engine

- **trigger-engine.ts**: `triggerType: 'webhook'`, `webhookMode: 'async'`, `webhookDelivery: 'poll'`
- **trigger-scheduler.ts**: `triggerType: 'cron'`
- **workflow-executions.ts**: Use shared `TRIGGER_TYPES`, default `studio` for manual runs
- **triggers.ts route**: Update Zod enum from `['webhook', 'cron', 'polling', 'event', 'connector']` to `['webhook', 'cron', 'event']`

### Connector Package

- **webhook-handler.ts**: `triggerType: 'event'` (connector webhooks are push-based events)
- **cron-scheduler.ts**: `triggerType: 'cron'`
- **polling-scheduler.ts**: `triggerType: 'cron'`
- **workflow-tool-executor.ts**: `triggerType: 'agent'`
- **types.ts**: `strategy` → `triggerType`, align with shared types
- **trigger-engine.ts**: Update exhaustive switch to `webhook | cron | event`

### Runtime

- **process-api.ts**: `triggerType: 'webhook'` with mode/delivery from query param
- **workflow-tool-executor.ts**: `triggerType: 'agent'`

## Studio Frontend Changes

### WorkflowTriggersTab — Trigger Creation

Dropdown reduced to 3 registration types:

- Webhook
- Cron Schedule
- Event

Webhook creation form adds:

- Mode toggle: `sync` | `async`
- When async: delivery toggle: `poll` | `push`
- When push: `callbackUrl` (required) + `accessToken` (optional)

### WorkflowCard — Execution Display

5-type trigger style map:

| Type      | Label   | Icon          |
| --------- | ------- | ------------- |
| `webhook` | Webhook | `<Webhook />` |
| `cron`    | Cron    | `<Clock />`   |
| `event`   | Event   | `<Zap />`     |
| `studio`  | Studio  | `<Play />`    |
| `agent`   | Agent   | `<Bot />`     |

### WorkflowOverviewTab

3-type labels for trigger registrations: `webhook`, `cron`, `event`

### Studio API Types

```ts
// Trigger registration
triggerType: 'webhook' | 'cron' | 'event';

// Execution record
triggerType: 'webhook' | 'cron' | 'event' | 'studio' | 'agent';
webhookMode?: 'sync' | 'async';
webhookDelivery?: 'poll' | 'push';
```

### i18n

- Remove: `trigger_polling`, `trigger_manual`
- Add: `trigger_studio`, `trigger_agent`
- Keep: `trigger_webhook`, `trigger_cron`, `trigger_event`

## Files to Modify

| Package                | File                                                | Change                                                         |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `packages/shared`      | `types/workflow-schemas.ts`                         | Shared constants, Zod schema with webhook fields + superRefine |
| `packages/database`    | `models/workflow-execution.model.ts`                | New enum import, add webhook fields                            |
| `packages/database`    | `models/trigger-registration.model.ts`              | `strategy` → `triggerType`, drop `polling`/`connector`         |
| `packages/connectors`  | `triggers/types.ts`                                 | Align types, `strategy` → `triggerType`                        |
| `packages/connectors`  | `types.ts`                                          | `strategy` → `triggerType`                                     |
| `packages/connectors`  | `triggers/trigger-engine.ts`                        | Switch to `webhook`/`cron`/`event`                             |
| `packages/connectors`  | `triggers/webhook-handler.ts`                       | `triggerType: 'event'`                                         |
| `packages/connectors`  | `triggers/cron-scheduler.ts`                        | `triggerType: 'cron'`                                          |
| `packages/connectors`  | `triggers/polling-scheduler.ts`                     | `triggerType: 'cron'`                                          |
| `packages/connectors`  | `executor/workflow-tool-executor.ts`                | `triggerType: 'agent'`                                         |
| `apps/workflow-engine` | `services/trigger-engine.ts`                        | Type update, set webhook mode/delivery                         |
| `apps/workflow-engine` | `services/trigger-scheduler.ts`                     | `triggerType: 'cron'`                                          |
| `apps/workflow-engine` | `routes/triggers.ts`                                | Zod enum update                                                |
| `apps/workflow-engine` | `routes/workflow-executions.ts`                     | Shared `TRIGGER_TYPES`, default `studio`                       |
| `apps/runtime`         | `routes/process-api.ts`                             | `webhook` + mode/delivery from query param                     |
| `apps/runtime`         | `services/workflow/workflow-tool-executor.ts`       | `triggerType: 'agent'`                                         |
| `apps/studio`          | `components/workflows/tabs/WorkflowTriggersTab.tsx` | 3 types + webhook mode/delivery form                           |
| `apps/studio`          | `components/workflows/WorkflowCard.tsx`             | 5-type trigger styles                                          |
| `apps/studio`          | `components/workflows/tabs/WorkflowOverviewTab.tsx` | 3-type labels                                                  |
| `apps/studio`          | `api/workflows.ts`                                  | Typed trigger fields                                           |
| `packages/i18n`        | `locales/en/studio.json`                            | Add/remove trigger keys                                        |
| Tests                  | ~12 test files                                      | Update trigger type assertions                                 |
| Migration              | New migration script                                | Remap old values in MongoDB                                    |

## Out of Scope

- Pipeline engine trigger types (`kafka | schedule | manual`) — separate domain
- Restate workflow handler internals
- BullMQ job infrastructure (cron-scheduler/polling-scheduler still exist, just report correct triggerType)
