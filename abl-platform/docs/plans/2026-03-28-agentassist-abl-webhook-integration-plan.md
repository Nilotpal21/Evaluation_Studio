# ABL ↔ AgentAssist Webhook Integration Plan

**Date:** 2026-03-28
**Status:** DRAFT
**Scope:** Pass webhook callback URL and ABL source flag from ABL Platform to AgentAssist during transfer initiation, and dispatch agent events back to ABL via webhook.

---

## 1. Problem Statement

When ABL initiates a transfer to SmartAssist via `POST /agentassist/api/v1/conversations`, AgentAssist creates a conversation and routes it to a human agent. When the agent sends a message (or closes the conversation), AgentAssist dispatches the event via `sendKoreEvent()` to the **KoreServer** only. There is no mechanism to also notify the ABL webhook.

Currently, ABL relies on the KoreServer routing events back through its XO webhook system, which introduces an unnecessary hop and requires XO platform configuration. A direct webhook dispatch from AgentAssist to ABL is more reliable and lower-latency.

---

## 2. Solution Overview

```
┌─────────────┐   POST /conversations   ┌─────────────────┐
│ ABL Runtime  │ ───────────────────────>│  KoreServer     │
│              │   (metaInfo includes    │  (BotBuilder)   │
│              │    webhookUrl + flag)   │                 │
│              │                         └───────┬─────────┘
│              │                                 │ Socket.IO
│              │                                 ▼
│              │                         ┌─────────────────┐
│              │  POST /webhooks/        │  AgentAssist    │
│              │  smartassist            │  (koreagentassist)
│              │ <───────────────────────│                 │
│              │  (agent message event)  │  sendKoreEvent()│
└─────────────┘                         └─────────────────┘
```

**Key changes:**

1. **ABL** includes `webhookUrl` and `source: 'abl'` in `metaInfo` during `initTransfer`
2. **AgentAssist** reads these from the conversation's `metaInfo` and uses **mutually exclusive dispatch paths**:
   - If `metaInfo.abl` exists → dispatch to ABL webhook → **skip KoreServer dispatch entirely**
   - If `metaInfo.abl` does NOT exist → dispatch to KoreServer (existing flow, completely untouched)

---

## 3. Data Flow

### 3.1 Transfer Initiation (ABL → KoreServer → AgentAssist)

ABL's `SmartAssistClient.initTransfer()` sends:

```json
{
  "orgId": "o-d1572137-...",
  "userId": "u-xxxx",
  "botId": "st-xxxx",
  "source": "web",
  "metaInfo": {
    "firstName": "ABL",
    "lastName": "Platform",
    "conversationHistory": [...],
    "agentTransferConfig": { ... },
    "abl": {
      "webhookUrl": "https://abl-runtime.example.com/api/v1/agent-transfer/webhooks/smartassist",
      "source": "abl-platform",
      "tenantId": "019cd1b6-266b-7859-8bae-4410451fb8b6",
      "sessionId": "f85c3586-f734-4d2b-abe7-fcbc89f4fb54"
    }
  }
}
```

**Why nest under `metaInfo.abl`?**

- `metaInfo` is a free-form `Object` in AgentAssist's Conversation model (no schema validation to break)
- Namespacing under `abl` avoids collisions with existing `metaInfo` fields (`firstName`, `queue`, `campaignName`, etc.)
- The `abl` object is self-contained — easy to check existence and extract

### 3.2 Agent Event Dispatch (AgentAssist → ABL)

When `sendKoreEvent()` fires for events like `start_kore_agent_chat_message_for_user`, AgentAssist checks `conversation.metaInfo.abl.webhookUrl`. If present, it POSTs the same event payload to that URL.

ABL's webhook route already handles this exact payload format — no changes needed on the receiving side.

---

## 4. Security Analysis

### 4.1 Webhook URL Validation (SSRF Prevention)

**Risk:** A malicious actor could set `metaInfo.abl.webhookUrl` to an internal URL (e.g., `http://169.254.169.254/latest/meta-data/`) to perform Server-Side Request Forgery.

**Mitigations:**

