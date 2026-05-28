/**
 * Stub Providers for Development
 *
 * These are minimal provider implementations that allow pipelines to validate.
 * Replace with real implementations before production use.
 */

import {
  type PipelineStageProvider,
  type JSONSchema,
} from '../services/provider-registry/types.js';
import { ProviderRegistry } from '../services/provider-registry/index.js';

// Base stub provider factory
function createStubProvider(
  id: string,
  name: string,
  type: 'extraction' | 'chunking' | 'enrichment' | 'embedding' | 'multimodal',
): PipelineStageProvider {
  return {
    id,
    name,
    type,
    version: '1.0.0-stub',
    description: `Stub ${type} provider for development`,

    async execute(input: any, config: any): Promise<any> {
      return input; // Pass-through
    },

    validateConfig(config: unknown): config is any {
      return typeof config === 'object' && config !== null;
    },

    getSchema(): JSONSchema {
      return {
        type: 'object',
        properties: {},
      };
    },
  };
}

// Register all stub providers
export function registerStubProviders() {
  const registry = ProviderRegistry.getInstance();

  // Extraction providers
  registry.register(createStubProvider('docling', 'Docling', 'extraction'));
  registry.register(createStubProvider('llamaindex', 'LlamaIndex', 'extraction'));

  // Chunking providers
  registry.register(createStubProvider('tree-builder', 'Tree Builder', 'chunking'));

  // Enrichment providers
  registry.register(createStubProvider('tfidf-llm', 'TF-IDF + LLM', 'enrichment'));
  registry.register(createStubProvider('llm-enrichment', 'LLM Enrichment', 'enrichment'));

  // Embedding providers
  registry.register(createStubProvider('bge-m3', 'BGE-M3', 'embedding'));
  registry.register(createStubProvider('openai', 'OpenAI', 'embedding'));
  registry.register(createStubProvider('cohere', 'Cohere', 'embedding'));
  registry.register(createStubProvider('custom', 'Custom', 'embedding'));
}
