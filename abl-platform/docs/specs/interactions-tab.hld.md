# HLD: Interactions Tab

**Feature Spec**: `docs/features/interactions-tab.md`
**Test Spec**: `docs/testing/interactions-tab.md`
**Status**: DRAFT
**Author**: System (Retroactive HLD for implemented feature)
**Date**: 2026-04-02

---

## 1. Problem Statement

Agent developers and support engineers debugging agent execution face three critical problems:

1. **No clear narrative** — raw trace events are flat lists with no story. Developers must manually reconstruct the interaction flow from timestamps and event correlations.
2. **Missing context** — LLM token usage, cost, memory state changes, and guardrail checks are invisible in existing debug tools.
3. **Bad UX** — too much noise, no way to focus on what matters. Error diagnosis requires correlating events across multiple tabs (Traces, Data, Performance, Conversation).

Without the Interactions tab, debugging an agent session requires switching between 4-5 tabs to piece together token usage, tool calls, memory state, and conversation flow. This inefficiency slows development velocity, increases mean-time-to-resolution for bugs, and makes incident response reactive rather than proactive.

**Goal**: Provide an **interaction-centric debug panel** that presents agent execution as a clear, sequential narrative with embedded intelligence: token/cost at every level, inline guardrail status, git-style memory diffs, parallel execution swim lanes, and flow graph awareness for scripted agents.

---

## 2. Alternatives Considered

### Option A: Server-Side Event Processing

**Description**: Process trace events on the backend into aggregated interactions, expose via REST API (`GET /api/sessions/:sessionId/interactions`). Client fetches pre-processed interactions and renders UI.

**Pros**:

- Handles large sessions (1000+ interactions) efficiently
- Consistent view across multiple clients
- Can cache aggregated results in Redis
- Client memory constraints not a concern

**Cons**:

- Requires new backend service or route handlers
- Extra network latency for every load
- Real-time updates require WebSocket + polling hybrid
- Backend complexity (event processor must be maintained in two places)
- No benefit for typical sessions (10-50 interactions)

**Effort**: L (2-3 weeks — new API routes, caching layer, event processor port to backend)

### Option B: Client-Side Event Processing (CHOSEN)

**Description**: Process trace events entirely in the browser using React `useMemo` hooks. Read from existing `ObservatoryStore`, group events into interactions client-side, render with Framer Motion.

**Pros**:

- **Zero backend changes** — no new API endpoints, no service modifications
- **Instant updates** — leverages existing WebSocket for real-time event streaming
- **Simple architecture** — single source of truth (ObservatoryStore), no caching logic
- **Fast iteration** — UI changes don't require backend deploys
- **Leverages existing infrastructure** — WebSocket, stores, trace event schema

**Cons**:

- Client memory constraints (500+ interactions may need virtualization)
- Processing happens on every render (mitigated by `useMemo` dependency tracking)
- Large sessions (1000+ interactions) may cause UI lag
- Cannot offload computation to backend for heavy sessions

**Effort**: S (1-2 weeks — event processor, React components, unit tests)

### Option C: Hybrid (Backend Aggregation + Client Rendering)

**Description**: Backend pre-aggregates high-level summaries (interaction count, token totals, guardrail pass/fail counts) via REST API. Client fetches summaries, then fetches full events on-demand when user expands an interaction.

**Pros**:

- Best of both worlds for large sessions
- Summary loads instantly, detail loads on-demand
- Can paginate interactions (load first 50, then more on scroll)

**Cons**:

- Most complex architecture
- Requires new API endpoints (`/interactions/summary`, `/interactions/:id/steps`)
- Cache invalidation logic for real-time updates
- Waterfall loading (summary → detail) increases perceived latency
- Unclear benefit for typical sessions (10-50 interactions)

**Effort**: L (3-4 weeks — backend aggregation, caching, client pagination, WebSocket delta updates)

### Recommendation: Option B (Client-Side Event Processing)

**Rationale**: For the target use case (internal debugging tool, typical sessions 10-50 interactions, rare >100), client-side processing is the simplest, fastest-to-ship solution. Zero backend changes means zero deployment risk, zero service coupling, and maximum iteration speed. The performance trade-off (client memory) is acceptable given:

- Optimization already in place (switchMap limited to 100 interactions)
- Virtualization path is clear for future scaling (React Virtuoso)
- Real-time WebSocket updates are instant without backend coordination

If user research shows >50% of debug sessions exceed 500 interactions, re-evaluate Option C (hybrid).

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Studio (Browser)                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Observatory Debug Panel                  │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │ Traces Tab   │  │ Interactions │  │ Performance  │   │   │
│  │  │              │  │     Tab      │  │     Tab      │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │   │
│  │           │                │                │             │   │
│  │           └────────────────┴────────────────┘             │   │
│  │                            │                              │   │
│  │                    ┌───────▼────────┐                     │   │
│  │                    │ObservatoryStore│ (zustand)           │   │
│  │                    │  .events[]     │                     │   │
│  │                    └───────▲────────┘                     │   │
│  └────────────────────────────┼──────────────────────────────┘   │
│                               │                                  │
│                    ┌──────────▼──────────┐                       │
│                    │ WebSocketContext    │                       │
│                    │ (receives trace     │                       │
│                    │  events from        │                       │
│                    │  Runtime)           │                       │
│                    └──────────▲──────────┘                       │
└───────────────────────────────┼──────────────────────────────────┘
                                │ WebSocket
                    ┌───────────▼──────────┐
                    │     Runtime          │
                    │  (emits trace events │
                    │   during execution)  │
                    └──────────────────────┘
```

### Component Diagram (Interactions Tab)

```
┌─────────────────────────────────────────────────────────────────┐
│                      InteractionsTab.tsx                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  const events = useObservatoryStore(s => s.events)       │   │
│  │  const processed = useMemo(() =>                         │   │
│  │    processEventsToInteractions(events), [events])        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                               │                                  │
│                               ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │           event-processor.ts                             │   │
│  │  • groupByUserMessage()                                  │   │
│  │  • buildInteraction()                                    │   │
│  │  • buildSummary() (token totals, guardrail counts)       │   │
│  │  • buildAgentPath() (agent enter/exit tracking)          │   │
│  │  • detectParallelExecution() (overlapping time ranges)   │   │
│  └──────────────────────────────────────────────────────────┘   │
│                               │                                  │
│                               ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Rendered Components:                                    │   │
│  │  • SessionHeader (aggregate stats)                       │   │
│  │  • InteractionCard[] (collapsible)                       │   │
│  │    ├─ TokenBadge (per-call, per-interaction)             │   │
│  │    ├─ GuardrailPanel/GuardrailCompact                    │   │
│  │    ├─ MemoryDiff (git-style diffs)                       │   │
│  │    ├─ SwimLaneTimeline (parallel tool calls)             │   │
│  │    └─ FlowBreadcrumb (scripted agents)                   │   │
│  │  • AgentSwitchBanner (between interactions)              │   │
│  │  • SessionResolutionFooter                               │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

**Step-by-step data flow for a live debugging session:**

1. **Agent execution begins** in Runtime
   - Runtime executes agent logic (LLM calls, tool calls, state transitions)
   - Trace helpers emit events: `user_message`, `llm_call`, `tool_call`, `guardrail_check`, `flow_transition`, etc.

