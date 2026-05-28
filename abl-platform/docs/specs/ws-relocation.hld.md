# HLD: WebSocket Relocation (App-Level → Chat-Tab-Level)

**Feature Spec**: `docs/features/sub-features/ws-relocation.md`
**Test Spec**: `docs/testing/sub-features/ws-relocation.md`
**Design Doc**: `docs/superpowers/specs/2026-04-13-ws-relocation-design.md`
**Status**: APPROVED (implemented with deviations -- see Post-Implementation Notes)
**Author**: Platform Team
**Date**: 2026-04-13

---

## 1. Problem Statement

The Studio app opens a WebSocket connection to the runtime (`/ws`) immediately on user login, regardless of whether the user is on a page that needs real-time communication. This creates three measurable problems:

1. **Phantom connection cycling**: The infrastructure proxy (`agents-dev.kore.ai`) enforces a ~60-second idle timeout and does not count WebSocket control frames as activity. After ~56 seconds of no data frames, the proxy kills the connection. The client auto-reconnects, the `reconnectAttempts` counter resets to 0 on every successful `onopen` (`WebSocketContext.tsx:758`), and the cycle repeats indefinitely. Users see 6+ accumulated WS connections in Chrome DevTools.

2. **Wasted server resources**: Users browsing projects, editing agents, or viewing analytics all hold WS connections that serve zero purpose. Each connection consumes a `ClientState` slot (max 10,000 in `WebSocketConnectionManager`), JWT verification, tenant context resolution, and heartbeat sweep participation.

3. **Missing application-level keepalive**: The SDK handler (`sdk-handler.ts:2337`) has `case 'ping'` → `pong` data frames. The internal Studio handler (`handler.ts:1456`) does not — its 18 message types exclude `ping`. Protocol-level heartbeat (`ws.ping()` control frames in `heartbeat.ts:32`) doesn't survive L7 proxies.

**Quantified impact**: With 50 authenticated users, the current design creates 50 WS connections, all cycling every ~56 seconds. After relocation, only users on the Chat tab (~10) maintain connections, and those connections are stable (no cycling).

---

## 2. Alternatives Considered

### Option A: Keep App-Level WS + Add Keepalive Only

- **Description**: Leave `WebSocketProvider` at the app root. Only add application-level `ping`/`pong` keepalive to prevent proxy timeouts.
- **Pros**: Minimal code change (3 files). Fixes the connection cycling immediately. No risk of breaking component tree access.
- **Cons**: Does NOT fix wasted resources — all authenticated users still hold a WS connection regardless of page. Does NOT improve app load time (splash screen still gates on WS). ~50 idle connections remain.
- **Effort**: S

### Option B: Relocate WS to Chat Tab + Add Keepalive (RECOMMENDED)

- **Description**: Move `WebSocketProvider` from `page.tsx` to `AppShell.tsx` wrapping `ChatWithDebugPanel`. Decouple `App.tsx` and `CommandPalette` from WS context. Add keepalive ping/pong.
- **Pros**: Fixes all three problems — no phantom cycling, no wasted connections, app loads faster. Connections exist only when needed. Keepalive prevents proxy timeout during active chat. Clean architecture (WS scoped to its only consumer subtree).
- **Cons**: Requires decoupling 2 app-level components. Session resume tested on navigate-away-and-back. More files changed (9 files).
- **Effort**: M

### Option C: Relocate WS to Project Level

- **Description**: Move `WebSocketProvider` to wrap the entire project area (all pages within a project).
- **Pros**: Simplifies "future" features that might need WS outside chat (none exist today).
- **Cons**: Still wastes connections on agent editor, workflows, sessions list, settings, analytics — 30+ non-chat pages within a project. Doesn't solve the resource waste problem for the vast majority of pages. All 7 live WS consumers are in the Chat tab, not spread across project pages.
- **Effort**: M (same as B, but less effective)

### Recommendation: Option B

