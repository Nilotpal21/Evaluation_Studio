/**
 * Context Access Tests (D1 read injection + D2 write whitelist)
 *
 * D1: Before tool execution, if a tool has `context_access.read: ['user_location']`,
 *     the runtime injects `_context: { user_location: 'NYC' }` into the tool's params
 *     when session.data.values contains that key.
 *
 * D2: After tool execution, if the tool returns `context_updates: { last_check: '...' }`
 *     and the tool has `context_access.write: ['last_check']`, the value is applied to
 *     session.data.values. Keys NOT in the whitelist are silently dropped.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT
// =============================================================================

class MockLLMClient {
  private responseHandler: (
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
    usage?: { input_tokens: number; output_tokens: number };
    resolvedModel?: { modelId: string; provider: string; source: string };
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Done.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
  ) {
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockLLMClient {
  const mock = new MockLLMClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) {
      session.llmClient = mock;
    }
  };
  return mock;
}

// =============================================================================
// ABL FIXTURE
// =============================================================================

const AGENT_WITH_TOOL = `
AGENT: CtxAgent

GOAL: "Test agent for context access"

PERSONA: "Helpful assistant"

TOOLS:
  check_weather(city: string) -> {forecast: string}
    description: "Check weather for a city"
`;

// =============================================================================
// HELPERS
// =============================================================================

/** Build a one-shot LLM handler: call 1 triggers a tool, call 2 returns final text. */
function oneToolCallThenDone(
  toolName: string,
  toolInput: Record<string, unknown>,
): (
  systemPrompt: string,
  messages: Array<{ role: string; content: unknown }>,
  tools: unknown[],
) => any {
  let callCount = 0;
  return (_sys, _msgs, tools) => {
    // Entity extraction pass — return empty extraction
    if ((tools as any[]).some((t: any) => t.name === '_extract_entities')) {
      return {
        text: '',
        toolCalls: [{ id: 'extract-1', name: '_extract_entities', input: {} }],
        stopReason: 'tool_use',
        rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input: {} }],
      };
    }
    callCount++;
    if (callCount === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'tc-1', name: toolName, input: toolInput }],
        stopReason: 'tool_use',
        rawContent: [{ type: 'tool_use', id: 'tc-1', name: toolName, input: toolInput }],
      };
    }
    return {
      text: 'All done.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'All done.' }],
    };
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Context Access (D1 read injection, D2 write whitelist)', () => {
  let executor: RuntimeExecutor;
  let mockClient: MockLLMClient;

  beforeEach(() => {
    executor = new RuntimeExecutor();
    mockClient = injectMockClient(executor);
  });

  // ===========================================================================
  // D1-1: Tool with context_access.read receives _context in params
  // ===========================================================================

  test('D1: tool with context_access.read receives _context with session values', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_TOOL], 'CtxAgent'),
    );

    // Seed session with a value the tool should receive
    session.data.values.user_location = 'NYC';

    // Patch the tool IR to declare context_access.read
    const toolIR = session.agentIR!.tools!.find((t) => t.name === 'check_weather');
    toolIR!.context_access = { read: ['user_location'], write: [] };

    // Capture the params passed to the tool executor
    let capturedParams: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, params: Record<string, unknown>) => {
        capturedParams = params;
        return { forecast: 'sunny' };
      },
    } as any;

    mockClient.setResponseHandler(oneToolCallThenDone('check_weather', { city: 'NYC' }));

    await executor.executeMessage(session.id, 'What is the weather?');

    // The executor should have injected _context into the tool params
    expect(capturedParams).toBeDefined();
    expect(capturedParams!._context).toEqual({ user_location: 'NYC' });
  });

  // ===========================================================================
  // D1-2: Tool WITHOUT context_access does NOT receive _context
  // ===========================================================================

  test('D1: tool without context_access does NOT receive _context', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_TOOL], 'CtxAgent'),
    );

    session.data.values.user_location = 'NYC';

    // No context_access on the tool IR (default after compilation)

    let capturedParams: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, params: Record<string, unknown>) => {
        capturedParams = params;
        return { forecast: 'cloudy' };
      },
    } as any;

    mockClient.setResponseHandler(oneToolCallThenDone('check_weather', { city: 'NYC' }));

    await executor.executeMessage(session.id, 'What is the weather?');

    expect(capturedParams).toBeDefined();
    expect(capturedParams!._context).toBeUndefined();
  });

  // ===========================================================================
  // D2-1: Valid key in write whitelist is applied to session.data.values
  // ===========================================================================

  test('D2: context_updates key in write whitelist is applied to session values', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_TOOL], 'CtxAgent'),
    );

    // Patch the tool IR to declare context_access.write
    const toolIR = session.agentIR!.tools!.find((t) => t.name === 'check_weather');
    toolIR!.context_access = { read: [], write: ['last_check'] };

    // The tool executor returns context_updates with a whitelisted key
    session.toolExecutor = {
      execute: async () => ({
        forecast: 'rainy',
        context_updates: { last_check: '2026-03-06T10:00:00Z' },
      }),
    } as any;

    mockClient.setResponseHandler(oneToolCallThenDone('check_weather', { city: 'London' }));

    await executor.executeMessage(session.id, 'Check London weather');

    expect(session.data.values.last_check).toBe('2026-03-06T10:00:00Z');
  });

  // ===========================================================================
  // D2-2: Key NOT in write whitelist is silently dropped
  // ===========================================================================

  test('D2: context_updates key NOT in write whitelist is silently dropped', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_TOOL], 'CtxAgent'),
    );

    // Whitelist only allows 'last_check', not 'secret_key'
    const toolIR = session.agentIR!.tools!.find((t) => t.name === 'check_weather');
    toolIR!.context_access = { read: [], write: ['last_check'] };

    session.toolExecutor = {
      execute: async () => ({
        forecast: 'windy',
        context_updates: {
          last_check: '2026-03-06T12:00:00Z',
          secret_key: 'should-be-dropped',
        },
      }),
    } as any;

    mockClient.setResponseHandler(oneToolCallThenDone('check_weather', { city: 'Paris' }));

    await executor.executeMessage(session.id, 'Check Paris weather');

    // Whitelisted key is applied
    expect(session.data.values.last_check).toBe('2026-03-06T12:00:00Z');

    // Non-whitelisted key is NOT applied
    expect(session.data.values.secret_key).toBeUndefined();
  });

  test('message metadata is available during the turn and cleaned up afterward', async () => {
    const metadata = {
      locale: 'en-US',
      context: { plan: 'enterprise' },
    };
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([AGENT_WITH_TOOL], 'CtxAgent'),
    );

    const toolIR = session.agentIR!.tools!.find((t) => t.name === 'check_weather');
    toolIR!.context_access = { read: ['message_metadata'], write: [] };

    let capturedParams: Record<string, unknown> | undefined;
    let capturedSessionNamespace: unknown;
    session.toolExecutor = {
      execute: async (_name: string, params: Record<string, unknown>) => {
        capturedParams = params;
        capturedSessionNamespace = (session.data.values.session as Record<string, unknown>)
          .messageMetadata;
        return { forecast: 'sunny' };
      },
    } as any;

    mockClient.setResponseHandler(oneToolCallThenDone('check_weather', { city: 'NYC' }));

    await executor.executeMessage(session.id, 'What is the weather?', undefined, undefined, {
      messageMetadata: metadata,
    });

    expect(capturedParams?._context).toEqual({ message_metadata: metadata });
    expect(capturedSessionNamespace).toEqual(metadata);
    expect(session.data.values.message_metadata).toBeUndefined();
    expect(
      (session.data.values.session as Record<string, unknown>).messageMetadata,
    ).toBeUndefined();
  });
});
