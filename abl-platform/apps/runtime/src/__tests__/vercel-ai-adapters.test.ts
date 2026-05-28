/**
 * Vercel AI SDK Type Adapters Tests
 *
 * Tests for message and tool conversion between ABL platform types
 * and Vercel AI SDK types.
 */

import { describe, test, expect } from 'vitest';
import { convertMessages, convertTools } from '../services/llm/vercel-ai-adapters';
import type { Message, ToolDefinition } from '@abl/compiler/platform/llm/types';

// =============================================================================
// convertMessages
// =============================================================================

describe('convertMessages', () => {
  test('should convert simple text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'system', content: 'You are helpful' },
    ];

    const result = convertMessages(messages);

    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'system', content: 'You are helpful' },
    ]);
  });

  test('should convert messages with text blocks', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'How are you?' },
        ],
      },
    ];

    const result = convertMessages(messages);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'How are you?' },
    ]);
  });

  test('should convert image messages with base64', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'aGVsbG8=', // "hello" in base64
            },
          },
        ],
      },
    ];

    const result = convertMessages(messages);
    const content = result[0].content as any[];

    expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(content[1].type).toBe('image');
    expect(content[1].image).toBeInstanceOf(Buffer);
    expect(content[1].image.toString()).toBe('hello');
  });

  test('should convert image messages with URL', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/image.jpg',
            },
          },
        ],
      },
    ];

    const result = convertMessages(messages);
    const content = result[0].content as any[];

    expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(content[1]).toEqual({
      type: 'image',
      image: 'https://example.com/image.jpg',
    });
  });

  test('should convert tool_use blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check that' },
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'get_weather',
            input: { location: 'SF', units: 'celsius' },
          },
        ],
      },
    ];

    const result = convertMessages(messages);
    const content = result[0].content as any[];

    expect(content[0]).toEqual({ type: 'text', text: 'Let me check that' });
    expect(content[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'call_123',
      toolName: 'get_weather',
      input: { location: 'SF', units: 'celsius' },
    });
  });

  test('should convert tool_result blocks with string content', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: 'Sunny, 72°F',
          },
        ],
      },
    ];

    const result = convertMessages(messages);
    const content = result[0].content as any[];

    expect(content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'call_123',
      toolName: 'call_123', // no prior tool_use, falls back to toolCallId
      output: { type: 'text', value: 'Sunny, 72°F' },
    });
  });

  test('should convert tool_result blocks with object content', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: { temperature: 72, conditions: 'sunny' },
          },
        ],
      },
    ];

    const result = convertMessages(messages);
    const content = result[0].content as any[];

    expect(content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'call_123',
      toolName: 'call_123', // no prior tool_use, falls back to toolCallId
      output: { type: 'json', value: { temperature: 72, conditions: 'sunny' } },
    });
  });

  test('should handle multi-turn conversation with tools', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What is the weather in SF?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check that for you' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'get_weather',
            input: { location: 'SF' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'Sunny, 72°F',
          },
        ],
      },
      {
        role: 'assistant',
        content: 'The weather in SF is sunny and 72°F.',
      },
    ];

    const result = convertMessages(messages);

    expect(result).toHaveLength(4);
    expect(result[0].content).toBe('What is the weather in SF?');
    expect(result[3].content).toBe('The weather in SF is sunny and 72°F.');
  });
});

// =============================================================================
// convertTools
// =============================================================================

describe('convertTools', () => {
  test('should convert simple tool definition', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Get weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('get_weather');
    expect(result.get_weather.description).toBe('Get weather for a location');
    expect(result.get_weather.inputSchema).toBeDefined();
  });

  test('should convert tool with optional fields', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Get weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
            units: { type: 'string' },
          },
          required: ['location'],
        },
      },
    ];

    const result = convertTools(tools);
    const schema = result.get_weather.inputSchema;

    expect(schema).toBeDefined();
    // Zod schema should handle optional fields correctly
  });

  test('should convert tool with enum field', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'set_temperature',
        description: 'Set temperature',
        input_schema: {
          type: 'object',
          properties: {
            units: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature units',
            },
          },
          required: ['units'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('set_temperature');
    expect(result.set_temperature.inputSchema).toBeDefined();
  });

  test('should convert tool with number fields', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'calculate',
        description: 'Perform calculation',
        input_schema: {
          type: 'object',
          properties: {
            a: { type: 'number', minimum: 0, maximum: 100 },
            b: { type: 'integer', minimum: 1 },
          },
          required: ['a', 'b'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('calculate');
    expect(result.calculate.inputSchema).toBeDefined();
  });

  test('should convert tool with boolean field', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'toggle_feature',
        description: 'Toggle feature',
        input_schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable or disable' },
          },
          required: ['enabled'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('toggle_feature');
    expect(result.toggle_feature.inputSchema).toBeDefined();
  });

  test('should convert tool with array field', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'search',
        description: 'Search items',
        input_schema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 10,
            },
          },
          required: ['tags'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('search');
    expect(result.search.inputSchema).toBeDefined();
  });

  test('should convert tool with nested object', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'create_user',
        description: 'Create a user',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
                zip: { type: 'string' },
              },
              required: ['city'],
            },
          },
          required: ['name', 'address'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('create_user');
    expect(result.create_user.inputSchema).toBeDefined();
  });

  test('preserves unknown keys for partially specified object params', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'direct_nested_lookup',
        description: 'Lookup with partially specified nested filters',
        input_schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'object',
              properties: {
                region: { type: 'string' },
                nested: { type: 'object' },
              },
            },
          },
          required: ['filter'],
        },
      },
    ];

    const result = convertTools(tools);
    const parsed = result.direct_nested_lookup.inputSchema.parse({
      filter: {
        region: 'us-east',
        nested: { vip: true, tags: ['priority', 'renewal'] },
      },
    }) as { filter: Record<string, unknown> };

    expect(parsed.filter).toEqual({
      region: 'us-east',
      nested: { vip: true, tags: ['priority', 'renewal'] },
    });
  });

  test('preserves payload for opaque object params without declared sub-properties', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'opaque_filter_tool',
        description: 'Tool with opaque object input',
        input_schema: {
          type: 'object',
          properties: {
            filter: { type: 'object' },
          },
          required: ['filter'],
        },
      },
    ];

    const result = convertTools(tools);
    const parsed = result.opaque_filter_tool.inputSchema.parse({
      filter: {
        region: 'us-east',
        nested: { vip: true, tags: ['priority', 'renewal'] },
      },
    }) as { filter: Record<string, unknown> };

    expect(parsed.filter).toEqual({
      region: 'us-east',
      nested: { vip: true, tags: ['priority', 'renewal'] },
    });
  });

  test('should convert multiple tools', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
      {
        name: 'get_time',
        description: 'Get time',
        input_schema: {
          type: 'object',
          properties: { timezone: { type: 'string' } },
          required: ['timezone'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('get_weather');
    expect(result).toHaveProperty('get_time');
    expect(Object.keys(result)).toHaveLength(2);
  });

  test('should handle string constraints', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'validate_input',
        description: 'Validate input',
        input_schema: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$',
            },
            name: {
              type: 'string',
              minLength: 2,
              maxLength: 50,
            },
          },
          required: ['email', 'name'],
        },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveProperty('validate_input');
    expect(result.validate_input.inputSchema).toBeDefined();
  });
});
