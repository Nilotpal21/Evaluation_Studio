/**
 * Azure Key Vault Provider
 *
 * Uses @azure/keyvault-keys + @azure/identity (dynamically imported).
 * Defaults to RSA-HSM 3072-bit keys (FIPS 140-2 Level 2/3 when provisioned
 * with Key Vault premium SKU). For FIPS 140-3 Level 3, use Azure Managed HSM
 * via AzureManagedHSMProvider.
 *
 * Operations:
 *   - CryptographyClient.wrapKey('RSA-OAEP-256'): Wrap DEK with KEK
 *   - CryptographyClient.unwrapKey('RSA-OAEP-256'): Unwrap DEK (version-pinned after rotation)
 *   - KeyClient.createKey: Create RSA-HSM 3072 KEK
 *   - KeyClient.beginDeleteKey: Schedule key deletion
 */

import type {
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KeyPurpose,
} from '../types.js';
import { randomBytes } from 'node:crypto';

// =============================================================================
// CONFIG
// =============================================================================

/** Lazy-load Azure SDKs to avoid bundling when not used */
async function loadAzureKeyvault(): Promise<any> {
  return import('@azure/keyvault-keys' as string);
}

async function loadAzureIdentity(): Promise<any> {
  return import('@azure/identity' as string);
}

export interface AzureKeyVaultProviderConfig {
  vaultUrl: string;
  keyName: string;
  keyVersion?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

// =============================================================================
// AZURE KEY VAULT PROVIDER
// =============================================================================

export class AzureKeyVaultProvider implements KMSProvider {
  readonly providerType: string = 'azure-keyvault';
  protected readonly wrapAlgorithm = 'RSA-OAEP-256' as const;
  protected readonly keyType = 'RSA-HSM' as const;
  protected readonly keySize = 3072;
  protected readonly keyAlgorithmLabel = 'RSA-HSM-3072' as const;

  protected keyClient: any = null;
  protected cryptoClient: any = null;
  /** Credential instance reused for version-specific CryptographyClients */
  private credential: any = null;
  /** Cached CryptographyClient factory (from @azure/keyvault-keys) */
  private CryptographyClientCtor: any = null;
  private initialized = false;

  constructor(protected readonly config: AzureKeyVaultProviderConfig) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { KeyClient, CryptographyClient } = await loadAzureKeyvault();
    const { DefaultAzureCredential, ClientSecretCredential } = await loadAzureIdentity();

    this.credential =
      this.config.clientId && this.config.clientSecret && this.config.tenantId
        ? new ClientSecretCredential(
            this.config.tenantId,
            this.config.clientId,
            this.config.clientSecret,
          )
        : new DefaultAzureCredential();
    this.CryptographyClientCtor = CryptographyClient;

    const vaultUrl = this.config.vaultUrl.replace(/\/+$/, '');
    this.keyClient = new KeyClient(vaultUrl, this.credential);

    const keyId = this.config.keyVersion
      ? `${vaultUrl}/keys/${this.config.keyName}/${this.config.keyVersion}`
      : `${vaultUrl}/keys/${this.config.keyName}`;

    this.cryptoClient = new CryptographyClient(keyId, this.credential);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.keyClient = null;
    this.cryptoClient = null;
    this.credential = null;
    this.CryptographyClientCtor = null;
    this.initialized = false;
  }

