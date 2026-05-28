# Session Scope Enforcement -- HLD Log

**Phase**: 3 (HLD)
**Date**: 2026-04-15
**Status**: Complete

## Clarifying Questions & Decisions

### Architecture & Data Flow

| Question                                         | Classification | Answer                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is the preferred architecture pattern?      | DECIDED        | Boundary-scoped architecture: `ExecutionScopeFactory` validates production/debug/system boundaries, `ScopedSessionFacade` owns session CRUD, and compatibility handling is explicit policy rather than implicit fallback.                                |
| How does data flow through the system?           | ANSWERED       | Request path for session create/resume and queue enqueue; event/worker path for message persistence, migration telemetry, and diagnostics projection. ALS remains downstream propagation only.                                                           |
| What existing patterns should the design follow? | ANSWERED       | Follow the model-resolution contract for separating scope from versioned inputs, and the contact-resolution flow for canonical human identity. Reuse the existing tenant+project+environment DEK hierarchy instead of inventing new crypto abstractions. |
| What is the deployment topology?                 | ANSWERED       | Multi-pod runtime with Redis hot state, MongoDB cold state, BullMQ workers, Studio proxies, and shared event/audit sinks. The design must remain stateless across pods.                                                                                  |
| What is the scale assumption?                    | INFERRED       | Critical hot-path runtime flow: session create/resume and queue enqueue happen on user-facing paths, so incremental scope resolution must stay bounded and compatibility diagnostics must not require cross-store scans per request.                     |

### Integration & Dependencies

| Question                                                  | Classification | Answer                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which packages does this depend on?                       | ANSWERED       | `apps/runtime`, `packages/database`, `packages/shared-auth`, `packages/shared-encryption`, `packages/eventstore`, `packages/agent-transfer`, `packages/web-sdk`, and `apps/studio`.                                          |
| Are new external dependencies required?                   | DECIDED        | No. The architecture uses existing Redis, MongoDB, BullMQ, KMS/DEK, and trace/audit infrastructure.                                                                                                                          |
| Are there breaking API changes?                           | INFERRED       | Public wire shapes change minimally; the primary change is stricter fail-closed behavior and additive diagnostics payloads. Internal runtime/store interfaces change materially.                                             |
| How does this interact with compile -> deploy -> execute? | ANSWERED       | Compile/deploy outputs stay unchanged. Runtime execution consumes canonical actor/scope input, while model-resolution and reasoning-settings contracts remain intact and must not absorb human-subject identity by accident. |
| How should Studio consume the design?                     | DECIDED        | Session detail is the operator-facing source of truth, backed by a dedicated diagnostics/read-model payload that other Studio surfaces reuse.                                                                                |

### Risk & Migration

| Question                                   | Classification | Answer                                                                                                                                                                                   |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is the biggest technical risk?        | DECIDED        | Broadening the fix beyond the boundary without breaking runtime continuity. The mitigation is phased rollout, compatibility telemetry, and reversible `audit -> warn -> enforce` gating. |
| Is there existing data to migrate?         | ANSWERED       | Yes: hot/cold sessions, message queue payloads, ownership semantics, and legacy encrypted artifacts all need classification into backfillable, compatibility, or quarantined buckets.    |
| What is the rollback strategy?             | DECIDED        | Preserve backward-readable fields and compatibility projections while rollout mode moves between `audit`, `warn`, and `enforce`. Rollback changes policy, not storage shape.             |
| Are feature flags/phased rollout required? | DECIDED        | Yes. Phase 0 tests + telemetry, Phase 1 boundary enforcement, Phase 2 store/service/ALS propagation, Phase 3 debug/system split and compatibility removal.                               |
| What is the blast radius?                  | ANSWERED       | High: runtime session creation, queue persistence, Studio diagnostics, ownership, reporting, GDPR, and DEK usage all depend on the same canonical scope contract.                        |

## Clarification Notes

This phase did not use autonomous oracle or auditor agents. Decisions were derived from:

- the approved feature spec and testing spec
- repository code in runtime, shared-auth, database, encryption, Studio, and agent-transfer
- existing HLD patterns for SDK auth/session unification and session compaction

## Files Created / Updated

- `docs/specs/session-scope-enforcement.hld.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/hld.log.md`

## Review Findings

### Round 1 -- Full Audit

- HLD includes 3 alternatives with explicit recommendation and trade-offs
- System context, component, and sequence diagrams are present
- All 12 architectural concerns are addressed
- Data model covers runtime scope contracts, queue envelopes, diagnostics, and DEK alignment
- API section captures fail-closed response envelopes and modified surfaces

### Round 2 -- Deep Dive

- Checked that actor/subject/memory/auth-profile/model-resolution decisions remain aligned with the feature spec
- Checked that Studio diagnostics, privileged locator, and GDPR compatibility-lane decisions are represented directly in the design
- Checked that migration and rollback sections match the `audit -> warn -> enforce` rollout the test plan expects

### Round 3 -- Cross-Phase Consistency

- HLD design is traceable to FR-1 through FR-24 in the feature spec
- Test strategy aligns with E2E/integration/unit scenarios in the test spec
- No architecture-blocking open questions remain; only operational rollout prerequisites remain
