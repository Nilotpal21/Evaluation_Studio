# Test Specification: WebSocket Relocation

**Feature Spec**: `docs/features/sub-features/ws-relocation.md`
**Design Doc**: `docs/superpowers/specs/2026-04-13-ws-relocation-design.md`
**HLD**: `docs/specs/ws-relocation.hld.md`
**LLD**: N/A — not yet created
**Status**: IN PROGRESS
**Last Updated**: 2026-04-14

---

## 1. Current State

**As of 2026-04-14**: The WS relocation is implemented (7 commits under ABLP-333). The keepalive feature (FR-5/FR-6/FR-7/FR-10) was added then reverted during hardening. New unit tests exist for CommandPalette HTTP fetching, session launcher, SDK handler legacy ping compat, websocket-events ping rejection, and SessionManager heartbeat removal guard. All planned E2E and integration tests remain unwritten. Existing related tests:

| Test File                                                              | What It Covers                                                                                                      | Relevance                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/channels/ws-heartbeat.test.ts`             | Protocol-level `ws.ping()` / `pong` control frames, `trackConnection`, `startHeartbeat`, `stopHeartbeat` (14 tests) | Validates server-side protocol heartbeat — unrelated to app-level keepalive but confirms heartbeat infrastructure works |
| `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx` | Token refresh does not trigger WS reconnection when connection is OPEN                                              | Directly relevant — must still pass after relocation. Tests the guard check at `WebSocketContext.tsx:733`               |
| `apps/studio/src/__tests__/studio-transport.test.ts`                   | `useStudioTransport` message translation layer                                                                      | Uses mocked `useWebSocketContext` — should be unaffected since context interface unchanged                              |
| `apps/runtime/src/__tests__/channels/ws-handler.test.ts`               | Debug WS handler message routing, auth gate, load_agent, send_message, resume_session                               | Tests handler.ts message switch — ping case will be added to this module                                                |
| `apps/runtime/src/__tests__/channels/ws-tenant-isolation.test.ts`      | Cross-tenant WS connection rejection                                                                                | Validates tenant isolation at WS level — unaffected by this change                                                      |

---

## 2. Coverage Matrix

| FR    | Description                       | Unit                                          | Integration            | E2E             | Manual  | Status                               |
| ----- | --------------------------------- | --------------------------------------------- | ---------------------- | --------------- | ------- | ------------------------------------ |
| FR-1  | No WS on non-chat pages           |                                               |                        | PLANNED (E2E-1) | PLANNED | CODE DONE, NOT TESTED                |
| FR-2  | WS connects on Chat tab           |                                               |                        | PLANNED (E2E-2) | PLANNED | CODE DONE, NOT TESTED                |
| FR-3  | WS closes on Chat tab exit        |                                               |                        | PLANNED (E2E-3) | PLANNED | CODE DONE, NOT TESTED                |
| FR-4  | Session auto-resumes on return    |                                               | PLANNED (INT-3, INT-4) | PLANNED (E2E-4) | PLANNED | CODE DONE, NOT TESTED                |
| FR-5  | Runtime internal ping/pong        | N/A                                           | N/A                    |                 |         | REVERTED -- FR removed in hardening  |
| FR-6  | Client sends ping every 25s       | N/A                                           | N/A                    | N/A             |         | REVERTED -- FR removed in hardening  |
| FR-7  | Client handles pong message       | N/A                                           |                        |                 |         | REVERTED -- FR removed in hardening  |
| FR-8  | Splash screen gates on auth only  | PLANNED (UT-4)                                |                        | PLANNED (E2E-6) |         | CODE DONE, NOT TESTED (no unit test) |
| FR-9  | CommandPalette fetches via HTTP   | DONE (command-palette.test.tsx)               | PLANNED (INT-5)        |                 |         | PARTIAL -- unit test exists          |
| FR-10 | Keepalive cleanup on close        | N/A                                           | N/A                    |                 |         | REVERTED -- FR removed in hardening  |
| NEW   | Legacy SDK ping compat            | DONE (ws-sdk-handler.test.ts)                 |                        |                 |         | DONE -- unit test exists             |
| NEW   | No heartbeat frames after session | DONE (session-manager-connect.test.ts)        |                        |                 |         | DONE -- regression guard             |
| NEW   | parseClientMessage rejects ping   | DONE (websocket-events.test.ts)               |                        |                 |         | DONE -- unit test exists             |
| NEW   | Session launcher post-relocation  | DONE (project-agent-session-launcher.test.ts) |                        |                 |         | DONE -- unit test exists             |

---

## 3. E2E Test Scenarios (MANDATORY)

> **Standard**: E2E tests exercise the real system through its HTTP API and browser automation.
> No mocks, no direct DB access, no stubbed servers. Auth context and isolation checks on every scenario.

### E2E-1: No WebSocket on Project Dashboard

- **Preconditions**: Runtime running on test port, Studio built and served, test user authenticated
- **Steps**:
  1. Login via `POST /api/auth/login` with test credentials → receive JWT
  2. Navigate to project dashboard (`/projects/:projectId`)
  3. Wait 5 seconds for any deferred connections
  4. Capture all WebSocket connections from browser network activity via Playwright `page.on('websocket')`
- **Expected Result**: Zero WebSocket connections opened. No `/ws` requests in network log.
- **Auth Context**: Authenticated user with valid JWT, member of test tenant, access to test project
- **Isolation Check**: N/A — verifying absence of connections
- **Covers**: FR-1

### E2E-2: WebSocket Connects on Chat Tab

- **Preconditions**: Runtime running, test user authenticated, project with at least one agent
- **Steps**:
  1. Login and navigate to project dashboard
  2. Navigate to Agents page → select test agent → click Chat tab
  3. Capture WebSocket connections via `page.on('websocket')`
  4. Wait for WS `open` event
- **Expected Result**: Exactly 1 WebSocket connection opened to `/ws` endpoint. Connection URL includes the runtime host. WebSocket `readyState` is OPEN.
- **Auth Context**: Authenticated user with project access. WS subprotocol includes `web-debug-auth,<JWT>`
- **Isolation Check**: WS connection uses authenticated user's JWT in subprotocol header. Server resolves tenant context from JWT.
- **Covers**: FR-2

### E2E-3: WebSocket Disconnects on Navigation Away

- **Preconditions**: E2E-2 completed — WS connection is OPEN on Chat tab
- **Steps**:
  1. From Chat tab, navigate to Workflows page (click Workflows in sidebar)
  2. Wait 2 seconds for cleanup
  3. Check captured WebSocket connection state
- **Expected Result**: WebSocket connection closes cleanly. Playwright `ws.isClosed()` returns true. No new WS connections opened on Workflows page.
- **Auth Context**: Same authenticated user
- **Isolation Check**: N/A — verifying connection cleanup
- **Covers**: FR-3

### E2E-4: Session Resumes After Navigate Away and Back

- **Preconditions**: E2E-2 completed — WS is OPEN, agent loaded
- **Steps**:
  1. On Chat tab, send a test message via the chat input
  2. Wait for agent response (message appears in chat panel)
  3. Navigate to Workflows page (WS closes, session detaches)
  4. Wait 2 seconds
  5. Navigate back to the same agent's Chat tab
  6. Wait for new WS connection to open
  7. Capture WS messages via `ws.on('framesent')` and `ws.on('framereceived')`
- **Expected Result**: New WS connection opens. Client sends `{ type: 'resume_session', sessionId: '<original>' }`. Server responds with `{ type: 'session_resumed' }` containing session state. Previous conversation messages are visible in chat panel. Chat input is functional.
- **Auth Context**: Same user, same tenant, same project. Server validates session ownership via `ensureWsSessionAccess()`.
- **Isolation Check**: Server validates `userId` and `tenantId` match original session creator. Cross-user resume attempt returns `session_expired`.
- **Covers**: FR-4

### E2E-5: Keepalive Prevents Proxy Timeout

- **Preconditions**: E2E-2 completed — WS is OPEN on Chat tab
- **Steps**:
  1. On Chat tab with active WS connection
  2. Capture all WS frames via `ws.on('framesent')`
  3. Wait 60 seconds with no user interaction (no messages sent, no clicks)
  4. Check WS connection state after 60 seconds
  5. Count `{ type: 'ping' }` frames in captured sent messages
- **Expected Result**: WS connection remains OPEN after 60 seconds (no close/reconnect cycle). At least 2 `{ type: 'ping' }` data frames sent by client (at ~25s and ~50s). At least 2 `{ type: 'pong' }` frames received from server.
- **Auth Context**: Authenticated user
- **Isolation Check**: N/A — keepalive is connection-scoped
- **Covers**: FR-6

### E2E-6: App Loads Without WebSocket Dependency

- **Preconditions**: Runtime running, Studio served
- **Steps**:
  1. Login with valid credentials
  2. Measure time from login submission to splash screen dismissal
  3. Verify project dashboard is interactive (can click sidebar items)
  4. Check that no WS connections were opened during login → dashboard flow
- **Expected Result**: Splash screen dismisses based on auth completion only (not WS connection). Dashboard renders in under 1 second after auth. Zero WS connections opened.
- **Auth Context**: Authenticated user
- **Isolation Check**: N/A — verifying WS decoupling from app startup
- **Covers**: FR-8

### E2E-7: Multiple Navigation Cycles

- **Preconditions**: Runtime running, test user authenticated, project with agent
- **Steps**:
  1. Navigate to Chat tab → WS opens
  2. Navigate to Workflows → WS closes
  3. Navigate to Chat tab → WS opens (new connection)
  4. Navigate to Settings → WS closes
  5. Navigate to Chat tab → WS opens (new connection)
  6. Count total WS connections created and verify only 1 is OPEN at any time
- **Expected Result**: Exactly 3 WS connections created total. At each Chat tab visit, exactly 1 connection is OPEN. At each non-Chat page, 0 connections are OPEN. No leaked connections.
- **Auth Context**: Same user throughout
- **Isolation Check**: Each connection goes through fresh `resolveWSTenantContext()` — JWT validated on every connect
- **Covers**: FR-1, FR-2, FR-3

---

## 4. Integration Test Scenarios (MANDATORY)

> **Standard**: Integration tests exercise real service boundaries. Start real Express/WS servers on random ports.
> No mocking codebase components. Only external third-party services may be mocked via DI.

### INT-1: Runtime Ping-Pong Response

- **Boundary**: WS client → Runtime `/ws` handler
- **Setup**: Start runtime Express server on random port (`{ port: 0 }`). Obtain test JWT via auth service or test token generator.
- **Steps**:
  1. Open WebSocket connection to `ws://localhost:<port>/ws` with subprotocol `web-debug-auth,<JWT>`
  2. Wait for connection `open` event
  3. Send `JSON.stringify({ type: 'ping' })`
  4. Wait for message response
