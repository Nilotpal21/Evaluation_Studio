/**
 * Client-side API functions for user preferences.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import {
  normalizeInsightsAnalyticsFilters,
  type PersistedInsightsAnalyticsFilters,
} from '../lib/preferences/insights-analytics-filters';

export interface PreferencesData {
  pinnedProjectIds: string[];
  insightsAnalyticsFilters: PersistedInsightsAnalyticsFilters;
}

interface PreferencesResponse {
  success: boolean;
  data: PreferencesData;
}

export async function fetchPreferences(): Promise<PreferencesData> {
  const response = await apiFetch('/api/user/preferences', { method: 'GET' });
  const result = await handleResponse<PreferencesResponse>(response);
  return {
    pinnedProjectIds: result.data.pinnedProjectIds,
    insightsAnalyticsFilters: normalizeInsightsAnalyticsFilters(
      result.data.insightsAnalyticsFilters,
    ),
  };
}

export async function updatePreferences(
  updates: Partial<PreferencesData>,
): Promise<PreferencesData> {
  const response = await apiFetch('/api/user/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const result = await handleResponse<PreferencesResponse>(response);
  return {
    pinnedProjectIds: result.data.pinnedProjectIds,
    insightsAnalyticsFilters: normalizeInsightsAnalyticsFilters(
      result.data.insightsAnalyticsFilters,
    ),
  };
}
