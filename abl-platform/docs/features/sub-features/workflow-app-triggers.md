# Feature: Workflow App Triggers

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: PLANNED
**Feature Area(s)**: `integrations`, `agent lifecycle`, `project lifecycle`
**Package(s)**: `apps/studio`, `apps/workflow-engine`, `packages/connectors`, `packages/database`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-app-triggers.md](../../testing/sub-features/workflow-app-triggers.md)
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

Workflows today support two trigger mechanisms: **Webhook** (external caller POSTs to our API) and **Cron Schedule** (time-based). Both require manual configuration — webhook callers must know the endpoint URL and manage API keys, and there is no way to automatically start a workflow in response to events in external applications (Gmail receives an email, Jira issue is created, Slack message posted, GitHub PR merged, etc.).

The trigger creation UI currently exposes five trigger types: Webhook, Cron Schedule, Polling, Event, and Connector. The latter three are confusing to users — "Connector" requires manually selecting a connectorName, triggerName, and connectionId from dropdowns, with no guided OAuth flow or event discovery. The "Polling" and "Event" types are implementation details that should not be user-facing.

### Goal Statement

Add a third trigger category — **App Triggers** — that allows Studio users to pick an external application (Gmail, Jira, Slack, GitHub, etc.), authenticate via OAuth, select a trigger event, and save. The platform handles webhook registration, polling setup, and event routing automatically. The trigger creation UI should show exactly three options: **Webhook**, **Cron Schedule**, and **App Triggers**.

### Summary

App Triggers provides a user-friendly UX on top of the existing connector trigger infrastructure (`packages/connectors/src/triggers/`). Instead of exposing raw "Connector" type with manual field entry, users see an app catalog grid, connect via OAuth (reusing the existing `ConnectionService`), pick an event, and save. Under the hood, the trigger is registered as `type: 'connector'` and the `ConnectorTriggerEngine` handles the actual webhook/polling/cron strategy based on the connector's trigger definition. The Polling, Event, and Connector types are hidden from the creation UI but retained in the backend for backward compatibility.

The initial catalog is populated via the Activepieces importer (`packages/connectors/src/adapters/activepieces/importer.ts`), making the full Activepieces ecosystem available. Priority apps for end-to-end testing: **Gmail, Jira, Slack, GitHub**.

---

## 2. Scope

### Goals

- G1: Provide an "App Triggers" option in the trigger creation UI alongside Webhook and Cron Schedule
- G2: Show a browsable catalog of external apps with icons, names, and available trigger events
- G3: Guide users through OAuth connection for the selected app (reusing existing connection infrastructure)
- G4: Register app triggers that automatically set up webhook subscriptions or polling via the connector trigger engine
- G5: Import the full Activepieces connector catalog to populate available apps
- G6: Ensure end-to-end functionality for priority apps: Gmail, Jira, Slack, GitHub
- G7: Hide Polling, Event, and Connector trigger types from the creation UI (backend unchanged)

### Non-Goals (Out of Scope)

- NG1: Custom event filters/conditions at the trigger level (workflows can use condition nodes to filter events post-arrival)
- NG2: Building custom connector implementations — relies on Activepieces adapter for app integrations
- NG3: Removing Polling, Event, or Connector types from the backend (backward compatibility)
- NG4: Per-app rate limiting — uses existing tenant-level rate limiting
- NG5: Trigger marketplace or sharing across tenants
- NG6: Trigger-level retry configuration (uses existing connector trigger engine defaults)

---

## 3. User Stories

1. **US-1**: As a **Studio user**, I want to see an "App Triggers" option when creating a trigger so that I can connect external apps to my workflow without manual webhook configuration.

2. **US-2**: As a **Studio user**, I want to browse a catalog of available apps (Gmail, Jira, Slack, GitHub, etc.) with icons and descriptions so that I can discover what integrations are available.

3. **US-3**: As a **Studio user**, I want to authenticate with an external app via OAuth when setting up an app trigger so that the platform can subscribe to events on my behalf.

4. **US-4**: As a **Studio user**, I want to select a specific trigger event (e.g., "New Email" for Gmail, "Issue Created" for Jira) so that my workflow only fires for the events I care about.

