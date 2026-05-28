# Session Observability Gaps — Design & Implementation Plan

**Date**: 2026-03-26
**Status**: DONE (implemented + tested 2026-03-26)
**Scope**: 8 audit items across runtime + studio (3 HIGH, 2 MED, 3 LOW)
**Audit**: lld-reviewer pass 1 — 2 CRITICAL, 3 HIGH addressed below

## Problem Statement

Sessions viewed in Studio show incomplete data due to two independent persistence pipelines diverging:

1. **Trace events** (ClickHouse) — reliable, immediate, always succeed
2. **Session messages** (BullMQ → MongoDB) — 7 silent failure points, zero logging

Additionally, `agent_enter`/`agent_exit` lifecycle events are only emitted from the WebSocket handler, leaving 11+ other channel handlers (SDK, REST, VXML, AudioCodes, Genesys, etc.) without span data in the waterfall.

## Design Decisions

| #   | Decision                              | Choice                                                                        | Rationale                                                                                                                                                       |
| --- | ------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Lifecycle dedup strategy              | Single emitter in `executeMessage()`                                          | Removes 7 per-handler call sites. Channel metadata via `ExecuteMessageOptions.channelMetadata`.                                                                 |
| D2  | Message persistence when MongoDB down | Always enqueue to BullMQ (Redis-backed)                                       | BullMQ retry handles transient MongoDB outages. Circuit breaker prevents retry storms.                                                                          |
| D3  | Agent response synthesis from traces  | Use `llm_call.data.response` (2000 char) + `dsl_respond.data.rendered` (full) | Best available data. Truncation preferable to no message at all.                                                                                                |
| D4  | Span synthesis strategy               | Always synthesize, merge/dedup with real events                               | Handles partial lifecycle persistence (e.g., 2 of 5 turns have real events).                                                                                    |
| D5  | Circuit breaker implementation        | Reuse Redis-backed `@agent-platform/circuit-breaker`                          | BullMQ worker already requires Redis. If Redis is down, BullMQ itself is non-functional — in-memory fallback adds no value. Use existing battle-tested package. |

## Audit Findings Addressed

### Round 1

| #   | Severity | Finding                                                                                 | Resolution                                                                                       |
| --- | -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1  | CRITICAL | Incomplete channel coverage — VXML, AudioCodes, Genesys, pipeline call sites not listed | Added all `executeMessage()` call sites to Item 1, including pipeline inline type fix            |
| A2  | CRITICAL | `SessionMessage` type needs `synthetic?: boolean` field                                 | Added to Item 3 plan — extend interface in `studio/src/types/index.ts`                           |
| A3  | HIGH     | In-memory circuit breaker diverges from platform pattern                                | Changed to reuse `@agent-platform/circuit-breaker` (Redis-backed). BullMQ requires Redis anyway. |
| A4  | HIGH     | TraceForwarder `logAgentEnter`/`logAgentExit` ambiguity                                 | Added explicit note: construct-layer calls in `trace-forwarder.ts` are INTERNAL — do NOT touch   |
| A5  | HIGH     | No E2E tests — SDLC requires minimum 5                                                  | Added E2E test section with 6 scenarios                                                          |

### Round 2

| #   | Severity | Finding                                                                                                    | Resolution                                                                                                 |
| --- | -------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| B1  | CRITICAL | Circuit breaker API mismatch — config field names wrong, `getBreaker` doesn't exist                        | Fixed to use real API: `registry.app(tenantId, appId)` → `BreakerHandle.execute()`. Corrected field names. |
| B2  | HIGH     | ExecutionCoordinator drops channelMetadata — constructs `{ attachmentIds, signal }` only                   | Added to Item 1: extend `SubmitOptions` + coordinator's `runExecution()` to pass `channelMetadata` through |
| B3  | HIGH     | A2A server.ts call sites missing (server.ts:545, :548-564)                                                 | Added to call site table. Non-streaming path has no `onTraceEvent` — accepted limitation.                  |
| B4  | MEDIUM   | 4 channel handlers don't pass `onTraceEvent` (VXML, AudioCodes, Twilio, SDK inbound)                       | Documented as accepted limitation. Future work: add onTraceEvent to these handlers.                        |
| B5  | MEDIUM   | `enqueueLLMRequest` in handler.ts:2177 doesn't pass `execOptions` — channelMetadata lost on LLM queue path | Added to Item 1: pass `execOptions` as 7th arg to `enqueueLLMRequest()`                                    |
| B6  | LOW      | Call site count inconsistency                                                                              | Fixed count in table                                                                                       |

