# Filler & Status Messages — Cross-Channel Design & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate dead-air on voice channels and provide real-time progress feedback on chat/SDK channels during long agent operations (tool calls, multi-step reasoning, entity extraction, handoffs) by emitting contextual status updates through a unified filler message system that renders appropriately per channel.

**Architecture:** A channel-agnostic `FillerMessageService` manages a filler queue per session. Fillers come from two sources: (1) **LLM-piggybacked `<status>` tags** — the primary model emits a brief status message before each tool call, parsed from the stream at zero cost, and (2) **operation-aware static message pools** as fallback. Queued fillers are held behind a delay gate (3s voice, 2s chat); if the operation completes before the delay, the filler is silently discarded. If emitted, fillers render through channel adapters: TTS for voice, `status_update` WebSocket events for chat/SDK, no-op for async channels. The service hooks into `ExecutionCoordinator` and `ReasoningExecutor` lifecycle callbacks, driven by existing `TraceEvent` types.

**Tech Stack:** TypeScript, Vitest, ABL DSL (optional `CHANNEL_SETTINGS` section)

---

## MVP Status (2026-03-11)

### Completed (Phase 1 MVP — Chat/WebSocket only)

- [x] Types & config (`services/filler/types.ts`) — StatusEvent, StatusOperation, FillerConfig, QueuedFiller
- [x] FillerMessageService core (`services/filler/filler-service.ts`) — delay gate, cooldown, cancel, maxPerTurn, destroy
- [x] Static operation-aware message pools (`services/filler/message-pools.ts`) — 7 operation categories, dedup
- [x] WebSocket `status_update`/`status_clear` events added to ServerMessage union and ServerMessages factory
- [x] WebSocket handler integration (`handler.ts`) — trace events queue fillers, chunks cancel fillers, cleanup on completion
- [x] Unit tests: filler-service (9 tests), message-pools (4 tests), integration (5 tests) — all passing

### Deferred to Phase 2

- [ ] Voice channel adapter (TTS filler emission)
- [ ] Voice handler integration (Twilio, KoreVG, LiveKit)
- [ ] LLM `<status>` tag piggybacking (prompt injection + stream parser)
- [ ] Prompt builder injection for `<status>` tag instruction
- [ ] DSL parser for CHANNEL_SETTINGS section
- [ ] Project-level filler settings

### Deferred to Phase 3

- [ ] Trace event logging for fillers (observability)
- [ ] ChatWidget rendering (Studio)
- [ ] Studio debug panel filler display

---

## 1. Current State

### 1.1 Channel Architecture

The ABL platform serves multiple channel families, each with different UX expectations during long operations:

| Channel Family       | Examples                                  | Current Wait UX                      | Gap                                 |
| -------------------- | ----------------------------------------- | ------------------------------------ | ----------------------------------- |
| **Voice**            | Twilio, KoreVG/Jambonz, LiveKit, Realtime | Silence                              | Critical — callers hang up          |
| **Chat (WebSocket)** | Web SDK (`web_chat`), Studio debug        | `typing_start` event + dots          | Partial — no status text            |
| **SDK (Embedded)**   | `sdk_websocket`, Custom integrations      | `response_start` triggers `isTyping` | Partial — no operation context      |
| **Async Channels**   | Slack, Teams, WhatsApp, Email             | None (async by nature)               | Low — users expect delay            |
| **AG-UI**            | AG-UI protocol consumers                  | Stream events                        | Low — protocol has lifecycle events |

### 1.2 Voice Architecture

The ABL platform supports four voice integration paths:

| Path                     | Provider                   | Transport                       | STT                    | TTS                          | File                                                         |
| ------------------------ | -------------------------- | ------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------ |
| **Twilio Media Streams** | Twilio                     | WebSocket (`/ws/twilio-media`)  | Deepgram               | ElevenLabs                   | `apps/runtime/src/websocket/twilio-media-handler.ts`         |
| **KoreVG / Jambonz**     | Kore Voice Gateway         | WebSocket (`/ws/korevg`)        | Deepgram (via Jambonz) | ElevenLabs / vendor-provided | `apps/runtime/src/services/voice/korevg/korevg-session.ts`   |
| **LiveKit**              | LiveKit (WebRTC)           | LiveKit Room (in-process agent) | Provider-configured    | Provider-configured          | `apps/runtime/src/services/voice/livekit/agent-worker.ts`    |
| **Realtime**             | OpenAI / Gemini / Ultravox | WebSocket (native multimodal)   | Built-in               | Built-in                     | `apps/runtime/src/services/voice/realtime-voice-executor.ts` |

Voice mode resolution follows a priority chain: deployment config > agent IR `voice_optimized` hint > global config > default (`pipeline`). See `apps/runtime/src/services/voice/voice-mode-resolver.ts` and `apps/runtime/src/services/voice/voice-session-resolver.ts`.

Channel types relevant to voice are defined in `apps/runtime/src/channels/types.ts`: `voice`, `voice_twilio`, `voice_livekit`, `korevg`, `audiocodes`. The `VOICE_TYPES` set in `apps/runtime/src/channels/manifest.ts` and the `isVoiceChannel()` helper in `apps/runtime/src/services/execution/prompt-builder.ts` detect voice sessions at runtime.

### 1.3 How Streaming Works Today

**Pipeline mode (Twilio / KoreVG / LiveKit):**

1. User speech is transcribed by STT (Deepgram)
2. Transcription is sent to `RuntimeExecutor.executeMessage()` via the `ExecutionCoordinator`
3. The `ReasoningExecutor` runs an agentic loop: LLM call -> tool calls -> LLM call -> ...
4. Text chunks arrive via `onChunk` callback during LLM streaming
5. Final response text is sent to TTS (ElevenLabs) for synthesis
6. Audio chunks are streamed back to the caller

**Chat/SDK mode (WebSocket):**

1. Client sends `send_message` or `chat_message` via WebSocket
2. Server emits `typing_start` before execution begins
3. `response_start` → `response_chunk` (streamed) → `response_end` lifecycle
4. Client ChatClient maps `response_start` to `typing: true`, `response_end` to `typing: false`
5. Between `response_start` and the first `response_chunk`, there is **no status information** — the user sees only a typing indicator (bouncing dots) with no context about what is happening

**Realtime mode (OpenAI Realtime / Gemini Live / Ultravox):**

The `RealtimeVoiceExecutor` bridges directly to a multimodal model. Tool calls are handled via `handleToolCall` and results are submitted back via `submitToolResult`. The model itself manages audio output. Filler messages are less critical here since the model can produce audio while processing, but tool call latency still creates gaps.

### 1.4 Existing WebSocket Event Types

The current `ServerMessage` union type (in `apps/runtime/src/types/index.ts`) includes these relevant events:

- `typing_start` — sent before execution begins (no status text, no end event)
- `response_start` / `response_chunk` / `response_end` — streaming response lifecycle
- `trace_event` — forwarded trace events (tool_call, handoff, agent_enter, etc.)
- `handoff_progress` — structured handoff lifecycle events (started, waiting, completed, failed)
- `execution_queued` / `execution_started` / `execution_cancelled` — execution lifecycle

The `ChatEvents` in the Web SDK (`packages/web-sdk/src/core/types.ts`) emit `typing: { isTyping: boolean }` — a boolean with no status text. The `handoff_progress` event is the closest existing pattern to what we need: structured lifecycle events that the client can render as transient status messages.

