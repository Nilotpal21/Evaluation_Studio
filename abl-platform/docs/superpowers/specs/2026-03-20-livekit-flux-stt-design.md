# LiveKit Deepgram Flux STT Support

**Date:** 2026-03-20
**Status:** Draft
**Scope:** Backend — LiveKit agent worker, runtime config

## Problem

The LiveKit voice pipeline uses `deepgramPlugin.STT` (v1 API) for all Deepgram models, including Flux. This means:

- Flux model ID gets passed to the v1 API which doesn't support Flux's confidence-based endpointing
- LiveKit relies on Silero VAD for turn detection, ignoring Flux's native end-of-turn capabilities
- No way to leverage Flux's ~260ms semantic turn detection vs VAD's silence-based approach

The KoreVG path already has full Flux support (verb builder, shared constants). The LiveKit path needs equivalent support.

## Design

### 1. Conditional STTv2 in Agent Worker

**File:** `apps/runtime/src/services/voice/livekit/agent-worker.ts`

When the tenant's configured STT model is a Flux model, use `STTv2` instead of `STT`:

```ts
const sttModel = voiceCreds.stt.model || 'nova-3';

if (isFluxModel(sttModel)) {
  stt = new deepgramPlugin.STTv2({
    apiKey: voiceCreds.stt.apiKey,
    model: sttModel,
    eotThreshold: FLUX_DEFAULTS.eotThreshold,
    eagerEotThreshold: FLUX_DEFAULTS.eagerEotThreshold,
    eotTimeoutMs: FLUX_DEFAULTS.eotTimeoutMs,
  });
} else {
  stt = new deepgramPlugin.STT({
    apiKey: voiceCreds.stt.apiKey,
    model: sttModel,
    language: 'en',
  });
}
```

Reuses `isFluxModel()` and `FLUX_DEFAULTS` from `@agent-platform/config` (already used by KoreVG verb builder).

### 2. AgentSession turn_detection

When Flux is active, set `turn_detection: "stt"` on AgentSession so LiveKit defers to Deepgram's confidence-based endpointing instead of its own VAD:

```ts
const session = new voice.AgentSession({
  vad, // undefined when Flux + fluxSkipVad
  stt,
  tts,
  llm: new PipelineLLM(),
  ...(isFlux && { turnDetection: 'stt' }),
});
```

### 3. Configurable VAD Skip

**Env var:** `LIVEKIT_FLUX_SKIP_VAD` (default: `true`)

- `true` — skip Silero VAD when Flux is active (cleaner, avoids two turn-detection systems)
- `false` — load VAD alongside Flux for comparison testing

**File:** `apps/runtime/src/config/index.ts` — add to config schema
**File:** `apps/runtime/.env.example` — document the new env var

### 4. What stays the same

- Nova models: completely untouched, existing `STT` + VAD path
- TTS (ElevenLabs): no changes
- Voice credentials resolution: already returns `model` from tenant config
- No new packages: `STTv2` exists in `@livekit/agents-plugin-deepgram@1.0.44`

## Files Touched

1. `apps/runtime/src/services/voice/livekit/agent-worker.ts` — STT creation + AgentSession config
2. `packages/config/src/schemas/voice.schema.ts` — `fluxSkipVad` field in livekit config schema
3. `apps/runtime/src/config/index.ts` — add `LIVEKIT_FLUX_SKIP_VAD` env mapping
4. `apps/runtime/.env.example` — document new env var

## Testing

- Local LiveKit server (`livekit-server --dev`) + Deepgram free tier
- Toggle `LIVEKIT_FLUX_SKIP_VAD` to compare VAD vs no-VAD behavior with Flux
- Verify Nova models still work unchanged
