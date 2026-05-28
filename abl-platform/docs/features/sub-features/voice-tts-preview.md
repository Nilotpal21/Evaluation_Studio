# Feature: Voice TTS Preview

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Voice Capabilities](../voice-capabilities.md)
**Status**: ALPHA
**Feature Area(s)**: `customer experience`, `admin operations`, `integrations`
**Package(s)**: `apps/runtime`, `apps/studio`
**Owner(s)**: `voice-platform`
**Testing Guide**: [../../testing/sub-features/voice-tts-preview.md](../../testing/sub-features/voice-tts-preview.md)
**Last Updated**: 2026-04-11

---

## 1. Introduction / Overview

### Problem Statement

Workspace admins configure TTS provider credentials (ElevenLabs, Orpheus/Groq, Cartesia) in Admin > Voice Services by entering API keys and selecting default voice/model settings. Channel builders then pick a TTS provider, language, and voice for each voice pipeline channel connection. **Neither user can hear the resulting voice until a live call happens.** If the API key is wrong, the voice sounds unnatural, or the wrong voice was selected, this is only discovered during a real caller interaction — causing poor customer experience and wasted debugging time.

### Goal Statement

Provide an inline TTS preview capability that lets users hear what their configured text-to-speech voice sounds like directly within the product surfaces where they configure those voices — without leaving the page, without re-entering credentials, and without needing a live call.

### Summary

Voice TTS Preview adds a "Preview Voice" control to two product surfaces:

1. **Channel Connection Configuration** — inside the Speech Synthesis section of voice pipeline channel settings, users can type sample text and click Play to hear the exact voice their callers will hear, using the connection's configured TTS provider, voice, and credentials.

2. **Admin > Voice Services** — on each configured TTS provider card, admins can test that their credentials work and audition voices with an optional voice override selector.

Both surfaces are delivered together, sharing a single `<TTSPreview>` component backed by a new generalized TTS preview API endpoint in the runtime.

---

## 2. Scope

### Goals

- Enable channel builders to preview TTS output inline while configuring a voice pipeline channel connection
- Enable workspace admins to validate TTS credentials and audition voices from Admin > Voice Services
- Provide a single, reusable `<TTSPreview>` UI component shared across both surfaces
- Add a generalized TTS preview API endpoint that supports ElevenLabs and Orpheus providers
- Display synthesis latency so users can evaluate voice provider performance
- Rate-limit the preview endpoint to prevent cost abuse

### Non-Goals (Out of Scope)

- STT (speech-to-text) preview or testing
- S2S / Realtime provider preview (OpenAI Realtime, Gemini Live, ElevenLabs Conversational AI, etc.) — these are bidirectional streaming protocols, fundamentally different from TTS
- Voice library browsing/discovery (browsing all available voices for a provider)
- SSML or markup editing in the preview
- Batch TTS generation or file export
- Voice cloning or custom voice creation
- Standalone TTS playground page in the product navigation
- Jambonz-proxied TTS providers (Deepgram, Google, AWS, Azure TTS via Jambonz) — these use a different synthesis path; can be added in a future iteration
- Audio recording/download functionality

---

## 3. User Stories

1. As a **channel builder**, I want to hear a sample of the TTS voice I selected for my voice pipeline connection so that I can verify it sounds appropriate for my use case before callers hear it.

2. As a **channel builder**, I want to see how long the TTS synthesis takes so that I can evaluate whether the provider/voice will introduce acceptable latency in live calls.

3. As a **workspace admin**, I want to test that my newly configured TTS provider credentials produce audio so that I can confirm the API key is valid before channel builders try to use it.

4. As a **workspace admin**, I want to hear what the default voice for a TTS provider sounds like — and override it to try other voices — so that I can make an informed choice about which voice to set as the workspace default.

5. As a **channel builder**, I want to type custom sample text for the preview so that I can hear how the voice handles the kind of content my agent will actually say (e.g., technical terms, greetings, numbers).

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a TTS preview control within the Speech Synthesis section of voice pipeline channel configuration (`ConfigurationTab.tsx` > `VoiceFields`).

2. **FR-2**: The system must accept user-provided sample text (1-500 characters) and synthesize it using the channel connection's currently selected TTS provider and service instance credentials.

3. **FR-3**: The system must expose a `POST /api/v1/voice/tts-preview` endpoint that accepts `{ text, serviceInstanceId, provider, voice?, model?, language? }` and returns audio data (WAV or MP3).

