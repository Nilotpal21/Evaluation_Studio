/**
 * Integration Provider Service
 *
 * Shared logic for building the integration provider catalog response.
 * Merges connector-catalog.json entries with Nango OAuth metadata and
 * per-connector auth profile counts (with visibility filtering).
 *
 * Used by both project-scoped and workspace-scoped provider endpoints.
 */

import { getProviderConfig } from '@agent-platform/connectors/auth';
import {
  NANGO_ALIAS_MAP,
  NANGO_SECONDARY_PROVIDERS,
  DIRECT_API_KEY_CONNECTORS,
  selectPreferredNangoProvider,
} from '@agent-platform/connectors/catalog';
import { extractConnectionConfigFields } from './connection-config-utils';
import type { IAuthProfile } from '@agent-platform/database/models';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { AuthType } from '../api/auth-profiles';

const log = createLogger('integration-provider-service');

// Static import of the generated connector catalog JSON
import catalog from '@agent-platform/connectors/catalog/json';

// Microsoft Graph-backed connectors support BOTH:
//   - azure_ad  — service-principal client-credentials (backend automation,
//                 app acts as itself with admin-consented permissions)
//   - oauth2_app — user-delegated OAuth 2.0 (each user signs in; app acts
//                  on their behalf within their permissions)
// Listing both lets the user pick the right mode for their use case.
const CONNECTOR_AUTH_TYPE_OVERRIDES: Record<string, string[]> = {
  twilio: ['basic'],
  'amazon-s3': ['aws_iam'],
  // AP pieces for Microsoft user-acting apps consume `auth.access_token`.
  // Only oauth2_app produces a user token through the AP execution path —
  // azure_ad (client-credentials) is reserved for HTTP/MCP tools that do
  // their own token exchange in resolve-tool-auth.ts.
  'microsoft-teams': ['oauth2_app'],
  'microsoft-onedrive': ['oauth2_app'],
  'microsoft-sharepoint': ['oauth2_app'],
  'microsoft-outlook': ['oauth2_app'],
  'microsoft-outlook-calendar': ['oauth2_app'],
  'microsoft-power-bi': ['oauth2_app'],
  'microsoft-dynamics-365-business-central': ['oauth2_app'],
  // Azure Blob AP piece exclusively uses BlobServiceClient.fromConnectionString.
  // Service principal credentials cannot be converted to a connection string,
  // so the user pastes the storage-account connection string as an api_key.
  'azure-blob-storage': ['api_key'],
  'amazon-ses': ['aws_iam'],
  'amazon-sqs': ['aws_iam'],
  'amazon-sns': ['aws_iam'],
  // Azure DI declares `authType: 'custom'` (PieceAuth.CustomAuth with 4 props:
  // endpoint, apiKey, apiVersion, defaultModel). Studio has no `'custom'`
  // AuthType variant — model it as `api_key` (apiKey is the credential) and
  // surface the other three props via injected `connectionConfig` fields below.
  'azure-document-intelligence': ['api_key'],
};

/**
 * Per-connector `connectionConfig` overrides for catalog entries whose piece
 * declares a `PieceAuth.CustomAuth` shape that isn't sourced from Nango. The
 * AuthProfile slide-over renders any keys present here as additional fields
 * alongside the chosen auth-type form.
 *
 * Storage shape: these values land under `profile.config.connectionConfig.<key>`,
 * which is exactly where the per-connector auth bridges (see
 * `packages/connectors/src/adapters/activepieces/auth-adapters/*.ts`) read them
 * at runtime.
 */
const CONNECTOR_CONNECTION_CONFIG_OVERRIDES: Record<
  string,
  Record<string, ConnectionConfigFieldMeta>
> = {
  'azure-document-intelligence': {
    endpoint: {
      type: 'string',
      title: 'Endpoint',
      description:
        'Azure DI endpoint, e.g. https://<resource>.cognitiveservices.azure.com (no trailing slash). Required — there is no fallback if blank.',
      example: 'https://my-di.cognitiveservices.azure.com',
      required: true,
    },
    apiVersion: {
      type: 'string',
      title: 'API Version',
      description:
        'Azure DI REST API version. Leave blank to use the current GA (2024-11-30). Override only when your Azure resource is pinned to an older API version (e.g. 2023-07-31).',
      example: '2024-11-30',
      default: '2024-11-30',
    },
    // Model is per-action (extract_document.props.model), not per-auth-profile.
  },
};

