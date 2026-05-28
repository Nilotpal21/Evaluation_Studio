/**
 * Softphone API Client
 *
 * Functions for fetching softphone configuration and provisioning
 * Jambonz applications for WebRTC SIP device support.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface SoftphoneConfigResponse {
  sipDomain: string;
  wsServers: string[];
  ready: boolean;
  warnings: string[];
}

export interface SoftphoneNumber {
  number: string;
  channelName: string;
  connectionId: string;
}

export interface SoftphoneProjectDiagnostics {
  hasIssues: boolean;
  issueCount: number;
  failedAgentCount: number;
  messages: string[];
}

interface ProjectTopologyDiagnosticsResponse {
  errors?: string[];
  errorSummary?: {
    failedAgentCount?: number;
    totalErrorCount?: number;
  };
}

// =============================================================================
// API
// =============================================================================

/**
 * Fetch the SIP domain and WebSocket SBC URLs for the softphone.
 * Also returns readiness status based on Jambonz account configuration.
 */
export async function fetchSoftphoneConfig(): Promise<SoftphoneConfigResponse> {
  const response = await apiFetch(`${getRuntimeUrl()}/api/v1/voice/softphone-config`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse<SoftphoneConfigResponse>(response);
}

/**
 * Fetch dialable phone numbers for a project from voice channel connections.
 */
export async function fetchSoftphoneNumbers(projectId: string): Promise<SoftphoneNumber[]> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/v1/voice/softphone-numbers/${projectId}`,
    { headers: { 'Content-Type': 'application/json' } },
  );
  const data = await handleResponse<{ numbers?: SoftphoneNumber[] }>(response);
  return data.numbers ?? [];
}

/**
 * Fetch project compile diagnostics so LiveDial can warn when a call can connect
 * at the SIP layer but runtime will fail to start because the project DSL is invalid.
 */
export async function fetchSoftphoneProjectDiagnostics(
  projectId: string,
): Promise<SoftphoneProjectDiagnostics> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/topology`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await handleResponse<ProjectTopologyDiagnosticsResponse>(response);
  const messages = Array.isArray(data.errors) ? data.errors.filter(Boolean) : [];
  const issueCount = data.errorSummary?.totalErrorCount ?? messages.length;
  const failedAgentCount = data.errorSummary?.failedAgentCount ?? 0;

  return {
    hasIssues: issueCount > 0 || messages.length > 0,
    issueCount,
    failedAgentCount,
    messages,
  };
}
