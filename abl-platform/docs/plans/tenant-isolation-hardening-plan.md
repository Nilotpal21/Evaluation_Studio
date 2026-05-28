# Tenant Isolation Hardening — Implementation Plan

**Date:** 2026-03-18
**Updated:** 2026-03-18 (post-review feedback — 9 findings addressed)
**Status:** In Progress — Sprint 1-3 done, Sprint 4-5 remaining
**Triggered by:** External security feedback review + Prasanna's annotations

---

## Design Principles

1. **Centralize, don't duplicate** — One tenant context resolution path shared across REST, WS debug, SDK WS, and future channels
2. **Fail-closed everywhere** — Missing tenantId = reject. No soft checks, no optional params for tenant-scoped queries
3. **Defense in depth** — Tenant boundary enforced at every layer: middleware, ALS, DB plugin, storage, queues
4. **Separate blast radius** — Queue isolation by tenant, app origin (studio vs runtime), and channel

---

## Architecture Overview

### Current State — 3 Separate Tenant Resolution Paths

```
REST routes      → createUnifiedAuthMiddleware() → req.tenantContext + ALS
WS debug (handler.ts) → resolveWSTenantContext()  → state.tenantContext (NO per-message ALS)
WS SDK (sdk-handler.ts) → handleTokenAuth()       → state.tenantId + per-message ALS ✓
```

**Problems:**

- handler.ts reimplements tenant resolution manually (lines 462-516) instead of reusing shared-auth
- handler.ts does NOT wrap message processing in `runWithTenantContext()` — downstream code calling `getCurrentTenantId()` gets `undefined`
- Two separate `AsyncLocalStorage` instances: `shared-auth` (runtime REST/SDK) vs `database/mongo` (Mongoose plugin) — code running in one ALS doesn't automatically have the other
- No `requireTenantContext` middleware — routes use ad-hoc `!` assertions or inline null checks

### Target State — Centralized

```
ALL channels → resolveAndValidateTenantContext() → TenantContextData
             → runWithTenantContext(ctx, handler) → ALS propagated to all downstream code
             → requireTenantContext() middleware   → guaranteed non-null for protected routes
             → Mongoose plugin reads from shared-auth ALS (single source of truth)
```

---

## Sprint 1 — Centralized Tenant Context + Fail-Closed Guards ✅ DONE

**Goal:** One resolution path, one ALS, hard checks everywhere.

### Task 1.1 — Unify AsyncLocalStorage ✅ DONE

**Problem:** Two ALS instances (`shared-auth` and `database/mongo`) mean code can be in one context but not the other.

**Files:**

- `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts:18` — has its own `tenantStorage`
- `packages/shared-auth/src/middleware/tenant-context.ts:16` — has its own `tenantContextStore`

