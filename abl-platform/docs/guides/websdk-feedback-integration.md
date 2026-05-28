# WebSDK In-Chat Feedback Integration Guide

This guide describes the standard way to collect user feedback from a customer
web chat experience built with `@agent-platform/web-sdk`. It is intended for
delivery teams embedding the WebSDK in customer applications.

Use the WebSDK feedback contract for all new in-chat feedback. Do not route
feedback as a normal chat message and do not trigger a dedicated feedback agent
or tool just to store ratings.

## Recommended Flow

1. Bootstrap the WebSDK with `AgentProvider`.
2. Enable the SDK feedback UI or render every final assistant message with a
   thumbs-up / thumbs-down control.
3. When the user rates a message, call `chat.submitFeedback(...)`.
4. The SDK sends a `feedback.submit` WebSocket frame to runtime.
5. Runtime validates the target message against the active session, persists the
   feedback, and returns a `feedback.ack`.
6. The SDK resolves the promise with `{ feedbackId }` or rejects with a
   structured error code.

The assistant does not see this as a user turn. Feedback capture short-circuits
at runtime and is stored in the platform feedback pipeline.

## Built-In SDK Feedback UI

For teams using the WebSDK-rendered chat UI, feedback buttons are configurable
at the SDK surface. The default is disabled, so existing integrations do not
render feedback controls until the embedding application opts in.

React:

```tsx
import { AgentProvider, ChatWidget } from '@agent-platform/web-sdk/react';

export function App({ config }: { config: RuntimeConfig }) {
  return (
    <AgentProvider
      endpoint={config.endpoint}
      projectId={config.projectId}
      apiKey={config.apiKey}
      channelId={config.channelId}
    >
      <ChatWidget enableFeedback />
    </AgentProvider>
  );
}
```

Web components:

```html
<agent-chat
  endpoint="https://runtime.example.com"
  project-id="your_project_id"
  api-key="pk_your_public_key"
  enable-feedback="true"
></agent-chat>

<agent-widget
  endpoint="https://runtime.example.com"
  project-id="your_project_id"
  api-key="pk_your_public_key"
  mode="unified"
  enable-feedback="true"
></agent-widget>
```

Disable by omitting the flag, passing `enableFeedback={false}`, or setting
`enable-feedback="false"`.

When enabled, the SDK:

- renders thumbs-up and thumbs-down controls under final assistant messages,
- submits thumbs-up immediately,
- opens an optional comment box for thumbs-down,
- calls `chat.submitFeedback(...)` with the active assistant `messageId`,
- shows pending, success, and mapped failure states, and
- skips the per-message controls when the message already includes a rich
  `feedback` template so the UI is not duplicated.

Custom chat UIs can still implement their own controls with the same
`chat.submitFeedback(...)` contract below.

## Runtime And SDK Contract

Call `chat.submitFeedback` from the active `ChatClient`:

```ts
await chat.submitFeedback({
  messageId: assistantMessage.id,
  ratingType: 'thumbs',
  ratingValue: 1,
});
```

Payload fields:

| Field            | Required | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| `messageId`      | Yes      | Final persisted assistant message ID being rated      |
| `ratingType`     | Yes      | `thumbs`, `star`, or `text`                           |
| `ratingValue`    | Yes      | `0`/`1` for thumbs, `1..5` for star, `0` for text     |
| `feedbackText`   | No       | Optional comment, runtime cap is 5000 chars           |
| `actionRenderId` | No       | Correlation ID for rich-template rendered action sets |
| `timeoutMs`      | No       | SDK-side ack timeout; defaults to 10 seconds          |

Return value:

```ts
const { feedbackId } = await chat.submitFeedback(input);
```

Common rejection codes:

| Code                 | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `NOT_CONNECTED`      | SDK transport is not connected                                              |
| `FEEDBACK_PENDING`   | Same `messageId` / `actionRenderId` is in flight                            |
| `FEEDBACK_TIMEOUT`   | Runtime did not ack before timeout                                          |
| `INVALID_INPUT`      | Bad rating shape or oversized comment                                       |
| `INVALID_TARGET`     | Message does not exist in the active session or is not an assistant message |
| `DUPLICATE_FEEDBACK` | Feedback already exists for this session/message/user tuple                 |
| `STORAGE_FAILURE`    | Runtime could not persist feedback                                          |