5. **US-5**: As a **Studio user**, I want to reuse an existing OAuth connection when creating an app trigger so that I don't need to re-authenticate for apps I've already connected.

6. **US-6**: As a **Studio user**, I want to see the status of my app triggers (active, paused, error) and manage their lifecycle so that I can troubleshoot integration issues.

7. **US-7**: As a **platform operator**, I want app triggers to use the existing connector infrastructure so that new apps are available without platform code changes.

---

## 4. Functional Requirements

1. **FR-1**: The trigger creation form MUST show exactly three trigger type options: Webhook, Cron Schedule, and App Triggers. The Polling, Event, and Connector types MUST be hidden from the creation UI.

2. **FR-2**: When "App Triggers" is selected, the system MUST display a searchable catalog of available apps fetched from the `ConnectorListingService`, showing app name, icon, and category.

3. **FR-3**: When an app is selected from the catalog, the system MUST display the available trigger events for that app (from `ConnectorTrigger[]` on the connector definition).

4. **FR-4**: When a trigger event is selected, the system MUST show existing OAuth connections for the selected app (filtered by `connectorName`) and offer a "Connect" button to create a new connection if none exist.

5. **FR-5**: The system MUST register app triggers with `type: 'connector'` in the `TriggerRegistration` collection, including `connectorName`, `triggerName`, `connectionId`, and trigger-specific property values in the `config` field as defined by `ConnectorTrigger.props`.

6. **FR-6**: The `ConnectorTriggerEngine` MUST be enhanced to invoke `ConnectorTrigger.onEnable(ctx)` during registration for webhook-strategy triggers, enabling the connector to register webhooks with the external app's API. Currently the engine routes to `registerPollingTrigger()` or `registerCronTrigger()` based on strategy but performs no external registration for webhook triggers. The Activepieces adapter's `onEnable` stubs MUST be replaced with real implementations for priority apps (Gmail, Jira, Slack, GitHub).

7. **FR-7**: The `ConnectorTriggerEngine` MUST be enhanced to invoke `ConnectorTrigger.onDisable(ctx)` during deregistration, enabling the connector to unregister webhooks with the external app's API. Currently deregistration only removes BullMQ jobs and soft-deletes the registration. The Activepieces adapter's `onDisable` stubs MUST be replaced with real implementations for priority apps.

8. **FR-8**: Existing triggers of type Polling, Event, or Connector MUST continue to display correctly in the trigger list with their original type labels and icons.

9. **FR-9**: The trigger catalog endpoint (`GET /api/connectors/triggers/catalog`) MUST return real connector data from `ConnectorListingService` instead of static data, including only connectors that have at least one trigger defined.

10. **FR-10**: The system MUST display app trigger events in the trigger list with the app name and event name (e.g., "Gmail — New Email") instead of raw connectorName/triggerName.

11. **FR-11**: The app catalog MUST support text search/filtering by app name to allow quick discovery in large catalogs.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Triggers are project-scoped                                 |
| Agent lifecycle            | NONE         | Workflows, not agents                                       |
| Customer experience        | PRIMARY      | Core UX improvement — simplified trigger setup              |
| Integrations / channels    | PRIMARY      | Directly adds external app integrations                     |
| Observability / tracing    | SECONDARY    | Trigger events emit TraceEvents via existing infrastructure |
| Governance / controls      | SECONDARY    | Triggers respect project/tenant isolation                   |
| Enterprise / compliance    | SECONDARY    | OAuth credentials managed via existing connection service   |
| Admin / operator workflows | NONE         | No admin-facing changes                                     |

### Related Feature Integration Matrix

