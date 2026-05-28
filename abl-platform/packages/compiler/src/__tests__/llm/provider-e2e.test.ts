/**
 * Provider E2E Tests — Representative Coverage
 *
 * NOTE: These tests are SKIPPED as of the Vercel AI SDK migration.
 * The custom provider implementations (createProvider, AnthropicProvider, etc.)
 * have been removed. Provider instantiation now happens in the runtime layer
 * using Vercel AI SDK packages (@ai-sdk/*).
 *
 * For runtime-level provider E2E tests, see:
 * - apps/runtime/src/__tests__/vercel-ai-adapters.test.ts
 * - apps/runtime/src/__tests__/llm-integration.test.ts
 *
 * Original environment variables (preserved for reference):
 *   OPENAI_API_KEY     — OpenAI (gpt-4o-mini, o3-mini)
 *   ANTHROPIC_API_KEY  — Anthropic (claude-3-5-haiku, claude-haiku-4-5)
 *   GOOGLE_AI_API_KEY  — Gemini AI Studio (gemini-2.0-flash, gemini-2.5-flash)
 *   VERTEX_ACCESS_TOKEN + VERTEX_PROJECT_ID — Vertex AI (gemini-2.0-flash)
 *   AZURE_OPENAI_API_KEY + AZURE_OPENAI_RESOURCE + AZURE_OPENAI_DEPLOYMENT — Azure OpenAI
 *   COHERE_API_KEY     — Cohere (command-r)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import type { LLMProvider, ToolDefinition, StreamEvent } from '../../platform/llm/types.js';

// Skip all tests — createProvider() is deprecated post Vercel AI SDK migration
const SKIP_REASON =
  'Provider E2E tests are skipped: createProvider() was removed in the Vercel AI SDK migration. ' +
  'See apps/runtime/src/__tests__/ for runtime-level integration tests.';

// Stub createProvider — returns a no-op provider so beforeAll() doesn't throw
// when API keys happen to be set in the environment. All individual tests are
// guarded with skipIfNoKey and will never call the provider methods.
// The real createProvider() was removed in the Vercel AI SDK migration.
function createProvider(_config: any): LLMProvider {
  return {
    complete: async () => {
      throw new Error(SKIP_REASON);
    },
    stream: async function* () {
      throw new Error(SKIP_REASON);
    },
  } as unknown as LLMProvider;
}

// createProvider is permanently removed — force-skip all tests regardless of env keys
const PROVIDER_REMOVED = true;

// =============================================================================
// CONSTANTS
// =============================================================================

const STANDARD_TIMEOUT_MS = 30_000;
const REASONING_TIMEOUT_MS = 60_000;

const SIMPLE_PROMPT = 'You are a helpful assistant. Reply in one short sentence.';
const TOOL_PROMPT =
  'You are a weather assistant. Always use the get_weather tool when asked about weather.';

const WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a location',
  input_schema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
};

// =============================================================================
// HELPERS
// =============================================================================

/** Collect all text_delta chunks and check for message_end in a stream */
async function collectStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<{ chunks: string[]; gotMessageEnd: boolean; events: StreamEvent[] }> {
  const chunks: string[] = [];
  const events: StreamEvent[] = [];
  let gotMessageEnd = false;

  for await (const event of stream) {
    events.push(event);
    if (event.type === 'text_delta') {
      chunks.push(event.text);
    }
    if (event.type === 'message_end') {
      gotMessageEnd = true;
    }
  }

  return { chunks, gotMessageEnd, events };
}

/** Assert standard tool call result shape */
function assertToolCallResult(
  result: {
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
  },
  label: string,
) {
  expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);

  const call = result.toolCalls.find((tc) => tc.name === 'get_weather');
  expect(call).toBeDefined();
  expect(call!.input).toHaveProperty('location');

  console.log(`[E2E] ${label} tools: ${call!.name}(${JSON.stringify(call!.input)})`);
}

