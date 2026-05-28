# Voice Capabilities

**Feature ID:** #33
**Status:** ALPHA
**Owner:** Platform Engineering
**Created:** 2026-03-22
**Last Updated:** 2026-04-14

---

## 1. Problem Statement

Enterprise customers deploying AI agents on the ABL platform need voice/speech interaction capabilities across multiple channels: web browser (WebRTC), telephony (PSTN via SIP trunking), and embedded SDK widgets. Without integrated voice support, customers cannot serve phone-based users, accessibility-constrained users, or contact center automation use cases. The platform must provide a unified voice architecture that spans the full pipeline (STT -> LLM -> TTS) while also supporting next-generation realtime voice models (OpenAI Realtime, Gemini Live, Ultravox) that bypass the pipeline entirely with native audio-in/audio-out.

### Business Impact

- Contact center automation (IVR replacement, call deflection) is a P0 enterprise requirement
- Outbound campaigns (appointment reminders, notifications) require telephony
- Web voice enables hands-free interaction and accessibility compliance
- Competitors (Decagon, Sierra, Cognigy) already ship voice-native agent platforms

### User Pain Points

1. No way to serve phone callers without custom integration work
2. High latency in voice interactions when STT/TTS are not optimized for streaming
3. No unified transcript/audit trail across voice and text channels
4. No DSL-level control over voice behavior (SSML, voice selection, barge-in)

---

## 2. Scope

### In Scope

- **Pipeline voice mode**: Client-side VAD -> WebSocket audio transport -> server STT (Deepgram) -> RuntimeExecutor -> TTS (ElevenLabs) -> audio playback
- **Realtime voice mode**: Native audio I/O via realtime LLM providers (OpenAI Realtime, Gemini Live, Ultravox) with server-side VAD
- **LiveKit WebRTC integration**: Full-duplex voice via LiveKit rooms with RuntimeBridgeAgent
- **Telephony (PSTN)**: SIP trunking via LiveKit SIP service or Twilio Media Streams
- **KoreVG/Jambonz integration**: WebSocket-based voice gateway for phone calls with verb-based response model
- **Custom telephony TTS**: Orpheus via Groq with tenant-scoped admin configuration, per-channel service-instance selection, and optional WebSocket streaming
- **Web SDK voice**: VoiceClient, VoiceWidget (custom element), TwilioAdapter, VADAdapter, RealtimeAudioPlayer
- **DSL voice constructs**: VoiceConfigIR, voice_optimized hints, voice_latency_target_ms, voice_response_rules
- **Voice mode resolution**: Deployment config -> agent IR hints -> global config -> default pipeline
- **Voice credential management**: Tenant-aware factory (VoiceServiceFactory) with encrypted credential caching
- **LiveDial (Studio Softphone)**: Browser-based test calling from Studio for testing voice agent flows — user dials a configured phone number, Jambonz SBC routes the call as an inbound webhook to ABL Runtime which bridges to PSTN. Includes SIP registration, DTMF, mute/hold, and browser-side call recording via MediaRecorder API
- **TTS Preview**: Generalized TTS preview endpoint (`/api/v1/voice/tts-preview`) for auditing ElevenLabs and Orpheus synthesis from Studio before deploying to production channels
- **Voice Transfer Gateway**: Abstract `VoiceGatewaySession` interface in `@agent-platform/agent-transfer` enabling provider-agnostic call transfers (SIP REFER, PSTN dial, human agent bridge) across KoreVG, AudioCodes, and Twilio gateways
- **Grok Realtime LLM**: KoreVG sessions can use Grok LLM directly for S2S voice via `grok-llm-payload.ts`, alongside the existing OpenAI Realtime and Gemini Live paths
- **Observability**: Voice turn tracing (STT/LLM/TTS phases), timing reports, realtime session metrics
- **Barge-in support**: Client-side (pipeline) and server-side (realtime/LiveKit) interruption handling
- **Transcript capture**: Always-capture policy for compliance (completed, abandoned, failed, transferred calls)

### Out of Scope

- Video/screen-sharing capabilities
- Custom STT/TTS model training
- Multi-language simultaneous interpretation
- Voice biometric authentication

### Dependencies

- `@abl/compiler` IR schema (VoiceConfigIR, execution hints)
- `packages/web-sdk` (VoiceClient, VoiceWidget, AudioCapture, VAD)
- `apps/runtime` voice services (Deepgram, ElevenLabs, Twilio, LiveKit, KoreVG)
- External services: Deepgram API, ElevenLabs API, OpenAI Realtime API, Groq Orpheus API, Twilio, LiveKit Server, Jambonz, FreeSWITCH custom TTS streaming module

---

## 3. User Stories

### US-1: Web Voice Interaction (Pipeline Mode)

**As a** web user visiting an agent-powered page,
**I want to** click a microphone button and speak to the AI agent,
**So that** I can interact hands-free without typing.

**Acceptance Criteria:**

- Microphone permission is requested on first use
- VAD automatically detects speech start/end (or push-to-talk fallback)
- Audio is streamed to server, transcribed, processed by agent, and response is spoken back
- Barge-in stops agent audio when user starts speaking
- Transcript is visible in the widget in real-time

### US-2: Realtime Voice Interaction

