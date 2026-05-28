# Feature: WebSocket Relocation (App-Level → Chat-Tab-Level)

**Doc Type**: SUB-FEATURE
**Parent Feature**: Real-Time Communication / WebSocket Infrastructure
**Status**: ALPHA
**Feature Area(s)**: `customer experience`, `observability`
**Package(s)**: `apps/studio`, `apps/runtime`, `packages/web-sdk`
**Owner(s)**: Platform Team
**Testing Guide**: `../../testing/sub-features/ws-relocation.md`
**Last Updated**: 2026-04-14

---

## 1. Introduction / Overview

### Problem Statement

The Studio app opens a WebSocket connection to the runtime (`/ws`) **immediately on user login**, regardless of whether the user is on a page that needs real-time communication. This causes three problems:

1. **Phantom connection cycling**: The infrastructure proxy (e.g., `agents-dev.kore.ai`) enforces a ~60-second idle timeout and does not count WebSocket control frames (protocol-level ping/pong) as activity. After ~56 seconds of no data frames, the proxy terminates the connection. The client auto-reconnects, the `reconnectAttempts` counter resets on every successful `onopen` (line 758), and the cycle repeats **indefinitely**. Users see 6+ accumulated WebSocket connections in Chrome DevTools.

2. **Wasted resources**: Users browsing projects, editing agents, configuring workflows, viewing analytics, or managing settings all hold an open WS connection that serves zero purpose. Every such connection also consumes a server-side `ClientState` slot (max 10,000 in `WebSocketConnectionManager`), goes through JWT verification and tenant context resolution, and participates in 30-second heartbeat sweeps.

3. **Missing application-level keepalive parity**: The SDK WebSocket handler (`sdk-handler.ts:2337`) supports application-level `case 'ping'` → `pong` data frames. The internal Studio handler (`handler.ts:1456`) does not — it has 18 message types but `ping` is not among them. Protocol-level heartbeat (`ws.ping()` control frames in `heartbeat.ts:32`) works for direct connections but not through L7 proxies.

### Goal Statement

Relocate the `WebSocketProvider` from the app root (`page.tsx`) to the chat-tab component (`ChatWithDebugPanel` in `AppShell.tsx`), so the WS connection only exists when the user is actively in a live chat or test session. Additionally, add application-level ping/pong keepalive to match the SDK handler's existing capability.

### Summary

This change scopes the WebSocket lifecycle to the component tree that actually needs it. A complete consumer audit confirmed that all 7 live WS consumers sit inside the `ChatWithDebugPanel` subtree. The 2 app-level consumers (`App.tsx` splash screen, `CommandPalette`) don't truly need WS — the splash screen already has a 3-second fallback, and `fetchApps` is already an HTTP call. The server-side default disconnect behavior is `detach` (session stays alive), and `resume_session` supports 3-tier lookup (memory → Redis → DB), so navigating away from the Chat tab and back is seamless.

---

## 2. Scope

### Goals

- Move `WebSocketProvider` from `page.tsx` (app root) to `AppShell.tsx` wrapping `ChatWithDebugPanel` (chat tab)
- Add `case 'ping'` to the runtime internal WS handler (`handler.ts`) for app-level keepalive parity with SDK handler
- Add client-side periodic ping (25-second interval) in `WebSocketContext.tsx` to survive L7 proxy idle timeouts
- Decouple `App.tsx` from `useWebSocketContext()` — gate splash screen on auth state only
- Decouple `CommandPalette.tsx` from `useWebSocketContext()` — extract `fetchApps` to standalone HTTP hook
- Add `ping` to client-side `ClientMessage` type and `pong` to client-side `ServerMessage` type
- Add `ping` to runtime `ClientMessage` type

### Non-Goals (Out of Scope)

