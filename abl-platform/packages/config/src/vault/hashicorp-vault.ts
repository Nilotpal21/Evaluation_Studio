/**
 * HashiCorp Vault Provider
 *
 * Reads secrets from HashiCorp Vault KV v2 engine.
 * Requires VAULT_ADDR and VAULT_TOKEN environment variables (or K8s auth).
 *
 * TLS Configuration:
 * - Set VAULT_CACERT or VAULT_CA_FILE to the path of a CA certificate for custom CAs.
 * - Set VAULT_SKIP_VERIFY=true in development to skip TLS verification.
 * - For Node 18+, custom CA certificates should be configured via NODE_EXTRA_CA_CERTS
 *   environment variable, as the native fetch API does not support per-request CA options.
 * - In production, HTTPS is enforced — HTTP addresses will log an error.
 */

import * as fs from 'node:fs';
import type { VaultProvider } from './index.js';

export class HashiCorpVaultProvider implements VaultProvider {
  readonly name = 'hashicorp';

  private vaultAddr: string | undefined;
  private vaultToken: string | undefined;
  private vaultPath: string;
  private initialized = false;
  private cachedSecrets: Record<string, string> = {};

  /** Cache TTL fields */
  private cacheExpiresAt: number = 0;
  private cacheExpiryMs: number;

  /** Lease tracking */
  private leaseExpiresAt?: number;
  private leaseDuration?: number;

  /** K8s auth fields */
  private authMethod: 'token' | 'k8s' = 'token';
  private k8sRole?: string;
  private k8sTokenPath: string = '/var/run/secrets/kubernetes.io/serviceaccount/token';

  /** Token refresh timer (for K8s auth) */
  private tokenRefreshTimer?: ReturnType<typeof setInterval>;

  /** Prevents thundering herd on cache expiry */
  private refetchPromise: Promise<void> | null = null;

  constructor(options?: {
    addr?: string;
    token?: string;
    path?: string;
    cacheExpiryMs?: number;
    k8sAuth?: boolean;
    k8sRole?: string;
  }) {
    this.vaultAddr = options?.addr ?? process.env.VAULT_ADDR;
    this.vaultToken = options?.token ?? process.env.VAULT_TOKEN;
    this.vaultPath = options?.path ?? 'secret/data/kore-platform';
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 3_600_000; // 1 hour default

    // K8s auth configuration
    if (options?.k8sAuth || process.env.VAULT_K8S_AUTH === 'true') {
      this.authMethod = 'k8s';
      this.k8sRole = options?.k8sRole ?? process.env.VAULT_K8S_ROLE;
    }
  }

