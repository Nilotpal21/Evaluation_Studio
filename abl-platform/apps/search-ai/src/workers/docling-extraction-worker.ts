/**
 * Docling Extraction Worker
 *
 * Calls the Docling Python service to extract structured content from documents.
 * Extracts pages with layout, tables, images, and screenshots.
 * Uploads images/screenshots to S3 and stores page data in MongoDB.
 *
 * Flow: extraction → docling-extraction → page-processing → chunking
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import axios from 'axios';
import FormData from 'form-data';
import {
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_WORKFLOW_DOCLING_EXTRACTION,
  QUEUE_PAGE_PROCESSING,
  DocumentStatus,
  isWorkflowDoclingExtractionJob,
  type WorkflowDoclingExtractionJobData,
} from '@agent-platform/search-ai-sdk';
import { processExtractionOnly } from './branches/extraction-only.js';
import { recordBullMQQueueDepth, recordWorkerActiveJobs } from './branches/extraction-metrics.js';
import { getWorkflowDoclingExtractionQueue } from '../queues/queue-factory.js';
import { getLazyModel } from '../db/index.js';
import type { ISearchDocument, IDocumentPage } from '@agent-platform/database';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const DocumentPage = getLazyModel<IDocumentPage>('DocumentPage'); // → search_ai

import { withTenantContext } from '@agent-platform/database/mongo';
import { S3StorageService, uploadBase64ToS3 } from '@agent-platform/shared';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';
import { getConfig } from '../config/index.js';
import { createFileStorage } from '../storage/storage-factory.js';
import type { PageProcessingJobData } from './shared.js';
import {
  logStatusTransition,
  logJobPickup,
  logJobCompletion,
  logQueueEnqueue,
} from './status-logger.js';
import { publishProgressEvent } from '../routes/progress.js';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';

// =============================================================================
// TYPES
// =============================================================================

export interface DoclingExtractionJobData {
  indexId: string;
  documentId: string;
  sourceUrl: string; // S3 URL or HTTP URL
  tenantId: string;
  /** Pipeline stage config — when present, tracks extraction provenance */
  pipelineStage?: import('./shared.js').PipelineStageConfig;
}

interface DoclingPage {
  pageNumber: number;
  text: string;
  layout: {
    headings: Array<{
      level: number;
      text: string;
      bbox?: any;
    }>;
    structure?: any;
  };
  tables: Array<{
    rows: string[][];
    headers: string[];
    html: string;
    markdown: string;
    bbox?: any;
    isComplete: boolean;
  }>;
  images: Array<{
    data: string; // Base64
    format: string;
    bbox?: any;
  }>;
  screenshot: string | null; // Base64
}

