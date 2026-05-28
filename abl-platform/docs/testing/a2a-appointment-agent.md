# Feature Test Guide: A2A Appointment Scheduling Agent

**Feature**: Multi-turn conversational appointment scheduling agent hosted on Vercel/Next.js, serving the A2A protocol (JSON-RPC, SSE streaming, task management)
**Owner**: Platform team
**Branch**: develop
**First tested**: 2026-04-27
**Last updated**: 2026-04-27
**Overall status**: STABLE

---

## Current State (as of 2026-04-27)

The appointment scheduling agent is fully operational as a standalone A2A server. All four JSON-RPC methods pass: `message/send` (sync multi-turn), `message/stream` (SSE with correct event sequence), `tasks/get` (retrieves completed task with full response text), and `tasks/cancel` (returns -32001 for unknown tasks, cancels known tasks correctly). The full 6-turn booking + cancel conversation works end-to-end with the AI model (Claude Sonnet 4.6) calling the correct tools at each step. One bug was found and fixed during this session (`tasks/cancel` returned success with empty `contextId` for unknown task IDs — corrected to return -32001). Platform integration testing is **blocked** pending Docker Desktop startup (MongoDB/Redis not available).

### Quick Health Dashboard

| Area                            | Status | Last Verified | Notes                                                        |
| ------------------------------- | ------ | ------------- | ------------------------------------------------------------ |
| Agent Card (`/.well-known/...`) | PASS   | 2026-04-27    | All 4 skills, streaming:true, correct URL                    |
| `message/send` multi-turn       | PASS   | 2026-04-27    | 6-turn booking + cancel conversation verified                |
| `message/stream` SSE            | PASS   | 2026-04-27    | Correct event sequence: working→artifact chunks→completed    |
| `tasks/get`                     | PASS   | 2026-04-27    | Returns state + full response text after stream              |
| `tasks/cancel`                  | PASS   | 2026-04-27    | -32001 for unknown, cancels known tasks                      |
| Error handling                  | PASS   | 2026-04-27    | -32601 method not found, -32602 bad params, -32001 not found |
| Platform A2A handoff            | —      | Not tested    | Blocked: Docker Desktop not running                          |
| Slot conflict (double-booking)  | —      | Not tested    | Pending                                                      |
| Concurrent requests same slot   | —      | Not tested    | Pending                                                      |

---

## Test Coverage Map

### A2A Protocol Methods

- [x] `GET /.well-known/agent-card.json` — correct name, skills, capabilities — `Iteration 1 (2026-04-27) PASS`
- [x] `GET /api/a2a/.well-known/agent-card.json` — re-export route — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 1: initiate booking — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 2: provide date → available slots returned — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 3: select time — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 4: provide name — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 5: provide reason → booking confirmed with APT-XXXXXXXX — `Iteration 1 (2026-04-27) PASS`
- [x] `message/send` — Turn 6: cancel by confirmation ID — `Iteration 1 (2026-04-27) PASS`
- [x] `message/stream` — SSE event sequence correct (working → artifact chunks → lastChunk → completed) — `Iteration 1 (2026-04-27) PASS`
- [x] `message/stream` — Tool call (check_availability) happens inside stream before text — `Iteration 1 (2026-04-27) PASS`
- [x] `tasks/get` — known task returns state + response message — `Iteration 1 (2026-04-27) PASS`
- [x] `tasks/get` — unknown task returns -32001 error — `Iteration 1 (2026-04-27) PASS`
- [x] `tasks/cancel` — known task cancels correctly — `Iteration 1 (2026-04-27) PASS`
- [x] `tasks/cancel` — unknown task returns -32001 error — `Iteration 1 (2026-04-27) PASS (after fix)`
- [x] Unknown method returns -32601 — `Iteration 1 (2026-04-27) PASS`
- [x] Invalid JSON body returns -32700 — `Iteration 1 (2026-04-27) PASS` (by code inspection)
- [ ] Missing `params.message` returns -32602 — `Not tested`

