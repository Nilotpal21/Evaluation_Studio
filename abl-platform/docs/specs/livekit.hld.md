# High-Level Design: LiveKit Voice Integration

**Feature:** LiveKit Voice Integration
**Status:** ALPHA
**Created:** 2026-03-23
**Last Updated:** 2026-03-23

---

## 1. Architecture Overview

The LiveKit Voice Integration provides real-time voice AI capabilities through two channels: WebRTC (browser) and PSTN telephony (phone calls). Both channels converge on the same RuntimeBridgeAgent pipeline, ensuring agents behave identically regardless of the audio transport.

```
                     ┌─────────────────────────────────────┐
                     │          Client Layer                │
                     │                                     │
                     │  ┌──────────┐    ┌──────────────┐   │
                     │  │ Browser  │    │  Phone/PSTN  │   │
                     │  │ (WebRTC) │    │  (SIP)       │   │
                     │  └────┬─────┘    └──────┬───────┘   │
                     └───────┼─────────────────┼───────────┘
                             │                 │
                     ┌───────┼─────────────────┼───────────┐
                     │       │   LiveKit Layer  │           │
                     │       ▼                 ▼           │
                     │  ┌──────────┐    ┌──────────────┐   │
                     │  │ LiveKit  │    │ LiveKit SIP  │   │
                     │  │ Server   │◄───│ Service      │   │
                     │  │ (SFU)    │    │ (Bridge)     │   │
                     │  └────┬─────┘    └──────────────┘   │
                     │       │                             │
                     │       │  Redis (shared state)       │
                     └───────┼─────────────────────────────┘
                             │ WebRTC audio tracks
                     ┌───────┼─────────────────────────────┐
                     │       ▼   Runtime Layer              │
                     │                                     │
                     │  ┌─────────────────────────────┐    │
                     │  │      Agent Worker            │    │
                     │  │  ┌─────┐ ┌────┐ ┌───────┐   │    │
                     │  │  │ VAD │→│STT │→│Runtime│   │    │
                     │  │  │Silero│ │DG  │ │Exec.  │   │    │
                     │  │  └─────┘ └────┘ └───┬───┘   │    │
                     │  │                     │       │    │
                     │  │                ┌────▼────┐  │    │
                     │  │                │  TTS    │  │    │
                     │  │                │ElevenLabs│  │    │
                     │  │                └─────────┘  │    │
                     │  └─────────────────────────────┘    │
                     │                                     │
                     │  ┌────────────┐  ┌──────────────┐   │
                     │  │ Token API  │  │ Telephony    │   │
                     │  │ /livekit/* │  │ API /tel/*   │   │
                     │  └────────────┘  └──────────────┘   │
                     └─────────────────────────────────────┘
                             │
                     ┌───────┼─────────────────────────────┐
                     │       ▼   Data Layer                 │
                     │                                     │
                     │  ┌──────────┐  ┌──────────────┐     │
                     │  │ MongoDB  │  │    Redis      │     │
                     │  │ Sessions │  │ Cred Cache    │     │
                     │  │ Calls    │  │ Session State │     │
                     │  │ Creds    │  │ Pub/Sub       │     │
                     │  └──────────┘  └──────────────┘     │
                     └─────────────────────────────────────┘
```

### Key Design Principle: Unified Pipeline

Both WebRTC and SIP callers are **LiveKit room participants**. The RuntimeBridgeAgent subscribes to the participant's audio track and publishes response audio. The agent does not know or care whether the participant is a browser or a phone — the audio pipeline is identical.

---

## 2. Component Architecture

### 2.1 Token Generation API

**Location:** `apps/runtime/src/routes/livekit.ts` (existing)

Responsible for authenticating the client, validating inputs, performing credential pre-flight, generating a scoped LiveKit access token, and spawning an agent.

**Request flow:**

```
POST /api/v1/livekit/token
  → Auth middleware (JWT or API key)
  → Input validation (ID patterns)
  → Concurrency check (activeRoomCount vs maxConcurrentRooms)
  → Credential pre-flight (STT + TTS for tenant)
  → Token generation (room-scoped grants)
  → Agent spawn (fire-and-forget)
  → Response: { token, roomName, url, identity }
```

**Security:**

