# HLD: SDK Chat UI Consolidation

**Feature Spec**: [`docs/features/sub-features/sdk-chat-ui-consolidation.md`](../features/sub-features/sdk-chat-ui-consolidation.md)
**Test Spec**: [`docs/testing/sub-features/sdk-chat-ui-consolidation.md`](../testing/sub-features/sdk-chat-ui-consolidation.md)
**Status**: IMPLEMENTED
**Author**: Platform team
**Date**: 2026-04-03

---

## 1. Problem Statement & Goal

The ABL platform maintains two independent chat implementations: the Web SDK (`packages/web-sdk/`) for customer embeds and Studio's ChatPanel (`apps/studio/src/components/chat/`) for developer testing. Both independently implement message rendering, streaming protocol parsing (`response_start`/`response_chunk`/`response_end`), input handling, rich content, and actions across ~1,300 duplicated lines. Bug fixes must be applied in two places. The streaming protocol is parsed by two separate state machines. Thought cards, handoff indicators, and error surfacing exist only in Studio — SDK consumers have zero visibility into agent reasoning.

**Goal**: Make the Web SDK the single source of truth for all chat UI rendering. Studio consumes SDK components via a transport adapter, eliminating duplication and giving SDK consumers thought cards, handoff indicators, and error surfacing for free.

---

## 2. Alternatives Considered

### Option A: Shared Component Library (New Package)

- **Description**: Extract shared chat components into a new `packages/chat-components` package consumed by both `packages/web-sdk` and `apps/studio`.
- **Pros**: Clean separation of concerns. Both consumers import from a neutral package. No circular dependency risk.
- **Cons**: Introduces a new package to maintain. Doubles the build pipeline surface. Chat logic (ChatClient, streaming protocol) would still live in web-sdk, creating an awkward split between logic and UI. Studio would need to bridge its WebSocket to a neutral interface anyway.
- **Effort**: L (new package, build config, cross-package types, barrel exports)

### Option B: Transport Abstraction in Web SDK (Chosen)

- **Description**: Introduce `SDKTransport` interface in web-sdk. `DefaultTransport` wraps `SessionManager` for customers. `StudioTransport` (in `apps/studio`) bridges `WebSocketContext` to the same interface. Shared React components live in web-sdk. Studio's `StudioChatPanel` composes SDK components.
- **Pros**: No new package. Chat logic + UI co-located in web-sdk. SDK consumers get thought cards/handoff/error for free. Studio's one-line swap makes cutover and rollback trivial. Transport interface enables future transports (mobile, test harness) without touching UI code.
- **Cons**: Web SDK takes on composition responsibility (was previously presentation-only). Studio depends more heavily on web-sdk. StudioTransport must carefully avoid double-processing of thought/trace events (GAP-004).
- **Effort**: M (interface + adapter + components + cutover)

### Option C: Studio Imports SDK as-is (No Transport Abstraction)

