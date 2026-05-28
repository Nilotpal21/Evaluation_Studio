/**
 * Type Adapters for Vercel AI SDK Integration
 *
 * Re-exports from @agent-platform/llm shared package.
 * Kept as a thin wrapper for backward compatibility with runtime imports.
 */
export {
  convertMessages,
  convertTools,
  extractOpenAIResponsesPreviousResponseId,
  findOpenAIResponsesPreviousResponse,
  jsonSchemaToZod,
  type OpenAIResponsesPreviousResponseRef,
  type SDKTool,
} from '@agent-platform/llm';
