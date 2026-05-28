/**
 * GCP Cloud KMS Provider
 *
 * Uses @google-cloud/kms (dynamically imported).
 * Supports both HSM and software protection levels.
 *
 * Key resource name format:
 *   projects/{project}/locations/{location}/keyRings/{ring}/cryptoKeys/{key}
 */

import { randomBytes } from 'node:crypto';
import type {
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KeyPurpose,
} from '../types.js';

// =============================================================================
// CONFIG
// =============================================================================

/** Lazy-load the GCP KMS SDK to avoid bundling when not used */
async function loadGCPKMS(): Promise<any> {
  return import('@google-cloud/kms' as string);
}

export interface GCPCloudKMSProviderConfig {
  /** GCP project ID */
  projectId: string;
  /** Location (e.g., 'us-east1', 'global') */
  location: string;
  /** Key ring name */
  keyRing: string;
  /** Crypto key name */
  keyName: string;
  /** Key version (optional, latest if not specified) */
  keyVersion?: string;
  /** Path to service account JSON (optional, uses ADC if not set) */
  credentialsPath?: string;
}

// =============================================================================
// GCP CLOUD KMS PROVIDER
// =============================================================================

export class GCPCloudKMSProvider implements KMSProvider {
  readonly providerType = 'gcp-cloud-kms' as const;

  private client: any = null;
  private initialized = false;

  constructor(private readonly config: GCPCloudKMSProviderConfig) {}

  private get keyPath(): string {
    return `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}/cryptoKeys/${this.config.keyName}`;
  }

  private get versionedKeyPath(): string {
    const version = this.config.keyVersion || '1';
    return `${this.keyPath}/cryptoKeyVersions/${version}`;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { KeyManagementServiceClient } = await loadGCPKMS();

    const opts: any = {};
    if (this.config.credentialsPath) {
      opts.keyFilename = this.config.credentialsPath;
    }

    this.client = new KeyManagementServiceClient(opts);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close?.();
      this.client = null;
    }
    this.initialized = false;
  }

  async healthCheck(): Promise<KMSHealthStatus> {
    const start = Date.now();
    try {
      this.assertInitialized();
      await this.client.getCryptoKey({ name: this.keyPath });
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

    // GCP doesn't have a native generateDataKey — generate locally, then encrypt
    const dekPlaintext = randomBytes(32);
    const [response] = await this.client.encrypt({
      name: keyId || this.keyPath,
      plaintext: dekPlaintext,
    });

    return {
      plaintext: dekPlaintext,
      ciphertext: Buffer.from(response.ciphertext),
      keyId: keyId || this.config.keyName,
    };
  }

  async wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    this.assertInitialized();

    const [response] = await this.client.encrypt({
      name: keyId || this.keyPath,
      plaintext,
    });

    return {
      ciphertext: Buffer.from(response.ciphertext),
      keyId: keyId || this.config.keyName,
    };
  }

  async unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    _keyVersion?: number,
    _keyVersionId?: string,
  ): Promise<Buffer> {
    this.assertInitialized();

    const [response] = await this.client.decrypt({
      name: keyId || this.keyPath,
      ciphertext,
    });

    return Buffer.from(response.plaintext);
  }

  async encrypt(keyId: string, plaintext: Buffer): Promise<Buffer> {
    const { ciphertext } = await this.wrapKey(keyId, plaintext);
    return ciphertext;
  }

  async decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer> {
    return this.unwrapKey(keyId, ciphertext);
  }

  async createKey(purpose: KeyPurpose): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const keyId = `abl-${purpose}-${randomBytes(4).toString('hex')}`;
    const keyRingPath = `projects/${this.config.projectId}/locations/${this.config.location}/keyRings/${this.config.keyRing}`;

    const [key] = await this.client.createCryptoKey({
      parent: keyRingPath,
      cryptoKeyId: keyId,
      cryptoKey: {
        purpose: 'ENCRYPT_DECRYPT',
        versionTemplate: {
          algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
          protectionLevel: 'SOFTWARE',
        },
        labels: { platform: 'abl', purpose },
      },
    });

    return {
      keyId: key.name || keyId,
      purpose,
      state: 'active',
      protectionLevel: 'software-protected',
      algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
      createdAt: key.createTime ? new Date(key.createTime) : new Date(),
      rotationIntervalDays: 0,
      providerMetadata: { project: this.config.projectId, location: this.config.location },
    };
  }

  async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const [key] = await this.client.getCryptoKey({ name: keyId || this.keyPath });

    const protectionLevel =
      key.versionTemplate?.protectionLevel === 'HSM'
        ? ('hsm' as const)
        : ('software-protected' as const);

    return {
      keyId: key.name || keyId,
      purpose: 'data-encryption',
      state: 'active',
      protectionLevel,
      algorithm: key.versionTemplate?.algorithm || 'GOOGLE_SYMMETRIC_ENCRYPTION',
      createdAt: key.createTime ? new Date(key.createTime) : new Date(),
      rotationIntervalDays: key.rotationPeriod
        ? Math.floor(parseInt(key.rotationPeriod) / 86400)
        : 0,
      providerMetadata: { project: this.config.projectId, location: this.config.location },
    };
  }

  async enableKeyRotation(keyId: string, intervalDays: number): Promise<void> {
    this.assertInitialized();

    const rotationPeriodSeconds = intervalDays * 86400;
    await this.client.updateCryptoKey({
      cryptoKey: {
        name: keyId || this.keyPath,
        rotationPeriod: { seconds: rotationPeriodSeconds },
        nextRotationTime: { seconds: Math.floor(Date.now() / 1000) + rotationPeriodSeconds },
      },
      updateMask: { paths: ['rotation_period', 'next_rotation_time'] },
    });
  }

  async scheduleKeyDeletion(keyId: string, _pendingWindowDays?: number): Promise<void> {
    this.assertInitialized();

    // GCP: destroy the primary version (the key resource remains)
    await this.client.destroyCryptoKeyVersion({
      name: `${keyId || this.keyPath}/cryptoKeyVersions/1`,
    });
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.client) {
      throw new Error('GCPCloudKMSProvider is not initialized. Call initialize() first.');
    }
  }
}
