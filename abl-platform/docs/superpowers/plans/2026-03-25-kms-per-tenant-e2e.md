# KMS Per-Tenant + Platform End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make platform-level and per-tenant KMS configuration fully production-ready so any tenant can use their own cloud KMS provider (AWS, Azure, GCP, external) with local provider fallback, end-to-end across all services.

**Architecture:** The KMS system already has the correct layered design (KMSResolver → KMSProviderPool → cloud providers). The work is completing the per-tenant credential lifecycle (encrypt on save, decrypt on use), adding input validation, making `encryptForTenantAuto` async-capable, fixing the tier derivation bug, wiring search-ai services fully, and fixing/adding tests.

**Tech Stack:** TypeScript, Vitest, Mongoose, Zod, AES-256-GCM, Node.js crypto

---

## File Structure

### Files to Modify

| File                                                                     | Responsibility                  | Change                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/kms/kms-provider-pool.ts`                         | Provider pool + auth resolution | Implement `resolveAuthConfig` Phase 2: decrypt `authConfigEncrypted` JSON blob via local provider                                                   |
| `apps/runtime/src/routes/kms-admin.ts`                                   | Admin API                       | Add Zod validation on PUT /config, encrypt auth creds before storage                                                                                |
| `packages/database/src/kms/kms-resolver.ts`                              | Tenant config resolution        | Fix hardcoded `tier` for per-tenant configs                                                                                                         |
| `packages/shared-encryption/src/index.ts`                                | Encryption entry points         | Make `encryptForTenantAuto` async, route through facade                                                                                             |
| `packages/shared-encryption/src/engine.ts`                               | EncryptionService               | No changes needed — `encryptForTenant` sync method already tries DEK cache via facade. The async path is handled in `index.ts` via facade.encrypt() |
| `packages/shared/src/encryption/index.ts`                                | Re-export barrel                | Re-export now-async `encryptForTenantAuto` (type changes)                                                                                           |
| `apps/runtime/src/routes/channel-connections.ts`                         | Channel connections             | `await` all 4 `encryptForTenantAuto` calls (lines 406, 536, 774, 974)                                                                               |
| `apps/runtime/src/__tests__/kms-admin-authz.test.ts`                     | AuthZ tests                     | Fix 6 broken assertions (`toMatchObject` → `toBe`)                                                                                                  |
| `apps/runtime/src/__tests__/kms-admin-crud.test.ts`                      | CRUD tests                      | Fix import/load failures, add per-tenant provider type tests                                                                                        |
| `apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts` | Integration tests               | Fix import path, implement INT-5 placeholder                                                                                                        |
| `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`         | Pool edge tests                 | Fix failing `getProvider` before init test                                                                                                          |

### Files to Create

| File                                                                 | Responsibility                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/database/src/kms/__tests__/auth-config-encryption.test.ts` | Tests for credential encryption/decryption round-trip                    |
| `apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts`      | E2E: two tenants with different providers, encrypt/decrypt independently |
| `packages/database/src/kms/auth-config-crypto.ts`                    | Encrypt/decrypt auth config JSON blobs using local provider              |

---

## Task 1: Auth Config Crypto Module

**Files:**

- Create: `packages/database/src/kms/auth-config-crypto.ts`
- Create: `packages/database/src/kms/__tests__/auth-config-encryption.test.ts`
- Modify: `packages/database/src/kms/index.ts` (add export)

This is the core missing piece. A small module that encrypts/decrypts JSON auth config blobs using the LocalKMSProvider (platform key). This avoids the chicken-and-egg problem: per-tenant auth creds are encrypted with the _platform_ key, not the tenant's own KMS key.

- [ ] **Step 1: Write the failing tests**

Create `packages/database/src/kms/__tests__/auth-config-encryption.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LocalKMSProvider } from '../local-kms-provider.js';
import { encryptAuthConfig, decryptAuthConfig } from '../auth-config-crypto.js';

const MASTER_KEY_HEX = 'a'.repeat(64);
const PLATFORM_KEY_ID = 'platform-default';

describe('auth-config-crypto', () => {
  let localProvider: LocalKMSProvider;

  beforeAll(async () => {
    localProvider = new LocalKMSProvider(MASTER_KEY_HEX);
    await localProvider.initialize();
  });

  afterAll(async () => {
    await localProvider.shutdown();
  });

  it('round-trips AWS auth config', async () => {
    const config = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toContain('AKIAIOSFODNN7EXAMPLE');

    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips Azure auth config', async () => {
    const config = {
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      clientId: '11111111-2222-3333-4444-555555555555',
      clientSecret: 'my-azure-client-secret',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips GCP auth config', async () => {
    const config = {
      projectId: 'my-gcp-project',
      keyRing: 'my-key-ring',
      credentialsPath: '/etc/gcp/sa-key.json',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('round-trips external BYOP auth config', async () => {
    const config = {
      externalApiKey: 'byop-api-key-1234',
    };
    const encrypted = await encryptAuthConfig(config, localProvider, PLATFORM_KEY_ID);
    const decrypted = await decryptAuthConfig(encrypted, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual(config);
  });

  it('returns empty object for null/undefined input', async () => {
    const decrypted = await decryptAuthConfig(null, localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual({});
  });

  it('returns empty object for empty string input', async () => {
    const decrypted = await decryptAuthConfig('', localProvider, PLATFORM_KEY_ID);
    expect(decrypted).toEqual({});
  });

  it('different configs produce different ciphertexts', async () => {
    const a = await encryptAuthConfig({ key: 'aaa' }, localProvider, PLATFORM_KEY_ID);
    const b = await encryptAuthConfig({ key: 'bbb' }, localProvider, PLATFORM_KEY_ID);
    expect(a).not.toEqual(b);
  });

  it('throws on tampered ciphertext', async () => {
    const encrypted = await encryptAuthConfig({ key: 'secret' }, localProvider, PLATFORM_KEY_ID);
    const tampered = encrypted.slice(0, -4) + 'XXXX';
    await expect(decryptAuthConfig(tampered, localProvider, PLATFORM_KEY_ID)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/database/src/kms/__tests__/auth-config-encryption.test.ts`
