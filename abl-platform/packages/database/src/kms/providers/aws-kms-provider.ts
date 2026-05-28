/**
 * AWS KMS Provider
 *
 * Uses @aws-sdk/client-kms (dynamically imported) for:
 *   - GenerateDataKey: Generate DEK wrapped by a CMK
 *   - Encrypt/Decrypt: Direct KMS operations (≤4KB)
 *   - CreateKey: Create new CMK
 *   - ScheduleKeyDeletion: Schedule key for deletion
 *   - GetParametersForImport + ImportKeyMaterial: BYOK
 *
 * Supports both software and HSM-backed keys (AWS CloudHSM custom key store).
 */

import type {
  KMSProvider,
  GenerateDataKeyResult,
  WrapKeyResult,
  KMSKeyMetadata,
  KMSHealthStatus,
  KeyPurpose,
} from '../types.js';

// =============================================================================
// TYPES (AWS SDK — lazy loaded)
// =============================================================================

type KMSClient = any;

/** Lazy-load the AWS SDK to avoid bundling it when not used */
async function loadAWSSDK(): Promise<any> {
  return import('@aws-sdk/client-kms' as string);
}

export interface AWSKMSProviderConfig {
  region: string;
  keyId: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

// =============================================================================
// AWS KMS PROVIDER
// =============================================================================

export class AWSKMSProvider implements KMSProvider {
  readonly providerType = 'aws-kms' as const;

  private client: KMSClient | null = null;
  private initialized = false;
  private importTokenCache = new Map<string, { token: Buffer; expiresAt: number }>();

  constructor(private readonly config: AWSKMSProviderConfig) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { KMSClient: KMSClientClass } = await loadAWSSDK();

    const clientConfig: any = {
      region: this.config.region,
    };

    if (this.config.endpoint) {
      clientConfig.endpoint = this.config.endpoint;
    }

    if (this.config.credentials) {
      clientConfig.credentials = this.config.credentials;
    }

