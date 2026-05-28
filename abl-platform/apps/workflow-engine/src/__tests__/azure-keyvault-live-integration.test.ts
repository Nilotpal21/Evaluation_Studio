/**
 * Azure Key Vault — Live Integration (workflow-engine deploy context)
 *
 * Exercises the full AzureKeyVaultProvider generate → wrap → unwrap cycle
 * against a real Azure Key Vault instance. Skipped in CI unless the
 * AZURE_KV_TEST_* env vars are set.
 *
 * Required env vars to enable:
 *   AZURE_KV_TEST_VAULT_URL  — e.g. https://my-vault.vault.azure.net
 *   AZURE_KV_TEST_KEY_NAME   — RSA-HSM KEK name in the vault
 *   AZURE_TENANT_ID          — Service principal tenant
 *   AZURE_CLIENT_ID          — Service principal client ID
 *   AZURE_CLIENT_SECRET      — Service principal secret
 *
 * Without all five vars this suite is skipped automatically.
 *
 * Run manually:
 *   AZURE_KV_TEST_VAULT_URL=... AZURE_KV_TEST_KEY_NAME=... \
 *   AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=... \
 *   pnpm --filter=@agent-platform/workflow-engine test azure-keyvault-live
 *
 * @see apps/workflow-engine/src/__tests__/azure-kms-dep-resolution.test.ts
 * @see packages/database/src/__tests__/kms-azure-dep-resolution.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { KMSProvider } from '@agent-platform/database/kms';

const VAULT_URL = process.env.AZURE_KV_TEST_VAULT_URL;
const KEY_NAME = process.env.AZURE_KV_TEST_KEY_NAME;
const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;

const LIVE_CREDS_PRESENT = !!(VAULT_URL && KEY_NAME && TENANT_ID && CLIENT_ID && CLIENT_SECRET);

describe.skipIf(!LIVE_CREDS_PRESENT)(
  'AzureKeyVaultProvider live integration (workflow-engine deploy context)',
  () => {
    let provider: KMSProvider | null = null;

    const getProvider = async (): Promise<KMSProvider> => {
      if (provider) return provider;
      // Use the exported factory — exercises the same dynamic-import path as production
      const { createKMSProvider } = await import('@agent-platform/database/kms');
      provider = await createKMSProvider({
        providerType: 'azure-keyvault',
        vaultUrl: VAULT_URL!,
        keyName: KEY_NAME!,
        tenantId: TENANT_ID!,
        clientId: CLIENT_ID!,
        clientSecret: CLIENT_SECRET!,
      });
      await provider.initialize();
      return provider;
    };

    afterAll(async () => {
      if (provider) await provider.shutdown().catch(() => {});
      provider = null;
    });

    it('health check returns healthy against real vault', async () => {
      const p = await getProvider();
      const health = await p.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.providerType).toBe('azure-keyvault');
      expect(health.latencyMs).toBeGreaterThan(0);
    });

    it('generateDataKey → unwrapKey round-trip recovers original plaintext', async () => {
      const p = await getProvider();
      const { plaintext, ciphertext, keyVersionId } = await p.generateDataKey(KEY_NAME!);

      expect(plaintext).toBeInstanceOf(Buffer);
      expect(plaintext.length).toBe(32);
      expect(ciphertext).toBeInstanceOf(Buffer);
      expect(ciphertext.length).toBeGreaterThan(0);

      const recovered = await p.unwrapKey(KEY_NAME!, ciphertext, 1, keyVersionId);
      expect(recovered).toBeInstanceOf(Buffer);
      expect(recovered.equals(plaintext)).toBe(true);
    });

    it('wrapKey → unwrapKey round-trip with arbitrary 32-byte key', async () => {
      const p = await getProvider();
      const { randomBytes } = await import('node:crypto');

      const testKey = randomBytes(32);
      const { ciphertext, keyVersionId } = await p.wrapKey(KEY_NAME!, testKey);

      expect(ciphertext).toBeInstanceOf(Buffer);
      const recovered = await p.unwrapKey(KEY_NAME!, ciphertext, 1, keyVersionId);
      expect(recovered.equals(testKey)).toBe(true);
    });
  },
);