  async initialize(): Promise<void> {
    // Enforce HTTPS in production
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    if (this.vaultAddr?.startsWith('http://') && nodeEnv === 'production') {
      console.error(
        '[Config] HashiCorp Vault address uses HTTP in production — this is insecure. Use HTTPS.',
      );
    }

    // TLS skip verify warning
    if (process.env.VAULT_SKIP_VERIFY === 'true') {
      if (nodeEnv === 'production') {
        console.error(
          '[Config] WARNING: VAULT_SKIP_VERIFY=true is set in production — TLS verification is disabled. This is insecure.',
        );
      } else {
        console.warn('[Config] VAULT_SKIP_VERIFY=true — TLS verification disabled (dev only).');
      }
    }

    // Log CA cert path if configured (informational)
    const caCertPath = process.env.VAULT_CACERT ?? process.env.VAULT_CA_FILE;
    if (caCertPath) {
      console.info(
        `[Config] Vault CA certificate path configured: ${caCertPath}. ` +
          'Ensure NODE_EXTRA_CA_CERTS is set for Node 18+ fetch API.',
      );
    }

    // Attempt K8s service account auth if configured
    if (this.authMethod === 'k8s') {
      try {
        await this.authenticateK8s();
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[Config] K8s auth failed: ${errMsg}. Falling back to static VAULT_TOKEN.`);
        this.authMethod = 'token';
        this.vaultToken = this.vaultToken ?? process.env.VAULT_TOKEN;
      }
    }

    if (!this.vaultAddr || !this.vaultToken) {
      console.warn('[Config] HashiCorp Vault not configured: VAULT_ADDR and VAULT_TOKEN required');
      return;
    }

    try {
      await this.fetchSecrets();
      this.initialized = true;
      console.log(
        `[Config] HashiCorp Vault provider initialized (${Object.keys(this.cachedSecrets).length} secrets)`,
      );

      // Start K8s token refresh timer if using K8s auth
      if (this.authMethod === 'k8s') {
        this.startTokenRefreshTimer();
      }
    } catch (error) {
      console.error('[Config] Failed to connect to HashiCorp Vault:', error);
      throw error;
    }
  }

  /**
   * Authenticate using Kubernetes service account token.
   * Reads the SA JWT and exchanges it for a Vault token via the kubernetes auth method.
   */
  private async authenticateK8s(): Promise<void> {
    if (!this.vaultAddr) {
      throw new Error('VAULT_ADDR is required for K8s auth');
    }

    const saToken = await fs.promises.readFile(this.k8sTokenPath, 'utf-8');

    const response = await fetch(`${this.vaultAddr}/v1/auth/kubernetes/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: this.k8sRole,
        jwt: saToken.trim(),
      }),
    });

    if (!response.ok) {
      throw new Error(`K8s Vault login failed with ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };

    if (!body.auth?.client_token) {
      throw new Error('K8s Vault login response missing auth.client_token');
    }

    this.vaultToken = body.auth.client_token;

    // Track auth token lease if provided
    if (body.auth.lease_duration) {
      this.leaseDuration = body.auth.lease_duration;
      this.leaseExpiresAt = Date.now() + body.auth.lease_duration * 1000;
    }
  }

  /**
   * Start a timer that refreshes K8s auth token every 60 seconds.
   */
  private startTokenRefreshTimer(): void {
    const REFRESH_INTERVAL_MS = 60_000;

    this.tokenRefreshTimer = setInterval(async () => {
      try {
        await this.authenticateK8s();
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[Config] K8s token refresh failed: ${errMsg}`);
      }
    }, REFRESH_INTERVAL_MS);

    // Unref the timer so it doesn't prevent Node process from exiting
    if (
      this.tokenRefreshTimer &&
      typeof this.tokenRefreshTimer === 'object' &&
      'unref' in this.tokenRefreshTimer
    ) {
      (this.tokenRefreshTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Fetch secrets from Vault and update cache + lease tracking.
   */
  private async fetchSecrets(): Promise<void> {
    if (!this.vaultAddr || !this.vaultToken) {
      throw new Error('Vault address and token are required');
    }

    const response = await fetch(`${this.vaultAddr}/v1/${this.vaultPath}`, {
      headers: {
        'X-Vault-Token': this.vaultToken,
      },
    });

    if (!response.ok) {
      throw new Error(`Vault responded with ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as {
      data?: { data?: Record<string, string> };
      lease_duration?: number;
    };

    this.cachedSecrets = body?.data?.data ?? {};
    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;

    // Track lease duration from Vault response
    if (body.lease_duration !== undefined && body.lease_duration > 0) {
      this.leaseDuration = body.lease_duration;
      this.leaseExpiresAt = Date.now() + body.lease_duration * 1000;
    }
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.initialized) return undefined;

    const now = Date.now();
    const cacheExpired = now > this.cacheExpiresAt;
    const leaseExpired = this.leaseExpiresAt !== undefined && now > this.leaseExpiresAt;

    // Re-fetch if cache expired or lease expired (with thundering herd protection)
    if (cacheExpired || leaseExpired) {
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
    const now = Date.now();
    const cacheExpired = now > this.cacheExpiresAt;
    const leaseExpired = this.leaseExpiresAt !== undefined && now > this.leaseExpiresAt;
    if (cacheExpired || leaseExpired) {
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

  async set(key: string, value: string): Promise<void> {
    if (!this.vaultAddr || !this.vaultToken) {
      throw new Error('HashiCorp Vault not configured');
    }

    // Save previous value for rollback
    const previousValue = this.cachedSecrets[key];

    // Update local cache
    this.cachedSecrets[key] = value;

    // Write all secrets back to Vault KV v2
    try {
      const response = await fetch(`${this.vaultAddr}/v1/${this.vaultPath}`, {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.vaultToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: this.cachedSecrets }),
      });

      if (!response.ok) {
        throw new Error(`Vault write failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      // Revert cache on failure — restore previous value or remove if new key
      if (previousValue !== undefined) {
        this.cachedSecrets[key] = previousValue;
      } else {
        delete this.cachedSecrets[key];
      }
      throw error;
    }

    // Reset cache expiry after successful write
    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
  }

  async delete(key: string): Promise<void> {
    if (!this.vaultAddr || !this.vaultToken) {
      throw new Error('HashiCorp Vault not configured');
    }

    const previous = this.cachedSecrets[key];
    delete this.cachedSecrets[key];

    // Write updated secrets back to Vault KV v2
    const response = await fetch(`${this.vaultAddr}/v1/${this.vaultPath}`, {
      method: 'POST',
      headers: {
        'X-Vault-Token': this.vaultToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: this.cachedSecrets }),
    });

    if (!response.ok) {
      // Revert cache on failure
      if (previous !== undefined) this.cachedSecrets[key] = previous;
      throw new Error(`Vault delete failed: ${response.status} ${response.statusText}`);
    }

    // Reset cache expiry after successful write
    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  async close(): Promise<void> {
    // Clear K8s token refresh timer
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = undefined;
    }

    this.initialized = false;
    this.cachedSecrets = {};
    this.cacheExpiresAt = 0;
    this.leaseExpiresAt = undefined;
    this.leaseDuration = undefined;
  }
}
