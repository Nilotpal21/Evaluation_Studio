import { describe, expect, it } from 'vitest';
import { eventRegistry } from '../../event-registry.js';
import { AgentEnteredDataSchema, AgentExitedDataSchema } from '../agent-events.js';

describe('agent event schemas', () => {
  it('accepts runtime agent enter triggers emitted by regular and resume turns', () => {
    for (const trigger of ['user_message', 'handoff', 'delegate', 'resume_intent', 'fan_out']) {
      expect(AgentEnteredDataSchema.safeParse({ trigger }).success).toBe(true);
    }
  });

  it('rejects empty agent enter triggers while allowing extension values', () => {
    expect(AgentEnteredDataSchema.safeParse({ trigger: '' }).success).toBe(false);
    expect(AgentEnteredDataSchema.safeParse({ trigger: 'custom_runtime_trigger' }).success).toBe(
      true,
    );
  });

  it('accepts runtime agent exit results emitted for normal, blocked, and return turns', () => {
    for (const result of [
      'completed',
      'complete',
      'continue',
      'constraint_blocked',
      'escalate',
      'handoff',
      'delegate',
      'error',
      'return_to_parent',
      'waiting_for_action',
      'collect',
    ]) {
      expect(AgentExitedDataSchema.safeParse({ result }).success).toBe(true);
    }
  });

  it('rejects empty agent exit results while allowing extension values', () => {
    expect(AgentExitedDataSchema.safeParse({ result: '' }).success).toBe(false);
    expect(AgentExitedDataSchema.safeParse({ result: 'custom_runtime_result' }).success).toBe(true);
  });

  it('marks content-bearing agent events as PII for retention scrubbing', () => {
    const piiTypes = eventRegistry.getPIIEventTypes();

    expect(piiTypes).toContain('agent.handoff');
    expect(piiTypes).toContain('agent.delegated');
    expect(piiTypes).toContain('agent.delegate.completed');
    expect(piiTypes).toContain('agent.decision');
    expect(piiTypes).toContain('agent.handoff.resume_intent');
    expect(piiTypes).toContain('agent.thread.returned');
  });
});