## Raw Wire Contracts For Debugging

When debugging in a browser WebSocket inspector, feedback is sent as a raw JSON
message over the already-authenticated SDK WebSocket. It is not sent as a chat
turn.

Client to runtime:

```ts
type FeedbackSubmitMessage = {
  type: 'feedback.submit';
  messageId: string;
  ratingType: 'thumbs' | 'star' | 'text';
  ratingValue: number;
  feedbackText?: string;
  actionRenderId?: string;
};
```

Thumbs-up example:

```json
{
  "type": "feedback.submit",
  "messageId": "msg_123",
  "ratingType": "thumbs",
  "ratingValue": 1
}
```

Thumbs-down with comment:

```json
{
  "type": "feedback.submit",
  "messageId": "msg_123",
  "ratingType": "thumbs",
  "ratingValue": 0,
  "feedbackText": "The recommendation did not match the customer's plan."
}
```

Star rating example:

```json
{
  "type": "feedback.submit",
  "messageId": "msg_123",
  "ratingType": "star",
  "ratingValue": 4
}
```

Text-only feedback example:

```json
{
  "type": "feedback.submit",
  "messageId": "msg_123",
  "ratingType": "text",
  "ratingValue": 0,
  "feedbackText": "The answer was missing pricing details."
}
```

Runtime validation rules:

| Field            | Rule                                           |
| ---------------- | ---------------------------------------------- |
| `messageId`      | Required string, max 128 chars                 |
| `ratingType`     | `thumbs`, `star`, or `text`                    |
| `ratingValue`    | `0` or `1` for thumbs, integer `1..5` for star |
| `feedbackText`   | Optional for thumbs/star, required for text    |
| `feedbackText`   | Max 5000 chars                                 |
| `actionRenderId` | Optional string, max 256 chars                 |

Runtime to client:

```ts
type FeedbackAckMessage = {
  type: 'feedback.ack';
  messageId: string;
  success: boolean;
  feedbackId?: string;
  actionRenderId?: string;
  error?: {
    code: string;
    message: string;
  };
};
```

Success ack:

```json
{
  "type": "feedback.ack",
  "messageId": "msg_123",
  "success": true,
  "feedbackId": "fb_456"
}
```

Failure ack:

```json
{
  "type": "feedback.ack",
  "messageId": "msg_123",
  "success": false,
  "error": {
    "code": "INVALID_TARGET",
    "message": "Target message not found in this session"
  }
}
```

For rich-template fallback paths, runtime also accepts a generic action submit
where `actionId` is `feedback`. This is normalized into the same feedback
service path:

```json
{
  "type": "action_submit",
  "actionId": "feedback",
  "value": "down",
  "formData": {
    "messageId": "msg_123",
    "feedbackText": "The answer was not specific enough."
  },
  "renderId": "render_abc"
}
```

The `value` mapping for this fallback is:

| `value`     | Normalized rating     |
| ----------- | --------------------- |
| `up`        | `thumbs`, value `1`   |
| `down`      | `thumbs`, value `0`   |
| `"1"`-`"5"` | `star`, numeric value |

## React Provider Setup

A common production pattern is to fetch runtime configuration from a server-side
config endpoint, then mount `AgentProvider` with the public SDK key:

```tsx
import { AgentProvider } from '@agent-platform/web-sdk/react';

export function App({ config }: { config: RuntimeConfig }) {
  return (
    <AgentProvider
      endpoint={config.endpoint}
      projectId={config.projectId}
      apiKey={config.apiKey}
      channelId={config.channelId}
      debug={true}
    >
      <Chat />
    </AgentProvider>
  );
}
```

The public `pk_...` key is browser-safe, but should still be served from backend
configuration so it can be rotated without rebuilding the frontend. Restrict it
by allowed origins in Studio.

