# Feature Test Guide: Voice Capabilities

**Feature**: Voice pipeline (LiveKit, Twilio, KoreVG/Jambonz, VXML, AudioCodes), ASR, TTS, DTMF, barge-in, voice tracing
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/voice-capabilities.md](../features/voice-capabilities.md)
**First tested**: 2026-03-18
**Last updated**: 2026-04-14
**Overall status**: BETA — Voice subsystem has strong unit and local integration coverage, including Orpheus admin/channel/runtime wiring, LiveDial softphone (with insecure-context guards), a headless/browser-driven softphone automation harness for scripted outbound calls and multi-turn scenarios, TTS preview, Grok S2S payload, voice transfer gateway, and voice analytics routes. Still no CI-stable or transcript-asserting end-to-end telephony/audio quality test against live infrastructure

---

## Current State (as of 2026-04-14)

The voice subsystem has extensive unit and integration test coverage for individual components (LiveKit agent worker, LLM adapter, routes, trace hooks, mode resolver, credential cache, Twilio service, ElevenLabs timeout, Jambonz provisioning, Orpheus admin/channel/runtime wiring, Grok S2S payload, S2S verb builder, TTS preview, voice analytics routes, LiveKit voice pipeline integration). It now also has a **local automated softphone path** for scripted outbound calls: a headless Chromium runner can reuse the existing Studio softphone registration flow, inject prerecorded caller audio, detect returned remote audio, and surface a machine-readable result snapshot. The same harness now supports scripted multi-turn playback with remote-speech and remote-silence gating plus optional DTMF steps. See [docs/testing/sub-features/softphone-headless-automation.md](./sub-features/softphone-headless-automation.md). The `livekit-voice.integration.test.ts` tests the full LLM adapter pipeline with mock Anthropic client but real DSL compilation. Recent additions since April 7 include KoreVG Grok routing tests, TTS preview schema tests, voice analytics route tests, S2S event handler tests, realtime tool-call tests, a LiveKit voice pipeline integration test, and the headless softphone automation harness.

### Quick Health Dashboard

