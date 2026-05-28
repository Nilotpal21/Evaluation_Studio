# Feature: Grok Realtime S2S Voice Provider

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: PLANNED
**Feature Area(s)**: `customer experience`, `integrations`
**Package(s)**: `@abl/compiler`, `@agent-platform/runtime`, `@agent-platform/studio`, `@agent-platform/database`
**Owner(s)**: Platform Engineering
**Testing Guide**: [`../../testing/sub-features/grok-realtime-s2s-voice.md`](../../testing/sub-features/grok-realtime-s2s-voice.md)
**Last Updated**: 2026-03-31

---

## 1. Introduction / Overview

### Problem Statement

Customers deploying voice-enabled ABL agents require provider diversity for cost optimization, resilience, and access to model-specific capabilities. The platform currently supports three realtime voice providers (OpenAI Realtime, Gemini Live, Ultravox) for web/SDK channels and three S2S providers (s2s:openai, s2s:google, s2s:elevenlabs) for KoreVG telephony channels. xAI's Grok models offer competitive realtime voice capabilities but are not yet integrated, limiting customer choice and creating vendor lock-in risk.

Without Grok support, customers cannot:

- Leverage xAI's Grok models for voice interactions
- Diversify across multiple realtime voice providers
- Take advantage of potential cost savings or performance characteristics unique to Grok
- Meet procurement requirements for multi-vendor redundancy

### Goal Statement

Enable Grok (xAI) as a realtime voice provider across all ABL voice channels (web SDK, WebSocket sessions, KoreVG telephony) with parity to existing OpenAI/Gemini/Ultravox support. Tenant admins can configure Grok credentials in Studio, developers can select Grok for voice-optimized agents, and end users experience seamless Grok-powered voice interactions with full observability and tenant isolation.

### Summary

This feature adds Grok (xAI) as the fourth realtime voice provider in the ABL platform. It includes:

1. **Grok Realtime Adapter** (`GrokRealtimeSession`) implementing the `RealtimeVoiceSession` interface for web/SDK channels
2. **S2S Provider Support** (`s2s:grok`) for KoreVG telephony integration via KoreVG's llm verb
3. **Credential Management** UI in Studio for tenant admins to add/edit Grok API keys with encryption at rest
4. **Voice Mode Resolution** enhancements to detect and route to Grok when configured
5. **Observability** integration with existing voice trace events, metrics, and Homer/HEP quality monitoring

The implementation follows established patterns from OpenAI/Gemini/Ultravox adapters, ensuring consistency and maintainability.

---

## 2. Scope

### Goals

- Add `grok_realtime` provider for web SDK and WebSocket voice sessions
- Add `s2s:grok` provider for KoreVG telephony voice sessions
- Implement `GrokRealtimeSession` class following `RealtimeVoiceSession` interface
- Extend Studio UI to support Grok credential configuration (Voice Services page)
- Update `VoiceServiceFactory` to resolve Grok credentials per tenant
- Register Grok in realtime provider registry and S2S provider types
- Emit trace events and metrics for Grok sessions consistent with other providers
- Support tool calling from Grok realtime sessions through ABL tool executor
- Maintain tenant isolation and encrypted credential storage for Grok API keys
- Document Grok configuration in voice capabilities docs

### Non-Goals (Out of Scope)

- **Grok text-only LLM support** — already exists via model registry, not part of this feature
- **Grok STT/TTS for pipeline mode** — Grok does not offer standalone STT/TTS APIs
- **Migration tooling from other providers** — tenant admins manually configure Grok credentials
- **Grok-specific voice analytics UI** — use existing Homer/HEP and voice trace infrastructure
- **Grok voice quality tuning UI** — beyond standard temperature/max_tokens controls
- **Automatic failover from Grok to other providers** — tenants explicitly select provider per agent/deployment
- **Grok API cost tracking dashboard** — use existing LLM usage metrics

---

## 3. User Stories

### US-1: Configure Grok Credentials

**As a** tenant admin,
**I want to** add my xAI Grok API key in Studio's Voice Services settings,
**So that** my organization can use Grok for voice interactions.

**Acceptance Criteria:**

- Navigate to Studio > Admin > Voice Services
- Click "Add Service" and select "Grok (xAI) - Realtime Voice"
- Enter API key and optional organization ID
- Credentials are encrypted at rest in `TenantServiceInstance` collection
- Test connection validates Grok API key format and accessibility
- Service status shows "Active" after successful validation