| Control                  | Implementation                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allowlist validation** | AgentAssist validates the webhook URL against a configurable allowlist (`ABL_WEBHOOK_ALLOWED_HOSTS` env var). Only URLs matching the allowlist are dispatched to. |
| **Protocol restriction** | Only `https://` URLs accepted in production. `http://` allowed only when `NODE_ENV !== 'production'` (for local dev).                                             |
| **No private IPs**       | Reject URLs resolving to private/loopback ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`).                              |
| **URL length limit**     | Max 512 characters to prevent buffer abuse.                                                                                                                       |

### 4.2 Webhook Authentication (Replay Prevention)

**Risk:** If an attacker discovers the webhook URL, they could send fake events.

**Mitigations:**

| Control              | Implementation                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HMAC signature**   | AgentAssist signs each webhook request with a shared secret (`ABL_WEBHOOK_SECRET` env var) using HMAC-SHA256. The signature is sent in `x-kore-signature` header. ABL already has `verifyWebhookSignature()` that validates this. |
| **Timestamp header** | Include `x-kore-timestamp` header with Unix timestamp. ABL rejects requests where timestamp drift > 5 minutes.                                                                                                                    |
| **Nonce**            | Include `x-kore-nonce` header with a UUID. ABL's Redis-backed nonce store prevents replay.                                                                                                                                        |

### 4.3 Data Exposure

**Risk:** The webhook URL is stored in `metaInfo` which may be visible to agents in the AgentAssist UI.

**Mitigations:**

| Control               | Implementation                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Redact from UI**    | The `metaInfo.abl` object should be stripped from any API response that surfaces metaInfo to the agent desktop UI. Add a `sanitizeMetaInfo()` utility. |
| **Don't log secrets** | Never log the full webhook URL or signing secret. Log only the host portion for debugging.                                                             |

### 4.4 Failure Isolation

**Risk:** If the ABL webhook is down, agent events for ABL conversations would be lost.

**Design principle:** ABL conversations use a **separate dispatch path** — they never go through KoreServer. This means the existing KoreServer flow is completely untouched and unaffected. However, it also means ABL webhook failures cannot fall back to KoreServer.

**Mitigations:**

| Control                        | Implementation                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Retry with backoff**         | Up to 3 retries with exponential backoff (1s, 2s, 4s). After exhaustion, log error and move on.                            |
| **Timeout**                    | 5-second request timeout per attempt.                                                                                      |
| **Circuit breaker**            | After 5 consecutive failures for a conversation, stop dispatching for that conversation and log a warning.                 |
| **No cross-path interference** | ABL webhook failures never affect KoreServer dispatch for non-ABL conversations. The two paths are completely independent. |

---

## 5. Implementation Plan

### Phase 1: ABL Platform — Pass Webhook URL in `initTransfer`

**Files to modify:**

#### 5.1.1 `packages/agent-transfer/src/config/schema.ts`

Add webhook URL configuration to SmartAssist config schema.

```typescript
// Add to SmartAssistConfigSchema
/** ABL webhook base URL sent to AgentAssist for callback dispatch */
ablWebhookBaseUrl: z.string().url().optional(),
/** Shared secret for HMAC webhook signature verification */
ablWebhookSecret: z.string().min(16).optional(),
```

#### 5.1.2 `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

Include `metaInfo.abl` in the `initTransfer` payload.

```typescript
// Inside initTransfer(), add to the metaInfo object (line ~182-193):
metaInfo: {
  firstName: payload.contact?.firstName || 'ABL',
  lastName: payload.contact?.lastName || 'Platform',
  conversationHistory: payload.conversationHistory,
  metadata: payload.metadata,
  // ... existing fields ...

  // NEW: ABL webhook callback configuration
  abl: {
    source: 'abl-platform',
    webhookUrl: this.config.ablWebhookBaseUrl
      ? `${this.config.ablWebhookBaseUrl}/api/v1/agent-transfer/webhooks/smartassist`
      : undefined,
    tenantId: payload.tenantId,
    sessionId: payload.contactId,
    channel: payload.channel,
  },
},
```

#### 5.1.3 `packages/agent-transfer/src/adapters/kore/index.ts`

Pass the webhook base URL from adapter config to the client.

```typescript
// In initialize(), when building SmartAssistClient config:
ablWebhookBaseUrl: this.smartAssistConfig?.ablWebhookBaseUrl,
```

#### 5.1.4 Connection Config (UI/Environment)

The `ablWebhookBaseUrl` needs to be configured. Options:

- **Environment variable**: `ABL_WEBHOOK_BASE_URL=https://abl-runtime.example.com`
- **Connection config in Studio**: Add to the SmartAssist connection credential fields
- **Auto-detect**: Use the runtime's own base URL (e.g., `req.protocol + '://' + req.get('host')`)

**Recommended:** Auto-detect from runtime config, with env var override.

```typescript
// In runtime's agent-transfer/index.ts, when building adapter config:
ablWebhookBaseUrl: process.env.ABL_WEBHOOK_BASE_URL
  || `http://localhost:${config.port}`,
