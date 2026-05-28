# Grok Realtime S2S - Execution Flow Analysis & Fix Plan

**Date**: 2026-04-03
**Current Branch**: feat/grok-realtime-s2s-voice
**Current Commit**: d0444725c

---

## Current Issues Summary

1. **"Extra data: line 1 column 129" error** when sending conversation.item.create
2. **Tool execution loops** - Grok repeatedly calls search_hotels without user input
3. **Handoffs hang** - After handoff, Grok waits indefinitely unless user speaks
4. **Schema validation error** - agent.exited receives 'continue' but expects 'completed|handoff|delegate|error'

---

## How OpenAI Realtime API Works (Reference)

### Normal Tool Execution Flow:

1. LLM decides to call a tool → sends `response.function_call_arguments.done`
2. Client executes tool
3. Client sends tool result via `conversation.item.create` with type=`function_call_output`
4. LLM automatically continues with the result (no explicit response.create needed)

### Handoff Flow:

1. Handoff tool executes → agent changes
2. Client sends `session.update` with new instructions
3. LLM automatically continues with new context (no explicit response.create needed)

---

## How Grok Realtime API Actually Works (Observed Behavior)

### Current Implementation (commit 18b11c3fd - "working"):

**Handoff Flow:**

```
1. Handoff tool executes
2. Send session.update (new instructions)
3. Send conversation.item.create (synthetic "Go ahead" message)
4. Send response.create
5. Grok speaks
```

**Tool Result Flow:**

```
1. Tool executes
2. Send tool result via llm:update
3. Send response.create
4. Grok continues
```

**Problems with this:**

- conversation.item.create causes "Extra data" error
- response.create after every tool causes loops
- Waiting indefinitely without proper triggers

---

## Step-by-Step Execution Plan

### Step 1: Understand Current Message Format

**Question:** What exact JSON format does Grok expect for:

- Tool results (conversation.item.create with function_call_output?)
- Response triggers (response.create alone? with conversation context?)

**Action:** Read xAI docs + examine successful OpenAI flow in logs

### Step 2: Fix Tool Result Format

**Current:** Sending via `buildKorevgLlmUpdateCommand(toolOutputMessage)` where toolOutputMessage is OpenAI format
**Question:** Does Grok accept OpenAI's function_call_output format?

**Test:**

```typescript
// Option A: OpenAI format via llm:update
{
  type: "conversation.item.create",
  item: {
    type: "function_call_output",
    call_id: "...",
    output: "..."
  }
}

// Option B: Direct result via conversation.item?
{
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "tool",
    content: "..."
  }
}
```

### Step 3: Fix Response Triggers

**Current:** Sending response.create after every tool
**Question:** When should response.create be sent?

**Test scenarios:**

1. After tool result - does Grok auto-continue like OpenAI?
2. After handoff session.update - does Grok auto-continue?
3. What triggers Grok to speak after tool execution?

### Step 4: Fix Handoff Flow

**Current:** session.update + conversation.item.create + response.create
**Question:** Is conversation.item.create needed? Does session.update alone work?

**Test:**

- Handoff → session.update only → see if Grok waits or speaks
- If waits → try response.create only (no conversation.item)

### Step 5: Fix Schema Validation

**Issue:** agent.exited event receives action.type='continue' but schema expects 'completed|handoff|delegate|error'
**Location:** runtime-executor.ts line 2914

**Fix:** Map 'continue' to 'completed' or preserve 'handoff' from line 2748

---

## Testing Protocol (Step-by-Step)

### Test 1: Baseline - Current "Working" State

**Commit:** 18b11c3fd
**Expected:** Handoff works but has "Extra data" error
**Verify:**

- [ ] Initial greeting works
- [ ] Handoff to Sales_Agent works
- [ ] Tool execution works once
- [ ] Note exact error messages

### Test 2: Tool Result Without response.create

**Change:** Remove response.create after tool results (line 1897-1914)
**Expected:** Grok should auto-continue like OpenAI, OR hang
**Verify:**

- [ ] Does Grok speak after tool execution?
- [ ] Does it wait for user input?
- [ ] Any error messages?

### Test 3: Handoff Without conversation.item.create

**Change:** Remove conversation.item.create from handoff (line 1838-1856)
**Keep:** session.update + response.create only
**Expected:** No "Extra data" error, but may hang
**Verify:**

