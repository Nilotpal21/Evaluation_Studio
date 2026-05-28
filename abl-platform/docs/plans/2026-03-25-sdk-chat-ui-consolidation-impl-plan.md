# LLD: SDK Chat UI Consolidation

**Feature Spec**: `docs/features/sub-features/sdk-chat-ui-consolidation.md`
**HLD**: `docs/specs/sdk-chat-ui-consolidation.hld.md`
**Test Spec**: `docs/testing/sub-features/sdk-chat-ui-consolidation.md`
**Status**: COMPLETE
**Date**: 2026-04-03

### Phase Status

| Phase | Name                                         | Status   |
| ----- | -------------------------------------------- | -------- |
| 1     | Transport Layer + ChatClient Refactor        | DONE     |
| 2     | Shared React UI Components + Theme + Strings | DONE     |
| 3     | Studio Integration                           | DONE     |
| 4     | Cutover, Validation & Cleanup                | DONE     |
| 5     | VoiceClient Transport Refactor (Follow-on)   | DEFERRED |

### Post-Implementation Notes (2026-04-03)

- The browser suites landed on the current branch as `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` and `apps/studio/e2e/sdk-chat-performance.spec.ts` instead of the earlier placeholder filenames.
- Two regressions found after the original cutover now have dedicated guards: `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts` and `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx`.
- The current branch, not the historical feature branch, is now the source of truth for coverage and file paths.

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                               | Rationale                                                                                                                                                                                                                    | Alternatives Rejected                                                                           |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-1  | 4 implementation phases + 1 follow-on                                  | Theme/strings are consumed by components — separate phase creates false boundary. Each phase stays within 3-package limit.                                                                                                   | 6 phases (1:1 with feature spec — too granular)                                                 |
| D-2  | SDK ChatInput receives `onUploadFile` callback prop                    | Transport-agnostic: two different upload mechanisms (API key vs JWT) cannot be abstracted at the component level.                                                                                                            | Upload on SDKTransport (pollutes interface), hardcoded in ChatInput                             |
| D-3  | CSS custom properties + JS style objects in `sdk-styles.ts`            | SDK is embeddable — cannot require CSS imports/modules/Tailwind. JS style objects with `var()` give zero-config theming.                                                                                                     | CSS modules (requires bundler config), Tailwind (pollutes consumer namespace)                   |
| D-4  | Import SessionManager from `../core/`, do NOT move                     | CLAUDE.md prohibits removing exports. Re-export from `transport/index.ts` is additive.                                                                                                                                       | Move SessionManager to transport/ (breaks existing imports)                                     |
| D-5  | ChatClient receives separate `UploadConfig` alongside SDKTransport     | Keeps SDKTransport as a clean messaging interface. Upload is HTTP, not WebSocket.                                                                                                                                            | Upload methods on SDKTransport (leaks HTTP concerns into messaging interface)                   |
| D-6  | AgentProvider creates ChatClient directly when transport prop provided | AgentSDK requires apiKey/projectId which transport callers may not have. Avoids wasted SessionManager creation.                                                                                                              | Always create AgentSDK (wastes resources, requires unused config)                               |
| D-7  | Keep backwards-compatible re-exports for RichContent/RichMessage       | CLAUDE.md export removal guard. RichMessage becomes deprecated wrapper delegating to MarkdownContent.                                                                                                                        | Delete old paths (breaks existing imports)                                                      |
| D-8  | Clean implementation, reference cherry-pick commits as prior art       | LLD is durable; feature branch is ephemeral. Cherry-picked commits may not conform to commit discipline.                                                                                                                     | Mandate cherry-pick tasks (creates branch coupling)                                             |
| D-9  | Add status_update/status_clear to TransportServerMessage union         | These are needed by ChatClient for existing VoiceClient/AgentProvider consumers. Adding to the union is additive, clean, and avoids transport-specific coupling.                                                             | Secondary rawMessage channel (violates transport-agnostic design), silently drop (breaks voice) |
| D-10 | React ChatWidget name kept despite Web Component collision             | React ChatWidget lives in `@agent-platform/web-sdk/react` sub-path; Web Component ChatWidget in root `@agent-platform/web-sdk`. Different entry points, no runtime conflict. JSDoc on both exports clarifies which is which. | Rename to SDKChatWidget (unnecessary — entry points disambiguate)                               |

### Key Interfaces & Types

```typescript
// packages/web-sdk/src/transport/types.ts — NEW
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

export interface TransportError {
  code: string;
  message: string;
  recoverable: boolean;
}

// packages/web-sdk/src/core/types.ts — MODIFY
export type MessageRole = 'user' | 'assistant' | 'system' | 'thought';

export interface MessageMetadata {
  toolName?: string;
  agentName?: string;
  traceIds?: string[];
  llmCallId?: string;
  handoffFrom?: string;
  handoffTo?: string;
  errorCode?: string;
  severity?: 'warning' | 'error';
  [key: string]: unknown;
}

// Updated Message interface
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

// packages/web-sdk/src/chat/ChatClient.ts — MODIFY constructor
interface ChatUploadConfig {
  getAuthToken: () => Promise<string>;
  getProjectId: () => string;
  getRuntimeSessionId: () => string | null;
  getEndpoint: () => string;
}

// New constructor signature:
// constructor(transport: SDKTransport, uploadConfig?: ChatUploadConfig, debug?: boolean, sessionManager?: SessionManager)
// sessionManager is optional — only needed for omnichannel methods (subscribeLiveTranscript)

// packages/web-sdk/src/react/AgentProvider.tsx — MODIFY props
interface AgentProviderProps extends Partial<SDKConfig> {
  children: React.ReactNode;
  transport?: SDKTransport;
  theme?: SDKTheme;
  strings?: Partial<SDKStrings>;
}
```

### Module Boundaries

