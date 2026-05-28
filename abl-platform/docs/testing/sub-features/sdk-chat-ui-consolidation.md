# Test Specification: SDK Chat UI Consolidation

**Feature Spec**: [`docs/features/sub-features/sdk-chat-ui-consolidation.md`](../../features/sub-features/sdk-chat-ui-consolidation.md)
**HLD**: [`docs/specs/sdk-chat-ui-consolidation.hld.md`](../../specs/sdk-chat-ui-consolidation.hld.md)
**LLD**: [`docs/plans/2026-03-25-sdk-chat-ui-consolidation-impl-plan.md`](../../plans/2026-03-25-sdk-chat-ui-consolidation-impl-plan.md)
**Status**: ACTIVE
**Last Updated**: 2026-04-03

---

## 1. Coverage Matrix

| FR    | Requirement                              | Unit | Integration | E2E / Browser | Manual | Status                                                                                       |
| ----- | ---------------------------------------- | ---- | ----------- | ------------- | ------ | -------------------------------------------------------------------------------------------- |
| FR-1  | SDKTransport interface                   | ✅   | -           | -             | -      | `transport-types.test.ts`                                                                    |
| FR-2  | DefaultTransport wraps SessionManager    | ✅   | ✅          | ✅            | -      | `default-transport.test.ts` + browser auth/resilience flows                                  |
| FR-3  | SessionManager backwards-compat alias    | ✅   | ✅          | Partial       | -      | Covered through Path A `AgentProvider` / `DefaultTransport` tests                            |
| FR-4  | ChatClient with SDKTransport             | ✅   | ✅          | ✅            | -      | `chat-client-transport.test.ts`, `chat-client-integration.test.ts`, browser suites           |
| FR-5  | Extended Message type (thought role)     | ✅   | -           | ✅            | -      | Typed/unit coverage plus browser thought-card flows                                          |
| FR-6  | Thought/handoff/error message processing | ✅   | ✅          | ✅            | -      | ChatClient + Studio/browser coverage                                                         |
| FR-7  | 10+ shared React components              | ✅   | ✅          | ✅            | -      | Component suites + browser suites                                                            |
| FR-8  | AgentProvider transport prop             | ✅   | ✅          | ✅            | -      | Path A / Path B tests plus embed/browser coverage                                            |
| FR-9  | SDKThemeProvider                         | ✅   | ✅          | ✅            | -      | Provider tests + browser perf / theme checks                                                 |
| FR-10 | StringsProvider                          | ✅   | ✅          | ✅            | -      | Provider tests + nesting regression + browser checks                                         |
| FR-11 | StudioTransport adapter                  | -    | ✅          | ✅            | -      | `studio-transport.test.ts` + Studio/browser workflows                                        |
| FR-12 | StudioChatPanel                          | -    | ✅          | ✅            | -      | `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx` + Studio/browser workflows |
| FR-13 | ThoughtCard onViewTrace callback         | ✅   | ✅          | ✅            | -      | Unit, transport, and Studio/browser trace checks                                             |
| FR-14 | Delete old Studio chat files             | -    | -           | ✅            | N      | Verified through cutover + no-import regressions                                             |
| FR-15 | Existing hooks unchanged                 | ✅   | ✅          | Partial       | -      | Path A tests and browser use-without-transport coverage folded into current suites           |

Legend: ✅ = Tested, ❌ = Not yet written, P = Planned, N = Needs manual verification, - = Not applicable

---

## 1.1 Current State (2026-04-03)

The current branch now contains the browser and performance suites that were still missing in the original 2026-03-26 sync. The most important follow-up regressions from the last week are also covered explicitly:

- `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts` guards against message carryover across Studio session switches.
- `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx` guards nested-provider localization behavior after the `AgentProvider` / `ChatWidget` double-wrap fix.
- `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts` covers the main Studio and SDK browser flows.
- `apps/studio/e2e/sdk-chat-performance.spec.ts` covers bundle-size, bulk-render, rapid-streaming, and theme-switch budgets.

The remaining test gap is not "no E2E" anymore; it is mostly about whether a separate dedicated backwards-compat browser lane is still worth keeping distinct from the existing Path A integration coverage.

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system. No mocks, no direct DB access. Browser automation via Playwright against running services.

### E2E-1: Studio chat send and streaming response

- **Preconditions**: Studio running via PM2 (port 5173), Runtime running (port 3112), at least one project with a deployed agent that emits thought events, user logged in with valid JWT
- **Steps**:
  1. Navigate to Studio agent page
  2. Open the chat panel (StudioChatPanel renders via SDK components)
  3. Type "Hello, what can you do?" in the ChatInput component
  4. Click send button
  5. Observe streaming response in MessageList (StreamingMessage renders chunks)
  6. Wait for response to complete
  7. Verify thought cards appear (ThoughtCard component with tool name, expand/collapse)
  8. Click "View trace" on a ThoughtCard
  9. Verify navigation to observatory debug panel with matching trace
