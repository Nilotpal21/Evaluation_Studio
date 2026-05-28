# Phase 5 (JIT Auth) Audit -- Iteration 1

**Date:** 2026-03-18
**Auditor:** LLD Reviewer Agent
**Scope:** Tasks 5.1-5.18, Scenarios IS-5.1 through IS-5.11
**Spec:** `docs/plans/AUTH-PROFILE-IMPLEMENTATION-ROADMAP.md` Phase 5

---

## VERDICT: NEEDS_CHANGES

---

## ISSUES

### CRITICAL

**C1. SDK handler missing `cleanupSession` on disconnect -- orphaned Promises and Redis keys**

The internal `handler.ts` (line 580-590) correctly calls `getPausedExecutionStore().cleanupSession(runtimeId)` on WS close. The SDK handler `sdk-handler.ts` does NOT call `cleanupSession` anywhere in its `ws.on('close')` handler (lines 545-663). This means SDK clients that disconnect during a JIT auth wait will leak in-memory Promises and Redis keys until TTL expiry.

This is the exact Phase 4 dual-handler parity gap pattern documented in agent memory.

- File: `apps/runtime/src/websocket/sdk-handler.ts` lines 545-663
- Fix: Add `getPausedExecutionStore().cleanupSession(runtimeSidForCleanup)` in the SDK handler's `close` handler, alongside the existing `cleanupAuthGate(runtimeSidForCleanup)` call at line 658.

---

**C2. No session ownership validation in `auth_response` handlers -- any client can resolve any paused execution**

Both `handler.ts` (line 2908-2922) and `sdk-handler.ts` (line 1521-1533) process `auth_response` messages by directly calling `store.resolve(toolCallId)` or `store.reject(toolCallId, ...)` using only the client-supplied `toolCallId`. Neither handler verifies that the WebSocket connection owns the session associated with the paused execution.

A malicious client that guesses or observes a `toolCallId` can resolve another session's paused execution, bypassing the OAuth requirement entirely.

This is the Phase 4 session ownership pattern documented in agent memory (`consent_satisfy` had the same issue).

- File: `apps/runtime/src/websocket/handler.ts` lines 2908-2922
- File: `apps/runtime/src/websocket/sdk-handler.ts` lines 1521-1533
- Fix: Before calling `store.resolve()` or `store.reject()`:
  1. Call `store.get(toolCallId)` to retrieve the `PausedExecutionData`.
  2. Compare `pausedData.sessionId` against the WS connection's `runtimeSessionId` (from `clients.get(ws)` or `sdkClients.get(ws)`).
  3. If mismatch or not found, silently ignore (do not log the toolCallId to avoid enumeration).

---

**C3. `jitMetadataMap` is an unbounded in-memory Map with no TTL or eviction**

`ToolOAuthService.jitMetadataMap` (line 236) is `new Map<string, JitOAuthMetadata>()` with no max size, no TTL, and no eviction. If many JIT flows are initiated but callbacks never arrive (user closes popup, network failure), entries accumulate indefinitely.

Platform invariant: every in-memory Map needs max size + TTL + eviction.

- File: `apps/runtime/src/services/tool-oauth-service.ts` line 236
- Fix: Either:
  (a) Piggyback on the `stateStore` TTL -- since `stateStore.getAndDelete(state)` is called on callback, and `InMemoryOAuthStateStore` cleans up expired states every 60s, have `clearJitMetadata` called from the cleanup cycle too. OR
  (b) Add a `MAX_JIT_METADATA_ENTRIES` constant (e.g., 10000), check size before `.set()`, and add a periodic cleanup that removes entries older than 10 minutes (matching the OAuth state TTL).

---

### HIGH

**H1. OAuth popup close detection assumes completion -- Phase 4 pattern repeat**

`AuthChallengeMessage.tsx` lines 69-83: When the popup closes, the component assumes completion and sends `auth_response: { status: 'completed' }`. This is exactly the Phase 4 false positive pattern -- the user could close the popup without completing OAuth, or the OAuth provider could show an error page that the user then closes.

The comment on line 72-73 says "the OAuth callback will have posted the auth_response via server" but there is no `window.postMessage` listener or server-side confirmation mechanism visible. If the OAuth callback doesn't fire (user denied consent), the client still sends `completed`.

- File: `apps/studio/src/components/chat/AuthChallengeMessage.tsx` lines 69-83
- Fix: Use `window.postMessage` from the OAuth callback page to signal success/failure to the opener. Only send `status: 'completed'` when the callback message is received. If popup closes without a message, send `status: 'cancelled'`.

---

**H2. JIT auth trigger condition relies on error message string matching**

`auth-profile-tool-middleware.ts` line 119: `errMsg.includes('AUTH_PROFILE_NOT_FOUND')` -- the JIT auth flow is triggered by pattern-matching on the error message string from `resolveToolAuth()`. This is fragile:

- If the error message changes, JIT auth silently stops working.
- If a different error coincidentally contains this substring, JIT auth fires incorrectly.

