# Feature: Entity Extraction & Semantic Entities

**Doc Type**: FOCUSED SUB-FEATURE
**Parent Feature**: [NLU / Intent Classification & Entity Extraction](./nlu.md)
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `governance`
**Package(s)**: `apps/runtime`, `packages/compiler`, `packages/core`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)
**Last Updated**: 2026-04-15

---

> Canonical ownership for semantic entity work moved here on 2026-04-15. The older `docs/superpowers/*entity*` and semantic-constructs docs remain historical implementation inputs, not the canonical feature record.

## 1. Introduction / Overview

### Problem Statement

Before the April 2026 implementation, entity extraction logic was split across parser/compiler/runtime layers with inconsistent validation, duplicated semantic definitions, and no canonical runtime observation model. `NLU.entities` definitions were partially compiled but not consumed consistently at runtime, GATHER extraction paths applied validation unevenly, and there was no first-class `ENTITIES` / `ENTITY_REF` flow for reusable semantic types.

### Goal Statement

Provide a canonical entity model that:

- defines reusable semantic entities in the DSL and IR,
- preserves backward compatibility with legacy `NLU.entities`,
- enriches GATHER collection with entity semantics,
- runs utterance-scoped extraction and intrinsic validation at runtime, and
- emits traceable, sensitivity-aware observation events.

### Summary

The shipped feature has three major slices:

1. **Parser + compiler semantic entity registry**: top-level `ENTITIES`, `ENTITY_REF`, legacy `NLU.entities` lowering, system entity definitions, and compile-time GATHER enrichment now flow into `AgentIR.entities`.
2. **Runtime observation pipeline**: reasoning and flow execution now run a per-turn entity observation pass for `ir.entities`, store utterance-scoped observations on the session, and emit masked trace events for observations plus intrinsic validation.
3. **Extraction parity fixes**: shared validation and normalization utilities now close several long-standing gaps across GATHER extraction call sites, including `max_retries`, `validation_process`, enum synonym enrichment, and compile-time merge of NLU entity metadata into GATHER fields.

---

## 2. Scope

### Goals

- Add a first-class top-level `ENTITIES:` DSL section
- Add `ENTITY_REF` on top-level and flow GATHER fields
- Lower explicit entities, legacy `NLU.entities`, and inline GATHER system types into one canonical `ir.entities` registry
- Add built-in system entity definitions for `email`, `phone`, `date`, `datetime`, `boolean`, and `currency`
- Preserve utterance-scoped observations separately from session-scoped gathered values
- Run intrinsic validation and sensitivity-aware tracing for entity observations
- Reuse NLU entity values/synonyms to enrich GATHER enum handling at compile time
- Close the validation/normalization parity gaps across reasoning and flow extraction paths

### Non-Goals (Current Release)

- Full multi-tier `ir.entities` extraction using sidecar + LLM + regex fallback
- End-to-end automatic slot assignment from observations into GATHER fields
- Runtime commitment of observation values directly into memory/session state without existing GATHER flow
- Real ML sidecar models for semantic entity extraction
- Public HTTP / WebSocket E2E coverage for the new entity registry and observation lifecycle

---

## 3. User Stories

1. As an **agent author**, I want reusable semantic entities so I can define `airport_code`, `travel_date`, or `work_email` once and reference them across routing and GATHER.
2. As a **runtime executor**, I want utterance-scoped entity observations so I can inspect what the user mentioned on this turn without immediately committing it to session state.
3. As a **platform maintainer**, I want entity validation and normalization to behave consistently across reasoning and flow extraction paths so GATHER does not silently accept raw invalid values.
4. As a **compliance-sensitive builder**, I want entity observations and traces to respect `SENSITIVE` flags so extracted PII is masked in trace output.

---

## 4. Functional Requirements

