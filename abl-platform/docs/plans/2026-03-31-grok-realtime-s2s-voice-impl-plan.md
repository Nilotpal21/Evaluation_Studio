# LLD: Grok Realtime S2S Voice Integration

**Feature Spec**: `docs/features/sub-features/grok-realtime-s2s-voice.md`
**HLD**: `docs/specs/grok-realtime-s2s-voice.hld.md`
**Test Spec**: `docs/testing/sub-features/grok-realtime-s2s-voice.md`
**Status**: DRAFT
**Date**: 2026-03-31

---

## 1. Design Decisions

### Dual-Path Architecture

**IMPORTANT**: This feature supports TWO integration paths:

1. **Web/SDK Path**: GrokRealtimeSession → WebSocket → Grok API (direct)
2. **Telephony Path**: Runtime → KoreVG → Jambonz TaskLlmGrok_S2S → Grok API (indirect via Jambonz)

The decisions below address implementation for BOTH paths.

### Decision Log

| #   | Decision                                                                                                      | Rationale                                                                                                                                                                                                                                                                                    | Alternatives Rejected                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D-1 | Follow OpenAI adapter structure exactly (for web/SDK path) with Grok-specific event handling                  | User explicitly requested "following openai s2s realtime implementation as it is perfectly working". Proven pattern reduces risk. Web/SDK path requires direct WebSocket management by GrokRealtimeSession. Telephony path uses Jambonz (see D-2).                                           | Creating abstracted base class (premature abstraction), waiting for xAI SDK (blocks timeline) |
| D-2 | Separate `buildGrokLlmVerbPayload()` for telephony path (Jambonz integration)                                 | Jambonz TaskLlmGrok_S2S shows critical differences: session.update BEFORE response.create, different event types (response.function_call_arguments.done vs response.function_call_arguments.delta). Telephony path goes THROUGH Jambonz, not direct to Grok — Jambonz manages the WebSocket. | Extending existing function with conditional logic (increases complexity, error-prone)        |
| D-3 | Feature flag `FEATURE_GROK_VOICE_ENABLED` default true from day 1                                             | Additive feature, tenant opt-in via credential configuration provides natural rollout control. Fast rollback via flag=false.                                                                                                                                                                 | Default false beta flag (delays adoption, requires manual enablement per tenant)              |
| D-4 | No protocol translation layer in phase 1                                                                      | Assume OpenAI compatibility initially per HLD OQ-1. Jambonz already has working Grok implementation suggesting compatibility. Add translation incrementally if testing reveals protocol differences.                                                                                         | Building translation layer upfront (over-engineering without evidence of need)                |
| D-5 | Audio format fail-fast (no transcoding)                                                                       | <600ms p95 latency budget cannot accommodate transcoding overhead. Industry standard: all realtime voice APIs support PCM16.                                                                                                                                                                 | Building transcoding layer (adds latency, complexity, CPU load)                               |
| D-6 | 4-phase implementation: Core Adapter → Credentials & Studio UI → KoreVG Integration → Testing & Observability | Each phase independently deployable. Core adapter must work before credentials, credentials before UI, Studio/KoreVG can proceed in parallel after phase 1.                                                                                                                                  | Single mega-phase (unrevertable, untestable), 6+ micro-phases (coordination overhead)         |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/llm/realtime/grok-realtime.ts
import type {
  RealtimeVoiceSession,
  RealtimeSessionConfig,
  RealtimeConnectionState,
  RealtimeProviderType,
} from './types.js';

export class GrokRealtimeSession implements RealtimeVoiceSession {
  readonly providerType: RealtimeProviderType = 'grok_realtime';
  private ws: WebSocket | null = null;
  private _connectionState: RealtimeConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private config: RealtimeSessionConfig | null = null;

  async connect(config: RealtimeSessionConfig): Promise<void>;
  disconnect(): void;
  sendAudio(audio: Buffer): void;
  submitToolResult(callId: string, result: string): void;
  updateSystemPrompt(prompt: string): void;
  updateTools(tools: any[]): void;
  get connectionState(): RealtimeConnectionState;

  // Grok-specific: session.update BEFORE response.create
  private async sendSessionUpdate(): Promise<void>;
  private async sendResponseCreate(): Promise<void>;
}

// apps/runtime/src/services/voice/korevg/grok-llm-payload.ts
import type {
  RealtimeLlmToolDefinition,
  RealtimeLlmVerbPayload,
  S2SSessionConfig,
} from '../s2s/types.js';

export function buildGrokLlmVerbPayload(params: {
  apiKey: string;
  instructions: string;
  s2sConfig: S2SSessionConfig;
  tools: RealtimeLlmToolDefinition[];
}): RealtimeLlmVerbPayload;

// apps/runtime/src/services/voice/s2s/types.ts (MODIFIED)
export type S2SProviderType =
  | 's2s:openai'
  | 's2s:google'
  | 's2s:elevenlabs'
  | 's2s:deepgram'
  | 's2s:ultravox'
  | 's2s:grok'; // NEW

// packages/compiler/src/platform/llm/realtime/types.ts (MODIFIED)
export type RealtimeProviderType = 'openai_realtime' | 'gemini_live' | 'ultravox' | 'grok_realtime'; // NEW

// apps/studio/src/api/voice-services.ts (MODIFIED)
export type S2SProvider =
  | 's2s:openai'
  | 's2s:google'
  | 's2s:elevenlabs'
  | 's2s:deepgram'
  | 's2s:ultravox'
  | 's2s:grok'; // NEW
