/**
 * Nango Provider Config Mapper
 *
 * Maps Nango's open-source provider YAML/JSON definitions into our
 * standardized provider config format. These configs contain OAuth URLs,
 * scopes, token endpoints, and PKCE settings.
 *
 * Nango's providers.yaml is fetched at BUILD TIME from:
 * https://raw.githubusercontent.com/NangoHQ/nango/master/packages/providers/providers.yaml
 *
 * We only use it as static reference data — Nango itself is not a runtime dependency.
 */

export type ProviderParamValue = string | number | boolean;

export interface NangoConnectionConfigField {
  type: string;
  title?: string;
  description?: string;
  format?: string;
  pattern?: string;
  example?: string;
  prefix?: string;
  optional?: boolean;
  automated?: boolean;
  doc_section?: string;
  enum?: string[];
  default?: string | number | boolean;
}

export interface ProviderConnectionConfigField {
  type: string;
  title?: string;
  description?: string;
  format?: string;
  pattern?: string;
  example?: string;
  prefix?: string;
  optional?: boolean;
  automated?: boolean;
  docSection?: string;
  enum?: string[];
  default?: string | number | boolean;
}

export type ProviderConnectionConfig = Record<string, ProviderConnectionConfigField>;

/** Nango provider entry (subset of their YAML schema) */
export interface NangoProvider {
  auth_mode: 'OAUTH2' | 'OAUTH1' | 'API_KEY' | 'BASIC' | 'NONE';
  authorization_url?: string;
  token_url?: string;
  authorization_params?: Record<string, ProviderParamValue>;
  token_params?: Record<string, ProviderParamValue>;
  scope_separator?: string;
  default_scopes?: string[];
  pkce?: boolean;
  refresh_url?: string;
  docs?: string;
  connection_config?: Record<string, NangoConnectionConfigField>;
  proxy?: {
    base_url: string;
    headers?: Record<string, string>;
  };
}

/** Our standardized provider config output */
export interface ProviderConfig {
  name: string;
  authMode: 'oauth2' | 'oauth1' | 'api_key' | 'basic' | 'none';
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  authorizationParams?: Record<string, ProviderParamValue>;
  tokenParams?: Record<string, ProviderParamValue>;
  connectionConfig?: ProviderConnectionConfig;
  scopeSeparator: string;
  defaultScopes: string[];
  pkce: boolean;
  docsUrl?: string;
  proxyBaseUrl?: string;
  proxyHeaders?: Record<string, string>;
}

function mapConnectionConfig(
  connectionConfig?: NangoProvider['connection_config'],
): ProviderConnectionConfig | undefined {
  if (!connectionConfig) {
    return undefined;
  }

  const mappedEntries = Object.entries(connectionConfig).map(([key, field]) => [
    key,
    {
      type: field.type,
      title: field.title,
      description: field.description,
      format: field.format,
      pattern: field.pattern,
      example: field.example,
      prefix: field.prefix,
      optional: field.optional,
      automated: field.automated,
      docSection: field.doc_section,
      enum: field.enum,
      default: field.default,
    } satisfies ProviderConnectionConfigField,
  ]);

  return Object.fromEntries(mappedEntries);
}

/** Maps a Nango auth_mode to our auth mode */
export function mapAuthMode(nangoMode: NangoProvider['auth_mode']): ProviderConfig['authMode'] {
  switch (nangoMode) {
    case 'OAUTH2':
      return 'oauth2';
    case 'OAUTH1':
      return 'oauth1';
    case 'API_KEY':
      return 'api_key';
    case 'BASIC':
      return 'basic';
    case 'NONE':
      return 'none';
    default:
      return 'none';
  }
}

/** Maps a single Nango provider entry → our ProviderConfig */
export function mapNangoProvider(name: string, nango: NangoProvider): ProviderConfig {
  return {
    name,
    authMode: mapAuthMode(nango.auth_mode),
    authorizationUrl: nango.authorization_url,
    tokenUrl: nango.token_url,
    refreshUrl: nango.refresh_url ?? nango.token_url,
    authorizationParams: nango.authorization_params,
    tokenParams: nango.token_params,
    connectionConfig: mapConnectionConfig(nango.connection_config),
    scopeSeparator: nango.scope_separator ?? ' ',
    defaultScopes: nango.default_scopes ?? [],
    pkce: nango.pkce ?? false,
    docsUrl: nango.docs,
    proxyBaseUrl: nango.proxy?.base_url,
    proxyHeaders: nango.proxy?.headers,
  };
}

/** Maps a full providers dictionary → array of ProviderConfigs */
export function mapAllProviders(providers: Record<string, NangoProvider>): ProviderConfig[] {
  return Object.entries(providers).map(([name, config]) => mapNangoProvider(name, config));
}

/** Filters to only OAuth2 providers (most useful for our connector auth) */
export function filterOAuth2Providers(configs: ProviderConfig[]): ProviderConfig[] {
  return configs.filter((c) => c.authMode === 'oauth2');
}
