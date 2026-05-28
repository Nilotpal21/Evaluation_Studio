/**
 * Canonical Mapper Worker
 *
 * Picks up CanonicalMapJobData from QUEUE_CANONICAL_MAP and applies
 * canonical field mappings to SearchChunk metadata.
 *
 * Note: Chunks are already created by page-processing-worker in the
 * modern Docling pipeline. This worker only applies metadata mappings.
 *
 * If enrichment is not skipped (default), it enqueues enrichment jobs
 * to QUEUE_ENRICHMENT. Otherwise it moves chunks directly to the
 * embedding queue.
 *
 * Flow: ingest --> extract --> page-processing --> canonical-map --> enrich --> embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  QUEUE_CANONICAL_MAP,
  QUEUE_ENRICHMENT,
  QUEUE_EMBEDDING,
  DocumentStatus,
  ChunkStatus,
} from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';
import type { ISearchDocument, ISearchChunk, ISearchIndex } from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform

import { withTenantContext } from '@agent-platform/database/mongo';
import {
  createQueue,
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
} from './shared.js';
import type { CanonicalMapJobData, EnrichmentJobData, EmbeddingJobData } from './shared.js';
import { getCanonicalMapperService } from '../services/canonical-mapping/canonical-mapper.service.js';
import { AVAILABLE_CANONICAL_FIELDS } from '@agent-platform/search-ai-internal';

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

export async function processCanonicalMapJob(job: Job<CanonicalMapJobData>): Promise<void> {
  const { indexId, documentId, tenantId } = job.data;

  workerLog('canonical-mapper', `Processing document ${documentId}`, { indexId });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // ── 1. Load the document and index ────────────────────────────────────
      const [document, index] = await Promise.all([
        SearchDocument.findOne({ _id: documentId, indexId }),
        SearchIndex.findOne({ _id: indexId, tenantId }).lean(),
      ]);

      if (!document) {
        throw new Error(`Document ${documentId} not found in index ${indexId}`);
      }
      if (!index) {
        throw new Error(`Index ${indexId} not found`);
      }

      try {
        // ── 2. Load existing chunks (created by page-processing-worker) ──────
        // In the Docling pipeline, chunks are already created from DocumentPages.
        // The canonical-mapper just applies field mappings and routes to enrichment.
        const existingChunks = await SearchChunk.find({
          indexId,
          documentId,
          tenantId,
        }).lean();

        if (existingChunks.length === 0) {
          // No chunks exist - this should not happen with Docling pipeline
          // All documents should go through page-processing-worker first
          throw new Error(
            `No chunks found for document ${documentId}. ` +
              `Ensure page-processing-worker has completed before canonical-mapper.`,
          );
        } else {
          // New Docling pipeline: apply canonical mapping to existing chunks
          workerLog(
            'canonical-mapper',
            `Applying canonical mapping to ${existingChunks.length} existing chunks`,
          );

          const service = getCanonicalMapperService();
          const mappingResult = await service.applyMapping(
            document.sourceMetadata as Record<string, unknown> | null,
            tenantId,
            document.connectorId,
          );

          // Log any transform errors
          if (mappingResult.errors.length > 0) {
            workerLog(
              'canonical-mapper',
              `Mapping completed with ${mappingResult.errors.length} error(s)`,
              { errors: mappingResult.errors },
            );
          }

          // ── 3. Build default canonical fields from document properties ──────
          // These are always available regardless of FieldMapping configuration.
          // Connector-specific FieldMappings (from applyMapping) take precedence.
          const defaultCanonical = buildDefaultCanonicalFields(document, index);

          // Merge: defaults first, then connector mappings override
          const finalCanonical: Record<string, unknown> = {
            ...defaultCanonical,
            ...mappingResult.canonicalMetadata,
          };

          // Remove any raw pass-through keys that aren't canonical field names
          // (e.g., file_upload, charCount from the old pass-through behavior)
          const canonicalFieldNames = new Set(
            AVAILABLE_CANONICAL_FIELDS.map((f) => f.storageField),
          );
          for (const key of Object.keys(finalCanonical)) {
            if (!canonicalFieldNames.has(key)) {
              delete finalCanonical[key];
            }
          }

          workerLog('canonical-mapper', 'Built canonical metadata', {
            fieldCount: Object.keys(finalCanonical).length,
            fields: Object.keys(finalCanonical),
          });

          // Update chunks with canonical metadata
          await SearchChunk.updateMany(
            { indexId, documentId, tenantId },
            {
              $set: {
                canonicalMetadata: finalCanonical,
              },
            },
          );

          workerLog(
            'canonical-mapper',
            `Updated ${existingChunks.length} chunks with canonical metadata`,
          );
        }

        // Get final chunk IDs and count
        const chunks = await SearchChunk.find({ indexId, documentId, tenantId })
          .select('_id')
          .lean();
        const chunkIds = chunks.map((c) => c._id);
        const chunkCount = chunkIds.length;

        // ── 5. Update document status ─────────────────────────────────────────
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            chunkCount: chunkCount,
            status: DocumentStatus.ENRICHED,
          },
        );

        // ── 6. Enqueue enrichment ─────────────────────────────────────────────
        const enrichmentQueue = createQueue(QUEUE_ENRICHMENT);
        try {
          const enrichmentData: EnrichmentJobData = {
            indexId,
            documentId,
            chunkIds,
            tenantId,
          };

          await enrichmentQueue.add(`enrich:${documentId}`, enrichmentData, {
            jobId: `enrich:${indexId}:${documentId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
          });
        } finally {
          await enrichmentQueue.close();
        }

        workerLog(
          'canonical-mapper',
          `Processed ${chunkCount} chunk(s) for document ${documentId}`,
          {
            indexId,
          },
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ERROR,
            processingError: `Canonical mapping failed: ${errMsg}`,
          },
        );
        throw error;
      }
    }),
  );
}

// =============================================================================
// DEFAULT CANONICAL FIELD EXTRACTION
// =============================================================================
// Always populate core canonical fields from document-level properties.
// These provide baseline metadata for filtering even when no FieldMappings
// are configured (e.g., direct file uploads without a connector).
// Connector-specific FieldMappings (from CanonicalMapperService) take
// precedence — they are merged ON TOP of these defaults.

/**
 * Build default canonical field values from document and index properties.
 *
 * Maps well-known document fields to canonical storage fields:
 *  - title           ← document.name or originalReference (filename)
 *  - mime_type       ← document.contentType
 *  - source_type     ← derived from contentType (e.g., "pdf", "markdown", "spreadsheet")
 *  - source_url      ← document.sourceUrl or originalReference
 *  - created_date    ← document.createdAt (ISO string)
 *  - modified_date   ← document.updatedAt (ISO string)
 *  - language        ← document.language
 *  - status          ← document.status
 *  - content_summary ← metadata.documentSummary (LLM summary, truncated to 500 chars)
 *  - author          ← from sourceMetadata if available
 *  - category        ← from classification or sourceMetadata
 */
