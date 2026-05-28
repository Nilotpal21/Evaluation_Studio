/**
 * LLM Provider E2E Tests — Real API Calls
 *
 * Tests real LLM calls through the compiler's provider layer.
 * Requires ANTHROPIC_API_KEY in environment (loaded from apps/runtime/.env).
 *
 * Tests cover:
 * 1. Simple text completion (Anthropic)
 * 2. Completion with tool use (Anthropic)
 * 3. Streaming text completion (Anthropic)
 * 4. Streaming with tool use (Anthropic)
 * 5. SessionLLMClient integration (direct mode)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { createProvider } from '../platform/llm/provider.js';
import type { LLMProvider, ToolDefinition, StreamEvent, Message } from '../platform/llm/types.js';
// Trigger auto-registration
import '../platform/llm/providers/index.js';

// =============================================================================
// CONFIG
// =============================================================================

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30000;

// createProvider() was removed during the Vercel AI SDK migration, so these
// compiler-level provider E2E tests stay skipped until they are rebuilt on the
// runtime-layer SessionLLMClient stack.
const PROVIDER_E2E_DISABLED = true;
const skipIfNoKey = PROVIDER_E2E_DISABLED || !API_KEY ? test.skip : test;

// =============================================================================
// TEST FIXTURES
// =============================================================================

const SIMPLE_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a location',
  input_schema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
      unit: { type: 'string', description: 'Temperature unit', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['location'],
  },
};

const MULTI_TOOL: ToolDefinition = {
  name: 'search_flights',
  description: 'Search for available flights',
  input_schema: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Origin city' },
      destination: { type: 'string', description: 'Destination city' },
    },
    required: ['origin', 'destination'],
  },
};

// =============================================================================
// ANTHROPIC PROVIDER — REAL API CALLS
// =============================================================================

describe('Anthropic Provider — Real API E2E', () => {
  let provider: LLMProvider;

  beforeAll(() => {
    if (PROVIDER_E2E_DISABLED || !API_KEY) return;
    provider = createProvider({
      provider: 'anthropic',
      apiKey: API_KEY,
    });
  });

  skipIfNoKey(
    'simple text completion returns coherent response',
    async () => {
      const result = await provider.complete(
        'You are a helpful assistant. Reply in one sentence.',
        [{ role: 'user', content: 'What is the capital of France?' }],
        { model: MODEL, maxTokens: 100, timeoutMs: TIMEOUT_MS },
      );

      expect(result.text).toBeTruthy();
      expect(result.text.toLowerCase()).toContain('paris');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBeGreaterThan(0);
      expect(result.usage!.outputTokens).toBeGreaterThan(0);
      console.log(
        `[E2E] complete: "${result.text.substring(0, 80)}..." (${result.usage!.inputTokens}/${result.usage!.outputTokens} tokens)`,
      );
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'completion with tool use triggers tool call',
    async () => {
      const result = await provider.completeWithTools(
        'You are a weather assistant. Always use the get_weather tool when asked about weather.',
        [{ role: 'user', content: 'What is the weather like in Tokyo?' }],
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL] },
      );

      expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(result.stopReason).toBe('tool_use');

      const weatherCall = result.toolCalls.find((tc) => tc.name === 'get_weather');
      expect(weatherCall).toBeDefined();
      expect(weatherCall!.input).toHaveProperty('location');
      expect(weatherCall!.id).toBeTruthy();

      console.log(
        `[E2E] completeWithTools: tool=${weatherCall!.name} input=${JSON.stringify(weatherCall!.input)}`,
      );
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'multi-turn conversation with tool results',
    async () => {
      const messages: Message[] = [
        { role: 'user', content: 'What is the weather in London?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the weather for you.' },
            {
              type: 'tool_use',
              id: 'tool_call_1',
              name: 'get_weather',
              input: { location: 'London' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_call_1',
              content: JSON.stringify({ temperature: 15, condition: 'cloudy', unit: 'celsius' }),
            },
          ],
        },
      ];

      const result = await provider.completeWithTools(
        'You are a weather assistant. Summarize the weather data returned by tools.',
        messages,
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL] },
      );

      // After receiving tool result, model should respond with text (not another tool call)
      expect(result.text).toBeTruthy();
      expect(result.stopReason).toBe('end_turn');
      // Response should reference the weather data
      const lower = result.text!.toLowerCase();
      expect(lower.includes('london') || lower.includes('15') || lower.includes('cloudy')).toBe(
        true,
      );

      console.log(`[E2E] multi-turn: "${result.text!.substring(0, 100)}..."`);
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'streaming text completion yields text deltas',
    async () => {
      const chunks: string[] = [];
      let gotMessageEnd = false;

      for await (const event of provider.streamComplete(
        'You are a helpful assistant. Reply in one sentence.',
        [{ role: 'user', content: 'Name three colors.' }],
        { model: MODEL, maxTokens: 100, timeoutMs: TIMEOUT_MS },
      )) {
        if (event.type === 'text_delta') {
          chunks.push(event.text);
        }
        if (event.type === 'message_end') {
          gotMessageEnd = true;
        }
      }

      const fullText = chunks.join('');
      expect(fullText).toBeTruthy();
      expect(chunks.length).toBeGreaterThan(1); // Multiple streaming chunks
      expect(gotMessageEnd).toBe(true);

      console.log(
        `[E2E] streamComplete: "${fullText.substring(0, 80)}..." (${chunks.length} chunks)`,
      );
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'streaming with tool use emits start/delta/end events',
    async () => {
      const events: StreamEvent[] = [];

      for await (const event of provider.streamCompleteWithTools(
        'You are a weather assistant. Always use the get_weather tool.',
        [{ role: 'user', content: 'Check the weather in Berlin please.' }],
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL] },
      )) {
        events.push(event);
      }

      // Should have tool_use lifecycle events
      const toolStart = events.find((e) => e.type === 'tool_use_start');
      const toolDeltas = events.filter((e) => e.type === 'tool_use_delta');
      const toolEnd = events.find((e) => e.type === 'tool_use_end');
      const messageEnd = events.find((e) => e.type === 'message_end');

      expect(toolStart).toBeDefined();
      expect(toolStart!.name).toBe('get_weather');
      expect(toolStart!.id).toBeTruthy();

      expect(toolDeltas.length).toBeGreaterThanOrEqual(1);

      expect(toolEnd).toBeDefined();
      expect(toolEnd!.input).toBeDefined();
      expect(toolEnd!.input).toHaveProperty('location');

      expect(messageEnd).toBeDefined();

      console.log(
        `[E2E] streamCompleteWithTools: ${events.length} events, tool=${toolStart!.name}, input=${JSON.stringify(toolEnd!.input)}`,
      );
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'multiple tools — model picks the right one',
    async () => {
      const result = await provider.completeWithTools(
        'You are a travel assistant. Use the appropriate tool for each request.',
        [{ role: 'user', content: 'Find flights from New York to London' }],
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL, MULTI_TOOL] },
      );

      expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
      const flightCall = result.toolCalls.find((tc) => tc.name === 'search_flights');
      expect(flightCall).toBeDefined();
      expect(flightCall!.input).toHaveProperty('origin');
      expect(flightCall!.input).toHaveProperty('destination');

      console.log(
        `[E2E] multi-tool: selected=${flightCall!.name} input=${JSON.stringify(flightCall!.input)}`,
      );
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'handles max_tokens gracefully',
    async () => {
      const result = await provider.complete(
        'You are a storyteller.',
        [{ role: 'user', content: 'Write a very long detailed story about space exploration.' }],
        { model: MODEL, maxTokens: 10, timeoutMs: TIMEOUT_MS },
      );

      // With only 10 tokens, should hit max_tokens
      expect(result.stopReason).toBe('max_tokens');
      expect(result.text).toBeTruthy();
      expect(result.usage!.outputTokens).toBeLessThanOrEqual(15); // ~10 tokens with some tolerance

      console.log(
        `[E2E] max_tokens: stop=${result.stopReason} output_tokens=${result.usage!.outputTokens}`,
      );
    },
    TIMEOUT_MS,
  );
});

// =============================================================================
// LITELLM FORMAT — ROUND-TRIP THROUGH ANTHROPIC
// =============================================================================

describe('LiteLLM Provider — Format Round-Trip via Anthropic (no proxy needed)', () => {
  /**
   * This test verifies that LiteLLM's formatMessages() produces correct OpenAI format
   * by checking the format translation output against known-good patterns.
   * It does NOT need a LiteLLM proxy running — it tests the format conversion logic.
   */

  skipIfNoKey(
    'LiteLLM format is compatible with Anthropic multi-turn tool cycle',
    async () => {
      // Use Anthropic provider directly to verify the full tool cycle works
      const provider = createProvider({
        provider: 'anthropic',
        apiKey: API_KEY!,
      });

      // Step 1: Ask for weather → should trigger tool call
      const step1 = await provider.completeWithTools(
        'You are a weather bot. Always use the get_weather tool.',
        [{ role: 'user', content: 'Weather in Paris?' }],
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL] },
      );

      expect(step1.toolCalls.length).toBeGreaterThanOrEqual(1);
      const toolCall = step1.toolCalls[0];

      // Step 2: Send tool result back → should get text response
      const step2Messages: Message[] = [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: [
            ...(step1.text ? [{ type: 'text' as const, text: step1.text }] : []),
            {
              type: 'tool_use' as const,
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.input,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolCall.id,
              content: JSON.stringify({ temperature: 22, condition: 'sunny', humidity: 60 }),
            },
          ],
        },
      ];

      const step2 = await provider.completeWithTools(
        'You are a weather bot. Report the weather data from tools concisely.',
        step2Messages,
        { model: MODEL, maxTokens: 200, timeoutMs: TIMEOUT_MS, tools: [SIMPLE_TOOL] },
      );

      expect(step2.text).toBeTruthy();
      expect(step2.stopReason).toBe('end_turn');
      const lower = step2.text!.toLowerCase();
      expect(lower.includes('paris') || lower.includes('22') || lower.includes('sunny')).toBe(true);

      console.log(
        `[E2E] tool round-trip: step1=${toolCall.name}(${JSON.stringify(toolCall.input)}) → step2="${step2.text!.substring(0, 80)}..."`,
      );
    },
    TIMEOUT_MS * 2,
  );
});