/**
 * Per-connector `apiKeyConfig` overrides for connectors whose API-key header is
 * fixed by the piece (i.e. not user-configurable). The slide-over uses this to
 * pre-fill the `headerName` field rather than defaulting to the generic
 * `X-API-Key`.
 */
const CONNECTOR_API_KEY_CONFIG_OVERRIDES: Record<string, IntegrationProvider['apiKeyConfig']> = {
  'azure-document-intelligence': {
    headerName: 'Ocp-Apim-Subscription-Key',
  },
};

const MICROSOFT_ENTRA_ENDPOINT = 'https://login.microsoftonline.com';
const MICROSOFT_GRAPH_RESOURCE = 'https://graph.microsoft.com';

const CONNECTOR_AUTH_PREFILL: Record<string, Partial<Record<string, Record<string, unknown>>>> = {
  'amazon-s3': {
    aws_iam: { service: 's3' },
  },
  'amazon-ses': {
    aws_iam: { service: 'ses' },
  },
  'amazon-sqs': {
    aws_iam: { service: 'sqs' },
  },
  'amazon-sns': {
    aws_iam: { service: 'sns' },
  },
  'microsoft-teams': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: MICROSOFT_GRAPH_RESOURCE,
    },
  },
  'microsoft-onedrive': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: MICROSOFT_GRAPH_RESOURCE,
    },
  },
  'microsoft-sharepoint': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: MICROSOFT_GRAPH_RESOURCE,
    },
  },
  'microsoft-outlook': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: MICROSOFT_GRAPH_RESOURCE,
    },
  },
  'microsoft-outlook-calendar': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: MICROSOFT_GRAPH_RESOURCE,
    },
  },
  'microsoft-power-bi': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: 'https://analysis.windows.net/powerbi/api',
    },
  },
  shopify: {
    oauth2_client_credentials: {
      tokenUrl: 'https://${connectionConfig.subdomain}.myshopify.com/admin/oauth/access_token',
      scopes: [],
    },
  },
  'microsoft-dynamics-365-business-central': {
    oauth2_client_credentials: {
      tokenUrl: 'https://login.microsoftonline.com/${connectionConfig.tenantId}/oauth2/v2.0/token',
    },
  },
  'azure-blob-storage': {
    azure_ad: {
      endpoint: MICROSOFT_ENTRA_ENDPOINT,
      resource: 'https://storage.azure.com',
    },
  },
};

type CatalogEntryLike = {
  name: string;
  displayName: string;
  description: string;
  category: string;
  authType: string;
  providerAlias?: string;
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
  };
};

const VIRTUAL_INTEGRATION_CONNECTORS: CatalogEntryLike[] = [
  {
    name: 'microsoft-onedrive',
    displayName: 'Microsoft OneDrive',
    description: 'Cloud file storage and sharing in Microsoft 365.',
    category: 'storage',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'microsoft-sharepoint',
    displayName: 'Microsoft SharePoint',
    description: 'Sites, files, and document collaboration in Microsoft 365.',
    category: 'productivity',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'microsoft-outlook',
    displayName: 'Microsoft Outlook',
    description: 'Email access through Microsoft 365 and Microsoft Graph.',
    category: 'communication',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'microsoft-outlook-calendar',
    displayName: 'Microsoft Outlook Calendar',
    description: 'Calendar access through Microsoft 365 and Microsoft Graph.',
    category: 'productivity',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'microsoft-power-bi',
    displayName: 'Microsoft Power BI',
    description: 'Business intelligence dashboards and reporting in Microsoft.',
    category: 'productivity',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'microsoft-dynamics-365-business-central',
    displayName: 'Microsoft Dynamics 365 Business Central',
    description: 'ERP and business operations in Dynamics 365 Business Central.',
    category: 'crm',
    authType: 'none',
    providerAlias: 'microsoft-business-central',
  },
  {
    name: 'azure-blob-storage',
    displayName: 'Azure Blob Storage',
    description: 'Object storage in Azure Storage accounts.',
    category: 'storage',
    authType: 'none',
    providerAlias: 'microsoft',
  },
  {
    name: 'amazon-ses',
    displayName: 'Amazon SES',
    description: 'Transactional email delivery through Amazon Simple Email Service.',
    category: 'communication',
    authType: 'custom',
  },
  {
    name: 'amazon-sqs',
    displayName: 'Amazon SQS',
    description: 'Managed message queueing with Amazon Simple Queue Service.',
    category: 'custom',
    authType: 'custom',
  },
  {
    name: 'amazon-sns',
    displayName: 'Amazon SNS',
    description: 'Managed pub/sub messaging with Amazon Simple Notification Service.',
    category: 'communication',
    authType: 'custom',
  },
];

