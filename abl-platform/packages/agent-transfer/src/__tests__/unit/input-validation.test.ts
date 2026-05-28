import { describe, it, expect } from 'vitest';
import { TransferToAgentInputSchema } from '../../tools/transfer-to-agent.js';

describe('TransferToAgentInput schema validation', () => {
  it('rejects skills array > 50 items', () => {
    const skills = Array.from({ length: 51 }, (_, i) => `skill-${i}`);
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      skills,
    });
    expect(result.success).toBe(false);
  });

  it('accepts skills array <= 50 items', () => {
    const skills = Array.from({ length: 50 }, (_, i) => `skill-${i}`);
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      skills,
    });
    expect(result.success).toBe(true);
  });

  it('rejects metadata > 16KB', () => {
    const bigValue = 'x'.repeat(17000);
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      metadata: { data: bigValue },
    });
    expect(result.success).toBe(false);
  });

  it('accepts metadata <= 16KB', () => {
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      metadata: { key: 'small value' },
    });
    expect(result.success).toBe(true);
  });

  it('validates priority range (0-10)', () => {
    expect(TransferToAgentInputSchema.safeParse({ provider: 'kore', priority: -1 }).success).toBe(
      false,
    );
    expect(TransferToAgentInputSchema.safeParse({ provider: 'kore', priority: 11 }).success).toBe(
      false,
    );
    expect(TransferToAgentInputSchema.safeParse({ provider: 'kore', priority: 0 }).success).toBe(
      true,
    );
    expect(TransferToAgentInputSchema.safeParse({ provider: 'kore', priority: 10 }).success).toBe(
      true,
    );
    expect(TransferToAgentInputSchema.safeParse({ provider: 'kore', priority: 5 }).success).toBe(
      true,
    );
  });

  it('requires provider field', () => {
    const result = TransferToAgentInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty provider string', () => {
    const result = TransferToAgentInputSchema.safeParse({ provider: '' });
    expect(result.success).toBe(false);
  });

  it('accepts valid complete input', () => {
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      skills: ['billing', 'tech-support'],
      queueId: 'q-1',
      priority: 5,
      metadata: { reason: 'escalation' },
      postAgentAction: 'return',
      providerConfig: { custom: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer priority', () => {
    const result = TransferToAgentInputSchema.safeParse({
      provider: 'kore',
      priority: 5.5,
    });
    expect(result.success).toBe(false);
  });
});
