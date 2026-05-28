# LLD: WebSocket Relocation (App-Level → Chat-Tab-Level)

**Feature Spec**: `docs/features/sub-features/ws-relocation.md`
**HLD**: `docs/specs/ws-relocation.hld.md`
**Test Spec**: `docs/testing/sub-features/ws-relocation.md`
**Status**: DONE (implemented with deviations -- keepalive reverted in hardening)
**Date**: 2026-04-13

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                | Rationale                                                                                                                                                                        | Alternatives Rejected                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D-1 | Add `case 'ping'` before `case 'action_submit'` in handler switch                                       | Groups keepalive with low-cost operations. Mirrors SDK handler placement.                                                                                                        | Adding at end of switch (no functional difference, but less readable)                 |
| D-2 | Store keepalive interval ref alongside `wsRef` and `reconnectTimeout` in WebSocketContext               | Follows existing ref pattern for timer management. Cleanup in `closeWs()` mirrors `reconnectTimeout` cleanup.                                                                    | Separate `useEffect` for keepalive (adds complexity, harder to coordinate with close) |
| D-3 | Extract `useAvailableApps` as standalone hook using existing `fetchApps` HTTP logic                     | `fetchApps` already calls `fetch('/api/agents/apps')` — zero WS dependency. Extract preserves behavior exactly.                                                                  | Keeping fetchApps in WS context and adding a separate provider (over-engineered)      |
| D-4 | CommandPalette reads `loadApp`/`resetSession` from session store conditional check, not from WS context | After relocation, WS context only exists in Chat tab. CommandPalette is app-level — it cannot access WS context. Session-dependent commands are disabled when no active session. | Creating a second WS provider at app level (defeats the purpose of relocation)        |
| D-5 | `WebSocketProvider` wraps `ChatWithDebugPanel` inline in AppShell render, not as a separate component   | Minimal change. AppShell already has the conditional `if (tab === 'chat')`. Adding the wrapper is 3 lines.                                                                       | Creating a `ChatTabWrapper` component (unnecessary abstraction for a single use)      |
| D-6 | 25s keepalive as module-level constant, not env var                                                     | Protocol-level implementation detail. Not user-facing. Consistent across all deployments.                                                                                        | Env var `WS_KEEPALIVE_INTERVAL_MS` (over-configurable for an internal constant)       |
| D-7 | Phase 1 (keepalive) is independently deployable before Phase 2-5 (relocation)                           | Keepalive fixes proxy timeout immediately with zero risk. Relocation is a separate concern.                                                                                      | Single deployment (higher risk, no incremental value)                                 |

### Key Interfaces & Types

```typescript
// apps/runtime/src/types/index.ts — ClientMessage union extension
export type ClientMessage =
  | { type: 'load_agent' /* ... existing */ }
  // ... existing members ...
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' }
  | { type: 'ping' }; // NEW — keepalive request

// apps/studio/src/types/index.ts — ClientMessage union extension
export type ClientMessage =
  | { type: 'load_agent' /* ... existing */ }
  // ... existing members ...
  | { type: 'auth_response'; toolCallId: string; status: 'completed' | 'cancelled' }
  | { type: 'ping' }; // NEW — keepalive request

// apps/studio/src/types/index.ts — ServerMessage union extension
export type ServerMessage =
  | { type: 'agent_loaded' /* ... existing */ }
  // ... existing members ...
  | { type: 'pong' }; // NEW — keepalive response (already exists in runtime types)

// apps/studio/src/hooks/useAvailableApps.ts — NEW hook
// AppInfo shape must match WebSocketContext.tsx lines 31-37 exactly
interface AppInfo {
  name: string;
  domain: string; // projectId
  entryAgent: string;
  agentCount: number;
}
interface UseAvailableAppsReturn {
  availableApps: AppInfo[];
  fetchApps: () => Promise<void>;
  loading: boolean;
}
```

### Module Boundaries

