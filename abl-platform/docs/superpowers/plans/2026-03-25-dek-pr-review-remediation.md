# DEK PR Review Remediation + Full Scope Restoration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 18 PR review findings from PR #505, restore configurable epoch-based DEK rotation per tenant (time + usage), AND restore project+environment KMS scoping so consumers can have different KMS configs per environment.

**Status:** ✅ ALL 20 TASKS COMPLETE (2026-03-26). 166 tests passing, 27 packages build clean, 0 failures.

**Architecture:** The PR simplified DEK scoping from `(tenant, project, environment)` to tenant-only, which removed per-environment KMS isolation and broke epoch-based auto-rotation. This plan:

1. Fixes all critical/high bugs (cross-tenant DEK ID leakage, format detection, auth fallback)
2. Restores `DEKScope = { tenantId, projectId, environment }` — each project+environment can use a different KMS provider. All three fields are **required** (Decision 1: greenfield, no existing DEK data).
3. Restores epoch-based rotation: `dekEpochIntervalHours` + `dekMaxUsageCount` per tenant (Decision 9)
4. Restores the 5-level KMS config inheritance chain + materializer, triggered synchronously on config change (Decision 11)
5. Threads project+environment scope through `encryptForTenantAuto`/`decryptForTenantAuto` API
6. Implements Hybrid A+C plugin scope (Decision 2): per-model `scope: 'tenant'|'project'` declaration + document fields for tenantId/projectId + AsyncLocalStorage for environment
7. Uses opaque `nanoid(16)` DEK IDs (Decision 3) — decrypt needs no scope, just dekId

**Design Decisions:** All 14 binding decisions are documented in [`docs/specs/dek-encryption-design-decisions.md`](../../specs/dek-encryption-design-decisions.md). Every task in this plan must conform to them.

**Tech Stack:** TypeScript, Mongoose, Node.js crypto, nanoid, BullMQ (re-encryption queue)

**Branch:** `feature/epoch-removal-dek-cache-fix` (current)

**PR:** https://bitbucket.org/koreteam1/abl-platform/pull-requests/505

**Develop reference:** All files prefixed `origin/develop:` are the source of truth for the original implementation.

---

## Issue Triage (from PR review)

| #   | Severity | Issue                                                                    | Task                                           |
| --- | -------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| 1   | CRITICAL | Cross-tenant `_lastAcquiredDekId` leakage                                | Task 1                                         |
| 2   | CRITICAL | `isDEKEnvelopeFormat` duplicated with different thresholds               | Task 2                                         |
| 4   | HIGH     | `resolveAuthConfig` falls back to env vars on per-tenant decrypt failure | Task 3                                         |
| 3   | HIGH     | `decrypt()` silently returns ciphertext for unrecognized formats         | Task 4                                         |
| 5   | HIGH     | `decryptForTenant` sync breaks on DEK envelope with cold cache           | Task 5                                         |
| 6   | HIGH     | `insertMany` facade path lacks explicit double-encryption guard          | Task 6                                         |
| 7   | HIGH     | Rotation job vs new DEK model mismatch (restore epoch)                   | Task 7                                         |
| —   | HIGH     | DEKScope must be `(tenant, project, environment)`                        | Tasks 8-13                                     |
| 8   | MEDIUM   | Platform default never cached in L1                                      | Task 14                                        |
| 9   | MEDIUM   | Removed exported interfaces                                              | Task 9 (folded into Task 8)                    |
| 10  | MEDIUM   | `encryptForTenantAuto` lacks PBKDF2 fallback on facade error             | Task 15                                        |
| 12  | MEDIUM   | DEK facade init duplicated across 4 servers                              | Task 16                                        |
| 13  | MEDIUM   | `reason` field not validated at runtime                                  | Task 17                                        |
| 11  | LOW      | Orphaned `MaterializedKMSConfig` documents                               | Resolved by Task 10 (un-stubbing materializer) |
| 14  | LOW      | `console.warn/info` in `packages/database/`                              | Task 18 (doc-only)                             |
| 15  | LOW      | Scope creep: A2A additions in `server.ts`                                | Out of scope (separate PR)                     |
| 16  | LOW      | Unrelated Studio changes bundled                                         | Out of scope (separate PR)                     |
| 17  | LOW      | `configActive` field removed from PUT response                           | Task 19                                        |
| 18  | LOW      | ClickHouse column name mismatch                                          | Task 18 (doc-only)                             |

---

## Phase Overview

| Phase                     | Tasks | Focus                                                                                                                                                                                      | Commit Scope                                           |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **A: Critical Bug Fixes** | 1-6   | Cross-tenant bug, format detection, auth fallback, sync path, double-encrypt guard                                                                                                         | packages/database, packages/shared-encryption          |
| **B: Epoch Restoration**  | 7     | Restore time+usage rotation with epoch dedup (Decision 4/13), fire-and-forget $inc (Decision 6)                                                                                            | packages/database, apps/runtime                        |
| **C: Scope Restoration**  | 8-13  | Restore `(tenant, project, environment)` scope with opaque nanoid dekId (Decision 3), Hybrid A+C plugin (Decision 2), two-layer middleware (Decision 12), `'_shared'` default (Decision 7) | packages/database, packages/shared-encryption, apps/\* |
| **D: Medium/Low Fixes**   | 14-19 | Caching, fallback, dedup init, validation, docs                                                                                                                                            | All                                                    |

---

## File Map

### Modified Files