- Adding missing message handlers for `session_ended`, `execution_queued/started/cancelled/rejected`, `handoff_progress`, `agent_switch`, `typing_start` (pre-existing gaps, tracked in design doc §7.2)
- Message queueing when WS is disconnected (currently `send()` logs a warning and drops — behavior preserved)
- Exponential backoff for reconnection (currently fixed 3-second interval — behavior preserved)
- Adding `default` case to `handleMessage` switch (pre-existing, low priority)
- Adding `sessionId` validation on incoming messages (server-side already validates ownership)
- Tab visibility handling (pause WS when tab is backgrounded)
- Deleting dead components (`AgentSelector.tsx`, `TestCaseList.tsx`) — separate cleanup task

---

## 3. User Stories

1. As a **Studio developer**, I want the WebSocket to connect only when I open the Chat tab so that browsing projects, editing agents, and configuring workflows does not create unnecessary connections.
2. As a **Studio developer**, I want my chat session to survive when I navigate away from the Chat tab and back so that I don't lose conversation context.
3. As a **Studio developer**, I want the WebSocket to stay alive during idle chat periods (no messages being sent) so that the connection isn't dropped by infrastructure proxies.
4. As a **platform operator**, I want to reduce unnecessary WebSocket connections on the runtime so that server resources (connection slots, heartbeat sweeps, tenant resolution) are only consumed by active chat sessions.
5. As a **Studio developer**, I want the app to load quickly after login without waiting for a WebSocket connection so that I can start browsing immediately.

---

## 4. Functional Requirements

| ID    | Requirement                                                                                             | Status (2026-04-14)                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | The system must NOT open a WebSocket connection when the user logs in and lands on any non-chat page.   | **Implemented** -- `WebSocketProvider` removed from `page.tsx`, added to `AppShell.tsx` wrapping `ChatWithDebugPanel` only                                          |
| FR-2  | The system must open a WebSocket connection when the user navigates to the Chat tab.                    | **Implemented** -- `WebSocketProvider` mounts with chat tab in `AppShell.tsx`                                                                                       |
| FR-3  | The system must close the WebSocket connection when the user navigates away from the Chat tab.          | **Implemented** -- `WebSocketProvider` unmounts, cleanup effect calls `closeWs()`                                                                                   |
| FR-4  | The system must automatically resume the active session when the user returns to the Chat tab.          | **Implemented** -- Session resume via `resume_session` message on reconnect when `sessionId` exists in `useSessionStore`                                            |
| FR-5  | The runtime internal WS handler must respond to `{ type: 'ping' }` with `{ type: 'pong' }`.             | **Reverted** -- Added in initial commit, reverted in hardening follow-up. Internal `/ws` handler has no `case 'ping'`. Keepalive relies on protocol-level heartbeat |
| FR-6  | The Studio WS client must send `{ type: 'ping' }` data frames every 25 seconds.                         | **Reverted** -- Added in initial commit, removed in hardening follow-up. No client-side keepalive interval exists                                                   |
| FR-7  | The Studio WS client must handle `{ type: 'pong' }` server messages without error.                      | **Reverted** -- Removed along with FR-5/FR-6 in hardening. No `pong` handling needed since no pings are sent                                                        |
| FR-8  | The `App.tsx` splash screen must gate on authentication state only, not on WebSocket connection status. | **Implemented** -- `App.tsx` no longer imports `useWebSocketContext`, splash gates on `authLoading` only                                                            |
| FR-9  | The `CommandPalette` must fetch available apps via HTTP without depending on `WebSocketContext`.        | **Implemented** -- `useAvailableApps` HTTP hook created, `CommandPalette` uses `useOptionalWebSocketContext` for session-dependent commands                         |
| FR-10 | The keepalive ping interval must be cleaned up when the WebSocket is closed.                            | **N/A** -- No keepalive interval exists after hardening (FR-6 reverted)                                                                                             |

