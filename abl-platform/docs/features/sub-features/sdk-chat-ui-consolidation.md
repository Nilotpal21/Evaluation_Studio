# Feature: SDK Chat UI Consolidation

**Doc Type**: SUB-FEATURE
**Parent Feature**: [SDK](../sdk.md)
**Status**: BETA
**Feature Area(s)**: `customer experience`, `integrations`, `agent lifecycle`
**Package(s)**: `packages/web-sdk`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/sdk-chat-ui-consolidation.md](../../testing/sub-features/sdk-chat-ui-consolidation.md)
**Last Updated**: 2026-04-03

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform maintains two independent chat implementations:

1. **Web SDK** (`packages/web-sdk/`) — customer-facing embeddable SDK with ChatClient, ChatWidget (Web Component), and basic React components (AgentProvider, RichMessage).
2. **Studio ChatPanel** (`apps/studio/src/components/chat/`) — developer-facing chat with debug panel integration, thought cards, session switching, health banners, and auth challenge handling (~1,300 lines across ChatPanel.tsx, MessageList.tsx, ChatInput.tsx, StreamingMessage.tsx).

Both implement message rendering, streaming, input handling, rich content, and actions independently. Bug fixes and feature additions must be duplicated. The streaming protocol (`response_start`/`response_chunk`/`response_end`) is parsed in two separate state machines (SDK's `TypedEventEmitter<ChatEvents>` vs Studio's Zustand session-store). Thought/handoff/error rendering exists only in Studio — SDK consumers have no visibility into agent thinking.

### Goal Statement

Make the Web SDK the single source of truth for chat UI. Studio consumes SDK components via a `StudioTransport` adapter, eliminating ~1,300 lines of duplicate chat code. SDK consumers gain thought cards, handoff messages, and error surfacing for free. Fix once, render everywhere.

### Summary

This feature introduces a transport-agnostic architecture to the Web SDK:

- **Layer 1 (Transport)**: `SDKTransport` interface with `DefaultTransport` (customer, API key auth) and `StudioTransport` (JWT auth, bridges WebSocketContext).
- **Layer 2 (Chat Logic)**: `ChatClient` refactored to accept `SDKTransport` instead of `SessionManager`. Extended `Message` type with `role: 'thought'` and handoff/error metadata.
- **Layer 3 (UI Components)**: 10 shared React components (MessageList, ChatInput, StreamingMessage, ThoughtCard, HandoffMessage, ErrorMessage, RichContent, ActionHandler, TypingIndicator, ChatWidget).
- **Layer 4 (Composition)**: Studio wraps SDK components with `StudioChatPanel` + `StudioChatHeader` for debug/export/reset/session features. Customer embeds use SDK as-is.

The existing public API (`AgentProvider`, `useChat`, `useAgent`, Web Components) remains backwards-compatible. `SessionManager` is re-exported as an alias.

---

## 2. Scope

### Goals

- Introduce `SDKTransport` interface as a pluggable connection abstraction for chat and voice
- Implement `DefaultTransport` (wraps current SessionManager, zero behavior change for customers)
- Implement `StudioTransport` adapter (bridges WebSocketContext/Zustand stores for Studio)
- Refactor `ChatClient` to accept `SDKTransport` instead of `SessionManager`
- Extend `Message` type with `role: 'thought'` and handoff/error metadata
- Build 10 shared React UI components for chat rendering
- Add theme system via CSS custom properties (`SDKThemeProvider`)
- Add strings/i18n abstraction for SDK components (`StringsProvider`)
- Update `AgentProvider` with optional `transport` prop
- Create `StudioChatPanel` wrapper with Studio-specific header
- Delete Studio's duplicate chat files (ChatPanel.tsx, MessageList.tsx, ChatInput.tsx, StreamingMessage.tsx)
- Maintain full backwards compatibility for SDK public API

### Non-Goals (Out of Scope)

- Voice UI component consolidation — transport designed for both, but voice widget UI not being replaced
- Web Component changes — `<agent-chat>`, `<agent-voice>`, `<agent-widget>` remain unchanged
- SessionSidebar, DebugPanel, FloatingDebugPanel, Observatory changes — these Studio components are unchanged
- WebSocketContext replacement — StudioTransport wraps it, does not replace it
- Runtime/backend changes — this is purely a client-side refactoring
- Customer-facing theming documentation — theme system ships, docs are follow-on
- Omnichannel session continuity UI changes — transcript hydration continues to work through existing ChatClient methods
- `AuthChallengeMessage.tsx` and `SessionHealthBanner.tsx` — these Studio-only components are RETAINED (not deleted, not moved to SDK). `StudioChatPanel` renders them directly. They are not generalized for SDK consumers.

