# DEK Unification: ClickHouse + BullMQ + Direct Call Sites

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate ClickHouse field encryption, BullMQ queue encryption, and remaining direct `EncryptionService.encryptForTenant`/`decryptForTenant` call sites to use `TenantEncryptionFacade` (DEK envelope encryption) as the primary path, eliminating the legacy PBKDF2-only code paths.

**Architecture:** The `TenantEncryptionFacade` already exists and is wired into all 4 servers via `initDEKFacade()`. The Mongoose plugin already uses it. The gap is that `field-interceptor.ts` (used by ClickHouse), `secure-queue.ts` (used by BullMQ), and ~15 direct call sites still use the sync `EncryptionService` API which only opportunistically hits the DEK cache. This refactoring makes all paths async-first through the facade, with PBKDF2 fallback handled internally by the facade (not the caller).

**Tech Stack:** TypeScript, TenantEncryptionFacade, DEKManager, AsyncLocalStorage (EncryptionContext), BullMQ, ClickHouse

**Key Constraint:** All changes must be backward-compatible — legacy `ENC:v3:` and hex 3-part ciphertext must still decrypt via the facade's built-in PBKDF2 fallback. No data migration required.

**Branch:** Work on `feature/epoch-removal-dek-cache-fix` (current branch).

---

## File Structure

### Modified Files

| File                                                                  | Responsibility                               | Change                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/shared-encryption/src/field-interceptor.ts`                 | ClickHouse/Redis field-level encrypt/decrypt | Make async, accept `TenantEncryptionFacade` + `DEKScope`, remove `EncryptionService` dependency |
| `packages/shared-encryption/src/secure-queue.ts`                      | BullMQ job data encrypt/decrypt              | Make async, accept `TenantEncryptionFacade`, resolve scope from job data                        |
| `packages/shared-encryption/src/index.ts`                             | Package exports                              | Export new async versions, keep sync exports for backward compat during migration               |
| `packages/database/src/clickhouse-encryption-interceptor.ts`          | ClickHouse row-level intercept               | Make `beforeInsert`/`afterQuery` async, accept facade-based deps                                |
| `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts` | Wires interceptor deps                       | Switch from `EncryptionService` to `TenantEncryptionFacade`                                     |
| `apps/runtime/src/services/message-persistence-queue.ts`              | BullMQ message queue                         | Use async encrypt/decrypt with facade                                                           |
| `apps/runtime/src/services/session/redis-session-store.ts`            | Redis session encryption                     | Replace `encryptionService.encryptForTenant` with `encryptForTenantAuto`                        |
| `apps/runtime/src/routes/connections.ts`                              | Connection credential encryption             | Replace `encryptionService.encryptForTenant` with `encryptForTenantAuto`                        |
| `apps/runtime/src/services/execution/routing-executor.ts`             | Connection credential decryption             | Replace `getEncryptionService().decryptJsonForTenant` with facade                               |

### New Files

| File                                                                     | Responsibility                                |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| `packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts` | Tests for async field interceptor with facade |
| `packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts`      | Tests for async secure queue with facade      |

---

## Task 1: Async Field Interceptor with Facade Support

**Files:**

- Modify: `packages/shared-encryption/src/field-interceptor.ts`
- Create: `packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts`
- Modify: `packages/shared-encryption/src/index.ts`

**Context:** The field interceptor is used by both ClickHouse and BullMQ. Currently it's synchronous and depends on `EncryptionService`. We add async versions that use `TenantEncryptionFacade` directly. The sync versions stay for backward compat until all callers are migrated.

- [ ] **Step 1: Write failing tests for async field interceptor**

```typescript
// packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts
import { describe, it, expect, vi } from 'vitest';
import { encryptFieldsAsync, decryptFieldsAsync } from '../field-interceptor.js';
import type { TenantEncryptionFacade, DEKScope } from '../tenant-encryption-facade.js';

function createMockFacade(): TenantEncryptionFacade {
  return {
    encrypt: vi.fn(async (plaintext: string, _scope: DEKScope) => `DEK:${plaintext}`),
    decrypt: vi.fn(async (ciphertext: string, _tenantId: string) => {
      if (ciphertext.startsWith('DEK:')) return ciphertext.slice(4);
      throw new Error('Unknown format');
    }),
    encryptSync: vi.fn(() => null),
    decryptSync: vi.fn(() => null),
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
    forceRotate: vi.fn(),
    clearCache: vi.fn(),
  } as unknown as TenantEncryptionFacade;
}

