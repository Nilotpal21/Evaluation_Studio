# Feature: Interactions Tab

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: **BETA** (promoted from ALPHA after implementing minimum test coverage: 3 integration + 3 E2E tests, PR review complete)
**Feature Area(s)**: `observability`, `agent lifecycle`
**Package(s)**: `apps/studio`
**Owner(s)**: Studio team
**Testing Guide**: `../testing/interactions-tab.md`
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

Agent developers and support engineers debugging agent execution face three critical problems:

1. **No clear narrative** — raw trace events are flat lists with no story. Developers must manually reconstruct the interaction flow from timestamps and event correlations.
2. **Missing context** — LLM token usage, cost, memory state changes, and guardrail checks are invisible in existing debug tools.
3. **Bad UX** — too much noise, no way to focus on what matters. Error diagnosis requires correlating events across multiple tabs (Traces, Data, Performance, Conversation).

Without the Interactions tab, debugging an agent session requires:

- Switching between 4-5 tabs to piece together token usage, tool calls, memory state, and conversation flow
- Manual correlation of event timestamps to understand causality
- No visibility into parallel execution patterns or flow state for scripted agents
- No way to quickly identify cost hotspots or guardrail failures

This inefficiency slows development velocity, increases mean-time-to-resolution for bugs, and makes incident response reactive rather than proactive.

### Goal Statement

Provide an **interaction-centric debug panel** that presents agent execution as a clear, sequential narrative with embedded intelligence: token/cost at every level, inline guardrail status, git-style memory diffs, parallel execution swim lanes, and flow graph awareness for scripted agents. Enable developers to understand exactly what happened, why, and at what cost — all in one unified timeline.

### Summary

The Interactions tab is a new debug panel in Studio's Observatory that transforms raw trace events into a chronological interaction timeline. Each interaction (one user message + all agent processing until the next user message or session end) is rendered as a collapsible card with:

- **Token & Cost Intelligence (Feature A)**: Per-LLM-call, per-interaction, and per-session token breakdowns with context window utilization and cost calculation
- **Guardrail & Safety Layer (Feature B)**: Inline input/output guardrail status with confidence bars, PII detection, prompt injection checks, and hallucination detection
- **Memory & State Evolution (Feature C)**: Git-style diffs showing exactly what changed in session state after each interaction (added, changed, removed, unchanged keys)
- **Parallel Execution Visualization (Feature D)**: Swim lane timelines for parallel tool calls with dependency tracking and time savings calculation
- **Flow & DSL Awareness (Feature F)**: For scripted agents, shows flow breadcrumb, mini flow graph, variable resolution trails, transition condition evaluation, and per-field gather confidence

Users interact with the tab through:

- **Studio UI**: Select Interactions tab in Observatory debug panel, expand/collapse interaction cards, view step details
- **Real-time updates**: WebSocket connection pushes new events as the session progresses
- **Historical analysis**: Load completed sessions from database and analyze trace history

---

## 2. Scope

### Goals

- Provide a single unified view of agent execution that replaces multi-tab correlation
- Surface token usage and cost at every level (per-call, per-interaction, per-session)
- Show guardrail checks inline with interaction steps for immediate visibility
- Visualize memory state changes as git-style diffs for easy debugging
- Detect and visualize parallel tool execution with dependency tracking
- For scripted agents, show flow graph state, variable resolution, and transition conditions
- Support both real-time session monitoring and historical trace analysis
- Handle sessions with 100+ interactions without UI degradation

### Non-Goals (Out of Scope)

- **Production monitoring** — this is a development/debugging tool, not a live ops dashboard
- **Replay & navigation (Feature E)** — deferred from v1; adds complexity without solving core readability
- **Collaboration & export (Feature G)** — deferred; not required for initial debugging use case
- **Comparison mode (Feature H)** — deferred; requires loading two sessions, out of scope for v1
- **Historical trend analysis** — the tab shows one session at a time, not aggregate metrics
- **User-facing customer support UI** — this is internal tooling for agent developers and support engineers
- **Automatic error diagnosis** — the tab surfaces data; automated root cause analysis is out of scope

