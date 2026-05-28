# Workflows Studio + Runtime Production Implementation Spec

Status: Proposed  
Date: 2026-03-08  
Audience: Studio, Runtime, Workflow Engine, Platform, QA, SRE  
Primary objective: make workflow authoring in Studio reliable and independent from workflow-engine execution availability, while keeping runtime execution correct, secure, and scalable.

## 1. Problem Statement

Workflow UI is still flaky and not production-grade. The main failure pattern is not one bug; it is contract drift across Studio, runtime, workflow-engine, and database models.

Current high-impact issues:

- Step contracts are inconsistent across editor payloads, runtime denormalization, and executor expectations.
- Control-flow authoring is incomplete for condition/parallel/loop.
- Notification schemas and event models conflict across Studio, engine routes, DB schema, and dispatcher.
- Routing/wiring has path mismatches and route shadowing risks.
- Trigger readiness is not strongly validated when scheduler/connector trigger engine dependencies are unavailable.
- Project isolation is incomplete in a few workflow-session operations.
- Lifecycle is missing a true draft/publish model.

## 2. Goals

- Deliver stable workflow creation, editing, and publish flows in Studio.
- Ensure Studio authoring works even when workflow-engine is degraded or unavailable.
- Enforce one canonical contract for all step, trigger, and notification models.
- Guarantee tenant + project isolation for all workflow operations.
- Add deterministic validation and error messaging before publish and before execute.
- Establish release gates proving every trigger and action works in Studio and runtime.

## 3. Non-Goals

- Replacing Restate or redesigning execution orchestration.
- Rebuilding all connector internals.
- Introducing multi-tenant cross-project workflows.

## 4. Scope

In scope systems:

- `apps/studio`
- `apps/runtime`
- `apps/workflow-engine`
- `packages/database`
- shared types/contracts package

Key source files impacted:

- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/components/workflows/steps/StepEditor.tsx`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/components/workflows/tabs/WorkflowStepsTab.tsx`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/components/workflows/tabs/WorkflowNotificationsTab.tsx`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/hooks/useWorkflowDetail.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/routes/workflows.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/routes/workflow-helpers.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/middleware/workflow-engine-proxy.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/workflow-engine/src/routes/notification-rules.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/workflow-engine/src/handlers/step-dispatcher.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/workflow.model.ts`

## 5. Target Architecture

Design principles:

- Studio is the authoring surface and must remain operable when engine execution plane is unhealthy.
- Runtime is the control-plane gateway and authoritative API boundary for Studio.
- Workflow-engine is execution-plane and trigger/notification processing.
- Contracts are shared, versioned, and validated at each boundary.

Layer boundaries:

- Studio -> Runtime:
  - Authoring API: CRUD draft workflows, validate workflows, publish workflows, list versions.
  - Runtime-only dependency for authoring.
- Runtime -> Workflow-engine:
  - Execution API: run/cancel/list executions.
  - Trigger lifecycle API.
  - Notification dispatch lifecycle API.

## 6. Canonical Contract Design

Create shared package:

- `packages/workflow-contracts`
- Use `zod` as source of truth.
- Generate TypeScript types from zod directly.

Canonical entities:

- `WorkflowDraft`
- `WorkflowPublishedVersion`
- `WorkflowStep`
- `TriggerRegistrationRequest`
- `NotificationRule`
- `WorkflowValidationResult`

Step contract rules:

- Each step type has strict schema.
- Fields with JSON semantics are stored as objects, not JSON strings.
- UI textareas parse JSON locally into typed objects.
- Runtime rejects malformed schema with field-level errors.

Control-flow representation:

- `condition` stores `thenStepIds` and `elseStepIds`.
- `parallel` stores explicit `branches[]` where each branch has `stepIds[]`.
- `loop` stores `collectionExpression`, `itemVariable`, and `bodyStepIds[]`.

Notification contract:

- Canonical: `name`, `events[]`, `channel { type, target, connectionId? }`, `enabled`.
- Event enum and channel enum shared by Studio + runtime + engine + DB.
- Remove legacy `event` singular form from contracts.

## 7. Workflow Lifecycle Model

Status model:

- `draft`
- `published`
- `paused`
- `archived`

Lifecycle transitions:

- `create` -> `draft`
- `draft` -> `published` via explicit publish endpoint with validation gate
- `published` <-> `paused`
- `published|paused|draft` -> `archived`

Behavior rules:

- Studio edits only draft revision.
- Execute operations use latest published revision by default.
- Optional execute override for draft allowed only in non-prod or admin mode.

## 8. API Specification

Runtime authoring endpoints:

- `POST /api/projects/:projectId/workflows` create draft
- `GET /api/projects/:projectId/workflows/:workflowId` get draft + published metadata
- `PUT /api/projects/:projectId/workflows/:workflowId` update draft
- `POST /api/projects/:projectId/workflows/:workflowId/validate` validate draft
- `POST /api/projects/:projectId/workflows/:workflowId/publish` publish draft as immutable version
- `GET /api/projects/:projectId/workflows/:workflowId/versions` list versions
- `POST /api/projects/:projectId/workflows/:workflowId/rollback/:version` rollback by creating new draft from version

Runtime execution endpoints:

- `POST /api/projects/:projectId/workflows/:workflowId/executions/execute`
- `GET /api/projects/:projectId/workflows/:workflowId/executions`
- `GET /api/projects/:projectId/workflows/:workflowId/executions/:executionId`
- `POST /api/projects/:projectId/workflows/:workflowId/executions/:executionId/cancel`

Trigger endpoints:

- `GET /api/projects/:projectId/workflows/triggers`
- `POST /api/projects/:projectId/workflows/triggers`
- `POST /api/projects/:projectId/workflows/triggers/:id/pause`
- `POST /api/projects/:projectId/workflows/triggers/:id/resume`
- `DELETE /api/projects/:projectId/workflows/triggers/:id`

Notification endpoints:

- `GET /api/projects/:projectId/workflows/:workflowId/notifications`
- `POST /api/projects/:projectId/workflows/:workflowId/notifications`
- `PUT /api/projects/:projectId/workflows/:workflowId/notifications/:ruleId`
- `DELETE /api/projects/:projectId/workflows/:workflowId/notifications/:ruleId`
- `POST /api/projects/:projectId/workflows/:workflowId/notifications/:ruleId/test`

Error envelope:

- Standardized: `{ success: false, error: { code, message, fieldErrors? } }`

## 9. Security and Isolation Requirements

Hard requirements:

- Every workflow query/update scoped by `tenantId` and `projectId`.
- `associate-session` must verify session belongs to same tenant and project.
- Archive warning session count must include tenant+project filters.
- No authoring route should require workflow-engine connectivity.
- SSRF guard remains mandatory for HTTP and async webhook steps.

Permissions:

- Authoring: `workflow:create`, `workflow:read`, `workflow:update`, `workflow:delete`.
- Publish: `workflow:publish` or `workflow:update` + publish feature gate.
- Execute: `workflow:execute`.
- Approval actions: `approval:write`.

## 10. Performance and Reliability Requirements

Write path:

- Replace full-document step autosave with patch-based updates.
- Add optimistic concurrency via `version` field (`If-Match` style or explicit version number).

Read path:

- Workflow list endpoints return summaries only.
- Detail endpoints provide expanded payload.

SLO targets:

- P95 draft save < 400ms at control-plane gateway.
- P95 workflow detail load < 600ms.
- Trigger create/pause/resume success rate > 99.9%.

## 11. UX Requirements for Studio

Must-have UX:

- Inline schema validation for all fields.
- JSON editor with parse feedback and auto-format.
- Deterministic autosave state indicator.
- Explicit publish readiness checklist.
- Engine health badges for Trigger/Monitor/Notification tabs.
- Clear error states for dependency outages.

Control-flow authoring UX:

- Visual branch mapping for condition and parallel.
- Loop body editor with explicit step references.
- Drag-reorder implemented if drag handle is visible.

## 12. Migration Plan

Migration A: notifications schema harmonization

- Add new canonical fields while preserving read compatibility.
- Backfill legacy notification records to new schema.
- Update read mapper to support both old and new during migration window.
- Remove legacy support after two stable releases.