**Rationale**: A consumer audit confirmed all 7 live `useWebSocketContext()` consumers sit inside `ChatWithDebugPanel`. Option B targets exactly the right scope. Option A fixes cycling but not resource waste. Option C is over-scoped — no non-chat page within a project uses WS today, and designing for hypothetical future requirements violates YAGNI. The session detach/resume mechanism (`handler.ts:152` default `detach`, `handleResumeSession` 3-tier lookup) already supports the navigate-away-and-back pattern that Option B introduces.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                       Browser (Studio)                    │
│                                                          │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────┐  │
│  │   App.tsx    │   │ CommandPal. │   │  AppShell.tsx │  │
│  │ (auth only)  │   │  (HTTP only) │   │              │  │
│  │ NO WS ──────────── NO WS ──────────┤              │  │
│  └─────────────┘   └─────────────┘   │  ┌──────────┐│  │
│                                       │  │ Chat Tab ││  │
│                                       │  │┌────────┐││  │
│                                       │  ││WS Prov.│││  │
│                                       │  ││ ping   │││  │
│                                       │  ││ 25s    │◄┼──┼── keepalive
│                                       │  │└───┬────┘││  │
│                                       │  └────┼─────┘│  │
│                                       └───────┼──────┘  │
│                                               │ WS      │
└───────────────────────────────────────────────┼─────────┘
                                                │
                    ┌───────────────────────────┐│
                    │    L7 Proxy (agents-dev)   ││
                    │    idle timeout: ~60s      ◄┘
                    │    data frames reset timer │
                    └───────────┬───────────────┘
                                │ WS
                    ┌───────────▼───────────────┐
                    │      Runtime (/ws)         │
                    │  ┌─────────────────────┐  │
                    │  │   handler.ts          │  │
                    │  │  case 'ping' → pong  │  │
                    │  │  case 'load_agent'   │  │
                    │  │  case 'send_message' │  │
                    │  │  case 'resume_sess.' │  │
                    │  │  ... (20 cases)      │  │
                    │  └─────────────────────┘  │
                    │                            │
                    │  ┌──────────┐ ┌─────────┐ │
                    │  │ Sessions │ │ Redis   │ │
                    │  │ (Memory) │ │ (Cache) │ │
                    │  └──────────┘ └─────────┘ │
                    │  ┌──────────────────────┐ │
                    │  │    MongoDB (Persist)  │ │
                    │  └──────────────────────┘ │
                    └───────────────────────────┘
```

### Component Diagram

```
BEFORE:                              AFTER:
─────────────                        ─────────────

page.tsx                             page.tsx
└── WebSocketProvider ◄── WS HERE    └── App.tsx (auth-only)
    └── App.tsx                          └── AppShell.tsx
        └── AppShell.tsx                     ├── ProjectDashboard (NO WS)
            ├── ProjectDashboard             ├── AgentEditor (NO WS)
            ├── AgentEditor                  ├── Workflows (NO WS)
            ├── Workflows                    ├── Sessions (NO WS)
            ├── Sessions                     ├── Settings (NO WS)
            ├── Settings                     ├── ... 30+ pages (NO WS)
            ├── ... 30+ pages                │
            │                                └── if tab === 'chat':
            └── ChatWithDebugPanel               WebSocketProvider ◄── WS HERE
                ├── SessionSidebar                   └── ChatWithDebugPanel
                ├── StudioChatPanel                      ├── SessionSidebar
                └── DebugTabs                            ├── StudioChatPanel
                                                         └── DebugTabs
```

### Data Flow

**Connection lifecycle (after relocation):**

```
1. User navigates to Chat tab
   └── AppShell.tsx:586 renders <WebSocketProvider>
       └── WebSocketContext useEffect triggers
           └── doConnect() → new WebSocket(url, subprotocol)
               └── Server: handleConnection() → auth, tenant resolution
                   └── ws.onopen → reconnectAttempts = 0
                       └── if sessionId exists: send resume_session
                           └── Server: handleResumeSession → 3-tier lookup
                               └── session_resumed → client restores state

2. During active chat (idle or chatting)
   └── setInterval(ping, 25000)
       └── Client sends { type: 'ping' } (data frame)
           └── Proxy counts as activity, resets idle timer
               └── Server: case 'ping' → send(ws, ServerMessages.pong())
                   └── Client: case 'pong' → no-op

3. User navigates away from Chat tab
   └── React unmounts WebSocketProvider
       └── useEffect cleanup → closeWs()
           └── clearInterval(keepaliveInterval)
               └── ws.close()
                   └── Server: ws.on('close')
                       └── disconnectBehavior: 'detach' (default)
                           └── Session stays alive, detached from WS
