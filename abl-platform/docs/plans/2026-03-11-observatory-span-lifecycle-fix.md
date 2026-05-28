# Observatory Span Lifecycle Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 architectural bugs in the Observatory span lifecycle that cause spinning loaders, flat hierarchy, duplicate spans, wrong timestamps, and bare "decision" labels.

**Architecture:** The root cause is `observatory-store.ts` `addEvent()` which (a) auto-creates duplicate spans, (b) never ends them, (c) uses `new Date()` instead of event timestamps, and (d) matches spans by stack position instead of agent name. Fix the store first, then fix the post-replay sweep, then fix the SpanTree inline rendering to use the existing `DecisionCard` component.

**Tech Stack:** TypeScript, React, Zustand, Vitest

**IMPORTANT:** Run `npx prettier --write <files>` on ALL changed files before finishing each task. lint-staged WILL silently revert your work if files aren't formatted. BEFORE using any existing component/function/type, READ its source file to verify the actual signature. Never guess prop names or parameter types.

**Context:** The trace-event-consolidation plan (Phases 1-4) is already implemented. This plan fixes span lifecycle bugs discovered during manual testing AFTER consolidation was completed. All consolidation infrastructure (`normalizeEventType()`, `DecisionCard`, `DECISION_KIND_META`, platform_events schema, trace-bridge deletion) is already in place.

---

## Task 1: Fix `startSpan()` to accept a timestamp parameter

The `startSpan()` action uses `new Date()` for `startTime` (line 625). For historical sessions replayed from ClickHouse, this makes every span appear to start at replay time, not at the actual event time. Duration calculations become meaningless.

**Files:**

- Modify: `apps/studio/src/store/observatory-store.ts:142-149` (interface) and `615-639` (implementation)

**Step 1: Read the current `startSpan` signature and `endSpan`**

Read `apps/studio/src/store/observatory-store.ts` lines 140-160 (interface) and 614-656 (implementation).

**Step 2: Add optional `timestamp` parameter to `startSpan` interface**

In the `ObservatoryStore` interface (around line 142), change:

```typescript
// Before:
startSpan: (
  spanId: string,
  name: string,
  traceId: string,
  sessionId: string,
  agentName: string,
  parentSpanId?: string,
) => void;

// After:
startSpan: (
  spanId: string,
  name: string,
  traceId: string,
  sessionId: string,
  agentName: string,
  parentSpanId?: string,
  timestamp?: Date,
) => void;
```

**Step 3: Use `timestamp` parameter in implementation**

In the `startSpan` implementation (around line 615), change:

```typescript
// Before:
startSpan: (spanId, name, traceId, sessionId, agentName, parentSpanId) => {
  set((state) => {
    const newSpans = boundedMapSet(
      state.spans,
      spanId,
      {
        spanId,
        traceId,
        parentSpanId,
        name,
        startTime: new Date(),
        // ...

// After:
startSpan: (spanId, name, traceId, sessionId, agentName, parentSpanId, timestamp) => {
  set((state) => {
    const newSpans = boundedMapSet(
      state.spans,
      spanId,
      {
        spanId,
        traceId,
        parentSpanId,
        name,
        startTime: timestamp ?? new Date(),
        // ...
```

**Step 4: Do the same for `endSpan` — accept optional timestamp**

In the interface (around line 150):

```typescript
// Before:
endSpan: (spanId: string, status?: 'completed' | 'error') => void;

// After:
endSpan: (spanId: string, status?: 'completed' | 'error', timestamp?: Date) => void;
```

In the implementation (around line 641):

```typescript
// Before:
endSpan: (spanId, status = 'completed') => {
  set((state) => {
    const newSpans = new Map(state.spans);
    const span = newSpans.get(spanId);
    if (span) {
      span.endTime = new Date();

// After:
endSpan: (spanId, status = 'completed', timestamp?) => {
  set((state) => {
    const newSpans = new Map(state.spans);
    const span = newSpans.get(spanId);
    if (span) {
      span.endTime = timestamp ?? new Date();
```

**Step 5: Format and build**

```bash
npx prettier --write apps/studio/src/store/observatory-store.ts
pnpm build --filter=@agent-platform/studio
```

**Step 6: Commit**

```
[ABLP-2] fix(studio): add timestamp parameter to startSpan/endSpan for historical replay
```

---

## Task 2: Rewrite `addEvent()` span lifecycle — remove auto-spans, fix matching