| Area                              | Status      | Last Verified | Notes                                                                |
| --------------------------------- | ----------- | ------------- | -------------------------------------------------------------------- |
| LiveKit Token Generation          | UNIT        | 2026-03-18    | `livekit-routes.test.ts` — validation, concurrency, auth             |
| LiveKit Agent Worker              | UNIT        | 2026-03-18    | `livekit-agent-worker.test.ts` — metadata parsing, helpers           |
| LiveKit LLM Adapter               | UNIT        | 2026-03-18    | `livekit-llm-adapter.test.ts` — init, chat, timeout                  |
| LiveKit Integration Flow          | INTEGRATION | 2026-03-18    | `livekit-voice-e2e.test.ts` — mocked external deps                   |
| Voice Pipeline Tracing            | UNIT        | 2026-03-18    | `voice-pipeline-trace.test.ts` — STT/LLM/TTS phases                  |
| Realtime Voice Tracing            | UNIT        | 2026-03-18    | `voice-realtime-trace.test.ts` — turn lifecycle                      |
| Voice Mode Resolver               | UNIT        | 2026-03-18    | `voice-mode-resolver.test.ts` — priority chain                       |
| Voice Credential Cache            | UNIT        | 2026-03-18    | `voice-credential-cache.test.ts` — set/get/invalidate                |
| Twilio Webhook Signature          | UNIT        | 2026-03-18    | `voice-twilio-sig.test.ts` — HMAC validation                         |
| Twilio Service                    | UNIT        | 2026-03-18    | `twilio-service.test.ts` — config, tokens                            |
| ElevenLabs TTS                    | UNIT        | 2026-03-18    | `elevenlabs-stream-timeout.test.ts` — timeout handling               |
| Jambonz Provisioning              | UNIT        | 2026-03-18    | `jambonz-provisioning.service.test.ts` — API operations              |
| Orpheus Service Resolution        | UNIT        | 2026-04-07    | `voice-service-factory.test.ts` — tenant service instance resolution |
| Orpheus Custom HTTP TTS           | UNIT        | 2026-04-07    | `orpheus-tts.test.ts` — WAV/PCM parsing and chunking                 |
| Orpheus Custom WS Handler         | UNIT        | 2026-04-07    | `orpheus-custom-tts-handler.test.ts` — connect/stream/flush flow     |
| Channel Provider Awareness (UI)   | UNIT        | 2026-04-07    | `channel-provider-awareness.test.tsx` — selected vendor wiring       |
| Speech Provider Discovery (UI)    | UNIT        | 2026-04-07    | `speech-providers.test.ts` — `custom:orpheus` discovery              |
| Realtime Voice Executor           | UNIT        | 2026-03-18    | `realtime-voice-executor.test.ts` — tool routing                     |
| Realtime Tool Call Execution      | UNIT        | 2026-04-01    | `realtime-tool-call.test.ts` — realtime tool dispatch                |
| Voice Prompt Building             | UNIT        | 2026-03-18    | `prompt-builder-voice.test.ts` — voice prompts                       |
| Voice Ingress Auth                | UNIT        | 2026-03-18    | `channel-voice-ingress-auth.test.ts` — auth tokens                   |
| Twilio WebSocket Auth             | UNIT        | 2026-03-18    | `ws-twilio-auth.test.ts` — WS auth                                   |
| Twilio Media Handler              | UNIT        | 2026-03-18    | `ws-twilio-handler.test.ts` — media stream handling                  |
| Voice Trace Platform              | UNIT        | 2026-03-18    | `observability/voice-trace-platform.test.ts` — platform integration  |
| KoreVG Grok LLM Payload           | UNIT        | 2026-04-13    | `korevg-router-grok.test.ts` — Grok payload routing via KoreVG       |
| S2S Google Event Handler          | UNIT        | 2026-04-08    | `s2s-google-event-handler.test.ts` — Google S2S event handling       |
| S2S LLM Verb Builder              | UNIT        | 2026-04-08    | `s2s-llm-verb-builder.test.ts` — S2S verb construction               |
| TTS Preview Schema                | UNIT        | 2026-04-11    | `tts-preview.test.ts` — schema validation, rate limit config         |
| Custom TTS Route                  | UNIT        | 2026-04-11    | `custom-tts-route.test.ts` — custom TTS endpoint                     |
| TTS Message Handlers              | UNIT        | 2026-03-27    | `tts-message-handlers.test.ts` — TTS message handling                |
| Voice Analytics Routes            | UNIT        | 2026-04-11    | `voice-analytics-route.test.ts` — analytics route handlers           |
| Voice Analytics OpenAPI           | UNIT        | 2026-04-11    | `voice-analytics.openapi-contract.test.ts` — OpenAPI contract        |
| LiveKit Voice Pipeline            | INTEGRATION | 2026-04-14    | `livekit-voice.integration.test.ts` — full LLM adapter chain         |
| Headless LiveDial Automation      | LOCAL E2E   | 2026-04-22    | `softphone-automation-runner.ts` + `/softphone-automation` page      |
| Orpheus Pipeline E2E              | E2E         | 2026-04-11    | `voice-pipeline-orpheus.e2e.test.ts` — Orpheus pipeline flow         |
| Voice Filler Adapter              | UNIT        | 2026-03-27    | `voice-filler-adapter.test.ts` — filler message adapter              |
| Voice Filler Integration          | INTEGRATION | 2026-03-27    | `voice-filler-integration.test.ts` — filler message integration      |
| Voice IR Resolution               | E2E         | 2026-03-27    | `voice-ir-resolution.e2e.test.ts` — IR resolution flow               |
| Voice Config Integration          | INTEGRATION | 2026-03-27    | `voice-config-integration.test.ts` — config integration              |
| Voice Service Instance Repo       | UNIT        | 2026-03-27    | `voice-service-instance-repo.test.ts` — service instance repo        |
| Voice E2E Caller Audio Route      | E2E         | 2026-03-27    | `voice-e2e-caller-audio-route.test.ts` — caller audio route          |
| Full E2E Voice Call               | —           | Not tested    | No real audio E2E test exists                                        |
| Cross-Tenant Credential Isolation | —           | Not tested    | Needs multi-tenant setup                                             |
| DTMF Collection                   | —           | Not tested    | KoreVG gather verb only                                              |
| Barge-In Handling                 | —           | Not tested    | KoreVG config verb only                                              |
| VXML IVR Response                 | —           | Not tested    | Sync XML response flow                                               |
| AudioCodes Bot API                | —           | Not tested    | Webhook + WS flow                                                    |
| Voice Analytics (ClickHouse)      | —           | Not tested    | Full ClickHouse round-trip still needs live infra                    |