1. **FR-1**: The parser must support a top-level `ENTITIES:` block with entity name, type, values, synonyms, pattern, validation, and `SENSITIVE`.
2. **FR-2**: The parser and compiler must support `ENTITY_REF` on top-level and flow GATHER fields, preserving collection-policy properties while inheriting entity semantics.
3. **FR-3**: The compiler must lower explicit entities, legacy `NLU.entities`, and inline GATHER system types into a canonical `AgentIR.entities` registry with provenance.
4. **FR-4**: The compiler must provide built-in system entity definitions for `email`, `phone`, `date`, `datetime`, `boolean`, and `currency`.
5. **FR-5**: The compiler must merge compatible NLU entity metadata into GATHER fields so enum values, synonyms, `sensitive`, and validation metadata are not lost.
6. **FR-6**: Runtime execution must run an utterance-scoped entity observation pass for `ir.entities` on each user turn in both reasoning and flow execution.
7. **FR-7**: Runtime observation results must preserve intrinsic validation results and mask sensitive values in trace events.
8. **FR-8**: GATHER extraction call sites must use shared validation/normalization helpers so non-inline and fallback extraction paths match inline behavior more closely.
9. **FR-9**: Parser/compiler/runtime changes must preserve backward compatibility with existing `NLU.entities` and inline GATHER system types.
10. **FR-10**: The codebase must provide helper logic for slot assignment, clarification, and disambiguation for entity-backed GATHER fields, even if the full end-to-end wiring is not yet complete.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                    | Impact Level | Notes                                                                    |
| ----------------------- | ------------ | ------------------------------------------------------------------------ |
| Agent lifecycle         | PRIMARY      | Authors can declare canonical semantic entities and reuse them in GATHER |
| Customer experience     | PRIMARY      | Better extraction normalization and validation reduce bad slot commits   |
| Observability / tracing | PRIMARY      | New utterance-scoped observation and intrinsic-validation trace events   |
| Governance / controls   | SECONDARY    | `SENSITIVE` metadata influences trace masking                            |
| Project lifecycle       | SECONDARY    | Reuses existing project extraction config and locale wiring              |
| Enterprise / compliance | SECONDARY    | Sensitive entity handling plus future PII-guard alignment                |

### Related Feature Integration Matrix

| Related Feature          | Relationship Type | Why It Matters                                                               | Key Touchpoints                                      | Current State |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| NLU                      | parent / umbrella | NLU owns the higher-level umbrella; this child feature owns entity semantics | `docs/features/nlu.md`, `docs/specs/nlu.hld.md`      | BETA          |
| Gather / Data Collection | shares data with  | GATHER fields inherit entity semantics and still own collection policy       | `compileGather()`, runtime GATHER extraction         | STABLE        |
| PII Detection            | shares metadata   | `SENSITIVE` flags and masked traces should align with future guard usage     | `sensitive`, `maskSensitiveValue()`                  | PARTIAL       |
| Runtime Tracing          | extends           | Observation and validation lifecycle emit new trace events                   | `entity-trace-events.ts`, `onTraceEvent`             | ALPHA         |
| Project Runtime Config   | configured by     | Locale and existing extraction strategy still affect downstream behavior     | `project-runtime-config-resolver.ts`, session locale | STABLE        |

---

## 6. Design Considerations

- **Observation vs commitment**: entities are utterance-scoped observations; GATHER remains the session-scoped commitment layer.
- **Semantic definition vs collection policy**: entities own reusable semantics; GATHER owns prompts, retries, confirmation, business validation, and completion behavior.
- **Backward compatibility first**: explicit `ENTITIES` is the new canonical path, but legacy `NLU.entities` and inline system types still lower into the same IR registry.
- **Fail-soft runtime behavior**: if entity extraction fails during a turn, runtime falls back to an empty observation set instead of blocking execution.

---

## 7. Technical Considerations

- The new runtime observation pipeline currently executes only the JS-extractable tier for `ir.entities`; non-JS entity types still rely on existing GATHER extraction paths for full collection.
- `ENTITY_REF` inheritance is resolved at compile time, so most runtime consumers continue to see normalized `GatherField` metadata even before full observation-to-slot wiring exists.
- System entities are represented as compiler-owned registry entries with `source: 'system'` to avoid collisions with author-defined entities.
- Observations are serialization-safe plain objects stored on session state, but they are replaced each turn and are not treated as durable memory.

---

## 8. How to Consume

### DSL