This is the core fix. The current `addEvent()` has 3 bugs:

1. **Line 348**: Auto-creates `span-${agentName}-${sessionId}` for every agent — never ended → spinner forever
2. **Line 361**: `agent_enter` creates a SECOND span → duplicates in tree
3. **Line 374**: `agent_exit` ends `getActiveSpan()` (top of stack) — doesn't match by agent name

**Files:**

- Modify: `apps/studio/src/store/observatory-store.ts:330-591`

**Step 1: Read the full `addEvent` method**

Read `apps/studio/src/store/observatory-store.ts` lines 284-591 to understand all the event type branches.

**Step 2: Remove the auto-span creation block (lines 347-358)**

Delete this entire block:

```typescript
// DELETE these lines (347-358):
// Auto-create span for this agent if none exists
const agentSpanId = `span-${agentName}-${event.sessionId}`;
if (!spans.has(agentSpanId) && agentName !== 'unknown') {
  get().startSpan(
    agentSpanId,
    agentName,
    event.traceId,
    event.sessionId,
    agentName,
    event.parentSpanId,
  );
}
```

**Step 3: Fix `agent_enter` to pass event timestamp**

Replace the `agent_enter` handler (lines 360-371):

```typescript
// Before:
if (event.type === 'agent_enter') {
  get().startSpan(
    event.spanId,
    `${event.agentName}`,
    event.traceId,
    event.sessionId,
    event.agentName,
    event.parentSpanId,
  );
  get().updateFlowNode(agentName, { status: 'active', enteredAt: event.timestamp });
}

// After:
if (event.type === 'agent_enter') {
  get().startSpan(
    event.spanId,
    event.agentName,
    event.traceId,
    event.sessionId,
    event.agentName,
    event.parentSpanId,
    event.timestamp,
  );
  get().updateFlowNode(agentName, { status: 'active', enteredAt: event.timestamp });
}
```

**Step 4: Fix `agent_exit` to find span by agent name, pass timestamp**

Replace the `agent_exit` handler (lines 373-383):

```typescript
// Before:
if (event.type === 'agent_exit') {
  const activeSpan = get().getActiveSpan();
  if (activeSpan) {
    get().endSpan(activeSpan.spanId, event.data.result === 'error' ? 'error' : 'completed');
  }
  get().updateFlowNode(event.agentName, {
    status: event.data.result === 'error' ? 'error' : 'completed',
    exitedAt: event.timestamp,
  });
}

// After:
if (event.type === 'agent_exit') {
  const { spans: currentSpans } = get();
  const status = event.data.result === 'error' ? ('error' as const) : ('completed' as const);

  // Strategy: direct spanId match first (live sessions), LIFO fallback (replay/re-entrant).
  // The runtime emits agent_exit with the SAME spanId as the matching agent_enter.
  // For historical replay, spanId may be synthetic ('span-' + event.id), so LIFO fallback
  // finds the LAST running span for this agent (correct for nested/re-entrant agents).
  if (currentSpans.has(event.spanId) && currentSpans.get(event.spanId)!.status === 'running') {
    get().endSpan(event.spanId, status, event.timestamp);
  } else {
    // LIFO fallback: find LAST running span for this agent (not first — handles re-entrancy)
    let lastMatch: string | undefined;
    for (const [sid, s] of currentSpans) {
      if (s.agentName === event.agentName && s.status === 'running') lastMatch = sid;
    }
    if (lastMatch) {
      get().endSpan(lastMatch, status, event.timestamp);
    }
  }

  get().updateFlowNode(event.agentName, {
    status,
    exitedAt: event.timestamp,
  });
}
```

**Step 5: Fix `flow_step_enter` parentSpanId and timestamp**

**CRITICAL:** The `parentSpanId` for a flow step must be the running agent's span, NOT `event.spanId` (which is the per-event ID set by replay as `eventData.spanId || 'span-' + event.id`). We must scan `currentSpans` for a running span matching this agent.

In the `flow_step_enter` handler (around line 461):

```typescript
// Before:
get().startSpan(
  stepSpanId,
  `Step: ${stepName}`,
  event.traceId,
  event.sessionId,
  agentName,
  event.spanId || agentSpanId,
);

// After — scan for running agent span to use as parent:
const { spans: currentSpans } = get();
let agentParentSpanId: string | undefined;
for (const [sid, s] of currentSpans) {
  if (s.agentName === agentName && s.status === 'running') {
    agentParentSpanId = sid;
    break;
  }
}
get().startSpan(
  stepSpanId,
  `Step: ${stepName}`,
  event.traceId,
  event.sessionId,
  agentName,
  agentParentSpanId,
  event.timestamp,
);
```

