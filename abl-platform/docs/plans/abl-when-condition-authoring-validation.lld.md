# ABL WHEN Condition Authoring and Validation — Low-Level Design

**Status**: DRAFT
**Date**: 2026-04-24
**Owner**: Platform team
**Related Feature Doc**: [docs/features/abl-language.md](../features/abl-language.md)
**Related Testing Guide**: [docs/testing/abl-language.md](../testing/abl-language.md)
**Related HLD Spec**: [docs/specs/abl-language.hld.md](../specs/abl-language.hld.md)

## 0. Implementation Progress

- [x] Phase 0: authoring-surface cleanup
- [ ] Phase 1: shared boolean-condition validation foundation
- [ ] Phase 2: runtime fail-closed compatibility guard
- [ ] Phase 3: Studio route-type authoring model
- [ ] Phase 4: generator, language-service, and docs migration completion

## 1. Scope

This LLD turns the current `WHEN` confusion into a concrete implementation plan. It focuses on:

- making `WHEN` mean one thing everywhere: a boolean expression over runtime state
- separating semantic routing from expression authoring in Studio
- rejecting dangerous top-level string-literal conditions consistently across compiler and runtime
- preserving valid shorthand such as `needs_specialist`
- making fallback routing explicit via `WHEN: true`
- aligning docs, prompt templates, snippets, and diagnostics with the same mental model

Out of scope for this plan:

- redesigning the upstream intent-classification pipeline itself
- changing CEL syntax or replacing the evaluator
- broad parser rewrites for uppercase DSL or YAML ABL

## 2. Terminology

| Term                     | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Boolean condition slot   | Any ABL field that is evaluated as a boolean expression (`WHEN`, `IF`, `CHECK`, etc.) |
| Expression route         | A route authored directly as a boolean expression, e.g. `input contains "lookup"`     |
| Intent route             | A route that targets classifier output, e.g. `intent.category == "billing"`           |
| Fallback route           | The explicit final route authored as `WHEN: true`                                     |
| Literal-string condition | A condition whose entire expression is a string literal, e.g. `"user wants help"`     |

## 3. Non-Negotiable Invariants

1. `WHEN` always means “evaluate this boolean expression now.” It must never imply hidden supervisor reasoning.
2. Semantic routing must be explicit. If the product wants plain-English routing, it must classify first and then route on structured state such as `intent.category`.
3. Top-level string-literal conditions are invalid authoring, except safe normalization of `"true"` and `"false"`.
4. Valid shorthand expressions such as `needs_specialist` remain supported.
5. Explicit fallback routes compile and render as `WHEN: true`, not `WHEN: "true"`.
6. Compiler, language-service, Studio UI, snippets, and prompt templates must teach the same condition model.
7. Runtime must not execute dangerous legacy string-literal conditions as truthy first-match rules.
8. Legacy compatibility must be bounded and observable with trace warnings or diagnostics.
9. Cross-surface behavior must stay format-agnostic: uppercase DSL and YAML ABL follow the same condition rules.
10. Every rollout slice must be independently deployable and must not require a one-shot migration.

## 4. Decision Log

| #   | Decision                                                                                     | Rationale                                                                                                | Alternatives Rejected                                            |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D-1 | Treat `WHEN` as a boolean-expression slot everywhere                                         | Removes ambiguity and aligns runtime behavior with author intent                                         | Implicit semantic interpretation of plain-English `WHEN`         |
| D-2 | Add explicit Studio route types: Intent, Expression, Fallback                                | Makes the semantic-vs-deterministic choice visible instead of overloading raw text                       | Keep one freeform `WHEN` field and rely only on placeholder text |
| D-3 | Add one shared compiler validator for boolean-condition slots                                | Prevents handoff-only fixes from leaving the same bug in delegates, escalation, completion, and profiles | Ad hoc validators per construct                                  |
| D-4 | Runtime fail-closed on top-level literal strings, with `"true"`/`"false"` normalization only | Protects deployed legacy configs without breaking valid boolean shorthand                                | Continue `Boolean(result)` on any non-empty string               |
| D-5 | Keep catch-all routing explicit as `WHEN: true`                                              | Removes the quoted-string trap and makes fallback intent obvious                                         | Preserve `WHEN: "true"` for compatibility teaching               |

## 5. Module Boundaries

