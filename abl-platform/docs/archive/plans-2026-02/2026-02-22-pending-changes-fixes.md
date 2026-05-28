# Pending Changes Fix Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 5 critical and 11 important issues found in the code review of pending/untracked changes.

**Architecture:** Three workstreams: (1) Runtime tenant isolation fixes in `channel-repo.ts` and `sdk-channels.ts`, (2) Studio search-ai proxy security hardening in `search-ai-proxy.ts` + all 29 route files, (3) Code quality fixes across diagnostics, tests, and the plan document.

**Tech Stack:** TypeScript, Express.js, Next.js App Router, MongoDB/Mongoose, Vitest

**Related:** [Centralized Auth Design](2026-02-22-centralized-auth-design.md) — the tenant isolation fixes here are a subset of the broader auth architecture. The centralized auth plan supersedes individual tenant isolation fixes with a unified three-layer access model.

---

## Workstream 1: Runtime SDK Channel Tenant Isolation (Critical)

### Task 1: Fix `updateSDKChannel` and `deleteSDKChannel` repo functions

The root cause is in `channel-repo.ts` — the repo functions don't accept `tenantId`/`projectId`, so callers can't pass them. Fix the repo layer first, then update callers.

**Files:**

- Modify: `apps/runtime/src/repos/channel-repo.ts:171-183`

**Step 1: Fix `updateSDKChannel` to accept and filter by `tenantId` + `projectId`**

Change the function signature and query from:

```typescript
export async function updateSDKChannel(
  id: string,
  data: Record<string, unknown>,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.findByIdAndUpdate(id, { $set: data }, { new: true }).lean();
  return doc ? parseChannelDoc(doc) : null;
}
```

To:

```typescript
export async function updateSDKChannel(
  id: string,
  projectId: string,
  tenantId: string,
  data: Record<string, unknown>,
): Promise<SDKChannelDoc | null> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const doc = await SDKChannel.findOneAndUpdate(
    { _id: id, projectId, tenantId },
    { $set: data },
    { new: true },
  ).lean();
  return doc ? parseChannelDoc(doc) : null;
}
```

**Step 2: Fix `deleteSDKChannel` to accept and filter by `tenantId` + `projectId`**

Change from:

```typescript
export async function deleteSDKChannel(id: string): Promise<void> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  await SDKChannel.deleteOne({ _id: id });
}
```

To:

