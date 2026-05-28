/**
 * Project I/O API Client
 *
 * Functions for export, import, and git integration against the Studio API routes.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { AppError } from '@agent-platform/shared/errors';
import { sanitizeServerError } from '../lib/sanitize-error';
import type { ExportDslFormat } from '@agent-platform/project-io';

// =============================================================================
// TYPES — Export
// =============================================================================

export interface ExportPreviewAgent {
  name: string;
  hasDslContent: boolean;
}

export interface ExportPreviewTool {
  name: string;
  toolType: string;
}

export interface ExportPreviewDependencyWarning {
  from: string;
  to: string;
  type: string;
}

export interface ExportReadinessDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  source?: string | null;
}

export interface ExportReadinessIssue {
  kind: 'agent_draft' | 'runtime_config';
  agentName?: string;
  diagnostics: ExportReadinessDiagnostic[];
}

export interface ExportPreviewResponse {
  project: { name: string; slug: string };
  agents: ExportPreviewAgent[];
  tools: ExportPreviewTool[];
  profiles: string[];
  dependencies: {
    edges: Array<{ from: string; to: string; type: string }>;
    validation: {
      valid: boolean;
      missing: ExportPreviewDependencyWarning[];
      circular: string[][];
    };
  };
}

export interface ExportResponse {
  success: boolean;
  manifest: Record<string, unknown>;
  lockfile: Record<string, unknown>;
  files: Record<string, string>;
  warnings: string[];
}

export interface ExportLayerInfo {
  name: string;
  defaultMode: 'always' | 'on' | 'off';
  entityCount: number;
}

export interface ExportProvisioningInfo {
  requiredEnvVars: string[];
  requiredAuthProfiles: Array<{
    name: string;
    authType: string;
    scope: 'tenant' | 'project';
    connector?: string;
    category?: string;
    connectionMode?: 'shared' | 'per_user';
    config: Record<string, unknown>;
    referencedBy: string[];
  }>;
  requiredConnectors: string[];
  requiredMcpServers: string[];
}

export interface ExportPreviewResponseV2 extends ExportPreviewResponse {
  layers: ExportLayerInfo[];
  defaultLayers: string[];
  provisioning: ExportProvisioningInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExportReadinessDiagnostic(value: unknown): value is ExportReadinessDiagnostic {
  return (
    isRecord(value) &&
    (value.severity === 'error' || value.severity === 'warning') &&
    typeof value.message === 'string'
  );
}

function isExportReadinessIssue(value: unknown): value is ExportReadinessIssue {
  return (
    isRecord(value) &&
    (value.kind === 'agent_draft' || value.kind === 'runtime_config') &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isExportReadinessDiagnostic)
  );
}

function formatExportReadinessMessages(issues: readonly ExportReadinessIssue[]): string[] {
  return issues
    .flatMap((issue) =>
      issue.diagnostics.map((diagnostic) => {
        const safeMessage = sanitizeServerError(diagnostic.message, 'Export blocked');
        return issue.kind === 'agent_draft' && issue.agentName
          ? `Agent "${issue.agentName}": ${safeMessage}`
          : safeMessage;
      }),
    )
    .filter((message, index, all) => message.length > 0 && all.indexOf(message) === index);
}

export function getExportErrorIssues(error: unknown): ExportReadinessIssue[] {
  if (!(error instanceof Error) || !('cause' in error)) {
    return [];
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (!isRecord(cause) || !Array.isArray(cause.issues)) {
    return [];
  }

  return cause.issues.filter(isExportReadinessIssue);
}

export function getExportErrorMessages(error: unknown, fallback: string): string[] {
  const issueMessages = formatExportReadinessMessages(getExportErrorIssues(error));
  if (issueMessages.length > 0) {
    return issueMessages;
  }

  if (error instanceof AppError || error instanceof Error) {
    return [sanitizeServerError(error.message, fallback)];
  }

  return [fallback];
}

// =============================================================================
// TYPES — Import
// =============================================================================

/** Agent-level change details (shared between v1 and v2) */
export interface AgentChanges {
  added: string[];
  modified: Array<{
    name: string;
    diff: {
      hasChanges: boolean;
      sections: unknown[];
      summary: {
        added: string[];
        removed: string[];
        modified: string[];
        unchanged: string[];
      };
    };
  }>;
  removed: string[];
  unchanged: string[];
}

/** Layer-level change counts (v2) */
export interface LayerChangeSummary {
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
}

