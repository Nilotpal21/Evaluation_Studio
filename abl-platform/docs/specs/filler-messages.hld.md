# High-Level Design: Filler Messages

**Feature slug**: filler-messages
**Status**: STABLE (Phase 1), ALPHA (Phase 2 channel-config layer), PLANNED (Phase 2 voice adapters / Phase 3)
**Created**: 2026-03-23
**Last updated**: 2026-04-29
**Feature spec**: `docs/features/filler-messages.md`
**Test spec**: `docs/testing/filler-messages.md`

---

## 1. Overview

The filler messages system provides contextual status feedback to users during long-running agent operations (tool calls, handoffs, multi-step reasoning). It eliminates dead-air on voice channels and replaces generic typing indicators on chat channels with operation-specific status text.

The system uses a per-session `FillerMessageService` that listens to execution trace events, queues operation-aware status messages behind a configurable delay gate, and emits them through channel-specific adapters. Three filler sources are supported with descending priority: pipeline-generated (parallel LLM call), LLM-piggybacked (`<status>` tags in primary model stream), and static operation-aware message pools.

---

## 2. Architecture

### 2.1 Component Diagram

```
User Input
    |
    v
RuntimeExecutor.executeMessage()
    |
    +-- Creates FillerMessageService(sessionId, config, onEmit)
    |
    +-- Wraps onChunk with StatusTagParser
    |       |
    |       +-- <status> tag found -> queueFiller('general', text, 'piggybacked')
    |       +-- Regular text -> fillerService.cancel() + forward to client
    |
    +-- Fires generatePipelineFiller() in parallel (async, best-effort)
    |       |
    |       +-- Success -> fillerService.queueFiller('tool_call', text, 'pipeline')
    |       +-- Timeout/failure -> silent fallback to static
    |
    +-- Wraps onTraceEvent with filler mapping
    |       |
    |       +-- Maps trace type to StatusOperation
    |       +-- Selects message from getFillerMessage(op, history, toolName)
    |       +-- fillerService.queueFiller(op, text, 'static')
    |
    +-- FillerMessageService internals:
    |       |
    |       +-- Delay gate (chatDelayMs / voiceDelayMs)
    |       +-- Cooldown enforcement (cooldownMs)
    |       +-- maxPerTurn cap
    |       +-- Pipeline/piggybacked skip delay (emit immediately)
    |       +-- Static fillers go through delay gate
    |
    +-- onEmit callback:
            |
            +-- Emits trace event { type: 'status_update', data: { text, operation } }
            +-- WebSocket handler forwards as ServerMessages.statusUpdate()
            +-- Client receives { type: 'status_update', text, operation, transient: true }
```

### 2.2 Key Components

| Component                  | Location                                                | Responsibility                                                                  |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `FillerMessageService`     | `apps/runtime/src/services/filler/filler-service.ts`    | Per-session lifecycle: queue, delay gate, cancel, cooldown, maxPerTurn, destroy |
| `getFillerMessage()`       | `apps/runtime/src/services/filler/message-pools.ts`     | Static message selection with operation-awareness and dedup                     |
| `generatePipelineFiller()` | `apps/runtime/src/services/filler/pipeline-filler.ts`   | Parallel LLM call for query-specific filler generation                          |
| `StatusTagParser`          | `apps/runtime/src/services/filler/status-tag-parser.ts` | Streaming parser for `<status>` tags in LLM output                              |
| `resolveFillerConfig()`    | `apps/runtime/src/services/filler/config-resolver.ts`   | Pure function: `channelType → FillerConfig`; bottom layer of FR-12 (ABLP-710)   |
| `ChannelManifestEntry`     | `apps/runtime/src/channels/manifest.ts`                 | `fillerMode: ChannelFillerMode` — single source of truth for channel capability |
| `types.ts`                 | `apps/runtime/src/services/filler/types.ts`             | StatusEvent, StatusOperation, FillerConfig, QueuedFiller                        |
| `RuntimeExecutor`          | `apps/runtime/src/services/runtime-executor.ts`         | Wiring: creates service, wraps callbacks, fires pipeline filler                 |
| `ServerMessages`           | `apps/runtime/src/websocket/events.ts`                  | `statusUpdate()`, `statusClear()` factory methods                               |
| `handler.ts`               | `apps/runtime/src/websocket/handler.ts`                 | Forwards `status_update`/`status_clear` trace events to WebSocket               |

### 2.3 Data Flow

**Filler emission path (chat/WebSocket):**

