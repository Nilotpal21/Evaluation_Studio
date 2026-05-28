/**
 * Import Nango Provider Configs
 *
 * Fetches Nango's providers.yaml from GitHub, maps OAuth2 providers
 * into our standardized format, and writes a generated JSON file.
 *
 * Usage: pnpm connectors:import-providers
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { formatJson } from './format-json.js';
import {
  importProviders,
  NANGO_PROVIDERS_URL,
} from '../packages/connectors/src/adapters/nango/importer.js';
import type { NangoProvider } from '../packages/connectors/src/adapters/nango/provider-mapper.js';
import { assertGeneratedProvidersPopulated } from '../packages/connectors/src/generated-artifact-guards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'adapters',
  'nango',
  'generated',
);
const OUTPUT_FILE = join(OUTPUT_DIR, 'providers.json');

async function main(): Promise<void> {
  console.log(`Fetching Nango providers.yaml from ${NANGO_PROVIDERS_URL}...`);

  const response = await fetch(NANGO_PROVIDERS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch providers.yaml: ${response.status} ${response.statusText}`);
  }

  const yamlText = await response.text();
  const rawProviders = parseYaml(yamlText) as Record<string, NangoProvider>;

  const providerCount = Object.keys(rawProviders).length;
  console.log(`Parsed ${providerCount} providers from YAML`);

  const configs = importProviders(rawProviders);
  console.log(`Imported ${configs.length} providers (all auth modes)`);
  assertGeneratedProvidersPopulated(configs, 'Nango provider import');

  const output = await formatJson(configs);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, output);
  console.log(`Written to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(
    'Failed to import Nango providers:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
