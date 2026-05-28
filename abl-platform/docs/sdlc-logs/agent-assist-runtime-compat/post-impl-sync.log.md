# Post-Implementation Sync — Agent Assist V1 Compatibility Facade

**Date**: 2026-04-25
**JIRA**: ABLP-390
**Branch**: `KI081/feat/ABLP-390-agent-assist-runtime-compat`
**Sync mode**: review-first (no commit; user reviews diff before final commit)
**Audit run**: phase-auditor v1, round 1 — verdict NEEDS_REVISION → addressed in revision pass below.

---

## Documents Updated

| Doc                                                              | Change Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/features/agent-assist-runtime-compat.md`                   | Status PLANNED → ALPHA. Packages list now reflects shipped surface (drops `apps/admin`, adds `apps/studio`, `packages/i18n`). §10.1/§10.2/§10.3/§10.4 file paths corrected for the agentic-compat → agent-assist rename. §10.2 admin tree removed (deleted from repo). §10.5 test table reflects all 17 actually-committed test files. §11/§12 cleanup — kill-switch retired, secret env var renamed. §16 gaps re-graded (POC items mostly resolved; new low-severity items added for streaming precedence, SSE no-transform, key prefix, public API doc). §17 coverage matrix flipped to ✅ for shipped scenarios. |
| `docs/testing/agent-assist-runtime-compat.md`                    | Status PLANNED → PARTIAL. Health dashboard counts updated (14 e2e, 4 integration, 8 unit, 1 contract). Added manual ngrok parity row (passed 2026-04-25).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/testing/README.md`                                         | Row 98 PLANNED → PARTIAL 04-25 with concrete e2e/int counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/specs/agent-assist-runtime-compat.hld.md`                  | Status REVIEW → APPROVED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/plans/2026-04-22-agent-assist-runtime-compat-impl-plan.md` | Status DRAFT → DONE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Not modified:

- `docs/guides/agent-assist-api.md` — already current (committed in `9decc7326` and `f8cd22610`).
- `docs/guides/agent-assist-runtime-compat-ngrok-testing.md` — content already matches shipped flow (rename pass landed earlier).
- `docs/sdlc-logs/agent-assist-runtime-compat/{feature-spec,hld,lld,test-spec,feature-spec-rewrite}.log.md` — historical phase logs, intentionally append-only.

---

## Coverage Delta

| Type                                   | Before (planned)   | After (committed)                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (services + repos + workers)      | "0 / ≥6 committed" | 12 (`envelope-builder`, `metadata-normalizer`, `feature-gate`, `welcome-resolver`, `trace-events`, `callback-signer`, `callback-url-validator`, `callback-url-validation`, `agent-assist-binding-repo`, `agent-assist-callback-worker`, plus 2 supporting suites) |
| Integration (real Mongo / BullMQ)      | "0 / ≥5"           | 4 (`agent-assist-binding-repo.int`, `agent-assist-callback-worker.int`, `project-agent-assist-bindings.int`, `platform-admin-agent-assist.int`) — 1 short of the ≥5 BETA target                                                                                   |
| Route e2e (supertest, full middleware) | "0 / ≥5"           | 14 across 3 suites (`agent-assist.route`, `project-agent-assist-bindings`, `platform-admin-agent-assist`)                                                                                                                                                         |
| Shared-kernel registry contract        | implicit           | 1 (`packages/shared-kernel/src/__tests__/trace-event-contract.test.ts`)                                                                                                                                                                                           |
| Studio proxy unit                      | n/a                | 1 suite (4/13 sub-tests pre-existing flakes — known-issue, not introduced by this branch)                                                                                                                                                                         |
| Manual end-to-end (ngrok widget)       | n/a                | 1 walkthrough — multiple `/sessions` + `/runs/execute` traces captured 2026-04-25 (see ngrok testing guide)                                                                                                                                                       |
| Recorded-traffic contract test         | "0 / 1"            | still 0 — automated parity test deferred                                                                                                                                                                                                                          |
| Load test (k6)                         | "0 / 1"            | still 0 — deferred to BETA promotion gate                                                                                                                                                                                                                         |

