import { describe, it, expect } from 'vitest';
import {
  AgentEnteredDataSchema,
  AgentExitedDataSchema,
} from '../../../../packages/eventstore/src/schema/events/agent-events.js';

describe('agent.entered schema', () => {
  it.each(['user_message', 'handoff', 'delegate', 'resume_intent', 'fan_out'])(
    'accepts trigger=%s',
    (trigger) => {
      const result = AgentEnteredDataSchema.safeParse({ trigger });
      expect(result.success).toBe(true);
    },
  );
});

describe('agent.exited schema', () => {
  it.each([
    'escalate',
    'continue',
    'constraint_blocked',
    'completed',
    'complete',
    'handoff',
    'error',
    'delegate',
    'return_to_parent',
    'waiting_for_action',
    'collect',
  ])('accepts result=%s', (exitResult) => {
    const result = AgentExitedDataSchema.safeParse({ result: exitResult });
    expect(result.success).toBe(true);
  });
});