describe('encryptFieldsAsync', () => {
  it('encrypts specified fields using facade', async () => {
    const facade = createMockFacade();
    const scope: DEKScope = { tenantId: 't1', projectId: 'p1', environment: '_shared' };
    const row = { content: 'hello', role: 'user', tenantId: 't1' };

    const result = await encryptFieldsAsync(row, ['content'], scope, facade);

    expect(result.content).toBe('DEK:hello');
    expect(result.role).toBe('user');
    expect(facade.encrypt).toHaveBeenCalledWith('hello', scope);
  });

  it('skips null fields', async () => {
    const facade = createMockFacade();
    const scope: DEKScope = { tenantId: 't1', projectId: '_tenant', environment: '_tenant' };
    const row = { content: null, role: 'user' };

    const result = await encryptFieldsAsync(row, ['content'], scope, facade);

    expect(result.content).toBeNull();
    expect(facade.encrypt).not.toHaveBeenCalled();
  });

  it('JSON-stringifies non-string values before encrypting', async () => {
    const facade = createMockFacade();
    const scope: DEKScope = { tenantId: 't1', projectId: 'p1', environment: '_shared' };
    const row = { data: { nested: true } };

    const result = await encryptFieldsAsync(row, ['data'], scope, facade);

    expect(result.data).toBe('DEK:{"nested":true}');
  });

  it('throws on already-encrypted value (double encryption guard)', async () => {
    const facade = createMockFacade();
    const scope: DEKScope = { tenantId: 't1', projectId: 'p1', environment: '_shared' };
    const row = { content: 'ENC:v3:abc:def:ghi' };

    await expect(encryptFieldsAsync(row, ['content'], scope, facade)).rejects.toThrow('already');
  });
});

