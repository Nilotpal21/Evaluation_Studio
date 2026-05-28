# Testing Guide: Workflow App Triggers

**Feature**: [Workflow App Triggers](../../features/sub-features/workflow-app-triggers.md)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md)
**Status**: PLANNED
**Last Updated**: 2026-04-14

---

## Current State

No tests exist yet. Feature is in PLANNED status.

---

## Coverage Matrix

| FR    | Description                                           | Unit | Integration | E2E | Manual |
| ----- | ----------------------------------------------------- | ---- | ----------- | --- | ------ |
| FR-1  | Trigger creation shows Webhook, Cron, App Triggers    | -    | -           | -   | -      |
| FR-2  | App catalog fetched from ConnectorListingService      | -    | -           | -   | -      |
| FR-3  | Trigger events shown for selected app                 | -    | -           | -   | -      |
| FR-4  | OAuth connections listed/created for selected app     | -    | -           | -   | -      |
| FR-5  | App triggers registered as type: 'connector'          | -    | -           | -   | -      |
| FR-6  | ConnectorTriggerEngine calls onEnable on registration | -    | -           | -   | -      |
| FR-7  | onDisable called on deregistration                    | -    | -           | -   | -      |
| FR-8  | Legacy trigger types display correctly                | -    | -           | -   | -      |
| FR-9  | Catalog endpoint returns real connector data          | -    | -           | -   | -      |
| FR-10 | App trigger shows app name + event name in list       | -    | -           | -   | -      |
| FR-11 | App catalog supports text search/filtering            | -    | -           | -   | -      |

---

## E2E Test Scenarios

### E2E-1: Create App Trigger End-to-End

**Preconditions**: Authenticated user, project with a workflow, Activepieces connectors loaded
**Steps**:

1. `GET /api/projects/:projectId/workflows/:workflowId` — verify workflow exists
2. Navigate to Triggers tab
3. Click "New Trigger" → select "App Triggers"
4. Verify catalog grid loads with apps from `GET /api/connectors/triggers/catalog`
5. Select an app (e.g., Jira) → verify events dropdown populates
6. Select event (e.g., "Issue Created")
7. Create or select OAuth connection via `POST /api/projects/:projectId/connections`
8. Save trigger via `POST /api/projects/:projectId/workflows/triggers` with `type: 'connector'`
9. Verify trigger appears in list with app name + event name
10. Verify `TriggerRegistration` created with correct `connectorName`, `triggerName`, `connectionId`

**Auth context**: JWT with `workflow:write` permission, scoped to `tenantId` + `projectId`
**Isolation check**: Verify trigger not visible from different project/tenant

### E2E-2: App Trigger Fires Workflow Execution

**Preconditions**: Active app trigger registered (webhook strategy)
**Steps**:

1. Simulate external app webhook POST to `/webhooks/:connectorName/:registrationId`
2. Verify webhook signature validation passes
3. Verify workflow execution started via Restate
4. `GET /api/projects/:projectId/workflows/:workflowId/executions` — verify new execution with `triggerType: 'webhook'`
5. Verify trigger `lastFiredAt` updated

**Auth context**: Webhook request with HMAC signature (no JWT)
**Isolation check**: Webhook URL contains registration ID — wrong registration ID returns 404

### E2E-3: App Trigger Lifecycle (Pause/Resume/Delete)

**Preconditions**: Active app trigger
**Steps**:

1. `POST /api/projects/:projectId/workflows/triggers/:id/pause` — verify status changes to `paused`
2. Simulate webhook POST → verify trigger does NOT fire (status is paused)
3. `POST /api/projects/:projectId/workflows/triggers/:id/resume` — verify status changes to `active`
4. `DELETE /api/projects/:projectId/workflows/triggers/:id` — verify soft delete (status: `deleted`)
5. Verify `onDisable()` called to clean up webhook subscription

**Auth context**: JWT with `workflow:write` permission
**Isolation check**: Other tenant's `POST /pause` returns 404

### E2E-4: Reuse Existing Connection

**Preconditions**: User has existing Slack OAuth connection
**Steps**:

1. Create new app trigger, select Slack
2. Verify existing connection appears in connection selector
3. Select existing connection (no new OAuth required)
4. Save trigger
5. Verify `TriggerRegistration.connectionId` references existing connection

### E2E-5: Cross-Tenant Trigger Isolation

**Preconditions**: Tenant A has app trigger, Tenant B authenticated
**Steps**:

1. Tenant B: `GET /api/projects/:projectId/workflows/triggers` — verify Tenant A's triggers NOT returned
2. Tenant B: `POST /pause` on Tenant A's trigger ID — verify 404
3. Tenant B: `DELETE` Tenant A's trigger ID — verify 404

---

## Integration Test Scenarios

### INT-1: Trigger Catalog Returns Real Connector Data

**Steps**:

1. Load connectors via Activepieces importer
2. `GET /api/connectors/triggers/catalog`
3. Verify response contains connectors with `triggers` array
4. Verify only connectors with >= 1 trigger are included
5. Verify each trigger has `name`, `displayName`, `description`, `strategy`

### INT-2: ConnectorTriggerEngine Registers Webhook Trigger

**Steps**:

1. Call `triggerEngine.register({ type: 'connector', connectorName: 'github', triggerName: 'push', connectionId: '...' })`
2. Verify `TriggerRegistration` created in DB with `strategy: 'webhook'`
3. Verify `ConnectorTrigger.onEnable()` called

### INT-3: ConnectorTriggerEngine Registers Polling Trigger

**Steps**:

1. Call `triggerEngine.register({ type: 'connector', connectorName: 'gmail', triggerName: 'new-email', connectionId: '...' })`
2. Verify `TriggerRegistration` created with `strategy: 'polling'`
3. Verify BullMQ repeatable job created with correct interval

### INT-4: Trigger Deregistration Calls onDisable

**Steps**:

1. Register a webhook trigger
2. Call `triggerEngine.deregister(registrationId)`
3. Verify `ConnectorTrigger.onDisable()` called
4. Verify `TriggerRegistration.status` set to `deleted`

### INT-5: Hidden Types Still Display in Trigger List

**Steps**:

1. Insert trigger with `type: 'polling'` directly into DB
2. `GET /api/projects/:projectId/workflows/triggers`
3. Verify response includes the polling trigger with correct type/label

---

## Manual Test Scenarios

### MAN-1: OAuth Flow for Priority Apps

Test OAuth connection creation for Gmail, Jira, Slack, GitHub via Nango. Verify token storage and refresh.

### MAN-2: App Catalog UX Review

Verify catalog grid layout, search filtering, and responsiveness on desktop and mobile viewports.