### US-2: Select Grok for Voice-Optimized Agent

**As a** developer building an ABL agent,
**I want to** configure my voice-optimized agent to use Grok realtime,
**So that** end users experience low-latency voice powered by Grok models.

**Acceptance Criteria:**

- Set deployment voice config to `mode: 'realtime'` in Studio
- Voice mode resolver detects Grok model in tenant default LLM config
- `VoiceServiceFactory.resolveS2SCredentials()` returns Grok credentials for S2S sessions
- `createRealtimeSession('grok_realtime')` creates `GrokRealtimeSession` instance
- System prompt and tool definitions are forwarded to Grok session
- Tool calls from Grok are routed through ABL tool executor

### US-3: KoreVG Telephony Call with Grok S2S

**As a** phone caller,
**I want to** speak with an AI agent powered by Grok,
**So that** I experience natural voice conversation.

**Acceptance Criteria:**

- Inbound call to KoreVG-connected channel resolves to agent with Grok S2S configured
- `KorevgRouter` detects `s2s:grok` provider from channel connection config
- Grok credentials resolved via `VoiceServiceFactory.resolveS2SCredentials('tenant-1', 's2s:grok')`
- KoreVG sends `llm` verb payload with Grok API endpoint and credentials
- Audio streams bidirectionally between caller and Grok realtime session
- Call transcript captured in `ConversationStore` as with other providers
- Homer/HEP quality metrics recorded (MOS, jitter, packet loss)

### US-4: Web SDK Voice with Grok

**As a** web user interacting with an agent via `<agent-voice>` widget,
**I want to** have voice conversations powered by Grok,
**So that** I experience fast, natural voice responses.

**Acceptance Criteria:**

- SDK WebSocket handler resolves voice session via `resolveVoiceSession()`
- Voice mode resolver returns `mode: 'realtime', providerType: 'grok_realtime'`
- `RealtimeVoiceExecutor` creates `GrokRealtimeSession` and connects to xAI endpoint
- User audio is streamed to Grok via `sendAudio()`
- Grok audio responses are streamed back to client via `onAudio` event
- Transcripts displayed in real-time via `onTranscript` events
- Voice turn metrics (latency, token usage) tracked in trace events

### US-5: Debug Grok Voice Session

**As a** platform operator,
**I want to** view Grok voice session logs, traces, and metrics,
**So that** I can troubleshoot issues and monitor quality.

**Acceptance Criteria:**

- Grok sessions emit `realtime_session_start`, `realtime_turn_complete`, `realtime_session_end` trace events
- Trace store captures Grok-specific usage metrics (input/output tokens, audio duration)
- ClickHouse analytics queries include `providerType = 'grok_realtime'` dimension
- Homer quality metrics available for Grok-powered KoreVG calls
- Grok connection errors logged with structured context (sessionId, tenantId, error)

---

## 4. Functional Requirements

1. **FR-1**: The system MUST implement a `GrokRealtimeSession` class that conforms to the `RealtimeVoiceSession` interface defined in `packages/compiler/src/platform/llm/realtime/types.ts`.

2. **FR-2**: The system MUST register `grok_realtime` provider via `registerRealtimeProvider('grok_realtime', () => new GrokRealtimeSession())` in `packages/compiler/src/platform/llm/realtime/index.ts`.

3. **FR-3**: The system MUST add `'s2s:grok'` to the `S2SProviderType` union in `apps/runtime/src/services/voice/s2s/types.ts`.

4. **FR-4**: The system MUST add `'s2s:grok'` to allowed service types in `apps/runtime/src/routes/tenant-service-instances.ts` for credential CRUD operations.

5. **FR-5**: The system MUST extend `VoiceServiceFactory.resolveS2SCredentials()` to handle `'s2s:grok'` provider type and decrypt Grok credentials from `TenantServiceInstance` records.

6. **FR-6**: The system MUST update Studio Voice Services UI (`apps/studio/src/components/admin/VoiceServicesPage.tsx`) to include "Grok (xAI) - Realtime Voice" in the provider dropdown.

7. **FR-7**: The system MUST encrypt Grok API keys at rest in MongoDB `TenantServiceInstance.encryptedCredentials` field using `EncryptionService`.

8. **FR-8**: The system MUST validate Grok API key format (non-empty string, starts with expected prefix if documented) before saving credentials.

