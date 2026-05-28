/**
 * Resolves the encryption master key from a vault provider or environment variable.
 */

const log = {
  info: (_msg: string) => {},
  warn: (_msg: string) => {},
};

export interface VaultProvider {
  isAvailable(): boolean;
  get(key: string): Promise<string | undefined>;
}

export async function resolveMasterKey(vaultProvider?: VaultProvider): Promise<string> {
  if (vaultProvider?.isAvailable()) {
    const key = await vaultProvider.get('ENCRYPTION_MASTER_KEY');
    if (key) {
      log.info('Master key resolved from vault provider');
      return key;
    }
    log.warn('Vault available but ENCRYPTION_MASTER_KEY not found — falling back to env');
  }

  const envKey = process.env.ENCRYPTION_MASTER_KEY;
  if (envKey) {
    if (process.env.NODE_ENV === 'production') {
      log.warn('ENCRYPTION_MASTER_KEY sourced from environment variable — vault is recommended');
    }
    return envKey;
  }

  throw new Error('ENCRYPTION_MASTER_KEY not found in vault or environment');
}
