# Chat CSAT Survey Implementation Plan

## Overview

This document describes the end-to-end implementation of CSAT (Customer Satisfaction Survey)
rendering and submission for the ABL Platform chat channel. When a SmartAssist human agent closes
a conversation, SmartAssist sends a CSAT event containing the survey prompt and survey type. ABL
renders an interactive rating widget in the user chat window and submits the rating back to
SmartAssist's CSAT API.

---

## Background

### How KoreServer handles CSAT

1. Agent closes conversation → SmartAssist fires `start_kore_agent_chat_message_for_user` with
   `csatRequested: true`, `csatMessage.value`, `surveyType`, and `dialogDetails`.
2. KoreServer sends the CSAT text to the user, then triggers `trigger_dialog_from_agent` which
   runs a bot dialog that collects the rating.
3. The bot dialog's service node POSTs the rating to SmartAssist at
   `POST {smartassistUrl}/api/v1/csatResponse/save`.

### ABL Platform approach (Option B — Custom UI)

ABL does not use KoreServer's bot dialog mechanism. Instead:

1. The CSAT event arrives via SmartAssist webhook → runtime → WebSocket → Studio.
2. Studio renders a native rating widget (stars / thumbs / NPS numbers) inside the chat window.
3. On user submission, Studio calls the runtime which forwards the rating to SmartAssist's CSAT API.

### SmartAssist CSAT Submission API

- **Endpoint**: `POST {smartassistUrl}/api/v1/csatResponse/save`
- **Auth**: Internal apikey header (same as other SmartAssist client calls)
- **Request body**:

| Field        | Required | Description                                               |
| ------------ | -------- | --------------------------------------------------------- |
| `userId`     | Yes      | SmartAssist user ID — from `data.userId` in event         |
| `channel`    | Yes      | Source channel — from `data.source` (e.g. `"rtm"`)        |
| `botId`      | Yes      | SmartAssist bot/instance ID — from `data.iId`             |
| `score`      | Yes      | User rating (1–5 for CSAT, 0–10 for NPS, 0/1 for thumbs)  |
| `surveyType` | No       | `"csat"` \| `"nps"` \| `"likeDislike"` (default `"csat"`) |
| `comments`   | No       | Optional free-text comment from user                      |

- **Response**: 200 OK with gratitude message text.

### Event payload fields used

All fields below are available in the `data` object of the `agent_transfer_event` WebSocket message:

| Event Field         | Used For                             |
| ------------------- | ------------------------------------ |
| `csatRequested`     | Gate CSAT rendering (must be `true`) |
| `csatMessage.value` | Survey prompt text shown to user     |
| `surveyType`        | Determines widget type               |
| `userId`            | Submission payload                   |
| `iId`               | `botId` in submission payload        |
| `source`            | `channel` in submission payload      |
| `conversationId`    | Stored in csatData for context       |
| `orgId`             | Stored in csatData for context       |

---

## Survey Widget Types

| `surveyType`  | Widget                            | Score range |
| ------------- | --------------------------------- | ----------- |
| `csat`        | 5 emoji buttons (😞😐😊😄🤩)      | 1 – 5       |
| `likeDislike` | Thumbs Up / Thumbs Down buttons   | 1 / 0       |
| `nps`         | Row of 11 number buttons (0 – 10) | 0 – 10      |

---

## Data Flow

```
SmartAssist webhook (start_kore_agent_chat_message_for_user)
  ↓
Runtime agent-transfer-webhooks.ts
  ↓
event-handler.ts → processEvent()
  → data.csatMessage, csatRequested, surveyType preserved in AgentEvent.data
  ↓
message-bridge.ts → deliverViaWebSocket()
  → { type: 'agent_transfer_event', event: { type: 'agent:message', data } }
  ↓
Studio WebSocketContext.tsx
  → emits plain text message (csatMessage.value)
  → emits CSAT message with csatData in metadata
  ↓
PreviewMessageList.tsx
  → detects message.csatData → renders <CsatRatingCard>
  ↓
User selects rating + optional comment → clicks Submit
  ↓
Studio POST /api/projects/[id]/agent-transfer/csat/submit
  ↓ (proxy)
Runtime POST /api/v1/agent-transfer/csat/submit
  ↓
KoreAdapter.submitCsatRating()
  ↓
SmartAssistClient.submitCsatRating()
  ↓
POST {smartassistUrl}/api/v1/csatResponse/save
```

---

## Implementation Phases

### Phase 1 — SmartAssist Client

