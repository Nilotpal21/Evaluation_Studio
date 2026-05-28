import { describe, expect, it } from 'vitest';
import { extractCurrentAgentFromTraceEvents } from '../pipeline/services/eval/eval-trace-utils.js';
import type { TraceEvent } from '../pipeline/services/eval/eval-types.js';

describe('eval trace utilities', () => {
  it('extracts the latest responding agent from runtime trace event data', () => {
    const traceEvents = [
      { type: 'agent_enter', data: { agentName: 'SupportAgent' } },
      { type: 'handoff', data: { toAgent: 'BillingAgent' } },
      { type: 'flow_step_enter', data: { stepName: 'finalize', agentName: 'BillingAgent' } },
    ] as TraceEvent[];

    expect(extractCurrentAgentFromTraceEvents(traceEvents)).toBe('BillingAgent');
  });

  it('supports flattened rendered trace events as a fallback', () => {
    const traceEvents = [
      { type: 'agent_enter', agentName: 'SupportAgent' },
      { type: 'flow_step_enter', stepName: 'finalize', agent: 'SupportAgent' },
    ] as unknown as TraceEvent[];

    expect(extractCurrentAgentFromTraceEvents(traceEvents)).toBe('SupportAgent');
  });
});
