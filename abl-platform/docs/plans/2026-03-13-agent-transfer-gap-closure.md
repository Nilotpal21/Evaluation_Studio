# Implementation Plan: Agent Transfer — Gap Closure & Bug Fixes

> Closes protocol gaps and correctness bugs identified by the [full code review](../XO_KORE_SMARTASSIST_AGENT_TRANSFER.md#12-abl-platform-gap-analysis)
> comparing the ABL `packages/agent-transfer` implementation against the XO platform reference.
>
> **47 findings total:** 12 critical + 4 new from review, 19 important, 8 moderate, 4 test gaps.
>
> **Review round 2 (2026-03-13):** 3 parallel review agents verified all findings against source code.
> 2 findings downgraded (I19, M5), 4 new critical bugs discovered, several fix corrections applied.
> See [Review Corrections](#review-corrections) appendix.

---

## Overview

| Phase                                                              | Scope                                | Priority | Effort   | Findings Addressed                                            |
| ------------------------------------------------------------------ | ------------------------------------ | -------- | -------- | ------------------------------------------------------------- |
| [0. Existing Code Correctness](#phase-0-existing-code-correctness) | Fix bugs in code that IS implemented | CRITICAL | 3–4 days | C6, C7, C8, C9, C11, C12, I2, I8, I10, I11, I18, NEW-1, NEW-2 |
| [1. User → Agent Protocol](#phase-1-user--agent-protocol)          | Wire bidirectional messaging         | CRITICAL | 2–3 days | C1, C2, C3, C4, C5, I1, I4, I5, I6                            |
| [2. Security Hardening](#phase-2-security-hardening)               | Fix security-relevant bugs           | HIGH     | 1–2 days | C10, I9, I12, I16                                             |
| [3. Attachment Handling](#phase-3-attachment-handling)             | File transfer both directions        | MEDIUM   | 2–3 days | (no finding # — missing feature)                              |
| [4. Session Store Polish](#phase-4-session-store-polish)           | TTL, CSAT, disposition, cleanup      | MEDIUM   | 1–2 days | I3, I13, I14, I15, I17, M1, M3, M6, M7, M8                    |
| [5. Test Coverage](#phase-5-test-coverage)                         | Fill critical test gaps              | MEDIUM   | 1–2 days | T1, T2, T3, T4, M2, M4, I7                                    |

**Total estimated effort: 10–16 days**

---

## Phase 0: Existing Code Correctness

> Fix bugs in the code that IS implemented today. These break the existing webhook → message bridge path.

### 0.1 Fix session key prefix mismatch (C6)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:150-153`

**Problem:** `execute()` returns `sessionId: "kore:..."` but session store uses `agent_transfer:...`. All subsequent `endSession`/`extendTTL` calls operate on the wrong key.

**Fix:** Import `sessionKey()` from `session/types.ts` and use it:

```typescript
import { sessionKey } from '../../session/types.js';

// In execute(), replace line 152:
return {
  ...result,
  sessionId: sessionKey(payload.tenantId, payload.contactId, payload.channel),
};
```

### 0.2 Fix webhook event type not normalized (C11)

**File:** `apps/runtime/src/routes/agent-transfer-webhooks.ts:174-186`

**Problem:** Raw XO event type (`agent_message`) is passed to bridge which checks for `agent:message`. All chat messages silently dropped.

**Fix:** Use `KoreEventHandler.mapEventType()` to normalize before routing:

```typescript
import { KoreEventHandler } from '@agent-platform/agent-transfer';

// In the webhook handler, before bridge.routeAgentEvent:
const mappedType = KoreEventHandler.mapEventType(event.type) ?? event.type;

await bridge.routeAgentEvent(sessionKey, {
  type: mappedType as AgentEventType,
  // ... rest unchanged
});
```

### 0.3 Fix double-delivery in webhook handler (C12)

**File:** `apps/runtime/src/routes/agent-transfer-webhooks.ts:165-187`

**Problem:** Both `adapter.handleInboundEvent()` (which fires `onAgentMessage` callback → bridge) AND the direct `bridge.routeAgentEvent` call run, causing duplicate messages.

**Fix:** Remove the direct bridge call. Let the adapter's `onAgentMessage` callback (registered in `index.ts`) be the sole delivery path:

```typescript
// Replace lines 165-187 with:
if (typeof (adapter as any).handleInboundEvent === 'function') {
  await (adapter as any).handleInboundEvent(event, session.tenantId);
}
// Remove the direct bridge.routeAgentEvent block entirely.
// The adapter's onAgentMessage callback handles bridge routing.
```

Also add `handleInboundEvent` to the `AgentDesktopAdapter` interface to eliminate the `any` cast.

### 0.4 Fix hardcoded key format in `handleInboundEvent` (I2)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:238`

**Fix:** Import and use `sessionKey()`:

```typescript
import { sessionKey } from '../../session/types.js';

// Replace line 238:
const key = sessionKey(session['tenantId'], session['contactId'], session['channel']);
```

### 0.5 Fix empty `providerSessionId` writing blank index key (C7)

**File:** `packages/agent-transfer/src/session/lua-scripts.ts:47`

**Fix:** Add length check in the Lua script:

```lua
local providerSessionId = redis.call('HGET', sessionKey, 'providerSessionId')
if providerSessionId and #providerSessionId > 0 then
  redis.call('SET', indexKey, sessionKey)
  -- ... TTL logic
end
```

### 0.6 Fix TOCTOU in `end()` — dangling index keys (C8)

**File:** `packages/agent-transfer/src/session/transfer-session-store.ts:229-253`

**Problem:** Session can expire between `get()` and Lua script execution, leaving orphaned index key.

**Fix:** Move provider/index lookup inside the Lua script. Modify `LUA_END_SESSION` to read `provider`, `providerSessionId` from the hash before deleting:

```lua
-- LUA_END_SESSION modification:
local provider = redis.call('HGET', KEYS[1], 'provider')
local providerSessionId = redis.call('HGET', KEYS[1], 'providerSessionId')
-- Delete session hash
redis.call('DEL', KEYS[1])
-- Delete index if it existed
if provider and providerSessionId and #providerSessionId > 0 then
  local indexKey = 'at_by_provider:' .. provider .. ':' .. ARGV[1] .. ':' .. providerSessionId
  redis.call('DEL', indexKey)
end
-- SREM from active sessions and pod set
redis.call('SREM', KEYS[2], KEYS[1])
if KEYS[3] then redis.call('SREM', KEYS[3], KEYS[1]) end
return 1
```

This eliminates the `get()` call before `end()` — the Lua script handles everything atomically.

### 0.7 Fix `at_active_sessions` unbounded growth (C9)

**Problem:** Sessions expired via Redis TTL are never SREM'd from the active sessions SET.

> **NOTE:** The original approach (keyspace notifications + reconstruct index key) was found to be
> unimplementable — once the session hash expires, `providerSessionId` is lost and the
> `at_by_provider:*` index key cannot be reconstructed. See [Review Corrections](#review-corrections).

**Revised approach — two-part fix:**

**Part A: `SREM at_active_sessions` on expiry (sufficient for the unbounded growth problem)**

**File:** `apps/runtime/src/services/agent-transfer/index.ts`

Subscribe to Redis keyspace notifications and clean up the active sessions SET only (no index key reconstruction needed):

```typescript
const sub = redis.duplicate();
await sub.config('SET', 'notify-keyspace-events', 'Ex');
await sub.psubscribe('__keyevent@*__:expired');
sub.on('pmessage', async (_pattern, _channel, key) => {
  if (key.startsWith('agent_transfer:')) {
    // Only SREM from active set and pod set — index key has its own TTL
    await transferSessionStore.cleanupExpiredSession(key);
  }
});
```

`cleanupExpiredSession(key)` does:

- `SREM at_active_sessions key`
- `SREM at_pod:{hostname} key` (for all known pod hostnames, or scan `at_pod:*` sets)

The `at_by_provider:*` index key already has a matching TTL set at creation time (`LUA_CREATE_SESSION` line 51), so it self-expires. No reconstruction needed.

**Part B (optional): Store reverse mapping for index cleanup**

If eager index cleanup is desired, add a reverse mapping key at session creation:

**File:** `packages/agent-transfer/src/session/lua-scripts.ts` — in `LUA_CREATE_SESSION`:

```lua
-- After writing the index key:
if providerSessionId and #providerSessionId > 0 then
  redis.call('SET', indexKey, sessionKey)
  redis.call('SET', 'at_session_index:' .. sessionKey, indexKey)  -- reverse mapping
  if ttl > 0 then
    redis.call('EXPIRE', indexKey, ttl)
    redis.call('EXPIRE', 'at_session_index:' .. sessionKey, ttl)  -- same TTL
  end
end
```

Then on expiry notification, read the reverse mapping before it expires (it has the same TTL but may lag slightly) to find and delete the index key. This is optional — Part A alone solves the unbounded growth problem.

### 0.8 Fix non-atomic `extendTTL` pipeline (I8)

**File:** `packages/agent-transfer/src/session/transfer-session-store.ts:290-298`

**Problem:** Pipeline between `EXPIRE` and `HMSET` is not atomic — if key expires between them, `HMSET` creates ghost record.

**Fix:** Replace pipeline with a Lua script:

```lua
-- LUA_EXTEND_TTL
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[1])
if KEYS[2] then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
redis.call('HMSET', KEYS[1], 'updatedAt', ARGV[2], 'lastHeartbeat', ARGV[3])
return 1
```

Add to `lua-scripts.ts` and call from `extendTTL()`.

### 0.9 Fix `LUA_CLAIM_SESSION` CROSSSLOT violation (I10)

**File:** `packages/agent-transfer/src/session/lua-scripts.ts:124-147`

**Problem:** Pod SET keys passed as ARGV, not KEYS — fails in Redis Cluster.

**Fix:** Pass pod keys as `KEYS[2]` and `KEYS[3]`, update the caller to `numkeys=3`:

```typescript
await this.redis.evalsha(sha, 3, key, oldPodKey, newPodKey, oldHostname, newHostname, now);
```

Update Lua script to read from `KEYS[2]`/`KEYS[3]` instead of ARGV.

### 0.10 Fix dead pod SET keys never deleted (I11)

**File:** `packages/agent-transfer/src/session/session-recovery-service.ts:129`

**Fix:** In `stop()`, after draining sessions, delete the pod SET:

```typescript
async stop(): Promise<void> {
  // ... existing cleanup ...
  await this.redis.del(podSessionsKey(this.hostname));  // ADD THIS
  await this.redis.del(podHeartbeatKey(this.hostname));
}
```

### 0.11 Fix `initPromise` not cleared on failure (I18)

**File:** `apps/runtime/src/services/agent-transfer/index.ts:100-103`

**Fix:**

```typescript
initPromise = doInitializeAgentTransfer(redis, config).catch((err) => {
  initPromise = null;
  throw err;
});
```

### Tests for Phase 0

- Unit: Session key from `execute()` matches `sessionKey()` format
- Unit: Webhook handler normalizes event types before routing to bridge
- Unit: No double-delivery — only adapter callback path delivers messages
- Unit: `extendTTL` with expired key returns false, does not create ghost record
- Unit: `end()` atomically cleans up index key even if session already expired
- Integration: Full webhook → adapter → bridge → channel delivery with correct event types

---

## Phase 1: User → Agent Protocol

> Wire the missing bidirectional messaging. Currently the adapter can initiate transfers but cannot exchange messages.

### 1.1 Fix transfer initiation URL (C3)

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts:107`

**Fix:** Make the endpoint configurable, defaulting to XO's `/message`:

```typescript
// In SmartAssistConfig (config/schema.ts):
initTransferPath?: string;  // default: '/message'
eventHandlePath?: string;   // default: '/agentDesktopEventHandle'

// In initTransfer():
const path = this.config.initTransferPath ?? '/message';
const result = await this.post(path, body, 'INIT_TRANSFER');
```

### 1.2 Add missing transfer payload fields (C4)

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts:90-128`

Expand `KoreTransferPayload` and `initTransfer()` body construction:

```typescript
export interface KoreTransferPayload {
  // ... existing fields ...

  // NEW — required by XO
  source?: string; // channel type: rtm, voice, email, etc.
  conversationType?: string; // livechat, messaging, email
  skillsIds?: string[]; // numeric skill IDs (separate from skill names)
  metaInfo?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    city?: string;
    country?: string;
    customData?: Record<string, unknown>;
    agentTransferConfig?: {
      automationBotId?: string;
      inQueueFlowId?: string;
      waitingExperienceId?: string;
      noAgentsFlowId?: string;
      outOfHoursFlowId?: string;
      lastIntentName?: string;
      dialog_tone?: Array<{ tone_name: string; level: number }>;
    };
  };
  keyIntentName?: string;
  sentimentTone?: { sentiment: string; emoji?: string; strength: number };
  agentDesktopMeta?: Record<string, unknown>;
  hostDomain?: string;
  os?: string;
  device?: string;
  surveyRequired?: 'YES' | 'NO' | 'ASK' | 'REQUESTED';
  email?: {
    emailId?: string;
    toEmailId?: string;
    subject?: string;
    cc?: string[];
  };
  campaignInfo?: Record<string, unknown>;
}
```

Wire all fields into the `body` construction in `initTransfer()`.

### 1.3 Fix `accountId` mapping (C5)

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts:243-249`

**Fix:** Add `accountId` to `SmartAssistConfig`:

```typescript
// config/schema.ts:
export const SmartAssistConfigSchema = z.object({
  baseUrl: z.string().url(),  // also fixes M5
  apiKey: z.string().min(1),
  accountId: z.string().optional(),  // NEW — separate from tenantId
  // ...
});

// smartassist-client.ts:
private mapIdentity(agentId: string, contactId: string, tenantId: string): Record<string, string> {
  return {
    botId: agentId,
    userId: contactId,
    orgId: tenantId,
    accountId: this.config.accountId ?? tenantId,  // use configured or fallback
  };
}
```

### 1.4 Add `sendEvent()` to SmartAssistClient (C1, C2)

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

```typescript
export type KoreUserEventName =
  | 'start_kore_agent_chat_message_for_agent'
  | 'start_control_message_for_agent'
  | 'close_conversation';

export interface KoreUserEvent {
  eventName: KoreUserEventName;
  payload: {
    conversationId: string;
    author: { id: string; type: 'USER' };
    type?: string;
    value?: string;
    event: string;
    attachments?: Array<{ url: string; name: string; mimeType: string; size?: number }>;
  };
  queryFields: { sid: string; cId: string };
}

async sendEvent(
  sessionId: string,
  conversationId: string,
  event: KoreUserEvent,
): Promise<OperationResult<void>> {
  const basePath = this.config.eventHandlePath ?? '/agentDesktopEventHandle';
  const path = `${basePath}?sid=${encodeURIComponent(sessionId)}&cId=${encodeURIComponent(conversationId)}`;
  return this.post(path, event as unknown as Record<string, unknown>, 'SEND_USER_EVENT');
}
```

### 1.5 Wire `sendUserMessage()` and `sendControlEvent()` in KoreAdapter

**File:** `packages/agent-transfer/src/adapters/kore/index.ts`

Replace `sendUserMessage()` (lines 156–164):

```typescript
async sendUserMessage(sessionId: string, message: UserMessage): Promise<void> {
  if (!this.client) {
    throw new Error('SmartAssist client not configured');
  }

  const session = await this.resolveSession(sessionId);
  if (!session) {
    log.warn('Cannot forward user message — no active session', { sessionId });
    return;
  }

  const conversationId = session.providerSessionId;
  if (!conversationId) {
    log.warn('Cannot forward user message — no conversationId', { sessionId });
    return;
  }

  const result = await this.client.sendEvent(sessionId, conversationId, {
    eventName: 'start_kore_agent_chat_message_for_agent',
    payload: {
      conversationId,
      author: { id: session.contactId, type: 'USER' },
      type: 'text',
      value: message.content,
      event: 'user_message',
      attachments: message.attachments?.map((a) => ({
        url: a.url, name: a.name, mimeType: a.mimeType, size: a.size,
      })),
    },
    queryFields: { sid: sessionId, cId: conversationId },
  });

  if (!result.success) {
    log.error('Failed to forward user message to SmartAssist', {
      sessionId, conversationId, error: result.error,
    });
  }

  if (this.sessionStore) {
    await this.sessionStore.extendTTL(sessionId);
  }
}
```

Add `sendControlEvent()`:

```typescript
async sendControlEvent(
  sessionId: string,
  eventType: 'typing' | 'stop_typing' | 'close_agent_chat' | 'message_read' | 'message_delivered',
): Promise<void> {
  if (!this.client) return;

  const session = await this.resolveSession(sessionId);
  if (!session) return;

  const conversationId = session.providerSessionId;
  if (!conversationId) return;

  const eventName = eventType === 'close_agent_chat'
    ? 'close_conversation' as const
    : 'start_control_message_for_agent' as const;

  await this.client.sendEvent(sessionId, conversationId, {
    eventName,
    payload: {
      conversationId,
      author: { id: session.contactId, type: 'USER' },
      event: eventType,
    },
    queryFields: { sid: sessionId, cId: conversationId },
  });
}
```

Add `resolveSession()` helper and update `TransferSessionStoreHandle` to include `get()`.

### 1.6 Wire `endSession()` to notify SmartAssist (I1)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:166-171`

```typescript
async endSession(sessionId: string, reason: string): Promise<void> {
  log.info('Ending transfer session', { sessionId, reason });

  // Notify SmartAssist (skip if agent initiated the close)
  if (this.client && reason !== 'agent_closed') {
    await this.sendControlEvent(sessionId, 'close_agent_chat').catch((err) => {
      log.warn('Failed to send close event to SmartAssist', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (this.sessionStore) {
    await this.sessionStore.end(sessionId);
  }
}
```

### 1.7 Fix `checkAgentAvailability` blocking queued transfers (I4)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:274-292`

**Fix:** Skip availability check when a queue is specified:

```typescript
if (!payload.queue) {
  const availResult = await this.client.checkAgentAvailability({...});
  if (!availResult.success || !availResult.data) {
    return { success: false, status: 'no_agents', ... };
  }
}
```

### 1.8 Mark `initTransfer` as non-retryable (I5)

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

**Fix:** Add `retryable` parameter to `post()`:

```typescript
private async post<T>(path, body, operationCode, retryable = true): Promise<OperationResult<T>> {
  const fn = async () => retryable
    ? this.executeWithRetry(path, body, operationCode)
    : this.executeRequest(path, body, operationCode);
  if (this.circuitBreaker) return this.circuitBreaker.execute(fn);
  return fn();
}

// In initTransfer:
const result = await this.post(path, body, 'INIT_TRANSFER', false);
```

### 1.9 Add `agent_disconnect` to session cleanup triggers (I6)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:248`

```typescript
if (
  xoEvent.type === 'closed' ||
  xoEvent.type === 'conversation_closed' ||
  xoEvent.type === 'agent_disconnect'
) {
  // ... post-agent action / session end
}
```

### Tests for Phase 1

- Unit: `initTransfer` uses configurable path, sends all XO fields
- Unit: `sendEvent` POSTs to `agentDesktopEventHandle` with correct payload
- Unit: `sendUserMessage` resolves session, forwards message
- Unit: `sendControlEvent` maps event types to correct `eventName`
- Unit: `endSession` sends close event, then cleans up
- Unit: Queued transfers skip availability check
- Unit: `initTransfer` does not retry on failure
- Unit: `agent_disconnect` triggers cleanup

---

## Phase 2: Security Hardening

### 2.1 Fix webhook nonce using HMAC signature (C10)

**File:** `packages/agent-transfer/src/security/webhook-verification.ts:120`

**Fix:** Use `timestamp + signature` as the nonce key:

```typescript
const nonceKey = `${ts}:${computedSig}`;
const isNew = await nonceStore.markSeen(nonceKey, replayWindowMs);
```

This allows legitimate retries at different timestamps while blocking replays with identical timestamps.

### 2.2 Fix key parsing on colons in contactId (I9)

**File:** `packages/agent-transfer/src/session/transfer-session-store.ts:468-472`

**Fix:** Validate at creation time:

```typescript
// In session/types.ts sessionKey():
export function sessionKey(tenantId: string, contactId: string, channel: string): string {
  if (tenantId.includes(':') || contactId.includes(':') || channel.includes(':')) {
    throw new Error('Session key components must not contain colons');
  }
  return `agent_transfer:${tenantId}:${contactId}:${channel}`;
}
```

### 2.3 Fix rate limiter memory amplification (I12)

**File:** `packages/agent-transfer/src/security/rate-limiter.ts:27-34`

**Fix:** Use Lua script for conditional ZADD:

```lua
-- LUA_RATE_CHECK
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return count + 1
end
return -1  -- rejected, no entry added
```

### 2.4 Fix SSRF guard treating DNS failure as non-blocking (I16)

**File:** `packages/agent-transfer/src/security/ssrf-guard.ts:98-107`

**Fix:** Make DNS failure blocking:

```typescript
} catch (err) {
  if (err instanceof Error && err.message.startsWith('SSRF blocked')) {
    throw err;
  }
  throw new Error(`SSRF blocked: DNS resolution failed for ${hostname}`);
}
```

### 2.5 Fix settings routes reading tenantId from raw header (I19)

**File:** `apps/runtime/src/routes/agent-transfer-settings.ts:35-36`

**Fix:** Read from authenticated context:

```typescript
const tenantId = (req as any).tenantContext?.tenantId as string | undefined;
const projectId = (req as any).tenantContext?.projectId as string | undefined;
```

### 2.6 Add `baseUrl` protocol validation (M5)

**File:** `packages/agent-transfer/src/config/schema.ts:29`

```typescript
baseUrl: z.string().url().refine(
  (url) => url.startsWith('https://') || url.startsWith('http://'),
  { message: 'baseUrl must use http or https protocol' },
),
```

### Tests for Phase 2

- Unit: Webhook nonce accepts retries with different timestamps
- Unit: Webhook nonce rejects replays with identical timestamps
- Unit: Session key creation rejects colons in components
- Unit: Rate limiter does not add entries when limit exceeded
- Unit: SSRF guard blocks on DNS failure
- Unit: Settings route uses auth context, not raw header

---

## Phase 3: Attachment Handling

### 3.1 Add `resolveFileUrl()` to SmartAssistClient

**File:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

```typescript
async resolveFileUrl(fileId: string): Promise<OperationResult<string>> {
  const result = await this.post<{ url: string }>(
    `/api/v1/internal/files/${encodeURIComponent(fileId)}/url`,
    {},
    'RESOLVE_FILE_URL',
  );
  if (!result.success || !result.data) {
    return {
      success: false,
      error: result.error ?? { code: 'FILE_NOT_FOUND', message: 'File URL resolution failed' },
    };
  }
  return { success: true, data: result.data.url };
}
```

### 3.2 Extract attachments in KoreEventHandler

**File:** `packages/agent-transfer/src/adapters/kore/event-handler.ts`

In `processEvent()`, after building `agentEvent`:

```typescript
if (xoEvent.data?.attachments && Array.isArray(xoEvent.data.attachments)) {
  agentEvent.data.attachments = xoEvent.data.attachments;
}
```

### 3.3 Deliver attachments in MessageBridge

**File:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

In `deliverViaChatChannel()`, after main message delivery:

```typescript
const attachments = event.data?.attachments as Array<{
  fileId?: string;
  url?: string;
  fileName?: string;
  fileType?: string;
}>;
if (attachments?.length) {
  for (const attachment of attachments) {
    const fileUrl = attachment.url ?? attachment.fileId;
    if (!fileUrl) continue;
    const attachmentMessage: NormalizedOutgoingMessage = {
      sessionId: event.sessionId,
      text: attachment.fileName ?? 'Attachment',
      eventType: 'agent.attachment',
      metadata: {
        fileUrl,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        source: 'agent-transfer',
      },
    };
    await adapter.sendResponse(attachmentMessage, connection);
  }
}
```

### 3.4 Flip capability flag

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:54`

```typescript
supportsFileUpload: true,  // was: false
```

User attachments are already forwarded by Phase 1.5 (`sendUserMessage` includes `message.attachments`).

### Tests for Phase 3

- Unit: `resolveFileUrl()` calls correct endpoint
- Unit: `processEvent()` preserves attachment data
- Unit: `deliverViaChatChannel()` delivers attachments as separate messages
- Integration: Agent sends attachment → webhook → event handler → bridge → channel

---

## Phase 4: Session Store Polish

### 4.1 Add `ownerPod` to `TransferSessionStoreHandle.create` (I3)

Add `ownerPod?: string` to create params. Default to `os.hostname()` if not provided.

### 4.2 Fix double session end in `completeCsat` (I13)

**File:** `packages/agent-transfer/src/post-agent/csat-handler.ts:82-94`

Remove intermediate `update(state: 'ended')`. Emit then end:

```typescript
async completeCsat(...): Promise<void> {
  await this.emit({ type: 'csat_completed', ... });
  await this.store.end(sessionKey);
}
```

### 4.3 Guard `JSON.parse` in disposition handler (I14)

**File:** `packages/agent-transfer/src/post-agent/disposition-handler.ts:45-46, 57`

Wrap in try/catch, return null on parse failure, log corrupt data.

### 4.4 Fix timeout scheduler Map eviction (I15)

**File:** `packages/agent-transfer/src/events/session-timeout-scheduler.ts:63-68`

Cancel BullMQ job before evicting from Map:

```typescript
if (this.activeJobs.size >= MAX_ACTIVE_JOBS) {
  const oldest = this.activeJobs.keys().next().value;
  if (oldest) {
    const oldJobId = this.activeJobs.get(oldest);
    if (oldJobId) await this.queue.remove(oldJobId).catch(() => {});
    this.activeJobs.delete(oldest);
  }
}
```

### 4.5 Fix email TTL mismatch (I17)

**File:** `packages/agent-transfer/src/session/types.ts:17`

Change `email: 14400` to `email: 86400` (24hr, matching XO).

### 4.6 Fix `checkHealth` false positives (M1)

Add lightweight SmartAssist ping or check circuit breaker state.

### 4.7 Add `sourceAgentId` to tool context (M3)

Add `sourceAgentId?: string` to `TransferToolContext` and wire into payload.

### 4.8 Pipeline session listing (M6)

Use Redis pipeline for batch HGETALL instead of serial reads.

### 4.9 Add retry to timeout jobs (M7)

Set `defaultJobOptions.attempts: 3` with backoff.

### 4.10 Fix `getByProvider` numeric field casting (M8)

Return typed `TransferSessionData` instead of `Record<string, string>`.

---

## Phase 5: Test Coverage

### 5.1 Add webhook signature verification tests (T1)

Test with real secret configured. Cover: valid accepted, invalid rejected (401), missing rawBody (500), replay rejected.

### 5.2 Fix boot test mocks (T2)

Add `createTraceStoreAdapter`, `TenantScopedSessionEncryptor`, `isEncryptionAvailable` to mock factory.

### 5.3 Add end-to-end round-trip test (T3)

Webhook POST → adapter → event handler → bridge → channel delivery. Verify type normalization.

### 5.4 Add session key consistency test (T4)

Assert `sessionKey()`, `execute()` return, and webhook reconstruction produce identical keys.

### 5.5 Fix `conversation_updated` mapping (I7)

Change from `agent:message` to drop/ignore. Add test.

### 5.6 Fix `any` cast for `invalidateAuth` (M2)

Add to `AgentDesktopAdapter` interface.

### 5.7 Guard `JSON.parse` in SmartAssistClient (M4)

Wrap `JSON.parse(text)` in try/catch at line 231.

---

## Implementation Order

```
Week 1 — Correctness (Phase 0 + critical Phase 1):
  Day 1:   0.1–0.4 (key prefix, event normalization, double-delivery, hardcoded key)
  Day 2:   0.5–0.8 (Lua fixes: empty providerSessionId, TOCTOU, active set, extendTTL)
  Day 3:   0.9–0.11 (CROSSSLOT, dead pod keys, initPromise) + Phase 0 tests
  Day 4:   1.1–1.3 (transfer URL, payload fields, accountId mapping)

Week 2 — Protocol + Security (Phase 1 remainder + Phase 2):
  Day 1:   1.4–1.6 (sendEvent, sendUserMessage, sendControlEvent, endSession notify)
  Day 2:   1.7–1.9 (queued transfers, retry safety, agent_disconnect) + Phase 1 tests
  Day 3:   Phase 2 — all 6 security items + tests

Week 3 — Features + Polish (Phases 3–5):
  Day 1-2: Phase 3 (attachments both directions)
  Day 2-3: Phase 4 (session store polish — 10 items)
  Day 3:   Phase 5 (test coverage gaps)
```

---

## Verification Checklist

### Build & Tests

- [ ] `pnpm build --filter=@agent-platform/agent-transfer` passes
- [ ] `pnpm build --filter=runtime` passes
- [ ] All existing agent-transfer tests pass (no regressions)
- [ ] New unit tests cover all 43 findings

### Phase 0 — Existing Code

- [ ] `execute()` returns session key matching `sessionKey()` format
- [ ] Webhook handler normalizes XO event types to ABL format
- [ ] No duplicate message delivery via webhook path
- [ ] `extendTTL` on expired key returns false, no ghost record
- [ ] `end()` atomically cleans up index key
- [ ] `at_active_sessions` entries cleaned up on TTL expiry
- [ ] `initPromise` retryable after transient failure

### Phase 1 — Protocol

- [ ] `initTransfer` sends all required XO fields
- [ ] `sendUserMessage` POSTs to SmartAssist `agentDesktopEventHandle`
- [ ] `sendControlEvent` sends typing/close/receipt events
- [ ] `endSession` notifies SmartAssist before cleanup
- [ ] Queued transfers work when no agents online
- [ ] `initTransfer` is not retried

### Phase 2 — Security

- [ ] Webhook nonce handles at-least-once delivery
- [ ] Session keys reject colons in components
- [ ] Rate limiter rejects without recording rejected requests
- [ ] SSRF guard blocks DNS failures
- [ ] Settings routes use authenticated tenant context

### Phase 3 — Attachments

- [ ] Agent attachments delivered to user channel
- [ ] User attachments forwarded to SmartAssist

### Manual Verification

- [ ] User sends message during active transfer → agent sees it in SmartAssist desktop
- [ ] Agent sends message → user receives it via their channel
- [ ] User/bot ends session → SmartAssist shows conversation closed
- [ ] Agent sends attachment → user receives file
- [ ] Webhook replay blocked, legitimate retries accepted

---

## Dependencies & Risks

| Risk                                                                      | Mitigation                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SmartAssist event handle path — XO uses `/api/v1/internal/events/handle/` | Make path configurable; default to XO's verified path          |
| SmartAssist init path — XO uses `/api/v1/conversations?streamId=...`      | Make configurable; default to XO's verified path               |
| `accountId` may equal `tenantId` in some deployments                      | Default to tenantId when `accountId` not configured            |
| Lua script changes require Redis version compat                           | Test with Redis 6.2+ (minimum supported); Lua 5.1 compat       |
| Phase 0 fixes may temporarily break existing integrations                 | Ship Phase 0 as single atomic PR; full test suite before merge |
| Keyspace notifications require Redis `notify-keyspace-events` config      | Document in deployment guide; add health check                 |
| Control events may not be needed if SmartAssist ignores them              | Gate behind `enableControlEvents: boolean` config flag         |

---

## Review Corrections

> Added 2026-03-13 after review round 2 (3 parallel review agents verified all findings against source).

### Findings Downgraded

| Finding                                     | Original Severity | Verdict       | Reason                                                                                                                                          |
| ------------------------------------------- | ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **I19** (settings tenantId from raw header) | IMPORTANT         | **NOT A BUG** | Routes use `authMiddleware` + `requireProjectPermission` which validates tenant access. Header reading is downstream of validated auth context. |
| **M5** (baseUrl protocol validation)        | MODERATE          | **NOT A BUG** | `assertAllowedUrlSync()` in SmartAssistClient constructor already enforces protocol. Schema-level check is nice-to-have, not a gap.             |

### Findings Corrected

| Finding         | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.6 (C8)**    | TOCTOU risk is real but overstated. The index key has its own TTL, so orphans self-expire. The proposed Lua fix is an improvement but the plan must also show the updated TypeScript caller (currently passes KEYS[1-4] with no ARGV; fix adds ARGV[1] for tenantId).                                                                                                                                                                                                                                                                        |
| **0.7 (C9)**    | **Keyspace notification approach is unimplementable as described.** Once a session key expires in Redis, `providerSessionId` is lost — cannot reconstruct the `at_by_provider:*` index key for cleanup. **Revised approach:** Store a reverse mapping `at_session_index:{sessionKey} → indexKey` with matching TTL at session creation time. On expiry notification, read the reverse mapping to find and delete the index. Alternatively, accept that index keys self-expire via their own TTL and focus on `SREM at_active_sessions` only. |
| **0.8 (I8)**    | Lua guard `if KEYS[2] then` is wrong — empty string is truthy in Lua. Must use `if KEYS[2] and #KEYS[2] > 0 then`. Plan must also show the TypeScript caller update for the new Lua script.                                                                                                                                                                                                                                                                                                                                                  |
| **2.1 (C10)**   | Fix references `ts` variable outside its `if (timestampHeader)` block scope. Must restructure to ensure `ts` is available at nonce construction or use a fallback: `const nonceKey = ts ? \`${ts}:${computedSig}\` : computedSig`.                                                                                                                                                                                                                                                                                                           |
| **3.3**         | Fallback `attachment.url ?? attachment.fileId` uses fileId as URL — wrong. Must call `resolveFileUrl()` from 3.1 for fileId values.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **1.1 (C3)**    | XO's actual initChat URL is `POST {koreAgentUrl}/api/v1/conversations?streamId=...` (NOT `/message`). Default `initTransferPath` should be `/api/v1/conversations`.                                                                                                                                                                                                                                                                                                                                                                          |
| **1.4 (C1/C2)** | XO's actual event handle URL is `/api/v1/internal/events/handle/` (NOT `/agentDesktopEventHandle`). Default `eventHandlePath` should be `/api/v1/internal/events/handle/`.                                                                                                                                                                                                                                                                                                                                                                   |

### New Findings (from review round 2)

#### NEW-1: WebSocket delivery path never works (CRITICAL)

**File:** `apps/runtime/src/services/agent-transfer/index.ts:175-177`

```typescript
koreAdapter.onAgentMessage(async (event) => {
  await bridge.routeAgentEvent(event.sessionId, event);
});
```

`event.sessionId` is set to `xoEvent.conversationId` (SmartAssist's conversation ID) in `KoreEventHandler.processEvent()` at `event-handler.ts:80`. But WebSocket connections are registered with ABL session keys (`agent_transfer:{tenantId}:{contactId}:{channel}`). The `getSessionWebSocket(sessionId)` lookup uses the SmartAssist conversationId, which never matches any registered WebSocket — **all WebSocket delivery silently fails**.

**Fix:** In the `onAgentMessage` callback, resolve the ABL session key from the SmartAssist conversationId via `sessionStore.getByProvider()`, then pass the ABL key to the bridge:

```typescript
koreAdapter.onAgentMessage(async (event) => {
  const session = await transferSessionStore.getByProvider('kore', event.tenantId, event.sessionId);
  if (!session) return;
  const ablKey = sessionKey(session.tenantId, session.contactId, session.channel);
  await bridge.routeAgentEvent(ablKey, { ...event, sessionId: ablKey });
});
```

#### NEW-2: Post-agent action is always 'end' (CRITICAL)

**File:** `packages/agent-transfer/src/adapters/kore/index.ts:249`

```typescript
const postAction = (session as Record<string, unknown>)['postAgentAction'] ?? 'end';
```

`postAgentAction` is stored inside `metadata` (see `execute()` at lines 134-137), not as a top-level session field. `getByProvider()` returns `Record<string, string>` where `metadata` is a JSON-stringified blob, not individual keys. `session['postAgentAction']` is always `undefined`, so `postAction` is always `'end'` — **CSAT surveys and return-to-bot are dead code**.

**Root cause:** The `TransferSessionStoreHandle.getByProvider` wrapper in `apps/runtime/src/services/agent-transfer/index.ts:154-155` coerces all values via `String(v)`, which turns the already-parsed `metadata` object into the literal string `"[object Object]"`. Even `JSON.parse(session['metadata'])` would fail with a SyntaxError.

**Fix (two parts):**

**Part 1:** Fix the `getByProvider` handle coercion to preserve structured fields as JSON:

```typescript
// In apps/runtime/src/services/agent-transfer/index.ts, getByProvider wrapper:
return Object.fromEntries(
  Object.entries(session).map(([k, v]) => [
    k,
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
  ]),
);
```

**Part 2:** Parse the metadata in `handleInboundEvent`:

```typescript
let postAction: string = 'end';
const metadataStr = session['metadata'];
if (metadataStr) {
  try {
    const meta = JSON.parse(metadataStr);
    postAction = meta.postAgentAction ?? 'end';
  } catch {
    /* use default */
  }
}
```

**Long-term fix:** Change `TransferSessionStoreHandle.getByProvider` return type from `Record<string, string>` to `TransferSessionData` directly, eliminating the lossy coercion. This is tracked in Phase 4 item 4.10.

#### NEW-3: `TransferSessionStoreHandle.end()` discards boolean return (MODERATE)

**File:** `apps/runtime/src/services/agent-transfer/index.ts:141-143`

```typescript
end: async (key) => { await transferSessionStore!.end(key); },
```

`TransferSessionStore.end()` returns `Promise<boolean>` (false if session not found). The handle wrapper discards the return value. Callers cannot distinguish "session ended" from "session already gone".

**Fix:** Update `TransferSessionStoreHandle.end()` return type to `Promise<boolean>` and propagate the result.

#### NEW-4: Double `extendTTL` per webhook event (LOW)

In `agent-transfer-webhooks.ts`: `handleInboundEvent()` calls `extendTTL` (via adapter at index.ts:239), then the webhook handler calls `extendTTL` again at line 191. Redundant but not harmful. Low priority — remove the duplicate in the webhook handler when fixing C12 (0.3).
