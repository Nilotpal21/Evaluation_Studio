/**
 * Question Synthesis Worker
 *
 * BullMQ worker for ATLAS-KG Phase 5: Question Synthesis
 *
 * Pipeline position: After enrichment, parallel with KG/multimodal/embedding
 * Generates 3-5 answerable questions per chunk for question-based retrieval.
 * Stores results in ChunkQuestion collection.
 *
 * Cost: ~$0.00017/chunk (Gemini Flash)
 */

import { Worker, type Job } from 'bullmq';

import { WorkerLLMClient } from '@agent-platform/llm';
import { QuestionSynthesisService } from '../services/question-synthesis/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getRedisConnection } from './shared.js';
import { workerLog, workerError, withTraceContext } from './shared.js';
import { QUEUE_QUESTION_SYNTHESIS } from '@agent-platform/search-ai-sdk';

import { getLazyModel } from '../db/index.js';
import type {
  ISearchChunk,
  ISearchDocument,
  IChunkQuestion,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const ChunkQuestion = getLazyModel<IChunkQuestion>('ChunkQuestion'); // → search_ai
export interface QuestionSynthesisJobData {
  tenantId: string;
  indexId: string;
  documentId: string;
  jobId?: string;
}

export class QuestionSynthesisWorker {
  private worker: Worker<QuestionSynthesisJobData>;

  constructor() {
    // Create BullMQ worker
    this.worker = new Worker<QuestionSynthesisJobData>(
      QUEUE_QUESTION_SYNTHESIS,
      this.processJob.bind(this),
      {
        connection: getRedisConnection(),
        prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
        concurrency: 3,
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
      workerLog('question-synthesis', `Completed document ${job.data.documentId}`);
    });

    this.worker.on('failed', (job, err) => {
      workerError('question-synthesis', `Failed for document ${job?.data.documentId}`, err);
    });
  }

  /**
   * Process question synthesis job
   */
  private async processJob(job: Job<QuestionSynthesisJobData>): Promise<void> {
    const { tenantId, indexId, documentId } = job.data;

    workerLog('question-synthesis', `Processing document ${documentId}`, { tenantId, indexId });

    await withTraceContext(job.data as unknown as Record<string, unknown>, async () => {
      try {
        // Resolve per-index LLM configuration
        const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

        // Check if question synthesis is enabled
        if (!llmConfig.useCases.questionSynthesis.enabled) {
          workerLog(
            'question-synthesis',
            `Question synthesis disabled for index ${indexId}, skipping`,
          );
          return;
        }

        // Create service with per-index configuration
        const llmClient = new WorkerLLMClient(
          llmConfig.useCases.questionSynthesis.provider,
          llmConfig.useCases.questionSynthesis.apiKey,
          llmConfig.useCases.questionSynthesis.model,
        );

        const synthesizer = new QuestionSynthesisService(llmClient, {
          model: llmConfig.useCases.questionSynthesis.model,
          questionsPerChunk: llmConfig.useCases.questionSynthesis.questionsPerChunk,
          maxTokens: llmConfig.useCases.questionSynthesis.maxTokens,
          enableEmbedding: llmConfig.useCases.questionSynthesis.enableEmbedding,
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
          workerLog('question-synthesis', `No chunks found for document ${documentId}`);
          return;
        }

        // Fetch document for context
        const document = await SearchDocument.findOne({
          _id: documentId,
          tenantId,
          indexId,
        }).lean();

        workerLog('question-synthesis', `Generating questions for ${chunks.length} chunks`);

        // Generate questions for all chunks
        const results = await synthesizer.generateQuestionsBatch(
          chunks.map((chunk: any) => ({
            content: chunk.content,
            context: {
              documentTitle: (document as any)?.metadata?.title as string | undefined,
              documentType: (document as any)?.metadata?.type as string | undefined,
              sectionHeading: chunk.metadata?.section as string | undefined,
            },
          })),
        );

        // Store questions in database
        const questionDocs = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const result = results[i];

          for (let j = 0; j < result.questions.length; j++) {
            const question = result.questions[j];
            questionDocs.push({
              tenantId,
              indexId,
              documentId,
              chunkId: chunk._id,
              question: question.question,
              questionType: question.questionType,
              confidence: question.confidence,
              vectorId: null, // Will be populated by embedding worker if enabled
              questionIndex: j,
              metadata: {
                jobId: job.id,
                timestamp: new Date().toISOString(),
              },
            });
          }
        }

        // Delete existing questions for this document (if regenerating)
        // CRITICAL: Delete from BOTH MongoDB AND OpenSearch to prevent duplicates
        const existingQuestions = await ChunkQuestion.find({
          tenantId,
          indexId,
          documentId,
        }).lean();

        // Delete from OpenSearch first (if questions were embedded)
        if (existingQuestions.length > 0) {
          try {
            const { createVectorStore } = await import('@agent-platform/search-ai-internal');
            const { getLazyModel } = await import('../db/index.js');
            const SearchIndex = getLazyModel('SearchIndex');

            const searchIndex = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
            const vectorIndexName = (searchIndex as any)?.activeVectorIndex;

            if (vectorIndexName) {
              const vectorStore = createVectorStore({
                provider: 'opensearch',
                url: (process.env.OPENSEARCH_URL || process.env.VECTOR_STORE_URL)!,
                apiKey: process.env.OPENSEARCH_PASSWORD || process.env.VECTOR_STORE_API_KEY,
              });

              // Delete old question vectors using their IDs
              const questionIds = existingQuestions.map((q: any) => String(q._id));
              if (questionIds.length > 0) {
                await vectorStore.delete(vectorIndexName, questionIds);
                workerLog(
                  'question-synthesis',
                  `Deleted ${questionIds.length} old question vectors from OpenSearch`,
                );
              }
            }
          } catch (vectorDeleteError) {
            // Non-fatal but log warning - old vectors may remain
            workerError(
              'question-synthesis',
              'Failed to delete old question vectors from OpenSearch',
              vectorDeleteError instanceof Error
                ? vectorDeleteError
                : new Error(String(vectorDeleteError)),
            );
          }
        }

        // Delete from MongoDB
        await ChunkQuestion.deleteMany({ tenantId, indexId, documentId });

        // Insert new questions
        if (questionDocs.length > 0) {
          await ChunkQuestion.insertMany(questionDocs);
        }

        workerLog(
          'question-synthesis',
          `Stored ${questionDocs.length} questions for document ${documentId}`,
        );

        // Update document metadata with question synthesis stats
        const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
        const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);

        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId, indexId },
          {
            $set: {
              'metadata.questionSynthesisStats': {
                questionsGenerated: questionDocs.length,
                chunksProcessed: chunks.length,
                totalTokens,
                totalCost,
                timestamp: new Date().toISOString(),
              },
            },
          },
        );

        workerLog('question-synthesis', `Completed document ${documentId}`, {
          questionsGenerated: questionDocs.length,
          cost: `$${totalCost.toFixed(6)}`,
        });
      } catch (error) {
        workerError('question-synthesis', `Error processing document ${documentId}`, error);
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
export function createQuestionSynthesisWorker(): QuestionSynthesisWorker {
  return new QuestionSynthesisWorker();
}
