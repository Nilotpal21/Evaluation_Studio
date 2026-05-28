# SDLC Log: ABL Language -- Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec Generation
**Feature**: ABL Language
**Slug**: abl-language

---

## Decision Log

| #   | Question                                           | Classification | Answer                                                                                                                                                                                 |
| --- | -------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is the uppercase DSL format legacy?                | ANSWERED       | No. Both uppercase and YAML are production domain conventions per `CLAUDE.md` and codebase evidence. The uppercase parser (`agent-based-parser.ts`, 6,701 LOC) is actively maintained. |
| 2   | What parser technology does the uppercase DSL use? | ANSWERED       | Regex-based line scanner in `agent-based-parser.ts`, NOT Chevrotain grammar. The Chevrotain lexer/CST parser is only used for supervisor documents.                                    |
| 3   | How many custom CEL functions exist?               | ANSWERED       | 35+ functions in `packages/compiler/src/platform/constructs/cel-functions.ts` (222 LOC in language-service metadata).                                                                  |
| 4   | What is the compilation timeout default?           | ANSWERED       | 30,000ms, configurable via `CompilerOptions.compilationTimeoutMs`. Error code E727 emitted on timeout.                                                                                 |
| 5   | Are source maps implemented?                       | ANSWERED       | `CompilerOptions.include_source_maps` is declared but not fully implemented. Logged as GAP-007.                                                                                        |
| 6   | What system tool names are reserved?               | ANSWERED       | `__handoff__`, `__delegate__`, `__complete__`, `__escalate__`, `__fan_out__`, `__set_context__` per `packages/compiler/src/platform/constants.ts`.                                     |

## Files Created/Modified

- `docs/features/abl-language.md` -- Re-generated feature spec with all 20 template sections filled
- `docs/sdlc-logs/abl-language/feature-spec.log.md` -- This log file

## Codebase Exploration

### Packages Explored

| Package                     | Key Files                          | LOC                         | Notes          |
| --------------------------- | ---------------------------------- | --------------------------- | -------------- |
| `packages/core`             | parser/, types/, schema/           | ~10,671 total               | 25 test files  |
| `packages/compiler`         | platform/ir/, platform/constructs/ | ~7,545 in ir/ + constructs/ | 168 test files |
| `packages/language-service` | src/ (9 files)                     | 2,459                       | 7 test files   |

### Key Findings

1. The uppercase DSL parser is a regex-based line scanner (not Chevrotain grammar as sometimes assumed)
2. The Chevrotain lexer (524 LOC) is only used by the supervisor parser
3. Both parser paths produce identical `AgentBasedDocument` AST -- format detection is a 33-LOC heuristic
4. CEL evaluator requires BigInt normalization due to `@marcbachmann/cel-js` behavior
5. The compiler timeout mechanism checks elapsed time at each agent compilation iteration

## Review Summary

### Round 1 -- Completeness

- [x] All 20 sections filled (template has 18 + runtime integration + admin integration)
- [x] 8 user stories (exceeds minimum 3)
- [x] 15 functional requirements (exceeds minimum 4)
- [x] 5 related features in integration matrix
- [x] Non-functional concerns address tenant, project, and user isolation
- [x] Delivery plan has 5 parent tasks with subtasks
- [x] 5 open questions
- [x] All claims grounded in code evidence with file paths and LOC counts

### Round 2 -- Cross-Phase Consistency

- [x] FR numbering consistent (FR-1 through FR-15)
- [x] Scope boundaries match non-goals
- [x] User stories align with functional requirements
- [x] Implementation files verified at stated paths
