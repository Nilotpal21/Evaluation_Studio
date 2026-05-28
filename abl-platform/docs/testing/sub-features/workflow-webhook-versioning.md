# Testing Guide: Workflow Webhook Versioning

**Feature Spec**: [../../features/sub-features/workflow-webhook-versioning.md](../../features/sub-features/workflow-webhook-versioning.md)
**Status**: PARTIAL
**Last Updated**: 2026-04-19
**Parent Testing Guide**: [workflow-triggers.md](./workflow-triggers.md)

---

## 1. Feature Metadata

- **Slug**: `workflow-webhook-versioning`
- **Doc Type**: SUB-FEATURE testing guide
- **Packages Under Test**: `apps/runtime`, `apps/workflow-engine`, `apps/studio`, `packages/compiler`
- **Test Runners**: Vitest (runtime/engine/compiler), Playwright (Studio)

---

## 2. Current State

**Implementation DONE as of 2026-04-18.** Feature promoted to **ALPHA**. KEYSTONE parity test (Scenario 5 below) asserts runtime and engine agree on default version resolution using a shared MongoMemoryServer fixture.

Additional audit-remediation coverage landed on 2026-04-18:

- Runtime E2E now asserts short-URL execute/status calls forward the original caller credential to workflow-engine.
- Runtime E2E now validates against the resolved version `inputSchema` for both explicit pins and default-resolution executes.
- Studio component regression tests now cover create-flow auto-persistence of the previewed workflow version without rewriting edit-style auto-resolve bindings.

**Baseline Gaps (from feature spec §16):**

- GAP-001 (engine default-branch non-determinism) — **Mitigated**: `system-executions-semver.test.ts` + `system-execute-version.test.ts` (KEYSTONE) cover this.
- GAP-004 (legacy bindings without `workflowVersion`) — **Covered**: `workflow-tool-executor-versioning.integration.test.ts` includes the unversioned regression case.
- GAP-005 (semver npm dep propagation) — **Mitigated**: superseded by 2026-04-19 dedupe into `packages/shared-kernel`; both apps now re-export.
- GAP-006 (semver.rcompare on corrupt strings) — **Mitigated** (2026-04-19): shared-kernel's `parseSemver()` returns `null` on invalid input; comparator treats as "invalid < draft". Regression in runtime + engine `semver-compare.test.ts`.
- GAP-007 (Studio local comparator pre-release handling) — **Mitigated** (2026-04-19): `apps/studio/src/lib/semver-compare.ts` now re-exports `@agent-platform/shared-kernel` `compareSemverDesc`. Studio, runtime, and engine share a single parser.
- GAP-008 (`mutate` missing from deps array) — **Open** (deferred to BETA).

**Audit-Remediation Gaps (closed 2026-04-19, feature spec §16 GAP-009 through GAP-013):**

- GAP-009 (trigger-engine semver-desc fallback) — **Covered**: 3 new cases in `trigger-fire-resolution.test.ts` (highest-semver pick, inactive excluded, soft-deleted excluded).
- GAP-010 (rate limit on execute) — **Covered**: e2e asserts `X-RateLimit-*` headers on 202 response.
- GAP-011 (audit log on execute) — **Covered**: e2e polls `audit_logs` collection for `action: 'workflow.executed'` + `metadata.executionId`.
- GAP-012 (resolved version in response) — **Covered**: 2 e2e cases (async pinned version + sync default-resolved version).
- GAP-013 (dedupe `compareSemverDesc`) — **Covered**: existing runtime + engine `semver-compare.test.ts` suites both pass after pointing to shared-kernel re-export.

**Post-ALPHA consolidation (2026-04-19):**