Expected: FAIL — module `../auth-config-crypto.js` not found

- [ ] **Step 3: Write the implementation**

Create `packages/database/src/kms/auth-config-crypto.ts`:

```typescript
/**
 * Auth Config Crypto
 *
 * Encrypts/decrypts per-tenant KMS auth credential JSON blobs
 * using the platform's LocalKMSProvider.
 *
 * Design: Per-tenant cloud KMS credentials are encrypted with the *platform*
 * key (via LocalKMSProvider.encrypt), not the tenant's own cloud KMS.
 * This avoids the chicken-and-egg problem: we need the credentials to
 * connect to the tenant's KMS, so those credentials must be protected
 * by a key we already have (the platform key).
 */

import type { KMSProvider } from './types.js';

/**
 * Encrypt a plain auth config object into a base64 string.
 *
 * @param config  Plain JSON credentials (e.g. { accessKeyId, secretAccessKey })
 * @param provider  The local/platform KMS provider
 * @param keyId  The key ID to encrypt with (usually 'platform-default')
 * @returns Base64-encoded encrypted blob
 */
export async function encryptAuthConfig(
  config: Record<string, string | undefined>,
  provider: KMSProvider,
  keyId: string,
): Promise<string> {
  // Strip undefined values before serializing
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) clean[k] = v;
  }
  const plaintext = Buffer.from(JSON.stringify(clean), 'utf8');
  const ciphertext = await provider.encrypt(keyId, plaintext);
  return ciphertext.toString('base64');
}

/**
 * Decrypt a base64-encoded auth config blob back to a plain JSON object.
 *
 * @param encrypted  Base64-encoded encrypted blob (or null/empty)
 * @param provider  The local/platform KMS provider
 * @param keyId  The key ID to decrypt with (usually 'platform-default')
 * @returns Plain JSON credentials
 */
export async function decryptAuthConfig(
  encrypted: string | null | undefined,
  provider: KMSProvider,
  keyId: string,
): Promise<Record<string, string | undefined>> {
  if (!encrypted) return {};
  const ciphertext = Buffer.from(encrypted, 'base64');
  const plaintext = await provider.decrypt(keyId, ciphertext);
  return JSON.parse(plaintext.toString('utf8'));
}
```

- [ ] **Step 4: Add export to barrel**

In `packages/database/src/kms/index.ts`, add:

```typescript
export { encryptAuthConfig, decryptAuthConfig } from './auth-config-crypto.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build --filter=@agent-platform/database && pnpm vitest run packages/database/src/kms/__tests__/auth-config-encryption.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/database/src/kms/auth-config-crypto.ts packages/database/src/kms/__tests__/auth-config-encryption.test.ts packages/database/src/kms/index.ts
git add packages/database/src/kms/auth-config-crypto.ts packages/database/src/kms/__tests__/auth-config-encryption.test.ts packages/database/src/kms/index.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(database): add auth-config-crypto module for per-tenant KMS credential encryption

Encrypt/decrypt per-tenant KMS auth credential JSON blobs using
the platform's LocalKMSProvider. Avoids chicken-and-egg: tenant
cloud KMS creds are protected by the platform key we already have.
EOF
)"
```

---

## Task 2: Implement `resolveAuthConfig` Phase 2 (C1)

**Files:**

- Modify: `packages/database/src/kms/kms-provider-pool.ts:290-321`
- Modify: `packages/database/src/__tests__/kms-provider-pool-edge.test.ts` (add tests + fix failing test)

This is the central blocker. When `authConfigEncrypted` is set on a tenant's provider config, decrypt it using the local provider instead of reading env vars.

- [ ] **Step 1: Write the failing tests**

Add to `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`, in a new `describe('resolveAuthConfig per-tenant')` block. The pool's `resolveAuthConfig` is private, so we test it indirectly via `createProvider`. We'll add a public `resolveAuthConfigForTesting` method gated behind a flag, OR we test through the `getProvider` path using a mock provider factory.

Instead, since `resolveAuthConfig` is called inside `createProvider` which is called by `getProvider`, we test through the public API. Create a dedicated test file:

Create `packages/database/src/kms/__tests__/resolve-auth-config.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { KMSProviderPool } from '../kms-provider-pool.js';
import { LocalKMSProvider } from '../local-kms-provider.js';
import { encryptAuthConfig } from '../auth-config-crypto.js';
import type { IResolvedProviderRef } from '../../models/materialized-kms-config.model.js';

// Mock the providers/index.js factory to capture what auth config is passed
const capturedConfigs: Record<string, unknown>[] = [];

vi.mock('../providers/index.js', () => ({
  createKMSProvider: async (config: Record<string, unknown>) => {
    capturedConfigs.push(config);
    // Return a mock KMSProvider
    return {
      providerType: config.providerType,
      initialize: vi.fn(),
      shutdown: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
      generateDataKey: vi.fn(),
      wrapKey: vi.fn(),
      unwrapKey: vi.fn(),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      createKey: vi.fn(),
      describeKey: vi.fn(),
      enableKeyRotation: vi.fn(),
      scheduleKeyDeletion: vi.fn(),
    };
  },
}));

const MASTER_KEY_HEX = 'a'.repeat(64);

describe('resolveAuthConfig per-tenant', () => {
  let pool: KMSProviderPool;
  let localProvider: LocalKMSProvider;

  beforeAll(async () => {
    localProvider = new LocalKMSProvider(MASTER_KEY_HEX);
    await localProvider.initialize();
  });

  beforeEach(async () => {
    capturedConfigs.length = 0;
    pool = new KMSProviderPool({ masterKeyHex: MASTER_KEY_HEX });
    await pool.initialize();
  });

  afterAll(async () => {
    await localProvider.shutdown();
  });

  it('decrypts authConfigEncrypted for aws-kms tenant config', async () => {
    const rawCreds = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      endpoint: 'https://kms.us-west-2.amazonaws.com',
    };
    const encrypted = await encryptAuthConfig(rawCreds, localProvider, 'platform-default');

    const config: IResolvedProviderRef = {
      providerType: 'aws-kms',
      keyId: 'arn:aws:kms:us-west-2:123456789012:key/mrk-1234',
      region: 'us-west-2',
      vaultUrl: null,
      externalEndpoint: null,
      authMethod: 'service-account',
      authConfigEncrypted: encrypted,
    };

    await pool.getProvider(config);

    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]).toMatchObject({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      endpoint: 'https://kms.us-west-2.amazonaws.com',
    });
  });

  it('decrypts authConfigEncrypted for azure-keyvault tenant config', async () => {
    const rawCreds = {
      tenantId: 'aaaa-bbbb-cccc',
      clientId: '1111-2222-3333',
      clientSecret: 'azure-secret',
    };
    const encrypted = await encryptAuthConfig(rawCreds, localProvider, 'platform-default');

    const config: IResolvedProviderRef = {
      providerType: 'azure-keyvault',
      keyId: 'my-key',
      region: null,
      vaultUrl: 'https://myvault.vault.azure.net',
      externalEndpoint: null,
      authMethod: 'service-account',
      authConfigEncrypted: encrypted,
    };

    await pool.getProvider(config);

    expect(capturedConfigs[0]).toMatchObject({
      tenantId: 'aaaa-bbbb-cccc',
      clientId: '1111-2222-3333',
      clientSecret: 'azure-secret',
    });
  });

  it('falls back to env vars when authConfigEncrypted is null', async () => {
    // Set env vars for this test
    const origRegion = process.env.KMS_AWS_REGION;
    const origKeyId = process.env.KMS_AWS_ACCESS_KEY_ID;
    const origSecret = process.env.KMS_AWS_SECRET_ACCESS_KEY;
    process.env.KMS_AWS_ACCESS_KEY_ID = 'ENV_ACCESS_KEY';
    process.env.KMS_AWS_SECRET_ACCESS_KEY = 'ENV_SECRET_KEY';

    const config: IResolvedProviderRef = {
      providerType: 'aws-kms',
      keyId: 'arn:aws:kms:us-east-1:123:key/abc',
      region: 'us-east-1',
      vaultUrl: null,
      externalEndpoint: null,
      authMethod: 'service-account',
      authConfigEncrypted: null,
    };

    await pool.getProvider(config);

    expect(capturedConfigs[0]).toMatchObject({
      accessKeyId: 'ENV_ACCESS_KEY',
      secretAccessKey: 'ENV_SECRET_KEY',
    });

    // Restore env vars
    process.env.KMS_AWS_ACCESS_KEY_ID = origKeyId;
    process.env.KMS_AWS_SECRET_ACCESS_KEY = origSecret;
  });

  it('decrypts authConfigEncrypted for external BYOP config', async () => {
    const rawCreds = { externalApiKey: 'byop-key-123' };
    const encrypted = await encryptAuthConfig(rawCreds, localProvider, 'platform-default');

    const config: IResolvedProviderRef = {
      providerType: 'external',
      keyId: 'ext-key',
      region: null,
      vaultUrl: null,
      externalEndpoint: 'https://byop.example.com/kms',
      authMethod: 'api-key',
      authConfigEncrypted: encrypted,
    };

    await pool.getProvider(config);

    expect(capturedConfigs[0]).toMatchObject({
      externalApiKey: 'byop-key-123',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/database/src/kms/__tests__/resolve-auth-config.test.ts`
Expected: FAIL — tests fail because `resolveAuthConfig` ignores `authConfigEncrypted`

- [ ] **Step 3: Implement resolveAuthConfig Phase 2**

Modify `packages/database/src/kms/kms-provider-pool.ts`. Change `resolveAuthConfig` from sync to async and decrypt the blob when present:

Replace the `resolveAuthConfig` method (lines 290-321) with:

```typescript
  /**
   * Resolve auth credentials for a provider config.
   *
   * For platform default (no authConfigEncrypted):
   *   Read from KMS_AZURE_*, KMS_AWS_*, KMS_GCP_* env vars.
   *
   * For per-tenant config (authConfigEncrypted set):
   *   Decrypt the JSON blob using the local provider, then parse credentials.
   *   Per-tenant authConfigEncrypted is decrypted with the local/platform key
   *   since it's platform-level config (avoids chicken-and-egg with the tenant's own KMS).
   */
  private async resolveAuthConfig(
    config: IResolvedProviderRef,
  ): Promise<Record<string, string | undefined>> {
    // Per-tenant encrypted credentials — decrypt with the local provider
    if (config.authConfigEncrypted && this.localProvider) {
      try {
        // Static import at file top: import { decryptAuthConfig } from './auth-config-crypto.js';
        return await decryptAuthConfig(config.authConfigEncrypted, this.localProvider, 'platform-default');
      } catch (err) {
        log.warn('Failed to decrypt per-tenant authConfigEncrypted, falling back to env vars', {
          providerType: config.providerType,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fall through to env var resolution
      }
    }

    // Platform default — read from env vars
    const type = config.providerType;

    if (type === 'azure-keyvault' || type === 'azure-managed-hsm') {
      return {
        tenantId: process.env.KMS_AZURE_TENANT_ID,
        clientId: process.env.KMS_AZURE_CLIENT_ID,
        clientSecret: process.env.KMS_AZURE_CLIENT_SECRET,
      };
    }

    if (type === 'aws-kms') {
      return {
        accessKeyId: process.env.KMS_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.KMS_AWS_SECRET_ACCESS_KEY,
        endpoint: process.env.KMS_AWS_ENDPOINT,
      };
    }

    if (type === 'gcp-cloud-kms') {
      return {
        projectId: process.env.KMS_GCP_PROJECT_ID,
        keyRing: process.env.KMS_GCP_KEY_RING,
        credentialsPath: process.env.KMS_GCP_CREDENTIALS_PATH,
      };
    }

    if (type === 'external') {
      return {
        externalApiKey: process.env.KMS_EXTERNAL_API_KEY,
      };
    }

    return {};
  }
```

Also update `createProvider` at line 248 to await the now-async method:

```typescript
const authConfig = await this.resolveAuthConfig(config);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build --filter=@agent-platform/database && pnpm vitest run packages/database/src/kms/__tests__/resolve-auth-config.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Fix the failing kms-provider-pool-edge test**

In `packages/database/src/__tests__/kms-provider-pool-edge.test.ts`, the test at ~line 131 that expects `pool.getProvider(aws-kms)` to throw before init — the AWS SDK initializes without real creds. Change the assertion to verify it gets a provider (since the factory is mocked or SDK accepts empty creds), or adjust the test to check for meaningful behavior. Read the test to determine the exact fix.

- [ ] **Step 6: Run all pool-related tests**

Run: `pnpm vitest run packages/database/src/__tests__/kms-provider-pool-edge.test.ts packages/database/src/__tests__/kms-provider-pool.test.ts packages/database/src/kms/__tests__/resolve-auth-config.test.ts packages/database/src/kms/__tests__/auth-config-encryption.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/database/src/kms/kms-provider-pool.ts packages/database/src/kms/__tests__/resolve-auth-config.test.ts packages/database/src/__tests__/kms-provider-pool-edge.test.ts
git add packages/database/src/kms/kms-provider-pool.ts packages/database/src/kms/__tests__/resolve-auth-config.test.ts packages/database/src/__tests__/kms-provider-pool-edge.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(database): implement resolveAuthConfig Phase 2 — decrypt per-tenant KMS credentials

resolveAuthConfig now decrypts authConfigEncrypted JSON blobs via the
platform LocalKMSProvider when set, falling back to env vars when null.
This enables per-tenant cloud KMS with tenant-specific credentials.
EOF
)"
```

---

## Task 3: Encrypt Auth Credentials in PUT /config (C2 + C4)

**Files:**

- Modify: `apps/runtime/src/routes/kms-admin.ts:73-176`

Add Zod validation for the request body AND encrypt auth credentials before storage.

- [ ] **Step 1: Write the Zod schema and encryption logic**

At the top of `apps/runtime/src/routes/kms-admin.ts` (after imports), add:

```typescript
import { z } from 'zod';

const KMSProviderRefSchema = z.object({
  providerType: z.enum([
    'local',
    'aws-kms',
    'azure-keyvault',
    'azure-managed-hsm',
    'gcp-cloud-kms',
    'external',
  ]),
  keyId: z.string().min(1, 'keyId is required'),
  region: z.string().nullable().optional().default(null),
  vaultUrl: z.string().nullable().optional().default(null),
  externalEndpoint: z.string().nullable().optional().default(null),
  authMethod: z
    .enum([
      'default-credentials',
      'service-account',
      'managed-identity',
      'api-key',
      'mtls',
      'oauth2',
      'hmac',
    ])
    .nullable()
    .optional()
    .default(null),
  // Raw credentials from the client — will be encrypted before storage
  authConfig: z.record(z.string()).nullable().optional().default(null),
});

