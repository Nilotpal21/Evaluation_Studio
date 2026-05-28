# Arch Onboarding Conversation UX — Unified Message Blocks

**Date:** 2026-04-24
**Status:** Approved (rev 3 — addresses review findings)
**Scope:** `apps/studio/src/lib/arch-ai/ui/`, `apps/studio/src/app/arch/page.tsx`, `apps/studio/src/lib/arch-ai/processors/`

## Problem

During the onboarding interview flow (INTERVIEW → BLUEPRINT → BUILD), assistant messages disappear from the chat UI. Users see only their own responses and disconnected widgets, making the conversation feel like a broken form instead of a guided interview.

### Root Causes

Three interlocking defects create this behavior:

**Defect 1 — Rendering asymmetry between live and restore.**
During live streaming, the TurnEngine emits `turn_started` → `text_delta` → `interactive_tool` as separate events, creating two visual elements: an assistant text bubble and a widget bubble. But persistence stores them as ONE `StoredMessage` with both `content` (text) and `toolCalls` (widget). On session restore, both rendering surfaces use mutually exclusive branches — if `toolCall` exists, only the widget renders, and the assistant text is discarded. This affects:

- `apps/studio/src/app/arch/page.tsx:1651` (onboarding `/arch` page)
- `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx:488` (in-project overlay)

**Defect 2 — Answered widgets become invisible.**
`widget-visibility.ts:31-33` only renders an unanswered widget if its `toolCallId` matches `session.metadata.pendingInteraction.id`. When the next turn starts, `pendingInteraction` is cleared. If `toolCall.result` hasn't been set yet (race between DB write and SSE), the widget message renders as nothing — no text, no widget.

**Defect 3 — Phantom duplicate user messages.**
When the TurnEngine processes a `tool_answer`, it persists the raw answer as a standalone user message via `buffer.appendMessage('user', ...)` at `turn-engine.ts:663`. This creates a bare user bubble ("Web Chat, Voice") that duplicates the widget answer, disconnected from the question context.

### Two Live SSE Paths

The system has two distinct paths that emit widget events to the client:

1. **Engine path (durable)**: TurnEngine emits `turn_started` → `text_delta` → `interactive_tool` as typed `TurnEvent` envelopes with `turnId`/`seq`. Used for LLM-driven interview questions.

2. **Coordinator path (raw)**: `persistCoordinatorWidget()` and the BuildComplete flow emit raw `ArchSSEEvent` directly via the `emit()` callback, bypassing the TurnEngine entirely. Used for blueprint confirmation, topology approval/revision, and build completion widgets.

For the onboarding widgets in scope, the live coordinator contract must be:
`specialist?` → `text_delta(promptText)` → `tool_call`

Where `promptText` is the exact string persisted into the `StoredMessage.content` field (`options.messageText ?? payload.question ?? 'Review the next action.'`). This keeps live and restore visually identical.

Both paths hit `dispatchRawSseEvent` in `event-dispatcher.ts`. Today, the raw `tool_call` handler (line 294) always creates a NEW message with empty `content`, splitting text from widget. After this change, blank widget-only coordinator prompts are not a valid steady-state path for BlueprintConfirm, TopologyApproval, TopologyRevision, or BuildComplete.

## Design: Unified Message Blocks

Every assistant turn renders as ONE unified block: conversational text above, widget below. The block transitions through states:

### Message Block States

| State              | Visual                                                         | When                                                                        |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Streaming**      | Text streams in with typing indicator, no widget yet           | `turn_started` through `text_delta` events                                  |
| **Widget Pending** | Full text above, active interactive widget below               | `interactive_tool` or `tool_call` event arrives; `state = 'widget_pending'` |
| **Answered**       | Full text above, compacted Q&A summary below (green checkmark) | User submits widget answer; `toolCall.result` is set                        |
| **Text Only**      | Just assistant text, no widget                                 | Turn ends naturally without interactive tool                                |

### Compacted Answer Formats

| Widget Type      | Compacted Display                                           |
| ---------------- | ----------------------------------------------------------- |
| TextInput        | `"Label: value"` with checkmark                             |
| SingleSelect     | `"Label: selected option"` with checkmark                   |
| MultiSelect      | `"Label:"` followed by selected option chips with checkmark |
| Confirmation     | `"Confirmed"` or `"Declined"` with checkmark                |
| FileUpload       | `"Files: filename1, filename2"` with checkmark              |
| SecretInput      | `"Secret collected"` with lock icon                         |
| BlueprintConfirm | `"action label"` with checkmark                             |
| TopologyApproval | `"accept/request_changes/reject — notes"` with checkmark    |
| TopologyRevision | `"targets — notes"` with checkmark                          |
| BuildComplete    | `"action"` with checkmark                                   |

