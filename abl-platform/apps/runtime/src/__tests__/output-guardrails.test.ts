import { describe, it, expect } from 'vitest';
import { checkOutputGuardrails } from '../services/execution/output-guardrails.js';

describe('checkOutputGuardrails', () => {
  it('should pass when no guardrails defined', async () => {
    const result = await checkOutputGuardrails('Hello', undefined, {});
    expect(result.passed).toBe(true);
    expect(result.text).toBe('Hello');
  });

  it('should pass when guardrails array is empty', async () => {
    const result = await checkOutputGuardrails('Hello', [], {});
    expect(result.passed).toBe(true);
  });

  it('should pass when only input guardrails exist (no output kind)', async () => {
    const guardrails = [
      { name: 'input-check', condition: 'true', action: { type: 'block' }, kind: 'input' },
    ];
    const result = await checkOutputGuardrails('Hello', guardrails as any, {});
    expect(result.passed).toBe(true);
  });

  it('should pass when text is empty', async () => {
    const result = await checkOutputGuardrails('', [{ kind: 'output' }] as any, {});
    expect(result.passed).toBe(true);
  });

  it('should return the original text on pass', async () => {
    const result = await checkOutputGuardrails('Hello world', undefined, {});
    expect(result.text).toBe('Hello world');
  });
});
