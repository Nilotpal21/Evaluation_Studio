# Unified Observability Design

**Date:** 2026-03-10
**Status:** Approved
**Scope:** Runtime trace system, Studio sessions/traces/debug UI

## Problem

1. **Two parallel trace systems** — TraceEvents (always emitted, flat list with spanId/parentSpanId) and DecisionLog (gated by traceVerbosity, in-memory only, rich "why" data). They don't talk to each other.
2. **No waterfall visualization** — SpanTree component exists but is never rendered. Debug panel shows flat decision list. Traces explorer synthesizes fake hierarchy from event types.
3. **Decision log broken** — requires `verbose` verbosity but most sessions run at `standard`. Even Studio debug sessions showed nothing.
4. **Feature gaps vs AgenticAI** — no generations list, no node detail panel, no advanced filters, no cost tracking, no CSV export, no progressive loading.

## Approach: Merge Decisions Into Trace Events

Kill the separate decision log system. Decision entries become trace events with `type: 'decision'`, inheriting spanId/parentSpanId from the trace emitter's span stack. Persisted to ClickHouse alongside all other trace events. One system, one pipeline, one UI.

## Section 1: Data Model

### Decision Trace Event Shape

```typescript
interface DecisionTraceEvent extends TraceEvent {
  type: 'decision';
  decisionKind:
    | 'field_validation'
    | 'gather_extraction'
    | 'flow_transition'
    | 'correction'
    | 'data_mutation'
    | 'handoff'
    | 'delegation';
  metadata: {
    reason: string;
    candidates?: any[]; // handoff candidates, delegation options
    selected?: string; // chosen option
    conditions?: any[]; // evaluated conditions
    fieldErrors?: any[]; // validation results
    [key: string]: unknown;
  };
}
```

### Verbosity Gating

| Decision Kind       | Verbosity Level | Rationale                 |
| ------------------- | --------------- | ------------------------- |
| `handoff`           | standard        | Critical routing decision |
| `delegation`        | standard        | Critical routing decision |
| `flow_transition`   | standard        | User-visible control flow |
| `field_validation`  | standard        | Explains gather failures  |
| `gather_extraction` | verbose         | High volume per turn      |
| `correction`        | verbose         | Noisy, debugging only     |
| `data_mutation`     | verbose         | Noisy, debugging only     |

Studio debug sessions always run at `verbose` (already set in `runtime-executor.ts`).

## Section 2: Runtime Changes

### Kill `decision-log.ts` as a Separate System

Decision entries flow through the existing `TraceEmitter` instead of a separate in-memory array.

**Changes to `trace-emitter.ts`:**

- Add `emitDecision(kind, metadata)` method that:
  1. Checks `shouldEmitTrace('decision', verbosity)` (reuses existing gating)
  2. Creates a `TraceEvent` with `type: 'decision'`, `decisionKind: kind`, inherits current `spanId`/`parentSpanId` from the span stack
  3. Emits through the same pipeline (WebSocket push + ClickHouse write)

**Changes to `trace-helpers.ts`:**

- Add `'decision'` to both `STANDARD_EVENTS` and `VERBOSE_EVENTS` arrays
- `shouldEmitTrace` gains a second check: if `eventType === 'decision'`, also check `decisionKind` against the verbosity table above

**Changes to callers** (gather executor, flow executor, handoff executor, etc.):

- Replace `appendDecision(session, { ... })` calls with `traceEmitter.emitDecision(kind, metadata)`
- Each call site already has access to the trace emitter via the execution context

**`decision-log.ts` removal:**

- Delete the file
- Remove `decisionLog` from session state
- Remove the `decisions` WebSocket message type (decisions now arrive as regular trace events)

**Performance preserved:**

- Zero-cost gate remains (`shouldEmitTrace` returns false immediately for low verbosity)
- No in-memory accumulation (events stream out, no 500-entry FIFO buffer)
- ClickHouse `BufferedWriter` batching unchanged (10K rows, 5s flush)

## Section 3: ClickHouse Storage