```

---

### Phase 1b: ABL Platform — Receive & Process Webhook Events

These changes ensure ABL correctly receives webhook events from AgentAssist, resolves sessions despite orgId/tenantId mismatch, delivers agent messages to the Studio UI via WebSocket, and resets session state when the human agent disconnects.

**Status:** ✅ Already implemented in `kore-adapter-enhancements` branch.

**Files modified:**

#### 5.1b.1 `packages/agent-transfer/src/session/transfer-session-store.ts` — Provider Alias Index

**Problem:** Kore SmartAssist uses its own `orgId` (e.g., `o-d1572137-...`) in webhook events, but ABL sessions are keyed by ABL `tenantId` (e.g., `019cd1b6-...`). The provider index lookup `at_by_provider:smartassist:<orgId>:<conversationId>` fails because the key was created with ABL tenantId.

**Solution:** Create a secondary alias index keyed by Kore orgId that points to the same session.

```typescript
// New method on TransferSessionStore:
async addProviderAlias(
  provider: string,
  aliasTenantId: string,    // Kore orgId
  providerSessionId: string,
  key: string,              // Primary session key (uses ABL tenantId)
  ttl?: number,
): Promise<void>

// Creates: at_by_provider:smartassist:<koreOrgId>:<providerSessionId> → <primary session key>
// TTL synced with the primary session key.

// Also modified:
// - end() — cleans up alias key when session ends
// - extendTTL() — extends alias key TTL alongside primary key
```

#### 5.1b.2 `packages/agent-transfer/src/adapters/kore/index.ts` — Create Alias on Transfer

After `sessionStore.create()`, if the Kore orgId differs from the ABL tenantId, create the alias:

```typescript
const koreOrgId = this.smartAssistConfig?.orgId || this.smartAssistConfig?.accountId;
if (
  koreOrgId &&
  koreOrgId !== payload.tenantId &&
  sessionResult.sessionKey &&
  this.sessionStore.addProviderAlias
) {
  await this.sessionStore.addProviderAlias(
    'smartassist',
    koreOrgId,
    result.providerSessionId ?? '',
    sessionResult.sessionKey,
  );
}
```

Also fixed `handleInboundEvent` to use provider string `'smartassist'` (was incorrectly `'kore'`).

Also added `start_kore_agent_chat_close_for_user` to the disconnect event types.

#### 5.1b.3 `apps/runtime/src/routes/agent-transfer-webhooks.ts` — Tenant Isolation Fix

**Problem:** Webhook events carry Kore orgId as `event.orgId`. After session lookup succeeds (via alias), the tenant isolation check rejects because `event.orgId !== session.tenantId`.

**Solution:** Also accept the provider's orgId stored in `session.providerData.orgId` as a valid match:

```typescript
// Step 5: Tenant isolation check
if (event.orgId && event.orgId !== session.tenantId) {
  // Extract provider orgId from providerData (object or JSON string)
  let providerOrgId: string | undefined;
  const providerDataRaw = session.providerData;
  if (providerDataRaw && typeof providerDataRaw === 'object') {
    providerOrgId = (providerDataRaw as Record<string, unknown>).orgId as string | undefined;
  } else if (typeof providerDataRaw === 'string') {
    try {
      const pd = JSON.parse(providerDataRaw);
      providerOrgId = pd?.orgId;
    } catch { /* not parseable */ }
  }

  // Accept if event.orgId matches the provider's orgId
  if (!providerOrgId || event.orgId !== providerOrgId) {
    return res.status(404).json({ ... }); // 404, not 403
  }
}
```

#### 5.1b.4 `apps/runtime/src/services/agent-transfer/index.ts` — Wiring & Disconnect Handling

**Changes:**

1. Added `addProviderAlias` to the `storeHandle` interface wiring
2. On `agent:disconnected` event, reset runtime session transfer flags so user messages go back to the AI agent:

```typescript
koreAdapter.onAgentMessage(async (event) => {
  // ... existing session lookup and bridge routing ...

  // NEW: Reset transfer flags on agent disconnect
  if (event.type === 'agent:disconnected') {
    const sessionService = getSessionService();
    const runtimeSession = await sessionService.loadSession(session.contactId);
    if (runtimeSession && (runtimeSession.transferInitiated || runtimeSession.isEscalated)) {
      runtimeSession.transferInitiated = false;
      runtimeSession.isEscalated = false;
      await sessionService.saveSession(runtimeSession);
    }
  }
});
```

#### 5.1b.5 `apps/runtime/src/services/agent-transfer/message-bridge.ts` — WebSocket Delivery

**Problem:** `routeAgentEvent()` tried to find a WebSocket by the transfer session key (`agent_transfer:<tenantId>:<contactId>:<channel>`), but WebSockets are registered by `contactId` (the runtime session ID).

**Solution:** Try multiple lookup keys:

```typescript
let ws = getSessionWebSocket(sessionId);
// Fallback: try contactId from event
if (!ws && contactId) {
  ws = getSessionWebSocket(contactId);
}
// Fallback: extract contactId from transfer session key format
if (!ws && sessionId.startsWith('agent_transfer:')) {
  const parts = sessionId.split(':');
  if (parts.length >= 3) {
    ws = getSessionWebSocket(parts[2]);
  }
}
```

#### 5.1b.6 `apps/runtime/src/websocket/handler.ts` — Register WebSocket with Bridge

**Problem:** `registerSessionWebSocket()` was never called in production, only in tests.

**Solution:** Register the WebSocket with the message bridge after session creation:

```typescript
import { registerSessionWebSocket } from '../services/agent-transfer/message-bridge.js';

