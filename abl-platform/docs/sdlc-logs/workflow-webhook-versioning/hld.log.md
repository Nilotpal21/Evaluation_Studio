# HLD Log — workflow-webhook-versioning

**Date**: 2026-04-18
**Skill**: `/hld`
**Artifact**: `docs/specs/workflow-webhook-versioning.hld.md`
**Prior phase**: feature-spec (committed 2026-04-17)

---

## Phase 1 — Prerequisites

- Feature spec: `docs/features/sub-features/workflow-webhook-versioning.md` (20 FRs)
- Test spec: `docs/testing/sub-features/workflow-webhook-versioning.md` (21-row coverage matrix)
- Prior HLDs consulted: `workflow-triggers.hld.md`, `workflow-versioning.hld.md`, `workflow-as-tool.hld.md`

## Phase 2 — Oracle Clarification

Invoked `product-oracle` with 20 clarifying questions across Architecture & Data Flow, Integration & Dependencies, Risk & Migration. All 20 resolved.

- ANSWERED: 14
- INFERRED: 4
- DECIDED: 2
- AMBIGUOUS: 0

### DECIDED items (flagged)

| #         | Decision                                                                                                                                 | Rationale                                                                                                 | Risk |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- |
| D-1 (Q2)  | `semver ^7.7.4` added as prod dep to `apps/runtime/package.json` + `apps/workflow-engine/package.json` independently, NOT shared package | Only 2 consumers; shared package causes broader install propagation                                       | Low  |
| D-2 (Q13) | No per-tenant feature flag for the semver-sort behavior change                                                                           | Prior behavior is non-deterministic (bug class); rollback = prior build deploy or per-workflow deactivate | Low  |

### Two additional DECIDED items surfaced during HLD writing (documented in HLD §10)

| #   | Decision                                                                                                            | Rationale                                                                     | Risk |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---- |
| D-3 | Shared handler extracted into `apps/runtime/src/routes/process-api.ts` as exported helper, not moved to `services/` | Matches repo convention; no existing precedent for route logic in `services/` | Low  |
| D-4 | Explicit-pin lookup = new repo function `findWorkflowVersionByAnyState()`, not an option flag on existing function  | Repo convention: single-responsibility filter semantics per function          | Low  |

### Key oracle insights (beyond feature spec)

- **Engine semver-string field is accepted by Zod but ignored in resolution today** (`workflow-executions.ts:97-106` vs `:280-324`). This feature introduces the semver-string resolver branch — new behavior, not a modification.
- **`SessionService.computeIRHash()` via `JSON.stringify(ir)`** naturally picks up the new `workflowVersion` field; no manual cache invalidation needed.
- **`process-api.e2e.test.ts` uses DI-mocked engine** (external-service boundary per CLAUDE.md), not `vi.mock`. New E2E tests follow same pattern.
- **No Studio E2E asserts on URL string content** — URL shape change is safe.
- **`semver ^7.7.4`** matches existing devDep transitive version; pin to match.
- **Version strings are strictly `v{M}.{m}.{p}` or literal `draft`** per `nextVersion()`. No pre-release strings in practice.

## Phase 3 — Generation