- **Expected Result**: Message appears in chat, streaming response renders progressively, thought cards show with tool names, "View trace" navigates to correct observatory entry
- **Auth Context**: Studio JWT (tenant + project scoped), agent has thought-emitting tools
- **Covers**: FR-7, FR-11, FR-12, FR-13

### E2E-2: Studio debug workflow — export and reset

- **Preconditions**: Same as E2E-1, at least one message in chat history
- **Steps**:
  1. Send a message to generate a response with thoughts
  2. Click the debug toggle button in StudioChatHeader
  3. Verify the debug panel opens alongside the chat
  4. Verify trace events populate in the debug panel for the latest message
  5. Click "Export transcript" button
  6. Verify a file downloads containing the message history (JSON or text)
  7. Click "Reset session" button
  8. Verify chat history clears and a new session is created
  9. Send a new message, verify it appears in a fresh conversation
- **Expected Result**: Debug panel shows traces, export downloads transcript, reset clears history and starts fresh session
- **Auth Context**: Studio JWT, same project
- **Covers**: FR-12

### E2E-3: Studio session switching

- **Preconditions**: Studio running, at least two existing sessions for the same agent
- **Steps**:
  1. Verify current session's messages are displayed in StudioChatPanel
  2. Click a different session in the SessionSidebar
  3. Verify MessageList updates to show the selected session's message history
  4. Verify message content includes correct roles (user, assistant, thought)
  5. Send a new message in the switched session
  6. Verify the response appears in the correct session context
  7. Switch back to the original session
  8. Verify the original session's messages are intact
- **Expected Result**: Session switching loads correct history, new messages go to active session, switching back preserves prior history
- **Auth Context**: Studio JWT, same project, same user
- **Covers**: FR-11, FR-12

### E2E-4: SDK embed — basic chat with thought cards and actions

- **Preconditions**: Runtime running (port 3112), project with valid API key (`pk_*`), agent that emits thoughts and provides quick-reply actions, test HTML page at `packages/web-sdk/examples/react-app/` loading `<AgentProvider projectId="..." apiKey="..."><ChatWidget />`
- **Steps**:
  1. Open the test page in Playwright
  2. Verify ChatWidget renders with ChatInput visible
  3. Type "Show me some options" in the ChatInput
  4. Click send
  5. Observe streaming response in MessageList (chunks render progressively)
  6. Wait for response to complete
  7. If agent emits thoughts: verify ThoughtCard renders with tool name and is collapsible
  8. If agent returns quick-reply actions: verify ActionHandler renders buttons
  9. Click a quick-reply button
  10. Verify the action triggers a new message send and response
- **Expected Result**: Chat sends/receives messages, streaming renders, thought cards appear, action buttons work
- **Auth Context**: API key auth (`pk_*`), project-scoped
- **Covers**: FR-2, FR-6, FR-7, FR-8

### E2E-5: SDK backwards compatibility — useChat without transport prop

- **Preconditions**: Same as E2E-4
- **Steps**:
  1. Open test page that uses `<AgentProvider projectId="..." apiKey="...">` with `useChat()` hook (no `transport` prop)
  2. Verify AgentProvider creates DefaultTransport internally
  3. Call `useChat().send('Hello')` via a button or text input
  4. Verify message appears in the MessageList
  5. Verify streaming response renders correctly
  6. Call `useChat().getMessages()` and verify returned array includes sent and received messages
  7. Verify `useChat().clearMessages()` empties the message list
  8. Verify `useAgent()` hook returns the AgentSDK instance
- **Expected Result**: All existing hooks work identically to pre-consolidation behavior, no transport prop needed
- **Auth Context**: API key auth, project-scoped
- **Covers**: FR-2, FR-3, FR-15

### E2E-6: SDK embed with theme and strings customization

- **Preconditions**: Runtime running (port 3112), project with valid API key, test page renders `<AgentProvider projectId="..." apiKey="..."><SDKThemeProvider theme={{ primaryColor: '#FF0000' }}><StringsProvider strings={{ sendButton: 'Enviar', placeholder: 'Escribe...' }}><ChatWidget /></StringsProvider></SDKThemeProvider></AgentProvider>`
- **Steps**:
  1. Open the test page in Playwright
  2. Inspect the ChatWidget container element — verify `--sdk-primary-color` CSS custom property is set to `#FF0000`
  3. Verify the send button text reads "Enviar" (not default "Send")
  4. Verify the input placeholder reads "Escribe..." (not default)
  5. Type a message and send — verify the themed chat UI renders the response correctly
  6. Verify message bubbles use the custom primary color
