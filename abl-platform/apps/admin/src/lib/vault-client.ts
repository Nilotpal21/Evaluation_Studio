/**
 * Server-side Vault Client
 *
 * Simple env-based vault for the admin dashboard.
 * In dev, reads from process.env. In production, this would be extended
 * with K8s/AWS/Azure providers.
 *
 * NOTE: Does NOT import @agent-platform/config because Turbopack cannot
 * resolve ESM workspace packages as server externals. Logic is inlined.
 */

export interface VaultProvider {
  get(key: string): Promise<string | undefined>;
  getAll(prefix?: string): Promise<Record<string, string>>;
  set?(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

let vaultClient: VaultProvider | null = null;

/**
 * Get the vault client singleton.
 * In dev: reads from process.env only.
 */
export async function getVaultClient(): Promise<VaultProvider> {
  if (vaultClient) return vaultClient;

  vaultClient = {
    async get(key: string) {
      return process.env[key];
    },
    async getAll(prefix?: string) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (prefix && !key.startsWith(prefix)) continue;
        result[key] = value;
      }
      return result;
    },
    async set(key: string, value: string) {
      process.env[key] = value;
    },
    async delete(key: string) {
      delete process.env[key];
    },
  };

  return vaultClient;
}

/**
 * Mask a secret value for display.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.slice(0, 4) + '*'.repeat(Math.max(value.length - 8, 4)) + value.slice(-4);
}