```

### Sequence Diagram: Navigate Away and Resume

```
Browser (Chat Tab)           L7 Proxy          Runtime
─────────────────           ─────────          ───────
     │                          │                  │
     │── WS OPEN ──────────────►──────────────────►│ handleConnection()
     │◄─ agent_loaded ─────────◄──────────────────◄│
     │── send_message ─────────►──────────────────►│ handleSendMessage()
     │◄─ response_start ───────◄──────────────────◄│
     │◄─ response_chunk ×N ────◄──────────────────◄│
     │◄─ response_end ─────────◄──────────────────◄│
     │                          │                  │
     │── ping (every 25s) ─────►──────────────────►│ case 'ping' → pong
     │◄─ pong ─────────────────◄──────────────────◄│
     │                          │                  │
 [USER NAVIGATES AWAY]         │                  │
     │── ws.close() ───────────►──────────────────►│ ws.on('close')
     │                          │                  │  └── detach session
     X (WebSocketProvider       │                  │
        unmounted)              │                  │
                                │                  │
 [USER RETURNS TO CHAT]        │                  │
     │                          │                  │
     │── WS OPEN (new) ────────►──────────────────►│ handleConnection()
     │── resume_session ────────►──────────────────►│ handleResumeSession()
     │                          │                  │  └── 3-tier lookup:
     │                          │                  │      memory → Redis → DB
     │◄─ session_resumed ──────◄──────────────────◄│
     │   (full state + history) │                  │
     │                          │                  │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Tenant Isolation**    | Unchanged. `resolveWSTenantContext()` runs on every new WS connection, extracting tenantId from JWT. The relocation does not alter the auth or tenant resolution flow. `ensureWsSessionAccess()` validates tenant + user ownership on `resume_session`. Cross-tenant access returns `session_expired`.                                                       |
| 2   | **Data Access Pattern** | No new data access. Session detach/resume uses existing 3-tier lookup (in-memory → Redis → MongoDB). `WebSocketConnectionManager` tracks active connections in-memory. No new caching layers introduced.                                                                                                                                                     |
| 3   | **API Contract**        | One additive change: runtime `/ws` handler accepts `{ type: 'ping' }` and responds with `{ type: 'pong' }`. This mirrors the existing SDK handler behavior (`sdk-handler.ts:2337`). No existing message types change. No breaking changes. Client-side type unions extended with `ping`/`pong`.                                                              |
| 4   | **Security Surface**    | Auth mechanism unchanged — JWT in WS subprotocol (`web-debug-auth,<token>`). Ping/pong messages carry no auth data, no PII, no session state — they are empty data frames. The `ping` handler executes after the auth gate (`handler.ts:1436-1444`), so unauthenticated connections cannot send pings. No new input validation needed (ping has no payload). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | No new error paths. If `ping` arrives on an unauthenticated connection, the existing auth gate rejects it before reaching the switch. If `pong` is received with no active keepalive, the `case 'pong': break;` handler silently ignores it. WS connection errors use existing `onclose` → reconnect logic (3s interval, 5 attempts).                                                                                      |
| 6   | **Failure Modes** | **Proxy kills connection despite keepalive**: Only if keepalive interval exceeds proxy timeout — mitigated by 25s interval vs 60s timeout (2.4x safety margin). **Session lost on resume**: 3-tier lookup fails only if all of memory, Redis, AND DB lose the session — extremely unlikely. **React unmount race**: `closeWs()` nulls event handlers before closing, preventing stale `onclose` from triggering reconnect. |
| 7   | **Idempotency**   | Ping/pong is inherently idempotent — sending multiple pings is harmless. `resume_session` is also idempotent — calling it on an already-active session returns the current state. `closeWs()` is safe to call multiple times (guards against null `wsRef`).                                                                                                                                                                |
| 8   | **Observability** | No new trace events. Existing `ws-handler` logger logs connect/disconnect. After relocation, connect/disconnect events correlate with Chat tab navigation (higher frequency but lower total count). `ws-heartbeat` logger will emit fewer "Terminating unresponsive WebSocket client" warnings because keepalive prevents false positives.                                                                                 |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Connection setup**: ~5-50ms per new WS (JWT verify + tenant resolution, cached per-user). Acceptable for Chat tab navigation frequency (~1-5 times per session). **Keepalive overhead**: 40 bytes every 25 seconds per active chat — 1.6 bytes/sec. **Connection reduction**: From N (all authenticated users) to M (Chat tab users only), where M << N.                                                                                                                                                                                                                                                                                                        |
| 10  | **Migration Path**     | Two-phase deployment: **Phase 1** (keepalive only, zero risk): Add `case 'ping'` to handler + add keepalive interval. Ships independently, fixes proxy timeout. **Phase 2** (relocation): Move provider, decouple App.tsx + CommandPalette. Can ship in a single deployment. No data migration. No feature flags needed — changes are structurally isolated.                                                                                                                                                                                                                                                                                                      |
| 11  | **Rollback Plan**      | Revert 3 files to restore original behavior: `page.tsx` (add WebSocketProvider back), `App.tsx` (restore isConnected check), `AppShell.tsx` (remove WebSocketProvider wrapper). Keepalive changes (handler.ts, WebSocketContext.tsx, types) are independently beneficial and should be kept even on rollback. Each file has clear single-purpose changes.                                                                                                                                                                                                                                                                                                         |
| 12  | **Test Strategy**      | **Unit (10 scenarios)**: Ping/pong handler, keepalive interval lifecycle, App.tsx without WS, CommandPalette HTTP fetch, type validation. **Integration (7 scenarios)**: Real WS server — ping/pong roundtrip, session detach/resume, cross-user/cross-tenant isolation, keepalive cleanup. **E2E (7 scenarios)**: Playwright — no WS on dashboard, connects on Chat tab, disconnects on nav, session resume, keepalive over 60s, app load without WS, multi-navigation cycles. **Regression (5 existing tests)**: Auth refresh, transport, heartbeat, handler, tenant isolation. No mocking of codebase components — all integration/E2E tests use real servers. |