**Step 6: Fix `flow_step_exit` to pass timestamp to endSpan**

In the `flow_step_exit` handler (around line 533):

```typescript
// Before:
get().endSpan(activeSpan.spanId, result === 'error' ? 'error' : 'completed');

// After:
get().endSpan(activeSpan.spanId, result === 'error' ? 'error' : 'completed', event.timestamp);
```

**Step 7: Fix event-to-span attachment — find span by agent name instead of deleted agentSpanId**

Replace the event-to-span attachment block at the end of `addEvent` (around lines 581-590):

```typescript
// Before:
// Add event to the agent's span
if (spans.has(agentSpanId)) {
  get().addEventToSpan(agentSpanId, event);
} else {
  // Fallback to active span
  const activeSpan = get().getActiveSpan();
  if (activeSpan) {
    get().addEventToSpan(activeSpan.spanId, event);
  }
}

// After:
// Add event to the matching running span for this agent
const { spans: latestSpans } = get();
let attachedToSpan = false;
for (const [sid, s] of latestSpans) {
  if (s.agentName === agentName && s.status === 'running') {
    get().addEventToSpan(sid, event);
    attachedToSpan = true;
    break;
  }
}
if (!attachedToSpan) {
  // Fallback: if no running span for this agent, create one on-the-fly
  // This handles events that arrive before agent_enter (e.g. session_created)
  if (agentName !== 'unknown') {
    const fallbackSpanId = `span-${agentName}-${event.sessionId}`;
    if (!latestSpans.has(fallbackSpanId)) {
      get().startSpan(
        fallbackSpanId,
        agentName,
        event.traceId,
        event.sessionId,
        agentName,
        undefined,
        event.timestamp,
      );
    }
    get().addEventToSpan(fallbackSpanId, event);
  }
}
```

**Step 8: Format and build**

```bash
npx prettier --write apps/studio/src/store/observatory-store.ts
pnpm build --filter=@agent-platform/studio
```

**Step 9: Commit**

```
[ABLP-2] fix(studio): rewrite addEvent span lifecycle — remove auto-spans, fix matching by agent name
```

---

## Task 3: Add post-replay span sweep in `replay-trace-events.ts`

For historical sessions, all events are replayed from ClickHouse. After replay, some spans may still be in "running" state because:

- No `agent_exit` was emitted (e.g., session was abandoned)
- Fallback spans were created for orphaned events

These need to be marked as `completed` after replay finishes, otherwise the UI shows spinners on historical sessions.

**Files:**

- Modify: `apps/studio/src/utils/replay-trace-events.ts:116-175`

**Step 1: Read the current replay function**

Read `apps/studio/src/utils/replay-trace-events.ts` fully.

**Step 2: Add post-replay span sweep after the event replay loop**

After the `for (const event of sorted)` loop (around line 160) and before the `sessionStartTime` override (line 167), add:

**CRITICAL:** Do NOT use the `obs` variable captured before the replay loop. Zustand's `set()` replaces state — `obs.spans` would be stale (still the empty pre-replay Map). Always call `useObservatoryStore.getState()` fresh after the loop.

```typescript
// ── Post-replay sweep: close all still-running spans ──
// Historical sessions are complete — no span should remain "running".
// IMPORTANT: Must get fresh state — obs.spans captured before the loop is stale.
const postReplayState = useObservatoryStore.getState();
const postReplaySpans = postReplayState.spans;
if (postReplaySpans instanceof Map) {
  // Use the last event's timestamp as the end time
  const lastTimestamp =
    sorted.length > 0 ? new Date(sorted[sorted.length - 1].timestamp) : new Date();
  for (const [spanId, span] of postReplaySpans) {
    if (span.status === 'running') {
      postReplayState.endSpan(spanId, 'completed', lastTimestamp);
    }
  }
}
```

Note: We call `useObservatoryStore.getState()` again (not `obs`) because Zustand's `set()` during the replay loop replaced the state object. The `endSpan` action now accepts a third `timestamp` parameter (from Task 1).

**Step 3: Format and build**

