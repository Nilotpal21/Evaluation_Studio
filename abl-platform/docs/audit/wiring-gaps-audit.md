# Wiring Gaps Audit Report

**Date:** 2026-03-18
**Auditor:** Claude Opus 4.6 (automated source code audit)
**Checklist:** `docs/plans/AUTH-PROFILE-E2E-CHECKLIST.md`
**Scope:** WG-1 through WG-4 — verify each checklist item by reading source code

---

## WG-1: OAuth callback resolves JIT paused executions

**File:** `apps/runtime/src/services/tool-oauth-service.ts` (lines 336-419)

| #   | Checklist Item                                                                                    | Verdict  | Evidence                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `handleOAuthCallback` calls `getJitMetadata(state)` after token storage                           | **PASS** | Line 407: `const jitMeta = this.getJitMetadata(state);` — called after `upsertToken` (line 391) and the success log (line 401)                                                          |
| 2   | If JIT metadata found, imports and calls `getPausedExecutionStore().resolve(metadata.toolCallId)` | **PASS** | Lines 409-411: Dynamic import of `paused-execution-store.js`, calls `store.resolve(jitMeta.toolCallId)`                                                                                 |
| 3   | Calls `clearJitMetadata(state)` after resolution                                                  | **PASS** | Line 412: `this.clearJitMetadata(state);` — called immediately after `resolve()`                                                                                                        |
| 4   | Logs JIT resolution event                                                                         | **PASS** | Lines 413-418: `log.info('JIT OAuth flow completed — paused execution resolved', { provider, tenantId, sessionId, toolCallId })`                                                        |
| 5   | Non-JIT callbacks (no metadata) continue working unchanged                                        | **PASS** | The JIT block is guarded by `if (jitMeta)` (line 408). When `getJitMetadata` returns `null`, the function returns normally after token storage. No code path changes for non-JIT flows. |

**WG-1 Verdict: PASS (5/5)**

---

## WG-2: WebSocketContext.tsx handles preflight events

**File:** `apps/studio/src/contexts/WebSocketContext.tsx` (lines 467-481)

| #   | Checklist Item                                                                                 | Verdict  | Evidence                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `auth_required` case calls `useBatchConsentStore.getState().initFromAuthRequired(message)`     | **PASS** | Lines 467-471: `case 'auth_required':` calls `useBatchConsentStore.getState().initFromAuthRequired(message.sessionId, message.pending, message.satisfied)`. Signature matches the store definition (3-arg: sessionId, pending[], satisfied[]). |
| 2   | `auth_gate_updated` case calls `useBatchConsentStore.getState().updateFromGateUpdate(message)` | **PASS** | Lines 473-476: `case 'auth_gate_updated':` calls `useBatchConsentStore.getState().updateFromGateUpdate(message.pending, message.satisfied)`. Signature matches (2-arg: pending[], satisfied[]).                                                |
| 3   | `auth_gate_satisfied` case calls `useBatchConsentStore.getState().markAllSatisfied()`          | **PASS** | Lines 479-480: `case 'auth_gate_satisfied':` calls `useBatchConsentStore.getState().markAllSatisfied()`. Zero-arg call matches store definition.                                                                                               |

**Import check:** Line 25 imports `useBatchConsentStore` from `'../store/batch-consent-store'`. The store exists at `apps/studio/src/store/batch-consent-store.ts` and exports `useBatchConsentStore`. Import is correct.

**WG-2 Verdict: PASS (3/3)**

---

## WG-3: Main WS handler has preflight + consent_satisfy

**File:** `apps/runtime/src/websocket/handler.ts`

| #   | Checklist Item                                                                                      | Verdict  | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Imports `checkAuthPreflightFromIR` and `satisfyConnector` from auth-preflight                       | **PASS** | Lines 88-94: Imports `checkAuthPreflightFromIR`, `hasActiveAuthGate`, `queueMessageBehindAuthGate`, `satisfyConnector`, `cleanupAuthGate`, `createTokenLookups` from `'../services/auth-profile/auth-preflight.js'`                                                                                                                                                 |
| 2   | Calls `checkAuthPreflightFromIR` after agent/IR loaded, sends `auth_required` if requirements exist | **PASS** | Lines 1189-1218: After agent is loaded and state_update is sent, checks `runtimeSession.compilationOutput`, calls `checkAuthPreflightFromIR(sessionId, compilationOutput, { userId, tenantId }, tokenLookups)`. If `gateState` is non-null, sends `ServerMessages.authRequired(sessionId, gateState.pending, gateState.satisfied)` and returns (blocking ON_START). |
| 3   | Has `consent_satisfy` message handler with session ownership validation                             | **PASS** | Line 807: `case 'consent_satisfy':` dispatches to `handleConsentSatisfy`. Lines 2932-2953: Function validates `authProfileRef` and `runtimeSid` exist, then checks `sessionId !== clientState?.sessionId` for ownership. Logs warning on violation.                                                                                                                 |
| 4   | Sends `auth_gate_updated` / `auth_gate_satisfied` events back to client                             | **PASS** | Lines 2961-2990: If `result.allSatisfied`, sends `ServerMessages.authGateSatisfied()`. Otherwise sends `ServerMessages.authGateUpdated(sessionId, result.state.pending, result.state.satisfied)`.                                                                                                                                                                   |
| 5   | Auth gate check: messages queued while gate active                                                  | **PASS** | Lines 1490-1504: Before processing a user message, checks `hasActiveAuthGate(runtimeSidForGate)`. If active, calls `queueMessageBehindAuthGate(runtimeSidForGate, text, attachmentIds)` and sends `message_queued` with reason `auth_gate_active`. Returns early.                                                                                                   |