### Key Rules

1. **One assistant block = text + widget.** Never split across separate message objects.
2. **Answered widgets compact inline.** They never disappear. They show the Q&A summary.
3. **Widget answers do NOT generate user message bubbles.** The answer is recorded on the `toolCall.result` of the assistant message, not as a separate user message.
4. **Identical rendering live and after restore.** The same rendering path handles both SSE streaming and session snapshot restoration.

## Implementation Plan

### Layer 1: Fix the UI rendering (BOTH surfaces)

**File: `apps/studio/src/app/arch/page.tsx` (onboarding — primary surface)**

The onboarding page at line 1651 has the same mutually exclusive branch:

```
toolCall && shouldRenderToolCall
  ? <WidgetRenderer />              // text lost
  : msg.content ? <AssistantResponse /> : null
```

Change to unified rendering — assistant messages always render content first, then widget below if present:

```
msg.role === 'assistant'
  ? <>
      {(msg.content || msg.activityGroups || msg.thinkingText || msg.isStreaming)
        && <ArchAssistantResponse />}
      {toolCall && shouldRenderToolCall
        && <WidgetRenderer />}
    </>
  : <UserMessage />
```

**File: `apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx` (in-project)**

Same change at line 488. The branch structure mirrors `page.tsx`.

**File: `apps/studio/src/lib/arch-ai/ui/widget-visibility.ts`**

Remove the `pendingInteraction` guard for answered widgets. An answered widget (with `result`) should ALWAYS render in compacted form:

```
BEFORE:
  if no result → only render if pendingInteraction matches

AFTER:
  if has result → always render (compacted)
  if no result → render if pendingInteraction matches (active widget)
```

### Layer 2: Fix the event-dispatcher (BOTH SSE paths)

**File: `apps/studio/src/lib/arch-ai/ui/event-dispatcher.ts`**

**Engine path — `interactive_tool` handler (line 143):**
Instead of creating a NEW message for the widget, attach `toolCall` to the current streaming assistant message:

```
BEFORE:
  finalizeCurrentAssistantMessage(s.messages, s.currentMsgId)  // message A: text only
  create new message B with toolCall                            // message B: widget only

AFTER:
  if (s.currentMsgId) {
    // Attach toolCall to existing message A → unified text + widget
    update message A to add toolCall, set isStreaming: false
  } else {
    // No streaming message (e.g., interactive_tool with no preceding text_delta)
    create new message with toolCall (graceful fallback)
  }
  set state to widget_pending
```

**Raw coordinator path — `persistCoordinatorWidget()` / BuildComplete emit contract + `tool_call` handler (line 294):**

First, fix the emit side so user-facing coordinator widgets always establish assistant text before the widget event:

**File: `apps/studio/src/lib/arch-ai/processors/process-message.ts`**

`persistCoordinatorWidget()` should compute the exact same `promptText` used for persistence, then emit it live before `tool_call`:

```typescript
const promptText =
  options?.messageText ??
  (typeof payload.question === 'string' ? payload.question : 'Review the next action.');

if (options?.specialist) {
  emit({ type: 'specialist', name: options.specialist, icon: 'bot' });
}

emit({ type: 'text_delta', delta: `${promptText}\n\n` });
emit({ type: 'tool_call', toolCallId, toolName: 'ask_user', input: payload });

await sessionService.appendMessage(ctx, sessionId, {
  content: promptText,
  toolCalls: [{ toolCallId, toolName: 'ask_user', input: payload }],
  ...
});
```

This makes BlueprintConfirm, TopologyApproval, and TopologyRevision match the BuildComplete pattern, which already emits summary text before its widget.

Then, fix the client merge path: if there is a `currentMsgId` (from the preceding `text_delta` or `specialist` event), attach the `toolCall` to that message instead of creating a new one.