interface DoclingExtractionResult {
  pages: DoclingPage[];
  metadata: {
    pageCount: number;
    hasOCR: boolean;
    totalTables: number;
    totalImages: number;
    processingTime: number;
    documentType?: string;
    // Language detection (from Docling's fasttext + lingua detector)
    language?: string; // ISO 639-1 code
    languageConfidence?: number; // 0.0-1.0
    languageScript?: string; // Latin, CJK, Arabic, Cyrillic, etc.
    languageDetectionMethod?: string; // fasttext-confident, sampling-voted, lingua-definitive, script-fallback
    secondaryLanguages?: Array<{ lang: string; confidence: number }>;
  };
  structure: {
    outline: any[];
    documentType?: string;
  };
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

/**
 * Discriminated union covering both the ingestion-path payload and the
 * workflow-path payload (`mode: 'extraction-only'`). The shared processor
 * branches on `job.queueName` and the data shape inside.
 *
 * NOTE: the union is defined here rather than in `@agent-platform/search-ai-sdk`
 * because the SDK is a leaf package that does not own the ingestion-path
 * `DoclingExtractionJobData` shape. The workflow-path shape
 * (`WorkflowDoclingExtractionJobData`) IS owned by the SDK so that the
 * workflow-engine producer and the search-ai worker consumer share one wire
 * type. Deviation from the LLD documented in `docs/sdlc-logs/document-extraction-integrations/implementation.log.md`.
 */
type DoclingExtractionJob = DoclingExtractionJobData | WorkflowDoclingExtractionJobData;

/**
 * Top-level dispatch — routes the job to the correct branch.
 *   - `workflow-docling-extraction` queue OR `mode === 'extraction-only'` →
 *      workflow-path branch (`processExtractionOnly`).
 *   - `search-docling-extraction` queue (existing) → full-ingestion branch
 *      (`processFullIngestion`) — byte-for-byte unchanged from prior behavior.
 */
async function processDoclingExtractionJob(job: Job<DoclingExtractionJob>): Promise<void> {
  if (
    job.queueName === QUEUE_WORKFLOW_DOCLING_EXTRACTION ||
    isWorkflowDoclingExtractionJob(job.data)
  ) {
    return processExtractionOnly(job as Job<WorkflowDoclingExtractionJobData>);
  }
  return processFullIngestion(job as Job<DoclingExtractionJobData>);
}

async function processFullIngestion(job: Job<DoclingExtractionJobData>): Promise<void> {
  const jobStartMs = Date.now();
  const { indexId, documentId, sourceUrl, tenantId } = job.data;

  logJobPickup({
    worker: 'docling-extraction',
    jobId: job.id || 'unknown',
    documentId,
    queueName: QUEUE_DOCLING_EXTRACTION,
    timestamp: new Date(),
  });

  workerLog('docling-extraction', `Extracting document ${documentId} with Docling`, {
    indexId,
    sourceUrl,
  });

  await withTenantContext({ tenantId }, async () => {
    // ── 1. Load the document ──────────────────────────────────────────────
    const document = await SearchDocument.findOne({ _id: documentId, indexId });
    if (!document) {
      throw new Error(`Document ${documentId} not found in index ${indexId}`);
    }

    // Mark document as extracting
    logStatusTransition({
      documentId,
      indexId,
      tenantId,
      fromStatus: document.status,
      toStatus: DocumentStatus.EXTRACTING,
      worker: 'docling-extraction',
      timestamp: new Date(),
    });

    await SearchDocument.findOneAndUpdate(
      { _id: documentId, tenantId },
      {
        status: DocumentStatus.EXTRACTING,
        processingError: null,
      },
    );

    // ── 2. Download document from source ──────────────────────────────────
    workerLog('docling-extraction', `Downloading document from ${sourceUrl}`);
    const documentBuffer = await downloadDocument(sourceUrl);

    try {
      // ── 3. Call unified extraction service for supported formats ────────────────
      // Unified Docling service handles 14 formats:
      // - Docling path (13 formats): PDF, DOCX, DOC, PPTX, PPT, HTML, PNG, JPEG, JPG, TIFF, BMP, WEBP, MD
      // - LlamaIndex path (1 format): TXT (extracted as single page, chunked in page-processing)
      // - Unsupported: CSV, JSON, XML (need hierarchical tree extraction - task #15)
      workerLog(
        'docling-extraction',
        `Calling unified extraction service (${document.contentType})`,
      );

      // OCR: skip only for formats guaranteed to be pure text (HTML, Markdown, TXT).
      // PDF, DOCX, PPTX, and images may contain scanned pages, diagrams, or
      // embedded images with text that require OCR to extract.
      const PURE_TEXT_FORMATS = new Set(['text/html', 'text/markdown', 'text/plain']);
      const contentType = document.contentType || 'application/octet-stream';
      const needsOcr = !PURE_TEXT_FORMATS.has(contentType);

      // Pipeline config can override: force OCR on/off
      const pipelineOcr = job.data.pipelineStage?.providerConfig?.ocrEnabled;
      const ocrEnabled = pipelineOcr !== undefined ? Boolean(pipelineOcr) : needsOcr;

      workerLog(
        'docling-extraction',
        `OCR ${ocrEnabled ? 'enabled' : 'skipped'} for ${contentType}`,
      );

      const extractionResult = await callDoclingService(
        documentBuffer,
        {
          extractImages: true,
          extractTables: true,
          renderScreenshots: true,
          ocrEnabled,
        },
        contentType,
        document.originalReference || 'document',
      );

      workerLog(
        'docling-extraction',
        `Docling extraction complete: ${extractionResult.metadata.pageCount} pages`,
      );

      // ── 3b. Guard: 0 pages means extraction failed to parse content ────────
      if (extractionResult.pages.length === 0) {
        const errorMsg = `Docling extraction returned 0 pages for document ${documentId} (${document.contentType || 'unknown type'}, ${document.originalReference || 'unknown file'})`;
        workerError('docling-extraction', errorMsg, new Error('zero_pages_extracted'));

        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ERROR,
            errorMessage: errorMsg,
            sourceMetadata: {
              ...document.sourceMetadata,
              doclingExtraction: {
                pageCount: 0,
                processingTime: extractionResult.metadata.processingTime,
                engine: 'docling',
                error: 'zero_pages_extracted',
              },
            },
          },
        );

        logStatusTransition({
          documentId,
          indexId,
          tenantId,
          fromStatus: DocumentStatus.EXTRACTING,
          toStatus: DocumentStatus.ERROR,
          worker: 'docling-extraction',
          timestamp: new Date(),
          metadata: { reason: 'zero_pages_extracted' },
        });

        logJobCompletion({
          worker: 'docling-extraction',
          jobId: job.id || 'unknown',
          documentId,
          status: 'failed',
          durationMs: Date.now() - jobStartMs,
          timestamp: new Date(),
        });

        return;
      }

      // ── 4. Check if we need asset storage (only for PDFs with images/screenshots) ────
      const hasAssets = extractionResult.pages.some(
        (p) => p.images.length > 0 || p.screenshot !== null,
      );

      const config = getConfig();
      const storageConfig = config.storage;
      const useS3 = storageConfig.provider === 's3' || storageConfig.provider === 'minio';
      let s3Service: S3StorageService | null = null;
      let localAssetDir: string | null = null;

      if (hasAssets) {
        if (useS3) {
          workerLog(
            'docling-extraction',
            `Initializing S3 for image/screenshot storage (bucket: ${storageConfig.bucket})`,
          );
          s3Service = new S3StorageService({
            bucket: storageConfig.bucket,
            region: storageConfig.region || 'us-east-1',
            endpoint: storageConfig.endpoint,
            encryption: 'AES256',
            accessKeyId: storageConfig.accessKeyId,
            secretAccessKey: storageConfig.secretAccessKey,
          });
        } else {
          const path = await import('path');
          const fs = await import('fs/promises');
          const basePath = path.resolve(storageConfig.basePath || './uploads');
          localAssetDir = path.join(basePath, tenantId, indexId, documentId, 'assets');
          await fs.mkdir(localAssetDir, { recursive: true });
          workerLog('docling-extraction', `Using local storage for assets: ${localAssetDir}`);
        }
      }

      // ── 5. Process and store pages ────────────────────────────────────────
      workerLog(
        'docling-extraction',
        `Storing ${extractionResult.pages.length} pages in MongoDB${hasAssets ? ' and S3' : ''}`,
      );

      const pageRecords = await Promise.all(
        extractionResult.pages.map(async (page) => {
          workerLog('docling-extraction', `Processing page ${page.pageNumber}`);

          // Upload images to S3 or local storage
          const imageInfos = await Promise.all(
            page.images.map(async (img, idx) => {
              const fileName = `page-${page.pageNumber}-image-${idx}.${img.format}`;

              if (useS3 && s3Service) {
                const key = S3StorageService.buildPageAssetKey(
                  tenantId,
                  indexId,
                  documentId,
                  page.pageNumber,
                  `image-${idx}`,
                  img.format,
                );

                const uploadResult = await uploadBase64ToS3(s3Service, key, img.data, {
                  contentType: `image/${img.format}`,
                  metadata: {
                    tenantId,
                    indexId,
                    documentId,
                    pageNumber: String(page.pageNumber),
                    assetType: 'image',
                  },
                });

                return {
                  s3Url: uploadResult.url,
                  format: img.format,
                  bbox: img.bbox,
                  sizeBytes: uploadResult.sizeBytes,
                };
              } else {
                // Local storage
                const path = await import('path');
                const fs = await import('fs/promises');
                const filePath = path.join(localAssetDir!, fileName);
                const buffer = Buffer.from(img.data, 'base64');
                await fs.writeFile(filePath, buffer);

                return {
                  s3Url: `file://${filePath}`,
                  format: img.format,
                  bbox: img.bbox,
                  sizeBytes: buffer.length,
                };
              }
            }),
          );

          // Upload screenshot to S3 or local storage
          let screenshotUrl: string | null = null;
          if (page.screenshot) {
            if (useS3 && s3Service) {
              const key = S3StorageService.buildPageAssetKey(
                tenantId,
                indexId,
                documentId,
                page.pageNumber,
                'screenshot',
                'png',
              );

              const uploadResult = await uploadBase64ToS3(s3Service, key, page.screenshot, {
                contentType: 'image/png',
                metadata: {
                  tenantId,
                  indexId,
                  documentId,
                  pageNumber: String(page.pageNumber),
                  assetType: 'screenshot',
                },
              });

              screenshotUrl = uploadResult.url;
            } else {
              // Local storage
              const path = await import('path');
              const fs = await import('fs/promises');
              const fileName = `page-${page.pageNumber}-screenshot.png`;
              const filePath = path.join(localAssetDir!, fileName);
              const buffer = Buffer.from(page.screenshot, 'base64');
              await fs.writeFile(filePath, buffer);
              screenshotUrl = `file://${filePath}`;
            }
          }

          // Create DocumentPage record
          return {
            tenantId,
            indexId,
            documentId,
            pageNumber: page.pageNumber,
            text: page.text,
            tokenCount: countTokens(page.text), // Accurate token count using tiktoken
            layout: {
              headings: page.layout.headings.map((h) => ({
                level: h.level,
                text: h.text,
                bbox: h.bbox || undefined,
              })),
              structure: page.layout.structure || {},
            },
            tables: page.tables.map((t) => ({
              rows: t.rows,
              headers: t.headers,
              html: t.html,
              markdown: t.markdown,
              bbox: t.bbox || undefined,
              isComplete: t.isComplete,
            })),
            images: imageInfos,
            screenshot: screenshotUrl,
            status: 'pending',
          };
        }),
      );

      workerLog('docling-extraction', `Inserting ${pageRecords.length} pages into MongoDB`);

      let insertedPages: any[];
      try {
        insertedPages = await DocumentPage.insertMany(pageRecords, { ordered: true });
        workerLog('docling-extraction', `Stored ${insertedPages.length} pages successfully`);
      } catch (error) {
        workerError('docling-extraction', `Failed to insert pages`, error);
        throw error;
      }

      // Publish progress event for crawl jobs after bulk insert
      const crawlJobId = document.sourceMetadata?.crawlJobId;
      if (crawlJobId) {
        await publishProgressEvent({
          type: 'document_processed',
          jobId: crawlJobId,
          timestamp: new Date().toISOString(),
          data: {
            url: document.originalReference || '',
            documentId,
            progress: {
              total: insertedPages.length,
              completed: insertedPages.length,
              failed: 0,
              percentage: 100,
            },
          },
        });
      }

      // ── 6. Update document ─────────────────────────────────────────────────
      logStatusTransition({
        documentId,
        indexId,
        tenantId,
        fromStatus: DocumentStatus.EXTRACTING,
        toStatus: DocumentStatus.EXTRACTED,
        worker: 'docling-extraction',
        timestamp: new Date(),
        metadata: { pageCount: extractionResult.metadata.pageCount },
      });

      // Build pipeline provenance info (if pipeline config was passed)
      const pipelineStage = job.data.pipelineStage;
      const pipelineInfo = pipelineStage
        ? {
            pipelineId: pipelineStage.pipelineId,
            flowId: pipelineStage.flowId,
            extractionProvider: pipelineStage.provider,
          }
        : undefined;

      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.EXTRACTED,
          pageCount: extractionResult.metadata.pageCount,
          // Store Docling-detected language directly on the document
          ...(extractionResult.metadata.language
            ? { language: extractionResult.metadata.language }
            : {}),
          sourceMetadata: {
            ...document.sourceMetadata,
            doclingExtraction: {
              pageCount: extractionResult.metadata.pageCount,
              totalTables: extractionResult.metadata.totalTables,
              totalImages: extractionResult.metadata.totalImages,
              hasOCR: extractionResult.metadata.hasOCR,
              processingTime: extractionResult.metadata.processingTime,
              documentType: extractionResult.metadata.documentType,
              engine: 'docling', // Explicit engine marker
              // Language detection metadata
              language: extractionResult.metadata.language,
              languageConfidence: extractionResult.metadata.languageConfidence,
              languageScript: extractionResult.metadata.languageScript,
              languageDetectionMethod: extractionResult.metadata.languageDetectionMethod,
              secondaryLanguages: extractionResult.metadata.secondaryLanguages,
            },
            ...(pipelineInfo ? { pipeline: pipelineInfo } : {}),
          },
        },
      );