**As a** tenant admin configuring a voice-optimized agent,
**I want to** enable realtime voice mode using OpenAI Realtime or Gemini Live,
**So that** users experience ultra-low-latency conversational voice with native audio I/O.

**Acceptance Criteria:**

- Voice mode resolver selects realtime when: deployment config says 'realtime', or agent has voice_optimized hint + tenant has realtime model
- System prompt and tools are forwarded to the realtime provider
- Tool calls from the realtime model are routed through the ABL tool executor
- Transcripts are captured for both user and assistant turns
- Graceful fallback to pipeline mode if realtime provider is unavailable

### US-3: Phone Call via Telephony

**As a** phone caller dialing an enterprise support number,
**I want to** speak with an AI agent that understands my request and responds naturally,
**So that** I can resolve my issue without waiting for a human agent.

**Acceptance Criteria:**

- Inbound SIP calls are routed to the correct project/agent via channel connection
- Agent processes speech through the full pipeline (STT -> LLM -> TTS)
- DTMF input is supported for IVR-style digit collection
- Call metadata (duration, disposition, transfer events) is recorded
- Agent can transfer the call to another agent or external number

### US-4: KoreVG/Jambonz Voice Gateway

**As a** deployment operator connecting the platform to KoreVG/Jambonz,
**I want to** provision a channel connection that maps inbound calls to agents,
**So that** phone calls are automatically routed to the correct ABL agent.

**Acceptance Criteria:**

- WebSocket URL pattern `wss://runtime/ws/korevg/{connectionId}?token={token}` is established
- Jambonz verbs (say, gather, config, hangup) are correctly built from agent responses
- Custom speech credentials provision both `custom_tts_url` and `custom_tts_streaming_url` with the tenant label and selected service instance
- Streaming TTS is supported via say verb with `stream=true` when the channel explicitly enables Orpheus WebSocket streaming
- Authentication via inbound auth token prevents unauthorized connections

### US-8: Tenant-Scoped Orpheus Configuration

**As a** tenant admin configuring telephony voice,
**I want to** register Orpheus via Groq in admin, choose that exact service instance in a voice pipeline channel, and optionally toggle streaming,
**So that** my calls use the intended model, voice, and transport mode without relying on global runtime env.

**Acceptance Criteria:**

- `/admin/voice` supports `custom:orpheus` with API key, model, and default voice fields
- Voice pipeline channel config stores exact `ttsServiceInstanceId` and `asrServiceInstanceId`, not just vendor names
- Runtime resolves Orpheus credentials from the selected tenant service instance
- Operators can toggle `orpheusWsStreamingEnabled` per connection to compare buffered and streaming paths
- Jambonz provisioning reuses duplicate Orpheus speech credentials and still completes DID registration

### US-9: LiveDial — Studio Test Calling

**As a** Studio user testing a voice-enabled agent,
**I want to** dial phone numbers configured in my project's voice channels directly from Studio,
**So that** I can test the end-to-end voice agent flow without leaving the browser or using an external phone.

**Acceptance Criteria:**

- Phone icon appears in Studio header only when voice channel connections with phone numbers exist
- Clicking the icon opens a popover with number selection, dial pad, and call button
- SIP registration via AudioCodes WebRTC SDK connects to Jambonz SBC over WSS
- Outbound calls are routed through Jambonz `sipdevicecall-<tenantId>` application to PSTN
- In-call controls: mute, hold, DTMF keypad, hangup
- Ringback tone plays during dialing/ringing phase
- Call recording (opt-in via checkbox) captures both local and remote audio using browser MediaRecorder API
- Recording is downloadable as WebM after call ends, with proper memory cleanup
- Friendly error messages for SIP failures (busy, timeout, rejected, unavailable)
- Each browser tab gets a unique SIP registration to avoid conflicts with multiple users/tabs
- Phone numbers refresh when the popover opens (reflects newly added/removed numbers)
- Navigation during active call does not interrupt audio
- Insecure-context guard: `crypto.randomUUID` falls back to `Math.random` and `getUserMedia` unavailability shows a friendly error instead of crashing
- Softphone outbound calls route through the same Jambonz application/`call_hook` as inbound calls, ensuring consistent agent logic

### US-5: Voice in Embedded SDK Widget

**As a** developer embedding the ABL SDK in a web application,
**I want to** add voice interaction via the `<agent-voice>` custom element,
**So that** my users can speak to agents without additional integration work.

**Acceptance Criteria:**

- Widget renders voice button with state indicators (idle, connecting, listening, processing, speaking)
- Mute/unmute toggle is available during active voice sessions
- Transcript and response text are displayed in the widget
- Widget auto-detects browser support and disables if unsupported
- Theme customization via attributes

### US-6: DSL Voice Configuration

**As a** agent developer writing ABL DSL,
**I want to** configure voice behavior at the agent and step level,
**So that** I can control SSML, voice selection, and response formatting for voice channels.

**Acceptance Criteria:**

- `voice_config` field on agent IR supports SSML, instructions, and plain_text overrides
- `voice_optimized` hint in execution config influences mode resolution
- `voice_latency_target_ms` sets response time SLOs
- `voice_response_rules` in behavior profile controls voice-specific formatting
- Voice config is inherited from agent level and can be overridden at step/respond level

### US-7: Voice Credential Management

