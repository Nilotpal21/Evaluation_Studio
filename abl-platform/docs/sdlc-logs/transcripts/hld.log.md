# SDLC Log: Transcripts — HLD Phase

**Feature**: Transcripts
**Phase**: HLD (Phase 3 of 6)
**Date**: 2026-03-23
**Status**: COMPLETE

---

## Product Oracle Decisions

### Architecture & Data Flow

| #   | Question                        | Answer                                                                                                                                                                                                                                       | Classification                      |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | Preferred architecture pattern? | Service extraction: `TranscriptService` in `apps/runtime/src/services/transcript-service.ts` with project-scoped route in `apps/runtime/src/routes/project-transcripts.ts`. Follows the pattern of `sessions.ts` → `MongoConversationStore`. | ANSWERED (matches existing pattern) |
| 2   | Data flow?                      | Request-driven: Studio -> Runtime API -> TranscriptService -> MongoDB. No event-driven components.                                                                                                                                           | DECIDED                             |
| 3   | Expected scale?                 | Low-volume: estimated 10-50 transcript creates/day per tenant, 100-500 reads/day. Export is even less frequent. Not a hot path.                                                                                                              | INFERRED                            |
| 4   | Existing patterns to follow?    | `session-state.model.ts` stores compressed `conversationHistory` as Buffer. `conversation-reader.ts` reads encrypted messages. `alerts.ts` uses `requireProjectPermission`.                                                                  | ANSWERED                            |
| 5   | Deployment topology?            | Single service (Runtime). No workers or queues needed for transcript operations.                                                                                                                                                             | DECIDED                             |

### Integration & Dependencies

| #   | Question                              | Answer                                                                                                          | Classification |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Dependencies?                         | Session + Message models (read), encryptionPlugin, tenantIsolationPlugin, unifiedAuth middleware. All existing. | ANSWERED       |
| 2   | New external dependencies?            | None. All infrastructure already in place.                                                                      | ANSWERED       |
| 3   | API contract with consumers?          | Studio proxies to Runtime. JSON request/response with Zod schemas. Standard error envelope.                     | DECIDED        |
| 4   | Breaking changes?                     | Existing `/api/v1/transcripts` route is deprecated but not removed. New project-scoped route is additive.       | DECIDED        |
| 5   | Compile → deploy → execute lifecycle? | No impact. Transcripts are operational, not part of agent compilation or execution.                             | ANSWERED       |

### Risk & Migration

| #   | Question                | Answer                                                                                                                                                                                                                                                                                                         | Classification |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Biggest technical risk? | Encryption round-trip: messages are encrypted in `messages` collection, decrypted on read, re-encrypted in `transcripts` collection. If encryption keys differ or rotate, transcript data could become unreadable. Mitigation: transcripts use same `encryptionPlugin` with same tenant-scoped key derivation. | DECIDED        |
| 2   | Data migration?         | None. Prototype stores files on local disk (ephemeral). New collection starts empty.                                                                                                                                                                                                                           | ANSWERED       |
| 3   | Rollback strategy?      | Revert deployment. New routes removed, old routes still work. Drop `transcripts` collection to clean up.                                                                                                                                                                                                       | DECIDED        |
| 4   | Feature flags?          | Not needed. New route is additive. Old route remains for backward compatibility.                                                                                                                                                                                                                               | DECIDED        |
| 5   | Blast radius?           | Minimal. Transcript feature is isolated -- no other feature depends on it. Only touches new MongoDB collection and new routes.                                                                                                                                                                                 | ANSWERED       |

---

## Audit Log

| Round | Date       | Findings                                                                                                                                                                                                                                                                                                             | Resolution              |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | 2026-03-23 | All 12 architectural concerns addressed with concrete decisions. 3 alternatives with real trade-offs (not strawmen). Architecture diagrams provided (system context + component). Data model with indexes and relationships. API design with request/response examples. Error responses enumerated.                  | All quality gates pass. |
| 2     | 2026-03-23 | Data model deep dive: unique compound index for idempotency `(tenantId, sessionId, name)` is correct. TTL index has `expireAfterSeconds: 0` which means MongoDB respects the `expiresAt` field value. Encryption plugin on `messages` Buffer field confirmed (same pattern as `session-state.model.ts` `stateData`). | No changes needed.      |
| 3     | 2026-03-23 | Cross-phase consistency: All 15 FRs from feature spec are traceable to HLD design decisions. Test strategy (concern #12) references test spec scenarios. API endpoints match feature spec section 6. Data model matches feature spec section 7 (with refined indexes).                                               | Confirmed consistent.   |

---

## Files Created

- `docs/specs/transcripts.hld.md` — High-Level Design
- `docs/sdlc-logs/transcripts/hld.log.md` — This file