---

## 3. User Stories

1. As an **agent developer**, I want to see token usage and cost breakdown for every LLM call so that I can identify cost hotspots and optimize prompts.

2. As a **support engineer**, I want to see inline guardrail check results (PII detection, prompt injection, hallucination) so that I can quickly diagnose why a user message was blocked or flagged.

3. As an **agent developer debugging memory issues**, I want to see git-style diffs of session state changes so that I can identify which tool or step mutated state incorrectly.

4. As an **agent developer debugging performance**, I want to see swim lane visualizations of parallel tool calls so that I can verify that parallelization is working and identify dependency bottlenecks.

5. As a **platform engineer debugging scripted agents**, I want to see the flow graph, variable resolution trails, and transition condition evaluation so that I can understand why the agent took a specific path.

6. As an **incident responder**, I want to quickly scan interaction statuses (green/amber/red dots) and jump to the errored interaction so that I can diagnose production issues faster.

---

## 4. Functional Requirements

1. **FR-1**: The system must process raw trace events from `ObservatoryStore` into a chronological list of interactions, where each interaction contains all steps from one user message to the next.

2. **FR-2**: The system must calculate and display token usage (input, output, total) and cost for every LLM call, with aggregated totals at the interaction and session levels.

3. **FR-3**: The system must display context window utilization as a percentage of the model's maximum context size, with color-coded warnings (green: 0-60%, amber: 60-80%, red: 80-100%).

4. **FR-4**: The system must show input and output guardrail check results inline with interaction steps, including confidence bars, check types (PII, prompt injection, hallucination, tone, policy), and pass/warn/fail status.

5. **FR-5**: The system must display memory state changes as git-style diffs with four categories: added (+), changed (~), removed (-), and unchanged (dimmed), showing old and new values for changed keys.

6. **FR-6**: The system must detect parallel tool execution by analyzing overlapping time ranges and render them as swim lane timelines with dependency indicators and time savings calculation.

7. **FR-7**: For scripted agents, the system must display a flow breadcrumb showing visited, current, upcoming, and errored steps, with a mini flow graph visualization showing node states.

8. **FR-8**: For scripted agents, the system must show variable resolution trails (how DSL template variables like `{{orderId}}` resolved to runtime values) and transition condition evaluation results (which conditions were TRUE/FALSE).

9. **FR-9**: For scripted agents, the system must display per-field gather confidence with source text highlighting, showing which parts of the user message contributed to each extracted field.

10. **FR-10**: The system must support real-time updates via WebSocket as trace events are emitted during an active session.

11. **FR-11**: The system must load and display historical traces from completed sessions stored in the database.

12. **FR-12**: The system must handle sessions with 100+ interactions without UI performance degradation by implementing optimizations (e.g., switchMap limited to last 100 interactions).

13. **FR-13**: The system must render lifecycle banners (agent_enter, agent_exit, delegate_start, delegate_complete, thread_return, gather_enter, gather_exit) as thin inline dividers between step cards.

14. **FR-14**: The system must display agent switch banners between interactions when the active agent changes, showing mode transitions (reasoning/scripted) and context preservation status.

15. **FR-15**: The system must show a session header with aggregate stats (interaction count, agent count, LLM call count, tool call count, total duration, total tokens, total cost, max context window utilization, guardrail summary).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                      |
| -------------------------- | ------------ | -------------------------------------------------------------------------- |
| Project lifecycle          | NONE         | Does not affect project CRUD, deployment, or configuration                 |
| Agent lifecycle            | SECONDARY    | Visualizes agent execution but does not modify agent behavior              |
| Customer experience        | NONE         | Internal tooling; not user-facing                                          |
| Integrations / channels    | NONE         | Debug tool; does not touch channel surfaces                                |
| Observability / tracing    | PRIMARY      | Core observability feature; primary consumer of trace events               |
| Governance / controls      | SECONDARY    | Surfaces guardrail checks but does not enforce policy                      |
| Enterprise / compliance    | NONE         | No audit trail, retention, or compliance concerns                          |
| Admin / operator workflows | SECONDARY    | Used by support engineers for incident response; not part of admin console |