---

## Audit Scope

This guide covers:

- LiveKit/browser voice plumbing, route validation, and pipeline integration
- Voice pipeline tracing, realtime tracing, and mode resolution
- Credential caching and webhook/auth behavior
- Provider-specific unit coverage for Twilio, ElevenLabs, Jambonz provisioning, and Orpheus
- Grok S2S payload routing and verb building
- TTS preview schema validation and route testing
- Voice analytics route handlers and OpenAPI contract testing
- Voice filler messages, IR resolution, and config integration
- Softphone insecure-context guards (crypto.randomUUID fallback, getUserMedia check)

It does not yet prove a full live audio round-trip through real telephony or WebRTC infrastructure.

---

## Coverage Goals

This feature will be meaningfully covered when the repo proves all of the following:

- At least one real voice ingress path works end to end without mocked media infrastructure
- Cross-tenant credential isolation is verified across the voice credential cache and session flows
- KoreVG/VXML/AudioCodes response builders are directly validated
- Voice analytics and trace persistence are exercised with their real downstream dependencies

---

## Test Coverage Map

### LiveKit Integration

- [x] Token generation with valid credentials — `livekit-routes.test.ts`
- [x] 400 on invalid sessionId/projectId patterns — `livekit-routes.test.ts`
- [x] 429 when max concurrent rooms reached — `livekit-routes.test.ts`
- [x] 503 when LiveKit not configured — `livekit-routes.test.ts`
- [x] 403 when tenant context missing — `livekit-routes.test.ts`
- [x] Capabilities endpoint (enabled/configured status) — `livekit-routes.test.ts`
- [x] Agent worker metadata validation (valid/invalid JSON) — `livekit-agent-worker.test.ts`
- [x] `parseAndValidateMetadata` rejects path traversal — `livekit-agent-worker.test.ts`
- [x] `findLastUserMessage` extracts from ChatContext — `livekit-agent-worker.test.ts`
- [x] `createTextStream` creates readable stream — `livekit-agent-worker.test.ts`
- [x] RuntimeLLMAdapter initialization (deployment + legacy paths) — `livekit-llm-adapter.test.ts`
- [x] RuntimeLLMAdapter.chat() with timeout — `livekit-llm-adapter.test.ts`
- [x] RuntimeLLMAdapter DSL cache behavior — `livekit-llm-adapter.test.ts`
- [x] Integration flow with mocked LiveKit SDK — `livekit-voice-e2e.test.ts`
- [x] LiveKit voice pipeline integration (real DSL, mock Anthropic) — `livekit-voice.integration.test.ts`
- [ ] True E2E: browser -> LiveKit room -> agent -> audio out — Not tested
- [ ] Agent spawn failure recovery — Not tested (E2E)
- [ ] Room disconnect and cleanup — Not tested (E2E)
- [ ] Concurrent rooms across tenants — Not tested (E2E)

### Voice Pipeline Tracing

- [x] `startVoiceTurn` creates OTEL span and context — `voice-pipeline-trace.test.ts`
- [x] `startSTTPhase` / `completeSTTPhase` tracking — `voice-pipeline-trace.test.ts`
- [x] `startLLMPhase` / `completeLLMPhase` tracking — `voice-pipeline-trace.test.ts`
- [x] `startTTSPhase` / `recordTTSFirstChunk` / `completeTTSPhase` — `voice-pipeline-trace.test.ts`
- [x] `completeVoiceTurn` timing breakdown calculation — `voice-pipeline-trace.test.ts`
- [x] `failVoiceTurn` error handling and span cleanup — `voice-pipeline-trace.test.ts`
- [x] Platform tracer event emission — `voice-pipeline-trace.test.ts`
- [ ] Trace persistence to TraceStore — Not tested (integration)
- [ ] Trace export to ClickHouse — Not tested (integration)

### Realtime Voice

