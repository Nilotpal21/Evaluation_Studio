/**
 * Azure KMS Dependency Resolution Test
 *
 * Validates that @azure/identity and @azure/keyvault-keys are resolvable
 * at runtime. The Azure KMS provider lazy-loads these packages via dynamic
 * import() — if they're not installed in the consuming app's node_modules,
 * initialization fails with "Cannot find package '@azure/keyvault-keys'".
 *
 * This test catches the scenario where the packages are declared as optional
 * peerDependencies but not installed by any consuming app.
 *
 * @see https://bitbucket.org/koreteam1/abl-platform/pull-requests/965
 */

import { describe, it, expect } from 'vitest';

describe('Azure KMS dependency resolution', () => {
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

  it('AzureKeyVaultProvider can be instantiated without errors', async () => {
    const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');

    const provider = new AzureKeyVaultProvider({
      vaultUrl: 'https://test-vault.vault.azure.net',
      keyName: 'test-key',
    });

    expect(provider.providerType).toBe('azure-keyvault');
  });

  it('AzureKeyVaultProvider.initialize() resolves SDK imports', async () => {
    const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');

    const provider = new AzureKeyVaultProvider({
      vaultUrl: 'https://test-vault.vault.azure.net',
      keyName: 'test-key',
      // Use explicit credentials to avoid DefaultAzureCredential needing env vars
      tenantId: 'test-tenant-00000000',
      clientId: 'test-client-00000000',
      clientSecret: 'test-value-00000000', // gitleaks:allow
    });

    // initialize() will construct KeyClient and CryptographyClient.
    // It won't make network calls — just proves the SDK classes resolve.
    await provider.initialize();

    // healthCheck will fail (no real vault) but proves the import chain works
    const health = await provider.healthCheck();
    expect(health.providerType).toBe('azure-keyvault');
    // We expect unhealthy since there's no real vault, but no MODULE_NOT_FOUND error
    expect(health.healthy).toBe(false);
    expect(health.message).not.toContain('Cannot find package');
    expect(health.message).not.toContain('MODULE_NOT_FOUND');
  });

  it('strips trailing slash from vaultUrl to avoid double-slash in key ID', async () => {
    const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');

    const provider = new AzureKeyVaultProvider({
      vaultUrl: 'https://test-vault.vault.azure.net/', // trailing slash
      keyName: 'my-key',
      tenantId: 'test-tenant-00000000',
      clientId: 'test-client-00000000',
      clientSecret: 'test-value-00000000', // gitleaks:allow
    });

    await provider.initialize();

    // healthCheck error message should reference the correct URL (no double slash)
    const health = await provider.healthCheck();
    expect(health.message).not.toContain('//keys/');
    expect(health.message).not.toContain('is not a valid Key Vault key ID');
  });
});