### Related Feature Integration Matrix

| Related Feature      | Relationship Type | Why It Matters                                                                    | Key Touchpoints                                               | Current State |
| -------------------- | ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| Observatory (Traces) | extends           | Interactions tab is an alternative view of the same trace event stream            | `ObservatoryStore.events`, shared event types                 | STABLE        |
| Session Store        | depends on        | Enriches agent_response steps with actual message content from session store      | `SessionStore.messages`, `useSessionStore((s) => s.messages)` | STABLE        |
| WebSocket (Runtime)  | emits into        | Runtime emits trace events via WebSocket; Interactions tab consumes them          | `WebSocketContext`, `ObservatoryStore.addEvent()`             | STABLE        |
| Agent Execution      | observes          | Visualizes agent execution; does not modify behavior                              | Trace events emitted by Runtime execution services            | STABLE        |
| Guardrails           | observes          | Surfaces guardrail check results; does not enforce policy                         | `guardrail_*` trace events                                    | STABLE        |
| Flow Engine (DSL)    | observes          | For scripted agents, visualizes flow graph state and variable resolution          | `flow_*` trace events, agent DSL definitions                  | STABLE        |
| Token Intelligence   | depends on        | Calculates cost using model pricing data; requires token counts from trace events | `llm_call` events with `metadata.inputTokens`, `outputTokens` | STABLE        |
| Parallel Execution   | observes          | Detects parallel tool calls by analyzing overlapping time ranges                  | `tool_call` events with `startTime`, `endTime`                | STABLE        |

---

## 6. Design Considerations

**Wireframes**: Interactive wireframes were created during design phase (served at localhost:54460):

- `wireframe-ab.html`: Features A + B (token intelligence, guardrails)
- `wireframe-cd.html`: Features C + D (memory diffs, parallel swim lanes)
- `wireframe-ef.html`: Feature F (flow graphs, variable resolution, gather confidence)

**Design doc**: Full design specification at `/Users/sainathbhima/Downloads/2026-03-30-turns-tab-design.md` (641 lines)

**UX patterns**:

- Collapsible interaction cards with animated expand/collapse (Framer Motion)
- Color-coded status dots (green: ok, amber: warning, red: error)
- Compact vs expanded guardrail display (compact for all-pass cases, expanded for warnings/failures/first interaction)
- Git-style diff syntax with colored left borders for memory changes
- Swim lane timelines with dependency arrows for parallel execution
- Flow breadcrumbs and mini graphs for scripted agents

**Accessibility**:

- All interactive elements have `aria-label` and `aria-expanded` attributes
- Collapsible regions use `role="region"` with descriptive labels
- Color is not the only indicator (status badges use text + color)

**Style system**:

- Uses semantic tokens from `@agent-platform/design-tokens`
- Background colors: `bg-background-muted`, `bg-background-elevated`
- Text colors: `text-foreground`, `text-foreground-subtle`, `text-foreground-muted`
- Intent colors: `bg-success`, `bg-warning`, `bg-error`, `bg-info`, `bg-purple`

---

## 7. Technical Considerations

**Event processing pipeline**:

1. Runtime emits trace events via WebSocket
2. `WebSocketContext` receives events and dispatches to `ObservatoryStore.addEvent()`
3. Interactions tab reads `ObservatoryStore.events` and processes them via `processEventsToInteractions()`
4. Event processor groups events into interactions, detects parallel execution, builds agent path, calculates summaries
5. UI renders interaction cards with step components

**Performance optimizations**:

- `switchMap` limited to last 100 interactions to prevent unbounded memory (InteractionsTab.tsx:43)
- Memoized processing with `useMemo()` to avoid reprocessing on every render
- Conditional rendering: only expanded interactions render step details
- Virtualization: future consideration for sessions with 500+ interactions

**Trace event dependencies**:

- Requires Runtime to emit trace events at `standard` verbosity level or higher (see `apps/runtime/src/services/execution/trace-helpers.ts`)
- Some features require specific event types (e.g., `gather_start`, `gather_complete` added for gather lifecycle banners)

