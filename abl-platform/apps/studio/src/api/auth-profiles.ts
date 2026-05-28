/**
 * Auth Profiles API Client
 *
 * Typed fetch functions for the Auth Profile CRUD + OAuth endpoints.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type AuthType =
  | 'none'
  | 'api_key'
  | 'bearer'
  | 'oauth2_app'
  | 'oauth2_token'
  | 'oauth2_client_credentials'
  // Phase 2
  | 'basic'
  | 'custom_header'
  | 'aws_iam'
  | 'azure_ad'
  | 'mtls'
  | 'ssh_key'
  // Phase 3
  | 'digest'
  | 'kerberos'
  | 'saml'
  | 'hawk'
  | 'ws_security';

export type AuthProfileStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'invalid'
  | 'pending_authorization';
export type AuthProfileVisibility = 'shared' | 'personal';
export type AuthProfileConnectionMode = 'shared' | 'per_user';
export type AuthProfileEnvironment = 'development' | 'staging' | 'production' | null;
export type AuthProfileUsageMode = 'preconfigured' | 'user_token' | 'jit' | 'preflight';
/** ABLP-913 discriminator: integration profiles bind to a vendor, custom are generic. */
export type AuthProfileProfileType = 'integration' | 'custom';
export type AuthProfileMigrationStatus = 'legacy_read_only';

export interface AuthProfileMigrationInfo {
  status: AuthProfileMigrationStatus;
  message: string;
  replacementAuthProfileId: string | null;
  replacementAuthType: 'oauth2_app';
}

export interface AuthProfileSummary {
  id: string;
  name: string;
  description?: string;
  authType: AuthType;
  usageMode: AuthProfileUsageMode;
  status: AuthProfileStatus;
  environment: AuthProfileEnvironment;
  visibility: AuthProfileVisibility;
  connectionMode: AuthProfileConnectionMode;
  scope: 'tenant' | 'project';
  /** ABLP-913: integration vs custom — derived from connector at write time. */
  profileType?: AuthProfileProfileType;
  inherited?: boolean;
  connector?: string;
  category?: string;
  tags?: string[];
  /** When false, runtime resolution rejects this profile with AUTH_PROFILE_DISABLED. */
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  /** Resolved owner email (from a single batched user lookup). Null if the user record can't be resolved. */
  createdByEmail?: string | null;
  isAuthorized?: boolean;
  migration?: AuthProfileMigrationInfo | null;
}

export interface AuthProfileDetail extends AuthProfileSummary {
  config: Record<string, unknown>;
  /** Secret fields are redacted — keys present with value '[REDACTED]' */
  redactedSecrets: Record<string, string>;
  linkedAppProfileId?: string;
}

export interface CreateAuthProfilePayload {
  name: string;
  description?: string;
  authType: AuthType;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  projectId: string | null;
  scope: 'tenant' | 'project';
  environment?: string | null;
  visibility?: AuthProfileVisibility;
  connectionMode?: AuthProfileConnectionMode;
  usageMode?: AuthProfileUsageMode;
  linkedAppProfileId?: string;
  connector?: string;
  category?: string;
  tags?: string[];
}

export interface UpdateAuthProfilePayload {
  name?: string;
  description?: string | null;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  environment?: string | null;
  visibility?: AuthProfileVisibility;
  connectionMode?: AuthProfileConnectionMode;
  usageMode?: AuthProfileUsageMode;
  connector?: string;
  category?: string;
  tags?: string[];
  linkedAppProfileId?: string | null;
  status?: AuthProfileStatus;
  enabled?: boolean;
}

export interface AuthProfileConsumer {
  type: string;
  id: string;
  name: string;
  label: string;
}

export interface AuthProfileBulkResult {
  id: string;
  status: 'ok' | 'error' | 'skipped';
  error?: string;
  reason?: string;
}

