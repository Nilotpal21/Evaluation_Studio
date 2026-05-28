/**
 * Provider Registration
 *
 * Registers all built-in pipeline stage providers with the ProviderRegistry.
 * Called once at SearchAI app startup.
 *
 * ## Adding a New Provider
 *
 * 1. Create a provider class implementing PipelineStageProvider
 * 2. Import it here
 * 3. Add it to the registerAllProviders() function
 * 4. The provider will appear in the Studio UI provider dropdowns automatically
 */

import { ProviderRegistry } from '../provider-registry.js';

// Extraction providers
import { DoclingExtractionProvider } from './docling-extraction.provider.js';
import { LlamaIndexExtractionProvider } from './llamaindex-extraction.provider.js';
import { HttpWebhookProvider } from './http-webhook.provider.js';

// Chunking providers
import { TreeBuilderChunkingProvider } from './tree-builder-chunking.provider.js';
import { RecursiveCharacterChunkingProvider } from './recursive-character-chunking.provider.js';
import { FixedSizeChunkingProvider } from './fixed-size-chunking.provider.js';

// Enrichment providers
import { LLMEnrichmentProvider } from './llm-enrichment.provider.js';
import { QuestionSynthesisProvider } from './question-synthesis.provider.js';

// Content Intelligence & Visual Analysis (V2 replacements for enrichment)
import { ContentIntelligenceProvider } from './content-intelligence.provider.js';
import { VisualAnalysisProvider } from './visual-analysis.provider.js';

// Custom LLM stage
import { LlmStageProvider } from './llm-stage.provider.js';

// Embedding providers
import { BGEM3EmbeddingProvider } from './bge-m3-embedding.provider.js';

import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider-registration');

/**
 * Register all built-in providers with the ProviderRegistry.
 *
 * Call this once during SearchAI server startup, before accepting requests.
 *
 * @returns Number of providers registered
 */
export function registerAllProviders(): number {
  const registry = ProviderRegistry.getInstance();

  const providers = [
    // ── Extraction providers ──────────────────────────────────────────────
    new DoclingExtractionProvider(),
    new LlamaIndexExtractionProvider(),
    new HttpWebhookProvider('extraction'), // HTTP Webhook for extraction

    // ── Chunking providers ────────────────────────────────────────────────
    new TreeBuilderChunkingProvider(),
    new RecursiveCharacterChunkingProvider(),
    new FixedSizeChunkingProvider(),

    // ── Enrichment providers (legacy — kept for backward compat) ─────────
    new LLMEnrichmentProvider(),
    new QuestionSynthesisProvider(),
    new HttpWebhookProvider('enrichment'), // HTTP Webhook for enrichment

    // ── Content Intelligence (V2 — replaces text enrichment) ─────────────
    new ContentIntelligenceProvider(),

    // ── Visual Analysis (V2 — replaces visual enrichment) ────────────────
    new VisualAnalysisProvider(),

    // ── Utility stage type providers (api-webhook) ──────────
    new HttpWebhookProvider('api-webhook' as any),

    // ── Custom LLM stage (classify, summarize, extract, translate) ───────
    new LlmStageProvider(),

    // ── Embedding providers ───────────────────────────────────────────────
    new BGEM3EmbeddingProvider(),
  ];

  let registered = 0;

  for (const provider of providers) {
    try {
      registry.register(provider);
      registered++;
    } catch (error) {
      logger.error('Failed to register provider', {
        providerId: provider.id,
        providerName: provider.name,
        stageType: provider.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('Provider registration complete', {
    registered,
    total: providers.length,
    counts: Object.fromEntries(registry.getProviderCounts()),
  });

  return registered;
}
