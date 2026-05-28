# Observability and Tracing

> Consolidated reference for the ABL platform's real-time tracing, engine decision visibility, diagnostic patterns, and observability UI.

## Table of Contents

1. [Overview and Principles](#1-overview-and-principles)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Complete Trace Event Type System](#3-complete-trace-event-type-system)
4. [Server-Side Tracing](#4-server-side-tracing)
5. [Engine Decision Tracing](#5-engine-decision-tracing)
6. [Decision Trace Points](#6-decision-trace-points)
7. [Verbosity Control](#7-verbosity-control)
8. [WebSocket Message Flow](#8-websocket-message-flow)
9. [Client-Side Stores](#9-client-side-stores)
10. [UI Components](#10-ui-components)
11. [Arch Diagnostic Patterns](#11-arch-diagnostic-patterns)
12. [Implementation Status](#12-implementation-status)
13. [File Reference](#13-file-reference)

---

## 1. Overview and Principles

The ABL platform uses a **layered event-driven architecture** for tracing and debugging with real-time WebSocket communication:

```
[Server Runtime] --> [Trace Emitter] --> [WebSocket] --> [Client Stores] --> [UI Components]
```

**Core Principles:**

- **Real-time streaming.** Events are sent immediately as they occur during agent execution. There is no batching or delayed flush -- every LLM call, tool execution, decision, and state transition is visible to the developer the moment it happens.

- **Hierarchical spans.** Parent-child relationships are tracked via a span stack on the trace emitter. Agent entry creates a span; agent exit closes it. Flow steps nest within agent spans. This produces a tree structure suitable for span-tree and timeline rendering.

- **Type-safe events.** All 33 event types are declared in a TypeScript union (`TraceEventType` in `apps/runtime/src/types/index.ts`, mirrored as `ExtendedTraceEventType` in `apps/studio/src/types/index.ts`). Downstream consumers -- Studio EventTimeline, trace-store filters, MCP analysis tools -- use exhaustive handling.

- **Decision visibility.** The engine's internal decisions (completion checks, auto-advance, extraction strategy selection, memory trigger evaluation, constraint backtracking) emit trace events with the same fidelity as external actions (LLM calls, tool invocations). The goal: make the engine's _why_ as visible as its _what_.

- **Multi-layer visualization.** Events are consumed by three independent UI layers: the state machine graph (execution highlighting), the span tree (hierarchical nesting), and the event timeline (chronological detail with filtering and search).

**Cross-references:**

- For persistent trace storage (ClickHouse tiered storage), see [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md), Section 5
- For multi-tenant observability roadmap, see [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md)

---

## 2. Architecture Diagram

```
+-----------------------------------------------------------------------------+
|                           SERVER (apps/runtime)                              |
+-----------------------------------------------------------------------------+
|                                                                              |
|  +------------------+    +------------------+    +------------------+        |
|  | Runtime Executor  |--->|  Trace Emitter   |--->|    WebSocket     |        |
|  |                   |    |                  |    |    Handler       |        |
|  | - Flow execution  |    | - Span management|    |                  |        |
|  | - Tool calls      |    | - Event emission |    | - Message routing|        |
|  | - LLM calls       |    | - Session binding|    | - Reconnection   |        |
|  | - Decisions       |    | - Callsite ctx   |    | - Auth           |        |
|  +------------------+    +------------------+    +--------+---------+        |
|                                                           |                  |
+---------------------------------------------------------------------------+--+
                                                            |
                                   WebSocket (ws://localhost:3002/ws)
                                                            |
+---------------------------------------------------------------------------+--+
|                           CLIENT (apps/studio)            |                   |
+---------------------------------------------------------------------------+--+
|                                                           v                   |
|  +---------------------------------------------------------------+           |
|  |                     WebSocket Context                          |           |
|  |  - Connection management    - Message parsing                  |           |
|  |  - Auto-reconnection        - Store dispatching                |           |
|  +---------------------------------------------------------------+           |
|                    |                      |                                    |
|                    v                      v                                    |
|  +-------------------------+  +-------------------------------+               |
|  |     Trace Store         |  |     Observatory Store          |               |
|  |                         |  |                                |               |
|  | - Event filtering       |  | - Span hierarchy               |               |
|  | - Search                |  | - Flow graph                   |               |
|  | - Type selection        |  | - Execution state              |               |
|  +-------------------------+  +-------------------------------+               |
|                    |                      |                                    |
|                    +----------+-----------+                                    |
|                               v                                               |
|  +---------------------------------------------------------------+           |
|  |                      UI Components                             |           |
|  |                                                                |           |
|  |  +-----------------+  +--------------+  +------------------+   |           |
|  |  | StateMachineView|  | EventTimeline|  |    SpanTree      |   |           |
|  |  |                 |  |              |  |                  |   |           |
|  |  | - Graph viz     |  | - Chrono view|  | - Hierarchy      |   |           |
|  |  | - Execution     |  | - Icons/color|  | - Details        |   |           |
|  |  |   highlighting  |  | - Summaries  |  | - Status         |   |           |
|  |  | - Pan/Zoom      |  | - Filtering  |  |                  |   |           |
|  |  +-----------------+  +--------------+  +------------------+   |           |
|  +---------------------------------------------------------------+           |
|                                                                               |
+-------------------------------------------------------------------------------+
```

---

## 3. Complete Trace Event Type System

All 33 trace event types in the platform, organized by category. This is the single authoritative table -- both the runtime union (`TraceEventType`) and studio union (`ExtendedTraceEventType`) must include every type listed here.

### Core Execution Events

| #   | Event Type         | Emitted By         | Data Fields                                                         | Purpose                                 |
| --- | ------------------ | ------------------ | ------------------------------------------------------------------- | --------------------------------------- |
| 1   | `llm_call`         | `executeWithTools` | model, tokens, latency, messages, response, rawRequest, rawResponse | LLM API call with full request/response |
| 2   | `tool_call`        | `executeToolCall`  | name, input, output, success, latency                               | Tool invocation and result              |
| 3   | `decision`         | Various            | decision, alternatives, reason                                      | General routing/logic decision          |
| 4   | `constraint_check` | `checkConstraints` | constraintType, passed, context                                     | Constraint evaluation (pass/fail)       |
| 5   | `handoff`          | `handleHandoff`    | fromAgent, toAgent, context, returnExpected                         | Agent-to-agent transfer                 |
| 6   | `escalation`       | `handleEscalate`   | reason, priority, context                                           | Transfer to human agent                 |
| 7   | `error`            | Various            | message, stack, context                                             | Runtime errors                          |

### Session Lifecycle Events

| #   | Event Type      | Emitted By         | Data Fields          | Purpose                |
| --- | --------------- | ------------------ | -------------------- | ---------------------- |
| 8   | `session_start` | Session creation   | sessionId, agentName | Session initialization |
| 9   | `session_end`   | Session completion | sessionId, reason    | Session termination    |

### Agent Lifecycle Events

| #   | Event Type    | Emitted By          | Data Fields                   | Purpose                          |
| --- | ------------- | ------------------- | ----------------------------- | -------------------------------- |
| 10  | `agent_enter` | `handleSendMessage` | agentName, spanId             | Agent activation (creates span)  |
| 11  | `agent_exit`  | `handleSendMessage` | agentName, spanId, durationMs | Agent deactivation (closes span) |

### Flow Events (Scripted Mode)

| #   | Event Type        | Emitted By        | Data Fields                 | Purpose                 |
| --- | ----------------- | ----------------- | --------------------------- | ----------------------- |
| 12  | `flow_step_enter` | `executeFlowStep` | stepName, agentName         | Step activation         |
| 13  | `flow_step_exit`  | `executeFlowStep` | stepName, result            | Step completion         |
| 14  | `flow_transition` | `executeFlowStep` | fromStep, toStep, condition | Step-to-step transition |

### Extraction Events

| #   | Event Type          | Emitted By               | Data Fields            | Purpose                       |
| --- | ------------------- | ------------------------ | ---------------------- | ----------------------------- |
| 15  | `entity_extraction` | `extractEntitiesWithLLM` | fields, values, method | LLM + regex entity extraction |

### Delegation Events

| #   | Event Type          | Emitted By       | Data Fields         | Purpose                    |
| --- | ------------------- | ---------------- | ------------------- | -------------------------- |
| 16  | `delegate_start`    | `handleDelegate` | targetAgent, input  | Sub-agent invocation start |
| 17  | `delegate_complete` | `handleDelegate` | targetAgent, result | Sub-agent invocation end   |

### DSL Construct Events

| #   | Event Type     | Emitted By        | Data Fields        | Purpose                         |
| --- | -------------- | ----------------- | ------------------ | ------------------------------- |
| 18  | `dsl_collect`  | `executeFlowStep` | fields, values     | GATHER/COLLECT field extraction |
| 19  | `dsl_prompt`   | `executeFlowStep` | promptText         | PROMPT display                  |
| 20  | `dsl_respond`  | `executeFlowStep` | responseText       | RESPOND execution               |
| 21  | `dsl_set`      | `executeFlowStep` | key, value         | SET state modification          |
| 22  | `dsl_on_input` | `executeFlowStep` | condition, matched | ON_INPUT evaluation             |
| 23  | `dsl_call`     | `executeFlowStep` | target, args       | CALL execution                  |

### Engine Decision Events (added in engine decision tracing)

| #   | Event Type                | Emitted By                  | Data Fields                                                             | Purpose                                                        |
| --- | ------------------------- | --------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| 24  | `completion_check`        | `checkCompletionConditions` | condition, result, agent, currentStep, **source**, **nextStep**         | COMPLETE condition evaluation with callsite context            |
| 25  | `engine_decision`         | Auto-advance logic          | decision, reason, currentStep, nextStep, chainDepth                     | Engine routing decisions (skip_completion_check, auto_advance) |
| 26  | `handoff_condition_check` | Handoff evaluator           | target, condition, matched                                              | Handoff routing condition evaluation                           |
| 27  | `thread_return`           | Thread management           | childAgent, parentAgent                                                 | Child-to-parent control flow return                            |
| 35  | `return_to_parent`        | `handleReturnToParent`      | from, to, reason, forwardedMessage                                      | Child agent returns control to parent supervisor               |
| 36  | `thread_resume`           | `handleHandoff`             | agentName, threadIndex, from, preservedHistoryLength, preservedDataKeys | Waiting thread reactivated instead of creating new thread      |
| 28  | `data_stored`             | Context persistence         | key, value                                                              | Context variable persistence                                   |
| 29  | `digression`              | Intent detection            | intent, action                                                          | Intent digression detection                                    |
| 30  | `sub_intent`              | Intent detection            | intent                                                                  | Sub-intent detection                                           |
| 31  | `correction`              | Correction detector         | field, oldValue, newValue, **detectionMethod**, **fieldMatchReason**    | Value correction (enriched with detection metadata)            |
| 32  | `constraint_violation`    | Constraint evaluator        | constraintType, name, details                                           | Constraint failure                                             |
| 33  | `warning`                 | Various                     | message, context                                                        | Non-fatal warnings                                             |
| 34  | `user_message`            | Message reception           | text, sessionId                                                         | Incoming user message                                          |

### EventTimeline Rendering Configuration

Every event type has rendering configuration in `apps/studio/src/components/observatory/EventTimeline.tsx` via `getEventConfig()` and `getEventSummary()`.

**Rendering for the 11 engine decision types:**

| Event Type                | Icon           | Color   | Summary Format                               |
| ------------------------- | -------------- | ------- | -------------------------------------------- |
| `completion_check`        | AlertTriangle  | orange  | `[source] "condition" -> COMPLETE / not met` |
| `engine_decision`         | Cpu            | gray    | `decision: reason`                           |
| `handoff_condition_check` | GitBranch      | amber   | `target: "condition" -> matched / not met`   |
| `thread_return`           | ArrowRightLeft | purple  | `childAgent -> parentAgent`                  |
| `constraint_violation`    | XCircle        | red     | `constraintType: name`                       |
| `user_message`            | MessageSquare  | blue    | `"message text..."`                          |
| `warning`                 | AlertTriangle  | yellow  | `warning message`                            |
| `digression`              | GitBranch      | pink    | `intent: name (action)`                      |
| `sub_intent`              | GitBranch      | pink    | `intent: name`                               |
| `correction`              | Variable       | teal    | `field: oldValue -> newValue`                |
| `data_stored`             | Variable       | emerald | `key: name`                                  |

All icons are from `lucide-react`. Unknown event types fall through to a default gray rendering with raw JSON.

---

## 4. Server-Side Tracing

### 4.1 Trace Emitter

**Location:** `apps/runtime/src/services/trace-emitter.ts`

The trace emitter is a factory function that creates a session-bound emitter instance. Each session gets its own emitter with a dedicated span stack.

```typescript
interface TraceEmitterOptions {
  sessionId: string;
  ws: WebSocket;
}

function createTraceEmitter(options: TraceEmitterOptions): TraceEmitter;
```

**Event Categories:**

| Category     | Methods                                                                                                     | Purpose                   |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Core Events  | `logLLMCall`, `logToolCall`, `logDecision`, `logConstraintCheck`, `logHandoff`, `logEscalation`, `logError` | Basic execution tracing   |
| Flow Events  | `logFlowStepEnter`, `logFlowStepExit`, `logFlowTransition`                                                  | Track flow-mode execution |
| Agent Events | `logAgentEnter`, `logAgentExit`                                                                             | Track agent lifecycle     |
| Delegation   | `logDelegateStart`, `logDelegateComplete`                                                                   | Agent-to-agent delegation |
| Custom       | `logCustom`, `emit`                                                                                         | Extensible event emission |

### 4.2 Span Management

The trace emitter maintains a span stack for hierarchical tracing:

```typescript
// Internal state
let currentSpanId: string | undefined;
let spanStack: string[] = [];

// logAgentEnter creates new span, pushes to stack
// logAgentExit pops from stack
// Parent span ID automatically tracked
```

Spans create the tree structure visible in the SpanTree UI component. Every event emitted while a span is active inherits that span's ID as its `spanId`, and the parent span's ID as its `parentSpanId`.

### 4.3 Event Structure

Each event includes:

| Field          | Type                      | Description                                  |
| -------------- | ------------------------- | -------------------------------------------- |
| `type`         | `TraceEventType`          | Event type identifier from the 33-type union |
| `timestamp`    | `string` (ISO)            | When the event occurred                      |
| `durationMs`   | `number?`                 | Optional elapsed time                        |
| `data`         | `Record<string, unknown>` | Event-specific payload                       |
| `agentName`    | `string`                  | Source agent                                 |
| `spanId`       | `string`                  | Current span identifier                      |
| `parentSpanId` | `string?`                 | Parent span for hierarchy                    |

### 4.4 Trace Store (Server-Side)

**Location:** `apps/runtime/src/services/trace-store.ts`

```
getTraceStore().addEvent(sessionId, traceEvent)
  |-- Store in ring buffer (max 500 events per session)
  |-- Forward to OTEL trace bridge (OpenTelemetry) if configured
  +-- Broadcast to all subscribed WebSocket clients
```

The server-side trace store is in-memory with a fixed ring buffer. For persistent storage, see [DATA_ARCHITECTURE.md](./DATA_ARCHITECTURE.md), Section 5.1 (traces table) and Section 6 (tiered storage architecture with hot/warm/cold tiers).

---

## 5. Engine Decision Tracing

### 5.1 Background

Debugging the Welcome_Agent premature-completion bug revealed three systemic failures in the observability stack:

1. **Type gap.** The runtime emitted trace events using string literals (e.g., `'completion_check'`), but the `TraceEventType` union only listed 22 of the 33+ event types actually emitted. Missing types fell through to generic gray rendering in Studio.

2. **Studio rendering gap.** `EventTimeline.tsx` used a `switch(event.type)` with cases only for known types. Unknown types rendered as anonymous gray boxes with raw JSON -- the information was present in the trace but invisible to developers.

3. **Analysis gap.** The `analyzeTraces()` function had no concept of flow path analysis. It could not compare expected vs. actual step execution, detect skipped steps, or identify premature completion.

### 5.2 Completion Check with Callsite Context

The `checkCompletionConditions()` function is called from four locations in the runtime executor. Previously, all four emitted an identical `completion_check` event with no indication of _where_ the check fired. Now each callsite provides descriptive context:

```typescript
private checkCompletionConditions(
  session: RuntimeSession,
  onChunk?: (chunk: string) => void,
  onTraceEvent?: (...) => void,
  callContext?: { source: string; currentStep?: string; nextStep?: string }
): ExecutionResult | null
```

**Four callsites and their sources:**

| Callsite                | `source` Value           | When It Fires                             |
| ----------------------- | ------------------------ | ----------------------------------------- |
| Explicit COMPLETE step  | `explicit_complete_step` | Flow reaches a step named COMPLETE        |
| Loop-back pre-advance   | `loop_back_pre_advance`  | About to revisit an already-executed step |
| Terminal step (no THEN) | `terminal_step`          | Step has no transition defined            |
| Post-turn eval          | `post_turn_eval`         | After each reasoning turn                 |

The emitted trace event now includes:

```typescript
onTraceEvent({
  type: 'completion_check',
  data: {
    condition: condition.when,
    result: isComplete,
    agent: session.agentName,
    currentStep: session.currentFlowStep,
    source: callContext?.source || 'unknown',
    nextStep: callContext?.nextStep,
  },
});
```

### 5.3 Engine Decision Events

Two new `engine_decision` events capture the auto-advance logic:

**When skipping a completion check** (forward-progressing flow):

```typescript
{ type: 'engine_decision', data: {
  decision: 'skip_completion_check',
  reason: 'forward_progressing_transition',
  currentStep, nextStep, agent
}}
```

**Before auto-advancing to the next step:**

```typescript
{ type: 'engine_decision', data: {
  decision: 'auto_advance',
  fromStep, toStep, agent, chainDepth
}}
```

### 5.4 Handoff Condition Check Events

```typescript
{ type: 'handoff_condition_check', data: {
  target: 'target_agent_name',
  condition: 'the condition expression',
  matched: true | false
}}
```

### 5.5 Flow Path Analysis

The `analyzeTraces()` function in `apps/runtime/src/routes/sessions.ts` now computes a `flowPath` object:

```typescript
flowPath: {
  expectedSteps: ['check_availability', 'greeting', 'collect_info', 'process'],
  visitedSteps: ['check_availability'],
  skippedSteps: ['greeting', 'collect_info', 'process'],
  completionSource: 'loop_back_pre_advance',
  completedAtStep: 'check_availability',
}
```

When premature completion is detected, the analysis generates:

- **Issue**: `"Premature completion -- completed at step 'check_availability' but steps [greeting, collect_info, process] never executed."`
- **Suggestion**: `"Review COMPLETE condition -- if it contains 'OR true' or checks early-set variables, it may fire before later steps execute."`

### 5.6 Before and After

**Before** (2+ hours to diagnose):

```
Developer: "Welcome_Agent completes without greeting"
  -> Open Studio EventTimeline
  -> See: flow_step_enter (check_availability), then session_end
  -> No explanation of why
  -> Read runtime-executor.ts (5000 lines)
  -> Add console.logs to find which callsite fired
  -> Discover loop_back_pre_advance callsite
```

**After** (30 seconds):

```
Developer: "Welcome_Agent completes without greeting"
  -> Open Studio EventTimeline
  -> See: flow_step_enter (check_availability)
  -> See: completion_check (orange) -- [loop_back_pre_advance] "x IS SET OR true" -> COMPLETE
  -> Root cause visible immediately
  OR: Use kore_analyze_session
  -> See: flowPath.skippedSteps = ['greeting', 'collect_info']
  -> See: issue "Premature completion -- completed at 'check_availability'"
```

---

## 6. Decision Trace Points

Eighteen decision points in the runtime emit trace events that answer: **what was decided, what alternatives existed, and why this path was chosen.** These are organized by category.

### Category: Extraction and Strategy

| #   | Decision Point                                  | Proposed Trace Event           | Key Data Fields                                                       |
| --- | ----------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| 1   | Strategy resolution (field -> block -> default) | `extraction_strategy_resolved` | field, resolvedStrategy, source (`field` / `block` / `default`)       |
| 2   | Pattern extraction attempted/matched/failed     | `extraction_attempt`           | field, method: `pattern`, pattern, matched, value                     |
| 3   | LLM extraction JSON parse fallback to regex     | `extraction_parse_fallback`    | field, primaryFailed, regexMatched                                    |
| 4   | Hybrid fallback from LLM to pattern             | `extraction_fallback`          | field, from: `llm`, to: `pattern`, reason (`llm_error` / `no_result`) |

### Category: Memory

| #   | Decision Point                                      | Proposed Trace Event       | Key Data Fields                                              |
| --- | --------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| 5   | REMEMBER trigger evaluated (condition true/false)   | `memory_trigger_evaluated` | trigger, condition, result, reason                           |
| 6   | RECALL instruction fired (data found/not found)     | `memory_recall_result`     | event, factsFound, factsLoaded                               |
| 7   | FactStore unavailable (no-op path taken)            | `memory_unavailable`       | reason (`no_fact_store` / `no_user_id` / `no_memory_config`) |
| 8   | Preference detected (pattern, category, confidence) | `preference_detected`      | text, category, confidence, pattern                          |
| 9   | Memory error caught and swallowed                   | `memory_error`             | operation, error, continued: true                            |

### Category: Constraints and Control Flow

| #   | Decision Point                                        | Proposed Trace Event         | Key Data Fields                                            |
| --- | ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| 10  | Backtrack count incremented                           | `constraint_backtrack`       | step, count, limit, action (`goto` / `retry`)              |
| 11  | Backtrack limit reached -> escalation                 | `constraint_backtrack_limit` | step, count, fallbackAction: `escalate`                    |
| 12  | Constraint directive type (terminal vs. control flow) | `constraint_directive`       | constraint, action, type (`terminal` / `control_flow`)     |
| 13  | Mini-collect entered/exited                           | `constraint_mini_collect`    | fields, phase (`enter` / `exit`), result (`pass` / `fail`) |

### Category: Gather and Corrections

| #   | Decision Point                                                    | Proposed Trace Event        | Key Data Fields                                                                                       |
| --- | ----------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| 14  | Field activation mode -> field skipped/active                     | `gather_field_activation`   | field, activation, active, reason                                                                     |
| 15  | `complete_when` short-circuit (gather complete before all fields) | `gather_complete_reason`    | reason (`complete_when` / `all_fields` / `check_complete`), missingOptional                           |
| 16  | Correction field identification                                   | Enriched `correction` event | detectionMethod (`regex` / `llm`), fieldMatchReason (`type_match` / `last_string` / `llm_identified`) |
| 17  | Dependent field invalidation after correction                     | `correction_invalidation`   | field, dependents, cleared                                                                            |

### Category: Session and Config

| #   | Decision Point                                    | Proposed Trace Event   | Key Data Fields                        |
| --- | ------------------------------------------------- | ---------------------- | -------------------------------------- |
| 18  | LLM validation fail-open (error treated as valid) | `validation_fail_open` | field, rule, error, treatAsValid: true |

### TraceDecision Interface

All 18 decision points emit via the existing `onTraceEvent` callback using a shared structure:

```typescript
interface TraceDecision {
  type: 'decision';
  category: 'extraction' | 'memory' | 'constraint' | 'gather' | 'validation' | 'config';
  decision: string; // e.g. 'extraction_strategy_resolved'
  inputs: Record<string, unknown>; // what was evaluated
  result: string | boolean; // what was decided
  reason?: string; // human-readable explanation
  alternatives?: string[]; // what other paths existed
}
```

No new infrastructure is needed -- these events flow through the same trace emitter, WebSocket, and store pipeline as all other events.

---

## 7. Verbosity Control

Not all decision traces should be emitted in production. The `traceVerbosity` setting controls emission granularity per session:

| Level               | What Is Emitted                                                      | Use Case              |
| ------------------- | -------------------------------------------------------------------- | --------------------- |
| `minimal` (default) | Errors, escalations, completion events only                          | Production            |
| `standard`          | Above + step transitions, tool calls, constraint checks              | Staging / QA          |
| `verbose`           | Above + all 18 decision traces from Section 6                        | Development debugging |
| `debug`             | Above + LLM prompts/responses, extraction details, memory operations | Deep investigation    |

Set via session creation options or agent IR config:

```yaml
AGENT: My_Agent
DEBUG:
  trace_verbosity: verbose
```

When set at the session level, it overrides the agent IR default for that session only.

---

## 8. WebSocket Message Flow

### 8.1 Message Types

| Type             | Direction        | Content             | Purpose                                         |
| ---------------- | ---------------- | ------------------- | ----------------------------------------------- |
| `trace_event`    | Server -> Client | `TraceEventWithId`  | Real-time trace events                          |
| `response_chunk` | Server -> Client | String chunk        | Streaming LLM responses                         |
| `response_start` | Server -> Client | Message ID          | Start of streaming                              |
| `response_end`   | Server -> Client | Full text           | End of streaming                                |
| `agent_loaded`   | Server -> Client | Agent IR + metadata | Agent initialization                            |
| `state_update`   | Server -> Client | `AgentState`        | State changes (gather progress, context)        |
| `action_taken`   | Server -> Client | `ConstructAction`   | Actions (handoff, delegate, complete, escalate) |
| `session_reset`  | Server -> Client | Session ID          | Clear traces                                    |
| `load_agent`     | Client -> Server | Agent path          | Load request                                    |
| `send_message`   | Client -> Server | Text + session      | User message                                    |

### 8.2 Message Sequence (Per User Message)

```
Client receives (in order):
  1. { type: 'responseStart',  sessionId, messageId }
  2. { type: 'responseChunk',  sessionId, messageId, chunk }   <-- may repeat
  3. { type: 'traceEvent',     sessionId, event }               <-- interleaved
  4. { type: 'responseEnd',    sessionId, messageId, response }
  5. { type: 'stateUpdate',    sessionId, state }
  6. { type: 'actionTaken',    sessionId, action }
```

### 8.3 Handler Integration

**Location:** `apps/runtime/src/websocket/handler.ts`

```typescript
const result = await executor.executeMessage(
  runtimeSession.id,
  text,
  // Stream chunks callback
  (chunk) => send(ws, ServerMessages.responseChunk(...)),
  // Trace events callback
  (event) => {
    send(ws, ServerMessages.traceEvent(...));
    getTraceStore().addEvent(sessionId, traceEvent);
  }
);
```

The handler dispatches the executor result, then sends `responseEnd`, `stateUpdate`, and `actionTaken` sequentially.

---

## 9. Client-Side Stores

### 9.1 WebSocket Context

**Location:** `apps/studio/src/contexts/WebSocketContext.tsx`

Responsibilities:

- WebSocket connection management
- Automatic reconnection (5 attempts, 3-second intervals)
- Message parsing and store dispatching
- High-level actions: `loadAgent()`, `sendMessage()`, `resetSession()`

On receiving a `trace_event` message, the context:

1. Parses the `ServerMessage` JSON
2. Converts timestamps to Date objects
3. Dispatches to both stores in parallel

### 9.2 Trace Store

**Location:** `apps/studio/src/store/trace-store.ts`

**State:**

- `events`: Array of all trace events
- `selectedTypes`: Filter by event type (all 33+ types appear in the filter panel via `ALL_TYPES`)
- `searchQuery`: Full-text search across event data
- `expandedEventIds`: UI expansion state
- `selectedEventId`: Current selection

**Capabilities:**

- Filter by any combination of the 33 event types
- Full-text search across event data
- Bulk expand/collapse

### 9.3 Observatory Store

**Location:** `apps/studio/src/store/observatory-store.ts`

This is the most sophisticated store with auto-processing logic.

**State:**

```typescript
interface ObservatoryState {
  spans: Map<string, Span>; // Hierarchical trace structure
  events: ExtendedTraceEvent[]; // Extended events with hierarchy
  activeSpanStack: string[]; // Currently active spans
  staticGraph: StaticGraph | null; // Single-agent state machine
  appStaticGraph: AppStaticGraph | null; // Multi-agent visualization
  executionState: Map<string, NodeExecutionState>; // Node states
}
```

**Auto-Processing:** When an event is added, the store automatically:

1. Creates flow nodes for new agents
2. Creates spans for `agent_enter` events
3. Updates span hierarchy on `agent_exit`
4. Tracks flow transitions between steps
5. Updates execution state for state machine visualization

---

## 10. UI Components

### 10.1 StateMachineView

**Location:** `apps/studio/src/components/observatory/StateMachineView.tsx`

**Layout:** Uses Dagre.js for hierarchical graph layout. Top-to-bottom flow with configurable spacing and custom node positioning via drag-and-drop.

**Node Types:**

| Type         | Shape             | Color     |
| ------------ | ----------------- | --------- |
| Entry        | Circle            | Green     |
| Exit         | Circle            | Red       |
| Step         | Rounded Rectangle | Blue/Gray |
| Decision     | Diamond           | Amber     |
| LLM Decision | Diamond           | Purple    |

**Execution States:**

| State     | Visual                  |
| --------- | ----------------------- |
| Unvisited | Gray, no icon           |
| Active    | Blue, pulsing animation |
| Visited   | Green, checkmark icon   |

**Edge Types:**

| Type        | Style        | Color  |
| ----------- | ------------ | ------ |
| Sequential  | Solid        | Gray   |
| Conditional | Dashed       | Blue   |
| Success     | Solid        | Green  |
| Failure     | Dashed       | Red    |
| Error       | Dotted       | Red    |
| Digression  | Dashed       | Orange |
| Taken       | Solid + Glow | Cyan   |

**Interactive Features:** Pan (drag canvas), zoom (mouse wheel, 0.25x-2x), fit to screen, reset view, minimap (fullscreen mode), node dragging.

### 10.2 EventTimeline

**Location:** `apps/studio/src/components/observatory/EventTimeline.tsx`

Chronological event display with:

- Icon and color coding per event type (see Section 3 rendering table)
- Human-readable summary lines via `getEventSummary()`
- Expandable detail view with full event data
- Type filtering and text search integration with trace store

### 10.3 DebugTabs

**Location:** `apps/studio/src/components/observatory/DebugTabs.tsx`

Four-tab debug panel:

| Tab     | Content                                                  |
| ------- | -------------------------------------------------------- |
| Context | Phase, collected data, context vars, constraints, memory |
| History | Conversation messages with roles and timestamps          |
| IR      | Full intermediate representation JSON                    |
| Logs    | System logs with level filtering (info/warn/error)       |

### 10.4 SpanTree

**Location:** `apps/studio/src/components/observatory/SpanTree.tsx`

Hierarchical span visualization:

- Parent-child relationships via indentation
- Status indicators (running / completed / error)
- Duration and event count per span
- Click to select and view span details

### 10.5 Additional Observatory Components

| Component                 | Location                                  | Purpose                                              |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `SessionTimeline.tsx`     | `apps/studio/src/components/observatory/` | LLM latency, tool times, token usage, volley metrics |
| `GatherProgressPanel.tsx` | `apps/studio/src/components/observatory/` | Synced gather field progress                         |
| `ConstraintMonitor.tsx`   | `apps/studio/src/components/observatory/` | Constraint evaluation status                         |
| `LLMCallCard.tsx`         | `apps/studio/src/components/observatory/` | Detailed LLM call inspection                         |
| `ToolCallViewer.tsx`      | `apps/studio/src/components/observatory/` | Tool call input/output inspection                    |
| `AgentFlowGraph.tsx`      | `apps/studio/src/components/observatory/` | Multi-agent flow visualization                       |

---

## 11. Arch Diagnostic Patterns

Arch (the AI assistant) uses pattern recognition on trace data to proactively detect and explain common issues. Each pattern has a trace signature, a diagnosis explanation, and a fix recommendation.

### Pattern 1: Memory Silent No-Op

**Trace signature:** No `memory_trigger_evaluated` events despite agent having MEMORY config.

**Diagnosis:** "Your agent has REMEMBER triggers configured, but the memory system is not active. This usually means no FactStore is configured for this session. Memory requires a persistent store (MongoDB) -- in local development, preferences will not persist across sessions."

**Fix:** "Configure a FactStore in your deployment, or use `InMemoryFactStore` for testing."

### Pattern 2: Backtrack Loop Leading to Unexpected Escalation

**Trace signature:** 3x `constraint_backtrack` events for the same step, followed by `escalation`.

**Diagnosis:** "Your constraint on step '{step}' triggered a GOTO/RETRY loop that hit the maximum backtrack limit (3). After 3 attempts, the runtime escalated instead of continuing the loop."

**Fix:** "Consider restructuring your flow so the correction path uses different steps, or handle the case where the constraint cannot be satisfied after multiple attempts."

### Pattern 3: Wrong Field Corrected

**Trace signature:** `correction` event where `field` does not match what the user likely intended.

**Diagnosis:** "The correction detector matched '{newValue}' to field '{field}' using the '{detectionMethod}' method. This was a heuristic match -- the system matched the value type to the last collected field of that type. If this is wrong, consider using more specific correction phrases like 'change {fieldName} to {value}'."

### Pattern 4: Extraction Strategy Mismatch

**Trace signature:** `extraction_strategy_resolved` with `source: 'default'` + extraction failure.

**Diagnosis:** "Field '{field}' used the default 'hybrid' extraction strategy because no explicit strategy was set. For structured data like emails, phone numbers, or dates, consider using `STRATEGY: pattern` for faster, more reliable extraction."

### Pattern 5: Gather Stall (Fields Never Activate)

**Trace signature:** Repeated `gather_field_activation` with `active: false` for the same field across multiple turns.

**Diagnosis:** "Field '{field}' has `activation: progressive` with `DEPENDS_ON: [{deps}]`, but those dependency fields have not been collected yet. The field will not be prompted until all dependencies are satisfied."

### Pattern 6: ON_INPUT Silent Drop

**Trace signature:** User message received but no `flow_transition` or `on_input_match` event.

**Diagnosis:** "The user's message '{message}' did not match any ON_INPUT condition, and there is no ELSE branch. The agent re-prompted without acknowledging the input. Add an ELSE branch to handle unexpected responses."

### Pattern 7: LLM Validation Silently Disabled

**Trace signature:** `validation_fail_open` events.

**Diagnosis:** "LLM validation for field '{field}' failed (error: {error}), so the value was accepted without validation. This is by design (fail-open), but means the value '{value}' may not meet your validation rule '{rule}'. If this validation is critical, consider using a deterministic validation type (pattern, range, enum)."

### Pattern 8: Preference Not Persisted

**Trace signature:** `preference_detected` event but no subsequent `memory_trigger_evaluated` with matching field.

**Diagnosis:** "A preference was detected ('{category}: {text}') but there is no REMEMBER trigger configured for this field. Add a REMEMBER rule to persist detected preferences."

### Arch Diagnostic API

The structured interface for Arch to query trace data and receive matched patterns:

```typescript
interface ArchDiagnosticRequest {
  sessionId: string;
  question?: string; // "Why didn't my memory persist?"
  autoDetect?: boolean; // run all pattern detectors
}

interface ArchDiagnosticResult {
  patterns: Array<{
    pattern: string; // 'memory_silent_noop'
    confidence: number; // 0.0-1.0
    explanation: string; // human-readable
    evidence: TraceEvent[]; // supporting trace events
    fix: string; // actionable recommendation
    specReference?: string; // link to relevant doc section
  }>;
}
```

Arch calls this after the developer describes their issue. The result includes matched patterns with explanations that Arch presents conversationally. The 8 patterns above are the initial set; additional patterns can be added by implementing the same signature/evidence/fix structure.

---

## 12. Implementation Status

### Complete

| Feature                                  | Notes                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real-time trace capture                  | Events sent immediately via WebSocket                                                                                                                                    |
| Span hierarchy                           | Parent-child via stack management                                                                                                                                        |
| State machine visualization              | Dagre.js + custom rendering                                                                                                                                              |
| Execution highlighting                   | Active/visited states with animation                                                                                                                                     |
| WebSocket reconnection                   | 5 attempts, 3-second intervals                                                                                                                                           |
| Type-safe events (33 types)              | All types in TypeScript union                                                                                                                                            |
| Debug tabs                               | Context, History, IR, Logs                                                                                                                                               |
| Static graph extraction                  | From agent IR flow definitions                                                                                                                                           |
| Flow transitions                         | Tracked and visualized                                                                                                                                                   |
| Span tree                                | Hierarchical view with status                                                                                                                                            |
| Constraint check events                  | With relevant context and evaluation results                                                                                                                             |
| Entity extraction events                 | LLM + regex extraction                                                                                                                                                   |
| App-level visualization                  | Multi-agent swimlanes via AppStaticGraph                                                                                                                                 |
| Session timeline metrics                 | LLM latency, tool times, token usage, volley metrics                                                                                                                     |
| GatherProgress panel                     | Synced with collected data                                                                                                                                               |
| MCP debug integration                    | 15 tools for Claude Code (58 tests)                                                                                                                                      |
| Engine decision tracing (Phase 1-5)      | Type system, callsite context, flow path analysis, Studio rendering, MCP tools. All verified: 1188 tests pass, zero type errors across runtime, studio, and CLI packages |
| Completion check callsite context        | 4 callsites (`explicit_complete_step`, `loop_back_pre_advance`, `terminal_step`, `post_turn_eval`)                                                                       |
| Engine decision events                   | `skip_completion_check` and `auto_advance` events                                                                                                                        |
| EventTimeline rendering for 11 new types | Icon, color, summary format for all engine decision types                                                                                                                |
| Flow path analysis                       | Expected vs. visited steps, skipped step detection, premature completion detection                                                                                       |
| MCP tool enhancement                     | `kore_get_traces`, `kore_analyze_session`, `kore_debug_session` updated with flow path data                                                                              |

### Partially Working

| Feature                              | Notes                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| DSL construct events                 | Types defined, partially wired (not all constructs emit events)                       |
| Guardrail events                     | Types defined, not wired (guardrails not yet executed at runtime)                     |
| 18 decision trace points (Section 6) | Interface designed, partial implementation. Extraction and memory traces need wiring. |
| Verbosity control                    | Design complete, not yet wired into session creation                                  |
| Arch diagnostic patterns             | 8 patterns designed, API interface defined, not yet integrated with Arch              |

### Not Implemented

| Feature                 | Notes                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Breakpoints             | Types and store exist, no execution capability. Requires pause/resume in runtime executor.                                        |
| Distributed tracing     | No correlation IDs across agents/sessions. Planned: see [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md). |
| Trace persistence       | In-memory only, lost on restart. Planned: MongoDB hot (7-day TTL) + ClickHouse cold (90-day analytics).                           |
| Trace export            | No download capability (JSON, CSV, OpenTelemetry format).                                                                         |
| Trace playback          | No replay functionality. No step forward/backward through events.                                                                 |
| Bidirectional debugging | No pause/resume or step-over/step-into from the UI.                                                                               |
| Cross-session views     | Single session only. Planned: workspace-scoped dashboards, session comparison.                                                    |
| Multi-tenant isolation  | No WebSocket auth scoping. Planned: JWT auth on connect, workspace-level broadcast channels.                                      |
| Performance profiling   | No flame graph, no slow-step identification, no duration breakdown visualization.                                                 |

### Future Architecture: Multi-Tenant Observability

The tracing architecture is planned to evolve to support multi-tenant, distributed observability:

- **Persistent storage**: MongoDB (hot, 7-day TTL) + ClickHouse (cold, 90-day analytics)
- **Tenant isolation**: All traces tagged with `accountId` + `workspaceId`, enforced at middleware
- **Cross-session views**: Workspace-scoped dashboards, session comparison, aggregate analytics
- **Platform ops**: Cross-tenant health monitoring, usage metering
- **WebSocket scoping**: JWT auth on connect, workspace-level broadcast channels

See [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md) for the full implementation plan.

---

## 13. File Reference

### Server-Side (Runtime)

| File                                            | Purpose                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/trace-emitter.ts`    | Trace emission factory, span management, event categories                               |
| `apps/runtime/src/services/trace-store.ts`      | Server-side ring buffer, OTEL bridge, WebSocket broadcast                               |
| `apps/runtime/src/services/runtime-executor.ts` | Agent execution with tracing, completion check callsite context, engine_decision events |
| `apps/runtime/src/websocket/handler.ts`         | WebSocket message handling, executor dispatch, trace forwarding                         |
| `apps/runtime/src/websocket/events.ts`          | Message type definitions (ServerMessages, ClientMessages)                               |
| `apps/runtime/src/routes/sessions.ts`           | Session routes, `analyzeTraces()` with flow path analysis                               |
| `apps/runtime/src/types/index.ts`               | Source-of-truth `TraceEventType` union (33 types)                                       |

### Client-Side (Studio)

| File                                            | Purpose                                                      |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `apps/studio/src/contexts/WebSocketContext.tsx` | Client WebSocket management, reconnection, store dispatch    |
| `apps/studio/src/store/trace-store.ts`          | Trace event storage, filtering, search, `ALL_TYPES` array    |
| `apps/studio/src/store/observatory-store.ts`    | Span hierarchy, flow graph, execution state, auto-processing |
| `apps/studio/src/types/index.ts`                | Studio mirror `ExtendedTraceEventType` union                 |

### UI Components

| File                                                             | Purpose                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/studio/src/components/observatory/StateMachineView.tsx`    | State machine graph with execution highlighting           |
| `apps/studio/src/components/observatory/EventTimeline.tsx`       | Chronological event display with icons, colors, summaries |
| `apps/studio/src/components/observatory/DebugTabs.tsx`           | Debug panel (Context, History, IR, Logs)                  |
| `apps/studio/src/components/observatory/SpanTree.tsx`            | Hierarchical span view                                    |
| `apps/studio/src/components/observatory/SessionTimeline.tsx`     | Session-level metrics visualization                       |
| `apps/studio/src/components/observatory/GatherProgressPanel.tsx` | Gather field progress tracking                            |
| `apps/studio/src/components/observatory/ConstraintMonitor.tsx`   | Constraint evaluation status                              |
| `apps/studio/src/components/observatory/LLMCallCard.tsx`         | Detailed LLM call inspection                              |
| `apps/studio/src/components/observatory/ToolCallViewer.tsx`      | Tool call input/output inspection                         |
| `apps/studio/src/components/observatory/AgentFlowGraph.tsx`      | Multi-agent flow visualization                            |
| `apps/studio/src/components/observatory/event-colors.ts`         | Event type color definitions                              |

### MCP Debug Tools

| File                                               | Purpose                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/mcp-debug/src/tools/flow.ts`             | MCP flow graph and analysis tools                                         |
| `packages/kore-platform-cli/src/mcp/server.ts`     | MCP server with kore_get_traces, kore_analyze_session, kore_debug_session |
| `packages/kore-platform-cli/src/mcp/docs/index.ts` | Embedded documentation for engine decision and debugging patterns         |

### Shared Types

| File                                         | Purpose                                           |
| -------------------------------------------- | ------------------------------------------------- |
| `packages/compiler/src/platform/ir/types.ts` | AgentIR, FlowConfig, CompletionConfig definitions |
| `packages/compiler/src/types/trace.ts`       | Shared TraceEvent interface (if exists)           |

---

_Consolidated from: TRACING_DEBUGGING_ARCHITECTURE.md, ENGINE_DECISION_TRACING.md, runtime-explainability-design.md (W1 + W3), RUNTIME_FLOW_TRACE.md (trace event table)._

_Last updated: 2026-03-02_
