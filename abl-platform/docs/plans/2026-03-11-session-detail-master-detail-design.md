# Session Detail Master-Detail Redesign

**Date**: 2026-03-11
**Status**: Approved
**Goal**: Refactor the session detail view from a three-panel layout to a two-panel master-detail pattern, fix data quality bugs (raw IDs, empty traces, constraint spam), and reorganize information architecture so each panel has a clear, non-overlapping purpose.

---

## Problem Statement

The current session detail view has three panels (left tree, top-right summary, bottom-right debug tabs) with overlapping concerns:

- The conversation tree (left) and Traces tab (bottom-right) both show execution hierarchy
- SessionSummaryPanel tabs (Preview/Request/Response) and Performance tab both show LLM details
- Three critical bugs degrade the experience:
  1. Raw trace/span IDs shown as node labels (runtime writes composite ID into `agentName`)
  2. Empty traces waterfall (ClickHouse stores `randomUUID()` instead of real `spanId`)
  3. Constraint check spam (12+ uncollapsed `constraint_check` nodes)

## Layout

Two-panel master-detail with persistent metrics header.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ← Back to Sessions    s-019c0ce7-7248    ⚡131  🪙12,030  💰$0.06 │
├──────────────────┬──────────────────────────────────────────────────┤
│ Agent Execution  │  $0.06  │  12,030 tokens  │  60.9s  │  Mar 11  │
│ Tree             ├──────────────────────────────────────────────────┤
│                  │ [Overview] [Traces] [Data] [Conv] [Perf] [IR] [Voice*] │
│ ▾ TravelDesk_Sup │                                                  │
│   ├ LLM → gpt-4o│  ┌──────────────────────────────────────────────┐│
│   ├ decision:... │  │                                              ││
│   ├ constraints… │  │   Tab content                                ││
│   └ handoff → …  │  │   (driven by selected tab + selected node)  ││
│ ── "book flight" │  │                                              ││
│ ▾ Booking_Agent  │  │                                              ││
│   ├ LLM → gpt-4o│  └──────────────────────────────────────────────┘│
│   └ tool: search │                                                  │
└──────────────────┴──────────────────────────────────────────────────┘
```

- Metrics bar: persistent, always visible (cost, tokens, latency, timestamp)
- Tabs: Overview | Traces | Data | Conversation | Performance | IR | Voice (conditional)
- Single horizontal resize handle (default 35/65)
- SessionSummaryPanel eliminated as separate component

---

## Agent Execution Tree (Left Panel)

Agent-centric hierarchy with user message separators and smart collapsing.

```
▾ TravelDesk_Supervisor                    2.1s
  ├ LLM → gpt-4o                    830tk  0.8s
  ├ decision: handoff → Booking…           12ms
  ├ constraints (12) ✓                     45ms
  └ handoff → Booking_Agent                 3ms
── "I want to book a flight to Paris"
▾ Booking_Agent                            1.4s
  ├ LLM → gpt-4o                    620tk  0.6s
  ├ tool: search_flights                   0.5s
  ├ LLM → gpt-4o                    480tk  0.3s
  └ decision: completion ✓                  8ms