---

## 3. User Stories

1. As an **agent developer** using Studio, I want the chat panel to work identically after the consolidation so that my debugging workflow (thought cards, trace links, debug panel, session switching, export) is uninterrupted.
2. As an **SDK consumer** (external developer), I want to embed a chat widget that shows agent thinking and handoff events inline so that my end users understand what the agent is doing.
3. As an **SDK consumer**, I want the existing `<AgentProvider projectId="..." apiKey="...">` API to continue working so that I do not need to change my integration code.
4. As a **platform developer**, I want to fix chat bugs in one place (web-sdk) so that both Studio and customer embeds benefit from the fix simultaneously.
5. As an **SDK consumer**, I want to customize the chat appearance with my brand colors via a theme prop so that the widget matches my application's design.
6. As an **SDK consumer**, I want to override UI strings (labels, placeholders, accessibility text) so that I can localize the chat experience.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide an `SDKTransport` interface with `connect()`, `disconnect()`, `isConnected()`, `send()`, `on()`, `getSessionId()`, and a `capabilities` object declaring supported features. File upload remains on `ChatClient.uploadAttachment()` (existing boundary).
2. **FR-2**: The system must provide a `DefaultTransport` implementation that wraps the current `SessionManager` with zero behavior change for existing SDK consumers.
3. **FR-3**: The system must re-export `SessionManager` as a backwards-compatible alias from the transport module.
4. **FR-4**: The system must refactor `ChatClient` to accept `SDKTransport` in its constructor instead of `SessionManager`, while preserving all public API methods (`send`, `submitAction`, `uploadAttachment`, `getMessages`, `clearMessages`).
5. **FR-5**: The `Message` type must be extended with `role: 'thought'` and optional metadata fields: `toolName`, `agentName`, `handoffFrom`, `handoffTo`, `errorCode`, `severity`, `traceIds`. This widens the `role` union from `'user' | 'assistant' | 'system'` to `'user' | 'assistant' | 'system' | 'thought'`. The change is additive (existing consumers that pattern-match on `'user' | 'assistant' | 'system'` will need a default/fallback case), but existing runtime behavior is unchanged since `'thought'` messages only appear when a transport emits thought events.
6. **FR-6**: When a transport emits thought/handoff/error events, `ChatClient` must translate them into `Message` objects with the appropriate role and metadata.
7. **FR-7**: The system must provide shared React components: MessageList, ChatInput, StreamingMessage, ThoughtCard, HandoffMessage, ErrorMessage, RichContent, ActionHandler, TypingIndicator, and ChatWidget.
8. **FR-8**: `AgentProvider` must accept an optional `transport` prop. When provided, it uses the transport directly (ignoring `projectId`/`apiKey`). When absent, it creates a `DefaultTransport` internally (existing behavior).
9. **FR-9**: The system must provide `SDKThemeProvider` that applies theming via CSS custom properties with a default theme.
10. **FR-10**: The system must provide a `StringsProvider` for SDK component labels with defaults and consumer override capability.
11. **FR-11**: Studio must provide a `StudioTransport` adapter (`useStudioTransport` hook) that bridges `WebSocketContext` and Zustand stores to the `SDKTransport` interface.
12. **FR-12**: Studio must provide `StudioChatPanel` that composes SDK components with Studio-specific features (agent header, debug toggle, export, reset) and retains Studio-only components (`AuthChallengeMessage`, `SessionHealthBanner`) rendered alongside the SDK chat UI.
13. **FR-13**: The ThoughtCard component must accept an optional `onViewTrace` callback prop so Studio can link thought cards to the observatory debug panel.
14. **FR-14**: After the cutover, Studio's duplicate chat files (ChatPanel.tsx, MessageList.tsx, ChatInput.tsx, StreamingMessage.tsx) must be deleted.
15. **FR-15**: All existing SDK hooks (`useChat`, `useAgent`, `useVoice`) and Web Components must continue to function without changes.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                   |
| -------------------------- | ------------ | ------------------------------------------------------- |
| Project lifecycle          | NONE         | No project-scoped data changes                          |
| Agent lifecycle            | SECONDARY    | Studio agent testing UI affected                        |
| Customer experience        | PRIMARY      | SDK chat gains thought cards, handoff, error surfacing  |
| Integrations / channels    | SECONDARY    | Transport abstraction enables future channel transports |
| Observability / tracing    | SECONDARY    | Thought/trace metadata surfaced to SDK consumers        |
| Governance / controls      | NONE         | No guardrail changes                                    |
| Enterprise / compliance    | NONE         | No PII, no persistence changes                          |
| Admin / operator workflows | NONE         | Admin portal unaffected                                 |

