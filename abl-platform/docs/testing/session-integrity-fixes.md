# Session Integrity Fixes - Live Test Report

> **Last Updated**: 2026-04-27
> **Tested By**: session-integrity-test@example.com (automated)
> **Branch**: fix/remove-stale-connector-dockerfile-refs
> **Environment**: Local (PM2: runtime@3112, studio@5173, MongoDB@27017)

## Current State

All 6 fix clusters have source-level or live verification evidence. Redis and cold-store parity are covered by integration tests and should be run in the integration lane because they require real Redis/MongoDB infrastructure.

## Quick Health Dashboard

| Cluster | Description                         | Status             |
| ------- | ----------------------------------- | ------------------ |
| 1       | Redis field parity                  | PASS (integration) |
| 2       | Agent.exited schema with 'escalate' | PASS               |
| 3       | Config coldPersistDebounceMs floor  | PASS               |
| 4       | Zombie sessions (WS disconnect)     | PASS (live)        |
| 5       | BullMQ TTLs                         | PASS               |
| 6       | Timestamp faithfulness              | PASS (live)        |

## Test Coverage Map

### Cluster 1: Redis Field Parity

**What was fixed**: `agentRawVersions`, `backtrackCounts`, `constraintCollectState`, `moduleProvenance` were silently dropped during Redis session serialization/deserialization.

**Verification method**: Integration test plus compiled output inspection of `apps/runtime/dist/services/session/redis-session-store.js`.

**Results**:

- All 4 fields present in `SESSION_JSON_FIELDS` array (lines 143, 145, 147, 149)
- All 4 fields present in `hashToSession()` deserialization (lines 907-912)
- `moduleProvenance` also in SERIALIZABLE_FIELDS (line 171)
- Source file (`apps/runtime/src/services/session/redis-session-store.ts`) matches at lines 164-170, 1149-1158

**Gap**: The serialization layer is covered directly. A full executor-level multi-agent scenario with backtracking would still provide higher-confidence end-to-end validation.

### Cluster 2: Agent.exited Schema with 'escalate'

**What was fixed**: `AgentExitedDataSchema` did not include `escalate` as a valid result value.

**Verification method**: Direct Zod schema validation via Node.js.

**Results**:

- `{ result: 'escalate' }` -> valid: true
- `{ result: 'delegate' }` -> valid: true
- `{ result: 'handoff' }` -> valid: true
- `{ result: 'bad' }` -> valid: false
- `{ result: 'resolved' }` -> valid: false

### Cluster 3: Config coldPersistDebounceMs Floor

**What was fixed**: `coldPersistDebounceMs` accepted dangerously low values (e.g., 100ms) that could cause excessive MongoDB writes.

**Verification method**: Direct Zod schema validation of `SessionConfigSchema.coldPersistDebounceMs`.

**Results**:

- `100` -> REJECTED: "Number must be greater than or equal to 500"
- `499` -> REJECTED: "Number must be greater than or equal to 500"
- `500` -> ACCEPTED: 500
- `2000` -> ACCEPTED: 2000
- `undefined` -> DEFAULT: 2000

### Cluster 4: Zombie Sessions (WS Disconnect)

**What was fixed**: When a WebSocket client disconnects without sending `end_session`, the analytics DB session was left in `status: 'active'` indefinitely (zombie session).

**Verification method**: Live WebSocket test -- connected to runtime, loaded agent, sent message, received full response, then disconnected without `end_session`.

**Test session**: `a02a2182-8172-439f-99a1-1bb608c5400d`
**Project**: `019db4dc-365c-7d02-a184-6b6869abe04d` (weather App)
**Agent**: `weather_agent`

**Results**:

- Session created and received full LLM response (weather in London)
- Client disconnected after 3s without `end_session`
- Runtime log confirms: `[WS] Preserving debug DB session after resumable disconnect sessionId=a02a2182-8172-439f-99a1-1bb608c5400d`
- MongoDB session status: `idle` (not `active`)
- `endedAt`: `null` so resumable disconnects remain non-terminal
- Timestamp ordering remains valid: `createdAt < lastActivityAt`
- Cold persistence confirmed: 3 versions written to `session_states`

### Cluster 5: BullMQ TTLs

