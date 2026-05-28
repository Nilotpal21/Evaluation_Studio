# @agent-platform/web-sdk

Embeddable Web SDK for Voice (WebRTC) and Chat interactions with Agent Platform.

This package is consumable on its own and does not require the rest of the monorepo to be installed alongside it.

## Features

- **Chat Widget**: Text-based conversations with AI agents
- **Voice Widget**: Real-time voice via WebRTC (Twilio)
- **Unified Widget**: Combined chat + voice with mode toggle
- **React Components**: First-class React support with hooks
- **Web Components**: Framework-agnostic custom elements
- **TypeScript**: Full type safety

## Installation

```bash
npm install @agent-platform/web-sdk
# or
pnpm add @agent-platform/web-sdk
```

## Quick Start

### Script Tag (UMD)

```html
<script src="https://cdn.agentplatform.com/sdk/v1/agent-sdk.umd.js"></script>
<script>
  AgentSDK.init({
    projectId: 'your_project_id',
    apiKey: 'pk_your_public_key',
  });
</script>

<!-- Chat widget; add enable-feedback="true" to show built-in feedback buttons -->
<agent-chat position="bottom-right"></agent-chat>
<agent-chat position="bottom-right" enable-feedback="true"></agent-chat>

<!-- Or voice widget -->
<agent-voice position="bottom-left"></agent-voice>

<!-- Or unified widget; enable-feedback works for the chat surface -->
<agent-widget mode="unified" position="bottom-right"></agent-widget>
<agent-widget mode="unified" position="bottom-right" enable-feedback="true"></agent-widget>
```

Activity updates are controlled by the SDK channel configuration returned by Runtime. Customer-facing channels hide transient handoff/delegate/reasoning activity by default, while Studio debug surfaces can keep them enabled separately.

### ES Modules

```typescript
import { AgentSDK } from '@agent-platform/web-sdk';

const sdk = new AgentSDK({
  projectId: 'your_project_id',
  apiKey: 'pk_your_public_key',
});

await sdk.connect();

// Chat
const chat = sdk.chat();
chat.on('message', (msg) => console.log('Message:', msg));
await chat.send('Hello!');
await chat.send('Look up this account', {
  metadata: {
    accountId: 'acct_123',
    context: { tier: 'gold' },
  },
});

// Voice
const voice = sdk.voice();
voice.on('transcription', (text) => console.log('User:', text));
await voice.start();
```

### React

```tsx
import { AgentProvider, ChatWidget, useChat } from '@agent-platform/web-sdk/react';

function App() {
  return (
    <AgentProvider projectId="your_project_id" apiKey="pk_your_public_key">
      <ChatWidget enableFeedback />
    </AgentProvider>
  );
}

// Or build custom UI with hooks
function CustomChat() {
  const { messages, send, isTyping } = useChat();
  // Build your UI...
}
```

## API Reference

### AgentSDK

Main SDK class for initializing and managing connections.

```typescript
const sdk = new AgentSDK({
  projectId: string;       // Required: Project ID
  apiKey: string;          // Required: Public API key (pk_...)
  endpoint?: string;       // Optional: API endpoint
  debug?: boolean;         // Optional: Enable debug logging
  idleDisconnect?: {       // Optional: browser inactivity disconnect
    timeoutMs: number;     // e.g. 900000 for 15 minutes
    behavior?: 'disconnect' | 'end_session';
  };
  autoConnect?: boolean;   // Optional: Auto-connect on init
  reconnect?: {            // Optional: Reconnection settings
    enabled?: boolean;
    maxAttempts?: number;
    baseDelay?: number;
    maxDelay?: number;
  };
});

// Methods
await sdk.connect(): Promise<string>  // Returns session ID
sdk.disconnect(): void
sdk.chat(): ChatClient
sdk.voice(): VoiceClient
sdk.isConnected(): boolean
sdk.getSessionId(): string | undefined

// Events
sdk.on('connected', ({ sessionId }) => {});
sdk.on('disconnected', ({ reason }) => {});
sdk.on('idleTimeout', ({ timeoutMs, behavior }) => {});
sdk.on('error', ({ error }) => {});
```

`idleDisconnect.behavior: 'disconnect'` closes the browser socket and leaves Runtime lifecycle
policy to decide whether the session is resumable. `behavior: 'end_session'` sends Runtime's
explicit end-session frame before closing so the conversation is terminalized.

### ChatClient

Text messaging functionality.

```typescript
const chat = sdk.chat();

// Methods
await chat.send(text: string, options?: {
  attachmentIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<string>
chat.getMessages(): Message[]
chat.clearHistory(): void

// Events
chat.on('message', (msg: Message) => {});
chat.on('messageStart', ({ messageId }) => {});
chat.on('messageChunk', ({ messageId, chunk }) => {});
chat.on('messageEnd', ({ messageId, message }) => {});
chat.on('typing', ({ isTyping }) => {});
```

Per-message `metadata` is validated server-side and is available only for the active turn as `session.messageMetadata` and `message_metadata`.

### Structured Assistant Messages

Current assistant messages can include structured payloads alongside plain text:

```typescript
chat.on('message', (msg) => {
  if (msg.role !== 'assistant') return;

  console.log(msg.content); // plain text fallback / main response
  console.log(msg.voiceConfig); // voice-specific output config
  console.log(msg.richContent); // built-in rich content schema
  console.log(msg.actions); // interactive actions
});
```

