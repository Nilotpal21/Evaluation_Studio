# SDK & Transport Layer

> **Estimated time**: 35 minutes | **Prerequisites**: Familiarity with React, TypeScript, and WebSocket concepts

## Learning Objectives

After completing this module, you will be able to:

- Describe the 4-layer Web SDK architecture and how each layer contributes
- Use `ChatClient` to build custom UI experiences with streaming support
- Distinguish between `DefaultTransport` and `StudioTransport` and explain when each applies
- Identify all 4 `TransportCapabilities` flags and explain why `supportsStreaming` is not one of them
- Configure `AgentProvider` using both Path A (SDK-managed) and Path B (custom transport)

## Web SDK Architecture Overview

The Agent Platform Web SDK (`@agent-platform/web-sdk`) is organized into four distinct layers, each with a clear responsibility:

| Layer            | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| **Transport**    | `SDKTransport` interface with pluggable implementations                 |
| **Chat Logic**   | `ChatClient` accepts any transport; manages messages, typing, streaming |
| **React UI**     | 11 shared components: `MessageList`, `ChatInput`, `ChatWidget`, etc.    |
| **Theme / i18n** | `SDKThemeProvider` (CSS custom properties) + `StringsProvider` (l10n)   |

This layered design is deliberate. Each layer can be swapped or extended independently. You can use the React UI components with a custom transport, or use the `ChatClient` without any React components at all. The layers compose upward -- the transport feeds the chat logic, which feeds the UI.

```
+----------------------------------------------+
|              Your Application                |
+----------------------------------------------+
|  AgentProvider                               |
|  +--------------------+  +-----------------+ |
|  | ChatWidget         |  | Theme + Strings | |
|  |  MessageList       |  | SDKThemeProvider| |
|  |  ChatInput         |  | StringsProvider | |
|  |  TypingIndicator   |  +-----------------+ |
|  +--------+-----------+                      |
|           |                                  |
|  +--------v-----------+                      |
|  |  ChatClient        | (transport-agnostic) |
|  +--------+-----------+                      |
|           |                                  |
|  +--------v----------------------------------+
|  |  SDKTransport (interface)                 |
|  |  +- DefaultTransport (API key auth)       |
|  |  +- StudioTransport  (JWT auth)           |
|  +-------------------------------------------+
+----------------------------------------------+
```

## The Transport Layer

The transport layer is the foundation. It defines _how_ the SDK communicates with the platform -- the protocol, authentication, and connection lifecycle.

### The SDKTransport Interface

Every transport implements a common interface:

```typescript
interface SDKTransport {
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
```

The interface is event-driven. You `connect()`, `send()` messages, and listen for events. The `on()` method returns an unsubscribe function, following React's cleanup pattern.

### TransportCapabilities: The 4 Flags

Every transport declares its capabilities through a set of boolean flags:

```typescript
interface TransportCapabilities {
  supportsThoughts: boolean; // Can receive agent reasoning/thought messages
  supportsHandoff: boolean; // Can display agent-to-agent handoff notifications
  supportsFileUpload: boolean; // Can upload file attachments
  supportsVoice: boolean; // Can handle voice interactions
}
```

> **Key Concept**: Notice what is _not_ in `TransportCapabilities`: there is no `supportsStreaming` flag. Streaming is handled at the message protocol level (via `response_start` / `response_chunk` / `response_end` message types), not as a transport capability. All WebSocket-based transports inherently support streaming. The capabilities flags describe higher-level feature support that varies between transport implementations.

### DefaultTransport vs. StudioTransport

The SDK ships with two transport implementations that serve different purposes:

| Transport            | Auth Method         | Use Case                                             | Created By                |
| -------------------- | ------------------- | ---------------------------------------------------- | ------------------------- |
| **DefaultTransport** | API key + SDK token | Customer-facing deployments (your website, your app) | `AgentSDK` automatically  |
| **StudioTransport**  | JWT (session-based) | ABL Studio's internal test chat panel                | Studio's WebSocket bridge |

**DefaultTransport** is what you use in production. It wraps a `SessionManager` that handles API key authentication, session creation, WebSocket connection, and automatic reconnection. When you create an `AgentSDK` instance with a `projectId` and `apiKey`, it creates a `DefaultTransport` internally.

**StudioTransport** is used inside ABL Studio itself. Studio already has an authenticated WebSocket connection (via JWT), so `StudioTransport` bridges that existing connection to the SDK's transport interface. This is an example of the custom transport pattern -- Studio implements `SDKTransport` against its own WebSocket.

> **Key Concept**: You do not create `DefaultTransport` or `StudioTransport` directly in most cases. `AgentSDK` creates `DefaultTransport` for you (Path A). For custom integrations, you implement the `SDKTransport` interface yourself, following the same pattern `StudioTransport` uses internally.

## ChatClient: The Heart of Chat Logic

`ChatClient` is the transport-agnostic chat engine. It accepts any `SDKTransport` and manages the full lifecycle of a text conversation: sending messages, receiving responses, handling streaming, tracking typing state, and managing interactive actions.