- **Expected Result**: Server responds with `{ type: 'pong' }`. Response is valid JSON. No other side effects (no session created, no trace events).
- **Failure Mode**: If handler does not have `case 'ping'`, the message is silently dropped (no response, no error). Test times out waiting for pong.
- **Covers**: FR-5

### INT-2: Keepalive Keeps Connection Alive Through Proxy Simulation

- **Boundary**: WS client keepalive → Runtime WS server
- **Setup**: Start runtime on random port. Connect WS with valid JWT. Configure a simulated idle timeout (close connections that receive no data frames for 10 seconds).
- **Steps**:
  1. Connect WS and verify it's OPEN
  2. Start sending `{ type: 'ping' }` every 5 seconds (simulating 25s interval at compressed timescale)
  3. Wait 30 seconds (3x the simulated idle timeout)
  4. Verify WS is still OPEN
  5. Stop sending pings
  6. Wait 15 seconds (1.5x idle timeout)
- **Expected Result**: Connection stays open while pings are being sent. Connection is terminated after pings stop and idle timeout is exceeded. Each ping receives a `{ type: 'pong' }` response.
- **Failure Mode**: Without keepalive, connection drops after 10 seconds of inactivity.
- **Covers**: FR-5, FR-6

### INT-3: Session Detach on WS Close