- **Expected Result**: Theme CSS properties and string overrides are applied in the browser, chat still functions
- **Auth Context**: API key auth (`pk_*`), project-scoped
- **Covers**: FR-9, FR-10

### E2E-7: Rich content rendering through consolidated components

- **Preconditions**: Runtime running, agent configured to return rich content (carousel, table, quick-replies)
- **Steps**:
  1. Open SDK test page or Studio chat
  2. Send a message that triggers rich content response (e.g., "Show me a data table")
  3. Verify RichContent component dispatches to correct template renderer
  4. Verify carousel slides are navigable (if carousel)
  5. Verify table rows/columns render correctly (if table)
  6. Verify quick-reply buttons are clickable and trigger sends (if quick-replies)
- **Expected Result**: Rich content templates render correctly through the shared MessageList/RichContent pipeline
- **Auth Context**: API key auth (`pk_*`), project-scoped — run against SDK embed test page
- **Covers**: FR-7 (RichContent integration with MessageList)

### E2E-8: Error surfacing — agent error renders ErrorMessage

- **Preconditions**: Runtime running (port 3112), project with valid API key, agent configured with a tool that can fail (e.g., HTTP tool pointing to unreachable endpoint)
- **Steps**:
  1. Open SDK embed test page
  2. Send a message designed to trigger an agent error
  3. Verify ErrorMessage component renders with error severity and message
  4. Verify the error is non-blocking (user can send another message)
  5. Send a follow-up message and verify normal response cycle resumes
- **Expected Result**: Errors surface visually via ErrorMessage, do not crash the chat, and recovery works
- **Auth Context**: API key auth (`pk_*`), project-scoped — run against SDK embed test page
- **Covers**: FR-6, FR-7

### E2E-9: SDK auth isolation — invalid key and cross-project rejection

- **Preconditions**: Runtime running, two projects (Project A with valid `pk_A`, Project B with valid `pk_B`)
- **Steps**:
  1. Open SDK test page configured with `projectId=A, apiKey=pk_A`
  2. Send a message — verify connection succeeds and response renders
  3. Open a second SDK test page configured with `projectId=B, apiKey=pk_A` (mismatched key for project)
  4. Attempt to send a message — verify connection fails with auth error (transport emits error, ErrorMessage renders)
  5. Open a third SDK test page with no `apiKey` prop
  6. Verify transport fails to connect and ChatWidget shows disconnected/error state
- **Expected Result**: Cross-project key mismatch is rejected, missing auth fails gracefully
- **Auth Context**: API key auth — valid key for Project A, mismatched key for Project B, no key
- **Covers**: FR-2, SEC-4

### E2E-10: Connection resilience — disconnect and reconnect during streaming

- **Preconditions**: Runtime running, project with valid API key, test page with ChatWidget
- **Steps**:
  1. Open SDK test page, send a message that triggers a long response
  2. While streaming chunks are rendering, simulate network disruption (Playwright network conditions or CDP)
  3. Verify the UI transitions to disconnected state (TypingIndicator stops, disconnected banner/state)
  4. Restore network connectivity
  5. Verify DefaultTransport reconnects automatically (exponential backoff)
  6. After reconnection, send a new message
  7. Verify the new message round-trip completes normally
- **Expected Result**: Disconnection is surfaced in UI, reconnection is automatic, new messages work after recovery
- **Auth Context**: API key auth (`pk_*`), project-scoped
- **Covers**: FR-2 (reliability), FR-7 (UI state)

---

## 3. Integration Test Scenarios (MANDATORY)

> **Note on mocking**: Client-side integration tests mock the network boundary (WebSocket/SessionManager) since the real network layer is tested via the E2E scenarios in Section 2. Codebase components above the network boundary are tested with their real implementations.

### INT-1: DefaultTransport faithfully delegates to SessionManager

- **Boundary**: `DefaultTransport` -> `SessionManager`
- **Setup**: Create a mock `SessionManager` with spy methods (`connect`, `disconnect`, `isConnected`, `send`, `getSessionId`, `getAuthToken`, `getProjectId`, `getRuntimeSessionId`, `getEndpoint`, `onTranscriptItem`). Instantiate `DefaultTransport(mockSessionManager)`.
- **Steps**:
  1. Call `transport.connect()`, verify `sessionManager.connect()` called
  2. Call `transport.isConnected()`, verify delegates to `sessionManager.isConnected()`
  3. Call `transport.send({ type: 'chat_message', text: 'Hello' })`, verify `sessionManager.send()` called with correct payload
  4. Call `transport.getSessionId()`, verify delegates to `sessionManager.getSessionId()`
  5. Emit `session_start` from mock, verify transport emits `connected` event
  6. Emit `message` from mock with `{ role: 'assistant', content: 'Hi' }`, verify transport emits `message` event with `TransportServerMessage`
  7. Call `transport.disconnect()`, verify `sessionManager.disconnect()` called