**Deployment considerations**:

- No feature flag; enabled by default in Studio
- Requires Runtime version alignment for new trace event types (e.g., gather lifecycle events)
- No database migrations; consumes existing trace event schema

---

## 8. How to Consume

### Studio UI

**Route**: Studio debug panel → Observatory → Interactions tab

**Workflow entry points**:

1. **Active session debugging**: Open debug panel while agent is responding, switch to Interactions tab, watch real-time updates
2. **Historical analysis**: Open a completed session from session list, navigate to Interactions tab, review full timeline
3. **Error investigation**: Session errors show red status dot; click into errored interaction to see step details

**User actions**:

- Click interaction card header to expand/collapse step timeline
- Hover over token badges to see breakdown
- Click guardrail "▶ View raw response" to see full guardrail API response
- Click "Copy cURL" button on tool calls to reproduce requests
- Click flow graph nodes to jump to that step's trace events

**Role expectations**: Agent developers, platform engineers, support staff. No tenant admin or end-user access.

### API (Runtime)

Interactions tab does not expose REST endpoints. It is a pure consumer of trace events.

**Trace event emission**:

- Runtime services emit trace events via `onTraceEvent()` callback
- Events must include: `type`, `timestamp`, `agentName`, `data`, optional `metadata`
- See `apps/runtime/src/services/execution/trace-helpers.ts` for verbosity control

### API (Studio)

No Studio-side API routes. The tab is a client-side component that reads from stores.

### Admin Portal

Not applicable. Interactions tab is Studio-only.

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. The tab visualizes trace events from any channel (Web, Voice, SDK, A2A, MCP) without channel-specific logic.

---

## 9. Data Model

### Collections / Tables

**No new collections.** The Interactions tab consumes existing trace event data.

**Trace events** (stored in `TraceStore`, MongoDB `traces` collection):

```text
Collection: traces
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - sessionId: string (required, indexed)
  - type: string (e.g., 'user_message', 'llm_call', 'tool_call', 'guardrail_check', ...)
  - timestamp: Date
  - agentName: string
  - data: Record<string, unknown> (event-specific payload)
  - metadata: Record<string, unknown> (optional enrichment: tokens, cost, confidence, ...)
Indexes:
  - { tenantId: 1, projectId: 1, sessionId: 1, timestamp: 1 }
```

### Key Relationships

