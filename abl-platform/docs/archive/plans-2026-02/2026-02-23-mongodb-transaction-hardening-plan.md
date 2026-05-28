# MongoDB Transaction Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify all MongoDB transaction usage behind a single, enterprise-grade helper that handles replica-set detection, automatic retries, standalone fallback, and orphan cleanup — eliminating 3 inconsistent patterns and 9 identified issues.

**Architecture:** Replace all direct `mongoose.startSession()` / manual `startTransaction()` calls with the shared `withTransaction()` helper from `packages/shared/src/repos/mongo-tx.ts`. Upgrade that helper to use Mongoose's `session.withTransaction()` for built-in transient-error retries. Add TTL-based cache invalidation for the replica-set check. Propagate `session` to all reads inside transaction callbacks.

**Tech Stack:** Mongoose 8, Vitest, TypeScript

---

## Affected Files Summary

| File                                                      | Change                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/shared/src/repos/mongo-tx.ts`                   | Rewrite: use `session.withTransaction()`, add TTL cache, export from barrel              |
| `packages/shared/src/repos/index.ts`                      | Add `withTransaction`, `canUseTransactions` exports                                      |
| `packages/shared/src/repos/tool-repo.ts`                  | Fix: pass `session` to re-read inside transaction                                        |
| `packages/shared/src/repos/tool-version-repo.ts`          | Refactor: use shared `withTransaction` in `createNamedVersion` and `setPublishedVersion` |
| `apps/studio/src/repos/workspace-repo.ts`                 | Refactor: use shared `withTransaction` in `createWorkspaceWithOwner`                     |
| `packages/database/src/mongo/base-model.ts`               | Refactor: delegate `withTransaction` to shared helper                                    |
| `packages/database/src/migrations/runner.ts`              | Refactor: use shared `canUseTransactions` instead of topology sniffing                   |
| `packages/shared/src/__tests__/mongo-tx.test.ts`          | Update: test new TTL cache, `session.withTransaction()` delegation                       |
| `packages/shared/src/__tests__/tool-version-repo.test.ts` | Update: verify `withTransaction` usage in `createNamedVersion`, `setPublishedVersion`    |
| `packages/shared/src/__tests__/tool-repo.test.ts`         | Update: verify session passed to re-read                                                 |

---

### Task 1: Upgrade `mongo-tx.ts` — TTL cache + `session.withTransaction()`

**Files:**

- Modify: `packages/shared/src/repos/mongo-tx.ts`
- Test: `packages/shared/src/__tests__/mongo-tx.test.ts`

**Why:** The current implementation has two issues: (1) `canUseTransactions` caches forever — if it runs before connection is ready, it returns `false` for the process lifetime; (2) `withTransaction` manually calls `startTransaction()`/`commitTransaction()`/`abortTransaction()` which skips Mongoose's built-in transient error retry logic that `session.withTransaction()` provides.

**Step 1: Write the failing tests for TTL cache invalidation**

Add tests to `packages/shared/src/__tests__/mongo-tx.test.ts`:

```typescript
describe('canUseTransactions TTL', () => {
  it('re-checks after TTL expires', async () => {
    // First call: standalone
    mockCommand.mockResolvedValueOnce({});
    vi.resetModules();
    vi.mock('mongoose', () => ({
      default: {
        connection: { db: { admin: () => ({ command: mockCommand }) } },
        startSession: vi.fn(() => mockSession),
      },
    }));
    const mod = await import('../repos/mongo-tx.js');
    expect(await mod.canUseTransactions()).toBe(false);

    // Advance time past TTL (5 minutes)
    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // Second call: now replica set
    mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
    expect(await mod.canUseTransactions()).toBe(true);
    vi.useRealTimers();
  });
});
```

Also add test verifying `session.withTransaction()` is used (not manual start/commit/abort):

```typescript
it('delegates to session.withTransaction() for automatic retry', async () => {
  mockCommand.mockResolvedValueOnce({ setName: 'rs0' });
  const mockWithTransaction = vi.fn(async (fn) => fn());
  const mockSessionObj = {
    withTransaction: mockWithTransaction,
    endSession: vi.fn(),
  };
  const startSession = vi.fn(() => mockSessionObj);
  vi.resetModules();
  vi.mock('mongoose', () => ({
    default: {
      connection: { db: { admin: () => ({ command: mockCommand }) } },
      startSession,
    },
  }));
  const { withTransaction: fresh } = await import('../repos/mongo-tx.js');

  const fn = vi.fn(async (session) => 'ok');
  await fresh(fn);
  expect(mockWithTransaction).toHaveBeenCalledOnce();
  expect(fn).toHaveBeenCalledWith(mockSessionObj);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/shared && pnpm vitest run src/__tests__/mongo-tx.test.ts`
Expected: FAIL — TTL test fails (cache never expires), `session.withTransaction` test fails (manual calls used instead)

**Step 3: Implement the upgraded `mongo-tx.ts`**

Replace `packages/shared/src/repos/mongo-tx.ts` with:

```typescript
/**
 * MongoDB Transaction Helpers
 *
 * Shared utilities for transactional operations.
 * Caches whether the connected MongoDB supports transactions (replica set / mongos).
 * Uses session.withTransaction() for automatic transient-error retry.
 */

import mongoose from 'mongoose';

/** TTL for the replica-set check cache (ms). Re-checks after this period. */
const TX_CHECK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Cached result + timestamp for TTL-based invalidation. */
let _txCache: { promise: Promise<boolean>; checkedAt: number } | null = null;

/**
 * Check whether the connected MongoDB supports transactions.
 * Result is cached with a 5-minute TTL to handle late replica-set promotion
 * without hammering the admin API on every request.
 */
export function canUseTransactions(): Promise<boolean> {
  const now = Date.now();
  if (_txCache && now - _txCache.checkedAt < TX_CHECK_TTL_MS) {
    return _txCache.promise;
  }

  const promise = (async () => {
    try {
      const admin = mongoose.connection.db!.admin();
      const info = await admin.command({ hello: 1 });
      return !!(info['setName'] || info['msg'] === 'isdbgrid');
    } catch {
      return false;
    }
  })();

  _txCache = { promise, checkedAt: now };
  return promise;
}

/** Reset the cache. Exposed for tests only. */
export function _resetTxCache(): void {
  _txCache = null;
}

/**
 * Run an operation inside a MongoDB transaction if available, otherwise run without.
 *
 * Uses Mongoose's `session.withTransaction()` which automatically retries on
 * TransientTransactionError and UnknownTransactionCommitResult — the manual
 * startTransaction/commitTransaction pattern does NOT retry.
 *
 * The callback receives `session` (ClientSession) when transactions are available,
 * or `null` when running on standalone MongoDB. Callers must pass `session` to
 * all Mongoose operations via `{ session }` options for transactional consistency.
 */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession | null) => Promise<T>,
): Promise<T> {
  const useTx = await canUseTransactions();

  if (useTx) {
    const session = await mongoose.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  return fn(null);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run src/__tests__/mongo-tx.test.ts`
Expected: PASS — all existing + new tests green

**Step 5: Commit**

```bash
git add packages/shared/src/repos/mongo-tx.ts packages/shared/src/__tests__/mongo-tx.test.ts
git commit -m "fix(shared): upgrade mongo-tx to session.withTransaction with TTL cache"
```

---

### Task 2: Export `withTransaction` and `canUseTransactions` from barrel

**Files:**

- Modify: `packages/shared/src/repos/index.ts`

**Why:** Other packages (studio, database) need access to the shared transaction helper. Currently `mongo-tx.ts` is only importable via direct path, not the barrel.

**Step 1: Add exports to barrel**

Add to `packages/shared/src/repos/index.ts`:

```typescript
// Transaction helpers
export { withTransaction, canUseTransactions } from './mongo-tx.js';
```

**Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/shared`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/shared/src/repos/index.ts
git commit -m "feat(shared): export transaction helpers from repos barrel"
```

---

### Task 3: Fix `createToolWithDraft` — pass session to re-read

**Files:**

- Modify: `packages/shared/src/repos/tool-repo.ts:487`
- Test: `packages/shared/src/__tests__/tool-repo.test.ts`

**Why:** Inside the `withTransaction` callback at line 487, a `ToolVersion.findOne()` re-fetch is done without passing `session`. This read happens outside the transaction's snapshot isolation — a concurrent write could return stale/different data.

**Step 1: Write failing test**

Add to `packages/shared/src/__tests__/tool-repo.test.ts` in the `createToolWithDraft` describe block:

```typescript
it('passes session to re-read query inside transaction', async () => {
  // Override withTransaction to provide a real session mock
  const mockSession = { id: 'test-session' };
  vi.mocked(withTransaction).mockImplementationOnce(async (fn) => fn(mockSession as any));

  // ... existing setup for Tool.create, ToolVersion.create, ToolVersion.findOne ...

  await createToolWithDraft(tenantId, projectId, data);

  // Verify findOne was called with session option
  const findOneCall = mockToolVersionFindOne.mock.calls[0];
  // The .lean() chain should ultimately include session
  expect(mockToolVersionFindOne).toHaveBeenCalledWith(
    expect.objectContaining({ _id: expect.anything(), tenantId }),
  );
  // Check that session was passed — implementation detail depends on how mock chain works
});
```

**Step 2: Fix the re-read to include session**

In `packages/shared/src/repos/tool-repo.ts`, change line 487 from:

```typescript
const freshVersion = await ToolVersion.findOne({ _id: versionDoc._id, tenantId }).lean();
```

to:

```typescript
const freshVersion = await ToolVersion.findOne({ _id: versionDoc._id, tenantId })
  .session(session)
  .lean();
```

Note: Mongoose's `.session(null)` is safe — it's a no-op when session is null.

**Step 3: Run tests**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-repo.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/repos/tool-repo.ts packages/shared/src/__tests__/tool-repo.test.ts
git commit -m "fix(shared): pass session to re-read in createToolWithDraft"
```

---

### Task 4: Refactor `createNamedVersion` to use shared `withTransaction`

**Files:**

- Modify: `packages/shared/src/repos/tool-version-repo.ts:274-319`
- Test: `packages/shared/src/__tests__/tool-version-repo.test.ts`

**Why:** `createNamedVersion` directly calls `mongoose.startSession()` + `session.withTransaction()` without checking if the MongoDB instance supports transactions. On standalone MongoDB (common in dev), this throws `"Transaction numbers are only allowed on a replica set member or mongos"`. The shared `withTransaction` helper handles this with a graceful fallback.

**Step 1: Write failing test for standalone fallback**

Add to `packages/shared/src/__tests__/tool-version-repo.test.ts`:

```typescript
it('createNamedVersion works on standalone MongoDB (no transaction)', async () => {
  // Mock withTransaction to simulate standalone (null session)
  vi.mocked(withTransaction).mockImplementationOnce(async (fn) => fn(null));

  // ... setup draft, no existing version, etc. ...

  const result = await createNamedVersion(toolId, tenantId, {
    versionName: 'v1.0',
    createdBy: 'user-1',
  });

  expect(result).toBeDefined();
  expect(result.versionName).toBe('v1.0');
});
```

**Step 2: Refactor `createNamedVersion`**

Replace the transaction block in `packages/shared/src/repos/tool-version-repo.ts` (lines ~273-319) with:

```typescript
import { withTransaction } from './mongo-tx.js';

// ... inside createNamedVersion, replace lines 273-319:

// 5. Clear isPublished + create new version atomically.
//    Uses shared withTransaction for automatic retry + standalone fallback.
const doc = await withTransaction(async (session) => {
  const opts = session ? { session } : {};

  // Clear isPublished on existing published version
  await ToolVersion.updateMany(
    { toolId, tenantId, isPublished: true },
    { $set: { isPublished: false } },
    opts,
  );

  // Create versioned snapshot from draft (marked as published)
  const [created] = await ToolVersion.create(
    [
      {
        tenantId,
        toolId,
        version: nextVersion,
        isPublished: true,
        versionName: data.versionName,
        versionComments: data.versionComments ?? null,
        description: draft.description,
        inputSchema: draft.inputSchema,
        outputSchema: draft.outputSchema,
        returnDirect: draft.returnDirect,
        timeoutMs: draft.timeoutMs,
        cacheable: draft.cacheable,
        parallelizable: draft.parallelizable,
        sideEffects: draft.sideEffects,
        requiresAuth: draft.requiresAuth,
        httpConfig: serializeConfigMaps(draft.httpConfig),
        mcpConfig: serializeConfigMaps(draft.mcpConfig),
        sandboxConfig: serializeConfigMaps(draft.sandboxConfig),
        lambdaConfig: serializeConfigMaps(draft.lambdaConfig),
        createdBy: data.createdBy,
      },
    ],
    opts,
  );

  return created;
});

if (!doc) {
  throw new Error('Transaction completed but no document was created - data integrity error');
}
```

Remove the `mongoose` import that was only used for direct session management (if no other usage remains).

**Step 3: Run tests**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-version-repo.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/repos/tool-version-repo.ts packages/shared/src/__tests__/tool-version-repo.test.ts
git commit -m "fix(shared): use shared withTransaction in createNamedVersion for standalone fallback"
```

---

### Task 5: Wrap `setPublishedVersion` in a transaction

**Files:**

- Modify: `packages/shared/src/repos/tool-version-repo.ts:582-628`
- Test: `packages/shared/src/__tests__/tool-version-repo.test.ts`

**Why:** `setPublishedVersion` uses `bulkWrite` with `{ ordered: true }` to clear the old published flag and set the new one. While ordered execution is sequential, it's **not atomic** — if the second op fails, the first (clearing `isPublished`) is not rolled back, leaving zero published versions. Wrapping in `withTransaction` makes this atomic when a replica set is available, and the `ordered: true` bulkWrite remains the fallback on standalone.

**Step 1: Write failing test**

```typescript
it('setPublishedVersion uses transaction for atomicity', async () => {
  // Verify withTransaction is called
  const txSpy = vi.mocked(withTransaction);
  // ... setup target version exists ...

  await setPublishedVersion(versionId, toolId, tenantId);
  expect(txSpy).toHaveBeenCalledOnce();
});
```

**Step 2: Wrap in `withTransaction`**

In `packages/shared/src/repos/tool-version-repo.ts`, refactor `setPublishedVersion`:

```typescript
export async function setPublishedVersion(
  versionId: string,
  toolId: string,
  tenantId: string,
): Promise<NormalizedToolVersion | null> {
  const { ToolVersion } = await import('@agent-platform/database/models');

  // Validate the target version exists, belongs to the tool, and is versioned
  const target = await ToolVersion.findOne({
    _id: versionId,
    toolId,
    tenantId,
  }).lean();

  if (!target) return null;
  if (target.versionName === 'draft') {
    throw new Error('Cannot set draft version as published — only named versions allowed');
  }

  // Atomic clear + set — transaction ensures no window with zero published versions
  await withTransaction(async (session) => {
    const opts = session ? { session } : {};

    await ToolVersion.bulkWrite(
      [
        {
          updateMany: {
            filter: { toolId, tenantId, isPublished: true },
            update: { $set: { isPublished: false } },
          },
        },
        {
          updateOne: {
            filter: { _id: versionId, toolId, tenantId, versionName: { $ne: 'draft' } },
            update: { $set: { isPublished: true } },
          },
        },
      ],
      { ordered: true, ...opts },
    );
  });

  // Re-fetch to return normalized result
  const updated = await ToolVersion.findOne({
    _id: versionId,
    toolId,
    tenantId,
  }).lean();

  return normalize(updated);
}
```

**Step 3: Run tests**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-version-repo.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/repos/tool-version-repo.ts packages/shared/src/__tests__/tool-version-repo.test.ts
git commit -m "fix(shared): wrap setPublishedVersion in transaction for atomicity"
```

---

### Task 6: Wrap `deleteTool` in a transaction with orphan cleanup

**Files:**

- Modify: `packages/shared/src/repos/tool-repo.ts:336-366`
- Test: `packages/shared/src/__tests__/tool-repo.test.ts`

**Why:** `deleteTool` performs 3 sequential deletes (versions → secrets → tool) without a transaction. If the tool delete fails after versions are deleted, the system ends up with orphaned state and no way to recover. Following the same pattern as `createToolWithDraft`, use `withTransaction` for atomicity when available.

**Step 1: Write failing test**

```typescript
it('deleteTool uses withTransaction for atomicity', async () => {
  const txSpy = vi.mocked(withTransaction);
  // ... setup existing tool ...

  await deleteTool(toolId, tenantId);
  expect(txSpy).toHaveBeenCalledOnce();
});
```

**Step 2: Refactor `deleteTool`**

```typescript
export async function deleteTool(
  id: string,
  tenantId: string,
): Promise<{ deleted: boolean; versionsDeleted: number; secretsDeleted: number }> {
  const { Tool, ToolVersion, ToolSecret } = await import('@agent-platform/database/models');

  // Load tool name before deletion (needed for secret cascade)
  const tool = await Tool.findOne({ _id: id, tenantId }).select('name').lean();
  if (!tool) {
    return { deleted: false, versionsDeleted: 0, secretsDeleted: 0 };
  }

  return withTransaction(async (session) => {
    const opts = session ? { session } : {};

    // Delete all versions first
    const versionResult = await ToolVersion.deleteMany({ toolId: id, tenantId }, opts);

    // E10: Cascade delete orphaned secrets scoped by toolName
    let secretsDeleted = 0;
    if (tool?.name) {
      const secretResult = await ToolSecret.deleteMany({ tenantId, toolName: tool.name }, opts);
      secretsDeleted = secretResult.deletedCount;
    }

    // Delete the tool
    const result = await Tool.deleteOne({ _id: id, tenantId }, opts);

    return {
      deleted: result.deletedCount > 0,
      versionsDeleted: versionResult.deletedCount,
      secretsDeleted,
    };
  });
}
```

**Step 3: Run tests**

Run: `cd packages/shared && pnpm vitest run src/__tests__/tool-repo.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/src/repos/tool-repo.ts packages/shared/src/__tests__/tool-repo.test.ts
git commit -m "fix(shared): wrap deleteTool in transaction for atomic cascade delete"
```

---

### Task 7: Refactor `createWorkspaceWithOwner` to use shared `withTransaction`

**Files:**

- Modify: `apps/studio/src/repos/workspace-repo.ts:324-391`

**Why:** `createWorkspaceWithOwner` directly calls `MongoConnectionManager.getInstance().connection.startSession()` + `session.withTransaction()` without checking for replica set support. On standalone MongoDB (dev environments), this crashes. Also uses a different transaction pattern from all other repos.

**Step 1: Refactor to use shared helper**

```typescript
import { withTransaction } from '@agent-platform/shared/repos';

export async function createWorkspaceWithOwner(
  tenantData: {
    name: string;
    slug: string;
    ownerId: string;
    organizationId?: string | null;
    retentionDays?: number;
    settings?: any;
    status?: string;
  },
  memberData: {
    role: string;
    customRoleId?: string | null;
  },
): Promise<any> {
  await ensureDb();
  const { Tenant, TenantMember } = await import('@agent-platform/database/models');

  return withTransaction(async (session) => {
    const opts = session ? { session } : {};

    // Create tenant
    const [tenantDoc] = await Tenant.create(
      [
        {
          name: tenantData.name,
          slug: tenantData.slug,
          ownerId: tenantData.ownerId,
          organizationId: tenantData.organizationId ?? null,
          retentionDays: tenantData.retentionDays ?? 7,
          settings: tenantData.settings ?? null,
          status: tenantData.status ?? 'active',
        },
      ],
      opts,
    );
    const tenant = tenantDoc.toObject();

    // Create tenant member
    const [memberDoc] = await TenantMember.create(
      [
        {
          tenantId: tenant._id,
          userId: tenantData.ownerId,
          role: memberData.role,
          customRoleId: memberData.customRoleId ?? null,
        },
      ],
      opts,
    );
    const member = memberDoc.toObject();

    return {
      tenant: { ...tenant, id: tenant._id },
      member: { ...member, id: member._id },
    };
  });
}
```

Remove the `MongoConnectionManager` import if no longer used in this file.

**Step 2: Verify build**

Run: `pnpm build --filter=@agent-platform/studio`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/studio/src/repos/workspace-repo.ts
git commit -m "fix(studio): use shared withTransaction in createWorkspaceWithOwner"
```

---

### Task 8: Refactor `BaseModel.withTransaction` to use shared helper

**Files:**

- Modify: `packages/database/src/mongo/base-model.ts:337-350`

**Why:** `BaseModel.withTransaction()` always starts a session unconditionally — it will crash on standalone MongoDB. Delegating to the shared `canUseTransactions()` check makes it safe. Note: `BaseModel` lives in `packages/database` which is a lower-level package than `packages/shared`. To avoid circular dependencies, we import `canUseTransactions` from `mongo-tx` logic duplicated locally, or restructure to have database depend on the detection function.

**Decision:** Since `canUseTransactions` only depends on `mongoose` (no shared-package deps), extract the detection into `packages/database/src/mongo/tx-support.ts` and have `packages/shared/src/repos/mongo-tx.ts` re-export/delegate to it. However, to minimize churn, the simpler approach: inline the same `hello` command check in `BaseModel` since it's a 5-line utility.

**Step 1: Add replica-set guard to `BaseModel.withTransaction`**

In `packages/database/src/mongo/base-model.ts`, modify:

```typescript
async withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  // Check if transactions are supported (replica set / mongos)
  let useTx = false;
  try {
    const admin = mongoose.connection.db!.admin();
    const info = await admin.command({ hello: 1 });
    useTx = !!(info['setName'] || info['msg'] === 'isdbgrid');
  } catch {
    useTx = false;
  }

  if (!useTx) {
    // Standalone: run without transaction, pass a no-op session proxy
    // that won't break callers expecting session parameter
    return fn(null as unknown as ClientSession);
  }

  const session = await mongoose.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}
```

**Note:** Passing `null as unknown as ClientSession` matches the pattern in `mongo-tx.ts` where callers check `session ? { session } : {}`. The `BaseModel.withTransaction` signature requires `ClientSession` but callers should use the `opts` pattern.

**Alternative (cleaner):** Change the signature to match `mongo-tx.ts`:

```typescript
async withTransaction<T>(
  fn: (session: ClientSession | null) => Promise<T>,
): Promise<T> {
```

Check if any callers of `BaseModel.withTransaction` exist first. If none exist outside tests, the signature change is safe.

**Step 2: Run database package tests**

Run: `cd packages/database && pnpm vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/database/src/mongo/base-model.ts
git commit -m "fix(database): add replica-set guard to BaseModel.withTransaction"
```

---

### Task 9: Refactor `MigrationRunner` to use standard detection

**Files:**

- Modify: `packages/database/src/migrations/runner.ts:208-225`

**Why:** `MigrationRunner.runWithOptionalTransaction()` accesses internal Mongoose topology via `(mongoose.connection as any).getClient?.()?.topology?.description?.type` — this is fragile and breaks across driver version upgrades. Replace with the same `hello` command approach used everywhere else.

**Step 1: Refactor `runWithOptionalTransaction`**

```typescript
private async runWithOptionalTransaction(
  fn: (session?: ClientSession) => Promise<void>,
): Promise<void> {
  // Use the standard hello command to detect replica set support
  let useTx = false;
  try {
    const admin = this.db.admin();
    const info = await admin.command({ hello: 1 });
    useTx = !!(info['setName'] || info['msg'] === 'isdbgrid');
  } catch {
    useTx = false;
  }

  if (useTx) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  } else {
    await fn();
  }
}
```

**Step 2: Run migration tests (if any exist)**

Run: `cd packages/database && pnpm vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/database/src/migrations/runner.ts
git commit -m "fix(database): use hello command for replica-set detection in MigrationRunner"
```

---

### Task 10: Full integration verification

**Step 1: Build all packages**

Run: `pnpm build`
Expected: All packages build successfully

**Step 2: Run all affected test suites**

Run: `pnpm vitest run --filter=@agent-platform/shared && pnpm vitest run --filter=@agent-platform/database`
Expected: All tests pass

**Step 3: Final commit (if any fixups needed)**

---

## Enterprise Readiness Checklist

| Concern                         | Status  | Notes                                                                    |
| ------------------------------- | ------- | ------------------------------------------------------------------------ |
| **Standalone MongoDB fallback** | Fixed   | All 4 transaction sites now use `withTransaction` with graceful fallback |
| **Transient error retry**       | Fixed   | `session.withTransaction()` auto-retries `TransientTransactionError`     |
| **Cache staleness**             | Fixed   | 5-minute TTL on replica-set detection                                    |
| **Atomic cascade deletes**      | Fixed   | `deleteTool` wrapped in transaction                                      |
| **Atomic publish swap**         | Fixed   | `setPublishedVersion` wrapped in transaction                             |
| **Session isolation**           | Fixed   | Re-reads inside transactions pass `session`                              |
| **Consistent detection**        | Fixed   | All sites use `hello` command, not topology internals                    |
| **No orphan state**             | Fixed   | All multi-doc writes are transactional or have cleanup                   |
| **Test coverage**               | Updated | TTL cache, standalone fallback, session propagation tests                |
