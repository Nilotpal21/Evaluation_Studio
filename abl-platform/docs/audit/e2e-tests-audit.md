# Auth Profile E2E Tests — Audit Report

**Date:** 2026-03-18
**Auditor:** Claude Opus 4.6 (automated)
**Checklist:** `docs/plans/AUTH-PROFILE-E2E-CHECKLIST.md`

---

## Overall Verdict: **PARTIAL PASS**

- 38 of 40 checklist scenarios have corresponding tests
- 2 scenarios MISSING (7.5 capacity eviction, 7.7 auth gate reset)
- 0 stub/empty tests found
- 0 prohibited mock anti-patterns found
- Suite 4 does NOT use `parseAgentBasedABL`/`compileABLtoIR` (tests IR shapes directly, not DSL parsing)

---

## Coverage Matrix

### Suite 1: Multi-Channel JIT Auth

| #   | Scenario                                                                           | File:Line                           | Status      | Notes                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Main WS handler sends `auth_challenge` when tool needs auth and `jit_auth=true`    | `auth-jit-multichannel.test.ts:109` | **COVERED** | Uses real `createAuthProfileToolMiddleware`, real `PausedExecutionStore`, real `ServerMessages.authChallenge`. Mocks only `resolveByName` (DB). Assertions: challenge payload fields, ServerMessage serialization, resolution + retry. |
| 1.2 | SDK WS handler sends `auth_challenge` when tool needs auth and `jit_auth=true`     | `auth-jit-multichannel.test.ts:172` | **COVERED** | Same middleware with different sessionId. Verifies SDK channel uses identical path.                                                                                                                                                    |
| 1.3 | `auth_response` with `status: completed` resumes paused execution                  | `auth-jit-multichannel.test.ts:211` | **COVERED** | Uses real `parseClientMessage`, real `store.resolve()`, verifies entry removed after resolution.                                                                                                                                       |
| 1.4 | `auth_response` with `status: cancelled` fails tool call with `AuthCancelledError` | `auth-jit-multichannel.test.ts:260` | **COVERED** | Uses real `parseClientMessage`, `store.reject()` with `AuthCancelledError`. Checks `AUTH_CANCELLED` code in result.                                                                                                                    |
| 1.5 | Timeout: no `auth_response` within TTL -> `AuthTimeoutError`                       | `auth-jit-multichannel.test.ts:299` | **COVERED** | Sets `JIT_AUTH_TIMEOUT_MS=200`, waits for natural timeout. Checks `AUTH_TIMEOUT` code.                                                                                                                                                 |
| 1.6 | Non-OAuth auth profile with `jit_auth=true` -> clear error                         | `auth-jit-multichannel.test.ts:328` | **COVERED** | Omits `initiateJitOAuth` callback. Checks `JIT_AUTH_NOT_SUPPORTED` error code with profile name in message.                                                                                                                            |
| 1.7 | Tool WITHOUT `jit_auth` but with `auth_profile_ref` -> fails immediately           | `auth-jit-multichannel.test.ts:350` | **COVERED** | Sets `jit_auth: false`. Expects `AUTH_PROFILE_NOT_FOUND` throw. Verifies no challenge sent, store empty.                                                                                                                               |

### Suite 2: Multi-Channel Preflight Consent