- **Interactions ↔ Trace Events**: An interaction is a derived grouping of trace events between two user messages
- **Steps ↔ Trace Events**: Each step in an interaction corresponds to one or more trace events of a specific type
- **Agent Path ↔ Sessions**: Agent path is derived from `agent_enter`, `agent_exit`, `delegate_start`, `delegate_complete` events
- **Memory Diffs ↔ Context State**: Memory diffs are derived by comparing `context.before` and `context.after` snapshots from context mutation events
- **Parallel Execution ↔ Tool Calls**: Parallel detection analyzes overlapping time ranges of `tool_call` events

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                            | Purpose                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/observatory/interactions/event-processor.ts` (20KB) | Core event processing: groups events into interactions, detects parallel, builds agent path |
| `apps/studio/src/components/observatory/interactions/types.ts` (113 lines)      | Type definitions for Interaction, InteractionStep, LifecycleBanner, SessionSummary, etc.    |
| `apps/studio/src/components/observatory/interactions/constants.ts` (395 lines)  | Step config, event-to-step mapping, lifecycle event sets, event labels                      |

### Routes / Handlers

Not applicable (no backend routes; pure frontend component).

### UI Components

| File                                                                                   | Purpose                                                                                  |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/components/observatory/interactions/InteractionsTab.tsx` (168 lines)  | Root component: loads events from store, processes to interactions, renders timeline     |
| `apps/studio/src/components/observatory/interactions/InteractionCard.tsx` (185 lines)  | Collapsible interaction card with header (agent, mode, status, duration, tokens)         |
| `apps/studio/src/components/observatory/interactions/InteractionStep.tsx` (256 lines)  | Individual step renderer with type-specific content (llm, tool, guardrail, memory, etc.) |
| `apps/studio/src/components/observatory/interactions/SessionHeader.tsx` (104 lines)    | Session-level summary stats with token/cost/guardrail aggregates                         |
| `apps/studio/src/components/observatory/interactions/AgentSwitchBanner.tsx` (37 lines) | Banner shown between interactions when agent switches                                    |
| `apps/studio/src/components/observatory/interactions/LifecycleBanner.tsx` (57 lines)   | Thin inline dividers for agent_enter, agent_exit, delegate, thread_return, gather events |
| `apps/studio/src/components/observatory/interactions/TokenBadge.tsx` (57 lines)        | Feature A: Token count and cost display                                                  |
| `apps/studio/src/components/observatory/interactions/ContextWindowBar.tsx` (53 lines)  | Feature A: Context window utilization bar with color thresholds                          |
| `apps/studio/src/components/observatory/interactions/GuardrailPanel.tsx` (185 lines)   | Feature B: Expanded guardrail display with confidence bars and check results             |
| `apps/studio/src/components/observatory/interactions/GuardrailCompact.tsx` (60 lines)  | Feature B: Compact single-line guardrail display                                         |
| `apps/studio/src/components/observatory/interactions/MemoryDiff.tsx` (238 lines)       | Feature C: Git-style diff for memory state changes                                       |
| `apps/studio/src/components/observatory/interactions/DiffLine.tsx` (108 lines)         | Feature C: Individual diff line component (added, changed, removed, unchanged)           |
| `apps/studio/src/components/observatory/interactions/SwimLaneTimeline.tsx` (247 lines) | Feature D: Parallel tool execution swim lanes with dependency tracking                   |
| `apps/studio/src/components/observatory/interactions/FlowBreadcrumb.tsx` (159 lines)   | Feature F: Flow step breadcrumb for scripted agents                                      |
| `apps/studio/src/components/observatory/interactions/MiniFlowGraph.tsx` (134 lines)    | Feature F: Mini flow graph visualization                                                 |
| `apps/studio/src/components/observatory/interactions/GatherConfidence.tsx` (263 lines) | Feature F: Per-field gather confidence with source text highlighting                     |
| `apps/studio/src/components/observatory/interactions/ErrorBoundary.tsx` (73 lines)     | Error boundary wrapper for the entire Interactions tab                                   |

### Jobs / Workers / Background Processes

Not applicable (no background jobs; all processing is client-side).

### Tests

| File                                                                     | Type | Coverage Focus                                                   |
| ------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------- |
| `apps/studio/src/__tests__/interactions-event-processor.test.ts` (12KB)  | unit | Event processing logic, interaction grouping, parallel detection |
| `apps/studio/src/__tests__/interactions-token-guard.test.ts` (6KB)       | unit | Token calculation, cost aggregation, guardrail summary logic     |
| `apps/studio/src/__tests__/interactions-memory-diff.test.ts` (2.6KB)     | unit | Memory diff categorization (added, changed, removed, unchanged)  |
| `apps/studio/src/__tests__/interactions-parallel-detect.test.ts` (2.1KB) | unit | Parallel execution detection from overlapping time ranges        |
| `apps/studio/src/__tests__/interactions-flow-dsl.test.ts` (2.9KB)        | unit | Flow step status, breadcrumb rendering, variable resolution      |
| `apps/studio/src/__tests__/interactions-contract.test.ts` (1.9KB)        | unit | Type contract validation for Interaction, InteractionStep types  |

**Test coverage**: Unit tests only (70-80% core logic). No integration or E2E tests yet. See §17 for full coverage matrix and planned test scenarios.

---

## 11. Configuration

### Environment Variables

No environment variables required. The tab reads from existing Studio stores.

### Runtime Configuration

No runtime configuration. The tab operates on trace events at whatever verbosity level Runtime is configured to emit.

**Trace verbosity note**: For full feature functionality, Runtime should emit trace events at `standard` verbosity or higher. Some features require specific event types:

- Feature C (memory diffs): requires `data_stored`, `dsl_set`, `memory_*` events
- Feature D (parallel swim lanes): requires `tool_call` events with `startTime`, `endTime`
- Feature F (flow graphs): requires `flow_step_enter`, `flow_step_exit`, `flow_transition` events

