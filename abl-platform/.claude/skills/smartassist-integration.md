---
name: smartassist-integration
description: Use when working on agent transfer, SmartAssist API calls, webhook handling, session management, post-agent actions (CSAT), or any human-agent handoff feature in ABL or XO.
---

# SmartAssist Integration Reference

SmartAssist is Kore.ai's agent desktop / contact center product. Both XO and ABL integrate with it for human-agent handoff. This skill documents the complete API contract, event types, and integration patterns.

## Architecture

```
┌──────────┐    API calls     ┌─────────────┐    Agent UI     ┌───────────┐
│  Bot      │ ───────────────→│ SmartAssist  │ ──────────────→│  Agent    │
│  (ABL/XO) │                 │  Server      │                │  Desktop  │
│           │ ←───────────────│              │ ←──────────────│           │
└──────────┘  Webhook events  └─────────────┘  Agent actions  └───────────┘
```

## SmartAssist API Endpoints

All requests include `apikey: {apiKey}` header (lowercase, NOT `x-api-key`).

### 1. Initiate Transfer

```
POST {baseUrl}/api/v1/conversations?streamId={agentId}
Headers: apikey: {key}, app-language: {lang} (optional)
```

**Request body:**

```json
{
  "botId": "string",
  "userId": "string",
  "orgId": "string",
  "accountId": "string",
  "queue": "string (optional)",
  "skills": ["string (optional)"],
  "priority": "number 0-10 (optional)",
  "language": "string (optional)",
  "conversationHistory": [{ "role": "user|agent|system", "content": "string", "timestamp": "ISO" }],
  "metadata": {},
  "customData": {},
  "automationBotId": "string (optional)",
  "overrideAgents": "boolean (optional)",
  "overrideValues": {},
  "agentAssistEvents": { "startEvents": {}, "endEvents": {} },
  "lastIntentName": "string",
  "lastIntentuserInput": "string",
  "dialog_tone": "string",
  "inQueueFlowId": "string (optional)",
  "waitingExperienceId": "string (optional)"
}
```

**Response:** `{ "conversationId": "string" }`

### 2. Check Business Hours

```
POST {baseUrl}/api/v1/internal/flows/nodes/businessHours
Headers: apikey: {key}
Body: { "botId", "userId", "orgId", "accountId", "id": "hoursOfOperationId" }
Response: { "success": boolean }
```

### 3. Check Agent Availability

```
POST {baseUrl}/api/v1/internal/flows/nodes/agentsAvailability
Headers: apikey: {key}
Body: { "botId", "userId", "orgId", "accountId", "skills?", "queue?", "language?",
        "specificAgents?": boolean, "specificAgentValues?": {} }
Response: { "success": boolean }
```

### 4. Validate Queue

```
POST {baseUrl}/api/v1/internal/flows/nodes/queueAvailability
Headers: apikey: {key}
Body: { "botId", "userId", "orgId", "accountId", "queueId", "priority?" }
Response: { "success": boolean }
```

## Webhook Events (SmartAssist → Bot)

SmartAssist sends events to the configured webhook URL. XO uses `apikey` header for auth (NOT HMAC).

### Event Types

| Event                    | ABL Mapping               | Description                        |
| ------------------------ | ------------------------- | ---------------------------------- |
| `agent_message`          | `agent:message`           | Agent sent a message               |
| `agent_accepted`         | `agent:connected`         | Agent accepted conversation        |
| `agent_joined`           | `agent:joined`            | Agent joined conversation          |
| `agent_transferred`      | `agent:connected`         | Agent transferred to another agent |
| `conversation_queued`    | `agent:queued`            | User placed in queue               |
| `queue_position_update`  | `agent:queued`            | Queue position changed             |
| `wait_time_update`       | `agent:queued`            | Estimated wait time updated        |
| `typing`                 | `agent:typing`            | Agent is typing                    |
| `stop_typing`            | `agent:typing_stop`       | Agent stopped typing               |
| `message_delivered`      | `agent:delivery_receipt`  | Message delivered                  |
| `bot_message_delivered`  | `agent:delivery_receipt`  | Bot message delivered              |
| `user_message_delivered` | `agent:delivery_receipt`  | User message delivered             |
| `form_message`           | `agent:form`              | Form submitted/received            |
| `proactive_agentassist`  | `agent:assist_suggestion` | Agent assist suggestion            |
| `closed`                 | `agent:disconnected`      | Conversation closed                |
| `conversation_closed`    | `agent:disconnected`      | Conversation closed (variant)      |
| `agent_disconnect`       | `agent:disconnected`      | Agent disconnected                 |
| `transfer_status`        | `transfer:status`         | Transfer completion status         |
| `conversation_updated`   | —                         | Conversation metadata updated      |

