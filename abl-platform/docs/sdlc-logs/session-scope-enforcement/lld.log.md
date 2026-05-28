# Session Scope Enforcement -- LLD Log

**Phase**: 4 (LLD)
**Date**: 2026-04-15
**Status**: Complete

## Clarifying Questions & Decisions

### Implementation Strategy

| Question                                                 | Classification | Answer                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What should the implementation order be?                 | DECIDED        | Core critical path first: boundary scope enforcement, then storage/ALS hardening, then shared-service semantics. Operator/read-model and crypto work may proceed as sibling workstreams so they do not block the P0/P1 isolation fixes. |
| How should "red tests first" fit with deployable phases? | DECIDED        | Red-first validation is an execution rule within each phase: write tests first on the branch, verify failure locally, then implement until green before merge.                                                                          |
| Should rollout stay behind feature flags?                | DECIDED        | Yes. `SESSION_SCOPE_ENFORCEMENT_MODE` is the central flag (`audit` / `warn` / `enforce`), with bounded compatibility flags for queue repair, compat reads, diagnostics exposure, and DEK compatibility.                                 |
| What is acceptable for the first merged slice?           | DECIDED        | Phase 1 must close the production boundary gaps: HTTP/session create, WebSocket/session bootstrap, and queue enqueue. Studio/reporting/crypto work must not delay that.                                                                 |
| Are there hard deadlines that change phasing?            | INFERRED       | No explicit external deadline was provided in-thread. The driver is safe progression from planning to implementation without reopening isolation gaps.                                                                                  |

### Technical Details

| Question                                             | Classification | Answer                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which files are the primary boundary seams?          | ANSWERED       | `routes/chat.ts`, `services/session/session-bootstrap.ts`, `channels/pipeline/session-factory.ts`, `websocket/handler.ts`, `websocket/sdk-handler.ts`, `websocket/twilio-media-handler.ts`, and `services/message-persistence-queue.ts`. |
| Where should the new core contracts live?            | DECIDED        | Under `apps/runtime/src/services/session/` as `execution-scope.ts`, `execution-scope-factory.ts`, `scope-policy.ts`, `scoped-session-facade.ts`, and diagnostics/migration helpers.                                                      |
| What is the database migration strategy?             | DECIDED        | Additive model fields plus idempotent backfill / re-encryption scripts. No legacy identity-field deletion until rollout and rollback drills complete.                                                                                    |
| Which paths are performance-sensitive?               | ANSWERED       | Session create/resume, queue enqueue, Redis reverse lookup, and contact resolution. The LLD keeps boundary work bounded and avoids per-request deep-store scans.                                                                         |
| Which tests are the first concrete red-test targets? | ANSWERED       | `tiered-session-store.test.ts`, `message-persistence-queue-full.test.ts`, boundary route/handler tests, ownership/auth-profile tests, and memory/model-resolution regression suites.                                                     |

### Risk & Dependencies

| Question                                             | Classification | Answer                                                                                                                                                                                        |
| ---------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is the biggest implementation risk?             | DECIDED        | Spreading the feature too broadly and losing the core isolation goal. The mitigation is explicit core phases plus sibling workstreams and centralized rollout policy.                         |
| Which existing plans does this depend on?            | ANSWERED       | Auth-profile implementation planning, omnichannel session continuity, the historical SDK auth hardening work, and the recent session-observability LLD style/rollout pattern.                 |
| What needs to be monitored before `enforce`?         | DECIDED        | Scope validation failures, compatibility-path usage, migration status, canonical subject/actor coverage, wrong-scope-kind rejections, queue repair volume, and DEK compatibility telemetry.   |
| What is the whole-feature definition of done?        | DECIDED        | Core boundary and storage gaps closed, canonical subject/actor semantics propagated, diagnostics/read models aligned, crypto compatibility classified, and rollout/rollback drills completed. |
| Are there architecture-blocking open questions left? | DECIDED        | No architecture blockers remain. Only operational rollout questions remain around voice E2E harness maturity, analytics assertion surface, and primary DEK rollout-health signal.             |

## Clarification Notes

This phase did not use autonomous oracle or auditor agents. Answers were derived from:

- the approved feature spec
- the approved test spec
- the approved HLD
- direct inspection of runtime/session/store/auth/memory/reporting source files
- nearby implementation-plan precedents in `docs/plans/`

## Repository Evidence Reviewed

- `apps/runtime/src/services/session/types.ts`
- `apps/runtime/src/services/session/session-store.ts`
- `apps/runtime/src/services/session/session-service.ts`
- `apps/runtime/src/services/session/redis-session-store.ts`
- `apps/runtime/src/services/session/tiered-session-store.ts`
- `apps/runtime/src/services/session/session-state-repo.ts`
- `apps/runtime/src/services/session/session-bootstrap.ts`
- `apps/runtime/src/channels/pipeline/session-factory.ts`
- `apps/runtime/src/services/message-persistence-queue.ts`
- `apps/runtime/src/services/stores/mongo-conversation-store.ts`
- `packages/shared-auth/src/middleware/session-ownership.ts`
- `apps/runtime/src/services/auth-profile/auth-preflight.ts`
- `apps/runtime/src/services/execution/memory-executor.ts`
- `apps/runtime/src/services/llm/model-resolution-versioning.ts`
- `apps/runtime/src/__tests__/tiered-session-store.test.ts`
- `apps/runtime/src/__tests__/message-persistence-queue-full.test.ts`
- `docs/plans/session-observability-gaps.lld.md`
- `docs/plans/2026-04-02-integration-auth-profiles-impl-plan.md`
- `docs/plans/2026-03-22-omnichannel-session-continuity-impl-plan.md`
- `docs/plans/2026-03-14-web-sdk-jwt-jwe-auth.md`

## Files Created / Updated

- `docs/plans/session-scope-enforcement.lld.md`
- `docs/testing/sub-features/session-scope-enforcement.md`
- `docs/sdlc-logs/session-scope-enforcement/lld.log.md`

## Outcome

- The missing LLD now exists and is aligned with the feature spec, HLD, and test spec.
- The plan explicitly splits the work into a core runtime path plus two bounded sibling workstreams so the production isolation fixes stay on the critical path.
- The next executable step is Phase 1 branch work: write the boundary and queue red tests first, verify the failures locally, then implement the converted boundary paths to green.
