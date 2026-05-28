# Low-Level Design & Implementation Plan: Filler Messages

**Feature slug**: filler-messages
**Status**: Phase 1 STABLE, Phase 2-3 PLANNED
**Created**: 2026-03-23
**Last updated**: 2026-03-23
**Feature spec**: `docs/features/filler-messages.md`
**Test spec**: `docs/testing/filler-messages.md`
**HLD**: `docs/specs/filler-messages.hld.md`

---

## Implementation Status

### Phase 1 -- Core + Chat/WebSocket (COMPLETED 2026-03-11)

All Phase 1 tasks are implemented and tested. This LLD documents the existing implementation for reference and defines Phase 2-3 implementation plans.

| Task | Description                   | Status | Files                                     |
| ---- | ----------------------------- | ------ | ----------------------------------------- |
| 1.1  | Types & Config                | DONE   | `services/filler/types.ts`                |
| 1.2  | Static Message Pools          | DONE   | `services/filler/message-pools.ts`        |
| 1.3  | FillerMessageService Core     | DONE   | `services/filler/filler-service.ts`       |
| 1.4  | Pipeline Filler Generator     | DONE   | `services/filler/pipeline-filler.ts`      |
| 1.5  | Status Tag Parser             | DONE   | `services/filler/status-tag-parser.ts`    |
| 1.6  | WebSocket Event Types         | DONE   | `websocket/events.ts` (extended)          |
| 1.7  | WebSocket Handler Integration | DONE   | `websocket/handler.ts` (extended)         |
| 1.8  | RuntimeExecutor Wiring        | DONE   | `services/runtime-executor.ts` (extended) |
| 1.9  | Unit & Integration Tests      | DONE   | 4 test files, 34 tests                    |

All paths below are relative to `apps/runtime/src/`.

---

## Phase 1 -- Detailed Implementation Reference

### Task 1.1: Types & Config (`services/filler/types.ts`)

**Exports:**

- `StatusOperation` -- union type: `'tool_call' | 'reasoning' | 'handoff' | 'delegation' | 'extraction' | 'constraint_check' | 'general'`
- `StatusEvent` -- emitted to client: `{ id, sessionId, text, operation, transient: true, index, timestamp }`
- `FillerConfig` -- service configuration: `{ enabled, chatDelayMs, cooldownMs, maxPerTurn }`
- `DEFAULT_FILLER_CONFIG` -- defaults: `{ enabled: true, chatDelayMs: 1200, cooldownMs: 3000, maxPerTurn: 5 }`
- `QueuedFiller` -- internal queue entry: `{ text, source, operation, queuedAt, timerId }`

**Design decisions:**

- `chatDelayMs` was tuned from 2000ms (initial design) to 1200ms (production) based on UX feedback
- `cooldownMs` was tuned from 5000ms to 3000ms to allow more frequent updates in multi-step flows
- `source` field on `QueuedFiller` distinguishes priority: `'pipeline' | 'piggybacked' | 'static'`

### Task 1.2: Static Message Pools (`services/filler/message-pools.ts`)

**Exports:**

- `OPERATION_MESSAGES` -- `Record<StatusOperation, string[]>` with user-centric messages per operation
- `TOOL_MESSAGES` -- `Record<string, string[]>` with messages for well-known tool names
- `getFillerMessage(operation, recentHistory?, toolName?)` -- selects message with dedup

**Design decisions:**

- Messages are user-centric ("Searching for that now...") not architecture-centric ("Executing tool call...")
- Tool-specific messages checked first, then operation pool, then `general` fallback
- Dedup filters against `recentHistory` array; falls back to full pool if all filtered out
- No Redis needed -- history is passed in by caller (session-scoped)

### Task 1.3: FillerMessageService Core (`services/filler/filler-service.ts`)

**Class: `FillerMessageService`**

Constructor: `(sessionId: string, config: FillerConfig, onEmit: (event: StatusEvent) => void)`

**Public API:**

| Method                                  | Behavior                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `queueFiller(operation, text, source?)` | Queue a filler. Pipeline/piggybacked emit immediately; static goes through delay gate. Respects cooldown (static only) and maxPerTurn. |
| `cancel()`                              | Clear pending filler timer. Called when real response arrives.                                                                         |
| `reset()`                               | Alias for cancel -- LLM chunk reached user.                                                                                            |
| `resetTurn()`                           | Reset turn counter and clear pending. Called for new execution turn.                                                                   |
| `destroy()`                             | Mark destroyed, clear all timers. Called on session cleanup.                                                                           |
| `isDestroyed()`                         | Check if service has been destroyed.                                                                                                   |
| `setPipelineFiller(text)`               | Store a pipeline-generated filler for the next operation event.                                                                        |
| `consumePipelineFiller()`               | Get and consume the stored pipeline filler (returns null if absent/consumed).                                                          |

