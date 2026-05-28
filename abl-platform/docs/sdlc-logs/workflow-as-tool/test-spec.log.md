# SDLC Log — workflow-as-tool — test-spec phase

**Date**: 2026-04-13
**Skill**: /test-spec
**Inputs**: docs/features/workflow-as-tool.md
**Output**: docs/testing/workflow-as-tool.md

## Oracle decisions (Phase 2)

All 15 questions resolved (no AMBIGUOUS escalations).

| #   | Class    | Note                                                                                                                                |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | DECIDED  | Highest risk: FR-5 (sync poll/timeout/cancel) and FR-2/FR-3 (validation/isolation)                                                  |
| Q2  | INFERRED | Mirror SearchAI executor edge cases; preempt Restate 502, deleted-workflow-after-bind                                               |
| Q3  | DECIDED  | Greenfield coverage; no existing workflow-tool tests                                                                                |
| Q4  | INFERRED | DI fakes for Restate + Mongoose models per `workflow-executions-routes.test.ts:39-51`; real Express on random port; real JWT secret |
| Q5  | ANSWERED | In-process Express + supertest pattern; no Docker; CI uses `pnpm test`                                                              |
| Q6  | DECIDED  | 5 critical journeys: sync happy, async immediate, sync timeout cancel, validation reject (cron-only), cross-project reject          |
| Q7  | INFERRED | Internal JWT scoped to tenantId; mismatched tenantId → 404 (CLAUDE.md invariant 1)                                                  |
| Q8  | DECIDED  | Multi-turn covered (E2E-6); multi-agent handoff out of v1 scope                                                                     |
| Q9  | INFERRED | 4 fixture workflows: sync-webhook, async-webhook, cron-only, cross-project                                                          |
| Q10 | DECIDED  | One parallel integration test (INT-7); no formal load scenario in v1                                                                |
| Q11 | ANSWERED | Three boundaries: executor↔engine HTTP, validator↔DB, IR loader↔DB                                                                  |
| Q12 | INFERRED | Trigger lookup tested at validator integration level (INT-4)                                                                        |
| Q13 | ANSWERED | Cross-project & cross-tenant both → 404 (engine already filters by `{tenantId, projectId}`)                                         |
| Q14 | DECIDED  | Two concurrency scenarios: external cancel mid-poll, parallel independence; skip JWT-expiry race                                    |
| Q15 | ANSWERED | Failure paths: 502 Restate, 404 deleted workflow, sync timeout cancel, terminal failed/rejected, 400 malformed                      |

Full oracle output is in conversation history (Phase 2 spawn).

## Decisions logged on the spec

- D-1: FR-5 + FR-2/FR-3 carry the highest E2E + integration weight.
- D-3: No baseline coverage to track; greenfield.
- D-6: 5 critical E2E journeys + 1 multi-turn (E2E-6) = 6 total; ≥ 5 mandate satisfied.
- D-8: Cross-feature: multi-turn yes, multi-agent no (v1).
- D-10: 1 parallel integration test; load testing deferred.
- D-14: External cancel + parallel independence; JWT race excluded (1h vs 60s).

## Audit rounds (Phase 4b)

### Round 1 — NEEDS_REVISION

3 CRITICAL + 4 HIGH findings:

- E2E-5 step 2 used direct DB insertion → replaced with API-only stale-binding flow (create + archive via PATCH).
- E2E-6 used direct DB query for assertion → replaced with HTTP `GET .../executions?sessionId=` and cross-tenant 404 check.
- Server setup not explicit per scenario → added "Server setup" line stating real Express + random port + full middleware to E2E-1..E2E-6.
- Missing 401/403 coverage → added new E2E-7 (no auth, expired token, VIEWER role on tool create, internal-JWT verification).
- INT-7 had no FR mapping → added FR-1 rationale (executor interface parity vs SearchAI).
- Added test file mapping entry for E2E-7.

### Round 2 — APPROVED

All R1 findings resolved. One MEDIUM (FR-7 E2E matrix cell should be ✅ since E2E-7 step 4 covers it) — applied.

Final counts: **7 E2E scenarios, 7 integration scenarios, 6 unit scenarios.** All FR-1..FR-10 in coverage matrix.

## Next phase

- Run `/hld workflow-as-tool` → produces `docs/specs/workflow-as-tool.hld.md`.
- Open testing questions in §9 of the spec — feed into HLD review.

---

## 2026-04-14 — Revision: BETA-gap UI E2E for FR-8/FR-9

**Trigger**: Post-impl-sync (2026-04-13) listed FR-8/FR-9 automated Studio UI tests as BETA promotion blockers. Re-invoked `/test-spec workflow-as-tool` to extend the existing STABLE spec with automated Playwright UI E2E coverage.

### Oracle decisions (Phase 2)

13 clarifying questions, all resolved as ANSWERED/INFERRED/DECIDED. No AMBIGUOUS escalations.

Key decisions:

- D-1: UI specs live at `apps/studio/e2e/workflow-tool-*.spec.ts` (Tools-page tier), not under `e2e/workflows/` (canvas tier).
- D-4: Manual smoke test doc kept as visual/UX regression checklist; coexists with automated tests.
- D-6: One test seeds two workflows (sync + async webhook) for mode-default coverage.
- D-7: FR-9 uses cron-only workflow (more realistic than zero-trigger).
- D-10: Playground integration deferred — already covered by backend E2E-1/E2E-2.

### Changes to test spec

- §1 Coverage Matrix: FR-8/FR-9 E2E column ❌ → 🟡 with transition criteria; legend added.
- §2 E2E: 4 new scenarios appended (UI-E2E-1..4) — workflow+webhook picker & mode default; cron-only empty state; tab + deep-link; badge + binding panel.
- §2 Prerequisite block: required `data-testid` attributes for `ToolsListPage`, `ToolCreateDialog`, `WorkflowConfigForm`, `ToolDetailPage`, `ToolTypeBadge`.
- §8 Test File Mapping: 2 new Playwright spec rows (`workflow-tool-config.spec.ts`, `workflow-tool-list.spec.ts`).
- §9 Open Questions: items 4–5 added (manual-doc coexistence, timing-fragility caveat).

### Audit rounds

| Round | Verdict                | Findings                                                                      | Resolution                          |
| ----- | ---------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| 1     | APPROVED with findings | 1 HIGH (UI-E2E-4 isolation), 2 MEDIUM (file path convention, UI-E2E-3 timing) | All 3 fixed in-place before round 2 |
| 2     | APPROVED               | 0                                                                             | Ready to commit                     |

### Final counts (this revision)

- E2E: 7 backend + **4 new UI** = 11 total
- Integration: 7 (unchanged)
- Unit: 6 (unchanged)

### Next phase

- Run `/hld workflow-as-tool-ui-tests` (lightweight — mostly testing-architecture decisions) OR skip to `/lld` since architecture is "Playwright spec at known path with prescribed testids."
- Implementer must first ship the testid additions in a separate `test(studio)` commit (additive, no behavior change), then land UI-E2E-1..2 and UI-E2E-3..4 as two follow-up commits to respect commit-scope-guard limits.
- Once all 4 UI-E2E scenarios pass in CI, flip FR-8/FR-9 STATUS column STABLE and bump feature spec PLANNED→ALPHA→BETA.
