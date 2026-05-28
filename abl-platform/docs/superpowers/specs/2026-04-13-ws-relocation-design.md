# WebSocket Relocation: App-Level → Chat-Tab-Level

**Date**: 2026-04-13
**Status**: Draft — Awaiting Approval
**Scope**: `apps/studio/`, `apps/runtime/` (handler.ts, events.ts, types)

---

## 1. Problem Statement

The Studio app opens a WebSocket connection to the runtime (`/ws`) **immediately on login**, regardless of whether the user needs it. This causes:

1. **Multiple phantom connections**: The infrastructure proxy (`agents-dev.kore.ai`) has a ~60-second idle timeout. Because no application-level data frames flow during idle periods (only protocol-level ping/pong which the proxy ignores), the proxy kills the connection every ~56 seconds. The client reconnects automatically, and since `onopen` resets the reconnect counter, this cycle repeats **indefinitely**. Chrome DevTools shows 6+ accumulated WS connections.

2. **Wasted resources**: Users browsing projects, editing agents, configuring workflows, or viewing analytics all hold an open WS connection that serves zero purpose.

3. **Missing application-level keepalive**: The SDK handler has `case 'ping'` → `pong` response, but the internal `/ws` handler does not. The protocol-level heartbeat (`ws.ping()` control frames) doesn't survive L7 proxies.

---

## 2. Root Cause Analysis

### 2.1 Why Multiple Connections Appear

```
t=0s    WS connects (onopen → reconnectAttempts = 0)
t=56s   Proxy kills connection (no data frames for ~60s)
t=56s   onclose fires → reconnect after 3s
t=59s   New WS connects (onopen → reconnectAttempts = 0)  ← counter resets!
t=115s  Proxy kills again
...repeats forever
```

The `reconnectAttempts` counter resets to 0 on every successful connection (`WebSocketContext.tsx:758`), so the 5-attempt max never trips.

### 2.2 Why Protocol-Level Heartbeat Doesn't Help

- `heartbeat.ts:32`: Server sends `ws.ping()` (WebSocket control frame) every 30s
- Browser auto-responds with `pong` (also a control frame)
- Many L7 proxies (NGINX, ALB, Cilium, cloud LBs) **don't count control frames as activity** — only data frames reset the idle timer
- The SDK handler (`sdk-handler.ts:2337`) has `case 'ping': send(ws, ServerMessages.pong())` — application-level data frames that DO reset the proxy timer
- The internal handler (`handler.ts:1456`) has **no `ping` case** — 18 message types handled, none is `ping`

### 2.3 Why WS Is at App Level

Historical design: the splash screen (`App.tsx:155`) gates on `isConnected` to show "Connecting..." before rendering the main UI. A 3-second fallback timeout already exists (`App.tsx:81-84`), making the WS gate redundant.

---

## 3. Consumer Inventory

### 3.1 Complete Map of `useWebSocketContext()` Consumers

| #   | File                            | Values Used                                                  | Live?    | Rendered Where                               |
| --- | ------------------------------- | ------------------------------------------------------------ | -------- | -------------------------------------------- |
| 1   | `App.tsx:42`                    | `isConnected`, `isReconnecting`                              | **LIVE** | Root — splash screen gating                  |
| 2   | `CommandPalette.tsx:50`         | `availableApps`, `loadApp`, `resetSession`, `fetchApps`      | **LIVE** | Root — Cmd+K overlay                         |
| 3   | `ChatWithDebugPanel.tsx:26`     | `startProjectAgentSession`                                   | **LIVE** | Project → Agents → Agent → Chat tab          |
| 4   | `StudioChatPanel.tsx:141`       | `send`, `resetSession`, `isConnected`                        | **LIVE** | Inside ChatWithDebugPanel                    |
| 5   | `SessionSidebar.tsx:67`         | `resumeSession`, `switchSession`                             | **LIVE** | Inside ChatWithDebugPanel                    |
| 6   | `AuthChallengeMessage.tsx:65`   | `send`                                                       | **LIVE** | Inside StudioChatPanel                       |
| 7   | `OverviewTab.tsx:200` (session) | `isConnected`                                                | **LIVE** | Inside DebugTabs → inside ChatWithDebugPanel |
| 8   | `TestContextPanel.tsx:38`       | `startProjectAgentSession`, `isConnected`                    | **LIVE** | Inside DebugTabs → inside ChatWithDebugPanel |
| 9   | `useStudioTransport.ts:230`     | `sendMessage`, `send`, `isConnected`, `subscribeChatMessage` | **LIVE** | Used by StudioChatPanel                      |
| 10  | `AgentSelector.tsx:17`          | `loadAgent`                                                  | **DEAD** | Exported but never imported                  |
| 11  | `TestCaseList.tsx:34`           | `runTest`                                                    | **DEAD** | Exported but never imported                  |

