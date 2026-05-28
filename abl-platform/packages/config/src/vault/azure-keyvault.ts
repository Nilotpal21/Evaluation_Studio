/**
 * Azure Key Vault Provider
 *
 * Reads secrets from Azure Key Vault using @azure/keyvault-secrets and @azure/identity.
 * Uses the DefaultAzureCredential chain (Managed Identity, Azure CLI, env vars, etc.).
 *
 * Authentication is handled by the Azure SDK's DefaultAzureCredential, which automatically
 * picks the best credential for the environment:
 *   - AKS pods: Workload Identity (federated OIDC) or Pod Identity (AAD)
 *   - VMs: Managed Identity
 *   - Local dev: Azure CLI (`az login`) or env vars (AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET)
 *
 * Cache TTL: Secrets are cached for 1 hour (configurable). On expiry, re-fetch from Vault.
 * If Azure is unreachable, serve stale cache + log warning.
 */

import type { VaultProvider } from './index.js';

interface SecretClient {
  getSecret(name: string): Promise<{ value?: string; properties: { version?: string } }>;
  listPropertiesOfSecrets(): AsyncIterable<{ name: string; enabled?: boolean }>;
}

export class AzureKeyVaultProvider implements VaultProvider {
  readonly name = 'azure';

  private vaultUrl: string | undefined;
  private initialized = false;
  private cachedSecrets: Record<string, string> = {};
  private client: SecretClient | null = null;
  private cacheExpiresAt = 0;
  private cacheExpiryMs: number;

  /** Prevents thundering herd on cache expiry */
  private refetchPromise: Promise<void> | null = null;

  constructor(options?: { vaultUrl?: string; cacheExpiryMs?: number }) {
    this.vaultUrl = options?.vaultUrl ?? process.env.AZURE_KEYVAULT_URL;
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 3_600_000; // 1 hour
  }

  async initialize(): Promise<void> {
    if (!this.vaultUrl) {
      console.warn('[Config] Azure Key Vault not configured: AZURE_KEYVAULT_URL required');
      return;
    }

    try {
      // Dynamic imports — @azure/keyvault-secrets and @azure/identity are optional
      const identityModule = (await Function('return import("@azure/identity")')()) as {
        DefaultAzureCredential: new () => unknown;
      };

      const secretsModule = (await Function('return import("@azure/keyvault-secrets")')()) as {
        SecretClient: new (url: string, credential: unknown) => SecretClient;
      };

      const credential = new identityModule.DefaultAzureCredential();
      this.client = new secretsModule.SecretClient(this.vaultUrl, credential);

      await this.fetchSecrets();
      this.initialized = true;

      console.log(
        `[Config] Azure Key Vault initialized (${Object.keys(this.cachedSecrets).length} secrets from ${this.vaultUrl})`,
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);

      if (errMsg.includes('Cannot find module') || errMsg.includes('MODULE_NOT_FOUND')) {
        console.warn(
          '[Config] Azure Key Vault unavailable: @azure/keyvault-secrets or @azure/identity not installed',
        );
        return;
      }

      console.error('[Config] Failed to connect to Azure Key Vault:', errMsg);
      throw error;
    }
  }

  private async fetchSecrets(): Promise<void> {
    if (!this.client) return;

    const newSecrets: Record<string, string> = {};

    // List all secrets, then fetch each value
    for await (const secretProperties of this.client.listPropertiesOfSecrets()) {
      if (secretProperties.enabled === false) continue;

      try {
        const secret = await this.client.getSecret(secretProperties.name);
        if (secret.value !== undefined) {
          // Convert Azure secret name (kebab-case) to env var style (UPPER_SNAKE_CASE)
          const key = secretProperties.name.replace(/-/g, '_').toUpperCase();
          newSecrets[key] = secret.value;
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[Config] Azure Key Vault: failed to read secret "${secretProperties.name}": ${msg}`,
        );
      }
    }

    this.cachedSecrets = newSecrets;
    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.initialized) return undefined;

    // Check cache expiry (with thundering herd protection)
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

    // Check cache expiry (with thundering herd protection)
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

  async set(key: string, value: string): Promise<void> {
    if (!this.client) {
      throw new Error('Azure Key Vault client is not initialized');
    }

    // Azure secret names use kebab-case
    const secretName = key.replace(/_/g, '-').toLowerCase();

    try {
      // setSecret is on the client instance — no need to re-import the module
      await (
        this.client as unknown as { setSecret(name: string, value: string): Promise<unknown> }
      ).setSecret(secretName, value);

      // Update cache
      this.cachedSecrets[key] = value;
      this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Config] Azure Key Vault set("${key}") failed: ${msg}`);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.client) {
      throw new Error('Azure Key Vault client is not initialized');
    }

    const secretName = key.replace(/_/g, '-').toLowerCase();

    try {
      const poller = await (
        this.client as unknown as {
          beginDeleteSecret(name: string): Promise<{ pollUntilDone(): Promise<unknown> }>;
        }
      ).beginDeleteSecret(secretName);

      // Wait for the delete operation to complete before updating cache
      await poller.pollUntilDone();

      // Remove from cache
      delete this.cachedSecrets[key];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Config] Azure Key Vault delete("${key}") failed: ${msg}`);
      throw error;
    }
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.cachedSecrets = {};
    this.client = null;
    this.cacheExpiresAt = 0;
  }
}
