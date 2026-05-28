import { describe, it, expect } from 'vitest';
import { guardrailMessage, GuardrailErrorCode } from '../../platform/guardrails/messages.js';

describe('guardrailMessage', () => {
  it('resolves INPUT_BLOCKED without params', () => {
    const msg = guardrailMessage(GuardrailErrorCode.INPUT_BLOCKED);
    expect(msg).toBe('Input blocked by guardrail policy.');
  });

  it('resolves PROVIDER_NOT_REGISTERED with params', () => {
    const msg = guardrailMessage(GuardrailErrorCode.PROVIDER_NOT_REGISTERED, {
      provider: 'openai',
    });
    expect(msg).toBe('Guardrail provider "openai" not registered');
  });

  it('resolves FILTER_ESCALATED with guardrailName param', () => {
    const msg = guardrailMessage(GuardrailErrorCode.FILTER_ESCALATED, {
      guardrailName: 'pii-filter',
    });
    expect(msg).toBe('Filter removed too much content from "pii-filter" — blocked');
  });

  it('falls back to code string for unknown codes', () => {
    const msg = guardrailMessage('UNKNOWN_CODE_XYZ');
    expect(msg).toBe('UNKNOWN_CODE_XYZ');
  });

  it('resolves all defined guardrail codes', () => {
    for (const [, code] of Object.entries(GuardrailErrorCode)) {
      const msg = guardrailMessage(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toBe(code); // Should resolve to a human-readable message, not the code itself
    }
  });
});