- **Expected Result**: Every SDKTransport method delegates to the corresponding SessionManager method; events are translated to transport format
- **Failure Mode**: If SessionManager throws, DefaultTransport surfaces the error (does not swallow)
- **Covers**: FR-2

### INT-2: StudioTransport bridges WebSocketContext chat messages

- **Boundary**: `StudioTransport` -> `WebSocketContext`
- **Setup**: Create mock WebSocketContext with `sendMessage()`, `addMessageListener()`, state getters (`isConnected`, `sessionId`, `projectId`). Mock Zustand session-store for active session. Initialize `useStudioTransport()` hook via `renderHook()`.
- **Steps**:
  1. Call `transport.connect()`, verify it resolves (StudioTransport is already connected via WebSocketContext)
  2. Call `transport.isConnected()`, verify it reads WebSocketContext connection state
  3. Call `transport.send({ type: 'chat_message', text: 'Hello' })`, verify `wsContext.sendMessage()` called
  4. Emit a `response_start` event from mock WebSocketContext, verify transport emits `message` event with `TransportServerMessage`
  5. Emit a `response_chunk` event, verify transport translates it
  6. Emit a `response_end` event, verify transport translates it
  7. Emit a `state_update` event (Studio-only), verify transport does NOT capture it (it stays in Zustand stores only)
  8. Emit a `dsl_collect` event (Studio-only), verify transport does NOT capture it
- **Expected Result**: Chat messages flow through, Studio-only message types are filtered out
- **Failure Mode**: If WebSocketContext disconnects, transport emits `disconnected`
- **Covers**: FR-11

### INT-3: StudioTransport thought event dual delivery

- **Boundary**: `StudioTransport` -> `WebSocketContext` + `observatory-store`
- **Setup**: Same as INT-2. Additionally, mock observatory-store's `addTraceEvent()` method.
- **Steps**:
  1. Emit a `tool_thought` event from mock WebSocketContext
  2. Verify StudioTransport translates it to a thought `TransportServerMessage` (role: 'thought', metadata: { toolName, traceIds })
  3. Verify the original event ALSO reaches observatory-store (StudioTransport subscribes to a subset; it does not intercept/block)
  4. Emit a `status_update` event
  5. Verify it does NOT appear as a transport message
  6. Verify it DOES reach the original Zustand store subscriber
- **Expected Result**: Thought events are dual-delivered: SDK transport gets `Message(role:'thought')`, observatory pipeline continues unbroken
- **Failure Mode**: If StudioTransport intercepts instead of subscribing, observatory breaks — verify independence
- **Covers**: FR-11, FR-13, GAP-004

### INT-4: ChatClient processes thought/handoff/error events through transport

- **Boundary**: `ChatClient` -> `SDKTransport`
- **Setup**: Create a mock `SDKTransport` that implements the interface. Initialize `ChatClient(mockTransport)`.
- **Steps**:
  1. Emit a thought event: `transport.emit('message', { type: 'thought', content: 'Thinking...', metadata: { toolName: 'search', traceIds: ['t1'] } })`
  2. Verify `chatClient.getMessages()` includes a `Message` with `role: 'thought'`, `content: 'Thinking...'`, `metadata.toolName: 'search'`
  3. Emit a handoff event: `transport.emit('message', { type: 'handoff', metadata: { handoffFrom: 'agent-a', handoffTo: 'agent-b' } })`
  4. Verify message has `metadata.handoffFrom` and `metadata.handoffTo`
  5. Emit an error event: `transport.emit('message', { type: 'error', content: 'Tool failed', metadata: { errorCode: 'TOOL_ERROR', severity: 'warning' } })`
  6. Verify message has `metadata.errorCode` and `metadata.severity`
  7. Verify `getMessages()` returns all three messages in order
  8. Verify standard user/assistant messages still work alongside thought/handoff/error
- **Expected Result**: ChatClient translates transport events into typed `Message` objects with correct role and metadata
- **Failure Mode**: Missing metadata fields silently default to undefined (no crash)
- **Covers**: FR-4, FR-5, FR-6

### INT-5: ChatClient streaming protocol through transport

- **Boundary**: `ChatClient` -> `SDKTransport` (streaming flow)
- **Setup**: Mock SDKTransport, initialize ChatClient.
- **Steps**:
  1. Send a user message via `chatClient.send('Hello')`
  2. Emit `response_start` from transport
  3. Verify ChatClient creates a pending assistant message
  4. Emit 5 `response_chunk` events with content fragments: `["The ", "quick ", "brown ", "fox ", "jumped"]`
  5. Verify the pending message accumulates chunks: `"The quick brown fox jumped"`
  6. Emit `response_end`
  7. Verify the message is finalized (no longer streaming)
  8. Emit an interleaved `status_update` between chunks 3 and 4
  9. Verify status event does not corrupt the streaming accumulation
  10. Verify `getMessages()` returns `[userMessage, assistantMessage]`