| Module                               | Responsibility                                   | Depends On                               |
| ------------------------------------ | ------------------------------------------------ | ---------------------------------------- |
| `transport/types.ts`                 | SDKTransport interface, message type definitions | `core/types.ts` (RichContent, etc.)      |
| `transport/DefaultTransport`         | Wraps SessionManager → SDKTransport              | `core/SessionManager`, `transport/types` |
| `transport/index.ts`                 | Barrel exports, SessionManager alias re-export   | `transport/*`, `core/SessionManager`     |
| `chat/ChatClient`                    | Chat logic, message accumulation, streaming      | `transport/types` (SDKTransport)         |
| `react/components/*`                 | Transport-agnostic UI components                 | `core/types` (Message), React            |
| `react/theme/*`                      | CSS custom property theming                      | React                                    |
| `react/strings/*`                    | i18n string overrides                            | React                                    |
| `react/AgentProvider`                | React context, SDK/transport lifecycle           | `core/AgentSDK`, `transport/types`       |
| Studio `adapters/useStudioTransport` | WebSocketContext → SDKTransport bridge           | WebSocketContext, SDKTransport           |
| Studio `StudioChatPanel`             | Composes SDK components + Studio features        | SDK react components, Studio stores      |

---

## 2. File-Level Change Map

### New Files

| File                                                         | Purpose                                    | LOC Estimate |
| ------------------------------------------------------------ | ------------------------------------------ | ------------ |
| `packages/web-sdk/src/transport/types.ts`                    | SDKTransport interface, message types      | 80           |
| `packages/web-sdk/src/transport/DefaultTransport.ts`         | Wraps SessionManager                       | 180          |
| `packages/web-sdk/src/transport/index.ts`                    | Barrel exports, SessionManager alias       | 15           |
| `packages/web-sdk/src/react/components/MessageList.tsx`      | Role-based message dispatch                | 200          |
| `packages/web-sdk/src/react/components/ChatInput.tsx`        | Text input, file upload, send              | 250          |
| `packages/web-sdk/src/react/components/StreamingMessage.tsx` | Animated streaming display                 | 50           |
| `packages/web-sdk/src/react/components/ThoughtCard.tsx`      | Collapsible thought with onViewTrace       | 100          |
| `packages/web-sdk/src/react/components/HandoffMessage.tsx`   | Agent routing A→B indicator                | 40           |
| `packages/web-sdk/src/react/components/ErrorMessage.tsx`     | Severity-styled error display              | 50           |
| `packages/web-sdk/src/react/components/ActionHandler.tsx`    | Button/select/input actions                | 80           |
| `packages/web-sdk/src/react/components/TypingIndicator.tsx`  | Animated typing dots                       | 30           |
| `packages/web-sdk/src/react/components/ChatWidget.tsx`       | Composes all above into complete chat      | 120          |
| `packages/web-sdk/src/react/components/MarkdownContent.tsx`  | Sanitized markdown renderer                | 100          |
| `packages/web-sdk/src/react/components/icons.tsx`            | Shared SVG icon components                 | 60           |
| `packages/web-sdk/src/react/components/sdk-styles.ts`        | JS style objects with CSS custom prop refs | 120          |
| `packages/web-sdk/src/react/components/index.ts`             | Barrel for components directory            | 20           |
| `packages/web-sdk/src/react/theme/ThemeProvider.tsx`         | SDKThemeProvider, CSS custom properties    | 60           |
| `packages/web-sdk/src/react/theme/default-theme.ts`          | Default color/spacing/radius values        | 30           |
| `packages/web-sdk/src/react/theme/types.ts`                  | SDKTheme type definition                   | 25           |
| `packages/web-sdk/src/react/strings/StringsProvider.tsx`     | i18n strings context + provider            | 50           |
| `packages/web-sdk/src/react/strings/defaults.ts`             | English default string values              | 40           |
| `packages/web-sdk/src/react/strings/types.ts`                | SDKStrings type definition                 | 25           |
| `apps/studio/src/adapters/useStudioTransport.ts`             | Bridges WebSocketContext → SDKTransport    | 200          |
| `apps/studio/src/components/chat/StudioChatPanel.tsx`        | SDK components + Studio-specific header    | 200          |
| `apps/studio/src/components/chat/StudioChatHeader.tsx`       | Agent info, debug toggle, export, reset    | 150          |

### Modified Files

| File                                                     | Change Description                                                     | Risk |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ---- |
| `packages/web-sdk/src/core/types.ts`                     | Add `MessageRole`, `MessageMetadata`. Widen `Message.role`, `metadata` | Med  |
| `packages/web-sdk/src/chat/ChatClient.ts`                | Constructor takes SDKTransport + UploadConfig. New message handlers    | High |
| `packages/web-sdk/src/core/AgentSDK.ts`                  | Use DefaultTransport internally. Pass UploadConfig to ChatClient       | Med  |
| `packages/web-sdk/src/react/AgentProvider.tsx`           | Optional transport prop. Path A (AgentSDK) vs Path B (direct)          | High |
| `packages/web-sdk/src/react/RichContent.tsx`             | Move to components/, leave re-export at old path                       | Low  |
| `packages/web-sdk/src/react/RichMessage.tsx`             | Deprecate, delegate to MarkdownContent                                 | Low  |
| `packages/web-sdk/src/react/index.ts`                    | Export all new components, theme, strings                              | Low  |
| `packages/web-sdk/src/index.ts`                          | Export transport types and DefaultTransport                            | Low  |
| `packages/web-sdk/package.json`                          | No changes needed (sub-path exports already cover ./react)             | Low  |
| `apps/studio/src/components/chat/ChatWithDebugPanel.tsx` | One-line swap: ChatPanel → StudioChatPanel                             | Low  |
| `apps/studio/src/contexts/WebSocketContext.tsx`          | Add chatMessageEmitter + subscribeChatMessage for StudioTransport      | Med  |

### Deleted Files

