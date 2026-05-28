# Voice Capabilities — High-Level Design

**Feature:** Voice Capabilities (#33)
**Status:** ALPHA
**Created:** 2026-03-22
**Last Updated:** 2026-04-14
**Inputs:** [Feature Spec](../features/voice-capabilities.md) | [Test Spec](../testing/voice-capabilities.md)

---

### Post-Implementation Notes (2026-04-14)

Since last HLD update, the following additions materialized beyond the original design:

1. **Insecure-context guards** (ABLP-189): Softphone hook now gracefully degrades `crypto.randomUUID` and `getUserMedia` on non-HTTPS origins, preventing crash on insecure contexts.
2. **Softphone call webhook redirect**: The `/call` webhook now returns a Jambonz `redirect` verb to the phone number's configured application `call_hook`, unifying inbound and outbound call agent logic.
3. **TTS Preview**: New `/api/v1/voice/tts-preview` endpoint for previewing ElevenLabs/Orpheus synthesis from Studio.
4. **Voice Transfer Gateway**: Abstract `VoiceGatewaySession` interface in `@agent-platform/agent-transfer` for provider-agnostic call transfers.
5. **Grok S2S Payload**: `grok-llm-payload.ts` enables KoreVG sessions to use Grok LLM directly for S2S voice.
6. **KoreVG CORS**: Voice endpoints now accept server-to-server calls from KoreVG/feature-server origins, authenticated via token.

---

## 1. Executive Summary

Voice capabilities enable ABL platform agents to interact via spoken conversation across web (WebRTC/WebSocket), telephony (PSTN/SIP), and embedded SDK channels. The architecture supports two voice modes: **pipeline** (client VAD + Deepgram STT + RuntimeExecutor + provider TTS) and **realtime** (native audio I/O via OpenAI Realtime, Gemini Live, or Ultravox). The telephony pipeline now also supports **Orpheus via Groq** as a tenant-configured custom TTS provider with two transport modes: buffered HTTP synth and optional WebSocket streaming at the KoreVG/FreeSWITCH boundary. A voice mode resolver determines which mode to use based on a priority chain (deployment config > agent IR hints > global config > default). Voice sessions are tenant-isolated with encrypted credential management and full observability via trace events and metrics.

---

## 2. Architecture Overview

### System Context

```
+------------------+     +------------------+     +------------------+
|   Web Browser    |     |   Phone (PSTN)   |     |   Embedded App   |
|  (WebSocket/     |     |  (SIP Trunk)     |     |  (SDK Widget)    |
|   WebRTC)        |     |                  |     |                  |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         v                        v                        v
+--------+--------+     +--------+---------+     +--------+---------+
| SDK WS Handler  |     | LiveKit SIP /    |     | SDK WS Handler   |
|                 |     | Twilio Media /   |     |                  |
|                 |     | KoreVG Router    |     |                  |
+--------+--------+     +--------+---------+     +--------+---------+
         |                        |                        |
         +------------+-----------+------------+-----------+
                      |                        |
              +-------+--------+       +-------+--------+
              | Voice Session  |       | Voice Mode     |
              | Resolver       |       | Resolver       |
              +-------+--------+       +-------+--------+
                      |                        |
         +------------+-----------+------------+
         |                        |
+--------+--------+     +--------+---------+
| Pipeline Mode   |     | Realtime Mode    |
| (Deepgram STT   |     | (OpenAI/Gemini/  |
|  + ElevenLabs   |     |  Ultravox)       |
|  TTS)           |     |                  |
+--------+--------+     +--------+---------+
         |                        |
         +------------+-----------+
                      |
              +-------+--------+
              | Runtime        |
              | Executor       |
              | (ABL Engine)   |
              +-------+--------+
                      |
         +------------+-----------+
         |                        |
+--------+--------+     +--------+---------+
| Conversation    |     | Voice Trace      |
| Store           |     | Store            |
| (MongoDB)       |     | (OTEL/ClickHouse)|
+-----------------+     +------------------+
```

### Component Decomposition

| Layer             | Component                | Responsibility                                            |
| ----------------- | ------------------------ | --------------------------------------------------------- |
| **Client**        | VoiceClient              | State machine, mic capture, VAD, audio playback           |
| **Client**        | VoiceWidget              | Custom element (`<agent-voice>`), UI rendering            |
| **Client**        | TwilioAdapter            | WebRTC voice via Twilio Voice SDK                         |
| **Client**        | VADAdapter               | Speech detection (auto via @ricky0123/vad-web or manual)  |
| **Client**        | RealtimeAudioPlayer      | Web Audio API PCM16 playback                              |
| **Transport**     | SDK WS Handler           | WebSocket upgrade, auth, voice message routing            |
| **Transport**     | Twilio Media Handler     | Twilio Media Streams WebSocket                            |
| **Transport**     | KoreVG Router            | Jambonz WebSocket, verb dispatch                          |
| **Transport**     | Orpheus Custom TTS HTTP  | Buffered custom TTS endpoint for Jambonz `say` playback   |
| **Transport**     | Orpheus Custom TTS WS    | Custom streaming WS endpoint for Jambonz/FreeSWITCH       |
| **Transport**     | LiveKit Agent Worker     | LiveKit room join, agent embedding                        |
| **Resolution**    | Voice Session Resolver   | Mode resolution + executor creation                       |
| **Resolution**    | Voice Mode Resolver      | Priority chain: deployment > agent > global > default     |
| **Pipeline**      | VoicePipeline            | STT -> Executor -> TTS orchestration                      |
| **Pipeline**      | DeepgramService          | Streaming STT via WebSocket                               |
| **Pipeline**      | ElevenLabsService        | Streaming TTS via HTTP                                    |
| **Realtime**      | RealtimeVoiceExecutor    | Tool routing, constraint checks, transcript capture       |
| **Realtime**      | OpenAI Realtime Session  | WebSocket to OpenAI Realtime API                          |
| **Realtime**      | Gemini Live Session      | WebSocket to Gemini Live API                              |
| **Realtime**      | Ultravox Session         | HTTP to Ultravox API                                      |
| **Credentials**   | VoiceServiceFactory      | Tenant-aware service creation + caching                   |
| **Credentials**   | Orpheus Service Resolver | Resolve exact Orpheus tenant service instance for channel |
| **Credentials**   | VoiceCredentialCache     | Redis-backed credential cache                             |
| **Observability** | Voice Trace Hooks        | STT/LLM/TTS phase timing                                  |
| **Observability** | Voice Metrics            | Session/turn/interruption counters                        |
| **Engine**        | RuntimeExecutor          | ABL agent processing (shared with text)                   |
| **Engine**        | Voice Runtime            | Low-latency runtime variant                               |

---

## 3. Architectural Concerns

### 3.1 Resource Isolation

**Tenant Isolation:** Every voice session is scoped to a tenant via `tenantId`. The VoiceServiceFactory resolves credentials per tenant from TenantServiceInstance records. The VoiceCredentialCache keys include tenantId (`auth-profile:voice:{tenantId}:{callId}`) ensuring no cross-tenant credential leakage.

**Project Isolation:** Voice sessions are scoped to projects via `projectId`. The SDK WebSocket handler validates the API key against the project. KoreVG connections are mapped to projects via ChannelConnection records.

**User Isolation:** Voice sessions are per-connection (WebSocket). Each connection has its own session state. No shared mutable state between concurrent voice sessions.

**Cross-scope access:** Returns 404 (not 403) to avoid leaking resource existence.

### 3.2 Authentication & Authorization

- **SDK WebSocket:** Public API key validated at connection time via `sdk-handler.ts`
- **KoreVG WebSocket:** Inbound auth token (32-byte hex) validated against ChannelConnection config
- **Custom Orpheus TTS:** HTTP and WS endpoints are protected by bearer auth and scoped by tenant/service-instance query params
- **LiveKit:** Participant tokens generated server-side, scoped to room/session
- **Twilio:** Access tokens generated via TwilioService, scoped to tenant
- **Realtime providers:** API keys resolved from tenant credentials, never exposed to client
- **Centralized auth:** Uses `createUnifiedAuthMiddleware` for REST API endpoints

### 3.3 Stateless Distributed

Voice sessions are designed to be stateless at the pod level:

- **Session state** stored in MongoDB (ConversationStore)
- **Credential cache** in Redis with TTL (VoiceCredentialCache)
- **Voice pipeline state** is connection-scoped (lives with the WebSocket)
- **Realtime sessions** are connection-scoped (provider WebSocket per session)
- **LiveKit rooms** are managed by LiveKit server (external state)

**Caveat:** Pipeline voice sessions (VoicePipeline) and realtime sessions (RealtimeVoiceExecutor) hold in-memory state tied to the WebSocket connection. If the pod crashes, the voice session is lost. This is acceptable because voice sessions are short-lived and the client reconnects.

### 3.4 Traceability

Every voice turn emits structured trace events:

- `voice_turn_start` -> `voice_stt_complete` -> `voice_llm_start` -> `voice_llm_complete` -> `voice_tts_start` -> `voice_tts_first_chunk` -> `voice_tts_complete` -> `voice_turn_complete`
- Realtime turns: `realtime_session_start` -> `realtime_turn_complete` -> `realtime_session_end`
- LiveKit turns: Full trace hooks via `livekit-trace-hooks.ts`
- Client trace context forwarding via WebSocket messages for end-to-end correlation
- All traces include `tenantId`, `projectId`, `sessionId` for scoping

### 3.5 Compliance

- **Transcript capture:** Always-on policy — completed, abandoned, failed, and transferred calls all have transcripts recorded
- **Configurable retention:** `transcriptRetention: 'always' | 'on_success' | 'never'` in VoiceRuntimeConfig
- **Data minimization:** Audio streams are not persisted by default; only text transcripts
- **Right to erasure:** Transcript deletion cascades from session deletion
- **Encryption:** Credentials encrypted at rest via EncryptionService

### 3.6 Performance

- **Pipeline latency budget:** Target < 2s end-to-end (STT ~200ms + LLM ~1s + TTS ~300ms + network ~500ms)
- **Realtime latency:** Target < 500ms (provider-native, no STT/TTS pipeline)
- **Streaming:** All audio paths use streaming chunks (no full-buffer-then-process)
- **Orpheus telephony streaming:** Streaming is true at the telephony boundary, but Groq remains HTTP-backed upstream per flush; buffered HTTP remains the fallback path
- **Parallel tools:** Voice runtime supports concurrent tool execution
- **Aggressive timeouts:** Voice runtime uses shorter timeouts than text runtime
- **Cache:** VoiceServiceFactory caches services per tenant with 10-minute TTL
- **Audio encoding:** PCM16 (compact binary) for realtime; MP3 for pipeline playback

### 3.7 Error Recovery

| Failure                       | Recovery Strategy                                      |
| ----------------------------- | ------------------------------------------------------ |
| STT connection dropped        | Pipeline restarts Deepgram connection                  |
| TTS synthesis fails           | Log error, deliver text-only response                  |
| Realtime provider disconnect  | Exponential backoff reconnect (max 3 retries, base 1s) |
| LiveKit room unavailable      | Return error to client, session fails                  |
| KoreVG auth failure           | Reject WebSocket connection                            |
| Credential decryption failure | Return SERVICE_UNAVAILABLE, log error                  |
| VAD library missing           | Fallback to ManualVADAdapter (push-to-talk)            |
| Audio playback blocked        | Log warning, continue to next turn                     |

### 3.8 Scalability

- **Horizontal scaling:** Runtime pods are stateless (voice sessions are connection-scoped). Load balancer distributes WebSocket connections.
- **LiveKit scaling:** LiveKit Cloud or self-hosted cluster handles room scaling independently.
- **Credential cache:** Redis-backed with bounded TTL. No unbounded in-memory maps.
- **VoiceServiceFactory cache:** Bounded by tenant count, TTL eviction prevents memory growth.
- **Audio processing:** Non-blocking (streaming chunks on event loop, no large buffer allocations).
- **Connection limits:** MAX_SDK_CLIENTS constant bounds concurrent WebSocket connections per pod.

### 3.9 Extensibility

- **New STT providers:** Implement a service matching DeepgramService interface, register in VoiceServiceFactory
- **New TTS providers:** Implement a service matching ElevenLabsService interface, register in VoiceServiceFactory
- **New realtime providers:** Implement RealtimeVoiceSession interface, register via `registerRealtimeProvider()`
- **New telephony gateways:** Add WebSocket handler following KoreVG Router pattern
- **DSL voice constructs:** Extend VoiceConfigIR in IR schema, update compiler
- **Voice analytics:** Extend trace events and metrics for custom analytics pipelines

### 3.10 Observability Infrastructure

**Trace Events:**

- Voice turn traces with phase breakdown (STT/LLM/TTS) via `voice-trace.ts`
- Realtime voice traces via `voice-metrics.ts`
- LiveKit-specific traces via `livekit-trace-hooks.ts`
- Client trace context forwarding for end-to-end latency measurement

**Metrics:**

- `voice_turn_duration_ms` (histogram, by phase)
- `voice_session_count` (gauge, by mode)
- `voice_interruption_count` (counter)
- `realtime_token_usage` (counter, by direction)
- `voice_error_count` (counter, by error type)

**Logging:**

- Structured logging via `createLogger('module')` (never console.log)
- Voice session resolver logs one structured entry per resolution (info or error)
- No redundant logging across handler/resolver layers

### 3.11 Configuration Management

| Config                          | Source                | Default                      |
| ------------------------------- | --------------------- | ---------------------------- |
| REALTIME_VOICE_ENABLED          | Env var               | true                         |
| FEATURE_LIVEKIT_ENABLED         | Env var               | false                        |
| ORPHEUS_TTS_ENABLE_WS_STREAMING | Env var               | false                        |
| ORPHEUS_TTS_WS_VALIDATED        | Env var               | false                        |
| Deployment voice mode           | MongoDB (Deployment)  | undefined (falls to default) |
| Agent voice_optimized           | IR compilation        | false                        |
| Global voice.mode               | Runtime config        | undefined                    |
| STT/TTS credentials             | TenantServiceInstance | none (service unavailable)   |
| Deepgram model                  | DeepgramConfig        | nova-2                       |
| ElevenLabs model                | ElevenLabsConfig      | undefined (provider default) |
| Pipeline silence threshold      | VoicePipeline         | 1500ms                       |
| Realtime max reconnect          | OpenAI/Gemini session | 3 retries                    |
| Credential cache TTL            | VoiceServiceFactory   | 10 minutes                   |
| Voice credential cache TTL      | VoiceCredentialCache  | 4 hours (Redis)              |
| Orpheus WS toggle               | ChannelConnection     | false                        |

### 3.12 Deployment & Operations

- **LiveKit SIP:** Requires host networking + public IP, 10001 UDP ports (5060 + 10000-20000). Not serverless-compatible.
- **LiveKit Cloud:** Alternative that eliminates self-hosted infra.
- **KoreVG/Jambonz:** Separate deployment, connected via WebSocket URL provisioning.
- **Feature flags:** REALTIME_VOICE_ENABLED and FEATURE_LIVEKIT_ENABLED gate functionality.
- **Credential rotation:** VoiceServiceFactory.invalidate() clears cache on rotation.
- **Graceful shutdown:** LiveKit adapter registry tracks active connections for orderly cleanup.

---

## 4. Data Flow Diagrams

### Pipeline Voice Turn

```
Client                  SDK Handler              VoicePipeline        Deepgram        ElevenLabs
  |                          |                        |                   |                |
  |-- voice_start ---------->|                        |                   |                |
  |<- voice_started ---------|                        |                   |                |
  |                          |-- createPipeline() --->|                   |                |
  |                          |                        |-- connect() ----->|                |
  |-- voice_audio ---------->|                        |                   |                |
  |-- speech_end ----------->|                        |                   |                |
  |                          |-- sendAudio() -------->|-- audio --------->|                |
  |                          |                        |<- transcription --|                |
  |<- transcription ---------|                        |                   |                |
  |<- voice_processing ------|                        |                   |                |
  |                          |        [RuntimeExecutor processes turn]    |                |
  |<- voice_response_start --|                        |                   |                |
  |                          |                        |-- synthesize() ---|--------------->|
  |                          |                        |<- audio chunks ---|----------------|
  |<- voice_audio_chunk -----|                        |                   |                |
  |<- voice_speaking_end ----|                        |                   |                |
  |<- voice_response_end ----|                        |                   |                |
```

### Realtime Voice Turn

```
Client            SDK Handler         VoiceSessionResolver    RealtimeExecutor    OpenAI Realtime
  |                    |                      |                      |                    |
  |-- voice_start ---->|                      |                      |                    |
  |                    |-- resolve() -------->|                      |                    |
  |                    |                      |-- create executor -->|                    |
  |                    |                      |                      |-- connect() ------>|
  |<- voice_started ---|                      |                      |                    |
  |                    |                      |                      |<- audio ----------|
  |<- realtime_audio --|                      |                      |                    |
  |                    |                      |                      |<- tool_call -------|
  |                    |                      |     [ABL tool executor runs]              |
  |                    |                      |                      |-- tool_result ---->|
  |                    |                      |                      |<- audio ----------|
  |<- realtime_audio --|                      |                      |                    |
  |<- realtime_transcript -|                  |                      |                    |
```

### KoreVG Voice Turn

```
Jambonz          KoreVG Router         RuntimeExecutor        VerbBuilder
  |                    |                      |                    |
  |-- session:new ---->|                      |                    |
  |                    |-- resolve agent ---->|                    |
  |<- [say: greeting] |                      |                    |
  |                    |                      |<- greeting text ---|
  |-- gather result -->|                      |                    |
  |                    |-- process speech --->|                    |
  |                    |                      |-- agent response ->|
  |                    |                      |                    |-- build verbs
  |<- [say: response] |                      |                    |
  |                    |                      |                    |
  |-- call:status ---->|                      |                    |
  |   (hangup)        |-- cleanup session -->|                    |
```

---

## 5. Alternatives Analysis

### Alternative A: Unified Voice Gateway (Selected)

All voice channels (web, telephony, SDK) route through the same RuntimeExecutor with different transport adapters.

**Pros:**

- Single agent logic path for all channels
- Consistent transcript and trace format
- Voice mode resolution is centralized
- DSL voice constructs work across all channels

**Cons:**

- Transport adapters must handle different protocols (WebSocket, WebRTC, SIP)
- KoreVG verb model adds complexity specific to telephony
- LiveKit requires separate infrastructure

**Selected because:** Maximizes code reuse and ensures consistent agent behavior across channels. The transport adapter pattern cleanly separates protocol concerns from business logic.

### Alternative B: Separate Voice Microservice

Extract all voice processing into a standalone microservice that communicates with the runtime via gRPC.

**Pros:**

- Voice scaling independent of runtime
- Clear service boundary
- Can be deployed closer to telephony infrastructure
- Independent development lifecycle

**Cons:**

- Additional network hop increases latency (critical for voice)
- gRPC schema coordination overhead
- Session state must be shared across services
- More operational complexity

**Rejected because:** The additional latency from a separate service is unacceptable for voice (target < 500ms). Voice sessions are inherently tied to the WebSocket connection lifecycle, making separation awkward.

### Alternative C: Client-Side Only Voice (No Server Pipeline)

Push all STT/TTS processing to the client, with the server only seeing text.

**Pros:**

- No server-side audio processing
- Lower server resource usage
- Client controls provider selection

**Cons:**

- Exposes API keys to client
- No server-side transcript capture for compliance
- Cannot use realtime voice models (they require server-side sessions)
- No telephony support (phones don't run client-side JS)

**Rejected because:** Compliance requirements (always-capture transcripts) and telephony support (PSTN) require server-side voice processing. Client-side only is insufficient for enterprise use cases.

---

## 6. Security Design

### Threat Model

| Threat                         | Mitigation                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Credential exposure to client  | API keys for STT/TTS/realtime are server-side only. Client uses session tokens. |
| Audio eavesdropping            | WebSocket/WebRTC connections use TLS. Audio not stored by default.              |
| Unauthorized voice session     | API key validation at WebSocket connect. KoreVG uses inbound auth token.        |
| Cross-tenant credential access | VoiceServiceFactory/VoiceCredentialCache key by tenantId.                       |
| Audio flood (DoS)              | WebSocket message rate limiting. MAX_SDK_CLIENTS connection limit.              |
| Participant spoofing (LiveKit) | Metadata validation with regex patterns (S6) before use.                        |
| SSRF via voice config          | Voice config is server-generated from IR; no user-supplied URLs in audio paths. |

### Encryption

- **At rest:** Voice credentials encrypted in MongoDB via EncryptionService. VoiceCredentialCache stores decrypted credentials in Redis with bounded TTL.
- **In transit:** All WebSocket connections over TLS (wss://). LiveKit uses DTLS-SRTP for WebRTC media.
- **Key management:** Credentials resolved via `dualReadCredentials()` supporting auth profile migration.

---

## 7. Capacity Planning

### Resource Estimates

| Resource              | Pipeline Mode          | Realtime Mode           | KoreVG                 |
| --------------------- | ---------------------- | ----------------------- | ---------------------- |
| CPU per session       | Low (audio relay)      | Low (audio relay)       | Low (verb processing)  |
| Memory per session    | ~2MB (audio buffers)   | ~1MB (connection state) | ~500KB (session state) |
| Network per session   | ~64 kbps (16kHz PCM16) | ~128 kbps (24kHz PCM16) | ~64 kbps (mulaw)       |
| External API calls    | 2 per turn (STT + TTS) | 0 (native)              | 2 per turn (STT + TTS) |
| WebSocket connections | 1 per client           | 1 client + 1 provider   | 1 per call             |

### Scaling Limits

- **Concurrent sessions per pod:** Limited by MAX_SDK_CLIENTS and available WebSocket connections
- **STT/TTS rate limits:** Depends on Deepgram/ElevenLabs plan
- **Realtime sessions:** Limited by provider concurrent connection limits
- **LiveKit rooms:** Limited by LiveKit server/cloud capacity
- **Redis credential cache:** Negligible memory (small JSON per tenant)

---

## 8. Risk Assessment

| Risk                              | Probability | Impact   | Mitigation                                                         |
| --------------------------------- | ----------- | -------- | ------------------------------------------------------------------ |
| Deepgram/ElevenLabs API outage    | Medium      | High     | Graceful degradation to text-only; multi-provider support (future) |
| Realtime provider API changes     | Medium      | Medium   | Provider abstraction via RealtimeVoiceSession interface            |
| LiveKit infrastructure complexity | High        | Medium   | LiveKit Cloud as alternative to self-hosted                        |
| Voice latency exceeds SLO         | Medium      | High     | Streaming architecture, aggressive timeouts, monitoring            |
| Cross-tenant credential leakage   | Low         | Critical | tenantId-scoped cache keys, integration tests                      |
| Audio data privacy violation      | Low         | Critical | Always-capture transcripts (text only), no audio storage           |

---

## 9. Dependencies

### Internal

| Dependency                  | Impact                         | Risk                          |
| --------------------------- | ------------------------------ | ----------------------------- |
| `@abl/compiler` (IR schema) | VoiceConfigIR, execution hints | Low (stable schema)           |
| RuntimeExecutor             | Agent processing               | Low (core stable)             |
| EncryptionService           | Credential decryption          | Low (well-tested)             |
| ConversationStore (MongoDB) | Transcript persistence         | Low (production stable)       |
| Redis                       | Credential cache               | Low (standard infrastructure) |

### External

| Dependency                             | Impact                     | Risk                                |
| -------------------------------------- | -------------------------- | ----------------------------------- |
| Deepgram API                           | STT for pipeline mode      | Medium (third-party SLA)            |
| ElevenLabs API                         | TTS for pipeline mode      | Medium (third-party SLA)            |
| Groq Orpheus API                       | Custom telephony TTS       | Medium (HTTP-backed upstream)       |
| OpenAI Realtime API                    | Realtime voice mode        | Medium (API stability)              |
| Twilio                                 | Voice tokens, SIP trunking | Medium (third-party SLA)            |
| LiveKit Server                         | WebRTC rooms, SIP bridge   | Medium (infrastructure complexity)  |
| Jambonz                                | KoreVG voice gateway       | Medium (deployment complexity)      |
| FreeSWITCH custom TTS streaming module | WS telephony playout       | Medium (external protocol contract) |
| @ricky0123/vad-web                     | Client-side VAD            | Low (optional, graceful fallback)   |

---

## 10. Open Issues

1. **No STT/TTS provider fallback:** If Deepgram is down, pipeline mode has no alternative STT provider. Consider adding Google Cloud STT or Azure Speech as secondary.
2. **Realtime provider selection:** Currently hardcoded by admin config. Should the platform auto-select the best realtime provider based on model availability and latency?
3. **Voice session persistence:** Pod crash loses in-progress voice session. Should session checkpointing be added for long calls?
4. **Audio recording storage:** No current mechanism to store call recordings. Required for some compliance regimes.
5. **Multi-language STT:** Deepgram language parameter is configurable but there's no auto-detection or mid-call language switching.
6. **Streaming audio quality:** Orpheus WS streaming is functionally wired, but transport quality still needs measurable regression coverage before it should become the default path.

---

## 11. Post-Implementation Notes (2026-04-07)

- Added tenant-scoped **Orpheus via Groq** configuration in Studio `/admin/voice`.
- Channel configuration now stores exact `ttsServiceInstanceId` / `asrServiceInstanceId` values rather than selecting only vendor families.
- Jambonz provisioning now emits both `custom_tts_url` and `custom_tts_streaming_url` for Orpheus speech credentials.
- Runtime supports per-connection `orpheusWsStreamingEnabled` so operators can compare buffered and WS telephony modes on the same DID.
- Duplicate-label Orpheus speech credential reuse was added so speech credential conflicts no longer block DID registration.
