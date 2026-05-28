# Enterprise KMS & Encryption Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all KMS providers work per-tenant from DB config, fix encryption plugin security gaps, clean up dead code and env vars.

**Architecture:** Replace global KMS singleton with a `KMSProviderPool` keyed by config fingerprint. Wire pool through `KMSResolver` into every consumer (`dek-manager`, `reencryption-queue`, `kms-rotation-job`, `encryption.plugin`). Add missing per-tenant config fields. Harden encryption plugin against bulk ops, serialization leaks, and partial writes.

**Tech Stack:** Mongoose plugins, AES-256-GCM, BullMQ, SWR (Studio), Express routes

**Design doc:** `docs/plans/2026-03-07-enterprise-kms-encryption-design.md`

**Review findings incorporated:**

- G1/G3: Circular dependency fix — inject resolver function, not class import
- G2: pbkdf2Sync → async in LocalKMSProvider (Phase 0)
- G4: Redis Pub/Sub cache invalidation (Task 22)
- G6: Deployment sequence added at bottom
- G7: Concurrent acquire dedup in DEKCache (Task 23)

---

## Phase 0: Prerequisites

### Task 0A: Convert pbkdf2Sync to async in LocalKMSProvider

**Why:** `pbkdf2Sync` with 100k iterations blocks the event loop ~50-100ms per call. Under load this causes DoS.

**Files:**

- Modify: `packages/database/src/kms/local-kms-provider.ts`

**Step 1:** Find the `deriveKey` method that uses `pbkdf2Sync` and convert to async:

```typescript
// BEFORE:
import { pbkdf2Sync, ... } from 'node:crypto';

private deriveKey(keyId: string): Buffer {
  return pbkdf2Sync(this.masterKey, `kms:${keyId}`, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// AFTER:
import { pbkdf2, ... } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

private async deriveKey(keyId: string): Promise<Buffer> {
  return pbkdf2Async(this.masterKey, `kms:${keyId}`, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}
```

**Step 2:** Update all callers of `deriveKey()` to `await this.deriveKey()` — `wrapKey`, `unwrapKey`, `encrypt`, `decrypt`, `generateDataKey`.

**Step 3:** Also check `packages/shared/src/encryption/` for any `pbkdf2Sync` usage and convert.

**Step 4:** Build and run tests:

```bash
pnpm build && cd packages/database && pnpm vitest run src/__tests__/encryption-plugin
```

### Task 0B: Add KMS resolver injection point to encryption plugin

**Why:** The encryption plugin lives in `packages/database` but needs per-tenant KMS resolution which lives in `apps/runtime`. Direct import creates circular dependency. Solution: inject a resolver function at startup.

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts`

**Step 1:** Add resolver function type and setter after the tenant encryption section (after line 111):

```typescript
// ─── KMS Resolver Function (injected at startup) ────────────────────

type KMSResolverFn = (tenantId: string) => Promise<{
  provider: KMSProvider;
  keyId: string;
} | null>;

let kmsResolverFn: KMSResolverFn | null = null;

/**
 * Set the KMS resolver function for per-tenant v2 encryption.
 * Called at startup after KMSProviderPool and KMSResolver are initialized.
 *
 * The function takes a tenantId and returns the resolved provider + keyId,
 * or null to fall back to v1.
 */
export function setKMSResolverFn(fn: KMSResolverFn): void {
  kmsResolverFn = fn;
}

function isKMSResolverAvailable(): boolean {
  return kmsResolverFn !== null;
}
```

**Step 2:** Export from barrel — add `setKMSResolverFn` to `packages/database/src/mongo/index.ts` exports.

**Step 3:** Update `_resetEncryptionStateForTesting` to also clear `kmsResolverFn`:

```typescript
export function _resetEncryptionStateForTesting(): void {
  masterKeyBuffer = null;
  kmsProvider = null;
  kmsKeyId = null;
  tenantEncryption = null;
  kmsResolverFn = null;
}
```

**Step 4:** Build and run tests — expect PASS (no behavior change yet, just new injection point).

---

## Phase 1: Encryption Plugin Hardening (No Behavioral Change to KMS)

### Task 1: Block bulk ops on encrypted models (E1)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:235-248`
- Test: `packages/database/src/__tests__/encryption-plugin-bulk-ops.test.ts` (new)

**Step 1: Write failing tests**

```typescript
// packages/database/src/__tests__/encryption-plugin-bulk-ops.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setMasterKey,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

describe('encryption plugin — bulk operation blocking', () => {
  let TestModel: any;

  beforeAll(async () => {
    _resetEncryptionStateForTesting();
    setMasterKey(TEST_MASTER_KEY);

    const schema = new mongoose.Schema({
      tenantId: String,
      name: String,
      secret: String,
    });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
    TestModel = mongoose.model('BulkOpTest', schema);
  });

  afterAll(() => {
    _resetEncryptionStateForTesting();
    delete mongoose.models.BulkOpTest;
    delete (mongoose as any).modelSchemas.BulkOpTest;
  });

  it('insertMany with plaintext encrypted field throws', async () => {
    await expect(
      TestModel.insertMany([{ tenantId: 't1', name: 'a', secret: 'plaintext-secret' }]),
    ).rejects.toThrow(/encryption.*insertMany/i);
  });

  it('updateMany with plaintext $set on encrypted field throws', async () => {
    await expect(
      TestModel.updateMany({ tenantId: 't1' }, { $set: { secret: 'new-plaintext' } }),
    ).rejects.toThrow(/encryption.*updateMany/i);
  });

  it('updateMany on non-encrypted field succeeds', async () => {
    await expect(
      TestModel.updateMany({ tenantId: 't1' }, { $set: { name: 'updated' } }),
    ).resolves.not.toThrow();
  });

  it('insertMany with no encrypted fields succeeds', async () => {
    await expect(TestModel.insertMany([{ tenantId: 't1', name: 'b' }])).resolves.not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/database && pnpm vitest run src/__tests__/encryption-plugin-bulk-ops.test.ts
```

Expected: FAIL — no bulk op blocking exists yet.

**Step 3: Implement bulk op guards**

Add after `schema.add({ ire: ... })` block (after line 247) in `encryption.plugin.ts`:

```typescript
// ── Block unencrypted bulk writes ──────────────────────────────────
schema.pre('insertMany', function (next, docs: any[]) {
  for (const doc of docs) {
    for (const field of fieldsToEncrypt) {
      if (doc[field] !== undefined && doc[field] !== null && !doc.ire) {
        return next(
          new Error(
            `[encryption-plugin] Cannot insertMany with unencrypted field '${field}'. ` +
              'Use save() for automatic encryption.',
          ),
        );
      }
    }
  }
  next();
});

schema.pre('updateMany', function (next) {
  const update = this.getUpdate() as any;
  if (!update?.$set) return next();
  for (const field of fieldsToEncrypt) {
    if (update.$set[field] !== undefined) {
      return next(
        new Error(
          `[encryption-plugin] Cannot updateMany with encrypted field '${field}'. ` +
            'Use findOneAndUpdate() + save() for automatic encryption.',
        ),
      );
    }
  }
  next();
});
```

**Step 4: Run tests**

```bash
cd packages/database && pnpm vitest run src/__tests__/encryption-plugin-bulk-ops.test.ts
```

Expected: PASS

**Step 5: Run existing encryption tests to verify no regressions**

```bash
cd packages/database && pnpm vitest run src/__tests__/encryption-plugin
```

Expected: All existing tests PASS

---

### Task 2: Fix serialization leak (E2)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:240-247`
- Test: `packages/database/src/__tests__/encryption-plugin-serialization.test.ts` (new)

**Step 1: Write failing test**

```typescript
// packages/database/src/__tests__/encryption-plugin-serialization.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import {
  setMasterKey,
  _resetEncryptionStateForTesting,
} from '../mongo/plugins/encryption.plugin.js';
import { encryptionPlugin } from '../mongo/plugins/encryption.plugin.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

describe('encryption plugin — serialization', () => {
  let TestModel: any;

  beforeAll(async () => {
    _resetEncryptionStateForTesting();
    setMasterKey(TEST_MASTER_KEY);

    const schema = new mongoose.Schema({
      tenantId: String,
      name: String,
      secret: String,
    });
    schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['secret'] });
    TestModel = mongoose.model('SerializationTest', schema);
  });

  afterAll(() => {
    _resetEncryptionStateForTesting();
    delete mongoose.models.SerializationTest;
    delete (mongoose as any).modelSchemas.SerializationTest;
  });

  it('toJSON strips encryption metadata (ire, cek, iv, kmsKeyId)', async () => {
    const doc = new TestModel({ tenantId: 't1', name: 'test', secret: 'mysecret' });
    await doc.save();

    const json = doc.toJSON();
    expect(json).not.toHaveProperty('ire');
    expect(json).not.toHaveProperty('cek');
    expect(json).not.toHaveProperty('iv');
    expect(json).not.toHaveProperty('kmsKeyId');
    expect(json).toHaveProperty('name', 'test');
  });

  it('toObject strips encryption metadata', async () => {
    const doc = new TestModel({ tenantId: 't1', name: 'test2', secret: 'anothersecret' });
    await doc.save();

    const obj = doc.toObject();
    expect(obj).not.toHaveProperty('ire');
    expect(obj).not.toHaveProperty('cek');
    expect(obj).not.toHaveProperty('iv');
    expect(obj).not.toHaveProperty('kmsKeyId');
  });
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Add toJSON/toObject transforms**

In `encryptionPlugin()`, after the `schema.add({ ire: ... })` block:

```typescript
// ── Strip encryption metadata from serialization ───────────────────
const stripEncryptionMeta = (_doc: any, ret: any) => {
  delete ret.ire;
  delete ret.cek;
  delete ret.iv;
  delete ret.kmsKeyId;
  return ret;
};
schema.set('toJSON', { transform: stripEncryptionMeta });
schema.set('toObject', { transform: stripEncryptionMeta });
```

**Step 4: Run tests — expect PASS**

**Step 5: Run all encryption tests — expect PASS**

---

### Task 3: Fix partial write atomicity (E3)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:320-327`

**Step 1: Refactor pre-save v1/v2 field encryption to be atomic**

Replace lines 320-327 (the `for` loop that encrypts fields one at a time):

```typescript
// BEFORE (line 320-327):
for (const field of fieldsToEncrypt) {
  const value = this.get(field);
  if (value !== undefined && value !== null) {
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    this.set(field, encryptField(strValue, cek, this._id as string));
  }
}

// AFTER (atomic):
const encrypted = new Map<string, string>();
for (const field of fieldsToEncrypt) {
  const value = this.get(field);
  if (value !== undefined && value !== null) {
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    encrypted.set(field, encryptField(strValue, cek, this._id as string));
  }
}
for (const [field, value] of encrypted) {
  this.set(field, value);
}
```

Also make the v3 path atomic (lines 285-291):

```typescript
// BEFORE (line 285-291):
for (const field of fieldsToEncrypt) {
  const value = this.get(field);
  if (value !== undefined && value !== null) {
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    this.set(field, enc.encryptForTenant(strValue, tenantId));
  }
}

// AFTER (atomic):
const encryptedV3 = new Map<string, string>();
for (const field of fieldsToEncrypt) {
  const value = this.get(field);
  if (value !== undefined && value !== null) {
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    encryptedV3.set(field, enc.encryptForTenant(strValue, tenantId));
  }
}
for (const [field, value] of encryptedV3) {
  this.set(field, value);
}
```

**Step 2: Run all encryption tests — expect PASS (behavior unchanged)**

---