- **Expected Result**: Streaming chunks accumulate correctly, interleaved events are handled, final message is complete
- **Failure Mode**: Orphaned `response_chunk` without `response_start` is ignored
- **Covers**: FR-4

### INT-6: AgentProvider with transport prop renders SDK components

- **Boundary**: `AgentProvider` -> `SDKTransport` -> `useChat()`
- **Setup**: Create mock SDKTransport. Render `<AgentProvider transport={mockTransport}><TestConsumer /></AgentProvider>` where `TestConsumer` uses `useChat()`.
- **Steps**:
  1. Verify AgentProvider does NOT create a DefaultTransport internally (no `SessionManager` instantiation)
  2. Verify `useChat()` returns `{ send, getMessages, clearMessages, isConnected }`
  3. Call `send('Hello')`, verify message goes through `mockTransport.send()`
  4. Emit a response from mockTransport, verify `getMessages()` includes it
  5. Call `clearMessages()`, verify message list empties
  6. Verify `isConnected` reflects mockTransport state
- **Expected Result**: AgentProvider uses the provided transport, bypasses internal DefaultTransport creation
- **Failure Mode**: If transport prop changes mid-lifecycle, old transport disconnects, new transport connects
- **Covers**: FR-8

### INT-7: AgentProvider without transport prop — backwards compatibility

- **Boundary**: `AgentProvider` -> `DefaultTransport` (internal creation)
- **Setup**: Render `<AgentProvider projectId="test-proj" apiKey="pk_test"><TestConsumer /></AgentProvider>` (no transport prop). Mock `AgentSDK` construction.
- **Steps**:
  1. Verify AgentProvider creates a DefaultTransport internally
  2. Verify DefaultTransport wraps the internally-created SessionManager
  3. Verify `useChat()` works the same as before the transport refactoring
  4. Verify `useAgent()` returns the AgentSDK instance
  5. Verify `useVoice()` returns the VoiceClient
- **Expected Result**: Zero behavior change from pre-consolidation API
- **Failure Mode**: N/A — this must be identical
- **Covers**: FR-2, FR-3, FR-15

### INT-8: SDKThemeProvider applies CSS custom properties

- **Boundary**: `SDKThemeProvider` -> React components
- **Setup**: Render `<SDKThemeProvider theme={{ primaryColor: '#FF0000', backgroundColor: '#000' }}><ChatWidget messages={[...]} /></SDKThemeProvider>`
- **Steps**:
  1. Verify the provider element sets `--sdk-primary-color: #FF0000` as a CSS custom property on its container
  2. Verify `--sdk-background-color: #000` is set
  3. Verify SDK components (ChatInput, MessageList) inherit these properties
  4. Render without SDKThemeProvider — verify components use default theme values
  5. Change theme prop dynamically — verify CSS properties update
- **Expected Result**: Theme values flow to components via CSS custom properties, defaults work without provider
- **Failure Mode**: Missing theme value falls back to default, no crash
- **Covers**: FR-9

### INT-9: StringsProvider overrides component labels

- **Boundary**: `StringsProvider` -> React components
- **Setup**: Render `<StringsProvider strings={{ sendButton: 'Enviar', placeholder: 'Escribe un mensaje...' }}><ChatInput /></StringsProvider>`
- **Steps**:
  1. Verify ChatInput's send button text is "Enviar"
  2. Verify ChatInput's placeholder text is "Escribe un mensaje..."
  3. Render ChatInput without StringsProvider — verify English defaults
  4. Provide partial overrides — verify non-overridden strings use defaults
- **Expected Result**: String overrides apply to components, partial overrides merge with defaults
- **Failure Mode**: Missing string key falls back to default English string
- **Covers**: FR-10

### INT-10: StudioChatPanel composes SDK components with Studio features

- **Boundary**: `StudioChatPanel` -> SDK MessageList + ChatInput + StudioChatHeader
- **Setup**: Render `<StudioChatPanel>` with mock StudioTransport, mock messages array including thought/user/assistant/error messages
- **Steps**:
  1. Verify StudioChatHeader renders with agent name, debug toggle button, export button, reset button
  2. Verify SDK MessageList renders within StudioChatPanel
  3. Verify thought messages render as ThoughtCard with "View trace" link (onViewTrace prop wired)
  4. Verify assistant messages render with RichContent
  5. Verify SDK ChatInput renders at the bottom
  6. Verify AuthChallengeMessage renders when auth challenge state is active
  7. Verify SessionHealthBanner renders when session health is degraded
  8. Click debug toggle — verify callback fires
  9. Click export — verify callback fires
  10. Click reset — verify callback fires
