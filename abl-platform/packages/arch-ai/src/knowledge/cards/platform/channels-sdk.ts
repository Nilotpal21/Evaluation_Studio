// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: api-reference/sdks.mdx
// Regenerate: pnpm abl:docs:generate

export const CHANNELS_SDK_CARD = `## SDK Channels — Web, Mobile, API

## Web SDK
- The Agent Platform Web SDK (\`@agent-platform/web-sdk\`) provides a TypeScript/JavaScript library for embedding agent chat and voice interactions in web applications.
- The browser-facing SDK does not send the public \`pk_*\` key directly to \`/ws/sdk\`.
### Installation
\`\`\`bash
npm install @agent-platform/web-sdk
\`\`\`
Or include via script tag:
\`\`\`html
<script src="https://cdn.ablplatform.com/agent-sdk/latest/agent-sdk.min.js"></script>
\`\`\`
### Quick start
#### Vanilla JavaScript
\`\`\`typescript
import { AgentSDK } from '@agent-platform/web-sdk';

const sdk = new AgentSDK({
  projectId: 'your-project-id',
  apiKey: 'pk_your-public-key',
  endpoint: 'https://api.ablplatform.com',
});

await sdk.connect();

// Send a chat message
const chat = sdk.chat();
chat.on('message', (msg) => console.log(msg.content));
await chat.send('Hello, I need help!');
\`\`\`
#### React
\`\`\`tsx
import { AgentProvider, useChat, useVoice } from '@agent-platform/web-sdk/react';

function App() {
  return (
    <AgentProvider
      projectId="your-project-id"
      apiKey="pk_your-public-key"
      endpoint="https://api.ablplatform.com"
    >
      <ChatWidget />
    </AgentProvider>
  );
}

function ChatWidget() {
  const { messages, isTyping, sendMessage, isConnected } = useChat();

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong> {msg.content}
        </div>
      ))}
      {isTyping && <div>Agent is typing...</div>}
      <button onClick={() => sendMessage('Hello!')} disabled={!isConnected}>
        Send
      </button>
    </div>
  );
}
\`\`\`
#### Web component
\`\`\`html
<script src="https://api.ablplatform.com/sdk/agent-widget.js"></script>

<agent-widget project-id="your-project-id" api-key="pk_your-public-key" mode="chat"></agent-widget>
\`\`\`
---
### AgentSDK
The main SDK class. Creates and manages connections, chat clients, and voice clients.
#### Constructor
\`\`\`typescript
new AgentSDK(config: SDKConfig)
\`\`\`
##### SDKConfig
| Property    | Type    | Required | Default     | Description                        |
| ----------- | ------- | -------- | ----------- | ---------------------------------- |
| \`projectId\` | string  | Yes      | --          | Project ID to connect to           |
| \`apiKey\`    | string  | Yes      | --          | Public API key (starts with \`pk_\`) |
| \`endpoint\`  | string  | No       | Same origin | Platform base URL                  |
| \`debug\`     | boolean | No       | \`false\`     | Enable debug logging to console    |
#### Methods
| Method           | Returns         | Description                                           |
| ---------------- | --------------- | ----------------------------------------------------- | -------------------------- |
| \`connect()\`      | \`Promise<void>\` | Establish WebSocket connection to the platform        |
| \`disconnect()\`   | \`void\`          | Close the connection and clean up resources           |
| \`chat()\`         | \`ChatClient\`    | Get the chat client instance (created on first call)  |
| \`voice()\`        | \`VoiceClient\`   | Get the voice client instance (created on first call) |
| \`isConnected()\`  | \`boolean\`       | Check if the SDK is connected                         |
| \`getSessionId()\` | \`string         | null\`                                                 | Get the current session ID |
#### Static methods
| Method                  | Returns    | Description                                                    |
| ----------------------- | ---------- | -------------------------------------------------------------- |
| \`AgentSDK.init(config)\` | \`AgentSDK\` | Create and store an SDK instance globally (for web components) |
#### Events
| Event          | Payload                 | Description                      |
| -------------- | ----------------------- | -------------------------------- |
| \`connected\`    | \`void\`                  | WebSocket connection established |
| \`disconnected\` | \`void\`                  | WebSocket connection closed      |
| \`error\`        | \`{ error: Error }\`      | Connection or runtime error      |
| \`sessionStart\` | \`{ sessionId: string }\` | New session started              |
| \`sessionEnd\`   | \`void\`                  | Session ended                    |
\`\`\`typescript
sdk.on('connected', () => {
  console.log('Connected to platform');
});

sdk.on('error', ({ error }) => {
  console.error('SDK error:', error.message);
});

sdk.on('sessionStart', ({ sessionId }) => {
  console.log('Session started:', sessionId);
});
\`\`\`
---
### ChatClient
Handles text messaging with streaming support. Obtained via \`sdk.chat()\`.
#### Methods
| Method                   | Returns           | Description                                         |
| ------------------------ | ----------------- | --------------------------------------------------- |
| \`send(text, options?)\`   | \`Promise<string>\` | Send a message. Returns the message ID              |
| \`uploadAttachment(file)\` | \`Promise<string>\` | Upload a file attachment. Returns the attachment ID |
| \`getMessages()\`          | \`Message[]\`       | Get all messages in the conversation                |
| \`getIsTyping()\`          | \`boolean\`         | Check if the agent is currently responding          |
| \`clearMessages()\`        | \`void\`            | Clear the local message history                     |
#### send() options
\`\`\`typescript
interface SendMessageOptions {
  /** Pre-uploaded attachment IDs to include with the message */
  attachmentIds?: string[];
  /** Optional per-message metadata for the current turn only */
  metadata?: Record<string, unknown>;
}
\`\`\`
##### Example: send with attachments
\`\`\`typescript
const chat = sdk.chat();

// Upload a file first
const attachmentId = await chat.uploadAttachment(fileInput.files[0]);

// Send message with attachment
await chat.send('Please analyze this document', {
  attachmentIds: [attachmentId],
});
\`\`\`
##### Example: send with per-message metadata
\`\`\`typescript
await chat.send('Look up this account', {
  metadata: {
    accountId: 'acct_123',
    context: { tier: 'gold' },
  },
});
\`\`\`
- Per-message metadata is validated server-side and is available only for that turn.
#### Events
| Event                | Payload                                      | Description                              |
| -------------------- | -------------------------------------------- | ---------------------------------------- |
| \`message\`            | \`Message\`                                    | New message received (user or assistant) |
| \`messageChunk\`       | \`{ messageId: string, chunk: string }\`       | Streaming text chunk from assistant      |
| \`typing\`             | \`{ isTyping: boolean }\`                      | Agent typing indicator changed           |
| \`messageSent\`        | \`{ messageId: string }\`                      | User message was sent                    |
| \`attachmentUploaded\` | \`{ attachmentId: string, filename: string }\` | File upload completed                    |
| \`attachmentError\`    | \`{ filename: string, error: string }\`        | File upload failed                       |
| \`error\`              | \`{ error: Error }\`                           | Chat error                               |
\`\`\`typescript
const chat = sdk.chat();

chat.on('message', (msg) => {
  if (msg.role === 'assistant') {
    console.log('Agent:', msg.content);
    if (msg.richContent?.markdown) {
      renderMarkdown(msg.richContent.markdown);
    }
    if (msg.actions) {
      renderActions(msg.actions);
    }
  }
});

chat.on('messageChunk', ({ messageId, chunk }) => {
  appendToMessage(messageId, chunk);
});

chat.on('typing', ({ isTyping }) => {
  showTypingIndicator(isTyping);
});
\`\`\`
#### Message type
\`\`\`typescript
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  richContent?: RichContent;
  actions?: ActionSet;
  attachments?: AttachmentRef[];
}
\`\`\`
#### RichContent type
Multi-format content variants delivered alongside the plain text response:
\`\`\`typescript
interface RichContent {
  markdown?: string;
  adaptive_card?: string;
  html?: string;
  slack?: string;
  ag_ui?: string;
  whatsapp?: string;
}
\`\`\`
#### ActionSet type
Interactive action elements the agent sends for user input:
\`\`\`typescript
interface ActionSet {
  elements: ActionElement[];
  submit_label?: string;
  submit_id?: string;
}

interface ActionElement {
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
\`\`\`
#### AttachmentRef type
\`\`\`typescript
interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  category: 'image' | 'document' | 'audio' | 'video';
}
\`\`\`
---
### VoiceClient
- Handles voice interactions via WebSocket audio pipeline with optional WebRTC.
The voice client supports two modes:
- **Pipeline mode**: Client-side VAD (Voice Activity Detection) captures PCM16 audio, sends it via WebSocket for server-side STT/LLM/TTS processing, and plays back MP3 audio responses.
- **Realtime mode**: Native audio I/O via realtime LLM providers with PCM16 streaming.
#### Methods
| Method         | Returns         | Description                                              |
| -------------- | --------------- | -------------------------------------------------------- |
| \`start()\`      | \`Promise<void>\` | Start voice interaction (requests microphone permission) |
| \`stop()\`       | \`void\`          | Stop voice interaction and release audio resources       |
| \`toggleMute()\` | \`boolean\`       | Toggle microphone mute. Returns the new mute state       |`;
