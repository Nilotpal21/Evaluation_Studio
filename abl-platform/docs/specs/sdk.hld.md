# High-Level Design: Web SDK

**Feature Spec**: `../features/sdk.md`
**Test Spec**: `../testing/sdk.md`
**Status**: ALPHA
**Last Updated**: 2026-03-22

---

## 1. Executive Summary

The Web SDK (`packages/web-sdk`) is a client-side TypeScript library that enables web applications to embed AI agent conversations (text chat and voice) via a WebSocket connection to the ABL Runtime. This HLD defines the architecture across three integration surfaces (programmatic API, Web Components, React bindings), the WebSocket protocol, voice pipeline design, and the server-side SDK handler in the Runtime. The system currently exists as an ALPHA implementation with functional chat, voice (pipeline + realtime), and widget capabilities.

---

## 2. Architecture Overview

### System Context

```
┌──────────────────────────────────────────────────────────────────┐
│                        Consumer Web App                           │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐       │
│  │ Script Tag  │  │ React App    │  │ Custom JS App     │       │
│  │ <agent-     │  │ <AgentProv>  │  │ new AgentSDK()    │       │
│  │  widget>    │  │ useChat()    │  │ sdk.chat().send() │       │
│  └──────┬──────┘  └──────┬───────┘  └────────┬──────────┘       │
│         │                │                    │                   │
│         └────────────────┴────────────────────┘                   │
│                          │                                        │
│              ┌───────────┴──────────┐                             │
│              │     AgentSDK Core    │                             │
│              │  ┌─ SessionManager   │  WebSocket (WSS)            │
│              │  ├─ ChatClient       ├─────────────────────┐       │
│              │  └─ VoiceClient      │  HTTP (HTTPS)       │       │
│              │     ├─ AudioCapture  ├──────────────┐      │       │
│              │     ├─ VADAdapter    │              │      │       │
│              │     └─ RealtimePlayer│              │      │       │
│              └──────────────────────┘              │      │       │
└────────────────────────────────────────────────────┼──────┼───────┘
                                                     │      │
                                              ┌──────┴──────┴──────┐
                                              │    ABL Runtime      │
                                              │  ┌── sdk-handler ──┐│
                                              │  │  JWT Auth       ││
                                              │  │  Project Resolve││
                                              │  │  Agent Compile  ││
                                              │  │  Exec Coord     ││
                                              │  │  LLM Queue      ││
                                              │  │  Msg Persist    ││
                                              │  │  Voice Orch     ││
                                              │  │  Rate Limiter   ││
                                              │  └─────────────────┘│
                                              │                     │
                                              │  MongoDB  Redis     │
                                              └─────────────────────┘
```

### Component Hierarchy

```
packages/web-sdk/
├── core/
│   ├── AgentSDK.ts         — Main entry point, facade over clients
│   ├── SessionManager.ts   — WebSocket lifecycle, reconnection, heartbeat
│   ├── EventEmitter.ts     — Type-safe event system
│   └── types.ts            — All shared types (SDKConfig, Message, etc.)
├── chat/
│   ├── ChatClient.ts       — Text messaging with streaming + attachments
│   └── types.ts            — Chat-specific types
├── voice/
│   ├── VoiceClient.ts      — Voice orchestrator (pipeline + realtime modes)
│   ├── AudioCapture.ts     — Mic access, PCM16 encoding
│   ├── VADAdapter.ts       — VAD auto-detect + ManualVADAdapter fallback
│   └── RealtimeAudioPlayer.ts — Web Audio API PCM16 playback
├── ui/
│   ├── UnifiedWidget.ts    — Web Component with Shadow DOM
│   ├── ChatWidget.ts       — Chat-only Web Component
│   ├── VoiceWidget.ts      — Voice-only Web Component
│   └── styles.ts           — CSS-in-JS theming
├── react/
│   ├── AgentProvider.tsx    — React Context + state management
│   └── index.ts            — Hook exports
└── index.ts                — Global exports + window binding
```

