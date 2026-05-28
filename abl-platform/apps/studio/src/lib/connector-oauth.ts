/**
 * Connector OAuth Utilities
 *
 * Maps connector names to OAuth providers and loads OAuth client credentials
 * from environment variables. Used by the connection OAuth initiate/callback routes.
 *
 * Env var convention (same as runtime's Tool OAuth):
 *   OAUTH_PROVIDER_<PROVIDER>_CLIENT_ID
 *   OAUTH_PROVIDER_<PROVIDER>_CLIENT_SECRET
 *
 * Example:
 *   OAUTH_PROVIDER_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
 *   OAUTH_PROVIDER_GOOGLE_CLIENT_SECRET=GOCSPX-xxx
 */

import crypto from 'crypto';
import {
  normalizeConnectionConfig,
  resolveTemplatedParams,
  resolveTemplatedUrl,
} from '@agent-platform/connectors/auth';
import { validateUrlForSSRF } from '@agent-platform/shared/security';
import { getDevSSRFOptions } from '@agent-platform/shared-kernel/security';

// =============================================================================
// TYPES
// =============================================================================

type ConnectorOAuthParamValue = string | number | boolean;

interface ConnectorOAuthConnectionConfigField {
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

export interface ConnectorOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  authorizationParams?: Record<string, ConnectorOAuthParamValue>;
  tokenParams?: Record<string, ConnectorOAuthParamValue>;
  connectionConfig?: Record<string, ConnectorOAuthConnectionConfigField>;
  defaultScopes: string[];
  scopeSeparator: string;
  pkce: boolean;
}

type ConnectorCatalogEntry = {
  name: string;
  oauth2?: ConnectorOAuthConfig;
};

export interface PendingOAuthState {
  connectorName: string;
  provider: string;
  displayName?: string;
  redirectUri: string;
  scopes: string[];
  tokenUrl: string;
  tokenParams?: Record<string, string>;
  connectionConfig?: ConnectionConfigValues;
  clientId: string;
  clientSecret: string;
  expiresAt: number;
}

type ConnectionConfigValues = Record<string, string>;

export interface ConnectorOAuthInitiateErrorResponse {
  status: 400 | 500;
  message: string;
}

export const BLOCKED_OAUTH_URL_ERROR_MESSAGE = 'URL blocked by security policy';
export const INVALID_CONNECTION_CONFIG_ERROR_MESSAGE = 'Invalid connection configuration';
export const OAUTH_INITIATE_ERROR_MESSAGE = 'Failed to initiate OAuth';

function isBlockedOAuthUrlError(message: string): boolean {
  return (
    message === 'Invalid URL format' || message.startsWith('Blocked ') || message.includes('SSRF')
  );
}

function isConnectionConfigError(message: string): boolean {
  return (
    message === 'This connector does not accept connectionConfig values' ||
    message === 'connectionConfig must be an object of string values' ||
    message === 'connectionConfig values must be strings' ||
    message.startsWith('connectionConfig.') ||
    message.startsWith('connectionConfig ') ||
    message.startsWith('Missing required connection configuration:') ||
    message.startsWith('Unsupported connection configuration key:')
  );
}

export function getInitiateConnectorOAuthErrorResponse(
  error: unknown,
): ConnectorOAuthInitiateErrorResponse {
  const message = error instanceof Error ? error.message : String(error);

  if (isBlockedOAuthUrlError(message)) {
    return {
      status: 400,
      message: BLOCKED_OAUTH_URL_ERROR_MESSAGE,
    };
  }

  if (isConnectionConfigError(message)) {
    return {
      status: 400,
      message: INVALID_CONNECTION_CONFIG_ERROR_MESSAGE,
    };
  }

  return {
    status: 500,
    message: OAUTH_INITIATE_ERROR_MESSAGE,
  };
}

// =============================================================================
// CONNECTOR → PROVIDER MAPPING
// =============================================================================

/**
 * Maps connector names (from the catalog) to their OAuth provider.
 * Multiple connectors can share one provider (e.g., gmail, google-sheets → google).
 */
const CONNECTOR_TO_PROVIDER: Record<string, string> = {
  gmail: 'google',
  'google-sheets': 'google',
  'google-calendar': 'google',
  'google-drive': 'google',
  slack: 'slack',
  github: 'github',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  pipedrive: 'pipedrive',
  asana: 'asana',
  clickup: 'clickup',
  notion: 'notion',
  'microsoft-teams': 'microsoft',
};

/** Resolve the OAuth provider name for a connector */
export function getOAuthProvider(connectorName: string): string {
  return CONNECTOR_TO_PROVIDER[connectorName] ?? connectorName;
}

// =============================================================================
// PROVIDER CREDENTIALS
// =============================================================================

interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

