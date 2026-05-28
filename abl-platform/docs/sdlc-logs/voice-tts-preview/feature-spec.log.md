# Feature Spec Log — Voice TTS Preview

**Feature**: Voice TTS Preview
**Date**: 2026-04-11
**Phase**: Feature Spec (Phase 1 of SDLC)

---

## Oracle Decisions

### Scope & Problem

| #   | Question                                | Answer                                                                                                                                                                                                                                                                                                                                                           | Classification                                                                                                                                                        |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | What specific problem does this solve?  | Admins configure TTS provider credentials (API keys, voice IDs, models) but cannot hear the resulting voice until a live call. Channel builders pick TTS provider/language/voice for pipeline channels but have no way to preview what callers will hear. The only preview capability is a separate standalone TTS playground app disconnected from the product. | ANSWERED — VoiceServicesPage.tsx shows credential config with no preview; ConfigurationTab.tsx VoiceFields section has provider/voice pickers with no play capability |
| Q2  | What is explicitly OUT of scope for v1? | STT preview (speech-to-text testing), S2S/Realtime preview (OpenAI Realtime, Gemini Live, etc.), voice library browsing/discovery, SSML editing, batch TTS generation, voice cloning, and standalone playground page.                                                                                                                                            | DECIDED — v1 focuses on pipeline TTS only; S2S providers are fundamentally different (bidirectional streaming)                                                        |
| Q3  | New capability or enhancement?          | New capability — no TTS preview exists anywhere in the product today. The standalone playground is a separate app, not part of the platform.                                                                                                                                                                                                                     | ANSWERED — no preview components found in studio codebase                                                                                                             |
| Q4  | Priority/timeline driver?               | Internal need — the UX gap was identified during analysis of the standalone TTS playground. Users currently must make live calls to hear voice quality.                                                                                                                                                                                                          | INFERRED — user initiated this feature exploration; no Jira ticket exists yet                                                                                         |
| Q5  | Competing approaches or prior attempts? | The standalone TTS playground app exists externally. The runtime already has `/api/v1/voice/custom-tts/orpheus` for Orpheus synthesis. No in-product preview was attempted before.                                                                                                                                                                               | ANSWERED — custom-tts.ts contains the Orpheus endpoint; no preview UI code found                                                                                      |

### User Stories & Requirements

| #   | Question                           | Answer                                                                                                                                                                                                                                                                                  | Classification                                                                                 |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Q6  | Primary personas?                  | Both: (1) Workspace admin configuring TTS credentials in Voice Services — needs to validate credentials work and audition voices. (2) Channel builder configuring a voice pipeline connection — needs to preview what callers will actually hear with the specific connection settings. | DECIDED — two distinct intents map to two surfaces as discussed in the UX analysis             |
| Q7  | Critical user journeys?            | Three distinct journeys: credential validation, voice audition, and connection preview. All are critical — v1 should support credential validation + connection preview. Voice audition (trying multiple voices) is a stretch.                                                          | DECIDED — credential validation is the minimum viable, connection preview is the primary value |
| Q8  | Voice-override selection v1 or v2? | v2 — the channel config preview should use whatever voice is already selected. The admin page can allow voice override in v2.                                                                                                                                                           | DECIDED — keeps v1 scope tight                                                                 |
| Q9  | Latency requirements?              | Should display synthesis latency (total time). First-byte latency is important for voice agents — showing it differentiates this from a toy demo. No hard latency requirement for the preview itself (it's not in the call path).                                                       | INFERRED — custom-tts.ts already logs elapsedMs; voice users care about latency                |
| Q10 | Which TTS providers in v1?         | ElevenLabs and Orpheus (custom:orpheus) — these are the two TTS providers with full service implementations in the runtime (elevenlabs-service.ts, orpheus-tts.ts). Deepgram/Google/AWS/Azure TTS go through Jambonz and would need a different synthesis path.                         | ANSWERED — only ElevenLabs and Orpheus have direct runtime service implementations             |

### Technical & Architecture

| #   | Question                          | Answer                                                                                                                                                                                                                                                                   | Classification                                                                                |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Q11 | Which packages/services affected? | Runtime: new generalized TTS preview route + extend VoiceServiceFactory. Studio: new TTSPreview component + API client. Packages: none (uses existing @agent-platform/shared for encryption).                                                                            | ANSWERED — based on existing code paths                                                       |
| Q12 | Telephony vs native sample rate?  | Channel-level preview should output at native quality (not telephony 8kHz) — users want to hear the best representation. The actual telephony downsampling is a runtime concern, not a preview concern.                                                                  | DECIDED — preview is about voice quality evaluation, not telephony fidelity testing           |
| Q13 | Security/isolation?               | Yes — the preview endpoint must be tenant-scoped (tenantId required), use unified auth middleware (requireAuth), and resolve credentials through VoiceServiceFactory.resolveServiceCredentials which is already tenant-aware. The endpoint should never expose API keys. | INFERRED — follows platform patterns from CLAUDE.md core invariants                           |
| Q14 | Rate limiting for cost?           | Yes — rate-limit to prevent accidental rapid-fire. 5 requests per minute per tenant is reasonable for a preview feature. Show character count to users so they understand cost impact.                                                                                   | DECIDED — ElevenLabs charges per character; Groq has rate limits                              |
| Q15 | Credential resolution path?       | Use existing VoiceServiceFactory.resolveServiceCredentials for all providers. The Orpheus resolver already demonstrates the pattern. Extend it to ElevenLabs path with the same tenant → instance → decrypt → synthesize flow.                                           | ANSWERED — orpheus-service-instance-resolver.ts and voice-service-factory.ts show the pattern |

---

## AMBIGUOUS Items (none)

All questions were classifiable as ANSWERED, INFERRED, or DECIDED. No user escalation needed.

---

## Audit Results

### Round 1 — Quality Gates

- **Result**: APPROVED
- All 18 template sections addressed
- 5 user stories (min 3), 10 FRs (min 4), 4 related features (min 2)
- Isolation concerns addressed for tenant, project, user
- One MEDIUM finding: Cartesia mentioned in open questions but not in FR-5 — consistent since no runtime service exists

### Round 2 — Cross-Phase Consistency

- **Result**: APPROVED
- Delivery plan aligns with implementation files
- Testing scenarios map to FRs
- API surface definition consistent across sections
- Error response format follows CLAUDE.md structured error pattern

---

## Files Created

- `docs/features/sub-features/voice-tts-preview.md` — Feature spec
- `docs/testing/sub-features/voice-tts-preview.md` — Testing guide placeholder
- `docs/sdlc-logs/voice-tts-preview/feature-spec.log.md` — This log
- Updated: `docs/features/sub-features/README.md`, `docs/features/README.md`, `docs/testing/README.md`, `docs/testing/sub-features/README.md`

---

## Files Read

- `apps/studio/src/components/admin/VoiceServicesPage.tsx`
- `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`
- `apps/studio/src/api/speech-providers.ts`
- `apps/studio/src/api/voice-services.ts`
- `apps/runtime/src/routes/custom-tts.ts`
- `apps/runtime/src/services/voice/orpheus-service-instance-resolver.ts`
- `apps/runtime/src/services/voice/voice-service-factory.ts`
- `apps/runtime/src/services/voice/elevenlabs-service.ts`