**As a** tenant admin,
**I want to** configure STT/TTS/telephony provider credentials per tenant,
**So that** each tenant uses their own API keys and voice services.

**Acceptance Criteria:**

- VoiceServiceFactory resolves credentials from TenantServiceInstance records
- Credentials are decrypted via EncryptionService before use
- Service instances are cached per tenant with 10-minute TTL
- Cache invalidation on credential rotation
- Auth profile credentials supported via dual-read pattern

---

## 4. Functional Requirements

### FR-1: Pipeline Voice Mode

The system shall support a pipeline voice mode where:

- Client captures audio via AudioCapture (16kHz PCM16 default)
- VAD detects speech boundaries (@ricky0123/vad-web or manual push-to-talk fallback)
- Audio is base64-encoded and sent via WebSocket (`voice_audio` message)
- Server transcribes via Deepgram STT (nova-2 model, streaming WebSocket)
- Transcription is forwarded to RuntimeExecutor for agent processing
- Agent response text is synthesized via ElevenLabs TTS (streaming MP3)
- Audio chunks are streamed back to client for playback
- Barge-in detection interrupts playback and notifies server

### FR-2: Realtime Voice Mode

The system shall support a realtime voice mode where:

- RealtimeVoiceSession connects to provider (OpenAI Realtime, Gemini Live, Ultravox)
- Server-side VAD handles turn detection
- Audio flows natively through the provider (PCM16 or g711)
- Tool calls are routed through RealtimeVoiceExecutor to ABL tool executor
- Constraint checks run after tool execution
- System prompt and tool definitions are updateable mid-session
- Usage metrics (tokens, audio duration, turn count) are tracked

### FR-3: LiveKit WebRTC Voice

The system shall support LiveKit-based WebRTC voice where:

- Agent worker runs in-process (no forked child processes)
- RuntimeBridgeAgent routes LLM calls through RuntimeExecutor
- LiveKit handles WebRTC plumbing (STT/TTS/VAD/barge-in)
- Participant metadata is validated before use
- Full voice-trace integration via livekit-trace-hooks
- Adapter registry tracks active connections for graceful shutdown

### FR-4: Telephony via SIP Trunking

The system shall support PSTN telephony where:

- LiveKit SIP service bridges SIP/RTP to WebRTC (primary path)
- Twilio Media Streams + LiveKit Room proxy (fallback path)
- Phone callers become LiveKit room participants
- SIP-native features supported (REFER transfers, SIP INFO DTMF)
- Jambonz provisioning automates DID -> application -> WebSocket URL mapping

### FR-5: KoreVG Voice Gateway

The system shall support KoreVG/Jambonz integration where:

- KorevgRouter handles WebSocket connections from Jambonz
- VerbBuilder converts agent responses to Jambonz verbs (say, gather, config, hangup)
- Buffered custom TTS is available via `custom_tts_url` for `say` playback
- Optional Orpheus streaming is available via `custom_tts_streaming_url` when `orpheusWsStreamingEnabled=true` and runtime gates are enabled
- DTMF digit collection via gather verb with numDigits/maxDigits/finishOnKey
- Homer client provides SIP message logging for debugging
- Session resolver maps connectionId to project/agent

### FR-6: Voice Mode Resolution

The system shall resolve voice mode (pipeline vs realtime) via priority chain:

1. Feature flag kill switch (REALTIME_VOICE_ENABLED env var)
2. Deployment explicit voice config (mode: pipeline | realtime | auto)
3. Agent IR voice_optimized hint + tenant has realtime model
4. Global voice.mode config
5. Default: pipeline

### FR-7: Voice Observability

The system shall provide voice-specific observability:

- Voice turn tracing with phase breakdown (STT -> LLM -> TTS)
- Timing reports with first-audio-out latency
- Realtime session metrics (connection duration, turn count, interruptions)
- Client-side trace context forwarding via WebSocket messages
- Transcript capture for all call dispositions (completed, abandoned, failed, transferred)

### FR-8: Web SDK Voice Components

The system shall provide client-side voice components:

- VoiceClient with state machine (idle -> connecting -> ready -> listening -> processing -> speaking)
- VoiceWidget custom element (`<agent-voice>`) with shadow DOM
- TwilioAdapter for WebRTC voice via Twilio Voice SDK
- VADAdapter with automatic (@ricky0123/vad-web) and manual (push-to-talk) modes
- RealtimeAudioPlayer for PCM16 streaming playback via Web Audio API
- AudioCapture for microphone input with Float32-to-PCM16 conversion

### FR-9: Voice Credential Factory

The system shall manage voice service credentials:

- Tenant-aware VoiceServiceFactory creates/caches Deepgram, ElevenLabs, Twilio, and Orpheus services
- Credentials decrypted from TenantServiceInstance records via EncryptionService
- 10-minute cache TTL with per-tenant invalidation
- Dual-read pattern for auth profile credential migration
- Voice credential cache for high-frequency access paths
- Channel and deployment flows resolve the exact `ttsServiceInstanceId` / `asrServiceInstanceId` selected by the operator

### FR-11: LiveDial (Studio Softphone)

The system shall support browser-based outbound calling from Studio where:

- `GET /api/v1/voice/softphone-config` returns the SIP domain and WSS server URLs from Jambonz account config
- `GET /api/v1/voice/softphone-numbers/:projectId` returns phone numbers from the project's active voice channel connections (korevg, voice_realtime, voice_pipeline, voice_twilio)
- `POST /api/v1/voice/softphone/register` webhook accepts Jambonz SIP device registration callbacks
- `POST /api/v1/voice/softphone/call` webhook looks up the phone number's configured Jambonz application and returns a redirect verb to its `call_hook` URL, routing outbound softphone calls through the same agent logic as inbound calls
- AudioCodes WebRTC SDK (JsSIP) handles SIP over WebSocket registration and call signaling
- SoftphoneManager singleton wraps SDK lifecycle (register, call, hangup, DTMF, mute, hold)
- SIP username is `<emailPrefix>_<sessionId>` where sessionId is a per-tab random ID stored in sessionStorage
- Two Jambonz applications per tenant: `sipdevicereg-<tenantId>` for registration, `sipdevicecall-<tenantId>` for outbound calls
- Browser-side call recording via MediaRecorder API mixes remote + local audio streams through AudioContext
- Recording is stored as WebM/Opus blob URL (~16 KB/s), downloadable after call ends
- Memory cleanup: blob URLs are revoked on new call, popover dismiss, and component unmount
- Insecure-context guard: `crypto.randomUUID` gracefully falls back to `Math.random().toString(36)` on non-HTTPS origins; `getUserMedia` unavailability is detected before call initiation with a user-friendly error message

### FR-10: Orpheus Admin and Channel Wiring

The system shall support tenant-scoped Orpheus configuration and channel selection where:

- `/admin/voice` exposes `custom:orpheus` as a configurable TTS provider
- `/api/v1/tenant/service-instances` accepts `custom:orpheus` service instances
- Voice pipeline channel config allows selecting the exact Orpheus service instance and voice
- Channel provisioning generates Jambonz speech credentials with both buffered and streaming custom TTS URLs
- Duplicate-label Jambonz speech credential reuse does not block DID registration or inbound call routing

---

## 5. Non-Functional Requirements

### NFR-1: Latency

- Pipeline mode: < 2 seconds end-to-end (speech end -> first audio out)
- Realtime mode: < 500ms first audio out
- Voice runtime targets sub-500ms response with streaming enabled

### NFR-2: Reliability

- Realtime providers reconnect with exponential backoff (max 3 retries)
- Pipeline mode degrades gracefully if VAD library is unavailable (push-to-talk fallback)
- Transcript capture is always-on regardless of call outcome
- WebSocket connections survive transient network issues
- Duplicate-label Jambonz speech credential reuse must not block DID registration for phone numbers

### NFR-3: Scalability

- Voice sessions are stateless on runtime pods (session state in Redis/MongoDB)
- LiveKit rooms scale horizontally via LiveKit Cloud or self-hosted cluster
- VoiceServiceFactory cache is bounded with TTL eviction
- Audio processing does not block the event loop (streaming chunks)

### NFR-4: Security

- Microphone permission required before audio capture
- Voice tokens are scoped to session and tenant
- Twilio/LiveKit credentials encrypted at rest
- KoreVG inbound auth token validates WebSocket connections
- Participant metadata validated before use (S6)
- Cross-tenant voice session isolation via tenantId scoping

### NFR-5: Compliance

- All voice transcripts captured for audit (always-capture policy)
- Call metadata recorded: duration, disposition, transfer events
- Data minimization via configurable transcript retention (always | on_success | never)
- Right to erasure cascades to voice transcripts and call recordings

---

## 6. Technical Architecture

### Component Overview

```
                    Web SDK Layer
    +-------+    +-------------+    +-----------+
    |Voice  |    |  Voice      |    | Twilio    |
    |Widget |    |  Client     |    | Adapter   |
    +---+---+    +------+------+    +-----+-----+
        |               |                |
        +-------+-------+--------+-------+
                |                 |
          WebSocket          WebRTC (Twilio)
                |                 |
    +-----------+-----------------+-----------+
    |           Runtime Server                |
    |  +------------+  +------------------+   |
    |  | SDK WS     |  | Twilio Media     |   |
    |  | Handler    |  | Handler          |   |
    |  +-----+------+  +--------+---------+   |
    |        |                   |             |
    |  +-----+-------------------+-------+    |
    |  |     Voice Session Resolver      |    |
    |  +-----+-------------------+-------+    |
    |        |                   |             |
    |  +-----+------+  +--------+---------+   |
    |  | Pipeline    |  | Realtime Voice   |   |
    |  | (Deepgram   |  | Executor         |   |
    |  |  + ElevenLabs)|  | (OpenAI/Gemini) |   |
    |  +-----+------+  +--------+---------+   |
    |        |                   |             |
    |  +-----+-------------------+-------+    |
    |  |     Runtime Executor            |    |
    |  +-----+-------------------+-------+    |
    |        |                   |             |
    |  +-----+------+  +--------+---------+   |
    |  | LiveKit    |  | KoreVG/Jambonz   |   |
    |  | Agent      |  | Router           |   |
    |  | Worker     |  |                  |   |
    |  +------------+  +------------------+   |
    |                 +-------------------+   |
    |                 | Orpheus Custom    |   |
    |                 | TTS HTTP / WS     |   |
    |                 +-------------------+   |
    +----------------------------------------+
```

### Key Files