### 3.2 Component Tree Analysis

```
page.tsx (WebSocketProvider currently mounted HERE)
└── App.tsx ← isConnected, isReconnecting (SPLASH ONLY)
    └── AppShell.tsx
        ├── CommandPalette ← fetchApps (HTTP!), loadApp, resetSession
        ├── ProjectDashboard (NO WS)
        ├── AgentListPage (NO WS)
        ├── AgentEditorPage (NO WS)
        ├── WorkflowsListPage (NO WS)
        ├── SessionsListPage (NO WS)
        ├── SessionDetailPage (NO WS)
        ├── ... 30+ other pages (NO WS)
        │
        └── ChatWithDebugPanel ← ALL real WS consumers are HERE
            ├── SessionSidebar ← resumeSession, switchSession
            ├── StudioChatPanel ← send, resetSession, isConnected
            │   ├── useStudioTransport ← sendMessage, send, subscribeChatMessage
            │   └── AuthChallengeMessage ← send
            └── DebugTabs
                ├── OverviewTab ← isConnected (status badge)
                └── TestContextPanel ← startProjectAgentSession, isConnected
```

**Key finding**: Consumers #3–#9 (all real WS usage) are **entirely within the `ChatWithDebugPanel` subtree**. Consumers #1–#2 are app-level but don't truly need WS.

### 3.3 Store Dependencies (Written by WS Messages)

The `handleMessage` function (`WebSocketContext.tsx:156-652`) writes to these stores on incoming messages:

| Store                  | Actions Called                                                                                                                                                                               | Triggered By Message Types                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useSessionStore`      | `setSession`, `setState`, `updateState`, `setLastAction`, `startStreaming`, `appendStreamChunk`, `endStreaming`, `setError`, `setStatusMessage`, `addMessage`, `clearMessages`, `setLoading` | `agent_loaded`, `response_start/chunk/end`, `trace_event`, `state_update`, `action_taken`, `session_reset`, `session_resumed`, `session_expired`, `error`, `context_injected`, `context_injection_error` |
| `useObservatoryStore`  | `setDebugState`, `clearEvents`, `clearFlow`, `setStaticGraph`, `setAppStaticGraph`, `setGraphViewMode`, `addEvent`, `startClientTimer`, `endClientTimer`, `addLog`                           | `agent_loaded`, `trace_event`, `session_reset`, `session_health`, `tool_warnings`                                                                                                                        |
| `useBatchConsentStore` | `reset`, `initFromAuthRequired`, `updateFromGateUpdate`, `markAllSatisfied`                                                                                                                  | `agent_loaded`, `session_reset`, `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`                                                                                                             |

All of these stores are **only consumed by components inside the chat/debug panel tree**. No app-level component reads from these stores.

---

## 4. Design

### 4.1 Move WebSocketProvider to ChatWithDebugPanel

**Current** (`page.tsx:84`):

```tsx
<WebSocketProvider url={wsUrl}>
  <App />