- **Expected Result**: StudioChatPanel is a composition of SDK components + Studio-specific header/banners
- **Failure Mode**: Missing StudioTransport renders error boundary, not crash
- **Covers**: FR-12, FR-13

### INT-11: Custom transport implementation — echo transport with AgentProvider

- **Boundary**: `AgentProvider` -> custom `SDKTransport`
- **Setup**: Create an `EchoTransport` implementing `SDKTransport` that echoes back messages as assistant responses. Render `<AgentProvider transport={echoTransport}><TestConsumer /></AgentProvider>`.
- **Steps**:
  1. Verify `connect()` resolves
  2. Call `useChat().send('Echo test')`, verify `EchoTransport.send()` receives the payload
  3. Verify EchoTransport emits a `message` event with `{ role: 'assistant', content: 'Echo: Echo test' }`
  4. Verify `useChat().getMessages()` contains both user and echoed assistant message
  5. Call `echoTransport.disconnect()`, verify `useChat().isConnected` becomes false
- **Expected Result**: Custom transport implementation works with AgentProvider and useChat hook
- **Failure Mode**: Invalid transport (missing methods) throws at AgentProvider initialization
- **Covers**: FR-1, FR-8

---

## 4. Unit Test Scenarios

### UT-1: SDKTransport interface contract

- **Module**: `transport/types.ts`
- **Input**: TypeScript interface definition
- **Tests**:
  1. Verify `SDKTransport` requires all methods: `connect()`, `disconnect()`, `isConnected()`, `send()`, `on()`, `getSessionId()`
  2. Verify `capabilities` object is required with boolean feature flags
  3. Verify a minimal mock implementation satisfies the interface (compile-time check + runtime assertion)
  4. Verify `TransportServerMessage` union covers: `response_start`, `response_chunk`, `response_end`, `thought`, `handoff`, `error`, `auth_challenge`, `status_update`, `status_clear`
- **Covers**: FR-1

### UT-2: DefaultTransport — SessionManager alias re-export

- **Module**: `transport/index.ts`
- **Input**: Import `{ SessionManager }` from transport barrel
- **Tests**:
  1. Verify `SessionManager` is exported from `transport/index.ts`
  2. Verify it is the same class as the original `core/SessionManager`
  3. Verify `import { SessionManager } from '@agent-platform/web-sdk'` still works (root barrel)
- **Covers**: FR-3

### UT-3: Message type extension

- **Module**: `core/types.ts`
- **Input**: `Message` type definition
- **Tests**:
  1. Verify `Message.role` accepts `'user' | 'assistant' | 'system' | 'thought'`
  2. Verify optional metadata fields: `toolName`, `agentName`, `handoffFrom`, `handoffTo`, `errorCode`, `severity`, `traceIds`
  3. Verify `MessageRole` type alias is exported
  4. Verify existing code that creates `Message({ role: 'user' })` still compiles
- **Covers**: FR-5

### UT-4: MessageList role-based dispatch

- **Module**: `react/components/MessageList.tsx`
- **Input**: Array of `Message` objects with various roles
- **Tests**:
  1. Render MessageList with `[{ role: 'user', content: 'Hi' }]` — verify user bubble renders
  2. Render with `[{ role: 'assistant', content: 'Hello' }]` — verify assistant bubble renders
  3. Render with `[{ role: 'thought', content: 'Searching...', metadata: { toolName: 'search' } }]` — verify ThoughtCard renders
  4. Render with `[{ role: 'system', content: 'Session started' }]` — verify system message renders
  5. Render with mixed roles — verify correct ordering
  6. Render with empty array — verify empty state
  7. Render with message containing `richContent` — verify RichContent dispatches
- **Covers**: FR-7

### UT-5: ThoughtCard expand/collapse and onViewTrace

- **Module**: `react/components/ThoughtCard.tsx`
- **Input**: Thought message with metadata
- **Tests**:
  1. Render ThoughtCard with `{ content: 'Looking up docs', metadata: { toolName: 'search' } }` — verify tool name displayed
  2. Click the card — verify content expands (initially collapsed)
  3. Click again — verify content collapses
  4. Render with `onViewTrace` callback, click "View trace" — verify callback fires with `traceIds`
  5. Render without `onViewTrace` — verify "View trace" link is not rendered
  6. Render with long content — verify truncation in collapsed state
- **Covers**: FR-7, FR-13

### UT-6: ChatInput component

- **Module**: `react/components/ChatInput.tsx`
- **Input**: User interactions
- **Tests**:
  1. Type text and press Enter — verify `onSend` callback fires with text
  2. Type text and click send button — verify `onSend` fires
  3. Verify input clears after send
  4. Verify disabled state when `isConnected` is false
  5. Verify placeholder text from StringsProvider
  6. Verify file upload button triggers file picker
  7. Verify Shift+Enter inserts newline (does not send)
- **Covers**: FR-7

### UT-7: StreamingMessage component