```yaml
AGENT: TravelAssistant
GOAL: 'Collect trip details'

ENTITIES:
  airport_code:
    TYPE: enum
    VALUES: [JFK, LAX, LHR]
    SYNONYMS:
      JFK: [new york, nyc]
  work_email:
    TYPE: email
    SENSITIVE: true

GATHER:
  origin:
    ENTITY_REF: airport_code
    PROMPT: 'Where are you flying from?'
  email:
    ENTITY_REF: work_email
    PROMPT: 'What is your work email?'
    VALIDATE: 'must end with @company.com'
    VALIDATION_PROCESS: LLM
    MAX_RETRIES: 3
```

### Runtime Behavior

- `ENTITIES` and legacy `NLU.entities` compile into `session.agentIR.entities`
- reasoning and flow execution call `extractEntityObservations()` on each user turn
- extracted observations are stored on `session.observations`
- `entity_observation` and `entity_validation_intrinsic` traces are emitted, with sensitive values masked
- existing GATHER extraction still performs the final slot-filling / value-commitment path

---

## 9. Data Model

### Agent IR

```text
AgentIR
  - entities?: EntityDefinitionIR[]

EntityDefinitionIR
  - name: string
  - type: EntityType
  - values?: string[]
  - synonyms?: Record<string, string[]>
  - pattern?: string
  - intrinsic_validation?: string
  - sensitive?: boolean
  - source: 'explicit' | 'nlu_lowered' | 'gather_inline' | 'system'
```

### Gather Field Enrichment

```text
GatherField
  - entity_ref?: string
  - enum_values?: string[]
  - synonyms?: Record<string, string[]>
  - validation.max_retries?: number
  - validation.validation_process?: 'REGEX' | 'CODE' | 'LLM'
```

### Runtime Observation Store

```text
ObservationSet
  - turn: number
  - entities: Record<string, EntityObservation[]>

EntityObservation
  - entityName: string
  - entityType: string
  - value: unknown
  - confidence: number
  - intrinsicValid?: boolean
  - intrinsicError?: string
  - sensitive?: boolean
```

---

## 10. Key Implementation Files

### Runtime

