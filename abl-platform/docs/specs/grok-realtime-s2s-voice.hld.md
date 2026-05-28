# HLD: Grok Realtime S2S Voice Provider

**Feature Spec**: [`docs/features/sub-features/grok-realtime-s2s-voice.md`](../features/sub-features/grok-realtime-s2s-voice.md)
**Test Spec**: [`docs/testing/sub-features/grok-realtime-s2s-voice.md`](../testing/sub-features/grok-realtime-s2s-voice.md)
**Status**: DRAFT
**Author**: Platform Engineering
**Date**: 2026-03-31

---

## 1. Problem Statement

The ABL platform currently supports three realtime voice providers (OpenAI Realtime, Gemini Live, Ultravox) for web/SDK channels and three S2S providers (s2s:openai, s2s:google, s2s:elevenlabs) for KoreVG telephony channels. Customers require provider diversity for cost optimization, resilience, and access to model-specific capabilities. xAI's Grok models offer competitive realtime voice capabilities but are not yet integrated, limiting customer choice and creating vendor lock-in risk.

Without Grok support, customers cannot leverage xAI's Grok models for voice interactions, diversify across multiple realtime voice providers, or meet procurement requirements for multi-vendor redundancy.

**Goal**: Enable Grok (xAI) as a realtime voice provider across all ABL voice channels (web SDK, WebSocket sessions, KoreVG telephony) with parity to existing OpenAI/Gemini/Ultravox support. Tenant admins can configure Grok credentials in Studio, developers can select Grok for voice-optimized agents, and end users experience seamless Grok-powered voice interactions with full observability and tenant isolation.

---

## 2. Alternatives Considered

### Dual-Path Architecture Overview

**IMPORTANT**: This feature supports TWO integration paths:

1. **Web/SDK Path (Direct WebSocket Integration)**:
   - `GrokRealtimeSession` → WebSocket → Grok API
   - Runtime manages WebSocket connection directly
   - Used for: Browser SDK, mobile SDK, direct WebSocket sessions

2. **Telephony Path (Indirect via Jambonz/KoreVG)**:
   - Runtime → KoreVG → Jambonz `TaskLlmGrok_S2S` → Grok API
   - Jambonz manages WebSocket connection to Grok API
   - Used for: SIP/telephony calls, PSTN integration

The alternatives below evaluate **how to implement the GrokRealtimeSession adapter** (web/SDK path), NOT whether to use Jambonz for telephony (telephony path is non-negotiable, KoreVG is the established telephony infrastructure).

### Option A: Follow OpenAI Adapter Pattern Exactly (Recommended)

**Description**: Implement `GrokRealtimeSession` class by copying `OpenAIRealtimeSession` structure exactly (WebSocket client, event handlers, exponential backoff reconnection). Assume OpenAI Realtime API protocol compatibility initially, add translation layer if needed after xAI publishes official documentation. For telephony, create separate `buildGrokLlmVerbPayload()` function that generates Jambonz llm verb with `vendor: 'grok'`.

**Pros**:

- Fastest time to implementation — reuse proven OpenAI pattern
- Minimal code delta — copy OpenAIRealtimeSession structure, change endpoint/headers
- User explicitly requested: "follow openai s2s realtime implementation as it is perfectly working"
- Consistent with existing Gemini/Ultravox adapters (no shared base class)
- Low risk if Grok is OpenAI-compatible (high probability given industry standards)

**Cons**:

- If Grok protocol differs significantly, requires protocol translation layer (adds complexity)
- Duplicates some boilerplate across four realtime adapters (OpenAI, Gemini, Ultravox, Grok)
- No official xAI SDK available yet to validate protocol compatibility

**Effort**: S (3-5 days for core adapter + Studio UI + tests)

### Option B: Abstracted Realtime Provider Base Class

**Description**: Extract common realtime provider logic (WebSocket lifecycle, event handler registration, reconnection, usage tracking) into `AbstractRealtimeSession` base class. Implement `GrokRealtimeSession` extending the base class with Grok-specific event handling.

**Pros**:

- Reduces code duplication across four realtime adapters
- Easier to add fifth/sixth providers in future (DRY principle)
- Enforces consistent behavior (reconnection, error handling, metrics) via base class

**Cons**:

- Premature abstraction — only three providers exist, unclear what commonalities truly are
- Refactoring risk — OpenAI/Gemini/Ultravox working in production, base class could introduce regressions
- Longer implementation timeline (4-7 days to refactor + add Grok)
- User requested "follow openai s2s realtime implementation as it is" — implies minimal deviation

**Effort**: M (5-8 days for base class refactor + Grok + tests + regression testing)

### Option C: xAI Official SDK (When Available)

**Description**: Wait for xAI to publish official Node.js SDK with realtime voice support. Use SDK instead of raw WebSocket connection.

**Pros**:

- Official support, guaranteed protocol compatibility
- SDK may handle reconnection, error handling, protocol upgrades automatically
- Lower maintenance burden (xAI maintains SDK)

**Cons**:

- **Blocking**: xAI SDK not available, no published timeline
- Customer demand exists now — cannot defer integration indefinitely
- Risk: SDK may abstract away control we need (e.g., event-level trace hooks)
- May still need wrapper to conform to `RealtimeVoiceSession` interface

**Effort**: Unknown (depends on SDK availability + 2-3 days for wrapper)

### Recommendation: **Option A (Follow OpenAI Adapter Pattern)**

**Rationale**:

- User explicitly requested following OpenAI implementation "as it is perfectly working"
- Fastest time to value (3-5 days vs 5-8 days for base class refactor)
- Low risk if Grok is OpenAI-compatible (high probability — industry standard)
- Supports BOTH integration paths:
  - **Web/SDK**: GrokRealtimeSession handles direct WebSocket to Grok API
  - **Telephony**: buildGrokLlmVerbPayload() generates Jambonz-compatible llm verb payload, Jambonz TaskLlmGrok_S2S manages Grok connection
- If protocol differs, translation layer can be added incrementally without blocking initial integration
- Consistent with existing adapter pattern (OpenAI, Gemini, Ultravox have no shared base class)
- Three data points (OpenAI, Gemini, Ultravox) insufficient to justify abstraction (premature optimization)
- Feature spec marks protocol compatibility as open question OQ-1, not a blocker

**Trade-offs Acknowledged**: Some code duplication across adapters, requires refactor if we reach 6+ realtime providers. Accept this technical debt in exchange for faster delivery and lower regression risk.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          ABL Platform                                    │
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │ Web Browser  │    │ Phone (PSTN) │    │ Embedded App │              │
│  │ (WebSocket)  │    │ (SIP/KoreVG) │    │ (SDK Widget) │              │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘              │
│         │                   │                    │                      │
│         │                   │                    │                      │
│         v                   v                    v                      │
│  ┌──────────────────────────────────────────────────────┐               │
│  │          Voice Session Resolver                      │               │
│  │  (mode: pipeline | realtime, provider selection)     │               │
│  └──────────────────────────────────────────────────────┘               │
│         │                                     │                          │
│         │ mode=realtime                       │ provider=grok_realtime   │
│         │ provider=grok_realtime              │                          │
│         v                                     v                          │
│  ┌─────────────────────────┐    ┌─────────────────────────┐             │
│  │ RealtimeVoiceExecutor   │    │ KoreVG Router           │             │
│  │ (tool routing, traces)  │    │ (llm verb for S2S)      │             │
│  └──────────┬──────────────┘    └──────────┬──────────────┘             │
│             │                              │                             │
│             v                              v                             │
│  ┌─────────────────────────┐    ┌─────────────────────────┐             │
│  │ GrokRealtimeSession     │◄───┤ VoiceServiceFactory     │             │
│  │ (WebSocket to xAI)      │    │ (credential resolution) │             │
│  └──────────┬──────────────┘    └──────────┬──────────────┘             │
│             │                              │                             │
│             │ WSS connection               │ decrypt credentials         │
│             v                              v                             │
└─────────────┼──────────────────────────────┼─────────────────────────────┘
              │                              │
              v                              v
      ┌───────────────┐            ┌───────────────┐
      │ xAI Grok API  │            │ MongoDB       │
      │ (Realtime WS) │            │ (TenantSvc    │
      │               │            │  Instance)    │
      └───────────────┘            └───────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│ packages/compiler/src/platform/llm/realtime/                            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ grok-realtime.ts                                          │         │