### Related Feature Integration Matrix

| Related Feature                                                                 | Relationship Type | Why It Matters                                                                 | Key Touchpoints                                                       | Current State |
| ------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------- |
| [SDK](../sdk.md)                                                                | extends           | Chat consolidation extends the SDK's React and transport layers                | AgentProvider, ChatClient, SessionManager, types.ts                   | BETA          |
| [SDK Rich Content Templates](sdk-rich-content-templates.md)                     | shares data with  | Template renderers produce React elements consumed by the shared MessageList   | RichContent.tsx, templates/registry.ts, rich-renderer.ts              | BETA          |
| [Tracing & Observability](../tracing-observability.md)                          | emits into        | StudioTransport bridges trace events into observatory-store                    | WebSocketContext, observatory-store, ThoughtCard onViewTrace callback | STABLE        |
| [Omnichannel Session Continuity](../omnichannel-session-continuity.md)          | depends on        | ChatClient.hydrateBackfill() must continue working with transport abstraction  | ChatClient, SessionManager/DefaultTransport                           | ALPHA         |
| [Agent Development Studio](../agent-development-studio.md)                      | configured by     | Studio chat panel is the primary agent testing surface                         | ChatWithDebugPanel, StudioChatPanel, SessionSidebar                   | BETA          |
| [SDK Auth Session Unification](../../specs/sdk-auth-session-unification.hld.md) | depends on        | DefaultTransport wraps SessionManager which implements the auth bootstrap flow | /api/v1/sdk/init, /api/v1/sdk/refresh, sdk-auth subprotocol           | BETA          |

---

## 6. Design Considerations

- **Transport-agnostic architecture**: The SDK decouples UI from connection management. Layers 2-3 never import from Layer 1 directly. They communicate through the `SDKTransport` interface. This keeps the SDK functional for customers while enabling Studio to inject its own transport.
- **Composition over replacement**: Studio's `StudioChatPanel` composes SDK components rather than replacing the entire debug panel. SessionSidebar, DebugTabs, FloatingDebugPanel, resize divider — all untouched. Only the chat rendering is swapped.
- **CSS custom properties for theming**: Zero JS runtime cost. Studio passes its design tokens; customers pass brand colors. Components use `var(--sdk-primary-color)` internally.
- **ThoughtCard extensibility**: The SDK's ThoughtCard renders expand/collapse and tool name. Studio adds "View trace" links via the `onViewTrace` callback prop, not by forking the component.
- **`'use client'` boundary**: SDK React components must be client-only. Next.js SSR will not attempt to render WebSocket-dependent code.

---

## 7. Technical Considerations

- **Backwards compatibility is non-negotiable**: `SessionManager` must be re-exported as alias. `AgentProvider` without `transport` prop must work identically. All existing hooks must function. Web Components are unchanged. The `Message.role` type widens from `'user' | 'assistant' | 'system'` to include `'thought'` — this is a **type-level breaking change** for TypeScript consumers who exhaustively switch on `role`. Mitigation: existing consumers never see `'thought'` messages unless their transport emits thought events (DefaultTransport does; custom transports may). Documentation must call this out. A `MessageRole` type alias should be exported for consumers who want to switch on role.
- **StudioTransport is a thin adapter, not a replacement**: `WebSocketContext` continues to receive ALL WebSocket messages and feed observatory-store/trace-store/session-store. `StudioTransport` subscribes to a subset (chat messages) and translates them to `TransportServerMessage` format. Studio-only message types (`state_update`, `action_taken`, `dsl_collect`, `context_injected`) stay in WebSocketContext and feed Zustand stores directly.
- **Omnichannel gap**: The `SDKTransport` interface in the design spec does not include omnichannel methods (`discoverLiveSession`, `joinLiveSession`). These are currently on `AgentSDK` directly. They can remain there or be exposed through an optional extension interface.
- **Bundle size**: New React components go into `react/components/`, tree-shakeable via the `@agent-platform/web-sdk/react` entry point. Web Component bundles are unaffected.
- **Auth separation**: `DefaultTransport` uses API key auth (`pk_*`). `StudioTransport` uses JWT auth via `authHeaders()`. The SDK UI components never touch auth directly.

