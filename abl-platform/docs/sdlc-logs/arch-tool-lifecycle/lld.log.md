# LLD Log: Arch Tool Lifecycle

## Oracle Phase (Round 0)

**Date:** 2026-04-13
**Agent:** product-oracle

### Questions & Decisions

| #   | Question Summary                                  | Classification | Key Decision                                                                 |
| --- | ------------------------------------------------- | -------------- | ---------------------------------------------------------------------------- |
| Q1  | handleBuildAction return type migration           | DECIDED        | All cases in one commit — mechanical change, single call site                |
| Q2  | save_tool_dsl gating                              | ANSWERED       | Conditional tool set in buildBuildTools (not execute guard)                  |
| Q3  | Shared service: refactor routes or parallel path? | DECIDED        | Parallel path — route handler has HTTP-specific concerns                     |
| Q4  | Does ctx carry permissions?                       | ANSWERED       | Yes — `ctx.permissions?: string[]` at route.ts:2128                          |
| Q5  | Prompt sections for BUILD vs IN_PROJECT           | DECIDED        | Separate sections — different contexts                                       |
| Q6  | Who emits 'done' after continueToLLM?             | ANSWERED       | Existing LLM flow at route.ts:5948                                           |
| Q7  | Validate DSL in save_tool_dsl?                    | DECIDED        | No — accept raw string, validate at CREATE time                              |
| Q8  | toolDsls consumption location                     | ANSWERED       | After collectInlineSeedTools loop at route.ts:4207-4215                      |
| Q9  | ToolName exhaustive switch updates                | ANSWERED       | IN_PROJECT_TOOLS, specialist maps, tests — no breaking switches              |
| Q10 | buildFormDataFromConfig location                  | DECIDED        | tools-ops.ts — LLM-specific transformation                                   |
| Q11 | Regression risk                                   | INFERRED       | LOW — mechanical change, tests exist, verify review/modify cases             |
| Q12 | Other callers for shared service                  | INFERRED       | None currently — API route convergence is future refactor                    |
| Q13 | Hallucinated tool names in completion check       | ANSWERED       | Extra keys ignored, real names still required. Add turn-limit safety valve.  |
| Q14 | Existing tests to update                          | ANSWERED       | build-completion.test.ts:282-453 (3 tests), tools.test.ts (array assertions) |
| Q15 | map_tool_to_agent (FR-8)                          | DECIDED        | Deferred — not in design spec, open question unresolved                      |

### Escalations

None — all questions answerable from codebase and docs.

---

## Audit Rounds

### Round 1: Architecture Compliance (lld-reviewer)

**Verdict:** NEEDS_CHANGES

| Finding                                                  | Severity | Resolution                                                                                               |
| -------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| C-1: `getOrCreateDefaultNamespace` unavailable in studio | CRITICAL | D-11: Inline `VariableNamespace` import matching route.ts:118-150                                        |
| C-2: save_tool_dsl regex rejects extracted names         | CRITICAL | D-9: Use `AGENT_NAME_PATTERN` from route.ts                                                              |
| H-1: SSE stream lifecycle ambiguous for continueToLLM    | HIGH     | D-10: No close/done, same stream reused                                                                  |
| H-2: FR-3 through FR-7 coverage gap                      | HIGH     | Added FR Coverage Map table                                                                              |
| H-3: SSRF templateUrlsAllowed too permissive             | HIGH     | D-12: Check `ssrf.reason` not regex                                                                      |
| M-1 through M-5                                          | MEDIUM   | All fixed (fallback invariants, updateToolViaService, turn counter, inferToolTypeFromDsl, phase overlap) |

### Round 2: Pattern Consistency (lld-reviewer)

**Verdict:** NEEDS_CHANGES

| Finding                                         | Severity | Resolution                                                                                                       |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| H-1: Call site missing local variable mutations | HIGH     | Added buildSubPhase/specialist/display mutations matching route.ts:4860-4864                                     |
| H-2: parseDslToToolForm wrong import path       | HIGH     | Specified `@agent-platform/shared/tools` subpath                                                                 |
| M-1 through M-4                                 | MEDIUM   | All fixed (turn counter line ref, pre-existing close() bug, authToken in context, Phase 6 architecture boundary) |

### Round 3: Completeness (lld-reviewer)

**Verdict:** NEEDS_CHANGES

| Finding                                | Severity | Resolution                                                                                               |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| H-1: default case missing return value | HIGH     | Added: default returns `{ continueToLLM: true }`                                                         |
| H-2: AGENT_NAME_PATTERN divergence     | HIGH     | D-9 updated: use route.ts local, documented divergence                                                   |
| M-1 through M-4                        | MEDIUM   | All fixed (dependency graph, design spec stale code, SSRF exact implementation, design spec import path) |

### Round 4: Cross-Phase Consistency (phase-auditor)

**Verdict:** NEEDS_REVISION

| Finding                                                 | Severity | Resolution                                                                  |
| ------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| XP-1: Test spec FR numbering divorced from feature spec | CRITICAL | Added Section 8: Test Spec Reconciliation with scenario-by-scenario mapping |
| XP-4: Test spec uses different tool names               | CRITICAL | Documented in Section 8, action item for post-impl-sync                     |
| XP-3: Delivery plan tasks 2,4,5 not covered             | HIGH     | Added Section 7: Delivery Plan Alignment                                    |
| XP-2: Design spec SSRF code stale                       | HIGH     | Added Design Spec Override Notes table                                      |
| XP-3: FR-10 journal gap                                 | HIGH     | Added to Section 9 deferred work item 3                                     |
| XP-2: Feature spec file path divergence                 | HIGH     | Added to Section 7 file path table                                          |

### Round 5: Final Sweep (lld-reviewer)

**Verdict:** APPROVED

| Finding                                                | Severity | Resolution                     |
| ------------------------------------------------------ | -------- | ------------------------------ |
| M-1: Phase 5 also modifies route.ts                    | MEDIUM   | Added note in dependency graph |
| M-2: Wiring checklist missing context injection compat | MEDIUM   | Added item 20 to checklist     |

All CRITICAL and HIGH findings resolved. 2 MEDIUM remain (addressed). No remaining CRITICALs after 5 rounds.