- **Module**: `react/components/StreamingMessage.tsx`
- **Input**: Streaming content string, isStreaming flag
- **Tests**:
  1. Render with `isStreaming: true, content: "Hello"` — verify typing indicator appears
  2. Update content to "Hello world" — verify re-render with new content
  3. Set `isStreaming: false` — verify typing indicator disappears
  4. Render with empty content and `isStreaming: true` — verify just the indicator shows
- **Covers**: FR-7

### UT-8: HandoffMessage, ErrorMessage, TypingIndicator

- **Module**: `react/components/HandoffMessage.tsx`, `ErrorMessage.tsx`, `TypingIndicator.tsx`
- **Tests**:
  1. HandoffMessage: render with `{ handoffFrom: 'Agent A', handoffTo: 'Agent B' }` — verify both names displayed
  2. HandoffMessage: render with only `handoffTo` — verify graceful display
  3. ErrorMessage: render with `{ errorCode: 'TOOL_ERROR', severity: 'warning', content: 'Search failed' }` — verify warning styling
  4. ErrorMessage: render with `severity: 'error'` — verify error styling
  5. TypingIndicator: render — verify animated dots appear
  6. TypingIndicator: verify accessible role and label
- **Covers**: FR-7

### UT-9: ActionHandler component

- **Module**: `react/components/ActionHandler.tsx`
- **Input**: Action definitions (buttons, selects, inputs)
- **Tests**:
  1. Render quick-reply buttons `[{ type: 'button', label: 'Yes' }, { type: 'button', label: 'No' }]` — verify two buttons render
  2. Click "Yes" button — verify `onAction` callback fires with action payload
  3. Render select action — verify dropdown renders with options
  4. Render input action — verify text input renders
  5. Verify actions disabled after submission (one-shot)
- **Covers**: FR-7

### UT-10: MarkdownContent sanitization

- **Module**: `react/components/MarkdownContent.tsx`
- **Tests**:
  1. Render markdown with `**bold**` — verify `<strong>` tag in output
  2. Render with code block — verify `<pre><code>` renders
  3. Render with `<script>alert('xss')</script>` — verify script tag stripped (XSS prevention)
  4. Render with `<img onerror="alert('xss')">` — verify onerror attribute stripped
  5. Render with links — verify `target="_blank"` and `rel="noopener noreferrer"`
  6. Render empty string — verify no crash
- **Covers**: FR-7

### UT-11: ChatWidget composition

- **Module**: `react/components/ChatWidget.tsx`
- **Input**: Props for the composed chat widget
- **Tests**:
  1. Render ChatWidget — verify it contains MessageList, ChatInput, TypingIndicator
  2. Verify messages flow from ChatClient through ChatWidget to MessageList
  3. Verify send from ChatInput triggers ChatClient.send()
  4. Verify TypingIndicator shows during streaming
  5. Verify ChatWidget accepts className for custom styling
- **Covers**: FR-7

### UT-12: Omnichannel methods regression

- **Module**: `core/AgentSDK.ts`
- **Tests**:
  1. Verify `AgentSDK.discoverLiveSession()` still works after transport refactoring
  2. Verify `AgentSDK.joinLiveSession()` still works
  3. Verify `ChatClient.hydrateBackfill()` works through DefaultTransport
- **Covers**: FR-4 (regression)

---

## 5. Security & Isolation Tests

### SEC-1: Auth separation between transports

- DefaultTransport authenticates with API key (`pk_*`), never exposes JWT
- StudioTransport authenticates with JWT via `authHeaders()`, never exposes API key
- SDK components (Layer 3) never access auth credentials directly — they call `transport.send()`

### SEC-2: XSS prevention in rendered content

- MarkdownContent strips `<script>` tags, `onerror`/`onclick` handlers, `javascript:` URLs
- RichContent template renderers sanitize HTML content before injection
- User input in ChatInput is sent as text, never rendered as raw HTML

### SEC-3: SSR safety

- All SDK React components use `'use client'` directive
- Components that access `window`, `document`, or WebSocket are guarded with `typeof window !== 'undefined'` checks

### SEC-4: Transport scope propagation

- DefaultTransport carries `projectId` from API key scope — verify with mock
- StudioTransport carries `projectId` from WebSocketContext — verify with mock
- Verify no cross-project message leakage in session switching (integration test with two projects)

### SEC-5: Input validation

- ChatInput rejects empty messages (whitespace-only)
- `transport.send()` validates message structure (required fields present)
- File upload validates FormData is properly formed

---

## 6. Performance & Load Tests

### PERF-1: Bundle size validation

- Build `@agent-platform/web-sdk/react` entry point
- Verify output size < 40KB (gzipped) per success metric

### PERF-2: Large message list rendering

