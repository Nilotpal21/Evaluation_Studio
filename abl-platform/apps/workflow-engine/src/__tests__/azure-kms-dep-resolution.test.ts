/**
 * Azure KMS Dependency Resolution — workflow-engine deploy context
 *
 * packages/database declares @azure/identity and @azure/keyvault-keys as
 * optionalDependencies. pnpm deploy --prod (run from the workflow-engine
 * Dockerfile) drops transitive optionals, so workflow-engine must declare
 * them as direct dependencies.
 *
 * This test runs inside the workflow-engine package so it fails if those
 * direct declarations are ever removed. The database-package equivalent
 * (kms-azure-dep-resolution.test.ts) does not catch that regression because
 * it executes in a context where optionals are always present.
 *
 * @see apps/workflow-engine/package.json — @azure/identity, @azure/keyvault-keys
 * @see packages/database/src/__tests__/kms-azure-dep-resolution.test.ts
 */
import { describe, it, expect } from 'vitest';

describe('Azure KMS dependency resolution (workflow-engine deploy context)', () => {
  it('@azure/keyvault-keys is resolvable via dynamic import', async () => {
    const mod = await import('@azure/keyvault-keys');
    expect(mod.KeyClient).toBeDefined();
    expect(mod.CryptographyClient).toBeDefined();
  });

  it('@azure/identity is resolvable via dynamic import', async () => {
    const mod = await import('@azure/identity');
    expect(mod.DefaultAzureCredential).toBeDefined();
    expect(mod.ClientSecretCredential).toBeDefined();
  });
});