The built-in renderer registry handles the platform-defined `richContent` fields. These are fixed schema keys such as `markdown`, `carousel`, `kpi`, `table`, `form`, and `quick_replies`.

### Planned Custom `renderables[]` Contract (Draft)

The recommended extension for customer-defined UI payloads is a separate `renderables[]` array on each assistant message. This is not implemented yet, but the existing registry makes the SDK a natural consumer once the transport adds it.

```typescript
interface RenderablePayload {
  name: string; // e.g. "com.bank.account_summary.v1"
  payload: unknown;
  targets?: string[];
  fallbackText?: string;
  schemaRef?: string;
}
```

Draft renderer example:

```typescript
import { defaultRegistry } from '@agent-platform/web-sdk';

defaultRegistry.register({
  type: 'com.bank.account_summary.v1',
  extract(message) {
    return message.renderables?.find(
      (item) => item.name === 'com.bank.account_summary.v1',
    )?.payload;
  },
  render(data) {
    return <AccountSummaryCard data={data} />;
  },
  renderDOM(data) {
    const el = document.createElement('div');
    el.textContent = `Balance: ${data.balance} ${data.currency}`;
    return el;
  },
});
```

The Web SDK is not its own runtime channel target. It consumes the `sdk_websocket` transport and renders client-side.

### VoiceClient

Voice interaction via WebRTC.

```typescript
const voice = sdk.voice();

// Methods
await voice.start(): Promise<void>
voice.stop(): void
voice.mute(): void
voice.unmute(): void
voice.toggleMute(): boolean

// Static
VoiceClient.isSupported(): boolean
VoiceClient.getAudioDevices(): Promise<MediaDeviceInfo[]>

// Events
voice.on('stateChange', ({ state, previousState }) => {});
voice.on('transcription', ({ text, isFinal, confidence }) => {});
voice.on('responseStart', ({ messageId }) => {});
voice.on('responseEnd', ({ messageId, text }) => {});
voice.on('speaking', ({ isSpeaking }) => {});
voice.on('error', ({ error }) => {});
```

### Web Components

#### `<agent-chat>`

```html
<agent-chat
  project-id="xxx"
  api-key="pk_xxx"
  position="bottom-right"
  enable-feedback="true"
  theme='{"primaryColor": "#007bff"}'
  welcome-message="Hello!"
  placeholder="Type a message..."
  show-branding="true"
  compact="false"
></agent-chat>
```

#### `<agent-voice>`

```html
<agent-voice
  project-id="xxx"
  api-key="pk_xxx"
  position="bottom-left"
  theme='{"primaryColor": "#007bff"}'
></agent-voice>
```

#### `<agent-widget>`

```html
<agent-widget
  project-id="xxx"
  api-key="pk_xxx"
  mode="unified"
  position="bottom-right"
  enable-feedback="true"
></agent-widget>
```

### React Components

#### AgentProvider

```tsx
<AgentProvider
  projectId="xxx"
  apiKey="pk_xxx"
  endpoint="https://api.example.com"
  theme={{ primaryColor: '#007bff' }}
  debug={false}
>
  {children}
</AgentProvider>
```

#### ChatWidget

```tsx
<ChatWidget
  enableFeedback={true}
  theme={{ primaryColor: '#007bff' }}
  strings={{ feedbackThanks: 'Thanks for the feedback' }}
  onUploadFile={async (file) => 'attachment-id'}
  onViewTrace={(metadata) => {}}
  onAction={(actionId, value, options) => {}}
/>
```

`enableFeedback` defaults to `false`. When enabled, the React widget renders
thumbs-up / thumbs-down controls under final assistant messages, submits through
`chat.submitFeedback(...)`, supports an optional thumbs-down comment, and avoids
duplicating controls when the message already contains a rich feedback template.
For web components, use `enable-feedback="true"` on `<agent-chat>` or
`<agent-widget>`; omit the attribute or set it to `"false"` to disable it.

#### VoiceWidget

```tsx
<VoiceWidget
  position="bottom-left"
  theme={{ primaryColor: '#007bff' }}
  onStart={() => {}}
  onStop={() => {}}
  onTranscription={(text, isFinal) => {}}
/>
```

### React Hooks

```tsx
// Main SDK hook
const { isConnected, sessionId, error, reconnect, disconnect } = useAgent();

// Chat hook
const { messages, isTyping, isSending, send, clearHistory } = useChat();

// Voice hook
const {
  state,
  isActive,
  isListening,
  isSpeaking,
  isMuted,
  transcript,
  start,
  stop,
  toggleMute,
  isSupported,
} = useVoice();
```

## Theme Configuration

```typescript
interface WidgetTheme {
  primaryColor?: string; // Default: '#0066FF'
  textColor?: string; // Default: '#1a1a1a'
  backgroundColor?: string; // Default: '#ffffff'
  borderRadius?: number; // Default: 12
  fontFamily?: string; // Default: system fonts
  darkMode?: boolean; // Default: false
}
```

## Browser Support

- Chrome 70+
- Firefox 70+
- Safari 14+
- Edge 79+

Voice features require WebRTC support.

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run examples
cd examples/react-app && pnpm dev
```

## License

MIT