4. **FR-4**: The system must resolve TTS provider credentials via `VoiceServiceFactory.resolveServiceCredentials` using the provided `serviceInstanceId` and tenant context — the API key must never be sent from or exposed to the client.

5. **FR-5**: The system must support ElevenLabs and Orpheus (custom:orpheus) TTS providers.

6. **FR-6**: The system must display synthesis latency (total request duration in milliseconds) after audio playback completes.

7. **FR-7**: The system must rate-limit the TTS preview endpoint to 5 requests per minute per tenant to prevent cost abuse.

8. **FR-8**: The system must require authentication via `requireAuth` middleware and scope the preview to the authenticated user's tenant.

9. **FR-9**: The system must return structured error responses when synthesis fails (invalid credentials, provider error, rate limit exceeded) with user-friendly error messages.

10. **FR-10**: The system must provide a default sample text ("Hello, how can I help you today?") that users can override.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                           |
| -------------------------- | ------------ | ------------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Preview is tenant-scoped via service instances, not project-scoped              |
| Agent lifecycle            | NONE         | Does not affect agent configuration or execution                                |
| Customer experience        | PRIMARY      | Directly improves voice quality assurance before customer-facing calls          |
| Integrations / channels    | PRIMARY      | Integrates into voice channel connection configuration                          |
| Observability / tracing    | SECONDARY    | Preview requests should be logged but not traced like production calls          |
| Governance / controls      | SECONDARY    | Rate limiting prevents cost abuse; auth required                                |
| Enterprise / compliance    | NONE         | No PII in preview text (user-provided sample text)                              |
| Admin / operator workflows | PRIMARY      | Preview on Voice Services admin page for credential validation + voice audition |

### Related Feature Integration Matrix

| Related Feature                                | Relationship Type | Why It Matters                                                        | Key Touchpoints                                                               | Current State                               |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| [Voice Capabilities](../voice-capabilities.md) | extends           | TTS preview is a sub-feature of the voice platform                    | VoiceServiceFactory, service instance resolution, ElevenLabs/Orpheus services | ALPHA — voice pipeline and S2S both working |
| [Channels](../channels.md)                     | configured by     | Preview lives inside channel connection configuration UI              | ConfigurationTab > VoiceFields, speech-providers API                          | ALPHA — voice channel config exists         |
| [Auth Profiles](../auth-profiles.md)           | depends on        | TTS credentials may be resolved via auth profiles instead of raw keys | VoiceServiceFactory uses dualReadCredentials + resolveAuthProfileCredentials  | BETA — auth profile resolution works        |
| [Rate Limiting](../rate-limiting.md)           | shares data with  | Preview endpoint needs rate limiting                                  | Rate limit middleware in runtime                                              | BETA — rate limiting infrastructure exists  |

---

## 6. Design Considerations

### UX Placement

**Channel Configuration**: Inline within `ConfigurationTab.tsx` > `VoiceFields` > Speech Synthesis section. After the user selects TTS provider, language, and voice, a collapsible "Preview Voice" panel appears with:

- Text input (textarea, pre-filled with default sample text)
- "Play" button
- Audio player (HTML5 `<audio>` element)
- Latency display ("Generated in 340ms")
- Character count ("47 / 500 characters")

**Admin Voice Services**: On `VoiceServicesPage.tsx`, each configured TTS provider card gets a "Test" button that opens the `<TTSPreview>` component in a popover/dialog with `allowVoiceOverride: true`, letting admins try different voices.

### UX Anti-Patterns to Avoid

- **No auto-play**: Always require explicit click
- **No blocking**: Preview is optional, never blocks the save flow
- **No credential exposure**: Component receives `serviceInstanceId`, never API keys
- **No standalone page**: Preview lives in context, not as a separate nav item
- **No duplicate voice picker**: Uses whatever voice is already selected in the parent form

---

## 7. Technical Considerations

### Provider-Specific Synthesis

| Provider       | Service Class          | Output Format       | API                                        |
| -------------- | ---------------------- | ------------------- | ------------------------------------------ |
| ElevenLabs     | `ElevenLabsService`    | MP3 (mp3_44100_128) | `POST /v1/text-to-speech/{voiceId}/stream` |
| Orpheus (Groq) | `synthesizeOrpheusPcm` | WAV (PCM 24kHz)     | `POST /openai/v1/audio/speech` via Groq    |

The preview endpoint must normalize output to a browser-playable format. ElevenLabs natively returns MP3. Orpheus returns PCM that needs WAV wrapping (already handled by `buildPcm16MonoWav`).