### 1.5 Where Gaps Occur

| Gap Source                                        | Duration | Frequency                | Voice Impact       | Chat Impact                   |
| ------------------------------------------------- | -------- | ------------------------ | ------------------ | ----------------------------- |
| **Tool execution** (API calls, DB queries)        | 2-15s    | Every tool call          | High — silence     | Medium — dots only            |
| **Multi-step reasoning** (sequential tool calls)  | 5-30s    | Complex queries          | Critical — hangups | High — user wonders if stuck  |
| **Entity extraction** (GATHER mode NLU)           | 1-3s     | Each gather turn         | Low — usually fast | Low                           |
| **Handoff / delegation** (agent switch + IR load) | 2-5s     | Cross-agent routing      | Medium             | Medium — no handoff indicator |
| **LLM cold start** (first token latency)          | 1-5s     | First turn, post-handoff | Medium             | Low — typing dots cover it    |
| **Constraint checking** (post-tool guardrails)    | 0.5-2s   | Per tool call            | Low                | Low                           |

The `onChunk` callback in `ReasoningExecutor.execute()` streams text during LLM generation, but **between** LLM calls (during tool execution), no output reaches any channel. This is the primary gap across all channels.

### 1.6 AgenticAI Reference

AgenticAI's `FillerMessageGraphBuilder` (in `backend/apps/engine/src/utils/filler-message-graph.utils.ts`) uses LangGraph to:

- Support `static` mode (random selection from configured messages) and `dynamic` mode (LLM-generated with execution context)
- Track filler history in Redis (capped at 50 entries, 900s TTL) to avoid repetition
- Use a system prompt template with execution history, available agents/tools, and conversation context
- Cap dynamic LLM calls with a configurable timeout (default 10s)
- Resolve execution history per-node with description, status, and duration context

ABL's design takes inspiration from this but integrates directly with the existing execution pipeline rather than using a separate graph framework, and extends the concept to work across all channels — not just voice.

### 1.7 Industry Reference

Leading platforms handle long-operation feedback as follows:

- **Intercom Fin / Zendesk AI:** Chat UIs show operation-specific status messages ("Searching knowledge base...", "Looking up your order...") as transient bubbles that disappear when the real response arrives. These are driven by internal tool call events.
- **Amazon Lex / Google CCAI (voice):** Use configurable "wait messages" that play TTS audio after a silence threshold. Google CCAI calls these "partial responses" and allows them to be triggered by webhook fulfillment progress.
- **Cognigy:** Supports "Think" nodes that emit intermediate messages to the user during long operations, configurable per flow step.
- **OpenAI Assistants API:** Emits streaming events like `tool_calls.in_progress` that clients can render as status updates. The pattern is: structured events with operation context, rendered client-side.

The common pattern across all leaders: **the server emits structured operation events; the client renders them in channel-appropriate ways**. This is the approach ABL should follow — a unified event model with channel-specific rendering.

---

## 2. Design — Unified Filler Message System

### 2.1 Core Concept

A `FillerMessageService` is a per-session component that works across all channel types:

1. **Starts a silence timer** when execution begins (message submitted to `ExecutionCoordinator`)
2. **Resets the timer** on every meaningful output event (LLM chunk, tool result, state update)
3. **Emits a `StatusEvent`** when the timer fires (silence threshold exceeded)
4. **Cancels the timer** when the final response starts streaming
5. **Enforces a cooldown** between consecutive emissions to avoid spamming
6. **Delegates rendering** to a `ChannelFillerAdapter` that knows how to emit for each channel type

### 2.2 StatusEvent — The Unified Event

All channels receive the same internal `StatusEvent`:

```typescript
interface StatusEvent {
  /** Unique event ID */
  id: string;
  /** Session this event belongs to */
  sessionId: string;
  /** Human-readable status text */
  text: string;
  /** What operation triggered this status */
  operation: StatusOperation;
  /** Whether this is transient (should not be persisted to history) */
  transient: true;
  /** Sequential index within this execution turn */
  index: number;
  /** Timestamp */
  timestamp: number;
}

type StatusOperation =
  | 'tool_call' // "Searching products..."
  | 'reasoning' // "Analyzing your request..."
  | 'handoff' // "Transferring you to a specialist..."
  | 'delegation' // "Consulting another agent..."
  | 'extraction' // "Processing your input..."
  | 'constraint_check' // "Verifying your request..."
  | 'general'; // "One moment please..."
```

### 2.3 Channel-Specific Rendering

| Channel Family       | Rendering                                                         | Event Format                                                  | Persistence   |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| **Voice (pipeline)** | TTS-rendered speech with barge-in                                 | `sendFiller(text)` on voice handler                           | Not persisted |
| **Voice (realtime)** | Conversation item injection (provider-specific)                   | Provider API call                                             | Not persisted |
| **Chat (WebSocket)** | New `status_update` WS event → typing dots + status text          | `{ type: "status_update", text, operation, transient: true }` | Not persisted |
| **SDK (Embedded)**   | New `statusUpdate` ChatEvent → client renders as transient bubble | Same WS event, surfaced via `ChatEvents.statusUpdate`         | Not persisted |
| **Async channels**   | Not emitted (async channels have no real-time connection)         | N/A                                                           | N/A           |

### 2.4 Three Filler Sources (Priority Order)

| Source                             | Phase   | Latency | Quality                            | Cost                                 | When Used                                                         |
| ---------------------------------- | ------- | ------- | ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| **LLM-piggybacked `<status>` tag** | Phase 1 | 0ms     | Best — full conversation context   | Zero (already in primary LLM stream) | Before the first tool call in a turn                              |
| **Operation-aware static pool**    | Phase 1 | 0ms     | Good — operation-specific messages | Zero                                 | Subsequent tool calls, or if no `<status>` tag was emitted        |
| **Dynamic (small model)**          | Removed | —       | —                                  | —                                    | Replaced by `<status>` piggybacking — no separate LLM call needed |

**Key insight:** Instead of calling a separate cheap model for contextual fillers, we piggyback on the primary LLM response. The model already knows what tool it's about to call and why — we just ask it to emit a brief status message in `<status>...</status>` tags before each tool call. This is free, instant, and contextually perfect.

#### How `<status>` Piggybacking Works

1. **System prompt instruction** added by `prompt-builder.ts` for sessions with fillers enabled:
   > "Before each tool call, emit a brief status message in `<status>...</status>` tags (under 15 words) telling the user what you are about to do. Example: `<status>Let me look up your order</status>`"
2. **ReasoningExecutor** parses `<status>` tags from the LLM stream via `onChunk`:
   - Strips the `<status>...</status>` block from the text that reaches the user
   - Extracts the status text and queues it in `FillerMessageService` as a **piggybacked filler**
3. The piggybacked filler follows the same queue/delay/cancel lifecycle as static fillers (see §2.8)
4. **Fallback:** If the model does not emit a `<status>` tag (older models, non-compliant responses), the static operation-aware pool is used as fallback — no degradation

### 2.5 Operation-Aware Static Messages

Instead of a flat pool of generic messages, static mode uses **operation-tagged message pools** that produce contextually relevant status text without any LLM cost:

```typescript
const OPERATION_MESSAGES: Record<StatusOperation, string[]> = {
  tool_call: [
    'Looking that up for you...',
    'Searching for that information...',
    'Let me check on that...',
    'Fetching the details...',
  ],
  reasoning: [
    'Analyzing your request...',
    'Thinking through the best approach...',
    'Processing your question...',
    'Working on that now...',
  ],
  handoff: [
    'Connecting you with the right specialist...',
    'Transferring you now...',
    'Let me bring in someone who can help...',
  ],
  delegation: [
    'Consulting with another agent...',
    'Getting a second opinion on that...',
    'Checking with a specialist...',
  ],
  extraction: ['Processing your input...', 'Understanding your response...'],
  constraint_check: ['Verifying your request...', 'Running some checks...'],
  general: ['One moment please...', 'Just a moment...', 'Bear with me...', 'Working on that...'],
};
```

The operation type is derived from the most recent `TraceEvent` before the silence timer fires:

- `tool_call` trace event → `StatusOperation.tool_call`
- `handoff` or `handoff_progress` → `StatusOperation.handoff`
- `delegate_start` → `StatusOperation.delegation`
- `dsl_collect` → `StatusOperation.extraction`
- `constraint_check` → `StatusOperation.constraint_check`
- No recent trace event → `StatusOperation.general`

### 2.6 Filler Queue & Cancellation

Fillers are **queued, not emitted immediately**. This prevents abrupt interruptions when tool calls complete fast:

```typescript
interface QueuedFiller {
  text: string;
  source: 'piggybacked' | 'static';
  operation: StatusOperation;
  queuedAt: number;
  /** Timer ID for delayed emission */
  timerId: ReturnType<typeof setTimeout> | null;
}
```

**Queue lifecycle:**

1. **Enqueue:** When a `<status>` tag is parsed or a static filler is selected, it enters the queue with state `pending`
2. **Delay gate:** A `setTimeout` starts for the channel-appropriate delay (`delay_ms` for voice, `chat_delay_ms` for chat)
3. **Emit:** If the timer fires, the filler is emitted via the channel adapter → user sees/hears it
4. **Discard (fast completion):** If the tool completes or the next LLM chunk arrives BEFORE the delay timer fires, the queued filler is **silently discarded** — the user never sees it
5. **Interrupt (mid-delivery):** If a filler is already being delivered (TTS speaking, status text visible) and the real response starts streaming:
   - Voice: barge-in cuts the TTS audio
   - Chat: `status_clear` event removes the transient text
   - The filler service transitions to "response streaming" state — no more fillers emitted

**Key guarantees:**

- A filler is NEVER shown if the operation completes within the delay threshold
- Only ONE filler is active at a time (new filler replaces previous)
- Real response ALWAYS takes priority over filler — filler yields immediately
- `FillerService.destroy()` on session cleanup clears all timers (no leaks)

### 2.7 Lifecycle

```
User input → executeMessage()
                    │
                    ├─ FillerService.start(sessionId, channelAdapter)
                    │
                    ├─ [LLM streaming] → onChunk parses <status> tags
                    │   ├─ <status> found → extract text, strip from output, QUEUE filler
                    │   └─ no <status> → FillerService.reset() (text reaching user)
                    │
                    ├─ [Tool call starts] → silence begins, delay timer starts
                    │   │
                    │   ├─ Tool completes in < delay_ms → DISCARD queued filler (user sees nothing)
                    │   │
                    │   ├─ delay_ms passes → EMIT queued filler via adapter
                    │   │   ├─ Voice: TTS "Let me look up your order"
                    │   │   ├─ Chat: WS { type: "status_update", text: "Looking up your order..." }
                    │   │   └─ SDK: ChatEvents.statusUpdate emitted
                    │   │
                    │   ├─ [Tool completes after filler shown] → FillerService.reset()
                    │   │
                    │   └─ [More tool calls...] → cycle repeats with static pool (no <status> for mid-chain)
                    │
                    ├─ [Handoff] → FillerService.setOperation('handoff', targetAgent)
                    │   └─ delay_ms passes → "Transferring you to..." (from static pool)
                    │
                    └─ [Final response starts] → FillerService.cancel()
                        ├─ Discard any pending queued filler
                        ├─ Voice: interrupt any in-progress TTS
                        ├─ Chat: WS { type: "status_clear" }
                        └─ response_chunk begins streaming to user
```

### 2.8 Trace Event Integration

The filler service listens to the `onTraceEvent` callback (already wired in `ExecutionCoordinator` and `ReasoningExecutor`) to update its operation context:

```typescript
// Trace event → operation mapping
const TRACE_TO_OPERATION: Record<string, StatusOperation> = {
  tool_call: 'tool_call',
  handoff: 'handoff',
  handoff_progress: 'handoff',
  delegate_start: 'delegation',
  dsl_collect: 'extraction',
  constraint_check: 'constraint_check',
  agent_enter: 'handoff',
};
```

When a trace event arrives, the filler service:

1. Maps it to a `StatusOperation` (or ignores unmapped types)
2. Extracts context from `event.data` (tool name, target agent, etc.)
3. If a filler fires before the next reset, it uses this operation + context to select/generate the status text

### 2.9 Chat/SDK Status Message UX

For chat channels, status updates appear as **transient status indicators** in the UI:

1. **Server sends** `{ type: "status_update", sessionId, text: "Searching products...", operation: "tool_call", transient: true }`
2. **Web SDK ChatClient** emits `statusUpdate: { text, operation }` event
3. **ChatWidget** renders a transient status line below the typing dots: `[...] Searching products...`
4. **Server sends** `{ type: "status_clear", sessionId }` when execution produces output or completes
5. **Widget** removes the status line; typing dots may persist until `response_end`

Key UX rules for chat:

- Status messages are **never persisted** to conversation history — they are ephemeral UI state
- Status text replaces (not stacks with) previous status text — only one status line at a time
- Status text is shown alongside the typing indicator, not instead of it
- If `response_chunk` arrives while status is showing, status is immediately cleared
- For multi-step operations, status updates incrementally: "Searching products..." → "Analyzing results..." → "Preparing your answer..."

### 2.10 Progress Updates for Multi-Step Operations

For complex operations involving multiple sequential steps, the filler service can emit numbered progress updates:

```
Step 1 of 3: Gathering product information...
Step 2 of 3: Comparing prices...
Step 3 of 3: Preparing your recommendation...
```

