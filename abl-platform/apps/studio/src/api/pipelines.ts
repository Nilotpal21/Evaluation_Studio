/**
 * Pipeline API Client
 *
 * Functions for pipeline CRUD operations and trigger management.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES (frontend-only — no SDK import into browser bundle)
// =============================================================================

export interface PipelineStage {
  id: string;
  name: string;
  type: string;
  provider: string;
  providerConfig: Record<string, unknown>;
  onError?: 'fail' | 'continue';
  order?: number;
  fallbackProvider?: string;
  fallbackConfig?: Record<string, unknown>;
  description?: string;
  executionCondition?: string;
}

export interface RuleCondition {
  type: 'simple' | 'compound' | 'cel';
  field?: string;
  operator?: string;
  value?: unknown;
  logic?: 'AND' | 'OR';
  conditions?: RuleCondition[];
  celExpression?: string;
}

export interface PipelineFlow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  isDefault: boolean;
  stages: PipelineStage[];
  selectionRules: RuleCondition[];
}

export interface ActiveEmbeddingConfig {
  provider: 'openai' | 'cohere' | 'bge-m3' | 'custom';
  model: string;
  dimensions: number;
  providerConfig?: Record<string, unknown>;
}

export interface EmbeddingModelInfo {
  id: string;
  name: string;
  dimensions: number[];
  defaultDimensions: number;
  costPer1MTokens: number;
  maxBatchSize: number;
  maxInputTokens: number;
}

export interface EmbeddingProviderInfo {
  id: string;
  name: string;
  description: string;
  selfHosted: boolean;
  requiresCredentials: boolean;
  hasCredentials: boolean;
  models: EmbeddingModelInfo[];
}

export interface PipelineDefinition {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  name: string;
  description?: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  flows: PipelineFlow[];
  activeEmbeddingConfig?: ActiveEmbeddingConfig;
  validationStatus?: 'valid' | 'invalid';
  validationErrors?: ValidationError[];
  lastValidatedAt?: string;
  lastDeployedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationError {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  summary: {
    errorCount: number;
    warningCount: number;
    infoCount: number;
    durationMs: number;
  };
}

export interface ProviderInfo {
  id: string;
  name: string;
  version: string;
  description: string;
}

export interface ProviderSchemas {
  providers: ProviderInfo[];
  schemas: Record<string, unknown>;
}

export interface FlowSelectionResult {
  success: boolean;
  selectedFlow?: PipelineFlow;
  details?: Record<string, unknown>;
  error?: string;
}

export interface TriggerResult {
  success: boolean;
  flowJobId?: string;
  triggeredCount?: number;
  totalDocuments?: number;
  flowJobIds?: string[];
  batchId?: string;
  pipelineId: string;
  pipelineVersion: number;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

const SEARCH_AI_BASE = '/api/search-ai';

function pipelineBasePath(projectId: string, kbId: string): string {
  return `${SEARCH_AI_BASE}/projects/${projectId}/knowledge-bases/${kbId}/pipelines`;
}

/**
 * Get the active pipeline for a knowledge base.
 */
export async function fetchPipeline(
  projectId: string,
  kbId: string,
): Promise<PipelineDefinition | null> {
  const response = await apiFetch(pipelineBasePath(projectId, kbId));
  const data = await handleResponse<{ pipeline: PipelineDefinition | null }>(response);
  return data.pipeline;
}

/**
 * Create a new pipeline for a knowledge base.
 * Creates the default pipeline template.
 */
export async function createPipeline(projectId: string, kbId: string): Promise<PipelineDefinition> {
  const response = await apiFetch(pipelineBasePath(projectId, kbId), {
    method: 'POST',
  });
  const data = await handleResponse<{ pipeline: PipelineDefinition }>(response);
  return data.pipeline;
}

/**
 * Update a pipeline definition.
 */