---

## 8. How to Consume

### Studio UI

Studio's `ChatWithDebugPanel.tsx` swaps one line:

```diff
- <ChatPanel onToggleDebug={toggleDebugPanel} debugPanelOpen={debugPanelOpen} />
+ <StudioChatPanel onToggleDebug={toggleDebugPanel} debugPanelOpen={debugPanelOpen} />
```

All other Studio surfaces (SessionSidebar, DebugTabs, Observatory) remain unchanged.

### API (Runtime)

No new HTTP endpoints. Transport is a client-side concern.

### API (Studio)

No new API routes. The StudioTransport adapter bridges existing WebSocket connections.

### Admin Portal

N/A — admin portal unaffected.

### Channel / SDK / Voice / A2A / MCP Integration

- **Web SDK (React)**: `<AgentProvider projectId="..." apiKey="...">` + `useChat()` — unchanged API, but consumers now get thought cards, handoff messages, and error surfacing for free via the shared components.
- **Web SDK (React, custom transport)**: `<AgentProvider transport={myTransport}>` — new capability for advanced consumers.
- **Web Components**: `<agent-chat>`, `<agent-voice>`, `<agent-widget>` — unchanged.
- **Voice**: Transport abstraction covers voice, but voice UI components are not being replaced in this scope.
- **A2A / MCP**: Not affected — transport is browser-side only.

---

## 9. Data Model

### Collections / Tables

No new database collections. This is a purely client-side refactoring. No server-side data model changes.

### Key Relationships

- `Message` type gains `role: 'thought'` and metadata fields — this is a wire-format type extension, not a persistence change
- `SDKTransport` is a client-side interface; transport instances are ephemeral (created on mount, destroyed on unmount)
- `StudioTransport` reads from existing Zustand stores (session-store, observatory-store) via subscriptions

---

## 10. Key Implementation Files

All files marked **NEW** are created by this feature. Files marked **MODIFY** exist on develop and require changes. Files marked **DELETE** are removed.

### Domain / Core Logic

| File                                                 | Status  | Purpose                                                      |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------ |
| `packages/web-sdk/src/transport/types.ts`            | **NEW** | `SDKTransport` interface, `TransportMessage` types           |
| `packages/web-sdk/src/transport/DefaultTransport.ts` | **NEW** | Wraps SessionManager, implements SDKTransport                |
| `packages/web-sdk/src/transport/index.ts`            | **NEW** | Barrel exports, SessionManager alias re-export               |
| `packages/web-sdk/src/chat/ChatClient.ts`            | MODIFY  | Constructor accepts SDKTransport; thought/handoff processing |
| `packages/web-sdk/src/core/AgentSDK.ts`              | MODIFY  | Uses DefaultTransport internally                             |
| `packages/web-sdk/src/core/types.ts`                 | MODIFY  | Extended `Message` type with thought role + metadata         |
| `packages/web-sdk/src/voice/VoiceClient.ts`          | MODIFY  | Constructor accepts SDKTransport (follow-on)                 |
| `packages/web-sdk/src/index.ts`                      | MODIFY  | Export transport types                                       |

### UI Components