| Module              | Responsibility                                                             | Depends On                                  |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Studio authoring UI | Present route-type choices and expression-first labeling                   | i18n, canvas serializers, snippet generator |
| Studio serializers  | Emit canonical unquoted boolean expressions                                | authoring state, DSL mutation helpers       |
| Compiler validator  | Classify boolean slots, emit diagnostics, produce safe autofix suggestions | parser output, validation types             |
| Language service    | Surface the same diagnostics and quick-fix hints in the editor             | compiler diagnostics                        |
| Runtime guard       | Refuse dangerous literal-string conditions at execution time               | CEL evaluator, routing executor             |
| Knowledge surfaces  | Keep examples, prompts, and docs aligned with the runtime truth            | Studio/Arch prompt libraries, docs          |

## 6. File-Level Change Map

### Modified Files

| File                                                                  | Change Description                                 | Risk   |
| --------------------------------------------------------------------- | -------------------------------------------------- | ------ |
| `apps/studio/src/components/agent-editor/sections/HandoffsEditor.tsx` | Route-type control and expression-focused labeling | Medium |
| `apps/studio/src/components/agent-detail/CoordinationSection.tsx`     | Inline route authoring updates                     | Medium |
| `apps/studio/src/components/abl/pickers/SimpleConstructModal.tsx`     | Expression-based construct defaults                | Low    |
| `apps/studio/src/components/abl/commands/SnippetGenerator.ts`         | Canonical `WHEN` snippet generation                | Low    |
| `apps/studio/src/lib/agent-canvas/dsl-updater.ts`                     | Raw-expression serialization for condition slots   | Medium |
| `apps/studio/src/lib/abl-serializers.ts`                              | Route-type aware serialization                     | Medium |
| `packages/i18n/locales/en/studio.json`                                | User-facing labels, placeholders, route-type copy  | Low    |
| `packages/compiler/src/platform/ir/validate-field-refs.ts`            | Shared boolean-slot validation hook-in             | High   |
| `packages/compiler/src/platform/ir/validate-coordination-config.ts`   | Condition-slot diagnostics for coordination blocks | High   |
| `packages/compiler/src/platform/ir/validation-types.ts`               | New diagnostics / autofix metadata                 | Medium |
| `packages/compiler/src/platform/constructs/cel-evaluator.ts`          | Literal-string fail-closed behavior                | High   |
| `apps/runtime/src/services/execution/routing-executor.ts`             | Defensive routing behavior and trace emission      | High   |
| `packages/language-service/src/diagnostics.ts`                        | Editor-visible condition diagnostics               | Medium |
| `packages/language-service/src/docs.ts`                               | Updated authoring guidance / hover text            | Low    |

### New Files

| File                                                                    | Purpose                                                          | LOC Estimate |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `packages/compiler/src/platform/ir/validate-boolean-condition-slots.ts` | Shared condition-slot inventory, classification, and diagnostics | 250-400      |
| `packages/compiler/src/__tests__/boolean-condition-validation.test.ts`  | Cross-slot validation matrix                                     | 150-250      |
| `apps/studio/src/components/agent-detail/RouteTypeSelector.tsx`         | Shared Intent / Expression / Fallback chooser                    | 120-220      |

## 7. Implementation Phases

### Phase 0: Authoring Cleanup (Completed)

**Goal**: Stop teaching the broken quoted-string mental model in the highest-signal Studio and docs surfaces.

**Delivered in this change**:

1. Snippet and canvas serialization now emit raw `WHEN` expressions instead of auto-quoting them.
2. Studio labels and placeholders now say `Condition (expression)` and show expression examples.
3. Getting-started docs, Academy content, and Arch/Studio prompt templates were updated to use expression-based routing and `WHEN: true` fallback examples.

**Exit Criteria**:

- [x] No primary Studio authoring surface auto-generates `WHEN: "..."` for new handoff/delegate conditions
- [x] High-signal docs no longer claim that `WHEN` itself is semantic LLM reasoning
- [x] Catch-all prompt examples use `WHEN: true`

### Phase 1: Shared Boolean-Condition Validation Foundation

**Goal**: Add one shared compiler validator that classifies and validates every boolean-condition slot consistently.

**Tasks**:

1.1. Add `validate-boolean-condition-slots.ts` with a central inventory of boolean slots:

- coordination handoffs / delegates
- escalation triggers
- completion conditions
- flow checks / `IF`-style condition slots
- routing rules
- behavior profile `WHEN`

  1.2. Add new diagnostic categories to `validation-types.ts`:

- top-level literal string in boolean slot
- likely plain-English sentence instead of expression
- safe autofix available for `"true"` / `"false"`
- optional non-blocking hint for deterministic expression routes

  1.3. Wire the shared validator into `validate-field-refs.ts` and `validate-coordination-config.ts`.

  1.4. Add autofix suggestions:

- `"true"` -> `true`
- `"false"` -> `false`
- quoted prose -> hard error, no autofix
- bare plain-English sentence -> hard error, no autofix

  1.5. Keep identifier-only expressions such as `needs_specialist` valid.

**Exit Criteria**:

- [ ] Compiler emits deterministic diagnostics for the five canonical cases:
  - `WHEN: "true"`
  - `WHEN: "false"`
  - `WHEN: "user wants to book or create a reservation"`
  - `WHEN: user wants to book or create a reservation`
  - `WHEN: input contains "lookup"`
- [ ] `validateFieldReferences()` and `validateCoordinationConfig()` both exercise the shared validator instead of duplicating rules
- [ ] Existing valid shorthand (`needs_specialist`) stays warning-free
- [ ] Diagnostic payloads expose enough metadata for editor quick fixes

**Test Strategy**:

- Unit: new validator matrix in `packages/compiler/src/__tests__/boolean-condition-validation.test.ts`
- Integration: extend `packages/compiler/src/__tests__/validate-field-refs.test.ts`
- Integration: extend `packages/compiler/src/__tests__/validate-coordination-config.test.ts`

**Rollback**: Remove the validator hook-in and retain the Phase 0 copy cleanup while keeping existing runtime behavior.

### Phase 2: Runtime Fail-Closed Compatibility Guard

**Goal**: Prevent deployed legacy string-literal conditions from acting as truthy first-match routes.

**Tasks**:

2.1. Introduce a condition-shape guard before boolean coercion in `cel-evaluator.ts`.

2.2. Compatibility behavior:

- top-level `"true"` -> normalize to `true` and emit deprecation trace
- top-level `"false"` -> normalize to `false` and emit deprecation trace
- any other top-level string literal -> return `false` and emit warning/error trace
- non-literal strings produced by valid expressions remain untouched

  2.3. Update `routing-executor.ts` to surface a sanitized routing diagnostic when a legacy literal-string condition is suppressed.

  2.4. Ensure deterministic routing traces still distinguish zero-LLM route matches from classifier-driven routing.

**Exit Criteria**:

- [ ] Runtime no longer treats `"user wants to book"` as truthy
- [ ] Runtime still accepts `true`, `false`, and identifier-only boolean expressions
- [ ] A suppressed legacy literal-string route produces a traceable warning without leaking internal remediation text to users
- [ ] Canonical fallback `WHEN: true` continues to work in routing and behavior-profile contexts

**Test Strategy**:

- Unit: extend `packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts`
- Runtime unit/integration: add routing coverage in `apps/runtime/src/__tests__/routing/routing-conditions.test.ts` (or nearest routing-condition suite)

**Rollback**: Revert the evaluator guard while keeping compiler validation in place.

### Phase 3: Studio Route-Type Authoring Model

**Goal**: Replace the ambiguous freeform-first handoff authoring experience with explicit route types.

**Tasks**:

3.1. Add a shared `RouteTypeSelector` with:

- `Intent route`
- `Expression route`
- `Fallback route`

  3.2. Expression route:

- label: `Condition (expression)`
- placeholder examples such as `input contains "lookup"`
- inline guidance that prose is not valid

  3.3. Intent route:

- guided fields for category (and optional confidence threshold if present)
- generated expression output such as `intent.category == "billing"`

  3.4. Fallback route:

- no freeform condition field
- serializes directly to `WHEN: true`
- visually marked as final/default route

  3.5. Apply the same model to:

- Agent editor handoffs
- Coordination section handoffs
- canvas relationship creation/editing
- snippet/construct insertion

  3.6. Add migration logic so existing handoff strings hydrate into the closest route type:

- `true` -> fallback
- `intent.category == ...` -> intent route
- everything else -> expression route with diagnostics preserved

