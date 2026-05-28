/**
 * OpenAI LLM client adapter.
 */

import OpenAI from 'openai';
import type { LLMClient, LLMMessage } from '../types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

export function createOpenAIClient(apiKey: string, model?: string): LLMClient {
  const client = new OpenAI({ apiKey });
  const resolvedModel = model || DEFAULT_MODEL;

  return {
    async chat(messages: LLMMessage[], system?: string): Promise<string> {
      const formatted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

      if (system) {
        formatted.push({ role: 'system', content: system });
      }

      for (const m of messages) {
        formatted.push({ role: m.role, content: m.content });
      }

      const response = await client.chat.completions.create({
        model: resolvedModel,
        messages: formatted,
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
}