</WebSocketProvider>
```

**Proposed** — wrap `ChatWithDebugPanel` in `AppShell.tsx`:

```tsx
// AppShell.tsx, line ~586
if (tab === 'chat') {
  return (
    <WebSocketProvider url={wsUrl}>
      <ChatWithDebugPanel />
    </WebSocketProvider>
  );
}
```

**Lifecycle**:

- WS connects when user navigates to: **Project → Agents → [Agent] → Chat tab**
- WS disconnects when user navigates away from the Chat tab
- Navigation path: `area='project'`, `page='agents'`, `subPage=<agentName>`, `tab='chat'`

### 4.2 Decouple App.tsx from WebSocket

**Current splash logic** (`App.tsx:155`):

```tsx
if (authLoading || (showSplash && isAuthenticated && !isConnected)) {
  return <SplashScreen ... />;
}
```

**Proposed** — remove WS dependency:

```tsx
if (authLoading || showSplash) {
  return <SplashScreen isAuthLoading={authLoading} />;
}
```

- Remove `useWebSocketContext()` import from `App.tsx`
- Remove `isReconnecting` from `SplashScreen` (no longer relevant at app level)
- Remove "Connected" toast (`App.tsx:87-91`) — connection feedback moves to the chat panel
- Keep the 3s fallback timeout for splash dismissal
- `App.tsx` becomes a pure auth + routing shell

### 4.3 Decouple CommandPalette from WebSocket

| Value             | Current Usage                                                    | Change                                                                                                |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `fetchApps()`     | HTTP call (`fetch('/api/agents/apps')`) — already WS-independent | Move to a standalone hook or inline the fetch                                                         |
| `availableApps`   | State populated by `fetchApps`                                   | Move to standalone state (local `useState` or a Zustand store slice)                                  |
| `loadApp(domain)` | Sends WS `load_agent` for each agent in domain                   | Only available when inside a WS-connected chat. Disable/hide in CommandPalette when no active session |
| `resetSession()`  | Sends WS `reset_session`                                         | Same — only available during active session                                                           |

**Approach**: Extract `fetchApps` + `availableApps` into a small `useAvailableApps()` hook (HTTP-only). For `loadApp`/`resetSession` — make them conditional: the CommandPalette checks if a session is active (via `useSessionStore`) and only shows those commands when there's a live chat session.

### 4.4 Remove WebSocketProvider from page.tsx

```tsx
// page.tsx — BEFORE
export default function HomePage() {
  const { wsUrl: configWsUrl } = useRuntimeConfig();
  const wsUrl = deriveDefaultWsUrl(configWsUrl);
  return (
    <ErrorBoundary>
      <SWRConfig value={swrConfig}>
        <WebSocketProvider url={wsUrl}>
          <App />
        </WebSocketProvider>
      </SWRConfig>
    </ErrorBoundary>
  );
}

// page.tsx — AFTER
export default function HomePage() {
  return (
    <ErrorBoundary>
      <SWRConfig value={swrConfig}>
        <App />
      </SWRConfig>
    </ErrorBoundary>
  );
}
```

The `wsUrl` derivation moves to `AppShell.tsx` where the `WebSocketProvider` now lives.

### 4.5 Add Application-Level Keepalive (Ping/Pong)

Even with WS scoped to the chat tab, the proxy timeout still applies during idle chat periods. We need application-level keepalive to match the SDK handler's existing support.

#### 4.5.1 Server Side — Add `ping` to Internal Handler

**File**: `apps/runtime/src/websocket/handler.ts` (~line 1553, after last `case`)

```typescript
case 'ping':
  send(ws, ServerMessages.pong());
  break;
```

This matches `sdk-handler.ts:2337-2339` exactly.

#### 4.5.2 Server Side — Add `ping` to Client Message Types

**File**: `apps/runtime/src/types/index.ts`

Add to the `ClientMessage` union:

```typescript
| { type: 'ping' }
```

**Note**: `ServerMessage` already has `{ type: 'pong' }` (line 400) and `ServerMessages.pong()` factory exists in `events.ts:422-423`.

#### 4.5.3 Client Side — Add `ping` to Client Message Types

**File**: `apps/studio/src/types/index.ts`

Add to the `ClientMessage` union (after line 455):

```typescript
| { type: 'ping' }
```

Add to the `ServerMessage` union:

```typescript
| { type: 'pong' }
```

#### 4.5.4 Client Side — Periodic Ping in WebSocketContext

**File**: `apps/studio/src/contexts/WebSocketContext.tsx`

Add a keepalive interval inside the connection effect, after `wsRef.current = ws`:

```typescript
// Application-level keepalive — sends data frames to survive L7 proxy idle timeouts
const keepaliveInterval = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25_000); // 25s — well within typical 60s proxy timeout
```

Clean up in `closeWs()` and the onclose handler.

#### 4.5.5 Client Side — Handle `pong` in handleMessage

Add to the switch in `handleMessage`:

```typescript
case 'pong':
  // Keepalive response — no action needed
  break;