### Credential Resolution Flow

```
Client: POST /api/v1/voice/tts-preview { serviceInstanceId, text, voice }
  → requireAuth middleware extracts tenantId
  → VoiceServiceFactory.resolveServiceCredentials(tenantId, provider, { instanceId })
  → Decrypt API key from TenantServiceInstance
  → Call provider API with decrypted key
  → Return audio buffer to client
```

### Audio Playback

The client receives audio as a binary response. The `<TTSPreview>` component creates an object URL from the blob and plays it via an HTML5 `<audio>` element. The object URL is revoked after playback to prevent memory leaks.

---

## 8. How to Consume

### Studio UI

**Channel Connection > Configuration > Speech Synthesis section** (voice_pipeline channels only):

- Route: `/projects/:projectId/deployments/channels/:channelId` → Configuration tab → VoiceFields → Speech Synthesis block
- Visible when: TTS provider is selected and at least one TTS service instance is configured
- User provides sample text, clicks Play, hears the audio

**Admin > Voice Services**:

- Route: `/admin/voice-services`
- Each configured TTS provider card shows a "Test" button
- Opens the `<TTSPreview>` component with `allowVoiceOverride: true` so admins can audition different voices

### API (Runtime)

| Method | Path                        | Purpose                                               |
| ------ | --------------------------- | ----------------------------------------------------- |
| POST   | `/api/v1/voice/tts-preview` | Synthesize text and return audio for browser playback |

**Request body:**

```json
{
  "text": "Hello, how can I help you today?",
  "serviceInstanceId": "svc_abc123",
  "provider": "elevenlabs",
  "voice": "EXAVITQu4vr4xnSDxMaL",
  "model": "eleven_multilingual_v2",
  "language": "en-US"
}
```

**Response:** Binary audio data with appropriate `Content-Type` (`audio/mpeg` for ElevenLabs, `audio/wav` for Orpheus).

**Error responses:**

```json
{ "success": false, "error": { "code": "RATE_LIMITED", "message": "TTS preview rate limit exceeded. Try again in 60 seconds." } }
{ "success": false, "error": { "code": "PROVIDER_ERROR", "message": "ElevenLabs API returned 401 — check your API key in Voice Services." } }
{ "success": false, "error": { "code": "SERVICE_NOT_CONFIGURED", "message": "No active TTS service instance found." } }
```

### API (Studio)

| Method | Path                             | Purpose                                     |
| ------ | -------------------------------- | ------------------------------------------- |
| POST   | `/api/voice/tts-preview` (proxy) | Studio Next.js proxy to runtime TTS preview |

### Admin Portal

"Test" button on Voice Services TTS provider cards with voice override capability.

### Channel / SDK / Voice / A2A / MCP Integration

This feature is not channel-aware at the transport level. It is a Studio-only UI capability used during channel configuration. The preview audio does not flow through any channel infrastructure (Jambonz, Twilio, LiveKit).

---

## 9. Data Model

### Collections / Tables

No new collections required. The feature uses existing data:

```text
Collection: tenantServiceInstances (existing)
Fields used:
  - _id: string (serviceInstanceId)
  - tenantId: string (tenant scoping)
  - serviceType: string ('elevenlabs' | 'custom:orpheus')
  - isActive: boolean
  - encryptedApiKey: string (decrypted server-side via VoiceServiceFactory)
  - config: { voiceId?, model?, ... }
```

### Key Relationships

- `TTSPreview` component → `serviceInstanceId` → `tenantServiceInstances` collection → decrypted credentials → provider API
- The service instance is already managed by Admin > Voice Services (`VoiceServicesPage.tsx`)
- Channel connections reference service instances via `ttsServiceInstanceId` in their config

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                   | Purpose                                         |
| ---------------------------------------------------------------------- | ----------------------------------------------- |
| `apps/runtime/src/services/voice/voice-service-factory.ts`             | Tenant-aware credential resolution + decryption |
| `apps/runtime/src/services/voice/elevenlabs-service.ts`                | ElevenLabs TTS synthesis (streaming + buffered) |
| `apps/runtime/src/services/voice/orpheus-tts.ts`                       | Orpheus TTS synthesis via Groq                  |
| `apps/runtime/src/services/voice/orpheus-service-instance-resolver.ts` | Orpheus credential resolution pattern           |

### Routes / Handlers