---

## 5. Data Model

### New Collections/Tables

None. No database schema changes.

### Modified Collections/Tables

None. No field additions, no index changes.

### Key Relationships

Type-level changes only (TypeScript union extensions):

| File                              | Type            | Change                    | Backward Compatible         |
| --------------------------------- | --------------- | ------------------------- | --------------------------- |
| `apps/runtime/src/types/index.ts` | `ClientMessage` | Add `\| { type: 'ping' }` | Yes — additive union member |
| `apps/studio/src/types/index.ts`  | `ClientMessage` | Add `\| { type: 'ping' }` | Yes — additive union member |
| `apps/studio/src/types/index.ts`  | `ServerMessage` | Add `\| { type: 'pong' }` | Yes — additive union member |

Already exists (no change needed):

- `apps/runtime/src/types/index.ts` — `ServerMessage` already has `{ type: 'pong' }` (line 400)
- `apps/runtime/src/websocket/events.ts` — `ServerMessages.pong()` factory exists (line 422-423)

---

## 6. API Design

### New Endpoints

None. No new HTTP or WS endpoints.

### Modified Endpoints

| Endpoint                    | Change                                                     | Backward Compatible                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS `/ws` (internal handler) | Add `case 'ping': send(ws, ServerMessages.pong()); break;` | Yes — unknown message types were previously silently dropped (no `default` case), so old clients sending `ping` would have been ignored. Now they get a response. |

### Error Responses

No new error codes. Ping/pong uses the existing message protocol. If ping is sent on an unauthenticated connection, the existing auth gate returns: `{ type: 'error', message: 'Authentication required. Please sign in first.' }`

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No changes. WS connect/disconnect events already logged by `ws-handler` logger. No new auditable actions.
- **Rate Limiting**: No changes. Ping messages are not rate-limited (40 bytes/25s is negligible). Existing WS message rate limits apply to all message types equally.
- **Caching**: No changes. Tenant context resolution cache is per-user, already exists. Session 3-tier lookup cache (memory → Redis → DB) is unchanged.
- **Encryption**: No changes. WS runs over WSS (TLS) in production. Ping/pong payloads contain no sensitive data.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                        | Type            | Risk                                                                                                            |
| ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| Auth store (`useAuthStore`)                       | Runtime data    | LOW — `accessToken` subscription unchanged. Guard check prevents reconnection on token refresh.                 |
| Session store (`useSessionStore`)                 | Runtime data    | LOW — `sessionId` read for `resume_session` on reconnect. Store interface unchanged.                            |
| Runtime WS handler (`handler.ts`)                 | Server endpoint | LOW — Additive change (new case in switch). No modification to existing cases.                                  |
| `ServerMessages.pong()` factory (`events.ts:422`) | Server utility  | ZERO — Already exists, used by SDK handler.                                                                     |
| `resolveWSTenantContext()`                        | Server auth     | ZERO — Called on every WS connect. Unchanged.                                                                   |
| `handleResumeSession()` + 3-tier lookup           | Server session  | ZERO — Existing functionality. No modifications.                                                                |
| L7 proxy configuration                            | Infrastructure  | LOW — Keepalive fix works regardless of proxy config. 25s interval provides 2.4x safety margin for 60s timeout. |

