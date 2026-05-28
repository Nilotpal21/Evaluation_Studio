# ABL Platform — Agent Transfer Reference

> Step-by-step reference for how Koreserver implements Agent Transfer functionality
> and the bidirectional communication between Koreserver (ABL Runtime) and
> AgentAssist (Kore SmartAssist).

---

## Architecture Overview

The Agent Transfer system hands off conversations from AI agents (bots) running on ABL Runtime to live human agents on Kore SmartAssist (AgentAssist). Communication is HTTP-based in both directions:

- **Outbound** (Koreserver → SmartAssist): HTTP POST via `undici` connection pool with circuit breaker
- **Inbound** (SmartAssist → Koreserver): HTTP POST webhook with HMAC signature verification
- **Session state**: Redis HASH with TTL-based expiration and Lua atomic operations

```
┌──────────────┐                                    ┌──────────────────┐
│   End User   │                                    │  Kore SmartAssist │
│ (Chat/Voice/ │                                    │  (AgentAssist)    │
│  Slack/WA)   │                                    │                   │
└──────┬───────┘                                    └────────┬──────────┘
       │                                                     │
       ▼                                                     │
┌──────────────────────────────────────────────────┐         │
│           ABL Runtime (Koreserver)                │         │
│                                                  │         │
│  TransferToolExecutor                            │         │
│    └→ KoreAdapter.execute()                      │         │
│         └→ SmartAssistClient                     │         │
│              .checkBusinessHours() ─────────────────────►  │
│              .checkAgentAvailability() ──────────────────►  │
│              .initTransfer() ────────────────────────────►  │
│              POST /api/v1/conversations           │         │
│                                                  │         │
│  User messages:                                  │         │
│    KoreAdapter.sendUserMessage()                 │         │
│      └→ SmartAssistClient.sendEvent() ──────────────────►  │
│           POST /api/v1/internal/events/handle    │         │
│                                                  │         │
│  Webhook receiver:                               │         │
│    POST /api/v1/agent-transfer/webhooks/kore ◄──────────── │
│      └→ HMAC signature verification              │         │
│      └→ KoreEventHandler (XO → ABL mapping)      │         │
│      └→ MessageBridge.routeAgentEvent()          │         │
│           └→ WebSocket / Channel / Voice         │         │
│                                                  │         │
│  Session Store (Redis):                          │         │
│    agent_transfer:{tenant}:{contact}:{chan}       │         │
│    at_by_provider:kore:{tenant}:{sessionId}      │         │
└──────────────────────────────────────────────────┘         │
       │                                                     │
       ▼                                                     │
┌──────┴───────┐                                             │
│   End User   │                                             │
│  (receives   │                                             │
│   agent msg) │                                             │
└──────────────┘                                             │
```

---

## Step 1: Boot & Initialization

**File:** `apps/runtime/src/services/agent-transfer/index.ts`

At runtime startup, the agent transfer subsystem initializes. Called from `apps/runtime/src/server.ts`.

### Initialization sequence:

1. Creates a **Redis-backed `TransferSessionStore`** for session tracking
   - Optional: `TenantScopedSessionEncryptor` for field-level encryption of sensitive session data
2. Creates an **`AdapterRegistry`** (name → adapter instance map)
3. Creates a **shared session store handle** (adapter-facing interface with `create`, `get`, `end`, `extendTTL`, `getByProvider`)
4. Creates and registers the **`KoreAdapter`**:
   ```
   new KoreAdapter(smartassistConfig, storeHandle)
   koreAdapter.initialize({ name: 'kore', auth: { type: 'internal_key', apiKey }, options: { baseUrl } })
   adapterRegistry.register('kore', koreAdapter)
   ```
5. Wires the **`AgentTransferMessageBridge`** — routes agent events back to users:
   ```
   koreAdapter.onAgentMessage(handler)  → bridge.routeAgentEvent()
   koreAdapter.onSessionEvent(handler)  → bridge.routeAgentEvent()
   ```
6. Starts **`SessionRecoveryService`** — recovers sessions after pod crashes by scanning `at_pod:{hostname}` for orphaned sessions
7. Wires **TraceStore adapter** for observability (emits trace events to platform TraceStore)
8. Creates **BullMQ session timeout queue** — handles TTL-based session expiration
9. Creates **BullMQ durable event queue** — ensures agent events are not lost during delivery failures
10. Subscribes to **Redis keyspace expired events** — when session hashes expire (TTL), removes them from `at_active_sessions` set

