# Contact Center Arrival Summary — Gap Analysis & Resolution

**Date:** 2026-04-28  
**Updated:** 2026-04-30  
**Author:** srinivasarao.yasarla  
**Scope:** KoreServer → KoreAgentAssist conversation summary flow vs. ABL Platform integration  
**Status:** Implemented — changes shipped in branch `agent-transfer-message-persistence`

---

## 1. Executive Summary

When a KoreServer-powered bot escalates to a human agent, the Contact Center desktop receives an **Arrival Summary** — an LLM-generated overview of the conversation — moments after the agent accepts the transfer. When an ABL Platform agent escalated, the Arrival Summary was **empty**.

This document explains the complete flow, the three root causes, and the fixes applied across both KoreAgentAssist and ABL Platform. A secondary issue — `orgId`/`accountId` not being persisted to the connection metadata — was also resolved.

---

## 2. Working Path — KoreServer → KoreAgentAssist

### 2.1 Transfer initiation (KoreServer)

`AgentTransferExecutor.js` collects:

| Field                                          | Source             | Purpose                        |
| ---------------------------------------------- | ------------------ | ------------------------------ |
| `botSessionId`                                 | Active session ID  | Key for chatHistory API lookup |
| `metaInfo.agentTransferConfig`                 | Bot config         | Queue ID, skills, routing      |
| `metaInfo.conversationSummaryForAgentTransfer` | LLM pre-generation | Pre-computed summary text      |
| `metaInfo.chatHistoryUrl`                      | Constructed URL    | Fallback history fetch         |
| `metaInfo.sentiment`                           | NLP result         | Customer sentiment             |

`koreAgent/index.js:4033` — POST to KoreAgentAssist:

```json
{
  "orgId": "...",
  "userId": "...",
  "botId": "...",
  "botSessionId": "sess_abc123",
  "source": "kore",
  "metaInfo": {
    "agentTransferConfig": { "queueId": "..." },
    "conversationSummaryForAgentTransfer": "Customer asked about...",
    "chatHistoryUrl": "https://kore-host/api/1.1/botmessages/..."
  }
}
```

`BaseAgentExecutor.js:initialMessageToAgent()` immediately sends the pre-computed summary as a text message into the agent console.

### 2.2 KoreAgentAssist — `updateArrivalSummaryForConversation()` (`utils.js:208`)

Guard check (line 232):

```js
if (userId && botId && botSessionId && arrivalSummaryEnabled) {
  // proceed to generate summary
}
```

Flow when guard passes:

1. `GET {KORE_HOST}/api/1.1/botmessages/agentAssist/chatHistory?sessionId={botSessionId}` → returns full message list in KoreServer format
2. `generateConversationStringForResolutionComments(chatHistory)` → builds transcript string
3. POST to ML API (`/nlp/analyzeDialogue`) → returns `summary: ["..."]`
4. Store `conversation.summary = [...]` in MongoDB
5. On `conversation_accept`: Socket.IO emits full conversation (with `summary[]`) to agent desktop

### 2.3 Message format handled by `generateConversationStringForResolutionComments()` (`utils.js:454`)

```js
// KoreServer message format — only this is supported
const role =
  message.author.type === 'USER' ? 'Customer' : message.author.type === 'AGENT' ? 'Agent' : 'Bot';
const text = message.components[0]?.data?.text;
return `${role}:${text}`;
```

---

## 3. Root Cause Analysis

### Root Cause 1 — Guard fails: no `botSessionId` (Critical)

ABL does not send `botSessionId`. The guard at `utils.js:232`:

```js
if (userId && botId && botSessionId && arrivalSummaryEnabled) {
```

evaluates to `false` → `updateArrivalSummaryForConversation()` exits immediately → `conversation.summary = []` → `asGenerationFailed: true`.

Summary generation is **never attempted**.

### Root Cause 2 — `KORE_HOST` chatHistory API call would fail (Critical)

Even if the guard were bypassed, KoreAgentAssist calls:

```js
GET {KORE_HOST}/api/1.1/botmessages/agentAssist/chatHistory?sessionId={botSessionId}
```

ABL Platform does not expose this endpoint. The call returns 404 → empty chatHistory → summary skipped.

`conversation.metaInfo.conversationHistory` (which already contains the full history) was **never checked or used**.

### Root Cause 3 — Format mismatch in string formatter (Secondary)

`generateConversationStringForResolutionComments()` reads:

```js
message.author.type; // "USER" | "BOT" | "AGENT"
message.components[0]?.data?.text;
```

ABL sends:

```js
message.role; // "user" | "assistant"
message.content; // plain string
```