```
BEFORE (line 294):
  const messages = finalizeCurrentAssistantMessage(s.messages, s.currentMsgId);
  const toolMessage: ChatMessage = { id: new, content: '', toolCall: ... };
  return { messages: [...messages, toolMessage], ... };

AFTER:
  if (s.currentMsgId) {
    // Merge toolCall into existing message
    return {
      messages: s.messages.map(m => m.id === s.currentMsgId
        ? { ...m, toolCall: { ... }, isStreaming: false }
        : m),
      currentMsgId: null,
      state: 'widget_pending',
      ...
    };
  } else {
    // Defensive recovery only: synthesize assistant content from the widget payload
    // instead of rendering a blank widget-only message.
    const synthesizedContent =
      extractPromptText(env.input) ?? 'Review the next action.';
    return {
      messages: [
        ...s.messages,
        { content: synthesizedContent, toolCall: ..., isStreaming: false },
      ],
      ...
    };
  }
```

`extractPromptText()` should prefer `input.promptText` if present (forward-compatible), then fall back to `input.question`. The key rule is: **never append a blank `content: ''` standalone widget block for the onboarding coordinator widgets in scope.**

This covers the coordinator widgets: BlueprintConfirm, TopologyApproval, TopologyRevision, and BuildComplete.

### Layer 3: Suppress phantom user bubbles (caller-side, NOT engine)

**Decision: caller-side control in `process-message.ts` and `process-in-project.ts`.**

The TurnEngine's `RunTurnInput` interface does not carry `msg.type` — callers flatten `tool_answer` into a plain `userInput` string before calling `runTurn()`. Adding an engine-level `origin` field would widen the engine contract for a UI-only concern. Instead, suppress the visible user bubble at the caller level.

**File: `apps/studio/src/lib/arch-ai/processors/process-message.ts`**

For `tool_answer` turns that flow through `runTurn()`: the caller already calls `sessionService.setToolResult()` (line 665) to record the answer on the assistant message's `toolCall.result`. The engine's `buffer.appendMessage('user', ...)` creates the phantom bubble.

Fix: after `runTurn()` returns for a `tool_answer` turn, mark the engine-appended user message as `messageMetadata.source = 'widget_answer'` so the UI can suppress it. This avoids widening the engine contract:

```typescript
// After runTurn completes for tool_answer:
if (msg.type === 'tool_answer') {
  // Tag the engine-appended user message so the UI hides it
  await sessionService.tagLastUserMessage(ctx, session.id, {
    source: 'widget_answer',
    toolCallId: msg.toolCallId,
  });
}
```

Alternative (simpler, preferred): add a `suppressUserMessage?: boolean` flag to `RunTurnInput`. When true, the engine skips `buffer.appendMessage('user', ...)`. This is a narrow, opt-in extension — not a general `origin` field.

```typescript
// turn-engine.ts line 662:
if (!input.suppressUserMessage) {
  input.buffer.appendMessage('user', input.userContent ?? input.userInput, {
    phase: getCommittedPhase(),
    timestamp: new Date(clock()).toISOString(),
  });
}
```

Callers set `suppressUserMessage: true` when calling `runTurn()` for `tool_answer` turns. The LLM history is already served by:

- `sessionService.setToolResult()` records the answer on `toolCall.result` (used by `buildAssistantToolSections` for history)
- `appendDeterministicToolAnswerMessage()` adds a tagged user message for deterministic flows (BuildComplete, TopologyApproval)

**Recommended approach: `suppressUserMessage` flag.** It's a single boolean, the engine already has similar flags (`clientMessageId`, `llmOptions`), and it keeps the suppression decision close to the caller that knows the message type.

**File: `apps/studio/src/lib/arch-ai/processors/process-in-project.ts`**

Same change for in-project `tool_answer` turns.

**File: `apps/studio/src/lib/arch-ai/ui/hook.ts`**

In `restoreMessagesFromSession()` (line 103), filter out user messages tagged with `messageMetadata.source = 'widget_answer'` or `'deterministic_tool_answer'` to prevent phantom bubbles on restore. (The `deterministic_tool_answer` messages are already filtered in `build-llm-messages.ts` for history; they should also be filtered from the UI.)

### Layer 4: LLM history coherence (build-llm-messages.ts)

**No changes needed.** The existing `buildArchLLMMessages` and `prepareTurnHistory` already handle this correctly:

- `buildAssistantToolSections` extracts tool prompts and answers from `toolCalls`
- `selectRawMessagesForContext` includes messages with tool outcomes
- The history summary captures `capturedAnswers` from widget interactions

The LLM already sees widget Q&A pairs. The bug is UI-only.

## Scope

### In scope