// After session is created in WebSocket handler:
registerSessionWebSocket(sessionId, ws);
```

#### 5.1b.7 `apps/studio/src/types/index.ts` — New ServerMessage Type

Added `agent_transfer_event` to the `ServerMessage` union:

```typescript
| {
    type: 'agent_transfer_event';
    sessionId: string;
    event: { type: string; data?: Record<string, unknown>; timestamp?: string };
  }
```

#### 5.1b.8 `apps/studio/src/contexts/WebSocketContext.tsx` — Display Agent Messages

Handle `agent_transfer_event` in the WebSocket message switch:

```typescript
case 'agent_transfer_event': {
  const transferEvent = message.event;
  if (transferEvent.type === 'agent:message' && transferEvent.data?.message) {
    const agentName = transferEvent.data.agentInfo?.name || 'Human Agent';
    addMessage({
      id: `agent-transfer-${Date.now()}`,
      role: 'assistant',
      content: transferEvent.data.message,
      timestamp: new Date(),
      traceIds: [],
      metadata: { agentName },
    });
  } else if (transferEvent.type === 'agent:disconnected') {
    addMessage({
      id: `agent-transfer-disconnect-${Date.now()}`,
      role: 'system',
      content: 'Human agent has disconnected. You are now back with the AI assistant.',
      timestamp: new Date(),
      traceIds: [],
    });
  }
  break;
}
```

---

### Phase 2: AgentAssist — Route to ABL Webhook at Call Site

**Approach:** Route events to ABL webhook OR KoreServer at the **call site** — the 3-4 places where agent-to-user events originate. The `conversation` object (with `metaInfo.abl`) is already loaded at these call sites, so the routing check is a zero-cost in-memory property lookup. **`sendKoreEvent()` is completely untouched.**

**Why this approach (not modifying `sendKoreEvent`):**

- `sendKoreEvent()` is called from **80+ places** across 15 files — modifying it risks breaking existing flows
- Modifying `sendKoreEvent()` would require a DB lookup per event (the function doesn't have the conversation object)
- Only **3-4 call sites** produce events that ABL cares about, and they already have the conversation loaded
- Zero performance impact on non-ABL conversations — one `if` check on an already-loaded object

**Call site analysis:**

| #   | Location                                        | Event Type                      | `conversation` Available?                                                     |
| --- | ----------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `socket.js:5980` → `handleAgentMessage()`       | Agent text message → user       | ✅ Yes (line 5636: `getConversationById`)                                     |
| 2   | `socket.js:5345` → `handleAgentMessage()`       | Agent form message → user       | ✅ Yes (same handler)                                                         |
| 3   | `socket.service.js:275` → `sendMessageToUser()` | System/scheduled message → user | ⚠️ Partial (line 228: `getConversationsByCnd` — add `metaInfo` to projection) |
| 4   | `socket.service.js:300` → `closeConversation()` | Idle close → user               | ❌ No (needs DB lookup or flag in `data`)                                     |

**Files to modify:**

#### 5.2.1 `src/config/config.js` — Add ABL webhook configuration

```javascript
// Add to config object
ablWebhook: {
  enabled: toBool(process.env.ABL_WEBHOOK_ENABLED, true),
  secret: process.env.ABL_WEBHOOK_SECRET || '',
  allowedHosts: (process.env.ABL_WEBHOOK_ALLOWED_HOSTS || '').split(',').filter(Boolean),
  timeoutMs: parseInt(process.env.ABL_WEBHOOK_TIMEOUT_MS || '5000', 10),
  maxRetries: parseInt(process.env.ABL_WEBHOOK_MAX_RETRIES || '3', 10),
  circuitBreakerThreshold: parseInt(process.env.ABL_WEBHOOK_CB_THRESHOLD || '5', 10),
},
```

#### 5.2.2 `src/services/ablWebhookDispatcher.js` — NEW FILE

Create a dedicated webhook dispatcher service.

```javascript
/**
 * ABL Webhook Dispatcher
 *
 * Dispatches agent events to ABL Platform via HTTP webhook.
 * For ABL conversations (identified by metaInfo.abl), this replaces the
 * KoreServer dispatch entirely — the two paths are mutually exclusive.
 *
 * Called from specific call sites where the conversation object is already
 * loaded. sendKoreEvent() is never modified — routing happens at the caller.
 */
const config = require('../config/config');
const logger = require('../config/logger')('ablWebhookDispatcher');
const crypto = require('crypto');
const { URL } = require('url');
const { makeHttpRequest } = require('../utils/http');