| File                                           | Purpose                                |
| ---------------------------------------------- | -------------------------------------- |
| `apps/runtime/src/routes/custom-tts.ts`        | Existing Orpheus TTS route (reference) |
| `apps/runtime/src/routes/tts-preview.ts` (NEW) | Generalized TTS preview endpoint       |

### UI Components

| File                                                                        | Purpose                                  |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/studio/src/components/voice/TTSPreview.tsx` (NEW)                     | Shared TTS preview component             |
| `apps/studio/src/api/tts-preview.ts` (NEW)                                  | Studio API client for TTS preview        |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | Integration point in VoiceFields section |

### Jobs / Workers / Background Processes

N/A — TTS preview is synchronous request/response.

### Tests

| File                                                                   | Type        | Coverage Focus                           |
| ---------------------------------------------------------------------- | ----------- | ---------------------------------------- |
| `apps/runtime/src/__tests__/routes/tts-preview.test.ts` (NEW)          | integration | Endpoint validation, auth, rate limiting |
| `apps/studio/src/__tests__/components/voice/TTSPreview.test.tsx` (NEW) | unit        | Component rendering, state management    |

---

## 11. Configuration

### Environment Variables

| Variable                 | Default | Description                                    |
| ------------------------ | ------- | ---------------------------------------------- |
| `TTS_PREVIEW_RATE_LIMIT` | `5`     | Max TTS preview requests per minute per tenant |
| `TTS_PREVIEW_MAX_CHARS`  | `500`   | Maximum character count for preview text input |

### Runtime Configuration

No feature flags. The preview UI is always visible when a TTS provider is configured for a voice pipeline channel.

### DSL / Agent IR / Schema

N/A — TTS preview is a Studio/admin tool, not an agent configuration concern.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation  | The preview endpoint resolves credentials via `tenantId` from auth context. A tenant can only preview using their own service instances. Cross-tenant returns 404. |
| Project isolation | N/A — service instances are tenant-scoped, not project-scoped. The preview is available from any project's channel configuration.                                  |
| User isolation    | Any authenticated user in the tenant can use the preview. No user-level access restriction beyond tenant membership.                                               |

### Security & Compliance

- **Auth**: `requireAuth` middleware required on the preview endpoint
- **Credential handling**: API keys are resolved server-side from encrypted service instances; never sent to or from the client
- **Input validation**: Preview text validated via Zod (min 1, max 500 characters, string type)
- **No PII expectation**: Preview text is user-provided sample text, not customer data. No PII detection/masking required.

### Performance & Scalability

- **Latency**: ElevenLabs: ~300-800ms for short text. Orpheus via Groq: ~500-1500ms. Preview is not in the call path — latency is acceptable.
- **Payload size**: Audio responses typically 50-200KB for short preview text. No compression needed.
- **Caching**: No caching of preview audio — each request generates fresh audio (different text, different voice settings).
- **Rate limiting**: 5 requests/minute/tenant prevents accidental cost spikes.

### Reliability & Failure Modes

- **Provider down**: Return structured error with provider-specific message. Do not retry automatically.
- **Invalid credentials**: Return clear error ("check your API key in Voice Services") so the user knows where to fix it.
- **Rate limit exceeded**: Return 429 with human-readable message and retry-after hint.
- **Degraded mode**: If the preview endpoint is unavailable, the channel configuration UI works normally — preview is additive, never blocking.

### Observability

- Log each preview request with: tenantId, provider, serviceInstanceId, text length, latency, success/failure
- Use `createLogger('tts-preview')` — do not emit TraceEvents (preview is not an agent execution)
- No dashboards or alerts initially

### Data Lifecycle

- Preview audio is ephemeral — generated on demand, streamed to client, not persisted
- No database writes, no storage, no TTL concerns
- Request logs follow standard runtime log retention

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Runtime TTS Preview Endpoint

1.1 Create `apps/runtime/src/routes/tts-preview.ts` with `POST /api/v1/voice/tts-preview`
1.2 Implement provider dispatch: route to ElevenLabsService or Orpheus synthesizer based on `provider` field
1.3 Integrate `VoiceServiceFactory.resolveServiceCredentials` for tenant-scoped credential resolution
1.4 Add Zod request validation (text, serviceInstanceId, provider, optional voice/model/language)
1.5 Add rate limiting (5 req/min/tenant)
1.6 Add structured error responses for auth, validation, provider, and rate limit failures
1.7 Register route in runtime server.ts
1.8 Write integration tests

### Phase 2: Studio API Client + TTSPreview Component

2.1 Create `apps/studio/src/api/tts-preview.ts` — API client that calls the runtime endpoint via Studio proxy
2.2 Create Studio Next.js API route to proxy TTS preview requests to runtime
2.3 Create `apps/studio/src/components/voice/TTSPreview.tsx` — shared component with text input, play button, audio player, latency display, optional voice override selector
2.4 Write component tests

### Phase 3: Channel Configuration Integration

3.1 Import and render `<TTSPreview>` in `ConfigurationTab.tsx` > `VoiceFields` > Speech Synthesis section
3.2 Pass selected TTS provider, serviceInstanceId, voice, and model as props with `allowVoiceOverride: false`
3.3 Show preview only when a TTS provider is selected
3.4 Test the full flow: select provider → type text → play → hear audio

### Phase 4: Admin Voice Services Integration

4.1 Add "Test" button to TTS provider cards on `VoiceServicesPage.tsx`
4.2 Render `<TTSPreview>` in a dialog/popover with `allowVoiceOverride: true`
4.3 Allow voice selection override for audition purposes
4.4 Test the full flow: click Test → select voice → type text → play → hear audio

---

## 14. Success Metrics

| Metric                                    | Baseline         | Target                                          | How Measured                                 |
| ----------------------------------------- | ---------------- | ----------------------------------------------- | -------------------------------------------- |
| Preview usage rate                        | 0                | >50% of voice channel configs trigger a preview | Runtime logs: count of /tts-preview requests |
| Credential validation success             | Unknown          | >90% first-try success                          | Preview success rate vs. provider error rate |
| Time to first voice preview               | N/A (no feature) | <5 seconds from clicking Play                   | Client-side timing in TTSPreview component   |
| Reduction in voice config support tickets | Baseline TBD     | 30% reduction                                   | Support ticket analysis                      |

---

## 15. Open Questions

1. Should Cartesia TTS be included? It was recently added to `TTS_SERVICE_TYPES` in VoiceServicesPage but no Cartesia synthesis service exists in the runtime yet.
2. Should the preview output audio at native provider sample rate or downsample to telephony (8kHz) to simulate what callers actually hear? Current decision: native rate for preview quality, but this is debatable.
3. Should the ElevenLabs preview use `mp3_44100_128` (best quality) or `ulaw_8000` (telephony fidelity)? Recommendation: mp3 for preview, since users want to evaluate voice quality.
4. Should preview requests count against the tenant's ElevenLabs character quota? (They will by nature of calling the ElevenLabs API — should we warn users about this?)

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                     | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Jambonz-proxied TTS providers (Deepgram, Google, AWS, Azure) not supported — can be added later | Medium   | Open   |
| GAP-002 | No voice-override selection in channel config preview (uses currently selected voice only)      | Low      | Open   |
| GAP-003 | No audio download/save capability                                                               | Low      | Open   |
| GAP-004 | Cartesia TTS has no runtime synthesis service — cannot be previewed until a service is built    | Medium   | Open   |
| GAP-005 | No visual waveform display — uses basic HTML5 audio player                                      | Low      | Open   |

---

## 17. Testing & Validation

### Test Coverage Summary

| Type        | Count | Key Scenarios                                                       |
| ----------- | ----- | ------------------------------------------------------------------- |
| E2E         | 7     | Both providers, cross-tenant isolation, auth, rate limiting, errors |
| Integration | 11    | Validation, provider dispatch, credential resolution, rate limiting |
| Unit        | 9     | TTSPreview component rendering, state management, voice override    |
| Security    | 5     | Tenant isolation, auth, credential exposure, input validation       |
| Manual      | 3     | UI layout, audio quality, error UX                                  |

### Testing Principles

- External provider APIs (ElevenLabs, Groq) mocked via dependency injection — NOT `vi.mock`
- E2E tests exercise the real auth middleware chain and tenant isolation
- Manual testing required for audio playback quality verification

> Full testing details: [../../testing/sub-features/voice-tts-preview.md](../../testing/sub-features/voice-tts-preview.md)

---

## 18. References

- Design docs: (to be created in `/hld` phase)
- Parent feature: [Voice Capabilities](../voice-capabilities.md)
- Related: [Channels](../channels.md), [Auth Profiles](../auth-profiles.md)
- Existing TTS implementation: `apps/runtime/src/routes/custom-tts.ts`, `apps/runtime/src/services/voice/orpheus-tts.ts`
- ElevenLabs service: `apps/runtime/src/services/voice/elevenlabs-service.ts`
- Voice Service Factory: `apps/runtime/src/services/voice/voice-service-factory.ts`
