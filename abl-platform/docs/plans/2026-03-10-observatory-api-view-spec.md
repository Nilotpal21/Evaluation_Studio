# Observatory API <-> View Specification

**Date:** 2026-03-10
**Status:** Reference Document
**Scope:** Complete mapping of every Runtime API endpoint, data element, and Studio UI view in the Observatory system

---

## 1. API Inventory

### 1.1 POST /api/projects/:projectId/sessions

- **Status:** ✅ EXISTS
- **Purpose:** Create a new test session for an agent
- **Auth:** `session:execute` permission
- **Request Body:**

```json
{
  "agentId": "traveldesk/TravelDesk_Supervisor"
}
```

- **Response Shape:**

```json
{
  "success": true,
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "agentId": "traveldesk/TravelDesk_Supervisor",
    "agentName": "TravelDesk_Supervisor",
    "createdAt": "2026-03-10T07:57:00.000Z"
  }
}
```

- **Consumed By:** Studio chat panel (new session creation via TestSessionService)
- **Missing Fields:** None

---

### 1.2 GET /api/projects/:projectId/sessions

- **Status:** ✅ EXISTS
- **Purpose:** List sessions with pagination and filtering. DB is primary source; RuntimeExecutor augments with live status.
- **Query Params:** `limit` (max 200, default 50), `offset` (default 0), `status` (active|ended|completed|escalated|abandoned), `channel` (web_debug|slack|whatsapp|voice|etc.)
- **Response Shape:**

```json
{
  "success": true,
  "total": 142,
  "offset": 0,
  "limit": 50,
  "sessions": [
    {
      "id": "clxyz123abc456def789",
      "runtimeSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "agentId": "TravelDesk_Supervisor",
      "agentName": "TravelDesk_Supervisor",
      "durationMs": 32300,
      "messageCount": 4,
      "traceEventCount": 23,
      "tokenCount": 6013,
      "estimatedCost": 0.030065,
      "errorCount": 0,
      "disposition": "completed",
      "createdAt": "2026-03-10T07:57:00.000Z",
      "lastActivityAt": "2026-03-10T07:57:32.300Z",
      "activeAgent": "HotelSearch_Agent",
      "threadCount": 2,
      "status": "completed",
      "channel": "web_debug",
      "projectId": "proj_abc123",
      "environment": "development"
    }
  ]
}
```

- **Consumed By:** `useSessionList` hook -> SessionsExplorerTab, SessionExplorerPage (admin)
- **Missing Fields:** None -- comprehensively augmented from DB + RuntimeExecutor + TraceStore
- **Notes:**
  - Ghost sessions (0 messages, 0 traces, not active) are filtered out
  - Active sessions get `status: "active"` regardless of DB status
  - Duration computed from: callDuration (voice) > endedAt-startedAt > lastActivityAt-startedAt

---

### 1.3 GET /api/projects/:projectId/sessions/:id

- **Status:** ✅ EXISTS
- **Purpose:** Get full session detail including messages, state, and trace events
- **Lookup Strategy:** RuntimeExecutor first (active), DB fallback (historical), ClickHouse traces fallback
- **Response Shape (active session from RuntimeExecutor):**

```json
{
  "success": true,
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "agent": { "name": "TravelDesk_Supervisor" },
    "agentName": "TravelDesk_Supervisor",
    "state": {
      "context": { "destination": "paris" },
      "conversationPhase": "gathering",
      "gatherProgress": { "destination": "paris", "dates": null },
      "constraintResults": {},
      "lastToolResults": {},
      "memory": { "session": {}, "persistentCache": {}, "pendingRemembers": [] }
    },
    "messages": [
      {
        "id": "msg_001",
        "role": "user",
        "content": "Find hotels in Paris for next week",
        "timestamp": "2026-03-10T07:57:01.000Z"
      },
      {
        "id": "msg_002",
        "role": "assistant",
        "content": "I'd be happy to help you find hotels in Paris! Let me search for available options for next week.",
        "timestamp": "2026-03-10T07:57:03.500Z"
      }
    ],
    "traceEvents": [
      {
        "id": "evt_001",
        "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "type": "agent_enter",
        "timestamp": "2026-03-10T07:57:00.100Z",
        "data": {
          "agentName": "TravelDesk_Supervisor",
          "mode": "reasoning",
          "trigger": "user_message"
        },
        "agentName": "TravelDesk_Supervisor",
        "spanId": "span-TravelDesk_Supervisor-1741590420100",
        "parentSpanId": null
      },
      {
        "id": "evt_002",
        "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "type": "llm_call",
        "timestamp": "2026-03-10T07:57:00.200Z",
        "durationMs": 1200,
        "data": {
          "model": "claude-sonnet-4-20250514",
          "messagesIn": 3,
          "tokensIn": 1245,
          "tokensOut": 392,
          "latencyMs": 1200,
          "cost": 0.008235
        }
      }
    ],
    "threads": [{ "agentName": "TravelDesk_Supervisor", "index": 0 }],
    "activeThreadIndex": 0,
    "createdAt": "2026-03-10T07:57:00.000Z",
    "lastActivityAt": "2026-03-10T07:57:32.300Z"
  }
}
```

- **Response Shape (historical session from DB):** Same structure plus:

```json
{
  "session": {
    "runtimeSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "tokenCount": 6013,
    "estimatedCost": 0.030065,
    "messageCount": 4,
    "channel": "web_debug",
    "status": "completed"
  }
}
```

- **Consumed By:** `useSessionDetail` hook -> `SessionDetailPage`, `AgentConversationTree`, `SessionSummaryPanel`, `DebugTabs`
- **Trace Fallback Chain:**
  1. RuntimeExecutor `getSessionDetail()` trace events
  2. In-memory TraceStore `getEvents(runtimeSessionId)`
  3. ClickHouse `abl_platform.traces` (via `getTraceForTenant`)
- **Missing Fields:**
  - ⚠️ ClickHouse fallback events lack `spanId` and `parentSpanId` (randomUUID assigned on write -- see Gap 5.1.1)
  - ⚠️ No `handoffCount` field in detail response (available in list response via DB)

---

### 1.4 DELETE /api/projects/:projectId/sessions/:id

- **Status:** ✅ EXISTS
- **Purpose:** Soft-delete session. Cleans up RuntimeExecutor + cascade deletes from DB (session + messages + usage metrics + attachments + events)
- **Auth:** `session:delete` permission
- **Response Shape:**

```json
{ "success": true, "message": "Session deleted" }
```

- **Consumed By:** Studio session list delete button, admin session management
- **Missing Fields:** None

---

### 1.5 POST /api/projects/:projectId/sessions/:id/close

- **Status:** ✅ EXISTS
- **Purpose:** Close a session with an explicit disposition
- **Request Body:**

```json
{ "disposition": "completed" }
```

- **Valid Dispositions:** `completed`, `abandoned`, `agent_hangup`, `transferred`, `failed`, `timeout`
- **Response Shape:**

```json
{
  "success": true,
  "message": "Session closed with disposition: completed",
  "status": "completed",
  "disposition": "completed"
}
```

- **Consumed By:** Voice pipeline (call end), Studio session close action
- **Missing Fields:** None

---

### 1.6 POST /api/projects/:projectId/sessions/:id/reset

- **Status:** ✅ EXISTS
- **Purpose:** Reset session state, messages, and traces (active sessions only)
- **Auth:** `session:execute` permission
- **Response Shape:**

```json
{
  "success": true,
  "message": "Session reset",
  "state": {
    "context": {},
    "conversationPhase": "start",
    "gatherProgress": {},
    "constraintResults": {},
    "lastToolResults": {},
    "memory": {}
  }
}
```