- tenantId extracted from JWT (server-authoritative, never from request body)
- Room name format: `voice_{tenantId}_{projectId}_{sessionId}` (prevents cross-tenant collision)
- User token grants: join=true, publish=true, subscribe=true, publishData=false

### 2.2 Agent Worker (In-Process Model)

**Location:** `apps/runtime/src/services/voice/livekit/agent-worker.ts` (existing)

The agent worker runs embedded in the runtime server process. No forked child processes.

**Initialization sequence (per room):**

1. Create `RuntimeLLMAdapter` with session metadata
2. Initialize adapter (deployment-aware or legacy DSL compile)
3. Register adapter in global tracking map
4. Resolve tenant voice credentials (Deepgram STT + ElevenLabs TTS)
5. Generate agent-scoped access token with `canPublishData: true`
6. Connect to LiveKit room via `@livekit/rtc-node`
7. Load plugins: Deepgram STT, ElevenLabs TTS, Silero VAD (optional)
8. Create `RuntimeBridgeAgent` (extends `voice.Agent`, overrides `llmNode()`)
9. Create `AgentSession` and start pipeline

**Per-turn flow:**

```
User speaks → VAD detects speech end → Deepgram STT transcribes
  → Pipeline calls agent.llmNode(chatCtx)
  → RuntimeBridgeAgent extracts user text from ChatContext
  → Creates ReadableStream<string> returned immediately to TTS
  → Background: adapter.chat(userText, onChunk) → RuntimeExecutor
  → Each chunk enqueued to stream → TTS synthesizes concurrently
  → Audio published to room → User hears response
  → Transcript + timing sent via data channel
```

### 2.3 RuntimeLLMAdapter

**Location:** `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` (existing)

Bridges LiveKit's agent framework with the platform's RuntimeExecutor.

**Two initialization paths:**

| Path             | Trigger                | Mechanism                                              | Advantage               |
| ---------------- | ---------------------- | ------------------------------------------------------ | ----------------------- |
| Deployment-aware | `deploymentId` present | `DeploymentResolver.resolve()` → pre-compiled IR       | Faster, version-pinned  |
| Legacy DSL       | No `deploymentId`      | DSL cache (5-min TTL, max 500 entries) + fresh compile | Development flexibility |

**Key behaviors:**

- Deferred DB session creation: session only created in MongoDB on first `chat()` call, preventing ghost sessions from agent spawns that never receive audio
- Chat timeout: 30-second limit prevents indefinite hangs
- Token metrics accumulated from trace events
- Tenant-guarded project lookup (`findProjectWithAgents(projectId, tenantId)`)

### 2.4 Voice Service Factory

**Location:** `apps/runtime/src/services/voice/voice-service-factory.ts` (existing)

Tenant-aware voice service resolution with caching.

**Credential resolution flow:**

```
resolveVoiceCredentials(tenantId)
  → resolveAndDecrypt(tenantId, 'deepgram')
  → resolveAndDecrypt(tenantId, 'elevenlabs')

resolveAndDecrypt(tenantId, serviceType)
  → resolveInstance(tenantId, serviceType)  // MongoDB: TenantServiceInstance
  → dualReadCredentials:
      1. Auth profile path (preferred): resolveAuthProfileCredentials()
      2. Legacy fallback: EncryptionService.decryptForTenant()
```

**Caching:**

- Service instances cached 10 minutes per tenant
- Cache invalidated via Redis pub/sub on `auth-profile:updated` events
- Service factory subscribes to Redis for real-time invalidation

### 2.5 Voice Observability

**Location:** `apps/runtime/src/services/voice/livekit/livekit-trace-hooks.ts` (existing)

Maps LiveKit agent pipeline events to the platform's unified voice trace system.

**Trace events per turn:**

| Phase           | Trace Function              | Metrics                                          |
| --------------- | --------------------------- | ------------------------------------------------ |
| Turn start      | `traceLiveKitTurnStart`     | sessionId, utterance                             |
| STT complete    | `traceLiveKitSTT`           | transcript, confidence, durationMs               |
| LLM start       | `traceLiveKitLLMStart`      | provider: runtime-executor                       |
| LLM end         | `traceLiveKitLLMEnd`        | response, durationMs                             |
| TTS start       | `traceLiveKitTTSStart`      | provider: elevenlabs                             |
| TTS first chunk | `traceLiveKitTTSFirstChunk` | chunkSize                                        |
| TTS end         | `traceLiveKitTTSEnd`        | -                                                |
| Turn complete   | `traceLiveKitTurnComplete`  | totalLatency, sttLatency, llmLatency, ttsLatency |
| Turn failed     | `traceLiveKitTurnFailed`    | error                                            |