**Post-Implementation Note on FR-5/6/7/10**: The initial WS relocation commit (`041e93ae8`) added `case 'ping'` to `handler.ts`, ping/pong types to `events.ts`, and client-side keepalive to `WebSocketContext.tsx`. The hardening follow-up (`9b73c8d38`) reverted all of these. The rationale was that the Runtime protocol-level heartbeat (`ws.ping()` control frames in `heartbeat.ts`) already handles liveness for direct connections. Application-level keepalive was intended for L7 proxy idle timeout survival, but the hardening prioritized removing the complexity. **This means the original problem of L7 proxy idle timeouts on the internal `/ws` handler remains unaddressed.** The fix only addresses the WS relocation (fewer connections) and app-level decoupling.

Additionally, the SDK handler (`sdk-handler.ts`) had its JSON heartbeat timer removed from the browser SDK `SessionManager` (`0d85325d1`), but legacy SDK bundles that still send `{ type: 'ping' }` receive a raw `{ type: 'pong' }` response via `sendLegacyPong()` (`835e0b265`).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | NONE         | No project-level changes                                              |
| Agent lifecycle            | SECONDARY    | Agent loading/chat is where WS connects                               |
| Customer experience        | PRIMARY      | Fixes visible bug (multiple connections), faster app load             |
| Integrations / channels    | NONE         | SDK/voice/omnichannel handlers unchanged                              |
| Observability / tracing    | SECONDARY    | Observatory stores only populated during active chat (same as before) |
| Governance / controls      | NONE         | No permission or policy changes                                       |
| Enterprise / compliance    | NONE         | Auth mechanism unchanged                                              |
| Admin / operator workflows | NONE         | Admin portal unaffected                                               |

### Related Feature Integration Matrix

| Related Feature            | Relationship Type | Why It Matters                                                                                                          | Key Touchpoints                                              | Current State                                                                    |
| -------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Authentication (SSO/OAuth) | depends on        | WS connection effect depends on `accessToken` from auth store. Token refresh must not trigger unnecessary reconnection. | `auth-store.ts`, `auth.ts` (scheduleTokenRefresh)            | Guard check at line 733 prevents reconnection when token changes — verified safe |
| Session Management         | shares data with  | Sessions are detached on WS close and resumed on WS reconnect. 3-tier lookup supports cross-pod rehydration.            | `handler.ts` (handleResumeSession), `session-store.ts`       | Default disconnect behavior is `detach` — sessions survive                       |
| Observatory/Tracing        | emits into        | Trace events flow over WS into observatory stores. Only active during chat.                                             | `observatory-store.ts`, `WebSocketContext.tsx` handleMessage | All trace consumers are inside ChatWithDebugPanel tree                           |
| Auth Profiles (JIT Auth)   | extends           | Auth challenges and consent gates flow over WS during active chat.                                                      | `batch-consent-store.ts`, `AuthChallengeMessage.tsx`         | All auth challenge UI is inside chat panel                                       |

---

## 6. Design Considerations

See full design document: `docs/superpowers/specs/2026-04-13-ws-relocation-design.md`

Key architectural decisions:

- **Why chat-tab-level, not project-level**: All WS consumers are inside the Chat tab's component tree. Project-level would still waste connections on agent editor, workflows, sessions list, etc.
- **Why 25-second keepalive**: Well within typical 60-second proxy timeout. Two pings per timeout window. Low overhead (~40 bytes per ping). Aligned with server heartbeat interval (30s).
- **Why `detach` not `end` on disconnect**: The runtime default is `detach` (`handler.ts:152`), meaning sessions survive disconnection. This enables seamless navigate-away-and-back without losing state.

---

## 7. Technical Considerations