| File                                                         | Status     | Purpose                                                                                                 |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------- |
| `packages/web-sdk/src/react/components/MessageList.tsx`      | **NEW**    | Renders Message[] with role-based dispatch                                                              |
| `packages/web-sdk/src/react/components/ChatInput.tsx`        | **NEW**    | Text input, file upload, send button                                                                    |
| `packages/web-sdk/src/react/components/StreamingMessage.tsx` | **NEW**    | Animated streaming content display                                                                      |
| `packages/web-sdk/src/react/components/ThoughtCard.tsx`      | **NEW**    | Collapsible thinking card (role: 'thought')                                                             |
| `packages/web-sdk/src/react/components/HandoffMessage.tsx`   | **NEW**    | Agent routing A→B indicator                                                                             |
| `packages/web-sdk/src/react/components/ErrorMessage.tsx`     | **NEW**    | Styled error/warning display                                                                            |
| `packages/web-sdk/src/react/components/RichContent.tsx`      | MODIFY     | Moved from `react/RichContent.tsx` into `react/components/` and updated to work with shared MessageList |
| `packages/web-sdk/src/react/components/ActionHandler.tsx`    | **NEW**    | Renders button/select/input action sets                                                                 |
| `packages/web-sdk/src/react/components/TypingIndicator.tsx`  | **NEW**    | Animated typing dots                                                                                    |
| `packages/web-sdk/src/react/components/ChatWidget.tsx`       | **NEW**    | Composes all above into complete chat                                                                   |
| `packages/web-sdk/src/react/components/icons.tsx`            | **NEW**    | Shared icon components                                                                                  |
| `packages/web-sdk/src/react/components/MarkdownContent.tsx`  | **NEW**    | Markdown renderer replacing RichMessage.tsx                                                             |
| `packages/web-sdk/src/react/components/sdk-styles.ts`        | **NEW**    | SDK component CSS-in-JS styles                                                                          |
| `packages/web-sdk/src/react/RichMessage.tsx`                 | MODIFY     | Deprecated wrapper — delegates to MarkdownContent (kept per export removal guard)                       |
| `packages/web-sdk/src/react/theme/ThemeProvider.tsx`         | **NEW**    | SDKThemeProvider with CSS custom properties                                                             |
| `packages/web-sdk/src/react/theme/default-theme.ts`          | **NEW**    | Default theme values                                                                                    |
| `packages/web-sdk/src/react/theme/types.ts`                  | **NEW**    | Theme type definitions                                                                                  |
| `packages/web-sdk/src/react/strings/StringsProvider.tsx`     | **NEW**    | i18n strings provider                                                                                   |
| `packages/web-sdk/src/react/strings/defaults.ts`             | **NEW**    | Default string values                                                                                   |
| `packages/web-sdk/src/react/strings/types.ts`                | **NEW**    | String type definitions                                                                                 |
| `packages/web-sdk/src/react/AgentProvider.tsx`               | MODIFY     | Optional `transport` prop                                                                               |
| `packages/web-sdk/src/react/index.ts`                        | MODIFY     | Export new components + hooks                                                                           |
| `apps/studio/src/adapters/useStudioTransport.ts`             | **NEW**    | Bridges WebSocketContext to SDKTransport                                                                |
| `apps/studio/src/components/chat/StudioChatPanel.tsx`        | **NEW**    | SDK components + Studio-specific header                                                                 |
| `apps/studio/src/components/chat/StudioChatHeader.tsx`       | **NEW**    | Agent info, debug toggle, export, reset                                                                 |
| `apps/studio/src/components/chat/ChatWithDebugPanel.tsx`     | MODIFY     | One-line swap to StudioChatPanel                                                                        |
| `apps/studio/src/components/chat/ChatPanel.tsx`              | **DELETE** | Replaced by StudioChatPanel                                                                             |
| `apps/studio/src/components/chat/MessageList.tsx`            | **DELETE** | Replaced by SDK MessageList                                                                             |
| `apps/studio/src/components/chat/ChatInput.tsx`              | **DELETE** | Replaced by SDK ChatInput                                                                               |
| `apps/studio/src/components/chat/StreamingMessage.tsx`       | **DELETE** | Replaced by SDK StreamingMessage                                                                        |
| `apps/studio/src/components/chat/AuthChallengeMessage.tsx`   | RETAIN     | Studio-only — rendered by StudioChatPanel when auth challenge occurs                                    |
| `apps/studio/src/components/chat/SessionHealthBanner.tsx`    | RETAIN     | Studio-only — rendered by StudioChatPanel for session health warnings                                   |
| `apps/studio/src/contexts/WebSocketContext.tsx`              | MODIFY     | Add chatMessageEmitter + subscribeChatMessage for StudioTransport subscription                          |

### Routes / Handlers

N/A — no new HTTP routes or API handlers. Transport is a client-side concern. Studio's existing WebSocket routes are unchanged.

### Jobs / Workers / Background Processes

N/A — no background processing.

### Tests