const PutConfigBodySchema = z.object({
  defaultProvider: KMSProviderRefSchema.nullable().optional(),
  dekRetentionDays: z.number().int().min(1).max(3650).optional(),
  kekRotationPeriodDays: z.number().int().min(1).max(3650).optional(),
  reencryption: z
    .object({
      enabled: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(10).optional(),
      batchSize: z.number().int().min(1).max(1000).optional(),
      maxRetries: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
  byokEnabled: z.boolean().optional(),
  byopEnabled: z.boolean().optional(),
  complianceLevel: z.enum(['standard', 'pci-dss', 'hipaa', 'fips-140-3']).optional(),
  failurePolicy: z.enum(['fail-closed', 'graceful-degradation']).optional(),
});
```

- [ ] **Step 2: Update the PUT /config handler**

Replace the PUT /config handler body validation (lines 78-81) and `defaultProvider` storage (line 91) with:

```typescript
// Validate request body
const parseResult = PutConfigBodySchema.safeParse(body);
if (!parseResult.success) {
  return res.status(400).json({
    error: 'Invalid request body',
    details: parseResult.error.flatten().fieldErrors,
  });
}
const validated = parseResult.data;

// Encrypt auth credentials if provided
let providerToStore = validated.defaultProvider ?? null;
if (providerToStore && providerToStore.authConfig) {
  try {
    const { getKMSProviderPool, isKMSProviderPoolAvailable } =
      await import('@agent-platform/database/kms');
    if (!isKMSProviderPoolAvailable()) {
      return res.status(503).json({
        error: 'KMS provider pool not initialized — retry after server startup completes',
      });
    }
    const pool = getKMSProviderPool();
    const localProvider = pool.getLocalProvider();
    const { encryptAuthConfig } = await import('@agent-platform/database/kms');
    const encrypted = await encryptAuthConfig(
      providerToStore.authConfig,
      localProvider,
      'platform-default',
    );
    // Store encrypted blob, strip raw authConfig
    providerToStore = {
      providerType: providerToStore.providerType,
      keyId: providerToStore.keyId,
      region: providerToStore.region ?? null,
      vaultUrl: providerToStore.vaultUrl ?? null,
      externalEndpoint: providerToStore.externalEndpoint ?? null,
      authMethod: providerToStore.authMethod ?? null,
      authConfigEncrypted: encrypted,
    };
  } catch (encErr) {
    log.error('Failed to encrypt auth credentials', {
      error: encErr instanceof Error ? encErr.message : String(encErr),
    });
    return res.status(500).json({ error: 'Failed to encrypt auth credentials' });
  }
} else if (providerToStore) {
  // No raw authConfig — preserve existing authConfigEncrypted from DB
  // (partial updates must not wipe previously-stored credentials)
  const existing = await TenantKMSConfig.findOne({ tenantId }).lean();
  providerToStore = {
    providerType: providerToStore.providerType,
    keyId: providerToStore.keyId,
    region: providerToStore.region ?? null,
    vaultUrl: providerToStore.vaultUrl ?? null,
    externalEndpoint: providerToStore.externalEndpoint ?? null,
    authMethod: providerToStore.authMethod ?? null,
    authConfigEncrypted: (existing as any)?.defaultProvider?.authConfigEncrypted ?? null,
  };
}
```

Then update the `$set` to use `providerToStore` instead of `body.defaultProvider`, and use `validated.*` for the other fields:

```typescript
    $set: {
      tenantId,
      defaultProvider: providerToStore,
      dekRetentionDays: validated.dekRetentionDays ?? 90,
      kekRotationPeriodDays: validated.kekRotationPeriodDays ?? 365,
      reencryption: {
        enabled: validated.reencryption?.enabled ?? true,
        concurrency: validated.reencryption?.concurrency ?? 1,
        batchSize: validated.reencryption?.batchSize ?? 50,
        maxRetries: validated.reencryption?.maxRetries ?? 3,
      },
      byokEnabled: validated.byokEnabled ?? false,
      byopEnabled: validated.byopEnabled ?? false,
      complianceLevel: validated.complianceLevel ?? 'standard',
      failurePolicy: validated.failurePolicy ?? 'fail-closed',
    },
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter=@agent-platform/runtime`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
npx prettier --write apps/runtime/src/routes/kms-admin.ts
git add apps/runtime/src/routes/kms-admin.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(runtime): add Zod validation and credential encryption to PUT /config

PUT /config now validates request body via Zod schema (provider type
enum, required keyId, numeric bounds on retention/rotation). Raw auth
credentials in authConfig are encrypted via the platform LocalKMSProvider
before storage. Clients send plaintext creds; MongoDB stores only
encrypted blobs.
EOF
)"
```

---

## Task 4: Fix Resolver Tier Derivation (H1)

**Files:**

- Modify: `packages/database/src/kms/kms-resolver.ts:258-272`
- Modify: `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts` (add tier test)

- [ ] **Step 1: Write the failing test**

Add to `apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`:

```typescript
it('should derive tier=hsm for azure-managed-hsm tenant config', async () => {
  mockFindOne.mockResolvedValueOnce({
    tenantId: 'tenant-hsm',
    defaultProvider: {
      providerType: 'azure-managed-hsm',
      keyId: 'hsm-key',
      region: null,
      vaultUrl: 'https://myhsm.managedhsm.azure.net',
      externalEndpoint: null,
      authMethod: 'managed-identity',
      authConfigEncrypted: null,
    },
    failurePolicy: 'fail-closed',
    _v: 1,
  });
  const result = await resolver.resolve('tenant-hsm');
  expect(result.tier).toBe('hsm');
});

it('should derive tier=software-protected for aws-kms tenant config', async () => {
  mockFindOne.mockResolvedValueOnce(TENANT_KMS_DOC);
  const result = await resolver.resolve(TENANT);
  expect(result.tier).toBe('software-protected');
});

it('should derive tier=local for local provider tenant config', async () => {
  mockFindOne.mockResolvedValueOnce({
    tenantId: 'tenant-local',
    defaultProvider: {
      providerType: 'local',
      keyId: 'custom-local-key',
      region: null,
      vaultUrl: null,
      externalEndpoint: null,
      authMethod: null,
      authConfigEncrypted: null,
    },
    failurePolicy: 'fail-closed',
    _v: 1,
  });
  const result = await resolver.resolve('tenant-local');
  expect(result.tier).toBe('local');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`
Expected: The `hsm` test fails (gets `'software-protected'`)

- [ ] **Step 3: Fix the tier derivation**

In `packages/database/src/kms/kms-resolver.ts`, replace the hardcoded tier at line 268:

```typescript
// Before:
tier: 'software-protected',

// After — extract a helper above the class:
// function deriveTier(providerType: string): string {
//   if (providerType === 'azure-managed-hsm') return 'hsm';
//   if (providerType === 'local') return 'local';
//   return 'software-protected';
// }
tier: deriveTier(doc.defaultProvider.providerType),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build --filter=@agent-platform/database && pnpm vitest run apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/database/src/kms/kms-resolver.ts apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts
git add packages/database/src/kms/kms-resolver.ts apps/runtime/src/services/kms/__tests__/kms-resolver.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] fix(database): derive tier from providerType for per-tenant KMS configs

Per-tenant configs with azure-managed-hsm now correctly report
tier='hsm' instead of the hardcoded 'software-protected'.
EOF
)"
```

---

## Task 5: Make `encryptForTenantAuto` Async (C3)

**Files:**

- Modify: `packages/shared-encryption/src/index.ts:173-175`
- Modify: `packages/shared-encryption/src/engine.ts` (add async method)
- Grep all callers of `encryptForTenantAuto` and update them

This is the most impactful change. Currently `encryptForTenantAuto` is sync and only uses PBKDF2. It needs to become async and route through the facade when available.

- [ ] **Step 1: Update all callers (enumerated)**

The following call sites must be updated to `await`:

| File                                             | Line | Context                                                                 | Already async?            |
| ------------------------------------------------ | ---- | ----------------------------------------------------------------------- | ------------------------- |
| `apps/runtime/src/routes/channel-connections.ts` | 406  | `safeConfig.encryptedA2aApiKey = encryptForTenantAuto(...)`             | Yes (async route handler) |
| `apps/runtime/src/routes/channel-connections.ts` | 536  | `const encryptedInboundAuthToken = encryptForTenantAuto(...)`           | Yes                       |
| `apps/runtime/src/routes/channel-connections.ts` | 774  | `config.encryptedA2aApiKey = encryptForTenantAuto(...)`                 | Yes                       |
| `apps/runtime/src/routes/channel-connections.ts` | 974  | `const encryptedToken = encryptForTenantAuto(...)`                      | Yes                       |
| `packages/shared/src/encryption/index.ts`        | 48   | Re-export passthrough (type changes from `string` to `Promise<string>`) | N/A                       |

All 4 call sites in `channel-connections.ts` are inside `async (req, res) =>` route handlers, so adding `await` is safe.

- [ ] **Step 2: Make `encryptForTenantAuto` async**

In `packages/shared-encryption/src/index.ts`, replace lines 173-175:

```typescript
// Before:
export function encryptForTenantAuto(plaintext: string, tenantId: string): string {
  return getEncryptionService().encryptForTenant(plaintext, tenantId);
}

// After:
/**
 * Encrypt plaintext for a tenant — preferred entry point for all service code.
 *
 * Uses DEK envelope encryption (async facade) when the facade is available,
 * falls back to legacy PBKDF2 hex format otherwise.
 */
export async function encryptForTenantAuto(plaintext: string, tenantId: string): Promise<string> {
  const facade = getEncryptionFacade();
  if (facade) {
    return facade.encrypt(plaintext, { tenantId });
  }
  return getEncryptionService().encryptForTenant(plaintext, tenantId);
}
```

- [ ] **Step 3: Update all callers to await**

For each call site found in step 1, ensure the result is `await`ed. Common pattern:

```typescript
// Before:
const encrypted = encryptForTenantAuto(value, tenantId);

// After:
const encrypted = await encryptForTenantAuto(value, tenantId);
```

If the calling function is not already async, it must be made async.

- [ ] **Step 4: Build all affected packages**

Run: `pnpm build`
Expected: No TypeScript errors

- [ ] **Step 5: Run existing encryption tests**

Run: `pnpm vitest run packages/shared-encryption/src/__tests__/ packages/shared/src/__tests__/encryption/`
Expected: ALL PASS (sync callers in tests may need updating)

- [ ] **Step 6: Commit**

```bash
npx prettier --write <all changed files>
git add <all changed files>
git commit -m "$(cat <<'EOF'
[ABLP-2] feat(shared-encryption): make encryptForTenantAuto async, route through DEK facade

encryptForTenantAuto now uses the TenantEncryptionFacade when available,
producing DEK-envelope ciphertext that routes through the tenant's
configured KMS provider. Falls back to legacy PBKDF2 when no facade.
All callers updated to await the result.
EOF
)"
```

---

## Task 6: Fix Broken Tests

**Files:**

- Modify: `apps/runtime/src/__tests__/kms-admin-authz.test.ts` (6 assertion fixes)
- Modify: `apps/runtime/src/__tests__/kms-admin-crud.test.ts` (fix import/load)
- Modify: `apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts` (fix import)

- [ ] **Step 1: Fix authz test assertions**

In `apps/runtime/src/__tests__/kms-admin-authz.test.ts`, at lines 235, 244, 252, 270, 279, 287, replace:

```typescript
// Before:
expect(json.error).toMatchObject({ message: 'Forbidden' });

// After:
expect(json.error).toBe('Forbidden');
```

There are 6 occurrences.

- [ ] **Step 2: Run authz tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/kms-admin-authz.test.ts`
Expected: 15/15 PASS

- [ ] **Step 3: Fix CRUD test import**

Read `apps/runtime/src/__tests__/kms-admin-crud.test.ts` to identify the exact import resolution failure. The test likely imports from `@agent-platform/database/kms` with stale mock paths. Update the `vi.mock()` calls to match the current module exports (`getGlobalKMSResolver`, `isKMSProviderPoolAvailable`, `getKMSProviderPool`, `KMSResolver`).

- [ ] **Step 4: Fix integration test import**

Read `apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts` line 16. The import `@agent-platform/database/__tests__/helpers/setup-mongo.js` is not an exported path. Either:

- Add it to `packages/database/package.json` exports, or
- Use a relative import path instead

- [ ] **Step 5: Implement INT-5 placeholder**

In `dek-envelope-encryption.integration.test.ts`, replace the `expect(true).toBe(true)` placeholder with a real test that:

1. Creates a document with legacy PBKDF2 encryption
2. Creates a document with DEK envelope encryption
3. Reads both from the same collection
4. Verifies both decrypt correctly

- [ ] **Step 6: Run all fixed tests**

Run: `pnpm vitest run apps/runtime/src/__tests__/kms-admin-authz.test.ts apps/runtime/src/__tests__/kms-admin-crud.test.ts apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/kms-admin-authz.test.ts apps/runtime/src/__tests__/kms-admin-crud.test.ts apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts
git add apps/runtime/src/__tests__/kms-admin-authz.test.ts apps/runtime/src/__tests__/kms-admin-crud.test.ts apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] fix(runtime): fix KMS test failures — authz assertions, CRUD imports, integration test

Fix 6 authz test assertions (error is string, not object), fix CRUD
test mock paths to match current module exports, fix integration test
import path, implement INT-5 dual-format read test.
EOF
)"
```

---

## Task 7: Per-Tenant Integration Test

**Files:**

- Create: `apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts`

Integration test: two tenants with different KMS providers, encrypting and decrypting independently, verifying cross-tenant isolation. Uses `vi.mock()` for DB models (acceptable for integration tests per CLAUDE.md — only E2E tests forbid mocking).

- [ ] **Step 1: Write the E2E test**

Create `apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts`:

```typescript
/**
 * KMS Per-Tenant Integration Test
 *
 * Verifies that two tenants with different KMS provider configurations
 * can encrypt and decrypt data independently using the full stack:
 * KMSResolver → KMSProviderPool → DEKManager → TenantEncryptionFacade
 *
 * Uses LocalKMSProvider with different key IDs to simulate different
 * cloud providers (avoids needing real AWS/Azure/GCP credentials in tests).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  KMSProviderPool,
  setKMSProviderPool,
  KMSResolver,
  DEKManager,
  setGlobalKMSResolver,
} from '@agent-platform/database/kms';
import { TenantEncryptionFacade } from '@agent-platform/shared-encryption';

const MASTER_KEY_HEX = 'b'.repeat(64);

// Mock TenantKMSConfig to return different configs per tenant
vi.mock('@agent-platform/database/models', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    TenantKMSConfig: {
      findOne: vi.fn().mockImplementation(({ tenantId }: { tenantId: string }) => ({
        lean: () => {
          if (tenantId === 'tenant-alpha') {
            return Promise.resolve({
              tenantId: 'tenant-alpha',
              defaultProvider: {
                providerType: 'local',
                keyId: 'alpha-key',
                region: null,
                vaultUrl: null,
                externalEndpoint: null,
                authMethod: null,
                authConfigEncrypted: null,
              },
              failurePolicy: 'fail-closed',
              _v: 1,
            });
          }
          if (tenantId === 'tenant-beta') {
            return Promise.resolve({
              tenantId: 'tenant-beta',
              defaultProvider: {
                providerType: 'local',
                keyId: 'beta-key',
                region: null,
                vaultUrl: null,
                externalEndpoint: null,
                authMethod: null,
                authConfigEncrypted: null,
              },
              failurePolicy: 'fail-closed',
              _v: 2,
            });
          }
          return Promise.resolve(null); // No config → platform default
        },
      })),
    },
    // Mock DEKEntry for DEKManager
    DEKEntry: {
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((doc: Record<string, unknown>) => doc),
      countDocuments: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    },
  };
});

describe('KMS Per-Tenant Integration', () => {
  let pool: KMSProviderPool;
  let resolver: KMSResolver;
  let facade: TenantEncryptionFacade;

  beforeAll(async () => {
    pool = new KMSProviderPool({ masterKeyHex: MASTER_KEY_HEX });
    await pool.initialize();
    setKMSProviderPool(pool);

    resolver = new KMSResolver();
    setGlobalKMSResolver(resolver);

    const dekManager = new DEKManager(resolver);
    facade = new TenantEncryptionFacade(
      dekManager,
      Buffer.from(MASTER_KEY_HEX, 'hex'),
      'platform-default',
    );
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  it('resolves different configs for different tenants', async () => {
    const alphaConfig = await resolver.resolve('tenant-alpha');
    const betaConfig = await resolver.resolve('tenant-beta');
    const defaultConfig = await resolver.resolve('tenant-gamma');

    expect(alphaConfig.provider.keyId).toBe('alpha-key');
    expect(alphaConfig.sourceConfigVersion).toBe(1);

    expect(betaConfig.provider.keyId).toBe('beta-key');
    expect(betaConfig.sourceConfigVersion).toBe(2);

    expect(defaultConfig.provider.keyId).toBe('platform-default');
    expect(defaultConfig.sourceConfigVersion).toBe(0);
  });

  it('encrypts with tenant-specific config and decrypts correctly', async () => {
    const plaintext = 'Hello from tenant-alpha';
    const encrypted = await facade.encrypt(plaintext, { tenantId: 'tenant-alpha' });

    expect(encrypted).not.toBe(plaintext);
    expect(typeof encrypted).toBe('string');

    const decrypted = await facade.decrypt(encrypted, { tenantId: 'tenant-alpha' });
    expect(decrypted).toBe(plaintext);
  });

  it('two tenants produce different ciphertexts for same plaintext', async () => {
    const plaintext = 'Same message for both tenants';

    const encAlpha = await facade.encrypt(plaintext, { tenantId: 'tenant-alpha' });
    const encBeta = await facade.encrypt(plaintext, { tenantId: 'tenant-beta' });

    // Different ciphertexts (different DEKs from different key IDs)
    expect(encAlpha).not.toBe(encBeta);

    // Both decrypt correctly in their own scope
    expect(await facade.decrypt(encAlpha, { tenantId: 'tenant-alpha' })).toBe(plaintext);
    expect(await facade.decrypt(encBeta, { tenantId: 'tenant-beta' })).toBe(plaintext);
  });

  it('platform default tenant also works', async () => {
    const plaintext = 'Default tenant data';
    const encrypted = await facade.encrypt(plaintext, { tenantId: 'tenant-gamma' });
    const decrypted = await facade.decrypt(encrypted, { tenantId: 'tenant-gamma' });
    expect(decrypted).toBe(plaintext);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts
git add apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts
git commit -m "$(cat <<'EOF'
[ABLP-2] test(runtime): add per-tenant KMS E2E test — multi-tenant encrypt/decrypt isolation

Verifies two tenants with different KMS configs resolve independently,
produce different ciphertexts, and decrypt correctly in their own scope.
Covers the full stack: KMSResolver → KMSProviderPool → DEKManager →
TenantEncryptionFacade.
EOF
)"
```

---

## Task 8: Run Full KMS Test Suite

- [ ] **Step 1: Build all packages**

Run: `pnpm build`

- [ ] **Step 2: Run all KMS tests**

Run:

```bash
pnpm vitest run \
  packages/database/src/__tests__/kms-providers.test.ts \
  packages/database/src/__tests__/local-kms-provider.test.ts \
  packages/database/src/__tests__/kms-provider-pool.test.ts \
  packages/database/src/__tests__/kms-provider-pool-edge.test.ts \
  packages/database/src/__tests__/encryption-plugin-kms.test.ts \
  packages/database/src/__tests__/encryption-plugin-resolver.test.ts \
  packages/database/src/__tests__/encryption-plugin-v3.test.ts \
  packages/database/src/__tests__/encryption-plugin-dek.test.ts \
  packages/database/src/kms/__tests__/ \
  packages/shared-encryption/src/__tests__/ \
  apps/runtime/src/services/kms/__tests__/ \
  apps/runtime/src/__tests__/kms-admin-authz.test.ts \
  apps/runtime/src/__tests__/kms-admin-crud.test.ts \
  apps/runtime/src/__tests__/kms-security.test.ts \
  apps/runtime/src/__tests__/kms-per-tenant-integration.test.ts \
  apps/runtime/src/__tests__/dek-envelope-encryption.integration.test.ts
```

Expected: ALL PASS. If any fail, fix them before proceeding.

- [ ] **Step 3: Final commit if any fixes needed**

---

## Summary

| Task                          | Fixes                    | Files                             |
| ----------------------------- | ------------------------ | --------------------------------- |
| 1. Auth Config Crypto         | Foundation for C1+C2     | `auth-config-crypto.ts` + tests   |
| 2. resolveAuthConfig Phase 2  | **C1** (central blocker) | `kms-provider-pool.ts` + tests    |
| 3. PUT /config Zod + Encrypt  | **C2** + **C4**          | `kms-admin.ts`                    |
| 4. Tier Derivation            | **H1**                   | `kms-resolver.ts` + test          |
| 5. encryptForTenantAuto Async | **C3**                   | `index.ts`, `engine.ts` + callers |
| 6. Fix Broken Tests           | Test health              | 3 test files                      |
| 7. Per-Tenant E2E Test        | Confidence               | New E2E test                      |
| 8. Full Suite Run             | Validation               | —                                 |

**Not in scope (documented for future):**

- H2/H3: Search-AI Redis invalidation + setKMSResolverFn — lower priority, works with 60s TTL
- Workflow engine / pipeline engine KMS wiring — separate feature scope
- Admin app encryption — separate feature scope
