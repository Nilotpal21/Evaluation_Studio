/**
 * Slice 3 lock test — Bruce feedback 5.2 (observability leg)
 *
 * Before fix: a single input-guardrail violation produced TWO
 * `constraint_check` / `guardrail_check` trace events — once from the
 * pipeline evaluation and once from `checkConstraints`'s re-evaluation.
 * That inflated observability dashboards and hid real violation counts.
 *
 * After fix: exactly ONE trace event per input-guardrail violation —
 * the pipeline's own `guardrail_check` event. `checkConstraints` emits
 * zero events for input-kind guardrails.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkConstraints } from '../services/execution/constraint-checker.js';
import type { RuntimeSession } from '../services/execution/types.js';

function makeSession(): RuntimeSession {
  return {
    id: 'trace-count-session',
    agentName: 'test',
    agentIR: {
      identity: { name: 'test', goal: 'test' },
      execution: {},
      constraints: {
        constraints: [],
        guardrails: [
          {
            name: 'pii_guard',
            description: 'pii guard',
            kind: 'input',
            priority: 1,
            tier: 'local',
            // 'true' always fires — guardrail semantics: true == violation detected
            check: 'true',
            action: { type: 'block' },
          },
          {
            name: 'length_guard',
            description: 'length guard',
            kind: 'input',
            priority: 2,
            tier: 'local',
            check: 'true',
            action: { type: 'warn' },
          },
        ],
      },
    },
    data: {
      values: { input: 'my ssn is 123-45-6789' },
    },
    conversationHistory: [],
    traceVerbosity: 'normal',
  } as unknown as RuntimeSession;
}

describe('guardrail trace-event count is stable (Slice 3 / Bruce 5.2)', () => {
  it('emits zero constraint_check events for input-kind guardrails', () => {
    const session = makeSession();
    const onTrace = vi.fn();

    checkConstraints(session, onTrace);

    // Catch both the direct `constraint_check` event and the decision-wrapped form.
    const inputGuardrailTraces = onTrace.mock.calls.filter(([evt]) => {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      const namedTargets = ['pii_guard', 'length_guard'];
      if (evt.type === 'constraint_check' && namedTargets.includes(String(data.name))) return true;
      if (
        evt.type === 'decision' &&
        data.decisionKind === 'constraint_check' &&
        namedTargets.includes(String(data.field))
      )
        return true;
      return false;
    });
    expect(inputGuardrailTraces).toHaveLength(0);
  });

  it('does not double-emit trace events for a single constraint violation', () => {
    const session = makeSession();
    session.agentIR!.constraints = {
      constraints: [
        {
          condition: 'has(verified)',
          on_fail: { type: 'respond', message: 'needs verification' },
          severity: 'blocking',
        } as any,
      ],
      guardrails: [],
    };
    session.data.values = {};
    const onTrace = vi.fn();

    checkConstraints(session, onTrace);

    // Exactly one direct `constraint_check` trace for the failing constraint.
    const directTraces = onTrace.mock.calls.filter(([evt]) => evt.type === 'constraint_check');
    expect(directTraces).toHaveLength(1);
  });
});