Migration B: step payload normalization

- Parse existing string JSON fields where possible.
- Flag unparseable fields with migration audit report.
- Keep original payload snapshot for rollback.

Migration C: workflow lifecycle

- Existing active workflows become `published`.
- Create initial draft from current published payload for editability.

## 13. Implementation Plan by Phase

Phase 0: Stabilization and Safety

- Freeze non-critical workflow feature changes.
- Add route-level regression tests for execute/triggers/notifications path wiring.
- Add temporary observability logs for contract mismatches.
- Exit criteria: reproducible failing scenarios captured in tests.

Phase 1: Shared Contracts

- Build `packages/workflow-contracts`.
- Replace ad-hoc types in Studio and runtime with shared contracts.
- Introduce runtime request validation middleware for workflow payloads.
- Exit criteria: all workflow API tests use shared schemas.

Phase 2: Runtime Routing and Isolation Fixes

- Fix route shadowing (`/triggers`, `/approvals`, other special routes) before `/:id`.
- Fix execute path consistency from Studio through runtime to engine.
- Patch `associate-session` and archive session count scoping.
- Exit criteria: authz/isolation tests pass and no shadow regressions.

Phase 3: Step Editor and Control-flow Completion

- Implement type-safe editors for all supported step types.
- Implement condition/parallel/loop authoring with explicit step references.
- Wire agent list source for `agent_invocation`.
- Exit criteria: can author, save, reload, and execute all step types from Studio.

Phase 4: Notification Model Unification

- Align Studio UI options with canonical events/channels.
- Align engine route validation and DB schema with shared contract.
- Wire notification dispatch from runtime execution events.
- Exit criteria: create/list/update/delete/test works; actual dispatch verified.

Phase 5: Trigger Readiness and Dependency Handling

- Trigger create fails fast when scheduler/connector trigger engine unavailable.
- Add readiness diagnostics endpoint for trigger dependencies.
- Implement or hide unsupported trigger types behind feature flag.
- Exit criteria: no "registered but non-functional" triggers.

Phase 6: Draft/Publish Lifecycle

- Add draft/publish/version endpoints and UI.
- Add publish validation and blocking errors.
- Add rollback flow.
- Exit criteria: full create-edit-publish-pause-archive path works in Studio.

Phase 7: Performance and Concurrency

- Move to patch-based saves and version conflict handling.
- Add payload size reductions on list APIs.
- Exit criteria: P95 latencies within targets and no stale overwrites.

Phase 8: Hardening and Release

- Full regression and load testing.
- Canary release with telemetry gates.
- Progressive rollout by tenant/project flags.
- Exit criteria: release gates all green for two consecutive days.

## 14. Test Strategy

Unit tests:

- Shared contract parsers/serializers.
- Step editor parse/transform logic.
- Runtime denormalize/normalize removal or compatibility shims.

Integration tests:

- Studio API routes -> runtime route mapping.
- Runtime -> workflow-engine proxy and auth propagation.
- Notification CRUD + dispatch with canonical model.
- Trigger registration lifecycle with and without scheduler dependencies.

E2E tests:

- Studio-only create/edit/publish flow without direct API seeding.
- All step types authoring and successful execution.
- All trigger types available in UI and functional at runtime.
- Notification rules create + real delivery test path.
- Degraded dependency behavior (engine down, Redis down, connector engine down).

Security tests:

- Tenant and project isolation for all workflow routes.
- Permission matrix checks for every mutation endpoint.

### 14.1 Detailed Test Case Catalog (Must-Pass Before Production)

Format:

- `ID` | `Type` | `Scenario` | `Expected Result`

Contract and serialization tests:

- `WF-CONTRACT-001` | Unit | Parse valid `connector_action` step payload | schema parse succeeds with typed `params` object
- `WF-CONTRACT-002` | Unit | Parse `connector_action.params` as JSON string | parse fails with `fieldErrors.params` (no silent coercion)
- `WF-CONTRACT-003` | Unit | Parse valid `http.headers` object | schema parse succeeds
- `WF-CONTRACT-004` | Unit | Parse `http.headers` as raw string | parse fails with clear field error
- `WF-CONTRACT-005` | Unit | Parse `approval.approvers` array | schema parse succeeds
- `WF-CONTRACT-006` | Unit | Parse `approval.approvers` comma-separated string | parse fails and provides remediation hint
- `WF-CONTRACT-007` | Unit | Parse `delay.duration` in supported format | parse succeeds and canonical value retained
- `WF-CONTRACT-008` | Unit | Parse unsupported `delay.duration` format | parse fails deterministically
- `WF-CONTRACT-009` | Unit | Parse `condition` without `thenStepIds` | parse fails
- `WF-CONTRACT-010` | Unit | Parse `parallel` branch without `stepIds` | parse fails
- `WF-CONTRACT-011` | Unit | Parse `loop` without `bodyStepIds` | parse fails
- `WF-CONTRACT-012` | Unit | Parse notification with unknown event | parse fails with event enum list
- `WF-CONTRACT-013` | Unit | Parse notification with `channel.type=teams` when enum is `msteams` | parse fails
- `WF-CONTRACT-014` | Unit | Parse trigger registration request with unsupported type | parse fails
- `WF-CONTRACT-015` | Unit | Round-trip Studio form model -> runtime contract -> DB document | no field loss or type mutation

Runtime routing and proxy tests:

- `WF-ROUTE-001` | Integration | `GET /workflows/triggers` with existing workflow ID named "triggers" | route resolves to trigger list endpoint, never `/:id`
- `WF-ROUTE-002` | Integration | `GET /workflows/connectors` | route resolves to connectors endpoint, never `/:id`
- `WF-ROUTE-003` | Integration | `GET /workflows/approvals` | route resolves to approvals proxy, never `/:id`
- `WF-ROUTE-004` | Integration | Studio execute route path | runtime receives path that is actually mounted and returns 202
- `WF-ROUTE-005` | Integration | Studio notifications list route | proxy forwards tenant and auth headers correctly
- `WF-ROUTE-006` | Integration | Studio trigger pause/resume routes | runtime proxy forwards correct registration ID and method
- `WF-ROUTE-007` | Integration | runtime proxy when workflow-engine unavailable | returns structured 502 with stable error code
- `WF-ROUTE-008` | Integration | runtime proxy forwards `X-Tenant-Id` and `Authorization` | workflow-engine sees both headers
- `WF-ROUTE-009` | Integration | query-string forwarding for trigger list (`workflowId`) | query preserved end-to-end
- `WF-ROUTE-010` | Integration | runtime route order regression guard | test fails if reserved routes are mounted after `/:id`

Studio authoring behavior tests:

- `WF-STUDIO-001` | E2E | Create workflow from Studio modal | workflow lands in `draft` with valid ID and detail page opens
- `WF-STUDIO-002` | E2E | Edit workflow overview name/description and reload | values persist after hard reload
- `WF-STUDIO-003` | E2E | Add each step type from StepTypeSelector | each type renders editor and saves without JS errors
- `WF-STUDIO-004` | E2E | Invalid JSON in `http.headers` editor | inline validation blocks save/publish
- `WF-STUDIO-005` | E2E | Valid JSON auto-format in params editor | value is normalized and saved as typed object
- `WF-STUDIO-006` | E2E | Drag handle visible in step list | reorder actually changes persisted `position`
- `WF-STUDIO-007` | E2E | Step autosave indicator | shows `saving` then `saved` state, no silent failures
- `WF-STUDIO-008` | E2E | Concurrent tab edit of same workflow | conflict surfaced, no silent overwrite
- `WF-STUDIO-009` | E2E | Agent invocation step selector | agent list loads from project API and persists selected ID
- `WF-STUDIO-010` | E2E | Trigger tab while engine unhealthy | clear degraded-state UI, no infinite spinner
- `WF-STUDIO-011` | E2E | Notifications tab list/create/delete | list reflects API mutations immediately
- `WF-STUDIO-012` | E2E | Publish workflow with missing required fields | publish blocked with per-field validation
- `WF-STUDIO-013` | E2E | Publish workflow after fixing validation | publish succeeds and version recorded
- `WF-STUDIO-014` | E2E | Edit published workflow | edits go to draft, published version remains immutable
- `WF-STUDIO-015` | E2E | Rollback to older version | new draft seeded from selected version