│  │                                                           │         │
│  │  export class GrokRealtimeSession                        │         │
│  │    implements RealtimeVoiceSession {                     │         │
│  │                                                           │         │
│  │    + connect(config: RealtimeSessionConfig): Promise<void>│        │
│  │    + disconnect(): Promise<void>                          │         │
│  │    + sendAudio(audio: Buffer): void                       │         │
│  │    + commitAudioBuffer(): void                            │         │
│  │    + cancelResponse(): void                               │         │
│  │    + submitToolResult(callId: string, result: string): void│        │
│  │    + updateSystemPrompt(prompt: string): void             │         │
│  │    + updateTools(tools: ToolDefinition[]): void           │         │
│  │    + on(event: K, handler: EventHandler): void            │         │
│  │                                                           │         │
│  │    - ws: WebSocket                                        │         │
│  │    - config: RealtimeSessionConfig                        │         │
│  │    - connectionState: RealtimeConnectionState             │         │
│  │    - reconnectAttempts: number                            │         │
│  │    - usage: RealtimeUsageMetrics                          │         │
│  │    - handlers: Map<EventType, Set<Handler>>               │         │
│  │  }                                                        │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ index.ts                                                  │         │
│  │                                                           │         │
│  │  registerRealtimeProvider(                               │         │
│  │    'grok_realtime',                                      │         │
│  │    () => new GrokRealtimeSession()                       │         │
│  │  );                                                      │         │
│  └───────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ apps/runtime/src/services/voice/                                        │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ s2s/types.ts                                              │         │
│  │                                                           │         │
│  │  export type S2SProviderType =                           │         │
│  │    | 's2s:openai'                                        │         │
│  │    | 's2s:google'                                        │         │
│  │    | 's2s:elevenlabs'                                    │         │
│  │    | 's2s:deepgram'                                      │         │
│  │    | 's2s:ultravox'                                      │         │
│  │    | 's2s:grok';  // NEW                                 │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ voice-service-factory.ts                                  │         │
│  │                                                           │         │
│  │  async resolveS2SCredentials(                            │         │
│  │    tenantId: string,                                     │         │
│  │    provider: S2SProviderType                             │         │
│  │  ): Promise<{ credentials: { apiKey: string, ... } }>   │         │
│  │  {                                                       │         │
│  │    // Resolve from TenantServiceInstance                 │         │
│  │    // Decrypt via EncryptionService                      │         │
│  │    // Cache in VoiceCredentialCache                      │         │
│  │    // NEW: handle 's2s:grok' case                        │         │
│  │  }                                                       │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ korevg/realtime-llm-payload.ts                            │         │
│  │                                                           │         │
│  │  export function buildRealtimeLlmVerbPayload(            │         │
│  │    s2sConfig: S2SSessionConfig,                          │         │
│  │    ...                                                   │         │
│  │  ): RealtimeLlmVerbPayload {                             │         │
│  │    const vendor = s2sConfig.provider === 's2s:grok'     │         │
│  │      ? 'grok'  // NEW case                               │         │
│  │      : s2sConfig.provider === 's2s:openai'              │         │
│  │      ? 'openai'                                          │         │
│  │      : ...;                                              │         │
│  │                                                           │         │
│  │    return { verb: 'llm', vendor, model, auth, ... };     │         │
│  │  }                                                       │         │
│  └───────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ apps/studio/src/components/admin/                                       │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ VoiceServicesPage.tsx                                     │         │
│  │                                                           │         │
│  │  const SERVICE_CARDS: ServiceCardConfig[] = [            │         │
│  │    {                                                     │         │
│  │      serviceType: 's2s:grok',  // NEW                   │         │
│  │      label: 'xAI Grok Realtime',                        │         │
│  │      description: 'Grok realtime S2S for voice',        │         │
│  │      icon: <Mic />,                                     │         │
│  │      fields: [                                          │         │
│  │        { key: 'apiKey', label: 'API Key',               │         │
│  │          type: 'password', isApiKey: true },            │         │
│  │        { key: 'model', label: 'Model',                  │         │
│  │          defaultValue: 'grok-realtime-1' },             │         │
│  │        { key: 'voice', label: 'Voice',                  │         │
│  │          defaultValue: 'default' },                     │         │
│  │      ],                                                 │         │
│  │    },                                                   │         │
│  │    // ... existing OpenAI, Gemini, Ultravox cards      │         │
│  │  ];                                                     │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ deployments/channels/S2SProviderSelector.tsx              │         │
│  │                                                           │         │
│  │  const PROVIDER_LABELS = {                               │         │
│  │    's2s:openai': 'OpenAI Realtime',                     │         │
│  │    's2s:google': 'Google Gemini Live',                  │         │
│  │    's2s:grok': 'xAI Grok Realtime',  // NEW             │         │
│  │    ...                                                  │         │
│  │  };                                                     │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │ deployments/channels/GrokS2SFields.tsx (NEW FILE)         │         │
│  │                                                           │         │
│  │  export function GrokS2SFields({                         │         │
│  │    config, onChange                                      │         │
│  │  }: S2SConfigFieldsProps) {                             │         │
│  │    return (                                              │         │
│  │      <div className="space-y-4">                         │         │
│  │        <Select label="Model"                             │         │
│  │          options={GROK_MODELS} />                        │         │
│  │        <Select label="Voice"                             │         │
│  │          options={GROK_VOICES} />                        │         │
│  │        <input type="range" id="temperature"              │         │
│  │          min="0" max="1" step="0.1" />                   │         │
│  │      </div>                                              │         │
│  │    );                                                    │         │
│  │  }                                                       │         │
│  └───────────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

#### Scenario 1: Web SDK Voice Session with Grok

```
1. Client → Runtime: WebSocket upgrade to wss://runtime/sdk/voice?deploymentId=...
2. Runtime: Validate API key, resolve tenant/project
3. Runtime → Voice Session Resolver:
   - Input: { tenantId, projectId, deploymentId, agentIR }
   - Resolve voice mode: Check deployment config → agent IR hints → global config
   - Output: { mode: 'realtime', providerType: 'grok_realtime' }
4. Runtime → VoiceServiceFactory:
   - resolveS2SCredentials(tenantId, 's2s:grok')
   - Query MongoDB TenantServiceInstance collection: { tenantId, serviceType: 's2s:grok' }
   - Decrypt credentials via EncryptionService
   - Cache in VoiceCredentialCache (key: tenant-123:s2s:grok, TTL: 10min)
   - Return: { apiKey: 'xai-...', organizationId: 'org-...' }
5. Runtime → RealtimeVoiceExecutor:
   - createRealtimeSession('grok_realtime', config)
   - Registry returns new GrokRealtimeSession()
6. GrokRealtimeSession → xAI Grok API:
   - WebSocket connect to wss://api.x.ai/v1/realtime (or compatible endpoint)
   - Headers: { Authorization: 'Bearer xai-...', 'X-Organization-ID': 'org-...' }
   - Send session.update with system prompt and tools
7. Client → Runtime: voice_audio message with base64-encoded PCM16
8. Runtime → GrokRealtimeSession: sendAudio(buffer)
9. GrokRealtimeSession → xAI: { type: 'input_audio_buffer.append', audio: <base64> }
10. xAI → GrokRealtimeSession: { type: 'response.audio.delta', delta: <base64> }
11. GrokRealtimeSession → Runtime: onAudio(buffer) event handler
12. Runtime → Client: voice_audio_chunk message
13. xAI → GrokRealtimeSession: { type: 'response.audio_transcript.done', transcript: '...' }
14. GrokRealtimeSession → Runtime: onTranscript({ role: 'assistant', text: '...' }) event
15. Runtime → Client: voice_transcript message
16. Runtime → TraceStore: Emit realtime_turn_complete trace event with usage metrics
17. Runtime → ClickHouse: Write trace event (providerType: 'grok_realtime', inputTokens, outputTokens, audioDurationMs)
```