export interface ImportPreviewIssue {
  id: string;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  category:
    | 'general'
    | 'syntax'
    | 'tool'
    | 'compile'
    | 'dependency'
    | 'integrity'
    | 'entry_agent'
    | 'identity'
    | 'binding';
  message: string;
  code?: string;
  file?: string;
  line?: number;
  agent?: string;
}

export interface ImportBindingResolutionRequest {
  id: string;
  kind: 'searchai_index' | 'workflow_trigger';
  toolName: string;
  toolType: 'searchai' | 'workflow';
  message: string;
  required: boolean;
  supportedActions: Array<'map_existing' | 'create_from_archive' | 'defer' | 'skip_tool'>;
  source: {
    tenantId?: string;
    indexId?: string;
    kbName?: string;
    workflowId?: string;
    workflowVersion?: string;
    triggerId?: string;
  };
}

export interface ImportBindingResolutionInput {
  action: 'map_existing' | 'create_from_archive' | 'defer' | 'skip_tool';
  target?: {
    indexId?: string;
    workflowId?: string;
    workflowVersion?: string;
    triggerId?: string;
  };
}

export interface ImportApiErrorEntry {
  msg: string;
  code: string;
}

export interface ImportContractError {
  code: string;
  message: string;
  stage?: string;
  sanitizedCause?: string;
}

/**
 * Import preview response — v2 format (returned by importProjectV2).
 * v1 `changes.agents` is now `agentChanges` at top level.
 * v1 `changes.tools` / `changes.locales` are replaced by `layerChanges` counts.
 */
export interface ImportPreviewResponse {
  success: boolean;
  previewDigest?: string;
  errors?: ImportApiErrorEntry[];
  preview?: {
    valid: boolean;
    formatVersion: '1.0' | '2.0';
    layers: string[];
    layerChanges: Partial<Record<string, LayerChangeSummary>>;
    agentChanges: AgentChanges;
    toolChanges: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    localeChanges?: {
      added: string[];
      modified: string[];
      removed: string[];
    };
    shaIntegrity: {
      valid: boolean;
      integrityMatch: boolean;
      layerResults: Record<string, { valid: boolean; mismatchedFiles: string[] }>;
      errors: string[];
      warnings: string[];
    };
    crossLayerDeps: {
      valid: boolean;
      missingDependencies: Array<{
        source: string;
        sourceLayer: string;
        target: string;
        targetLayer: string;
        type: string;
      }>;
      warnings: string[];
    };
    syntaxErrors: Array<{ file: string; errors: Array<{ line: number; message: string }> }>;
    bindingResolutionRequests?: ImportBindingResolutionRequest[];
    issues: ImportPreviewIssue[];
    hasBlockingIssues: boolean;
    requiresAcknowledgement: boolean;
    blockingIssueCount: number;
    nonBlockingIssueCount: number;
    entryAgentResolution: {
      requested: string | null;
      resolved: string | null;
      matchedBy: 'exact' | 'alias' | 'missing' | 'none';
    };
    previewDigest?: string;
    warnings: string[];
  };
  warnings: string[];
  error?: ImportContractError | string | null;
}

export interface ImportApplySummary {
  created: number;
  updated: number;
  deleted: number;
  toolsCreated: number;
  toolsUpdated: number;
  toolsDeleted: number;
  localesCreated: number;
  localesUpdated: number;
  localesDeleted: number;
  evalsCreated?: number;
  evalsUpdated?: number;
  evalsDeleted?: number;
}

export interface ImportApplySuccessResponse {
  success: true;
  applied: ImportApplySummary;
  entryAgentName: string | null;
  previewDigest?: string;
  preview?: ImportPreviewResponse['preview'];
  warnings: string[];
}

export interface ImportApplyFailureResponse {
  success: false;
  previewDigest?: string;
  preview?: ImportPreviewResponse['preview'];
  errors?: ImportApiErrorEntry[];
  warnings?: string[];
  error: ImportContractError | null;
  operationId?: string;
}

export type ImportApplyResponse = ImportApplySuccessResponse | ImportApplyFailureResponse;

export interface ImportOperationStatusLayer {
  status: string;
}

