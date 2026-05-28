# Observatory API <-> View Specification

**Generated:** 2026-03-10
**Source:** JSON files in `docs/observatory-spec/`
**Regenerate:** `npx tsx docs/observatory-spec/generate-spec.ts`

---

## 1. API Inventory

### 1.1 POST /api/projects/:projectId/sessions

- **Status:** exists
- **Purpose:** Create a new test session for an agent
- **Auth:** `session:execute`
- **Request Body:**

```json
{
  "agentId": "traveldesk/TravelDesk_Supervisor"
}
```

- **Response:**

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

- **Consumed By:** Studio chat panel (TestSessionService)

---

### 1.2 GET /api/projects/:projectId/sessions

- **Status:** exists
- **Purpose:** List sessions with pagination and filtering. DB is primary source; RuntimeExecutor augments with live status.
- **Query Params:**
  - `limit` (number) default: 50 max: 200
  - `offset` (number) default: 0
  - `status` (string) values: active, ended, completed, escalated, abandoned
  - `channel` (string) values: web_debug, slack, whatsapp, voice
- **Response:**

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

- **Consumed By:** useSessionList hook, SessionsExplorerTab, SessionExplorerPage (admin)
- **Notes:**
  - Ghost sessions (0 messages, 0 traces, not active) are filtered out
  - Active sessions get status: 'active' regardless of DB status
  - Duration computed from: callDuration (voice) > endedAt-startedAt > lastActivityAt-startedAt

---

### 1.3 GET /api/projects/:projectId/sessions/:id

- **Status:** exists
- **Purpose:** Get full session detail including messages, state, and trace events
- **Response:**

```json
{
  "success": true,
  "session": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "agent": {
      "name": "TravelDesk_Supervisor"
    },
    "agentName": "TravelDesk_Supervisor",
    "state": {
      "context": {
        "destination": "paris"
      },
      "conversationPhase": "gathering",
      "gatherProgress": {
        "destination": "paris",
        "dates": null
      },
      "constraintResults": {},
      "lastToolResults": {},
      "memory": {
        "session": {},
        "persistentCache": {},
        "pendingRemembers": []
      }
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
    "threads": [
      {
        "agentName": "TravelDesk_Supervisor",
        "index": 0
      }
    ],
    "activeThreadIndex": 0,
    "createdAt": "2026-03-10T07:57:00.000Z",
    "lastActivityAt": "2026-03-10T07:57:32.300Z"
  }
}
```

- **Consumed By:** useSessionDetail hook, SessionDetailPage, AgentConversationTree, SessionSummaryPanel, DebugTabs
- **Trace Fallback Chain:**
  1. RuntimeExecutor getSessionDetail() trace events
  2. In-memory TraceStore getEvents(runtimeSessionId)
  3. ClickHouse abl_platform.traces (canonical, with real span_id/parent_span_id/agent_name)
- **Missing:**
  - No handoffCount field in detail response (available in list response via DB)

---

### 1.4 DELETE /api/projects/:projectId/sessions/:id

- **Status:** exists
- **Purpose:** Soft-delete session. Cleans up RuntimeExecutor + cascade deletes from DB (session + messages + usage metrics + attachments + events)
- **Auth:** `session:delete`
- **Response:**

```json
{
  "success": true,
  "message": "Session deleted"
}
```

- **Consumed By:** Studio session list delete button, admin session management

---

### 1.5 POST /api/projects/:projectId/sessions/:id/close

- **Status:** exists
- **Purpose:** Close a session with an explicit disposition
- **Request Body:**

```json
{
  "disposition": "completed"
}
```

- **Response:**

```json
{
  "success": true,
  "message": "Session closed with disposition: completed",
  "status": "completed",
  "disposition": "completed"
}
```

- **Consumed By:** Voice pipeline (call end), Studio session close action

---

### 1.6 POST /api/projects/:projectId/sessions/:id/reset

- **Status:** exists
- **Purpose:** Reset session state, messages, and traces (active sessions only)
- **Auth:** `session:execute`
- **Response:**

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
- **Notes:**
  - Only works for active RuntimeExecutor sessions, not historical DB sessions

---

### 1.7 GET /api/projects/:projectId/sessions/:id/traces

- **Status:** exists
- **Purpose:** Get session trace events with filtering, pagination, and multi-source fallback
- **Query Params:**
  - `limit` (number)
  - `offset` (number)
  - `types` (string) — comma-separated event types
  - `eventType` (string)
  - `decisionKind` (string)
  - `spanId` (string)
  - `include` (string) values: metrics