```

#### 4.5.6 Keepalive Interval Choice

| Option                       | Interval | Rationale                                                                                                                                      |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **25 seconds** (recommended) | 25s      | Well within 60s proxy timeout. Two pings per proxy timeout window. Low overhead (~40 bytes/ping). Aligned with protocol-level heartbeat (30s). |
| 15 seconds                   | 15s      | More aggressive. Higher overhead for no benefit.                                                                                               |
| 45 seconds                   | 45s      | Too close to 60s timeout — single missed ping could cause disconnect.                                                                          |

---

## 5. Server-Side Impact Analysis

### 5.1 Session Disconnect Behavior

When the WS closes (user navigates away from Chat tab):

1. `handler.ts:1140` — `ws.on('close')` fires
2. `resolveWebDebugDisconnectLifecycle()` is called
3. Default fallback: `disconnectBehavior: 'detach'` (`handler.ts:152`)
4. **Session is detached, NOT ended** — it stays alive in the runtime executor

This means navigating away from Chat and back does NOT destroy the session.

### 5.2 Session Resume on Reconnect

When the user returns to the Chat tab (new WS connects):

1. `WebSocketContext.tsx:762-765` — `onopen` checks for existing `sessionId` in `useSessionStore`
2. Sends `{ type: 'resume_session', sessionId }` automatically
3. `handler.ts:3137-3260` — `handleResumeSession()` tries 3-tier lookup:
   - **Tier 1**: In-memory on same pod (instant)
   - **Tier 2**: Cross-pod rehydration from Redis/SessionService
   - **Tier 3**: DB fallback — rebuild runtime session from persisted data
4. Returns `session_resumed` with full state and conversation history
5. Client restores session state, messages, traces, and agent details

**Session resume is fully supported.** The existing `onopen` logic already handles this.

### 5.3 In-Flight Message Risk

If the user navigates away **during an active response** (streaming):

1. WS closes → server detects disconnect
2. Streaming response is orphaned (no client to deliver to)
3. Session state is preserved via snapshot (`executor.saveSessionSnapshot()`)
4. On resume: conversation history is replayed from DB, but the **in-flight partial response may be lost**

**Mitigation**: This is the same behavior as today (browser close, network drop). The existing `resume_session` flow handles it by replaying history from DB. No additional work needed.

### 5.4 Connection Setup Overhead

Each new WS connection requires:

1. Subprotocol auth token extraction (~0ms)
2. JWT verification via `extractVerifiedUserTokenClaims()` (~1ms)
3. Tenant context resolution via `resolveWSTenantContext()` (~5-50ms, involves DB lookup)
4. Buffered message processing

This is lightweight. The tenant context resolution is cached per-user in practice. More frequent connections (per-chat vs per-app) add negligible overhead.

### 5.5 Detached Session Cleanup

Detached sessions are cleaned up by:

- Runtime executor's session TTL (configurable per tenant/project)
- `WebSocketConnectionManager` stale sweep (60s interval, 5-minute TTL)
- Session terminalization service for channels that opt in

No changes needed — existing cleanup handles the detach-resume cycle.

---

## 6. Edge Cases

### 6.1 Token Refresh During Active Chat

**Current flow**:

1. `scheduleTokenRefresh(600)` schedules refresh ~9 minutes after login
2. `runScheduledTokenRefresh()` → `setTokens(newToken)` → `accessToken` changes in Zustand
3. `WebSocketContext.tsx:680` subscribes to `accessToken` — component re-renders
4. Connection effect re-runs (`accessToken` is in dependency array)
5. **Guard check** (`line 733`): `wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.url === url` → returns early (no reconnection)

**After this change**: Same behavior — token refresh doesn't trigger reconnection because the guard catches it. The new token is used on the NEXT connection (if a reconnect happens or user navigates away and back).

### 6.2 Multiple Browser Tabs

Each tab opens its own WS connection when the user opens the Chat tab. This is the same as today (each tab has its own `WebSocketProvider`). The runtime's `ConnectionRegistry` supports multiple connections per session.

**Improvement**: With WS scoped to chat tab, tabs that aren't on the Chat tab **won't have a connection at all**, reducing total connections.

### 6.3 Server Restart While on Chat Tab

1. Server restart terminates the WS connection
2. `onclose` fires → reconnect logic triggers (3s interval, max 5 attempts)
3. If server is back within ~18s (5 × 3s + connection time), reconnection succeeds
4. `onopen` sends `resume_session` → session rehydrated from DB
5. If server is down longer → "Failed to connect to server" error shown

**No change from current behavior.**

### 6.4 Tab Visibility (Background Tabs)

**Current**: No `visibilitychange` handling exists (confirmed via grep — only `useExecutionPolling.ts` checks `document.hidden`, unrelated to WS).

**After this change**: Same — no visibility handling. Browser maintains WS connection in background tabs. The keepalive ping continues, keeping the proxy alive.

**Future improvement** (out of scope): Could pause keepalive and optionally close WS when tab goes background for >N minutes.

### 6.5 Network Disconnects (WiFi Drop, VPN Reconnect)

1. WS `onclose` fires (or `onerror` → `onclose`)
2. Reconnect logic triggers (3s interval, max 5 attempts)
3. If network recovers within the retry window → reconnects and resumes session
4. If not → error state shown

**No change from current behavior.** The reconnection logic is preserved as-is.

### 6.6 User Switches Agents Within Chat Tab

`ChatWithDebugPanel.tsx:33-38` already handles this:

```typescript
useEffect(() => {
  const { agent } = useSessionStore.getState();
  if (agent && agentName && agent.name !== agentName) {
    useSessionStore.getState().clearSession();
  }
}, [agentName]);
```

The `WebSocketProvider` stays mounted (same Chat tab), so the WS connection stays open. Only the session state is cleared. A new `startProjectAgentSession` call creates a fresh session.

### 6.7 Navigating Away During Agent Load

If the user navigates away while `load_agent` is in progress:

1. WS closes → server-side agent compilation continues but response has no destination
2. `clients.remove(ws)` cleans up the client state
3. No session was created yet, so no cleanup needed

**Safe — no data loss.**

---

## 7. Handled Message Types Audit

### 7.1 Server Messages Handled by Client (`handleMessage` switch)

| Message Type              | Store Actions                                                         | Status                           |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| `agent_loaded`            | `setSession`, `clearObservatoryEvents`, `clearFlow`, `setStaticGraph` | ✅ Handled                       |
| `agent_load_error`        | `setLoading(false)`, `setError`                                       | ✅ Handled                       |
| `response_start`          | `startStreaming`                                                      | ✅ Handled                       |
| `response_chunk`          | `appendStreamChunk`                                                   | ✅ Handled                       |
| `response_end`            | `endStreaming`, `endClientTimer`, `setStatusMessage(null)`            | ✅ Handled                       |
| `trace_event`             | `addObservatoryEvent`, `addLog`, `updateState`, `addMessage`          | ✅ Handled                       |
| `state_update`            | `updateState` / `setState`                                            | ✅ Handled                       |
| `action_taken`            | `setLastAction`                                                       | ✅ Handled                       |
| `session_reset`           | `setState`, `clearObservatoryEvents`, `clearFlow`                     | ✅ Handled                       |
| `session_resumed`         | Full state + history restore                                          | ✅ Handled                       |
| `session_expired`         | `setError`                                                            | ✅ Handled                       |
| `context_injected`        | `updateState`                                                         | ✅ Handled                       |
| `tool_mock_set`           | (no-op)                                                               | ✅ Handled                       |
| `context_injection_error` | `setError`                                                            | ✅ Handled                       |
| `auth_challenge`          | `addMessage` (system)                                                 | ✅ Handled                       |
| `auth_required`           | `useBatchConsentStore.initFromAuthRequired`                           | ✅ Handled                       |
| `auth_gate_updated`       | `useBatchConsentStore.updateFromGateUpdate`                           | ✅ Handled                       |
| `auth_gate_satisfied`     | `useBatchConsentStore.markAllSatisfied`                               | ✅ Handled                       |
| `status_update`           | `setStatusMessage`                                                    | ✅ Handled                       |
| `status_clear`            | `setStatusMessage(null)`                                              | ✅ Handled                       |
| `session_health`          | `addObservatoryEvent`, `addLog`                                       | ✅ Handled                       |
| `tool_warnings`           | `addLog`, `setStatusMessage`                                          | ✅ Handled                       |
| `message_queued`          | `setStatusMessage`                                                    | ✅ Handled                       |
| `error`                   | `setLoading(false)`, `setError`                                       | ✅ Handled                       |
| `info`                    | `setIsConfigured`, `setStatusMessage`                                 | ✅ Handled                       |
| `agent_transfer_event`    | `addMessage`                                                          | ✅ Handled                       |
| `pong`                    | —                                                                     | ❌ **NOT handled** (to be added) |

### 7.2 Server Messages NOT Handled (No `case` in Switch)

These are sent by the runtime but have no handler in the client:

| Message Type          | Sent By Runtime         | Impact                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| `pong`                | `ServerMessages.pong()` | **To be added** (keepalive)                   |
| `session_ended`       | Session terminalization | Silently ignored — client shows stale session |
| `execution_queued`    | Execution coordinator   | No queue position feedback                    |
| `execution_started`   | Execution coordinator   | No execution started feedback                 |
| `execution_cancelled` | Execution coordinator   | No cancellation feedback                      |
| `execution_rejected`  | Execution coordinator   | No rejection feedback                         |
| `typing_start`        | Agent typing indicator  | No typing animation                           |
| `handoff_progress`    | Handoff in progress     | No handoff status feedback                    |
| `agent_switch`        | Multi-agent routing     | No agent switch notification                  |

**Out of scope for this change** — these are pre-existing gaps, not introduced by the relocation.

---

## 8. Type Changes Summary

| File                              | Type            | Change                    |
| --------------------------------- | --------------- | ------------------------- |
| `apps/runtime/src/types/index.ts` | `ClientMessage` | Add `\| { type: 'ping' }` |
| `apps/studio/src/types/index.ts`  | `ClientMessage` | Add `\| { type: 'ping' }` |
| `apps/studio/src/types/index.ts`  | `ServerMessage` | Add `\| { type: 'pong' }` |

**Already exists** (no changes needed):

- `apps/runtime/src/types/index.ts` — `ServerMessage` already has `{ type: 'pong' }` (line 400)
- `apps/runtime/src/websocket/events.ts` — `ServerMessages.pong()` factory exists (line 422-423)

---

## 9. File Change Matrix

| File                                                 | Change Type | Description                                                                                                            |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/page.tsx`                       | **Remove**  | Remove `WebSocketProvider` wrapper, remove `useRuntimeConfig`/`deriveDefaultWsUrl` imports                             |
| `apps/studio/src/App.tsx`                            | **Modify**  | Remove `useWebSocketContext` import, remove `isConnected`/`isReconnecting` from splash logic, remove "Connected" toast |
| `apps/studio/src/components/navigation/AppShell.tsx` | **Modify**  | Import `WebSocketProvider`, wrap `ChatWithDebugPanel` in it                                                            |
| `apps/studio/src/components/CommandPalette.tsx`      | **Modify**  | Replace `useWebSocketContext` with `useAvailableApps` hook + conditional session actions                               |
| `apps/studio/src/hooks/useAvailableApps.ts`          | **Create**  | New hook: HTTP-based app fetching (extracted from WebSocketContext)                                                    |
| `apps/studio/src/contexts/WebSocketContext.tsx`      | **Modify**  | Add keepalive interval (ping every 25s), add `pong` case to handleMessage, clean up keepalive on close                 |
| `apps/runtime/src/websocket/handler.ts`              | **Modify**  | Add `case 'ping': send(ws, ServerMessages.pong()); break;`                                                             |
| `apps/runtime/src/types/index.ts`                    | **Modify**  | Add `{ type: 'ping' }` to ClientMessage union                                                                          |
| `apps/studio/src/types/index.ts`                     | **Modify**  | Add `{ type: 'ping' }` to ClientMessage, `{ type: 'pong' }` to ServerMessage                                           |