### Webhook Payload Structure

```json
{
  "type": "agent_message",
  "conversationId": "conv_12345",
  "botId": "string",
  "userId": "string",
  "orgId": "string",
  "data": {},
  "message": "string",
  "agentInfo": {},
  "timestamp": "ISO"
}
```

### Webhook Authentication

**XO pattern (correct):** SmartAssist sends `apikey` header — bot verifies against stored key.
**ABL initially implemented:** HMAC-SHA256 (incorrect — was fixed to match XO's `apikey` pattern).

```typescript
// Correct verification (ABL KoreAdapter.verifyWebhook):
const incomingKey = req.headers['apikey'];
return incomingKey === config.auth.apiKey;
```

## Agent Transfer State Machine

### XO States

```
initAgentTransfer → [pending] → SmartAssist events
    → [active] (agent accepted) → agent messaging
    → [closed] (agent disconnect) → post-agent action
    → session cleanup (Redis delete)
```

### ABL States

```
transfer-to-agent tool → pre-checks → initTransfer
    → [pending] → webhook events
    → [queued] → queue_position_update
    → [active] → agent:connected
    → agent:disconnected → post-agent handler
    → [post_agent] → csat | return | end
    → [ended] → cleanup
```

### Post-Agent Actions

| Action           | XO Name           | ABL Name   | Behavior                           |
| ---------------- | ----------------- | ---------- | ---------------------------------- |
| End conversation | `endConversation` | `'end'`    | Terminate session                  |
| Return to bot    | `returnToFlow`    | `'return'` | Resume bot flow                    |
| CSAT survey      | `triggerDialog`   | `'csat'`   | Run CSAT dialog then end           |
| Show message     | `showMsg`         | —          | Display message (XO-only fallback) |

## Session Storage

### XO Redis Keys

```
AgentTransfer:{botId}:{userId}:{channel}     → session state (TTL varies)
{userId}#{botId}                             → kore agent session
CSAT#{userId}#{botId}                        → CSAT session
```

### ABL Redis Keys

```
agent_transfer:{tenantId}:{contactId}:{channel}           → HASH (session data)
at_by_provider:{provider}:{tenantId}:{providerSessionId}  → STRING (reverse lookup)
at_active_sessions                                         → SET (all active)
at_pod:{hostname}                                          → SET (pod-owned)
```

### Channel TTLs

| Channel   | XO TTL         | ABL TTL              |
| --------- | -------------- | -------------------- |
| Chat      | 1800s (30min)  | 1800s (30min)        |
| Messaging | 172800s (48h)  | 172800s (48h)        |
| Email     | 2592000s (30d) | 2592000s (30d)       |
| Voice     | —              | 0 (session duration) |
| Campaign  | —              | 3600s (1h)           |
| Default   | 1800s (30min)  | 1800s (30min)        |

## ABL Implementation Files

### packages/agent-transfer/src/

```
├── adapters/
│   ├── kore/
│   │   ├── smartassist-client.ts    # HTTP client (circuit breaker, retry, connection pool)
│   │   ├── index.ts                 # KoreAdapter (pre-checks, execute, webhook verify)
│   │   └── event-handler.ts         # XO event → ABL event mapping, OOB flags
│   ├── registry.ts                  # Multi-provider registry
│   └── interface.ts                 # AdapterInterface
├── config/
│   └── schema.ts                    # Zod schemas for all config
├── session/
│   ├── transfer-session-store.ts    # Redis HASH store with Lua scripts
│   └── types.ts                     # TransferSessionData, TTL defaults
├── tools/
│   ├── transfer-to-agent.ts         # smartassist_transfer_to_agent (main tool)
│   ├── check-hours.ts               # smartassist_check_hours
│   ├── check-availability.ts        # smartassist_check_availability
│   ├── set-queue.ts                 # smartassist_set_queue
│   ├── ivr-menu.ts                  # smartassist_ivr_menu (voice DTMF menu)
│   ├── ivr-digit-input.ts           # smartassist_ivr_digit_input (multi-digit)
│   ├── call-transfer.ts             # smartassist_call_transfer (SIP/PSTN)
│   └── deflect-to-chat.ts           # smartassist_deflect_to_chat
├── post-agent/
│   └── csat-handler.ts              # CSAT workflow (started → completed/skipped)
├── events/
├── voice/
│   └── index.ts                     # VoiceGatewayInterface, VoiceChannelDetector
└── types.ts                         # TransferPayload, VoiceMessagePayload, OOBFlags
```

### apps/runtime/src/

```
├── routes/agent-transfer-webhooks.ts    # Webhook route (per-adapter auth dispatch)
├── services/agent-transfer/
│   ├── index.ts                         # Boot/init service (feature-flag gated)
│   └── message-bridge.ts               # WS message relay, DTMF routing
└── services/execution/
    └── transfer-tool-executor.ts        # Tool execution (smartassist_* tool routing)
```

## ABL Configuration Schema

```typescript
{
  smartassist: {
    baseUrl: "https://smartassist.example.com",
    apiKey: "sk-xxxxx",
    timeoutMs: 5000,
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000, halfOpenMax: 3 },
    retry: { maxAttempts: 3, backoffMs: 500, backoffMultiplier: 2 }
  },
  session: {
    ttl: { chat: 1800, email: 2592000, voice: 0, messaging: 172800, campaign: 3600, default: 1800 },
    maxConcurrentPerContact: number,
    cleanupBatchSize: number
  },
  providers: [{ name: 'kore', type: 'smartassist', config: { ... } }],
  voice: { type: 'korevg', sipDefaults: { transferMethod, headerPassthrough }, recording: { enabled, orgLevelCheck } }
}
```

## Kore-Specific Provider Config

```typescript
{
  queueId?: string,                // Default queue
  businessHoursId?: string,        // Hours of operation ID
  checkAvailability?: boolean,     // Default: true
  waitingExperienceId?: string,    // In-queue experience
  noAgentsFlowId?: string,         // No agents fallback
  outOfHoursFlowId?: string,       // Outside hours fallback
  inQueueFlowId?: string           // In-queue flow
}
```

## OOB (Out-of-Band) Flags

OOB flags signal transitions from bot responses. Parsed in `event-handler.ts`:

```typescript
{
  isAgentTransfer / agentTransfer  → 'oob:agent_transfer'
  isDeflection                     → 'oob:deflection'
  isDeflectionAutomation           → 'oob:deflection_automation'
  isDeflectionAgentTransfer        → 'oob:deflection_agent_transfer'
  isOfferChatOptions               → 'oob:offer_chat'
  conversationEnd                  → 'oob:conversation_end'
}
```

**Additional context in OOB:**

- `detectedIntentName` — last detected intent
- `dialogRefId` / `dialogId` — dialog references
- `context.lastIntentuserInput` — user input text
- `context.lastIntentName` — intent name
- `context.dialog_tone` — detected sentiment/tone

## Identity Mapping

| ABL Field   | SmartAssist API Field                | XO Field              |
| ----------- | ------------------------------------ | --------------------- |
| `agentId`   | `streamId` (URL param)               | `streamId` / `botId`  |
| `contactId` | `userId`                             | `userId`              |
| `tenantId`  | `orgId` AND `accountId` (same value) | `accountId` / `orgId` |
| `projectId` | not sent                             | not applicable        |
| `channel`   | not sent                             | `channel.type`        |

## Pre-Check Flow (ABL Only)

ABL runs pre-checks before calling `initTransfer`. XO does not have this — validation is lazy.

```
1. Business Hours (if businessHoursId configured)
   → POST /api/v1/internal/flows/nodes/businessHours
   → Fail: status='outside_hours'

2. Agent Availability (default: enabled, skip if checkAvailability=false)
   → POST /api/v1/internal/flows/nodes/agentsAvailability
   → Fail: status='no_agents'

3. Queue Validation (only if payload.queue specified)
   → POST /api/v1/internal/flows/nodes/queueAvailability
   → Fail: status='queue_invalid'

4. All pass → POST /api/v1/conversations?streamId={agentId}
```

## Critical Parity Notes

1. **Auth header is `apikey` (lowercase)** — NOT `x-api-key`, NOT `Authorization`
2. **Webhook auth is `apikey` header check** — NOT HMAC-SHA256
3. **Session key prefix is `agent_transfer:`** — NOT `kore:` (was a bug)
4. **TTLs must match XO** — messaging 48h, email 30d (were 30min and 4h — bug)
5. **`'csat'` must be in postAgentAction union** — was excluded, making CsatHandler unreachable
6. **initTransfer URL is `/api/v1/conversations?streamId=`** — NOT `/liveAgentUrl/`
7. **SmartAssist sends `apikey` header on webhooks** — verify against stored key