**Data channel messages:** Transcript and timing sent to client via reliable data channel for real-time UI display.

### 2.6 Studio Voice Preview

**Location:** `apps/studio/src/app/preview-livekit/page.tsx` (existing)

Full-page voice interface with:

- **VoiceOrb:** Animated state indicator (idle → connecting → listening → processing → speaking → error)
- **Progressive connection steps:** token → room → mic → ready
- **Transcript panel:** Real-time display of user/agent turns
- **Timing display:** Per-turn breakdown (total, STT, LLM, TTS)
- **Connect/disconnect controls**

**Token flow:** Studio proxies to runtime via `/api/livekit/token` and `/api/livekit/capabilities` Next.js API routes.

### 2.7 SIP Telephony (P1 — To Be Built)

**Proposed architecture** (from RFC_LIVEKIT_SIP_TELEPHONY.md):

```
Phone → PSTN → Twilio SIP Trunk → LiveKit SIP Service → LiveKit Room
                                                              │
                                                    RuntimeBridgeAgent
                                                    (same pipeline as WebRTC)
```

**New components needed:**

| Component                  | Responsibility                                      |
| -------------------------- | --------------------------------------------------- |
| SIP Trunk Service          | CRUD + sync with LiveKit SIP API                    |
| SIP Call Lifecycle Handler | Webhook → room → agent spawn, DID resolution        |
| DTMF Handler               | Digit receive/send/collection via LiveKit events    |
| Telephony Routes           | REST API for trunk/number/call management           |
| Phone Number Provisioning  | Twilio API integration for number search + purchase |
| Call Record Store          | MongoDB model for call history and analytics        |

**DID resolution chain:**

```
Inbound call (DID +15105550123)
  → PhoneNumber lookup (number → tenantId, projectId)
  → Project lookup (projectId → deploymentId, entryAgent)
  → Agent spawn with SIP-enriched metadata
  → Immediate greeting (phone callers expect it)
```

---

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

- Room names scoped: `voice_{tenantId}_{projectId}_{sessionId}`
- Token generation requires tenant-authenticated request (JWT or API key)
- `tenantId` is server-authoritative — extracted from JWT, never from request body or participant metadata
- Cross-tenant project access returns 404 (not 403)
- Voice credentials resolved per tenant from `TenantServiceInstance`
- DSL cache key includes tenantId: `${tenantId}:${projectId}`
- SIP trunks, phone numbers, call records all tenant-scoped with `tenantId` field

### 3.2 Authentication & Authorization

- Token endpoint: `createUnifiedAuthMiddleware` (JWT + API key)
- Studio proxy: `requireAuth()` for user JWT, `X-SDK-Token` header for SDK path
- LiveKit tokens: room-scoped grants with separate user/agent permission sets
- Agent token: `canPublishData: true` (transcript/timing), user token: `canPublishData: false`
- Telephony routes: `requireProjectPermission(req, res, 'telephony:write')` for management
- SIP trunk credentials: encrypted via `EncryptionService` (AES-256-GCM)

### 3.3 Performance

- **Streaming-first response:** `ReadableStream<string>` returned to TTS immediately; TTS synthesizes from first chunk without waiting for full response
- **DSL cache:** 5-minute TTL, max 500 entries, avoids re-fetching project DSLs per room
- **Credential cache:** 10-minute TTL per tenant, avoids decryption per request
- **Deferred DB session:** Created on first `chat()`, not on agent spawn — prevents ghost sessions
- **Fire-and-forget spawn:** HTTP response returned before agent connects
- **Chat timeout:** 30-second limit prevents indefinite resource consumption
- **Latency budget:** Target < 2.5s P50 (STT ~250ms + LLM ~1500ms + TTS ~500ms + overhead ~250ms)

### 3.4 Scalability