- **Boundary**: WS close event → Runtime session lifecycle
- **Setup**: Start runtime on random port. Connect WS. Send `load_agent` to initialize an agent. Send `start_session` or `send_message` to create a session.
- **Steps**:
  1. Verify session is active (send `get_state`, receive session state)
  2. Close WS connection (`ws.close()`)
  3. Wait 2 seconds for server-side cleanup
  4. Open new WS connection with same JWT
  5. Send `{ type: 'resume_session', sessionId: '<from step 1>' }`
- **Expected Result**: Server responds with `{ type: 'session_resumed' }` containing session state. Session was detached (not ended) on WS close. Conversation history is preserved in resumed session.
- **Failure Mode**: If disconnect behavior is `end` instead of `detach`, resume attempt returns `session_expired`.
- **Covers**: FR-4

### INT-4: Session Resume Validates Ownership

- **Boundary**: `resume_session` → `ensureWsSessionAccess()` → session store
- **Setup**: Start runtime. User A connects, creates session. User A disconnects.
- **Steps**:
  1. User A: connect WS, load agent, start session, note sessionId
  2. User A: close WS
  3. User B: connect WS with different JWT (different userId, same tenantId)
  4. User B: send `{ type: 'resume_session', sessionId: '<User A's session>' }`
- **Expected Result**: Server rejects User B's resume attempt. Response is `{ type: 'session_expired' }` or error indicating access denied. Session state is NOT leaked to User B.
- **Failure Mode**: If `ensureWsSessionAccess()` is missing or bypassed, User B gains access to User A's session.
- **Covers**: FR-4 (isolation aspect)