1. `RuntimeExecutor` creates `FillerMessageService` with `onEmit` callback
2. `onEmit` wraps the filler as a trace event: `{ type: 'status_update', data: { text, operation, index } }`
3. The centralized trace handler in `RuntimeExecutor` emits this to the WebSocket handler's `onTraceEvent`
4. `handler.ts` detects `status_update` trace events and sends `ServerMessages.statusUpdate()` via WebSocket
5. Client receives JSON: `{ type: 'status_update', sessionId, text, operation, transient: true, index }`

**Cancellation path:**

1. When LLM streaming produces a real output chunk, `fillerService.cancel()` is called
2. Any pending timer is cleared; pending filler is discarded
3. `status_clear` event sent to client

---

## 3. Twelve Architectural Concerns

### 3.1 Resource Isolation

- `FillerMessageService` is scoped per-session -- each session has its own instance with independent state
- Session ID is embedded in every `StatusEvent`, ensuring events are routed to the correct client
- No cross-session data access -- message history and turn counters are instance-local
- Pipeline filler uses session-scoped model resolution (inherits tenant/project context from execution)

### 3.2 Authentication & Authorization

- Fillers are emitted within authenticated execution paths only -- the `RuntimeExecutor` is invoked after auth middleware
- No new API endpoints or permission checks needed -- fillers piggyback on existing execution traces
- WebSocket connections are already authenticated via JWT before any messages are processed

### 3.3 Stateless & Distributed

- `FillerMessageService` is in-memory per session, per pod -- this is acceptable because:
  - Fillers are transient (not persisted) and ephemeral (destroyed with session)
  - Sessions are sticky to pods via WebSocket connections
  - No cross-pod coordination needed
- Pipeline filler state (pending LLM call) is fire-and-forget -- no distributed locks needed
- Static message pools are pure functions with no shared state

### 3.4 Traceability

- Every filler emission is surfaced as a trace event (`status_update` type) flowing through the existing `onTraceEvent` pipeline
- The `StatusEvent` includes: session ID, operation type, text, index, timestamp
- Phase 2 will add dedicated filler trace events to `TraceStore` for observability dashboards
- Pipeline filler generation logs debug-level messages via `createLogger('pipeline-filler')`

### 3.5 Compliance & Data Privacy

- Filler messages are transient (`transient: true`) and NEVER persisted to conversation history or database
- No PII in static message pools -- messages are generic operational status text
- Pipeline-generated fillers may reference user query terms, but they are ephemeral and not stored
- Status tag content is extracted from the LLM stream and never persisted separately

### 3.6 Performance

- Static filler selection: O(1) -- array index lookup, no computation
- Timer overhead: single `setTimeout` per queued filler -- negligible
- Pipeline filler: async parallel call with 2s timeout -- does not block execution path
- Status tag parser: streaming, constant memory (256-byte buffer max), processes each chunk in O(n)
- Cooldown and maxPerTurn prevent excessive event emission under load

### 3.7 Error Handling

- Pipeline filler failure: caught, logged at debug level, falls back to static pool silently
- Status tag parser malformation: oversized buffers flushed as regular text, incomplete tags flushed at stream end
- `FillerMessageService.queueFiller()` is a no-op when: disabled, destroyed, maxPerTurn reached, or within cooldown
- WebSocket send failure: fire-and-forget (filler is best-effort, not critical path)

### 3.8 Backward Compatibility

- New `status_update` and `status_clear` WebSocket event types are additive -- existing clients that don't handle them simply ignore unknown event types
- No changes to existing `typing_start`, `response_start`, `response_chunk`, `response_end` lifecycle
- `ServerMessage` union type is extended, not modified -- no breaking type changes
- Fillers are disabled by default for agents without explicit configuration (Phase 2)

### 3.9 Scalability

- Per-session in-memory state scales linearly with active sessions (one `FillerMessageService` per session)
- Memory per service: ~200 bytes (config + counters + one pending filler)
- No shared state, no coordination -- scales horizontally with pod count
- Pipeline filler adds one LLM call per execution turn (bounded by session rate)

### 3.10 Configuration Management