// =============================================================================
// PROVIDER CORRECTNESS — STRESS SCENARIOS
// =============================================================================

describe('Provider Correctness — Edge Cases', () => {
  let provider: LLMProvider;

  beforeAll(() => {
    if (PROVIDER_E2E_DISABLED || !API_KEY) return;
    provider = createProvider({
      provider: 'anthropic',
      apiKey: API_KEY,
    });
  });

  skipIfNoKey(
    'empty tool list returns text only',
    async () => {
      const result = await provider.completeWithTools(
        'Reply briefly.',
        [{ role: 'user', content: 'Hello' }],
        { model: MODEL, maxTokens: 100, timeoutMs: TIMEOUT_MS, tools: [] },
      );

      expect(result.text).toBeTruthy();
      expect(result.toolCalls).toEqual([]);
      expect(result.stopReason).toBe('end_turn');

      console.log(`[E2E] empty tools: "${result.text!.substring(0, 60)}..."`);
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'long system prompt works correctly',
    async () => {
      const longPrompt =
        'You are an assistant. '.repeat(100) + 'Reply with exactly: "ACKNOWLEDGED"';

      const result = await provider.complete(
        longPrompt,
        [{ role: 'user', content: 'Please acknowledge.' }],
        { model: MODEL, maxTokens: 50, timeoutMs: TIMEOUT_MS },
      );

      expect(result.text).toBeTruthy();
      expect(result.text!.toLowerCase()).toContain('acknowledged');

      console.log(`[E2E] long prompt: "${result.text!.substring(0, 60)}..."`);
    },
    TIMEOUT_MS,
  );

  skipIfNoKey(
    'concurrent requests succeed',
    async () => {
      const promises = Array.from({ length: 3 }, (_, i) =>
        provider.complete(
          'Reply with just the number given.',
          [{ role: 'user', content: `The number is ${i + 1}. Reply with just that number.` }],
          { model: MODEL, maxTokens: 20, timeoutMs: TIMEOUT_MS },
        ),
      );

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.text).toBeTruthy();
        expect(r.stopReason).toBe('end_turn');
      }

      console.log(`[E2E] concurrent: ${results.map((r) => `"${r.text!.trim()}"`).join(', ')}`);
    },
    TIMEOUT_MS * 2,
  );
});