describe('decryptFieldsAsync', () => {
  it('decrypts specified fields using facade', async () => {
    const facade = createMockFacade();
    const row = { content: 'DEK:hello', role: 'user', _enc: 'dek' };

    const result = await decryptFieldsAsync(row, ['content'], 't1', facade);

    expect(result.content).toBe('hello');
    expect(result._enc).toBeUndefined();
    expect(facade.decrypt).toHaveBeenCalledWith('DEK:hello', 't1');
  });

  it('passes through rows without _enc marker', async () => {
    const facade = createMockFacade();
    const row = { content: 'plaintext', role: 'user' };

    const result = await decryptFieldsAsync(row, ['content'], 't1', facade);

    expect(result.content).toBe('plaintext');
    expect(facade.decrypt).not.toHaveBeenCalled();
  });

  it('skips null/non-string fields', async () => {
    const facade = createMockFacade();
    const row = { content: null, _enc: 'dek' };

    const result = await decryptFieldsAsync(row, ['content'], 't1', facade);

    expect(result.content).toBeNull();
    expect(facade.decrypt).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=@agent-platform/shared-encryption && pnpm test --filter=@agent-platform/shared-encryption -- --run packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts`
Expected: FAIL — `encryptFieldsAsync` and `decryptFieldsAsync` not exported

- [ ] **Step 3: Implement async field interceptor functions**

Add to `packages/shared-encryption/src/field-interceptor.ts`:

```typescript
import type { TenantEncryptionFacade, DEKScope } from './tenant-encryption-facade.js';
import { isAlreadyEncrypted } from './encryption-registry.js';

// ... existing sync functions stay unchanged ...

/**
 * Async field encryption using TenantEncryptionFacade (DEK envelope).
 * Used by ClickHouse interceptor and BullMQ secure queue after migration.
 */
export async function encryptFieldsAsync(
  row: Record<string, unknown>,
  fields: readonly string[],
  scope: DEKScope,
  facade: TenantEncryptionFacade,
): Promise<Record<string, unknown>> {
  const result = { ...row };

  for (const field of fields) {
    const value = result[field];
    if (value == null) continue;

    const str = typeof value === 'string' ? value : JSON.stringify(value);

    if (isAlreadyEncrypted(str)) {
      throw new Error(
        `Field "${field}" already has encryption format — double encryption detected`,
      );
    }

    result[field] = await facade.encrypt(str, scope);
  }

  result._enc = 'dek';
  return result;
}

/**
 * Async field decryption using TenantEncryptionFacade (DEK envelope + legacy fallback).
 * Decision 3: decrypt needs no scope — dekId extracted from ciphertext header.
 * tenantId only needed for legacy PBKDF2 fallback within the facade.
 */
export async function decryptFieldsAsync(
  row: Record<string, unknown>,
  fields: readonly string[],
  tenantId: string,
  facade: TenantEncryptionFacade,
): Promise<Record<string, unknown>> {
  if (!row._enc) return row;

  const result = { ...row };

  for (const field of fields) {
    const value = result[field];
    if (value == null || typeof value !== 'string') continue;

    result[field] = await facade.decrypt(value, tenantId);
  }

  delete result._enc;
  return result;
}
```

- [ ] **Step 4: Export new functions from index.ts**

Add to `packages/shared-encryption/src/index.ts` after existing field-interceptor exports:

```typescript
export { encryptFieldsAsync, decryptFieldsAsync } from './field-interceptor.js';
```

- [ ] **Step 5: Build and run tests**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=@agent-platform/shared-encryption && pnpm test --filter=@agent-platform/shared-encryption -- --run packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write packages/shared-encryption/src/field-interceptor.ts packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts packages/shared-encryption/src/index.ts
git add packages/shared-encryption/src/field-interceptor.ts packages/shared-encryption/src/__tests__/field-interceptor-dek.test.ts packages/shared-encryption/src/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(shared-encryption): add async field interceptor using TenantEncryptionFacade

Add encryptFieldsAsync/decryptFieldsAsync that use the DEK envelope
encryption via TenantEncryptionFacade instead of legacy sync EncryptionService.
These will replace the sync versions in ClickHouse and BullMQ paths.
EOF
)"
```

---

## Task 2: Async Secure Queue with Facade Support

**Files:**

- Modify: `packages/shared-encryption/src/secure-queue.ts`
- Create: `packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts`
- Modify: `packages/shared-encryption/src/index.ts`

**Context:** `secure-queue.ts` wraps BullMQ job data for encryption. Currently sync with `EncryptionService`. We add async versions using the facade. The key difference from field-interceptor is that secure-queue resolves scope from job data (`tenantId` + optional `projectId`).

- [ ] **Step 1: Write failing tests for async secure queue**

```typescript
// packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts
import { describe, it, expect, vi } from 'vitest';
import { wrapJobDataForEncryptAsync, unwrapJobDataForDecryptAsync } from '../secure-queue.js';
import type { TenantEncryptionFacade, DEKScope } from '../tenant-encryption-facade.js';

function createMockFacade(): TenantEncryptionFacade {
  return {
    encrypt: vi.fn(async (plaintext: string, _scope: DEKScope) => `DEK:${plaintext}`),
    decrypt: vi.fn(async (ciphertext: string, _tenantId: string) => {
      if (ciphertext.startsWith('DEK:')) return ciphertext.slice(4);
      throw new Error('Unknown format');
    }),
    encryptSync: vi.fn(() => null),
    decryptSync: vi.fn(() => null),
    encryptJson: vi.fn(),
    decryptJson: vi.fn(),
    forceRotate: vi.fn(),
    clearCache: vi.fn(),
  } as unknown as TenantEncryptionFacade;
}

describe('wrapJobDataForEncryptAsync', () => {
  it('encrypts manifest fields using facade with scope from job data', async () => {
    const facade = createMockFacade();
    const data = { content: 'hello world', tenantId: 't1', projectId: 'p1' };

    const result = await wrapJobDataForEncryptAsync('message-persistence', data, facade);

    expect(result.content).toBe('DEK:hello world');
    expect(result.tenantId).toBe('t1');
    expect(facade.encrypt).toHaveBeenCalledWith('hello world', {
      tenantId: 't1',
      projectId: 'p1',
      environment: '_shared',
    });
  });

  it('uses _tenant defaults when projectId not in job data', async () => {
    const facade = createMockFacade();
    const data = { content: 'hello', tenantId: 't1' };

    await wrapJobDataForEncryptAsync('message-persistence', data, facade);

    expect(facade.encrypt).toHaveBeenCalledWith('hello', {
      tenantId: 't1',
      projectId: '_tenant',
      environment: '_shared',
    });
  });

  it('throws if tenantId missing from job data', async () => {
    const facade = createMockFacade();
    const data = { content: 'hello' };

    await expect(wrapJobDataForEncryptAsync('message-persistence', data, facade)).rejects.toThrow(
      'tenantId required',
    );
  });

  it('returns data unchanged for queues with no encrypted fields', async () => {
    const facade = createMockFacade();
    const data = { payload: 'anything', tenantId: 't1' };

    const result = await wrapJobDataForEncryptAsync('reencryption-queue', data, facade);

    expect(result).toBe(data);
    expect(facade.encrypt).not.toHaveBeenCalled();
  });
});

describe('unwrapJobDataForDecryptAsync', () => {
  it('decrypts manifest fields using facade', async () => {
    const facade = createMockFacade();
    const data = { content: 'DEK:hello world', tenantId: 't1', _enc: 'dek' };

    const result = await unwrapJobDataForDecryptAsync('message-persistence', data, facade);

    expect(result.content).toBe('hello world');
    expect(facade.decrypt).toHaveBeenCalledWith('DEK:hello world', 't1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=@agent-platform/shared-encryption && pnpm test --filter=@agent-platform/shared-encryption -- --run packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts`
Expected: FAIL — `wrapJobDataForEncryptAsync` not exported

- [ ] **Step 3: Implement async secure queue functions**

Replace `packages/shared-encryption/src/secure-queue.ts` content (keeping existing sync exports):

```typescript
import type { EncryptionService } from './engine.js';
import {
  encryptFields,
  decryptFields,
  encryptFieldsAsync,
  decryptFieldsAsync,
} from './field-interceptor.js';
import { getRedisQueueManifest } from './encryption-manifest.js';
import type { TenantEncryptionFacade } from './tenant-encryption-facade.js';

// ── Sync (legacy — used until callers migrate) ──────────────────────

export function wrapJobDataForEncrypt(
  queueName: string,
  data: Record<string, unknown>,
  encryptionService: EncryptionService,
): Record<string, unknown> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for encrypted queue "${queueName}"`);
  }

  return encryptFields(data, manifest.fieldsToEncrypt, tenantId, encryptionService);
}

export function unwrapJobDataForDecrypt(
  queueName: string,
  data: Record<string, unknown>,
  encryptionService: EncryptionService,
): Record<string, unknown> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for decrypting queue "${queueName}"`);
  }

  return decryptFields(data, manifest.fieldsToEncrypt, tenantId, encryptionService);
}

// ── Async (DEK envelope via TenantEncryptionFacade) ─────────────────

/**
 * Encrypt BullMQ job data fields using TenantEncryptionFacade.
 * Resolves DEKScope from job data: tenantId (required), projectId (optional, defaults to '_tenant'),
 * environment (optional, defaults to '_shared').
 */
export async function wrapJobDataForEncryptAsync(
  queueName: string,
  data: Record<string, unknown>,
  facade: TenantEncryptionFacade,
): Promise<Record<string, unknown>> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for encrypted queue "${queueName}"`);
  }

  const scope = {
    tenantId,
    projectId: (data.projectId as string) || '_tenant',
    environment: (data.environment as string) || '_shared',
  };

  return encryptFieldsAsync(data, manifest.fieldsToEncrypt, scope, facade);
}

