# Phase 5 (JIT Auth) — Audit Iteration 2

**Date**: 2026-03-18
**Auditor**: Claude Opus 4.6 (Lead Architect Agent)
**Scope**: Verify 3 critical + 4 high fixes from iteration 1, check for remaining issues
**Verdict**: **PASS**

---

## Fix Verification Summary

| ID         | Severity | Finding                                            | Status   |
| ---------- | -------- | -------------------------------------------------- | -------- |
| CRITICAL-1 | Critical | SDK handler missing cleanupSession on disconnect   | VERIFIED |
| CRITICAL-2 | Critical | No session ownership validation in auth_response   | VERIFIED |
| CRITICAL-3 | Critical | jitMetadataMap unbounded                           | VERIFIED |
| HIGH-1     | High     | OAuth popup close assumes completion               | VERIFIED |
| HIGH-2     | High     | JIT trigger uses fragile string matching           | VERIFIED |
| HIGH-3     | High     | Non-OAuth auth profiles not guarded                | VERIFIED |
| HIGH-4     | High     | PausedExecutionStore.pending has no periodic sweep | VERIFIED |

---

## Detailed Verification

### CRITICAL-1: SDK handler missing cleanupSession on disconnect

**File**: `apps/runtime/src/websocket/sdk-handler.ts` (lines 655-665)
**Status**: VERIFIED

The disconnect handler now calls `getPausedExecutionStore().cleanupSession(runtimeId)` with the correct session ID derived from `state.runtimeSessionId || state.runtimeSession?.id`. The call is properly `.catch()`-guarded with a warning log. This matches the equivalent fix in `handler.ts` (lines 580-590).

### CRITICAL-2: No session ownership validation in auth_response handlers

**Files**: `apps/runtime/src/websocket/handler.ts` (lines 2915-2926), `apps/runtime/src/websocket/sdk-handler.ts` (lines 1539-1549)
**Status**: VERIFIED

Both handlers now validate session ownership before processing `auth_response`:

1. **handler.ts**: Gets `clientSessionId` from `clients.get(ws)` state, calls `store.get(toolCallId)` to get `pausedData`, and compares `pausedData.sessionId !== clientSessionId`. On mismatch, logs a warning and returns early.
2. **sdk-handler.ts**: Same pattern using `state.runtimeSessionId || state.runtimeSession?.id`. On mismatch, logs and breaks.