### Config source:

**File:** `apps/runtime/src/config/agent-transfer.ts`

| Environment Variable                      | Description                          | Default |
| ----------------------------------------- | ------------------------------------ | ------- |
| `AGENT_TRANSFER_ENABLED`                  | Enable the subsystem                 | `false` |
| `SMARTASSIST_API_URL` / `SMARTASSIST_URL` | SmartAssist base URL                 | —       |
| `SMARTASSIST_API_KEY`                     | API key for authentication           | —       |
| `SMARTASSIST_WEBHOOK_SECRET`              | HMAC secret for webhook verification | —       |
| `SMARTASSIST_TIMEOUT_MS`                  | HTTP request timeout                 | `30000` |
| `VOICE_GATEWAY_TYPE`                      | Voice gateway provider               | —       |

---

## Step 2: Transfer Initiation (Koreserver → SmartAssist)

**Trigger:** The LLM calls the `transfer_to_agent` tool during a conversation.

### 2a. Tool routing

**File:** `apps/runtime/src/services/execution/transfer-tool-executor.ts`

The `TransferToolExecutor` receives the tool call and routes it:

```
LLM output: { tool: "transfer_to_agent", args: { queue: "sales", skills: ["billing"] } }
  → TransferToolExecutor.execute()
    → Applies rate limiting on transfer_to_agent calls
    → KoreAdapter.execute(payload)
```

Recognized tool names: `transfer_to_agent`, `check_hours`, `check_availability`, `set_queue`, `ivr_menu`, `ivr_digit_input`, `call_transfer`, `deflect_to_chat`

### 2b. Pre-checks

**File:** `packages/agent-transfer/src/adapters/kore/index.ts` — `runPreChecks()`

Before initiating the transfer, `KoreAdapter` runs pre-checks via `SmartAssistClient`:

| Pre-check          | SmartAssist API                                        | When                             |
| ------------------ | ------------------------------------------------------ | -------------------------------- |
| Business Hours     | `POST /api/v1/internal/flows/nodes/businessHours`      | If `metadata.hoursId` is present |
| Agent Availability | `POST /api/v1/internal/flows/nodes/agentsAvailability` | If no `queue` specified          |
| Queue Validation   | `POST /api/v1/internal/flows/nodes/queueAvailability`  | If `queue` is specified          |

If any pre-check fails, the transfer returns immediately with status:

- `outside_hours` — business hours check failed
- `no_agents` — no agents available
- `queue_invalid` — queue doesn't exist

### 2c. Transfer API call

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts` — `initTransfer()`

```
POST {SMARTASSIST_URL}/api/v1/conversations

Headers:
  Content-Type: application/json
  x-api-key: {SMARTASSIST_API_KEY}

Body (KoreTransferPayload):
{
  // Identity (mapped by SmartAssistClient.mapIdentity())
  "botId": "<agentId>",              // ABL agentId → XO botId
  "userId": "<contactId>",           // ABL contactId → XO userId
  "orgId": "<tenantId>",             // ABL tenantId → XO orgId
  "accountId": "<tenantId>",         // ABL tenantId → XO accountId

  // Routing
  "queue": "sales",
  "skills": ["billing", "spanish"],
  "priority": 5,                     // clamped 0-10, default 5
  "language": "en",

  // Context
  "conversationHistory": [
    { "role": "user", "content": "I need help with billing", "timestamp": "..." },
    { "role": "agent", "content": "Let me transfer you...", "timestamp": "..." }
  ],
  "metadata": { ... },
  "customData": { ... },

  // XO-specific fields
  "source": "bot",
  "conversationType": "chat",
  "skillsIds": ["skill-uuid-1"],
  "automationBotId": "<sourceAgentId>",
  "metaInfo": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phoneNumber": "+1234567890",
    "agentTransferConfig": {
      "automationBotId": "<bot-id>",
      "lastIntentName": "TransferToAgent",
      "dialog_tone": [{ "tone_name": "frustrated", "level": 0.7 }]
    }
  },
  "sentimentTone": { "sentiment": "negative", "emoji": "...", "strength": 0.7 },
  "surveyRequired": "YES"            // "YES" | "NO" | "ASK" | "REQUESTED"
}

