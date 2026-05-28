/**
 * useAlerts Hooks
 *
 * SWR hooks for alert configuration API endpoints.
 * Fetches from Studio proxy at /api/admin/alerts which forwards to runtime.
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface AlertConfig {
  _id: string;
  tenantId: string;
  type: 'usage_threshold' | 'credit_low' | 'health_degraded' | 'feature_limit';
  threshold: number;
  channel: 'webhook' | 'email';
  target: string;
  enabled: boolean;
  cooldownMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAlertInput {
  type: 'usage_threshold' | 'credit_low' | 'health_degraded' | 'feature_limit';
  threshold: number;
  channel: 'webhook' | 'email';
  target: string;
  enabled: boolean;
  cooldownMinutes: number;
}

interface AlertsResponse {
  success: boolean;
  configs: AlertConfig[];
}

// =============================================================================
// HELPERS
// =============================================================================

function buildAlertsUrl(tenantId: string | null): string | null {
  if (!tenantId) return null;
  return `/api/admin/alerts?tenantId=${encodeURIComponent(tenantId)}`;
}

const SWR_OPTIONS = {
  refreshInterval: 60_000,
  keepPreviousData: true,
};

// =============================================================================
// HOOKS
// =============================================================================

export function useAlertConfigs() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key = isAuthenticated ? buildAlertsUrl(tenantId) : null;

  const { data, error, isLoading, mutate } = useSWR<AlertsResponse>(key, SWR_OPTIONS);

  const createAlert = useCallback(
    async (input: CreateAlertInput): Promise<boolean> => {
      if (!tenantId) return false;
      try {
        const url = `/api/admin/alerts?tenantId=${encodeURIComponent(tenantId)}`;
        const response = await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (result.success) {
          await mutate();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [tenantId, mutate],
  );

  const updateAlert = useCallback(
    async (id: string, updates: Partial<CreateAlertInput>): Promise<boolean> => {
      if (!tenantId) return false;
      try {
        const url = `/api/admin/alerts/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`;
        const response = await apiFetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (result.success) {
          await mutate();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [tenantId, mutate],
  );

  const deleteAlert = useCallback(
    async (id: string): Promise<boolean> => {
      if (!tenantId) return false;
      try {
        const url = `/api/admin/alerts/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`;
        const response = await apiFetch(url, {
          method: 'DELETE',
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (result.success) {
          await mutate();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [tenantId, mutate],
  );

  return {
    configs: data?.configs ?? [],
    loading: isLoading,
    error,
    createAlert,
    updateAlert,
    deleteAlert,
  };
}
