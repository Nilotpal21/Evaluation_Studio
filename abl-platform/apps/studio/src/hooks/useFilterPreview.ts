/**
 * useFilterPreview Hook
 *
 * SWR hook for filter preview data with 500ms debounce.
 * Uses POST-based SWR fetcher since previewFilters is a POST endpoint.
 */

import { useState, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { previewFilters } from '../api/search-ai';

export interface FilterConfig {
  selectedSiteIds: string[];
  selectedFileTypes: string[];
  dateRange: { modifiedAfter?: string; modifiedBefore?: string };
  filterTemplate: 'documents-only' | 'tech-docs' | 'everything' | 'custom';
  folderRules: { include: string[]; exclude: string[] };
  sizeLimits: { minBytes?: number; maxBytes?: number };
  metadataConditions: Array<{ field: string; operator: string; value: string }>;
  conditionGroups: Array<{
    logic: 'AND' | 'OR';
    conditions: Array<{ field: string; operator: string; value: string }>;
  }>;
  celExpression?: string;
}

export interface FilterPreviewData {
  matchCount: number;
  excludedCount: number;
  estimatedSyncMinutes: number;
  diff: {
    newlyIncluded: number;
    newlyExcluded: number;
    reasons: Array<{ description: string; count: number }>;
  };
  sampleDocuments: Array<{ name: string; type: string; sizeBytes: number }>;
  excludedDocuments: Array<{ name: string; reason: string }>;
  exclusionSummary: Array<{ category: string; count: number }>;
  perRuleImpact: Array<{
    ruleName: string;
    includeCount: number;
    excludeCount: number;
    netCount: number;
  }>;
  generatedODataFilter: string;
  generatedODataSelect: string;
}

const DEBOUNCE_MS = 500;

export interface UseFilterPreviewReturn {
  preview: FilterPreviewData | null;
  isLoading: boolean;
  error: string | null;
}

export function useFilterPreview(
  connectorId: string | null,
  filterConfig: FilterConfig | null,
): UseFilterPreviewReturn {
  // Debounce the filter config serialization
  const [debouncedConfig, setDebouncedConfig] = useState<string | null>(null);

  useEffect(() => {
    if (!filterConfig) {
      setDebouncedConfig(null);
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedConfig(JSON.stringify(filterConfig));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterConfig]);

  const key =
    connectorId && debouncedConfig
      ? [`/api/search-ai/connectors/${connectorId}/filters/preview`, debouncedConfig]
      : null;

  const { data, error, isLoading } = useSWR(
    key,
    () => {
      if (!connectorId || !debouncedConfig) return null;
      const config = JSON.parse(debouncedConfig);
      return previewFilters(connectorId, config);
    },
    { revalidateOnFocus: false },
  );

  const preview = useMemo(() => {
    if (!data) return null;
    // Normalize the response to FilterPreviewData shape
    const raw = (
      typeof data === 'object' && data !== null && 'data' in data
        ? (data as Record<string, unknown>).data
        : data
    ) as FilterPreviewData | null;
    return raw ?? null;
  }, [data]);

  return {
    preview,
    isLoading,
    error: error ? String(error) : null,
  };
}

/** Default empty filter config */
export function createDefaultFilterConfig(): FilterConfig {
  return {
    selectedSiteIds: [],
    selectedFileTypes: [],
    dateRange: {},
    filterTemplate: 'documents-only',
    folderRules: { include: [], exclude: [] },
    sizeLimits: {},
    metadataConditions: [],
    conditionGroups: [],
  };
}
