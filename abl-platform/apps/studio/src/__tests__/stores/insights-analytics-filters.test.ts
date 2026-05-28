import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANALYTICS_PAGE_FILTERS,
  DEFAULT_ANALYTICS_SESSIONS_FILTERS,
  DEFAULT_ANALYTICS_TRACES_FILTERS,
  DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
  getSurfaceState,
  normalizeInsightsAnalyticsFilters,
  resetSurfaceState,
  setSurfaceState,
  type PersistedInsightsAnalyticsFilters,
  type PersistedFilterRow,
} from '../../lib/preferences/insights-analytics-filters';

function createFilterRow(overrides?: Partial<PersistedFilterRow>): PersistedFilterRow {
  return {
    id: 'row-1',
    columnKey: 'eventType',
    operator: 'eq',
    value: 'error',
    ...overrides,
  };
}

describe('insights analytics filter helpers', () => {
  it('normalizes invalid values and strips unknown surfaces', () => {
    const normalized = normalizeInsightsAnalyticsFilters({
      version: 1,
      byProject: {
        'project-a': {
          analyticsPage: {
            dateRangeMode: 'bogus',
            quickRange: '7d',
            customFrom: '2026-04-01T00:00',
            customTo: '2026-04-02T00:00',
            activeTab: 'sessions-explorer',
          },
          analyticsTraces: {
            activeSubTab: 'generations',
            typeFilter: 'bogus',
            searchQuery: 'Billing',
            filterRows: [createFilterRow(), { id: 'bad', columnKey: '', operator: 'nope' }],
          },
          unknownSurface: {
            should: 'be removed',
          },
        },
        'project-b': 'invalid project payload',
      },
    });

    expect(normalized.byProject['project-a']).toEqual({
      analyticsPage: {
        dateRangeMode: DEFAULT_ANALYTICS_PAGE_FILTERS.dateRangeMode,
        quickRange: '7d',
        customFrom: '2026-04-01T00:00',
        customTo: '2026-04-02T00:00',
        activeTab: 'sessions-explorer',
      },
      analyticsTraces: {
        activeSubTab: 'generations',
        typeFilter: DEFAULT_ANALYTICS_TRACES_FILTERS.typeFilter,
        searchQuery: 'Billing',
        filterRows: DEFAULT_ANALYTICS_TRACES_FILTERS.filterRows,
      },
    });
    expect(normalized.byProject['project-b']).toBeUndefined();
  });

  it('keeps surfaces partitioned by project and removes surfaces that return to defaults', () => {
    let filters: PersistedInsightsAnalyticsFilters = DEFAULT_INSIGHTS_ANALYTICS_FILTERS;

    filters = setSurfaceState(filters, 'project-a', 'analyticsSessions', {
      ...DEFAULT_ANALYTICS_SESSIONS_FILTERS,
      search: 'voice',
    });
    filters = setSurfaceState(filters, 'project-b', 'analyticsSessions', {
      ...DEFAULT_ANALYTICS_SESSIONS_FILTERS,
      statusFilter: 'active',
    });

    expect(getSurfaceState(filters, 'project-a', 'analyticsSessions')).toMatchObject({
      search: 'voice',
      statusFilter: DEFAULT_ANALYTICS_SESSIONS_FILTERS.statusFilter,
    });
    expect(getSurfaceState(filters, 'project-b', 'analyticsSessions')).toMatchObject({
      search: DEFAULT_ANALYTICS_SESSIONS_FILTERS.search,
      statusFilter: 'active',
    });

    filters = setSurfaceState(
      filters,
      'project-a',
      'analyticsSessions',
      DEFAULT_ANALYTICS_SESSIONS_FILTERS,
    );

    expect(filters.byProject['project-a']).toBeUndefined();
    expect(filters.byProject['project-b']).toBeDefined();
    expect(getSurfaceState(filters, 'project-b', 'analyticsSessions')).toMatchObject({
      statusFilter: 'active',
    });
  });

  it('resets traces filters without navigating away from the current sub-tab', () => {
    const filters = setSurfaceState(
      DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
      'project-a',
      'analyticsTraces',
      {
        activeSubTab: 'generations',
        typeFilter: 'error',
        searchQuery: 'billing',
        filterRows: [createFilterRow()],
      },
    );

    const resetFilters = resetSurfaceState(filters, 'project-a', 'analyticsTraces');

    expect(getSurfaceState(resetFilters, 'project-a', 'analyticsTraces')).toEqual({
      ...DEFAULT_ANALYTICS_TRACES_FILTERS,
      activeSubTab: 'generations',
    });
  });

  it('resets analytics shell date controls while preserving the current top-level tab', () => {
    const filters = setSurfaceState(
      DEFAULT_INSIGHTS_ANALYTICS_FILTERS,
      'project-a',
      'analyticsPage',
      {
        dateRangeMode: 'custom',
        quickRange: '7d',
        customFrom: '2026-04-01T00:00',
        customTo: '2026-04-02T00:00',
        activeTab: 'traces-explorer',
      },
    );

    const resetFilters = resetSurfaceState(filters, 'project-a', 'analyticsPage');

    expect(getSurfaceState(resetFilters, 'project-a', 'analyticsPage')).toEqual({
      ...DEFAULT_ANALYTICS_PAGE_FILTERS,
      activeTab: 'traces-explorer',
    });
  });
});
