# HLD Log — cross-provider-quorum-convergence

## Round 1 — Phase 1 Discovery + Clarifying Questions

**Date**: 2026-04-19
**Skill**: `/hld`
**Oracle agent**: `product-oracle`

### Summary

Product-oracle classified all 15 clarifying questions. **Zero AMBIGUOUS items** — no user escalation required. 12 ANSWERED / 3 DECIDED / 2 INFERRED.

### Sources consulted by oracle

- Feature spec `docs/features/sub-features/cross-provider-quorum-convergence.md`
- Test spec `docs/testing/sub-features/cross-provider-quorum-convergence.md`
- Feature-spec + test-spec logs
- `packages/helix/HELIX.md`, `CLAUDE.md`, `agents.md`
- `packages/helix/src/types.ts` (Session, StageResult, ExecutorResult, ModelEngine, HelixConfig, ExecutorEfficiencyBudget)
- `packages/helix/src/models/model-router.ts` (execute path, abortActiveExecutions, cost accumulation)
- `packages/helix/src/models/{claude-sdk-executor,codex-cli-executor}.ts` (dynamic import, efficiency controller)
- `packages/helix/src/pipeline/pipeline-engine.ts` (executeStage dispatch lines 1790-1870, handleBlockingStageResult 1045, run loop 494-620, deterministic-replay bypass 1855, plan-generation post-processing 521, 613, 2265)
- `packages/helix/src/pipeline/special-stage-executor.ts` (7 public methods → StageResult)
- `packages/helix/src/pipeline/stage-output-{schema,parsers}.ts`
- `packages/helix/src/session/session-manager.ts` (persist:96, appendToJournalFile:233)
- `packages/helix/src/oracles/oracle-constellation.ts`
- Workspace-wide `openai` dep scan (3 consumers on v4.x)

### Decisions log

| ID  | Topic                                                             | Class    | Decision                                                                                                                                                                         |
| --- | ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Dispatch insertion point / bypass paths                           | ANSWERED | `executeStage` has 4 call-sites (main loop 508, parallel substages 2527, sequential substages 2550, replay regression bypass 1855). Dueling guard must be compatible with all.   |
| Q2  | SpecialStageExecutor public surface                               | ANSWERED | 7 public methods, all return `Promise<StageResult>` via shared `makeResult()` helper. `executeDuelingPlanGeneration` must match signature + return type.                         |
| Q3  | StageResult shape + handleBlockingStageResult                     | ANSWERED | `status: 'passed' \| 'failed' \| 'skipped' \| 'looped'`. `isBlockingStageResult` treats `failed \| looped` as blocking. Dueling hard-abort returns `status: 'failed'`.           |
| Q4  | Checkpoint persistence granularity                                | ANSWERED | Per-stage via `SessionManager.persist()`. Mid-stage precedent exists (oracle checkpoints line 360, slice diff-hash 2026-04-05). Persist after each planner completes.            |
| Q5  | Stage type key                                                    | ANSWERED | `'plan-generation'` (lowercase-hyphen). Output schema ID is `'slice-plan'`. Confirmed at lines 521, 613, 2265.                                                                   |
| Q6  | `openai` SDK version                                              | DECIDED  | Pin `^4.77.0` (matches 3 existing workspace consumers: `search-ai-internal`, `mcp-openai-reviewer`, `codetool-sandbox/runtime_js`). v5 not yet released.                         |
| Q7  | Codex `disableToolUse` wiring                                     | ANSWERED | Already exists on `ExecutorEfficiencyBudget` (types.ts:290). Zero surface change. Use `{ disableToolUse: true, explorationTurns: 0, targetTurns: 8, hardTurnCap: 12 }`.          |
| Q8  | `ModelRouter.execute` + costUsd                                   | ANSWERED | `ExecutorResult.costUsd?: number` already exists. Add pure `accumulateProviderCost()` helper + post-execute hook in pipeline-engine after every `modelRouter.execute()`.         |
| Q9  | Stage-output parser extension                                     | ANSWERED | Parsers are call-site-selected (not registry lookup). Extend via composition: wrap `parseSlicePlanOutput` + extract `divergenceNotes`. Add `plan-c-with-divergence` schema ID.   |
| Q10 | Journal write path                                                | ANSWERED | `SessionManager.appendToJournalFile()` exists (line 233). Use `deps.journal()` callback from `executeDuelingPlanGeneration`. OS-atomic appends for single-line writes.           |
| Q11 | Backward compatibility (missing new fields in old sessions)       | ANSWERED | Optional fields absent is safe. JSON round-trip via `persist()`/`load()` preserves absent fields. No migration. Initialize from `?? {}` in every read site.                      |
| Q12 | Byte-for-byte equivalence evidence for flag-off path              | DECIDED  | No existing evidence. HLD mandates explicit regression tests: UT-9 (config defaults) + INT-8 (dispatch wiring) + feature-spec row 23 (flag-off behavior unchanged).              |
| Q13 | Hard-abort vs resume-retry — does abort clean `duelingPlanState`? | INFERRED | Abort does NOT clean mid-stage state (matches oracle-checkpoint precedent at line 85-98). Stale-partial risk is managed by the checkpoint-reuse principle. Document in §12.      |
| Q14 | Rollback strategy                                                 | DECIDED  | Primary: unset `--enable-dueling-planners` / `--use-openai-architecture-oracle` → instant revert. Fallback: delete `.helix/sessions/<id>/`. Git-revert only as nuclear option.   |
| Q15 | Parallel timeout / abort artifact preservation                    | INFERRED | Use `.then()`-eager persist per planner (not post-allSettled sequential) so Ctrl+C between Plan A fulfillment and allSettled return still preserves Plan A. Document in §4 D-15. |