| Related Feature                            | Relationship Type | Why It Matters                                                            | Key Touchpoints                                                                                | Current State                                  |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [Workflow Triggers](workflow-triggers.md)  | extends           | App Triggers extends the existing trigger infrastructure with a new UX    | `TriggerEngine`, `TriggerRegistration`, `WorkflowTriggersTab`                                  | Webhook + Cron implemented; App catalog static |
| [Connectors](../connectors.md)             | depends on        | App Triggers uses the connector registry, trigger engine, and connections | `ConnectorTriggerEngine`, `ConnectionService`, `ConnectorListingService`, Activepieces adapter | ALPHA — registry + listing service working     |
| [Workflows & Human Tasks](../workflows.md) | shares data with  | App triggers start workflow executions                                    | `TriggerRegistration.workflowId`, Restate execution                                            | ALPHA — execution pipeline working             |

---

## 6. Design Considerations

### UI Flow

```
Trigger Creation Form
├── [Webhook]  [Cron Schedule]  [App Triggers]   ← type selector (3 buttons)
│
└── When "App Triggers" selected:
    ├── Step 1: App Catalog Grid
    │   ├── Search bar (filter by name)
    │   ├── App cards: icon + name + category badge
    │   └── Click card → Step 2
    │
    ├── Step 2: Event Selector
    │   ├── Dropdown of available trigger events for selected app
    │   ├── Event description shown below dropdown
    │   └── Select event → Step 3
    │
    └── Step 3: Connection
        ├── List existing connections for this app
        ├── "Use existing" radio buttons
        ├── "Connect new" button → opens OAuth popup/redirect
        └── Save → creates TriggerRegistration with type: 'connector'
```

### App Catalog Card Design

Each app card shows:

- App icon (from connector metadata or Activepieces piece icon)
- App display name
- Category badge (CRM, Communication, Developer Tools, etc.)
- Available trigger count

---

## 7. Technical Considerations

### Reuse Over Build

App Triggers is primarily a **UI/UX improvement** on top of existing backend infrastructure, with targeted engine enhancements. The connector trigger engine (`packages/connectors/src/triggers/trigger-engine.ts`) already handles:

- Webhook strategy routing (returns `{ strategy: 'webhook' }` — currently no external registration)
- Polling scheduling via `registerPollingTrigger()` using BullMQ repeatable jobs
- Cron scheduling via `registerCronTrigger()` using BullMQ cron jobs
- Deregistration removes BullMQ jobs and soft-deletes the registration

**New engine work required**: The `registerTrigger` method must be enhanced to call `ConnectorTrigger.onEnable(ctx)` for webhook-strategy triggers (to register webhooks with external apps), and `deregisterTrigger` must call `ConnectorTrigger.onDisable(ctx)` for cleanup. The Activepieces adapter currently stubs these as no-ops — real implementations are needed for priority apps.

The `ConnectorListingService` (`packages/connectors/src/services/connector-listing-service.ts`) already returns connectors with their triggers.

### Key Implementation Insight

The existing `type: 'connector'` in `WorkflowTriggersTab.tsx` (line 267-275) already creates connector triggers, but with raw dropdown selects. The App Triggers UX replaces those dropdowns with a guided catalog → event → connection flow while sending the same payload shape to the API.

### Activepieces Catalog Import

The `ActivepiecesImporter` (`packages/connectors/src/adapters/activepieces/importer.ts`) imports pieces from the Activepieces ecosystem. Each piece defines triggers with:

- `strategy: 'webhook' | 'polling' | 'cron'`
- `props: ConnectorProperty[]` for trigger-specific configuration
- `onEnable` / `onDisable` lifecycle hooks
- `sampleData` for UI previews

### Migration Path

No data migration needed. Existing `type: 'connector'` triggers in the database continue working. The UI change is purely presentational — "App Triggers" in the creation form maps to `type: 'connector'` in the API.

---

## 8. How to Consume

### Studio UI

**Trigger Creation**: Navigate to Workflow → Triggers tab → Click "New Trigger" → Select "App Triggers" → Browse catalog → Select app → Select event → Connect/select connection → Save.

**Trigger Management**: App triggers appear in the trigger list with the app name and event name. Supports pause, resume, fire (test), and delete actions via the existing trigger lifecycle UI.

**Route**: `/workflows/:workflowId` → Triggers tab (existing route, no new routes needed)

### API (Runtime)

Proxied through runtime to workflow-engine. No new endpoints — uses existing trigger CRUD endpoints.

