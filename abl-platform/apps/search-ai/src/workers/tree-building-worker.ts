/**
 * Tree Building Worker
 *
 * BullMQ worker for ATLAS-KG Phase 2: Adaptive Tree Construction
 *
 * Pipeline position: After extraction, before enrichment
 * Processes chunks to build hierarchical tree structure with:
 * - Sentence-aligned boundaries
 * - Semantic grouping (cosine similarity)
 * - Constrained balancing (max depth 4, max children 10)
 * - LLM-generated summaries for internal nodes
 *
 * Stores results in ChunkHierarchy collection.
 */

import { Worker, type Job } from 'bullmq';

import { WorkerLLMClient } from '@agent-platform/llm';
import { TreeBuilderService, ConstrainedBalancer } from '../services/tree-builder/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { getConfig } from '../config/index.js';
import { BULLMQ_CLUSTER_SAFE_PREFIX } from '@agent-platform/redis';
import { getRedisConnection } from './shared.js';
import { workerLog, workerError } from './shared.js';
import { QUEUE_TREE_BUILDING } from '@agent-platform/search-ai-sdk';

import { getLazyModel } from '../db/index.js';
import type {
  ISearchChunk,
  ISearchDocument,
  IChunkHierarchy,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const ChunkHierarchy = getLazyModel<IChunkHierarchy>('ChunkHierarchy'); // → search_ai
export interface TreeBuildingJobData {
  tenantId: string;
  indexId: string;
  documentId: string;
  jobId?: string;
}

export class TreeBuildingWorker {
  private worker: Worker<TreeBuildingJobData>;

  constructor() {
    // Create BullMQ worker
    this.worker = new Worker<TreeBuildingJobData>(QUEUE_TREE_BUILDING, this.processJob.bind(this), {
      connection: getRedisConnection(),
      prefix: BULLMQ_CLUSTER_SAFE_PREFIX,
      concurrency: 2,
      removeOnComplete: {
        count: 100,
        age: 3600, // 1 hour
      },
      removeOnFail: {
        count: 1000,
        age: 86400, // 24 hours
      },
    });

    this.worker.on('completed', (job) => {
      workerLog('tree-building', `Completed document ${job.data.documentId}`);
    });

    this.worker.on('failed', (job, err) => {
      workerError('tree-building', `Failed for document ${job?.data.documentId}`, err);
    });
  }

  /**
   * Process tree building job
   *
   * Creates a per-job LLMClient using resolved per-index config
   * instead of a singleton, ensuring tenant isolation.
   */
  private async processJob(job: Job<TreeBuildingJobData>): Promise<void> {
    const { tenantId, indexId, documentId } = job.data;

    workerLog('tree-building', `Processing document ${documentId}`, { tenantId, indexId });

    try {
      // Resolve per-index LLM configuration (tenant-isolated)
      const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);

      // Use progressiveSummarization use-case config (tree building uses same tier)
      const sumConfig = llmConfig.useCases.progressiveSummarization;
      const llmClient = new WorkerLLMClient(sumConfig.provider, sumConfig.apiKey, sumConfig.model);

      // Get tree builder config from app config
      const config = getConfig();

      // Create tree builder service per job with resolved LLM client
      const treeBuilder = new TreeBuilderService(llmClient, {
        sentenceAlignment: {
          targetChunkSize: config.treeBuilder.targetChunkSize ?? 512,
          maxChunkSize: config.treeBuilder.maxChunkSize ?? 1024,
          minChunkSize: config.treeBuilder.minChunkSize ?? 128,
        },
        semanticSplit: {
          similarityThreshold: config.treeBuilder.similarityThreshold ?? 0.7,
          embeddingDim: 1536,
        },
        balancer: {
          maxDepth: config.treeBuilder.maxDepth ?? 4,
          maxChildrenPerNode: config.treeBuilder.maxChildrenPerNode ?? 10,
          minChildrenPerNode: 2,
        },
        summaryModel: config.treeBuilder.summaryModel ?? sumConfig.model,
        summaryMaxTokens: config.treeBuilder.summaryMaxTokens ?? 200,
        enableSemanticSplitting: config.treeBuilder.enableSemanticSplitting ?? false,
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
        workerLog('tree-building', `No chunks found for document ${documentId}`);
        return;
      }

      workerLog('tree-building', `Building tree from ${chunks.length} chunks`);

      // Build tree structure
      const result = await treeBuilder.buildTreeFromChunks(tenantId, indexId, documentId, chunks);

      workerLog(
        'tree-building',
        `Tree built: ${result.leafCount} leaves, ${result.internalCount} internal nodes`,
        { maxDepth: result.maxDepth },
      );

      // Store hierarchy nodes in database
      const hierarchyDocs = result.nodes.map((node) =>
        ConstrainedBalancer.toChunkHierarchy(node, tenantId, indexId, documentId, {
          buildJobId: job.id,
          buildTimestamp: new Date().toISOString(),
        }),
      );

      // Delete existing hierarchy for this document (if rebuilding)
      await ChunkHierarchy.deleteMany({ tenantId, indexId, documentId });

      // Insert new hierarchy
      await ChunkHierarchy.insertMany(hierarchyDocs);

      workerLog(
        'tree-building',
        `Stored ${hierarchyDocs.length} hierarchy nodes for document ${documentId}`,
      );

      // Update document metadata with tree stats
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId, indexId },
        {
          $set: {
            'metadata.treeStats': {
              leafCount: result.leafCount,
              internalCount: result.internalCount,
              maxDepth: result.maxDepth,
              totalTokens: result.totalTokens,
              rootId: result.rootId,
              buildTimestamp: new Date().toISOString(),
            },
          },
        },
      );

      workerLog('tree-building', `Completed document ${documentId}`);
    } catch (error) {
      workerError('tree-building', `Error processing document ${documentId}`, error);
      throw error;
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
  }
}

// Export factory function for worker initialization
export function createTreeBuildingWorker(): TreeBuildingWorker {
  return new TreeBuildingWorker();
}