- **Consumed By:** Studio debug panel reset button
- **Missing Fields:** None
- **Note:** Only works for active RuntimeExecutor sessions, not historical DB sessions

---

### 1.7 GET /api/projects/:projectId/sessions/:id/traces

- **Status:** ✅ EXISTS
- **Purpose:** Get session trace events with filtering, pagination, and multi-source fallback
- **Query Params:** `limit`, `offset`, `types` (comma-separated), `eventType`, `decisionKind`, `spanId`, `include=metrics`
- **Trace Source Fallback:**
  1. In-memory TraceStore (runtimeSessionId, then sessionId)
  2. ClickHouse `abl_platform.traces` (gated by `OBS_TRACE_CANONICAL_READ=true`)
  3. ClickHouse `abl_platform.platform_events` (lossy type translation)
- **Response Shape:**

```json
{
  "success": true,
  "total": 23,
  "offset": 0,
  "limit": 23,
  "traces": [
    {
      "id": "evt_001",
      "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "type": "agent_enter",
      "timestamp": "2026-03-10T07:57:00.100Z",
      "data": { "agentName": "TravelDesk_Supervisor", "mode": "reasoning" },
      "agentName": "TravelDesk_Supervisor",
      "spanId": "span-TravelDesk_Supervisor-1741590420100"
    }
  ],
  "_meta": {
    "source": "memory",
    "event_count": 23,
    "is_truncated": false
  },
  "metrics": {
    "span-TravelDesk_Supervisor-1741590420100": {
      "eventCount": 15,
      "durationMs": 28400,
      "types": { "llm_call": 3, "tool_call": 2, "decision": 5, "agent_enter": 1, "agent_exit": 1 }
    }
  }
}
```

- **Consumed By:** `useSessionTraces` hook, `useSessionDetail` (fallback fetch), traces explorer
- **Missing Fields:**
  - ⚠️ ClickHouse canonical traces use `randomUUID()` for `span_id` and empty `parent_span_id` (see `appendEvent` in `clickhouse-trace-store.ts` line 110-111)

---

### 1.8 GET /api/projects/:projectId/sessions/:id/traces/:spanId/children

- **Status:** ⚠️ PARTIAL (declared in route comments but implementation delegates to `spanId` query param on `/:id/traces`)
- **Purpose:** Get child events for a specific span
- **Effective Query:** `GET /:id/traces?spanId=<spanId>`
- **Missing:** No dedicated endpoint -- uses `spanId` filter on the traces endpoint

---

### 1.9 GET /api/projects/:projectId/sessions/:id/metrics

- **Status:** ⚠️ PARTIAL (declared in route comments, implemented as `?include=metrics` on the traces endpoint)
- **Purpose:** Get aggregated session metrics (per-span event counts, durations, type breakdowns)
- **Effective Query:** `GET /:id/traces?include=metrics`
- **Response:** `metrics` field in the traces response (see 1.7)
- **Missing:**
  - ❌ No dedicated `/metrics` endpoint -- metrics are bundled with traces response
  - ❌ No server-side cost aggregation (client computes cost from per-span `llm_call` events)
  - ❌ No server-side token aggregation

---

### 1.10 GET /api/projects/:projectId/sessions/:id/agent-spec

- **Status:** ✅ EXISTS
- **Purpose:** Get agent specification (DSL source, compiled IR, metadata) for a session
- **Auth:** `session:read` permission
- **Response Shape:**

```json
{
  "success": true,
  "agent": {
    "id": "TravelDesk_Supervisor",
    "name": "TravelDesk_Supervisor",
    "type": "supervisor",
    "mode": "reasoning",
    "dsl": "AGENT TravelDesk_Supervisor\n  ROLE: \"You are a travel assistant...\"\n  ...",
    "ir": { "agent": { "name": "TravelDesk_Supervisor", "role": "..." }, "steps": [], "tools": [] },
    "toolCount": 5,
    "gatherFieldCount": 3
  }
}
```

- **Consumed By:** IR tab in DebugTabs, agent spec viewer
- **Note:** Only works for active RuntimeExecutor sessions (needs `getSession()`)
- **Missing:**
  - ❌ No DB fallback for historical sessions (returns 404 if session is not in RuntimeExecutor)

---

### 1.11 GET /api/projects/:projectId/sessions/:id/analysis

- **Status:** ✅ EXISTS
- **Purpose:** Automated trace analysis with issue detection, suggestions, and flow path analysis
- **Auth:** `session:read` permission
- **Response Shape:**

```json
{
  "success": true,
  "analysis": {
    "summary": {
      "totalEvents": 23,
      "eventCounts": {
        "llm_call": 3,
        "tool_call": 2,
        "agent_enter": 1,
        "agent_exit": 1,
        "decision": 5
      },
      "duration": 32300,
      "llmCalls": 3,
      "toolCalls": 2,
      "errors": 0
    },
    "currentState": {
      "step": "search_hotels",
      "phase": "executing",
      "collectedFields": ["destination", "dates"],
      "missingFields": ["budget"]
    },
    "issues": [
      {
        "type": "info",
        "title": "High LLM cost",
        "description": "Session used 6,013 tokens across 3 LLM calls"
      }
    ],
    "suggestions": ["Consider caching repeated search results to reduce tool call latency"],
    "flowPath": {
      "expectedSteps": ["greet", "gather_info", "search_hotels", "present_results"],
      "visitedSteps": ["greet", "gather_info", "search_hotels"],
      "skippedSteps": ["present_results"],
      "completionSource": "handoff",
      "completedAtStep": "search_hotels"
    }
  }
}
```

- **Consumed By:** Not currently wired to any UI component
- **Note:** Active sessions only (requires RuntimeExecutor `getSession()`)
- **Missing:**
  - ❌ No DB/ClickHouse fallback for historical sessions
  - ❌ No UI component consumes this endpoint

---

### 1.12 GET /api/projects/:projectId/sessions/export

- **Status:** ✅ EXISTS
- **Purpose:** Export trace events as CSV
- **Query Params:** `sessionIds` (comma-separated, required, max 20), `eventType`, `decisionKind`
- **Response:** CSV file download (`Content-Type: text/csv`)
- **CSV Columns:** `id, sessionId, type, decisionKind, spanId, parentSpanId, agentName, timestamp, data`
- **Consumed By:** Not currently wired to any UI component
- **Missing:**
  - ❌ No UI button/flow triggers this export
  - ⚠️ Only exports from in-memory TraceStore (no ClickHouse fallback)

---

### 1.13 GET /api/projects/:projectId/sessions/generations

- **Status:** ✅ EXISTS
- **Purpose:** List all LLM call events across sessions (generations view)
- **Query Params:** `sessionId` (optional filter), `limit` (max 500, default 50), `offset`
- **Response Shape:**

```json
{
  "success": true,
  "total": 87,
  "offset": 0,
  "limit": 50,
  "generations": [
    {
      "id": "evt_002",
      "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "model": "claude-sonnet-4-20250514",
      "tokensIn": 1245,
      "tokensOut": 392,
      "latencyMs": 1200,
      "cost": 0.008235,
      "timestamp": "2026-03-10T07:57:00.200Z",
      "spanId": "span-TravelDesk_Supervisor-1741590420100"
    }
  ]
}
```

- **Consumed By:** `LLMCallsTab` in DebugTabs
- **Missing:**
  - ⚠️ Only scans in-memory TraceStore (max 100 sessions) -- no ClickHouse fallback
  - ⚠️ No model name normalization (raw model string from provider)

---

### 1.14 POST /api/projects/:projectId/sessions/bulk-close

