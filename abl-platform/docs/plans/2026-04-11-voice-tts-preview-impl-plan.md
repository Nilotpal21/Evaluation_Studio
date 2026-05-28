# LLD: Voice TTS Preview

**Feature Spec**: `docs/features/sub-features/voice-tts-preview.md`
**HLD**: `docs/specs/voice-tts-preview.hld.md`
**Test Spec**: `docs/testing/sub-features/voice-tts-preview.md`
**Status**: DONE
**Date**: 2026-04-11

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                      | Rationale                                                                                                                                            | Alternatives Rejected                                       |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| D-1 | New route file `tts-preview.ts`                               | Clean separation from `custom-tts.ts` which uses static token auth for Jambonz callbacks                                                             | Extending `custom-tts.ts` (wrong auth model)                |
| D-2 | Use `tenantRateLimit('request', { requestsPerMinute: 5 })`    | Reuses existing rate-limit middleware with an override. No new `RateLimitOperation` type needed.                                                     | Adding a new `tts_preview` operation type (over-engineered) |
| D-3 | Direct runtime call via `getRuntimeUrl()`                     | Follows existing pattern in `voice.ts` and `speech-providers.ts` Studio API clients                                                                  | Studio Next.js proxy route (unnecessary indirection)        |
| D-4 | ElevenLabs `synthesize()` (buffered) not `synthesizeStream()` | Preview is short text (<500 chars), response is <200KB. Buffered is simpler — no need for streaming. Browser `<audio>` needs a complete blob anyway. | Streaming (adds complexity for no benefit at this scale)    |
| D-5 | ElevenLabs `outputFormat: 'mp3_44100_128'`                    | Best quality for preview evaluation. Default `ulaw_8000` is optimized for Twilio telephony, not browser playback.                                    | `ulaw_8000` (telephony encoding, poor browser quality)      |
| D-6 | `VoiceServiceFactory` instantiation per request               | Follows `resolveOrpheusServiceConfig` pattern (creates factory, calls `resolveServiceCredentials`, discards). Factory has internal LRU cache.        | Singleton factory (factory is stateless except cache)       |

### Key Interfaces & Types

```typescript
// apps/runtime/src/routes/tts-preview.ts

import { z } from 'zod';

export const ttsPreviewRequestSchema = z.object({
  text: z.string().min(1).max(500),
  serviceInstanceId: z.string().min(1),
  provider: z.enum(['elevenlabs', 'custom:orpheus']),
  voice: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  language: z.string().optional(),
});

export type TtsPreviewRequest = z.infer<typeof ttsPreviewRequestSchema>;
```

```typescript
// apps/studio/src/api/tts-preview.ts

export interface TtsPreviewParams {
  text: string;
  serviceInstanceId: string;
  provider: 'elevenlabs' | 'custom:orpheus';
  voice?: string;
  model?: string;
  language?: string;
}

export interface TtsPreviewResult {
  audioBlob: Blob;
  contentType: string;
  latencyMs: number;
}
```

```typescript
// apps/studio/src/components/voice/TTSPreview.tsx

export interface TTSPreviewProps {
  provider: string;
  serviceInstanceId: string;
  voice?: string;
  model?: string;
  language?: string;
  allowVoiceOverride?: boolean;
}
```

### Module Boundaries

| Module                            | Responsibility                                               | Depends On                                          |
| --------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `routes/tts-preview.ts`           | HTTP handling, Zod validation, rate limit, provider dispatch | VoiceServiceFactory, ElevenLabsService, orpheus-tts |
| `api/tts-preview.ts`              | Studio→Runtime HTTP client for TTS preview                   | `apiFetch`, `getRuntimeUrl`                         |
| `components/voice/TTSPreview.tsx` | UI: text input, play button, audio player, latency display   | `api/tts-preview.ts`                                |

---

## 2. File-Level Change Map

### New Files

| File                                              | Purpose                           | LOC Estimate |
| ------------------------------------------------- | --------------------------------- | ------------ |
| `apps/runtime/src/routes/tts-preview.ts`          | Runtime TTS preview endpoint      | ~120         |
| `apps/studio/src/api/tts-preview.ts`              | Studio API client                 | ~50          |
| `apps/studio/src/components/voice/TTSPreview.tsx` | Shared TTSPreview React component | ~180         |

### Modified Files

