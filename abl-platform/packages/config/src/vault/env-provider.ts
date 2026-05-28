/**
 * Environment Variable Provider
 *
 * Default provider that reads from process.env.
 * Filters to only return env vars in the known mapping allowlist
 * to prevent leaking unrelated environment variables.
 */

import type { VaultProvider } from './index.js';
import { BASE_ENV_MAPPING } from '../env-mapping.js';

/** Essential env vars always included in the allowlist */
const ESSENTIAL_VARS = ['NODE_ENV', 'PORT', 'HOST'];

export class EnvProvider implements VaultProvider {
  readonly name = 'env';
  private allowlist: Set<string>;

  constructor(options?: { allowedKeys?: string[] }) {
    // Build allowlist from known env mapping keys + essentials + caller overrides
    this.allowlist = new Set<string>([
      ...Object.keys(BASE_ENV_MAPPING),
      ...ESSENTIAL_VARS,
      ...(options?.allowedKeys ?? []),
    ]);
  }

  async initialize(): Promise<void> {
    // No initialization needed for env vars
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.allowlist.has(key)) return undefined;
    return process.env[key];
  }

  async getAll(prefix?: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (!this.allowlist.has(key)) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      result[key] = value;
    }

    return result;
  }

  isAvailable(): boolean {
    return true;
  }

  async close(): Promise<void> {
    // No cleanup needed
  }

  async set(key: string, value: string): Promise<void> {
    process.env[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete process.env[key];
  }
}
