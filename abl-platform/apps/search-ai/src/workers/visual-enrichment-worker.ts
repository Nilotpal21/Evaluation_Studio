/**
 * Visual Enrichment Worker (Phase 3a)
 *
 * Page-by-page visual enrichment that:
 * - Analyzes images/screenshots with progressive context
 * - Enriches text summaries with visual insights
 * - Enhances questions with visual references
 * - Chains visual context from page to page
 *
 * Runs AFTER Phase 2 (page processing) and BEFORE Phase 4 (KG, Embedding)
 */

import { Worker, type Job, Queue } from 'bullmq';
import { QUEUE_VISUAL_ENRICHMENT } from '@agent-platform/search-ai-sdk';
import { VisionService } from '../services/vision/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';

import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getRedisConnection, workerLog, workerError, withTraceContext } from './shared.js';
import type { VisualEnrichmentJobData, DocumentVisualEnrichmentJobData } from './shared.js';

import { getLazyModel } from '../db/index.js';
import type { ISearchChunk, IChunkQuestion, IDocumentPage } from '@agent-platform/database';

// Models bound to correct databases (platform vs content)
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion'); // → search_ai
const DocumentPage = getLazyModel<IDocumentPage>('DocumentPage'); // → search_ai
export class VisualEnrichmentWorker {
  private worker: Worker<VisualEnrichmentJobData | DocumentVisualEnrichmentJobData>;
  private queue: Queue;

  constructor(concurrency = 3) {
    // Create queue
    this.queue = new Queue(QUEUE_VISUAL_ENRICHMENT, {
      connection: getRedisConnection(),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
    });

    // Create BullMQ worker
    this.worker = new Worker<VisualEnrichmentJobData | DocumentVisualEnrichmentJobData>(
      QUEUE_VISUAL_ENRICHMENT,
      this.processJob.bind(this),
      {
        connection: getRedisConnection(),
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency,
        limiter: {
          max: 10, // Max 10 jobs per minute
          duration: 60000,
        },
        removeOnComplete: {
          count: 100,
          age: 3600, // 1 hour
        },
        removeOnFail: {
          count: 1000,
          age: 86400, // 24 hours
        },
      },
    );

    this.worker.on('completed', (job) => {
      workerLog(
        'visual-enrichment',
        `Completed ${job.name} for ${job.data.documentId} ${(job.data as VisualEnrichmentJobData).pageNumber ? `page ${(job.data as VisualEnrichmentJobData).pageNumber}` : ''}`,
      );
    });

    this.worker.on('failed', (job, err) => {
      workerError(
        'visual-enrichment',
        `Failed for ${job?.data.documentId} ${(job?.data as VisualEnrichmentJobData).pageNumber ? `page ${(job?.data as VisualEnrichmentJobData).pageNumber}` : ''}`,
        err,
      );
    });
  }

  /**
   * Route job to appropriate handler based on job name
   */
  private async processJob(
    job: Job<VisualEnrichmentJobData | DocumentVisualEnrichmentJobData>,
  ): Promise<void> {
    await withTraceContext(job.data as unknown as Record<string, unknown>, async () => {
      if (job.name === 'enrich-page') {
        await this.processPageEnrichment(job as Job<VisualEnrichmentJobData>);
      } else if (job.name === 'enrich-document') {
        // Import dynamically to avoid circular dependency
        const { processDocumentVisualEnrichment } =
          await import('./document-visual-enrichment-worker.js');
        await processDocumentVisualEnrichment(job as Job<DocumentVisualEnrichmentJobData>);
      } else {
        throw new Error(`Unknown job name: ${job.name}`);
      }
    });
  }