- [x] `startRealtimeVoiceTurn` context creation — `voice-realtime-trace.test.ts`
- [x] `recordRealtimeFirstAudioOut` latency tracking — `voice-realtime-trace.test.ts`
- [x] `recordRealtimeToolCall` accumulation — `voice-realtime-trace.test.ts`
- [x] `completeRealtimeVoiceTurn` breakdown — `voice-realtime-trace.test.ts`
- [x] `failRealtimeVoiceTurn` error handling — `voice-realtime-trace.test.ts`
- [x] Realtime voice executor tool routing — `realtime-voice-executor.test.ts`
- [x] Transcript capture in realtime mode — `realtime-voice-executor.test.ts`
- [x] Realtime tool call dispatch — `realtime-tool-call.test.ts`
- [ ] True realtime model (GPT-4o Realtime API) integration — Not tested

### Voice Mode Resolution

- [x] Default mode is `pipeline` — `voice-mode-resolver.test.ts`
- [x] Deployment explicit config overrides — `voice-mode-resolver.test.ts`
- [x] Agent `voice_optimized` hint + tenant capability — `voice-mode-resolver.test.ts`
- [x] Global config mode selection — `voice-mode-resolver.test.ts`
- [x] `REALTIME_VOICE_ENABLED=false` kill switch — `voice-mode-resolver.test.ts`
- [x] Fallback when tenant lacks realtime model — `voice-mode-resolver.test.ts`

### Credential Management

- [x] `VoiceCredentialCache.set` with TTL clamping — `voice-credential-cache.test.ts`
- [x] `VoiceCredentialCache.get` cache hit/miss — `voice-credential-cache.test.ts`
- [x] `VoiceCredentialCache.invalidate` per-call — `voice-credential-cache.test.ts`
- [x] `VoiceCredentialCache.invalidateByTenant` with SCAN — `voice-credential-cache.test.ts`
- [ ] `VoiceServiceFactory.resolveVoiceCredentials` with real DB — Not tested (E2E)
- [ ] Auth Profile dual-read path — Not tested (integration)
- [ ] Cache invalidation via Redis pub/sub — Not tested (integration)

### Twilio

- [x] Twilio service configuration validation — `twilio-service.test.ts`
- [x] Access token generation — `twilio-service.test.ts`
- [x] TwiML generation with stream URL — `twilio-service.test.ts`
- [x] Webhook signature validation (HMAC) — `voice-twilio-sig.test.ts`
- [x] Signature rejection for missing header — `voice-twilio-sig.test.ts`
- [x] Signature rejection for invalid signature — `voice-twilio-sig.test.ts`
- [x] Twilio WebSocket authentication — `ws-twilio-auth.test.ts`
- [x] Twilio media stream handling — `ws-twilio-handler.test.ts`
- [ ] Full Twilio call lifecycle (connect → media → status → end) — Not tested (E2E)
- [ ] Phone number purchase flow — Not tested (E2E)

### TTS (ElevenLabs)

- [x] Stream timeout handling — `elevenlabs-stream-timeout.test.ts`
- [ ] Streaming synthesis end-to-end — Not tested (requires API key)
- [ ] Voice ID resolution from tenant config — Not tested
- [ ] Audio format options (ulaw_8000, pcm, mp3) — Not tested

### Jambonz/KoreVG

- [x] Jambonz provisioning API operations — `jambonz-provisioning.service.test.ts`
- [x] Duplicate-label speech credential reuse + DID registration path — `channel-connections-voice-patch.test.ts`
- [x] Orpheus WS streaming mode resolution (`orpheusWsStreamingEnabled`) — `korevg-session-orpheus-streaming.test.ts`
- [x] Orpheus custom streaming WS contract (connect ack, stream, flush, stop) — `orpheus-custom-tts-handler.test.ts`
- [x] Headless LiveDial automation with prerecorded WAV input — `apps/studio/e2e/softphone-automation-runner.ts` + `apps/studio/src/app/softphone-automation/page.tsx`
- [ ] KoreVG WebSocket session lifecycle — Not tested
- [ ] Verb builder (say, gather, hangup, config) — Not tested (unit)
- [ ] Barge-in configuration and detection — Not tested
- [ ] DTMF digit collection via gather verb — Not tested
- [ ] Live telephony audio quality comparison (buffered vs streaming) — Manual only, not automated
- [ ] Homer/RTCP network quality integration — Not tested

