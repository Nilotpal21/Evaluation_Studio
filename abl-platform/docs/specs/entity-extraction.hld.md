# Entity Extraction & Semantic Entities — High-Level Design

**Feature**: Entity Extraction & Semantic Entities
**Status**: APPROVED
**Last Updated**: 2026-04-15
**Feature Spec**: [docs/features/entity-extraction.md](../features/entity-extraction.md)
**Test Spec**: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)
**Parent Feature**: [docs/features/nlu.md](../features/nlu.md)

---

## 1. Problem Statement

Entity semantics were previously fragmented across `NLU.entities`, inline GATHER field types, and multiple runtime extraction paths. That fragmentation caused three classes of issues:

1. **Definition drift**: entity values, synonyms, sensitivity flags, and validation metadata could be declared in one place and silently lost in another.
2. **Runtime inconsistency**: only some extraction paths normalized enums and validated values consistently.
3. **Missing lifecycle model**: runtime had no first-class observation layer to represent values seen in the current utterance separately from values committed to session state.

### Post-Implementation Notes (2026-04-15)

- Canonical documentation for semantic entities now lives outside `docs/superpowers` in the feature, testing, HLD, and LLD docs linked above.
- Parser + compiler support for `ENTITIES`, `ENTITY_REF`, system entities, and NLU-to-GATHER merge shipped successfully.
- Runtime now stores utterance-scoped observations and emits masked observation/intrinsic-validation traces in both reasoning and flow execution.
- The feature is still ALPHA because the new observation layer is only partially wired: slot-assignment helpers are not connected end-to-end, and the entity pipeline currently executes the JS tier only.

---

## Implementation Status

| Component                                 | Status   | Details                                                                                   |
| ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `ENTITIES` parser                         | DONE     | `packages/core/src/parser/agent-based-parser.ts` parses explicit entities and metadata    |
| `ENTITY_REF` parser                       | DONE     | Top-level and flow GATHER fields parse `ENTITY_REF`                                       |
| Canonical `ir.entities` registry          | DONE     | `packages/compiler/src/platform/ir/compiler.ts` lowers explicit, NLU, and inline entities |
| System entity definitions                 | DONE     | `packages/compiler/src/platform/ir/system-entities.ts` defines 6 intrinsic system types   |
| NLU-to-GATHER enrichment                  | DONE     | Enum values, synonyms, validation metadata, and sensitivity are merged compile-time       |
| Validation parity fixes                   | DONE     | Shared validation/normalization wired through major extraction call sites                 |
| Runtime observation storage               | DONE     | `session.observations` added for utterance-scoped observation sets                        |
| Observation / intrinsic-validation traces | DONE     | Reasoning and flow emit masked observation and intrinsic-validation trace events          |
| Slot assignment helpers                   | DONE     | Pure clarification/disambiguation helpers implemented and unit-tested                     |
| Live observation-to-slot wiring           | PARTIAL  | Helpers exist but are not connected to runtime gather commitment                          |
| Multi-tier entity pipeline                | PARTIAL  | New observation pipeline currently covers JS-extractable entity types only                |
| Public API E2E                            | NOT IMPL | No dedicated HTTP / WebSocket E2E yet                                                     |

---

## 2. Alternatives Considered

### Alternative A: Keep `NLU.entities` + GATHER duplication

**Description**: Continue treating `NLU.entities` and GATHER field types as separate, partially overlapping systems.

**Pros**: Minimal code churn, no new top-level DSL constructs.

**Cons**: Preserves duplicated semantics, inconsistent validation, and confusing authoring model.

### Alternative B: Immediate full unification with observation-driven slot commitment

**Description**: Introduce `ENTITIES`, `ENTITY_REF`, observation storage, and full end-to-end automatic slot assignment in one release.

**Pros**: Cleanest target architecture with one canonical runtime flow.

**Cons**: Larger blast radius, harder rollout, and higher regression risk in GATHER behavior.

### Alternative C: Canonical registry + observation layer with backward-compatible staged runtime adoption (Selected)

