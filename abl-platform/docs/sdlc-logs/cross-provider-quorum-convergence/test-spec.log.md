# Test Spec Log — cross-provider-quorum-convergence

## Round 1 — Phase 1 Discovery + Clarifying Questions

**Date**: 2026-04-19
**Skill**: `/test-spec`
**Oracle agent**: `product-oracle`

### Summary

Product-oracle classified all 24 clarifying questions. **Zero AMBIGUOUS items** — no user escalation required. All ANSWERED / INFERRED / DECIDED from codebase evidence.

### Sources consulted by oracle

- `docs/features/sub-features/cross-provider-quorum-convergence.md` (full feature spec)
- `docs/testing/sub-features/cross-provider-quorum-convergence.md` (existing placeholder)
- `packages/helix/CLAUDE.md`, `packages/helix/agents.md`
- `packages/helix/vitest.config.ts`, `packages/helix/package.json`
- 58 existing test files under `packages/helix/src/__tests__/`
- `.claude/hooks/platform-mock-lint.sh`, `.claude/hooks/e2e-test-quality-lint.sh`
- `pnpm-workspace.yaml` (helix is excluded — `!packages/helix`)

### Decisions log

| ID  | Question                         | Classification | Decision                                                                                                                                                                                                                         |
| --- | -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Highest-risk FRs                 | INFERRED       | FR-5 (parallel fan-out), FR-7/8/9 (failure trio), FR-12 (resume checkpoint), FR-6 (synthesis with tool-use disabled). Historic checkpoint bugs in agents.md drive resume emphasis.                                               |
| A2  | Known failure modes              | ANSWERED       | No production runs yet. 4 regression patterns from adjacent work (plan retry carry-forward, checkpoint advancement race, stale index on resume, missing heartbeats) inform scenarios.                                            |
| A3  | Coverage baseline                | ANSWERED       | model-router 325 LOC, oracle-constellation 961 LOC, pipeline-engine 11,735 LOC, claude-sdk 590 LOC, codex-cli 870 LOC, doctor 280 LOC. No coverage threshold configured.                                                         |
| A4  | Real-network vs injected fakes   | ANSWERED       | All injected. openai SDK via `OpenAiClientFactory`; Claude SDK via `vi.mock('@anthropic-ai/...')` (external, allowed); Codex CLI via fake subprocess (existing pattern).                                                         |
| A5  | Test environment                 | ANSWERED       | In-process only. No Docker, no DB. Vitest: pool:forks, maxWorkers:1, testTimeout:20s. Temp dirs via `mkdtemp`; git-initialized workspaces per test.                                                                              |
| B1  | Missing E2E journeys             | INFERRED       | Add E2E-7 (both flags on simultaneously) and E2E-8 (abort mid-planner). Budget-cap-mid-synthesis → INT scenario.                                                                                                                 |
| B2  | Auth context                     | ANSWERED       | N/A — HELIX is a local CLI. Document as N/A with OS filesystem permissions justification (per feature spec §12).                                                                                                                 |
| B3  | Cross-feature regressions        | INFERRED       | Existing row 23 regression (defaults leave behavior unchanged) sufficient. No per-template scenarios needed — `bug-fix`/`drift-audit`/`canary` never set dueling flag.                                                           |
| B4  | Data seeding                     | ANSWERED       | Follow `pipeline-engine.test.ts` L10957+ patterns: temp dir + git init + `createConfig` helper + fake executors + sessionManager + real filesystem assertions.                                                                   |
| B5  | Performance scenarios            | DECIDED        | (a) concurrent sessions N/A (single-session tool). (b) streaming backpressure → unit test. (c) 50+ oracle rounds N/A for this sub-feature.                                                                                       |
| C1  | Missing integration boundaries   | INFERRED       | Add INT-8 (SpecialStageExecutor dispatch wiring) and INT-9 (Plan Quality gate flow-through with Plan C).                                                                                                                         |
| C2  | Session event integration        | ANSWERED       | No new event emitter surface. Progress events emitted via `emitProgress()` — E2E-1 verifies ordering.                                                                                                                            |
| C3  | Tenant/project isolation         | ANSWERED       | Confirmed N/A. Document in §5 with verbatim feature-spec §12 justification.                                                                                                                                                      |
| C4  | Race conditions                  | INFERRED       | 3 scenarios: interrupt during persist (must-cover, E2E-5 + INT-4), concurrent A+B persist serialization (INT-10, new), read-during-write (nice-to-have).                                                                         |
| C5  | Error/failure path priority      | DECIDED        | Must-cover: budget-mid-synthesis, 429 rate limit, timeout/stall. Should-cover: 500 server error, malformed SSE. Nice-to-have: partial JSON in structured output.                                                                 |
| D1  | Vitest timeouts                  | ANSWERED       | 20s global is sufficient; per-test override via `{ timeout: N }` available but unused in existing suite.                                                                                                                         |
| D2  | Fixture directory                | DECIDED        | Create `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts` — new convention, justified by 3-file shared usage. Inline helpers remain default for single-file fixtures.                                                  |
| D3  | CI job                           | ANSWERED       | None. HELIX excluded from workspace (`!packages/helix`). No GitHub Actions workflow. Local-only test execution via `pnpm exec vitest run`.                                                                                       |
| D4  | Coverage thresholds              | ANSWERED       | None configured. `vitest.config.ts` has v8 provider + reporters but no enforced minimums.                                                                                                                                        |
| D5  | Snapshot vs substring assertions | DECIDED        | Substring/regex. Free-form prose + model-dependent output → snapshots brittle. Matches existing helix test convention (zero snapshot tests in 58 test files).                                                                    |
| E1  | Unit test scenarios list         | INFERRED       | 10 scenarios: pricing lookup, stream mapper, cost calc, synthesis-prompt builder, `resolveArchitectureOracle`, `planStageTimeoutMs`, PlanArtifact JSON round-trip, costByProvider accumulator, config defaults, `isAvailable()`. |
| E2  | Helpers as pure unit tests       | ANSWERED       | Yes — `planStageTimeoutMs` and `resolveArchitectureOracle` get both unit-level (pure function) and integration-level coverage.                                                                                                   |
| E3  | Property-based tests             | DECIDED        | No fast-check. Example-based suffices (3-4 scenarios cover all edges). fast-check not a helix dep; overkill for accumulator shape.                                                                                               |
| F1  | Test file list completeness      | ANSWERED       | `doctor.test.ts` exists (280 LOC), needs `OPENAI_API_KEY` validation test. Add `special-stage-executor.test.ts` (existing 82 LOC) and `stage-output-schema.test.ts` to the update list.                                          |
| F2  | Fixture path                     | DECIDED        | `packages/helix/src/__tests__/test-helpers/plan-fixtures.ts`. Shared module justified; follows openAiClient factory DI pattern over vi.mock external.                                                                            |