  async healthCheck(): Promise<KMSHealthStatus> {
    const start = Date.now();
    try {
      this.assertInitialized();
      await this.keyClient.getKey(this.config.keyName);
      return {
        healthy: true,
        providerType: this.providerType,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        healthy: false,
        providerType: this.providerType,
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async generateDataKey(keyId: string): Promise<GenerateDataKeyResult> {
    this.assertInitialized();

    const dekPlaintext = randomBytes(32);
    const wrapResult = await this.cryptoClient.wrapKey(this.wrapAlgorithm, dekPlaintext);
    const versionId = extractKeyVersion(wrapResult.keyID);

    return {
      plaintext: dekPlaintext,
      ciphertext: Buffer.from(wrapResult.result),
      keyId: keyId || this.config.keyName,
      keyVersionId: versionId,
    };
  }

  async wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    this.assertInitialized();

    const wrapResult = await this.cryptoClient.wrapKey(this.wrapAlgorithm, plaintext);
    const versionId = extractKeyVersion(wrapResult.keyID);

    return {
      ciphertext: Buffer.from(wrapResult.result),
      keyId: keyId || this.config.keyName,
      keyVersionId: versionId,
    };
  }

  async unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    _keyVersion?: number,
    keyVersionId?: string,
  ): Promise<Buffer> {
    this.assertInitialized();

    // When a specific key version is known (post-rotation safety), construct a
    // version-pinned CryptographyClient so Azure uses the exact key material
    // that performed the original wrap — not the latest (rotated) version.
    const client = keyVersionId ? this.getVersionedCryptoClient(keyVersionId) : this.cryptoClient;

    const { result } = await client.unwrapKey(this.wrapAlgorithm, ciphertext);
    return Buffer.from(result);
  }

  async encrypt(keyId: string, plaintext: Buffer): Promise<Buffer> {
    this.assertInitialized();

    const { result } = await this.cryptoClient.encrypt('RSA-OAEP-256', plaintext);
    return Buffer.from(result);
  }

  async decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer> {
    this.assertInitialized();

    const { result } = await this.cryptoClient.decrypt('RSA-OAEP-256', ciphertext);
    return Buffer.from(result);
  }

  async createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const keyName = `abl-${purpose}-${randomBytes(4).toString('hex')}`;
    const key = await this.keyClient.createKey(keyName, this.keyType, {
      keySize: this.keySize,
      tags: { platform: 'abl', purpose },
    });

    const isHSM = key.keyType?.endsWith('-HSM') ?? this.keyType === 'RSA-HSM';

    return {
      keyId: key.id || keyName,
      purpose,
      state: key.properties.enabled ? 'active' : 'deactivated',
      protectionLevel: isHSM ? 'hsm' : 'software-protected',
      algorithm: this.keyAlgorithmLabel,
      createdAt: key.properties.createdOn || new Date(),
      rotationIntervalDays: 0,
      providerMetadata: { vaultUrl: this.config.vaultUrl },
    };
  }

  async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const key = await this.keyClient.getKey(keyId || this.config.keyName);
    const isHSM = key.keyType?.endsWith('-HSM') ?? false;

    return {
      keyId: key.id || keyId,
      purpose: 'data-encryption',
      state: key.properties.enabled ? 'active' : 'deactivated',
      protectionLevel: isHSM ? 'hsm' : 'software-protected',
      algorithm: key.keyType || this.keyAlgorithmLabel,
      createdAt: key.properties.createdOn || new Date(),
      expiresAt: key.properties.expiresOn || undefined,
      rotationIntervalDays: 0,
      providerMetadata: { vaultUrl: this.config.vaultUrl },
    };
  }

  async enableKeyRotation(keyId: string, intervalDays: number): Promise<void> {
    this.assertInitialized();

    await this.keyClient.updateKeyRotationPolicy(keyId || this.config.keyName, {
      lifetimeActions: [
        {
          action: 'Rotate',
          trigger: { timeAfterCreate: `P${intervalDays}D` },
        },
      ],
    });
  }

  async scheduleKeyDeletion(keyId: string, _pendingWindowDays?: number): Promise<void> {
    this.assertInitialized();

    const poller = await this.keyClient.beginDeleteKey(keyId || this.config.keyName);
    await poller.pollUntilDone();
  }

  /**
   * Build a CryptographyClient pinned to a specific key version.
   * Required for unwrapping DEKs after KEK rotation — the default
   * (versionless) client targets the latest version which has different
   * key material post-rotation.
   */
  protected getVersionedCryptoClient(versionId: string): any {
    const vaultUrl = this.config.vaultUrl.replace(/\/+$/, '');
    const versionedKeyId = `${vaultUrl}/keys/${this.config.keyName}/${versionId}`;
    return new this.CryptographyClientCtor(versionedKeyId, this.credential);
  }

  protected assertInitialized(): void {
    if (!this.initialized || !this.keyClient || !this.cryptoClient) {
      throw new Error('AzureKeyVaultProvider is not initialized. Call initialize() first.');
    }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract the version segment from an Azure Key Vault key URL.
 * URL format: https://{vault}.vault.azure.net/keys/{name}/{version}
 * Returns the hex version string, or undefined if not present.
 */
function extractKeyVersion(keyUrl?: string): string | undefined {
  if (!keyUrl) return undefined;
  // Split on /keys/ and take the part after keyName
  const keysIdx = keyUrl.indexOf('/keys/');
  if (keysIdx === -1) return undefined;
  const afterKeys = keyUrl.substring(keysIdx + 6); // skip '/keys/'
  const slashIdx = afterKeys.indexOf('/');
  if (slashIdx === -1) return undefined;
  const version = afterKeys.substring(slashIdx + 1);
  return version || undefined;
}