      // ── 7. Enqueue page processing job ─────────────────────────────────────
      const pageIds = insertedPages.map((p: any) => p._id);

      const jobDataAny = job.data as unknown as Record<string, unknown>;
      const chunkingStage = jobDataAny._chunkingStage as
        | import('./shared.js').PipelineStageConfig
        | undefined;
      const enrichmentStage = jobDataAny._enrichmentStage as
        | import('./shared.js').PipelineStageConfig
        | undefined;
      const embeddingStage = jobDataAny._embeddingStage as
        | import('./shared.js').PipelineStageConfig
        | undefined;

      const processingData: PageProcessingJobData & Record<string, unknown> = {
        indexId,
        documentId,
        tenantId,
        pageIds,
        previousPageSummary: null,
        pipelineStage: chunkingStage,
      };

      if (enrichmentStage) processingData._enrichmentStage = enrichmentStage;
      if (embeddingStage) processingData._embeddingStage = embeddingStage;

      await createQueue(QUEUE_PAGE_PROCESSING).add(
        `page-processing:${documentId}`,
        processingData,
        {
          jobId: `page-processing:${indexId}:${documentId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );

      logQueueEnqueue({
        targetQueue: QUEUE_PAGE_PROCESSING,
        jobId: `page-processing:${indexId}:${documentId}`,
        documentId,
        worker: 'docling-extraction',
        timestamp: new Date(),
      });

      workerLog('docling-extraction', `Enqueued page processing job for ${documentId}`);

      logJobCompletion({
        worker: 'docling-extraction',
        jobId: job.id || 'unknown',
        documentId,
        status: 'completed',
        durationMs: Date.now() - jobStartMs,
        timestamp: new Date(),
      });
    } catch (error) {
      workerError('docling-extraction', `Docling extraction failed for ${documentId}`, error);

      logStatusTransition({
        documentId,
        indexId,
        tenantId,
        fromStatus: DocumentStatus.EXTRACTING,
        toStatus: DocumentStatus.ERROR,
        worker: 'docling-extraction',
        timestamp: new Date(),
        metadata: { error: error instanceof Error ? error.message : 'unknown' },
      });

      // Mark document as failed
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.ERROR,
          processingError: error instanceof Error ? error.message : 'Docling extraction failed',
        },
      );

      logJobCompletion({
        worker: 'docling-extraction',
        jobId: job.id || 'unknown',
        documentId,
        status: 'failed',
        durationMs: Date.now() - jobStartMs,
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'unknown',
      });

      throw error;
    }
  });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Download document from S3, HTTP, or local file URL.
 * Delegates to shared downloadDocumentContent utility.
 */
async function downloadDocument(url: string): Promise<Buffer> {
  const { downloadDocumentContent } = await import('../services/ingestion/download-document.js');
  return downloadDocumentContent(url);
}

/**
 * MIME-to-extension map for deriving file extension when the original filename
 * (often a URL) has no extension. Docling's DocumentConverter relies on
 * file extension to detect format, so we must ensure one is present.
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  'text/html': '.html',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
};

/**
 * Known file extensions that Docling can detect format from.
 */
const KNOWN_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.md',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.tiff',
  '.tif',
  '.bmp',
  '.webp',
  '.csv',
  '.xlsx',
  '.xls',
]);

/**
 * Ensures the filename has a recognizable file extension so that the Docling
 * Python service can detect the document format when writing to a temp file.
 *
 * For file uploads: originalReference is already "report.pdf" → passes through.
 * For crawled URLs: originalReference may be "https://.../.../page-title" (no ext)
 *   → derives extension from contentType.
 * For connectors: variable — handles both cases.
 */
function ensureFilenameExtension(originalRef: string, contentType: string): string {
  // Extract the last path segment (strip query params and hash)
  const urlPath = originalRef.split('?')[0].split('#')[0];
  const lastSegment = urlPath.split('/').pop() || 'document';

  // Check if it already has a known extension
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = lastSegment.slice(dotIndex).toLowerCase();
    if (KNOWN_EXTENSIONS.has(ext)) {
      return lastSegment;
    }
  }

  // No recognized extension — derive from contentType
  const ext = MIME_TO_EXTENSION[contentType] || '';
  if (ext) {
    return `${lastSegment}${ext}`;
  }

  // Last resort: return as-is (callDoclingService will still pass contentType header)
  return lastSegment;
}

/**
 * Call unified Docling extraction service (supports all 18 formats)
 */
async function callDoclingService(
  documentBuffer: Buffer,
  options: {
    extractImages: boolean;
    extractTables: boolean;
    renderScreenshots: boolean;
    ocrEnabled: boolean;
  },
  contentType: string,
  filename: string,
): Promise<DoclingExtractionResult> {
  const form = new FormData();

  // Ensure filename has a valid extension for Docling format detection.
  // Crawled URLs often lack extensions (e.g. "https://docs.kore.ai/.../page-title")
  // which causes Docling to fail with "File format not allowed" when creating temp files.
  const safeFilename = ensureFilenameExtension(filename, contentType);

  form.append('file', documentBuffer, {
    filename: safeFilename,
    contentType,
  });
  form.append('options', JSON.stringify(options));

  const doclingServiceUrl = process.env.DOCLING_SERVICE_URL || 'http://localhost:8080';

  workerLog(
    'docling-extraction',
    `Calling Docling service at ${doclingServiceUrl}/extract (filename: ${filename})`,
  );

  const maxRetries = 3;
  // ECONNABORTED = axios timeout — retrying a timed-out large file just wastes time
  const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']);

  // Scale timeout with file size: 5 min base + 1 min per 5MB, capped at 30 min
  const fileSizeMB = documentBuffer.length / (1024 * 1024);
  const timeoutMs = Math.min(300_000 + Math.ceil(fileSizeMB / 5) * 60_000, 1_800_000);

  workerLog(
    'docling-extraction',
    `HTTP timeout: ${timeoutMs / 1000}s for ${fileSizeMB.toFixed(1)}MB file`,
  );

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const requestForm = attempt === 0 ? form : new FormData();
      if (attempt > 0) {
        requestForm.append('file', documentBuffer, { filename, contentType });
        requestForm.append('options', JSON.stringify(options));
      }

      const response = await axios.post<DoclingExtractionResult>(
        `${doclingServiceUrl}/extract`,
        requestForm,
        {
          headers: requestForm.getHeaders(),
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: timeoutMs,
        },
      );

      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorCode = (error as any).code || '';
        const isRetryable =
          status === 503 ||
          status === 429 ||
          status === 502 ||
          status === 504 ||
          RETRYABLE_CODES.has(errorCode);

        if (isRetryable && attempt < maxRetries) {
          const backoffMs = 1000 * 2 ** attempt;
          workerLog(
            'docling-extraction',
            `Retryable error (${status ?? errorCode}), attempt ${attempt + 1}/${maxRetries}, waiting ${backoffMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        if (!error.response) {
          const errCode = errorCode || 'UNKNOWN';
          const errorMessage = error.message || 'Unknown error';
          throw new Error(
            `Docling service unreachable at ${doclingServiceUrl}: ${errCode} - ${errorMessage}. ` +
              `Check that the service is running and the URL is correct.`,
          );
        }

        const statusText = error.response.statusText;
        const data = error.response.data ? JSON.stringify(error.response.data) : 'no response data';
        throw new Error(`Docling service error: HTTP ${status} ${statusText} - Response: ${data}`);
      }
      throw error;
    }
  }