## Items

### Item 1 [HIGH]: Remove duplicate lifecycle emissions, centralize in executeMessage()

**Root cause**: `handler.ts` emits `logAgentEnter`/`logAgentExit`/`logUserMessage` via `traceEmitter`, AND `executeMessage()` now emits centralized `agent_enter`/`agent_exit` via `onTraceEvent`. WS sessions get double events. All other channels (SDK, REST, VXML, AudioCodes, Genesys, pipeline, Twilio) get zero lifecycle events.

**All `executeMessage()` call sites** (14 production call sites):

| #   | File                                    | Line    | Channel                 | `onTraceEvent`?                                           | Action                                                   |
| --- | --------------------------------------- | ------- | ----------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `websocket/handler.ts`                  | 2180    | `web_debug`             | Yes                                                       | Add channelMetadata, remove traceEmitter lifecycle calls |
| 2   | `websocket/handler.ts`                  | 2177    | `web_debug` (LLM queue) | Yes (via enqueueLLMRequest)                               | Pass execOptions with channelMetadata as 7th arg         |
| 3   | `websocket/handler.ts`                  | 3649    | `web_debug` (ON_START)  | No                                                        | Add onTraceEvent + channelMetadata                       |
| 4   | `websocket/sdk-handler.ts`              | 2257    | `sdk`                   | Yes                                                       | Add channelMetadata to execOptions                       |
| 5   | `websocket/sdk-handler.ts`              | 2530    | `sdk` (ON_START)        | No                                                        | Add onTraceEvent + channelMetadata                       |
| 6   | `websocket/sdk-handler.ts`              | 3465    | `sdk` (inbound)         | No (but centralized handler wraps undefined)              | Add `{ channelMetadata }` as 5th arg                     |
| 7   | `websocket/twilio-media-handler.ts`     | 578     | `twilio_voice`          | No (explicit undefined, but centralized handler wraps it) | Add `{ channelMetadata }` as 5th arg                     |
| 8   | `routes/chat.ts`                        | 1483    | `api`                   | Yes (via coordinator)                                     | Add channelMetadata to coordinator submit                |
| 9   | `routes/channel-vxml.ts`                | 158     | `vxml`                  | No (but centralized handler wraps undefined)              | Add `{ channelMetadata }` as 5th arg                     |
| 10  | `routes/channel-audiocodes.ts`          | 263     | `audiocodes`            | No (but centralized handler wraps undefined)              | Add `{ channelMetadata }` as 5th arg                     |
| 11  | `routes/channel-genesys.ts`             | 143     | `genesys`               | Yes                                                       | Add channelMetadata                                      |
| 12  | `channels/pipeline/message-pipeline.ts` | 84      | `pipeline`              | Yes                                                       | Fix inline type, add channelMetadata                     |
| 13  | `server.ts`                             | 545     | `a2a` (non-streaming)   | No (but centralized handler wraps undefined)              | Add `undefined, undefined, { channelMetadata }` args     |
| 14  | `server.ts`                             | 548-564 | `a2a` (streaming)       | Yes (via coordinator)                                     | Add channelMetadata to coordinator submit                |

**Key insight**: `createCentralizedTraceHandler()` (line 1846 in `runtime-executor.ts`) **always returns a real function** even when the caller passes `undefined` for `onTraceEvent`. After wrapping, `onTraceEvent` is always defined inside `executeMessage()`. Lifecycle events fire for ALL channels and persist to TraceStore + ClickHouse automatically. Callers that don't pass `onTraceEvent` only miss the _forwarding_ to their own callback — the centralized storage still happens. Therefore, every call site just needs `{ channelMetadata }` in options for channel identification.

**Plan**:

1. Add `channelMetadata` to `ExecuteMessageOptions` (`execution/types.ts:454`):

   ```typescript
   export interface ExecuteMessageOptions {
     attachmentIds?: string[];
     signal?: AbortSignal;
     actionEvent?: { actionId: string; value?: string };
     /** Channel-specific metadata emitted with centralized agent lifecycle events */
     channelMetadata?: {
       channel: string; // 'web_debug' | 'sdk' | 'api' | 'vxml' | etc.
       contentLength?: number;
       hasAttachments?: boolean;
       attachmentCount?: number;
     };
   }
   ```