| Method | Path                                                     | Purpose                                    |
| ------ | -------------------------------------------------------- | ------------------------------------------ |
| GET    | `/api/projects/:projectId/workflows/triggers`            | List triggers (existing)                   |
| POST   | `/api/projects/:projectId/workflows/triggers`            | Create trigger with `type: 'connector'`    |
| DELETE | `/api/projects/:projectId/workflows/triggers/:id`        | Delete trigger (existing)                  |
| POST   | `/api/projects/:projectId/workflows/triggers/:id/pause`  | Pause trigger (existing)                   |
| POST   | `/api/projects/:projectId/workflows/triggers/:id/resume` | Resume trigger (existing)                  |
| GET    | `/api/connectors/triggers/catalog`                       | Get real app catalog (updated from static) |

### API (Studio)

| Method | Path                                   | Purpose                         |
| ------ | -------------------------------------- | ------------------------------- |
| GET    | `/api/projects/:projectId/connectors`  | List connectors with triggers   |
| GET    | `/api/projects/:projectId/connections` | List existing OAuth connections |
| POST   | `/api/projects/:projectId/connections` | Create new OAuth connection     |

### Admin Portal

N/A — no admin-specific changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — App Triggers is a workflow trigger mechanism, not channel-aware. Workflows triggered by app events can interact with any channel via their execution logic.

---

## 9. Data Model

### Collections / Tables

No new collections. Uses existing models:

```text
Collection: trigger_registrations (existing)
Fields used by App Triggers:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - workflowId: string (required)
  - connectorName: string (e.g., 'gmail', 'jira', 'slack')
  - triggerName: string (e.g., 'new-email', 'issue-created')
  - connectionId: string (reference to connections collection)
  - strategy: 'webhook' | 'polling' | 'cron' | 'event' | 'connector' (full Mongoose enum; 'event' and 'connector' are legacy types retained for backward compatibility)
  - status: 'active' | 'paused' | 'error' | 'deleted'
  - config: Record<string, unknown> (trigger-specific props)
  - webhookSecret: string (for webhook strategy)
  - cronExpression: string (for cron strategy)
  - pollingIntervalMs: number (for polling strategy)
  - authProfileId: string (optional, for auth profile-linked connections)
  - bullmqJobId: string (for polling/cron — BullMQ job reference)
  - webhookUrl: string (generated webhook URL for push-based triggers)
  - missedFirePolicy: 'fire_once' | 'fire_all' | 'skip' (handling missed cron fires)
  - environment: string (deployment environment binding)
  - consecutiveErrors: number
  - lastFiredAt: Date
  - lastErrorAt: Date
  - deletedAt: Date (soft delete timestamp)
Indexes (existing):
  - { tenantId: 1, workflowId: 1 }
  - { tenantId: 1, connectorName: 1, status: 1 }
  - { tenantId: 1, projectId: 1 }
```

### Key Relationships

- `TriggerRegistration.workflowId` → `Workflow._id` (which workflow to execute)
- `TriggerRegistration.connectionId` → `Connection._id` (OAuth credentials for the app)
- `TriggerRegistration.connectorName` → `ConnectorRegistry` entry (connector definition with triggers)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/connectors/src/triggers/trigger-engine.ts`            | Connector trigger engine — routes to webhook/polling/cron strategy |
| `packages/connectors/src/triggers/webhook-handler.ts`           | Inbound webhook handler for push-based triggers                    |
| `packages/connectors/src/triggers/polling-scheduler.ts`         | BullMQ polling job registration                                    |
| `packages/connectors/src/triggers/cron-scheduler.ts`            | BullMQ cron job registration                                       |
| `packages/connectors/src/triggers/types.ts`                     | TriggerRegistration, WorkflowTriggerInput types                    |
| `packages/connectors/src/services/connector-listing-service.ts` | Connector catalog with trigger metadata                            |
| `packages/connectors/src/services/connection-service.ts`        | OAuth connection CRUD                                              |
| `packages/connectors/src/adapters/activepieces/importer.ts`     | Activepieces piece importer                                        |

### Routes / Handlers

| File                                                   | Purpose                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `apps/workflow-engine/src/routes/triggers.ts`          | Trigger CRUD routes (existing)                                   |
| `apps/workflow-engine/src/routes/trigger-catalog.ts`   | Trigger catalog endpoint (to be updated)                         |
| `apps/workflow-engine/src/services/trigger-engine.ts`  | Top-level trigger engine — delegates to connector trigger engine |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts` | Runtime proxy for trigger API calls                              |