- **Description**: Studio directly instantiates `AgentSDK` with API key auth, rendering SDK components. No transport interface, no adapter.
- **Pros**: Simplest implementation. No new abstractions.
- **Cons**: Studio would need its own API key (it uses JWT, not `pk_*`). Would bypass WebSocketContext entirely, breaking observatory, session sidebar, debug panel, trace pipeline, and all Zustand stores. Fundamentally incompatible with Studio's architecture.
- **Effort**: S (but doesn't work)

### Recommendation: Option B — Transport Abstraction in Web SDK

**Rationale**: Option B preserves Studio's existing WebSocketContext/Zustand architecture while allowing SDK components to render chat UI. The transport interface is a clean dependency inversion — Layers 2-3 (chat logic + UI) depend on an interface, not a concrete implementation. Option A creates unnecessary package overhead. Option C is architecturally incompatible with Studio's JWT auth and observatory pipeline.

---

## 3. Architecture

### System Context Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Consumer Web App                                │
│                                                                        │
│  ┌──────────────┐    ┌───────────────────┐    ┌──────────────────┐    │
│  │ <agent-chat>  │    │ <AgentProvider>   │    │ new AgentSDK()   │    │
│  │ Web Component │    │   <ChatWidget>    │    │ sdk.chat().send()│    │
│  └──────┬────────┘    └────────┬──────────┘    └────────┬─────────┘    │
│         │                      │                        │              │
│         └──────────────────────┴────────────────────────┘              │
│                                │                                       │
│                    ┌───────────┴──────────────┐                        │
│                    │   SDKTransport interface  │                        │
│                    │   (Layer 1 boundary)      │                        │
│                    └───────────┬──────────────┘                        │
│                                │                                       │
│                    ┌───────────┴──────────────┐                        │
│                    │   DefaultTransport        │                        │
│                    │   (wraps SessionManager)  │                        │
│                    └───────────┬──────────────┘                        │
└────────────────────────────────┼───────────────────────────────────────┘
                                 │  WebSocket (WSS)
                         ┌───────┴───────┐
                         │  ABL Runtime   │
                         └───────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                          Studio (apps/studio)                          │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────┐       │
│  │  ChatWithDebugPanel                                        │       │
│  │  ┌──────────────────────────────────────────────────┐      │       │
│  │  │  StudioChatPanel (Layer 4)                       │      │       │
│  │  │  ┌──────────────────┐  ┌──────────────────────┐  │      │       │
│  │  │  │ StudioChatHeader │  │ AuthChallengeMessage  │  │      │       │
│  │  │  │ (Studio-only)    │  │ SessionHealthBanner   │  │      │       │
│  │  │  └──────────────────┘  │ (Studio-only, RETAIN) │  │      │       │
│  │  │  ┌──────────────────┐  └──────────────────────┘  │      │       │
│  │  │  │ SDK Components   │                             │      │       │
│  │  │  │ (Layer 3)        │                             │      │       │
│  │  │  │ MessageList      │                             │      │       │
│  │  │  │ ChatInput        │                             │      │       │
│  │  │  │ StreamingMessage │                             │      │       │
│  │  │  │ ThoughtCard ──────── onViewTrace → Observatory │      │       │
│  │  │  └──────────────────┘                             │      │       │
│  │  └──────────────────────────────────────────────────┘      │       │
│  │  ┌────────────┐  ┌───────────────────────┐                 │       │
│  │  │DebugPanel  │  │  SessionSidebar       │ (unchanged)     │       │
│  │  └────────────┘  └───────────────────────┘                 │       │
│  └────────────────────────────────────────────────────────────┘       │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────┐    │
│  │  StudioTransport (Layer 1)                                     │    │
│  │  Bridges WebSocketContext → SDKTransport interface              │    │
│  │  ┌──────────────────────┐      ┌────────────────────────────┐  │    │
│  │  │  Chat messages       │─────>│  SDK ChatClient (Layer 2)  │  │    │
│  │  │  response_start/end  │      │  Messages, streaming       │  │    │
│  │  │  thought events      │      └────────────────────────────┘  │    │
│  │  └──────────┬───────────┘                                      │    │
│  │             │ (subscribes, does NOT intercept)                  │    │
│  │  ┌──────────┴───────────┐                                      │    │
│  │  │  WebSocketContext     │───> observatory-store (unchanged)    │    │
│  │  │  (all messages)       │───> session-store (unchanged)       │    │
│  │  │                       │───> trace-store (unchanged)         │    │
│  │  └──────────────────────┘                                      │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                │  WebSocket (WSS, JWT auth)            │
└────────────────────────────────┼───────────────────────────────────────┘
                                 │
                         ┌───────┴───────┐
                         │  ABL Runtime   │
                         └───────────────┘
```

### Component Diagram — 4-Layer Architecture

```
Layer 4 (Composition)
├── StudioChatPanel          (apps/studio) — composes SDK + Studio features
├── StudioChatHeader         (apps/studio) — agent info, debug, export, reset
├── ChatWidget               (web-sdk)     — composes all L3 components
└── AgentProvider            (web-sdk)     — React context, optional transport

Layer 3 (UI Components) — packages/web-sdk/src/react/
├── MessageList              — role-based dispatch (user/assistant/thought/system)
├── ChatInput                — text input, file upload, send
├── StreamingMessage         — animated chunk accumulation
├── ThoughtCard              — collapsible, onViewTrace callback
├── HandoffMessage           — agent A→B indicator
├── ErrorMessage             — severity-styled error display
├── RichContent              — template registry dispatch (MODIFY existing)
├── ActionHandler            — button/select/input actions
├── TypingIndicator          — animated dots
├── MarkdownContent          — sanitized markdown (replaces RichMessage)
├── icons.tsx                — shared SVG icons
└── sdk-styles.ts            — CSS-in-JS style constants

Layer 3 (Theme + Strings) — packages/web-sdk/src/react/
├── theme/ThemeProvider      — SDKThemeProvider, CSS custom properties
├── theme/default-theme      — default color/spacing values
├── strings/StringsProvider  — i18n overrides with defaults
└── strings/defaults         — English default strings

Layer 2 (Chat Logic) — packages/web-sdk/src/
├── chat/ChatClient          — MODIFY: accepts SDKTransport, thought/handoff/error
└── core/types               — MODIFY: Message role + metadata, MessageRole alias

Layer 1 (Transport) — interface boundary
├── transport/types           — SDKTransport interface, TransportMessage types
├── transport/DefaultTransport — wraps SessionManager (zero behavior change)
├── transport/index           — barrel + SessionManager alias re-export
└── (studio) adapters/useStudioTransport — bridges WebSocketContext
```

### Data Flow — Chat Message Round-Trip

**External SDK consumer (DefaultTransport):**

```
1. User types in ChatInput → onSend callback
2. ChatWidget calls ChatClient.send(text)
3. ChatClient calls transport.send({ type: 'chat_message', text, sessionId })
4. DefaultTransport delegates to SessionManager.send()
5. SessionManager sends WebSocket frame to Runtime
6. Runtime processes → streams response
7. SessionManager receives response_start/chunk/end frames
8. DefaultTransport translates to TransportServerMessage, emits 'message'
9. ChatClient.handleServerMessage() accumulates chunks into Message
10. ChatClient emits 'message' event
11. AgentProvider re-renders → MessageList shows new message
```

**Studio (StudioTransport):**

```
1. User types in SDK ChatInput (within StudioChatPanel)
2. ChatWidget calls ChatClient.send(text)
3. ChatClient calls transport.send({ type: 'chat_message', text, sessionId })
4. StudioTransport delegates to WebSocketContext.sendMessage()
5. WebSocketContext sends WebSocket frame to Runtime
6. Runtime processes → streams response
7. WebSocketContext receives ALL messages:
   a. Chat messages (response_start/chunk/end) → forwarded to StudioTransport
   b. Trace events → ingested into observatory-store (UNCHANGED)
   c. State updates → fed to session-store (UNCHANGED)
   d. Thought events → DUAL DELIVERY:
      i.  WebSocketContext ingests into observatory-store (existing path)
      ii. StudioTransport translates to TransportServerMessage(role:'thought')
8. StudioTransport emits 'message' event
9. ChatClient accumulates into Message array
10. SDK MessageList renders ThoughtCard with onViewTrace → observatory
```

### Sequence Diagram — StudioTransport Thought Event (GAP-004 Resolution)

```
Runtime          WebSocketContext      observatory-store    StudioTransport    ChatClient     ThoughtCard
  │                    │                      │                  │                │               │
  │── trace_event ────>│                      │                  │                │               │
  │  (tool_thought)    │                      │                  │                │               │
  │                    │── ingestLive ────────>│ (existing path)  │                │               │
  │                    │   TraceEvent()        │ addTraceEvent()  │                │               │
  │                    │                      │                  │                │               │
  │                    │── notify subscribers ─────────────────>│                │               │
  │                    │   (chat-relevant)     │                  │                │               │
  │                    │                      │                  │── emit ───────>│               │
  │                    │                      │                  │  'message'     │               │
  │                    │                      │                  │  {role:'thought'}              │
  │                    │                      │                  │                │── render ────>│
  │                    │                      │                  │                │  ThoughtCard  │
  │                    │                      │                  │                │  onViewTrace──>│
  │                    │                      │                  │                │               │ observatory
```

**Key insight**: StudioTransport **subscribes** to WebSocketContext events — it does NOT intercept them. WebSocketContext's existing handlers continue to run unchanged. StudioTransport adds a parallel listener that translates chat-relevant events into SDK transport format. There is no double-processing because:

- **Observatory path** (existing): WebSocketContext → `ingestLiveTraceEvent()` → observatory-store. Renders in DebugPanel.
- **SDK path** (new): WebSocketContext → StudioTransport listener → ChatClient → ThoughtCard UI.

These are independent outputs for different UI surfaces. The thought event appears in BOTH the observatory debug panel AND the chat ThoughtCard, which is the desired behavior.

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Transport carries `tenantId` from auth scope. `DefaultTransport` inherits from API key (`pk_*`). `StudioTransport` inherits from JWT claims via `WebSocketContext`. SDK components (Layers 2-3) never access tenant context directly — they call `transport.send()`. No new isolation boundaries.                                                                                                                                                                                                                                                  |
| 2   | **Data Access Pattern** | No database access. All state is ephemeral (in-memory). `ChatClient.messages: Message[]` is the source of truth for UI rendering. `DefaultTransport` delegates storage to `SessionManager`. `StudioTransport` reads from `useSessionStore` for session context. No caching layer.                                                                                                                                                                                                                                                                  |
| 3   | **API Contract**        | No new HTTP endpoints. `SDKTransport` interface is the internal contract: `connect()`, `disconnect()`, `isConnected()`, `send(TransportClientMessage)`, `on(event, handler)`, `getSessionId()`, `capabilities: TransportCapabilities`. File upload remains on `ChatClient.uploadAttachment(file: File)` (existing boundary). `TransportServerMessage` union: `response_start`, `response_chunk`, `response_end`, `thought`, `handoff`, `error`, `auth_challenge`. `Message.role` widens to include `'thought'`. `MessageRole` type alias exported. |
| 4   | **Security Surface**    | Auth separation: `DefaultTransport` = API key, `StudioTransport` = JWT. Components never touch auth. XSS prevention in `MarkdownContent` (strip `<script>`, `onerror`, `javascript:` URLs). `'use client'` directive for SSR safety. `ChatClient.uploadAttachment()` validates `File` input. No new attack surface — transport wraps existing WebSocket connections.                                                                                                                                                                               |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | Transport errors → `error` event with `{ code, message, severity }`. ChatClient translates to `Message(role:'system', metadata: { errorCode, severity })`. ErrorMessage component renders with severity styling. Non-fatal errors (tool failure) → warning in chat. Fatal errors (connection failure) → disconnected state. User can always send another message after non-fatal errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Failure Modes** | **Connection failure**: DefaultTransport retries with exponential backoff (inherited from SessionManager). StudioTransport inherits WebSocketContext reconnection. **Streaming interrupted**: orphaned `response_chunk` without `response_start` is ignored. **Theme/strings missing**: components fall back to defaults. **Transport missing**: AgentProvider creates DefaultTransport internally. **MessageMetadata type narrowing**: `metadata` changes from `Record<string, unknown>` to `MessageMetadata`. `MessageMetadata` preserves runtime compat via `[key: string]: unknown` index signature, but TypeScript type inference may narrow differently under strict settings. Existing code like `message.metadata?.customField` continues to work at runtime. Mitigation: verify during implementation that the index signature preserves assignability; document the widened type in release notes. |
| 7   | **Idempotency**   | N/A for this feature. Message sends are not idempotent by design (each send creates a new conversation turn). `ChatClient.generateId()` provides client-side message IDs for dedup in `hydrateBackfill()`. Transport `connect()` is idempotent (returns existing connection if already connected).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | **Observability** | Client-side only. `Message.metadata.traceIds` surfaces trace IDs for Studio's observatory link (`onViewTrace` callback). `DefaultTransport` logs with `[SDKTransport:Default]` prefix when `debug: true`. No new server-side traces. Browser DevTools remains primary SDK debugging surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Bundle: < 40KB gzipped for `@agent-platform/web-sdk/react` entry. Theming: zero JS runtime (CSS custom properties). Transport overhead: one event listener layer (negligible vs WebSocket latency). MessageList: bounded by ChatClient max messages. No virtualization needed at current scale.                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | **Migration Path**     | Incremental 6-phase delivery (feature spec Section 13). Phases 1-3 are SDK-only, additive, no Studio impact. Phase 4 adds StudioTransport adapter. Phase 5 is one-line swap + delete. Phase 6 is VoiceClient follow-on. No data migration. No database changes. No server-side changes.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11  | **Rollback Plan**      | Phase 5 cutover is a one-line change in `ChatWithDebugPanel.tsx` (`<StudioChatPanel>` → `<ChatPanel>`). Old Studio files are deleted in a SEPARATE commit after validation. If rollback needed: revert the swap commit, old files still exist. SDK changes are additive and do not affect rollback.                                                                                                                                                                                                                                                                                                                                                                                                          |
| 12  | **Test Strategy**      | The planned matrix is now partially realized on the current branch: transport/unit coverage in `packages/web-sdk/src/__tests__`, Studio integration coverage in `apps/studio/src/__tests__`, browser coverage in `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts`, and perf coverage in `apps/studio/e2e/sdk-chat-performance.spec.ts`. **Mock boundaries per surface** remain the same: (1) SDK integration tests mock the network boundary (`SessionManager`/`SDKTransport`) but use real `ChatClient` and components; (2) Studio integration tests mock the `WebSocketContext` boundary but use real `StudioTransport` and SDK rendering; (3) browser suites run against real Studio + Runtime flows. |

---

## 5. Requirement Traceability

| FR    | Description                           | Addressed In                                                                                   |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| FR-1  | SDKTransport interface                | §3 Component Diagram (Layer 1), §4 Concern #3 (API Contract), §6 Data Model (SDKTransport def) |
| FR-2  | DefaultTransport wraps SessionManager | §3 Data Flow (External SDK), §6 Data Model (DefaultTransport), §9 Dependencies                 |
| FR-3  | SessionManager re-export              | §7 API Design (new exports table, SessionManager row)                                          |
| FR-4  | ChatClient accepts SDKTransport       | §3 Component Diagram (Layer 2), §6 Data Model (Key Relationships)                              |
| FR-5  | Message type widening (role+metadata) | §6 Data Model (Message type before/after, MessageRole, MessageMetadata)                        |
| FR-6  | Thought/handoff/error → Message       | §3 Sequence Diagram (GAP-004), §4 Concern #5 (Error Model)                                     |
| FR-7  | Shared React components               | §3 Component Diagram (Layer 3), §7 API Design (react exports table)                            |
| FR-8  | AgentProvider optional transport      | §7 API Design (modified exports table), §4 Concern #6 (Transport missing fallback)             |
| FR-9  | SDKThemeProvider (CSS custom props)   | §3 Component Diagram (Layer 3 Theme), §8 Cross-Cutting (Caching), §4 Concern #9 (Performance)  |
| FR-10 | StringsProvider (i18n overrides)      | §3 Component Diagram (Layer 3 Strings), §7 API Design (react exports)                          |
| FR-11 | StudioTransport adapter               | §3 System Context (Studio section), §3 Data Flow (Studio), §3 Sequence Diagram                 |
| FR-12 | StudioChatPanel composition           | §3 System Context (Studio section), §3 Component Diagram (Layer 4)                             |
| FR-13 | ThoughtCard onViewTrace callback      | §3 Sequence Diagram (onViewTrace → observatory), §4 Concern #8 (Observability)                 |
| FR-14 | Delete Studio duplicate files         | §4 Concern #10 (Migration Path Phase 5), §4 Concern #11 (Rollback Plan)                        |
| FR-15 | Existing hooks/Web Components intact  | §7 API Design (no breaking changes), §4 Concern #3 (API Contract), §2 Option B (Pros)          |

---

## 6. Data Model

### New Collections/Tables

None. This is a purely client-side refactoring. No server-side persistence changes.

### Modified Types (Client-Side)

**`Message` type extension** (`packages/web-sdk/src/core/types.ts`):

```typescript
// Before
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  richContent?: RichContent;
  actions?: ActionSet;
  attachments?: AttachmentRef[];
  sourceChannel?: SourceChannel;
  inputMode?: InputMode;
}

