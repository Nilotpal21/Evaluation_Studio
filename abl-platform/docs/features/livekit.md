# Feature Spec: LiveKit Voice Integration

**Status:** BETA
**Author:** Platform Engineering
**Created:** 2026-03-23
**Last Updated:** 2026-03-23

---

## 1. Problem Statement

The ABL Platform needs a production-grade real-time voice channel that enables AI agents to conduct spoken conversations with users via WebRTC (browser) and PSTN telephony (phone calls). Voice is the primary interaction mode for contact center automation, appointment scheduling, and accessibility use cases. Without a unified voice pipeline, customers must build and maintain their own audio infrastructure, increasing time-to-production and operational burden.

### 1.1 Target Users

| Persona                | Need                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| **Platform Builder**   | Configure voice-enabled agents via Studio UI without managing audio infrastructure |
| **End User (Browser)** | Speak with an AI agent through a web-based voice interface with low latency        |
| **End User (Phone)**   | Call a phone number and interact with an AI agent via PSTN telephony               |
| **Enterprise Admin**   | Manage phone numbers, SIP trunks, voice credentials, and call routing per tenant   |
| **SDK Developer**      | Integrate voice into custom applications using the web SDK                         |

### 1.2 Business Context

- Kore.ai's competitors (Decagon, Sierra, Cognigy) all offer voice AI channels
- Contact center automation is the highest-value use case for enterprise customers
- Phone remains the primary communication channel for many industries (healthcare, finance, government)
- WebRTC voice provides a seamless browser-based testing and demo experience

---

## 2. Scope

### 2.1 In Scope

| Sub-Feature                     | Description                                                                                | Priority |
| ------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| **WebRTC Voice Pipeline**       | Browser-based real-time voice via LiveKit SDK (VAD -> STT -> RuntimeExecutor -> TTS)       | P0       |
| **LiveKit Agent Worker**        | In-process agent model with RuntimeBridgeAgent routing LLM calls through RuntimeExecutor   | P0       |
| **Token Generation API**        | Secure token endpoint with credential pre-flight, concurrency guards, and tenant isolation | P0       |
| **Voice Credential Management** | Tenant-scoped STT (Deepgram) and TTS (ElevenLabs) credential resolution with caching       | P0       |
| **Studio Voice Preview**        | Full-page voice preview UI with animated state orb, transcript panel, and timing metrics   | P0       |
| **Web SDK Voice Support**       | VoiceClient with pipeline and realtime modes, VAD, barge-in, audio capture                 | P0       |
| **Voice Observability**         | Trace hooks for per-turn timing (STT/LLM/TTS phases), data channel transcripts             | P0       |
| **SIP Telephony (Inbound)**     | PSTN calls via LiveKit SIP + Twilio Elastic SIP Trunking, inbound call routing             | P1       |
| **SIP Telephony (Outbound)**    | Agent-initiated outbound calls via outbound SIP trunks                                     | P2       |
| **DTMF Handling**               | Receive/send DTMF digits, digit collection with timeouts                                   | P1       |
| **Call Transfer**               | Cold transfer via SIP REFER to external numbers                                            | P2       |
| **Phone Number Management**     | Provision, configure, and route DID numbers per project                                    | P1       |
| **Call Recording**              | LiveKit egress-based call recording with S3 storage                                        | P2       |
| **Multi-Language STT**          | Language selection for Deepgram STT beyond English                                         | P2       |

### 2.2 Out of Scope

- Warm/consultative call transfers (requires hold + conference — deferred to v2)
- Video calling (audio-only for v1)
- Custom STT/TTS provider plugins (Deepgram + ElevenLabs only for v1)
- Call queuing with hold music and position announcements
- Voicemail detection and recording
- SMS/MMS messaging via the same phone numbers

---

## 3. Requirements

### 3.1 Functional Requirements

#### FR-1: WebRTC Voice Session Lifecycle