## Custom Chat UI Pattern

In a custom React chat surface, read the active chat client from `useAgent()` and
messages from `useChat()`:

```tsx
import { useAgent, useChat } from '@agent-platform/web-sdk/react';

function Chat() {
  const { chat, isConnected } = useAgent();
  const { messages } = useChat();

  const submitFeedback = async (messageId: string, rating: 'up' | 'down', comment?: string) => {
    if (!chat) throw Object.assign(new Error('Not connected'), { code: 'NOT_CONNECTED' });

    return chat.submitFeedback({
      messageId,
      ratingType: 'thumbs',
      ratingValue: rating === 'up' ? 1 : 0,
      ...(comment?.trim() ? { feedbackText: comment.trim() } : {}),
    });
  };

  return (
    <>
      {messages
        .filter((message) => message.role === 'assistant')
        .map((message) => (
          <AssistantMessage
            key={message.id}
            message={message}
            feedbackDisabled={!isConnected || !chat}
            onFeedback={(rating, comment) => submitFeedback(message.id, rating, comment)}
          />
        ))}
    </>
  );
}
```

Important details:

- Use the final assistant message ID from `messages`, not a streaming placeholder.
- Disable controls while feedback is pending for that message.
- After success, keep the selected rating locked to avoid accidental duplicate
  submissions.
- For thumbs-up, submit immediately.
- For thumbs-down, open an optional comment box, then submit with or without the
  comment.
- A UI cap below the runtime cap is fine. For example, a customer UI can limit
  comments to 500 chars even though runtime accepts up to 5000.

## Recommended UI State Pattern

Track feedback state by assistant message ID:

```ts
type FeedbackState = {
  rating: 'up' | 'down';
  status: 'pending' | 'sent' | 'failed';
  comment?: string;
  feedbackId?: string;
  error?: string;
};

const [feedbackByMessageId, setFeedbackByMessageId] = useState<Record<string, FeedbackState>>({});
```

State transitions:

| User action       | UI state                                                  |
| ----------------- | --------------------------------------------------------- |
| Click thumbs-up   | Set `pending`, call `submitFeedback`, then mark `sent`    |
| Click thumbs-down | Set `pending`, show optional comment box                  |
| Send comment      | Call `submitFeedback` with `feedbackText`, then `sent`    |
| Skip comment      | Call `submitFeedback` without `feedbackText`, then `sent` |
| Failure           | Set `failed` and show a short mapped error message        |

The reference app maps SDK/runtime error codes to user-facing messages:

```ts
function formatFeedbackError(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code;
  switch (code) {
    case 'NOT_CONNECTED':
      return 'Reconnect to send feedback';
    case 'INVALID_TARGET':
      return "This message can't be rated yet";
    case 'DUPLICATE_FEEDBACK':
      return 'Already submitted';
    case 'INVALID_INPUT':
      return 'Comment too long';
    case 'STORAGE_FAILURE':
      return 'Server error - try again';
    case 'FEEDBACK_TIMEOUT':
      return 'Server did not respond';
    case 'FEEDBACK_PENDING':
      return 'Feedback in flight';
    default:
      return err instanceof Error ? err.message : 'Could not send feedback';
  }
}
```

## Rich Feedback Templates

If the agent emits a rich feedback template, the WebSDK renderer can submit
feedback through the same runtime contract.

Built-in WebSDK surfaces already thread this callback:

- React `<ChatWidget />`
- React `<RichMessage />`
- Vanilla `ChatWidget`
- Vanilla `UnifiedWidget`

If you render `<RichContent />` yourself, bind the message ID in the owning
component and pass a `submitFeedback` callback:

```tsx
<RichContent
  message={message}
  onAction={handleAction}
  submitFeedback={(input) =>
    chat.submitFeedback({
      messageId: message.id,
      ...input,
      ...(message.actions?.renderId ? { actionRenderId: message.actions.renderId } : {}),
    })
  }
/>
```

`RichContent` intentionally stays pure. It does not call hooks or know about the
SDK client; the owner binds `messageId` and `actionRenderId`.

