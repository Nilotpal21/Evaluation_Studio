# ABLP-1038 Sessions and Traces Explorer v2 Data-Flow Audit

Date: 2026-05-13

Related issues:

- ABLP-1003: https://koreteam.atlassian.net/browse/ABLP-1003
- ABLP-1004: https://koreteam.atlassian.net/browse/ABLP-1004
- ABLP-1005: https://koreteam.atlassian.net/browse/ABLP-1005

## Scope

This audit covers the cross-layer values introduced or promoted by Sessions and Traces Explorer v2:

- Session explorer filters, sorting, pagination, and URL state.
- Project-scoped trace explorer rows representing spans/execution units.
- First-class trace `environment` propagation through EventStore and ClickHouse.
- Studio proxy, hook, UI rendering, and session-detail deep-linking for selected spans.

## Layer Map

| Layer                    | Files                                                                                                                                                                                                                           | Direction                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Runtime session API      | `apps/runtime/src/routes/sessions.ts`                                                                                                                                                                                           | READ query params, query sessions, RESPOND session rows                     |
| Runtime trace API        | `apps/runtime/src/routes/traces.ts`                                                                                                                                                                                             | READ query params, query ClickHouse, enrich legacy rows, RESPOND trace rows |
| Runtime emit path        | `apps/runtime/src/services/runtime-executor.ts`, `apps/runtime/src/services/trace/emit-to-eventstore.ts`, `apps/runtime/src/services/tracing/write-pipeline.ts`                                                                 | WRITE/PASS-THROUGH environment into event payloads                          |
| Event schema             | `packages/eventstore/src/schema/platform-event.ts`                                                                                                                                                                              | DEFINE `PlatformEvent.environment`                                          |
| Event persistence mapper | `packages/eventstore/src/stores/clickhouse/clickhouse-row-mapper.ts`                                                                                                                                                            | MAP `PlatformEvent.environment` to/from ClickHouse rows                     |
| ClickHouse DDL           | `packages/eventstore/src/stores/clickhouse/platform-events-table.ts`, `packages/database/src/clickhouse-schemas/init.ts`                                                                                                        | PERSIST `environment` in base and by-session tables/views                   |
| Studio trace proxy       | `apps/studio/src/app/api/runtime/traces/route.ts`                                                                                                                                                                               | PASS-THROUGH trace filters and auth headers to runtime                      |
| Studio hooks/types       | `apps/studio/src/hooks/useSessionList.ts`, `apps/studio/src/hooks/useTraceExplorer.ts`, `apps/studio/src/types/index.ts`                                                                                                        | BUILD query strings, TYPE listing responses                                 |
| Studio UI                | `apps/studio/src/components/session/SessionsListPage.tsx`, `apps/studio/src/components/traces/TracesPage.tsx`, `apps/studio/src/components/session/SessionDetailPage.tsx`, `apps/studio/src/components/session/OverviewTab.tsx` | PRESENT filters, rows, contextual panels, and deep links                    |

## Field Propagation Matrix

| Field                      | Runtime Emit | Event Schema      | Mapper            | ClickHouse DDL | Runtime Trace Query            | Studio Proxy        | Studio Hook/Types | Studio UI           |
| -------------------------- | ------------ | ----------------- | ----------------- | -------------- | ------------------------------ | ------------------- | ----------------- | ------------------- |
| `tenantId` / `tenant_id`   | Y            | Y                 | Y                 | Y              | Y, required filter             | Y via `X-Tenant-Id` | -                 | -                   |
| `projectId` / `project_id` | Y            | Y                 | Y                 | Y              | Y, required filter             | Y path segment      | Y query param     | Y navigation scope  |
| `sessionId` / `session_id` | Y            | Y                 | Y                 | Y              | Y, returned and searched       | Y pass-through      | Y                 | Y, deep-link target |
| `traceId` / `trace_id`     | Y            | Y                 | Y                 | Y              | Y, returned and searched       | Y pass-through      | Y                 | Y, row identity     |
| `spanId` / `span_id`       | Y            | Y                 | Y                 | Y              | Y, returned and searched       | Y pass-through      | Y                 | Y, deep-link target |
| `agentName` / `agent_name` | Y            | Y                 | Y                 | Y              | Y, filtered/searched           | Y pass-through      | Y                 | Y                   |
| `environment`              | Y            | Y                 | Y                 | Y              | Y, filter plus legacy fallback | Y pass-through      | Y                 | Y                   |
| `channel`                  | Y            | Y                 | Y                 | Y              | Y, filtered                    | Y pass-through      | Y                 | Y                   |
| `type`                     | -            | event type source | Y as `event_type` | Y              | Y, derived from event types    | Y pass-through      | Y                 | Y                   |
| `status`                   | -            | error source      | Y as `has_error`  | Y              | Y, derived from error count    | Y pass-through      | Y                 | Y                   |
| `startedAt`                | Y timestamp  | Y                 | Y                 | Y              | Y, min timestamp               | Y pass-through      | Y                 | Y                   |
| `durationMs` / latency     | Y            | Y                 | Y                 | Y              | Y, range/filter/sort           | Y pass-through      | Y                 | Y                   |
| token counts               | Y in data    | Y data            | Y data            | Y data         | Y, JSON projection/sum         | Y pass-through      | Y                 | Y                   |
| `estimatedCost`            | Y in data    | Y data            | Y data            | Y data         | Y, JSON projection/sum         | Y pass-through      | Y                 | Y                   |
| `eventCount`               | -            | -                 | -                 | -              | Y, `count()`                   | Y pass-through      | Y                 | Y                   |
| `errorCount`               | -            | -                 | -                 | -              | Y, `sum(has_error)`            | Y pass-through      | Y                 | Y                   |
| `preview`                  | -            | -                 | -                 | -              | Y, event-type summary only     | Y pass-through      | Y                 | Y                   |