export function buildDefaultCanonicalFields(
  document: ISearchDocument,
  _index: ISearchIndex,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  const srcMeta = (document.sourceMetadata ?? {}) as Record<string, unknown>;
  const fileMeta = (srcMeta.file_upload ?? srcMeta) as Record<string, unknown>;

  // ── Core fields ──────────────────────────────────────────────────────────

  // title: prefer document.name, then sourceMetadata title, then originalReference
  const title =
    document.name || (fileMeta.title as string | undefined) || document.originalReference;
  if (title) canonical.title = title;

  // mime_type
  const mimeType = document.contentType || (fileMeta.mimeType as string | undefined);
  if (mimeType) canonical.mime_type = mimeType;

  // source_type: derive a human-readable type from MIME or filename extension
  if (mimeType) {
    canonical.source_type = deriveSourceType(mimeType, document.originalReference);
  }

  // source_url — use the external-facing URL for citations (never expose internal URLs)
  // Priority:
  //   1. originalReference if it's a navigable http(s) URL (connector/crawled source)
  //   2. downloadUrl — signed external download URL for file uploads
  //   3. originalReference as-is (filename fallback for display)
  // NEVER use internalFileUrl or raw sourceUrl (S3/storage paths) — those are internal-only.
  const docAny = document as any;
  if (
    document.originalReference &&
    (document.originalReference.startsWith('http://') ||
      document.originalReference.startsWith('https://'))
  ) {
    canonical.source_url = document.originalReference;
  } else if (docAny.downloadUrl) {
    canonical.source_url = docAny.downloadUrl;
  } else if (document.originalReference) {
    canonical.source_url = document.originalReference;
  }

  // created_date / modified_date
  if (document.createdAt) {
    canonical.created_date = new Date(document.createdAt).toISOString();
  }
  if (document.updatedAt) {
    canonical.modified_date = new Date(document.updatedAt).toISOString();
  }

  // language
  if (document.language) {
    canonical.language = document.language;
  }

  // status
  if (document.status) {
    canonical.status = document.status;
  }

  // content_summary — source of truth: metadata.documentSummary (LLM summary from page-processing-worker)
  const docSummary = document.metadata?.documentSummary as string | undefined;
  if (docSummary) {
    canonical.content_summary =
      docSummary.length > 500 ? docSummary.slice(0, 500) + '...' : docSummary;
  }

  // ── Metadata-derived fields ──────────────────────────────────────────────

  // author (from sourceMetadata if available)
  const author =
    (fileMeta.author as string | undefined) ||
    (srcMeta.author as string | undefined) ||
    (srcMeta.created_by as string | undefined);
  if (author) canonical.author = author;

  // category (from classification or sourceMetadata)
  if (document.classification?.category) {
    canonical.category = document.classification.category;
  } else if (srcMeta.category) {
    canonical.category = srcMeta.category;
  }

  // tags (from sourceMetadata)
  if (srcMeta.tags) {
    canonical.tags = srcMeta.tags;
  }

  return canonical;
}

