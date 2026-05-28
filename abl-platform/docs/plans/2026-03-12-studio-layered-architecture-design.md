# Studio Layered Architecture — Design Spec

**Date:** 2026-03-12
**Status:** Reviewed
**Scope:** Studio app restructuring for debuggability, testability, and AI-agent navigability

## Problem Statement

Studio's codebase has grown organically without consistent layer boundaries. Every major feature page (Observatory, Sessions, Connections, Agent Detail, Arch, Workflows, Model Config, Deployments, Search-AI) is a self-contained mess with:

1. **No clear separation of concerns with Runtime** — data comes from three paths (HTTP proxy to Runtime, direct MongoDB reads, WebSocket) and it's unclear which is the source of truth for any given piece of data.

2. **Monolithic hub files** — `WebSocketContext.tsx` (974 LOC) handles 16 message types inline, routing to 6 stores. `observatory-store.ts` has a 348-line `addEvent()` megafunction. `arch.service.ts` is 2,910 LOC mixing API calls, state transforms, and business logic.

3. **No visibility between pipeline layers** — when data is wrong in the UI, there's no way to tell whether the bug is in Runtime's emission, WebSocket transport, store processing, or component rendering. Debugging is "stare at the UI, guess which layer, read code."

4. **AI-agent hostility** — Claude Code cannot efficiently navigate the codebase because no single file owns a behavior, files are too large to hold in context, and data flow requires reading 3+ interleaved files to trace.

### Structural Audit (Key Numbers)

| Metric                                | Value                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zustand stores                        | 25 (6,799 LOC total)                                                                                                                                           |
| Stores with side effects mixed in     | 3 (pipeline-store, arch-store, arch-config-store) + WebSocketContext as side-effect hub                                                                        |
| WebSocketContext.tsx                  | 974 LOC, 16 top-level message types (with 5 trace_event sub-branches + log formatting), routes to 6 stores (session, trace, observatory, auth, ui, navigation) |
| observatory-store.ts addEvent()       | 348 LOC single function (lines 292–639)                                                                                                                        |
| arch.service.ts                       | 2,910 LOC                                                                                                                                                      |
| search-ai.ts                          | 2,016 LOC                                                                                                                                                      |
| ModelsPage.tsx                        | 2,064 LOC                                                                                                                                                      |
| Top 6 files combined                  | 10,000+ LOC                                                                                                                                                    |
| Files importing from WebSocketContext | 11 (+ others importing stores indirectly fed by the context)                                                                                                   |
| Catch blocks across Studio            | 202 across 92 files (inconsistent patterns)                                                                                                                    |
| Hooks with data fetching              | 40+ in `src/hooks/` (many contain inline fetch logic)                                                                                                          |
| Client-side API files (`src/api/`)    | 26 files, 6,512 LOC total (largest: search-ai.ts 2,016, crawl.ts 441, pipelines.ts 365)                                                                        |
| Server-side repo files                | 14 in `src/repos/` (audit, auth, compliance, credential, eval, mfa, org, project, sdk, service-node, session, workspace, config-variable)                      |

## Solution Architecture: Five Pillars

### Pillar 1: Message Bus

Replace the WebSocket god object with a layered transport:

```
WebSocketTransport (connect/disconnect/reconnect only, ~150 LOC)
       ↓ raw messages
MessageBus (typed dispatch, handler registration, no business logic)
       ↓ typed events
Feature Handlers (one per domain, registered on bus)
  ├── sessions.handlers.ts       → SessionStore (chat, streaming, state, errors)
  ├── observatory.handlers.ts    → ObservatoryStore (spans, flow, metrics)
  ├── test-context.handlers.ts   → TestContextStore (context injection, tool mocks)
  └── (future handlers as features are extracted)
```

**Design decisions:**

- `WebSocketTransport` owns connection lifecycle only — connect, disconnect, reconnect with backoff, heartbeat
- `MessageBus` is a typed event emitter — `bus.on('trace_event', handler)`, `bus.emit(type, payload)`
- Handlers register at module init, not at render time (no React coupling in the bus layer)
- Bus supports middleware for cross-cutting concerns (logging, tap points)

**Library evaluation — build vs adopt:**

| Option                         | Size    | Pros                                                                                                                     | Cons                                                   | Verdict                         |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------- |
| **Hand-rolled** (current plan) | ~80 LOC | Full control, exact types, zero deps                                                                                     | Maintenance, edge cases (error propagation, async)     | Default if needs are simple     |
| **emittery** (~1.3KB gzip)     | Tiny    | Async-first, `onAny()` for tap points, `listenerCount()`, TypeScript generics, maintained by sindresorhus, battle-tested | Needs a typed wrapper for `ServerMessageMap`           | **Recommended**                 |
| **nanoevents** (~0.1KB)        | Minimal | Smallest possible, synchronous                                                                                           | No middleware, no `onAny()` — tap points need wrapping | Viable if middleware not needed |
| **mitt** (~0.2KB)              | Minimal | Widely used, wildcard support                                                                                            | No async, no middleware chain                          | Not ideal for tap points        |
| **RxJS**                       | Large   | Powerful operators                                                                                                       | Overkill, heavy bundle, steep learning curve           | Avoid                           |

**Recommendation:** Use **emittery** as the MessageBus core. It provides `onAny()` (perfect for tap-point middleware without a custom middleware chain), proper async error handling, `listenerCount()` for debugging, and is well-maintained. Wrap it with a thin typed facade (`MessageBus<ServerMessageMap>`) that enforces our type map. If emittery proves too opinionated, fall back to hand-rolled — the facade ensures the swap is transparent to consumers.

### Pillar 2: Feature Modules

Every major feature gets a consistent file structure:

```
features/
  <feature>/
    <feature>.api.ts          ← ALL data access (REST + WS). Single file to read.
    <feature>.store.ts        ← Pure state, no side effects
    <feature>.types.ts        ← Shared types (what Runtime sends, what UI needs)
    <feature>.handlers.ts     ← WebSocket message handlers (if feature uses WS)
    <feature>.contract.ts     ← Zod schemas for Runtime ↔ Studio boundary
    components/
      <Feature>Page.tsx       ← Thin shell, delegates to sub-components
      <SubComponent>.tsx
      ...
```

**Rules:**

1. **`.api.ts` is the only file that talks to the outside world** — fetch, proxy calls, WS send. Components and stores never call APIs directly.
2. **`.store.ts` is pure state** — no async, no fetch, no side effects. Zustand store with only synchronous actions.
3. **`.contract.ts` defines the Runtime ↔ Studio boundary** — Zod schemas for every request/response shape. When Runtime changes a response shape, contract tests fail.
4. **`.handlers.ts` subscribes to the message bus** (if the feature uses WebSocket) — transforms WS messages into store mutations via the API layer.
5. **`.types.ts` is the shared vocabulary** — TypeScript types derived from contract schemas, used by store and components.
6. **Components are thin** — read from store, call api.ts functions. No inline data fetching, no inline data transformation.