export async function updatePipeline(
  projectId: string,
  kbId: string,
  pipelineId: string,
  updates: Partial<PipelineDefinition>,
): Promise<{ pipeline: PipelineDefinition; validation: ValidationResult }> {
  const response = await apiFetch(`${pipelineBasePath(projectId, kbId)}/${pipelineId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return handleResponse<{ pipeline: PipelineDefinition; validation: ValidationResult }>(response);
}

export interface ReindexSummary {
  checkpoint1Count: number;
  checkpoint2Count: number;
  checkpoint3Count: number;
  checkpoint4Count: number;
  totalDocuments: number;
  totalChunks: number;
  estimatedCostUsd: number;
  estimatedDurationMin: number;
}

export interface PublishResult {
  pipeline: PipelineDefinition;
  reindex: {
    hasChanges: boolean;
    summary: ReindexSummary;
    changeSet: {
      embeddingChanged: boolean;
      routingChanged: boolean;
      preChunkChanges: number;
      postChunkChanges: number;
    };
  } | null;
}

export interface ReindexResult {
  batchId: string;
  totalItems: number;
  summary: ReindexSummary;
}

/**
 * Publish a pipeline.
 * Returns reindex analysis if there are changes requiring reindexing.
 */
export async function publishPipeline(
  projectId: string,
  kbId: string,
  pipelineId: string,
): Promise<PublishResult> {
  const response = await apiFetch(`${pipelineBasePath(projectId, kbId)}/${pipelineId}/publish`, {
    method: 'POST',
  });
  return handleResponse<PublishResult>(response);
}

/**
 * Trigger reindexing for a published pipeline.
 */
export async function triggerReindex(
  projectId: string,
  kbId: string,
  pipelineId: string,
): Promise<ReindexResult> {
  const response = await apiFetch(`${pipelineBasePath(projectId, kbId)}/${pipelineId}/reindex`, {
    method: 'POST',
  });
  return handleResponse<ReindexResult>(response);
}

/**
 * Validate a pipeline without saving.
 */
export async function validatePipeline(
  projectId: string,
  kbId: string,
  pipelineData: Partial<PipelineDefinition>,
): Promise<ValidationResult> {
  const response = await apiFetch(`${pipelineBasePath(projectId, kbId)}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pipelineData),
  });
  return handleResponse<ValidationResult>(response);
}

/**
 * Test flow selection with a sample document.
 */
export async function testFlowSelection(
  projectId: string,
  kbId: string,
  pipelineId: string,
  document: { extension: string; mimeType: string; size: number; name: string },
): Promise<FlowSelectionResult> {
  const response = await apiFetch(
    `${pipelineBasePath(projectId, kbId)}/${pipelineId}/test-selection`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document }),
    },
  );
  return handleResponse<FlowSelectionResult>(response);
}

/**
 * Get provider schemas for a stage type.
 */
export async function fetchProviderSchemas(
  projectId: string,
  stageType: string,
): Promise<ProviderSchemas> {
  const response = await apiFetch(
    `${SEARCH_AI_BASE}/projects/${projectId}/pipelines/providers/${stageType}/schemas`,
  );
  return handleResponse<ProviderSchemas>(response);
}

/**
 * Trigger pipeline for a single document.
 */
export async function triggerDocumentPipeline(
  projectId: string,
  kbId: string,
  documentId: string,
): Promise<TriggerResult> {
  const response = await apiFetch(
    `${SEARCH_AI_BASE}/projects/${projectId}/knowledge-bases/${kbId}/documents/${documentId}/trigger-pipeline`,
    { method: 'POST' },
  );
  return handleResponse<TriggerResult>(response);
}

/**
 * Trigger pipeline for all documents in a source.
 */
export async function triggerSourcePipeline(
  projectId: string,
  kbId: string,
  sourceId: string,
): Promise<TriggerResult> {
  const response = await apiFetch(
    `${SEARCH_AI_BASE}/projects/${projectId}/knowledge-bases/${kbId}/sources/${sourceId}/trigger-pipeline`,
    { method: 'POST' },
  );
  return handleResponse<TriggerResult>(response);
}

// =============================================================================
// EMBEDDING CONFIGURATION API
// =============================================================================

/**
 * Get available embedding providers with credential status.
 */
export async function fetchEmbeddingProviders(projectId: string): Promise<EmbeddingProviderInfo[]> {
  const response = await apiFetch(
    `${SEARCH_AI_BASE}/projects/${projectId}/pipelines/providers/embedding`,
  );
  const data = await handleResponse<{ data: { providers: EmbeddingProviderInfo[] } }>(response);
  return data.data.providers;
}

/**
 * Update embedding configuration for a pipeline.
 * Requires confirm: true. Triggers reindexing.
 */
export async function updateEmbeddingConfig(
  projectId: string,
  kbId: string,
  pipelineId: string,
  config: {
    provider: string;
    model: string;
    dimensions: number;
    providerConfig?: Record<string, unknown>;
    confirm: true;
  },
): Promise<{
  data: {
    previousConfig: ActiveEmbeddingConfig;
    newConfig: ActiveEmbeddingConfig;
    reindexRequired: boolean;
  };
}> {
  const response = await apiFetch(
    `${pipelineBasePath(projectId, kbId)}/${pipelineId}/embedding-config`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    },
  );
  return handleResponse(response);
}
