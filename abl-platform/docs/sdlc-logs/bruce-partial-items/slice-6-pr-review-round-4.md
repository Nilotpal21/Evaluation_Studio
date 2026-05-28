# Slice 6 PR Review -- Round 4 of 5

**Reviewer:** pr-reviewer (Claude Opus 4.6)
**Date:** 2026-04-19
**Jira:** ABLP-415
**Commits:** 6066d0e5c, 5edd28de0, d5a379b02, ee1695381, 3bbe3f1e7, 58ee0b501 (+ eff1cb520 for orphaned AST field)
**Round 3 verdict:** NEEDS_FIXES (1 MEDIUM: JSON schema drift)
**Round 3 response:** Commit 58ee0b501 adds `enum_set` to `abl-schema.json`, 3 new Ajv tests, and ABL_SPEC precedence callout

## VERDICT: APPROVED (clean)

---

## Round 3 MEDIUM Resolution

### JSON Schema Drift (`abl-schema.json` missing `enum_set`)

**Status: RESOLVED**

Verified at `packages/core/src/schema/abl-schema.json:700-703`:

```json
"enum_set": {
  "type": "array",
  "items": { "type": "string" }
}
```

The property is inside the `semantics` object (lines 687-706) which retains `"additionalProperties": false`. This means `enum_set` is now explicitly allowed and no unknown properties can sneak in.

Three new tests added at `packages/core/src/__tests__/abl-schema.test.ts`:

1. **Line 280**: "validates gather field with semantics.enum_set" -- accepts `{ enum_set: ['small', 'medium', 'large'] }` as the sole semantics property
2. **Line 295**: "validates semantics.enum_set coexisting with other semantics keys" -- accepts `{ format: 'currency_code', enum_set: ['USD', 'EUR', 'GBP'], locale: 'en-US' }`
3. **Line 314**: "rejects non-array semantics.enum_set" -- confirms `enum_set: 'small,medium,large'` (string) is rejected

All three tests verify the exact failure mode (additionalProperties rejection) and the positive acceptance paths. Schema-code drift is closed.

### ABL_SPEC Precedence Rule (Round 3 LOW)

**Status: RESOLVED**

Verified at `docs/reference/ABL_SPEC.md:511`:

> **Precedence when both `options` and `semantics.enum_set` are specified:** the top-level `options` list wins and is written into `enum_values`. `semantics.enum_set` is retained on the IR `semantics` block for round-trip / introspection but does _not_ override the top-level list.

This matches the compiler behavior at `compiler.ts:1270-1274` and `compiler.ts:3199-3203`, and is locked by tests 5, 6, and 7 in the test file.

---

## Verification Item 1: Schema Tests Pass

**Core package:** 685/685 tests PASS (34 test files), 0 failures. Duration: 831ms.

The 3 new `enum_set` tests (52 total schema tests) are included in this count. No regressions from the schema addition.

## Verification Item 2: Compiler Tests Pass (Runtime Regression Pulse)

**Compiler package:** 4854/4854 tests PASS (204 test files, 4 skipped), 0 failures. Duration: 7.19s.

No regressions from the IR schema addition, the parser list-keys change, or the compiler ternary addition. The 7 enum_set-specific tests all pass within this suite.

## Verification Item 3: Cross-Slice Consistency (FLOW-Step Compile Path)

Re-verified at `packages/compiler/src/platform/ir/compiler.ts:3180-3203`:

- Line 3189: `enum_set: f.semantics.enumSet` -- semantics block carries the field
- Lines 3199-3203: `enum_values` fallback chain: `f.options?.length ? f.options : f.semantics?.enumSet?.length ? f.semantics.enumSet : undefined`

This is structurally identical to the top-level path at lines 1270-1274 and 1387-1396. The FLOW-step path does NOT replicate the Slice 5 (ABLP-414) gap where `sensitive`, `sensitive_display`, and `mask_config` are silently dropped. Slice 6 `enum_set` is correctly carried through both compile paths.

**Verdict:** CONFIRMED CLEAN. No FLOW-step gap for `enum_set`.

## Verification Item 4: Public-Contract Completeness

### Contract Registry (`abl-contract-registry.ts`)

No `enum_set` entry needed. Grep confirmed zero matches. The registry catalogs construct-level facts (handoff semantics, lifecycle events, coordination actions, system variables), not individual `GatherFieldSemantics` properties. No existing entry for `format`, `unit`, `locale`, or any other field-level semantics property. Consistent with Round 3 finding #4.

### Generated Contract JSON (`docs/reference/generated/abl-contract.json`)

Zero matches for `enum_set`, `enum_values`, or field-level `semantics` in the generated JSON. The generated facts operate at construct level (handoff, memory, lifecycle). No asymmetry.