| #   | Scenario                                                                   | File:Line                                 | Status      | Notes                                                                                                                                |
| --- | -------------------------------------------------------------------------- | ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1 | Main WS handler sends `auth_required` on session init                      | `auth-preflight-multichannel.test.ts:134` | **COVERED** | Uses real `checkAuthPreflight`, `hasActiveAuthGate`, `ServerMessages.authRequired`. Mock: token lookups (injected functions).        |
| 2.2 | SDK WS handler sends `auth_required` on session init                       | `auth-preflight-multichannel.test.ts:160` | **COVERED** | Same function, different sessionId.                                                                                                  |
| 2.3 | `consent_satisfy` updates auth gate state, sends `auth_gate_updated`       | `auth-preflight-multichannel.test.ts:180` | **COVERED** | Uses real `satisfyConnector`. Checks `allSatisfied: false`, pending/satisfied counts, `ServerMessages.authGateUpdated`.              |
| 2.4 | All connectors satisfied -> `auth_gate_satisfied`, replays queued messages | `auth-preflight-multichannel.test.ts:211` | **COVERED** | Uses real `queueMessageBehindAuthGate`, `satisfyConnector`. Checks `allSatisfied: true`, queued message contents, gate deactivation. |
| 2.5 | Messages sent while auth gate active are queued (max 100)                  | `auth-preflight-multichannel.test.ts:250` | **COVERED** | Queues 100 messages, checks 101st throws `Too many queued messages`. Verifies queue depth via `getAuthGateState`.                    |
| 2.6 | Auth gate cleanup on session disconnect                                    | `auth-preflight-multichannel.test.ts:277` | **COVERED** | Uses real `cleanupAuthGate`. Verifies gate removed and state undefined after cleanup.                                                |
| 2.7 | No `auth_required` when all tools use `consent: inline`                    | `auth-preflight-multichannel.test.ts:296` | **COVERED** | Passes only inline requirements. Checks `checkAuthPreflight` returns null, no gate active.                                           |
| 2.8 | No `auth_required` when all tokens already satisfied                       | `auth-preflight-multichannel.test.ts:315` | **COVERED** | Uses `satisfiedTokenLookups` returning true for all profiles. Checks null result, no gate.                                           |
| 2.9 | Mixed preflight + inline tools -> only preflight tools in `auth_required`  | `auth-preflight-multichannel.test.ts:336` | **COVERED** | Mixes 2 preflight + 1 inline. Only 2 appear in pending.                                                                              |

**Bonus coverage:** `checkAuthPreflightFromIR` integration (line 359), `resolveConsentState` 3-tier lookup (line 420) — both tested with real implementations.

### Suite 3: OAuth Callback -> Async JIT Resume

| #   | Scenario                                                           | File:Line                             | Status      | Notes                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------ | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1 | Full circuit: pause -> auth_challenge -> OAuth callback -> resolve | `auth-oauth-callback-jit.test.ts:131` | **COVERED** | Uses real `ToolOAuthService`, `PausedExecutionStore`, `InMemoryOAuthStateStore`. Mocks: `fetch` (HTTP), token store. Full circuit: pause -> initiateJitOAuth -> extract state -> mock token exchange -> handleOAuthCallback -> pausePromise resolves -> metadata cleared. |
| 3.2 | Expired JIT metadata -> callback stores token but does not resolve | `auth-oauth-callback-jit.test.ts:203` | **COVERED** | Clears metadata before callback. Token still stored but no resolution attempt.                                                                                                                                                                                            |
| 3.3 | Race: callback arrives after client cancelled -> no error          | `auth-oauth-callback-jit.test.ts:240` | **COVERED** | Rejects paused execution first, then handles callback. No throw. Token still stored.                                                                                                                                                                                      |
| 3.4 | Non-JIT OAuth callback -> works normally, no crash                 | `auth-oauth-callback-jit.test.ts:289` | **COVERED** | Uses `initiateOAuthFlow` (non-JIT). No JIT metadata exists. Callback stores token normally.                                                                                                                                                                               |
| 3.5 | JIT metadata cleanup after callback resolves                       | `auth-oauth-callback-jit.test.ts:327` | **COVERED** | Verifies metadata exists before callback, null after. Paused execution resolved.                                                                                                                                                                                          |

### Suite 4: DSL -> Compile -> IR -> Runtime E2E

