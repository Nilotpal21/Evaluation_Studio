import type { ProviderConfig } from './adapters/nango/provider-mapper.js';
import type { CatalogEntry } from './catalog/extract-entry.js';

const IMPORT_PROVIDERS_COMMAND = 'pnpm connectors:import-providers';
const GENERATE_CATALOG_COMMAND = 'pnpm connectors:generate-catalog';

export function assertGeneratedProvidersPopulated(
  providers: ProviderConfig[],
  context: string,
): void {
  if (providers.length > 0) {
    return;
  }

  throw new Error(
    `${context} found an empty Nango provider registry. Run ${IMPORT_PROVIDERS_COMMAND} to regenerate providers.json.`,
  );
}

export function assertGeneratedCatalogPopulated(catalog: CatalogEntry[], context: string): void {
  if (catalog.length > 0) {
    return;
  }

  throw new Error(
    `${context} found an empty connector catalog. Run ${GENERATE_CATALOG_COMMAND} to regenerate connector-catalog.json.`,
  );
}

export function assertCatalogOAuthProvidersAvailable(
  catalog: CatalogEntry[],
  providers: ProviderConfig[],
): void {
  if (providers.length > 0) {
    return;
  }

  const oauth2ConnectorCount = catalog.filter((entry) => entry.authType === 'oauth2').length;
  if (oauth2ConnectorCount === 0) {
    return;
  }

  throw new Error(
    `Connector catalog generation found ${oauth2ConnectorCount} OAuth2 connectors but the Nango provider registry is empty. Run ${IMPORT_PROVIDERS_COMMAND} before ${GENERATE_CATALOG_COMMAND}.`,
  );
}
