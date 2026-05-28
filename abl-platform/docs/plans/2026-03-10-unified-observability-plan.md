# Unified Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge the decision log into the trace event system and build a unified waterfall UI across all three Studio surfaces (debug panel, sessions, traces explorer) with full AgenticAI feature parity.

**Architecture:** Kill the separate decision-log.ts in-memory system. Decision entries become trace events with `type: 'decision'` flowing through the existing TraceEmitter → WebSocket + ClickHouse pipeline. The Studio UI gets a shared WaterfallPanel/NodeDetailPanel component pair rendered in the debug panel (live), session detail (historical), and traces explorer (search/filter). Shared primitives (TimeRangeSelector, AdvancedFilterPanel, ColumnCustomizer, CsvExport) are built once and reused across all list views.

**Tech Stack:** TypeScript, Express, ClickHouse, React 18, Zustand, Tailwind, Framer Motion, Lucide icons

**Design Doc:** `docs/plans/2026-03-10-unified-observability-design.md`

---

## Phase 1: Runtime — Decision Events as Trace Events

### Task 1: Add decision event types to trace-helpers.ts

**Files:**

- Modify: `apps/runtime/src/services/execution/trace-helpers.ts:11-84`
- Modify: `apps/runtime/src/types/index.ts:61-153`

**Step 1: Add 'decision' to TraceEventType union**

In `apps/runtime/src/types/index.ts`, add `'decision'` to the `TraceEventType` union (around line 61-138). Also add `decisionKind` as optional field on `TraceEvent` interface (around line 140-153):

```typescript
// Add to TraceEventType union
| 'decision'

// Add to TraceEvent interface
decisionKind?: 'field_validation' | 'gather_extraction' | 'flow_transition'
  | 'correction' | 'data_mutation' | 'handoff' | 'delegation'
  | 'constraint_check' | 'escalation' | 'guardrail_check' | 'completion';
```

**Step 2: Add decision verbosity gating to trace-helpers.ts**

In `apps/runtime/src/services/execution/trace-helpers.ts`, add `'decision'` to `EVENT_VERBOSITY` map (line 16-73). The `shouldEmitTrace` function (line 78-84) already uses this map, so no change needed there. Add a new `DECISION_KIND_VERBOSITY` map and `shouldEmitDecision` function:

```typescript
// After EVENT_VERBOSITY map
export const DECISION_KIND_VERBOSITY: Record<string, number> = {
  handoff: VERBOSITY_LEVELS.standard,
  delegation: VERBOSITY_LEVELS.standard,
  flow_transition: VERBOSITY_LEVELS.standard,
  field_validation: VERBOSITY_LEVELS.standard,
  escalation: VERBOSITY_LEVELS.standard,
  completion: VERBOSITY_LEVELS.standard,
  constraint_check: VERBOSITY_LEVELS.standard,
  guardrail_check: VERBOSITY_LEVELS.standard,
  gather_extraction: VERBOSITY_LEVELS.verbose,
  correction: VERBOSITY_LEVELS.verbose,
  data_mutation: VERBOSITY_LEVELS.verbose,
};

export function shouldEmitDecision(decisionKind: string, verbosity: string = 'standard'): boolean {
  const levelRequired = DECISION_KIND_VERBOSITY[decisionKind] ?? VERBOSITY_LEVELS.verbose;
  const currentLevel = VERBOSITY_LEVELS[verbosity as keyof typeof VERBOSITY_LEVELS] ?? 0;
  return currentLevel >= levelRequired;
}
```

Also add `'decision'` to `EVENT_VERBOSITY` at `standard` level (the per-kind check happens in `shouldEmitDecision`):

```typescript
decision: VERBOSITY_LEVELS.standard,
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm test -- --grep "trace-helpers\|trace.helpers\|shouldEmit" --passWithNoTests`
Expected: PASS (existing tests should still pass)

**Step 4: Commit**

```bash
git add apps/runtime/src/types/index.ts apps/runtime/src/services/execution/trace-helpers.ts
git commit -m "feat(runtime): add decision event type and per-kind verbosity gating"
```

---

### Task 2: Add emitDecision to trace-emitter.ts

**Files:**

- Modify: `apps/runtime/src/services/trace-emitter.ts:57-636`

**Step 1: Add emitDecision method**

In `trace-emitter.ts`, add an `emitDecision` method near the existing `logDecision` (line 280-296). The new method creates a proper TraceEvent with spanId/parentSpanId inheritance:

```typescript
function emitDecision(decisionKind: string, metadata: Record<string, unknown>): void {
  if (!shouldEmitDecision(decisionKind, config.verbosity)) return;

  const event: TraceEvent = {
    type: 'decision',
    decisionKind: decisionKind as TraceEvent['decisionKind'],
    timestamp: new Date().toISOString(),
    agentName: currentAgentName,
    spanId: currentSpanId,
    parentSpanId: spanStack.length > 1 ? spanStack[spanStack.length - 2] : undefined,
    data: metadata,
  };

  config.onTraceEvent?.(event);
}
```

Import `shouldEmitDecision` from `./execution/trace-helpers.js` at the top of the file.

Add `emitDecision` to the returned public API object (line 610-636).

**Step 2: Run tests**

Run: `cd apps/runtime && pnpm test -- --grep "trace.emitter\|TraceEmitter" --passWithNoTests`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/services/trace-emitter.ts
git commit -m "feat(runtime): add emitDecision method to trace emitter with span inheritance"
```

---

### Task 3: Migrate callers from appendDecision to emitDecision

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts` (11 call sites)
- Modify: `apps/runtime/src/services/execution/routing-executor.ts` (3 call sites)
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` (1 call site)
- Modify: `apps/runtime/src/services/execution/output-guardrails.ts` (1 call site)
- Modify: `apps/runtime/src/services/execution/constraint-checker.ts` (2 call sites)

**Step 1: Identify trace emitter access pattern**

Each executor receives a trace emitter through the execution context. Check how each file accesses the trace emitter — it may be via `context.traceEmitter`, `session.traceEmitter`, or a parameter. Look at each file's function signatures to find the access pattern.

**Step 2: Migrate flow-step-executor.ts**

Replace all `appendDecision(session, { type: 'X', ... })` calls with `traceEmitter.emitDecision('X', { ... })`. The `type` field from DecisionEntry becomes the first arg (decisionKind). The remaining fields (`outcome`, `matched`, `condition`, etc.) go into the metadata object.

Remove `import { appendDecision, shouldLogDecisions } from './decision-log.js'` — the verbosity check is now inside `emitDecision`.

Example migration (line 133):

```typescript
// Before:
appendDecision(session, { type: 'data_mutation', outcome: 'set', matched: true });
// After:
traceEmitter.emitDecision('data_mutation', { outcome: 'set', matched: true });
```

Example with shouldLogDecisions guard (line 1239):

```typescript
// Before:
if (shouldLogDecisions(session.traceVerbosity)) {
  appendDecision(session, { type: 'gather_extraction', outcome: '...', matched: true });
}
// After (guard is now inside emitDecision):
traceEmitter.emitDecision('gather_extraction', { outcome: '...', matched: true });
```

Apply this pattern to all 11 call sites in flow-step-executor.ts: lines 133, 822, 834, 1240, 1646, 1752, 2810, 2994, 3293, 3785, 3849.

**Step 3: Migrate routing-executor.ts**

Same pattern for 3 call sites: lines 1935, 2350, 3266.
Remove `import { appendDecision, shouldLogDecisions } from './decision-log.js'`.

**Step 4: Migrate reasoning-executor.ts**

1 call site at line 733.
Remove `import { appendDecision } from './decision-log.js'`.

**Step 5: Migrate output-guardrails.ts**

1 call site at line 70.
Remove `import { appendDecision } from './decision-log.js'`.

**Step 6: Migrate constraint-checker.ts**

2 call sites at lines 72 and 163.
Remove `import { appendDecision } from './decision-log.js'`.

**Step 7: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm test`
Expected: PASS. Some tests may reference `decisionLog` on session state — those will be addressed in Task 4.

**Step 8: Commit**

```bash
git add apps/runtime/src/services/execution/
git commit -m "refactor(runtime): migrate all appendDecision callers to traceEmitter.emitDecision"
```

---

### Task 4: Delete decision-log.ts and clean up session state

**Files:**

- Delete: `apps/runtime/src/services/execution/decision-log.ts`
- Modify: `apps/runtime/src/services/execution/types.ts:196-199` (remove decisionLog from RuntimeSession)
- Modify: Any tests that reference `decisionLog` on session state

**Step 1: Delete decision-log.ts**

```bash
rm apps/runtime/src/services/execution/decision-log.ts
```

**Step 2: Remove decisionLog from session types**

In `apps/runtime/src/services/execution/types.ts` (line 199), remove:

```typescript
decisionLog?: DecisionEntry[];
```

Keep the `DecisionEntry` and `DecisionType` type definitions (lines 40-69) — they're still useful as documentation of decision kinds, and the types may be referenced in tests.

**Step 3: Remove decisionLog from session state updates**

Search for any code that reads `session.decisionLog` or sends it over WebSocket. The WebSocket handler (`apps/runtime/src/websocket/handler.ts`) may include `decisionLog` in state updates — remove it.

**Step 4: Update tests**

Search: `grep -r "decisionLog\|decision.log\|appendDecision\|shouldLogDecisions" apps/runtime/src/__tests__/`

Update any test that:

- Asserts `session.decisionLog` has entries → assert trace events with `type: 'decision'` instead
- Mocks `appendDecision` → remove the mock
- Imports from `decision-log.js` → remove the import

**Step 5: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add -A apps/runtime/src/
git commit -m "refactor(runtime): delete decision-log.ts, remove decisionLog from session state"
```

---

### Task 5: Remove decisionLog from Studio session store

**Files:**

- Modify: `apps/studio/src/store/session-store.ts:153-155`
- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx:311-325` (DecisionsTab)
- Modify: `apps/studio/src/components/observatory/DecisionTreeView.tsx`

**Step 1: Remove decisionLog from session-store.ts**

In `apps/studio/src/store/session-store.ts`, remove the `decisionLog` update at line 153-155:

```typescript
// Remove this line:
decisionLog: updates.decisionLog ?? currentState.decisionLog,
```

**Step 2: Update DebugTabs DecisionsTab temporarily**

For now, change the `DecisionsTab` (line 311-325) to show an empty state message: "Decision events now appear in the Traces tab." This is temporary — Task 15 replaces this tab entirely.

**Step 3: Run Studio build**

Run: `cd apps/studio && pnpm build`
Expected: PASS (may have type errors if `decisionLog` is referenced elsewhere — fix any)

**Step 4: Commit**

```bash
git add apps/studio/src/store/session-store.ts apps/studio/src/components/observatory/
git commit -m "refactor(studio): remove decisionLog from session store, prepare for Traces tab"
```

---

## Phase 2: Runtime — API Enhancements