| Module                          | Responsibility                                                 | Depends On                                                    |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `handler.ts` (runtime)          | Responds to `ping` with `pong`                                 | `ServerMessages.pong()` factory (existing)                    |
| `WebSocketContext.tsx` (studio) | Sends ping every 25s, handles pong, cleans up interval         | `wsRef`, `closeWs()` (existing)                               |
| `useAvailableApps.ts` (studio)  | HTTP fetch of `/api/agents/apps`                               | `authHeaders()` from auth utils (existing)                    |
| `AppShell.tsx` (studio)         | Wraps `ChatWithDebugPanel` in `WebSocketProvider`              | `WebSocketProvider`, `deriveDefaultWsUrl`, `useRuntimeConfig` |
| `page.tsx` (studio)             | Renders `App` without WS wrapper                               | None (removes dependency)                                     |
| `App.tsx` (studio)              | Splash screen gates on auth only                               | `useAuthStore` (existing)                                     |
| `CommandPalette.tsx` (studio)   | Uses `useAvailableApps` hook, conditionalizes session commands | `useAvailableApps`, `useSessionStore`                         |

---

## 2. File-Level Change Map

### New Files

| File                                        | Purpose                                                                            | LOC Estimate |
| ------------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| `apps/studio/src/hooks/useAvailableApps.ts` | Standalone HTTP hook for fetching available apps (extracted from WebSocketContext) | ~35          |

### Modified Files

| File                                                 | Change Description                                                                                                                   | Risk                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `apps/runtime/src/types/index.ts`                    | Add `\| { type: 'ping' }` to `ClientMessage` union (line ~248)                                                                       | Low — additive union member                                 |
| `apps/runtime/src/websocket/handler.ts`              | Add `case 'ping': send(ws, ServerMessages.pong()); break;` before `action_submit` (~line 1553)                                       | Low — one new case, no existing cases modified              |
| `apps/studio/src/types/index.ts`                     | Add `\| { type: 'ping' }` to `ClientMessage` (line ~455), add `\| { type: 'pong' }` to `ServerMessage` (after last member)           | Low — additive union members                                |
| `apps/studio/src/contexts/WebSocketContext.tsx`      | Add keepalive interval ref, start interval in `ws.onopen`, add `case 'pong': break;` to handleMessage, clear interval in `closeWs()` | Med — modifying core WS lifecycle, but changes are additive |
| `apps/studio/src/App.tsx`                            | Remove `useWebSocketContext` import, remove `isConnected`/`isReconnecting` from splash logic, remove connected toast                 | Med — changes app-level gating behavior                     |
| `apps/studio/src/components/CommandPalette.tsx`      | Replace `useWebSocketContext` with `useAvailableApps` + `useSessionStore`, conditionalize session commands                           | Med — changes data source                                   |
| `apps/studio/src/app/page.tsx`                       | Remove `WebSocketProvider` wrapper, remove `deriveDefaultWsUrl` import                                                               | Med — structural change to component tree                   |
| `apps/studio/src/components/navigation/AppShell.tsx` | Import `WebSocketProvider` + `deriveDefaultWsUrl`, wrap `ChatWithDebugPanel` in provider                                             | Med — structural change to component tree                   |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Server-Side Keepalive (Runtime)

**Goal**: Runtime `/ws` handler responds to `{ type: 'ping' }` with `{ type: 'pong' }`.

**Tasks**:

1.1. Add `| { type: 'ping' }` to `ClientMessage` union in `apps/runtime/src/types/index.ts` (after the `auth_response` member, line ~248)

1.2. Add `case 'ping'` to the message switch in `apps/runtime/src/websocket/handler.ts` (before `case 'action_submit'`, ~line 1553):

```typescript
case 'ping':
  send(ws, ServerMessages.pong());
  break;
```

1.3. Verify `ServerMessages.pong()` factory exists at `events.ts:422-423` (already confirmed — no change needed)

**Files Touched**:

- `apps/runtime/src/types/index.ts` — add `| { type: 'ping' }` to ClientMessage
- `apps/runtime/src/websocket/handler.ts` — add `case 'ping'` to switch

**Exit Criteria**:

- [ ] `pnpm build --filter=runtime` succeeds with 0 errors
- [ ] TypeScript accepts `{ type: 'ping' }` as a valid `ClientMessage`
- [ ] Runtime handler responds with `{ type: 'pong' }` when sent `{ type: 'ping' }` over WS
- [ ] All existing tests pass: `pnpm test --filter=runtime -- --run ws-handler` and `pnpm test --filter=runtime -- --run ws-heartbeat`