/** Assert standard streaming tool use events */
function assertStreamToolEvents(events: StreamEvent[], label: string) {
  const toolStart = events.find((e) => e.type === 'tool_use_start');
  const toolEnd = events.find((e) => e.type === 'tool_use_end');
  const messageEnd = events.find((e) => e.type === 'message_end');

  expect(toolStart).toBeDefined();
  expect((toolStart as any).name).toBe('get_weather');

  expect(toolEnd).toBeDefined();
  expect((toolEnd as any).input).toHaveProperty('location');

  expect(messageEnd).toBeDefined();

  console.log(
    `[E2E] ${label} tools stream: ${events.length} events, tool=${(toolStart as any).name}`,
  );
}

// =============================================================================
// OPENAI
// =============================================================================

describe('OpenAI', () => {
  const API_KEY = process.env.OPENAI_API_KEY;
  const skipIfNoKey = PROVIDER_REMOVED || !API_KEY ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!API_KEY) return;
    provider = createProvider({ provider: 'openai', apiKey: API_KEY });
  });

  describe('standard chat (gpt-4o-mini)', () => {
    const MODEL = 'gpt-4o-mini';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] OpenAI chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] OpenAI stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('reasoning (o3-mini)', () => {
    const MODEL = 'o3-mini';

    skipIfNoKey(
      'non-streaming — uses maxCompletionTokens, no temperature',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          {
            model: MODEL,
            maxCompletionTokens: 1000,
            timeoutMs: REASONING_TIMEOUT_MS,
          },
        );

        expect(result.text).toBeTruthy();
        expect(result.usage).toBeDefined();
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] OpenAI reasoning: "${result.text.substring(0, 80)}" (${result.usage!.outputTokens} output tokens)`,
        );
      },
      REASONING_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(SIMPLE_PROMPT, [{ role: 'user', content: 'What is 2+2?' }], {
            model: MODEL,
            maxCompletionTokens: 1000,
            timeoutMs: REASONING_TIMEOUT_MS,
          }),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] OpenAI reasoning stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      REASONING_TIMEOUT_MS,
    );
  });

  describe('tool use (gpt-4o-mini)', () => {
    const MODEL = 'gpt-4o-mini';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Tokyo?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        expect(result.stopReason).toBe('tool_use');
        assertToolCallResult(result, 'OpenAI');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in Berlin.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'OpenAI');
      },
      STANDARD_TIMEOUT_MS,
    );
  });
});

// =============================================================================
// ANTHROPIC
// =============================================================================

describe('Anthropic', () => {
  const API_KEY = process.env.ANTHROPIC_API_KEY;
  const skipIfNoKey = PROVIDER_REMOVED || !API_KEY ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!API_KEY) return;
    provider = createProvider({ provider: 'anthropic', apiKey: API_KEY });
  });

  describe('standard chat (claude-3-5-haiku)', () => {
    const MODEL = 'claude-3-5-haiku-20241022';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] Anthropic chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Anthropic stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('tool use (claude-3-5-haiku)', () => {
    const MODEL = 'claude-3-5-haiku-20241022';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Paris?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        expect(result.stopReason).toBe('tool_use');
        assertToolCallResult(result, 'Anthropic');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in London.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'Anthropic');
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('thinking (claude-haiku-4-5 + thinking)', () => {
    // claude-3-5-haiku does NOT support thinking; need Claude 3.7+ or Haiku 4.5+
    const MODEL = 'claude-haiku-4-5-20251001';

    skipIfNoKey(
      'non-streaming — enableThinking + thinkingBudget → thinkingContent',
      async () => {
        const result = await provider.complete(
          'You are a helpful assistant.',
          [{ role: 'user', content: 'What is 2+2?' }],
          {
            model: MODEL,
            maxTokens: 1024,
            enableThinking: true,
            thinkingBudget: 5000,
            timeoutMs: REASONING_TIMEOUT_MS,
          },
        );

        expect(result.text).toBeTruthy();
        expect(result.thinkingContent).toBeTruthy();
        expect(result.usage).toBeDefined();

        console.log(
          `[E2E] Anthropic thinking: text="${result.text.substring(0, 60)}" thinking=${result.thinkingContent!.length} chars`,
        );
      },
      REASONING_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming — thinking events',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            'You are a helpful assistant.',
            [{ role: 'user', content: 'What is 2+2?' }],
            {
              model: MODEL,
              maxTokens: 1024,
              enableThinking: true,
              thinkingBudget: 5000,
              timeoutMs: REASONING_TIMEOUT_MS,
            },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Anthropic thinking stream: "${fullText.substring(0, 60)}" (${chunks.length} chunks)`,
        );
      },
      REASONING_TIMEOUT_MS,
    );
  });
});

