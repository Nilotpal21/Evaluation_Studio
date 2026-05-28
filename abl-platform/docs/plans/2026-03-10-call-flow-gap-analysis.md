# Call Flow & Agent Transfer — Gap Analysis Report

**Date:** 2026-03-10
**Reviewed by:** 5 parallel code-explorer agents (core, runtime, studio, voice/IVR, drift)
**Scope:** `packages/agent-transfer`, `packages/a2a`, `apps/runtime` agent-transfer integration, `apps/studio` transfer UI
**Cross-referenced:** RFC-014, Studio design doc, 52-task remediation plan

---

## Executive Summary

- **1 SHOWSTOPPER**: `handleEscalate()` never calls the agent-transfer package — the bridge between `__escalate__` and transfer session creation is completely missing
- **Phase 1 "DONE" is false**: Tasks 1, 2, 4 are still open; Tasks 3, 6 are partial
- **71 total findings** across 5 review dimensions
- **A2A package is production-ready** — the strongest subsystem in scope
- **Voice/IVR tools are wired** but voice gateway registry is unused and 4 voice features are missing
- **Studio UI has 29 findings** — 2 critical (broken route + data loss), 5 high, 22 medium/low

---

## SHOWSTOPPER — Blocks All Production Use

### handleEscalate() never calls agent-transfer package

**Severity:** CRITICAL — blocks the entire escalation → human transfer flow
**Evidence:** `apps/runtime/src/services/execution/routing-executor.ts:2319-2385`

When the LLM calls `__escalate__`, `handleEscalate()` sets `session.isEscalated = true` and emits a trace event — but does NOT:

- Look up connection credentials
- Call `getAdapterRegistry()`
- Create a transfer session via `TransferSessionStore`
- Contact the agent desktop provider via `KoreAdapter.execute()`

The design doc says "This replaces the current behavior of just setting a flag and emitting a trace" — but the flag-and-trace behavior is still all that happens. This is the single biggest gap in the entire system. The 52-task remediation plan does NOT include this wiring task.

**Impact:** Steps 3-8 of the E2E flow (create session → contact provider → webhook → message delivery → post-agent → return to bot) are all dead code paths that can only be triggered via direct API calls, never through the LLM escalation path.

**Fix:** Wire `handleEscalate()` to:

1. Read `escalationConfig.routing` from IR
2. Resolve connection credentials via `getAdapterRegistry()`
3. Create transfer session via `TransferSessionStore`
4. Call adapter's `execute()` method
5. Bridge agent messages back via `MessageBridge`
6. Handle post-agent flow on session end

---

## Phase 1 Status — Plan Claims "DONE" But Isn't

| Task                                | Plan Status | Actual Status  | Evidence                                                                                                                |
| ----------------------------------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **1** — Session update() TOCTOU     | DONE        | **STILL OPEN** | `transfer-session-store.ts:166` — EXISTS + HMSET still used, no Lua script                                              |
| **2** — Leader election TOCTOU      | DONE        | **STILL OPEN** | `session-recovery-service.ts:175-179` — GET + EXPIRE renewal, not SET XX EX                                             |
| **3** — Timeout scheduler pod-local | DONE        | **PARTIAL**    | Deterministic jobId ✅; cross-pod cancel broken ❌ (pod A can't cancel pod B's timeout)                                 |
| **4** — Auth token refresh          | DONE        | **STILL OPEN** | `jwt.ts:22`, `oauth2-client.ts:44` — both return `existing` unchanged. Tests written for planned behavior, not current. |
| **5** — SMEMBERS → SSCAN            | DONE        | **STILL OPEN** | `session-recovery-service.ts:195` — smembers still used                                                                 |
| **6** — extendTTL N+1               | DONE        | **PARTIAL**    | Pipeline implemented ✅; HGETALL still called on every invocation ❌                                                    |

---

## CRITICAL & HIGH Findings

### Runtime Integration

| #   | Finding                                                                   | Severity     | Evidence                                                                      |
| --- | ------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| R-1 | Sessions/Settings routes have NO auth middleware — reachable without JWT  | **CRITICAL** | `agent-transfer-sessions.ts`, `agent-transfer-settings.ts` — no `requireAuth` |
| R-2 | PUT /settings accepts raw body with no schema validation                  | HIGH         | `agent-transfer-settings.ts:109-113`                                          |
| R-3 | Sessions list scans ALL tenants then filters in-memory (O(N))             | HIGH         | `agent-transfer-sessions.ts:65-100`                                           |
| R-4 | `deliverViaChatChannel` drops agent:connected/queued/typing events        | HIGH         | `message-bridge.ts:296-303`                                                   |
| R-5 | No WebSocket reconnection/pod-failover recovery — events silently dropped | HIGH         | `message-bridge.ts:158-163`                                                   |
| R-6 | Webhook secret is single hardcoded value, not per-provider                | HIGH         | `agent-transfer-webhooks.ts:72-73`                                            |
| R-7 | No warning log when webhookSecret absent (silent fail-open)               | MEDIUM       | `agent-transfer-webhooks.ts:74`                                               |
| R-8 | Boot blocks on `sessionRecoveryService.start()`                           | MEDIUM       | `agent-transfer/index.ts:193`                                                 |

