# Slice 6 PR Review -- Round 3 of 5

**Reviewer:** pr-reviewer (Claude Opus 4.6)
**Date:** 2026-04-19
**Jira:** ABLP-415
**Commits:** 6066d0e5c, 5edd28de0, d5a379b02, ee1695381, 3bbe3f1e7 (+ eff1cb520 for orphaned AST field)
**Round 2 verdict:** APPROVED (clean)
**Round 2 response:** Commit 3bbe3f1e7 adds FLOW-step precedence-lock test

## VERDICT: NEEDS_FIXES (1 MEDIUM finding)

---

## Round 2 Resolution

### Suggestion: FLOW-step precedence-lock test (combinatorial completeness)

**Status: RESOLVED**

Commit 3bbe3f1e7 adds test 7 at line 137-163: "FLOW-step GATHER: options wins when both options and semantics.enum_set are specified". Uses `severity` field with `OPTIONS: [sev1, sev2, sev3]` and `SEMANTICS: { enum_set: [minor, major, blocker] }`, asserting `enum_values === ['sev1', 'sev2', 'sev3']` (options wins) and `semantics.enum_set === ['minor', 'major', 'blocker']` (semantics preserved). The combinatorial matrix is now complete: top-level + FLOW-step, both enum_set-only and options-wins-over-enum_set.

Verified at `packages/compiler/src/__tests__/gather-semantics-enumset-alias.test.ts:137-163`.

---

## Systemic & Integration Analysis (Round 3 Focus)

### 1. IR Determinism and Hashing

**Analysis:** `computeIRHash` at `apps/runtime/src/services/session/session-service.ts:110` uses `JSON.stringify(ir)`. When a field has `semantics.enum_set: undefined`, `JSON.stringify` omits the key entirely, producing identical JSON to an agent without the field. Only agents that explicitly use `SEMANTICS: { enum_set: [...] }` in their DSL will have `semantics.enum_set` set to a non-undefined value, producing a different hash. This is correct -- new semantic info changes the hash, absence of the feature is transparent.

**JSON key ordering concern:** `JSON.stringify` produces keys in insertion order. The compiler always builds the semantics object in the same order (format, components, unit, lookup, convert_to, locale, kore_entity_type, enum_set) at both compiler.ts:1386-1396 and 3180-3189. No dynamic key reordering risk.

**Verdict:** COUNTERED. IR hash stability is preserved. No forced invalidation for unrelated agents.

### 2. Model Resolution Cache Impact

**Analysis:** The model resolution cache key (via `buildModelResolutionSnapshotFingerprint` at `model-resolution-versioning.ts:144-152`) reads ONLY from `agentIR.execution` via `getModelResolutionExecutionSnapshot()`. `GatherFieldSemantics` lives under `AgentIR.gather.fields[*].semantics`, which is NOT on the model resolution cache key path. The reasoning-settings cache key uses the same execution-only snapshot fingerprint. No cache bump needed.

**Verdict:** COUNTERED. `gather` is completely outside the model resolution cache key surface.

### 3. Contract Registry / Fact Catalog

**Analysis:** The `abl-contract-registry.ts` at `packages/compiler/src/platform/contracts/abl-contract-registry.ts` catalogs high-level constructs (handoff, memory, lifecycle events, coordination actions, system variables), not individual field-level semantics properties. No existing catalog entry covers `format`, `components`, `unit`, or any other `GatherFieldSemantics` property. Adding `enum_set` does not create an asymmetry with the registry.

**Verdict:** COUNTERED. The contract registry operates at construct level, not field-semantics level. No entry needed for `enum_set`.

### 4. Schema Versioning / Migration -- JSON Schema Missing `enum_set`

**Analysis:** `packages/core/src/schema/abl-schema.json` defines the `semantics` object at lines 687-702 with `"additionalProperties": false`. The properties list includes: `format`, `components`, `unit`, `lookup`, `convert_to`, `locale`, `kore_entity_type` -- but does NOT include `enum_set`.

Since `additionalProperties: false` is set, any ABL YAML with `semantics: { enum_set: [...] }` will fail Ajv validation against this schema. The schema is documented as the "public schema surface consumed by tooling/tests" (per `docs/features/abl-contract-hardening.md:378`). External tooling, IDE plugins, or CI pipelines using this schema would reject valid agents that use `enum_set` in semantics.