| File                                                            | Responsibility                                                                                  | Tasks    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| `packages/database/src/kms/dek-manager.ts`                      | DEK lifecycle, acquire (nanoid dekId), unwrap (dekId-only lookup), rotate                       | 1, 7, 9  |
| `packages/shared-encryption/src/encryption-registry.ts`         | Format detection (private `isDEKEnvelopeFormat`)                                                | 2        |
| `packages/shared-encryption/src/legacy-format-detection.ts`     | Format detection (exported `isDEKEnvelopeFormat`)                                               | 2        |
| `packages/database/src/kms/kms-provider-pool.ts`                | Auth config resolution — fail-closed (Decision 14 for auth)                                     | 3        |
| `packages/shared-encryption/src/tenant-encryption-facade.ts`    | Decrypt format routing (Decision 14: return encrypted + warn), scope threading                  | 4, 5, 11 |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`      | Mongoose plugin — Hybrid A+C scope (Decision 2)                                                 | 6, 13    |
| `apps/runtime/src/services/kms/kms-rotation-job.ts`             | Periodic rotation job — epoch dedup (Decision 4)                                                | 7        |
| `packages/database/src/models/tenant-kms-config.model.ts`       | Tenant KMS config schema + project/env overrides, epoch config per-tenant (Decision 9)          | 7, 8     |
| `packages/database/src/models/dek-registry.model.ts`            | DEK registry — nanoid dekId (Decision 3), epoch dedup (Decision 4), expiresAt (Decision 5)      | 7, 9     |
| `packages/database/src/kms/kms-resolver.ts`                     | KMS config resolution — 3-dimensional resolve, 5-level inheritance                              | 10, 14   |
| `packages/database/src/models/materialized-kms-config.model.ts` | Pre-resolved KMS config per `(tenantId, projectId, environment)`                                | 10       |
| `packages/shared-encryption/src/index.ts`                       | Async encrypt/decrypt exports — add scope params                                                | 12, 15   |
| `packages/shared-encryption/src/engine.ts`                      | Sync encrypt/decrypt — scope threading                                                          | 5, 12    |
| `apps/runtime/src/routes/kms-admin.ts`                          | Admin API — separate endpoints per scope (Decision 10), sync materializer trigger (Decision 11) | 17, 19   |
| `apps/runtime/src/server.ts`                                    | Facade init, two-layer middleware (Decision 12)                                                 | 13, 16   |
| `apps/search-ai/src/server.ts`                                  | Facade init                                                                                     | 16       |
| `apps/search-ai-runtime/src/server.ts`                          | Facade init                                                                                     | 16       |
| `apps/studio/src/lib/ensure-db.ts`                              | Facade init                                                                                     | 16       |
| `apps/runtime/src/services/llm/model-resolution.ts`             | Credential decrypt — pass scope                                                                 | 13       |
| `apps/runtime/src/routes/channel-connections.ts`                | Connection encrypt/decrypt — pass scope                                                         | 13       |
| `apps/runtime/src/channels/connection-resolver.ts`              | Channel decrypt — pass scope                                                                    | 13       |
| `apps/runtime/src/services/queues/delivery-worker.ts`           | Webhook decrypt — pass scope                                                                    | 13       |
| `apps/runtime/src/routes/deployments.ts`                        | Deployment decrypt — pass scope                                                                 | 13       |

### New/Restored Files

| File                                                | Responsibility                                                  | Task |
| --------------------------------------------------- | --------------------------------------------------------------- | ---- |
| `packages/database/src/kms/dek-facade-factory.ts`   | Shared facade initialization helper                             | 16   |
| `apps/runtime/src/services/kms/kms-materializer.ts` | Restore 5-level config materializer (sync trigger, Decision 11) | 10   |

---

## Phase A: Critical Bug Fixes (Tasks 1-6)

### Task 1: Fix cross-tenant `_lastAcquiredDekId` leakage (CRITICAL #1)

**Problem:** `_lastAcquiredDekId` is a single string shared across all tenants. When tenant A acquires and tenant B acquires, `getActiveDEKId()` returns B's ID for everyone. Sync encrypt uses this to look up cached DEK — cross-tenant data corruption.

**Design alignment:** Per Decision 3 (opaque dekId), the active DEK tracking must be keyed by full `DEKScope` (not just tenantId) since different scopes have independent DEKs.

**Files:**

- Modify: `packages/database/src/kms/dek-manager.ts:169,253,335,417,441-443`
- Modify: `packages/shared-encryption/src/tenant-encryption-facade.ts:47,135-137`

- [ ] **Step 1: Change `_lastAcquiredDekId` from `string` to `Map<string, string>` keyed by scope**

In `dek-manager.ts`:

```typescript
// Line 169: Replace
private _lastAcquiredDekId: string | null = null;
// With:
private _lastAcquiredDekIds = new Map<string, string>();

// Add scope key helper:
private scopeKey(scope: DEKScope): string {
  return `${scope.tenantId}:${scope.projectId}:${scope.environment}`;
}

// Line 253: Replace
this._lastAcquiredDekId = actualDekId;
// With:
this._lastAcquiredDekIds.set(this.scopeKey(scope), actualDekId);

// Line 335: Replace
this._lastAcquiredDekId = dekId;
// With:
this._lastAcquiredDekIds.set(this.scopeKey(scope), dekId);

// Line 417: Replace
this._lastAcquiredDekId = null;
// With:
this._lastAcquiredDekIds.delete(this.scopeKey(scope));

// Lines 441-443: Replace
getActiveDEKId(): string {
  return this._lastAcquiredDekId ?? DEKManager.ACTIVE_DEK_ID;
}
// With:
getActiveDEKId(scope?: DEKScope): string {
  if (scope) {
    return this._lastAcquiredDekIds.get(this.scopeKey(scope)) ?? DEKManager.ACTIVE_DEK_ID;
  }
  return DEKManager.ACTIVE_DEK_ID;
}

// Line 448: Replace
this._lastAcquiredDekId = null;
// With:
this._lastAcquiredDekIds.clear();
```

- [ ] **Step 2: Update `DEKManagerLike` interface + `encryptSync` in `tenant-encryption-facade.ts`**

```typescript
// Line 47:
getActiveDEKId?(scope?: DEKScope): string;

// Line 137:
const dekId = this.dekManager.getActiveDEKId(scope);
```

- [ ] **Step 3: Build and test both packages**

```bash
cd packages/database && pnpm build && pnpm test -- --run
cd ../shared-encryption && pnpm build && pnpm test -- --run
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/database/src/kms/dek-manager.ts packages/shared-encryption/src/tenant-encryption-facade.ts
git add packages/database/src/kms/dek-manager.ts packages/shared-encryption/src/tenant-encryption-facade.ts
git commit -m "[ABLP-2] fix(kms): replace shared _lastAcquiredDekId with per-scope Map

Cross-tenant DEK ID leakage: _lastAcquiredDekId was a single string
shared across all tenants/scopes. Changed to Map<scopeKey, dekId>
keyed by (tenantId:projectId:environment)."
```

---

### Task 2: Unify duplicate `isDEKEnvelopeFormat` (CRITICAL #2)

**Problem:** Two copies with different thresholds: `encryption-registry.ts` uses `<= 40` (rejects 40-char), `legacy-format-detection.ts` uses `< 40` (accepts 40-char).

**Files:**

- Modify: `packages/shared-encryption/src/encryption-registry.ts:51-67` — delete private copy, import from legacy-format-detection

- [ ] **Step 1: Delete private `isDEKEnvelopeFormat` from `encryption-registry.ts` (lines 46-67), add import**

```typescript
// Add to imports at top:
import { isDEKEnvelopeFormat } from './legacy-format-detection.js';
// Delete lines 46-67 (the private isDEKEnvelopeFormat function)
```

`isAlreadyEncrypted()` already calls `isDEKEnvelopeFormat` — it will now use the canonical version.

- [ ] **Step 2: Build and test**

```bash
cd packages/shared-encryption && pnpm build && pnpm test -- --run
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/shared-encryption/src/encryption-registry.ts
git add packages/shared-encryption/src/encryption-registry.ts
git commit -m "[ABLP-2] fix(encryption): unify isDEKEnvelopeFormat to single source

Removed duplicate from encryption-registry.ts (value.length <= 40) and
import canonical version from legacy-format-detection.ts (value.length < 40)."
```

---

### Task 3: Fail-closed auth config fallback for per-tenant configs (HIGH #4)

**Design alignment:** Decision 14 says general decryption failures return encrypted value + warning. But auth config is a **special case** — per-tenant KMS auth config decrypt failure must throw (fail-closed), never silently fall back to platform env var credentials. A misconfigured tenant must not get access to platform KMS credentials.

**Files:**

- Modify: `packages/database/src/kms/kms-provider-pool.ts:291-308`

- [ ] **Step 1: Replace silent fallback with throw**

```typescript
// In resolveAuthConfig(), replace the catch block (lines 302-307):
} catch (err) {
  // FAIL CLOSED for per-tenant configs — distinct from Decision 14's
  // general "return encrypted + warn" policy. Auth config fallback to
  // platform credentials would be a privilege escalation.
  throw new Error(
    `Failed to decrypt per-tenant authConfigEncrypted for ${config.providerType}: ` +
    `${err instanceof Error ? err.message : String(err)}. ` +
    `Per-tenant KMS configs must have valid encrypted credentials.`
  );
}
```

- [ ] **Step 2: Build and test**

```bash
cd packages/database && pnpm build && pnpm test -- --run
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/database/src/kms/kms-provider-pool.ts
git add packages/database/src/kms/kms-provider-pool.ts
git commit -m "[ABLP-2] fix(kms): fail-closed on per-tenant auth config decrypt failure