| #    | Scenario                                                                       | File:Line                         | Status      | Notes                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------ | --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | DSL `auth_profile: "x"` -> IR `auth_profile_ref: "x"`                          | `auth-dsl-to-runtime.test.ts:82`  | **PARTIAL** | Tests IR field presence on manually constructed ToolDefinition. Does NOT parse DSL with `parseAgentBasedABL`. See note below.                                                                                 |
| 4.2  | DSL `auth_jit: true` -> IR `jit_auth: true`                                    | `auth-dsl-to-runtime.test.ts:93`  | **PARTIAL** | Same issue: tests IR shape, not DSL parsing.                                                                                                                                                                  |
| 4.3  | DSL `consent: preflight` -> IR `consent_mode: "preflight"`                     | `auth-dsl-to-runtime.test.ts:103` | **PARTIAL** | Tests IR shape only. Checklist says "Real Components: `parseAgentBasedABL`, `compileABLtoIR`" but these are NOT used.                                                                                         |
| 4.4  | DSL `connection: per_user` -> IR `connection_mode: "per_user"`                 | `auth-dsl-to-runtime.test.ts:113` | **PARTIAL** | Same.                                                                                                                                                                                                         |
| 4.5  | DSL `auth_profile: "{{config.X}}"` -> IR preserves template                    | `auth-dsl-to-runtime.test.ts:123` | **PARTIAL** | Tests template string in IR field, not DSL compilation.                                                                                                                                                       |
| 4.6  | IR auth tools -> `collectAuthRequirements` -> correct requirements             | `auth-dsl-to-runtime.test.ts:135` | **COVERED** | Uses real `collectAuthRequirements`. Proper assertions on deduplication, field values.                                                                                                                        |
| 4.7  | IR tools -> `checkAuthPreflightFromIR` -> auth gate activated                  | `auth-dsl-to-runtime.test.ts:170` | **PARTIAL** | Tests `collectAuthRequirements` scope merging, NOT `checkAuthPreflightFromIR` as specified. The checklist says to test `checkAuthPreflightFromIR` + `resolveConsentState`. Cross-references to Suite 2 tests. |
| 4.8  | IR tool with `jit_auth` -> `createAuthProfileToolMiddleware` -> auth_challenge | `auth-dsl-to-runtime.test.ts:226` | **PARTIAL** | Only verifies IR tool has correct fields for middleware compatibility. Does NOT construct the middleware or trigger auth_challenge. Cross-references to Suite 1 tests.                                        |
| 4.9  | `auth_jit: true` without `auth_profile` -> compile-time warning                | `auth-dsl-to-runtime.test.ts:248` | **PARTIAL** | Verifies the structural combination is possible in IR. Does NOT invoke `validateAuthJitRequiresProfile` or check for actual warning emission.                                                                 |
| 4.10 | `consent: preflight` without `auth_profile` -> compile-time warning            | `auth-dsl-to-runtime.test.ts:268` | **PARTIAL** | Verifies `collectAuthRequirements` ignores tools without `auth_profile_ref`. Does NOT test validation warning.                                                                                                |

**Suite 4 systemic issue:** The checklist specifies these tests should use `parseAgentBasedABL` and `compileABLtoIR` as real components (pure functions, no mocks needed). Instead, all tests manually construct IR objects and only test downstream consumers. This means **the DSL-to-IR compilation path for auth fields is entirely untested**. If `consent` or `connection` DSL keywords are not wired in the parser/compiler (which WG-4 flags as a gap), these tests would still pass.

### Suite 5: JIT Auth with Rich Templates

| #   | Scenario                                                                           | File:Line                           | Status      | Notes                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1 | Tool with `jit_auth + adaptive_card` -> auth_challenge then rich content on resume | `auth-jit-rich-content.test.ts:103` | **COVERED** | Full middleware flow: challenge sent, auth resolved, rich content returned. Checks `adaptive_card` in parsed result.                                   |
| 5.2 | Tool with `jit_auth + carousel` -> rich content preserved across pause/resume      | `auth-jit-rich-content.test.ts:158` | **COVERED** | Same flow with carousel. Checks card count and title preservation.                                                                                     |
| 5.3 | `auth_challenge` does not corrupt rich content rendering context                   | `auth-jit-rich-content.test.ts:208` | **COVERED** | Uses real `ServerMessages.authChallenge`, `ServerMessages.responseEnd`, `serializeServerMessage`. Verifies type discrimination and no field collision. |
| 5.4 | Timeout during JIT on rich-content tool -> error, not broken rich content          | `auth-jit-rich-content.test.ts:255` | **COVERED** | Short timeout. Checks error result has `AUTH_TIMEOUT` and no `rich_content` field.                                                                     |

### Suite 6: Studio UI Event Integration