**Exit Criteria**:

- [ ] Users can create Intent / Expression / Fallback routes without typing raw `WHEN` first
- [ ] No Studio surface suggests `true`, `"true"`, or prose as interchangeable
- [ ] Fallback routes are always explicit and serialize to `WHEN: true`
- [ ] Existing valid handoff expressions round-trip without mutation

**Test Strategy**:

- Component: extend `apps/studio/src/__tests__/components/coordination-section.test.tsx`
- Component: extend `apps/studio/src/components/abl/commands/SnippetGenerator.test.ts`
- Integration: extend `apps/studio/src/__tests__/dsl-updater.test.ts`

**Rollback**: Hide the new selector and fall back to expression-only freeform authoring while keeping the new compiler/runtime protections.

### Phase 4: Generator, Language-Service, and Docs Completion

**Goal**: Align the rest of the ecosystem with the new contract so the product stops reintroducing the same bug.

**Tasks**:

4.1. Update Arch/Studio build prompts, knowledge cards, construct catalogs, and handbook references to use expression-based examples only.

4.2. Update language-service docs/hover snippets so `WHEN` documentation explicitly says “boolean expression.”

4.3. Sweep remaining user-facing docs and examples outside the Phase 0 cleanup set.

4.4. Add a regression inventory for known anti-patterns:

- `WHEN: "true"`
- `WHEN: "user asks about billing"`
- `WHEN: user asks about billing`
- docs claiming the LLM directly interprets `WHEN`

**Exit Criteria**:

- [ ] No primary prompt/generator surface emits `WHEN: "true"` or quoted prose conditions
- [ ] No primary docs surface claims `WHEN` is plain-English LLM routing
- [ ] Language-service hover/docs use the same expression-first explanation as Studio UI

**Test Strategy**:

- Prompt/library snapshot tests where present
- Search-based manual verification for known anti-pattern strings

**Rollback**: Revert doc/prompt updates independently; runtime/compiler safety remains intact.

## 8. Wiring Checklist

- [ ] Shared compiler validator exported and invoked from existing validation entry points
- [ ] Validation codes added to `validation-types.ts` and surfaced through language-service diagnostics
- [ ] Runtime evaluator guard called by all routing/condition execution paths
- [ ] Studio route-type selector wired into both handoff authoring surfaces
- [ ] Canvas DSL updater and snippet generator emit canonical condition syntax
- [ ] i18n strings added for route-type labels, helper text, and validation messages
- [ ] New tests added to the nearest existing suites rather than creating isolated one-off harnesses

## 9. Cross-Phase Concerns

### Compatibility

- Existing compiled configs with `WHEN: "true"` or `WHEN: "false"` should continue to behave via normalization during the compatibility window.
- Existing compiled configs with other literal-string conditions should fail closed at runtime and produce traces.
- New authoring should never generate those legacy patterns again.

### Telemetry

- Count suppressed literal-string conditions in traces/logs so we can measure rollout risk.
- Add one searchable warning shape for “literal string used as boolean condition.”

### UX Copy

- Prefer “Condition (expression)” instead of “When.”
- Never describe plain-English text as a valid `WHEN`.
- Be explicit that semantic routing requires an intent/classification field.

## 10. Acceptance Criteria

- [ ] A user can author a fallback route without typing a raw expression and it serializes to `WHEN: true`
- [ ] `WHEN: "true"` and `WHEN: "false"` are normalized safely, not treated as generic truthy strings
- [ ] `WHEN: "user wants to book or create a reservation"` is blocked by compiler validation and suppressed by runtime compatibility logic
- [ ] `WHEN: user wants to book or create a reservation` is diagnosed as plain-English prose, not semantic routing
- [ ] `WHEN: input contains "lookup"` remains valid deterministic routing with no LLM requirement
- [ ] Studio, compiler, runtime, docs, and generator prompts all present the same condition model

## 11. Open Questions

1. Should identifier-only expressions such as `needs_specialist` remain first-class in Studio UI, or should the editor normalize them to `needs_specialist == true` on save?
2. Do we want a dedicated quick fix that converts a quoted prose handoff into an Intent route scaffold, or is a hard error with guidance sufficient for v1?
3. Should behavior-profile default detection migrate fully to `WHEN: true`, or continue to tolerate empty `WHEN` indefinitely?
