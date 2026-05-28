# HLD: Voice TTS Preview

**Feature Spec**: `docs/features/sub-features/voice-tts-preview.md`
**Test Spec**: `docs/testing/sub-features/voice-tts-preview.md`
**Status**: IMPLEMENTED
**Author**: bhanurajak
**Date**: 2026-04-11

---

## 1. Problem Statement

Workspace admins configure TTS provider credentials (API keys, voice IDs, models) in Admin > Voice Services, and channel builders select TTS provider/language/voice for pipeline channels — but neither can hear the resulting voice until a live call. Invalid API keys, unnatural voices, or wrong voice selections are only discovered during real caller interactions.

This HLD designs an inline TTS preview capability that synthesizes sample text on demand using the tenant's configured TTS credentials and returns playable audio directly in the Studio UI — in both the channel configuration and admin voice services surfaces.

---

## 2. Alternatives Considered

### Option A: New Generalized TTS Preview Route (Recommended)

- **Description**: Add a new `POST /api/v1/voice/tts-preview` route in the runtime that accepts `{ text, serviceInstanceId, provider, voice?, model? }`, resolves credentials via `VoiceServiceFactory.resolveServiceCredentials`, dispatches to the appropriate provider (ElevenLabs or Orpheus), and returns audio bytes. Studio calls this directly via `apiFetch(getRuntimeUrl() + '...')`.
- **Pros**: Single endpoint for all TTS providers. Follows existing credential resolution patterns. Clean separation — route handles HTTP concerns, factory handles credentials, provider services handle synthesis. Consistent with how `voice.ts` API client calls runtime directly.
- **Cons**: New route to maintain. Must handle two different audio output formats (MP3 vs WAV).
- **Effort**: S

### Option B: Extend Existing Custom-TTS Route

- **Description**: Modify `custom-tts.ts` `/orpheus` endpoint to accept an additional `provider` field and support ElevenLabs alongside Orpheus.
- **Pros**: No new route file. Reuses existing authorization logic.
- **Cons**: `custom-tts.ts` uses its own auth token (`ORPHEUS_TTS_AUTH_TOKEN`) instead of `requireAuth` — fundamentally different security model. It's designed for Jambonz callbacks, not user-facing preview. Adding ElevenLabs to an Orpheus-specific route is a naming/ownership conflict. The route also has streaming modes (`progressive`) designed for telephony, not browser playback.
- **Effort**: M (more refactoring to adapt the auth model)

### Option C: Studio-Side Proxy with Server-Side Synthesis

- **Description**: Create a Next.js API route in Studio that resolves credentials and calls provider APIs server-side, returning audio to the browser. Studio becomes the synthesis orchestrator.
- **Pros**: No runtime changes needed.
- **Cons**: Violates architecture — Studio is a frontend host, not a service execution layer. VoiceServiceFactory and all credential resolution logic live in the runtime. Would require duplicating or importing runtime service code into Studio. Studio has no MongoDB access for service instance lookup.
- **Effort**: L (and architecturally wrong)

### Recommendation: Option A

**Rationale**: Option A is the only approach that follows the existing architecture. Credentials live in the runtime's MongoDB, resolved via `VoiceServiceFactory`. The runtime already has both ElevenLabs and Orpheus service implementations. The new route is small (~100 lines), uses existing auth middleware, and naturally fits alongside the existing `/api/v1/voice/*` routes. Option B's auth model (static token) is incompatible with user-facing preview. Option C moves service logic into the wrong layer.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Studio (Browser)                      │
│                                                              │
│  ┌──────────────────────┐    ┌───────────────────────────┐  │
│  │  ConfigurationTab    │    │  VoiceServicesPage        │  │
│  │  └── VoiceFields     │    │  └── ServiceCard          │  │
│  │      └── TTSPreview  │    │      └── TTSPreview       │  │
│  └──────────┬───────────┘    └────────────┬──────────────┘  │
│             │                             │                  │
│             └──────────┬──────────────────┘                  │
│                        │ POST /api/v1/voice/tts-preview      │
└────────────────────────┼─────────────────────────────────────┘
                         │ (JWT Bearer token)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                     Runtime (Express)                         │
