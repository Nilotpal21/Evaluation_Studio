# Speech-to-Speech (S2S) Integration Plan for ABL Platform

**Created:** 2026-03-09
**Status:** Planning
**Priority:** High

## Executive Summary

This document outlines the plan to integrate Speech-to-Speech (S2S) capabilities into the ABL platform by leveraging KoreVG's S2S implementation. S2S enables direct voice-to-voice LLM interaction without intermediate text transcription, significantly reducing latency and improving naturalness of voice conversations.

## Table of Contents

1. [Background & Context](#background--context)
2. [Architecture Analysis](#architecture-analysis)
3. [Integration Strategy](#integration-strategy)
4. [Implementation Plan](#implementation-plan)
   - [UI Configuration & Tenant Services](#ui-configuration--tenant-services) (Tasks 1-11)
   - [Agent Flow Integration](#agent-flow-integration-with-s2s)
   - [Backend Implementation](#backend-implementation) (Tasks 12-18)
5. [Technical Specifications](#technical-specifications)
6. [Testing Strategy](#testing-strategy)
7. [Rollout Plan](#rollout-plan)
8. [Risks & Mitigation](#risks--mitigation)
9. [Success Metrics](#success-metrics)
10. [Next Steps](#next-steps)
11. [Appendices](#appendices)

---

## Background & Context

### What is S2S?

Speech-to-Speech (S2S) is a voice interaction paradigm where:

- Audio streams directly to an LLM provider's realtime API
- The LLM processes audio natively (no STT intermediate step)
- The LLM generates audio responses natively (no TTS intermediate step)
- Significantly lower latency (target: < 300ms vs 800ms+ for STT→LLM→TTS pipeline)
- More natural conversation flow with proper prosody, intonation, and interruption handling

### KoreVG S2S Implementation

KoreVG has production-ready S2S support for:

- **OpenAI Realtime API** (`gpt-4o-realtime-preview`)
- **ElevenLabs Conversational AI**
- **Google Gemini Live**
- **Deepgram Voice Agent**
- **Ultravox**

**Key Components:**

1. **FreeSWITCH Modules** (C/C++):
   - `mod_openai_s2s.c` - OpenAI Realtime API integration
   - `mod_elevenlabs_s2s.c` - ElevenLabs Conversational AI
   - `mod_google_s2s.c` - Google Gemini Live
   - `mod_deepgram_voice_agent_s2s.c` - Deepgram Voice Agent
   - `mod_ultravox_s2s.c` - Ultravox
   - Audio handling: Linear16 PCM, Speex resampling, media bug API
   - WebSocket connections with event handling

2. **Feature Server** (Node.js):
   - Task-based architecture: `lib/tasks/llm/llms/`
   - Vendor-specific implementations (`openai_s2s.js`, `elevenlabs_s2s.js`, etc.)
   - Session lifecycle management
   - Tool calling with MCP integration
   - Event filtering and webhooks

### ABL Current Voice Architecture

**Existing Modes:**

- `voice_pipeline` - Traditional STT → LLM → TTS pipeline (Deepgram + ElevenLabs)
- `voice_realtime` - OpenAI Realtime API (via KoreVG)
- `voice_vxml` - VXML integration

**Infrastructure:**

- `KorevgRouter` - WebSocket connection handler for KoreVG
- `KorevgSession` - Session management with verb builder
- `RealtimeVoiceExecutor` - Bridges ABL flows with realtime voice
- Voice metrics, tracing, and observability

**Gap:** Current `voice_realtime` is OpenAI-specific. Need to abstract S2S as a provider-agnostic layer supporting multiple vendors.

---

## Architecture Analysis

### KoreVG S2S Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FreeSWITCH (Media Layer)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ mod_openai   │  │ mod_eleven   │  │ mod_google   │          │
│  │    _s2s      │  │  labs_s2s    │  │    _s2s      │   ...    │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│         │                  │                  │                  │
│         └──────────────────┴──────────────────┘                 │
│                            │                                     │
│                   Media Bug API (audio i/o)                      │
│                   Speex Resampler                                │
│                   WebSocket Client                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket (audio + events)
                              │
┌─────────────────────────────▼─────────────────────────────────┐
│                    Feature Server (Node.js)                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              TaskLlm (Parent)                            │  │
│  │  - Session lifecycle                                     │  │
│  │  - Tool hook routing                                     │  │
│  │  - MCP integration                                       │  │
│  │  - Event filtering                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                  │
│         ┌────────────────────┼────────────────────┐            │
│         ▼                    ▼                    ▼            │
│  ┌─────────────┐      ┌─────────────┐     ┌─────────────┐    │
│  │ openai_s2s  │      │elevenlabs   │     │ google_s2s  │    │
│  │   .js       │      │  _s2s.js    │     │    .js      │    │
│  └─────────────┘      └─────────────┘     └─────────────┘    │
│         │                    │                    │            │
│         └────────────────────┴────────────────────┘            │
│                              │                                  │
│                 uuid_<vendor>_s2s API calls                     │
│                 (session.create, client.event, session.delete)  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP REST API
                              │
                     ┌────────▼─────────┐
                     │   LLM Provider    │
                     │  (OpenAI, etc.)   │
                     └──────────────────┘
```

### ABL Integration Architecture (Proposed)

```
┌──────────────────────────────────────────────────────────────────────┐
│                          ABL Runtime                                  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │            KorevgRouter (WebSocket Handler)                   │   │
│  │  - Upgrade handling                                           │   │
│  │  - Session pooling                                            │   │
│  │  - Auth verification                                          │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                            │                                          │
│                            ▼                                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              KorevgSession (Session Manager)                  │   │
│  │  - Verb builder (KoreVG commands)                           │   │
│  │  - Message routing                                            │   │
│  │  - Lifecycle management                                       │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                            │                                          │
│              ┌─────────────┴─────────────┐                           │
│              ▼                           ▼                           │
│  ┌──────────────────────┐   ┌──────────────────────────┐           │
│  │  VoicePipelineMode   │   │   S2SRealtimeMode        │◄── NEW    │
│  │                      │   │                          │           │
│  │  - STT (Deepgram)    │   │  - Provider abstraction  │           │
│  │  - LLM               │   │  - Tool execution        │           │
│  │  - TTS (ElevenLabs)  │   │  - Session config        │           │
│  │  - Tool execution    │   │  - Event handling        │           │
│  └──────────────────────┘   └────────────┬─────────────┘           │
│                                           │                          │
│                          ┌────────────────┴────────────────┐        │
│                          ▼                                 ▼        │
│              ┌──────────────────────┐      ┌──────────────────────┐│
│              │  OpenAIS2SProvider   │      │ ElevenLabsS2SProvider││
│              │                      │      │                      ││
│              │  - Model config      │      │  - Agent config      ││
│              │  - Tool definitions  │      │  - Voice settings    ││
│              │  - Session.update    │      │  - Conversation ID   ││
│              └──────────────────────┘      └──────────────────────┘│
│                          │                                 │         │
│                          └────────────────┬────────────────┘         │
│                                           │                          │
│                                           ▼                          │
│                          ┌─────────────────────────────────┐        │
│                          │   S2SCommandBuilder             │        │
│                          │  (Generates KoreVG verbs)      │        │
│                          └─────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
                                           │
                                           │ WebSocket
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                 FreeSWITCH + KoreVG Modules                          │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ mod_openai   │  │ mod_eleven   │  │ mod_google   │              │
│  │    _s2s      │  │  labs_s2s    │  │    _s2s      │      ...     │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└──────────────────────────────────────────────────────────────────────┘
                                           │
                                           │ HTTP/WebSocket
                                           ▼
                              ┌────────────────────────┐
                              │   LLM Provider APIs    │
                              │  OpenAI, ElevenLabs,   │
                              │  Google, Deepgram      │
                              └────────────────────────┘
```

---

## Integration Strategy

### Phase 1: Foundation (Weeks 1-2)

**Goal:** Build S2S abstraction layer without breaking existing `voice_realtime`

**Deliverables:**

1. `S2SProvider` interface and base class
2. `S2SRealtimeMode` session manager
3. `S2SCommandBuilder` for KoreVG verb generation
4. OpenAI S2S provider implementation (migrate existing logic)
5. Configuration schema updates

### Phase 2: Multi-Provider Support (Weeks 3-4)

**Goal:** Add ElevenLabs and Google Gemini S2S providers

**Deliverables:**

1. `ElevenLabsS2SProvider` implementation
2. `GoogleS2SProvider` implementation
3. Provider-specific credential management
4. Studio UI for provider selection
5. Integration tests for each provider

### Phase 3: Tool Calling & Advanced Features (Weeks 5-6)

**Goal:** Tool execution, MCP integration, advanced session control

**Deliverables:**

1. Tool definition translation for each provider
2. Tool execution bridge with ABL runtime
3. MCP tool integration
4. Session update API (mid-call config changes)
5. Interrupt handling and barge-in

### Phase 4: Observability & Production Readiness (Week 7)

**Goal:** Metrics, tracing, error handling, documentation

**Deliverables:**

1. S2S-specific metrics and traces
2. Error recovery and fallback strategies
3. Load testing and performance optimization
4. Documentation and runbooks
5. Production deployment

---

## Implementation Plan

## UI Configuration & Tenant Services

### Overview: Two-Level Configuration

S2S integration requires configuration at two levels:

1. **Tenant Level:** API credentials for S2S providers (stored in `TenantServiceInstance`)
2. **Channel Level:** Provider selection and configuration (stored in `ChannelConnection.config`)

**Key Design:**

- ✅ API keys stored centrally at tenant level (encrypted)
- ✅ Reusable across multiple channels
- ✅ Channel config only shows providers with configured API keys
- ✅ Similar UX to Pipeline Voice, but S2S-specific

### Data Models

#### Tenant Service Instance (MongoDB)

Extend existing `TenantServiceInstance` model:

```typescript
// packages/database/src/models/tenant-service-instance.model.ts

export interface TenantServiceInstanceDocument extends Document {
  tenantId: string;
  serviceType: 'stt' | 'tts' | 'llm' | 's2s'; // Add 's2s'
  provider: string; // 'openai', 'elevenlabs', 'google', 'deepgram', 'ultravox'
  credentials: {
    apiKey: string; // Encrypted
    agentId?: string; // ElevenLabs
    projectId?: string; // Google
    region?: string;
  };
  config?: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

#### Channel Connection Config

Extend `ChannelConnection.config` for `voice_realtime`:

```typescript
interface VoiceRealtimeConfig {
  s2sProvider: 'openai' | 'elevenlabs' | 'google' | 'deepgram' | 'ultravox';
  useTenantCredentials: boolean; // Always true for UI flow

  openai?: {
    model: string;
    voice: string;
    temperature?: number;
    maxTokens?: number;
    turnDetection?: {
      type: 'server_vad' | 'none';
      threshold?: number;
      prefixPaddingMs?: number;
      silenceDurationMs?: number;
    };
  };

  elevenlabs?: {
    agentId: string;
    conversationId?: string;
  };

  google?: {
    model: string;
    voice: string;
    temperature?: number;
  };

  // Phone number (from KoreVG provisioning)
  phoneNumber?: string;
  KoreVGApplicationSid?: string;
  KoreVGPhoneNumberSid?: string;
}
```

---

### Task 1: Extend TenantServiceInstance Model

**Files:**

- Modify: `packages/database/src/models/tenant-service-instance.model.ts`

Add `'s2s'` to `serviceType` enum and S2S-specific credential fields.

---

### Task 2: Voice Services API Endpoints

**Files:**

- Create: `apps/runtime/src/routes/voice-services.ts`

**Endpoints:**

```typescript
// GET /api/voice-services - List all S2S services for tenant
// POST /api/voice-services - Create new S2S service
// PATCH /api/voice-services/:id - Update existing service
// DELETE /api/voice-services/:id - Delete service
// POST /api/voice-services/:id/test - Test connection

router.post('/', authMiddleware, async (req, res) => {
  const { tenantId } = req.auth!;
  const { provider, credentials } = req.body;

  // Encrypt API key
  const encryption = getEncryptionService();
  const encryptedApiKey = await encryption.encrypt(credentials.apiKey);

  const service = await TenantServiceInstance.create({
    tenantId,
    serviceType: 's2s',
    provider,
    credentials: { ...credentials, apiKey: encryptedApiKey },
    isActive: true,
  });

  res.status(201).json({ service });
});

router.post('/:id/test', authMiddleware, async (req, res) => {
  const service = await TenantServiceInstance.findOne({
    _id: req.params.id,
    tenantId: req.auth!.tenantId,
  });

  const encryption = getEncryptionService();
  const apiKey = await encryption.decrypt(service.credentials.apiKey);

  // Test connection based on provider
  const result = await testProviderConnection(service.provider, apiKey);
  res.json(result);
});
```

---

### Task 3: Studio API Client for Voice Services

**Files:**

- Create: `apps/studio/src/api/voice-services.ts`

```typescript
export async function listVoiceServices(): Promise<VoiceServiceInstance[]> {
  const res = await fetch(`${getApiBase()}/api/voice-services`, {
    credentials: 'include',
  });
  const data = await res.json();
  return data.services;
}

export async function createVoiceService(payload: CreateServicePayload) {
  const res = await fetch(`${getApiBase()}/api/voice-services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function testVoiceServiceConnection(serviceId: string) {
  const res = await fetch(`${getApiBase()}/api/voice-services/${serviceId}/test`, {
    method: 'POST',
    credentials: 'include',
  });
  return res.json();
}
```

---

### Task 4: Tenant Voice Services Page

**Files:**

- Create: `apps/studio/src/app/(authenticated)/settings/voice-services/page.tsx`

Main settings page showing all S2S providers with configuration status.

**Features:**

- List all 5 S2S providers (OpenAI, ElevenLabs, Google, Deepgram, Ultravox)
- Show "Configured" badge for active services
- Configure/Edit/Delete actions
- Test connection button

---

### Task 5: Voice Services List Component

**Files:**

- Create: `apps/studio/src/components/settings/voice-services/VoiceServicesList.tsx`

Displays list of S2S provider cards with status and actions.

---

### Task 6: S2S Provider Card Component

**Files:**

- Create: `apps/studio/src/components/settings/voice-services/S2SProviderCard.tsx`

Individual provider card showing:

- Provider logo and name
- Configuration status (badge)
- Masked API key (last 4 chars)
- Test/Edit/Delete actions
- Link to provider docs

---

### Task 7: Configure S2S Modal

**Files:**

- Create: `apps/studio/src/components/settings/voice-services/ConfigureS2SModal.tsx`

Modal for entering/editing S2S provider credentials:

- API Key input (password field)
- Provider-specific fields (agent ID for ElevenLabs, etc.)
- Save/Cancel actions
- Info alert about encryption

---

### Task 8: S2S Provider Selector for Channels

**Files:**

- Create: `apps/studio/src/components/deployments/channels/S2SProviderSelector.tsx`

Provider selection component for channel configuration:

- Fetches available providers (those with API keys)
- Radio group for provider selection
- Shows "uses tenant credentials" badge
- Warning if no providers configured

---

### Task 9: S2S Config Fields Dispatcher

**Files:**

- Create: `apps/studio/src/components/deployments/channels/S2SConfigFields.tsx`

Routes to provider-specific configuration components based on selected provider.

---

### Task 10: Provider-Specific Configuration Components

**Files:**

- Create: `apps/studio/src/components/deployments/channels/OpenAIS2SFields.tsx`
- Create: `apps/studio/src/components/deployments/channels/ElevenLabsS2SFields.tsx`
- Create: `apps/studio/src/components/deployments/channels/GoogleS2SFields.tsx`

**OpenAI Fields:**

- Model dropdown (gpt-4o-realtime models)
- Voice dropdown (alloy, echo, shimmer, etc.)
- Temperature slider
- Advanced: Turn detection, silence duration, prefix padding

**ElevenLabs Fields:**

- Agent ID input (required)
- Conversation ID input (optional)
- Info alert linking to ElevenLabs dashboard

**Google Fields:**

- Model dropdown (gemini-2.0-flash-exp)
- Voice dropdown (Puck, Charon, Kore, etc.)
- Temperature slider

---

### Task 11: Update Channel Configuration Tab

**Files:**

- Modify: `apps/studio/src/components/deployments/channels/tabs/ConfigurationTab.tsx`

Update `VoiceFields` component to handle `voice_realtime` type:

```typescript
function VoiceFields({ channelType, config, setConfig }: FieldsProps) {
  const isRealtime = channelType === 'voice_realtime';

  if (isRealtime) {
    return (
      <>
        <S2SProviderSelector
          value={config.s2sProvider}
          onChange={(provider) => setConfig(prev => ({ ...prev, s2sProvider: provider }))}
        />
        {config.s2sProvider && (
          <S2SConfigFields provider={config.s2sProvider} config={config} setConfig={setConfig} />
        )}
      </>
    );
  }

  // Existing pipeline/VXML logic...
}
```

---

### UI Implementation Timeline

**Week 1: Tenant Voice Services**

- Days 1-2: Tasks 8-9 (Data model + API endpoints)
- Days 3-4: Tasks 10-14 (Studio pages and components)
- Day 5: Testing, encryption integration

**Week 2: Channel Configuration**

- Days 1-2: Tasks 15-16 (Provider selector + dispatcher)
- Days 3-4: Task 17 (Provider-specific fields)
- Day 5: Task 18 (Integration + testing)

---

### User Flow Example

**First-Time Setup:**

1. Navigate to Settings → Voice Services
2. See all providers showing "Not Configured"
3. Click "Configure" on OpenAI
4. Enter API key: `sk-proj-...`
5. Click "Test Connection" → Success ✅
6. Save → OpenAI shows "Configured" with `***proj-xyz`

**Create S2S Channel:**

1. Navigate to project → deployments → Create Channel
2. Select type: "Realtime Voice (S2S)"
3. Phone number dropdown appears
4. Provider selector shows: OpenAI ✅, Google ✅ (only configured)
5. Select OpenAI
6. Configure: Model (gpt-4o-realtime), Voice (alloy), Temperature (0.8)
7. Expand "Advanced Settings" → Turn Detection (Server VAD), Silence (700ms)
8. Click "Create Channel"
9. Backend provisions KoreVG + phone number
10. Channel created successfully

---

### Security Considerations

1. **API Key Encryption:**
   - All API keys encrypted at rest using `EncryptionService`
   - Never sent to frontend unencrypted
   - Masked in UI (show last 4 characters only)

2. **Tenant Isolation:**
   - All queries filtered by `tenantId`
   - Cannot access other tenant's credentials
   - Row-level security in MongoDB

3. **Audit Logging:**
   - Log all credential changes
   - Log test connection attempts
   - Track which users configured services

---

## Agent Flow Integration with S2S

### Overview

S2S sessions execute **agent flows** defined in ABL's Agent Builder, similar to Pipeline Voice. Each agent has:

- **Instructions**: System prompts and behavior guidelines
- **Tools**: Available functions the agent can call
- **Constraints**: Runtime validation rules (content filters, guardrails)
- **Handoff Configuration**: Rules for transferring to other agents

The `AgentIR` (Agent Intermediate Representation) encapsulates these definitions and is passed to `S2SRealtimeMode` to orchestrate the S2S session.

---

### Agent Definition Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Builder (Studio)                    │
│  - Instructions: "You are a customer support agent..."          │
│  - Tools: [checkOrderStatus, createTicket, transferToHuman]     │
│  - Constraints: [no_pii_logging, profanity_filter]              │
│  - Handoffs: [escalation_agent, sales_agent]                    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              │ Compiled to AgentIR
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          AgentIR Object                          │
│  {                                                               │
│    id: 'agent_abc123',                                           │
│    instructions: 'You are a customer support agent...',          │
│    tools: [ { name: 'checkOrderStatus', schema: {...} } ],      │
│    constraints: [ { type: 'content_filter', rules: {...} } ],   │
│    handoffs: [ { targetAgentId: 'escalation_agent', ... } ]     │
│  }                                                               │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              │ Passed to S2S session
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    S2SRealtimeMode Constructor                   │
│  new S2SRealtimeMode(provider, session, agentIR)                │
└─────────────────────────────────────────────────────────────────┘
```

---

### 1. System Prompt Building

**Method:** `buildSystemPrompt(): string`

**Location:** `korevg-session.ts` (already exists for pipeline voice)

**Purpose:** Converts agent instructions into S2S provider-compatible system prompts.

**Implementation:**

```typescript
private buildSystemPrompt(): string {
  // Extract base instructions from AgentIR
  let systemPrompt = this.agentIR.instructions;

  // Add constraint-based instructions
  if (this.agentIR.constraints) {
    for (const constraint of this.agentIR.constraints) {
      if (constraint.type === 'content_filter') {
        systemPrompt += '\n\nIMPORTANT: Do not discuss sensitive topics including: ';
        systemPrompt += constraint.blockedTopics.join(', ');
      }
      if (constraint.type === 'response_length') {
        systemPrompt += `\n\nKeep responses under ${constraint.maxTokens} tokens.`;
      }
    }
  }

  // Add handoff instructions
  if (this.agentIR.handoffs && this.agentIR.handoffs.length > 0) {
    systemPrompt += '\n\nYou can transfer the caller to:';
    for (const handoff of this.agentIR.handoffs) {
      systemPrompt += `\n- ${handoff.targetAgentId}: ${handoff.description}`;
    }
    systemPrompt += '\n\nUse the `handoff` tool to transfer.';
  }

  // Add metadata context (optional)
  systemPrompt += `\n\nSession Info: Tenant=${this.tenantId}, Project=${this.projectId}`;

  return systemPrompt;
}
```

**Provider Mapping:**

| Provider   | System Prompt Field               |
| ---------- | --------------------------------- |
| OpenAI     | `session.create.instructions`     |
| ElevenLabs | `agentConfig.prompt`              |
| Google     | `systemInstruction.text`          |
| Deepgram   | Not supported (uses model tuning) |
| Ultravox   | `systemPrompt`                    |

---

### 2. Tool Definitions Translation

**Method:** `buildToolDefinitions(): ToolDefinition[]`

**Location:** `korevg-session.ts` (already exists for pipeline voice)

**Purpose:** Converts ABL tool definitions to provider-specific function schemas.

**Implementation:**

```typescript
private buildToolDefinitions(): ToolDefinition[] {
  const ablTools: ToolDefinition[] = [];

  // Extract tools from AgentIR
  for (const tool of this.agentIR.tools) {
    ablTools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema, // JSON Schema
    });
  }

  // Add built-in handoff tool if handoffs configured
  if (this.agentIR.handoffs && this.agentIR.handoffs.length > 0) {
    ablTools.push({
      name: 'handoff',
      description: 'Transfer the caller to another agent',
      parameters: {
        type: 'object',
        properties: {
          targetAgentId: {
            type: 'string',
            enum: this.agentIR.handoffs.map(h => h.targetAgentId),
            description: 'ID of the agent to transfer to',
          },
          reason: {
            type: 'string',
            description: 'Reason for the transfer',
          },
        },
        required: ['targetAgentId'],
      },
    });
  }

  return ablTools;
}
```

**Provider Translation:**

Each `S2SProvider` implementation has a `buildToolDefinitions()` method that translates ABL tools:

```typescript
// OpenAI S2S Provider
buildToolDefinitions(tools: ToolDefinition[]): unknown {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters, // OpenAI uses JSON Schema directly
  }));
}

// ElevenLabs S2S Provider
buildToolDefinitions(tools: ToolDefinition[]): unknown {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: this.convertToElevenLabsSchema(tool.parameters),
  }));
}

// Google Gemini Provider
buildToolDefinitions(tools: ToolDefinition[]): unknown {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'OBJECT',
      properties: this.convertToGoogleSchema(tool.parameters.properties),
      required: tool.parameters.required,
    },
  }));
}
```

---

### 3. Tool Execution Flow

**Component:** `ToolExecutor` class

**Location:** `apps/runtime/src/services/voice/tool-executor.ts` (shared with pipeline voice)

**Purpose:** Executes tool calls received from S2S providers against ABL runtime.

**Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. S2S Provider emits tool_call event                          │
│     { type: 'tool_call', toolCallId: 'call_123',                │
│       toolName: 'checkOrderStatus', arguments: {orderId: '456'}}│
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. S2SRealtimeMode.handleToolCall()                            │
│     - Validates tool exists in agentIR                          │
│     - Checks constraints (rate limits, allowed tools)           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. ToolExecutor.execute(toolName, arguments)                   │
│     - Resolves tool definition from agentIR                     │
│     - Executes via ABL runtime (HTTP, MCP, or internal)         │
│     - Returns result: { success, data, error }                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Provider.handleToolResult(toolCallId, result)               │
│     - Formats result for provider (OpenAI vs ElevenLabs format) │
│     - Returns provider-specific payload                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Send tool result to S2S provider via WebSocket              │
│     session.sendLlmClientEvent(toolResultPayload)               │
└─────────────────────────────────────────────────────────────────┘
```

**Example Implementation:**

```typescript
// In S2SRealtimeMode
private async handleToolCall(event: S2SToolCallEvent): Promise<void> {
  try {
    // Validate tool exists in agent
    const toolDef = this.agentIR.tools.find(t => t.name === event.toolName);
    if (!toolDef) {
      throw new Error(`Tool ${event.toolName} not found in agent definition`);
    }

    // Check constraints
    await this.checkToolConstraints(event.toolName);

    // Execute tool
    const result = await this.toolExecutor.execute(
      event.toolName,
      event.arguments,
      {
        tenantId: this.session.tenantId,
        projectId: this.session.projectId,
        sessionId: this.session.sessionId,
      }
    );

    // Format result for provider
    const toolResult = this.provider.handleToolResult(event.toolCallId, result);

    // Send back to S2S provider
    await this.session.sendLlmClientEvent(toolResult);

    // Emit observability event
    this.eventHandler.emitToolInvoked({
      toolName: event.toolName,
      executionTimeMs: result.executionTimeMs,
      success: result.success,
    });

  } catch (err) {
    const errorResult = this.provider.handleToolResult(event.toolCallId, {
      success: false,
      error: { code: 'tool_execution_failed', message: String(err) },
    });
    await this.session.sendLlmClientEvent(errorResult);
  }
}
```

---

### 4. Constraint Checking

**Purpose:** Enforce agent constraints during S2S sessions (content filters, rate limits, allowed actions).

**Implementation:**

```typescript
// In S2SRealtimeMode
private async checkToolConstraints(toolName: string): Promise<void> {
  if (!this.agentIR.constraints) return;

  for (const constraint of this.agentIR.constraints) {
    if (constraint.type === 'allowed_tools') {
      if (!constraint.allowedTools.includes(toolName)) {
        throw new Error(`Tool ${toolName} not allowed by agent constraints`);
      }
    }

    if (constraint.type === 'rate_limit') {
      const callCount = await this.getRateLimitCount(toolName, constraint.windowMs);
      if (callCount >= constraint.maxCalls) {
        throw new Error(`Rate limit exceeded for tool ${toolName}`);
      }
    }
  }
}

// Content filtering happens on transcripts
private async checkContentConstraints(transcript: string): Promise<boolean> {
  if (!this.agentIR.constraints) return true;

  for (const constraint of this.agentIR.constraints) {
    if (constraint.type === 'content_filter') {
      for (const blockedTerm of constraint.blockedTerms) {
        if (transcript.toLowerCase().includes(blockedTerm.toLowerCase())) {
          // Emit warning event
          this.eventHandler.emitConstraintViolation({
            constraintType: 'content_filter',
            violationType: 'blocked_term',
            transcript, // May contain PII - mark appropriately
          });
          return false;
        }
      }
    }
  }

  return true;
}
```

**Constraint Types:**

| Constraint Type   | Enforcement Point          | Action                        |
| ----------------- | -------------------------- | ----------------------------- |
| `allowed_tools`   | Before tool execution      | Block tool call, return error |
| `rate_limit`      | Before tool execution      | Block if limit exceeded       |
| `content_filter`  | On transcript delta events | Warn, log, or disconnect      |
| `response_length` | In system prompt           | LLM self-regulates            |
| `max_turn_count`  | On turn completion         | Graceful session end          |

---

### 5. Agent Handoffs

**Purpose:** Transfer the caller from one agent to another mid-session (e.g., tier-1 → tier-2 escalation).

**Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. LLM decides to handoff and calls `handoff` tool             │
│     { toolName: 'handoff', arguments: {                         │
│       targetAgentId: 'escalation_agent',                        │
│       reason: 'Customer wants refund'                           │
│     }}                                                           │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. ToolExecutor recognizes built-in `handoff` tool             │
│     - Load target agent definition from database                │
│     - Validate handoff is allowed (check agentIR.handoffs)      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. S2SRealtimeMode.performHandoff(targetAgentId)               │
│     - Build new system prompt from target agent                 │
│     - Build new tool definitions from target agent              │
│     - Call provider.updateSession() to change instructions      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Provider sends session.update to S2S service                │
│     - OpenAI: session.update with new instructions/tools        │
│     - ElevenLabs: Update conversation config via API            │
│     - Google: Not supported (requires new session)              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Session continues with new agent configuration              │
│     - New system prompt, tools, constraints active              │
│     - Conversation history preserved (provider-dependent)       │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation:**

```typescript
// In ToolExecutor
async execute(toolName: string, args: unknown, context: ExecutionContext): Promise<ToolResult> {
  // Handle built-in handoff tool
  if (toolName === 'handoff') {
    const { targetAgentId, reason } = args as { targetAgentId: string; reason?: string };
    return await this.executeHandoff(targetAgentId, reason, context);
  }

  // Normal tool execution
  const tool = this.agentIR.tools.find(t => t.name === toolName);
  // ... execute tool
}

private async executeHandoff(
  targetAgentId: string,
  reason: string | undefined,
  context: ExecutionContext
): Promise<ToolResult> {
  // Load target agent
  const targetAgent = await this.agentService.getAgent(
    context.tenantId,
    context.projectId,
    targetAgentId
  );

  if (!targetAgent) {
    return {
      success: false,
      error: { code: 'agent_not_found', message: `Agent ${targetAgentId} not found` },
    };
  }

  // Trigger handoff in S2SRealtimeMode
  await this.s2sMode.performHandoff(targetAgent, reason);

  return {
    success: true,
    data: { message: `Transferred to ${targetAgent.name}`, targetAgentId },
  };
}
```

```typescript
// In S2SRealtimeMode
async performHandoff(targetAgent: AgentIR, reason?: string): Promise<void> {
  // Update internal agentIR reference
  const previousAgentId = this.agentIR.id;
  this.agentIR = targetAgent;

  // Rebuild tool executor with new agent
  this.toolExecutor = new ToolExecutor(targetAgent);

  // Build new configuration
  const newInstructions = this.session.buildSystemPrompt(); // Uses new agentIR
  const newTools = this.session.buildToolDefinitions(); // Uses new agentIR

  // Update S2S session
  await this.provider.updateSession(this.currentSessionId!, {
    instructions: newInstructions,
    tools: newTools,
  });

  // Emit observability event
  this.eventHandler.emitAgentHandoff({
    fromAgentId: previousAgentId,
    toAgentId: targetAgent.id,
    reason,
  });
}
```

**Provider Support:**

| Provider   | Session Update Support | Notes                                      |
| ---------- | ---------------------- | ------------------------------------------ |
| OpenAI     | ✅ Yes                 | `session.update` event                     |
| ElevenLabs | ✅ Yes                 | Update conversation config via REST API    |
| Google     | ❌ No                  | Requires new session (workaround: restart) |
| Deepgram   | ⚠️ Limited             | System prompt only                         |
| Ultravox   | ✅ Yes                 | `update_config` message                    |

---

### 6. Integration Points

**Existing KorevgSession Methods (Reused):**

```typescript
// These methods already exist for pipeline voice and are reused for S2S

class KorevgSession {
  private agentIR: AgentIR; // Set during session initialization

  // Called during S2S session start
  private buildSystemPrompt(): string {
    // Converts agentIR.instructions → S2S system prompt
  }

  private buildToolDefinitions(): ToolDefinition[] {
    // Converts agentIR.tools → S2S tool definitions
  }

  // Called during agent loading
  private async loadAgentForProject(projectId: string, agentId: string): Promise<AgentIR> {
    // Fetches agent definition from MongoDB
    // Returns compiled AgentIR
  }
}
```

**New S2S-Specific Methods:**

```typescript
// Send client events to S2S provider (tool results, interruptions)
async sendLlmClientEvent(payload: unknown): Promise<void> {
  // Formats as KoreVG client.event and sends via WebSocket
}

// Update S2S session configuration (for handoffs)
async updateS2SSession(updates: SessionUpdate): Promise<void> {
  // Routes to appropriate S2S provider's updateSession method
}
```

---

### Summary: Agent Flow Lifecycle in S2S

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Voice call arrives → KorevgSession created                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Load channel config                                          │
│     - Detects s2s.provider = 'openai'                           │
│     - Loads agentId from channel config                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Load Agent Definition                                        │
│     agentIR = loadAgentForProject(projectId, agentId)           │
│     - instructions: "You are a support agent..."                │
│     - tools: [checkOrder, createTicket, handoff]                │
│     - constraints: [content_filter, rate_limit]                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Create S2SRealtimeMode                                      │
│     s2sMode = new S2SRealtimeMode(provider, session, agentIR)   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. Start S2S Session                                            │
│     s2sMode.start({                                             │
│       instructions: buildSystemPrompt(),  // From agentIR       │
│       tools: buildToolDefinitions(),      // From agentIR       │
│       voice, model, temperature...                              │
│     })                                                          │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  6. Runtime: Tool calls & constraint checks                     │
│     - LLM calls tools → ToolExecutor executes                   │
│     - Transcripts checked against content filters               │
│     - Rate limits enforced                                      │
│     - Handoffs trigger agent switch + session.update            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  7. Session ends → voice.session.ended event emitted            │
│     - Final metrics calculated                                  │
│     - Conversation stored (if configured)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Key Takeaway:** S2S sessions execute agent flows identically to Pipeline Voice, with the same agent definitions (instructions, tools, constraints, handoffs) driving the conversation. The only difference is the execution layer: S2S sends these configurations directly to the realtime LLM provider, while Pipeline Voice executes them step-by-step via STT → LLM → TTS.

---

---

---

## Backend Implementation

### Task 12: S2S Provider Abstraction

**Files:**

- Create: `apps/runtime/src/services/voice/s2s/S2SProvider.ts`
- Create: `apps/runtime/src/services/voice/s2s/types.ts`

**S2SProvider Interface:**

```typescript
export interface S2SProvider {
  readonly vendor: string;
  readonly supportedFeatures: S2SFeatures;

  // Session lifecycle
  createSession(config: S2SSessionConfig): Promise<S2SSessionInfo>;
  updateSession(sessionId: string, updates: S2SSessionUpdate): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;

  // Tool integration
  buildToolDefinitions(tools: ToolDefinition[]): unknown;
  handleToolResult(toolCallId: string, result: unknown): unknown;

  // Event handling
  parseServerEvent(event: unknown): S2SServerEvent | null;
  shouldForwardEvent(event: S2SServerEvent): boolean;
}

export interface S2SSessionConfig {
  instructions: string;
  tools?: ToolDefinition[];
  voice?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  turnDetection?: TurnDetectionConfig;
  // Provider-specific options
  providerOptions?: Record<string, unknown>;
}

export interface S2SFeatures {
  toolCalling: boolean;
  interruption: boolean;
  sessionUpdate: boolean;
  customVoices: boolean;
  streaming: boolean;
}
```

**Base Implementation:**

```typescript
export abstract class BaseS2SProvider implements S2SProvider {
  constructor(
    protected readonly config: S2SProviderConfig,
    protected readonly logger: Logger,
  ) {}

  abstract get vendor(): string;
  abstract get supportedFeatures(): S2SFeatures;
  abstract createSession(config: S2SSessionConfig): Promise<S2SSessionInfo>;
  abstract buildToolDefinitions(tools: ToolDefinition[]): unknown;

  // Common utilities
  protected generateSessionId(): string {
    return `s2s_${randomUUID()}`;
  }

  protected validateConfig(): void {
    // Common validation logic
  }
}
```

---

### Task 13: OpenAI S2S Provider

**Files:**

- Create: `apps/runtime/src/services/voice/s2s/providers/OpenAIS2SProvider.ts`
- Migrate: Logic from existing `voice_realtime` implementation

**Implementation:**

```typescript
export class OpenAIS2SProvider extends BaseS2SProvider {
  readonly vendor = 'openai';
  readonly supportedFeatures: S2SFeatures = {
    toolCalling: true,
    interruption: true,
    sessionUpdate: true,
    customVoices: false,
    streaming: true,
  };

  async createSession(config: S2SSessionConfig): Promise<S2SSessionInfo> {
    const payload = {
      type: 'session.create',
      model: config.model || 'gpt-4o-realtime-preview-2024-12-17',
      instructions: config.instructions,
      voice: config.voice || 'alloy',
      tools: this.buildToolDefinitions(config.tools || []),
      turn_detection: config.turnDetection,
    };

    return {
      sessionId: this.generateSessionId(),
      KoreVGVerb: {
        verb: 'llm',
        vendor: 'openai',
        model: payload.model,
        apiKey: this.config.apiKey,
        sessionCreate: payload,
      },
    };
  }

  buildToolDefinitions(tools: ToolDefinition[]): unknown {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  parseServerEvent(event: unknown): S2SServerEvent | null {
    const e = event as Record<string, unknown>;

    switch (e.type) {
      case 'response.output_item.done':
        if (e.item?.type === 'function_call') {
          return {
            type: 'tool_call',
            toolCallId: e.item.call_id,
            toolName: e.item.name,
            arguments: JSON.parse(e.item.arguments),
          };
        }
        break;

      case 'response.audio_transcript.delta':
        return {
          type: 'transcript',
          role: 'assistant',
          text: e.delta,
          isFinal: false,
        };

      case 'input_audio_buffer.speech_started':
        return { type: 'speech_started' };

      case 'error':
        return {
          type: 'error',
          error: e.error,
        };
    }

    return null;
  }
}
```

---

### Task 14: ElevenLabs S2S Provider

**Files:**

- Create: `apps/runtime/src/services/voice/s2s/providers/ElevenLabsS2SProvider.ts`

**Key Differences from OpenAI:**

- Agent ID instead of model
- Conversation ID for session continuity
- Different tool definition format
- Different event names

```typescript
export class ElevenLabsS2SProvider extends BaseS2SProvider {
  readonly vendor = 'elevenlabs';
  readonly supportedFeatures: S2SFeatures = {
    toolCalling: true,
    interruption: true,
    sessionUpdate: false, // ElevenLabs doesn't support mid-session updates
    customVoices: true,
    streaming: true,
  };

  async createSession(config: S2SSessionConfig): Promise<S2SSessionInfo> {
    const agentId = config.providerOptions?.agentId as string;
    if (!agentId) {
      throw new Error('ElevenLabs requires agentId in providerOptions');
    }

    return {
      sessionId: this.generateSessionId(),
      KoreVGVerb: {
        verb: 'llm',
        vendor: 'elevenlabs',
        agentId,
        apiKey: this.config.apiKey,
        conversationId: config.providerOptions?.conversationId,
        // ElevenLabs doesn't accept instructions in session.create
        // They must be configured in the agent on ElevenLabs dashboard
      },
    };
  }

  buildToolDefinitions(tools: ToolDefinition[]): unknown {
    // ElevenLabs uses a different tool format
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required || [],
      },
    }));
  }

  parseServerEvent(event: unknown): S2SServerEvent | null {
    const e = event as Record<string, unknown>;

    // ElevenLabs event structure differs from OpenAI
    switch (e.type) {
      case 'agent_response':
        if (e.text) {
          return {
            type: 'transcript',
            role: 'assistant',
            text: e.text,
            isFinal: true,
          };
        }
        break;

      case 'tool_call':
        return {
          type: 'tool_call',
          toolCallId: e.tool_call_id,
          toolName: e.tool_name,
          arguments: e.parameters,
        };

      case 'user_speech_started':
        return { type: 'speech_started' };

      case 'error':
        return {
          type: 'error',
          error: e.message,
        };
    }

    return null;
  }
}
```

---

### Task 15: Google Gemini S2S Provider

**Files:**

- Create: `apps/runtime/src/services/voice/s2s/providers/GoogleS2SProvider.ts`

```typescript
export class GoogleS2SProvider extends BaseS2SProvider {
  readonly vendor = 'google';
  readonly supportedFeatures: S2SFeatures = {
    toolCalling: true,
    interruption: true,
    sessionUpdate: true,
    customVoices: true,
    streaming: true,
  };

  async createSession(config: S2SSessionConfig): Promise<S2SSessionInfo> {
    return {
      sessionId: this.generateSessionId(),
      KoreVGVerb: {
        verb: 'llm',
        vendor: 'google',
        model: config.model || 'gemini-2.0-flash-exp',
        apiKey: this.config.apiKey,
        systemInstruction: config.instructions,
        tools: this.buildToolDefinitions(config.tools || []),
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: config.voice || 'Puck',
          },
        },
      },
    };
  }

  buildToolDefinitions(tools: ToolDefinition[]): unknown {
    return tools.map((tool) => ({
      functionDeclarations: [
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      ],
    }));
  }

  parseServerEvent(event: unknown): S2SServerEvent | null {
    const e = event as Record<string, unknown>;

    // Google's event structure
    if (e.serverContent) {
      const content = e.serverContent as Record<string, unknown>;

      if (content.modelTurn) {
        const turn = content.modelTurn as Record<string, unknown>;

        if (turn.parts) {
          const parts = turn.parts as Array<Record<string, unknown>>;

          for (const part of parts) {
            if (part.functionCall) {
              return {
                type: 'tool_call',
                toolCallId: part.functionCall.id,
                toolName: part.functionCall.name,
                arguments: part.functionCall.args,
              };
            }

            if (part.text) {
              return {
                type: 'transcript',
                role: 'assistant',
                text: part.text,
                isFinal: true,
              };
            }
          }
        }
      }

      if (content.turnComplete) {
        return { type: 'turn_complete' };
      }
    }

    return null;
  }
}
```

---

### Task 16: S2SRealtimeMode Session Manager

**Files:**

- Create: `apps/runtime/src/services/voice/s2s/S2SRealtimeMode.ts`
- Refactor: Extract logic from existing `KorevgSession`

```typescript
export class S2SRealtimeMode {
  private provider: S2SProvider;
  private session: KorevgSession;
  private toolExecutor: ToolExecutor;
  private currentSessionId: string | null = null;
  private eventHandlers: Map<string, Function> = new Map();

  constructor(provider: S2SProvider, session: KorevgSession, agentIR: AgentIR) {
    this.provider = provider;
    this.session = session;
    this.toolExecutor = new ToolExecutor(agentIR);
  }

  async start(config: S2SSessionConfig): Promise<void> {
    // Create S2S session with provider
    const sessionInfo = await this.provider.createSession(config);
    this.currentSessionId = sessionInfo.sessionId;

    // Build KoreVG verb
    const verb = this.buildLlmVerb(sessionInfo);

    // Send to KoreVG via KorevgSession
    await this.session.sendVerb(verb);

    // Register event handlers
    this.session.on('llm:event', this.handleLlmEvent.bind(this));
  }

  private buildLlmVerb(sessionInfo: S2SSessionInfo): KoreVGVerb {
    return {
      verb: 'llm',
      vendor: this.provider.vendor,
      ...sessionInfo.KoreVGVerb,
      eventHook: this.getEventHookUrl(),
      actionHook: this.getActionHookUrl(),
    };
  }

  private async handleLlmEvent(event: unknown): Promise<void> {
    const parsedEvent = this.provider.parseServerEvent(event);

    if (!parsedEvent) return;

    switch (parsedEvent.type) {
      case 'tool_call':
        await this.handleToolCall(parsedEvent);
        break;

      case 'transcript':
        this.emit('transcript', parsedEvent);
        break;

      case 'speech_started':
        this.emit('interrupted');
        break;

      case 'error':
        this.emit('error', new Error(parsedEvent.error));
        break;
    }
  }

  private async handleToolCall(event: S2SToolCallEvent): Promise<void> {
    try {
      const result = await this.toolExecutor.execute(event.toolName, event.arguments);

      const toolResult = this.provider.handleToolResult(event.toolCallId, result);

      // Send tool result back to LLM
      await this.session.sendLlmClientEvent(toolResult);
    } catch (error) {
      this.logger.error('Tool execution failed', { error, event });
      // Send error back to LLM
      const errorResult = this.provider.handleToolResult(event.toolCallId, {
        error: error.message,
      });
      await this.session.sendLlmClientEvent(errorResult);
    }
  }

  async updateSession(updates: S2SSessionUpdate): Promise<void> {
    if (!this.provider.supportedFeatures.sessionUpdate) {
      throw new Error(`${this.provider.vendor} does not support session updates`);
    }

    await this.provider.updateSession(this.currentSessionId!, updates);

    // Send session.update client event to KoreVG
    const updateEvent = this.buildSessionUpdateEvent(updates);
    await this.session.sendLlmClientEvent(updateEvent);
  }

  async stop(): Promise<void> {
    if (this.currentSessionId) {
      await this.provider.deleteSession(this.currentSessionId);
      this.currentSessionId = null;
    }

    this.session.removeAllListeners('llm:event');
  }
}
```

---

### Task 17: Configuration Schema

**Files:**

- Modify: `packages/config/src/schemas/voice.schema.ts`
- Modify: `packages/database/src/models/channel-connection.model.ts`

**Add S2S Configuration:**

```typescript
// voice.schema.ts
const S2SProviderSchema = z.enum(['openai', 'elevenlabs', 'google', 'deepgram', 'ultravox']);

const S2SConfigSchema = z.object({
  provider: S2SProviderSchema,
  model: z.string().optional(),
  voice: z.string().optional(),
  apiKey: z.string().optional(),
  agentId: z.string().optional(), // For ElevenLabs
  conversationId: z.string().optional(), // For session continuity
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  turnDetection: z
    .object({
      type: z.enum(['server_vad', 'none']),
      threshold: z.number().optional(),
      prefixPaddingMs: z.number().optional(),
      silenceDurationMs: z.number().optional(),
    })
    .optional(),
});

// Add to VoiceConfigSchema
export const VoiceConfigSchema = z.object({
  // ... existing fields
  s2s: S2SConfigSchema.optional(),
});
```

---

### Task 18: Integration with KorevgSession

**Files:**

- Modify: `apps/runtime/src/services/voice/korevg/korevg-session.ts`

**Add S2S Mode Detection:**

```typescript
// In KorevgSession constructor or initialization
private async initializeVoiceMode(): Promise<void> {
  const channelConfig = await this.loadChannelConfig();

  if (channelConfig.s2s) {
    // S2S Realtime Mode
    const provider = this.createS2SProvider(channelConfig.s2s);
    this.voiceMode = new S2SRealtimeMode(
      provider,
      this,
      this.agentIR,
    );

    await (this.voiceMode as S2SRealtimeMode).start({
      instructions: this.buildSystemPrompt(),
      tools: this.buildToolDefinitions(),
      voice: channelConfig.s2s.voice,
      model: channelConfig.s2s.model,
      temperature: channelConfig.s2s.temperature,
      turnDetection: channelConfig.s2s.turnDetection,
      providerOptions: {
        agentId: channelConfig.s2s.agentId,
        conversationId: channelConfig.s2s.conversationId,
      },
    });
  } else if (channelConfig.realtime) {
    // Legacy OpenAI Realtime Mode (for backward compatibility)
    // ... existing logic
  } else {
    // Traditional STT → LLM → TTS Pipeline
    // ... existing logic
  }
}

private createS2SProvider(config: S2SConfig): S2SProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIS2SProvider({
        apiKey: config.apiKey || this.getOpenAIApiKey(),
      }, this.logger);

    case 'elevenlabs':
      return new ElevenLabsS2SProvider({
        apiKey: config.apiKey || this.getElevenLabsApiKey(),
      }, this.logger);

    case 'google':
      return new GoogleS2SProvider({
        apiKey: config.apiKey || this.getGoogleApiKey(),
      }, this.logger);

    case 'deepgram':
      return new DeepgramS2SProvider({
        apiKey: config.apiKey || this.getDeepgramApiKey(),
      }, this.logger);

    default:
      throw new Error(`Unsupported S2S provider: ${config.provider}`);
  }
}
```

---

## Technical Specifications

### S2S Provider Comparison

| Feature            | OpenAI Realtime | ElevenLabs CA | Google Gemini Live | Deepgram VA | Ultravox     |
| ------------------ | --------------- | ------------- | ------------------ | ----------- | ------------ |
| **Tool Calling**   | ✅ Yes          | ✅ Yes        | ✅ Yes             | ✅ Yes      | ✅ Yes       |
| **Interruption**   | ✅ Yes          | ✅ Yes        | ✅ Yes             | ✅ Yes      | ✅ Yes       |
| **Session Update** | ✅ Yes          | ❌ No         | ✅ Yes             | ❌ No       | ✅ Yes       |
| **Custom Voices**  | ❌ Fixed set    | ✅ Yes        | ✅ Yes             | ✅ Yes      | ❌ Fixed set |
| **Streaming**      | ✅ Yes          | ✅ Yes        | ✅ Yes             | ✅ Yes      | ✅ Yes       |
| **Model Choice**   | ✅ Yes          | ❌ Fixed      | ✅ Yes             | ❌ Fixed    | ✅ Yes       |
| **Temperature**    | ✅ Yes          | ❌ No         | ✅ Yes             | ❌ No       | ✅ Yes       |
| **Max Tokens**     | ✅ Yes          | ❌ No         | ❌ No              | ❌ No       | ✅ Yes       |

### Audio Specifications

All S2S providers expect:

- **Format:** Linear16 PCM
- **Sample Rate:** 16 kHz (can be 24 kHz for some providers)
- **Channels:** Mono (1 channel)
- **Encoding:** 16-bit signed little-endian

FreeSWITCH modules handle conversion via Speex resampler.

### Latency Targets

| Metric                      | Target  | Measurement                                   |
| --------------------------- | ------- | --------------------------------------------- |
| **Speech End to LLM Start** | < 100ms | Time from VAD detection to first LLM API call |
| **LLM First Token**         | < 200ms | Time from API call to first response token    |
| **TTS First Audio**         | < 100ms | Time from first token to first audio chunk    |
| **End-to-End Latency**      | < 400ms | Total time from speech end to audio playback  |

### API Rate Limits

Configure per-tenant rate limiting:

```typescript
const S2S_RATE_LIMITS = {
  openai: {
    requestsPerMinute: 100,
    tokensPerMinute: 100000,
  },
  elevenlabs: {
    requestsPerMinute: 60,
    charactersPerMonth: 100000,
  },
  google: {
    requestsPerMinute: 60,
    tokensPerMinute: 50000,
  },
};
```

---

## Testing Strategy

### Unit Tests

1. **S2SProvider Interface**
   - Test each provider's session lifecycle
   - Test tool definition building
   - Test event parsing

2. **S2SRealtimeMode**
   - Test tool execution flow
   - Test event routing
   - Test session update handling

3. **Command Builder**
   - Test KoreVG verb generation
   - Test provider-specific payloads

### Integration Tests

1. **Provider Integration**
   - Mock KoreVG WebSocket server
   - Test full session lifecycle
   - Test tool calling round-trip
   - Test error handling

2. **Multi-Provider**
   - Test switching between providers
   - Test provider-specific features

### E2E Tests

1. **Real Voice Calls**
   - Test with Twilio phone numbers
   - Test with real LLM providers (staging accounts)
   - Test latency measurements
   - Test interruption handling

2. **Load Testing**
   - Concurrent sessions (target: 50+ simultaneous)
   - Tool calling under load
   - Memory leak detection

### Test Plan Matrix

| Test Type   | OpenAI | ElevenLabs | Google | Coverage Target |
| ----------- | ------ | ---------- | ------ | --------------- |
| Unit        | ✅     | ✅         | ✅     | 80%             |
| Integration | ✅     | ✅         | ✅     | 70%             |
| E2E         | ✅     | ✅         | ✅     | Critical paths  |
| Load        | ✅     | ✅         | ✅     | 50 concurrent   |

---

## Rollout Plan

### Phase 1: Alpha (Internal Testing)

**Week 1-2:**

- Deploy to dev environment
- Internal team testing with OpenAI provider
- Fix critical bugs
- Performance baseline

**Criteria:**

- OpenAI S2S works end-to-end
- No regressions in existing voice modes
- < 500ms latency measured

### Phase 2: Beta (Select Customers)

**Week 3-4:**

- Deploy to staging environment
- Invite 5-10 beta customers
- Add ElevenLabs and Google providers
- Collect feedback and metrics

**Criteria:**

- All 3 providers working
- < 5% error rate
- Positive customer feedback

### Phase 3: GA (General Availability)

**Week 5-6:**

- Deploy to production
- Enable for all tenants
- Announce in release notes
- Monitor metrics closely

**Criteria:**

- < 1% error rate
- < 400ms p95 latency
- No customer-reported critical bugs

### Feature Flags

```typescript
const S2S_FEATURE_FLAGS = {
  's2s-enabled': {
    default: false,
    description: 'Enable S2S voice mode',
  },
  's2s-provider-openai': {
    default: true,
    description: 'Enable OpenAI S2S provider',
  },
  's2s-provider-elevenlabs': {
    default: false, // Beta
    description: 'Enable ElevenLabs S2S provider',
  },
  's2s-provider-google': {
    default: false, // Beta
    description: 'Enable Google S2S provider',
  },
};
```

---

## Risks & Mitigation

### Risk 1: Provider API Changes

**Risk:** LLM providers may change their S2S APIs without notice.

**Mitigation:**

- Abstract provider logic behind stable interface
- Monitor provider changelog and announcements
- Maintain version-specific provider implementations
- Automated tests against provider staging environments

### Risk 2: Latency Degradation

**Risk:** S2S latency may exceed targets under load or due to provider issues.

**Mitigation:**

- Comprehensive latency monitoring and alerting
- Automatic fallback to STT→LLM→TTS pipeline if latency > 1s
- Connection pre-warming and keep-alive
- Regional provider selection (if available)

### Risk 3: Tool Calling Inconsistencies

**Risk:** Different providers have different tool calling semantics.

**Mitigation:**

- Comprehensive unit tests for each provider's tool format
- Validation layer to catch malformed tool calls
- Detailed error messages for debugging
- Provider-specific documentation

### Risk 4: FreeSWITCH Module Compatibility

**Risk:** KoreVG FreeSWITCH modules may not be compatible with our deployment.

**Mitigation:**

- Test with exact FreeSWITCH version used in production
- Maintain forked versions of critical modules if needed
- Work with KoreVG team on compatibility issues
- Document module version requirements

### Risk 5: Cost Explosion

**Risk:** S2S mode may be significantly more expensive than pipeline mode.

**Mitigation:**

- Per-tenant usage quotas and alerts
- Cost monitoring dashboard
- Automatic mode switching based on usage patterns
- Customer communication about cost implications

---

## Success Metrics

### Technical Metrics

1. **Latency**
   - p50 < 300ms
   - p95 < 500ms
   - p99 < 800ms

2. **Reliability**
   - Uptime > 99.5%
   - Error rate < 1%
   - Successful tool call rate > 95%

3. **Performance**
   - Support 100+ concurrent sessions
   - CPU usage < 70% under normal load
   - Memory stable over 24h operation

### Business Metrics

1. **Adoption**
   - 20% of voice users try S2S within 1 month
   - 50% of S2S users continue using it after 1 week

2. **User Satisfaction**
   - Net Promoter Score > 8/10
   - < 5% churn due to S2S issues
   - Positive qualitative feedback

3. **Cost Efficiency**
   - S2S cost per minute < 1.5x pipeline mode
   - ROI positive within 3 months

---

## Next Steps

1. **Review & Approval**
   - Engineering review this plan
   - Product approval for scope and timeline
   - Security review for LLM provider integrations

2. **Kick-off**
   - Assign engineering resources
   - Set up project tracking
   - Create detailed task breakdown in Jira/Linear

3. **Execution**
   - Begin Phase 1 implementation
   - Weekly progress reviews
   - Adjust timeline based on learnings

---

## Appendices

### Appendix A: FreeSWITCH Module Commands

**OpenAI S2S:**

```
uuid_openai_s2s <uuid> session.create <host> <path> <auth-type> <api-key>
uuid_openai_s2s <uuid> client.event <client-event-json>
uuid_openai_s2s <uuid> session.delete
```

**ElevenLabs S2S:**

```
uuid_elevenlabs_s2s <uuid> session.create <agent-id> <api-key> [conversation-id]
uuid_elevenlabs_s2s <uuid> client.event <client-event-json>
uuid_elevenlabs_s2s <uuid> session.delete
```

**Google S2S:**

```
uuid_google_s2s <uuid> session.create <model> <api-key>
uuid_google_s2s <uuid> client.event <client-event-json>
uuid_google_s2s <uuid> session.delete
```

### Appendix B: KoreVG LLM Verb Syntax

```json
{
  "verb": "llm",
  "vendor": "openai|elevenlabs|google|deepgram|ultravox",
  "apiKey": "${API_KEY}",
  "model": "gpt-4o-realtime-preview",
  "voice": "alloy",
  "actionHook": "https://runtime.abl.com/voice/s2s/action",
  "eventHook": "https://runtime.abl.com/voice/s2s/event",
  "sessionCreate": {
    "type": "session.create",
    "instructions": "You are a helpful assistant...",
    "tools": [],
    "turn_detection": {
      "type": "server_vad",
      "silence_duration_ms": 700
    }
  }
}
```

### Appendix C: References

- [OpenAI Realtime API Documentation](https://platform.openai.com/docs/guides/realtime)
- [ElevenLabs Conversational AI Documentation](https://elevenlabs.io/docs/conversational-ai)
- [Google Gemini Live API Documentation](https://ai.google.dev/gemini-api/docs/live)
- [KoreVG LLM Verb Documentation](https://docs.KoreVG.org/en/latest/KoreVG-verbs/llm.html)
- [KoreVG GitHub Repository](https://github.com/KoreVG)
- [FreeSWITCH Media Bug API](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Introduction/Event-System/Media-Bug_13173520/)

---

**Document Version:** 1.0
**Last Updated:** 2026-03-09
**Author:** ABL Platform Team
**Reviewers:** [TBD]
