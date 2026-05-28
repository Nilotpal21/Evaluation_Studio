# SDLC Log: Session Timeout & Disposition Unification — Implementation Phase

**Feature**: session-timeout-disposition-unification
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/session-timeout-disposition-unification.lld.md`
**Date Started**: 2026-03-30
**Date Completed**: IN PROGRESS

---

## Preflight

- [x] LLD file paths verified — slice 1A targets exist in `packages/database`, `packages/compiler`, `apps/runtime`, and `packages/eventstore`
- [x] Function signatures current — `ProjectSettings`, compiler IR execution config, runtime event-bus payloads, and EventStore session-event schemas match the planned additive slice entry point
- [x] Recent changes reviewed — recent compiler/database/event work exists, but no blocking semantic conflict with additive lifecycle groundwork
- Dirty tree note: existing changes in `apps/studio/next-env.d.ts`, lifecycle docs, and `packages/database/.claude/` were left untouched

## Phase Execution

### Phase 1: Shared Lifecycle Core and Contracts

- **Status**: DONE
- **Slices Completed**: 1A schema/contracts, 1B compare-only services, 1C additive event widening
- **Exit Criteria**: all met
  - [x] `pnpm build --filter=@agent-platform/database --filter=@abl/compiler --filter=@abl/eventstore --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @abl/compiler test -- src/__tests__/ir/session-lifecycle-ir.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/execution/event-bus/types.test.ts src/services/session-lifecycle/__tests__/policy-service.test.ts src/services/session-lifecycle/__tests__/disposition-service.test.ts`
  - [x] `pnpm --filter @agent-platform/pipeline-engine test -- src/__tests__/integration-trigger-execution.test.ts`
  - [x] `ProjectSettings` has additive `sessionLifecycle` storage shape
  - [x] Compiler emits additive `execution.sessionLifecycle` while preserving `execution.timeouts.session_timeout_ms`
  - [x] Compare-only runtime `SessionLifecyclePolicyService` and `SessionDispositionService` exist with unit coverage
  - [x] Runtime and EventStore `session.ended` contracts accept canonical lifecycle fields additively
- **Files Changed**: 14
- **Deviations**: Kept the new policy/disposition services pure and unwired in this phase so the slice remains no-regression and compare-only.

### Phase 2: Runtime Terminalization and Event Emission

- **Status**: DONE
- **Slices Completed**: 2A read-only lifecycle routes and effective-policy inspection, 2B explicit close and bulk-close terminalization behind feature flag, 2C cleanup-job terminalization through shared lifecycle services
- **Slice 2A Exit Criteria**: met
  - [x] `GET /api/projects/:projectId/session-lifecycle` returns saved lifecycle overrides with flattened transfer TTL overrides
  - [x] `GET /api/projects/:projectId/session-lifecycle/effective` resolves tenant, project, agent, and transfer TTL provenance without changing live runtime behavior
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/project-session-lifecycle.integration.test.ts src/__tests__/project-session-lifecycle.e2e.test.ts`
- **Slice 2B Exit Criteria**: met
  - [x] `POST /api/projects/:projectId/sessions/:id/close` routes through `SessionTerminalizationService` when `SESSION_TERMINALIZATION_ENABLED=true`
  - [x] `POST /api/projects/:projectId/sessions/bulk-close` routes through `SessionTerminalizationService` when `SESSION_TERMINALIZATION_ENABLED=true`
  - [x] Successful explicit close and bulk-close paths emit exactly one canonical `session.ended` event with normalized `disposition`, `status`, and `terminalSource`
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/terminalization-service.test.ts src/__tests__/session-terminalization.integration.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/session-terminalization.e2e.test.ts`
- **Slice 2C Exit Criteria**: met with documented E2E substitution
  - [x] Runtime session creation resolves timeout policy through the shared lifecycle service, including project and agent precedence
  - [x] Cleanup terminalization routes through `SessionTerminalizationService` when `SESSION_TERMINALIZATION_ENABLED=true`
  - [x] Cleanup keeps canonical `timeout` vs `unengaged` differentiation
  - [x] Successful cleanup terminalization emits exactly one canonical `session.ended` event
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/runtime-policy-service.test.ts src/services/session-lifecycle/__tests__/terminalization-service.test.ts src/__tests__/session-runtime-timeouts.integration.test.ts src/__tests__/session-cleanup-terminalization.integration.test.ts src/__tests__/sessions/session-cleanup-retention.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/session-cleanup-terminalization.e2e.test.ts`
- **Files Changed**: 17
- **Deviations**: Effective-policy inspection surfaces current transfer TTL provenance as `project.agentTransfer.ttl.*` or `legacy.default` so this phase reflects live behavior before transfer TTL unification rewires callers in Phase 4. The legacy `src/__tests__/sessions/session-routes.test.ts` file is excluded by current runtime Vitest config, so route regression coverage for slice 2B is carried by the new service unit tests plus real-route integration and full-server E2E coverage. Slice 2C keeps project runtime override verification at integration level because `project-io/import` does not yet persist `config/project-settings.json` into the working-copy shape read by the lifecycle route, so the full-server cleanup E2E uses the API-importable agent lifecycle override path instead.