| File                                                                | Type        | Coverage Focus                                    |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------- |
| `packages/web-sdk/src/__tests__/transport-types.test.ts`            | unit        | SDKTransport interface contract                   |
| `packages/web-sdk/src/__tests__/default-transport.test.ts`          | integration | DefaultTransport wraps SessionManager             |
| `packages/web-sdk/src/__tests__/chat-client-transport.test.ts`      | integration | ChatClient with SDKTransport (includes streaming) |
| `packages/web-sdk/src/__tests__/chat-client-status.test.ts`         | unit        | Status events through ChatClient                  |
| `packages/web-sdk/src/__tests__/chat-client-integration.test.ts`    | integration | Status events via embedding app API               |
| `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts` | regression  | Session-switch carryover protection               |
| `packages/web-sdk/src/__tests__/chat-backfill.test.ts`              | unit        | Backfill dedup, sorting, transcript               |
| `packages/web-sdk/src/__tests__/react-components.test.tsx`          | unit        | All shared React components                       |
| `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx`  | regression  | Nested StringsProvider / localization behavior    |
| `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`  | integration | AgentProvider Path A + B                          |
| `packages/web-sdk/src/__tests__/echo-transport.test.ts`             | integration | Custom transport implementation                   |
| `apps/studio/src/__tests__/studio-transport.test.ts`                | integration | StudioTransport adapter                           |
| `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx`   | integration | StudioChatPanel composition                       |

### Build Scripts

| File                                              | Status  | Purpose                                             |
| ------------------------------------------------- | ------- | --------------------------------------------------- |
| `packages/web-sdk/scripts/create-react-entry.mjs` | **NEW** | esbuild post-build script for React sub-path bundle |

---

## 11. Configuration

### Environment Variables

No new environment variables. Transport configuration is programmatic.

### Runtime Configuration

No runtime configuration changes. Studio's WebSocketContext configuration (endpoint, auth) is unchanged.

### DSL / Agent IR / Schema

No DSL/IR changes. The extended `Message` type is a client-side wire format concern.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Transport carries projectId. DefaultTransport inherits from API key scope. StudioTransport inherits from JWT claims. |
| Tenant isolation  | Transport carries tenantId. DefaultTransport inherits from API key scope. StudioTransport inherits from JWT claims.  |
| User isolation    | N/A — no user-owned resources. Session state remains server-side in Redis/MongoDB.                                   |

### Security & Compliance

- **Auth separation**: `DefaultTransport` uses API key auth (`pk_*`). `StudioTransport` uses JWT auth via `authHeaders()`. SDK UI components never touch auth directly — they call `transport.send()` for messages and `ChatClient.uploadAttachment()` for files.
- **No new attack surface**: Transport interface does not expose new endpoints. It wraps existing WebSocket connections.
- **SSR safety**: SDK React components must use `'use client'` directive to prevent Next.js SSR of browser-only code.
- **No PII changes**: Message content is transient (in-memory). No new persistence.

### Performance & Scalability

- **Bundle size**: ~15-25KB for React components (tree-shakeable via `@agent-platform/web-sdk/react` entry point). Web Component bundles unaffected.
- **CSS custom properties**: Zero JS runtime cost for theming.
- **Transport overhead**: StudioTransport adds one layer of event subscription/translation. Negligible compared to WebSocket latency.
- **Bounded collections**: SDK components use existing message array limits from ChatClient.

### Reliability & Failure Modes

- **Transport disconnection**: Components react to `disconnected` event. Reconnection is handled inside each transport implementation (exponential backoff in DefaultTransport, configurable in StudioTransport).
- **Thought event missing**: If a transport does not emit thought events, thought cards never appear. Components handle absence gracefully.
- **Theme missing**: If no SDKThemeProvider, components use default theme. No crash.
- **Backwards compatibility**: If `transport` prop is not provided to AgentProvider, DefaultTransport is created internally. Zero behavior change.

### Observability

- Thought/trace metadata (`traceIds`, `llmCallId`) surfaced in `Message.metadata` for Studio's observatory integration.
- No new trace events or metrics on the server side — this is a client-side feature.
- Browser dev tools remain the primary debugging surface for SDK consumers.

### Data Lifecycle

N/A — all state is ephemeral (in-memory). Message arrays are cleared on disconnect. No persistence, TTLs, or retention.

---

## 13. Delivery Plan / Work Breakdown