### UI Components

| File                                                                         | Purpose                                               |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`          | Main trigger tab — type selector, creation form, list |
| `apps/studio/src/components/workflows/triggers/ExternalAppCatalog.tsx`       | App catalog grid (to be updated from "Coming Soon")   |
| `apps/studio/src/components/workflows/triggers/AppTriggerPicker.tsx` _(new)_ | Guided app → event → connection flow                  |

### Jobs / Workers / Background Processes

| File                                                    | Purpose                                  |
| ------------------------------------------------------- | ---------------------------------------- |
| `packages/connectors/src/triggers/polling-scheduler.ts` | Polling worker processes periodic checks |
| `packages/connectors/src/triggers/cron-scheduler.ts`    | Cron worker processes scheduled triggers |

### Tests

| File                                        | Type        | Coverage Focus                            |
| ------------------------------------------- | ----------- | ----------------------------------------- |
| TBD — `apps/studio/e2e/workflows/`          | e2e         | App trigger creation flow                 |
| TBD — `apps/workflow-engine/src/__tests__/` | integration | Trigger registration with connector type  |
| TBD — `packages/connectors/src/__tests__/`  | unit        | ConnectorListingService trigger filtering |

---

## 11. Configuration

### Environment Variables

No new environment variables. Uses existing:

| Variable              | Default                  | Description                        |
| --------------------- | ------------------------ | ---------------------------------- |
| `WORKFLOW_ENGINE_URL` | `http://localhost:9080`  | Workflow engine base URL for proxy |
| `REDIS_URL`           | `redis://localhost:6379` | Redis for BullMQ trigger jobs      |
| `NANGO_HOST_URL`      | (from `.env`)            | Nango server for OAuth connections |

### Runtime Configuration

- Connector triggers inherit the auto-pause threshold from `TRIGGER_AUTO_PAUSE_THRESHOLD` (10 consecutive errors) defined in `apps/workflow-engine/src/constants.ts:45`
- Polling intervals bounded by `MIN_POLLING_INTERVAL_MS` (30s in `packages/connectors/src/triggers/constants.ts`; note: `apps/workflow-engine/src/constants.ts` defines 10s — the connectors package value takes precedence for app triggers) and `MAX_POLLING_INTERVAL_MS` (24h)

### DSL / Agent IR / Schema

N/A — App Triggers is a runtime/workflow-engine concern, not part of the Agent IR or DSL.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Trigger registrations include `projectId`. Catalog and connection queries are project-scoped. Cross-project access returns 404.                                                                                                                                                                               |
| Tenant isolation  | All trigger, connection, and connector queries include `tenantId`. Cross-tenant access returns 404.                                                                                                                                                                                                           |
| User isolation    | Triggers are project-scoped — any project member with `workflow:write` can manage any trigger in the project (TriggerRegistration has no `createdBy` field). OAuth connections referenced by triggers are user-scoped via the Connection model's `createdBy` field; cross-user connection access returns 404. |

### Security & Compliance

- OAuth tokens stored in connections collection, encrypted at rest via existing encryption infrastructure
- Webhook secrets per trigger registration, encrypted at rest
- Inbound webhook signature verification via `ConnectorTrigger.verify()` method
- No PII stored in trigger registrations — only configuration metadata
- Audit logging via existing TraceEvent infrastructure

### Performance & Scalability

- Catalog endpoint response cached (connector registry is loaded at startup)
- Polling triggers bounded by `MIN_POLLING_INTERVAL_MS` (30s in connectors package) to prevent excessive API calls
- BullMQ handles trigger job scheduling — scales horizontally via Redis
- Auto-pause after 10 consecutive errors prevents runaway triggers (`TRIGGER_AUTO_PAUSE_THRESHOLD`)