**Internal state:**

- `pending: QueuedFiller | null` -- at most one pending filler at a time
- `turnEmitCount` -- emissions this turn (bounded by maxPerTurn)
- `turnIndex` -- sequential index for StatusEvent ordering
- `lastEmitTime` -- cooldown tracking
- `destroyed` -- guards against post-destroy emissions
- `pipelineFiller: string | null` -- stored pipeline filler text

**Key behaviors:**

1. Pipeline/piggybacked fillers have delay=0 (emit immediately) and skip cooldown
2. Static fillers go through `chatDelayMs` delay gate
3. New filler replaces any pending filler (clearPending first)
4. Emission produces a `StatusEvent` with UUID, session ID, timestamps
5. All timer IDs stored for cleanup on destroy

### Task 1.4: Pipeline Filler Generator (`services/filler/pipeline-filler.ts`)

**Export: `generatePipelineFiller(model: LanguageModel, userMessage: string): Promise<string | null>`**

- Uses Vercel AI SDK `generateText()` with:
  - Prompt template asking for <12 word status message
  - `maxOutputTokens: 30`, `temperature: 0`
  - `AbortSignal.timeout(2000)` -- hard 2s timeout
- Post-processing: trim, remove quotes, normalize ending to "..."
- Returns `null` for: empty result, >100 chars, "NONE" (greetings), timeout, any error
- Logs at debug level via `createLogger('pipeline-filler')`

### Task 1.5: Status Tag Parser (`services/filler/status-tag-parser.ts`)

**Class: `StatusTagParser`**

- Streaming parser for `<status>...</status>` tags in LLM output
- Handles tags split across multiple chunks via 256-byte buffer
- `processChunk(chunk)` returns `{ outputChunk, statusText }`
- `flush()` returns any buffered content at stream end (incomplete tags become regular text)
- Multiple tags in one chunk: last tag wins for `statusText`
- Oversized buffer (>256 bytes without closing tag): flushed as regular text

### Task 1.6-1.7: WebSocket Integration

**events.ts additions:**

```typescript
statusUpdate(sessionId, text, operation, index) -> { type: 'status_update', sessionId, text, operation, transient: true, index }
statusClear(sessionId) -> { type: 'status_clear', sessionId }
```

**handler.ts additions (in `createTraceEventHandler`):**

- Detects `status_update` trace events and forwards via `ServerMessages.statusUpdate()`
- Detects `status_clear` trace events and forwards via `ServerMessages.statusClear()`

### Task 1.8: RuntimeExecutor Wiring

**Location**: `services/runtime-executor.ts`, within `createCentralizedTraceHandler` and execution flow

**Trace-to-operation mapping** (`traceToFillerOperation`):

```
tool_call        -> 'tool_call'
handoff          -> 'handoff'
handoff_progress -> 'handoff'
delegate_start   -> 'delegation'
fan_out_start    -> 'delegation'
dsl_collect      -> 'extraction'
constraint_check -> 'constraint_check'
```

**Wiring flow** (in `executeMessage`):

1. Create `FillerMessageService` with `onEmit` that emits `status_update` trace event
2. Wrap `onChunk` with `StatusTagParser`:
   - Piggybacked `<status>` text -> `queueFiller('general', text, 'piggybacked')`
   - Regular output text -> `fillerService.cancel()` + forward original chunk
3. Fire `generatePipelineFiller()` in parallel (async):
   - Success -> `queueFiller('tool_call', text, 'pipeline')`
   - Failure -> silent (static fallback handles it)
4. Wrap `onTraceEvent`:
   - Map trace type to `StatusOperation`
   - Select message via `getFillerMessage(op, [], toolName)`
   - Queue as static: `queueFiller(op, text, 'static')`
5. On execution complete: `fillerService.destroy()`

### Task 1.9: Tests

| Test File                      | Tests | Coverage                                                                   |
| ------------------------------ | ----- | -------------------------------------------------------------------------- |
| `filler-service.test.ts`       | 15    | Delay, cancel, cooldown, maxPerTurn, pipeline priority, destroy, resetTurn |
| `filler-message-pools.test.ts` | 4     | All operations, correct pool, dedup, tool-specific                         |
| `filler-integration.test.ts`   | 5     | Trace mapping, fast cancel, handoff, sequence, unknown events              |
| `status-tag-parser.test.ts`    | 11    | Complete/split/multiple tags, flush, edge cases                            |