Every ABL message was silently skipped → empty transcript string → ML API not called with meaningful content.

### Root Cause 4 — Timing race condition (Critical)

In KoreAgentAssist `triggerQueueTransferFlow` (controller line 543), routing fires asynchronously — agents who accepted the transfer quickly received `summary = []` because the async ML summarization had not yet completed when `conversation_accept` was emitted.

---

## 4. Gap Summary

| Check                                      | KoreServer                                | ABL Platform (before fix)   | Result                        |
| ------------------------------------------ | ----------------------------------------- | --------------------------- | ----------------------------- |
| `botSessionId` present                     | ✓                                         | ✗                           | Guard fails, summary skipped  |
| `KORE_HOST` chatHistory reachable          | ✓                                         | ✗ (endpoint doesn't exist)  | 404 if guard bypassed         |
| Inline `conversationHistory` in `metaInfo` | ✗ (not sent)                              | ✓ (sent, stored in MongoDB) | Available but never read      |
| Message format matches formatter           | ✓ (`author.type` / `components`)          | ✗ (`role` / `content`)      | Empty transcript even if read |
| Pre-computed summary in `metaInfo`         | ✓ (`conversationSummaryForAgentTransfer`) | ✗                           | No fast-path fallback         |
| Timing: summary seeded before routing      | ✓ (sync pre-generation)                   | ✗                           | Race condition on fast accept |

---

## 5. Fixes Applied

### 5.1 KoreAgentAssist — `src/utils/utils.js`

**Relaxed guard + inline history path** in `updateArrivalSummaryForConversation()`:

```js
const inlineHistory = conversation.metaInfo?.conversationHistory;
const hasInlineHistory = Array.isArray(inlineHistory) && inlineHistory.length > 0;
const summarySessionId = botSessionId || conversationId.toString();

// Guard changed from: if (userId && botId && botSessionId && arrivalSummaryEnabled)
if (userId && botId && (botSessionId || hasInlineHistory) && arrivalSummaryEnabled) {
  let conversationString;
  if (hasInlineHistory) {
    conversationString = generateConversationStringFromABLHistory(inlineHistory);
  } else {
    // existing KORE_HOST fetch path — unchanged
  }
  // summarySessionId used as ML API key fallback when botSessionId absent
}
arrivalSummary = _.get(resolutionResponse, `summary.${summarySessionId}.Summary`, []);
```

**New function** for ABL message format:

```js
function generateConversationStringFromABLHistory(history) {
  let conversationString = '';
  _.each(history, function (message) {
    const text = (message.content || '').trim();
    if (!text) return;
    if (message.role === 'user') {
      conversationString += `Customer:${text}\n`;
    } else if (message.role === 'assistant') {
      conversationString += `Bot:${text}\n`;
    }
  });
  return conversationString.trim();
}
```

### 5.2 KoreAgentAssist — `src/controllers/conversation.controller.js`

**Synchronous summary seeding** to fix the timing race condition. After `saveConversation()` and before routing fires:

```js
const precomputedSummary = reqBody?.metaInfo?.conversationSummaryForAgentTransfer;
if (precomputedSummary && !(conversation.summary && conversation.summary.length)) {
  await conversationService.updateConversation(conversation._id, {
    summary: [precomputedSummary],
    asGenerationFailed: false,
  });
  conversation.summary = [precomputedSummary];
}
```

The async ML summarization still runs and overwrites with an NLP-quality summary when complete. The pre-computed summary is a plain-text fallback that eliminates the race window.

### 5.3 ABL Platform — Pre-computed transfer summary

**`apps/runtime/src/services/execution/llm-wiring.ts`**

Added `buildTransferSummaryFromHistory()` (pure function, no LLM call, zero latency):

```ts
const TRANSFER_SUMMARY_MAX_CHARS = 2000;

function buildTransferSummaryFromHistory(
  history: Array<{ role: string; content: string }>,
): string | undefined {
  if (history.length === 0) return undefined;
  const lines = history
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content.trim()}`)
    .join('\n');
  return lines.length > TRANSFER_SUMMARY_MAX_CHARS
    ? `${lines.slice(0, TRANSFER_SUMMARY_MAX_CHARS)}...`
    : lines;
}
```

`getContext()` computes and returns `conversationSummaryForAgentTransfer` from the transfer history.

**Type chain propagation** (`conversationSummaryForAgentTransfer?: string` added to):

- `TransferToolContext` — `packages/agent-transfer/src/tools/transfer-to-agent.ts`
- `TransferPayload` — `packages/agent-transfer/src/types.ts`
- `KoreTransferPayload` and `metaInfo` — `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`
- Kore adapter `initTransfer` call — `packages/agent-transfer/src/adapters/kore/index.ts`

### 5.4 ABL Platform — `orgId` / `accountId` connection metadata persistence

`getAccountIdByBotId` in `smartassist-client.ts` previously discarded the `accountId` field from the API response. Both fields are now returned and handled:

**`smartassist-client.ts`** — return type changed from `OperationResult<string>` to `OperationResult<{ orgId: string; accountId?: string }>`:

```ts
const accountId = (data.accountId as string) || undefined;
return { success: true, data: { orgId, accountId } };
```

**`kore/index.ts`** — `resolveOrgId()` caches both fields in-memory and passes both to the callback:

```ts
const { orgId, accountId } = result.data;
this.smartAssistConfig!.orgId = orgId;
if (accountId) this.smartAssistConfig!.accountId = accountId;
await this.onOrgIdResolved(orgId, accountId);
```

**`routing-executor.ts`** — wires `setOnOrgIdResolved` after `initAdapter.initialize()` to persist into MongoDB:

```ts
if (initAdapter instanceof KoreAdapter) {
  initAdapter.setOnOrgIdResolved(async (orgId, accountId) => {
    const updatedMetadata = { ...connectionMetadata, orgId, ...(accountId ? { accountId } : {}) };
    await ConnectorConnection.findOneAndUpdate(
      { _id: writeBackConnectionId, tenantId: writeBackTenantId },
      { $set: { metadata: updatedMetadata } },
    );
  });
}
```

On the next transfer, `connectionMetadata` already contains `orgId`/`accountId`, so `KoreAdapter.initialize()` sets them from `auth` and `resolveOrgId()` returns early — no extra API call.

---

## 6. End-to-End Flow After Fix

```
ABL agent transfer initiated
  │
  ▼