Response:
{
  "conversationId": "<smartassist-conversation-id>"
}
```

### 2d. Session creation in Redis

After successful `initTransfer()`, `KoreAdapter` creates a session:

```typescript
sessionStore.create({
  tenantId,
  contactId,
  channel: 'chat',
  provider: 'kore',
  providerSessionId: '<smartassist-conversation-id>',
  agentId,
  metadata: { postAgentAction: 'end', sourceAgentId, parentAgentId },
});
```

Redis keys created atomically (Lua script):

- `agent_transfer:{tenantId}:{contactId}:chat` — HASH (session data)
- `at_by_provider:kore:{tenantId}:<conversationId>` — STRING (reverse lookup)
- `at_active_sessions` — SADD (active set)
- `at_pod:{hostname}` — SADD (pod ownership)

---

## Step 3: User Messages During Transfer (Koreserver → SmartAssist)

Once a transfer session is active, user messages are forwarded to the live agent.

**File:** `packages/agent-transfer/src/adapters/kore/index.ts` — `sendUserMessage()`

```
POST {SMARTASSIST_URL}/api/v1/internal/events/handle/?sid={sessionKey}&cId={conversationId}

Headers:
  Content-Type: application/json
  x-api-key: {SMARTASSIST_API_KEY}

Body (KoreUserEvent):
{
  "eventName": "start_kore_agent_chat_message_for_agent",
  "payload": {
    "conversationId": "<smartassist-conversation-id>",
    "author": { "id": "<contactId>", "type": "USER" },
    "type": "text",
    "value": "I have a question about my last invoice",
    "event": "user_message",
    "attachments": [
      { "url": "https://...", "name": "invoice.pdf", "mimeType": "application/pdf", "size": 12345 }
    ]
  },
  "queryFields": {
    "sid": "<session-key>",
    "cId": "<smartassist-conversation-id>"
  }
}
```

### Control events

| User Action        | `eventName`                       | `event` field       |
| ------------------ | --------------------------------- | ------------------- |
| Typing             | `start_control_message_for_agent` | `typing`            |
| Stopped typing     | `start_control_message_for_agent` | `stop_typing`       |
| Close conversation | `close_conversation`              | `close_agent_chat`  |
| Message read       | `start_control_message_for_agent` | `message_read`      |
| Message delivered  | `start_control_message_for_agent` | `message_delivered` |

---

## Step 4: Agent Responds — Webhook (SmartAssist → Koreserver)

When a live agent on SmartAssist sends a message or performs an action, SmartAssist posts an event to the ABL Runtime webhook.

**File:** `apps/runtime/src/routes/agent-transfer-webhooks.ts`

### Webhook endpoint

```
POST /api/v1/agent-transfer/webhooks/kore
```

### Request from SmartAssist

```
POST /api/v1/agent-transfer/webhooks/kore

Headers:
  Content-Type: application/json
  x-kore-signature: <HMAC-SHA256 signature>
  x-kore-timestamp: <unix timestamp>

Body (XOEvent):
{
  "type": "agent_message",
  "conversationId": "<smartassist-conversation-id>",
  "botId": "<bot-id>",
  "userId": "<user-id>",
  "orgId": "<tenant-id>",
  "message": "Hello, how can I help you?",
  "agentInfo": {
    "agentId": "<agent-id>",
    "name": "John Smith",
    "email": "john@example.com"
  },
  "data": { "attachments": [...] },
  "timestamp": "2026-03-25T10:30:00Z"
}
```

### Processing pipeline (6 steps)

```
1. Check subsystem initialized
     └─ 503 if not initialized

2. Validate provider is registered in AdapterRegistry
     └─ 404 if unknown provider

3. Verify webhook signature (if SMARTASSIST_WEBHOOK_SECRET configured)
     ├─ HMAC-SHA256 using x-kore-signature + x-kore-timestamp headers
     ├─ Redis-backed nonce store for replay attack prevention
     └─ 401 if signature invalid

4. Parse XOEvent from request body
     ├─ Validate: type + conversationId required
     ├─ Validate: orgId required (tenant isolation)
     └─ 400 if malformed

5. Look up transfer session in Redis
     ├─ sessionStore.getByProvider('kore', orgId, conversationId)
     ├─ Validate session.tenantId === event.orgId (tenant isolation)
     └─ 404 if not found or tenant mismatch (no existence leaking)

