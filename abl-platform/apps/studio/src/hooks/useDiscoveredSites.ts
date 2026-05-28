/**
 * useDiscoveredSites Hook
 *
 * SWR hook for fetching and managing discovered SharePoint sites.
 * Supports pagination and search filtering.
 */

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import {
  getDiscoveredSites,
  getSelectedSites,
  selectSites,
  type DiscoveredSite,
} from '../api/connector-extensions';

// =============================================================================
// TYPES
// =============================================================================

interface UseDiscoveredSitesOptions {
  search?: string;
  page?: number;
  limit?: number;
}

interface UseDiscoveredSitesResult {
  sites: DiscoveredSite[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => Promise<void>;
}

interface UseSelectedSitesResult {
  mode: 'all' | 'selected' | 'excluded';
  siteIds: string[];
  selectedCount: number;
  isLoading: boolean;
  error: string | null;
  mutate: () => Promise<void>;
  updateSelection: (siteIds: string[], mode?: 'selected' | 'excluded') => Promise<void>;
}

// =============================================================================
// HOOKS
// =============================================================================

/**
 * Fetch discovered sites with pagination and search
 */
export function useDiscoveredSites(
  connectorId: string,
  options?: UseDiscoveredSitesOptions,
): UseDiscoveredSitesResult {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const key =
    isAuthenticated && connectorId
      ? ['discovered-sites', connectorId, options?.search, options?.page, options?.limit]
      : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    async () => {
      const response = await getDiscoveredSites(connectorId, options);
      return response.data;
    },
    {
      refreshInterval: 0, // Don't auto-refresh (discovery results are static)
      keepPreviousData: true,
    },
  );

  return {
    sites: data?.sites ?? [],
    pagination: data?.pagination ?? null,
    isLoading,
    error: error ? String(error) : null,
    mutate: async () => {
      await mutate();
    },
  };
}

/**
 * Fetch and manage selected sites configuration
 */
export function useSelectedSites(connectorId: string): UseSelectedSitesResult {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [updating, setUpdating] = useState(false);

  const key = isAuthenticated && connectorId ? ['selected-sites', connectorId] : null;

  const { data, error, isLoading, mutate } = useSWR(
    key,
    async () => {
      const response = await getSelectedSites(connectorId);
      return response.data;
    },
    {
      refreshInterval: 0,
      keepPreviousData: true,
    },
  );

  const updateSelection = useCallback(
    async (siteIds: string[], mode: 'selected' | 'excluded' = 'selected') => {
      setUpdating(true);
      try {
        await selectSites(connectorId, siteIds, mode);
        await mutate();
      } finally {
        setUpdating(false);
      }
    },
    [connectorId, mutate],
  );

  return {
    mode: data?.mode ?? 'all',
    siteIds: data?.siteIds ?? [],
    selectedCount: data?.selectedCount ?? 0,
    isLoading: isLoading || updating,
    error: error ? String(error) : null,
    mutate: async () => {
      await mutate();
    },
    updateSelection,
  };
}