Previously silently fell back to platform env vars, giving misconfigured
tenant access to platform KMS credentials. Now throws."
```

---

### Task 4: Log warning for unrecognized format in `decrypt()` (HIGH #3)

**Design alignment:** Decision 14 — return encrypted value as-is + warning log. The facade must never throw on decrypt failure.

**Files:**

- Modify: `packages/shared-encryption/src/tenant-encryption-facade.ts:94-98`

- [ ] **Step 1: Add warning for suspicious long unrecognized values**

```typescript
if (!isDEKEnvelopeFormat(ciphertext)) {
  if (ciphertext.length > 100) {
    log.warn('[tenant-encryption-facade] Unrecognized format returned as plaintext', {
      length: ciphertext.length,
      tenantId: scope.tenantId,
      hint: 'May be corrupted ciphertext — Decision 14: return encrypted + warn',
    });
  }
  return ciphertext;
}
```

Note: Use `createLogger('tenant-encryption-facade')` not `console.warn` per CLAUDE.md rules.

- [ ] **Step 2: Build, test, commit**

```bash
npx prettier --write packages/shared-encryption/src/tenant-encryption-facade.ts
cd packages/shared-encryption && pnpm build && pnpm test -- --run
git add packages/shared-encryption/src/tenant-encryption-facade.ts
git commit -m "[ABLP-2] fix(encryption): warn on unrecognized format in facade decrypt

Decision 14: return encrypted value as-is with warning log instead of
throwing. Logs model context for operational investigation."
```

---

### Task 5: Fix sync `decryptForTenant` for DEK envelope with cold cache (HIGH #5)

**Design alignment:** Decision 3 (opaque dekId) means decrypt only needs the dekId extracted from ciphertext. But sync path can't do async DEK unwrap. Must throw with clear error directing caller to async `decryptForTenantAuto()`.

**Files:**

- Modify: `packages/shared-encryption/src/engine.ts:20,122-134`

- [ ] **Step 1: Add `isDEKEnvelopeFormat` to import (line 20) and add format check before hex fallback**

```typescript
// Line 20: add isDEKEnvelopeFormat
import { isLegacyFormat, isDEKEnvelopeFormat } from './legacy-format-detection.js';

// Lines 122-134: add guard
decryptForTenant(encryptedData: string, tenantId: string): string {
  const facade = getEncryptionFacade();
  if (facade) {
    const dekResult = facade.decryptSync(encryptedData, { tenantId });
    if (dekResult !== null) return dekResult;
  }

  // DEK envelope with cold cache — can't parse as hex, need async path
  if (!isLegacyFormat(encryptedData) && isDEKEnvelopeFormat(encryptedData)) {
    throw new Error(
      'DEK envelope data requires async decryption (cache cold). ' +
      'Use decryptForTenantAuto() instead of decryptForTenant().'
    );
  }

  const key = this.deriveTenantKey(tenantId);
  return this.decryptFromHex3Part(encryptedData, key);
}
```

- [ ] **Step 2: Build, test, commit**

```bash
npx prettier --write packages/shared-encryption/src/engine.ts
cd packages/shared-encryption && pnpm build && pnpm test -- --run
git add packages/shared-encryption/src/engine.ts
git commit -m "[ABLP-2] fix(encryption): detect DEK envelope in sync decryptForTenant

Throws clear error instead of trying hex parse on base64 DEK envelope."
```

---

### Task 6: Add double-encryption guard to `insertMany` facade path (HIGH #6)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:400-404`

- [ ] **Step 1: Add `rejectIfAlreadyEncrypted` before facade encrypt**

```typescript
// Line 402-404: add guard before encrypt call
const strValue = typeof value === 'string' ? value : JSON.stringify(value);
rejectIfAlreadyEncrypted(field, strValue, 'insertMany/facade');
doc[field] = await encryptionFacade!.encrypt(strValue, { tenantId: tenantId });
```

- [ ] **Step 2: Build, test, commit**

```bash
npx prettier --write packages/database/src/mongo/plugins/encryption.plugin.ts
cd packages/database && pnpm build && pnpm test -- --run
git add packages/database/src/mongo/plugins/encryption.plugin.ts
git commit -m "[ABLP-2] fix(encryption): add double-encryption guard to insertMany facade path"
```

---

## Phase B: Epoch Restoration (Task 7)

### Task 7: Restore epoch-based DEK rotation with time + usage limits

**Problem:** New DEKs don't set `expiresAt` or `maxUsageCount`. The rotation job never transitions them. DEKs have unbounded lifetime — violates NIST SP 800-57.

**Design alignment:**

- **Decision 4** (epoch for dedup): `epoch` is an idempotency key for concurrent creation, not embedded in ciphertext. Format: `"2026-03-25T12"` (Decision 13: 12h minimum granularity)
- **Decision 5** (expiresAt): Precomputed on create as epoch boundary + intervalMs. Hot path checks `expiresAt < now` — no config lookup needed.
- **Decision 6** (fire-and-forget $inc): Usage count is non-blocking. `maxUsageCount` is safety ceiling (~2^30).
- **Decision 9** (epoch config per tenant): `dekEpochIntervalHours` and `dekMaxUsageCount` live on `TenantKMSConfig`, not per project/environment.

**Reference:** `origin/develop:apps/runtime/src/services/kms/dek-manager.ts` — used `calculateEpoch()`, `expiresAt`, `maxUsageCount`.

**Files:**

- Modify: `packages/database/src/models/dek-registry.model.ts` (un-deprecate `expiresAt`, `maxUsageCount`)
- Modify: `packages/database/src/models/tenant-kms-config.model.ts` (un-deprecate `dekEpochIntervalHours`, `dekMaxUsageCount`)
- Modify: `packages/database/src/kms/dek-manager.ts` (set fields on create, check usage, fire-and-forget $inc)
- Modify: `apps/runtime/src/services/kms/kms-rotation-job.ts` (add usage-based transition)

- [ ] **Step 1: Un-deprecate fields in DEK registry model**

In `dek-registry.model.ts`: Remove `@deprecated` JSDoc from `maxUsageCount` and `expiresAt` in both interface and schema.

- [ ] **Step 2: Un-deprecate epoch config in TenantKMSConfig**

In `tenant-kms-config.model.ts`: Remove `@deprecated` from `dekEpochIntervalHours` and `dekMaxUsageCount`. Add proper JSDoc:

```typescript
/** Hours per DEK epoch (default: 24). Controls expiresAt on new DEKs. Per-tenant only (Decision 9). */
dekEpochIntervalHours: number;
/** Max encryptions per DEK (default: 2^30). Safety ceiling, not precise limit (Decision 6). */
dekMaxUsageCount: number;
```

