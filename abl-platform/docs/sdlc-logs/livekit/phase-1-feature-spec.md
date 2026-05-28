# SDLC Log: LiveKit — Phase 1 (Feature Spec)

**Date:** 2026-03-23
**Phase:** Feature Spec
**Artifact:** `docs/features/livekit.md`

## Summary

Generated feature spec for the LiveKit Voice Integration feature. The feature covers both WebRTC voice (P0, already in production) and PSTN telephony via LiveKit SIP (P1, to be built).

## Key Findings

1. **Substantial existing implementation**: The WebRTC voice pipeline is fully implemented with agent worker, RuntimeLLMAdapter, voice service factory, trace hooks, Studio preview, and web SDK support.
2. **RFC already exists**: `docs/rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md` provides detailed design for the SIP telephony extension.
3. **Remaining work is telephony-focused**: SIP trunk management, phone number provisioning, call lifecycle, DTMF handling, and Studio telephony UI.
4. **Test coverage gap**: The existing production voice code has minimal test coverage — this is the highest priority gap.

## Decisions

- D1: In-process agent model (not forked processes) — DECIDED
- D2: Deepgram STT + ElevenLabs TTS — DECIDED
- D3: Silero VAD optional (graceful degradation) — DECIDED
- D4: LiveKit SIP (Option A) for telephony — DECIDED
- D5: Twilio as primary SIP trunk provider — DECIDED
- D6: Fire-and-forget agent spawn — DECIDED
- D7: Deferred DB session creation — DECIDED
- D8: Stream-first LLM response — DECIDED