// Circuit breaker state: conversationId → consecutive failure count
const circuitState = new Map();
const MAX_CIRCUIT_STATE_SIZE = 10000;

/**
 * Check if a conversation is from ABL Platform.
 * Returns the ABL config object or null.
 * This is a zero-cost in-memory check — no DB lookup.
 */
function getAblConfig(conversation) {
  const abl = conversation?.metaInfo?.abl;
  if (!abl || !abl.webhookUrl || abl.source !== 'abl-platform') {
    return null;
  }
  return abl;
}

/**
 * Validate webhook URL for security (SSRF prevention).
 * Returns { valid: boolean, reason?: string }
 */
function validateWebhookUrl(webhookUrl) {
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return { valid: false, reason: 'Missing or empty URL' };
  }
  if (webhookUrl.length > 512) {
    return { valid: false, reason: 'URL exceeds 512 characters' };
  }

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Protocol check
  const isProduction = config.environment === 'production';
  if (isProduction && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTPS allowed in production' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTP/HTTPS protocols allowed' };
  }

  // Private IP check
  const hostname = parsed.hostname;
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^localhost$/i,
    /^\[::1\]$/,
  ];
  if (privatePatterns.some((p) => p.test(hostname))) {
    if (isProduction) {
      return { valid: false, reason: 'Private/loopback IPs not allowed in production' };
    }
    logger.warn('Webhook URL resolves to private IP (allowed in non-production)', {
      host: hostname,
    });
  }

  // Allowlist check (if configured)
  const allowedHosts = config.ablWebhook?.allowedHosts || [];
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    return { valid: false, reason: `Host ${hostname} not in allowlist` };
  }

  return { valid: true };
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Returns headers to include in the request.
 */
