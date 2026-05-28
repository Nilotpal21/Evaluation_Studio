# Display LLM "Thought" Reasoning in Studio Chat UI

## Context

When `enable_thinking` is ON, the prompt builder injects a `thought` property into every tool schema (system + regular tools). The LLM fills this in to explain its reasoning per tool call. Currently:

- **System tools** (`__handoff__`, etc.): `thought` is extracted, stripped, emitted as a `decision` trace event → goes to Observatory debug panel only, **not to chat**.
- **Regular tools**: `thought` is **not extracted at all** — it gets passed to the actual tool executor (HTTP/MCP/sandbox endpoint), wasting tokens and potentially confusing external APIs.
- **Chat UI**: Only shows `user`, `assistant`, `system` messages. No tool call or thought rendering exists.

**Goal**: Whenever any tool call (system or user-defined) includes a `thought`, surface it in the chat window as a collapsible, purple-themed card. Thoughts auto-expand during tool execution and auto-collapse when the agent's response arrives.

---

## Implementation

### Task 1: Extract `thought` from regular tool calls

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

Currently only system tools (line 550-572) strip `thought`. Add the same pattern for regular tools (around line 719, before `session.toolExecutor.execute()`):

- Extract `thought` and `reason` from `toolCall.input`
- Strip them before passing to the tool executor
- Emit a `tool_thought` trace event with `{ toolName, thought, reasoning, agent }`
- Apply to both the normal execution path (line 722) and the retry path (line 736)

Also emit `tool_thought` from the existing system tool `thought` extraction block (line 562-571), so the chat UI has **one consistent event type** to listen for regardless of tool type.

### Task 2: Add `tool_thought` to trace event type enums

**File:** `apps/runtime/src/types/index.ts` (line ~90)

- Add `| 'tool_thought'` to the `TraceEventType` union

**File:** `apps/studio/src/types/index.ts`

- Add `'tool_thought'` to `ExtendedTraceEventType` (line ~95)
- Add `'thought'` to `SessionMessage.role` union: `'user' | 'assistant' | 'system' | 'thought'`
- Add optional `toolName?: string` and `agentName?: string` to `SessionMessage.metadata`

**File:** `apps/studio/src/store/trace-store.ts` (line ~40)

- Add `'tool_thought'` to the `ALL_TYPES` array

### Task 3: Intercept `tool_thought` events in WebSocket handler

**File:** `apps/studio/src/contexts/WebSocketContext.tsx` (after line 199)

Following the existing handoff system-message pattern, add:

```typescript
if (message.event.type === 'tool_thought' && message.event.data?.thought) {
  const thoughtId = `thought-${Date.now()}-${message.event.id}`;
  addMessage({
    id: thoughtId,
    role: 'thought',
    content: message.event.data.thought,
    timestamp: new Date(message.event.timestamp),
    traceIds: [message.event.id],
    metadata: {
      toolName: message.event.data.toolName,
      agentName: message.event.data.agentName || message.event.data.agent,
    },
  });
  // Start expanded while agent is still working
  expandThought(thoughtId);
}
```

### Task 4: Track expanded thought IDs in session store

**File:** `apps/studio/src/store/session-store.ts`

- Add `expandedThoughtIds: Set<string>` to store state (default: empty)
- Add `expandThought(id: string)` action — adds ID to the set
- Add `collapseAllThoughts()` action — clears the set
- Add `toggleThought(id: string)` action — toggles ID in/out of set
- In `endStreaming()` (line 171): call `collapseAllThoughts()` — this auto-collapses all thoughts when the agent response arrives
- In `clearSession()` / `restoreSession()`: reset `expandedThoughtIds` to empty set

**File:** `apps/studio/src/contexts/WebSocketContext.tsx`

When adding a `tool_thought` message (Task 3), also call `expandThought(messageId)` so the thought starts expanded while the agent is still working.

### Task 5: Render thought messages in chat UI

**File:** `apps/studio/src/components/chat/MessageList.tsx`

Add a `ThoughtItem` component:

- **Auto-expand/collapse**: Reads `expandedThoughtIds` from session store. Starts expanded when created (during tool execution). Auto-collapses when `response_end` fires (via store). User can manually toggle.
- **Purple theme**: `bg-purple-subtle` background, `text-purple` for labels (design system HSL 262°, designated for AI/LLM elements)
- **Lightbulb icon**: Already used in `AgentConversationTree.tsx` — semantically perfect for reasoning
- **Compact layout**: Smaller avatar (`w-6 h-6`), reduced padding (`py-3`) — thoughts are supplementary, not primary conversation
- **Tool name badge**: Mono-font badge showing which tool triggered the thought
- **Expanded state**: Left purple border (`border-l-2 border-purple/20`) connecting header to thought text
- **Imports**: Add `Lightbulb`, `ChevronDown`, `ChevronRight` from `lucide-react`

In `MessageItem`, branch early: `if (message.role === 'thought') return <ThoughtItem ... />`

### Task 6: Add `tool_thought` to log formatter and replay

**File:** `apps/studio/src/utils/replay-trace-events.ts`

- Add a `case 'tool_thought'` to `formatTraceEventLog()` (line ~74):

  ```
  return { level: 'info', message: `Thought (${toolName}): ${thought.slice(0, 80)}...` }
  ```

- In `hydrateSessionStoreFromDetail()` (line 183-189), extend the role cast to include `'thought'`:
  ```
  role: m.role as 'user' | 'assistant' | 'system' | 'thought'
  ```

### Task 7: i18n keys

**File:** `packages/i18n/locales/en/studio.json`

Under `chat.messages`, add:

```json
"thought_label": "Agent Reasoning"
```

---

## Verification

1. `pnpm build` — all packages compile
2. `pnpm --filter @agent-platform/runtime test -- --run reasoning-executor` — thought extraction tests pass
3. `pnpm --filter @agent-platform/runtime test -- --run prompt-builder` — existing enable_thinking tests pass
4. `pnpm --filter @agent-platform/runtime test -- --run traveldesk` — E2E tests pass
5. Manual: Enable Thinking ON → send message that triggers tool call → verify thought card appears **expanded** during tool execution
6. Manual: When agent response arrives, verify all thought cards **auto-collapse**
7. Manual: Click collapsed thought card → verify it re-expands showing reasoning text with purple left border
8. Manual: Verify Observatory still receives `decision` events for system tools (no regression)
9. Manual: Verify regular tool executor does NOT receive `thought` in its input params