| #   | Scenario                                                                   | File:Line                        | Status      | Notes                                                                                                                   |
| --- | -------------------------------------------------------------------------- | -------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| 6.1 | `auth_challenge` WS event -> system message in chat                        | `auth-studio-events.test.ts:83`  | **COVERED** | Verifies event fields and constructs system message shape. No real chat store integration (constructs object manually). |
| 6.2 | `auth_required` WS event -> batch consent store initialized                | `auth-studio-events.test.ts:113` | **COVERED** | Uses real `useBatchConsentStore.initFromAuthRequired`. Checks connector count, statuses, auth profile refs.             |
| 6.3 | `auth_gate_updated` WS event -> individual connector state updated         | `auth-studio-events.test.ts:140` | **COVERED** | Uses real store. Inits then updates. Checks google-creds connected, salesforce-creds pending.                           |
| 6.4 | `auth_gate_satisfied` WS event -> all connectors satisfied, gate dismissed | `auth-studio-events.test.ts:162` | **COVERED** | Uses real `markAllSatisfied`. Checks `active: false`, all connected.                                                    |
| 6.5 | `initFromAuthRequired` creates correct connector entries                   | `auth-studio-events.test.ts:180` | **COVERED** | Detailed check: connector names, statuses, scopes, connectionMode for each entry.                                       |
| 6.6 | `updateFromGateUpdate` transitions individual connector states             | `auth-studio-events.test.ts:228` | **COVERED** | Multi-step: satisfies A, then B, then authorizing C. Checks authorizing state preserved across gate updates.            |
| 6.7 | `markAllSatisfied` sets `allSatisfied: true`                               | `auth-studio-events.test.ts:286` | **COVERED** | Tests with skipped connector. Checks connected vs skipped status, computed getters.                                     |

**Bonus coverage:** `reset`, `setFailed`, `setConnected` edge cases, `initFromAuthRequired` with no pending.

### Suite 7: Cross-Session Security

| #   | Scenario                                                        | File:Line                           | Status      | Notes                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------- | ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | `auth_response` with another session's `toolCallId` -> rejected | `auth-jit-multichannel.test.ts:388` | **COVERED** | Uses real `PausedExecutionStore.pause`, `get`, `parseClientMessage`. Verifies session mismatch is detectable. Note: tests the detection mechanism (data comparison), not a handler-level rejection.                                                    |
| 7.2 | `consent_satisfy` for another session -> rejected               | `auth-jit-multichannel.test.ts:427` | **PARTIAL** | Parses message and checks sessionId mismatch. Does NOT test handler-level rejection — only verifies the sessionId field is available for comparison.                                                                                                   |
| 7.3 | Disconnected session's paused executions cleaned up             | `auth-jit-multichannel.test.ts:445` | **COVERED** | Real `cleanupSession`. Creates 3 entries (2 for target, 1 for other). Verifies target removed, other retained, promises reject with "Session disconnected".                                                                                            |
| 7.4 | JIT metadata expires after TTL -> returns null                  | `auth-jit-multichannel.test.ts:497` | **PARTIAL** | Tests `PausedExecutionStore` timeout as proxy for JIT metadata TTL. Does NOT test `ToolOAuthService.getJitMetadata` TTL directly (the actual component listed in checklist).                                                                           |
| 7.5 | `jitMetadataMap` evicts when at capacity                        | `auth-jit-multichannel.test.ts:514` | **MISSING** | Test exists but only checks `store.size` tracking (1 entry, then 0 after reject). Does NOT test `MAX_JIT_METADATA_ENTRIES` eviction or `evictOldestJitMetadata`. The test name mentions "max capacity" but the test body is about basic size tracking. |
| 7.6 | `PausedExecutionStore.sweepExpired()` removes timed-out entries | `auth-jit-multichannel.test.ts:538` | **PARTIAL** | Tests natural timeout expiry (same mechanism as 7.4). Does NOT explicitly call `sweepExpired()` — relies on the internal timeout callback. The checklist specifies testing the periodic sweep timer.                                                   |
| 7.7 | Auth gate state cleaned up on session reset                     | N/A                                 | **MISSING** | No test exists. Checklist specifies testing `cleanupAuthGate` in `reset_session` handler.                                                                                                                                                              |

---

## Anti-Pattern Audit