// ─── Types ──────────────────────────────────────────────────────────────

export interface ConnectionConfigFieldMeta {
  type: string;
  title?: string;
  description?: string;
  pattern?: string;
  example?: string;
  default?: string | number | boolean;
  /**
   * When true the slide-over renders the field as required (asterisk, no
   * "(Optional)" hint, blocks save when blank). Nango-sourced metadata
   * doesn't carry this flag — only per-connector overrides
   * (CONNECTOR_CONNECTION_CONFIG_OVERRIDES) set it.
   */
  required?: boolean;
}

export interface IntegrationProvider {
  connectorName: string;
  displayName: string;
  description: string;
  category: string;
  availableAuthTypes: string[];
  authPrefill?: Partial<Record<AuthType, Record<string, unknown>>>;
  oauth2?: {
    authorizationUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    defaultScopes: string[];
    scopeSeparator: string;
    pkce: boolean;
    authorizationParams?: Record<string, string>;
    tokenParams?: Record<string, string>;
    connectionConfigFields?: string[];
  };
  /** Nango connection_config metadata — applies to all auth types (API_KEY, OAuth2, etc.) */
  connectionConfig?: Record<string, ConnectionConfigFieldMeta>;
  /** Pre-filled API key configuration from Nango proxy headers */
  apiKeyConfig?: {
    headerName: string;
    prefix?: string;
    /** Additional headers derived from connectionConfig fields (e.g. anthropic-version) */
    additionalHeaders?: Array<{
      headerName: string;
      fieldKey: string;
      fieldMeta: ConnectionConfigFieldMeta;
      defaultValue?: string;
    }>;
  };
  profileCount: number;
  profiles: IntegrationProviderProfile[];
}

export interface IntegrationProviderProfile {
  id: string;
  name: string;
  scope: 'tenant' | 'project';
  usageMode: string;
  authType: string;
  status: string;
}

// ─── Build Provider List ────────────────────────────────────────────────

export interface BuildProvidersOptions {
  tenantId: string;
  /** null for workspace (tenant-only profiles), string for project scope */
  projectId: string | null;
  userId: string;
  isAdmin: boolean;
}

type NangoProviderConfig = NonNullable<ReturnType<typeof getProviderConfig>>;
type OAuthParamMap = Record<string, string>;

function uniqueProviderConfigs(
  configs: Array<NangoProviderConfig | undefined>,
): NangoProviderConfig[] {
  const deduped = new Map<string, NangoProviderConfig>();
  for (const config of configs) {
    if (!config || deduped.has(config.name)) {
      continue;
    }
    deduped.set(config.name, config);
  }
  return Array.from(deduped.values());
}

function addAvailableAuthType(types: string[], authType: string): void {
  if (!types.includes(authType)) {
    types.push(authType);
  }
}

function isClientCredentialsProvider(
  provider: Pick<NangoProviderConfig, 'tokenUrl' | 'tokenParams'>,
): boolean {
  return provider.tokenUrl != null && provider.tokenParams?.grant_type === 'client_credentials';
}