### Task 4: Replace console.warn with logger

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:14,370,450`

**Step 1: Add logger import**

After line 14 (`import type { KMSProvider } ...`), add:

```typescript
import { createLogger } from '@abl/compiler/platform';
const log = createLogger('encryption-plugin');
```

**Step 2: Replace console.warn calls**

Line 370:

```typescript
// BEFORE:
console.warn('[encryption-plugin] CEK unwrap failed, falling back to route decryption', {
// AFTER:
log.warn('CEK unwrap failed, falling back to route decryption', {
```

Line 450:

```typescript
// BEFORE:
console.warn('[encryption-plugin] decryptDoc failed, leaving fields encrypted', {
// AFTER:
log.warn('decryptDoc failed, leaving fields encrypted', {
```

**Step 3: Run all encryption tests — expect PASS**

---

### Task 5: Prevent v3-to-v1 downgrade (E5)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts` (pre-save hook)
- Test: add to `packages/database/src/__tests__/encryption-plugin-v3.test.ts`

**Step 1: Write failing test**

Add to the existing v3 test file:

```typescript
it('refuses to downgrade v3 document to v1 when tenant encryption unavailable', async () => {
  // Create v3 doc
  const doc = new TestModel({ tenantId: 't1', secret: 'original' });
  await doc.save();
  expect(doc.ire).toBe('v3');

  // Disable tenant encryption
  _resetEncryptionStateForTesting();
  setMasterKey(TEST_MASTER_KEY);
  // Tenant encryption is now unavailable, only v1 available

  doc.secret = 'modified';
  await expect(doc.save()).rejects.toThrow(/downgrade/i);
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Add downgrade guard in pre-save**

Before the v3 check (around line 276), add:

```typescript
// Prevent v3 → v1 downgrade
const existingIre = this.get('ire');
if (existingIre === 'v3' && !skipTenantScoping && !isTenantEncryptionAvailable()) {
  throw new Error(
    '[encryption-plugin] Cannot save: tenant encryption unavailable and document requires v3. ' +
      'Refusing to downgrade to v1/v2.',
  );
}
```

**Step 4: Run tests — expect PASS**

---

### Task 6: Add findOneAndDelete post-hook (E9)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:457-467`

**Step 1: Add findOneAndDelete to the post-hook list**

Change lines 457-467 to include `findOneAndDelete`:

```typescript
schema.post('find', async function (docs: any[]) {
  await Promise.all(docs.map(decryptDoc));
});

schema.post('findOne', async function (doc: any) {
  await decryptDoc(doc);
});

schema.post('findOneAndUpdate', async function (doc: any) {
  await decryptDoc(doc);
});

schema.post('findOneAndDelete', async function (doc: any) {
  await decryptDoc(doc);
});
```

**Step 2: Run all encryption tests — expect PASS**

---

### Task 7: Fix IV_LENGTH mismatch (E4)

**Files:**

- Modify: `packages/shared/src/encryption/constants.ts:2`

**Step 1: Update shared constant**

```typescript
// BEFORE:
export const IV_LENGTH = 16;
// AFTER:
export const IV_LENGTH = 12; // 96 bits — NIST SP 800-38D recommended for AES-GCM
```

**Step 2: Run full test suite to find breakages**

```bash
pnpm build && pnpm test
```

Note: Old encrypted data with 16-byte IVs is self-describing (IV is stored in ciphertext). The `engine.ts` decryption reads IV from stored data, so existing data still decrypts correctly. Only NEW encryptions use 12-byte IVs.

If any tests fail, they're likely testing the engine directly with hardcoded 16-byte expectations — update those tests.

---

### Task 8: Validate master key hex format (E7)

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:35-39`

**Step 1: Strengthen validation**

```typescript
// BEFORE:
export function setMasterKey(masterKey: string): void {
  if (masterKey.length !== 64) {
    throw new Error('Master key must be a 64-character hex string (32 bytes)');
  }
  masterKeyBuffer = Buffer.from(masterKey, 'hex');
}

// AFTER:
export function setMasterKey(masterKey: string): void {
  if (!/^[0-9a-f]{64}$/i.test(masterKey)) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY must be exactly 64 hex characters (32 bytes). ' +
        `Got ${masterKey.length} characters.`,
    );
  }
  masterKeyBuffer = Buffer.from(masterKey, 'hex');
}
```

**Step 2: Run all encryption tests — expect PASS**

---

## Phase 2: KMS Provider Pool

### Task 9: Create KMSProviderPool

**Files:**

- Create: `packages/database/src/kms/kms-provider-pool.ts`
- Test: `packages/database/src/__tests__/kms-provider-pool.test.ts` (new)

**Step 1: Write failing tests**

```typescript
// packages/database/src/__tests__/kms-provider-pool.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KMSProviderPool } from '../kms/kms-provider-pool.js';
import type { IResolvedProviderRef } from '../models/materialized-kms-config.model.js';

const TEST_MASTER_KEY = 'a'.repeat(64);

const localConfig: IResolvedProviderRef = {
  providerType: 'local',
  keyId: 'platform-default',
  region: null,
  vaultUrl: null,
  externalEndpoint: null,
  authMethod: null,
  authConfigEncrypted: null,
};

const awsConfig: IResolvedProviderRef = {
  providerType: 'local', // Use local to simulate — real AWS needs creds
  keyId: 'aws-test-key',
  region: 'us-east-1',
  vaultUrl: null,
  externalEndpoint: null,
  authMethod: null,
  authConfigEncrypted: null,
};

describe('KMSProviderPool', () => {
  let pool: KMSProviderPool;

  beforeEach(async () => {
    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 5 });
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  it('getLocalProvider returns initialized local provider', () => {
    const local = pool.getLocalProvider();
    expect(local).toBeDefined();
    expect(local.providerType).toBe('local');
  });

  it('getProvider returns local provider for local config', async () => {
    const provider = await pool.getProvider(localConfig);
    expect(provider.providerType).toBe('local');
  });

  it('same fingerprint returns same instance', async () => {
    const p1 = await pool.getProvider(localConfig);
    const p2 = await pool.getProvider(localConfig);
    expect(p1).toBe(p2);
  });

  it('different fingerprints return different instances', async () => {
    const p1 = await pool.getProvider(localConfig);
    const p2 = await pool.getProvider(awsConfig);
    expect(p1).not.toBe(p2);
  });

  it('evict removes provider from pool', async () => {
    await pool.getProvider(awsConfig);
    expect(pool.size).toBe(2); // local + aws
    await pool.evict('local:aws-test-key');
    expect(pool.size).toBe(1);
  });

  it('shutdown clears all providers', async () => {
    await pool.getProvider(awsConfig);
    await pool.shutdown();
    expect(pool.size).toBe(0);
  });

  it('rejects when pool is full', async () => {
    // Pool maxSize=5, local takes 1 slot
    for (let i = 0; i < 4; i++) {
      await pool.getProvider({
        ...localConfig,
        keyId: `key-${i}`,
      });
    }
    // 5th different config should evict LRU (not throw)
    const p = await pool.getProvider({ ...localConfig, keyId: 'key-overflow' });
    expect(p).toBeDefined();
    expect(pool.size).toBeLessThanOrEqual(5);
  });
});
```

**Step 2: Run test — expect FAIL**

**Step 3: Implement KMSProviderPool**

```typescript
// packages/database/src/kms/kms-provider-pool.ts
import type { KMSProvider } from './types.js';
import type { IResolvedProviderRef } from '../models/materialized-kms-config.model.js';
import { LocalKMSProvider } from './local-kms-provider.js';

interface PooledProvider {
  provider: KMSProvider;
  fingerprint: string;
  lastUsedAt: number;
}

export interface KMSProviderPoolOptions {
  masterKeyHex: string;
  maxSize?: number;
  idleTimeoutMs?: number;
}

export function computeFingerprint(config: IResolvedProviderRef): string {
  switch (config.providerType) {
    case 'local':
      return `local:${config.keyId}`;
    case 'aws-kms':
      return `aws-kms:${config.region}:${config.keyId}`;
    case 'azure-keyvault':
    case 'azure-managed-hsm':
      return `${config.providerType}:${config.vaultUrl}`;
    case 'gcp-cloud-kms':
      return `gcp-cloud-kms:${config.region}:${config.keyId}`;
    case 'external':
      return `external:${config.externalEndpoint}`;
    default:
      return `${config.providerType}:${config.keyId}`;
  }
}

export class KMSProviderPool {
  private providers = new Map<string, PooledProvider>();
  private localProvider: LocalKMSProvider | null = null;
  private readonly masterKeyHex: string;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;

  constructor(options: KMSProviderPoolOptions) {
    this.masterKeyHex = options.masterKeyHex;
    this.maxSize = options.maxSize ?? 50;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
  }

  async initialize(): Promise<void> {
    this.localProvider = new LocalKMSProvider(this.masterKeyHex);
    await this.localProvider.initialize();

    const fp = 'local:platform-default';
    this.providers.set(fp, {
      provider: this.localProvider,
      fingerprint: fp,
      lastUsedAt: Date.now(),
    });
  }

  getLocalProvider(): KMSProvider {
    if (!this.localProvider) {
      throw new Error('KMSProviderPool not initialized. Call initialize() first.');
    }
    return this.localProvider;
  }

  async getProvider(config: IResolvedProviderRef): Promise<KMSProvider> {
    const fp = computeFingerprint(config);

    const existing = this.providers.get(fp);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.provider;
    }

    // Evict LRU if at capacity
    if (this.providers.size >= this.maxSize) {
      this.evictLRU();
    }

    // Create new provider
    const provider = await this.createProvider(config);
    this.providers.set(fp, {
      provider,
      fingerprint: fp,
      lastUsedAt: Date.now(),
    });

    return provider;
  }

  async evict(fingerprint: string): Promise<void> {
    const entry = this.providers.get(fingerprint);
    if (!entry) return;

    // Never evict the default local provider
    if (entry.provider === this.localProvider) return;

    this.providers.delete(fingerprint);
    await entry.provider.shutdown();
  }

  async shutdown(): Promise<void> {
    const entries = [...this.providers.values()];
    this.providers.clear();
    this.localProvider = null;

    await Promise.allSettled(entries.map((e) => e.provider.shutdown()));
  }

  get size(): number {
    return this.providers.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.providers) {
      // Never evict the default local provider
      if (entry.provider === this.localProvider) continue;
      if (entry.lastUsedAt < oldestTime) {
        oldestTime = entry.lastUsedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.providers.get(oldestKey);
      this.providers.delete(oldestKey);
      entry?.provider.shutdown().catch(() => {});
    }
  }

  private async createProvider(config: IResolvedProviderRef): Promise<KMSProvider> {
    // All "local" variants use LocalKMSProvider with the platform master key
    if (config.providerType === 'local') {
      const provider = new LocalKMSProvider(this.masterKeyHex);
      await provider.initialize();
      return provider;
    }

    // Dynamic import to avoid bundling unused cloud SDKs
    const { createKMSProvider } = await import('./providers/index.js');
    const provider = await createKMSProvider({
      providerType: config.providerType as any,
      keyId: config.keyId,
      region: config.region ?? undefined,
      vaultUrl: config.vaultUrl ?? undefined,
      externalEndpoint: config.externalEndpoint ?? undefined,
      authMethod: config.authMethod ?? undefined,
      authConfigEncrypted: config.authConfigEncrypted ?? undefined,
    });
    await provider.initialize();
    return provider;
  }
}
```

**Step 4: Export from barrel**

Add to `packages/database/src/kms/index.ts`:

```typescript
// Provider pool
export {
  KMSProviderPool,
  computeFingerprint,
  type KMSProviderPoolOptions,
} from './kms-provider-pool.js';
```

**Step 5: Run tests — expect PASS**

---

### Task 10: Add pool to KMS registry

**Files:**

- Modify: `packages/database/src/kms/kms-registry.ts`

**Step 1: Add pool state alongside existing singleton**

```typescript
// Add after line 27 (let platformProvider):
import type { KMSProviderPool } from './kms-provider-pool.js';

let providerPool: KMSProviderPool | null = null;

export function setKMSProviderPool(pool: KMSProviderPool): void {
  providerPool = pool;
  // Also set platformProvider for backward compat
  platformProvider = pool.getLocalProvider();
}

export function getKMSProviderPool(): KMSProviderPool {
  if (!providerPool) {
    throw new Error('KMS Registry: no provider pool set. Call setKMSProviderPool() at startup.');
  }
  return providerPool;
}

export function isKMSProviderPoolAvailable(): boolean {
  return providerPool !== null;
}
```

Update `shutdownKMSRegistry`:

```typescript
export async function shutdownKMSRegistry(): Promise<void> {
  if (providerPool) {
    const pool = providerPool;
    providerPool = null;
    platformProvider = null;
    await pool.shutdown();
  } else if (platformProvider) {
    const provider = platformProvider;
    platformProvider = null;
    await provider.shutdown();
  }
}
```

Update `_resetKMSRegistryForTesting`:

```typescript
export function _resetKMSRegistryForTesting(): void {
  platformProvider = null;
  providerPool = null;
}
```

**Step 2: Export new functions from barrel** (`packages/database/src/kms/index.ts`):

```typescript
export {
  setPlatformKMSProvider,
  getPlatformKMSProvider,
  isPlatformKMSAvailable,
  setKMSProviderPool,
  getKMSProviderPool,
  isKMSProviderPoolAvailable,
  shutdownKMSRegistry,
  _resetKMSRegistryForTesting,
} from './kms-registry.js';
```

**Step 3: Run all tests — expect PASS (backward compatible)**

---

### Task 11: Update server.ts startup to use pool

**Files:**

- Modify: `apps/runtime/src/server.ts:757-777`

**Step 1: Replace singleton init with pool init**

```typescript
// BEFORE (lines 757-777):
// Initialize KMS abstraction layer (LocalKMSProvider wraps existing master key behavior)
try {
  const { LocalKMSProvider, setPlatformKMSProvider } = await import('@agent-platform/database/kms');
  const kmsProvider = new LocalKMSProvider(encMasterKey);
  await kmsProvider.initialize();
  setPlatformKMSProvider(kmsProvider);
  serverLog.info('KMS provider initialized', { providerType: kmsProvider.providerType });

  // Wire KMS into Mongoose encryption plugin when keyId is configured
  const kmsKeyId = getConfigLazy().kms?.keyId;
  if (kmsKeyId) {
    const { setKMSProvider } = await import('@agent-platform/database/models');
    setKMSProvider(kmsProvider, kmsKeyId);
    serverLog.info('Mongoose encryption plugin KMS v2 enabled', { kmsKeyId });
  }
} catch (kmsError) {
  serverLog.warn('KMS provider initialization failed (non-fatal)', {
    error: kmsError instanceof Error ? kmsError.message : String(kmsError),
  });
}

// AFTER:
// Initialize KMS Provider Pool (replaces global singleton)
try {
  const { KMSProviderPool, setKMSProviderPool } = await import('@agent-platform/database/kms');
  const pool = new KMSProviderPool({ masterKeyHex: encMasterKey });
  await pool.initialize();
  setKMSProviderPool(pool);
  serverLog.info('KMS Provider Pool initialized');
} catch (kmsError) {
  serverLog.warn('KMS Provider Pool initialization failed (non-fatal)', {
    error: kmsError instanceof Error ? kmsError.message : String(kmsError),
  });
}
```

Note: `setKMSProvider(kmsProvider, kmsKeyId)` call is **removed** — v2 encryption will resolve the provider per-document via the injected resolver (Task 14). The `setKMSProviderPool` sets `platformProvider` internally for backward compat.

**Step 2: Wire KMS resolver function into encryption plugin**

After the pool init block, add:

```typescript
// Wire per-tenant KMS resolution into encryption plugin
try {
  const { setKMSResolverFn } = await import('@agent-platform/database/models');
  const { KMSResolver } = await import('./services/kms/kms-resolver.js');
  const { getKMSProviderPool } = await import('@agent-platform/database/kms');
  const resolver = new KMSResolver();
  const pool = getKMSProviderPool();

  setKMSResolverFn(async (tenantId: string) => {
    const config = await resolver.resolve(tenantId, 'default', 'production');
    if (config.provider.providerType === 'local' && config.sourceConfigVersion === 0) {
      // No tenant-specific config — return null to use legacy v1 path
      return null;
    }
    const provider = await pool.getProvider(config.provider);
    return { provider, keyId: config.keyId };
  });
  serverLog.info('KMS per-tenant resolver wired into encryption plugin');
} catch (resolverErr) {
  serverLog.warn('KMS resolver wiring failed (non-fatal, v2 uses legacy global)', {
    error: resolverErr instanceof Error ? resolverErr.message : String(resolverErr),
  });
}
```

**Step 3: Build and test**

```bash
pnpm build && pnpm test
```

---

## Phase 3: Wire Pool Into Consumers

### Task 12: Update dek-manager.ts to use pool + resolver

**Files:**

- Modify: `apps/runtime/src/services/kms/dek-manager.ts:16,157,184,253`

**Step 1: Replace import and add resolver dependency**

```typescript
// BEFORE (line 16):
import { getPlatformKMSProvider } from '@agent-platform/database/kms';

// AFTER:
import { getKMSProviderPool } from '@agent-platform/database/kms';
import type { KMSProvider } from '@agent-platform/database/kms';
import { KMSResolver, type ResolvedKMSConfig } from './kms-resolver.js';
```

**Step 2: Add resolver to DEKManager constructor**

```typescript
export class DEKManager {
  private cache = new DEKCache();
  private resolver: KMSResolver;

  constructor(resolver?: KMSResolver) {
    this.resolver = resolver ?? new KMSResolver();
  }

  private async getProviderForScope(scope: DEKScope): Promise<KMSProvider> {
    const config = await this.resolver.resolve(scope.tenantId, scope.projectId, scope.environment);
    const pool = getKMSProviderPool();
    return pool.getProvider(config.provider);
  }
```

**Step 3: Replace all `getPlatformKMSProvider()` calls**

Line 157: `const kms = getPlatformKMSProvider();` → `const kms = await this.getProviderForScope(scope);`

Line 184: `const kms = getPlatformKMSProvider();` → `const kms = await this.getProviderForScope(scope);`

Line 253: `const kms = getPlatformKMSProvider();` → `const kms = await this.getProviderForScope(scope);`

**Step 4: Build and run tests**

```bash
pnpm build && pnpm test
```

---

### Task 13: Update reencryption-queue.ts to use pool + resolver

**Files:**

- Modify: `apps/runtime/src/services/kms/reencryption-queue.ts:191-192`

**Step 1: Replace imports in processReencryptionJob**

```typescript
// BEFORE (lines 191-192):
const { getPlatformKMSProvider } = await import('@agent-platform/database/kms');
const kms = getPlatformKMSProvider();

// AFTER:
const { getKMSProviderPool } = await import('@agent-platform/database/kms');
const { KMSResolver } = await import('./kms-resolver.js');
const resolver = new KMSResolver();
const resolvedConfig = await resolver.resolve(
  tenantId,
  job.projectId ?? 'default',
  job.environment ?? 'production',
);
const pool = getKMSProviderPool();
const kms = await pool.getProvider(resolvedConfig.provider);
```

**Step 2: Build and run tests**

---

### Task 14: Update encryption.plugin.ts v2 path to use injected resolver

**Why:** The plugin can't import from `apps/runtime` (circular dep). Task 0B added `setKMSResolverFn()`. Now wire v2 encrypt/decrypt through it.

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts:49-71,141-153,170-177,305-310,363`

**Step 1: Deprecate global KMS state, use resolver function**

Keep `setKMSProvider`/`isKMSEncryptionAvailable` for backward compat but make v2 prefer the resolver:

```typescript
// Lines 49-71 — keep existing but update isKMSEncryptionAvailable:
export function isKMSEncryptionAvailable(): boolean {
  // Prefer injected resolver (per-tenant), fall back to global (legacy)
  return kmsResolverFn !== null || (kmsProvider !== null && kmsKeyId !== null);
}
```

**Step 2: Update encryptCEKWithKMS to use injected resolver**

```typescript
async function encryptCEKWithKMS(
  cek: Buffer,
  tenantId?: string,
): Promise<{ encryptedCek: string; kmsKeyIdUsed: string }> {
  // Per-tenant resolution via injected resolver (preferred)
  if (kmsResolverFn && tenantId) {
    const resolved = await kmsResolverFn(tenantId);
    if (resolved) {
      const { ciphertext } = await resolved.provider.wrapKey(resolved.keyId, cek);
      return {
        encryptedCek: ciphertext.toString('base64'),
        kmsKeyIdUsed: resolved.keyId,
      };
    }
  }

  // Legacy fallback: global kmsProvider (set at startup)
  if (!kmsProvider || !kmsKeyId) {
    throw new Error('KMS provider not configured');
  }
  const { ciphertext } = await kmsProvider.wrapKey(kmsKeyId, cek);
  return {
    encryptedCek: ciphertext.toString('base64'),
    kmsKeyIdUsed: kmsKeyId,
  };
}
```

**Step 3: Update decryptCEKv2 to use injected resolver**

```typescript
async function decryptCEKv2(
  encryptedCek: string,
  docKmsKeyId: string,
  tenantId?: string,
): Promise<Buffer> {
  const ciphertext = Buffer.from(encryptedCek, 'base64');

  // Per-tenant resolution via injected resolver (preferred)
  if (kmsResolverFn && tenantId) {
    try {
      const resolved = await kmsResolverFn(tenantId);
      if (resolved) {
        return resolved.provider.unwrapKey(docKmsKeyId, ciphertext);
      }
    } catch {
      // Fall through to legacy global provider
    }
  }

  // Legacy fallback: global kmsProvider
  if (!kmsProvider) {
    throw new Error('KMS provider not configured — cannot decrypt v2 document');
  }
  return kmsProvider.unwrapKey(docKmsKeyId, ciphertext);
}
```

**Step 4: Update pre-save v2 path to pass tenantId**

```typescript
// Around line 305:
if (isKMSEncryptionAvailable()) {
  const tenantId = this.get(tenantIdField) as string | undefined;
  const { encryptedCek, kmsKeyIdUsed } = await encryptCEKWithKMS(cek, tenantId);
  this.set('cek', encryptedCek);
  this.set('kmsKeyId', kmsKeyIdUsed);
  this.set('iv', undefined);
  this.set('ire', 'v2');
}
```

**Step 5: Update decryptDoc to pass tenantId**

```typescript
// Around line 363:
cek = await decryptCEKv2(doc.cek, doc.kmsKeyId, doc[tenantIdField]);
```

**Step 6: Build and run all encryption tests**

```bash
pnpm build && cd packages/database && pnpm vitest run src/__tests__/encryption-plugin
```

Existing tests still pass because they set global `kmsProvider` (legacy path). New per-tenant path activates only when `kmsResolverFn` is set.

---

### Task 15: Update kms-rotation-job.ts to use per-tenant config

**Files:**

- Modify: `apps/runtime/src/services/kms/kms-rotation-job.ts:102-126,172,221-254`

**Step 1: Make rotation per-tenant**

The rotation job currently applies global settings to all tenants. Change it to iterate tenants and read their config:

```typescript
async function runRotation(config: KMSRotationConfig): Promise<void> {
  if (!isDatabaseAvailable()) return;

  const now = new Date();
  const { TenantKMSConfig } = await import('@agent-platform/database/models');

  // Get all tenants with KMS configs
  const tenantConfigs = await TenantKMSConfig.find({})
    .select('tenantId dekEpochIntervalHours dekRetentionDays kekRotationPeriodDays')
    .lean();

  // Also run for system-level (tenants without explicit config use defaults)
  const tenantIds = tenantConfigs.map((c: any) => c.tenantId);

  // Phase 1: Epoch transitions (global — uses DEK expiresAt field)
  const transitioned = await transitionExpiredDEKs(now);

  // Phase 2: DEK destruction — per-tenant retention
  let totalDestroyed = 0;
  for (const tc of tenantConfigs) {
    const retention = (tc as any).dekRetentionDays ?? config.dekRetentionDays;
    totalDestroyed += await destroyRetiredDEKs(now, retention, (tc as any).tenantId);
  }
  // Also destroy for tenants without config (use global default)
  totalDestroyed += await destroyRetiredDEKsExcluding(now, config.dekRetentionDays, tenantIds);

  // Phase 3: KEK age check
  let reencryptionQueued = 0;
  if (config.enableReencryption) {
    reencryptionQueued = await checkKEKRotation(config.kekRotationPeriodDays);
  }

  if (transitioned > 0 || totalDestroyed > 0 || reencryptionQueued > 0) {
    log.info('KMS rotation pass completed', {
      transitioned,
      destroyed: totalDestroyed,
      reencryptionQueued,
    });
  }
}
```

Update `destroyRetiredDEKs` to accept optional tenantId filter:

```typescript
async function destroyRetiredDEKs(
  now: Date,
  retentionDays: number,
  tenantId?: string,
): Promise<number> {
  // Add tenantId to query if provided
  const query: Record<string, any> = {
    status: 'decrypt_only',
    expiresAt: { $lt: new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000) },
  };
  if (tenantId) query.tenantId = tenantId;
  // ... rest unchanged
}
```

**Step 2: Build and test**

---

### Task 16: Update kms-admin.ts — sync materialization + pool health

**Files:**

- Modify: `apps/runtime/src/routes/kms-admin.ts:106-118,371-384`

**Step 1: Make materialization synchronous**

```typescript
// BEFORE (lines 106-118):
// Trigger materialization (fire-and-forget)
try {
  const { KMSMaterializer } = await import('../services/kms/kms-materializer.js');
  const materializer = new KMSMaterializer();
  materializer.materialize(tenantId).catch((err: unknown) => { ... });
} catch { }

// AFTER:
// Trigger materialization (synchronous — admin can wait)
try {
  const { KMSMaterializer } = await import('../services/kms/kms-materializer.js');
  const materializer = new KMSMaterializer();
  await materializer.materialize(tenantId);
} catch (matErr) {
  log.warn('Materialization failed after config save', {
    tenantId,
    error: matErr instanceof Error ? matErr.message : String(matErr),
  });
}
```

**Step 2: Fix health endpoint to use pool**

```typescript
// BEFORE (lines 371-384):
const { getPlatformKMSProvider, isPlatformKMSAvailable } =
  await import('@agent-platform/database/kms');
if (!isPlatformKMSAvailable()) { ... }
const kms = getPlatformKMSProvider();
const health = await kms.healthCheck();

// AFTER:
const { getKMSProviderPool, isKMSProviderPoolAvailable } =
  await import('@agent-platform/database/kms');

if (!isKMSProviderPoolAvailable()) {
  return res.json({ tenantId, healthy: false, provider: config.provider.providerType, message: 'KMS provider pool not available' });
}

const pool = getKMSProviderPool();
const kms = await pool.getProvider(config.provider);
const health = await kms.healthCheck();
```

**Step 3: Build and test**

---

## Phase 4: Config Model & Cleanup

### Task 17: Add missing fields to TenantKMSConfig

**Files:**

- Modify: `packages/database/src/models/tenant-kms-config.model.ts:47-62,131-155`

**Step 1: Add missing fields to interface**

```typescript
export interface ITenantKMSConfig {
  _id: string;
  tenantId: string;
  defaultProvider: IKMSProviderRef | null;
  environments: IKMSEnvironmentOverride[];
  projects: IKMSProjectOverride[];
  dekEpochIntervalHours: number;
  dekMaxUsageCount: number;
  dekRetentionDays: number; // NEW (C1)
  kekRotationPeriodDays: number; // NEW (C2)
  reencryption: {
    // NEW (C3)
    enabled: boolean;
    concurrency: number;
    batchSize: number;
    maxRetries: number;
  };
  byokEnabled: boolean;
  byopEnabled: boolean;
  complianceLevel: string;
  failurePolicy: string;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
```

**Step 2: Add to schema**

After `dekMaxUsageCount` in the schema definition:

```typescript
dekRetentionDays: { type: Number, default: 90 },
kekRotationPeriodDays: { type: Number, default: 365 },
reencryption: {
  type: new Schema(
    {
      enabled: { type: Boolean, default: true },
      concurrency: { type: Number, default: 1 },
      batchSize: { type: Number, default: 50 },
      maxRetries: { type: Number, default: 3 },
    },
    { _id: false },
  ),
  default: () => ({ enabled: true, concurrency: 1, batchSize: 50, maxRetries: 3 }),
},
```

**Step 3: Update MaterializedKMSConfig similarly**

Add `dekRetentionDays` and `kekRotationPeriodDays` to the interface and schema.

**Step 4: Build and test**

---

### Task 18: Remove dead KMS env var config keys (C4)

**Files:**

- Modify: `apps/runtime/src/config/index.ts:265-271`

**Step 1: Remove dead config keys**

```typescript
// BEFORE (lines 265-271):
  // KMS
  KMS_PROVIDER: 'kms.provider',
  KMS_REGION: 'kms.region',
  KMS_KEY_ID: 'kms.keyId',
  KMS_VAULT_URL: 'kms.vaultUrl',
  KMS_DEK_EPOCH_INTERVAL_HOURS: 'kms.dekEpochIntervalHours',
  KMS_DEK_MAX_USAGE_COUNT: 'kms.dekMaxUsageCount',

// AFTER:
  // KMS — operational settings only. Provider config is per-tenant in DB.
  // (KMS_PROVIDER, KMS_REGION, KMS_KEY_ID, KMS_VAULT_URL removed — these are per-tenant)
```

**Step 2: Remove env var reads from reencryption-queue.ts**

Replace `getQueueConfig()` (lines 49-57) to read from tenant config when available:

```typescript
function getDefaultQueueConfig(): ReencryptionQueueConfig {
  return {
    enabled: process.env.KMS_REENCRYPTION_QUEUE_ENABLED !== 'false',
    concurrency: 1,
    batchSize: 50,
    maxRetries: 3,
    jobTimeoutMs: 300_000,
  };
}
```

The actual per-tenant values will be read from `TenantKMSConfig.reencryption` in the worker.

**Step 3: Update server.ts rotation job config** (lines 1167-1172)

```typescript
// BEFORE:
startKMSRotationJob({
  intervalMinutes: parseInt(process.env.KMS_ROTATION_INTERVAL_MINUTES || '60', 10),
  dekRetentionDays: parseInt(process.env.KMS_DEK_RETENTION_DAYS || '90', 10),
  kekRotationPeriodDays: parseInt(process.env.KMS_KEK_ROTATION_PERIOD_DAYS || '365', 10),
  enableReencryption: process.env.KMS_REENCRYPTION_ENABLED !== 'false',
});

// AFTER:
startKMSRotationJob({
  intervalMinutes: parseInt(process.env.KMS_ROTATION_INTERVAL_MINUTES || '60', 10),
  // dekRetentionDays and kekRotationPeriodDays are now per-tenant from DB.
  // These are fallback defaults for tenants without explicit config.
  dekRetentionDays: 90,
  kekRotationPeriodDays: 365,
  enableReencryption: true,
});
```

**Step 4: Build and run full test suite**

---

### Task 19: Update KMS admin PUT to save new fields

**Files:**

- Modify: `apps/runtime/src/routes/kms-admin.ts:86-104`

**Step 1: Add new fields to upsert**

```typescript
$set: {
  tenantId,
  defaultProvider: body.defaultProvider,
  environments: body.environments,
  projects: body.projects,
  dekEpochIntervalHours: body.dekEpochIntervalHours ?? 24,
  dekMaxUsageCount: body.dekMaxUsageCount ?? 2 ** 30,
  dekRetentionDays: body.dekRetentionDays ?? 90,              // NEW
  kekRotationPeriodDays: body.kekRotationPeriodDays ?? 365,    // NEW
  reencryption: {                                               // NEW
    enabled: body.reencryption?.enabled ?? true,
    concurrency: body.reencryption?.concurrency ?? 1,
    batchSize: body.reencryption?.batchSize ?? 50,
    maxRetries: body.reencryption?.maxRetries ?? 3,
  },
  byokEnabled: body.byokEnabled ?? false,
  byopEnabled: body.byopEnabled ?? false,
  complianceLevel: body.complianceLevel ?? 'standard',
  failurePolicy: body.failurePolicy ?? 'fail-closed',
},
```

**Step 2: Build and test**

---

### Task 20: Update Studio KMS UI to show new config fields

**Files:**

- Modify: `apps/studio/src/components/admin/KMSConfigForm.tsx`
- Modify: `apps/studio/src/hooks/useKMS.ts`

**Step 1: Add rotation/re-encryption fields to KMSConfigForm**

Add form fields for:

- `dekRetentionDays` (number input, default 90)
- `kekRotationPeriodDays` (number input, default 365)
- `reencryption.enabled` (checkbox)
- `reencryption.concurrency` (number input, default 1)
- `reencryption.batchSize` (number input, default 50)

Group them under a "Rotation & Re-encryption" section in the form.

**Step 2: Update useKMS hook updateKMSConfig mutation to include new fields**

**Step 3: Build Studio**

```bash
cd apps/studio && pnpm build
```

---

### Task 21: Final cleanup — remove deprecated code paths

**Files:**

- Modify: `packages/database/src/mongo/plugins/encryption.plugin.ts` — remove old `kmsProvider`/`kmsKeyId` globals (now replaced by pool resolution)
- Verify: `packages/database/src/kms/kms-registry.ts` — `getPlatformKMSProvider()` still works via pool backward compat
- Verify: All `getConfigLazy().kms?.keyId` references removed from `server.ts`

**Step 1: Search for remaining `getPlatformKMSProvider` calls**

```bash
grep -r "getPlatformKMSProvider" apps/ packages/ --include="*.ts" -l
```

Any remaining calls should be replaced with `getKMSProviderPool().getProvider(config)` or documented as backward-compat.

**Step 2: Search for remaining KMS env var references**

```bash
grep -rn "KMS_PROVIDER\|KMS_REGION\|KMS_KEY_ID\|KMS_VAULT_URL" apps/ packages/ --include="*.ts"
```

Remove any found (except in test fixtures).

**Step 3: Run full test suite**

```bash
pnpm build && pnpm test
```

---

## Phase 5: Multi-Pod Coherence & Hardening

### Task 22: Redis Pub/Sub cache invalidation for KMSResolver L1

**Why:** When admin updates KMS config on Pod A, Pod B's L1 cache (60s TTL) serves stale config. Wrong provider used for up to 60 seconds.

**Files:**

- Modify: `apps/runtime/src/services/kms/kms-resolver.ts`
- Modify: `apps/runtime/src/routes/kms-admin.ts` (publish after materialization)
- Modify: `apps/runtime/src/server.ts` (subscribe at startup)

**Step 1: Add publish/subscribe to KMSResolver**

```typescript
// kms-resolver.ts — add methods:

/** Publish cache invalidation event via Redis */
async publishInvalidation(tenantId: string): Promise<void> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (redis) {
      await redis.publish('kms:config:invalidate', tenantId);
    }
  } catch {
    // Redis not available — L1 TTL will expire naturally
  }
}

/** Subscribe to cache invalidation events */
async subscribeInvalidation(): Promise<void> {
  try {
    const { getRedisClient } = await import('../redis/redis-client.js');
    const redis = getRedisClient();
    if (!redis) return;

    const subscriber = redis.duplicate();
    await subscriber.subscribe('kms:config:invalidate', (tenantId: string) => {
      this.evictTenant(tenantId);
      log.debug('L1 KMS cache evicted via Pub/Sub', { tenantId });
    });
  } catch {
    log.warn('KMS cache invalidation subscription failed');
  }
}
```

**Step 2: Publish after materialization in kms-admin.ts**

After `await materializer.materialize(tenantId)`:

```typescript
const resolver = new KMSResolver();
resolver.evictTenant(tenantId); // Local pod
await resolver.publishInvalidation(tenantId); // All pods
```

**Step 3: Subscribe at startup in server.ts**

After pool init:

```typescript
const { KMSResolver } = await import('./services/kms/kms-resolver.js');
const kmsResolver = new KMSResolver();
await kmsResolver.subscribeInvalidation();
```

**Step 4: Build and test**

---

### Task 23: Concurrent DEK acquire deduplication

**Why:** Two concurrent requests for the same epoch both miss cache → double `generateDataKey()` → wasted KMS API calls + cost.

**Files:**

- Modify: `apps/runtime/src/services/kms/dek-manager.ts`

**Step 1: Add inflight tracking to DEKManager**

```typescript
export class DEKManager {
  private cache = new DEKCache();
  private resolver: KMSResolver;
  private inflight = new Map<string, Promise<AcquiredDEK>>();

  // ...

  async acquireDEK(
    scope: DEKScope,
    kekKeyId: string,
    epochIntervalHours: number,
    maxUsageCount: number,
  ): Promise<AcquiredDEK> {
    const epoch = DEKManager.calculateEpoch(Date.now(), epochIntervalHours);
    const inflightKey = `${scope.tenantId}:${scope.projectId}:${scope.environment}:${epoch}`;

    // Check cache
    const cached = this.cache.get(scope, epoch);
    if (cached) return { plaintext: cached, epoch, kekKeyId, kekKeyVersion: 1 };

    // Check inflight
    const existing = this.inflight.get(inflightKey);
    if (existing) return existing;

    // Start acquire and track it
    const promise = this._doAcquireDEK(scope, kekKeyId, epoch, epochIntervalHours, maxUsageCount)
      .finally(() => this.inflight.delete(inflightKey));
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  private async _doAcquireDEK(...): Promise<AcquiredDEK> {
    // Move existing acquireDEK logic here
  }
}
```

**Step 2: Build and test**

---

### Task 24: Security tests

**Files:**

- Create: `apps/runtime/src/__tests__/kms-security.test.ts` (new)

**Step 1: Write tests for:**

- Cross-tenant DEK isolation: Tenant A cannot unwrap Tenant B's DEKs
- Permission check: Non-admin user calling `/kms/config` gets 403
- Credential redaction: Error messages don't leak auth credentials
- Provider validation: Invalid AWS credentials rejected before save

**Step 2: Run tests**

---

## Deployment Sequence

**Critical: Wrong order can cause data loss.**

1. **Deploy Phase 0 + Phase 1** — encryption hardening + async pbkdf2 + resolver injection point. No behavior change. Verify existing data decrypts.
2. **Deploy Phase 2** — KMS Provider Pool + registry. Pool is initialized but only local provider used. `getPlatformKMSProvider()` backward compat active.
3. **Deploy Phase 3** — Wire pool into consumers. dek-manager, reencryption-queue, rotation job use pool. Encryption plugin v2 uses injected resolver. All tenants still resolve to `local` (no tenant configs exist yet).
4. **Deploy Phase 4** — Config model fields, admin validation, Studio UI updates, dead env var cleanup.
5. **Enable per-tenant KMS** — Admin configures AWS/Azure/GCP for specific tenant. New encryptions use tenant-specific provider. Existing v1/v2 data still decrypts via stored `kmsKeyId` + legacy fallback.
6. **Deploy Phase 5** — Redis cache invalidation, concurrent dedup, security tests.

---

## Verification Checklist

After all tasks complete:

- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — all existing tests pass
- [ ] New tests pass: bulk-ops, serialization, provider-pool
- [ ] `grep -r "console.warn\|console.log" packages/database/src/mongo/plugins/encryption.plugin.ts` — no hits
- [ ] `grep -r "getPlatformKMSProvider" apps/runtime/src/services/kms/` — no hits (all replaced with pool)
- [ ] `grep -r "KMS_PROVIDER\|KMS_REGION\|KMS_KEY_ID\|KMS_VAULT_URL" apps/runtime/src/config/` — no hits
- [ ] Health endpoint returns correct tenant-specific provider type
- [ ] KMS rotation job reads per-tenant `dekRetentionDays` from DB
- [ ] Re-encryption queue reads per-tenant concurrency/batch from DB
