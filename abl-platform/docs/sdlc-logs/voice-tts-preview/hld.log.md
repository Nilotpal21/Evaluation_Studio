# HLD Log — Voice TTS Preview

**Feature**: Voice TTS Preview
**Date**: 2026-04-11
**Phase**: HLD (Phase 3 of SDLC)

---

## Oracle Decisions

### Architecture & Data Flow

| #   | Question                        | Answer                                                                                                                                                      | Classification |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1  | Preferred architecture pattern? | New route handler in runtime — follows existing `/api/v1/voice/*` pattern. Not a service extraction or worker queue — synchronous request/response is fine. | DECIDED        |
| Q2  | Data flow?                      | Request path: Studio → Runtime POST → auth → rate limit → validate → VoiceServiceFactory → Provider API → audio response. No events, no queues.             | ANSWERED       |
| Q3  | Expected scale?                 | Low volume: 5 req/min/tenant cap, preview-only (not in call path). No scaling concerns beyond rate limiting.                                                | INFERRED       |
| Q4  | Existing patterns to follow?    | `custom-tts.ts` (Orpheus route), `voice.ts` (Studio API client), `VoiceServiceFactory.resolveServiceCredentials` (credential resolution).                   | ANSWERED       |
| Q5  | Deployment topology?            | Single route in existing runtime Express app. No new services, no new workers.                                                                              | DECIDED        |

### Integration & Dependencies

| #   | Question                   | Answer                                                                                                                | Classification |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q6  | Existing service deps?     | VoiceServiceFactory, ElevenLabsService, synthesizeOrpheusSpeech, requireAuth, tenantRateLimit — all existing, stable. | ANSWERED       |
| Q7  | New external dependencies? | None — already depends on ElevenLabs API and Groq API via existing services.                                          | ANSWERED       |
| Q8  | API contract?              | Zod-validated JSON in, binary audio out. Follows `{ success, error: { code, message } }` error pattern.               | DECIDED        |
| Q9  | Breaking changes?          | None — purely additive new endpoint.                                                                                  | ANSWERED       |
| Q10 | Compile/deploy lifecycle?  | No impact — no DSL/IR changes, no agent configuration changes. Studio UI is build-time.                               | ANSWERED       |

### Risk & Migration

| #   | Question                | Answer                                                                                                                                                                                                                  | Classification |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q11 | Biggest technical risk? | VoiceServiceFactory.resolveServiceCredentials visibility — it's in the "PRIVATE" comment section but lacks the `private` keyword, so it's callable. Risk: someone adds `private` later. Mitigation: LLD will note this. | INFERRED       |
| Q12 | Data migration?         | None — no new collections, no schema changes.                                                                                                                                                                           | ANSWERED       |
| Q13 | Rollback strategy?      | Remove route registration + UI imports. Pure code revert, no data cleanup. Preview is additive — removing it breaks nothing.                                                                                            | DECIDED        |
| Q14 | Feature flags?          | Not needed. Preview UI is inert when no TTS service instance is configured (the Play button requires a serviceInstanceId).                                                                                              | DECIDED        |
| Q15 | Blast radius?           | Minimal — preview is a leaf feature. Failure means "can't preview voice" → users fall back to current behavior (live call to hear voice). No cascading impact.                                                          | INFERRED       |

---

## AMBIGUOUS Items (none)

All questions classified. No user escalation needed.

---

## Audit Results

### Round 1 — Full Audit

- **Result**: APPROVED
- All 12 concerns addressed with real decisions
- 3 alternatives with genuine trade-offs (not strawmen)
- Architecture diagrams: system context + component
- Data model: explicit "no changes" with justification
- API design: full Zod schema, 6 error codes, auth, rate limit
- 3 open questions

### Round 2 — Data Model & API Deep Dive

- **Result**: APPROVED
- Request schema matches feature spec FR-3
- Error codes cover all failure modes from test spec
- Rate limit operation key (`tts_preview`) is new but follows existing patterns
- `resolveServiceCredentials` is callable (no `private` keyword) — verified in code

### Round 3 — Cross-Phase Consistency

- **Result**: APPROVED
- Feature spec FRs all traceable to HLD design decisions
- Test spec scenarios all implementable against the HLD's API design
- Error response format consistent across all three documents
- Provider output formats (MP3/WAV) consistent

---

## Key Design Decisions

1. **New route over extending custom-tts.ts**: Different auth model (JWT vs static token), different purpose (user preview vs Jambonz callback)
2. **Direct runtime call over Studio proxy**: Follows existing `voice.ts` pattern, avoids unnecessary proxy layer
3. **Native audio format per provider**: MP3 for ElevenLabs, WAV for Orpheus — browser plays both, avoids transcoding complexity
4. **No audio caching**: Each preview is fresh synthesis — different text, different voices, low volume
5. **resolveServiceCredentials for both providers**: Unified credential resolution, consistent with Orpheus resolver pattern

---

## Files Created

- `docs/specs/voice-tts-preview.hld.md` — HLD document
- `docs/sdlc-logs/voice-tts-preview/hld.log.md` — This log
