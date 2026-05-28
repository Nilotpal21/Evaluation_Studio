import { describe, expect, it } from 'vitest';
import {
  attachTraceCausalFieldsToData,
  buildTraceCausalitySummary,
  getTraceCausalFields,
} from '../utils/trace-causality';

describe('trace-causality utilities', () => {
  it('prefers canonical top-level causal fields over mirrored payload fields', () => {
    const fields = getTraceCausalFields({
      id: 'evt-1',
      type: 'completion_check',
      agentRunId: 'run-top',
      causeEventId: 'evt-cause-top',
      phase: 'decision',
      data: {
        agentRunId: 'run-data',
        causeEventId: 'evt-cause-data',
        causal: {
          phase: 'nested-phase',
          reasonCode: 'completion_check',
        },
      },
    });

    expect(fields).toEqual(
      expect.objectContaining({
        agentRunId: 'run-top',
        causeEventId: 'evt-cause-top',
        phase: 'decision',
        reasonCode: 'completion_check',
      }),
    );
  });

  it('builds a readable cause ledger and flags missing cause links', () => {
    const summary = buildTraceCausalitySummary([
      {
        id: 'evt-enter',
        type: 'agent_enter',
        agentName: 'Agent',
        spanId: 'span-enter',
        data: { causal: { agentRunId: 'run-1', phase: 'agent_lifecycle' } },
      },
      {
        id: 'evt-decision',
        type: 'completion_check',
        agentName: 'Agent',
        data: {
          causal: {
            agentRunId: 'run-1',
            decisionId: 'evt-decision',
            causeEventId: 'span-enter',
            phase: 'decision',
            reasonCode: 'completion_check',
          },
        },
      },
      {
        id: 'evt-orphan',
        type: 'tool_call',
        data: { causal: { causeEventId: 'evt-missing', phase: 'tool' } },
      },
    ]);

    expect(summary.agentRunCount).toBe(1);
    expect(summary.decisionCount).toBe(1);
    expect(summary.linkedCauseCount).toBe(2);
    expect(summary.resolvedCauseCount).toBe(1);
    expect(summary.missingCauseCount).toBe(1);
    expect(summary.traceHealthLabel).toBe('1 link not loaded');
    expect(summary.rows[1]?.label).toBe('Decision');
    expect(summary.rows[1]?.causeLabel).toBe('Agent entered Agent');
    expect(summary.rows[1]?.causeDetail).toBe('agent_enter evt-ente...');
    expect(summary.phaseCounts).toEqual([
      { phase: 'agent_lifecycle', count: 1 },
      { phase: 'decision', count: 1 },
      { phase: 'tool', count: 1 },
    ]);
  });

  it('attaches causal fields without overwriting event-domain fields', () => {
    const data = attachTraceCausalFieldsToData(
      { phase: 'complete' },
      { phase: 'tool', reasonCode: 'tool_call', causeEventId: 'evt-prev' },
    );

    expect(data).toEqual(
      expect.objectContaining({
        phase: 'complete',
        reasonCode: 'tool_call',
        causeEventId: 'evt-prev',
        causal: expect.objectContaining({
          phase: 'tool',
          reasonCode: 'tool_call',
          causeEventId: 'evt-prev',
        }),
      }),
    );
  });
});
