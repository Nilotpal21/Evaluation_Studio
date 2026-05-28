# LLD / Implementation Plan: Bruce Remaining Gap Closure

**Source plan**: `docs/plans/2026-04-18-bruce-partial-items-slice-plan.md`
**Audit inputs**:

- `docs/sdlc-logs/bruce-partial-items/slice-5-pr-review-round-*.md`
- `docs/sdlc-logs/bruce-partial-items/slice-6-pr-review-round-4.md`
- `docs/features/sub-features/pii-detection-enhancements.md`

**JIRA parent**: `ABLP-409`
**Status**: DRAFT
**Last Updated**: 2026-04-19

---

## 1. Objective

Close the remaining Bruce gaps without baking in future-hostile semantics or allowing Studio to keep silently dropping authored metadata.

This plan assumes the product is still in **Dev / QA**:

- authoring-time warnings are acceptable
- save-blocking Studio errors are acceptable when the editor cannot preserve semantics
- DSL and project-setting migrations are acceptable when the guidance is explicit
- runtime contracts still need to stay clean and future-ready

Success requires:

- handoff failure behavior is defined for real handoff phases instead of copied from delegate semantics
- `EXPECT_RETURN` is the clearer preferred authored form while `RETURN` remains backward compatible
- unsupported visual-editor cases fail fast instead of silently round-tripping away metadata
- Studio gains one canonical gather metadata model instead of more one-off fields
- DB-loaded guardrail providers stop expiring due to time alone and reload only via explicit invalidation
- Kore/XO entity migration hooks move toward config-driven mapping, not more hardcoded alias tables
- parked work stays explicitly documented as debt, not mistaken for completed contract support

---

## 2. Change Classification

### Persona Swim Lanes Touched

- **DSL author**: sees clearer compile-time warnings, deprecations, and editor compatibility errors
- **Studio author**: gets fail-fast guidance when the visual editor cannot safely preserve authored metadata
- **Runtime operator**: gets deterministic handoff fallback behavior and explicit provider cache invalidation semantics
- **Platform developer**: owns the compiler/runtime/Studio contract alignment and migration compatibility lanes

### Cross-Cutting Gate

- Contracts & Compatibility

### Primary Review Concerns

- Execution & Orchestration
- Import / Export / Round-Trip Fidelity
- Studio Authoring Safety
- Guardrails / Provider Lifecycle
- Docs, Examples, and Compatibility Messaging

### Secondary Review Concerns

- Traceability & Observability
- Rollout / Rollback Safety
- Testing Integrity & Wiring Verification

---

## 3. Decision Freeze For This Plan

This plan intentionally revises several entries from the 2026-04-18 partial-items slice plan so the remaining work lands on stable semantics.

| Item                                      | Prior lock                    | Revised implementation decision                                                                                                                           |
| ----------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.5 Streaming evaluator full buffer       | Parked                        | Stay parked. Document current streaming evaluation as heuristic / partial until explicitly un-parked. No hidden "full buffer" claim.                      |
| 10.1 Handoff `ON_FAILURE`                 | Mirror DelegateConfig         | Reuse the same action vocabulary only. Do **not** promise delegate-identical semantics. Handoff needs phase-aware behavior.                               |
| 3.2 `tool:*:before` recall events         | Blocking                      | Keep blocked. Make the block explicit in diagnostics and Studio surfaces.                                                                                 |
| 1.2 Tool confirmation lint                | Warning only                  | Keep warning-only at compiler/runtime contract level. Surface prominently in Studio; do not auto-default runtime confirmation.                            |
| HANDOFF `EXPECT_RETURN` rename            | One-release alias deprecation | Keep both keys parser-compatible. Prefer `EXPECT_RETURN` in docs and Studio because it is clearer; do not deprecate either key yet.                       |
| 5.6 Provider registry TTL                 | DB-loaded = session-permanent | Implement as "no time-based eviction for DB-loaded providers; explicit invalidation only." Keep tenant reload throttling separate from registry lifetime. |
| Slice 5 Studio `PII_TYPE` round-trip      | Separate follow-up            | Fold into a broader Studio gather metadata slice. `PII_TYPE` alone is not the right unit.                                                                 |
| Slice 6 visual editor drops all semantics | Informational follow-up       | Treat as a first-class gap. Add fail-fast protection immediately, then canonicalize the Studio metadata model.                                            |
| Slice 5 Kore entity mapping               | Separate follow-up slice      | Keep separate, but make it config-driven and dependent on the canonical gather metadata model.                                                            |

---

## 4. Implementation Strategy

### Guiding Rules