**Source of truth documentation:** Each `<feature>.api.ts` has a header comment declaring where each piece of data comes from:

```typescript
/**
 * Sessions API Layer
 *
 * Data sources:
 *   Session list        → REST GET /api/projects/:id/sessions (Studio reads MongoDB directly)
 *   Session traces      → WS subscribe_session (Runtime pushes via MessageBus)
 *   Create session      → REST POST /api/runtime/sessions → proxy to Runtime
 *   Session metrics     → REST GET /api/projects/:id/sessions/:sid/metrics → proxy to Runtime
 */
```

### Pillar 3: Pipeline X-Ray (Tap Points + Diagnostics)

Instrument each layer boundary with optional capture:

```
Runtime emit → [tap] → WS transport → [tap] → handler → [tap] → store → [tap] → UI render
```

**Implementation:**

- Tap points are MessageBus middleware — zero overhead when disabled
- Enable via `localStorage.setItem('STUDIO_DEBUG_CAPTURE', 'true')` or URL param `?debug=capture`
- Each tap writes to an in-memory ring buffer (last 1000 events per layer). The buffer tracks `total_received` vs `retained` so the diagnosis report can distinguish "X events evicted by ring buffer (expected, increase buffer if needed)" from "Y events dropped by handler (unexpected bug)"
- `pnpm studio:diagnose <session-id>` dumps buffers to `/.observatory-debug/<session-id>/` as JSONL files and diffs adjacent layers
- **Zustand devtools middleware** — enable `devtools()` middleware on all feature stores during development. This provides time-travel debugging, state diff inspection, and action replay via Redux DevTools browser extension. Zero cost in production (tree-shaken when `process.env.NODE_ENV !== 'development'`).
- Diagnosis output is a structured JSON report:

```json
{
  "session_id": "abc123",
  "layers": {
    "runtime_emit": { "event_count": 47 },
    "ws_transport": { "event_count": 47, "diff_from_previous": "none" },
    "handler": {
      "event_count": 45,
      "diff_from_previous": "2 events dropped",
      "dropped": ["trace_event:constraint_check", "trace_event:constraint_check"]
    },
    "store": { "event_count": 45, "diff_from_previous": "none" },
    "ui_render": {
      "event_count": 43,
      "diff_from_previous": "2 events not rendered",
      "missing": ["span:gather_field_x", "span:gather_field_y"]
    }
  },
  "diagnosis": "Handler layer dropped 2 constraint_check events. Check observatory-handler.ts event type filtering.",
  "files_to_inspect": ["features/observatory/observatory.handlers.ts"]
}
```

**Data extraction:** The ring buffers live in the browser's JavaScript memory. To get data to the CLI:

- Option A: `?debug=capture` mode writes tap data to `localStorage` (limited to ~5MB), CLI reads via a tiny Next.js API route (`/api/debug/tap-data`)
- Option B: A "Download Diagnostics" button in the Studio UI exports the ring buffers as a JSON file to the user's filesystem, which the CLI then reads
- Option C: The CLI connects to the running Studio dev server via WebSocket and requests a buffer dump

Option B is simplest and most reliable. The CLI doesn't need to be a separate process — it can be a script that reads the downloaded JSON file and produces the diagnosis report.

**Diagnostic JSONL format:** Use an OTel-inspired schema for tap-point records (not full OpenTelemetry browser SDK — too heavy). Each line in the JSONL export is a self-contained record:

```jsonl
{"ts":"2026-03-12T10:00:00.123Z","layer":"ws_transport","type":"trace_event","subType":"llm_call","sessionId":"s1","seq":42,"data":{...}}
{"ts":"2026-03-12T10:00:00.125Z","layer":"handler","type":"trace_event","subType":"llm_call","sessionId":"s1","seq":42,"data":{...}}
{"ts":"2026-03-12T10:00:00.130Z","layer":"store","type":"trace_event","subType":"llm_call","sessionId":"s1","seq":42,"storeAction":"addEvent","data":{...}}
```

Fields: `ts` (ISO timestamp), `layer` (tap point name), `type`/`subType` (message type), `sessionId`, `seq` (monotonic counter for ordering), `storeAction` (which store method was called, store layer only), `data` (raw payload). The `seq` field enables cross-layer correlation: same `seq` → same event at different pipeline stages.

**Claude Code workflow:**

1. User reports bug → reproduces with capture enabled
2. User clicks "Download Diagnostics" or data is auto-exported to `/.observatory-debug/`
3. `pnpm studio:diagnose <session>` → reads the JSON report
4. Report tells Claude Code exactly which layer and which file to inspect
5. Claude Code reads the file, understands the issue, fixes it

### Pillar 4: Contract Tests Per Layer

**Current schema state:** Zod is already used in 85 files (333 `z.object` instances), but almost entirely in server-side API route handlers for request validation. Client-side code has near-zero Zod usage — only `arch.service.ts` (topology schemas) and 2 form components use Zod. Response types are TypeScript interfaces scattered across `src/api/*.ts` (30+ interfaces) and `src/types/` — all trust-based with no runtime validation.

The `apiFetch()` / `handleResponse<T>()` pattern in `src/lib/api-client.ts` returns `response.json()` cast to `T` without validation. Each feature's `.api.ts` should integrate Zod parsing:

```typescript
// features/observatory/observatory.api.ts
import { handleResponse } from '@/lib/api-client';
import { SessionDetailResponse } from './observatory.contract';

export async function fetchSessionDetail(id: string) {
  const res = await apiFetch(`/api/runtime/sessions/${id}`);
  const raw = await handleResponse(res);
  return SessionDetailResponse.parse(raw); // Zod validates at runtime
}
```

Each feature's `.contract.ts` Zod schemas become the foundation for layered tests:

```
features/<feature>/
  __tests__/
    <feature>.contract.test.ts   ← "Runtime responses match expected schemas"
    <feature>.handler.test.ts    ← "Given WS messages, handler produces correct store actions"
    <feature>.store.test.ts      ← "Given actions, store produces correct state"
    <feature>.component.test.ts  ← "Given state, component renders correct elements"

  __fixtures__/
    <scenario>.json              ← Golden fixtures (captured from real sessions or hand-written)
```

**Current test state:**

- 125 test files in a flat `src/__tests__/` directory (not co-located with features)
- Tests use `happy-dom` environment with comprehensive setup in `setup.tsx` (mocks for next/navigation, next-intl with real English translations, etc.)
- Store tests directly manipulate Zustand state via `useStore.setState()` and `useStore.getState()` — no fixtures
- Component tests use inline mock state objects — no shared fixtures
- Zero `__fixtures__/` directories exist anywhere in Studio
- Vitest config: 30s timeouts, v8 coverage, `@/` path alias

