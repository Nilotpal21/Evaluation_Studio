# Implementation Log — cross-provider-quorum-convergence

**Ticket:** ABLP-406
**LLD:** `docs/plans/2026-04-19-cross-provider-quorum-convergence-impl-plan.md`
**Started:** 2026-04-19

---

## Phase 0 — Preflight

### Artifact anchors re-verified against main

All LLD line-number anchors re-checked against current develop HEAD (post-LLD commit `894a4b35f`) before implementation begins.

| Anchor                                                              | LLD claim                                                  | Actual (2026-04-19) | Drift |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- | ----- |
| `ModelEngine` union in `types.ts`                                   | line 269                                                   | line 269            | ✓     |
| `executeOracleReview` `modelRouter.execute` site                    | line 282                                                   | line 282            | ✓     |
| `defaultOracles` const                                              | line 355                                                   | line 355            | ✓     |
| `buildOracleSynthesisModelSpec`                                     | line 777                                                   | line 777            | ✓     |
| `inferOracleConfidence`                                             | lines 1220-1229                                            | lines 1220-1229     | ✓     |
| `schemaById` static record                                          | line 428                                                   | line 428            | ✓     |
| `validateStageOutputData`                                           | line 443                                                   | line 443            | ✓     |
| `pipeline-engine.ts` 9 `modelRouter.execute` sites                  | lines 1982, 2935, 4035, 4197, 4251, 4705, 5185, 5328, 5384 | all present         | ✓     |
| Constellation ctor `this.oracles = customOracles ?? defaultOracles` | line 66                                                    | line 66             | ✓     |

### Preflight discrepancy — 10th `modelRouter.execute` site

LLD Task 1.B.6 notes `special-stage-executor.ts` likely has "0-2" additional `modelRouter.execute` sites. Preflight grep found exactly **one** site at **line 646** of `special-stage-executor.ts`. This is within the LLD's anticipated range — Task 1.B.6 explicitly says "grep first, then insert". No LLD update required; the site will be covered by Task 1.B.6 during Commit 1.B.

### Working tree sanity

- `git status` — clean for `packages/helix/` (unrelated pre-existing `folder-reader.ts` uncommitted).
- `git log -3` — LLD commit `894a4b35f` landed at HEAD.
- `git log --since="1 week ago" -- packages/helix/src/` — 20+ refactor commits last week; all LLD line anchors re-verified above (no drift).

### Ready to begin Phase 1 Commit 1.A.

---

## Phase 1 — Executor + Oracle Swap + Cost Attribution

### Commit 1.A — Types, config, executor, router registration

**SHA:** `65776e961`
**Status:** DONE

### Commit 1.B — Cost accumulator + Architecture oracle swap + CLI + doctor

**SHA:** `83d561063`
**Status:** DONE

### Commit 1.C — Phase 1 unit/integration/E2E tests

**SHA:** `b4569cd26`
**Status:** DONE

---

## Phase 2 — Dueling-Planners Convergence

### Commit 2.A — plan-c-with-divergence schema + dueling synthesis prompt

**SHA:** `41a85b7dc`
**Status:** DONE

### Commit 2.B — Dueling-plan orchestrator + pipeline dispatch

**SHA:** `d6d7253fb`
**Status:** DONE

### Commit 2.C — Phase 2 tests

**SHA:** `f5ca6d2ed`
**Status:** DONE

---

## Phase 3 — Documentation & Feature Status

### Commit 3 — Doc sync + ALPHA promotion

**Status:** DONE

Tasks completed:

- Feature spec status promoted PLANNED -> ALPHA
- Feature spec §10 errata fixed: `executeDuelingPlanGeneration` signature corrected from fabricated `(workDir, session, stage, deps)` to canonical `(session, stage, startTime, stageDeadlineAt?)`
- Feature spec §13 task 2.6 updated: `planStageTimeoutMs(config)` reference replaced with dispatch-site-override description per LLD D-6
- Feature spec §17 coverage matrix: all 23 scenarios marked PASS
- Feature spec delivery status table added with all 6 commit SHAs
- Test spec status promoted PLANNED -> IMPLEMENTED, HLD/LLD links added
- Test spec coverage matrix: all 16 FRs marked PASS
- Test spec Current State section updated with actual test file references
- HLD §4 Concern #4 (line 360): "Zod-based `stage-output-parsers.ts`" corrected to "AJV 8 + JSON Schema draft 2020-12"
- HLD §7 Cross-Cutting (line 524): "Zod schemas in `stage-output-schema.ts`" corrected to "`JsonSchemaDocument` entries registered in `schemaById`, validated via AJV 8"
- HELIX.md §Future Work #1: updated to note `openai-api` executor implemented
- HELIX.md §Model Router: expanded from 2 to 3 registered executors
- HELIX.md §Oracle Constellation: documented Architecture oracle swap capability
- HELIX.md §Highlights: added "Cross-Provider Quorum & Dueling Planners" section
- CLAUDE.md Change Checklist: added OpenAI executor and dueling-plan test entries
- agents.md: appended Phase 2 implementation learnings + Phase 3 sync entry with all 6 commit SHAs

Test baseline: 741 passing / 1 pre-existing flake (concerns-audit.test.ts, unrelated).
No production code changes in this commit.

---

## Phase 4 — Audit & Residual Sync

### 5 pr-reviewer rounds (2026-04-19)

All 5 mandatory implementation-phase audit rounds executed:

| Round | Verdict  | New findings                                        | Resolution                                  |
| ----- | -------- | --------------------------------------------------- | ------------------------------------------- |
| 1     | APPROVED | 1 MEDIUM advisory (GAP-001/002) + 2 LOW             | Captured in feature spec §16                |
| 2     | APPROVED | 0 new                                               | —                                           |
| 3     | APPROVED | 0 findings                                          | Wiring + FR traceability verified           |
| 4     | APPROVED | 1 MEDIUM (codex binary missing from `helix doctor`) | Fixed in `8417ffe13` (+4 tests)             |
| 5     | APPROVED | 0 new                                               | 2 stale-text items routed to post-impl-sync |

### Commit 8417ffe13 — R4 audit follow-up

**Status:** DONE

Extended `helix doctor` to fail preflight when `enableDuelingPlanners` or `useOpenAiArchitectureOracle` is on but the `codex` binary is missing. Prevents wasted planner spend when Codex synthesis would fail at execution time.

- `src/readiness/doctor.ts`: added `environment.codex-binary` checklist item (severity `critical`) gated on `options.enableDuelingPlanners`
- `src/models/codex-cli-executor.ts`: extracted `resolveCodexBinaryPath` as a standalone exported function (replaces module-private `resolveCodexPath`); barrel re-export via `src/index.ts`
- `src/__tests__/doctor.test.ts`: +4 tests covering checklist emission, flag-gated omission, missing-binary detection, `HELIX_CODEX_PATH` env override

Tests: 745 passing + 1 pre-existing flake.

### Post-impl-sync (this commit)

Residual sync closing items R5 surfaced:

- `docs/testing/sub-features/cross-provider-quorum-convergence.md` §10 Status: `PLANNED` → `IMPLEMENTED`
- `docs/features/sub-features/cross-provider-quorum-convergence.md` §13 Delivery Status: added R4-fix row (`8417ffe13`)
- `packages/helix/CLAUDE.md` Change Checklist: added doctor/readiness preflight entry
- `docs/sdlc-logs/cross-provider-quorum-convergence/post-impl-sync.log.md`: new log documenting the full trail

Final test count: 746 passing / 61 files. Feature at `ALPHA` — ready for operator-driven BETA promotion per §14 success metrics.