```

### Module Boundaries

| Module                                      | Responsibility                                                                          | Depends On                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GrokRealtimeSession`                       | WebSocket lifecycle, event handlers, audio streaming, tool calling for web/SDK sessions | ws (npm), RealtimeVoiceSession interface, TraceStore  |
| `buildGrokLlmVerbPayload`                   | Generate KoreVG llm verb payload with Grok-specific session initialization order        | S2SSessionConfig, RealtimeLlmToolDefinition types     |
| `VoiceServiceFactory.resolveS2SCredentials` | Resolve 's2s:grok' credentials from TenantServiceInstance with Redis caching            | TenantServiceInstance model, EncryptionService, Redis |
| `GrokS2SFields` (Studio)                    | Grok-specific S2S configuration UI (API key, model, voice, temperature)                 | S2SConfigFields router, voice-services API client     |
| `VoiceServicesPage` (Studio)                | Voice provider card UI for Grok credential CRUD                                         | TenantServiceInstance API, GrokS2SFields component    |

---

## 2. File-Level Change Map

### New Files

| File                                                                          | Purpose                                                               | LOC Estimate                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`                | GrokRealtimeSession class implementing RealtimeVoiceSession interface | 450-500 lines (similar to openai-realtime.ts)          |
| `apps/runtime/src/services/voice/korevg/grok-llm-payload.ts`                  | buildGrokLlmVerbPayload function for KoreVG llm verb generation       | 120-150 lines (similar to buildRealtimeLlmVerbPayload) |
| `apps/studio/src/components/deployments/channels/GrokS2SFields.tsx`           | Grok S2S configuration form fields (API key, model, voice)            | 180-220 lines (similar to OpenAIS2SFields.tsx)         |
| `packages/compiler/src/platform/llm/realtime/__tests__/grok-realtime.test.ts` | Unit tests for GrokRealtimeSession contract compliance                | 350-400 lines                                          |
| `apps/runtime/src/__tests__/channels/grok-voice-integration.test.ts`          | Integration tests for credential resolution, encryption, caching      | 280-320 lines                                          |
| `apps/runtime/src/__tests__/korevg/grok-s2s-integration.test.ts`              | Integration tests for KoreVG S2S payload generation                   | 220-260 lines                                          |
| `apps/runtime/src/__tests__/e2e/grok-voice-e2e.test.ts`                       | E2E tests for complete voice session lifecycle                        | 400-450 lines                                          |
| `apps/studio/src/__tests__/admin/voice-services-grok.test.tsx`                | Studio UI integration tests for Grok card CRUD                        | 200-240 lines                                          |

**Total New LOC**: ~2,200-2,550 lines (7 implementation files + 4 test files)

### Modified Files

| File                                                                      | Change Description                                                                                                    | Risk                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/compiler/src/platform/llm/realtime/index.ts`                    | Add `export { GrokRealtimeSession }` and `registerRealtimeProvider('grok_realtime', () => new GrokRealtimeSession())` | **Low** - Follows existing pattern, additive only            |
| `apps/runtime/src/services/voice/s2s/types.ts`                            | Add `'s2s:grok'` to S2SProviderType union type                                                                        | **Low** - Type-only change, no runtime impact                |
| `apps/runtime/src/services/voice/voice-service-factory.ts`                | Add case `'s2s:grok'` to `resolveS2SCredentials()` switch statement, handle credential resolution                     | **Low** - Follows existing provider pattern                  |
| `apps/runtime/src/services/voice/voice-session-resolver.ts`               | Import and use `buildGrokLlmVerbPayload` when provider is 's2s:grok'                                                  | **Low** - Conditional logic, no impact on existing providers |
| `apps/studio/src/components/admin/VoiceServicesPage.tsx`                  | Add Grok card to `SERVICE_CARDS` array (lines 76-323) with fields: API Key, Model, Voice                              | **Low** - Additive UI change                                 |
| `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` | Add `'s2s:grok': 'xAI Grok Realtime'` to PROVIDER_LABELS (line 21)                                                    | **Low** - Additive UI label                                  |
| `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`     | Add case `'s2s:grok'` to route to `<GrokS2SFields />` component (line 22)                                             | **Low** - Router addition                                    |
| `apps/studio/src/api/voice-services.ts`                                   | Add `'s2s:grok'` to S2SProvider type union (line 14)                                                                  | **Low** - Type-only change                                   |
| `packages/compiler/src/platform/llm/realtime/types.ts`                    | Add `'grok_realtime'` to RealtimeProviderType union type                                                              | **Low** - Type-only change                                   |

**Total Modified Files**: 9 files
**Total Modifications LOC**: ~120-150 lines added (mostly additive, minimal changes to existing logic)

### Deleted Files

None. This is a purely additive feature.

---

## 3. Implementation Phases

CRITICAL: Each phase must be independently deployable and testable.
No phase should leave the system in a broken state.

### Phase 1: Core Adapter & Provider Registration (Web/SDK Path) (3-4 days)

**Goal**: Implement GrokRealtimeSession adapter and register it as a realtime voice provider (direct path: GrokRealtimeSession → WebSocket → Grok API)

**Tasks**:

1.1. Create `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`