- [ ] **Step 3: Add `calculateEpoch()` and `getEpochConfig()` to DEKManager**

```typescript
/** Decision 13: epoch string for dedup. 12h minimum granularity. */
private calculateEpoch(intervalHours: number): string {
  const intervalMs = Math.max(intervalHours, 12) * 60 * 60 * 1000;
  return new Date(Math.floor(Date.now() / intervalMs) * intervalMs)
    .toISOString()
    .slice(0, 13);
}

private async getEpochConfig(tenantId: string): Promise<{ epochIntervalHours: number; maxUsageCount: number }> {
  try {
    const { TenantKMSConfig } = await import('../models/index.js');
    const config = await TenantKMSConfig.findOne({ tenantId })
      .select('dekEpochIntervalHours dekMaxUsageCount')
      .lean();
    return {
      epochIntervalHours: (config as any)?.dekEpochIntervalHours ?? 24,
      maxUsageCount: (config as any)?.dekMaxUsageCount ?? (2 ** 30),
    };
  } catch {
    return { epochIntervalHours: 24, maxUsageCount: 2 ** 30 };
  }
}
```

- [ ] **Step 4: Set `expiresAt` + `maxUsageCount` + epoch on DEK create**

In `_doAcquireDEK`, before `DEKEntry.create()`:

```typescript
const epochConfig = await this.getEpochConfig(scope.tenantId);
const epoch = this.calculateEpoch(epochConfig.epochIntervalHours);
const intervalMs = Math.max(epochConfig.epochIntervalHours, 12) * 60 * 60 * 1000;
const epochNum = Math.floor(Date.now() / intervalMs);
const expiresAt = new Date((epochNum + 1) * intervalMs);

await DEKEntry.create({
  dekId: nanoid(16), // Decision 3: opaque ID
  tenantId: scope.tenantId,
  projectId: scope.projectId,
  environment: scope.environment,
  epoch, // Decision 4: dedup key for concurrent creation
  status: 'active',
  wrappedDek,
  kekKeyId,
  kekKeyVersion,
  usageCount: 1,
  maxUsageCount: epochConfig.maxUsageCount, // Decision 6: safety ceiling
  expiresAt, // Decision 5: precomputed for hot path
});
```

- [ ] **Step 5: Add fire-and-forget usage increment (Decision 6)**

After acquiring DEK, fire-and-forget:

```typescript
// Decision 6: non-blocking, eventually consistent
DEKEntry.updateOne({ dekId: actualDekId }, { $inc: { usageCount: 1 } }).catch((err) => {
  this.log.warn('Usage count increment failed', {
    dekId: actualDekId,
    error: err instanceof Error ? err.message : String(err),
  });
});
```

- [ ] **Step 6: Add usage-based auto-rotation check**

In `_doAcquireDEK`, after the `activeEntry` block:

```typescript
const currentUsage = (activeEntry.usageCount ?? 0) + 1;
if (
  activeEntry.maxUsageCount &&
  activeEntry.maxUsageCount > 0 &&
  currentUsage >= activeEntry.maxUsageCount
) {
  this.log.info('DEK usage limit reached, auto-rotating', {
    tenantId: scope.tenantId,
    dekId: actualDekId,
  });
  DEKEntry.updateOne(
    { dekId: actualDekId, status: 'active' },
    { $set: { status: 'decrypt_only' } },
  ).catch((err: unknown) => {
    this.log.warn('Auto-rotate failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  this.cache.evict(actualDekId);
  this._lastAcquiredDekIds.delete(this.scopeKey(scope));
}
```

- [ ] **Step 7: Add `transitionOverusedDEKs()` to rotation job**

In `kms-rotation-job.ts`, add Phase 1b:

```typescript
async function transitionOverusedDEKs(): Promise<number> {
  const { DEKEntry } = await import('@agent-platform/database/models');
  const result = await DEKEntry.updateMany(
    {
      status: 'active',
      maxUsageCount: { $gt: 0 },
      $expr: { $gte: ['$usageCount', '$maxUsageCount'] },
    },
    { $set: { status: 'decrypt_only' } },
  );
  if (result.modifiedCount > 0) {
    log.info('Transitioned overused DEKs', { count: result.modifiedCount });
  }
  return result.modifiedCount;
}
```

- [ ] **Step 8: Build, test, commit**

```bash
npx prettier --write packages/database/src/kms/dek-manager.ts packages/database/src/models/dek-registry.model.ts packages/database/src/models/tenant-kms-config.model.ts apps/runtime/src/services/kms/kms-rotation-job.ts
git add packages/database/src/kms/dek-manager.ts packages/database/src/models/dek-registry.model.ts packages/database/src/models/tenant-kms-config.model.ts apps/runtime/src/services/kms/kms-rotation-job.ts
git commit -m "[ABLP-2] feat(kms): restore epoch-based DEK rotation with time + usage limits

- Decision 4/13: epoch string for concurrent creation dedup (12h min)
- Decision 5: expiresAt precomputed on create for hot-path check
- Decision 6: fire-and-forget $inc for usage count
- Decision 9: epoch config per tenant
- DEKManager auto-rotates on usage limit exceeded
- Rotation job adds usage-based transition (Phase 1b)"
```

---

## Phase C: Scope Restoration — `(tenant, project, environment)` (Tasks 8-13)

### Task 8: Restore `TenantKMSConfig` model with project/environment overrides

**Design alignment:** Decision 10 (separate API endpoints per scope) requires the model to support per-project and per-environment overrides. Decision 9 (epoch config per tenant) means `dekEpochIntervalHours`/`dekMaxUsageCount` stay at tenant level only.

**Reference:** `origin/develop:packages/database/src/models/tenant-kms-config.model.ts`

**Files:**

- Modify: `packages/database/src/models/tenant-kms-config.model.ts`

- [ ] **Step 1: Restore `IKMSEnvironmentOverride` and `IKMSProjectOverride` interfaces**

```typescript
export interface IKMSEnvironmentOverride {
  environment: string;
  provider: IKMSProviderRef;
  tier: string;
}

export interface IKMSProjectOverride {
  projectId: string;
  defaultProvider: IKMSProviderRef | null;
  environments: IKMSEnvironmentOverride[];
}
```

- [ ] **Step 2: Add `environments` and `projects` to `ITenantKMSConfig` interface**

```typescript
environments: IKMSEnvironmentOverride[];
projects: IKMSProjectOverride[];
```

- [ ] **Step 3: Add embedded schemas and fields to main schema**

```typescript
const KMSEnvironmentOverrideSchema = new Schema<IKMSEnvironmentOverride>({
  environment: { type: String, required: true },
  provider: { type: KMSProviderRefSchema, required: true },
  tier: { type: String, required: true, enum: ['hsm', 'software-protected', 'platform-shared', 'local', 'ephemeral'] },
}, { _id: false });

const KMSProjectOverrideSchema = new Schema<IKMSProjectOverride>({
  projectId: { type: String, required: true },
  defaultProvider: { type: KMSProviderRefSchema, default: null },
  environments: { type: [KMSEnvironmentOverrideSchema], default: [] },
}, { _id: false });

// In main schema:
environments: { type: [KMSEnvironmentOverrideSchema], default: [] },
projects: { type: [KMSProjectOverrideSchema], default: [] },
```