### Notable divergences from placeholder

1. **New E2E scenarios** — Oracle recommended 2 additions (dual-flag simultaneous run + abort-mid-planner). Adopted.
2. **New INT scenarios** — Oracle recommended INT-8 (dispatch wiring), INT-9 (gate flow-through), INT-10 (concurrent persist serialization), INT-11 (error-path matrix: 429 / timeout / 500 / malformed SSE / budget-mid-synthesis). Adopted.
3. **Unit Test Scenarios section** — Placeholder consolidated units into INT-1. Per skill template, pulled out a separate §4 Unit Test Scenarios section with 10 scenarios.
4. **Test fixture module** — Placeholder proposed `test-helpers/plan-fixtures.ts`. Oracle confirmed path and DI approach. Adopted.

### Escalations to user

None. All questions resolved.

### Files created by Phase 1

- `docs/sdlc-logs/cross-provider-quorum-convergence/test-spec.log.md` (this file)

---

## Round 2 — Phase 4b Audit (Round 1 of 2)

**Date**: 2026-04-19
**Auditor**: `phase-auditor`
**Verdict**: NEEDS_REVISION (1 CRITICAL + 3 HIGH + 2 MEDIUM)

### Findings summary

| Severity | ID    | Area                                                                                                                                      | Fix applied                                                                                                                                                  |
| -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | TS-2  | `EngineUnavailableError` class cited in INT-2 + SEC-3 — does not exist; ModelRouter returns `ExecutorResult.error` string, does not throw | INT-2 + SEC-3 rewritten to assert on `ExecutorResult` shape (non-empty `error`, no stack/env leak). No fabricated error class referenced.                    |
| HIGH     | TS-2  | `claude-sdk-executor.test.ts` LOC reference (~590) stale (actual 728)                                                                     | All LOC annotations stripped from §11 References (single source of truth is file contents, not inline counts).                                               |
| HIGH     | TS-9  | `stage-runner.test.ts` absent from test-file mapping despite HELIX Change Checklist coverage                                              | Added "HELIX Change Checklist coverage" footer in §8 with explicit justification for each Change Checklist item NOT updated.                                 |
| HIGH     | TS-10 | E2E-2 `soloPass` assertion contradictory (checked `planB.soloPass` when planB should be `undefined`)                                      | Rewrote to `session.duelingPlanState.planB === undefined` + `planA.soloPass === true` per §9 Data Model.                                                     |
| MEDIUM   | TS-9  | INT-6 dual-classification as unit+integration overlaps with UT-6                                                                          | INT-6 reshaped to pure integration-level: pipeline dispatch / timeout firing. Pure-function cases deferred to UT-6 with explicit cross-reference.            |
| MEDIUM   | TS-2  | New error classes (`OpenAiApiError`, `StallDetectedError`, `BudgetExceededError`, etc.) not flagged as new-to-implement                   | Added explicit "New error classes" note at top of INT-11 naming all 4 new classes plus existing executor-error context for `CodexCliError`/`ClaudeSdkError`. |