### Reliability & Failure Modes

- **OAuth token expiry**: `TokenManager` in `packages/connectors/base/src/auth/token-manager.ts` handles refresh
- **Webhook registration failure**: `onEnable()` throws → trigger status set to `error` → user sees error state in UI
- **External app downtime**: Polling triggers retry on next interval; webhook triggers have no action needed (app will push when back up)
- **Consecutive errors**: Auto-pause after `TRIGGER_AUTO_PAUSE_THRESHOLD` (10) consecutive errors

### Observability

- Trigger fire events emit `TraceEvent`s via existing `TraceStore`
- Trigger status changes (active → error, auto-pause) logged via workflow-engine logger
- BullMQ job metrics available via existing Bull dashboard

### Data Lifecycle

- Soft-deleted triggers (`status: 'deleted'`) retained for audit trail
- Webhook subscriptions cleaned up via `onDisable()` on deregistration
- No TTL on trigger registrations — managed via explicit lifecycle actions

---

## 13. Delivery Plan / Work Breakdown

1. **UI: Trigger type selector cleanup**
   1.1 Update `TRIGGER_TYPES` and `TRIGGER_TYPE_CONFIG` in `WorkflowTriggersTab.tsx` to show only Webhook, Cron Schedule, App Triggers
   1.2 Ensure existing Polling/Event/Connector triggers display correctly in the trigger list with their original labels
   1.3 Map "App Triggers" selection to internal `type: 'connector'`

2. **UI: App catalog component**
   2.1 Create `AppTriggerPicker.tsx` component with app grid, search/filter, and event selector
   2.2 Update `ExternalAppCatalog.tsx` to fetch from real `ConnectorListingService` (remove "Coming Soon")
   2.3 Add connection selector/creation step within the picker
   2.4 Wire `AppTriggerPicker` into `TriggerCreationForm` when type is "App Triggers"

3. **Backend: Catalog endpoint update**
   3.1 Update `trigger-catalog.ts` to query `ConnectorListingService` instead of returning static data
   3.2 Filter to only connectors with at least one trigger defined
   3.3 Return trigger metadata (name, displayName, description, strategy) per connector

4. **Backend: ConnectorTriggerEngine enhancement**
   4.1 Enhance `registerTrigger()` to call `ConnectorTrigger.onEnable(ctx)` for webhook-strategy triggers
   4.2 Enhance `deregisterTrigger()` to call `ConnectorTrigger.onDisable(ctx)` for cleanup
   4.3 Replace Activepieces adapter `onEnable`/`onDisable` stubs with real implementations for priority apps (Gmail, Jira, Slack, GitHub)

5. **Backend: Activepieces catalog population**
   5.1 Ensure Activepieces importer runs at startup and populates connector registry with trigger metadata
   5.2 Verify priority apps (Gmail, Jira, Slack, GitHub) have correct trigger definitions
   5.3 Test OAuth flows for priority apps via Nango

6. **End-to-end validation**
   6.1 E2E test: create Gmail app trigger → verify webhook/polling registration
   6.2 E2E test: create Jira app trigger → fire event → verify workflow execution
   6.3 E2E test: pause/resume/delete app trigger lifecycle
   6.4 E2E test: reuse existing connection for new trigger
   6.5 Integration test: trigger catalog returns real connector data

---

## 14. Success Metrics

| Metric                           | Baseline       | Target                         | How Measured                                                                   |
| -------------------------------- | -------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| App triggers created per week    | 0              | > 10                           | Count `TriggerRegistration` with `type: 'connector'` and connectorName != null |
| Trigger creation completion rate | N/A (new flow) | > 80%                          | UI analytics: start create → save success                                      |
| Trigger error rate (auto-pause)  | N/A            | < 5%                           | Count triggers reaching auto-pause threshold                                   |
| Catalog apps available           | 0 (static)     | > 50                           | `ConnectorListingService.listConnectors()` with triggers                       |
| Priority app coverage            | 0              | 4 (Gmail, Jira, Slack, GitHub) | E2E tests passing for each app                                                 |