### HLD section mapping

- **§3 Architecture Diagram**: Q1 (dispatch flow), Q2 (executor surface), Q5 (stage type), Q8 (costUsd pathway), Q10 (journal write)
- **§4 12-Concerns Table**: Q6 (SDK dep), Q11 (backward compat), Q12 (flag-off regression), Q13 (abort state), Q14 (rollback)
- **§5 Data Model**: Q3 (StageResult), Q4 (checkpoint granularity), Q9 (parser extension), Q11 (optional fields)
- **§4 Failure Modes row + §9 Open Questions**: Q13, Q15 (abort cleanup / eager persist)

### Escalations to user

None. All 15 questions resolved.

### Files created by Phase 1

- `docs/sdlc-logs/cross-provider-quorum-convergence/hld.log.md` (this file)

---

## Round 2 — Phase 3 Generation + design-lint

**Date**: 2026-04-19
**Skill**: `/hld`

### Artifact

- `docs/specs/cross-provider-quorum-convergence.hld.md` (CREATED, ≈585 lines)

### Sections

1. Problem Statement
2. Alternatives Considered (3 options: ambient, planners-only, chosen bundle) + Recommendation
3. Architecture — system context diagram, component diagram, data flow, 2 sequence diagrams (partial-failure, double-failure)
4. 12 Architectural Concerns table (Tenant/Project/User isolation N/A with CLI-tool justification)
5. Data Model — `Session` + `PlanArtifact` + `HelixConfig` extensions, backward compat, relationships
6. API Design — N/A (HELIX is CLI-only), internal surfaces documented
7. Cross-Cutting Concerns — audit, rate, cache, encryption, secret handling, structured output, progress
8. Dependencies — upstream (openai@^4.77.0 + internals) / downstream (gates, consumers)
9. Open Questions — 7 items (GPT-5 availability, prompt labeling, partial-fail persistence, timeout tuning, cost cap, journal format, synthesis quality)
10. References — feature/test specs + 13 code references

### design-lint

- `tools/design-lint.sh` executed — **19 PASS / 1 WARN / 0 MISSING**, completeness 95%, passes quality gate.
- Warning: "2 open questions/TODOs remaining" (these are the §9 genuine open questions — expected).

---

## Round 3 — Audit Round 1 (NEEDS_REVISION lite → APPROVED)

**Date**: 2026-04-19
**Skill**: `/hld`
**Auditor**: `phase-auditor`

### Verdict: **APPROVED** with 2 HIGH + 1 MEDIUM (precision fixes)

### Findings

| ID   | Severity | Topic                                                                                                                | Status |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| HD-8 | HIGH     | `appendToJournalFile` is `private`; diagram must reference public `addJournalEntry` (line 206)                       | FIXED  |
| HD-2 | HIGH     | `handleBlockingStageResult` line reference drifted from 508-511 to 511-515                                           | FIXED  |
| HD-3 | MEDIUM   | "thin delegator" annotation misleading — should be "delegates to extracted module" (class is substantial, 7 methods) | FIXED  |

### Verified in Round 1