**No schema migration.** The existing `trace_events` table already has everything needed:

| Column                                  | Usage for decisions                                                     |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `event_type`                            | `'decision'`                                                            |
| `metadata`                              | JSON blob with `decisionKind`, `reason`, `candidates`, `selected`, etc. |
| `span_id`                               | Inherited from trace emitter's span stack                               |
| `parent_span_id`                        | Inherited from trace emitter's span stack                               |
| `timestamp`                             | Auto-set                                                                |
| `session_id`, `tenant_id`, `project_id` | Already propagated                                                      |

**Write volume impact:** Decision events add ~5-15 events per turn at `standard` verbosity (handoff/delegation/flow decisions), ~20-40 at `verbose` (adds gather extraction, corrections, data mutations). Current trace volume is ~30-80 events per turn. Worst case doubles write volume for verbose sessions (Studio debug only). Standard sessions see ~20-40% increase.

**Query patterns unchanged.** Existing queries filter by `event_type` — decisions are just another event type. To get the old "decision log" view, filter `WHERE event_type = 'decision'`. To build the waterfall, query all events for a session ordered by timestamp.

**Retention:** Same TTL as other trace events (configured per tenant). No separate retention policy needed.

## Section 4: Unified UI

Three surfaces, one shared component hierarchy. Tab is called "Traces" everywhere.

### 4a. Shared Components

**`SpanTree.tsx`** (exists, enhance):

- Decision event rendering: icon + kind badge + reason text
- Cost column with color coding (green < $0.01, yellow $0.01-$0.10, red > $0.10)
- Duration bars (already implemented)
- Token breakdown tooltip on hover (input/output/total tokens + costs)
- Status indicators: green checkmark (completed), red X (error), orange ! (warning), spinner (running)
- Copy span ID to clipboard with checkmark feedback

**New: `WaterfallPanel.tsx`** — wrapper that:

1. Takes events (WebSocket stream or ClickHouse query)
2. Builds span tree from `spanId`/`parentSpanId`
3. Renders `SpanTree` with surface-appropriate options

**New: `NodeDetailPanel.tsx`** — right sidebar when clicking a span:

- **Summary row**: cost ($), total tokens, latency, timestamp (4-column layout for LLM calls, 2-column for spans)
- **Tabs**:
  - **Preview**: formatted input/output with chat bubbles color-coded by role (user=blue, assistant=green, system=gray, tool=orange)
  - **Request**: full input JSON
  - **Response**: full output JSON
  - **Metadata**: span metadata (decision kind, reason, candidates, etc.)
  - **Logs**: status messages and errors
- For decision events: shows reason, candidates list, selected option, evaluated conditions

**New: `TimeRangeSelector.tsx`**:

- Preset buttons: 1h, 24h, 7d, 30d, 90d
- Custom date range picker
- Preset label shown in header
- UTC normalization

**New: `AdvancedFilterPanel.tsx`** — right-side slideout (720px):

- Add/remove filter rows
- Per-filter controls: column dropdown, operator dropdown, value input
- Operators by type:
  - String: =, !=, contains
  - Number: =, >, >=, <, <=
  - DateTime: >=, <=, =
  - Multi-select: "any of", "none of"
- AND logic between filters
- Filter tags displayed above table showing active filters
- Remove individual filter from tag bar / clear all

**New: `ColumnCustomizer.tsx`** — right-side slideout:

- Toggle columns on/off
- Drag to reorder
- Pinned columns always visible
- State persisted to localStorage

**New: `CsvExport.tsx`** — export button:

- Exports all visible + hidden columns
- Filename with timestamp (e.g., `sessions-2026-03-10.csv`)
- Disabled when no data

**Search component**:

- Two modes: "Search IDs & Metadata" vs "Search Full Content"
- Toggle between modes
- 300ms debounce

### 4b. Chat Debug Panel (`DebugTabs.tsx`)

**Replace "Decisions" tab with "Traces" tab:**