export interface ListAuthProfilesParams {
  authType?: AuthType | AuthType[];
  status?: AuthProfileStatus;
  scope?: AuthProfileSummary['scope'];
  environment?: string;
  visibility?: AuthProfileVisibility;
  connector?: string;
  /** ABLP-913: filter to integration- or custom-typed profiles. */
  profileType?: AuthProfileProfileType;
  cursor?: string;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastUsedAt' | 'status';
  sortDir?: 'asc' | 'desc';
  search?: string;
}

interface ListResponse<T> {
  success: boolean;
  data: T[];
  pagination: { nextCursor: string | null; total: number };
}

interface SingleResponse<T> {
  success: boolean;
  data: T;
}

export interface AuthProfileValidationResult {
  valid: boolean;
  latencyMs?: number;
  message?: string;
  validationType?: 'configuration' | 'oauth_grant' | 'token_exchange';
  requiresUserAuthorization?: boolean;
  /**
   * Operational health snapshot — drives the status pill and the contextual
   * primary-action button in the Studio UI. The shape is mirrored from
   * @/lib/auth-profile-health (see that module for the state vocabulary).
   * Optional for backwards compatibility with older Studio builds; new code
   * should always read from this struct rather than re-computing health
   * client-side.
   */
  health?: {
    state:
      | 'connected'
      | 'connected_no_auto_renew'
      | 'reauth_required'
      | 'not_authorized'
      | 'requires_user_authorization'
      | 'verified'
      | 'untested'
      | 'configuration_error'
      | 'lifecycle_blocked';
    reason: string;
    lastVerifiedAt?: string;
    refreshTokenStored?: boolean;
  };
}

