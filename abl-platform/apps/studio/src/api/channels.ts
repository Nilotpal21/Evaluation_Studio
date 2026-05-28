/**
 * Channels API Client
 *
 * Functions for SDK channel management via the Studio proxy routes.
 * All requests go through /api/runtime/sdk-channels which authenticates,
 * resolves tenant/project context, and forwards to Runtime server-side.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export type SDKChannelAuthMode = 'anonymous' | 'hosted_exchange';
export type SDKTokenEnvelopePolicy = 'inherit' | 'signed' | 'jwe_preferred' | 'jwe_required';

export interface SDKJweCapability {
  success: true;
  supported: boolean;
  canIssueBootstrap: boolean;
  canIssueSession: boolean;
  canVerify: boolean;
  blockedReason?:
    | 'provider_disabled'
    | 'key_provider_unavailable'
    | 'transport_budget_unverified'
    | 'diagnostics_unready'
    | 'redaction_unverified';
  maxEncryptedBootstrapBytes: number;
  maxEncryptedSessionBytes: number;
}

export interface SDKChannelAuth {
  mode: SDKChannelAuthMode;
  hasServerSecret: boolean;
  serverSecretPrefix?: string;
  serverSecretLastRotatedAt?: string;
}

export interface SDKChannel {
  id: string;
  tenantId: string;
  projectId: string;
  deploymentId: string | null;
  name: string;
  channelType:
    | 'web'
    | 'mobile_ios'
    | 'mobile_android'
    | 'voice'
    | 'voice_livekit'
    | 'voice_twilio'
    | 'api';
  publicApiKeyId: string;
  config: Record<string, unknown>;
  isActive: boolean;
  environment: string | null;
  followEnvironment: boolean;
  auth: SDKChannelAuth;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelInput {
  name: string;
  channelType: string;
  deploymentId?: string;
  publicApiKeyId: string;
  config?: Record<string, unknown>;
  environment?: string | null;
  followEnvironment?: boolean;
  auth?: {
    mode?: SDKChannelAuthMode;
    rotateServerSecret?: boolean;
  };
}

export interface UpdateChannelInput {
  name?: string;
  deploymentId?: string | null;
  config?: Record<string, unknown>;
  isActive?: boolean;
  environment?: string | null;
  followEnvironment?: boolean;
  auth?: {
    mode?: SDKChannelAuthMode;
    rotateServerSecret?: boolean;
  };
}

// =============================================================================
// API — routes through Studio proxy at /api/runtime/sdk-channels
// =============================================================================

/** Project-scoped proxy (LIST, CREATE) — projectId via query param */
const PROXY_BASE = '/api/runtime/sdk-channels';

/** Per-channel proxy (GET, PATCH, DELETE) — channelId in path */
function channelDetailUrl(channelId: string) {
  return `${PROXY_BASE}/${encodeURIComponent(channelId)}`;
}

export async function fetchChannels(
  projectId: string,
): Promise<{ success: boolean; channels: SDKChannel[] }> {
  const response = await apiFetch(`${PROXY_BASE}?projectId=${encodeURIComponent(projectId)}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createChannel(
  projectId: string,
  data: CreateChannelInput,
): Promise<{ success: boolean; channel: SDKChannel; serverSecret?: string }> {
  const response = await apiFetch(`${PROXY_BASE}?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateChannel(
  _projectId: string,
  channelId: string,
  data: UpdateChannelInput,
): Promise<{ success: boolean; channel: SDKChannel; serverSecret?: string }> {
  const response = await apiFetch(channelDetailUrl(channelId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteChannel(
  _projectId: string,
  channelId: string,
): Promise<{ success: boolean }> {
  const response = await apiFetch(channelDetailUrl(channelId), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function fetchSdkJweCapability(projectId: string): Promise<SDKJweCapability> {
  const response = await apiFetch(
    `/api/runtime/sdk-jwe-capability?projectId=${encodeURIComponent(projectId)}`,
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}