### Phase 3: Channel Disconnect, SDK Convergence, and End Hooks

- **Status**: DONE
- **Slices Completed**: 3A shared disconnect-policy resolution in live channel callers, 3B SDK `end_session` terminalization through shared lifecycle service, 3C project/channel end hooks and lifecycle write surface
- **Slice 3A Exit Criteria**: met
  - [x] Channel disconnect behavior now resolves through `SessionRuntimePolicyService` in the shared lifecycle manager, debug websocket handler, and SDK websocket handler
  - [x] Legacy per-channel fallback defaults remain in place when shared policy resolution returns no value
  - [x] Project channel overrides affect live disconnect cleanup for `voice`, `web_debug`, and `web_chat`
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/runtime-policy-service.test.ts src/channels/pipeline/__tests__/lifecycle-manager.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/ws-handler.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/project-session-lifecycle.e2e.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/channels/channels-sdk-runtime.e2e.test.ts --testNamePattern "packaged SDK bootstraps through sdk/init, authenticates via WebSocket subprotocol, and uploads attachments through the scoped SDK route"`
- **Slice 3B Exit Criteria**: met
  - [x] SDK `end_session` still acknowledges the client and closes the socket with a clean explicit end path
  - [x] SDK explicit end now routes through `SessionTerminalizationService` when `SESSION_TERMINALIZATION_ENABLED=true`
  - [x] SDK explicit end emits one canonical `session.ended` event with `terminalSource='sdk_end_session'`
  - [x] Explicit SDK end still performs paused-execution cleanup, auth-gate cleanup, and artifact cleanup without regressing detach-default channel behavior
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/channels/ws-sdk-handler.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/session-terminalization-sdk.integration.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/session-terminalization-sdk.e2e.test.ts`
- **Slice 3C Exit Criteria**: met
  - [x] End hooks run only after terminalization persists state and emits `session.ended`
  - [x] Only `ignore` and `respond` hook modes are accepted by runtime lifecycle settings
  - [x] Project-level hook config with channel override is enforced, and no agent-level hook override is consulted
  - [x] `PATCH /api/projects/:projectId/session-lifecycle` merges lifecycle updates without replacing unrelated runtime/channel settings
  - [x] SDK explicit end on a detach-default `web_chat` channel honors both `respond` and `ignore` hook modes without regressing terminalization
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/end-hook-runner.test.ts src/services/session-lifecycle/__tests__/runtime-policy-service.test.ts src/services/session-lifecycle/__tests__/terminalization-service.test.ts src/channels/pipeline/__tests__/lifecycle-manager.test.ts src/__tests__/channels/ws-sdk-handler.test.ts src/__tests__/channels/ws-handler.test.ts src/__tests__/project-session-lifecycle.integration.test.ts src/__tests__/project-session-lifecycle.e2e.test.ts src/__tests__/session-terminalization-sdk.integration.test.ts src/__tests__/session-terminalization-sdk.e2e.test.ts`
- **Files Changed**: 18
- **Deviations**: The heavy SDK runtime channel E2E is excluded from the default unit-test Vitest config, so slice 3A runs it explicitly through `vitest.e2e.config.ts`. Slice 3C adds `PATCH` as the canonical merge-based lifecycle write surface while keeping `PUT` as a replace-style compatibility path because the repo already uses `PUT` for adjacent config routes. Project-admin-versus-viewer write authorization is covered at integration level, while the full-server E2E route auth case remains API-only with a non-member caller because the platform still lacks a public project-member management API. The route-focused harness tests continue to emit non-blocking Mongo audit-log shutdown warnings during teardown after the main assertions pass.

### Phase 4: Agent-Transfer Lifecycle Alignment

- **Status**: DONE
- **Slices Completed**: 4A transfer-session TTL policy injection for create and extend paths, 4B structured transfer end metadata write path, 4C parent-conversation terminalization through the shared lifecycle service
- **Slice 4A Exit Criteria**: met
  - [x] Transfer-session create paths now resolve `project.agentTransfer.session.ttl` overrides before calling the Redis-backed store
  - [x] Transfer-session extend paths now re-resolve project TTL policy and pass the effective TTL plus channel hint into the store
  - [x] Transfer-session creation persists `projectId` through both Kore and Five9 adapter paths so runtime can resolve project policy on subsequent extends
  - [x] `pnpm build --filter=@agent-platform/agent-transfer --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/runtime-policy-service.test.ts src/__tests__/agent-transfer-boot.test.ts`
  - [x] `pnpm --filter @agent-platform/agent-transfer test -- src/adapters/five9/__tests__/five9-adapter.test.ts src/__tests__/kore-adapter-key-fixes.test.ts`
  - [x] `AGENT_TRANSFER_E2E=1 pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/five9-transfer.e2e.test.ts`
- **Files Changed**: 10
- **Deviations**: Slice 4A deliberately preserves current live fallback semantics by resolving transfer TTL as `project override -> legacy store default`; it does not yet adopt the config-schema defaults because that alignment is reserved for the later compatibility/defaults slice. The Five9 transfer E2E fixture needed two non-product corrections while validating this slice: its host setup now respects the real SSRF guard by using a public-safe hostname that the custom fetch rewrites to the local mock server, and its metadata mock now matches the current `Five9Client` contract (`context.farmId` and `metadata.dataCenters[].apiUrls[{host,port}]`).
- **Slice 4B Exit Criteria**: partially complete for the metadata-write path
  - [x] `POST /api/v1/agent-transfer/sessions/:id/end` accepts an optional structured JSON body without breaking legacy empty-body callers
  - [x] Structured end payloads persist normalized end metadata before cleanup removes the transfer-session hash
  - [x] End requests fail closed when metadata persistence fails, preventing silent loss of disposition/wrap-up payloads
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/agent-transfer-sdk-project-scope.test.ts src/__tests__/auth/agent-transfer-routes-authz.test.ts`
  - [x] Transfer-driven parent conversation end landed in slice 4C