export interface OAuthGrantAuthorizationResult {
  id: string;
  authProfileId: string;
  authProfileRef?: string;
  provider: string;
  principalScope: 'user' | 'tenant';
  principalId: string;
  storage: 'oauth_grant_store';
  scope: string;
  expiresAt: string | null;
  /**
   * True when the OAuth provider returned a refresh token in the token response.
   * False indicates the access token cannot be silently renewed — the profile
   * will need manual re-authorization once the access token expires. Studio uses
   * this to show an inline warning at authorization time so users discover the
   * issue immediately rather than 1 hour later when their first workflow run
   * fails with AUTH_PROFILE_TOKEN_REQUIRED.
   */
  refreshTokenStored: boolean;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

function buildUrl(base: string, params: Record<string, unknown>): string {
  const url = new URL(base, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

export async function fetchAuthProfiles(
  projectId: string,
  params: ListAuthProfilesParams = {},
): Promise<ListResponse<AuthProfileSummary>> {
  const path = buildUrl(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles`,
    params as Record<string, unknown>,
  );
  const res = await apiFetch(path);
  return handleResponse<ListResponse<AuthProfileSummary>>(res);
}

export async function fetchAuthProfile(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
  );
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function createAuthProfile(
  projectId: string,
  payload: CreateAuthProfilePayload,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/auth-profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function updateAuthProfile(
  projectId: string,
  profileId: string,
  payload: UpdateAuthProfilePayload,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function deleteAuthProfile(
  projectId: string,
  profileId: string,
): Promise<{ success: boolean }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
  );
  return handleResponse<{ success: boolean }>(res);
}

export async function revokeAuthProfile(
  projectId: string,
  profileId: string,
): Promise<{ success: boolean }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/revoke`,
    { method: 'POST' },
  );
  return handleResponse<{ success: boolean }>(res);
}

export async function validateAuthProfile(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<AuthProfileValidationResult>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/validate`,
    { method: 'POST' },
  );
  return handleResponse<SingleResponse<AuthProfileValidationResult>>(res);
}

export interface VerifyDraftAuthProfilePayload {
  authType: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export async function verifyDraftAuthProfile(
  projectId: string,
  payload: VerifyDraftAuthProfilePayload,
): Promise<SingleResponse<AuthProfileValidationResult>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/verify-draft`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<AuthProfileValidationResult>>(res);
}

export async function verifyDraftWorkspaceAuthProfile(
  payload: VerifyDraftAuthProfilePayload,
): Promise<SingleResponse<AuthProfileValidationResult>> {
  const res = await apiFetch('/api/auth-profiles/verify-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<AuthProfileValidationResult>>(res);
}

export async function fetchAuthProfileConsumers(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<AuthProfileConsumer[]>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/consumers`,
  );
  return handleResponse<SingleResponse<AuthProfileConsumer[]>>(res);
}

export async function bulkAuthProfiles(
  projectId: string,
  payload: {
    action: 'delete' | 'revoke' | 'activate';
    profileIds: string[];
  },
): Promise<SingleResponse<{ results: AuthProfileBulkResult[] }>> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/auth-profiles/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<{ results: AuthProfileBulkResult[] }>>(res);
}

export async function initiateOAuth(
  projectId: string,
  payload: ProjectOAuthInitiatePayload,
): Promise<SingleResponse<{ authUrl: string; state: string }>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/initiate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<{ authUrl: string; state: string }>>(res);
}

export async function handleOAuthProfileCallback(
  projectId: string,
  payload: { code: string; state: string; displayName?: string },
): Promise<SingleResponse<OAuthGrantAuthorizationResult>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  return handleResponse<SingleResponse<OAuthGrantAuthorizationResult>>(res);
}

export type ProjectOAuthInitiatePayload =
  | {
      connectorName?: string;
      authProfileId: string;
      authProfileRef?: never;
      environment?: string | null;
      isUserConsent?: boolean;
      connectionConfig?: Record<string, string>;
    }
  | {
      connectorName?: string;
      authProfileRef: string;
      authProfileId?: never;
      environment?: string | null;
      isUserConsent?: boolean;
      connectionConfig?: Record<string, string>;
    };

export type WorkspaceOAuthInitiatePayload =
  | {
      connectorName?: string;
      authProfileId: string;
      authProfileRef?: never;
      environment?: string | null;
      connectionConfig?: Record<string, string>;
    }
  | {
      connectorName?: string;
      authProfileRef: string;
      authProfileId?: never;
      environment?: string | null;
      connectionConfig?: Record<string, string>;
    };

export async function initiateWorkspaceOAuthLegacy(
  payload: WorkspaceOAuthInitiatePayload,
): Promise<SingleResponse<{ authUrl: string; state: string }>> {
  const res = await apiFetch('/api/auth-profiles/oauth/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<{ authUrl: string; state: string }>>(res);
}

export async function handleWorkspaceOAuthProfileCallback(payload: {
  code: string;
  state: string;
  displayName?: string;
}): Promise<SingleResponse<OAuthGrantAuthorizationResult>> {
  return completeWorkspaceOAuthCallback(payload);
}

// =============================================================================
// WORKSPACE (TENANT-SCOPED) API FUNCTIONS
// =============================================================================

export async function fetchWorkspaceAuthProfiles(
  params: ListAuthProfilesParams = {},
): Promise<ListResponse<AuthProfileSummary>> {
  const path = buildUrl('/api/admin/auth-profiles', params as Record<string, unknown>);
  const res = await apiFetch(path);
  return handleResponse<ListResponse<AuthProfileSummary>>(res);
}

export async function fetchWorkspaceAuthProfile(
  profileId: string,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}`);
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function createWorkspaceAuthProfile(
  payload: Omit<CreateAuthProfilePayload, 'projectId' | 'scope'>,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch('/api/admin/auth-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, projectId: null, scope: 'tenant' }),
  });
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function updateWorkspaceAuthProfile(
  profileId: string,
  payload: UpdateAuthProfilePayload,
): Promise<SingleResponse<AuthProfileDetail>> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<AuthProfileDetail>>(res);
}

export async function deleteWorkspaceAuthProfile(profileId: string): Promise<{ success: boolean }> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ success: boolean }>(res);
}

export async function revokeWorkspaceAuthProfile(profileId: string): Promise<{ success: boolean }> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}/revoke`, {
    method: 'POST',
  });
  return handleResponse<{ success: boolean }>(res);
}

export async function validateWorkspaceAuthProfile(
  profileId: string,
): Promise<SingleResponse<AuthProfileValidationResult>> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}/validate`, {
    method: 'POST',
  });
  return handleResponse<SingleResponse<AuthProfileValidationResult>>(res);
}

