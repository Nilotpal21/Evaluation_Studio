/**
 * AWS Secrets Manager Provider
 *
 * Reads secrets from AWS Secrets Manager.
 * Uses the AWS SDK default credential chain (env vars, IAM role, ECS task role, etc.).
 *
 * IAM Role refresh: The AWS SDK handles credential refresh automatically via the
 * default credential chain (IAM roles, ECS task roles, EC2 instance profiles, etc.),
 * so unlike HashiCorp Vault we don't need manual auth/token refresh. However, the
 * secret VALUES still need periodic re-fetch since they may have been rotated in
 * Secrets Manager (e.g., via automatic rotation lambdas or manual updates).
 */

import type { VaultProvider } from './index.js';

export class AWSSecretsProvider implements VaultProvider {
  readonly name = 'aws';

  private region: string;
  private secretName: string;
  private initialized = false;
  private cachedSecrets: Record<string, string> = {};
  private client: unknown = null;

  /** Cache TTL fields */
  private cacheExpiresAt: number = 0;
  private cacheExpiryMs: number;

  /** Version tracking — detects secret rotation in AWS Secrets Manager */
  private currentVersionId?: string;

  /** Prevents thundering herd on cache expiry */
  private refetchPromise: Promise<void> | null = null;

  constructor(options?: { region?: string; secretName?: string; cacheExpiryMs?: number }) {
    this.region = options?.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.secretName = options?.secretName ?? process.env.AWS_SECRET_NAME ?? 'kore-platform/config';
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 3_600_000; // 1 hour default
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import — @aws-sdk/client-secrets-manager is optional
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sdk = await (Function('return import("@aws-sdk/client-secrets-manager")')() as Promise<{
        SecretsManagerClient: new (config: { region: string }) => {
          send(cmd: unknown): Promise<{ SecretString?: string; VersionId?: string }>;
        };
        GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
      }>);

      this.client = new sdk.SecretsManagerClient({ region: this.region });

      await this.fetchSecrets();

      this.initialized = true;
      console.log(
        `[Config] AWS Secrets Manager initialized (${Object.keys(this.cachedSecrets).length} secrets from ${this.secretName})`,
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // If the SDK isn't installed, warn and return (soft failure for dev)
      if (errMsg.includes('Cannot find module') || errMsg.includes('MODULE_NOT_FOUND')) {
        console.warn(
          '[Config] AWS Secrets Manager unavailable: @aws-sdk/client-secrets-manager not installed',
        );
        return;
      }

      console.error('[Config] Failed to read from AWS Secrets Manager:', error);
      throw error;
    }
  }