---

## 3. Architectural Concerns

### 3.1 Tenant Isolation

- **Client-side**: No tenant awareness — all scoping is handled server-side via the API key and session token.
- **Server-side**: `buildTenantContextData(state)` extracts `tenantId` from the JWT session token. All operations run inside `runWithTenantContext()` for ALS-based tenant scoping. Cross-tenant access is impossible because the API key maps to a specific tenant+project.
- **Client state**: `sdkClients` Map is keyed by WebSocket instance. No cross-client state leakage.

### 3.2 Authentication & Authorization

- **API key authentication**: Public API keys (`pk_...`) are passed as query parameters on WebSocket upgrade. The server validates the key against the project's registered keys.
- **JWT session tokens**: After validation, the server issues a JWT with `SDK_TOKEN_ISSUER` and `SDK_TOKEN_AUDIENCE` claims. The token carries `tenantId`, `projectId`, `permissions` (chat/voice), `deploymentId`, and `channelId`.
- **Permission scoping**: `SDKClientState.permissions` controls which operations are allowed (`{ chat: boolean, voice: boolean }`).
- **No client-side secrets**: API keys are public (safe for browser embedding). Secret keys are never exposed.

### 3.3 Stateless / Distributed

- **Client-side**: The SDK is inherently stateless between sessions. On reconnect, a new session is created (no session restoration).
- **Server-side**: `sdkClients` is an in-memory `Map` per runtime pod. This is acceptable because WebSocket connections are sticky to the pod they connect to. Session state for cross-pod scenarios uses `runtimeSessionId` for cluster-ready lookup.
- **DB session lazy creation**: `ensureDbSession()` uses a `WeakMap` deduplication guard to prevent concurrent DB session creation from parallel messages.

### 3.4 Traceability

- **Client-side**: Debug mode logs to console with prefixed tags (`[AgentSDK:Session]`, `[AgentSDK:Chat]`, `[AgentSDK:Voice]`). No structured trace emission from client.
- **Server-side**: `createLogger('sdk-ws')` for structured logs. Trace events emitted via `getTraceStore()` for session lifecycle, message processing, and voice turns. Voice timing tracked via `voice-trace.ts` module.

### 3.5 Compliance

- **Transport encryption**: All WebSocket connections use WSS in production.
- **Data minimization**: Client-side message history is in-memory only (no localStorage/IndexedDB). Server-side lazy DB session creation prevents ghost records.
- **Right to erasure**: Server-side session cleanup on disconnect clears all state from `sdkClients` Map.
- **API key in URL**: The API key appears in the WebSocket URL query string. The server logs with redaction (`pk_***`). HTTPS prevents interception in transit.

### 3.6 Performance

- **Bundle size**: The core SDK (without voice) is lightweight. Voice dependencies (Twilio SDK, @ricky0123/vad-web) are optional peer dependencies loaded via dynamic import only when voice is activated.
- **Audio encoding**: `float32ToPCM16` and `pcm16ToBase64` are optimized inline loops (no library dependencies).
- **Reconnection**: Exponential backoff (1s, 2s, 4s, 8s, 16s, capped at 30s) prevents thundering herd on server recovery.
- **Heartbeat**: 30s ping interval keeps connections alive through proxies/load balancers without excessive overhead.

### 3.7 Error Handling

- **Client-side**: All errors emit typed events (`error` on SDK, ChatClient, VoiceClient). Callers can subscribe globally or per-client. Connection errors trigger reconnection. Voice errors transition to `error` state.
- **Server-side**: Errors are caught and sent as error frames over WebSocket. `BackpressureError` from LLM queue is handled gracefully with user-facing error message.
- **Reconnection on error**: `this.connect().catch(() => {})` in `attemptReconnect()` swallows reconnection errors (the backoff loop handles retry). This is a known code quality gap per CLAUDE.md rules (`.catch(() => {})`).

