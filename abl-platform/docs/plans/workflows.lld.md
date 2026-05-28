# Workflows & Human Tasks -- Low-Level Design

> **Status**: DONE
> **Last Updated**: 2026-04-14

## Task T-1: Workflow Definition CRUD

### Files

- `apps/runtime/src/routes/workflows.ts` -- CRUD routes mounted at `/api/projects/:projectId/workflows`
- `apps/runtime/src/routes/workflow-helpers.ts` -- `denormalizeSteps()` utility
- `apps/runtime/src/services/stores/mongo-workflow-definition-store.ts` -- MongoDB store implementation

### Key Signatures

- `POST /` -- Create workflow (requires `workflow:create`)
- `GET /` -- Query workflows with type, status, limit, offset
- `GET /by-name` -- Lookup by name (query param)
- `GET /:id` -- Get by ID (with tenantId + projectId)
- `PUT /:id` -- Update (field-by-field picking to prevent prototype pollution)
- `POST /:id/archive` -- Soft archive with active session warning
- `POST /:id/associate-session` -- Link workflow to conversation session

### Design Notes

- Uses `createOpenAPIRouter` for auto-generated OpenAPI docs
- Auth: `authMiddleware` + `requireProjectScope` + `tenantRateLimit`
- Store delegates to `getStores().workflowDefinition` via factory pattern
- Audit: `auditWorkflowCreated`, `auditWorkflowUpdated`, `auditWorkflowArchived`

---

## Task T-2: Workflow Versioning

### Files

- `apps/runtime/src/routes/workflow-versions.ts` -- Version routes at `/:workflowId/versions`
- `apps/runtime/src/services/workflow-version-service.ts` -- Version lifecycle service

### Key Signatures

- `POST /` -- Create version from working copy
- `GET /` -- List versions
- `GET /:version` -- Get version detail
- `POST /:version/promote` -- Promote version status
- `GET /:version/diff/:otherVersion` -- Diff two versions

---

## Task T-3: Human Task Model

### Files

- `packages/database/src/models/human-task.model.ts` -- Mongoose model

### Key Types

- `HumanTaskType`: `'approval' | 'data_entry' | 'review' | 'decision' | 'escalation'`
- `HumanTaskStatus`: `'pending' | 'assigned' | 'in_progress' | 'completed' | 'expired' | 'cancelled'`
- `IHumanTaskSource`: Discriminated union with `workflow_approval`, `workflow_human_task`, `agent_escalation`
- `IHumanTaskFieldDef`: `{ name, type, label, required, options?, validation?, defaultValue? }`

### Design Notes

- Uses `uuidv7` for `_id`
- `tenantIsolationPlugin` enforces tenant scoping at query level
- Compound indexes: `{tenantId, projectId, status, createdAt}`, `{source.type, source.executionId, source.stepId}`, `{status, dueAt}`

---

## Task T-4: Human Task Routes

### Files

- `apps/runtime/src/routes/human-tasks.ts` -- Factory function `createHumanTaskRouter(deps)`

### Key Signatures

- `GET /` -- List tasks with filters (status, type, assignedTo, priority, limit, offset)
- `GET /:taskId` -- Get single task
- `POST /:taskId/assign` -- Assign to user or team
- `POST /:taskId/claim` -- Claim for live handling (sets `in_progress`, records `claimedBy`)
- `POST /:taskId/resolve` -- Submit response and dispatch to upstream source

### Design Notes

- Deps interface: `resolveApproval`, `resolveHumanTask`, `resolveEscalation`
- User isolation: non-admin users see only own tasks via `$or` filter
- Required field validation on resolve: checks task `fields[].required` against submitted `fields`
- Upstream dispatch is fire-and-forget after marking task complete (errors logged, not surfaced)
- Uses direct HumanTask model access (not store pattern -- GAP)

---

## Task T-5: Studio Workflow UI

### Files -- Canvas Builder

- `apps/studio/src/components/workflows/WorkflowsListPage.tsx` -- List page with search, status filter
- `apps/studio/src/components/workflows/WorkflowCard.tsx` -- Card component
- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx` -- Detail page with tabs
- `apps/studio/src/components/workflows/CreateWorkflowModal.tsx` -- Creation modal
- `apps/studio/src/components/workflows/canvas/WorkflowCanvas.tsx` -- ReactFlow canvas
- `apps/studio/src/components/workflows/canvas/WorkflowCanvasPage.tsx` -- Canvas page with debug panels
- `apps/studio/src/components/workflows/canvas/useAutoSave.ts` -- Auto-save hook
- `apps/studio/src/components/workflows/canvas/useExecutionPolling.ts` -- Execution polling hook
- `apps/studio/src/components/workflows/canvas/useWorkflowSave.ts` -- Save hook
- `apps/studio/src/components/workflows/canvas/useWorkflowValidation.ts` -- Validation hook
- `apps/studio/src/components/workflows/canvas/nodes/WorkflowNodeComponent.tsx` -- Generic node
- `apps/studio/src/components/workflows/canvas/nodes/StartNodeComponent.tsx` -- Start node
- `apps/studio/src/components/workflows/canvas/nodes/EndNodeComponent.tsx` -- End node
- `apps/studio/src/components/workflows/canvas/config/*.tsx` -- 16 node config panels (Api, Condition, DataEntry, DynamicAction, End, Expression, Function, FunctionEditor, Generic, Human, Integration, IntegrationPicker, Loop, Start, TextToText, Connections)
- `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx` -- Debug flow log
- `apps/studio/src/components/workflows/canvas/panels/WorkflowDebugPanel.tsx` -- Debug panel
- `apps/studio/src/components/workflows/tabs/WorkflowStepsTab.tsx` -- Steps config
- `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` -- Triggers config
- `apps/studio/src/components/workflows/tabs/WorkflowMonitorTab.tsx` -- Monitoring
- `apps/studio/src/components/workflows/tabs/WorkflowOverviewTab.tsx` -- Overview
- `apps/studio/src/components/workflows/tabs/WorkflowErrorTab.tsx` -- Errors
- `apps/studio/src/components/workflows/tabs/WorkflowNotificationsTab.tsx` -- Notifications

---

## Task T-6: Studio Inbox

### Files

- `apps/studio/src/components/inbox/UnifiedInboxPage.tsx` -- Unified inbox with task list, filters, priority badges
- `apps/studio/src/components/inbox/TaskCard.tsx` -- Task card with response formatting, connector ticket links
- `apps/studio/src/components/inbox/EscalationPanel.tsx` -- Escalation chain display
- `apps/studio/src/components/inbox/DynamicForm.tsx` -- Dynamic form rendering for human task fields
- `apps/studio/src/api/human-tasks.ts` -- API client (list, get, assign, claim, resolve with priority filter)

### Design Notes

- Unified inbox replaces the original approval-only InboxPage
- TaskCard renders connectorTicketUrl + connectorTicketId as clickable links
- useHumanTasks hook forwards priority query param for server-side filtering
- Approve/reject/resolve actions with toast feedback
- 5s polling interval for task list refresh

---

## Known Gaps (Updated 2026-04-14)

### Resolved

- ~~Human task routes have no test coverage~~ -- `human-task-routes.test.ts` has 2 tests (list scoping, claim)
- ~~No SLA breach enforcement~~ -- SLA checker implemented for agent-escalation tasks; workflow tasks use Restate durable timers

### Remaining

- Direct Mongoose model access in human task routes (should use store pattern)
- No escalation chain automation (escalation chain field exists but automatic progression not wired)
- No real HTTP E2E tests (Express server + MongoDB) for workflow-engine service
- No GDPR right-to-erasure cascade for workflow data
