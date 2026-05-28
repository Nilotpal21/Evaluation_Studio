# Observatory -- Low-Level Design

## Implementation Structure

### packages/observatory/src/schema/

**trace-events.ts** -- 737 lines

- 18 domain-specific TraceEventType sub-unions composing into unified `TraceEventType`
- `ALL_TRACE_EVENT_TYPES` runtime array (for iteration)
- `ExtendedTraceEvent` interface with OpenTelemetry-compatible fields (traceId, spanId, parentSpanId)
- Type-safe event data variants (LLMCallData, ToolCallData, DecisionData, etc.)
- Helper functions: `createTraceEvent`, `generateEventId`, `generateSpanId`, `generateTraceId`

**spans.ts** -- 430 lines

- `Span` interface: spanId, traceId, parentSpanId, name, timing, status, events, attributes
- `SpanBuilder` class: fluent API for span construction
- `SpanManager` class: in-memory span lifecycle (start, end, query, cleanup) with per-session active span stack
- `TraceTree` class: builds tree from flat spans, critical path analysis, `toAscii()` visualization
- `TraceContext` interface + `createTraceContext()` / `createChildContext()` for context propagation

### packages/observatory/src/protocol/

**types.ts** -- 511 lines

- `DebugSession` with states: running, paused, waiting, completed, error
- 4 breakpoint spec types: AgentBreakpoint, StepBreakpoint, EventBreakpoint, ConditionalBreakpoint
- `BreakpointContext` with call stack, state snapshot, trace event
- 15 debug commands (client -> server): connect, sessions, attach, detach, break, unbreak, breaks, pause, resume, step, state, trace, stack, explain, evaluate, follow
- 15 debug events (server -> client): connected, sessions, attached, detached, session_created, session_ended, breakpoint_hit, paused, resumed, trace, state, stack, breaks, explain, evaluate_result, error
- Protocol version: `1.0.0`
- Server capabilities: breakpoints, step, state, trace, stack, explain, evaluate, follow

**debug-server.ts** -- 722 lines

- `DebugServer` class: WebSocket server with client management
- Runtime integration points: `onSessionCreated`, `onSessionDestroyed`, `onTraceEvent`, `onStateUpdate`, `onAgentEnter`, `onAgentExit`, `onStepEnter`
- `checkBreakpoint()`: evaluates all breakpoints + step conditions
- `pauseExecution()`: blocks until resume via SessionManager
- Command handlers for all 15 commands
- Not implemented: `handleTrace` (trace history), `handleExplain` (LLM-based)

**session-manager.ts** -- 399 lines

- `InternalSession` extends `DebugSession` with pauseResolver, stepping state, callStack, stateSnapshot
- Flow control: `pause()` creates Promise that resolves on `resume()`
- Step execution: sets stepping flag, resumes, then re-pauses after one step
- Auto-resume: `setTimeout` of 5 minutes on pause
- Agent call stack: push/pop with current step tracking

**breakpoints.ts** -- 485 lines

- `BreakpointManager`: CRUD for breakpoints + `checkBreakpoints()` evaluation
- Safe expression evaluator: `tokenize()` -> `safeEvaluate()` (recursive-descent)
- Supported tokens: numbers, strings, booleans, null, undefined, identifiers, operators, parens, not
- Supported operators: ==, !=, >, <, >=, <=, &&, ||, !
- Identifier resolution: dotted property paths against state object

### apps/runtime/src/services/debug-integration.ts -- 431 lines

- `DebugRuntimeExecutor` class wrapping `RuntimeExecutor`
- Per-session `SessionDebugContext`: traceId, spanStack, agentStack
- `executeMessage()`: waits if paused, enters agent, wraps trace handler, checks breakpoints
- `enterAgent()` / `exitAgent()`: manages agent stack and emits agent_enter/exit events
- Event type mapping: internal types -> observatory TraceEventType

### apps/studio/src/store/observatory-store.ts

- Zustand store with canvas view modes (graph, chat, split, app)
- Debug tabs: overview, traces, data, conversation, performance, ir, voice, errors
- Manages spans, events, timeline events, constraint results, step metrics, agent flow graph

### Key Files

| File                                                   | LOC  | Purpose                                   |
| ------------------------------------------------------ | ---- | ----------------------------------------- |
| `packages/observatory/src/schema/trace-events.ts`      | 737  | Canonical trace event types               |
| `packages/observatory/src/schema/spans.ts`             | 430  | Span hierarchy + TraceTree                |
| `packages/observatory/src/protocol/types.ts`           | 511  | Debug protocol types                      |
| `packages/observatory/src/protocol/debug-server.ts`    | 722  | WebSocket debug server                    |
| `packages/observatory/src/protocol/session-manager.ts` | 399  | Session lifecycle + flow control          |
| `packages/observatory/src/protocol/breakpoints.ts`     | 485  | Breakpoint evaluation + expression parser |
| `apps/runtime/src/services/debug-integration.ts`       | 431  | Runtime debug executor wrapper            |
| `apps/studio/src/store/observatory-store.ts`           | ~200 | Zustand debug state                       |
| `apps/studio/src/components/observatory/SpanTree.tsx`  | ~400 | Span tree visualization                   |
| `apps/studio/src/components/observatory/DebugTabs.tsx` | ~200 | Debug panel tabs                          |

### Known Gaps

| ID    | Description                                                                     | Severity |
| ----- | ------------------------------------------------------------------------------- | -------- |
| GAP-1 | Trace history command not implemented                                           | Medium   |
| GAP-2 | Explain command not implemented (needs LLM)                                     | Low      |
| GAP-3 | In-memory Maps have no max size, TTL, or eviction (SpanManager, SessionManager) | Medium   |
| GAP-4 | console.log/console.error in DebugServer instead of createLogger                | Low      |
| GAP-5 | No auth in Studio WebSocket connection to debug server                          | Medium   |
| GAP-6 | Core debug protocol has zero test coverage                                      | High     |