- **FR-1.1**: Client requests a LiveKit token via `POST /api/v1/livekit/token` with `sessionId`, `projectId`, optional `agentName` and `deploymentId`
- **FR-1.2**: Server validates all IDs against `/^[a-zA-Z0-9_\-]{1,128}$/`, returns 400 on invalid input
- **FR-1.3**: Server checks concurrent room count against `maxConcurrentRooms` (default: 50), returns 429 if exceeded
- **FR-1.4**: Server performs credential pre-flight (STT + TTS presence), returns 422 with details if missing
- **FR-1.5**: Server generates a LiveKit access token with room-scoped grants (join, publish, subscribe)
- **FR-1.6**: Server spawns an agent in the room (fire-and-forget) immediately after token generation
- **FR-1.7**: Agent worker initializes RuntimeLLMAdapter with deployment-aware or legacy DSL path
- **FR-1.8**: Audio pipeline activates: VAD (Silero) -> STT (Deepgram) -> LLM (RuntimeExecutor) -> TTS (ElevenLabs)
- **FR-1.9**: Agent returns streaming text via ReadableStream for concurrent TTS synthesis
- **FR-1.10**: Session cleanup on disconnect: AgentSession.close() -> Room.disconnect() -> adapter.dispose()

#### FR-2: Voice Credential Resolution

- **FR-2.1**: Credentials resolved per tenant from `TenantServiceInstance` records in MongoDB
- **FR-2.2**: API keys encrypted at rest (AES-256-GCM) via `EncryptionService`, decrypted on demand
- **FR-2.3**: Credential cache with 10-minute TTL per tenant, invalidated on auth profile updates via Redis pub/sub
- **FR-2.4**: Dual-read path: auth profile first, legacy encrypted field fallback

#### FR-3: Studio Voice Preview

- **FR-3.1**: Full-page voice preview at `/preview-livekit` with animated voice orb
- **FR-3.2**: Visual state indicators: idle, connecting (progressive steps), listening, processing, speaking, error
- **FR-3.3**: Real-time transcript panel showing user utterances and agent responses
- **FR-3.4**: Timing breakdown display (total, STT, LLM, TTS latencies) per turn
- **FR-3.5**: Connect/disconnect controls with microphone permission handling

#### FR-4: SIP Telephony (Inbound)

- **FR-4.1**: LiveKit SIP service bridges PSTN calls to LiveKit rooms via SIP INVITE
- **FR-4.2**: Dispatch rules route inbound calls: trunk ID -> called number -> room assignment
- **FR-4.3**: DID number -> tenant -> project -> deployment -> entry agent resolution chain
- **FR-4.4**: Agent delivers immediate greeting on SIP participant join (phone callers expect it)
- **FR-4.5**: SIP participant metadata (phone number, trunk ID, call status) available to agent context

#### FR-5: DTMF Support

- **FR-5.1**: Receive DTMF digits from SIP participants via LiveKit data channel events
- **FR-5.2**: Digit collection with configurable timeout (default: 5000ms) and max digits (default: 20)
- **FR-5.3**: Send DTMF digits from agent to SIP participant for IVR navigation
- **FR-5.4**: Platform tools: `sip.collect_digits`, `sip.send_dtmf`

#### FR-6: Telephony Management

- **FR-6.1**: CRUD API for SIP trunks under `/api/projects/:projectId/telephony/trunks`
- **FR-6.2**: Phone number provisioning via Twilio API integration
- **FR-6.3**: Number routing configuration: deployment, entry agent, greeting, features
- **FR-6.4**: Call history with filtering, pagination, and session trace linking
- **FR-6.5**: Studio telephony page with Phone Numbers, SIP Trunks, and Call History tabs

### 3.2 Non-Functional Requirements

| ID         | Requirement                                                   | Target                                 |
| ---------- | ------------------------------------------------------------- | -------------------------------------- |
| **NFR-1**  | End-to-end voice latency (speech end to first audio response) | < 2.5 seconds (P50), < 4 seconds (P99) |
| **NFR-2**  | Concurrent WebRTC voice sessions per runtime instance         | >= 50 (configurable)                   |
| **NFR-3**  | Token generation endpoint response time                       | < 200ms (P95)                          |
| **NFR-4**  | Voice credential resolution (cached)                          | < 5ms                                  |
| **NFR-5**  | Voice credential resolution (cold)                            | < 500ms                                |
| **NFR-6**  | Agent spawn to pipeline-ready latency                         | < 3 seconds                            |
| **NFR-7**  | Graceful shutdown — all sessions closed cleanly               | Within 30 seconds                      |
| **NFR-8**  | SIP call setup time (SIP INVITE to audio bidirectional)       | < 5 seconds                            |
| **NFR-9**  | DTMF digit detection accuracy                                 | > 99.5%                                |
| **NFR-10** | Availability (voice pipeline)                                 | 99.9% uptime                           |

---

## 4. User Stories

### US-1: WebRTC Voice Conversation

> As a **platform builder**, I want to test my agent's voice capabilities in the Studio preview, so that I can iterate on conversation design without deploying to production.

