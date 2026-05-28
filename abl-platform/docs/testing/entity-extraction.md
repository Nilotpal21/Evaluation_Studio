# Feature Test Guide: Entity Extraction & Semantic Entities

**Feature**: Entity extraction, semantic entity registry, `ENTITIES`, `ENTITY_REF`, runtime observations
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/entity-extraction.md](../features/entity-extraction.md)
**Parent Feature**: [docs/features/nlu.md](../features/nlu.md)
**First tested**: 2026-04-15
**Last updated**: 2026-04-15
**Overall status**: ALPHA — strong parser/compiler/runtime unit coverage, limited integration coverage, no public API E2E yet

---

## Current State (as of 2026-04-15)

The semantic entity split has good unit coverage across parser, compiler, observation storage, intrinsic validation, and trace builders. The parser/compiler side of `ENTITIES` and `ENTITY_REF` is well covered, and the runtime now stores utterance-scoped observations in both reasoning and flow execution. The main gaps are end-to-end ones: the new observation layer currently covers only JS-extractable entity types, slot-assignment helpers are not wired into live GATHER commitment, and there is no dedicated public HTTP/WebSocket E2E for entity-backed execution.

### Quick Health Dashboard

| Area                                      | Status   | Last Verified | Notes                                                                                 |
| ----------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------- |
| `ENTITIES` parser                         | PASS     | 2026-04-15    | Top-level entities, synonyms, `SENSITIVE`, intrinsic validation metadata              |
| `ENTITY_REF` parser                       | PASS     | 2026-04-15    | Top-level + flow GATHER fields parse correctly                                        |
| Entity registry compilation               | PASS     | 2026-04-15    | Explicit entities, lowered NLU entities, inline system entities                       |
| System entity definitions                 | PASS     | 2026-04-15    | 6 built-in entity types verified                                                      |
| GATHER enrichment / gap fixes             | PASS     | 2026-04-15    | `max_retries`, `validation_process`, NLU merge, enum synonym wiring                   |
| Observation store                         | PASS     | 2026-04-15    | Utterance-scoped immutable lifecycle                                                  |
| Intrinsic validation                      | PASS     | 2026-04-15    | Email, phone, date, datetime, boolean, currency, enum, pattern                        |
| Runtime observation pipeline              | PASS     | 2026-04-15    | JS-extractable entities only                                                          |
| Entity trace builders                     | PASS     | 2026-04-15    | Observation + intrinsic validation + future slot/commitment trace builders            |
| Slot assignment helpers                   | PASS     | 2026-04-15    | Clarification / disambiguation logic covered in unit tests                            |
| Live slot assignment / observation commit | PARTIAL  | 2026-04-15    | Helpers exist, but runtime gather path is not wired to consume `session.observations` |
| Public API E2E                            | NOT IMPL | -             | No dedicated HTTP / WebSocket E2E for `ENTITIES` / `ENTITY_REF`                       |

---

## Audit Scope

This guide covers:

- parser and AST support for `ENTITIES`, `ENTITY_REF`, `SENSITIVE`, and `MAX_RETRIES`
- compiler lowering into `AgentIR.entities`
- system entity definitions and GATHER enrichment
- shared runtime validation / normalization utilities
- observation storage, intrinsic validation, and trace builders
- runtime observation wiring in reasoning and flow execution

It does not treat the broader NLU routing/classifier matrix as canonical coverage for this sub-feature; that remains in [docs/testing/nlu.md](./nlu.md).

---

## Coverage Matrix

| FR    | Description                                                        | Unit | Integration | E2E | Manual | Status  |
| ----- | ------------------------------------------------------------------ | ---- | ----------- | --- | ------ | ------- |
| FR-1  | `ENTITIES` parser support                                          | YES  | NO          | NO  | NO     | PASS    |
| FR-2  | `ENTITY_REF` parser + compiler inheritance                         | YES  | NO          | NO  | NO     | PASS    |
| FR-3  | Canonical `AgentIR.entities` registry                              | YES  | NO          | NO  | NO     | PASS    |
| FR-4  | Built-in system entity definitions                                 | YES  | NO          | NO  | NO     | PASS    |
| FR-5  | Compile-time GATHER enrichment from NLU entities                   | YES  | PARTIAL     | NO  | NO     | PARTIAL |
| FR-6  | Utterance-scoped runtime observations                              | YES  | PARTIAL     | NO  | NO     | PARTIAL |
| FR-7  | Sensitive trace masking + intrinsic validation traces              | YES  | NO          | NO  | NO     | PASS    |
| FR-8  | Shared extraction validation parity across call sites              | YES  | PARTIAL     | NO  | NO     | PARTIAL |
| FR-9  | Backward compatibility with `NLU.entities` and inline system types | YES  | NO          | NO  | NO     | PASS    |
| FR-10 | End-to-end slot assignment / commitment for entity-backed GATHER   | YES  | NO          | NO  | NO     | PARTIAL |

---

## E2E Test Scenarios (MANDATORY) — not yet implemented

### E2E-1: `ENTITIES` + `ENTITY_REF` flow through public chat execution

**Status**: Not implemented

**Goal**: Compile an agent with `ENTITIES` and `ENTITY_REF`, execute a real `/api/v1/chat/agent` turn, and verify the GATHER response uses the inherited entity semantics.

### E2E-2: Sensitive entity observations are masked in emitted traces

**Status**: Not implemented

**Goal**: Execute a public API turn containing a sensitive entity (for example email), then verify trace output contains masked observation values instead of raw PII.

