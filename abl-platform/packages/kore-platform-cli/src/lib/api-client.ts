/**
 * API Client
 *
 * HTTP client with authentication for Kore Platform API.
 */

import { getApiUrl, getRuntimeApiUrl, getSearchAiApiUrl } from './config.js';
import { getToken, getCredentials, saveCredentials } from './credentials.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  requireAuth?: boolean;
  service?: 'runtime' | 'search-ai'; // Explicit override; default is Studio (gateway)
}

// =============================================================================
// CLIENT
// =============================================================================

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, requireAuth = true, service } = options;

  // Route to correct service — default is Studio (gateway)
  let apiUrl: string;
  if (service === 'search-ai') {
    apiUrl = getSearchAiApiUrl();
  } else if (service === 'runtime') {
    apiUrl = getRuntimeApiUrl();
  } else if (endpoint.startsWith('/api/indexes') || endpoint.startsWith('/api/connectors')) {
    apiUrl = getSearchAiApiUrl();
  } else {
    apiUrl = getApiUrl();
  }

  const token = getToken();

  if (requireAuth && !token) {
    throw new Error('Not authenticated. Run: kore-platform-cli login');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response = await fetch(`${apiUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Auto-refresh on 401 if we have a refresh token
  if (response.status === 401 && requireAuth) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getToken()}`;
      response = await fetch(`${apiUrl}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }
  }

  if (!response.ok) {
    let errorMessage = `Request failed: ${response.status} ${response.statusText}`;

    try {
      const errorData = (await response.json()) as ApiError;
      errorMessage = errorData.error || errorMessage;
    } catch {
      // Use default error message
    }

    throw new Error(errorMessage);
  }

  return response.json() as Promise<T>;
}

/**
 * Attempt to refresh the access token using the stored refresh token
 */
async function attemptTokenRefresh(): Promise<boolean> {
  const creds = getCredentials();
  if (!creds?.refreshToken) return false;

  try {
    const apiUrl = getApiUrl();
    const resp = await fetch(`${apiUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: creds.refreshToken }),
    });

    if (!resp.ok) return false;

    const data = (await resp.json()) as {
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };

    saveCredentials({
      token: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: new Date(Date.now() + data.expiresIn * 1000).toISOString(),
      email: creds.email,
    });

    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// AUTH API
// =============================================================================

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export interface DeviceTokenError {
  error: 'authorization_pending' | 'expired_token' | 'token_already_used' | string;
}

/**
 * Start device authorization flow
 */
export async function startDeviceAuth(scopes?: string[]): Promise<DeviceAuthResponse> {
  return apiRequest<DeviceAuthResponse>('/api/auth/device', {
    method: 'POST',
    body: { scopes },
    requireAuth: false,
  });
}

/**
 * Poll for device token
 */
