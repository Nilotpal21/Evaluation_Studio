/**
 * Connector Catalog Enrichment
 *
 * Pure helpers for the project-scoped connector catalog response. Kept
 * dependency-free so they can be unit-tested without Next.js, mongoose,
 * or platform mocks.
 */

export interface ConnectorCatalogEntry {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  authType?: string;
  actions?: Array<{ name: string; displayName: string; description?: string }>;
  triggers?: Array<{ name: string; displayName: string; description?: string }>;
}

export interface EnrichmentProvider {
  connectorName: string;
  displayName: string;
  description?: string;
  category?: string;
  availableAuthTypes: string[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    authorizationParams?: Record<string, unknown>;
    tokenParams?: Record<string, unknown>;
    defaultScopes?: string[];
    scopeSeparator?: string;
    pkce?: boolean;
    connectionConfigFields?: string[];
  };
  connectionConfig?: Record<string, unknown>;
}

export interface EnrichedConnector {
  name: string;
  displayName: string;
  description?: string;
  category?: string;
  authType: string;
  availableAuthTypes: string[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    authorizationParams?: Record<string, unknown>;
    tokenParams?: Record<string, unknown>;
    connectionConfig?: Record<string, unknown>;
    defaultScopes?: string[];
    scopeSeparator: string;
    pkce?: boolean;
  };
  actions: NonNullable<ConnectorCatalogEntry['actions']>;
  triggers: NonNullable<ConnectorCatalogEntry['triggers']>;
}

const primaryAuthTypePriority = [
  'oauth2',
  'oauth2_client_credentials',
  'azure_ad',
  'api_key',
  'basic',
  'aws_iam',
  'mtls',
] as const;

// Utility connectors that the project-scoped connector picker should not
// surface as integrations. They remain available elsewhere (raw HTTP tool
// definitions, direct DB connections), but the auth-aware connector list is
// for selecting external systems to connect, not built-in primitives.
export const PROJECT_CONNECTOR_HIDDEN_NAMES: ReadonlySet<string> = new Set(['http', 'postgres']);

export function pickPrimaryAuthType(availableAuthTypes: string[]): string {
  for (const candidate of primaryAuthTypePriority) {
    if (availableAuthTypes.includes(candidate)) {
      return candidate;
    }
  }
  return availableAuthTypes[0] ?? 'none';
}

export function enrichProvidersWithCatalog(
  providers: EnrichmentProvider[],
  catalog: ConnectorCatalogEntry[],
): EnrichedConnector[] {
  const catalogByName = new Map(catalog.map((entry) => [entry.name, entry]));

  return providers.map((provider) => {
    const catalogEntry = catalogByName.get(provider.connectorName);
    const connectionConfig =
      provider.oauth2?.connectionConfigFields && provider.connectionConfig
        ? Object.fromEntries(
            provider.oauth2.connectionConfigFields
              .map((fieldKey): [string, unknown] | null => {
                const fieldMeta = provider.connectionConfig?.[fieldKey];
                return fieldMeta ? [fieldKey, fieldMeta] : null;
              })
              .filter((entry): entry is [string, unknown] => entry !== null),
          )
        : undefined;

    return {
      name: provider.connectorName,
      displayName: provider.displayName,
      description: provider.description,
      category: provider.category,
      authType: pickPrimaryAuthType(provider.availableAuthTypes),
      availableAuthTypes: provider.availableAuthTypes,
      oauth2: provider.oauth2
        ? {
            authorizationUrl: provider.oauth2.authorizationUrl,
            tokenUrl: provider.oauth2.tokenUrl,
            refreshUrl: provider.oauth2.refreshUrl,
            authorizationParams: provider.oauth2.authorizationParams,
            tokenParams: provider.oauth2.tokenParams,
            connectionConfig,
            defaultScopes: provider.oauth2.defaultScopes,
            scopeSeparator: provider.oauth2.scopeSeparator ?? ' ',
            pkce: provider.oauth2.pkce,
          }
        : undefined,
      actions: catalogEntry?.actions ?? [],
      triggers: catalogEntry?.triggers ?? [],
    };
  });
}