| Component                 | Path                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| VoiceClient               | `packages/web-sdk/src/voice/VoiceClient.ts`                                 |
| VoiceWidget               | `packages/web-sdk/src/ui/VoiceWidget.ts`                                    |
| TwilioAdapter             | `packages/web-sdk/src/voice/TwilioAdapter.ts`                               |
| VADAdapter                | `packages/web-sdk/src/voice/VADAdapter.ts`                                  |
| RealtimeAudioPlayer       | `packages/web-sdk/src/voice/RealtimeAudioPlayer.ts`                         |
| Voice types               | `packages/web-sdk/src/voice/types.ts`                                       |
| Voice Pipeline            | `apps/runtime/src/services/voice/voice-pipeline.ts`                         |
| Voice Service Factory     | `apps/runtime/src/services/voice/voice-service-factory.ts`                  |
| Voice Mode Resolver       | `apps/runtime/src/services/voice/voice-mode-resolver.ts`                    |
| Voice Session Resolver    | `apps/runtime/src/services/voice/voice-session-resolver.ts`                 |
| Deepgram STT              | `apps/runtime/src/services/voice/deepgram-service.ts`                       |
| ElevenLabs TTS            | `apps/runtime/src/services/voice/elevenlabs-service.ts`                     |
| Twilio Service            | `apps/runtime/src/services/voice/twilio-service.ts`                         |
| LiveKit Agent Worker      | `apps/runtime/src/services/voice/livekit/agent-worker.ts`                   |
| LiveKit LLM Adapter       | `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts`            |
| KoreVG Router             | `apps/runtime/src/services/voice/korevg/korevg-router.ts`                   |
| KoreVG Verb Builder       | `apps/runtime/src/services/voice/korevg/verb-builder.ts`                    |
| KoreVG Grok LLM Payload   | `apps/runtime/src/services/voice/korevg/grok-llm-payload.ts`                |
| KoreVG Realtime LLM       | `apps/runtime/src/services/voice/korevg/realtime-llm-payload.ts`            |
| S2S Google Event Handler  | `apps/runtime/src/services/voice/korevg/s2s-google-event-handler.ts`        |
| S2S LLM Verb Builder      | `apps/runtime/src/services/voice/korevg/s2s-llm-verb-builder.ts`            |
| SIP Header Sanitizer      | `apps/runtime/src/services/voice/korevg/sip-header-sanitizer.ts`            |
| Homer Client              | `apps/runtime/src/services/voice/korevg/homer-client.ts`                    |
| Orpheus HTTP TTS Route    | `apps/runtime/src/routes/custom-tts.ts`                                     |
| Orpheus WS TTS Handler    | `apps/runtime/src/websocket/orpheus-custom-tts-handler.ts`                  |
| Orpheus PCM/TTS Service   | `apps/runtime/src/services/voice/orpheus-tts.ts`                            |
| Orpheus Playback Store    | `apps/runtime/src/services/voice/orpheus-playback-store.ts`                 |
| Orpheus Service Resolver  | `apps/runtime/src/services/voice/orpheus-service-instance-resolver.ts`      |
| Realtime Voice Executor   | `apps/runtime/src/services/voice/realtime-voice-executor.ts`                |
| Realtime Types            | `packages/compiler/src/platform/llm/realtime/types.ts`                      |
| OpenAI Realtime           | `packages/compiler/src/platform/llm/realtime/openai-realtime.ts`            |
| Gemini Live               | `packages/compiler/src/platform/llm/realtime/gemini-live.ts`                |
| Ultravox                  | `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts`          |
| Voice Runtime             | `packages/compiler/src/platform/runtimes/voice-runtime.ts`                  |
| IR Schema (VoiceConfigIR) | `packages/compiler/src/platform/ir/schema.ts`                               |
| SDK WS Handler            | `apps/runtime/src/websocket/sdk-handler.ts`                                 |
| Twilio Media Handler      | `apps/runtime/src/websocket/twilio-media-handler.ts`                        |
| Voice Credential Cache    | `apps/runtime/src/services/voice/voice-credential-cache.ts`                 |
| Jambonz Provisioning      | `apps/runtime/src/services/voice/jambonz-provisioning.service.ts`           |
| Softphone Webhooks        | `apps/runtime/src/routes/softphone-webhooks.ts`                             |
| Softphone Config Endpoint | `apps/runtime/src/routes/voice.ts` (softphone-config, softphone-numbers)    |
| LiveDial Button           | `apps/studio/src/components/softphone/SoftphoneButton.tsx`                  |
| LiveDial Popover          | `apps/studio/src/components/softphone/SoftphonePopover.tsx`                 |
| LiveDial DialPad          | `apps/studio/src/components/softphone/DialPad.tsx`                          |
| LiveDial CallControls     | `apps/studio/src/components/softphone/CallControls.tsx`                     |
| SoftphoneManager          | `apps/studio/src/lib/softphone-manager.ts`                                  |
| useSoftphone Hook         | `apps/studio/src/hooks/useSoftphone.ts`                                     |
| Softphone Store           | `apps/studio/src/store/softphone-store.ts`                                  |
| Softphone API Client      | `apps/studio/src/api/softphone.ts`                                          |
| AudioCodes SDK Types      | `apps/studio/src/types/audiocodes.d.ts`                                     |
| AudioCodes SDK Bundle     | `apps/studio/public/js/ac_webrtc.min.js`                                    |
| Studio Admin Voice UI     | `apps/studio/src/components/admin/VoiceServicesPage.tsx`                    |
| TTS Preview UI            | `apps/studio/src/components/voice/TTSPreview.tsx`                           |
| TTS Preview API Client    | `apps/studio/src/api/tts-preview.ts`                                        |
| TTS Preview Route         | `apps/runtime/src/routes/tts-preview.ts`                                    |
| Voice Analytics Route     | `apps/runtime/src/routes/voice-analytics.ts`                                |
| Voice Transfer Gateway    | `packages/agent-transfer/src/voice/voice-gateway.ts`                        |
| Voice Transfer Index      | `packages/agent-transfer/src/voice/index.ts`                                |
| Channel Configuration UI  | `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` |

