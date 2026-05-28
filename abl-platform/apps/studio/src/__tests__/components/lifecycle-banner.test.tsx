import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LifecycleBannerComponent } from '../../components/observatory/interactions/LifecycleBanner';
import type { LifecycleBanner } from '../../components/observatory/interactions/types';

function makeBanner(overrides?: Partial<LifecycleBanner>): LifecycleBanner {
  return {
    id: 'banner-enter',
    timestamp: new Date('2026-03-31T10:00:00Z'),
    kind: 'agent_enter',
    agentName: 'AppointmentRouter',
    event: {
      id: 'evt-enter',
      type: 'agent_enter',
      timestamp: new Date('2026-03-31T10:00:00Z'),
      traceId: 'trace-1',
      spanId: 'span-enter',
      sessionId: 'sess-1',
      agentName: 'AppointmentRouter',
      data: {
        agentName: 'AppointmentRouter',
        trigger: 'user_message',
        reasonCode: 'agent_enter_user_message',
      },
    },
    reason: 'Started after user input',
    trigger: 'user_message',
    reasonCode: 'agent_enter_user_message',
    phase: 'agent_lifecycle',
    agentRunId: 'run-1',
    causeEventId: 'evt-user',
    causeLabel: 'user_message evt-user',
    ...overrides,
  };
}

describe('LifecycleBannerComponent', () => {
  it('shows the lifecycle reason in the collapsed row', () => {
    render(<LifecycleBannerComponent banner={makeBanner()} />);

    expect(screen.getByText('Agent Entered — AppointmentRouter')).toBeInTheDocument();
    expect(screen.getByText('Reason: Started after user input')).toHaveClass('text-[9px]');
    expect(screen.getByRole('button', { name: 'Open details' })).toBeInTheDocument();
    expect(screen.queryByText('agent_enter_user_message')).not.toBeInTheDocument();
    expect(screen.queryByText(/cause=/)).not.toBeInTheDocument();
  });

  it('expands to structured lifecycle details and raw event data', () => {
    render(<LifecycleBannerComponent banner={makeBanner()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));

    expect(screen.getByText('trigger')).toBeInTheDocument();
    expect(screen.getByText('user_message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close details' })).toBeInTheDocument();
    expect(screen.queryByText('agent run')).not.toBeInTheDocument();
    expect(screen.queryByText('cause id')).not.toBeInTheDocument();
    expect(screen.getByText('Triggered by: user_message evt-user')).toBeInTheDocument();
    expect(screen.getByText(/"reasonCode": "agent_enter_user_message"/)).toBeInTheDocument();
  });

  it('renders thread returns as subtle child to parent rows', () => {
    render(
      <LifecycleBannerComponent
        banner={makeBanner({
          id: 'banner-return',
          kind: 'thread_return',
          agentName: 'SkymateRouter',
          parentAgent: 'FlightInfoSpecialist',
          targetAgent: 'SkymateRouter',
          reason: 'FlightInfoSpecialist returned control to SkymateRouter',
          event: {
            id: 'evt-return',
            type: 'thread_return',
            timestamp: new Date('2026-03-31T10:00:01Z'),
            traceId: 'trace-1',
            spanId: 'span-return',
            sessionId: 'sess-1',
            agentName: 'SkymateRouter',
            data: {
              from: 'FlightInfoSpecialist',
              to: 'SkymateRouter',
            },
          },
        })}
      />,
    );

    expect(
      screen.getByText('Thread Returned — FlightInfoSpecialist → SkymateRouter'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Reason: FlightInfoSpecialist returned control to SkymateRouter'),
    ).toHaveClass('text-[9px]');
    expect(screen.getByRole('button', { name: 'Open details' })).toBeInTheDocument();
  });

  it('renders all lifecycle banner kinds emitted by the trace processor', () => {
    const cases: Array<{ kind: LifecycleBanner['kind']; expectedText: string }> = [
      { kind: 'handoff_return_handler', expectedText: 'Handoff Return Handler — SkymateRouter' },
      { kind: 'resume_intent', expectedText: 'Resume Intent — AppointmentRouter' },
      { kind: 'thread_resume', expectedText: 'Thread Resumed — AppointmentRouter' },
      { kind: 'return_to_parent', expectedText: 'Return to Parent — ParentAgent → ChildAgent' },
    ];

    for (const { kind, expectedText } of cases) {
      const { unmount } = render(
        <LifecycleBannerComponent
          banner={makeBanner({
            id: `banner-${kind}`,
            kind,
            targetAgent:
              kind === 'handoff_return_handler'
                ? 'SkymateRouter'
                : kind === 'return_to_parent'
                  ? 'ChildAgent'
                  : undefined,
            parentAgent: kind === 'return_to_parent' ? 'ParentAgent' : undefined,
            reason: 'Lifecycle transition recorded',
            event: {
              id: `evt-${kind}`,
              type: kind,
              timestamp: new Date('2026-03-31T10:00:01Z'),
              traceId: 'trace-1',
              spanId: `span-${kind}`,
              sessionId: 'sess-1',
              agentName: 'AppointmentRouter',
              data: {},
            },
          })}
        />,
      );

      expect(screen.getByText(expectedText)).toBeInTheDocument();
      unmount();
    }
  });
});