#### Scenario 2: KoreVG Telephony Call with Grok S2S

```
1. KoreVG → Runtime: WebSocket upgrade to /korevg?channelId=...&token=...&caller=+1555...
2. Runtime → KorevgRouter: Validate token, resolve ChannelConnection config
3. KorevgRouter: Read ChannelConnection.config.s2sProvider === 's2s:grok'
4. KorevgRouter → VoiceServiceFactory: resolveS2SCredentials(tenantId, 's2s:grok')
5. VoiceServiceFactory → MongoDB: Query TenantServiceInstance { tenantId, serviceType: 's2s:grok' }
6. VoiceServiceFactory → EncryptionService: Decrypt credentials
7. VoiceServiceFactory: Cache in Redis, return { apiKey: 'xai-...', organizationId: 'org-...' }
8. KorevgRouter → buildRealtimeLlmVerbPayload():
   - Input: { provider: 's2s:grok', model: 'grok-realtime-1', voice: 'default', ... }
   - Output: {
       verb: 'llm',
       vendor: 'grok',
       model: 'grok-realtime-1',
       auth: { apiKey: 'xai-...', organizationId: 'org-...' },
       eventHook: '/llm-event',
       toolHook: '/llm-tool',
       llmOptions: {
         session_update: {
           modalities: ['text', 'audio'],
           instructions: '<system-prompt>',
           voice: 'default',
           output_audio_format: 'pcm16',
           tools: [<tool-definitions>],
           turn_detection: { type: 'server_vad', threshold: 0.5, ... },
         },
       },
     }
9. KorevgRouter → Jambonz: Send llm verb payload via WebSocket
10. Jambonz → TaskLlmGrok_S2S: Route to Grok handler based on vendor: 'grok'
11. TaskLlmGrok_S2S → xAI Grok API:
    - Connect to wss://api.x.ai/v1/realtime
    - Auth: Bearer token (apiKey)
    - **CRITICAL**: Send session.update FIRST (with instructions, voice, tools)
    - Then send response.create (triggers initial greeting)
    - (Order matters: session_update before response_create per grok_s2s.js lines 198-233)
12. Jambonz ↔ xAI: Audio streams bidirectionally (pcm16, 16kHz)
13. xAI → Jambonz: { type: 'response.function_call_arguments.done', name: 'get_weather', call_id: '...', arguments: '{...}' }
14. Jambonz → Runtime: /llm-tool webhook with tool call details
15. Runtime → ToolExecutor: execute('get_weather', { location: 'San Francisco' })
16. ToolExecutor: Run ABL tool, return result: { temperature: 68, condition: 'Sunny' }
17. Runtime → Jambonz: tool_result response
18. Jambonz → xAI: { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: '...', output: '{...}' } }
19. Jambonz → xAI: { type: 'response.create' } (triggers response incorporating tool result)
20. xAI → Jambonz: Continue audio response incorporating tool result
19. Runtime → TraceStore: Emit voice_turn, voice_tool_call trace events
20. Runtime → ClickHouse: Write trace events with provider: 'grok_realtime'
```

#### Scenario 3: Credential Configuration via Studio UI

```
1. User → Studio: Navigate to Admin → Voice Services
2. Studio → Browser: Render VoiceServicesPage component
3. VoiceServicesPage: Map SERVICE_CARDS array, render Grok card with "Not Configured" badge
4. User → Studio: Click "Configure" on Grok card
5. Studio: Open dialog with fields: Display Name, API Key, Model, Voice
6. User: Fill form and click "Save"
7. Studio → Runtime: POST /api/tenants/{tenantId}/service-instances
   - Body: {
       displayName: 'Production Grok Credentials',
       serviceType: 's2s:grok',
       apiKey: 'xai-prod-key-abc123',
       config: { model: 'grok-realtime-1', voice: 'default' },
     }
   - Auth: Tenant admin JWT
8. Runtime → TenantServiceInstancesRoute: Validate JWT, check tenantId scope
9. Runtime → EncryptionService: encrypt({ apiKey, config }) with tenant-specific key
10. Runtime → MongoDB: Insert TenantServiceInstance document:
    - { tenantId, serviceType: 's2s:grok', encryptedCredentials: '...', status: 'active' }
11. Runtime → VoiceServiceFactory: invalidate() cache for this tenant/provider
12. Runtime → Redis: DELETE tenant-123:s2s:grok cache key
13. Runtime → Studio: 201 Created with { success: true, instance: { id: '...', serviceType: 's2s:grok', isActive: true } }
14. Studio: Show success toast: "Grok (xAI) - Realtime Voice credentials saved"
15. Studio: Update Grok card to "Configured" state (green badge)
```

### Sequence Diagram: Tool Calling with Grok