- **Horizontal scaling:** Add runtime instances; each supports 50 concurrent rooms (configurable)
- **Concurrency guard:** `activeRoomCount()` enforces `maxConcurrentRooms` per instance
- **External API bottleneck:** Each call holds 3 persistent connections (STT, LLM, TTS) — scaling wall is provider concurrency limits
- **LiveKit SFU:** Handles 100K+ rooms (Cloud); voice AI = 2 participants/room
- **SIP service:** DNS SRV for multi-instance, ~5000 concurrent per instance (UDP port range)
- **Agent server:** 4 cores / 8GB RAM → 10-25 concurrent calls per instance

### 3.5 Reliability

- **Graceful degradation:** Silero VAD optional (all audio treated as speech if unavailable); data channel non-critical; DB session non-critical
- **Graceful shutdown:** `stopLiveKitWorker()` closes all sessions, disconnects all rooms, disposes all adapters via `Promise.allSettled()`
- **Error isolation:** Each voice session has its own adapter + room; failure in one does not affect others
- **Deployment fallback:** If DeploymentResolver fails (non-410), falls back to legacy DSL compile
- **Chat error handling:** Timeout or execution errors produce "I encountered an error. Please try again." audio response

### 3.6 Observability

- **Voice trace hooks:** Full per-turn trace with phase-level timing (STT, LLM, TTS)
- **EventStore events:** `voice.session.started`, `voice.session.ended`, `voice.turn.completed`, `voice.stt.completed`, `voice.tts.completed`, `voice.barge_in.detected`
- **Structured logging:** All components use `createLogger('module')` — never console.log
- **Data channel metrics:** Real-time transcript + timing sent to client
- **Health probes:** `isLiveKitWorkerRunning()` for readiness checks

### 3.7 Data Model

**Existing models (production):**

| Model                 | Storage | Purpose                                         |
| --------------------- | ------- | ----------------------------------------------- |
| TenantServiceInstance | MongoDB | Voice credentials (STT/TTS API keys)            |
| ConversationSession   | MongoDB | Voice session records (channel: 'voice')        |
| ConversationMessage   | MongoDB | Turn messages (user utterance + agent response) |

**New models (telephony — to be built):**

| Model       | Storage | Purpose                                            |
| ----------- | ------- | -------------------------------------------------- |
| SIPTrunk    | MongoDB | SIP trunk configuration per tenant/project         |
| PhoneNumber | MongoDB | DID numbers mapped to trunks and agents            |
| CallRecord  | MongoDB | Call history with timing, status, and session link |

### 3.8 API Surface

**Existing endpoints (production):**

| Method | Path                           | Purpose                            |
| ------ | ------------------------------ | ---------------------------------- |
| POST   | `/api/v1/livekit/token`        | Generate LiveKit access token      |
| GET    | `/api/v1/livekit/capabilities` | Query LiveKit feature availability |

**New endpoints (telephony — to be built):**

| Method | Path                                                 | Purpose                  |
| ------ | ---------------------------------------------------- | ------------------------ |
| POST   | `/api/projects/:projectId/telephony/trunks`          | Create SIP trunk         |
| GET    | `/api/projects/:projectId/telephony/trunks`          | List SIP trunks          |
| GET    | `/api/projects/:projectId/telephony/trunks/:id`      | Get trunk detail         |
| PATCH  | `/api/projects/:projectId/telephony/trunks/:id`      | Update trunk             |
| DELETE | `/api/projects/:projectId/telephony/trunks/:id`      | Delete trunk             |
| POST   | `/api/projects/:projectId/telephony/trunks/:id/test` | Test trunk connectivity  |
| GET    | `/api/projects/:projectId/telephony/numbers`         | List phone numbers       |
| POST   | `/api/projects/:projectId/telephony/numbers`         | Provision number         |
| PATCH  | `/api/projects/:projectId/telephony/numbers/:id`     | Configure routing        |
| DELETE | `/api/projects/:projectId/telephony/numbers/:id`     | Release number           |
| POST   | `/api/projects/:projectId/telephony/numbers/search`  | Search available numbers |
| GET    | `/api/projects/:projectId/telephony/calls`           | Call history             |
| GET    | `/api/projects/:projectId/telephony/calls/:callId`   | Call detail              |
| POST   | `/api/projects/:projectId/telephony/calls/outbound`  | Initiate outbound call   |