| File                                                                        | Change Description                                             | Risk |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | ---- |
| `apps/runtime/src/server.ts`                                                | Add import + `app.use` for tts-preview route (~2 lines)        | Low  |
| `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` | Import and render `<TTSPreview>` in Speech Synthesis section   | Low  |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`                    | Add "Test" button to ServiceCard, render `<TTSPreview>` dialog | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Runtime TTS Preview Endpoint

**Goal**: Create the `POST /api/v1/voice/tts-preview` endpoint with auth, rate limiting, Zod validation, and provider dispatch.

**Tasks**:

1.1. Create `apps/runtime/src/routes/tts-preview.ts`:

- Import `express`, `z`, `createLogger`, `authMiddleware`, `tenantRateLimit`, `VoiceServiceFactory`, `ElevenLabsService`, `synthesizeOrpheusSpeech`, `isEncryptionAvailable`, `getEncryptionService`
- Define `ttsPreviewRequestSchema` (Zod schema from §1)
- Create Express Router
- Add `POST /` handler with middleware chain: `authMiddleware`, `tenantRateLimit('request', { requestsPerMinute: 5 })`
- In handler: parse body with Zod, extract `tenantId` from `req.tenantContext`, create VoiceServiceFactory, call `resolveServiceCredentials(tenantId, provider, { instanceId: serviceInstanceId })`, dispatch to provider, return audio with correct Content-Type and `X-Synthesis-Latency-Ms` header
- Provider dispatch: `elevenlabs` → `ElevenLabsService.fromCredentials().synthesize(text, { voiceId, modelId, outputFormat: 'mp3_44100_128' })`, `custom:orpheus` → `synthesizeOrpheusSpeech({ apiKey, text, voice, model })`
- Error handling: Zod errors → 400, null credentials → 404, provider errors → 502, all with `{ success: false, error: { code, message } }`

  1.2. Register route in `apps/runtime/src/server.ts`:

- Add `import ttsPreviewRouter from './routes/tts-preview.js';` (near line 21, with other voice-related imports)
- Add `app.use('/api/v1/voice/tts-preview', ttsPreviewRouter);` (after line 599, after `custom-tts` route)

  1.3. Run `pnpm build --filter=@agent-platform/runtime` to verify compilation

**Files Touched**:

- `apps/runtime/src/routes/tts-preview.ts` — NEW
- `apps/runtime/src/server.ts` — add import + route registration

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 type errors
- [ ] `curl -X POST http://localhost:3112/api/v1/voice/tts-preview` with no auth returns 401
- [ ] Route handler dispatches to correct provider based on `provider` field
- [ ] Invalid request body returns 400 with Zod error details
- [ ] Non-existent serviceInstanceId returns 404 with `SERVICE_NOT_CONFIGURED` code

**Test Strategy**:

- Integration: Tested in Phase 4 (after all code is written)
- Manual: `curl` with valid JWT to verify the endpoint works

**Rollback**: Delete `tts-preview.ts`, remove 2 lines from `server.ts`

---

### Phase 2: Studio API Client + TTSPreview Component

**Goal**: Create the Studio-side API client and shared `<TTSPreview>` React component.

**Tasks**:

2.1. Create `apps/studio/src/api/tts-preview.ts`:

- Import `apiFetch` from `../lib/api-client` and `getRuntimeUrl` from `../config/runtime`
- Export `synthesizeTTSPreview(params: TtsPreviewParams): Promise<TtsPreviewResult>`
- Implementation: `POST ${getRuntimeUrl()}/api/v1/voice/tts-preview` with JSON body, handle response as blob, extract `X-Synthesis-Latency-Ms` header, return `{ audioBlob, contentType, latencyMs }`
- Handle error responses: check `res.ok`, parse JSON error body, throw descriptive error

  2.2. Create `apps/studio/src/components/voice/TTSPreview.tsx`:

- Accept props: `TTSPreviewProps` (provider, serviceInstanceId, voice?, model?, language?, allowVoiceOverride?)
- State: `text` (default: "Hello, how can I help you today?"), `loading`, `error`, `audioUrl`, `latencyMs`
- Render: textarea for text input, character counter ("X / 500 characters"), Play button (disabled when loading or no serviceInstanceId), audio element (hidden until audioUrl exists), latency display, error message
- On Play click: call `synthesizeTTSPreview()`, create object URL from blob, set audioUrl, auto-play
- Cleanup: `URL.revokeObjectURL()` on new play or component unmount via `useEffect` cleanup
- If `allowVoiceOverride` is true: render a text input for voice ID override (simple for now; fetching voice lists is a v2 enhancement)
- Use design tokens for styling (no hardcoded Tailwind palette colors)

  2.3. Run `pnpm build --filter=@agent-platform/studio` to verify compilation