**Acceptance Criteria:**

- Click "Voice Preview" to open the LiveKit voice preview page
- Grant microphone permission when prompted
- Speak naturally and hear the agent respond within 3 seconds
- See real-time transcript of both user and agent speech
- See per-turn timing breakdown (STT, LLM, TTS)
- Click disconnect to cleanly end the session

### US-2: SDK Voice Integration

> As an **SDK developer**, I want to add voice capabilities to my web application using the platform SDK, so that my end users can speak with AI agents without building audio infrastructure.

**Acceptance Criteria:**

- Import `VoiceClient` from the web SDK
- Call `voiceClient.start()` to begin a voice session
- Receive events for state changes (listening, processing, speaking)
- Handle barge-in (user speaks while agent is responding)
- Call `voiceClient.stop()` to cleanly disconnect

### US-3: Inbound Phone Call

> As an **end user**, I want to call a phone number and interact with an AI agent by speaking naturally, so that I can get help without using a computer.

**Acceptance Criteria:**

- Dial the assigned phone number
- Hear an immediate greeting from the agent
- Speak naturally and hear responses within 3-4 seconds
- Use DTMF keypad when prompted (e.g., "Press 1 for billing")
- Call ends cleanly when either party hangs up

### US-4: Phone Number Setup

> As an **enterprise admin**, I want to provision phone numbers and configure call routing in Studio, so that I can assign AI agents to handle calls on specific numbers.

**Acceptance Criteria:**

- Navigate to Telephony page in Studio
- Search and provision available phone numbers from Twilio
- Assign a number to a specific deployment and entry agent
- Configure greeting message and features (DTMF, recording)
- See call history with duration, status, and session trace links

### US-5: Tenant Voice Credential Configuration

> As an **enterprise admin**, I want to configure STT and TTS credentials per tenant, so that voice services use my organization's API keys and billing.

**Acceptance Criteria:**

- Navigate to Admin > Voice Services
- Add Deepgram STT credentials (API key, model selection)
- Add ElevenLabs TTS credentials (API key, voice ID, model)
- Credentials encrypted at rest, decrypted only during voice sessions
- Credential changes take effect within 10 minutes (cache TTL)

---

## 5. Existing Implementation Inventory

The LiveKit integration already has substantial production code:

| Component                   | Location                                                         | Status     |
| --------------------------- | ---------------------------------------------------------------- | ---------- |
| LiveKit Agent Worker        | `apps/runtime/src/services/voice/livekit/agent-worker.ts`        | Production |
| RuntimeLLMAdapter           | `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` | Production |
| Worker Entry (lifecycle)    | `apps/runtime/src/services/voice/livekit/worker-entry.ts`        | Production |
| Trace Hooks                 | `apps/runtime/src/services/voice/livekit/livekit-trace-hooks.ts` | Production |
| Voice Service Factory       | `apps/runtime/src/services/voice/voice-service-factory.ts`       | Production |
| Voice Config Schema         | `packages/config/src/schemas/voice.schema.ts`                    | Production |
| Voice Events (EventStore)   | `packages/eventstore/src/schema/events/voice-events.ts`          | Production |
| Studio Voice Preview Page   | `apps/studio/src/app/preview-livekit/page.tsx`                   | Production |
| Studio Token Proxy          | `apps/studio/src/app/api/livekit/token/route.ts`                 | Production |
| Studio Capabilities Proxy   | `apps/studio/src/app/api/livekit/capabilities/route.ts`          | Production |
| Web SDK VoiceClient         | `packages/web-sdk/src/voice/VoiceClient.ts`                      | Production |
| Web SDK Voice Types         | `packages/web-sdk/src/voice/types.ts`                            | Production |
| Web SDK AudioCapture        | `packages/web-sdk/src/voice/AudioCapture.ts`                     | Production |
| Web SDK VADAdapter          | `packages/web-sdk/src/voice/VADAdapter.ts`                       | Production |
| Web SDK RealtimeAudioPlayer | `packages/web-sdk/src/voice/RealtimeAudioPlayer.ts`              | Production |
| Start Script (dev)          | `scripts/start-livekit.sh`                                       | Production |
| Architecture Doc            | `apps/runtime/src/services/voice/livekit/ARCHITECTURE.md`        | Production |
| SIP Telephony RFC           | `docs/rfcs/RFC_LIVEKIT_SIP_TELEPHONY.md`                         | Draft      |
| i18n Voice Strings          | `packages/i18n/locales/en/studio.json`                           | Partial    |