### 3.9 Security

- **Transport:** LiveKit uses WSS (TLS) for signaling, DTLS-SRTP for media
- **SIP security:** TLS signaling (port 5061), SRTP media encryption (configurable per trunk)
- **Credential encryption:** AES-256-GCM via EncryptionService for all stored API keys
- **Input validation:** All IDs validated against `/^[a-zA-Z0-9_\-]{1,128}$/` to prevent path traversal
- **No client-supplied tenantId:** Always extracted from server-authoritative JWT
- **Toll fraud prevention:** Per-tenant outbound concurrency limits, destination allowlists, international blocking
- **PII handling:** Existing pii-detector applied to STT transcripts; call recordings require consent configuration

### 3.10 Compliance

- **Data minimization:** Voice audio is not stored by default (only transcripts via conversation store)
- **Call recording consent:** Configurable per-number, announcement before recording starts
- **Retention:** Call records follow tenant-scoped retention policies
- **Right to erasure:** Deleting a tenant cascades to all call records, phone numbers, and SIP trunks
- **Audit logging:** All telephony management operations logged via existing audit trail

### 3.11 Error Handling

| Error Category            | Handling Strategy                                      |
| ------------------------- | ------------------------------------------------------ |
| Invalid input IDs         | 400 with validation details                            |
| Auth failure              | 401 Unauthorized                                       |
| Cross-tenant access       | 404 Not Found (no existence leaking)                   |
| Missing voice credentials | 422 with specific gap details                          |
| Concurrency limit         | 429 Too Many Requests                                  |
| LiveKit not configured    | 503 Service Unavailable                                |
| Agent spawn failure       | Logged, fire-and-forget (user joins room but no agent) |
| Chat timeout (30s)        | Trace failed turn, speak error message to user         |
| Plugin load failure       | Logged, agent spawn aborted                            |
| SIP trunk sync failure    | Retry with backoff, mark trunk as error status         |

### 3.12 Migration & Rollout

- **Feature flag:** `FEATURE_LIVEKIT_ENABLED` gates the entire voice pipeline
- **Backward compatible:** No breaking changes to existing text-based channels
- **Incremental rollout:** WebRTC voice (P0, existing) → SIP inbound (P1) → DTMF (P1) → outbound (P2)
- **Database migration:** New telephony models are additive (no schema changes to existing collections)
- **Configuration migration:** Voice config schema extended with optional SIP block (backward compatible)

---

## 4. Alternatives Considered

### 4.1 Forked Process Model vs In-Process