llm-wiring.ts: buildTransferSummaryFromHistory(transferHistory)
  └─ Returns plain-text transcript (zero latency, no LLM)
  │
  ▼
POST /agentassist/api/v1/conversations/
  metaInfo.conversationHistory: [{role, content}, ...]
  metaInfo.conversationSummaryForAgentTransfer: "Customer: I need help...\nAgent: ..."
  (no botSessionId needed)
  │
  ▼
conversation.controller.js: saveConversation()
  └─ Synchronously seeds conversation.summary = [precomputedSummary]
  └─ Routing fires AFTER summary is already set  ← race condition eliminated
  │
  ▼
triggerQueueTransferFlow() → agent routed to queue
  │
  ▼
updateArrivalSummaryForConversation() (async, runs after routing)
  ├─ hasInlineHistory = true  ← new check
  ├─ generateConversationStringFromABLHistory(inlineHistory)
  │    → "Customer:I need help with my account\nBot:I can help with that..."
  ├─ POST to ML API /nlp/analyzeDialogue
  │    → { summary: ["Customer enquired about account..."] }
  └─ conversation.summary = ["Customer enquired about account..."]  ← overwrites with NLP quality
  │
  ▼
Agent accepts transfer (conversation_accept)
  └─ Socket.IO emits conversation with summary[] → agent desktop  ✓
```

---

## 7. Files Changed

### KoreAgentAssist (`koreagentassist` repo, branch `feature/abl-arrival-summary`)

| File                                         | Change                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `src/utils/utils.js`                         | Relax guard, inline history path, `summarySessionId` fallback          |
| `src/utils/utils.js`                         | New `generateConversationStringFromABLHistory()` function              |
| `src/controllers/conversation.controller.js` | Synchronous summary seeding from `conversationSummaryForAgentTransfer` |

### ABL Platform (`abl-platform` repo, branch `agent-transfer-message-persistence`)

| File                                                              | Change                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/llm-wiring.ts`               | `buildTransferSummaryFromHistory()` + populate `conversationSummaryForAgentTransfer` in context      |
| `packages/agent-transfer/src/types.ts`                            | `conversationSummaryForAgentTransfer?: string` on `TransferPayload`                                  |
| `packages/agent-transfer/src/tools/transfer-to-agent.ts`          | `conversationSummaryForAgentTransfer?: string` on `TransferToolContext`                              |
| `packages/agent-transfer/src/adapters/kore/index.ts`              | Pass-through to `initTransfer`; updated `onOrgIdResolved` signature; cache `accountId`               |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts` | `getAccountIdByBotId` returns `{ orgId, accountId }`; `metaInfo.conversationSummaryForAgentTransfer` |
| `apps/runtime/src/services/execution/routing-executor.ts`         | Wire `setOnOrgIdResolved` to persist `orgId`/`accountId` to `ConnectorConnection.metadata`           |
