/**
 * Custom (OpenAI-compatible) LLM client adapter.
 *
 * Uses the OpenAI SDK with a custom base URL for self-hosted
 * or third-party OpenAI-compatible endpoints (e.g. Qwen, vLLM).
 */

import OpenAI from 'openai';
import type { LLMClient, LLMMessage } from '../types.js';

export function createCustomClient(baseURL: string, apiKey: string, model: string): LLMClient {
  const client = new OpenAI({ baseURL, apiKey });

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
        model,
        messages: formatted,
      });

      return response.choices[0]?.message?.content ?? '';
    },
  };
}
