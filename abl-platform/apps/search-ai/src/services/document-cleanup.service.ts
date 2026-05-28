/**
 * Document Cleanup Service
 *
 * Centralized service for deleting documents with proper vector store cleanup.
 * CRITICAL: Always delete from vector store FIRST before MongoDB to prevent orphaned vectors.
 *
 * Also handles cascading cleanup of FieldMappings and DomainVocabulary:
 * - Source deletion → remove that source's FieldMappings + prune orphaned vocab entries
 * - All documents gone (documentCount → 0) → full reset of fields, vocab, jsonFieldConfig
 *
 * All deletion code paths MUST use this service to ensure consistency.
 */

import { createVectorStore, type VectorStoreProvider } from '@agent-platform/search-ai-internal';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('document-cleanup');

const SearchDocument = getLazyModel('SearchDocument');
const SearchChunk = getLazyModel('SearchChunk');
const ChunkQuestion = getLazyModel('ChunkQuestion');

/**
 * Resolve vector index name for deletion
 */
async function resolveVectorIndexName(
  vectorStore: VectorStoreProvider,
  tenantId: string,
  indexId: string,
  sourceId?: string,
): Promise<string> {
  // Try SearchIndex.activeVectorIndex first
  try {
    const SearchIndex = getLazyModel('SearchIndex');
    const index = await SearchIndex.findOne({ _id: indexId, tenantId })
      .select('activeVectorIndex vectorIndexHistory vectorStore')
      .lean();

    if (index) {
      const activeIndex = (index as any).activeVectorIndex;
      if (activeIndex) return activeIndex as string;

      // Fallback to vectorStore.collectionName
      const collectionName = (index as any).vectorStore?.collectionName;
      if (collectionName) return collectionName as string;
    }
  } catch {
    // Fall through
  }

  // Last resort: use indexId as collection name
  return indexId;
}

/**
 * Delete documents with proper vector store cleanup
 *
 * @param documentIds - Array of document IDs to delete
 * @param tenantId - Tenant ID
 * @param indexId - SearchIndex ID
 * @returns Object with deletion stats and any failures
 */
