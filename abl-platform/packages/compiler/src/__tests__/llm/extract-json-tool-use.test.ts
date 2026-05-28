/**
 * Tests for tool-use-based JSON extraction
 *
 * Tests parseSchemaString helper and the LLMClient.extractJson method
 * which uses forced tool use for reliable structured output.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LLMClient, parseSchemaString } from '../../platform/llm/provider.js';
import type {
  LLMProvider,
  ToolCompletionResult,
  CompletionResult,
} from '../../platform/llm/types.js';

// =============================================================================
// parseSchemaString tests
// =============================================================================

describe('parseSchemaString', () => {
  test('should parse simple string fields', () => {
    const result = parseSchemaString('{ "name": "string", "email": "string" }');

    expect(result.properties).toEqual({
      name: { type: 'string' },
      email: { type: 'string' },
    });
    expect(result.required).toEqual(['name', 'email']);
  });

  test('should parse number fields', () => {
    const result = parseSchemaString('{ "age": "number", "count": "integer" }');

    expect(result.properties.age).toEqual({ type: 'number' });
    expect(result.properties.count).toEqual({ type: 'number' });
    expect(result.required).toContain('age');
    expect(result.required).toContain('count');
  });

  test('should parse boolean fields', () => {
    const result = parseSchemaString('{ "active": "boolean" }');

    expect(result.properties.active).toEqual({ type: 'boolean' });
    expect(result.required).toContain('active');
  });

  test('should handle "or null" types as optional', () => {
    const result = parseSchemaString('{ "name": "string", "nickname": "string or null" }');

    expect(result.properties.name).toEqual({ type: 'string' });
    expect(result.properties.nickname).toEqual({ type: 'string' });
    expect(result.required).toEqual(['name']);
    expect(result.required).not.toContain('nickname');
  });

  test('should handle invalid JSON gracefully', () => {
    const result = parseSchemaString('not valid json');

    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });

  test('should handle unknown types as string', () => {
    const result = parseSchemaString('{ "data": "custom_type" }');

    expect(result.properties.data).toEqual({ type: 'string' });
  });

  test('should handle empty schema', () => {
    const result = parseSchemaString('{}');

    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });
});

// =============================================================================
// LLMClient.extractJson tests
// =============================================================================

describe('LLMClient.extractJson', () => {
  let mockProvider: LLMProvider;

  beforeEach(() => {
    mockProvider = {
      name: 'anthropic',
      complete: vi.fn(),
      completeWithTools: vi.fn(),
      streamComplete: vi.fn(),
      streamCompleteWithTools: vi.fn(),
      getModelForTier: vi.fn().mockReturnValue('test-model'),
      supportsFeature: vi.fn().mockReturnValue(true),
    } as unknown as LLMProvider;
  });

  test('should use tool use when provider supports tools', async () => {
    const toolResult: ToolCompletionResult = {
      toolCalls: [
        { id: '1', name: 'extract_fields', input: { name: 'John', email: 'john@test.com' } },
      ],
      stopReason: 'tool_use',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.completeWithTools as any).mockResolvedValue(toolResult);

    const client = new LLMClient(mockProvider);
    const result = await client.extractJson(
      'Extract user info',
      [{ role: 'user', content: 'My name is John and email is john@test.com' }],
      '{ "name": "string", "email": "string" }',
      { model: 'test-model' },
    );

    expect(result).toEqual({ name: 'John', email: 'john@test.com' });
    expect(mockProvider.completeWithTools).toHaveBeenCalledTimes(1);

    // Verify the tool definition shape
    const call = (mockProvider.completeWithTools as any).mock.calls[0];
    const toolOptions = call[2]; // options arg
    expect(toolOptions.tools[0].name).toBe('extract_fields');
    expect(toolOptions.toolChoice).toBe('any');
  });

  test('should fall back to prompt-based extraction when provider lacks tool support', async () => {
    (mockProvider.supportsFeature as any).mockReturnValue(false);
    const completionResult: CompletionResult = {
      text: '{ "name": "Jane" }',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.complete as any).mockResolvedValue(completionResult);

    const client = new LLMClient(mockProvider);
    const result = await client.extractJson(
      'Extract info',
      [{ role: 'user', content: 'My name is Jane' }],
      '{ "name": "string" }',
      { model: 'test-model' },
    );

    expect(result).toEqual({ name: 'Jane' });
    expect(mockProvider.complete).toHaveBeenCalledTimes(1);
    expect(mockProvider.completeWithTools).not.toHaveBeenCalled();
  });

  test('should fall back to prompt-based when tool use fails', async () => {
    (mockProvider.completeWithTools as any).mockRejectedValue(new Error('Tool use error'));
    const completionResult: CompletionResult = {
      text: '{ "name": "Fallback" }',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.complete as any).mockResolvedValue(completionResult);

    const client = new LLMClient(mockProvider);
    const result = await client.extractJson(
      'Extract info',
      [{ role: 'user', content: 'My name is Fallback' }],
      '{ "name": "string" }',
      { model: 'test-model' },
    );

    expect(result).toEqual({ name: 'Fallback' });
  });

  test('should return empty object when tool use returns no tool calls', async () => {
    const toolResult: ToolCompletionResult = {
      toolCalls: [],
      text: 'No data found',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.completeWithTools as any).mockResolvedValue(toolResult);
    const completionResult: CompletionResult = {
      text: 'I could not find any data',
      stopReason: 'end_turn',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.complete as any).mockResolvedValue(completionResult);

    const client = new LLMClient(mockProvider);
    const result = await client.extractJson(
      'Extract info',
      [{ role: 'user', content: 'Hello' }],
      '{ "name": "string" }',
      { model: 'test-model' },
    );

    // Falls back to prompt-based, which finds no JSON
    expect(result).toEqual({});
  });

  test('should build correct tool schema from schema string', async () => {
    const toolResult: ToolCompletionResult = {
      toolCalls: [{ id: '1', name: 'extract_fields', input: { age: 25, active: true } }],
      stopReason: 'tool_use',
      model: 'test-model',
      latencyMs: 100,
    };
    (mockProvider.completeWithTools as any).mockResolvedValue(toolResult);

    const client = new LLMClient(mockProvider);
    await client.extractJson(
      'Extract info',
      [{ role: 'user', content: 'I am 25 years old and active' }],
      '{ "age": "number", "active": "boolean", "note": "string or null" }',
      { model: 'test-model' },
    );

    const call = (mockProvider.completeWithTools as any).mock.calls[0];
    const tool = call[2].tools[0];
    expect(tool.input_schema.properties.age).toEqual({ type: 'number' });
    expect(tool.input_schema.properties.active).toEqual({ type: 'boolean' });
    expect(tool.input_schema.properties.note).toEqual({ type: 'string' });
    // "note" is "string or null" so should NOT be required
    expect(tool.input_schema.required).toContain('age');
    expect(tool.input_schema.required).toContain('active');
    expect(tool.input_schema.required).not.toContain('note');
  });
});