**Test Strategy**:

- Unit: `ws-ping-pong.test.ts` — verify `send(ws, ServerMessages.pong())` is called when handler receives `{ type: 'ping' }`. Use the same real-server pattern as existing `ws-handler.test.ts`.

**Rollback**: Remove the 2-line case statement and the type union member. Zero side effects.

---

### Phase 2: Client-Side Keepalive (Studio)

**Goal**: Studio WS client sends `{ type: 'ping' }` every 25s and handles `{ type: 'pong' }` responses.

**Tasks**:

2.1. Add `| { type: 'ping' }` to studio `ClientMessage` and `| { type: 'pong' }` to studio `ServerMessage` in `apps/studio/src/types/index.ts`

2.2. Add `case 'pong': break;` to the `handleMessage` switch in `WebSocketContext.tsx` (after the last existing case, before the implicit fall-through)

2.3. Add a module-level constant and ref for the keepalive interval in `WebSocketContext.tsx`:

```typescript
const WS_KEEPALIVE_INTERVAL_MS = 25_000;
```

Add `keepaliveInterval` ref alongside existing `reconnectTimeout` ref:

```typescript
const keepaliveInterval = useRef<ReturnType<typeof setInterval> | null>(null);
```

2.4. Start keepalive interval in `ws.onopen` callback (after `reconnectAttempts.current = 0`, line ~758):

```typescript
// Start keepalive to survive L7 proxy idle timeouts
if (keepaliveInterval.current) clearInterval(keepaliveInterval.current);
keepaliveInterval.current = setInterval(() => {
  if (wsRef.current?.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify({ type: 'ping' }));
  }
}, WS_KEEPALIVE_INTERVAL_MS);
```

2.5. Clear keepalive interval in `closeWs()` (after `clearTimeout(reconnectTimeout.current)`, line ~690):

```typescript
if (keepaliveInterval.current) {
  clearInterval(keepaliveInterval.current);
  keepaliveInterval.current = null;
}
```

**Files Touched**:

- `apps/studio/src/types/index.ts` — add `ping` to ClientMessage, `pong` to ServerMessage
- `apps/studio/src/contexts/WebSocketContext.tsx` — keepalive ref, interval start/stop, `case 'pong'`

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] TypeScript accepts `{ type: 'ping' }` as studio `ClientMessage` and `{ type: 'pong' }` as studio `ServerMessage`
- [ ] Client sends `{ type: 'ping' }` data frames at 25-second intervals when WS is OPEN
- [ ] `case 'pong'` in handleMessage does not throw or trigger state mutations
- [ ] Keepalive interval is cleared when `closeWs()` is called
- [ ] Existing auth refresh regression test passes: `pnpm test --filter=studio -- --run websocket-auth-refresh-regression`

**Test Strategy**:

- Unit: `ws-keepalive.test.ts` — verify interval starts on open, sends ping, clears on close. Use `vi.useFakeTimers` for deterministic timing. Verify pong handler is a no-op.

**Rollback**: Remove keepalive ref, interval logic, and type additions. Revert to pre-keepalive state. No data to clean up.

---

### Phase 3: Decouple App.tsx from WebSocket

**Goal**: `App.tsx` splash screen gates on auth state only, with no dependency on `WebSocketContext`.

**Tasks**:

3.1. In `apps/studio/src/App.tsx`:

- Remove `import { useWebSocketContext } from './contexts/WebSocketContext';` (line 17)
- Remove `const { isConnected, isReconnecting } = useWebSocketContext();` (line 42)

  3.2. Change splash screen conditional (line 155) from:

```typescript
if (authLoading || (showSplash && isAuthenticated && !isConnected)) {
```

to:

```typescript
if (authLoading || showSplash) {
```

3.3. Replace the splash dismiss effect (lines 73-78) from:

```typescript
useEffect(() => {
  if (!authLoading && (isConnected || !isAuthenticated)) {
    const timer = setTimeout(() => setShowSplash(false), isConnected ? 500 : 0);
    return () => clearTimeout(timer);
  }
}, [isConnected, authLoading, isAuthenticated]);
```

to:

```typescript
useEffect(() => {
  if (!authLoading) {
    const timer = setTimeout(() => setShowSplash(false), isAuthenticated ? 500 : 0);
    return () => clearTimeout(timer);
  }
}, [authLoading, isAuthenticated]);
```

3.4. Remove the connected toast effect (lines 87-91):

```typescript
// Remove entirely:
useEffect(() => {
  if (isConnected && !showSplash) {
    toast.success(t('connected_toast'), { duration: 2000 });
  }
}, [isConnected, showSplash, t]);
```

3.5. Update `SplashScreen` component: remove `isReconnecting` prop usage. The splash screen always shows the loading state (never "reconnecting" since there's nothing to reconnect at app level).

Change the SplashScreen call (line 156) from:

```typescript
return <SplashScreen isReconnecting={isReconnecting} isAuthLoading={authLoading} />;
```

to:

```typescript
return <SplashScreen isAuthLoading={authLoading} />;
```

Update the `SplashScreen` component signature and body (lines 226-269):

- Remove `isReconnecting` from props
- Remove the `isReconnecting` conditional branch (the `WifiOff` animation)
- Keep only the loading branch

  3.6. Remove unused imports: `WifiOff` from lucide-react (if no longer used elsewhere in App.tsx). Keep `Loader2`.

**Files Touched**:

- `apps/studio/src/App.tsx` — remove WS dependency, simplify splash logic

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] App.tsx does not import `useWebSocketContext` or `WebSocketContext`
- [ ] Splash screen dismisses based on `authLoading` → `false` transition only
- [ ] No "Connected to server" toast on app load
- [ ] Existing tests pass: `pnpm test --filter=studio -- --run`

**Test Strategy**:

- Unit: `app-no-ws-dependency.test.ts` — render App without WebSocketProvider in tree, verify it renders splash → main content based on auth state only.

**Rollback**: Restore the `useWebSocketContext()` call and splash conditions. 1 file, self-contained.

---

### Phase 4: Decouple CommandPalette from WebSocket

**Goal**: `CommandPalette` fetches apps via HTTP hook and conditionalizes session commands on session store.

**Tasks**:

4.1. Create `apps/studio/src/hooks/useAvailableApps.ts`:

```typescript
import { useState, useCallback } from 'react';
import { authHeaders } from '../lib/api-client';

interface AppInfo {
  name: string;
  /** projectId — used as URL param to /api/agents/apps/:projectId */
  domain: string;
  entryAgent: string;
  agentCount: number;
}

interface UseAvailableAppsReturn {
  availableApps: AppInfo[];
  fetchApps: () => Promise<void>;
  loading: boolean;
}

export function useAvailableApps(): UseAvailableAppsReturn {
  const [availableApps, setAvailableApps] = useState<AppInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/agents/apps', {
        headers: authHeaders(),
      });
      const data = await response.json();
      if (data.success && data.apps) {
        setAvailableApps(data.apps);
      }
    } catch (err) {
      if (process.env.NODE_ENV === 'development') console.error('[API] Failed to fetch apps:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  return { availableApps, fetchApps, loading };
}
```

4.2. Update `apps/studio/src/components/CommandPalette.tsx`:

- Replace `import { useWebSocketContext } from '../contexts/WebSocketContext';` with `import { useAvailableApps } from '../hooks/useAvailableApps';`
- Replace `const { availableApps, loadApp, resetSession, fetchApps } = useWebSocketContext();` with:
  ```typescript
  const { availableApps, fetchApps } = useAvailableApps();
  const sessionId = useSessionStore((s) => s.sessionId);
  ```
- For `loadApp` and `resetSession` commands in the command list: wrap them in a `sessionId` check. When no active session exists, these commands are hidden or disabled. The actual `loadApp` and `resetSession` functionality will only be available from within the Chat tab (where WS context exists).

  4.3. Verify the `AppInfo` type matches the existing shape returned by `WebSocketContext.availableApps`. Read `WebSocketContext.tsx` to confirm the shape of `availableApps` state.