1. Separate **authoring-time strictness** from **runtime semantic changes**. Dev / QA allows stronger Studio guardrails, but it does not justify muddy runtime contracts.
2. Land fail-fast protections before expanding the visual editor, so authors stop losing metadata immediately.
3. Do not add another one-off Studio field for `PII_TYPE`. Canonicalize gather metadata once, then layer focused UI on top.
4. Keep compatibility support narrow and explicit. Both `EXPECT_RETURN` and `RETURN` stay parse-compatible while authored examples and Studio guidance prefer the clearer `EXPECT_RETURN` form.
5. Handoff timeout behavior and handoff failure behavior are different concerns. Preserve `on_timeout` as a separate contract.
6. Cache lifetime and reload throttling are different concerns. Avoid wording that collapses them into a single "TTL" story.
7. Every phase closes with wiring proof plus regression coverage. Code existence alone is not enough.

### Recommended Execution Order

1. Diagnostics and compatibility lane hardening
2. Handoff failure contract
3. Studio fail-fast protection against metadata loss
4. Canonical Studio gather metadata round-trip
5. Provider registry invalidation semantics
6. Config-driven Kore / XO mapping follow-up
7. Docs, status, and parked-debt sync

---

## 5. Phase Plan

## Phase 1: Diagnostics, Warnings, and Compatibility Lane

### Scope

Make the remaining unsupported or risky constructs visible to authors now, without silently changing runtime behavior.

### Target Files

- `packages/core/src/parser/agent-based-parser.ts`
- `packages/core/src/types/agent-based.ts`
- `packages/compiler/src/platform/ir/validation-types.ts`
- `packages/compiler/src/platform/ir/validate-ir.ts`
- `packages/compiler/src/platform/ir/validate-coordination-config.ts`
- `packages/compiler/src/platform/ir/recall-validation.ts`
- `apps/studio/src/lib/abl/project-aware-compile.ts`
- `apps/studio/src/app/api/projects/[id]/agents/[agentId]/compile/route.ts`
- `apps/studio/src/app/api/abl/diagnostics/route.ts`
- `apps/studio/src/components/agent-editor/AgentEditorBanners.tsx`
- `apps/studio/src/components/agents/AgentDetailPage.tsx`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `docs/reference/STATUS.md`

### Tasks

1. Lock parser compatibility so both `EXPECT_RETURN` and `RETURN` continue to work while docs and Studio guidance prefer `EXPECT_RETURN`.
2. Add a compiler warning when a tool advertises `hints.side_effects: true` but no explicit confirmation policy is configured.
3. Keep `tool:*:before` blocked and attach an explicit diagnostic code/message explaining that recall can mutate context before dispatch.
4. Ensure Studio compile and diagnostics routes preserve and surface these warnings as first-class author feedback.
5. Update reference docs and status docs so compatibility and deprecation messaging matches actual behavior.

### Exit Criteria

- `EXPECT_RETURN` and `RETURN` both continue to compile without forced migration.
- Public docs and Studio guidance consistently present `EXPECT_RETURN` as the clearer authored form.
- Missing tool confirmation produces a warning, not a hidden runtime default.
- `tool:*:before` fails deterministically with a clear diagnostic instead of a vague unsupported-state error.
- Both the visual editor and raw ABL editor surface the new warnings through existing compile-message channels.

### Notes

- This phase intentionally does **not** deprecate either handoff return key.
- This phase intentionally does **not** auto-default confirmation behavior at runtime.

---

## Phase 2: Handoff `ON_FAILURE` Contract Hardening

### Scope

Add `ON_FAILURE` for handoff in a way that matches actual handoff lifecycle phases rather than copying delegate semantics verbatim.

### Target Files

- `packages/core/src/types/agent-based.ts`
- `packages/core/src/parser/agent-based-parser.ts`
- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/validation-types.ts`
- `packages/compiler/src/platform/ir/validate-coordination-config.ts`
- `apps/runtime/src/services/execution/routing-executor.ts`
- `apps/runtime/src/__tests__/execution/`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `docs/reference/ABL_SPEC.md`

### Tasks

1. Extend the DSL, parsed types, and IR to support handoff `on_failure`.
2. Reuse the same action vocabulary as delegate (`continue`, `escalate`, `respond:<message>`), but define handoff-specific runtime semantics.
3. Split handoff failure handling by phase:
   - pre-transfer validation / setup failure -> `on_failure`
   - dispatch failure before transfer acceptance -> `on_failure`
   - timeout after handoff has been accepted -> existing `on_timeout`
   - downstream child-agent execution failure after accepted transfer -> not parent `on_failure`
4. Emit trace coverage for which phase triggered the fallback so later debugging is deterministic.
5. Document the distinction between `on_failure` and `on_timeout` clearly in ABL references.

### Exit Criteria

- Handoff supports `on_failure` end-to-end in parser, compiler, IR, and runtime.
- Docs no longer claim "same semantics as delegate."
- Tests cover pre-transfer failure, dispatch failure, accepted-handoff timeout, and non-parent-owned downstream failure.
- `on_timeout` remains a separate contract and is not silently folded into `on_failure`.

### Notes

- This phase should not change existing successful handoff flows.
- If runtime behavior differs by remote-vs-local handoff path, the difference must be explicit and tested.

---

## Phase 3: Studio Fail-Fast Protection For Lossy Visual Editing

### Scope

Stop the visual editor from silently dropping authored gather metadata before the canonical metadata model lands.

### Target Files

- `apps/studio/src/store/agent-detail-store.ts`
- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/lib/abl/project-aware-compile.ts`
- `apps/studio/src/components/agent-editor/AgentEditor.tsx`
- `apps/studio/src/components/agent-editor/AgentEditorBanners.tsx`
- `apps/studio/src/components/agents/AgentDetailPage.tsx`
- `apps/studio/src/hooks/useAgentIR.ts`
- `apps/studio/src/__tests__/`

