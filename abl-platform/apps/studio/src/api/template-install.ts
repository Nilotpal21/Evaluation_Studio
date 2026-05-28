/**
 * Template Install API Client
 *
 * Client-side functions for the template install flow.
 * All calls go through apiFetch() which auto-attaches JWT auth headers.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ProjectInstallRequest {
  templateSlug: string;
  version: string;
  projectName: string;
  projectSlug?: string;
  description?: string;
}

export interface AppliedCounts {
  created: number;
  updated: number;
  deleted: number;
  toolsCreated: number;
  toolsUpdated: number;
  toolsDeleted: number;
  localesCreated: number;
  localesUpdated: number;
  localesDeleted: number;
  profilesCreated: number;
  profilesUpdated: number;
  profilesDeleted: number;
  evalsCreated: number;
  evalsUpdated: number;
  evalsDeleted: number;
  modelPoliciesUpserted: number;
  modelPoliciesDeleted: number;
}

export interface ProvisioningReport {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
}

export interface ProjectInstallResponse {
  success: true;
  project: { id: string; name: string; slug: string };
  applied: AppliedCounts;
  entryAgentName: string | null;
  provisioningRequired: ProvisioningReport;
}

export interface AgentPreviewRequest {
  templateSlug: string;
  version: string;
}

export interface AgentPreviewResponse {
  success: true;
  preview: {
    layers: string[];
    agentChanges: {
      added: string[];
      modified: Array<{ name: string; changes: string[] }>;
      removed: string[];
      unchanged: string[];
    };
    toolChanges: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    issues: Array<{ id: string; severity: string; message: string }>;
    hasBlockingIssues: boolean;
    previewDigest: string;
    entryAgentResolution: { resolved: string | null };
  };
  previewDigest: string | null;
  warnings: string[];
}

export interface AgentApplyRequest {
  templateSlug: string;
  version: string;
  previewDigest?: string | null;
  acknowledgedIssueIds?: string[];
}

export interface AgentApplyResponse {
  success: true;
  operationId: string;
  applied: AppliedCounts;
  entryAgentName: string | null;
  warnings: string[];
  provisioningRequired: ProvisioningReport;
}

// ─── API Functions ──────────────────────────────────────────────────────

/**
 * Install a project template — creates a new project and imports the bundle.
 */
export async function installProjectTemplate(
  input: ProjectInstallRequest,
): Promise<ProjectInstallResponse> {
  const response = await apiFetch('/api/template-install/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  return handleResponse<ProjectInstallResponse>(response);
}

/**
 * Preview an agent template install — dry-run into an existing project.
 */
export async function previewAgentInstall(
  projectId: string,
  input: AgentPreviewRequest,
): Promise<AgentPreviewResponse> {
  const response = await apiFetch(
    `/api/template-install/agent/${encodeURIComponent(projectId)}/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  return handleResponse<AgentPreviewResponse>(response);
}

/**
 * Apply an agent template install — merge into an existing project.
 */
export async function applyAgentInstall(
  projectId: string,
  input: AgentApplyRequest,
): Promise<AgentApplyResponse> {
  const response = await apiFetch(
    `/api/template-install/agent/${encodeURIComponent(projectId)}/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  return handleResponse<AgentApplyResponse>(response);
}