- File: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` line 119
- Fix: Use a typed error class (e.g., `AuthProfileNotFoundError`) or an error `code` property instead of string matching. Check `err instanceof AuthProfileNotFoundError` or `err.code === 'AUTH_PROFILE_NOT_FOUND'`.

---

**H3. IS-5.9 (non-OAuth profile with JIT) not implemented -- no guard for non-OAuth auth types**

The spec scenario IS-5.9 requires: "Auth profile is type `api_key` with `auth_jit: true` -> tool fails immediately with clear error: 'JIT auth is only supported for OAuth-type auth profiles'".

The middleware at `auth-profile-tool-middleware.ts` line 182 hardcodes `authType: 'oauth2'` regardless of the actual profile's auth type. There is no check that the auth profile is actually an OAuth type before attempting JIT. If someone sets `jit_auth: true` on an `api_key` profile, the middleware will send an `auth_challenge` with no `authUrl` (since `initiateJitOAuth` will return undefined for non-OAuth profiles), and the UI will show a disabled "Authorize" button that can never complete.

- File: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` lines 147-188
- Fix: Before sending `auth_challenge`, resolve the auth profile's type. If it's not an OAuth type (`oauth2`, `oauth2_client_credentials`), return an immediate error result instead of pausing:
  ```
  return { result: JSON.stringify({ error: 'JIT auth is only supported for OAuth-type auth profiles', code: 'JIT_NOT_SUPPORTED' }) };
  ```

---

**H4. `PausedExecutionStore.pending` Map has max size but no TTL-based eviction**

The `pending` Map (line 68) has `MAX_PAUSED_EXECUTIONS = 1000` but relies solely on `setTimeout` for individual entry cleanup. If timers are not firing (event loop saturation, process pause), entries could accumulate. There is no periodic sweep to evict entries whose `pausedAt + timeoutMs` has passed.

- File: `apps/runtime/src/services/auth-profile/paused-execution-store.ts` line 68
- Fix: Add a periodic sweep (e.g., every 60s) that checks `Date.now() > entry.data.pausedAt + entry.data.timeoutMs` and rejects stale entries. Use `setInterval` with `.unref()`.

---

### MEDIUM

**M1. Test for JIT metadata storage (jit-auth-oauth.test.ts line 89-102) has no assertions**

The test at line 89 "stores JIT metadata for the state" calls `initiateJitOAuth` but has no `expect()` assertions that verify the metadata was stored. The comment says "we can't easily get the state from the URL" but the next test (line 106) shows exactly how to extract the state and verify metadata. This is an empty test stub pattern from Phase 3 memory.

- File: `apps/runtime/src/__tests__/jit-auth-oauth.test.ts` lines 89-102
- Fix: Add assertions: extract state from URL, call `service.getJitMetadata(state)`, assert it equals `{ sessionId: 'session-abc', toolCallId: 'tc_xyz' }`.

---

**M2. No test for IS-5.5 (multiple concurrent JIT challenges)**

The spec scenario IS-5.5 describes two tools needing JIT auth simultaneously with independent challenge/response flows. No test verifies this. The `PausedExecutionStore` uses `toolCallId` as the Map key, which should support this, but it's untested.

- Fix: Add a test that pauses two tool executions with different toolCallIds, resolves them independently, and verifies each resumes correctly.

---

**M3. No test for OAuth callback -> resume signal (IS-5.10 race condition)**

The spec scenario IS-5.10 describes a race where the OAuth callback arrives before the `PausedExecutionStore` has finished writing. The `jit-auth-oauth.test.ts` tests only verify URL generation and metadata storage, not the callback -> resume -> tool retry flow.

- Fix: Add integration test that simulates: `initiateJitOAuth` -> `handleOAuthCallback` -> verify `getPausedExecutionStore().resolve()` is called with correct toolCallId.

---

**M4. `handleJitAuth` generates its own `toolCallId` instead of using the actual tool call ID**

Line 149 in `auth-profile-tool-middleware.ts`: `const toolCallId = 'jit-' + Date.now() + '-' + Math.random()...`. The spec (IS-5.1) shows `toolCallId: "tc_123"` suggesting the tool call's actual ID should be used. Using a synthetic ID means the `auth_response` from the client cannot be correlated back to the original LLM tool call, which may cause issues with tool result reporting.

