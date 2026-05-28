/**
 * @agent-platform/llm
 *
 * Shared LLM provider factory and worker client using Vercel AI SDK.
 * Used by both Runtime (SessionLLMClient) and SearchAI (WorkerLLMClient).
 */

export { createVercelProvider, createVercelEmbeddingProvider } from './provider-factory.js';
export {
  WorkerLLMClient,
  type WorkerLLMClientOptions,
  type ToolUseResult,
} from './worker-llm-client.js';
export {
  convertTools,
  convertMessages,
  extractOpenAIResponsesPreviousResponseId,
  findOpenAIResponsesPreviousResponse,
  jsonSchemaToZod,
  type OpenAIResponsesPreviousResponseRef,
  type SDKTool,
} from './tool-adapters.js';

// Re-export commonly used Vercel AI SDK types and functions
export { generateText, streamText, type LanguageModel } from 'ai';

/**
 * Minimal interface for an LLM client that supports `.chat()`.
 *
 * Both the deprecated `LLMClient` from `@abl/compiler` and the new
 * `WorkerLLMClient` satisfy this interface. SearchAI services should
 * accept this type instead of the concrete class.
 */
export interface ChatLLMClient {
  chat(
    systemPrompt: string,
    messages: Array<{ role: string; content: string | unknown[] }>,
    options: { model?: string; maxTokens?: number; timeoutMs?: number },
  ): Promise<string>;
}
