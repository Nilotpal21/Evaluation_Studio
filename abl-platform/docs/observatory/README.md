# Observatory Spec (JSON-Derived)

**Date:** 2026-03-10 | **Last Updated:** 2026-03-10 (post-fix) | **Status:** Reference Document

This directory contains the Observatory API/View specification as structured JSON files with derived markdown summaries.

## Recent Changes (2026-03-10)

**16 items completed. Phases 0-2 complete.** ClickHouse stores real span hierarchy, agent names, and cost. UI replay uses real spanId/parentSpanId. Feature flag `OBS_TRACE_CANONICAL_READ` removed. Decision-log unified into trace events. Traces endpoint has full filter params, \_meta, span metrics, and CH fallback on all read paths (traces, generations, metrics, export). See `FIXES.md` for details.

**All 28 E2E tests pass:** `apps/runtime/src/__tests__/e2e/observatory-api-e2e.test.ts`

## File Index

| File                          | Contents                                     | Records                     |
| ----------------------------- | -------------------------------------------- | --------------------------- |
| `apis.json`                   | 18 API endpoints with sample payloads        | 18 endpoints                |
| `data-elements.json`          | 9 data types with field definitions          | 9 types                     |
| `views.json`                  | 8 UI views with layout specs                 | 8 views                     |
| `data-flows.json`             | 4 end-to-end data flow diagrams              | 4 flows                     |
| `gaps.json`                   | 19 gaps (7 fixed, 2 mitigated, 9 open)       | 19 gaps                     |
| `event-types.json`            | Event type taxonomy + platform mapping       | 7 core + 40+ extended types |
| `stores.json`                 | Client (Zustand) + server store architecture | 5 stores                    |
| `fixes-and-requirements.json` | 52 items (9 done, 43 remaining)              | 52 items                    |
| `FIXES.md`                    | Human-readable fix tracker with phases       | Derived                     |
| `SPEC.md`                     | Full generated spec (from JSON)              | Derived                     |
| `generate-spec.ts`            | Spec generator script                        | Tool                        |

---

## API Summary

_Source: `apis.json`_

| #    | Method | Path                                                            | Status                   |
| ---- | ------ | --------------------------------------------------------------- | ------------------------ |
| 1.1  | POST   | `/api/projects/:projectId/sessions`                             | exists                   |
| 1.2  | GET    | `/api/projects/:projectId/sessions`                             | exists                   |
| 1.3  | GET    | `/api/projects/:projectId/sessions/:id`                         | exists                   |
| 1.4  | DELETE | `/api/projects/:projectId/sessions/:id`                         | exists                   |
| 1.5  | POST   | `/api/projects/:projectId/sessions/:id/close`                   | exists                   |
| 1.6  | POST   | `/api/projects/:projectId/sessions/:id/reset`                   | exists                   |
| 1.7  | GET    | `/api/projects/:projectId/sessions/:id/traces`                  | exists                   |
| 1.8  | GET    | `/api/projects/:projectId/sessions/:id/traces/:spanId/children` | **exists** (was partial) |
| 1.9  | GET    | `/api/projects/:projectId/sessions/:id/metrics`                 | **exists** (was partial) |
| 1.10 | GET    | `/api/projects/:projectId/sessions/:id/agent-spec`              | exists                   |
| 1.11 | GET    | `/api/projects/:projectId/sessions/:id/analysis`                | exists                   |
| 1.12 | GET    | `/api/projects/:projectId/sessions/export`                      | exists                   |
| 1.13 | GET    | `/api/projects/:projectId/sessions/generations`                 | exists (+ CH fallback)   |
| 1.14 | POST   | `/api/projects/:projectId/sessions/bulk-close`                  | exists                   |
| 1.15 | POST   | `/api/projects/:projectId/sessions/cleanup-orphans`             | exists                   |
| 1.16 | WS     | `/ws`                                                           | exists                   |
| 1.17 | GET    | `/api/runtime/sessions/[id]` (Studio proxy)                     | exists                   |
| 1.18 | GET    | `/api/runtime/sessions/[id]/traces` (Studio proxy)              | exists                   |

---

