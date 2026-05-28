# Entity Extraction & Semantic Entities — Low-Level Design

**Feature**: Entity Extraction & Semantic Entities
**Status**: POST-IMPL SYNC COMPLETE
**Last Updated**: 2026-04-15
**Feature Spec**: [docs/features/entity-extraction.md](../features/entity-extraction.md)
**Test Spec**: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)

---

## Implementation Structure

### Core Files

| File                                                           | Purpose                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`                       | AST types for explicit entities, `entityRef`, and `sensitive` metadata                      |
| `packages/core/src/parser/agent-based-parser.ts`               | `ENTITIES`, `ENTITY_REF`, `MAX_RETRIES`, `SENSITIVE`, and validation-process parsing        |
| `packages/compiler/src/platform/ir/schema.ts`                  | `EntityDefinitionIR`, `entity_ref`, `synonyms`, validation metadata, observation-related IR |
| `packages/compiler/src/platform/ir/compiler.ts`                | Entity lowering, `ENTITY_REF` inheritance, inline system entities, NLU-to-GATHER merge      |
| `packages/compiler/src/platform/ir/system-entities.ts`         | Built-in system entity registry                                                             |
| `apps/runtime/src/services/execution/extraction-validation.ts` | Shared extracted-value validation and enum normalization                                    |
| `apps/runtime/src/services/execution/entity-observations.ts`   | Observation store types, immutable helpers, and sensitive masking                           |
| `apps/runtime/src/services/execution/intrinsic-validation.ts`  | Runtime intrinsic validation across supported entity types                                  |
| `apps/runtime/src/services/execution/entity-pipeline.ts`       | Runtime observation pipeline for `ir.entities`                                              |
| `apps/runtime/src/services/execution/slot-assignment.ts`       | Clarification/disambiguation helpers for entity-backed GATHER slots                         |
| `apps/runtime/src/services/execution/entity-trace-events.ts`   | Entity lifecycle trace-event builders                                                       |
| `apps/runtime/src/services/execution/reasoning-executor.ts`    | Reasoning-path observation storage + trace emission                                         |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Flow-path observation storage + validation parity fixes                                     |
| `apps/runtime/src/services/session/types.ts`                   | Serialized observation storage on session data                                              |
| `apps/runtime/src/services/execution/types.ts`                 | Runtime observation typing                                                                  |

### Test Files

| File                                                                      | Type        | Focus                                                               |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `packages/core/src/__tests__/parser-entities-section.test.ts`             | unit        | `ENTITIES`, `ENTITY_REF`, flow gather parsing                       |
| `packages/core/src/__tests__/parser-gather-gap-fixes.test.ts`             | unit        | `MAX_RETRIES`, legacy `SENSITIVE` parsing                           |
| `packages/compiler/src/__tests__/entities-compilation.test.ts`            | unit        | canonical entity registry, `ENTITY_REF`, system entities            |
| `packages/compiler/src/__tests__/entity-extraction-gap-fixes.test.ts`     | unit        | validation metadata and compile-time merge parity                   |
| `packages/compiler/src/__tests__/system-entities.test.ts`                 | unit        | built-in system entity definitions                                  |
| `apps/runtime/src/__tests__/entity-observations.test.ts`                  | unit        | observation lifecycle                                               |
| `apps/runtime/src/__tests__/intrinsic-validation.test.ts`                 | unit        | intrinsic validation                                                |
| `apps/runtime/src/__tests__/entity-pipeline.test.ts`                      | unit        | runtime observation extraction                                      |
| `apps/runtime/src/__tests__/slot-assignment.test.ts`                      | unit        | clarification / disambiguation helpers                              |
| `apps/runtime/src/__tests__/entity-trace-events.test.ts`                  | unit        | entity lifecycle traces                                             |
| `apps/runtime/src/__tests__/extraction/gather-lookup-integration.test.ts` | integration | runtime gather integration still works with enriched field metadata |

---

## Module T-1: Parser & AST Surface

### Responsibilities

- parse explicit `ENTITIES:` definitions
- parse `ENTITY_REF` on top-level and flow GATHER fields
- preserve compatibility with legacy `NLU.entities`
- parse `SENSITIVE`, `MAX_RETRIES`, and `VALIDATION_PROCESS`

### Key Notes

- parser allows some combinations that the compiler later rejects or normalizes
- `entityRef` is retained on AST gather fields so the compiler can inherit semantics later

---

## Module T-2: Compiler Entity Registry

### Responsibilities

- create canonical `AgentIR.entities`
- merge explicit `ENTITIES`, lowered `NLU.entities`, and anonymous inline system entities
- add `source` provenance (`explicit`, `nlu_lowered`, `gather_inline`, `system`)
- enrich GATHER fields with enum values, synonyms, validation metadata, and inherited types

### Key Rules

1. Explicit `ENTITIES` definitions win over legacy `NLU.entities`.
2. Duplicate entity names across explicit and legacy surfaces raise compile errors.
3. `ENTITY_REF` inherits entity semantics but GATHER keeps collection-policy fields.
4. Inline GATHER system types create anonymous entities for canonical registry coverage.

---

## Module T-3: Extraction Validation Parity

### Responsibilities

- normalize enum values consistently
- validate extracted values across reasoning and flow call sites
- preserve validation metadata such as `retry_prompt`, `max_retries`, and `validation_process`

### Key Files

- `apps/runtime/src/services/execution/extraction-validation.ts`
- `apps/runtime/src/services/execution/reasoning-executor.ts`
- `apps/runtime/src/services/execution/flow-step-executor.ts`

### Post-Implementation Result

The parity gaps from the April gap-fix plan are mostly closed on the compiler side and substantially improved on the runtime side. Existing GATHER flows remain the system of record for final slot commitment.

---

## Module T-4: Runtime Observation Pipeline

### Responsibilities

- run per-turn observation extraction for `ir.entities`
- normalize and intrinsically validate extracted values
- store observation results on the session
- emit sensitivity-aware trace events

### Runtime Shape

```text
current turn input
  -> extractEntityObservations()
  -> ObservationSet
  -> session.observations
  -> entity_observation / entity_validation_intrinsic traces