// After
export type MessageRole = 'user' | 'assistant' | 'system' | 'thought';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  richContent?: RichContent;
  actions?: ActionSet;
  attachments?: AttachmentRef[];
  sourceChannel?: SourceChannel;
  inputMode?: InputMode;
}

export interface MessageMetadata {
  // Thought metadata
  toolName?: string;
  agentName?: string;
  traceIds?: string[];
  llmCallId?: string;
  // Handoff metadata
  handoffFrom?: string;
  handoffTo?: string;
  // Error metadata
  errorCode?: string;
  severity?: 'warning' | 'error';
  // Extensible
  [key: string]: unknown;
}
```

**`SDKTransport` interface** (`packages/web-sdk/src/transport/types.ts`):

```typescript
export interface SDKTransport {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  send(message: TransportClientMessage): void;
  on(event: 'message', handler: (msg: TransportServerMessage) => void): () => void;
  on(event: 'connected', handler: () => void): () => void;
  on(event: 'disconnected', handler: (reason?: string) => void): () => void;
  on(event: 'error', handler: (error: TransportError) => void): () => void;
  getSessionId(): string | null;
  capabilities: TransportCapabilities;
}

export interface TransportCapabilities {
  supportsThoughts: boolean;
  supportsHandoff: boolean;
  supportsFileUpload: boolean;
  supportsVoice: boolean;
}