- **Studio comparator parity (GAP-007)** — `apps/studio/src/lib/semver-compare.ts` re-exports shared-kernel's `compareSemverDesc` under the existing `compareSemverDescLocal` alias. Runtime + engine `semver-compare.test.ts` suites verify the canonical implementation; Studio call sites (`WorkflowDetailPage`, `WorkflowConfigForm`) inherit the same behavior with zero call-site changes.
- **CodeSnippets tab consolidation** — Webhook invocation UI reduced from 4 tabs to 3 (Sync / Async+Poll / Async Push). Async-only was a fire-and-forget variant that Async+Poll supersedes. `apps/studio/e2e/workflows/workflow-trigger-api-key.spec.ts` updated to loop the 3-label list; `workflows.triggers.async_mode` i18n key removed.

---

## 3. Coverage Matrix

Legend: ✅ Covered by live test / ❌ Not covered / ⏸ Partial / 📝 Manual/doc-only

| FR    | Scenario                                                                                        | Unit | Integration | E2E | Manual | Status                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | Short URL `/api/v1/workflows/:id/execute` mounted + authenticates via `x-api-key`               |      | ✅          | ✅  |        | PASS                                                                                                                          |
| FR-2  | Accepts `?mode=sync\|async\|async_push` and `?version=<semver>`                                 |      | ✅          | ✅  |        | PASS                                                                                                                          |
| FR-3  | 404 conceal on `projectScope` mismatch                                                          |      |             | ✅  |        | PASS                                                                                                                          |
| FR-4  | Handler reuses `process-api` logic (input validation, UUIDv7 executionId, sync/async branching) |      | ✅          |     |        | PASS                                                                                                                          |
| FR-5  | Sync mode auto-promotes to 202 on timeout                                                       |      | ⏸           |     |        | PARTIAL (inherited from legacy handler; no explicit timeout scenario)                                                         |
| FR-6  | `?version=<nonexistent>` returns 404 `WORKFLOW_VERSION_NOT_FOUND`                               |      |             | ✅  |        | PASS                                                                                                                          |
| FR-7  | Proxy reads `?version=` + body precedence: body wins                                            |      | ✅          |     |        | PASS                                                                                                                          |
| FR-8  | Default resolution = highest semver active non-draft (runtime path)                             | ✅   | ✅          |     |        | PASS                                                                                                                          |
| FR-8  | Default resolution = highest semver active non-draft (engine path, parity)                      | ✅   |             | ✅  |        | PASS (KEYSTONE)                                                                                                               |
| FR-9  | No active versions → draft fallback + `workflow.version.resolution.miss` metric                 |      | ✅          |     |        | PASS                                                                                                                          |
| FR-10 | `WorkflowBindingIR.workflowVersion` added as optional field; compiler accepts + passes through  | ✅   |             |     |        | PASS                                                                                                                          |
| FR-11 | `WorkflowToolExecutor` forwards `workflowVersion` in engine body when set                       |      | ✅          | ✅  |        | PASS                                                                                                                          |
| FR-12 | `WorkflowConfigForm.tsx` persists selected version into binding DSL                             | ✅   |             | ✅  |        | PASS (component regression covers create/edit semantics; DSL unit + executor E2E cover downstream data path)                  |
| FR-13 | `WorkflowDetailPage` renders `[version]` + `[active\|inactive]` badge pair                      |      |             | ✅  |        | PASS                                                                                                                          |
| FR-14 | Inactive caption `served via <version>` appears only for inactive                               |      |             | ✅  |        | PASS                                                                                                                          |
| FR-15 | `WebhookQuickStart` emits short URL with `?version=<viewed>`                                    |      |             | ✅  |        | PASS                                                                                                                          |
| FR-16 | `CodeSnippets` emits short URL in 3 modes (Sync, Async+Poll, Async Push)                        |      |             | ✅  |        | PASS (Async-only mode dropped 2026-04-19 — superseded by Async+Poll; `workflow-trigger-api-key.spec.ts` asserts 3-tab layout) |
| FR-17 | Version badge clickable → Versions tab; state badge tooltip                                     |      |             | ✅  |        | PASS                                                                                                                          |
| FR-18 | Viewing draft or inactive emits `?version=draft` or `?version=v0.1.5` respectively              |      |             | ⏸   |        | PARTIAL (Playwright asserts visible badge states; URL assertion relies on buildCurl round-trip)                               |
| FR-19 | Execution-start log contains `version` field                                                    |      |             |     | 📝     | MANUAL (logs visible in test output; no assertion — log assertions are anti-pattern)                                          |
| FR-20 | Docs cross-reference updated                                                                    |      |             |     | 📝     | MANUAL (post-impl-sync skill covers this)                                                                                     |
| FR-21 | `GET /api/v1/workflows/:id/executions/:executionId` returns execution status + output           |      |             | ✅  |        | PASS                                                                                                                          |
| G-9   | GAP-009: legacy webhook trigger resolves highest-semver active (no pin, no deployment)          |      | ✅          |     |        | PASS (`trigger-fire-resolution.test.ts` — 3 cases)                                                                            |
| G-10  | GAP-010: execute routes attach `tenantRateLimit('request')` → `X-RateLimit-*` headers present   |      |             | ✅  |        | PASS                                                                                                                          |
| G-11  | GAP-011: `workflow.executed` audit record persisted with resolved version + mode + apiKeyId     |      |             | ✅  |        | PASS                                                                                                                          |
| G-12  | GAP-012: response envelope includes `resolvedVersion` + `resolvedVersionId`                     |      |             | ✅  |        | PASS                                                                                                                          |
| G-13  | GAP-013: `compareSemverDesc` canonicalized in shared-kernel (re-export parity)                  | ✅   |             |     |        | PASS (runtime + engine semver-compare suites both go through shared-kernel re-export)                                         |