- **Slice 4C Exit Criteria**: met
  - [x] Transfer end can optionally terminalize the parent conversation session through `SessionTerminalizationService`
  - [x] Structured transfer-end metadata is durably persisted on the parent conversation session before the ephemeral transfer-session record is removed
  - [x] Transfer-driven `transferred -> escalated` lifecycle outcomes remain compatible with retention cleanup and regression tests
  - [x] `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/agent-transfer`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/agent-transfer-session-terminalization.integration.test.ts src/__tests__/auth/agent-transfer-routes-authz.test.ts src/__tests__/escalation-transfer-wiring.test.ts src/__tests__/sessions/session-cleanup-retention.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/agent-transfer-session-terminalization.e2e.test.ts`
- **Files Changed**: 2
- **Deviations**: Slice 4B kept the compatibility route as the caller-owned end mechanism and normalized structured metadata directly into the live transfer session before `end()`. Slice 4C completed the parent-session bridge without changing the external route shape, so the rollout stays additive while the legacy transfer callers converge on the shared terminalization path.

### Hardening Slice: Duplicate Terminalization Idempotency and SDK Session Alias Cleanup

- **Status**: DONE
- **Scope**: fix the shared terminalization correctness gap before 4C and align SDK websocket state with the deleted internal `runtimeSessionId` alias
- **Exit Criteria**: met
  - [x] Already-terminal stored sessions no longer rewrite persisted `status`, `disposition`, or `endedAt`
  - [x] Duplicate explicit close returns the persisted terminal outcome and emits no second `session.ended`
  - [x] Runtime SDK websocket state no longer depends on the removed internal `runtimeSessionId` field
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/session-lifecycle/__tests__/terminalization-service.test.ts src/__tests__/session-terminalization.integration.test.ts src/__tests__/session-terminalization.e2e.test.ts`
- **Files Changed**: 5
- **Deviations**: This hardening slice landed ahead of 4C because review surfaced a correctness issue in the shared terminalization path that could silently desynchronize persisted session disposition from downstream billing/pipeline/dashboard consumers. The SDK alias cleanup was bundled here because the rebase removed the internal `runtimeSessionId` field and the websocket handler needed to rely on the canonical runtime session object instead.