---

## 7. Data Model

### VoiceConfigIR (IR Schema)

```typescript
interface VoiceConfigIR {
  ssml?: string; // SSML markup for TTS
  instructions?: string; // Voice-specific instructions
  plain_text?: string; // Plain text fallback
}
```

### RealtimeSessionConfig

```typescript
interface RealtimeSessionConfig {
  model: string;
  systemPrompt: string;
  tools?: ToolDefinition[];
  voice?: string;
  turnDetection?: RealtimeTurnDetection;
  audioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  sampleRate?: number;
  temperature?: number;
  maxResponseTokens?: number;
  apiKey: string;
  endpoint?: string;
}
```

### VoiceSession (Runtime)

```typescript
interface VoiceSession {
  session: Session;
  callMetadata: VoiceMetadata;
  transcriptBuffer: TranscriptEntry[];
  isActive: boolean;
  startTime: Date;
  lastActivityTime: Date;
}
```

### VoicePipelineConfig

```typescript
interface VoicePipelineConfig {
  sessionId: string;
  projectId: string;
  agentName: string;
  voiceId?: string;
  ttsServiceInstanceId?: string;
  asrServiceInstanceId?: string;
  orpheusWsStreamingEnabled?: boolean;
}
```

---

## 8. API Surface

### WebSocket Messages (Client -> Server)

| Message Type          | Fields                      | Description            |
| --------------------- | --------------------------- | ---------------------- |
| `voice_start`         | `sessionId`                 | Start voice session    |
| `voice_stop`          | `sessionId`                 | Stop voice session     |
| `voice_audio`         | `sessionId, audio` (base64) | Audio utterance chunk  |
| `speech_end`          | `sessionId`                 | Speech ended (VAD)     |
| `barge_in`            | `sessionId`                 | User interrupted agent |
| `voice_token_request` | `sessionId`                 | Request Twilio token   |

### WebSocket Messages (Server -> Client)

| Message Type                | Fields                      | Description                    |
| --------------------------- | --------------------------- | ------------------------------ |
| `voice_started`             | `voiceMode`                 | Session started, mode resolved |
| `transcription`             | `text, isFinal, confidence` | STT result                     |
| `voice_response_start`      | `messageId`                 | Agent response starting        |
| `voice_response_chunk`      | `messageId, text`           | Streaming text chunk           |
| `voice_response_end`        | `messageId, text`           | Agent response complete        |
| `voice_audio_chunk`         | `audio` (base64 MP3)        | TTS audio chunk                |
| `voice_speaking_end`        | -                           | All audio chunks sent          |
| `voice_speaking`            | `isSpeaking`                | Speaking state change          |
| `voice_processing`          | -                           | Processing user input          |
| `voice_error`               | `error`                     | Voice error occurred           |
| `voice_barge_in_ack`        | -                           | Barge-in acknowledged          |
| `voice_token`               | `token`                     | Twilio access token            |
| `voice_realtime_audio`      | `audio` (base64 PCM16)      | Realtime audio chunk           |
| `voice_realtime_transcript` | `text, role, isFinal`       | Realtime transcript            |

### KoreVG Verb Protocol

| Verb     | Purpose                                  |
| -------- | ---------------------------------------- |
| `say`    | Text-to-speech with optional streaming   |
| `gather` | Collect speech/DTMF input                |
| `config` | Configure session synthesizer/recognizer |
| `hangup` | End call                                 |
| `listen` | Start audio stream                       |

### LiveDial (Studio Softphone) REST Endpoints