- **Status:** ✅ EXISTS
- **Purpose:** Close all matching sessions for a project/agent
- **Request Body:**

```json
{ "agentName": "TravelDesk_Supervisor", "disposition": "abandoned" }
```

- **Response Shape:**

```json
{ "success": true, "closedRuntime": 3, "closedDb": 12 }
```

- **Consumed By:** Admin session management
- **Missing Fields:** None

---

### 1.15 POST /api/projects/:projectId/sessions/cleanup-orphans

- **Status:** ✅ EXISTS
- **Purpose:** Delete orphaned/phantom sessions that were never fully initialized
- **Orphan Criteria:** messageCount=0 AND no runtimeSessionId AND status in (active, idle)
- **Query Params:** `dryRun=true` for preview
- **Response Shape:**

```json
{ "success": true, "deletedDb": 5 }
```

- **Consumed By:** Admin maintenance operations
- **Missing Fields:** None

---

### 1.16 WebSocket /ws (trace_event messages)

- **Status:** ✅ EXISTS
- **Purpose:** Real-time trace event streaming during live sessions
- **Message Types Sent:**
  - `trace_event` -- individual trace event (same shape as REST trace events)
  - `trace_replay` -- bulk replay of buffered events on subscribe
  - `session_ended` -- session termination notification
  - `session_expired` -- session timeout notification
  - `response_chunk` -- streaming LLM response text
- **Trace Event Shape (over WebSocket):**

```json
{
  "type": "trace_event",
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event": {
    "id": "evt_003",
    "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "type": "tool_call",
    "timestamp": "2026-03-10T07:57:02.000Z",
    "durationMs": 800,
    "data": {
      "toolName": "search_hotels",
      "input": { "destination": "paris", "dates": "2026-03-17 to 2026-03-24" },
      "output": { "results": ["..."] },
      "success": true,
      "latencyMs": 800
    },
    "deploymentId": "deploy_abc",
    "environment": "development",
    "agentVersions": { "TravelDesk_Supervisor": 3 }
  }
}
```

- **Consumed By:** `WebSocketContext` -> `observatory-store.addEvent()` -> DebugTabs, FloatingDebugPanel
- **Missing Fields:** None

---

### 1.17 Studio Proxy: GET /api/runtime/sessions/[id] (Next.js Route)

- **Status:** ✅ EXISTS
- **Purpose:** Proxy from Studio to Runtime for session detail
- **File:** `apps/studio/src/app/api/runtime/sessions/[id]/route.ts`
- **Behavior:** Forwards to `GET /api/projects/:projectId/sessions/:id` on Runtime
- **Query Params:** `projectId` (required)
- **Timeout:** 15s with AbortController
- **Error Codes:** `PROXY_TIMEOUT` (504), `PROXY_ERROR` (502), `MISSING_PARAM` (400)

---

### 1.18 Studio Proxy: GET /api/runtime/sessions/[id]/traces (Next.js Route)

- **Status:** ✅ EXISTS
- **Purpose:** Proxy from Studio to Runtime for session traces
- **File:** `apps/studio/src/app/api/runtime/sessions/[id]/traces/route.ts`
- **Behavior:** Forwards to `GET /api/projects/:projectId/sessions/:id/traces` on Runtime
- **Query Params:** `projectId` (required), all other params forwarded

---

## 2. Data Elements Dictionary

### 2.1 SessionMessage

| Field                         | Type                                                   | Sample                                 | Source                   |
| ----------------------------- | ------------------------------------------------------ | -------------------------------------- | ------------------------ |
| id                            | string                                                 | `"msg_001"`                            | MongoDB `messages.id`    |
| role                          | `"user"` \| `"assistant"` \| `"system"` \| `"thought"` | `"user"`                               | MongoDB                  |
| content                       | string                                                 | `"Find hotels in Paris for next week"` | MongoDB                  |
| timestamp                     | Date                                                   | `2026-03-10T07:57:01.000Z`             | MongoDB                  |
| traceIds                      | string[]                                               | `["evt_001", "evt_002"]`               | MongoDB                  |
| metadata?.tokensIn            | number                                                 | `1245`                                 | Computed at message time |
| metadata?.tokensOut           | number                                                 | `392`                                  | Computed at message time |
| metadata?.latencyMs           | number                                                 | `1200`                                 | Computed at message time |
| metadata?.action              | ConstructAction                                        | `{ type: "respond", message: "..." }`  | Runtime engine           |
| metadata?.toolName            | string                                                 | `"search_hotels"`                      | Runtime engine           |
| metadata?.agentName           | string                                                 | `"TravelDesk_Supervisor"`              | Runtime engine           |
| metadata?.handoffFrom         | string                                                 | `"Supervisor"`                         | Runtime engine           |
| metadata?.handoffTo           | string                                                 | `"HotelSearch_Agent"`                  | Runtime engine           |
| metadata?.attachmentFilenames | string[]                                               | `["invoice.pdf"]`                      | Upload pipeline          |

### 2.2 TraceEvent (Studio client type)

| Field        | Type                      | Sample                                                  | Source                                |
| ------------ | ------------------------- | ------------------------------------------------------- | ------------------------------------- |
| id           | string                    | `"evt_001"`                                             | `crypto.randomUUID()` in TraceEmitter |
| sessionId    | string                    | `"a1b2c3d4-..."`                                        | TraceEmitter config                   |
| type         | ExtendedTraceEventType    | `"llm_call"`                                            | TraceEmitter method                   |
| timestamp    | Date                      | `2026-03-10T07:57:00.200Z`                              | `new Date()` at emit time             |
| durationMs   | number \| undefined       | `1200`                                                  | Computed by caller                    |
| data         | Record<string, unknown>   | `{ model: "claude-sonnet-4-20250514", tokensIn: 1245 }` | Caller-provided                       |
| decisionKind | DecisionKind \| undefined | `"handoff"`                                             | Only when type=decision               |

### 2.3 ExtendedTraceEvent (Observatory store type)

| Field              | Type                                           | Sample                                       | Source                               |
| ------------------ | ---------------------------------------------- | -------------------------------------------- | ------------------------------------ |
| id                 | string                                         | `"evt_001"`                                  | From TraceEvent                      |
| type               | ExtendedTraceEventType                         | `"agent_enter"`                              | From TraceEvent                      |
| timestamp          | Date                                           | `2026-03-10T07:57:00.100Z`                   | From TraceEvent                      |
| durationMs         | number \| undefined                            | `1200`                                       | From TraceEvent                      |
| traceId            | string                                         | `"a1b2c3d4-..."`                             | `event.sessionId` or sessionId param |
| spanId             | string                                         | `"span-TravelDesk_Supervisor-1741590420100"` | From TraceEmitter span stack         |
| parentSpanId       | string \| undefined                            | `"span-root-1741590420000"`                  | From TraceEmitter span stack         |
| sessionId          | string                                         | `"a1b2c3d4-..."`                             | TraceEmitter config                  |
| agentName          | string                                         | `"TravelDesk_Supervisor"`                    | `data.agentName` or `"unknown"`      |
| stepName           | string \| undefined                            | `"search_hotels"`                            | `data.stepName`                      |
| data               | Record<string, unknown>                        | `{ agentName: "...", mode: "reasoning" }`    | From TraceEvent                      |
| metadata?.severity | `"debug"` \| `"info"` \| `"warn"` \| `"error"` | `"info"`                                     | Optional                             |
| metadata?.tags     | string[]                                       | `["critical-path"]`                          | Optional                             |

### 2.4 Span (Observatory store type)