### Phase 5: Studio and Control-Plane Convergence

- **Status**: DONE
- **Slices Completed**: 5A runtime lifecycle route owns transfer TTL writes, 5B Studio lifecycle proxy/hook rollout, 5C compatibility cleanup for legacy transfer-settings writes
- **Exit Criteria**: met
  - [x] Studio reads lifecycle settings through the dedicated project lifecycle route
  - [x] Transfer TTL controls write through the lifecycle API instead of the legacy transfer-settings API
  - [x] Legacy transfer-settings writes preserve lifecycle-owned TTL values when callers omit them
  - [x] `pnpm build --filter=@agent-platform/runtime`
  - [x] `pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/studio`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/__tests__/project-session-lifecycle.integration.test.ts src/__tests__/routes/agent-transfer-settings.openapi-contract.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/project-session-lifecycle.e2e.test.ts`
  - [x] `pnpm --filter @agent-platform/studio test -- src/__tests__/agent-transfer-ui.test.ts`
  - [x] `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/session-lifecycle-api.e2e.test.ts`
  - [x] `git diff --check`
- **Deviations**: The legacy runtime transfer-settings route still exists intentionally; this slice only makes it compatibility-safe by preserving lifecycle-owned TTLs instead of removing the old surface in the same release.

### Phase 6: Billing Follow-On Scaffolding

- **Status**: IN PROGRESS
- **Slices Completed**: 6A billing-unit policy contract/control-plane scaffolding, 6B1 compare-only derivation preview surface and per-session assessment boundary, 6B2 compare-only replay/backfill persistence plus admin inspection routes, 6C1 manual materialization batches plus truthful billing aggregate event emission, 6C2A scheduler-safe due planning and checkpoint scaffolding, 6C2B scheduled materialization orchestration plus tenant aggregate project/channel breakdowns, 6C3A batch-scoped per-session materialization result persistence and inspection, 6C3B idempotent materialization-application control-plane records, 6C4 published reporting projection plus platform/tenant/project report APIs, 6C5A platform-admin and tenant-admin consumer cutover onto published usage reports, 6C5B low-frequency publication scheduling for completed batches, 6C5C Studio tenant billing consumer cutover onto published usage reports, 6C5D Studio project billing consumer cutover onto published usage reports, 6C5E Studio analytics tenant-usage alias/quarantine, 6C5F materialized-vs-published operator visibility, 6C5G platform publication visibility aggregation, 6C5H platform-to-tenant usage drilldown, 6C5I bounded manual tenant publish/apply action, 6C5J inline tenant batch/application inspection, 6C5K tenant per-session results drill-in
- **Slice 6A Exit Criteria**: met
  - [x] Billing-unit policy is tenant-level only, plan-aware, and stored under the billing domain on `Subscription`
  - [x] All plans currently resolve the same default billing-unit policy, while keeping the config shape plan-aware for future divergence
  - [x] Platform-admin-only `GET /api/platform/admin/billing-policy/plans`, `GET /:tenantId`, `PUT /:tenantId`, and `DELETE /:tenantId` routes exist for inspecting and managing overrides
  - [x] Billing materialization basis is configurable as `time_window` or `completed_sessions`
  - [x] `packages/eventstore` defines the `billing` category and `billing.usage.updated` contract for future dashboard consumption
  - [x] No billing writes, workers, or terminalization-side billing mutations were introduced in this slice
  - [x] `pnpm build --filter=@agent-platform/database --filter=@abl/eventstore --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/database test -- src/__tests__/model-billing.test.ts`
  - [x] `pnpm --filter @abl/eventstore test -- src/__tests__/event-categories.test.ts src/__tests__/billing-events-schema.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime test -- src/services/billing/__tests__/billing-policy-service.test.ts src/__tests__/platform-admin-billing-policy.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/platform-admin-billing-policy.e2e.test.ts`
- **Deviations**: Slice 6A stops at contracts and control-plane plumbing. It does not add compare-only derivation jobs, billing writes, or `billing.usage.updated` emission yet, because those remain the next two incremental billing slices.
- **Slice 6B Exit Criteria**: met
  - [x] Pure compare-only derivation service explains excluded debug/proactive sessions and 15-minute interval splits from resolved billing policy
  - [x] Platform-admin preview route surfaces compare-only derivation without adding billing writes or scheduler coupling
  - [x] Per-session billing assessment is available for ended sessions without emitting `billing.usage.updated` from lifecycle terminalization
  - [x] Addon-unit math supports `off`, `per_call`, and `bucketed` policy modes, with ClickHouse-first counts and message-history fallback when usage telemetry is unavailable
  - [x] Historical replay/backfill job wiring exists for sampled completed sessions and usage telemetry
  - [x] Compare-only outputs are persisted or surfaced for parity review before any billing writes
  - [x] `pnpm build --filter=@agent-platform/database --filter=@agent-platform/runtime`
  - [x] `pnpm --filter @agent-platform/database exec vitest run src/__tests__/model-billing.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/platform-admin-billing-policy.test.ts src/__tests__/billing-usage-preview-service.integration.test.ts src/__tests__/billing-session-assessment-service.integration.test.ts src/__tests__/billing-usage-replay-service.integration.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/platform-admin-billing-policy.e2e.test.ts src/__tests__/platform-admin-billing-preview.e2e.test.ts src/__tests__/platform-admin-billing-replay.e2e.test.ts`
- **Deviations**: Slice 6B stays compare-only but no longer stops at preview and per-session assessment. It now adds manual platform-admin replay/backfill routes plus persisted run/session parity artifacts so historical ended sessions can be reviewed before any scheduler or billing materializer exists. Lifecycle terminalization still emits only `session.ended`, and `billing.usage.updated` remains reserved for the future materialization slice.
- **Slice 6C Exit Criteria**: partially complete
  - [x] Billing-domain materialization batches are persisted independently from lifecycle terminalization
  - [x] Platform-admin-only `POST /api/platform/admin/billing-policy/:tenantId/materializations`, `GET /:tenantId/materializations`, and `GET /:tenantId/materializations/:batchId` routes exist for manual aggregate materialization and inspection
  - [x] `billing.usage.updated` payloads now reflect the actual materialization basis and trigger source instead of hardcoded completed-session semantics
  - [x] Aggregate billing events are emitted from the billing materialization service, not from session terminalization
  - [x] Aggregate billing summaries and emitted events include tenant-scope project and channel breakdowns for analytics consumers
  - [x] Scheduler-owned billing checkpoints exist so manual materialization batches do not become the automated billing cursor
  - [x] Platform-admin-only `GET /api/platform/admin/billing-policy/:tenantId/materializations/due` exposes the next scheduler-safe candidate for `time_window` and `completed_sessions`
  - [x] Completed-session due planning uses `endedAt` plus `sessionId` cursor ordering to avoid duplicate or skipped sessions when timestamps tie
  - [x] Scheduled billing materialization now runs automatically for due tenant batches and advances checkpoints only after successful materialization
  - [x] Manual and scheduled billing materialization batches persist batch-scoped per-session result rows and expose them through `GET /api/platform/admin/billing-policy/:tenantId/materializations/:batchId/results`
  - [x] Platform-admin-only `POST /api/platform/admin/billing-policy/:tenantId/materializations/:batchId/apply` and `GET /:tenantId/materializations/:batchId/application` routes persist and expose one idempotent application record per completed batch
  - [x] Materialization application records select the matching active deal plus accounting period and intentionally defer legacy `CreditLedger` / `BillingLineItem` projection until unit-to-credit and unit-to-price mapping is defined
  - [x] Applied materialization batches publish deduped per-session reporting rows keyed by `tenantId + sessionId`
  - [x] Platform-admin, tenant-workspace, and project-scoped APIs can return time-windowed usage plus billing-unit totals from the published reporting projection
  - [x] Admin platform and tenant usage consumers now proxy to published billing usage reports instead of the legacy platform `usage-summary` analytics path
  - [x] Admin tenant usage now exposes publication-status visibility so operators can distinguish completed materialization from published report availability
  - [x] Admin global usage now exposes platform publication-status visibility so operators can identify lagging tenants without drilling into each workspace first
  - [x] Admin global usage visibility rows now deep-link into the tenant Usage tab publication section for fast drilldown on lagging tenants
  - [x] Admin tenant usage now exposes a bounded `Publish now` action for pending completed batches by reusing the idempotent runtime apply endpoint and refreshing report visibility in place
  - [x] Admin tenant usage now exposes inline batch/application inspection via on-demand detail proxies so operators can see scope, summary, and projection state without leaving the page
  - [x] Admin tenant usage now exposes paginated per-session batch results via the same expanded detail surface, so included/excluded sessions are inspectable without leaving the page
  - [x] Studio billing usage now reads the published billing report plane at both tenant and project scopes instead of the legacy `tenant-usage` analytics path while leaving the old analytics route available for other consumers
  - [x] Studio analytics hooks now use a dedicated `/api/analytics/tenant-usage` proxy path while `/api/tenant-usage` remains a deprecated compatibility shim
  - [x] A separate low-frequency publication scheduler now applies a bounded number of completed batches into report rows without lengthening the materialization scheduler pass
  - [x] `pnpm build --filter=@agent-platform/database --filter=@abl/eventstore --filter=@agent-platform/runtime`
  - [x] `pnpm build --filter=@agent-platform/database --filter=@agent-platform/runtime --filter=@agent-platform/admin`
  - [x] `pnpm build --filter=@agent-platform/studio`
  - [x] `pnpm --filter @agent-platform/database exec vitest run src/__tests__/model-billing.test.ts`
  - [x] `pnpm --filter @abl/eventstore exec vitest run src/__tests__/billing-events-schema.test.ts`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/billing-usage-materialization-service.integration.test.ts src/__tests__/billing-usage-materialization-scheduler-service.integration.test.ts src/__tests__/billing-usage-materialization-planner-service.integration.test.ts src/__tests__/billing-usage-materialization-visibility-service.integration.test.ts src/__tests__/billing-materialization-application-service.integration.test.ts src/__tests__/billing-usage-publication-scheduler-service.integration.test.ts src/__tests__/billing-usage-report-service.integration.test.ts src/__tests__/platform-admin-billing-policy.test.ts src/__tests__/workspace-billing.test.ts src/__tests__/project-billing.test.ts src/__tests__/execution/event-bus/types.test.ts src/__tests__/runtime-maintenance-jobs.test.ts`
  - [x] `pnpm --filter @agent-platform/admin exec vitest run src/__tests__/billing-usage-proxy-routes.test.ts src/__tests__/billing-publication.test.ts src/__tests__/tenant-detail-tabs.test.ts`
  - [x] `pnpm --filter @agent-platform/admin exec vitest run src/__tests__/tenant-detail-tabs.test.ts`
  - [x] `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/hooks/billing-hooks.test.ts src/__tests__/components/BillingPage.test.tsx`
  - [x] `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts src/__tests__/platform-admin-billing-preview.e2e.test.ts src/__tests__/platform-admin-billing-replay.e2e.test.ts src/__tests__/platform-admin-billing-materialization.e2e.test.ts src/__tests__/platform-admin-billing-materialization-plan.e2e.test.ts src/__tests__/platform-admin-billing-materialization-scheduled.e2e.test.ts src/__tests__/platform-admin-billing-application.e2e.test.ts`