- **Response:**

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
      "data": {
        "agentName": "TravelDesk_Supervisor",
        "mode": "reasoning"
      },
      "agentName": "TravelDesk_Supervisor",
      "spanId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "parentSpanId": null
    }
  ],
  "_meta": {
    "source": "memory",
    "event_count": 23,
    "is_truncated": false
  },
  "metrics": {
    "f47ac10b-58cc-4372-a567-0e02b2c3d479": {
      "eventCount": 15,
      "durationMs": 28400,
      "types": {
        "llm_call": 3,
        "tool_call": 2,
        "decision": 5,
        "agent_enter": 1,
        "agent_exit": 1
      }
    }
  }
}
```

- **Consumed By:** useSessionTraces hook, useSessionDetail (fallback fetch), traces explorer
- **Trace Fallback Chain:**
  1. In-memory TraceStore (runtimeSessionId, then sessionId)
  2. ClickHouse abl_platform.traces (canonical — always attempted when isClickHouseTraceEnabled())
  3. ClickHouse abl_platform.platform_events (lossy type translation, last resort)
- **Notes:**
  - OBS_TRACE_CANONICAL_READ feature flag removed (2026-03-10). ClickHouse canonical reads always attempted.
  - ClickHouse traces now include real span_id, parent_span_id, and agent_name.
  - queryClickHouseCanonicalTraces returns spanId and parentSpanId in response shape.

---

### 1.8 GET /api/projects/:projectId/sessions/:id/traces/:spanId/children

- **Status:** exists
- **Purpose:** Get child events for a specific span — progressive loading
- **Response:**

```json
{
  "success": true,
  "children": [
    {
      "id": "evt_003",
      "type": "tool_call",
      "parentSpanId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "data": {
        "toolName": "search_hotels",
        "success": true
      }
    }
  ]
}
```

- **Consumed By:** WaterfallPanel lazy loading, SpanTree expand
- **Notes:**
  - Filters in-memory TraceStore events by parentSpanId matching the :spanId param.
  - Returns events whose data.parentSpanId or event linkage matches.

---

### 1.9 GET /api/projects/:projectId/sessions/:id/metrics

- **Status:** exists
- **Purpose:** Get aggregated session metrics — dedicated endpoint with ClickHouse fallback
- **Response:**

```json
{
  "success": true,
  "metrics": {
    "totalEvents": 23,
    "totalLLMCalls": 5,
    "totalToolCalls": 10,
    "totalTokensIn": 3200,
    "totalTokensOut": 1800,
    "totalTokens": 5000,
    "totalCost": 0.030065,
    "totalDurationMs": 32300,
    "errorCount": 0,
    "source": "memory"
  }
}
```

- **Consumed By:** SessionSummaryPanel, Performance tab metrics cards
- **Notes:**
  - Primary: aggregates from in-memory TraceStore events.
  - Fallback: when in-memory is empty, queries ClickHouse canonical traces and aggregates from data JSON blobs.
  - Field names follow observatory-spec canonical format: totalLLMCalls, totalToolCalls, totalTokensIn, totalTokensOut.

---

### 1.10 GET /api/projects/:projectId/sessions/:id/agent-spec

- **Status:** exists
- **Purpose:** Get agent specification (DSL source, compiled IR, metadata) for a session
- **Auth:** `session:read`
- **Response:**

```json
{
  "success": true,
  "agent": {
    "id": "TravelDesk_Supervisor",
    "name": "TravelDesk_Supervisor",
    "type": "supervisor",
    "mode": "reasoning",
    "dsl": "AGENT TravelDesk_Supervisor\n  ROLE: \"You are a travel assistant...\"\n  ...",
    "ir": {
      "agent": {
        "name": "TravelDesk_Supervisor",
        "role": "..."
      },
      "steps": [],
      "tools": []
    },
    "toolCount": 5,
    "gatherFieldCount": 3
  }
}
```

- **Consumed By:** IR tab in DebugTabs, agent spec viewer
- **Missing:**
  - No DB fallback for historical sessions (returns 404 if session is not in RuntimeExecutor)
- **Notes:**
  - Only works for active RuntimeExecutor sessions (needs getSession())

---

### 1.11 GET /api/projects/:projectId/sessions/:id/analysis

- **Status:** exists
- **Purpose:** Automated trace analysis with issue detection, suggestions, and flow path analysis
- **Auth:** `session:read`
- **Response:**

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

- **Missing:**
  - No DB/ClickHouse fallback for historical sessions
  - No UI component consumes this endpoint
- **Notes:**
  - Active sessions only (requires RuntimeExecutor getSession())

---

### 1.12 GET /api/projects/:projectId/sessions/export

- **Status:** exists
- **Purpose:** Export trace events as CSV
- **Query Params:**
  - `sessionIds` (string) — comma-separated, required, max 20
  - `eventType` (string)
  - `decisionKind` (string)
- **Missing:**
  - No UI button/flow triggers this export
  - Only exports from in-memory TraceStore (no ClickHouse fallback)

---

### 1.13 GET /api/projects/:projectId/sessions/generations

- **Status:** exists
- **Purpose:** List all LLM call events across sessions (generations view)
- **Query Params:**
  - `sessionId` (string) — optional filter
  - `limit` (number) default: 50 max: 500
  - `offset` (number)
- **Response:**

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
      "spanId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    }
  ]
}
```

- **Consumed By:** LLMCallsTab in DebugTabs
- **Missing:**
  - No model name normalization (raw model string from provider)
- **Notes:**
  - Primary: scans in-memory TraceStore across active sessions.
  - Fallback: when in-memory returns empty and sessionId filter is provided, queries ClickHouse abl_platform.traces WHERE event_type = 'llm_call'.

---

### 1.14 POST /api/projects/:projectId/sessions/bulk-close

- **Status:** exists
- **Purpose:** Close all matching sessions for a project/agent
- **Request Body:**

```json
{
  "agentName": "TravelDesk_Supervisor",
  "disposition": "abandoned"
}
```

- **Response:**

```json
{
  "success": true,
  "closedRuntime": 3,
  "closedDb": 12
}
```

- **Consumed By:** Admin session management

---

### 1.15 POST /api/projects/:projectId/sessions/cleanup-orphans

- **Status:** exists
- **Purpose:** Delete orphaned/phantom sessions that were never fully initialized
- **Query Params:**
  - `dryRun` (boolean) default: false
- **Response:**

```json
{
  "success": true,
  "deletedDb": 5
}
```

- **Consumed By:** Admin maintenance operations
- **Notes:**
  - Orphan criteria: messageCount=0 AND no runtimeSessionId AND status in (active, idle)

---

### 1.16 WS /ws