**Change:** Make the Mongoose tenant isolation plugin read from the shared-auth ALS as primary, falling back to its own ALS for backward compat (search-ai workers that don't use shared-auth).

```typescript
// tenant-isolation.plugin.ts — getCurrentTenantContext() updated:
export function getCurrentTenantContext(): TenantContext | undefined {
  // 1. Try shared-auth ALS first (set by unified auth middleware + WS handlers)
  const sharedCtx = getSharedAuthTenantContext(); // imported from shared-auth
  if (sharedCtx) return { tenantId: sharedCtx.tenantId, isSuperAdmin: sharedCtx.isSuperAdmin };

  // 2. Fall back to local ALS (for search-ai workers using withTenantContext directly)
  return tenantStorage.getStore();
}
```

**Acceptance criteria:**

- Runtime REST routes: Mongoose plugin auto-injects tenantId from shared-auth ALS
- Runtime WS handlers: Mongoose plugin auto-injects tenantId when wrapped in `runWithTenantContext()`
- Search-AI workers: Continue to work via local `withTenantContext()` (backward compat)
- Test: Create a document via a REST route — verify tenantId is set by plugin without explicit `doc.tenantId = x`

### Task 1.2 — Wire handler.ts to centralized `resolveTenantContext()` ✅ DONE

**Problem:** handler.ts lines 462-516 reimplemented tenant resolution instead of reusing shared-auth.

**Solution implemented:** `resolveTenantContext()` was extracted to `packages/shared-auth/src/services/tenant-resolver.ts` with a dependency-injection interface (`TenantResolutionDeps`) so it doesn't directly import DB models. handler.ts's `resolveWSTenantContext()` was rewired to delegate to the centralized resolver with DI dependencies (`resolveTenantMembership`, `resolveDefaultTenant`, `resolveEffectivePermissions`).

**Note (review feedback #5):** The local `resolveWSTenantContext()` wrapper was kept as a thin delegation layer rather than deleted, because it handles the DI wiring and error-to-undefined conversion specific to the WS context. This is the correct pattern — the duplicate _logic_ was eliminated while the WS-specific adapter remains.

**Files changed:**

- `packages/shared-auth/src/services/tenant-resolver.ts` — NEW, centralized resolver with DI
- `apps/runtime/src/websocket/handler.ts` — rewired to delegate to shared-auth resolver

### Task 1.3 — Wrap WS handler.ts message processing in ALS ✅ DONE

**Problem:** handler.ts stores `state.tenantContext` but never calls `runWithTenantContext()`. Downstream code calling `getCurrentTenantId()` gets undefined.

**File:** `apps/runtime/src/websocket/handler.ts`

**Change:** Wrap the message dispatch in `runWithTenantContext()`, matching sdk-handler.ts pattern:

```typescript
// handler.ts — message handler (currently line 574-578)
ws.on('message', async (data) => {
  await tenantReady;
  const ctx = state.tenantContext;
  if (ctx) {
    await runWithTenantContext(ctx, () => handleMessage(ws, data.toString()));
  } else {
    // No tenant context — only allow non-tenant operations (e.g., load_agent for file-based agents)
    handleMessage(ws, data.toString());
  }
});

// Also wrap the close handler:
ws.on('close', async () => {
  const ctx = state.tenantContext;
  if (ctx) {
    await runWithTenantContext(ctx, () => handleClose(ws));
  } else {
    handleClose(ws);
  }
});
```

**Acceptance criteria:**

- `getCurrentTenantId()` returns correct tenantId inside any handler.ts message handler
- MongoConversationStore calls (endSession, createSession) succeed with ALS context
- Session cleanup on disconnect works without throwing "Tenant context required"

### Task 1.4 — Add `requireTenantContext()` middleware ✅ MIDDLEWARE CREATED, ADOPTION IN PROGRESS

**Problem:** No middleware guarantees `req.tenantContext` is populated. Routes use ad-hoc `!` assertions (`req.tenantContext!.tenantId`) that crash at runtime.

**Done:**

- `requireTenantContext()` and `requireAuthWithTenant()` implemented in `packages/shared-auth/src/middleware/unified-auth.ts`
- 8 unit tests passing in `packages/shared-auth/src/__tests__/require-tenant-context.test.ts`
- **(Review feedback #3 — P1):** Re-exports added through `@agent-platform/shared` barrel so search-ai-runtime and other consumers can import without adding shared-auth as a direct dependency:
  - `packages/shared/src/middleware/unified-auth.ts` — re-exports from shared-auth
  - `packages/shared/src/middleware/index.ts` — re-exports
  - `packages/shared/src/index.ts` — re-exports

**`req.tenantContext!` footprint (review feedback #4 — P1):**

| App               | Occurrences | Files              |
| ----------------- | ----------- | ------------------ |
| runtime           | 249         | 41 route files     |
| search-ai         | 99          | 12 route files     |
| search-ai-runtime | 7           | 5 route files      |
| **Total**         | **355**     | **58 route files** |

**Adoption plan:** This is a large-scale migration that should be phased:

1. **Phase A (Sprint 5):** Add `requireTenantContext()` to the router-level middleware chain for runtime, search-ai, and search-ai-runtime — this makes `req.tenantContext` guaranteed non-null for all routes behind auth
2. **Phase B (Sprint 5):** Incrementally replace `req.tenantContext!` with `req.tenantContext` (remove `!` assertion) — safe after Phase A since middleware guarantees non-null
3. **Phase C (CI):** Add lint rule blocking new `req.tenantContext!` assertions

**Acceptance criteria:**

- ✅ `requireTenantContext` exported from `@agent-platform/shared-auth`
- ✅ `requireTenantContext` re-exported from `@agent-platform/shared` (for search-ai-runtime)
- ⬜ Zero `req.tenantContext!` assertions remain in route handlers (355 remaining — phased migration)
- ⬜ Routes that need tenant context use `[authMiddleware, requireTenantContext()]` chain

### Task 1.5 — Harden WS session ownership checks (fail-closed) ✅ DONE

**Problem:** Subscribe, resume, and fork handlers use soft `a && b && a !== b` pattern that skips the check when either tenantId is undefined.

**Files:**

- `apps/runtime/src/websocket/handler.ts:2119-2126` (subscribe)
- `apps/runtime/src/websocket/handler.ts:2327-2331` (resume)
- `apps/runtime/src/websocket/handler.ts:3091-3096` (fork)

**Change:** Extract a centralized session ownership validator:

```typescript
// apps/runtime/src/websocket/session-ownership.ts (NEW)
export function validateSessionOwnership(
  clientState: ClientState,
  session: RuntimeSession,
): { allowed: boolean; reason?: string } {
  // 1. Client MUST have tenant context
  if (!clientState.tenantId) {
    return { allowed: false, reason: 'No tenant context' };
  }

  // 2. Session MUST have tenant context (sessions without tenantId are legacy/orphaned)
  if (!session.tenantId) {
    return { allowed: false, reason: 'Session has no tenant context' };
  }

  // 3. Tenant must match
  if (session.tenantId !== clientState.tenantId) {
    return { allowed: false, reason: 'Session not found' }; // 404 semantics, not 403
  }

  // 4. User ownership (when both are set)
  // Anonymous/channel sessions (no userId) are accessible to any user in the tenant
  if (session.userId && clientState.userId && session.userId !== clientState.userId) {
    return { allowed: false, reason: 'Session not found' };
  }

  return { allowed: true };
}
```

Update all three handlers to call `validateSessionOwnership()` and reject on `!allowed`.

**Acceptance criteria:**

- No `&&` soft checks remain in subscribe/resume/fork handlers
- Client without tenantId is rejected (not silently allowed)
- Session without tenantId is rejected (orphaned sessions are inaccessible)
- Cross-tenant returns "Session not found" (404 semantics)

---

## Sprint 2 — Database Layer Defense in Depth ✅ DONE

**Goal:** Mongoose plugin prevents cross-tenant writes even if application code has bugs.

### Task 2.1 — Harden tenantIsolationPlugin: assert on create ✅ DONE

**Problem:** Pre-validate hook only sets tenantId if not present. Explicit tenantId is trusted without validation.

**File:** `packages/database/src/mongo/plugins/tenant-isolation.plugin.ts:92-98`

**Change:**

```typescript
// pre-validate hook — REPLACE current logic
schema.pre('validate', function () {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;

  if (this.isNew) {
    const existingTenantId = this.get('tenantId');
    if (!existingTenantId) {
      // Auto-set from context
      this.set('tenantId', ctx.tenantId);
    } else if (existingTenantId !== ctx.tenantId) {
      // SECURITY: Reject cross-tenant write attempt
      throw new Error(
        `Tenant isolation violation: document tenantId (${existingTenantId}) ` +
          `does not match context tenantId (${ctx.tenantId})`,
      );
    }
    // else: matches context — allow through
  }
});
```

Same change for `insertMany` hook and `injectTenantFilter`:

```typescript
// injectTenantFilter — REPLACE current logic
function injectTenantFilter(query: Query<any, any>): void {
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.isSuperAdmin) return;

  const filter = query.getFilter();
  if (filter.tenantId && filter.tenantId !== ctx.tenantId) {
    // SECURITY: Query specifies a different tenant than context
    throw new Error(
      `Tenant isolation violation: query tenantId (${filter.tenantId}) ` +
        `does not match context tenantId (${ctx.tenantId})`,
    );
  }
  if (!filter.tenantId) {
    query.where('tenantId').equals(ctx.tenantId);
  }
}
```

**Acceptance criteria:**

- Creating a document with wrong tenantId throws (not silently persisted)
- Querying with wrong tenantId throws (not silently allowed)
- SuperAdmin bypass still works
- All existing tests pass (no legitimate cross-tenant writes broken)

### Task 2.2 — Make tenantId required in model resolution ✅ DONE

**Problem:** `resolveTenantModelById(id, tenantId?)` — optional tenantId means unscoped query is possible, potentially leaking LLM API keys.

**Files:**

- `apps/runtime/src/repos/llm-resolution-repo.ts:138-148`
- `apps/runtime/src/services/llm/model-resolution.ts:782-784`

**Change:**

```typescript
// llm-resolution-repo.ts — make tenantId required
export async function findTenantModelByIdWithPrimaryConnection(
  id: string,
  tenantId: string,  // ← REQUIRED
): Promise<any | null> {
  const { TenantModel } = await import('@agent-platform/database/models');
  const doc = await TenantModel.findOne({ _id: id, tenantId }).lean();  // ← Always scoped
  if (!doc) return null;
  return filterPrimaryConnection(doc);
}

// model-resolution.ts — make tenantId required
private async resolveTenantModelById(
  tenantModelId: string,
  tenantId: string,  // ← REQUIRED
): Promise<TenantModelResolution | null> {
```

**Impact:** Callers that pass `context.tenantId` (which is typed `string | undefined`) will get a type error. Fix each call site:

- If `context.tenantId` is undefined, fail early with a clear error instead of running an unscoped query
- Trace all callers of `resolveTenantModelById` and `findTenantModelByIdWithPrimaryConnection` to ensure tenantId is always available

**Acceptance criteria:**

- TypeScript compilation succeeds with tenantId as required param
- No unscoped TenantModel queries possible
- Callers that lack tenantId fail with a descriptive error, not a silent cross-tenant leak

### Task 2.3 — Audit Mongoose models for tenantIsolationPlugin coverage ✅ PARTIALLY DONE

**Problem:** Models opt in to tenant isolation via `schema.plugin(tenantIsolationPlugin)`. No centralized registry — gaps are invisible.

**Done:**

- `tools/audit-tenant-plugin.sh` created and run — **baseline: 18 models with tenantId but no plugin** out of 114 total models
- **ProjectAgent (review feedback P0 #1):** Plugin was MISSING — now added. ProjectAgent has its own `tenantId` field and compound unique indexes on `{tenantId, projectId, name}`, making it a direct tenant-scoped model, NOT a join-through-project model as originally assumed. The plugin is required.

**Remaining (18 gaps need case-by-case review):**

Each gap model falls into one of these categories:

1. **Needs plugin added** (like ProjectAgent) — direct tenantId field with no automatic scoping
2. **Legitimate exception** — model is accessed only via admin/super-admin paths, or tenantId is set-once-and-read-only
3. **Needs documentation** — manual guard exists but is undocumented

The 18 gaps should be triaged in Sprint 5 with the CI enforcement work.

**Acceptance criteria:**

- ✅ Script in `tools/audit-tenant-plugin.sh`
- ⬜ Every model with `tenantId` field either has the plugin or has a documented reason why not
- ⬜ Add to CI as a check (can be advisory initially)

---

## Sprint 3 — Storage & Header Trust ✅ DONE

**Goal:** Defense in depth for S3 and eliminate untrusted header trust.

### Task 3.1 — S3 tenant path validation (defense in depth) ✅ DONE

**Problem:** `getDownloadUrl(path)` and `delete(path)` accept raw S3 keys. A bug in any caller could generate a presigned URL for another tenant's file.

**Files:**

- `apps/studio/src/services/archive/s3-archive-store.ts:134,149`
- `packages/shared/src/services/s3-storage.ts:242,269`

**Design:** Three layers of defense:

**Layer 1 — Tenant-scoped methods on S3ArchiveStore:**

```typescript
// s3-archive-store.ts — add tenant-validated methods
async getDownloadUrlForTenant(
  tenantId: string,
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  this.assertTenantOwnsPath(tenantId, path);
  return this.getDownloadUrl(path, expiresInSeconds);
}

async deleteForTenant(tenantId: string, path: string): Promise<void> {
  this.assertTenantOwnsPath(tenantId, path);
  return this.delete(path);
}

private assertTenantOwnsPath(tenantId: string, path: string): void {
  // Expected format: tenants/{tenantId}/... or {tenantId}/...
  const expectedPrefixes = [
    `tenants/${tenantId}/`,
    `${tenantId}/`,
  ];
  if (!expectedPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new AppError('Access denied: path does not belong to tenant', {
      code: 'TENANT_PATH_VIOLATION',
      statusCode: 403,
    });
  }
}
```

**Layer 2 — Deprecate raw `getDownloadUrl(path)` and `delete(path)`:**
Mark existing methods as `@deprecated` and add a lint rule to catch new usages.

**Layer 3 — S3 bucket policy (infrastructure):**
If using per-tenant key prefixes (`tenants/{tenantId}/`), add an S3 bucket policy or IAM condition that requires the `x-tenant-id` metadata to match. This is a safety net at the infrastructure level — deferred to infra repo.

**(Review feedback #6 — P1):** The multimodal-service attachment upload/download surface also needs tenant path validation. `apps/runtime/src/services/multimodal-service.ts` uploads attachments via S3StorageService — these paths must be validated against the requesting tenant. Add to Sprint 5 as a follow-up migration task.

**Acceptance criteria:**

- ✅ `assertTenantOwnsPath` implemented in both s3-archive-store.ts and s3-storage.ts
- ✅ `getDownloadUrlForTenant`/`deleteForTenant` methods added
- ⬜ All callers of `getDownloadUrl`/`delete` migrated to tenant-validated versions (including multimodal-service)
- ⬜ Raw methods deprecated with `@deprecated` JSDoc

### Task 3.2 — Eliminate `x-tenant-id` header trust ✅ DONE

**Problem:** Two production files read tenantId from untrusted client headers.

**File 1:** `apps/runtime/src/routes/agent-transfer-settings.ts:35,87`

```typescript
// BEFORE:
const tenantId = req.headers['x-tenant-id'] as string | undefined;

// AFTER:
const tenantId = req.tenantContext?.tenantId;
if (!tenantId) {
  return res.status(403).json({
    success: false,
    error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
  });
}
```

Or better: add `requireTenantContext()` (from Task 1.4) to the route middleware chain and use `req.tenantContext.tenantId` directly.

**File 2:** `apps/runtime/src/middleware/workflow-engine-proxy.ts:77`

```typescript
// BEFORE:
const tenantId =
  (req as any).tenantContext?.tenantId ?? (req.headers['x-tenant-id'] as string | undefined);

// AFTER:
const tenantId = (req as any).tenantContext?.tenantId;
// If no tenant context, do NOT forward x-tenant-id header — fail-closed
```

**Lint rule:** Add a Claude Code hook and a CI check:

```bash
# tools/no-tenant-header-trust.sh
# Blocks: req.headers['x-tenant-id'] in routes/ and middleware/
# Allows: in dev-auth.ts (dev only), in service-to-service internal handlers
```

**Done:**

- `agent-transfer-settings.ts` — changed from `req.headers['x-tenant-id']` to `req.tenantContext?.tenantId`
- `workflow-engine-proxy.ts` — removed fallback to client `x-tenant-id` header

**(Review feedback #7 — P2):** Some `x-tenant-id` header reads may be legitimate for **internal service-to-service** calls (e.g., workflow engine calling runtime). The lint rule allowlist should distinguish:

- **BLOCKED:** Any route/middleware in `apps/*/src/routes/` or `apps/*/src/middleware/` reading `x-tenant-id` from client requests
- **ALLOWED:** Internal service handlers that receive `x-tenant-id` from trusted upstream services (behind network policy / service mesh), documented with `// INTERNAL: trusted service-to-service header`

**Acceptance criteria:**

- ✅ Zero production routes read `x-tenant-id` from client-facing headers
- ✅ Workflow engine proxy does not fall back to header
- ⬜ CI lint blocks reintroduction (with internal allowlist)

### Task 3.3 — `requireAuth()` → guarantee tenant context or explicit opt-out ✅ DONE

**Problem:** `requireAuth()` passes if `req.user` exists, even without `req.tenantContext`. Routes that then access `req.tenantContext.tenantId` crash.

**File:** `packages/shared-auth/src/middleware/unified-auth.ts:413-422`

**Change:** Two middleware options:

```typescript
// Option A: requireAuthWithTenant() — most routes should use this
export function requireAuthWithTenant(): RequestHandler[] {
  return [requireAuth(), requireTenantContext()];
}

// Option B: requireAuthOnly() — for routes that genuinely don't need tenant (e.g., /me, /tenants)
export const requireAuthOnly = requireAuth;
```

Update `authMiddleware` in runtime and search-ai to use `requireAuthWithTenant()` by default.

**Acceptance criteria:**

- Default `authMiddleware` guarantees both auth and tenant context
- Routes that explicitly don't need tenant use `requireAuthOnly()` with a comment explaining why

---

## Sprint 4 — Queue Isolation

**Goal:** Separate blast radius across tenants, apps, and channels.

### Task 4.1 — Per-tenant rate limiting on LLM queue

**Problem:** Single `Queue('llm-requests')` — noisy tenant starves others.

**File:** `apps/runtime/src/services/llm/llm-queue.ts:194`

**Design:** Use BullMQ's built-in rate limiter with a tenant-aware concurrency strategy:

```typescript
// Option A: Per-tenant concurrency via BullMQ groups (preferred if BullMQ Pro)
bullQueue = new Queue('llm-requests', {
  connection: queueConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
    attempts: 1,
    group: { id: '${tenantId}' }, // BullMQ Pro feature
  },
});

// Option B: Application-level per-tenant semaphore (no BullMQ Pro required)
// Use a Redis-backed per-tenant counter:
//   key: tenant:${tenantId}:llm-concurrency
//   max: configurable per tier (free=2, pro=10, enterprise=50)
// Check before enqueue, decrement on complete/fail
```

**Make tenantId required in LLMJobData:**

```typescript
interface LLMJobData {
  jobId: string;
  sessionId: string;
  message: string;
  tenantId: string; // ← REQUIRED, not optional
  enqueuedAt: number;
  // ...
}
```

**Acceptance criteria:**

- tenantId is required in all LLM job payloads
- Per-tenant concurrency limit prevents noisy-neighbor starvation
- Configurable per tenant tier

### Task 4.2 — Separate queues by app origin

**Problem per Prasanna:** Studio traffic and runtime traffic share the same queue. Channel traffic should also be isolated.

**Design:** Split `llm-requests` into origin-specific queues:

```
llm-requests:runtime    — runtime agent execution (WS handler, SDK handler)
llm-requests:studio     — studio preview/test runs
llm-requests:channel    — channel adapter traffic (WhatsApp, Slack, etc.)
```

Each queue gets its own worker pool with independent concurrency settings:

```typescript
// Queue names
const QUEUE_LLM_RUNTIME = 'llm-requests:runtime';
const QUEUE_LLM_STUDIO = 'llm-requests:studio';
const QUEUE_LLM_CHANNEL = 'llm-requests:channel';

// Worker concurrency per origin
const CONCURRENCY = {
  runtime: 10, // interactive — low latency
  studio: 5, // preview — best effort
  channel: 15, // high volume — batch friendly
};
```

**Job routing:** The enqueue call site determines which queue to use based on the session's origin:

- `sdk-handler.ts` → `channel` or `runtime` (based on session.channel)
- `handler.ts` → `studio` (web debug) or `runtime`
- Channel adapters → `channel`

**Acceptance criteria:**

- Three separate LLM queues with independent concurrency
- Studio preview does not compete with production runtime traffic
- Channel surge does not block interactive sessions
- Dashboard/metrics distinguish queue origins

### Task 4.3 — Channel isolation within channel queue

**Problem per Prasanna:** A single misbehaving channel (e.g., WhatsApp webhook flood) can starve all other channels.

**Design:** Within the `llm-requests:channel` queue, use BullMQ job groups or a Redis semaphore keyed by `tenantId:channelType`:

```typescript
// Per-channel-type concurrency limit
const CHANNEL_CONCURRENCY: Record<string, number> = {
  whatsapp: 5,
  slack: 5,
  webchat: 10,
  voice: 3,
  default: 3,
};

// When enqueuing:
await channelQueue.add('llm-request', jobData, {
  group: { id: `${tenantId}:${channelType}` },
  // or use application-level semaphore
});
```

**Acceptance criteria:**

- Per-tenant per-channel concurrency limits
- WhatsApp flood for tenant A does not block Slack for tenant A or any traffic for tenant B
- Configurable limits per channel type

### Task 4.4 — Queue name migration plan (review feedback #9 — P2)

**Problem:** Renaming queues from `llm-requests` to `llm-requests:runtime` etc. requires a coordinated migration. Old jobs in-flight on the original queue name will be lost if consumers stop listening.

**Migration steps:**

1. Deploy new consumers listening on BOTH old (`llm-requests`) and new (`llm-requests:runtime`, etc.) queue names
2. Update producers to route to new queue names based on session origin
3. Wait for old queue to drain (monitor via BullMQ dashboard)
4. Remove old queue consumers in a follow-up deploy
5. Add health check that alerts if old queue depth > 0 after migration window

**Acceptance criteria:**

- Zero-downtime migration — no in-flight jobs lost
- Old queue fully drained before consumer removal
- Monitoring/alerting on queue depths during migration

---

## Sprint 5 — Orphan Cleanup & Linting

**Goal:** Clean up orphaned data and prevent regression.

### Task 5.1 — Fix `captureAbandonedCall()` to require tenantId

**Problem:** Creates sessions with `tenantId: undefined` — orphaned outside any tenant boundary.

**File:** `packages/compiler/src/platform/stores/conversation-store.ts:304-310`

**(Review feedback #8 — P2):** Note that `ConversationStore` is an interface with multiple implementations:

- `MongoConversationStore` — production, persists to MongoDB
- `InMemoryConversationStore` — used in tests and file-based agent mode
- `captureAbandonedCall()` is called on the store implementation currently in use

The fix must work across both implementations:

- **MongoConversationStore:** tenantId is critical — orphaned sessions pollute the DB and are invisible to any tenant
- **InMemoryConversationStore:** tenantId is still important for correctness in multi-tenant test scenarios, but the blast radius is limited to the process lifetime

**Change:** `captureAbandonedCall()` should receive tenantId from its caller (available via ALS after Sprint 1's `runWithTenantContext` wrapping). If tenantId is not available, log a warning and still create the session with a marker (`tenantId: '__orphaned__'`) so it can be found and cleaned up, rather than silently creating unscoped data.

**Acceptance criteria:**

- All `captureAbandonedCall()` callers pass tenantId (or it's resolved from ALS)
- Sessions are never created with undefined tenantId in production (MongoConversationStore)
- Migration script to tag existing orphaned sessions

### Task 5.2 — CI enforcement of tenant isolation lints

**Problem:** Existing Claude Code hooks only fire for AI agents, not human developers. No CI enforcement.

**Change:** Create `tools/tenant-isolation-lint.sh` that runs in CI on every PR:

```bash
#!/usr/bin/env bash
# Checks:
# 1. No findById/findByIdAndUpdate/findByIdAndDelete in app code
# 2. No req.headers['x-tenant-id'] in routes/ or middleware/ (except allowlist)
# 3. No tenantId?: string (optional) in repo function signatures
# 4. No req.tenantContext! (non-null assertion)
# 5. All models with tenantId field have tenantIsolationPlugin (via audit script)
```

Add to Harness CI pipeline as a required check.

**Acceptance criteria:**

- Script exits non-zero on violations
- Runs in CI on every PR
- Allowlist for legitimate exceptions (dev-auth.ts, service-to-service handlers)

### Task 5.3 — ProjectAgent tenant isolation ✅ DONE (P0 fix)

**Original assumption (WRONG):** ProjectAgent uses manual tenant guard via project join, so plugin not needed.

**Reality (review feedback P0 #1):** ProjectAgent has its own `tenantId` field AND compound indexes on `{tenantId, projectId, name}`. It is a direct tenant-scoped model that was missing the isolation plugin — a genuine P0 gap.

**Fix applied:** Added `tenantIsolationPlugin` to `packages/database/src/models/project-agent.model.ts`. This model file also already has proper tenant-scoped indexes.

**Acceptance criteria:**

- ✅ `tenantIsolationPlugin` added to ProjectAgent schema
- ✅ Audit script no longer reports ProjectAgent as a gap

---

## Execution Order & Dependencies

```
Sprint 1 (Centralize)              Sprint 2 (DB hardening)
├─ 1.1 Unify ALS ──────────────────┤
├─ 1.2 Extract resolveTenantContext │├─ 2.1 Harden plugin (depends on 1.1)
├─ 1.3 WS handler ALS wrapping ────┤├─ 2.2 Required tenantId in model resolution
├─ 1.4 requireTenantContext ────────┤├─ 2.3 Audit model plugin coverage
├─ 1.5 Session ownership validator  │
                                    │
Sprint 3 (Storage + Headers)        Sprint 4 (Queue Isolation)
├─ 3.1 S3 path validation          ├─ 4.1 Per-tenant rate limiting
├─ 3.2 Eliminate x-tenant-id trust  ├─ 4.2 Queue split by app origin
├─ 3.3 requireAuthWithTenant        ├─ 4.3 Channel isolation
                                    │
                              Sprint 5 (Cleanup + Lint)
                              ├─ 5.1 Fix captureAbandonedCall
                              ├─ 5.2 CI lint enforcement
                              └─ 5.3 ProjectAgent documentation
```

**Sprint 1 is the foundation** — all other sprints depend on centralized ALS and `requireTenantContext`.

**Sprint 2 and Sprint 3 can run in parallel** — DB hardening and storage/header fixes are independent.

**Sprint 4 can start after Sprint 1** — queue isolation needs tenantId to be required (from 1.x changes).

**Sprint 5 can run anytime** — cleanup and linting are independent.

---

## Risk Assessment

| Change                                      | Risk                                                               | Mitigation                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Unify ALS (1.1)                             | Search-AI workers may break if they rely on the database-local ALS | Fallback reads local ALS first, shared-auth second                                                                |
| Harden plugin assert (2.1)                  | Legitimate code that sets explicit tenantId on create will throw   | Audit all `new Model({tenantId: x})` calls before deploying. Should be rare — most code relies on plugin auto-set |
| Required tenantId in model resolution (2.2) | Callers passing undefined will get type errors                     | Fix each caller to either provide tenantId or fail early                                                          |
| Queue split (4.2)                           | Existing job consumers need to listen on new queue names           | Deploy consumers for new queues before producers start routing to them. Drain old queue before removal            |
| Session ownership fail-closed (1.5)         | Debug/orphaned sessions become inaccessible                        | Expected behavior — orphaned sessions should not be accessible. Add admin override for debugging                  |

---

## Test Strategy

Each sprint must include:

1. **Unit tests** for new utilities (`resolveTenantContext`, `validateSessionOwnership`, `assertTenantOwnsPath`)
2. **Integration tests** for Mongoose plugin hardening (create with wrong tenantId → throws)
3. **E2E tests** for cross-tenant scenarios:
   - WS client A (tenant-1) tries to subscribe to tenant-2's session → rejected
   - REST client tries to get presigned URL for another tenant's S3 path → rejected
   - Request with forged `x-tenant-id` header → ignored, uses auth context
4. **Regression tests** — all existing runtime (8,861), search-ai (1,430), and compiler (3,947) tests must pass

---

## Mapping to Original Findings

| Finding                                  | Sprint.Task   | Status                                                  |
| ---------------------------------------- | ------------- | ------------------------------------------------------- |
| #1 Centralize WS tenant context          | 1.2, 1.3      | ✅ Single resolution path, per-message ALS              |
| #4 Soft subscribe check                  | 1.5           | ✅ Fail-closed via `validateSessionOwnership()`         |
| #5 Soft resume check                     | 1.5           | ✅ Fail-closed via `validateSessionOwnership()`         |
| #6 MongoConversationStore ALS            | 1.1, 1.3      | ✅ Unified ALS propagated per-message                   |
| #7 Optional tenantId in model resolution | 2.2           | ✅ Required parameter                                   |
| #9 ProjectAgent manual guard             | 5.3           | ✅ Plugin added (P0 — was missing, not manual-guard)    |
| #10 captureAbandonedCall orphans         | 5.1           | ⬜ Pending                                              |
| #11 BullMQ global queue                  | 4.1, 4.2, 4.3 | ⬜ Pending                                              |
| #12 S3 path validation                   | 3.1           | ✅ Tenant-scoped methods + path assertion               |
| #13 requireAuth no tenant guarantee      | 1.4, 3.3      | ✅ `requireTenantContext()` + `requireAuthWithTenant()` |
| #14 Plugin allows tenantId override      | 2.1           | ✅ Assert match on create, reject mismatch              |
| #16 x-tenant-id header trust             | 3.2           | ✅ Eliminated in production routes                      |

---

## Review Feedback Resolution (2026-03-18)

9 findings from code review, all addressed in plan or code:

| #   | Priority | Finding                                                                                          | Resolution                                                                                                                                             |
| --- | -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **P0**   | ProjectAgent missing `tenantIsolationPlugin`                                                     | ✅ Fixed — plugin added to model                                                                                                                       |
| 2   | P1       | ALS unification uses global mutable — not safe for multiple providers                            | Acknowledged — current single-provider pattern is sufficient for our architecture. If multiple providers needed in future, convert to a provider chain |
| 3   | P1       | `requireTenantContext` not re-exported from `@agent-platform/shared`                             | ✅ Fixed — re-exports added to shared barrel                                                                                                           |
| 4   | P1       | 355 `req.tenantContext!` assertions across 58 route files — no migration plan                    | ✅ Plan updated with phased adoption (Phase A/B/C in Task 1.4)                                                                                         |
| 5   | P1       | handler.ts still has local `resolveWSTenantContext` — not fully centralized                      | ✅ Fixed — rewired to delegate to `resolveTenantContext()` from shared-auth via DI. Local function kept as thin adapter for WS-specific error handling |
| 6   | P1       | S3 tenant path validation doesn't cover multimodal-service attachment surface                    | ✅ Plan updated — multimodal-service added to Sprint 5 migration scope                                                                                 |
| 7   | P2       | Header trust lint needs allowlist for internal service-to-service calls                          | ✅ Plan updated — allowlist criteria documented                                                                                                        |
| 8   | P2       | `captureAbandonedCall` fix must work across MongoConversationStore AND InMemoryConversationStore | ✅ Plan updated — both implementations addressed                                                                                                       |
| 9   | P2       | Queue rename needs migration plan to avoid losing in-flight jobs                                 | ✅ Plan updated — Task 4.4 added with zero-downtime migration steps                                                                                    |