```
┌────────┐         ┌──────────────┐      ┌──────────────┐      ┌─────────┐      ┌──────────┐
│ Client │         │ Runtime      │      │ Grok Session │      │ xAI API │      │ Tool     │
│        │         │ (Executor)   │      │              │      │         │      │ Executor │
└───┬────┘         └──────┬───────┘      └──────┬───────┘      └────┬────┘      └────┬─────┘
    │                     │                     │                   │                │
    │ audio: "weather SF" │                     │                   │                │
    ├─────────────────────>                     │                   │                │
    │                     │ sendAudio(buffer)   │                   │                │
    │                     ├─────────────────────>                   │                │
    │                     │                     │ input_audio_buffer│                │
    │                     │                     ├───────────────────>                │
    │                     │                     │                   │                │
    │                     │                     │ response.function_call             │
    │                     │                     │<──────────────────┤                │
    │                     │                     │ {                 │                │
    │                     │                     │   call_id: 'c1',  │                │
    │                     │                     │   name: 'get_weather',             │
    │                     │                     │   arguments: '{"location":"SF"}'   │
    │                     │                     │ }                 │                │
    │                     │                     │                   │                │
    │                     │ onToolCall(toolCall)│                   │                │
    │                     │<────────────────────┤                   │                │
    │                     │                     │                   │                │
    │                     │ execute('get_weather', {location: 'SF'})                 │
    │                     ├──────────────────────────────────────────────────────────>
    │                     │                     │                   │ [ABL Tool Exec]│
    │                     │                     │                   │                │
    │                     │ result: { temp: 68, condition: 'Sunny' }                 │
    │                     │<──────────────────────────────────────────────────────────┤
    │                     │                     │                   │                │
    │                     │ submitToolResult('c1', '{"temp":68,"condition":"Sunny"}')|
    │                     ├─────────────────────>                   │                │
    │                     │                     │ conversation.item.create           │
    │                     │                     │ {                 │                │
    │                     │                     │   type: 'function_call_output',    │
    │                     │                     │   call_id: 'c1',  │                │
    │                     │                     │   output: '{...}' │                │
    │                     │                     │ }                 │                │
    │                     │                     ├───────────────────>                │
    │                     │                     │                   │                │
    │                     │                     │ response.audio.delta               │
    │                     │                     │<──────────────────┤                │
    │                     │                     │ "Weather in SF is 68 and sunny"    │
    │                     │ onAudio(buffer)     │                   │                │
    │                     │<────────────────────┤                   │                │
    │ audio_chunk         │                     │                   │                │
    │<────────────────────┤                     │                   │                │
    │                     │                     │                   │                │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every Grok session scoped to `tenantId`. VoiceServiceFactory resolves credentials per tenant from TenantServiceInstance (`{ _id, tenantId, serviceType: 's2s:grok', encryptedCredentials }`). VoiceCredentialCache keys include tenantId (`tenant-123:s2s:grok`). Cross-tenant credential access returns **404** (not 403).                                                                                                                        |
| 2   | **Data Access Pattern** | Repository pattern via Mongoose models. `TenantServiceInstanceModel.findOne({ tenantId, serviceType: 's2s:grok' })` for credential reads. EncryptionService for decrypt. VoiceServiceFactory caches decrypted credentials in Redis (TTL: 10min, max 100 entries per tenant). No direct MongoDB queries in business logic.                                                                                                                          |
| 3   | **API Contract**        | Studio REST API: `POST /api/tenants/{tenantId}/service-instances` (create), `PATCH /{instanceId}` (update), `DELETE /{instanceId}` (remove). Request: `{ serviceType: 's2s:grok', apiKey, config }`. Response: `{ success: true, instance: { id, serviceType, isActive, createdAt } }`. Error envelope: `{ success: false, error: { code, message } }`. No versioning needed (additive change).                                                    |
| 4   | **Security Surface**    | **Auth**: Studio endpoints use `requireAuth()` + `requirePermission('tenant:admin')`. Runtime WebSocket validates API key. **Input validation**: Zod schema for apiKey (min 1 char, string), config (object). **SSRF**: No user-controlled URLs (Grok endpoint hardcoded or from env var). **Encryption**: Credentials encrypted at rest via EncryptionService (AES-256-GCM). **Secrets**: API keys never logged, never returned in GET responses. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Credential missing → SERVICE_UNAVAILABLE (500), fallback to pipeline mode if graceful degradation enabled. Decryption failure → SERVICE_UNAVAILABLE, log error (never expose encryption failure details to client). Grok API 401 → terminate session, emit trace event with error_type: 'invalid_api_key'. Grok API 429 → emit rate_limit_exceeded trace event, session fails. WebSocket disconnect → exponential backoff reconnect (max 3 retries, base 1s).           |
| 6   | **Failure Modes** | **Network partition**: WebSocket close triggers reconnect with exponential backoff. Max 3 attempts, then session fails. **Timeout**: WebSocket connect timeout 10s, no response timeout 30s. **Partial failure**: If Grok credentials invalid but OpenAI credentials valid, only Grok sessions fail (provider isolation). **Circuit breaker**: VoiceServiceFactory cache prevents repeated decryption failures (cache null result for 60s).                             |
| 7   | **Idempotency**   | Credential CRUD idempotent via MongoDB upsert semantics. `POST /service-instances` with duplicate serviceType returns 409 Conflict (user must DELETE then POST, or use PATCH to update). WebSocket messages not idempotent (audio streaming), but reconnection resumes from last ack'd position if supported by Grok protocol. Tool result submission idempotent by call_id (Grok deduplicates).                                                                        |
| 8   | **Observability** | **Traces**: `realtime_session_start`, `realtime_turn_complete`, `realtime_session_end` with providerType: 'grok_realtime'. Usage metrics: inputTokens, outputTokens, audioDurationInMs, audioDurationOutMs, turnCount, connectionDurationMs. **Logs**: Structured via `createLogger('grok-realtime')` (never console.log). **Debug**: Connection state changes logged (connecting → connected → disconnected). Error events logged with sessionId, tenantId, errorType. |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Latency target**: <600ms p95 end-to-end (same as OpenAI). **Payload size**: Audio frames 100ms chunks (PCM16 16kHz = 3.2KB/frame), max 10KB/message. **Batch limits**: No batching (streaming). **Throughput**: 100+ sessions/day/tenant, 50+ concurrent sessions per runtime pod. **Cache**: VoiceServiceFactory cache hit ratio target 99% (10min TTL).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | **Migration Path**     | **Current state**: No Grok support. **Target state**: Grok available as option. **Transition**: (1) Deploy code, (2) Tenant admins manually add Grok credentials via Studio UI, (3) Developers select Grok for voice agents. **Rollback**: Set `FEATURE_GROK_VOICE_ENABLED=false` via env var. No data migration required. **Graceful degradation**: If Grok credentials not configured, voice mode resolver falls back to pipeline mode or returns error (existing behavior).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | **Rollback Plan**      | **Code rollback**: Revert commit, redeploy. No data migration to undo (additive change). **Feature flag**: Set `FEATURE_GROK_VOICE_ENABLED=false` to disable Grok without code rollback. Existing sessions fail gracefully, new sessions fall back to other providers. **Credential removal**: DELETE `/api/service-instances/{id}` removes Grok credentials. Cache invalidated immediately via VoiceServiceFactory.invalidate(). **Zero downtime**: No breaking changes to existing APIs or data models.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | **Test Strategy**      | **Unit**: GrokRealtimeSession contract tests (connect, disconnect, sendAudio, toolResult, reconnection). VoiceServiceFactory.resolveS2SCredentials() with 's2s:grok' case. buildRealtimeLlmVerbPayload() with grok vendor. Target 90% line coverage for adapter. **Integration**: VoiceServiceFactory + TenantServiceInstance + EncryptionService round-trip. KoreVG Router + buildRealtimeLlmVerbPayload(). Trace event emission. Credential cache behavior. Target 85% line coverage. **E2E**: HTTP API interaction only (no mocking codebase components). Real MongoDB/Redis/ClickHouse. Mock Grok WebSocket server (OpenAI-compatible protocol). 7 E2E scenarios from test spec (credential config → voice session → traces → analytics). Auth context + tenant isolation checks (404 for cross-tenant access). Target 80% feature coverage. **Performance**: 50+ concurrent sessions, <600ms p95 latency, 99% cache hit rate. |

---

## 5. Data Model

### New Collections/Tables

**None** — Grok uses existing collections with new service type values.

### Modified Collections/Tables

#### TenantServiceInstance (MongoDB, existing collection)

**Change**: Add `'s2s:grok'` as allowed value for `serviceType` field.

**Schema** (unchanged):

```typescript
{
  _id: ObjectId,
  tenantId: string,  // indexed
  serviceType: string,  // 's2s:grok' is NEW VALUE
  displayName: string,
  encryptedCredentials: string,  // AES-256-GCM encrypted { apiKey, organizationId?, config }
  status: 'active' | 'inactive',
  metadata: {
    addedBy: string,  // userId
    lastTested: Date,
    testResult: { success: boolean, error?: string },
  },
  createdAt: Date,
  updatedAt: Date,
}
```

**Indexes** (unchanged):

- `{ tenantId: 1, serviceType: 1 }` (unique) — ensures one Grok credential per tenant
- `{ tenantId: 1, status: 1 }` — for listing active services

**Validation**: Runtime `tenant-service-instances.ts` route already validates serviceType against allowed list. Update to include `'s2s:grok'`.

#### VoiceSession (MongoDB, existing collection)

**Change**: None (schema already supports arbitrary providerType values).

**New Values**: `providerType: 'grok_realtime'` for Grok sessions.

#### voice_trace_events (ClickHouse, existing table)

**Change**: None (schema already supports arbitrary provider_type dimension).

**New Values**: `provider_type = 'grok_realtime'` for Grok session traces.

#### voice_usage_metrics (ClickHouse, existing table)

**Change**: None.

**New Values**: `provider = 'grok_realtime'` for Grok usage metrics.

### Key Relationships

```
TenantServiceInstance (MongoDB)
  |
  +-- tenantId ──> Tenant (MongoDB)
  |
  +-- serviceType = 's2s:grok' ──> GrokRealtimeSession (runtime)
  |
  +-- encryptedCredentials ──> EncryptionService (decrypt) ──> VoiceServiceFactory (cache)
  |
  +-- VoiceCredentialCache (Redis)
      |
      +-- key: tenant-123:s2s:grok
      +-- value: { apiKey: 'xai-...', organizationId: 'org-...' }
      +-- TTL: 10 minutes