export interface ImportOperationStatusData {
  operationId: string;
  status: string;
  layers: Record<string, ImportOperationStatusLayer>;
  error: {
    phase: string;
    layer: string;
    message: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportOperationStatusResponse {
  success: boolean;
  data?: ImportOperationStatusData;
  error?: ImportContractError | null;
}

// =============================================================================
// TYPES — Git
// =============================================================================

export interface GitIntegration {
  id: string;
  projectId: string;
  provider: 'github' | 'gitlab' | 'bitbucket';
  repositoryUrl: string;
  defaultBranch: string;
  syncPath: string;
  authProfileId: string;
  syncConfig: {
    autoSync: boolean;
    autoDeploy: {
      enabled: boolean;
      environment: string;
      branch: string;
    } | null;
    conflictStrategy: 'manual' | 'local_wins' | 'remote_wins';
  };
  lastSyncAt: string | null;
  lastSyncCommit: string | null;
  lastSyncStatus: 'success' | 'failed' | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitStatusResponse {
  integration: {
    provider: string;
    repositoryUrl: string;
    defaultBranch: string;
    lastSyncAt: string | null;
    lastSyncCommit: string | null;
    lastSyncStatus: 'success' | 'failed' | null;
  };
  localLayers: ExportLayerInfo[];
  defaultLayers: string[];
  localAgents: Array<{
    name: string;
    sourceHash: string | null;
    lastEditedAt: string | null;
  }>;
  localLocaleFiles: Array<{
    id: string;
    relativePath: string;
    filePath: string;
    localeCode: string;
    scope: 'shared' | 'agent';
    updatedAt: string | null;
  }>;
  message: string;
}

export interface GitSyncHistoryEntry {
  projectId: string;
  direction: 'push' | 'pull';
  commitSha: string;
  branch: string;
  status: 'success' | 'failed';
  agentsAffected: string[];
  changesSummary: { added: string[]; modified: string[]; deleted: string[] };
  triggeredBy: string;
  createdAt: string;
}

// =============================================================================
// EXPORT API
// =============================================================================

function projectUrl(projectId: string, path: string) {
  return `/api/projects/${projectId}${path}`;
}

function isImportResponseEnvelope(value: unknown): value is { success: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success?: unknown }).success === 'boolean'
  );
}

function normalizeImportEnvelope<T extends { success: boolean }>(body: T): T {
  if (body.success || typeof body !== 'object' || body === null) {
    return body;
  }

  const failureBody = body as T & {
    error?: ImportContractError | string | null;
    errors?: ImportApiErrorEntry[];
  };

  if (failureBody.error || !Array.isArray(failureBody.errors) || failureBody.errors.length === 0) {
    return body;
  }

  const messages = failureBody.errors.map((entry) => entry.msg).filter(Boolean);
  const primaryCode = failureBody.errors[0]?.code ?? 'REQUEST_FAILED';

  return {
    ...failureBody,
    error: {
      code: primaryCode,
      message: sanitizeServerError(messages.join(' | '), 'Request failed'),
    },
  } as T;
}

async function handleImportResponse<T extends { success: boolean }>(
  response: Response,
): Promise<T> {
  const body = await response.json().catch(() => null);

  if (isImportResponseEnvelope(body)) {
    return normalizeImportEnvelope(body as T);
  }

  if (!response.ok) {
    const nestedError =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'object'
        ? (body.error as {
            code?: string;
            message?: string;
            stage?: string;
            sanitizedCause?: string;
          })
        : undefined;
    const operationId =
      body &&
      typeof body === 'object' &&
      'operationId' in body &&
      typeof body.operationId === 'string'
        ? body.operationId
        : undefined;

    const message =
      nestedError?.message ??
      (body && typeof body === 'object' && 'errors' in body && Array.isArray(body.errors)
        ? (body.errors[0] as { msg?: string } | undefined)?.msg
        : undefined) ??
      'Request failed';
    const code =
      nestedError?.code ??
      (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
        ? body.code
        : `HTTP_${response.status}`);

    throw new AppError(sanitizeServerError(message, 'Request failed'), {
      code,
      statusCode: response.status,
      cause:
        nestedError || operationId
          ? {
              stage: nestedError?.stage,
              sanitizedCause: nestedError?.sanitizedCause,
              operationId,
            }
          : undefined,
    });
  }

  throw new AppError('Malformed import response', {
    code: 'INVALID_IMPORT_RESPONSE',
    statusCode: 500,
  });
}