- **React component lifecycle**: `WebSocketProvider` mounts/unmounts with the Chat tab. The cleanup effect (`WebSocketContext.tsx:722-726`) calls `closeWs()` on unmount, which properly nulls handlers before closing.
- **Next.js `dynamic()` import**: `ChatWithDebugPanel` is not dynamically imported — it's a regular component rendered inside `AppShell.tsx`. The `WebSocketProvider` will wrap it directly.
- **Token refresh race**: When `accessToken` changes while WS is open, the guard check (`readyState === OPEN && url === url`) returns early — no reconnection. When WS is `CONNECTING`, `closeWs()` terminates it and `doConnect()` uses the new token. Both paths are safe.
- **Strict Mode double-mount**: In development, React Strict Mode may cause double mount/unmount. The cleanup effect handles this correctly. In production builds, Strict Mode doesn't double-mount.

---

## 8. How to Consume

### Studio UI

- **Before**: WS connection indicator in splash screen. "Connected to server" toast on login.
- **After**: No WS-related splash screen gating. Connection status visible only within the Chat tab (existing `isConnected` badge in OverviewTab, existing connection-dependent UI in StudioChatPanel).
- **User journey**: Login → browse freely (no WS) → open agent Chat tab (WS connects, session starts or resumes) → navigate away (WS closes, session detaches) → return to Chat tab (WS reconnects, session resumes).

### API (Runtime)

| Method | Path  | Purpose                                               |
| ------ | ----- | ----------------------------------------------------- |
| WS     | `/ws` | Internal Studio WebSocket — add `case 'ping'` handler |

No new endpoints. Existing endpoint behavior extended with one additional message type.

### API (Studio)

| Method | Path               | Purpose                                                                           |
| ------ | ------------------ | --------------------------------------------------------------------------------- |
| GET    | `/api/agents/apps` | Fetch available apps — already HTTP, extracted from WS context to standalone hook |

### Admin Portal

N/A — no admin-facing changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — SDK handler already has `case 'ping'`. Voice, A2A, and MCP handlers are unaffected. Only the internal `/ws` handler is modified.

---

## 9. Data Model

### Collections / Tables

No data model changes. No new collections, fields, or indexes.

### Key Relationships

**Planned type changes vs actual (post-hardening):**

- `apps/runtime/src/types/index.ts` — `ClientMessage` union: `| { type: 'ping' }` was added then removed. No `ping` in the ClientMessage union at HEAD.
- `apps/runtime/src/websocket/events.ts` — `parseClientMessage` `case 'ping'` was added then removed. `ping` is now an invalid/unknown message type. `ServerMessages.pong()` factory was removed.
- `apps/runtime/src/types/index.ts` — `{ type: 'pong' }` was removed from the `ServerMessage` union.
- `apps/studio/src/types/index.ts` — `| { type: 'ping' }` and `| { type: 'pong' }` were added then removed.
- `packages/web-sdk/src/core/SessionManager.ts` — JSON heartbeat timer was removed (no more client-side `ping` sends).

**Net type-level change at HEAD**: No new union members were added. The only structural changes are removals (heartbeat timer, `pong` from ServerMessage). The SDK handler uses a raw JSON string for legacy ping compat, bypassing the typed ServerMessage infrastructure.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                            | Purpose                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/contexts/WebSocketContext.tsx` | WebSocket provider and context; exports `useOptionalWebSocketContext` for components outside the provider tree (added during hardening) |
| `apps/runtime/src/websocket/sdk-handler.ts`     | SDK WS handler with `sendLegacyPong()` compatibility shim for older SDK bundles that still send `{ type: 'ping' }`                      |
| `packages/web-sdk/src/core/SessionManager.ts`   | Browser SDK session manager; JSON heartbeat timer removed, connection liveness owned by server-side protocol heartbeat                  |

### Routes / Handlers

| File                                                 | Purpose                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/studio/src/components/navigation/AppShell.tsx` | Wraps `ChatWithDebugPanel` with `WebSocketProvider` (WS relocation target) |
| `apps/studio/src/app/page.tsx`                       | `WebSocketProvider` removed, URL derivation imports removed                |

### UI Components