- **Status:** exists
- **Purpose:** Real-time trace event streaming during live sessions
- **Response:**

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
      "input": {
        "destination": "paris",
        "dates": "2026-03-17 to 2026-03-24"
      },
      "output": {
        "results": ["..."]
      },
      "success": true,
      "latencyMs": 800
    },
    "deploymentId": "deploy_abc",
    "environment": "development",
    "agentVersions": {
      "TravelDesk_Supervisor": 3
    }
  }
}
```

- **Consumed By:** WebSocketContext -> observatory-store.addEvent(), DebugTabs, FloatingDebugPanel
- **Message Types:**
  - `trace_event` — Individual trace event (same shape as REST trace events)
  - `trace_replay` — Bulk replay of buffered events on subscribe
  - `session_ended` — Session termination notification
  - `session_expired` — Session timeout notification
  - `response_chunk` — Streaming LLM response text

---

### 1.17 GET /api/runtime/sessions/[id]

- **Status:** exists
- **Purpose:** Studio proxy to Runtime for session detail
- **Proxies To:** `GET /api/projects/:projectId/sessions/:id`
- **Query Params:**
  - `projectId` (string)

---

### 1.18 GET /api/runtime/sessions/[id]/traces

- **Status:** exists
- **Purpose:** Studio proxy to Runtime for session traces
- **Proxies To:** `GET /api/projects/:projectId/sessions/:id/traces`
- **Query Params:**
  - `projectId` (string)

---

## 2. Data Elements Dictionary

### 2.1 SessionMessage

| Field                           | Type              | Sample                               | Source                               |
| ------------------------------- | ----------------- | ------------------------------------ | ------------------------------------ | ---------- | ------ | ------- |
| `id`                            | `string`          | `msg_001`                            | MongoDB messages.id                  |
| `role`                          | `"user"           | "assistant"                          | "system"                             | "thought"` | `user` | MongoDB |
| `content`                       | `string           | ContentBlock[]`                      | `Find hotels in Paris for next week` | MongoDB    |
| `timestamp`                     | `Date`            | `2026-03-10T07:57:01.000Z`           | MongoDB                              |
| `traceIds`                      | `string[]`        | `["evt_001","evt_002"]`              | MongoDB                              |
| `metadata?.tokensIn`            | `number`          | `1245`                               | Computed at message time             |
| `metadata?.tokensOut`           | `number`          | `392`                                | Computed at message time             |
| `metadata?.latencyMs`           | `number`          | `1200`                               | Computed at message time             |
| `metadata?.action`              | `ConstructAction` | `{"type":"respond","message":"..."}` | Runtime engine                       |
| `metadata?.toolName`            | `string`          | `search_hotels`                      | Runtime engine                       |
| `metadata?.agentName`           | `string`          | `TravelDesk_Supervisor`              | Runtime engine                       |
| `metadata?.handoffFrom`         | `string`          | `Supervisor`                         | Runtime engine                       |
| `metadata?.handoffTo`           | `string`          | `HotelSearch_Agent`                  | Runtime engine                       |
| `metadata?.attachmentFilenames` | `string[]`        | `["invoice.pdf"]`                    | Upload pipeline                      |

---

### 2.2 TraceEvent

_Studio client type_

| Field          | Type                      | Sample                                                 | Source                              |
| -------------- | ------------------------- | ------------------------------------------------------ | ----------------------------------- | ----------------------- |
| `id`           | `string`                  | `evt_001`                                              | crypto.randomUUID() in TraceEmitter |
| `sessionId`    | `string`                  | `a1b2c3d4-...`                                         | TraceEmitter config                 |
| `type`         | `ExtendedTraceEventType`  | `llm_call`                                             | TraceEmitter method                 |
| `timestamp`    | `Date`                    | `2026-03-10T07:57:00.200Z`                             | new Date() at emit time             |
| `durationMs`   | `number                   | undefined`                                             | `1200`                              | Computed by caller      |
| `data`         | `Record<string, unknown>` | `{"model":"claude-sonnet-4-20250514","tokensIn":1245}` | Caller-provided                     |
| `decisionKind` | `DecisionKind             | undefined`                                             | `handoff`                           | Only when type=decision |

---

### 2.3 ExtendedTraceEvent

_Observatory store type_

| Field                | Type                      | Sample                                     | Source                             |
| -------------------- | ------------------------- | ------------------------------------------ | ---------------------------------- | ---------------------------- | ------ | -------- |
| `id`                 | `string`                  | `evt_001`                                  | From TraceEvent                    |
| `type`               | `ExtendedTraceEventType`  | `agent_enter`                              | From TraceEvent                    |
| `timestamp`          | `Date`                    | `2026-03-10T07:57:00.100Z`                 | From TraceEvent                    |
| `durationMs`         | `number                   | undefined`                                 | `1200`                             | From TraceEvent              |
| `traceId`            | `string`                  | `a1b2c3d4-...`                             | event.sessionId or sessionId param |
| `spanId`             | `string`                  | `span-TravelDesk_Supervisor-1741590420100` | From TraceEmitter span stack       |
| `parentSpanId`       | `string                   | undefined`                                 | `span-root-1741590420000`          | From TraceEmitter span stack |
| `sessionId`          | `string`                  | `a1b2c3d4-...`                             | TraceEmitter config                |
| `agentName`          | `string`                  | `TravelDesk_Supervisor`                    | data.agentName or 'unknown'        |
| `stepName`           | `string                   | undefined`                                 | `search_hotels`                    | data.stepName                |
| `data`               | `Record<string, unknown>` | `{"agentName":"...","mode":"reasoning"}`   | From TraceEvent                    |
| `metadata?.severity` | `"debug"                  | "info"                                     | "warn"                             | "error"`                     | `info` | Optional |
| `metadata?.tags`     | `string[]`                | `["critical-path"]`                        | Optional                           |

---

### 2.4 Span

_Observatory store type_

| Field          | Type                      | Sample                                | Source                           |
| -------------- | ------------------------- | ------------------------------------- | -------------------------------- | ----------------------- | ---------------- |
| `spanId`       | `string`                  | `span-TravelDesk_Supervisor-a1b2c3d4` | observatory-store.startSpan()    |
| `traceId`      | `string`                  | `a1b2c3d4-...`                        | From ExtendedTraceEvent          |
| `parentSpanId` | `string                   | undefined`                            | `span-root-...`                  | From ExtendedTraceEvent |
| `name`         | `string`                  | `TravelDesk_Supervisor`               | Agent name or step name          |
| `startTime`    | `Date`                    | `2026-03-10T07:57:00.100Z`            | new Date() at span start         |
| `endTime`      | `Date                     | undefined`                            | `2026-03-10T07:57:32.300Z`       | Set on endSpan()        |
| `durationMs`   | `number                   | undefined`                            | `32200`                          | endTime - startTime     |
| `status`       | `"running"                | "completed"                           | "error"`                         | `completed`             | Set on endSpan() |
| `agentName`    | `string`                  | `TravelDesk_Supervisor`               | From event                       |
| `sessionId`    | `string`                  | `a1b2c3d4-...`                        | From event                       |
| `events`       | `ExtendedTraceEvent[]`    | `[...]`                               | Accumulated via addEventToSpan() |
| `attributes`   | `Record<string, unknown>` | `{}`                                  | Currently unused                 |

---

### 2.5 TreeNode

_Conversation tree type_

| Field       | Type                               | Sample                    | Source                           |
| ----------- | ---------------------------------- | ------------------------- | -------------------------------- | --------------------------------------- |
| `id`        | `string`                           | `evt_001`                 | Event ID or synthetic            |
| `type`      | `TreeNodeType`                     | `user_input`              | Derived from event type          |
| `label`     | `string`                           | `Find hotels in Paris...` | Message content or event summary |
| `detail`    | `string                            | undefined`                | `(reasoning)`                    | Model name, token count, etc.           |
| `tokens`    | `{ input: number; output: number } | undefined`                | `{"input":1245,"output":392}`    | From data.tokensIn/tokensOut            |
| `latencyMs` | `number                            | undefined`                | `1200`                           | From event.durationMs or data.latencyMs |
| `timestamp` | `string                            | undefined`                | `2026-03-10T07:57:00.200Z`       | ISO string                              |
| `data`      | `Record<string, unknown>           | undefined`                | `Full event data`                | Raw trace event data                    |
| `children`  | `TreeNode[]`                       | `[...]`                   | Nested hierarchy                 |

---

### 2.6 SessionListItem

_Studio type_

| Field              | Type     | Sample                     | Source                    |
| ------------------ | -------- | -------------------------- | ------------------------- | --------- |
| `id`               | `string` | `clxyz123abc456def789`     | MongoDB \_id              |
| `agentId`          | `string` | `TravelDesk_Supervisor`    | currentAgent from DB      |
| `agentName`        | `string` | `TravelDesk_Supervisor`    | RuntimeExecutor or DB     |
| `status`           | `string` | `active`                   | DB + runtime augmentation |
| `runtimeSessionId` | `string  | undefined`                 | `a1b2c3d4-...`            | DB column |
| `durationMs`       | `number` | `32300`                    | Computed server-side      |
| `messageCount`     | `number` | `4`                        | DB or RuntimeExecutor     |
| `traceEventCount`  | `number` | `23`                       | TraceStore or DB counter  |
| `tokenCount`       | `number` | `6013`                     | DB aggregate              |
| `estimatedCost`    | `number` | `0.030065`                 | DB aggregate              |
| `errorCount`       | `number` | `0`                        | DB counter                |
| `disposition`      | `string  | null`                      | `completed`               | DB field  |
| `channel`          | `string  | undefined`                 | `web_debug`               | DB field  |
| `createdAt`        | `string` | `2026-03-10T07:57:00.000Z` | DB startedAt              |
| `lastActivityAt`   | `string` | `2026-03-10T07:57:32.300Z` | DB field                  |

---

### 2.7 ClickHouseTraceRow

_Storage type — canonical persistent trace store_

| Field            | Type       | Sample                                                  | Source                                                                                             |
| ---------------- | ---------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| `tenant_id`      | `string`   | `tenant_abc`                                            | From ClickHouseTraceStore config                                                                   |
| `session_id`     | `string`   | `a1b2c3d4-...`                                          | Runtime session ID                                                                                 |
| `trace_id`       | `string`   | `a1b2c3d4-...`                                          | Same as session_id in current usage                                                                |
| `timestamp`      | `string`   | `2026-03-10 07:57:00.200`                               | ISO without T/Z                                                                                    |
| `span_id`        | `string`   | `f47ac10b-58cc-4372-a567-0e02b2c3d479`                  | Real event ID from traceEvent.id via createCentralizedTraceHandler                                 |
| `parent_span_id` | `string`   | `a3e8b1c7-42d9-4f01-8e7c-9d5b6a0f2e13`                  | Derived: tool_call → preceding llm_call span_id; explicit parentSpanId from event.data             |
| `event_type`     | `string`   | `llm_call`                                              | From TraceEvent.type                                                                               |
| `agent_name`     | `string`   | `TravelDesk_Supervisor`                                 | From traceEvent.agentName via createCentralizedTraceHandler                                        |
| `data`           | `string`   | `{"model":"claude-sonnet-4-20250514","cost":0.008,...}` | JSON-stringified event data; llm_call events include cost field (default 0). Optionally encrypted. |
| `encrypted`      | `number (0 | 1)`                                                     | `1`                                                                                                | Whether data column is encrypted |
| `key_version`    | `number`   | `1`                                                     | Encryption key version                                                                             |
| `duration_ms`    | `number`   | `1200`                                                  | From event.durationMs                                                                              |
| `has_error`      | `number (0 | 1)`                                                     | `0`                                                                                                | Derived from event type/data     |
| `error_message`  | `string`   | ``                                                      | From event.data.error                                                                              |
| `node_id`        | `string`   | ``                                                      | From trace context (createTrace/endTrace only)                                                     |
| `sequence`       | `string`   | ``                                                      | From event.sequence                                                                                |

---

### 2.8 TraceEventTypes

_All event types emitted by TraceEmitter_

| Event Type          | Emitter                          | Key Data Fields                                                                             | Verbosity                   |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------- |
| `llm_call`          | `logLLMCall()`                   | `model`, `messagesIn`, `tokensIn`, `tokensOut`, `latencyMs`, `cost`, `messages`, `response` | standard                    |
| `tool_call`         | `logToolCall()`                  | `toolName`, `input`, `output`, `success`, `latencyMs`, `error`                              | standard                    |
| `decision`          | `logDecision() / emitDecision()` | `decisionType/decisionKind`, `decision`, `reasoning`, `contextMeta`                         | standard/verbose (per kind) |
| `constraint_check`  | `logConstraintCheck()`           | `constraint`, `passed`, `context`                                                           | standard                    |
| `handoff`           | `logHandoff()`                   | `toAgent`, `reason`, `contextMeta`                                                          | standard                    |
| `escalation`        | `logEscalation()`                | `reason`, `priority`, `contextMeta`                                                         | standard                    |
| `error`             | `logError()`                     | `errorType`, `message`, `stack`                                                             | always                      |
| `user_message`      | `logUserMessage()`               | `contentLength`, `channel`, `hasAttachments`, `attachmentCount`                             | standard                    |
| `agent_response`    | `logAgentResponse()`             | `contentLength`, `channel`, `hasRichContent`, `durationMs`                                  | standard                    |
| `session_updated`   | `logSessionUpdated()`            | `updateSource`, `keysUpdated`, `updateCount`                                                | standard                    |
| `agent_enter`       | `logAgentEnter()`                | `agentName`, `mode`, `trigger`, `spanId`, `parentSpanId`                                    | standard                    |
| `agent_exit`        | `logAgentExit()`                 | `agentName`, `result`, `durationMs`                                                         | standard                    |
| `flow_step_enter`   | `logFlowStepEnter()`             | `agentName`, `stepName`, `stepType`                                                         | standard                    |
| `flow_step_exit`    | `logFlowStepExit()`              | `agentName`, `stepName`, `durationMs`                                                       | standard                    |
| `flow_transition`   | `logFlowTransition()`            | `agentName`, `fromStep`, `toStep`, `condition`                                              | standard                    |
| `delegate_start`    | `logDelegateStart()`             | `fromAgent`, `targetAgent`, `task`                                                          | standard                    |
| `delegate_complete` | `logDelegateComplete()`          | `fromAgent`, `targetAgent`, `success`, `durationMs`                                         | standard                    |

---

### 2.9 SessionMetrics

_Aggregated metrics returned by GET /sessions/:id/metrics_

| Field             | Type      | Sample        | Source                                                              |
| ----------------- | --------- | ------------- | ------------------------------------------------------------------- | ----------------------------- |
| `totalEvents`     | `number`  | `23`          | Count of all trace events                                           |
| `totalLLMCalls`   | `number`  | `5`           | Count of llm_call events                                            |
| `totalToolCalls`  | `number`  | `10`          | Count of tool_call events                                           |
| `totalTokensIn`   | `number`  | `3200`        | Sum of data.tokensIn from llm_call events                           |
| `totalTokensOut`  | `number`  | `1800`        | Sum of data.tokensOut from llm_call events                          |
| `totalTokens`     | `number`  | `5000`        | totalTokensIn + totalTokensOut                                      |
| `totalCost`       | `number`  | `0.030065`    | Sum of data.cost from llm_call events (rounded to 6 decimal places) |
| `totalDurationMs` | `number`  | `32300`       | Sum of durationMs from all events                                   |
| `errorCount`      | `number`  | `0`           | Count of error events or events with has_error                      |
| `source`          | `"memory" | "clickhouse"` | `memory`                                                            | Which store provided the data |

---

## 3. View Specifications

### 3.1 Session Detail Page

- **Status:** exists
- **Component:** `SessionDetailPage.tsx`
- **Route:** `/projects/:projectId/sessions/:sessionId`
- **APIs Used:** GET /sessions/:id (via useSessionDetail), GET /sessions/:id/traces (fallback), GET /sessions/:id/metrics
- **Layout:** Two-column
  - **Conversation Tree** (35%): Hierarchical tree of user inputs, agent nodes, LLM calls, tool calls, responses
  - **Detail Panel** (65%):
    - Summary: `SessionSummaryPanel` — Metrics (cost, tokens, latency, LLM calls) + node detail tabs
    - Debug Tabs: `DebugTabs` — Traces, Data, Conversation, Performance, IR
- **Working:**
  - Two-column resizable layout with horizontal drag handle
  - Vertical resizable split (summary top / debug tabs bottom)
  - Breadcrumb navigation with shortened session ID
  - Loading states with spinner
  - Error state with retry button
  - Top-right metrics bar (trace count, token count, cost)
  - Session store hydration from REST data
  - Observatory store replay from trace events
  - Cleanup on unmount (clears all stores)
- **Broken / Missing:**
  - Conversation tree shows [object Object] when message.content is ContentBlock[] instead of string
  - Cost shows '--' for sessions where DB estimatedCost is 0 and no trace-level cost aggregation is wired to UI

---

### 3.2 Agent Conversation Tree

- **Status:** exists
- **Component:** `AgentConversationTree.tsx`
- **Data Source:** tree from useSessionDetail -> buildConversationTree()
- **Node Types:**
  | Type | Icon | Color | Badges |
  | --- | --- | --- | --- |
  | `user_input` | User | accent | — |
  | `agent` | Bot | success | mode |
  | `sub_agent` | Bot | success | mode |
  | `llm_call` | Cpu | warning | tokens, latency |
  | `tool_call` | Wrench | info | latency |
  | `handoff` | ArrowRightLeft | warning | target |
  | `delegate_action` | ArrowRightLeft | info | target |
  | `complete` | CheckCircle2 | success | — |
  | `escalate` | AlertTriangle | error | — |
  | `decision` | Lightbulb | muted | type |
  | `flow_step` | Workflow | info | step type |
  | `flow_transition` | GitBranch | muted | condition |
  | `agent_response` | divider style | muted | — |
  | `voice_session_start` | Phone | success | STT/TTS vendor |
  | `voice_session_end` | PhoneOff | muted | turn count |
  | `voice_turn` | AudioLines | info | timing breakdown |
  | `voice_stt` | Mic | info | confidence % |
  | `voice_tts` | Volume2 | info | chunks, duration |
  | `voice_barge_in` | VolumeX | warning | type, turn |
- **Working:**
  - Hierarchical tree with expand/collapse (auto-expanded to depth 2)
  - Click-to-select highlights node and updates selectedTraceNodeId in UI store
  - Token/latency badges on LLM and tool call nodes
  - Agent response separator between turns
  - Voice session rendering
  - Hex ID filtering (avoids showing raw MongoDB ObjectIds as labels)
  - System tool detection (**handoff**, **delegate**, **complete**, **escalate**)
- **Broken / Missing:**
  - When message.content is ContentBlock[] (rich content), label shows 'User input' instead of extracted text

---

### 3.3 Session Summary Panel

- **Status:** exists
- **Component:** `SessionSummaryPanel.tsx`
- **Data Source:** metrics from useSessionDetail, traceEvents, tree, selected node from ui-store
- **Working:**
  - Metric cards with cost, tokens, latency, LLM calls
  - Tab switching with selected node detail
  - Voice tab auto-detected from voice_session_start events
  - JsonViewer for raw data inspection
  - Copy session ID to clipboard
  - MetricInfoIcon tooltips
- **Broken / Missing:**
  - No fullscreen mode for large JSON payloads

---

### 3.4 Debug Tabs

- **Status:** exists
- **Component:** `DebugTabs.tsx`
- **Tabs:**
  | ID | Label | Icon | Content |
  | --- | --- | --- | --- |
  | `traces` | Traces | Activity | WaterfallPanel with SpanTree |
  | `data` | Data | Database | TestContextPanel (gather progress, context vars) |
  | `conversation` | Conversation | MessageSquare | Conversation history viewer |
  | `performance` | Performance | Gauge | LLMCallsTab (generations list) |
  | `ir` | IR | Code2 | Agent IR JSON viewer |
- **Working:**
  - Animated tab indicator (Framer Motion)
  - Scrollable tab bar
  - Docked / floating mode toggle
  - Log viewer with clear button
  - All five tabs render content
- **Broken / Missing:**
  - Performance tab (LLMCallsTab) needs to wire useSessionTraces with types=llm_call filter for ClickHouse fallback

---

### 3.5 Waterfall Panel + Span Tree

- **Status:** exists
- **Components:** `WaterfallPanel.tsx`, `SpanTree.tsx`
- **Working:**
  - Full span tree rendering for live sessions
  - Cost color coding
  - Decision event badges
  - Token aggregation per span
- **Features:**
  - Summary bar with totals
  - Live/Historical mode indicator
  - Expandable span tree with parent-child hierarchy
  - Cost column with color coding (green < $0.01, yellow < $0.10, red >= $0.10)
  - Token breakdown tooltip (prompt + completion)
  - Decision event rendering inline with reason text
  - Copy span ID to clipboard
  - Click to select span -> NodeDetailPanel

---

### 3.6 Node Detail Panel

- **Status:** exists
- **Component:** `NodeDetailPanel.tsx`
- **Data Source:** Selected span from observatory-store
- **Tabs:**
  | ID | Label | Icon | Content |
  | --- | --- | --- | --- |
  | `undefined` | | | |
  | `undefined` | | | |
  | `undefined` | | | |
  | `undefined` | | | |
  | `undefined` | | | |
- **Working:**
  - Full detail rendering for LLM calls (cost, tokens, latency)
  - Decision badge
  - Copy ID
  - All five tabs
- **Broken / Missing:**
  - No tool call input/output formatting (raw JSON only)
  - No diff view for comparing request/response across LLM calls

---

### 3.7 Floating Debug Panel

- **Status:** exists
- **Component:** `FloatingDebugPanel.tsx`
- **Working:**
  - All drag/resize/dock functionality
- **Features:**
  - Drag to move
  - Resize handle
  - Dock/minimize/close buttons
  - Framer Motion drag controls

---

### 3.8 Session List / Sessions Explorer

- **Status:** exists
- **Data Source:** GET /api/runtime/sessions?projectId=X (5s polling via useSessionList)
- **Broken / Missing:**
  - No time range filter
  - No channel filter in UI (API supports it)
  - No status filter in UI (API supports it)
  - No search by session ID
  - No CSV export button
- **Features:**
  - Group by agent name
  - Sort by lastActivityAt descending
  - Filter out disposition='abandoned'
  - Show: agent name, status, message count, duration, token count, cost

---

## 4. Data Flow Diagrams

### 4.1 Session Detail Page Data Flow

**Step 1:** User navigates to /projects/:projectId/sessions/:sessionId
**Step 2:** useSessionDetail(sessionId, projectId) triggers SWR fetch
**Step 3:** SWR fetch: /api/runtime/sessions/:id?projectId=X (Studio Next.js proxy)
**Step 4:** Runtime: GET /api/projects/:projectId/sessions/:id
**Step 5:** Lookup chain

- _If RuntimeExecutor.getSessionDetail(id) found:_ Return active session (messages, traceEvents, state, threads)
- _If Not found in RuntimeExecutor:_ - findSessionById(id, tenantId) - If not found: findSessionByRuntimeId(id, tenantId) - findMessagesForSession(dbSession.id) - Trace fallback: TraceStore.getEvents(runtimeSessionId) -> ClickHouse abl_platform.traces -> Empty traces
  **Step 6:** Response: { success: true, session: { id, messages, traceEvents, ... } }
  **Step 7:** fetchSessionDetail() parses response
  **Step 8:** If traceEvents empty -> fallback: GET /api/runtime/sessions/:runtimeSessionId/traces?projectId=X
  **Step 9:** replayTraceEventsIntoObservatory(traceEvents, sessionId)
  **Step 10:** For each event: observatory-store.addEvent(extendedEvent)
- Creates/updates spans Map
- Appends to events[]
- Creates flowNodes for agents
- Creates flowEdges for handoffs/delegates
- Tracks metrics (tokens, LLM calls, tool calls)
- Updates staticGraph execution state
  **Step 11:** hydrateSessionStoreFromDetail(session)
- session-store.restoreSession({ sessionId, agent, messages, state })
  **Step 12:** buildConversationTree(messages, traceEvents)
  **Step 13:** computeMetrics(traceEvents) with DB fallback
  **Step 14:** Render: SessionDetailPage
- AgentConversationTree (tree)
- SessionSummaryPanel (metrics, traceEvents, tree)
- DebugTabs -> TracesTab/DataTab/ConversationTab/PerformanceTab/IRTab

---

### 4.2 Live Chat Debug Data Flow

**Step 1:** WebSocket connect -> `ws://runtime:3112/ws` with `Sec-WebSocket-Protocol: web-debug-auth,<access_token>`
**Step 2:** Client sends: { type: 'start_session', agentId: '...' }
**Step 3:** Handler creates RuntimeSession + TraceEmitter
**Step 4:** Client sends: { type: 'user_message', text: '...' }
**Step 5:** RuntimeExecutor processes message
**Step 6:** createCentralizedTraceHandler() processes each trace event

