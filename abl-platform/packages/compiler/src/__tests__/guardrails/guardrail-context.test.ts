import { describe, it, expect } from 'vitest';
import { buildGuardrailCelContext } from '../../platform/constructs/guardrail-context.js';

describe('buildGuardrailCelContext', () => {
  it('should inject input variable for input kind', () => {
    const ctx = buildGuardrailCelContext('input', {
      content: 'Hello world',
      agentGoal: 'Help users',
      sessionTurnCount: 5,
    });
    expect(ctx.input).toBe('Hello world');
    expect(ctx.agent_goal).toBe('Help users');
    expect(ctx.session_turn_count).toBe(5);
  });

  it('should inject output variable for output kind', () => {
    const ctx = buildGuardrailCelContext('output', {
      content: 'Response text',
      agentGoal: 'Help users',
      sessionTurnCount: 3,
    });
    expect(ctx.output).toBe('Response text');
  });

  it('should inject tool variables for tool_input kind', () => {
    const ctx = buildGuardrailCelContext('tool_input', {
      content: '{"query": "test"}',
      toolName: 'search',
      toolParameters: { query: 'test' },
      sessionTurnCount: 2,
    });
    expect(ctx.tool_name).toBe('search');
    expect(ctx.tool_parameters).toEqual({ query: 'test' });
  });

  it('should inject handoff variables for handoff kind', () => {
    const ctx = buildGuardrailCelContext('handoff', {
      content: 'Context transfer',
      sourceAgent: 'booking',
      targetAgent: 'support',
      handoffContext: 'Customer needs help',
      handoffReason: 'Billing issue',
      sessionTurnCount: 4,
    });
    expect(ctx.source_agent).toBe('booking');
    expect(ctx.target_agent).toBe('support');
    expect(ctx.handoff_context).toBe('Customer needs help');
  });
});
