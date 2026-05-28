/**
 * Channel Connections API Client
 *
 * Functions for managing channel connections (messaging, voice, protocol channels)
 * against the runtime API. All endpoints are project-scoped.
 */

import { apiFetch } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

function getBase(projectId: string) {
  return `${getRuntimeUrl()}/api/projects/${projectId}/channel-connections`;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.json();
}

// =============================================================================
// TYPES
// =============================================================================

export type ChannelEnvironment = 'dev' | 'staging' | 'production';
export type ProviderVerificationStrength = 'weak' | 'strong';
export type ChannelConnectionDeleteOutcome = 'deactivated' | 'deleted';

export interface ChannelConnectionIdentityVerification {
  providerVerificationStrength: ProviderVerificationStrength;
}

export interface ChannelConnectionSummary {
  id: string;
  projectId: string;
  channelType: string;
  displayName: string | null;
  externalIdentifier: string;
  hasCredentials: boolean;
  config: Record<string, unknown>;
  identityVerification: ChannelConnectionIdentityVerification;
  status: string;
  deploymentId: string | null;
  environment: string | null;
  webhookUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  channel_type:
    | 'slack'
    | 'line'
    | 'msteams'
    | 'email'
    | 'whatsapp'
    | 'messenger'
    | 'telegram'
    | 'zendesk'
    | 'instagram'
    | 'genesys'
    | 'twilio_sms'
    | 'vxml'
    | 'voice_vxml'
    | 'jambonz'
    | 'voice_realtime'
    | 'voice_pipeline'
    | 'audiocodes'
    | 'ag_ui'
    | 'a2a'
    | 'http_async'
    | 'ai4w';
  display_name?: string;
  external_identifier?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  identityVerification?: ChannelConnectionIdentityVerification;
  deployment_id?: string;
  environment?: ChannelEnvironment;
}

export interface UpdateConnectionInput {
  display_name?: string;
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  identityVerification?: ChannelConnectionIdentityVerification;
  status?: 'active' | 'inactive';
  deployment_id?: string | null;
  environment?: ChannelEnvironment | null;
  authProfileId?: string | null;
  rotate_secret?: boolean;
}

export interface DeleteConnectionResponse {
  success: boolean;
  outcome: ChannelConnectionDeleteOutcome;
}

// =============================================================================
// API
// =============================================================================

export async function fetchConnections(
  projectId: string,
  channelType?: string,
): Promise<{ connections: ChannelConnectionSummary[] }> {
  let url = getBase(projectId);
  if (channelType) url += `?channel_type=${channelType}`;
  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function fetchConnection(
  projectId: string,
  id: string,
): Promise<{ connection: ChannelConnectionSummary }> {
  const response = await apiFetch(`${getBase(projectId)}/${id}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createConnection(
  projectId: string,
  data: CreateConnectionInput,
): Promise<{
  connection: ChannelConnectionSummary;
  ai4w?: { connectionId: string; connectionSecret: string; note: string };
}> {
  const response = await apiFetch(getBase(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateConnection(
  projectId: string,
  id: string,
  data: UpdateConnectionInput,
): Promise<{
  connection: ChannelConnectionSummary;
  ai4w?: { connectionSecret: string; note: string };
}> {
  const response = await apiFetch(`${getBase(projectId)}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteConnection(
  projectId: string,
  id: string,
): Promise<DeleteConnectionResponse> {
  const response = await apiFetch(`${getBase(projectId)}/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}