### INT-5: CommandPalette HTTP Fetch

- **Boundary**: Studio HTTP client → Runtime `/api/agents/apps` endpoint
- **Setup**: Runtime running with test project containing 2+ agents/apps
- **Steps**:
  1. Send `GET /api/agents/apps` with auth headers (`Authorization: Bearer <JWT>`)
  2. Parse response
- **Expected Result**: Response is `200 OK` with JSON array of available apps. Each app has required fields (`name`, `id`, etc.). Response is project-scoped (only returns apps for the authorized project).
- **Failure Mode**: If endpoint doesn't exist or requires WS context, returns 404 or 500.
- **Covers**: FR-9

### INT-6: Keepalive Interval Cleanup on Close

- **Boundary**: WS client keepalive timer → WS close event
- **Setup**: Start runtime. Connect WS. Start keepalive interval (ping every 25s).
- **Steps**:
  1. Connect WS, verify OPEN
  2. Wait 30 seconds — verify at least 1 ping sent
  3. Close WS connection
  4. Wait 30 seconds after close
  5. Count total pings sent after close
- **Expected Result**: Zero pings sent after WS close. Interval timer is cleared. No `setInterval` leak.
- **Failure Mode**: If `clearInterval` is not called in `closeWs()` or `onclose`, pings continue after connection closes, causing `send()` errors on closed socket.
- **Covers**: FR-10

### INT-7: Cross-Tenant Session Resume Rejection

