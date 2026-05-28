# Test Spec Log — Voice TTS Preview

**Feature**: Voice TTS Preview
**Date**: 2026-04-11
**Phase**: Test Spec (Phase 2 of SDLC)

---

## Oracle Decisions

### Test Scope & Priorities

| #   | Question                             | Answer                                                                                                                                                                    | Classification |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q1  | Which FRs are highest risk?          | FR-3 (endpoint), FR-4 (credential resolution), FR-7 (rate limiting), FR-8 (auth) — these are security and cost boundaries                                                 | INFERRED       |
| Q2  | Known edge cases or failure modes?   | Invalid credentials, rate limit race conditions, WAV vs MP3 content-type mismatch, object URL memory leaks in browser                                                     | INFERRED       |
| Q3  | Current test coverage baseline?      | Zero — no tests exist for tts-preview. Orpheus-tts.test.ts tests helper functions only. voice-e2e-caller-audio-route.test.ts uses heavy vi.mock (not a pattern to follow) | ANSWERED       |
| Q4  | External dependencies needing mocks? | ElevenLabs API and Groq API are the only external deps — must be mocked via DI. VoiceServiceFactory, auth middleware, MongoDB, Redis are real.                            | DECIDED        |
| Q5  | Test environment setup?              | Express on random ports, MongoDB for service instances, Redis for rate limiting. Docker Compose provides MongoDB/Redis in CI. No external network calls.                  | ANSWERED       |

### E2E Scenarios

| #   | Question                      | Answer                                                                                                                                                    | Classification |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q6  | Critical user journeys?       | ElevenLabs preview, Orpheus preview, cross-tenant isolation, unauthenticated rejection, rate limit enforcement, invalid credentials, admin voice override | DECIDED        |
| Q7  | Auth/permission combinations? | Tenant OWNER (primary), no auth (rejection). Feature is tenant-scoped, not project-scoped — no project-level permission matrix needed.                    | INFERRED       |
| Q8  | Cross-feature interactions?   | VoiceServiceFactory credential resolution (shared with voice pipeline), rate limiting middleware (shared infra). No webhook or event-driven interactions. | ANSWERED       |
| Q9  | Data seeding?                 | Tenant + ElevenLabs service instance + Orpheus service instance. Seeded via API, not direct DB. Test encryption key for API key storage.                  | DECIDED        |
| Q10 | Performance/load scenarios?   | Latency measurement accuracy, concurrent multi-tenant requests, large text (500 chars). Not critical for v1 but included for completeness.                | INFERRED       |

### Integration Boundaries

| #   | Question                            | Answer                                                                                                                                                               | Classification |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Q11 | Service boundaries needing tests?   | Route → Zod validation, Route → VoiceServiceFactory (credential resolution), Route → provider synthesis (ElevenLabs/Orpheus), Route → rate limit middleware          | ANSWERED       |
| Q12 | Webhook/event-driven flows?         | None — TTS preview is synchronous request/response with no event emission                                                                                            | ANSWERED       |
| Q13 | Tenant/project isolation scenarios? | Tenant isolation is critical (cross-tenant 404). Project isolation is N/A (service instances are tenant-scoped). User isolation N/A (any tenant member can preview). | ANSWERED       |
| Q14 | Race conditions or concurrency?     | Rate limit counter race (two requests arriving at exactly limit). Mitigated by Redis atomic operations. Worth a test but low risk.                                   | INFERRED       |
| Q15 | Error/failure paths?                | Empty text, oversized text, missing fields, unsupported provider, nonexistent service instance, provider API failure, invalid credentials                            | ANSWERED       |

---

## AMBIGUOUS Items (none)

All questions classified as ANSWERED, INFERRED, or DECIDED. No user escalation needed.

---

## Audit Results

### Round 1 — Quality Gates

- **Result**: APPROVED
- 7 E2E scenarios (min 5) ✓
- 11 integration scenarios (min 5) ✓
- All 10 FRs mapped in coverage matrix ✓
- Security & isolation section: 5 concrete checks ✓
- E2E scenarios specify auth context ✓
- E2E scenarios: no codebase mocks, only external DI stubs ✓
- Integration scenarios specify service boundaries ✓
- Test file mapping present ✓
- No TODO stubs ✓
- One finding: Feature spec §17 still had old placeholder — FIXED (updated to summary table)

### Round 2 — Cross-Phase Consistency

- **Result**: APPROVED
- Test scenarios map 1:1 to feature spec FRs
- Provider support (ElevenLabs + Orpheus) tested in both E2E and integration
- Rate limiting tested at both middleware (INT-9) and full-stack (E2E-5) levels
- Error response format consistent with feature spec §8 error examples
- Admin voice override (allowVoiceOverride) covered in UT-8 and E2E-7

---

## Files Created/Modified

- Updated: `docs/testing/sub-features/voice-tts-preview.md` — comprehensive test spec (replaces placeholder)
- Updated: `docs/features/sub-features/voice-tts-preview.md` — §17 updated from placeholder to summary
- Updated: `docs/testing/README.md` — test count updated (7 E2E, 11 integration)
- Created: `docs/sdlc-logs/voice-tts-preview/test-spec.log.md` — this log