```bash
npx prettier --write apps/studio/src/utils/replay-trace-events.ts
pnpm build --filter=@agent-platform/studio
```

**Step 4: Commit**

```
[ABLP-2] fix(studio): sweep running spans after historical replay to stop spinners
```

---

## Task 4: Update `SpanTree.tsx` DecisionBadge to use `DECISION_KIND_META`

The current `DecisionBadge` (lines 363-376) always shows a purple GitBranch icon and the raw kind string. It should use kind-specific icons and colors from `DECISION_KIND_META` (already exists in `event-types.ts`).

**Files:**

- Modify: `apps/studio/src/components/observatory/SpanTree.tsx:363-376` (DecisionBadge)
- Modify: `apps/studio/src/components/observatory/SpanTree.tsx:474-507` (SpanDetails decision list)

**Step 1: Read the existing DecisionBadge and SpanDetails**

Read `apps/studio/src/components/observatory/SpanTree.tsx` lines 360-510.

**Step 2: Read the DecisionCard component for its compact mode API**

Read `apps/studio/src/components/observatory/DecisionCard.tsx` to verify the `compact` prop API.

**Step 3: Replace DecisionBadge with DecisionCard compact mode**

```typescript
// Before (lines 363-376):
const DecisionBadge = memo(function DecisionBadge({ event }: { event: ExtendedTraceEvent }) {
  const kind = typeof event.data?.decisionKind === 'string' ? event.data.decisionKind : 'decision';
  const reason = typeof event.data?.reason === 'string' ? event.data.reason : undefined;

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-subtle text-purple"
      title={reason ?? `Decision: ${kind}`}
    >
      <GitBranch className="w-2.5 h-2.5" />
      {kind}
    </span>
  );
});

// After — outer span provides pill shape; no bg color (DecisionCard compact has kind-specific colors):
const DecisionBadge = memo(function DecisionBadge({ event }: { event: ExtendedTraceEvent }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px]">
      <DecisionCard data={event.data} compact />
    </span>
  );
});
```

Add the import at the top of the file (near line 29):

```typescript
import { DecisionCard } from './DecisionCard';
```

Remove the `GitBranch` import if it's no longer used elsewhere in the file. Check first — it IS used in SpanDetails (line 477, 490). Keep it.

**Step 4: Replace SpanDetails decision section with DecisionCard**

Replace the inline decision rendering in SpanDetails (lines 474-507):

```typescript
// Before (lines 474-507):
      {decisions.length > 0 && (
        <div className="mt-3">
          <div className="text-muted mb-1 flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            Decisions ({decisions.length}):
          </div>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {decisions.map((event) => {
              const kind =
                typeof event.data?.decisionKind === 'string' ? event.data.decisionKind : 'decision';
              const reason = typeof event.data?.reason === 'string' ? event.data.reason : '';
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-2 px-2 py-1.5 bg-purple-subtle/50 rounded"
                >
                  <GitBranch className="w-3 h-3 text-purple mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-subtle text-purple">
                      {kind}
                    </span>
                    {reason && (
                      <p className="text-muted mt-0.5 text-[11px] break-words">{reason}</p>
                    )}
                  </div>
                  <span className="text-subtle text-[10px] ml-auto shrink-0">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

// After:
      {decisions.length > 0 && (
        <div className="mt-3">
          <div className="text-muted mb-1 flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            Decisions ({decisions.length}):
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {decisions.map((event) => (
              <DecisionCard key={event.id} data={event.data} timestamp={event.timestamp} />
            ))}
          </div>
        </div>
      )}
```

**Step 5: Format and build**

```bash
npx prettier --write apps/studio/src/components/observatory/SpanTree.tsx
pnpm build --filter=@agent-platform/studio
```

**Step 6: Commit**

```
[ABLP-2] fix(studio): use DecisionCard in SpanTree badges and detail section
```

---

## Task 5: Sort children by `startTime` in `getSpanTree()`

The current `getSpanTree()` (around line 840) builds the parent-child hierarchy but does not sort children. This means sibling spans appear in insertion order (Map iteration order), not chronological order — making the tree confusing when agents/steps don't appear in the order they actually executed.

**Files:**

- Modify: `apps/studio/src/store/observatory-store.ts:840-876`

**Step 1: Read the `getSpanTree` implementation**

Read `apps/studio/src/store/observatory-store.ts` lines 840-876.

