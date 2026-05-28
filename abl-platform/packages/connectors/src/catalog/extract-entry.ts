/**
 * Extract serializable catalog metadata from a loaded Connector.
 * Strips all functions — output is safe for JSON.stringify.
 */

import type { Connector } from '../types.js';
import type {
  ProviderConfig,
  ProviderConnectionConfig,
  ProviderConnectionConfigField,
  ProviderParamValue,
} from '../adapters/nango/provider-mapper.js';

const CONNECTION_CONFIG_TEMPLATE_RE =
  /\$\{connectionConfig\.([A-Za-z0-9_]+)\}|\{([A-Za-z0-9_]+)\}/g;

export interface CatalogEntry {
  name: string;
  displayName: string;
  version: string;
  description: string;
  category: string;
  authType: string;
  actions: { name: string; displayName: string; description: string }[];
  triggers: {
    name: string;
    displayName: string;
    description: string;
    props: Array<{
      name: string;
      displayName: string;
      description?: string;
      type: string;
      required: boolean;
      defaultValue?: unknown;
      options?: Array<{ label: string; value: string | number }>;
      refreshers?: string[];
    }>;
  }[];
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    authorizationParams?: Record<string, ProviderParamValue>;
    tokenParams?: Record<string, ProviderParamValue>;
    connectionConfig?: ProviderConnectionConfig;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
}

function titleCaseKey(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function collectTemplateKeys(value?: string): string[] {
  if (!value) {
    return [];
  }

  const matches = value.matchAll(CONNECTION_CONFIG_TEMPLATE_RE);
  const keys = new Set<string>();
  for (const match of matches) {
    const key = match[1] ?? match[2];
    if (key) {
      keys.add(key);
    }
  }

  return [...keys];
}

function inferConnectionConfigFromSource(value?: string): ProviderConnectionConfig {
  if (!value) {
    return {};
  }

  const branches = value
    .split('||')
    .map((branch) => branch.trim())
    .filter(Boolean);
  const branchKeys = branches.map((branch) => new Set(collectTemplateKeys(branch)));
  const allKeys = new Set(branchKeys.flatMap((keys) => [...keys]));
  const inferredConfig: ProviderConnectionConfig = {};

  for (const key of allKeys) {
    const appearsInEveryBranch = branchKeys.every((keys) => keys.has(key));
    const field: ProviderConnectionConfigField = {
      type: 'string',
      title: titleCaseKey(key),
      optional: branches.length > 1 && !appearsInEveryBranch,
    };

    if (key.includes('hostname')) {
      field.format = 'hostname';
    }
    if (key.endsWith('url') || key.includes('_url')) {
      field.format = 'uri';
    }
    if (value.includes(`https://\${connectionConfig.${key}}`)) {
      field.prefix = 'https://';
    }

    inferredConfig[key] = field;
  }

  return inferredConfig;
}

function inferConnectionConfigFromParamValues(
  params?: Record<string, ProviderParamValue>,
): ProviderConnectionConfig | undefined {
  if (!params) {
    return undefined;
  }

  return mergeConnectionConfig(
    ...Object.values(params)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => inferConnectionConfigFromSource(value)),
  );
}

function mergeConnectionConfig(
  ...configs: Array<ProviderConnectionConfig | undefined>
): ProviderConnectionConfig | undefined {
  const merged: ProviderConnectionConfig = {};

  for (const config of configs) {
    if (!config) {
      continue;
    }
    for (const [key, field] of Object.entries(config)) {
      merged[key] = {
        ...(merged[key] ?? {}),
        ...field,
      };
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function getProviderConnectionConfig(
  provider: ProviderConfig,
  existingOAuth?: CatalogEntry['oauth2'],
): ProviderConnectionConfig | undefined {
  const providerConnectionConfig = mergeConnectionConfig(
    inferConnectionConfigFromSource(provider.authorizationUrl),
    inferConnectionConfigFromSource(provider.tokenUrl),
    inferConnectionConfigFromSource(provider.refreshUrl),
    inferConnectionConfigFromSource(provider.proxyBaseUrl),
    inferConnectionConfigFromParamValues(provider.authorizationParams),
    inferConnectionConfigFromParamValues(provider.tokenParams),
    provider.connectionConfig,
  );
  if (providerConnectionConfig) {
    return providerConnectionConfig;
  }

  return mergeConnectionConfig(
    inferConnectionConfigFromSource(existingOAuth?.authorizationUrl),
    inferConnectionConfigFromSource(existingOAuth?.tokenUrl),
    inferConnectionConfigFromSource(existingOAuth?.refreshUrl),
  );
}

function shouldPreferProviderUrls(
  existingOAuth: NonNullable<CatalogEntry['oauth2']>,
  providerConnectionConfig?: ProviderConnectionConfig,
): boolean {
  if (!providerConnectionConfig || Object.keys(providerConnectionConfig).length === 0) {
    return false;
  }

  return [existingOAuth.authorizationUrl, existingOAuth.tokenUrl, existingOAuth.refreshUrl].some(
    (url) => typeof url === 'string' && /\{[A-Za-z0-9_]+\}/.test(url),
  );
}

export function extractCatalogEntry(connector: Connector, category: string): CatalogEntry {
  const entry: CatalogEntry = {
    name: connector.name,
    displayName: connector.displayName,
    version: connector.version,
    description: connector.description,
    category,
    authType: connector.auth.type,
    actions: connector.actions.map((a) => ({
      name: a.name,
      displayName: a.displayName,
      description: a.description,
    })),
    triggers: connector.triggers.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      props: t.props.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        description: p.description,
        type: p.type,
        required: p.required,
        defaultValue: p.defaultValue,
        options: p.options,
        refreshers: p.refreshers,
      })),
    })),
  };

  // Extract OAuth2 config directly from the connector's auth metadata
  if (connector.auth.type === 'oauth2' && connector.auth.oauth2) {
    entry.oauth2 = {
      authorizationUrl: connector.auth.oauth2.authorizationUrl,
      tokenUrl: connector.auth.oauth2.tokenUrl,
      defaultScopes: connector.auth.oauth2.scopes ?? [],
      scopeSeparator: ' ',
      pkce: connector.auth.oauth2.pkce ?? false,
    };
  }

  return entry;
}