### What Remains to Build

| Component                                           | Priority | Effort |
| --------------------------------------------------- | -------- | ------ |
| SIP Trunk Management Service                        | P1       | Large  |
| Telephony REST API Routes                           | P1       | Medium |
| SIP Call Lifecycle Handler                          | P1       | Large  |
| Agent Greeting on SIP Join                          | P1       | Small  |
| DTMF Handler                                        | P1       | Medium |
| Phone Number Provisioning (Twilio API)              | P1       | Medium |
| Studio Telephony Page                               | P1       | Large  |
| Database Models (PhoneNumber, SIPTrunk, CallRecord) | P1       | Medium |
| DSL TELEPHONY Block (compiler)                      | P2       | Medium |
| Outbound Call Tool                                  | P2       | Medium |
| Call Transfer (SIP REFER)                           | P2       | Medium |
| Call Recording (LiveKit Egress)                     | P2       | Large  |
| Multi-Language STT                                  | P2       | Small  |

---

## 6. Technical Constraints

1. **LiveKit SIP requires host networking**: The SIP service needs a public IP and UDP ports 5060 + 10000-20000. Not compatible with serverless or shared k8s clusters.
2. **Optional Dependencies**: All `@livekit/*` packages are optional — dynamic imports used throughout to avoid build-time dependency on LiveKit types.
3. **Feature Flag Gated**: `FEATURE_LIVEKIT_ENABLED=true` required to activate the voice pipeline.
4. **In-Process Model**: Agents run embedded in the runtime server process (no forked child processes) to maintain cross-process adapter registry and tsx dev mode compatibility.
5. **Tenant Isolation**: Room names scoped as `voice_{tenantId}_{projectId}_{sessionId}` to prevent cross-tenant collision. tenantId is server-authoritative from JWT, never from participant metadata.
6. **External API Bottleneck**: Each concurrent call holds 3 persistent connections (STT WebSocket, LLM request, TTS WebSocket). Scaling wall is external provider concurrency limits, not LiveKit infrastructure.

---

## 7. Decision Log

| #   | Decision                                                | Classification | Rationale                                                                      |
| --- | ------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| D1  | In-process agent model (not forked processes)           | DECIDED        | Eliminates cross-process adapter registry issues, compatible with tsx dev mode |
| D2  | Deepgram for STT, ElevenLabs for TTS                    | DECIDED        | Best-in-class latency for real-time voice AI; tenant-configurable              |
| D3  | Silero VAD as optional (graceful degradation)           | DECIDED        | Pipeline proceeds without VAD — all audio treated as speech                    |
| D4  | LiveKit SIP (Option A) for telephony                    | DECIDED        | Unified room model, native SIP features, proven at scale via LiveKit Cloud     |
| D5  | Twilio as primary SIP trunk provider                    | DECIDED        | Best documentation, dedicated LiveKit integration guide, broadest coverage     |
| D6  | Fire-and-forget agent spawn after token generation      | DECIDED        | Non-blocking HTTP response; agent connects before or shortly after user        |
| D7  | Deferred DB session creation (on first chat, not spawn) | DECIDED        | Prevents ghost sessions from agent spawns that never receive audio             |
| D8  | Stream-first LLM response (ReadableStream)              | DECIDED        | TTS starts synthesizing from first chunk without waiting for full response     |

---

## 8. Dependencies

| Dependency                      | Type           | Notes                                                 |
| ------------------------------- | -------------- | ----------------------------------------------------- |
| LiveKit Server                  | Infrastructure | SFU for WebRTC media routing                          |
| LiveKit SIP Service             | Infrastructure | SIP-to-WebRTC bridge (telephony only)                 |
| Deepgram                        | External API   | Speech-to-text (nova-3 model)                         |
| ElevenLabs                      | External API   | Text-to-speech (eleven_turbo_v2 model)                |
| Twilio Elastic SIP Trunking     | External API   | PSTN connectivity (telephony only)                    |
| Redis                           | Infrastructure | Session state, credential cache invalidation          |
| MongoDB                         | Infrastructure | Credential storage, session persistence, call records |
| `@livekit/agents`               | npm (optional) | v1.0 agent framework                                  |
| `@livekit/agents-plugin-silero` | npm (optional) | VAD plugin                                            |
| `@livekit/rtc-node`             | npm (optional) | Room connection                                       |
| `@livekit/server-sdk-node`      | npm (optional) | Token generation, SIP API                             |