| Field        | Type                                      | Sample                                  | Source                             |
| ------------ | ----------------------------------------- | --------------------------------------- | ---------------------------------- |
| spanId       | string                                    | `"span-TravelDesk_Supervisor-a1b2c3d4"` | `observatory-store.startSpan()`    |
| traceId      | string                                    | `"a1b2c3d4-..."`                        | From ExtendedTraceEvent            |
| parentSpanId | string \| undefined                       | `"span-root-..."`                       | From ExtendedTraceEvent            |
| name         | string                                    | `"TravelDesk_Supervisor"`               | Agent name or step name            |
| startTime    | Date                                      | `2026-03-10T07:57:00.100Z`              | `new Date()` at span start         |
| endTime      | Date \| undefined                         | `2026-03-10T07:57:32.300Z`              | Set on `endSpan()`                 |
| durationMs   | number \| undefined                       | `32200`                                 | `endTime - startTime`              |
| status       | `"running"` \| `"completed"` \| `"error"` | `"completed"`                           | Set on `endSpan()`                 |
| agentName    | string                                    | `"TravelDesk_Supervisor"`               | From event                         |
| sessionId    | string                                    | `"a1b2c3d4-..."`                        | From event                         |
| events       | ExtendedTraceEvent[]                      | `[...]`                                 | Accumulated via `addEventToSpan()` |
| attributes   | Record<string, unknown>                   | `{}`                                    | Currently unused                   |

### 2.5 TreeNode (Conversation tree type)

| Field     | Type                                           | Sample                                                                                                                         | Source                                      |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| id        | string                                         | `"evt_001"` or `"user-0"`                                                                                                      | Event ID or synthetic                       |
| type      | TreeNodeType                                   | `"user_input"` \| `"agent"` \| `"llm_call"` \| `"tool_call"` \| `"handoff"` \| `"decision"` \| `"flow_step"` \| `"voice_turn"` | Derived from event type                     |
| label     | string                                         | `"Find hotels in Paris..."`                                                                                                    | Message content or event summary            |
| detail    | string \| undefined                            | `"(reasoning)"` or `"1637 tokens"`                                                                                             | Model name, token count, etc.               |
| tokens    | { input: number; output: number } \| undefined | `{ input: 1245, output: 392 }`                                                                                                 | From `data.tokensIn/tokensOut`              |
| latencyMs | number \| undefined                            | `1200`                                                                                                                         | From `event.durationMs` or `data.latencyMs` |
| timestamp | string \| undefined                            | `"2026-03-10T07:57:00.200Z"`                                                                                                   | ISO string                                  |
| data      | Record<string, unknown> \| undefined           | Full event data                                                                                                                | Raw trace event data                        |
| children  | TreeNode[]                                     | `[...]`                                                                                                                        | Nested hierarchy                            |

### 2.6 SessionListItem (Studio type)

| Field            | Type                | Sample                                                        | Source                    |
| ---------------- | ------------------- | ------------------------------------------------------------- | ------------------------- |
| id               | string              | `"clxyz123abc456def789"`                                      | MongoDB `_id`             |
| agentId          | string              | `"TravelDesk_Supervisor"`                                     | `currentAgent` from DB    |
| agentName        | string              | `"TravelDesk_Supervisor"`                                     | RuntimeExecutor or DB     |
| status           | string              | `"active"` \| `"completed"` \| `"escalated"` \| `"abandoned"` | DB + runtime augmentation |
| runtimeSessionId | string \| undefined | `"a1b2c3d4-..."`                                              | DB column                 |
| durationMs       | number              | `32300`                                                       | Computed server-side      |
| messageCount     | number              | `4`                                                           | DB or RuntimeExecutor     |
| traceEventCount  | number              | `23`                                                          | TraceStore or DB counter  |
| tokenCount       | number              | `6013`                                                        | DB aggregate              |
| estimatedCost    | number              | `0.030065`                                                    | DB aggregate              |
| errorCount       | number              | `0`                                                           | DB counter                |
| disposition      | string \| null      | `"completed"`                                                 | DB field                  |
| channel          | string \| undefined | `"web_debug"`                                                 | DB field                  |
| createdAt        | string              | `"2026-03-10T07:57:00.000Z"`                                  | DB `startedAt`            |
| lastActivityAt   | string              | `"2026-03-10T07:57:32.300Z"`                                  | DB field                  |

### 2.7 ClickHouseTraceRow (Storage type)

| Field          | Type          | Sample                                           | Source                                   |
| -------------- | ------------- | ------------------------------------------------ | ---------------------------------------- |
| tenant_id      | string        | `"tenant_abc"`                                   | From ClickHouseTraceStore config         |
| session_id     | string        | `"a1b2c3d4-..."`                                 | Runtime session ID                       |
| trace_id       | string        | `"a1b2c3d4-..."`                                 | Same as session_id in current usage      |
| timestamp      | string        | `"2026-03-10 07:57:00.200"`                      | ISO without T/Z                          |
| span_id        | string        | `"f47ac10b-58cc-..."`                            | **BUG:** `randomUUID()` not real span ID |
| parent_span_id | string        | `""`                                             | **BUG:** Always empty string             |
| event_type     | string        | `"llm_call"`                                     | From TraceEvent.type                     |
| agent_name     | string        | `""`                                             | **BUG:** Always empty in `appendEvent`   |
| data           | string        | `"{\"model\":\"claude-sonnet-4-20250514\",...}"` | JSON-stringified, optionally encrypted   |
| encrypted      | number (0\|1) | `1`                                              | Whether data column is encrypted         |
| key_version    | number        | `1`                                              | Encryption key version                   |
| duration_ms    | number        | `1200`                                           | From event.durationMs                    |
| has_error      | number (0\|1) | `0`                                              | Derived from event type/data             |
| error_message  | string        | `""`                                             | From event.data.error                    |
| node_id        | string        | `""`                                             | Always empty in `appendEvent`            |
| sequence       | string        | `""`                                             | From event.sequence                      |

### 2.8 TraceEvent Types Emitted

| Event Type          | Emitter Method                     | Key Data Fields                                                             | Verbosity                   |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| `llm_call`          | `logLLMCall()`                     | model, messagesIn, tokensIn, tokensOut, latencyMs, cost, messages, response | standard                    |
| `tool_call`         | `logToolCall()`                    | toolName, input, output, success, latencyMs, error                          | standard                    |
| `decision`          | `logDecision()` / `emitDecision()` | decisionType/decisionKind, decision, reasoning, contextMeta                 | standard/verbose (per kind) |
| `constraint_check`  | `logConstraintCheck()`             | constraint, passed, context                                                 | standard                    |
| `handoff`           | `logHandoff()`                     | toAgent, reason, contextMeta                                                | standard                    |
| `escalation`        | `logEscalation()`                  | reason, priority, contextMeta                                               | standard                    |
| `error`             | `logError()`                       | errorType, message, stack                                                   | always                      |
| `user_message`      | `logUserMessage()`                 | contentLength, channel, hasAttachments, attachmentCount                     | standard                    |
| `agent_response`    | `logAgentResponse()`               | contentLength, channel, hasRichContent, durationMs                          | standard                    |
| `session_updated`   | `logSessionUpdated()`              | updateSource, keysUpdated, updateCount                                      | standard                    |
| `agent_enter`       | `logAgentEnter()`                  | agentName, mode, trigger; sets spanId, parentSpanId                         | standard                    |
| `agent_exit`        | `logAgentExit()`                   | agentName, result (completed/handoff/delegate/error), durationMs            | standard                    |
| `flow_step_enter`   | `logFlowStepEnter()`               | agentName, stepName, stepType                                               | standard                    |
| `flow_step_exit`    | `logFlowStepExit()`                | agentName, stepName, durationMs                                             | standard                    |
| `flow_transition`   | `logFlowTransition()`              | agentName, fromStep, toStep, condition                                      | standard                    |
| `delegate_start`    | `logDelegateStart()`               | fromAgent, targetAgent, task                                                | standard                    |
| `delegate_complete` | `logDelegateComplete()`            | fromAgent, targetAgent, success, durationMs                                 | standard                    |