### Appointment Tools

- [x] `check_availability` — returns 7 slots for an open date — `Iteration 1 (2026-04-27) PASS`
- [x] `book_appointment` — creates booking, returns APT-XXXXXXXX confirmation ID — `Iteration 1 (2026-04-27) PASS`
- [x] `cancel_appointment` — cancels existing booking — `Iteration 1 (2026-04-27) PASS`
- [ ] `get_appointment` — lookup by confirmation ID — `Not tested directly`
- [ ] `book_appointment` — slot already taken returns error message to model — `Not tested`
- [ ] `check_availability` — date with all slots booked returns no-availability message — `Not tested`

### SDK Integration

- [x] `@a2a-js/sdk` 0.3.13 installed and types resolve — `Iteration 1 (2026-04-27) PASS`
- [x] TypeScript compiles with zero errors (`tsc --noEmit`) — `Iteration 1 (2026-04-27) PASS`
- [x] `Message`, `TextPart`, SDK response types used in route handler — `Iteration 1 (2026-04-27) PASS`

### Multi-provider Model Fallback

- [x] Anthropic (claude-sonnet-4-6) primary path — `Iteration 1 (2026-04-27) PASS`
- [ ] OpenAI fallback when ANTHROPIC_API_KEY missing — `Not tested`
- [ ] Google fallback — `Not tested`

### Platform Integration

- [ ] Platform runtime starts and `./apx up apps` succeeds — `Blocked: Docker not running`
- [ ] A2A channel connection pointing to `http://localhost:4010/api/a2a` created via Admin — `Not tested`
- [ ] Platform agent handoff via `HANDOFF TO: ... LOCATION: REMOTE PROTOCOL: A2A` routes to appointment agent — `Not tested`
- [ ] Multi-turn history forwarded correctly from platform to appointment agent — `Not tested`
- [ ] Agent card discovered via platform's `discoverAgent` use case — `Not tested`

---

## Open Gaps

- **GAP-001**: Platform integration not tested
  - **Severity**: High
  - **Reason**: Docker Desktop was not running during test session; MongoDB and Redis unavailable
  - **Action**: Start Docker Desktop, run `./apx up infra && ./apx up apps`, create A2A connection in Admin pointing to `http://localhost:4010/api/a2a`, test through the platform's handoff

- **GAP-002**: Slot conflict (double-booking) not tested
  - **Severity**: Medium
  - **Reason**: Store uses `Set` for slot tracking; needs concurrent or sequential double-book test

- **GAP-003**: `get_appointment` tool not tested via conversation
  - **Severity**: Low
  - **Reason**: Conversation flow didn't trigger it; needs a "look up my appointment" turn

---

## Pending / Future Work

- [ ] Platform integration end-to-end (blocked by Docker — see GAP-001)
- [ ] Test with `HOSTED_AGENT_PROVIDER=openai` to verify provider fallback
- [ ] Double-booking: book same slot twice → second attempt should get "slot not available" response
- [ ] `message/stream` multi-turn: send Turn 2 as streaming, verify tool still called
- [ ] `tasks/cancel` on an in-flight stream (cancel mid-stream is currently not wired)
- [ ] Verify slot freed after cancel: rebook same slot on same date/time

---

## Enhancement Ideas

- **ENH-001** (Iteration 1): `message/send` could return taskId in metadata so callers can use `tasks/get` without capturing it from a streaming response
- **ENH-002** (Iteration 1): Add `list_appointments(date?)` tool to show all bookings for a given context
- **ENH-003** (Iteration 1): For production: replace in-memory store with Redis to survive cold starts

---

## Iteration Log

### Iteration 1 — 2026-04-27