// =============================================================================
// GEMINI
// =============================================================================

describe('Gemini', () => {
  const API_KEY = process.env.GOOGLE_AI_API_KEY;
  const skipIfNoKey = PROVIDER_REMOVED || !API_KEY ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!API_KEY) return;
    provider = createProvider({ provider: 'gemini', apiKey: API_KEY });
  });

  describe('standard chat (gemini-2.0-flash)', () => {
    const MODEL = 'gemini-2.0-flash';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] Gemini chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Gemini stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('tool use (gemini-2.0-flash)', () => {
    const MODEL = 'gemini-2.0-flash';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Sydney?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        assertToolCallResult(result, 'Gemini');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in Rome.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'Gemini');
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('thinking budget (gemini-2.5-flash)', () => {
    const MODEL = 'gemini-2.5-flash';

    skipIfNoKey(
      'non-streaming — thinkingBudget accepted without error',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          {
            model: MODEL,
            maxTokens: 200,
            thinkingBudget: 5000,
            timeoutMs: REASONING_TIMEOUT_MS,
          },
        );

        expect(result.text).toBeTruthy();
        expect(result.usage).toBeDefined();

        console.log(
          `[E2E] Gemini thinking: "${result.text.substring(0, 80)}" (${result.usage!.outputTokens} output tokens)`,
        );
      },
      REASONING_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming — thinkingBudget accepted without error',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(SIMPLE_PROMPT, [{ role: 'user', content: 'What is 2+2?' }], {
            model: MODEL,
            maxTokens: 200,
            thinkingBudget: 5000,
            timeoutMs: REASONING_TIMEOUT_MS,
          }),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Gemini thinking stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      REASONING_TIMEOUT_MS,
    );
  });
});

// =============================================================================
// VERTEX AI
// =============================================================================

describe('Vertex AI', () => {
  const API_KEY = process.env.VERTEX_API_KEY;
  const ACCESS_TOKEN = process.env.VERTEX_ACCESS_TOKEN;
  const PROJECT_ID = process.env.VERTEX_PROJECT_ID;
  const REGION = process.env.VERTEX_REGION || 'us-central1';
  const canRun = !!((API_KEY || ACCESS_TOKEN) && PROJECT_ID);
  const skipIfNoKey = PROVIDER_REMOVED || !canRun ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!canRun) return;
    provider = createProvider({
      provider: 'vertex',
      projectId: PROJECT_ID!,
      region: REGION,
      // API key auth (query param) or OAuth2 Bearer token
      ...(ACCESS_TOKEN ? { accessToken: ACCESS_TOKEN } : { apiKey: API_KEY }),
    });
  });

  describe('standard chat (gemini-2.0-flash)', () => {
    const MODEL = 'gemini-2.0-flash';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] Vertex chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Vertex stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('tool use (gemini-2.0-flash)', () => {
    const MODEL = 'gemini-2.0-flash';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Mumbai?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        assertToolCallResult(result, 'Vertex');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in Seoul.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'Vertex');
      },
      STANDARD_TIMEOUT_MS,
    );
  });
});

// =============================================================================
// AZURE OPENAI
// =============================================================================

