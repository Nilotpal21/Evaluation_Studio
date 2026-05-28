# Post-Implementation Sync — Voice Capabilities (Orpheus Enhancement)

**Feature:** `voice-capabilities`  
**Date:** 2026-04-07  
**Status:** COMPLETE

## Scope of This Sync

This pass backfills the shipped Orpheus telephony work into the existing `voice-capabilities` SDLC track rather than creating a separate feature. The implementation was already committed in `[ABLP-209] feat(runtime): add Orpheus streaming and service wiring` (`7ac528be7`) and later merged with `develop`.

## Inputs Reviewed

- Feature doc: `docs/features/voice-capabilities.md`
- Test guide: `docs/testing/voice-capabilities.md`
- HLD: `docs/specs/voice-capabilities.hld.md`
- LLD: `docs/plans/2026-03-22-voice-capabilities-impl-plan.md`
- Implementation commit: `7ac528be7`
- Merge commit: `880c09f2c`

## What Was Synced

### Feature Spec

- Added Orpheus via Groq as a telephony TTS capability under the existing voice feature.
- Documented tenant-scoped admin configuration in `/admin/voice`.
- Documented exact `ttsServiceInstanceId` / `asrServiceInstanceId` selection in voice pipeline channels.
- Added `FR-10` for Orpheus admin/channel wiring.
- Updated KoreVG/Jambonz requirements to describe:
  - buffered `custom_tts_url`
  - optional `custom_tts_streaming_url`
  - per-connection `orpheusWsStreamingEnabled`
- Added new implementation files and configuration surfaces.

### Test Guide

- Added the shipped Orpheus coverage:
  - service-instance resolution
  - channel provisioning + duplicate-label reuse
  - custom HTTP TTS handling
  - custom WS TTS handler
  - Studio provider awareness and speech-provider discovery
- Corrected the testing README summary so it no longer overstates live E2E coverage.
- Recorded the remaining high-priority gap: no automated live telephony/audio quality regression.

### HLD

- Added Orpheus HTTP/WS adapters and resolver to the architecture.
- Added Groq Orpheus and the FreeSWITCH custom TTS streaming module as explicit external dependencies.
- Documented the real transport shape:
  - true streaming at the telephony boundary
  - HTTP-backed upstream to Groq per flush
- Added post-implementation notes for:
  - admin/service-instance flow
  - channel-level WS toggle
  - Jambonz duplicate-label reuse

### LLD

- Updated the current-state table to reflect that Orpheus HTTP/WS runtime paths and Studio provider-awareness work are implemented.
- Replaced outdated generic “zero tests everywhere” gaps with the actual current gaps:
  - no automated live telephony E2E
  - no audio-quality regression harness
  - no live cross-tenant call isolation test
- Added a post-implementation delta section so the plan reflects what actually shipped after the original 2026-03-22 planning pass.

## Coverage Delta

| Area                                  | Before           | After                               |
| ------------------------------------- | ---------------- | ----------------------------------- |
| Orpheus admin/service-instance docs   | Missing          | Documented in feature/HLD/LLD       |
| Channel exact instance selection docs | Missing          | Documented in feature/HLD/LLD       |
| Jambonz duplicate-label reuse docs    | Missing          | Documented in feature/test/HLD/LLD  |
| Orpheus runtime test visibility       | Partial/implicit | Explicitly mapped in test guide     |
| Testing README accuracy               | Overstated       | Corrected to partial/local coverage |

## Remaining Gaps

1. Automated live telephony E2E for Orpheus remains missing.
2. Buffered vs WS streaming audio quality still needs a measurable regression harness.
3. The FreeSWITCH `custom_tts_streaming` dependency remains an external protocol dependency outside this repo.
4. No live non-PSTN/wideband validation exists yet for the Orpheus WS path.

## Outcome

The `voice-capabilities` SDLC artifacts now reflect the shipped Orpheus work accurately enough for:

- admin configuration walkthroughs
- channel configuration walkthroughs
- manual buffered vs streaming comparison in dev
- future follow-up work to focus on measurable telephony-quality and E2E coverage rather than rediscovering the architecture