- Real-time waterfall via WebSocket
- Uses `observatory-store`'s existing `addEventToSpan`/`getSpanTree()`
- Decision events render inline within their parent span
- Clicking a span opens `NodeDetailPanel` in a right drawer
- Keep other 4 tabs: Data, Conversation, Performance, IR

### 4c. Sessions List (`SessionsListPage.tsx`)

**Columns (default visible):**

- Session ID (pinned, copy button)
- Environment
- Created At
- Traces count
- Duration (human-readable: "2m 30s")
- Tokens (formatted with commas)
- Cost (color-coded)
- User ID

**Columns (hidden by default):**

- Input Cost ($), Output Cost ($)
- Input Tokens, Output Tokens
- Source (debug_websocket, api, widget, etc.)
- Channel Type

**Features:**

- TimeRangeSelector (presets + custom)
- AdvancedFilterPanel with all columns filterable
- ColumnCustomizer
- CsvExport
- Sorting on all columns (default: Created At DESC)
- Pagination: 50 per page, first/prev/next/last buttons, "1-50 of 500" indicator
- Click row → Session Detail Page
- Environment filter

### 4d. Session Detail Page (`SessionDetailPage.tsx`)

**Header:**

- Session ID (copy button)
- Created timestamp, duration, environment
- Trace count, total tokens, total cost
- User IDs

**Layout:**

- Left: Agent Conversation Tree (existing)
- Right top: Session summary (existing)
- Right main: **Traces waterfall** with `WaterfallPanel` + `NodeDetailPanel`
  - Progressive loading: span summaries first, expand to load children on click
  - Cost summary row at top of waterfall
  - Batch loading (5 traces at a time)

### 4e. Traces Explorer (`TracesExplorerTab.tsx`)

**Three sub-tabs: Traces, Generations**

**Traces sub-tab — columns (default visible):**

- Trace ID (pinned, copy button)
- Input (lazy-loaded)
- Session ID (linked)
- Latency
- Output (lazy-loaded)
- Total Cost (color-coded)
- Total Tokens
- Environment
- Created At

**Traces sub-tab — columns (hidden by default):**

- User ID
- Level (DEBUG/DEFAULT/WARNING/ERROR with color badges)
- Source
- Input/Output tokens breakdown
- Input/Output cost breakdown
- Tags, Metadata

**Generations sub-tab — columns (default visible):**

- Model (pinned)
- Name
- Input (lazy-loaded)
- Output (lazy-loaded, green highlight)
- Latency
- Tokens
- Cost (color-coded)
- Start Time
- Trace ID

**Generations sub-tab — columns (hidden by default):**

- User ID, End Time, Time to First Token, Tokens/sec
- Level, Input/Output tokens, Input/Output cost, Metadata

**Shared features across both sub-tabs:**

- TimeRangeSelector
- AdvancedFilterPanel (all columns filterable with typed operators)
- Search with metadata/full-text toggle
- ColumnCustomizer
- CsvExport
- Sorting (default: timestamp DESC)
- Pagination (50/page)
- Click row → opens trace detail with waterfall + NodeDetailPanel
- Clicking a generation row → opens trace detail with that observation pre-selected

**Replace synthesized span tree with real one:**

- Remove inline `TraceSpanTree` that fakes hierarchy from event types
- Use shared `WaterfallPanel` with real `spanId`/`parentSpanId`
- Keep timeline view as alternative flat view toggle

### 4f. Loading & Empty States

- **Initial load**: Skeleton loaders for tables, trees, and node detail panel
- **Lazy-loaded fields**: Inline skeleton in cells (input/output columns)
- **Empty state**: Icon + "No sessions/traces found. Try adjusting your filters or time range."
- **Refresh button** with spinner
- **Progressive rendering**: `hasInitiallyLoaded` flag to prevent flash

## Section 5: API Changes

### New/Enhanced Endpoints

