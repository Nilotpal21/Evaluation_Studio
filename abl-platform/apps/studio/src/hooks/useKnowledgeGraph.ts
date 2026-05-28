/**
 * useKnowledgeGraph Hook
 *
 * SWR hooks for Knowledge Graph statistics, documents, and entities.
 */

import useSWR from 'swr';
import { useState } from 'react';
import { apiFetch } from '../lib/api-client';
import type {
  KGStats,
  ClassifiedDocumentsResult,
  EntityDistributionResult,
  GraphStructure,
  DomainSummary,
  TaxonomyDetail,
  TaxonomySetupJobStatus,
} from '../api/search-ai';

interface UseKGStatsReturn {
  stats: KGStats | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

interface UseClassifiedDocumentsReturn {
  documents: ClassifiedDocumentsResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

interface UseEntityDistributionReturn {
  entities: EntityDistributionResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch Knowledge Graph statistics
 */
export function useKGStats(indexId: string | null): UseKGStatsReturn {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/kg-enrich/stats` : null;
  const { data, error, isLoading, mutate } = useSWR<KGStats>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  return {
    stats: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

/**
 * Fetch classified documents with pagination and filtering
 */
export function useClassifiedDocuments(
  indexId: string | null,
  params?: {
    page?: number;
    limit?: number;
    productId?: string;
    department?: string;
    minConfidence?: number;
    sortBy?: 'confidence' | 'createdAt';
    sortOrder?: 'asc' | 'desc';
  },
): UseClassifiedDocumentsReturn {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.set('page', params.page.toString());
  if (params?.limit) queryParams.set('limit', params.limit.toString());
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.department) queryParams.set('department', params.department);
  if (params?.minConfidence) queryParams.set('minConfidence', params.minConfidence.toString());
  if (params?.sortBy) queryParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) queryParams.set('sortOrder', params.sortOrder);

  const key =
    indexId && params
      ? `/api/search-ai/indexes/${indexId}/kg-enrich/documents?${queryParams.toString()}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<ClassifiedDocumentsResult>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  return {
    documents: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

/**
 * Fetch entity distribution
 */
export function useEntityDistribution(
  indexId: string | null,
  params?: {
    productId?: string;
    limit?: number;
  },
): UseEntityDistributionReturn {
  const queryParams = new URLSearchParams();
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.limit) queryParams.set('limit', params.limit.toString());

  const key = indexId
    ? `/api/search-ai/indexes/${indexId}/kg-enrich/entities?${queryParams.toString()}`
    : null;

  const { data, error, isLoading, mutate } = useSWR<EntityDistributionResult>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  return {
    entities: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

// ─── Domain & Taxonomy Hooks ────────────────────────────────────────────

interface UseKGDomainsReturn {
  domains: DomainSummary[] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch available KG domain definitions
 */
export function useKGDomains(): UseKGDomainsReturn {
  const { data, error, isLoading, mutate } = useSWR<{ domains: DomainSummary[] }>(
    '/api/search-ai/indexes/kg-taxonomy/domains',
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000, // 60 seconds — domain list changes rarely
    },
  );

  return {
    domains: data?.domains ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

interface UseKGTaxonomyReturn {
  taxonomy: TaxonomyDetail | null;
  isLoading: boolean;
  error: string | null;
  isNotFound: boolean;
  refresh: () => void;
}

/**
 * Fetch current taxonomy for an index
 */
export function useKGTaxonomy(indexId: string | null): UseKGTaxonomyReturn {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/kg-taxonomy` : null;
  const { data, error, isLoading, mutate } = useSWR<TaxonomyDetail>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
    // Don't throw on 404 — it means taxonomy hasn't been set up yet
    shouldRetryOnError: (err: any) => err?.statusCode !== 404,
  });

  return {
    taxonomy: data ?? null,
    isLoading,
    error: error?.statusCode === 404 ? null : (error?.message ?? null),
    isNotFound: error?.statusCode === 404,
    refresh: () => mutate(undefined, { revalidate: true }),
  };
}

interface UseKGSetupJobStatusReturn {
  status: TaxonomySetupJobStatus | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Poll taxonomy setup job status
 * Polls every 2 seconds while status is QUEUED or PROCESSING
 */
export function useKGSetupJobStatus(
  indexId: string | null,
  jobId: string | null,
): UseKGSetupJobStatusReturn {
  const key =
    indexId && jobId
      ? `/api/search-ai/indexes/${indexId}/kg-taxonomy/setup/${encodeURIComponent(jobId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<TaxonomySetupJobStatus>(key, {
    revalidateOnFocus: false,
    refreshInterval: (latestData) => {
      // Poll while job is active, stop when complete or failed
      if (!latestData) return 2000;
      if (latestData.status === 'COMPLETED' || latestData.status === 'FAILED') return 0;
      return 2000;
    },
  });

  return {
    status: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

interface UseGraphStructureReturn {
  graph: GraphStructure | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch graph structure for visualization
 */
export function useGraphStructure(
  indexId: string | null,
  params?: {
    nodeId?: string;
    depth?: number;
    nodeType?: string;
    productId?: string;
    includeEntityInstances?: boolean;
    entityLimit?: number;
    summaryMode?: boolean;
  },
): UseGraphStructureReturn {
  const queryParams = new URLSearchParams();
  if (params?.nodeId) queryParams.set('nodeId', params.nodeId);
  if (params?.depth) queryParams.set('depth', params.depth.toString());
  if (params?.nodeType) queryParams.set('nodeType', params.nodeType);
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.includeEntityInstances !== undefined)
    queryParams.set('includeEntityInstances', params.includeEntityInstances.toString());
  if (params?.entityLimit) queryParams.set('entityLimit', params.entityLimit.toString());
  if (params?.summaryMode !== undefined)
    queryParams.set('summaryMode', params.summaryMode.toString());

  const key = indexId
    ? `/api/search-ai/indexes/${indexId}/kg-enrich/graph?${queryParams.toString()}`
    : null;

  const { data, error, isLoading, mutate } = useSWR<GraphStructure>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 10000, // 10 seconds - graph data changes less frequently
  });

  return {
    graph: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(),
  };
}

// ─── Configuration Hooks ────────────────────────────────────────────────

interface ModelCapabilities {
  score: number;
  reasoning: string;
}

interface AssessedModel {
  id: string;
  displayName: string;
  provider: string | null;
  tier: string;
  capabilities: {
    knowledgeGraph: ModelCapabilities;
  };
}

interface ModelRecommendation {
  modelId: string;
  reason: string;
}

interface ConfiguredIndex {
  indexId: string;
  knowledgeBaseName: string;
  model: {
    id: string;
    displayName: string;
    provider: string;
    tier: string;
  } | null;
  configuredAt: string;
}

export interface KGConfigurationStatus {
  environment: {
    available: boolean;
    reason: string | null;
  };
  autoConfigureModelId: string | null;
  configurationLevel: 'workspace' | 'tenant' | 'none';
  workspace: {
    hasKGConfigured: boolean;
    configuredIndexes: ConfiguredIndex[];
    recommendation?: {
      action: string;
      message: string;
    };
  };
  tenant: {
    models: AssessedModel[];
    recommendation: ModelRecommendation | null;
  } | null;
  requiresConfiguration: boolean;
}

interface UseKGConfigurationStatusReturn {
  status: KGConfigurationStatus | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch KG configuration status with workspace-aware recommendations
 */
export function useKGConfigurationStatus(indexId: string | null): UseKGConfigurationStatusReturn {
  const key = indexId ? `/api/search-ai/indexes/${indexId}/kg-configuration-status` : null;
  const { data, error, isLoading, mutate } = useSWR<KGConfigurationStatus>(key, {
    revalidateOnFocus: false,
    dedupingInterval: 5000,
  });

  return {
    status: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: () => mutate(undefined, { revalidate: true }),
  };
}

interface ConfigureModelParams {
  modelId: string;
  inheritedFrom?: string;
}

interface ConfigureModelResponse {
  success: boolean;
  message: string;
}

interface UseKGConfigureModelReturn {
  configureModel: (params: ConfigureModelParams) => Promise<ConfigureModelResponse>;
  isConfiguring: boolean;
  error: string | null;
}

/**
 * Configure LLM model for Knowledge Graph use case (mutation)
 */
export function useKGConfigureModel(indexId: string | null): UseKGConfigureModelReturn {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configureModel = async (params: ConfigureModelParams): Promise<ConfigureModelResponse> => {
    if (!indexId) {
      throw new Error('Index ID is required');
    }

    setIsConfiguring(true);
    setError(null);

    try {
      const response = await apiFetch(`/api/search-ai/indexes/${indexId}/kg-configure-model`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ error: 'Failed to configure model' }));
        throw new Error(errorData.error || errorData.message || 'Failed to configure model');
      }

      const result = await response.json();
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to configure model';
      setError(errorMessage);
      throw err;
    } finally {
      setIsConfiguring(false);
    }
  };

  return {
    configureModel,
    isConfiguring,
    error,
  };
}
