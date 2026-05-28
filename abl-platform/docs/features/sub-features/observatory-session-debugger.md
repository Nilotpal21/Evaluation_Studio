# Feature: Observatory Session Debugger

**Doc Type**: SUB-FEATURE
**Parent Feature**: Tracing & Observability
**Status**: BETA
**Feature Area(s)**: `observability`, `customer experience`, `admin operations`
**Package(s)**: `apps/studio`, `@agent-platform/observatory`, `@agent-platform/shared-kernel`
**Owner(s)**: `Studio team`, `Platform team`
**Testing Guide**: [docs/testing/sub-features/observatory-session-debugger.md](../../testing/sub-features/observatory-session-debugger.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

Studio's current Observatory session debugger is useful but structurally inconsistent. The Traces tab, span tree, waterfall summary, session overview tree, and detail views do not share one domain model. Selection is split across `ui-store`, `observatory-store`, and `trace-store`; cost and token aggregation are recomputed in multiple components; step span closure still uses heuristics; and some UI surfaces render the same detail data twice.

The result is flaky behavior that operators can feel directly: stale or incorrect parent/child span relationships, ghost selection, mismatched metrics between panels, split-focus detail views, and live-vs-replay differences that make debugging less trustworthy.

### Goal Statement

The goal of the Observatory Session Debugger redesign is to make Studio's trace-inspection experience deterministic, coherent, and testable by moving it to a single-source observability domain model with immutable event normalization, exact span lifecycle tracking, shared selectors, and one canonical detail surface per selection.

### Summary

Observatory Session Debugger is the Studio-facing debugging surface for live and historical session traces. It powers the Traces tab, span tree, waterfall summary, node detail panel, and the selection bridge between session-overview structures and span/event detail views.

This sub-feature builds on the platform-wide tracing pipeline documented in the parent feature, but focuses specifically on the Studio experience. The redesign is not a visual reskin. It is an architectural cleanup of how Studio ingests, stores, derives, and renders trace data.

The target design has four core properties:

- trace events are normalized once at the boundary and never mutated in place
- one feature store owns Observatory events, spans, selection, and expand/collapse state
- selectors derive tree, metrics, and detail view models exactly once
- components become mostly presentational and stop owning business logic

### Key Capabilities

- Live and replay trace ingestion with the same canonical event normalization rules
- Deterministic parent/child span relationships for agents and flow steps
- Single, consistent cost/token/latency aggregation across summary, tree, and detail views
- Clear selection ownership for spans, events, and execution-tree nodes
- Keyboard-navigable span trees that respect expand/collapse visibility
- One canonical detail surface for span inspection instead of duplicated inline and docked panels

---

## 2. Scope

### Goals

- Give Studio Observatory one source of truth for normalized events, spans, selection, and derived view state.
- Make live sessions and replayed sessions render the same hierarchy and metrics for the same trace data.
- Replace heuristic span matching with exact registry-based lifecycle bookkeeping.
- Remove duplicate metric computation and duplicate detail rendering from the Traces tab.
- Make the redesigned debugger easy to test through pure logic/store suites and focused component tests.

### Non-Goals (Out of Scope)

- This redesign does not change the platform-wide trace vocabulary or ClickHouse schema on its own.
- This redesign does not replace the broader Studio session page or redesign unrelated tabs outside Observatory.
- This redesign does not require a runtime protocol rewrite, though it can benefit from future runtime improvements such as explicit step-instance IDs.

---

## 3. User Stories

1. As a Studio operator, I want the same span hierarchy and metrics no matter whether I am watching a live run or a replayed session so that I can trust what the debugger is telling me.
2. As a developer, I want one deterministic place to reason about Observatory state so that UI fixes do not require touching three stores and several duplicated calculations.
3. As a QA or support engineer, I want keyboard navigation, selection, and detail rendering to behave predictably so that regressions are easy to verify and reproduce.

---

## 4. Functional Requirements

1. **FR-1**: The system must normalize trace events exactly once at the Studio ingestion boundary and prefer canonical top-level IDs over mirrored payload fields.
2. **FR-2**: The system must keep Observatory event ownership in one feature store rather than duplicating event data across multiple stores.
3. **FR-3**: The system must track active agent spans and active step spans through deterministic indexes keyed by agent and step identity, not by global "latest running span" heuristics.
4. **FR-4**: The system must expose explicit selection state for the debugger surfaces it owns and must not overload one raw ID field to represent spans, events, and synthetic execution-tree nodes.
5. **FR-5**: The system must compute cost, token, and latency metrics through shared selectors so every Observatory surface shows the same totals for the same span or session.
6. **FR-6**: The system must render a single canonical detail surface for span inspection in the Traces tab.
7. **FR-7**: The system must flatten only visible tree nodes for keyboard navigation and must avoid hidden or ghost selections under collapsed parents.
8. **FR-8**: The system must support incremental migration so legacy imports can be redirected without a one-shot big-bang rewrite.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                  |
| -------------------------- | ------------ | ---------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Session debugging happens inside project-scoped Studio workflows.      |
| Agent lifecycle            | PRIMARY      | Agent enter/exit, flow steps, and handoffs are the core debug model.   |
| Customer experience        | SECONDARY    | Operators use the debugger to resolve end-user-facing failures faster. |
| Integrations / channels    | SECONDARY    | Live and replay traces arrive from Runtime/WebSocket and REST paths.   |
| Observability / tracing    | PRIMARY      | This is the Studio debugger surface for the tracing feature.           |
| Governance / controls      | SECONDARY    | Trustworthy debugging reduces operational ambiguity and audit drift.   |
| Enterprise / compliance    | NONE         | The redesign is UI/state architecture, not a compliance feature.       |
| Admin / operator workflows | PRIMARY      | This is an operator-facing debugging surface.                          |

### Related Feature Integration Matrix

| Related Feature                                        | Relationship Type | Why It Matters                                                                  | Key Touchpoints                                 | Current State        |
| ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------- |
| [Tracing & Observability](../tracing-observability.md) | extends           | The debugger consumes the trace pipeline defined by the parent feature.         | `TraceEvent`, WebSocket replay, session APIs    | Active integration   |
| [Memory & Session Management](../memory-sessions.md)   | shares data with  | Session detail views combine messages, execution trees, and Observatory traces. | session detail page, trace replay, overview tab | Active integration   |
| [MCP Support](../mcp-support.md)                       | tested with       | MCP debug workflows depend on the Studio debugger staying trustworthy.          | trace analysis, live session debugging          | Indirect integration |

---

## 6. Design Considerations (Optional)

- The Traces tab should behave like a master-detail debugger: the tree is the navigation surface and the detail panel is the inspection surface.
- Inline detail expansion inside the tree is intentionally removed from the target design because it competes with the docked panel and collapses the available viewport.
- Keyboard behavior must match the visible tree. Arrow navigation should never move selection into a collapsed branch.
- The redesign should preserve the existing Studio visual language; the work is primarily architectural and interaction-focused.

---

## 7. Technical Considerations (Optional)

- The current groundwork already includes an immutable trace adapter at [apps/studio/src/utils/trace-event-adapter.ts](../../../apps/studio/src/utils/trace-event-adapter.ts) and a live ingestion seam at [apps/studio/src/utils/live-trace-event-ingestion.ts](../../../apps/studio/src/utils/live-trace-event-ingestion.ts). The redesign should build on those seams rather than reintroducing inline normalization in components or contexts.
- The long-term target is a dedicated `apps/studio/src/features/observatory/` module with pure domain helpers, selectors, and a compatibility layer for legacy imports.
- `trace-store` should stop owning Observatory events. During migration it may survive only as a compatibility facade or filter-state shell, but event authority should move to the feature store.
- `ui-store` should stop owning `selectedTraceNodeId`. Generic shell state can remain there, but Observatory selection belongs to the Observatory feature.

---

## 8. How to Consume

### Studio UI

Primary entry points:

- Session detail Traces tab in Studio
- Live debug panel / Observatory surfaces
- Span tree, waterfall summary, and node detail panel
- Session overview bridge points that need explicit links into span or event detail

The target interaction model is:

1. trace data enters Studio through live WebSocket messages or replayed session responses
2. the Observatory feature store ingests normalized events
3. selectors derive tree, metrics, and detail view models
4. presentational components render those view models without recomputing domain logic

### API (Runtime)

| Method | Path / Message                                               | Purpose                                     |
| ------ | ------------------------------------------------------------ | ------------------------------------------- |
| WS     | `/ws`                                                        | Live session connection for trace streaming |
| WS msg | `{ type: 'trace_event', sessionId, event }`                  | Live trace event delivery                   |
| WS msg | `{ type: 'trace_replay', sessionId, events, totalBuffered }` | Historical replay hydration                 |

### API (Studio)

| Method | Path                       | Purpose                                       |
| ------ | -------------------------- | --------------------------------------------- |
| GET    | `/api/sessions/:sessionId` | Load session detail and replayable trace data |

### Admin Portal

There is no separate Admin surface for this sub-feature. Operators use it through Studio.

### Channel / SDK / Voice / A2A / MCP Integration

This debugger is channel-agnostic at the UI layer. It consumes the normalized trace stream emitted by Runtime regardless of whether the execution originated from chat, voice, SDK, or multi-agent handoff flows.

---

## 9. Data Model

### Client-Side Domain State

```text
State Slice: observatory_feature_state
Fields:
  - eventsById: Map<string, NormalizedTraceEvent>
  - orderedEventIds: string[]
  - spansById: Map<string, SpanRecord>
  - selection:
      - activeSpanId: string | null
      - activeEventId: string | null
      - activeExecutionNodeId: string | null
  - expandedSpanIds: Set<string>
  - activeAgentSpanIdsByAgent: Map<string, string[]>
  - activeStepSpanIdsByAgentStep: Map<string, string[]>
  - flowNodes / flowEdges: derived or explicitly stored execution graph state
Derived Selectors:
  - visibleSpanTree
  - visibleSpanIds
  - sessionSummaryMetrics
  - selectedSpanViewModel
  - selectedEventViewModel
```

### Key Relationships

- `NormalizedTraceEvent.spanId` attaches an event to a span record.
- `SpanRecord.parentSpanId` forms the span tree.
- `activeAgentSpanIdsByAgent` and `activeStepSpanIdsByAgentStep` are lifecycle indexes used to start and end the correct running span.
- `activeExecutionNodeId` references session-overview nodes and must not be mixed with `spanId` or `eventId`.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                    | Purpose                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/studio/src/utils/trace-event-adapter.ts`          | Existing canonical event adapter used as groundwork for unified normalization    |
| `apps/studio/src/utils/live-trace-event-ingestion.ts`   | Existing live ingestion seam to route into the feature store                     |
| `apps/studio/src/store/observatory-store.ts`            | Current monolithic Observatory state owner to be strangled into a feature module |
| `apps/studio/src/store/trace-store.ts`                  | Legacy duplicated trace store that should lose Observatory event ownership       |
| `apps/studio/src/store/ui-store.ts`                     | Legacy generic UI store that currently owns span selection                       |
| `apps/studio/src/features/observatory/store.ts`         | Planned single-source Observatory feature store                                  |
| `apps/studio/src/features/observatory/selectors.ts`     | Planned shared selector layer for tree, metrics, and detail panels               |
| `apps/studio/src/features/observatory/span-registry.ts` | Planned deterministic span lifecycle helpers                                     |

### UI Components

| File                                                         | Purpose                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/studio/src/components/observatory/DebugTabs.tsx`       | Current Traces tab composition and detail panel host              |
| `apps/studio/src/components/observatory/WaterfallPanel.tsx`  | Summary bar and tree container                                    |
| `apps/studio/src/components/observatory/SpanTree.tsx`        | Span hierarchy renderer; currently mixes rendering and derivation |
| `apps/studio/src/components/observatory/NodeDetailPanel.tsx` | Canonical detail panel that should remain the sole detail surface |
| `apps/studio/src/components/session/OverviewTab.tsx`         | Session overview that currently shares overloaded selection state |
| `apps/studio/src/components/session/AgentExecutionTree.tsx`  | Execution tree that currently mixes event IDs and span IDs        |

### Tests

| File                                                                 | Type        | Coverage Focus                                          |
| -------------------------------------------------------------------- | ----------- | ------------------------------------------------------- |
| `apps/studio/src/__tests__/trace-event-adapter.test.ts`              | unit        | canonical top-level ID precedence and fallback behavior |
| `apps/studio/src/__tests__/live-trace-event-ingestion.test.ts`       | unit        | live ingestion preserves canonical IDs and hierarchy    |
| `apps/studio/src/__tests__/observatory-span-end.test.ts`             | unit        | span end handling                                       |
| `apps/studio/src/store/__tests__/observatory-span-lifecycle.test.ts` | unit        | span lifecycle invariants                               |
| `apps/studio/src/__tests__/e2e/observatory-trace-flow.test.ts`       | integration | end-to-end Observatory trace flow                       |

---

## 11. Configuration

### Environment Variables

No feature-specific environment variables are required for the Studio-side redesign.

### Runtime Configuration

- Studio tests should continue using the split runner:
  - `pnpm --filter @agent-platform/studio test`
  - `pnpm -C apps/studio exec vitest run --config vitest.node.config.ts ...`
- The redesign may introduce a temporary feature flag if a staged rollout is needed, but that is not required for the architectural plan.

### DSL / Agent IR / Schema

This sub-feature consumes emitted trace events and does not define new DSL or IR schema.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

The debugger is read-only on the Studio side and relies on existing Runtime/Studio session access controls. The redesign must not bypass the existing project and tenant isolation already enforced by the parent tracing/session APIs.

### Security & Compliance

The redesign must preserve the current boundary that only authorized Studio users can fetch or subscribe to session traces. It must also avoid in-place mutation of trace payloads so downstream consumers do not observe unexpected data shape changes.

### Performance & Scalability

- Tree, summary, and detail selectors should derive from normalized state once rather than recomputing per component.
- Expanded/collapsed tree navigation should operate on visible-node selectors rather than walking all descendants on every keypress.
- Any new in-memory maps or sets must remain bounded and cleared on session reset.

### Reliability & Failure Modes

- If a live event arrives without complete span metadata, the boundary normalizer may synthesize a fallback span ID, but it must do so deterministically.
- If a parent span is missing during replay, the UI should degrade by rendering the span as a root rather than silently dropping it.
- Session reset must clear all Observatory selection and registry indexes together.

### Observability

This feature is itself part of the observability surface. The key quality signal is parity: live and replayed traces should produce the same view models for the same input event stream.

### Data Lifecycle

Observatory feature state is bounded in memory and cleared on session reset or navigation away from the active debugging context. Historical durability remains the responsibility of the underlying tracing/event pipeline.

---

## 13. Delivery Plan / Work Breakdown

1. Establish the unified Observatory feature module and keep compatibility adapters for current imports.
   1.1 Move normalization and ingestion helpers behind the feature boundary.
   1.2 Introduce one Observatory feature store with explicit selection slots and lifecycle indexes.
2. Replace heuristic span lifecycle and duplicated metric derivation.
   2.1 Add deterministic agent-step span registries.
   2.2 Add shared selectors for tree, visible tree, summary metrics, and detail metrics.
3. Cut over the Traces tab and session overview surfaces.
   3.1 Remove inline tree details and keep `NodeDetailPanel` as the single detail surface.
   3.2 Stop overloading one selection ID across spans, events, and execution nodes.
4. Remove legacy ownership and cleanup stale abstractions.
   4.1 Deprecate or delete duplicated event ownership in `trace-store`.
   4.2 Remove stale selection plumbing from `ui-store`.

---

## 14. Success Metrics

| Metric                                                    | Baseline                        | Target                | How Measured                                  |
| --------------------------------------------------------- | ------------------------------- | --------------------- | --------------------------------------------- |
| Span metric parity across summary, tree, and detail panel | Mismatches exist today          | 100% parity           | shared selector tests + manual fixture checks |
| Wrong or stale parent/child span rendering on replay      | Known flaky cases               | 0 known reproductions | lifecycle regression suite                    |
| Dual detail surfaces for one span selection               | 2 surfaces                      | 1 surface             | component tests + manual verification         |
| Hidden-node keyboard selection                            | Reproducible today              | 0 hidden selections   | tree interaction tests                        |
| Store ownership of Observatory events                     | 2 stores + generic UI selection | 1 feature store       | code review + integration tests               |

---

## 15. Open Questions

1. Should the redesigned detail panel become a bottom dock on wide layouts and a modal sheet on narrow layouts, or remain docked in all viewports?
2. Do we want to keep a lightweight trace-filter slice separate from the Observatory feature store, or fully absorb current `trace-store` filter state into the feature module?
3. Should Runtime eventually emit explicit step-instance IDs to replace the temporary per-agent/per-step stack registry on the Studio side?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                               | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Current Studio Observatory still has split selection ownership across `ui-store`, `observatory-store`, and `trace-store`. | High     | Open      |
| GAP-002 | Metric aggregation remains duplicated in `SpanTree`, `DebugTabs`, and `NodeDetailPanel` until the selector layer lands.   | High     | Open      |
| GAP-003 | Canonical ID normalization is fixed at the boundary, but the broader UI/state redesign is still pending.                  | Medium   | Mitigated |
| GAP-004 | The full browser-oriented component suite for the redesigned Observatory experience does not exist yet.                   | Medium   | Open      |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                 | Coverage Type | Status                             | Test File / Note                                                    |
| --- | -------------------------------------------------------- | ------------- | ---------------------------------- | ------------------------------------------------------------------- |
| 1   | Live ingestion prefers canonical top-level IDs           | unit          | PASS                               | `trace-event-adapter.test.ts`, `live-trace-event-ingestion.test.ts` |
| 2   | Replay hydration preserves parent/child span hierarchy   | unit          | PASS                               | `trace-event-adapter.test.ts`                                       |
| 3   | Span lifecycle closes the right agent/step spans         | unit          | PASS (current groundwork) / EXPAND | `observatory-span-lifecycle.test.ts`                                |
| 4   | Summary, tree, and detail metrics stay identical         | unit          | NOT TESTED                         | add selector parity suite                                           |
| 5   | Traces tab renders one detail surface per span selection | component     | NOT TESTED                         | redesign follow-up                                                  |
| 6   | Keyboard navigation stays within visible nodes           | component     | NOT TESTED                         | redesign follow-up                                                  |
| 7   | Session overview selection no longer overloads span IDs  | integration   | NOT TESTED                         | redesign follow-up                                                  |

### Testing Notes

Current coverage proves the new normalization seams and span-lifecycle groundwork, but it does not yet prove the target single-store UI architecture. The redesign should add pure logic/store tests first, then focused component tests around tree navigation and panel behavior.

> Full testing details: [docs/testing/sub-features/observatory-session-debugger.md](../../testing/sub-features/observatory-session-debugger.md)

---

## 18. References

- Design docs: `docs/specs/observatory-session-debugger-redesign.hld.md`, `docs/specs/observatory-session-debugger-redesign.lld.md`
- Implementation plan: `docs/plans/2026-03-22-observatory-session-debugger-redesign-plan.md`
- Parent feature: [Tracing & Observability](../tracing-observability.md)
- Current groundwork files: `apps/studio/src/utils/trace-event-adapter.ts`, `apps/studio/src/utils/live-trace-event-ingestion.ts`
