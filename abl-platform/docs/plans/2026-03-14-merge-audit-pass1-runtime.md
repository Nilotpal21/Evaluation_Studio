# Merge Audit Pass 1 — Runtime Package

**Date:** 2026-03-14
**Merge:** `feature/trace-platform-infrastructure-v2` into `develop`
**Auditor:** Claude (automated)

---

## 1. `apps/runtime/src/routes/channel-genesys.ts`

**Verdict: FAIL — `session.runtimeSessionId` does not exist on `ResolvedSession`**

Both sides' imports are correctly preserved:

- Develop: `extractIngressToken`, `tokensMatch` from `@agent-platform/shared-kernel/security` — VERIFIED exported at `packages/shared-kernel/src/security/index.ts:21`.
- Branch: `emitChannelResponseSent` from `../services/channel-trace-utils.js` — VERIFIED exported at line 23 of that file.
- `emitChannelResponseSent` IS used at line 157 — no dead import.

**Bug (lines 157, 160):** The call `emitChannelResponseSent(session.runtimeSessionId, ...)` accesses `session.runtimeSessionId`, but `resolveSession()` returns `ResolvedSession { channelSessionId, sessionId, isNew }` (defined at `apps/runtime/src/channels/session-resolver.ts:67-71`). There is no `runtimeSessionId` property. The value will be `undefined`, causing the trace event to have an empty/undefined `session_id` in ClickHouse.

Additionally, line 160 calls `executor.getSession(session.runtimeSessionId)` with `undefined`, which will return `undefined`, so `configHash` will always be missing.

**Correct property:** `session.sessionId` (which IS the runtime session ID — see session-resolver.ts line 127 where `sessionId = newSession.id`).

---

## 2. `apps/runtime/src/routes/channel-vxml.ts`

**Verdict: FAIL — same `session.runtimeSessionId` bug as genesys**

Both sides' imports are correctly preserved:

- Develop: `extractIngressToken`, `tokensMatch` from `@agent-platform/shared-kernel/security` — VERIFIED.
- Branch: `emitChannelResponseSent` from `../services/channel-trace-utils.js` — VERIFIED.
- `emitChannelResponseSent` IS used at line 199 — no dead import.

**Bug (lines 199, 202):** Identical to genesys — `session.runtimeSessionId` is `undefined` because `ResolvedSession` does not have that property. Should be `session.sessionId`.

---

## 3. `apps/runtime/src/routes/platform-admin-tenants.ts`

**Verdict: PASS — all schemas used, no route conflicts**

All declared schemas are used in route handlers:
| Schema | Used at |
|--------|---------|
| `statusChangeSchema` | Line 325 — `PATCH /:tenantId/status` |
| `subscriptionChangeSchema` | Line 370 — `PATCH /:tenantId/subscription` |
| `addMemberSchema` | Line 480 — `POST /:tenantId/members` |
| `updateMemberRoleSchema` | Line 599 — `PATCH /:tenantId/members/:userId` |
| `createTenantSchema` | Line 206 — `POST /` |
| `createProjectSchema` | Line 710 — `POST /:tenantId/projects` |
| `VALID_MEMBER_ROLES` | Lines 51, 56 — used by `addMemberSchema` and `updateMemberRoleSchema` |

Route paths are non-overlapping:

- `GET /` — list tenants (develop)
- `POST /` — create tenant (branch)
- `GET /:tenantId` — tenant detail (develop)
- `PATCH /:tenantId/status` — status change (develop)
- `PATCH /:tenantId/subscription` — plan change (develop)
- `GET /:tenantId/members` — list members (branch)
- `POST /:tenantId/members` — add member (branch)
- `DELETE /:tenantId/members/:userId` — remove member (branch)
- `PATCH /:tenantId/members/:userId` — update role (branch)
- `GET /:tenantId/projects` — list projects (branch)
- `POST /:tenantId/projects` — create project (branch)
- `DELETE /:tenantId/projects/:projectId` — delete project (branch)

Both develop (subscription management) and branch (member/project CRUD, tenant creation) goals fully preserved.

---

## 4. `apps/runtime/src/services/queues/inbound-worker.ts`

**Verdict: FAIL — `session.runtimeSessionId` does not exist on `ResolvedSession`**

Imports verified:

- `runWithObservabilityContext` from `@abl/compiler/platform/observability` — VERIFIED exported at `packages/compiler/src/platform/observability/index.ts:11`.
- `extractTrace` from `@agent-platform/shared-observability/tracing` — VERIFIED exported at `packages/shared-observability/src/tracing/index.ts:18`.
- `injectTrace` — VERIFIED at same location. Used at line 1071 for delivery job trace propagation.
- `emitChannelResponseSent` — VERIFIED. Used at line 1205.

Observability context wrapping at line 958 is correctly wired — `runWithObservabilityContext({ traceId, spanId }, () => executor.executeMessage(...))`.

**Bug (lines 960, 1206):** `session.runtimeSessionId` is used in two places:

1. Line 960: `executor.executeMessage(session.runtimeSessionId, ...)` — passes `undefined` as the session ID to the runtime executor. This will cause `executeMessage` to fail or look up a nonexistent session.
2. Line 1206: `emitChannelResponseSent(session.runtimeSessionId, ...)` — same issue as channel routes; trace event gets `undefined` session ID.

The `session` variable is assigned at line 152 via `resolveSession(resolvedConnection, payload.message)` which returns `ResolvedSession { channelSessionId, sessionId, isNew }`. The correct property is `session.sessionId`.

**Severity:** This is a **critical runtime bug** — line 960 means every async channel message (Slack, WhatsApp, LINE, MS Teams, email, Telegram, etc.) will fail to execute because the executor receives `undefined` instead of a valid session ID.

---

## 5. `apps/runtime/src/routes/agent-transfer-webhooks.ts`

**Verdict: PASS — no merge-related issues**

This file was not in conflict. It correctly:

- Validates `isAgentTransferInitialized()` before processing
- Enforces tenant isolation (orgId vs session.tenantId, returns 404 on mismatch per platform invariant)
- Uses `KoreEventHandler.mapEventType` for XO event normalization
- Follows error envelope pattern `{ success, error: { code, message } }`

No references to `runtimeSessionId` or other properties affected by the merge.

---

## Summary

| File                         | Verdict  | Issue                                                                                                                       |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `channel-genesys.ts`         | **FAIL** | `session.runtimeSessionId` is `undefined`; should be `session.sessionId` (lines 157, 160)                                   |
| `channel-vxml.ts`            | **FAIL** | Same bug (lines 199, 202)                                                                                                   |
| `platform-admin-tenants.ts`  | **PASS** | All schemas used, no route conflicts                                                                                        |
| `inbound-worker.ts`          | **FAIL** | `session.runtimeSessionId` is `undefined` at lines 960, 1206. Line 960 is **critical** — breaks all async channel execution |
| `agent-transfer-webhooks.ts` | **PASS** | No merge-related issues                                                                                                     |

### Root Cause

The feature branch introduced `runtimeSessionId` as a new property name, likely expecting the `ResolvedSession` interface to be updated. However, the interface at `apps/runtime/src/channels/session-resolver.ts:67-71` still defines only `{ channelSessionId, sessionId, isNew }`. The property `sessionId` in `ResolvedSession` IS the runtime session ID (assigned from `newSession.id` at line 127), so it is a naming mismatch — not missing data.

### Impact

- **3 files affected** with the same root cause
- **Critical path broken:** inbound-worker line 960 passes `undefined` to `executeMessage`, breaking all async channel message processing
- **Observability degraded:** trace events in all 3 files emit with `undefined` session IDs