| Endpoint                                    | Method | Description                                                                           |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `/api/sessions`                             | GET    | Enhanced: advanced filters, time range, column selection                              |
| `/api/sessions/:id/traces`                  | GET    | Enhanced: `eventType`, `decisionKind`, `spanId`, `limit`, `offset`, `include=metrics` |
| `/api/sessions/:id/traces/:spanId/children` | GET    | **New**: progressive loading — events within a specific span                          |
| `/api/sessions/:id/metrics`                 | GET    | **New**: aggregated cost, tokens, duration, trace count                               |
| `/api/traces`                               | GET    | Enhanced: advanced filters, search modes, sparse field selection, time range          |
| `/api/traces/:id/detail`                    | GET    | **New**: full trace with span tree structure + per-span metrics                       |
| `/api/generations`                          | GET    | **New**: filtered trace events where type is LLM call                                 |
| `/api/traces/export`                        | GET    | **New**: CSV export with streaming response                                           |

### WebSocket Changes

Decision events arrive as regular trace events through the existing `trace_event` message type. Remove the separate `decisions` message type.

### Key ClickHouse Queries

**Span tree aggregation (progressive loading):**

```sql
SELECT span_id, parent_span_id,
  min(timestamp) as start_time, max(timestamp) as end_time,
  sumIf(metadata.tokens_used, event_type = 'llm_call') as total_tokens,
  count() as event_count
FROM trace_events
WHERE session_id = ? AND tenant_id = ?
GROUP BY span_id, parent_span_id
ORDER BY start_time
```

**Generations query:**

```sql
SELECT * FROM trace_events
WHERE tenant_id = ? AND event_type = 'llm_call'
  AND timestamp BETWEEN ? AND ?
ORDER BY timestamp DESC
LIMIT ? OFFSET ?
```

## Section 6: RBAC

All endpoints use `createUnifiedAuthMiddleware` + `requirePermission()`.

| Endpoint                     | Permission      | Isolation                                          |
| ---------------------------- | --------------- | -------------------------------------------------- |
| `GET /api/sessions`          | `sessions:read` | `WHERE tenant_id = req.tenantId` always            |
| `GET /api/sessions/:id/*`    | `sessions:read` | `findOne({ _id, tenantId })` — 404 on cross-tenant |
| `GET /api/traces`            | `traces:read`   | `WHERE tenant_id = req.tenantId`                   |
| `GET /api/traces/:id/detail` | `traces:read`   | Tenant-scoped lookup                               |
| `GET /api/generations`       | `traces:read`   | Same as traces                                     |
| `GET /api/traces/export`     | `traces:export` | Separate permission — admin-gated                  |

**Project-scoped routes** (under `/api/projects/:projectId/...`):

- Use `requireProjectPermission(req, res, 'sessions:read')`
- Verify `session.projectId === req.params.projectId`
- Cross-project access returns 404

**Sensitive data**: List endpoints return only aggregated metrics (cost, tokens, duration). Full event content (LLM inputs/outputs) requires authenticated `/detail` or `/children` calls. No bulk content exposure.

**CSV export**: Separate `traces:export` permission prevents regular users from bulk-downloading trace data. Rate-limited via existing API rate limiter.

**WebSocket**: Already authenticated via debug WebSocket handshake. Events only stream for the session the user owns.

## Section 7: Performance

**Write path:**

- Zero-cost gate: `shouldEmitTrace()` returns false immediately for low verbosity
- Standard sessions: ~20-40% more events (high-value decisions only)
- Verbose sessions (Studio debug only): up to 2x — single-user, not production traffic
- BufferedWriter unchanged: 10K row batch, 5s flush, 100K max buffer, async inserts

**Read path:**

- Progressive loading: span summaries first, child events on expand
- Lazy-load input/output: batched in groups of 5 with 100ms delays
- Session metrics fetched in parallel with session list
- 1-minute TTL cache on observation input/output

**Client-side:**

- `memo` on cell renderers, `useMemo` for derived data
- 300ms debounce on search
- Observatory-store limits: 2K events, 1K spans

**Storage:**

- No schema migration, no new tables
- Same TTL-based retention per tenant
- Full-text search is opt-in (metadata search is default)

## Feature Parity with AgenticAI