2. Fix **pipeline inline type** at `channels/pipeline/types.ts:105`:

   ```typescript
   // Change from:
   execOptions?: { attachmentIds?: string[] };
   // To:
   execOptions?: ExecuteMessageOptions;
   ```

   Import `ExecuteMessageOptions` from `../../services/execution/types.js`.

3. In `executeMessage()`, merge `channelMetadata` into the `agent_enter` and `user_message` event data:

   ```typescript
   // user_message — centralized, covers both flow + reasoning mode
   if (onTraceEvent) {
     onTraceEvent({
       type: 'user_message',
       data: {
         message: userMessage,
         sessionId,
         agent: session.agentName,
         ...options?.channelMetadata,
       },
     });
   }
   // agent_enter — immediately after
   onTraceEvent({
     type: 'agent_enter',
     data: {
       agentName: executingAgentName,
       mode: ...,
       trigger: ...,
       ...options?.channelMetadata,
     },
   });
   ```

4. **Remove the duplicate `user_message` emission in reasoning path** (currently at line ~2414 inside the reasoning-only section). It's now emitted centrally before the flow/reasoning branch.

5. Remove from `handler.ts` (main execution path only):
   - `traceEmitter.logUserMessage()` at line 2104
   - `traceEmitter.logAgentEnter()` at line 2124
   - `traceEmitter.logAgentExit()` at lines 2429, 2439, 2469

6. **Keep** the `handler.ts` **fallback path** (line 2496) — this runs when no runtime is configured and does NOT go through `executeMessage()`. These calls remain:
   - `traceEmitter.logAgentEnter()` at line 2496
   - `traceEmitter.logAgentExit()` at line 2541

7. **Extend `SubmitOptions`** in `execution-coordinator.ts:31` to include `channelMetadata`:

   ```typescript
   export interface SubmitOptions {
     // ... existing fields ...
     channelMetadata?: ExecuteMessageOptions['channelMetadata'];
   }
   ```

   Then in `runExecution()` (line ~538), pass it through:

   ```typescript
   const result = await this.executor.executeMessage(
     sessionId,
     execution.message,
     options.onChunk,
     options.onTraceEvent,
     {
       attachmentIds: options.attachmentIds,
       signal: abortController.signal,
       channelMetadata: options.channelMetadata,
     },
   );
   ```

8. **Fix `enqueueLLMRequest` call** in handler.ts:2177 — pass `execOptions` as 7th argument so channelMetadata reaches the LLM queue worker:

   ```typescript
   result = await enqueueLLMRequest(
     session.id, text, onChunk, onTraceEvent, session.tenantId,
     { channelMetadata: { channel: 'web_debug', contentLength: text.length, ... } },
   );
   ```

9. Pass `channelMetadata` from each call site with `onTraceEvent`. Example for handler.ts:

   ```typescript
   const result = await executor.executeMessage(sessionId, text, onChunk, onTraceEvent, {
     ...existingOptions,
     channelMetadata: {
       channel: 'web_debug',
       contentLength: text.length,
       hasAttachments: !!attachmentIds?.length,
       attachmentCount: attachmentIds?.length || 0,
     },
   });
   ```

10. **DO NOT TOUCH** `trace-forwarder.ts` `logAgentEnter`/`logAgentExit` — these are construct-layer internal calls used by the compiler bridge. They emit events with `source: 'construct-layer'` for sub-agent lifecycle within a single execution turn. They are NOT the same as the handler-level lifecycle events being centralized here.

**Files**: `execution/types.ts`, `execution-coordinator.ts`, `runtime-executor.ts`, `handler.ts`, `sdk-handler.ts`, `chat.ts`, `channel-genesys.ts`, `channels/pipeline/message-pipeline.ts`, `channels/pipeline/types.ts`, `server.ts`

---

### Item 2 [HIGH]: Always enqueue messages to BullMQ with circuit breaker

**Root cause**: `persistMessage()` entry point silently returns when `isDatabaseAvailable()` is false. Messages never reach BullMQ. Additionally, `isDatabaseAvailable()` is a one-shot init flag — it never detects runtime MongoDB failures.

**Plan**:

1. **Remove the `isDatabaseAvailable()` guard from `persistMessage()` entry point** (line 605). BullMQ is Redis-backed and independent of MongoDB. Messages should always be enqueued to the Redis-backed BullMQ queue regardless of MongoDB state.