  /**
   * Process visual enrichment for a single page
   */
  private async processPageEnrichment(job: Job<VisualEnrichmentJobData>): Promise<void> {
    const { tenantId, indexId, documentId, pageNumber, chunkId } = job.data;

    workerLog('visual-enrichment', `[Phase 3a] Processing page ${pageNumber}`, {
      documentId,
      chunkId,
    });

    // 1. Resolve LLM config for this index
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

    // 2. Check if vision is enabled
    if (!llmConfig.useCases.vision.enabled) {
      workerLog('visual-enrichment', `Vision disabled for index, skipping page ${pageNumber}`, {
        indexId,
      });
      await this.enqueueNextPage(tenantId, indexId, documentId, pageNumber);
      return;
    }

    // 3. Load Phase 2 outputs (text-based)
    const chunk = await SearchChunk.findOne({ _id: chunkId, tenantId, indexId });
    if (!chunk) {
      throw new Error(`Chunk not found: ${chunkId}`);
    }

    const textSummary = chunk.metadata.progressiveSummary;
    // For standalone image documents, there may be no text and therefore
    // no progressive summary.  Still proceed if the chunk has images so
    // the vision LLM can describe the image content.
    if (!textSummary && !chunk.metadata?.hasImages) {
      workerLog(
        'visual-enrichment',
        `No progressive summary and no images, skipping page ${pageNumber}`,
        {
          chunkId,
        },
      );
      await this.enqueueNextPage(tenantId, indexId, documentId, pageNumber);
      return;
    }

    const questions = await ChunkQuestion.find({
      chunkId,
      scope: 'chunk',
    }).sort({ questionIndex: 1 });

    // 4. Load previous page's visual context
    let previousVisualContext: string | null = null;
    if (pageNumber > 1) {
      const previousChunk = await SearchChunk.findOne({
        documentId,
        tenantId,
        indexId,
        'metadata.pageNumber': pageNumber - 1,
      });
      previousVisualContext = previousChunk?.metadata?.visualAnalysis?.visualContext || null;
    }

    // 5. Load images/screenshot for this page
    const page = await DocumentPage.findOne({
      documentId,
      pageNumber,
    });

    if (!page) {
      throw new Error(`DocumentPage not found: ${documentId}, page ${pageNumber}`);
    }

    const images = page.images || [];
    const screenshot = page.screenshot;

    // 6. Check if visual processing needed (cost optimization)
    const hasVisuals = images.length > 0 || screenshot !== null;

    if (!hasVisuals) {
      workerLog('visual-enrichment', `No visuals on page ${pageNumber}, skipping`);

      // Mark as processed but skipped
      await SearchChunk.findOneAndUpdate(
        { _id: chunkId, tenantId },
        {
          'metadata.visualAnalysis': {
            processed: false,
            processedAt: new Date(),
            imageDescriptions: [],
            visualContext: previousVisualContext || '',
            enrichmentTokens: 0,
            enrichmentCost: 0,
            enrichmentModel: llmConfig.useCases.vision.model,
          },
        },
      );

      await this.enqueueNextPage(tenantId, indexId, documentId, pageNumber);
      return;
    }

    // 7. Initialize VisionService with resolved config
    const visionService = new VisionService({
      indexId,
      tenantId,
      resolvedConfig: llmConfig,
    });

    const startTime = Date.now();

    try {
      // 8. Visual analysis with progressive context
      workerLog('visual-enrichment', `Analyzing visuals for page ${pageNumber}`, {
        imageCount: images.length,
        hasScreenshot: screenshot !== null,
        hasPreviousContext: previousVisualContext !== null,
      });

      // For standalone images without OCR text, use a placeholder so the
      // vision LLM still describes the image content.
      const effectiveSummary =
        textSummary || 'This is a standalone image document. Describe the image content in detail.';

      const visualAnalysis = await visionService.analyzeWithContext({
        images,
        screenshot,
        textSummary: effectiveSummary,
        previousVisualContext,
        questions: questions.map((q) => q.question),
      });

      // 9. Enrich summary with visual context
      workerLog('visual-enrichment', `Enriching summary for page ${pageNumber}`);

      // When there is no original text summary (standalone image), use the
      // image descriptions themselves as the enriched summary instead of
      // trying to merge into a non-existent original.
      const enrichedSummary = textSummary
        ? await visionService.enrichSummary({
            originalSummary: textSummary,
            imageDescriptions: visualAnalysis.imageDescriptions,
            visualContext: visualAnalysis.visualContext,
          })
        : [
            ...visualAnalysis.imageDescriptions.map((d: any) => d.description).filter(Boolean),
            visualAnalysis.screenshotAnalysis || '',
          ]
            .filter(Boolean)
            .join(' ');

      // 10. Enhance questions with visual context
      workerLog(
        'visual-enrichment',
        `Enhancing ${questions.length} questions for page ${pageNumber}`,
      );

      const enhancedQuestions = await visionService.enhanceQuestions({
        originalQuestions: questions as any,
        imageDescriptions: visualAnalysis.imageDescriptions,
        visualElements: visualAnalysis.keyVisualElements,
      });

      // 11. Calculate total cost
      const totalEnrichmentCost = visualAnalysis.costUsd;
      const totalEnrichmentTokens = visualAnalysis.tokensUsed;

      // 12. Update chunk with enriched data
      await SearchChunk.findOneAndUpdate(
        { _id: chunkId, tenantId },
        {
          // Update summary to enriched version
          'metadata.progressiveSummary': enrichedSummary,
          'metadata.progressiveSummaryVersion': 2,

          // Add visual analysis data
          'metadata.visualAnalysis': {
            processed: true,
            processedAt: new Date(),
            imageDescriptions: visualAnalysis.imageDescriptions,
            screenshotAnalysis: visualAnalysis.screenshotAnalysis,
            visualContext: visualAnalysis.visualContext,
            enrichmentTokens: totalEnrichmentTokens,
            enrichmentCost: totalEnrichmentCost,
            enrichmentModel: llmConfig.useCases.vision.model,
          },

          // Update costs
          'metadata.totalCost': (chunk.metadata.totalCost || 0) + totalEnrichmentCost,
          'metadata.totalTokens': (chunk.metadata.totalTokens || 0) + totalEnrichmentTokens,
        },
      );

      // 13. Update questions
      for (let i = 0; i < enhancedQuestions.length; i++) {
        const enrichedQ = enhancedQuestions[i];

        if (enrichedQ.isNew) {
          // New visual-specific question
          await ChunkQuestion.create({
            tenantId,
            indexId,
            documentId,
            chunkId,
            question: enrichedQ.question,
            scope: 'chunk',
            questionType: 'other',
            confidence: 0.8,
            questionIndex: questions.length + i,
            questionVersion: 2,
            metadata: {
              visuallyEnriched: true,
              visualElements: enrichedQ.visualElements || [],
              addedInPhase3: true,
              jobId: job.id,
              timestamp: new Date().toISOString(),
            },
          });
        } else if (i < questions.length) {
          // Update existing question
          const originalQuestion = questions[i];
          await ChunkQuestion.findOneAndUpdate(
            { _id: originalQuestion._id, tenantId },
            {
              question: enrichedQ.question,
              questionVersion: 2,
              'metadata.visuallyEnriched': enrichedQ.modified,
              'metadata.visualElements': enrichedQ.visualElements || [],
              'metadata.originalQuestion': enrichedQ.modified
                ? originalQuestion.question
                : undefined,
            },
          );
        }
      }

      const processingTime = Date.now() - startTime;

      workerLog('visual-enrichment', `Page ${pageNumber} enrichment complete`, {
        processingTimeMs: processingTime,
        imageDescriptions: visualAnalysis.imageDescriptions.length,
        questionsModified: enhancedQuestions.filter((q) => q.modified).length,
        questionsAdded: enhancedQuestions.filter((q) => q.isNew).length,
        tokens: totalEnrichmentTokens,
        cost: totalEnrichmentCost.toFixed(6),
      });

      // 14. Enqueue next page or document-level enrichment
      await this.enqueueNextPage(tenantId, indexId, documentId, pageNumber);
    } catch (error) {
      workerError('visual-enrichment', `Page ${pageNumber} enrichment failed`, error);

      // Mark as failed but don't block pipeline
      await SearchChunk.findOneAndUpdate(
        { _id: chunkId, tenantId },
        {
          'metadata.visualAnalysis': {
            processed: false,
            processedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
            imageDescriptions: [],
            visualContext: previousVisualContext || '',
            enrichmentTokens: 0,
            enrichmentCost: 0,
          },
        },
      );

      // Continue to next page despite error
      await this.enqueueNextPage(tenantId, indexId, documentId, pageNumber);

      throw error;
    }
  }