VoiceSession (MongoDB)
  |
  +-- tenantId ──> Tenant
  +-- projectId ──> Project
  +-- providerType: 'grok_realtime' ──> GrokRealtimeSession

voice_trace_events (ClickHouse)
  |
  +-- tenant_id ──> Tenant (dimension)
  +-- session_id ──> VoiceSession (dimension)
  +-- provider_type: 'grok_realtime' ──> GrokRealtimeSession (dimension)
```

---

## 6. API Design

### New Endpoints

**None** — Grok uses existing TenantServiceInstance CRUD endpoints.

### Modified Endpoints

#### POST /api/tenants/{tenantId}/service-instances

**Existing Endpoint** — Modified to accept `'s2s:grok'` as valid `serviceType`.

**Request**:

```json
{
  "displayName": "Production Grok Credentials",
  "serviceType": "s2s:grok",
  "apiKey": "xai-prod-key-abc123",
  "config": {
    "model": "grok-realtime-1",
    "voice": "default",
    "organizationId": "org-xyz"
  }
}
```

**Response** (201 Created):

```json
{
  "success": true,
  "instance": {
    "id": "66f1a2b3c4d5e6f7a8b9c0d1",
    "tenantId": "tenant-123",
    "serviceType": "s2s:grok",
    "displayName": "Production Grok Credentials",
    "isActive": true,
    "createdAt": "2026-03-31T10:00:00Z",
    "updatedAt": "2026-03-31T10:00:00Z"
  }
}
```

**Validation**:

- `serviceType` must be one of allowed types including `'s2s:grok'`
- `apiKey` required, string, min 1 char (Zod: `z.string().min(1)`)
- `config.model` optional, string, default `'grok-realtime-1'`
- `config.voice` optional, string, default `'default'`
- `config.organizationId` optional, string

**Auth**: `requireAuth()` + `requirePermission('tenant:admin')`

#### PATCH /api/tenants/{tenantId}/service-instances/{instanceId}

**Existing Endpoint** — No changes. Supports updating Grok credentials.

**Request**:

```json
{
  "displayName": "Updated Grok Credentials",
  "config": {
    "model": "grok-realtime-2"
  }
}
```

**Response** (200 OK): Same as POST response.

**Side Effect**: Invalidates VoiceServiceFactory cache (`tenant-123:s2s:grok` deleted from Redis).

#### DELETE /api/tenants/{tenantId}/service-instances/{instanceId}

**Existing Endpoint** — No changes. Deletes Grok credentials.

**Response** (200 OK):

```json
{
  "success": true
}
```

**Side Effect**: Invalidates VoiceServiceFactory cache.

#### GET /api/tenants/{tenantId}/service-instances

**Existing Endpoint** — No changes. Returns Grok credentials in list (API key NOT included).

**Response** (200 OK):

```json
{
  "success": true,
  "instances": [
    {
      "id": "66f1a2b3c4d5e6f7a8b9c0d1",
      "serviceType": "s2s:grok",
      "displayName": "Production Grok Credentials",
      "isActive": true,
      "createdAt": "2026-03-31T10:00:00Z"
    }
  ]
}
```

### Error Responses

| Error Code          | HTTP Status | Scenario                                             |
| ------------------- | ----------- | ---------------------------------------------------- |
| UNAUTHORIZED        | 401         | Missing or invalid JWT                               |
| FORBIDDEN           | 403         | User lacks `tenant:admin` permission                 |
| NOT_FOUND           | 404         | Cross-tenant access (tenantId mismatch)              |
| CONFLICT            | 409         | Duplicate `serviceType: 's2s:grok'` for tenant       |
| VALIDATION_ERROR    | 400         | Invalid apiKey format or missing required field      |
| SERVICE_UNAVAILABLE | 500         | Encryption service unavailable or decryption failure |

**Example Error Response**:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Service instance with type 's2s:grok' already exists for this tenant"
  }
}
```

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Credential CRUD operations logged to audit trail:
  - `tenant_service_instance.created` (tenantId, serviceType, addedBy, timestamp)
  - `tenant_service_instance.updated` (instanceId, changes, updatedBy, timestamp)
  - `tenant_service_instance.deleted` (instanceId, deletedBy, timestamp)
