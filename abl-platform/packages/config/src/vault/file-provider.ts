/**
 * File-based Provider
 *
 * Reads secrets from an encrypted local file using the 'conf' package.
 * Useful for local development with encrypted secrets.
 */

import type { VaultProvider } from './index.js';

interface ConfStore {
  get(key: string): string | undefined;
  get(key: string, defaultValue: string): string;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  store: Record<string, unknown>;
}

export class FileProvider implements VaultProvider {
  readonly name = 'file';
  private store: ConfStore | null = null;
  private configPath: string | undefined;

  constructor(options?: { configPath?: string }) {
    this.configPath = options?.configPath;
  }

  async initialize(): Promise<void> {
    try {
      // Dynamic import — conf is optional
      const Conf = ((await Function('return import("conf")')()) as { default: unknown })
        .default as new (opts: Record<string, unknown>) => ConfStore;

      this.store = new Conf({
        projectName: 'kore-platform',
        encryptionKey: process.env.CONFIG_ENCRYPTION_KEY,
        configName: 'secrets',
        cwd: this.configPath,
      });
    } catch (error) {
      console.warn('[Config] File provider unavailable: conf package not installed');
      throw error;
    }
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.store) return undefined;
    return this.store.get(key);
  }

  async getAll(prefix?: string): Promise<Record<string, string>> {
    if (!this.store) return {};

    const result: Record<string, string> = {};
    const allData = this.store.store;

    for (const [key, value] of Object.entries(allData)) {
      if (typeof value !== 'string') continue;
      if (prefix && !key.startsWith(prefix)) continue;
      result[key] = value;
    }

    return result;
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.store) throw new Error('FileProvider not initialized');
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    if (!this.store) throw new Error('FileProvider not initialized');
    this.store.delete(key);
  }

  isAvailable(): boolean {
    return this.store !== null;
  }

  async close(): Promise<void> {
    this.store = null;
  }
}