/**
 * Decrypt BullMQ job data fields using TenantEncryptionFacade.
 * Handles both DEK envelope and legacy ENC:v3: formats via facade fallback.
 */
export async function unwrapJobDataForDecryptAsync(
  queueName: string,
  data: Record<string, unknown>,
  facade: TenantEncryptionFacade,
): Promise<Record<string, unknown>> {
  const manifest = getRedisQueueManifest(queueName);
  if (manifest.fieldsToEncrypt.length === 0) return data;

  const tenantId = data.tenantId as string;
  if (!tenantId) {
    throw new Error(`tenantId required in job data for decrypting queue "${queueName}"`);
  }

  return decryptFieldsAsync(data, manifest.fieldsToEncrypt, tenantId, facade);
}
```

- [ ] **Step 4: Export new functions from index.ts**

Add to `packages/shared-encryption/src/index.ts` after existing secure-queue exports:

```typescript
export { wrapJobDataForEncryptAsync, unwrapJobDataForDecryptAsync } from './secure-queue.js';
```

- [ ] **Step 5: Build and run tests**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=@agent-platform/shared-encryption && pnpm test --filter=@agent-platform/shared-encryption -- --run packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full package tests to verify no regressions**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm test --filter=@agent-platform/shared-encryption`
Expected: ALL PASS (existing sync tests unaffected)

- [ ] **Step 7: Run prettier and commit**

```bash
npx prettier --write packages/shared-encryption/src/secure-queue.ts packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts packages/shared-encryption/src/index.ts
git add packages/shared-encryption/src/secure-queue.ts packages/shared-encryption/src/__tests__/secure-queue-dek.test.ts packages/shared-encryption/src/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(shared-encryption): add async secure queue using TenantEncryptionFacade

Add wrapJobDataForEncryptAsync/unwrapJobDataForDecryptAsync that encrypt
BullMQ job data via DEK envelope encryption. Resolves DEKScope from job
data (tenantId + projectId + environment). Sync versions kept for compat.
EOF
)"
```

---

## Task 3: Async ClickHouse Encryption Interceptor

**Files:**

- Modify: `packages/database/src/clickhouse-encryption-interceptor.ts`

**Context:** The interceptor's `beforeInsert`/`afterQuery` are sync. We add async versions that use the facade. The sync versions remain since existing callers in ClickHouse stores use them synchronously.

- [ ] **Step 1: Read the ClickHouse stores to understand how the interceptor is called**

Read: `apps/runtime/src/services/stores/clickhouse-message-store.ts` — check how `beforeInsert`/`afterQuery` are called to understand if callers can handle async.

