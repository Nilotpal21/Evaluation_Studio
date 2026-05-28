# Slice 6 PR Review — Round 1 of 5

**Reviewer:** pr-reviewer (Claude Opus 4.6)
**Date:** 2026-04-19
**Jira:** ABLP-415
**Commits:** 6066d0e5c, 5edd28de0, d5a379b02 (+ eff1cb520 for orphaned AST field)

## VERDICT: APPROVED (with 2 LOW suggestions)

---

## Analyze-Counter-Fix Audit Trail

| #   | Finding                                                                                                      | Severity | Action       | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------ | -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FLOW-step test (test 4) does not assert `semantics.enum_set` round-trip                                      | LOW      | SUGGESTION   | Test 1 asserts both `semantics.enum_set` and `enum_values` for top-level; test 4 only asserts `enum_values`. The FLOW-step compiler does map `enum_set` (compiler.ts:3189), so it will work, but test coverage is asymmetric.                                                                                                                 |
| 2   | No test for precedence when BOTH `options:` and `semantics.enum_set:` coexist                                | LOW      | SUGGESTION   | Compiler at line 1270 clearly gives `options` precedence. Documenting via test would prevent future regression if someone reorders the ternary.                                                                                                                                                                                               |
| 3   | ON_INPUT determinism doc says "compiler and runtime both treat ON_INPUT as a first-match boolean dispatcher" | INFO     | COUNTERED    | The compiler passes through condition strings without enforcing purity (compiler.ts:3298-3305). The doc is aspirational/prescriptive ("treat as"), not claiming static analysis enforcement. The runtime does evaluate conditions as expressions. The phrasing is acceptable as a design contract.                                            |
| 4   | FLOW-step compiler drops `sensitive`, `sensitive_display`, `mask_config`                                     | INFO     | PRE-EXISTING | Lines 3145-3204 of compiler.ts map FLOW-step fields but omit sensitive/mask_config. This is the Slice 5 gap (ABLP-414 follow-up). Slice 6 correctly adds `enum_set` to both paths — no new asymmetry introduced.                                                                                                                              |
| 5   | AST field `enumSet` landed in ABLP-417 commit (eff1cb520)                                                    | INFO     | ACKNOWLEDGED | Documented staging race. The field is correctly typed at agent-based.ts:671 and consumed by compiler + parser in the ABLP-415 commits. No code gap.                                                                                                                                                                                           |
| 6   | AgentIR hash impact from new `enum_set` field                                                                | INFO     | COUNTERED    | `computeIRHash` at session-service.ts:110 uses `JSON.stringify(ir)`. Adding `enum_set: undefined` produces no JSON output (undefined is omitted). Only agents actually using `enum_set:` in DSL will see hash changes, which is correct — the IR changed. No forced cache invalidation for unrelated agents. No settings-version bump needed. |
| 7   | Runtime consumers of `enum_values` unaffected                                                                | INFO     | VERIFIED     | flow-step-executor.ts reads `enum_values` at lines 2480, 2992. extraction-validation.ts reads `enum_values` at lines 24, 292, 328. None read `semantics.enum_set` directly. The normalization to `enum_values` at compile time means runtime is transparent to the new DSL path.                                                              |
| 8   | No runtime error surfaces leak tenant/model info                                                             | INFO     | VERIFIED     | No new error throwing code in any Slice 6 file. Parser and compiler changes are pure data transforms.                                                                                                                                                                                                                                         |
| 9   | `SEMANTIC_KEY_MAP` and `SEMANTIC_LIST_KEYS` used in BOTH parser paths                                        | INFO     | VERIFIED     | FLOW-step parser at line 1062 and top-level parser at line 3049 both call `isSemanticListKey(mappedKey)`. Symmetric.                                                                                                                                                                                                                          |
| 10  | IR schema `enum_set` follows snake_case convention                                                           | INFO     | VERIFIED     | AST: `enumSet` (camelCase). IR: `enum_set` (snake_case). Matches `convertTo`/`convert_to`, `koreEntityType`/`kore_entity_type`.                                                                                                                                                                                                               |

## Code Quality

### Correctness

- **Top-level path**: `compileGather` at line 1270 correctly falls back from `options` to `semantics.enumSet`. Line 1396 mirrors `enumSet` into IR `semantics.enum_set`. CORRECT.
- **FLOW-step path**: Line 3199 applies identical fallback logic. Line 3189 mirrors into IR semantics. CORRECT.
- **Parser**: `SEMANTIC_KEY_MAP` maps `enum_set` -> `enumSet`. `SEMANTIC_LIST_KEYS` has both `components` and `enumSet`. `isSemanticListKey()` called in BOTH top-level (line 3049) and FLOW-step (line 1062) parsers. CORRECT.
- **Back-compat**: Top-level `options:` path unchanged; test 5 passes. CORRECT.

### Test Quality

- 5 tests cover: top-level round-trip, absence guard, coexistence with other semantics, FLOW-step path, back-compat. All 5 pass.
- **Suggestion**: Test 4 (FLOW-step) should also assert `field!.semantics!.enum_set` for full parity with test 1.
- **Suggestion**: A 6th test for dual-specification (`options:` AND `semantics.enum_set:` on the same field) would lock the precedence rule.

### Architectural Symmetry with Slice 5

Slice 6 does NOT introduce a new FLOW-step asymmetry. Both top-level and FLOW-step paths correctly propagate `enum_set` into both `semantics.enum_set` and `enum_values`. The pre-existing FLOW-step gap for `sensitive`/`mask_config` is from before Slice 6 and tracked under ABLP-414.

### Documentation

- `enum_set` row in Field Semantics table: accurate, describes alias relationship correctly.
- ON_INPUT determinism paragraph: precise, correctly distinguishes from DIGRESSIONS. The phrase "compiler and runtime both treat" is prescriptive rather than claiming static enforcement, which is fine.
- Flow Step Events determinism blockquote: reinforces the same rule. No contradictions.

## Verification Results

- **Tests**: 5/5 PASS (gather-semantics-enumset-alias.test.ts)
- **Jira**: ABLP-415 used consistently across all 3 commits. AST orphan in ABLP-417 documented.
- **Prettier**: Not re-checked (committed code; pre-commit hook would have caught issues)

## OpenAI Review

MCP tool not available — skipped.

## Suggestions (non-blocking)

1. **Test 4 completeness** (`gather-semantics-enumset-alias.test.ts:114`): Add `expect(field!.semantics!.enum_set).toEqual(['low', 'medium', 'high', 'urgent']);` to verify FLOW-step semantics round-trip, matching what test 1 does for top-level.

2. **Precedence lock test**: Add a test with both `options: [a, b]` and `SEMANTICS: { enum_set: [x, y] }` on the same field, asserting `enum_values` matches `options` — locks the precedence rule documented in the code comment at compiler.ts:1267-1269.
