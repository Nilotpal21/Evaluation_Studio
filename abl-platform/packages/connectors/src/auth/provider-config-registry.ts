/**
 * ProviderConfigRegistry
 *
 * Loads 600+ OAuth2 provider configs generated from Nango's providers.yaml.
 * Used by ConnectionResolver to look up token URLs, refresh URLs, and other
 * OAuth2 provider metadata without hardcoding.
 *
 * Run `pnpm connectors:import-providers` to regenerate the provider configs.
 */

import type { ProviderConfig } from '../adapters/nango/provider-mapper.js';

// Import generated provider data (checked into repo, no runtime fetch)
// Uses require-style for JSON — the generated file is a JSON array of ProviderConfig.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const providerData: ProviderConfig[] = require('../adapters/nango/generated/providers.json');

const providers = new Map<string, ProviderConfig>();
for (const p of providerData) {
  providers.set(p.name.toLowerCase(), p);
}

/** Look up a provider config by name (case-insensitive). */
export function getProviderConfig(name: string): ProviderConfig | undefined {
  return providers.get(name.toLowerCase());
}

/** Register a provider config programmatically (used by tests). */
export function registerProvider(config: ProviderConfig): void {
  providers.set(config.name.toLowerCase(), config);
}

/** List all available provider configs. */
export function listProviders(): ProviderConfig[] {
  return Array.from(providers.values());
}
