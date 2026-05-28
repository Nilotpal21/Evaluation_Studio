/**
 * Composite Vault Provider
 *
 * Chains multiple vault providers in priority order.
 * The first provider that returns a value wins.
 */

import type { VaultProvider } from './index.js';

export class CompositeVaultProvider implements VaultProvider {
  readonly name = 'composite';
  private providers: VaultProvider[] = [];
  private failedProviders: string[] = [];
  private succeededProviders: string[] = [];

  constructor(providers: VaultProvider[]) {
    this.providers = providers;
  }

  async initialize(): Promise<void> {
    this.failedProviders = [];
    this.succeededProviders = [];

    for (const provider of this.providers) {
      try {
        await provider.initialize();
        this.succeededProviders.push(provider.name);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Config] Composite: provider "${provider.name}" failed: ${message}`);
        this.failedProviders.push(provider.name);
      }
    }

    // If ALL providers failed, throw — the system cannot function
    if (this.providers.length > 0 && this.failedProviders.length === this.providers.length) {
      throw new Error(
        `[Config] Composite: all providers failed to initialize: ${this.failedProviders.join(', ')}`,
      );
    }
  }

  async get(key: string): Promise<string | undefined> {
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      const value = await provider.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async getAll(prefix?: string): Promise<Record<string, string>> {
    // Merge from lowest priority to highest so higher-priority values win
    const merged: Record<string, string> = {};

    for (let i = this.providers.length - 1; i >= 0; i--) {
      const provider = this.providers[i];
      if (!provider.isAvailable()) continue;
      const values = await provider.getAll(prefix);
      Object.assign(merged, values);
    }

    return merged;
  }

  isAvailable(): boolean {
    // Only available if at least one provider is available (not all failed)
    if (this.providers.length > 0 && this.failedProviders.length === this.providers.length) {
      return false;
    }
    return this.providers.some((p) => p.isAvailable());
  }

  async close(): Promise<void> {
    for (const provider of this.providers) {
      await provider.close();
    }
  }

  /**
   * Returns the status of each provider after initialization.
   */
  getProviderStatus(): {
    succeeded: string[];
    failed: string[];
  } {
    return {
      succeeded: [...this.succeededProviders],
      failed: [...this.failedProviders],
    };
  }

  /** Watch all providers that support watching */
  watch(callback: (changedKeys: string[]) => void): void {
    for (const provider of this.providers) {
      if (provider.watch) {
        provider.watch(callback);
      }
    }
  }

  /** Delegate set to the first provider that supports writes and is available */
  async set(key: string, value: string): Promise<void> {
    for (const provider of this.providers) {
      if (provider.set && provider.isAvailable()) {
        await provider.set(key, value);
        return;
      }
    }
    throw new Error('No provider supports writes');
  }

  /** Delegate delete to the first provider that supports deletes and is available */
  async delete(key: string): Promise<void> {
    for (const provider of this.providers) {
      if (provider.delete && provider.isAvailable()) {
        await provider.delete(key);
        return;
      }
    }
    throw new Error('No provider supports deletes');
  }
}