- **Deviations**: Slice 6C now covers durable manual and scheduled aggregate materialization, truthful aggregate event emission, scheduler-owned checkpoint storage, tenant-scope project/channel breakdowns, batch-scoped per-session materialization result persistence with admin inspection, an idempotent materialization-application control plane, and a published reporting projection that powers time-windowed usage APIs without mutating legacy priced surfaces. It also cuts Admin’s platform-wide and tenant usage dashboards and Studio’s tenant/project billing usage surfaces over to the published-reporting plane, while intentionally leaving the legacy `tenant-usage` route in place as a deprecated compatibility shim for separate analytics consumers and keeping the low-frequency publication scheduler decoupled from the materializer pass. The follow-on operator-visibility slices add explicit publication-status surfaces so tenant admins can see when completed materialization batches are still waiting to be applied into published report rows, platform admins can see the same lag aggregated across tenants from the global usage surface, and the platform surface can deep-link straight into the tenant Usage publication section for drilldown. The latest bounded operator slices now add a manual `Publish now` action in Admin tenant usage, inline batch/application inspection, and a paginated per-session results drill-in, but they intentionally reuse the existing idempotent runtime apply endpoint plus read-only detail/result routes instead of introducing any scheduler coupling or a separate publication write path. It still does not introduce downstream invoice/ledger mutations or per-project scheduled batch partitioning. As part of this slice, the repo retired the unused legacy `UsagePeriod` model/export path and moved the active billing persistence boundary entirely onto replay/materialization/application/reporting collections. The full runtime harness used by the billing materialization E2E paths does not bootstrap the event bus, so those end-to-end tests intentionally lock `eventDispatchAttempted=false` while the service-level integration tests inject an event bus and verify the emitted `billing.usage.updated` payload.