- In-memory TraceStore.addEvent(sessionId, traceEventWithId)
- ClickHouse: getClickHouseTraceStore(tenantId).appendEvent(sessionId, {spanId, parentSpanId, agentName, data, ...})
- EventStore dual-write (analytics → abl_platform.platform_events)
- WebSocket.send({ type: 'trace_event', sessionId, event })
  **Step 7:** Client (WebSocketContext) receives trace_event
  **Step 8:** observatory-store.addEvent(extendedEvent)
  **Step 9:** React re-renders: FloatingDebugPanel -> DebugTabs -> TracesTab -> WaterfallPanel -> SpanTree

---

### 4.3 Trace Storage & Retrieval Flow

**Write Time** (TraceEmitter.emit):

- **In-memory TraceStore**
  - maxEventsPerSession: 500
  - ttlMinutes: 120
  - cleanupIntervalSeconds: 60
- **ClickHouse BufferedWriter** (`abl_platform.traces`)
  - bufferSize: 10000
  - flushIntervalSeconds: 5
- **EventStore dual-write** (`abl_platform.platform_events`)
  **Read Time** (GET /sessions/:id/traces):

1. **In-memory TraceStore**
   Immediate return if found. Returns TraceEventWithId with id, sessionId, agentName.
2. **ClickHouse abl_platform.traces** (gate: `isClickHouseTraceEnabled() (USE_MONGO_CLICKHOUSE=true)`)
   - Preserves original event types
   - Real span_id/parent_span_id hierarchy
   - Real agent_name
   - Cost in llm_call data
   - Encryption/decryption via interceptor
