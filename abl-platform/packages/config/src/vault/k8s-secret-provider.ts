/**
 * Kubernetes Secret Provider
 *
 * Reads secrets from mounted K8s Secret volumes.
 * In K8s, secrets mounted as volumes appear as individual files
 * under /var/run/secrets/<secret-name>/<key>.
 */

import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { VaultProvider } from './index.js';

export class K8sSecretProvider implements VaultProvider {
  readonly name = 'k8s';

  private mountPath: string;
  private initialized = false;
  private cachedSecrets: Record<string, string> = {};

  /** Cache TTL fields */
  private cacheExpiresAt: number = 0;
  private cacheExpiryMs: number;

  /** Prevents thundering herd on cache expiry */
  private refetchPromise: Promise<void> | null = null;

  constructor(options?: { mountPath?: string; cacheExpiryMs?: number }) {
    this.mountPath =
      options?.mountPath ?? process.env.K8S_SECRETS_PATH ?? '/var/run/secrets/agent-platform';
    this.cacheExpiryMs = options?.cacheExpiryMs ?? 3_600_000; // 1 hour default
  }

  async initialize(): Promise<void> {
    const mountExists = await fsPromises
      .access(this.mountPath)
      .then(() => true)
      .catch(() => false);
    if (!mountExists) {
      console.warn(`[Config] K8s secrets mount not found at ${this.mountPath}`);
      return;
    }

    try {
      const files = await fsPromises.readdir(this.mountPath);
      for (const file of files) {
        // Skip hidden files (e.g., ..data symlinks created by K8s)
        if (file.startsWith('.')) continue;

        const filePath = join(this.mountPath, file);
        const value = (await fsPromises.readFile(filePath, 'utf-8')).trim();
        // Convert filename to env var style: database-url -> DATABASE_URL
        const key = file.replace(/-/g, '_').toUpperCase();
        this.cachedSecrets[key] = value;
      }

      this.initialized = true;
      this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
      console.log(
        `[Config] K8s secret provider initialized (${Object.keys(this.cachedSecrets).length} secrets from ${this.mountPath})`,
      );
    } catch (error) {
      console.error('[Config] Failed to read K8s mounted secrets:', error);
      throw error;
    }
  }

  /**
   * Re-read secrets from the mounted volume using async fs.
   * Compares against cached values and logs which keys changed.
   */
  private async reReadSecrets(): Promise<void> {
    const files = await fsPromises.readdir(this.mountPath);
    const freshSecrets: Record<string, string> = {};

    for (const file of files) {
      if (file.startsWith('.')) continue;

      const filePath = join(this.mountPath, file);
      const value = (await fsPromises.readFile(filePath, 'utf-8')).trim();
      const key = file.replace(/-/g, '_').toUpperCase();
      freshSecrets[key] = value;
    }

    // Detect changed keys
    const changedKeys: string[] = [];
    for (const [key, value] of Object.entries(freshSecrets)) {
      if (this.cachedSecrets[key] !== value) {
        changedKeys.push(key);
      }
    }
    // Detect removed keys
    for (const key of Object.keys(this.cachedSecrets)) {
      if (!(key in freshSecrets)) {
        changedKeys.push(key);
      }
    }

    if (changedKeys.length > 0) {
      console.log(`[Config] K8s secrets updated — changed keys: ${changedKeys.join(', ')}`);
    }

    this.cachedSecrets = freshSecrets;
    this.cacheExpiresAt = Date.now() + this.cacheExpiryMs;
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.initialized) return undefined;

    // Re-read from disk if cache expired (with thundering herd protection)
    if (Date.now() > this.cacheExpiresAt) {
      if (!this.refetchPromise) {
        this.refetchPromise = this.reReadSecrets()
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

    // Re-read from disk if cache expired (with thundering herd protection)
    if (Date.now() > this.cacheExpiresAt) {
      if (!this.refetchPromise) {
        this.refetchPromise = this.reReadSecrets()
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

  async close(): Promise<void> {
    this.initialized = false;
    this.cachedSecrets = {};
    this.cacheExpiresAt = 0;
  }
}
