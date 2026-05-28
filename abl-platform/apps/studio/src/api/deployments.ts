/**
 * Deployments API Client
 *
 * Functions for deployment lifecycle management against the runtime API.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface ModelOverride {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  tenantId: string;
  environment: 'dev' | 'staging' | 'production';
  label: string | null;
  description: string | null;
  agentVersionManifest: Record<string, string>;
  entryAgentName: string;
  compilationHash: string | null;
  status: 'active' | 'draining' | 'retired';
  endpointSlug: string;
  previousDeploymentId: string | null;
  promotedFromDeploymentId: string | null;
  createdBy: string;
  createdAt: string;
  retiredAt: string | null;
  drainingStartedAt: string | null;
  channelCount?: number;
  modelOverrides: Record<string, ModelOverride> | null;
}

export interface CreateDeploymentInput {
  environment: string;
  agentVersionManifest: Record<string, string>;
  entryAgentName: string;
  label?: string;
  description?: string;
  modelOverrides?: Record<string, ModelOverride>;
}

export interface PromoteDeploymentInput {
  targetEnvironment: 'dev' | 'staging' | 'production';
  label?: string;
  description?: string;
  modelOverrides?: Record<string, ModelOverride>;
}

// =============================================================================
// API
// =============================================================================

function deploymentUrl(projectId: string, path = '') {
  return `${getRuntimeUrl()}/api/projects/${projectId}/deployments${path}`;
}

export async function fetchDeployments(
  projectId: string,
  params?: { environment?: string; status?: string },
): Promise<{ success: boolean; deployments: Deployment[] }> {
  const qs = new URLSearchParams();
  if (params?.environment) qs.set('environment', params.environment);
  if (params?.status) qs.set('status', params.status);
  const query = qs.toString() ? `?${qs}` : '';

  const response = await apiFetch(deploymentUrl(projectId, query), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createDeployment(
  projectId: string,
  data: CreateDeploymentInput,
): Promise<{ success: boolean; deployment: Deployment }> {
  const response = await apiFetch(deploymentUrl(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function getDeployment(
  projectId: string,
  deploymentId: string,
): Promise<{ success: boolean; deployment: Deployment }> {
  const response = await apiFetch(deploymentUrl(projectId, `/${deploymentId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function retireDeployment(
  projectId: string,
  deploymentId: string,
): Promise<{ success: boolean; deployment: Deployment }> {
  const response = await apiFetch(deploymentUrl(projectId, `/${deploymentId}/retire`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function rollbackDeployment(
  projectId: string,
  deploymentId: string,
): Promise<{ success: boolean; deployment: Deployment }> {
  const response = await apiFetch(deploymentUrl(projectId, `/${deploymentId}/rollback`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function promoteDeployment(
  projectId: string,
  deploymentId: string,
  data: PromoteDeploymentInput,
): Promise<{ success: boolean; deployment: Deployment; channelsUpdated: number }> {
  const response = await apiFetch(deploymentUrl(projectId, `/${deploymentId}/promote`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

// =============================================================================
// SNAPSHOT TYPES
// =============================================================================

export interface SnapshotEnvVar {
  key: string;
  isSecret: boolean;
  description: string | null;
  namespaces: string[];
}

export interface SnapshotConfigVar {
  key: string;
  value: string;
  description: string | null;
  namespaces: string[];
}

export interface DeploymentSnapshot {
  id: string;
  deploymentId: string;
  environment: string;
  snapshotVersion: number;
  snapshotHash: string;
  envVars: SnapshotEnvVar[];
  configVars: SnapshotConfigVar[];
  createdBy: string;
  createdAt?: string;
}

export interface SnapshotDiffEntry {
  key: string;
  type: 'env' | 'config';
  namespaces: string[];
  valueChanged?: boolean;
}

export interface SnapshotDiff {
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  changed: SnapshotDiffEntry[];
}

// =============================================================================
// SNAPSHOT API
// =============================================================================

export async function fetchDeploymentSnapshot(
  projectId: string,
  deploymentId: string,
): Promise<{ success: boolean; snapshot: DeploymentSnapshot }> {
  const response = await apiFetch(deploymentUrl(projectId, `/${deploymentId}/snapshot`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function fetchSnapshotValue(
  projectId: string,
  deploymentId: string,
  key: string,
): Promise<{ success: boolean; key: string; value: string }> {
  const response = await apiFetch(
    deploymentUrl(projectId, `/${deploymentId}/snapshot/value/${encodeURIComponent(key)}`),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse(response);
}

export async function fetchSnapshotDiff(
  projectId: string,
  deploymentId: string,
  compareWithId: string,
): Promise<{
  success: boolean;
  identical: boolean;
  sourceHash: string;
  targetHash: string;
  diff?: SnapshotDiff;
}> {
  const response = await apiFetch(
    deploymentUrl(
      projectId,
      `/${deploymentId}/snapshot/diff?compareWith=${encodeURIComponent(compareWithId)}`,
    ),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse(response);
}