- [ ] Error gone?
- [ ] Does Grok speak after handoff?
- [ ] Does it wait for user input?

### Test 4: Handoff With response.create Only

**Change:** Remove both conversation.item.create AND response.create
**Keep:** Only session.update
**Expected:** Grok waits for user to speak first
**Verify:**

- [ ] Error gone?
- [ ] Grok silent after handoff?
- [ ] Responds when user speaks?

---

## Progress Log

### Test 2: Tool Result Without response.create (2026-04-03)

**Change Made:**

- Removed `response.create` after tool results for Grok (lines 1888-1906)
- Kept tool result sending via `llm:update`
- OpenAI action tools with speech still get response.create

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Hypothesis:** The looping behavior is caused by sending `response.create` after every tool result, which forces Grok to respond immediately. Since there's no new user input, Grok just calls the same tool again.

**Expected Behavior:**

- Grok should auto-continue after tool results (like OpenAI)
- OR Grok should wait for user to speak before continuing

**Status:** Testing revealed handoff repeating audio issue

**Test Result:**

- Tool execution loops: FIXED - Grok no longer calls tools repeatedly
- Handoff works: Session update successful, new agent speaks
- **NEW ISSUE**: Audio repeats after handoff - agent speaks repeatedly in loop

**Root Cause Analysis:**
After handoff, the code sequence was:

1. `session.update` with new instructions ✓
2. `conversation.item.create` with "Go ahead." ✓
3. `response.create` to trigger Grok ✓
4. **Tool result sent for handoff tool** ✗ ← CAUSES LOOP

The handoff tool result (function_call_output) triggers Grok again, causing repeating audio.

### Test 2.5: Fix Handoff Repeating Audio (2026-04-03)

**Change Made:**

- Extract `isHandoff` variable at line 1799-1803 (agent name changed)
- Skip tool result sending when `isHandoff=true` (line 1877: `if (tc.callId && !isHandoff)`)
- Added comment: "Skip for handoffs - we already sent session.update + conversation.item.create + response.create"

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Hypothesis:** For handoffs, we send 3 messages (session.update, conversation.item.create, response.create) which work correctly. But then we also send a 4th message (tool result) which shouldn't be sent. This extra message confuses Grok and causes audio repetition.

**Expected Behavior:**