### DSL / Agent IR / Schema

Not applicable. The tab does not modify DSL or IR; it visualizes trace events from agent execution.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Project isolation | Trace events are scoped by `projectId`. The tab inherits isolation from `ObservatoryStore`.              |
| Tenant isolation  | Trace events are scoped by `tenantId`. Cross-tenant access is blocked at the API level (Studio backend). |
| User isolation    | Sessions are user-owned. A user can only view their own sessions unless they have admin permissions.     |

**Inherited from Observatory**: The Interactions tab does not implement its own isolation logic. It relies on `ObservatoryStore` to only load trace events that the current user has permission to view.

### Security & Compliance

**Authentication**: Inherited from Studio. Users must be authenticated to access the debug panel.

**Authorization**: Inherited from Observatory. Users can only view sessions they own or have been granted access to.

**Sensitive data**: Trace events may contain user input, LLM responses, tool call payloads. This data is:

- **Not logged to external services** (stays in Studio memory and MongoDB)
- **Subject to retention policies** (traces have TTL configured in `TraceStore`)
- **Not exported** (no export button in v1)

**PII handling**: The tab **surfaces** PII detection results from guardrails but does not redact PII. If PII is present in trace events, it will be visible to users viewing the Interactions tab.

**Audit logging**: Not applicable. The tab is read-only; no mutations are logged.

### Performance & Scalability

**Client-side processing**: All event processing happens in the browser using `useMemo()`. For sessions with 500+ interactions, consider virtualization (React Virtuoso) to avoid rendering all cards at once.

**Memory optimization**:

- `switchMap` limited to last 100 interactions (InteractionsTab.tsx:43)
- Only expanded interactions render step details (conditional rendering)
- Event processor filters out empty `flow_transition` events (InteractionCard.tsx:126-128)

**WebSocket throughput**: Real-time updates rely on WebSocket connection. For high-traffic sessions (10+ events/second), consider batching updates or throttling UI renders.

**Trace event volume**: Sessions with 1000+ events may cause UI lag. Future optimization: paginate interactions or load on-scroll.

### Reliability & Failure Modes

**Error boundary**: The entire Interactions tab is wrapped in an error boundary (`ErrorBoundary.tsx`). If event processing fails, the tab shows a fallback UI instead of crashing the debug panel.

**Partial data**: If trace events are missing (e.g., Runtime emits at `minimal` verbosity), the tab gracefully degrades:

- Missing token data → token badges show "N/A"
- Missing guardrail events → guardrail sections are omitted
- Missing flow events → flow graphs are not rendered

**Loading state**: The tab shows a skeleton while events are loading (`isLoading` state from `SessionStore`).

**Empty state**: If no interactions are recorded, the tab shows "No interactions recorded" message.

### Observability

**Trace events consumed**: The Interactions tab **is** an observability tool. It does not emit its own trace events.

**Client-side errors**: JavaScript errors in event processing are caught by the error boundary and logged to the browser console.

**Performance monitoring**: No built-in performance metrics. Use browser DevTools to profile rendering performance.

### Data Lifecycle

**Retention**: Trace events are subject to the TTL configured in `TraceStore` (typically 30-90 days). The Interactions tab does not control retention.

**Deletion**: When a session is deleted, all associated trace events are deleted. The Interactions tab does not implement deletion logic.

**Archival**: Not applicable. Historical traces are loaded from MongoDB; no separate archival mechanism.

---

## 13. Delivery Plan / Work Breakdown

**Note**: This feature has already been implemented. The plan below reflects the actual implementation phases.

1. **Core Infrastructure**
   1.1 Define type system (`types.ts`, `constants.ts`)
   1.2 Implement event processor (`event-processor.ts`)
   1.3 Add event-to-step mapping and lifecycle event detection
   1.4 Write unit tests for event processor

2. **Feature A — Token & Cost Intelligence**
   2.1 Implement `TokenBadge` component
   2.2 Implement `ContextWindowBar` component
   2.3 Add token aggregation logic to session header
   2.4 Write unit tests for token calculation