- **Boundary**: `resume_session` → tenant isolation check
- **Setup**: Start runtime. Tenant A user connects and creates session. Tenant B user connects.
- **Steps**:
  1. Tenant A user: connect, load agent, start session, note sessionId
  2. Tenant A user: close WS
  3. Tenant B user: connect WS with Tenant B JWT
  4. Tenant B user: send `{ type: 'resume_session', sessionId: '<Tenant A's session>' }`
- **Expected Result**: Server rejects with `session_expired` or error. No session data leaked. Tenant B cannot enumerate or access Tenant A's sessions.
- **Failure Mode**: Missing `tenantId` check in `handleResumeSession` or 3-tier lookup allows cross-tenant access.
- **Covers**: FR-4 (tenant isolation)

---

## 5. Unit Test Scenarios

### UT-1: Runtime Handler Ping → Pong

- **Module**: `apps/runtime/src/websocket/handler.ts` — message switch
- **Input**: `{ type: 'ping' }` message on authenticated WS connection
- **Expected Output**: `send(ws, ServerMessages.pong())` called once. Resulting message is `{ type: 'pong' }`. No session state changes.
- **Test File**: `apps/runtime/src/__tests__/channels/ws-ping-pong.test.ts` (planned)
- **Covers**: FR-5

### UT-2: Client Keepalive Interval Start

- **Module**: `apps/studio/src/contexts/WebSocketContext.tsx` — keepalive in connection effect
- **Input**: WS connection opens (`readyState = OPEN`)
- **Expected Output**: `setInterval` called with 25000ms period. First ping sent after 25 seconds. Subsequent pings at 25-second intervals. Uses fake timers (`vi.useFakeTimers`).
- **Test File**: `apps/studio/src/__tests__/ws-keepalive.test.ts` (planned)
- **Covers**: FR-6

### UT-3: Client Handles Pong Message

- **Module**: `apps/studio/src/contexts/WebSocketContext.tsx` — `handleMessage` switch
- **Input**: `{ type: 'pong' }` server message received on WS
- **Expected Output**: No error thrown. No state mutations. No console warnings. Message is silently consumed.
- **Test File**: `apps/studio/src/__tests__/ws-keepalive.test.ts` (planned)
- **Covers**: FR-7

### UT-4: App.tsx Splash Screen Auth-Only Gating

- **Module**: `apps/studio/src/App.tsx` — splash screen conditional
- **Input**: `authLoading = true` → `authLoading = false`, `isAuthenticated = true`
- **Expected Output**: Splash screen shows while `authLoading = true`. Splash screen dismisses when `authLoading = false`. No dependency on `isConnected` or `WebSocketContext`. Component renders without `WebSocketProvider` in the tree.
- **Test File**: `apps/studio/src/__tests__/app-no-ws-dependency.test.ts` (planned)
- **Covers**: FR-8

### UT-5: useAvailableApps Hook Fetches via HTTP

- **Module**: `apps/studio/src/hooks/useAvailableApps.ts` (planned)
- **Input**: Hook mounted with valid auth context
- **Expected Output**: Calls `fetch('/api/agents/apps', { headers: authHeaders() })`. Returns `{ apps: [...], loading, error }`. Does not import or use `WebSocketContext`.
- **Test File**: `apps/studio/src/__tests__/hooks/use-available-apps.test.ts` (planned)
- **Covers**: FR-9

### UT-6: CommandPalette Without WebSocket

- **Module**: `apps/studio/src/components/CommandPalette.tsx`
- **Input**: CommandPalette rendered without `WebSocketProvider` in tree
- **Expected Output**: Component renders without error. Available apps listed from `useAvailableApps` hook. Session-dependent commands (loadApp, resetSession) conditionally disabled when no active session.
- **Test File**: `apps/studio/src/__tests__/command-palette-no-ws.test.ts` (planned)
- **Covers**: FR-9

### UT-7: Keepalive Cleanup on Close