- All 12 concerns addressed genuinely (no hand-waving); isolation N/A with CLI-tool justification
- Three alternatives with genuine pros/cons/effort (not strawmen)
- Architecture diagrams: system-context + component + 3 sequence/data-flow diagrams
- Data model: additive optional fields, JSON round-trip safe, `?? {}` initialization
- All 16 FRs traceable to HLD sections (XP-1 verified systematically)
- 35 test-spec scenarios align with HLD test strategy (§4 row #12)
- `agents.md` 2026-04-19 learnings reflected (ModelEngine union, plan-generation dispatch, persist behavior)
- Code grounding: 11 code references spot-checked (model-router, special-stage-executor, session-manager, oracle-constellation, pipeline-engine, holistic-audit)

---

## Round 4 — Audit Round 2 (NEEDS_REVISION → fixes → APPROVED in Round 3)

**Date**: 2026-04-19
**Skill**: `/hld`
**Auditor**: `phase-auditor`

### Verdict: **NEEDS_REVISION** with 1 CRITICAL + 1 HIGH

### Findings

| ID        | Severity | Topic                                                                                                                                                                                                                                                                                            | Status |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| HD-4/FS-2 | CRITICAL | `executeDuelingPlanGeneration(workDir, session, stage, deps)` signature was fabricated. Real pattern: `(session, stage, startTime, stageDeadlineAt?)` matching the 7 existing `SpecialStageExecutor` methods. All dependencies resolved via constructor-injected `this.deps`, not parameter bag. | FIXED  |
| HD-4      | HIGH     | `holistic-audit.ts` is a static `const` PipelineTemplate (line 123); has no access to runtime config. Proposed `planStageTimeoutMs(config)` helper won't work. Resolved by runtime override at `PipelineEngine.executeStage()` dispatch time.                                                    | FIXED  |

### Fixes applied

1. **Signature** — corrected in 4 locations (SS3.2 component diagram, SS3.3 data flow steps 4-14 with numbering re-sequenced, SS4 row #3 API Contract, SS6 API Design bullets). All `deps.X` references updated to `this.deps.X`.
2. **Timeout strategy** — runtime override at dispatch site in `PipelineEngine.executeStage()` (stage.timeoutMs = 18 \* MINUTE_MS when `config.enableDuelingPlanners` is true). Template remains unchanged. Alternative (builder-function refactor) explicitly rejected as out-of-scope. Documented in SS4 concern #9 and SS3.2 component diagram.

### Verified in Round 2

- Data-model deep dive: Session, PlanArtifact, HelixConfig extensions complete; optional-field safety (`?? {}` pattern) consistent
- Secret handling: triple-cited (SS4 row #4, SS7, SS12 row 1) — consistent
- Failure-mode matrix: 8 degradation paths enumerated (a-h), no missing path
- Checkpoint-reuse semantics: abort does NOT clean mid-stage state (oracle-constellation.ts:85-98 precedent)
- MCP forward-compat: older clients ignore unknown fields — verified pattern
- Feature spec non-goals preserved; no scope creep

---

## Round 5 — Audit Round 3 (FINAL APPROVAL)

**Date**: 2026-04-19
**Skill**: `/hld`
**Auditor**: `phase-auditor`

### Verdict: **APPROVED** — no findings

### Round 3 focus (per HLD skill workflow): cross-phase consistency

- All 16 FRs (FR-1 through FR-16) traceable to HLD sections — XP-1 verified
- HLD enables LLD: data model, dispatch points, file layout, failure matrix all precise — XP-2 verified
- No scope creep beyond feature spec — XP-3 verified
- Terminology uniform across feature spec, test spec, HLD — XP-4 verified
- `packages/helix/agents.md` patterns reflected (checkpoint reuse, `makeResult()` helper, constructor-injection) — XP-5 verified
- Signature fix from Round 2 applied consistently — zero residual `(workDir, session, stage, deps)` or bare `deps.X` references
- Timeout strategy consistent across SS3.2, SS3.3, SS4 — no leftover `planStageTimeoutMs` references
- 12 code references spot-checked: all line numbers within current code

### Informational items for `/post-impl-sync`

The feature spec has two references that the HLD now supersedes (non-blocking for HLD approval):

1. Feature spec line 278: `executeDuelingPlanGeneration(workDir, session, stage, deps)` — stale signature.
2. Feature spec line 282: `planStageTimeoutMs(config)` compile-time helper — stale (replaced by runtime override).

Both are tracked for the post-implementation sync phase.

---

## Phase 5 — Commit Log

- HLD committed alongside log updates and `packages/helix/agents.md` entry.
- Commit hash: _(pending)_
- Next phase: `/lld cross-provider-quorum-convergence` (5 audit rounds mandated by pipeline).