| Endpoint                                     | Method | Auth     | Description                                                                                                                            |
| -------------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/voice/softphone-config`             | GET    | Required | Returns `sipDomain`, `wsServers[]`, `ready`, `warnings[]`                                                                              |
| `/api/v1/voice/softphone-numbers/:projectId` | GET    | Required | Returns phone numbers from project's active voice channel connections                                                                  |
| `/api/v1/voice/softphone/register`           | POST   | None     | Jambonz SIP device registration webhook — returns `{ status: 'ok' }`                                                                   |
| `/api/v1/voice/softphone/call`               | POST   | None     | Jambonz outbound call webhook — looks up configured app and returns `redirect` verb to route through same agent logic as inbound calls |

### TTS Preview

| Endpoint                    | Method | Auth     | Description                                                                        |
| --------------------------- | ------ | -------- | ---------------------------------------------------------------------------------- |
| `/api/v1/voice/tts-preview` | POST   | Required | Synthesize sample text via tenant-configured ElevenLabs or Orpheus (Groq) provider |

### Admin and Channel Configuration Surfaces

| Surface                              | Purpose                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `/admin/voice`                       | Configure tenant-scoped Orpheus via Groq service instances                |
| `/api/v1/tenant/service-instances`   | Persist encrypted `custom:orpheus` credentials                            |
| Voice pipeline channel configuration | Select exact ASR/TTS service instance ids and toggle Orpheus WS streaming |
| `/api/v1/voice/speech-options`       | Return Orpheus voices/languages for Studio dropdowns                      |

---

## 9. Security Considerations

1. **Credential Isolation**: Voice service credentials (Deepgram, ElevenLabs, Twilio, Orpheus) are encrypted at rest and scoped per tenant via TenantServiceInstance
2. **Session Authentication**: SDK WebSocket connections validated via public API key; KoreVG via inbound auth token
3. **Participant Validation**: LiveKit room participant metadata is validated before use (pattern matching on IDs)
4. **Audio Data Protection**: Audio streams are not persisted by default; only transcripts are stored
5. **Rate Limiting**: WebSocket message rate limiting prevents audio flood attacks
6. **Feature Flag**: Realtime voice can be globally disabled via REALTIME_VOICE_ENABLED kill switch
7. **Insecure Context Guards**: Softphone gracefully degrades on non-HTTPS origins — `crypto.randomUUID` falls back to `Math.random`, and `getUserMedia` unavailability is detected before call initiation with a user-friendly error
8. **Cross-Origin Voice Gateway**: KoreVG feature-server POST requests from external origins (e.g., `korevg-dev.kore.ai`) are authenticated via token, not browser CORS

---

## 10. Observability

### Voice Turn Traces

Each voice turn emits structured trace events with phase timing:

- `voice_turn_start`: STT phase begins
- `voice_stt_complete`: Transcription received
- `voice_llm_start` / `voice_llm_complete`: Agent processing
- `voice_tts_start` / `voice_tts_first_chunk` / `voice_tts_complete`: Audio synthesis
- `voice_turn_complete`: Full turn timing report

### Realtime Voice Metrics

- Session start/end with connection duration
- Turn completion with token usage
- Interruption events
- Tool call latency within realtime sessions

### Client Trace Context

WebSocket messages can include client-side trace context for end-to-end correlation.

---

## 11. Error Handling

| Error Scenario                 | Handling                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Microphone permission denied   | Emit `micPermissionDenied`, set state to error                                                       |
| Deepgram not configured        | Throw SERVICE_UNAVAILABLE, pipeline fails to start                                                   |
| ElevenLabs synthesis failure   | Log error, skip audio, continue text-only                                                            |
| Realtime provider disconnect   | Exponential backoff reconnect (max 3 retries)                                                        |
| LiveKit room join failure      | Log error, return error to client                                                                    |
| KoreVG WebSocket auth failure  | Reject connection                                                                                    |
| VAD library not available      | Graceful fallback to ManualVADAdapter (push-to-talk)                                                 |
| Audio playback failure         | Log warning, continue to next turn                                                                   |
| Twilio SDK not loaded          | Log warning, use WebSocket audio fallback                                                            |
| LiveDial SIP registration fail | Show "Registration failed" badge, disable call button                                                |
| LiveDial call rejected/busy    | Show friendly error banner with 8s auto-dismiss                                                      |
| LiveDial no microphone         | Recording falls back to remote-only audio                                                            |
| LiveDial Jambonz not ready     | Show grayed-out phone icon with warning tooltip                                                      |
| LiveDial insecure context      | `crypto.randomUUID` falls back to `Math.random`; `getUserMedia` shows "Microphone unavailable" error |

---

## 12. Performance Considerations

- **Streaming architecture**: All audio paths use streaming (no full-buffer-then-process)
- **Orpheus telephony modes**: Buffered `say` remains the baseline path; WS streaming is true at the telephony boundary but still HTTP-backed upstream to Groq per flush
- **Parallel execution**: Voice runtime supports parallel tool calls (maxParallelTools config)
- **Aggressive timeouts**: Voice runtime uses shorter timeouts than text runtime
- **Web Audio API**: RealtimeAudioPlayer uses AudioContext scheduling for gapless playback
- **Chunk accumulation**: Pipeline audio chunks are accumulated and combined for single-play (avoids gap between chunks)
- **PCM16 encoding**: Efficient binary format for realtime audio transport
- **Cache TTL**: Voice service factory caches with 10-minute TTL to avoid repeated credential decryption

---

## 13. Migration & Compatibility

- **Pipeline mode** is the default and requires no special configuration
- **Realtime mode** is opt-in via deployment config or agent IR hints
- **LiveKit integration** requires FEATURE_LIVEKIT_ENABLED=true and LiveKit server credentials
- **KoreVG integration** requires Jambonz provisioning and channel connection setup
- **Orpheus WS streaming** requires both runtime feature gates and per-connection opt-in
- **Web SDK** maintains backward compatibility: VoiceClient works without Twilio SDK (pure WebSocket fallback)
- **VAD** is optional: graceful fallback to push-to-talk when @ricky0123/vad-web is not installed

---

## 14. Testing Strategy

### Unit Tests

- VoiceClient state machine transitions
- VADAdapter initialization and event emission
- RealtimeAudioPlayer enqueue/interrupt/destroy lifecycle
- VerbBuilder verb construction from agent responses
- Voice mode resolver priority chain
- Voice credential cache TTL and invalidation

### Integration Tests

- Pipeline voice flow: audio -> STT -> executor -> TTS -> audio
- Realtime voice session: connect -> tool call -> transcript capture
- LiveKit agent worker: room join -> LLM adapter -> trace hooks (`livekit-voice.integration.test.ts`)
- Voice service factory: credential resolution -> service creation
- KoreVG router: WebSocket connect -> verb dispatch -> response
- KoreVG Grok LLM payload routing (`korevg-router-grok.test.ts`)
- Orpheus service-instance resolution and Jambonz provisioning idempotency
- Orpheus custom streaming handler: connect ack, stream, flush, binary PCM delivery
- TTS preview schema validation and provider routing (`tts-preview.test.ts`)
- S2S Google event handler and verb builder (`s2s-google-event-handler.test.ts`, `s2s-llm-verb-builder.test.ts`)

### E2E Tests

- Full web voice conversation via SDK WebSocket
- Phone call via KoreVG WebSocket with say/gather verbs
- Realtime voice session with tool execution
- Voice mode resolution across deployment/agent/global configs
- Barge-in interruption during active TTS playback
- Manual comparison of Orpheus buffered vs WS streaming modes on the same DID

---

## 15. Rollout Plan

| Phase           | Description                                                                                                                                                                                                                        | Gate                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| ALPHA (current) | Pipeline + realtime modes working, LiveKit integration active, KoreVG functional, LiveDial softphone operational, TTS preview, Orpheus admin/channel wiring, voice transfer gateway abstraction, Grok S2S, insecure-context guards | Core voice pipeline E2E passes       |
| BETA            | Telephony via SIP trunking, full observability dashboard, credential rotation                                                                                                                                                      | 5+ tenants using voice in staging    |
| STABLE          | Outbound campaigns, multi-language support, voice analytics pipeline                                                                                                                                                               | 30-day P0 bug-free, < 2s P95 latency |

---

## 16. Open Questions

1. **Outbound dialing**: ~~Should the platform initiate outbound calls, or is that purely a telephony provider responsibility?~~ **Partially resolved** — LiveDial (Studio Softphone) supports browser-based outbound calls via Jambonz SBC. Softphone `/call` webhook now redirects through the same Jambonz application as inbound calls for consistent agent logic. Fully automated outbound campaign dialing is still out of scope.
2. **Voice cloning**: Should we support custom voice cloning via ElevenLabs Professional Voice Cloning?
3. **Multi-language real-time**: How to handle language switching mid-conversation (e.g., Spanish to English)?
4. **Recording storage**: Where to store call recordings (S3? internal blob store?) and retention policies?
5. **Warm transfer**: ~~How to maintain conversation context when transferring from AI agent to human agent?~~ **Partially resolved** — `VoiceGatewaySession` interface in `@agent-platform/agent-transfer` provides `transferCall()`, `dialAgent()`, and `conferenceHumanAgent()` methods for provider-agnostic voice transfers. Full warm-transfer with context forwarding still requires integration testing.
6. **Groq upstream streaming**: Should the platform progressively pipe Groq audio to the WS path, or continue buffering per flush until transport quality is fully characterized?

---

## 17. Alternatives Considered

### Alternative 1: WebRTC-Only (No Pipeline Mode)

Use WebRTC for all voice interactions, eliminating the WebSocket audio pipeline.

**Pros:** Lower latency, simpler architecture, proven technology
**Cons:** Requires RTCPeerConnection support (not universal), more complex server infrastructure, doesn't work behind strict firewalls

**Decision:** Rejected. Pipeline mode via WebSocket is more universally compatible and provides a fallback for environments where WebRTC is unavailable.

### Alternative 2: Single Provider Lock-in

Standardize on a single STT+TTS+telephony provider (e.g., Twilio for everything).

**Pros:** Simpler integration, single credential set, consistent quality
**Cons:** Vendor lock-in, can't optimize per-use-case, pricing inflexibility

**Decision:** Rejected. Multi-provider architecture (Deepgram STT + ElevenLabs TTS + Twilio/LiveKit telephony) allows best-of-breed selection and tenant-level provider choice.

### Alternative 3: External Voice Gateway Only

Delegate all voice processing to an external gateway (e.g., Audiocodes, Genesys) and only receive text.

**Pros:** No voice infrastructure to maintain, enterprise-grade telephony
**Cons:** No control over latency, no realtime voice models, high per-minute costs

**Decision:** Rejected. Platform needs native voice control for realtime models, barge-in, and low-latency optimization.

---

## 18. References

- [RFC: LiveKit SIP Telephony Integration](../rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md)
- [KoreVG Integration Guide](../setup/KOREVG_INTEGRATION.md)
- [KoreVG Setup Guide](../setup/KOREVG_SETUP_GUIDE.md)
- [Jambonz Provisioning E2E](../setup/JAMBONZ_PROVISIONING_E2E.md)
- IR Schema: `packages/compiler/src/platform/ir/schema.ts`
- Realtime Types: `packages/compiler/src/platform/llm/realtime/types.ts`
