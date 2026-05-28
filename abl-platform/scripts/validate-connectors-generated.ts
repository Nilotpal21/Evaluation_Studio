import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderConfig } from '../packages/connectors/src/adapters/nango/provider-mapper.js';
import type { CatalogEntry } from '../packages/connectors/src/catalog/extract-entry.js';
import {
  assertGeneratedCatalogPopulated,
  assertGeneratedProvidersPopulated,
} from '../packages/connectors/src/generated-artifact-guards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providersPath = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'adapters',
  'nango',
  'generated',
  'providers.json',
);
const catalogPath = join(
  __dirname,
  '..',
  'packages',
  'connectors',
  'src',
  'generated',
  'connector-catalog.json',
);

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

async function main(): Promise<void> {
  const providers = readJsonFile<ProviderConfig[]>(providersPath);
  assertGeneratedProvidersPopulated(providers, `Connectors build validation (${providersPath})`);
  console.log(`Validated ${providers.length} Nango OAuth2 providers`);

  const catalog = readJsonFile<CatalogEntry[]>(catalogPath);
  assertGeneratedCatalogPopulated(catalog, `Connectors build validation (${catalogPath})`);
  console.log(`Validated ${catalog.length} connector catalog entries`);
}

main().catch((err) => {
  console.error(
    'Generated connectors artifact validation failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
