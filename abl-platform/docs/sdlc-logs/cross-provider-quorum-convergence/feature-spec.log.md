# Feature Spec Log — cross-provider-quorum-convergence

## Round 1 — Phase 1 Discovery + Clarifying Questions

**Date**: 2026-04-19
**Skill**: `/feature-spec`
**Oracle agent**: `product-oracle`

### Summary

Product-oracle classified all 14 clarifying questions. **Zero AMBIGUOUS items** — no user escalations required. 13 DECIDED / INFERRED / ANSWERED items.

### Sources consulted

- `docs/features/helix-autonomous-engineering-harness.md` (parent, ALPHA)
- `docs/plans/helix-autonomous-harness-roadmap.lld.md` (DRAFT)
- `packages/helix/HELIX.md` (vision + Future Work §507)
- `packages/helix/CLAUDE.md`, `packages/helix/agents.md`
- `packages/helix/src/types.ts`
- `packages/helix/src/models/model-router.ts`, `claude-sdk-executor.ts`
- `packages/helix/src/oracles/oracle-constellation.ts`
- `packages/helix/src/pipeline/templates/holistic-audit.ts`
- `packages/helix/package.json`

### Decisions log

| ID  | Question                       | Classification | Decision                                                                                                                                                                                   |
| --- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Doc type                       | DECIDED        | SUB-FEATURE under helix-autonomous-engineering-harness.md                                                                                                                                  |
| A2  | Out of scope                   | DECIDED        | 8 items: non-architecture oracles on OpenAI, implementation-stage openai, learned autonomy, cost optimization, UI for divergence, claude-api executor, parallel slices, other pipelines    |
| A3  | Relationship to Future Work #1 | ANSWERED       | Partially closes — `openai-api` yes, `claude-api` remains open                                                                                                                             |
| A4  | Prior attempts                 | ANSWERED       | None. `openai-api` type declared but no executor; no `openai` dep in package.json                                                                                                          |
| B1  | Primary persona                | INFERRED       | Helix CLI operator (`helix audit`/`helix fix`)                                                                                                                                             |
| B2  | Critical journeys              | INFERRED       | 5 journeys: standard dueling run, one-planner-fail solo-pass, both-fail abort, codex-fail abort, cross-provider arch oracle verdict                                                        |
| B3  | Must vs nice-to-have           | DECIDED        | MUST: cost attribution, solo-pass fallback, codex-fail abort, paper trail. NICE: MCP divergence tool, streaming                                                                            |
| B4  | Performance impact             | INFERRED       | ~1.5× wall-clock; 8min→~18-20min stage budget; must checkpoint Plan A+B outputs                                                                                                            |
| B5  | Regression-sensitive features  | ANSWERED       | Plan quality gate, checkpoint reuse, explain_blocker, list_gate_results, resume, plan-review carry-forward                                                                                 |
| C1  | Packages affected              | ANSWERED       | `packages/helix/` only                                                                                                                                                                     |
| C2  | Data model                     | DECIDED        | (a) `costByProvider` keyed by `engine:model`; (b) Plan artifacts in `.helix/sessions/<id>/`, NOT `docs/sdlc-logs/`                                                                         |
| C3  | Credentials                    | ANSWERED       | Process env (`OPENAI_API_KEY`), same as codex-cli today                                                                                                                                    |
| C4  | SDK choice                     | DECIDED        | Official `openai` npm SDK, dynamic import, matches claude-sdk-executor pattern                                                                                                             |
| C5  | Model ID                       | DECIDED        | `gpt-5` for both Architecture oracle and Planner B (reasoning parity, structured output, matches team's GPT-5.4 usage)                                                                     |
| C6  | Budget cap                     | INFERRED       | Keep $10 initially; existing tuneOracleModelSpec adjusts dynamically                                                                                                                       |
| C7  | Synthesis labeling             | DECIDED        | Unlabeled ("Candidate A"/"Candidate B"); disable codex tools during synthesis                                                                                                              |
| C8  | Dispatch insertion point       | ANSWERED       | Add `plan-generation` case to `executeStage` dispatch (pipeline-engine.ts ~line 1870). New `specialStageExecutor.executeDuelingPlanGeneration()` matching oracle-analysis pattern          |
| C9  | Failure = abort                | DECIDED        | Yes. Stage returns `status: 'failed'`, advisory surfaces, no silent Opus fallback                                                                                                          |
| C10 | Artifact location              | DECIDED        | `.helix/sessions/<id>/{plan-a,plan-b,plan-c,divergence-notes}.md` + summary entry in `docs/sdlc-logs/<feature>/helix/journal.md`                                                           |
| C11 | MCP tool                       | DECIDED        | Deferred to follow-up. Paper trail + existing MCP tools sufficient                                                                                                                         |
| C12 | Resume checkpointing           | INFERRED       | New `session.duelingPlanState` field captures planA/planB/planC/divergenceNotes intermediates; persists atomically                                                                         |
| C13 | Test matrix                    | ANSWERED       | New: `openai-api-executor.test.ts`. Update: `oracle-constellation`, `model-router`, `pipeline-engine`, `stage-runner` tests                                                                |
| C14 | Rollout                        | DECIDED        | Template-level opt-in + config gate (`HelixConfig.useOpenAiArchitectureOracle` / `enableDuelingPlanners`); openai-api executor always registered but only invoked when explicitly declared |

### Notable divergences from user brief

1. **Plan artifact location** — brief specified `docs/sdlc-logs/<feature>/plans/`. Oracle correctly pushed to `.helix/sessions/<id>/` per HELIX's session-scoped persistence convention. Repo-level `docs/sdlc-logs/` is SDLC-phase-scoped, not session-scoped. **Adopted oracle recommendation.**
2. **Dueling plans reuse via checkpoint** — brief did not specify; oracle added per the existing checkpoint-reuse pattern. **Adopted.**

### Escalations to user

None. All questions resolved.

### Files created by Phase 1

- `docs/sdlc-logs/cross-provider-quorum-convergence/feature-spec.log.md` (this file)

---

## Round 2 — Phase 4b Audit (Round 1 of 2)

**Date**: 2026-04-19
**Auditor**: `phase-auditor`
**Verdict**: NEEDS_REVISION

### Findings summary

| Severity | ID   | Area                                                                           | Fix applied                                                                                                                     |
| -------- | ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | FS-2 | Problem Statement line 18 — broken grammar + unfalsifiable bias claim          | Rephrased to design hypothesis: "any systematic blind spot in that provider's model would not be caught by a dissenting voice…" |
| HIGH     | FS-3 | User Story 5 compounded two capabilities (solo-pass + hard-abort)              | Split into US-5 (solo-pass continuation) and US-6 (hard-abort discipline); renumbered subsequent stories to US-7/US-8           |
| MEDIUM   | FS-2 | FR-4 line reference `~1870` may drift during helix extractions                 | Added stable anchor: "the `// Main stage execution loop` block, currently ~line 1870"                                           |
| MEDIUM   | FS-9 | Feature-spec matrix shows 23 rows; testing guide documents 13 formal scenarios | Added Testing Notes paragraph mapping feature-spec rows to testing-guide E2E/INT numbering                                      |
| LOW      | —    | Grammar fix in line 18                                                         | Absorbed into FS-2 fix                                                                                                          |

### Cross-phase checks

All PASS: template completeness (FS-1), code grounding (FS-2), requirement quality (FS-3), user stories (FS-4), integration matrix (FS-5), non-functional concerns (FS-6), data model (FS-7), delivery plan (FS-8), testing section (FS-9), scope clarity (FS-10), sub-features/features/testing README indexes, parent feature linkage, HELIX Change Checklist alignment, agents.md learnings reflected, no platform-component mocking in test spec.

Code grounding spot-checks confirmed accurate: `types.ts:269-273`, `model-router.ts:48-67`, `oracle-constellation.ts:370-383`, `model-router.ts:214-223`, `pipeline-engine.ts:508-511`, `pipeline-engine.ts:~1870`, `holistic-audit.ts:291-313`, `HELIX.md:507`, `model-router.ts:245` (registerExecutor), `claude-sdk-executor.ts:124` (dynamic import).

### Files changed during round 1 fix

- `docs/features/sub-features/cross-provider-quorum-convergence.md` — §1 Problem Statement, §3 User Stories, §4 FR-4, §17 Testing Notes
- `docs/testing/sub-features/cross-provider-quorum-convergence.md` — unchanged

---

## Round 3 — Phase 4b Audit (Round 2 of 2, fresh-eyes)

**Date**: 2026-04-19
**Auditor**: `phase-auditor`
**Verdict**: APPROVED (pending 3 HIGH fixes, all applied)

### Findings summary

| Severity | ID    | Area                                                                                                                                                               | Fix applied                                                                                                                      |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| HIGH     | FS-2  | `DEFAULT_HELIX_CONFIG` does not exist — config assembled inline by `buildHelixConfig()` in `cli.ts` (~1268-1321)                                                   | Updated §10 table entry to reference `buildHelixConfig()` with CLI flag construction path                                        |
| HIGH     | FS-2  | `SessionManager.persistSession()` does not exist — actual method is `persist()` at `session/session-manager.ts:96`                                                 | FR-11 corrected to cite `SessionManager.persist()` with file path                                                                |
| HIGH     | TS-10 | Test spec parent-feature link broken (`../helix-autonomous-engineering-harness.md` resolves to nonexistent `docs/testing/helix-autonomous-engineering-harness.md`) | Rewired to `../../features/helix-autonomous-engineering-harness.md`; also fixed feature-spec back-link to use `../../features/…` |
| MEDIUM   | FS-7  | `PlanArtifact` shape in FR-11 had 5 fields; §9 Data Model had 8 fields (durationMs, turnsUsed, soloPass added)                                                     | FR-11 updated to defer to §9 as authoritative; §9 remains 8-field definition                                                     |
| MEDIUM   | FS-2  | Parent feature doc does not reference this sub-feature                                                                                                             | Deferred — update deferred to post-commit; will be handled by `/post-impl-sync` on parent feature                                |
| MEDIUM   | FS-2  | Reader could assume all Claude oracles use same model (codebase=sonnet, testing+domain=opus)                                                                       | Accepted as-is; specificity not required for feature-spec level                                                                  |
| LOW      | FS-3  | FR-6 mixes `efficiencyBudget` implementation detail into functional requirement                                                                                    | Accepted as-is; FR remains testable                                                                                              |

### Cross-phase checks

All PASS (XP-1 through XP-5). Code-grounding spot-checks across 11 paths were accurate except the 2 noted above, which are now fixed.

### Files changed during round 2 fix

- `docs/features/sub-features/cross-provider-quorum-convergence.md` — §4 FR-11 and §10 Key Implementation Files table
- `docs/testing/sub-features/cross-provider-quorum-convergence.md` — §Feature Metadata (parent link), §7 References (feature-spec link)

### Outcome

Both documents pass all 18 TEMPLATE.md sections, all 16 FRs are testable, all cross-phase checks PASS, code grounding is accurate, and the testing placeholder's test-double strategy correctly applies platform rules (no internal module mocking). Feature spec transitions from Phase 1 (discovery) → Phase 5 (commit).
