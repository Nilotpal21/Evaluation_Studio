/**
 * Crawler Ingestion Service
 *
 * Shared service for ingesting crawled HTML content into SearchAI pipeline.
 * Used by both:
 * - Crawler Ingestion Worker (direct access, no HTTP)
 * - Crawler Ingestion HTTP Endpoint (for external integrations)
 *
 * Responsibilities:
 * 1. Clean HTML with Readability (remove noise)
 * 2. Upload HTML to S3 (production) or local filesystem (dev)
 * 3. Create SearchDocument with tenant isolation
 * 4. Enqueue Docling extraction job
 * 5. Update source status
 *
 * Design Principles:
 * - No HTTP calls (direct access to S3, MongoDB, BullMQ)
 * - Graceful degradation (if Readability fails, use raw HTML)
 * - Tenant isolation (all queries include tenantId)
 * - Content deduplication (hash-based)
 */

import crypto from 'crypto';
import type { ISearchIndex, ISearchSource, ISearchDocument } from '@agent-platform/database/models';
import { withTenantContext, uuidv7 } from '@agent-platform/database/mongo';
import { getLazyModel, getModel } from '../../db/index.js';

const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
import {
  QUEUE_DOCLING_EXTRACTION,
  DocumentStatus,
  SourceStatus,
} from '@agent-platform/search-ai-sdk';
import { createQueue, workerLog } from '../../workers/shared.js';
import { getConfig } from '../../config/index.js';
import { createFileStorage } from '../../storage/storage-factory.js';
import type { DoclingExtractionJobData } from '../../workers/shared.js';
import { logStatusTransition, logQueueEnqueue } from '../../workers/status-logger.js';
import type { ReadabilityMetadata } from '../readability/index.js';
import { runExtractionCascade } from '../crawler/extraction-cascade.js';
import { qualityMetricsService } from '../quality-metrics/index.js';
import type { QualityMetrics } from '../quality-metrics/index.js';

// =============================================================================
// TYPES
// =============================================================================

export interface CrawledContentInput {
  /** SearchAI index ID */
  indexId: string;
  /** SearchAI source ID */
  sourceId: string;
  /** Original URL that was crawled */
  url: string;
  /** Raw HTML content from crawler */
  htmlContent: string;
  /** Tenant ID for isolation */
  tenantId: string;
  /** Crawler metadata (optional) */
  metadata?: {
    crawledAt?: string;
    domain?: string;
    siteType?: 'static' | 'spa' | 'hybrid' | 'unknown';
    profileConfidence?: number;
    jsRequired?: boolean;
    title?: string;
    description?: string;
    language?: string;
    [key: string]: unknown;
  };
  /** Force replace existing document with same URL (default: false) */
  force?: boolean;
}

export interface CrawledContentResult {
  /** Whether ingestion was successful */
  success: boolean;
  /** Document ID (if created or existing unchanged doc) */
  documentId?: string;
  /** Outcome classification for recrawl tracking */
  outcome?: 'new' | 'updated' | 'unchanged';
  /** Original reference (URL) */
  originalReference?: string | null;
  /** Content type */
  contentType?: string | null;
  /** Content size (bytes) */
  contentSizeBytes?: number;
  /** Document status */
  status?: string;
  /** Metadata including Readability info */
  metadata?: Record<string, unknown>;
  /** Created timestamp */
  createdAt?: Date;
  /** Error details (if failed) */
  error?: {
    code: string;
    message: string;
  };
  /** Duplicate document info (if exists and force=false) */
  duplicate?: {
    documentId: string;
    originalReference: string | null;
    status: string;
    createdAt: Date;
  };
}

// =============================================================================
// SERVICE
// =============================================================================

