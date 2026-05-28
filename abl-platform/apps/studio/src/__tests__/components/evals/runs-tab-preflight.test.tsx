import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { refreshMock, projectStoreState, evalsStoreState, mockUseEvalRuns } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  projectStoreState: {
    currentProject: {
      id: 'proj-1',
      name: 'Project One',
    },
  },
  evalsStoreState: {
    activeTab: 'runs',
    setActiveTab: vi.fn(),
    selectedRunId: null as string | null,
    setSelectedRunId: vi.fn(),
    selectedCell: null as { personaId: string; scenarioId: string } | null,
    setSelectedCell: vi.fn(),
    compareBaselineId: null as string | null,
    compareCurrentId: null as string | null,
    setCompare: vi.fn(),
  },
  mockUseEvalRuns: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/store/project-store', () => ({
  useProjectStore: <T,>(selector: (state: typeof projectStoreState) => T): T =>
    selector(projectStoreState),
}));

vi.mock('@/store/evals-store', () => ({
  useEvalsStore: Object.assign(
    <T,>(selector: (state: typeof evalsStoreState) => T): T => selector(evalsStoreState),
    {
      getState: () => evalsStoreState,
    },
  ),
}));

vi.mock('@/hooks/useEvalData', () => ({
  useEvalRuns: (...args: unknown[]) => mockUseEvalRuns(...args),
  useEvalSets: () => ({ sets: [], isLoading: false, error: null, refresh: refreshMock }),
  useEvalHeatMap: () => ({ cells: [], isLoading: false }),
  useEvalRunStatus: () => ({ status: null, startedAt: null, completedAt: null }),
  useEvalPersonas: () => ({ personas: [], isLoading: false, error: null, refresh: refreshMock }),
  useEvalScenarios: () => ({
    scenarios: [],
    isLoading: false,
    error: null,
    refresh: refreshMock,
  }),
  useEvalEvaluators: () => ({
    evaluators: [],
    isLoading: false,
    error: null,
    refresh: refreshMock,
  }),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../components/evals/shared/QuickEvalButton', () => ({
  QuickEvalButton: () => <button type="button">Quick Eval</button>,
}));

vi.mock('../../../../components/evals/dialogs/StartRunDialog', () => ({
  StartRunDialog: () => null,
}));

vi.mock('../../../../components/evals/heatmap/HeatMap', () => ({
  HeatMap: () => <div>HeatMap</div>,
}));

vi.mock('../../../../components/evals/heatmap/ScoreDetail', () => ({
  ScoreDetail: () => null,
}));

vi.mock('../../../../components/evals/comparison/RunComparison', () => ({
  RunComparison: () => <div>RunComparison</div>,
}));

vi.mock('../../../../components/evals/comparison/ScoreTrend', () => ({
  ScoreTrend: () => <div>ScoreTrend</div>,
}));

vi.mock('../../../../components/evals/shared/StatisticalSummary', () => ({
  StatisticalSummary: () => <div>StatisticalSummary</div>,
}));

vi.mock('../../../../components/evals/shared/EvalBadge', () => ({
  EvalBadge: ({ score }: { score: number }) => <span>{score}</span>,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { RunsTab } from '@/components/evals/tabs/RunsTab';

describe('RunsTab preflight visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evalsStoreState.selectedRunId = null;
    evalsStoreState.selectedCell = null;
    evalsStoreState.compareBaselineId = null;
    evalsStoreState.compareCurrentId = null;
  });

  it('shows the preflight panel when there are no runs yet', () => {
    mockUseEvalRuns.mockReturnValue({
      runs: [],
      isLoading: false,
      refresh: refreshMock,
    });

    render(<RunsTab />);

    expect(screen.getByText('Pipeline Health')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Configuration' })).toBeInTheDocument();
  });

  it('shows the preflight panel alongside existing runs', () => {
    mockUseEvalRuns.mockReturnValue({
      runs: [
        {
          id: 'run-1',
          name: 'Baseline Run',
          status: 'pending',
          triggerSource: 'manual',
          createdAt: '2026-04-02T00:00:00.000Z',
        },
      ],
      isLoading: false,
      refresh: refreshMock,
    });

    render(<RunsTab />);

    expect(screen.getByText('Pipeline Health')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Configuration' })).toBeInTheDocument();
  });
});