- **Module**: `apps/studio/src/contexts/WebSocketContext.tsx` — `closeWs()` function
- **Input**: Active WS connection with running keepalive interval, then `closeWs()` called
- **Expected Output**: `clearInterval` called for keepalive timer. No more pings after close. WS `close()` called. Refs nulled. Fake timer advancement confirms no further pings.
- **Test File**: `apps/studio/src/__tests__/ws-keepalive.test.ts` (planned)
- **Covers**: FR-10

### UT-8: Keepalive Cleanup on Unmount

- **Module**: `apps/studio/src/contexts/WebSocketContext.tsx` — useEffect cleanup
- **Input**: `WebSocketProvider` mounted (WS connects, keepalive starts), then unmounted (Chat tab navigation away)
- **Expected Output**: useEffect cleanup calls `closeWs()`. Keepalive interval cleared. No dangling timers. No `send()` calls after unmount.
- **Test File**: `apps/studio/src/__tests__/ws-keepalive.test.ts` (planned)
- **Covers**: FR-10

### UT-9: Token Refresh Does Not Reconnect (Regression Guard)

- **Module**: `apps/studio/src/contexts/WebSocketContext.tsx` — connection effect guard
- **Input**: WS is OPEN. `accessToken` changes in auth store (token refresh).
- **Expected Output**: Guard check (`readyState === OPEN && url === url`) returns early. No `closeWs()` called. No new WebSocket created. Existing connection stays open.
- **Test File**: `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx` (existing — must still pass)
- **Covers**: Regression guard, cross-reference with FR-6

### UT-10: Ping Message Type Validation

- **Module**: `apps/runtime/src/types/index.ts` — `ClientMessage` union, `apps/studio/src/types/index.ts` — `ClientMessage` and `ServerMessage` unions
- **Input**: TypeScript compilation
- **Expected Output**: `{ type: 'ping' }` is a valid `ClientMessage` in both runtime and studio types. `{ type: 'pong' }` is a valid `ServerMessage` in studio types. `{ type: 'pong' }` already exists in runtime `ServerMessage` (verify not removed).
- **Test File**: Type-level validation via `tsc --noEmit` (no runtime test needed)
- **Covers**: FR-5, FR-7

---

## 6. Security & Isolation Tests

### 6.1 Cross-Tenant Isolation

- [x] **Covered by INT-7**: Cross-tenant session resume is rejected. Tenant B cannot access Tenant A's session via `resume_session`.
- [x] **Covered by existing `ws-tenant-isolation.test.ts`**: Cross-tenant WS connection rejection. Unchanged by this feature.

### 6.2 Cross-User Isolation

- [x] **Covered by INT-4**: Cross-user session resume is rejected. User B cannot access User A's session even within same tenant.

### 6.3 Authentication

- [x] **Covered by existing `ws-handler.test.ts`**: WS connection without valid JWT is rejected.
- [x] **Ping without auth**: Unauthenticated WS connections are rejected before any message handling — `ping` cannot bypass auth gate.

### 6.4 Input Validation

- [x] **Ping message carries no data**: `{ type: 'ping' }` has no fields to validate beyond `type`. Malformed JSON is already handled by the existing message parser.

### 6.5 Data Leakage

- [x] **Pong carries no session data**: `{ type: 'pong' }` is an empty acknowledgment — no user data, no session state, no PII.
- [x] **Session resume validates before returning state**: `ensureWsSessionAccess()` runs before any session data is returned (INT-3, INT-4, INT-7).

---

## 7. Performance & Load Tests

### PERF-1: Connection Count Under Concurrent Users

- **Scenario**: 50 authenticated users on non-chat pages, 10 users on Chat tab
- **Expected**: ~10 WS connections on runtime (vs. ~60 previously)
- **Measurement**: `websocket_connections` Prometheus metric or `wss.clients.size`

### PERF-2: Keepalive Overhead

