# Merge Audit Pass 4 -- Search-AI Workers

**Date:** 2026-03-14
**Branch:** `feature/trace-platform-infrastructure-v2` merged into `develop`
**Scope:** All 6 IdP sync workers + shared utilities

---

## 1. `apps/search-ai/src/workers/shared.ts` -- PASS

All required elements verified:

| Check                                                                              | Status | Details                                                                              |
| ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| `crypto` imported                                                                  | PASS   | Line 9: `import crypto from 'crypto';`                                               |
| `extractTrace` imported from `@agent-platform/shared-observability/tracing`        | PASS   | Line 18                                                                              |
| `runWithObservabilityContext` imported from `@abl/compiler/platform/observability` | PASS   | Line 19                                                                              |
| `workerLoggers` Map                                                                | PASS   | Line 67: `const workerLoggers = new Map<string, ReturnType<typeof createLogger>>();` |
| `getWorkerLogger` function                                                         | PASS   | Lines 69-76                                                                          |
| `workerLog` exported                                                               | PASS   | Line 78                                                                              |
| `workerError` exported                                                             | PASS   | Line 82, uses `err instanceof Error ? err.message : String(err)` (correct pattern)   |
| `withTraceContext` exported                                                        | PASS   | Lines 101-107, uses `extractTrace` + `runWithObservabilityContext`                   |
| `withTraceContext` generates fallback IDs                                          | PASS   | Lines 103-104: `crypto.randomUUID()` for traceId/spanId when extraction returns null |

No issues found.

---

## 2. `apps/search-ai/src/workers/azuread-group-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                                             |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 36                                                                                                                                             |
| `withTenantContext` imported                          | PASS   | Line 29 from `@agent-platform/database/mongo`                                                                                                       |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 266-267: `await withTraceContext(job.data as unknown as Record<string, unknown>, () => withTenantContext({ tenantId }, async () => { ... }))` |
| Auth profile dual-read preserved                      | PASS   | Lines 272-293: checks `authProfileId`, imports `isAuthProfileEnabled`, calls `resolveAuthProfileCredential`, falls back to legacy                   |
| Worker processes data correctly                       | PASS   | Fetches groups via Graph API, fetches members per group, upserts GroupNode/MEMBER_OF to Neo4j, stores delta token, invalidates cache                |

No issues found.

---

## 3. `apps/search-ai/src/workers/azuread-user-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                              |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 34                                                                                                                              |
| `withTenantContext` imported                          | PASS   | Line 27 from `@agent-platform/database/mongo`                                                                                        |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 216-217                                                                                                                        |
| Auth profile dual-read preserved                      | PASS   | Lines 222-243: identical pattern -- `authProfileId` check, `isAuthProfileEnabled()`, `resolveAuthProfileCredential`, legacy fallback |
| Worker processes data correctly                       | PASS   | Fetches users via Graph API, filters active users, batch upserts UserNode to Neo4j, stores delta token, invalidates cache            |

No issues found.

---

## 4. `apps/search-ai/src/workers/google-group-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                                       |
| ----------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 38                                                                                                                                       |
| `withTenantContext` imported                          | PASS   | Line 31 from `@agent-platform/database/mongo`                                                                                                 |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 278-279                                                                                                                                 |
| Auth profile dual-read preserved                      | PASS   | Lines 284-305: identical pattern                                                                                                              |
| Worker processes data correctly                       | PASS   | Fetches groups via Google Directory API, fetches members per group, upserts GroupNode/MEMBER_OF to Neo4j, stores timestamp, invalidates cache |

No issues found.

---

## 5. `apps/search-ai/src/workers/google-user-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                                                                             |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 36                                                                                                                                                                             |
| `withTenantContext` imported                          | PASS   | Line 29 from `@agent-platform/database/mongo`                                                                                                                                       |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 239-240                                                                                                                                                                       |
| Auth profile dual-read preserved                      | PASS   | Lines 245-266: identical pattern                                                                                                                                                    |
| Worker processes data correctly                       | PASS   | Fetches users via Google Directory API with client-side delta filtering, filters active (non-suspended) users, batch upserts UserNode to Neo4j, stores timestamp, invalidates cache |

No issues found.

---

## 6. `apps/search-ai/src/workers/okta-group-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                                                                   |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 37                                                                                                                                                                   |
| `withTenantContext` imported                          | PASS   | Line 29 from `@agent-platform/database/mongo`                                                                                                                             |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 292-293                                                                                                                                                             |
| Auth profile dual-read preserved                      | PASS   | Lines 298-319: identical pattern                                                                                                                                          |
| Worker processes data correctly                       | PASS   | Fetches groups via Okta API with Link-header pagination, fetches members per group, upserts GroupNode/MEMBER_OF to Neo4j, stores lastUpdated timestamp, invalidates cache |

No issues found.

---

## 7. `apps/search-ai/src/workers/okta-user-sync-worker.ts` -- PASS

| Check                                                 | Status | Details                                                                                                                                                                      |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTraceContext` imported from `./shared.js`        | PASS   | Line 34                                                                                                                                                                      |
| `withTenantContext` imported                          | PASS   | Line 27 from `@agent-platform/database/mongo`                                                                                                                                |
| Nesting: `withTraceContext` wraps `withTenantContext` | PASS   | Lines 239-240                                                                                                                                                                |
| Auth profile dual-read preserved                      | PASS   | Lines 245-266: identical pattern                                                                                                                                             |
| Worker processes data correctly                       | PASS   | Fetches users via Okta API with filter-based delta query, filters ACTIVE/PROVISIONED users, batch upserts UserNode to Neo4j, stores lastUpdated timestamp, invalidates cache |

No issues found.

---

## Summary

| File                           | Verdict |
| ------------------------------ | ------- |
| `shared.ts`                    | PASS    |
| `azuread-group-sync-worker.ts` | PASS    |
| `azuread-user-sync-worker.ts`  | PASS    |
| `google-group-sync-worker.ts`  | PASS    |
| `google-user-sync-worker.ts`   | PASS    |
| `okta-group-sync-worker.ts`    | PASS    |
| `okta-user-sync-worker.ts`     | PASS    |

**Overall: 7/7 PASS. All workers correctly integrate `withTraceContext` wrapping `withTenantContext`, and all preserve auth profile dual-read with legacy fallback.**

### Consistent patterns across all 6 workers

1. **Trace context wrapping**: `await withTraceContext(job.data as unknown as Record<string, unknown>, () => withTenantContext({ tenantId }, async () => { ... }));` -- outer trace, inner tenant. Correct ordering.
2. **Auth profile dual-read**: All 6 workers use the same pattern -- check `authProfileId` from job data, dynamically import `isAuthProfileEnabled`, call `resolveAuthProfileCredential`, catch errors and fall back to legacy `LLMCredential.findOne({ _id: credentialId, tenantId, isActive: true })`.
3. **Job data interfaces**: All 6 `*SyncJobData` interfaces in `shared.ts` include `authProfileId?: string` (optional for backward compat).
4. **Tenant isolation**: All credential lookups use `{ _id, tenantId }` (never `findById`). All `findOneAndUpdate` calls scope by tenantId.
5. **Error handling**: All workers use `error instanceof Error ? error.message : String(error)` pattern. All use AbortController timeouts on external API calls.