| File                                                 | Purpose                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/App.tsx`                            | `useWebSocketContext` removed, splash gates on `authLoading` only, "Connected" toast removed                      |
| `apps/studio/src/components/CommandPalette.tsx`      | Uses `useOptionalWebSocketContext` + `useAvailableApps` HTTP hook; session-dependent commands conditionally gated |
| `apps/studio/src/components/chat/SessionSidebar.tsx` | Minor cleanup during hardening                                                                                    |
| `apps/studio/src/components/session/OverviewTab.tsx` | Minor cleanup during hardening                                                                                    |

### New Files

| File                                        | Purpose                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/studio/src/hooks/useAvailableApps.ts` | HTTP-based app fetching hook replacing WS-dependent app loading in CommandPalette |
| `apps/studio/src/lib/app-graph-loader.ts`   | Standalone app graph loading utility extracted during WS relocation hardening     |

### Tests

| File                                                                     | Type | Coverage Focus                                                                                  |
| ------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx`   | unit | Existing regression guard -- verified still passing after relocation                            |
| `apps/studio/src/__tests__/components/command-palette.test.tsx`          | unit | CommandPalette renders and fetches apps via HTTP hook without WebSocket dependency              |
| `apps/studio/src/__tests__/hooks/project-agent-session-launcher.test.ts` | unit | Session launcher hook behavior post-WS relocation                                               |
| `apps/runtime/src/__tests__/channels/websocket-events.test.ts`           | unit | `parseClientMessage` coverage; confirms `ping` is rejected as invalid at the parse layer        |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`             | unit | SDK WS handler including legacy ping compatibility shim, auth, identity propagation             |
| `apps/runtime/src/__tests__/ws-sdk-message-contract.test.ts`             | unit | SDK message contract coverage post-heartbeat removal                                            |
| `packages/web-sdk/src/__tests__/session-manager-connect.test.ts`         | unit | `connect()` readiness; regression guard that no heartbeat frames are sent after `session_start` |
| `packages/web-sdk/src/__tests__/default-transport.test.ts`               | unit | DefaultTransport message translation; confirms `pong` is dropped as internal message            |

---

## 11. Configuration

### Environment Variables

| Variable         | Default                          | Description                                                                               |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `RUNTIME_WS_URL` | (derived from `window.location`) | WebSocket URL — no change, just used in different location (AppShell instead of page.tsx) |

### Runtime Configuration

No new feature flags or tenant-level settings. The keepalive interval (25s) is a constant in `WebSocketContext.tsx`. No configuration needed — it's a protocol-level implementation detail.

### DSL / Agent IR / Schema

N/A — no DSL or IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Unchanged — `startProjectAgentSession` sends `projectId` in WS messages. Server validates.                                       |
| Tenant isolation  | Unchanged — `resolveWSTenantContext()` runs on every new WS connection. JWT-based tenant scoping preserved.                      |
| User isolation    | Unchanged — `ensureWsSessionAccess()` validates user ownership on `resume_session`. Cross-user access returns `session_expired`. |

### Security & Compliance

- **Auth mechanism unchanged**: Subprotocol-based JWT auth (`web-debug-auth,<token>`) — same as before.
- **Token handling**: New token from refresh is used on next connection (guard check prevents unnecessary reconnection with old WS).
- **Ping/pong messages carry no auth data**: `{ type: 'ping' }` and `{ type: 'pong' }` are empty data frames — no secrets, no PII.

### Performance & Scalability

- **Fewer connections**: Users not in Chat tab have zero WS connections (previously: 1 connection per authenticated user).
- **Reduced heartbeat load**: Fewer connections in `wss.clients` → fewer protocol-level pings in the 30s sweep.
- **Connection setup overhead**: ~5-50ms per new connection (JWT verify + tenant resolution). Acceptable for navigate-to-chat frequency.
- **Keepalive overhead**: 40 bytes every 25 seconds per active chat session. Negligible.