### Core Package

| #   | Finding                                                                       | Severity | Evidence                                                            |
| --- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| C-1 | `AdapterRegistry.invalidateAuth()` is a no-op stub                            | HIGH     | `registry.ts:50-55` — gets adapter but never calls `invalidateAuth` |
| C-2 | `JWTAuth` has no `tokenUrl` branch — can't fetch real tokens                  | HIGH     | `jwt.ts:8-18`                                                       |
| C-3 | `getActiveSessions()` returns all sessions across all tenants                 | MEDIUM   | `transfer-session-store.ts:309-311`                                 |
| C-4 | `extendTTL()` race — HGETALL then pipeline allows session resurrection        | MEDIUM   | `transfer-session-store.ts:250-270`                                 |
| C-5 | `CsatHandler` stores `csatStartedAt` as string, not number                    | LOW      | `csat-handler.ts:48`                                                |
| C-6 | Recovery service does N sequential Redis round-trips (2000 for 1000 sessions) | MEDIUM   | `session-recovery-service.ts:205-263`                               |
| C-7 | `SdkNotificationQueue` has no dead letter integration                         | MEDIUM   | `sdk-notification-queue.ts`                                         |

### Studio UI

| #    | Finding                                                                    | Severity     | Evidence                                    |
| ---- | -------------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| S-1  | endTransferSession route returns 404 (no API route file exists)            | **CRITICAL** | `api/agent-transfer.ts:124` → missing route |
| S-2  | Voice config type mismatch — flat UI vs nested backend (data loss on save) | **CRITICAL** | `api/agent-transfer.ts:26-31`               |
| S-3  | TTL unit mismatch — UI says minutes, no conversion, backend stores seconds | HIGH         | `api/agent-transfer.ts:40`                  |
| S-4  | Priority enum: form uses normal/urgent, IR uses medium/critical            | HIGH         | `EscalationEditor.tsx:34`                   |
| S-5  | No search or pagination on TransferSessionsPage                            | HIGH         | `TransferSessionsPage.tsx:126-148`          |
| S-6  | No voice settings in EscalationEditor (transfer method, SIP headers)       | HIGH         | `EscalationEditor.tsx:402-566`              |
| S-7  | handleEndSession has no catch block — errors silently swallowed            | HIGH         | `TransferSessionsPage.tsx:96-108`           |
| S-8  | Provider filter hardcodes NICE/Five9 (not in registry)                     | MEDIUM       | `TransferSessionsPage.tsx:33-39`            |
| S-9  | OAuth2 flow unimplemented in CreateConnectionModal                         | MEDIUM       | `CreateConnectionModal.tsx:218-227`         |
| S-10 | All transfer UI strings hardcoded (no i18n)                                | MEDIUM       | 3 components                                |

### Voice/IVR

| #   | Finding                                                    | Severity | Evidence                                  |
| --- | ---------------------------------------------------------- | -------- | ----------------------------------------- |
| V-1 | VoiceGatewayRegistry unused — KoreVG never registers       | HIGH     | `message-bridge.ts:447-461`               |
| V-2 | Call transfer is SIP/PSTN only — no attended/consult types | HIGH     | `call-transfer.ts:21`                     |
| V-3 | `enableSpeechInput: false` hardcoded in both IVR tools     | MEDIUM   | `ivr-menu.ts:85`, `ivr-digit-input.ts:73` |
| V-4 | Call recording tool does not exist                         | HIGH     | — (compliance gap)                        |
| V-5 | Hold/unhold absent from VoiceGateway interface             | HIGH     | `voice-gateway.ts:20`                     |
| V-6 | No IVR or call-transfer form editors in Studio             | MEDIUM   | —                                         |

---

## Phase 1-4 Task Status (Plan Tasks Still Open)

| Task | Description                        | Status                                      |
| ---- | ---------------------------------- | ------------------------------------------- |
| 1    | Session update() TOCTOU Lua script | STILL OPEN                                  |
| 2    | Leader election TOCTOU             | STILL OPEN                                  |
| 3    | Timeout scheduler cross-pod cancel | PARTIAL (local OK, cross-pod broken)        |
| 4    | Auth token refresh (JWT + OAuth2)  | STILL OPEN (tests exist, impl is stub)      |
| 5    | SMEMBERS → SSCAN                   | STILL OPEN                                  |
| 6    | extendTTL N+1                      | PARTIAL (pipeline OK, HGETALL still called) |
| 12   | SmartAssist pool hardcoding        | STILL OPEN                                  |
| 14   | Dead letter tenant isolation       | STILL OPEN                                  |
| 15   | Graceful shutdown 5s → 15s         | STILL OPEN                                  |
| 22   | Rate limiter unbounded sorted set  | STILL OPEN                                  |
| 23   | Fallback executor OTel metrics     | STILL OPEN                                  |
| 24   | Queue depth in health checks       | STILL OPEN                                  |