/** Load OAuth client credentials from env vars */
export function loadProviderCredentials(provider: string): OAuthProviderCredentials | null {
  const prefix = `OAUTH_PROVIDER_${provider.toUpperCase()}`;
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// =============================================================================
// CATALOG LOOKUP
// =============================================================================

/** Get OAuth config for a connector from catalog data */
export function getConnectorOAuthConfig(
  catalog: ConnectorCatalogEntry[],
  connectorName: string,
): ConnectorOAuthConfig | null {
  const entry = catalog.find((c) => c.name === connectorName);
  if (!entry?.oauth2) return null;
  return {
    authorizationUrl: entry.oauth2.authorizationUrl,
    tokenUrl: entry.oauth2.tokenUrl,
    authorizationParams: entry.oauth2.authorizationParams,
    tokenParams: entry.oauth2.tokenParams,
    connectionConfig: entry.oauth2.connectionConfig,
    defaultScopes: entry.oauth2.defaultScopes ?? [],
    scopeSeparator: entry.oauth2.scopeSeparator ?? ' ',
    pkce: entry.oauth2.pkce ?? false,
  };
}

// =============================================================================
// PENDING STATE STORE (in-memory, single-pod)
// =============================================================================

const pendingStates = new Map<string, PendingOAuthState>();
const MAX_PENDING_STATES = 1000;
const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** Store a pending OAuth state */
function storePendingState(state: string, data: PendingOAuthState): void {
  if (pendingStates.size >= MAX_PENDING_STATES) {
    const now = Date.now();
    for (const [key, entry] of pendingStates) {
      if (entry.expiresAt < now) pendingStates.delete(key);
    }
    // If still at capacity after expiry sweep, evict oldest entry
    if (pendingStates.size >= MAX_PENDING_STATES) {
      const oldestKey = pendingStates.keys().next().value;
      if (oldestKey) pendingStates.delete(oldestKey);
    }
  }
  pendingStates.set(state, data);
}

/** Retrieve and delete a pending state (atomic get-and-delete) */
export function consumePendingState(state: string): PendingOAuthState | null {
  const data = pendingStates.get(state) ?? null;
  if (data) {
    pendingStates.delete(state);
    if (data.expiresAt < Date.now()) return null;
  }
  return data;
}

// =============================================================================
// INITIATE FLOW
// =============================================================================

/**
 * Initiate OAuth flow for a connector.
 * Looks up OAuth config from catalog + credentials from env vars.
 * Returns the full authorization URL with all required query params.
 */
export function initiateConnectorOAuth(
  catalog: ConnectorCatalogEntry[],
  connectorName: string,
  redirectUri: string,
  connectionConfig?: Record<string, unknown>,
  displayName?: string,
): { authUrl: string; state: string } {
  const oauthConfig = getConnectorOAuthConfig(catalog, connectorName);
  if (!oauthConfig) {
    throw new Error(`Connector "${connectorName}" does not have OAuth configuration in catalog`);
  }

  const provider = getOAuthProvider(connectorName);
  const creds = loadProviderCredentials(provider);
  if (!creds) {
    throw new Error(
      `OAuth credentials not configured for provider "${provider}". ` +
        `Set OAUTH_PROVIDER_${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET env vars.`,
    );
  }

  const state = crypto.randomBytes(32).toString('hex');
  const normalizedConnectionConfig = normalizeConnectionConfig(connectionConfig, oauthConfig);
  const authorizationUrl = resolveTemplatedUrl(oauthConfig.authorizationUrl, {
    connectionConfig: normalizedConnectionConfig,
    validateResolvedUrl: (url) => validateUrlForSSRF(url, getDevSSRFOptions()),
  });
  const tokenUrl = resolveTemplatedUrl(oauthConfig.tokenUrl, {
    connectionConfig: normalizedConnectionConfig,
    validateResolvedUrl: (url) => validateUrlForSSRF(url, getDevSSRFOptions()),
  });
  const authorizationParams = resolveTemplatedParams(oauthConfig.authorizationParams, {
    connectionConfig: normalizedConnectionConfig,
  });
  const tokenParams = resolveTemplatedParams(oauthConfig.tokenParams, {
    connectionConfig: normalizedConnectionConfig,
  });

  storePendingState(state, {
    connectorName,
    provider,
    displayName,
    redirectUri,
    scopes: oauthConfig.defaultScopes,
    tokenUrl,
    tokenParams,
    connectionConfig: normalizedConnectionConfig,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    expiresAt: Date.now() + STATE_EXPIRY_MS,
  });

  const params = new URLSearchParams(authorizationParams);
  params.set('client_id', creds.clientId);
  params.set('redirect_uri', redirectUri);
  params.set('response_type', params.get('response_type') ?? 'code');
  if (oauthConfig.defaultScopes.length > 0) {
    params.set('scope', oauthConfig.defaultScopes.join(oauthConfig.scopeSeparator));
  }
  params.set('state', state);
  if (!params.has('access_type')) {
    params.set('access_type', 'offline');
  }
  if (!params.has('prompt')) {
    params.set('prompt', 'consent');
  }

  const authUrl = `${authorizationUrl}?${params.toString()}`;
  return { authUrl, state };
}