1. **Transport abstraction (SDK-only, additive)**
   1.1 Define `SDKTransport` interface in `transport/types.ts`
   1.2 Implement `DefaultTransport` wrapping SessionManager
   1.3 Re-export `SessionManager` as alias from `transport/index.ts`
   1.4 Refactor `ChatClient` constructor to accept `SDKTransport`
   1.5 Update `AgentSDK` to use `DefaultTransport` internally
   1.6 Add thought/handoff/error message processing in `ChatClient`
   1.7 Extend `Message` type with `role: 'thought'` and metadata fields
   1.8 Verify omnichannel methods (`discoverLiveSession`, `joinLiveSession`) on `AgentSDK` continue to work with `DefaultTransport` internally — write regression test
   1.9 Write transport + ChatClient tests

2. **Shared React UI components (SDK-only, additive)**
   2.1 Build MessageList, ChatInput, StreamingMessage
   2.2 Build ThoughtCard with optional `onViewTrace` callback
   2.3 Build HandoffMessage, ErrorMessage
   2.4 Build ActionHandler (rich content actions)
   2.5 Build TypingIndicator
   2.6 Build ChatWidget (composes all above)
   2.7 Build MarkdownContent (replaces RichMessage.tsx) with sanitized markdown rendering
   2.8 Build icons.tsx and sdk-styles.ts
   2.9 Write React component tests

3. **Theme and strings system (SDK-only, additive)**
   3.1 Define theme types and default theme
   3.2 Build SDKThemeProvider with CSS custom properties
   3.3 Define string types and defaults
   3.4 Build StringsProvider
   3.5 Update AgentProvider with optional `transport`, `theme`, `strings` props
   3.6 Update `react/index.ts` and root `index.ts` exports

4. **Studio integration (Studio-side)**
   4.1 Build `useStudioTransport` hook adapter
   4.2 Build `StudioChatHeader` (extracted from current ChatPanel)
   4.3 Build `StudioChatPanel` composing SDK components
   4.4 Write StudioTransport + StudioChatPanel tests

5. **Cutover and cleanup**
   5.1 Update `ChatWithDebugPanel.tsx` to use `StudioChatPanel`
   5.2 Verify debug/export/reset/session-switch functionality
   5.3 Delete old Studio chat files (ChatPanel.tsx, MessageList.tsx, ChatInput.tsx, StreamingMessage.tsx)
   5.4 Run full regression test suite
   5.5 Update SDK package exports and verify backwards compatibility

6. **VoiceClient transport refactor (follow-on)**
   6.1 Refactor `VoiceClient` constructor to accept `SDKTransport`
   6.2 Verify voice continues to work with DefaultTransport and StudioTransport
   6.3 Write VoiceClient transport tests

---

## 14. Success Metrics

| Metric                              | Baseline                               | Target    | How Measured                             |
| ----------------------------------- | -------------------------------------- | --------- | ---------------------------------------- |
| Studio duplicate chat LOC           | ~1,300 lines                           | 0 lines   | wc -l on deleted files                   |
| SDK React component count           | 3 (Provider, RichContent, RichMessage) | 13+       | Count of exports from react/index.ts     |
| Backwards compatibility breaks      | 0                                      | 0         | agent-provider-transport.test.tsx        |
| Studio chat regression count        | 0                                      | 0         | Studio E2E test suite                    |
| SDK bundle size (React entry point) | ~15KB                                  | < 40KB    | Build output size                        |
| External dependencies added         | 0                                      | 0         | package.json diff                        |
| Thought card visibility (SDK)       | Not available                          | Available | ThoughtCard renders for thought messages |

---

## 15. Open Questions