- **Phase 1**: Hardcoded defaults in `DEFAULT_FILLER_CONFIG` -- enabled=true, chatDelayMs=1200, cooldownMs=3000, maxPerTurn=5
- **ABLP-710 (implemented)**: Channel-type-aware defaults resolution. `resolveFillerConfig(channelType)` maps channel types to config via `CHANNEL_MANIFEST.fillerMode`. Three modes: `'chat'` (default), `'voice_pipeline'` (tighter config), `'none'` (disabled — `voice_realtime`, `voice_vxml`). This is the bottom layer of the Phase 2 three-level resolution stack.
- **Phase 2 (planned)**: Full three-level configuration resolution:
  1. Agent DSL `CHANNEL_SETTINGS.status_messages` (highest priority)
  2. Project settings `channelSettings.statusMessages`
  3. Channel-type defaults via `resolveFillerConfig` (ABLP-710, implemented)
- Voice channels use separate `voiceDelayMs` (500ms default, shorter than chat `chatDelayMs`)

### 3.11 Monitoring & Observability

- **Phase 1**: Filler events visible in WebSocket trace stream (debug mode)
- **Phase 2**: Dedicated trace events for filler emissions with metrics:
  - Filler emission count per session/turn
  - Pipeline filler hit rate vs static fallback
  - Average filler delay (time from operation start to filler emission)
  - Piggybacked tag detection rate per model
- Pipeline filler latency logged at debug level

### 3.12 Testing Strategy

| Layer         | Coverage                                     | Key Tests                                              |
| ------------- | -------------------------------------------- | ------------------------------------------------------ |
| Unit          | FillerMessageService core (15 tests)         | Delay, cancel, cooldown, maxPerTurn, pipeline priority |
| Unit          | Message pools (4 tests)                      | All operations, dedup, tool-specific                   |
| Unit          | StatusTagParser (12 tests)                   | Split chunks, flush, multiple tags                     |
| Unit          | Channel config resolver (20 tests, ABLP-710) | All 28 channel families, shape contract                |
| Integration   | Trace event mapping (5 tests)                | Operation mapping, fast cancel, sequence               |
| Integration   | Config propagation (5 tests, ABLP-710)       | Disabled guard, chat delay, voice maxPerTurn cap       |
| E2E (planned) | WebSocket filler flow (7 scenarios)          | Real server, real WebSocket, operation timing          |
| E2E (Phase 2) | Voice filler flow (3 scenarios)              | KoreVG, Twilio, LiveKit                                |
| E2E (Phase 3) | Web SDK rendering (3 scenarios)              | ChatWidget, AgentProvider                              |

---

## 4. Alternatives Considered

### 4.1 Separate Small Model for Dynamic Fillers

**Approach**: Call a cheap model (e.g., Haiku, GPT-4o-mini) for each filler generation.

**Rejected because**:

- Adds 200-500ms latency per filler (network + inference)
- Additional LLM cost (~$0.00005/filler, adds up at scale)
- Limited context (needs separate prompt with conversation summary)
- More complex (model routing, timeout, fallback logic)

**Chosen instead**: LLM piggybacking (`<status>` tags) gives the same contextual quality at zero cost and zero latency, with static pools as reliable fallback.

### 4.2 Client-Side Timer Approach

**Approach**: Let the client SDK detect silence and show its own status messages.

**Rejected because**:

- Client has no visibility into what the server is doing (tool call vs reasoning vs handoff)
- Generic "still processing..." messages provide no operational context
- Voice channels cannot be handled client-side (need server-side TTS)
- Different clients would have inconsistent behavior

### 4.3 LangGraph-Based Filler System (AgenticAI Pattern)

