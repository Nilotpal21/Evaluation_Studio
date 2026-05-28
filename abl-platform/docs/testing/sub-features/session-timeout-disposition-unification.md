# Test Specification: Session Timeout & Disposition Unification

**Feature Spec**: `docs/features/sub-features/session-timeout-disposition-unification.md`
**Parent Feature**: [Memory & Sessions](../../features/memory-sessions.md)
**HLD**: `docs/specs/session-timeout-disposition-unification.hld.md`
**LLD**: `docs/plans/session-timeout-disposition-unification.lld.md`
**Status**: IN PROGRESS
**Last Updated**: 2026-04-01

---

## 1. Feature Metadata

- **Package(s)**: `apps/runtime`, `apps/studio`, `packages/database`, `packages/compiler`, `packages/agent-transfer`, `packages/eventstore`, `packages/pipeline-engine`
- **Feature Area**: project lifecycle, agent lifecycle, integrations, eventing, operator controls, billing boundary
- **Risk Level**: High (touches session creation, cleanup, channel disconnect, transfer TTLs, event emission, and operator-visible close semantics)

---

## 2. Current State

The codebase already has partial coverage for pieces of this behavior, but not for the fully unified lifecycle model we want:

- runtime close and bulk-close behavior are covered in `apps/runtime/src/__tests__/sessions/session-routes.test.ts`
- SDK explicit `end_session` behavior is covered in `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`
- runtime cleanup and session store behavior are covered across `session-redis.e2e.test.ts`, cleanup tests, and route tests
- transfer-session TTL behavior is partially covered in `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`
- transfer disposition metadata now has shared terminalization coverage plus route-level regression coverage, but full transfer E2E is still pending
- pipeline-engine already has `session.ended` trigger coverage, but not full regression coverage for the widened terminal payload shape
- compare-only billing replay/backfill now has persisted model coverage, runtime integration coverage, mocked admin-route coverage, and a real platform-admin E2E path in addition to the earlier billing preview surface
- billing aggregate summaries now carry tenant-scope project and channel breakdowns through preview, replay, persisted materialization batches, and `billing.usage.updated` payloads
- billing materialization now has both manual and scheduled coverage, including due-planning, checkpoint-advance safety, scheduler integration, persisted batch-scoped per-session materialization results, and real platform-admin materialization E2E paths for both batch detail and scheduled execution
- billing materialization application now has idempotent control-plane persistence with service integration coverage, admin-route coverage, and a real platform-admin E2E path that records batch-to-deal/accounting-period selection without mutating legacy credit-ledger or priced line-item surfaces
- applied materialization batches now publish a deduped session-level reporting projection, and time-windowed usage/billing-unit reports are exposed at platform-admin, tenant-workspace, and project scopes with integration, route, and E2E coverage
- a second low-frequency publication scheduler now applies a bounded number of completed batches into the published reporting plane so dashboards can catch up without lengthening the materialization scheduler pass
- admin platform, tenant usage consumers, and Studio tenant/project billing pages now proxy to the published billing usage report surfaces; the legacy `tenant-usage` analytics route remains for other Studio analytics consumers that have not moved to the billing-report plane
- Studio analytics hooks now read through `/api/analytics/tenant-usage`, while `/api/tenant-usage` remains a deprecated compatibility shim with dedicated route and hook regression coverage
- admin tenant usage now also surfaces materialization-vs-publication status so operators can see pending publication counts, recent batch states, and last materialized/published timestamps when report rows lag behind completed batches
- admin global usage now also surfaces cross-tenant publication visibility, so platform operators can see which tenants have completed batches still waiting to be published into report rows
- admin global usage rows now deep-link into the tenant Usage publication section via `?tab=usage#publication-visibility`, so operators can move from platform lag detection to tenant batch detail in one step
- admin tenant usage now also exposes a bounded `Publish now` action for pending completed batches, reusing the existing idempotent application control plane and refreshing both publication state and usage-report totals after success
- admin tenant usage now also supports inline batch/application inspection, so operators can open scope, summary, deal-period, and projection detail for a recent batch without leaving the Usage page
- admin tenant usage now also exposes paginated per-session materialization results inline, so operators can see which sessions were included or excluded without switching to platform-admin-only billing routes

What is missing is end-to-end proof that tenant defaults, project overrides, agent timeout/disconnect overrides, channel disconnect defaults, project/channel end-hook settings, transfer TTL settings, guaranteed `session.ended` emission, and pipeline-driven post-session automation all converge into one enforced conversation-session lifecycle model. We also need explicit proof that billing artifacts are not written directly from terminalization.

