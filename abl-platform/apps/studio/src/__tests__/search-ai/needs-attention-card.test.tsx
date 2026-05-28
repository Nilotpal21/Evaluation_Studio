/**
 * @vitest-environment happy-dom
 *
 * Unit tests for NeedsAttentionCard checker functions.
 * Tests are written against rendered output since the checkers are module-private.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HealthSummaryResponse } from '../../api/search-ai';

// ---------------------------------------------------------------------------
// Mock lucide-react — explicit factory (global Proxy mock hangs under forks)
// Icons used by NeedsAttentionCard: AlertCircle, AlertTriangle, CheckCircle2,
// Info, Loader2
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const icon = (name: string) => {
    const Cmp = (props: Record<string, unknown>) => (
      <svg data-testid={`icon-${name}`} {...props}>
        <title>{name}</title>
      </svg>
    );
    Cmp.displayName = name;
    return Cmp;
  };
  return {
    AlertCircle: icon('AlertCircle'),
    AlertTriangle: icon('AlertTriangle'),
    CheckCircle2: icon('CheckCircle2'),
    Info: icon('Info'),
    Loader2: icon('Loader2'),
  };
});

// ---------------------------------------------------------------------------
// Mock SWR — configurable per test
// ---------------------------------------------------------------------------

const mockMutate = vi.fn();
let mockSwrReturn: Record<string, unknown> = {
  data: undefined,
  error: undefined,
  isLoading: false,
  mutate: mockMutate,
};

vi.mock('swr', () => ({
  default: vi.fn(() => mockSwrReturn),
}));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------

vi.mock('../../api/search-ai', () => ({
  fetchHealthSummary: vi.fn().mockResolvedValue({}),
  renameSource: vi.fn(),
  updateCitationConfig: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

const mockSetTab = vi.fn();
const mockSetTabAndSubSection = vi.fn();
const mockSetPendingFilter = vi.fn();

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setTab: mockSetTab,
      setTabAndSubSection: mockSetTabAndSubSection,
    }),
}));

vi.mock('../../store/data-tab-filter-store', () => ({
  useDataTabFilterStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setPendingFilter: mockSetPendingFilter,
    }),
}));

// ---------------------------------------------------------------------------
// Import component under test (after all mocks)
// ---------------------------------------------------------------------------

import { NeedsAttentionCard } from '../../components/search-ai/home/NeedsAttentionCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-healthy HealthSummaryResponse. */
function healthyData(): HealthSummaryResponse {
  return {
    sources: { total: 3, syncing: 0, errors: [] },
    pipeline: { status: 'valid', errors: [] },
    circuitBreaker: null,
    documents: { total: 100, errored: 0, processing: 0 },
    llm: { configured: true },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeedsAttentionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSwrReturn = {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    };
  });

  it('shows a loading spinner while data is loading', () => {
    mockSwrReturn = { data: undefined, error: undefined, isLoading: true, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);
    expect(screen.getByTestId('icon-Loader2')).toBeInTheDocument();
    // The "Checking health..." text comes from the i18n key health_loading
    expect(screen.getByText('Checking health...')).toBeInTheDocument();
  });

  it('shows a checkmark when all health checks are clean', () => {
    mockSwrReturn = { data: healthyData(), error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);
    expect(screen.getByTestId('icon-CheckCircle2')).toBeInTheDocument();
    // The "all healthy" message from i18n
    expect(
      screen.getByText('All systems healthy. Your knowledge base is running smoothly.'),
    ).toBeInTheDocument();
  });

  it('shows source syncing as severity info (not warning) — regression guard for #9', () => {
    const data = healthyData();
    data.sources.syncing = 2;
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // The Info icon should be present (severity: info), NOT AlertTriangle (severity: warning)
    expect(screen.getByTestId('icon-Info')).toBeInTheDocument();
    expect(screen.queryByTestId('icon-AlertTriangle')).not.toBeInTheDocument();

    // ICU plural: "2 sources syncing"
    expect(screen.getByText('2 sources syncing')).toBeInTheDocument();
  });

  it('shows circuit breaker HALF_OPEN as warning with correct key — regression guard for #78', () => {
    const data = healthyData();
    data.circuitBreaker = { state: 'HALF_OPEN', failureRate: 0.3, provider: 'openai' };
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Should use AlertTriangle (warning), not AlertCircle (error)
    expect(screen.getByTestId('icon-AlertTriangle')).toBeInTheDocument();
    expect(screen.queryByTestId('icon-AlertCircle')).not.toBeInTheDocument();

    // The i18n key is circuit_breaker_half_open, rendered as:
    // "LLM circuit breaker is recovering (openai)"
    expect(screen.getByText('LLM circuit breaker is recovering (openai)')).toBeInTheDocument();
  });

  it('shows circuit breaker OPEN as error severity', () => {
    const data = healthyData();
    data.circuitBreaker = { state: 'OPEN', failureRate: 0.8, provider: 'azure' };
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Should use AlertCircle (error severity)
    expect(screen.getByTestId('icon-AlertCircle')).toBeInTheDocument();

    // "LLM circuit breaker is open (azure)"
    expect(screen.getByText('LLM circuit breaker is open (azure)')).toBeInTheDocument();
  });

  it('renders multiple issues in correct order (source error + pipeline invalid)', () => {
    const data = healthyData();
    // Source with errors
    data.sources.errors = [
      { sourceId: 's1', sourceName: 'Confluence', error: 'Auth expired', lastSyncAt: null },
    ];
    // Invalid pipeline
    data.pipeline = {
      status: 'invalid',
      errors: [{ code: 'E01', message: 'Missing embedding stage', severity: 'error', path: '/' }],
    };
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Both should show error icons (AlertCircle). Source issues come first, then pipeline.
    const errorIcons = screen.getAllByTestId('icon-AlertCircle');
    expect(errorIcons).toHaveLength(2);

    // Source error: "1 source with sync errors"
    expect(screen.getByText('1 source with sync errors')).toBeInTheDocument();
    // Source detail shows the source name
    expect(screen.getByText('Confluence')).toBeInTheDocument();

    // Pipeline error: "Pipeline has 1 validation error"
    expect(screen.getByText('Pipeline has 1 validation error')).toBeInTheDocument();
    // Pipeline detail shows error message
    expect(screen.getByText('Missing embedding stage')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // LLM Health Checker
  // ---------------------------------------------------------------------------

  it('shows LLM warning when llm.configured is false', () => {
    const data: HealthSummaryResponse = {
      ...healthyData(),
      llm: { configured: false },
    };
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Should show AlertTriangle (warning severity) for LLM not configured
    expect(screen.getByTestId('icon-AlertTriangle')).toBeInTheDocument();
    expect(screen.getByText('LLM models not configured')).toBeInTheDocument();
  });

  it('shows no LLM warning when llm.configured is true', () => {
    const data: HealthSummaryResponse = {
      ...healthyData(),
      llm: { configured: true },
    };
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Should show all-healthy state (CheckCircle2)
    expect(screen.getByTestId('icon-CheckCircle2')).toBeInTheDocument();
    expect(screen.queryByText('LLM models not configured')).not.toBeInTheDocument();
  });

  it('does not crash when llm field is missing (optional chaining)', () => {
    // Simulate older backend that doesn't include llm field
    const { llm: _omit, ...dataWithoutLlm } = healthyData();
    const data = dataWithoutLlm as unknown as HealthSummaryResponse;
    mockSwrReturn = { data, error: undefined, isLoading: false, mutate: mockMutate };
    render(<NeedsAttentionCard kbId="kb-1" />);

    // Should render without crashing — shows all-healthy
    expect(screen.getByTestId('icon-CheckCircle2')).toBeInTheDocument();
    expect(screen.queryByText('LLM models not configured')).not.toBeInTheDocument();
  });
});