**Files Touched**:

- `apps/studio/src/hooks/useAvailableApps.ts` — NEW
- `apps/studio/src/components/CommandPalette.tsx` — replace WS dependency

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] CommandPalette does not import `useWebSocketContext` or `WebSocketContext`
- [ ] CommandPalette renders available apps from HTTP fetch
- [ ] Session-dependent commands (loadApp, resetSession) are hidden when no active session
- [ ] `fetchApps` is called on palette open (same behavior as before)

**Test Strategy**:

- Unit: `use-available-apps.test.ts` — verify HTTP fetch, loading state, error handling.
- Unit: `command-palette-no-ws.test.ts` — render CommandPalette without WebSocketProvider, verify it renders apps and conditionalizes session commands.

**Rollback**: Delete `useAvailableApps.ts`, restore CommandPalette's `useWebSocketContext` import. 2 files.

---

### Phase 5: Relocate WebSocketProvider

**Goal**: `WebSocketProvider` wraps `ChatWithDebugPanel` in `AppShell.tsx` instead of the entire app in `page.tsx`.

**Tasks**:

5.1. Update `apps/studio/src/app/page.tsx`:

- Remove the `WebSocketProvider` dynamic import (lines 11-14):
  ```typescript
  // DELETE:
  const WebSocketProvider = dynamic(
    () => import('@/contexts/WebSocketContext').then((m) => ({ default: m.WebSocketProvider })),
    { ssr: false },
  );
  ```
- Remove `import { deriveDefaultWsUrl } from '@/utils/derive-ws-url';` (line 8)
- Remove `import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';` (line 7) — only if not used elsewhere in the file
- Remove `const { wsUrl: configWsUrl } = useRuntimeConfig();` (line 78) and `const wsUrl = deriveDefaultWsUrl(configWsUrl);` (line 79)
- Change the JSX from:

  ```tsx
  <SWRConfig value={swrConfig}>
    <WebSocketProvider url={wsUrl}>
      <App />
    </WebSocketProvider>
  </SWRConfig>
  ```

  to:

  ```tsx
  <SWRConfig value={swrConfig}>
    <App />
  </SWRConfig>
  ```

  5.2. Update `apps/studio/src/components/navigation/AppShell.tsx`:

- Add imports at the top:
  ```typescript
  import { WebSocketProvider } from '@/contexts/WebSocketContext';
  import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
  import { deriveDefaultWsUrl } from '@/utils/derive-ws-url';
  ```
- Inside the component, derive the WS URL:
  ```typescript
  const { wsUrl: configWsUrl } = useRuntimeConfig();
  const wsUrl = deriveDefaultWsUrl(configWsUrl);
  ```
- Wrap the Chat tab render (lines 586-588) from:

  ```tsx
  if (tab === 'chat') {
    return <ChatWithDebugPanel />;
  }
  ```

  to:

  ```tsx
  if (tab === 'chat') {
    return (
      <WebSocketProvider url={wsUrl}>
        <ChatWithDebugPanel />
      </WebSocketProvider>
    );
  }
  ```

  5.3. Verify that `useRuntimeConfig` is available in `AppShell` (it must be within the `RuntimeConfigProvider` tree — check `page.tsx` or `_app.tsx` provider chain).

**Files Touched**:

- `apps/studio/src/app/page.tsx` — remove WebSocketProvider wrapper
- `apps/studio/src/components/navigation/AppShell.tsx` — add WebSocketProvider around ChatWithDebugPanel

**Exit Criteria**:

- [ ] `pnpm build --filter=studio` succeeds with 0 errors
- [ ] No WS connection opens on login/dashboard/agent-editor/workflows/settings pages
- [ ] WS connection opens when navigating to Chat tab
- [ ] WS connection closes when navigating away from Chat tab
- [ ] Session resumes when returning to Chat tab (if sessionId exists in store)
- [ ] All 7 WS consumers (`SessionSidebar`, `StudioChatPanel`, `OverviewTab`, `TestContextPanel`, `useStudioTransport`, `AuthChallengeMessage`, + the context itself) function correctly inside the Chat tab
- [ ] Auth refresh regression test passes: `pnpm test --filter=studio -- --run websocket-auth-refresh-regression`
- [ ] At most 1 WS connection exists at any time — verified via Playwright `page.on('websocket')` counting in E2E-7 (3 cycles, only 1 OPEN at a time)
- [ ] "New Chat" on same agent reuses existing WS (no close/reopen) — `resetSession` message sent over same connection
- [ ] Switching agents on Chat tab reuses existing WS — `load_agent` message sent over same connection