---

## 4. E2E Test Scenarios

**All E2E tests hit real HTTP — no mocks of codebase components. MongoMemoryServer for data; real Express + workflow-engine process.**

### E2E-1: Short-URL authentication + happy path

**FRs covered**: FR-1, FR-2, FR-3, FR-4

**Setup**: Seed tenant + project + API key with `workflow:execute` scope + `projectScope: [projectId]`. Create workflow, publish and activate `v0.1.0`.

**Steps**:

1. `POST /api/v1/workflows/<wf_id>/execute?mode=sync` with `x-api-key` and `{ input: {} }`.
2. Assert HTTP 200, body `status: 'completed'`, `output` present.
3. `POST /api/v1/workflows/<wf_id>/execute` **without** `x-api-key`.
4. Assert HTTP 401.
5. `POST /api/v1/workflows/<wf_id>/execute` with API key scoped to a **different project**.
6. Assert HTTP 404 `WORKFLOW_NOT_FOUND` (conceal).

**Isolation checks**: Cross-project API key returns 404, not 403.

### E2E-2: Version pin round-trip + pin-miss

**FRs covered**: FR-2, FR-6, FR-18

**Setup**: Workflow with `v0.1.0` (inactive), `v0.2.0` (active). Also create a soft-deleted version `v0.0.9` (`deleted: true`).

**Steps**:

1. `POST .../execute?version=v0.1.0` → HTTP 200 (**explicit pin bypasses state filter** per FR-6 — inactive version executes when pinned).
2. Assert `WorkflowExecution.workflowVersion` = `v0.1.0`.
3. `POST .../execute?version=v99.99.99` → HTTP 404 `WORKFLOW_VERSION_NOT_FOUND` (nonexistent).
4. `POST .../execute?version=v0.0.9` → HTTP 404 `WORKFLOW_VERSION_NOT_FOUND` (soft-deleted — `deleted: true` filter applies even for explicit pins).
5. `POST .../execute?version=draft` → HTTP 200 (draft is always targetable).
6. Assert `WorkflowExecution.workflowVersion` = `draft`.
7. `POST .../execute` **without** `?version=` (default resolution) → HTTP 200 with `WorkflowExecution.workflowVersion = v0.2.0` (the only active non-draft).

