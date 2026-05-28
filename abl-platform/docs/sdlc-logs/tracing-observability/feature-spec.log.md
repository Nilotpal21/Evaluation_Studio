# SDLC Log: Tracing & Observability -- Feature Spec

**Phase:** Feature Spec (Phase 1)
**Date:** 2026-03-22
**Status:** Complete

## Process

### Codebase Exploration

Explored 20+ source files across 4 packages and 2 apps to ground the feature spec in code reality:

**Packages:**

- `packages/observatory/src/schema/trace-events.ts` -- 30+ event types, ExtendedTraceEvent, W3C IDs
- `packages/observatory/src/schema/spans.ts` -- Span, SpanBuilder, SpanManager, TraceTree
- `packages/observatory/src/protocol/types.ts` -- Debug protocol (16 commands, 15 events)
- `packages/observatory/src/protocol/debug-server.ts` -- WebSocket debug server on port 9229

**Runtime:**

- `apps/runtime/src/services/trace-store.ts` -- Memory TraceStore (ring buffer 500/session, 50K sessions)
- `apps/runtime/src/services/trace/redis-trace-store.ts` -- Redis Streams + Pub/Sub, memory pressure circuit breaker
- `apps/runtime/src/services/trace-emitter.ts` -- Unified emission pipeline (WS + TraceStore + EventStore)
- `apps/runtime/src/services/execution/trace-helpers.ts` -- 4-tier verbosity gating
- `apps/runtime/src/services/execution/trace-forwarder.ts` -- Construct-layer bridge
- `apps/runtime/src/services/eventstore-singleton.ts` -- ClickHouse backend with WAL
- `apps/runtime/src/services/trace-event-types.ts` -- Platform event type mapping
- `apps/runtime/src/services/debug-integration.ts` -- Debug runtime wrapper
- `apps/runtime/src/observability/otel-setup.ts` -- Full OTEL SDK (traces, metrics, logs)
- `apps/runtime/src/observability/otel-trace-bridge.ts` -- TraceStore -> OTEL bridge
- `apps/runtime/src/observability/metrics.ts` -- 12 metric instruments

**Studio:**

- `apps/studio/src/store/trace-store.ts` -- Zustand store, 1000 event cap
- `apps/studio/src/store/observatory-store.ts` -- Spans, flow graph, metrics, debug state

**Docs:**

- `docs/observatory/README.md` -- 18 API endpoints, 9 data types, 19 gaps (9 fixed)
- `docs/plans/2026-03-10-unified-observability-design.md` -- Decision log merge
- `docs/observatory/PLATFORM_OBSERVABILITY_ROADMAP.md` -- Two-level architecture

### Decisions

| ID  | Decision                                                                             | Classification |
| --- | ------------------------------------------------------------------------------------ | -------------- |
| D1  | All 18 sections grounded in actual source code, not imagined APIs                    | DECIDED        |
| D2  | Event type taxonomy derived from actual `ALL_TRACE_EVENT_TYPES` + Studio `ALL_TYPES` | DECIDED        |
| D3  | Storage tier model based on actual Memory/Redis/ClickHouse/EventStore chain          | DECIDED        |
| D4  | Verbosity levels from actual `VERBOSITY_LEVELS` constant                             | DECIDED        |
| D5  | API surface from actual `docs/observatory/README.md` endpoint inventory              | DECIDED        |
| D6  | Configuration env vars from actual `process.env` reads in source                     | DECIDED        |

### Output

- Feature spec: `docs/features/tracing-observability.md` (18 sections)
- 10 user stories with acceptance criteria
- Data model grounded in 4 actual TypeScript interfaces
- 30+ event types from actual codebase taxonomy
- 18 REST API endpoints from actual observatory spec
- 10 configuration variables from actual env var reads
- 8 open questions documented
