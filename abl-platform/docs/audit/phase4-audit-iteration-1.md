# Phase 4 Preflight Consent — Audit Iteration 1

**Date:** 2026-03-18
**Auditor:** LLD Reviewer Agent
**Spec:** `docs/plans/AUTH-PROFILE-IMPLEMENTATION-ROADMAP.md` (Phase 4, tasks 4.1-4.18, scenarios IS-4.1-IS-4.10)

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### [CRITICAL] C1: SDK handler never sends `auth_required` event on session init

The SDK handler (`apps/runtime/src/websocket/sdk-handler.ts`) imports `checkAuthPreflight` (line 77) but never calls it during session/agent initialization. The main WebSocket handler wires this at line 1180-1207 of `handler.ts`, but the SDK handler has no equivalent code path. This means:

- SDK clients never receive `auth_required` on `load_agent`
- The auth gate is never activated for SDK sessions
- `send_message` will never be gated (since `hasActiveAuthGate` returns false)
- Task 4.9 and scenario IS-4.9 are completely unfulfilled

**File:** `apps/runtime/src/websocket/sdk-handler.ts`
**Fix:** Wire `checkAuthPreflight` into the SDK session initialization path (wherever `runtimeSession` is created/loaded from compiled IR), send `ServerMessages.authRequired()` to the SDK WS, matching the pattern at `handler.ts:1180-1207`.

### [CRITICAL] C2: `authGateStates` Map has max size but no TTL or eviction timer

The in-memory Map at `apps/runtime/src/services/auth-profile/auth-preflight.ts:35` has `MAX_AUTH_GATE_ENTRIES = 10000` with FIFO eviction, but:

- **No TTL**: If a user opens a session, gets the consent gate, then abandons without disconnecting the WebSocket (e.g., mobile browser suspends), the entry lives forever until the WebSocket close handler fires.
- **No periodic eviction**: Platform invariant requires every in-memory Map to have max size + TTL + eviction.

**File:** `apps/runtime/src/services/auth-profile/auth-preflight.ts:35-38`
**Fix:** Add a `createdAt` timestamp to `AuthGateState`, add a named constant `AUTH_GATE_TTL_MS` (e.g., 30 minutes), and add a `setInterval`-based sweep (every 60s) that deletes entries older than TTL. Also store a module-level reference to the interval for cleanup on shutdown.

### [CRITICAL] C3: Unbounded message queue behind auth gate

`queueMessageBehindAuthGate()` (`auth-preflight.ts:141-156`) pushes messages to `state.queuedMessages` with no limit. A malicious or buggy client could send thousands of messages while the auth gate is active, causing OOM.

**File:** `apps/runtime/src/services/auth-profile/auth-preflight.ts:150`
**Fix:** Add `MAX_QUEUED_MESSAGES = 50` (or similar). If queue is full, return false and send an error to the client. Add a test for this limit.

---

### [HIGH] H1: Token lookups are hardcoded to always return false

The main handler wires `defaultLookups` that always return `false` for all three tiers (`handler.ts:1184-1188`). This means:

- Cross-session token reuse (IS-4.2, IS-4.6) will never work
- ConsentStateResolver's 3-tier logic is dead code in production
- Every session will always show the full consent UI, even if the user already authorized

**File:** `apps/runtime/src/websocket/handler.ts:1184-1188`
**Fix:** Wire actual token lookup functions that check the session token store, user-scoped token store (via contact identity), and tenant-scoped store. Document this as a known limitation if token stores don't exist yet, but at minimum add a TODO with a tracking reference so it's not silently forgotten.

### [HIGH] H2: `handleConsentSatisfy` does not validate session ownership

In `handler.ts:2944-2974`, the `consent_satisfy` handler extracts `sessionId` from the client message but does not verify that the WebSocket connection owns that session. A client could send `consent_satisfy` for another user's session.

**File:** `apps/runtime/src/websocket/handler.ts:2944-2974`
**Fix:** Verify `message.sessionId === clients.get(ws)?.runtimeSession?.id || clients.get(ws)?.runtimeSessionId`. Return 404 (not 403) if mismatch, per platform conventions.

### [HIGH] H3: `reset_session` does not clean up auth gate

When a user sends `reset_session` (handler.ts:1969), the session is reset but `cleanupAuthGate(sessionId)` is never called. The auth gate cleanup only happens on WebSocket `close` (handler.ts:593-596). This means after `reset_session`, the stale auth gate entry persists and could interfere with the new session if it reuses the same sessionId.

**File:** `apps/runtime/src/websocket/handler.ts:1969-1991`
**Fix:** Add `cleanupAuthGate(message.sessionId)` in `handleResetSession` before the session is reset.

### [HIGH] H4: `openOAuthPopup` always resolves `true` on popup close