- [ ] **Step 4: Build, test, commit**

```bash
npx prettier --write packages/database/src/models/tenant-kms-config.model.ts
cd packages/database && pnpm build && pnpm test -- --run
git add packages/database/src/models/tenant-kms-config.model.ts
git commit -m "[ABLP-2] feat(kms): restore project/environment overrides in TenantKMSConfig

Re-adds IKMSEnvironmentOverride, IKMSProjectOverride interfaces and
embedded schemas for per-project + per-environment KMS config."
```

---

### Task 9: Restore `DEKScope`, DEK registry model, and DEKManager to 3-dimensional

**Design alignment:**

- **Decision 1** (greenfield): `projectId` and `environment` are **required** fields, no `'_default'` fallback, no legacy indexes
- **Decision 3** (opaque dekId): `dekId` is `nanoid(16)`, globally unique. Decrypt lookup is `{ dekId }` only — no scope needed
- **Decision 4** (epoch dedup): Unique index `{ tenantId, projectId, environment, epoch }` for concurrent creation dedup
- **Decision 7** (`'_shared'`): Models without environment use `'_shared'`, not `'_default'`

**Reference:** `origin/develop:packages/database/src/models/dek-registry.model.ts` and `origin/develop:apps/runtime/src/services/kms/dek-manager.ts`

**Files:**

- Modify: `packages/database/src/models/dek-registry.model.ts` (add `dekId`, `projectId`, `environment`, update indexes)
- Modify: `packages/database/src/kms/dek-manager.ts` (update `DEKScope`, cache keys, queries)

- [ ] **Step 1: Update DEK registry schema (Decision 1/3/4)**

In `dek-registry.model.ts`:

```typescript
// Interface:
dekId: string;          // nanoid(16), globally unique (Decision 3)
tenantId: string;       // required
projectId: string;      // required (Decision 1: no default)
environment: string;    // required (Decision 1: no default)

// Schema:
dekId: { type: String, required: true, unique: true },  // Decision 3
projectId: { type: String, required: true },             // Decision 1: no default
environment: { type: String, required: true },           // Decision 1: no default

// Indexes (Decision 4):
DEKEntrySchema.index({ dekId: 1 }, { unique: true });  // Decision 3: decrypt lookup
DEKEntrySchema.index({ tenantId: 1, projectId: 1, environment: 1, epoch: 1 }, { unique: true });  // Decision 4: creation dedup
DEKEntrySchema.index({ tenantId: 1, projectId: 1, environment: 1, status: 1 });  // find active DEK
DEKEntrySchema.index({ status: 1 });  // rotation job
DEKEntrySchema.index({ kekKeyId: 1, status: 1 });  // re-encryption queries
// NO old { tenantId: 1, epoch: 1 } index — Decision 1: greenfield, no compat
```

- [ ] **Step 2: Update `DEKScope` in `dek-manager.ts` — all fields required**

```typescript
export interface DEKScope {
  tenantId: string;
  projectId: string; // required — no default
  environment: string; // required — no default
}
```

- [ ] **Step 3: Update `DEKCache` — key by dekId only (Decision 3)**

```typescript
// Decision 3: cache key is just dekId since it's globally unique
private key(dekId: string): string {
  return dekId;
}

get(dekId: string): DEKCacheEntry | null { ... }
set(dekId: string, entry: DEKCacheEntry): void { ... }
evict(dekId: string): boolean { ... }

evictByTenant(tenantId: string): number {
  // Must iterate — dekId doesn't encode tenant
  let evicted = 0;
  for (const [key, entry] of this.cache) {
    if (entry.tenantId === tenantId) {
      entry.plaintext.fill(0);
      this.cache.delete(key);
      evicted++;
    }
  }
  return evicted;
}
```

Note: `DEKCacheEntry` needs a `tenantId` field so `evictByTenant` can work without scope in the cache key.

- [ ] **Step 4: Update DEKEntry queries — use dekId for decrypt, full scope for encrypt**

In `_doAcquireDEK` (find active for encrypt):

```typescript
const activeEntry = await DEKEntry.findOne({
  tenantId: scope.tenantId,
  projectId: scope.projectId,
  environment: scope.environment,
  status: 'active',
})
  .sort({ createdAt: -1 })
  .lean();
```

In `unwrapDEK` (decrypt path — Decision 3: dekId only):

```typescript
const entry = await DEKEntry.findOne({
  dekId, // Decision 3: globally unique, no scope needed
  status: { $in: ['active', 'decrypt_only'] },
}).lean();
```

In `forceRotateDEK` (Decision 8: flexible scope):

```typescript
// If scope provided, rotate that scope only; if tenant-only, rotate all for tenant
const filter: Record<string, unknown> = { status: 'active' };
filter.tenantId = scope.tenantId;
if (scope.projectId) filter.projectId = scope.projectId;
if (scope.environment) filter.environment = scope.environment;
const result = await DEKEntry.updateMany(filter, { $set: { status: 'decrypt_only' } });
```

- [ ] **Step 5: Build, test, commit**

```bash
npx prettier --write packages/database/src/kms/dek-manager.ts packages/database/src/models/dek-registry.model.ts
cd packages/database && pnpm build && pnpm test -- --run
git add packages/database/src/kms/dek-manager.ts packages/database/src/models/dek-registry.model.ts
git commit -m "[ABLP-2] feat(kms): restore 3-dimensional DEKScope with opaque nanoid dekId

Decision 1: greenfield — projectId/environment required, no defaults
Decision 3: nanoid(16) dekId, decrypt lookup by dekId only
Decision 4: epoch for concurrent creation dedup
Decision 7: '_shared' for models without environment context
No backward compat indexes (no existing DEK data)."
```

---

### Task 10: Restore KMS Resolver with 3-dimensional resolve + Materializer

**Design alignment:**

- 5-level KMS config inheritance: project+env → project default → tenant env → tenant default → platform default
- **Decision 11** (sync materializer): Materialization runs synchronously in PUT/POST config handler
- **Decision 10** (separate endpoints): Admin API has separate endpoints per scope

**Reference:** `origin/develop:apps/runtime/src/services/kms/kms-resolver.ts` and `origin/develop:apps/runtime/src/services/kms/kms-materializer.ts`

**Files:**

- Modify: `packages/database/src/kms/kms-resolver.ts` — restore 3-param `resolve()`
- Modify: `packages/database/src/models/materialized-kms-config.model.ts` — un-stub
- Create/restore: `apps/runtime/src/services/kms/kms-materializer.ts`

- [ ] **Step 1: Add `dekEpochIntervalHours`, `dekMaxUsageCount` to `ResolvedKMSConfig`**

In `kms-resolver.ts`:

```typescript
export interface ResolvedKMSConfig {
  provider: IResolvedProviderRef;
  tier: string;
  keyId: string;
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  failurePolicy: string;
  sourceConfigVersion: number;
}
```

- [ ] **Step 2: Update `KMSConfigCache` to use 3-dimensional key**

```typescript
private key(tenantId: string, projectId: string, environment: string): string {
  return `${tenantId}:${projectId}:${environment}`;
}

get(tenantId: string, projectId: string, environment: string): ResolvedKMSConfig | null { ... }
set(tenantId: string, projectId: string, environment: string, config: ResolvedKMSConfig): void { ... }
```

