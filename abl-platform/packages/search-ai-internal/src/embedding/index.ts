/**
 * Embedding — barrel exports
 */

export type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingRequest,
  EmbeddingResult,
} from './interface.js';

export { OpenAIEmbeddingProvider } from './openai.js';
export { CohereEmbeddingProvider } from './cohere.js';
export { BGEm3EmbeddingProvider } from './bge-m3.js';
export { AzureOpenAIEmbeddingProvider, type AzureOpenAIEmbeddingConfig } from './azure-openai.js';
export { CustomEmbeddingProvider } from './custom.js';
export { createEmbeddingProvider, type EmbeddingFactoryConfig } from './factory.js';
export {
  EmbeddingProviderResolver,
  type EmbeddingConfigSource,
  type EmbeddingCredentialSource,
  type GetPipelineConfigFn,
  type ResolveCredentialsFn,
  type EmbeddingProviderResolverOptions,
} from './resolver.js';
