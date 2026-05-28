/**
 * Generate Static Connector Catalog
 *
 * Loads all AP pieces in Node (not Turbopack), extracts display metadata,
 * and writes connector-catalog.json. This file is committed to the repo
 * and served by Studio — Studio never imports AP piece code.
 *
 * Usage: pnpm connectors:generate-catalog
 * Check: pnpm connectors:generate-catalog --check
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatJson } from './format-json.js';
import { ConnectorRegistry } from '../packages/connectors/src/registry.js';
import { loadConnectors } from '../packages/connectors/src/loader.js';
import {
  extractCatalogEntry,
  enrichWithOAuth,
} from '../packages/connectors/src/catalog/extract-entry.js';
import type { CatalogEntry } from '../packages/connectors/src/catalog/extract-entry.js';
import type { ProviderConfig } from '../packages/connectors/src/adapters/nango/provider-mapper.js';
import { assertCatalogOAuthProvidersAvailable } from '../packages/connectors/src/generated-artifact-guards.js';

// Category mapping (mirrors apps/studio/src/components/connections/connector-categories.ts)
const CONNECTOR_CATEGORIES: Record<string, string> = {
  slack: 'communication',
  discord: 'communication',
  'microsoft-teams': 'communication',
  'microsoft-outlook': 'communication',
  'amazon-ses': 'communication',
  'amazon-sns': 'communication',
  gmail: 'communication',
  twilio: 'communication',
  sendgrid: 'communication',
  'microsoft-sharepoint': 'productivity',
  'microsoft-outlook-calendar': 'productivity',
  'microsoft-power-bi': 'productivity',
  notion: 'productivity',
  asana: 'productivity',
  clickup: 'productivity',
  'jira-cloud': 'productivity',
  linear: 'productivity',
  'google-calendar': 'productivity',
  'google-drive': 'storage',
  'amazon-s3': 'storage',
  'azure-blob-storage': 'storage',
  'microsoft-onedrive': 'storage',
  'google-sheets': 'storage',
  airtable: 'storage',
  postgres: 'storage',
  'amazon-sqs': 'custom',
  hubspot: 'crm',
  'microsoft-dynamics-365-business-central': 'crm',
  salesforce: 'crm',
  pipedrive: 'crm',
  shopify: 'crm',
  stripe: 'crm',
  openai: 'ai_dev',
  claude: 'ai_dev',
  github: 'ai_dev',
  zendesk: 'service_management',
  servicenow: 'service_management',
  http: 'custom',
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'packages', 'connectors', 'src', 'generated');
const OUTPUT_FILE = join(OUTPUT_DIR, 'connector-catalog.json');

async function main(): Promise<void> {
  const isCheck = process.argv.includes('--check');

  // Load all connectors via the existing loader (runs in Node, not Turbopack)
  const registry = new ConnectorRegistry();
  await loadConnectors(registry);

  const connectors = registry.listConnectors();
  console.log(`Loaded ${connectors.length} connectors`);

  // Extract catalog entries
  const catalog: CatalogEntry[] = connectors.map((c) =>
    extractCatalogEntry(c, CONNECTOR_CATEGORIES[c.name] ?? 'custom'),
  );

  // Load Nango provider configs
  let nangoProviders: ProviderConfig[] = [];
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
  try {
    nangoProviders = JSON.parse(readFileSync(providersPath, 'utf-8')) as ProviderConfig[];
  } catch (err) {
    throw new Error(
      `Failed to load Nango providers from ${providersPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`Loaded ${nangoProviders.length} Nango OAuth2 providers`);
  assertCatalogOAuthProvidersAvailable(catalog, nangoProviders);

  // Enrich catalog with OAuth metadata
  const enrichedCatalog = catalog.map((entry) => enrichWithOAuth(entry, nangoProviders));

  // Sort by category then name for deterministic output
  enrichedCatalog.sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );

  const output = await formatJson(enrichedCatalog);

  if (isCheck) {
    try {
      const existing = readFileSync(OUTPUT_FILE, 'utf-8');
      if (existing === output) {
        console.log('connector-catalog.json is up to date');
        process.exit(0);
      } else {
        console.error('connector-catalog.json is STALE. Run: pnpm connectors:generate-catalog');
        process.exit(1);
      }
    } catch {
      console.error('connector-catalog.json does not exist. Run: pnpm connectors:generate-catalog');
      process.exit(1);
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, output);
  console.log(`Written ${enrichedCatalog.length} entries to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Failed to generate catalog:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