| Aspect           | Forked Process              | In-Process (chosen)             |
| ---------------- | --------------------------- | ------------------------------- |
| Isolation        | OS-level per call           | Shared process                  |
| Memory           | Higher (duplicated runtime) | Lower (shared)                  |
| Adapter registry | Cross-process IPC needed    | Direct memory reference         |
| tsx dev mode     | Broken (fork doesn't work)  | Works                           |
| Crash isolation  | Process crash isolated      | Unhandled exception affects all |

**Decision:** In-process model chosen for simplicity and dev-mode compatibility. Crash isolation mitigated via error boundaries in each voice session.

### 4.2 Telephony Architecture Options

| Option                          | Description                                               | Chosen?                       |
| ------------------------------- | --------------------------------------------------------- | ----------------------------- |
| A: LiveKit SIP (native bridge)  | SIP service bridges directly to LiveKit rooms             | Yes (primary)                 |
| B: Twilio Media Streams + proxy | Twilio streams audio to server, server proxies to LiveKit | Fallback option               |
| C: Twilio direct (no LiveKit)   | Separate pipeline, no LiveKit for phone                   | Rejected (divergent pipeline) |

**Decision:** Option A for unified room model and native SIP features. Option B reserved as fallback for environments without host networking.

### 4.3 STT/TTS Provider Selection

| Provider               | Considered For | Status                                |
| ---------------------- | -------------- | ------------------------------------- |
| Deepgram (nova-3)      | STT            | Chosen — best streaming latency       |
| Google Cloud STT       | STT            | Deferred — multi-provider support v2  |
| ElevenLabs (turbo_v2)  | TTS            | Chosen — best voice quality + latency |
| Azure Cognitive Speech | TTS            | Deferred — multi-provider support v2  |

---

## 5. Risks and Mitigations

| Risk                                                        | Probability | Impact | Mitigation                                                |
| ----------------------------------------------------------- | ----------- | ------ | --------------------------------------------------------- |
| LiveKit SIP requires host networking (no k8s)               | High        | Medium | Option B (Twilio proxy) as fallback; LiveKit Cloud option |
| External API concurrency limits (STT/TTS)                   | Medium      | High   | Multi-provider failover, quota monitoring, backpressure   |
| LLM latency dominates end-to-end voice latency              | High        | Medium | Streaming-first response, model selection guidance        |
| Silero VAD model not available on all platforms             | Low         | Low    | Graceful degradation — pipeline works without VAD         |
| SIP trunk credential rotation breaks active calls           | Low         | Medium | Grace period during rotation, cache TTL alignment         |
| Ghost sessions from spawned agents that never receive audio | Medium      | Low    | Deferred DB session creation (already implemented)        |

---

## 6. File Map

### Existing (Production)

| File                                                             | Purpose                                      |
| ---------------------------------------------------------------- | -------------------------------------------- |
| `apps/runtime/src/services/voice/livekit/index.ts`               | Barrel exports                               |
| `apps/runtime/src/services/voice/livekit/agent-worker.ts`        | Room connection, plugins, RuntimeBridgeAgent |
| `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` | RuntimeExecutor bridge                       |
| `apps/runtime/src/services/voice/livekit/worker-entry.ts`        | Worker lifecycle, spawn, registry            |
| `apps/runtime/src/services/voice/livekit/livekit-trace-hooks.ts` | Voice trace integration                      |
| `apps/runtime/src/services/voice/livekit/ARCHITECTURE.md`        | State machine documentation                  |
| `apps/runtime/src/services/voice/voice-service-factory.ts`       | Tenant credential resolution                 |
| `apps/runtime/src/services/voice/voice-mode-resolver.ts`         | Pipeline vs realtime mode                    |
| `apps/runtime/src/services/voice/deepgram-service.ts`            | Deepgram STT service                         |
| `apps/runtime/src/services/voice/elevenlabs-service.ts`          | ElevenLabs TTS service                       |
| `packages/config/src/schemas/voice.schema.ts`                    | Voice configuration schema                   |
| `packages/eventstore/src/schema/events/voice-events.ts`          | Voice event schemas                          |
| `packages/web-sdk/src/voice/VoiceClient.ts`                      | Browser voice client                         |
| `packages/web-sdk/src/voice/AudioCapture.ts`                     | Browser audio capture                        |
| `packages/web-sdk/src/voice/VADAdapter.ts`                       | Browser VAD adapter                          |
| `apps/studio/src/app/preview-livekit/page.tsx`                   | Studio voice preview                         |
| `apps/studio/src/app/api/livekit/token/route.ts`                 | Studio token proxy                           |
| `apps/studio/src/app/api/livekit/capabilities/route.ts`          | Studio capabilities proxy                    |
| `scripts/start-livekit.sh`                                       | Dev server start script                      |

### New (To Be Built)

| File                                                        | Purpose                           |
| ----------------------------------------------------------- | --------------------------------- |
| `apps/runtime/src/services/telephony/sip-trunk-service.ts`  | SIP trunk CRUD + LiveKit API sync |
| `apps/runtime/src/services/telephony/sip-call-handler.ts`   | Inbound call lifecycle            |
| `apps/runtime/src/services/telephony/dtmf-handler.ts`       | DTMF digit handling               |
| `apps/runtime/src/services/telephony/outbound-call-tool.ts` | Outbound call platform tool       |
| `apps/runtime/src/routes/telephony.ts`                      | Telephony REST API routes         |
| `packages/database/src/models/sip-trunk.model.ts`           | SIPTrunk Mongoose model           |
| `packages/database/src/models/phone-number.model.ts`        | PhoneNumber Mongoose model        |
| `packages/database/src/models/call-record.model.ts`         | CallRecord Mongoose model         |
| `apps/studio/src/components/telephony/TelephonyPage.tsx`    | Studio telephony UI               |
| `apps/studio/src/api/telephony.ts`                          | Studio telephony API client       |