### Softphone / LiveDial

- [x] Existing Studio softphone registration/config path reused for automation — `apps/studio/src/hooks/useSoftphone.ts`
- [x] Headless browser flow can inject a prerecorded WAV as microphone input — `apps/studio/e2e/softphone-automation-runner.ts`
- [x] Automation page exposes machine-readable status and completion state — `apps/studio/src/app/softphone-automation/page.tsx`
- [ ] Transcript/content assertions — Not tested
- [ ] DTMF flows — Not tested
- [ ] CI/nightly execution — Not tested

### Grok / S2S Voice

- [x] KoreVG Grok LLM payload routing — `korevg-router-grok.test.ts`
- [x] S2S Google event handler — `s2s-google-event-handler.test.ts`
- [x] S2S LLM verb builder — `s2s-llm-verb-builder.test.ts`
- [ ] Live Grok S2S telephony round-trip — Not tested (E2E)

### TTS Preview

- [x] TTS preview request schema validation (ElevenLabs + Orpheus) — `tts-preview.test.ts`
- [x] TTS preview rate limit and max chars config — `tts-preview.test.ts`
- [x] Custom TTS route endpoint — `custom-tts-route.test.ts`
- [x] TTS message handlers — `tts-message-handlers.test.ts`
- [ ] TTS preview live synthesis (requires API keys) — Not tested (E2E)

### Voice Analytics Routes

- [x] Voice analytics route handlers — `voice-analytics-route.test.ts`
- [x] Voice analytics OpenAPI contract — `voice-analytics.openapi-contract.test.ts`
- [ ] Voice analytics ClickHouse round-trip — Not tested (requires ClickHouse)

### Voice Filler Messages

- [x] Voice filler adapter — `voice-filler-adapter.test.ts`
- [x] Voice filler integration — `voice-filler-integration.test.ts`

### Voice Config and IR Resolution

- [x] Voice config integration — `voice-config-integration.test.ts`
- [x] Voice IR resolution E2E — `voice-ir-resolution.e2e.test.ts`
- [x] Voice service instance repo — `voice-service-instance-repo.test.ts`
- [x] Voice E2E caller audio route — `voice-e2e-caller-audio-route.test.ts`

### Orpheus Pipeline E2E

- [x] Orpheus pipeline E2E flow — `voice-pipeline-orpheus.e2e.test.ts`

### Admin / Channel Voice Configuration

- [x] `/admin/voice` exposes `custom:orpheus` as a TTS provider — `speech-providers.test.ts`
- [x] Voice pipeline channel persists `ttsServiceInstanceId` / `asrServiceInstanceId` — `channel-provider-awareness.test.tsx`
- [x] Voice pipeline channel persists Orpheus WS streaming toggle — `channel-provider-awareness.test.tsx`
- [x] Runtime provisioning uses selected Orpheus service instance in custom URLs — `channel-connections-voice-patch.test.ts`
- [ ] End-to-end Studio UI smoke test for admin -> channel -> live call — Not automated

### VXML IVR

- [ ] VXML 2.1 response generation — Not tested
- [ ] Barge-in configuration — Not tested
- [ ] No-match / no-input retry handling — Not tested
- [ ] Synchronous webhook response flow — Not tested

### AudioCodes

- [ ] Conversation creation webhook — Not tested
- [ ] Activity processing — Not tested
- [ ] WebSocket message delivery — Not tested
- [ ] Disconnect handling — Not tested

### Voice Quality & Analytics

- [ ] ASR quality scoring (repetition, hesitation, correction) — Not tested (unit exists in observability tests)
- [ ] ASR cascade failure detection — Not tested (unit exists in observability tests)
- [ ] Voice analytics hourly aggregation — Not tested (requires ClickHouse)
- [ ] Voice analytics summary KPIs — Not tested (requires ClickHouse)

### Voice Prompt Building

- [x] Voice-specific prompt building — `prompt-builder-voice.test.ts`
- [x] Voice channel ingress authentication — `channel-voice-ingress-auth.test.ts`

---

## Test Files Index