/**
 * Derive a human-readable source_type from MIME type and filename.
 */
export function deriveSourceType(mimeType: string, filename: string | null): string {
  const mimeMap: Record<string, string> = {
    'application/pdf': 'pdf',
    'text/markdown': 'markdown',
    'text/plain': 'text',
    'text/html': 'html',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
  };

  const mapped = mimeMap[mimeType];
  if (mapped) return mapped;

  // Fallback: extract from filename extension
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext) return ext;
  }

  // Last resort: simplify MIME (e.g., "application/pdf" → "pdf")
  const parts = mimeType.split('/');
  return parts[parts.length - 1];
}

// =============================================================================
// CANONICAL MAPPING (via CanonicalMapperService)
// =============================================================================
// Connector-specific mapping is handled by CanonicalMapperService (see services/canonical-mapping/)
// The service provides:
// - LRU cache with 5-minute TTL for field mappings
// - Cache observability metrics (hits, misses, evictions, hit rate)
// - Transform support (direct, lowercase, split, date_format, rename_value, extract, coalesce, compute)
// - Redis pub/sub for distributed cache invalidation (Phase 1 Task 4)

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the canonical-mapper worker.
 *
 * @param concurrency — max parallel mapping jobs (default 5)
 */
export default function createCanonicalMapperWorker(concurrency = 5): Worker<CanonicalMapJobData> {
  const worker = new Worker<CanonicalMapJobData>(
    QUEUE_CANONICAL_MAP,
    processCanonicalMapJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('canonical-mapper', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('canonical-mapper', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('canonical-mapper', 'Worker error', err);
  });

  workerLog('canonical-mapper', `Started with concurrency=${concurrency}`);
  return worker;
}