2. **Add a circuit breaker around MongoDB write operations in the worker** using the existing `@agent-platform/circuit-breaker` package (Redis-backed). The BullMQ worker already requires Redis to function — if Redis is down, BullMQ itself is non-functional, so the "works without Redis" argument for an in-memory breaker is moot.

   Configuration — use `registry.app()` API with `'system'` tenant (message persistence is cross-tenant):

   ```typescript
   import { CircuitBreakerRegistry } from '@agent-platform/circuit-breaker';

   // Initialize once during module setup (alongside BullMQ init)
   const registry = new CircuitBreakerRegistry(redis, {
     defaults: {
       app: {
         failureThreshold: 5, // open after 5 failures
         successThreshold: 2, // close after 2 successes in half-open
         resetTimeout: 30_000, // ms, OPEN → HALF_OPEN wait
         monitorWindow: 30_000, // ms, rolling window
         halfOpenMaxConcurrent: 1, // 1 probe at a time
         failureRateThreshold: 50, // percentage (not ratio)
         minimumRequestCount: 3, // min requests before rate matters
       },
     },
   });
   const mongoPersistBreaker = registry.app('system', 'message-persistence-mongo');
   ```

3. **Worker job handler** wraps MongoDB operations with the circuit breaker:

   ```typescript
   async function workerJobHandler(job) {
     const batch = decryptBatchFromQueue(job.data);
     await mongoPersistBreaker.execute(async () => {
       // existing MongoDB write logic
       await writeBatchToMongoDB(batch);
     });
     // CircuitOpenError propagates → BullMQ retries with backoff
   }
   ```

4. **Keep `isDatabaseAvailable()` only for non-essential guards** where skipping is acceptable (e.g., session metrics, analytics). Remove it from message persistence path.

5. **Increase BullMQ retry config** for message persistence:

   ```typescript
   attempts: 5,                        // was 3
   backoff: { type: 'exponential', delay: 2000 },  // was 1000ms
   ```

   With exponential backoff: 2s, 4s, 8s, 16s, 32s — covers ~1 minute of MongoDB downtime.

6. **Graceful degradation when Redis is also down**: If both Redis and MongoDB are down, BullMQ itself cannot enqueue. The `persistMessage()` entry point should catch the BullMQ enqueue error and log it (instead of crashing). Messages are lost in this scenario, but this is an accepted failure mode — both backing stores are unavailable.

**Files**: `message-persistence-queue.ts`

---

### Item 3 [MED]: Synthesize agent responses from trace events

**Root cause**: `useSessionDetail.ts` only backfills `user` messages from `user_message` traces. Agent responses that failed to persist to MongoDB are not recovered.

**Available trace data for responses**:

- `llm_call.data.response` — truncated to 2000 chars (reasoning mode, `reasoning-executor.ts:1194`)
- `dsl_respond.data.rendered` — full text (scripted/flow mode, `flow-step-executor.ts:4622`)
- `agent_response` — only has `contentLength` (no text)

**Plan**:

1. **Extend `SessionMessage` interface** (`studio/src/types/index.ts:37`) with optional metadata:

   ```typescript
   export interface SessionMessage {
     // ... existing fields ...
     metadata?: {
       // ... existing metadata fields ...
       /** True when this message was reconstructed from trace events (not persisted to MongoDB) */
       synthetic?: boolean;
       /** True when the response text was truncated from traces (llm_call 2000 char limit) */
       truncated?: boolean;
     };
   }
   ```

2. Extend `augmentedMessages` to also synthesize `assistant` messages:

   ```typescript
   const agentResponseEvents = effectiveTraceEvents.filter((e) => {
     const t = normalizeEventType(e.type);
     return t === 'llm_call' || t === 'dsl_respond';
   });
   ```

3. For `llm_call` events, extract `data.response` (up to 2000 chars). For `dsl_respond`, extract `data.rendered` (full text).

4. Dedup against existing assistant messages using **timestamp proximity** (within 5s window) AND content prefix matching (first 100 chars), not just exact content match. This avoids false dedup on repeated short messages.

5. Synthetic messages get `metadata.synthetic: true` for UI differentiation.

6. For truncated responses (from `llm_call`), set `metadata.truncated: true` when `data.response.length === 2000`.

7. Apply the same dedup fix (Item 6) to user messages simultaneously.

**Files**: `studio/src/types/index.ts`, `useSessionDetail.ts`

---

### Item 4 [MED]: Log swallowed catch in agent_exit finally block