**Test migration plan:** During feature module extraction, existing tests in `src/__tests__/` stay put until the feature module is stable. Then:

1. Co-located tests (`features/<feature>/__tests__/`) are written for the new module
2. Old test in `src/__tests__/` is deleted once the co-located replacement passes
3. `vitest.config.ts` already includes `src/**/*.{ts,tsx}` — no config changes needed

**Test structure:**

- **Contract tests** validate Zod schemas against fixture data — catches Runtime drift
- **Handler tests** feed fixture WS messages through the handler, assert store mutations
- **Store tests** feed mutations into store, assert resulting state
- **Component tests** render with fixture state, assert DOM output

**Modern techniques & tooling (ranked by effort-to-value):**

1. **Validated fetch wrapper** (Phase 1, ~1 day) — Replace the trust-based `handleResponse<T>()` cast with a `validatedFetch<T>(url, schema)` that parses through Zod at runtime. Every `.api.ts` call gets runtime validation for free. Zod parse errors include the exact field that drifted, making contract violations immediately actionable.

2. **CI spec drift detection** (Phase 1, ~0.5 day) — Commit a golden OpenAPI spec snapshot (from Runtime's `/api-docs`). CI step diffs the live spec against the snapshot. Any drift blocks the PR with a clear "field X was removed/changed" message. Lightweight and catches 80% of drift.

3. **MSW (Mock Service Worker) for WebSocket testing** (Phase 2, ~2-3 days) — MSW v2 supports WebSocket mocking via `ws.link()`. Use MSW handlers in vitest to simulate Runtime WebSocket messages without a running server. Enables handler integration tests that exercise the full bus → handler → store pipeline with realistic message sequences. Also useful for recording/replaying real WebSocket sessions as test fixtures.

4. **OpenAPI→Zod codegen** (Phase 3+, ~2-3 days) — Tools like **hey-api** or **orval** generate Zod schemas and typed fetch clients from Runtime's OpenAPI spec. This eliminates hand-written `.contract.ts` schemas for REST endpoints. Evaluate after Phase 1 proves the manual pattern — codegen is only valuable if Runtime's OpenAPI spec is complete and accurate.

5. **Golden fixture snapshots** (Phase 6, ~1 day) — Part of the Capture→Fixture pipeline. Jest/Vitest inline snapshot tests for store state after processing a fixture event sequence. Catches unexpected state shape changes.

6. **Pact for WebSocket contracts** (Future, ~3-5 days) — Consumer-driven contract testing where Studio defines what it expects from Runtime, and Runtime verifies it produces that. Heavyweight but prevents cross-team drift. Defer until the team structure warrants it.

### Pillar 5: Capture→Fixture Pipeline

The tap-point snapshots from Pillar 3 become the input for Pillar 4's test fixtures:

1. Bug found → capture session via X-Ray tap points
2. `pnpm studio:diagnose` identifies the broken layer
3. Developer (or Claude Code) fixes the bug
4. `pnpm studio:fixture <session-id> <scenario-name>` converts the captured tap data into a golden fixture
5. Fixture is committed → contract/handler/store tests run against it in CI
6. Bug cannot recur without a test failure

## Directory Migration Plan

Feature modules live at `apps/studio/src/features/<feature>/`. During migration, existing directories transition as follows:

| Existing Directory                   | During Migration                                                                         | After Migration                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/store/`                         | Barrel re-exports pointing to `features/<feature>/<feature>.store.ts`                    | Deleted (all stores live inside feature modules)                                                                                              |
| `src/contexts/WebSocketContext.tsx`  | Dual-write: old context + new bus both active                                            | Replaced by `src/infrastructure/ws-transport.ts` + `src/infrastructure/message-bus.ts` (~150 LOC total)                                       |
| `src/services/`                      | Barrel re-exports pointing to `features/<feature>/<feature>.api.ts`                      | Deleted                                                                                                                                       |
| `src/api/` (client-side API modules) | Barrel re-exports pointing to feature `.api.ts` files                                    | Deleted                                                                                                                                       |
| `src/components/<feature>/`          | Moved into `features/<feature>/components/`                                              | Old directory deleted                                                                                                                         |
| `src/components/` (shared)           | Stays — shared UI primitives (Button, Dialog, etc.) remain here                          | Unchanged                                                                                                                                     |
| `src/hooks/`                         | Refactored to delegate to feature `.api.ts`; thin wrappers remain                        | Cross-cutting hooks stay; feature-specific hooks move into feature modules or are inlined                                                     |
| `src/lib/`                           | Stays — cross-cutting utilities (runtime-proxy, api-response, route-handler) remain here | Unchanged                                                                                                                                     |
| `src/repos/`                         | Stays — server-side data access layer, out of scope for feature modules                  | Unchanged                                                                                                                                     |
| `src/db/`                            | Stays — server-side database connection                                                  | Unchanged                                                                                                                                     |
| `src/utils/`                         | Feature-specific utils move into feature modules                                         | `replay-trace-events.ts` → observatory, `graph-generator.ts` → observatory, `llm-cost.ts` → model-config, `derive-ws-url.ts` → infrastructure |
| `src/infrastructure/`                | **New** — WebSocketTransport, MessageBus, tap-point middleware                           | Created in Phase 1                                                                                                                            |

Import redirects use barrel re-exports so that existing `import { useObservatoryStore } from '@/store/observatory-store'` continues to work during migration. Barrel files are deleted per-feature after all consumers are updated.

## WebSocket Message Type → Handler Mapping

Complete inventory of the 16 `ServerMessage` types (defined in `src/types/index.ts`) and their target handlers in the new architecture:

| Message Type              | Current Store(s)                        | New Handler                                        | Notes                                                                            |
| ------------------------- | --------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `agent_loaded`            | session, observatory                    | `sessions.handlers.ts` + `observatory.handlers.ts` | Sets session + agent (sessions), clears events + sets static graph (observatory) |
| `agent_load_error`        | session                                 | `sessions.handlers.ts`                             |                                                                                  |
| `response_start`          | session                                 | `sessions.handlers.ts`                             | Starts streaming                                                                 |
| `response_chunk`          | session                                 | `sessions.handlers.ts`                             | Appends chunk                                                                    |
| `response_end`            | session, observatory                    | `sessions.handlers.ts`                             | Ends streaming + client timer                                                    |
| `trace_event`             | trace, observatory, session             | Split: see decomposition below                     | Largest handler, dual-delivery to observatory + sessions                         |
| `state_update`            | session                                 | `sessions.handlers.ts`                             |                                                                                  |
| `action_taken`            | session                                 | `sessions.handlers.ts`                             |                                                                                  |
| `session_reset`           | session, trace, observatory             | `sessions.handlers.ts` + `observatory.handlers.ts` | Both need to clear state                                                         |
| `session_resumed`         | session, trace, observatory, navigation | `sessions.handlers.ts`                             | Restores full session, replays traces                                            |
| `session_expired`         | session                                 | `sessions.handlers.ts`                             |                                                                                  |
| `context_injected`        | session                                 | `test-context.handlers.ts`                         | Test context feature                                                             |
| `tool_mock_set`           | (none)                                  | `test-context.handlers.ts`                         | Status notification only                                                         |
| `context_injection_error` | session                                 | `test-context.handlers.ts`                         |                                                                                  |
| `error`                   | session                                 | `sessions.handlers.ts`                             | Generic error                                                                    |
| `info`                    | (custom state)                          | `sessions.handlers.ts`                             | Server config status                                                             |

**Note:** `session_reset` requires both sessions and observatory handlers to clear their respective state. Both register for this message type on the bus.

**Note:** `context_injected`, `tool_mock_set`, `context_injection_error` belong to the test-context feature, which the spec currently groups under Sessions. These should get their own handler or be a sub-module of sessions.

## trace_event Handler Decomposition

The `trace_event` case in WebSocketContext (lines 167–308) currently handles concerns belonging to two different feature modules. The full `ExtendedTraceEventType` union has 37 variants (defined in `src/types/index.ts` lines 89–144), covering: core trace types (llm_call, tool_call, decision, constraint_check, handoff, escalation, error), session lifecycle (session_start/end/ended), agent flow (agent_enter/exit, flow_step_enter/exit, flow_transition), ABL constructs (dsl_collect/prompt/respond/set/on_input/call), engine decisions (completion_check, engine_decision, handoff_condition_check, thread_return, data_stored, digression, sub_intent, correction, constraint_violation, warning, user_message), voice pipeline (9 types), and thinking (tool_thought, decision).

This must be explicitly split:

**→ `observatory.handlers.ts` (Phase 1):**

The observatory store's `addEvent()` (348 LOC, lines 292–639) handles these event types — all move to the handler:

- **Event normalization:** dotted → underscore type conversion via `normalizeEventType()`, session start time tracking
- **Metrics:** `llm_call` → token aggregation (inputTokens, outputTokens), LLM call count; `tool_call` → tool call count; `constraint_check` → constraint history
- **Span lifecycle (synthetic):** `agent_enter` → `startSpan()` + flow node update; `agent_exit` → `endSpan()` with LIFO fallback for re-entrant agents; `flow_step_enter` → child span under agent span + step metrics + flow node; `flow_step_exit` → end step span + update step metrics; `session_ended` → sweep all running spans
- **Flow graph:** `handoff` → create target node + add edge + update static graph execution state; `delegate_start` → create target node + add delegate edge; `flow_transition` → add step-to-step edge
- **Static graph execution state:** `llm_call` → mark intent_classifier/reasoning as active; `tool_call` → mark reasoning as visited, tool node as active; step enter/exit → mark step nodes active/visited
- **Event-to-span attachment:** Every event is attached to its agent's running span (with fallback span creation if none exists)
- **Voice events:** `voice_session_start`, `voice_session_end`, `voice_turn`, `voice_stt`, `voice_tts`, `voice_tts_quality`, `voice_asr_quality`, `voice_asr_cascade`, `voice_barge_in` — currently unhandled in addEvent() but defined in ExtendedTraceEventType and may appear in the event stream

**→ `sessions.handlers.ts` (Phase 2):**

- Error surfacing: `trace_event` with `error` sub-type → chat error message (`addMessage` with system role)
- Thought cards: `tool_thought` events → thought card creation/merging with streaming awareness (merge into current turn's thought card when streaming, create new card otherwise)
- Handoff routing: `handoff` events → merged into current turn's thought card metadata, or fallback system message
- State extraction: `dsl_collect`, `entity_extraction` → `gatherProgress` + `context` state; `dsl_set` → `context` assignments
- Log entries: all trace events → `formatTraceEventLog()` → conversation log via `addLog()`

**Cross-feature store dependencies (migration risk):**

Observatory components currently read from session-store (e.g., `GatherProgressPanel` reads gather progress from session state, `DebugTabs` reads session ID). Conversely, chat components read from observatory-store (e.g., `ChatWithDebugPanel` reads spans, `SessionSidebar` reads observatory state). This bidirectional dependency means:

1. Observatory and Sessions feature modules cannot be fully independent — they share state.
2. **Resolution:** Extract shared state (session ID, active agent) into a lightweight `src/infrastructure/session-context.ts` that both features read from. Feature-specific state stays in feature stores. The session context is NOT a Zustand store — it's a simple reactive value (e.g., `useSyncExternalStore` over a shared ref) to avoid yet another store.
3. Alternatively, accept that `observatory.store.ts` exports a few selectors that `sessions` components import, and vice versa. Cross-feature store reads are acceptable; cross-feature store _writes_ are not.

**How the split works at the bus level:**
Both handlers register for the `trace_event` message type on the MessageBus. The bus delivers each trace event to **both** handlers. Each handler filters for the sub-types it owns. This avoids a single handler needing to know about the other's concerns.

```typescript
// observatory.handlers.ts
bus.on('trace_event', (event) => {
  if (isObservatoryConcern(event)) {
    /* span lifecycle, metrics, flow graph */
  }
});

// sessions.handlers.ts
bus.on('trace_event', (event) => {
  if (isSessionConcern(event)) {
    /* thoughts, errors, state extraction */
  }
});
```

During Phase 1 (before sessions.handlers.ts exists), the old WebSocketContext retains the session-related trace_event handling. Phase 2 extracts it.

## trace-store.ts Disposition

The current codebase has both `trace-store.ts` (190 LOC) and `observatory-store.ts` (1,241 LOC) receiving trace events from WebSocketContext. During Phase 1:

- `trace-store.ts` is **merged into** `observatory.store.ts`. The observatory store becomes the single owner of all trace/span/event state.
- Any components currently reading from `trace-store` are updated to read from `observatory.store.ts` instead.
- `trace-store.ts` is deleted after the merge (with a barrel re-export during transition).

Rationale: having two stores for the same data (trace events) is a source of bugs and confusion. One store, one source of truth.

## Feature Module Inventory

### Observatory

- **Current:** 1,241-LOC store (348-line `addEvent()` megafunction), 3,500 LOC active components, data via WebSocket only
- **After:** `features/observatory/`
  - `observatory.api.ts` — trace subscriptions, session queries
  - `observatory.store.ts` — pure state (spans, events, metrics, timeline)
  - `observatory.handlers.ts` — WS trace event handler on the bus
  - `observatory.contract.ts` — Zod schemas for every trace event type
  - `event-normalizer.ts` — type normalization, field mapping (pure function)
  - `span-lifecycle.ts` — span open/close/attach (pure function)
  - `metric-aggregator.ts` — token/cost/latency rollup (pure function)
  - Components: DebugTabs (split into tab-per-file), SpanTree, NodeDetailPanel, FloatingDebugPanel

### Sessions / Chat

- **Current:** Multiple data sources (direct MongoDB + WebSocket + session-store), chat message handling interleaved in WebSocketContext
- **After:** `features/sessions/`
  - `sessions.api.ts` — unifies REST session list (MongoDB) + WS streaming + proxy for mutations
  - `sessions.store.ts` — session list + active session + messages (pure state)
  - `sessions.handlers.ts` — chat message handlers (thought cards, error surfacing, state extraction)
  - `sessions.contract.ts` — message shapes, session shapes, trace shapes
  - Components: SessionsPage, SessionList, ChatPanel, MessageBubble, ThoughtCard

### Connections

- **Current:** Two separate systems (project connectors via Studio DB, channel connections via Runtime proxy) with different APIs, stores, and error handling
- **After:** `features/connections/`
  - `connections.api.ts` — **unified interface** abstracting both backends. Components don't know which backend serves a connection.
  - `connections.store.ts` — connection list + detail + test status
  - `connections.contract.ts` — shared shape regardless of backend source
  - Components: ConnectionsPage, ConnectionList, ConnectionDetail, ConnectionTestPanel

### Agent Detail

- **Current:** `agent-detail-store.ts` (728 LOC), scattered editor components, `arch.service.ts` (2,910 LOC) mixed in
- **After:** `features/agent-detail/`
  - `agent-detail.api.ts` — save, compile, lock, permissions, version
  - `agent-detail.store.ts` — parsed IR sections, expansion state, save status (slimmed)
  - `agent-detail.contract.ts` — agent IR shape, compilation response shape
  - Components: AgentDetailPage, per-section editors (GoalsEditor, ToolsEditor, GuardrailsEditor, etc.)

### Arch (AI Assistant)

- **Current:** `arch.service.ts` (2,910 LOC), `arch-store.ts` (816 LOC), `arch-config-store.ts` (197 LOC with side effects)
- **After:** `features/arch/`
  - `arch.api.ts` — chat, generate, config endpoints
  - `arch.store.ts` — conversation + suggestions + diffs (pure state)
  - `arch-conversation.ts` — conversation flow logic
  - `arch-diff.ts` — diff computation and presentation
  - `arch-generation.ts` — agent generation pipeline
  - `arch-config.ts` — config CRUD (extracted from store side effects)
  - `arch.contract.ts` — chat response shapes, generation response shapes
  - Components: ArchPanel, ArchChat, ArchMessage, ArchDiffView, ArchSuggestionChips

### Search-AI

- **Current:** `search-ai.ts` (2,016 LOC) + `api/crawl.ts` (441 LOC) + `api/pipelines.ts` (365 LOC) — direct fetch calls with connector/crawler/pipeline logic interleaved. The `components/search-ai/` directory is the largest in Studio with 40+ files including sub-directories for pipelines and viewer.
- **After:** `features/search-ai/`
  - `search-ai.api.ts` — unified API layer for knowledge base CRUD
  - `search-ai-connectors.ts` — connector CRUD and OAuth
  - `search-ai-crawl.ts` — crawler configuration, crawl jobs, progress
  - `search-ai-pipelines.ts` — ingestion/query pipeline config (absorbs `api/pipelines.ts`)
  - `search-ai-sync.ts` — sync operations and status
  - `search-ai-discovery.ts` — field discovery and schema
  - `search-ai.store.ts` — connector list + sync status + discovery state
  - `search-ai.contract.ts` — SearchAI-Runtime boundary schemas
  - Components: KnowledgeBaseDashboardPage, KnowledgeBaseDetailPage, ConnectorList, ConnectorDetail, CrawlerTab, PipelineEditor, QueryPlayground, VocabularyTab, KnowledgeGraphTab (40+ components — this is the largest feature module)

### Workflows

- **Current:** `pipeline-store.ts` (472 LOC) + `pipeline-editor-store.ts` (351 LOC) + `pipeline-list-store.ts` (33 LOC) — three stores for one feature (though list store is trivial)
- **After:** `features/workflows/`
  - `workflows.api.ts` — CRUD + versioning + execution
  - `workflows.store.ts` — merged single store (pipeline state + editor state + list state with clear sections)
  - `workflows.contract.ts` — workflow step shapes, execution state shapes
  - Components: WorkflowsPage, WorkflowCanvas, StepEditor, VersionHistory

### Model Config

- **Current:** `ModelsPage.tsx` (2,064 LOC) — everything in one component
- **After:** `features/model-config/`
  - `model-config.api.ts` — tenant + project model CRUD, provider testing
  - `model-config.store.ts` — provider list, model config, test results
  - `model-config.contract.ts` — model/provider shapes, test response shapes
  - Components: ModelConfigPage, ProviderList, ModelForm, TestPanel, BillingSummary

### Deployments & Channels

- **Current:** Two separate directories — `components/deploy/DeployPanel.tsx` (1,137 LOC) for the deployment lifecycle panel AND `components/deployments/` (12 components + `channels/` sub-directory with catalog, registry, normalizer, instance config, 6 tab components). Additionally `api/deployments.ts` (136 LOC), `api/channels.ts` (107 LOC), `api/channel-connections.ts` (143 LOC), `api/channel-oauth.ts` (73 LOC), `api/http-async-channels.ts` (152 LOC).
- **After:** `features/deployments/`
  - `deployments.api.ts` — lifecycle endpoints (create, promote, rollback, retire) + environment management
  - `channels.api.ts` — channel CRUD, catalog, OAuth, connections (unified from 4 current API files)
  - `deployments.store.ts` — deployment list, active deployment, promotion state
  - `deployments.contract.ts` — deployment state shapes, lifecycle response shapes, channel shapes
  - Components: DeployPanel (thin shell), DeploymentList, DeploymentDetail, PromoteDialog, RollbackDialog, ChannelCatalog, ChannelDetail, channel tabs

### Additional Feature Areas (Not Yet Scoped)

The following feature areas exist in the codebase but are not large enough to warrant dedicated phases. They should be migrated opportunistically in Phase 5 or as a follow-on:

| Feature Area    | Current Location                                                     | Complexity                                                          |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Evals           | `components/evals/`, `store/evals-store.ts` (56 LOC), 10+ API routes | Medium — multiple sub-pages (scenarios, personas, evaluators, runs) |
| Analytics       | `components/analytics/` (7 components), `hooks/useAnalytics.ts`      | Low — mostly read-only dashboard                                    |
| Settings        | `components/settings/` (16 components)                               | Low — CRUD forms, no WS                                             |
| Tools           | `components/tools/`, `store/tool-store.ts`, `api/tools.ts`           | Low                                                                 |
| MCP Servers     | `components/mcp-servers/`, `store/mcp-server-store.ts`               | Low                                                                 |
| Auth Profiles   | `components/auth-profiles/`, `api/auth-profiles.ts`                  | Low — new feature, already small                                    |
| Governance      | `components/governance/` (1 component)                               | Trivial                                                             |
| Voice Analytics | `components/voice-analytics/`                                        | Low                                                                 |
| Alerts          | `components/alerts/`                                                 | Low                                                                 |

### Hooks Migration Strategy

The `src/hooks/` directory contains 40+ hooks, many with inline `fetch` calls (e.g., `useConnectors.ts`, `useGuardrails.ts`, `useEnvVars.ts`). These are a significant source of scattered data-fetching logic that the feature module pattern must absorb:

- **Rule:** Each feature module's `.api.ts` replaces the corresponding hook's fetch logic. The hook becomes a thin wrapper: `useConnectors()` calls `connections.api.fetchConnectors()` internally.
- **During migration:** Hooks stay in `src/hooks/` but are refactored to delegate to the feature API layer. After all consumers are updated, hooks that are purely data-fetching wrappers may be inlined into components using SWR directly with the feature API.
- **Hooks that remain:** Cross-cutting hooks (`useOutsideClick`, `useSession`) stay in `src/hooks/`. Runtime WebSocket transport now lives behind the dedicated provider/context layer instead of a standalone `useWebSocket` hook.

### Server-Side Code (`repos/`, `services/`, `db/`)

Studio has significant server-side code (Next.js API routes + supporting layers) that is **out of scope** for the feature module restructuring:

- `src/repos/` — 14 repository files (data access layer for Studio's own MongoDB)
- `src/services/` — 20+ service files (business logic for server-side API routes)
- `src/db/` — database connection
- `src/app/api/` — Next.js API route handlers (server-side, already well-structured by convention)

The feature module pattern applies to **client-side code only** (stores, hooks, components, client API modules). Server-side code follows its own layering (route → service → repo → db) which is already reasonably structured.

## Phasing

### Phase 1: Infrastructure + Observatory Pilot

**Goal:** Build the infrastructure and prove the pattern on the most painful feature.

**Scope:**

1. `WebSocketTransport` — connect/disconnect/reconnect only
2. `MessageBus` — typed dispatch + handler registration + middleware support
3. Feature module scaffold (`features/` directory, conventions documented)
4. Tap point infrastructure (middleware on bus, in-memory ring buffers)
5. `pnpm studio:diagnose` CLI skeleton
6. **Observatory feature module** — full migration:
   - `observatory.api.ts`, `observatory.store.ts`, `observatory.handlers.ts`, `observatory.contract.ts`
   - `event-normalizer.ts`, `span-lifecycle.ts`, `metric-aggregator.ts`
   - Tap points at transport → handler → store → UI
   - Contract tests with captured fixtures
7. Dual-write: new bus runs alongside old WebSocketContext (observatory uses bus, everything else stays on old context)

**Validation:** Observatory bugs diagnosable via `pnpm studio:diagnose`. Contract tests catch observatory schema drift.

### Phase 2: Sessions + Chat

**Goal:** Migrate the highest user-facing impact feature. Extract the biggest chunk of WebSocketContext logic.

**Scope:**

1. `features/sessions/` — full module (api, store, handlers, contract, components)
2. Chat message handlers extracted from WebSocketContext → `sessions.handlers.ts`
3. Thought card logic, error surfacing, state extraction → handler
4. Session list unified (REST + WS sources documented in api.ts)
5. Contract tests + fixtures for message shapes
6. Tap points for chat pipeline

**Validation:** Chat debugging follows same pattern as Observatory. WebSocketContext loses its largest handler block.

### Phase 3: Connections + Agent Detail (parallel with Phase 2 if resources allow)

**Goal:** Fix the most confusing data flows.

**Scope:**

1. `features/connections/` — unified interface over two backends
2. `features/agent-detail/` — per-section editors, slimmed store
3. Contract tests for connection shapes and agent IR shapes

**Validation:** Connections work through one mental model. Agent detail sections are independently navigable.

### Phase 4: Arch + Search-AI (parallel with Phase 3)

**Goal:** Decompose the biggest megafiles.

**Scope:**

1. `features/arch/` — split arch.service.ts (2,910 → 4 files), extract config store side effects
2. `features/search-ai/` — split search-ai.ts (2,016 LOC) + crawl.ts (441 LOC) + pipelines.ts (365 LOC) → 6 API modules
3. Contract tests for both

**Validation:** No file over 500 LOC in Arch or Search-AI.

### Phase 5: Workflows + Model Config + Deployments

**Goal:** Complete the migration for remaining pages.

**Scope:**

1. `features/workflows/` — merge two stores, split components
2. `features/model-config/` — split ModelsPage.tsx (2,064 → components)
3. `features/deployments/` — unify deploy/ + deployments/ + channels/ (DeployPanel 1,137 LOC + 20+ deployment/channel components + 5 channel API files)
4. Contract tests for all three

**Validation:** All major pages follow the feature module pattern.

### Phase 6: Capture→Fixture Pipeline + CI + Error Standardization

**Goal:** Make the system self-reinforcing.

**Scope:**

1. `pnpm studio:fixture <session-id> <name>` — converts tap snapshots to golden fixtures
2. CI integration — contract tests on every PR
3. Extend existing `ErrorBoundary` component (`src/components/ui/ErrorBoundary.tsx`) to all feature module page shells (currently only used in ABLEditor and PipelineEditor)
4. Standardized error types in all `*.api.ts` (structured errors, no silent swallows). **Current state:** 317 bare `catch {}` blocks across 192 files, 433 `toast.error/success` calls across 88 components, and an existing `ErrorBoundary` component used in only 3 places (ABLEditor, PipelineEditor, page.tsx). Error standardization must address:
   - Replace bare `catch {}` with structured error handling in feature `.api.ts` files
   - Consolidate toast patterns: each feature `.api.ts` should handle errors uniformly (components should not call toast directly for API errors)
   - Wrap every feature page shell in `ErrorBoundary` for unhandled render errors
5. Delete old WebSocketContext — **gate check:** only when zero components import `useWebSocketContext` directly (verify with `grep -r useWebSocketContext apps/studio/src/`)

**Validation:** CI catches Runtime drift. Captured bugs become regression tests automatically.

### Phase Dependencies

```
Phase 1 (Infrastructure + Observatory)
  ↓ pattern proven
Phase 2 (Sessions/Chat)    Phase 3 (Connections/Agent)    Phase 4 (Arch/Search-AI)
       ↓                         ↓                              ↓
       └────────────── all feed ─┴──────────────────────────────┘
                                 ↓
                    Phase 5 (Workflows/Models/Deploy)
                                 ↓
                    Phase 6 (CI + Capture Pipeline)
```

Phases 2, 3, 4 are fully parallel — different features, different files, no conflicts. Good candidates for parallel Claude Code agents in worktrees.

### Migration Safety (all phases)

- Each feature module runs **alongside** old code during migration (dual-write for bus, re-exports for imports)
- Old imports redirected to new module via barrel re-exports — no big-bang rename
- Feature module goes "live" only after its contract tests pass
- Old code deleted per-feature after migration validated
- Each phase gate: `pnpm build` passes, existing tests pass, new contract tests pass

## Risk Register

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                   |
| ------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------- |
| Dual-write period introduces subtle bugs (events processed twice or not at all) | Medium     | High   | Each handler has a tap point — diagnosis immediately shows double-processing or drops        |
| Observatory ↔ Sessions cross-dependency creates circular import                 | High       | Medium | session-context.ts in infrastructure layer; lint rule banning cross-feature store writes     |
| Search-AI migration (40+ components) takes much longer than other features      | High       | Medium | Split Phase 4 into two sub-phases: API layer first, then components                          |
| 317 bare catch blocks make error standardization in Phase 6 a huge task         | High       | Low    | Prioritize catch blocks in .api.ts files only; leave component catch blocks for a later pass |
| Contract tests become maintenance burden (schema changes require test updates)  | Medium     | Medium | Zod schemas generate TS types automatically; contract tests run only on affected features    |
| Performance regression from MessageBus overhead (extra dispatch layer)          | Low        | Medium | Bus middleware is zero-cost when disabled; benchmark against WebSocketContext baseline       |

## Success Criteria

1. **Any Studio bug is diagnosable in under 5 minutes** — `pnpm studio:diagnose` identifies the broken layer and file
2. **Claude Code can fix a Studio bug by reading 3 files** — `<feature>.api.ts` (data flow), `<feature>.contract.ts` (expected shapes), the broken file (identified by diagnosis)
3. **No file over 500 LOC** in critical feature paths
4. **Runtime contract drift caught in CI** — before any human or AI opens the browser
5. **Every diagnosed bug becomes a regression test** — test suite grows from real bugs, not imagination

## Out of Scope

- Runtime-side restructuring (Runtime's OpenAPI registry is already well-organized)
- Full OpenAPI→Zod codegen pipeline (evaluated: hey-api/orval — defer until Phase 3+ after manual pattern proves out and Runtime's OpenAPI spec completeness is verified)
- Full OpenTelemetry browser SDK (evaluated: too heavy — use OTel-inspired JSONL schema instead)
- Pact consumer-driven contract testing (evaluated: valuable for cross-team drift but heavyweight — defer until team structure warrants it)
- Visual regression testing (Playwright visual tests already exist)
- Performance optimization (this is about structure, not speed)
- Server-side code restructuring (`src/repos/`, `src/services/`, `src/app/api/`) — already follows route → service → repo layering

## Appendix: Modern Techniques & Libraries

Research conducted 2026-03-12. Recommendations integrated into the relevant pillars above; this section provides the full evaluation context.

### Event Bus Libraries

| Library    | Size   | Async | Wildcard/onAny | Middleware                       | TypeScript      | Verdict               |
| ---------- | ------ | ----- | -------------- | -------------------------------- | --------------- | --------------------- |
| emittery   | ~1.3KB | Yes   | `onAny()`      | No (but onAny covers tap points) | Generic support | **Recommended**       |
| nanoevents | ~0.1KB | No    | No             | No                               | Good            | Viable minimal option |
| mitt       | ~0.2KB | No    | `*` wildcard   | No                               | Good            | Not ideal for async   |
| ts-bus     | ~2KB   | Yes   | No             | Yes                              | Excellent       | Low adoption, risk    |
| RxJS       | ~30KB  | Yes   | Yes            | Operators                        | Excellent       | Overkill              |

**Decision:** Hand-rolled MessageBus for Phase 1 (~60 LOC), with emittery as documented swap-in option if complexity grows. The facade pattern (`on`/`emit`/`use`) makes the swap transparent.

### Diagnostics & Debugging

- **JSONL with OTel-inspired schema** — adopted for tap-point exports. Each tap record includes `ts`, `layer`, `type`, `subType`, `sessionId`, `seq` (monotonic for cross-layer correlation). Not full OTel (browser SDK is 50KB+), but the schema is compatible if we ever need to push to Jaeger/Grafana Tempo.
- **Zustand `devtools` middleware** — adopted for all new feature stores. Provides time-travel, state diffing, and action replay via Redux DevTools extension. Zero production cost (tree-shaken). Already proven in the ecosystem.
- **In-app diagnostic panel over Chrome extension** — adopted. Lower friction (no install), works in any browser, can access ring buffers directly. The "Download Diagnostics" button exports JSONL for CLI analysis.
- **MSW v2 WebSocket recording/replay** — deferred to Phase 2. Can record real WebSocket sessions and replay them in tests, enabling integration tests without a running Runtime.

### Contract Testing

| Technique                                                  | Effort   | Value                                                                           | Phase       |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- | ----------- |
| Validated fetch wrapper (`validatedFetch<T>(url, schema)`) | 1 day    | High — runtime Zod validation on every API call, exact field-level drift errors | **Phase 1** |
| CI spec drift detection (golden OpenAPI snapshot diff)     | 0.5 day  | High — catches 80% of drift before tests run                                    | **Phase 1** |
| MSW + vitest for WebSocket handler integration tests       | 2-3 days | High — exercises full bus→handler→store pipeline                                | Phase 2     |
| hey-api / orval (OpenAPI→Zod codegen)                      | 2-3 days | Medium — eliminates hand-written .contract.ts for REST endpoints                | Phase 3+    |
| Golden fixture snapshots (inline snapshot tests)           | 1 day    | Medium — catches unexpected state shape changes                                 | Phase 6     |
| Pact consumer-driven contracts (WebSocket)                 | 3-5 days | High but heavyweight — cross-team drift prevention                              | Future      |

**Decision:** Phase 1 adopts validated fetch wrapper + CI spec drift detection. MSW adopted in Phase 2. Codegen evaluated after manual pattern is proven.

## Review Log

### Iteration 1

**Explored:** WebSocketContext.tsx, observatory-store.ts, arch.service.ts, search-ai.ts, ModelsPage.tsx, DeployPanel.tsx, all stores, hooks directory, repos directory, catch blocks, ErrorBoundary, trace_event sub-branches
**Findings:** 4 inaccuracies, 6 gaps, 0 new ideas
**Changes:**

- Fixed WebSocketContext LOC: 975 → 974, message types: 14 → 16, trace_event sub-branches: ~8 → 5+log
- Fixed catch block count: 80 → 202 across 92 files
- Added store names routed to by WebSocketContext (session, trace, observatory, auth, ui, navigation)
- Added hooks/ and repos/ directories to Structural Audit table
- Added hooks/ and repos/ to Directory Migration Plan table
- Added "Hooks Migration Strategy" section explaining how 40+ hooks with inline fetch logic will be absorbed
- Added "Server-Side Code" section clarifying repos/services/db are out of scope
- Added "Additional Feature Areas" table listing 9 unscoped features (evals, analytics, settings, tools, mcp-servers, auth-profiles, governance, voice-analytics, alerts)
- Fixed ErrorBoundary in Phase 6: already exists at components/ui/ErrorBoundary.tsx, needs extension not creation
- Updated sessions.handlers.ts trace_event decomposition to match actual sub-branches (tool_thought, not tool_call/reasoning/constraint_check)
- Added pipeline-list-store.ts actual LOC (33) to show it's trivial

### Iteration 2

**Explored:** All component directories (observatory, chat, sessions, connections, agent-detail, arch, search-ai, deploy, deployments, pipelines, workflows), cross-store imports, client API file sizes, feature component counts
**Findings:** 3 gaps, 1 inaccuracy, 2 new ideas
**Changes:**

- Added cross-feature store dependency analysis: observatory reads session-store, chat reads observatory-store — proposed session-context.ts as shared reactive value
- Fixed Deployments section: was only DeployPanel (1,137 LOC), actually two directories with 20+ components including channels catalog, registry, normalizer, 6 tabs, plus 4 API files
- Fixed Search-AI section: was undersized, actually 40+ components across sub-directories, plus crawl.ts (441 LOC) and pipelines.ts (365 LOC) API files
- Added client-side API directory stats to audit table (26 files, 6,512 LOC)
- Identified that agent-detail components also cross-reference tool-store (ToolsSection imports from tool-store)

### Iteration 3

**Explored:** WebSocket ServerMessage types (src/types/index.ts), TraceEventType + ExtendedTraceEventType (37 variants), observatory-store addEvent() full implementation (292-639), formatTraceEventLog, replay-trace-events.ts
**Findings:** 3 gaps, 2 inaccuracies, 1 new idea
**Changes:**

- Added complete WebSocket Message Type to Handler Mapping table (16 message types with current stores and target handlers)
- Identified test-context as a separate handler domain (context_injected, tool_mock_set, context_injection_error) — added test-context.handlers.ts to bus handler list
- Replaced vague observatory.handlers.ts decomposition with detailed event-type-to-action mapping from actual addEvent() code (metrics, span lifecycle, flow graph, execution state, voice events)
- Added full ExtendedTraceEventType inventory (37 variants) to trace_event decomposition section
- Identified voice pipeline events (9 types) as defined but unhandled — documented as migration consideration
- Fixed message bus handler names from generic (chat-handler, agent-handler, auth-handler) to match actual feature module naming (sessions.handlers.ts, observatory.handlers.ts, test-context.handlers.ts)

### Iteration 4

**Explored:** Zod schema usage across Studio (333 z.object instances in 85 files), client-side API response types, api-client.ts handleResponse pattern, shared package schemas, TypeScript interfaces in src/api/ and src/types/
**Findings:** 2 gaps, 1 new idea, 0 inaccuracies
**Changes:**

- Added "Current schema state" section to Pillar 4: quantified that Zod is used almost exclusively server-side, client has near-zero runtime validation
- Documented the apiFetch/handleResponse trust-based pattern and how .api.ts files should integrate Zod parsing
- Added concrete code example showing how contract schemas integrate with existing handleResponse utility
- Noted 30+ TypeScript response interfaces scattered across src/api/\*.ts that will be replaced by Zod schemas in .contract.ts files

### Iteration 5

**Explored:** vitest.config.ts, setup.tsx, trace-store.test.ts, observatory-components.test.tsx, test file count, fixture directories, test patterns (inline mocks vs fixtures)
**Findings:** 2 gaps, 0 inaccuracies, 1 new idea
**Changes:**

- Added "Current test state" section to Pillar 4: 125 test files in flat directory, happy-dom environment, no fixtures anywhere, inline mock patterns
- Added "Test migration plan" explaining how existing tests coexist with new co-located tests during migration
- Documented that vitest.config.ts already supports the feature module test structure (no config changes needed)
- Key insight: the Capture-to-Fixture pipeline (Pillar 5) will need to create the first-ever **fixtures** directories — this is greenfield, not migration

### Iteration 6

**Explored:** Error handling patterns: toast usage (sonner), catch blocks, bare catch {} blocks, ErrorBoundary usage, error propagation patterns
**Findings:** 3 gaps, 0 inaccuracies, 1 new idea
**Changes:**

- Quantified error handling debt: 317 bare `catch {}` blocks across 192 files (silent swallows), 433 toast calls across 88 components (inconsistent patterns)
- Expanded Phase 6 error standardization with concrete sub-tasks: replace bare catch blocks, consolidate toast patterns into .api.ts, wrap feature pages in ErrorBoundary
- Noted ErrorBoundary is used in only 3 places (ABLEditor, PipelineEditor, page.tsx) despite existing — most feature pages have no error boundary
- New idea: feature .api.ts files should centralize toast/error handling so components don't handle errors directly (single error presentation point per feature)

### Iteration 7

**Explored:** Full spec re-read for contradictions, phasing consistency, missing risks, diagnostic CLI feasibility, utils directory disposition, agent_loaded handler multi-store routing
**Findings:** 4 inaccuracies, 3 gaps, 1 contradiction
**Changes:**

- Fixed Problem Statement prose: "975 LOC" → "974 LOC", "20+ message types" → "16 message types" (was already fixed in audit table but not in narrative)
- Fixed agent_loaded handler mapping: routes to both sessions + observatory (not just sessions)
- Fixed Phase 4 search-ai scope: "2,016 → 3 modules" → "2,016 + 441 + 365 LOC → 6 API modules"
- Fixed Phase 5 deployments scope: "split DeployPanel.tsx (1,137 → stages)" → full scope including 20+ components and 5 API files
- Added trace-store.ts actual LOC (190) to disposition section
- Added diagnostic CLI data extraction section: explained browser↔CLI communication gap, proposed 3 options with Option B (download button) as recommended
- Added utils/ directory to migration table: replay-trace-events.ts → observatory, graph-generator.ts → observatory, llm-cost.ts → model-config, derive-ws-url.ts → infrastructure
- Added Risk Register with 6 risks: dual-write bugs, circular imports, search-ai migration scope, catch block debt, contract test maintenance, performance regression
