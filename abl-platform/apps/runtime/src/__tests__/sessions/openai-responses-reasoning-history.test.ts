import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ToolDefinition } from '@abl/compiler/platform/llm/types.js';

const mockStreamText = vi.fn();
const mockGenerateText = vi.fn();
const mockCreateVercelProvider = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

vi.mock('@agent-platform/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/llm')>();
  return {
    ...actual,
    createVercelProvider: (...args: unknown[]) => mockCreateVercelProvider(...args),
  };
});

vi.mock('../../config/index.js', () => ({
  isConfigLoaded: () => true,
  getConfig: () => ({
    llm: { litellmProxyUrl: '' },
    llmCache: {
      providerCacheMax: 100,
      providerCacheTtlSeconds: 600,
    },
  }),
}));

vi.mock('../../observability/metrics.js', () => ({
  recordLlmCall: vi.fn(),
}));

import { SessionLLMClient, clearProviderCache } from '../../services/llm/session-llm-client.js';
import type { ModelResolutionService } from '../../services/llm/model-resolution.js';

const lookupOrderTool: ToolDefinition = {
  name: 'lookup_order',
  description: 'Look up an order',
  input_schema: {
    type: 'object',
    properties: {
      orderId: { type: 'string', description: 'Order id' },
    },
    required: ['orderId'],
  },
};

function createOpenAIResolution(): ModelResolutionService {
  return {
    resolve: vi.fn().mockResolvedValue({
      modelId: 'openai/gpt-5',
      provider: 'openai',
      source: 'tenant_model',
      credential: { apiKey: 'test-key-123', endpoint: undefined, authType: 'api_key' },
      parameters: { maxTokens: 2048, reasoningEffort: 'medium' },
      useResponsesApi: true,
      useStreaming: true,
    }),
    resolveReasoningSettings: vi.fn(),
  } as unknown as ModelResolutionService;
}

function createClient(): SessionLLMClient {
  return new SessionLLMClient(createOpenAIResolution(), {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentName: 'responses-agent',
    sessionId: 'session-1',
  });
}