---

## 3. Coverage Matrix

| FR    | Description                                                                                                           | Unit | Integration | E2E | Manual | Status      |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ----------- |
| FR-1  | Runtime timeout/disconnect precedence chain (tenant -> project -> agent -> explicit override)                         | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-2  | End-hook policy resolved from project default plus channel override, with no agent override                           | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-3  | Project-admin-only hook configuration                                                                                 | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-4  | Project-scoped lifecycle settings enforced on live runtime sessions                                                   | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-5  | Agent-level timeout/disconnect overrides enforced from IR                                                             | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-6  | Shared terminalization across close, cleanup, disconnect, SDK end, and transfer-driven end                            | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-7  | Canonical disposition normalization and idempotent terminal state                                                     | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-8  | Guaranteed `session.ended` emission for every successful terminal path                                                | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-9  | Event emission happens before end hooks and hook failure cannot suppress terminalization                              | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-10 | End-hook policy supports only `ignore` and `respond`                                                                  | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-11 | `respond` hook remains best effort and does not block terminalization                                                 | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-12 | Non-user-facing automation runs from pipelines, not runtime hook config                                               | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-13 | Transfer-session TTL injection and transfer end metadata capture                                                      | ✅   | ✅          | ❌  | -      | IN PROGRESS |
| FR-14 | Effective policy inspection surface with source provenance and end-hook visibility                                    | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-15 | Backward-compatible compatibility routes over shared backend                                                          | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-16 | Billing separation: terminalization does not directly create/mutate billing records                                   | ❌   | ❌          | ❌  | -      | PLANNED     |
| FR-17 | Downstream billing-unit derivation and dashboard billing-event guidance captured for follow-on billing implementation | -    | -           | -   | ✅     | FOLLOW-ON   |
| FR-18 | Automated coverage for lifecycle convergence, event emission, hooks, transfer TTLs, and billing                       | ❌   | ❌          | ❌  | -      | PLANNED     |

Legend: ✅ = Covered, ❌ = Not covered, - = N/A

---

## 4. E2E Test Scenarios

> E2E tests must use the real HTTP/WebSocket surfaces. No mocking of codebase components, no direct DB assertions, and no bypassing auth/middleware.

### E2E-1: Project Runtime Timeout Override Governs Live Session End

**Covers**: FR-1, FR-4, FR-6, FR-7, FR-8

1. Create a project with lifecycle settings overriding the tenant default idle/max-age.
2. Start a real runtime session over the supported channel surface.
3. Let the session age past the project idle limit but not the tenant default.
4. Assert cleanup/close behavior records the expected normalized timeout disposition.
5. Assert the effective-policy inspection route shows `source=project`.
6. Assert the session end path emits the canonical terminal event.

### E2E-2: Agent Override Beats Project Default for Timeout or Disconnect Only

**Covers**: FR-1, FR-5, FR-14

1. Configure a project lifecycle default.
2. Start two real sessions under the same project: one on an agent with an override, one without.
3. Assert the overridden agent uses the agent-level timeout/disconnect policy while the other session uses the project policy.
4. Assert the effective-policy route shows different sources for the two sessions.

### E2E-3: Channel Disconnect Uses Configured Default Disposition and Emits End Event

**Covers**: FR-4, FR-6, FR-8

1. Save a project lifecycle policy for a target channel with a non-default `disconnectBehavior` and `defaultDisposition`.
2. Start a real session on that channel.
3. Disconnect the client without an explicit close.
4. Assert the resulting runtime session status/disposition matches the configured channel policy.
5. Assert exactly one `session.ended` event is emitted with the expected terminal source.

### E2E-4: SDK `end_session` Forces Explicit Complete Through Shared Terminalization

**Covers**: FR-6, FR-7, FR-8, FR-15

1. Start a real SDK session on a channel whose disconnect default is `detach`.
2. Send the `end_session` WebSocket message.
3. Assert the session closes through the shared lifecycle service with the normalized completed disposition.
4. Assert one canonical end event is emitted.
5. Assert no late timeout/disconnect path overrides the explicit close result.

### E2E-5: `respond` End Hook Is Best Effort

**Covers**: FR-2, FR-9, FR-10, FR-11

1. Configure a project or channel end hook with `mode=respond`.
2. Start a real session with an attached transport.
3. Trigger session end.
4. Assert the session is terminalized and the end event is emitted before hook success is checked.
5. Assert the user receives the closing message when the transport is still available.
6. Repeat with a disconnected transport and assert the session still ends successfully with the event emitted.