### Cross-phase checks

All PASS (XP-1 through XP-5 + XP-cross-phase-counts): FR coverage complete, forward compatibility intact, scope-locked, terminology consistent, `packages/helix/agents.md` aligned, feature-spec §17 scenario counts match test-spec totals (8 E2E / 11 INT / 10 UT).

### Files changed during round 1 fix

- `docs/testing/sub-features/cross-provider-quorum-convergence.md` — E2E-2 assertions, INT-2 + SEC-3 engine-unavailable assertions, INT-6 classification, INT-11 error-class preamble, §8 Change Checklist footer, §11 LOC annotations removed

---

## Round 3 — Phase 4b Audit (Round 2 of 2, fresh-eyes)

**Date**: 2026-04-19
**Auditor**: `phase-auditor`
**Verdict**: APPROVED (2 non-blocking MEDIUM findings applied as bonus hygiene)

### Round-1 fix verification

All 6 findings from round 1 verified fixed. No new issues introduced.

### Findings summary

| Severity | ID   | Area                                                                                                            | Fix applied                                                                                                                   |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM   | TS-9 | `stage-output-schema.test.ts` missing from §8 mapping despite new `plan-c-with-divergence` schema variant       | Added row to §8 table; updated totals to "9 existing files updated".                                                          |
| MEDIUM   | TS-2 | E2E-5 cites `pipeline-engine.test.ts:10957+` for abort pattern; line actually points at `createConfig()` helper | Replaced with line-number-free "existing `engine.abort()` abort-controller pattern" (matches round-1 LOC-stripping approach). |
| LOW      | TS-2 | INT-2 wording conflates constructor initialization with `registerExecutor()` post-construction for `openai-api` | Accepted as-is — no functional impact, phrasing clarified naturally by §10 feature-spec key implementation files.             |

### Cross-phase checks

All PASS (XP-1 through XP-5). FR coverage complete, forward compatibility intact, scope-locked, terminology consistent, `packages/helix/agents.md` checkpoint learnings reflected in E2E-5 / INT-4 / INT-10.

### Files changed during round 2 fix

- `docs/testing/sub-features/cross-provider-quorum-convergence.md` — E2E-5 preconditions, §8 `stage-output-schema.test.ts` row + totals

### Outcome

Test spec approved for `/hld` phase. 16 FRs mapped across 8 E2E + 11 INT + 10 UT + 3 SEC + 3 PERF scenarios with concrete assertions, file paths, and architectural grounding. Six open testing questions deferred to `/lld` (partial-failure artifact policy, mid-stream Codex persistence, journal format stability, dueling-specific budget cap, OpenAI SDK version fidelity, reasoning-model cost rollup).

---