## What Runtime Does

For `feedback.submit`, runtime:

- validates the input shape with the feedback Zod schema,
- uses the WebSocket session context for tenant, project, session, user, and
  channel,
- verifies the target message belongs to the same tenant/project/session and has
  role `assistant`,
- deduplicates by `(tenantId, sessionId, messageId, userId)`,
- writes to ClickHouse `abl_platform.feedback`,
- emits a PII-minimized `feedback.submitted` event,
- broadcasts a PII-minimized trace event, and
- returns `feedback.ack`.

Success ack:

```json
{
  "type": "feedback.ack",
  "messageId": "msg_123",
  "success": true,
  "feedbackId": "fb_456"
}
```

Failure ack:

```json
{
  "type": "feedback.ack",
  "messageId": "msg_123",
  "success": false,
  "error": {
    "code": "INVALID_TARGET",
    "message": "Target message not found in this session"
  }
}
```

## Where Feedback Appears

Collected feedback is available in Studio under the project-level Insights
surface:

1. Open the customer project in Studio.
2. In the project sidebar, expand **Insights**.
3. Open **Feedback**.

The Feedback page shows recent in-chat feedback captured by the runtime. It
includes timestamp, agent, channel, rating, optional comment, session ID, and a
detail drawer for the selected row.

Available filters:

| Filter       | Description                     |
| ------------ | ------------------------------- |
| Date range   | Last 7, 30, or 90 days          |
| Rating type  | All, thumbs, star, or text-only |
| Comment      | Any, has comment, or no comment |
| Agent name   | Exact agent-name filter         |
| Channel      | Exact channel filter            |
| Session ID   | Supported by the backing API    |
| Message ID   | Supported by the backing API    |
| Rating value | Supported by the backing API    |

The Studio page calls the internal Studio proxy:

```http
GET /api/runtime/feedback?projectId=<projectId>&dateRange/filter params...
```

That proxy forwards to the runtime project-scoped read API:

```http
GET /api/projects/:projectId/feedback
```

Supported runtime query parameters:

| Parameter     | Description                                       |
| ------------- | ------------------------------------------------- |
| `from` / `to` | ISO datetime bounds; defaults to the last 30 days |
| `limit`       | Page size, default 50, max 200                    |
| `cursor`      | Cursor returned from the previous page            |
| `agentName`   | Filter by agent name                              |
| `channel`     | Filter by channel                                 |
| `ratingType`  | `thumbs`, `star`, or `text`                       |
| `ratingValue` | Numeric rating value                              |
| `sessionId`   | Filter by session ID                              |
| `messageId`   | Filter by assistant message ID                    |
| `hasText`     | `true` for comments, `false` for no comment       |

Response shape:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "feedbackId": "fb_456",
        "timestamp": "2026-05-18 10:15:30.123",
        "sessionId": "session_123",
        "messageId": "msg_123",
        "agentName": "assistant",
        "channel": "web",
        "ratingType": "thumbs",
        "ratingValue": 1,
        "feedbackText": "",
        "hasText": false,
        "source": "websocket",
        "ingress": "feedback_submit"
      }
    ],
    "nextCursor": null
  }
}
```

The runtime read API is protected by project analytics access. Cross-tenant or
cross-project access is concealed. The backing store is ClickHouse table
`abl_platform.feedback`; user-facing access should normally go through Studio or
the runtime API instead of direct database queries.

## Verification Checklist

Before shipping a WebSDK feedback integration:

- Send a normal chat turn and wait for a final assistant message.
- Click thumbs-up on that final assistant message.
- Confirm `chat.submitFeedback(...)` resolves with a non-empty `feedbackId`.
- Click thumbs-down on another assistant message, enter a comment, and confirm
  success.
- Submit duplicate feedback on the same assistant message and verify the UI
  handles `DUPLICATE_FEEDBACK`.
- Try submitting while disconnected and verify the UI handles `NOT_CONNECTED`.
- Confirm feedback is not visible to the assistant as a user turn.
