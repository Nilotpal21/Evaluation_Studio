import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PIPELINE_OBSERVABILITY_CONTRACT } from '@agent-platform/shared';

const useSWRMock = vi.fn();

const runsStoreState = {
  typeFilter: 'all',
  pipelineFilter: null as string | null,
  statusFilter: 'all',
  timeWindow: '24h',
  openRunId: null as string | null,
  openRun: vi.fn(),
  closeRun: vi.fn(),
  setTypeFilter: vi.fn(),
  setPipelineFilter: vi.fn(),
  setStatusFilter: vi.fn(),
  setTimeWindow: vi.fn(),
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('swr', () => ({
  default: (...args: unknown[]) => useSWRMock(...args),
}));

vi.mock('@/store/pipeline-runs-store', () => ({
  useRunsStore: (selector: (state: typeof runsStoreState) => unknown) => selector(runsStoreState),
}));

import { RecentRunsPanel } from '@/components/pipelines/runs/RecentRunsPanel';
import { PipelineDataPanel } from '@/components/pipelines/data/PipelineDataPanel';
import { expandCustomDimensionRows } from '@/components/pipelines/data/ClickHousePreviewTable';

describe('Pipeline observability Studio panels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runsStoreState.openRun.mockReset();
    runsStoreState.closeRun.mockReset();
    runsStoreState.setTypeFilter.mockReset();
    runsStoreState.setPipelineFilter.mockReset();
    runsStoreState.setStatusFilter.mockReset();
    runsStoreState.setTimeWindow.mockReset();
    useSWRMock.mockImplementation((key: string | null) => {
      if (typeof key === 'string' && key.includes('/pipeline-observability/runs/health')) {
        return {
          data: {
            success: true,
            meta: { contract: PIPELINE_OBSERVABILITY_CONTRACT },
            data: {
              total: 8,
              completed: 7,
              failed: 1,
              running: 0,
              cancelled: 0,
              successRate: 87.5,
              avgDurationMs: 1225,
            },
          },
          isLoading: false,
        };
      }

      if (typeof key === 'string' && key.includes('/pipeline-observability/runs?')) {
        return {
          data: {
            meta: { contract: PIPELINE_OBSERVABILITY_CONTRACT },
            data: [],
            pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
          },
          mutate: vi.fn(),
          isLoading: false,
        };
      }

      if (
        typeof key === 'string' &&
        key.includes('/pipeline-observability/data/previewable-pipelines')
      ) {
        return {
          data: {
            success: true,
            meta: { contract: PIPELINE_OBSERVABILITY_CONTRACT },
            data: [
              {
                id: 'builtin:sentiment-analysis',
                name: 'Sentiment Analysis',
                kind: 'builtin',
              },
            ],
          },
          error: null,
          isLoading: false,
        };
      }

      return {
        data: undefined,
        error: null,
        isLoading: false,
        mutate: vi.fn(),
      };
    });
  });

  it('shows the observability scope notice in the runs panel', () => {
    render(<RecentRunsPanel projectId="proj-1" />);

    expect(screen.getByText('scope_notice.title')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.runs_description')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.contract_summary')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.deferred_summary')).toBeInTheDocument();
  });

  it('shows the observability scope notice in the data panel', () => {
    render(<PipelineDataPanel projectId="proj-1" />);

    expect(screen.getByText('scope_notice.title')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.data_description')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.contract_summary')).toBeInTheDocument();
    expect(screen.getByText('scope_notice.deferred_summary')).toBeInTheDocument();
  });

  it('expands quality custom_dimensions into visible output columns', () => {
    const result = expandCustomDimensionRows(
      [
        {
          session_id: 'sess-1',
          overall_score: 1.964,
          helpfulness: 0,
          accuracy: 0,
          custom_dimensions: '{"empathy":4,"resolution_speed":3.5}',
        },
      ],
      ['session_id', 'overall_score', 'helpfulness', 'accuracy', 'custom_dimensions'],
    );

    expect(result.columns).toEqual([
      'session_id',
      'overall_score',
      'helpfulness',
      'accuracy',
      'empathy',
      'resolution_speed',
    ]);
    expect(result.rows[0]).toMatchObject({
      empathy: 4,
      resolution_speed: 3.5,
    });
  });
});
