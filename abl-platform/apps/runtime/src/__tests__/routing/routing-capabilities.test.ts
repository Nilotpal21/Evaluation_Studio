import { describe, expect, it } from 'vitest';
import {
  getHandoffReturnInfo,
  getReturnExpectedForTarget,
  getValidHandoffTargets,
  resolveActiveRoutingCapabilities,
} from '../../services/execution/routing-capabilities.js';
import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';

function makeIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 1800000,
      },
    },
    identity: {
      goal: '',
      persona: '',
      limitations: [],
      system_prompt: { template: '', sections: {} },
    },
    tools: [],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], escalation: undefined },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
    ...overrides,
  } as AgentIR;
}

describe('routing-capabilities', () => {
  it('derives handoff and delegate targets from the active IR', () => {
    const capabilities = resolveActiveRoutingCapabilities(
      makeIR({
        routing: {
          rules: [
            {
              to: 'Billing_Agent',
              when: 'true',
              description: 'Billing',
              priority: 1,
              return: true,
            },
          ],
          default_agent: 'Billing_Agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
        coordination: {
          delegates: [
            {
              agent: 'Summary_Agent',
              when: 'true',
              purpose: 'Summarize data',
              input: {},
              returns: {},
              use_result: 'result',
              on_failure: 'continue',
            },
          ],
          handoffs: [
            {
              to: 'Shipping_Agent',
              when: 'true',
              return: false,
              context: { pass: [], summary: '' },
            },
          ],
        },
      }),
    );

    expect(getValidHandoffTargets(capabilities)).toEqual(['Billing_Agent', 'Shipping_Agent']);
    expect(Array.from(capabilities.delegateTargets)).toEqual(['Summary_Agent']);
    expect(getReturnExpectedForTarget(capabilities, 'Billing_Agent')).toBe(true);
    expect(getReturnExpectedForTarget(capabilities, 'Shipping_Agent')).toBe(false);
  });

  it('prefers the latest IR-defined return semantics for duplicate handoff targets', () => {
    const capabilities = resolveActiveRoutingCapabilities(
      makeIR({
        routing: {
          rules: [
            {
              to: 'Shared_Target',
              when: 'true',
              description: 'Route to target',
              priority: 1,
              return: false,
            },
          ],
          default_agent: 'Shared_Target',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'Shared_Target',
              when: 'true',
              return: true,
              context: { pass: [], summary: '' },
            },
          ],
        },
      }),
    );

    expect(getHandoffReturnInfo(capabilities)).toEqual({ Shared_Target: true });
  });

  it('returns empty capabilities when no routing metadata is present', () => {
    const capabilities = resolveActiveRoutingCapabilities(makeIR());

    expect(getValidHandoffTargets(capabilities)).toEqual([]);
    expect(Array.from(capabilities.delegateTargets)).toEqual([]);
    expect(getHandoffReturnInfo(capabilities)).toEqual({});
  });

  it('includes constraint-declared handoff targets in the active authority map', () => {
    const capabilities = resolveActiveRoutingCapabilities(
      makeIR({
        constraints: {
          constraints: [
            {
              condition: 'priority != "critical"',
              on_fail: {
                type: 'handoff',
                target: 'Specialist_Agent',
                message: 'Critical issue detected',
              },
            },
          ],
          guardrails: [],
        },
      }),
    );

    expect(getValidHandoffTargets(capabilities)).toEqual(['Specialist_Agent']);
    expect(getReturnExpectedForTarget(capabilities, 'Specialist_Agent')).toBe(false);
  });

  it('does not let constraint handoffs override explicit return semantics for the same target', () => {
    const capabilities = resolveActiveRoutingCapabilities(
      makeIR({
        routing: {
          rules: [
            {
              to: 'Specialist_Agent',
              when: 'true',
              description: 'Escalate to specialist',
              priority: 1,
              return: true,
            },
          ],
          default_agent: 'Specialist_Agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
        constraints: {
          constraints: [
            {
              condition: 'priority != "critical"',
              on_fail: {
                type: 'handoff',
                target: 'Specialist_Agent',
                message: 'Critical issue detected',
              },
            },
          ],
          guardrails: [],
        },
      }),
    );

    expect(getValidHandoffTargets(capabilities)).toEqual(['Specialist_Agent']);
    expect(getReturnExpectedForTarget(capabilities, 'Specialist_Agent')).toBe(true);
  });
});