/**
 * Connectors that support API key auth via the same Bearer token field as OAuth2,
 * but have no Nango secondary provider config. normalizeAuthForAP() maps
 * { apiKey } to { props: { ..., accessToken: apiKey } } for these connectors.
 * Fixed two-entry array — no dynamic growth, no eviction needed.
 */
export const DIRECT_API_KEY_CONNECTORS = ['zendesk', 'servicenow'] as const;

/**
 * Manual alias map for connectors whose catalog name differs from their Nango provider name.
 * Key: catalog connector name, Value: Nango provider name.
 */
export const NANGO_ALIAS_MAP: Record<string, string> = {
  'jira-cloud': 'jira',
  'microsoft-teams': 'microsoft',
  'microsoft-dynamics-365-business-central': 'microsoft-business-central',
  claude: 'anthropic',
  // Google sub-products map to the umbrella `google` provider so OAuth gets
  // `access_type=offline` + `prompt=consent` — without these, Google does
  // not reliably issue a refresh_token and workflows fail with
  // AUTH_PROFILE_TOKEN_REQUIRED after the first access-token expiry.
  gmail: 'google',
  'google-sheets': 'google',
  'google-drive': 'google',
  'google-calendar': 'google',
};

function hasOAuthProviderUrls(
  provider?: Pick<ProviderConfig, 'authorizationUrl' | 'tokenUrl'>,
): boolean {
  return Boolean(provider?.authorizationUrl && provider?.tokenUrl);
}

export function selectPreferredNangoProvider<
  T extends { authorizationUrl?: string; tokenUrl?: string },
>(exactProvider: T | undefined, aliasProvider: T | undefined): T | undefined {
  if (!aliasProvider) {
    return exactProvider;
  }
  if (!exactProvider) {
    return aliasProvider;
  }
  if (!hasOAuthProviderUrls(exactProvider) && hasOAuthProviderUrls(aliasProvider)) {
    return aliasProvider;
  }
  return exactProvider;
}

/**
 * Secondary Nango provider names for connectors that support multiple auth modes.
 * e.g. Shopify has both `shopify` (OAuth2) and `shopify-api-key` (API_KEY).
 * Key: catalog connector name, Value: array of secondary Nango provider names.
 */
export const NANGO_SECONDARY_PROVIDERS: Record<string, string[]> = {
  shopify: ['shopify-cc', 'shopify-api-key'],
  github: ['github-pat'],
};

/**
 * Enrich a catalog entry with OAuth2 metadata from Nango provider configs.
 * Matches by connector name (exact, hyphen→underscore, or manual alias map).
 * Works for any catalog authType — connectors with authType 'custom' or 'none'
 * can be resolved to OAuth2 if a Nango provider entry exists.
 */
export function enrichWithOAuth(entry: CatalogEntry, providers: ProviderConfig[]): CatalogEntry {
  const alias = NANGO_ALIAS_MAP[entry.name];
  const exactProvider =
    providers.find((p) => p.name === entry.name) ??
    providers.find((p) => p.name === entry.name.replaceAll('-', '_'));
  const aliasProvider = alias != null ? providers.find((p) => p.name === alias) : undefined;
  const provider = selectPreferredNangoProvider(exactProvider, aliasProvider);
  if (!provider || !provider.authorizationUrl || !provider.tokenUrl) return entry;

  const existingOAuth = entry.oauth2;
  const providerConnectionConfig = getProviderConnectionConfig(provider, existingOAuth);
  if (existingOAuth) {
    const preferProviderUrls = shouldPreferProviderUrls(existingOAuth, providerConnectionConfig);
    return {
      ...entry,
      oauth2: {
        authorizationUrl: preferProviderUrls
          ? (provider.authorizationUrl ?? existingOAuth.authorizationUrl)
          : existingOAuth.authorizationUrl,
        tokenUrl: preferProviderUrls
          ? (provider.tokenUrl ?? existingOAuth.tokenUrl)
          : existingOAuth.tokenUrl,
        refreshUrl:
          preferProviderUrls && provider.refreshUrl
            ? provider.refreshUrl
            : (existingOAuth.refreshUrl ?? provider.refreshUrl),
        authorizationParams: provider.authorizationParams,
        tokenParams: provider.tokenParams,
        connectionConfig: providerConnectionConfig,
        defaultScopes:
          existingOAuth.defaultScopes.length > 0
            ? existingOAuth.defaultScopes
            : provider.defaultScopes,
        scopeSeparator: provider.scopeSeparator,
        pkce: existingOAuth.pkce || provider.pkce,
      },
    };
  }

  return {
    ...entry,
    authType: entry.authType === 'oauth2' ? 'oauth2' : entry.authType,
    oauth2: {
      authorizationUrl: provider.authorizationUrl,
      tokenUrl: provider.tokenUrl,
      refreshUrl: provider.refreshUrl,
      authorizationParams: provider.authorizationParams,
      tokenParams: provider.tokenParams,
      connectionConfig: providerConnectionConfig,
      defaultScopes: provider.defaultScopes,
      scopeSeparator: provider.scopeSeparator,
      pkce: provider.pkce,
    },
  };
}