- **Scenario**: 100 active Chat sessions, each sending ping every 25s
- **Expected**: 4 pings/min/session = 400 messages/min total. ~16KB/min bandwidth (40 bytes × 400). Negligible CPU impact.
- **Measurement**: WS frame counter on runtime

### PERF-3: Chat Tab Navigation Latency

- **Scenario**: User navigates to Chat tab, measures time from click to WS OPEN + session resume
- **Expected**: < 200ms for WS connect + JWT verify + tenant resolution. < 500ms total including session resume from memory. < 2s for cold resume from DB.
- **Measurement**: Playwright timing from navigation to first received WS message

---

## 8. Test Infrastructure

### Required Services

| Service                | Purpose                                        | Setup                                                                                    |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime (Express + WS) | Integration + E2E target                       | `pnpm dev --filter=runtime` or Docker                                                    |
| Studio (Next.js)       | E2E browser target                             | `pnpm dev --filter=studio` or `pnpm build --filter=studio && pnpm start --filter=studio` |
| MongoDB                | Session persistence for INT-3 resume from DB   | Docker: `docker compose up mongo`                                                        |
| Redis                  | Session cache for resume_session 3-tier lookup | Docker: `docker compose up redis`                                                        |

### Data Seeding

- **Test tenant**: Created via admin API or seed script
- **Test user**: JWT issued for test tenant with project access
- **Test project**: At least 1 project with 1 configured agent
- **Test agent**: Any agent with model configured (for send_message to work in E2E-4)

### Environment Variables

| Variable         | Value                    | Purpose                                |
| ---------------- | ------------------------ | -------------------------------------- |
| `RUNTIME_WS_URL` | `ws://localhost:3112/ws` | WS endpoint for studio tests           |
| `NODE_ENV`       | `test`                   | Test mode                              |
| `JWT_SECRET`     | Test secret              | Token generation for integration tests |

### CI Configuration

- Unit tests: `pnpm test --filter=studio --filter=runtime` — no infrastructure needed
- Integration tests: Require running runtime + MongoDB + Redis
- E2E tests: Require running runtime + studio + MongoDB + Redis + Playwright

---

## 9. Test File Mapping

### Existing Tests (created or updated during ABLP-333)

| Test File                                                                | Type | Covers                              | Status               |
| ------------------------------------------------------------------------ | ---- | ----------------------------------- | -------------------- |
| `apps/studio/src/__tests__/components/command-palette.test.tsx`          | unit | FR-9 (CommandPalette HTTP fetching) | DONE                 |
| `apps/studio/src/__tests__/hooks/project-agent-session-launcher.test.ts` | unit | Session launcher post-relocation    | DONE                 |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`             | unit | Legacy SDK ping compat              | DONE                 |
| `apps/runtime/src/__tests__/channels/websocket-events.test.ts`           | unit | parseClientMessage rejects ping     | DONE                 |
| `apps/runtime/src/__tests__/ws-sdk-message-contract.test.ts`             | unit | SDK message contract                | DONE                 |
| `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`         | unit | No heartbeat regression guard       | DONE                 |
| `packages/web-sdk/src/__tests__/default-transport.test.ts`               | unit | pong dropped as internal            | DONE                 |
| `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx`   | unit | Regression guard (UT-9)             | EXISTING -- verified |

### Planned Tests (still unwritten)

| Test File                                                              | Type        | Covers                     | Status                                   |
| ---------------------------------------------------------------------- | ----------- | -------------------------- | ---------------------------------------- |
| `apps/studio/src/__tests__/app-no-ws-dependency.test.ts`               | unit        | FR-8 (UT-4)                | PLANNED -- code done, test not written   |
| `apps/studio/src/__tests__/hooks/use-available-apps.test.ts`           | unit        | FR-9 (UT-5)                | PLANNED -- hook exists, test not written |
| `apps/runtime/src/__tests__/channels/ws-session-detach-resume.test.ts` | integration | FR-4 (INT-3, INT-4, INT-7) | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/no-ws-on-dashboard.spec.ts`             | e2e         | FR-1 (E2E-1)               | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/ws-connects-on-chat.spec.ts`            | e2e         | FR-2 (E2E-2)               | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/ws-disconnects-on-nav.spec.ts`          | e2e         | FR-3 (E2E-3)               | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/session-resume.spec.ts`                 | e2e         | FR-4 (E2E-4)               | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/app-load-no-ws.spec.ts`                 | e2e         | FR-8 (E2E-6)               | PLANNED                                  |
| `apps/studio/e2e/ws-relocation/navigation-cycles.spec.ts`              | e2e         | FR-1, FR-2, FR-3 (E2E-7)   | PLANNED                                  |