export async function pollDeviceToken(
  deviceCode: string,
): Promise<DeviceTokenResponse | DeviceTokenError> {
  const apiUrl = getApiUrl();

  const response = await fetch(`${apiUrl}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });

  return response.json() as Promise<DeviceTokenResponse | DeviceTokenError>;
}

// =============================================================================
// PROJECT API
// =============================================================================

export interface Project {
  id: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  agentCount?: number;
  sessionCount?: number;
}

/**
 * List projects
 */
export async function listProjects(): Promise<{ projects: Project[] }> {
  const res = await apiRequest<{ success: boolean; projects: Project[] }>('/api/projects');
  return { projects: res.projects };
}

/**
 * Get project by ID
 */
export async function getProject(id: string): Promise<Project> {
  const res = await apiRequest<{ success: boolean; project: Project }>(`/api/projects/${id}`);
  return res.project;
}

/**
 * Create project
 */
export async function createProject(data: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<Project> {
  const res = await apiRequest<{ success: boolean; project: Project }>('/api/projects', {
    method: 'POST',
    body: data,
  });
  return res.project;
}

/**
 * Delete project
 */
export async function deleteProject(id: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/projects/${id}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// WORKSPACE API
// =============================================================================

export interface Workspace {
  tenantId: string;
  tenantName: string;
  role: string;
  orgId?: string;
}

export interface SwitchWorkspaceResponse {
  accessToken: string;
  tenantId: string;
  role: string;
  orgId?: string;
}

/**
 * List workspaces the current user belongs to
 */
export async function listWorkspaces(): Promise<{ tenants: Workspace[] }> {
  return apiRequest<{ tenants: Workspace[] }>('/api/auth/tenants');
}

/**
 * Switch to a different workspace
 */
export async function switchWorkspace(tenantId: string): Promise<SwitchWorkspaceResponse> {
  return apiRequest<SwitchWorkspaceResponse>('/api/auth/tenants/switch', {
    method: 'POST',
    body: { tenantId },
  });
}

// =============================================================================
// DEBUG API
// =============================================================================

export interface DebugToken {
  id: string;
  scopes: string[];
  sessionIds: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
}

/**
 * List debug tokens
 */
export async function listDebugTokens(): Promise<{ tokens: DebugToken[] }> {
  return apiRequest<{ tokens: DebugToken[] }>('/api/debug/tokens');
}

/**
 * Create debug token
 */
export async function createDebugToken(data?: {
  sessionIds?: string[];
  scopes?: string[];
  expiresIn?: number;
}): Promise<{
  token: string;
  expiresAt: string;
  scopes: string[];
}> {
  return apiRequest('/api/debug/token', {
    method: 'POST',
    body: data || {},
  });
}

/**
 * Revoke debug token
 */
export async function revokeDebugToken(token: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>('/api/debug/token', {
    method: 'DELETE',
    body: { token },
  });
}

/**
 * Revoke all debug tokens
 */
export async function revokeAllDebugTokens(): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>('/api/debug/tokens', {
    method: 'DELETE',
  });
}

// =============================================================================
// CONNECTOR API
// =============================================================================

export interface Connector {
  _id: string;
  tenantId: string;
  sourceId: string;
  connectorType: string;
  connectionConfig: Record<string, unknown>;
  filterConfig: {
    mode: 'include' | 'exclude';
    siteUrls: string[];
    libraryNames: string[];
    contentTypes: string[];
    modifiedSince: Date | null;
  };
  syncState: {
    lastFullSyncAt: Date | null;
    lastDeltaSyncAt: Date | null;
    deltaToken: string | null;
    checkpointData: unknown | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
  };
  permissionConfig: {
    mode: 'full' | 'simplified' | 'disabled';
    crawlSchedule: string | null;
    lastCrawlAt: Date | null;
  };
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: Date | null;
    pauseReason: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface Source {
  _id: string;
  tenantId: string;
  indexId: string;
  name: string;
  sourceType: string;
  status: string;
  documentCount?: number;
  lastSyncAt?: Date;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
  message?: string;
}

export interface AuthStatusResponse {
  authenticated: boolean;
  status?: string;
  interval?: number;
  error?: string;
}

export interface SyncStatusResponse {
  status: 'idle' | 'syncing' | 'paused' | 'error';
  syncState: Connector['syncState'];
  errorState: Connector['errorState'];
  progress: {
    percentage: number;
    processed: number;
    total: number;
    failed: number;
  };
}

/**
 * List connectors for an index
 */
export async function listConnectors(
  indexId?: string,
): Promise<{ connectors: Connector[]; total: number }> {
  if (!indexId) {
    throw new Error('indexId is required');
  }
  return apiRequest<{ connectors: Connector[]; total: number }>(
    `/api/indexes/${indexId}/connectors`,
  );
}

/**
 * Get connector details
 */
export async function getConnector(
  indexId: string,
  connectorId: string,
): Promise<{ connector: Connector; source: Source }> {
  return apiRequest<{ connector: Connector; source: Source }>(
    `/api/indexes/${indexId}/connectors/${connectorId}`,
  );
}

/**
 * Create a connector
 */
export async function createConnector(data: {
  indexId: string;
  name: string;
  connectorType: string;
  connectionConfig?: Record<string, unknown>;
  filterConfig?: Connector['filterConfig'];
}): Promise<{ connector: Connector; source: Source }> {
  const { indexId, ...body } = data;
  return apiRequest<{ connector: Connector; source: Source }>(
    `/api/indexes/${indexId}/connectors`,
    {
      method: 'POST',
      body,
    },
  );
}

/**
 * Update connector configuration
 */
export async function updateConnector(
  indexId: string,
  connectorId: string,
  data: {
    connectionConfig?: Record<string, unknown>;
    filterConfig?: Partial<Connector['filterConfig']>;
    permissionConfig?: Partial<Connector['permissionConfig']>;
  },
): Promise<{ connector: Connector }> {
  return apiRequest<{ connector: Connector }>(`/api/indexes/${indexId}/connectors/${connectorId}`, {
    method: 'PUT',
    body: data,
  });
}

/**
 * Delete connector
 */
export async function deleteConnector(
  indexId: string,
  connectorId: string,
): Promise<{ deleted: boolean; connectorId: string }> {
  return apiRequest<{ deleted: boolean; connectorId: string }>(
    `/api/indexes/${indexId}/connectors/${connectorId}`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Initiate OAuth device code flow
 */
export async function initiateConnectorAuth(connectorId: string): Promise<DeviceCodeResponse> {
  return apiRequest<DeviceCodeResponse>(`/api/connectors/${connectorId}/auth/initiate`, {
    method: 'POST',
  });
}

/**
 * Poll for OAuth token status
 */
export async function getConnectorAuthStatus(connectorId: string): Promise<AuthStatusResponse> {
  return apiRequest<AuthStatusResponse>(`/api/connectors/${connectorId}/auth/status`);
}

/**
 * Revoke OAuth token
 */
export async function revokeConnectorAuth(connectorId: string): Promise<{ revoked: boolean }> {
  return apiRequest<{ revoked: boolean }>(`/api/connectors/${connectorId}/auth/revoke`, {
    method: 'POST',
  });
}

/**
 * Validate filter configuration
 */
export async function validateConnectorFilters(
  connectorId: string,
): Promise<{ valid: boolean; errors?: string[]; config?: unknown }> {
  return apiRequest<{ valid: boolean; errors?: string[]; config?: unknown }>(
    `/api/connectors/${connectorId}/filters/validate`,
  );
}

/**
 * Start sync
 */
export async function startConnectorSync(
  connectorId: string,
  syncType: 'full' | 'delta' = 'full',
): Promise<{ syncStarted: boolean; syncType: string; message: string; startedAt: Date }> {
  return apiRequest<{ syncStarted: boolean; syncType: string; message: string; startedAt: Date }>(
    `/api/connectors/${connectorId}/sync/start`,
    {
      method: 'POST',
      body: { syncType },
    },
  );
}

/**
 * Get sync status
 */
export async function getConnectorSyncStatus(connectorId: string): Promise<SyncStatusResponse> {
  return apiRequest<SyncStatusResponse>(`/api/connectors/${connectorId}/sync/status`);
}

/**
 * Pause sync
 */
export async function pauseConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ paused: boolean; reason: string }> {
  return apiRequest<{ paused: boolean; reason: string }>(
    `/api/connectors/${connectorId}/sync/pause`,
    {
      method: 'POST',
      body: { reason },
    },
  );
}

/**
 * Resume sync
 */
export async function resumeConnectorSync(connectorId: string): Promise<{ resumed: boolean }> {
  return apiRequest<{ resumed: boolean }>(`/api/connectors/${connectorId}/sync/resume`, {
    method: 'POST',
  });
}