### E2E-3: Default resolution by semver (runtime path)

**FRs covered**: FR-8, FR-9

**Setup**: Workflow with `v0.9.0` published later but inactive, `v0.10.0` published earlier and active, `v0.2.0` also active.

**Steps**:

1. `POST .../execute` **without** `?version=` → HTTP 200.
2. Assert `WorkflowExecution.workflowVersion` = `v0.10.0` (highest semver active, **not** `v0.9.0` despite later publish).
3. Deactivate `v0.10.0` and `v0.2.0`.
4. `POST .../execute` → HTTP 200, `workflowVersion` = `draft` (fallback).
5. Assert metric `workflow.version.resolution.miss` emitted.

### E2E-4: Runtime ↔ engine resolution parity (keystone)

**FRs covered**: FR-8 (engine branch)

**Setup**: Same multi-active-version setup as E2E-3.

**Steps**:

1. Call runtime short URL without `?version=`. Capture chosen `workflowVersion`.
2. Call engine's internal `/api/v1/projects/:pid/workflows/:wid/executions/execute` directly (via service-token). Capture chosen `workflowVersion`.
3. Assert both calls resolved to the **same** version (`v0.10.0`).
4. Repeat with only `v0.2.0` active — both should choose `v0.2.0`.

This is the single most important test in the suite. If it fails, the feature's primary reliability claim is broken.

### E2E-5: Studio header + Quick Start reflect viewed version (Playwright)

**FRs covered**: FR-13, FR-14, FR-15, FR-16, FR-18

**Setup**: Studio running, workflow with `v0.2.0` active + `v0.1.5` inactive.

**Steps**:

1. Navigate to Workflow Detail page. Assert header shows `[v0.2.0] [active]`, no caption.
2. Open Triggers tab → assert Webhook URL contains `?version=v0.2.0`.
3. Switch canvas to view `v0.1.5` via Versions tab.
4. Assert header shows `[v0.1.5] [inactive]` and caption `served via v0.2.0`.
5. Assert Quick Start URL now contains `?version=v0.1.5`.
6. Switch to `draft`. Assert `[draft]` (single badge — no state pill because state applies only to published versions), no caption, URL `?version=draft`.

### E2E-6: Agent tool binding version pin round-trip

**FRs covered**: FR-10, FR-11, FR-12

**Setup**: Agent DSL with a workflow tool bound. Version dropdown set to `v0.1.0` in `WorkflowConfigForm`.

**Steps**:

1. Save the tool binding. Assert DSL contains `workflow_version: "v0.1.0"`.
2. Reload agent into runtime. Trigger a session where the agent invokes the tool.
3. Inspect the engine request body — `workflowVersion: "v0.1.0"` present.
4. Assert `WorkflowExecution.workflowVersion` = `v0.1.0`.
5. Change binding to "Latest active (auto-resolve)". Re-save.
6. Assert DSL no longer contains `workflow_version` key.
7. Trigger again. Engine body does **not** include `workflowVersion`. Execution picks highest active semver (FR-8).

### E2E-7: Legacy `/api/v1/process/:workflowId` remains functional

**FRs covered**: NG1 (backward compat)

**Setup**: Same API key / workflow as E2E-1.

**Steps**:

1. `POST /api/v1/process/<wf_id>` with `{ input: {}, isAsync: false }` + `x-api-key`.
2. Assert HTTP 200 + workflow executes identically to short URL.
3. Assert no regression in response schema (existing tests in `process-api.e2e.test.ts` still pass).

### E2E-9: Execute response exposes resolvedVersion + resolvedVersionId (GAP-012)

**FRs covered**: observability on short URL execute (carries the decision of FR-8 / FR-2 back to the caller)

**Setup**: Workflow with `v0.1.0` active. One agent + API key from E2E-1 fixtures.

