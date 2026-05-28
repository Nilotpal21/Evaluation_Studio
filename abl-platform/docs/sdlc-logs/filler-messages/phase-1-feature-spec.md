# SDLC Log: Filler Messages -- Phase 1 (Feature Spec)

**Date**: 2026-03-23
**Phase**: Feature Spec
**Artifact**: `docs/features/filler-messages.md`

## Summary

Generated feature spec for the filler messages system, documenting the existing Phase 1 MVP implementation and planned Phase 2-3 scope. Grounded in actual codebase analysis of 6 implementation files and 4 test files.

## Key Decisions

| Decision                                                | Classification | Rationale                                                                             |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Three-source priority (pipeline > piggybacked > static) | ANSWERED       | Already implemented in `filler-service.ts` and `runtime-executor.ts`                  |
| chatDelayMs = 1200ms (not 2000ms)                       | ANSWERED       | Tuned from original design based on UX feedback, reflected in `DEFAULT_FILLER_CONFIG` |
| cooldownMs = 3000ms (not 5000ms)                        | ANSWERED       | Tuned from original design for multi-step flows                                       |
| Transient events (never persisted)                      | ANSWERED       | `transient: true` on all StatusEvent, no TraceStore persistence                       |
| Phase 2 scope: voice + DSL                              | INFERRED       | Based on deferred items in `docs/plans/2026-03-09-voice-filler-messages-design.md`    |
| Phase 3 scope: web SDK + studio                         | INFERRED       | Based on deferred items in design doc, no web-sdk changes found in codebase           |

## Findings

- Phase 1 MVP is fully implemented with 34 tests passing
- Pipeline filler and status tag parser are more advanced than the original MVP scope described in the plan doc
- WebSocket `status_update`/`status_clear` events are wired in handler.ts but web-sdk does not yet handle them
- No DSL parser support for CHANNEL_SETTINGS exists yet
