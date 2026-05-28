# SDLC Log: ws-relocation — Implementation Phase

**Feature**: WebSocket Relocation (App-Level to Chat-Tab-Level)
**Phase**: IMPLEMENTATION
**LLD**: `docs/plans/2026-04-13-ws-relocation-impl-plan.md`
**Date Started**: 2026-04-13
**Date Completed**: 2026-04-13 (no commits per user instruction)

---

## Preflight

- [x] LLD file paths verified
- [x] Function signatures current
- [x] No conflicting recent changes
- Discrepancies: none

## Phase Execution

### LLD Phase 1: Server-side keepalive (runtime)

- **Status**: DONE
- **Commit**: (no commit per user instruction)
- **Exit Criteria**: all met — `pnpm build --filter=@agent-platform/runtime` succeeds, `case 'ping'` present in handler switch, `ServerMessages.pong()` used
- **Deviations**: none
- **Files Changed**: 2
  - `apps/runtime/src/types/index.ts` — added `| { type: 'ping' }` to ClientMessage
  - `apps/runtime/src/websocket/handler.ts` — added `case 'ping': send(ws, ServerMessages.pong()); break;`

### LLD Phase 2: Client-side keepalive (studio)

- **Status**: DONE
- **Commit**: (no commit per user instruction)
- **Exit Criteria**: all met — studio typechecks clean, `case 'pong'` in handleMessage, keepalive interval starts on open, clears on close
- **Deviations**: none
- **Files Changed**: 2
  - `apps/studio/src/types/index.ts` — added `| { type: 'ping' }` to ClientMessage, `| { type: 'pong' }` to ServerMessage
  - `apps/studio/src/contexts/WebSocketContext.tsx` — added `WS_KEEPALIVE_INTERVAL_MS` constant, `keepaliveInterval` ref, interval start in `ws.onopen`, cleanup in `closeWs()`, `case 'pong'` handler

### LLD Phase 3: Decouple App.tsx from WebSocket

- **Status**: DONE
- **Commit**: (no commit per user instruction)
- **Exit Criteria**: all met — App.tsx no longer imports `useWebSocketContext`, splash is auth-only, no connected toast
- **Deviations**: Kept `connecting` i18n key instead of adding new `loading` key to avoid touching locale files
- **Files Changed**: 1
  - `apps/studio/src/App.tsx` — removed `useWebSocketContext` import/usage, simplified splash to auth-only gating, removed connected toast, simplified SplashScreen (removed `isReconnecting` prop and reconnecting state), removed unused imports (`toast`, `AnimatePresence`, `KoreWordmark`)

### LLD Phase 4: Decouple CommandPalette from WebSocket

- **Status**: DONE
- **Commit**: (no commit per user instruction)
- **Exit Criteria**: all met — CommandPalette imports `useAvailableApps` not `useWebSocketContext`, apps fetched via HTTP
- **Deviations**: Apps group navigates to chat tab on select (instead of calling `loadApp` which requires WS context). Reset session command removed from palette (requires WS context).
- **Files Changed**: 2
  - `apps/studio/src/hooks/useAvailableApps.ts` — NEW: HTTP-only hook with `AppInfo` type, `fetchApps`, `loading` state
  - `apps/studio/src/components/CommandPalette.tsx` — replaced `useWebSocketContext` with `useAvailableApps` + `useSessionStore`, app commands navigate to chat tab, removed `RotateCcw` unused import

### LLD Phase 5: Relocate WebSocketProvider

- **Status**: DONE
- **Commit**: (no commit per user instruction)
- **Exit Criteria**: all met — `page.tsx` has no WS provider, `AppShell.tsx` wraps `ChatWithDebugPanel` with `WebSocketProvider`, both packages typecheck clean
- **Deviations**: Had to pass `wsUrl` through `renderContent()` function parameter since it's a standalone function, not inside the `AppShell()` component body
- **Files Changed**: 2
  - `apps/studio/src/app/page.tsx` — removed `WebSocketProvider` dynamic import, `useRuntimeConfig`, `deriveDefaultWsUrl`, WS URL derivation, and provider wrapper
  - `apps/studio/src/components/navigation/AppShell.tsx` — added `WebSocketProvider`, `useRuntimeConfig`, `deriveDefaultWsUrl` imports; derived `wsUrl` in `AppShell()`; passed `wsUrl` to `renderContent()`; wrapped `ChatWithDebugPanel` in `WebSocketProvider`

## Wiring Verification

- [x] `WebSocketProvider` removed from `page.tsx`
- [x] `WebSocketProvider` added around `ChatWithDebugPanel` in `AppShell.tsx`
- [x] `useAvailableApps` hook created and imported in `CommandPalette.tsx`
- [x] `case 'ping'` added to runtime handler switch
- [x] `case 'pong'` added to studio handleMessage switch
- [x] Keepalive interval starts in `ws.onopen`, clears in `closeWs()`
- [x] Studio and runtime typecheck clean
- Missing wiring found: none

## Review Rounds

Not executed per user instruction (no commits).

## Acceptance Criteria

- [x] All LLD phases complete
- [ ] E2E tests passing (not run — no commits)
- [ ] Integration tests passing (not run — no commits)
- [x] No regressions: `tsc --noEmit` passes for both runtime and studio
- [ ] Feature spec files accurate (deferred to post-impl-sync)

## Summary

- 5 phases completed
- 9 files modified, 1 new file created
- 0 commits (per user instruction)
- Net change: -16 lines (78 insertions, 94 deletions)
- Key deviation: `loadApp`/`resetSession` removed from CommandPalette (require WS context) — apps command navigates to chat tab instead