**Root cause**: Empty `catch {}` in the `finally` block violates "no swallowed catches" rule.

**Plan**: Add `log.warn`:

```typescript
} catch (err) {
  log.warn('agent_exit trace emission failed', {
    sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

**Files**: `runtime-executor.ts`

---

### Item 5 [MED]: Always synthesize spans, merge/dedup with real events

**Root cause**: `hasAgentLifecycle` is all-or-nothing. If 2 of 5 turns have real `agent_enter`/`agent_exit`, synthesis is skipped and those 3 turns get no spans.

**Plan**:

1. Replace the boolean `hasAgentLifecycle` check with per-turn analysis:

   ```typescript
   // Build map of turns that have real lifecycle events
   const turnsWithLifecycle = new Set<number>();
   // ... scan events, identify turns by user_message boundaries,
   // mark turns that have real agent_enter/agent_exit
   ```

2. Always run `synthesizeTurnSpans()`, but have it:
   - Skip synthesis for turns that already have real `agent_enter`/`agent_exit`
   - Only inject synthetic lifecycle events for turns missing them
   - Preserve real events' spanIds (don't overwrite with synthetic ones)

3. Dedup logic: if a synthetic `agent_enter` would be created for a turn that already has a real one within the same timestamp window (5s), skip the synthetic.

4. Fix timestamp collision: offset synthetic `agent_enter` by -1ms and `agent_exit` by +1ms relative to their anchor events, ensuring clean waterfall ordering.

**Files**: `replay-trace-events.ts`

---

### Item 6 [LOW]: Fix content-based dedup false positives

**Root cause**: If user sends "yes" twice, second message is deduped as false duplicate.

**Plan**: Use **timestamp proximity + content** for dedup:

```typescript
// Instead of just content matching:
const isDuplicate = baseMessages.some(
  (m) =>
    m.content?.trim().toLowerCase() === content.trim().toLowerCase() &&
    Math.abs(new Date(m.timestamp).getTime() - evtTimestamp) < 5000, // within 5s
);
```

Messages with identical content but >5s apart are treated as distinct.

**Named constants** (no magic numbers):

```typescript
const DEDUP_WINDOW_MS = 5_000;
const LLM_RESPONSE_TRUNCATION_LIMIT = 2_000;
```

**Files**: `useSessionDetail.ts`

---

### Item 7 [LOW]: Circuit breaker prevents retry storms (covered by Item 2)

Merged with Item 2. The in-memory circuit breaker in the worker prevents all queued jobs from hitting MongoDB simultaneously when it recovers.

---

### Item 8 [LOW]: Fix unsafe agentName casting in synthesizeTurnSpans

**Root cause**: `(event as unknown as Record<string, unknown>).agentName` is brittle.

**Plan**: Access via the event's standard fields:

```typescript
// TraceEvent likely has agentName as optional field
const agentName =
  (event as { agentName?: string }).agentName ||
  ((event.data as Record<string, unknown>)?.agentName as string) ||
  'unknown';