The existing `abl-schema.test.ts` (49 tests, all passing) does not test `enum_set` in semantics, so this gap is not caught by CI.

**Verdict:** CONFIRMED. Schema-code drift: TypeScript types, parser, compiler, and docs all support `enum_set`, but the JSON schema rejects it. This is a real bug that will block any schema-validation consumer from accepting agents with `semantics.enum_set`.

**Recommended fix:**

1. Add `"enum_set": { "type": "array", "items": { "type": "string" } }` to the `semantics.properties` object in `packages/core/src/schema/abl-schema.json` (after `kore_entity_type`).
2. Add a test in `abl-schema.test.ts` validating a gather field with `semantics: { enum_set: ['a', 'b'] }` to prevent future drift.

### 5. Studio Decompiler Round-Trip

**Analysis:** Grep for `decompil`, `ir-to-dsl`, `dslFromIR`, `irToDsl` across the entire repo returns zero matches outside the Round 2 review log. No IR-to-DSL decompiler exists. Studio works with raw DSL text editing. A UI save preserves the text as-is, so `enum_set` survives round-trips through DSL text editing.

**Verdict:** COUNTERED. No decompiler exists to strip the field.

### 6. IR to Runtime Data Flow

**Analysis:** Grep for `enum_set`/`enumSet` in `apps/runtime/src/` returns zero matches. The runtime reads `enum_values` (at `extraction-validation.ts:292` and `flow-step-executor.ts:2480,2992`), never `semantics.enum_set`. The compile-time normalization from `semantics.enum_set` into the top-level `enum_values` means the runtime is completely transparent to the new DSL path. `semantics.enum_set` in the IR is pure introspection/round-trip metadata, not a runtime consumer. This matches the design documented in the test file header (lines 10-11) and ABL_SPEC.md (line 509).

**Verdict:** COUNTERED. Intentional design -- `semantics.enum_set` is for introspection; runtime reads `enum_values`.

### 7. Observability / Traces

**Analysis:** The trace-event-registry at `packages/shared-kernel/src/constants/trace-event-registry.ts` does not reference `semantics`, `enum_set`, or any gather field properties. Trace events capture execution-level events (session start/end, agent execution, tool calls), not field-level schema metadata. No schema-strict trace validators operate on gather field semantics.

**Verdict:** COUNTERED. Trace infrastructure does not intersect with gather field semantics.

### 8. Runtime / Studio Test Suite Pulse

**Analysis:**