**Description**: Ship parser/compiler unification and the observation layer first, preserve existing GATHER commitment flow, and add end-to-end slot wiring later.

**Pros**: Delivers immediate semantic cleanup and runtime visibility while controlling migration risk.

**Cons**: Leaves temporary architectural seams; some helper modules are present before they are fully wired.

### Recommendation

Alternative C was selected because it captures the semantic model and most of the runtime groundwork without forcing a flag-day migration of GATHER behavior.

---

## 3. Architecture

### Key Design Decisions

1. **Canonical registry**: all entity definitions lower into `AgentIR.entities`.
2. **Backward compatibility**: `NLU.entities` still compiles, but explicit `ENTITIES` is now the canonical authoring surface.
3. **Utterance-scoped observations**: runtime observations are reset each turn and are distinct from gathered session values.
4. **Collection-policy separation**: `ENTITY_REF` inherits entity semantics while GATHER retains prompts, retries, validation mode, and completion policy.
5. **Sensitivity-aware tracing**: traces mask sensitive values rather than leaking raw observation contents.

### Component Diagram

```text
ABL DSL
  ├─ ENTITIES
  ├─ NLU.entities (legacy)
  └─ GATHER / FLOW GATHER with ENTITY_REF
        │
        ▼
packages/core parser
        │
        ▼
packages/compiler IR compiler
  ├─ explicit entities
  ├─ lowered NLU entities
  ├─ inline system entities
  └─ GATHER enrichment / ENTITY_REF inheritance
        │
        ▼
AgentIR.entities + enriched GatherField metadata
        │
        ▼
apps/runtime execution
  ├─ entity-pipeline.ts
  ├─ entity-observations.ts
  ├─ intrinsic-validation.ts
  └─ extraction-validation.ts
        │
        ▼
session.observations + entity trace events
```

### Runtime Data Flow

1. A user turn arrives in reasoning or flow execution.
2. Runtime reads `session.agentIR.entities`.
3. `extractEntityObservations()` runs for JS-extractable entity definitions.
4. Observations are normalized and intrinsically validated.
5. `session.observations` is replaced for the current turn.
6. Observation and intrinsic-validation trace events are emitted.
7. Existing GATHER extraction/commitment flow continues independently using enriched field metadata.

---

## 4. Trust Boundaries & Risks

| Boundary                               | Risk                                                                             | Current Mitigation                                          |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| DSL authoring → parser/compiler        | Invalid or conflicting entity semantics                                          | Parser coverage + compiler conflict detection               |
| Compiler IR → runtime observation pass | Entity metadata present but not fully consumed                                   | Compile-time inheritance keeps existing GATHER flow working |
| Runtime observations → traces          | Sensitive values leaking into logs                                               | `maskSensitiveValue()` + sensitive trace-event handling     |
| Observation layer → future slot wiring | Helpers may drift from eventual runtime behavior if they remain unwired too long | Unit coverage + explicit ALPHA status documenting the gap   |

---

## 5. Operational Model

- No new external services are required for the current implementation.
- Existing locale resolution is reused for observation normalization.
- Failures in the observation pipeline degrade to an empty observation set rather than halting execution.
- Because the new pipeline is in-memory and per-turn, there is no migration/backfill burden for persisted data.

---

## 6. Open Questions

1. Should the next phase wire `slot-assignment.ts` directly into live GATHER execution?
2. Should the new observation pipeline incorporate sidecar / LLM / regex tiers, or should it remain a lightweight pre-pass?
3. Should `session.observations` become an explicit prompt/model input surface for routing or tool policies?

---

## 7. Post-Implementation Deviations from Earlier Plans

- The parser/compiler semantic-constructs work shipped and is stable.
- The runtime observation layer shipped in a smaller first slice than the original runtime-entity-pipeline plan: observations + intrinsic-validation traces are live, but slot-assignment and commitment tracing remain staged.
- Canonical documentation moved from `docs/superpowers/*` into the standard feature/testing/spec/plan locations instead of treating the earlier implementation notes as the long-term source of truth.