| File                                                          | Reason                                            |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/chat/ChatPanel.tsx`               | Replaced by StudioChatPanel                       |
| `apps/studio/src/components/chat/MessageList.tsx`             | Replaced by SDK MessageList                       |
| `apps/studio/src/components/chat/ChatInput.tsx`               | Replaced by SDK ChatInput                         |
| `apps/studio/src/components/chat/StreamingMessage.tsx`        | Replaced by SDK StreamingMessage                  |
| `apps/studio/src/__tests__/chat-and-projects.test.tsx`        | Tests old ChatPanel (replaced by Phase 3/4 tests) |
| `apps/studio/src/__tests__/chat-input-media.test.tsx`         | Tests old ChatInput                               |
| `apps/studio/src/__tests__/chat-input-dnd.test.tsx`           | Tests old ChatInput                               |
| `apps/studio/src/__tests__/chat-input-attachments.test.tsx`   | Tests old ChatInput                               |
| `apps/studio/src/__tests__/message-list-hooks-order.test.tsx` | Tests old MessageList                             |
| `apps/studio/src/__tests__/message-list-attachments.test.tsx` | Tests old MessageList                             |
| `apps/studio/src/__tests__/message-list-download.test.tsx`    | Tests old MessageList                             |
| `apps/studio/src/__tests__/message-list-thumbnails.test.tsx`  | Tests old MessageList                             |

> Deletions happen in Phase 4 in a separate commit AFTER cutover is validated.

---

## 3. Implementation Phases

### Phase 1: Transport Layer + ChatClient Refactor

**Goal**: Introduce SDKTransport interface, DefaultTransport wrapper, and refactor ChatClient to accept transport injection — zero behavior change for existing consumers.

**Tasks**:

1.1. Create `packages/web-sdk/src/transport/types.ts` with SDKTransport interface, TransportCapabilities, TransportClientMessage, TransportServerMessage, TransportError types. Import RichContent/ActionSet/MessageMetadata from `../core/types.js`.

1.2. Add `MessageRole` type alias and `MessageMetadata` interface to `packages/web-sdk/src/core/types.ts`. Update `Message.role` from literal union to `MessageRole`. Update `Message.metadata` from `Record<string, unknown>` to `MessageMetadata`. Keep both backwards-compatible via the index signature.

1.3. Create `packages/web-sdk/src/transport/DefaultTransport.ts`:

- Class extends `TypedEventEmitter` with transport events
- Constructor takes `SessionManager`
- `connect()` → `sessionManager.connect()`, listen for `connected` event from SessionManager, translate `session_start` message to `connected` lifecycle event
- `disconnect()` → `sessionManager.disconnect()`
- `isConnected()` → `sessionManager.isConnected()`
- `send(msg)` → translate `TransportClientMessage` to `WSClientMessage`, call `sessionManager.send()`
- `on(event, handler)` → subscribe to internal events, return unsubscribe function
- `getSessionId()` → `sessionManager.getSessionId()`
- `capabilities` → `{ supportsThoughts: true, supportsHandoff: true, supportsFileUpload: true, supportsVoice: true }`
- Internal: subscribe to `sessionManager.on('message', handler)`, translate WSServerMessage to TransportServerMessage per Q12 mapping table. Key translations: `response_end.content` ← `msg.fullText ?? msg.text`; `response_chunk.content` ← `msg.chunk`; `auth_challenge` maps all fields from wire format; `status_update`/`status_clear` included per D-9.

  1.4. Create `packages/web-sdk/src/transport/index.ts`:

- Export all from `./types.js`
- Export `DefaultTransport` from `./DefaultTransport.js`
- Re-export `SessionManager` from `../core/SessionManager.js` (FR-3 backwards compat alias)

  1.5. Refactor `packages/web-sdk/src/chat/ChatClient.ts`:

- Define `ChatUploadConfig` interface (getAuthToken, getProjectId, getRuntimeSessionId, getEndpoint)
- Change constructor from `(sessionManager: SessionManager, debug = false)` to `(transport: SDKTransport, uploadConfig?: ChatUploadConfig, debug?: boolean)`
- Replace all `this.sessionManager.isConnected()` calls with `this.transport.isConnected()`
- Replace all `this.sessionManager.getSessionId()` calls with `this.transport.getSessionId()`
- Replace `this.sessionManager.send(frame)` with `this.transport.send(clientMessage)` where clientMessage is a TransportClientMessage
- Replace `this.sessionManager.on('message', handler)` with `this.transport.on('message', handler)` — update handler to accept TransportServerMessage instead of WSServerMessage
- Update `handleServerMessage()` to switch on `TransportServerMessage.type` instead of WSServerMessage.type — replace the `const msg = message as Record<string, unknown>` cast with proper type narrowing on the discriminated union
- Add new handlers for `thought`, `handoff` message types — create Message objects with appropriate role and metadata
- Keep `uploadAttachment()` using `this.uploadConfig` methods (getAuthToken, getProjectId, getRuntimeSessionId, getEndpoint)
- Handle `status_update`/`status_clear` via the standard `TransportServerMessage` union (D-9) — same pattern as other message types
- Keep all existing public methods: `send`, `submitAction`, `uploadAttachment`, `getMessages`, `clearMessages`, `hydrateBackfill`, `subscribeLiveTranscript`, `sendTypedInterrupt`, `sendAuthResponse`
- **Omnichannel methods** (`subscribeLiveTranscript`, `sendTypedInterrupt`, `hydrateBackfill`): These depend on SessionManager-specific APIs (`onTranscriptItem`). Constructor accepts optional `sessionManager?: SessionManager` as 4th param. When present, omnichannel methods work. When absent (transport-only callers), `subscribeLiveTranscript()` throws `Error('subscribeLiveTranscript requires SessionManager — use AgentSDK or provide sessionManager')` and `sendTypedInterrupt()` delegates to `transport.send({ type: 'typed_interrupt', ... })`. `hydrateBackfill()` works on the local message array — no SessionManager needed.
- **response_chunk → messageChunk mapping**: When handling `response_chunk` from TransportServerMessage, emit `messageChunk` event with `{ messageId, chunk: msg.content }` to preserve the existing ChatEvents contract.
- **response_end content**: Read `msg.content` from TransportServerMessage (DefaultTransport maps `fullText ?? text` to `content`)

  1.6. Update `packages/web-sdk/src/core/AgentSDK.ts`:

- Import DefaultTransport
- In constructor: create `DefaultTransport(this.sessionManager)` and store it
- In `chat()`: pass `new ChatClient(this.defaultTransport, { getAuthToken: () => this.sessionManager.getAuthToken(), getProjectId: () => this.sessionManager.getProjectId(), getRuntimeSessionId: () => this.sessionManager.getRuntimeSessionId(), getEndpoint: () => this.sessionManager.getEndpoint() }, this.config.debug, this.sessionManager)` — passes SessionManager for omnichannel methods
- Keep `getSessionManager()` public method (backwards compat)

  1.7. Update `packages/web-sdk/src/index.ts`:

- Add exports: `SDKTransport`, `DefaultTransport`, `TransportCapabilities`, `TransportClientMessage`, `TransportServerMessage`, `TransportError`, `MessageRole`, `MessageMetadata`
- Re-export SessionManager from transport/index (already exported from core — ensure no double export conflict)

  1.8. Write tests:

- `__tests__/transport-types.test.ts` (UT-1): Verify SDKTransport interface contract — mock implementation satisfies interface, TransportServerMessage union covers all types
- `__tests__/default-transport.test.ts` (INT-1): DefaultTransport delegates to MockSessionManager — connect, disconnect, isConnected, send, getSessionId. Event translation: SessionManager emits WSServerMessage, DefaultTransport emits TransportServerMessage
- `__tests__/chat-client-transport.test.ts` (INT-4, INT-5): ChatClient with MockTransport — send message, receive response_start/chunk/end, verify message accumulation. Thought/handoff/error processing — verify correct Message role and metadata
- `__tests__/agent-provider-transport.test.tsx` (UT-2, UT-3, UT-4): Path A / Path B behavior, backwards compatibility, theme and strings wrapping
- `__tests__/echo-transport.test.ts` (UT-2): Third-party transport contract / export parity

**Files Touched**:

- `packages/web-sdk/src/transport/types.ts` — NEW
- `packages/web-sdk/src/transport/DefaultTransport.ts` — NEW
- `packages/web-sdk/src/transport/index.ts` — NEW
- `packages/web-sdk/src/core/types.ts` — MODIFY (MessageRole, MessageMetadata, Message)
- `packages/web-sdk/src/chat/ChatClient.ts` — MODIFY (constructor, message handling)
- `packages/web-sdk/src/core/AgentSDK.ts` — MODIFY (use DefaultTransport)
- `packages/web-sdk/src/index.ts` — MODIFY (export transport types)
- `packages/web-sdk/src/__tests__/*.test.ts*` — NEW / updated focused transport, provider, and regression suites

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/web-sdk` succeeds with 0 type errors
- [ ] Focused transport/provider suites pass: transport-types, default-transport, chat-client-transport, agent-provider-transport, echo-transport
- [ ] Existing test file `agent-provider-config.test.ts` still passes (regression check)
- [ ] `import { SessionManager } from '@agent-platform/web-sdk'` resolves to the same class
- [ ] `AgentSDK.chat().send('hello')` works identically (manual smoke test or existing test)
- [ ] DefaultTransport translates all 9 TransportServerMessage types correctly (7 original + status_update + status_clear)

**Test Strategy**:

- Unit: SDKTransport interface contract, MessageRole/MessageMetadata types
- Integration: DefaultTransport↔SessionManager delegation, ChatClient↔Transport message flow

**Rollback**: Revert the 3 new files (transport/), restore ChatClient.ts and AgentSDK.ts to pre-refactor state. No data migration needed.

---

### Phase 2: Shared React UI Components + Theme + Strings

**Goal**: Build all 10+ shared React components, theme system, strings provider, and update AgentProvider with optional transport prop.

**Tasks**:

2.1. Create `packages/web-sdk/src/react/components/sdk-styles.ts` — JS style objects referencing CSS custom properties. Define styles for message bubbles, chat container, input area, thought card, error message, etc. All colors reference `var(--sdk-*)`.

2.2. Create `packages/web-sdk/src/react/components/icons.tsx` — SVG icon components: SendIcon, AttachIcon, ExpandIcon, CollapseIcon, ThoughtIcon, ErrorIcon, HandoffIcon, TypingDot.

2.3. Create `packages/web-sdk/src/react/theme/types.ts` — `SDKTheme` interface with `primaryColor`, `backgroundColor`, `textColor`, `borderColor`, `borderRadius`, `fontFamily`, `fontSize`, custom overrides.

2.4. Create `packages/web-sdk/src/react/theme/default-theme.ts` — default values for all SDKTheme properties.

2.5. Create `packages/web-sdk/src/react/theme/ThemeProvider.tsx` — `SDKThemeProvider` component that sets CSS custom properties on a wrapper div. Accepts `theme?: Partial<SDKTheme>`, merges with defaults.

2.6. Create `packages/web-sdk/src/react/strings/types.ts` — `SDKStrings` interface with all localizable keys: `sendButton`, `inputPlaceholder`, `typingIndicator`, `expandThought`, `collapseThought`, `viewTrace`, `errorTitle`, `handoffMessage`, etc.

2.7. Create `packages/web-sdk/src/react/strings/defaults.ts` — English default values for all keys.

2.8. Create `packages/web-sdk/src/react/strings/StringsProvider.tsx` — React context provider. Accepts `strings?: Partial<SDKStrings>`, merges with defaults. Export `useStrings()` hook.

2.9. Create `packages/web-sdk/src/react/components/MarkdownContent.tsx` — sanitized markdown renderer. Strip `<script>`, `onerror`, `javascript:` URLs. Uses `renderMarkdown` from existing `ui/rich-renderer.ts`. Add `'use client'` directive. **Note**: This is separate from Studio's internal `apps/studio/src/components/ui/MarkdownContent.tsx` which remains for other Studio consumers (DebugPanel, etc.). The SDK version is standalone with no Studio dependency.

2.10. Create `packages/web-sdk/src/react/components/StreamingMessage.tsx` — accepts `content: string`, `isStreaming: boolean`. Renders animated text with cursor. Uses sdk-styles and strings provider.

2.11. Create `packages/web-sdk/src/react/components/ThoughtCard.tsx` — props: `content`, `toolLabel`, `isExpanded`, `isThinking`, `onToggle`, `onViewTrace?`, `metadata`. Collapsible card, animated icon when thinking.

2.12. Create `packages/web-sdk/src/react/components/HandoffMessage.tsx` — props: `fromAgent`, `toAgent`. Displays routing indicator.

2.13. Create `packages/web-sdk/src/react/components/ErrorMessage.tsx` — props: `content`, `severity: 'warning' | 'error'`. Styled error/warning display.

2.14. Create `packages/web-sdk/src/react/components/ActionHandler.tsx` — props: `actions: ActionSet`, `onAction: (actionId, value) => void`. Renders buttons/select/input based on action type.

2.15. Create `packages/web-sdk/src/react/components/TypingIndicator.tsx` — animated dots, uses strings for "Agent is typing" text.

2.16. Create `packages/web-sdk/src/react/components/ChatInput.tsx` — props: `onSend: (text, attachmentIds?) => void`, `onUploadFile?: (file: File) => Promise<string>`, `disabled?`, `placeholder?`. Text area, file upload (drag-drop, paste, picker), pending file state. Uses strings for placeholder/button label.

2.17. Create `packages/web-sdk/src/react/components/MessageList.tsx` — props: `messages: Message[]`, `streamingContent?`, `isStreaming?`, `onAction?`, `onViewTrace?`, `renderThoughtCard?`. Role-based dispatch: user → user bubble, assistant → assistant bubble + MarkdownContent + RichContent + ActionHandler, thought → ThoughtCard, system → system message or ErrorMessage (based on metadata.errorCode).

2.18. Move `packages/web-sdk/src/react/RichContent.tsx` to `packages/web-sdk/src/react/components/RichContent.tsx`. Leave a re-export at the old path. Update imports.

2.19. Update `packages/web-sdk/src/react/RichMessage.tsx` — deprecate with `@deprecated` JSDoc, delegate to MarkdownContent internally. Keep export.

2.20. Create `packages/web-sdk/src/react/components/ChatWidget.tsx` — composes MessageList + ChatInput + TypingIndicator + StreamingMessage. Reads from ChatClient via context (useChat hook). Wraps in SDKThemeProvider + StringsProvider.

2.21. Create `packages/web-sdk/src/react/components/index.ts` — barrel export for all components.

2.22. Update `packages/web-sdk/src/react/AgentProvider.tsx`:

- Change props from `extends SDKConfig` to `extends Partial<SDKConfig>` with optional `transport?: SDKTransport`, `theme?: SDKTheme`, `strings?: Partial<SDKStrings>`
- Path A (no transport): existing AgentSDK flow, unchanged. Requires `projectId` + `apiKey`.
- Path B (transport provided): create ChatClient directly with transport. No AgentSDK. No SessionManager.
  - `useChat()` returns full ChatClient-backed state (messages, send, streaming, etc.)
  - `useAgent()` returns `{ sdk: null, isConnected, sessionId }` (transport-derived, no AgentSDK)
  - `useVoice()` returns safe defaults matching existing return shape: `{ voiceState: 'idle', startVoice: () => { throw new Error('Voice requires AgentSDK — provide apiKey/projectId instead of transport') }, stopVoice: noop, toggleMute: () => false, isMuted: false, isConnected: transport.isConnected(), thought: null, statusMessage: null }` — throws descriptive error on startVoice, but all other fields are safe defaults
  - `thought` and `statusMessage` state derive from ChatClient events, not AgentSDK
- Wrap children in SDKThemeProvider + StringsProvider if theme/strings props provided.

  2.23. Update `packages/web-sdk/src/react/index.ts` — export all new components: MessageList, ChatInput, StreamingMessage, ThoughtCard, HandoffMessage, ErrorMessage, ActionHandler, TypingIndicator, ChatWidget, MarkdownContent, SDKThemeProvider, StringsProvider, useStrings. Keep existing exports.

  2.24. Write tests:

- `__tests__/react-components.test.tsx` (UT-5 through UT-12): Render each component with minimal props, verify output. ThoughtCard expand/collapse. ErrorMessage severity variants. ActionHandler button click. MessageList role-based dispatch.
- `__tests__/agent-provider-transport.test.tsx` + `__tests__/strings-provider-nesting.test.tsx` (INT-8, INT-9): SDKThemeProvider / StringsProvider wrapping behavior, localization overrides, and nested-provider regression coverage.
- `__tests__/agent-provider-transport.test.tsx` (INT-6, INT-7): AgentProvider with transport prop creates ChatClient directly. AgentProvider without transport creates AgentSDK (backwards compat). useChat/useAgent/useVoice hooks return expected values in both paths.

**Files Touched**:

- `packages/web-sdk/src/react/components/*.tsx` — NEW (13 component files)
- `packages/web-sdk/src/react/components/sdk-styles.ts` — NEW
- `packages/web-sdk/src/react/components/icons.tsx` — NEW
- `packages/web-sdk/src/react/components/index.ts` — NEW
- `packages/web-sdk/src/react/theme/*.ts(x)` — NEW (3 files)
- `packages/web-sdk/src/react/strings/*.ts(x)` — NEW (3 files)
- `packages/web-sdk/src/react/RichContent.tsx` — MODIFY (re-export)
- `packages/web-sdk/src/react/RichMessage.tsx` — MODIFY (deprecate)
- `packages/web-sdk/src/react/AgentProvider.tsx` — MODIFY (transport prop)
- `packages/web-sdk/src/react/index.ts` — MODIFY (exports)
- `packages/web-sdk/src/__tests__/*.test.tsx` — NEW (3 test files)

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/web-sdk` succeeds with 0 type errors
- [ ] All 3 new test files pass: react-components, theme-strings, agent-provider-transport
- [ ] Existing test `agent-provider-config.test.ts` still passes
- [ ] `import { MessageList, ChatInput, ChatWidget, SDKThemeProvider, StringsProvider } from '@agent-platform/web-sdk/react'` resolves correctly
- [ ] `import { RichContent } from '@agent-platform/web-sdk/react'` still works (backwards compat re-export)
- [ ] `import { RichMessage } from '@agent-platform/web-sdk/react'` still works (deprecated wrapper)
- [ ] ChatWidget renders with default theme when no SDKThemeProvider is present
- [ ] ChatWidget renders with custom theme when SDKThemeProvider wraps it

**Test Strategy**:

- Unit: Each React component renders with correct props, handles events
- Integration: AgentProvider lifecycle with/without transport prop, theme/strings propagation

**Rollback**: Delete all new files in `react/components/`, `react/theme/`, `react/strings/`. Restore AgentProvider.tsx, index.ts, RichContent.tsx, RichMessage.tsx to pre-phase state.

---

### Phase 3: Studio Integration

**Goal**: Build StudioTransport adapter and StudioChatPanel that composes SDK components with Studio-specific features.

**Tasks**:

3.0. **Prerequisite**: Add message event emitter to `apps/studio/src/contexts/WebSocketContext.tsx`:

- WebSocketContext currently handles messages internally in `handleMessage` callback (lines 122-520) with no external subscription mechanism
- Add a `chatMessageEmitter` (TypedEventEmitter) that fires for chat-relevant message types: `response_start`, `response_chunk`, `response_end`, `trace_event` (tool_thought subset), `error`, `auth_challenge`, `status_update`, `status_clear`
- Emit on the emitter from within the existing `handleMessage` switch cases — additive, does not change existing store writes
- Expose `subscribeChatMessage(handler: (msg: WSServerMessage) => void): () => void` from `useWebSocketContext()`
- This is the critical bridge that StudioTransport subscribes to — without it, Phase 3 cannot work

  3.1. Create `apps/studio/src/adapters/useStudioTransport.ts`:

- React hook that creates and returns an SDKTransport instance
- Reads from `useWebSocketContext()` for: `sendMessage`, `send`, `isConnected`, `resetSession`, `subscribeChatMessage` (added in 3.0)
- Reads from `useSessionStore()` for: `sessionId` only (NOT messages — backfill is StudioChatPanel's responsibility via `ChatClient.hydrateBackfill()` or direct prop pass to MessageList)
- Subscribes to WebSocketContext chat message events via `subscribeChatMessage()` for chat-relevant types:
  - `response_start` → TransportServerMessage `response_start`
  - `response_chunk` → TransportServerMessage `response_chunk`
  - `response_end` → TransportServerMessage `response_end`
  - `trace_event` with `tool_thought` subtype → TransportServerMessage `thought`
  - `error` → TransportServerMessage `error`
  - `auth_challenge` → TransportServerMessage `auth_challenge`
- Filters OUT Studio-only types: `state_update`, `action_taken`, `dsl_collect`, `context_injected`, `session_reset`, `session_resumed`, etc. — these continue to flow through WebSocketContext to Zustand stores unchanged.
- `send()` implementation: calls `wsContext.sendMessage(text)` for chat messages, `wsContext.send()` for other types
- `connect()` → resolves immediately (already connected via WebSocketContext)
- `disconnect()` → no-op (WebSocketContext manages connection lifecycle)
- `getSessionId()` → reads from `useSessionStore`
- `capabilities` → `{ supportsThoughts: true, supportsHandoff: true, supportsFileUpload: true, supportsVoice: false }` (voice not through this transport)
- Handle session switch: when `sessionId` changes, emit `disconnected` + `connected` events so ChatClient resets message array (per HLD OQ-3)

  3.2. Create `apps/studio/src/components/chat/StudioChatHeader.tsx`:

- Extract header rendering from current `ChatPanel.tsx` (lines 152-218)
- Props: `agent`, `onToggleDebug`, `debugPanelOpen`, `onExport`, `onReset`, `hasTestContext`
- Renders: agent name, type badge, mode, tool count, debug toggle button, export button, reset button, test context indicator

  3.3. Create `apps/studio/src/components/chat/StudioChatPanel.tsx`:

- Props: `onToggleDebug?: () => void`, `debugPanelOpen?: boolean`
- Internal: call `useStudioTransport()` to get transport
- Wrap SDK components in `<AgentProvider transport={studioTransport}>`
- **i18n bridge**: Create a `useStudioChatStrings()` helper that calls `useTranslations('chat.panel')`, `useTranslations('chat.input')`, `useTranslations('chat.messages')` from next-intl and maps the 30+ Studio translation keys to `SDKStrings` shape. Pass result as `strings` prop to `<AgentProvider>`. This ensures Studio users see localized chat strings, not SDK English defaults. The mapping is: `t('chat.input.placeholder')` → `SDKStrings.inputPlaceholder`, `t('chat.input.send')` → `SDKStrings.sendButton`, `t('chat.messages.typing')` → `SDKStrings.typingIndicator`, etc.
- Import `parseAuthChallengeData` from `AuthChallengeMessage.tsx` to detect and render auth challenge state (current MessageList uses this at line 31)
- Render: StudioChatHeader + BatchConsentGate + SessionHealthBanner + AuthChallengeMessage (when challenge active, using parseAuthChallengeData) + SDK ChatWidget
- Wire `onViewTrace` callback: `(traceId) => { setDebugPanelOpen(true); setDebugPanelTab('traces'); /* select trace */ }`
- Wire `onUploadFile`: use Studio's `apiFetch` upload path with `useNavigationStore.projectId` and `useSessionStore.sessionId`
- Wire `onExport`: serialize messages to JSON blob download (same logic as current ChatPanel lines 68-85)
- Wire `onReset`: call `wsContext.resetSession()`

  3.4. Write tests:

- `apps/studio/src/__tests__/studio-transport.test.ts` (INT-2, INT-3): StudioTransport delegates send to WebSocketContext. Translates incoming messages. Filters Studio-only types. Thought event dual delivery — observatory-store AND transport both receive.
- `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx` (INT-10): StudioChatPanel renders SDK components within Studio wrapper. Debug toggle works. Export and reset wire correctly.
- `packages/web-sdk/src/__tests__/echo-transport.test.ts` (INT-11): Create EchoTransport implementing SDKTransport — validates the interface is implementable by third-party consumers.

**Files Touched**:

- `apps/studio/src/contexts/WebSocketContext.tsx` — MODIFY (add chatMessageEmitter + subscribeChatMessage)
- `apps/studio/src/adapters/useStudioTransport.ts` — NEW
- `apps/studio/src/components/chat/StudioChatPanel.tsx` — NEW
- `apps/studio/src/components/chat/StudioChatHeader.tsx` — NEW
- `apps/studio/src/__tests__/studio-transport.test.ts` — NEW
- `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx` — NEW
- `packages/web-sdk/src/__tests__/echo-transport.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@agent-platform/studio` succeeds with 0 type errors
- [ ] All 3 focused integration files pass: studio-transport, components/studio-chat-panel, echo-transport
- [ ] StudioTransport correctly filters out `state_update`, `dsl_collect` messages (not forwarded to ChatClient)
- [ ] Thought events arrive at BOTH observatory-store AND ChatClient (dual delivery)
- [ ] StudioChatPanel renders SDK MessageList with Studio's message history

**Test Strategy**:

- Integration: StudioTransport↔WebSocketContext message flow, StudioChatPanel composition rendering

**Rollback**: Delete the 3 new Studio files and 3 test files. Revert WebSocketContext.tsx chatMessageEmitter changes (task 3.0).

---

### Phase 4: Cutover, Validation & Cleanup

**Goal**: Swap Studio to use StudioChatPanel, validate everything works, delete old duplicate files.

**Tasks**:

4.1. Update `apps/studio/src/components/chat/ChatWithDebugPanel.tsx`:

- Change import from `ChatPanel` to `StudioChatPanel`
- Change JSX from `<ChatPanel onToggleDebug={...} debugPanelOpen={...} />` to `<StudioChatPanel onToggleDebug={...} debugPanelOpen={...} />`
- This is a one-line import change + one-line JSX change

  4.2. Verify full regression:

- `pnpm build` (full monorepo build)
- `pnpm test --filter=@agent-platform/web-sdk` (all SDK tests)
- `pnpm test --filter=@agent-platform/studio` (all Studio tests)

  4.3. Delete old Studio chat files in a SEPARATE commit:

- `apps/studio/src/components/chat/ChatPanel.tsx` (265 lines)
- `apps/studio/src/components/chat/MessageList.tsx` (537 lines)
- `apps/studio/src/components/chat/ChatInput.tsx` (466 lines)
- `apps/studio/src/components/chat/StreamingMessage.tsx` (44 lines)
- Total: ~1,312 lines deleted

  4.4. Update or delete all consumers of the deleted files. Exhaustive list of known consumers:

- `apps/studio/src/components/chat/ChatWithDebugPanel.tsx` — already updated in 4.1 (ChatPanel → StudioChatPanel)
- `apps/studio/src/__tests__/chat-and-projects.test.tsx` — DELETE (tests old ChatPanel)
- `apps/studio/src/__tests__/chat-input-media.test.tsx` — DELETE (tests old ChatInput)
- `apps/studio/src/__tests__/chat-input-dnd.test.tsx` — DELETE (tests old ChatInput)
- `apps/studio/src/__tests__/chat-input-attachments.test.tsx` — DELETE (tests old ChatInput)
- `apps/studio/src/__tests__/message-list-hooks-order.test.tsx` — DELETE (tests old MessageList)
- `apps/studio/src/__tests__/message-list-attachments.test.tsx` — DELETE (tests old MessageList)
- `apps/studio/src/__tests__/message-list-download.test.tsx` — DELETE (tests old MessageList)
- `apps/studio/src/__tests__/message-list-thumbnails.test.tsx` — DELETE (tests old MessageList)
- Run `grep -r "from.*ChatPanel\|from.*MessageList\|from.*ChatInput\|from.*StreamingMessage" apps/studio/src/` to catch any additional references.
- These 8 test files are replaced by the new tests in Phase 3 (studio-transport, studio-chat-panel) and Phase 4 E2E tests.

  4.5. Create E2E test files:

- `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` — main Studio + SDK browser matrix
- `apps/studio/e2e/sdk-chat-performance.spec.ts` — PERF-1 through PERF-4 browser/perf checks

  4.6. E2E test scenarios (from test spec):

- E2E-1: Studio chat send and streaming response
- E2E-2: Studio debug workflow — export and reset
- E2E-3: Studio session switching
- E2E-4: SDK embed — basic chat with thought cards and actions
- E2E-5: SDK backwards compatibility — useChat without transport prop
- E2E-6: SDK embed with theme and strings customization
- E2E-7: Rich content rendering through consolidated components
- E2E-8: Error surfacing — agent error renders ErrorMessage
- E2E-9: SDK auth isolation — invalid key and cross-project rejection
- E2E-10: Connection resilience — disconnect and reconnect during streaming

  4.7. Security tests:

- SEC-1: XSS prevention in MarkdownContent
- SEC-2: Transport auth separation (API key vs JWT never mixed)
- SEC-3: SSR safety (`'use client'` directives present)
- SEC-4: Auth isolation (cross-project key rejected)
- SEC-5: File upload validation (size, type)

  4.8. Performance tests:

- PERF-1: Bundle size < 40KB gzipped for react entry
- PERF-2: MessageList renders 200+ messages without jank
- PERF-3: Rapid streaming (100 chunks) renders smoothly
- PERF-4: Theme switching has zero layout thrash

**Files Touched**:

- `apps/studio/src/components/chat/ChatWithDebugPanel.tsx` — MODIFY (2 lines)
- `apps/studio/src/components/chat/ChatPanel.tsx` — DELETE
- `apps/studio/src/components/chat/MessageList.tsx` — DELETE
- `apps/studio/src/components/chat/ChatInput.tsx` — DELETE
- `apps/studio/src/components/chat/StreamingMessage.tsx` — DELETE
- `apps/studio/src/__tests__/chat-and-projects.test.tsx` — DELETE
- `apps/studio/src/__tests__/chat-input-media.test.tsx` — DELETE
- `apps/studio/src/__tests__/chat-input-dnd.test.tsx` — DELETE
- `apps/studio/src/__tests__/chat-input-attachments.test.tsx` — DELETE
- `apps/studio/src/__tests__/message-list-hooks-order.test.tsx` — DELETE
- `apps/studio/src/__tests__/message-list-attachments.test.tsx` — DELETE
- `apps/studio/src/__tests__/message-list-download.test.tsx` — DELETE
- `apps/studio/src/__tests__/message-list-thumbnails.test.tsx` — DELETE
- `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` — NEW
- `apps/studio/e2e/sdk-chat-performance.spec.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build` succeeds (full monorepo)
- [ ] `pnpm test` passes (all packages)
- [ ] All 10 E2E scenarios pass
- [ ] All 5 security tests pass
- [ ] Bundle size < 40KB gzipped for `@agent-platform/web-sdk/react`
- [ ] No imports reference deleted Studio chat files
- [ ] Studio chat works identically to pre-cutover (manual verification)

**Test Strategy**:

- E2E: Playwright against real Studio + Runtime, no mocks
- Security: XSS probes, auth boundary testing
- Performance: Bundle analysis, rendering benchmarks

**Rollback**: Revert the ChatWithDebugPanel.tsx swap commit. Old files are deleted in a separate commit — if rollback needed before deletion, just revert the swap. If rollback needed after deletion, revert both commits.

---

### Phase 5: VoiceClient Transport Refactor (Follow-on)

**Goal**: Refactor VoiceClient to accept SDKTransport, completing the transport abstraction.

> This is a separate PR. Not part of the initial implementation.

**Tasks**:

5.1. Refactor `packages/web-sdk/src/voice/VoiceClient.ts` constructor to accept `SDKTransport`
5.2. Update AgentSDK to pass DefaultTransport to VoiceClient
5.3. Write VoiceClient transport tests
5.4. Verify voice works with DefaultTransport and StudioTransport

**Exit Criteria**:

- [ ] VoiceClient accepts SDKTransport
- [ ] Existing voice tests pass
- [ ] Voice works in Studio via StudioTransport

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers. This prevents the #1 agent failure mode: writing code that nothing calls.

- [ ] `transport/types.ts` exported from `transport/index.ts`
- [ ] `transport/DefaultTransport` exported from `transport/index.ts`
- [ ] `transport/index.ts` exported from `packages/web-sdk/src/index.ts`
- [ ] `SessionManager` re-exported from `transport/index.ts` (FR-3 alias)
- [ ] `MessageRole` and `MessageMetadata` exported from `core/types.ts` and root `index.ts`
- [ ] `AgentSDK` uses `DefaultTransport` internally (not raw SessionManager for ChatClient)
- [ ] `ChatClient` constructor updated in `AgentSDK.chat()` call site
- [ ] All 12 new React components exported from `react/components/index.ts`
- [ ] `react/components/index.ts` re-exported from `react/index.ts`
- [ ] `SDKThemeProvider` exported from `react/index.ts`
- [ ] `StringsProvider` and `useStrings` exported from `react/index.ts`
- [ ] `AgentProvider` accepts `transport` prop (interface updated)
- [ ] `ChatWidget` renders within `AgentProvider` context
- [ ] `RichContent` re-exported from old path (`react/RichContent.tsx` → `react/components/RichContent.tsx`)
- [ ] `RichMessage` deprecated wrapper delegates to `MarkdownContent`
- [ ] `useStudioTransport` imported and called in `StudioChatPanel`
- [ ] `StudioChatPanel` imported in `ChatWithDebugPanel.tsx` (Phase 4 swap)
- [ ] `StudioChatHeader` imported in `StudioChatPanel`
- [ ] `AuthChallengeMessage` imported in `StudioChatPanel` (RETAIN, not moved)
- [ ] `SessionHealthBanner` imported in `StudioChatPanel` (RETAIN, not moved)

---

## 5. Cross-Phase Concerns

### Database Migrations

None. This is a purely client-side feature. No server-side persistence changes.

### Feature Flags

None. The 4-phase delivery provides natural feature gating: Phases 1-2 are SDK-only additive changes (no Studio impact). Phase 3 creates the Studio adapter but doesn't activate it. Phase 4 is the cutover.

### Configuration Changes

No new environment variables or config files. Theme and strings are runtime props, not configuration.

### Import Convention

All imports within `packages/web-sdk/` must use `.js` extensions per ESM convention established in the codebase (e.g., `from '../core/types.js'`, `from './DefaultTransport.js'`). Studio (`apps/studio/`) does NOT use `.js` extensions (Next.js handles module resolution).

### Prior Art Reference

Implementation reference exists at commits `06a0c16e5` and `6180e0229` on `origin/KI0326/feature/SDK`. Implementers should consult these for design decisions and existing component implementations but should produce clean commits conforming to current develop.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] 10 E2E tests from test spec passing (Playwright against real Studio + Runtime)
- [ ] 11 integration tests from test spec passing
- [ ] 12 unit tests from test spec passing
- [ ] 5 security tests passing
- [ ] 4 performance tests passing (bundle < 40KB, 200+ messages, rapid streaming, theme switch)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] ~1,312 lines of duplicate Studio chat code deleted
- [ ] SDK React component count increased from 3 to 13+
- [ ] External dependencies added: 0
- [ ] `SessionManager` import from `@agent-platform/web-sdk` still works
- [ ] `<AgentProvider projectId="..." apiKey="...">` + `useChat()` works identically (no transport prop needed)
- [ ] Feature spec updated with implementation details via `/post-impl-sync`
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. **StudioTransport thought event subscription mechanism**: WebSocketContext handles `trace_event` messages internally (lines 172-326). StudioTransport needs to subscribe to a subset of these. Should StudioTransport register as a second listener on the raw WebSocket, or should it subscribe to WebSocketContext's dispatch layer? Recommendation: subscribe to a new lightweight event emitter on WebSocketContext that fires for chat-relevant messages, avoiding duplication of the 155-line message handler.

2. **ChatInput file upload in Studio context**: Studio's ChatInput uploads to `/api/projects/:projectId/sessions/:sessionId/attachments` which returns attachment IDs. The SDK ChatInput receives `onUploadFile` callback. Does StudioChatPanel need to replicate the full drag-drop/paste/pending-file UX from Studio's ChatInput (466 lines), or can we use the SDK ChatInput's built-in upload UX with Studio's upload endpoint wired in? Recommendation: use SDK ChatInput's UX, wire Studio endpoint via callback.

3. **BatchConsentGate integration**: Studio's current ChatPanel wraps messages/input in `<BatchConsentGate>`. StudioChatPanel needs to do the same. BatchConsentGate depends on `batch-consent-store`. Should this wrap the entire SDK ChatWidget, or only the input area? Recommendation: wrap the entire chat area in StudioChatPanel (outside the SDK components).