**Step 2: Add sort after building the tree**

After the tree-building loop that sets `parent.children`, add a sort pass:

```typescript
// After building the tree, sort children by startTime
for (const node of nodeMap.values()) {
  if (node.children.length > 1) {
    node.children.sort((a, b) => a.span.startTime.getTime() - b.span.startTime.getTime());
  }
}
```

Insert this BEFORE the `return roots` statement.

**Step 3: Format and build**

```bash
npx prettier --write apps/studio/src/store/observatory-store.ts
pnpm build --filter=@agent-platform/studio
```

**Step 4: Commit**

```
[ABLP-2] fix(studio): sort span tree children by startTime for chronological ordering
```

---

## Task 6: Handle live session `session_ended` — sweep running spans

For **live** sessions (not historical replay), spans may remain running if `agent_exit` was missed or dropped. When a `session_ended` event arrives, sweep all running spans to `completed`.

**Files:**

- Modify: `apps/studio/src/store/observatory-store.ts` (inside `addEvent()`, near the session event handlers)

**Step 1: Read session event handlers in `addEvent`**

Read the `session_ended` / `session_created` handling section in `addEvent()`.

**Step 2: Add sweep on `session_ended`**

In the `addEvent()` method, after the existing `session_ended` handling logic, add:

```typescript
if (event.type === 'session_ended') {
  // Sweep all running spans — session is over, nothing should still be "running"
  const { spans: currentSpans } = get();
  for (const [sid, s] of currentSpans) {
    if (s.status === 'running') {
      get().endSpan(sid, 'completed', event.timestamp);
    }
  }
}
```

**Step 3: Format and build**

```bash
npx prettier --write apps/studio/src/store/observatory-store.ts
pnpm build --filter=@agent-platform/studio
```

**Step 4: Commit**

```
[ABLP-2] fix(studio): sweep running spans on session_ended for live sessions
```

---

## Task 7: Add unit tests for `addEvent` span lifecycle

The span lifecycle logic has no dedicated tests. Add at least one test verifying the core flow: `agent_enter` creates a span, events attach to it, `agent_exit` ends it by agent name (not stack position).

**Files:**

- Create: `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useObservatoryStore } from '../observatory-store';

describe('Observatory span lifecycle', () => {
  beforeEach(() => {
    const s = useObservatoryStore.getState();
    s.clearEvents(); // resets spans, activeSpanStack, events, flowNodes, etc.
    s.clearFlow();
    s.resetMetrics();
    s.clearLogs();
  });

  it('agent_enter creates span, agent_exit ends it by agent name', () => {
    const store = useObservatoryStore.getState();
    const sessionId = 'test-session';
    const traceId = 'test-trace';
    const agentName = 'TestAgent';
    const spanId = 'span-test-1';
    const ts = new Date('2026-01-01T00:00:00Z');

    // Simulate agent_enter
    store.addEvent({
      id: 'evt-1',
      type: 'agent_enter',
      spanId,
      traceId,
      sessionId,
      agentName,
      timestamp: ts,
      data: {},
    });

    // Verify span was created
    const spans = useObservatoryStore.getState().spans;
    expect(spans.has(spanId)).toBe(true);
    expect(spans.get(spanId)!.status).toBe('running');
    expect(spans.get(spanId)!.agentName).toBe(agentName);

    // Simulate agent_exit
    store.addEvent({
      id: 'evt-2',
      type: 'agent_exit',
      spanId: 'span-exit-1',
      traceId,
      sessionId,
      agentName,
      timestamp: new Date('2026-01-01T00:00:05Z'),
      data: { result: 'success' },
    });

    // Verify span was ended
    const updatedSpans = useObservatoryStore.getState().spans;
    expect(updatedSpans.get(spanId)!.status).toBe('completed');
  });
});
```

**Step 2: Run the test**

```bash
pnpm --filter=@agent-platform/studio exec vitest run src/store/__tests__/observatory-span-lifecycle.test.ts
```

Expected: PASS. If it fails, adjust the test to match the actual `addEvent` input shape (read the `ExtendedTraceEvent` type first).

**Step 3: Format and commit**

```bash
npx prettier --write apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts
```

```
[ABLP-2] test(studio): add span lifecycle unit test for agent_enter/exit flow
```

---

## Task 8: Run full test suite and verify build

**Step 1: Build all packages**

```bash
pnpm build
```