---

## Phase 2 -- Voice Adapters + DSL Configuration

### Task 2.1: Channel Filler Adapter Interface

**File**: `services/filler/adapters/channel-filler-adapter.ts` (CREATE)

```typescript
export interface ChannelFillerAdapter {
  emitStatus(event: StatusEvent): void;
  clearStatus(sessionId: string): void;
  cancelPlayback?(sessionId: string): void;
}
```

**Implementations** (3 files to create):

| Adapter                  | File                                   | Channels                                               | Behavior                                               |
| ------------------------ | -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `WebSocketFillerAdapter` | `adapters/websocket-filler-adapter.ts` | web_chat, sdk_websocket, web_debug                     | Send `status_update`/`status_clear` via WebSocket      |
| `VoiceFillerAdapter`     | `adapters/voice-filler-adapter.ts`     | voice, voice_twilio, voice_livekit, korevg, audiocodes | Call `sendFiller()` on voice handler; barge-in enabled |
| `NoopFillerAdapter`      | `adapters/noop-filler-adapter.ts`      | slack, teams, whatsapp, email, api, etc.               | No-op -- async channels don't need fillers             |

**Factory**: `resolveChannelAdapter(session: RuntimeSession, ws?: WebSocket): ChannelFillerAdapter`

**Exit criteria:**

- [ ] Interface defined with JSDoc
- [ ] Three implementations created
- [ ] Factory function resolves correct adapter per channel type
- [ ] Unit tests for adapter resolution
- [ ] Build passes: `pnpm build --filter=runtime`

### Task 2.2: Voice Session Registry

**File**: `services/filler/voice-session-registry.ts` (CREATE)

```typescript
interface VoiceOutputHandler {
  sendFiller(text: string): void;
  cancelFiller(): void;
}

class VoiceSessionRegistry {
  private handlers: Map<string, { handler: VoiceOutputHandler; registeredAt: number }>;
  register(sessionId: string, handler: VoiceOutputHandler): void;
  unregister(sessionId: string): void;
  get(sessionId: string): VoiceOutputHandler | undefined;
}
```

**Platform invariant compliance:**

- Max size: 10,000 entries
- TTL: 1 hour (3,600,000ms)
- Eviction: on `get()`, check TTL; periodic sweep every 5 minutes
- Singleton export

**Exit criteria:**

- [ ] Registry with bounded Map, TTL, eviction
- [ ] Unit tests: register, get, unregister, max size, TTL expiry
- [ ] Build passes

### Task 2.3: Voice Handler Filler Methods

**Files to modify:**

| Voice Handler | File                                      | Method             | Mechanism                                            |
| ------------- | ----------------------------------------- | ------------------ | ---------------------------------------------------- |
| KoreVG        | `services/voice/korevg/korevg-session.ts` | `sendFiller(text)` | Send `say` verb with `bargeIn: true` via WebSocket   |
| Twilio        | `websocket/twilio-media-handler.ts`       | `sendFiller(text)` | Synthesize via ElevenLabs TTS, stream audio chunks   |
| LiveKit       | `services/voice/livekit/agent-worker.ts`  | `sendFiller(text)` | Inject as synthetic assistant text into AgentSession |

All handlers also need:

- `cancelFiller()` to stop in-progress TTS playback
- `implements VoiceOutputHandler`
- Registration with `VoiceSessionRegistry` on session start
- Unregistration on session close/disconnect

**Exit criteria:**

- [ ] All three handlers implement `VoiceOutputHandler`
- [ ] Register/unregister on session lifecycle
- [ ] Unit tests per handler (sendFiller, cancelFiller, error handling)
- [ ] Integration test: voice session with filler emission
- [ ] Build passes

### Task 2.4: DSL CHANNEL_SETTINGS Parser

**Files to modify:**

- `packages/compiler/src/parser/` -- Add CHANNEL_SETTINGS section parsing
- `packages/compiler/src/platform/ir/schema.ts` -- Add `ChannelSettingsIR` type
- `packages/compiler/src/emitter/` -- Emit `channel_settings` in agent IR

**DSL syntax:**