### Generated Contract Facts (`docs/reference/generated/abl-contract-facts.md`)

Same: zero matches for gather-field-level properties. Construct-level only.

### `apps/content/` (MDX reference material)

Directory does not exist at `apps/content/abl-reference/`. Not applicable.

### Package `agents.md` learnings

Grep for `enum_set`/`enumSet` across all `agents.md` files: zero matches. No package-level learning has been logged for this slice. This is a minor gap but non-blocking -- the feature is fully documented in ABL_SPEC.md and the test file header.

**Verdict:** No public-contract gaps. The feature is documented where users look (ABL_SPEC.md) and validated by the JSON schema.

## Verification Item 5: Studio Decompiler / Visual Editor Round-Trip

### Decompiler

No IR-to-DSL decompiler exists (confirmed in Rounds 2-3; re-verified via grep). Studio works with raw DSL text editing. DSL text round-trips preserve `enum_set` verbatim.

### Visual Editor (form-based)

The Studio visual editor uses `parseGather` (IR -> `GatherFieldData`) at `apps/studio/src/store/agent-detail-store.ts:431-471` and `serializeGatherToABL` (`GatherFieldData` -> DSL text) at `apps/studio/src/lib/abl-serializers.ts:156-226`.

Observations:

- `GatherFieldData` (lines 99-124) does NOT have an `enumSet` or `enum_set` property
- `parseGather` reads `f.enum_values` into `options` (line 450) and `f.semantics?.lookup` into `lookupTable` (line 466-468), but does NOT read `f.semantics?.enum_set`
- `serializeGatherToABL` writes `options: [...]` only when `f.type === 'enum'` (line 203), and writes `semantics: { lookup: ... }` (lines 182-186) but not `enum_set`

This means: if a user edits a field that uses `SEMANTICS: { enum_set: [...] }` with `type: string` through the visual editor, the `enum_set` origin is lost -- the field round-trips through `enum_values -> options` but the serializer only emits `options:` for `type: enum`, not `type: string`.

**However, this is a pre-existing limitation** of the visual editor, not a Slice 6 regression:

- The same limitation exists for `format`, `components`, `unit`, `convert_to`, `locale`, and `kore_entity_type` -- none of these semantics properties are in `GatherFieldData` or the serializer
- Only `lookup` is carried through the visual editor path
- The visual editor was designed for a subset of GATHER properties; advanced features require the code editor

**Verdict:** INFO only. Pre-existing visual editor limitation. Not a Slice 6 defect. The raw DSL code editor (which is how advanced users write `SEMANTICS:` blocks) preserves everything.

## Verification Item 6: ON_INPUT Determinism Docs

Re-verified both blockquotes:

**ABL_SPEC.md:1895-1901** (Section 3.20.3):

> `ON_INPUT` is a _deterministic_ routing primitive. `IF` conditions evaluate as pure boolean expressions over `input` and flow/session variables -- no LLM reasoning, no intent classification, no tool calls inside the predicate.

**ABL_SPEC.md:2854-2856** (Section 7.10):

> ON_INPUT `IF:` predicates are pure boolean expressions over `input` and session/flow variables. No LLM reasoning, no tool invocations, no intent classification runs inside the predicate

**Runtime implementation** at `packages/compiler/src/platform/constructs/utils.ts:446-546`:

- `evaluateOnInput()` is a synchronous function that iterates branches sequentially
- Conditions are evaluated via `evaluateConditionDetailedDual()` (line 518) -- a CEL-aware boolean evaluator
- No LLM calls, no async operations, no tool invocations in the evaluation path
- ELSE branch (no condition) always matches as fallback (line 483)
- First match wins (returns immediately at line 545)

The flow-step-executor at `apps/runtime/src/services/execution/flow-step-executor.ts:5190-5197` calls `evaluateOnInput()` synchronously with `branchesToEvaluate`, `currentMessage`, and `session.data.values` as context. No LLM or tool call infrastructure is injected.

**Verdict:** Both blockquotes are truthful and non-contradictory. The ON_INPUT evaluation model is a synchronous, deterministic, first-match boolean dispatcher using CEL expression evaluation. The docs accurately describe both the design intent and the actual implementation.

## Verification Item 7: Final Architectural Sign-Off

After 4 rounds of review covering:

1. **Round 1**: Core correctness (TDD tests, compiler paths, IR mapping, back-compat)
2. **Round 2**: Combinatorial completeness (precedence matrix, FLOW-step coverage)
3. **Round 3**: Systemic analysis (IR hashing, cache keys, schema validation, runtime data flow, observability, ON_INPUT determinism)
4. **Round 4**: Closure verification (schema fix, regression testing, cross-slice consistency, public contracts, Studio round-trip, ON_INPUT truthfulness)

