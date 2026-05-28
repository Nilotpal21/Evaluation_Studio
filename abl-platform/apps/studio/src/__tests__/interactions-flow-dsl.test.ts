/**
 * Flow/DSL — Tests for flow step state computation.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';
import { extractFlowSteps } from '../components/observatory/interactions/FlowBreadcrumb';
import type { InteractionStep } from '../components/observatory/interactions/types';
import type { ExtendedTraceEvent } from '../types';

let id = 0;
const base = new Date('2026-03-31T10:00:00Z');

function makeStep(
  type: InteractionStep['type'],
  data: Record<string, unknown> = {},
  events: ExtendedTraceEvent[] = [],
): InteractionStep {
  id++;
  const step: InteractionStep = {
    id: `step-${id}`,
    type,
    timestamp: base,
    agentName: 'test-agent',
    events:
      events.length > 0
        ? events
        : [
            {
              id: `evt-${id}`,
              type: type as ExtendedTraceEvent['type'],
              timestamp: base,
              traceId: 'trace-1',
              spanId: `span-${id}`,
              sessionId: 'sess-1',
              agentName: 'test-agent',
              data,
            },
          ],
    data,
  };
  return step;
}

describe('extractFlowSteps', () => {
  it('extracts visited and active steps from transitions', () => {
    const steps = [
      makeStep('flow_transition', { fromStep: 'greeting', toStep: 'collect_issue' }),
      makeStep('flow_transition', { fromStep: 'collect_issue', toStep: 'lookup_order' }),
    ];

    const result = extractFlowSteps(steps);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'greeting', state: 'visited' });
    expect(result[1]).toEqual({ name: 'collect_issue', state: 'visited' });
    expect(result[2]).toEqual({ name: 'lookup_order', state: 'active' });
  });

  it('marks error steps', () => {
    const steps = [
      makeStep('flow_transition', { fromStep: 'greeting', toStep: 'lookup' }),
      makeStep('error', { message: 'Service unavailable' }),
    ];

    const result = extractFlowSteps(steps);

    const lookupStep = result.find((s) => s.name === 'lookup');
    expect(lookupStep?.state).toBe('error');
  });

  it('includes upcoming steps from flow definition', () => {
    const steps = [
      makeStep('flow_transition', {
        fromStep: 'greeting',
        toStep: 'collect',
        flowSteps: ['greeting', 'collect', 'process', 'confirm'],
      }),
    ];

    const result = extractFlowSteps(steps);

    expect(result).toHaveLength(4);
    expect(result[2]).toEqual({ name: 'process', state: 'upcoming' });
    expect(result[3]).toEqual({ name: 'confirm', state: 'upcoming' });
  });

  it('returns empty for non-flow interactions', () => {
    const steps = [
      makeStep('user_input', { content: 'hello' }),
      makeStep('llm_call', { model: 'gpt-4' }),
    ];

    const result = extractFlowSteps(steps);

    expect(result).toHaveLength(0);
  });
});