export async function fetchExportPreview(projectId: string): Promise<ExportPreviewResponseV2> {
  const response = await apiFetch(projectUrl(projectId, '/export/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function fetchExport(
  projectId: string,
  format: 'zip' | 'folder' | 'tar.gz' = 'zip',
  dslFormat: ExportDslFormat = 'source',
): Promise<ExportResponse> {
  // Always use v2 format
  return fetchExportV2(projectId, [], format, dslFormat);
}

export async function fetchExportV2(
  projectId: string,
  layers: string[],
  format: 'zip' | 'folder' | 'tar.gz' = 'zip',
  dslFormat: ExportDslFormat = 'source',
): Promise<ExportResponse> {
  const qs = new URLSearchParams({
    version: '2',
    format,
    dsl_format: dslFormat,
    layers: layers.join(','),
  });
  const response = await apiFetch(projectUrl(projectId, `/export?${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// =============================================================================
// IMPORT API
// =============================================================================

export async function fetchImportPreview(
  projectId: string,
  files: Record<string, string>,
  options?: {
    deleteUnmatched?: boolean;
    bindingResolutions?: Record<string, ImportBindingResolutionInput>;
  },
): Promise<ImportPreviewResponse> {
  const response = await apiFetch(projectUrl(projectId, '/import/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      deleteUnmatched: options?.deleteUnmatched ?? false,
      bindingResolutions: options?.bindingResolutions,
    }),
  });
  return handleImportResponse<ImportPreviewResponse>(response);
}

export async function applyImport(
  projectId: string,
  files: Record<string, string>,
  options?: {
    deleteUnmatched?: boolean;
    previewDigest?: string | null;
    acknowledgedIssueIds?: string[];
    bindingResolutions?: Record<string, ImportBindingResolutionInput>;
  },
): Promise<ImportApplyResponse> {
  const response = await apiFetch(projectUrl(projectId, '/import/apply'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files,
      deleteUnmatched: options?.deleteUnmatched ?? false,
      previewDigest: options?.previewDigest ?? null,
      acknowledgedIssueIds: options?.acknowledgedIssueIds ?? [],
      bindingResolutions: options?.bindingResolutions,
    }),
  });
  return handleImportResponse<ImportApplyResponse>(response);
}

export async function fetchImportStatus(
  projectId: string,
  operationId: string,
): Promise<ImportOperationStatusResponse> {
  const qs = new URLSearchParams({ operationId });
  const response = await apiFetch(projectUrl(projectId, `/import/status?${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleImportResponse<ImportOperationStatusResponse>(response);
}

// =============================================================================
// GIT INTEGRATION API
// =============================================================================

export async function fetchGitIntegration(
  projectId: string,
): Promise<{ integration: GitIntegration | null }> {
  const response = await apiFetch(projectUrl(projectId, '/git'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createGitIntegration(
  projectId: string,
  data: {
    provider: 'github' | 'gitlab' | 'bitbucket';
    repositoryUrl: string;
    defaultBranch?: string;
    syncPath?: string;
    authProfileId: string;
    syncConfig?: { autoSync?: boolean; conflictStrategy?: 'manual' | 'ours' | 'theirs' };
  },
): Promise<{ integration: GitIntegration }> {
  const response = await apiFetch(projectUrl(projectId, '/git'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function updateGitIntegration(
  projectId: string,
  data: {
    defaultBranch?: string;
    syncPath?: string;
    syncConfig?: { autoSync?: boolean; conflictStrategy?: 'manual' | 'ours' | 'theirs' };
  },
): Promise<{ integration: GitIntegration }> {
  const response = await apiFetch(projectUrl(projectId, '/git'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteGitIntegration(projectId: string): Promise<{ success: boolean }> {
  const response = await apiFetch(projectUrl(projectId, '/git'), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function fetchGitStatus(projectId: string): Promise<GitStatusResponse> {
  const response = await apiFetch(projectUrl(projectId, '/git/status'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function pushToGit(
  projectId: string,
  data?: { commitMessage?: string; branch?: string },
): Promise<{
  success: boolean;
  branch: string;
  agentsCount: number;
  localeFilesCount?: number;
  message?: string;
}> {
  const response = await apiFetch(projectUrl(projectId, '/git/push'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });
  return handleResponse(response);
}

export async function pullFromGit(
  projectId: string,
  data?: { branch?: string; dryRun?: boolean },
): Promise<{ success: boolean; branch: string; message: string }> {
  const response = await apiFetch(projectUrl(projectId, '/git/pull'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });
  return handleResponse(response);
}

export async function fetchGitHistory(
  projectId: string,
  params?: { limit?: number; direction?: 'push' | 'pull' },
): Promise<{ history: GitSyncHistoryEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.direction) qs.set('direction', params.direction);
  const query = qs.toString() ? `?${qs}` : '';

  const response = await apiFetch(projectUrl(projectId, `/git/history${query}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}