In `useBatchOAuth.ts:59-66`, the poll interval resolves `true` unconditionally when `popup.closed` is detected. There is no mechanism to determine whether the OAuth flow actually succeeded or was cancelled/denied by the user. The comment says "In production, the popup callback would set this" but there is no implementation.

**File:** `apps/studio/src/hooks/useBatchOAuth.ts:59-66`
**Fix:** Implement a message-passing mechanism: the OAuth callback page should `window.opener.postMessage({ type: 'oauth_complete', success: true/false, authProfileRef })`, and the popup poller should listen for this message. Without this, `onFailed` callback is never triggered for denied OAuth flows.

---

### [MEDIUM] M1: `BatchConsentGate` `sendMessage` prop uses loose `Record<string, unknown>` type

**File:** `apps/studio/src/components/auth-profiles/BatchConsentGate.tsx:17`
**Fix:** Type as `(msg: { type: 'consent_satisfy'; sessionId: string; authProfileRef: string }) => void` for type safety.

### [MEDIUM] M2: `handleContinue` callback is a no-op

In `BatchConsentGate.tsx:64-67`, `handleContinue` is an empty callback. The "Continue" button in the panel is wired to it but does nothing. The gate deactivation is supposed to happen via `auth_gate_satisfied` WS event, but there's no logic to manually dismiss the gate when the user clicks Continue after all connectors are connected.

**File:** `apps/studio/src/components/auth-profiles/BatchConsentGate.tsx:64-67`
**Fix:** If all connectors are in `connected` state (locally), `handleContinue` should either send a signal to the runtime or optimistically deactivate the local gate. Currently the button is enabled but does nothing.

### [MEDIUM] M3: `useBatchOAuth` `isConnecting` reads a ref directly (not reactive)

`isConnecting: connectingRef.current` at line 128 returns the ref value at render time but won't trigger re-renders when `connectAll` starts/finishes. The value will always be `false` when initially read.

**File:** `apps/studio/src/hooks/useBatchOAuth.ts:128`
**Fix:** Use `useState` for `isConnecting` instead of a ref, or track it in the Zustand store.

### [MEDIUM] M4: No test for auth gate eviction at capacity

The `MAX_AUTH_GATE_ENTRIES` eviction logic at `auth-preflight.ts:105-110` is not covered by any test. The test file (`auth-preflight.test.ts`) does not test the max capacity scenario.

**File:** `apps/runtime/src/__tests__/auth-preflight.test.ts`
**Fix:** Add a test that creates `MAX_AUTH_GATE_ENTRIES + 1` gates and verifies the oldest is evicted.

### [MEDIUM] M5: i18n key count (24 in spec vs 22 actual)

Spec task 4.18 calls for 24 i18n keys in `auth_profiles.batch_consent.*`. The actual file has 22 keys. The missing keys appear to be for the description text shown below the connector list and the "progress_complete" variant.

**File:** `packages/i18n/locales/en/studio.json`
**Fix:** Verify all UI strings in the three components reference existing keys. The `description` key exists but is not used in `BatchConsentPanel.tsx`. The `progress_complete` key exists but is not used. Either wire them in or remove them. Add any actually missing keys.

### [MEDIUM] M6: `connectAll` captures stale `connectors` array via closure

In `useBatchOAuth.ts:108-123`, `connectAll` depends on `connectors` from the options, but this is the array at the time the hook was called. If a connector's status changes during the sequential flow (e.g., from 'failed' to 'connected' by the server), the `pending` filter on line 112 uses stale data.

**File:** `apps/studio/src/hooks/useBatchOAuth.ts:108-123`
**Fix:** Read connectors from the store inside `connectAll` instead of using the closure: `const pending = useBatchConsentStore.getState().connectors.filter(...)`.

---

## VERIFIED

