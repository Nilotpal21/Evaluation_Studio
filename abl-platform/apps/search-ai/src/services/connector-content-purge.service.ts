/**
 * Connector Content Purge Service
 *
 * Manages content purge operations: initiate, poll status, cancel, retry.
 * Purge deletes documents, chunks, and vector embeddings for a connector
 * while preserving the connector configuration.
 */

import { createLogger } from '@abl/compiler/platform';
import type { IConnectorConfig, IConnectorCleanupJob } from '@agent-platform/database';
import { getLazyModel } from '../db/index.js';
import { ConnectorError } from './connector.service.js';
import { writeAuditEntry } from './connector-audit.service.js';

const logger = createLogger('connector-content-purge');

const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const ConnectorCleanupJob = getLazyModel<IConnectorCleanupJob>('ConnectorCleanupJob');

// ─── Types ────────────────────────────────────────────────────────────────

export interface CleanupStatus {
  cleanupId: string;
  status: 'idle' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  documents: { total: number; removed: number };
  chunks: { total: number; removed: number };
  vectorEmbeddings: { total: number; removed: number };
  estimatedTimeRemaining: number | null;
  error: string | null;
}

// ─── Service Functions ───────────────────────────────────────────────────

export async function initiatePurge(
  connectorId: string,
  tenantId: string,
  indexId: string,
  actor: string,
): Promise<{ cleanupId: string; status: 'in_progress' }> {
  const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Check sync conflict
  const syncState = (connector as Record<string, unknown>).syncState as
    | Record<string, unknown>
    | undefined;
  if (syncState?.syncInProgress) {
    throw new ConnectorError(
      'SYNC_IN_PROGRESS',
      'Cannot purge content while sync is in progress',
      409,
    );
  }

  const sourceId = (connector as Record<string, unknown>).sourceId as string | undefined;
  if (sourceId) {
    const SearchSource = getLazyModel('SearchSource');
    const source = await SearchSource.findOne({ _id: sourceId, tenantId, indexId }).lean();
    if (!source) {
      throw new ConnectorError('NOT_FOUND', 'Connector source not found', 404);
    }
  }

  // Count existing content
  const SearchDocument = getLazyModel('SearchDocument');
  const SearchChunk = getLazyModel('SearchChunk');

  let documentCount = 0;
  let chunkCount = 0;
  if (sourceId) {
    [documentCount, chunkCount] = await Promise.all([
      SearchDocument.countDocuments({ sourceId, tenantId, indexId }),
      SearchChunk.countDocuments({ sourceId, tenantId, indexId }),
    ]);
  }

  // Create cleanup job
  const job = await ConnectorCleanupJob.create({
    connectorId,
    tenantId,
    status: 'in_progress',
    documents: { total: documentCount, removed: 0 },
    chunks: { total: chunkCount, removed: 0 },
    vectorEmbeddings: { total: chunkCount, removed: 0 },
    estimatedTimeRemaining: null,
    error: null,
    startedAt: new Date(),
    completedAt: null,
    initiatedBy: actor,
  });

  // Write audit entry
  try {
    await writeAuditEntry({
      connectorId,
      tenantId,
      actor,
      actorType: 'user',
      event: 'content.purge_initiated',
      category: 'lifecycle',
      metadata: { cleanupId: job._id, documentCount, chunkCount },
    });
  } catch (auditErr) {
    logger.error('Failed to write audit entry for purge initiation', {
      connectorId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  // Async purge (in batches) — run in background
  runPurgeAsync(job._id, sourceId ?? '', tenantId, indexId).catch((err) => {
    logger.error('Background purge failed', {
      cleanupId: job._id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  logger.info('Content purge initiated', { connectorId, cleanupId: job._id });

  return { cleanupId: job._id, status: 'in_progress' };
}

export async function getPurgeStatus(
  cleanupId: string,
  tenantId: string,
  connectorId: string,
): Promise<CleanupStatus> {
  const job = await ConnectorCleanupJob.findOne({ _id: cleanupId, tenantId, connectorId }).lean();
  if (!job) {
    throw new ConnectorError('NOT_FOUND', 'Cleanup job not found', 404);
  }

  return {
    cleanupId: job._id,
    status: job.status,
    documents: job.documents,
    chunks: job.chunks,
    vectorEmbeddings: job.vectorEmbeddings,
    estimatedTimeRemaining: job.estimatedTimeRemaining,
    error: job.error,
  };
}

export async function cancelPurge(
  cleanupId: string,
  tenantId: string,
  connectorId: string,
): Promise<CleanupStatus> {
  const job = await ConnectorCleanupJob.findOneAndUpdate(
    { _id: cleanupId, tenantId, connectorId, status: 'in_progress' },
    { $set: { status: 'cancelled' } },
    { new: true },
  ).lean();

  if (!job) {
    throw new ConnectorError('NOT_FOUND', 'Active cleanup job not found', 404);
  }

  return {
    cleanupId: job._id,
    status: job.status,
    documents: job.documents,
    chunks: job.chunks,
    vectorEmbeddings: job.vectorEmbeddings,
    estimatedTimeRemaining: null,
    error: null,
  };
}

export async function retryPurge(
  cleanupId: string,
  tenantId: string,
  connectorId: string,
  indexId: string,
): Promise<CleanupStatus> {
  const job = await ConnectorCleanupJob.findOne({ _id: cleanupId, tenantId, connectorId }).lean();
  if (!job) {
    throw new ConnectorError('NOT_FOUND', 'Cleanup job not found', 404);
  }

  if (job.status !== 'failed') {
    throw new ConnectorError('INVALID_STATE', 'Only failed cleanup jobs can be retried', 400);
  }

  await ConnectorCleanupJob.findOneAndUpdate(
    { _id: cleanupId, tenantId, connectorId },
    { $set: { status: 'in_progress', error: null } },
  );

  const connector = await ConnectorConfig.findOne({
    _id: connectorId,
    tenantId,
  }).lean();
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }
  const sourceId = (connector as Record<string, unknown>)?.sourceId as string | undefined;
  if (sourceId) {
    const SearchSource = getLazyModel('SearchSource');
    const source = await SearchSource.findOne({ _id: sourceId, tenantId, indexId }).lean();
    if (!source) {
      throw new ConnectorError('NOT_FOUND', 'Connector source not found', 404);
    }
  }

  // Resume async purge
  runPurgeAsync(cleanupId, sourceId ?? '', tenantId, indexId).catch((err) => {
    logger.error('Background purge retry failed', {
      cleanupId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    cleanupId,
    status: 'in_progress',
    documents: job.documents,
    chunks: job.chunks,
    vectorEmbeddings: job.vectorEmbeddings,
    estimatedTimeRemaining: null,
    error: null,
  };
}

// ─── Background Purge (batch deletion) ───────────────────────────────────

const BATCH_SIZE = 100;

async function runPurgeAsync(
  cleanupId: string,
  sourceId: string,
  tenantId: string,
  indexId: string,
): Promise<void> {
  const SearchDocument = getLazyModel('SearchDocument');
  const SearchChunk = getLazyModel('SearchChunk');
  const ChunkQuestion = getLazyModel('ChunkQuestion');
  const SearchSource = getLazyModel('SearchSource');

  try {
    if (!sourceId) {
      await ConnectorCleanupJob.findOneAndUpdate(
        { _id: cleanupId, tenantId },
        { $set: { status: 'completed', completedAt: new Date() } },
      );
      return;
    }

    // Source/index binding is rechecked so async retries cannot purge a moved source.
    const source = await SearchSource.findOne({ _id: sourceId, tenantId, indexId }).lean();
    if (!source) {
      throw new Error(`Source ${sourceId} not found`);
    }

    // Delete questions first (they reference chunks)
    let questionsRemoved = 0;
    let hasMoreQuestions = true;
    while (hasMoreQuestions) {
      // Check for cancellation
      const currentJob = await ConnectorCleanupJob.findOne({ _id: cleanupId, tenantId }).lean();
      if (currentJob?.status === 'cancelled') return;

      // Find questions for documents from this source
      const documentsInSource = await SearchDocument.find({ sourceId, tenantId, indexId })
        .select('_id')
        .limit(BATCH_SIZE)
        .lean();

      if (documentsInSource.length === 0) {
        hasMoreQuestions = false;
        break;
      }

      const documentIds = documentsInSource.map((d: Record<string, unknown>) => d._id);
      const questionsToDelete = await ChunkQuestion.find({
        documentId: { $in: documentIds },
        tenantId,
      })
        .select('_id')
        .limit(BATCH_SIZE)
        .lean();

      if (questionsToDelete.length === 0) {
        hasMoreQuestions = false;
        break;
      }

      const questionIds = questionsToDelete.map((q: Record<string, unknown>) => q._id);
      await ChunkQuestion.deleteMany({ _id: { $in: questionIds }, tenantId });
      questionsRemoved += questionsToDelete.length;

      logger.debug('Deleted question batch', {
        cleanupId,
        batchSize: questionsToDelete.length,
        totalRemoved: questionsRemoved,
      });
    }

    logger.info('Deleted all questions for source', {
      cleanupId,
      sourceId,
      questionsRemoved,
    });

    // Delete documents with proper vector store cleanup (batched)
    // Documents are deleted in batches with their chunks and vectors
    const { deleteDocumentsWithVectorCleanup } = await import('./document-cleanup.service.js');

    let docsRemoved = 0;
    let chunksRemoved = 0;
    let hasMoreDocs = true;

    while (hasMoreDocs) {
      // Check for cancellation
      const currentJob = await ConnectorCleanupJob.findOne({ _id: cleanupId, tenantId }).lean();
      if (currentJob?.status === 'cancelled') return;

      const docsToDelete = await SearchDocument.find({ sourceId, tenantId, indexId })
        .select('_id')
        .limit(BATCH_SIZE)
        .lean();

      if (docsToDelete.length === 0) {
        hasMoreDocs = false;
        break;
      }

      const documentIds = docsToDelete.map((d: Record<string, unknown>) => String(d._id));

      // Delete with vector cleanup
      const cleanupResult = await deleteDocumentsWithVectorCleanup(documentIds, tenantId, indexId);

      docsRemoved += cleanupResult.deletedCount;
      chunksRemoved += cleanupResult.chunkCount;

      await ConnectorCleanupJob.findOneAndUpdate(
        { _id: cleanupId, tenantId },
        {
          $set: {
            'documents.removed': docsRemoved,
            'chunks.removed': chunksRemoved,
            'vectorEmbeddings.removed': chunksRemoved + cleanupResult.questionCount,
          },
        },
      );
    }

    // Mark completed
    await ConnectorCleanupJob.findOneAndUpdate(
      { _id: cleanupId, tenantId },
      { $set: { status: 'completed', completedAt: new Date() } },
    );

    logger.info('Content purge completed', {
      cleanupId,
      docsRemoved,
      chunksRemoved,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Content purge failed', { cleanupId, error: errorMsg });
    await ConnectorCleanupJob.findOneAndUpdate(
      { _id: cleanupId, tenantId },
      { $set: { status: 'failed', error: errorMsg } },
    );
  }
}
