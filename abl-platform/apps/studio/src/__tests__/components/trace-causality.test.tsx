import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TraceCausalChips, TraceCausalityLedger } from '../../components/trace/TraceCausality';

describe('TraceCausality UI', () => {
  it('renders compact causal chips for a trace event', () => {
    render(
      <TraceCausalChips
        event={{
          id: 'evt-decision',
          type: 'completion_check',
          data: {
            causal: {
              agentRunId: 'session-1:agent:1',
              causeEventId: 'evt-enter',
              decisionId: 'evt-decision',
              phase: 'decision',
              reasonCode: 'completion_check',
            },
          },
        }}
      />,
    );

    expect(screen.getByText('phase')).toBeInTheDocument();
    expect(screen.getAllByText('decision')).toHaveLength(2);
    expect(screen.getByText('reason')).toBeInTheDocument();
    expect(screen.getByText('completion_check')).toBeInTheDocument();
  });

  it('renders a full causal ledger with developer-facing labels and unresolved-link status', () => {
    render(
      <TraceCausalityLedger
        events={[
          {
            id: 'evt-enter',
            type: 'agent_enter',
            spanId: 'span-enter',
            data: { causal: { agentRunId: 'run-1', phase: 'agent_lifecycle' } },
          },
          {
            id: 'evt-decision',
            type: 'completion_check',
            data: {
              causal: {
                agentRunId: 'run-1',
                causeEventId: 'span-enter',
                decisionId: 'evt-decision',
                phase: 'decision',
                reasonCode: 'completion_check',
              },
            },
          },
          {
            id: 'evt-tool',
            type: 'tool_call',
            data: { causal: { causeEventId: 'evt-missing', phase: 'tool' } },
          },
        ]}
      />,
    );

    expect(screen.getByText('Execution links')).toBeInTheDocument();
    expect(screen.getByText('3 linked events')).toBeInTheDocument();
    expect(screen.getByText('1 unresolved link')).toBeInTheDocument();
    expect(screen.getAllByText('Agent run').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cause').length).toBeGreaterThan(0);
    expect(screen.getByText('Link health')).toBeInTheDocument();
    expect(screen.getByText('Link quality')).toBeInTheDocument();
    expect(screen.getAllByText('Agent entered').length).toBeGreaterThan(0);
    expect(screen.getAllByText('agent_enter evt-ente...').length).toBeGreaterThan(0);
    expect(screen.getByText('Linked event not loaded')).toBeInTheDocument();
    expect(screen.getByText('completion check')).toBeInTheDocument();
  });
});