export function normalizeOAuthParams(
  params: Record<string, unknown> | undefined,
): OAuthParamMap | undefined {
  if (!params) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(params)
      .filter((entry): entry is [string, string | number | boolean] => {
        const [, value] = entry;
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      })
      .map(([key, value]) => [key, String(value)]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function deriveAvailableAuthTypesFromProviders(
  entry: Pick<CatalogEntryLike, 'name' | 'authType' | 'oauth2'>,
  providerConfigs: NangoProviderConfig[],
): string[] {
  const availableAuthTypes: string[] = [];

  if (entry.oauth2?.authorizationUrl && entry.oauth2.tokenUrl) {
    addAvailableAuthType(availableAuthTypes, 'oauth2');
  }

  if (entry.authType === 'api_key') {
    addAvailableAuthType(availableAuthTypes, 'api_key');
  }

  if ((DIRECT_API_KEY_CONNECTORS as readonly string[]).includes(entry.name)) {
    addAvailableAuthType(availableAuthTypes, 'api_key');
  }

  for (const providerConfig of providerConfigs) {
    if (providerConfig.authMode === 'api_key') {
      addAvailableAuthType(availableAuthTypes, 'api_key');
    }

    if (providerConfig.authMode === 'basic') {
      addAvailableAuthType(availableAuthTypes, 'basic');
    }

    if (providerConfig.authorizationUrl && providerConfig.tokenUrl) {
      addAvailableAuthType(availableAuthTypes, 'oauth2');
    }

    if (isClientCredentialsProvider(providerConfig)) {
      addAvailableAuthType(availableAuthTypes, 'oauth2_client_credentials');
    }
  }

  // Always report the connector's declared authType as a fallback — including
  // 'none' (Docling, HTTP) and 'custom' (Azure DI, ServiceNow, Shopify). These
  // do not map to a generic AuthProfile type via `mapConnectorAuthTypeToProfileAuthType`,
  // but the catalog UI uses `availableAuthTypes.length > 0` as the "render this
  // connector" gate, so dropping them here makes them disappear from the
  // Connector Catalog tab entirely.
  if (availableAuthTypes.length === 0) {
    addAvailableAuthType(availableAuthTypes, entry.authType);
  }

  return availableAuthTypes;
}

/**
 * Parse Nango proxy headers to extract API key header name, prefix,
 * and additional headers derived from connectionConfig fields.
 *
 * e.g. { "authorization": "Bearer ${apiKey}" } → { headerName: "Authorization", prefix: "Bearer " }
 * e.g. { "x-api-key": "${apiKey}", "anthropic-version": "${connectionConfig.version}" }
 *   → { headerName: "x-api-key", additionalHeaders: [{ headerName: "anthropic-version", fieldKey: "version", ... }] }
 */
function parseApiKeyConfig(
  proxyHeaders?: Record<string, string>,
  connectionConfig?: Record<
    string,
    {
      type: string;
      title?: string;
      description?: string;
      pattern?: string;
      example?: string;
      default?: string | number | boolean;
    }
  >,
): IntegrationProvider['apiKeyConfig'] {
  if (!proxyHeaders) return undefined;

  let headerName: string | undefined;
  let prefix: string | undefined;
  const additionalHeaders: NonNullable<
    NonNullable<IntegrationProvider['apiKeyConfig']>['additionalHeaders']
  > = [];

  for (const [header, value] of Object.entries(proxyHeaders)) {
    if (typeof value !== 'string') continue;

    // Primary API key header
    if (value.includes('${apiKey}')) {
      headerName = header;
      const prefixMatch = value.match(/^(.+?)\$\{apiKey\}/);
      prefix = prefixMatch?.[1] && prefixMatch[1].length > 0 ? prefixMatch[1] : undefined;
      continue;
    }

    // connectionConfig-mapped headers (e.g. "anthropic-version": "${connectionConfig.version}")
    const connConfigMatch = value.match(/^\$\{connectionConfig\.(\w+)\}(?:\s*\|\|\s*(.+))?$/);
    if (connConfigMatch) {
      const fieldKey = connConfigMatch[1];
      const defaultVal = connConfigMatch[2]?.trim();
      const fieldMeta = connectionConfig?.[fieldKey];
      if (fieldMeta) {
        additionalHeaders.push({
          headerName: header,
          fieldKey,
          fieldMeta: {
            type: fieldMeta.type,
            title: fieldMeta.title,
            description: fieldMeta.description,
            pattern: fieldMeta.pattern,
            example: fieldMeta.example,
            default: fieldMeta.default,
          },
          defaultValue: defaultVal,
        });
      }
    }
  }

  if (!headerName) return undefined;

  return {
    headerName,
    prefix,
    additionalHeaders: additionalHeaders.length > 0 ? additionalHeaders : undefined,
  };
}

/**
 * Build the integration provider response by merging:
 * 1. Static connector catalog entries
 * 2. Nango provider OAuth metadata (via alias resolution)
 * 3. Auth profile counts (with visibility filtering)
 */
export async function buildIntegrationProviders(
  options: BuildProvidersOptions,
): Promise<IntegrationProvider[]> {
  const { tenantId, projectId, userId, isAdmin } = options;

  // 1. Load connector catalog entries (includes built-in oauth2 from ActivePieces connectors)
  const entries = catalog as Array<{
    name: string;
    displayName: string;
    description: string;
    category: string;
    authType: string;
    providerAlias?: string;
    oauth2?: {
      authorizationUrl: string;
      tokenUrl: string;
      refreshUrl?: string;
      defaultScopes: string[];
      scopeSeparator: string;
      pkce: boolean;
    };
  }>;
  const catalogConnectorNames = new Set(entries.map((entry) => entry.name));
  const mergedEntries: typeof entries = [
    ...entries,
    ...VIRTUAL_INTEGRATION_CONNECTORS.filter((entry) => !catalogConnectorNames.has(entry.name)),
  ];

  // 2. Collect connector names for batch profile query
  const connectorNames = mergedEntries.map((e) => e.name);

  // 3. Query auth profiles for these connectors (single DB query)
  const { AuthProfile } = await import('@agent-platform/database/models');

  const profileFilter: Record<string, unknown> = {
    tenantId,
    connector: { $in: connectorNames },
  };

  // Scope filter: project endpoint shows project + inherited tenant profiles
  // Workspace endpoint shows only tenant-scoped profiles
  if (projectId !== null) {
    profileFilter.$or = [{ projectId }, { projectId: null, scope: 'tenant' }];
  } else {
    profileFilter.projectId = null;
    profileFilter.scope = 'tenant';
  }

  // Visibility enforcement
  if (!isAdmin) {
    profileFilter.$and = [
      {
        $or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }],
      },
    ];
  }

  const profiles = (await AuthProfile.find(profileFilter).lean()) as IAuthProfile[];
  log.debug('Loaded integration auth profiles', { count: profiles.length, tenantId });

  // 4. Group profiles by connector
  const profilesByConnector = new Map<string, IAuthProfile[]>();
  for (const profile of profiles) {
    if (!profile.connector) continue;
    const existing = profilesByConnector.get(profile.connector) ?? [];
    existing.push(profile);
    profilesByConnector.set(profile.connector, existing);
  }

  // 5. Build response entries
  const providers: IntegrationProvider[] = [];

  for (const entry of mergedEntries) {
    // Resolve Nango provider via alias
    const alias = entry.providerAlias ?? NANGO_ALIAS_MAP[entry.name];
    const exactNangoConfig =
      getProviderConfig(entry.name) ?? getProviderConfig(entry.name.replace(/-/g, '_'));
    const aliasNangoConfig = alias ? getProviderConfig(alias) : undefined;
    const nangoConfig = selectPreferredNangoProvider(exactNangoConfig, aliasNangoConfig);

    // Resolve secondary Nango providers (e.g. shopify-api-key for Shopify)
    const secondaryNames = NANGO_SECONDARY_PROVIDERS[entry.name] ?? [];
    const secondaryConfigs = secondaryNames
      .map((name) => getProviderConfig(name))
      .filter((c): c is NonNullable<typeof c> => c != null);
    const allProviderConfigs = uniqueProviderConfigs([
      exactNangoConfig,
      aliasNangoConfig,
      nangoConfig,
      ...secondaryConfigs,
    ]);

    // Determine available auth types
    let availableAuthTypes: string[] = [];
    const authTypeOverride = CONNECTOR_AUTH_TYPE_OVERRIDES[entry.name];
    if (authTypeOverride) {
      availableAuthTypes = [...authTypeOverride];
    } else {
      availableAuthTypes = deriveAvailableAuthTypesFromProviders(entry, allProviderConfigs);
    }

    // Build OAuth2 metadata: catalog is primary source, Nango enriches with extra fields
    let oauth2: IntegrationProvider['oauth2'];
    if (
      entry.oauth2?.authorizationUrl ||
      (nangoConfig?.authorizationUrl && nangoConfig?.tokenUrl)
    ) {
      // Prefer Nango URLs (more up-to-date, have template variables), fall back to catalog
      const authorizationUrl =
        nangoConfig?.authorizationUrl ?? entry.oauth2?.authorizationUrl ?? '';
      const tokenUrl = nangoConfig?.tokenUrl ?? entry.oauth2?.tokenUrl ?? '';
      const refreshUrl = nangoConfig?.refreshUrl ?? entry.oauth2?.refreshUrl;
      const authorizationParams = normalizeOAuthParams(nangoConfig?.authorizationParams);
      const tokenParams = normalizeOAuthParams(nangoConfig?.tokenParams);

      const connectionConfigFields = extractConnectionConfigFields(
        [authorizationUrl, tokenUrl, refreshUrl ?? ''],
        [nangoConfig?.authorizationParams, nangoConfig?.tokenParams],
      );

      oauth2 = {
        authorizationUrl,
        tokenUrl,
        refreshUrl,
        defaultScopes:
          entry.oauth2?.defaultScopes && entry.oauth2.defaultScopes.length > 0
            ? entry.oauth2.defaultScopes
            : (nangoConfig?.defaultScopes ?? []),
        scopeSeparator: nangoConfig?.scopeSeparator ?? entry.oauth2?.scopeSeparator ?? ' ',
        pkce: nangoConfig?.pkce ?? entry.oauth2?.pkce ?? false,
        authorizationParams,
        tokenParams,
        connectionConfigFields:
          connectionConfigFields.length > 0 ? connectionConfigFields : undefined,
      };
    }

    // Extract Nango connectionConfig metadata for all auth types (API_KEY, OAuth2, etc.)
    // Merge from primary provider and any secondary providers
    let connectionConfig: IntegrationProvider['connectionConfig'];
    const mapped: Record<string, ConnectionConfigFieldMeta> = {};
    for (const provConfig of allProviderConfigs) {
      if (!provConfig?.connectionConfig) continue;
      for (const [key, field] of Object.entries(provConfig.connectionConfig)) {
        if (mapped[key]) continue; // primary wins
        // Skip automated fields — they have Nango-managed defaults and are not user-facing
        if ('automated' in field && field.automated) continue;
        mapped[key] = {
          type: field.type,
          title: field.title,
          description: field.description,
          pattern: field.pattern,
          example: field.example,
          default: field.default,
        };
      }
    }
    if (Object.keys(mapped).length > 0) {
      connectionConfig = mapped;
    }

    // Map profiles for this connector
    const connectorProfiles = profilesByConnector.get(entry.name) ?? [];
    const mappedProfiles: IntegrationProviderProfile[] = connectorProfiles.map((p) => ({
      id: p._id.toString(),
      name: p.name,
      scope: p.scope as 'tenant' | 'project',
      usageMode: p.usageMode ?? 'preconfigured',
      authType: p.authType,
      status: p.status,
    }));

    // Parse API key config from Nango proxy headers (primary or secondary providers)
    let apiKeyConfig: IntegrationProvider['apiKeyConfig'];
    if (availableAuthTypes.includes('api_key')) {
      for (const provConfig of allProviderConfigs) {
        if (!provConfig) continue;
        const parsed = parseApiKeyConfig(provConfig.proxyHeaders, provConfig.connectionConfig);
        if (parsed) {
          apiKeyConfig = parsed;
          break;
        }
      }
    }

    // Remove connectionConfig fields that are already shown as additional API key headers
    if (apiKeyConfig?.additionalHeaders && connectionConfig) {
      const headerFieldKeys = new Set(apiKeyConfig.additionalHeaders.map((h) => h.fieldKey));
      const filtered = Object.fromEntries(
        Object.entries(connectionConfig).filter(([key]) => !headerFieldKeys.has(key)),
      );
      connectionConfig = Object.keys(filtered).length > 0 ? filtered : undefined;
    }

    // Apply per-connector connectionConfig and apiKeyConfig overrides for pieces
    // whose PieceAuth.CustomAuth isn't expressed via Nango (e.g. Azure DI).
    const connectionConfigOverride = CONNECTOR_CONNECTION_CONFIG_OVERRIDES[entry.name];
    if (connectionConfigOverride) {
      connectionConfig = { ...(connectionConfig ?? {}), ...connectionConfigOverride };
    }
    const apiKeyConfigOverride = CONNECTOR_API_KEY_CONFIG_OVERRIDES[entry.name];
    if (apiKeyConfigOverride) {
      apiKeyConfig = { ...(apiKeyConfig ?? { headerName: '' }), ...apiKeyConfigOverride };
    }

    providers.push({
      connectorName: entry.name,
      displayName: entry.displayName,
      description: entry.description,
      category: entry.category,
      availableAuthTypes,
      authPrefill: CONNECTOR_AUTH_PREFILL[entry.name],
      oauth2,
      connectionConfig,
      apiKeyConfig,
      profileCount: mappedProfiles.length,
      profiles: mappedProfiles,
    });
  }

  return providers;
}
