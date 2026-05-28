/**
 * @vitest-environment happy-dom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExtendedTraceEvent } from '../types';
import { processEventsToInteractions } from '../components/observatory/interactions/event-processor';
import { InteractionStep } from '../components/observatory/interactions/InteractionStep';

function makeEvent(
  type: string,
  offsetMs: number,
  data: Record<string, unknown>,
): ExtendedTraceEvent {
  const timestamp = new Date(new Date('2026-04-24T10:00:00Z').getTime() + offsetMs);
  return {
    id: `evt-${offsetMs}`,
    type: type as ExtendedTraceEvent['type'],
    timestamp,
    durationMs: typeof data.latencyMs === 'number' ? (data.latencyMs as number) : undefined,
    traceId: `trace-${offsetMs}`,
    spanId: `span-${offsetMs}`,
    sessionId: 'sess-tool-card',
    agentName: 'observatory-agent',
    data,
  };
}

describe('ToolCallContent', () => {
  it('renders separate visible child cards for same-step parallel tool calls', () => {
    const events = [
      makeEvent('user_message', 0, { content: 'Run both lookups.' }),
      makeEvent('tool_call', 100, {
        tool: 'crm_lookup',
        toolName: 'crm_lookup',
        input: { customerId: 'cust-123' },
        result: { name: 'Alice' },
        success: true,
        latencyMs: 94,
        url: 'https://internal.example.test/crm',
        method: 'GET',
      }),
      makeEvent('tool_call', 120, {
        tool: 'balance_lookup',
        toolName: 'balance_lookup',
        input: { accountId: 'acc-987' },
        result: { balance: 42 },
        success: true,
        latencyMs: 101,
        url: 'https://internal.example.test/balance',
        method: 'GET',
      }),
      makeEvent('agent_response', 180, { content: 'Parallel tools completed.' }),
    ];

    const processed = processEventsToInteractions(events);
    const interaction = processed.interactions[0];
    const toolStep = interaction.steps.find((step) => step.type === 'tool_call');

    expect(toolStep).toBeDefined();

    render(<InteractionStep step={toolStep!} isLast={false} allSteps={interaction.steps} />);

    expect(screen.getByText('2 tool calls')).toBeInTheDocument();
    expect(screen.getByText('crm_lookup')).toBeInTheDocument();
    expect(screen.getByText('balance_lookup')).toBeInTheDocument();
    expect(screen.getAllByText('GET')).toHaveLength(2);
  });
});
