/**
 * useNotificationConfig Hook
 *
 * SWR hook for connector notification preferences with optimistic updates.
 */

import { useMemo, useCallback } from 'react';
import useSWR from 'swr';
import { apiFetch, handleResponse } from '../lib/api-client';

export interface NotificationConfigData {
  emailAlertsEnabled: boolean;
  emailEvents: string[];
  webhookUrl: string | null;
  webhookEvents: string[];
}

interface NotificationConfigResponse {
  success: boolean;
  data: NotificationConfigData;
}

function engineUrl(path: string): string {
  return `/api/search-ai${path}`;
}

export interface UseNotificationConfigReturn {
  config: NotificationConfigData | null;
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
  updateConfig: (updates: Partial<NotificationConfigData>) => Promise<void>;
  testWebhook: () => Promise<{ success: boolean; error?: string }>;
}

export function useNotificationConfig(
  indexId: string | null,
  connectorId: string | null,
): UseNotificationConfigReturn {
  const key =
    indexId && connectorId
      ? `/api/search-ai/indexes/${indexId}/connectors/${connectorId}/notifications`
      : null;

  const { data, error, isLoading, mutate } = useSWR<NotificationConfigResponse>(key);

  const config = useMemo(() => data?.data ?? null, [data]);

  const updateConfig = useCallback(
    async (updates: Partial<NotificationConfigData>) => {
      if (!indexId || !connectorId) return;

      // Optimistic update
      const optimisticData: NotificationConfigResponse = {
        success: true,
        data: {
          ...(config ?? {
            emailAlertsEnabled: false,
            emailEvents: [],
            webhookUrl: null,
            webhookEvents: [],
          }),
          ...updates,
        },
      };
      await mutate(optimisticData, { revalidate: false });

      try {
        const url = engineUrl(`/indexes/${indexId}/connectors/${connectorId}/notifications`);
        const response = await apiFetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        await handleResponse(response);
        await mutate();
      } catch {
        // Rollback to server state
        await mutate();
      }
    },
    [indexId, connectorId, config, mutate],
  );

  const testWebhook = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!indexId || !connectorId) return { success: false, error: 'Missing IDs' };

    try {
      const url = engineUrl(
        `/indexes/${indexId}/connectors/${connectorId}/notifications/test-webhook`,
      );
      const response = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: config?.webhookUrl }),
      });
      const result = await handleResponse<{ success: boolean }>(response);
      return { success: result.success };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [indexId, connectorId, config?.webhookUrl]);

  return {
    config,
    isLoading,
    error: error ? String(error) : null,
    mutate: () => mutate(),
    updateConfig,
    testWebhook,
  };
}