Control-flow correctness tests:

- `WF-CF-001` | Integration | Condition step true branch path | only `thenStepIds` execute in order
- `WF-CF-002` | Integration | Condition step false branch path | only `elseStepIds` execute in order
- `WF-CF-003` | Integration | Parallel step with `fail_fast` | first branch failure stops remaining branches
- `WF-CF-004` | Integration | Parallel step with `wait_all` | all branches complete and failures captured
- `WF-CF-005` | Integration | Loop step with `bodyStepIds` | body executes once per item and context vars set correctly
- `WF-CF-006` | Integration | Loop max-iteration guard | execution halts safely when limit exceeded
- `WF-CF-007` | Integration | Nested control-flow (condition inside loop) | deterministic execution graph and status updates

Trigger lifecycle tests:

- `WF-TRIGGER-001` | Integration | Create webhook trigger | registration persists and webhook URL/secret generated
- `WF-TRIGGER-002` | Integration | Fire webhook trigger | execution created with expected trigger metadata
- `WF-TRIGGER-003` | Integration | Create cron trigger with scheduler up | scheduler job created and registration active
- `WF-TRIGGER-004` | Integration | Create cron trigger with scheduler down | request fails with dependency-unavailable error
- `WF-TRIGGER-005` | Integration | Create connector trigger with connector engine up | registration active and connector trigger registered
- `WF-TRIGGER-006` | Integration | Create connector trigger with connector engine down | request fails, no "active but dead" registration
- `WF-TRIGGER-007` | Integration | Pause trigger | registration status becomes paused and scheduled job removed
- `WF-TRIGGER-008` | Integration | Resume trigger | registration status active and scheduled job restored
- `WF-TRIGGER-009` | Integration | Deregister trigger | registration soft-deleted and denormalized workflow trigger removed
- `WF-TRIGGER-010` | E2E | Trigger tab list reflects lifecycle changes | add/pause/resume/delete visible without stale states

Notification model and delivery tests:

- `WF-NOTIFY-001` | Integration | Create notification with canonical event + channel | stored and retrievable via list API
- `WF-NOTIFY-002` | Integration | Reject non-canonical event (`approval.requested` if enum differs) | 400 with enum guidance
- `WF-NOTIFY-003` | Integration | Reject non-canonical channel (`teams` vs `msteams`) | 400 with enum guidance
- `WF-NOTIFY-004` | Integration | Update notification rule events/channels | validation and persistence both succeed
- `WF-NOTIFY-005` | Integration | Delete notification rule | removed from subsequent list responses
- `WF-NOTIFY-006` | Integration | Test notification endpoint | dispatcher invoked with correct tenant and channel payload
- `WF-NOTIFY-007` | Integration | Workflow emits `workflow.failed` event | matching notification rules are dispatched
- `WF-NOTIFY-008` | Integration | Workflow emits `step.waiting_approval` event | matching rules dispatched once per step pause
- `WF-NOTIFY-009` | Integration | Dispatcher adapter failure | workflow continues and failure is logged/metriced
- `WF-NOTIFY-010` | Migration | Legacy notification documents read path | legacy docs are transformed to canonical API response

Isolation and authorization tests:

- `WF-ISO-001` | Integration | Get workflow by ID from wrong tenant | 404 (not 403 leak) and no data returned
- `WF-ISO-002` | Integration | List workflows from project A while scoped to project B | only project B data returned
- `WF-ISO-003` | Integration | `associate-session` with session in different project | request rejected with 403/404 and no mutation
- `WF-ISO-004` | Integration | Archive workflow active-session warning | session count scoped by tenant+project+workflow
- `WF-ISO-005` | Integration | Trigger list with tenant mismatch | no cross-tenant registrations visible
- `WF-ISO-006` | Integration | Notification CRUD with wrong tenant context | no cross-tenant mutation possible
- `WF-ISO-007` | Integration | Viewer role attempts workflow update | 403 with required permission in message
- `WF-ISO-008` | Integration | Developer role full workflow lifecycle | allowed per permission matrix
- `WF-ISO-009` | Integration | Approval write route requires approval permission | unauthorized role blocked
- `WF-ISO-010` | Integration | Audit log integrity for create/update/archive | records contain actor, tenant, project, workflow IDs