    this.client = new KMSClientClass(clientConfig);
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      this.client.destroy?.();
      this.client = null;
    }
    this.importTokenCache.clear();
    this.initialized = false;
  }

  async healthCheck(): Promise<KMSHealthStatus> {
    const start = Date.now();
    try {
      this.assertInitialized();
      const { DescribeKeyCommand } = await loadAWSSDK();
      await this.client!.send(new DescribeKeyCommand({ KeyId: this.config.keyId }));
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

    const { GenerateDataKeyCommand } = await loadAWSSDK();
    const response = await this.client!.send(
      new GenerateDataKeyCommand({
        KeyId: keyId || this.config.keyId,
        KeySpec: 'AES_256',
      }),
    );

    return {
      plaintext: Buffer.from(response.Plaintext!),
      ciphertext: Buffer.from(response.CiphertextBlob!),
      keyId: keyId || this.config.keyId,
    };
  }

  async wrapKey(keyId: string, plaintext: Buffer): Promise<WrapKeyResult> {
    this.assertInitialized();

    const { EncryptCommand } = await loadAWSSDK();
    const response = await this.client!.send(
      new EncryptCommand({
        KeyId: keyId || this.config.keyId,
        Plaintext: plaintext,
      }),
    );

    return {
      ciphertext: Buffer.from(response.CiphertextBlob!),
      keyId: keyId || this.config.keyId,
    };
  }

  async unwrapKey(
    keyId: string,
    ciphertext: Buffer,
    _keyVersion?: number,
    _keyVersionId?: string,
  ): Promise<Buffer> {
    this.assertInitialized();

    const { DecryptCommand } = await loadAWSSDK();
    const response = await this.client!.send(
      new DecryptCommand({
        KeyId: keyId || this.config.keyId,
        CiphertextBlob: ciphertext,
      }),
    );

    return Buffer.from(response.Plaintext!);
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

    const { CreateKeyCommand } = await loadAWSSDK();
    const response = await this.client!.send(
      new CreateKeyCommand({
        Description: `ABL Platform ${purpose} key`,
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [
          { TagKey: 'Platform', TagValue: 'abl' },
          { TagKey: 'Purpose', TagValue: purpose },
        ],
      }),
    );

    const meta = response.KeyMetadata!;
    return {
      keyId: meta.KeyId!,
      purpose,
      state: 'active',
      protectionLevel: meta.Origin === 'AWS_CLOUDHSM' ? 'hsm' : 'software-protected',
      algorithm: 'AES-256-GCM',
      createdAt: meta.CreationDate!,
      rotationIntervalDays: 0,
      providerMetadata: { arn: meta.Arn },
    };
  }

  async describeKey(keyId: string): Promise<KMSKeyMetadata> {
    this.assertInitialized();

    const { DescribeKeyCommand } = await loadAWSSDK();
    const response = await this.client!.send(
      new DescribeKeyCommand({ KeyId: keyId || this.config.keyId }),
    );

    const meta = response.KeyMetadata!;
    const stateMap: Record<string, any> = {
      Enabled: 'active',
      Disabled: 'deactivated',
      PendingDeletion: 'destroyed',
      PendingImport: 'pre-active',
    };

    return {
      keyId: meta.KeyId!,
      purpose: 'data-encryption',
      state: stateMap[meta.KeyState!] || 'active',
      protectionLevel: meta.Origin === 'AWS_CLOUDHSM' ? 'hsm' : 'software-protected',
      algorithm: 'AES-256-GCM',
      createdAt: meta.CreationDate!,
      rotationIntervalDays: 0,
      providerMetadata: { arn: meta.Arn, origin: meta.Origin },
    };
  }

  async enableKeyRotation(keyId: string, _intervalDays: number): Promise<void> {
    this.assertInitialized();

    const { EnableKeyRotationCommand } = await loadAWSSDK();
    await this.client!.send(new EnableKeyRotationCommand({ KeyId: keyId || this.config.keyId }));
  }

  async scheduleKeyDeletion(keyId: string, pendingWindowDays = 30): Promise<void> {
    this.assertInitialized();

    const { ScheduleKeyDeletionCommand } = await loadAWSSDK();
    await this.client!.send(
      new ScheduleKeyDeletionCommand({
        KeyId: keyId || this.config.keyId,
        PendingWindowInDays: pendingWindowDays,
      }),
    );
  }

  async getWrappingPublicKey(keyId: string): Promise<Buffer> {
    this.assertInitialized();

    const { GetParametersForImportCommand } = await loadAWSSDK();
    const resolvedKeyId = keyId || this.config.keyId;
    const response = await this.client!.send(
      new GetParametersForImportCommand({
        KeyId: resolvedKeyId,
        WrappingAlgorithm: 'RSAES_OAEP_SHA_256',
        WrappingKeySpec: 'RSA_2048',
      }),
    );

    // Cache the import token — required by importKeyMaterial for this key
    this.importTokenCache.set(resolvedKeyId, {
      token: Buffer.from(response.ImportToken!),
      expiresAt: response.ParametersValidTo!.getTime(),
    });

    return Buffer.from(response.PublicKey!);
  }

  async importKeyMaterial(keyId: string, wrapped: Buffer): Promise<void> {
    this.assertInitialized();

    const resolvedKeyId = keyId || this.config.keyId;

    // Retrieve cached import token from prior getWrappingPublicKey call
    let importToken: Buffer;
    const cached = this.importTokenCache.get(resolvedKeyId);

    if (cached && cached.expiresAt > Date.now()) {
      importToken = cached.token;
      this.importTokenCache.delete(resolvedKeyId);
    } else {
      // No cached token or expired — fetch fresh parameters
      this.importTokenCache.delete(resolvedKeyId);
      const { GetParametersForImportCommand } = await loadAWSSDK();
      const params = await this.client!.send(
        new GetParametersForImportCommand({
          KeyId: resolvedKeyId,
          WrappingAlgorithm: 'RSAES_OAEP_SHA_256',
          WrappingKeySpec: 'RSA_2048',
        }),
      );
      importToken = Buffer.from(params.ImportToken!);
    }

    const { ImportKeyMaterialCommand } = await loadAWSSDK();
    await this.client!.send(
      new ImportKeyMaterialCommand({
        KeyId: resolvedKeyId,
        EncryptedKeyMaterial: wrapped,
        ImportToken: importToken,
        ExpirationModel: 'KEY_MATERIAL_DOES_NOT_EXPIRE',
      }),
    );
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.client) {
      throw new Error('AWSKMSProvider is not initialized. Call initialize() first.');
    }
  }
}