9. **FR-9**: The system MUST support tool calling from Grok realtime sessions by implementing `onToolCall` event handler and routing through ABL `ToolExecutor`.

10. **FR-10**: The system MUST emit trace events for Grok sessions: `realtime_session_start`, `realtime_turn_complete`, `realtime_session_end` with usage metrics (input tokens, output tokens, audio duration).

11. **FR-11**: The system MUST handle Grok WebSocket disconnects with exponential backoff reconnection (max 3 retries, base delay 1000ms) consistent with OpenAI/Gemini adapters.

12. **FR-12**: The system MUST scope all Grok credentials and sessions to `tenantId` ensuring no cross-tenant credential leakage.

13. **FR-13**: The system MUST support audio formats compatible with Grok API (pcm16, g711_ulaw, g711_alaw) with sample rates (16kHz, 24kHz) as documented.

14. **FR-14**: The system MUST update system prompt and tools dynamically via `updateSystemPrompt()` and `updateTools()` methods during active Grok sessions.

15. **FR-15**: The system MUST include `providerType: 'grok_realtime'` dimension in voice analytics queries and dashboards.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                  |
| -------------------------- | ------------ | ------------------------------------------------------ |
| Project lifecycle          | NONE         | No project-level lifecycle changes                     |
| Agent lifecycle            | SECONDARY    | Adds voice provider option for voice-optimized agents  |
| Customer experience        | PRIMARY      | Enables Grok-powered voice interactions for end users  |
| Integrations / channels    | PRIMARY      | Extends voice channel support to Grok provider         |
| Observability / tracing    | SECONDARY    | Adds Grok-specific trace events and metrics            |
| Governance / controls      | NONE         | No governance-level policy changes                     |
| Enterprise / compliance    | SECONDARY    | Encrypted credential storage follows existing patterns |
| Admin / operator workflows | SECONDARY    | Admins configure Grok credentials in Voice Services UI |

### Related Feature Integration Matrix