- HLD written: `docs/specs/workflow-webhook-versioning.hld.md`
- `tools/design-lint.sh` — 95% completeness, 19 PASS / 1 WARN (open questions remain — expected) / 0 MISSING
- 12 architectural concerns addressed (not N/A'd except where genuinely absent)
- 3 alternatives considered (A: path-segment, B: long-URL-only, C: short-URL + semver-sort + binding) with Option C recommended

## Phase 4b — Audit Loop

### Round 1 — NEEDS_REVISION (2 CRITICAL, 3 HIGH, 3 MEDIUM)

| ID                                       | Severity | Fix                                                                                                                                                                                    |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HD-6 Section numbering                   | CRITICAL | Renumbered sections 1→13 (was 1, 2, 2, 3, 4, ...)                                                                                                                                      |
| HD-5 Error code mismatch                 | CRITICAL | `UPSTREAM_ERROR` → `UPSTREAM_UNAVAILABLE` to match existing `process-api.ts:341,412`                                                                                                   |
| HD-6 Status poll endpoint no FR          | HIGH     | Added FR-21 to feature spec + test-matrix row for it                                                                                                                                   |
| HD-4 DSL lockstep 4th+5th site           | HIGH     | Updated dependency table + references to enumerate all 4 lockstep sites: `schema.ts:891`, `dsl-property-parser.ts:519` (interface), `:541` (parser), `resolve-tool-implementations.ts` |
| HD-5 Shared handler boundary             | HIGH     | Clarified in concern #2: version resolution runs in each route adapter BEFORE invoking shared handler; shared handler takes pre-resolved `{ workflowVersionId, workflowVersion }` pair |
| HD-3 WorkflowConfigForm overstatement    | MEDIUM   | Reworded: component has version dropdown today (used for trigger filtering), this feature extends it to persist into DSL                                                               |
| HD-3 Async-push data flow missing        | MEDIUM   | Added one-paragraph "Async-push callback flow (unchanged)" block with cross-reference to workflow-async-completion HLD                                                                 |
| HD-8 Rollout Stage 4 Docker coordination | MEDIUM   | Added sentence about engine Docker rebuild + engine-first safe deploy order                                                                                                            |

### Round 1 — Fix Summary (5 bullets)

1. Section numbering fixed — all 13 sections now contiguously numbered.
2. Error codes harmonized with existing `process-api.ts` vocabulary (`UPSTREAM_UNAVAILABLE`, `SYNC_UNAVAILABLE`).
3. Status-poll endpoint now has FR-21 in feature spec + row in test coverage matrix.
4. DSL compiler lockstep enumerated to 4 sites (was 3); risk level bumped to Medium.
5. Shared-handler boundary made explicit: version resolution is per-adapter, not shared.

design-lint rerun: **95% PASS**, no new violations.

### Round 2 — NEEDS_REVISION (1 CRITICAL, 1 HIGH, 3 MEDIUM)

| ID                                           | Severity | Fix                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HD-5 residual `UPSTREAM_ERROR`               | CRITICAL | Removed `UPSTREAM_ERROR` from Concerns #3 and #6; only `UPSTREAM_UNAVAILABLE` remains (matches `process-api.ts:341,412`).                                                                                                                                                          |
| HD-5 mode→engine two-field mapping           | HIGH     | Added to Concern #3: `sync` → `{webhookMode:'sync'}`; `async` → `{webhookMode:'async', webhookDelivery:'poll'}`; `async_push` → `{webhookMode:'async', webhookDelivery:'push'}`.                                                                                                   |
| HD-7 idempotency line ref wrong              | MEDIUM   | Replaced `process-api.ts:228-237` reference with correct attribution: engine supports it at `workflow-executions.ts:98`; runtime short URL acceptance is new; refer to `workflow-engine/agents.md` for boundary-validation. Also added `executionId?` to body shape in Concern #3. |
| HD-4 resolve-tool-implementations overstated | MEDIUM   | Clarified: 3 code-change sites + 1 verification site (no code change — passes whole `WorkflowBindingLocal` object at line 571).                                                                                                                                                    |
| HD-3 component-diagram arrow                 | MEDIUM   | Redrew arrows: repo functions called by ROUTE ADAPTER before shared handler; two labeled arrows (state-agnostic for new URL, state-filtered for legacy).                                                                                                                           |

### Round 2 — Fix Summary (5 bullets)

1. Removed every `UPSTREAM_ERROR` reference; all 502 errors now use `UPSTREAM_UNAVAILABLE`.
2. Documented the two-field engine contract: `?mode=` (single query) decomposes to `{webhookMode, webhookDelivery}` in the adapter.
3. Corrected `executionId` attribution — new for runtime short URL, existing on engine. Added `executionId?` to body shape.
4. DSL lockstep refined to "3 code + 1 verify" to avoid implying an unnecessary change in `resolve-tool-implementations.ts`.
5. Component diagram redrawn to show version resolution happening in the adapter, not the shared handler.

design-lint rerun: **95% PASS**, 0 `UPSTREAM_ERROR` occurrences.

### Round 3 — APPROVED

**Verdict**: APPROVED. 0 CRITICAL, 0 HIGH, 1 MEDIUM.

| ID                 | Severity | Location                                   | Resolution                                                                                                                                                                  |
| ------------------ | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XP-3 FR-21 E2E gap | MEDIUM   | test spec coverage matrix vs E2E scenarios | Fixed — added **E2E-8** scenario in `docs/testing/sub-features/workflow-webhook-versioning.md` exercising the status-poll endpoint (happy path + auth + cross-project 404). |

All 8 R1/R2 fixes verified by auditor. All 8 code-reference spot-checks passed. All 10 concern-checklist items verified.

### Auditor notes for LLD phase

1. FR-21 E2E coverage now in place (E2E-8) — compiler lockstep phase should verify E2E-8 passes before declaring Phase 2 complete.
2. Compiler lockstep (3 code + 1 verify) should be a single atomic commit.
3. Stage 4 (semver-sort) requires explicit runtime↔engine parity verification — E2E-4 is the keystone.

---

## Phase 5 — Commit

Pending commit — see git log for `[ABLP-2] docs(workflow-engine): add workflow-webhook-versioning HLD`.

### Package agents.md updates

Not required at HLD phase — design docs are not package-specific. LLD phase may add entries per `docs/sdlc/pipeline.md` package-learnings rules. Delivery plan task 6.3 (from feature spec) covers post-impl agents.md updates.

### Next phase

Run `/lld workflow-webhook-versioning` to generate the phased implementation plan with exit criteria. Run `/compact` first per pipeline rules.