3. **ClickHouse abl_platform.platform_events**
   Last-resort fallback
   - Lossy type mapping
   - Max 500 events
   - No span hierarchy

---

### 4.4 Metrics Aggregation Flow

**Step 1:** Client requests GET /sessions/:id/metrics
**Step 2:** Try in-memory TraceStore first
**Step 3:** ClickHouse fallback when in-memory is empty
**Step 4:** Return SessionMetrics

---

## 5. Gap Analysis

**Total: 19 gaps** — 2 critical, 3 high, 10 medium, 4 low

### 5.1 Data Gaps

| #     | Gap                                                                            | Severity     | Fix                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.1 | ClickHouse appendEvent writes randomUUID() as span_id and empty parent_span_id | **Critical** |                                                                                                                                                                     |
| 5.1.2 | ClickHouse appendEvent writes empty agent_name                                 | **High**     |                                                                                                                                                                     |
| 5.1.3 | message.content can be ContentBlock[] not string                               | Medium       | In buildConversationTree, extract text from ContentBlock array: Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('') : content |
| 5.1.4 | In-memory TraceStore has 120-minute TTL and 500-event ring buffer              | Medium       |                                                                                                                                                                     |
| 5.1.5 | No per-span cost in ClickHouse writes                                          | Medium       |                                                                                                                                                                     |
| 5.1.6 | replayTraceEventsIntoObservatory creates synthetic spanId                      | **High**     |                                                                                                                                                                     |