---

## 15. Open Questions

1. **OQ-1**: Which Activepieces pieces have production-quality trigger implementations? Some may have `onEnable`/`onDisable` stubs that don't actually register webhooks. Need to audit priority apps.
2. **OQ-2**: How should we handle apps that require additional trigger-specific props (e.g., Gmail "label filter", Jira "project key")? Current plan is to show them as form fields from `ConnectorTrigger.props`, but the UX for dynamic props needs design.
3. **OQ-3**: Should the app catalog show a "status" indicator (connected vs not connected) based on whether the user has existing connections for each app?
4. **OQ-4**: How do we handle Activepieces pieces that require Nango proxy vs direct API access? Need to verify the adapter layer handles both transparently.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                        | Severity | Status |
| ------- | -------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No event filtering at trigger level — all matching events fire the workflow                        | Medium   | Open   |
| GAP-002 | Activepieces trigger quality varies — some pieces have stub implementations                        | High     | Open   |
| GAP-003 | No bulk trigger management — each trigger must be created/managed individually                     | Low      | Open   |
| GAP-004 | Trigger-specific props (`ConnectorTrigger.props`) need dynamic form rendering in the picker UI     | Medium   | Open   |
| GAP-005 | No trigger testing/preview — user cannot test if their OAuth + event selection works before saving | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                          | Coverage Type | Status     | Test File / Note                                                                           |
| --- | ----------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------------------------------------------ |
| 1   | Create app trigger via UI (app → event → connection → save)       | e2e           | NOT TESTED | Studio E2E with real server                                                                |
| 2   | Trigger catalog returns real connector data                       | integration   | NOT TESTED | Workflow-engine integration test                                                           |
| 3   | App trigger fires workflow on external event                      | e2e           | NOT TESTED | Simulate webhook POST to trigger endpoint                                                  |
| 4   | Pause/resume/delete app trigger lifecycle                         | e2e           | NOT TESTED | Studio E2E with real server                                                                |
| 5   | Reuse existing connection for new trigger                         | e2e           | NOT TESTED | Studio E2E                                                                                 |
| 6   | Trigger list shows app name + event name                          | e2e           | NOT TESTED | Studio E2E                                                                                 |
| 7   | Hidden types (Polling/Event) still display for existing triggers  | integration   | NOT TESTED | API test: create legacy-type triggers via API, verify list endpoint returns correct labels |
| 8   | Cross-tenant trigger isolation (tenant A cannot see B's triggers) | e2e           | NOT TESTED | Multi-tenant API test with auth                                                            |
| 9   | Cross-project trigger isolation                                   | e2e           | NOT TESTED | API test with different projectIds                                                         |
| 10  | OAuth connection failure handling                                 | integration   | NOT TESTED | Connection service error path                                                              |

### Testing Notes

E2E tests must exercise the real system: Studio UI → Runtime proxy → Workflow Engine → Connector Trigger Engine → BullMQ/Redis. No mocking of platform components. External app APIs (Gmail, Jira) may be mocked via Nango test mode or Activepieces test adapters for deterministic testing.

Integration tests focus on the catalog endpoint and trigger registration pipeline without requiring external OAuth.

> Full testing details: [../../testing/sub-features/workflow-app-triggers.md](../../testing/sub-features/workflow-app-triggers.md)

---

## 18. References

- Parent feature: [Workflows & Human Tasks](../workflows.md)
- Sibling feature: [Workflow Triggers](workflow-triggers.md)
- HLD: [docs/specs/workflow-triggers.hld.md](../../specs/workflow-triggers.hld.md)
- LLD: [docs/plans/2026-03-24-workflow-triggers-impl-plan.md](../../plans/2026-03-24-workflow-triggers-impl-plan.md)
- Connectors feature: [Connectors](../connectors.md)
- Connector trigger types: `packages/connectors/src/types.ts` (ConnectorTrigger interface)
- Trigger engine: `packages/connectors/src/triggers/trigger-engine.ts`
- Activepieces adapter: `packages/connectors/src/adapters/activepieces/importer.ts`
