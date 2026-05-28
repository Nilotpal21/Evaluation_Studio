## Trigger System: Gmail "New Email" as the Example

### 1. The Activepieces Trigger Definition

`node_modules/.pnpm/@activepieces+piece-gmail@0.11.7/.../new-email.js`

- **Strategy:** `TriggerStrategy.POLLING` — Gmail doesn't push; the platform polls Gmail's API
- **`onEnable`:** Seeds `lastPoll = Date.now()` in the store (cursor initialization)
- **`run`:** Reads `lastPoll`, calls `gmail.users.messages.list`, returns new messages since cursor, updates cursor
- **Props:** `subject`, `from`, `to`, `label`, `category`

---

### 2. Boot-Time Loading & Adapter

`packages/connectors/src/loader.ts:49` → `packages/connectors/src/adapters/activepieces/runtime-adapter.ts`

The key mapping at `runtime-adapter.ts:207-208`:

```
AP POLLING  →  platform type: 'cron'
AP WEBHOOK  →  platform type: 'webhook'
```

So Gmail becomes a `'cron'`-typed trigger in the platform (no cronExpression, so it uses a repeating interval).

The AP trigger's `onEnable/onDisable/run` are wrapped into a platform `ConnectorTrigger` object and registered in `ConnectorRegistry` (max 500 entries).

---

### 3. Registration Flow (when a user sets up a trigger in Studio)

```
Studio UI
  → POST /api/projects/:projectId/triggers
  → apps/workflow-engine/src/routes/triggers.ts:91
  → workflow-engine TriggerEngine.register()  (services/trigger-engine.ts:149)
  → detects connectorName → delegates to ConnectorTriggerEngine.registerTrigger()
  → packages/connectors/src/triggers/trigger-engine.ts:121
```

Inside the connectors `TriggerEngine` at `trigger-engine.ts:129`, it switches on type:

- `'cron'` with no cronExpression → falls into polling path at line 240
- Calls `runOnEnable()` — seeds the `lastPoll` cursor via Gmail's `onEnable`
- Calls `registerPollingTrigger()` → creates a **BullMQ repeatable job** with `jobId: poll:<registrationId>` every 30 seconds (or connector-specific override)

---

### 4. Polling Execution Loop

`packages/connectors/src/triggers/polling-scheduler.ts:133` — `processPollingJob()` runs every 30s:

```
BullMQ Worker fires
  1. Load TriggerRegistration from MongoDB (must be status: 'active')
  2. Resolve OAuth2 credentials (authResolver)
  3. Call AP trigger's run() → hits Gmail API, returns new emails
  4. SHA-256 content-hash dedup (Redis, TTL = max(3× interval, 15min))
  5. For each new email → workflowResolver → RestateClient.startWorkflow()
  6. Update lastPoll cursor in Redis store
  7. After 10 consecutive failures → auto-pause (status: 'error')
```

---

### 5. Webhook Path (non-Gmail)

For webhook-type triggers (e.g. GitHub, Stripe):

- `onEnable` calls the external provider's subscribe API with `webhookUrl`
- Inbound events hit `POST /api/v1/webhooks/connector/:connectorName/:registrationId` (unauthenticated, signature-verified)
- `packages/connectors/src/triggers/webhook-handler.ts:81` handles dedup + Restate dispatch

---

### 6. Boot-Time Recovery

`apps/workflow-engine/src/services/connector-trigger-rehydrator.ts:77`

On pod restart, Redis (BullMQ) state is gone. The rehydrator scans MongoDB for all `status: 'active'` trigger registrations and re-creates BullMQ jobs idempotently. This runs fire-and-forget at boot.

---

### Key Gotchas

| Gotcha                           | Detail                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| AP `POLLING` → platform `'cron'` | Not `'polling'` — flows through the `case 'cron'` branch with no cronExpression                                      |
| Two `TriggerEngine` classes      | `packages/connectors/...` (connector lifecycle) and `apps/workflow-engine/...` (Studio API layer) — different shapes |
| Store key namespace              | Redis: `conn:{connectionId}:{key}` for state, `dedup:{registrationId}:{hash}` for dedup                              |
| BullMQ is ephemeral              | Redis restart kills all schedules — rehydrator is the safety net                                                     |
| Gmail attachments                | Redis-backed, 1-hour TTL, 10MB max                                                                                   |

The full data flow in one line: **AP trigger definition → runtime adapter wraps it → BullMQ polls every 30s → AP `run()` hits Gmail API → dedup → Restate starts workflow execution**.