No remaining concerns. The implementation is:

- **Complete**: Both compile paths (top-level and FLOW-step) carry `enum_set` through semantics and normalize to `enum_values`
- **Non-breaking**: Absence of the feature produces identical IR/hashes to pre-feature agents
- **Schema-aligned**: JSON schema, TypeScript types, parser, compiler, and docs all agree
- **Test-locked**: 7 compiler tests + 3 schema tests cover the full behavioral matrix (both paths, precedence, coexistence, absence, back-compat, type rejection)
- **Documented**: ABL_SPEC.md field row + precedence blockquote
- **Isolated from pre-existing gaps**: FLOW-step sensitive/mask_config gap is Slice 5 (ABLP-414), not replicated here

---

## Analyze-Counter-Fix Audit Trail

| #   | Finding                                         | Severity | Action       | Evidence                                                                                                                                           |
| --- | ----------------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Round 3 MEDIUM: JSON schema drift               | MEDIUM   | RESOLVED     | `abl-schema.json:700-703` now includes `enum_set`. 3 Ajv tests at `abl-schema.test.ts:280,295,314`. Core suite 685/685 PASS.                       |
| 2   | Round 3 LOW: ABL_SPEC precedence rule           | LOW      | RESOLVED     | ABL_SPEC.md:511 blockquote documents precedence. Matches compiler code at 1270-1274 and 3199-3203.                                                 |
| 3   | FLOW-step compile path after schema change      | MEDIUM   | VERIFIED     | compiler.ts:3189 carries `enum_set`, 3199-3203 fallback chain intact. 4854/4854 compiler tests PASS.                                               |
| 4   | Contract registry / generated facts gap         | LOW      | COUNTERED    | Registry is construct-level, not field-semantics-level. No existing entries for `format`, `unit`, `locale`. No asymmetry.                          |
| 5   | Studio visual editor drops `semantics.enum_set` | INFO     | PRE-EXISTING | `GatherFieldData` type lacks all semantics properties except `lookup`. Same gap for `format`, `components`, `unit`, etc. Not a Slice 6 regression. |
| 6   | ON_INPUT determinism docs truthfulness          | INFO     | VERIFIED     | `evaluateOnInput()` at utils.ts:446 is synchronous CEL evaluation. No LLM/tool calls. Both ABL_SPEC blockquotes (1901, 2856) match implementation. |
| 7   | Package agents.md not updated                   | INFO     | NOTED        | No learning logged for enum_set. Non-blocking -- feature documented in ABL_SPEC and test headers.                                                  |

## Review Rounds Summary

| Category                   | Round | Findings | Countered | Fixed    | Resolved                     |
| -------------------------- | ----- | -------- | --------- | -------- | ---------------------------- |
| Correctness                | R1    | 2 LOW    | 0         | 2        | 2                            |
| Combinatorial completeness | R2    | 1 LOW    | 0         | 1        | 1                            |
| Systemic analysis          | R3    | 12       | 8         | 1 MEDIUM | 12                           |
| Closure verification       | R4    | 7        | 2         | 0        | 7 (all prior fixes verified) |
| **Total**                  | **4** | **22**   | **10**    | **4**    | **22**                       |

## Verification Results

- **Build**: Core and compiler packages compile cleanly (tests ran successfully, which requires build)
- **Tests**: Core 685/685 PASS, Compiler 4854/4854 PASS (204 files, 4 skipped)
- **Prettier**: Pre-commit hook enforces on all committed code; committed files are formatted
- **Jira**: ABLP-415 used consistently across all 6 commits in scope

## OpenAI Review

MCP tool not available -- skipped.

## Documentation Sync Check

- [x] ABL_SPEC.md updated with `enum_set` field row and precedence blockquote
- [x] JSON schema (`abl-schema.json`) updated with `enum_set` property
- [x] No new routes, workers, or models -- no architecture doc updates needed
- [x] No new packages -- no Dockerfile updates needed
- [ ] `packages/compiler/agents.md` not updated with enum_set learning (INFO, non-blocking)

## Remaining Items (non-blocking, for future work)

1. **Studio visual editor**: `GatherFieldData` could be extended with a `semantics` property to preserve `format`, `enum_set`, etc. through the visual editor path. This is a pre-existing gap affecting all semantics properties, not specific to Slice 6.
2. **Package learning**: Consider adding an `agents.md` entry to `packages/compiler/` documenting the dual-path compile pattern for new `GatherFieldSemantics` properties (top-level at ~1387 and FLOW-step at ~3180).
