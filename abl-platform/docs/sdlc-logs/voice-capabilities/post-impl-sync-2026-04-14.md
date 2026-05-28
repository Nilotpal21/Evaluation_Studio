# Post-Implementation Sync — Voice Capabilities (April 14)

**Feature:** `voice-capabilities`
**Date:** 2026-04-14
**Status:** COMPLETE

## Scope of This Sync

This pass updates all voice-capabilities documentation to reflect work that shipped between 2026-04-08 and 2026-04-14. The primary trigger was ABLP-189 (softphone insecure-context guards), but additional voice-related work also landed during this window.

## Key Changes Captured

1. **ABLP-189 — Softphone insecure-context guards**: `crypto.randomUUID` fallback and `getUserMedia` pre-check in `useSoftphone.ts`
2. **Softphone call webhook redirect**: `/call` webhook now returns Jambonz `redirect` verb to the phone number's configured application `call_hook`, routing outbound calls through same agent logic as inbound
3. **KoreVG CORS**: Voice endpoints accept server-to-server calls from KoreVG feature-server origins (token-authenticated)
4. **S2S voice tool trace fixes**: Defensive fallbacks for Google S2S tool call extraction, Grok temperature forwarding, analytics vendor labeling
5. **TTS Preview**: Generalized `/api/v1/voice/tts-preview` endpoint for ElevenLabs/Orpheus synthesis from Studio
6. **Voice Transfer Gateway**: Abstract `VoiceGatewaySession` interface in `@agent-platform/agent-transfer`
7. **Grok S2S Payload**: `grok-llm-payload.ts` for KoreVG sessions using Grok LLM directly
8. **LiveKit voice pipeline integration test**: Real DSL compilation with mock Anthropic client

## Documents Updated

- **Feature spec** (`docs/features/voice-capabilities.md`):
  - Updated Last Updated to 2026-04-14
  - Added TTS Preview, Voice Transfer Gateway, Grok Realtime LLM to scope
  - Updated US-9 acceptance criteria with insecure-context guard and call webhook redirect
  - Updated FR-11 to reflect redirect-based call routing
  - Added 14 new entries to Key Files table (KoreVG sub-components, TTS preview, voice transfer, voice analytics, Orpheus playback store)
  - Added TTS Preview to API Surface section
  - Updated security considerations with insecure-context guards and cross-origin voice gateway
  - Updated error handling table with insecure-context scenario
  - Updated integration test section with new test files
  - Marked open questions 1 (outbound dialing) and 5 (warm transfer) as partially resolved
  - Updated rollout plan ALPHA description

- **Test spec** (`docs/testing/voice-capabilities.md`):
  - Updated Last Updated to 2026-04-14 and overall status
  - Updated Current State narrative with new test coverage
  - Added 16 new entries to Quick Health Dashboard
  - Added 6 new test coverage sections (Grok/S2S, TTS Preview, Voice Analytics Routes, Voice Filler Messages, Voice Config/IR, Orpheus Pipeline E2E)
  - Added 18 new entries to Test Files Index
  - Updated Audit Scope with expanded coverage areas

- **Testing index** (`docs/testing/README.md`):
  - Updated Voice Capabilities row: 3 e2e (local), 20+ local, PARTIAL 04-14

- **HLD** (`docs/specs/voice-capabilities.hld.md`):
  - Updated Last Updated to 2026-04-14
  - Added Post-Implementation Notes section with 6 additions since last update

- **LLD** (`docs/plans/2026-03-22-voice-capabilities-impl-plan.md`):
  - Updated Last Updated to 2026-04-14
  - Added Post-Implementation Delta (2026-04-14) section documenting 10 shipped items

## Coverage Delta

| Type              | Before (04-07) | After (04-14)      |
| ----------------- | -------------- | ------------------ |
| Unit tests        | ~24            | ~37                |
| Integration tests | ~2             | ~5                 |
| E2E tests (local) | 0              | 3 (local, no live) |
| Test files        | 22             | 40                 |

## Remaining Gaps

1. **No live telephony E2E test** — still the most critical gap before BETA
2. **Cross-tenant credential isolation** — not tested with real multi-tenant setup
3. **VerbBuilder unit tests** — KoreVG verb builder still lacks dedicated unit tests
4. **VXML / AudioCodes** — no test coverage
5. **Voice analytics ClickHouse round-trip** — needs live ClickHouse

## Deviations from Plan

- **Voice transfer gateway** was not in the original LLD — emerged from agent-transfer refactoring
- **TTS preview** was not in the original LLD — added as a sub-feature
- **Grok S2S payload** was not in the original LLD — emerged from S2S voice work
- Softphone redirect routing was a significant behavior change (dial verb -> redirect verb) not anticipated in original plan
