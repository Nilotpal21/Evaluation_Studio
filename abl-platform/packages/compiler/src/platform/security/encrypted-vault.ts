/**
 * Encrypted Vault Operations
 *
 * Provides encrypt/decrypt wrappers for PIIVault serialization.
 * Uses EncryptionService (AES-256-GCM) with tenant-scoped keys.
 */

import { createLogger } from '../logger.js';
import { PIIVault } from './pii-vault.js';

const log = createLogger('encrypted-vault');

export interface VaultEncryptionService {
  encryptForTenant(plaintext: string, tenantId: string): Promise<string>;
  decryptForTenant(encryptedData: string, tenantId: string): Promise<string>;
}

export async function encryptVault(
  vault: PIIVault,
  tenantId: string,
  encryptionService: VaultEncryptionService,
): Promise<string | null> {
  if (vault.isEmpty()) return null;
  try {
    const serialized = vault.serialize();
    return await encryptionService.encryptForTenant(serialized, tenantId);
  } catch (err) {
    log.warn('vault-encrypt-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function decryptVault(
  encrypted: string,
  tenantId: string,
  encryptionService: VaultEncryptionService,
): Promise<PIIVault | null> {
  try {
    const json = await encryptionService.decryptForTenant(encrypted, tenantId);
    return PIIVault.deserialize(json);
  } catch (err) {
    log.warn('vault-decrypt-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