**Test Strategy**:

- E2E: Full Playwright suite (E2E-1 through E2E-7) — verify no WS on dashboard, connects on chat, disconnects on nav, session resume, keepalive, app load without WS, navigation cycles.
- Integration: `ws-session-detach-resume.test.ts` — verify session survives WS close and can be resumed.

**Dependencies**: Phase 3 (App.tsx decoupled) and Phase 4 (CommandPalette decoupled) MUST be complete before Phase 5. If the provider is moved before these components are decoupled, they will crash calling `useWebSocketContext()` outside the provider tree.

**Rollback**: Restore `WebSocketProvider` in `page.tsx`, remove from `AppShell.tsx`. 2 files. Keepalive changes (Phase 1-2) are preserved and independently beneficial.

---

## 3b. Connection Lifecycle Guarantees

After relocation, the WebSocket connection lifecycle is scoped to `WebSocketProvider` mounted inside the Chat tab render path in `AppShell.tsx`. These invariants are enforced by the existing `WebSocketContext.tsx` code and must be preserved:

### Single-Connection Guarantee

At most ONE WebSocket connection exists at any time. Enforced by three guards:

1. **Pre-connect cleanup** (`handler.ts:737`): `closeWs()` is called before every `doConnect()`, terminating any existing connection
2. **Open guard** (`WebSocketContext.tsx:733`): If `readyState === OPEN && url === url`, the effect returns early — no duplicate connection
3. **Connecting guard** (`WebSocketContext.tsx:746-751`): If `readyState === OPEN || readyState === CONNECTING`, `doConnect()` returns early

### WS Close Events

The WebSocket closes in exactly these scenarios:

| Trigger                                | Code Path                                                                            | Behavior                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Navigate away from Chat tab            | React unmounts `WebSocketProvider` → cleanup effect (`line 722-725`) → `closeWs()`   | WS closes, handlers nulled, server sees `ws.on('close')` → `detach` session |
| Navigate to non-agent page             | Same as above — `tab !== 'chat'` causes unmount                                      | Same as above                                                               |
| User logs out                          | `LOGOUT_SIGNAL_EVENT` listener (`line 708-713`) → `closeWs()`                        | WS closes, auth state cleared                                               |
| Connection error (5 attempts exceeded) | `ws.onclose` (`line 772-791`) — reconnect counter exhausted                          | WS stays closed, `setError('Failed to connect')`                            |
| Token change while CONNECTING          | Guard at `line 733` fails → `closeWs()` at `line 737` → `doConnect()` with new token | Old WS closed, new WS opened with fresh token                               |

### "New Chat" Scenarios

| User Action                                             | WS Behavior                                                   | Session Behavior                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Click "New Chat" on same agent                          | WS stays OPEN (same provider mounted)                         | `resetSession()` sends `{ type: 'reset_session' }` over existing WS                         |
| Switch to different agent's Chat tab                    | WS stays OPEN (same `tab === 'chat'`, provider stays mounted) | `loadAgent()` sends `{ type: 'load_agent' }` for new agent over existing WS                 |
| Navigate to Overview tab then to different agent's Chat | WS closes on tab change (unmount), new WS opens on remount    | Server detaches old session; new mount sends `load_agent` for new agent                     |
| Navigate to Workflows page then back to Chat            | WS closes on page change (unmount), new WS opens on remount   | Server detaches session; if `sessionId` exists in store, `resume_session` sent on reconnect |

### Close Cleanup Safety

`closeWs()` (`line 688-701`) is safe to call multiple times and prevents stale callbacks:

1. Clears reconnect timeout
2. **Nulls all event handlers** (`onopen`, `onclose`, `onerror`, `onmessage`) BEFORE calling `ws.close()`
3. Sets `wsRef.current = null`

This means even if the browser fires `onclose` asynchronously after the component unmounts, the handler is null — no stale state mutations, no zombie reconnection loops.

### Keepalive Cleanup

The keepalive interval (Phase 2) is cleared in `closeWs()` alongside the reconnect timeout:

- `clearInterval(keepaliveInterval.current)` runs before `ws.close()`
- No pings are sent after the connection closes
- No `setInterval` leak on unmount

---

## 4. Wiring Checklist

- [x] New service registered in DI container / module exports — N/A (no new services)
- [x] New routes registered in router file — N/A (no new routes)
- [x] New models added to database index — N/A (no new models)
- [x] New types exported from package index — `ping` in ClientMessage, `pong` in ServerMessage (both inline union members, no separate export needed)
- [x] New middleware added to middleware chain — N/A
- [x] New workers registered in worker startup — N/A
- [x] UI components imported and rendered in parent components — `WebSocketProvider` imported in `AppShell.tsx` (moved from `page.tsx`)
- [x] New API endpoints documented in OpenAPI spec — N/A (WS message, not HTTP endpoint)
- [x] New hook (`useAvailableApps`) imported in `CommandPalette.tsx` — Phase 4, task 4.2
- [x] `WebSocketProvider` removed from `page.tsx` — Phase 5, task 5.1
- [x] `WebSocketProvider` added to `AppShell.tsx` wrapping `ChatWithDebugPanel` — Phase 5, task 5.2
- [x] `wsUrl` derivation moved from `page.tsx` to `AppShell.tsx` — Phase 5, tasks 5.1 + 5.2
- [x] `useRuntimeConfig` accessible in `AppShell` (within provider tree) — Phase 5, task 5.3

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes.

### Feature Flags

None. Two-phase deployment (keepalive first, relocation second) provides safe rollout without flags.

### Configuration Changes

No new environment variables. No new config keys. The keepalive interval (25s) is a module-level constant in `WebSocketContext.tsx`.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 5 phases complete with exit criteria met
- [ ] FR-1: Zero WS connections on non-chat pages (verified via Playwright network interception)
- [ ] FR-2: WS connects when Chat tab opens
- [ ] FR-3: WS closes when navigating away from Chat tab
- [ ] FR-4: Session auto-resumes on return to Chat tab
- [ ] FR-5: Runtime handler responds `{ type: 'pong' }` to `{ type: 'ping' }`
- [ ] FR-6: Client sends ping every 25 seconds
- [ ] FR-7: Client handles pong without error
- [ ] FR-8: Splash screen gates on auth only
- [ ] FR-9: CommandPalette fetches apps via HTTP
- [ ] FR-10: Keepalive interval cleaned up on WS close
- [ ] All 5 existing regression tests pass (auth-refresh, transport, heartbeat, handler, tenant-isolation)
- [ ] `pnpm build` succeeds with 0 errors across all affected packages
- [ ] `pnpm test --filter=runtime --filter=studio` passes

---

## 7. Open Questions

1. **`useRuntimeConfig` availability in AppShell**: Need to verify that `RuntimeConfigProvider` is above `AppShell` in the component tree. If not, `wsUrl` derivation needs an alternative source (e.g., reading from window or a config context that IS available). Quick check: `page.tsx` renders `<App />` which renders `<AppShell />`. If `RuntimeConfigContext` is provided in `_app.tsx` or `page.tsx`, it's available. To be verified during Phase 5 implementation.

2. **`availableApps` type shape**: The exact shape of `AppInfo` in the `useAvailableApps` hook needs to match what `WebSocketContext` currently stores. Read `WebSocketContext.tsx` state initialization during Phase 4 implementation to confirm field names.

3. **`loadApp`/`resetSession` in CommandPalette after decouple**: These functions call `send()` over WS. After removing WS dependency from CommandPalette, these commands should either (a) navigate to Chat tab first then invoke, or (b) be hidden entirely when not on Chat tab. Current plan: hide when no active session. Exact UX to be determined during Phase 4.