│                                                              │
│  requireAuth → rateLimiter → zodValidation → tts-preview     │
│                                                  │           │
│                              ┌────────────────────┤           │
│                              │                    │           │
│                    VoiceServiceFactory     Provider Dispatch  │
│                    resolveServiceCredentials       │           │
│                              │              ┌─────┴─────┐    │
│                              ▼              ▼           ▼    │
│                         MongoDB        ElevenLabs    Orpheus │
│                    (TenantServiceInstance)  API      (Groq)  │
│                    decrypt API key          │           │     │
│                                            ▼           ▼     │
│                                        audio/mpeg   audio/wav│
└──────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
apps/runtime/
├── routes/
│   └── tts-preview.ts (NEW)        ← HTTP handler, Zod validation, rate limit
├── services/voice/
│   ├── voice-service-factory.ts     ← resolveServiceCredentials (existing)
│   ├── elevenlabs-service.ts        ← synthesize() → Buffer (existing)
│   └── orpheus-tts.ts               ← synthesizeOrpheusSpeech() → WAV (existing)
└── middleware/
    ├── auth.ts                      ← requireAuth (existing)
    └── rate-limiter.ts              ← tenantRateLimit (existing)

apps/studio/
├── api/
│   └── tts-preview.ts (NEW)         ← API client: POST to runtime
├── components/voice/
│   └── TTSPreview.tsx (NEW)          ← Shared UI: text input, play, latency
└── components/
    ├── deployments/channels/tabs/
    │   └── ConfigurationTab.tsx      ← Integration point (VoiceFields section)
    └── admin/
        └── VoiceServicesPage.tsx     ← Integration point (Test button)