3. **Feature B — Guardrail & Safety Layer**
   3.1 Implement `GuardrailPanel` (expanded view)
   3.2 Implement `GuardrailCompact` (single-line view)
   3.3 Add guardrail event detection to event processor
   3.4 Write unit tests for guardrail summary logic

4. **Feature C — Memory & State Evolution**
   4.1 Implement `MemoryDiff` component
   4.2 Implement `DiffLine` component (added, changed, removed, unchanged)
   4.3 Add context diff logic to event processor
   4.4 Write unit tests for memory diff categorization

5. **Feature D — Parallel Execution Visualization**
   5.1 Implement parallel tool detection logic in event processor
   5.2 Implement `SwimLaneTimeline` component
   5.3 Add dependency tracking and time savings calculation
   5.4 Write unit tests for parallel detection

6. **Feature F — Flow & DSL Awareness**
   6.1 Implement `FlowBreadcrumb` component
   6.2 Implement `MiniFlowGraph` component
   6.3 Implement `GatherConfidence` component with source text highlighting
   6.4 Write unit tests for flow step status and variable resolution

7. **Integration & Polish**
   7.1 Wire `InteractionsTab` into `DebugTabs` (Studio Observatory)
   7.2 Add `useInteractionCount()` hook for badge count
   7.3 Implement error boundary and loading states
   7.4 Add lifecycle banners (agent enter/exit, delegate, gather)
   7.5 Optimize performance (switchMap limit, conditional rendering)

---

## 14. Success Metrics

| Metric                                 | Baseline                                      | Target                     | How Measured                                                        |
| -------------------------------------- | --------------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Time to diagnose agent error           | 10-15 minutes (multi-tab)                     | 2-3 minutes (single tab)   | Internal dogfooding + support ticket resolution time                |
| Tabs visited per debugging session     | 4-5 (Traces, Data, Conversation, Performance) | 1 (Interactions only)      | Studio analytics: tab switch events during debug sessions           |
| Token cost hotspot identification time | 5-10 minutes (manual calc)                    | 30 seconds (inline badges) | Internal feedback: "How long to find highest-cost LLM call?"        |
| Parallel execution verification time   | 10 minutes (manual trace correlation)         | 1 minute (swim lane view)  | Internal feedback: "How long to verify parallel tool calls worked?" |
| Agent developer satisfaction (NPS)     | Baseline survey after v1 release              | +15 points after 1 month   | Internal NPS survey focused on debug tooling                        |

---

## 15. Open Questions

1. **Virtualization threshold**: At what point should we enable virtualization for sessions with many interactions? 500? 1000?

2. **Export functionality**: Should we add a "Download as JSON" or "Share debug link" button in v2?

3. **Comparison mode**: If we add Feature H (comparison mode) in v2, how do we fit two timelines side-by-side without overwhelming the UI?

4. **Trace event schema versioning**: How do we handle breaking changes to trace event schema? Should the tab show a warning if trace events are from an older Runtime version?

5. **User permission model**: Should we add granular permissions for who can view Interactions tab data? (e.g., agent developers see all, support engineers see only prod sessions)

6. **Real-time throttling**: For high-traffic sessions (10+ events/second), should we batch updates every 200ms to avoid UI thrashing?

