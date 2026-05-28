/**
 * Scope Classification Worker
 *
 * BullMQ worker for ATLAS-KG Phase 5: Scope Classification
 *
 * Pipeline position: After enrichment, parallel with KG/multimodal/embedding
 * Classifies chunk scope (chunk/section/document) and determines retrieval strategy.
 * Stores results in ChunkScope collection.
 *
 * Cost: ~$0.00001/chunk (very cheap, Gemini Flash)
 */

import { Worker, type Job } from 'bullmq';

import { WorkerLLMClient } from '@agent-platform/llm';
import { ScopeClassifierService } from '../services/scope-classifier/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getRedisConnection } from './shared.js';
import { workerLog, workerError, withTraceContext } from './shared.js';
import { QUEUE_SCOPE_CLASSIFICATION } from '@agent-platform/search-ai-sdk';

import { getLazyModel } from '../db/index.js';
import type { ISearchChunk, ISearchDocument, IChunkScope } from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const ChunkScope = getLazyModel<IChunkScope>('ChunkScope'); // → search_ai
export interface ScopeClassificationJobData {
  tenantId: string;
  indexId: string;
  documentId: string;
  jobId?: string;
}

export class ScopeClassificationWorker {
  private worker: Worker<ScopeClassificationJobData>;

  constructor() {
    // Create BullMQ worker
    this.worker = new Worker<ScopeClassificationJobData>(
      QUEUE_SCOPE_CLASSIFICATION,
      this.processJob.bind(this),
      {
        connection: getRedisConnection(),
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: 5,
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
      workerLog('scope-classification', `Completed document ${job.data.documentId}`);
    });

    this.worker.on('failed', (job, err) => {
      workerError('scope-classification', `Failed for document ${job?.data.documentId}`, err);
    });
  }

  /**
   * Process scope classification job
   */
  private async processJob(job: Job<ScopeClassificationJobData>): Promise<void> {
    const { tenantId, indexId, documentId } = job.data;

    workerLog('scope-classification', `Processing document ${documentId}`, { tenantId, indexId });

    await withTraceContext(job.data as unknown as Record<string, unknown>, async () => {
      try {
        // Resolve per-index LLM configuration
        const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

        // Check if scope classification is enabled for this index
        if (!llmConfig.useCases.scopeClassification.enabled) {
          workerLog(
            'scope-classification',
            `Scope classification disabled for index ${indexId}, skipping`,
          );
          return;
        }

        // Create service with per-index configuration
        const llmClient = new WorkerLLMClient(
          llmConfig.useCases.scopeClassification.provider,
          llmConfig.useCases.scopeClassification.apiKey,
          llmConfig.useCases.scopeClassification.model,
        );

        const classifier = new ScopeClassifierService(llmClient, {
          model: llmConfig.useCases.scopeClassification.model,
          maxTokens: llmConfig.useCases.scopeClassification.maxTokens,
        });

        // Fetch all chunks for this document
        const chunks = await SearchChunk.find({
          tenantId,
          indexId,
          documentId,
        })
          .sort({ position: 1 })
          .lean();

        if (chunks.length === 0) {
          workerLog('scope-classification', `No chunks found for document ${documentId}`);
          return;
        }

        // Fetch document for context
        const document = await SearchDocument.findOne({
          _id: documentId,
          tenantId,
          indexId,
        }).lean();

        workerLog('scope-classification', `Classifying scope for ${chunks.length} chunks`);

        // Classify scope for all chunks
        const results = await classifier.classifyBatch(
          chunks.map((chunk: any, index: number) => ({
            content: chunk.content,
            context: {
              documentTitle: (document as any)?.metadata?.title as string | undefined,
              sectionHeading: chunk.metadata?.section as string | undefined,
              position: index,
              totalChunks: chunks.length,
            },
          })),
        );

        // Store scope classifications in database
        const scopeDocs = chunks.map((chunk: any, index: number) => {
          const result = results[index];
          return {
            tenantId,
            indexId,
            documentId,
            chunkId: chunk._id,
            scopeLevel: result.scopeLevel,
            confidence: result.confidence,
            reasoning: result.reasoning,
            retrievalStrategy: result.retrievalStrategy,
            metadata: {
              jobId: job.id,
              timestamp: new Date().toISOString(),
            },
          };
        });

        // Delete existing scope classifications for this document (if reclassifying)
        await ChunkScope.deleteMany({ tenantId, indexId, documentId });

        // Insert new scope classifications
        if (scopeDocs.length > 0) {
          await ChunkScope.insertMany(scopeDocs);
        }

        workerLog(
          'scope-classification',
          `Stored ${scopeDocs.length} scope classifications for document ${documentId}`,
        );

        // Calculate distribution stats
        const distribution = {
          chunk: results.filter((r) => r.scopeLevel === 'chunk').length,
          section: results.filter((r) => r.scopeLevel === 'section').length,
          document: results.filter((r) => r.scopeLevel === 'document').length,
        };

        // Update document metadata with scope classification stats
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId, indexId },
          {
            $set: {
              'metadata.scopeClassificationStats': {
                totalChunks: chunks.length,
                distribution,
                timestamp: new Date().toISOString(),
              },
            },
          },
        );

        workerLog('scope-classification', `Completed document ${documentId}`, { distribution });
      } catch (error) {
        workerError('scope-classification', `Error processing document ${documentId}`, error);
        throw error;
      }
    });
  }

  isRunning(): boolean {
    return this.worker.isRunning();
  }

  /**
   * Close worker and cleanup
   */
  async close(): Promise<void> {
    await this.worker.close();
  }
}

// Export factory function for worker initialization
export function createScopeClassificationWorker(): ScopeClassificationWorker {
  return new ScopeClassificationWorker();
}