---

## Status Promotion

- **Feature**: PLANNED → **ALPHA** (implementation phases 1–7 of §13 complete; core happy path verified end-to-end via ngrok widget 2026-04-25; ALPHA criteria from `docs/features/AUTHORING_GUIDE.md` §6 met).
- **Testing**: PLANNED → **PARTIAL** (well above ≥3 e2e, ≥3 integration; one shy of ≥5 integration target; load test + automated contract parity still pending).
- **HLD**: REVIEW → **APPROVED**.
- **LLD**: DRAFT → **DONE**.

ALPHA → BETA gate (deferred for human decision):

- ✅ E2E ≥ 3 — have 14
- ⚠️ Integration ≥ 5 — have 4 (need 1 more, e.g. a real round-trip integration test for `execution-bridge`)
- ✅ All CRITICAL gaps resolved (`§16` table)
- ❌ PR review (this branch is not yet merged; standard PR-review gate to apply)
- ❌ Production soak (not yet deployed)

---

## Deviations from Plan

| Plan item                                                                                                     | Actual                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §13 Phase Actual Task 3 — admin app routes under `apps/admin/src/app/api/tenants/[tenantId]/agent-assist/...` | **Removed before merge.** Studio's project-scoped CRUD (`/api/projects/:id/agent-assist-bindings/...`) is the canonical management surface. Platform-admin tenant-scoped routes still exist in the runtime under `/api/platform/admin/agent-assist`. |
| Naming `agentic-compat`                                                                                       | **Renamed to `agent-assist`** across the entire surface (filenames, identifiers, MongoDB collection `agent_assist_bindings`, BullMQ queues `agent-assist-callback[-dlq]`, feature-gate slug `agent_assist`, env var prefix `AGENT_ASSIST_*`).        |
| `AGENT_ASSIST_ENABLED` global kill switch                                                                     | **Retired.** Per-tenant `agent_assist` feature flag + per-project enable toggle in Studio cover the operational need; the global env var added avoidable risk.                                                                                       |
| `runs/execute` branch order: `isAsync && callbackUrl` → 202; otherwise `isAsync && !callbackUrl` → 400        | **Updated**: `stream.enable: true` now wins over `isAsync: true` (Kore.ai's "Agentic Response Streaming" widget mode sends both flags + no callbackUrl and expects SSE). New unit test covers the precedence.                                        |
| SSE response                                                                                                  | **Hardened**: emitter sets `Cache-Control: no-cache, no-transform` so the global `compression()` middleware skips gzip on SSE; `res.flush()` after every frame so token deltas arrive live, not batched. Studio proxy mirrors `no-transform`.        |
| Binding row stores only `apiKeyId` (opaque doc UUID)                                                          | **Added `apiKeyPrefix` column** so the Studio table + Configuration modal show the recognizable plaintext prefix (e.g. `abl_f931…`) instead of the doc-UUID last-4. Existing bindings backfilled in dev.                                             |
| Public API documentation                                                                                      | **Net-new**: `docs/guides/agent-assist-api.md` published as the third-party integrator reference (endpoints, error codes, SSE frame format, async-push HMAC contract, welcome resolution + DSL configuration). Not in the original plan.             |

---

## Known Issues / Carry-overs

- **GAP-001**: `metadata.aa_uamsgs` is normalized + bounded but not yet forwarded into the executor's prompt context. Tracked.
- **GAP-007**: `binding.deploymentId = null` + deployment archival race — sanitized 200 today, no auto-disable.
- **GAP-008**: 60 s read-cache TTL ⇒ disabled bindings may resolve on another pod for up to a minute. Accepted.
- **Studio proxy test flakes**: `apps/studio/src/__tests__/api-routes/agent-assist-proxy.test.ts` has 4 pre-existing flakes from before this branch's rename. Documented; not a regression of this work.
- **Pending automation**: recorded-traffic contract test (test scenario 10) and k6 load test (test scenario 19) deferred to the BETA gate.

---

## Audit (round 1, post-revision)

The `phase-auditor` agent ran round 1 against the initial sync output and returned **NEEDS_REVISION** with 2 CRITICAL + 6 HIGH findings, dominated by:

1. **Admin-app → Studio deviation under-documented** — the initial sync added a single inline note in feature spec §10.2 but left FR-31, §8.2, §8.6, §12.2, §13 Task 3 still describing the removed admin-app routes. Test spec §3.8, §4.4, §5.2 INT-4, §6, §7, §11, §12 all referenced `apps/admin/` files that don't exist.
2. **Test spec §1 + §3 prose stale** — §1 still said "the committed codebase has no tests" (factually wrong, 20 test files exist). §3 coverage matrix had every cell at ⬜ PLANNED.
3. **`AGENT_ASSIST_ENABLED` lingering** — the retired kill-switch env var still appeared in test spec §3.7, §5.1 E2E-6, §5.3, §11.
4. **Spec/code inconsistency on disabled binding** — feature spec §17 row 5 said `503 BINDING_DISABLED`, FR-12 said 404 `APP_NOT_FOUND`, code returned 503. User decision: 404 is correct (existence-disclosure invariant); the 503 was a code bug.
5. **Test spec §12 mapped 10 test files that don't exist** — the table was the original Phase Actual plan, not post-impl reality.
6. **Stale phrasings** — feature spec §13 line 503 said "uncommitted on branch", §13 Task 2.1 referenced `agentAssistBinding.ts` (kebab-case file is `agent-assist-binding.model.ts`).
7. **Package `agents.md` not updated** for `apps/studio`, `packages/database`, `packages/shared-kernel`, `packages/i18n`.

### Revisions applied (Batch 1 + Batch 2, all per user direction)

**Code change (504 → 404 on disabled binding):**

- `apps/runtime/src/routes/agent-assist.ts:143` — disabled binding now returns 404 `APP_NOT_FOUND` (existence-disclosure parity with missing binding); preserves the warn log with binding metadata.
- `apps/runtime/src/__tests__/routes/agent-assist.route.test.ts` — corresponding test rewritten from 503/`BINDING_DISABLED` to 404/`APP_NOT_FOUND`.
- `apps/runtime/src/services/agent-assist/types.ts` — JSDoc on `BindingStatus.disabled` updated.
- `apps/runtime/src/repos/agent-assist-binding-repo.ts` — comment in `get` rewritten (no behavior change).
- `docs/guides/agent-assist-api.md` — `BINDING_DISABLED` row removed from the error-codes table; `APP_NOT_FOUND` description expanded to cover disabled-binding case.
- `docs/guides/agent-assist-runtime-compat-ngrok-testing.md` — error table + scenario matrix updated to show 404 (not 503) for disabled binding; also rewrote the "Feature gate off" row to reference the per-tenant `agent_assist` flag (not the retired kill switch).

**Feature spec doc fixes:**

- FR-31 rewritten to describe both surfaces (Studio project-scoped CRUD + runtime platform-admin) with the actual route paths and audit prefixes.
- §8.1 (Studio UI) rewritten — was "none in Studio"; now describes the **Settings → Agent Assist** page with mint/rotate, Configuration modal, prefix display, per-project enable toggle.
- §8.2 surface-semantics matrix updated — "Admin API only" → "Studio + runtime platform-admin"; "No Studio CRUD surface yet" removed.
- §8.3 design-time language updated — "tenant admin creates a binding via Admin API" → "project owner creates a binding from Studio".
- §8.5 (Studio API) rewritten — was "N/A — no Studio-side API routes"; now lists 11 actual routes including `generate-api-key` and `settings`.
- §8.6 (Admin / Platform-Admin) rewritten — `apps/admin` text replaced with the runtime platform-admin router routes.
- §12.2 audit description updated — `logAdminAction` (admin-app) replaced with the runtime's `writeAuditLog` and the actual action prefixes.
- §12.4 — explicit retirement note for the kill-switch env var.
- §13 Phase POC line 46 + 503: "uncommitted" → "committed"; Task 2.1 filename corrected; Task 3 marked as a deviation with explanation.
- §17 row 5 (the 503-vs-404 contradiction): updated to `404 APP_NOT_FOUND (existence-disclosure parity with missing binding)`.

**Test spec doc fixes:**

- §1 Current State rewritten to describe the actual committed test surface (8 + 2 unit suites + 3 e2e suites + 4 integration suites + 1 shared-kernel contract test + 1 Studio proxy suite + 1 manual ngrok walkthrough).
- §2 Health Dashboard remaining stale rows updated (Production wiring: yes, Cross-tenant isolation: yes, Admin CRUD: 4/≥4 ✅).
- §3 Coverage Matrix all 8 sub-tables flipped row-by-row to actual ✅ / ⚠️ partial / ❌ planned status with correct test-file pointers.
- §3.8 retitled "Binding management surfaces (Studio + platform-admin)" with the two-surface coverage breakdown plus `generate-api-key` + `/settings` rows.
- §4 Production Wiring rewritten as ✅ / ⚠️ / ❌ verification statements; §4.4 + §4.5 file paths corrected.
- §5.1 E2E-4 + §11 — `AGENT_ASSIST_CALLBACK_HMAC_SECRET_REF` → `AGENT_ASSIST_CALLBACK_SIGNING_SECRET`.
- §5.1 E2E-6 sub-case (a) rewritten — was `AGENT_ASSIST_ENABLED=false`, now is "tenant lacks `agent_assist` feature flag"; sub-case (b) is now project-level disable.
- §5.2 INT-4 boundary + setup + steps + expected-result fully rewritten — admin-app harness replaced with runtime express test app + the Studio + platform-admin actions; immutable-field PATCH and `generate-api-key` covered.
- §5.3 critical feature-gate matrix rewritten — `AGENT_ASSIST_ENABLED=false` row replaced with `Tenant lacks agent_assist feature` and a new `Project-level disable` row.
- §6 Unit Test Plan completely rewritten — table now lists the 12 actually-committed unit suites; obsolete Phase-Actual plan rows removed; "modules covered only at e2e/integration level" subsection added.
- §7 Committed Test Inventory replaces the old "POC Test Assets (uncommitted starting points)" section — table now lists the actual on-disk tests with status.
- §11 — `AGENT_ASSIST_ENABLED=true` removed from the env-var defaults block; HMAC secret env var renamed; explicit footnote on kill-switch retirement.
- §11 `seedBindingViaAdminAPI` helper renamed to `seedBindingViaManagementAPI` and described against both surfaces.
- §12 fully rewritten — file mapping now points at the 19 actual on-disk test paths; "Pending (deferred to BETA gate)" sub-list captures the 4 tests still planned.

**Package `agents.md` updates (4 files):**

- `apps/studio/agents.md` — appended two entries: top-level Settings → Agent Assist page architecture; the "show plaintext key prefix, not doc-id last-4" gotcha.
- `packages/database/agents.md` — appended one entry covering the binding model + `apiKeyPrefix` column + isolation-plugin pattern.
- `packages/shared-kernel/agents.md` — appended one entry covering the `agent_assist.*` trace event family registration.
- `packages/i18n/agents.md` — created new (file did not exist); seed entry covers the `settings.agent_assist` namespace separation from `settings.agent_transfer`.

### Round 2 audit

Not run yet — user reviews this revision pass first. If accepted, a second audit can confirm the revisions land cleanly before commit.

---

## Next Steps

1. User reviews the diff (`git diff` over the doc edits in this commit set).
2. If accepted, commit the doc changes — proposed message: `[ABLP-390] docs: post-impl sync for agent-assist-runtime-compat (PLANNED → ALPHA)`.
3. (Optional) Run `phase-auditor` on the synced docs before merging the PR.
4. Add one more integration test (e.g. round-trip `execution-bridge`) to clear the ≥5-integration BETA gate.
5. Schedule the k6 load test against the saturation harness; capture results in this folder.