### 5.2 View Gaps

| #     | Gap                                                | Severity     | Fix                                                                                                                               |
| ----- | -------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 5.2.1 | TracesTab shows 'No spans' for historical sessions | **Critical** |                                                                                                                                   |
| 5.2.2 | No session list filters in UI                      | Medium       | Add time range picker, status dropdown, channel dropdown, and session ID search. API already supports status and channel filters. |
| 5.2.3 | No CSV export button in UI                         | Low          | Add export button to session list and session detail. Wire to GET /sessions/export?sessionIds=...                                 |
| 5.2.4 | Analysis endpoint not wired to UI                  | Medium       | Add an 'Analysis' tab or panel in SessionDetailPage that calls GET /sessions/:id/analysis.                                        |
| 5.2.5 | Agent-spec endpoint only works for active sessions | Medium       | Add DB fallback in /agent-spec endpoint: look up agent by name from the session's currentAgent field.                             |
| 5.2.6 | Performance tab only shows in-memory data          | Medium       |                                                                                                                                   |
| 5.2.7 | No cost breakdown visualization                    | Low          | Add a cost waterfall or bar chart to the Performance tab, aggregating per-LLM-call cost from trace events.                        |

### 5.3 API Gaps

| #     | Gap                                                                     | Severity | Fix                                                                                              |
| ----- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| 5.3.1 | No dedicated GET /sessions/:id/metrics endpoint                         | Medium   |                                                                                                  |
| 5.3.2 | Generations endpoint only scans in-memory TraceStore (max 100 sessions) | **High** |                                                                                                  |
| 5.3.3 | Export endpoint only reads from in-memory TraceStore                    | Medium   |                                                                                                  |
| 5.3.4 | No GET /sessions/:id/messages endpoint                                  | Low      | Add a dedicated paginated messages endpoint. DB already supports findMessagesForSessionCursor(). |
| 5.3.5 | OBS_TRACE_CANONICAL_READ env var gates ClickHouse trace reads           | Medium   |                                                                                                  |
| 5.3.6 | No bulk trace query across sessions                                     | Low      | Add GET /sessions/traces?sessionIds=x,y,z that returns merged, chronologically sorted traces.    |