**Additional observations:**

- After auth gate is satisfied, queued messages are replayed (lines 2964-2976) via `handleSendMessage`.
- ON_START is deferred: fires only after gate clears (lines 2977-2981).
- Auth gate cleanup is imported (`cleanupAuthGate`, line 92) for session disconnect handling.

**WG-3 Verdict: PASS (5/5)**

---

## WG-4: DSL parser supports consent and connection keywords

### Parser: `packages/core/src/parser/tool-file-parser.ts`

| #   | Checklist Item                                                            | Verdict  | Evidence                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Parser handles `consent: preflight \| inline` -> AST `consent` field      | **PASS** | Lines 494-495: `case 'consent':` sets `result.consent = value as 'preflight' \| 'inline'`. The `ToolPropertiesResult` interface (line 219) declares `consent?: 'preflight' \| 'inline'`. Line 126: `if (props.consent) tool.consent = props.consent;` assigns to the AgentTool AST.             |
| 2   | Parser handles `connection: per_user \| shared` -> AST `connection` field | **PASS** | Lines 497-498: `case 'connection':` sets `result.connection = value as 'per_user' \| 'shared'`. The `ToolPropertiesResult` interface (line 221) declares `connection?: 'per_user' \| 'shared'`. Line 127: `if (props.connection) tool.connection = props.connection;` assigns to AgentTool AST. |

### Types: `packages/core/src/types/agent-based.ts`

| #   | Checklist Item                                                      | Verdict  | Evidence                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | AgentTool type has authProfile, authJit, consent, connection fields | **PASS** | Lines 528-535: `authProfile?: string`, `authJit?: boolean`, `consent?: 'preflight' \| 'inline'`, `connection?: 'per_user' \| 'shared'` — all four fields present with correct types and JSDoc. |

### Compiler: `packages/compiler/src/platform/ir/compiler.ts`

| #   | Checklist Item                                   | Verdict  | Evidence                                                                                      |
| --- | ------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------- |
| 4   | Compiler maps consent -> IR `consent_mode`       | **PASS** | Line 745: `consent_mode: tool.consent,` — maps AST `consent` to IR `consent_mode`             |
| 5   | Compiler maps connection -> IR `connection_mode` | **PASS** | Line 746: `connection_mode: tool.connection,` — maps AST `connection` to IR `connection_mode` |

**Note on checklist discrepancy:** The checklist (WG-4) specifies AST field names as `consentMode` and `connectionMode`, but the actual implementation uses `consent` and `connection` on the AST (matching the DSL keyword names), then maps to `consent_mode` and `connection_mode` on the IR. This is arguably cleaner (AST matches DSL surface syntax, IR uses snake_case convention). The semantic intent is satisfied.

**WG-4 Verdict: PASS (5/5)**

---

## Overall Verdict

| Wiring Gap                                        | Items  | Passed | Failed | Verdict  |
| ------------------------------------------------- | ------ | ------ | ------ | -------- |
| WG-1: OAuth callback resolves JIT                 | 5      | 5      | 0      | **PASS** |
| WG-2: WebSocketContext preflight events           | 3      | 3      | 0      | **PASS** |
| WG-3: Main WS handler preflight + consent_satisfy | 5      | 5      | 0      | **PASS** |
| WG-4: DSL parser consent/connection keywords      | 5      | 5      | 0      | **PASS** |
| **Total**                                         | **18** | **18** | **0**  | **PASS** |

**Overall: PASS** -- All 18 checklist items verified against source code. All four wiring gaps have been correctly implemented.

### Minor Observations (not failures)

1. **WG-1 dynamic import:** `getPausedExecutionStore` is dynamically imported inside `handleOAuthCallback` (line 409) rather than statically at module top. This avoids circular dependency issues but adds ~1ms latency on first JIT callback. Acceptable tradeoff.

2. **WG-3 auth gate error handling:** The preflight check is wrapped in try/catch (lines 1213-1218) with a fallback that proceeds without the gate. This is a safe degradation — better than blocking the session on a preflight error.

3. **WG-4 AST naming:** Checklist expected `consentMode`/`connectionMode` on AST, implementation uses `consent`/`connection`. The compiler correctly maps these to IR `consent_mode`/`connection_mode`. The end-to-end pipeline works correctly.