### 3.8 Scalability

- **Horizontal scaling**: Each runtime pod handles its own WebSocket connections. Load balancer assigns connections to pods. No cross-pod coordination needed for SDK sessions.
- **Connection limits**: `MAX_SDK_CLIENTS` constant bounds the number of concurrent connections per pod.
- **Rate limiting**: Per-session rate limiting via `checkSessionMessageRate()` prevents individual connections from overwhelming the system.

### 3.9 Backward Compatibility

- **SDK versioning**: UMD bundles served from CDN should use versioned URLs (`/sdk/v1/`, `/sdk/v2/`). Breaking changes require a new major version.
- **WebSocket protocol**: Message types are additive. New message types are ignored by old clients (unhandled `switch` cases fall through silently).
- **React peer dependency**: React 18+ as a peer dependency. React 19 compatibility should be verified before BETA.

### 3.10 Testability

- **Current state**: 14 unit tests (type shapes only), ~30 server-side tests (fully mocked). Zero E2E or integration tests.
- **Key gap**: The client-side SDK has no tests for its core behavior (connection, messaging, voice). All WebSocket interaction is untested at the integration level.
- **Recommendation**: Priority is E2E tests for WebSocket connection and chat round-trip (E2E-1, E2E-2 from test spec).

### 3.11 Observability

- **Client metrics**: No metrics collection on client side (by design — avoids privacy concerns).
- **Server metrics**: `recordWsRateLimitRejection()` for rate limit monitoring. Voice turn timing via `voice-trace.ts`.
- **Missing**: No client-side error reporting/telemetry. No connection success/failure metrics from client perspective.

### 3.12 Deployment

- **Package distribution**: npm package (`@anthropic/agent-sdk`) + CDN-hosted UMD bundle.
- **Server-side**: No separate deployment — the SDK handler is part of the Runtime app (`apps/runtime`). Deployed as part of normal runtime deployment.
- **CDN setup**: Not yet configured. UMD bundle needs to be published to a CDN (CloudFront, Fastly, or similar).

---

## 4. Data Flow

### Chat Message Flow

```
Client                          Server (sdk-handler)
  │                                │
  ├─ chat_message ────────────────>│
  │  {type, text, messageId,       │── ensureDbSession()
  │   sessionId, attachmentIds?}   │── compileToResolvedAgent()
  │                                │── enqueueLLMRequest() or
  │                                │   executionCoordinator.execute()
  │                                │
  │<──────── response_start ───────│
  │  {type: 'response_start'}     │
  │                                │
  │<──────── response_chunk ───────│  (repeated)
  │  {type, messageId, chunk}     │
  │                                │
  │<──────── response_end ─────────│
  │  {type, messageId, fullText,   │── persistMessage()
  │   richContent?, actions?}      │── persistTurnMetrics()
  │                                │
```

### Planned Follow-Up: Named `renderables[]`

The current websocket contract already carries `content`, `richContent`, `actions`, and `voiceConfig`. A planned follow-up is to add a parallel `renderables[]` field for customer-defined named payloads that the browser client can render by contract name.

```typescript
interface RenderablePayload {
  name: string; // e.g. "com.bank.account_summary.v1"
  payload: unknown;
  targets?: string[];
  fallbackText?: string;
  schemaRef?: string;
}
```

This keeps built-in `richContent` fixed and platform-owned, while allowing custom Web SDK consumers to register renderers keyed by `renderables[].name`.

### Voice Pipeline Flow

```
Client                          Server
  │                                │
  ├─ voice_start ─────────────────>│
  │<──────── voice_started ────────│  {voiceMode: 'pipeline'}
  │                                │
  │  [VAD detects speech]          │
  ├─ voice_audio ─────────────────>│  {audio: base64 PCM16}
  ├─ speech_end ──────────────────>│
  │                                │── STT (Deepgram/ElevenLabs)
  │<──────── transcription ────────│  {text, isFinal: true}
  │                                │── LLM processing
  │<──────── voice_response_start ─│
  │                                │── TTS
  │<──────── voice_audio_chunk ────│  (repeated, base64 MP3)
  │<──────── voice_speaking_end ───│
  │                                │
  │  [User speaks during playback] │
  ├─ barge_in ────────────────────>│
  │<──────── voice_barge_in_ack ───│
  │                                │
```

