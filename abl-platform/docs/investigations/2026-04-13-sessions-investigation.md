# BullMQ ALS Context Leak — Root Cause Analysis

**Date:** 2026-04-13
**Environment:** agents-dev.kore.ai
**Reported Issues:**

1. Chat sessions are getting deleted after a few minutes
2. Chat data (messages) not being saved to MongoDB / ClickHouse

**Status:** Root cause identified, fix pending

---

## Executive Summary

Both reported issues share a single root cause: the BullMQ message persistence worker runs without tenant context isolation, allowing a concurrent HTTP/WebSocket request's tenant identity to leak into the worker's database operations. This causes cross-tenant write rejections, which silently prevents message persistence and triggers automatic session cleanup.

The issue only manifests in environments with Redis (dev, staging, production) — never locally — because the BullMQ pipeline is only active when Redis is available.

---

## Reported Symptoms

| #   | Symptom                                          | Impact                                                                     |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | Chat sessions disappear after a few minutes      | Users lose conversation history; sessions appear to never have existed     |
| 2   | Chat messages not saved to MongoDB or ClickHouse | No persistent record of conversations; analytics pipeline receives no data |

---

## Root Cause: AsyncLocalStorage Context Leak

### Background

The platform uses Node.js `AsyncLocalStorage` (ALS) for tenant isolation. Every HTTP/WebSocket request runs inside a tenant-scoped ALS context. The Mongoose `tenant-isolation.plugin.ts` reads this context on every database operation and rejects writes where the document's `tenantId` doesn't match the ALS context's `tenantId`.

### The Bug

The BullMQ worker in `message-persistence-queue.ts` processes message persistence jobs in the **same Node.js process** as the Express/WebSocket handlers. The worker's job handler (`workerJobHandler`, line ~221) has **no ALS wrapper**. When a BullMQ job executes while a concurrent HTTP/WebSocket request is in-flight, the worker inherits that request's tenant ALS context.

### The Two Tenant IDs

| Tenant ID           | Source                                                                            | How it gets there                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tenant-dev-001`    | The message job data — set when `persistMessage()` was called from the WS handler | Passed explicitly in the MongoDB query: `Session.updateOne({ _id, tenantId: 'tenant-dev-001' })`                                 |
| `019d1a05-7733-...` | Leaked ALS context from a **concurrent** HTTP/WS request for a different tenant   | The `tenant-isolation.plugin.ts` reads `getCurrentTenantContext()` which returns the shared-auth ALS from the concurrent request |

### The Race Condition

```
[HTTP request for tenant 019d1a05...]     [BullMQ worker for tenant-dev-001 job]
         │                                          │
  runWithTenantContext(019d1a05...)         workerJobHandler(job)  ← NO ALS wrapper
         │                                          │
  sets ALS: tenantId=019d1a05...           Session.updateOne({tenantId: 'tenant-dev-001'})
         │                                          │
         │                                   pre-hook → getCurrentTenantContext()
         │                                          │
         │                                   reads leaked ALS → tenantId=019d1a05...
         │                                          │
         │                               'tenant-dev-001' ≠ '019d1a05...' → VIOLATION!
```

### Failure Chain

```
ALS leak
  → tenant-isolation.plugin.ts rejects cross-tenant write
    → Message.insertMany() fails with "Tenant isolation violation"
      → BullMQ retries 5 times, all fail (ALS leak is persistent)
        → Messages never reach MongoDB (Issue #2)
          → messageCount stays at 0, session metric updates also fail silently
            → endSession() sees zero durable activity
              → Session is cascade-deleted as a "ghost" (Issue #1)
```

---

## Why It Only Fails in Dev (Not Locally)

| Condition                            | Local                                     | Dev (agents-dev.kore.ai)                             |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------------- |
| Redis available                      | No                                        | Yes                                                  |
| BullMQ worker active                 | No — falls back to direct DB writes       | Yes — messages go through BullMQ pipeline            |
| Message persistence path             | Synchronous, inside request's ALS context | Async, in BullMQ worker with no ALS wrapper          |
| Multiple tenants active concurrently | Rare (single developer)                   | Yes — multiple tenants hitting the same runtime      |
| ALS leak possible                    | No — no BullMQ, no shared worker          | Yes — worker shares event loop with request handlers |

**Locally:** `persistMessage()` detects no Redis, falls back to `store.addMessage()` which runs inside the request's correct ALS context. No cross-tenant contamination is possible.

**In dev:** `persistMessage()` enqueues to BullMQ. The worker processes the job in the same event loop, potentially during another tenant's request, inheriting the wrong ALS context.

---

## Why It Wasn't Caught Earlier

1. **Local development never exercises BullMQ** — no Redis means direct writes in the correct ALS context.
2. **Single-tenant testing** — when only one tenant is active, the leaked ALS context matches the job's tenant. No violation.
3. **Silent failure** — the BullMQ `failed` event logs the error, but session metric updates are fire-and-forget (`.catch()` only warns). No user-visible error is raised.
4. **Evidence destruction** — `endSession()` cascade-deletes sessions with zero activity, removing the session and any partial data. It appears as if the session never existed.
5. **Tests mock the database layer** — unit tests use `vi.mock('@agent-platform/database/models')`, so the real tenant-isolation plugin never fires during testing.

---

## Affected Code Locations

| File                                                             | Line | Role                                                                |
| ---------------------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| `apps/runtime/src/services/message-persistence-queue.ts`         | ~221 | `workerJobHandler()` — **missing ALS wrapper** (the bug)            |
| `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts` | ~168 | `injectTenantFilter()` — compares filter tenantId vs ALS tenantId   |
| `apps/runtime/src/db/index.ts`                                   | ~42  | Registers shared-auth's ALS as the external tenant context provider |
| `apps/runtime/src/services/stores/mongo-conversation-store.ts`   | ~282 | `endSession()` cascade-deletes sessions with zero durable activity  |

---

## Proposed Fix

Isolate the BullMQ worker's job handler from the shared-auth ALS context so the tenant-isolation plugin does not pick up a stale or unrelated tenant identity from a concurrent request. The worker already passes `tenantId` explicitly in every query filter and document field — the plugin's ALS-based auto-injection is redundant for this code path and actively harmful when it reads a leaked context.

**Location:** `message-persistence-queue.ts` `createWorker()` — wrap the worker callback so it runs in a clean, isolated ALS context that cannot be contaminated by concurrent request handlers.

**Risk:** Low. No query or document in the worker relies on ALS-injected tenant context — all tenant scoping is explicit in the job data.

**Scope:** Single file change, no architectural impact, no API changes.

---

## Verification Plan

1. Deploy the fix to `agents-dev.kore.ai`
2. Create chat sessions with two different tenants concurrently
3. Verify sessions persist beyond the idle timeout
4. Verify messages appear in MongoDB (`messages` collection) and ClickHouse
5. Confirm runtime logs show zero `Tenant isolation violation` errors
6. Confirm `BullMQ message-persistence job failed permanently` count drops to zero

---

## Related Commit

Commit `bae179dba` ([ABLP-273] fix(runtime): harden zero-activity session heuristics) did not introduce this bug. It hardened the `endSession()` activity check by also querying `MessageModel.exists()` and `AttachmentModel.exists()`. This made the pre-existing ALS leak **visible** — sessions that previously sat with zero counters (but weren't actively checked) are now thoroughly checked and cascade-deleted when no persisted data is found.
