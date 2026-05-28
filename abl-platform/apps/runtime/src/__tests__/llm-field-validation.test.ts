import { describe, test, expect, vi } from 'vitest';
import {
  validateFieldWithLLM,
  validateFieldsWithLLM,
} from '../services/execution/llm-field-validator.js';

// Mock LLM client
function createMockLLMClient(response: { text: string }) {
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: response.text,
      usage: { inputTokens: 10, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test' },
    }),
  };
}

describe('validateFieldWithLLM', () => {
  test('returns valid for valid value', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const result = await validateFieldWithLLM(
      'email',
      'test@example.com',
      'Must be a valid email',
      client,
    );
    expect(result.valid).toBe(true);
  });

  test('returns invalid for rejected value', async () => {
    const client = createMockLLMClient({
      text: '{"valid": false, "reason": "Not a valid email format"}',
    });
    const result = await validateFieldWithLLM(
      'email',
      'not-email',
      'Must be a valid email',
      client,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Not a valid email');
  });

  test('fail-open on LLM error', async () => {
    const client = {
      chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM down')),
    };
    const result = await validateFieldWithLLM('email', 'test@example.com', 'Must be valid', client);
    expect(result.valid).toBe(true); // fail-open
  });

  test('fail-open on unparseable response', async () => {
    const client = createMockLLMClient({ text: 'I cannot validate this' });
    const result = await validateFieldWithLLM('email', 'test@example.com', 'Must be valid', client);
    expect(result.valid).toBe(true); // fail-open
  });

  test('rejects oversized value', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const bigValue = 'x'.repeat(3000);
    const result = await validateFieldWithLLM('field', bigValue, 'Must be short', client);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds maximum');
    expect(client.chatWithToolUse).not.toHaveBeenCalled(); // LLM not called for oversized
  });

  test('emits trace event on successful validation', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };

    await validateFieldWithLLM('email', 'test@example.com', 'Must be valid', client, onTraceEvent);

    expect(traceEvents).toHaveLength(1);
    expect(traceEvents[0].type).toBe('llm_call');
    expect(traceEvents[0].data.purpose).toBe('field_validation');
    expect(traceEvents[0].data.fieldName).toBe('email');
  });

  test('emits trace event on LLM error (fail-open)', async () => {
    const client = {
      chatWithToolUse: vi.fn().mockRejectedValue(new Error('LLM down')),
    };
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };

    await validateFieldWithLLM('email', 'test@example.com', 'Must be valid', client, onTraceEvent);

    expect(traceEvents).toHaveLength(1);
    expect(traceEvents[0].type).toBe('memory_error');
    expect(traceEvents[0].data.operation).toBe('validateFieldWithLLM');
  });

  test('extracts JSON from response with surrounding text', async () => {
    const client = createMockLLMClient({
      text: 'Here is the result: {"valid": false, "reason": "Bad format"} done.',
    });
    const result = await validateFieldWithLLM('email', 'bad', 'Must be valid email', client);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Bad format');
  });
});

describe('validateFieldsWithLLM', () => {
  test('validates multiple fields in parallel', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [
      {
        name: 'email',
        validation: { type: 'llm' as const, rule: 'Valid email', error_message: 'Invalid email' },
      },
      {
        name: 'phone',
        validation: { type: 'llm' as const, rule: 'Valid phone', error_message: 'Invalid phone' },
      },
    ];
    const errors = await validateFieldsWithLLM(
      { email: 'a@b.com', phone: '555-1234' },
      fields,
      client,
    );
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).toHaveBeenCalledTimes(2);
  });

  test('skips fields without LLM validation type', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [
      {
        name: 'email',
        validation: {
          type: 'pattern' as const,
          rule: '.*@.*',
          error_message: 'Must contain @',
        },
      },
      {
        name: 'phone',
        validation: { type: 'llm' as const, rule: 'Valid phone', error_message: 'Invalid phone' },
      },
    ];
    const errors = await validateFieldsWithLLM(
      { email: 'a@b.com', phone: '555-1234' },
      fields,
      client,
    );
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).toHaveBeenCalledTimes(1); // Only phone (llm type)
  });

  test('returns errors for rejected fields', async () => {
    const client = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: '{"valid": false, "reason": "Invalid format"}',
        usage: {},
        resolvedModel: {},
      }),
    };
    const fields = [
      {
        name: 'email',
        validation: { type: 'llm' as const, rule: 'Valid email', error_message: 'Invalid email' },
      },
    ];
    const errors = await validateFieldsWithLLM({ email: 'bad' }, fields, client);
    expect(errors.email).toContain('Invalid format');
  });

  test('skips fields with undefined/null values', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [
      {
        name: 'email',
        validation: { type: 'llm' as const, rule: 'Valid email', error_message: 'Invalid email' },
      },
    ];
    const errors = await validateFieldsWithLLM({ email: undefined }, fields, client);
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).not.toHaveBeenCalled();
  });

  test('skips fields with null values', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [
      {
        name: 'email',
        validation: { type: 'llm' as const, rule: 'Valid email', error_message: 'Invalid email' },
      },
    ];
    const errors = await validateFieldsWithLLM({ email: null }, fields, client);
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).not.toHaveBeenCalled();
  });

  test('returns empty errors when no fields have LLM validation', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [
      {
        name: 'email',
        validation: {
          type: 'pattern' as const,
          rule: '.*@.*',
          error_message: 'Must contain @',
        },
      },
    ];
    const errors = await validateFieldsWithLLM({ email: 'a@b.com' }, fields, client);
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).not.toHaveBeenCalled();
  });

  test('returns empty errors when no fields have validation at all', async () => {
    const client = createMockLLMClient({ text: '{"valid": true}' });
    const fields = [{ name: 'email' }];
    const errors = await validateFieldsWithLLM({ email: 'a@b.com' }, fields, client);
    expect(errors).toEqual({});
    expect(client.chatWithToolUse).not.toHaveBeenCalled();
  });
});