  throw new Error(`Docling extraction failed after ${maxRetries} retries`);
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

const DEFAULT_INGESTION_CONCURRENCY = 3;
// ingestion(3) + workflow(3) = 6 — matches the default totalCap below.
const DEFAULT_WORKFLOW_CONCURRENCY = 3;

export interface CreateDoclingWorkersOptions {
  /** Reserved concurrency for the `search-docling-extraction` (ingestion) queue. */
  ingestionConcurrency?: number;
  /** Reserved concurrency for the `workflow-docling-extraction` (workflow) queue. */
  workflowConcurrency?: number;
  /**
   * Total pod-level concurrency cap. The sum of `ingestionConcurrency` and
   * `workflowConcurrency` must not exceed this value. Defaults to the value
   * of `INGESTION_MAX_CONCURRENT_JOBS` env (or 5 if unset) — matches
   * `apps/search-ai/src/server.ts` startup default.
   */
  totalConcurrencyCap?: number;
}

export interface DoclingExtractionWorkers {
  ingestion: Worker<DoclingExtractionJobData>;
  workflow: Worker<WorkflowDoclingExtractionJobData>;
}

/**
 * Two-queue worker factory (LLD Phase 1 Task 1.9).
 *
 * Builds reserved-slot workers for the ingestion and workflow queues so the
 * paths can't starve each other. The caller decides which worker(s) to
 * register with the lifecycle layer — when the workflow feature flag is off,
 * only `ingestion` is added to the worker list (the `workflow` Worker is
 * constructed but never started; BullMQ workers do not connect until added
 * to the registration list or until events are observed, matching the
 * existing lazy pattern).
 */
export default function createDoclingExtractionWorker(
  options: CreateDoclingWorkersOptions = {},
): DoclingExtractionWorkers {
  const ingestionConcurrency =
    options.ingestionConcurrency ??
    parseEnvInt(process.env.DOCLING_INGESTION_CONCURRENCY, DEFAULT_INGESTION_CONCURRENCY);
  const workflowConcurrency =
    options.workflowConcurrency ??
    parseEnvInt(process.env.DOCLING_WORKFLOW_CONCURRENCY, DEFAULT_WORKFLOW_CONCURRENCY);
  const totalCap =
    options.totalConcurrencyCap ?? parseEnvInt(process.env.INGESTION_MAX_CONCURRENT_JOBS, 6);

  if (ingestionConcurrency < 0 || workflowConcurrency < 0) {
    throw new Error(
      `Invalid Docling concurrency (ingestion=${ingestionConcurrency}, workflow=${workflowConcurrency}) — must be non-negative`,
    );
  }
  if (ingestionConcurrency + workflowConcurrency > totalCap) {
    throw new Error(
      `Docling concurrency sum (${ingestionConcurrency}+${workflowConcurrency}) exceeds INGESTION_MAX_CONCURRENT_JOBS cap (${totalCap})`,
    );
  }

  // S-3: runtime guard — INGESTION_MAX_CONCURRENT_JOBS can be overridden after
  // factory creation via env. Warn loudly if the live value diverges from totalCap.
  const runtimeCapCheck = setInterval(() => {
    const liveCap = parseEnvInt(process.env.INGESTION_MAX_CONCURRENT_JOBS, 5);
    if (ingestionConcurrency + workflowConcurrency > liveCap) {
      workerError(
        'docling-extraction',
        `Runtime concurrency cap mismatch: ingestion(${ingestionConcurrency})+workflow(${workflowConcurrency}) > INGESTION_MAX_CONCURRENT_JOBS(${liveCap})`,
        new Error('CONCURRENCY_CAP_EXCEEDED'),
      );
    }
  }, 60_000);
  runtimeCapCheck.unref();

  const ingestion = new Worker<DoclingExtractionJobData>(
    QUEUE_DOCLING_EXTRACTION,
    processDoclingExtractionJob as (job: Job<DoclingExtractionJobData>) => Promise<void>,
    {
      ...createWorkerOptions(ingestionConcurrency),
      lockDuration: 600_000,
      stalledInterval: 300_000,
    },
  );

  ingestion.on('completed', (job) =>
    workerLog('docling-extraction', `Job ${job.id} completed`, { documentId: job.data.documentId }),
  );
  ingestion.on('failed', (job, err) =>
    workerError('docling-extraction', `Job ${job?.id} failed`, err),
  );

  // S-2: use processExtractionOnly directly — avoids the type assertion that masked
  // data-shape differences between ingestion (DoclingExtractionJobData) and workflow
  // (WorkflowDoclingExtractionJobData) job payloads.
  const workflow = new Worker<WorkflowDoclingExtractionJobData>(
    QUEUE_WORKFLOW_DOCLING_EXTRACTION,
    processExtractionOnly,
    {
      ...createWorkerOptions(workflowConcurrency),
      lockDuration: 600_000,
      stalledInterval: 300_000,
    },
  );

  // Metric: worker_active_jobs{queue} — delta-counter on processing/completed/failed
  // (Phase 4 task 4.4). Log-line emission survives until search-ai boots an OTel SDK.
  workflow.on('active', () =>
    recordWorkerActiveJobs(1, { queue: QUEUE_WORKFLOW_DOCLING_EXTRACTION }),
  );
  workflow.on('completed', (job) => {
    recordWorkerActiveJobs(-1, { queue: QUEUE_WORKFLOW_DOCLING_EXTRACTION });
    workerLog('workflow-docling', `Job ${job.id} completed`, {
      tenantId: job.data.tenantId,
      stepId: job.data.stepId,
    });
  });
  workflow.on('failed', (job, err) => {
    recordWorkerActiveJobs(-1, { queue: QUEUE_WORKFLOW_DOCLING_EXTRACTION });
    workerError('workflow-docling', `Job ${job?.id} failed`, err);
  });

  // Metric: bullmq_queue_depth{queue} — 15 s periodic gauge tick (Phase 4 task 4.4).
  // `getWaitingCount` reads `LLEN <queue>:wait` from Redis — sub-millisecond cost.
  // Tied to the worker lifecycle: stops when the worker closes.
  const queueDepthTick = setInterval(async () => {
    try {
      const q = getWorkflowDoclingExtractionQueue();
      if (!q) return;
      const depth = await q.getWaitingCount();
      recordBullMQQueueDepth(depth, { queue: QUEUE_WORKFLOW_DOCLING_EXTRACTION });
    } catch (err) {
      // Metric emission must never tear down the worker. Log at warn so a
      // persistent Redis outage surfaces as a steady stream of warnings
      // rather than silent metric blanks.
      workerError(
        'workflow-docling',
        'queue-depth tick failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }, 15_000);
  // Best-effort: stop ticking and the S-3 cap-check when the worker closes.
  workflow.on('closing', () => {
    clearInterval(queueDepthTick);
    clearInterval(runtimeCapCheck);
  });
  // Don't keep the process alive solely for the tick.
  if (typeof queueDepthTick.unref === 'function') queueDepthTick.unref();

  workerLog(
    'docling-extraction',
    `Two-queue topology: ingestion=${ingestionConcurrency}, workflow=${workflowConcurrency}, cap=${totalCap}`,
  );

  return { ingestion, workflow };
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