## Data Elements Summary

_Source: `data-elements.json`_

| #   | Type               | Fields | Description                          |
| --- | ------------------ | ------ | ------------------------------------ |
| 2.1 | SessionMessage     | 13     | Message with role, content, metadata |
| 2.2 | TraceEvent         | 7      | Studio client trace event            |
| 2.3 | ExtendedTraceEvent | 13     | Observatory store enriched event     |
| 2.4 | Span               | 12     | Observatory span with events         |
| 2.5 | TreeNode           | 9      | Conversation tree node               |
| 2.6 | SessionListItem    | 15     | Session list row                     |
| 2.7 | ClickHouseTraceRow | 15     | Storage row (**bugs fixed**)         |
| 2.8 | TraceEventTypes    | 17     | All emitted event types              |
| 2.9 | SessionMetrics     | 10     | **NEW** — Metrics endpoint response  |

---

## Gap Analysis Summary

_Source: `gaps.json`_

**Total: 19 gaps** — 9 fixed, 2 mitigated, 8 open

### Fixed (2026-03-10)

| ID    | Gap                                                 | Category |
| ----- | --------------------------------------------------- | -------- |
| 5.1.1 | ~~ClickHouse writes randomUUID() as span_id~~       | Data     |
| 5.1.2 | ~~ClickHouse writes empty agent_name~~              | Data     |
| 5.1.5 | ~~No per-span cost in ClickHouse writes~~           | Data     |
| 5.1.6 | ~~Replay creates synthetic spanId~~                 | Data     |
| 5.2.1 | ~~TracesTab shows 'No spans' for historical~~       | View     |
| 5.3.1 | ~~No dedicated /metrics endpoint~~                  | API      |
| 5.3.2 | ~~Generations endpoint only scans in-memory~~       | API      |
| 5.3.3 | ~~Export only reads from in-memory~~                | API      |
| 5.3.5 | ~~OBS_TRACE_CANONICAL_READ gates ClickHouse reads~~ | API      |

### Mitigated

| ID    | Gap                                           | Status                               |
| ----- | --------------------------------------------- | ------------------------------------ |
| 5.1.4 | TraceStore 120min TTL / 500-event ring buffer | Mitigated by CH fallback             |
| 5.2.6 | Performance tab only shows in-memory data     | Mitigated by CH generations fallback |

### Remaining Open (8)

| ID    | Gap                                       | Severity |
| ----- | ----------------------------------------- | -------- |
| 5.1.3 | message.content can be ContentBlock[]     | Medium   |
| 5.2.2 | No session list filters in UI             | Medium   |
| 5.2.3 | No CSV export button in UI                | Low      |
| 5.2.4 | Analysis endpoint not wired to UI         | Medium   |
| 5.2.5 | Agent-spec only works for active sessions | Medium   |
| 5.2.7 | No cost breakdown visualization           | Low      |
| 5.3.4 | No paginated /messages endpoint           | Low      |
| 5.3.6 | No bulk trace query across sessions       | Low      |

---

## Data Flows

_Source: `data-flows.json`_

1. **Session Detail Page** — REST fetch -> proxy -> Runtime -> trace fallback chain -> observatory replay -> render
2. **Live Chat Debug** — WebSocket -> trace_event -> observatory-store.addEvent -> React re-render
3. **Trace Storage & Retrieval** — Write: createCentralizedTraceHandler -> memory + ClickHouse + EventStore | Read: memory -> ClickHouse traces -> platform_events
4. **Metrics Aggregation** — **NEW** — In-memory aggregation with ClickHouse fallback

---

## Store Architecture

_Source: `stores.json`_

**Client (Zustand):**

- Observatory Store — spans, events (max 2K), flow graph, metrics, UI state
- Session Store — sessionId, agent, messages, state

**Server (Runtime):**

- In-Memory TraceStore — ring buffer 500/session, 120min TTL, WebSocket broadcast (hot cache)
- Redis TraceStore — distributed alternative, same interface
- ClickHouse TraceStore — **canonical persistent store**, buffered writes (10K/5s), encryption at rest, real span_id/parent_span_id/agent_name, cost on all llm_call events