**Steps**:

1. `POST .../execute?mode=async&version=v0.1.0` with `x-api-key`.
2. Assert 202 response envelope includes `data.resolvedVersion === 'v0.1.0'` and `data.resolvedVersionId` matches the seeded `WorkflowVersion._id`.
3. `POST .../execute` (sync default) → resolve completion.
4. Assert 200 response `data.resolvedVersion === 'v0.1.0'` (default-resolved via FR-8).

Implemented in `workflows-execute.e2e.test.ts` as "async execute response envelope includes resolvedVersion and resolvedVersionId" + "sync completed response includes resolvedVersion for default-resolved versions".

### E2E-10: Execute route is rate-limited (GAP-010)

**FRs covered**: GAP-010 hardening

**Steps**:

1. `POST .../execute?mode=async` with `x-api-key`.
2. Assert response headers include non-empty `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` — proves `tenantRateLimit('request')` middleware is attached.

Quota-exhaustion 429 is covered by unit tests against the middleware (`apps/runtime/src/__tests__/auth/middleware.test.ts`) to avoid firing 100+ HTTP requests per suite.

Implemented in `workflows-execute.e2e.test.ts` as "execute response sets X-RateLimit-\* headers".

### E2E-11: Execute writes workflow.executed audit log (GAP-011)

**FRs covered**: GAP-011 hardening + compliance surface

**Steps**:

1. `POST .../execute?mode=async`. Capture `data.traceId`.
2. Poll `AuditLog.find({ action: 'workflow.executed', 'metadata.executionId': traceId })` up to 5s.
3. Assert exactly one record found; verify `metadata.workflowVersion`, `metadata.workflowVersionId`, `metadata.mode`, `metadata.apiKeyId` all present and match the request.

Implemented in `workflows-execute.e2e.test.ts` as "execute writes a workflow.executed audit log entry".

### E2E-8: Status-poll endpoint returns execution status + output

**FRs covered**: FR-21

**Setup**: Same API key / workflow as E2E-1. Workflow with `v0.1.0` active.

**Steps**:

1. `POST /api/v1/workflows/<wf_id>/execute?mode=async` with `x-api-key`. Capture `executionId` from 202 response.
2. `GET /api/v1/workflows/<wf_id>/executions/<executionId>` with `x-api-key` immediately.
3. Assert HTTP 200, body `{ status: 'running' }` or `{ status: 'completed' }` depending on timing.
4. Wait for completion (poll with short backoff up to 5s).
5. Assert final response contains `status: 'completed'` + `output` + `workflowVersion: 'v0.1.0'` (version pinned at dispatch is preserved on poll).
6. `GET .../executions/<executionId>` **without** `x-api-key` → HTTP 401.
7. `GET .../executions/<executionId>` with API key scoped to a different project → HTTP 404 (conceal).

**Isolation checks**: poll endpoint respects tenant + project scope identical to execute endpoint.

---

## 5. Integration Test Scenarios

### INT-1: Route mount alongside legacy

**FRs covered**: FR-1, NG1

In `process-api.integration.test.ts` extension, mount both routes on the same Express app and assert both respond without interference.

### INT-2: Proxy query + body precedence

**FRs covered**: FR-7

Call proxy route with both `?version=v0.1.0` and body `workflowVersion: "v0.2.0"`. Assert engine sees `v0.2.0` (body wins). Assert warning log emitted with structured fields `{ query: 'v0.1.0', body: 'v0.2.0' }`.

### INT-3: Semver resolver service-level

**FRs covered**: FR-8, FR-9

Call `resolveDefaultVersion()` directly with seeded fixtures: 3 active versions, deactivate mid-test, re-call — assert resolution changes deterministically.

### INT-4: Engine default-branch semver sort

**FRs covered**: FR-8 (engine)