Expected: 46/46 pass (or all succeed).

**Step 2: Run tests**

```bash
pnpm test
```

Expected: All packages pass except possibly `@agent-platform/connector-sharepoint` (pre-existing failure, unrelated).

**Step 3: Commit any test fixes if needed**

If any tests fail due to the observatory-store changes, fix them.

**Step 4: Manual verification**

Start the dev servers:

```bash
pnpm dev --filter=@agent-platform/runtime --filter=@agent-platform/studio
```

Open Studio at `http://localhost:5173`. Navigate to an agent session. Verify:

1. **No spinners on historical spans** — all spans show green checkmark (completed) or red X (error)
2. **Hierarchy visible** — child agents/steps are indented under their parent
3. **Decision badges show kind** — "Handoff", "Completion", "Constraint" with kind-specific icons and colors, NOT just "decision"
4. **Expanding a span** shows DecisionCard with candidates/reasoning/conditions sections
5. **Right detail panel** shows DecisionCard when a span with decisions is selected
6. **Duration shows correctly** — historical spans show actual duration (seconds/ms), not hours

---

## Summary of changes

| File                                 | What changes                                                                                                                                                                   | Lines affected     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `observatory-store.ts`               | `startSpan`/`endSpan` accept timestamp; remove auto-span creation; fix `agent_exit` matching; fix event-to-span attachment; `getSpanTree` children sort; `session_ended` sweep | ~100 lines changed |
| `replay-trace-events.ts`             | Post-replay sweep closes running spans (using fresh `getState()`, not stale `obs`)                                                                                             | ~12 lines added    |
| `SpanTree.tsx`                       | DecisionBadge uses DecisionCard compact; SpanDetails uses DecisionCard                                                                                                         | ~40 lines changed  |
| `observatory-span-lifecycle.test.ts` | New test: agent_enter creates span, agent_exit ends by name                                                                                                                    | ~50 lines new      |

Files NOT changed (already correct):

- `DecisionCard.tsx` — already has compact mode and full rendering
- `NodeDetailPanel.tsx` — already uses `<DecisionCard>` (line 291)
- `event-types.ts` — already has `DECISION_KIND_META` and `normalizeEventType()`
- `useSessionDetail.ts` — conversation tree builder works independently of span tree

## Review findings incorporated

### Round 0 (initial review)

| Finding                                                                                          | Severity | Task          | Fix                                                   |
| ------------------------------------------------------------------------------------------------ | -------- | ------------- | ----------------------------------------------------- |
| FAIL-1: `flow_step_enter` parentSpanId uses `event.spanId` (per-event ID), not parent agent span | Critical | Task 2 Step 5 | Scan `currentSpans` for running agent span            |
| FAIL-2: `obs.spans` stale after Zustand `set()` calls in replay loop                             | Critical | Task 3 Step 2 | Use fresh `useObservatoryStore.getState()` after loop |
| GAP-1: `getSpanTree()` children unsorted                                                         | Medium   | Task 5 (new)  | Sort by `startTime`                                   |
| GAP-2: No tests for `addEvent` span lifecycle                                                    | Medium   | Task 7 (new)  | Add unit test for agent_enter/exit flow               |
| GAP-3: Live sessions have no span sweep on `session_ended`                                       | Medium   | Task 6 (new)  | Sweep running spans on `session_ended` event          |

### Rounds 1-3 (3-round team review)

| Finding                                                                    | Severity | Task          | Fix                                                                    |
| -------------------------------------------------------------------------- | -------- | ------------- | ---------------------------------------------------------------------- |
| `agent_exit` FIFO matching ends wrong span for re-entrant agents           | Critical | Task 2 Step 4 | Direct spanId match first, LIFO fallback for replay/re-entrant         |
| `resetSession()` does not exist on observatory store                       | Critical | Task 7        | Use `clearEvents()` + `clearFlow()` + `resetMetrics()` + `clearLogs()` |
| DecisionBadge wrapper `bg-purple-subtle` defeats kind-specific colors      | Medium   | Task 4 Step 3 | Removed hardcoded purple background from outer wrapper                 |
| Task 2 Steps 2/5/7 must be done atomically (agentSpanId removed in Step 2) | Low      | Task 2        | Note: do not commit between sub-steps of Task 2                        |
| Consolidation plan already complete — no execution order dependency        | Info     | Header        | Updated context note                                                   |