## Appendix A: Event Type Taxonomy

### A.1 Core Event Types

| Type               | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `llm_call`         | LLM inference call with model, tokens, cost           |
| `tool_call`        | Tool execution with input/output/success              |
| `decision`         | Routing/extraction/validation decision with reasoning |
| `constraint_check` | Constraint evaluation with pass/fail                  |
| `handoff`          | Agent-to-agent handoff                                |
| `escalation`       | Escalation to human/external system                   |
| `error`            | Error occurrence                                      |

### A.2 Extended Event Types

**sessionLifecycle:** `session_start`, `session_end`, `user_message`, `agent_response`, `session_updated`

**agentLifecycle:** `agent_enter`, `agent_exit`, `delegate_start`, `delegate_complete`

**flowExecution:** `flow_step_enter`, `flow_step_exit`, `flow_transition`

**ablConstructs:** `dsl_collect`, `dsl_prompt`, `dsl_respond`, `dsl_set`, `dsl_on_input`, `dsl_call`

**engineInternals:** `completion_check`, `engine_decision`, `handoff_condition_check`, `thread_return`, `data_stored`, `digression`, `sub_intent`, `correction`, `constraint_violation`, `warning`

**voicePipeline:** `voice_session_start`, `voice_session_end`, `voice_turn`, `voice_stt`, `voice_tts`, `voice_tts_quality`, `voice_asr_quality`, `voice_asr_cascade`, `voice_barge_in`

