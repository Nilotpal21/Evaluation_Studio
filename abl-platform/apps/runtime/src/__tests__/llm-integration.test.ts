/**
 * LLM Provider Integration Tests
 *
 * Real integration tests with actual LLM providers.
 * These tests are skipped unless API keys are available in environment.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... pnpm test llm-integration.test.ts
 *   OPENAI_API_KEY=sk-... pnpm test llm-integration.test.ts
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { SessionLLMClient } from '../services/llm/session-llm-client';
import { ModelResolutionService } from '../services/llm/model-resolution';

// Skip all tests if no API keys are available
const hasApiKeys = () => {
  return !!(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
};

const describeIf = hasApiKeys() ? describe : describe.skip;

function createIntegrationClient(mockResolution: ModelResolutionService): SessionLLMClient {
  return new SessionLLMClient(mockResolution, {
    tenantId: 'test-tenant',
    projectId: 'test-project',
    agentName: 'test-agent',
    sessionId: 'test-session',
  });
}

// =============================================================================
// Anthropic Integration Tests
// =============================================================================

describeIf('Anthropic Integration', () => {
  let mockResolution: ModelResolutionService;

  beforeEach(() => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('ANTHROPIC_API_KEY not set, skipping Anthropic integration tests');
      return;
    }

    mockResolution = {
      resolve: () =>
        Promise.resolve({
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5-20250514',
          credential: {
            apiKey: process.env.ANTHROPIC_API_KEY!,
            endpoint: undefined,
          },
          parameters: {
            maxTokens: 1024,
            temperature: 0.7,
          },
          source: 'test',
        }),
    } as any;
  });

  test('simple completion', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const result = await client.chatWithToolUse(
      'You are a helpful assistant. Be concise.',
      [{ role: 'user', content: 'Say hello in one word' }],
      [],
    );

    expect(result.text).toBeTruthy();
    expect(result.text.toLowerCase()).toContain('hello');
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  }, 30000);

  test('tool calling', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const result = await client.chatWithToolUse(
      'You are a helpful assistant.',
      [{ role: 'user', content: 'What is the weather in San Francisco?' }],
      [
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
      ],
    );

    // Should either return text or tool calls
    const hasOutput = result.text || result.toolCalls.length > 0;
    expect(hasOutput).toBeTruthy();

    if (result.toolCalls.length > 0) {
      expect(result.toolCalls[0].name).toBe('get_weather');
      expect(result.toolCalls[0].input).toHaveProperty('location');
    }
  }, 30000);

  test('streaming completion', async () => {
    if (!process.env.ANTHROPIC_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const events: any[] = [];
    for await (const event of client.streamChatWithToolUse(
      'You are a helpful assistant. Be concise.',
      [{ role: 'user', content: 'Count to 3' }],
      [],
    )) {
      events.push(event);
    }

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    const doneEvents = events.filter((e) => e.type === 'done');
    const usageEvents = events.filter((e) => e.type === 'usage');

    expect(textDeltas.length).toBeGreaterThan(0);
    expect(doneEvents.length).toBe(1);
    expect(usageEvents.length).toBeGreaterThan(0);

    // Check that text was actually streamed
    const fullText = textDeltas.map((e) => e.delta).join('');
    expect(fullText.length).toBeGreaterThan(0);
  }, 30000);
});

// =============================================================================
// OpenAI Integration Tests
// =============================================================================

describeIf('OpenAI Integration', () => {
  let mockResolution: ModelResolutionService;

  beforeEach(() => {
    if (!process.env.OPENAI_API_KEY) {
      console.warn('OPENAI_API_KEY not set, skipping OpenAI integration tests');
      return;
    }

    mockResolution = {
      resolve: () =>
        Promise.resolve({
          provider: 'openai',
          modelId: 'gpt-4o-mini',
          credential: {
            apiKey: process.env.OPENAI_API_KEY!,
            endpoint: undefined,
          },
          parameters: {
            maxTokens: 1024,
            temperature: 0.7,
          },
          source: 'test',
        }),
    } as any;
  });

  test('simple completion', async () => {
    if (!process.env.OPENAI_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const result = await client.chatWithToolUse(
      'You are a helpful assistant. Be concise.',
      [{ role: 'user', content: 'Say hello in one word' }],
      [],
    );

    expect(result.text).toBeTruthy();
    expect(result.text.toLowerCase()).toContain('hello');
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  }, 30000);

  test('tool calling', async () => {
    if (!process.env.OPENAI_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const result = await client.chatWithToolUse(
      'You are a helpful assistant.',
      [{ role: 'user', content: 'What is the weather in San Francisco?' }],
      [
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
      ],
    );

    // Should either return text or tool calls
    const hasOutput = result.text || result.toolCalls.length > 0;
    expect(hasOutput).toBeTruthy();

    if (result.toolCalls.length > 0) {
      expect(result.toolCalls[0].name).toBe('get_weather');
      expect(result.toolCalls[0].input).toHaveProperty('location');
    }
  }, 30000);
});

// =============================================================================
// Google (Gemini) Integration Tests
// =============================================================================

describeIf('Google Gemini Integration', () => {
  let mockResolution: ModelResolutionService;

  beforeEach(() => {
    if (!process.env.GOOGLE_API_KEY) {
      console.warn('GOOGLE_API_KEY not set, skipping Gemini integration tests');
      return;
    }

    mockResolution = {
      resolve: () =>
        Promise.resolve({
          provider: 'google',
          modelId: 'gemini-2.0-flash-exp',
          credential: {
            apiKey: process.env.GOOGLE_API_KEY!,
            endpoint: undefined,
          },
          parameters: {
            maxTokens: 1024,
            temperature: 0.7,
          },
          source: 'test',
        }),
    } as any;
  });

  test('simple completion', async () => {
    if (!process.env.GOOGLE_API_KEY) return;

    const client = createIntegrationClient(mockResolution);

    const result = await client.chatWithToolUse(
      'You are a helpful assistant. Be concise.',
      [{ role: 'user', content: 'Say hello in one word' }],
      [],
    );

    expect(result.text).toBeTruthy();
    expect(result.text.toLowerCase()).toContain('hello');
    expect(result.usage).toBeDefined();
  }, 30000);
});