7. **Historical trace loading**: Should we paginate historical sessions (load first 50 interactions, then load more on scroll)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                           | Severity | Status                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | No E2E or integration tests. Only unit tests for core logic.                                          | N/A      | **Resolved** — Integration tests (INT-1, INT-2, INT-6) and E2E tests (E2E-1, SEC-1, SEC-2) implemented (Phase 2 & 4) |
| GAP-002 | Missing export functionality (JSON, shareable link, CSV). Users must screenshot or copy manually.     | Medium   | Deferred to v2                                                                                                       |
| GAP-003 | No virtualization for sessions with 500+ interactions. UI may lag with very long sessions.            | Medium   | Open (future optimization)                                                                                           |
| GAP-004 | No comparison mode. Users cannot compare two sessions side-by-side.                                   | Low      | Deferred to v2 (Feature H)                                                                                           |
| GAP-005 | No replay/navigation (Feature E). Users cannot step backward through interactions.                    | Low      | Deferred to v2                                                                                                       |
| GAP-006 | Trace event schema is not versioned. Runtime changes may break the UI.                                | Medium   | Open (requires schema registry)                                                                                      |
| GAP-007 | No guardrail-specific permissions. All users who can view a session can see guardrail results.        | Low      | Open (RBAC enhancement)                                                                                              |
| GAP-008 | Context window bar uses hardcoded model limits. Should read from dynamic model registry.              | Medium   | Open (needs model registry)                                                                                          |
| GAP-009 | Memory diffs do not handle nested object changes. Only top-level keys are diffed.                     | Medium   | Open (complex diff logic)                                                                                            |
| GAP-010 | Parallel swim lanes do not show tool retries. Failed tools are marked red, but retry logic is hidden. | Low      | Open (retry badge enhancement)                                                                                       |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                   | Coverage Type | Status     | Test File / Note                             |
| --- | -------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------- |
| 1   | Event processor groups events into interactions                            | unit          | PASS       | `interactions-event-processor.test.ts`       |
| 2   | Token calculation aggregates input/output tokens and cost                  | unit          | PASS       | `interactions-token-guard.test.ts`           |
| 3   | Memory diff categorizes state changes (added, changed, removed, unchanged) | unit          | PASS       | `interactions-memory-diff.test.ts`           |
| 4   | Parallel detection identifies overlapping tool calls                       | unit          | PASS       | `interactions-parallel-detect.test.ts`       |
| 5   | Flow step status derivation for scripted agents                            | unit          | PASS       | `interactions-flow-dsl.test.ts`              |
| 6   | Real-time WebSocket updates append new interactions                        | integration   | NOT TESTED | Requires WebSocket test harness              |
| 7   | Historical trace loading from database                                     | integration   | NOT TESTED | Requires test database with fixture sessions |
| 8   | UI renders interaction cards without crashing                              | e2e           | NOT TESTED | Requires Playwright + Studio test env        |
| 9   | Expanding/collapsing interaction cards                                     | e2e           | NOT TESTED | Manual testing only                          |
| 10  | Token badge displays correct values for LLM calls                          | e2e           | NOT TESTED | Manual testing only                          |

### Testing Notes

**Unit test coverage**: Core logic (event processor, token calc, memory diff, parallel detect, flow DSL) has unit tests. Coverage is estimated at 70-80% for `event-processor.ts`, `constants.ts`, and feature-specific logic.

**Missing integration tests**: No integration tests for WebSocket updates or database trace loading. These are tested manually during development.

**Missing E2E tests**: No automated UI tests. Interaction card expansion, token badge rendering, guardrail panels, memory diffs, swim lanes, and flow graphs are validated manually.

**Manual testing checklist**:

- [ ] Load a session with 50+ interactions and verify UI performance
- [ ] Verify token badges show correct values for GPT-4, Claude, and Gemini models
- [ ] Verify guardrail panels show pass/warn/fail status with confidence bars
- [ ] Verify memory diffs show correct added/changed/removed/unchanged keys
- [ ] Verify swim lane timelines render parallel tool calls with dependency arrows
- [ ] Verify flow breadcrumbs and mini graphs render for scripted agents
- [ ] Verify real-time updates append new interactions as agent responds

> Full testing details: `../testing/interactions-tab.md`

---

## 18. References

- Design docs:
  - `/Users/sainathbhima/Downloads/2026-03-30-turns-tab-design.md` (641 lines, full spec)
  - `docs/specs/crawl-together-interaction-tests.md` (related pattern testing, not directly about Interactions tab)
- Related feature docs:
  - `docs/features/observatory.md` (parent feature, if exists)
- Architecture references:
  - `apps/studio/src/store/observatory-store.ts` (trace event store)
  - `apps/studio/src/store/session-store.ts` (session message store)
  - `apps/runtime/src/services/execution/trace-helpers.ts` (trace event emission and verbosity control)