---

## 3. View Specifications

### 3.1 Session Detail Page

- **Route:** `/projects/:projectId/sessions/:sessionId` (via `currentView === 'session-detail'`)
- **Status:** ✅ EXISTS
- **Component:** `SessionDetailPage.tsx`
- **APIs Used:** `GET /sessions/:id` (via `useSessionDetail`), `GET /sessions/:id/traces` (fallback)
- **Layout:**

```
+------------------------------------------------------------------+
| <- Back to Sessions / s-019cd5e0-e4b1    Traces: 23  $0.030065  |
+----------------------------+-------------------------------------+
| CONVERSATION TREE (35%)    | SUMMARY + NODE DETAIL (65%)         |
|                            | +----------------------------------+|
| [user] Find hotels in      | | Cost    | Tokens | Latency      ||
|   paris for next week      | | $0.030  | 6,013  | 32.3s        ||
|                            | +----------------------------------+|
| -- AGENT RESPONSE --       |                                     |
| I'd be happy to help you   | [Preview] [Request] [Response]      |
|   find hotels in Paris...  | [Metadata] [Voice*]                 |
|                            | { selected node detail panel }      |
| [user] Under $200/night    +-------------------------------------+
|   v TravelDesk_Supervisor  | [Traces] [Data] [Conversation]      |
|     v LLM (claude-sonnet)  | [Performance] [IR]                  |
|       1637 tokens, 1.2s    | +----------------------------------+|
|     v search_hotels         | | v TravelDesk_Supervisor   32.3s ||
|       800ms                | |   v LLM Call (claude)     1.2s  ||
|   v HotelSearch_Agent      | |   v Tool: search_hotels   0.8s  ||
|     v LLM (claude-sonnet)  | |   v LLM Call (claude)     0.5s  ||
|       892 tokens, 0.5s     | | v HotelSearch_Agent       8.2s  ||
|                            | +----------------------------------+|
| -- AGENT RESPONSE --       |                                     |
| Here are the best hotels...|                                     |
+----------------------------+-------------------------------------+
```

- **Data Flow:**

```
User navigates to /sessions/:id
    |
useSessionDetail(sessionId, projectId)
    |
SWR fetch: /api/runtime/sessions/:id?projectId=X
    | (Studio proxy)
Runtime: GET /api/projects/:projectId/sessions/:id
    |
Response: { session: { messages, traceEvents, tokenCount, ... } }
    |
If traceEvents empty -> fallback fetch /api/runtime/sessions/:id/traces
    |
replayTraceEventsIntoObservatory(traceEvents, sessionId)
    |
observatory-store.addEvent() for each event
    | creates
spans Map, events[], flowNodes, metrics
    | consumed by
DebugTabs -> TracesTab -> WaterfallPanel -> SpanTree
```

- **What Works:**
  - Two-column resizable layout with horizontal drag handle
  - Vertical resizable split (summary top / debug tabs bottom)
  - Breadcrumb navigation with shortened session ID
  - Loading states with spinner
  - Error state with retry button
  - Top-right metrics bar (trace count, token count, cost)
  - Session store hydration from REST data
  - Observatory store replay from trace events
  - Cleanup on unmount (clears all stores)
- **What's Broken / Missing:**
  - ⚠️ Conversation tree shows `[object Object]` when `message.content` is `ContentBlock[]` instead of string (the tree builder checks `typeof msg.content === 'string'` but falls through to generic label)
  - ⚠️ TracesTab shows "No spans" for historical sessions when ClickHouse traces lack real spanId/parentSpanId
  - ⚠️ Cost shows `--` for sessions where traces have no per-span `cost` field and DB `estimatedCost` is 0

---

### 3.2 Agent Conversation Tree

- **Status:** ✅ EXISTS
- **Component:** `AgentConversationTree.tsx`
- **Data Source:** `tree` from `useSessionDetail` -> `buildConversationTree()`
- **Node Types Rendered:**

| TreeNodeType          | Icon           | Color   | Badges           | Status |
| --------------------- | -------------- | ------- | ---------------- | ------ |
| `user_input`          | User           | accent  | -                | ✅     |
| `agent`               | Bot            | success | mode             | ✅     |
| `sub_agent`           | Bot            | success | mode             | ✅     |
| `llm_call`            | Cpu            | warning | tokens, latency  | ✅     |
| `tool_call`           | Wrench         | info    | latency          | ✅     |
| `handoff`             | ArrowRightLeft | warning | target           | ✅     |
| `delegate_action`     | ArrowRightLeft | info    | target           | ✅     |
| `complete`            | CheckCircle2   | success | -                | ✅     |
| `escalate`            | AlertTriangle  | error   | -                | ✅     |
| `decision`            | Lightbulb      | muted   | type             | ✅     |
| `flow_step`           | Workflow       | info    | step type        | ✅     |
| `flow_transition`     | GitBranch      | muted   | condition        | ✅     |
| `agent_response`      | divider style  | muted   | -                | ✅     |
| `voice_session_start` | Phone          | success | STT/TTS vendor   | ✅     |
| `voice_session_end`   | PhoneOff       | muted   | turn count       | ✅     |
| `voice_turn`          | AudioLines     | info    | timing breakdown | ✅     |
| `voice_stt`           | Mic            | info    | confidence %     | ✅     |
| `voice_tts`           | Volume2        | info    | chunks, duration | ✅     |
| `voice_barge_in`      | VolumeX        | warning | type, turn       | ✅     |

- **What Works:**
  - Hierarchical tree with expand/collapse (auto-expanded to depth 2)
  - Click-to-select highlights node and updates `selectedTraceNodeId` in UI store
  - Token/latency badges on LLM and tool call nodes
  - Agent response separator between turns
  - Voice session rendering (flat timeline for voice, grouped for text)
  - Hex ID filtering (avoids showing raw MongoDB ObjectIds as labels)
  - System tool detection (`__handoff__`, `__delegate__`, `__complete__`, `__escalate__`)
- **What's Broken:**
  - ⚠️ When `message.content` is `ContentBlock[]` (rich content), label shows `"User input"` instead of extracted text

---

### 3.3 Session Summary Panel

- **Status:** ✅ EXISTS
- **Component:** `SessionSummaryPanel.tsx`
- **Data Source:** `metrics` from `useSessionDetail`, `traceEvents`, `tree`, selected node from `ui-store`
- **Layout:**

```
+----------------------------------------+
| Summary                                |
| +------+--------+--------+-----------+ |
| | Cost | Tokens | Latency| LLM Calls | |
| |$0.03 | 6,013  | 32.3s  | 3         | |
| +------+--------+--------+-----------+ |
|                                        |
| [Preview] [Request] [Response] [Meta]  |
| [Voice*]                               |
|                                        |
| { Selected node detail }               |
| - Preview: formatted view of data      |
| - Request: LLM messages sent           |
| - Response: LLM response text          |
| - Metadata: raw JSON of event data     |
| - Voice: voice-specific metrics        |
+----------------------------------------+
```

- **Tabs:** Preview, Request, Response, Metadata, Voice (conditional)
- **What Works:**
  - Metric cards with cost, tokens, latency, LLM calls
  - Tab switching with selected node detail
  - Voice tab auto-detected from `voice_session_start` events
  - JsonViewer for raw data inspection
  - Copy session ID to clipboard
  - MetricInfoIcon tooltips