| Related Feature                                             | Relationship Type | Why It Matters                                                | Key Touchpoints                                | Current State |
| ----------------------------------------------------------- | ----------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------- |
| [Voice Capabilities](../voice-capabilities.md)              | extends           | Grok is a new realtime provider within voice architecture     | VoiceServiceFactory, voice mode resolver       | ALPHA         |
| [Tenant Service Instances](../enterprise.md#tsi)            | configured by     | Grok credentials stored as TenantServiceInstance records      | credential CRUD, encryption                    | STABLE        |
| [Realtime Voice Session](../voice-capabilities.md#realtime) | implements        | GrokRealtimeSession implements RealtimeVoiceSession interface | RealtimeVoiceExecutor, tool calling            | ALPHA         |
| [KoreVG Voice Gateway](../voice-capabilities.md#korevg)     | shares data with  | Grok S2S used in KoreVG telephony sessions                    | KorevgRouter, s2sProvider config               | ALPHA         |
| [Voice Tracing](../voice-analytics.md)                      | emits into        | Grok sessions emit trace events to TraceStore/ClickHouse      | realtime_session_start, realtime_turn_complete | ALPHA         |

---

## 6. Design Considerations

N/A — No UI mockups required. Grok is added to existing Voice Services page dropdown following established patterns (OpenAI, Gemini, Ultravox).

---

## 7. Technical Considerations

### Architecture Decisions

1. **OpenAI-Compatible Protocol**: Assume Grok Realtime API follows OpenAI Realtime API protocol (WebSocket events, server-side VAD, tool calling). If Grok uses a custom protocol, `GrokRealtimeSession` must implement protocol translation.

2. **Provider Registry Pattern**: Use `registerRealtimeProvider()` for web/SDK sessions and add `s2s:grok` to `S2SProviderType` for KoreVG sessions, consistent with OpenAI/Gemini dual registration.

3. **Credential Format**: Store Grok API key as `{ apiKey: string, organizationId?: string }` in `TenantServiceInstance.encryptedCredentials`, encrypted via `EncryptionService`.

4. **Voice Mode Resolution**: `VoiceServiceFactory.resolveVoiceMode()` already checks tenant default LLM model. If model is Grok and deployment config is `mode: 'realtime'`, resolver returns `'realtime'`.

5. **Tool Calling**: Grok function_call events forwarded to `RealtimeVoiceExecutor.handleToolCall()` which invokes ABL `ToolExecutor.execute()`, same as OpenAI/Gemini.

6. **Observability**: Reuse existing `VoiceMetrics` and `TraceStore` infrastructure. Grok sessions emit events with `providerType: 'grok_realtime'`.

### Implementation Sequencing

1. **Phase 1** (Core adapter): Implement `GrokRealtimeSession`, register provider, add unit tests
2. **Phase 2** (Credentials): Extend `TenantServiceInstance` routes, update Studio UI, add encryption tests
3. **Phase 3** (KoreVG integration): Add `s2s:grok` to types, extend `KorevgRouter`, update `VoiceServiceFactory`
4. **Phase 4** (Testing & Observability): Add E2E tests, trace event validation, Homer integration tests

### Migration Notes

- **No migration required** — Grok is an additive feature. Existing agents continue using configured providers.
- **Tenant opt-in** — Admins must explicitly add Grok credentials before Grok can be selected.
- **Graceful degradation** — If Grok credentials not configured or API unavailable, voice mode resolver falls back to pipeline mode (existing behavior).

---

## 8. How to Consume

### 8.1 Studio UI (Tenant Admin)

**Voice Services Configuration:**

1. Navigate to **Admin > Voice Services**
2. Click **"Add Service"**
3. Select **"Grok (xAI) - Realtime Voice"** from provider dropdown
4. Enter:
   - **API Key** (required): xAI Grok API key from https://console.x.ai
   - **Organization ID** (optional): xAI organization ID if multi-org account
5. Click **"Test Connection"** to validate API key
6. Click **"Save"** — credentials encrypted and stored in `TenantServiceInstance`

**Voice-Optimized Agent Configuration:**

1. Create or edit deployment
2. Under **Voice Settings**, set:
   - **Voice Mode**: `realtime`
   - **Default Model**: Select Grok model (e.g., `grok-3-realtime`)
3. Deploy — agent will use Grok for voice sessions

### 8.2 API - Runtime

**Voice Session Resolution:**

```typescript
// Voice mode resolver automatically selects Grok if:
// 1. Deployment config has voicePipeline: 'realtime'
// 2. Tenant default model is Grok
// 3. Tenant has Grok credentials configured

const resolved = await resolveVoiceSession({
  tenantId: 'tenant-123',
  projectId: 'proj-456',
  agentIR: compiledAgent,
  sessionId: 'session-789',
});

// resolved.mode === 'realtime'
// resolved.providerType === 'grok_realtime'
// resolved.executor instanceof RealtimeVoiceExecutor
```

**Grok Credential Resolution:**

```typescript
// For S2S (KoreVG) sessions
const credentials = await voiceFactory.resolveS2SCredentials('tenant-123', 's2s:grok');
// { apiKey: 'xai-...', organizationId: 'org-...' }
```

### 8.3 API - Studio

**List Voice Services:**

```
GET /api/tenants/{tenantId}/services?type=voice
```

**Add Grok Credentials:**

```
POST /api/tenants/{tenantId}/services

{
  "serviceType": "s2s:grok",
  "credentials": {
    "apiKey": "xai-...",
    "organizationId": "org-..."
  }
}
```

**Test Grok Connection:**

```
POST /api/tenants/{tenantId}/services/{serviceId}/test

# Returns 200 OK or 400 with error details
```

### 8.4 Admin

N/A — Voice service management is in Studio, not standalone Admin app.

### 8.5 Channels (SDK, KoreVG)

**SDK WebSocket Voice:**

- Client connects via `wss://runtime/sdk/voice`
- Voice mode resolver selects Grok if tenant configured
- `RealtimeVoiceExecutor` creates `GrokRealtimeSession`
- Audio streams bidirectionally via WebSocket messages
- No client-side code changes required

**KoreVG Telephony:**

- ChannelConnection config includes `s2sProvider: 's2s:grok'`
- `KorevgRouter` resolves Grok credentials via `VoiceServiceFactory`
- Sends `llm` verb to KoreVG with Grok endpoint and credentials
- KoreVG handles audio streaming to/from Grok
- No KoreVG configuration changes required (uses existing llm verb)

---

## 9. Data Model

### 9.1 MongoDB Collections

**TenantServiceInstance (existing collection, new records):**

```typescript
{
  _id: ObjectId("..."),
  tenantId: "tenant-123",
  serviceType: "s2s:grok",  // NEW VALUE
  encryptedCredentials: "encrypted-blob...",  // { apiKey, organizationId }
  status: "active",
  createdAt: ISODate("2026-03-31T..."),
  updatedAt: ISODate("2026-03-31T..."),
  metadata: {
    addedBy: "user-456",
    lastTested: ISODate("2026-03-31T..."),
  }
}
```

**VoiceSession (existing collection, no schema changes):**

- `providerType` field already supports arbitrary strings
- Grok sessions stored with `providerType: 'grok_realtime'`

### 9.2 ClickHouse Tables

**voice_trace_events (existing table, new dimension value):**

- `provider_type` column includes `'grok_realtime'` dimension
- No schema migration required

**voice_usage_metrics (existing table):**

- `provider` column includes `'grok_realtime'` for filtering
- No schema migration required

### 9.3 Redis Cache

**VoiceCredentialCache keys:**

```
auth-profile:voice:{tenantId}:grok  # Decrypted Grok credentials, TTL 4 hours
```

---

## 10. Configuration

### 10.1 Environment Variables

| Variable                       | Type    | Default                      | Description                                             |
| ------------------------------ | ------- | ---------------------------- | ------------------------------------------------------- |
| `FEATURE_GROK_VOICE_ENABLED`   | boolean | `true`                       | Feature flag to enable/disable Grok voice support       |
| `GROK_API_ENDPOINT`            | string  | `wss://api.x.ai/v1/realtime` | Grok realtime WebSocket endpoint (override for testing) |
| `GROK_CONNECTION_TIMEOUT_MS`   | number  | `30000`                      | Grok WebSocket connection timeout                       |
| `GROK_MAX_RECONNECT_RETRIES`   | number  | `3`                          | Max reconnection attempts on disconnect                 |
| `GROK_RECONNECT_BASE_DELAY_MS` | number  | `1000`                       | Base delay for exponential backoff reconnects           |

### 10.2 Runtime Config

**Voice Mode Resolution Priority:**

```
1. Deployment config (voicePipeline: 'realtime')
2. Agent IR hints (voice_optimized: true)
3. Tenant default model (if Grok model)
4. Global default ('pipeline')
```

**Grok Model Detection:**

- Models starting with `grok-` are recognized as Grok provider
- Model registry includes Grok models with `supportsRealtimeVoice: true`

### 10.3 DSL / IR

**No DSL changes required.**

Existing voice config in ABL DSL applies to Grok:

```abl
AGENT: Support
EXECUTION:
  voice_optimized: true
  voice_latency_target_ms: 500
```

**VoiceConfigIR (no schema changes):**

```typescript
{
  provider: "grok",  // provider name
  voice_id: "default",  // Grok voice selection (if supported)
  speed: 1.0,
  instructions: "Speak clearly and concisely"
}
```

---

## 11. Non-Functional Concerns

### 11.1 Resource Isolation

**Tenant Isolation:**

- Every Grok credential is scoped to `tenantId`
- `VoiceServiceFactory.resolveS2SCredentials(tenantId, 's2s:grok')` validates tenant ownership
- Cross-tenant credential access returns 404 (not 403)
- Grok sessions include `tenantId` in all logs and traces

**Project Isolation:**

- Voice sessions scoped to `projectId` via ChannelConnection or SDK API key validation
- Grok credentials inherited at tenant level, applied per project

**User Isolation:**

- Voice sessions are per-connection (WebSocket), no shared mutable state
- Each connection has isolated `GrokRealtimeSession` instance

### 11.2 Security

**Credential Protection:**

- Grok API keys encrypted at rest via `EncryptionService.encrypt()`
- Keys never exposed to client (WebSocket or HTTP responses)
- Redis cache keys scoped to tenant: `auth-profile:voice:{tenantId}:grok`

**WebSocket Security:**

- Grok realtime endpoint uses TLS (wss://)
- API key sent in Authorization header, not query params
- Connection validated before audio streaming begins

**Audit Logging:**

- Grok credential creation/update/deletion logged to audit trail
- Failed Grok API calls logged with error context (no API key in log)

### 11.3 Performance

**Latency Targets:**

- Grok realtime mode target: < 500ms end-to-end (user speech → agent response)
- WebSocket connection establishment: < 2s
- Tool call round-trip: < 1s

**Concurrency:**

- Grok sessions stateless at pod level (connection-scoped)
- Horizontal scaling: distribute WebSocket connections across runtime pods
- Credential cache reduces MongoDB queries (10-minute TTL)

**Resource Usage per Session:**

- Memory: ~1MB (connection state + audio buffers)
- Network: ~64-128 kbps (audio streaming)
- CPU: Low (audio relay, minimal processing)

### 11.4 Reliability

**Error Recovery:**

| Failure                   | Recovery Strategy                                  |
| ------------------------- | -------------------------------------------------- |
| Grok WebSocket disconnect | Exponential backoff reconnect (max 3 retries)      |
| Grok API key invalid      | Return SERVICE_UNAVAILABLE, log error              |
| Grok endpoint unreachable | Fall back to pipeline mode if voicePipeline='auto' |
| Tool execution timeout    | Cancel Grok response, return error to user         |

**Graceful Degradation:**

- If Grok credentials not configured, voice mode resolver selects pipeline mode
- If Grok API rate-limited, return error with retry-after guidance
- If Grok tool call fails, log error and continue session

**Circuit Breaker (future):**

- Track Grok API error rate per tenant
- Open circuit after N consecutive failures
- Auto-recover after cooldown period

### 11.5 Observability

**Metrics:**

- `voice_session_count{provider="grok_realtime"}` — active Grok sessions
- `voice_turn_duration_ms{provider="grok_realtime"}` — turn latency histogram
- `realtime_token_usage{provider="grok_realtime", direction="in|out"}` — token counters
- `voice_error_count{provider="grok_realtime", error_type}` — error counter by type

**Trace Events:**

- `realtime_session_start` — Grok session initiated, includes tenantId, projectId, sessionId
- `realtime_turn_complete` — Grok turn finished, includes usage metrics (tokens, audio duration)
- `realtime_session_end` — Grok session closed, includes final usage summary
- `realtime_tool_call` — Tool invoked by Grok, includes tool name and latency

**Logging:**

- Grok connection state changes logged at INFO level
- Grok API errors logged at ERROR level with structured context
- No API keys or PII in logs

### 11.6 Data Lifecycle

**Credential Retention:**

- Grok credentials persist until tenant admin deletes them
- Encrypted at rest, decrypted on-demand with cache TTL (4 hours Redis, 10 minutes in-memory)

**Transcript Retention:**

- Grok voice session transcripts follow existing `transcriptRetention` policy:
  - `always`: Persist all transcripts indefinitely
  - `on_success`: Persist only successful sessions
  - `never`: No transcript persistence (trace events only)

**Voice Recording:**

- Grok audio streams not persisted by default (text transcripts only)
- Future enhancement: optional recording storage with compliance controls

---

## 12. Key Implementation Files

### New Files

| File                                                                          | Purpose                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`                | GrokRealtimeSession adapter implementation  |
| `packages/compiler/src/platform/llm/realtime/__tests__/grok-realtime.test.ts` | Unit tests for GrokRealtimeSession          |
| `apps/runtime/src/__tests__/channels/grok-voice-integration.test.ts`          | Integration tests for Grok voice resolution |
| `apps/runtime/src/__tests__/korevg/grok-s2s-integration.test.ts`              | KoreVG S2S Grok integration tests           |
| `docs/features/sub-features/grok-realtime-s2s-voice.md`                       | This feature spec                           |
| `docs/testing/sub-features/grok-realtime-s2s-voice.md`                        | Testing guide                               |

### Modified Files

| File                                                          | Changes                                     |
| ------------------------------------------------------------- | ------------------------------------------- |
| `packages/compiler/src/platform/llm/realtime/index.ts`        | Register grok_realtime provider             |
| `packages/compiler/src/platform/llm/realtime/types.ts`        | Add 'grok_realtime' to RealtimeProviderType |
| `apps/runtime/src/services/voice/s2s/types.ts`                | Add 's2s:grok' to S2SProviderType           |
| `apps/runtime/src/routes/tenant-service-instances.ts`         | Add 's2s:grok' to allowed service types     |
| `apps/runtime/src/services/voice/voice-service-factory.ts`    | Extend resolveS2SCredentials() for Grok     |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`      | Add Grok to provider dropdown               |
| `apps/studio/src/components/deployments/VoiceConfigPanel.tsx` | Display Grok in voice mode UI               |
| `docs/features/voice-capabilities.md`                         | Add Grok to supported providers list        |
| `docs/specs/voice-capabilities.hld.md`                        | Update architecture diagram with Grok       |

---

## 13. Success Metrics

| Metric                        | Target                                    | Measurement                                      |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------ |
| Grok credential configuration | 5+ tenants within 30 days of GA           | Count TenantServiceInstance records (s2s:grok)   |
| Grok voice session volume     | 100+ sessions/day across platform         | voice_session_count{provider="grok_realtime"}    |
| Grok voice latency (p95)      | < 600ms turn latency                      | voice_turn_duration_ms{provider="grok_realtime"} |
| Grok API error rate           | < 2% of total Grok sessions               | voice_error_count{provider="grok_realtime"}      |
| Provider diversity            | 3+ realtime providers active per customer | Distinct providerType in voice_trace_events      |

---

## 14. Open Questions

1. **Grok API Protocol Compatibility**: Does Grok Realtime API follow OpenAI Realtime API protocol (WebSocket events, server-side VAD, function_call events)? If not, what are the protocol differences?

2. **Grok Audio Format Support**: Which audio formats does Grok support (pcm16, g711_ulaw, g711_alaw)? What sample rates (16kHz, 24kHz, 48kHz)?

3. **Grok Voice Selection**: Does Grok offer multiple voice options like ElevenLabs, or single default voice? How is voice configured (session parameter, model name suffix)?

4. **Grok Credential Format**: Is API key sufficient, or does Grok require organization ID like OpenAI? Any special headers (X-Organization-ID)?

5. **Grok Rate Limits**: What are Grok's rate limits for realtime voice sessions? Concurrent connections per API key? Token limits?

6. **Grok Pricing**: What is Grok's pricing model for realtime voice (per-minute audio, per-token, tiered)? How should we track and surface costs to tenants?

7. **Grok Tool Calling Format**: Does Grok use OpenAI-style function_call events, or custom format? Do we need protocol translation layer?

8. **Grok KoreVG Integration**: Does KoreVG natively support Grok via llm verb, or do we need to upstream a KoreVG patch?

9. **Grok Availability**: Is Grok Realtime API generally available, or private beta? Do customers need xAI approval for API access?

10. **Grok Model Variants**: Which Grok models support realtime voice (grok-3-realtime, grok-3.5-realtime)? Are there regional endpoints?

---

## 15. Gaps, Known Issues & Limitations

### Gaps (Not Yet Implemented)

1. **Grok Voice Quality Analytics**: No Grok-specific MOS (Mean Opinion Score) tracking beyond standard Homer/HEP metrics.
2. **Grok Cost Dashboard**: No dedicated UI for Grok API usage costs (use existing LLM usage metrics).
3. **Grok Fallback Chains**: No automatic failover from Grok to OpenAI/Gemini on Grok API failure (manual tenant config).
4. **Grok Voice Tuning UI**: No Grok-specific controls for voice characteristics beyond standard temperature/max_tokens.

### Known Issues

1. **Unverified API Protocol**: Grok Realtime API protocol assumed OpenAI-compatible but not yet verified. May require adapter layer if protocol differs.
2. **Placeholder Endpoint**: `wss://api.x.ai/v1/realtime` is assumed endpoint; actual Grok endpoint may differ.
3. **Missing API Docs**: xAI has not published comprehensive realtime voice API documentation as of 2026-03-31.

### Limitations

1. **No Grok Pipeline Mode**: Grok does not offer standalone STT/TTS APIs, only realtime S2S. Cannot use Grok for pipeline voice mode.
2. **Tenant-Level Credentials**: Grok credentials configured at tenant level, not project level. All projects in a tenant share same Grok API key.
3. **No Grok Audio Recording**: Grok audio streams not persisted by default (transcripts only). Optional recording storage requires future feature.

---

## 16. Delivery Plan / Work Breakdown

### Parent Task 1: Grok Realtime Adapter Implementation

**Owner**: Platform Engineering
**Estimated Effort**: 3-5 days
**Subtasks**:

1.1. Implement `GrokRealtimeSession` class in `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`
1.2. Implement `RealtimeVoiceSession` interface methods: `connect()`, `disconnect()`, `sendAudio()`, `submitToolResult()`
1.3. Handle Grok WebSocket events: connection, audio, transcript, tool_call, error, disconnect
1.4. Implement reconnection logic with exponential backoff (max 3 retries, base delay 1000ms)
1.5. Add usage metrics tracking (input tokens, output tokens, audio duration)
1.6. Register `grok_realtime` provider in `packages/compiler/src/platform/llm/realtime/index.ts`
1.7. Add 'grok_realtime' to `RealtimeProviderType` in `types.ts`
1.8. Write unit tests for `GrokRealtimeSession` (20+ test cases covering lifecycle, events, errors)

### Parent Task 2: S2S Provider Support (KoreVG)

**Owner**: Platform Engineering
**Estimated Effort**: 2-3 days
**Subtasks**:

2.1. Add `'s2s:grok'` to `S2SProviderType` union in `apps/runtime/src/services/voice/s2s/types.ts`
2.2. Update `apps/runtime/src/routes/tenant-service-instances.ts` to allow `'s2s:grok'` in service type validation
2.3. Extend `VoiceServiceFactory.resolveS2SCredentials()` to handle `'s2s:grok'` provider
2.4. Update `KorevgRouter` to detect and route `s2s:grok` provider config
2.5. Build Grok llm verb payload in `buildRealtimeLlmVerbPayload()` helper
2.6. Add integration tests for Grok S2S credential resolution
2.7. Add E2E test for KoreVG session with Grok provider

### Parent Task 3: Credential Management & Studio UI

**Owner**: Frontend Engineering
**Estimated Effort**: 3-4 days
**Subtasks**:

3.1. Update `apps/studio/src/components/admin/VoiceServicesPage.tsx` to add "Grok (xAI) - Realtime Voice" option
3.2. Add Grok credential form fields (API Key, Organization ID optional)
3.3. Implement credential validation (non-empty, format check)
3.4. Add "Test Connection" button to validate Grok API key
3.5. Encrypt Grok credentials via `EncryptionService` before saving to MongoDB
3.6. Display Grok service status (Active, Inactive, Error) in Voice Services list
3.7. Add unit tests for Grok credential form (React Testing Library)
3.8. Add E2E test for Grok credential CRUD workflow (Playwright)

### Parent Task 4: Voice Mode Resolution & Observability

**Owner**: Platform Engineering
**Estimated Effort**: 2-3 days
**Subtasks**:

4.1. Verify `VoiceServiceFactory.resolveVoiceMode()` correctly detects Grok models
4.2. Update `resolveVoiceSession()` to create `GrokRealtimeSession` when providerType is 'grok_realtime'
4.3. Add trace event emissions for Grok sessions (session_start, turn_complete, session_end)
4.4. Include `providerType: 'grok_realtime'` in voice usage metrics
4.5. Update ClickHouse analytics queries to filter by Grok provider
4.6. Add Grok provider to voice analytics dashboards (Grafana or Studio)
4.7. Add integration tests for voice mode resolution with Grok
4.8. Add E2E test for web SDK voice session with Grok

### Parent Task 5: Documentation & Testing

**Owner**: Platform Engineering + Technical Writing
**Estimated Effort**: 2-3 days
**Subtasks**:

5.1. Update `docs/features/voice-capabilities.md` to list Grok as supported provider
5.2. Update `docs/specs/voice-capabilities.hld.md` architecture diagrams with Grok
5.3. Create testing guide in `docs/testing/sub-features/grok-realtime-s2s-voice.md`
5.4. Write developer guide for Grok voice configuration (API + DSL examples)
5.5. Update Voice Services help text in Studio to mention Grok
5.6. Add Grok to voice provider comparison table (latency, cost, features)
5.7. Run manual QA across web SDK, KoreVG, and Studio UI workflows
5.8. Validate all E2E and integration tests pass (CI green)

---

## 17. Testing & Validation

See [Testing Guide](../../testing/sub-features/grok-realtime-s2s-voice.md) for comprehensive test scenarios.

**Minimum Test Coverage:**

- **Unit Tests**: GrokRealtimeSession lifecycle, event handling, error cases (20+ tests)
- **Integration Tests**: Grok credential resolution, voice mode resolver with Grok, S2S provider routing (10+ tests)
- **E2E Tests**: Web SDK voice with Grok, KoreVG telephony with Grok, Studio credential CRUD (5+ tests)
- **Manual QA**: Real Grok API calls with production credentials, latency measurement, audio quality validation

**Test Scenarios (High-Level):**

1. **Grok Credential Configuration**: Admin adds Grok credentials in Studio, test connection succeeds
2. **Web SDK Voice Session**: User initiates voice session, Grok realtime selected, audio bidirectional
3. **KoreVG Telephony Call**: Phone caller reaches Grok-powered agent, transcript captured
4. **Tool Calling**: Grok calls ABL tool, result submitted, Grok responds with tool output
5. **Error Handling**: Grok API key invalid, system falls back to pipeline mode, error logged

---

**End of Feature Specification**