```yaml
AGENT CustomerService
  CHANNEL_SETTINGS:
    status_messages:
      enabled: true
      piggyback: true
      delay_ms: 3000
      chat_delay_ms: 2000
      cooldown_ms: 5000
      max_per_turn: 5
      voice_messages:
        - "One moment please."
        - "Let me check on that for you."
      chat_messages:
        - "Searching..."
        - "Working on that..."
```

**IR output:**

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

**Exit criteria:**

- [ ] Parser recognizes CHANNEL_SETTINGS section
- [ ] IR schema includes `channel_settings` on AgentIR
- [ ] Compiler emits channel_settings in IR output
- [ ] Compiler unit tests: parse, emit, validation
- [ ] Build passes: `pnpm build --filter=compiler`

### Task 2.5: Config Resolution

**File**: `services/filler/config-resolver.ts` (CREATE)

```typescript
export function resolveFillerConfig(
  agentIR: AgentIR | undefined,
  projectSettings: ProjectSettings | undefined,
  channelType: ChannelType,
): FillerConfig;
```

**Resolution priority:**

1. Agent IR `channel_settings.status_messages` (highest)
2. Project settings `channelSettings.statusMessages`
3. `DEFAULT_FILLER_CONFIG`

**Channel-aware defaults:**

- Voice channels: `delayMs = voiceDelayMs || 1200`
- Chat channels: `delayMs = chatDelayMs || 1200`

**Exit criteria:**

- [ ] Resolution function with three-level priority
- [ ] Channel-type-aware delay selection
- [ ] Unit tests: each resolution level, override behavior, missing config
- [ ] Build passes

### Task 2.6: Wire Voice Adapters into RuntimeExecutor

**File to modify:** `services/runtime-executor.ts`

**Changes:**

- Import `resolveChannelAdapter` and `resolveFillerConfig`
- Replace hardcoded `FillerConfig` with resolved config
- Pass channel adapter to `FillerMessageService.onEmit`
- Voice adapter: `onEmit` calls `adapter.emitStatus(event)` instead of trace event
- Chat adapter: existing trace event approach continues to work

**Exit criteria:**

- [ ] RuntimeExecutor uses resolved config and adapter
- [ ] Voice sessions route fillers through VoiceFillerAdapter
- [ ] Chat sessions continue using existing trace event path
- [ ] Integration tests: voice and chat paths
- [ ] Build passes

---

## Phase 3 -- Web SDK + Studio

### Task 3.1: Web SDK ChatClient Events

**Files to modify:**

- `packages/web-sdk/src/core/types.ts` -- Add `statusUpdate`, `statusClear` to `ChatEvents`
- `packages/web-sdk/src/chat/ChatClient.ts` -- Handle `status_update`, `status_clear` server messages

**Exit criteria:**

- [ ] ChatClient emits `statusUpdate({ text, operation, transient })` on `status_update` message
- [ ] ChatClient emits `statusClear` on `status_clear` message
- [ ] Unit tests for event emission
- [ ] Build passes: `pnpm build --filter=web-sdk`

### Task 3.2: React AgentProvider statusText

**Files to modify:**

- `packages/web-sdk/src/react/AgentProvider.tsx` -- Add `statusText` state
- `packages/web-sdk/src/react/hooks.ts` -- Expose in `useAgent()` return

**Behavior:**

- `statusUpdate` -> `setStatusText(text)`
- `statusClear` / `response_end` / `typing: false` -> `setStatusText(null)`

**Exit criteria:**

- [ ] `useAgent()` returns `{ statusText: string | null }`
- [ ] State updates on statusUpdate/statusClear events
- [ ] Auto-clear on response_end
- [ ] Unit tests for state management

### Task 3.3: ChatWidget Status Rendering

**File to modify:** `packages/web-sdk/src/ui/ChatWidget.ts`

**Rendering:**

- Status text appears as a transient line below typing indicator dots
- Only shown when `isTyping === true && statusText !== null`
- Styled as muted text, smaller font, with fade-in animation
- Replaces previous status text (only one at a time)
- Never added to message list/history

**Exit criteria:**

- [ ] Status text renders below typing indicator
- [ ] Disappears on status_clear
- [ ] Not persisted to message list
- [ ] Visual regression test or screenshot verification

### Task 3.4: Studio Debug Panel Filler Display

**File**: `apps/studio/src/components/chat/` (determine exact file)

**Display:**

- In debug/trace panel, show filler events with:
  - Source (pipeline / piggybacked / static)
  - Operation type
  - Text
  - Timing (queued at, emitted at, or cancelled)

**Exit criteria:**