function createTextStream(chunks: string[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createStreamResult(options: {
  text?: string;
  content?: unknown[];
  toolCalls?: unknown[];
  providerMetadata?: Record<string, unknown>;
}) {
  return {
    textStream: createTextStream(options.text ? [options.text] : []),
    text: Promise.resolve(options.text ?? ''),
    content: Promise.resolve(options.content ?? []),
    toolCalls: Promise.resolve(options.toolCalls ?? []),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve((options.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop'),
    providerMetadata: Promise.resolve(options.providerMetadata),
  };
}

describe('SessionLLMClient OpenAI Responses reasoning history', () => {
  beforeEach(() => {
    clearProviderCache();
    mockGenerateText.mockReset();
    mockStreamText.mockReset();
    mockCreateVercelProvider.mockReset();
    mockCreateVercelProvider.mockReturnValue({ modelId: 'openai/gpt-5' });
  });

  it('serializes preserved reasoning items adjacent to their function calls when no previous response id is available', async () => {
    mockStreamText
      .mockReturnValueOnce(
        createStreamResult({
          content: [
            {
              type: 'reasoning',
              text: 'Need to inspect the order before answering.',
              providerMetadata: {
                openai: { itemId: 'rs_lookup', reasoningEncryptedContent: 'encrypted-reasoning' },
              },
            },
            {
              type: 'tool-call',
              toolCallId: 'call_lookup',
              toolName: 'lookup_order',
              input: { orderId: 'O-123' },
              providerMetadata: { openai: { itemId: 'fc_lookup' } },
            },
          ],
          toolCalls: [
            {
              type: 'tool-call',
              toolCallId: 'call_lookup',
              toolName: 'lookup_order',
              input: { orderId: 'O-123' },
              providerMetadata: { openai: { itemId: 'fc_lookup' } },
            },
          ],
        }),
      )
      .mockReturnValueOnce(createStreamResult({ text: 'It shipped yesterday.' }));

    const client = createClient();
    const first = await client.chatWithToolUseStreamable(
      'system prompt',
      [{ role: 'user', content: 'Where is order O-123?' }],
      [lookupOrderTool],
      'response_gen',
      () => undefined,
    );

    expect(first.rawContent).toEqual([
      {
        type: 'reasoning',
        text: 'Need to inspect the order before answering.',
        providerMetadata: {
          openai: { itemId: 'rs_lookup', reasoningEncryptedContent: 'encrypted-reasoning' },
        },
      },
      {
        type: 'tool_use',
        id: 'call_lookup',
        name: 'lookup_order',
        input: { orderId: 'O-123' },
        providerMetadata: { openai: { itemId: 'fc_lookup' } },
      },
    ]);

    const history: Message[] = [
      { role: 'user', content: 'Where is order O-123?' },
      { role: 'assistant', content: first.rawContent },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_lookup',
            content: '{"status":"shipped"}',
          },
        ],
      },
      { role: 'user', content: 'Any update?' },
    ];

    await client.chatWithToolUseStreamable(
      'system prompt',
      history,
      [lookupOrderTool],
      'response_gen',
      () => undefined,
    );

    const secondCall = mockStreamText.mock.calls[1][0] as { messages: unknown[] };
    expect(secondCall.messages).toEqual([
      { role: 'user', content: 'Where is order O-123?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Need to inspect the order before answering.',
            providerOptions: {
              openai: { itemId: 'rs_lookup', reasoningEncryptedContent: 'encrypted-reasoning' },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_lookup',
            toolName: 'lookup_order',
            input: { orderId: 'O-123' },
            providerOptions: { openai: { itemId: 'fc_lookup' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_lookup',
            toolName: 'lookup_order',
            output: { type: 'json', value: { status: 'shipped' } },
          },
        ],
      },
      { role: 'user', content: 'Any update?' },
    ]);
  });

  it('uses previousResponseId and prunes replayed reasoning/function-call items when response id metadata exists', async () => {
    mockStreamText
      .mockReturnValueOnce(
        createStreamResult({
          content: [
            {
              type: 'reasoning',
              text: '',
              providerMetadata: {
                openai: { itemId: 'rs_lookup', reasoningEncryptedContent: 'encrypted-reasoning' },
              },
            },
            {
              type: 'tool-call',
              toolCallId: 'call_lookup',
              toolName: 'lookup_order',
              input: { orderId: 'O-123' },
              providerMetadata: { openai: { itemId: 'fc_lookup' } },
            },
          ],
          toolCalls: [
            {
              type: 'tool-call',
              toolCallId: 'call_lookup',
              toolName: 'lookup_order',
              input: { orderId: 'O-123' },
              providerMetadata: { openai: { itemId: 'fc_lookup' } },
            },
          ],
          providerMetadata: { openai: { responseId: 'resp_lookup' } },
        }),
      )
      .mockReturnValueOnce(createStreamResult({ text: 'It shipped yesterday.' }));

    const client = createClient();
    const first = await client.chatWithToolUseStreamable(
      'system prompt',
      [{ role: 'user', content: 'Where is order O-123?' }],
      [lookupOrderTool],
      'response_gen',
      () => undefined,
    );

    const history: Message[] = [
      { role: 'user', content: 'Where is order O-123?' },
      { role: 'assistant', content: first.rawContent },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_lookup',
            content: '{"status":"shipped"}',
          },
        ],
      },
      { role: 'user', content: 'Any update?' },
    ];

    await client.chatWithToolUseStreamable(
      'system prompt',
      history,
      [lookupOrderTool],
      'response_gen',
      () => undefined,
    );

    const secondCall = mockStreamText.mock.calls[1][0] as {
      messages: unknown[];
      providerOptions?: unknown;
    };
    expect(secondCall.providerOptions).toEqual({
      openai: {
        reasoningEffort: 'medium',
        store: true,
        previousResponseId: 'resp_lookup',
      },
    });
    expect(secondCall.messages).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_lookup',
            toolName: 'lookup_order',
            output: { type: 'json', value: { status: 'shipped' } },
          },
        ],
      },
      { role: 'user', content: 'Any update?' },
    ]);
  });
});