---

## What's Working Well

| Area                                 | Status                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **A2A package**                      | Production-ready — full async/streaming/push/cancel lifecycle, Redis task store, SSRF guard, tracing, strong test coverage |
| **Tool wiring**                      | All 8 transfer tools wired via `TransferToolExecutor`, voice-only gate enforced, LLM tool definitions present              |
| **Transfer session store**           | Lua scripts for create/end/claim are atomic and correct                                                                    |
| **KoreAdapter + SmartAssist client** | Functional for webhook-initiated flows                                                                                     |
| **CSAT + Disposition handlers**      | Implemented with proper typing                                                                                             |
| **Studio Connection Hub**            | Category-based display, inline expand, 3-step create modal                                                                 |
| **EscalationEditor**                 | Routing sub-section with connection picker, queue/skills/priority                                                          |
| **ABL serializers**                  | ESCALATE round-trip (form ↔ DSL ↔ IR) including voice fields                                                               |
| **DeflectToChatTool**                | Complete with XO parity (automation vs agent transfer branches)                                                            |

---

## Gaps NOT in the 52-Task Plan

| #      | Gap                                                            | Severity | Notes                                    |
| ------ | -------------------------------------------------------------- | -------- | ---------------------------------------- |
| NEW-1  | **handleEscalate() → agent-transfer wiring**                   | CRITICAL | The showstopper — not in any plan        |
| NEW-2  | `AdapterRegistry.invalidateAuth()` is a no-op                  | HIGH     | `invalidateAuth` not on interface either |
| NEW-3  | `JWTAuth` has no `tokenUrl` code path                          | HIGH     | Tests expect it but impl doesn't have it |
| NEW-4  | Session timeout cross-pod cancel still broken                  | HIGH     | Plan Task 3 marked done but isn't        |
| NEW-5  | `getActiveSessions()` bypasses tenant isolation                | MEDIUM   | Global SMEMBERS, no per-tenant scope     |
| NEW-6  | `extendTTL()` race condition (HGETALL → pipeline)              | MEDIUM   | Can resurrect deleted sessions           |
| NEW-7  | `CsatHandler` stores string instead of number                  | LOW      | Silent type corruption                   |
| NEW-8  | Recovery service 2000 sequential Redis calls for 1000 sessions | MEDIUM   | Not just SMEMBERS — per-key checks too   |
| NEW-9  | OAuth2 flow unimplemented in CreateConnectionModal             | MEDIUM   | TODO comment in code                     |
| NEW-10 | No operational runbooks or alerting guidance                   | MEDIUM   | Not in any plan                          |

---

## Recommended Priority Order

### Immediate (blocks production)

1. **Wire handleEscalate() → agent-transfer** (NEW-1) — the showstopper
2. **Add auth middleware to sessions/settings routes** (R-1) — security critical
3. **Fix Phase 1 tasks 1, 2, 4** — plan said done but they're not

### Week 1 (data correctness)

4. Fix voice config flat→nested (S-2) — data loss on save
5. Fix priority enum mismatch (S-4) — silent data corruption
6. Fix TTL unit mismatch (S-3)
7. Add catch block to handleEndSession (S-7)
8. Fix cross-pod timeout cancel (C-3/Task 3)

### Week 2 (operational completeness)

9. Implement auth token refresh (Task 4)
10. Fix webhook security gaps (R-6, R-7)
11. Add WebSocket failover recovery (R-5)
12. Implement deliverViaChatChannel for status events (R-4)
13. Add search/pagination to TransferSessionsPage (S-5)

### Week 3+ (voice foundation)

14. Wire VoiceGatewayRegistry to KoreVG (V-1)
15. Add attended/consult call transfer (V-2)
16. Implement call recording tool (V-4)
17. Add hold/unhold to gateway interface (V-5)
18. Enable speech input in IVR tools (V-3)

---

## Test Coverage Gaps

1. **No TOCTOU race test** for concurrent `update()` on a just-ended session
2. **No cross-pod cancel test** for timeout scheduler
3. **Auth refresh tests exist but test unimplemented behavior** — will fail when run
4. **No recovery SSCAN test** with >100 sessions
5. **No per-tenant dead letter isolation test**
6. **Session lifecycle state machine transitions not tested** — no guard for `ended → active`
7. **No E2E test** for `__escalate__` → transfer session → webhook → message delivery → post-agent
