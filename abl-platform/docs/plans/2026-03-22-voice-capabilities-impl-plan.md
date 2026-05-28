# Voice Capabilities — LLD & Implementation Plan

**Feature:** Voice Capabilities (#33)
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-04-14
**Inputs:** [Feature Spec](../features/voice-capabilities.md) | [Test Spec](../testing/voice-capabilities.md) | [HLD](../specs/voice-capabilities.hld.md)

---

## Overview

This LLD translates the voice capabilities HLD into a phased implementation plan. The voice subsystem already has substantial production code; this plan focuses on hardening, test coverage, gap closure, and production readiness.

### Current State Assessment

| Subsystem                           | Code Exists | Unit Tests | Integration Tests | E2E Tests | Status            |
| ----------------------------------- | ----------- | ---------- | ----------------- | --------- | ----------------- |
| VoiceClient (web-sdk)               | Yes         | No         | No                | No        | Needs tests       |
| VoiceWidget (web-sdk)               | Yes         | No         | No                | No        | Needs tests       |
| VADAdapter (web-sdk)                | Yes         | No         | No                | No        | Needs tests       |
| RealtimeAudioPlayer (web-sdk)       | Yes         | No         | No                | No        | Needs tests       |
| TwilioAdapter (web-sdk)             | Yes         | No         | No                | No        | Needs tests       |
| VoicePipeline (runtime)             | Yes         | No         | No                | No        | Needs tests       |
| DeepgramService (runtime)           | Yes         | No         | No                | No        | Needs tests       |
| ElevenLabsService (runtime)         | Yes         | No         | No                | No        | Needs tests       |
| TwilioService (runtime)             | Yes         | Partial    | No                | No        | Needs more tests  |
| VoiceServiceFactory (runtime)       | Yes         | Yes        | No                | No        | Improved          |
| VoiceModeResolver (runtime)         | Yes         | Yes (90%)  | No                | No        | Complete          |
| VoiceCredentialCache (runtime)      | Yes         | Yes (80%)  | No                | No        | Needs integration |
| VoiceSessionResolver (runtime)      | Yes         | No         | No                | No        | Needs tests       |
| RealtimeVoiceExecutor (runtime)     | Yes         | No         | No                | No        | Needs tests       |
| LiveKit Agent Worker (runtime)      | Yes         | No         | No                | No        | Needs tests       |
| LiveKit LLM Adapter (runtime)       | Yes         | No         | No                | No        | Needs tests       |
| KoreVG Router (runtime)             | Yes         | No         | No                | No        | Needs tests       |
| KoreVG VerbBuilder (runtime)        | Yes         | No         | No                | No        | Needs tests       |
| Orpheus HTTP TTS (runtime)          | Yes         | Yes        | No                | No        | Implemented       |
| Orpheus WS TTS (runtime)            | Yes         | Yes        | Manual only       | No        | Implemented       |
| Channel provider awareness (studio) | Yes         | Yes        | No                | No        | Implemented       |
| OpenAI Realtime (compiler)          | Yes         | Partial    | No                | No        | Needs more tests  |
| Gemini Live (compiler)              | Yes         | Partial    | No                | No        | Needs more tests  |
| Ultravox (compiler)                 | Yes         | Partial    | No                | No        | Needs more tests  |
| Voice Trace Hooks (runtime)         | Yes         | Yes (70%)  | No                | No        | Needs integration |
| SDK WS Handler (voice msgs)         | Yes         | Partial    | No                | No        | Needs E2E         |

### Key Gaps Identified

1. **No automated live telephony E2E tests** for any voice path
2. **No automated audio-quality regression** for buffered vs WS telephony transport
3. **No STT/TTS provider fallback** — single point of failure per provider
4. **No audio recording storage** — compliance gap for some regimes
5. **Missing VerbBuilder unit tests** — KoreVG telephony path remains undertested
6. **No voice session checkpoint** — pod crash loses in-progress calls
7. **No cross-tenant live call isolation test** — security-critical gap
8. **Realtime executor tool routing needs broader coverage under live media**

---

## Post-Implementation Delta (2026-04-07)

The following work shipped after this original LLD was authored:

- Added tenant-scoped `custom:orpheus` support in `/admin/voice` and service-instance APIs
- Added exact `ttsServiceInstanceId` / `asrServiceInstanceId` selection in voice pipeline channel configuration
- Added Orpheus buffered HTTP TTS and optional WS streaming for KoreVG/Jambonz telephony paths
- Added Jambonz provisioning support for `custom_tts_url` and `custom_tts_streaming_url`
- Fixed duplicate-label speech credential reuse so DID registration continues even when a prior Orpheus credential already exists

These shipped deltas mean the original plan is now partially complete for the Orpheus sub-area, but the remaining gaps above still need explicit follow-through before the broader voice feature can be treated as production-complete.

### Post-Implementation Delta (2026-04-14)

Additional work shipped since the April 7 delta:

- **ABLP-189**: Softphone insecure-context guards — `crypto.randomUUID` fallback and `getUserMedia` pre-check in `useSoftphone.ts`
- **Softphone call webhook redirect**: `/call` webhook now returns Jambonz `redirect` verb to the phone number's configured application, routing outbound calls through the same agent logic as inbound
- **KoreVG CORS**: Voice endpoints accept server-to-server calls from KoreVG feature-server origins (token-authenticated)
- **S2S voice tool trace fixes**: Defensive fallbacks for Google S2S tool call extraction, Grok temperature forwarding, analytics vendor labeling
- **TTS Preview**: Generalized `/api/v1/voice/tts-preview` endpoint supporting ElevenLabs and Orpheus (Groq), with Studio UI
- **Voice Transfer Gateway**: Abstract `VoiceGatewaySession` interface in `@agent-platform/agent-transfer` for provider-agnostic call transfers (SIP REFER, PSTN dial, human agent bridge)
- **Grok S2S Payload**: `grok-llm-payload.ts` for KoreVG sessions using Grok LLM directly
- **LiveKit voice pipeline integration test**: `livekit-voice.integration.test.ts` using real DSL compilation with mock Anthropic client
- **Voice analytics route tests**: `voice-analytics-route.test.ts` and OpenAPI contract test
- **Test coverage expanded**: 11 new test files added covering KoreVG Grok routing, S2S handlers, TTS preview, voice analytics, and realtime tool calls

---

## Phase 1: Foundation Tests & VerbBuilder Hardening

**Duration:** 1 sprint (1 week)
**Focus:** Unit tests for untested voice components, VerbBuilder robustness

### Tasks

#### 1.1 VerbBuilder Unit Tests

**File:** `apps/runtime/src/__tests__/verb-builder.test.ts`

Test all verb construction paths:

- `buildSayVerb(text, options)` — plain text, SSML, streaming, with/without synthesizer
- `buildGatherVerb(options)` — speech input, DTMF input, combined, with say prompt
- `buildConfigVerb(options)` — synthesizer config, recognizer config, both
- `buildHangupVerb()` — basic hangup
- `buildListenVerb(url, options)` — audio stream URL, mix type
- SIP header sanitization in verbs (no injection)
- Empty/null text handling (no empty say verbs)
- DTMF-specific fields: numDigits, maxDigits, finishOnKey, interDigitTimeout

**Implementation Details:**

```typescript
// verb-builder.test.ts structure
describe('VerbBuilder', () => {
  describe('buildSayVerb', () => {
    test('plain text produces say verb with text field');
    test('SSML text produces say verb with ssml field');
    test('streaming flag sets stream=true');
    test('synthesizer config includes vendor and voice');
    test('empty text returns null (no empty say)');
  });

  describe('buildGatherVerb', () => {
    test('speech input sets input=["speech"]');
    test('DTMF input sets input=["digits"]');
    test('combined sets input=["speech","digits"]');
    test('numDigits/finishOnKey set on DTMF gather');
    test('bargein flag controls bargein field');
    test('timeout/speechTimeout are configurable');
  });

  describe('SIP header sanitization', () => {
    test('strips CRLF injection attempts');
    test('strips null bytes');
    test('preserves valid SIP headers');
  });
});
```

#### 1.2 VoiceServiceFactory Unit Tests

**File:** `apps/runtime/src/__tests__/voice-service-factory.test.ts`

- Factory returns null when no TenantServiceInstance exists
- Factory decrypts credentials via EncryptionService
- Factory caches services per tenant (10-minute TTL)
- Cache invalidation by tenant removes all entries
- Cache invalidation by service type removes specific entry
- Concurrent getSTTService calls do not cause double creation
- Auth profile dual-read path is exercised

#### 1.3 VoiceSessionResolver Unit Tests

**File:** `apps/runtime/src/__tests__/voice-session-resolver.test.ts`

- Resolves to pipeline mode when no realtime model available
- Resolves to realtime mode when deployment config + tenant model
- Returns error when deployment explicitly requests realtime but no model
- Creates RealtimeVoiceExecutor for realtime mode
- Returns pipeline with reason when kill switch is active
- Logs one structured entry per resolution

#### 1.4 DeepgramService Unit Tests

**File:** `apps/runtime/src/__tests__/deepgram-service.test.ts`

- isConfigured() returns false without API key
- createConnection() opens WebSocket to Deepgram API (mock WebSocket)
- Connection.send(audio) forwards to WebSocket
- Transcription callback fires with parsed result
- Error callback fires on WebSocket error
- Connection.close() cleanly terminates

#### 1.5 ElevenLabsService Unit Tests

**File:** `apps/runtime/src/__tests__/elevenlabs-service.test.ts`

- isConfigured() returns false without API key
- synthesize() sends HTTP request to ElevenLabs API (mock fetch)
- Streaming synthesis yields audio chunks
- Fetch timeout (15s) triggers error
- Chunk timeout (10s) triggers stall detection
- AbortSignal cancellation stops synthesis
- Voice listing returns available voices

### Exit Criteria

- [ ] All new test files pass (`pnpm test --filter=runtime`)
- [ ] VerbBuilder covers all verb types with edge cases
- [ ] VoiceServiceFactory cache and invalidation tested
- [ ] VoiceSessionResolver all resolution paths tested
- [ ] DeepgramService and ElevenLabsService basic lifecycle tested
- [ ] No new type errors (`pnpm build --filter=runtime`)

---

## Phase 2: Integration Tests — Pipeline & Protocol

**Duration:** 1 sprint (1 week)
**Focus:** Integration tests for voice pipeline orchestration and SDK WebSocket protocol

### Tasks

#### 2.1 Pipeline Voice Integration Test (INT-1)

**File:** `apps/runtime/src/__tests__/integration/voice-pipeline.integration.test.ts`

Test the VoicePipeline orchestration with DI-injected STT/TTS stubs:

- Pipeline.start() initializes STT connection and enters listening state
- STT transcription result triggers RuntimeExecutor processing
- Agent response triggers TTS synthesis
- TTS audio chunks forwarded via onAudioChunk callback
- Pipeline.stop() releases all connections
- STT error transitions to error state
- TTS error logs warning but continues

**Implementation approach:**

- Create DeepgramService and ElevenLabsService stubs that emit pre-recorded events
- Wire stubs into VoicePipeline via constructor injection
- Use real RuntimeExecutor with a test agent IR
- Assert state transitions and callback invocations

#### 2.2 SDK WebSocket Voice Protocol Integration Test (INT-6)

**File:** `apps/runtime/src/__tests__/integration/sdk-voice-protocol.integration.test.ts`

Test the WebSocket voice message protocol with real Express server:

- Start runtime on random port (`{ port: 0 }`)
- Connect via WebSocket with valid API key
- Send voice_start, assert voice_started response
- Send voice_audio with base64 data, assert accepted
- Send speech_end, assert state transition
- Send voice_stop, assert session cleanup
- Send invalid message type, assert voice_error
- Send without sessionId, assert rejection
- Test rate limiting with rapid messages

#### 2.3 KoreVG Verb Dispatch Integration Test (INT-4)

**File:** `apps/runtime/src/__tests__/integration/korevg-verb-dispatch.integration.test.ts`

- Text agent response produces correct say verb sequence
- Gather request produces gather verb with correct input types
- DTMF collection produces gather with numDigits/finishOnKey
- Streaming say has stream=true
- Hangup verb ends session
- Config verb sets session synthesizer
- SIP header sanitization strips injection attempts

#### 2.4 Realtime Voice Executor Tool Routing Test (INT-2)

**File:** `apps/runtime/src/__tests__/integration/realtime-executor.integration.test.ts`

- Tool call from mock provider triggers ABL tool executor
- Tool result is submitted back to session
- Constraint checker runs after tool execution
- Multiple concurrent tool calls handled
- Invalid tool name returns error
- Transcript entries captured for both roles

### Exit Criteria

- [ ] Pipeline integration test exercises full STT -> Executor -> TTS flow
- [ ] SDK WebSocket test exercises complete voice message protocol
- [ ] KoreVG test covers all verb types
- [ ] Realtime executor test validates tool routing
- [ ] All integration tests pass with real Express servers (no mocked servers)
- [ ] No flaky tests (run 3x clean)

---

## Phase 3: E2E Tests — Core Voice Paths

**Duration:** 1 sprint (1 week)
**Focus:** E2E tests for pipeline voice, KoreVG telephony, and cross-tenant isolation

### Tasks

#### 3.1 Pipeline Voice E2E (E2E-1)

**File:** `apps/runtime/src/__tests__/e2e/voice-pipeline.e2e.test.ts`

Full voice conversation via SDK WebSocket:

- Start real runtime with all middleware
- Connect WebSocket, authenticate via API key
- Send voice_start, receive voice_started (pipeline mode)
- Send pre-recorded audio (base64 PCM16), send speech_end
- Receive transcription, voice_response_start, voice_audio_chunk(s), voice_speaking_end, voice_response_end
- Send voice_stop

**External service handling:**

- Deepgram and ElevenLabs stubbed via DI (test fixture injects mock services)
- All other middleware (auth, rate limiting, tenant isolation) runs real

#### 3.2 KoreVG WebSocket E2E (E2E-3)

**File:** `apps/runtime/src/__tests__/e2e/voice-korevg.e2e.test.ts`

Simulate inbound phone call:

- Create ChannelConnection record via API
- Connect WebSocket to `/ws/korevg/{connectionId}?token={authToken}`
- Send session:new event
- Receive initial greeting verb
- Send gather completion with speech text
- Receive agent response verb
- Send call:status hangup
- Verify session cleanup

#### 3.3 Cross-Tenant Voice Isolation E2E (E2E-5)

**File:** `apps/runtime/src/__tests__/e2e/voice-tenant-isolation.e2e.test.ts`

- Create two tenants with separate projects and API keys
- Start voice session for tenant A
- Verify tenant A's credentials are used (via trace events)
- Attempt cross-tenant access, verify 404 response
- Start voice session for tenant B
- Verify tenant B's credentials are used

#### 3.4 Voice Barge-In E2E (E2E-4)

**File:** `apps/runtime/src/__tests__/e2e/voice-barge-in.e2e.test.ts`

- Start pipeline voice session
- Trigger agent response (TTS streaming)
- While receiving audio chunks, send barge_in
- Verify barge_in_ack received
- Verify audio streaming stops
- Verify session returns to listening state

### Exit Criteria

- [ ] Pipeline E2E tests full conversation lifecycle
- [ ] KoreVG E2E tests phone call simulation
- [ ] Cross-tenant isolation prevents credential leakage
- [ ] Barge-in interrupts TTS and returns to listening
- [ ] All E2E tests use real Express servers with full middleware chain
- [ ] No mocking of codebase components (only external services via DI)

---

## Phase 4: Realtime Voice & Provider Hardening

**Duration:** 1 sprint (1 week)
**Focus:** Realtime voice E2E, provider reconnection, mode resolution E2E

### Tasks

#### 4.1 Realtime Voice E2E (E2E-6)

**File:** `apps/runtime/src/__tests__/e2e/voice-realtime.e2e.test.ts`

- Configure tenant with realtime model
- Set agent voice_optimized: true
- Connect WebSocket, send voice_start
- Verify voice_started with voiceMode: "realtime"
- Verify realtime session connects (via trace events)
- Send audio that triggers tool call
- Verify tool execution through ABL executor
- Verify realtime_transcript messages
- Send voice_stop, verify clean disconnect

**External service handling:**

- Mock realtime provider (OpenAI Realtime) via DI to simulate audio/tool call events
- All platform code runs real

#### 4.2 Voice Mode Resolution E2E (E2E-2)

**File:** `apps/runtime/src/__tests__/e2e/voice-mode-resolution.e2e.test.ts`

- Test deployment explicit config overrides agent hint
- Test "auto" mode falls through to agent hint
- Test kill switch forces pipeline
- Test tenant without realtime model falls back to pipeline

#### 4.3 Credential Resolution E2E (E2E-7)

**File:** `apps/runtime/src/__tests__/e2e/voice-credentials.e2e.test.ts`

- Two tenants with different STT/TTS configs
- Verify each tenant uses their own credentials
- Verify credential caching (no re-decryption within TTL)
- Verify cache invalidation forces fresh resolution

#### 4.4 Provider Reconnection Tests

**File:** `apps/runtime/src/__tests__/integration/realtime-reconnection.integration.test.ts`

- Simulate realtime provider disconnect
- Verify exponential backoff reconnect (1s, 2s, 4s)
- Verify max 3 retries before giving up
- Verify intentional disconnect does not trigger reconnect
- Verify connection state events are emitted correctly

#### 4.5 LiveKit Trace Hooks Integration (INT-7)

**File:** `apps/runtime/src/__tests__/integration/livekit-trace-hooks.integration.test.ts`

- Turn start emits voice_turn_start with session context
- STT completion includes timing
- LLM start/end includes prompt/response
- TTS start includes voice selection
- Turn complete includes full timing breakdown
- Trace events include tenantId and projectId

### Exit Criteria

- [ ] Realtime voice E2E validates full session lifecycle with tool calls
- [ ] Mode resolution E2E validates all priority chain paths via API
- [ ] Credential resolution E2E validates per-tenant isolation
- [ ] Provider reconnection handles disconnect/retry/give-up
- [ ] LiveKit trace hooks emit correct structured events
- [ ] All Phase 4 tests pass with no flakiness

---

## Phase 5: Production Hardening & Documentation

**Duration:** 1 sprint (1 week)
**Focus:** Error recovery, graceful degradation, documentation, coverage reporting

### Tasks

#### 5.1 STT/TTS Provider Fallback

Implement graceful degradation when primary STT/TTS provider is unavailable:

- If Deepgram returns error, log and return transcription error to client
- If ElevenLabs returns error, deliver text-only response
- Add health check endpoints for STT/TTS provider connectivity
- Add metrics for provider error rates

**Files to modify:**

- `apps/runtime/src/services/voice/voice-pipeline.ts` — add provider health check
- `apps/runtime/src/services/voice/deepgram-service.ts` — add isHealthy() method
- `apps/runtime/src/services/voice/elevenlabs-service.ts` — add isHealthy() method

#### 5.2 Voice Pipeline Error Recovery

Harden error handling in voice pipeline:

- STT WebSocket reconnection on transient failure
- TTS request retry with backoff (1 retry, 2s delay)
- Pipeline state machine validation (no invalid transitions)
- Audio buffer overflow protection (max buffer size constant)
- Silence timer cleanup on pipeline stop (prevent timer leak)

#### 5.3 Web SDK Voice Tests (jsdom)

**File:** `packages/web-sdk/src/__tests__/voice-client.test.ts`

Unit tests for VoiceClient state machine (jsdom environment):

- State transitions: idle -> connecting -> ready -> listening -> processing -> speaking -> idle
- Invalid transition throws error
- Mute/unmute toggles audio track enabled state
- isSupported() checks for getUserMedia and AudioContext
- VoiceMode getter returns current mode
- getInfo() returns complete state snapshot

#### 5.4 Coverage Reporting

Generate test coverage report for voice subsystem:

- Run `pnpm test --coverage` for runtime and compiler packages
- Compare against coverage targets from test spec
- Document gaps remaining in `docs/testing/voice-capabilities.md`

#### 5.5 Update Package Learnings

Create/update `agents.md` for packages touched:

- `apps/runtime/agents.md` — voice service patterns, test approaches
- `packages/web-sdk/agents.md` — voice client patterns, browser API mocking
- `packages/compiler/agents.md` — realtime provider patterns

### Exit Criteria

- [ ] Provider health checks implemented
- [ ] Pipeline error recovery handles transient failures
- [ ] Web SDK VoiceClient state machine tested
- [ ] Coverage report generated and documented
- [ ] Package learnings updated for all packages touched
- [ ] Feature status updated in feature spec (ALPHA -> BETA if all gates pass)

---

## Wiring Checklist

These items verify that all new code is properly wired into the system:

| #   | Item                                             | Verification                                                             |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | VerbBuilder tests import from actual source path | `import { VerbBuilder } from '../services/voice/korevg/verb-builder.js'` |
| 2   | Integration tests start real Express server      | `app.listen(0)` with full middleware                                     |
| 3   | E2E tests use HTTP API only (no direct DB)       | No Mongoose model imports in test files                                  |
| 4   | External services stubbed via DI, not vi.mock    | Constructor injection or factory override                                |
| 5   | New test files added to vitest include patterns  | Check `vitest.config.ts` include globs                                   |
| 6   | Health check endpoints registered in Express     | Route registration in server.ts                                          |
| 7   | Coverage targets updated in test spec            | `docs/testing/voice-capabilities.md`                                     |
| 8   | Package learnings reflect actual implementation  | `agents.md` files updated                                                |

---

## Risk Mitigation

| Risk                                 | Phase | Mitigation                                                          |
| ------------------------------------ | ----- | ------------------------------------------------------------------- |
| External services unavailable in CI  | 2-4   | DI stubs for Deepgram/ElevenLabs/OpenAI; no real API calls in tests |
| LiveKit tests require infrastructure | 4     | Defer LiveKit-specific E2E to separate infra test suite             |
| WebSocket tests flaky due to timing  | 2-4   | Use message-based assertions with timeouts, not setTimeout          |
| jsdom limitations for Web Audio API  | 5     | Mock AudioContext in test setup                                     |
| Large test suite slows CI            | 5     | Tag E2E tests separately; run in parallel where possible            |

---

## Success Metrics

| Metric                       | Current | After Phase 5       |
| ---------------------------- | ------- | ------------------- |
| Voice-related test files     | 8       | 25+                 |
| E2E test scenarios           | 0       | 7                   |
| Integration test scenarios   | 0       | 7                   |
| Voice mode resolver coverage | 90%     | 95%                 |
| Pipeline voice coverage      | 0%      | 60%                 |
| KoreVG coverage              | 0%      | 50%                 |
| SDK WebSocket voice coverage | 0%      | 60%                 |
| Feature status               | ALPHA   | ALPHA -> BETA ready |