── Agent: "I found 3 flights…"
```

### Node types

| Event type                     | Icon          | Label                                     | Right-side info   |
| ------------------------------ | ------------- | ----------------------------------------- | ----------------- |
| `agent_enter`                  | Bot           | `{agentName}`                             | total duration    |
| `llm_call`                     | Cpu           | `LLM → {model}`                           | tokens + duration |
| `tool_call`                    | Wrench        | `tool: {toolName}`                        | duration          |
| `decision`                     | Lightbulb     | `{decisionKind}: {outcome}` (80 char max) | duration          |
| `constraint_check` (collapsed) | Shield        | `constraints ({N}) ✓/✗`                   | total duration    |
| `guardrail_check` (collapsed)  | ShieldAlert   | `guardrails ({N}) ✓/✗`                    | total duration    |
| `handoff`                      | ArrowRight    | `handoff → {targetAgent}`                 | —                 |
| `delegate_start`               | Users         | `delegate → {targetAgent}`                | —                 |
| `flow_step_enter`              | Workflow      | `step: {stepName}`                        | duration          |
| `error`                        | AlertTriangle | `error: {message}` (60 char max)          | —                 |
| user separator                 | MessageSquare | `"{content}"` (60 char max)               | —                 |
| assistant separator            | Bot           | `Agent: "{content}"` (60 char max)        | —                 |

### Label fallback chains

```
agent_enter:  eventData.agentName → lastSegment(eventData.agent) → session.agentName → "Agent"
llm_call:     "LLM → " + eventData.model → "LLM Call"
tool_call:    "tool: " + eventData.toolName → eventData.name → "Tool Call"
decision:     eventData.decisionKind + ": " + eventData.outcome → "decision"
handoff:      "handoff → " + eventData.toAgent → eventData.agentName → "Handoff"
```

### Raw ID guard

Utility function `isRawId(value: string): boolean` that detects:

- Hex strings ≥16 chars: `/^[0-9a-f]{16,}$/i`
- `traceId:spanId` composites: `/^[0-9a-f]+:[0-9a-f]+$/i`
- UUIDs: `/^[0-9a-f]{8}-[0-9a-f]{4}-/i`

Any label matching these patterns gets replaced with the fallback.

### Collapsing rules

- Consecutive `constraint_check` events under same parent → single node with count + pass/fail summary
- Consecutive `guardrail_check` events → same treatment
- Expandable on click to see individual checks
- `gather_extraction` and `correction` events (verbose-only) collapsed similarly

### Selection behavior

- Click node → sets `selectedTraceNodeId` in UI store → drives Overview tab
- Click collapsed group → expands inline, selects group summary
- Double-click agent node → scrolls Traces tab to that agent's span

---

## Tab Content (Right Panel)

### Overview Tab (default)

**Nothing selected** — session summary:

- Agent name, session ID (copy button), environment, channel type
- Message count, trace event count
- Start/end timestamps, total duration
- Model(s) used, total tokens breakdown (input/output)

**Node selected** — node detail (reuses NodeDetailPanel internals):

- Summary row: 4 metrics (cost, tokens, latency, timestamp) for LLM calls; 2 metrics for others
- Sub-tabs: Preview | Request | Response | Metadata
  - Preview: Chat bubbles for LLM (user=blue, assistant=green, system=gray, tool=orange). DecisionCard for decisions. Formatted input/output for tools.
  - Request: Full input JSON with copy button
  - Response: Full output JSON with copy button
  - Metadata: Raw event.data via JsonViewer

### Traces Tab

- WaterfallPanel with real span hierarchy (spanId/parentSpanId)
- Duration bars, cost column (color coded), token counts, status indicators
- Click span → NodeDetailPanel as right-side drawer within tab
- Progressive loading for large sessions

### Data Tab (unchanged)

- GatherProgressPanel + ContextTab

### Conversation Tab (unchanged)

- Message history with role-colored borders

### Performance Tab (unchanged)

- LLMCallsTab + LogsSection

### IR Tab (unchanged)

- ABL DSL source + IR JSON + TestContextPanel

### Voice Tab (conditional, unchanged)

- VoiceMetricsTab — only when voice_session_start event exists

---

## Data Flow & Bug Fixes

### Bug 1: Empty traces waterfall (5.1.1 + 5.1.6)

**Write side**: `trace-emitter.ts` passes real `event.spanId`/`event.parentSpanId` to EventStore (done in trace consolidation Phase 2 — verify working).

**Read side**: `replayTraceEventsIntoObservatory` uses `event.spanId`/`event.parentSpanId` from API response. If missing, fall back to building hierarchy from `agent_enter`/`agent_exit` pairs.

### Bug 2: Raw IDs as labels (5.1.2)

**Write side**: Validate `agentName` in `trace-emitter.ts` — if matches raw ID pattern, use agent's actual name from execution context.

**Read side**: `buildAgentTree` label fallback chain with `isRawId()` guard.

### Bug 3: Constraint check spam

**Fix**: `buildAgentTree` detects consecutive runs of same-type events, collapses into single summary node with count badge.

### Data flow

```
Historical session:
  API /sessions/:id → traceEvents with real spanId/parentSpanId
    → replayTraceEventsIntoObservatory() → observatory-store (spans, events)
    → buildAgentTree() → tree: TreeNode[] (agent-centric, collapsed)

Live session:
  WebSocket trace_event → observatory-store.addEvent()
    → spans Map updated in real-time
    → buildAgentTree() recomputed on each event
```

### Store usage

- `useUIStore.selectedTraceNodeId`: bridges tree selection → Overview tab
- `observatoryStore.spans`/`selectedSpanId`: powers Traces tab waterfall
- `sessionStore`: unchanged (messages, agent, state for Conv/Data/IR tabs)
- Overview tab reads from both stores

---

## Component Map

### Rewrite (fresh file)

| Component                                              | Reason                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| `SessionDetailPage.tsx`                                | Layout fundamentally different (3→2 panels, resize logic changes) |
| `AgentConversationTree.tsx` → `AgentExecutionTree.tsx` | Different tree structure, collapsing, label resolution            |
| `buildConversationTree()` → `buildAgentTree.ts`        | Different algorithm (conversation-centric → agent-centric)        |

### New

| Component         | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `OverviewTab.tsx` | Session summary (nothing selected) / node detail (selected) |
| `MetricsBar.tsx`  | Persistent metrics strip                                    |
| `label-utils.ts`  | `resolveLabel()` fallback chains + `isRawId()` guard        |

### Modify

| Component                | Change                                      |
| ------------------------ | ------------------------------------------- |
| `DebugTabs.tsx`          | Add Overview as first tab                   |
| `useSessionDetail.ts`    | Swap tree builder call, fix spanId handling |
| `replay-trace-events.ts` | Prefer real spanIds over synthetic          |

### Extract and reuse

| Component                 | Action                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `SessionSummaryPanel.tsx` | Extract Preview/Request/Response/Metadata renderers into OverviewTab, delete original |

### Unchanged

WaterfallPanel, SpanTree, NodeDetailPanel, DecisionCard, GatherProgressPanel, LLMCallsTab, VoiceMetricsTab, FloatingDebugPanel, event-colors.ts

---

## File summary

- **3 rewrites**: SessionDetailPage, AgentExecutionTree, buildAgentTree
- **3 new files**: OverviewTab, MetricsBar, label-utils
- **3 modifications**: DebugTabs, useSessionDetail, replay-trace-events
- **1 extract-and-delete**: SessionSummaryPanel
- **~10 unchanged**: existing observatory components stay as-is
