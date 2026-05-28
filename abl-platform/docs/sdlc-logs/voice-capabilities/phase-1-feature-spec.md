# Phase 1: Feature Spec — voice-capabilities

**Phase:** Feature Spec
**Date:** 2026-03-22
**Status:** COMPLETE

## Inputs

- Codebase analysis of `packages/web-sdk/src/voice/` (VoiceClient, VADAdapter, TwilioAdapter, RealtimeAudioPlayer)
- Codebase analysis of `apps/runtime/src/services/voice/` (Pipeline, Realtime, LiveKit, KoreVG)
- Codebase analysis of `packages/compiler/src/platform/` (IR schema, realtime providers, voice runtime)
- RFC: LiveKit SIP Telephony (`docs/rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md`)
- KoreVG Integration docs (`docs/setup/KOREVG_INTEGRATION.md`)

## Key Decisions

| ID  | Decision                                                                                 | Classification         |
| --- | ---------------------------------------------------------------------------------------- | ---------------------- |
| D1  | Feature scope covers all existing voice paths (pipeline, realtime, LiveKit, KoreVG, SDK) | ANSWERED (code exists) |
| D2  | Status set to ALPHA (code exists but limited E2E test coverage)                          | DECIDED                |
| D3  | Outbound dialing marked as out-of-scope (future feature)                                 | DECIDED                |
| D4  | 9 functional requirements covering all voice subsystems                                  | DECIDED                |
| D5  | 3 realtime providers: OpenAI Realtime, Gemini Live, Ultravox                             | ANSWERED (code exists) |

## Audit Round 1 Findings

| #   | Severity | Finding                                                | Resolution                                                  |
| --- | -------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| 1   | HIGH     | Missing explicit mention of AudioCapture class in FR-8 | Added AudioCapture to FR-8 component list                   |
| 2   | HIGH     | No mention of Homer SIP logging in FR-5                | Added Homer client mention in FR-5                          |
| 3   | MEDIUM   | Architecture diagram could be clearer on LiveKit path  | Accepted — diagram shows high-level; LiveKit details in HLD |
| 4   | MEDIUM   | No mention of voice_credential_cache.ts in key files   | Added to key files table                                    |

## Audit Round 2 Findings

| #   | Severity | Finding                                              | Resolution                  |
| --- | -------- | ---------------------------------------------------- | --------------------------- |
| 1   | MEDIUM   | Missing jambonz-provisioning.service.ts in key files | Added to key files table    |
| 2   | LOW      | Open questions could include warm transfer context   | Added as Q5                 |
| 3   | LOW      | Testing strategy could reference existing test files | Deferred to test spec phase |

## Artifacts Produced

- `docs/features/voice-capabilities.md` — Full feature spec with 18 sections
- `docs/sdlc-logs/voice-capabilities/phase-1-feature-spec.md` — This log

## Metrics

- User Stories: 7
- Functional Requirements: 9
- Non-Functional Requirements: 5
- Open Questions: 5