**File**: `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

Add `submitCsatRating()` method following the same pattern as `sendEvent()`:

```ts
async submitCsatRating(params: {
  userId: string;
  channel: string;
  botId: string;
  score: number;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  comments?: string;
}): Promise<OperationResult<{ message?: string }>>
```

- POST to `{baseUrl}/api/v1/csatResponse/save`
- Auth via `koreApiKey` / `apiKey` header (same as `getAccountIdByBotId`)
- Return gratitude message from response body

---

### Phase 2 — KoreAdapter

**File**: `packages/agent-transfer/src/adapters/kore/index.ts`

Expose CSAT submission on the adapter class so the runtime route can call it without
importing the SmartAssist client directly:

```ts
async submitCsatRating(params: {
  userId: string;
  channel: string;
  botId: string;
  score: number;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  comments?: string;
}): Promise<OperationResult<{ message?: string }>>
```

Add method to `AgentDesktopAdapter` interface in
`packages/agent-transfer/src/adapters/interface.ts` as optional:

```ts
submitCsatRating?(params: CsatRatingParams): Promise<OperationResult<{ message?: string }>>;
```

---

### Phase 3 — Runtime Route

**New file**: `apps/runtime/src/routes/agent-transfer-csat.ts`

```
POST /api/v1/agent-transfer/csat/submit
```

Request body (Zod validated):

```ts
{
  provider: z.string().min(1),
  sessionKey: z.string().min(1),
  userId: z.string().min(1),
  channel: z.string().min(1),
  botId: z.string().min(1),
  score: z.number().int().min(0).max(10),
  surveyType: z.enum(['csat', 'nps', 'likeDislike']).default('csat'),
  comments: z.string().max(1000).optional(),
}
```

Handler:

1. Auth via `requireAuth`
2. Tenant isolation — verify `tenantId` from auth matches session
3. Look up adapter by `provider` from `getAdapterRegistry()`
4. Call `adapter.submitCsatRating(params)`
5. Return `{ success: true, message: gratitudeText }` or structured error

**`apps/runtime/src/server.ts`**: Register the new router:

```ts
import agentTransferCsatRouter from './routes/agent-transfer-csat.js';
app.use('/api/v1/agent-transfer/csat', agentTransferCsatRouter);
```

---

### Phase 4 — Studio Proxy Route

**New file**: `apps/studio/src/app/api/projects/[id]/agent-transfer/csat/submit/route.ts`

Follows the same pattern as `sessions/route.ts`:

- `POST` handler with `withRouteHandler({ requireProject: true, permissions: StudioPermission.CONNECTION_READ })`
- Proxies to `{runtimeUrl}/api/v1/agent-transfer/csat/submit`
- Forwards `Authorization` and `X-Tenant-Id` headers
- Body passed through as JSON

---

### Phase 5 — WebSocketContext

**File**: `apps/studio/src/contexts/WebSocketContext.tsx`

Replace the current `csatRequested` block that adds a plain text message with one that adds
a **CSAT message** carrying `csatData` in metadata:

```ts
if (transferEvent.data?.csatRequested) {
  const csatMessage = transferEvent.data.csatMessage as { value?: string } | undefined;

  addMessage({
    id: `agent-transfer-csat-${Date.now()}`,
    role: 'assistant',
    content: csatMessage?.value ?? 'Please rate your experience.',
    timestamp: new Date(),
    traceIds: [],
    csatData: {
      provider: 'smartassist',
      userId: transferEvent.data.userId as string,
      botId: transferEvent.data.iId as string,
      channel: (transferEvent.data.source as string) ?? 'rtm',
      surveyType: (transferEvent.data.surveyType as 'csat' | 'nps' | 'likeDislike') ?? 'csat',
      conversationId: transferEvent.data.conversationId as string,
      orgId: transferEvent.data.orgId as string,
    },
  });
}
```

---

### Phase 6 — Type Definitions

**File**: `apps/studio/src/components/preview/preview-chat-utils.ts`

```ts
export interface CsatData {
  provider: string;
  userId: string;
  botId: string;
  channel: string;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  conversationId: string;
  orgId: string;
}

export interface PreviewChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  richContent?: RichContent;
  actions?: ActionSet;
  authChallenge?: AuthChallengeMessage;
  csatData?: CsatData; // ← new
}
```

---

### Phase 7 — CsatRatingCard Component

**New file**: `apps/studio/src/components/preview/CsatRatingCard.tsx`

#### Props

```ts
interface CsatRatingCardProps {
  prompt: string;
  csatData: CsatData;
  projectId: string;
}
```

#### States

```
idle → rating selected → (optional) comment entered → submitting → submitted | error
```

#### Rendering by surveyType

**`csat`** — 5 emoji buttons:

```
😞   😐   😊   😄   🤩
 1    2    3    4    5