### Tasks

1. Add a Studio-side compatibility analyzer for gather metadata the visual editor cannot round-trip safely.
2. Treat the following as incompatible until Phase 4 lands:
   - `pii_type`
   - `semantics` keys other than `lookup`
   - any future gather metadata the current `GatherFieldData` model cannot represent losslessly
3. Show a prominent warning or save-blocking error in the visual editor when incompatible metadata is present.
4. Preserve a clear escape hatch back to raw DSL editing so Dev / QA authors can continue moving.
5. Make the failure mode explicit: "this editor cannot preserve these fields" instead of generic compile noise.

### Exit Criteria

- Opening and re-saving an agent through the visual editor can no longer silently strip incompatible gather metadata.
- Studio points authors at raw DSL when the visual editor is not safe.
- Compatibility detection is test-backed against compiled IR, not just optimistic UI state.

### Notes

- This phase is intentionally stricter in Studio than in raw DSL because the visual editor is the lossy surface.
- Save-blocking is acceptable here because the risk is deterministic metadata loss.

---

## Phase 4: Canonical Studio Gather Metadata Model and Round-Trip

### Scope

Replace the current piecemeal Studio gather-field shape with one canonical metadata model that can preserve current and near-future gather semantics.

### Target Files

- `apps/studio/src/store/agent-detail-store.ts`
- `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`
- `apps/studio/src/components/agent-editor/types.ts`
- `apps/studio/src/lib/abl-serializers.ts`
- `apps/studio/src/__tests__/components/`
- `apps/studio/src/__tests__/stores/`

### Tasks

1. Refactor `GatherFieldData` so Studio has an explicit metadata shape instead of scattered one-off fields.
2. Represent gather metadata in a way that can round-trip:
   - `lookup`
   - `pii_type`
   - existing sensitivity / mask / transient settings
   - current known `semantics` keys such as `format`, `locale`, `unit`, `components`, and `kore_entity_type`
   - future keys without dropping them on load/save
3. Hydrate the canonical metadata object from IR in `parseGather()`.
4. Serialize the canonical metadata object back to DSL in `serializeGatherToABL()`.
5. Expose `PII_TYPE` as first-class UI where it is already a committed product concept, while preserving less-common metadata even if the UI stays minimal for now.
6. Add round-trip tests that prove a visual-editor edit does not delete untouched metadata.

### Exit Criteria

- `PII_TYPE` round-trips through Studio.
- Non-lookup `semantics` no longer disappear during visual-editor save.
- The visual editor can preserve metadata it does not fully expose yet.
- The separate Slice 5 `PII_TYPE` and Slice 6 "all semantics dropped" follow-ups collapse into one resolved architecture slice.

### Notes

- The future-ready requirement here is **lossless preservation first**, rich editing second.
- Avoid a design that requires adding a new top-level Studio field for every future gather semantic.

---

## Phase 5: Provider Registry Lifetime and Explicit Invalidation

### Scope

Remove time-based eviction for DB-loaded guardrail providers while preserving bounded tenant reload behavior and explicit config-change invalidation.

### Target Files

- `packages/compiler/src/platform/guardrails/provider-registry.ts`
- `apps/runtime/src/services/guardrails/pipeline-factory.ts`
- `apps/runtime/src/routes/project-runtime-config.ts`
- `apps/runtime/src/__tests__/execution/guardrails/`
- `docs/reference/STATUS.md`

### Tasks

1. Separate provider-registry entry lifetime from tenant reload throttling.
2. Mark DB-loaded providers as non-expiring inside the tenant registry.
3. Keep a bounded, explicit invalidation path for project/provider config changes so the next use reloads fresh data.
4. Add tests that prove:
   - DB-loaded providers do not expire only because time passed
   - invalidation reloads the provider set
   - tenant scoping remains intact