**llmReasoning:** `tool_thought`

### A.3 Decision Kinds

| Kind                | Description                       |
| ------------------- | --------------------------------- |
| `field_validation`  | Gather field validation result    |
| `gather_extraction` | Entity extraction from user input |
| `flow_transition`   | Step-to-step transition decision  |
| `correction`        | User correction handling          |
| `data_mutation`     | Context variable mutation         |
| `handoff`           | Agent handoff routing             |
| `delegation`        | Sub-agent delegation              |
| `constraint_check`  | Constraint evaluation             |
| `escalation`        | Escalation decision               |
| `guardrail_check`   | Guardrail evaluation              |
| `completion`        | Completion detection              |

### A.4 Platform Event Mapping

| Platform Event               | Trace Event Type      |
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

## Appendix B: Store Architecture

### B.1 Client Stores (Zustand)

**Observatory Store** (`observatory-store.ts`)

| Field                     | Type                              | Description                   |
| ------------------------- | --------------------------------- | ----------------------------- | ----------------------------- |
| `spans`                   | `Map<string, Span>`               | Active and completed spans    |
| `events`                  | `ExtendedTraceEvent[]`            | Bounded to 2,000 events       |
| `activeSpanStack`         | `string[]`                        | Stack of active span IDs      |
| `flowNodes`               | `AgentFlowNode[]`                 | Agent flow graph nodes        |
| `flowEdges`               | `AgentFlowEdge[]`                 | Agent flow graph edges        |
| `staticGraph`             | `StaticGraph                      | null`                         | Compiled state machine graph  |
| `executionState`          | `Map<string, NodeExecutionState>` | Per-node visited state        |
| `appStaticGraph`          | `AppStaticGraph                   | null`                         | Multi-agent app graph         |
| `stepMetrics`             | `Map<string, StepMetrics>`        | Per-step visit/duration/error |
| `constraintHistory`       | `ConstraintCheckResult[]`         | Constraint check log          |
| `totalTokensIn`           | `number`                          | Aggregate input tokens        |
| `totalTokensOut`          | `number`                          | Aggregate output tokens       |
| `totalLLMCalls`           | `number`                          | Aggregate LLM call count      |
| `totalToolCalls`          | `number`                          | Aggregate tool call count     |
| `pendingMessageStartTime` | `number                           | null`                         | Client timing start           |
| `lastVolleyClientMs`      | `number                           | null`                         | Last volley client latency    |
| `avgVolleyClientMs`       | `number                           | null`                         | Average volley client latency |
| `selectedSpanId`          | `string                           | null`                         | UI: selected span             |
| `debugPanelTab`           | `string`                          | UI: active debug tab          |
| `debugPanelOpen`          | `boolean`                         | UI: debug panel visibility    |
| `canvasViewMode`          | `string`                          | UI: canvas view mode          |

**Session Store** (`session-store.ts`)

| Field       | Type               | Description                                                 |
| ----------- | ------------------ | ----------------------------------------------------------- |
| `sessionId` | `string`           | Current session ID                                          |
| `agent`     | `AgentDetails`     | Agent metadata                                              |
| `messages`  | `SessionMessage[]` | Conversation messages                                       |
| `state`     | `AgentState`       | context, gatherProgress, constraintResults, flowState, etc. |

### B.2 Server Stores (Runtime)

**In-Memory TraceStore**

- ringBufferSize: 500
- ttlMinutes: 120
- sessionTimeoutMinutes: 120
- cleanupIntervalSeconds: 60
- Features: WebSocket subscriber broadcast, OTEL bridge forwarding

**Redis TraceStore**

- Alternative when Redis available, same interface, distributed persistence

**ClickHouse TraceStore** (`abl_platform.traces`)

- bufferSize: 10000
- flushIntervalSeconds: 5
- Features: Buffered writes (fire-and-forget, no per-event flush), Encryption at rest (compress-then-encrypt), Real span_id from traceEvent.id (matches in-memory store), Auto-derived parent_span_id (tool_call → preceding llm_call), Real agent_name from traceEvent.agentName, Cost field on all llm_call events (default 0)