  /**
   * Fetch secrets from AWS Secrets Manager and update cache + version tracking.
   */
  private async fetchSecrets(): Promise<void> {
    if (!this.client) {
      throw new Error('AWS Secrets Manager client is not initialized');
    }

    const sdk = await (Function('return import("@aws-sdk/client-secrets-manager")')() as Promise<{
      GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
    }>);

    const command = new sdk.GetSecretValueCommand({
      SecretId: this.secretName,
    });
    const response = await (
      this.client as {
        send(cmd: unknown): Promise<{ SecretString?: string; VersionId?: string }>;
      }
    ).send(command);

    const newVersionId = response.VersionId;

    // Only update cache if version changed (or first fetch)
    if (newVersionId && this.currentVersionId && newVersionId !== this.currentVersionId) {
      console.log(
        `[Config] AWS Secrets Manager rotation detected: ${this.currentVersionId} → ${newVersionId}`,
      );
    }

    if (!this.currentVersionId || newVersionId !== this.currentVersionId) {
      if (response.SecretString) {
        try {
          this.cachedSecrets = JSON.parse(response.SecretString);
        } catch (parseError: unknown) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          console.warn(
            `[Config] AWS SecretString is not valid JSON, treating as raw value: ${msg}`,
          );
          this.cachedSecrets = { _raw: response.SecretString };
        }
      }
      this.currentVersionId = newVersionId;
    }

    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.initialized) return undefined;

    // Re-fetch if cache expired (with thundering herd protection)
    if (Date.now() > this.cacheExpiresAt) {
      if (!this.refetchPromise) {
        this.refetchPromise = this.fetchSecrets()
          .catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[Config] Re-fetch failed, serving stale cache: ${msg}`);
          })
          .finally(() => {
            this.refetchPromise = null;
          });
      }
      await this.refetchPromise;
    }

    return this.cachedSecrets[key];
  }

  async getAll(prefix?: string): Promise<Record<string, string>> {
    if (!this.initialized) return {};

    // Re-fetch if cache expired (with thundering herd protection)
    if (Date.now() > this.cacheExpiresAt) {
      if (!this.refetchPromise) {
        this.refetchPromise = this.fetchSecrets()
          .catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[Config] Re-fetch failed, serving stale cache: ${msg}`);
          })
          .finally(() => {
            this.refetchPromise = null;
          });
      }
      await this.refetchPromise;
    }

    if (!prefix) return { ...this.cachedSecrets };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.cachedSecrets)) {
      if (key.startsWith(prefix)) {
        result[key] = value;
      }
    }
    return result;
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  /**
   * WARNING: Race condition — this method performs a read-modify-write cycle on
   * the entire secrets blob. Concurrent `set()` calls from different processes
   * or pods can overwrite each other's changes (last-writer-wins).
   *
   * AWS Secrets Manager does not natively support field-level updates or
   * compare-and-swap (CAS) on the secret value. To mitigate:
   *   1. Use a distributed lock (e.g. Redis SET NX PX) around set/delete calls.
   *   2. Or use `VersionId` / `VersionStage` to detect stale writes — the caller
   *      would need to track the version from the last read and pass it here.
   *
   * For now, this implementation uses simple overwrite semantics without CAS.
   * If your deployment has multiple writers, add external locking.
   */
  async set(key: string, value: string): Promise<void> {
    if (!this.client) {
      throw new Error('AWS Secrets Manager client is not initialized');
    }

    const sdk = await (Function('return import("@aws-sdk/client-secrets-manager")')() as Promise<{
      PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
    }>);

    // Update the cached secrets and write back the full secret
    const previousValue = this.cachedSecrets[key];
    this.cachedSecrets[key] = value;

    const command = new sdk.PutSecretValueCommand({
      SecretId: this.secretName,
      SecretString: JSON.stringify(this.cachedSecrets),
    });

    try {
      const response = await (
        this.client as { send(cmd: unknown): Promise<{ VersionId?: string }> }
      ).send(command);

      // Track the new version after write
      if (response.VersionId) {
        this.currentVersionId = response.VersionId;
      }

      // Reset cache expiry after successful write
      this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
    } catch (error) {
      // Revert cache on failure
      if (previousValue !== undefined) {
        this.cachedSecrets[key] = previousValue;
      } else {
        delete this.cachedSecrets[key];
      }
      throw error;
    }
  }

  /**
   * WARNING: Same race condition as `set()` — see the comment above `set()` for details.
   * Concurrent `delete()` calls risk overwriting each other's changes.
   */
  async delete(key: string): Promise<void> {
    if (!this.client) {
      throw new Error('AWS Secrets Manager client is not initialized');
    }

    const sdk = await (Function('return import("@aws-sdk/client-secrets-manager")')() as Promise<{
      PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
    }>);

    // Remove from cached secrets and write back the full secret
    const previousValue = this.cachedSecrets[key];
    delete this.cachedSecrets[key];

    const command = new sdk.PutSecretValueCommand({
      SecretId: this.secretName,
      SecretString: JSON.stringify(this.cachedSecrets),
    });

    try {
      const response = await (
        this.client as { send(cmd: unknown): Promise<{ VersionId?: string }> }
      ).send(command);

      // Track the new version after write
      if (response.VersionId) {
        this.currentVersionId = response.VersionId;
      }

      // Reset cache expiry after successful write
      this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
    } catch (error) {
      // Revert cache on failure
      if (previousValue !== undefined) {
        this.cachedSecrets[key] = previousValue;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.cachedSecrets = {};
    this.client = null;
    this.cacheExpiresAt = 0;
    this.currentVersionId = undefined;
  }
}