**Approach**: Use a separate LangGraph workflow for filler generation (as in AgenticAI's `FillerMessageGraphBuilder`).

**Rejected because**:

- Adds a heavyweight dependency (LangGraph framework) for a focused use case
- Requires Redis for filler history tracking (50 entries, 900s TTL)
- Complex orchestration between filler graph and main execution graph
- ABL already has trace events and execution hooks that integrate naturally

**Chosen instead**: Direct integration with `RuntimeExecutor` trace events and `FillerMessageService` -- simpler, lower overhead, and leverages existing infrastructure.

### 4.4 WebSocket-Only Approach (No Voice)

**Approach**: Only support chat/WebSocket fillers, ignore voice channels.

**Rejected because**:

- Voice channels have the most critical user impact (dead-air causes hangups)
- The unified `FillerMessageService` architecture supports both with channel-specific adapters
- Phase 2 adds voice at low incremental cost given Phase 1 foundation

---

## 5. Data Model

### 5.1 StatusEvent (Runtime -- Not Persisted)

```typescript
interface StatusEvent {
  id: string; // UUID
  sessionId: string;
  text: string; // Human-readable status text
  operation: StatusOperation; // tool_call | reasoning | handoff | ...
  transient: true; // Always true -- never persisted
  index: number; // Sequential within turn
  timestamp: number; // Unix ms
}
```

### 5.2 FillerConfig (Runtime Configuration)

```typescript
interface FillerConfig {
  enabled: boolean;
  chatDelayMs: number; // Default: 1200
  voiceDelayMs?: number; // Default: 500 for voice_pipeline channels (ABLP-710)
  cooldownMs: number; // Default: 3000 (5000 for voice_pipeline)
  maxPerTurn: number; // Default: 5 (3 for voice_pipeline)
}
```

`resolveFillerConfig(channelType)` returns one of three config shapes:

- **chat** (default): `DEFAULT_FILLER_CONFIG` — `chatDelayMs:1200, cooldownMs:3000, maxPerTurn:5`
- **voice_pipeline**: `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG` — `voiceDelayMs:500, cooldownMs:5000, maxPerTurn:3`
- **none** (`voice_realtime`, `voice_vxml`): `{ ...DEFAULT_FILLER_CONFIG, enabled: false }` — skips entire filler block

### 5.3 QueuedFiller (Internal State)

```typescript
interface QueuedFiller {
  text: string;
  source: 'pipeline' | 'piggybacked' | 'static';
  operation: StatusOperation;
  queuedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
}
```

### 5.4 ChannelSettingsIR (Phase 2 -- Agent IR Extension)

```typescript
interface ChannelSettingsIR {
  status_messages?: {
    enabled: boolean;
    piggyback: boolean; // Ask LLM to emit <status> tags
    delay_ms: number;
    chat_delay_ms?: number;
    cooldown_ms: number;
    max_per_turn: number;
    voice_messages?: string[]; // Custom voice pool
    chat_messages?: string[]; // Custom chat pool
  };
}
```

No database schema changes -- all state is in-memory and transient.

---

## 6. API Changes

### 6.1 WebSocket Server Events (Added)

**`status_update`** -- Emitted when a filler message fires:

```json
{
  "type": "status_update",
  "sessionId": "sess-abc123",
  "text": "Searching for products...",
  "operation": "tool_call",
  "transient": true,
  "index": 0
}
```

**`status_clear`** -- Emitted when response starts streaming:

```json
{
  "type": "status_clear",
  "sessionId": "sess-abc123"
}
```

### 6.2 ServerMessages Factory (Extended)

```typescript
statusUpdate(sessionId: string, text: string, operation: string, index: number): ServerMessage;
statusClear(sessionId: string): ServerMessage;
```

### 6.3 No REST API Changes

Filler messages are emitted through the existing WebSocket trace event pipeline. No new REST endpoints.

---

## 7. Phase Plan

| Phase                               | Scope                                                                                                                  | Status  | Key Deliverables                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------- |
| **1 -- Core + Chat**                | FillerMessageService, static pools, pipeline filler, status tag parser, WebSocket events, RuntimeExecutor wiring       | STABLE  | 6 source files, 4 test files, 36 tests            |
| **2a -- Channel Config (ABLP-710)** | `ChannelFillerMode` manifest field, `resolveFillerConfig`, `DEFAULT_VOICE_PIPELINE_FILLER_CONFIG`, runtime wiring      | ALPHA   | 2 source files + 1 config, 2 test files, 25 tests |
| **2b -- Voice Adapters + DSL**      | Voice adapters (KoreVG, Twilio, LiveKit), voice session registry, DSL CHANNEL_SETTINGS, IR extension, project settings | PLANNED | ~10 source files, ~5 test files                   |
| **3 -- SDK + Studio**               | Web SDK events, ChatWidget rendering, React AgentProvider, Studio debug panel, filler trace observability              | PLANNED | ~5 source files, ~3 test files                    |

---

## 8. Dependencies

```
Phase 1 (DONE):
  RuntimeExecutor trace events  -->  FillerMessageService
  WebSocket handler             -->  ServerMessages.statusUpdate/Clear

Phase 2 (PLANNED):
  KoreVG / Twilio / LiveKit     -->  VoiceFillerAdapter
  DSL Parser / Compiler         -->  ChannelSettingsIR
  ProjectSettings               -->  Config resolution

Phase 3 (PLANNED):
  Web SDK ChatClient            -->  statusUpdate/statusClear events
  React AgentProvider           -->  statusText state
  ChatWidget                    -->  Status text rendering
```