- Copy `openai-realtime.ts` structure as baseline
- Update endpoint to `wss://api.x.ai/v1/realtime`
- Update auth header from `'OpenAI-Beta': 'realtime=v1'` to Grok-specific header (TBD - check xAI API docs)
- Implement Grok-specific event handlers:
  - `response.output_audio_transcript.delta` (vs OpenAI's `response.audio_transcript.delta`)
  - `response.function_call_arguments.done` (vs OpenAI's `response.function_call_arguments.delta`)
- **CRITICAL**: Implement session initialization order:
  ```typescript
  // Grok requires session.update BEFORE response.create
  async connect(config: RealtimeSessionConfig): Promise<void> {
    // ... WebSocket connection setup ...
    await this.sendSessionUpdate(); // MUST be first
    await this.sendResponseCreate(); // Then trigger initial greeting
  }
  ```
- Set `providerType = 'grok_realtime'`
- Implement reconnection with exponential backoff (1s, 2s, 4s, max 3 retries)
- Implement error classification (network, auth, rate limit, protocol)
- Add usage tracking (tokens, audio duration)

  1.2. Update `packages/compiler/src/platform/llm/realtime/types.ts`

- Add `'grok_realtime'` to RealtimeProviderType union

  1.3. Update `packages/compiler/src/platform/llm/realtime/index.ts`

- Add `export { GrokRealtimeSession } from './grok-realtime.js';`
- Add `registerRealtimeProvider('grok_realtime', () => new GrokRealtimeSession());`

  1.4. Create unit tests `packages/compiler/src/platform/llm/realtime/__tests__/grok-realtime.test.ts`

- Test RealtimeVoiceSession contract compliance (all 6 methods)
- Test connection lifecycle (disconnected → connecting → connected → disconnected)
- Test audio streaming (sendAudio with Buffer)
- Test tool result submission (submitToolResult with callId + result)
- Test session updates (updateSystemPrompt, updateTools)
- Test reconnection logic (3 retries with exponential backoff)
- Test error handling (network, auth, rate limit, protocol errors)
- Test event handlers (Grok-specific event types)
- **CRITICAL**: Test session initialization order (session.update before response.create)

  1.5. Run unit tests and verify 90%+ coverage

- `pnpm test --filter=@abl/compiler -- grok-realtime.test.ts`
- Check coverage report: `pnpm test:coverage --filter=@abl/compiler`

  1.6. Build and verify no TypeScript errors

- `pnpm build --filter=@abl/compiler`
- `pnpm typecheck --filter=@abl/compiler`

  1.7. Add feature flag to `packages/config/src/feature-flags.ts`

- `FEATURE_GROK_VOICE_ENABLED: process.env.FEATURE_GROK_VOICE_ENABLED !== 'false'`
- Default: true

**Files Touched**:

- NEW: `packages/compiler/src/platform/llm/realtime/grok-realtime.ts`
- MODIFIED: `packages/compiler/src/platform/llm/realtime/types.ts` (add 'grok_realtime' to union)
- MODIFIED: `packages/compiler/src/platform/llm/realtime/index.ts` (export + register)
- NEW: `packages/compiler/src/platform/llm/realtime/__tests__/grok-realtime.test.ts`
- MODIFIED: `packages/config/src/feature-flags.ts` (add FEATURE_GROK_VOICE_ENABLED)

**Exit Criteria**:

- [ ] `GrokRealtimeSession` class implements all 6 methods of `RealtimeVoiceSession` interface
- [ ] TypeScript compilation succeeds: `pnpm build --filter=@abl/compiler` exits 0
- [ ] Unit tests pass: `pnpm test --filter=@abl/compiler -- grok-realtime.test.ts` exits 0
- [ ] Unit test coverage ≥90% for `grok-realtime.ts`
- [ ] Provider registered: `import { getRealtimeProvider } from '@abl/compiler/platform/llm/realtime'; const provider = getRealtimeProvider('grok_realtime');` succeeds
- [ ] Session initialization order verified: test confirms session.update sent before response.create
- [ ] No regressions: `pnpm test --filter=@abl/compiler` exits 0 (all existing tests still pass)

**Test Strategy**:

- **Unit**: Mock WebSocket, test contract compliance, test Grok-specific event handling, test session initialization order
- **Integration**: None in this phase (no credential resolution yet)

**Rollback**:

- Revert commit removing `grok-realtime.ts`, registration, and type additions
- OR set `FEATURE_GROK_VOICE_ENABLED=false` (if provider check gates usage)

---

### Phase 2: Credentials Management & Studio UI (3-4 days)

**Goal**: Enable tenants to configure Grok credentials via Studio and resolve credentials at runtime

**Tasks**:

2.1. Update `apps/runtime/src/services/voice/s2s/types.ts`

- Add `'s2s:grok'` to S2SProviderType union

  2.2. Update `apps/runtime/src/services/voice/voice-service-factory.ts`

- Add case `'s2s:grok'` to `resolveS2SCredentials()` method:
  ```typescript
  async resolveS2SCredentials(tenantId: string, provider: S2SProviderType): Promise<...> {
    // ... existing code ...
    if (provider === 's2s:grok') {
      const creds = await this.resolveAndDecrypt(tenantId, 's2s:grok');
      if (!creds) {
        log.warn('Failed to resolve Grok S2S credentials', { tenantId });
        return null;
      }
      return {
        credentials: {
          apiKey: creds.apiKey,
          config: creds.config, // model, voice, temperature
        },
      };
    }
    // ... existing cases ...
  }
  ```
- Verify Redis caching works (key: `${tenantId}:s2s:grok`, TTL: 10 minutes)
- **Circuit breaker**: Cache null result on decryption failure (TTL: 60 seconds) to prevent repeated failures from hammering encryption service
- Verify cache invalidation on credential update/delete

  2.3. Update `apps/runtime/src/routes/tenant-service-instances.ts`

- Verify 's2s:grok' is accepted by Zod schema validation (should already work if schema uses `z.string()` for serviceType)
- Add validation for Grok credential structure:

  ```typescript
  const GrokCredentialsSchema = z.object({
    apiKey: z.string().min(1),
    organizationId: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  });
  ```

  2.4. Create `apps/studio/src/components/deployments/channels/GrokS2SFields.tsx`

- Mirror `OpenAIS2SFields.tsx` structure
- Fields:
  - API Key (password input, masked)
  - Organization ID (text input, optional)
  - Model (select dropdown: 'grok-2-1212', 'grok-beta', default: 'grok-2-1212')
  - Voice (select dropdown: TBD - check xAI API docs, default: 'alloy')
  - Temperature (slider 0-2, default: 1.0)
  - Turn Detection (toggle + threshold slider, default: enabled, 0.5 threshold)
- Validation: API Key required, others optional
- Save to TenantServiceInstance via POST `/api/tenants/{tenantId}/service-instances`

  2.5. Update `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`

- Add case `'s2s:grok'` at line 22:

  ```tsx
  case 's2s:grok':
    return <GrokS2SFields provider={provider} projectId={projectId} {...restProps} />;
  ```

  2.6. Update `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx`

- Add label at line 21:

  ```tsx
  const PROVIDER_LABELS = {
    // ... existing labels ...
    's2s:grok': 'xAI Grok Realtime',
  };
  ```

  2.7. Update `apps/studio/src/components/admin/VoiceServicesPage.tsx`

- Add Grok card to SERVICE_CARDS array (lines 76-323):

  ```tsx
  {
    id: 's2s:grok',
    name: 'xAI Grok',
    description: 'Realtime speech-to-speech with Grok models',
    icon: <GrokIcon />, // or generic microphone icon
    status: 'available',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true },
      { name: 'organizationId', label: 'Organization ID', type: 'text', required: false },
      { name: 'model', label: 'Model', type: 'select', options: ['grok-2-1212', 'grok-beta'], required: false },
      { name: 'voice', label: 'Voice', type: 'select', options: ['alloy', 'echo', 'shimmer'], required: false },
    ],
  }
  ```

  2.8. Update `apps/studio/src/api/voice-services.ts`

- Add `'s2s:grok'` to S2SProvider type union at line 14

  2.9. Create integration tests `apps/runtime/src/__tests__/channels/grok-voice-integration.test.ts`

- Test credential resolution via VoiceServiceFactory
- Test Redis caching (hit rate, TTL)
- Test cache invalidation on update/delete
- Test encryption at rest (verify MongoDB stores encrypted, decrypt succeeds)
- Test missing credentials return null
- Test decryption failure returns null
- Test cross-tenant credential access returns null (isolation)

  2.10. Create Studio UI tests `apps/studio/src/__tests__/admin/voice-services-grok.test.tsx`

- Test Grok card renders in VoiceServicesPage
- Test open dialog, form fields present
- Test validation (API Key required)
- Test submit creates TenantServiceInstance
- Test edit updates credentials
- Test delete removes credentials
- Test API key masking (not shown in plaintext after save)

  2.11. Run tests and verify

- `pnpm test --filter=@abl/runtime -- grok-voice-integration.test.ts`
- `pnpm test --filter=@abl/studio -- voice-services-grok.test.tsx`

  2.12. Build and verify no TypeScript errors

- `pnpm build --filter=@abl/runtime`
- `pnpm build --filter=@abl/studio`

**Files Touched**:

- MODIFIED: `apps/runtime/src/services/voice/s2s/types.ts` (add 's2s:grok' to union)
- MODIFIED: `apps/runtime/src/services/voice/voice-service-factory.ts` (add case 's2s:grok')
- MODIFIED: `apps/runtime/src/routes/tenant-service-instances.ts` (add Grok credential validation)
- NEW: `apps/studio/src/components/deployments/channels/GrokS2SFields.tsx`
- MODIFIED: `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx` (add case)
- MODIFIED: `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx` (add label)
- MODIFIED: `apps/studio/src/components/admin/VoiceServicesPage.tsx` (add Grok card)
- MODIFIED: `apps/studio/src/api/voice-services.ts` (add type)
- NEW: `apps/runtime/src/__tests__/channels/grok-voice-integration.test.ts`
- NEW: `apps/studio/src/__tests__/admin/voice-services-grok.test.tsx`

**Exit Criteria**:

- [ ] Studio UI renders Grok card in Voice Services page
- [ ] Grok credential CRUD works via Studio UI (create, read, update, delete)
- [ ] API key encrypted in MongoDB: query `db.tenant_service_instances.findOne({serviceType: 's2s:grok'})` shows encrypted `credentials` field
- [ ] VoiceServiceFactory.resolveS2SCredentials('tenant123', 's2s:grok') returns decrypted credentials
- [ ] Redis cache hit rate >95% for repeated calls (10min TTL)
- [ ] Integration tests pass: `pnpm test --filter=@abl/runtime -- grok-voice-integration.test.ts` exits 0
- [ ] Studio UI tests pass: `pnpm test --filter=@abl/studio -- voice-services-grok.test.tsx` exits 0
- [ ] Cross-tenant isolation: tenant A cannot access tenant B's Grok credentials (test returns null)
- [ ] TypeScript compilation succeeds for runtime and studio
- [ ] No regressions: all existing tests pass

**Test Strategy**:

- **Unit**: Credential schema validation, encryption/decryption helpers
- **Integration**: VoiceServiceFactory ↔ TenantServiceInstance ↔ Redis, Studio UI ↔ API endpoints

**Rollback**:

- Revert commit removing Studio UI components and credential resolution logic
- Delete any test Grok credentials via Studio UI or MongoDB shell
- Redis cache entries expire after 10 minutes automatically

---

### Phase 3: KoreVG Integration (Telephony Path via Jambonz) (2-3 days)

**Goal**: Enable Grok S2S for KoreVG telephony voice sessions (indirect path: Runtime → KoreVG → Jambonz TaskLlmGrok_S2S → Grok API)

**Tasks**:

3.1. Create `apps/runtime/src/services/voice/korevg/grok-llm-payload.ts`

- Implement `buildGrokLlmVerbPayload()` function following `buildRealtimeLlmVerbPayload()` structure
- **CRITICAL**: Use Grok-specific llmOptions structure:

  ```typescript
  export function buildGrokLlmVerbPayload({
    apiKey,
    instructions,
    s2sConfig,
    tools,
  }: {
    apiKey: string;
    instructions: string;
    s2sConfig: S2SSessionConfig;
    tools: RealtimeLlmToolDefinition[];
  }): RealtimeLlmVerbPayload {
    return {
      verb: 'llm',
      vendor: 'grok', // Routes to TaskLlmGrok_S2S in Jambonz
      model: (s2sConfig.model as string) || 'grok-2-1212',
      auth: { apiKey },
      eventHook: '/llm-event',
      toolHook: tools.length > 0 ? '/llm-tool' : undefined,
      events: [
        'session.updated',
        'response.done',
        'response.output_audio_transcript.delta', // Grok-specific
        'response.function_call_arguments.done', // Grok-specific
        'error',
      ],
      llmOptions: {
        // CRITICAL: session_update MUST be populated for Grok
        // Jambonz TaskLlmGrok_S2S sends session.update BEFORE response.create
        session_update: {
          instructions,
          voice: s2sConfig.voice || 'alloy',
          temperature: s2sConfig.temperature ?? 1.0,
          modalities: ['text', 'audio'],
          turn_detection: s2sConfig.turnDetection ?? {
            type: 'server_vad',
            threshold: 0.5,
            silence_duration_ms: 500,
          },
          tools:
            tools.length > 0
              ? tools.map((t) => ({
                  type: 'function',
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                }))
              : undefined,
        },
        // response_create triggers initial greeting AFTER session configured
        response_create: {
          modalities: ['text', 'audio'],
          instructions,
        },
      },
    };
  }
  ```

  3.2. Update `apps/runtime/src/services/voice/voice-session-resolver.ts`

- Add import: `import { buildGrokLlmVerbPayload } from './korevg/grok-llm-payload.js';`
- Add case for 's2s:grok' when building llm verb payload:

  ```typescript
  if (s2sProvider === 's2s:grok') {
    const payload = buildGrokLlmVerbPayload({
      apiKey: credentials.apiKey,
      instructions: systemPrompt,
      s2sConfig: voiceConfig.s2sConfig,
      tools: realtimeTools,
    });
    return payload;
  }
  ```

  3.3. Update `apps/runtime/src/services/voice/korevg/korevg-session.ts`

- Verify handleLlmEvent() processes Grok-specific events:
  - `response.output_audio_transcript.delta` (vs OpenAI's `response.audio_transcript.delta`)
  - `response.function_call_arguments.done` (vs OpenAI's `response.function_call_arguments.delta`)
- Add Grok event mappings if needed (or verify generic event handling covers Grok events)

  3.4. Create integration tests `apps/runtime/src/__tests__/korevg/grok-s2s-integration.test.ts`

- Test buildGrokLlmVerbPayload generates correct structure
- Test vendor: 'grok' routes to Jambonz TaskLlmGrok_S2S
- Test llmOptions.session_update populated (CRITICAL for Grok)
- Test llmOptions.response_create present
- Test events array includes Grok-specific event types
- Test tool format conversion (ABL → Grok function schema)
- Test voice config overrides (model, voice, temperature)
- Test empty tools array omits toolHook

  3.5. Run integration tests

- `pnpm test --filter=@abl/runtime -- grok-s2s-integration.test.ts`

  3.6. Build and verify no TypeScript errors

- `pnpm build --filter=@abl/runtime`

**Files Touched**:

- NEW: `apps/runtime/src/services/voice/korevg/grok-llm-payload.ts`
- MODIFIED: `apps/runtime/src/services/voice/voice-session-resolver.ts` (add case 's2s:grok')
- MODIFIED: `apps/runtime/src/services/voice/korevg/korevg-session.ts` (verify Grok event handling)
- NEW: `apps/runtime/src/__tests__/korevg/grok-s2s-integration.test.ts`

**Exit Criteria**:

- [ ] `buildGrokLlmVerbPayload()` function exists and exports correctly
- [ ] llm verb payload includes vendor: 'grok'
- [ ] llm verb payload includes llmOptions.session_update (required for Grok)
- [ ] llm verb payload includes llmOptions.response_create
- [ ] llm verb payload includes Grok-specific events (response.output_audio_transcript.delta, response.function_call_arguments.done)
- [ ] Integration tests pass: `pnpm test --filter=@abl/runtime -- grok-s2s-integration.test.ts` exits 0
- [ ] TypeScript compilation succeeds: `pnpm build --filter=@abl/runtime` exits 0
- [ ] Manual KoreVG test (if KoreVG available): POST `/api/runtime/voice/korevg/session` with 's2s:grok' provider creates session and connects to Grok API
- [ ] No regressions: all existing voice tests pass

**Test Strategy**:

- **Unit**: buildGrokLlmVerbPayload output structure
- **Integration**: voice-session-resolver → buildGrokLlmVerbPayload → KoreVG llm verb

**Rollback**:

- Revert commit removing grok-llm-payload.ts and voice-session-resolver changes
- KoreVG sessions fall back to previous providers (OpenAI, Google, etc.)

---

### Phase 4: Testing & Observability (3-4 days)

**Goal**: Comprehensive E2E tests, trace event validation, observability integration

**Tasks**:

4.1. Create E2E test `apps/runtime/src/__tests__/e2e/grok-voice-e2e.test.ts`

- **E2E-1: Complete Voice Session Lifecycle**
  - Seed: Create tenant, project, Grok credentials (via POST `/api/tenants/{tenantId}/service-instances`)
  - POST `/api/projects/{projectId}/channels` - create voice channel with 's2s:grok'
  - POST `/api/runtime/voice/session` - start voice session
  - WebSocket connect - send audio frames (PCM16)
  - Assert: WebSocket receives audio responses
  - Assert: Tool call event received → execute tool → submit result
  - Disconnect WebSocket
  - GET `/api/runtime/sessions/{sessionId}/traces` - verify trace events (session_start, turn_complete, session_end)
  - GET `/api/analytics/sessions/{sessionId}` - verify voice quality metrics (MOS, jitter, packet loss)
  - Assert: Cross-tenant access returns 404 (GET with different tenantId)
- **E2E-2: KoreVG Telephony Session** (if KoreVG available)
  - Seed: Tenant, project, Grok credentials
  - POST KoreVG webhook endpoint - simulate incoming call
  - Assert: llm verb payload sent to KoreVG with vendor: 'grok'
  - Assert: session.update sent before response.create (check KoreVG logs or trace events)
  - Assert: Audio streaming works (RTCP packets via rtpengine)
  - Assert: Tool call executed (via /llm-tool webhook)
  - Assert: Homer metrics captured (MOS >3.5 target)
- **E2E-4: Reconnection and Error Handling**
  - Start voice session
  - Simulate network disconnect (close WebSocket from client)
  - Assert: GrokRealtimeSession attempts reconnection (3 retries, exponential backoff)
  - Assert: Trace events emitted for disconnect + reconnect attempts
  - Assert: After 3 failed retries, session ends with error disposition
- **E2E-5: Multi-Tenant Concurrent Sessions**
  - Create 3 tenants, each with Grok credentials
  - Start 10 concurrent sessions per tenant (30 total)
  - Assert: No credential leakage (each session uses correct tenant credentials)
  - Assert: Cache segregation (tenant A sessions don't hit tenant B cache)
  - Assert: Trace events isolated by tenantId
- **E2E-6: Tool Calling Integration**
  - Seed: Tenant, project, Grok credentials, agent with tool definitions
  - Start voice session
  - Send audio that triggers tool call (e.g., "What's the weather in San Francisco?")
  - Assert: WebSocket receives function_call event with tool name and arguments
  - Execute tool via ABL ToolExecutor
  - Submit tool result via `submitToolResult(callId, result)`
  - Assert: WebSocket receives response with tool result incorporated
  - Assert: Trace events include llmToolCall with function name, call_id, execution time
- **E2E-7: Provider Selection in Voice Mode Resolver**
  - Seed: Tenant with Grok credentials, project with deployment config: voice mode 'realtime'
  - POST `/api/runtime/voice/session` with deploymentId
  - Assert: Voice mode resolver selects providerType: 'grok_realtime'
  - Assert: RealtimeVoiceExecutor created with GrokRealtimeSession instance
  - Test graceful fallback: Remove Grok credentials, start session again
  - Assert: Voice mode resolver falls back to pipeline mode OR returns error with clear message
  - Assert: No session created with missing credentials

    4.2. Create trace event tests `apps/runtime/src/__tests__/observability/grok-voice-trace.test.ts`

- Test session_start event includes provider: 'grok_realtime'
- Test turn_complete event includes audio duration, token counts
- Test session_end event includes final token counts, session outcome
- Test tool call events include function name, arguments, execution time
- Test error events include error classification (network, auth, rate limit, protocol)
- Test ClickHouse write buffering (events written within 5 seconds)

  4.3. Add trace event emission to `GrokRealtimeSession`

- On connect: emit `voiceConnectionStateChange` with state: 'connected', provider: 'grok_realtime'
- On audio received: emit `voiceAudioReceived` with audio duration
- On tool call: emit `llmToolCall` with function name, call_id
- On error: emit `voiceError` with error code, message, classification
- On disconnect: emit `voiceConnectionStateChange` with state: 'disconnected'

  4.4. Verify Homer integration (if Homer available)

- Test Grok voice sessions write to Homer (hep_proto_5_default for RTCP)
- Test MOS calculation (target: >3.5 for telephony)
- Test jitter, packet loss metrics captured
- Test Studio UI displays voice quality metrics for Grok sessions

  4.5. Add security & idempotency tests `apps/runtime/src/__tests__/security/grok-isolation.test.ts`

- Test cross-tenant credential access returns 404 (not 403)
- Test cross-project voice session access returns 404
- Test missing auth token returns 401
- Test insufficient permissions returns 403
- Test API key stored encrypted (query MongoDB, verify not plaintext)
- Test cache isolation (tenant A cannot hit tenant B cache via key manipulation)
- Test credential CRUD idempotency (POST duplicate serviceType returns 409, PATCH is idempotent)
- Test tool result submission idempotency (submit same call_id twice, Grok deduplicates)

  4.6. Add performance tests `apps/runtime/src/__tests__/performance/grok-concurrent-sessions.test.ts`

- Test 50+ concurrent sessions (test spec PERF-1)
- Test credential cache hit rate (target: 99%)
- Test audio streaming latency (p95 <600ms)
- Test ClickHouse trace write throughput (1000+ events/sec)

  4.7. Run all tests

- E2E: `pnpm test --filter=@abl/runtime -- grok-voice-e2e.test.ts`
- Trace: `pnpm test --filter=@abl/runtime -- grok-voice-trace.test.ts`
- Security: `pnpm test --filter=@abl/runtime -- grok-isolation.test.ts`
- Performance: `pnpm test --filter=@abl/runtime -- grok-concurrent-sessions.test.ts`

  4.8. Update documentation

- Update feature spec status: PLANNED → ALPHA
- Update test spec coverage matrix with actual test results
- Update HLD status: DRAFT → APPROVED
- Update LLD status: DRAFT → DONE

**Files Touched**:

- NEW: `apps/runtime/src/__tests__/e2e/grok-voice-e2e.test.ts`
- NEW: `apps/runtime/src/__tests__/observability/grok-voice-trace.test.ts`
- NEW: `apps/runtime/src/__tests__/security/grok-isolation.test.ts`
- NEW: `apps/runtime/src/__tests__/performance/grok-concurrent-sessions.test.ts`
- MODIFIED: `packages/compiler/src/platform/llm/realtime/grok-realtime.ts` (add trace event emission)
- MODIFIED: `docs/features/sub-features/grok-realtime-s2s-voice.md` (status update)
- MODIFIED: `docs/testing/sub-features/grok-realtime-s2s-voice.md` (coverage results)
- MODIFIED: `docs/specs/grok-realtime-s2s-voice.hld.md` (status update)
- MODIFIED: `docs/plans/2026-03-31-grok-realtime-s2s-voice-impl-plan.md` (status update)

**Exit Criteria**:

- [ ] E2E test E2E-1 passes (complete voice session lifecycle with trace events and analytics)
- [ ] E2E test E2E-4 passes (reconnection with exponential backoff)
- [ ] E2E test E2E-5 passes (30 concurrent sessions, no credential leakage)
- [ ] E2E test E2E-6 passes (tool calling integration with ABL ToolExecutor)
- [ ] E2E test E2E-7 passes (provider selection via voice mode resolver, graceful fallback)
- [ ] Trace events written to ClickHouse (query `SELECT * FROM traces WHERE provider = 'grok_realtime' LIMIT 10` returns results)
- [ ] Security & idempotency tests pass (10 security scenarios + 2 idempotency scenarios)
- [ ] Performance tests pass (50+ sessions, 99% cache hit rate, p95 <600ms latency)
- [ ] All test files pass: `pnpm test --filter=@abl/runtime` exits 0
- [ ] Feature spec status updated to ALPHA
- [ ] Test spec coverage matrix shows 80%+ overall coverage
- [ ] No regressions: all existing voice tests pass

**Test Strategy**:

- **E2E**: Real HTTP API, real servers (Express on random ports), real WebSocket, real MongoDB/Redis/ClickHouse
- **Integration**: Real service boundaries (VoiceServiceFactory → TenantServiceInstance, GrokRealtimeSession → TraceStore)
- **No mocks**: Only mock external xAI Grok API (via test WebSocket server)

**Rollback**:

- Revert commit removing test files and trace event emission
- Tests are additive, no impact on production code
- If trace events cause issues, disable via feature flag or remove emission code

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.
This section prevents the #1 agent failure mode: writing code that nothing calls.

- [x] New service registered in DI container / module exports
  - [x] `GrokRealtimeSession` exported from `packages/compiler/src/platform/llm/realtime/index.ts`
  - [x] `buildGrokLlmVerbPayload` exported from `apps/runtime/src/services/voice/korevg/grok-llm-payload.ts`
  - [x] `GrokS2SFields` exported from `apps/studio/src/components/deployments/channels/GrokS2SFields.tsx`

- [x] New routes registered in router file
  - N/A - No new routes (uses existing TenantServiceInstance CRUD endpoints)

- [x] New models added to `packages/database/src/models/index.ts`
  - N/A - No new models (uses existing TenantServiceInstance, VoiceSession)

- [x] New types exported from package index
  - [x] `'grok_realtime'` added to `RealtimeProviderType` in `packages/compiler/src/platform/llm/realtime/types.ts`
  - [x] `'s2s:grok'` added to `S2SProviderType` in `apps/runtime/src/services/voice/s2s/types.ts`
  - [x] `'s2s:grok'` added to `S2SProvider` in `apps/studio/src/api/voice-services.ts`

- [x] New middleware added to middleware chain
  - N/A - No new middleware

- [x] New workers registered in worker startup
  - N/A - No new workers

- [x] UI components imported and rendered in parent components
  - [x] `GrokS2SFields` imported in `S2SConfigFields.tsx` and rendered for case 's2s:grok'
  - [x] Grok card added to `SERVICE_CARDS` array in `VoiceServicesPage.tsx`
  - [x] Grok label added to `PROVIDER_LABELS` in `S2SProviderSelector.tsx`

- [x] New API endpoints documented in OpenAPI spec
  - N/A - No new endpoints (uses existing TenantServiceInstance endpoints)

- [x] Provider registered in provider registry
  - [x] `registerRealtimeProvider('grok_realtime', () => new GrokRealtimeSession())` in `packages/compiler/src/platform/llm/realtime/index.ts`

- [x] Credential resolution wired to VoiceServiceFactory
  - [x] Case 's2s:grok' added to `VoiceServiceFactory.resolveS2SCredentials()` in `voice-service-factory.ts`

- [x] KoreVG payload builder wired to voice-session-resolver
  - [x] `buildGrokLlmVerbPayload` imported and used in `voice-session-resolver.ts` for case 's2s:grok'

---

## 5. Cross-Phase Concerns

### Database Migrations

**None required.** TenantServiceInstance and VoiceSession collections already support arbitrary string values for `serviceType` and `providerType`. The feature is purely additive.

### Feature Flags

| Flag Name                    | Default Value | Purpose                                     | Rollout Plan                                                                |
| ---------------------------- | ------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `FEATURE_GROK_VOICE_ENABLED` | `true`        | Enable/disable Grok voice provider globally | Default true from day 1. Set to false for fast rollback if issues detected. |

**Environment variable**: `FEATURE_GROK_VOICE_ENABLED` (boolean, default: true)

**Usage**: Check flag before allowing 's2s:grok' provider selection in voice-session-resolver. If false, return error "Grok voice provider not available".

### Configuration Changes

**Environment Variables (new)**:

| Variable                     | Required | Default                      | Purpose                                                |
| ---------------------------- | -------- | ---------------------------- | ------------------------------------------------------ |
| `GROK_API_ENDPOINT`          | No       | `wss://api.x.ai/v1/realtime` | Grok WebSocket endpoint (for testing with mock server) |
| `FEATURE_GROK_VOICE_ENABLED` | No       | `true`                       | Feature flag to enable/disable Grok provider           |

**Runtime Config (no changes)**:

- Uses existing TenantServiceInstance credential storage
- Uses existing VoiceServiceFactory caching (Redis, 10min TTL)

**DSL/IR (no changes)**:

- Voice channel configuration already supports arbitrary `s2sProvider` string
- No IR changes needed

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 15 functional requirements (FR-1 through FR-15) from feature spec implemented and tested
- [ ] 7 E2E test scenarios passing (test spec E2E-1, E2E-2, E2E-4, E2E-5, E2E-6, E2E-7)
- [ ] 7 integration test scenarios passing (test spec INT-1 through INT-7)
- [ ] Unit test coverage ≥90% for GrokRealtimeSession adapter
- [ ] Unit test coverage ≥85% for credential resolution and Studio UI
- [ ] All test scenarios include tenant isolation checks (cross-tenant access returns 404)
- [ ] Security & idempotency tests passing (10 security scenarios + 2 idempotency scenarios)
- [ ] Performance tests passing (50+ concurrent sessions, 99% cache hit rate, p95 <600ms latency)
- [ ] No regressions in existing tests (`pnpm build && pnpm test` exits 0 for all packages)
- [ ] Studio UI renders Grok voice provider card
- [ ] Studio UI supports Grok credential CRUD (create, read, update, delete)
- [ ] Credentials encrypted at rest in MongoDB (AES-256-GCM)
- [ ] Credentials cached in Redis with 10min TTL
- [ ] Cross-tenant credential access returns 404 (not 403)
- [ ] Voice sessions emit trace events to ClickHouse (session_start, turn_complete, session_end)
- [ ] KoreVG telephony sessions work with 's2s:grok' provider (llm verb with vendor: 'grok')
- [ ] Tool calling works (function_call → ToolExecutor → result submission → Grok response)
- [ ] Reconnection works (3 retries, exponential backoff: 1s, 2s, 4s)
- [ ] Feature spec updated with implementation details (§18 Implementation Notes)
- [ ] Test spec updated with actual coverage results (§1 Coverage Matrix)
- [ ] HLD status updated to APPROVED
- [ ] LLD status updated to DONE
- [ ] All 4 implementation phases complete with exit criteria met
- [ ] Feature status: PLANNED → ALPHA (after all acceptance criteria met)

---

## 7. Open Questions

**Protocol & API (Critical - must resolve before phase 1 complete):**

1. **OQ-1: Grok API protocol compatibility** - Is the Grok realtime API 100% OpenAI-compatible, or are there protocol differences beyond event names?
   - **Impact**: If incompatible, need protocol translation layer (adds 2-3 days to phase 1)
   - **Resolution**: Test with real Grok API once available, examine xAI API documentation
   - **Mitigation**: Assume OpenAI compatibility initially, add translation layer incrementally if testing reveals differences

2. **OQ-2: Audio format support** - Does Grok support PCM16 (16kHz mono) and g.711 (μ-law/a-law)?
   - **Impact**: If unsupported, need transcoding layer or fail-fast with SERVICE_UNAVAILABLE
   - **Resolution**: Test with real Grok API, check xAI documentation
   - **Decision**: Fail-fast (no transcoding) per HLD D-5

3. **OQ-3: Tool calling format** - Does Grok use OpenAI's function_call format exactly?
   - **Impact**: If different, need schema transformation layer
   - **Resolution**: Test tool calling with real Grok API, check Jambonz TaskLlmGrok_S2S tool handling
   - **Mitigation**: Jambonz implementation suggests OpenAI compatibility

**Configuration & Credentials (High - impacts phase 2):**

4. **OQ-4: Voice selection** - Does Grok API support multiple voice options (alloy, echo, shimmer, etc.)?
   - **Impact**: Studio UI voice dropdown options, llmOptions.session_update.voice field
   - **Resolution**: Check xAI API documentation
   - **Temporary**: Default to 'alloy', make dropdown optional in phase 2

5. **OQ-5: Credential format** - Does Grok require API key only, or API key + organization ID?
   - **Impact**: Credential schema validation, Studio UI fields
   - **Resolution**: Check xAI console credential issuance format
   - **Temporary**: Support both (API key required, organization ID optional)

6. **OQ-6: Model variants** - Are there multiple Grok models for voice (grok-2-1212, grok-beta, etc.)?
   - **Impact**: Studio UI model selector dropdown options
   - **Resolution**: Check xAI API documentation
   - **Temporary**: Default to 'grok-2-1212', make selector optional

**Operational (Medium - impacts phase 4):**

7. **OQ-7: Rate limits** - What are Grok API rate limits (requests/min, tokens/min, concurrent sessions)?
   - **Impact**: Circuit breaker tuning, error handling, retry logic
   - **Resolution**: Check xAI pricing/limits documentation
   - **Mitigation**: Use conservative limits (100 req/min) until real limits known

8. **OQ-8: Session duration limit** - Is there a max session duration for Grok realtime sessions?
   - **Impact**: Session rotation logic if limit exists
   - **Resolution**: Test long-running sessions with real Grok API
   - **Mitigation**: Assume no limit initially, add rotation if testing reveals limit

9. **OQ-9: Grok API availability** - When will Grok realtime API be publicly available?
   - **Impact**: Timeline dependency for E2E testing with real API
   - **Resolution**: Monitor xAI announcements, contact xAI support
   - **Mitigation**: Use mock Grok WebSocket server for testing until real API available

10. **OQ-10: xAI API documentation** - Is there official xAI realtime API documentation?
    - **Impact**: Protocol details, authentication, event types, error codes
    - **Resolution**: Check https://docs.x.ai/ or contact xAI developer support
    - **Mitigation**: Use Jambonz TaskLlmGrok_S2S implementation as reference until official docs available

---

**End of Low-Level Design & Implementation Plan**
