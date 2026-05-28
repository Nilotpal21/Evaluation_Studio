# Feature Spec Log — workflow-webhook-versioning

**Date**: 2026-04-17
**Skill**: `/feature-spec`
**Artifact**: `docs/features/sub-features/workflow-webhook-versioning.md`
**Testing Placeholder**: `docs/testing/sub-features/workflow-webhook-versioning.md`
**Related Parents**: `workflow-triggers`, `workflow-versioning`, `workflow-as-tool`

---

## Phase 1 — Discovery & Clarification

### Prior art consulted

- `docs/features/sub-features/workflow-triggers.md` — parent; NG6 defers versioning integration
- `docs/features/sub-features/workflow-versioning.md` — `WorkflowVersion` state machine + FR-14 resolveDefault
- `docs/features/workflow-as-tool.md` + `docs/specs/workflow-as-tool.hld.md` — `WorkflowBindingIR`, `WorkflowConfigForm`
- `apps/runtime/src/routes/process-api.ts` — existing `/api/v1/process/:workflowId` route
- `apps/runtime/src/services/workflow-version-service.ts:695` — `resolveDefaultVersion` (currently sorts by publishedAt)
- `apps/workflow-engine/src/routes/workflow-executions.ts:311` — engine default branch (no sort)
- `apps/runtime/src/middleware/workflow-engine-proxy.ts` — proxy body-only version read
- `apps/runtime/src/services/workflow/workflow-tool-executor.ts` — missing `workflowVersion` field
- `apps/studio/src/components/workflows/WorkflowDetailPage.tsx:96-106` — existing single-badge logic
- `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` + `CodeSnippets.tsx` — existing panel
- `packages/compiler/src/platform/ir/schema.ts:891-902` — `WorkflowBindingIR` type

### Oracle agent invocation

Invoked `product-oracle` with 20 clarifying questions across Scope & Problem, User Stories & Requirements, Technical & Architecture. All 20 resolved — no AMBIGUOUS escalations.

### Classification breakdown

- ANSWERED: 13 (strong code/doc evidence)
- INFERRED: 4 (established patterns)
- DECIDED: 3 (oracle judgment calls, flagged for user review)
- AMBIGUOUS: 0

### Oracle DECIDED items (flagged for user)

| #         | Decision                                                                                                                  | Rationale                                                                                                                          | Risk                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| D-1 (Q1)  | Doc type = SUB-FEATURE under `docs/features/sub-features/workflow-webhook-versioning.md` (parent: `workflow-triggers.md`) | Incremental enhancement bridging existing sub-features. All three parents are already sub-features.                                | Low                                                                     |
| D-2 (Q7)  | When viewing an inactive version, URL pins `?version=<viewed>` + "served via" caption                                     | Developers need to test specific versions; production callers use version-less URL. Inactive pin-miss 404 is informative feedback. | Low — easy to reverse if user feedback prefers "always show active URL" |
| D-3 (Q10) | Version badge clickable (→ Versions tab); state badge tooltip only                                                        | Matches Studio navigation patterns (count badges link to their tab). Lightweight.                                                  | Low                                                                     |

### Key oracle answers

- **Q2** (Renaming `/api/v1/process`): Adding **new** route alongside. No deprecation. Studio stops surfacing legacy URL; it stays wired for backward compat.
- **Q3** (Long proxy URL): Kept internal-only. Used by `WorkflowToolExecutor` (agent path) and Studio design-time "Run". No external consumer to break.
- **Q4** (Engine default resolution): Engine currently has **no sort** — critical parity bug. Runtime sorts by `publishedAt`. This feature fixes both to semver-desc.
- **Q13** (Semver sort impl): Client-side sort fine; version counts <50 per workflow. No denormalization needed. Add `semver` npm dep to a shared package.
- **Q15** (Binding migration): Zero-touch. `WorkflowBindingIR` is in-memory IR; DSL parse of missing `workflow_version` → `undefined` → auto-resolve.
- **Q16** (Register-Workflow popup): **Already exists** — `WorkflowConfigForm.tsx` ships a 3-dropdown picker. Only plumbing change needed (persist selected version into binding DSL).

---

## Phase 2 — Generation

- Feature spec written: `docs/features/sub-features/workflow-webhook-versioning.md` (20 FRs, 6 user stories, 5 major goals, 7 non-goals, 5 gaps)
- Testing guide placeholder: `docs/testing/sub-features/workflow-webhook-versioning.md` (20-row coverage matrix, 7 E2E scenarios, 6 integration scenarios, 5 manual checks)

Key design choices grounded in code:

1. **Short URL = runtime route, not engine route** — matches process-api proxy pattern (`process-api.ts:319-329`)
2. **Client-side semver sort** — no schema migration
3. **Query-param `?version=` (not path segment)** — matches `process-api.ts:166` convention
4. **Additive binding field** — zero migration per `schema.ts:891` pattern

---

## Phase 3 — Testing Guide Placeholder

Written. Contains 20-row coverage matrix, 7 E2E scenarios, 6 integration scenarios, manual/staging validation, observability checks, regression guards. Keystone test is E2E-4 (runtime ↔ engine resolution parity).

---

## Phase 4 — Index Updates

- `docs/features/sub-features/README.md` — appended row
- `docs/testing/sub-features/README.md` — appended row