```

### Data Flow

**Request Path (browser → audio):**

1. User types sample text in `<TTSPreview>`, clicks Play
2. `TTSPreview` calls `synthesizeTTSPreview()` from `api/tts-preview.ts`
3. Studio API client sends `POST ${getRuntimeUrl()}/api/v1/voice/tts-preview` with JWT
4. Runtime middleware chain: `requireAuth` → `tenantRateLimit(5/min)` → `zodValidation`
5. Route handler extracts `tenantId` from auth context
6. `VoiceServiceFactory.resolveServiceCredentials(tenantId, provider, { instanceId })` → decrypt API key from MongoDB
7. Provider dispatch:
   - `elevenlabs`: `new ElevenLabsService({apiKey, voiceId, modelId}).synthesize(text, {outputFormat: 'mp3_44100_128'})` → MP3 Buffer
   - `custom:orpheus`: `synthesizeOrpheusSpeech({apiKey, text, voice, model})` → WAV Buffer
8. Response: `200` + audio bytes + `Content-Type` + `X-Synthesis-Latency-Ms` header
9. Studio creates `Blob` → `URL.createObjectURL()` → `<audio>` element plays
10. On next play or component unmount: `URL.revokeObjectURL()` to prevent memory leak

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern              | Design Decision                                                                                                                                                                                                                                                                                                             |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation** | `requireAuth` middleware extracts `tenantId` from JWT. `VoiceServiceFactory.resolveServiceCredentials` queries MongoDB with `{ tenantId, serviceType, instanceId }` — a tenant can only access their own service instances. Cross-tenant requests get `null` from the factory → 404 response (not 403, per core invariant). |
| 2   | **Data Access**      | No new data models. The route reads from `TenantServiceInstance` via `VoiceServiceFactory` (existing repo layer: `findActiveVoiceServiceInstanceById`). No caching of preview results — each request synthesizes fresh audio. The factory's existing 10-min LRU cache applies to credential resolution.                     |
| 3   | **API Contract**     | `POST /api/v1/voice/tts-preview` — Zod-validated JSON request body, binary audio response. Content-Type varies by provider (`audio/mpeg` or `audio/wav`). Error responses follow the platform pattern: `{ success: false, error: { code, message } }`. No breaking changes to existing APIs.                                |
| 4   | **Security Surface** | Auth: `requireAuth` middleware (JWT). Input: Zod schema validates text length (1-500), provider enum, string IDs. No SSRF risk — provider URLs are hardcoded in service implementations, not user-controlled. Credentials are decrypted server-side and never returned to the client.                                       |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Three error categories: (1) Validation errors → 400 with Zod details. (2) Service errors → 404 for missing instance, 429 for rate limit. (3) Provider errors → 502 with `PROVIDER_ERROR` code and sanitized message (e.g., "ElevenLabs API returned 401 — check your API key"). Raw provider errors are logged, not leaked to the client.                                                      |
| 6   | **Failure Modes** | Provider API down → 502 with retry suggestion. Provider timeout → ElevenLabsService already has 15s fetch timeout + 10s chunk timeout, Orpheus uses fetch timeout. No circuit breaker — preview is low-volume, non-critical. Network partition to MongoDB → credential resolution fails → 500 (generic). All failures are non-blocking — the channel config UI works normally without preview. |
| 7   | **Idempotency**   | Each preview request is idempotent — same input always produces equivalent audio (voices are deterministic for same text/settings). No state mutations. No dedup needed. Safe to retry.                                                                                                                                                                                                        |
| 8   | **Observability** | Log every preview request with `createLogger('tts-preview')`: tenantId, provider, serviceInstanceId, text length, latency, success/failure. No `TraceEvent` emission — preview is not an agent execution. `X-Synthesis-Latency-Ms` response header for client-side display.                                                                                                                    |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Target: <2s for short text (<100 chars). ElevenLabs: ~300-800ms, Orpheus: ~500-1500ms. Max payload: ~200KB audio for 500 chars. No compression needed at these sizes. Rate limit (5/min/tenant) caps provider API costs.                                                                                                                                                                                                                                          |
| 10  | **Migration Path**     | No data migration. New route is purely additive — zero changes to existing routes, services, or data models. Studio integration is additive (new component imported into existing pages). No feature flag needed — the preview UI is inert when no TTS service instance is configured.                                                                                                                                                                            |
| 11  | **Rollback Plan**      | Remove the route registration line from `server.ts` and the `<TTSPreview>` imports from `ConfigurationTab.tsx` and `VoiceServicesPage.tsx`. Since no data model changes exist, rollback is a pure code revert. Alternatively, deploy the runtime without the new route — Studio will show a network error on Play, but all other functionality is unaffected.                                                                                                     |
| 12  | **Test Strategy**      | **E2E (7)**: Real Express server, real auth middleware, real MongoDB, DI-stubbed external providers. Tests: both providers, cross-tenant 404, unauth 401, rate limiting, invalid credentials, voice override. **Integration (11)**: Zod validation, provider dispatch, credential resolution, rate limit, error mapping. **Unit (9)**: TTSPreview component rendering, state management, voice override toggle, memory cleanup. See test spec for full scenarios. |

---

## 5. Data Model

### New Collections/Tables

None. TTS preview is stateless — no data is persisted.

### Modified Collections/Tables

None. The feature reads from existing `TenantServiceInstance` documents.

### Key Relationships

```
TTSPreview component
  → serviceInstanceId (from channel connection config or admin voice service card)
    → TenantServiceInstance collection (existing)
      → encryptedApiKey (decrypted by VoiceServiceFactory)
        → Provider API (ElevenLabs or Groq)