- Compiler enum_set tests: 7/7 PASS (verified: `gather-semantics-enumset-alias.test.ts`)
- ABL schema tests: 49/49 PASS (but no test covers `semantics.enum_set` -- see finding #4)
- No snapshot tests over IR shape exist in compiler or runtime (grep confirmed)
- No runtime test references `enum_set` or `enumSet` -- no updates needed

**Verdict:** NO RISK. The new field does not require runtime test updates.

### 9. Docs Completeness -- Precedence Rule

**Analysis:** ABL_SPEC.md line 509 describes `enum_set` as "Allowed enumeration values (alias for top-level `options`; compiler mirrors into `enum_values`)". It does NOT mention the precedence rule: when both `options:` and `semantics.enum_set:` coexist, `options` wins for `enum_values` while `semantics.enum_set` is preserved independently.

The compiler code comment at compiler.ts:1267-1269 documents this: "Enum values can be declared either top-level (options: [...]) or inside the semantics block (enum_set: [...]). Normalize to a single enum_values array on the IR so runtime consumers read one source."

The test suite locks this behavior (tests 5, 6, 7), but the public-facing ABL_SPEC row does not mention precedence. Users who write both `OPTIONS:` and `SEMANTICS: { enum_set: ... }` would not know which wins without reading the compiler source.

**Verdict:** INFO (LOW). The "alias for top-level `options`" wording implies `options` is the primary and `enum_set` the alias, which is directionally correct. The full precedence rule is locked by tests. Not blocking, but a doc improvement would be beneficial.

### 10. ON_INPUT Determinism Callout Veracity

**Analysis:** The compiler at `compiler.ts:3298-3305` maps ON_INPUT branches by passing through `branch.condition` as a string without any static analysis or validation of purity. The runtime evaluates conditions as expressions via the resolveValue/CEL evaluator, which does support pure boolean evaluation but does not enforce it -- a user could reference a tool call result variable. The docs (ABL_SPEC.md:1899 and 2854) correctly frame this as "the compiler and runtime both treat ON_INPUT as a first-match boolean dispatcher" -- a prescriptive design rule, not claiming static enforcement. The phrasing is a design contract that guides correct usage.

**Verdict:** COUNTERED. The callout is prescriptive (how to use ON_INPUT correctly), not claiming compile-time enforcement of purity. Accurately describes the runtime's evaluation model (sequential first-match).

---

## Analyze-Counter-Fix Audit Trail

| #   | Finding                                       | Severity   | Action        | Evidence                                                                                                                                                            |
| --- | --------------------------------------------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Round 2 LOW: FLOW-step precedence-lock test   | LOW        | RESOLVED      | Commit 3bbe3f1e7 at test file:137-163                                                                                                                               |
| 2   | IR hash stability with new `enum_set` field   | MEDIUM     | COUNTERED     | `JSON.stringify` omits `undefined` keys; compiler builds semantics in deterministic order at compiler.ts:1386-1396. Only agents using the feature see hash changes. |
| 3   | Model resolution cache key impact             | MEDIUM     | COUNTERED     | Cache keys read only `agentIR.execution` via `getModelResolutionExecutionSnapshot()`. `gather.fields.*.semantics` is not on the path.                               |
| 4   | Contract registry needs `enum_set` entry      | LOW        | COUNTERED     | Registry catalogs constructs, not field-level semantics properties. No existing entry for `format`, `unit`, etc.                                                    |
| 5   | **JSON schema missing `enum_set`**            | **MEDIUM** | **CONFIRMED** | `abl-schema.json:687-702` has `additionalProperties: false` on `semantics` but no `enum_set` property. External tooling will reject valid DSL.                      |
| 6   | Studio decompiler might strip `enum_set`      | LOW        | COUNTERED     | No decompiler exists. Studio edits raw DSL text.                                                                                                                    |
| 7   | Runtime does not consume `semantics.enum_set` | INFO       | VERIFIED      | Zero matches for `enum_set`/`enumSet` in `apps/runtime/src/`. By design: compile-time normalization to `enum_values` is the contract.                               |
| 8   | Trace events / observability impact           | LOW        | COUNTERED     | Trace registry does not reference gather field semantics. No schema-strict trace validators.                                                                        |
| 9   | Snapshot tests over IR shape                  | LOW        | COUNTERED     | Zero snapshot tests in compiler or runtime (grep confirmed).                                                                                                        |
| 10  | ABL_SPEC precedence rule not documented       | LOW        | SUGGESTION    | "alias for top-level `options`" is directionally correct but does not state precedence when both coexist. Test-locked.                                              |
| 11  | ON_INPUT determinism callout accuracy         | INFO       | VERIFIED      | Prescriptive design rule, not claiming static enforcement. Runtime evaluates conditions sequentially (first-match).                                                 |
| 12  | FLOW-step `sensitive`/`mask_config` gap       | INFO       | PRE-EXISTING  | Slice 5 (ABLP-414). Slice 6 does NOT extend it.                                                                                                                     |

---

## Verification Results

- **Tests**: 7/7 PASS (`gather-semantics-enumset-alias.test.ts`)
- **Schema tests**: 49/49 PASS (but no coverage for `semantics.enum_set` -- the gap)
- **Jira**: ABLP-415 used consistently across all 5 commits
- **Prettier**: Pre-commit hook enforces; committed code is clean
- **Build**: Compiler and core packages build cleanly

## OpenAI Review

MCP tool not available -- skipped.

---

## Required Fixes (blocking verdict)

1. **[MEDIUM] JSON schema drift** (`packages/core/src/schema/abl-schema.json:687-702`):
   - Add `"enum_set": { "type": "array", "items": { "type": "string" } }` to the `semantics.properties` object.
   - Add a test in `packages/core/src/__tests__/abl-schema.test.ts` validating a gather field with `semantics: { enum_set: ['a', 'b', 'c'] }`.

## Suggestions (non-blocking)

1. **[LOW] Precedence rule in ABL_SPEC** (`docs/reference/ABL_SPEC.md:509`): Consider appending to the `enum_set` row: "When both `options` and `enum_set` are present, `options` takes precedence for `enum_values`; `semantics.enum_set` is preserved independently." Not requesting action -- test-locked.