export async function deleteDocumentsWithVectorCleanup(
  documentIds: string[],
  tenantId: string,
  indexId: string,
): Promise<{
  success: boolean;
  deletedCount: number;
  chunkCount: number;
  questionCount: number;
  failures: Array<{ documentId: string; error: string }>;
}> {
  if (documentIds.length === 0) {
    return { success: true, deletedCount: 0, chunkCount: 0, questionCount: 0, failures: [] };
  }

  const failures: Array<{ documentId: string; error: string }> = [];
  let totalChunks = 0;
  let totalQuestions = 0;

  // Initialize vector store
  const vectorStore: VectorStoreProvider = createVectorStore({
    provider:
      (process.env.VECTOR_STORE_PROVIDER as 'opensearch' | 'qdrant' | 'pinecone' | 'pgvector') ||
      'opensearch',
    url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
    apiKey: process.env.VECTOR_STORE_API_KEY,
  });

  // Get vector index name
  const vsIndexName = await resolveVectorIndexName(vectorStore, tenantId, indexId);

  // Process each document
  for (const documentId of documentIds) {
    try {
      // Fetch all chunk IDs and question IDs for this document
      const chunks = await SearchChunk.find({ documentId, tenantId, indexId }).select('_id').lean();
      const chunkIds = chunks.map((c) => String(c._id));

      const questions = await ChunkQuestion.find({ documentId, tenantId }).select('_id').lean();
      const questionIds = questions.map((q) => String(q._id));

      const allVectorIds = [...chunkIds, ...questionIds];

      // Delete vectors FIRST (with retry)
      if (allVectorIds.length > 0) {
        let vectorDeleteSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await vectorStore.delete(vsIndexName, allVectorIds);
            vectorDeleteSuccess = true;
            logger.debug('Deleted vectors for document', {
              documentId,
              chunkCount: chunkIds.length,
              questionCount: questionIds.length,
            });
            break;
          } catch (err) {
            logger.warn('Vector delete attempt failed', {
              attempt,
              documentId,
              error: err instanceof Error ? err.message : String(err),
            });
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
          }
        }

        if (!vectorDeleteSuccess) {
          failures.push({
            documentId,
            error: 'Vector store cleanup failed after 3 retries',
          });
          // Mark document as delete-pending for background retry
          await SearchDocument.findOneAndUpdate(
            { _id: documentId, tenantId, indexId },
            {
              $set: {
                status: 'delete-pending',
                processingError: 'Vector store cleanup failed',
              },
            },
          );
          continue; // Skip MongoDB deletion for this document
        }
      }

      // Only delete from MongoDB if vector deletion succeeded
      await ChunkQuestion.deleteMany({ documentId, tenantId });
      await SearchChunk.deleteMany({ documentId, tenantId, indexId });
      await SearchDocument.deleteOne({ _id: documentId, tenantId, indexId });

      totalChunks += chunkIds.length;
      totalQuestions += questionIds.length;
    } catch (error) {
      failures.push({
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error('Failed to delete document', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deletedCount = documentIds.length - failures.length;
  const success = failures.length === 0;

  logger.info('Bulk document deletion completed', {
    requestedCount: documentIds.length,
    deletedCount,
    totalChunks,
    totalQuestions,
    failureCount: failures.length,
  });

  return {
    success,
    deletedCount,
    chunkCount: totalChunks,
    questionCount: totalQuestions,
    failures,
  };
}

/**
 * Delete all documents for a source with proper vector cleanup
 */
export async function deleteSourceDocuments(
  sourceId: string,
  tenantId: string,
  indexId: string,
): Promise<{ success: boolean; deletedCount: number; chunkCount: number; failures: any[] }> {
  const documentIds = await SearchDocument.distinct('_id', { sourceId, tenantId, indexId });
  return deleteDocumentsWithVectorCleanup(
    documentIds.map((id) => String(id)),
    tenantId,
    indexId,
  );
}

// ─── Field & Vocabulary Cleanup ─────────────────────────────────────────────

/**
 * Case 1: Source-level cleanup.
 *
 * When a source is deleted, remove its FieldMappings and prune vocab entries
 * whose fieldRef no longer has any remaining FieldMappings from other sources.
 * Manual vocab entries are always preserved.
 */
export async function cleanupFieldsForSource(
  tenantId: string,
  indexId: string,
  connectorId: string,
): Promise<{ deletedMappings: number; prunedVocabEntries: number }> {
  const FieldMapping = getLazyModel('FieldMapping');
  const CanonicalSchema = getLazyModel('CanonicalSchema');
  const DomainVocabulary = getLazyModel('DomainVocabulary');

  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId: indexId,
    tenantId,
    status: 'active',
  }).lean();

  if (!schema) {
    return { deletedMappings: 0, prunedVocabEntries: 0 };
  }

  // Snapshot the canonical fields this connector owns BEFORE deletion
  const connectorMappings = await FieldMapping.find({
    canonicalSchemaId: (schema as any)._id,
    connectorId,
    tenantId,
  })
    .select('canonicalField')
    .lean();

  const affectedFields = new Set(
    (connectorMappings as any[]).map((m) => m.canonicalField as string),
  );

  // Delete all FieldMappings for this connector
  const deleteResult = await FieldMapping.deleteMany({
    canonicalSchemaId: (schema as any)._id,
    connectorId,
    tenantId,
  });
  const deletedMappings = (deleteResult as any).deletedCount ?? 0;

  logger.info('Deleted FieldMappings for source', {
    connectorId,
    indexId,
    deletedMappings,
    affectedFields: [...affectedFields],
  });

  // Check which affected fields still have mappings from OTHER sources
  let prunedVocabEntries = 0;
  if (affectedFields.size > 0) {
    const remaining = (await FieldMapping.distinct('canonicalField', {
      canonicalSchemaId: (schema as any)._id,
      tenantId,
      canonicalField: { $in: [...affectedFields] },
    })) as string[];
    const stillMapped = new Set(remaining);
    const orphanedFields = [...affectedFields].filter((f) => !stillMapped.has(f));

    if (orphanedFields.length > 0) {
      prunedVocabEntries = await pruneVocabEntries(tenantId, indexId, orphanedFields);
    }
  }

  return { deletedMappings, prunedVocabEntries };
}

/**
 * Case 2: Full cleanup when documentCount reaches 0.
 *
 * Removes ALL FieldMappings and auto-generated vocab entries for this KB.
 * Also clears jsonFieldConfig on the SearchIndex. Manual vocab is preserved.
 */
export async function cleanupAllFieldsAndVocab(
  tenantId: string,
  indexId: string,
): Promise<{ deletedMappings: number; deletedVocabEntries: number; clearedJsonConfig: boolean }> {
  const FieldMapping = getLazyModel('FieldMapping');
  const CanonicalSchema = getLazyModel('CanonicalSchema');
  const DomainVocabulary = getLazyModel('DomainVocabulary');
  const SearchIndex = getLazyModel('SearchIndex');
  const KnowledgeBase = getLazyModel('KnowledgeBase');

  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId: indexId,
    tenantId,
    status: 'active',
  }).lean();

  let deletedMappings = 0;
  if (schema) {
    const result = await FieldMapping.deleteMany({
      canonicalSchemaId: (schema as any)._id,
      tenantId,
    });
    deletedMappings = (result as any).deletedCount ?? 0;
  }

  // Clear auto-generated vocab entries (keep manual)
  let deletedVocabEntries = 0;
  const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).select('_id').lean();
  const kbId = (kb as any)?._id;

  if (kbId) {
    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: kbId,
      tenantId,
    });
    if (vocab) {
      const before = (vocab as any).entries.length;
      (vocab as any).entries = (vocab as any).entries.filter(
        (e: any) => e.generatedBy === 'manual',
      );
      deletedVocabEntries = before - (vocab as any).entries.length;
      if (deletedVocabEntries > 0) {
        (vocab as any).version += 1;
        await (vocab as any).save();
      }
    }
  }

  // Clear jsonFieldConfig
  let clearedJsonConfig = false;
  const updated = await SearchIndex.findOneAndUpdate(
    { _id: indexId, tenantId, jsonFieldConfig: { $exists: true } },
    { $unset: { jsonFieldConfig: '' } },
  );
  clearedJsonConfig = !!updated;

  logger.info('Full field + vocab cleanup (documentCount reached 0)', {
    indexId,
    deletedMappings,
    deletedVocabEntries,
    clearedJsonConfig,
  });

  return { deletedMappings, deletedVocabEntries, clearedJsonConfig };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Remove auto-generated vocab entries for orphaned canonical fields.
 */
async function pruneVocabEntries(
  tenantId: string,
  indexId: string,
  orphanedFields: string[],
): Promise<number> {
  const DomainVocabulary = getLazyModel('DomainVocabulary');
  const KnowledgeBase = getLazyModel('KnowledgeBase');

  const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).select('_id').lean();
  const kbId = (kb as any)?._id;
  if (!kbId) return 0;

  const vocab = await DomainVocabulary.findOne({
    projectKnowledgeBaseId: kbId,
    tenantId,
  });
  if (!vocab) return 0;

  const orphanSet = new Set(orphanedFields);
  const before = (vocab as any).entries.length;
  (vocab as any).entries = (vocab as any).entries.filter(
    (e: any) => e.generatedBy === 'manual' || !orphanSet.has(e.fieldRef),
  );
  const pruned = before - (vocab as any).entries.length;

  if (pruned > 0) {
    (vocab as any).version += 1;
    await (vocab as any).save();
    logger.info('Pruned orphaned vocab entries', {
      indexId,
      orphanedFields,
      prunedCount: pruned,
    });
  }

  return pruned;
}
