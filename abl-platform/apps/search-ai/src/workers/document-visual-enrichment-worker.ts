/**
 * Document-Level Visual Enrichment Worker (Phase 3b)
 *
 * Document-level visual re-summarization that:
 * - Collects all enriched page summaries
 * - Generates document-level visual narrative
 * - Enhances document-level questions
 * - Triggers downstream workers (KG, Embedding)
 *
 * Runs AFTER Phase 3a (all pages enriched) and BEFORE Phase 4 (KG, Embedding)
 */

import { Job } from 'bullmq';
import { VisionService } from '../services/vision/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { withTraceContext } from './shared.js';
import { injectTrace } from '@agent-platform/shared-observability/tracing';
import { getObservabilityContext } from '@abl/compiler/platform/observability';

import { createLogger } from '@abl/compiler/platform';

import { getLazyModel } from '../db/index.js';
import type {
  ISearchChunk,
  IChunkQuestion,
  ISearchDocument,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const log = createLogger('document-visual-enrichment-worker');

// ─── Job Data Interface ──────────────────────────────────────────────────────

export interface DocumentVisualEnrichmentJobData {
  tenantId: string;
  indexId: string;
  documentId: string;
}

// ─── Main Worker Function ────────────────────────────────────────────────────

/**
 * Process document-level visual enrichment
 *
 * Sequential flow:
 * 1. Load all enriched page summaries (from Phase 3a)
 * 2. Collect all image descriptions
 * 3. Re-generate document summary with visual narrative
 * 4. Re-generate document questions with visual context
 * 5. Update document
 * 6. Trigger downstream workers (KG, Embedding)
 */
export async function processDocumentVisualEnrichment(
  job: Job<DocumentVisualEnrichmentJobData>,
): Promise<void> {
  await withTraceContext(job.data as unknown as Record<string, unknown>, async () => {
    const { tenantId, indexId, documentId } = job.data;

    log.info('[Phase 3b] Starting document-level visual enrichment', {
      documentId,
    });

    // 1. Resolve LLM config
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

    if (!llmConfig.useCases.vision.enabled) {
      log.info('[Phase 3b] Vision disabled, skipping', { indexId });
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);
      return;
    }

    // 2. Load all enriched page summaries (from Phase 3a)
    const chunks = await SearchChunk.find({ documentId, tenantId, indexId }).sort({
      'metadata.pageNumber': 1,
    });

    const enrichedPageSummaries = chunks
      .filter((c) => c.metadata.progressiveSummaryVersion === 2)
      .map((c) => c.metadata.progressiveSummary);

    if (enrichedPageSummaries.length === 0) {
      log.info('[Phase 3b] No enriched page summaries found, skipping', {
        documentId,
      });
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);
      return;
    }

    // 3. Load text-only document summary from Phase 2
    const document = await SearchDocument.findOne({ _id: documentId, tenantId });
    if (!document) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const textOnlyDocSummary = (document as any).metadata?.documentSummary;
    if (!textOnlyDocSummary) {
      log.warn('[Phase 3b] No document summary found, skipping', { documentId });
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);
      return;
    }

    // 4. Load text-only document questions from Phase 2
    const docQuestions = await ChunkQuestion.find({
      documentId,
      tenantId,
      scope: 'document',
    }).sort({ questionIndex: 1 });

    // 5. Collect all image descriptions from all pages
    const allImageDescriptions = chunks.flatMap(
      (c) => c.metadata?.visualAnalysis?.imageDescriptions || [],
    );

    if (allImageDescriptions.length === 0) {
      log.info('[Phase 3b] No image descriptions found, skipping', {
        documentId,
      });
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);
      return;
    }

    // 6. Extract key visual elements
    const keyVisualElements = extractKeyVisuals(allImageDescriptions);

    // 7. Initialize VisionService
    const visionService = new VisionService({
      indexId,
      tenantId,
      resolvedConfig: llmConfig,
    });

    const startTime = Date.now();

    try {
      // 8. Re-generate document summary with visual context
      log.info('[Phase 3b] Enriching document summary', {
        documentId,
        enrichedPages: enrichedPageSummaries.length,
        totalImages: allImageDescriptions.length,
        keyVisualElements: keyVisualElements.length,
      });

      const enrichedDocSummary = await visionService.enrichDocumentSummary({
        originalDocumentSummary: textOnlyDocSummary,
        enrichedPageSummaries,
        allImageDescriptions,
        keyVisualElements,
      });

      // 9. Re-generate document questions with visual context
      log.info('[Phase 3b] Enhancing document questions', {
        documentId,
        questionCount: docQuestions.length,
      });

      const enrichedDocQuestions = await visionService.enhanceDocumentQuestions({
        originalQuestions: docQuestions as any,
        enrichedDocumentSummary: enrichedDocSummary.summary,
        keyVisualElements,
      });

      // 10. Update document
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          'metadata.documentSummary': enrichedDocSummary.summary,
          'metadata.documentSummaryVersion': 2,
          'metadata.visualDocumentSummary': {
            keyVisualElements: enrichedDocSummary.keyVisualElements,
            visualNarrative: enrichedDocSummary.visualNarrative,
            visualThemes: enrichedDocSummary.visualThemes,
            chartInsights: enrichedDocSummary.chartInsights,
            enrichedAt: new Date(),
            enrichmentTokens: enrichedDocSummary.tokensUsed,
            enrichmentCost: enrichedDocSummary.costUsd,
            enrichmentModel: llmConfig.useCases.vision.model,
          },
          'metadata.totalProcessingCost':
            ((document as any).metadata?.totalProcessingCost || 0) + enrichedDocSummary.costUsd,
          'metadata.totalProcessingTokens':
            ((document as any).metadata?.totalProcessingTokens || 0) +
            enrichedDocSummary.tokensUsed,
        },
      );

      // 11. Update document questions
      for (let i = 0; i < enrichedDocQuestions.length; i++) {
        const enrichedQ = enrichedDocQuestions[i];

        if (i < docQuestions.length) {
          const originalQ = docQuestions[i];

          await ChunkQuestion.findOneAndUpdate(
            { _id: originalQ._id, tenantId },
            {
              question: enrichedQ.question,
              questionVersion: 2,
              'metadata.visuallyEnriched': enrichedQ.modified,
              'metadata.originalQuestion': enrichedQ.modified ? originalQ.question : undefined,
            },
          );
        }
      }

      const processingTime = Date.now() - startTime;

      log.info('[Phase 3b] Document enrichment complete', {
        documentId,
        processingTimeMs: processingTime,
        enrichedPages: enrichedPageSummaries.length,
        totalImages: allImageDescriptions.length,
        keyVisualElements: keyVisualElements.length,
        visualThemes: enrichedDocSummary.visualThemes.length,
        chartInsights: enrichedDocSummary.chartInsights?.length || 0,
        questionsModified: enrichedDocQuestions.filter((q) => q.modified).length,
        tokens: enrichedDocSummary.tokensUsed,
        cost: enrichedDocSummary.costUsd.toFixed(6),
      });

      // 12. NOW enqueue downstream workers (KG, Embedding)
      // This is the critical sequencing: Phase 4 workers use enriched data
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);
    } catch (error) {
      log.error('[Phase 3b] Document enrichment failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Continue to downstream workers despite error
      await enqueueDownstreamWorkers(tenantId, indexId, documentId);

      throw error;
    }
  });
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Extract key visual elements from all image descriptions
 */