### Task 6: Enhance GET /sessions/:id/traces with filters and metrics

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts:1226-1352`

**Step 1: Add query parameter parsing**

At the top of the `GET /:id/traces` handler (line 1226), parse additional query params:

```typescript
const eventType = req.query.eventType as string | undefined;
const decisionKind = req.query.decisionKind as string | undefined;
const spanId = req.query.spanId as string | undefined;
const includeMetrics = req.query.include === 'metrics';
const limit = parseInt(req.query.limit as string) || 1000;
const offset = parseInt(req.query.offset as string) || 0;
```

**Step 2: Add filtering to ClickHouse queries**

In `queryClickHouseCanonicalTraces` (lines 1411-1498), add WHERE clauses:

```sql
AND (event_type = {eventType:String} OR {eventType:String} = '')
AND (span_id = {spanId:String} OR {spanId:String} = '')
```

Pass the params via `query_params`.

**Step 3: Add metrics aggregation**

When `includeMetrics` is true, run a second query to aggregate per-span metrics:

```sql
SELECT span_id, parent_span_id,
  min(timestamp) as start_time, max(timestamp) as end_time,
  sum(JSONExtractFloat(data, 'tokensIn')) as tokens_in,
  sum(JSONExtractFloat(data, 'tokensOut')) as tokens_out,
  sum(JSONExtractFloat(data, 'cost')) as cost,
  count() as event_count,
  countIf(has_error = 1) as error_count
FROM abl_platform.traces
WHERE session_id = {sessionId:String} AND tenant_id = {tenantId:String}
GROUP BY span_id, parent_span_id
ORDER BY start_time
```

Return as `{ events, spanMetrics }` when metrics included, `{ events }` otherwise.

**Step 4: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm test -- --grep "sessions\|traces" --passWithNoTests`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts
git commit -m "feat(runtime): add filter params and span metrics to session traces endpoint"
```

---

### Task 7: Add GET /sessions/:id/traces/:spanId/children endpoint

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`

**Step 1: Add the route**

After the existing `GET /:id/traces` route, add:

```typescript
router.get('/:id/traces/:spanId/children', async (req, res) => {
  if (!(await requireProjectPermission(req, res, 'session:read'))) return;

  const sessionId = req.params.id;
  const spanId = req.params.spanId;
  const tenantId = req.tenantContext!.tenantId;
  const limit = parseInt(req.query.limit as string) || 200;
  const offset = parseInt(req.query.offset as string) || 0;

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const result = await client.query({
    query: `
      SELECT *
      FROM abl_platform.traces
      WHERE session_id = {sessionId:String}
        AND tenant_id = {tenantId:String}
        AND parent_span_id = {spanId:String}
      ORDER BY timestamp ASC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: { sessionId, tenantId, spanId, limit, offset },
    format: 'JSONEachRow',
  });

  const rows = await result.json();
  res.json({ success: true, data: { events: rows } });
});
```

**Step 2: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm test -- --grep "session" --passWithNoTests`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts
git commit -m "feat(runtime): add progressive loading endpoint for span children"
```

---

### Task 8: Add GET /sessions/:id/metrics endpoint

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`

**Step 1: Add the route**

```typescript
router.get('/:id/metrics', async (req, res) => {
  if (!(await requireProjectPermission(req, res, 'session:read'))) return;

  const sessionId = req.params.id;
  const tenantId = req.tenantContext!.tenantId;

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const result = await client.query({
    query: `
      SELECT
        count() as trace_count,
        sum(JSONExtractFloat(data, 'tokensIn')) as total_tokens_in,
        sum(JSONExtractFloat(data, 'tokensOut')) as total_tokens_out,
        sum(JSONExtractFloat(data, 'cost')) as total_cost,
        min(timestamp) as first_event,
        max(timestamp) as last_event,
        countIf(has_error = 1) as error_count,
        countIf(event_type = 'llm_call') as llm_call_count,
        countIf(event_type = 'tool_call') as tool_call_count,
        countIf(event_type = 'decision') as decision_count
      FROM abl_platform.traces
      WHERE session_id = {sessionId:String}
        AND tenant_id = {tenantId:String}
    `,
    query_params: { sessionId, tenantId },
    format: 'JSONEachRow',
  });

  const rows = await result.json();
  const metrics = rows[0] ?? {};
  const durationMs =
    metrics.first_event && metrics.last_event
      ? new Date(metrics.last_event).getTime() - new Date(metrics.first_event).getTime()
      : 0;

  res.json({
    success: true,
    data: { ...metrics, duration_ms: durationMs },
  });
});
```

**Step 2: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts
git commit -m "feat(runtime): add session metrics endpoint for aggregated cost/tokens/duration"
```

---

### Task 9: Add generations and trace detail endpoints

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts` (or create `apps/runtime/src/routes/traces.ts` if it doesn't exist)

**Step 1: Check if traces route file exists**

Run: `ls apps/runtime/src/routes/traces.ts` — if not, routes go in sessions.ts.

**Step 2: Add GET /generations endpoint**

This is a project-scoped route. Add to the appropriate router:

```typescript
router.get('/generations', async (req, res) => {
  if (!(await requireProjectPermission(req, res, 'session:read'))) return;

  const tenantId = req.tenantContext!.tenantId;
  const projectId = req.params.projectId;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  const from =
    (req.query.from as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = (req.query.to as string) || new Date().toISOString();

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const result = await client.query({
    query: `
      SELECT *
      FROM abl_platform.traces
      WHERE tenant_id = {tenantId:String}
        AND event_type = 'llm_call'
        AND timestamp BETWEEN {from:String} AND {to:String}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: { tenantId, from, to, limit, offset },
    format: 'JSONEachRow',
  });

  const rows = await result.json();

  // Count query for pagination
  const countResult = await client.query({
    query: `
      SELECT count() as total
      FROM abl_platform.traces
      WHERE tenant_id = {tenantId:String}
        AND event_type = 'llm_call'
        AND timestamp BETWEEN {from:String} AND {to:String}
    `,
    query_params: { tenantId, from, to },
    format: 'JSONEachRow',
  });

  const countRows = await countResult.json();
  const total = countRows[0]?.total ?? 0;

  res.json({
    success: true,
    data: {
      generations: rows,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    },
  });
});
```

**Step 3: Add GET /sessions/:id/trace-detail endpoint**

Returns full trace with span tree structure:

```typescript
router.get('/:id/trace-detail', async (req, res) => {
  if (!(await requireProjectPermission(req, res, 'session:read'))) return;

  const sessionId = req.params.id;
  const tenantId = req.tenantContext!.tenantId;

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  // Span summaries
  const spanResult = await client.query({
    query: `
      SELECT span_id, parent_span_id,
        min(timestamp) as start_time, max(timestamp) as end_time,
        sum(JSONExtractFloat(data, 'tokensIn')) as tokens_in,
        sum(JSONExtractFloat(data, 'tokensOut')) as tokens_out,
        sum(JSONExtractFloat(data, 'cost')) as cost,
        count() as event_count,
        countIf(has_error = 1) as error_count,
        any(agent_name) as agent_name,
        groupArray(event_type) as event_types
      FROM abl_platform.traces
      WHERE session_id = {sessionId:String} AND tenant_id = {tenantId:String}
      GROUP BY span_id, parent_span_id
      ORDER BY start_time
    `,
    query_params: { sessionId, tenantId },
    format: 'JSONEachRow',
  });

  const spans = await spanResult.json();

  res.json({
    success: true,
    data: { sessionId, spans },
  });
});
```

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/
git commit -m "feat(runtime): add generations list and trace detail endpoints"
```

---

### Task 10: Add CSV export endpoint

**Files:**

- Modify: `apps/runtime/src/routes/sessions.ts`

**Step 1: Add GET /sessions/export endpoint**

```typescript
router.get('/export', async (req, res) => {
  if (!(await requireProjectPermission(req, res, 'session:read'))) return;
  // Note: In production, gate this behind 'traces:export' permission

  const tenantId = req.tenantContext!.tenantId;
  const projectId = req.params.projectId;
  const sessionId = req.query.sessionId as string | undefined;
  const from =
    (req.query.from as string) || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = (req.query.to as string) || new Date().toISOString();
  const maxRows = 10000;

  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  const client = getClickHouseClient();

  const sessionFilter = sessionId ? `AND session_id = {sessionId:String}` : '';

  const result = await client.query({
    query: `
      SELECT
        session_id, span_id, parent_span_id, event_type, agent_name,
        timestamp, duration_ms, has_error, data
      FROM abl_platform.traces
      WHERE tenant_id = {tenantId:String}
        ${sessionFilter}
        AND timestamp BETWEEN {from:String} AND {to:String}
      ORDER BY timestamp ASC
      LIMIT {maxRows:UInt32}
    `,
    query_params: { tenantId, sessionId: sessionId ?? '', from, to, maxRows },
    format: 'JSONEachRow',
  });

  const rows = await result.json();

  // Build CSV
  const headers = [
    'session_id',
    'span_id',
    'parent_span_id',
    'event_type',
    'agent_name',
    'timestamp',
    'duration_ms',
    'has_error',
  ];
  const csvLines = [headers.join(',')];
  for (const row of rows) {
    csvLines.push(headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }

  const filename = `traces-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvLines.join('\n'));
});
```

**Important:** Place this route BEFORE `/:id` routes to avoid Express treating "export" as a session ID.

**Step 2: Commit**

```bash
git add apps/runtime/src/routes/sessions.ts
git commit -m "feat(runtime): add CSV export endpoint for trace data"
```

---

## Phase 3: Studio — Shared UI Components

### Task 11: Create TimeRangeSelector component

**Files:**

- Create: `apps/studio/src/components/shared/TimeRangeSelector.tsx`

**Step 1: Build the component**

```tsx
'use client';

import { useState, useCallback } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export interface TimeRange {
  from: string;
  to: string;
  preset?: string;
}

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

const PRESETS = [
  { label: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: '90d', ms: 90 * 24 * 60 * 60 * 1000 },
] as const;