```typescript
export async function deleteSDKChannel(
  id: string,
  projectId: string,
  tenantId: string,
): Promise<boolean> {
  const { SDKChannel } = await import('@agent-platform/database/models');
  const result = await SDKChannel.deleteOne({ _id: id, projectId, tenantId });
  return result.deletedCount > 0;
}
```

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=runtime`
Expected: Build failure in `sdk-channels.ts` because callers need updating (Task 2 fixes this).

**Step 4: Commit**

```bash
git add apps/runtime/src/repos/channel-repo.ts
git commit -m "fix(runtime): add tenant+project scoping to updateSDKChannel and deleteSDKChannel"
```

---

### Task 2: Update `sdk-channels.ts` route callers to pass tenant context

**Files:**

- Modify: `apps/runtime/src/routes/sdk-channels.ts:323,367`

**Step 1: Update PATCH handler (line 323)**

Change:

```typescript
const updated = await updateSDKChannel(channelId, updates);
```

To:

```typescript
const updated = await updateSDKChannel(channelId, projectId, tenantId, updates);
```

**Step 2: Update DELETE handler (line 367)**

Change:

```typescript
await deleteSDKChannel(channelId);
```

To:

```typescript
const deleted = await deleteSDKChannel(channelId, projectId, tenantId);
if (!deleted) {
  res
    .status(404)
    .json({ success: false, error: { code: 'NOT_FOUND', message: 'SDK channel not found' } });
  return;
}
```

Since `deleteSDKChannel` now returns a boolean, we can remove the pre-delete `findSDKChannelById` lookup (lines 361-364) — the delete itself is now tenant-scoped and atomic. This eliminates the TOCTOU window entirely.

**Step 3: Fix `findPublicApiKey` call in POST handler (line 153)**

The `findPublicApiKey` call doesn't include `tenantId` — a key from another tenant's project could match if project IDs were predictable. Add tenant filtering:

Change:

```typescript
const apiKey = await findPublicApiKey({ id: publicApiKeyId, projectId });
```

To:

```typescript
const apiKey = await findPublicApiKey({ id: publicApiKeyId, projectId, tenantId });
```

Note: `findPublicApiKey` already accepts arbitrary `where` clauses and builds a filter dynamically. However, the `PublicApiKeyDoc.tenantId` field exists but `findPublicApiKey` doesn't handle a `tenantId` filter. We need to add that to `findPublicApiKey` in `channel-repo.ts`:

In `channel-repo.ts`, inside `findPublicApiKey` (around line 64-78), add:

```typescript
if (where.tenantId) filter.tenantId = where.tenantId;
```

And update the type signature to include `tenantId?: string`.

**Step 4: Fix `err: any` typing in PATCH and POST catch blocks (lines 203, 335)**

Change both `catch (err: any)` to `catch (err: unknown)` and update the error code check:

```typescript
} catch (err: unknown) {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
```

**Step 5: Validate `followEnvironment` type in PATCH handler (line 319)**

Currently `followEnvironment` is accepted without type validation. Add:

```typescript
if (followEnvironment !== undefined) {
  if (typeof followEnvironment !== 'boolean') {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_FOLLOW_ENV', message: 'followEnvironment must be a boolean' },
    });
    return;
  }
  updates.followEnvironment = followEnvironment;
}
```

**Step 6: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=runtime`
Expected: PASS

**Step 7: Commit**

```bash
git add apps/runtime/src/routes/sdk-channels.ts apps/runtime/src/repos/channel-repo.ts
git commit -m "fix(runtime): pass tenant context to update/delete SDK channel, validate followEnvironment"
```

---

### Task 3: Add SDK channels authz test

**Files:**

- Create: `apps/runtime/src/__tests__/sdk-channels-authz.test.ts`

**Step 1: Write authz tests**

Follow the pattern from existing `*-authz.test.ts` files. Test these scenarios for each route (GET list, POST create, GET by ID, PATCH, DELETE, POST token):

1. **Correct permission required** — request with correct role succeeds (200/201)
2. **Missing auth returns 401** — no token → 401
3. **Cross-tenant access returns 404** — tenant A's channel, tenant B's token → 404 (not 403)
4. **Cross-project access returns 404** — correct tenant, wrong project → 404
5. **Insufficient permission returns 403** — reader role on write endpoints → 403

Minimal test structure:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// ... test setup with mock Express app, mock repos

describe('SDK Channels Authorization', () => {
  describe('PATCH /:channelId', () => {
    it('returns 404 for cross-tenant channel access', async () => {
      // Setup: channel belongs to tenantA, request from tenantB
      // Assert: 404 response
    });
  });

  describe('DELETE /:channelId', () => {
    it('returns 404 for cross-tenant channel access', async () => {
      // Same pattern
    });
  });
});
```

**Step 2: Run tests**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm test --filter=runtime -- --run sdk-channels-authz`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/sdk-channels-authz.test.ts
git commit -m "test(runtime): add SDK channels authz tests for cross-tenant isolation"
```

---

## Workstream 2: Studio Search-AI Proxy Security (Critical)

### Task 4: Fix tenant isolation in `search-ai-proxy.ts`

The proxy reads `tenantId` from client-controlled sources (header + query param). Must use verified `user.tenantId` from JWT.

**Files:**

- Modify: `apps/studio/src/lib/search-ai-proxy.ts`

**Step 1: Add `tenantId` parameter to proxy functions**

Change the function signatures to accept a required `tenantId`:

```typescript
export async function proxyToSearchEngine(
  request: NextRequest,
  path: string,
  options?: { method?: string; body?: unknown; tenantId?: string },
): Promise<NextResponse> {
  return proxyTo(SEARCH_AI_ENGINE_URL, request, path, options, 'SearchAI engine');
}

