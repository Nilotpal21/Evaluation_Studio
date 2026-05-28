/**
 * Channel OAuth API Client
 *
 * Handles initiating channel OAuth flows and exchanging callback codes.
 */

import { apiFetch } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface ChannelOAuthAuthorizeResponse {
  success: boolean;
  authUrl: string;
  state: string;
}

export interface ChannelOAuthCallbackResult {
  success: boolean;
  channelType: string;
  credentials: Record<string, string>;
  externalIdentifier: string;
  displayName: string;
  metadata: Record<string, unknown>;
  projectId: string;
}

// =============================================================================
// HELPERS
// =============================================================================

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.json();
}

// =============================================================================
// API
// =============================================================================

/** Initiate channel OAuth flow — returns the provider's authorization URL */
export async function initiateChannelOAuth(
  channelType: string,
  projectId: string,
  redirectUri: string,
): Promise<ChannelOAuthAuthorizeResponse> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/v1/channel-oauth/${channelType}/authorize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri, projectId }),
    },
  );
  return handleResponse(response);
}

/** Exchange OAuth callback code for channel credentials */
export async function exchangeChannelOAuthCode(
  channelType: string,
  code: string,
  state: string,
): Promise<ChannelOAuthCallbackResult> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/v1/channel-oauth/${channelType}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
  return handleResponse(response);
}