- **What's Broken:**
  - ⚠️ Metrics show 0 when trace events have no `cost` field and DB aggregates are not forwarded
  - ⚠️ No "fullscreen" mode for large JSON payloads (MetricInfoIcon popover is small)

---

### 3.4 Debug Tabs (Traces/Data/Conversation/Performance/IR)

- **Status:** ✅ EXISTS
- **Component:** `DebugTabs.tsx`
- **Tabs:**

| Tab          | Label        | Icon          | Content                                          | Status    |
| ------------ | ------------ | ------------- | ------------------------------------------------ | --------- |
| traces       | Traces       | Activity      | WaterfallPanel with SpanTree                     | ✅ EXISTS |
| data         | Data         | Database      | TestContextPanel (gather progress, context vars) | ✅ EXISTS |
| conversation | Conversation | MessageSquare | Conversation history viewer                      | ✅ EXISTS |
| performance  | Performance  | Gauge         | LLMCallsTab (generations list)                   | ✅ EXISTS |
| ir           | IR           | Code2         | Agent IR JSON viewer                             | ✅ EXISTS |

- **What Works:**
  - Animated tab indicator (Framer Motion)
  - Scrollable tab bar
  - Docked / floating mode toggle
  - Log viewer with clear button
  - All five tabs render content
- **What's Broken:**
  - ⚠️ TracesTab (WaterfallPanel) shows "No spans" for historical sessions when `replayTraceEventsIntoObservatory` creates spans with synthetic IDs that don't form a proper hierarchy
  - ⚠️ Performance tab (LLMCallsTab) only shows data for active sessions with in-memory traces

---

### 3.5 Waterfall Panel + Span Tree

- **Status:** ✅ EXISTS
- **Components:** `WaterfallPanel.tsx`, `SpanTree.tsx`
- **Layout:**

```
+----------------------------------------------+
| [Live] | Spans: 5 | Duration: 32.3s |        |
|        | Tokens: 6,013 | Cost: $0.03 | Err: 0|
+----------------------------------------------+
| v TravelDesk_Supervisor           32.3s $0.02 |
|   v LLM Call (claude-sonnet)       1.2s $0.01 |
|     decision: handoff -> HotelSearch  [badge] |
|   v Tool: search_hotels             0.8s      |
|   v LLM Call (claude-sonnet)        0.5s $0.01|
| v HotelSearch_Agent                8.2s $0.01 |
|   v LLM Call (claude-sonnet)        0.9s $0.01|
+----------------------------------------------+
```

- **Features:**
  - Summary bar with totals (spans, duration, tokens, cost, errors)
  - Live/Historical mode indicator
  - Expandable span tree with parent-child hierarchy
  - Cost column with color coding (green < $0.01, yellow < $0.10, red >= $0.10)
  - Token breakdown tooltip (prompt + completion)
  - Decision event rendering inline with reason text
  - Copy span ID to clipboard
  - Click to select span -> NodeDetailPanel
- **What Works:**
  - Full span tree rendering for live sessions
  - Cost color coding
  - Decision event badges
  - Token aggregation per span
- **What's Broken:**
  - ⚠️ Historical sessions: spans created by `replayTraceEventsIntoObservatory` use synthetic `spanId` (`"span-" + event.id`) which doesn't match the real span hierarchy, resulting in flat/disconnected trees
  - ⚠️ When trace events come from ClickHouse, `agent_name` is always empty (set to `""` in `appendEvent`)

---

### 3.6 Node Detail Panel

- **Status:** ✅ EXISTS
- **Component:** `NodeDetailPanel.tsx`
- **Data Source:** Selected span from `observatory-store`
- **Layout:**

```
+------------------------------------------+
| TravelDesk_Supervisor    [handoff] [x]   |
+------------------------------------------+
| Cost      | Tokens     | Latency | Time  |
| $0.008    | 1,637      | 1.2s    | 07:57 |
+------------------------------------------+
| [Preview] [Request] [Response]           |
| [Metadata] [Logs]                        |
|                                          |
| Preview:                                 |
|   Model: claude-sonnet-4-20250514        |
|   Tokens: 1,245 in / 392 out            |
|   Cost: $0.008235                        |
|                                          |
| Request:                                 |
|   { messages: [...] }                    |
|                                          |
| Response:                                |
|   "I'd be happy to help you find..."    |
+------------------------------------------+
```

- **Tabs:** Preview, Request, Response, Metadata, Logs
- **What Works:** Full detail rendering for LLM calls (cost, tokens, latency), decision badge, copy ID, all five tabs
- **What's Missing:**
  - ⚠️ No tool call input/output formatting (raw JSON only)
  - ⚠️ No "diff" view for comparing request/response across LLM calls

---

### 3.7 Floating Debug Panel

- **Status:** ✅ EXISTS
- **Component:** `FloatingDebugPanel.tsx`
- **Purpose:** Draggable, resizable floating panel containing DebugTabs (used during live chat)
- **Features:** Drag to move, resize handle, dock/minimize/close buttons, Framer Motion drag controls
- **What Works:** All drag/resize/dock functionality
- **What's Missing:** None

---

### 3.8 Session List / Sessions Explorer

- **Status:** ✅ EXISTS (via `useSessionList` hook)
- **Data Source:** `GET /api/runtime/sessions?projectId=X` (5s polling)
- **Features:**
  - Group by agent name
  - Sort by lastActivityAt descending
  - Filter out `disposition='abandoned'`
  - Show: agent name, status, message count, duration, token count, cost
- **What's Missing:**
  - ❌ No time range filter
  - ❌ No channel filter in UI (API supports it)
  - ❌ No status filter in UI (API supports it)
  - ❌ No search by session ID
  - ❌ No CSV export button

---

## 4. Data Flow Diagrams

### 4.1 Session Detail Page Data Flow

```
User navigates to /projects/:projectId/sessions/:sessionId
    |
    v
useSessionDetail(sessionId, projectId)
    |
    v
SWR fetch: /api/runtime/sessions/:id?projectId=X
    |
    v (Studio Next.js proxy)
GET /api/projects/:projectId/sessions/:id
    |
    +--- RuntimeExecutor.getSessionDetail(id) ---- found? --+
    |        |                                                |
    |    Not found                                    Return active session
    |        |                                        (messages, traceEvents,
    |        v                                         state, threads)
    |   findSessionById(id, tenantId)                         |
    |        |                                                |
    |    Not found by DB ID                                   |
    |        |                                                |
    |        v                                                |
    |   findSessionByRuntimeId(id, tenantId)                  |
    |        |                                                |
    |     Found DB session                                    |
    |        |                                                |
    |        v                                                |
    |   findMessagesForSession(dbSession.id)                  |
    |        |                                                |
    |        v                                                |
    |   Trace fallback chain:                                 |
    |   1. TraceStore.getEvents(runtimeSessionId) ----------->|
    |   2. ClickHouse traces (getTraceForTenant) ------------>|
    |   3. Empty traces ------------------------------------->|
    |                                                         |
    v                                                         v
Response: { success: true, session: { id, messages, traceEvents, ... } }
    |
    v
fetchSessionDetail() parses response
    |
    v (if traceEvents empty)
Fallback: GET /api/runtime/sessions/:runtimeSessionId/traces?projectId=X
    |
    v
replayTraceEventsIntoObservatory(traceEvents, sessionId)
    |
    v
For each event:
    observatory-store.addEvent(extendedEvent)
        |
        +--- Creates/updates spans Map
        +--- Appends to events[]
        +--- Creates flowNodes for agents
        +--- Creates flowEdges for handoffs/delegates
        +--- Tracks metrics (tokens, LLM calls, tool calls)
        +--- Updates staticGraph execution state
    |
    v
hydrateSessionStoreFromDetail(session)
    |
    +--- session-store.restoreSession({ sessionId, agent, messages, state })
    |
    v
buildConversationTree(messages, traceEvents)
    |
    v
computeMetrics(traceEvents) with DB fallback
    |
    v
Render: SessionDetailPage
    +--- AgentConversationTree (tree)
    +--- SessionSummaryPanel (metrics, traceEvents, tree)
    +--- DebugTabs
             +--- TracesTab -> WaterfallPanel -> SpanTree (from observatory-store.getSpanTree())
             +--- DataTab -> TestContextPanel (from session-store)
             +--- ConversationTab (from session-store messages)
             +--- PerformanceTab -> LLMCallsTab
             +--- IRTab (from session-store agent.ir)
```