6. Delegate to adapter
     └─ adapter.handleInboundEvent(xoEvent, tenantId)
```

---

## Step 5: Event Mapping (XO Events → ABL Events)

**File:** `packages/agent-transfer/src/adapters/kore/event-handler.ts`

The `KoreEventHandler` translates SmartAssist XO event types to internal ABL event types via the `XO_EVENT_MAP`:

| XO Event (from SmartAssist) | ABL Event (internal)      | Description                        |
| --------------------------- | ------------------------- | ---------------------------------- |
| `agent_message`             | `agent:message`           | Agent sent a text message          |
| `agent_accepted`            | `agent:connected`         | Agent accepted the conversation    |
| `agent_joined`              | `agent:joined`            | Agent joined (multi-agent)         |
| `agent_transferred`         | `agent:connected`         | Transferred to another agent       |
| `conversation_queued`       | `agent:queued`            | Waiting in agent queue             |
| `queue_position_update`     | `agent:queued`            | Queue position changed             |
| `wait_time_update`          | `agent:queued`            | Estimated wait time updated        |
| `closed`                    | `agent:disconnected`      | Conversation closed                |
| `conversation_closed`       | `agent:disconnected`      | Conversation closed (alternate)    |
| `agent_disconnect`          | `agent:disconnected`      | Agent disconnected                 |
| `typing`                    | `agent:typing`            | Agent is typing                    |
| `stop_typing`               | `agent:typing_stop`       | Agent stopped typing               |
| `message_delivered`         | `agent:delivery_receipt`  | Message delivery confirmation      |
| `bot_message_delivered`     | `agent:delivery_receipt`  | Bot message delivery confirmation  |
| `user_message_delivered`    | `agent:delivery_receipt`  | User message delivery confirmation |
| `form_message`              | `agent:form`              | Agent sent a structured form       |
| `proactive_agentassist`     | `agent:assist_suggestion` | AgentAssist proactive suggestion   |

### Output: ABL AgentEvent

```typescript
{
  type: 'agent:message',                    // Mapped ABL event type
  sessionId: '<smartassist-conversation-id>',
  tenantId: '<tenant-id>',
  contactId: '<contact-id>',
  channel: 'chat',                          // 'chat' | 'voice' | 'email' | 'messaging' | 'campaign'
  timestamp: '2026-03-25T10:30:00Z',
  data: {
    message: 'Hello, how can I help you?',
    agentInfo: { agentId: '...', name: 'John Smith', email: '...' },
    attachments: [...],
    originalType: 'agent_message'            // Original XO event type preserved
  }
}
```

---

## Step 6: Message Delivery to End User

**File:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

After event mapping, the `AgentTransferMessageBridge` routes the agent's message to the end user.

### Delivery flow

```
KoreAdapter.handleInboundEvent()
  → fires onAgentMessage callbacks (registered during boot in Step 1)
  → boot handler resolves ABL session key from provider session
  → bridge.routeAgentEvent(ablSessionKey, agentEvent)
      → determines delivery channel
      → delivers to end user
```

### Delivery channels (priority order)

| Channel        | Mechanism                                 | Used For                   |
| -------------- | ----------------------------------------- | -------------------------- |
| WebSocket      | Direct WS push                            | Studio debug/test sessions |
| Chat/Messaging | Channel adapter (`deliverViaChatChannel`) | Slack, WhatsApp, etc.      |
| Voice          | Voice gateway (`deliverViaVoiceGateway`)  | Voice calls (TTS)          |

**WebSocket delivery** (Studio clients):

```json
{
  "type": "agent_transfer_event",
  "sessionId": "<abl-session-key>",
  "event": {
    "type": "agent:message",
    "data": { "message": "Hello, how can I help?", "agentInfo": { ... } },
    "timestamp": "2026-03-25T10:30:00Z"
  }
}
```

**Channel adapter delivery** (Slack, WhatsApp, etc.):

1. Resolves `channelType` and `connectionId` from event metadata
2. Gets the channel adapter from `ChannelRegistry`
3. Resolves the connection via `resolveConnectionById()`
4. For `agent:form` events: tries `adapter.transformOutput()` first, falls back to `renderFormAsText()`
5. Sends as `NormalizedOutgoingMessage` via `adapter.sendResponse()`
6. Delivers attachments as separate messages

**Voice delivery** (KoreVG/Jambonz):

1. Tries `VoiceGatewayRegistry` first (provider-agnostic)
2. Falls back to direct KoreVG session lookup
3. Calls `voiceSession.sendAgentMessage(text)` (TTS)

### WebSocket session registry

The bridge maintains an in-memory map (`sessionToWs`) with eviction:

- **Max entries:** 10,000
- **TTL:** 4 hours
- **Eviction:** Stale entries first, then oldest (force-evicted at 10% batch size)
- **Cleanup:** WS `close` event auto-removes the entry

---

## Step 7: Session End

Session termination can be triggered from either side.

### Agent closes (SmartAssist → Koreserver)

```
SmartAssist sends webhook: { type: "closed" | "conversation_closed" | "agent_disconnect" }
  → Webhook route (Step 4)
  → KoreEventHandler maps to agent:disconnected (Step 5)
  → Bridge notifies end user (Step 6)
  → KoreAdapter checks session.metadata.postAgentAction:
      - 'end': session removed from Redis
      - 'return': conversation returns to bot
