import { describe, expect, it } from 'vitest';

import {
  collectHandoffTargetReferences,
  resolveAllowedHandoffTargets,
} from '../../platform/constructs/executors/handoff-authority.js';
import type { AgentIR } from '../../platform/ir/schema.js';

function makeAgentIR(
  overrides: Partial<Pick<AgentIR, 'routing' | 'coordination' | 'constraints'>> = {},
): AgentIR {
  return {
    constraints: {
      constraints: [],
      guardrails: [],
    },
    coordination: {
      delegates: [],
      handoffs: [],
    },
    ...overrides,
  } as AgentIR;
}

describe('resolveAllowedHandoffTargets', () => {
  it('returns an empty map when agent IR is missing', () => {
    expect(resolveAllowedHandoffTargets(undefined)).toEqual(new Map());
  });

  it('collects trimmed routing and coordination handoff targets', () => {
    const handoffTargets = resolveAllowedHandoffTargets(
      makeAgentIR({
        routing: {
          rules: [
            {
              to: '  billing_agent  ',
              when: 'intent == "billing"',
              description: 'Route billing questions',
              priority: 1,
              return: true,
            },
            {
              to: '   ',
              when: 'intent == "noop"',
              description: 'Ignored blank target',
              priority: 2,
            },
          ],
          default_agent: 'fallback_agent',
          intent_classification: {
            use_llm: false,
            categories: [],
            min_confidence: 0.5,
          },
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: '  fraud_agent ',
              when: 'risk_score > 0.8',
              context: {
                pass: [],
                summary: 'Escalate suspected fraud',
              },
              return: false,
            },
            {
              to: '   ',
              when: 'false',
              context: {
                pass: [],
                summary: 'Ignored blank handoff',
              },
              return: true,
            },
          ],
        },
      }),
    );

    expect(Array.from(handoffTargets.entries())).toEqual([
      [
        'billing_agent',
        {
          returnExpected: true,
          source: 'routing',
        },
      ],
      [
        'fraud_agent',
        {
          returnExpected: false,
          source: 'coordination',
        },
      ],
    ]);
  });

  it('extracts only the leading token from constraint handoff targets', () => {
    const handoffTargets = resolveAllowedHandoffTargets(
      makeAgentIR({
        constraints: {
          constraints: [
            {
              condition: 'risk_score > 0.9',
              on_fail: {
                type: 'handoff',
                target: '  risk_agent explain to the specialist ',
              },
            },
            {
              condition: 'risk_score > 0.7',
              on_fail: {
                type: 'handoff',
              },
            },
            {
              condition: 'risk_score <= 0.7',
              on_fail: {
                type: 'respond',
                message: 'Continue',
              },
            },
          ],
          guardrails: [],
        },
      }),
    );

    expect(Array.from(handoffTargets.entries())).toEqual([
      [
        'risk_agent',
        {
          returnExpected: false,
          source: 'constraint',
        },
      ],
    ]);
  });

  it('preserves routing and coordination authority over duplicate constraint targets', () => {
    const handoffTargets = resolveAllowedHandoffTargets(
      makeAgentIR({
        routing: {
          rules: [
            {
              to: 'shared_agent',
              when: 'intent == "shared"',
              description: 'Primary route',
              priority: 1,
              return: true,
            },
          ],
          default_agent: 'fallback_agent',
          intent_classification: {
            use_llm: true,
            categories: ['shared'],
            min_confidence: 0.6,
          },
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'overflow_agent',
              when: 'queue_depth > 10',
              context: {
                pass: [],
                summary: 'Overflow relief',
              },
              return: true,
            },
          ],
        },
        constraints: {
          constraints: [
            {
              condition: 'handoff_required',
              on_fail: {
                type: 'handoff',
                target: 'shared_agent include any extra explanation here',
              },
            },
            {
              condition: 'overflow_required',
              on_fail: {
                type: 'handoff',
                target: 'overflow_agent urgent overflow',
              },
            },
          ],
          guardrails: [],
        },
      }),
    );

    expect(handoffTargets.get('shared_agent')).toEqual({
      returnExpected: true,
      source: 'routing',
    });
    expect(handoffTargets.get('overflow_agent')).toEqual({
      returnExpected: true,
      source: 'coordination',
    });
    expect(handoffTargets.size).toBe(2);
  });

  it('collects normalized target references with source paths and remote metadata', () => {
    const refs = collectHandoffTargetReferences(
      makeAgentIR({
        routing: {
          rules: [
            {
              to: ' billing_agent ',
              when: 'intent == "billing"',
              description: 'Billing route',
              priority: 1,
            },
          ],
          default_agent: 'fallback_agent',
          intent_classification: {
            use_llm: true,
            categories: ['billing'],
            min_confidence: 0.6,
          },
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: ' remote_specialist ',
              when: 'always',
              context: {
                pass: [],
                summary: 'Remote specialist',
              },
              return: true,
              remote: {
                location: 'remote',
                endpoint: 'https://example.com/a2a',
              },
            },
          ],
        },
        constraints: {
          constraints: [
            {
              condition: 'needs_review',
              on_fail: {
                type: 'handoff',
                target: ' review_agent include a short explanation ',
              },
            },
          ],
          guardrails: [],
        },
      }),
    );

    expect(refs).toEqual([
      {
        target: 'billing_agent',
        rawTarget: ' billing_agent ',
        path: 'routing.rules[0].to',
        returnExpected: false,
        source: 'routing',
        remote: false,
      },
      {
        target: 'remote_specialist',
        rawTarget: ' remote_specialist ',
        path: 'coordination.handoffs[0].to',
        returnExpected: true,
        source: 'coordination',
        remote: true,
      },
      {
        target: 'review_agent',
        rawTarget: ' review_agent include a short explanation ',
        path: 'constraints[0].on_fail.target',
        returnExpected: false,
        source: 'constraint',
        remote: false,
      },
    ]);
  });
});