### 4.2 Live Chat Debug Data Flow

```
WebSocket connect -> ws://runtime:3112/ws with Sec-WebSocket-Protocol: web-debug-auth,<access_token>
    |
    v
Client sends: { type: "start_session", agentId: "traveldesk/TravelDesk_Supervisor" }
    |
    v
Handler creates RuntimeSession + TraceEmitter
    |
    v
Client sends: { type: "user_message", text: "Find hotels in Paris" }
    |
    v
RuntimeExecutor processes message
    |
    v
TraceEmitter.logAgentEnter() -> emit()
    |
    +--- TraceStore.addEvent(sessionId, event)
    |        |
    |        +--- broadcasts to subscribers
    |        +--- forwards to OTEL bridge
    |
    +--- WebSocket.send({ type: "trace_event", sessionId, event })
    |
    +--- EventStore dual-write (analytics)
    |
    v
Client (WebSocketContext) receives trace_event
    |
    v
observatory-store.addEvent(extendedEvent)
    |
    v
React re-renders:
    FloatingDebugPanel -> DebugTabs -> TracesTab -> WaterfallPanel -> SpanTree
```

### 4.3 Trace Storage & Retrieval Flow

```
Runtime (emit time):
    TraceEmitter.emit()
        |
        +--- In-memory TraceStore (ring buffer, 500 events/session, 120min TTL)
        |
        +--- ClickHouse BufferedWriter (10K rows / 5s flush)
        |       Table: abl_platform.traces
        |       Columns: tenant_id, session_id, trace_id, timestamp,
        |                span_id [BUG: randomUUID], parent_span_id [BUG: always ""],
        |                event_type, agent_name [BUG: always ""], data [encrypted],
        |                duration_ms, has_error, error_message, node_id, sequence
        |
        +--- EventStore dual-write -> abl_platform.platform_events
                (lossy type translation, analytics-optimized)

Studio (read time):
    GET /sessions/:id/traces
        |
        +--- 1. In-memory TraceStore -> immediate return if found
        |
        +--- 2. ClickHouse abl_platform.traces (gated: OBS_TRACE_CANONICAL_READ=true)
        |       -> preserves original event types
        |       -> supports encryption/decryption via interceptor
        |
        +--- 3. ClickHouse abl_platform.platform_events (always available)
                -> lossy type mapping (llm.call.completed -> llm_call)
                -> max 500 events
                -> no span hierarchy
```

---

## 5. Gap Analysis

### 5.1 Data Gaps

| #     | Gap                                                                                      | Impact                                                                                                        | Severity     | Fix                                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.1 | ClickHouse `appendEvent` writes `randomUUID()` as `span_id` and `""` as `parent_span_id` | Historical sessions loaded from ClickHouse have no span hierarchy -- SpanTree renders flat list or "No spans" | **Critical** | In `clickhouse-trace-store.ts:110-111`, use `event.spanId ?? randomUUID()` and `event.parentSpanId ?? ''`. Requires TraceEvent to carry spanId/parentSpanId (already present on TraceStore's in-memory type but not passed through to ClickHouse writer). |
| 5.1.2 | ClickHouse `appendEvent` writes `""` as `agent_name`                                     | Historical traces have no agent attribution -- WaterfallPanel cannot group by agent                           | **High**     | In `clickhouse-trace-store.ts:113`, use `event.agentName ?? ''`. Requires passing agentName through TraceEvent.                                                                                                                                           |
| 5.1.3 | `message.content` can be `ContentBlock[]` not `string`                                   | Conversation tree shows `"User input"` or `[object Object]` instead of actual text                            | **Medium**   | In `buildConversationTree`, extract text from ContentBlock array: `Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : content`                                                                                   |
| 5.1.4 | In-memory TraceStore has 120-minute TTL and 500-event ring buffer                        | Sessions older than 2 hours or with >500 events lose traces from memory                                       | **Medium**   | This is by design -- ClickHouse provides persistence. But the ClickHouse path needs 5.1.1 and 5.1.2 fixes to be useful.                                                                                                                                   |
| 5.1.5 | No per-span cost in ClickHouse writes                                                    | Historical LLM cost is lost after memory eviction                                                             | **Medium**   | Include `cost` field in the `data` JSON blob written to ClickHouse (already present if caller includes it in event.data). Verify all `logLLMCall` callers pass `cost`.                                                                                    |
| 5.1.6 | `replayTraceEventsIntoObservatory` creates synthetic spanId `"span-" + event.id`         | Replayed spans don't form parent-child hierarchy, waterfall is flat                                           | **High**     | Use the event's actual `spanId` and `parentSpanId` fields when available. In `replay-trace-events.ts:145-146`, prefer `event.spanId ?? eventData.spanId ?? ('span-' + event.id)` and `event.parentSpanId ?? eventData.parentSpanId`.                      |

### 5.2 View Gaps

| #     | Gap                                                | Impact                                                                         | Severity     | Fix                                                                                                                                                          |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.2.1 | TracesTab shows "No spans" for historical sessions | Users cannot debug historical sessions                                         | **Critical** | Fix 5.1.1 (ClickHouse span hierarchy) + 5.1.6 (replay span mapping). Together these ensure historical sessions produce a proper span tree.                   |
| 5.2.2 | No session list filters in UI                      | Users must scroll through all sessions to find specific ones                   | **Medium**   | Add time range picker, status dropdown, channel dropdown, and session ID search to SessionsExplorerTab. API already supports `status` and `channel` filters. |
| 5.2.3 | No CSV export button in UI                         | Export endpoint exists but is unreachable from the UI                          | **Low**      | Add export button to session list and session detail with session ID selection. Wire to `GET /sessions/export?sessionIds=...`.                               |
| 5.2.4 | Analysis endpoint not wired to UI                  | Server-side trace analysis is unused -- users cannot see automated diagnostics | **Medium**   | Add an "Analysis" tab or panel in SessionDetailPage that calls `GET /sessions/:id/analysis` and renders issues, suggestions, and flow path.                  |
| 5.2.5 | Agent-spec endpoint only works for active sessions | Cannot view DSL/IR for historical sessions                                     | **Medium**   | Add DB fallback in `/agent-spec` endpoint: look up agent by name from the session's `currentAgent` field when RuntimeExecutor session is gone.               |
| 5.2.6 | Performance tab only shows in-memory data          | No LLM call history for historical sessions                                    | **Medium**   | Wire `useSessionTraces` with `types=llm_call` filter to fetch from traces endpoint (which has ClickHouse fallback).                                          |
| 5.2.7 | No cost breakdown visualization                    | Users see total cost but cannot identify which LLM calls are expensive         | **Low**      | Add a cost waterfall or bar chart to the Performance tab, aggregating per-LLM-call cost from trace events.                                                   |