| File                                                                          | Type        | Scenarios                                               |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------------------------------- |
| `apps/runtime/src/__tests__/livekit-voice-e2e.test.ts`                        | integration | LiveKit full flow with mocked SDK                       |
| `apps/runtime/src/__tests__/livekit-agent-worker.test.ts`                     | unit        | Metadata validation, helpers, text streams              |
| `apps/runtime/src/__tests__/livekit-routes.test.ts`                           | unit        | Token gen, capabilities, validation, concurrency        |
| `apps/runtime/src/__tests__/livekit-llm-adapter.test.ts`                      | unit        | Adapter init (deployment + legacy), chat, timeout       |
| `apps/runtime/src/__tests__/voice-pipeline-trace.test.ts`                     | unit        | Pipeline trace phases and timing breakdown              |
| `apps/runtime/src/__tests__/voice-realtime-trace.test.ts`                     | unit        | Realtime trace lifecycle                                |
| `apps/runtime/src/__tests__/voice-mode-resolver.test.ts`                      | unit        | Mode resolution priority chain                          |
| `apps/runtime/src/__tests__/voice-credential-cache.test.ts`                   | unit        | Redis credential cache CRUD                             |
| `apps/runtime/src/__tests__/voice-twilio-sig.test.ts`                         | unit        | Twilio HMAC webhook signature                           |
| `apps/runtime/src/__tests__/twilio-service.test.ts`                           | unit        | Twilio config, tokens, TwiML                            |
| `apps/runtime/src/__tests__/elevenlabs-stream-timeout.test.ts`                | unit        | ElevenLabs streaming timeout                            |
| `apps/runtime/src/__tests__/jambonz-provisioning.service.test.ts`             | unit        | Jambonz API provisioning                                |
| `apps/runtime/src/__tests__/channels/channel-connections-voice-patch.test.ts` | unit        | Orpheus provisioning, duplicate label reuse, DID wiring |
| `apps/runtime/src/__tests__/channels/voice-service-factory.test.ts`           | unit        | Tenant-scoped Orpheus service instance resolution       |
| `apps/runtime/src/__tests__/korevg-session-orpheus-streaming.test.ts`         | unit        | KoreVG WS toggle path for Orpheus                       |
| `apps/runtime/src/__tests__/services/orpheus-tts.test.ts`                     | unit        | Orpheus WAV/PCM parsing and chunk chunking              |
| `apps/runtime/src/__tests__/websocket/orpheus-custom-tts-handler.test.ts`     | unit        | Orpheus custom streaming socket contract                |
| `apps/runtime/src/__tests__/realtime-voice-executor.test.ts`                  | unit        | Realtime executor tool routing                          |
| `apps/runtime/src/__tests__/prompt-builder-voice.test.ts`                     | unit        | Voice prompt construction                               |
| `apps/runtime/src/__tests__/channel-voice-ingress-auth.test.ts`               | unit        | Voice ingress auth tokens                               |
| `apps/runtime/src/__tests__/ws-twilio-auth.test.ts`                           | unit        | Twilio WS authentication                                |
| `apps/runtime/src/__tests__/ws-twilio-handler.test.ts`                        | unit        | Twilio media stream handler                             |
| `apps/runtime/src/__tests__/observability/voice-trace-platform.test.ts`       | unit        | Voice trace platform hooks                              |
| `apps/runtime/src/__tests__/channels/korevg-router-grok.test.ts`              | unit        | KoreVG Grok LLM payload routing                         |
| `apps/runtime/src/__tests__/s2s-google-event-handler.test.ts`                 | unit        | Google S2S event handling                               |
| `apps/runtime/src/__tests__/s2s-llm-verb-builder.test.ts`                     | unit        | S2S LLM verb construction                               |
| `apps/runtime/src/__tests__/routes/tts-preview.test.ts`                       | unit        | TTS preview schema, rate limits                         |
| `apps/runtime/src/__tests__/routes/custom-tts-route.test.ts`                  | unit        | Custom TTS route endpoint                               |
| `apps/runtime/src/__tests__/tts-message-handlers.test.ts`                     | unit        | TTS message handling                                    |
| `apps/runtime/src/__tests__/routes/voice-analytics-route.test.ts`             | unit        | Voice analytics route handlers                          |
| `apps/runtime/src/__tests__/routes/voice-analytics.openapi-contract.test.ts`  | unit        | Voice analytics OpenAPI contract                        |
| `apps/runtime/src/__tests__/channels/livekit-voice.integration.test.ts`       | integration | LiveKit voice pipeline (real DSL, mock Anthropic)       |
| `apps/runtime/src/__tests__/channels/voice-pipeline-orpheus.e2e.test.ts`      | e2e         | Orpheus pipeline E2E flow                               |
| `apps/runtime/src/__tests__/channels/voice-filler-adapter.test.ts`            | unit        | Voice filler message adapter                            |
| `apps/runtime/src/__tests__/channels/voice-filler-integration.test.ts`        | integration | Voice filler integration flow                           |
| `apps/runtime/src/__tests__/channels/voice-ir-resolution.e2e.test.ts`         | e2e         | Voice IR resolution flow                                |
| `apps/runtime/src/__tests__/channels/voice-config-integration.test.ts`        | integration | Voice config integration                                |
| `apps/runtime/src/__tests__/channels/voice-service-instance-repo.test.ts`     | unit        | Voice service instance repo                             |
| `apps/runtime/src/__tests__/channels/voice-e2e-caller-audio-route.test.ts`    | e2e         | Caller audio routing E2E                                |
| `apps/runtime/src/__tests__/execution/realtime-tool-call.test.ts`             | unit        | Realtime tool call dispatch                             |