```

**`likeDislike`** — two buttons:

```
👍 Yes    👎 No
```

**`nps`** — 11 number buttons in a row:

```
0  1  2  3  4  5  6  7  8  9  10
```

With labels: `Not at all likely` ← → `Extremely likely`

#### After rating selected

- Show optional comments textarea (max 500 chars)
- Show Submit button

#### On submit

```ts
const res = await fetch(`/api/projects/${projectId}/agent-transfer/csat/submit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({
    provider: csatData.provider,
    userId: csatData.userId,
    channel: csatData.channel,
    botId: csatData.botId,
    score: selectedScore,
    surveyType: csatData.surveyType,
    comments: comment || undefined,
  }),
});
```

#### On success

Replace widget with gratitude message text returned from API (e.g. "Thank you for your feedback!").

#### On error

Show inline error: "Failed to submit. Please try again." with retry button.

#### Accessibility

- `role="group"` on the rating buttons container
- `aria-label` on each rating button
- `aria-pressed` on selected rating button
- Focus management after submit

---

### Phase 8 — PreviewMessageList

**File**: `apps/studio/src/components/preview/PreviewMessageList.tsx`

Add CSAT branch before the `assistant` branch:

```tsx
} : message.csatData ? (
  <CsatRatingCard
    prompt={message.content}
    csatData={message.csatData}
    projectId={projectId}
  />
) : message.role === 'assistant' ? (
```

`projectId` must be threaded into `PreviewMessageListProps` (already available in parent pages).

---

## Files Changed

### New Files (5)

| File                                                                        | Purpose                                |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `apps/runtime/src/routes/agent-transfer-csat.ts`                            | Runtime POST route for CSAT submission |
| `apps/studio/src/app/api/projects/[id]/agent-transfer/csat/submit/route.ts` | Studio proxy route                     |
| `apps/studio/src/components/preview/CsatRatingCard.tsx`                     | Interactive rating widget              |

### Modified Files (7)

| File                                                              | Change                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/agent-transfer/src/adapters/interface.ts`               | Add optional `submitCsatRating?` to `AgentDesktopAdapter` |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts` | Add `submitCsatRating()` method                           |
| `packages/agent-transfer/src/adapters/kore/index.ts`              | Expose `submitCsatRating()` on `KoreAdapter`              |
| `apps/runtime/src/server.ts`                                      | Register `agent-transfer-csat` router                     |
| `apps/studio/src/contexts/WebSocketContext.tsx`                   | Emit `csatData` instead of plain text for CSAT events     |
| `apps/studio/src/components/preview/preview-chat-utils.ts`        | Add `CsatData` type and `csatData` field                  |
| `apps/studio/src/components/preview/PreviewMessageList.tsx`       | Render `CsatRatingCard` for CSAT messages                 |

---

## Commit Strategy

Max 3 packages per commit, one concern per commit:

| #   | Commit message                                                                           | Packages         | Files                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| 1   | `feat(agent-transfer): add CSAT rating submission to SmartAssist client and KoreAdapter` | `agent-transfer` | `interface.ts`, `smartassist-client.ts`, `kore/index.ts`                              |
| 2   | `feat(runtime): add POST /api/v1/agent-transfer/csat/submit route`                       | `runtime`        | `agent-transfer-csat.ts`, `server.ts`                                                 |
| 3   | `feat(studio): render CSAT rating widget in chat window after agent disconnect`          | `studio`         | proxy route, WebSocketContext, preview-chat-utils, CsatRatingCard, PreviewMessageList |

---

## Out of Scope

- NPS follow-up question based on score range (KoreServer logic)
- CSAT for voice / messaging channels (chat only in this plan)
- Storing CSAT responses in ABL's own database
- CSAT analytics dashboard

---

## Open Questions

| #   | Question                                                                                                        | Impact |
| --- | --------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Does SmartAssist `source` field always equal `"rtm"` for web chat sessions? Affects `channel` submission field. | Medium |
| 2   | Should comments be shown for all survey types or only `csat`?                                                   | Low    |
| 3   | What is the exact gratitude message format returned by SmartAssist? Is it plain text or structured?             | Low    |