**Dead code cleanup** (optional, separate commit):
| `apps/studio/src/components/abl/AgentSelector.tsx` | **Delete candidate** | Never imported anywhere |
| `apps/studio/src/components/abl/TestCaseList.tsx` | **Delete candidate** | Never imported anywhere |

---

## 10. Migration Safety

### 10.1 What Doesn't Change

- WS protocol (same subprotocol auth, same message types)
- WS URL derivation logic
- Reconnection strategy (3s interval, 5 max attempts)
- `handleMessage` behavior (same switch, same store writes)
- Session resume logic (`onopen` sends `resume_session`)
- Token refresh interaction (guard check prevents unnecessary reconnection)
- Server-side handler, auth, tenant resolution
- All 30+ non-chat pages (they never used WS)

### 10.2 What Changes

- WS lifecycle: scoped to Chat tab instead of entire app
- Splash screen: gates on auth state only (not WS connection)
- CommandPalette: app loading via standalone HTTP hook
- Session management commands (load/reset): only available during active chat
- New: application-level ping/pong keepalive

### 10.3 Rollback Plan

If issues are discovered:

1. Revert `page.tsx` to wrap `<App>` in `WebSocketProvider` again
2. Revert `App.tsx` splash logic to use `isConnected`
3. Revert `AppShell.tsx` to render `ChatWithDebugPanel` without wrapper
4. Keep the ping/pong changes (they're independently beneficial)

Each change is in a separate file with clear boundaries — no cross-cutting entanglement.

---

## 11. Testing Plan

### 11.1 Manual Verification

| Scenario                                   | Expected Behavior                               |
| ------------------------------------------ | ----------------------------------------------- |
| Login → browse projects                    | No WS connection in Network tab                 |
| Login → project → agents list              | No WS connection                                |
| Login → project → agent → Chat tab         | WS connects, "Connected" feedback in chat       |
| Chat tab → send message → receive response | Normal chat flow                                |
| Chat tab → idle 2 minutes                  | WS stays alive (ping/pong every 25s)            |
| Chat tab → navigate to Workflows           | WS disconnects cleanly                          |
| Workflows → back to Chat tab               | WS reconnects, session auto-resumes             |
| Chat tab → server restart                  | Reconnects within retry window, session resumes |
| Cmd+K → search apps                        | Works (HTTP-based, no WS needed)                |
| Splash screen on login                     | No WS dependency, shows auth loading only       |

### 11.2 Automated Tests

| Test                                  | Scope                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- |
| WebSocket keepalive ping/pong         | Unit test: verify ping sent every 25s, pong handled                    |
| Session resume after reconnect        | Integration: disconnect WS, reconnect, verify session state            |
| App renders without WebSocketProvider | Unit test: App.tsx renders splash → main without WS context            |
| CommandPalette fetches apps via HTTP  | Unit test: verify fetchApps works without WS                           |
| Handler ping response                 | Unit test: send `{ type: 'ping' }`, verify `{ type: 'pong' }` response |

---

## 12. Implementation Order

| Step | Commit Type        | Description                                                                                        | Risk                                                              |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | `feat(runtime)`    | Add `case 'ping'` to handler.ts + add `ping` to runtime ClientMessage type                         | **Zero** — additive, no behavior change for existing clients      |
| 2    | `feat(studio)`     | Add `ping`/`pong` types to studio types, add keepalive interval + pong handler to WebSocketContext | **Low** — additive, fixes proxy timeout for existing app-level WS |
| 3    | `refactor(studio)` | Create `useAvailableApps` hook, decouple CommandPalette from WS                                    | **Low** — HTTP was already used, just extracting                  |
| 4    | `refactor(studio)` | Decouple App.tsx from WS (splash screen, toast)                                                    | **Low** — 3s fallback already exists                              |
| 5    | `refactor(studio)` | Move WebSocketProvider from page.tsx to AppShell.tsx wrapping ChatWithDebugPanel                   | **Medium** — the main architectural change                        |
| 6    | `test(studio)`     | Add tests for keepalive, session resume, app rendering without WS                                  | **Zero** — test-only                                              |

Steps 1-2 can ship independently as an immediate fix for the proxy timeout issue, even before the full relocation.
