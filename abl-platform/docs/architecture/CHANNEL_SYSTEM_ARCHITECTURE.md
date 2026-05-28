# Channel System — Complete Architecture Document

> Comprehensive end-to-end reference for the ABL Agent Platform channel system.
> Covers: DSL syntax, compiler pipeline, runtime execution, channel adapters, inbound/outbound flows, identity, contacts, cross-channel continuity, Studio UI, streaming, actions, templates, and all known gaps.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Channel Type Inventory](#2-channel-type-inventory)
3. [ABL DSL Syntax](#3-abl-dsl-syntax)
4. [Compiler Pipeline (DSL → IR)](#4-compiler-pipeline-dsl--ir)
5. [IR Type Definitions](#5-ir-type-definitions)
6. [Template System](#6-template-system)
7. [Inbound Flow (Channel → Runtime)](#7-inbound-flow-channel--runtime)
8. [Outbound Flow (Runtime → Channel)](#8-outbound-flow-runtime--channel)
9. [Channel Adapters](#9-channel-adapters)
10. [Action System](#10-action-system)
11. [Rich Content & Format Selection](#11-rich-content--format-selection)
12. [Streaming Support](#12-streaming-support)
13. [Attachment & Media Processing](#13-attachment--media-processing)
14. [Voice System](#14-voice-system)
15. [Channel Registration & Connection Management](#15-channel-registration--connection-management)
16. [Session Resolution](#16-session-resolution)
17. [Identity Verification System](#17-identity-verification-system)
18. [Contact Management](#18-contact-management)
19. [Cross-Channel Continuity (Orchestration)](#19-cross-channel-continuity-orchestration)
20. [Studio UI — Channel Management](#20-studio-ui--channel-management)
21. [Studio UI — Unified Interface Review](#21-studio-ui--unified-interface-review)
22. [Test Coverage](#22-test-coverage)
23. [Known Gaps & Missing Pieces](#23-known-gaps--missing-pieces)
24. [Key File Index](#24-key-file-index)
25. [Channel OAuth](#25-channel-oauth)

---

## 1. Architecture Overview

The channel system spans four layers:

| Layer        | Responsibility                                                               | Key Artifacts        |
| ------------ | ---------------------------------------------------------------------------- | -------------------- |
| **ABL DSL**  | Author declares RESPOND + VOICE + FORMATS + ACTIONS                          | `.abl` source files  |
| **Compiler** | Parses DSL → AST → IR with `RichContentIR`, `VoiceConfigIR`, `ActionSetIR`   | `packages/compiler/` |
| **Runtime**  | Executes resolved IR, interpolates payloads, delivers responses via adapters | `apps/runtime/src/`  |
| **Studio**   | UI for channel configuration, connection management, testing                 | `apps/studio/src/`   |

### Three Channel Subsystems

| Subsystem               | Purpose                                  | Model                 | Route                           | Studio Surface      |
| ----------------------- | ---------------------------------------- | --------------------- | ------------------------------- | ------------------- |
| **SDK Channels**        | Web widget, mobile, API embeds           | `Channel`             | `routes/channels.ts`            | `SDKChannelsPanel`  |
| **Channel Connections** | External platforms (Slack, Teams, Email) | `ChannelConnection`   | `routes/channel-connections.ts` | `ChannelSetupPanel` |
| **HTTP Async**          | Webhook callback subscriptions           | `WebhookSubscription` | `routes/http-async-channels.ts` | `HttpAsyncPanel`    |

### Two Adapter Systems

| System                           | Purpose                                | Location                              | Adapters                                          |
| -------------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| **Voice Format Adapters**        | Select voice output format per engine  | `services/channel/channel-adapter.ts` | TextChannel, ElevenLabs, RealtimeVoice, SSMLVoice |
| **Channel Integration Adapters** | Full inbound/outbound message handling | `channels/adapters/*.ts`              | 9 adapters (see §9)                               |

---

## 2. Channel Type Inventory

### ChannelType Union (17 types)

Defined in `apps/runtime/src/channels/types.ts:15-19`:

| Category          | Types           | Description               |
| ----------------- | --------------- | ------------------------- |
| **Async/Webhook** | `http_async`    | Webhook callback delivery |
|                   | `slack`         | Slack Bot (Block Kit)     |
|                   | `whatsapp`      | WhatsApp Cloud API        |
|                   | `messenger`     | Facebook Messenger        |
|                   | `email`         | SMTP inbound/outbound     |
|                   | `msteams`       | Microsoft Teams Bot       |
|                   | `vxml`          | Voice XML / IVR           |
|                   | `jambonz`       | Jambonz voice platform    |
| **Realtime**      | `web_debug`     | Studio debug console      |
|                   | `web_chat`      | Web chat widget           |
|                   | `sdk_websocket` | SDK WebSocket client      |
|                   | `api`           | REST API                  |
|                   | `ag_ui`         | Agent-to-UI protocol      |
|                   | `voice`         | Generic voice             |
|                   | `voice_twilio`  | Twilio PSTN voice         |
|                   | `voice_livekit` | LiveKit WebRTC voice      |
|                   | `http`          | Synchronous HTTP          |

### Type Alignment Across Layers

| Layer                                     | Types Accepted                                                  | Count |
| ----------------------------------------- | --------------------------------------------------------------- | ----- |
| `ChannelType` union                       | All 17                                                          | 17    |
| `ChannelConnection` model enum            | `http_async`, `slack`, `email`, `msteams`, `vxml`, `jambonz`    | 6     |
| `channel-connections` CRUD route          | `slack`, `msteams`, `email`                                     | 3     |
| `channel-webhooks` route allowed set      | `slack`, `email`, `msteams`, `jambonz`, `whatsapp`, `messenger` | 6     |
| SDK `channels` CRUD route                 | `web`, `mobile_ios`, `mobile_android`, `voice`, `api`           | 5     |
| Studio `ChannelSetupPanel` type union     | `slack`, `msteams`, `email`                                     | 3     |
| Studio `CreateConnectionInput` type union | `slack`, `msteams`, `email`                                     | 3     |
| Channel adapter registry                  | 9 adapters registered                                           | 9     |

---

## 3. ABL DSL Syntax

### RESPOND Block

Every `RESPOND:` in the DSL supports three optional sub-blocks:

```
RESPOND: "Hello, {{name}}!"
  VOICE:
    SSML: "<speak>Hello <emphasis>{{name}}</emphasis></speak>"
    INSTRUCTIONS: "Speak warmly and slowly"
    PLAIN_TEXT: "Hello {{name}}"
  FORMATS:
    MARKDOWN: "# Hello, **{{name}}**!"
    SLACK: '{"blocks":[...]}'
    ADAPTIVE_CARD: '{"type":"AdaptiveCard",...}'
    WHATSAPP: '{"type":"text","text":{"body":"Hello"}}'
    AG_UI: '{"events":[...]}'
    HTML: "<h1>Hello, <b>{{name}}</b>!</h1>"
```

### Where RESPOND Appears

| Location                      | Description                   |
| ----------------------------- | ----------------------------- |
| Flow step `RESPOND:`          | Step-level response           |
| `ON_START:`                   | Agent entry response          |
| `COMPLETE:`                   | Completion condition response |
| `ON_ERROR:`                   | Error handler response        |
| `ON_INPUT:` branches          | Input-conditional responses   |
| `ON_SUCCESS:` / `ON_FAILURE:` | CALL result responses         |
| `DIGRESSION:`                 | Digression responses          |
| `SUB_INTENT:`                 | Sub-intent responses          |
| `GLOBAL_DIGRESSIONS:`         | Global digression responses   |

### VOICE Sub-Block Keys

| Key             | Type             | Purpose                                        |
| --------------- | ---------------- | ---------------------------------------------- |
| `SSML:`         | String/multiline | Speech Synthesis Markup Language               |
| `INSTRUCTIONS:` | String/multiline | Natural language instructions for voice engine |
| `PLAIN_TEXT:`   | String/multiline | Plain text fallback for voice                  |

### FORMATS Sub-Block Keys

| Key              | Type             | Target Platform              |
| ---------------- | ---------------- | ---------------------------- |
| `MARKDOWN:`      | String/multiline | Web, mobile, general-purpose |
| `ADAPTIVE_CARD:` | JSON string      | Microsoft Teams              |
| `HTML:`          | String/multiline | Email, web                   |
| `SLACK:`         | JSON string      | Slack (Block Kit)            |
| `AG_UI:`         | JSON string      | Agent-to-UI protocol         |
| `WHATSAPP:`      | JSON string      | WhatsApp interactive         |

### ACTIONS Block

```
ACTIONS:
  - BUTTON: "confirm" LABEL: "Confirm Booking" VALUE: "confirm"
  - BUTTON: "cancel" LABEL: "Cancel" VALUE: "cancel"
  - SELECT: "room_type" LABEL: "Room Type"
    OPTIONS:
      - "standard" LABEL: "Standard"
      - "deluxe" LABEL: "Deluxe"
  - INPUT: "notes" LABEL: "Special Requests"
    INPUT_TYPE: text
    PLACEHOLDER: "Any preferences?"
    REQUIRED: false
SUBMIT_LABEL: "Submit"
SUBMIT_ID: "submit_booking"
```

### ACTION_HANDLERS Block

```
ACTION_HANDLERS:
  - ACTION: "confirm"
    CONDITION: "booking_status == 'pending'"
    RESPOND: "Booking confirmed!"
      VOICE:
        INSTRUCTIONS: "Sound excited"
    SET:
      booking_status: "confirmed"
    TRANSITION: "confirmation_step"
```

### Named Templates

```
TEMPLATES:
  greeting:
    DEFAULT: "Hello, {{name}}!"
    MARKDOWN: "# Hello, **{{name}}**!"
    ADAPTIVE_CARD: '{"type":"AdaptiveCard",...}'
    SLACK: '{"blocks":[...]}'

# Standalone form:
TEMPLATE greeting: |
  Hello, {{name}}! Welcome to {{company}}.

# Usage (compile-time resolution):
RESPOND: TEMPLATE(greeting)
```

---

## 4. Compiler Pipeline (DSL → IR)

### Pipeline Stages

| Stage                 | Input                     | Output                       | Key File                                         |
| --------------------- | ------------------------- | ---------------------------- | ------------------------------------------------ |
| **Parse**             | ABL source text           | AST (camelCase)              | `packages/core/src/parser/agent-based-parser.ts` |
| **Compile**           | AST                       | IR (snake_case)              | `packages/compiler/src/platform/ir/compiler.ts`  |
| **Resolve Templates** | IR with `TEMPLATE()` refs | IR with resolved strings     | `compiler.ts:1461` (`resolveTemplateRef`)        |
| **Resolve Formats**   | Template with formats     | IR nodes with `rich_content` | `compiler.ts:1498` (`resolveFormats`)            |
| **Validate**          | Full IR                   | Warnings/errors              | Compiler warnings (W602, E601)                   |

### Parser Functions

| Function                 | Line                         | Purpose                                                    |
| ------------------------ | ---------------------------- | ---------------------------------------------------------- |
| `parseVoiceBlock()`      | `agent-based-parser.ts:3163` | Parses `VOICE:` sub-block (SSML, INSTRUCTIONS, PLAIN_TEXT) |
| `tryParseVoiceConfig()`  | `agent-based-parser.ts:3218` | Peeks for VOICE block after RESPOND                        |
| `parseFormatsBlock()`    | `agent-based-parser.ts:3240` | Parses `FORMATS:` sub-block (fixed built-in format keys)   |
| `tryParseFormatsBlock()` | `agent-based-parser.ts:3315` | Peeks for FORMATS block after VOICE/RESPOND                |

### Compiler Transforms

| Function                         | Line               | Purpose                                                      |
| -------------------------------- | ------------------ | ------------------------------------------------------------ |
| `compileRichContent(ast)`        | `compiler.ts:797`  | AST → IR: `adaptiveCard` → `adaptive_card`, `agUi` → `ag_ui` |
| `compileVoiceConfig(ast)`        | `compiler.ts:788`  | AST → IR: `plainText` → `plain_text`                         |
| `resolveTemplateRef(node)`       | `compiler.ts:1461` | Replaces `TEMPLATE(name)` with template content              |
| `resolveFormats(node, template)` | `compiler.ts:1498` | Copies template formats to `rich_content` if not already set |
| `resolveAllTemplateRefs(ir)`     | `compiler.ts:1486` | Walks entire IR tree resolving all template refs             |

### Template Resolution Rules

| Scenario                                                    | Result                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `RESPOND: TEMPLATE(greeting)` where `greeting` exists       | `respond` replaced with template content; `rich_content` set from template formats |
| `RESPOND: TEMPLATE(unknown)`                                | Error `E601`: undefined template reference                                         |
| Template defined but never referenced                       | Warning `W602`: unused template                                                    |
| Node already has explicit `rich_content` + `TEMPLATE()` ref | Template formats NOT applied (explicit wins)                                       |

---

## 5. IR Type Definitions

Source: `packages/compiler/src/platform/ir/schema.ts`

### VoiceConfigIR

```typescript
interface VoiceConfigIR {
  ssml?: string; // SSML markup
  instructions?: string; // Natural language voice instructions
  plain_text?: string; // Plain text fallback
}
```

### RichContentIR

```typescript
interface RichContentIR {
  markdown?: string; // Markdown text
  adaptive_card?: string; // Adaptive Card JSON (Teams)
  html?: string; // HTML content (email, web)
  slack?: string; // Block Kit JSON (Slack)
  ag_ui?: string; // AG-UI events JSON
  whatsapp?: string; // WhatsApp interactive JSON
}
```

### ActionElementIR

```typescript
interface ActionElementIR {
  id: string;
  type: 'button' | 'select' | 'input';
  label: string;
  value?: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  input_type?: 'text' | 'number' | 'date' | 'time' | 'email';
  placeholder?: string;
  required?: boolean;
}
```

### ActionSetIR

```typescript
interface ActionSetIR {
  elements: ActionElementIR[];
  submit_label?: string;
  submit_id?: string;
}
```

### ActionHandlerIR

```typescript
interface ActionHandlerIR {
  action_id: string;
  condition?: string;
  respond?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  set?: Record<string, string>;
  transition?: string;
}
```

### ExecutionResult (Runtime)

Source: `apps/runtime/src/services/execution/types.ts:132-139`

```typescript
interface ExecutionResult {
  response: string; // Interpolated text
  action: { type: string }; // Flow metadata
  stateUpdates?: Partial<RuntimeState>;
  voiceConfig?: VoiceConfigIR; // 3 voice variants
  richContent?: RichContentIR; // Built-in rich content schema
  actions?: ActionSetIR; // Interactive elements
}
```

### ChannelOutput (Discriminated Union)

Source: `apps/runtime/src/channels/types.ts:130-136`

```typescript
type ChannelOutput =
  | { kind: 'text'; text: string }
  | { kind: 'slack_blocks'; blocks: unknown[]; text: string }
  | { kind: 'adaptive_card'; card: unknown; text: string }
  | { kind: 'whatsapp_interactive'; interactive: unknown; text: string }
  | { kind: 'messenger_template'; message: unknown; text: string }
  | { kind: 'ag_ui_events'; events: Array<{ type: string; data: unknown }> };
```

### NormalizedIncomingMessage

```typescript
interface NormalizedIncomingMessage {
  externalMessageId: string;
  externalSessionKey: string;
  text: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
  actionEvent?: ActionEvent;
}
```

### NormalizedOutgoingMessage

```typescript
interface NormalizedOutgoingMessage {
  sessionId: string;
  text: string;
  eventType: WebhookEventType;
  metadata?: Record<string, unknown>;
}
```

### InboundJobPayload

```typescript
interface InboundJobPayload {
  connectionId: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId?: string | null;
  environment?: string | null;
  channelType: ChannelType;
  message: NormalizedIncomingMessage;
  subscriptionId: string;
  idempotencyKey: string;
}
```

### DeliveryJobPayload

```typescript
interface DeliveryJobPayload {
  deliveryId: string;
  subscriptionId: string;
  tenantId: string;
  eventType: WebhookEventType;
  payload: string;
}
```

### ResolvedConnection

```typescript
interface ResolvedConnection {
  id: string;
  tenantId: string;
  projectId: string;
  agentId: string | null;
  deploymentId?: string | null;
  environment?: string | null;
  channelType: ChannelType;
  externalIdentifier: string;
  credentials: ChannelCredentials | null;
  config: Record<string, unknown>;
  status: string;
}
```

### ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly channelType: ChannelType;
  readonly capabilities: ChannelCapabilities;
  verifyRequest(headers, body, rawBody?, connection?): Promise<boolean>;
  parseIncoming(payload: InboundJobPayload): NormalizedIncomingMessage;
  sendResponse(
    message: NormalizedOutgoingMessage,
    connection: ResolvedConnection,
  ): Promise<SendResult>;
  transformOutput?(text: string, actions?: ActionSetIR): ChannelOutput;
}
```

### ChannelCapabilities

```typescript
interface ChannelCapabilities {
  supportsAsync: boolean;
  supportsStreaming: boolean;
  supportsMedia: boolean;
  supportsThreading: boolean;
}
```

---

## 6. Template System

### Compile-Time Templates

| Feature                 | Details                                                     |
| ----------------------- | ----------------------------------------------------------- |
| **Definition**          | `TEMPLATES:` block or standalone `TEMPLATE name:`           |
| **Reference**           | `RESPOND: TEMPLATE(name)`                                   |
| **Resolution**          | Compile-time (before IR output)                             |
| **Pattern**             | `TEMPLATE_REF_PATTERN = /^TEMPLATE\((\w+)\)$/`              |
| **Format propagation**  | Template formats → node `rich_content` (if not already set) |
| **IR storage**          | `AgentIR.templates: Record<string, string>`                 |
| **Late runtime lookup** | Not supported                                               |
| **Error codes**         | `E601` (undefined ref), `W602` (unused template)            |

Once compilation succeeds, runtime no longer sees `TEMPLATE(name)` references. It receives resolved text, `richContent`, `voiceConfig`, and `actions` only. That is why `W602` is meaningful: a template that is defined but never referenced has no effect on execution today.

### Planned External `RENDERABLES` Contract (Draft)

The current template system is good for fixed platform-owned shapes such as `markdown`, `whatsapp`, `adaptive_card`, and other built-in `RichContentIR` fields. It is not a good fit for customer-defined external payload names because template names are compile-time only.

The planned extension is a first-class wire payload:

```typescript
interface RenderablePayload {
  name: string; // e.g. "com.bank.account_summary.v1"
  payload: unknown;
  targets?: string[]; // e.g. ["api", "sdk_websocket", "http_async"]
  fallback_text?: string;
  schema_ref?: string;
}
```

| Surface               | Current Structured Behavior                                                            | Planned `renderables[]` Behavior                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`                 | Returns `response`, `voiceConfig`, `richContent`, `actions` inline                     | Return `renderables[]` alongside those existing fields                                                                                            |
| `sdk_websocket`       | `response_end` carries `fullText`, `voiceConfig`, `richContent`, `actions`             | Add `renderables[]` to `response_end`                                                                                                             |
| Custom Web SDK client | Consumes `sdk_websocket` transport and renders built-in `RichContent` via the registry | Register renderers that match `message.renderables[].name`                                                                                        |
| `http_async`          | Webhook payload is currently text-oriented and omits raw `richContent`                 | Include `voiceConfig`, `richContent`, and `renderables[]` directly in the webhook body while keeping `channel_output` for backwards compatibility |

The Web SDK is not a separate runtime channel target. It is a client surface over `sdk_websocket`.

### Runtime Interpolation

Source: `apps/runtime/src/services/execution/value-resolution.ts`

| Syntax                        | Example                            | Purpose                                 |
| ----------------------------- | ---------------------------------- | --------------------------------------- |
| `{{variable}}`                | `{{name}}`                         | Simple substitution from session values |
| `{{variable.property}}`       | `{{booking.hotel}}`                | Dot-notation nested access              |
| `{{#if variable}}...{{/if}}`  | `{{#if isPremium}}VIP{{/if}}`      | Conditional block                       |
| `{{#each array}}...{{/each}}` | `{{#each items}}{{name}}{{/each}}` | Loop over array                         |
| `{{@index}}`                  | `{{@index}}`                       | Loop index (0-based)                    |
| `{{add @index N}}`            | `{{add @index 1}}`                 | Computed index                          |

### Interpolation Functions

| Function                              | Line   | Applied To                                          |
| ------------------------------------- | ------ | --------------------------------------------------- |
| `interpolateTemplate(template, data)` | `:11`  | Main response text                                  |
| `interpolateVoiceConfig(vc, data)`    | `:94`  | All 3 voice fields (ssml, instructions, plain_text) |
| `interpolateRichContent(rc, data)`    | `:108` | All populated `RichContentIR` fields                |
| `resolveSetValue(rawValue, context)`  | `:126` | SET assignment values                               |
| `resolveValuePath(expr, context)`     | `:151` | Dot-notation path resolution                        |

---

## 7. Inbound Flow (Channel → Runtime)

### Webhook Channels

```
External Platform
  → POST /api/v1/channels/:channelType/webhook                    (generic — identifier from body)
    POST /api/v1/channels/:channelType/webhook/:connectionIdentifier (explicit — identifier in URL)
  → Adapter lookup from registry                       [registry.ts]
  → Verification challenge check (Slack url_verification)
  → Event filter (shouldProcess — skip bot messages)
  → Extract external identifier (from URL param or body via adapter)
  → Resolve connection (externalIdentifier → ChannelConnection)
  → Signature verification (per-connection secrets)
  → Message normalization (buildNormalizedMessage)
  → BullMQ enqueue (channel-inbound queue)
  → 200 OK (< 3s for Slack ACK)
```

The **generic route** (no identifier in URL) extracts `team_id:api_app_id` from the
request body via `adapter.extractExternalIdentifier()`. This supports multi-workspace
Slack apps where a single Event Subscriptions URL receives events from all installed
workspaces. The **explicit route** uses the identifier from the URL path and is useful
for manual connection setup or backward compatibility.

### BullMQ Inbound Worker

```
Job received                                           [inbound-worker.ts]
  → Tenant context set (runWithTenantContext)
  → Dedup check (Redis SET NX, 1hr TTL) — first attempt only
  → HTTP Async retry recovery (re-enqueue existing delivery)
  → Connection resolution (resolveConnectionById)
  → Session resolution (resolveSession)
  → Per-session distributed lock (acquireSessionLock)
  → Runtime execution:
      - Action events → executeActionSubmit()
      - Text messages → executeMessage()
  → Execution timeout race (120s configurable)
  → Transform output (adapter.transformOutput)
  → Route response:
      - HTTP Async → Create WebhookDelivery + delivery queue
      - Direct channels → adapter.sendResponse()
  → Release session lock (or defer to TTL on timeout)
```

### Inbound Worker Configuration

| Setting           | Value                                         | Source                    |
| ----------------- | --------------------------------------------- | ------------------------- |
| Queue name        | `channel-inbound`                             | BullMQ                    |
| Concurrency       | 5                                             | `inbound-worker.ts:319`   |
| Retry attempts    | 3                                             | `channel-webhooks.ts:143` |
| Backoff           | Exponential, 2s base                          | `channel-webhooks.ts:144` |
| Dedup TTL         | 1 hour                                        | `inbound-worker.ts:353`   |
| Dedup key format  | `channel:dedup:{tenantId}:{idempotencyKey}`   | `inbound-worker.ts:352`   |
| Execution timeout | 120,000ms (env: `CHANNEL_EXECUTE_TIMEOUT_MS`) | `inbound-worker.ts:23`    |
| Session lock key  | `channel:lock:{runtimeSessionId}`             | `inbound-worker.ts:135`   |
| Job ID format     | `{channelType}-{tenantId}-{idempotencyKey}`   | `channel-webhooks.ts:142` |

### Realtime Channels (WebSocket)

```
Client WebSocket → /ws/sdk
  → SDK auth (session token or API key)
  → Session init (createRuntimeSession via pipeline)
  → Bidirectional messaging via WebSocket frames
  → Streaming: response_start → response_chunk* → response_end
```

### Webhook Route: Allowed Channel Types

| Channel Type | In Allowed Set | Adapter Registered |                  Webhook Processing                   |
| ------------ | :------------: | :----------------: | :---------------------------------------------------: |
| `slack`      |      Yes       |        Yes         | Full (event_callback, block_actions, view_submission) |
| `whatsapp`   |      Yes       |        Yes         |           Full (text, interactive replies)            |
| `msteams`    |      Yes       |        Yes         |                Full (message, invoke)                 |
| `email`      |      Yes       |        Yes         |          Via SMTP server (not HTTP webhook)           |
| `messenger`  |      Yes       |        Yes         |                 Full (text, postback)                 |
| `jambonz`    |      Yes       |        Yes         |                    Voice webhooks                     |
| `http_async` | No (own route) |        Yes         |       Via `/api/v1/channels/http-async/message`       |
| `vxml`       |       No       |        Yes         |             Not exposed via webhook route             |

---

## 8. Outbound Flow (Runtime → Channel)

### ExecutionResult Production

The flow step executor produces `ExecutionResult` at:

| Location            | File:Lines                        | What's Included                    |
| ------------------- | --------------------------------- | ---------------------------------- |
| Flow step response  | `flow-step-executor.ts:1791-1797` | response, voiceConfig, richContent |
| ON_START response   | `flow-step-executor.ts:172-178`   | response, voiceConfig, richContent |
| Collect/prompt      | `flow-step-executor.ts:1002-1012` | response, voiceConfig, richContent |
| Complete response   | `flow-step-executor.ts:1699-1706` | response, voiceConfig, richContent |
| Digression response | `flow-step-executor.ts:742-749`   | response, voiceConfig, richContent |
| ON_INPUT branch     | flow-step-executor.ts (various)   | response, voiceConfig, richContent |

### Transform Pipeline

```
ExecutionResult
  → interpolateTemplate(response, session.data.values)
  → interpolateVoiceConfig(voiceConfig, session.data.values)
  → interpolateRichContent(richContent, session.data.values)
  → adapter.transformOutput(text, actions)  →  ChannelOutput
  → adapter.sendResponse(outgoingMessage, connection)
```

### Delivery Methods by Channel Type

| Channel Type   | Delivery Method       | API/Endpoint                                                |
| -------------- | --------------------- | ----------------------------------------------------------- |
| **Slack**      | Direct API call       | `https://slack.com/api/chat.postMessage`                    |
| **WhatsApp**   | Direct API call       | `https://graph.facebook.com/v18.0/{phoneNumberId}/messages` |
| **MS Teams**   | Bot Framework         | Service URL from activity + OAuth2                          |
| **Email**      | nodemailer SMTP       | Configurable SMTP transport                                 |
| **Messenger**  | Send API              | `https://graph.facebook.com/v18.0/me/messages`              |
| **HTTP Async** | BullMQ delivery queue | Customer's callback URL                                     |
| **VXML**       | Inline response       | VoiceXML document returned                                  |
| **Jambonz**    | Inline response       | Jambonz JSON response                                       |
| **Web/SDK**    | WebSocket             | `response_start` → `response_chunk`\* → `response_end`      |
| **AG-UI**      | WebSocket             | AG-UI protocol events                                       |

### WebSocket Response Events

| Event            | Payload                                       | When Sent          |
| ---------------- | --------------------------------------------- | ------------------ |
| `response_start` | `{ session_id }`                              | Before first chunk |
| `response_chunk` | `{ text: string }`                            | Each text delta    |
| `response_end`   | `{ text, voiceConfig, richContent, actions }` | After all chunks   |

Planned extension: `response_end` gains `renderables` for named external payloads. Existing fields remain unchanged.

---

## 9. Channel Adapters

### Adapter Registry

Source: `apps/runtime/src/channels/registry.ts`

| Adapter            | File                             | Lines | channelType  |
| ------------------ | -------------------------------- | ----- | ------------ |
| `HttpAsyncAdapter` | `adapters/http-async-adapter.ts` | ~90   | `http_async` |
| `SlackAdapter`     | `adapters/slack-adapter.ts`      | 499   | `slack`      |
| `WhatsAppAdapter`  | `adapters/whatsapp-adapter.ts`   | 366   | `whatsapp`   |
| `MSTeamsAdapter`   | `adapters/msteams-adapter.ts`    | 402   | `msteams`    |
| `EmailAdapter`     | `adapters/email-adapter.ts`      | 91    | `email`      |
| `MessengerAdapter` | `adapters/messenger-adapter.ts`  | ~200  | `messenger`  |
| `VxmlAdapter`      | `adapters/vxml-adapter.ts`       | ~120  | `vxml`       |
| `JambonzAdapter`   | `adapters/jambonz-adapter.ts`    | ~100  | `jambonz`    |
| `AgUiAdapter`      | `adapters/ag-ui-adapter.ts`      | ~100  | `ag_ui`      |

### Adapter Capabilities

| Adapter   | Async | Streaming |                Media                | Threading |
| --------- | :---: | :-------: | :---------------------------------: | :-------: |
| HttpAsync |  Yes  |    No     |                 No                  |    No     |
| Slack     |  Yes  |  **Yes**  |                 Yes                 |    Yes    |
| WhatsApp  |  Yes  |    No     |                 Yes                 |    No     |
| MS Teams  |  Yes  |    No     | Partial (personal chat attachments) |    Yes    |
| Email     |  Yes  |    No     |               **Yes**               |    Yes    |
| Messenger |  Yes  |    No     |                 No                  |    No     |
| VXML      |  Yes  |    No     |                 No                  |    No     |
| Jambonz   |  Yes  |    No     |                 No                  |    No     |
| AG-UI     |  No   |  **Yes**  |                 No                  |    No     |
| Korevg    |  Yes  |    No     |                 No                  |    No     |

### Adapter Method Summary

| Adapter   |    verifyRequest     | extractExternalIdentifier |      shouldProcess      |             buildNormalizedMessage             |    extractEventId    |      transformOutput      |      sendResponse       |
| --------- | :------------------: | :-----------------------: | :---------------------: | :--------------------------------------------: | :------------------: | :-----------------------: | :---------------------: |
| HttpAsync | API key (middleware) |            N/A            |           N/A           |                      N/A                       |         N/A          |            N/A            | Throws (delivery queue) |
| Slack     | HMAC-SHA256 + replay |          team_id          | Skip bot msgs, subtypes | event_callback, block_actions, view_submission | event_id / action_ts |         Block Kit         |    chat.postMessage     |
| WhatsApp  |     HMAC-SHA256      |      phone_number_id      | Text + interactive only |           Text + interactive replies           |      message.id      | Interactive buttons/lists |   Graph API /messages   |
| MS Teams  | JWT (Microsoft JWKS) |      conversation.id      |   Messages + invokes    |            Message + Action.Execute            |     activity.id      |     Adaptive Card 1.4     |   Bot Framework reply   |
| Email     |      N/A (SMTP)      |       from address        |        Has body         |               SMTP parsed fields               |      message-id      |         Text only         |       nodemailer        |
| Messenger |     HMAC-SHA256      |         sender.id         |     Text + postback     |            Text + postback payload             |     message.mid      |       Quick replies       |        Send API         |
| VXML      |     Bearer token     |            N/A            |           N/A           |                      N/A                       |         N/A          |           Text            |    VoiceXML response    |
| Jambonz   |     Bearer token     |            N/A            |           N/A           |                      N/A                       |         N/A          |           Text            |      Jambonz JSON       |
| AG-UI     |         N/A          |            N/A            |           N/A           |                      N/A                       |         N/A          |       AG-UI events        |        WebSocket        |

### Signature Verification Details

| Adapter   | Algorithm   | Header                  | Secret Source                                                | Replay Protection        |
| --------- | ----------- | ----------------------- | ------------------------------------------------------------ | ------------------------ |
| Slack     | HMAC-SHA256 | `x-slack-signature`     | `connection.credentials.signing_secret`                      | 5-minute timestamp check |
| WhatsApp  | HMAC-SHA256 | `x-hub-signature-256`   | `connection.credentials.app_secret` or `WHATSAPP_APP_SECRET` | None (dedup handles it)  |
| MS Teams  | JWT RS256   | `Authorization: Bearer` | Microsoft JWKS (`login.botframework.com`)                    | JWT `exp` claim          |
| Messenger | HMAC-SHA256 | `x-hub-signature-256`   | `connection.credentials.app_secret`                          | None                     |

### Session Key Formats

| Channel             | External Session Key Format                    | Example                                 |
| ------------------- | ---------------------------------------------- | --------------------------------------- |
| Slack (message.im)  | `slack:{team_id}:{channel_id}:{user_id}`       | `slack:T01ABC:D02XYZ:U03DEF`            |
| Slack (app_mention) | `slack:{team_id}:{channel_id}:{thread_ts\|ts}` | `slack:T01ABC:C04GHI:1234567890.123456` |
| WhatsApp            | `whatsapp:{phone_number_id}:{from}`            | `whatsapp:123456789:14155551234`        |
| MS Teams            | `msteams:{conversation_id}`                    | `msteams:a]concat-123`                  |
| Email               | `email:{connectionId}:{from}`                  | `email:conn-abc:user@example.com`       |
| Messenger           | `messenger:{sender_id}`                        | `messenger:1234567890`                  |

---

## 10. Action System

### Action Element Types

| Type     | DSL Keyword | IR Fields                                    | Supported Channels               |
| -------- | ----------- | -------------------------------------------- | -------------------------------- |
| `button` | `BUTTON:`   | id, label, value, description                | All except Email, VXML           |
| `select` | `SELECT:`   | id, label, options[]                         | Slack, Teams, WhatsApp (as list) |
| `input`  | `INPUT:`    | id, label, input_type, placeholder, required | Slack, Teams, Web/SDK            |

### ActionSetIR → ChannelOutput Transform

| Channel        | Buttons                                | Selects                            | Inputs                                | Transform Details               |
| -------------- | -------------------------------------- | ---------------------------------- | ------------------------------------- | ------------------------------- |
| **Slack**      | `actions` block with `button` elements | `static_select` in `actions` block | `input` block with `plain_text_input` | Full Block Kit layout           |
| **WhatsApp**   | ≤3: `reply` buttons; >3: `list` rows   | `list` rows (from options)         | Text fallback (unsupported)           | Interactive message format      |
| **Teams**      | `Action.Execute`                       | `Input.ChoiceSet`                  | `Input.Text`                          | Adaptive Card v1.4              |
| **Messenger**  | Quick replies (max 13)                 | Not supported                      | Not supported                         | Quick reply format              |
| **AG-UI**      | `action_request` events                | Form events                        | Form events                           | AG-UI protocol                  |
| **Email**      | Not supported                          | Not supported                      | Not supported                         | Text only                       |
| **HTTP Async** | JSON in payload                        | JSON in payload                    | JSON in payload                       | Raw ActionSetIR passed through  |
| **Web/SDK**    | Client-rendered                        | Client-rendered                    | Client-rendered                       | Raw ActionSetIR in response_end |

### WhatsApp Action Limits

| Limit                     | Value     | Fallback         |
| ------------------------- | --------- | ---------------- |
| Max reply buttons         | 3         | Promoted to list |
| Max list rows             | 10        | Truncated        |
| Button label max length   | 20 chars  | Truncated        |
| Button ID max length      | 256 chars | Truncated        |
| List row title max length | 24 chars  | Truncated        |
| List row description max  | 72 chars  | Truncated        |
| Header text max           | 60 chars  | N/A              |

### Inbound Action Callbacks

| Channel                 | Event Type                   | Produces      | Routed To               |
| ----------------------- | ---------------------------- | ------------- | ----------------------- |
| Slack `block_actions`   | Button click, select change  | `ActionEvent` | `executeActionSubmit()` |
| Slack `view_submission` | Modal form submit            | `ActionEvent` | `executeActionSubmit()` |
| WhatsApp `button_reply` | Reply button tap             | `ActionEvent` | `executeActionSubmit()` |
| WhatsApp `list_reply`   | List item selection          | `ActionEvent` | `executeActionSubmit()` |
| Teams `invoke`          | Adaptive Card Action.Execute | `ActionEvent` | `executeActionSubmit()` |
| Messenger postback      | Button tap                   | `ActionEvent` | `executeActionSubmit()` |
| Web/SDK `action_submit` | Any interactive element      | `ActionEvent` | `executeActionSubmit()` |

### ActionEvent Structure

```typescript
interface ActionEvent {
  type: 'action_event';
  actionId: string; // Matches ActionElementIR.id
  value: string; // Selected value
  source: string; // 'slack' | 'whatsapp' | 'msteams' | 'messenger' | 'web'
}
```

---

## 11. Rich Content & Format Selection

### Current State: Client-Side Format Selection

The runtime sends the populated `RichContentIR` object to the client. Format selection is delegated to the consuming client or SDK for the fixed built-in schema.

| Layer                               | What Happens                                                       |
| ----------------------------------- | ------------------------------------------------------------------ |
| Runtime engine                      | Produces `ExecutionResult.richContent` with all populated variants |
| Voice adapter                       | Selects voice format (SSML, plain_text, instructions) server-side  |
| WebSocket delivery                  | Sends full `richContent` in `response_end` event                   |
| Channel adapter (`transformOutput`) | Converts `ActionSetIR` → platform-native format                    |
| Client/SDK                          | Picks format to render based on its own context                    |

Customer-defined named payloads are not part of `RichContentIR` today. They require the separate `renderables[]` wire contract described above.

### Server-Side Format Selection (Voice Only)

Source: `apps/runtime/src/services/channel/channel-adapter.ts`

| Voice Engine       | Adapter                | Format Used                                |
| ------------------ | ---------------------- | ------------------------------------------ |
| ElevenLabs         | `ElevenLabsAdapter`    | `voiceConfig.plain_text` or strip markdown |
| OpenAI Realtime    | `RealtimeVoiceAdapter` | `voiceConfig.plain_text`                   |
| Gemini Live        | `RealtimeVoiceAdapter` | `voiceConfig.plain_text`                   |
| Google TTS         | `SSMLVoiceAdapter`     | `voiceConfig.ssml`                         |
| Azure Speech       | `SSMLVoiceAdapter`     | `voiceConfig.ssml`                         |
| Amazon Polly       | `SSMLVoiceAdapter`     | `voiceConfig.ssml`                         |
| Default (web, API) | `TextChannelAdapter`   | Passthrough text                           |

### Phase 2 Gap: Server-Side RichContent Resolution

`channel-adapter.ts:29` has a commented-out field:

```typescript
// richConfig?: RichConfigIR;  // Phase 2: reserved, not used yet
```

When implemented, the server would:

1. Read `session.channelType`
2. Select the matching `RichContentIR` field (`slack` for Slack sessions, `adaptive_card` for Teams, etc.)
3. Return only the relevant format to the adapter

---

## 12. Streaming Support

### Streaming by Channel Type

| Channel Type                  | Streaming? | Mechanism                                          | What's Streamed                     |
| ----------------------------- | :--------: | -------------------------------------------------- | ----------------------------------- |
| `web_chat` / `sdk_websocket`  |    Yes     | WebSocket frames                                   | Text deltas only                    |
| REST API (`/api/chat/stream`) |    Yes     | Server-Sent Events (SSE)                           | Text deltas only                    |
| `ag_ui`                       |    Yes     | WebSocket (AG-UI protocol)                         | Text + protocol events              |
| `voice` (Realtime)            |    Yes     | Audio WebSocket                                    | Audio frames                        |
| `voice` (Pipeline)            |    Yes     | LiveKit audio track                                | Audio frames                        |
| `slack`                       |  **Yes**   | `chat.startStream` / `appendStream` / `stopStream` | Text deltas via Slack streaming API |
| `whatsapp`                    |     No     | Single Graph API call                              | N/A                                 |
| `msteams`                     |     No     | Single Bot Framework reply                         | N/A                                 |
| `email`                       |     No     | Single SMTP send                                   | N/A                                 |
| `messenger`                   |     No     | Single Send API call                               | N/A                                 |
| `http_async`                  |     No     | Single webhook delivery                            | N/A                                 |
| `vxml` / `jambonz`            |     No     | Single response                                    | N/A                                 |

### What Is NOT Streamed

| Content Type            | Delivery            | Why                                            |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `voiceConfig`           | `response_end` only | Voice engines need complete text to synthesize |
| `richContent`           | `response_end` only | Structured formats need complete content       |
| `actions` (ActionSetIR) | `response_end` only | Interactive elements need complete action set  |

### ChannelCapabilities.supportsStreaming

| Adapter    |  Value  | Notes                                                                                                        |
| ---------- | :-----: | ------------------------------------------------------------------------------------------------------------ |
| AG-UI      | `true`  | WebSocket-based streaming via AG-UI protocol                                                                 |
| Slack      | `true`  | Uses `chat.startStream` / `appendStream` / `stopStream` APIs via `SlackStreamBuffer` and `SlackStreamClient` |
| All others | `false` | Webhook/async channels cannot stream                                                                         |

#### Slack Streaming Architecture

Slack streaming uses a dedicated buffer/client pattern:

- **`SlackStreamBuffer`** (`adapters/slack-stream-buffer.ts`): Buffers text deltas and flushes to Slack at throttled intervals to avoid rate limits.
- **`SlackStreamClient`** (`adapters/slack-stream-client.ts`): Wraps Slack Web API `chat.startStream`, `chat.appendStream`, and `chat.stopStream` methods.
- The adapter calls `startStream` on first delta, `appendStream` for subsequent deltas, and `stopStream` with the final complete message on `response_end`.

---

## 13. Attachment & Media Processing

Inbound file attachments from messaging channels are uploaded to the multimodal service and passed as `attachmentIds` to the agent execution engine. Each channel has a dedicated processor because file acquisition differs per platform.

### Per-Channel Processing

| Channel  | Source of File Bytes                                           | Processor File                  | Auth Needed                             |
| -------- | -------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| Slack    | CDN URL in `event.files[].url_private`                         | `slack-file-processor.ts`       | Bot token (`Bearer`)                    |
| WhatsApp | Graph API media endpoint                                       | `whatsapp-media-processor.ts`   | System user access token                |
| MS Teams | SharePoint download URL / inline image `contentUrl`            | `msteams-file-processor.ts`     | Bot Framework OAuth2 client credentials |
| Email    | MIME attachment inline (`parsed.attachments[].content` Buffer) | `email-attachment-processor.ts` | None (already in memory)                |

### Processing Flow

```
Channel webhook/SMTP
  → Channel-specific processor extracts file bytes
  → Convert to Readable stream
  → Upload to multimodal service (POST /api/files/upload)
  → Receive attachmentId
  → Pass attachmentIds in job metadata through BullMQ
  → Inbound worker reads attachmentIds from metadata
  → Passes to executeMessage() for LLM context
```

All download-then-upload channels (Slack, WhatsApp, MS Teams) are wrapped in a `Promise.race` batch timeout (`MEDIA_BATCH_TIMEOUT_MS`, default 60s, configurable via `CHANNEL_MEDIA_BATCH_TIMEOUT_MS` env var). Email attachments skip this since IDs are pre-uploaded in the SMTP server.

### Slack File Processing

1. `slack-file-downloader.ts` downloads from `url_private` using bot token auth
2. `slack-file-processor.ts` orchestrates: download → stream → upload to multimodal
3. Returns array of attachment IDs

### WhatsApp Media Processing

1. `whatsapp-media-downloader.ts` performs two-step download:
   - GET media URL from Graph API (`/{media_id}`)
   - GET binary from the returned URL
2. `whatsapp-media-processor.ts` orchestrates: download → stream → upload to multimodal

### MS Teams File Processing

1. Only personal (1:1) chat attachments are processed — group/channel conversations are skipped (Teams API limitation)
2. Two attachment types supported:
   - **`file_download_info`**: SharePoint-hosted files (documents, spreadsheets, etc.) — download URL in attachment content
   - **`inline_image`**: Teams-hosted images — `contentUrl` on the attachment, requires bot token auth
3. `msteams-auth.ts` acquires OAuth2 client-credentials token from `login.microsoftonline.com` (cached per tenant+app, bounded cache with eviction)
4. `msteams-file-downloader.ts` downloads with SSRF protection (`assertAllowedCallbackUrl`) and bot token host allowlisting (only `.sharepoint.com`, `.teams.microsoft.com`, etc.)
5. `msteams-file-processor.ts` orchestrates: download → stream → upload to multimodal, with stream cleanup on failure

### Email Attachment Processing

1. `mailparser.simpleParser()` extracts attachments as `Buffer` objects directly from MIME
2. `email-attachment-processor.ts` converts `Buffer` → `Readable.from(buffer)` → upload to multimodal
3. No download step needed — bytes are inline in the email

### SMTP Early Rejection (onRcptTo)

The SMTP server validates recipients **before** accepting the email body:

1. `onRcptTo` handler receives `RCPT TO` address
2. Calls `resolveChannelConnection('email', address)` to look up active connection
3. If no connection found → rejects with `550 No such recipient` (body never transferred)
4. If found → stores in `pendingConnections` Map keyed by SMTP session ID
5. `onData` handler retrieves pre-resolved connection from the Map
6. `onClose` handler cleans up the Map entry (prevents memory leaks)

### Inbound Worker Wiring

In `inbound-worker.ts`, after Slack file processing (~line 254):

```typescript
// WhatsApp media (download from Graph API → upload to multimodal)
if (payload.channelType === 'whatsapp' && whatsappMediaRefs) { ... }

// Slack files (download from CDN → upload to multimodal)
if (payload.channelType === 'slack' && slackFileRefs) { ... }

// MS Teams files (download from SharePoint/Teams → upload to multimodal)
if (payload.channelType === 'msteams' && teamsFileRefs) { ... }

// Email attachments (IDs pre-uploaded in SMTP server, just read from metadata)
if (payload.channelType === 'email' && !attachmentIds) {
  const emailAttIds = payload.message.metadata?.emailAttachmentIds as string[] | undefined;
  if (emailAttIds && emailAttIds.length > 0) {
    attachmentIds = emailAttIds;
  }
}
```

Email attachments are uploaded in the SMTP server (where Buffers are available) and only IDs are passed through BullMQ — avoiding base64-encoding large files in Redis.

### Multimodal Service Client

Source: `apps/runtime/src/attachments/multimodal-service-client.ts`

| Method     | Endpoint                  | Purpose                              |
| ---------- | ------------------------- | ------------------------------------ |
| `upload`   | `POST /api/files/upload`  | Upload file stream, returns file ID  |
| `download` | `GET /api/files/:id`      | Download file by ID                  |
| `delete`   | `DELETE /api/files/:id`   | Delete file by ID                    |
| `getInfo`  | `GET /api/files/:id/info` | Get file metadata (size, mime, etc.) |

---

## 14. Voice System

### Voice Pipeline Modes

| Mode         | Path               | Components                     | Latency |
| ------------ | ------------------ | ------------------------------ | ------- |
| **Pipeline** | STT → LLM → TTS    | Deepgram + LLM + ElevenLabs    | Higher  |
| **Realtime** | Direct voice model | OpenAI Realtime / Gemini Live  | Lower   |
| **Auto**     | Agent hint decides | Uses IR `execution.voice_mode` | Varies  |

### Voice Format Adapters

Source: `apps/runtime/src/services/channel/channel-adapter.ts`

| Adapter                | Registered For                               | Format Selection                                      |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `TextChannelAdapter`   | `text`, `web` (default)                      | Passthrough `text`                                    |
| `ElevenLabsAdapter`    | `elevenlabs`                                 | `voiceConfig.plain_text` or strip markdown from text  |
| `RealtimeVoiceAdapter` | `openai_realtime`, `gemini_live`             | `voiceConfig.plain_text` + `voiceConfig.instructions` |
| `SSMLVoiceAdapter`     | `google_tts`, `azure_speech`, `amazon_polly` | `voiceConfig.ssml`                                    |

### Voice Channel Types in Studio

| Channel Type           | Provider            | Preview Method                                       |
| ---------------------- | ------------------- | ---------------------------------------------------- |
| `voice_livekit`        | LiveKit (WebRTC)    | Secure share link → `/preview-livekit`               |
| `voice_twilio`         | Twilio (PSTN)       | No browser preview (phone only)                      |
| Web channel with voice | LiveKit or Realtime | Secure share link → `/preview` or `/preview-livekit` |

---

## 15. Channel Registration & Connection Management

### ChannelConnection Model

Source: `packages/database/src/models/channel-connection.model.ts`

| Field                  | Type           | Required | Notes                                                                                                                            |
| ---------------------- | -------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `_id`                  | String         |   Yes    | UUIDv7                                                                                                                           |
| `tenantId`             | String         |   Yes    | Tenant-scoped via middleware                                                                                                     |
| `projectId`            | String         |   Yes    | Project scope                                                                                                                    |
| `agentId`              | String \| null |    No    | Optional agent-level scoping                                                                                                     |
| `deploymentId`         | String \| null |    No    | Pin to specific deployment                                                                                                       |
| `environment`          | String \| null |    No    | Mutually exclusive with deploymentId                                                                                             |
| `channelType`          | Enum           |   Yes    | `http_async`, `slack`, `email`, `msteams`, `whatsapp`, `messenger`, `vxml`, `jambonz`, `realtime`, `pipeline`, `ag_ui`, `korevg` |
| `externalIdentifier`   | String         |   Yes    | Platform-specific ID (1–255 chars)                                                                                               |
| `displayName`          | String \| null |    No    | Human-friendly label                                                                                                             |
| `encryptedCredentials` | String \| null |    No    | AES-encrypted JSON blob                                                                                                          |
| `config`               | Mixed          |    No    | Channel-specific config                                                                                                          |
| `status`               | Enum           |   Yes    | `active` or `inactive` (default: `active`)                                                                                       |

### ChannelConnection Indexes

| Index               | Fields                                   | Unique |
| ------------------- | ---------------------------------------- | :----: |
| External lookup     | `{ channelType, externalIdentifier }`    |  Yes   |
| Tenant + type       | `{ tenantId, channelType }`              |   No   |
| Tenant + project    | `{ tenantId, projectId }`                |   No   |
| Tenant + deployment | `{ tenantId, deploymentId }`             |   No   |
| Listing             | `{ tenantId, projectId, createdAt: -1 }` |   No   |

### Connection Resolver

Source: `apps/runtime/src/channels/connection-resolver.ts`

| Function                                                    | Purpose                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `resolveChannelConnection(channelType, externalIdentifier)` | MongoDB lookup → decrypt credentials → return `ResolvedConnection` |
| `resolveConnectionById(connectionId)`                       | Direct ID lookup → decrypt credentials                             |
| `findOrCreateHttpAsyncConnection()`                         | Upsert for HTTP Async channels                                     |

### Credential Encryption

| Operation          | Method                                                   |
| ------------------ | -------------------------------------------------------- |
| Encrypt on save    | `EncryptionService.encrypt(JSON.stringify(credentials))` |
| Decrypt on resolve | `EncryptionService.decrypt(encryptedCredentials)`        |
| Key derivation     | Tenant-scoped keys via `EncryptionService`               |
| Algorithm          | AES (via platform EncryptionService)                     |

### CRUD Routes

| Route               | Path                                                              | Allowed Types                                         | Methods                 |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| SDK Channels        | `GET/POST/PUT/DELETE /api/projects/:projectId/channels`           | `web`, `mobile_ios`, `mobile_android`, `voice`, `api` | Full CRUD               |
| Channel Connections | `POST/GET/PATCH/DELETE /api/v1/channel-connections`               | `slack`, `msteams`, `email`                           | Full CRUD               |
| HTTP Async          | `POST/GET/PATCH/DELETE /api/v1/channels/http-async/subscriptions` | `http_async` (implicit)                               | Subscription management |

---

## 16. Session Resolution

Source: `apps/runtime/src/channels/session-resolver.ts`

### Resolution Flow

```
resolveSession(connection, message)
  → ChannelSession.findOne({ tenantId, externalSessionKey })
  → If found & active:
      → Verify runtime session exists in Redis
      → If expired: create new runtime session, update ChannelSession
      → If valid: update lastMessageAt, return existing
  → If not found:
      → Create runtime session via pipelineCreateSession()
      → Create ChannelSession mapping
      → Return new session
```

### ResolvedSession

```typescript
interface ResolvedSession {
  channelSessionId: string;
  runtimeSessionId: string;
  isNew: boolean;
}
```

### Stale Session Handling

| Scenario                                        | Detection                                         | Action                                                    |
| ----------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| ChannelSession exists, runtime session in Redis | `executor.getSession()` returns truthy            | Reuse session                                             |
| ChannelSession exists, runtime session expired  | `getSession()` null AND `rehydrateSession()` null | Create new runtime session, update ChannelSession mapping |
| No ChannelSession mapping                       | `findOne()` returns null                          | Create both runtime session and ChannelSession            |

### Pipeline Session Creation

`pipelineCreateSession()` accepts:

| Parameter          | Source                                        |
| ------------------ | --------------------------------------------- |
| `projectId`        | `connection.projectId`                        |
| `tenantId`         | `connection.tenantId`                         |
| `deploymentId`     | `connection.deploymentId`                     |
| `environment`      | `connection.environment` (if no deploymentId) |
| `allowWorkingCopy` | `true` if no deploymentId and no environment  |
| `channelType`      | `connection.channelType`                      |
| `userId`           | `'system'`                                    |
| `ensureLLMReady`   | `true`                                        |

---

## 17. Identity Verification System

Source: `apps/runtime/src/contexts/identity/`

### Architecture (Hexagonal / DDD)

| Layer              | Contents                                                                             |
| ------------------ | ------------------------------------------------------------------------------------ |
| **Domain**         | `IdentityArtifact`, `IdentityTier`, `VerificationAttempt`, `IdentityVerifier` (port) |
| **Infrastructure** | 6 verifier implementations, Redis token store, Redis resolution key store            |
| **Use Cases**      | `VerifyIdentity`, `ResolveSession`, `RegisterResolutionKey`, `PromoteTier`           |

### Identity Tiers

| Tier | Name       | How Reached                           | Capabilities                           |
| ---- | ---------- | ------------------------------------- | -------------------------------------- |
| 0    | Anonymous  | Default                               | Basic session, no contact resolution   |
| 1    | Recognized | Provider-verified (WhatsApp/FB)       | Session linking, partial contact       |
| 2    | Verified   | HMAC, OTP, email link, OAuth, webhook | Full contact resolution, cross-channel |

### Tier Promotion Matrix

| From \ To      | 0 (Anonymous) | 1 (Recognized) |           2 (Verified)           |
| -------------- | :-----------: | :------------: | :------------------------------: |
| 0 (Anonymous)  |       —       |    Provider    | HMAC, OTP, Email, OAuth, Webhook |
| 1 (Recognized) |      N/A      |       —        | HMAC, OTP, Email, OAuth, Webhook |
| 2 (Verified)   |      N/A      |      N/A       |                —                 |

### 6 Verification Methods

| Method         | Type        | Steps | Secret/Token                    | TTL           | Max Attempts |
| -------------- | ----------- | :---: | ------------------------------- | ------------- | :----------: |
| **HMAC**       | Single-step |   1   | Shared secret per tenant        | N/A           |      1       |
| **OTP**        | Two-step    |   2   | 6-digit TOTP, HMAC-hashed       | 10 min        |      5       |
| **Email Link** | Two-step    |   2   | 32-byte random token            | 1 hour        |  1 (click)   |
| **OAuth**      | Two-step    |   2   | PKCE + state parameter          | Session-based |      1       |
| **Provider**   | Single-step |   1   | Platform identity (WhatsApp/FB) | N/A           |      1       |
| **Webhook**    | Two-step    |   2   | Challenge/response              | 5 min         |      1       |

### Verification Method Details

| Method     | File                               | Algorithm                             | Storage                  |
| ---------- | ---------------------------------- | ------------------------------------- | ------------------------ |
| HMAC       | `verifiers/hmac-verifier.ts`       | HMAC-SHA256, timing-safe compare      | None (stateless)         |
| OTP        | `verifiers/otp-verifier.ts`        | TOTP generation, HMAC-hashed storage  | Redis (token store)      |
| Email Link | `verifiers/email-link-verifier.ts` | 32-byte `crypto.randomBytes`          | Redis (token store)      |
| OAuth      | `verifiers/oauth-verifier.ts`      | PKCE `code_verifier`/`code_challenge` | Redis (state + verifier) |
| Provider   | `verifiers/provider-verifier.ts`   | Platform-provided identity claim      | None                     |
| Webhook    | `verifiers/webhook-verifier.ts`    | Challenge token to customer endpoint  | Redis (token store)      |

### Resolution Keys

| Property      | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Key format    | `identity:resolution:{tenantId}:{artifactHash}`              |
| Artifact hash | SHA-256 of identity artifact                                 |
| TTL           | 24 hours                                                     |
| Storage       | Redis                                                        |
| Purpose       | Link returning users across sessions without re-verification |

### Identity Verification Routes

Source: `apps/runtime/src/routes/identity-verification.ts`

| Route                             | Method | Purpose                                         |
| --------------------------------- | ------ | ----------------------------------------------- |
| `/api/identity/verify/initiate`   | POST   | Start verification flow                         |
| `/api/identity/verify/complete`   | POST   | Complete verification (submit OTP, token, etc.) |
| `/api/identity/verify/:attemptId` | GET    | Check verification attempt status               |

### VerificationAttempt State Machine

```
pending → verified    (success)
pending → expired     (TTL exceeded)
pending → failed      (max attempts exceeded)
```

---

## 18. Contact Management

Source: `apps/runtime/src/contexts/contact/`

### Contact Aggregate

| Field            | Type                      | Notes                                   |
| ---------------- | ------------------------- | --------------------------------------- |
| `_id`            | String                    | UUIDv7                                  |
| `tenantId`       | String                    | Tenant-scoped                           |
| `identities`     | `ContactIdentity[]`       | Encrypted, searchable via blind indexes |
| `channelHistory` | `ChannelHistoryEntry[]`   | Channel + first/last seen timestamps    |
| `mergedInto`     | String \| null            | Soft-merge pointer to target contact    |
| `metadata`       | `Record<string, unknown>` | Extensible metadata                     |
| `createdAt`      | Date                      |                                         |
| `updatedAt`      | Date                      |                                         |

### ContactIdentity (Encrypted)

| Field            | Type         | Notes                                 |
| ---------------- | ------------ | ------------------------------------- |
| `type`           | String       | `email`, `phone`, `external_id`, etc. |
| `encryptedValue` | String       | AES-256-GCM encrypted                 |
| `blindIndex`     | String       | HMAC-SHA256 deterministic hash        |
| `verifiedAt`     | Date \| null | When identity was verified            |
| `source`         | String       | Which channel provided this identity  |

### Encryption Details

| Operation              | Algorithm                                                | Key Derivation                     |
| ---------------------- | -------------------------------------------------------- | ---------------------------------- |
| Encrypt identity value | AES-256-GCM                                              | HKDF per-tenant from master secret |
| Blind index            | HMAC-SHA256                                              | HKDF per-tenant from master secret |
| Property               | Deterministic per tenant (same input → same blind index) |

### Contact Use Cases

| Use Case                 | File                                     | Description                                  |
| ------------------------ | ---------------------------------------- | -------------------------------------------- |
| `ResolveOrCreateContact` | `use-cases/resolve-or-create-contact.ts` | Find by blind index or create new            |
| `LinkSessionToContact`   | `use-cases/link-session-to-contact.ts`   | Associate runtime session with contact       |
| `ExecuteMerge`           | `use-cases/execute-merge.ts`             | Admin-initiated merge of two contacts        |
| `SelfMerge`              | `use-cases/self-merge.ts`                | User proves ownership, merges own contacts   |
| `DetectMergeCandidates`  | `use-cases/detect-merge-candidates.ts`   | Find contacts with overlapping blind indexes |
| `CascadeDeleteContact`   | `use-cases/cascade-delete-contact.ts`    | GDPR hard-delete: contact + all data         |

### Contact Routes

| Route                          | Method | Purpose                   |
| ------------------------------ | ------ | ------------------------- |
| `/api/contacts/merge`          | POST   | Admin merge two contacts  |
| `/api/contacts/:id/self-merge` | POST   | User self-merge           |
| `/api/contacts/:id/gdpr`       | DELETE | GDPR cascade delete       |
| `/api/merge-suggestions`       | GET    | List merge suggestions    |
| `/api/merge-suggestions/:id`   | PUT    | Accept/dismiss suggestion |

### GDPR Cascade Delete

When `DELETE /api/contacts/:id/gdpr` is called:

| Step | What's Deleted                           |
| ---- | ---------------------------------------- |
| 1    | Contact record (hard delete)             |
| 2    | All associated ChannelSession records    |
| 3    | All conversation data linked to sessions |
| 4    | All trace events linked to sessions      |
| 5    | Audit event `CONTACT_DELETED` emitted    |

### Contact Audit Actions

| Action                | When                          |
| --------------------- | ----------------------------- |
| `CONTACT_CREATED`     | New contact created           |
| `CONTACT_UPDATED`     | Contact metadata updated      |
| `CONTACT_MERGED`      | Two contacts merged           |
| `CONTACT_SELF_MERGED` | User self-merge               |
| `CONTACT_DELETED`     | GDPR cascade delete           |
| `SESSION_LINKED`      | Session linked to contact     |
| `IDENTITY_ADDED`      | New identity added to contact |

---

## 19. Cross-Channel Continuity (Orchestration)

Source: `apps/runtime/src/contexts/orchestration/`

### Use Cases

| Use Case            | File                              | Lines | Trigger                     | Purpose                                             |
| ------------------- | --------------------------------- | :---: | --------------------------- | --------------------------------------------------- |
| `InitializeSession` | `use-cases/initialize-session.ts` |  224  | Every new inbound message   | Channel → identity → contact → session linking      |
| `PromoteAndLink`    | `use-cases/promote-and-link.ts`   |  134  | Verification success        | Tier promotion → contact resolution → back-link     |
| `SwitchChannel`     | `use-cases/switch-channel.ts`     |  124  | Tier 2+ user on new channel | Contact lookup → new session linked to same contact |

### InitializeSession Flow

```
Incoming message
  → Channel session resolution (ChannelSession model)
  → Identity tier assignment:
      - Provider auto-verify defaults to tier 1
      - Explicitly trusted channel/provider policy may classify provider auto-verify as tier 2
      - Others → tier 0 (anonymous)
  → Contact resolution:
      - Tier 2+ strong verification for reusable cross-channel identity
      - Weak provider-verified tier 1 allowed only for same-channel continuity on stable channel-owned artifacts
      - Find by blind index
      - Or create new contact
  → Session linking (associate runtime session with contact)
  → Return: session + identity + contact context
```

Same-channel weak provider-verified tier-1 continuity is a narrow bootstrap exception only. It does not authorize recall, live-session join, or other strong-verification-only capabilities. When a channel/provider is explicitly trusted to classify provider verification as strong tier 2, that identity is treated like other strong-verification mechanisms for authorization and audit.

### PromoteAndLink Flow

```
User completes verification
  → Tier promoted (0→1 or 1→2)
  → Contact resolved or created (by verified identity)
  → Current session linked to contact
  → Resolution key registered in Redis
  → Background job: back-link prior anonymous sessions
```

### SwitchChannel Flow

```
Tier 2 user starts on new channel
  → Resolve contact by verified identity blind index
  → Create new channel session linked to same contact
  → Conversation history available across channels
  → Return linked session
```

### Background Jobs (BullMQ)

| Job                     | File                              | Lines | Queue      | Purpose                                                 |
| ----------------------- | --------------------------------- | :---: | ---------- | ------------------------------------------------------- |
| `BackLinkSessions`      | `jobs/back-link-sessions.ts`      |  83   | Background | Link old anonymous sessions to newly identified contact |
| `DetectMergeCandidates` | `jobs/detect-merge-candidates.ts` |  127  | Background | Scan for contacts with overlapping blind indexes        |

### SDK WebSocket Contact Wiring

Source: `apps/runtime/src/websocket/sdk-handler-contact-linking.ts` (156 lines)

| Function                  | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `resolveAndLinkContact()` | Contact resolution during SDK session init (tier 2+ only) |
| Graceful degradation      | Contact operations never block session initialization     |

---

## 20. Studio UI — Channel Management

### Channel Catalog

Source: `apps/studio/src/components/deployments/ChannelsTab.tsx:94-151`

| Catalog Entry         | ID             | Available | Routes To                               |
| --------------------- | -------------- | :-------: | --------------------------------------- |
| Webhooks (HTTP Async) | `http-async`   |    Yes    | `HttpAsyncPanel` (inline, 700 lines)    |
| SDK Channels          | `sdk-channels` |    Yes    | `SDKChannelsPanel` (inline, 450 lines)  |
| Slack                 | `slack`        |    Yes    | `SlackSetupPanel` → `ChannelSetupPanel` |
| Microsoft Teams       | `ms-teams`     |    Yes    | `TeamsSetupPanel` → `ChannelSetupPanel` |
| Email                 | `email`        |    Yes    | `EmailSetupPanel` → `ChannelSetupPanel` |
| WhatsApp              | `whatsapp`     |  **No**   | Coming Soon                             |
| Voice (SIP/Telephony) | `voice`        |  **No**   | Coming Soon                             |
| Mobile SDK            | `mobile-sdk`   |  **No**   | Coming Soon                             |

### Missing from Catalog

| Channel   | Runtime Adapter |    Connection Model    | CRUD Route | Catalog Entry |
| --------- | :-------------: | :--------------------: | :--------: | :-----------: |
| Messenger |       Yes       | No (not in model enum) |     No     |  Not listed   |
| VXML      |       Yes       |     Yes (in model)     |     No     |  Not listed   |
| Jambonz   |       Yes       |     Yes (in model)     |     No     |  Not listed   |

### Panel Architecture

| Panel        | Component          | Base                | Location                       | Lines |
| ------------ | ------------------ | ------------------- | ------------------------------ | :---: |
| SDK Channels | `SDKChannelsPanel` | None (standalone)   | Inline in `ChannelsTab.tsx`    | ~450  |
| HTTP Async   | `HttpAsyncPanel`   | None (standalone)   | Inline in `ChannelsTab.tsx`    | ~700  |
| Slack        | `SlackSetupPanel`  | `ChannelSetupPanel` | `channels/SlackSetupPanel.tsx` |  94   |
| Teams        | `TeamsSetupPanel`  | `ChannelSetupPanel` | `channels/TeamsSetupPanel.tsx` |  82   |
| Email        | `EmailSetupPanel`  | `ChannelSetupPanel` | `channels/EmailSetupPanel.tsx` |  43   |

### ChannelSetupPanel Props

Source: `apps/studio/src/components/deployments/channels/ChannelSetupPanel.tsx:45-58`

| Prop                             | Type                              | Purpose                              |
| -------------------------------- | --------------------------------- | ------------------------------------ |
| `projectId`                      | string                            | Project scope                        |
| `channelType`                    | `'slack' \| 'msteams' \| 'email'` | Channel type (hardcoded union)       |
| `channelName`                    | string                            | Display name                         |
| `channelIcon`                    | ReactNode                         | Brand icon                           |
| `setupInstructions`              | ReactNode                         | Numbered setup steps                 |
| `webhookUrl`                     | string \| null                    | Webhook URL to copy (null for Email) |
| `credentialFields`               | `CredentialFieldDef[]`            | Credential form fields               |
| `configFields?`                  | `ConfigFieldDef[]`                | Optional config fields               |
| `externalIdentifierLabel?`       | string                            | Label for external ID input          |
| `externalIdentifierPlaceholder?` | string                            | Placeholder text                     |
| `autoGenerateIdentifier?`        | boolean                           | Auto-generate ID (Email)             |
| `onBack`                         | function                          | Navigate back to catalog             |

### ChannelSetupPanel Sections

| Section            | Content                                                     |            Present            |
| ------------------ | ----------------------------------------------------------- | :---------------------------: |
| Header             | Back button + icon + name                                   |            Always             |
| Connection Status  | Badge: Connected / Inactive / Not configured                |            Always             |
| Setup Instructions | Numbered steps (collapsible, auto-open when not connected)  |            Always             |
| Webhook URL        | Copyable URL                                                | When `webhookUrl` is provided |
| Configuration      | External ID, display name, environment, credentials, config |            Always             |
| Danger Zone        | Disconnect button with confirmation                         |        When connected         |

### Credential Fields by Channel

| Channel   | Field            | Type     | Required | Validation                     |
| --------- | ---------------- | -------- | :------: | ------------------------------ |
| **Slack** | `bot_token`      | password |   Yes    | Must start with `xoxb-`        |
|           | `signing_secret` | password |   Yes    | —                              |
|           | `app_id`         | text     |    No    | —                              |
| **Teams** | `app_id`         | text     |   Yes    | —                              |
|           | `client_secret`  | password |   Yes    | —                              |
|           | `tenant_id`      | text     |   Yes    | —                              |
| **Email** | (none)           | —        |    —     | Auto-generated inbound address |

### SDK Channel Detail View

Source: `apps/studio/src/components/deployments/ChannelDetail.tsx` (1145 lines)

| Section                   | Content                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| Header                    | Back, icon, name, type badge, active badge, toggle                      |
| Metadata                  | Deployment label, API key prefix, created date                          |
| Deployment Binding        | Environment selector, auto-follow toggle, pinned deployment             |
| Voice Credential Warnings | Deepgram/ElevenLabs/Realtime model checks                               |
| Widget Configuration      | Mode (chat/voice/unified), position, features, voice pipeline, messages |
| Preview & Testing         | Secure preview link (7-day), voice preview link                         |
| Embed Code                | HTML snippet (web channels only)                                        |
| Danger Zone               | Delete with confirmation                                                |

### HTTP Async Panel Features

| Feature             | UI Element                    | Description                                             |
| ------------------- | ----------------------------- | ------------------------------------------------------- |
| Subscription list   | Card per subscription         | URL, status, agent, events, last delivery, failures     |
| Create              | Dialog                        | Callback URL, deployment, agent, description            |
| Integration guide   | Dialog (on create + existing) | Webhook secret, endpoint, subscription ID, curl example |
| Edit                | Dialog                        | Update callback URL and events                          |
| Test message        | Dialog                        | Send test message, see result                           |
| Deliveries          | Dialog (table)                | Status, event type, HTTP code, attempts, timestamp      |
| Pause/Resume        | Button                        | Toggle `active`/`paused`                                |
| Secret regeneration | Button in guide               | Regenerate + copy new secret                            |
| Delete              | Confirm dialog                | Deactivate subscription                                 |

### API Clients

| Client              | File                         | Endpoint                                               |
| ------------------- | ---------------------------- | ------------------------------------------------------ |
| SDK Channels        | `api/channels.ts`            | `RUNTIME_URL/api/projects/:projectId/channels`         |
| Channel Connections | `api/channel-connections.ts` | `RUNTIME_URL/api/v1/channel-connections`               |
| HTTP Async          | `api/http-async-channels.ts` | `RUNTIME_URL/api/v1/channels/http-async/subscriptions` |

---

## 21. Studio UI — Unified Interface Review

### Feature Parity Matrix

| Feature                 |    SDK Channels     |          HTTP Async           | External (Slack/Teams/Email) |     Gap?     |
| ----------------------- | :-----------------: | :---------------------------: | :--------------------------: | :----------: |
| Catalog entry           |         Yes         |              Yes              |             Yes              |      —       |
| Multi-instance per type |         Yes         |              Yes              |    **No** (one per type)     |     Yes      |
| Card/list view          |         Yes         |              Yes              |     **No** (direct form)     |     Yes      |
| Detail view             |  Yes (1145 lines)   |      No (inline dialogs)      |            **No**            |     Yes      |
| Create flow             |       Dialog        |            Dialog             |         Inline form          | Inconsistent |
| Edit flow               |   Detail sections   |          Edit dialog          |         Inline form          | Inconsistent |
| Delete/disconnect       |   Confirm dialog    |        Confirm dialog         |        Confirm dialog        |      OK      |
| Active/inactive toggle  |  Toggle component   |     Pause/Resume buttons      |   **No** (disconnect only)   |     Yes      |
| Deployment: environment |         Yes         |    Yes (deployment picker)    |             Yes              |      OK      |
| Deployment: auto-follow |         Yes         |              No               |            **No**            |     Yes      |
| Deployment: pin         |         Yes         |              Yes              |            **No**            |     Yes      |
| Webhook URL display     |         N/A         |              N/A              |             Yes              |      OK      |
| Credentials management  |         N/A         |         N/A (API key)         |       Yes (encrypted)        |      OK      |
| Setup instructions      |         N/A         |       Integration guide       |     Yes (numbered steps)     |      OK      |
| Test message/preview    |    Preview link     |       Send test dialog        |            **No**            |     Yes      |
| Message/delivery log    |         No          |        Delivery table         |            **No**            |     Yes      |
| Health monitoring       |         No          | Failure count + last delivery |            **No**            |     Yes      |
| Secret management       |         N/A         |       Regenerate secret       |             N/A              |      OK      |
| Embed code              |   Yes (web only)    |              N/A              |             N/A              |      OK      |
| Voice config            | Yes (full pipeline) |              N/A              |             N/A              |     N/A      |

### Status Model Inconsistency

| Subsystem         | Status Model                        | Toggle UX                |
| ----------------- | ----------------------------------- | ------------------------ |
| SDK Channels      | `isActive: boolean`                 | Toggle component         |
| HTTP Async        | `active` / `paused` / `deactivated` | Pause/Resume buttons     |
| External Channels | `active` / `inactive`               | Disconnect only (binary) |

### Interaction Pattern Inconsistency

| Subsystem         | Pattern                  | Description                             |
| ----------------- | ------------------------ | --------------------------------------- |
| SDK Channels      | List → Card → Detail     | Multi-item, full lifecycle management   |
| HTTP Async        | List with action buttons | Multi-item with inline dialogs          |
| External Channels | Single-form wizard       | One connection, connect/disconnect only |

### Code Organization

| Component           | Location                         |     Extracted?      |
| ------------------- | -------------------------------- | :-----------------: |
| `SlackSetupPanel`   | `channels/SlackSetupPanel.tsx`   |         Yes         |
| `TeamsSetupPanel`   | `channels/TeamsSetupPanel.tsx`   |         Yes         |
| `EmailSetupPanel`   | `channels/EmailSetupPanel.tsx`   |         Yes         |
| `ChannelSetupPanel` | `channels/ChannelSetupPanel.tsx` |         Yes         |
| `SDKChannelsPanel`  | Inline in `ChannelsTab.tsx`      | **No** (~450 lines) |
| `HttpAsyncPanel`    | Inline in `ChannelsTab.tsx`      | **No** (~700 lines) |

---

## 22. Test Coverage

### Test Files by Context

| Context          | Test Files | Approximate Test Count |
| ---------------- | :--------: | :--------------------: |
| Identity         |    ~10     |          ~150          |
| Contact          |     ~8     |          ~120          |
| Orchestration    |     ~5     |          ~80           |
| Integration      |     ~4     |          ~50           |
| Channel adapters |     ~3     |          ~25           |
| **Total**        |  **~30**   |       **~425+**        |

### Identity Context Tests

| File                           | Tests | Covers                                                        |
| ------------------------------ | :---: | ------------------------------------------------------------- |
| `identity-artifact.test.ts`    |  ~10  | SHA-256 hashing, deterministic outputs                        |
| `identity-tier.test.ts`        |  ~15  | Tier ordering, promotion rules, method→tier mapping           |
| `verification-attempt.test.ts` |  ~20  | State machine (pending→verified/expired/failed), max attempts |
| `hmac-verifier.test.ts`        |  ~10  | HMAC-SHA256, timing-safe comparison                           |
| `otp-verifier.test.ts`         |  ~15  | TOTP generation, hash storage, TTL, max attempts              |
| `email-link-verifier.test.ts`  |  ~12  | Token generation, 1-hour TTL                                  |
| `oauth-verifier.test.ts`       |  ~15  | PKCE, state parameter, adapter interface                      |
| `provider-verifier.test.ts`    |  ~8   | Auto-verify, default tier 1 with policy-driven tier 2 option  |
| `webhook-verifier.test.ts`     |  ~10  | Challenge/response, 5-min TTL                                 |
| `verify-identity.test.ts`      |  ~15  | Use case orchestration, verifier dispatch                     |
| `resolve-session.test.ts`      |  ~15  | Resolution key lookup, tier assignment                        |

### Contact Context Tests

| File                                | Tests | Covers                                               |
| ----------------------------------- | :---: | ---------------------------------------------------- |
| `contact.test.ts`                   |  ~15  | Aggregate root invariants, identity management       |
| `contact-identity.test.ts`          |  ~10  | Encrypted value, blind index, verification state     |
| `contact-encryptor.test.ts`         |  ~12  | AES-256-GCM, HKDF, blind index determinism           |
| `contact-mongo-repository.test.ts`  |  ~15  | MongoDB adapter, tenant scoping, blind index queries |
| `resolve-or-create-contact.test.ts` |  ~15  | Find by blind index, create new, tenant isolation    |
| `execute-merge.test.ts`             |  ~12  | Identity transfer, channel history merge, audit      |
| `cascade-delete-contact.test.ts`    |  ~10  | Hard delete, cascade, audit event                    |
| `detect-merge-candidates.test.ts`   |  ~10  | Overlapping blind indexes, suggestion creation       |

### Orchestration Context Tests

| File                              | Tests | Covers                                              |
| --------------------------------- | :---: | --------------------------------------------------- |
| `initialize-session.test.ts`      |  ~25  | Full flow: channel→identity→contact→session         |
| `promote-and-link.test.ts`        |  ~15  | Tier promotion, contact creation, back-link trigger |
| `switch-channel.test.ts`          |  ~15  | Cross-channel session creation, contact lookup      |
| `back-link-sessions.test.ts`      |  ~10  | Retroactive session linking                         |
| `detect-merge-candidates.test.ts` |  ~10  | Background job processing                           |

---

## 23. Known Gaps & Missing Pieces

### Critical Gaps

| Gap                                      |  Severity  | Location                | Details                                                                                                                                  |
| ---------------------------------------- | :--------: | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity verification not wired          |  **High**  | `server.ts:454-485`     | Routes mounted with stub dependencies. `completeVerification` → `NOT_IMPLEMENTED`. Empty verifier registry. No Redis token store.        |
| Server-side RichContent format selection | **Medium** | `channel-adapter.ts:29` | Built-in `RichContentIR` fields are sent to clients as-is. No server-side resolver picks a rich format by channel type. Phase 2 comment. |
| Contact store stubs in production        | **Medium** | `server.ts`             | Contact routes wired with MongoDB stubs in tests but unclear production wiring.                                                          |
| Chat route session resolution TODO       |  **Low**   | `chat.ts:769`           | "When SessionStore is available in the HTTP path, use resolveSession()"                                                                  |

### UI Gaps

Studio now has setup panels for all 14 channel types (Slack, Teams, Email, WhatsApp, Messenger, AG-UI, A2A, Voice Realtime, Voice Pipeline, VXML, Web SDK, Mobile SDK, API, HTTP Async) via a unified `channel-registry.tsx` catalog.

| Gap                            | Status      | Details                                                       |
| ------------------------------ | ----------- | ------------------------------------------------------------- |
| Identity/contact management UI | Not started | No Studio pages for contacts, merge suggestions, verification |
| Channel activity/message log   | Not started | No visibility into message flow post-connection               |
| Unified test message           | Not started | Only HTTP Async and Web SDK have test capability              |

### Functional Gaps

| Gap                                            | Details                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `webhook` verification method type             | Not in shared types — uses `'provider'` as workaround (`webhook-verifier.ts:14`) |
| No streaming for webhook channels              | Architectural constraint — platforms don't support server-push                   |
| Rich content not streamed                      | `voiceConfig`, `richContent`, `actions` only in `response_end`                   |
| No retry UI for failed deliveries              | BullMQ auto-retries but no Studio UI to view/retry failures                      |
| Email SMTP config not in Studio                | Inbound SMTP server setup not configurable through UI                            |
| MS Teams attachments limited to personal chats | Group/channel file attachments skipped — Teams API requires different auth flow  |
| Messenger media not implemented                | `supportsMedia: false` — no file processing support                              |

### Studio Unification Gaps

All 14 channel types now share a unified `ChannelInstanceList` → `ChannelInstanceConfig` (tabbed detail) UI. External messaging channels have gained parity with SDK channels for most structural features. Remaining gaps are functional (testing, delivery tracking, health):

| Feature            | SDK Channels |   HTTP Async   |           External Channels           |
| ------------------ | :----------: | :------------: | :-----------------------------------: |
| Multi-instance     |     Yes      |      Yes       |                  Yes                  |
| List/card view     |     Yes      |      Yes       |                  Yes                  |
| Detail view        |     Yes      |      Yes       |                  Yes                  |
| Active toggle      |     Yes      |  Yes (pause)   | **No** (`supportsPauseResume: false`) |
| Deployment binding |     Yes      |      Yes       |                  Yes                  |
| Test capability    | Preview link |   Send test    |    **No** (`supportsTest: false`)     |
| Activity log       |      No      | Delivery table | **No** (`supportsDeliveryLog: false`) |
| Health monitoring  |      No      | Failure count  |                **No**                 |

---

## 24. Key File Index

### Compiler / DSL

| File                                             | Purpose                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts` | ABL parser (RESPOND, VOICE, FORMATS, ACTIONS)                         |
| `packages/compiler/src/platform/ir/schema.ts`    | IR type definitions (RichContentIR, VoiceConfigIR, ActionSetIR, etc.) |
| `packages/compiler/src/platform/ir/compiler.ts`  | AST → IR compiler, template resolution, format propagation            |

### Runtime — Channel Infrastructure

| File                                                     | Purpose                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/runtime/src/channels/types.ts`                     | ChannelType, ChannelAdapter, ChannelOutput, NormalizedMessage, JobPayloads |
| `apps/runtime/src/channels/registry.ts`                  | Singleton registry with 10 adapters                                        |
| `apps/runtime/src/channels/connection-resolver.ts`       | externalIdentifier → ChannelConnection with decrypted credentials          |
| `apps/runtime/src/channels/session-resolver.ts`          | externalSessionKey → RuntimeSession mapping                                |
| `apps/runtime/src/channels/pipeline/message-pipeline.ts` | Centralized execution + persistence for realtime channels                  |
| `apps/runtime/src/channels/pipeline/index.ts`            | Pipeline session creation                                                  |

### Runtime — Channel Adapters

| File                                                       | Purpose                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `apps/runtime/src/channels/adapters/http-async-adapter.ts` | HTTP Async (webhook delivery)                            |
| `apps/runtime/src/channels/adapters/slack-adapter.ts`      | Slack (Block Kit, signature verification, 3 event types) |
| `apps/runtime/src/channels/adapters/whatsapp-adapter.ts`   | WhatsApp (Graph API, interactive buttons/lists)          |
| `apps/runtime/src/channels/adapters/msteams-adapter.ts`    | MS Teams (Adaptive Cards, JWT verification, OAuth2)      |
| `apps/runtime/src/channels/adapters/email-adapter.ts`      | Email (nodemailer, SMTP, threading)                      |
| `apps/runtime/src/channels/adapters/messenger-adapter.ts`  | Facebook Messenger (Send API, quick replies)             |
| `apps/runtime/src/channels/adapters/vxml-adapter.ts`       | Voice XML / IVR                                          |
| `apps/runtime/src/channels/adapters/jambonz-adapter.ts`    | Jambonz voice platform                                   |
| `apps/runtime/src/channels/adapters/ag-ui-adapter.ts`      | Agent-to-UI protocol                                     |

### Runtime — Attachment & Media Processing

| File                                                               | Purpose                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/runtime/src/attachments/multimodal-service-client.ts`        | Upload/download/delete API client for multimodal service             |
| `apps/runtime/src/channels/adapters/slack-file-downloader.ts`      | Downloads files from Slack CDN with bot token auth                   |
| `apps/runtime/src/channels/adapters/slack-file-processor.ts`       | Orchestrates Slack file download → multimodal upload                 |
| `apps/runtime/src/channels/adapters/whatsapp-media-downloader.ts`  | Two-step WhatsApp media download (URL → binary)                      |
| `apps/runtime/src/channels/adapters/whatsapp-media-processor.ts`   | Orchestrates WhatsApp media download → multimodal upload             |
| `apps/runtime/src/channels/adapters/msteams-auth.ts`               | Bot Framework OAuth2 client-credentials token (cached)               |
| `apps/runtime/src/channels/adapters/msteams-file-downloader.ts`    | Downloads Teams files with SSRF protection + host allowlist          |
| `apps/runtime/src/channels/adapters/msteams-file-processor.ts`     | Orchestrates Teams file download → multimodal upload                 |
| `apps/runtime/src/channels/adapters/email-attachment-processor.ts` | Buffer → Readable stream → multimodal upload                         |
| `apps/runtime/src/services/email/smtp-server.ts`                   | SMTP inbound with `onRcptTo` early rejection + attachment extraction |

### Runtime — Streaming

| File                                                        | Purpose                                                |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| `apps/runtime/src/channels/adapters/slack-stream-buffer.ts` | Buffers text deltas and throttles flushes to Slack API |
| `apps/runtime/src/channels/adapters/slack-stream-client.ts` | Wraps Slack `chat.startStream/appendStream/stopStream` |

### Runtime — Routes

| File                                               | Purpose                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/runtime/src/routes/channel-webhooks.ts`      | Webhook ingress: generic (body-based) and explicit (URL-based) routes        |
| `apps/runtime/src/routes/channel-connections.ts`   | ChannelConnection CRUD: `POST/GET/PATCH/DELETE /api/v1/channel-connections`  |
| `apps/runtime/src/routes/channels.ts`              | SDK Channel CRUD: `GET/POST/PUT/DELETE /api/projects/:projectId/channels`    |
| `apps/runtime/src/routes/identity-verification.ts` | Identity verification: `POST /initiate`, `POST /complete`, `GET /:attemptId` |
| `apps/runtime/src/routes/contact-merge.ts`         | Contact merge: `POST /merge`, `POST /:id/self-merge`, `DELETE /:id/gdpr`     |
| `apps/runtime/src/routes/merge-suggestions.ts`     | Merge suggestions: `GET /`, `PUT /:id`                                       |

### Runtime — Queues

| File                                                 | Purpose                                   |
| ---------------------------------------------------- | ----------------------------------------- |
| `apps/runtime/src/services/queues/inbound-worker.ts` | BullMQ worker for channel-inbound queue   |
| `apps/runtime/src/services/queues/channel-queues.ts` | Queue initialization (inbound + delivery) |
| `apps/runtime/src/services/queues/session-lock.ts`   | Distributed session locking               |
| `apps/runtime/src/services/queues/redis-utils.ts`    | Redis URL parsing utility                 |

### Runtime — Execution

| File                                                        | Purpose                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/flow-step-executor.ts` | Flow step execution (produces ExecutionResult with richContent, voiceConfig, actions) |
| `apps/runtime/src/services/execution/value-resolution.ts`   | Template interpolation engine                                                         |
| `apps/runtime/src/services/execution/types.ts`              | ExecutionResult type definition                                                       |
| `apps/runtime/src/services/channel/channel-adapter.ts`      | Voice format adapters (Text, ElevenLabs, Realtime, SSML)                              |
| `apps/runtime/src/services/runtime-executor.ts`             | Runtime executor entry point                                                          |

### Runtime — Identity Context (DDD)

| File                                                                                  | Purpose                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/runtime/src/contexts/identity/domain/identity-artifact.ts`                      | SHA-256 hashing, IdentityArtifact type                           |
| `apps/runtime/src/contexts/identity/domain/identity-tier.ts`                          | Tier 0/1/2, promotion rules, method→tier mapping                 |
| `apps/runtime/src/contexts/identity/domain/identity-verifier.ts`                      | IdentityVerifier port interface                                  |
| `apps/runtime/src/contexts/identity/domain/verification-attempt.ts`                   | State machine (pending→verified/expired/failed)                  |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts`        | HMAC-SHA256 single-step verifier                                 |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts`         | 6-digit TOTP verifier                                            |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts`  | Email link token verifier                                        |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts`       | OAuth PKCE verifier                                              |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/provider-verifier.ts`    | Platform auto-verify (default tier 1, optional tier 2 by policy) |
| `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`     | Challenge/response verifier                                      |
| `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`           | Redis resolution key store (24hr TTL)                            |
| `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts` | Redis token store                                                |
| `apps/runtime/src/contexts/identity/use-cases/verify-identity.ts`                     | Verification orchestration use case                              |
| `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts`                     | Session resolution with identity                                 |
| `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts`             | Resolution key registration                                      |
| `apps/runtime/src/contexts/identity/use-cases/promote-tier.ts`                        | Tier promotion logic                                             |

### Runtime — Contact Context (DDD)

| File                                                                           | Purpose                             |
| ------------------------------------------------------------------------------ | ----------------------------------- |
| `apps/runtime/src/contexts/contact/domain/contact.ts`                          | Contact aggregate root              |
| `apps/runtime/src/contexts/contact/domain/contact-identity.ts`                 | Encrypted identity value object     |
| `apps/runtime/src/contexts/contact/infrastructure/contact-encryptor.ts`        | AES-256-GCM + HKDF + blind indexes  |
| `apps/runtime/src/contexts/contact/infrastructure/contact-mongo-repository.ts` | MongoDB adapter with tenant scoping |
| `apps/runtime/src/contexts/contact/infrastructure/contact-audit.ts`            | 7 audit actions, fire-and-forget    |
| `apps/runtime/src/contexts/contact/use-cases/resolve-or-create-contact.ts`     | Find by blind index or create       |
| `apps/runtime/src/contexts/contact/use-cases/link-session-to-contact.ts`       | Session → contact linking           |
| `apps/runtime/src/contexts/contact/use-cases/execute-merge.ts`                 | Admin merge                         |
| `apps/runtime/src/contexts/contact/use-cases/self-merge.ts`                    | User self-merge                     |
| `apps/runtime/src/contexts/contact/use-cases/cascade-delete-contact.ts`        | GDPR hard-delete                    |
| `apps/runtime/src/contexts/contact/use-cases/detect-merge-candidates.ts`       | Overlapping blind index scan        |

### Runtime — Orchestration Context (DDD)

| File                                                                      | Purpose                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts` | Hot-path: channel → identity → contact → session |
| `apps/runtime/src/contexts/orchestration/use-cases/promote-and-link.ts`   | Mid-session tier promotion → contact → back-link |
| `apps/runtime/src/contexts/orchestration/use-cases/switch-channel.ts`     | Cross-channel continuity                         |
| `apps/runtime/src/contexts/orchestration/jobs/back-link-sessions.ts`      | BullMQ: retroactive session linking              |
| `apps/runtime/src/contexts/orchestration/jobs/detect-merge-candidates.ts` | BullMQ: merge candidate detection                |

### Runtime — Database Models

| File                                                       | Purpose                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `packages/database/src/models/channel-connection.model.ts` | ChannelConnection (encrypted credentials, indexes) |
| `packages/database/src/models/contact.model.ts`            | Contact (encrypted identities, blind indexes)      |
| `packages/database/src/models/merge-suggestion.model.ts`   | MergeSuggestion (overlap blind indexes)            |

### Studio — Channel UI

| File                                                                        | Purpose                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/studio/src/components/deployments/channels/channel-registry.tsx`      | Unified channel catalog — 14 channel types with capabilities, setup panels |
| `apps/studio/src/components/deployments/channels/ChannelInstanceList.tsx`   | Unified list view for all channel instances (DataTable)                    |
| `apps/studio/src/components/deployments/channels/ChannelInstanceConfig.tsx` | Unified tabbed detail view (overview, deployment, testing, activity)       |
| `apps/studio/src/components/deployments/ChannelsTab.tsx`                    | Main channel tab (catalog + inline SDK + HTTP Async panels)                |
| `apps/studio/src/components/deployments/ChannelCard.tsx`                    | SDK channel card component                                                 |
| `apps/studio/src/components/deployments/ChannelDetail.tsx`                  | SDK channel detail view                                                    |
| `apps/studio/src/components/deployments/EmbedCodeDialog.tsx`                | Embed code dialog                                                          |
| `apps/studio/src/components/deployments/channels/ChannelSetupPanel.tsx`     | Shared base for external channel setup                                     |
| `apps/studio/src/api/channels.ts`                                           | SDK channel API client                                                     |
| `apps/studio/src/api/channel-connections.ts`                                | Channel connection API client                                              |
| `apps/studio/src/api/http-async-channels.ts`                                | HTTP Async subscription API client                                         |

---

## 25. Channel OAuth

Generic OAuth 2.0 flow for provisioning channel connections. Instead of manually
pasting bot tokens, Studio redirects to the channel provider's consent screen and
receives credentials automatically.

### Architecture

```
┌─────────┐  POST /authorize   ┌──────────────────────┐  redirect   ┌──────────┐
│  Studio  │ ─────────────────► │ ChannelOAuthService   │ ──────────► │ Provider │
│  (SPA)   │ ◄── authUrl+state  │   ├ state store (CSRF)│             │ (Slack)  │
│          │                    │   └ provider registry  │             │          │
│          │  GET /callback     │                        │ ◄── code    │          │
│          │ ◄── credentials    │  exchangeCode(code)    │             │          │
└─────────┘                    └──────────────────────┘             └──────────┘
```

### Core Interface: `ChannelOAuthProvider`

```ts
interface ChannelOAuthProvider {
  readonly channelType: string;
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult>;
}

interface ChannelOAuthResult {
  credentials: Record<string, string>; // encrypted & stored in ChannelConnection
  externalIdentifier: string; // e.g. "T123ABC:A456XYZ" for Slack
  displayName: string; // e.g. "Slack - My Workspace"
  metadata: Record<string, unknown>;
}
```

### How to Add a New Channel OAuth Provider

1. **Create the provider** — Implement `ChannelOAuthProvider` in
   `apps/runtime/src/services/channel-oauth/providers/<channel>-oauth-provider.ts`.
2. **Register it** — Add env-var checks and `service.registerProvider(...)` in
   `apps/runtime/src/services/channel-oauth/providers/index.ts`.
3. **Update channel registry** — Set `supportsOAuth: true` in the channel's
   capabilities in `apps/studio/src/components/deployments/channels/channel-registry.tsx`.
4. **Add env vars** — Add `CHANNEL_OAUTH_<CHANNEL>_*` variables to `.env.example`.

### Environment Variables

| Variable                             | Required              | Description                                               |
| ------------------------------------ | --------------------- | --------------------------------------------------------- |
| `CHANNEL_OAUTH_SLACK_CLIENT_ID`      | Yes (for Slack OAuth) | Slack app client ID                                       |
| `CHANNEL_OAUTH_SLACK_CLIENT_SECRET`  | Yes (for Slack OAuth) | Slack app client secret                                   |
| `CHANNEL_OAUTH_SLACK_SIGNING_SECRET` | Yes (for Slack OAuth) | Slack app signing secret                                  |
| `CHANNEL_OAUTH_SLACK_SCOPES`         | No                    | Comma-separated Slack scopes (sensible defaults built in) |

### API Routes

| Method | Path                                        | Auth                            | Purpose                                                  |
| ------ | ------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| `POST` | `/api/channel-oauth/:channelType/authorize` | JWT + `credential:write`        | Initiate OAuth flow; returns `{ authUrl, state }`        |
| `GET`  | `/api/channel-oauth/:channelType/callback`  | `unifiedAuth` (no JWT required) | Provider redirect target; exchanges code for credentials |

The callback does not require a JWT header because IdP redirects (e.g., Slack) cannot
carry authorization headers. Security is enforced via the CSRF state token that embeds
`tenantId`, `userId`, `projectId`, and an expiry timestamp (10 min TTL).

### Key Files

| File                                                                        | Purpose                                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/runtime/src/services/channel-oauth/channel-oauth-provider.ts`         | `ChannelOAuthProvider` + `ChannelOAuthResult` interfaces    |
| `apps/runtime/src/services/channel-oauth/channel-oauth-service.ts`          | `ChannelOAuthService` — state management, provider dispatch |
| `apps/runtime/src/services/channel-oauth/providers/slack-oauth-provider.ts` | Slack OAuth V2 implementation                               |
| `apps/runtime/src/services/channel-oauth/providers/index.ts`                | Env-var-driven provider registration                        |
| `apps/runtime/src/routes/channel-oauth.ts`                                  | Express routes (`/authorize`, `/callback`)                  |
| `apps/studio/src/app/oauth/channel-callback/page.tsx`                       | Studio callback page (receives credentials via postMessage) |
| `apps/studio/src/api/channel-oauth.ts`                                      | Studio API client for channel OAuth                         |

---

_Document generated from codebase analysis on develop branch, covering commits through `0597c25f` (channel-level identity, contact management, cross-channel continuity)._