In `system-execute-version.test.ts`, extend existing test with the multi-active scenario from E2E-3; assert engine's default resolution (no `workflowVersionId` in request) selects highest semver.

### INT-5: `WorkflowToolExecutor` version forwarding

**FRs covered**: FR-11

Unit-adjacent integration: construct an executor, register a binding with `workflowVersion: 'v0.1.0'`, invoke `execute()` with a test HTTP interceptor that captures the engine request body. Assert `body.workflowVersion === 'v0.1.0'`. Repeat with undefined — assert field absent.

### INT-7: Legacy webhook trigger resolves highest-semver active (GAP-009)

**FRs covered**: FR-8 (engine trigger-fire path)

`apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts` exercises `TriggerEngine.fireWebhookTrigger()` via DI test doubles (no vi.mock):

1. Legacy trigger (no pinned `workflowVersionId`, no deployment) against 3 active versions (`v0.9.0`, `v1.2.0`, `v0.10.0`) → engine picks `v1.2.0` and propagates its `workflowVersionId` on Restate input; working-copy draft steps NOT used.
2. Inactive candidate (state ≠ 'active') → excluded; falls to working copy.
3. Soft-deleted candidate (`deleted: true`) → excluded; higher semver still deleted loses to lower semver kept.

### INT-6: 404 conceal on cross-project semver pin-miss

**FRs covered**: FR-3, FR-6

API key scoped to project A; call short URL for a workflow in project B with a valid semver that exists in project B. Assert 404 `WORKFLOW_NOT_FOUND` (conceal) — never returns `WORKFLOW_VERSION_NOT_FOUND` (that would reveal the workflow exists elsewhere).

---

## 6. Manual / Staging Validation

1. Publish 3 versions of a workflow (`v0.1.0`, `v0.2.0`, `v0.10.0`) in Studio; activate all three. Navigate Workflow Detail page — verify `[v0.10.0] [active]` shown (not `v0.2.0` or `v0.1.0`).
2. Copy Quick Start URL; paste into curl; verify execution runs `v0.10.0` logically (check execution history).
3. Deactivate `v0.10.0`; copy URL again; verify it now pins `?version=v0.10.0` (viewed version unchanged) and execution returns 404 until version is reactivated or the URL is updated.
4. Create a new agent tool binding via Studio; pin `v0.2.0` in the popup; save; run a session that invokes the tool; verify `v0.2.0` ran.
5. Load a pre-existing agent tool binding saved before this feature; verify it continues to work, resolving to highest active semver.

---

## 7. Observability Checks

After implementation, verify in runtime logs / traces:

- `version` field present on execution-start log (`null` when absent, semver string when present).
- `workflow.version.resolution.miss` metric emitted on draft fallback (both runtime and engine).
- `proxy.version.conflict` warning emitted on body + query collision.
- No new error spikes in engine `/execute` endpoint vs pre-feature baseline.

---

## 8. Regression Guards

- Run full `process-api.e2e.test.ts` after changes — zero regression on legacy route behavior.
- Run full agent-tool E2E suite — zero regression on bindings without `workflowVersion`.
- Run Studio workflow tests — zero regression on unrelated tabs (canvas, executions, notifications).

---

## 9. Known Limitations (see feature spec §16)

- Pre-release semvers not supported in comparator (open question).
- No "snap-to current active at bind time" tool-binding option — only pin-specific or auto-resolve.
- `/api/v1/process/:workflowId` retains no sunset plan post-ship.

---

## 10. References

- Feature spec: [../../features/sub-features/workflow-webhook-versioning.md](../../features/sub-features/workflow-webhook-versioning.md)
- Parent testing guide: [workflow-triggers.md](./workflow-triggers.md)
- Related testing guides:
  - [workflow-versioning.md](./workflow-versioning.md)
  - [../workflow-as-tool.md](../workflow-as-tool.md)
  - [workflow-async-completion.md](./workflow-async-completion.md)
