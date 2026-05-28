# Genesys Bot Connector Channel Design

## Overview

Implement Genesys Bot Connector as a synchronous webhook channel in ABL platform, based on the existing koreserver implementation. Genesys CX sends customer messages to our webhook and holds the HTTP connection open, expecting the bot's response in the same request.

## Architecture

Genesys Bot Connector is a **synchronous webhook** channel — identical pattern to VXML. It uses `ingress: 'sync_webhook'` / `delivery: 'sync_response'` with its own dedicated route handler (not the generic async webhook pipeline).

### Request Flow

```
Genesys POST /api/v1/channels/genesys/hooks/:streamId
  Authorization: Bearer <client_secret>
  Body: { genesysConversationId, inputMessage: { type, text } }
    |
    v
  1. Extract bearer token from Authorization header
  2. Resolve connection by streamId (externalIdentifier)
  3. Verify bearer token matches stored client_secret
  4. Parse incoming message (Text or Structured type)
  5. Resolve/create session (genesysConversationId -> runtimeSessionId)
  6. Acquire session lock
  7. Execute message through runtime (synchronous)
  8. Build Genesys response format
  9. Return JSON response
  10. Release session lock
```

## Manifest Entry

```typescript
genesys: {
  displayName: 'Genesys',
  ingress: 'sync_webhook',
  delivery: 'sync_response',
  authMode: 'token',
  responseFormat: 'text',
  supportsRichOutput: true,
  supportsThreading: false,
  supportsMedia: false,
  supportsStreaming: false,
  isConnectionEligible: true,
  requiredCredentials: ['client_secret'],
  webhookPathPattern: '/api/v1/channels/genesys/hooks/:streamId',
  isVoice: false,
  supportsTypingIndicator: false,
}
```

## Incoming Message Format

From Genesys (koreserver format):

```json
{
  "genesysConversationId": "conv-123",
  "inputMessage": {
    "type": "Text",
    "text": "Hello"
  },
  "channelSource": "genesys"
}
```

Structured (button callback):

```json
{
  "genesysConversationId": "conv-123",
  "inputMessage": {
    "type": "Structured",
    "buttonResponse": {
      "payload": "option_1"
    }
  }
}
```

Normalized to:

```typescript
{
  externalMessageId: `${genesysConversationId}-${Date.now()}`,
  externalSessionKey: `genesys:${genesysConversationId}`,
  text: extractedText,
  metadata: { genesysConversationId, channelSource, originalMessage },
  timestamp: new Date(),
  actionEvent: isStructured ? { type: 'postback', value: buttonPayload } : undefined,
}
```

## Response Format

Matches koreserver exactly:

```json
{
  "replymessages": [{ "type": "Text", "text": "Hello! How can I help?" }],
  "botState": "MOREDATA",
  "intent": "Default Kore VA Intent",
  "endOfTask": false
}
```

Quick replies (from ActionSetIR):

```json
{
  "replymessages": [
    {
      "type": "Structured",
      "text": "Choose an option:",
      "content": [
        { "contentType": "QuickReply", "quickReply": { "text": "Option 1", "payload": "opt1" } },
        { "contentType": "QuickReply", "quickReply": { "text": "Option 2", "payload": "opt2" } }
      ]
    }
  ],
  "botState": "MOREDATA",
  "intent": "Default Kore VA Intent",
  "endOfTask": false
}
```

## Authentication

Bearer token verification (same as koreserver):

- Genesys sends `Authorization: Bearer <token>` header
- We extract the token and compare against `client_secret` stored in encrypted connection credentials
- Timing-safe comparison via `tokensMatch()` from `inbound-auth.ts`

## Files to Create/Modify

| File                                                    | Action                                    |
| ------------------------------------------------------- | ----------------------------------------- |
| `apps/runtime/src/channels/types.ts`                    | Add `'genesys'` to ChannelType union      |
| `apps/runtime/src/channels/manifest.ts`                 | Add genesys manifest entry                |
| `apps/runtime/src/channels/adapters/genesys-adapter.ts` | New adapter                               |
| `apps/runtime/src/routes/channel-genesys.ts`            | New sync route (based on channel-vxml.ts) |
| `apps/runtime/src/channels/registry.ts`                 | Register GenesysAdapter                   |
| `apps/runtime/src/server.ts`                            | Mount route at `/api/v1/channels/genesys` |

## Out of Scope (Future)

- Agent transfer (`botState: "COMPLETE"` + agent intent)
- Bot schema publication (OAuth API to push intents to Genesys)
- WebMessaging API support
- File/attachment handling
- Genesys metadata passthrough for agent handoff