### Removed from Plan (keepalive reverted)

| Test File                                                              | Type        | Originally Covered             | Status                                |
| ---------------------------------------------------------------------- | ----------- | ------------------------------ | ------------------------------------- |
| `apps/runtime/src/__tests__/channels/ws-ping-pong.test.ts`             | unit        | FR-5 (UT-1)                    | CANCELLED -- FR-5 reverted            |
| `apps/studio/src/__tests__/ws-keepalive.test.ts`                       | unit        | FR-6, FR-7, FR-10 (UT-2,3,7,8) | CANCELLED -- FR-6/FR-7/FR-10 reverted |
| `apps/runtime/src/__tests__/channels/ws-keepalive-integration.test.ts` | integration | FR-5, FR-6 (INT-1, INT-2)      | CANCELLED -- FR-5/FR-6 reverted       |
| `apps/runtime/src/__tests__/channels/ws-keepalive-cleanup.test.ts`     | integration | FR-10 (INT-6)                  | CANCELLED -- FR-10 reverted           |
| `apps/studio/e2e/ws-relocation/keepalive.spec.ts`                      | e2e         | FR-6 (E2E-5)                   | CANCELLED -- FR-6 reverted            |

---

## 10. Regression Test Checklist

Tests that must continue to pass after this change. These are not new tests — they are existing tests that could break if the relocation is done incorrectly.

| Test File                                                              | Risk   | Why                                                                                      |
| ---------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx` | HIGH   | Tests token refresh guard. WebSocketProvider location change could affect hook behavior. |
| `apps/studio/src/__tests__/studio-transport.test.ts`                   | MEDIUM | Mocks `useWebSocketContext`. Context interface must remain identical.                    |
| `apps/runtime/src/__tests__/channels/ws-heartbeat.test.ts`             | LOW    | Protocol heartbeat unchanged. Verifying no accidental changes.                           |
| `apps/runtime/src/__tests__/channels/ws-handler.test.ts`               | MEDIUM | Handler gets new `case 'ping'`. Existing cases must be unaffected.                       |
| `apps/runtime/src/__tests__/channels/ws-tenant-isolation.test.ts`      | LOW    | Tenant isolation unchanged. Sanity check.                                                |

---

## 11. Open Testing Questions

1. **Proxy simulation for E2E-5**: How to reliably test keepalive in E2E without a real proxy? Options: (a) trust the 60-second wait, (b) configure NGINX as test proxy with short timeout, (c) test at integration level only (INT-2) and verify E2E by confirming pings are sent.
2. **Chat tab selector stability**: E2E tests need reliable Playwright selectors for the Chat tab. Current routing is via `area/page/subPage/tab` URL params in AppShell — need to confirm these are accessible via URL navigation or require UI interaction.
3. **Test agent setup**: E2E-4 requires a real agent that responds to messages. Need to determine if a minimal test agent config is available in seed data or if one must be created during test setup.
4. **Session resume timing**: INT-3 depends on session surviving in detached state. Need to confirm there's no aggressive cleanup timer that might end detached sessions before the test reconnects. `runtime-policy-service.ts` `resolveDisconnectPolicy()` returns disposition — need to verify test agent uses `detach`.