- [ ] **Step 2: Add async methods to the interceptor**

Add to `packages/database/src/clickhouse-encryption-interceptor.ts`:

```typescript
export interface ClickHouseEncryptionDepsAsync {
  encryptFieldsAsync: (
    row: Record<string, unknown>,
    fields: readonly string[],
    scope: { tenantId: string; projectId: string; environment: string },
    facade: unknown,
  ) => Promise<Record<string, unknown>>;
  decryptFieldsAsync: (
    row: Record<string, unknown>,
    fields: readonly string[],
    tenantId: string,
    facade: unknown,
  ) => Promise<Record<string, unknown>>;
  getManifest: (table: string) => StoreEncryptionConfig;
  facade: unknown;
}

// Add these methods to ClickHouseEncryptionInterceptor class:

  private asyncDeps: ClickHouseEncryptionDepsAsync | null = null;

  setAsyncDeps(deps: ClickHouseEncryptionDepsAsync): void {
    this.asyncDeps = deps;
  }

  async beforeInsertAsync(table: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const manifest = (this.asyncDeps ?? this.deps).getManifest(table);
    if (manifest.fieldsToEncrypt.length === 0) return rows;

    if (!this.asyncDeps) {
      // Fallback to sync if async deps not set
      return this.beforeInsert(table, rows);
    }

    const results: Record<string, unknown>[] = [];
    for (const row of rows) {
      const tenantId = row.tenant_id as string;
      if (!tenantId) {
        throw new Error(`tenant_id required for encrypted ClickHouse table "${table}"`);
      }
      const scope = {
        tenantId,
        projectId: (row.project_id as string) || '_tenant',
        environment: '_shared',
      };
      results.push(
        await this.asyncDeps.encryptFieldsAsync(row, manifest.fieldsToEncrypt, scope, this.asyncDeps.facade),
      );
    }
    return results;
  }

  async afterQueryAsync(table: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const manifest = (this.asyncDeps ?? this.deps).getManifest(table);
    if (manifest.fieldsToEncrypt.length === 0) return rows;

    if (!this.asyncDeps) {
      return this.afterQuery(table, rows);
    }

    const results: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (row._enc) {
        const tenantId = row.tenant_id as string;
        if (!tenantId) {
          throw new Error(`tenant_id required to decrypt ClickHouse table "${table}"`);
        }
        try {
          results.push(
            await this.asyncDeps.decryptFieldsAsync(row, manifest.fieldsToEncrypt, tenantId, this.asyncDeps.facade),
          );
        } catch {
          const result = { ...row };
          for (const field of manifest.fieldsToEncrypt) {
            if (result[field] != null) result[field] = null;
          }
          result._decryptionFailed = true;
          delete result._enc;
          results.push(result);
        }
      } else {
        results.push(row);
      }
    }
    return results;
  }
```

- [ ] **Step 3: Build and verify types**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=@agent-platform/database`
Expected: Build succeeds

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write packages/database/src/clickhouse-encryption-interceptor.ts
git add packages/database/src/clickhouse-encryption-interceptor.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(database): add async methods to ClickHouseEncryptionInterceptor

Add beforeInsertAsync/afterQueryAsync that accept TenantEncryptionFacade
for DEK envelope encryption. Sync methods remain for backward compat.
EOF
)"
```

---

## Task 4: Wire ClickHouse Singleton to Use Facade

**Files:**

- Modify: `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`

**Context:** The singleton currently creates the interceptor with sync `EncryptionService` deps. We add the async facade deps so ClickHouse stores can call `beforeInsertAsync`/`afterQueryAsync`.

- [ ] **Step 1: Read how ClickHouse stores use the interceptor**

Read: `apps/runtime/src/services/stores/clickhouse-message-store.ts` — find the `beforeInsert`/`afterQuery` call sites to understand the migration path.

- [ ] **Step 2: Update the singleton to inject facade deps**

Replace `apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts`:

```typescript
import { ClickHouseEncryptionInterceptor } from '@agent-platform/database';
import {
  isEncryptionAvailable,
  getEncryptionService,
  encryptFields,
  decryptFields,
  encryptFieldsAsync,
  decryptFieldsAsync,
  getClickHouseManifest,
  getEncryptionFacade,
} from '@agent-platform/shared/encryption';
import type { TenantEncryptionFacade, DEKScope } from '@agent-platform/shared/encryption';

let interceptor: ClickHouseEncryptionInterceptor | null = null;

/**
 * Get the ClickHouse encryption interceptor singleton.
 * Returns null if encryption is not available (no master key configured).
 *
 * Wires both sync (legacy) and async (DEK facade) deps.
 * Callers should prefer beforeInsertAsync/afterQueryAsync when the facade is available.
 */
export function getClickHouseEncryptionInterceptor(): ClickHouseEncryptionInterceptor | null {
  if (interceptor) return interceptor;
  if (!isEncryptionAvailable()) return null;

  const encryptionService = getEncryptionService();

  interceptor = new ClickHouseEncryptionInterceptor({
    encryptFields: (row, fields, tenantId, svc) =>
      encryptFields(row, fields, tenantId, svc as typeof encryptionService),
    decryptFields: (row, fields, tenantId, svc) =>
      decryptFields(row, fields, tenantId, svc as typeof encryptionService),
    getManifest: getClickHouseManifest,
    encryptionService,
  });

  // Wire async DEK facade deps if facade is available
  const facade = getEncryptionFacade();
  if (facade) {
    interceptor.setAsyncDeps({
      encryptFieldsAsync: (row, fields, scope, _facade) =>
        encryptFieldsAsync(row, fields, scope as DEKScope, _facade as TenantEncryptionFacade),
      decryptFieldsAsync: (row, fields, tenantId, _facade) =>
        decryptFieldsAsync(row, fields, tenantId, _facade as TenantEncryptionFacade),
      getManifest: getClickHouseManifest,
      facade,
    });
  }

  return interceptor;
}

/**
 * Reset the singleton (for testing only).
 */
export function _resetClickHouseEncryptionInterceptorForTesting(): void {
  interceptor = null;
}
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=runtime`
Expected: Build succeeds

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts
git add apps/runtime/src/services/stores/clickhouse-encryption-singleton.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(runtime): wire ClickHouse interceptor to TenantEncryptionFacade

Inject async DEK facade deps into the ClickHouse encryption interceptor
singleton so stores can use beforeInsertAsync/afterQueryAsync for DEK
envelope encryption.
EOF
)"
```

---

## Task 5: Migrate ClickHouse Stores to Async Encryption

**Files:**

- Modify: ClickHouse store files that call `beforeInsert`/`afterQuery` (read first to find exact call sites)

**Context:** ClickHouse stores call the interceptor's sync methods. We switch them to the async versions. Since ClickHouse insert/query operations are already async (they await the ClickHouse HTTP client), making encryption async adds no architectural change.

- [ ] **Step 1: Find all ClickHouse store files that use the interceptor**

Run: `grep -rn 'beforeInsert\|afterQuery' apps/runtime/src/services/stores/ --include='*.ts'`

This will identify every call site. For each file:

1. Replace `interceptor.beforeInsert(table, rows)` with `await interceptor.beforeInsertAsync(table, rows)`
2. Replace `interceptor.afterQuery(table, rows)` with `await interceptor.afterQueryAsync(table, rows)`

The enclosing functions are already async (they await ClickHouse client calls), so adding await is safe.

- [ ] **Step 2: Update each store file**

For each file found in Step 1, update the calls. Example pattern:

```typescript
// Before:
const encryptedRows = interceptor.beforeInsert('messages', rows);
// After:
const encryptedRows = await interceptor.beforeInsertAsync('messages', rows);