### Voice Realtime Flow

```
Client                          Server
  │                                │
  ├─ voice_start ─────────────────>│
  │<──────── voice_started ────────│  {voiceMode: 'realtime'}
  │                                │
  │  [RealtimeAudioPlayer init]    │── RealtimeVoiceExecutor init
  │                                │
  │<──── voice_realtime_audio ─────│  (PCM16 from LLM, repeated)
  │<── voice_realtime_transcript ──│  {text, role, isFinal}
  │                                │
```

---

## 5. Alternatives Analysis

### Alternative A: REST API + Polling (Rejected)

**Description**: Replace WebSocket with REST endpoints for sending messages and polling for responses.

**Pros**:

- Simpler infrastructure (no WebSocket server needed)
- Works through HTTP-only proxies and firewalls
- Easier to load-balance (stateless requests)

**Cons**:

- No streaming support (chunks arrive as full response only)
- High latency for voice (polling interval overhead)
- Cannot support real-time voice at all
- Higher server load from polling requests
- Poor UX (no typing indicators, no progressive rendering)

**Verdict**: Rejected. Real-time streaming and voice are core requirements that demand WebSocket transport.

### Alternative B: Server-Sent Events (SSE) + REST (Considered)

**Description**: Use SSE for server-to-client streaming and REST POST for client-to-server messages.

**Pros**:

- Streaming responses via SSE (native browser support)
- Simpler than WebSocket (unidirectional)
- Works through more proxies than WebSocket
- No connection state management for sending

**Cons**:

- Bidirectional voice audio requires WebSocket anyway
- Two transport channels (SSE + REST) increases complexity
- SSE has 6-connection limit per domain in HTTP/1.1
- Cannot stream client audio via SSE (server-to-client only)

**Verdict**: Partially viable for chat-only, but voice requirement necessitates WebSocket. Maintaining two transport mechanisms adds complexity without benefit. A hybrid approach (SSE for chat, WebSocket for voice) was considered but rejected for unified simplicity.

### Alternative C: WebSocket (Current Implementation)

**Description**: Single WebSocket connection for all communication (chat, voice, control messages).

**Pros**:

- Full bidirectional streaming (chat + voice)
- Single connection for all message types
- Low latency for voice audio transport
- Native reconnection support
- Well-established pattern for real-time applications

**Cons**:

- Requires WebSocket-aware infrastructure (load balancers, proxies)
- Sticky session requirement for connection routing
- Connection state management complexity
- Harder to debug than REST (no browser DevTools request/response view)

**Verdict**: Selected. WebSocket is the only viable option that supports both chat streaming and bidirectional voice audio.

---

## 6. Security Analysis

### Threat Model

| Threat                         | Mitigation                                                          | Status      |
| ------------------------------ | ------------------------------------------------------------------- | ----------- |
| API key theft from client code | Public keys have limited scope (project + session only)             | Implemented |
| JWT token replay               | Short-lived tokens with audience/issuer validation                  | Implemented |
| Message injection              | Server validates message structure and session ownership            | Implemented |
| WebSocket hijacking            | WSS encryption + origin validation                                  | Partial     |
| Rate-based DoS                 | Per-session rate limiting via checkSessionMessageRate()             | Implemented |
| Cross-tenant data access       | Tenant isolation via JWT + ALS context propagation                  | Implemented |
| XSS via widget embedding       | Shadow DOM isolates widget; no dynamic HTML injection from messages | Implemented |
| Audio interception             | WSS for transport encryption; no at-rest audio storage on client    | Implemented |