Legend: `Y` = handled at this layer, `-` = intentionally not applicable.

## Findings

### Trace Environment

Verdict: complete for new rows, compatible for old rows.

- Definition: `PlatformEvent.environment` is defined in `packages/eventstore/src/schema/platform-event.ts`.
- Persistence: `ClickHouseRowMapper.toRow()` and `fromRow()` map `environment`; base and by-session ClickHouse DDL include the column.
- Runtime query: `apps/runtime/src/routes/traces.ts` filters `environment = {environment}` while also allowing empty legacy rows, then enriches from `Session.environment` scoped by `{ _id, tenantId, projectId }`.
- Studio: `apps/studio/src/app/api/runtime/traces/route.ts` forwards environment filters; `useTraceExplorer` and `TracesPage` expose the filter and render the value.

Residual risk: historical ClickHouse rows without `session_id` cannot be enriched from Mongo sessions. Expected behavior is partial filterability for those rows.

### Trace Row Contract

Verdict: complete for listing use.

- Runtime returns `TraceExplorerRow` fields: trace/span/session IDs, agent, environment, channel, type, status, timestamps, latency, tokens, cost, counts, and preview.
- Raw `data` is not selected into the listing response; token/cost values are projected from JSON fields and preview is derived from event type names only.
- Studio proxy and UI pass and render the same contract without exposing raw payloads.

Residual risk: non-LLM spans may report zero token/cost values. This matches the feature assumption and should not be interpreted as unknown spend.

### Session Explorer Filters

Verdict: complete for v1 explorer filters.

- Runtime session listing handles search, agent, environment, channel, status, disposition, outcome, date range, numeric ranges, pagination, and explicit sorting.
- Studio `SessionsListPage` persists filter state in URL query params and sends server-backed fetch params through `useSessionList`.
- Session-level raw trace aggregate is labeled `Trace Events`.

Residual risk: numeric range filters that cannot be expressed directly in Mongo projection are applied after fetching a bounded candidate window. Very large pages with rare matches can under-fill; this is accepted for v1 and called out for performance hardening if usage proves high.

### Session Detail Deep Links

Verdict: complete for direct selected-span navigation.

- `TracesPage` links to `/projects/:projectId/sessions/:sessionId/traces/:spanId`.
- `AppShell` extracts the route `spanId`.
- `SessionDetailPage` selects the matching trace/span and opens the trace-oriented detail view.
- `OverviewTab` resolves selected details by node ID or span ID and only shows contextual panels.

Residual risk: message-to-span relation still depends on causal metadata where present and timestamp fallback where not present.

## Tests Added

- `apps/runtime/src/routes/__tests__/traces-explorer-parity.test.ts`
  - Verifies trace filters reach ClickHouse query params.
  - Verifies tenant/project scoping in ClickHouse query and Mongo fallback query.
  - Verifies legacy row environment enrichment from `Session.environment`.
  - Verifies token/cost/event/error projections and no raw `data` in listing rows.
  - Verifies invalid boolean filters fail before querying ClickHouse.

- `apps/studio/src/__tests__/runtime-traces-proxy-parity.test.ts`
  - Verifies Studio proxy forwards project-scoped trace filters to runtime.
  - Verifies tenant/auth headers and no-store cache behavior.
  - Verifies missing `projectId` and auth errors do not proxy.

- `apps/studio/src/__tests__/components/traces-page-parity.test.tsx`
  - Verifies Traces tab renders span/execution-unit rows.
  - Verifies UI filters are passed to `useTraceExplorer`.
  - Verifies row click deep-links to the selected session/span.

## Open Follow-Ups

- Add a true end-to-end trace explorer scenario against running Runtime, Studio, and ClickHouse once seeded trace fixtures exist.
- Consider a dedicated ClickHouse summary table or materialized projection if project-wide trace explorer latency exceeds the target under production volume.
- Expand session-detail causality coverage after message-to-span causal metadata is consistently emitted for all runtime paths.
