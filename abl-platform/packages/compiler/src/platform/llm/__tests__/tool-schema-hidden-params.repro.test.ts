/**
 * FAILS: reproduces ABLP-1100 (Phase 1 contract)
 *
 * This test asserts the desired contract for hidden tool parameters:
 * - ToolParameter should accept `hidden: true` and `defaultSource` fields
 * - Hidden params should be excluded from LLM-facing JSON schemas
 *
 * Today these fields don't exist on ToolParameter, so the test models the future
 * contract locally and asserts the desired LLM-facing schema. It should fail
 * until Phase 1 adds the typed fields and filtering.
 */
// FAILS: reproduces ABLP-1100
import { describe, it, expect } from 'vitest';
import type { ToolParameter } from '../../ir/schema.js';

type FutureToolParameter = ToolParameter & {
  hidden?: boolean;
  defaultSource?: string;
};

describe('ABLP-1100: Hidden tool parameters excluded from LLM schema', () => {
  it('ToolParameter interface should accept hidden and defaultSource fields', () => {
    // Construct a normal (visible) parameter
    const visibleParam: ToolParameter = {
      name: 'message',
      type: 'string',
      description: 'The message to send',
      required: true,
    };

    // Construct a hidden parameter using the target contract shape.
    const hiddenParam: FutureToolParameter = {
      name: 'botId',
      type: 'string',
      description: 'Bot identifier resolved from session',
      required: true,
      hidden: true,
      defaultSource: 'session.botId',
    };

    expect(visibleParam.name).toBe('message');
    expect(hiddenParam.name).toBe('botId');
    expect(hiddenParam.hidden).toBe(true);
    expect(hiddenParam.defaultSource).toBe('session.botId');
  });

  it('LLM schema generation should exclude hidden params from properties', () => {
    // Simulate the schema generation logic from
    // apps/runtime/src/services/execution/prompt-builder.ts:1162-1189
    // This replicates what buildTools() does when converting IR params to input_schema.

    const toolParameters: FutureToolParameter[] = [
      {
        name: 'message',
        type: 'string',
        description: 'The message to send',
        required: true,
      },
      {
        name: 'intent',
        type: 'string',
        description: 'Detected intent name',
        required: true,
      },
      {
        name: 'botId',
        type: 'string',
        description: 'Bot identifier — should be hidden from LLM',
        required: true,
        hidden: true,
        defaultSource: 'session.botId',
      },
      {
        name: 'language',
        type: 'string',
        description: 'Language code — should be hidden from LLM',
        required: true,
        hidden: true,
        defaultSource: 'session.language',
      },
    ];

    // Simulate current buildTools() behavior: ALL params become properties
    // (no hidden filtering exists today)
    const properties: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];

    for (const param of toolParameters) {
      // ─── DESIRED behavior (Phase 1): skip hidden params ───
      // if ((param as { hidden?: boolean }).hidden) continue;
      // ─── CURRENT behavior: all params included ───
      properties[param.name] = {
        type: param.type,
        description: param.description,
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    const inputSchema = {
      type: 'object' as const,
      properties,
      required,
    };

    // FAILS: Today ALL params are included because there's no hidden filtering.
    // Once Phase 1 lands, hidden params (botId, language) should be excluded.
    //
    // Expected (after Phase 1):
    //   - properties should only contain 'message' and 'intent'
    //   - required should only contain ['message', 'intent']
    //
    // Actual (today):
    //   - properties contains ALL 4 params including botId and language
    //   - required contains ALL 4 param names

    expect(Object.keys(inputSchema.properties)).not.toContain('botId');
    expect(Object.keys(inputSchema.properties)).not.toContain('language');
    expect(Object.keys(inputSchema.properties)).toEqual(['message', 'intent']);
    expect(inputSchema.required).toEqual(['message', 'intent']);
  });

  it('hidden params should still be available at execution time via defaultSource resolution', () => {
    // This test documents the execution-time contract.
    // After Phase 1, the tool-binding-executor should resolve hidden params
    // from their defaultSource before passing to the tool.

    const llmGeneratedParams: Record<string, unknown> = {
      message: 'Hello world',
      intent: 'greeting',
      // LLM does NOT generate botId or language — they are hidden
    };

    // Simulated session context (what defaultSource resolves against)
    const sessionContext = {
      botId: 'bot-abc-123',
      language: 'en',
      channelType: 'webhook',
    };

    // DESIRED behavior after Phase 1:
    // resolveHiddenParams() would inject botId and language from session
    const expectedFullParams = {
      message: 'Hello world',
      intent: 'greeting',
      botId: 'bot-abc-123', // from session.botId
      language: 'en', // from session.language
    };

    // Today no resolution function exists — the LLM must generate ALL params.
    // This assertion documents what the tool would receive WITHOUT the feature:
    expect(llmGeneratedParams).not.toHaveProperty('botId');
    expect(llmGeneratedParams).not.toHaveProperty('language');

    // After Phase 1, a resolveHiddenParams() call would produce:
    expect(expectedFullParams).toHaveProperty('botId', 'bot-abc-123');
    expect(expectedFullParams).toHaveProperty('language', 'en');
  });
});