function signPayload(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signatureInput = `${timestamp}.${nonce}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(signatureInput).digest('hex');

  return {
    'x-kore-signature': `sha256=${signature}`,
    'x-kore-timestamp': timestamp,
    'x-kore-nonce': nonce,
  };
}

function isCircuitOpen(conversationId) {
  const failures = circuitState.get(conversationId) || 0;
  return failures >= (config.ablWebhook?.circuitBreakerThreshold || 5);
}

function recordSuccess(conversationId) {
  circuitState.delete(conversationId);
}

function recordFailure(conversationId) {
  const current = circuitState.get(conversationId) || 0;
  circuitState.set(conversationId, current + 1);
  if (circuitState.size > MAX_CIRCUIT_STATE_SIZE) {
    const firstKey = circuitState.keys().next().value;
    circuitState.delete(firstKey);
  }
}

/**
 * Dispatch an event to the ABL webhook with retries.
 *
 * @param {string} webhookUrl - The validated ABL webhook URL
 * @param {object} eventPayload - The event payload
 * @param {string} conversationId - For circuit breaker tracking
 */
async function dispatchEvent(webhookUrl, eventPayload, conversationId) {
  if (!config.ablWebhook?.enabled) return;

  if (isCircuitOpen(conversationId)) {
    logger.warn('ABL webhook circuit open, skipping dispatch', {
      conversationId,
      eventName: eventPayload?.eventName,
    });
    return;
  }

  const maxRetries = config.ablWebhook?.maxRetries || 3;
  const timeoutMs = config.ablWebhook?.timeoutMs || 5000;
  const secret = config.ablWebhook?.secret;

  const headers = {
    'Content-Type': 'application/json',
    ...(secret ? signPayload(eventPayload, secret) : {}),
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await makeHttpRequest(webhookUrl, 'POST', {
        headers,
        body: eventPayload,
        timeout: timeoutMs,
      });
      recordSuccess(conversationId);
      logger.info('ABL webhook event dispatched', {
        conversationId,
        eventName: eventPayload?.eventName,
        attempt,
      });
      return;
    } catch (err) {
      logger.error('ABL webhook dispatch failed', {
        conversationId,
        eventName: eventPayload?.eventName,
        attempt,
        maxRetries,
        error: err.message,
      });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
      }
    }
  }

  recordFailure(conversationId);
}

module.exports = {
  getAblConfig,
  validateWebhookUrl,
  signPayload,
  dispatchEvent,
  isCircuitOpen,
  _circuitState: circuitState,
  _recordSuccess: recordSuccess,
  _recordFailure: recordFailure,
};
```

#### 5.2.3 `src/socket.js` — Route in `handleAgentMessage()` (Agent text & form messages)

**Context:** `handleAgentMessage()` (line 5463) already loads the conversation at line 5636 via `getConversationById()`. The `sendKoreEvent()` calls are at lines 5980 (text) and 5345 (form).

```javascript
// At top of socket.js, add import:
const ablWebhookDispatcher = require('./services/ablWebhookDispatcher');

// ─── Call site 1: Agent text message (line ~5979) ───
// BEFORE:
if (!autoAccepted && !conversation.source.startsWith('emailConnectInst')) {
  socketService.sendKoreEvent(apiPayload);
}

// AFTER:
if (!autoAccepted && !conversation.source.startsWith('emailConnectInst')) {
  const ablConfig = ablWebhookDispatcher.getAblConfig(conversation);
  if (ablConfig) {
    // ABL conversation → dispatch to ABL webhook, skip KoreServer
    const validation = ablWebhookDispatcher.validateWebhookUrl(ablConfig.webhookUrl);
    if (validation.valid) {
      ablWebhookDispatcher
        .dispatchEvent(ablConfig.webhookUrl, apiPayload, data.conversationId)
        .catch((err) => logger.error(`ABL webhook dispatch error: ${err.message}`));
    }
  } else {
    // Non-ABL conversation → existing KoreServer flow (unchanged)
    socketService.sendKoreEvent(apiPayload);
  }
}

// ─── Call site 2: Agent form message (line ~5345) ───
// BEFORE:
if (!autoAccepted) {
  const apiPayload = { eventName: q, payload: data };
  socketService.sendKoreEvent(apiPayload);
}

// AFTER:
if (!autoAccepted) {
  const apiPayload = { eventName: q, payload: data };
  const ablConfig = ablWebhookDispatcher.getAblConfig(conversation);
  if (ablConfig) {
    const validation = ablWebhookDispatcher.validateWebhookUrl(ablConfig.webhookUrl);
    if (validation.valid) {
      ablWebhookDispatcher
        .dispatchEvent(ablConfig.webhookUrl, apiPayload, data.conversationId)
        .catch((err) => logger.error(`ABL webhook dispatch error: ${err.message}`));
    }
  } else {
    socketService.sendKoreEvent(apiPayload);
  }
}
```

**Note:** `sendKoreEvent()` is NOT modified. The routing happens at the call site where `conversation` is already loaded. For non-ABL conversations, `getAblConfig()` returns `null` and the code falls through to the existing `sendKoreEvent()` call — zero performance impact.

#### 5.2.4 `src/services/socket.service.js` — Route in `sendMessageToUser()` (System/scheduled messages)

**Context:** `sendMessageToUser()` (line 224) already fetches the conversation at line 228 via `getConversationsByCnd()`, but the projection only includes `_id, userId, status, language, source`. We need to add `metaInfo` to the projection.

```javascript
// At top of socket.service.js, add import:
const ablWebhookDispatcher = require('./ablWebhookDispatcher');

// ─── Call site 3: sendMessageToUser (line ~228) ───
// BEFORE (projection):
const conversationDeatils = await conversationService.getConversationsByCnd(
  { _id: conversationId },
  { _id: 1, userId: 1, status: 1, language: 1, source: 1 },
);

// AFTER (add metaInfo to projection):
const conversationDeatils = await conversationService.getConversationsByCnd(
  { _id: conversationId },
  { _id: 1, userId: 1, status: 1, language: 1, source: 1, metaInfo: 1 },
);

// ─── BEFORE (line ~275):
return sendKoreEvent(apiPayload);

// AFTER:
const ablConfig = ablWebhookDispatcher.getAblConfig(conversationDeatils);
if (ablConfig) {
  const validation = ablWebhookDispatcher.validateWebhookUrl(ablConfig.webhookUrl);
  if (validation.valid) {
    return ablWebhookDispatcher.dispatchEvent(ablConfig.webhookUrl, apiPayload, conversationId);
  }
  return; // ABL conversation but bad URL — skip KoreServer
} else {
  return sendKoreEvent(apiPayload);
}
```

**Performance note:** Adding `metaInfo: 1` to the projection adds minimal overhead — MongoDB only returns that one extra field. For non-ABL conversations, `metaInfo.abl` won't exist, `getAblConfig()` returns `null`, and the code falls through to `sendKoreEvent()`.

#### 5.2.5 `src/services/socket.service.js` — Route in `closeConversation()` (Idle close)

**Context:** `closeConversation()` (line 281) does NOT load the conversation — it only uses `data` passed in. We need to load it for the ABL check.

```javascript
// ─── Call site 4: closeConversation (line ~281) ───
// BEFORE:
function closeConversation(data) {
  let AppLanguage = _.get(data, 'language', 'en');
  const { conversationService, agentService, filtersService } = require('.');
  const { conversationId, userId, agentId } = data;
  // ... builds endConversationPayload ...
  sendKoreEvent(apiPayload);
  // ... existing close logic ...
}

// AFTER:
async function closeConversation(data) {
  let AppLanguage = _.get(data, 'language', 'en');
  const { conversationService, agentService, filtersService } = require('.');
  const { conversationId, userId, agentId } = data;

  // Check if ABL conversation — load conversation with metaInfo only
  const conversation = await conversationService.getConversationsByCnd(
    { _id: conversationId },
    { _id: 1, metaInfo: 1, orgId: 1, botId: 1 },
  );
  const ablConfig = ablWebhookDispatcher.getAblConfig(conversation);

  const endConversationPayload = {
    /* ... same as before ... */
  };
  const apiPayload = { eventName: q, payload: endConversationPayload };

  if (ablConfig) {
    // ABL conversation → dispatch close event to ABL webhook, skip KoreServer
    const validation = ablWebhookDispatcher.validateWebhookUrl(ablConfig.webhookUrl);
    if (validation.valid) {
      ablWebhookDispatcher
        .dispatchEvent(ablConfig.webhookUrl, apiPayload, conversationId)
        .catch((err) => logger.error(`ABL close webhook dispatch error: ${err.message}`));
    }
    // Still proceed with local conversation state cleanup below
  } else {
    // Non-ABL conversation → existing KoreServer flow (unchanged)
    sendKoreEvent(apiPayload);
  }

  // ... rest of existing closeConversation logic continues unchanged ...
  conversationService
    .updateConversationState({ conversationId, event: constant.TERMINATED })
    .then(async (conversation) => {
      /* ... */
    });
}
```

**Note:** `closeConversation` changes from `function` to `async function`. Since it's only called from 1 place (`redisTimerUtils.js:97`), this is safe. The DB lookup only happens here because `closeConversation` didn't previously load the conversation.

#### 5.2.6 `src/services/conversation.service.js` — Sanitize `metaInfo.abl` from API responses

```javascript
// Add utility function:
function sanitizeMetaInfoForAgent(metaInfo) {
  if (!metaInfo) return metaInfo;
  const sanitized = { ...metaInfo };
  delete sanitized.abl; // Remove ABL webhook config from agent-visible data
  return sanitized;
}

// Use in getConversationById responses that go to the agent desktop:
// (Apply in the controller layer or wherever conversation data is
//  serialized for the agent UI)
```

#### 5.2.7 `sendKoreEvent()` — NO CHANGES

**`sendKoreEvent()` is completely untouched.** All 80+ existing call sites continue to work exactly as before. The routing decision happens at the 3-4 specific call sites listed above, using the already-loaded `conversation` object.

---

### Phase 3: Configuration & Deployment

#### 5.3.1 ABL Runtime Environment Variables

```env
# ABL webhook base URL (auto-detected from runtime config if not set)
# ABL_WEBHOOK_BASE_URL=https://abl-runtime.example.com

# Shared secret for webhook HMAC signature (must match AgentAssist)
ABL_WEBHOOK_SECRET=<generate-a-32-char-random-secret>
```

#### 5.3.2 AgentAssist Environment Variables

```env
# Enable ABL webhook dispatch
ABL_WEBHOOK_ENABLED=true

# Shared secret for HMAC signing (must match ABL)
ABL_WEBHOOK_SECRET=<same-secret-as-ABL>

# Optional: Restrict to specific hosts
ABL_WEBHOOK_ALLOWED_HOSTS=abl-runtime.example.com,abl-runtime-staging.example.com

# Timeouts and retries
ABL_WEBHOOK_TIMEOUT_MS=5000
ABL_WEBHOOK_MAX_RETRIES=3
ABL_WEBHOOK_CB_THRESHOLD=5
```

---

## 6. File Change Summary

### ABL Platform (abl-platform repo)

#### Phase 1a: Send webhook URL in `initTransfer` (TODO)

| File                                                              | Change                                                | Lines |
| ----------------------------------------------------------------- | ----------------------------------------------------- | ----- |
| `packages/agent-transfer/src/config/schema.ts`                    | Add `ablWebhookBaseUrl`, `ablWebhookSecret` to schema | ~5    |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts` | Add `metaInfo.abl` to `initTransfer` payload          | ~10   |
| `packages/agent-transfer/src/adapters/kore/index.ts`              | Pass `ablWebhookBaseUrl` to client config             | ~3    |
| `apps/runtime/src/services/agent-transfer/index.ts`               | Set `ablWebhookBaseUrl` from env/config               | ~5    |

#### Phase 1b: Receive & process webhook events (✅ Implemented)

| File                                                            | Change                                                                                                                                                                              | Lines |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/agent-transfer/src/session/transfer-session-store.ts` | Add `addProviderAlias()`, `getSessionTtl()`, `extendAliasKeyTtl()`; modify `end()` and `extendTTL()` for alias cleanup                                                              | ~80   |
| `packages/agent-transfer/src/adapters/kore/index.ts`            | Create provider alias after session create; fix provider string `'kore'` → `'smartassist'` in `handleInboundEvent`; add `start_kore_agent_chat_close_for_user` to disconnect events | ~25   |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`            | Accept `providerData.orgId` as valid tenant match in isolation check                                                                                                                | ~20   |
| `apps/runtime/src/services/agent-transfer/index.ts`             | Wire `addProviderAlias` to storeHandle; reset runtime session transfer flags on `agent:disconnected`                                                                                | ~30   |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts`    | Multi-key WebSocket lookup (transfer key → contactId → extracted contactId)                                                                                                         | ~15   |
| `apps/runtime/src/websocket/handler.ts`                         | Call `registerSessionWebSocket(sessionId, ws)` after session creation                                                                                                               | ~3    |
| `apps/studio/src/types/index.ts`                                | Add `agent_transfer_event` to `ServerMessage` union                                                                                                                                 | ~5    |
| `apps/studio/src/contexts/WebSocketContext.tsx`                 | Handle `agent:message` (display as assistant) and `agent:disconnected` (system message + flag reset)                                                                                | ~20   |

### AgentAssist (koreagentassist repo)

| File                                                     | Change                                                                                   | Lines |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----- |
| `src/config/config.js`                                   | Add `ablWebhook` config block                                                            | ~10   |
| `src/services/ablWebhookDispatcher.js`                   | **NEW** — `getAblConfig()`, URL validation, HMAC signing, retry logic, circuit breaker   | ~150  |
| `src/socket.js` → `handleAgentMessage()`                 | Route agent text message (line ~5980) and form message (line ~5345) to ABL or KoreServer | ~20   |
| `src/services/socket.service.js` → `sendMessageToUser()` | Add `metaInfo` to projection, route to ABL or KoreServer                                 | ~10   |
| `src/services/socket.service.js` → `closeConversation()` | Load conversation for ABL check, route to ABL or KoreServer                              | ~15   |
| `src/services/conversation.service.js`                   | Add `sanitizeMetaInfoForAgent()`                                                         | ~10   |
| `src/services/socket.service.js` → `sendKoreEvent()`     | **NO CHANGES** — completely untouched                                                    | 0     |

---

## 7. Testing Checklist

### Unit Tests (AgentAssist)

- [ ] `ablWebhookDispatcher.validateWebhookUrl()` — accepts valid HTTPS URLs, rejects private IPs, rejects non-HTTPS in production, enforces allowlist
- [ ] `ablWebhookDispatcher.signPayload()` — generates valid HMAC-SHA256 signature
- [ ] `ablWebhookDispatcher.dispatchEvent()` — retries on failure, circuit breaker trips after threshold
- [ ] `sendKoreEvent()` — dispatches to ABL when `metaInfo.abl` is present, skips when absent

### Integration Tests (ABL)

- [ ] `initTransfer` includes `metaInfo.abl.webhookUrl` in payload
- [ ] Webhook route accepts events with valid HMAC signature
- [ ] Webhook route rejects events with invalid/missing signature
- [ ] Webhook route rejects events with stale timestamp (>5 min drift)

### E2E Tests

- [ ] Full flow: User message → AI escalation → transfer to SmartAssist → agent sends message → webhook → message displayed in Studio
- [ ] Agent closes conversation → `conversation_closed` event → Studio shows disconnect message → user messages go back to AI
- [ ] ABL conversation events are dispatched ONLY to ABL webhook (not to KoreServer)
- [ ] Non-ABL conversation events are dispatched ONLY to KoreServer (existing flow unchanged)
- [ ] Circuit breaker prevents repeated dispatch attempts after consecutive failures
- [ ] ABL webhook failure does NOT cause fallthrough to KoreServer path

---

## 8. Rollout Strategy

1. **Phase 1 (ABL):** Deploy ABL changes first. The `metaInfo.abl` field is additive — AgentAssist ignores unknown metaInfo fields.
2. **Phase 2 (AgentAssist):** Deploy with `ABL_WEBHOOK_ENABLED=false`. Verify `metaInfo.abl` is stored in conversations.
3. **Phase 3 (Enable):** Set `ABL_WEBHOOK_ENABLED=true` and configure the shared secret. Test with a single tenant.
4. **Phase 4 (Monitor):** Watch for circuit breaker trips, latency impact on `sendKoreEvent`, and webhook delivery success rates.

---

## 9. Open Questions

1. **Auto-detect vs explicit URL:** Should ABL auto-detect its own webhook URL from the runtime's config, or should it always be explicitly configured? Auto-detect is simpler but may fail behind reverse proxies.
2. ~~**Skip KoreServer dispatch?**~~ **RESOLVED:** Yes — ABL conversations use ONLY the ABL webhook path. KoreServer dispatch is skipped entirely for conversations with `metaInfo.abl`. The two paths are mutually exclusive.
3. **Webhook URL per-tenant vs global?** The current design sends one webhook URL per conversation. If ABL deploys multi-tenant with a single runtime, a global URL works. If each tenant has its own runtime, per-tenant URLs are needed.
4. **Secret rotation:** How will HMAC secrets be rotated without downtime? Consider accepting two secrets during rotation periods.