- Voice session start/end logged with providerType dimension
- Tool calls logged with tool name, arguments (sanitized for PII), result status

### Rate Limiting

- Studio API endpoints: 100 req/min per tenant (existing rate limiting applies)
- Grok WebSocket connections: No platform-side limit (relies on xAI API rate limits)
- If Grok API returns 429 rate limit error, emit trace event and fail session gracefully

### Caching

- **VoiceServiceFactory credential cache**:
  - Key: `tenant-123:s2s:grok`
  - Value: `{ apiKey: 'xai-...', organizationId: 'org-...' }`
  - TTL: 10 minutes
  - Max entries: 100 per tenant (bounded)
  - Eviction: LRU + TTL
- **VoiceCredentialCache (Redis)**:
  - Key: `auth-profile:voice:{tenantId}:{callId}`
  - TTL: 4 hours
  - Used for KoreVG credential lookup
- Cache invalidation on credential update/delete via `VoiceServiceFactory.invalidate()`

### Encryption

- **At rest**: TenantServiceInstance.encryptedCredentials encrypted via EncryptionService (AES-256-GCM)
- **In transit**: HTTPS for Studio API, WSS (TLS) for WebSocket connections, xAI Grok API connection via wss://
- **Key management**: Encryption keys managed by EncryptionService (env var ENCRYPTION_KEY_BASE64 or cloud KMS)
- **Secrets handling**: API keys never logged, never returned in GET responses, masked in Studio UI (**\*\***)

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency              | Type     | Risk   | Notes                                                                                                       |
| ----------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| xAI Grok Realtime API   | External | HIGH   | No official SDK yet, assuming OpenAI-compatible protocol                                                    |
| TenantServiceInstance   | Internal | LOW    | Stable MongoDB collection, no schema changes required                                                       |
| EncryptionService       | Internal | LOW    | Stable service, used for all credential encryption                                                          |
| VoiceServiceFactory     | Internal | MEDIUM | Extending with Grok case, low risk (additive change)                                                        |
| RealtimeVoiceExecutor   | Internal | LOW    | No changes, just uses new GrokRealtimeSession provider                                                      |
| WebSocket library (ws)  | npm      | LOW    | Same library used by OpenAI/Gemini adapters                                                                 |
| Jambonz feature-server  | External | LOW    | **Already has Grok support** — TaskLlmGrok_S2S implemented (vendor: 'grok', api.x.ai endpoint, bearer auth) |
| TraceStore / ClickHouse | Internal | LOW    | No schema changes, just new dimension value                                                                 |