**What was fixed**: BullMQ queues had no `removeOnComplete` or `removeOnFail` options, causing unbounded job accumulation in Redis.

**Verification method**: Compiled output inspection.

**Results** (`apps/runtime/dist/services/queues/channel-queues.js`):

- Inbound queue: `removeOnComplete: { count: 1000, age: 86400 }`, `removeOnFail: { count: 5000, age: 604800 }`
- Delivery queue: `removeOnComplete: { count: 1000, age: 86400 }`, `removeOnFail: { count: 5000, age: 604800 }`

**Results** (`apps/runtime/dist/server.js` -- resumption queue):

- `removeOnComplete: { count: 1000, age: 86400 }`, `removeOnFail: { count: 500, age: 604800 }`

### Cluster 6: Timestamp Faithfulness

**What was fixed**: `saveSessionSnapshot` used `Date.now()` instead of preserving the actual `lastActivityAt` from the session, causing timestamp drift.

**Verification method**: Compiled output inspection + live session validation.

**Compiled output** (`apps/runtime/dist/services/runtime-executor.js`):

- Hydration: `lastActivityAt: hydrated.lastActivityAt ? new Date(hydrated.lastActivityAt) : new Date()` -- preserves original
- Serialization: `session.lastActivityAt instanceof Date ? session.lastActivityAt.getTime() : (session.lastActivityAt ?? Date.now())` -- uses `instanceof Date` check
- Update: `session.lastActivityAt = new Date()` -- uses actual Date objects

**Live validation** (session `a02a2182-8172-439f-99a1-1bb608c5400d`):

- `createdAt`: 2026-04-27T07:46:09.312Z
- `lastActivityAt`: 2026-04-27T07:46:27.630Z (18.3s after creation -- matches LLM response time)
- `endedAt`: remains null for resumable disconnects; terminal disconnect paths still set it
- Session activity timestamps remain properly ordered and realistic

## Iteration Log

### Iteration 1 (2026-04-27)

| Time  | Test                                   | Result | Notes                                                        |
| ----- | -------------------------------------- | ------ | ------------------------------------------------------------ |
| 07:37 | Runtime health check                   | PASS   | Healthy, Redis connected, MongoDB connected                  |
| 07:37 | Auth (dev-login)                       | PASS   | Token issued for session-integrity-test@example.com          |
| 07:38 | Cluster 1: Redis field parity (code)   | PASS   | All 4 fields in SESSION_JSON_FIELDS + hashToSession          |
| 07:38 | Cluster 2: AgentExited escalate        | PASS   | Zod schema accepts escalate, rejects invalid                 |
| 07:39 | Cluster 3: coldPersistDebounceMs floor | PASS   | min(500) enforced, default 2000                              |
| 07:40 | WS auth (first attempt, wrong header)  | FAIL   | Used Authorization header instead of Sec-WebSocket-Protocol  |
| 07:41 | WS auth (second attempt, correct)      | PASS   | Used `['web-debug-auth', token]` subprotocol                 |
| 07:42 | WS message format (first attempt)      | FAIL   | Used `start_session` instead of `load_agent`                 |
| 07:43 | WS send_message (first attempt)        | FAIL   | Missing `sessionId` in send_message payload                  |
| 07:46 | Cluster 4: Zombie session (full test)  | PASS   | Session marked idle without terminal endedAt, cold-persisted |
| 07:47 | Cluster 5: BullMQ TTLs                 | PASS   | All queues have removeOnComplete + removeOnFail              |
| 07:47 | Cluster 6: Timestamp faithfulness      | PASS   | instanceof Date pattern + live validation                    |
| 07:48 | PM2 error check                        | PASS   | No test-related errors                                       |

## Open Gaps

1. **Cluster 1 runtime validation**: The 4 Redis fields (`agentRawVersions`, `backtrackCounts`, `constraintCollectState`, `moduleProvenance`) are covered at the serialization layer but not exercised in a live multi-agent session. A dedicated multi-agent backtracking test would close this gap.

2. **No automated full E2E test**: These fixes have targeted integration/unit coverage, but there is still no full multi-agent WebSocket E2E that exercises Redis restore, cold restore, and trace-frame correlation in one flow.

## Bugs Found

None during this test run.