---

## Testing Gaps & Recommendations

### High Priority

1. **Automated telephony E2E for Orpheus**: Add an end-to-end test that proves a real inbound call routes through Jambonz/KoreVG, resolves the selected Orpheus service instance, and produces audible media on the call leg.

2. **KoreVG Verb Builder Unit Tests**: The verb builder (`korevg/verb-builder.ts`) constructs Jambonz responses (say, gather, hangup, config) but has no dedicated unit tests. These are critical for correct DTMF and barge-in behavior.

3. **Cross-Tenant Credential Isolation**: Test that tenant A's voice credentials cannot be used for tenant B's sessions, especially with the `VoiceServiceFactory` caching layer and explicit `ttsServiceInstanceId` selection.

### Medium Priority

4. **Streaming Audio Quality Regression**: Add an automated regression harness for Orpheus buffered vs WS streaming transport quality so the remaining word-level distortion issue becomes measurable.

5. **VXML Response Generation**: Unit tests for VXML 2.1 XML output including barge-in configuration, no-match/no-input retry handling.

6. **AudioCodes Bot API**: Integration test for the AudioCodes webhook → WebSocket delivery flow.

7. **Voice Analytics**: Test hourly aggregation and summary KPI queries against a ClickHouse test instance.

8. **Credential Rotation**: Integration test verifying that Redis pub/sub invalidation propagates across runtime instances when voice auth profiles are updated.

### Low Priority

8. **Voice Quality Analyzer**: While the analyzer has some coverage in observability tests, dedicated tests for each signal (repetition, hesitation, correction, clarity, confidence) with edge cases would improve confidence.

9. **ASR Cascade Detection**: Test cascade detection with simulated network quality degradation data from Homer.

10. **Phone Number Management**: E2E test for Twilio phone number listing, search, and purchase (requires Twilio test credentials).

---

## How to Run Voice Tests

```bash
# All voice-related tests
pnpm test --filter=runtime -- --grep="voice|livekit|twilio|elevenlabs|jambonz"

# Specific test file
pnpm test --filter=runtime -- apps/runtime/src/__tests__/livekit-routes.test.ts

# Build first (required for type checking)
pnpm build --filter=runtime
```

### Prerequisites

- No external services needed for unit tests (all mocked)
- Redis needed for `voice-credential-cache.test.ts` (uses mock Redis)
- No LiveKit, Deepgram, ElevenLabs, or Twilio accounts needed for existing tests

---

## References

- Related feature doc: [docs/features/voice-capabilities.md](../features/voice-capabilities.md)
- Adjacent feature docs: [docs/features/channels.md](../features/channels.md), [docs/features/tracing-observability.md](../features/tracing-observability.md), [docs/features/auth-profiles.md](../features/auth-profiles.md)