function extractKeyVisuals(imageDescriptions: any[]): string[] {
  const keywords = new Set<string>();

  for (const img of imageDescriptions) {
    // Extract from description
    const desc = img.description?.toLowerCase() || '';
    if (desc.includes('chart')) keywords.add('chart');
    if (desc.includes('bar chart') || desc.includes('bar graph')) keywords.add('bar chart');
    if (desc.includes('line chart') || desc.includes('line graph')) keywords.add('line chart');
    if (desc.includes('pie chart')) keywords.add('pie chart');
    if (desc.includes('diagram')) keywords.add('diagram');
    if (desc.includes('graph')) keywords.add('graph');
    if (desc.includes('table')) keywords.add('table');
    if (desc.includes('code')) keywords.add('code snippet');
    if (desc.includes('screenshot')) keywords.add('screenshot');
    if (desc.includes('flowchart')) keywords.add('flowchart');

    // Extract from extracted data
    if (img.extractedData?.type) {
      keywords.add(img.extractedData.type);
    }
  }

  return Array.from(keywords);
}

/**
 * Enqueue downstream workers (Knowledge Graph, Embedding)
 */
async function enqueueDownstreamWorkers(
  tenantId: string,
  indexId: string,
  documentId: string,
): Promise<void> {
  log.info('[Phase 3b] Enqueuing downstream workers', { documentId });

  try {
    // Import queues dynamically to avoid circular dependency
    const { getEmbeddingQueue } = await import('../queues/index.js');
    const embeddingQueue = getEmbeddingQueue();
    if (!embeddingQueue) {
      throw new Error('Embedding queue unavailable (Redis not configured)');
    }

    // Embedding worker (always runs)
    const embeddingData: Record<string, unknown> = {
      tenantId,
      indexId,
      documentId,
    };

    // Propagate trace context to downstream job
    const obsCtx = getObservabilityContext();
    if (obsCtx) {
      injectTrace(embeddingData, {
        traceId: obsCtx.traceId,
        spanId: obsCtx.spanId,
      });
    }

    await embeddingQueue.add('embed-document', embeddingData).catch((err) => {
      log.error('[Phase 3b] Failed to enqueue embedding worker', {
        documentId,
        error: err.message,
      });
    });

    log.info('[Phase 3b] Downstream workers enqueued successfully', {
      documentId,
    });
  } catch (error) {
    log.error('[Phase 3b] Failed to enqueue downstream workers', {
      documentId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Don't throw - downstream workers failing to enqueue shouldn't block
  }
}

/**
 * Worker configuration
 */
export const documentVisualEnrichmentWorkerConfig = {
  concurrency: 2, // Conservative for document-level processing
  limiter: {
    max: 5, // Max 5 jobs per minute
    duration: 60000,
  },
};