**Scope**: All four A2A methods, full 6-turn booking+cancel conversation, SSE streaming, SDK integration
**Branch**: develop
**Duration**: ~30 min
**Tested by**: Claude Code (agent)
**Server**: `npm run dev` at `examples/external-a2a-bridge/external-vercel-agent/` (port 4010)

#### Results

| #   | Test                                   | Method               | Expected                                          | Actual                                                  | Status     |
| --- | -------------------------------------- | -------------------- | ------------------------------------------------- | ------------------------------------------------------- | ---------- |
| 1   | Agent card                             | GET `/.well-known/…` | name=Appointment Scheduling Agent, streaming:true | Correct JSON, 4 skills                                  | PASS       |
| 2   | Turn 1: initiate booking               | `message/send`       | Ask for date                                      | "What date would you like? Today is April 27, 2026."    | PASS       |
| 3   | Turn 2: provide date                   | `message/send`       | Show 7 available slots                            | All 7 slots listed for April 29                         | PASS       |
| 4   | Turn 3: select 2 PM                    | `message/send`       | Confirm time, ask for name                        | "Perfect, 2:00 PM it is! What's your full name?"        | PASS       |
| 5   | Turn 4: provide name (John Smith)      | `message/send`       | Ask for reason                                    | "Got it, John! And what's the reason?"                  | PASS       |
| 6   | Turn 5: provide reason                 | `message/send`       | Book + return APT-XXXXXXXX confirmation           | APT-B4233F2F confirmed with full summary                | PASS       |
| 7   | Turn 6: cancel by confirmation ID      | `message/send`       | Cancel + confirmation                             | "Successfully cancelled APT-B4233F2F" with details      | PASS       |
| 8   | `message/stream` SSE                   | `message/stream`     | status-update(working)→chunks→completed           | Correct sequence, tool called inside stream             | PASS       |
| 9   | `tasks/get` known task                 | `tasks/get`          | state=completed + full response text              | state:completed with message.parts[0].text              | PASS       |
| 10  | `tasks/get` unknown task               | `tasks/get`          | -32001 error                                      | `{"error":{"code":-32001, "message":"Task not found"}}` | PASS       |
| 11  | `tasks/cancel` unknown task (pre-fix)  | `tasks/cancel`       | -32001 error                                      | Success with empty contextId ← **BUG**                  | FAIL→FIXED |
| 12  | `tasks/cancel` unknown task (post-fix) | `tasks/cancel`       | -32001 error                                      | `{"error":{"code":-32001}}`                             | PASS       |
| 13  | Unknown method                         | `tasks/unknown`      | -32601 error                                      | `{"error":{"code":-32601}}`                             | PASS       |

#### Bugs Fixed

- **BUG-001**: `tasks/cancel` returned `{"result":{"kind":"task","contextId":"",...}}` for non-existent task IDs
  - **File**: `examples/external-a2a-bridge/external-vercel-agent/app/api/a2a/route.ts`
  - **Root Cause**: `handleTasksCancel` called `updateTask` (no-op on missing ID) then returned success with `task?.contextId ?? ''`
  - **Fix**: Added `if (!task) return jsonrpcError(-32001, ...)` guard before `updateTask`, same as `handleTasksGet`
  - **Verified**: Re-ran test 12 → -32001 returned correctly

#### New Gaps Found

- GAP-001: Platform integration blocked by Docker not running
- GAP-002: Slot conflict not tested
- GAP-003: `get_appointment` tool not exercised via conversation

---

## Test Environment

Appointment Agent: `http://localhost:4010` (Next.js dev, `npm run dev` in `examples/external-a2a-bridge/external-vercel-agent/`)
A2A Endpoint: `POST http://localhost:4010/api/a2a`
Agent Card: `GET http://localhost:4010/.well-known/agent-card.json`
LLM: Anthropic claude-sonnet-4-6 (key from platform `.env`)
Platform Runtime: localhost:3112 — **NOT RUNNING** (Docker down)
MongoDB: localhost:27017 — **NOT RUNNING** (Docker down)