export type TransportClientMessage =
  | { type: 'chat_message'; text: string; sessionId?: string; attachmentIds?: string[] }
  | { type: 'action_submit'; actionId: string; value?: string }
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' }
  | { type: 'typed_interrupt'; text: string; messageId: string; sessionId: string };

export type TransportServerMessage =
  | { type: 'response_start'; messageId: string }
  | { type: 'response_chunk'; content: string; messageId: string }
  | {
      type: 'response_end';
      messageId: string;
      content: string;
      richContent?: RichContent;
      actions?: ActionSet;
      sourceChannel?: SourceChannel;
    }
  | { type: 'thought'; content: string; metadata: MessageMetadata }
  | { type: 'handoff'; metadata: MessageMetadata }
  | { type: 'error'; content: string; metadata: MessageMetadata }
  | {
      type: 'auth_challenge';
      sessionId: string;
      toolCallId: string;
      authType: string;
      authUrl?: string;
      profileId: string;
      profileName: string;
      prompt: string;
      timeoutMs: number;
    }
  | { type: 'status_update'; text: string; operation?: string }
  | { type: 'status_clear' };
```

### Key Relationships

- `SDKTransport` is consumed by `ChatClient` (constructor injection) and `AgentProvider` (optional prop)
- `DefaultTransport` wraps `SessionManager` — one-to-one delegation
- `StudioTransport` subscribes to `WebSocketContext` — read-only listener, never modifies WebSocketContext state
- `Message.metadata` is now typed as `MessageMetadata` (was `Record<string, unknown>`)

---

## 7. API Design

### New Endpoints

None. This feature is purely client-side. No new HTTP routes, no new WebSocket message types.

### Modified Client-Side API

**New exports from `@agent-platform/web-sdk`:**

| Export                   | Type      | Purpose                                          |
| ------------------------ | --------- | ------------------------------------------------ |
| `SDKTransport`           | interface | Transport contract for ChatClient                |
| `DefaultTransport`       | class     | Wraps SessionManager                             |
| `TransportCapabilities`  | interface | Feature flag object                              |
| `TransportClientMessage` | type      | Client-to-server message union                   |
| `TransportServerMessage` | type      | Server-to-client message union                   |
| `MessageRole`            | type      | `'user' \| 'assistant' \| 'system' \| 'thought'` |
| `MessageMetadata`        | interface | Typed metadata for thought/handoff/error         |
| `SessionManager`         | class     | Re-exported alias (backwards compat, FR-3)       |

**New exports from `@agent-platform/web-sdk/react`:**

| Export             | Type      | Purpose                              |
| ------------------ | --------- | ------------------------------------ |
| `MessageList`      | component | Role-based message rendering         |
| `ChatInput`        | component | Text input + file upload + send      |
| `StreamingMessage` | component | Animated streaming display           |
| `ThoughtCard`      | component | Collapsible thought with onViewTrace |
| `HandoffMessage`   | component | Agent handoff indicator              |
| `ErrorMessage`     | component | Severity-styled error display        |
| `ActionHandler`    | component | Button/select/input actions          |
| `TypingIndicator`  | component | Animated dots                        |
| `ChatWidget`       | component | Composed chat widget                 |
| `MarkdownContent`  | component | Sanitized markdown renderer          |
| `SDKThemeProvider` | component | CSS custom property provider         |
| `StringsProvider`  | component | i18n string overrides                |

**Modified exports:**

| Export          | Change                                            |
| --------------- | ------------------------------------------------- |
| `AgentProvider` | New optional `transport?: SDKTransport` prop      |
| `Message`       | `role` widened to `MessageRole`, `metadata` typed |

### Error Responses

N/A — no HTTP endpoints. Transport errors surface as `TransportError` events:

```typescript
export interface TransportError {
  code: string; // e.g., 'CONNECTION_FAILED', 'AUTH_EXPIRED', 'SEND_FAILED'
  message: string;
  recoverable: boolean;
}
```

---

## 8. Cross-Cutting Concerns

- **Audit Logging**: N/A — no server-side changes. Client-side debug logging via `[SDKTransport:*]` prefix when `debug: true`.
- **Rate Limiting**: Unchanged. Server-side rate limiting via `checkSessionMessageRate()` per `sdk.hld.md`. Transport does not bypass rate limits.
- **Caching**: No caching. Message arrays are ephemeral. Theme values are CSS custom properties (browser-cached natively).
- **Encryption**: Unchanged. WebSocket connections use WSS (TLS). No client-side encryption changes.
- **Tree-shaking**: React components exported from `@agent-platform/web-sdk/react` sub-path. Consumers who only use `AgentSDK` programmatically do not bundle React components.
- **SSR Safety**: All React components use `'use client'` directive. Components guarded with `typeof window !== 'undefined'` where browser APIs are accessed.

---

## 9. Dependencies

### Upstream (this feature depends on)

| Dependency                   | Type                 | Risk   |
| ---------------------------- | -------------------- | ------ |
| `SessionManager` (web-sdk)   | Internal, wraps WS   | Low    |
| `WebSocketContext` (studio)  | Internal, 1045 lines | Medium |
| `observatory-store` (studio) | Internal, Zustand    | Low    |
| `session-store` (studio)     | Internal, Zustand    | Low    |
| SDK Auth Session Unification | Feature dependency   | Low    |
| React 18                     | Peer dependency      | Low    |

### Downstream (depends on this feature)

| Consumer                                | Impact                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| External SDK consumers (React)          | Gain thought/handoff/error components. No breaking changes. |
| External SDK consumers (Web Components) | Unaffected — Web Components do not use React layer.         |
| Studio chat panel                       | Migrated from own components to SDK components.             |
| SDK Rich Content Templates              | RichContent.tsx moves to `react/components/`, re-exported.  |
| Future mobile/test transports           | Can implement `SDKTransport` interface.                     |

---

## 10. Open Questions & Decisions Needed

1. **Omnichannel methods on SDKTransport**: Should `discoverLiveSession()` and `joinLiveSession()` be added to the `SDKTransport` interface as optional methods, or remain on `AgentSDK` directly? (Feature spec GAP-003. Current decision: remain on AgentSDK.)
2. **CSS custom property namespace**: Should the theme system use `--sdk-*`, `--abl-*`, or `--abl-sdk-*` as the prefix? (Feature spec OQ-3. Recommendation: `--sdk-*` for brevity.)
3. **StudioTransport session switch**: When Studio switches sessions, should `StudioTransport` emit `disconnected` + `connected` events, or should it transparently swap the underlying session? (Recommendation: emit lifecycle events so ChatClient resets its message array.)
4. **MessageMetadata backwards compatibility**: The `metadata` field changes from `Record<string, unknown>` to `MessageMetadata`. `MessageMetadata` extends `Record<string, unknown>` via index signature, preserving compatibility, but existing code that checks `metadata?.someField` should still work. Verify during implementation.
5. **Status message transport events**: ~~Deferred~~ **DECIDED (LLD D-9)**: `status_update` and `status_clear` added to `TransportServerMessage` union. Required by existing ChatClient consumers (VoiceClient, AgentProvider status listeners). Additive change, no scope risk. Types included in Section 6 definition above.

---

## 11. References

- Feature spec: [`docs/features/sub-features/sdk-chat-ui-consolidation.md`](../features/sub-features/sdk-chat-ui-consolidation.md)
- Test spec: [`docs/testing/sub-features/sdk-chat-ui-consolidation.md`](../testing/sub-features/sdk-chat-ui-consolidation.md)
- SDK HLD: [`docs/specs/sdk.hld.md`](sdk.hld.md)
- SDK Auth Session Unification: [`docs/specs/sdk-auth-session-unification.hld.md`](sdk-auth-session-unification.hld.md)
- Design spec (feature branch): `docs/superpowers/specs/2026-03-17-web-sdk-studio-consolidation-design.md` (on `origin/KI0326/feature/SDK`)

---

## 12. Post-Implementation Notes

_Added 2026-03-26 after implementation complete on `feature/sdk-chat-ui-consolidation`._

- **Turbopack + esbuild workaround**: Turbopack cannot resolve `.js` to `.ts` extensions for sub-path exports. Required an esbuild post-build script (`packages/web-sdk/scripts/create-react-entry.mjs`) to generate a bundled React entry point for Studio consumption.
- **StreamingMessage activation deferred (PROD-12)**: The StreamingMessage component renders but streaming text is not wired to MessageList — a typing indicator is shown instead during streaming. Wiring deferred to BETA.
- **Attachment forwarding bug (PROD-2)**: Found during PR review rounds 4-5 that attachment IDs were not forwarded through the transport layer on `chat_message`. Fixed by including `attachmentIds` in `TransportClientMessage`.