export async function proxyToSearchRuntime(
  request: NextRequest,
  path: string,
  options?: { method?: string; body?: unknown; tenantId?: string },
): Promise<NextResponse> {
  return proxyTo(SEARCH_AI_RUNTIME_URL, request, path, options, 'SearchAI runtime');
}
```

**Step 2: Remove client-controlled `tenantId` from `proxyTo`**

Replace lines 52-54 in `proxyTo`:

```typescript
const tenantId = request.headers.get('X-Tenant-Id') || request.nextUrl.searchParams.get('tenantId');
if (tenantId) headers['X-Tenant-Id'] = tenantId;
```

With:

```typescript
if (options?.tenantId) headers['X-Tenant-Id'] = options.tenantId;
```

This ensures `tenantId` can only come from the caller (route handler), which gets it from the verified JWT user object.

**Step 3: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`
Expected: Build failure — all 29 route callers need updating (Task 5).

**Step 4: Commit**

```bash
git add apps/studio/src/lib/search-ai-proxy.ts
git commit -m "fix(studio): remove client-controlled tenantId from search-ai proxy, require explicit param"
```

---

### Task 5: Update all search-ai route files to pass verified `tenantId` + encode path segments

All 29 route files need two fixes: (1) pass `user.tenantId` to the proxy, (2) wrap dynamic path segments in `encodeURIComponent`.

**Files:** All files under:

- `apps/studio/src/app/api/search-ai/` (23 route files)
- `apps/studio/src/app/api/search-ai-runtime/` (6 route files)

**Step 1: Fix each route file**

For every route handler, the pattern is:

**Before:**

```typescript
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/indexes/${id}`);
}
```

**After:**

```typescript
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAuth(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}`, {
    tenantId: user.tenantId,
  });
}
```

For POST/PATCH routes that read `request.json()`, wrap in try/catch:

**Before:**

```typescript
const body = await request.json();
return proxyToSearchEngine(request, `/api/indexes/${id}`, { method: 'PATCH', body });
```

**After:**

```typescript
let body: unknown;
try {
  body = await request.json();
} catch {
  return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
}
return proxyToSearchEngine(request, `/api/indexes/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body,
  tenantId: user.tenantId,
});
```

Apply this pattern to all 29 route files. The specific dynamic segments per route:

- `[id]` — 15 route files
- `[id]` + `[sourceId]` — 2 route files
- `[id]` + `[entryId]` — 1 route file
- `[indexId]` — 6 route files (search-ai-runtime)
- `[connectorId]` — 1 route file
- No dynamic segments — 4 route files (just add `tenantId`)

**Step 2: Verify build**

Run: `cd /Users/prasannaarikala/projects/agent-platform && pnpm build --filter=studio`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/studio/src/app/api/search-ai/ apps/studio/src/app/api/search-ai-runtime/
git commit -m "fix(studio): pass verified tenantId and encode path segments in all search-ai proxy routes"
```

---

### Task 6: Fix error response shape consistency in search-ai proxy

The proxy returns `{ error: string, details: string }` on 503, but the platform convention is `{ success: false, error: { code: string, message: string } }`.

**Files:**

- Modify: `apps/studio/src/lib/search-ai-proxy.ts:69-74`

**Step 1: Update error response shape**

Change:

```typescript
return NextResponse.json(
  {
    error: `${serviceName} service is not available. Please ensure it is running.`,
    details: message,
  },
  { status: 503 },
);
```

To:

```typescript
return NextResponse.json(
  {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: `${serviceName} service is not available. Please ensure it is running.`,
    },
  },
  { status: 503 },
);
```

**Step 2: Commit**

```bash
git add apps/studio/src/lib/search-ai-proxy.ts
git commit -m "fix(studio): align search-ai proxy error response with platform convention"
```

---

## Workstream 3: Code Quality Fixes