export async function fetchWorkspaceAuthProfileConsumers(
  profileId: string,
): Promise<SingleResponse<AuthProfileConsumer[]>> {
  const res = await apiFetch(`/api/admin/auth-profiles/${encodeURIComponent(profileId)}/consumers`);
  return handleResponse<SingleResponse<AuthProfileConsumer[]>>(res);
}

export async function bulkWorkspaceAuthProfiles(payload: {
  action: 'delete' | 'revoke' | 'activate';
  profileIds: string[];
}): Promise<SingleResponse<{ results: AuthProfileBulkResult[] }>> {
  const res = await apiFetch('/api/admin/auth-profiles/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<{ results: AuthProfileBulkResult[] }>>(res);
}

// =============================================================================
// WORKSPACE OAUTH FLOW (ABLP-619)
// =============================================================================

export async function initiateWorkspaceOAuth(
  payload:
    | {
        connectorName?: string;
        authProfileId: string;
        authProfileRef?: never;
        environment?: string | null;
        isUserConsent?: boolean;
        connectionConfig?: Record<string, string>;
      }
    | {
        connectorName?: string;
        authProfileRef: string;
        authProfileId?: never;
        environment?: string | null;
        isUserConsent?: boolean;
        connectionConfig?: Record<string, string>;
      },
): Promise<SingleResponse<{ authUrl: string; state: string }>> {
  const res = await apiFetch('/api/admin/auth-profiles/oauth/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<{ authUrl: string; state: string }>>(res);
}

export async function completeWorkspaceOAuthCallback(payload: {
  code: string;
  state: string;
  displayName?: string;
}): Promise<SingleResponse<OAuthGrantAuthorizationResult>> {
  const res = await apiFetch('/api/admin/auth-profiles/oauth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<OAuthGrantAuthorizationResult>>(res);
}

export async function recordWorkspaceUserConsent(payload: {
  connectorName: string;
  sessionId: string;
  authProfileId: string;
}): Promise<SingleResponse<{ authUrl: string; state: string; sessionId: string }>> {
  const res = await apiFetch('/api/admin/auth-profiles/oauth/user-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<SingleResponse<{ authUrl: string; state: string; sessionId: string }>>(res);
}

// =============================================================================
// INTEGRATION PROVIDERS
// =============================================================================

export interface IntegrationProviderProfile {
  id: string;
  name: string;
  scope: 'tenant' | 'project';
  usageMode: string;
  authType: string;
  status: AuthProfileStatus;
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
  /** Nango connection_config metadata — field definitions for API_KEY/custom providers */
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
  >;
  /** Pre-filled API key configuration from Nango proxy headers */
  apiKeyConfig?: {
    headerName: string;
    prefix?: string;
    /** Additional headers derived from connectionConfig fields (e.g. anthropic-version) */
    additionalHeaders?: Array<{
      headerName: string;
      fieldKey: string;
      fieldMeta: {
        type: string;
        title?: string;
        description?: string;
        pattern?: string;
        example?: string;
        default?: string | number | boolean;
      };
      defaultValue?: string;
    }>;
  };
  profileCount: number;
  profiles: IntegrationProviderProfile[];
}

export async function fetchIntegrationProviders(
  projectId: string,
): Promise<SingleResponse<IntegrationProvider[]>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/providers`,
  );
  return handleResponse<SingleResponse<IntegrationProvider[]>>(res);
}

export async function fetchWorkspaceIntegrationProviders(): Promise<
  SingleResponse<IntegrationProvider[]>
> {
  const res = await apiFetch('/api/auth-profiles/providers');
  return handleResponse<SingleResponse<IntegrationProvider[]>>(res);
}

// =============================================================================
// ABLP-913 — NEW ENDPOINTS
// =============================================================================

// ── Integrations (vendor-grouped view) ──────────────────────────────────

export interface IntegrationProfileEntry {
  id: string;
  name: string;
  isAuthorized: boolean;
  status: AuthProfileStatus;
  usageMode: string;
  authType: string;
}

export interface VendorGroup {
  connector: string;
  profileCount: number;
  profiles: IntegrationProfileEntry[];
}

export interface IntegrationsResponse {
  vendors: VendorGroup[];
}

export async function fetchIntegrations(
  projectId: string,
): Promise<SingleResponse<IntegrationsResponse>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/integrations`,
  );
  return handleResponse<SingleResponse<IntegrationsResponse>>(res);
}

// ── Revoke Preview (blast-radius) ───────────────────────────────────────

export interface BlastRadiusPayload {
  type: 'profile' | 'tokens';
  affectedConsumers: {
    tools: number;
    integrationNodes: number;
    mcpServers: number;
    a2aServers: number;
    connectorConnections: number;
    channelConnections: number;
    serviceNodes: number;
    gitIntegrations: number;
    triggerRegistrations: number;
  };
  affectedUsers: number;
  activeSessions: number;
  irreversible?: boolean;
  cascadeDeletesTokens?: number;
}

export async function getRevokePreview(
  projectId: string,
  profileId: string,
  type: 'profile' | 'tokens',
  userId?: string,
): Promise<SingleResponse<BlastRadiusPayload>> {
  const params: Record<string, string> = { type };
  if (userId) params.userId = userId;
  const path = buildUrl(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/revoke-preview`,
    params,
  );
  const res = await apiFetch(path);
  return handleResponse<SingleResponse<BlastRadiusPayload>>(res);
}

// ── Revoke User Tokens ──────────────────────────────────────────────────

export interface RevokeUserTokensResult {
  deletedCount: number;
  affectedUsers: number;
}

export async function revokeUserTokens(
  projectId: string,
  profileId: string,
  userId?: string,
): Promise<SingleResponse<RevokeUserTokensResult>> {
  const params: Record<string, string> = {};
  if (userId) params.userId = userId;
  const path = buildUrl(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/revoke-user-tokens`,
    params,
  );
  const res = await apiFetch(path, { method: 'POST' });
  return handleResponse<SingleResponse<RevokeUserTokensResult>>(res);
}

// ── Force Invalidate ────────────────────────────────────────────────────

export interface ForceInvalidateResult {
  profileId: string;
  subscriberCount: number;
}

export async function forceInvalidate(
  projectId: string,
  profileId: string,
): Promise<SingleResponse<ForceInvalidateResult>> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/force-invalidate`,
    { method: 'POST' },
  );
  return handleResponse<SingleResponse<ForceInvalidateResult>>(res);
}

// ── Audit Events ────────────────────────────────────────────────────────

export type AuthProfileAuditEventType =
  | 'authorized'
  | 'authorize_failed'
  | 'token_refreshed'
  | 'token_refresh_failed'
  | 'profile_revoked'
  | 'tokens_revoked'
  | 'profile_updated'
  | 'sensitive_field_changed'
  | 'profile_deleted'
  | 'scope_insufficient_detected';

export interface AuthProfileAuditEvent {
  _id: string;
  tenantId: string;
  projectId: string | null;
  profileId: string;
  eventType: AuthProfileAuditEventType;
  actorUserId: string | null;
  actorContext: {
    source: string;
    requestId?: string;
    sessionId?: string;
  };
  eventPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventsResponse {
  events: AuthProfileAuditEvent[];
  nextCursor: string | null;
}

export interface AuditEventsParams {
  eventType?: AuthProfileAuditEventType;
  cursor?: string;
  limit?: number;
}

export async function getAuditEvents(
  projectId: string,
  profileId: string,
  params: AuditEventsParams = {},
): Promise<SingleResponse<AuditEventsResponse>> {
  const path = buildUrl(
    `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}/audit-events`,
    params as Record<string, unknown>,
  );
  const res = await apiFetch(path);
  return handleResponse<SingleResponse<AuditEventsResponse>>(res);
}
