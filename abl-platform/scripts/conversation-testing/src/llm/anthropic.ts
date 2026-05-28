/**
 * Anthropic LLM client adapter.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMMessage } from '../types.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;

export function createAnthropicClient(apiKey: string, model?: string): LLMClient {
  const client = new Anthropic({ apiKey });
  const resolvedModel = model || DEFAULT_MODEL;

  return {
    async chat(messages: LLMMessage[], system?: string): Promise<string> {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: MAX_TOKENS,
        system: system || undefined,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      return textBlock ? textBlock.text : '';
    },
  };
}