- Render MessageList with 200 messages (mixed roles: user, assistant, thought, handoff, error)
- Measure render time — should complete within 100ms
- Verify no memory leaks on repeated re-renders (no stale subscriptions)

### PERF-3: Rapid streaming chunks

- Emit 100 `response_chunk` events in rapid succession (< 1ms apart)
- Verify all chunks accumulate correctly in the final message
- Verify no dropped chunks or garbled output

### PERF-4: Theme switching cost

- Switch theme 10 times in rapid succession
- Verify only CSS custom properties change (no React re-renders of child components)
- Measure: CSS property update should be < 1ms

---

## 7. Test Infrastructure

### Required Services

- **Unit/Integration tests**: No services required. Vitest + happy-dom. Mock transports and WebSocketContext.
- **E2E tests**: Studio (port 5173) + Runtime (port 3112) running via PM2. At least one project with deployed agent.

### Data Seeding

- **E2E**: Create project + deploy agent with at least one tool configured (any HTTP or search tool). The runtime emits `tool_thought` events for every tool invocation, which triggers ThoughtCard rendering. Use the existing test project's default agent with the Search tool enabled, or deploy a minimal agent with one HTTP tool. Create two sessions for session-switching test.
- **Unit/Integration**: Hard-coded mock data arrays. No DB access.

### Test Environment

| Tool                   | Version | Purpose                       |
| ---------------------- | ------- | ----------------------------- |
| vitest                 | ^4.0.18 | Test runner                   |
| happy-dom              | ^20.6.1 | DOM environment for SDK tests |
| @testing-library/react | ^16.x   | React component testing       |
| Playwright             | ^1.58.2 | E2E browser automation        |

### CI Configuration

- Unit/Integration: `pnpm build --filter=@agent-platform/web-sdk && pnpm test --filter=@agent-platform/web-sdk`
- Studio integration: `pnpm build --filter=@agent-platform/studio && pnpm test --filter=@agent-platform/studio`
- E2E: Uses `apps/studio/playwright.config.ts` with existing global setup/teardown that starts PM2 services. SDK embed E2E tests go in `apps/studio/e2e/` to leverage existing helpers (`bootstrapWidgetContext`, `checkSdkBrowserPrerequisites`).

---

## 8. Test File Mapping

| Test File                                                           | Type        | Covers                                                             |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `packages/web-sdk/src/__tests__/transport-types.test.ts`            | unit        | FR-1 transport contract                                            |
| `packages/web-sdk/src/__tests__/default-transport.test.ts`          | unit + int  | FR-2 default transport delegation + translation                    |
| `packages/web-sdk/src/__tests__/chat-client-transport.test.ts`      | unit + int  | FR-4, FR-5, FR-6 core message flow                                 |
| `packages/web-sdk/src/__tests__/chat-client-integration.test.ts`    | integration | FR-4 end-to-end message accumulation with mock transport boundary  |
| `packages/web-sdk/src/__tests__/chat-client-status.test.ts`         | unit        | status-update / status-clear handling                              |
| `packages/web-sdk/src/__tests__/agent-provider-transport.test.tsx`  | integration | FR-3, FR-8, FR-9, FR-10, FR-15 via Path A / Path B                 |
| `packages/web-sdk/src/__tests__/react-components.test.tsx`          | unit        | FR-7, FR-13 shared component rendering                             |
| `packages/web-sdk/src/__tests__/echo-transport.test.ts`             | unit        | Third-party transport interface parity                             |
| `packages/web-sdk/src/__tests__/chat-client-session-switch.test.ts` | regression  | Session-switch message carryover guard                             |
| `packages/web-sdk/src/__tests__/strings-provider-nesting.test.tsx`  | regression  | Nested StringsProvider localization guard                          |
| `apps/studio/src/__tests__/studio-transport.test.ts`                | integration | FR-11 Studio transport bridge                                      |
| `apps/studio/src/__tests__/components/studio-chat-panel.test.tsx`   | integration | FR-12 Studio composition layer                                     |
| `apps/studio/e2e/sdk-chat-consolidation-e2e.spec.ts`                | E2E         | Studio/browser flows, SDK embed flows, error/auth/resilience paths |
| `apps/studio/e2e/sdk-chat-performance.spec.ts`                      | E2E / perf  | PERF-1 through PERF-4                                              |

---

## 9. Open Testing Questions

1. Should the SDK embed E2E tests use the existing `packages/web-sdk/examples/react-app/` as the test page, or create a dedicated minimal test page? (DECIDED: Use existing react-app example — it already loads the SDK and has project/API key configuration.)
2. Should Playwright E2E tests for SDK embed run against the Vite dev server or a production build? (DECIDED: Production build — `pnpm build` first, then serve the built output. Matches CI conditions.)
3. How should E2E tests seed an agent that emits thought events? (DECIDED: Use existing project fixtures in test environment. Studio E2E already assumes a running agent.)