- [ ] **Step 3: Update `resolve()` to accept 3 required params and query MaterializedKMSConfig**

```typescript
async resolve(tenantId: string, projectId: string, environment: string): Promise<ResolvedKMSConfig> {
  const cached = this.cache.get(tenantId, projectId, environment);
  if (cached) return cached;

  try {
    const { MaterializedKMSConfig } = await import('../models/index.js');
    const doc = await MaterializedKMSConfig.findOne({ tenantId, projectId, environment }).lean();
    if (doc) {
      const resolved: ResolvedKMSConfig = {
        provider: doc.resolvedProvider,
        tier: doc.resolvedTier,
        keyId: doc.resolvedKeyId,
        dekEpochIntervalHours: doc.dekEpochIntervalHours,
        dekMaxUsageCount: doc.dekMaxUsageCount,
        failurePolicy: doc.failurePolicy,
        sourceConfigVersion: doc.sourceConfigVersion,
      };
      this.cache.set(tenantId, projectId, environment, resolved);
      return resolved;
    }
  } catch (err) { ... }

  // Fallback: try TenantKMSConfig direct (for scopes without materialized docs)
  try {
    const { TenantKMSConfig } = await import('../models/index.js');
    const doc = await TenantKMSConfig.findOne({ tenantId }).lean();
    if (doc?.defaultProvider) {
      const resolved = { ...build from doc... };
      this.cache.set(tenantId, projectId, environment, resolved);
      return resolved;
    }
  } catch { ... }

  const platformDefault = getPlatformDefault();
  this.cache.set(tenantId, projectId, environment, platformDefault); // Task 14: cache platform default
  return platformDefault;
}
```

- [ ] **Step 4: Update `getPlatformDefault()` to include epoch fields**

```typescript
dekEpochIntervalHours: 24,
dekMaxUsageCount: 2 ** 30,
```

- [ ] **Step 5: Restore KMS Materializer (Decision 11: sync trigger)**

Copy `origin/develop:apps/runtime/src/services/kms/kms-materializer.ts` and update imports. This is the 5-level resolution chain: project+env override → project default → tenant env override → tenant default → platform default.

```bash
git show origin/develop:apps/runtime/src/services/kms/kms-materializer.ts > apps/runtime/src/services/kms/kms-materializer.ts
```

Then update imports from `@agent-platform/database/models` and `@agent-platform/database/kms` as needed.

- [ ] **Step 6: Wire materializer in kms-admin routes (Decision 11: sync on config change)**

In `apps/runtime/src/routes/kms-admin.ts`, after config PUT/POST, call `materializer.materialize(tenantId)` synchronously:

```typescript
// Decision 11: sync materialization on config change
await materializer.materialize(tenantId);
```

- [ ] **Step 7: Build, test, commit**

```bash
npx prettier --write packages/database/src/kms/kms-resolver.ts packages/database/src/models/materialized-kms-config.model.ts apps/runtime/src/services/kms/kms-materializer.ts apps/runtime/src/routes/kms-admin.ts
cd packages/database && pnpm build && pnpm test -- --run
git add packages/database/src/kms/kms-resolver.ts packages/database/src/models/materialized-kms-config.model.ts apps/runtime/src/services/kms/kms-materializer.ts apps/runtime/src/routes/kms-admin.ts
git commit -m "[ABLP-2] feat(kms): restore 3-dimensional KMS resolver + materializer

KMSResolver.resolve() now accepts (tenantId, projectId, environment).
Reads MaterializedKMSConfig first, falls back to TenantKMSConfig direct.
Restores KMSMaterializer with 5-level config inheritance chain.
Decision 11: materializer triggered synchronously on config change."
```

---

### Task 11: Thread scope through `TenantEncryptionFacade`

**Design alignment:**

- **Decision 3** (opaque dekId): `decrypt()` only needs `tenantId` for legacy PBKDF2 fallback; DEK decrypt uses dekId from ciphertext
- **Decision 7** (`'_shared'`): Default environment is `'_shared'`, not `'_default'`
- `DEKScope` in facade uses required fields matching DEKManager's interface

**Files:**

- Modify: `packages/shared-encryption/src/tenant-encryption-facade.ts`

- [ ] **Step 1: Update `DEKScope` interface — all fields required for encrypt**

```typescript
export interface DEKScope {
  tenantId: string;
  projectId: string; // required for encrypt; for decrypt, only tenantId needed (legacy fallback)
  environment: string; // required for encrypt; '_shared' for models without env context (Decision 7)
}
```

- [ ] **Step 2: Update encrypt to pass full scope, decrypt to use dekId only (Decision 3)**

```typescript
async encrypt(plaintext: string, scope: DEKScope): Promise<string> {
  // Full scope needed — determines which DEK to use
  const acquired = await this.dekManager.acquireDEK(scope, this.defaultKekKeyId);
  ...
}

async decrypt(ciphertext: string, scope: DEKScope): Promise<string> {
  // Decision 3: extract dekId from ciphertext, lookup by dekId only
  // scope.tenantId only used for legacy PBKDF2 fallback
  const { dekId, iv, authTag, encrypted } = decodeDEKEnvelope(ciphertext);
  const dek = await this.dekManager.unwrapDEK(dekId);  // No scope needed
  ...
}
```

- [ ] **Step 3: Update `DEKManagerLike` interface**

```typescript
export interface DEKManagerLike {
  acquireDEK(scope: DEKScope, kekKeyId: string): Promise<AcquiredDEK>;
  unwrapDEK(dekId: string): Promise<Buffer>; // Decision 3: no scope needed
  getCachedDEK?(dekId: string): Buffer | null;
  getActiveDEKId?(scope?: DEKScope): string;
  forceRotateDEK?(scope: DEKScope): Promise<number>;
  clearCache?(): void;
}
```

- [ ] **Step 4: Build, test, commit**

```bash
npx prettier --write packages/shared-encryption/src/tenant-encryption-facade.ts
cd packages/shared-encryption && pnpm build && pnpm test -- --run
git add packages/shared-encryption/src/tenant-encryption-facade.ts
git commit -m "[ABLP-2] feat(encryption): thread project+environment scope through facade

DEKScope has required tenantId/projectId/environment for encrypt.
Decrypt uses dekId only (Decision 3) — no scope needed for DEK lookup.
Decision 7: '_shared' for models without environment context."
```

---

### Task 12: Thread scope through `encryptForTenantAuto` / `decryptForTenantAuto`

**Design alignment:**

- **Decision 7**: Default environment is `'_shared'` (not `'_default'`)
- **Decision 3**: Decrypt technically doesn't need projectId/environment for DEK lookup, but passes them for legacy PBKDF2 compatibility

**Files:**

- Modify: `packages/shared-encryption/src/index.ts:173-193`
- Modify: `packages/shared-encryption/src/engine.ts:105-134`

- [ ] **Step 1: Add required scope params to async API**

In `packages/shared-encryption/src/index.ts`:

```typescript
export async function encryptForTenantAuto(
  plaintext: string,
  tenantId: string,
  projectId: string,
  environment: string,
): Promise<string> {
  const facade = getEncryptionFacade();
  if (facade) {
    try {
      return await facade.encrypt(plaintext, { tenantId, projectId, environment });
    } catch (err) {
      log.warn('[encryptForTenantAuto] DEK failed, falling back to PBKDF2', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return getEncryptionService().encryptForTenant(plaintext, tenantId);
}

export async function decryptForTenantAuto(
  encrypted: string,
  tenantId: string,
  projectId: string,
  environment: string,
): Promise<string> {
  const facade = getEncryptionFacade();
  if (facade) {
    return facade.decrypt(encrypted, { tenantId, projectId, environment });
  }
  return getEncryptionService().decryptForTenant(encrypted, tenantId);
}
```

Note: `projectId` and `environment` are required params. Callers that don't have project context (tenant-scoped models) should pass sentinel values — see Task 13 for caller updates.

- [ ] **Step 2: Update sync `encryptForTenant` / `decryptForTenant` in engine.ts**

```typescript
encryptForTenant(plaintext: string, tenantId: string, projectId?: string, environment?: string): string {
  if (isAlreadyEncrypted(plaintext)) { throw ... }
  const facade = getEncryptionFacade();
  if (facade) {
    const dekResult = facade.encryptSync(plaintext, {
      tenantId,
      projectId: projectId ?? '_tenant',
      environment: environment ?? '_tenant',
    });
    if (dekResult !== null) return dekResult;
  }
  const key = this.deriveTenantKey(tenantId);
  return this.encryptToHex3Part(plaintext, key);
}
```

- [ ] **Step 3: Build, test, commit**

```bash
npx prettier --write packages/shared-encryption/src/index.ts packages/shared-encryption/src/engine.ts
cd packages/shared-encryption && pnpm build && pnpm test -- --run
git add packages/shared-encryption/src/index.ts packages/shared-encryption/src/engine.ts
git commit -m "[ABLP-2] feat(encryption): add projectId/environment params to encrypt/decrypt API

encryptForTenantAuto and decryptForTenantAuto now require projectId and
environment for 3-dimensional DEK scoping. Tenant-scoped callers use
sentinel values. Decision 7: '_shared' for models without env context."
```

---

### Task 13: Update all callers to pass scope + implement Hybrid A+C plugin (Decision 2)

**Design alignment:**

- **Decision 2** (Hybrid A+C): Plugin reads tenantId/projectId from document fields, environment from document field or AsyncLocalStorage, falls back to `'_shared'` (Decision 7)
- **Decision 12** (two-layer middleware): Global middleware sets `{ environment: null }`, project routes override with deployment environment

**Files:** All files that call `encryptForTenantAuto` / `decryptForTenantAuto` + encryption plugin + middleware

- [ ] **Step 1: Update encryption plugin for Hybrid A+C scope (Decision 2)**

In `packages/database/src/mongo/plugins/encryption.plugin.ts`:

```typescript
// Plugin options interface:
interface EncryptionPluginOptions {
  fieldsToEncrypt: string[];
  scope: 'tenant' | 'project'; // Decision 2
  scopeFields: {
    tenantId: string;
    projectId?: string; // required if scope='project'
    environment?: string; // optional — falls back to AsyncLocalStorage then '_shared'
  };
}

// In pre-save hook, resolve scope:
function resolveScope(doc: any, options: EncryptionPluginOptions): DEKScope {
  const tenantId = doc[options.scopeFields.tenantId];
  if (!tenantId) throw new Error(`Missing ${options.scopeFields.tenantId} on ${modelName}`);

  if (options.scope === 'tenant') {
    return { tenantId, projectId: '_tenant', environment: '_tenant' };
  }

  const projectId = doc[options.scopeFields.projectId!];
  if (!projectId) throw new Error(`Missing ${options.scopeFields.projectId} on ${modelName}`);

  // Decision 2: environment resolution order
  let environment: string;
  if (options.scopeFields.environment && doc[options.scopeFields.environment]) {
    environment = doc[options.scopeFields.environment]; // 1. From document field
  } else {
    const ctx = asyncLocalStorage.getStore();
    environment = ctx?.environment ?? '_shared'; // 2. AsyncLocalStorage → 3. '_shared' (Decision 7)
  }

  return { tenantId, projectId, environment };
}
```

- [ ] **Step 2: Add two-layer AsyncLocalStorage middleware (Decision 12)**

In `apps/runtime/src/server.ts`:

```typescript
// Layer 1: Global middleware (after auth) — tenant routes don't need environment
app.use((req, res, next) => {
  encryptionContext.run({ environment: null }, next);
});

// Layer 2: Project route middleware — sets environment from deployment context
app.use('/api/projects/:projectId', (req, res, next) => {
  const environment = (req.query.environment as string) || req.body?.environment || '_shared';
  encryptionContext.run({ environment }, next);
});
```

- [ ] **Step 3: Update `model-resolution.ts` — has `projectId` from context**

```typescript
// Credential decrypt for tenant-scoped LLMCredential model:
? await decryptForTenantAuto(rawKey, decryptionKey, '_tenant', '_tenant')
// Or with project context if available:
? await decryptForTenantAuto(rawKey, decryptionKey, context.projectId, context.environment ?? '_shared')
```

- [ ] **Step 4: Update `channel-connections.ts` — has `req.params.projectId`**

```typescript
// Project-scoped, no environment on model → '_shared' (Decision 7):
await encryptForTenantAuto(rawKey, tenantId, projectId, '_shared');
await decryptForTenantAuto(value, tenantId, projectId, '_shared');
```

- [ ] **Step 5: Update `connection-resolver.ts` — has tenantId, may have projectId**

Pass `projectId` where available from the connection record. Use `'_shared'` for environment.

- [ ] **Step 6: Update `delivery-worker.ts` — has `payload.tenantId`**

Pass `payload.projectId` if available, `'_shared'` for environment.

- [ ] **Step 7: Update `deployments.ts` — has `projectId` from route params**

```typescript
// EnvironmentVariable has environment on the document:
await decryptForTenantAuto(envVar.encryptedValue, tenantId, projectId, envVar.environment);
```

- [ ] **Step 8: Update `server.ts` wiring for tenant-scoped operations**

```typescript
// Platform-level operations use '_tenant' sentinels (Decision 7 scope for tenant models):
encryptForTenant: (plaintext, tenantId) => encryptForTenantAuto(plaintext, tenantId, '_tenant', '_tenant'),
decryptForTenant: (encrypted, tenantId) => decryptForTenantAuto(encrypted, tenantId, '_tenant', '_tenant'),
```

- [ ] **Step 9: Build all apps**

```bash
pnpm build --filter=@agent-platform/runtime --filter=@agent-platform/search-ai --filter=@agent-platform/search-ai-runtime --filter=@agent-platform/studio
```

- [ ] **Step 10: Commit**