### Missing Security Controls

1. **Origin validation**: WebSocket upgrade should validate the `Origin` header against an allowlist. Currently not implemented.
2. **CSRF protection**: WebSocket connections are not protected by CSRF tokens. The API key provides some protection but is not a CSRF mitigation.
3. **Message size limits**: No explicit maximum message size on the WebSocket handler. Large messages could cause memory pressure.

---

## 7. Deployment Topology

```
                    Internet
                       │
                  ┌────┴────┐
                  │   CDN   │ ─── agent-sdk.umd.js (static)
                  └─────────┘
                       │
                  ┌────┴────┐
                  │   LB    │ ─── WebSocket upgrade + sticky sessions
                  └────┬────┘
            ┌──────────┼──────────┐
       ┌────┴────┐ ┌───┴────┐ ┌──┴─────┐
       │ Runtime │ │ Runtime│ │ Runtime│  (N pods)
       │  Pod 1  │ │  Pod 2 │ │  Pod 3 │
       └────┬────┘ └───┬────┘ └──┬─────┘
            └──────────┼──────────┘
                  ┌────┴────┐
                  │ MongoDB │  (sessions, messages)
                  │  Redis  │  (rate limits, caching)
                  └─────────┘
```

Key deployment requirements:

- Load balancer must support WebSocket upgrade and sticky sessions
- CDN for static UMD bundle distribution
- Runtime pods are stateless (connection state is per-WebSocket, not shared)

---

## 8. Migration & Rollout

### Current State (ALPHA)

The SDK is functional with:

- Chat: text messaging, streaming responses, rich content, attachments
- Voice: pipeline mode (VAD + PCM16), realtime mode, barge-in, Twilio
- UI: UnifiedWidget (Web Component), React Provider + hooks
- Server: sdk-handler with JWT auth, agent compilation, LLM queue, rate limiting

### Path to BETA

1. Add E2E test suite (E2E-1 through E2E-5 from test spec)
2. Add integration tests (IT-1, IT-5, IT-9 minimum)
3. Implement origin validation on WebSocket upgrade
4. Add message size limits on server handler
5. Configure CDN distribution for UMD bundle
6. Verify React 19 compatibility

### Path to STABLE

1. Full E2E + integration test suite green (all 10 + 12 scenarios)
2. CDN distribution with versioned URLs
3. npm publish with semantic versioning
4. AudioWorklet migration (ScriptProcessorNode deprecation)
5. Performance benchmarks (bundle size < 50KB, connection < 10s, voice < 3s)

---

## 9. Open Design Questions

1. **Session restoration on reconnect**: Current behavior creates a new session. Should the server support resuming a previous session with message history replay?
2. **Multi-tab coordination**: Multiple browser tabs with the same SDK instance share nothing. Should there be a shared session mechanism (via BroadcastChannel or SharedWorker)?
3. **Offline message queue**: Should the SDK buffer messages when disconnected and send them on reconnect?
4. **Client-side telemetry**: Should the SDK collect anonymous usage metrics (connection time, error rates) for platform monitoring?
5. **WebSocket compression**: Should per-message deflate be enabled for WebSocket frames to reduce bandwidth?

---

## 10. Decision Log

| Decision                        | Date     | Rationale                                                  |
| ------------------------------- | -------- | ---------------------------------------------------------- |
| WebSocket over REST/SSE         | Pre-SDLC | Voice audio requires bidirectional streaming               |
| Shadow DOM for widgets          | Pre-SDLC | Prevents style conflicts with host pages                   |
| Optional voice deps             | Pre-SDLC | Keeps bundle small for chat-only integrations              |
| Lazy DB session                 | Pre-SDLC | Prevents ghost sessions from React Strict Mode             |
| Pipeline + realtime voice modes | Pre-SDLC | Supports both traditional STT/TTS and native realtime LLMs |
| Public API key auth             | Pre-SDLC | Safe for client-side embedding without secret exposure     |