5. Update docs/status text to say "explicit invalidation" rather than "session-permanent" if the latter overstates reality.

### Exit Criteria

- Registry behavior no longer depends on a time-based TTL for DB-loaded providers.
- Config changes can force a deterministic reload.
- Multi-tenant isolation and bounded caches remain intact.

### Notes

- The existing tenant load cache can remain bounded; it is a reload-throttling mechanism, not the source-of-truth lifetime rule.

---

## Phase 6: Config-Driven Kore / XO Entity Mapping Follow-Up

### Scope

Move the legacy XO/Kore alias mapping story toward project-config-driven PII and gather semantics behavior instead of another permanent hardcoded table.

### Target Files

- `packages/compiler/src/platform/utils/kore-entity-map.ts`
- `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts`
- `apps/runtime/src/routes/project-runtime-config.ts`
- `docs/features/sub-features/pii-detection-enhancements.md`
- `apps/runtime/src/__tests__/`
- `packages/compiler/src/__tests__/`

### Tasks

1. Keep the existing built-in Kore mapping as a migration seed, not the long-term customization layer.
2. Extend project runtime config to carry configurable gather-exemption / entity-to-PII mappings.
3. Teach `resolveGatherExemptions()` to consult config-driven overrides before falling back to hardcoded defaults.
4. Ensure the canonical Studio metadata model from Phase 4 can preserve `kore_entity_type` and related semantics without special-case loss.
5. Add tests that prove project config can override or extend built-in mapping behavior safely.

### Exit Criteria

- Kore / XO follow-up work no longer depends on growing another hardcoded alias table.
- Project-level config can influence gather exemption and mapping behavior in a bounded, test-backed way.
- The mapping story is compatible with the broader `PIIType = string` roadmap.

### Notes

- This phase should start only after Phase 4, otherwise Studio remains a lossy surface for the metadata it needs to preserve.

---

## Phase 7: Docs, Status, and Parked-Debt Sync

### Scope

Finish the remaining Bruce gap closure with accurate contract docs, plan status, and explicit parked-debt framing.

### Target Files

- `docs/plans/2026-04-18-bruce-partial-items-slice-plan.md`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `docs/reference/ABL_SPEC.md`
- `docs/reference/STATUS.md`
- `docs/sdlc-logs/bruce-partial-items/`

### Tasks

1. Mark which Bucket 1 and Bucket 2 items are closed by which phases in this plan.
2. Update status language so implemented compatibility aliases and Studio fail-fast behavior are reflected honestly.
3. Document the streaming evaluator buffer work as parked technical debt, not implied completion.
4. Capture any rollout notes for Dev / QA, especially where Studio now blocks unsafe visual saves.

### Exit Criteria

- No Bruce gap remains in a misleading "decided but status stale" state.
- Documentation matches actual parser, compiler, runtime, and Studio behavior.
- Parked items are explicitly labeled as debt with a known follow-up trigger.

---

## 6. Testing Expectations

This plan is not complete unless the remaining gaps are locked with tests at the correct layer.

### Required Coverage Shapes

- **Parser / compiler tests** for handoff return-key compatibility, tool confirmation lint, and blocked recall events
- **Runtime integration tests** for handoff `on_failure` phase behavior and provider invalidation behavior
- **Studio component / store tests** for visual-editor fail-fast behavior and gather metadata round-trip
- **Project-config integration tests** for config-driven gather exemption and entity mapping overrides

### Must-Verify Behaviors

- `EXPECT_RETURN` and `RETURN` both still work
- `EXPECT_RETURN` is the preferred authored form in docs and Studio guidance
- visual-editor save cannot silently remove `pii_type` or non-lookup semantics
- accepted handoff timeout does not incorrectly route through `on_failure`
- DB-loaded providers survive time passage but reload after explicit invalidation
- project config can influence mapping behavior without cross-tenant leakage

---

## 7. Explicit Non-Goals

- Implementing full-buffer streaming guardrail evaluation in this plan
- Removing `EXPECT_RETURN` parser compatibility
- Adding bespoke top-level Studio fields for every individual future gather semantic
- Treating handoff `on_failure` as a pure copy of delegate semantics
- Growing the Kore / XO migration story via another permanently hardcoded alias table

---

## 8. Recommended Delivery Shape

To keep blast radius manageable, the recommended shipping sequence is:

1. Phase 1 alone
2. Phase 2 alone
3. Phase 3 alone
4. Phase 4 alone
5. Phase 5 alone
6. Phase 6 alone
7. Phase 7 as part of the final sync pass

This yields one fast safety lane first, then one runtime semantic slice, then the Studio architecture closure, then the provider/mapping follow-ups.