```

Or define a local helper:

```typescript
function getAgentName(event: TraceEvent): string {
  return (
    (event as unknown as { agentName?: string }).agentName ||
    ((event.data as Record<string, unknown>)?.agent as string) ||
    ((event.data as Record<string, unknown>)?.agentName as string) ||
    'unknown'
  );
}
```

**Files**: `replay-trace-events.ts`

---

## Implementation Order

| Phase | Items                                               | Risk | Files Changed                                                                                                                                                                                                                                              |
| ----- | --------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Item 1 (dedup lifecycle) + Item 4 (swallowed catch) | HIGH | `execution/types.ts`, `runtime-executor.ts`, `handler.ts`, `sdk-handler.ts`, `twilio-media-handler.ts`, `chat.ts`, `channel-vxml.ts`, `channel-audiocodes.ts`, `channel-genesys.ts`, `channels/pipeline/message-pipeline.ts`, `channels/pipeline/types.ts` |
| 2     | Item 2 (message persistence + circuit breaker)      | HIGH | `message-persistence-queue.ts`                                                                                                                                                                                                                             |
| 3     | Items 3 + 6 (response synthesis + dedup fix)        | MED  | `studio/src/types/index.ts`, `useSessionDetail.ts`                                                                                                                                                                                                         |
| 4     | Items 5 + 8 (span synthesis + casting fix)          | MED  | `replay-trace-events.ts`                                                                                                                                                                                                                                   |

Each phase is independently committable and testable.

**Dependency note**: Phase 1 touches 10 files across runtime. Split into sub-commits:

- 1a: `execution/types.ts` + `execution-coordinator.ts` + `runtime-executor.ts` (channelMetadata type, coordinator passthrough, centralized user_message + agent_enter/exit)
- 1b: `handler.ts` (remove 5 lifecycle calls, add channelMetadata to executeMessage + enqueueLLMRequest calls)
- 1c: All other channel handlers with `onTraceEvent` (sdk-handler, chat.ts, channel-genesys, server.ts — add channelMetadata)
- 1d: `channels/pipeline/types.ts` + `message-pipeline.ts` (fix inline type to use ExecuteMessageOptions)

---

## Test Cases

### Phase 1: Centralized lifecycle dedup

**Unit tests** (`runtime-executor.test.ts` or new `agent-lifecycle.test.ts`):

| #     | Test                                                                                                                                  | Assertion                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T1.1  | `executeMessage()` with `onTraceEvent` emits exactly one `agent_enter` and one `agent_exit`                                           | Count events by type in callback                                          |
| T1.2  | `agent_enter` includes `channelMetadata` fields when passed via options                                                               | Verify `data.channel`, `data.contentLength` in emitted event              |
| T1.3  | `agent_exit` reflects correct `lifecycleResult` for each exit path: `completed`, `handoff`, `delegate`, `error`, `constraint_blocked` | Mock session + execution to trigger each path                             |
| T1.4  | `agent_exit.durationMs` is >0 and approximately correct                                                                               | Assert `durationMs >= 0` and `< 5000` (test execution is fast)            |
| T1.5  | Early exits (completed session, escalated, empty input) do NOT emit `agent_enter`/`agent_exit`                                        | Verify zero lifecycle events for these paths                              |
| T1.6  | Recursive calls (handoff) emit separate `agent_enter`/`agent_exit` pairs with `trigger: 'handoff'`                                    | Set up handoff scenario, verify 2 pairs                                   |
| T1.7  | `agent_exit` still fires when execution throws an error                                                                               | Throw from reasoning executor, verify `agent_exit` with `result: 'error'` |
| T1.8  | WS handler no longer emits `traceEmitter.logAgentEnter()` or `logAgentExit()` on the main path                                        | Mock traceEmitter, verify zero lifecycle calls                            |
| T1.9  | WS handler fallback path (no runtime) still emits its own lifecycle events                                                            | Verify fallback still works independently                                 |
| T1.10 | `user_message` trace event is emitted for both flow mode and reasoning mode                                                           | Test both paths, verify `user_message` in each                            |

### Phase 2: Message persistence circuit breaker

**Unit tests** (`message-persistence-queue.test.ts`):

| #    | Test                                                                                  | Assertion                                                  |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| T2.1 | `persistMessage()` enqueues to BullMQ even when `isDatabaseAvailable()` returns false | Spy on queue.add, verify it's called                       |
| T2.2 | Worker circuit breaker opens after 5 consecutive MongoDB write failures               | Simulate 5 failures, verify state transitions to `open`    |
| T2.3 | Open circuit breaker causes immediate throw (no MongoDB call)                         | Verify no DB call attempted when breaker is open           |
| T2.4 | Circuit breaker transitions to `half_open` after `resetTimeoutMs`                     | Advance timers, verify state change                        |
| T2.5 | Successful write in `half_open` resets breaker to `closed`                            | Simulate success after half-open, verify closed            |
| T2.6 | Failed write in `half_open` reopens breaker                                           | Simulate failure, verify open                              |
| T2.7 | BullMQ retries failed jobs with exponential backoff (5 attempts)                      | Verify job config has `attempts: 5`, `backoff.delay: 2000` |
| T2.8 | Messages are not permanently lost during 30s MongoDB outage                           | Simulate outage, verify all messages eventually persist    |

### Phase 3: Agent response synthesis + dedup

**Unit tests** (`useSessionDetail.test.ts` or inline):

| #    | Test                                                                                  | Assertion                                                                                |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| T3.1 | Missing assistant message is synthesized from `llm_call.data.response`                | Provide traces with llm_call but no matching message, verify synthetic assistant appears |
| T3.2 | Missing assistant message is synthesized from `dsl_respond.data.rendered` (flow mode) | Same as above with dsl_respond event                                                     |
| T3.3 | Truncated response (2000 chars) from `llm_call` is marked as truncated                | Verify indicator when response length === 2000                                           |
| T3.4 | Existing assistant message is NOT duplicated when matching trace exists               | Provide both real message and trace, verify single message                               |
| T3.5 | Identical content messages >5s apart are treated as distinct                          | Two "yes" messages 10s apart, both appear                                                |
| T3.6 | Identical content messages <5s apart are deduped                                      | Two "yes" messages 2s apart, only one appears                                            |
| T3.7 | Synthetic messages are sorted chronologically with real messages                      | Mixed timestamps, verify correct ordering                                                |
| T3.8 | Synthetic messages have `synthetic: true` flag                                        | Verify flag on synthesized messages                                                      |

### Phase 4: Span synthesis merge/dedup

**Unit tests** (`replay-trace-events.test.ts`):

| #    | Test                                                                     | Assertion                                            |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| T4.1 | No lifecycle events → all turns get synthetic `agent_enter`/`agent_exit` | 3 turns, 0 real lifecycle, verify 3 synthetic pairs  |
| T4.2 | All turns have real lifecycle → no synthetic events injected             | 3 turns, 3 real pairs, verify 0 synthetic            |
| T4.3 | Partial lifecycle (2/5 turns real) → only missing turns get synthetic    | 5 turns, 2 real pairs, verify 3 synthetic pairs      |
| T4.4 | Synthetic `agent_enter` is -1ms before user_message timestamp            | Verify timestamp offset                              |
| T4.5 | Synthetic `agent_exit` is +1ms after last event in turn                  | Verify timestamp offset                              |
| T4.6 | Real events keep their original spanIds (not overwritten)                | Verify spanId preserved on real events               |
| T4.7 | `agentName` extracted safely via helper (no unsafe casting)              | Pass events with/without agentName, verify no errors |
| T4.8 | Single-turn session gets one span                                        | 1 user_message + events, verify 1 span pair          |

### E2E Tests (required per SDLC — minimum 5 scenarios)

E2E tests start real servers and interact only via HTTP API. No mocks, no direct DB access.

| #     | Test                                                               | Setup                                                                                        | Assertion                                                                                                |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| E2E-1 | REST chat session produces `agent_enter` + `agent_exit` in traces  | POST `/api/projects/:id/chat` with a message, GET session traces                             | Traces contain exactly 1 `agent_enter` and 1 `agent_exit` with matching agentName                        |
| E2E-2 | REST chat session trace contains `channelMetadata.channel = 'api'` | POST message via REST API, GET session traces                                                | `agent_enter` event data includes `channel: 'api'`                                                       |
| E2E-3 | Multi-turn session produces correct lifecycle count                | POST 3 messages to same session via REST API, GET `/sessions/:id/traces`                     | Exactly 3 `agent_enter` + 3 `agent_exit` events, each with incrementing timestamps and correct agentName |
| E2E-4 | Circuit breaker state resets after MongoDB recovery                | Trigger 5 failed persistence jobs (mock MongoDB unavailable), then restore, POST new message | New message persists successfully; circuit breaker state is `closed`                                     |
| E2E-5 | Span waterfall shows per-turn spans for multi-turn session         | POST 3 messages to same session, GET traces                                                  | At least 3 `agent_enter`/`agent_exit` pairs in trace events                                              |
| E2E-6 | `agent_exit` result reflects constraint violation                  | POST message that triggers a guardrail block, GET traces                                     | `agent_exit` with `result: 'constraint_blocked'`                                                         |

### Integration Tests (minimum 5 scenarios)

Integration tests exercise real service boundaries with real middleware.

| #   | Test                                                                                          | Assertion                                                         |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| I-1 | `executeMessage()` emits lifecycle events through the centralized trace handler to TraceStore | TraceStore contains `agent_enter` + `agent_exit` after execution  |
| I-2 | Message persistence queue enqueues when `isDatabaseAvailable()` returns false                 | BullMQ job exists in queue after persistMessage call              |
| I-3 | Circuit breaker opens after repeated MongoDB failures and recovers on success                 | Breaker state transitions: closed → open → half_open → closed     |
| I-4 | All channel handlers pass `channelMetadata` with correct channel identifier                   | Intercept onTraceEvent callback, verify channel field per handler |
| I-5 | `user_message` trace event is emitted once (not duplicated) for WS handler path               | Count `user_message` events — exactly 1 per turn                  |