### Reliability & Failure Modes

- **Session survival**: Default disconnect behavior is `detach`. Sessions stay alive after WS close. Resumable via 3-tier lookup.
- **In-flight response loss**: If WS closes during streaming, partial response is lost. Same as current behavior (browser close, network drop). Session state is preserved via snapshot.
- **Reconnection**: Existing 3s interval, 5-attempt max. Counter resets on success (intentional — reconnect should work indefinitely for real network recovery).
- **Rollback**: Each change is in a separate file. Reverting `page.tsx` + `App.tsx` + `AppShell.tsx` restores original behavior. Keepalive changes are independently beneficial.

### Observability

- **No new trace events**: Observatory stores are only written by `handleMessage`, which is unchanged.
- **Existing `ws-handler` logger**: Logs connection/disconnection events. Will now see more connect/disconnect cycles as users navigate in/out of Chat tab, but with lower total connection count overall.
- **`ws-heartbeat` logger**: Fewer "Terminating unresponsive WebSocket client" warnings (keepalive prevents false positives from proxy-killed connections).

### Data Lifecycle

No data lifecycle changes. No new persistence, no new TTLs, no new cleanup jobs.

---

## 13. Delivery Plan / Work Breakdown

1. **Server-side keepalive support**
   1.1 Add `| { type: 'ping' }` to runtime `ClientMessage` type (`apps/runtime/src/types/index.ts`)
   1.2 Add `case 'ping': send(ws, ServerMessages.pong()); break;` to `handler.ts` message switch
   1.3 Write unit test for ping → pong response

2. **Client-side keepalive**
   2.1 Add `| { type: 'ping' }` to studio `ClientMessage` type and `| { type: 'pong' }` to studio `ServerMessage` type
   2.2 Add `case 'pong': break;` to `handleMessage` switch in `WebSocketContext.tsx`
   2.3 Add 25-second keepalive interval in the connection effect (after `wsRef.current = ws`)
   2.4 Clean up keepalive interval in `closeWs()` and `onclose` handler
   2.5 Write unit test for keepalive start/stop behavior

3. **Decouple App.tsx from WebSocket**
   3.1 Remove `useWebSocketContext()` import from `App.tsx`
   3.2 Change splash screen logic to gate on `authLoading` only (remove `isConnected` check)
   3.3 Remove "Connected" toast effect
   3.4 Remove `isReconnecting` from `SplashScreen` component props
   3.5 Write unit test for App rendering without WebSocketContext

4. **Decouple CommandPalette from WebSocket**
   4.1 Create `apps/studio/src/hooks/useAvailableApps.ts` — HTTP-based app fetching
   4.2 Replace `useWebSocketContext` in `CommandPalette.tsx` with `useAvailableApps` hook
   4.3 Make `loadApp`/`resetSession` commands conditional on active session (via `useSessionStore`)

5. **Relocate WebSocketProvider**
   5.1 Remove `WebSocketProvider` from `page.tsx`
   5.2 Add `WebSocketProvider` wrapping `ChatWithDebugPanel` in `AppShell.tsx:586`
   5.3 Move `wsUrl` derivation from `page.tsx` to `AppShell.tsx`
   5.4 Verify session resume works (navigate away from Chat, return — session auto-resumes)

6. **Validation**
   6.1 Manual verification: login → browse projects → no WS in Network tab
   6.2 Manual verification: open Chat tab → WS connects → idle 2 minutes → stays alive
   6.3 Manual verification: navigate away → WS closes → return → session resumes
   6.4 Run existing test suite (`pnpm test --filter=studio`)

---

## 14. Success Metrics