### E2E-6: Post-Session Automation Runs Through Pipelines

**Covers**: FR-8, FR-12, FR-15

1. Start and end a real session through one of the unified terminalization paths.
2. Assert `session.ended` is emitted exactly once.
3. Assert a test pipeline subscriber receives the terminal event and performs the expected downstream automation.
4. Assert the runtime close flow does not wait on pipeline side effects to finish.

### E2E-7: Transfer Session TTL and End Metadata Use Project Policy

**Covers**: FR-13, FR-15

1. Save project lifecycle settings with transfer TTL overrides.
2. Initiate a real transfer session.
3. Assert the live transfer session TTL matches the project policy rather than the store fallback.
4. Submit post-agent disposition metadata through the runtime-backed path.
5. End the transfer session via the compatibility route.
6. Assert the metadata was persisted before cleanup and the end reason is normalized correctly.

### E2E-8: Billing Models Remain Untouched by Terminalization

**Covers**: FR-16

1. Start and end a real session through one of the supported terminalization paths.
2. Assert the session lifecycle API result and emitted event show successful terminalization.
3. Assert through public billing/usage APIs or controlled inspection helpers that no direct credit-ledger, billing-line-item, replay/materialization artifact, or retired usage-period write was triggered by terminalization itself.

### E2E-9: Platform-Admin Replay Persists Compare-Only Billing Parity Outputs

**Covers**: FR-17, FR-18

1. Start and close real sessions that should produce one included and one excluded billing result.
2. Confirm the preview API sees the expected sessions and fallback metrics source.
3. Trigger `POST /api/platform/admin/billing-policy/:tenantId/replays` as a platform admin.
4. Assert the returned replay includes persisted compare-only summary and session-level parity rows.
5. Assert `GET /api/platform/admin/billing-policy/:tenantId/replays` lists the created run.
6. Assert `GET /api/platform/admin/billing-policy/:tenantId/replays/:runId` paginates persisted session results without requiring direct DB access.

### E2E-10: Scheduled Billing Materialization Closes Due Tenant Batches

**Covers**: FR-17, FR-18

1. Configure tenant billing policy with `materialization.basis=completed_sessions` and a low threshold such as `2`.
2. Start and close real sessions through the public runtime API until the threshold is met.
3. Wait for the scheduled billing worker to run through the real server bootstrap path.
4. Assert `GET /api/platform/admin/billing-policy/:tenantId/materializations` lists a `triggerSource=scheduled` batch.
5. Assert the persisted batch summary includes tenant aggregate `projectBreakdown` and `channelBreakdown`.
6. Assert `GET /api/platform/admin/billing-policy/:tenantId/materializations/:batchId/results` paginates the persisted per-session materialization rows for that scheduled batch.
7. Assert the automated checkpoint advances only after the scheduled batch succeeds.

### E2E-11: Materialization Application Records a Batch Exactly Once

**Covers**: FR-17, FR-18

1. Start and close a real session, then create a real billing materialization batch through the platform-admin API.
2. Create a matching active deal through the platform-admin deals API using the tenant organization or tenant fallback key.
3. Trigger `POST /api/platform/admin/billing-policy/:tenantId/materializations/:batchId/apply`.
4. Assert the first call returns `201` with persisted deal resolution, accounting period, and deferred projection targets.
5. Repeat the same apply call and assert it returns `200` with the same application id rather than creating a duplicate.
6. Assert `GET /api/platform/admin/billing-policy/:tenantId/materializations/:batchId/application` returns the stored application detail without requiring direct DB access.

---

## 5. Integration Test Scenarios

### INT-1: Effective Policy Resolution Matrix

Verify tenant-only, tenant+project, tenant+project+agent, and explicit override combinations all resolve the expected values and source provenance for timeout/disconnect, and verify end-hook resolution is project default plus channel override only.

### INT-2: Disposition Normalization and Status Mapping

Verify `completed`, `abandoned`, `agent_hangup`, `transferred`, `failed`, `timeout`, and `unengaged` all map to the expected persisted disposition and session status.

### INT-3: Cleanup Job Timeout vs Unengaged Split

Verify the cleanup job still differentiates `timeout` vs `unengaged`, but now uses the shared lifecycle service for policy and terminalization.
Verify the session-retention and message-retention cleanup queries both treat canonical `escalated` sessions as terminal so transferred conversations age out correctly.

### INT-4: Guaranteed `session.ended` Emission

Verify close, bulk-close, cleanup, disconnect, SDK end, and transfer-driven end each emit exactly one `session.ended` event with canonical payload fields.

