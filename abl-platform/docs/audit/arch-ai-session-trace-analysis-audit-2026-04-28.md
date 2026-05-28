# Arch AI Session And Trace Analysis Audit - 2026-04-28

## Scope

This audit covers the in-project Arch AI ability to answer user requests such as:

- "check my last session"
- "analyze today's sessions"
- "analyze sessions from 3 days"
- "find issues from my sessions and fix my agent"
- "compare agent performance from today's and yesterday's sessions"
- "analyze sessions from the last week"
- "compare my agent performance in production and staging"

## Capability Matrix

| User request                                   | Live tool path                                                                                   | Evidence source                                       | Status                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------ |
| Find latest/current/recent session             | `trace_diagnosis` with `sessionRef`/query inference                                              | Runtime `GET /api/projects/:projectId/sessions`       | Wired                                |
| List sessions to pick an ID                    | `session_ops(action=list)`                                                                       | Project-scoped Session store                          | Wired in this change                 |
| Read a session summary                         | `session_ops(action=get or get_analysis)`                                                        | Project-scoped Session store                          | Wired in this change                 |
| Deep dive one session                          | `trace_diagnosis(action=deep_dive)`                                                              | Runtime session detail, traces, diagnostics           | Wired                                |
| Query raw trace slices                         | `query_traces`                                                                                   | Tenant/project-scoped `trace_events` collection       | Wired, schema expanded               |
| Analyze today's/yesterday's/last week sessions | `trace_diagnosis(action=aggregate, errors, or discover)`                                         | Runtime session list and analytics endpoints          | Wired                                |
| Compare production vs staging                  | `trace_diagnosis(action=compare)`                                                                | Runtime session list, environment filters             | Wired                                |
| Compare today vs yesterday                     | `trace_diagnosis(action=compare)` with comparison time range                                     | Runtime session list, two time windows                | Wired in this change                 |
| Compare one agent across environments          | `trace_diagnosis(action=compare, agentName, environment, compareWithEnvironment)`                | Runtime session list, environment filters             | Wired                                |
| Explain and fix runtime behavior               | `trace_diagnosis` -> `query_traces` -> `read_agent` -> `read_topology` -> `propose_modification` | Runtime evidence plus project ABL/topology validation | Wired, prompt trained in this change |

## Findings Fixed

1. `session_ops` existed but was not reachable from live in-project Arch turns. It is now in the tool name union, specialist maps, classification table, live registry, compat refs, in-project tool builder, and activity labels.

2. The live `read_insights` schema only exposed `timeRange`, and the compat adapter forced every call to `overview`. It now accepts and preserves `overview`, `quality`, `outcomes`, `agent_performance`, `sentiment`, and `tool_performance`.

3. The live `query_traces` schema only exposed `agentName` and `limit` even though the implementation supports `sessionId`, event type filters, severity, time bounds, and data inclusion. The live schemas now expose those existing filters.

4. `trace_diagnosis` could compare sessions and environments, but not time windows. It now supports `compareWithTimeRange`, `compareFrom`, `compareTo`, and natural-language pairs such as "today vs yesterday", "yesterday vs today", "this week vs last week", and "this month vs last month".

5. Specialist prompts did not consistently instruct Arch to gather runtime evidence before proposing fixes. The in-project, diagnostician, analyst, observer, and testing prompts now require evidence-first workflows and topology-aware impact reasoning before agent edits.

## Scope And Isolation Review

- `trace_diagnosis` calls existing Runtime project APIs under `/api/projects/:projectId/...` and forwards the caller auth token plus tenant header. Runtime routes apply authentication, tenant context, project permission checks, and session ownership resolution.
- `query_traces` directly queries `trace_events` with `{ tenantId, projectId }` and requires `session:read`.
- `session_ops` directly reads project sessions with `{ tenantId, projectId }` and requires `session:read`. It is intended for exact project-level list/get summaries; natural "my session" questions should go through `trace_diagnosis` with `mine=true` inference so Runtime applies user-session ownership.

## Remaining Gaps

- `session_ops` is intentionally lightweight. It does not replace `trace_diagnosis` for user-owned "mine" filtering, deep traces, diagnostics, environment comparison, or time-window comparison.
- `read_insights` still supports only the existing coarse insight windows (`1h`, `24h`, `7d`, `30d`). Day-over-day and week-over-week comparisons are handled through `trace_diagnosis` session inventory until a dedicated analytics comparison API exists.
- There is no automatic fix application from traces. Arch can propose a validated, runtime-ready diff with impact and next actions, but applying still requires explicit user confirmation.