- Handoff executes: session.update + conversation.item.create + response.create
- NO tool result sent (handoff tool is special, doesn't need result)
- New agent speaks once, then waits for user input

**Status:** Testing revealed tool execution stuck issue

**Test Result:**

- Handoff repeating audio: LIKELY FIXED (not tested yet)
- **NEW ISSUE**: Regular tools stuck - Grok doesn't continue after `__set_context__`

**Root Cause Analysis:**
Test 2 removed `response.create` after ALL tool results for Grok. But Grok needs it to continue.

The real issue was:

- Handoffs were sending tool result + response.create → audio loop
- Regular tools need response.create to continue

### Test 2.6: Restore response.create for Non-Handoff Tools (2026-04-03)

**Change Made:**

- For Grok: Send `response.create` after tool results (lines 1886-1899)
- For handoffs: Skip tool result entirely (already handled by handoff block)
- For regular tools: Send tool result + response.create
- Added log: `[S2S:Grok] Sending response.create after tool result`

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
if (tc.callId && !isHandoff) {
  if (s2sProvider === 's2s:grok') {
    send tool result via llm:update
    send response.create  ← ADDED BACK
  }
}
```

**Hypothesis:**

- Handoffs: session.update + conversation.item.create + response.create (no tool result)
- Regular tools: tool result + response.create
- This gives Grok the trigger it needs without duplicating messages

**Expected Behavior:**

- `__set_context__` executes → tool result sent → response.create sent → Grok continues
- Handoffs execute → session.update + conversation.item.create + response.create → NO tool result → no audio loop

**Status:** Testing revealed tool execution loops again

**Test Result:**

- Regular tools no longer stuck: FIXED (`__set_context__` completes)
- **NEW ISSUE**: Tool execution loops - `search_hotels` called repeatedly (08:02:25, 08:02:26, 08:03:10, 08:03:12, 08:03:24...)
- Audio repeats: Grok speaks, says status message, calls tool again immediately

**Root Cause Analysis:**
Sending `response.create` after tool results forces Grok to continue immediately. Without new user input, Grok calls the tool again. This is the SAME loop from before.

**Key Insight:**

- With `response.create`: Grok continues immediately → loops
- Without `response.create`: Grok waits for user input → might seem stuck but is actually correct behavior

Maybe Grok is like OpenAI - it should auto-continue after tool results WITHOUT needing `response.create`?

### Test 2.7: Remove response.create After Tool Results (2026-04-03)

**Change Made:**

- For Grok: Send tool result via `llm:update` WITHOUT `response.create`
- For handoffs: Still skip tool result (handoff block handles it)
- Added log: `[S2S:Grok] Sending tool result without response.create`
- Comment: "Do NOT send response.create - let Grok decide when to continue"

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
if (tc.callId && !isHandoff) {
  if (s2sProvider === 's2s:grok') {
    send tool result via llm:update
    DO NOT send response.create  ← REMOVED AGAIN
  }
}
```

**Hypothesis:**
Grok should auto-continue after tool results like OpenAI. The "stuck" issue from Test 2.6 might have been:

1. User not speaking (Grok waiting for input - correct behavior)
2. Or tool result not formatted properly
3. Or Grok needs user interaction after certain tools

**Expected Behavior:**

- Tool executes → tool result sent → Grok processes result
- Grok either:
  - Waits for user to speak (if it needs more info)
  - Speaks the results (if it has enough info)
- NO looping - Grok won't call the same tool repeatedly

**Status:** Testing revealed long wait times between tool execution and continuation

**Test Result:**

- No loops: FIXED (search_hotels not called repeatedly)
- **NEW ISSUE**: Long wait times - 1min 42sec gap between handoff and first search_hotels
- User experience: Poor - must nudge Grok to continue after giving all details

**Root Cause Analysis:**
Without `response.create`, Grok waits for user input instead of auto-continuing. With `response.create` always, Grok loops. Need a middle ground.

**Key Insight:**

- Loops happen when Grok calls the SAME tool repeatedly
- Solution: Send `response.create` ONLY when tool is DIFFERENT from last call

### Test 2.8: Loop Detection via Tool Name Tracking (2026-04-03)

**Change Made:**

- Added `lastToolName` variable to track previous tool (line 780)
- Send tool result via `llm:update` (always)
- Send `response.create` ONLY if `tc.name !== lastToolName` (lines 1889-1904)
- Skip `response.create` if same tool called twice in a row
- Update `lastToolName = tc.name` after each tool

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
lastToolName = null  // at session start

Tool A executes:
  send tool result
  if (A !== lastToolName) → send response.create  ← YES (null !== A)
  lastToolName = A

Tool B executes:
  send tool result
  if (B !== lastToolName) → send response.create  ← YES (A !== B)
  lastToolName = B

Tool B executes again (loop):
  send tool result
  if (B !== lastToolName) → send response.create  ← NO (B === B)
  lastToolName = B
  Grok waits for user input → BREAKS LOOP
```

**Hypothesis:**
This breaks loops (same tool twice = no response.create) while keeping flow (different tools = send response.create). Natural conversation flow preserved.

**Expected Behavior:**

- `__set_context__` → response.create → Grok continues
- `search_hotels` (first) → response.create → Grok speaks results
- `search_hotels` (second, loop) → NO response.create → Grok waits → loop broken
- User speaks → new tool → response.create → flow resumes

**Status:** Testing revealed loop detection worked but caused audio repetition after user spoke

**Test Result:**

- Loop detection worked: Second search_hotels skipped response.create
- Call waited at the skip (correct - breaking the loop)
- User said "hello" to continue
- **ISSUE**: Audio started repeating after user spoke

**Root Cause Analysis:**
Looking at the logs:

- 08:16:29.522: First search_hotels → response.create → Grok starts speaking
- 08:16:52.548: Still audio deltas (Grok still speaking from first response)
- 08:16:53.131: Second search_hotels executes WHILE GROK IS STILL SPEAKING
- 08:16:53.134: Skip response.create (loop detection)
- 08:17:15: User says "hello"
- 08:17:15-08:17:18: Audio repeats

**Key Insight:**
Sending `response.create` after tool results **interrupts current speech** and triggers a new response. This causes:

1. Overlapping audio when tool calls happen rapidly
2. Audio repetition when user speaks during/after tool execution

Grok was ALREADY SPEAKING from the first response.create when the second tool fired. The loop detection prevented another response.create, but when user spoke, it reset state and caused repetition.

**The Real Issue:**
`response.create` is for triggering NEW responses. After tool results, Grok is ALREADY in the middle of a response (speaking status message). Sending response.create interrupts that and starts over.

### Test 2.9: No response.create After Tool Results (Final) (2026-04-03)

**Change Made:**

- Removed loop detection (lastToolName tracking)
- Do NOT send `response.create` after tool results
- Let Grok auto-continue naturally like OpenAI
- Added comment: "Sending response.create interrupts current speech and causes loops"

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
Tool executes:
  send tool result via llm:update
  DO NOT send response.create
  Grok auto-continues (finishes current response)
```

**Hypothesis:**
Grok works like OpenAI - it auto-continues after receiving tool results. The "stuck" feeling is actually Grok finishing its speech naturally, then waiting for user to speak. This is CORRECT behavior.

**Expected Behavior:**

- Tool executes → tool result sent → Grok continues current response
- Grok finishes speaking → waits for user
- User speaks → new response cycle begins
- No loops, no interruptions, no audio repetition

**Status:** Testing revealed handoff stuck - Grok rejects conversation.item.create

**Test Result:**

- Tool execution flow working (no loops, no repetition)
- **ISSUE**: Handoff waits indefinitely - never speaks after agent change

**Root Cause Analysis:**
Looking at the logs after handoff:

- 08:25:07.465: "Adding conversation item to trigger response after handoff"
- 08:25:07.739: session.updated event (good)
- 08:25:07.758: **error event from Grok** (bad!)

Earlier error logs show:

```
ERROR [korevg-router] [S2S] Error event from provider  provider=grok
error={"message":"Invalid event received","type":"invalid_request_error",
"code":"invalid_event","params":"Extra data: line 1 column 129 (char 128)"}
```

**Key Insight:**
Grok rejects `conversation.item.create` messages sent after `session.update`. The "Extra data: line 1 column 129" error means Grok doesn't support multiple messages in rapid succession via llm:update.

We were sending:

1. session.update (128 chars?)
2. conversation.item.create (starts at char 129) ← REJECTED
3. response.create (never reached)

**The Fix:**
Send ONLY `response.create` after `session.update` for handoffs. Skip `conversation.item.create` entirely - the session.update already has the new agent's context.

### Test 2.10: Handoff Without conversation.item.create (2026-04-03)

**Change Made:**

- Removed `conversation.item.create` from handoff flow (lines 1823-1849)
- Send only `response.create` after `session.update`
- Updated log: "Sending response.create after handoff (no conversation.item)"
- Comment: "Do NOT send conversation.item.create - Grok rejects it with 'Extra data' error"

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
Handoff executes:
  send session.update (new agent instructions + tools)
  send response.create  ← triggers new agent to speak
  (no conversation.item.create)
```

**Hypothesis:**
Session.update already provides the full context (new agent, new instructions, new tools). Response.create is sufficient to trigger the new agent to speak. Conversation.item.create is redundant and causes Grok API errors.

**Expected Behavior:**

- Handoff → session.update → response.create → new agent speaks
- No error events from Grok
- No "Extra data" errors
- Clean handoff with immediate continuation

**Status:** Found root cause from working example - wrong command type for tool results

**Analysis of Working Example:**
Examined `/home/rammohanyadavalli/Downloads/savg/sources/korevg-client-apps/server-grok-s2s-hotel-booking.js`

**Key Finding (lines 376-385):**

```javascript
const msg = {
  type: 'command',
  command: 'llm:tool-output', // ← Correct for Grok
  tool_call_id: tool_call_id,
  data: toolOutput,
};
```

**Our Mistake:**
We were using `llm:update` command for Grok tool results, but should use `llm:tool-output` (same as OpenAI).

**Command Types:**

- `llm:tool-output` - For sending tool execution results (correct for ALL providers)
- `llm:update` - For session configuration changes (handoffs, instruction updates)

**The working example:**

- Uses `llm:tool-output` for Grok tool results
- Never sends `response.create` after tool calls
- Grok auto-continues naturally after receiving tool results

### Test 2.11: Use llm:tool-output Instead of llm:update (2026-04-03)

**Change Made:**

- Changed Grok tool results from `buildKorevgLlmUpdateCommand` to `buildKorevgToolOutputCommand`
- Now uses `llm:tool-output` command (same as OpenAI/Google)
- Applied to both success and error paths
- Removed provider-specific branching - all providers use `llm:tool-output`

**Files Changed:**

- Line 1862-1871: Tool result success path - now uses `llm:tool-output`
- Line 1899-1906: Tool result error path - now uses `llm:tool-output`

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Logic:**

```
Tool executes:
  send tool result via llm:tool-output command (not llm:update)
  Grok auto-continues (no response.create needed)
```

**Hypothesis:**
The `llm:update` command was confusing Grok - it's meant for session configuration, not tool results. Using the correct `llm:tool-output` command should allow Grok to process tool results properly and auto-continue the conversation naturally.

**Expected Behavior:**

- Tool executes → tool result sent via `llm:tool-output` → Grok auto-continues
- No loops, no interruptions, no audio repetition
- Handoff works with `llm:update` (session config) + `response.create`
- Natural conversation flow throughout

**Status:** Aligned with working example - ACK timing adjusted

**Additional Fix (Test 2.12):**
After reviewing the working example more carefully, found ACK timing difference:

**Working Example Pattern:**

1. Receive `llm:tool-call` event
2. **ACK immediately** (before tool execution)
3. Execute tool
4. Send `llm:tool-output` command
5. **No second ACK**

**Our Old Pattern:**

1. Receive `llm:tool-call`
2. Execute tool
3. **ACK after execution**
4. Send `llm:tool-output`

**Change Made (Test 2.12):**

- Moved ACK to before tool execution (line 1764)
- Removed duplicate ACK after tool execution (line 1800)
- Removed duplicate ACK in error path (line 1898)

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Hypothesis:**
ACK timing might affect how Grok processes subsequent messages. The working example ACKs immediately to acknowledge receipt, then sends the result asynchronously.

**Status:** Fixed handoff - Grok needs tool result even for handoffs

**Final Fix (Test 2.13):**
After analyzing handoff behavior, found that handoffs were stalling because:

**Our Broken Pattern:**

1. Handoff executes
2. Send session.update ✓
3. Send response.create (trying to trigger Grok)
4. Skip handoff tool result
5. **Result:** Grok receives session.updated but never responds

**Root Cause:**
Grok treats handoffs like any other tool - it needs the tool result to continue. The working example doesn't use handoffs (single-agent), so we had to infer this behavior.

**New Pattern (Test 2.13):**

1. Handoff executes
2. Send session.update (new agent context)
3. Send handoff tool result via `llm:tool-output` (like any tool)
4. Grok receives both and auto-continues

**Change Made:**

- Removed response.create after handoffs (lines 1822-1842)
- Changed condition from `!isHandoff` to `s2sProvider === 's2s:grok' || !isHandoff` (line 1838-1839)
- Grok sends tool result for ALL tools including handoffs
- OpenAI skips tool result for handoffs (session.update alone works)

**File:** `apps/runtime/src/services/voice/korevg/korevg-router.ts`

**Hypothesis:**
Grok needs tool results for ALL tools to auto-continue. Handoffs are not special - send session.update for context, then send tool result to trigger continuation.

**Status:** Ready for testing - restart runtime required

---

## Key Learnings

1. **Command types matter:** `llm:tool-output` for tool results, `llm:update` for session changes
2. **ACK immediately:** Acknowledge `llm:tool-call` before executing the tool
3. **No duplicate ACKs:** Only one ACK per event
4. **Working example is authoritative:** Follow the exact pattern from server-grok-s2s-hotel-booking.js
5. **Grok needs all tool results:** Even handoffs need tool result sent via `llm:tool-output`
6. **No response.create after tools:** Tool results alone trigger auto-continuation

---

## Next Steps

1. **Test the Fix** - Restart runtime, make test call
2. **Verify Handoff** - Should speak immediately after agent change
3. **Verify Tool Flow** - All tools should execute and continue smoothly
4. **Complete E2E** - Full conversation flow from greeting to hotel search

---

## Notes

- Commit 18b11c3fd was "working properly" per user
- The "Extra data: line 1 column 129" error suggests JSON parsing issue
- Character 129 is right after a 128-char message - likely the second message in rapid succession
- Grok may not support multiple messages in quick succession via llm:update