### Downstream (depends on this feature)

| Consumer                   | Impact                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| Studio Voice Services UI   | Must render Grok card, handle credential CRUD                           |
| Voice analytics dashboards | Must support filtering by providerType: 'grok_realtime'                 |
| Deployment configs         | Developers can select Grok as voice provider (no code changes)          |
| KoreVG integrations        | Channels can specify `s2sProvider: 's2s:grok'` in config (no migration) |

---

## 9. Open Questions & Decisions Needed

1. **OQ-1** (Critical): Is the Grok realtime API protocol 100% compatible with OpenAI Realtime API (same WebSocket event types, same session.update structure, same tool calling format)?
   - **Impact**: If incompatible, need protocol translation layer (adds 2-3 days)
   - **Resolution Path**: Test with Grok API when available, review xAI documentation

2. **OQ-2** (High): What audio formats does Grok support (PCM16, g711_ulaw, g711_alaw)? What sample rates (16kHz, 24kHz)?
   - **Impact**: May need audio transcoding layer
   - **Resolution Path**: Test with Grok API, check xAI docs

3. **OQ-3** (High): What is the tool calling format for Grok? OpenAI function_call format or custom?
   - **Impact**: May need schema transformation layer for tool definitions and results
   - **Resolution Path**: Test tool calling with Grok API

4. **OQ-4** (Medium): Does Grok support voice selection (multiple voice options)? What are the voice identifiers?
   - **Impact**: Studio UI voice dropdown may need updating with Grok voice options
   - **Resolution Path**: Review xAI docs, check available voices

5. **OQ-5** (Medium): What is the exact credential format? API key only, or API key + organization ID + project ID?
   - **Impact**: Affects validation and storage schema
   - **Resolution Path**: Check xAI console credential issuance format

6. **OQ-6** (Medium): What are the Grok API rate limits and pricing model?
   - **Impact**: May need circuit breaker tuning, usage alerts
   - **Resolution Path**: Review xAI pricing docs

7. **OQ-7** (Low): What are the Grok-specific event types that differ from OpenAI?
   - **Impact**: May need event mapping in Runtime KoreVG router
   - **Resolution Path**: Jambonz implementation shows `response.output_audio_transcript.delta` vs `response.audio_transcript.delta`
   - **Note**: Jambonz feature-server already handles Grok-specific events (see `grok_server_events` in `lib/tasks/llm/llms/grok_s2s.js`)

8. **OQ-8** (Low): When will Grok realtime API be generally available?
   - **Impact**: Timeline dependency for implementation
   - **Resolution Path**: Contact xAI or monitor announcements

9. **OQ-9** (Low): Are there different Grok model variants for voice (e.g., grok-realtime-1, grok-realtime-2-turbo)?
   - **Impact**: Studio UI model selector may need updating
   - **Resolution Path**: Review xAI model documentation

10. **OQ-10** (Low): What is the session duration limit for Grok realtime sessions?
    - **Impact**: May need session rotation logic for long calls
    - **Resolution Path**: Test long-running sessions

---

## 10. References

- Feature spec: [`docs/features/sub-features/grok-realtime-s2s-voice.md`](../features/sub-features/grok-realtime-s2s-voice.md)
- Test spec: [`docs/testing/sub-features/grok-realtime-s2s-voice.md`](../testing/sub-features/grok-realtime-s2s-voice.md)
- Related designs:
  - [`docs/specs/voice-capabilities.hld.md`](voice-capabilities.hld.md) — Voice architecture overview
  - [`docs/specs/voice-analytics.hld.md`](voice-analytics.hld.md) — Voice tracing and metrics
- Reference implementations:
  - `packages/compiler/src/platform/llm/realtime/openai-realtime.ts` — OpenAI adapter pattern to copy for GrokRealtimeSession
  - `packages/compiler/src/platform/llm/realtime/gemini-live.ts` — Gemini adapter pattern
  - `apps/runtime/src/services/voice/voice-service-factory.ts` — Credential resolution (extend resolveS2SCredentials)
  - `apps/runtime/src/services/voice/korevg/realtime-llm-payload.ts` — KoreVG llm verb builder (add buildGrokLlmVerbPayload)
  - `apps/studio/src/components/admin/VoiceServicesPage.tsx` — Studio UI pattern (add Grok to SERVICE_CARDS)
- Jambonz integration:
  - `/home/rammohanyadavalli/Downloads/savg/sources/jambonz-feature-server/lib/tasks/llm/index.js` — Vendor routing (vendor: 'grok' already supported, line 89)
  - `/home/rammohanyadavalli/Downloads/savg/sources/jambonz-feature-server/lib/tasks/llm/llms/grok_s2s.js` — **Grok S2S implementation already exists**
    - Endpoint: `wss://api.x.ai/v1/realtime`
    - Auth: Bearer token
    - Events: Grok-specific event types (e.g., `response.output_audio_transcript.delta`)
    - Tool calling: `response.function_call_arguments.done` event
    - **Critical**: Session initialization requires `session.update` BEFORE `response.create` (lines 198-233)