Both implementations correctly guard against cross-session spoofing. The check `if (pausedData && clientSessionId && pausedData.sessionId !== clientSessionId)` is correct — it allows the call through if either `pausedData` is null (store.resolve/reject will handle the miss) or `clientSessionId` is null (defensive, won't happen in practice).

### CRITICAL-3: jitMetadataMap unbounded

**File**: `apps/runtime/src/services/tool-oauth-service.ts` (lines 233-697)
**Status**: VERIFIED

All four required mitigations are in place:

1. **MAX size**: `MAX_JIT_METADATA_ENTRIES = 1000` (line 234). Checked in `initiateJitOAuth` (line 606) before inserting.
2. **TTL**: `JIT_METADATA_TTL_MS = 10 * 60 * 1000` (line 237). Checked in `getJitMetadata` (line 644) — expired entries return null and are deleted.
3. **Periodic cleanup**: `JIT_METADATA_CLEANUP_INTERVAL_MS = 60_000` (line 240). Timer created in constructor (line 268), unref'd to avoid keeping process alive. `cleanupExpiredJitMetadata()` sweeps entries older than TTL.
4. **LRU eviction**: `evictOldestJitMetadata()` (line 690) evicts 10% of capacity when at max, sorted by `createdAt` ascending (oldest first).

The `destroy()` method (line 660) clears the timer and the map.

### HIGH-1: OAuth popup close assumes completion

**File**: `apps/studio/src/components/chat/AuthChallengeMessage.tsx` (lines 66-108)
**Status**: VERIFIED

The fix implements two complementary mechanisms:

1. **postMessage callback**: Listens for `window.postMessage` with `type: 'oauth_complete'` and matching `toolCallId` (line 74). Only on receipt is `oauthCompletedRef` set to true and `auth_response` sent with `status: 'completed'`.
2. **Popup close polling**: A `setInterval` (500ms) checks `popupRef.current?.closed` (line 92). If closed AND `oauthCompletedRef.current` is false, state transitions to `'cancelled'` and `auth_response` is sent with `status: 'cancelled'`.
3. **Origin validation**: `event.origin !== window.location.origin` check (line 73) prevents cross-origin spoofing.

### HIGH-2: JIT trigger uses fragile string matching

**Files**: `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts` (lines 20-38), `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` (line 120)
**Status**: VERIFIED

- `AuthProfileNotFoundError` class is defined with typed properties: `code = 'AUTH_PROFILE_NOT_FOUND'`, `profileName`, `toolName`, `jitAuth` (resolve-tool-auth.ts lines 20-38).
- The middleware uses `err instanceof AuthProfileNotFoundError` (line 120) instead of string matching.
- The error is thrown from `resolveToolAuth` when `!profile` (line 107): `throw new AuthProfileNotFoundError(profileName, tool.name, !!tool.jit_auth)`.

### HIGH-3: Non-OAuth auth profiles not guarded

**File**: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` (lines 179-191)
**Status**: VERIFIED

The `handleJitAuth` function checks `if (!authUrl && !config.initiateJitOAuth)` (line 181). When no OAuth initiation callback is available (meaning the profile is not OAuth-compatible), it returns a structured error result with code `JIT_AUTH_NOT_SUPPORTED` instead of attempting to pause execution. This prevents non-OAuth profiles from entering the JIT flow.

### HIGH-4: PausedExecutionStore.pending has no periodic sweep

**File**: `apps/runtime/src/services/auth-profile/paused-execution-store.ts` (lines 72-257)
**Status**: VERIFIED

All required elements are present:

1. **Sweep timer**: `SWEEP_INTERVAL_MS = 60_000` (line 33). Timer created in constructor (line 78), unref'd.
2. **`sweepExpired()` method** (lines 226-241): Iterates all entries, checks `pausedAt + timeoutMs`, rejects expired entries with `AuthTimeoutError`, and cleans them from the map.
3. **`destroy()` method** (lines 246-257): Clears the interval timer and rejects all remaining paused executions with a shutdown error.
4. **Max capacity**: `MAX_PAUSED_EXECUTIONS = 1000` (line 30), enforced in `pause()` (line 99).
5. **Session cleanup**: `cleanupSession(sessionId)` (lines 192-212) iterates entries, rejects with "Session disconnected", and cleans Redis keys via SCAN.

---

## Additional Component Verification

### PausedExecutionStore — Overall Design

The store follows a sound design:

- **Dual storage**: In-memory Map for Promises (pod-local, since WS is sticky), Redis for cross-pod visibility and TTL cleanup.
- **Session isolation**: `cleanupSession` filters by `sessionId`, both in-memory and Redis.
- **Error typing**: `AuthTimeoutError` and `AuthCancelledError` custom classes enable structured handling in the middleware.
- **Singleton pattern**: `getPausedExecutionStore()` with `resetPausedExecutionStore()` for testing.
- **Deferred work documented**: Session-scoped token revocation (Task 5.18) is clearly documented as deferred with rationale (lines 342-356).

### AuthChallengeMessage — UI Component

- Countdown timer updates every 1s, transitions to `timed_out` when remaining reaches 0.
- Cancel button sends `auth_response` with `status: 'cancelled'` and closes popup if open.
- State machine: `pending -> authorizing -> completed | timed_out | cancelled`. Terminal states are non-interactive.
- `parseAuthChallengeData` validates `_type === 'auth_challenge'` and `typeof toolCallId === 'string'`.

### WebSocketContext — auth_challenge handling

- `case 'auth_challenge'` (lines 446-464): Serializes challenge data as JSON in a system message content field with `_type: 'auth_challenge'` marker.
- Message ID uses `auth-challenge-${message.toolCallId}` — deterministic, avoids duplicates for same toolCallId.

### MessageList — AuthChallengeMessage rendering

- Import present (line 24): `import { AuthChallengeMessage, parseAuthChallengeData } from './AuthChallengeMessage'`.
- System messages are checked via `parseAuthChallengeData(message.content)` (line 79).
- When parsed, renders `<AuthChallengeMessage data={challengeData} />` inside the standard message container.

### auth-profile-tool-middleware — End-to-End JIT Flow

The flow is complete and correct:

1. Tool with `auth_profile_ref` triggers `resolveToolAuth`.
2. If profile not found and `jit_auth: true`, `AuthProfileNotFoundError` is caught (line 119-126).
3. `handleJitAuth` generates a toolCallId, optionally initiates OAuth, sends `auth_challenge` via callback.
4. `store.pause()` blocks until `resolve()` or `reject()` is called.
5. On resume, `resolveToolAuth` is called again with fresh credentials and tool call proceeds.
6. Timeout, cancellation, and disconnect are all handled with structured error responses.

---

## New Findings

### MEDIUM-1: `handleJitAuth` generates non-deterministic toolCallId

**File**: `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` (line 151)
**Code**: `const toolCallId = 'jit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);`

`Math.random()` is not cryptographically secure. While this ID is not security-critical (it is used for internal correlation, not authentication), using `crypto.randomUUID()` would be more consistent with the rest of the codebase which uses `crypto.randomBytes()` for state tokens. This is informational only — no exploit path exists since the toolCallId is only ever matched against the in-memory PausedExecutionStore on the same pod.

**Severity**: Low (informational)

### MEDIUM-2: Popup polling interval is generous

**File**: `apps/studio/src/components/chat/AuthChallengeMessage.tsx` (line 91)

The popup close detection polls every 500ms. If the user closes the popup, there is up to 500ms where the UI still shows "Waiting for authorization..." This is acceptable UX but could be tightened to 250ms with negligible performance impact.

**Severity**: Low (UX polish)

### MEDIUM-3: No rate limiting on auth_response messages

**Files**: `handler.ts` (line 2908), `sdk-handler.ts` (line 1533)

A client could spam `auth_response` messages. Since `store.resolve()` and `store.reject()` are idempotent (they log a warning when the entry is not found), this is not exploitable, but repeated calls generate unnecessary log noise. A simple `if (!store.has(toolCallId)) break;` guard before the ownership check would reduce noise.

**Severity**: Low (operational hygiene)

---

## Verdict: PASS

All 7 critical and high findings from iteration 1 have been verified as properly fixed:

- **3 Critical fixes**: All verified with correct implementation
- **4 High fixes**: All verified with correct implementation
- **3 New findings**: All Low severity (informational/polish) — none warrant blocking

The Phase 5 JIT Auth implementation is architecturally sound with proper:

- Resource cleanup on disconnect (both handlers)
- Session ownership validation (prevents cross-session spoofing)
- Bounded in-memory data structures (MAX + TTL + sweep + eviction)
- Structured error handling (typed errors, instanceof checks)
- Non-OAuth profile guard (fail-fast with clear error)
- Secure popup completion detection (postMessage + close polling)