| File                                                           | Purpose                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/entity-pipeline.ts`       | Per-turn entity observation pipeline (`extract -> normalize -> intrinsic validate`)    |
| `apps/runtime/src/services/execution/entity-observations.ts`   | Observation types, immutable helpers, and sensitive-value masking                      |
| `apps/runtime/src/services/execution/intrinsic-validation.ts`  | Type-level intrinsic validation and normalization                                      |
| `apps/runtime/src/services/execution/extraction-validation.ts` | Shared field validation / enum normalization used across GATHER extraction paths       |
| `apps/runtime/src/services/execution/entity-trace-events.ts`   | Trace builders for observation, validation, slot-assignment, clarification, commitment |
| `apps/runtime/src/services/execution/slot-assignment.ts`       | Pure helpers for direct assignment, clarification, and disambiguation decisions        |
| `apps/runtime/src/services/execution/reasoning-executor.ts`    | Runs the entity observation pass for reasoning agents and emits observation traces     |
| `apps/runtime/src/services/execution/flow-step-executor.ts`    | Runs the entity observation pass in flow execution and applies validation parity fixes |
| `apps/runtime/src/services/session/types.ts`                   | Persists utterance-scoped observations on session data                                 |
| `apps/runtime/src/services/execution/types.ts`                 | Runtime session typing for observation storage                                         |

### Parser / Compiler

| File                                                   | Purpose                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `packages/core/src/types/agent-based.ts`               | AST types for `ENTITIES`, `entityRef`, and `sensitive` metadata                   |
| `packages/core/src/parser/agent-based-parser.ts`       | Parses `ENTITIES`, `ENTITY_REF`, `MAX_RETRIES`, and `SENSITIVE`                   |
| `packages/compiler/src/platform/ir/schema.ts`          | Canonical `EntityDefinitionIR`, `entity_ref`, `synonyms`, and validation metadata |
| `packages/compiler/src/platform/ir/compiler.ts`        | Entity lowering, `ENTITY_REF` inheritance, anonymous inline entities, NLU merge   |
| `packages/compiler/src/platform/ir/system-entities.ts` | Built-in system entity registry                                                   |

### Tests

| File                                                                      | Type        | Coverage Focus                                                    |
| ------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| `packages/core/src/__tests__/parser-entities-section.test.ts`             | unit        | `ENTITIES` and `ENTITY_REF` parsing                               |
| `packages/core/src/__tests__/parser-gather-gap-fixes.test.ts`             | unit        | `MAX_RETRIES` and `SENSITIVE` parsing gaps                        |
| `packages/compiler/src/__tests__/entities-compilation.test.ts`            | unit        | Entity registry lowering, `ENTITY_REF`, inline system entities    |
| `packages/compiler/src/__tests__/entity-extraction-gap-fixes.test.ts`     | unit        | GATHER enrichment, validation metadata, NLU merge                 |
| `packages/compiler/src/__tests__/system-entities.test.ts`                 | unit        | System entity definitions                                         |
| `apps/runtime/src/__tests__/entity-observations.test.ts`                  | unit        | Observation store lifecycle                                       |
| `apps/runtime/src/__tests__/intrinsic-validation.test.ts`                 | unit        | Type-level validation                                             |
| `apps/runtime/src/__tests__/entity-pipeline.test.ts`                      | unit        | Observation extraction pipeline                                   |
| `apps/runtime/src/__tests__/slot-assignment.test.ts`                      | unit        | Clarification / disambiguation helpers                            |
| `apps/runtime/src/__tests__/entity-trace-events.test.ts`                  | unit        | Entity lifecycle trace builders                                   |
| `apps/runtime/src/__tests__/extraction/gather-lookup-integration.test.ts` | integration | Gather extraction still composes with lookup-backed normalization |

---

## 11. Configuration

No feature-specific environment variables were added for semantic entities. Runtime behavior currently reuses:

- session locale (`session.data.values._locale`) for extraction/normalization,
- existing project extraction config for legacy GATHER extraction paths, and
- existing trace callbacks for observability.

---

## 14. Success Metrics

| Metric                               | Baseline | Target | How Measured                                                       |
| ------------------------------------ | -------- | ------ | ------------------------------------------------------------------ |
| Parser / compiler parity gaps closed | N/A      | 100%   | Targeted parser/compiler tests for `ENTITIES`, `ENTITY_REF`, merge |
| Observation extraction correctness   | N/A      | > 90%  | Unit coverage for JS-extractable entity types                      |
| Invalid-value rejection consistency  | N/A      | > 90%  | Shared validation utility coverage across call sites               |
| Sensitive trace masking fidelity     | N/A      | 100%   | Unit tests for masked observation traces                           |

---

## 15. Open Questions

1. When should `slot-assignment.ts` be wired into the live GATHER commitment path?
2. Should the entity observation pipeline expand beyond JS extraction to sidecar / LLM / regex tiers?
3. Should `session.observations` become readable by tools, prompts, or routing policy in a first-class way?
4. Should `intrinsic_validation` evolve from descriptive metadata into an executable policy surface?

---

## 16. Implementation Status (as of 2026-04-15)

**Status rationale**: ALPHA — parser/compiler/runtime groundwork is implemented with strong unit coverage, but the new entity observation layer is still partially wired: public API E2E is absent, `ir.entities` extraction currently uses only the JS tier, and slot-assignment / commitment helpers are not yet connected end-to-end.

### Fully Implemented

- Top-level `ENTITIES` parsing and AST support
- `ENTITY_REF` parsing on top-level and flow GATHER fields
- Canonical `AgentIR.entities` registry with provenance tracking
- Lowering of legacy `NLU.entities` into the canonical registry
- Built-in system entities for `email`, `phone`, `date`, `datetime`, `boolean`, and `currency`
- Compile-time GATHER enrichment with enum values, synonyms, `sensitive`, and validation metadata
- Shared extraction validation / normalization utilities for reasoning + flow call sites
- Runtime utterance-scoped observation storage on session state
- Observation and intrinsic-validation trace builders with masking support

### Partially Implemented

- Runtime entity observation pipeline only processes JS-extractable entity types in `entity-pipeline.ts`
- Reasoning and flow executors store observations and emit observation traces, but do not yet consume them for slot assignment
- Slot-assignment, clarification, disambiguation, business-validation, and commitment trace helpers exist but remain utility-only

### Not Yet Implemented

- Public HTTP / WebSocket E2E coverage for `ENTITIES` / `ENTITY_REF`
- Sidecar / LLM / regex fallback inside the new `ir.entities` observation pipeline
- End-to-end observation-to-slot commitment flow using the new helper modules

---

## 17. Gaps, Known Issues & Limitations

| ID      | Description                                                                                      | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | `entity-pipeline.ts` currently extracts only JS-extractable entity types                         | High     | Open      |
| GAP-002 | `session.observations` is stored per turn but not yet consumed by live slot-assignment logic     | High     | Open      |
| GAP-003 | `slot-assignment.ts` and several trace builders are unit-tested but not wired into runtime flow  | High     | Open      |
| GAP-004 | No public API E2E verifies `ENTITIES` / `ENTITY_REF` behavior through chat execution             | High     | Open      |
| GAP-005 | Sensitive entity metadata masks traces, but broader PII-guard integration remains future work    | Medium   | Partial   |
| GAP-006 | Legacy GATHER extraction remains the path of record for final commitment and business validation | Medium   | By design |

---

## 18. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                 | Coverage Type | Status     | Test File / Note                                                  |
| --- | -------------------------------------------------------- | ------------- | ---------- | ----------------------------------------------------------------- |
| 1   | `ENTITIES` parser support                                | unit          | PASS       | `packages/core/src/__tests__/parser-entities-section.test.ts`     |
| 2   | `ENTITY_REF` parser + compiler inheritance               | unit          | PASS       | `parser-entities-section.test.ts`, `entities-compilation.test.ts` |
| 3   | System entity registry                                   | unit          | PASS       | `packages/compiler/src/__tests__/system-entities.test.ts`         |
| 4   | NLU-to-GATHER enrichment / validation metadata wiring    | unit          | PASS       | `entity-extraction-gap-fixes.test.ts`                             |
| 5   | Observation store lifecycle                              | unit          | PASS       | `apps/runtime/src/__tests__/entity-observations.test.ts`          |
| 6   | Intrinsic validation across supported entity types       | unit          | PASS       | `apps/runtime/src/__tests__/intrinsic-validation.test.ts`         |
| 7   | Runtime observation pipeline for JS-extractable entities | unit          | PASS       | `apps/runtime/src/__tests__/entity-pipeline.test.ts`              |
| 8   | Clarification / disambiguation helpers                   | unit          | PASS       | `apps/runtime/src/__tests__/slot-assignment.test.ts`              |
| 9   | Observation / intrinsic-validation trace builders        | unit          | PASS       | `apps/runtime/src/__tests__/entity-trace-events.test.ts`          |
| 10  | Public API execution of `ENTITIES` / `ENTITY_REF`        | e2e           | NOT TESTED | No dedicated HTTP / WebSocket E2E yet                             |

> Full testing details: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)

---

## 19. References

- Feature test guide: [docs/testing/entity-extraction.md](../testing/entity-extraction.md)
- HLD: [docs/specs/entity-extraction.hld.md](../specs/entity-extraction.hld.md)
- LLD: [docs/plans/entity-extraction.lld.md](../plans/entity-extraction.lld.md)
- Parent feature: [docs/features/nlu.md](./nlu.md)
- Historical implementation notes:
  - [docs/superpowers/specs/2026-04-06-entity-extraction-gap-fixes-design.md](../superpowers/specs/2026-04-06-entity-extraction-gap-fixes-design.md)
  - [docs/superpowers/specs/2026-04-07-abl-semantic-constructs-design.md](../superpowers/specs/2026-04-07-abl-semantic-constructs-design.md)
  - [docs/superpowers/plans/2026-04-07-runtime-entity-pipeline.md](../superpowers/plans/2026-04-07-runtime-entity-pipeline.md)
