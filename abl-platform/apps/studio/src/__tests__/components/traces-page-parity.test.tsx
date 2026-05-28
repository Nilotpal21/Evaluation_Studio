import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TraceExplorerFilters } from '../../hooks/useTraceExplorer';
import type { TraceExplorerRow } from '../../types';

const { mockNavigate, mockUseTraceExplorer } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseTraceExplorer: vi.fn(),
}));

vi.mock('../../store/navigation-store', () => ({
  useNavigationStore: () => ({
    projectId: 'project-1',
    navigate: mockNavigate,
  }),
}));

vi.mock('../../hooks/useTraceExplorer', () => ({
  useTraceExplorer: (...args: unknown[]) => mockUseTraceExplorer(...args),
}));

vi.mock('../../components/ui/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  ),
}));

import { TracesPage } from '../../components/traces/TracesPage';

const traceRow: TraceExplorerRow = {
  traceId: 'trace-1',
  spanId: 'span-llm-1234567890',
  sessionId: 'session-1234567890',
  agentName: 'CignaRouter',
  environment: 'production',
  channel: 'web_chat',
  type: 'llm_call',
  status: 'ok',
  startedAt: '2026-05-12T16:00:00.000Z',
  durationMs: 842,
  inputTokens: 128,
  outputTokens: 32,
  totalTokens: 160,
  estimatedCost: 0.004322,
  eventCount: 3,
  errorCount: 0,
  warningCount: 1,
  warnings: [
    {
      code: 'REASONING_FALLBACK',
      severity: 'warning',
      message:
        "Rule didn't match; LLM made this routing decision. This usually means the WHEN condition is broken or under-specified. See validation diagnostics.",
    },
    {
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      severity: 'warning',
      message:
        'OpenAI Responses rejected a function call because its required reasoning item was missing from replayed history. Verify previous_response_id or reasoning-item preservation.',
    },
  ],
  operatorDiagnostics: [
    {
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      customerMessage: "I'm having trouble completing that request. Please try again.",
      operatorHint:
        'OpenAI Responses rejected a function_call item because its required reasoning item was missing from replayed history.',
      traceId: 'trace-1',
      severity: 'error',
      category: 'llm',
      agentName: 'CignaRouter',
      toolName: null,
      recommendedAction:
        'Verify Responses history uses previous_response_id or preserves reasoning items adjacent to function_call items.',
    },
  ],
  preview: 'llm.call.completed, llm.call.started',
};

describe('TracesPage parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTraceExplorer.mockReturnValue({
      traces: [traceRow],
      total: 1,
      isLoading: false,
      error: null,
    });
  });

  test('renders trace explorer span rows and deep-links to the selected session span', () => {
    render(<TracesPage />);

    expect(screen.getAllByText('1 spans').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('span-llm-123')).toBeInTheDocument();
    expect(screen.getByText('session-1234')).toBeInTheDocument();
    expect(screen.getByText('CignaRouter')).toBeInTheDocument();
    expect(screen.getAllByText('production').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('842ms')).toBeInTheDocument();
    expect(screen.getByText('160')).toBeInTheDocument();
    expect(screen.getByText('$0.0043')).toBeInTheDocument();
    expect(screen.getByText('Reasoning fallback')).toBeInTheDocument();
    expect(screen.getByTestId('trace-reasoning-fallback-warning')).toBeInTheDocument();
    expect(
      screen.getByTitle(
        "Rule didn't match; LLM made this routing decision. This usually means the WHEN condition is broken or under-specified. See validation diagnostics.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Model diagnostic')).toBeInTheDocument();
    expect(screen.getByTestId('trace-llm-operator-diagnostic-warning')).toBeInTheDocument();
    expect(screen.getByTestId('trace-runtime-error-envelope')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_RESPONSES_REASONING_ITEM_MISSING')).toBeInTheDocument();
    expect(
      screen.getByTitle(/Verify Responses history uses previous_response_id/),
    ).toBeInTheDocument();
    expect(screen.getByText('llm.call.completed, llm.call.started')).toBeInTheDocument();

    fireEvent.click(screen.getByText('span-llm-123'));

    expect(mockNavigate).toHaveBeenCalledWith(
      '/projects/project-1/sessions/session-1234567890/traces/span-llm-1234567890',
    );
  });

  test('passes filters to the Studio trace explorer hook', () => {
    render(<TracesPage />);

    fireEvent.change(screen.getByPlaceholderText('Search trace, span, session'), {
      target: { value: 'span-llm' },
    });
    fireEvent.click(screen.getByLabelText('Agent: CignaRouter'));
    fireEvent.click(screen.getByLabelText('Environment: production'));
    fireEvent.click(screen.getByLabelText('Type: LLM calls'));
    fireEvent.click(screen.getByLabelText('Status: Errors'));

    const latestCall = mockUseTraceExplorer.mock.calls.at(-1) as
      | [string, TraceExplorerFilters]
      | undefined;
    expect(latestCall).toBeDefined();
    expect(latestCall?.[0]).toBe('project-1');
    expect(latestCall?.[1]).toMatchObject({
      q: 'span-llm',
      agentName: ['CignaRouter'],
      environment: ['production'],
      type: ['llm_call'],
      status: ['error'],
      range: '7d',
      sortBy: 'startedAt',
      sortDir: 'desc',
      limit: 50,
      offset: 0,
    });
  });
});
