/**
 * Extraction Tool Call Tests
 *
 * Verifies:
 * - buildExtractionTool() generates correct JSON Schema from GatherField metadata
 * - extractEntitiesWithLLM() uses structured tool call extraction path
 * - Fallback to text parsing when LLM doesn't use the tool
 * - toolChoice passthrough to LLM client
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { RuntimeSession, ExecutorContext } from '../../services/execution/types.js';
import type { RoutingExecutor } from '../../services/execution/routing-executor.js';
import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
    currentFlowStep: 'collect_info',
    llmClient: null,
    ...overrides,
  } as RuntimeSession;
}

function createMockLLMClientWithToolCall(toolCallInput: Record<string, unknown>) {
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc-1', name: '_extract_entities', input: toolCallInput }],
      stopReason: 'tool_use',
      rawContent: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    }),
  };
}

function createMockLLMClientWithTextFallback(responseText: string) {
  return {
    chatWithToolUse: vi.fn().mockResolvedValue({
      text: responseText,
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
    }),
  };
}

function createFlowStepExecutor(): FlowStepExecutor {
  const mockCtx = {} as ExecutorContext;
  const mockRouting = {} as RoutingExecutor;
  return new FlowStepExecutor(mockCtx, mockRouting);
}

// ---------------------------------------------------------------------------
// buildExtractionTool() unit tests
// ---------------------------------------------------------------------------

describe('FlowStepExecutor.buildExtractionTool', () => {
  test('generates correct schema for string fields', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'destination', type: 'string', prompt: 'Where do you want to go?' },
      { name: 'email', type: 'email' },
    ]);

    expect(tool.name).toBe('_extract_entities');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.required).toEqual([]);

    const props = tool.input_schema.properties;
    expect(props.destination.type).toBe('string');
    expect(props.destination.description).toContain('Where do you want to go?');
    expect(props.email.type).toBe('string');
    expect(props.email.description).toContain('email');
  });

  test('generates correct schema for numeric types', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'budget', type: 'number', prompt: 'Your budget' },
      { name: 'passengers', type: 'integer', prompt: 'Number of passengers' },
    ]);

    const props = tool.input_schema.properties;
    expect(props.budget.type).toBe('number');
    expect(props.passengers.type).toBe('integer');
  });

  test('embeds range validation as minimum/maximum', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'budget',
        type: 'number',
        prompt: 'Budget',
        validation: { type: 'range', rule: '100-5000' },
      },
    ]);

    const schema = tool.input_schema.properties.budget as unknown as Record<string, unknown>;
    expect(schema.minimum).toBe(100);
    expect(schema.maximum).toBe(5000);
  });

  test('embeds enum validation', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'class',
        type: 'string',
        prompt: 'Travel class',
        validation: { type: 'enum', rule: 'economy|business|first' },
      },
    ]);

    expect(tool.input_schema.properties.class.enum).toEqual(['economy', 'business', 'first']);
  });

  test('embeds pattern validation', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'phone',
        type: 'string',
        prompt: 'Phone number',
        validation: { type: 'pattern', rule: '^\\+?[1-9]\\d{1,14}$' },
      },
    ]);

    const schema = tool.input_schema.properties.phone as unknown as Record<string, unknown>;
    expect(schema.pattern).toBe('^\\+?[1-9]\\d{1,14}$');
  });

  test('appends LLM validation to description', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'destination',
        type: 'string',
        prompt: 'Where?',
        validation: { type: 'llm', rule: 'Must be a real city name' },
      },
    ]);

    expect(tool.input_schema.properties.destination.description).toContain(
      'Constraint: Must be a real city name',
    );
  });

  test('wraps list fields in array schema', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'interests', type: 'string', prompt: 'Your interests', list: true },
    ]);

    expect(tool.input_schema.properties.interests.type).toBe('array');
    expect(tool.input_schema.properties.interests.items).toBeDefined();
  });

  test('wraps range fields in object schema with low/high', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'budget', type: 'number', prompt: 'Budget range', range: true },
    ]);

    const prop = tool.input_schema.properties.budget;
    expect(prop.type).toBe('object');
    expect(prop.properties).toBeDefined();
    expect(prop.properties!.low).toBeDefined();
    expect(prop.properties!.high).toBeDefined();
  });

  test('includes extraction hints in description', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      {
        name: 'city',
        type: 'string',
        prompt: 'Destination city',
        extraction_hints: ['city name', 'location'],
      },
    ]);

    expect(tool.input_schema.properties.city.description).toContain('hints: city name, location');
  });

  test('omits default value from field description to avoid inferred extraction', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'room_type', type: 'string', prompt: 'Room preference', default: 'standard' },
    ]);
    expect(tool.input_schema.properties.room_type.description).not.toContain('[default:');
  });

  test('omits numeric defaults from field description', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'guests', type: 'number', prompt: 'Number of guests', default: 2 },
    ]);
    expect(tool.input_schema.properties.guests.description).not.toContain('[default:');
  });

  test('omits default annotation when field has no default', () => {
    const tool = FlowStepExecutor.buildExtractionTool([
      { name: 'city', type: 'string', prompt: 'City' },
    ]);
    expect(tool.input_schema.properties.city.description).not.toContain('[default:');
  });
});

// ---------------------------------------------------------------------------
// extractEntitiesWithLLM() — tool call path
// ---------------------------------------------------------------------------

describe('extractEntitiesWithLLM — structured tool call extraction', () => {
  let executor: FlowStepExecutor;

  beforeEach(() => {
    executor = createFlowStepExecutor();
  });

  test('extracts entities via tool call response', async () => {
    const llmClient = createMockLLMClientWithToolCall({
      destination: 'Paris',
      checkin: '2025-06-15',
    });
    const session = createMockSession({ llmClient: llmClient as any });

    const result = await executor.extractEntitiesWithLLM(
      'I want to go to Paris on June 15th',
      ['destination', 'checkin'],
      session,
      undefined,
      [
        { name: 'destination', type: 'string', prompt: 'Where?' },
        { name: 'checkin', type: 'date', prompt: 'Check-in date' },
      ],
    );

    expect(result.destination).toBe('Paris');
    expect(result.checkin).toBe('2025-06-15');
  });

  test('passes toolChoice: forced tool to LLM client', async () => {
    const llmClient = createMockLLMClientWithToolCall({ name: 'John' });
    const session = createMockSession({ llmClient: llmClient as any });

    await executor.extractEntitiesWithLLM('My name is John', ['name'], session, undefined, [
      { name: 'name', type: 'string', prompt: 'Name' },
    ]);

    expect(llmClient.chatWithToolUse).toHaveBeenCalledTimes(1);
    const call = llmClient.chatWithToolUse.mock.calls[0];
    // 5th arg should be the options with toolChoice — forced to extraction tool
    expect(call[4]).toEqual({ toolChoice: { type: 'tool', name: '_extract_entities' } });
    // 3rd arg should be the extraction tool array
    expect(call[2]).toHaveLength(1);
    expect(call[2][0].name).toBe('_extract_entities');
  });

  test('falls back to text parsing when LLM does not use tool', async () => {
    const llmClient = createMockLLMClientWithTextFallback('{"email": "test@example.com"}');
    const session = createMockSession({ llmClient: llmClient as any });

    const result = await executor.extractEntitiesWithLLM(
      'my email is test@example.com',
      ['email'],
      session,
      undefined,
      [{ name: 'email', type: 'email', prompt: 'Email address' }],
    );

    expect(result.email).toBe('test@example.com');
  });

  test('handles empty tool call input gracefully', async () => {
    const llmClient = createMockLLMClientWithToolCall({});
    const session = createMockSession({ llmClient: llmClient as any });

    const result = await executor.extractEntitiesWithLLM('hello', ['name'], session, undefined, [
      { name: 'name', type: 'string', prompt: 'Name' },
    ]);

    expect(result.name).toBeUndefined();
  });

  test('emits extractionMethod: tool_call in trace event', async () => {
    const llmClient = createMockLLMClientWithToolCall({ name: 'Alice' });
    const session = createMockSession({ llmClient: llmClient as any });
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    await executor.extractEntitiesWithLLM(
      'I am Alice',
      ['name'],
      session,
      (e) => traceEvents.push(e),
      [{ name: 'name', type: 'string', prompt: 'Name' }],
    );

    const llmCallEvent = traceEvents.find((e) => e.type === 'llm_call');
    expect(llmCallEvent).toBeDefined();
    expect(llmCallEvent!.data.extractionMethod).toBe('tool_call');
  });

  test('does not expose gather defaults to the extraction prompt or tool schema', async () => {
    const llmClient = createMockLLMClientWithToolCall({});
    const session = createMockSession({ llmClient: llmClient as any });

    await executor.extractEntitiesWithLLM(
      'Book me a hotel in Rome',
      ['room_type'],
      session,
      undefined,
      [{ name: 'room_type', type: 'string', prompt: 'Room preference', default: 'standard' }],
    );

    expect(llmClient.chatWithToolUse).toHaveBeenCalledTimes(1);
    const call = llmClient.chatWithToolUse.mock.calls[0];
    const systemPrompt = call[0] as string;
    const tools = call[2] as Array<{
      input_schema: {
        properties: Record<string, { description?: string }>;
      };
    }>;

    expect(systemPrompt).not.toContain('[default:');
    expect(systemPrompt).not.toContain('standard');
    expect(systemPrompt).toContain('(extract if stated)');
    expect(systemPrompt).not.toContain('(REQUIRED)');
    expect(tools[0].input_schema.properties.room_type.description).not.toContain('[default:');
  });
});
