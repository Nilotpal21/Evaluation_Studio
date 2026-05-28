# AgentAssist Webhook Dispatch — Changes Summary

**Date:** 2026-03-29
**Branch:** `feature/abl-webhook-dispatch` (koreagentassist repo)
**Related ABL branch:** `kore-adapter-enhancements` (abl-platform repo)

---

## Overview

When ABL initiates a transfer to SmartAssist, it passes `metaInfo.abl` (containing a webhook URL) in the conversations API payload. AgentAssist now checks this field at agent-to-user event dispatch points. If present, events are sent to the ABL webhook **instead of** KoreServer. Non-ABL conversations are completely unaffected.

---

## Design Decisions

| Decision                                             | Rationale                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Route at call site, not inside `sendKoreEvent()`** | `sendKoreEvent()` has 80+ callers across 15 files. Modifying it would require a DB lookup per event (it doesn't have the conversation object). Only 4 call sites produce events ABL cares about, and they already have the conversation loaded. |
| **Zero env vars**                                    | Webhook URL comes from `metaInfo.abl` per conversation. Timeout/retry/circuit-breaker use hardcoded defaults matching KoreServer's pattern (3 retries, no env vars).                                                                            |
| **Mutually exclusive paths**                         | ABL conversations NEVER fall through to KoreServer, even on webhook failure. The two paths are completely independent.                                                                                                                          |
| **`routeEvent()` returns boolean**                   | Returns `true` if ABL (caller skips `sendKoreEvent`), `false` if not ABL (caller calls `sendKoreEvent`). Simple, no refactoring of callers needed.                                                                                              |

---

## Files Changed

### 1. `src/services/ablWebhookDispatcher.js` — NEW FILE (~220 lines)

Central ABL webhook dispatch service. Exports:

| Function                                      | Purpose                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAblConfig(conversation)`                  | Returns `metaInfo.abl` object or `null`. Zero-cost in-memory check.                                                                                             |
| `validateWebhookUrl(url)`                     | SSRF prevention: blocks private IPs in production, requires HTTPS in production, 512 char limit.                                                                |
| `signPayload(payload, secret)`                | HMAC-SHA256 signing with timestamp + nonce for replay prevention.                                                                                               |
| `dispatchEvent(url, payload, convId, secret)` | HTTP POST with 3 retries (exponential backoff: 1s, 2s, 4s), 5s timeout, per-conversation circuit breaker (opens after 5 consecutive failures).                  |
| `routeEvent(conversation, apiPayload)`        | Convenience function: checks ABL config, validates URL, dispatches. Returns `true` if ABL conversation (caller should skip `sendKoreEvent`), `false` otherwise. |

**Dependencies used:**

- `require('./platformServices/request.service')` — same `makeHttpRequest` used by `sendKoreEvent`
- `require('../config/logger')('ablWebhookDispatcher')` — standard winston logger
- `require('../config/config')` — for `config.env` (production check)
- Node built-in `crypto` and `url`

### 2. `src/socket.js` — 2 call site modifications

**Import added (line 37):**

```javascript
const ablWebhookDispatcher = require('./services/ablWebhookDispatcher');
```

**Call site 1 — Agent text message (line ~5981, inside `handleAgentMessage()`):**

```javascript
// BEFORE:
socketService.sendKoreEvent(apiPayload);

// AFTER:
if (!ablWebhookDispatcher.routeEvent(conversation, apiPayload)) {
  socketService.sendKoreEvent(apiPayload);
}
```

`conversation` is already loaded at line 5636 via `getConversationById()`.

**Call site 2 — Agent form message (line ~5345, inside `handleAgentMessage()`):**

```javascript
// BEFORE:
socketService.sendKoreEvent(apiPayload);

// AFTER:
if (!ablWebhookDispatcher.routeEvent(conversation, apiPayload)) {
  socketService.sendKoreEvent(apiPayload);
}
```

Same `conversation` object from the enclosing `handleAgentMessage()` handler.

### 3. `src/services/socket.service.js` — 2 function modifications

**Import added (line 26):**

```javascript
const ablWebhookDispatcher = require('./ablWebhookDispatcher');
```

**`sendMessageToUser()` (line ~224):**

- Added `metaInfo: 1` to the `getConversationsByCnd` projection (line 238)
- Replaced `return sendKoreEvent(apiPayload)` with:

```javascript
if (!ablWebhookDispatcher.routeEvent(conversationDeatils, apiPayload)) {
  return sendKoreEvent(apiPayload);
}
```

**`closeConversation()` (line ~281):**

- Changed from `function` to `async function` (only called from 1 place: `redisTimerUtils.js:97`)
- Added DB lookup for conversation metaInfo (needed because this function didn't previously load the conversation):

```javascript
const conversation = await conversationService.getConversationsByCnd(
  { _id: conversationId },
  { _id: 1, metaInfo: 1 },
);
if (ablWebhookDispatcher.routeEvent(conversation, apiPayload)) {
  // ABL conversation — skip KoreServer, continue local cleanup
} else {
  sendKoreEvent(apiPayload);
}
```

- On error (DB lookup fails), falls back to `sendKoreEvent()` to avoid breaking existing flow.

### 5. `src/controllers/queue.controller.js` — 1 new export

**`getQueuesInternal(req, res, next)`:**

Internal API version of `GET /api/v1/queues` that uses apiKey auth instead of bearer token. Same response structure. `orgId` and `botId` passed in request body.

- Reuses `queue.getQueueByOrgId()` and `parsePaginatedResponse()` — identical data path
- Supports `lname` (name search), `limit`, `skip`, `page`, `sortBy`, `queueId` in body

### 6. `src/routes/v1/internalAPIs.route.js` — 1 new route

```javascript
router.post('/queues/list', auth(), getQueuesInternal);
```

**Endpoint:** `POST /agentassist/api/v1/internal/queues/list`

**Headers:**

- `apikey` — internal API key (validated by `internalAuth` middleware)

**Request body:**

```json
{
  "orgId": "o-xxxxx",
  "botId": "st-xxxxx",
  "lname": "Default",
  "limit": 10,
  "skip": 0
}
```

| Field     | Type   | Required | Description                             |
| --------- | ------ | -------- | --------------------------------------- |
| `orgId`   | string | Yes      | Organization/account ID                 |
| `botId`   | string | No       | Bot/instance ID (filters queues by bot) |
| `lname`   | string | No       | Queue name search (case-insensitive)    |
| `queueId` | string | No       | Filter by specific transfer queue       |
| `limit`   | number | No       | Page size (default: 10)                 |
| `skip`    | number | No       | Offset (default: 0)                     |
| `page`    | number | No       | Page number                             |
| `sortBy`  | string | No       | Sort field                              |

**Response** (same as bearer-token `GET /api/v1/queues`):

```json
{
  "results": [{ "id": "qu-xxx", "name": "Default Queue", ... }],
  "page": 1,
  "limit": 10,
  "hasMore": false,
  "totalPages": 1,
  "totalResults": 3
}
```

### 7. `src/services/conversation.service.js` — 1 new export

**`sanitizeMetaInfoForAgent(metaInfo)`:**

```javascript
function sanitizeMetaInfoForAgent(metaInfo) {
  if (!metaInfo || !metaInfo.abl) return metaInfo;
  const sanitized = { ...metaInfo };
  delete sanitized.abl;
  return sanitized;
}
```

Strips `metaInfo.abl` (webhook URL, secrets) before exposing conversation data to the agent desktop UI. Should be applied in the controller/API layer that serializes conversation data for the agent.

---

## What is NOT Changed

| Component                                        | Status                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `sendKoreEvent()` function                       | **Completely untouched** — zero modifications                               |
| All 80+ existing `sendKoreEvent()` call sites    | **No changes**                                                              |
| KoreServer dispatch for non-ABL conversations    | **Identical behavior**                                                      |
| Any existing tests                               | **No changes needed**                                                       |
| Environment variables / config                   | **No new env vars**                                                         |
| Existing `GET /api/v1/queues` (bearer token)     | **Completely untouched** — new internal endpoint is separate                |
| Existing `POST /api/v1/internal/queues` (by IDs) | **Completely untouched** — `/queues` and `/queues/list` are different paths |

---

## Performance Impact

| Scenario                          | Impact                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-ABL conversation              | **Zero** — `getAblConfig()` checks `conversation?.metaInfo?.abl` (in-memory property lookup on already-loaded object), returns `null`, falls through to `sendKoreEvent()` |
| ABL conversation                  | Webhook HTTP POST replaces KoreServer HTTP POST — similar latency                                                                                                         |
| `closeConversation()` for non-ABL | One lightweight MongoDB query `{ _id, metaInfo }` added — minimal overhead for an already-rare idle-close path                                                            |

---

## How ABL Passes `metaInfo.abl`

ABL's `SmartAssistClient.initTransfer()` includes this in the conversations API payload:

```json
{
  "metaInfo": {
    "firstName": "ABL",
    "lastName": "Platform",
    "abl": {
      "source": "abl-platform",
      "webhookUrl": "https://abl-runtime.example.com/api/v1/agent-transfer/webhooks/smartassist",
      "tenantId": "019cd1b6-266b-7859-8bae-4410451fb8b6",
      "sessionId": "f85c3586-f734-4d2b-abe7-fcbc89f4fb54",
      "secret": "<optional-hmac-secret>"
    }
  }
}
```

AgentAssist stores this in the Conversation model's free-form `metaInfo` field. On subsequent agent events, `getAblConfig()` reads it back.

---

## Testing Checklist

### Verify ABL path works:

- [ ] Initiate transfer from ABL with `metaInfo.abl.webhookUrl` set
- [ ] Agent sends message → verify POST to ABL webhook URL (not to KoreServer)
- [ ] Agent sends form → verify POST to ABL webhook URL
- [ ] Agent closes conversation → verify POST to ABL webhook URL
- [ ] System idle close → verify POST to ABL webhook URL

### Verify KoreServer path is unchanged:

- [ ] Initiate transfer from XO (no `metaInfo.abl`) → verify events still go to KoreServer
- [ ] All existing SmartAssist flows work identically

### Verify security:

- [ ] Webhook URL with private IP rejected in production
- [ ] HMAC signature present when `metaInfo.abl.secret` is set
- [ ] `metaInfo.abl` not visible in agent desktop UI (via `sanitizeMetaInfoForAgent`)

### Verify internal queues API:

- [ ] `POST /api/v1/internal/queues/list` with valid apikey + `{ orgId }` → returns queue list
- [ ] `POST /api/v1/internal/queues/list` with `{ orgId, lname: "Default" }` → returns filtered results
- [ ] Missing apikey → 403 Forbidden
- [ ] Missing orgId in body → 400 Bad Request
- [ ] Response structure matches `GET /api/v1/queues` (bearer-token version)

### Verify resilience:

- [ ] ABL webhook down → retries 3 times with backoff → circuit breaker opens after 5 failures
- [ ] ABL webhook failure does NOT affect non-ABL conversations
- [ ] `closeConversation` DB lookup failure falls back to KoreServer
