# agents.md — packages / core

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-05-03 — ABLP-612 YAML ON_ACTION Direct Field Normalization

**Category**: pattern
**Learning**: YAML direct `on_action` fields are a compatibility authoring shape and should normalize immediately into ordered `do[]` actions. This keeps direct YAML and text ABL behavior aligned for `set`, `clear`, `respond`, `call_spec`, `handoff`, `delegate`, `goto`, and `complete`.
**Files**: `src/parser/yaml-parser.ts`, `src/__tests__/yaml-flow-parser.test.ts`
**Impact**: Future action-handler syntax additions should update both `parseActionHandlerAction()` and direct-handler normalization, or explicitly reject direct usage with diagnostics.

## 2026-04-18 — ABL Contract Hardening Phase 2 (RETURN_HANDLERS surface)

**Category**: pattern
**Learning**: `RETURN_HANDLERS` is now a first-class AST/schema surface, but the parser intentionally keeps `HANDOFF.ON_RETURN` as a string-shaped compatibility lane. The parser records handler references through the existing `onReturn` slot, and the compiler later resolves whether that string is a built-in action (`continue`, `resume_intent`) or a named handler. This keeps text DSL, YAML DSL, and older `ON_RETURN` shorthand compatible while still supporting canonical `{ handler, map }` YAML structures.
**Files**: `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/parser/yaml-parser.ts`, `packages/core/src/schema/abl-schema.json`
**Impact**: Future ON_RETURN features should preserve the parser/compiler split: keep parsing permissive and compatibility-friendly in `@abl/core`, then centralize legality and normalization in the compiler instead of encoding runtime semantics directly into the parser.

## 2026-04-19 — ABL Contract Hardening Phase 4 (memory grants + canonical recall events)

**Category**: architecture
**Learning**: Parser surfaces should accept legacy memory syntax but emit the new canonical form immediately. Persistent memory now accepts `scope: execution_tree`, handoff context accepts both `grant_memory` and explicit `memory_grants`, and recall aliases like `ON_START` / `session_start` normalize to `session:start` at parse time instead of leaking legacy event names downstream.
**Files**: `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/parser/yaml-parser.ts`, `packages/core/src/schema/abl-schema.json`, `packages/core/src/__tests__/parser-memory-enhanced.test.ts`
**Impact**: Future memory-surface additions should keep `@abl/core` permissive for backward compatibility, but any public/generated output coming out of the parser should already be in canonical contract form so compiler/runtime/docs/tests do not each need their own normalization layer.

## 2026-04-19 — ABL Contract Hardening follow-up (authoring schema precision)

**Category**: gotcha
**Learning**: The public authored-YAML schema should validate the DSL surface, not the normalized IR surface. For handoff history that means accepting `auto`, `none`, `summary_only`, `full`, and the DSL shorthand `last_<n>`, while rejecting arbitrary strings even though the compiler later normalizes `last_<n>` into `{ last_n: n }`.
**Files**: `packages/core/src/schema/abl-schema.json`, `packages/core/src/__tests__/abl-schema.test.ts`
**Impact**: When the compiler normalizes syntax sugar into a richer IR shape, keep the JSON schema focused on what authors actually write so editors and CI linters enforce the same contract the parser expects.

## 2026-04-22 — Legacy HANDOFF.ON_RETURN shorthand compatibility follow-up

**Category**: architecture
**Learning**: `@abl/core` must preserve authored `HANDOFF.ON_RETURN` string shorthand exactly as a compatibility lane. The parser and YAML loader should accept plain string values and leave legality and normalization to compiler validation instead of rejecting the authored syntax early.
**Files**: `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/parser/yaml-parser.ts`, `packages/core/src/__tests__/parser-handoff-enhanced.test.ts`, `packages/core/src/__tests__/yaml-parser.test.ts`
**Impact**: Future ON_RETURN work in this package should keep authored-surface parsing permissive and backward-compatible so older bundles continue to parse cleanly while compiler-owned layers decide how to resolve or warn on the shorthand.

## 2026-04-27 — SOAP Tool Support Phase 1a (type system extension)

**Category**: architecture
**Learning**: Adding new optional fields to `HttpBindingAST` is safe and additive — all consumers of the interface already handle partial bindings via optional chaining. New DSL property names (`protocol`, `soap_version`, `soap_action`, `on_soap_fault`) must also be added to `TOOL_IMPLEMENTATION_PROPERTIES` in `agent-based-parser.ts` so the parser treats them as implementation-level props (not allowed in agent DSL tools sections).
**Files**: `packages/core/src/types/agent-based.ts`, `packages/core/src/parser/agent-based-parser.ts`
**Impact**: When extending HTTP tool bindings with new optional fields, always update both the AST type and the parser's implementation properties set in the same change.

## 2026-05-04 — ABLP-817 COMPLETE empty WHEN parser hang

**Category**: gotcha
**Learning**: `parseComplete()` must always advance `state.currentLine` and emit a structured parser error when it sees a `- WHEN:` entry that `parseCompleteCondition()` rejects. An empty `COMPLETE: - WHEN:` line misses the `(.+)` regex in `parseCompleteCondition()`, so the caller must fail closed locally instead of `continue`-ing back onto the same line. Regression coverage should run the parser in a subprocess with a timeout.
**Files**: `packages/core/src/parser/agent-based-parser.ts`, `packages/core/src/__tests__/parser-complete-empty-when-regression.test.ts`
**Impact**: Future COMPLETE-section validation changes need explicit negative tests for malformed `- WHEN:` entries, and any list-style parser helper that can return `null` must either consume the bad line itself or be wrapped by a caller-side cursor advance to avoid hangs.

## 2026-05-16 — Consent-aware tool confirmation syntax

**Category**: pattern
**Learning**: Agent and `.tools.abl` tool properties share `parseToolProperties()`, so new tool-level authoring fields should be added there once rather than separately in the agent parser. Consent-aware confirmation uses authored snake_case (`consent_required_in`, `consent_scope`, `consent_action`, `consent_fallback`) and normalizes to camelCase on `AgentTool.confirmation`; the compiler owns conversion to IR snake_case.
**Files**: `packages/core/src/parser/tool-file-parser.ts`, `packages/core/src/types/agent-based.ts`, `packages/core/src/__tests__/agent-based-parser.test.ts`
**Impact**: Future tool confirmation fields should follow the same authored-syntax -> AST -> IR split and add a parser test that reads through `parseAgentBasedABL()` so both agent-local and shared tool property parsing stay locked.

## 2026-05-17 — Coordination experience mode is authored metadata

**Category**: data propagation
**Learning**: `EXPERIENCE_MODE` on `HANDOFF` and `DELEGATE` is a topology/customer-experience hint, not runtime control flow by itself. The parser should preserve recognized values on the AST as optional `experienceMode` and leave legality/enforcement to compiler/runtime layers. Unknown values are ignored today for compatibility rather than making older authored bundles fail parse.
**Files**: `src/types/agent-based.ts`, `src/parser/agent-based-parser.ts`
**Impact**: Future coordination metadata should follow this split: parse the authored field permissively, compile it into IR, and add downstream validation/enforcement where the semantics are known.