### Task 7: Fix diagnostics empty catch and add logging

**Files:**

- Modify: `apps/runtime/src/services/diagnostics/diagnostic-patterns.ts:58-60`

**Step 1: Add error logging to the catch block**

Change:

```typescript
} catch {
  // Individual detector failures must not break other detectors
}
```

To:

```typescript
} catch (err: unknown) {
  // Individual detector failures must not break other detectors — but log for observability
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[Diagnostics] Detector failed: ${message}`);
}
```

**Step 2: Commit**

```bash
git add apps/runtime/src/services/diagnostics/diagnostic-patterns.ts
git commit -m "fix(runtime): log diagnostic detector failures instead of silently swallowing"
```

---

### Task 8: Extract `MAX_TTL_SECONDS` constant in `sdk-channels.ts`

**Files:**

- Modify: `apps/runtime/src/routes/sdk-channels.ts`

**Step 1: Check current constants section and add MAX_TTL_SECONDS**

The file already has a constants section around line 46-56. Find any inline `90 * 24 * 60 * 60` or similar TTL magic number and extract it.

Look for the token route (`POST /:channelId/token`). The max TTL is `90 * 24 * 60 * 60` (90 days). Extract to:

```typescript
const MAX_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
```

Replace inline usages with the named constants.

**Step 2: Commit**

```bash
git add apps/runtime/src/routes/sdk-channels.ts
git commit -m "refactor(runtime): extract token TTL magic numbers to named constants"
```

---

### Task 9: Fix plan document issues

**Files:**

- Modify: `docs/plans/2026-02-22-runtime-explainability-plan.md`

**Step 1: Fix Task 5 tautology (line ~421-424)**

The plan has:

```typescript
const isActive =
  !gatherResult.missing.includes(field.name) || gatherResult.missing.includes(field.name);
```

This is always `true`. The correct logic should be:

```typescript
const isActive = !gatherResult.missing.includes(field.name);
```

**Step 2: Note the `arch-diagnostics.ts` gap**

Add a note at the top of Task 9 that `diagnostic-patterns.ts` was implemented but `arch-diagnostics.ts` (the orchestrator) was not. The implementation diverged from the plan by combining both into `diagnostic-patterns.ts`. Note that `confidence` and `evidence` fields were omitted from the implementation.

**Step 3: Note the `traceHistory` durability concern in Task 10**

Add a note that `traceHistory` on `SessionData` is an in-memory-only field. For cluster-ready deployments, this must be backed by the trace store (ClickHouse/Redis) rather than embedded in the session. The current approach is valid for single-pod dev but needs a follow-up for production.

**Step 4: Commit**

```bash
git add docs/plans/2026-02-22-runtime-explainability-plan.md
git commit -m "docs: fix tautology and add implementation divergence notes to explainability plan"
```

---

## Summary

| Task | Workstream | Severity          | What it fixes                                                                                                               |
| ---- | ---------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1    | Runtime    | **Critical**      | `updateSDKChannel`/`deleteSDKChannel` repo functions lack tenant scoping                                                    |
| 2    | Runtime    | **Critical**      | Route callers don't pass tenant context; `findPublicApiKey` missing `tenantId`; `err: any`; `followEnvironment` unvalidated |
| 3    | Runtime    | **Important**     | Missing authz tests for SDK channels                                                                                        |
| 4    | Studio     | **Critical**      | `search-ai-proxy.ts` reads `tenantId` from client-controlled sources                                                        |
| 5    | Studio     | **Critical+High** | All 29 search-ai routes: pass verified `tenantId`, encode path segments, guard `request.json()`                             |
| 6    | Studio     | **Important**     | Non-conforming error response shape in proxy                                                                                |
| 7    | Runtime    | **Important**     | Empty catch block in diagnostics                                                                                            |
| 8    | Runtime    | **Important**     | Magic number TTL in token route                                                                                             |
| 9    | Docs       | **Important**     | Plan doc tautology and implementation divergence notes                                                                      |