### Why ChatClient Matters for Custom UI

If you are building a custom chat interface (not using the pre-built `ChatWidget`), `ChatClient` is your primary API. It gives you everything you need without coupling you to React:

```typescript
import { ChatClient } from '@agent-platform/web-sdk';

const chat = new ChatClient(myTransport);

// Send a message
const messageId = await chat.send('Hello, I need help with my booking');

// Listen for streaming responses
chat.on('messageChunk', ({ messageId, chunk }) => {
  appendToUI(messageId, chunk);
});

// Listen for complete messages
chat.on('message', (msg) => {
  if (msg.role === 'assistant') {
    displayMessage(msg.content);
  }
});

// Track typing state
chat.on('typing', ({ isTyping }) => {
  showTypingIndicator(isTyping);
});

// Handle interactive actions
chat.submitAction('book_hotel', 'grand_hotel');

// Upload attachments
const attachmentId = await chat.uploadAttachment(file);
await chat.send('Please analyze this document', { attachmentIds: [attachmentId] });
```

### Key ChatClient Methods

| Method                                 | Returns           | Purpose                                       |
| -------------------------------------- | ----------------- | --------------------------------------------- |
| `send(text, options?)`                 | `Promise<string>` | Send a message; returns message ID            |
| `uploadAttachment(file)`               | `Promise<string>` | Upload a file; returns attachment ID          |
| `getMessages()`                        | `Message[]`       | Get all messages in the conversation          |
| `getIsTyping()`                        | `boolean`         | Check if the agent is currently responding    |
| `submitAction(actionId, value?)`       | `void`            | Submit an interactive action (button, select) |
| `sendAuthResponse(toolCallId, status)` | `void`            | Respond to a JIT auth challenge               |
| `dispose()`                            | `void`            | Clean up subscriptions and timers             |

### ChatClient Events

| Event           | Payload                | When It Fires                                              |
| --------------- | ---------------------- | ---------------------------------------------------------- |
| `message`       | `Message`              | New complete message (user, assistant, thought, or system) |
| `messageChunk`  | `{ messageId, chunk }` | Streaming text fragment from assistant                     |
| `typing`        | `{ isTyping }`         | Agent typing state changed                                 |
| `authChallenge` | `AuthChallengeMessage` | JIT auth challenge received (OAuth popup needed)           |
| `statusUpdate`  | `{ text, operation }`  | Status update from agent (e.g., "Searching...")            |
| `error`         | `{ error }`            | Chat error occurred                                        |

## The 11 Shared React Components

The SDK provides 11 pre-built React components exported from `@agent-platform/web-sdk/react`:

| #   | Component          | Purpose                                                          |
| --- | ------------------ | ---------------------------------------------------------------- |
| 1   | `AgentProvider`    | Context provider; initializes SDK or accepts custom transport    |
| 2   | `ChatWidget`       | Ready-made chat panel composing all other components             |
| 3   | `MessageList`      | Role-based message dispatcher (user, assistant, thought, system) |
| 4   | `ChatInput`        | Text area with send button and file upload                       |
| 5   | `StreamingMessage` | Animated streaming text with blinking cursor                     |
| 6   | `ThoughtCard`      | Collapsible agent reasoning/thought display                      |
| 7   | `HandoffMessage`   | Agent routing indicator ("Routing from X to Y")                  |
| 8   | `ErrorMessage`     | Severity-styled error/warning display                            |
| 9   | `RichContent`      | Dispatches rendering for all rich content types                  |
| 10  | `ActionHandler`    | Renders buttons, selects, and inputs from ActionSet              |
| 11  | `TypingIndicator`  | Animated dots with localized label                               |
| 12  | `MarkdownContent`  | Sanitized markdown renderer (XSS-safe)                           |

Wait -- that is 12 items in the list. The SDK documentation describes 11 shared components. `MarkdownContent` is the 12th entry but is considered part of the shared component set. The official count of **11 shared React components** refers to the primary UI building blocks listed in the SDK architecture table.

> **Key Concept**: You can use `ChatWidget` for a complete out-of-the-box experience, or compose the individual components (`MessageList`, `ChatInput`, `TypingIndicator`, etc.) to build a fully custom layout. All components read state from `AgentProvider` via hooks.

## AgentProvider: Two Initialization Paths

`AgentProvider` is the React context provider that wraps your application. It supports two distinct initialization paths:

### Path A: SDK-Managed (Default)

Provide `projectId`, `apiKey`, and `endpoint`. The provider creates an `AgentSDK` instance, establishes a WebSocket connection, and manages chat and voice clients internally.

```tsx
import { AgentProvider, ChatWidget } from '@agent-platform/web-sdk/react';

function App() {
  return (
    <AgentProvider
      projectId="your-project-id"
      apiKey="pk_your-public-key"
      endpoint="https://api.ablplatform.com"
      theme={{ primaryColor: '#7c3aed' }}
    >
      <ChatWidget />
    </AgentProvider>
  );
}
```

Path A gives you everything: chat, voice, streaming, file upload, theming, and localization. This is the recommended path for customer-facing deployments.