### 5.3 API Gaps

| #     | Gap                                                                     | Impact                                                                                                    | Severity   | Fix                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.3.1 | No dedicated `GET /sessions/:id/metrics` endpoint                       | Client must fetch all traces and compute metrics locally (unreliable for large sessions)                  | **Medium** | Add a dedicated metrics endpoint that queries ClickHouse for aggregated counts (total tokens, total cost, duration, error count, event type breakdown) without transferring full event payloads. |
| 5.3.2 | Generations endpoint only scans in-memory TraceStore (max 100 sessions) | LLM call history is lost after memory eviction                                                            | **High**   | Add ClickHouse fallback to `/generations` endpoint: `SELECT * FROM abl_platform.traces WHERE event_type = 'llm_call' AND tenant_id = ? ORDER BY timestamp DESC LIMIT ?`                          |
| 5.3.3 | Export endpoint only reads from in-memory TraceStore                    | Cannot export traces for historical sessions                                                              | **Medium** | Add ClickHouse fallback to `/export` endpoint, same pattern as `/traces` endpoint.                                                                                                               |
| 5.3.4 | No `GET /sessions/:id/messages` endpoint                                | Messages are bundled in the full session detail response -- cannot paginate messages independently        | **Low**    | For sessions with hundreds of messages, add a dedicated paginated messages endpoint. DB already supports `findMessagesForSessionCursor()`.                                                       |
| 5.3.5 | `OBS_TRACE_CANONICAL_READ` env var gates ClickHouse trace reads         | ClickHouse canonical traces are opt-in, meaning most deployments use the lossy `platform_events` fallback | **Medium** | Graduate `OBS_TRACE_CANONICAL_READ` to default-on after verifying ClickHouse trace write reliability in production.                                                                              |
| 5.3.6 | No bulk trace query across sessions                                     | Cannot correlate traces across related sessions (e.g., handoff chain)                                     | **Low**    | Add `GET /sessions/traces?sessionIds=x,y,z` that returns merged, chronologically sorted traces from multiple sessions.                                                                           |

---

## Appendix A: Event Type Taxonomy

### A.1 Core Event Types (TraceEventType)

```
llm_call          -- LLM inference call with model, tokens, cost
tool_call         -- Tool execution with input/output/success
decision          -- Routing/extraction/validation decision with reasoning
constraint_check  -- Constraint evaluation with pass/fail
handoff           -- Agent-to-agent handoff
escalation        -- Escalation to human/external system
error             -- Error occurrence
```

### A.2 Extended Event Types (ExtendedTraceEventType)

```
-- Session lifecycle
session_start, session_end, user_message, agent_response, session_updated

-- Agent lifecycle
agent_enter, agent_exit, delegate_start, delegate_complete

-- Flow execution
flow_step_enter, flow_step_exit, flow_transition

-- ABL construct events
dsl_collect, dsl_prompt, dsl_respond, dsl_set, dsl_on_input, dsl_call

-- Engine internals
completion_check, engine_decision, handoff_condition_check,
thread_return, data_stored, digression, sub_intent, correction,
constraint_violation, warning

-- Voice pipeline
voice_session_start, voice_session_end, voice_turn, voice_stt,
voice_tts, voice_tts_quality, voice_asr_quality, voice_asr_cascade,
voice_barge_in

-- LLM reasoning
tool_thought
```

### A.3 Decision Kinds (DecisionKind)

```
field_validation     -- Gather field validation result
gather_extraction    -- Entity extraction from user input
flow_transition      -- Step-to-step transition decision
correction           -- User correction handling
data_mutation        -- Context variable mutation
handoff              -- Agent handoff routing
delegation           -- Sub-agent delegation
constraint_check     -- Constraint evaluation
escalation           -- Escalation decision
guardrail_check      -- Guardrail evaluation
completion           -- Completion detection
```

---

## Appendix B: Store Architecture

### B.1 Observatory Store (Zustand)

```
observatory-store.ts
|
+-- spans: Map<string, Span>           -- Active and completed spans
+-- events: ExtendedTraceEvent[]        -- Bounded to 2,000 events
+-- activeSpanStack: string[]           -- Stack of active span IDs
+-- flowNodes: AgentFlowNode[]          -- Agent flow graph nodes
+-- flowEdges: AgentFlowEdge[]          -- Agent flow graph edges
+-- staticGraph: StaticGraph | null     -- Compiled state machine graph
+-- executionState: Map<string, NodeExecutionState>  -- Per-node visited state
+-- appStaticGraph: AppStaticGraph | null  -- Multi-agent app graph
+-- stepMetrics: Map<string, StepMetrics>  -- Per-step visit/duration/error
+-- constraintHistory: ConstraintCheckResult[]  -- Constraint check log
+-- Aggregate counters: totalTokensIn, totalTokensOut, totalLLMCalls, totalToolCalls
+-- Client timing: pendingMessageStartTime, lastVolleyClientMs, avgVolleyClientMs
+-- UI state: selectedSpanId, debugPanelTab, debugPanelOpen, canvasViewMode, etc.
```

### B.2 Session Store (Zustand)

```
session-store.ts
|
+-- sessionId: string
+-- agent: AgentDetails
+-- messages: SessionMessage[]
+-- state: AgentState (context, gatherProgress, constraintResults, flowState, etc.)
```

### B.3 Trace Stores (Runtime)

```
In-Memory TraceStore (TraceStore class)
|-- Ring buffer: 500 events/session
|-- TTL: 120 minutes
|-- Session timeout: 120 minutes
|-- Cleanup: every 60 seconds
|-- WebSocket subscriber broadcast
|-- OTEL bridge forwarding
|
Redis TraceStore (alternative, when Redis available)
|-- Same interface, distributed persistence
|
ClickHouse TraceStore
|-- Buffered writes (10K rows / 5s flush)
|-- Encryption at rest (compress-then-encrypt)
|-- Table: abl_platform.traces
```

---

## Appendix C: Platform Event Type Mapping

ClickHouse `platform_events` uses dot-notation event types that are mapped to trace event types for UI compatibility:

| Platform Event Type          | Trace Event Type      |
| ---------------------------- | --------------------- |
| `llm.call.completed`         | `llm_call`            |
| `llm.call.failed`            | `llm_call`            |
| `tool.call.completed`        | `tool_call`           |
| `tool.call.failed`           | `tool_call`           |
| `agent.entered`              | `agent_enter`         |
| `agent.exited`               | `agent_exit`          |
| `agent.handoff`              | `handoff`             |
| `agent.escalated`            | `escalation`          |
| `agent.delegated`            | `delegate_start`      |
| `agent.decision`             | `decision`            |
| `agent.constraint.checked`   | `constraint_check`    |
| `flow.step.entered`          | `flow_step_enter`     |
| `flow.step.exited`           | `flow_step_exit`      |
| `flow.transition`            | `flow_transition`     |
| `session.started`            | `session_created`     |
| `session.ended`              | `session_ended`       |
| `session.updated`            | `session_updated`     |
| `message.user.received`      | `user_message`        |
| `message.agent.sent`         | `agent_response`      |
| `voice.session.started`      | `voice_session_start` |
| `voice.session.ended`        | `voice_session_end`   |
| `voice.turn.completed`       | `voice_turn`          |
| `voice.stt.completed`        | `voice_stt`           |
| `voice.tts.completed`        | `voice_tts`           |
| `voice.barge_in.detected`    | `voice_barge_in`      |
| `voice.asr_quality.analyzed` | `voice_asr_quality`   |
| `voice.tts_quality.measured` | `voice_tts_quality`   |
| `voice.asr_cascade.detected` | `voice_asr_cascade`   |