| Metric                              | Baseline                          | Target                   | How Measured                                       |
| ----------------------------------- | --------------------------------- | ------------------------ | -------------------------------------------------- |
| WS connections on non-chat pages    | 1 per authenticated user          | 0                        | Chrome DevTools Network tab                        |
| WS connection cycling on idle chat  | Every ~56 seconds                 | None (stable connection) | Chrome DevTools Network tab — single persistent WS |
| App load time (login → interactive) | Blocked by WS connect (~500ms-3s) | Auth-only (~200ms)       | Splash screen dismiss timing                       |
| Runtime active WS connections       | All authenticated users           | Only users on Chat tab   | `websocket_connections` Prometheus metric          |

---

## 15. Open Questions

1. **Proxy idle timeout**: Is the ~60-second timeout configurable on `agents-dev.kore.ai`? If so, increasing it to 120s would provide additional safety margin alongside the 25s keepalive. (Not a blocker — keepalive fix works regardless.)
2. **Tab visibility optimization**: Should the keepalive ping be paused when the browser tab goes to background? This would save ~1.4 pings/minute per backgrounded tab. (Deferred — not in scope.)
3. **Connection status in Chat tab**: After removing the splash screen WS gating, should we add a connection status indicator inside the Chat panel (e.g., a small "Connecting..." bar)? Currently, `StudioChatPanel` already reads `isConnected` for this purpose.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                            | Severity | Status                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | 9 server message types unhandled in client `handleMessage` switch (`session_ended`, `execution_queued/started/cancelled/rejected`, `handoff_progress`, `agent_switch`, `typing_start`) | Medium   | Open -- pre-existing, separate feature work                                                                                                                                                                                       |
| GAP-002 | `send()` silently drops messages when WS is disconnected (console.warn only)                                                                                                           | Medium   | Open -- pre-existing, needs design for message queue                                                                                                                                                                              |
| GAP-003 | Fixed 3-second reconnection interval (no exponential backoff)                                                                                                                          | Low      | Open -- pre-existing, nice-to-have improvement                                                                                                                                                                                    |
| GAP-004 | No `default` case in `handleMessage` switch                                                                                                                                            | Low      | Open -- pre-existing                                                                                                                                                                                                              |
| GAP-005 | Dead components `AgentSelector.tsx` and `TestCaseList.tsx` reference `useWebSocketContext` but are never imported                                                                      | Low      | Open -- cleanup task                                                                                                                                                                                                              |
| GAP-006 | In-flight streaming response may be lost if user navigates away during active response                                                                                                 | Low      | Mitigated -- same as browser close behavior, session state preserved via snapshot                                                                                                                                                 |
| GAP-007 | L7 proxy idle timeout still drops internal `/ws` connections (FR-5/FR-6 reverted)                                                                                                      | Medium   | Open -- the original problem of proxy-killed idle connections remains unsolved for internal Studio WS. WS relocation reduces the _number_ of affected connections but does not prevent the timeout cycle for active chat sessions |
| GAP-008 | No E2E or integration tests for WS relocation scenarios                                                                                                                                | Medium   | Open -- all 7 planned E2E and 7 planned integration tests remain unwritten                                                                                                                                                        |
| GAP-009 | `CommandPalette` uses `useOptionalWebSocketContext` instead of full WS independence                                                                                                    | Low      | Open -- the palette was partially decoupled (apps fetched via HTTP) but still checks `wsContext` for session-dependent commands. When outside the WS provider tree, session commands are hidden, which is correct behavior        |

---

## 17. Testing & Validation

### Actual Test Coverage (as of 2026-04-14)