- Fix onboarding `/arch` page (`apps/studio/src/app/arch/page.tsx`) — primary onboarding surface
- Fix in-project ArchOverlay (`apps/studio/src/lib/arch-ai/components/arch/overlay/ArchOverlay.tsx`)
- Fix event-dispatcher for BOTH engine `interactive_tool` AND raw `tool_call` paths
- Fix widget-visibility to always render answered widgets
- Suppress phantom user messages via `suppressUserMessage` flag in engine + caller-side control
- Filter `widget_answer` / `deterministic_tool_answer` user messages from UI restore
- Verify session restore renders identically to live streaming

### Out of scope

- LLM history building (already correct)
- New widget types
- Mobile responsiveness
- Engine-level `origin` field (rejected — too wide for a UI concern)

## Design Decisions

### D1: Source of truth for raw coordinator widgets

**Decision: emit prompt text before raw `tool_call`, then merge in event-dispatcher.**

Rationale: `persistCoordinatorWidget()` already stores a unified `StoredMessage` with both `content` and `toolCalls`. The live path should use the exact same `promptText` before the widget event so the client can merge into the current assistant message and match restore behavior. The event-dispatcher still keeps a defensive synthesis fallback for malformed/future events, but blank widget-only coordinator prompts are not acceptable for the onboarding flows in scope.

### D2: Where tool_answer suppression lives

**Decision: `suppressUserMessage` boolean on `RunTurnInput`, set by callers.**

Rationale: The engine has no knowledge of `msg.type` — callers flatten `tool_answer` into `userInput` before `runTurn()`. Adding a general `origin` field would widen the engine contract for a concern that only matters for UI rendering. A narrow `suppressUserMessage` flag is opt-in, has no effect on LLM behavior (the user turn is still added to `runningMessages` for the LLM call), and keeps the decision with the caller who knows the message type.

## Risk Assessment

| Risk                                              | Mitigation                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking onboarding page                          | Fix both `page.tsx` AND `ArchOverlay.tsx` — same pattern                                                                                                                           |
| Coordinator widgets still split live              | Emit exact persisted `promptText` before raw `tool_call`, then merge in event-dispatcher; defensive fallback synthesizes text from payload instead of blank widget-only blocks     |
| Widget answer submission regression               | `sendToolAnswer` flow unchanged; only the visual rendering of answered state changes                                                                                               |
| `suppressUserMessage` silently drops LLM context  | Flag only suppresses `buffer.appendMessage` (persistence). The engine still adds the user turn to `runningMessages` (line 718-721) for the live LLM call. LLM context unaffected.  |
| Existing sessions with old split/phantom messages | Graceful degradation: unified blocks show widget without preceding text; phantom user messages with missing `messageMetadata` still render (no crash, just cosmetically imperfect) |
| Optimistic rollback regression                    | `streamPost()` in `hook.ts:313` still captures and restores tool_answer rollback state; no changes to that path                                                                    |

## Test Plan

### Core flows

1. **Live onboarding (interview)**: Start fresh session → verify assistant text + widget render together → answer widget → verify compacted answer + text preserved → verify NO duplicate user bubble
2. **Page refresh**: Complete 3+ interview questions → refresh page → verify all assistant text preserved with compacted answers
3. **Widget types**: Test TextInput, SingleSelect, MultiSelect, Confirmation, FileUpload, SecretInput

### Coordinator-driven widgets (highest risk)

4. **BlueprintConfirm live**: Reach BLUEPRINT phase → verify confirm widget renders with context text → answer → verify compacted
5. **TopologyApproval live**: Generate draft → verify approval widget renders with text → accept/reject/request_changes → verify compacted
6. **TopologyRevision live**: Request changes → verify revision widget renders → submit revision → verify compacted
7. **BuildComplete live**: Complete build → verify completion card renders with summary text → choose action → verify compacted
8. **Blueprint/Build refresh**: Reach each widget type → refresh → verify restored with text + answer

### Edge cases

9. **In-project overlay**: Open overlay → send message → verify same unified rendering
10. **Failed tool_answer submission**: Answer widget → simulate network error → verify optimistic rollback restores widget_pending state with text preserved
11. **Old session data**: Load session with split messages (no `messageMetadata`) → verify graceful rendering (widget shows, no crash)
12. **Malformed coordinator event / dropped text prelude**: Trigger a coordinator widget with missing preceding `text_delta` → verify the client synthesizes assistant text from `question`/`promptText` and never renders a blank widget-only block