| Anti-Pattern                                    | Found?  | Details                                                                    |
| ----------------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Mocking `PausedExecutionStore`                  | **No**  | All tests use real singleton via `getPausedExecutionStore()`               |
| Mocking `collectAuthRequirements`               | **No**  | Suite 4 uses real import                                                   |
| Mocking `checkAuthPreflight`/`satisfyConnector` | **No**  | Suite 2 uses real imports                                                  |
| Mocking `parseAgentBasedABL`/`compileABLtoIR`   | **N/A** | These are never imported at all (Suite 4 skips DSL parsing entirely)       |
| Mocking `useBatchConsentStore`                  | **No**  | Suite 6 uses real Zustand store                                            |
| Mocking WS event serialization/parsing          | **No**  | Real `ServerMessages`, `parseClientMessage`, `serializeServerMessage` used |
| Empty test bodies / `expect(1).toBe(1)` stubs   | **No**  | All tests have substantive assertions                                      |
| Tests that only check function existence        | **No**  | All tests verify behavioral outcomes                                       |

---

## Summary Statistics

| Suite                              | Scenarios | COVERED | PARTIAL | MISSING |
| ---------------------------------- | --------- | ------- | ------- | ------- |
| 1: Multi-Channel JIT Auth          | 7         | 7       | 0       | 0       |
| 2: Multi-Channel Preflight Consent | 9         | 9       | 0       | 0       |
| 3: OAuth Callback -> JIT Resume    | 5         | 5       | 0       | 0       |
| 4: DSL -> Compile -> IR -> Runtime | 10        | 1       | 9       | 0       |
| 5: JIT Auth with Rich Templates    | 4         | 4       | 0       | 0       |
| 6: Studio UI Event Integration     | 7         | 7       | 0       | 0       |
| 7: Cross-Session Security          | 7         | 1       | 4       | 2       |
| **TOTAL**                          | **49**    | **34**  | **13**  | **2**   |

---

## Critical Findings

### Finding 1: Suite 4 does not test DSL parsing (HIGH)

The checklist explicitly requires `parseAgentBasedABL` and `compileABLtoIR` as real components for scenarios 4.1-4.5. The tests instead manually construct IR objects. This means:

- The DSL `consent: preflight` keyword (WG-4 gap) is completely untested
- The DSL `connection: per_user` keyword (WG-4 gap) is completely untested
- There is no verification that `auth_profile`, `auth_jit`, `consent`, or `connection` DSL keywords compile to correct IR fields

### Finding 2: Suite 4 validation scenarios are structural, not behavioral (MEDIUM)

Scenarios 4.9 and 4.10 should test compile-time warning emission from `validateAuthJitRequiresProfile` and equivalent. Instead they verify the IR shape is constructable, which always passes regardless of whether validation exists.

### Finding 3: Suite 7 missing capacity eviction and session reset tests (MEDIUM)

- 7.5: The test labeled "max capacity" only verifies basic size tracking. `MAX_JIT_METADATA_ENTRIES` and `evictOldestJitMetadata` are not exercised.
- 7.7: No test for `cleanupAuthGate` in `reset_session` handler.

### Finding 4: Suite 7 security tests verify data availability, not handler rejection (LOW)

Tests 7.1 and 7.2 verify the session mismatch is detectable (by comparing sessionId fields) but do not test that a WS handler actually rejects the cross-session attempt. This is acceptable for unit-level E2E but means the handler-level enforcement path is untested.

### Finding 5: Suite 6.1 does not test real chat store insertion (LOW)

The test constructs a system message object manually rather than testing actual chat store insertion logic from a WS event handler. Acceptable given the store/handler are in different layers.

---

## Mock Boundary Compliance

All test files correctly mock ONLY at true boundaries:

| Boundary                                    | How Mocked                                                | Files            |
| ------------------------------------------- | --------------------------------------------------------- | ---------------- |
| DB (`resolveByName`, `AuthProfile.findOne`) | `vi.mock('../../services/auth-profile-resolver.js')`      | Suite 1, 5       |
| Redis                                       | `vi.mock('../../services/redis/redis-client.js')`         | Suite 1, 2, 3, 5 |
| Logger                                      | `vi.mock('@abl/compiler/platform')`                       | Suite 1, 2, 3, 5 |
| HTTP fetch                                  | `globalThis.fetch = vi.fn()`                              | Suite 3          |
| Token lookups                               | Injected `TokenLookupFunctions` with mock implementations | Suite 2          |
| Token store                                 | In-memory mock implementing `OAuthTokenStore` interface   | Suite 3          |
| Encryptor                                   | Simple string prefix mock                                 | Suite 3          |

No component listed in the "Real Components" column is mocked, except as noted in Finding 1 (Suite 4 never imports the parser/compiler at all).