- File: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` line 149
- Fix: If `ctx` contains the actual LLM `toolCallId`, use it. If not, the synthetic ID is acceptable but document why.

---

**M5. Studio `WebSocketContext` serializes auth_challenge as JSON string in message content**

The `auth_challenge` message (WebSocketContext.tsx line 446-461) is serialized to JSON and stored as the `content` string of a system message. `MessageList.tsx` then parses it back from JSON. This double-serialization is fragile -- if any field contains characters that break JSON parsing, the challenge silently fails to render.

A more robust approach would be to use a typed message discriminator (e.g., a `_metadata` field on the message object) rather than embedding structured data in a string field.

- File: `apps/studio/src/contexts/WebSocketContext.tsx` lines 446-461
- Severity: Medium (works but fragile)

---

## VERIFIED

- [x] **PausedExecutionStore core mechanics** -- Promise-based pause/resume works correctly. TTL via setTimeout with `.unref()`. Redis soft-fail pattern (operations wrapped in try/catch, log warnings). SCAN-based cleanup. Singleton pattern with test reset.
- [x] **WebSocket protocol types** -- `auth_challenge` ServerMessage and `auth_response` ClientMessage are correctly defined in `types/index.ts`. `parseClientMessage` validates `auth_response` fields (toolCallId required, status must be 'completed' or 'cancelled'). `ServerMessages.authChallenge()` factory produces correct structure.
- [x] **events.ts message creators** -- `auth_challenge` and `auth_response` are registered in both the type system and the parser switch/case.
- [x] **Tool middleware JIT flow** -- Correctly detects missing credentials, sends `auth_challenge`, pauses via store, handles timeout/cancel/success paths, retries with fresh credentials on resume.
- [x] **OAuth JIT initiation** -- `initiateJitOAuth` generates valid OAuth URL with state, stores JIT metadata for callback routing, returns undefined for unknown providers.
- [x] **Studio UI** -- `AuthChallengeMessage` renders correctly with profile name, countdown, authorize/cancel buttons. Countdown uses `Date.now()` delta (not decrement) for accuracy. Terminal states properly handled.
- [x] **Studio wiring** -- `MessageList.tsx` imports and renders `AuthChallengeMessage` for system messages with `_type: 'auth_challenge'`. `WebSocketContext.tsx` handles `auth_challenge` server message.
- [x] **Studio types** -- `auth_challenge` added to server message union in `apps/studio/src/types/index.ts`.
- [x] **handler.ts disconnect cleanup** -- `cleanupSession` called on WS close (Task 5.17).
- [x] **Error handling patterns** -- All `catch` blocks use `err instanceof Error ? err.message : String(err)`.
- [x] **Logging** -- Uses `createLogger('module')`, no `console.log/error`.
- [x] **Test coverage for core store** -- Pause/resolve/timeout/cancel/cleanup all tested with fake timers. Tests are substantive (no empty stubs except M1).
- [x] **Test coverage for protocol** -- Message creation, serialization, parsing, validation all tested.
- [x] **Test coverage for middleware** -- Pass-through, JIT trigger, timeout paths tested.
- [x] **Test coverage for OAuth** -- URL generation, metadata storage/retrieval tested.

---

## Scenario Coverage

| Scenario                             | Status          | Notes                                                                                    |
| ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| IS-5.1 Full JIT happy path           | Partial         | Middleware test covers pause->resolve->retry. Missing end-to-end OAuth callback->resume. |
| IS-5.2 JIT timeout                   | Covered         | Store test + middleware test both verify timeout.                                        |
| IS-5.3 JIT cancel                    | Covered         | Store test verifies cancel rejection.                                                    |
| IS-5.4 Second tool same conversation | Not tested      | Token caching after JIT not verified.                                                    |
| IS-5.5 Multiple pending tools        | Not tested      | See M2.                                                                                  |
| IS-5.6 Session disconnect            | Partial         | handler.ts cleanup tested conceptually. SDK handler missing (C1).                        |
| IS-5.7 SDK with custom handler       | Not tested      | No SDK client test.                                                                      |
| IS-5.8 SDK default handler           | Not tested      | No SDK client test.                                                                      |
| IS-5.9 Non-OAuth JIT                 | Not implemented | See H3.                                                                                  |
| IS-5.10 Race condition               | Not tested      | See M3.                                                                                  |
| IS-5.11 Concurrent sessions          | Not tested      | Relies on toolCallId scoping (reasonable).                                               |

---

## NOTES

1. **Task 5.18 (session-scoped token revocation)** is correctly documented as deferred in both the spec and the code (paused-execution-store.ts lines 291-304).

2. **Task 5.15-5.16 (SDK types/callback)**: The SDK handler processes `auth_response` messages (line 1521) but there is no evidence of an `onAuthChallenge` callback hook in an SDK client package. This may be intentional if the SDK client package is out of scope for this phase, but should be tracked.

3. **Redis pub/sub for callback->resume (Task 5.10)**: The spec says "callback publishes Redis event `jit-auth:complete:{sessionId}:{toolCallId}`" but the current implementation uses the in-memory `PausedExecutionStore.resolve()` directly from the WS handler. This works for single-pod but will fail in multi-pod: the OAuth callback HTTP request may hit a different pod than the one holding the paused Promise. The `jitMetadataMap` in `ToolOAuthService` is also pod-local. This is a fundamental architecture issue for production but may be acceptable for initial implementation if documented.

4. **`MAX_PAUSED_EXECUTIONS = 1000`** is reasonable for a single pod, but the error thrown on overflow is a generic `Error`, not a typed error. Consider using a specific error class for monitoring/alerting.

5. The `auth_profile_ref` is used as both `profileId` and `profileName` in the auth_challenge message (middleware line 150, 184). If the auth profile has a user-friendly display name distinct from its ref ID, the UI will show the ref ID instead.