2. **Events stream to Studio via WebSocket**
   - Runtime serializes trace events to JSON
   - WebSocket connection pushes events to Studio (ws://localhost:5173/ws)
   - `WebSocketContext` receives events via `onmessage` handler

3. **Events stored in ObservatoryStore**
   - `WebSocketContext` dispatches to `ObservatoryStore.addEvent(event)`
   - Store appends event to `events[]` array (mutable state)
   - All Observatory tabs (Traces, Interactions, Performance) read from same store

4. **InteractionsTab processes events**
   - `useObservatoryStore((s) => s.events)` subscribes to store updates
   - `useMemo(() => processEventsToInteractions(events), [events])` triggers on new events
   - `event-processor.ts` groups events by user_message boundaries
   - Filters out pure-init interactions (no user_input or agent_response)
   - Builds interaction objects with steps, summaries, agent path, switches

5. **UI renders interactions**
   - React renders `SessionHeader` with aggregate stats
   - Maps `interactions[]` to `<InteractionCard>` components
   - Each card conditionally renders step details (only when expanded)
   - Framer Motion handles expand/collapse animations

6. **Real-time updates**
   - New events trigger store update → `useMemo` dependency → re-process → re-render
   - Only changed interactions re-render (React.memo + key stability)
   - UI stays responsive during high-traffic sessions (10+ events/second)

**For historical session analysis:**

1. User selects completed session from session list
2. Studio fetches session data + messages from REST API
3. Studio fetches trace events from MongoDB via `GET /api/traces?sessionId=...`
4. Events loaded into `ObservatoryStore.events` (batch load)
5. InteractionsTab processes full event array once
6. UI renders complete timeline (no incremental updates)

### Sequence Diagram

```sequence
Runtime->WebSocket: Emit trace event (llm_call)
WebSocket->WebSocketContext: onmessage(event)
WebSocketContext->ObservatoryStore: addEvent(event)
ObservatoryStore->InteractionsTab: trigger useObservatoryStore update
InteractionsTab->event-processor: processEventsToInteractions(events)
event-processor->InteractionsTab: return { interactions, summary }
InteractionsTab->InteractionCard: render interaction cards
InteractionCard->User: Display collapsible interaction UI
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Inherited from ObservatoryStore. Trace events are scoped by `tenantId` at storage level (MongoDB). InteractionsTab does not implement isolation logic — relies on store-level filtering. Studio already enforces session-level isolation (user can only load sessions they own or have project access to).                     |
| 2   | **Data Access Pattern** | Read-only consumer. No mutations. Data flow: MongoDB → REST API → ObservatoryStore → InteractionsTab (via zustand hooks). No caching layer (events cached in store). No repository abstraction (direct store access). ObservatoryStore handles WebSocket updates + historical fetches.                                         |
| 3   | **API Contract**        | No API endpoints exposed. **Consumer-only contract**: InteractionsTab expects trace events with: `{ type, timestamp, sessionId, agentName, data, metadata }`. Token data in `data.usage.{inputTokens,outputTokens}` or fallback to `data.tokensIn/tokensOut`. Event-to-step mapping in `constants.ts` (extensible via lookup). |
| 4   | **Security Surface**    | No new attack surface. Inherits Studio's existing auth (JWT via requireAuth middleware). Trace events may contain PII/sensitive data — tab **surfaces** this data (does not redact). No XSS risk (React escapes by default). No SSRF risk (no external fetches). No CSRF risk (read-only, no mutations).                       |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **Client-side errors**: Caught by `<InteractionsErrorBoundary>`. Displays fallback UI ("Error loading interactions. Try refreshing.") instead of crashing debug panel. Errors logged to browser console. **Missing data**: Graceful degradation (missing tokens → show "N/A", missing guardrails → omit section). **User experience**: Non-blocking — other Observatory tabs continue to work if Interactions fails. |
| 6   | **Failure Modes** | **WebSocket disconnect**: Events stop streaming, tab shows stale data. User must refresh. **Event processing error**: Error boundary prevents cascade. **Large session (1000+ interactions)**: UI may lag. Mitigated by switchMap limit (100 interactions) + virtualization (future). **Trace event schema mismatch**: Unknown event types ignored (extensible EVENT_TO_STEP lookup).                                |
| 7   | **Idempotency**   | Not applicable (read-only, no mutations). Event processor is pure function (same events → same interactions). Re-processing on every render is safe (memoized).                                                                                                                                                                                                                                                      |
| 8   | **Observability** | **Observability tool itself** — does not emit trace events. **Client-side errors**: Logged to browser console via error boundary. **Performance monitoring**: No built-in metrics. Use browser DevTools (React DevTools Profiler, Chrome Performance tab). **Event volume logging**: Console warning if >500 events or processing >100ms (event-processor.ts).                                                       |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Processing latency**: <100ms for 500 events (warning logged if exceeded). **Memory**: switchMap limited to 100 agent switches (~2MB). All interactions still rendered (virtualization deferred to GAP-003). **Payload size**: Trace events fetched from REST API (no size limit, but typical sessions <5MB). **Batch limits**: Not applicable (no batch mutations). **UI render**: Only expanded interactions render step details. **Real-time**: 10+ events/second is "high-traffic".                                                                                                                            |
| 10  | **Migration Path**     | **Current state**: Feature did not exist. Users manually correlated events across Traces/Data/Performance tabs. **Target state**: Interactions tab provides unified view. **Transition**: No migration — purely additive. No data migrations. Runtime can emit new trace event types (e.g., gather_start) incrementally. **Rollback**: Revert Studio deployment (no backend changes to rollback).                                                                                                                                                                                                                   |
| 11  | **Rollback Plan**      | **Strategy**: Revert Studio deployment to prior commit. **Data**: No database changes (consumes existing trace schema). **Runtime dependency**: New trace event types are optional (graceful degradation if missing). **Blast radius**: Isolated to Interactions tab (error boundary prevents cascade). **Testing**: Verify other Observatory tabs unaffected.                                                                                                                                                                                                                                                      |
| 12  | **Test Strategy**      | **Unit tests** (70-80% coverage): Event processor, token calculation, memory diff, parallel detection, flow DSL (6 test files). **Integration tests** (0 implemented, 8 scenarios specified): Event grouping, token aggregation, agent path, lifecycle banners, session resolution. **E2E tests** (0 implemented, 5 scenarios specified): Load session, real-time updates, parallel viz, flow graphs, guardrails. **Note**: Feature currently at ALPHA status (GAP-001). Integration and E2E tests required for BETA promotion. See test spec for prioritized scenarios (INT-1, INT-2, INT-6, E2E-1, SEC-1, SEC-2). |

---

## 5. Data Model

### New Collections/Tables

**None**. The Interactions tab does not introduce new database collections.

### Modified Collections/Tables

**None**. The Interactions tab reads from existing collections without modifications:

- **`traces`** (MongoDB) — stores trace events emitted by Runtime
  - Fields consumed: `type`, `timestamp`, `sessionId`, `agentName`, `data`, `metadata`
  - Token data: `data.usage.inputTokens`, `data.usage.outputTokens` (or `data.tokensIn`, `data.tokensOut`)
  - No schema changes required
  - New event types (e.g., `gather_start`, `gather_complete`) are added by Runtime, not by Studio

### Key Relationships

- **Trace events → Session**: Each trace event has `sessionId` (foreign key to `sessions` collection)
- **Trace events → Agent**: Each trace event has `agentName` (logical grouping, not enforced FK)
- **Messages → Session**: InteractionsTab enriches agent_response steps with message content from `SessionStore.messages` (in-memory join)

---

## 6. API Design

### New Endpoints

**None**. The Interactions tab does not expose new HTTP endpoints.

### Modified Endpoints

**None**. The Interactions tab does not modify existing endpoints.

### Trace Event Schema (Consumer Contract)

The Interactions tab **consumes** trace events from Runtime. Expected schema:

```typescript
interface TraceEvent {
  type: string; // e.g., 'user_message', 'llm_call', 'tool_call', 'guardrail_check'
  timestamp: Date; // ISO 8601 string
  sessionId: string; // UUID
  agentName: string; // e.g., 'customer-support'
  data: Record<string, unknown>; // Event-specific payload
  metadata: Record<string, unknown>; // Optional metadata
}
```

**Token data** (for `llm_call` events):

- **Primary**: `data.usage.inputTokens`, `data.usage.outputTokens`
- **Fallback**: `data.tokensIn`, `data.tokensOut`
- **Legacy fallback**: `data.promptTokens`, `data.completionTokens` (backward compatibility)

**Guardrail data** (for `guardrail_*` events):

- `data.checks` — array of guardrail check results
- Each check: `{ type, status, confidence, message }`

**Flow data** (for scripted agents):

- `flow_transition` — `data.fromStep`, `data.toStep`, `data.condition`
- `decision` — `data.branch`, `data.evaluation`
- `gather_start`, `gather_complete` — `data.fields`, `data.confidence`

**Event-to-step mapping** (`constants.ts`):

```typescript
export const EVENT_TO_STEP: Record<string, InteractionStepType> = {
  user_message: 'user_input',
  llm_call: 'reasoning',
  tool_call: 'tool',
  guardrail_check: 'guardrail',
  flow_transition: 'flow_step',
  // ... 30+ event types
};
```

### Error Responses

**Not applicable** — the Interactions tab does not expose API endpoints. Client-side errors are handled by error boundary.

---

## 7. Cross-Cutting Concerns

### Audit Logging

**Not applicable**. The Interactions tab is read-only. No mutations are logged.

### Rate Limiting

**Not applicable**. No API endpoints exposed. WebSocket rate limiting is handled by Runtime/Studio infrastructure (not Interactions-specific).

### Caching

**Strategy**: Events cached in `ObservatoryStore` (zustand in-memory state).

- **Real-time sessions**: Events accumulate in store as WebSocket pushes them
- **Historical sessions**: Batch-loaded from REST API, stored in ObservatoryStore
- **TTL**: Not applicable (store cleared when user navigates away from session)
- **Invalidation**: Not needed (events are append-only, no mutations)

### Encryption

- **At rest**: Trace events stored in MongoDB (encryption-at-rest configured at DB level, not feature-specific)
- **In transit**: WebSocket connection uses WSS in production (TLS 1.2+)
- **Client-side**: No encryption (events stored in browser memory unencrypted)

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency       | Type             | Risk                                                                                                                |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| ObservatoryStore | Internal (store) | **HIGH** — If store changes schema, InteractionsTab breaks. Mitigation: Shared types, comprehensive unit tests      |
| SessionStore     | Internal (store) | **LOW** — Only used for message enrichment (optional). Graceful degradation if messages missing                     |
| WebSocketContext | Internal (infra) | **MEDIUM** — If WebSocket breaks, no real-time updates. Mitigation: Historical traces still load from REST API      |
| Runtime          | Internal (svc)   | **HIGH** — Must emit trace events at `standard` verbosity. Mitigation: Graceful degradation for missing event types |
| Framer Motion    | External (npm)   | **LOW** — Used for animations only. If removed, tab still functional (no animations)                                |
| Design Tokens    | Internal (pkg)   | **LOW** — Styling only. If broken, visual issues but no functional breakage                                         |
| MongoDB (traces) | Internal (db)    | **HIGH** — Historical trace loading depends on DB. No mitigation (core platform dependency)                         |

### Downstream (depends on this feature)

**None**. No other features depend on the Interactions tab. It is a pure consumer (no exports used by other packages).

---

## 9. Open Questions & Decisions Needed

1. **Virtualization threshold**: At what interaction count should we enable virtualization? 500? 1000? Need user research on typical session sizes.

2. **Trace event schema versioning**: Should we add a `schemaVersion` field to trace events? If Runtime changes event structure, how does Studio detect incompatibility? (GAP-006)

3. **Export functionality**: Should v2 include "Download as JSON" or "Share debug link"? What format? (GAP-002)

4. **Real-time throttling**: For high-traffic sessions (10+ events/second), should we batch updates every 200ms to avoid UI thrashing?

5. **Memory diff depth**: Should we support nested object diffs beyond top-level keys? Current implementation only diffs `Object.keys(state)` at root level. (GAP-009)

6. **Guardrail permissions**: Should we add granular permissions for viewing guardrail results? Currently, all users who can view a session can see guardrail data. (GAP-007)

7. **Context window model registry**: Should `ContextWindowBar` read model limits from a dynamic registry instead of hardcoded constants? (GAP-008)

---

## 10. References

- **Feature spec**: `docs/features/interactions-tab.md`
- **Test spec**: `docs/testing/interactions-tab.md`
- **Design doc**: `/Users/sainathbhima/Downloads/2026-03-30-turns-tab-design.md` (641 lines)
- **Implementation**: `apps/studio/src/components/observatory/interactions/`
- **Event processor**: `apps/studio/src/components/observatory/interactions/event-processor.ts`
- **Types**: `apps/studio/src/components/observatory/interactions/types.ts`
- **Constants**: `apps/studio/src/components/observatory/interactions/constants.ts`
- **Related HLDs**: None (first Observatory tab to have retroactive HLD)