| #   | Scenario                                               | Coverage Type      | Status             | Test File / Note                                                                      |
| --- | ------------------------------------------------------ | ------------------ | ------------------ | ------------------------------------------------------------------------------------- |
| 1   | Internal `/ws` ping/pong response                      | unit + integration | REVERTED (N/A)     | FR-5 reverted in hardening -- internal handler has no `case 'ping'`                   |
| 2   | Client sends ping every 25s, cleans up on close        | unit               | REVERTED (N/A)     | FR-6 reverted in hardening -- no client-side keepalive interval                       |
| 3   | Client handles `pong` message without error            | unit               | REVERTED (N/A)     | FR-7 reverted in hardening -- no `pong` handler needed                                |
| 4   | App.tsx renders splash + main without WebSocketContext | unit               | NOT TESTED         | Code change verified (App.tsx no longer imports WS context) but no dedicated test     |
| 5   | CommandPalette fetches apps via HTTP without WS        | unit               | TESTED             | `apps/studio/src/__tests__/components/command-palette.test.tsx`                       |
| 6   | No WS connection on non-chat pages                     | e2e                | NOT TESTED         | WS relocation is structural (WebSocketProvider placement) but no E2E proof            |
| 7   | WS connects on Chat tab navigation                     | e2e                | NOT TESTED         | No browser E2E proof                                                                  |
| 8   | WS disconnects on Chat tab navigation away             | e2e                | NOT TESTED         | No browser E2E proof                                                                  |
| 9   | Session resumes after navigate away and back           | integration + e2e  | NOT TESTED         | No dedicated resume-after-relocation test                                             |
| 10  | Token refresh does not trigger WS reconnection         | unit               | EXISTING -- PASSES | `apps/studio/src/__tests__/websocket-auth-refresh-regression.test.tsx`                |
| 11  | Keepalive prevents proxy timeout                       | integration + e2e  | REVERTED (N/A)     | FR-5/FR-6 reverted -- L7 proxy timeout remains an open gap                            |
| 12  | Cross-user/cross-tenant session isolation              | integration        | NOT TESTED         | No dedicated cross-user session isolation test for WS relocation                      |
| 13  | Legacy SDK ping compat in SDK handler                  | unit               | TESTED             | `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts` -- `sendLegacyPong` shim |
| 14  | No heartbeat frames after `session_start`              | unit               | TESTED             | `packages/web-sdk/src/__tests__/session-manager-connect.test.ts` -- regression guard  |
| 15  | `parseClientMessage` rejects `ping` as invalid         | unit               | TESTED             | `apps/runtime/src/__tests__/channels/websocket-events.test.ts`                        |
| 16  | Session launcher hook post-relocation                  | unit               | TESTED             | `apps/studio/src/__tests__/hooks/project-agent-session-launcher.test.ts`              |

### Test Counts

- **Unit tests written**: 5 (CommandPalette, ws-sdk-handler legacy ping, session-manager heartbeat guard, websocket-events ping rejection, session launcher)
- **Unit tests planned but unwritten**: 3 (App.tsx no-WS, useAvailableApps hook, CommandPalette no-WS standalone)
- **Integration tests written**: 0 of 7 planned
- **E2E tests written**: 0 of 7 planned
- **Regression guards verified passing**: websocket-auth-refresh-regression.test.tsx

### Testing Notes

The ws-relocation implementation focused on structural code changes and existing regression guard verification. The 7 planned E2E test files and 7 planned integration test files from the test spec remain unwritten. The main testing gap is the absence of browser E2E proof that WS connections are scoped to the chat tab.

The keepalive-related test scenarios (UT-1, UT-2, UT-3, UT-7, UT-8, INT-1, INT-2, INT-6, E2E-5) are no longer applicable after the hardening reverted FR-5/FR-6/FR-7/FR-10.

> Full testing details: `../../testing/sub-features/ws-relocation.md`

---

## 18. References

- Design doc: `docs/superpowers/specs/2026-04-13-ws-relocation-design.md`
- Runtime heartbeat: `apps/runtime/src/websocket/heartbeat.ts`
- SDK ping handler: `apps/runtime/src/websocket/sdk-handler.ts:2337`
- Internal WS handler: `apps/runtime/src/websocket/handler.ts`
- Studio WS context: `apps/studio/src/contexts/WebSocketContext.tsx`
- Session lifecycle policy: `apps/runtime/src/services/session-lifecycle/runtime-policy-service.ts`
