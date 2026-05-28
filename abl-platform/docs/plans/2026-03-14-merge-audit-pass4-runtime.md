# Merge Audit Pass 4 — Runtime Files

**Date:** 2026-03-14
**Branch:** `feature/trace-platform-infrastructure-v2` → `develop`
**Auditor:** Claude Opus 4.6

---

## 1. `apps/runtime/src/services/queues/inbound-worker.ts`

**PASS**

| Check                                                     | Result                                                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `session.runtimeSessionId` references                  | PASS — All session references use `session.sessionId` (lines 155, 419, 438, 479, 571, 632, 691, 750, 770, 830, 870, 890, 931, 960, 1017, 1084, 1105, 1135, 1151, 1183, 1198, 1206, 1227) |
| `extractTrace` imported                                   | PASS — Line 17: `import { extractTrace, injectTrace } from '@agent-platform/shared-observability/tracing'`                                                                               |
| `runWithObservabilityContext` imported                    | PASS — Line 16: `import { runWithObservabilityContext } from '@abl/compiler/platform/observability'`                                                                                     |
| `executeMessage` wrapped in `runWithObservabilityContext` | PASS — Lines 958-977: `runWithObservabilityContext({ traceId, spanId }, () => executor.executeMessage(...))`                                                                             |
| `emitChannelResponseSent` imported                        | PASS — Line 21: `import { emitChannelResponseSent } from '../channel-trace-utils.js'`                                                                                                    |
| `emitChannelResponseSent` called with correct args        | PASS — Lines 1205-1214: called with `(session.sessionId, payload.channelType, durationMs, { tenantId, projectId, traceId })`                                                             |

---

## 2. `apps/runtime/src/routes/channel-genesys.ts`

**PASS**

| Check                                                                        | Result                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Import from `@agent-platform/shared-kernel/security`                         | PASS — Line 28: `import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security'`                           |
| `emitChannelResponseSent` imported from `../services/channel-trace-utils.js` | PASS — Line 29                                                                                                                        |
| No `runtimeSessionId` on `session.` object                                   | PASS — All references use `session.sessionId` (lines 109, 115, 138, 153, 157, 160)                                                    |
| `emitChannelResponseSent` called with `session.sessionId`                    | PASS — Line 157: `emitChannelResponseSent(session.sessionId, 'genesys', Date.now() - startTime, { tenantId, projectId, configHash })` |

---

## 3. `apps/runtime/src/routes/channel-vxml.ts`

**PASS**

| Check                                                                        | Result                                                                                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Import from `@agent-platform/shared-kernel/security`                         | PASS — Line 27: `import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security'`                        |
| `emitChannelResponseSent` imported from `../services/channel-trace-utils.js` | PASS — Line 28                                                                                                                     |
| No `runtimeSessionId` on `session.` object                                   | PASS — All references use `session.sessionId` (lines 129, 135, 156, 195, 199, 202)                                                 |
| `emitChannelResponseSent` called with `session.sessionId`                    | PASS — Line 199: `emitChannelResponseSent(session.sessionId, 'vxml', Date.now() - startTime, { tenantId, projectId, configHash })` |

---

## 4. `apps/runtime/src/routes/channel-audiocodes.ts`

**PASS**

| Check                                                                        | Result                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Import from `@agent-platform/shared-kernel/security`                         | PASS — Line 32: `import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security'`                              |
| `emitChannelResponseSent` imported from `../services/channel-trace-utils.js` | PASS — Line 47                                                                                                                           |
| No `session.runtimeSessionId`                                                | PASS — All session references use `session.sessionId` (lines 199, 205, 240, 274)                                                         |
| `emitChannelResponseSent` called with `session.sessionId`                    | PASS — Line 274: `emitChannelResponseSent(session.sessionId, 'audiocodes', Date.now() - startTime, { tenantId, projectId, configHash })` |

---

## 5. `apps/runtime/src/routes/platform-admin-tenants.ts`

**PASS**

| Check                                        | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subscriptionChangeSchema` exists (develop)  | PASS — Lines 46-48: `z.object({ planTier: z.enum(VALID_PLAN_TIERS) })`                                                                                                                                                                                                                                                                                                                     |
| Member/tenant/project schemas exist (branch) | PASS — `addMemberSchema` (line 50), `updateMemberRoleSchema` (line 55), `createTenantSchema` (line 59), `createProjectSchema` (line 69)                                                                                                                                                                                                                                                    |
| All schemas used in route handlers           | PASS — `statusChangeSchema` → PATCH `/:tenantId/status` (line 325); `subscriptionChangeSchema` → PATCH `/:tenantId/subscription` (line 370); `addMemberSchema` → POST `/:tenantId/members` (line 480); `updateMemberRoleSchema` → PATCH `/:tenantId/members/:userId` (line 599); `createTenantSchema` → POST `/` (line 206); `createProjectSchema` → POST `/:tenantId/projects` (line 710) |
| `VALID_MEMBER_ROLES` constant exists         | PASS — Line 40: `['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const`                                                                                                                                                                                                                                                                                                                          |
| No conflicting/duplicate route paths         | PASS — All 12 route paths are unique and non-overlapping                                                                                                                                                                                                                                                                                                                                   |

**Route inventory (no conflicts):**

- `GET /` — List tenants
- `POST /` — Create tenant
- `GET /:tenantId` — Tenant detail
- `PATCH /:tenantId/status` — Change status
- `PATCH /:tenantId/subscription` — Change plan tier
- `GET /:tenantId/members` — List members
- `POST /:tenantId/members` — Add member
- `DELETE /:tenantId/members/:userId` — Remove member
- `PATCH /:tenantId/members/:userId` — Update member role
- `GET /:tenantId/projects` — List projects
- `POST /:tenantId/projects` — Create project
- `DELETE /:tenantId/projects/:projectId` — Delete project

---

## 6. `apps/runtime/src/services/channel-trace-utils.ts`

**PASS**

| Check                                 | Result                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| File exists                           | PASS                                                           |
| Exports `emitChannelResponseSent`     | PASS — Line 23: `export function emitChannelResponseSent(...)` |
| Function signature matches call sites | PASS                                                           |

**Signature:**

```typescript
export function emitChannelResponseSent(
  sessionId: string,
  channel: string,
  durationMs: number,
  opts?: {
    tenantId?: string;
    projectId?: string;
    traceId?: string;
    configHash?: string;
  },
): void;
```

**Call site compatibility:**

- **genesys** (line 157): `(session.sessionId, 'genesys', durationMs, { tenantId, projectId, configHash })` — matches
- **vxml** (line 199): `(session.sessionId, 'vxml', durationMs, { tenantId, projectId, configHash })` — matches
- **audiocodes** (line 274): `(session.sessionId, 'audiocodes', durationMs, { tenantId, projectId, configHash })` — matches
- **inbound-worker** (line 1205): `(session.sessionId, payload.channelType, durationMs, { tenantId, projectId, traceId })` — matches (uses `traceId` instead of `configHash`, both optional)

---

## Summary

| File                        | Verdict  |
| --------------------------- | -------- |
| `inbound-worker.ts`         | **PASS** |
| `channel-genesys.ts`        | **PASS** |
| `channel-vxml.ts`           | **PASS** |
| `channel-audiocodes.ts`     | **PASS** |
| `platform-admin-tenants.ts` | **PASS** |
| `channel-trace-utils.ts`    | **PASS** |

**All 6 files pass audit. No issues found.**