export function TimeRangeSelector({ value, onChange, className }: TimeRangeSelectorProps) {
  const [showCustom, setShowCustom] = useState(false);

  const selectPreset = useCallback(
    (preset: (typeof PRESETS)[number]) => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - preset.ms).toISOString();
      onChange({ from, to, preset: preset.label });
      setShowCustom(false);
    },
    [onChange],
  );

  return (
    <div className={clsx('flex items-center gap-1', className)}>
      {PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => selectPreset(p)}
          className={clsx(
            'px-2 py-1 text-xs rounded-md transition-default',
            value.preset === p.label
              ? 'bg-accent/10 text-accent border border-accent/30'
              : 'text-foreground-muted hover:bg-surface-2 border border-transparent',
          )}
        >
          {p.label}
        </button>
      ))}
      <button
        onClick={() => setShowCustom(!showCustom)}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-default',
          !value.preset
            ? 'bg-accent/10 text-accent border border-accent/30'
            : 'text-foreground-muted hover:bg-surface-2 border border-transparent',
        )}
      >
        <Clock className="w-3 h-3" />
        Custom
        <ChevronDown className="w-3 h-3" />
      </button>
      {showCustom && (
        <div className="absolute mt-1 top-full right-0 z-50 p-3 bg-surface-1 border border-border rounded-lg shadow-lg">
          <div className="flex gap-2">
            <label className="text-xs text-foreground-muted">
              From
              <input
                type="datetime-local"
                value={value.from.slice(0, 16)}
                onChange={(e) =>
                  onChange({ from: new Date(e.target.value).toISOString(), to: value.to })
                }
                className="block mt-1 px-2 py-1 bg-surface-2 border border-border rounded text-xs"
              />
            </label>
            <label className="text-xs text-foreground-muted">
              To
              <input
                type="datetime-local"
                value={value.to.slice(0, 16)}
                onChange={(e) =>
                  onChange({ from: value.from, to: new Date(e.target.value).toISOString() })
                }
                className="block mt-1 px-2 py-1 bg-surface-2 border border-border rounded text-xs"
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/shared/TimeRangeSelector.tsx
git commit -m "feat(studio): add TimeRangeSelector with presets and custom date picker"
```

---

### Task 12: Create AdvancedFilterPanel component

**Files:**

- Create: `apps/studio/src/components/shared/AdvancedFilterPanel.tsx`

**Step 1: Build the component**

This is a right-side slideout (720px) with add/remove filter rows. Each row has: column dropdown, operator dropdown, value input. Operators vary by column type (string, number, datetime, multi-select).

```tsx
'use client';

import { useState, useCallback } from 'react';
import { X, Plus, Filter, SlidersHorizontal } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';

export type FilterOperator =
  | '='
  | '!='
  | 'contains'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'any_of'
  | 'none_of';

export interface FilterColumn {
  key: string;
  label: string;
  type: 'string' | 'number' | 'datetime' | 'multi_select';
  options?: { label: string; value: string }[]; // for multi_select
}

export interface FilterRow {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
}

interface AdvancedFilterPanelProps {
  columns: FilterColumn[];
  filters: FilterRow[];
  onChange: (filters: FilterRow[]) => void;
  className?: string;
}

const OPERATORS_BY_TYPE: Record<FilterColumn['type'], { label: string; value: FilterOperator }[]> =
  {
    string: [
      { label: 'equals', value: '=' },
      { label: 'not equals', value: '!=' },
      { label: 'contains', value: 'contains' },
    ],
    number: [
      { label: '=', value: '=' },
      { label: '>', value: '>' },
      { label: '>=', value: '>=' },
      { label: '<', value: '<' },
      { label: '<=', value: '<=' },
    ],
    datetime: [
      { label: 'after', value: '>=' },
      { label: 'before', value: '<=' },
      { label: 'equals', value: '=' },
    ],
    multi_select: [
      { label: 'any of', value: 'any_of' },
      { label: 'none of', value: 'none_of' },
    ],
  };

export function AdvancedFilterPanel({
  columns,
  filters,
  onChange,
  className,
}: AdvancedFilterPanelProps) {
  const [open, setOpen] = useState(false);

  const addFilter = useCallback(() => {
    const id = crypto.randomUUID();
    const firstCol = columns[0];
    onChange([...filters, { id, column: firstCol.key, operator: '=', value: '' }]);
  }, [columns, filters, onChange]);

  const removeFilter = useCallback(
    (id: string) => {
      onChange(filters.filter((f) => f.id !== id));
    },
    [filters, onChange],
  );

  const updateFilter = useCallback(
    (id: string, updates: Partial<FilterRow>) => {
      onChange(filters.map((f) => (f.id === id ? { ...f, ...updates } : f)));
    },
    [filters, onChange],
  );

  const getColumnType = (key: string) => columns.find((c) => c.key === key)?.type ?? 'string';

  const activeCount = filters.filter((f) => f.value).length;

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className={clsx(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-default',
          activeCount > 0
            ? 'border-accent/30 bg-accent/10 text-accent'
            : 'border-border text-foreground-muted hover:bg-surface-2',
          className,
        )}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        Filters
        {activeCount > 0 && (
          <span className="ml-1 px-1.5 py-0.5 bg-accent text-white rounded-full text-[10px] font-medium">
            {activeCount}
          </span>
        )}
      </button>

      {/* Filter tags */}
      {activeCount > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {filters
            .filter((f) => f.value)
            .map((f) => {
              const col = columns.find((c) => c.key === f.column);
              return (
                <span
                  key={f.id}
                  className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-surface-2 border border-border rounded-full"
                >
                  {col?.label} {f.operator} {f.value}
                  <button onClick={() => removeFilter(f.id)} className="hover:text-error">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          <button
            onClick={() => onChange([])}
            className="px-2 py-0.5 text-[11px] text-foreground-muted hover:text-error"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Slideout panel */}
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/20 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-[720px] max-w-full bg-surface-1 border-l border-border z-50 flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Filter className="w-4 h-4" /> Advanced Filters
                </h3>
                <button onClick={() => setOpen(false)} className="p-1 hover:bg-surface-2 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {filters.map((filter) => {
                  const colType = getColumnType(filter.column);
                  const operators = OPERATORS_BY_TYPE[colType];
                  return (
                    <div key={filter.id} className="flex items-start gap-2">
                      <select
                        value={filter.column}
                        onChange={(e) =>
                          updateFilter(filter.id, {
                            column: e.target.value,
                            operator: OPERATORS_BY_TYPE[getColumnType(e.target.value)][0].value,
                            value: '',
                          })
                        }
                        className="flex-1 px-2 py-1.5 text-xs bg-surface-2 border border-border rounded"
                      >
                        {columns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={filter.operator}
                        onChange={(e) =>
                          updateFilter(filter.id, { operator: e.target.value as FilterOperator })
                        }
                        className="w-24 px-2 py-1.5 text-xs bg-surface-2 border border-border rounded"
                      >
                        {operators.map((op) => (
                          <option key={op.value} value={op.value}>
                            {op.label}
                          </option>
                        ))}
                      </select>
                      {colType === 'datetime' ? (
                        <input
                          type="datetime-local"
                          value={filter.value.slice(0, 16)}
                          onChange={(e) =>
                            updateFilter(filter.id, {
                              value: new Date(e.target.value).toISOString(),
                            })
                          }
                          className="flex-1 px-2 py-1.5 text-xs bg-surface-2 border border-border rounded"
                        />
                      ) : (
                        <input
                          type={colType === 'number' ? 'number' : 'text'}
                          value={filter.value}
                          onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                          placeholder="Value..."
                          className="flex-1 px-2 py-1.5 text-xs bg-surface-2 border border-border rounded"
                        />
                      )}
                      <button
                        onClick={() => removeFilter(filter.id)}
                        className="p-1.5 hover:bg-surface-2 rounded text-foreground-muted hover:text-error"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="px-4 py-3 border-t border-border flex justify-between">
                <button
                  onClick={addFilter}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-accent hover:bg-accent/10 rounded"
                >
                  <Plus className="w-3.5 h-3.5" /> Add filter
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="px-4 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90"
                >
                  Apply
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/shared/AdvancedFilterPanel.tsx
git commit -m "feat(studio): add AdvancedFilterPanel with typed operators and slideout"
```

---

### Task 13: Create ColumnCustomizer component

**Files:**

- Create: `apps/studio/src/components/shared/ColumnCustomizer.tsx`

**Step 1: Build the component**

A slideout panel that lets users toggle columns on/off and reorder via drag-and-drop. State persisted to localStorage.

```tsx
'use client';

import { useState, useCallback, useEffect } from 'react';
import { X, Columns, GripVertical, Eye, EyeOff } from 'lucide-react';
import { AnimatePresence, motion, Reorder } from 'framer-motion';
import clsx from 'clsx';

export interface ColumnConfig {
  key: string;
  label: string;
  visible: boolean;
  pinned?: boolean; // pinned columns always visible, can't be toggled
}

interface ColumnCustomizerProps {
  storageKey: string; // localStorage key
  columns: ColumnConfig[];
  onChange: (columns: ColumnConfig[]) => void;
  className?: string;
}

export function useColumnConfig(
  storageKey: string,
  defaultColumns: ColumnConfig[],
): [ColumnConfig[], (cols: ColumnConfig[]) => void] {
  const [columns, setColumns] = useState<ColumnConfig[]>(() => {
    if (typeof window === 'undefined') return defaultColumns;
    const stored = localStorage.getItem(`col-config-${storageKey}`);
    if (!stored) return defaultColumns;
    try {
      const parsed = JSON.parse(stored) as ColumnConfig[];
      // Merge with defaults to pick up new columns
      const storedKeys = new Set(parsed.map((c) => c.key));
      const merged = [...parsed, ...defaultColumns.filter((c) => !storedKeys.has(c.key))];
      return merged;
    } catch {
      return defaultColumns;
    }
  });

  const update = useCallback(
    (cols: ColumnConfig[]) => {
      setColumns(cols);
      localStorage.setItem(`col-config-${storageKey}`, JSON.stringify(cols));
    },
    [storageKey],
  );

  return [columns, update];
}

export function ColumnCustomizer({
  storageKey,
  columns,
  onChange,
  className,
}: ColumnCustomizerProps) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(
    (key: string) => {
      onChange(
        columns.map((c) => (c.key === key && !c.pinned ? { ...c, visible: !c.visible } : c)),
      );
    },
    [columns, onChange],
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={clsx(
          'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border text-foreground-muted hover:bg-surface-2 transition-default',
          className,
        )}
      >
        <Columns className="w-3.5 h-3.5" />
        Columns
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/20 z-40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-80 bg-surface-1 border-l border-border z-50 flex flex-col"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="text-sm font-medium">Customize Columns</h3>
                <button onClick={() => setOpen(false)} className="p-1 hover:bg-surface-2 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <Reorder.Group
                axis="y"
                values={columns}
                onReorder={onChange}
                className="flex-1 overflow-y-auto p-2"
              >
                {columns.map((col) => (
                  <Reorder.Item
                    key={col.key}
                    value={col}
                    className="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-2 cursor-grab active:cursor-grabbing"
                  >
                    <GripVertical className="w-3.5 h-3.5 text-foreground-muted/50" />
                    <button
                      onClick={() => toggle(col.key)}
                      disabled={col.pinned}
                      className={clsx('p-0.5', col.pinned && 'opacity-50 cursor-not-allowed')}
                    >
                      {col.visible ? (
                        <Eye className="w-3.5 h-3.5 text-accent" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5 text-foreground-muted" />
                      )}
                    </button>
                    <span className={clsx('text-xs', !col.visible && 'text-foreground-muted')}>
                      {col.label}
                    </span>
                    {col.pinned && (
                      <span className="ml-auto text-[10px] text-foreground-muted">Pinned</span>
                    )}
                  </Reorder.Item>
                ))}
              </Reorder.Group>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/shared/ColumnCustomizer.tsx
git commit -m "feat(studio): add ColumnCustomizer with drag reorder and localStorage persistence"
```

---

### Task 14: Create CsvExport and SearchInput components

**Files:**

- Create: `apps/studio/src/components/shared/CsvExport.tsx`
- Create: `apps/studio/src/components/shared/SearchInput.tsx`

**Step 1: Build CsvExport**

```tsx
'use client';

import { useState, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import clsx from 'clsx';

interface CsvExportProps {
  onExport: () => Promise<string>; // returns CSV content
  filename: string;
  disabled?: boolean;
  className?: string;
}

export function CsvExport({ onExport, filename, disabled, className }: CsvExportProps) {
  const [loading, setLoading] = useState(false);

  const handleExport = useCallback(async () => {
    setLoading(true);
    try {
      const csv = await onExport();
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setLoading(false);
    }
  }, [onExport, filename]);

  return (
    <button
      onClick={handleExport}
      disabled={disabled || loading}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-border transition-default',
        disabled ? 'opacity-50 cursor-not-allowed' : 'text-foreground-muted hover:bg-surface-2',
        className,
      )}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Download className="w-3.5 h-3.5" />
      )}
      Export
    </button>
  );
}
```

**Step 2: Build SearchInput**

```tsx
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, ToggleLeft, ToggleRight } from 'lucide-react';
import clsx from 'clsx';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  mode?: 'metadata' | 'fulltext';
  onModeChange?: (mode: 'metadata' | 'fulltext') => void;
  placeholder?: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  mode,
  onModeChange,
  placeholder,
  className,
}: SearchInputProps) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const handleChange = useCallback(
    (v: string) => {
      setLocal(v);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(v), 300);
    },
    [onChange],
  );

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground-muted" />
        <input
          type="text"
          value={local}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder ?? 'Search...'}
          className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-2 border border-border rounded-md focus:border-accent/50 focus:outline-none"
        />
      </div>
      {onModeChange && (
        <button
          onClick={() => onModeChange(mode === 'metadata' ? 'fulltext' : 'metadata')}
          className="flex items-center gap-1 px-2 py-1.5 text-[11px] text-foreground-muted hover:bg-surface-2 rounded border border-border"
          title={mode === 'metadata' ? 'Search IDs & Metadata' : 'Search Full Content'}
        >
          {mode === 'fulltext' ? (
            <ToggleRight className="w-3.5 h-3.5 text-accent" />
          ) : (
            <ToggleLeft className="w-3.5 h-3.5" />
          )}
          {mode === 'fulltext' ? 'Full text' : 'Metadata'}
        </button>
      )}
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add apps/studio/src/components/shared/CsvExport.tsx apps/studio/src/components/shared/SearchInput.tsx
git commit -m "feat(studio): add CsvExport and SearchInput shared components"
```

---

## Phase 4: Studio — WaterfallPanel & NodeDetailPanel

### Task 15: Enhance SpanTree.tsx with decisions, cost, status, copy

**Files:**

- Modify: `apps/studio/src/components/observatory/SpanTree.tsx`

**Step 1: Read the current SpanTree implementation**

Read `apps/studio/src/components/observatory/SpanTree.tsx` to understand the exact current structure before modifying.

**Step 2: Add decision event rendering**

In the `SpanNode` component (line 67), add rendering for decision events within a span. Decision events should show:

- Icon based on `decisionKind` (reuse icon mapping from `DecisionTreeView.tsx` lines 64-102)
- Kind badge (e.g., "handoff", "flow_transition")
- Reason text from metadata

**Step 3: Add cost column with color coding**

Add a cost display to each span node. Use the `formatCost` helper from `apps/studio/src/components/analytics/shared.tsx:71`. Color coding:

- Green: < $0.01
- Yellow: $0.01-$0.10
- Red: > $0.10

```tsx
function getCostColor(cost: number): string {
  if (cost < 0.01) return 'text-success';
  if (cost < 0.1) return 'text-warning';
  return 'text-error';
}
```

**Step 4: Add token breakdown tooltip**

On hover over the cost/token area, show a tooltip with input tokens, output tokens, total tokens, input cost, output cost, total cost.

**Step 5: Add status indicators**

Replace or enhance `SpanStatusIcon` (line 147):

- Green `CheckCircle` for completed spans (has end event, no errors)
- Red `XCircle` for errored spans
- Orange `AlertTriangle` for warnings
- `Loader2` (spinning) for in-progress spans

**Step 6: Add copy span ID**

Add a small copy button next to each span ID that copies to clipboard with a checkmark feedback (2s timeout).

**Step 7: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 8: Commit**

```bash
git add apps/studio/src/components/observatory/SpanTree.tsx
git commit -m "feat(studio): enhance SpanTree with decisions, cost, status indicators, copy"
```

---

### Task 16: Create WaterfallPanel.tsx

**Files:**

- Create: `apps/studio/src/components/observatory/WaterfallPanel.tsx`

**Step 1: Build the component**

WaterfallPanel takes events (either from WebSocket stream or ClickHouse query result), builds the span tree, and renders SpanTree with a header showing total cost/tokens/duration.

```tsx
'use client';

import { useMemo, useCallback } from 'react';
import { SpanTree } from './SpanTree';
import { formatCost, formatDuration, formatTokens } from '../analytics/shared';
import clsx from 'clsx';

interface SpanSummary {
  spanId: string;
  parentSpanId?: string;
  agentName?: string;
  startTime: string;
  endTime?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  eventCount: number;
  errorCount: number;
  eventTypes: string[];
}

interface WaterfallPanelProps {
  spans: SpanSummary[];
  events?: any[]; // For live mode
  onSpanSelect?: (spanId: string) => void;
  selectedSpanId?: string;
  mode?: 'live' | 'historical';
  className?: string;
}

export function WaterfallPanel({
  spans,
  events,
  onSpanSelect,
  selectedSpanId,
  mode = 'historical',
  className,
}: WaterfallPanelProps) {
  // Compute totals
  const totals = useMemo(() => {
    let tokensIn = 0,
      tokensOut = 0,
      cost = 0,
      errors = 0;
    for (const s of spans) {
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
      cost += s.cost;
      errors += s.errorCount;
    }
    const duration =
      spans.length > 0
        ? new Date(spans[spans.length - 1].endTime ?? spans[spans.length - 1].startTime).getTime() -
          new Date(spans[0].startTime).getTime()
        : 0;
    return { tokensIn, tokensOut, cost, errors, duration, spanCount: spans.length };
  }, [spans]);

  return (
    <div className={clsx('flex flex-col h-full', className)}>
      {/* Summary bar */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-border text-xs text-foreground-muted">
        <span>{totals.spanCount} spans</span>
        <span>{formatDuration(totals.duration)}</span>
        <span>{formatTokens(totals.tokensIn + totals.tokensOut)} tokens</span>
        <span
          className={
            totals.cost > 0.1 ? 'text-error' : totals.cost > 0.01 ? 'text-warning' : 'text-success'
          }
        >
          {formatCost(totals.cost)}
        </span>
        {totals.errors > 0 && <span className="text-error">{totals.errors} errors</span>}
        {mode === 'live' && (
          <span className="ml-auto flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
            Live
          </span>
        )}
      </div>

      {/* SpanTree */}
      <div className="flex-1 overflow-y-auto">
        <SpanTree />
      </div>
    </div>
  );
}
```

Note: The exact integration with `SpanTree` depends on how `SpanTree` reads data. Currently it reads from `useObservatoryStore.getSpanTree()`. For historical mode, we'll need to either:

- Pass spans as props and have SpanTree accept props OR events
- Or populate the observatory store with historical data before rendering

Read the `SpanTree` and `observatory-store` implementations to determine the best approach.

**Step 2: Commit**

```bash
git add apps/studio/src/components/observatory/WaterfallPanel.tsx
git commit -m "feat(studio): add WaterfallPanel wrapper with summary bar and span tree"
```

---

### Task 17: Create NodeDetailPanel.tsx

**Files:**

- Create: `apps/studio/src/components/observatory/NodeDetailPanel.tsx`

**Step 1: Build the component**

Right sidebar that shows when a span is selected. Has 5 tabs: Preview, Request, Response, Metadata, Logs.

```tsx
'use client';

import { useState, useMemo } from 'react';
import { X, Copy, Check, Clock, Coins, Hash } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { formatCost, formatDuration, formatTokens } from '../analytics/shared';
import clsx from 'clsx';

interface NodeDetail {
  spanId: string;
  type: string;
  agentName?: string;
  decisionKind?: string;
  startTime: string;
  endTime?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  statusMessage?: string;
  hasError?: boolean;
}

interface NodeDetailPanelProps {
  node: NodeDetail | null;
  onClose: () => void;
  className?: string;
}

type DetailTab = 'preview' | 'request' | 'response' | 'metadata' | 'logs';

const ROLE_COLORS: Record<string, string> = {
  user: 'bg-blue-500/10 border-blue-500/20',
  assistant: 'bg-emerald-500/10 border-emerald-500/20',
  system: 'bg-zinc-500/10 border-zinc-500/20',
  tool: 'bg-orange-500/10 border-orange-500/20',
};

export function NodeDetailPanel({ node, onClose, className }: NodeDetailPanelProps) {
  const [tab, setTab] = useState<DetailTab>('preview');
  const [copied, setCopied] = useState(false);

  if (!node) return null;

  const durationMs = node.endTime
    ? new Date(node.endTime).getTime() - new Date(node.startTime).getTime()
    : undefined;

  const isLLMCall = node.type === 'llm_call';
  const isDecision = node.type === 'decision';

  const copyId = () => {
    navigator.clipboard.writeText(node.spanId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'preview', label: 'Preview' },
    { key: 'request', label: 'Request' },
    { key: 'response', label: 'Response' },
    { key: 'metadata', label: 'Metadata' },
    { key: 'logs', label: 'Logs' },
  ];

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className={clsx('flex flex-col h-full bg-surface-1 border-l border-border', className)}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{node.agentName ?? node.type}</span>
          {isDecision && node.decisionKind && (
            <span className="px-1.5 py-0.5 text-[10px] bg-accent/10 text-accent rounded">
              {node.decisionKind}
            </span>
          )}
          <button
            onClick={copyId}
            className="p-0.5 hover:bg-surface-2 rounded"
            title="Copy span ID"
          >
            {copied ? (
              <Check className="w-3 h-3 text-success" />
            ) : (
              <Copy className="w-3 h-3 text-foreground-muted" />
            )}
          </button>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-surface-2 rounded">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Summary metrics */}
      <div
        className={clsx(
          'grid gap-3 px-4 py-3 border-b border-border',
          isLLMCall ? 'grid-cols-4' : 'grid-cols-2',
        )}
      >
        {isLLMCall && (
          <>
            <div>
              <div className="text-[10px] text-foreground-muted uppercase">Cost</div>
              <div className="text-sm font-medium">{formatCost(node.cost ?? 0)}</div>
            </div>
            <div>
              <div className="text-[10px] text-foreground-muted uppercase">Tokens</div>
              <div className="text-sm font-medium">
                {formatTokens((node.tokensIn ?? 0) + (node.tokensOut ?? 0))}
              </div>
            </div>
          </>
        )}
        <div>
          <div className="text-[10px] text-foreground-muted uppercase">Latency</div>
          <div className="text-sm font-medium">
            {durationMs != null ? formatDuration(durationMs) : '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-foreground-muted uppercase">Timestamp</div>
          <div className="text-sm font-medium">{new Date(node.startTime).toLocaleTimeString()}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              'px-3 py-2 text-xs transition-default',
              tab === t.key
                ? 'text-accent border-b-2 border-accent'
                : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'preview' && (
          <PreviewTab
            input={node.input}
            output={node.output}
            isDecision={isDecision}
            metadata={node.metadata}
          />
        )}
        {tab === 'request' && <JsonTab data={node.input} />}
        {tab === 'response' && <JsonTab data={node.output} />}
        {tab === 'metadata' && <JsonTab data={node.metadata} />}
        {tab === 'logs' && (
          <div className="text-xs text-foreground-muted">
            {node.statusMessage ? (
              <pre className="whitespace-pre-wrap">{node.statusMessage}</pre>
            ) : (
              <p>No logs available</p>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function PreviewTab({
  input,
  output,
  isDecision,
  metadata,
}: {
  input: unknown;
  output: unknown;
  isDecision: boolean;
  metadata?: Record<string, unknown>;
}) {
  if (isDecision && metadata) {
    return (
      <div className="space-y-3">
        {metadata.reason && (
          <div>
            <div className="text-[10px] text-foreground-muted uppercase mb-1">Reason</div>
            <p className="text-xs">{String(metadata.reason)}</p>
          </div>
        )}
        {metadata.candidates && (
          <div>
            <div className="text-[10px] text-foreground-muted uppercase mb-1">Candidates</div>
            <ul className="text-xs space-y-1">
              {(metadata.candidates as string[]).map((c, i) => (
                <li
                  key={i}
                  className={clsx(
                    'px-2 py-1 rounded',
                    c === metadata.selected ? 'bg-accent/10 text-accent' : 'bg-surface-2',
                  )}
                >
                  {c} {c === metadata.selected && '(selected)'}
                </li>
              ))}
            </ul>
          </div>
        )}
        {metadata.conditions && (
          <div>
            <div className="text-[10px] text-foreground-muted uppercase mb-1">Conditions</div>
            <JsonTab data={metadata.conditions} />
          </div>
        )}
      </div>
    );
  }

  // Chat message format
  const messages = extractMessages(input);
  const response = extractResponse(output);

  return (
    <div className="space-y-2">
      {messages.map((msg, i) => (
        <div
          key={i}
          className={clsx(
            'px-3 py-2 rounded-lg border text-xs',
            ROLE_COLORS[msg.role] ?? ROLE_COLORS.system,
          )}
        >
          <div className="text-[10px] font-medium uppercase mb-1">{msg.role}</div>
          <div className="whitespace-pre-wrap">{msg.content}</div>
        </div>
      ))}
      {response && (
        <div className={clsx('px-3 py-2 rounded-lg border text-xs', ROLE_COLORS.assistant)}>
          <div className="text-[10px] font-medium uppercase mb-1">assistant</div>
          <div className="whitespace-pre-wrap">{response}</div>
        </div>
      )}
    </div>
  );
}

function JsonTab({ data }: { data: unknown }) {
  if (data == null) return <p className="text-xs text-foreground-muted">No data</p>;
  return (
    <pre className="text-xs whitespace-pre-wrap break-words font-mono text-foreground-muted">
      {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function extractMessages(input: unknown): { role: string; content: string }[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .filter((m) => m.role && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) }));
  }
  if (typeof input === 'object' && input !== null && 'messages' in input) {
    return extractMessages((input as any).messages);
  }
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  return [];
}

function extractResponse(output: unknown): string | null {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    const o = output as any;
    if (o.content) return String(o.content);
    if (o.choices?.[0]?.message?.content) return o.choices[0].message.content;
    if (o.completion) return o.completion;
  }
  return null;
}
```

**Step 2: Commit**

```bash
git add apps/studio/src/components/observatory/NodeDetailPanel.tsx
git commit -m "feat(studio): add NodeDetailPanel with preview/request/response/metadata/logs tabs"
```

---

## Phase 5: Studio — Debug Panel Integration

### Task 18: Replace Decisions tab with Traces tab in DebugTabs

**Files:**

- Modify: `apps/studio/src/components/observatory/DebugTabs.tsx:46-55, 311-325`
- Modify: `apps/studio/src/store/observatory-store.ts:28`

**Step 1: Update DebugTab type**

In `observatory-store.ts` (line 28), change:

```typescript
// Before:
export type DebugTab = 'decisions' | 'data' | 'conversation' | 'performance' | 'ir';
// After:
export type DebugTab = 'traces' | 'data' | 'conversation' | 'performance' | 'ir';
```

**Step 2: Replace DecisionsTab with TracesTab in DebugTabs.tsx**

In `DebugTabs.tsx`, change the tab definition (line 46) from `'decisions'` to `'traces'`, update the label to "Traces".

Replace the `DecisionsTab` component (line 311-325) with a new `TracesTab` that renders `WaterfallPanel` in live mode. The `WaterfallPanel` reads from the observatory store which already accumulates trace events via `addEvent`.

Add a state for `selectedSpanId` and render `NodeDetailPanel` in a right drawer when a span is selected.

```tsx
function TracesTab() {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);

  // WaterfallPanel reads from observatory store automatically
  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-hidden">
        <WaterfallPanel
          spans={[]} // Will be populated from store
          mode="live"
          onSpanSelect={(id) => {
            setSelectedSpanId(id);
            // Load node details from store
          }}
          selectedSpanId={selectedSpanId ?? undefined}
        />
      </div>
      <AnimatePresence>
        {selectedNode && (
          <div className="w-80 flex-shrink-0">
            <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**Step 3: Remove DecisionTreeView import**

Remove the import of `DecisionTreeView` from DebugTabs if it's no longer used.

**Step 4: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/observatory/DebugTabs.tsx apps/studio/src/store/observatory-store.ts
git commit -m "feat(studio): replace Decisions tab with Traces waterfall in debug panel"
```

---

## Phase 6: Studio — Sessions List & Detail

### Task 19: Enhance SessionsExplorerTab with full column set, filters, export

**Files:**

- Modify: `apps/studio/src/components/analytics/SessionsExplorerTab.tsx`

**Step 1: Read current implementation**

Read `apps/studio/src/components/analytics/SessionsExplorerTab.tsx` fully.

**Step 2: Add column configuration**

Import `useColumnConfig` from `shared/ColumnCustomizer`. Define default columns:

```typescript
const DEFAULT_SESSION_COLUMNS: ColumnConfig[] = [
  { key: 'sessionId', label: 'Session ID', visible: true, pinned: true },
  { key: 'environment', label: 'Environment', visible: true },
  { key: 'createdAt', label: 'Created At', visible: true },
  { key: 'traceCount', label: 'Traces', visible: true },
  { key: 'duration', label: 'Duration', visible: true },
  { key: 'tokens', label: 'Tokens', visible: true },
  { key: 'cost', label: 'Cost', visible: true },
  { key: 'userId', label: 'User ID', visible: true },
  { key: 'inputCost', label: 'Input Cost ($)', visible: false },
  { key: 'outputCost', label: 'Output Cost ($)', visible: false },
  { key: 'inputTokens', label: 'Input Tokens', visible: false },
  { key: 'outputTokens', label: 'Output Tokens', visible: false },
  { key: 'source', label: 'Source', visible: false },
  { key: 'channelType', label: 'Channel Type', visible: false },
];
```

**Step 3: Add toolbar with TimeRangeSelector, AdvancedFilterPanel, ColumnCustomizer, CsvExport, SearchInput**

Replace the existing status filter / sort controls with the new shared components. Wire them into the existing `useMemo` filter/sort/paginate chain.

**Step 4: Add cost color coding**

Use `getCostColor()` utility in the Cost column renderer.

**Step 5: Add copy Session ID button**

Add clipboard copy with checkmark feedback to the Session ID column.

**Step 6: Increase page size to 50**

Change `PAGE_SIZE` from 20 to 50.

**Step 7: Add full pagination controls**

Replace existing `<Pagination>` with first/prev/next/last buttons and "1-50 of 500" display. Use existing `Pagination.tsx` component which already supports this.

**Step 8: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 9: Commit**

```bash
git add apps/studio/src/components/analytics/SessionsExplorerTab.tsx
git commit -m "feat(studio): enhance sessions list with full columns, filters, export, search"
```

---

### Task 20: Add waterfall to SessionDetailPage

**Files:**

- Modify: `apps/studio/src/components/session/SessionDetailPage.tsx:137-256`

**Step 1: Read current implementation**

Read `apps/studio/src/components/session/SessionDetailPage.tsx`.

**Step 2: Replace DebugTabs with WaterfallPanel + NodeDetailPanel**

In the right panel (lines 233-251), replace `SessionSummaryPanel` + `DebugTabs` with:

- Top: `SessionSummaryPanel` (keep existing, but enhance header with cost/tokens)
- Bottom: `WaterfallPanel` in historical mode

Add a state for selected node and render `NodeDetailPanel` as a right drawer.

**Step 3: Fetch trace data**

Use `useSessionTraces(sessionId)` hook (or the enhanced `GET /sessions/:id/traces?include=metrics` endpoint) to load span summaries. The `useSessionDetail` hook (line 156) already fetches trace events — extend it to also call the metrics endpoint in parallel.

**Step 4: Wire progressive loading**

When user expands a span in the waterfall, call `GET /sessions/:id/traces/:spanId/children` to load child events.

**Step 5: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/studio/src/components/session/SessionDetailPage.tsx
git commit -m "feat(studio): add traces waterfall with node detail to session detail page"
```

---

## Phase 7: Studio — Traces Explorer

### Task 21: Rebuild TracesExplorerTab with shared components

**Files:**

- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx`

**Step 1: Read current implementation**

Read `apps/studio/src/components/analytics/TracesExplorerTab.tsx` fully (1,276 lines).

**Step 2: Replace synthesized span tree**

Remove the inline `TraceSpanTree` component that synthesizes hierarchy from event types (around line 190 where the comment says "spanId/parentSpanId are not populated by runtime"). Replace with the shared `WaterfallPanel` using real `spanId`/`parentSpanId`.

**Step 3: Add sub-tab navigation**

Add a tab bar at the top: "Traces" | "Generations"

The Traces sub-tab keeps the existing session list (left) + trace detail (right) layout, but replaces the inline span tree with `WaterfallPanel` + `NodeDetailPanel`.

**Step 4: Add toolbar**

Add `TimeRangeSelector`, `AdvancedFilterPanel`, `ColumnCustomizer`, `CsvExport`, `SearchInput` to the toolbar.

Define filter columns for the traces sub-tab:

```typescript
const TRACE_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'trace_id', label: 'Trace ID', type: 'string' },
  { key: 'session_id', label: 'Session ID', type: 'string' },
  {
    key: 'event_type',
    label: 'Event Type',
    type: 'multi_select',
    options: [
      { label: 'LLM Call', value: 'llm_call' },
      { label: 'Tool Call', value: 'tool_call' },
      { label: 'Decision', value: 'decision' },
      { label: 'Handoff', value: 'handoff' },
      { label: 'Agent Enter', value: 'agent_enter' },
    ],
  },
  { key: 'latency', label: 'Latency (ms)', type: 'number' },
  { key: 'cost', label: 'Cost ($)', type: 'number' },
  { key: 'tokens', label: 'Tokens', type: 'number' },
  { key: 'timestamp', label: 'Timestamp', type: 'datetime' },
  { key: 'agent_name', label: 'Agent', type: 'string' },
  {
    key: 'has_error',
    label: 'Has Error',
    type: 'multi_select',
    options: [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ],
  },
];
```

**Step 5: Keep timeline view toggle**

Keep the existing "timeline" vs "span_tree" toggle but rename "span_tree" to "waterfall". The timeline view stays as a flat chronological list.

**Step 6: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 7: Commit**

```bash
git add apps/studio/src/components/analytics/TracesExplorerTab.tsx
git commit -m "feat(studio): rebuild traces explorer with real span tree, filters, and search"
```

---

### Task 22: Add Generations sub-tab to TracesExplorerTab

**Files:**

- Modify: `apps/studio/src/components/analytics/TracesExplorerTab.tsx`

**Step 1: Create GenerationsTab component**

Add a new component within the file (or extract to a separate file if it gets large):

```tsx
function GenerationsTab({ projectId, timeRange }: { projectId: string; timeRange: TimeRange }) {
  // Fetch from GET /api/projects/:projectId/sessions/generations
  // Display in table with columns: Model, Name, Input, Output, Latency, Tokens, Cost, Start Time, Trace ID
  // Use ColumnCustomizer, AdvancedFilterPanel, CsvExport, Pagination
  // Click row → navigate to trace detail with that span pre-selected
}
```

**Step 2: Add SWR hook for generations**

Create a `useGenerations(projectId, timeRange, filters)` hook that calls the generations endpoint.

**Step 3: Add lazy-loaded input/output**

Input and Output columns show a skeleton initially, then load the full content per-row in batches of 5 with 100ms delays between batches. Use `useMemo` + `memo` for cell renderers.

**Step 4: Wire "click generation → trace detail"**

When clicking a generation row, switch to the Traces sub-tab with the parent session selected and the generation's span pre-selected in the NodeDetailPanel.

**Step 5: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/studio/src/components/analytics/TracesExplorerTab.tsx
git commit -m "feat(studio): add Generations sub-tab with lazy-loaded I/O and cost tracking"
```

---

## Phase 8: Skeleton Loaders & Polish

### Task 23: Add skeleton loaders for all new surfaces

**Files:**

- Create: `apps/studio/src/components/shared/Skeletons.tsx`

**Step 1: Build skeleton components**

```tsx
'use client';

import clsx from 'clsx';

function Shimmer({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse bg-surface-2 rounded', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex gap-4 mb-4">
        {Array.from({ length: cols }, (_, i) => (
          <Shimmer key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-4">
          {Array.from({ length: cols }, (_, j) => (
            <Shimmer key={j} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function TreeSkeleton({ depth = 3 }: { depth?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: depth }, (_, i) => (
        <div key={i} style={{ paddingLeft: i * 20 }} className="flex items-center gap-2">
          <Shimmer className="w-4 h-4 rounded-full" />
          <Shimmer className="h-6 flex-1 max-w-[200px]" />
          <Shimmer className="h-4 w-16" />
          <Shimmer className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

export function NodeDetailSkeleton() {
  return (
    <div className="p-4 space-y-4">
      <Shimmer className="h-6 w-48" />
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <Shimmer className="h-3 w-12 mb-1" />
            <Shimmer className="h-5 w-16" />
          </div>
        ))}
      </div>
      <Shimmer className="h-8 w-full" />
      <Shimmer className="h-32 w-full" />
    </div>
  );
}

export function InlineSkeleton({ width = 'w-24' }: { width?: string }) {
  return <Shimmer className={clsx('h-4 inline-block', width)} />;
}
```

**Step 2: Wire skeletons into WaterfallPanel, SessionsExplorerTab, TracesExplorerTab**

Add loading states: show `TableSkeleton` while session/trace lists load, `TreeSkeleton` while span tree loads, `NodeDetailSkeleton` while node details load.

Add `hasInitiallyLoaded` flag to prevent empty state flash.

**Step 3: Add empty states**

Use existing `EmptyState` component (`apps/studio/src/components/ui/EmptyState.tsx`) with appropriate messages:

- Sessions: "No sessions found. Try adjusting your filters or time range."
- Traces: "No traces found. Run a conversation to generate trace data."
- Generations: "No LLM calls found in the selected time range."

**Step 4: Run build**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/shared/Skeletons.tsx apps/studio/src/components/
git commit -m "feat(studio): add skeleton loaders and empty states for all observability surfaces"
```

---

### Task 24: Final integration test and cleanup

**Step 1: Run full runtime test suite**

Run: `cd apps/runtime && pnpm build && pnpm test`
Expected: PASS. Fix any failures.

**Step 2: Run full studio build**

Run: `cd apps/studio && pnpm build`
Expected: PASS. Fix any type errors.

**Step 3: Run prettier on all changed files**

Run: `npx prettier --write apps/runtime/src/services/execution/ apps/runtime/src/types/ apps/runtime/src/routes/sessions.ts apps/runtime/src/services/trace-emitter.ts apps/studio/src/components/observatory/ apps/studio/src/components/shared/ apps/studio/src/components/analytics/ apps/studio/src/components/session/ apps/studio/src/store/observatory-store.ts`

**Step 4: Verify decision events flow end-to-end**

Manual test:

1. Start runtime with `tsx watch src/index.ts`
2. Open Studio, start a debug chat session
3. Send a message that triggers handoff/flow decisions
4. Verify: Traces tab in debug panel shows decision events in the waterfall with correct span hierarchy
5. Verify: Session detail page shows the same trace data from ClickHouse
6. Verify: Traces explorer shows the session with real span tree (not synthesized)

**Step 5: Clean up dead code**

- Delete `DecisionTreeView.tsx` if no longer imported anywhere
- Remove any unused imports from modified files
- Remove the `decisions` WebSocket message handler from Studio if it exists

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore: cleanup dead code and run prettier on all unified observability files"
```

---

## Summary

| Phase | Tasks | Description                                                             |
| ----- | ----- | ----------------------------------------------------------------------- |
| 1     | 1-5   | Runtime: decision events as trace events, delete decision-log.ts        |
| 2     | 6-10  | Runtime: API enhancements (filters, metrics, generations, export)       |
| 3     | 11-14 | Studio: shared components (TimeRange, Filters, Columns, Export, Search) |
| 4     | 15-17 | Studio: WaterfallPanel + NodeDetailPanel                                |
| 5     | 18    | Studio: debug panel Traces tab                                          |
| 6     | 19-20 | Studio: sessions list + detail                                          |
| 7     | 21-22 | Studio: traces explorer + generations                                   |
| 8     | 23-24 | Skeletons, polish, integration test                                     |

**Total: 31 tasks across 11 phases**

Each phase can be committed independently. Phases 1-2 (runtime) should be completed before Phases 5-7 (Studio surfaces), but Phase 3-4 (shared components) can be done in parallel with Phase 2.

---

## Phase 9: Internationalization (i18n)

The codebase uses `next-intl` with translation keys in `packages/i18n/locales/en/studio.json`. All user-facing strings MUST use the `useTranslations()` hook, never hardcoded strings.

### Task 25: Add translation keys for all new observability strings

**Files:**

- Modify: `packages/i18n/locales/en/studio.json`

**Step 1: Add the `observability` namespace**

Add a new top-level key in `studio.json`:

```json
"observability": {
  "traces": "Traces",
  "sessions": "Sessions",
  "generations": "Generations",
  "waterfall": "Waterfall",
  "timeline": "Timeline",

  "tabs": {
    "preview": "Preview",
    "request": "Request",
    "response": "Response",
    "metadata": "Metadata",
    "logs": "Logs"
  },

  "metrics": {
    "cost": "Cost",
    "tokens": "Tokens",
    "latency": "Latency",
    "timestamp": "Timestamp",
    "duration": "Duration",
    "spans": "{count, plural, one {# span} other {# spans}}",
    "errors": "{count, plural, one {# error} other {# errors}}",
    "traceCount": "Traces",
    "inputTokens": "Input Tokens",
    "outputTokens": "Output Tokens",
    "inputCost": "Input Cost",
    "outputCost": "Output Cost",
    "totalCost": "Total Cost",
    "tokensPerSec": "Tokens/sec",
    "timeToFirstToken": "Time to First Token"
  },

  "columns": {
    "sessionId": "Session ID",
    "traceId": "Trace ID",
    "environment": "Environment",
    "createdAt": "Created At",
    "userId": "User ID",
    "source": "Source",
    "channelType": "Channel Type",
    "model": "Model",
    "name": "Name",
    "input": "Input",
    "output": "Output",
    "startTime": "Start Time",
    "endTime": "End Time",
    "level": "Level",
    "agent": "Agent",
    "hasError": "Has Error",
    "eventType": "Event Type"
  },

  "filters": {
    "title": "Advanced Filters",
    "addFilter": "Add filter",
    "apply": "Apply",
    "clearAll": "Clear all",
    "operators": {
      "equals": "equals",
      "notEquals": "not equals",
      "contains": "contains",
      "greaterThan": ">",
      "greaterOrEqual": ">=",
      "lessThan": "<",
      "lessOrEqual": "<=",
      "after": "after",
      "before": "before",
      "anyOf": "any of",
      "noneOf": "none of"
    },
    "valuePlaceholder": "Value..."
  },

  "timeRange": {
    "custom": "Custom",
    "from": "From",
    "to": "To"
  },

  "search": {
    "placeholder": "Search...",
    "metadata": "Metadata",
    "fulltext": "Full text"
  },

  "export": {
    "button": "Export",
    "filename": "traces-{date}.csv"
  },

  "columnCustomizer": {
    "title": "Customize Columns",
    "pinned": "Pinned"
  },

  "emptyStates": {
    "sessions": "No sessions found. Try adjusting your filters or time range.",
    "traces": "No traces found. Run a conversation to generate trace data.",
    "generations": "No LLM calls found in the selected time range.",
    "noLogs": "No logs available",
    "noData": "No data"
  },

  "live": "Live",
  "status": {
    "completed": "Completed",
    "error": "Error",
    "warning": "Warning",
    "running": "Running"
  },

  "decisions": {
    "reason": "Reason",
    "candidates": "Candidates",
    "conditions": "Conditions",
    "selected": "(selected)",
    "kinds": {
      "handoff": "Handoff",
      "delegation": "Delegation",
      "flow_transition": "Flow Transition",
      "field_validation": "Field Validation",
      "gather_extraction": "Gather Extraction",
      "correction": "Correction",
      "data_mutation": "Data Mutation",
      "constraint_check": "Constraint Check",
      "escalation": "Escalation",
      "guardrail_check": "Guardrail Check",
      "completion": "Completion"
    }
  },

  "roles": {
    "user": "user",
    "assistant": "assistant",
    "system": "system",
    "tool": "tool"
  },

  "pagination": {
    "showing": "{from}-{to} of {total}"
  },

  "copyId": "Copy ID",
  "copied": "Copied"
}
```

**Step 2: Commit**

```bash
git add packages/i18n/locales/en/studio.json
git commit -m "feat(i18n): add observability namespace with all trace/session/generation strings"
```

---

### Task 26: Wire translations into all new components

**Files:**

- Modify: All components created in Phases 3-8

**Step 1: Replace hardcoded strings in shared components**

For each component, import `useTranslations` and use namespaced keys:

```tsx
// TimeRangeSelector.tsx
const t = useTranslations('observability.timeRange');
// Label: t('custom'), t('from'), t('to')

// AdvancedFilterPanel.tsx
const t = useTranslations('observability.filters');
// t('title'), t('addFilter'), t('apply'), t('clearAll')
// Operator labels: t(`operators.${op}`)

// ColumnCustomizer.tsx
const t = useTranslations('observability.columnCustomizer');
// t('title'), t('pinned')

// CsvExport.tsx
const t = useTranslations('observability.export');
// t('button')

// SearchInput.tsx
const t = useTranslations('observability.search');
// t('placeholder'), t('metadata'), t('fulltext')
```

**Step 2: Replace hardcoded strings in WaterfallPanel + NodeDetailPanel**

```tsx
// WaterfallPanel.tsx
const t = useTranslations('observability');
// t('live'), t('metrics.spans', { count }), t('metrics.errors', { count })

// NodeDetailPanel.tsx
const t = useTranslations('observability');
// Tab labels: t('tabs.preview'), t('tabs.request'), etc.
// Metric labels: t('metrics.cost'), t('metrics.latency'), etc.
// Decision labels: t(`decisions.kinds.${kind}`), t('decisions.reason'), etc.
// Role labels: t(`roles.${role}`)
// Empty states: t('emptyStates.noLogs'), t('emptyStates.noData')
```

**Step 3: Replace hardcoded strings in list views**

```tsx
// SessionsExplorerTab.tsx
const t = useTranslations('observability');
// Column headers: t(`columns.${key}`)
// Empty state: t('emptyStates.sessions')

// TracesExplorerTab.tsx
const t = useTranslations('observability');
// Sub-tab labels: t('traces'), t('generations')
// Column headers: t(`columns.${key}`)
// View toggle: t('waterfall'), t('timeline')
```

**Step 4: Run build to catch any missing keys**

Run: `cd apps/studio && pnpm build`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/studio/src/components/
git commit -m "feat(i18n): wire useTranslations into all observability components"
```

---

## Phase 10: UI Performance & UX Best Practices

### Task 27: Add memoization, virtualization, and lazy loading

**Files:**

- Modify: All list/table components from Phases 6-7

**Step 1: Memo-wrap expensive cell renderers**

In `SessionsExplorerTab.tsx` and `TracesExplorerTab.tsx`, wrap cell renderer components with `React.memo`:

```tsx
const CostCell = memo(function CostCell({ value }: { value: number }) {
  return <span className={getCostColor(value)}>{formatCost(value)}</span>;
});

const IOCell = memo(function IOCell({
  value,
  loading,
}: {
  value: string | null;
  loading: boolean;
}) {
  if (loading) return <InlineSkeleton width="w-32" />;
  if (!value) return <span className="text-foreground-muted">—</span>;
  return (
    <span className="truncate max-w-[200px]" title={value}>
      {value}
    </span>
  );
});
```

**Step 2: Add virtualization for large lists**

The existing `VirtualList` component (`apps/studio/src/components/shared/VirtualList.tsx`) is already used in `TracesExplorerTab`. Ensure all list views with potentially >100 rows use it:

- Sessions list: Use `VirtualList` when total > 100
- Generations list: Use `VirtualList` always (can be many LLM calls)
- Trace event list (timeline view): Already uses `VirtualList`

**Step 3: Implement lazy I/O loading with batching**

For the Generations sub-tab, implement lazy-loaded input/output per row:

```tsx
function useLazyIO(generations: Generation[]) {
  const [ioMap, setIoMap] = useState<Map<string, { input: string; output: string }>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const cacheRef = useRef<Map<string, { data: any; ts: number }>>(new Map());
  const TTL = 60_000; // 1 minute

  useEffect(() => {
    const visible = generations.filter((g) => !ioMap.has(g.id) && !loading.has(g.id));
    if (visible.length === 0) return;

    // Batch in groups of 5 with 100ms delay
    let cancelled = false;
    (async () => {
      for (let i = 0; i < visible.length; i += 5) {
        if (cancelled) break;
        const batch = visible.slice(i, i + 5);
        setLoading((prev) => {
          const next = new Set(prev);
          batch.forEach((g) => next.add(g.id));
          return next;
        });

        await Promise.all(
          batch.map(async (g) => {
            // Check cache
            const cached = cacheRef.current.get(g.id);
            if (cached && Date.now() - cached.ts < TTL) {
              setIoMap((prev) => new Map(prev).set(g.id, cached.data));
              return;
            }
            // Fetch detail
            const res = await fetch(
              `/api/projects/${g.projectId}/sessions/${g.sessionId}/traces/${g.spanId}/children`,
            );
            const data = await res.json();
            const io = { input: extractInput(data), output: extractOutput(data) };
            cacheRef.current.set(g.id, { data: io, ts: Date.now() });
            setIoMap((prev) => new Map(prev).set(g.id, io));
          }),
        );

        setLoading((prev) => {
          const next = new Set(prev);
          batch.forEach((g) => next.delete(g.id));
          return next;
        });

        if (i + 5 < visible.length) await new Promise((r) => setTimeout(r, 100));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [generations, ioMap, loading]);

  return { ioMap, loading };
}
```

**Step 4: Add `useMemo` for derived data in all list views**

Ensure filter/sort/paginate chains are memoized:

```tsx
const filteredData = useMemo(
  () => applyFilters(data, filters, timeRange),
  [data, filters, timeRange],
);
const sortedData = useMemo(
  () => applySort(filteredData, sortKey, sortDir),
  [filteredData, sortKey, sortDir],
);
const pageData = useMemo(
  () => sortedData.slice(offset, offset + pageSize),
  [sortedData, offset, pageSize],
);
```

**Step 5: Add `useCallback` for event handlers**

Wrap all event handlers passed as props:

```tsx
const handleRowClick = useCallback((id: string) => {
  // navigate
}, []);

const handleSort = useCallback(
  (key: string) => {
    setSortDir((prev) => (sortKey === key && prev === 'asc' ? 'desc' : 'asc'));
    setSortKey(key);
  },
  [sortKey],
);
```

**Step 6: Commit**

```bash
git add apps/studio/src/components/analytics/ apps/studio/src/components/observatory/
git commit -m "perf(studio): add memo, virtualization, lazy I/O batching, useMemo/useCallback"
```

---

### Task 28: UX polish — keyboard navigation, focus management, ARIA

**Files:**

- Modify: All new components

**Step 1: Add keyboard navigation to tables**

Sessions list, traces list, generations list:

- Arrow Up/Down to navigate rows
- Enter to select/expand
- Escape to deselect

```tsx
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(index - 1);
        break;
      case 'Enter':
        handleRowClick(data[index].id);
        break;
      case 'Escape':
        setSelectedId(null);
        break;
    }
  },
  [data, handleRowClick],
);
```

**Step 2: Add ARIA attributes**

```tsx
// Tables
<table role="grid" aria-label={t('sessions')}>
<th role="columnheader" aria-sort={sortKey === key ? sortDir : 'none'}>
<tr role="row" aria-selected={selected} tabIndex={0}>

// Filter panel
<div role="dialog" aria-label={t('filters.title')}>

// Column customizer
<div role="dialog" aria-label={t('columnCustomizer.title')}>

// SpanTree
<ul role="tree" aria-label={t('traces')}>
<li role="treeitem" aria-expanded={expanded} aria-level={depth}>

// Tabs
<div role="tablist">
<button role="tab" aria-selected={active} aria-controls={panelId}>
<div role="tabpanel" id={panelId}>
```

**Step 3: Add focus trap for slideout panels**

When `AdvancedFilterPanel` or `ColumnCustomizer` opens:

- Trap focus within the panel
- Return focus to trigger button on close
- Close on Escape key

```tsx
useEffect(() => {
  if (!open) return;
  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };
  document.addEventListener('keydown', handleEsc);
  return () => document.removeEventListener('keydown', handleEsc);
}, [open]);
```

**Step 4: Add loading announcements for screen readers**

```tsx
<div role="status" aria-live="polite" className="sr-only">
  {loading ? 'Loading sessions...' : `${total} sessions loaded`}
</div>
```

**Step 5: Commit**

```bash
git add apps/studio/src/components/
git commit -m "a11y(studio): add keyboard navigation, ARIA attributes, focus management"
```

---

### Task 29: Visual polish — consistent spacing, transitions, truncation

**Files:**

- Modify: All new components

**Step 1: Ensure consistent spacing**

All components must use the Studio design system spacing:

- Card padding: `px-4 py-3`
- Table cell padding: `px-3 py-2`
- Gap between items: `gap-2` (tight), `gap-4` (standard)
- Border radius: `rounded-md` (buttons), `rounded-lg` (cards/panels)
- Font sizes: `text-xs` (table cells, badges), `text-sm` (headings, primary text)

**Step 2: Ensure all transitions use `transition-default`**

The Studio design system provides `transition-default` utility class. All hover/active states must use it:

```tsx
className = 'transition-default hover:bg-surface-2';
```

Never use raw `transition-colors` or custom durations.

**Step 3: Truncation with tooltips**

Long text in table cells (session IDs, trace IDs, agent names, input/output previews) must:

- Truncate with `truncate max-w-[200px]`
- Show full text on hover via `title` attribute

```tsx
<span className="truncate max-w-[200px]" title={fullValue}>
  {fullValue}
</span>
```

**Step 4: Cost color consistency**

Define cost color utility once and import everywhere:

```tsx
// In shared.tsx or a new observability-utils.ts
export function getCostColor(cost: number): string {
  if (cost < 0.01) return 'text-success';
  if (cost < 0.1) return 'text-warning';
  return 'text-error';
}

export function getCostBgColor(cost: number): string {
  if (cost < 0.01) return 'bg-success/10';
  if (cost < 0.1) return 'bg-warning/10';
  return 'bg-error/10';
}
```

**Step 5: Consistent empty states**

All empty states use the existing `EmptyState` component with:

- Lucide icon matching the context (Activity for traces, BarChart3 for sessions, Cpu for generations)
- Translated message from i18n keys
- Optional action button ("Adjust filters", "Start a conversation")

**Step 6: Commit**

```bash
git add apps/studio/src/components/
git commit -m "ui(studio): visual polish — consistent spacing, transitions, truncation, colors"
```

---

## Phase 11: Test Coverage

### Task 30: Runtime unit tests for decision event emission

**Files:**

- Create: `apps/runtime/src/__tests__/decision-trace-events.test.ts`

**Step 1: Write tests for shouldEmitDecision**

```typescript
import { describe, it, expect } from 'vitest';
import { shouldEmitDecision, DECISION_KIND_VERBOSITY } from '../services/execution/trace-helpers';

describe('shouldEmitDecision', () => {
  describe('standard verbosity', () => {
    it('emits handoff decisions', () => {
      expect(shouldEmitDecision('handoff', 'standard')).toBe(true);
    });
    it('emits delegation decisions', () => {
      expect(shouldEmitDecision('delegation', 'standard')).toBe(true);
    });
    it('emits flow_transition decisions', () => {
      expect(shouldEmitDecision('flow_transition', 'standard')).toBe(true);
    });
    it('emits field_validation decisions', () => {
      expect(shouldEmitDecision('field_validation', 'standard')).toBe(true);
    });
    it('does NOT emit gather_extraction at standard', () => {
      expect(shouldEmitDecision('gather_extraction', 'standard')).toBe(false);
    });
    it('does NOT emit correction at standard', () => {
      expect(shouldEmitDecision('correction', 'standard')).toBe(false);
    });
    it('does NOT emit data_mutation at standard', () => {
      expect(shouldEmitDecision('data_mutation', 'standard')).toBe(false);
    });
  });

  describe('verbose verbosity', () => {
    it('emits all decision kinds', () => {
      for (const kind of Object.keys(DECISION_KIND_VERBOSITY)) {
        expect(shouldEmitDecision(kind, 'verbose')).toBe(true);
      }
    });
  });

  describe('minimal verbosity', () => {
    it('emits nothing', () => {
      for (const kind of Object.keys(DECISION_KIND_VERBOSITY)) {
        expect(shouldEmitDecision(kind, 'minimal')).toBe(false);
      }
    });
  });

  it('defaults unknown kinds to verbose', () => {
    expect(shouldEmitDecision('unknown_kind', 'standard')).toBe(false);
    expect(shouldEmitDecision('unknown_kind', 'verbose')).toBe(true);
  });
});
```

**Step 2: Write tests for emitDecision on trace emitter**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTraceEmitter } from '../services/trace-emitter';

describe('TraceEmitter.emitDecision', () => {
  it('emits decision event with correct type and decisionKind', () => {
    const onTraceEvent = vi.fn();
    const emitter = createTraceEmitter({
      onTraceEvent,
      verbosity: 'standard',
    });

    emitter.emitDecision('handoff', { outcome: 'agent_b', matched: true });

    expect(onTraceEvent).toHaveBeenCalledOnce();
    const event = onTraceEvent.mock.calls[0][0];
    expect(event.type).toBe('decision');
    expect(event.decisionKind).toBe('handoff');
    expect(event.data.outcome).toBe('agent_b');
  });

  it('inherits spanId from current span stack', () => {
    const onTraceEvent = vi.fn();
    const emitter = createTraceEmitter({
      onTraceEvent,
      verbosity: 'verbose',
    });

    emitter.enterAgent('test_agent');
    emitter.emitDecision('flow_transition', { outcome: 'step_2' });

    const event = onTraceEvent.mock.calls.find((c) => c[0].type === 'decision')?.[0];
    expect(event.spanId).toBeDefined();
    expect(event.agentName).toBe('test_agent');
  });

  it('does not emit when verbosity gates it', () => {
    const onTraceEvent = vi.fn();
    const emitter = createTraceEmitter({
      onTraceEvent,
      verbosity: 'standard',
    });

    emitter.emitDecision('data_mutation', { outcome: 'set' });

    const decisionEvents = onTraceEvent.mock.calls.filter((c) => c[0].type === 'decision');
    expect(decisionEvents).toHaveLength(0);
  });

  it('emits all decision kinds at verbose', () => {
    const onTraceEvent = vi.fn();
    const emitter = createTraceEmitter({
      onTraceEvent,
      verbosity: 'verbose',
    });

    emitter.emitDecision('data_mutation', { outcome: 'set' });
    emitter.emitDecision('correction', { outcome: 'fix' });
    emitter.emitDecision('gather_extraction', { outcome: 'fields' });

    const decisionEvents = onTraceEvent.mock.calls.filter((c) => c[0].type === 'decision');
    expect(decisionEvents).toHaveLength(3);
  });
});
```

**Step 3: Run tests**

Run: `cd apps/runtime && pnpm build && pnpm test -- --grep "decision-trace\|emitDecision\|shouldEmitDecision"`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/decision-trace-events.test.ts
git commit -m "test(runtime): add unit tests for decision event emission and verbosity gating"
```

---

### Task 31: Studio component tests

**Files:**

- Create: `apps/studio/src/__tests__/time-range-selector.test.tsx`
- Create: `apps/studio/src/__tests__/advanced-filter-panel.test.tsx`
- Create: `apps/studio/src/__tests__/column-customizer.test.tsx`
- Create: `apps/studio/src/__tests__/waterfall-panel.test.tsx`
- Create: `apps/studio/src/__tests__/node-detail-panel.test.tsx`

**Step 1: TimeRangeSelector tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimeRangeSelector } from '../components/shared/TimeRangeSelector';

describe('TimeRangeSelector', () => {
  const defaultRange = {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    preset: '24h',
  };

  it('renders all preset buttons', () => {
    render(<TimeRangeSelector value={defaultRange} onChange={vi.fn()} />);
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
    expect(screen.getByText('90d')).toBeInTheDocument();
  });

  it('highlights active preset', () => {
    render(<TimeRangeSelector value={defaultRange} onChange={vi.fn()} />);
    const btn = screen.getByText('24h');
    expect(btn.className).toContain('bg-accent');
  });

  it('calls onChange with correct range when preset clicked', () => {
    const onChange = vi.fn();
    render(<TimeRangeSelector value={defaultRange} onChange={onChange} />);
    fireEvent.click(screen.getByText('7d'));
    expect(onChange).toHaveBeenCalledOnce();
    const range = onChange.mock.calls[0][0];
    expect(range.preset).toBe('7d');
    expect(new Date(range.from).getTime()).toBeGreaterThan(0);
  });

  it('shows custom date picker when Custom clicked', () => {
    render(<TimeRangeSelector value={defaultRange} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Custom'));
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });
});
```

**Step 2: AdvancedFilterPanel tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdvancedFilterPanel } from '../components/shared/AdvancedFilterPanel';

const columns = [
  { key: 'name', label: 'Name', type: 'string' as const },
  { key: 'cost', label: 'Cost', type: 'number' as const },
  { key: 'created', label: 'Created', type: 'datetime' as const },
];

describe('AdvancedFilterPanel', () => {
  it('shows filter count badge when filters active', () => {
    render(
      <AdvancedFilterPanel
        columns={columns}
        filters={[{ id: '1', column: 'name', operator: '=', value: 'test' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows filter tags for active filters', () => {
    render(
      <AdvancedFilterPanel
        columns={columns}
        filters={[{ id: '1', column: 'name', operator: '=', value: 'test' }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Name = test/)).toBeInTheDocument();
  });

  it('calls onChange when clear all clicked', () => {
    const onChange = vi.fn();
    render(
      <AdvancedFilterPanel
        columns={columns}
        filters={[{ id: '1', column: 'name', operator: '=', value: 'test' }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Clear all'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('opens slideout panel on Filters button click', () => {
    render(<AdvancedFilterPanel columns={columns} filters={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Filters'));
    expect(screen.getByText('Advanced Filters')).toBeInTheDocument();
  });
});
```

**Step 3: NodeDetailPanel tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeDetailPanel } from '../components/observatory/NodeDetailPanel';

describe('NodeDetailPanel', () => {
  const llmNode = {
    spanId: 'span-123',
    type: 'llm_call',
    agentName: 'test_agent',
    startTime: '2026-03-10T10:00:00Z',
    endTime: '2026-03-10T10:00:02Z',
    tokensIn: 100,
    tokensOut: 200,
    cost: 0.003,
    input: [{ role: 'user', content: 'Hello' }],
    output: { content: 'Hi there!' },
    metadata: { model: 'gpt-4' },
  };

  const decisionNode = {
    spanId: 'span-456',
    type: 'decision',
    decisionKind: 'handoff',
    agentName: 'router',
    startTime: '2026-03-10T10:00:01Z',
    metadata: {
      reason: 'User asked about billing',
      candidates: ['billing_agent', 'support_agent'],
      selected: 'billing_agent',
    },
  };

  it('renders LLM call with 4-column metrics', () => {
    render(<NodeDetailPanel node={llmNode} onClose={vi.fn()} />);
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Latency')).toBeInTheDocument();
    expect(screen.getByText('Timestamp')).toBeInTheDocument();
  });

  it('renders decision with kind badge', () => {
    render(<NodeDetailPanel node={decisionNode} onClose={vi.fn()} />);
    expect(screen.getByText('handoff')).toBeInTheDocument();
  });

  it('shows candidates list for decision events', () => {
    render(<NodeDetailPanel node={decisionNode} onClose={vi.fn()} />);
    // Preview tab is default
    expect(screen.getByText('billing_agent (selected)')).toBeInTheDocument();
    expect(screen.getByText('support_agent')).toBeInTheDocument();
  });

  it('renders chat bubbles in preview for LLM calls', () => {
    render(<NodeDetailPanel node={llmNode} onClose={vi.fn()} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('switches tabs correctly', () => {
    render(<NodeDetailPanel node={llmNode} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Metadata'));
    expect(screen.getByText(/"model": "gpt-4"/)).toBeInTheDocument();
  });

  it('copies span ID to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<NodeDetailPanel node={llmNode} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Copy span ID'));
    expect(writeText).toHaveBeenCalledWith('span-123');
  });

  it('calls onClose when X clicked', () => {
    const onClose = vi.fn();
    render(<NodeDetailPanel node={llmNode} onClose={onClose} />);
    const closeButtons = screen.getAllByRole('button');
    const xButton = closeButtons.find((b) => b.querySelector('.lucide-x'));
    if (xButton) fireEvent.click(xButton);
    expect(onClose).toHaveBeenCalled();
  });

  it('returns null when node is null', () => {
    const { container } = render(<NodeDetailPanel node={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
```

**Step 4: WaterfallPanel tests**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WaterfallPanel } from '../components/observatory/WaterfallPanel';

describe('WaterfallPanel', () => {
  const spans = [
    {
      spanId: 's1',
      parentSpanId: undefined,
      agentName: 'root',
      startTime: '2026-03-10T10:00:00Z',
      endTime: '2026-03-10T10:00:05Z',
      tokensIn: 100,
      tokensOut: 200,
      cost: 0.005,
      eventCount: 10,
      errorCount: 0,
      eventTypes: ['agent_enter', 'llm_call'],
    },
    {
      spanId: 's2',
      parentSpanId: 's1',
      agentName: 'child',
      startTime: '2026-03-10T10:00:01Z',
      endTime: '2026-03-10T10:00:03Z',
      tokensIn: 50,
      tokensOut: 100,
      cost: 0.002,
      eventCount: 5,
      errorCount: 1,
      eventTypes: ['tool_call'],
    },
  ];

  it('renders summary bar with totals', () => {
    render(<WaterfallPanel spans={spans} />);
    expect(screen.getByText('2 spans')).toBeInTheDocument();
  });

  it('shows error count when errors exist', () => {
    render(<WaterfallPanel spans={spans} />);
    expect(screen.getByText('1 errors')).toBeInTheDocument();
  });

  it('shows live indicator in live mode', () => {
    render(<WaterfallPanel spans={spans} mode="live" />);
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('does not show live indicator in historical mode', () => {
    render(<WaterfallPanel spans={spans} mode="historical" />);
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });
});
```

**Step 5: ColumnCustomizer tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ColumnCustomizer } from '../components/shared/ColumnCustomizer';

describe('ColumnCustomizer', () => {
  const columns = [
    { key: 'id', label: 'ID', visible: true, pinned: true },
    { key: 'name', label: 'Name', visible: true },
    { key: 'cost', label: 'Cost', visible: false },
  ];

  it('opens slideout on click', () => {
    render(<ColumnCustomizer storageKey="test" columns={columns} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Columns'));
    expect(screen.getByText('Customize Columns')).toBeInTheDocument();
  });

  it('shows pinned label for pinned columns', () => {
    render(<ColumnCustomizer storageKey="test" columns={columns} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Columns'));
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('lists all columns', () => {
    render(<ColumnCustomizer storageKey="test" columns={columns} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Columns'));
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
  });
});
```

**Step 6: Run all Studio tests**

Run: `cd apps/studio && pnpm test`
Expected: PASS

**Step 7: Check coverage**

Run: `cd apps/studio && pnpm test -- --coverage`

Target coverage for new components:

- `components/shared/TimeRangeSelector.tsx` — 80%+
- `components/shared/AdvancedFilterPanel.tsx` — 70%+ (slideout interactions hard to test fully)
- `components/shared/ColumnCustomizer.tsx` — 70%+
- `components/shared/CsvExport.tsx` — 80%+
- `components/observatory/WaterfallPanel.tsx` — 70%+
- `components/observatory/NodeDetailPanel.tsx` — 80%+

**Step 8: Commit**

```bash
git add apps/studio/src/__tests__/
git commit -m "test(studio): add component tests for all observability shared and observatory components"
```

---

## Updated Summary

| Phase | Tasks | Description                                                                |
| ----- | ----- | -------------------------------------------------------------------------- |
| 1     | 1-5   | Runtime: decision events as trace events, delete decision-log.ts           |
| 2     | 6-10  | Runtime: API enhancements (filters, metrics, generations, export)          |
| 3     | 11-14 | Studio: shared components (TimeRange, Filters, Columns, Export, Search)    |
| 4     | 15-17 | Studio: WaterfallPanel + NodeDetailPanel                                   |
| 5     | 18    | Studio: debug panel Traces tab                                             |
| 6     | 19-20 | Studio: sessions list + detail                                             |
| 7     | 21-22 | Studio: traces explorer + generations                                      |
| 8     | 23-24 | Skeletons, polish, integration test                                        |
| 9     | 25-26 | i18n: translation keys + wire into all components                          |
| 10    | 27-29 | UI perf (memo, virtualization, lazy loading) + UX (a11y, keyboard, polish) |
| 11    | 30-31 | Test coverage: runtime unit tests + Studio component tests                 |

**Total: 31 tasks across 11 phases**