This is driven by tracking the tool call index within an execution turn. When `max_per_turn` is known and multiple tool calls are expected (detectable from the agent IR's tool definitions), the filler service includes step context in the status text.

For dynamic mode, the step context is passed to the LLM prompt. For static mode, the step prefix is prepended to the operation-specific message:

- First tool call: "Looking that up for you..."
- Second tool call: "Step 2: Checking availability..."
- Third tool call: "Step 3: Almost done..."

---

## 3. Design — Static Fillers (Phase 1)

### 3.1 Message Selection Strategy

- **Round-robin per operation** (default): Cycle through the operation's message pool sequentially within a session
- **Random with dedup**: Random selection with dedup against last N messages (configurable, default N=3)
- Track used messages per session in `FillerMessageService` state (no Redis needed for static mode)

### 3.2 Cooldown & Thresholds

| Parameter      | Default                   | Description                           |
| -------------- | ------------------------- | ------------------------------------- |
| `delay_ms`     | 3000 (voice), 2000 (chat) | Silence threshold before first filler |
| `cooldown_ms`  | 5000 (voice), 4000 (chat) | Minimum interval between fillers      |
| `max_per_turn` | 5                         | Maximum fillers per execution turn    |

Voice channels use slightly longer defaults because TTS playback itself takes time. Chat channels can show status text faster since it is instant.

### 3.3 Channel Adapter Interface

```typescript
interface ChannelFillerAdapter {
  /** Emit a status event through the channel */
  emitStatus(event: StatusEvent): void;
  /** Clear any active status display */
  clearStatus(sessionId: string): void;
  /** Cancel in-progress filler playback (voice only) */
  cancelPlayback?(sessionId: string): void;
}
```

Implementations:

| Adapter                  | Channel Types                                                    | Behavior                                                        |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `VoiceFillerAdapter`     | `voice`, `voice_twilio`, `voice_livekit`, `korevg`, `audiocodes` | Calls `sendFiller(text)` on the voice handler; barge-in enabled |
| `WebSocketFillerAdapter` | `web_chat`, `sdk_websocket`                                      | Sends `status_update` / `status_clear` WS events                |
| `NoopFillerAdapter`      | `slack`, `teams`, `whatsapp`, `email`, `api`, etc.               | Does nothing — async channels do not need fillers               |

### 3.4 Voice Output Path

The filler message must reach the caller via the same TTS path as normal responses:

| Voice Path       | Filler Emission Mechanism                                                                |
| ---------------- | ---------------------------------------------------------------------------------------- |
| **KoreVG**       | `KorevgSession.sendFiller(text)` — sends a `say` verb via WebSocket with `bargeIn: true` |
| **Twilio Media** | Stream filler text through ElevenLabs TTS → audio chunks → Twilio media stream           |
| **LiveKit**      | Inject filler via `RuntimeLLMAdapter` as a synthetic assistant message                   |
| **Realtime**     | Phase 3 — inject as `conversation.item.create` (OpenAI) or inline text (Gemini)          |

All voice fillers are emitted with **barge-in enabled** — if the user starts speaking, the filler is immediately interrupted and the new utterance is processed.

### 3.5 WebSocket Output Path

For chat/SDK channels, two new `ServerMessage` variants are added:

```typescript
// In apps/runtime/src/types/index.ts — ServerMessage union
| {
    type: 'status_update';
    sessionId: string;
    text: string;
    operation: StatusOperation;
    transient: true;
  }
| {
    type: 'status_clear';
    sessionId: string;
  }
```

The `ServerMessages` factory in `events.ts` gains two new creators:

```typescript
statusUpdate(sessionId: string, text: string, operation: StatusOperation): ServerMessage {
  return { type: 'status_update', sessionId, text, operation, transient: true };
},

statusClear(sessionId: string): ServerMessage {
  return { type: 'status_clear', sessionId };
},
```

### 3.6 Web SDK Extension

The `ChatEvents` interface gains a new event:

```typescript
export interface ChatEvents {
  // ... existing events
  statusUpdate: { text: string; operation: string; transient: true };
  statusClear: void;
}
```

The `ChatClient.handleServerMessage()` method handles these new event types:

```typescript
case 'status_update':
  this.emit('statusUpdate', {
    text: msg.text as string,
    operation: msg.operation as string,
    transient: true,
  });
  break;

case 'status_clear':
  this.emit('statusClear', undefined);
  break;
```

The React `AgentProvider` exposes `statusText: string | null` state that components can render:

```typescript
const [statusText, setStatusText] = useState<string | null>(null);

chatClient.on('statusUpdate', ({ text }) => setStatusText(text));
chatClient.on('statusClear', () => setStatusText(null));
// Also clear on response_end
chatClient.on('typing', ({ isTyping }) => {
  if (!isTyping) setStatusText(null);
});
```

---

## 4. Design — LLM-Piggybacked Status Tags (Phase 2)

### 4.1 How It Works

Instead of a separate LLM call for contextual fillers, we piggyback on the primary model's response stream. The model already has full conversation context and knows what tool it's about to call — we just instruct it to emit a brief status message.

### 4.2 System Prompt Injection

When fillers are enabled for a session, `prompt-builder.ts` appends this instruction to the system prompt:

```
Before each tool call, emit a brief status message wrapped in <status>...</status> tags.
This message will be shown to the user while the tool executes. Keep it under 15 words,
natural, and informative. Do NOT ask questions in status messages.
Example: <status>Let me look up your order details</status>
```

This instruction is only added when `channelSettings.statusMessages.enabled === true`. It is intentionally lightweight — a single paragraph that does not significantly impact the model's behavior or token budget.

### 4.3 Stream Parsing in ReasoningExecutor

The `onChunk` wrapper in `ReasoningExecutor` detects `<status>` tags:

```typescript
// Simplified — actual implementation uses a streaming tag parser
const STATUS_OPEN = '<status>';
const STATUS_CLOSE = '</status>';

function processChunk(
  chunk: string,
  buffer: string,
): {
  outputChunk: string; // Text that reaches the user (status stripped)
  statusText: string | null; // Extracted status text, if complete
} {
  // Accumulate in buffer, extract <status>...</status>, return cleaned output
}
```

Key behaviors:

- `<status>` tags are **stripped** from the text stream — the user never sees raw tags
- The extracted text is queued as a piggybacked filler in `FillerMessageService`
- If the model emits `<status>` mid-sentence (shouldn't happen, but defensive), the parser handles partial tags gracefully via a small buffer
- If no `<status>` tag is detected before a tool call, the static pool provides the fallback

### 4.4 Examples

| Model Output (raw stream)                                                          | User Sees                                 | Queued Filler                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `<status>Let me check your order</status>` + tool_call                             | _(nothing — status was before tool call)_ | "Let me check your order"                               |
| `Sure, I can help with that. <status>Looking up your account</status>` + tool_call | "Sure, I can help with that."             | "Looking up your account"                               |
| _(no status tag)_ + tool_call                                                      | _(nothing)_                               | Falls back to static pool: "Looking that up for you..." |

### 4.5 Why Not a Separate Small Model?

| Approach                       | Latency                 | Cost               | Quality                  | Complexity                              |
| ------------------------------ | ----------------------- | ------------------ | ------------------------ | --------------------------------------- |
| **Piggybacked `<status>` tag** | 0ms (already in stream) | $0 (no extra call) | Best (full context)      | Low (stream parser)                     |
| Separate Haiku/mini call       | 200-500ms added         | ~$0.00005/filler   | Medium (limited context) | High (model routing, timeout, fallback) |

The piggybacked approach wins on every dimension. The only downside is model compliance — some models may not reliably emit `<status>` tags. This is mitigated by the static pool fallback, which is always available.

### 4.6 Filler History (Dedup)

- Tracked in-memory per session in `FillerMessageService` (list of last 10 emitted filler texts)
- Piggybacked fillers are added to history after emission
- Static pool selection checks history to avoid immediate repetition
- No Redis needed — history is session-scoped and small

---

## 5. Design — Integration Points

### 5.1 ExecutionCoordinator Hook

The `ExecutionCoordinator.submit()` method is the single entry point for all message processing. The filler service is activated here for **all channel types** (the adapter determines rendering):

```typescript
// In ExecutionCoordinator dispatch path — after the executor starts
const adapter = resolveChannelAdapter(session);
if (adapter.type !== 'noop') {
  fillerService.start(sessionId, {
    adapter,
    onTraceEvent: (event) => fillerService.updateOperation(event),
    delayMs: agentConfig.fillerDelayMs ?? adapter.defaultDelayMs,
    cooldownMs: agentConfig.fillerCooldownMs ?? adapter.defaultCooldownMs,
  });
}
```

**File:** `apps/runtime/src/services/execution/execution-coordinator.ts`

### 5.2 ReasoningExecutor Hook

The `ReasoningExecutor` runs the agentic loop. Timer resets happen at:

1. **Each `onChunk` emission** — LLM is actively streaming text
2. **Each tool result** — tool execution completed, about to resume LLM
3. **Loop iteration start** — next reasoning step beginning
4. **Each `onTraceEvent`** — updates the current operation context

```typescript
// In the reasoning loop, after tool execution:
fillerService.reset(sessionId);

// In the onChunk wrapper:
const wrappedOnChunk = (chunk: string) => {
  fillerService.reset(sessionId);
  onChunk?.(chunk);
};

// In the onTraceEvent wrapper:
const wrappedOnTraceEvent = (event) => {
  fillerService.updateOperation(event);
  onTraceEvent?.(event);
};
```

**File:** `apps/runtime/src/services/execution/reasoning-executor.ts`

### 5.3 Voice Service Hook

Each voice handler needs a method to emit filler text through its TTS pipeline:

| Handler                | Method             | Mechanism                                                                 |
| ---------------------- | ------------------ | ------------------------------------------------------------------------- |
| `KorevgSession`        | `sendFiller(text)` | Send `say` verb with `bargeIn: true` so user speech interrupts the filler |
| `TwilioMediaHandler`   | `sendFiller(text)` | Synthesize via ElevenLabs, stream audio chunks to Twilio media stream     |
| `LiveKit agent-worker` | `sendFiller(text)` | Inject as synthetic assistant text into the AgentSession                  |

**Files:**

- `apps/runtime/src/services/voice/korevg/korevg-session.ts`
- `apps/runtime/src/websocket/twilio-media-handler.ts`
- `apps/runtime/src/services/voice/livekit/agent-worker.ts`

### 5.4 WebSocket Handler Hook

Both `handler.ts` and `sdk-handler.ts` need to forward `status_update` and `status_clear` events to connected clients. The `WebSocketFillerAdapter` is wired to the `ws.send()` path:

```typescript
// WebSocketFillerAdapter implementation
class WebSocketFillerAdapter implements ChannelFillerAdapter {
  constructor(
    private ws: WebSocket,
    private sessionId: string,
  ) {}

  emitStatus(event: StatusEvent): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        type: 'status_update',
        sessionId: this.sessionId,
        text: event.text,
        operation: event.operation,
        transient: true,
      }),
    );
  }

  clearStatus(): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(
      JSON.stringify({
        type: 'status_clear',
        sessionId: this.sessionId,
      }),
    );
  }
}
```

**Files:**

- `apps/runtime/src/websocket/handler.ts`
- `apps/runtime/src/websocket/sdk-handler.ts`

### 5.5 Filler Cancellation

When the real response starts streaming (first `onChunk` after tool execution), the filler service:

1. Cancels any pending filler timer
2. Calls `adapter.clearStatus()` to remove any active status display
3. If voice: signals the voice handler to stop filler playback via `adapter.cancelPlayback()`
4. Transitions to "response streaming" state where no more fillers are emitted

### 5.6 Channel Detection & Adapter Resolution

```typescript
function resolveChannelAdapter(session: RuntimeSession, ws?: WebSocket): ChannelFillerAdapter {
  if (isVoiceChannel(session)) {
    const voiceHandler = voiceSessionRegistry.get(session.id);
    return voiceHandler ? new VoiceFillerAdapter(voiceHandler) : new NoopFillerAdapter();
  }

  if (ws && (session.channelType === 'web_chat' || session.channelType === 'sdk_websocket')) {
    return new WebSocketFillerAdapter(ws, session.id);
  }

  return new NoopFillerAdapter();
}
```

---

## 6. Design — DSL Extension

### 6.1 Agent-Level Configuration

A new optional `CHANNEL_SETTINGS` section in agent DSL (named channel-agnostic, not voice-specific):

```yaml
AGENT CustomerService
  PERSONA: You are a helpful customer service agent.
  GOAL: Help customers with orders and returns.

  CHANNEL_SETTINGS:
    status_messages:
      enabled: true
      piggyback: true        # Ask LLM to emit <status> tags (default: true)
      delay_ms: 3000         # Silence threshold before emitting queued filler (voice default)
      chat_delay_ms: 2000    # Override for chat channels
      cooldown_ms: 5000      # Minimum interval between statuses
      max_per_turn: 5        # Maximum statuses per execution turn
      voice_messages:        # Custom voice-specific static fallback messages
        - "One moment please."
        - "Let me check on that for you."
        - "I'm looking into that now."
      chat_messages:         # Custom chat-specific static fallback messages
        - "Searching..."
        - "Checking on that..."
        - "Processing your request..."
```

### 6.2 Project-Level Configuration

Project settings (`ProjectSettings` in DB) can set defaults for all agents:

```json
{
  "channelSettings": {
    "statusMessages": {
      "enabled": true,
      "piggyback": true,
      "delayMs": 3000,
      "chatDelayMs": 2000,
      "cooldownMs": 5000,
      "maxPerTurn": 5,
      "voiceMessages": ["One moment please.", "Let me check on that."],
      "chatMessages": ["Working on that...", "Looking into it..."]
    }
  }
}
```

### 6.3 Resolution Priority

1. Agent DSL `CHANNEL_SETTINGS.status_messages` (highest)
2. Project settings `channelSettings.statusMessages`
3. Platform defaults (static mode, channel-appropriate delays, default message pools)

### 6.4 IR Representation

The compiler emits filler config in the agent IR:

```typescript
interface ChannelSettingsIR {
  status_messages?: {
    enabled: boolean;
    piggyback: boolean;
    delay_ms: number;
    chat_delay_ms?: number;
    cooldown_ms: number;
    max_per_turn: number;
    voice_messages?: string[];
    chat_messages?: string[];
  };
}
```

This is added to `AgentIR` under a new `channel_settings` field (alongside existing `on_start.voice_config`).

---

## 7. Test Plan

### 7.1 Unit Tests

| Test                                       | Description                                                    | File                             |
| ------------------------------------------ | -------------------------------------------------------------- | -------------------------------- |
| Timer fires after delay                    | Start timer, verify callback fires after `delay_ms`            | `filler-message-service.test.ts` |
| Timer resets on activity                   | Start timer, reset before expiry, verify new delay             | `filler-message-service.test.ts` |
| Timer cancels cleanly                      | Start timer, cancel, verify no callback                        | `filler-message-service.test.ts` |
| Cooldown enforced                          | Emit filler, verify next filler respects `cooldown_ms`         | `filler-message-service.test.ts` |
| Max per turn cap                           | Emit `max_per_turn` fillers, verify no more are emitted        | `filler-message-service.test.ts` |
| Round-robin selection                      | Verify messages cycle without immediate repetition             | `filler-message-service.test.ts` |
| Operation-aware selection                  | Verify tool_call operation selects from tool_call pool         | `filler-message-service.test.ts` |
| Trace event to operation                   | Verify trace event types map to correct operations             | `filler-message-service.test.ts` |
| Voice channel uses VoiceAdapter            | Verify voice sessions get VoiceFillerAdapter                   | `channel-filler-adapter.test.ts` |
| Chat channel uses WSAdapter                | Verify chat sessions get WebSocketFillerAdapter                | `channel-filler-adapter.test.ts` |
| Async channel uses NoopAdapter             | Verify Slack/email/etc. get NoopFillerAdapter                  | `channel-filler-adapter.test.ts` |
| Config resolution                          | DSL > project > defaults priority                              | `filler-config-resolver.test.ts` |
| Piggybacked filler queued                  | `<status>` tag parsed → filler queued, not emitted immediately | `filler-message-service.test.ts` |
| Queued filler discarded on fast completion | Tool completes before delay → filler never shown               | `filler-message-service.test.ts` |
| Queued filler emitted after delay          | Tool takes > delay_ms → filler emitted via adapter             | `filler-message-service.test.ts` |
| Mid-delivery filler interrupted            | Response starts while filler active → filler cancelled         | `filler-message-service.test.ts` |
| No `<status>` tag → static fallback        | Model omits tag → static pool filler used                      | `filler-message-service.test.ts` |
| Status tag extraction                      | `<status>` tag stripped from output, text extracted            | `status-tag-parser.test.ts`      |
| Partial tag across chunks                  | Tag split across chunks handled correctly                      | `status-tag-parser.test.ts`      |
| Malformed tag flushed                      | Incomplete tag at stream end flushed as text                   | `status-tag-parser.test.ts`      |
| Chat delay override                        | Verify `chat_delay_ms` used for chat channels                  | `filler-config-resolver.test.ts` |
| Status event structure                     | Verify StatusEvent has all required fields                     | `filler-message-service.test.ts` |

### 7.2 Integration Tests

| Test                                   | Description                                                                       | File                                   |
| -------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| Coordinator activates filler for voice | Submit message with voice session, verify filler service starts with VoiceAdapter | `execution-coordinator-filler.test.ts` |
| Coordinator activates filler for chat  | Submit message with chat session, verify filler service starts with WSAdapter     | `execution-coordinator-filler.test.ts` |
| Coordinator skips filler for async     | Submit message with Slack session, verify NoopAdapter                             | `execution-coordinator-filler.test.ts` |
| ReasoningExecutor resets on chunk      | Verify timer resets during LLM streaming                                          | `reasoning-executor-filler.test.ts`    |
| Tool call triggers filler              | Execute tool that takes >3s, verify filler emitted                                | `reasoning-executor-filler.test.ts`    |
| Filler cancelled on response           | Verify filler timer cancelled when response streams                               | `reasoning-executor-filler.test.ts`    |
| WS status_update sent                  | Verify WebSocket receives status_update JSON                                      | `ws-filler-adapter.test.ts`            |
| WS status_clear sent                   | Verify WebSocket receives status_clear on response                                | `ws-filler-adapter.test.ts`            |
| Trace event updates operation          | Verify tool_call trace → tool_call operation → tool-specific filler               | `reasoning-executor-filler.test.ts`    |

### 7.3 E2E Tests

| Test                   | Description                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| KoreVG filler timing   | Full voice call with tool call >3s, verify `say` verb emitted as filler                  |
| Barge-in during filler | User speaks during filler playback, verify filler interrupted                            |
| Multi-filler sequence  | Long operation with multiple fillers, verify cooldown spacing                            |
| Chat status update     | Send message via SDK WebSocket, trigger long tool, verify `status_update` event received |
| Chat status clear      | Verify `status_clear` received when response starts streaming                            |
| Multi-step chat status | Execute 3 sequential tools, verify status text updates per tool                          |

---

## 8. Implementation Plan

### Phase 1 — Core Service + Chat Channel (Tasks 1-9)

#### Task 1: StatusEvent Types & Config

Define TypeScript types for the unified status event, configuration, and operation mapping.

**Files to create:**

- `apps/runtime/src/services/filler/types.ts`

**Files to modify:**

- None

**Details:**

- `StatusEvent` interface
- `StatusOperation` type
- `FillerMessageConfig` interface with channel-aware defaults
- `DEFAULT_FILLER_CONFIG` constant
- `OPERATION_MESSAGES` pools (operation-keyed static message pools)
- `TRACE_TO_OPERATION` mapping
- `resolveFillerConfig(agentIR, projectSettings, channelType)` function
- Resolution priority: agent IR > project settings > defaults

**Tests:**

- `apps/runtime/src/__tests__/filler-config.test.ts`

---

#### Task 2: FillerMessageService Core

Create the core service with timer management, operation tracking, message selection, and lifecycle.

**Files to create:**

- `apps/runtime/src/services/filler/filler-message-service.ts`

**Details:**

- `FillerMessageService` class with `start()`, `reset()`, `cancel()`, `destroy()`, `updateOperation()`, `setStepContext()`
- Timer-based with `setTimeout` / `clearTimeout`
- Operation-aware round-robin message selection
- Cooldown tracking between fillers
- Max-per-turn counter
- Accepts a `ChannelFillerAdapter` for output
- Trace event listener integration (maps trace events to operations)
- Uses `createLogger('filler-message')` for logging
- Full test coverage

**Tests:**

- `apps/runtime/src/__tests__/filler-message-service.test.ts`

---

#### Task 3: ChannelFillerAdapter Interface & Implementations

Create the adapter interface and all three implementations.

**Files to create:**

- `apps/runtime/src/services/filler/channel-filler-adapter.ts`
- `apps/runtime/src/services/filler/adapters/voice-filler-adapter.ts`
- `apps/runtime/src/services/filler/adapters/websocket-filler-adapter.ts`
- `apps/runtime/src/services/filler/adapters/noop-filler-adapter.ts`
- `apps/runtime/src/services/filler/index.ts` (barrel export)

**Details:**

- `ChannelFillerAdapter` interface: `emitStatus()`, `clearStatus()`, `cancelPlayback?()`
- `VoiceFillerAdapter`: wraps a `VoiceOutputHandler` (to be wired in Task 6)
- `WebSocketFillerAdapter`: sends `status_update` / `status_clear` JSON via WebSocket
- `NoopFillerAdapter`: does nothing
- `resolveChannelAdapter(session, ws?)` factory function

**Tests:**

- `apps/runtime/src/__tests__/channel-filler-adapter.test.ts`

---

#### Task 4: WebSocket Event Types Extension

Add `status_update` and `status_clear` to the WebSocket event type system.

**Files to modify:**

- `apps/runtime/src/types/index.ts` — add `status_update` and `status_clear` to `ServerMessage` union
- `apps/runtime/src/websocket/events.ts` — add `statusUpdate()` and `statusClear()` to `ServerMessages` factory

**Details:**

- New `StatusOperation` type (imported from filler types or re-exported)
- `status_update`: `{ type, sessionId, text, operation, transient: true }`
- `status_clear`: `{ type, sessionId }`
- Backward compatible — existing clients that do not handle these types ignore them

**Tests:**

- Verify existing event tests still pass (no breaking change)

---

#### Task 5: Web SDK Extension

Add status update handling to the ChatClient and React provider.

**Files to modify:**

- `packages/web-sdk/src/core/types.ts` — add `statusUpdate` and `statusClear` to `ChatEvents`
- `packages/web-sdk/src/chat/ChatClient.ts` — handle `status_update` and `status_clear` server messages
- `packages/web-sdk/src/chat/types.ts` — add `statusText` to `ChatState`
- `packages/web-sdk/src/ui/ChatWidget.ts` — render transient status text below typing indicator
- `packages/web-sdk/src/react/AgentProvider.tsx` — expose `statusText` state

**Details:**

- `ChatEvents.statusUpdate: { text: string; operation: string; transient: true }`
- `ChatEvents.statusClear: void`
- `ChatClient` dispatches these events from `handleServerMessage()`
- `ChatWidget` renders status text as a line below typing dots: `<div class="status-text">Searching products...</div>`
- Status text auto-clears on `response_end` / `status_clear`
- React hook: `useAgent()` returns `{ statusText }` alongside `isTyping`

**Tests:**

- `packages/web-sdk/src/__tests__/chat-status-events.test.ts`

---

#### Task 6: Voice Session Registry

Create a registry that maps session IDs to voice output handlers, so the filler service can find the correct voice handler for output.

**Files to create:**

- `apps/runtime/src/services/filler/voice-session-registry.ts`

**Details:**

- Singleton `Map<string, VoiceOutputHandler>` with `register()`, `unregister()`, `get()` methods
- `VoiceOutputHandler` interface: `{ sendFiller(text: string): void; cancelFiller(): void }`
- Max size (10,000) + TTL (1 hour) eviction (platform invariant: every in-memory Map needs bounds)
- KoreVG, Twilio, and LiveKit handlers register on session start, unregister on close

**Files to modify:**

- `apps/runtime/src/services/voice/korevg/korevg-session.ts` — register on init, unregister on close
- `apps/runtime/src/websocket/twilio-media-handler.ts` — register on stream start, unregister on close
- `apps/runtime/src/services/voice/livekit/agent-worker.ts` — register on room join, unregister on disconnect

**Tests:**

- `apps/runtime/src/__tests__/voice-session-registry.test.ts`

---

#### Task 7: Voice Handler Filler Methods

Add `sendFiller(text)` / `cancelFiller()` methods to each voice handler.

**Files to modify:**

- `apps/runtime/src/services/voice/korevg/korevg-session.ts` — add `sendFiller()`, `cancelFiller()`
- `apps/runtime/src/services/voice/korevg/verb-builder.ts` — add `buildFillerSayVerb()` if needed
- `apps/runtime/src/websocket/twilio-media-handler.ts` — add `sendFiller()`, `cancelFiller()`
- `apps/runtime/src/services/voice/livekit/agent-worker.ts` — add `sendFiller()`, `cancelFiller()`
- `apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts` — expose synthetic message injection

**Details:**

- KoreVG: `sendFiller()` sends `say` verb with `bargeIn: true`
- Twilio: synthesize via ElevenLabs TTS, stream audio chunks, track for cancellation
- LiveKit: inject as synthetic assistant text through normal TTS pipeline
- All handlers: `cancelFiller()` stops any in-progress TTS playback

**Tests:**

- `apps/runtime/src/__tests__/korevg-filler.test.ts`
- `apps/runtime/src/__tests__/twilio-media-filler.test.ts`
- `apps/runtime/src/__tests__/livekit-filler.test.ts`

---

#### Task 8: ExecutionCoordinator + ReasoningExecutor Integration

Wire the `FillerMessageService` into the execution pipeline for all channel types.

**Files to modify:**

- `apps/runtime/src/services/execution/execution-coordinator.ts` — activate filler on dispatch
- `apps/runtime/src/services/execution/reasoning-executor.ts` — reset timer on chunk/tool-result events, forward trace events

**Details:**

- In dispatch path: resolve channel adapter, create `FillerMessageService`, pass adapter and config
- The `onChunk` wrapper resets the filler timer
- The `onTraceEvent` wrapper calls `fillerService.updateOperation(event)` before forwarding
- After each tool result: `fillerService.reset()`
- On execution complete (success or error): `fillerService.cancel()` then `adapter.clearStatus()`
- WebSocket handlers (`handler.ts`, `sdk-handler.ts`): pass `ws` reference to adapter resolution

**Dependencies:** Tasks 1, 2, 3, 4, and at least one of Tasks 6/7

**Tests:**

- `apps/runtime/src/__tests__/execution-coordinator-filler.test.ts`
- `apps/runtime/src/__tests__/reasoning-executor-filler.test.ts`

---

#### Task 9: IR Schema Extension

Add `channel_settings` to the AgentIR schema.

**Files to modify:**

- `packages/compiler/src/platform/ir/schema.ts` — add `ChannelSettingsIR` type and `channel_settings?` field to `AgentIR`

**Details:**

- New `ChannelSettingsIR` interface with `status_messages` sub-structure
- Optional field on `AgentIR` — backward compatible
- No parser/compiler changes yet (Phase 1 uses project settings and defaults)

**Tests:**

- Verify existing compiler tests still pass (no breaking change)

---

### Phase 2 — LLM Piggybacking + DSL (Tasks 10-13)

#### Task 10: Status Tag Stream Parser

Add `<status>` tag detection and extraction to the ReasoningExecutor's `onChunk` pipeline.

**Files to create:**

- `apps/runtime/src/services/filler/status-tag-parser.ts`

**Files to modify:**

- `apps/runtime/src/services/execution/reasoning-executor.ts` — wrap `onChunk` to intercept `<status>` tags

**Details:**

- Streaming tag parser that handles `<status>...</status>` across chunk boundaries
- Small buffer (256 chars max) for accumulating partial tags
- Extracted status text is stripped from the output stream (user never sees raw tags)
- Extracted text is queued as a piggybacked filler in `FillerMessageService`
- If `<status>` tag is malformed or incomplete at stream end, flush buffer as normal text
- If `piggyback: false` in config, parser is bypassed entirely

**Tests:**

- `apps/runtime/src/__tests__/status-tag-parser.test.ts` — tag extraction, partial chunks, malformed tags, no-tag passthrough, buffer flush

---

#### Task 11: System Prompt Injection for Status Tags

Add the `<status>` tag instruction to the system prompt when fillers are enabled.

**Files to modify:**

- `apps/runtime/src/services/execution/prompt-builder.ts` — append status tag instruction when filler config is enabled

**Details:**

- Only injected when `channelSettings.statusMessages.enabled === true` AND `piggyback === true`
- Lightweight instruction (~60 words) appended to system prompt
- Does not interfere with existing system prompt template resolution
- Instruction is channel-agnostic (the tag is parsed server-side; channel rendering is the adapter's job)

**Tests:**

- `apps/runtime/src/__tests__/prompt-builder-filler.test.ts` — instruction added when enabled, omitted when disabled, omitted when piggyback=false

---

#### Task 12: DSL Parser Extension

Add `CHANNEL_SETTINGS` parsing to the ABL parser.

**Files to modify:**

- `packages/core/src/parser/` — add CHANNEL_SETTINGS section parser
- `packages/compiler/src/` — compile CHANNEL_SETTINGS to `channel_settings` IR field

**Details:**

- New optional section `CHANNEL_SETTINGS:` at agent level
- Parse `status_messages:` sub-block with all configuration fields
- Emit to `AgentIR.channel_settings`

**Tests:**

- `packages/core/src/__tests__/channel-settings-parser.test.ts`
- `packages/compiler/src/__tests__/channel-settings-compiler.test.ts`

---

#### Task 13: Project Settings Integration

Add filler configuration to project-level settings.

**Files to modify:**

- `apps/runtime/src/services/filler/types.ts` — enhance `resolveFillerConfig()` to read ProjectSettings
- Relevant project settings schema / types

**Details:**

- Add `channelSettings.statusMessages` to ProjectSettings schema
- `resolveFillerConfig()` merges: agent IR > project settings > defaults
- Studio UI extension (future) for configuring status messages via project settings

**Tests:**

- Update `apps/runtime/src/__tests__/filler-config.test.ts`

---

#### Task 13: Realtime Voice Executor Integration

Extend filler support to the realtime voice path (for tool call gaps).

**Files to modify:**

- `apps/runtime/src/services/voice/realtime-voice-executor.ts` — add filler timer during tool execution

**Details:**

- Start filler timer when `handleToolCall` begins
- Cancel timer when `submitToolResult` is called
- For realtime providers, inject filler as a conversation item (provider-specific)
- OpenAI Realtime: use `conversation.item.create` with assistant audio
- Gemini Live: use inline text response
- This is lower priority since realtime models often have natural pauses

**Tests:**

- `apps/runtime/src/__tests__/realtime-filler.test.ts`

---

### Phase 3 — Observability & Polish (Tasks 14-16)

#### Task 14: Trace Events & Metrics

Add observability for status message emission across all channels.

**Files to modify:**

- `apps/runtime/src/observability/voice-trace.ts` — add filler-specific trace span helpers (rename or extend for cross-channel)
- `apps/runtime/src/observability/metrics.ts` — add filler counters

**Details:**

- Trace event: `status_emitted` with `{ sessionId, text, operation, mode, channelType, delayMs, index }`
- Trace event: `status_cancelled` with `{ sessionId, reason, channelType }` (response started, barge-in, turn end)
- Prometheus counter: `abl_status_filler_total{mode, channel_type, operation}`
- Prometheus histogram: `abl_status_filler_delay_seconds` (time from silence start to filler emission)

**Tests:**

- `apps/runtime/src/__tests__/filler-trace.test.ts`

---

#### Task 15: ChatWidget Status Rendering Polish

Enhance the Web SDK ChatWidget rendering of status messages.

**Files to modify:**

- `packages/web-sdk/src/ui/ChatWidget.ts` — improved status text animation and styling
- `packages/web-sdk/src/ui/styles.ts` — add status text CSS

**Details:**

- Fade-in/fade-out animation for status text transitions
- Status text positioned below typing dots with subtle styling (smaller font, muted color)
- Multi-step progress rendering: "Step 2 of 3: Comparing prices..."
- Status text auto-scroll behavior (scroll to bottom when new status appears)

**Tests:**

- Manual visual testing in SDK demo page

---

#### Task 16: Studio Debug Panel Integration

Show status events in the Studio Observatory/debug panel.

**Files to modify:**

- Relevant Studio trace event rendering components

**Details:**

- Display `status_emitted` trace events in the Observatory timeline
- Show which operation triggered each status, what text was emitted, and to which channel type
- Useful for debugging filler timing and operation mapping

**Tests:**

- Manual testing in Studio debug UI

---

## Dependency Graph

```
Task 1 (Types & Config)
  ├─ Task 2 (Core Service)   ─┐
  ├─ Task 3 (Adapters)        ├─── all needed by ──→ Task 8 (Coordinator Integration)
  └─ Task 4 (WS Event Types)  │
                               │
Task 5 (Web SDK)  ← depends on Task 4
Task 6 (Voice Registry)  ──→ Task 7 (Voice Handlers)  ──→ Task 8
Task 9 (IR Schema)  ← depends on Task 1

Phase 2:
Task 10 (Status Tag Parser)    ← depends on Task 2
Task 11 (Prompt Injection)     ← depends on Task 8
Task 12 (DSL Parser)           ← depends on Task 9
  └─ Task 12b (Project Settings) ← depends on Task 1
Task 13 (Realtime)             ← depends on Task 2

Phase 3:
Task 14 (Observability)     ← depends on Task 8
Task 15 (Widget Polish)     ← depends on Task 5
Task 16 (Studio Debug)      ← depends on Task 14
```

**Recommended order:** 1 → 2 → 3 → 4 → 5 (parallel with 6 → 7) → 8 → 9 → 10 → 11 → 14 → 12 → 12b → 13 → 15 → 16

---

## Risk Mitigation

| Risk                                      | Mitigation                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Filler overlaps with real response        | Filler is queued with delay gate; discarded if tool completes fast; voice barge-in + `status_clear` for mid-delivery interruption            |
| Fast tool call shows unnecessary filler   | Delay gate (3s voice, 2s chat) ensures filler only emits if operation is genuinely slow; fast completions discard the queued filler silently |
| Voice filler sounds robotic/unnatural     | Use same TTS voice/settings as the agent; piggybacked text is model-generated and contextual                                                 |
| Chat status messages feel spammy          | Higher threshold for chat channels; only one status line at a time; `max_per_turn` cap                                                       |
| Model doesn't emit `<status>` tags        | Static operation-aware pool is always the fallback — zero degradation if model is non-compliant                                              |
| `<status>` tag split across chunks        | Streaming tag parser with 256-char buffer handles partial tags; malformed tags flushed as normal text                                        |
| Too many fillers annoy users              | `max_per_turn` cap (default 5); cooldown enforcement; operation dedup (same operation does not re-trigger)                                   |
| Memory leak from filler timers            | `destroy()` called on session cleanup; timer refs cleared on cancel                                                                          |
| Cross-pod session issue                   | FillerMessageService is session-local (same pod as WS/voice handler); no cross-pod coordination needed                                       |
| Backward compatibility                    | New WS event types are additive; clients that do not handle `status_update` simply ignore it; SDK changes are opt-in                         |
| Status text not useful enough             | Piggybacked `<status>` tags have full conversation context; operation-aware static pool as fallback                                          |
| Async channels receive unnecessary events | `NoopFillerAdapter` ensures zero overhead for Slack/Teams/email/etc.                                                                         |

---

## Key Differences from Voice-Only Design

| Aspect              | Previous (Voice-Only)                  | Current (Cross-Channel)                               |
| ------------------- | -------------------------------------- | ----------------------------------------------------- |
| Scope               | Voice channels only                    | All synchronous channels (voice, chat, SDK)           |
| Event model         | Direct TTS injection                   | Unified `StatusEvent` + channel adapters              |
| Chat support        | Explicitly excluded ("users can wait") | First-class: `status_update` WS events + transient UI |
| SDK support         | None                                   | `ChatEvents.statusUpdate` + React `statusText` state  |
| Operation awareness | Generic message pool                   | Operation-tagged pools driven by trace events         |
| DSL section         | `VOICE_SETTINGS`                       | `CHANNEL_SETTINGS` (channel-agnostic)                 |
| IR field            | `voice_settings`                       | `channel_settings`                                    |
| Progress tracking   | None                                   | Multi-step progress: "Step 2 of 3: ..."               |
| File organization   | `services/voice/filler-*`              | `services/filler/` (channel-agnostic location)        |
