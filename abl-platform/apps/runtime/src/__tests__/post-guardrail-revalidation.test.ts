import { describe, test, expect } from 'vitest';
import { validateToolInputs } from '@abl/compiler/platform/constructs';
import type { ToolParameter } from '@abl/compiler';

describe('Post-Guardrail Re-validation', () => {
  const schema: ToolParameter[] = [
    { name: 'order_id', type: 'string', required: true },
    { name: 'email', type: 'string', required: true },
    { name: 'amount', type: 'number', required: true },
    {
      name: 'status',
      type: 'string',
      required: false,
      enum: ['pending', 'confirmed', 'cancelled'],
    },
  ];

  test('passes when guardrail leaves valid params unchanged', () => {
    const params = { order_id: 'ORD-123', email: 'user@test.com', amount: 49.99 };
    expect(() => validateToolInputs('process_order', params, schema)).not.toThrow();
  });

  test('throws when guardrail nullifies a required field', () => {
    const params = { order_id: 'ORD-123', email: null, amount: 49.99 };
    expect(() =>
      validateToolInputs('process_order', params as Record<string, unknown>, schema),
    ).toThrow(/missing required parameter 'email'/);
  });

  test('throws when guardrail removes a required field', () => {
    const params = { order_id: 'ORD-123', amount: 49.99 };
    expect(() =>
      validateToolInputs('process_order', params as Record<string, unknown>, schema),
    ).toThrow(/missing required parameter 'email'/);
  });

  test('throws when guardrail modifies enum to invalid value', () => {
    const params = {
      order_id: 'ORD-123',
      email: 'user@test.com',
      amount: 49.99,
      status: '[REDACTED]',
    };
    expect(() => validateToolInputs('process_order', params, schema)).toThrow(
      /not in allowed values/,
    );
  });

  test('throws when guardrail changes number to non-numeric string', () => {
    const params = { order_id: 'ORD-123', email: 'user@test.com', amount: '[REDACTED]' };
    expect(() =>
      validateToolInputs('process_order', params as Record<string, unknown>, schema),
    ).toThrow(/expected type 'number'/);
  });
});