  /**
   * Enqueue next page or document-level enrichment
   */
  private async enqueueNextPage(
    tenantId: string,
    indexId: string,
    documentId: string,
    currentPageNumber: number,
  ): Promise<void> {
    const nextChunk = await SearchChunk.findOne({
      documentId,
      tenantId,
      indexId,
      'metadata.pageNumber': currentPageNumber + 1,
    });

    if (nextChunk) {
      // More pages to process
      workerLog('visual-enrichment', `Enqueuing next page ${currentPageNumber + 1}`);

      await this.queue.add('enrich-page', {
        tenantId,
        indexId,
        documentId,
        pageNumber: currentPageNumber + 1,
        chunkId: nextChunk._id.toString(),
      });
    } else {
      // All pages done → enqueue document-level enrichment
      workerLog('visual-enrichment', `All pages complete, enqueuing document enrichment`, {
        documentId,
      });

      await this.queue.add('enrich-document', {
        tenantId,
        indexId,
        documentId,
      });
    }
  }

  isRunning(): boolean {
    return this.worker.isRunning();
  }

  /**
   * Close worker and cleanup
   */
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

// Export factory function for worker initialization
export function createVisualEnrichmentWorker(concurrency = 3): VisualEnrichmentWorker {
  return new VisualEnrichmentWorker(concurrency);
}