### E2E-3: Multi-value observation triggers clarification or disambiguation

**Status**: Not implemented

**Goal**: Use a real runtime execution path to verify that multiple observed values for the same entity-backed slot produce a clarification or disambiguation interaction.

### E2E-4: Flow-step entity observations reset each turn

**Status**: Not implemented

**Goal**: Verify through a live flow execution that `session.observations` is replaced each utterance and does not persist stale values between turns.

---

## Integration Test Scenarios

### INT-1: Compiler-enriched gather fields stay compatible with runtime lookup normalization

**Status**: Implemented

**Coverage**: `apps/runtime/src/__tests__/extraction/gather-lookup-integration.test.ts`

**Goal**: Ensure enriched enum/synonym metadata still composes with runtime gather lookup behavior.

### INT-2: Reasoning and flow execution store utterance-scoped observations

**Status**: Partial

**Coverage**: exercised indirectly by runtime unit tests plus direct executor wiring in source

**Gap**: there is no dedicated integration test asserting observation storage and reset across full execution boundaries.

---

## Unit Test Scenarios

| Module                       | Test File(s)                                                          | Focus                                                                    |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Parser                       | `packages/core/src/__tests__/parser-entities-section.test.ts`         | `ENTITIES`, `ENTITY_REF`, sensitive flag, flow GATHER parsing            |
| Parser gap fixes             | `packages/core/src/__tests__/parser-gather-gap-fixes.test.ts`         | `MAX_RETRIES`, `SENSITIVE` on legacy NLU entity definitions              |
| Compiler entity registry     | `packages/compiler/src/__tests__/entities-compilation.test.ts`        | entity lowering, conflicts, inline system entities, `ENTITY_REF`         |
| Compiler gap fixes           | `packages/compiler/src/__tests__/entity-extraction-gap-fixes.test.ts` | validation metadata and NLU-to-GATHER merge                              |
| System entities              | `packages/compiler/src/__tests__/system-entities.test.ts`             | built-in registry and helper lookups                                     |
| Observation store            | `apps/runtime/src/__tests__/entity-observations.test.ts`              | immutable add/get/clear lifecycle and masking                            |
| Intrinsic validation         | `apps/runtime/src/__tests__/intrinsic-validation.test.ts`             | type-specific validation and normalization                               |
| Runtime observation pipeline | `apps/runtime/src/__tests__/entity-pipeline.test.ts`                  | extraction and validation for JS-extractable entity types                |
| Slot assignment helpers      | `apps/runtime/src/__tests__/slot-assignment.test.ts`                  | direct assignment, clarification, disambiguation prompt/message builders |
| Trace builders               | `apps/runtime/src/__tests__/entity-trace-events.test.ts`              | observation, validation, slot, and commitment trace-event payloads       |

---

## Security & Isolation Tests

- [x] Sensitive entity observations are masked in unit-level trace builder coverage
- [ ] Cross-tenant / cross-project isolation through public API is not yet covered for this sub-feature because no dedicated public API E2E exists
- [ ] Auth / permission enforcement through public entity-backed execution paths is not yet covered specifically for `ENTITIES` / `ENTITY_REF`

---

## Performance & Load Tests

Not currently implemented for this sub-feature.

Recommended future scenarios:

1. Observation pipeline latency for long-but-valid user turns with many system entity definitions
2. Regex / pattern validation cost under adversarial input sizes
3. Repeated-turn observation reset behavior under high concurrency

---

## Test Infrastructure

### Required Services

- `@abl/core` parser tests
- `@abl/compiler` unit tests
- runtime unit test environment
- optional runtime integration harness for gather lookup coverage

### Environment Variables

No feature-specific environment variables are required for current unit coverage.

---

## Test File Mapping

| Test File                                                                 | Type        | Covers                 |
| ------------------------------------------------------------------------- | ----------- | ---------------------- |
| `packages/core/src/__tests__/parser-entities-section.test.ts`             | unit        | FR-1, FR-2             |
| `packages/core/src/__tests__/parser-gather-gap-fixes.test.ts`             | unit        | FR-1, FR-5, FR-9       |
| `packages/compiler/src/__tests__/entities-compilation.test.ts`            | unit        | FR-2, FR-3, FR-4, FR-9 |
| `packages/compiler/src/__tests__/entity-extraction-gap-fixes.test.ts`     | unit        | FR-5, FR-8             |
| `packages/compiler/src/__tests__/system-entities.test.ts`                 | unit        | FR-4                   |
| `apps/runtime/src/__tests__/entity-observations.test.ts`                  | unit        | FR-6, FR-7             |
| `apps/runtime/src/__tests__/intrinsic-validation.test.ts`                 | unit        | FR-6, FR-7             |
| `apps/runtime/src/__tests__/entity-pipeline.test.ts`                      | unit        | FR-6, FR-7             |
| `apps/runtime/src/__tests__/slot-assignment.test.ts`                      | unit        | FR-10                  |
| `apps/runtime/src/__tests__/entity-trace-events.test.ts`                  | unit        | FR-7, FR-10            |
| `apps/runtime/src/__tests__/extraction/gather-lookup-integration.test.ts` | integration | FR-5, FR-8             |

---

## Remaining Gaps

- No public API E2E for `ENTITIES` / `ENTITY_REF`
- No end-to-end runtime consumption of `session.observations`
- No multi-tier fallback inside the new observation pipeline
- No dedicated integration test asserting observation reset across full execution turns
