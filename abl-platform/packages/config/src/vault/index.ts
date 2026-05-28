/**
 * Vault Provider Interface
 *
 * Abstraction for secret/config retrieval from various backends.
 */

/**
 * Vault provider interface — all providers must implement this
 */
export interface VaultProvider {
  /** Provider name for logging/debugging */
  readonly name: string;

  /** Initialize the provider (connect, authenticate, etc.) */
  initialize(): Promise<void>;

  /** Get a secret value by key */
  get(key: string): Promise<string | undefined>;

  /** Get all secrets matching a prefix (for batch loading) */
  getAll(prefix?: string): Promise<Record<string, string>>;

  /** Check if the provider is available/configured */
  isAvailable(): boolean;

  /** Close connections/cleanup */
  close(): Promise<void>;

  /** Optional: watch for secret changes (for rotation detection) */
  watch?(callback: (changedKeys: string[]) => void): void;

  /** Optional: write a secret value by key */
  set?(key: string, value: string): Promise<void>;

  /** Optional: delete a secret by key */
  delete?(key: string): Promise<void>;
}

export type VaultType = 'env' | 'file' | 'hashicorp' | 'aws' | 'azure' | 'k8s' | 'composite';

export interface CreateVaultProviderOptions {
  /** Additional env var keys to include in the EnvProvider allowlist */
  allowedKeys?: string[];
}

/**
 * Create a vault provider based on type
 */
export async function createVaultProvider(
  type: VaultType = 'env',
  options?: CreateVaultProviderOptions,
): Promise<VaultProvider> {
  switch (type) {
    case 'env': {
      const { EnvProvider } = await import('./env-provider.js');
      return new EnvProvider({ allowedKeys: options?.allowedKeys });
    }
    case 'file': {
      const { FileProvider } = await import('./file-provider.js');
      return new FileProvider();
    }
    case 'hashicorp': {
      const { HashiCorpVaultProvider } = await import('./hashicorp-vault.js');
      return new HashiCorpVaultProvider();
    }
    case 'aws': {
      const { AWSSecretsProvider } = await import('./aws-secrets.js');
      return new AWSSecretsProvider();
    }
    case 'azure': {
      const { AzureKeyVaultProvider } = await import('./azure-keyvault.js');
      return new AzureKeyVaultProvider();
    }
    case 'k8s': {
      const { K8sSecretProvider } = await import('./k8s-secret-provider.js');
      return new K8sSecretProvider();
    }
    case 'composite': {
      const { CompositeVaultProvider } = await import('./composite-provider.js');
      return new CompositeVaultProvider([]);
    }
    default:
      throw new Error(`Unknown vault type: ${type}`);
  }
}

export { EnvProvider } from './env-provider.js';
export { FileProvider } from './file-provider.js';
export { HashiCorpVaultProvider } from './hashicorp-vault.js';
export { AWSSecretsProvider } from './aws-secrets.js';
export { AzureKeyVaultProvider } from './azure-keyvault.js';
export { K8sSecretProvider } from './k8s-secret-provider.js';
export { CompositeVaultProvider } from './composite-provider.js';
