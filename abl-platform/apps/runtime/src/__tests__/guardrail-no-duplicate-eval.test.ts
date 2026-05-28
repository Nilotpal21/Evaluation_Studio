/**
 * Slice 3 lock test — Bruce feedback 5.2
 *
 * Input guardrails are evaluated by the guardrail pipeline in
 * flow-step-executor.ts:4002 before `checkConstraints` runs at line 4070.
 * Today, `checkConstraints` filters TO `input` kind guardrails at
 * constraint-checker.ts:277 and re-evaluates them via `checkConstraintsCore`,
 * producing a duplicate trace event + duplicate CEL evaluation.
 *
 * After fix: `checkConstraints` must NOT evaluate input-kind guardrails
 * (because the pipeline already did). It should still evaluate non-guardrail
 * `constraints[]` items. Output/tool/handoff guardrails do not reach this
 * code path anyway (they fire at their own execution points).
 */
import { describe, it, expect, vi } from 'vitest';
import { checkConstraints } from '../services/execution/constraint-checker.js';
import type { RuntimeSession } from '../services/execution/types.js';

function makeSession(): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test',
    agentIR: {
      identity: { name: 'test', goal: 'test' },
      execution: {},
      constraints: {
        constraints: [],
        guardrails: [
          {
            name: 'block_bad_word',
            description: 'blocks bad word',
            kind: 'input',
            priority: 1,
            tier: 'local',
            // 'true' always triggers — guardrail check semantics: true == violation
            check: 'true',
            action: { type: 'block' },
          },
        ],
      },
    },
    data: {
      values: { input: 'this is bad input' },
    },
    conversationHistory: [],
    traceVerbosity: 'normal',
  } as unknown as RuntimeSession;
}

describe('checkConstraints does not duplicate input-guardrail eval (Slice 3 / Bruce 5.2)', () => {
  it('skips input-kind guardrails (pipeline has already evaluated them)', () => {
    const session = makeSession();
    const onTrace = vi.fn();

    const result = checkConstraints(session, onTrace);

    // After fix: input-kind guardrail in the IR must NOT produce a violation
    // here — the pipeline owns input-kind. Legacy behavior returned the
    // violation, producing a double-block.
    expect(result).toBeNull();

    // And no constraint_check trace event should fire for the input guardrail
    // (either direct `constraint_check` or the decision-wrapped form).
    const guardrailTraces = onTrace.mock.calls.filter(([evt]) => {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      if (evt.type === 'constraint_check' && data.name === 'block_bad_word') return true;
      if (
        evt.type === 'decision' &&
        data.decisionKind === 'constraint_check' &&
        data.field === 'block_bad_word'
      )
        return true;
      return false;
    });
    expect(guardrailTraces).toHaveLength(0);
  });

  it('still evaluates non-guardrail constraints from the IR', () => {
    const session = makeSession();
    session.agentIR!.constraints = {
      constraints: [
        {
          name: 'must_have_name',
          condition: 'has(name)',
          on_fail: { type: 'respond', message: 'need name' },
          severity: 'blocking',
        } as any,
      ],
      guardrails: [
        {
          name: 'input_check',
          description: 'input guard',
          kind: 'input',
          priority: 1,
          tier: 'local',
          check: 'true',
          action: { type: 'block' },
        },
      ],
    };
    session.data.values = {};
    const onTrace = vi.fn();

    const result = checkConstraints(session, onTrace);

    // The constraint should still fire — only guardrails are skipped.
    expect(result).not.toBeNull();
    expect(result!.type).toBe('constraint');
    expect(result!.condition).toBe('has(name)');
  });

  it('still evaluates profile additionalConstraints', () => {
    const session = makeSession();
    (session as unknown as { _effectiveConfig: unknown })._effectiveConfig = {
      additionalConstraints: [
        {
          name: 'policy_constraint',
          condition: 'has(authorized)',
          on_fail: { type: 'respond', message: 'unauthorized' },
          severity: 'blocking',
        },
      ],
    };
    session.data.values = {};
    const onTrace = vi.fn();

    const result = checkConstraints(session, onTrace);

    expect(result).not.toBeNull();
    expect(result!.condition).toBe('has(authorized)');
  });
});