describe('Azure OpenAI', () => {
  const API_KEY = process.env.AZURE_OPENAI_API_KEY;
  const RESOURCE = process.env.AZURE_OPENAI_RESOURCE;
  const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
  const API_VERSION = process.env.AZURE_OPENAI_API_VERSION;
  const canRun = !!(API_KEY && RESOURCE && DEPLOYMENT);
  const skipIfNoKey = PROVIDER_REMOVED || !canRun ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!canRun) return;
    provider = createProvider({
      provider: 'azure',
      apiKey: API_KEY!,
      resourceName: RESOURCE!,
      deploymentName: DEPLOYMENT!,
      ...(API_VERSION && { apiVersion: API_VERSION }),
    });
  });

  // Azure model is determined by the deployment; the model hint is for capabilities lookup
  const MODEL = process.env.AZURE_OPENAI_MODEL || 'gpt-4.1';

  describe('standard chat', () => {
    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.stopReason).toBe('end_turn');
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] Azure chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(`[E2E] Azure stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`);
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('tool use', () => {
    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Chicago?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        expect(result.stopReason).toBe('tool_use');
        assertToolCallResult(result, 'Azure');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in Madrid.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'Azure');
      },
      STANDARD_TIMEOUT_MS,
    );
  });
});

// =============================================================================
// COHERE
// =============================================================================

describe('Cohere', () => {
  const API_KEY = process.env.COHERE_API_KEY;
  const skipIfNoKey = PROVIDER_REMOVED || !API_KEY ? test.skip : test;
  let provider: LLMProvider;

  beforeAll(() => {
    if (!API_KEY) return;
    provider = createProvider({ provider: 'cohere', apiKey: API_KEY });
  });

  describe('standard chat (command-r)', () => {
    const MODEL = 'command-r';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.complete(
          SIMPLE_PROMPT,
          [{ role: 'user', content: 'What is 2+2?' }],
          { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
        );

        expect(result.text).toBeTruthy();
        expect(result.usage).toBeDefined();
        expect(result.usage!.inputTokens).toBeGreaterThan(0);
        expect(result.usage!.outputTokens).toBeGreaterThan(0);

        console.log(
          `[E2E] Cohere chat: "${result.text.substring(0, 80)}" (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { chunks, gotMessageEnd } = await collectStream(
          provider.streamComplete(
            SIMPLE_PROMPT,
            [{ role: 'user', content: 'Name three colors.' }],
            { model: MODEL, maxTokens: 100, timeoutMs: STANDARD_TIMEOUT_MS },
          ),
        );

        const fullText = chunks.join('');
        expect(fullText).toBeTruthy();
        expect(chunks.length).toBeGreaterThan(1);
        expect(gotMessageEnd).toBe(true);

        console.log(
          `[E2E] Cohere stream: "${fullText.substring(0, 80)}" (${chunks.length} chunks)`,
        );
      },
      STANDARD_TIMEOUT_MS,
    );
  });

  describe('tool use (command-r)', () => {
    const MODEL = 'command-r';

    skipIfNoKey(
      'non-streaming',
      async () => {
        const result = await provider.completeWithTools(
          TOOL_PROMPT,
          [{ role: 'user', content: 'What is the weather in Cairo?' }],
          { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
        );

        assertToolCallResult(result, 'Cohere');
      },
      STANDARD_TIMEOUT_MS,
    );

    skipIfNoKey(
      'streaming',
      async () => {
        const { events } = await collectStream(
          provider.streamCompleteWithTools(
            TOOL_PROMPT,
            [{ role: 'user', content: 'Check the weather in Lagos.' }],
            { model: MODEL, maxTokens: 200, timeoutMs: STANDARD_TIMEOUT_MS, tools: [WEATHER_TOOL] },
          ),
        );

        assertStreamToolEvents(events, 'Cohere');
      },
      STANDARD_TIMEOUT_MS,
    );
  });
});
