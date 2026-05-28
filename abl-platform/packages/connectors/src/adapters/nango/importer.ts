/**
 * Nango Provider Config Importer
 *
 * Maps Nango's providers.yaml structure into static JSON files
 * per provider. These JSON files are checked into the repo and used
 * by our OAuth connection flow at runtime.
 *
 * The actual YAML fetching/parsing happens in the CLI script
 * (scripts/import-providers.ts) which depends on the `yaml` package.
 * This module contains only pure mapping and generation functions.
 *
 * Usage: pnpm connectors:import-providers
 */

import { mapAllProviders, filterOAuth2Providers } from './provider-mapper.js';
import type { NangoProvider, ProviderConfig } from './provider-mapper.js';

/** Nango providers.yaml source URL (used by CLI scripts) */
export const NANGO_PROVIDERS_URL =
  'https://raw.githubusercontent.com/NangoHQ/nango/master/packages/providers/providers.yaml';

/**
 * Import providers from raw data and return ProviderConfig[].
 * Optionally filter to OAuth2 only.
 */
export function importProviders(
  rawProviders: Record<string, NangoProvider>,
  options?: { oauth2Only?: boolean },
): ProviderConfig[] {
  const allConfigs = mapAllProviders(rawProviders);
  return options?.oauth2Only ? filterOAuth2Providers(allConfigs) : allConfigs;
}

/**
 * Generate a single JSON file content for a provider config.
 */
export function generateProviderJson(config: ProviderConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Generate an index.ts barrel file that re-exports all providers.
 */
export function generateProviderIndex(providerNames: string[]): string {
  const imports = providerNames
    .map((name) => {
      const varName = name.replace(/[-. ]/g, '_');
      return `import ${varName}Config from './${name}.json' with { type: 'json' };`;
    })
    .join('\n');

  const entries = providerNames
    .map((name) => {
      const varName = name.replace(/[-. ]/g, '_');
      return `  '${name}': ${varName}Config,`;
    })
    .join('\n');

  return `/**
 * Provider Configs — auto-generated from Nango providers.yaml
 * DO NOT EDIT MANUALLY
 */

${imports}

export const providerConfigs: Record<string, unknown> = {
${entries}
};
`;
}