Degraded dependency and resilience tests:

- `WF-RES-001` | Integration | workflow-engine down during executions list | Studio shows degraded card and retry action
- `WF-RES-002` | Integration | Redis unavailable on trigger operations | trigger endpoints return explicit dependency error
- `WF-RES-003` | Integration | connector registry unavailable in step editor | UI explains unavailable connectors without crash
- `WF-RES-004` | Integration | partial outage during autosave | user sees save error and can retry safely
- `WF-RES-005` | Integration | non-JSON proxy response from downstream | client receives sanitized structured error
- `WF-RES-006` | E2E | rapid tab switches during load/errors | no React hydration/runtime crashes

Performance and concurrency tests:

- `WF-PERF-001` | Perf | Patch-save latency under nominal load | P95 below 400ms
- `WF-PERF-002` | Perf | Workflow detail load with 200-step workflow | P95 below 600ms
- `WF-PERF-003` | Perf | Trigger list with 1k registrations | response within agreed latency budget
- `WF-PERF-004` | Concurrency | simultaneous updates with stale version token | one succeeds, one gets conflict response
- `WF-PERF-005` | Concurrency | retry after conflict with refreshed version | second save succeeds without data loss

Migration validation tests:

- `WF-MIG-001` | Migration | Backfill notifications old->new schema | all records converted and validated
- `WF-MIG-002` | Migration | Backfill malformed step JSON fields | failures captured in migration report, no silent corruption
- `WF-MIG-003` | Migration | Lifecycle migration active->published + draft seed | both views retrievable post-migration
- `WF-MIG-004` | Migration | rollback migration dry-run | report generated with no writes
- `WF-MIG-005` | Migration | rollback execution after failed migration batch | data restored from snapshot

Release gate rule:

- No production rollout unless all tests tagged `wf-prod-gate` pass in CI on two consecutive runs.

## 15. Rollout Plan

Rollout stages:

- Stage 1: internal dev tenants only.
- Stage 2: selected low-risk pilot tenants.
- Stage 3: 25% production tenants.
- Stage 4: 100% rollout.

Rollback strategy:

- Feature flags for draft/publish lifecycle and new notification model.
- Backward-compatible readers during migration window.
- Rollback by disabling feature flags and using legacy read paths.

## 16. Monitoring and Operational Readiness

Required dashboards:

- Workflow save success/error rates by endpoint.
- Publish validation failure reasons.
- Trigger registration and fire success rates.
- Notification dispatch attempts/failures by channel.
- Execution failure categories by step type.

Required alerts:

- Trigger registration success with zero scheduled jobs.
- Execute API non-2xx spike.
- Notification delivery failure rate threshold breach.
- Contract validation failure spike.

## 17. Delivery Timeline

Estimated timeline: 8 to 10 weeks

- Week 1: Phase 0
- Weeks 2-3: Phase 1
- Week 4: Phase 2
- Weeks 5-6: Phase 3
- Week 7: Phase 4
- Week 8: Phase 5
- Week 9: Phase 6
- Week 10: Phase 7 + Phase 8 hardening

## 18. Definition of Done

- Studio can fully author workflows with all supported step types and control-flow.
- Publish lifecycle is enforced and validated.
- Runtime and engine contracts are shared and versioned.
- Notifications and triggers are fully functional and validated end-to-end.
- Tenant/project isolation and authz tests pass for all workflow endpoints.
- Performance and reliability SLOs are met under expected load.

## 19. Immediate Next Implementation Tasks

- Create `packages/workflow-contracts` and migrate Studio/runtime types.
- Fix runtime route shadowing for `/triggers` and other reserved subpaths.
- Fix execute route path consistency from Studio to runtime.
- Align notification schemas across Studio UI, runtime, engine, and DB model.
- Implement control-flow authoring for condition/parallel/loop in Studio.
