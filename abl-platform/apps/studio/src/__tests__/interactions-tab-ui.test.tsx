/**
 * @vitest-environment happy-dom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionsTab } from '../components/observatory/interactions/InteractionsTab';
import {
  createAgentResponseEvent,
  createLLMCallEvent,
  createUserMessageEvent,
} from './fixtures/trace-events';
import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';

const scrollIntoViewMock = vi.fn();

function createInteraction(
  baseTimestamp: string,
  content: string,
  response: string,
  agentName = 'Banking_Supervisor',
) {
  const base = new Date(baseTimestamp);

  return [
    createUserMessageEvent(content, {
      sessionId: 'session-ui-test',
      agentName,
      timestamp: base,
    }),
    createLLMCallEvent({
      inputTokens: 120,
      outputTokens: 26,
      overrides: {
        sessionId: 'session-ui-test',
        agentName,
        timestamp: new Date(base.getTime() + 1000),
      },
    }),
    createAgentResponseEvent(response, {
      sessionId: 'session-ui-test',
      agentName,
      timestamp: new Date(base.getTime() + 2000),
    }),
  ];
}

function resetStores() {
  const observatory = useObservatoryStore.getState();
  observatory.clearEvents();
  observatory.clearFlow();
  observatory.resetMetrics();
  observatory.clearLogs();
  observatory.clearSelection();
  useSessionStore.getState().clearSession();
}

function setTraceEvents(events: ReturnType<typeof createInteraction>) {
  act(() => {
    useObservatoryStore.setState({ events });
  });
}

function setScrollMetrics(
  element: HTMLElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
}

describe('InteractionsTab', () => {
  beforeEach(() => {
    resetStores();
    scrollIntoViewMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });
  });

  it('keeps the latest interaction expanded as traces progress', async () => {
    const firstInteraction = createInteraction(
      '2026-04-23T10:00:00.000Z',
      'i want to apply for loan',
      'Could you clarify the loan type?',
    );
    const secondInteraction = createInteraction(
      '2026-04-23T10:01:00.000Z',
      'auto',
      'Please contact your bank loans team.',
    );

    setTraceEvents([...firstInteraction, ...secondInteraction]);
    render(<InteractionsTab mode="live" />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Interaction 2 with Banking_Supervisor/i }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    expect(
      screen.getByRole('button', { name: /Interaction 1 with Banking_Supervisor/i }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a two-line collapsed header with duration on the left and a waterfall summary', async () => {
    const interaction = createInteraction(
      '2026-04-23T10:00:00.000Z',
      'i want to apply for loan',
      'Could you clarify what type of loan you want to apply for?',
      'unknown',
    );

    setTraceEvents(interaction);
    render(<InteractionsTab mode="historical" />);

    const headerButton = await screen.findByRole('button', {
      name: /Interaction 1 with unknown/i,
    });

    expect(headerButton.textContent).toMatch(/1\s*2\.0s\s*unknown/i);
    expect(headerButton.textContent).toContain('USER');
    expect(headerButton.textContent).toContain('LLM');
    expect(headerButton.textContent).toContain('RESP');
    expect(headerButton.textContent).toContain('gpt-4');
    expect(headerButton.textContent).toContain('Could you clarify what type of loan');
  });

  it('enriches structured-only agent responses from persisted content envelopes', async () => {
    const base = new Date('2026-04-23T10:00:00.000Z');
    const events = [
      createUserMessageEvent('show my options', {
        sessionId: 'session-ui-test',
        agentName: 'Banking_Supervisor',
        timestamp: base,
      }),
      createAgentResponseEvent('', {
        sessionId: 'session-ui-test',
        agentName: 'Banking_Supervisor',
        timestamp: new Date(base.getTime() + 2000),
      }),
    ];

    useSessionStore.getState().addMessage({
      id: 'structured-response',
      role: 'assistant',
      content: '',
      contentEnvelope: {
        richContent: {
          markdown: '### Structured options',
        },
        voiceConfig: {
          plain_text: 'Structured options for voice',
        },
      },
      timestamp: new Date(base.getTime() + 2050),
      traceIds: [],
    });

    setTraceEvents(events);
    render(<InteractionsTab mode="historical" />);

    const headerButton = await screen.findByRole('button', {
      name: /Interaction 1 with Banking_Supervisor/i,
    });

    expect(headerButton.textContent).toContain('RESP');
    expect(headerButton.textContent).toContain('Structured options');
    expect(await screen.findByText('Structured options')).toBeInTheDocument();
  });

  it('enriches actions-only agent responses from persisted content envelopes', async () => {
    const base = new Date('2026-04-23T10:00:00.000Z');
    const events = [
      createUserMessageEvent('show actions', {
        sessionId: 'session-ui-test',
        agentName: 'Banking_Supervisor',
        timestamp: base,
      }),
      createAgentResponseEvent('', {
        sessionId: 'session-ui-test',
        agentName: 'Banking_Supervisor',
        timestamp: new Date(base.getTime() + 2000),
      }),
    ];

    useSessionStore.getState().addMessage({
      id: 'actions-only-response',
      role: 'assistant',
      content: '',
      contentEnvelope: {
        actions: {
          elements: [
            { id: 'approve', type: 'button', label: 'Approve' },
            { id: 'decline', type: 'button', label: 'Decline' },
          ],
        },
      },
      timestamp: new Date(base.getTime() + 2050),
      traceIds: [],
    });

    setTraceEvents(events);
    render(<InteractionsTab mode="historical" />);

    const headerButton = await screen.findByRole('button', {
      name: /Interaction 1 with Banking_Supervisor/i,
    });

    expect(headerButton.textContent).toContain('RESP');
    expect(headerButton.textContent).toContain('Interactive actions: Approve, Decline');
    expect(await screen.findAllByText('Interactive actions: Approve, Decline')).toHaveLength(2);
  });

  it('auto-scrolls to the newest interaction while following the live trace', async () => {
    const firstInteraction = createInteraction(
      '2026-04-23T10:00:00.000Z',
      'i want to apply for loan',
      'Could you clarify the loan type?',
    );
    const secondInteraction = createInteraction(
      '2026-04-23T10:01:00.000Z',
      'auto',
      'Please contact your bank loans team.',
    );

    render(<InteractionsTab mode="live" />);
    setTraceEvents(firstInteraction);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Interaction 1 with Banking_Supervisor/i }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    scrollIntoViewMock.mockClear();

    setTraceEvents([...firstInteraction, ...secondInteraction]);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Interaction 2 with Banking_Supervisor/i }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });

  it('stops auto-scrolling after the operator scrolls away from the bottom', async () => {
    const firstInteraction = createInteraction(
      '2026-04-23T10:00:00.000Z',
      'i want to apply for loan',
      'Could you clarify the loan type?',
    );
    const secondInteraction = createInteraction(
      '2026-04-23T10:01:00.000Z',
      'auto',
      'Please contact your bank loans team.',
    );

    render(<InteractionsTab mode="live" />);
    setTraceEvents(firstInteraction);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Interaction 1 with Banking_Supervisor/i }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    const timeline = screen.getByLabelText('Interaction timeline');
    setScrollMetrics(timeline, {
      scrollHeight: 800,
      clientHeight: 240,
      scrollTop: 120,
    });
    fireEvent.scroll(timeline);

    scrollIntoViewMock.mockClear();
    setTraceEvents([...firstInteraction, ...secondInteraction]);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Interaction 2 with Banking_Supervisor/i }),
      ).toHaveAttribute('aria-expanded', 'true');
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
