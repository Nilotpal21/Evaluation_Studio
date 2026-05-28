/**
 * Modules API Client
 *
 * Functions for module settings, releases, catalog, and dependency management.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface ModuleSettings {
  enabled: boolean;
  moduleVisibility: 'tenant' | 'private' | null;
}

export interface ModuleRelease {
  id: string;
  version: string;
  releaseNotes: string | null;
  contract: ModuleContract | null;
  sourceHash: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

export interface ModuleContract {
  providedAgents?: Array<{ name: string }>;
  providedTools?: Array<{ name: string }>;
  requiredConfigKeys?: Array<{ key: string; isSecret: boolean }>;
  requiredSecrets?: Array<{ key: string; referencedBy: string[]; toolName?: string }>;
  requiredAuthProfiles?: string[];
  requiredConnectors?: string[];
}

export interface CatalogEntry {
  moduleProjectId: string;
  name: string;
  description: string | null;
  moduleVisibility: 'tenant' | 'private' | null;
  latestVersion: string | null;
  latestReleaseDate: string | null;
  providedAgentCount: number;
  providedToolCount: number;
  environments: Array<{
    environment: string;
    moduleReleaseId?: string;
    revision?: number;
  }>;
}

export interface CatalogDetail {
  moduleProjectId: string;
  name: string;
  description: string | null;
  moduleVisibility: 'tenant' | 'private' | null;
  releases: Array<{
    id: string;
    version: string;
    releaseNotes: string | null;
    contract: ModuleContract | null;
    sourceHash: string;
    createdAt: string;
    createdBy: string;
  }>;
  environments: Array<{
    environment: string;
    moduleReleaseId?: string;
    revision?: number;
  }>;
}

export interface ModuleDependency {
  id: string;
  alias: string;
  moduleProjectId: string;
  moduleProjectName: string;
  selector: { type: 'version' | 'environment'; value: string };
  resolvedReleaseId: string;
  resolvedVersion: string;
  configOverrides: Record<string, string>;
  contractSnapshot: ModuleContract | null;
  updateAvailable?: {
    latestVersion: string;
    latestReleaseId: string;
  };
  createdAt: string;
  createdBy: string;
}

export interface ImportPreview {
  resolvedReleaseId: string;
  resolvedVersion: string;
  mountedSymbols: {
    agents: string[];
    tools: string[];
  };
  prerequisites: {
    blocking: string[];
    warnings: string[];
  };
  collisions: Array<{
    mountedName: string;
    conflictsWith: string;
  }>;
}

export interface PromotePointer {
  environment: string;
  moduleReleaseId: string;
  revision: number;
}

// =============================================================================
// MODULE SETTINGS
// =============================================================================

export async function getModuleSettings(
  projectId: string,
): Promise<{ success: boolean; data: ModuleSettings }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module`);
  return handleResponse(res);
}

export async function enableModule(
  projectId: string,
  params: { enabled: boolean; moduleVisibility?: 'tenant' | 'private' },
): Promise<{ success: boolean; message: string }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return handleResponse(res);
}

// =============================================================================
// RELEASES
// =============================================================================

export async function listReleases(
  projectId: string,
  cursor?: string,
  limit?: number,
): Promise<{
  success: boolean;
  data: ModuleRelease[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (limit) qs.set('limit', String(limit));
  const query = qs.toString() ? `?${qs}` : '';

  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module/releases${query}`,
  );
  return handleResponse(res);
}

export async function publishRelease(
  projectId: string,
  params: {
    version: string;
    releaseNotes?: string;
    promoteToEnvironment?: string;
  },
): Promise<{
  success: boolean;
  data: {
    releaseId: string;
    version: string;
    contract: ModuleContract | null;
    warnings: string[];
  };
}> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return handleResponse(res);
}

// =============================================================================
// PROMOTE
// =============================================================================

export async function promoteRelease(
  projectId: string,
  releaseId: string,
  params: { environment: string; expectedRevision?: number },
): Promise<{ success: boolean; message: string; pointer: PromotePointer }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module/releases/${encodeURIComponent(releaseId)}/promote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
  );
  return handleResponse(res);
}

// =============================================================================
// CATALOG
// =============================================================================

export async function listCatalog(
  projectId: string,
): Promise<{ success: boolean; data: CatalogEntry[] }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module-catalog`);
  return handleResponse(res);
}

export async function getModuleDetail(
  projectId: string,
  moduleProjectId: string,
): Promise<{ success: boolean; data: CatalogDetail }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module-catalog/${encodeURIComponent(moduleProjectId)}`,
  );
  return handleResponse(res);
}

// =============================================================================
// DEPENDENCIES
// =============================================================================

export async function listDependencies(
  projectId: string,
): Promise<{ success: boolean; data: ModuleDependency[] }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module-dependencies`);
  return handleResponse(res);
}

export async function previewImport(
  projectId: string,
  params: {
    moduleProjectId: string;
    selector: { type: 'version' | 'environment'; value: string };
    alias: string;
    configOverrides?: Record<string, string>;
  },
): Promise<{ success: boolean; data: ImportPreview }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module-dependencies/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
  );
  return handleResponse(res);
}

export async function confirmImport(
  projectId: string,
  params: {
    moduleProjectId: string;
    selector: { type: 'version' | 'environment'; value: string };
    alias: string;
    resolvedReleaseId: string;
    configOverrides?: Record<string, string>;
  },
): Promise<{ success: boolean; data: ModuleDependency }> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module-dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return handleResponse(res);
}

export async function removeDependency(
  projectId: string,
  dependencyId: string,
): Promise<{ success: boolean; message: string }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module-dependencies/${encodeURIComponent(dependencyId)}`,
    { method: 'DELETE' },
  );
  return handleResponse(res);
}

// =============================================================================
// POINTERS
// =============================================================================

export async function fetchModulePointers(
  projectId: string,
): Promise<{ success: boolean; data: PromotePointer[] }> {
  try {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module/pointers`);
    if (!res.ok) return { success: false, data: [] };
    return handleResponse(res);
  } catch {
    // Endpoint may not exist yet — gracefully degrade to empty
    return { success: false, data: [] };
  }
}

// =============================================================================
// UPGRADE DIFF
// =============================================================================

export interface ContractDiffEntry {
  name: string;
  change: 'added' | 'removed' | 'modified';
  severity: 'breaking' | 'non-breaking' | 'warn';
  detail?: string;
}

export interface ModuleContractDiff {
  agents: ContractDiffEntry[];
  tools: ContractDiffEntry[];
  configKeys: ContractDiffEntry[];
  envVars: ContractDiffEntry[];
  secrets: ContractDiffEntry[];
  authProfiles: ContractDiffEntry[];
  connectors: ContractDiffEntry[];
  mcpServers: ContractDiffEntry[];
  warnings: ContractDiffEntry[];
  hasBreakingChanges: boolean;
  summary: string;
}

export interface MountedSymbolChange {
  symbolType: 'agent' | 'tool';
  name: string;
  mountedName: string;
  change: 'added' | 'removed';
}

export interface PrerequisiteIssue {
  type: string;
  name: string;
  severity: 'breaking' | 'warn';
}

export interface UpgradeDiff {
  diff: ModuleContractDiff;
  prerequisiteIssues: PrerequisiteIssue[];
  mountedSymbolChanges: MountedSymbolChange[];
  currentVersion: string;
  targetVersion: string;
}

export async function getUpgradeDiff(
  projectId: string,
  dependencyId: string,
  targetReleaseId: string,
): Promise<{ success: boolean; data: UpgradeDiff }> {
  const qs = new URLSearchParams({ targetReleaseId });
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module-dependencies/${encodeURIComponent(dependencyId)}/diff?${qs}`,
  );
  return handleResponse(res);
}

export async function upgradeDependency(
  projectId: string,
  dependencyId: string,
  params: { targetReleaseId: string; configOverrides?: Record<string, string> },
): Promise<{ success: boolean; data: ModuleDependency & { previousVersion: string } }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module-dependencies/${encodeURIComponent(dependencyId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
  );
  return handleResponse(res);
}

// =============================================================================
// CONSUMERS
// =============================================================================

export interface ModuleConsumer {
  dependencyId: string;
  projectId: string;
  projectName: string;
  alias: string;
  resolvedVersion: string;
  resolvedReleaseId: string;
  selectorType: string;
  selectorValue: string;
  hasActiveDeployment: boolean;
  createdAt: string;
}

export async function listConsumers(projectId: string): Promise<{
  success: boolean;
  data: ModuleConsumer[];
  summary: { totalConsumers: number; activeDeployments: number };
}> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/module/consumers`);
  return handleResponse(res);
}

// =============================================================================
// ARCHIVE RELEASE
// =============================================================================

export async function archiveRelease(
  projectId: string,
  releaseId: string,
): Promise<{ success: boolean; message: string; releaseId: string; version: string }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/module/releases/${encodeURIComponent(releaseId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    },
  );
  return handleResponse(res);
}

// =============================================================================
// FEATURES
// =============================================================================

export async function getFeatures(): Promise<{ hasModules: boolean }> {
  const res = await apiFetch('/api/features');
  if (!res.ok) {
    return { hasModules: false };
  }
  const json = await res.json();
  const data = json.data ?? {};
  return { hasModules: data.reusable_modules ?? false };
}