// Before:
const decryptedRows = interceptor.afterQuery('messages', rows);
// After:
const decryptedRows = await interceptor.afterQueryAsync('messages', rows);
```

- [ ] **Step 3: Build and run full test suite**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=runtime && pnpm test --filter=runtime`
Expected: Build succeeds, tests pass

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/stores/*.ts
git add apps/runtime/src/services/stores/
git commit -m "$(cat <<'EOF'
[ABLP-2] refactor(runtime): migrate ClickHouse stores to async DEK encryption

Switch all ClickHouse store interceptor calls from sync beforeInsert/afterQuery
to async beforeInsertAsync/afterQueryAsync, enabling DEK envelope encryption
for all ClickHouse writes and reads.
EOF
)"
```

---

## Task 6: Migrate BullMQ Message Persistence Queue to Facade

**Files:**

- Modify: `apps/runtime/src/services/message-persistence-queue.ts`

**Context:** The message persistence queue uses sync `wrapJobDataForEncrypt`/`unwrapJobDataForDecrypt` with `getEncryptionService()`. We switch to the async facade-based versions. The `encryptBatchForQueue`/`decryptBatchFromQueue` helper functions become async.

- [ ] **Step 1: Update encrypt/decrypt helpers to use facade**

In `apps/runtime/src/services/message-persistence-queue.ts`, replace the imports and helper functions:

```typescript
// Replace import:
import {
  isEncryptionAvailable,
  getEncryptionFacade,
  getEncryptionService,
  wrapJobDataForEncryptAsync,
  unwrapJobDataForDecryptAsync,
  wrapJobDataForEncrypt,
  unwrapJobDataForDecrypt,
} from '@agent-platform/shared/encryption';

// Replace encryptBatchForQueue:
async function encryptBatchForQueue(batch: MessageBatchJobData): Promise<MessageBatchJobData> {
  if (!isEncryptionAvailable()) return batch;
  const facade = getEncryptionFacade();

  // Use async DEK path if facade available, else fall back to sync legacy
  if (facade) {
    const messages: MessageJobData[] = [];
    for (const m of batch.messages) {
      if (!m.tenantId) {
        messages.push(m);
        continue;
      }
      const encrypted = (await wrapJobDataForEncryptAsync(
        'message-persistence',
        m as unknown as Record<string, unknown>,
        facade,
      )) as unknown as MessageJobData;
      messages.push(encrypted);
    }
    return { ...batch, messages };
  }

  // Legacy sync fallback
  const svc = getEncryptionService();
  return {
    ...batch,
    messages: batch.messages.map((m) => {
      if (!m.tenantId) return m;
      return wrapJobDataForEncrypt(
        'message-persistence',
        m as unknown as Record<string, unknown>,
        svc,
      ) as unknown as MessageJobData;
    }),
  };
}

// Replace decryptBatchFromQueue:
async function decryptBatchFromQueue(batch: MessageBatchJobData): Promise<MessageBatchJobData> {
  if (!isEncryptionAvailable()) return batch;
  const facade = getEncryptionFacade();

  if (facade) {
    const messages: MessageJobData[] = [];
    for (const m of batch.messages) {
      if (!m.tenantId) {
        messages.push(m);
        continue;
      }
      const decrypted = (await unwrapJobDataForDecryptAsync(
        'message-persistence',
        m as unknown as Record<string, unknown>,
        facade,
      )) as unknown as MessageJobData;
      messages.push(decrypted);
    }
    return { ...batch, messages };
  }

  // Legacy sync fallback
  const svc = getEncryptionService();
  return {
    ...batch,
    messages: batch.messages.map((m) => {
      if (!m.tenantId) return m;
      return unwrapJobDataForDecrypt(
        'message-persistence',
        m as unknown as Record<string, unknown>,
        svc,
      ) as unknown as MessageJobData;
    }),
  };
}
```

- [ ] **Step 2: Update callers of these helpers to await them**

Find all call sites of `encryptBatchForQueue` and `decryptBatchFromQueue` in the same file and add `await`:

```typescript
// Before:
const encrypted = encryptBatchForQueue(batch);
// After:
const encrypted = await encryptBatchForQueue(batch);

// Before:
const batch = decryptBatchFromQueue(job.data);
// After:
const batch = await decryptBatchFromQueue(job.data);
```

The callers (enqueue function and worker handler) are already async.

- [ ] **Step 3: Build and run tests**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=runtime && pnpm test --filter=runtime`
Expected: Build succeeds, tests pass

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/message-persistence-queue.ts
git add apps/runtime/src/services/message-persistence-queue.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] refactor(runtime): migrate message persistence queue to DEK encryption

Switch BullMQ message persistence encrypt/decrypt from sync EncryptionService
to async TenantEncryptionFacade. Falls back to legacy sync path when facade
is unavailable.
EOF
)"
```

---

## Task 7: Migrate Redis Session Store to Facade

**Files:**

- Modify: `apps/runtime/src/services/session/redis-session-store.ts`

**Context:** The redis session store has ~6 `encryptForTenant` and ~1 `decryptForTenant` calls on `this.encryptionService` (an `EncryptionService` instance). These are on the session data hot path. We switch to `encryptForTenantAuto`/`decryptForTenantAuto` which are already async and use the facade.

- [ ] **Step 1: Read the session store to understand the encryption integration**

Read: `apps/runtime/src/services/session/redis-session-store.ts` — find constructor, encryptionService injection, and all encrypt/decrypt call sites.

- [ ] **Step 2: Replace direct EncryptionService calls with auto functions**

Replace the `EncryptionService` dependency with imports of `encryptForTenantAuto`/`decryptForTenantAuto`:

```typescript
// Add import:
import { encryptForTenantAuto, decryptForTenantAuto } from '@agent-platform/shared/encryption';

// At each call site, replace:
//   this.encryptionService.encryptForTenant(value, tenantId)
// With:
//   await encryptForTenantAuto(value, tenantId, projectId)
//
// And replace:
//   this.encryptionService.decryptForTenant(value, tenantId)
// With:
//   await decryptForTenantAuto(value, tenantId)
```

Note: The `encryptForTenantAuto` function accepts optional `projectId` and `environment` params. Pass `projectId` from session context if available, otherwise the default `'_tenant'` is fine.

Keep `encryptionService` in the constructor for now (other methods may use it for non-tenant encryption). Only replace `encryptForTenant`/`decryptForTenant` calls.

- [ ] **Step 3: Build and run tests**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=runtime && pnpm test --filter=runtime`
Expected: Build succeeds, tests pass

- [ ] **Step 4: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/services/session/redis-session-store.ts
git add apps/runtime/src/services/session/redis-session-store.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] refactor(runtime): migrate redis session store to DEK encryption

Replace direct EncryptionService.encryptForTenant/decryptForTenant calls
with encryptForTenantAuto/decryptForTenantAuto, routing through the
TenantEncryptionFacade for DEK envelope encryption.
EOF
)"
```

---

## Task 8: Migrate Remaining Direct Call Sites in Routes

**Files:**

- Modify: `apps/runtime/src/routes/connections.ts`
- Modify: `apps/runtime/src/services/execution/routing-executor.ts`

**Context:** `connections.ts` uses `getEncryptionService().encryptForTenant`/`decryptForTenant` directly. `routing-executor.ts` uses `getEncryptionService().decryptJsonForTenant`. Both should use the auto functions.

- [ ] **Step 1: Read connections.ts to find exact call sites**

Read: `apps/runtime/src/routes/connections.ts` lines around 78, 117, 119.

- [ ] **Step 2: Update connections.ts**

Replace:

```typescript
// Before:
const encryptionService = getEncryptionService();
// ... later:
encryptionService.encryptForTenant(plain, tenantId);
encryptionService.decryptForTenant(cipher, tenantId);

// After:
import { encryptForTenantAuto, decryptForTenantAuto } from '@agent-platform/shared/encryption';
// ... later:
await encryptForTenantAuto(plain, tenantId, projectId);
await decryptForTenantAuto(cipher, tenantId);
```

- [ ] **Step 3: Read routing-executor.ts to find the call site**

Read: `apps/runtime/src/services/execution/routing-executor.ts` around line 2596.

- [ ] **Step 4: Update routing-executor.ts**

Replace `getEncryptionService().decryptJsonForTenant(...)` with:

```typescript
const decrypted = await decryptForTenantAuto(encrypted, tenantId);
const parsed = JSON.parse(decrypted);
```

- [ ] **Step 5: Build and run tests**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build --filter=runtime && pnpm test --filter=runtime`
Expected: Build succeeds, tests pass

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write apps/runtime/src/routes/connections.ts apps/runtime/src/services/execution/routing-executor.ts
git add apps/runtime/src/routes/connections.ts apps/runtime/src/services/execution/routing-executor.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] refactor(runtime): migrate connection routes to DEK encryption

Replace direct getEncryptionService() calls in connections.ts and
routing-executor.ts with encryptForTenantAuto/decryptForTenantAuto
for DEK envelope encryption.
EOF
)"
```

---

## Task 9: Verify Full Build and Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Full monorepo build**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm build`
Expected: All packages build clean

- [ ] **Step 2: Full test suite**

Run: `cd /home/SaiKumar.Shetty/Documents/gale/abl-platform && pnpm test`
Expected: All tests pass, zero failures

- [ ] **Step 3: Verify no remaining legacy-only encrypt paths**

Run: `grep -rn 'encryptionService\.encryptForTenant\|encryptionService\.decryptForTenant' apps/runtime/src/ --include='*.ts' | grep -v '__tests__' | grep -v '.d.ts'`

This should show only:

- `redis-session-store.ts` (if not fully migrated — verify)
- Service files that use DI interfaces (tool-oauth-service, secrets-provider, inline-mcp-provider) — these are injected `EncryptionService` instances that receive the auto function via their interface. Verify the injectors pass the facade-based version.

---

## Out of Scope (Future Tasks)

These items are identified gaps but are NOT part of this refactoring:

1. **ClickHouse compress-then-encrypt**: `compressAndEncryptForTenant` in `engine.ts` uses PBKDF2 only. This needs a separate `compressAndEncryptForTenantAsync` that uses the facade + zstd compression. Only affects tables with large payloads.

2. **LLM Queue encryption gap**: `llm-queue.ts` has a manifest entry for encrypting `message` but doesn't actually call the encrypt wrapper. This is a separate bug fix.

3. **DI-injected services** (tool-oauth-service, secrets-provider, inline-mcp-provider, voice services): These accept an `EncryptionService`-like interface. They need their interfaces updated to accept async encrypt/decrypt, and their injectors updated to pass facade-based implementations. This is a larger refactor touching service constructors.

4. **BullMQ per-tenant queue isolation**: No per-tenant partitioning exists. This is an architecture decision, not a DEK migration issue.

5. **ClickHouse FactStore**: Has no `tenant_id` column, so encryption is impossible without schema migration.