- [ ] Filler events visible in Studio debug panel
- [ ] Source, operation, and text displayed
- [ ] Build passes: `pnpm build --filter=studio`

### Task 3.5: Filler Trace Observability

**Files to modify:**

- `services/filler/filler-service.ts` -- Emit trace events for filler lifecycle
- `services/runtime-executor.ts` -- Forward filler trace events to TraceStore

**Trace events:**

- `filler_queued`: operation, source, text
- `filler_emitted`: operation, source, text, delayMs
- `filler_cancelled`: reason (fast_completion, response_arrived, replaced)
- `filler_discarded`: reason (cooldown, maxPerTurn, disabled)

**Exit criteria:**

- [ ] Trace events emitted for all filler lifecycle states
- [ ] Visible in trace store and Studio trace viewer
- [ ] No impact on filler timing (trace emission is async)

---

## Wiring Checklist

### Phase 1 Wiring (COMPLETED)

- [x] `filler-service.ts` imported in `runtime-executor.ts`
- [x] `getFillerMessage` imported in `runtime-executor.ts`
- [x] `StatusTagParser` used in `runtime-executor.ts` onChunk wrapper
- [x] `generatePipelineFiller` called in parallel from `runtime-executor.ts`
- [x] `traceToFillerOperation` defined in `runtime-executor.ts`
- [x] `ServerMessages.statusUpdate()` added to `events.ts`
- [x] `ServerMessages.statusClear()` added to `events.ts`
- [x] `status_update` handling added to `handler.ts` createTraceEventHandler
- [x] `status_clear` handling added to `handler.ts` createTraceEventHandler
- [x] `fillerService.destroy()` called on execution cleanup

### Phase 2 Wiring (TODO)

- [ ] `ChannelFillerAdapter` interface created
- [ ] `WebSocketFillerAdapter` created and tested
- [ ] `VoiceFillerAdapter` created and tested
- [ ] `NoopFillerAdapter` created and tested
- [ ] `resolveChannelAdapter()` factory created
- [ ] `VoiceSessionRegistry` singleton created
- [ ] KoreVG `sendFiller()` implemented and registered
- [ ] Twilio `sendFiller()` implemented and registered
- [ ] LiveKit `sendFiller()` implemented and registered
- [ ] `CHANNEL_SETTINGS` parser added to compiler
- [ ] `ChannelSettingsIR` added to IR schema
- [ ] `resolveFillerConfig()` created
- [ ] `RuntimeExecutor` updated to use resolved config and adapter

### Phase 3 Wiring (TODO)

- [ ] `ChatEvents.statusUpdate` added to web-sdk types
- [ ] `ChatEvents.statusClear` added to web-sdk types
- [ ] `ChatClient.handleServerMessage()` handles status events
- [ ] `AgentProvider` exposes `statusText` state
- [ ] `ChatWidget` renders status text
- [ ] Filler trace events added to TraceStore
- [ ] Studio debug panel shows filler events

---

## Exit Criteria by Phase

### Phase 1 (ACHIEVED)

- [x] FillerMessageService creates per-session, emits status events after delay
- [x] Static message pools return operation-aware messages without repetition
- [x] Pipeline filler generates query-specific messages with 2s timeout
- [x] Status tag parser extracts `<status>` tags from LLM stream across chunk boundaries
- [x] WebSocket `status_update`/`status_clear` events sent to connected clients
- [x] 34 tests passing across 4 test files
- [x] Build clean: `pnpm build --filter=runtime`

### Phase 2

- [ ] Voice fillers play via TTS on KoreVG, Twilio, and LiveKit
- [ ] Barge-in interrupts filler playback on all voice handlers
- [ ] Voice session registry bounded (10K entries, 1hr TTL)
- [ ] DSL `CHANNEL_SETTINGS` section parsed and emitted in IR
- [ ] Config resolution: agent DSL > project > defaults
- [ ] All voice E2E scenarios passing (E2E-V1, V2, V3)
- [ ] All voice integration scenarios passing (INT-V1, V2)
- [ ] Build clean: `pnpm build --filter=runtime --filter=compiler`

### Phase 3

- [ ] Web SDK emits `statusUpdate`/`statusClear` events
- [ ] React `useAgent()` returns `statusText`
- [ ] ChatWidget renders transient status text
- [ ] Filler trace events visible in Studio
- [ ] All SDK E2E scenarios passing (E2E-SDK1, SDK2, SDK3)
- [ ] Build clean: `pnpm build --filter=runtime --filter=web-sdk --filter=studio`