1. Should the `SDKTransport` interface include optional omnichannel methods (`discoverLiveSession`, `joinLiveSession`), or should these remain on `AgentSDK` directly? (See also GAP-003)
2. Should Studio's `useStudioTransport` adapter bridge the `BatchConsentGate` (auth-preflight consent) flow, or should that remain a Studio-only component above the SDK layer?
3. What is the exact CSS custom property namespace for the theme system — `--sdk-*` or `--abl-*` or something else?
4. ~~Should the `MarkdownContent` component (458 lines on the feature branch) be included in the initial scope?~~ **DECIDED**: `MarkdownContent` is included in scope as part of Task 2 (shared React UI components). It replaces the existing `RichMessage.tsx` with a more capable markdown renderer used by both MessageList and StreamingMessage.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                  | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | Voice UI component consolidation deferred — only transport refactored                                                                                        | Medium   | Open      |
| GAP-002 | Web Components not updated to use transport abstraction                                                                                                      | Low      | Open      |
| GAP-003 | `SDKTransport` interface does not include omnichannel methods                                                                                                | Medium   | Open      |
| GAP-004 | StudioTransport thought/trace translation is a load-bearing seam; keep integration coverage in place to prevent regressions                                  | High     | Mitigated |
| GAP-005 | AuthChallengeMessage is Studio-only; SDK consumers have no auth challenge UI                                                                                 | Medium   | Open      |
| GAP-006 | No code exists on develop — everything must be cherry-picked from `origin/KI0326/feature/SDK`                                                                | High     | Closed    |
| PROD-5  | MessageList auto-scroll ignores user scroll position (UX enhancement for BETA)                                                                               | Medium   | Open      |
| PROD-12 | Streaming text path is now covered by component/browser tests; keep it guarded by regression coverage                                                        | Medium   | Mitigated |
| SEC-14  | action_submit `__action__:` delimiter could be confused by `:` in values                                                                                     | Low      | Open      |
| GAP-007 | Browser E2E/perf coverage is present, but backwards-compat browser coverage still leans more on integration tests than a dedicated separate browser scenario | Medium   | Mitigated |
| GAP-008 | Session-switch and nested `StringsProvider` regressions are subtle and should remain protected by dedicated regression suites                                | Low      | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                | Coverage Type      | Status | Test File / Note                                                                                                                        |
| --- | --------------------------------------------------------------------------------------- | ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SDKTransport interface contract validation                                              | unit               | PASS   | `packages/web-sdk/src/__tests__/transport-types.test.ts`                                                                                |
| 2   | DefaultTransport wraps SessionManager correctly                                         | unit               | PASS   | `packages/web-sdk/src/__tests__/default-transport.test.ts`                                                                              |
| 3   | ChatClient with SDKTransport sends/receives messages                                    | unit + integration | PASS   | `packages/web-sdk/src/__tests__/chat-client-transport.test.ts`, `packages/web-sdk/src/__tests__/chat-client-integration.test.ts`        |
| 4   | ChatClient processes thought/handoff/error into Messages                                | unit               | PASS   | `packages/web-sdk/src/__tests__/chat-client-transport.test.ts`                                                                          |
| 5   | AgentProvider Path A / Path B preserves backwards compatibility and transport injection | integration        | PASS   | `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`, `packages/web-sdk/src/__tests__/echo-transport.test.ts`             |
| 6   | MessageList / ThoughtCard / ChatWidget rendering                                        | unit               | PASS   | `packages/web-sdk/src/__tests__/react-components.test.tsx`                                                                              |
| 7   | Theme / strings provider behavior                                                       | integration        | PASS   | `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`, `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx`  |
| 8   | StudioTransport bridges WebSocketContext messages without breaking trace delivery       | integration        | PASS   | `apps/studio/src/__tests__/studio-transport.test.ts`                                                                                    |
| 9   | StudioChatPanel renders with debug/export/reset                                         | integration        | PASS   | `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx`                                                                       |
| 10  | Studio chat/browser workflow, SDK embed flows, errors, auth isolation, and resilience   | E2E                | PASS   | `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts`                                                                                    |
| 11  | Browser performance budgets (bundle, bulk rendering, rapid streaming, theme switching)  | E2E / perf         | PASS   | `apps/studio/e2e/sdk-chat-performance.spec.ts`                                                                                          |
| 12  | Session-switch and nested StringsProvider regressions stay fixed                        | regression         | PASS   | `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts`, `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx` |

### Testing Summary

Merged coverage now includes the transport/unit suites, Studio integration suites, two browser suites (`sdk-chat-consolidation-e2e.spec.ts`, `sdk-chat-performance.spec.ts`), and explicit regression guards for session switching and nested `StringsProvider` behavior.

### Testing Notes

The current branch now contains the authoritative test surface. Historical feature-branch commits are no longer the source of truth for coverage.

> Full testing details: [../../testing/sub-features/sdk-chat-ui-consolidation.md](../../testing/sub-features/sdk-chat-ui-consolidation.md)

---

## 18. References

- Design spec (historical reference): `docs/superpowers/specs/2026-03-17-web-sdk-studio-consolidation-design.md`
- Browser suite: `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts`
- Performance suite: `apps/studio/e2e/sdk-chat-performance.spec.ts`
- Parent feature: [docs/features/sdk.md](../sdk.md)
- Related: [SDK Rich Content Templates](sdk-rich-content-templates.md), [SDK Auth Session Unification](../../specs/sdk-auth-session-unification.hld.md)