### INT-5: End-Hook Ordering and Failure Handling

Verify terminal state is persisted and the end event is emitted before `respond` hooks are attempted, and verify hook errors fail open.

### INT-6: Transfer Store TTL Injection

Verify `TransferSessionStore.create()` and `extendTTL()` receive explicit TTL values from the policy service for `chat`, `email`, `voice`, `messaging`, and `campaign`.

Current coverage note: route-level transfer end regression tests now verify durable parent-session persistence for both terminalizing and non-terminalizing post-agent actions.

### INT-7: Compatibility Route Behavior

Verify existing close/end/settings routes still accept legacy request shapes while delegating to the unified backend service.

### INT-8: Billing Models Are Not Written

Verify the shared terminalization service does not call billing repositories/models and does not mutate billing replay/materialization artifacts, ledgers, or line items as part of session end.

### INT-9: Pipeline Compatibility With Widened Payload

Verify pipeline-engine `session.ended` trigger handlers continue to accept the widened end payload without regression.

### INT-10: Invalid Runtime Hook Modes Are Rejected

Verify lifecycle settings validation rejects runtime hook modes other than `ignore` and `respond`.

### INT-11: Project-Admin Hook Authorization

Verify non-admin project members cannot update project or channel end-hook settings, while project admins can.

### INT-12: Billing Replay Persistence and Pagination

Verify sampled ended sessions can be replayed through the compare-only billing service, persisted as run/session artifacts with project/channel aggregate breakdowns, and paginated back through the admin inspection surface with stable tenant scoping.

### INT-13: Scheduled Billing Materialization and Checkpoint Safety

Verify the billing scheduler consumes only due tenant batches from the planner, persists scheduled materialization batches plus batch-scoped per-session result rows, emits scheduled aggregate payloads with truthful basis/trigger metadata, and advances `BillingMaterializationCheckpoint` only after successful materialization.

### INT-14: Materialization Application Deal Resolution and Accounting Period

Verify the billing application service records one application row per tenant and batch, prefers exact project-scoped deals over organization-scoped fallbacks, resolves tenant fallback organization keys correctly, computes accounting periods from `billingStartDate + billingCycle`, and fails without persisting an application when active-deal resolution is ambiguous.

### INT-15: Low-Frequency Publication Scheduler Preserves Bounded Background Load

Verify the publication scheduler scans active tenants for completed batches whose usage-report projection is still pending, applies at most the configured batch limit per pass, and publishes deduped reporting rows without extending the materialization scheduler critical path.

### INT-16: Materialization Publication Visibility Explains Reporting Lag

Verify tenant-scoped operator visibility summarizes completed, running, failed, pending-publication, and published batches correctly, preserves project filtering, and exposes the recent publication state through the platform-admin route plus Admin proxy used by the tenant usage UI.

### INT-17: Platform Publication Visibility Aggregates Lag Across Tenants

Verify the platform visibility path summarizes global completed/running/failed/published counts, orders tenants with pending publication first, and exposes that cross-tenant lag through the Admin global usage proxy and UI.

### INT-18: Platform Visibility Drilldown Lands on Tenant Usage Publication State

Verify the platform usage surface generates stable tenant drilldown links that resolve the tenant detail page onto the Usage tab and anchor the publication-visibility section.

### INT-19: Tenant Operator Publish Action Reuses Idempotent Apply Path

Verify the tenant usage surface only offers `Publish now` for completed batches whose report publication is pending, proxies the action through the Admin boundary to the existing runtime apply endpoint, and refreshes both publication visibility and tenant usage totals after a successful publish.

### INT-20: Tenant Operator Can Inspect Batch and Application Detail Inline

Verify the tenant usage surface can fetch batch detail and application detail on demand for a recent materialization row, render scope/summary/projection information inline, and degrade gracefully when an application record has not been created yet.

### INT-21: Tenant Operator Can Page Through Materialization Session Results

Verify the tenant usage surface can fetch paginated per-session materialization results for an expanded batch, show included vs excluded outcomes with exclusion reasons, and page forward/backward through the result set via the Admin proxy without leaving the Usage tab.

---

## 6. Unit Test Scenarios

### UNIT-1: Policy Source Provenance

Verify the resolver returns both the value and the correct source label (`tenant`, `project`, `agent`, `explicit`).

### UNIT-2: Legacy Compiler Alias Normalization

Verify legacy `session_idle_timeout` compiler input normalizes into the new lifecycle IR object without breaking existing agents.