```bash
npx prettier --write apps/runtime/src/services/llm/model-resolution.ts apps/runtime/src/routes/channel-connections.ts apps/runtime/src/channels/connection-resolver.ts apps/runtime/src/services/queues/delivery-worker.ts apps/runtime/src/routes/deployments.ts apps/runtime/src/server.ts packages/database/src/mongo/plugins/encryption.plugin.ts
git add apps/runtime/src/services/llm/model-resolution.ts apps/runtime/src/routes/channel-connections.ts apps/runtime/src/channels/connection-resolver.ts apps/runtime/src/services/queues/delivery-worker.ts apps/runtime/src/routes/deployments.ts apps/runtime/src/server.ts packages/database/src/mongo/plugins/encryption.plugin.ts
git commit -m "[ABLP-2] feat(encryption): Hybrid A+C plugin scope + thread scope through callers

Decision 2: plugin reads tenantId/projectId from doc, environment from
doc field or AsyncLocalStorage, falls back to '_shared' (Decision 7).
Decision 12: two-layer middleware (global + project routes).
Tenant-scoped callers use '_tenant' sentinels.
Project-scoped callers pass projectId + environment where available."
```

---

## Phase D: Medium/Low Fixes (Tasks 14-19)

### Task 14: Cache platform default in L1 (MEDIUM #8)

**Files:**

- Modify: `packages/database/src/kms/kms-resolver.ts` — cache before returning platform default

Already included in Task 10 Step 3 (`this.cache.set(tenantId, projectId, environment, platformDefault)`).

If not yet done:

```typescript
const platformDefault = getPlatformDefault();
this.cache.set(tenantId, projectId, environment, platformDefault);
return platformDefault;
```

Commit: `[ABLP-2] fix(kms): cache platform default in L1 KMS resolver`

---

### Task 15: Add PBKDF2 fallback to `encryptForTenantAuto` on facade error (MEDIUM #10)

Already folded into Task 12 (the `try/catch` around `facade.encrypt()`).

---

### Task 16: Extract shared DEK facade initialization helper (MEDIUM #12)

**Files:**

- Create: `packages/database/src/kms/dek-facade-factory.ts`
- Modify: All 4 server entry points to use the factory

```typescript
export async function initDEKFacade(
  masterKeyHex: string,
  logger?,
): Promise<DEKFacadeInitResult | null> {
  const pool = new KMSProviderPool({ masterKeyHex });
  await pool.initialize();
  setKMSProviderPool(pool);
  const resolver = new KMSResolver();
  const dekManager = new DEKManager(resolver);
  const facade = new TenantEncryptionFacade(dekManager, Buffer.from(masterKeyHex, 'hex'));
  setEncryptionFacade(facade);
  return { facade, pool, resolver, dekManager };
}
```

Replace ~30-line init blocks in `runtime/server.ts`, `search-ai/server.ts`, `search-ai-runtime/server.ts`, `studio/ensure-db.ts`.

Commit: `[ABLP-2] refactor(kms): extract shared initDEKFacade factory`

---

### Task 17: Validate `reason` field in POST /keys/rotate (MEDIUM #13)

**Files:**

- Modify: `apps/runtime/src/routes/kms-admin.ts`

Add Zod schema:

```typescript
const RotateBodySchema = z.object({
  reason: z
    .enum(['kek-age-exceeded', 'manual-rotation', 'key-compromise'])
    .optional()
    .default('manual-rotation'),
});
```

Commit: `[ABLP-2] fix(kms-admin): validate reason field in POST /keys/rotate`

---

### Task 18: Documentation (LOW #11, #14, #18)

- MaterializedKMSConfig is no longer vestigial (restored in Task 10)
- Document `console.warn/info` exception for `packages/database/` (circular dep prevents `createLogger`)
- Document ClickHouse `dekId` ↔ `epoch` column mapping
- Reference the 14 design decisions doc in all updated documentation

Commit: `[ABLP-2] docs(kms): document console.warn exception and epoch column mapping`

---

### Task 19: Restore `configActive` in PUT /config response (LOW #17)

Check if field was removed; if so, add it back.

Commit: `[ABLP-2] fix(kms-admin): restore configActive in PUT /config response`

---

### Task 20: Final verification

- [ ] **Full build:** `pnpm build`
- [ ] **All tests:** `pnpm test:report` → check `test-reports/SUMMARY.md`
- [ ] **Format check:** `npx prettier --check "packages/**/*.ts" "apps/**/*.ts"`
- [ ] **Type check:** `pnpm build --filter=@agent-platform/database --filter=@agent-platform/shared-encryption --filter=@agent-platform/runtime`

---

## Design Decision Alignment Summary

Every task now references the specific design decisions it implements:

| Task | Decisions Applied                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| 1    | D3 (opaque dekId → scope key for active tracking)                                                              |
| 2    | — (bug fix, no decision impact)                                                                                |
| 3    | D14 (auth config is exception: fail-closed, not return-encrypted)                                              |
| 4    | D14 (return encrypted + warn for general decrypt failure)                                                      |
| 5    | D3 (detect DEK envelope format in sync path)                                                                   |
| 6    | — (bug fix, no decision impact)                                                                                |
| 7    | D4 (epoch dedup), D5 (expiresAt precomputed), D6 (fire-and-forget $inc), D9 (per-tenant config), D13 (12h min) |
| 8    | D9 (epoch config per tenant), D10 (separate endpoints)                                                         |
| 9    | D1 (greenfield: no defaults), D3 (nanoid dekId), D4 (epoch dedup index), D7 ('\_shared')                       |
| 10   | D11 (sync materializer), 5-level inheritance                                                                   |
| 11   | D3 (decrypt by dekId only), D7 ('\_shared' default)                                                            |
| 12   | D7 ('\_shared' not '\_default')                                                                                |
| 13   | D2 (Hybrid A+C plugin), D7 ('\_shared'), D12 (two-layer middleware)                                            |
| 14   | — (caching fix)                                                                                                |
| 15   | — (folded into Task 12)                                                                                        |
| 16   | — (DRY refactor)                                                                                               |
| 17   | — (validation fix)                                                                                             |
| 18   | — (documentation)                                                                                              |
| 19   | — (response fix)                                                                                               |

## Sentinel Values Reference

| Sentinel    | Meaning                                          | Used By                                                                                                        |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `'_tenant'` | Tenant-scoped model (no projectId/environment)   | 8 tenant-scoped encrypted models, server.ts wiring                                                             |
| `'_shared'` | Project-scoped model without environment context | 6 project-scoped models (ChannelConnection, SDKChannel, ToolSecret, MCPServerConfig, ServiceNode, AuthProfile) |

## Wire Format (Decision 3)

`base64(idLen[1] + dekId[N] + iv[12] + authTag[16] + ciphertext)` — the `dekId` is a nanoid(16) embedded in ciphertext. On decrypt, extract dekId and look up directly in DEK registry (`{ dekId }` unique index). No scope needed for decrypt.

## Summary of Changes by Phase

| Phase                 | Tasks  | Files Changed | Key Impact                                                             |
| --------------------- | ------ | ------------- | ---------------------------------------------------------------------- |
| A: Critical Bug Fixes | 1-6    | ~8            | Cross-tenant fix, format unification, auth hardening                   |
| B: Epoch Restoration  | 7      | ~4            | NIST SP 800-57 compliant DEK lifecycle restored                        |
| C: Scope Restoration  | 8-13   | ~18           | Per-project+environment KMS isolation, Hybrid A+C plugin, opaque dekId |
| D: Medium/Low Fixes   | 14-19  | ~8            | Caching, dedup, validation, docs                                       |
| **Total**             | **20** | **~38**       |                                                                        |