export class CrawlerIngestionService {
  /**
   * Ingest crawled HTML content into SearchAI pipeline
   *
   * Flow:
   * 1. Validate tenant ownership (index, source)
   * 2. Clean HTML with Readability
   * 3. Analyze quality metrics (noise reduction, content preservation, etc.)
   * 4. Check for duplicates (URL or content hash)
   * 5. Upload both raw and cleaned HTML to S3/local
   * 6. Create SearchDocument with quality metrics
   * 7. Enqueue Docling extraction
   * 8. Update source status
   */
  async ingestCrawledContent(input: CrawledContentInput): Promise<CrawledContentResult> {
    const { indexId, sourceId, url, htmlContent, tenantId, metadata, force = false } = input;

    const MAX_HTML_SIZE = 10 * 1024 * 1024; // 10MB
    if (htmlContent.length > MAX_HTML_SIZE) {
      return {
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `HTML content exceeds maximum size of ${MAX_HTML_SIZE / 1024 / 1024}MB`,
        },
      };
    }

    const SearchIndex = getModel('SearchIndex');
    const SearchSource = getModel('SearchSource');
    const SearchDocument = getModel('SearchDocument');

    try {
      // Run within tenant context for AsyncLocalStorage
      return await withTenantContext({ tenantId }, async () => {
        // ─── Step 1: Validate Tenant Ownership ─────────────────────────

        // Verify index exists AND belongs to tenant
        const index = await SearchIndex.findOne({ _id: indexId, tenantId })
          .maxTimeMS(30000)
          .lean()
          .exec();
        if (!index) {
          return {
            success: false,
            error: {
              code: 'INDEX_NOT_FOUND',
              message: 'Index not found or does not belong to tenant',
            },
          };
        }

        // Verify source exists and belongs to this index AND tenant
        const source = (await SearchSource.findOne({ _id: sourceId, indexId, tenantId })
          .maxTimeMS(30000)
          .lean()
          .exec()) as any;
        if (!source) {
          return {
            success: false,
            error: {
              code: 'SOURCE_NOT_FOUND',
              message: 'Source not found for this index',
            },
          };
        }

        // ─── Step 2: Extract content via cascade ─────────────────────
        // Tries Readability → Semantic HTML → Body fallback.
        // Each layer is quality-scored; first to pass threshold wins.

        workerLog('crawler-ingestion', `Running extraction cascade`, {
          url,
          originalSize: htmlContent.length,
          siteType: metadata?.siteType,
        });

        const cascadeResult = runExtractionCascade(
          htmlContent,
          url,
          metadata?.siteType as 'static' | 'spa' | 'hybrid' | 'unknown' | undefined,
        );

        const cleanedHTML = cascadeResult.cleanedHTML;
        const readabilityMetadata = cascadeResult.metadata;

        workerLog(
          'crawler-ingestion',
          `Extraction cascade: layer=${cascadeResult.layer}, accepted=${cascadeResult.accepted}`,
          {
            url,
            layer: cascadeResult.layer,
            qualityScore: cascadeResult.qualityScore,
            quality: cascadeResult.quality,
            accepted: cascadeResult.accepted,
            attempts: cascadeResult.attempts.length,
            cleaned: readabilityMetadata.cleaned,
            sizeReduction: readabilityMetadata.sizeReduction,
            originalSize: readabilityMetadata.originalSize,
            cleanedSize: readabilityMetadata.cleanedSize,
          },
        );

        // Use best extraction output
        const finalHTML = cleanedHTML;

        // ─── Step 2b: Content Keyword Filter ────────────────────────────

        // Check content keyword filter if present in metadata
        const filters = metadata?.filters as { contentKeywords?: string[] } | undefined;
        if (filters?.contentKeywords?.length) {
          const textLower = finalHTML.toLowerCase();
          const hasMatch = filters.contentKeywords.some((kw: string) =>
            textLower.includes(kw.toLowerCase()),
          );
          if (!hasMatch) {
            workerLog('crawler-ingestion', 'Content filtered out by keyword filter', {
              url,
              keywords: filters.contentKeywords,
            });
            return {
              success: false,
              error: {
                code: 'FILTERED_OUT',
                message: 'Content does not match keyword filter',
              },
            };
          }
        }

        // ─── Step 3: Analyze Quality Metrics ───────────────────────────

        const qualityMetrics = qualityMetricsService.analyzeQuality(
          url, // Use URL as documentId for now (real ID created later)
          url,
          htmlContent, // Raw HTML
          finalHTML, // Cleaned HTML
          {
            title: readabilityMetadata.title,
            author: readabilityMetadata.author,
            excerpt: readabilityMetadata.excerpt,
          },
        );

        workerLog('crawler-ingestion', `Quality metrics calculated`, {
          url,
          overallScore: qualityMetrics.scores.overall,
          noiseReduction: qualityMetrics.scores.noiseReduction,
          contentPreservation: qualityMetrics.scores.contentPreservation,
          structurePreservation: qualityMetrics.scores.structurePreservation,
          metadataExtraction: qualityMetrics.scores.metadataExtraction,
        });

        // ─── Step 4: Sanitize and Enrich Metadata ──────────────────────

        const sanitizedMetadata = this.sanitizeMetadata(metadata || {});
        sanitizedMetadata.sourceUrl = url;
        sanitizedMetadata.ingestedVia = 'crawler';
        sanitizedMetadata.readability = {
          success: cascadeResult.accepted,
          layer: cascadeResult.layer,
          qualityScore: cascadeResult.qualityScore,
          cleaned: readabilityMetadata.cleaned,
          sizeReduction: readabilityMetadata.sizeReduction,
          originalSize: readabilityMetadata.originalSize,
          cleanedSize: readabilityMetadata.cleanedSize,
          title: readabilityMetadata.title,
          author: readabilityMetadata.author,
          excerpt: readabilityMetadata.excerpt,
        };
        sanitizedMetadata.qualityMetrics = {
          overallScore: qualityMetrics.scores.overall,
          noiseReduction: qualityMetrics.scores.noiseReduction,
          contentPreservation: qualityMetrics.scores.contentPreservation,
          structurePreservation: qualityMetrics.scores.structurePreservation,
          metadataExtraction: qualityMetrics.scores.metadataExtraction,
          size: qualityMetrics.size,
          content: qualityMetrics.content,
          structure: qualityMetrics.structure,
          noise: qualityMetrics.noise,
        };
        // Note: rawSourceUrl will be added after S3 upload

        // ─── Step 5: Generate Content Hash ─────────────────────────────

        const contentHash = crypto
          .createHash('sha256')
          .update(finalHTML)
          .digest('hex')
          .slice(0, 32);

        // ─── Step 6: Check for Existing Document by URL ──────────────

        const existingDoc = (await SearchDocument.findOne({
          tenantId,
          indexId,
          sourceId,
          originalReference: url,
        }).lean()) as any;

        // Content unchanged — skip pipeline entirely (recrawl optimisation)
        // BUT: if the previous pipeline run failed/errored, re-process even with
        // identical content — the failure was in Docling/chunking, not the HTML.
        const pipelineSucceeded =
          existingDoc?.status !== 'failed' && existingDoc?.status !== 'error';
        if (existingDoc && !force && existingDoc.contentHash === contentHash && pipelineSucceeded) {
          workerLog('crawler-ingestion', `Content unchanged, skipping pipeline`, {
            documentId: existingDoc._id,
            url,
            contentHash,
          });

          // Touch lastVerifiedAt + update crawlJobId so the doc appears in
          // the current job's Pages list (fixes empty Pages after all-unchanged recrawl)
          const updateFields: Record<string, unknown> = { lastVerifiedAt: new Date() };
          if (metadata?.crawlJobId) {
            updateFields['sourceMetadata.crawlJobId'] = metadata.crawlJobId;
          }
          await SearchDocument.updateOne(
            { _id: existingDoc._id, tenantId },
            { $set: updateFields },
          );

          return {
            success: true,
            outcome: 'unchanged',
            documentId: existingDoc._id.toString(),
            originalReference: url,
          };
        }

        // Determine if this is an update (existing doc, different hash) or new
        const isUpdate = !!existingDoc;

        // ─── Step 7: Delete Existing Document (if content changed or force) ─

        if (existingDoc && (force || existingDoc.contentHash !== contentHash)) {
          workerLog('crawler-ingestion', `Force replacing existing document`, {
            documentId: existingDoc._id,
          });

          // Delete associated pages
          const { DocumentPage } = await import('@agent-platform/database');
          await DocumentPage.deleteMany({ documentId: existingDoc._id, tenantId });

          // Delete associated chunks
          const { SearchChunk } = await import('@agent-platform/database');

          // Vector store cleanup (best-effort)
          try {
            const existingChunks = await SearchChunk.find({ documentId: existingDoc._id, tenantId })
              .select('_id')
              .lean();
            const chunkIdsToDelete = existingChunks.map((c: any) => String(c._id));
            if (chunkIdsToDelete.length > 0) {
              const { createVectorStore, resolveIndexForWrite } =
                await import('@agent-platform/search-ai-internal');
              const vectorStore = createVectorStore({
                provider: (process.env.VECTOR_STORE_PROVIDER as any) || 'opensearch',
                url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
                apiKey: process.env.VECTOR_STORE_API_KEY,
              });
              const vsIndexName = await resolveIndexForWrite(
                vectorStore,
                tenantId,
                indexId,
                sourceId,
              );
              await vectorStore.delete(vsIndexName, chunkIdsToDelete);
            }
          } catch (vsErr) {
            workerLog(
              'crawler-ingestion',
              'Vector store cleanup failed on force-replace (continuing)',
              {
                error: vsErr instanceof Error ? vsErr.message : String(vsErr),
              },
            );
          }

          await SearchChunk.deleteMany({ documentId: existingDoc._id, tenantId });

          // Delete the document itself
          await SearchDocument.findOneAndDelete({ _id: existingDoc._id, tenantId });

          workerLog('crawler-ingestion', `Deleted existing document and associated data`);
        }

        // ─── Step 8: Upload HTML (Both Raw and Cleaned) ────────────────

        const config = getConfig();
        const storage = createFileStorage(config.storage);
        let cleanedFileUrl: string;
        let rawFileUrl: string;
        const cleanedHtmlBuffer = Buffer.from(finalHTML, 'utf-8');
        const rawHtmlBuffer = Buffer.from(htmlContent, 'utf-8');
        const contentSizeBytes = cleanedHtmlBuffer.length;
        const rawContentSizeBytes = rawHtmlBuffer.length;

        const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
        const timestamp = Date.now();

        const s3Metadata = {
          tenantId,
          indexId,
          sourceId,
          originalUrl: url,
        };

        // Upload raw HTML
        const rawKey = `crawler/raw/${tenantId}/${indexId}/${timestamp}-${urlHash}.html`;
        const rawUploadResult = await storage.upload(rawKey, rawHtmlBuffer, {
          contentType: 'text/html',
          metadata: { ...s3Metadata, version: 'raw' },
        });
        rawFileUrl = rawUploadResult.url;

        // Upload cleaned HTML
        const cleanedKey = `crawler/cleaned/${tenantId}/${indexId}/${timestamp}-${urlHash}.html`;
        const cleanedUploadResult = await storage.upload(cleanedKey, cleanedHtmlBuffer, {
          contentType: 'text/html',
          metadata: { ...s3Metadata, version: 'cleaned' },
        });
        cleanedFileUrl = cleanedUploadResult.url;

        workerLog('crawler-ingestion', `HTML stored (${storage.provider})`, {
          rawUrl: rawFileUrl,
          rawSize: rawContentSizeBytes,
          cleanedUrl: cleanedFileUrl,
          cleanedSize: contentSizeBytes,
          sizeReduction: readabilityMetadata.sizeReduction,
        });

        // ─── Step 9: Create SearchDocument ─────────────────────────────

        // Add raw source URL to metadata for debugging/comparison
        sanitizedMetadata.rawSourceUrl = rawFileUrl;
        sanitizedMetadata.rawContentSize = rawContentSizeBytes;

        // Use source name provided by user when creating the crawled source
        const displayName = source.name || url;

        // Upsert by {indexId, sourceId, contentHash} to avoid E11000 on
        // concurrent workers ingesting the same content. sourceId is included
        // to prevent cross-source document overwrites within the same index.
        let document: any;
        const upsertFilter = { indexId, sourceId, contentHash };
        const upsertUpdate = {
          $set: {
            tenantId,
            name: displayName,
            originalReference: url,
            contentType: 'text/html',
            contentSizeBytes, // Cleaned HTML size
            sourceUrl: cleanedFileUrl, // Docling will process cleaned HTML
            sourceMetadata: sanitizedMetadata,
            status: DocumentStatus.PENDING,
            lastVerifiedAt: new Date(),
          },
          $setOnInsert: {
            _id: uuidv7(),
          },
        };

        try {
          document = await SearchDocument.findOneAndUpdate(upsertFilter, upsertUpdate, {
            upsert: true,
            new: true,
          });
        } catch (upsertErr: any) {
          // E11000 race: concurrent worker already inserted this doc — just find it
          if (upsertErr?.code === 11000) {
            document = await SearchDocument.findOne(upsertFilter).lean();
            if (!document) throw upsertErr; // Shouldn't happen — re-throw
          } else {
            throw upsertErr;
          }
        }

        const wasInsert =
          !document.createdAt || document.createdAt.getTime() === document.updatedAt?.getTime();

        // Log document creation/update (status transition)
        logStatusTransition({
          documentId: document._id.toString(),
          indexId,
          tenantId,
          fromStatus: wasInsert ? 'none' : 'existing',
          toStatus: DocumentStatus.PENDING,
          worker: 'crawler-ingestion',
          timestamp: new Date(),
          durationMs: 0,
          metadata: {
            url,
            contentSizeBytes,
            rawContentSizeBytes,
            sizeReduction: readabilityMetadata.sizeReduction,
            upsertType: wasInsert ? 'insert' : 'update',
          },
        });

        workerLog('crawler-ingestion', `SearchDocument ${wasInsert ? 'created' : 'updated'}`, {
          documentId: document._id,
          url,
          cleanedUrl: cleanedFileUrl,
          rawUrl: rawFileUrl,
        });

        // ─── Step 10: Enqueue Docling Extraction ──────────────────────
        // Route to Docling extraction for structured HTML parsing
        // (headings, tables, images)

        const doclingQueue = createQueue(QUEUE_DOCLING_EXTRACTION);
        try {
          const extractJobId = `docling-extract:${document._id}`;

          await doclingQueue.add(extractJobId, {
            indexId,
            documentId: document._id.toString(),
            sourceUrl: cleanedFileUrl,
            tenantId,
          } satisfies DoclingExtractionJobData);

          logQueueEnqueue({
            worker: 'crawler-ingestion',
            targetQueue: QUEUE_DOCLING_EXTRACTION,
            jobId: extractJobId,
            documentId: document._id.toString(),
            timestamp: new Date(),
          });

          workerLog('crawler-ingestion', `Enqueued Docling extraction job`, {
            documentId: document._id,
            sourceUrl: cleanedFileUrl,
          });
        } finally {
          await doclingQueue.close();
        }

        // ─── Step 11: Update Source Status ─────────────────────────────

        if (source.status === SourceStatus.PENDING) {
          await SearchSource.findOneAndUpdate(
            { _id: sourceId, tenantId },
            { status: SourceStatus.ACTIVE },
          );
        }

        // ─── Step 12: Return Success ───────────────────────────────────

        return {
          success: true,
          outcome: isUpdate ? 'updated' : ('new' as const),
          documentId: document._id.toString(),
          originalReference: document.originalReference,
          contentType: document.contentType,
          contentSizeBytes: document.contentSizeBytes,
          status: document.status,
          metadata: document.sourceMetadata,
          createdAt: document.createdAt,
        };
      }); // End withTenantContext
    } catch (error) {
      workerLog('crawler-ingestion', `Ingestion failed`, {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: {
          code: 'INGESTION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Sanitize metadata object (strip prototype pollution keys)
   */
  private sanitizeMetadata(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith('$') || key.startsWith('__')) continue;
      result[key] = value;
    }
    return result;
  }
}

// Singleton instance
export const crawlerIngestionService = new CrawlerIngestionService();