### Path B: Custom Transport (No Voice)

Provide a `transport` prop implementing the `SDKTransport` interface. The provider creates a `ChatClient` directly from your transport. No `AgentSDK` is created.

```tsx
import { AgentProvider, ChatWidget } from '@agent-platform/web-sdk/react';
import { useMyCustomTransport } from './my-transport';

function App() {
  const transport = useMyCustomTransport();
  return (
    <AgentProvider transport={transport}>
      <ChatWidget />
    </AgentProvider>
  );
}
```

> **Key Concept**: Path B (custom transport) does **not** support voice. The `voice` client from `useAgent()` will be `null`, and `startVoice()` / `stopVoice()` will not be available. Voice requires the full `AgentSDK` lifecycle that only Path A provides. Use Path B when you have an existing WebSocket connection or authentication flow that you need to bridge to the SDK.

### When to Use Each Path

| Scenario                                  | Path       | Why                                               |
| ----------------------------------------- | ---------- | ------------------------------------------------- |
| Customer-facing website with chat + voice | **Path A** | Full SDK features, API key auth                   |
| Internal tool with existing auth system   | **Path B** | Bridge your existing WebSocket/JWT                |
| ABL Studio test panel                     | **Path B** | Studio already has an authenticated WS connection |
| Mobile app with custom WebSocket layer    | **Path B** | Wrap your native transport in SDKTransport        |
| Simple embed with minimal config          | **Path A** | Just provide projectId, apiKey, endpoint          |

## React Hooks for Custom UIs

When building custom UIs, three hooks give you access to SDK state:

### useAgent()

Full SDK context -- chat, voice, connection state, messages:

```typescript
const {
  sdk, // AgentSDK | null (null in Path B)
  isConnected, // boolean
  sessionId, // string | null
  chat, // ChatClient | null
  messages, // Message[]
  isTyping, // boolean
  sendMessage, // (text, options?) => Promise<void>
  voice, // VoiceClient | null (null in Path B)
  voiceState, // VoiceState
  thought, // ThoughtEventData | null
  statusMessage, // string | null
} = useAgent();
```

### useChat()

Chat-specific state only:

```typescript
const { messages, isTyping, sendMessage, isConnected } = useChat();
```

### useVoice()

Voice-specific state (Path A only):

```typescript
const { voiceState, startVoice, stopVoice, toggleMute, isMuted } = useVoice();
```

## Theme System

The SDK uses CSS custom properties (variables) for theming. All components reference `var(--sdk-*)` variables, so theme changes propagate instantly without re-rendering.

```tsx
<AgentProvider
  projectId="..."
  apiKey="pk_..."
  endpoint="https://..."
  theme={{
    primaryColor: '#7c3aed',
    backgroundColor: '#0f172a',
    textColor: '#e2e8f0',
    userBubbleColor: '#7c3aed',
    assistantBubbleColor: '#1e293b',
    fontFamily: 'Inter, sans-serif',
    borderRadius: '12px',
  }}
>
  <ChatWidget />
</AgentProvider>
```

You can pass `theme` to either `AgentProvider` (which wraps children in `SDKThemeProvider`) or directly to `ChatWidget`.

## Message Types and Streaming Protocol

Messages flow through the transport as typed objects. Understanding the protocol helps when building custom UIs:

**Client sends:**

- `chat_message` -- User text with optional attachments
- `action_submit` -- Interactive action response (button click, menu selection)
- `auth_response` -- JIT auth challenge response
- `typed_interrupt` -- Text interrupt during voice

**Server sends:**

- `response_start` -- Agent begins responding (contains messageId)
- `response_chunk` -- Streaming text fragment
- `response_end` -- Complete response with rich content, voice config, actions
- `thought` -- Agent reasoning/thought content
- `handoff` -- Agent-to-agent transfer notification
- `error` -- Error message
- `auth_challenge` -- JIT auth popup needed
- `status_update` / `status_clear` -- Processing status

Streaming works through the `response_start` -> N x `response_chunk` -> `response_end` sequence. The `ChatClient` assembles chunks into complete messages and fires both `messageChunk` (for live UI updates) and `message` (for the final complete message) events.

## Key Takeaways

- The Web SDK has 4 layers: Transport, Chat Logic (ChatClient), React UI (11 components), and Theme/i18n
- `ChatClient` is transport-agnostic -- use it with any `SDKTransport` implementation for custom UIs with full streaming support
- `TransportCapabilities` has 4 flags: `supportsThoughts`, `supportsHandoff`, `supportsFileUpload`, `supportsVoice` -- there is no `supportsStreaming` flag
- `DefaultTransport` uses API key auth for production; `StudioTransport` bridges Studio's JWT-authenticated WebSocket
- `AgentProvider` Path A (SDK-managed) gives you chat + voice; Path B (custom transport) gives you chat only -- no voice support

## What's Next

Explore the [Channel Architecture](../channel-architecture/content.md) module to understand how channels deliver agent conversations, or the [Agent Patterns](../agent-patterns/content.md) module to see how different agent types serve different business needs.