**Files Touched**:

- `apps/studio/src/api/tts-preview.ts` — NEW
- `apps/studio/src/components/voice/TTSPreview.tsx` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 type errors
- [ ] `TTSPreview` component renders with default text and Play button
- [ ] `synthesizeTTSPreview` function signature matches the runtime endpoint schema
- [ ] Object URL is revoked in cleanup effect

**Test Strategy**:

- Unit: Tested in Phase 4 (after all code is written)
- Manual: Render component in isolation to verify UI

**Rollback**: Delete the 2 new files

---

### Phase 3: UI Integration — Channel Config + Admin Voice Services

**Goal**: Wire `<TTSPreview>` into both product surfaces.

**Tasks**:

3.1. Integrate into `ConfigurationTab.tsx` VoiceFields Speech Synthesis section:

- Import `TTSPreview` from `../../voice/TTSPreview` (relative from the channels/tabs directory)
- After the Orpheus streaming checkbox (line ~1396, inside the `isPipeline && ttsProviders.length > 0` block), add the `<TTSPreview>` component:
  ```tsx
  {
    selectedTtsProvider && (
      <TTSPreview
        provider={selectedTtsProvider.serviceType}
        serviceInstanceId={selectedTtsProvider.id}
        voice={config.ttsVoice as string}
        model={getProviderConfigString(selectedTtsProvider, 'model')}
        language={config.ttsLanguage as string}
      />
    );
  }
  ```
- Wrap in the same `space-y-3` container as sibling elements

  3.2. Integrate into `VoiceServicesPage.tsx` ServiceCard:

- Import `TTSPreview` and a dialog component (use existing `Dialog` from UI library)
- In the `ServiceCard` component, after the "Edit" button (line ~461), add a "Test" button that is visible only when `isConfigured` is true AND the service type is a TTS provider (`elevenlabs` or `custom:orpheus`):
  ```tsx
  {
    isConfigured && ['elevenlabs', 'custom:orpheus'].includes(config.serviceType) && (
      <Button variant="ghost" size="sm" onClick={() => setShowTestDialog(true)}>
        Test
      </Button>
    );
  }
  ```
- Add a test dialog state: `const [showTestDialog, setShowTestDialog] = useState(false);`
- Render a dialog containing `<TTSPreview provider={config.serviceType} serviceInstanceId={instance.id} allowVoiceOverride />`

  3.3. Run `pnpm build --filter=@agent-platform/studio` to verify compilation

**Files Touched**:

- `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx` — add import + render TTSPreview
- `apps/studio/src/components/admin/VoiceServicesPage.tsx` — add Test button + dialog + TTSPreview

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 type errors
- [ ] TTSPreview appears in channel config when a TTS provider is selected
- [ ] "Test" button appears on configured TTS provider cards in Voice Services
- [ ] Test dialog opens and shows TTSPreview with `allowVoiceOverride`

**Test Strategy**:

- Manual: Start dev server, navigate to both surfaces, verify component appears
- Browser: Play button triggers API call, audio plays, latency displays

**Rollback**: Revert the 2 modified files

---

### Phase 4: Tests

**Goal**: Write integration and unit tests per the test spec.

**Tasks**:

4.1. Create `apps/runtime/src/__tests__/routes/tts-preview.test.ts`:

- Integration tests for the runtime endpoint (INT-1 through INT-11 from test spec)
- Start real Express app on random port with full middleware chain (auth, rate limit)
- Use DI for external providers: inject stub ElevenLabsService and Groq fetch mock
- Test: Zod validation (empty text, over 500 chars, missing fields), provider dispatch (ElevenLabs → MP3, Orpheus → WAV), credential resolution, rate limiting, unsupported provider, provider error handling, response headers

  4.2. Create `apps/studio/src/__tests__/components/voice/TTSPreview.test.tsx`:

- Unit tests for the TTSPreview component (UT-1 through UT-9 from test spec)
- Test: renders with default text, play triggers API call, loading state, latency display, error state, character counter, voice override toggle, object URL cleanup

  4.3. Run `pnpm test --filter=@agent-platform/runtime` and `pnpm test --filter=@agent-platform/studio` to verify all tests pass

**Files Touched**:

- `apps/runtime/src/__tests__/routes/tts-preview.test.ts` — NEW
- `apps/studio/src/__tests__/components/voice/TTSPreview.test.tsx` — NEW

**Exit Criteria**:

- [ ] All integration tests pass: `pnpm test --filter=@agent-platform/runtime -- --grep tts-preview`
- [ ] All unit tests pass: `pnpm test --filter=@agent-platform/studio -- --grep TTSPreview`
- [ ] No regressions: `pnpm build && pnpm test` passes across the monorepo
- [ ] Integration tests cover: validation, both providers, credential resolution, rate limiting, error responses
- [ ] Unit tests cover: rendering, state transitions, cleanup

**Test Strategy**:

- Integration: Real Express server, real auth context injection, DI-stubbed external providers
- Unit: React Testing Library for component behavior

**Rollback**: Delete the 2 test files

---

## 4. Wiring Checklist

- [ ] `tts-preview.ts` route imported in `server.ts` (Phase 1, task 1.2)
- [ ] `app.use('/api/v1/voice/tts-preview', ttsPreviewRouter)` registered after custom-tts route (Phase 1, task 1.2)
- [ ] `TTSPreview` component imported in `ConfigurationTab.tsx` (Phase 3, task 3.1)
- [ ] `TTSPreview` component rendered inside VoiceFields Speech Synthesis block (Phase 3, task 3.1)
- [ ] `TTSPreview` component imported in `VoiceServicesPage.tsx` (Phase 3, task 3.2)
- [ ] Test button and dialog rendered in ServiceCard (Phase 3, task 3.2)
- [ ] `synthesizeTTSPreview` function exported from `api/tts-preview.ts` (Phase 2, task 2.1)
- [ ] API client called by TTSPreview component (Phase 2, task 2.2)

---

## 5. Cross-Phase Concerns

### Database Migrations

None — no schema changes.

### Feature Flags

None — preview UI is naturally hidden when no TTS service instance is configured.

### Configuration Changes

| Variable                 | Default | Location       | Added In |
| ------------------------ | ------- | -------------- | -------- |
| `TTS_PREVIEW_RATE_LIMIT` | `5`     | Runtime `.env` | Phase 1  |
| `TTS_PREVIEW_MAX_CHARS`  | `500`   | Runtime `.env` | Phase 1  |

Both are optional — the code uses `parseInt(process.env.TTS_PREVIEW_RATE_LIMIT, 10) || 5` pattern.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] `POST /api/v1/voice/tts-preview` returns audio for ElevenLabs provider
- [ ] `POST /api/v1/voice/tts-preview` returns audio for Orpheus provider
- [ ] Unauthenticated requests return 401
- [ ] Cross-tenant requests return 404
- [ ] 6th request in a minute returns 429
- [ ] Invalid request body returns 400 with Zod details
- [ ] Provider API failures return 502 with structured error
- [ ] TTSPreview component renders in channel config Speech Synthesis section
- [ ] TTSPreview component renders in admin Voice Services Test dialog
- [ ] Audio plays in browser after clicking Play
- [ ] Synthesis latency is displayed after playback
- [ ] Voice override works in admin surface
- [ ] All integration tests pass
- [ ] All unit tests pass
- [ ] `pnpm build` succeeds across the monorepo
- [ ] No regressions in existing test suite

---

## 7. Open Questions

1. The `resolveServiceCredentials` method on `VoiceServiceFactory` is in the "PRIVATE" comment section but lacks the TypeScript `private` keyword — it's currently callable from external code. Should we add a public wrapper method, or is the current accessibility sufficient? Decision: use it as-is; the Orpheus resolver already does this.

2. Should the `TTS_PREVIEW_RATE_LIMIT` env var be read once at startup (module-level `const`) or on each request? Decision: module-level `const` — same pattern as other rate limit configs. Change requires restart.

3. For the admin "Test" dialog, should the voice override be a free-text input or a dropdown fetching voices from the provider API? Decision: free-text input for now. Fetching voice lists requires additional API calls and a new endpoint — tracked as a future enhancement.