### UNIT-3: End-Hook Config Validation

Verify `ignore` and `respond` configurations validate as expected, and verify unsupported modes such as `call` are rejected.

### UNIT-4: End-Hook Execution Ordering

Verify terminalization result construction marks event emission before hook attempt bookkeeping.

### UNIT-5: Transfer Metadata Merge Semantics

Verify post-agent metadata updates merge cleanly with existing transfer session state and survive invalid/partial payloads safely.

### UNIT-6: Billing Separation Guardrails

Verify terminalization code paths do not import or invoke billing model helpers directly.

---

## 7. Security & Isolation Scenarios

- Cross-project lifecycle settings read/write returns 404.
- Cross-project session close/end attempts return 404.
- Cross-tenant transfer metadata submission cannot target another tenant's session.
- Compatibility routes remain behind the same auth and RBAC middleware as the new lifecycle route.
- Only project admins may modify project or channel end-hook configuration.

---

## 8. Exit Criteria

- [ ] Unit coverage exists for precedence resolution, IR normalization, end-hook validation, and disposition mapping.
- [ ] Integration coverage exists for cleanup, disconnect, guaranteed event emission, hook failure handling, pipeline compatibility, transfer TTL injection, and compatibility routes.
- [ ] E2E coverage proves project overrides, agent timeout/disconnect overrides, SDK explicit end, project/channel end-hook behavior, transfer metadata capture, and billing separation.
- [ ] No lifecycle path bypasses the shared resolver/terminalization service.
- [ ] `session.ended` is emitted exactly once for every successful terminalization path.
- [ ] Terminalization introduces no direct billing writes.
- [ ] Studio and runtime docs reflect the final authoritative settings surface.

---

## 9. Follow-On Billing Validation

These items are recommended for the downstream billing feature, not this session-lifecycle rollout:

- current progress: the compare-only derivation engine now has unit coverage for excluded debug/proactive sessions, 15-minute interval splits, and addon unit modes; the compare-only per-session assessment service is covered by integration tests; manual replay/backfill over ended sessions now persists compare-only run/session artifacts with route and E2E coverage; manual and scheduled platform-admin materialization now persist aggregate batches plus batch-scoped per-session result rows with integration and E2E coverage; scheduler-owned billing checkpoints and the `GET /api/platform/admin/billing-policy/:tenantId/materializations/due` planning route now have model, integration, route, and E2E coverage; billing materialization application now persists idempotent control-plane batch application records with deal/accounting-period snapshots and route/E2E coverage; applied batches now publish deduped session-level reporting rows that feed time-windowed platform/tenant/project usage reports; a separate low-frequency publication scheduler now applies bounded completed-batch work into those report rows; platform-admin global, tenant-admin, and Studio tenant/project billing consumers now proxy to those published billing usage reports with route/hook/component coverage; tenant-admin operator surfaces now have dedicated materialized-vs-published visibility summaries with runtime integration and Admin proxy coverage plus a bounded manual publish action that reuses the existing apply path, inline batch/application inspection via on-demand detail fetches, and paginated per-session results drill-in from the same expanded row; platform-admin global usage now also has cross-tenant publication visibility and direct tenant drilldown coverage through the same runtime/admin boundary; Studio analytics now uses a dedicated `/api/analytics/tenant-usage` proxy with compatibility coverage on the legacy `/api/tenant-usage` shim; lifecycle terminalization now asserts that `billing.usage.updated` is not emitted on session end; and the billing materialization service now emits the truthful aggregate event contract when an event bus is available
- verify billing-unit policy resolves from tenant subscription-plan defaults only
- verify only platform admins can change billing-unit policy
- verify billing materialization basis resolves from tenant subscription-plan defaults only
- verify debug sessions such as `web_debug` are excluded from billable units
- verify proactive sessions with no or below-minimum user interaction are excluded from billable units
- verify base billing units are split into 15-minute intervals consistently
- verify LLM and tool usage contributes addon billing units separately from base conversation-time units
- verify per-session assessment remains compare-only and does not become the dashboard-facing aggregate event contract
- verify manual materialization batches do not advance the scheduler-owned billing checkpoint cursor
- verify completed-session due planning uses stable `endedAt` + `sessionId` ordering so tied timestamps do not duplicate or skip sessions
- verify scheduled billing materialization emits `billing.usage.updated` when a configured time window closes or a configured batch of completed sessions is materialized, using the same aggregate contract as the manual path
- verify dashboard billing views consume `billing.usage.updated` rather than inferring billing completion directly from raw `session.ended`