| AgenticAI Feature                  | ABL Implementation                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Observation tree (parent-child)    | SpanTree with real spanId/parentSpanId                                 |
| Cost per observation + session     | Cost column with color coding + token breakdown tooltip                |
| Progressive loading                | Lazy-load children on expand, batch loading                            |
| Generations list                   | Dedicated sub-tab in Traces Explorer                                   |
| Node detail panel                  | Right sidebar with Preview/Request/Response/Metadata/Logs tabs         |
| Advanced filters (typed operators) | AdvancedFilterPanel with string/number/datetime/multi-select operators |
| Time range presets + custom        | TimeRangeSelector component                                            |
| Full-text search                   | Search mode toggle (metadata vs full content)                          |
| Column customization               | ColumnCustomizer with show/hide + reorder                              |
| CSV export                         | CsvExport with all columns                                             |
| Status indicators                  | Color-coded icons (success/error/warning/running)                      |
| Duration bars                      | Already in SpanTree                                                    |
| Environment filtering              | Environment column + filter                                            |
| Copy IDs to clipboard              | Copy buttons with checkmark feedback                                   |
| Chat bubble formatting             | Color-coded by role in NodeDetailPanel Preview tab                     |
| Skeleton loaders                   | Table, tree, and node detail skeletons                                 |

**ABL additions beyond AgenticAI:**

- Decision events as first-class trace entries (no equivalent in AgenticAI)
- Real-time live waterfall in debug panel (AgenticAI is historical only)
- Verbosity-gated event emission (cost control at the source)

## Files Changed

### Runtime (Backend)

| File                                                   | Change                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| `apps/runtime/src/services/execution/decision-log.ts`  | **Delete**                                                    |
| `apps/runtime/src/services/trace-emitter.ts`           | Add `emitDecision()` method                                   |
| `apps/runtime/src/services/execution/trace-helpers.ts` | Add `'decision'` to event lists, decisionKind verbosity check |
| `apps/runtime/src/services/execution/*.ts` (callers)   | Replace `appendDecision` → `traceEmitter.emitDecision`        |
| `apps/runtime/src/types/index.ts`                      | Remove `decisionLog` from session state                       |
| `apps/runtime/src/routes/sessions.ts`                  | Enhance with filters, metrics, progressive loading            |
| `apps/runtime/src/routes/traces.ts`                    | Enhance + new endpoints (detail, generations, export)         |

### Studio (Frontend)

| File                                                         | Change                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `apps/studio/src/components/observatory/SpanTree.tsx`        | Enhance: decisions, cost, tooltips, status icons, copy |
| `apps/studio/src/components/observatory/WaterfallPanel.tsx`  | **New**: shared wrapper                                |
| `apps/studio/src/components/observatory/NodeDetailPanel.tsx` | **New**: right sidebar detail view                     |
| `apps/studio/src/components/observatory/DebugTabs.tsx`       | Replace Decisions tab → Traces tab                     |
| `apps/studio/src/components/session/SessionDetailPage.tsx`   | Add waterfall to right panel                           |
| `apps/studio/src/components/analytics/TracesExplorerTab.tsx` | Replace synthesized tree, add Generations sub-tab      |
| `apps/studio/src/components/analytics/SessionsListPage.tsx`  | Add all columns, filters, export                       |
| `apps/studio/src/components/shared/TimeRangeSelector.tsx`    | **New**                                                |
| `apps/studio/src/components/shared/AdvancedFilterPanel.tsx`  | **New**                                                |
| `apps/studio/src/components/shared/ColumnCustomizer.tsx`     | **New**                                                |
| `apps/studio/src/components/shared/CsvExport.tsx`            | **New**                                                |
| `apps/studio/src/store/observatory-store.ts`                 | Wire existing span methods to WaterfallPanel           |

## Not Changed

- ClickHouse schema (no migration)
- Database models / MongoDB schema
- Auth middleware infrastructure
- BufferedClickHouseWriter configuration
- Other debug tabs (Data, Conversation, Performance, IR)
- Agent-level tracing configuration