```

### Current Limitation

`entity-pipeline.ts` currently uses the JS extraction tier only. That keeps the first slice small and safe, but it means the new observation layer is not yet feature-complete for non-JS entity types.

---

## Module T-5: Slot Assignment & Lifecycle Tracing

### Responsibilities

- provide reusable helpers for:
  - direct assignment
  - clarification when one slot has multiple observed candidates
  - disambiguation when multiple slots share one entity reference
- provide trace builders for future slot-assignment, business-validation, and commitment events

### Post-Implementation Result

The helpers and trace builders are implemented and tested, but runtime executors currently consume only the observation and intrinsic-validation trace builders. Live slot-assignment wiring remains a follow-up.

---

## Post-Implementation Notes

### What Shipped

- canonical parser/compiler semantic entity support
- system entity definitions
- compile-time NLU-to-GATHER enrichment
- utterance-scoped observation storage
- intrinsic validation and masked trace events

### What Did Not Fully Ship

- observation-driven slot assignment
- commitment tracing
- multi-tier extraction inside the new observation pipeline
- public API E2E coverage

---

## Known Gaps

| ID      | Description                                                                                         | Severity | Status |
| ------- | --------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | New observation pipeline covers JS-extractable entity types only                                    | High     | Open   |
| GAP-002 | `slot-assignment.ts` is not wired into live GATHER execution                                        | High     | Open   |
| GAP-003 | `traceSlotAssignment`, `traceSlotClarification`, and commitment/business-validation traces are idle | High     | Open   |
| GAP-004 | No dedicated public API E2E for semantic entities                                                   | High     | Open   |
| GAP-005 | Observation storage is runtime-only and not yet exposed as a first-class prompt/tool input          | Medium   | Open   |

---

## Exit Criteria Snapshot

### Met

- parser/compiler support for canonical entities
- validation metadata and gap-fix wiring
- observation storage + masking traces
- unit coverage for all new modules

### Remaining

- wire observation-driven slot assignment into live gather flow
- add at least one public API E2E scenario
- decide whether to expand the observation pipeline beyond the JS extraction tier