- [x] **Auth requirement collection** (Task 4.1-4.4) -- `AuthRequirementIR` type added to `schema.ts:651-666`, `collectAuthRequirements` deduplicates by `auth_profile_ref`, merges scopes, preflight takes precedence over inline. Wired into `compiler.ts:469-473`. 9 tests cover dedup, multi-agent, connector binding, default connection_mode.
- [x] **DSL parsing** (Task 4.2) -- `connection:` and `consent:` properties parsed in `tool-file-parser.ts:494-503`, mapped to AST `connectionMode`/`consentMode` in `agent-based.ts:533-535`.
- [x] **IR schema fields** -- `auth_profile_ref`, `jit_auth`, `connection_mode`, `consent_mode` on `ToolDefinition` in `schema.ts:634-643`. `auth_requirements` on `CompilationOutput` at line 1944.
- [x] **WebSocket protocol** -- `auth_required`, `auth_gate_updated`, `auth_gate_satisfied` events defined in `types/index.ts:426-440`, factory functions in `events.ts:326-344`, `consent_satisfy` client message type at `types/index.ts:319`.
- [x] **Auth gate blocks only `send_message`** -- `hasActiveAuthGate` check in `handler.ts:1448` (send_message) and `sdk-handler.ts:1491`. `reset_session` and `cancel_execution` handlers have no auth gate check (correct per IS-4.5).
- [x] **Queued messages replay** -- `satisfyConnector` returns `queuedMessages`, handler replays them via `handleSendMessage` at `handler.ts:2960-2967`.
- [x] **ConsentStateResolver 3-tier lookup** -- `consent-state-resolver.ts` implements session -> user -> tenant lookup with correct gating (tenant only for `shared` connection_mode). Error handling returns `satisfied: false` (not throws). 7 tests cover all tiers + error path + priority.
- [x] **Cleanup on disconnect** -- `cleanupAuthGate(runtimeId)` called in `ws.on('close')` at `handler.ts:594-596`.
- [x] **Studio store** -- `batch-consent-store.ts` is session-scoped (no `persist`), 5 connector states, all transitions, `getPending` correctly includes `authorizing` and `failed`.
- [x] **Studio components** -- `BatchConsentGate` wraps children, `BatchConsentPanel` has progress bar + connector list + footer, `ConsentConnectorRow` has all 5 states with correct icons and buttons.
- [x] **i18n namespace** -- 22 keys under `auth_profiles.batch_consent.*` in `packages/i18n/locales/en/studio.json:7713-7737`.
- [x] **ChatPanel wiring** -- `BatchConsentGate` wraps the message list + chat input at `ChatPanel.tsx:224-254`.
- [x] **WebSocketContext wiring** -- `auth_required`, `auth_gate_updated`, `auth_gate_satisfied` handled at `WebSocketContext.tsx:447-459`, correctly calling store actions.
- [x] **Error handling pattern** -- `err instanceof Error ? err.message : String(err)` used correctly in consent-state-resolver, auth-preflight handler catch blocks.
- [x] **Logging** -- `createLogger('auth-preflight')` and `createLogger('consent-state-resolver')` used, no `console.log/error`.
- [x] **Express route ordering** -- N/A (WebSocket message types, not Express routes).
- [x] **No `any` in new code** -- Checked all new files; `(record as any)` in handler.ts line 1248 is pre-existing, not part of this phase.

---

## Scenario Coverage

| Scenario                              | Status          | Notes                                                                                        |
| ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- |
| IS-4.1 (full happy path)              | Partial         | Works for main WS handler; SDK handler missing (C1). Token lookups hardcoded false (H1).     |
| IS-4.2 (existing tokens skip consent) | Not working     | Token lookups always false (H1).                                                             |
| IS-4.3 (Connect All sequential)       | Partial         | Sequential logic correct, but popup always resolves true (H4).                               |
| IS-4.4 (mixed consent modes)          | Covered         | `collectAuthRequirements` filters to `preflight` only. Inline tools excluded.                |
| IS-4.5 (auth gate blocks messages)    | Covered         | `send_message` blocked; `reset_session`/`cancel_execution` pass through. Queue replay works. |
| IS-4.6 (consent persistence)          | Not working     | Token lookups always false (H1).                                                             |
| IS-4.7 (scope dedup)                  | Covered         | Compiler deduplicates scopes in `collectAuthRequirements`.                                   |
| IS-4.8 (timeout/abandon)              | Partial         | Cleanup on WS close works. No TTL on auth gate Map (C2).                                     |
| IS-4.9 (SDK preflight)                | Not implemented | SDK handler missing auth preflight wiring (C1).                                              |
| IS-4.10 (zero preflight)              | Covered         | Returns null from `checkAuthPreflight`, `BatchConsentGate` renders children.                 |

---

## Summary of Required Changes

| Priority | Count | Description                                                                                             |
| -------- | ----- | ------------------------------------------------------------------------------------------------------- |
| CRITICAL | 3     | SDK auth preflight missing, Map has no TTL, unbounded message queue                                     |
| HIGH     | 4     | Token lookups dead, session ownership not validated, reset doesn't cleanup, OAuth popup always succeeds |
| MEDIUM   | 6     | Type safety, no-op continue, stale ref, missing tests, i18n count, stale closure                        |

---

## Notes for Implementation

1. **C1 is the top priority** -- without SDK auth preflight, the SDK path is completely broken for preflight consent. This needs to be wired in the same code sprint.
2. **H1 (token lookups)** -- if the actual token stores don't exist yet, document this as a Phase 4 gap and create a stub that at least checks Redis for session-scoped tokens. The 3-tier resolver is well-designed but currently untestable in integration.
3. **H4 (OAuth popup)** -- this is a common pattern problem. Consider using `window.addEventListener('message', ...)` with origin validation for the popup callback, which is how the existing `AuthProfileOAuthDialog` works.
4. **C2/C3 are standard platform invariant violations** caught by the checklist. Simple fixes.