### Downstream (depends on this feature)

| Consumer                           | Impact                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `StudioChatPanel`                  | NONE — stays inside WebSocketProvider tree                                    |
| `SessionSidebar`                   | NONE — stays inside WebSocketProvider tree                                    |
| `OverviewTab` / `TestContextPanel` | NONE — stays inside WebSocketProvider tree                                    |
| `useStudioTransport`               | NONE — stays inside WebSocketProvider tree                                    |
| `AuthChallengeMessage`             | NONE — stays inside WebSocketProvider tree                                    |
| `App.tsx` (splash screen)          | CHANGED — no longer reads `isConnected`, gates on auth only                   |
| `CommandPalette`                   | CHANGED — uses new `useAvailableApps` HTTP hook, session commands conditional |

---

## 9. Open Questions & Decisions Needed

1. **Proxy timeout configurability**: Is the ~60s idle timeout on `agents-dev.kore.ai` configurable? Increasing to 120s alongside the 25s keepalive would provide a larger safety margin. Not a blocker — keepalive works regardless.
2. **Connection status UX in Chat tab**: After removing the splash screen WS gating, should a "Connecting..." indicator appear inside the Chat panel during WS setup (~50-200ms)? `StudioChatPanel` already reads `isConnected` — just needs verification that the existing UI handles the brief connecting state gracefully.
3. **Keepalive constant vs config**: The 25s keepalive interval is hardcoded as a constant. Should it be configurable via environment variable for deployments with different proxy timeouts? Current recommendation: hardcode — it's a protocol-level detail, not a user-facing setting.

---

## 10. References

- Feature spec: `docs/features/sub-features/ws-relocation.md`
- Test spec: `docs/testing/sub-features/ws-relocation.md`
- Design doc: `docs/superpowers/specs/2026-04-13-ws-relocation-design.md`
- Runtime heartbeat: `apps/runtime/src/websocket/heartbeat.ts`
- SDK ping handler: `apps/runtime/src/websocket/sdk-handler.ts:2337`
- Internal WS handler: `apps/runtime/src/websocket/handler.ts`
- Studio WS context: `apps/studio/src/contexts/WebSocketContext.tsx`
- Session lifecycle policy: `apps/runtime/src/services/session-lifecycle/runtime-policy-service.ts`
- Connection manager: `apps/runtime/src/websocket/connection-manager.ts`

---

## Post-Implementation Notes (2026-04-14)

The WS relocation was implemented across 7 commits under ABLP-333. Significant deviations from the HLD:

1. **Keepalive reverted**: The application-level ping/pong keepalive (HLD Section 3 Option B) was implemented in the initial commit but reverted during the hardening follow-up. The internal `/ws` handler no longer has `case 'ping'`, and the Studio client has no keepalive interval. This means the original problem of L7 proxy idle timeouts killing internal Studio WS connections remains unsolved for active chat sessions. The relocation reduces the number of affected connections (only chat tab users) but does not prevent the timeout cycle.

2. **SDK heartbeat removed**: The browser SDK `SessionManager` JSON heartbeat timer was removed entirely. Connection liveness is now owned by the server-side protocol-level WebSocket heartbeat (`ws.ping()` control frames). A legacy compatibility shim (`sendLegacyPong`) was added to the SDK handler for older published SDK bundles.

3. **CommandPalette partial decoupling**: Instead of full WS independence, `CommandPalette` uses `useOptionalWebSocketContext` (a new safe variant that returns null outside the provider tree) plus the `useAvailableApps` HTTP hook. Session-dependent commands are conditionally hidden when WS context is unavailable.

4. **New utility files**: `app-graph-loader.ts` was extracted as a standalone app graph loading utility. `useAvailableApps.ts` was created as a new HTTP-based hook.

5. **Type changes were net-zero**: All planned type additions (`ping`/`pong` members) were added then removed. The `pong` member was also removed from the runtime `ServerMessage` union and `ServerMessages.pong()` factory was deleted.