```

---

## 6. API Design

### New Endpoints

| Method | Path                        | Purpose                       | Auth          | Rate Limit       |
| ------ | --------------------------- | ----------------------------- | ------------- | ---------------- |
| POST   | `/api/v1/voice/tts-preview` | Synthesize text, return audio | `requireAuth` | 5 req/min/tenant |

**Request Schema (Zod):**

```typescript
const ttsPreviewSchema = z.object({
  text: z.string().min(1).max(500),
  serviceInstanceId: z.string().min(1),
  provider: z.enum(['elevenlabs', 'custom:orpheus']),
  voice: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  language: z.string().optional(),
});
```

**Response (success):**

- Status: `200`
- Headers: `Content-Type: audio/mpeg` (ElevenLabs) or `Content-Type: audio/wav` (Orpheus), `X-Synthesis-Latency-Ms: <ms>`
- Body: Binary audio data

**Response (errors):**

| Status | Code                     | When                                  |
| ------ | ------------------------ | ------------------------------------- |
| 400    | `VALIDATION_ERROR`       | Zod validation failure                |
| 400    | `UNSUPPORTED_PROVIDER`   | Provider not in enum                  |
| 401    | `UNAUTHORIZED`           | Missing/invalid JWT                   |
| 404    | `SERVICE_NOT_CONFIGURED` | Service instance not found for tenant |
| 429    | `RATE_LIMITED`           | >5 requests/min from this tenant      |
| 502    | `PROVIDER_ERROR`         | Provider API failure (auth, timeout)  |

### Modified Endpoints

None. All existing APIs remain unchanged.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Not required for preview — it's a read-only operation against credentials the user already configured. Standard request logging via `createLogger` is sufficient.
- **Rate Limiting**: 5 requests/minute/tenant via `tenantRateLimit` middleware with `tts_preview` operation key. Configurable via `TTS_PREVIEW_RATE_LIMIT` env var.
- **Caching**: No audio caching. `VoiceServiceFactory` already caches decrypted credentials for 10 minutes (LRU, max 100 entries). This is sufficient.
- **Encryption**: Credentials are encrypted at rest in MongoDB (Mongoose encryption plugin). `VoiceServiceFactory.resolveServiceCredentials` handles decryption transparently. The decrypted API key is used in memory only for the provider API call — never returned in the HTTP response.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type     | Risk                                                          |
| ----------------------------- | -------- | ------------------------------------------------------------- |
| `VoiceServiceFactory`         | Runtime  | Low — stable, well-tested credential resolution               |
| `ElevenLabsService`           | Runtime  | Low — existing synthesis method, used in production           |
| `synthesizeOrpheusSpeech`     | Runtime  | Low — existing synthesis function, used in production         |
| `requireAuth` middleware      | Runtime  | None — foundational platform middleware                       |
| `tenantRateLimit` middleware  | Runtime  | Low — existing middleware, may need new operation key         |
| `TenantServiceInstance` model | Data     | None — existing collection, no schema changes                 |
| ElevenLabs API                | External | Medium — third-party dependency, has rate limits and quotas   |
| Groq API (Orpheus)            | External | Medium — third-party dependency, may have availability issues |

### Downstream (depends on this feature)

| Consumer | Impact                                         |
| -------- | ---------------------------------------------- |
| None     | This is a leaf feature — nothing depends on it |

---

## 9. Open Questions & Decisions Needed

1. **Cartesia support**: Cartesia was recently added to `TTS_SERVICE_TYPES` in `VoiceServicesPage` but has no runtime synthesis service. Should the preview endpoint plan for future Cartesia support (via a provider plugin interface), or is a static `switch` on provider type sufficient?

2. **Studio API pattern**: The `voice.ts` API client calls the runtime directly via `getRuntimeUrl()`. Should `tts-preview.ts` follow the same pattern, or should it use a Studio proxy route (like `channels.ts` does) to avoid CORS issues? The direct pattern is simpler and already works for voice API calls.

3. **Audio response format**: Should the endpoint normalize all output to a single format (e.g., always WAV), or return the native format per provider? Returning native format (MP3 for ElevenLabs, WAV for Orpheus) avoids unnecessary transcoding and keeps the endpoint simple. The browser can play both.

---

## 10. References

- Feature spec: `docs/features/sub-features/voice-tts-preview.md`
- Test spec: `docs/testing/sub-features/voice-tts-preview.md`
- Existing Orpheus TTS route: `apps/runtime/src/routes/custom-tts.ts`
- Credential resolution: `apps/runtime/src/services/voice/voice-service-factory.ts`
- ElevenLabs service: `apps/runtime/src/services/voice/elevenlabs-service.ts`
- Orpheus synthesis: `apps/runtime/src/services/voice/orpheus-tts.ts`
- Orpheus resolver: `apps/runtime/src/services/voice/orpheus-service-instance-resolver.ts`
- Voice API client: `apps/studio/src/api/voice.ts`
- Speech providers: `apps/studio/src/api/speech-providers.ts`
- Channel config UI: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`
- Voice services admin: `apps/studio/src/components/admin/VoiceServicesPage.tsx`