Top-level `docs/features/README.md` and `docs/testing/README.md` not touched (sub-features don't appear there; the sub-feature index is the source of truth).

---

## Phase 4b — Audit Loop

### Round 1 — Findings

**Verdict**: NEEDS_REVISION — 3 CRITICAL, 5 HIGH, 3 MEDIUM findings.

| ID                                         | Severity | Location                                 | Fix Applied                                                                                                                                                                                                                 |
| ------------------------------------------ | -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| FS-2 (FR-18 contradiction)                 | CRITICAL | Feature spec line 103 vs test spec E2E-2 | Rewrote FR-6, FR-18 to state explicit pinning **bypasses** `state: 'active'` filter — inactive versions execute when pinned by exact semver. Documented engine parity (`workflow-executions.ts:290-305` already does this). |
| FS-3 (FR-2 mode enum incomplete)           | CRITICAL | FR-2 vs FR-16                            | Clarified that `async_poll` is a UI display label, not a route-level mode; route accepts 3 values (`sync`, `async`, `async_push`). `async_poll` tab uses `?mode=async` + shows a second poll curl.                          |
| FS-2 (error code mismatch)                 | CRITICAL | FR-6                                     | Documented new short URL uses `WORKFLOW_VERSION_NOT_FOUND` (engine-consistent); legacy `/api/v1/process` keeps `VERSION_NOT_FOUND` for backward compat. Both codes documented in API reference.                             |
| FS-2 (Problem Statement #1 stale)          | HIGH     | Line 20-21                               | Rewrote to distinguish (a) route not mounted and (b) URL version-less, and noted the CodeSnippets ↔ WebhookQuickStart inconsistency.                                                                                        |
| FS-2 (semver dep claim)                    | HIGH     | Section 7                                | Corrected — `semver` is transitive devDep only; must be added as production dep to runtime + engine or a shared package. Updated delivery plan task 1.3.                                                                    |
| FS-8 (delivery plan + error code)          | HIGH     | Section 13                               | Added task 1.6 for state-agnostic explicit-pin lookup + error-code handling.                                                                                                                                                |
| FS-10 (feature index updates)              | HIGH     | top-level READMEs                        | Added entries to `docs/features/README.md` and `docs/testing/README.md`.                                                                                                                                                    |
| FS-3 (FR-4 mode interface ambiguity)       | HIGH     | FR-4                                     | Clarified that the shared handler takes a **normalized mode enum**, not raw body — each route adapter (short URL query param, legacy body `isAsync`) normalizes before invoking.                                            |
| FS-2 (CodeSnippets long URL today)         | MEDIUM   | Section 6/7                              | Added explicit note in Problem Statement #1.                                                                                                                                                                                |
| FS-9 (semver as unit test)                 | MEDIUM   | Testing section                          | Split scenario 4 into 4a (unit) + 4b (integration).                                                                                                                                                                         |
| FS-7 (`WorkflowBindingIR.mode` enum scope) | MEDIUM   | Section 9                                | Binding stays `sync                                                                                                                                                                                                         | async` — LLM tool surface doesn't expose push/poll. Updated section (next edit) — see round 2 if needed. |
| XP-5 (compiler lockstep)                   | HIGH XP  | Task 2.2                                 | Added compiler-lockstep gotcha note referencing `packages/compiler/agents.md`.                                                                                                                                              |

### Round 1 — Fix Summary (5 bullets)

1. **Inactive-version pin semantics clarified**: explicit pins bypass `state: 'active'` filter (matches engine behavior); default resolution still requires active. Runtime handler replaces `findActiveWorkflowVersion()` with state-agnostic lookup for explicit pins.
2. **Mode enum normalized**: route accepts 3 values (`sync`, `async`, `async_push`); `async_poll` is UI-only.
3. **Error codes harmonized**: new route uses `WORKFLOW_VERSION_NOT_FOUND`; legacy route keeps `VERSION_NOT_FOUND`.
4. **semver dep correction**: must be added as prod dep; delivery plan updated.
5. **Index discoverability fixed**: top-level READMEs now list this sub-feature.

### Round 2 — APPROVED

**Verdict**: APPROVED. 0 CRITICAL, 0 HIGH, 1 MEDIUM (cosmetic).

| ID                       | Severity | Location             | Resolution                                                                                                                                                        |
| ------------------------ | -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-2 (index field order) | MEDIUM   | Section 9 Data Model | Fixed — updated to match actual `workflow-version.model.ts:122-134` order (tenantId first, not workflowId; included `deleted` + `publishedAt` in compound index). |

### Round 2 — Fix Summary (1 bullet)

1. Data model index definitions now mirror actual schema (`packages/database/src/models/workflow-version.model.ts:122-134`).

### Auditor notes for next phases

- HLD should formalize the two explicit-pin resolution paths: engine's `_id`-based pin (existing, internal) vs the new short URL's semver-string-based pin (new, external).
- HLD should resolve GAP-005: `semver` package placement (per-app vs shared package).
- All code references spot-checked by auditor (5/5 passed against actual repo state).

---

## Phase 5 — Commit & Logs

Pending commit — see git log for `[ABLP-2] docs(features): add workflow-webhook-versioning feature spec`.

### Package agents.md updates

Not required at this phase — feature spec phase creates specs, not code. Delivery plan task 6.3 covers agents.md updates after implementation via `/post-impl-sync`.

### Next phase

Run `/test-spec workflow-webhook-versioning` to generate the full test specification (current file is a coverage-matrix placeholder). Then `/hld workflow-webhook-versioning` for architecture, then `/lld workflow-webhook-versioning` for implementation plan.