```

### User/Bot closes (Koreserver → SmartAssist)

```
KoreAdapter.endSession(sessionId, reason)
  → If reason !== 'agent_closed':
      sends close_conversation event to SmartAssist via sendEvent()
  → Session removed from Redis (atomic Lua: HASH + reverse lookup + active set)
```

### Session timeout

BullMQ-based `SessionTimeoutScheduler` handles TTL-based expiration:

- Channel-specific TTLs (configured via `TransferSessionConfigSchema`)
- TTL extended on every user message and every agent event
- Redis keyspace notifications (`__keyevent@*__:expired`) trigger cleanup from `at_active_sessions`

---

## API Summary

### Outbound APIs (Koreserver → SmartAssist)

| Purpose                  | Method | SmartAssist Endpoint                              | SmartAssistClient Method   |
| ------------------------ | ------ | ------------------------------------------------- | -------------------------- |
| Initiate transfer        | POST   | `/api/v1/conversations`                           | `initTransfer()`           |
| Send user message        | POST   | `/api/v1/internal/events/handle/?sid=&cId=`       | `sendEvent()`              |
| Send control event       | POST   | `/api/v1/internal/events/handle/?sid=&cId=`       | `sendEvent()`              |
| Check business hours     | POST   | `/api/v1/internal/flows/nodes/businessHours`      | `checkBusinessHours()`     |
| Check agent availability | POST   | `/api/v1/internal/flows/nodes/agentsAvailability` | `checkAgentAvailability()` |
| Validate queue           | POST   | `/api/v1/internal/flows/nodes/queueAvailability`  | `validateQueue()`          |
| Update transfer          | POST   | `/api/v1/internal/flows/nodes/updateTransfer`     | `updateTransfer()`         |

### Inbound Webhook (SmartAssist → Koreserver)

| Purpose      | Method | Koreserver Endpoint                    |
| ------------ | ------ | -------------------------------------- |
| Agent events | POST   | `/api/v1/agent-transfer/webhooks/kore` |

### Internal Management APIs

| Purpose                | Method | Koreserver Endpoint                       |
| ---------------------- | ------ | ----------------------------------------- |
| List transfer sessions | GET    | `/api/v1/agent-transfer/sessions`         |
| End transfer session   | POST   | `/api/v1/agent-transfer/sessions/:id/end` |
| Get settings           | GET    | `/api/v1/agent-transfer/settings`         |
| Update settings        | PUT    | `/api/v1/agent-transfer/settings`         |

---

## Error Handling & Resilience

### Circuit breaker

`SmartAssistClient` wraps all outbound calls with an optional circuit breaker. When failures exceed the threshold, the circuit opens and requests fail fast without hitting SmartAssist.

### Retry with exponential backoff

Retryable operations use exponential backoff:

- Delay = `backoffMs x backoffMultiplier^(attempt-1)`
- Client errors (4xx): NOT retried
- Server errors (5xx) and network failures: retried
- Timeout (`AbortError`): stops retrying immediately

### Connection pooling

`undici Pool`: 50 connections, no pipelining, 30s keep-alive timeout.

### Session recovery

`SessionRecoveryService` recovers sessions after pod crashes:

- Scans `at_pod:{hostname}` for sessions owned by dead pods
- Re-registers sessions with the current pod
- Resumes TTL management

### Durable event queue

BullMQ-backed queue ensures agent events survive delivery failures:

- Failed events retried with backoff
- Dead-letter store for permanently failed events
- Graceful shutdown drains in-flight jobs before closing adapters

---

## Security

### Webhook signature verification

```
Signature = HMAC-SHA256(webhookSecret, rawBody)
Verified via: x-kore-signature and x-kore-timestamp headers
```

- Redis-backed nonce store prevents replay attacks
- Timestamp validation prevents stale requests

### SSRF guard

`assertAllowedUrlSync()` validates the SmartAssist base URL at client construction, preventing SSRF via config injection.

### Tenant isolation

- Every webhook event MUST include `orgId`
- Session lookup scoped by `(provider, tenantId, providerSessionId)`
- Tenant mismatch returns **404** (not 403) to avoid leaking session existence

### Session field encryption

Optional `TenantScopedSessionEncryptor` encrypts sensitive session fields, scoped per tenant.

---

## Key Files Reference

### Core SDK (`packages/agent-transfer/src/`)

| File                                  | Description                                             |
| ------------------------------------- | ------------------------------------------------------- |
| `adapters/kore/index.ts`              | KoreAdapter — full transfer lifecycle                   |
| `adapters/kore/smartassist-client.ts` | SmartAssistClient — HTTP client for SmartAssist API     |
| `adapters/kore/event-handler.ts`      | KoreEventHandler — XO to ABL event mapping              |
| `adapters/interface.ts`               | AgentDesktopAdapter interface contract                  |
| `adapters/registry.ts`                | AdapterRegistry — name to adapter map                   |
| `session/transfer-session-store.ts`   | Redis-backed session store with Lua scripts             |
| `config/schema.ts`                    | Zod config schemas                                      |
| `config/defaults.ts`                  | Default API paths, TTLs, Redis prefixes                 |
| `types.ts`                            | Shared types (TransferPayload, AgentEvent, etc.)        |
| `voice/index.ts`                      | Voice gateway utilities                                 |
| `events/index.ts`                     | DurableEventQueue, EventWorker, SessionTimeoutScheduler |

### Runtime Integration (`apps/runtime/src/`)

| File                                               | Description                           |
| -------------------------------------------------- | ------------------------------------- |
| `services/agent-transfer/index.ts`                 | Boot service — initializes everything |
| `services/agent-transfer/message-bridge.ts`        | Routes agent events to end users      |
| `services/agent-transfer/event-queue-factory.ts`   | BullMQ durable event queue            |
| `services/agent-transfer/timeout-queue-factory.ts` | BullMQ session timeout scheduler      |
| `services/execution/transfer-tool-executor.ts`     | LLM tool routing                      |
| `routes/agent-transfer-webhooks.ts`                | Inbound webhook from SmartAssist      |
| `routes/agent-transfer-sessions.ts`                | Session list and end endpoints        |
| `routes/agent-transfer-settings.ts`                | Settings GET/PUT endpoints            |
| `config/agent-transfer.ts`                         | Environment variable config loader    |

### Studio UI (`apps/studio/src/`)

| File                                                | Description          |
| --------------------------------------------------- | -------------------- |
| `components/settings/AgentTransferSettingsPage.tsx` | Settings page        |
| `components/operate/TransferSessionsPage.tsx`       | Active sessions list |
| `components/operate/TransferSessionDetailModal.tsx` | Session detail modal |
| `hooks/useAgentTransferSettings.ts`                 | Settings React hook  |
| `hooks/useTransferSessions.ts`                      | Sessions React hook  |

### Documentation

| File                                                    | Description           |
| ------------------------------------------------------- | --------------------- |
| `docs/enterprise/XO_KORE_SMARTASSIST_AGENT_TRANSFER.md` | XO platform reference |
| `docs/features/agent-transfer.md`                       | Feature specification |
| `docs/specs/agent-transfer.hld.md`                      | High-Level Design     |
| `docs/testing/agent-transfer.md`                        | Test specification    |
| `docs/plans/2026-03-23-agent-transfer-impl-plan.md`     | Implementation plan   |
| `docs/rfcs/RFC-014-agent-transfer-a2a.md`               | A2A integration RFC   |
