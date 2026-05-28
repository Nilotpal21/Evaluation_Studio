/**
 * Azure Managed HSM Provider
 *
 * Same SDK as Azure Key Vault but with Managed HSM endpoints.
 * FIPS 140-3 Level 3 validated. Keys never leave the HSM boundary.
 *
 * The Managed HSM URL format: https://{hsm-name}.managedhsm.azure.net
 * vs Key Vault URL format:    https://{vault-name}.vault.azure.net
 */

import type { KMSKeyMetadata, KeyPurpose } from '../types.js';
import {
  AzureKeyVaultProvider,
  type AzureKeyVaultProviderConfig,
} from './azure-keyvault-provider.js';

export class AzureManagedHSMProvider extends AzureKeyVaultProvider {
  override readonly providerType: string = 'azure-managed-hsm';

  constructor(config: AzureKeyVaultProviderConfig) {
    super(config);
  }

  override async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    const meta = await super.describeKey(keyId);
    meta.protectionLevel = 'hsm';
    return meta;
  }

  override async createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    const meta = await super.createKey(purpose);
    meta.protectionLevel = 'hsm';
    return meta;
  }
}
