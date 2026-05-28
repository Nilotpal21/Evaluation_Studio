/**
 * Document Upload Routes
 *
 * POST /:indexId/sources/:sourceId/documents - Upload file via multipart/form-data
 * GET  /:indexId/documents/:documentId       - Get document status
 *
 * Architecture:
 * 1. Upload file → Store in S3 (or local in dev)
 * 2. Create SearchDocument with S3 URL
 * 3. Route document based on MIME type:
 *    - Docling path (13 formats): PDF, Office docs, HTML, images, markdown → QUEUE_DOCLING_EXTRACTION
 *    - Legacy path (1 format): TXT → QUEUE_EXTRACTION (extracted as single page, chunked in processing)
 *    - Unsupported: CSV, JSON, XML (need hierarchical tree extraction - task #15)
 * 4. Pipeline: Extraction → Pages → Chunks → Embeddings → OpenSearch
 *
 * Supported formats (2026-02-23):
 * - Docling (13): PDF, DOCX, DOC, PPTX, PPT, HTML, PNG, JPEG, JPG, TIFF, BMP, WEBP, MD
 * - LlamaIndex (1): TXT (extracted as single page, chunked downstream)
 * - Removed: CSV, JSON, XML (need hierarchical tree extraction - task #15)
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { withTenantContext } from '@agent-platform/database/mongo';
import {
  QUEUE_DOCLING_EXTRACTION,
  QUEUE_EXTRACTION,
  DocumentStatus,
  SourceStatus,
} from '@agent-platform/search-ai-sdk';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type {
  ISearchIndex,
  ISearchSource,
  ISearchDocument,
  IDocumentPage,
  ISearchChunk,
  IConnectorConfig,
  IKnowledgeBase,
  ISearchPipelineDefinition,
  ISearchPipelineStage,
} from '@agent-platform/database';

// Models bound to correct databases (platform vs content)
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const SearchSource = getLazyModel<ISearchSource>('SearchSource'); // → search_ai
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase'); // → abl_platform
const SearchPipelineDefinition = getLazyModel<ISearchPipelineDefinition>(
  'SearchPipelineDefinition',
);
import { createQueue, workerLog, workerError } from '../workers/shared.js';
import type { DoclingExtractionJobData, PipelineStageConfig } from '../workers/shared.js';
import { FlowSelectionService } from '../services/flow-selection/flow-selection.service.js';
import { getConfig } from '../config/index.js';
import { createFileStorage, generateStorageKey } from '../storage/storage-factory.js';
import {
  routeDocument,
  detectMimeTypeFromExtension,
  isSupportedUploadType,
} from '../services/ingestion/document-routing.js';
import { createLogger } from '@abl/compiler/platform';
import { seedDocumentUploadVocabulary } from '../services/document-upload-vocabulary-seeder.js';
import {
  generateDocumentVocabularyEntries,
  upsertDocumentVocabulary,
  registerDocumentFields,
} from '../services/document-vocabulary-generator.js';
import type { ICanonicalSchema } from '@agent-platform/database';
import {
  AVAILABLE_CANONICAL_FIELDS,
  getAvailableField,
  toCanonicalField,
} from '@agent-platform/search-ai-internal/canonical';

const logger = createLogger('document-upload');
const router: RouterType = Router();

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract leaf field paths from a JSON record (dot-notation).
 * Used to detect new fields in subsequent JSON uploads.
 * e.g. { name: "x", address: { city: "y" } } → ["name", "address.city"]
 */
function extractLeafPaths(
  record: Record<string, unknown>,
  prefix = '',
  maxDepth = 2,
  depth = 0,
): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (depth < maxDepth && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      paths.push(
        ...extractLeafPaths(value as Record<string, unknown>, fullPath, maxDepth, depth + 1),
      );
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

// Multer error handler
function handleMulterError(err: any, req: Request, res: Response, next: NextFunction) {
  if (err) {
    logger.error('Multer error', {
      code: err.code,
      message: err.message,
      field: err.field,
      stack: err.stack,
    });
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large (max 100MB)' });
    }
    return res.status(400).json({ error: `File upload error: ${err.message}` });
  }
  next();
}

// FIX: Critical Bug (BUG-5) - Multer Memory Overflow Risk
// Use disk storage instead of memory to prevent OOM crashes with large files
// Scenario: 10 concurrent 100MB uploads = 1GB RAM → Node.js heap exhausted → crash
// Ensure upload temp directory exists once at module load
const UPLOAD_TEMP_DIR = path.join(process.cwd(), 'uploads', 'temp');
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, UPLOAD_TEMP_DIR);
    },
    filename: (req, file, cb) => {
      // Use timestamp + random string to avoid collisions
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, file.fieldname + '-' + uniqueSuffix + '-' + file.originalname);
    },
  }),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
  fileFilter: (_req, file, cb) => {
    // Check MIME type first
    if (isSupportedUploadType(file.mimetype)) {
      cb(null, true);
      return;
    }

    // If MIME type is generic (application/octet-stream), check file extension
    if (file.mimetype === 'application/octet-stream') {
      const ext = file.originalname.toLowerCase().split('.').pop();
      if (ext && isSupportedUploadType(ext)) {
        cb(null, true);
        return;
      }
    }

    cb(
      new Error(
        `Unsupported file type: ${file.mimetype}. Supported: PDF, DOCX, PPTX, HTML, images, and text formats.`,
      ),
    );
  },
});

/**
 * Sanitize metadata object (strip prototype pollution keys)
 */
function sanitizeMetadata(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key.startsWith('$') || key.startsWith('__')) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Strip file extension from a filename.
 */
function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.substring(0, lastDot) : filename;
}

/**
 * POST /:indexId/sources/:sourceId/documents
 *
 * Upload a document file and trigger the indexing pipeline.
 *
 * Query params:
 *   - force: If 'true', replace existing document with same content hash
 *
 * Body (multipart/form-data):
 *   - file: Document file (required)
 *   - metadata: JSON metadata (optional)
 */
router.post(
  '/:indexId/sources/:sourceId/documents',
  upload.single('file') as any, // Type workaround for Express middleware conflict
  handleMulterError, // Handle multer errors
  async (req: Request, res: Response, next: NextFunction) => {
    logger.info('POST handler invoked', {
      path: req.path,
      params: req.params,
      hasFile: !!req.file,
      contentType: req.headers['content-type'],
    });

    try {
      if (!req.tenantContext) {
        logger.error('No tenant context');
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { indexId, sourceId } = req.params;
      const tenantId = req.tenantContext.tenantId;
      const force = req.query.force === 'true' || req.body.force === 'true';

      logger.info('Received upload request', { indexId, sourceId, tenantId });

      // Run database operations within tenant context for AsyncLocalStorage
      await withTenantContext({ tenantId }, async () => {
        // Validate file uploaded
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded' });
          return;
        }

        // Verify index exists AND belongs to tenant (tenant isolation)
        const index = await SearchIndex.findOne(
          applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
        ).lean();

        if (!index) {
          res.status(404).json({ error: 'Index not found' });
          return;
        }

        // Verify source exists and belongs to this index AND tenant
        const source = await SearchSource.findOne({ _id: sourceId, indexId, tenantId }).lean();
        if (!source) {
          res.status(404).json({ error: 'Source not found for this index' });
          return;
        }

        // Look up ConnectorConfig for this source (universal connectorId)
        const ConnectorConfigModel = getLazyModel<IConnectorConfig>('ConnectorConfig');
        const connectorConfig = await ConnectorConfigModel.findOne({
          tenantId,
          sourceId,
        }).lean();
        const connectorId = connectorConfig?._id ?? null;

        // Parse user-provided metadata (optional JSON field)
        let userMetadata: Record<string, unknown> = {};
        if (req.body.metadata) {
          try {
            const parsed =
              typeof req.body.metadata === 'string'
                ? JSON.parse(req.body.metadata)
                : req.body.metadata;
            userMetadata = sanitizeMetadata(parsed);
          } catch (err) {
            res.status(400).json({ error: 'Invalid metadata JSON' });
            return;
          }
        }

        // Generate content hash from file on disk
        // FIX: BUG-5 - Read from disk instead of memory buffer
        const fs = await import('fs/promises');
        const fileBuffer = await fs.readFile(req.file.path);
        const contentHash = crypto
          .createHash('sha256')
          .update(fileBuffer)
          .digest('hex')
          .slice(0, 32);

        // Check for duplicate by content hash (optional deduplication)
        // MUST include tenantId for tenant isolation
        // Note: Check by indexId + contentHash only (matches MongoDB unique index)
        // Don't include sourceId - allows detecting duplicates across sources
        const existingDoc = await SearchDocument.findOne({
          tenantId,
          indexId,
          contentHash,
        }).lean();

        if (existingDoc && !force) {
          res.status(200).json({
            message: 'Document already exists (duplicate content hash). Use force=true to replace.',
            document: existingDoc,
          });
          return;
        }

        // If force=true and document exists, delete it first (cascade to pages/chunks/vectors)
        if (existingDoc && force) {
          workerLog('document-upload', `Force replacing existing document ${existingDoc._id}`);

          // FIX: Critical Bug #2 (BUG-2) - Vector Store Index Cleanup Missing
          // Delete vectors from vector store before deleting MongoDB records
          try {
            const SearchChunk = getLazyModel('SearchChunk');
            const chunks = await SearchChunk.find(
              { documentId: existingDoc._id, tenantId },
              { vectorId: 1, _id: 0 },
            ).lean();

            const vectorIds = chunks.map((c: any) => c.vectorId).filter((vid: any) => vid != null);

            if (vectorIds.length > 0) {
              workerLog(
                'document-upload',
                `Deleting ${vectorIds.length} vectors from vector store`,
              );

              // Dynamically import vector store to delete vectors
              const { createVectorStore, resolveIndexForWrite } =
                await import('@agent-platform/search-ai-internal');

              const vectorStoreConfig = {
                provider:
                  (process.env.VECTOR_STORE_PROVIDER as
                    | 'opensearch'
                    | 'qdrant'
                    | 'pinecone'
                    | 'pgvector') || 'opensearch',
                url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
                apiKey: process.env.VECTOR_STORE_API_KEY,
              };

              const vectorStore = createVectorStore(vectorStoreConfig);

              // Resolve the vector index name
              const vectorIndexName = await resolveIndexForWrite(
                vectorStore,
                tenantId,
                indexId,
                existingDoc.sourceId,
              );

              // Delete vectors
              await vectorStore.delete(vectorIndexName, vectorIds);

              workerLog(
                'document-upload',
                `Deleted ${vectorIds.length} vectors from index ${vectorIndexName}`,
              );

              // Close vector store connection
              await vectorStore.close();
            }
          } catch (error) {
            // Log error but don't fail the entire operation
            // Vector cleanup is important but shouldn't block document replacement
            workerError('document-upload', 'Failed to delete vectors from vector store', error);
            workerLog(
              'document-upload',
              'Continuing with document replacement despite vector cleanup failure',
            );
          }

          // Delete associated pages (use dual-connection context)
          const DocumentPage = getLazyModel('DocumentPage');
          await DocumentPage.deleteMany({ documentId: existingDoc._id, tenantId });

          // Delete document with proper vector store cleanup
          const { deleteDocumentsWithVectorCleanup } =
            await import('../services/document-cleanup.service.js');
          await deleteDocumentsWithVectorCleanup([String(existingDoc._id)], tenantId, indexId);

          workerLog('document-upload', `Deleted existing document and associated data`);
        }

        // Normalize MIME type (detect from extension if generic octet-stream)
        let contentType = req.file.mimetype;
        if (contentType === 'application/octet-stream') {
          const detectedType = detectMimeTypeFromExtension(req.file.originalname);
          if (detectedType) {
            contentType = detectedType;
            workerLog('document-upload', `Detected MIME type from extension: ${contentType}`, {
              originalMimeType: req.file.mimetype,
              filename: req.file.originalname,
            });
          }
        }

        // Build structured sourceMetadata under file_upload.* namespace
        // Auto-populate file-level fields + merge user-provided canonical fields
        const sourceMetadata = {
          file_upload: {
            title: userMetadata.title ?? stripExtension(req.file.originalname),
            mimeType: contentType,
            size: req.file.size,
            ...userMetadata,
          },
        };

        // Upload file via configured storage provider (S3/MinIO or local/NFS)
        const config = getConfig();
        const storage = createFileStorage(config.storage);
        let fileUrl: string;

        workerLog('document-upload', `Starting file storage (provider: ${storage.provider})`);

        const storageKey = generateStorageKey(
          `documents/${tenantId}/${indexId}`,
          req.file.originalname,
        );

        const uploadResult = await storage.upload(storageKey, fileBuffer, {
          contentType: contentType,
          metadata: {
            tenantId,
            indexId,
            sourceId,
            originalName: req.file.originalname,
          },
        });

        fileUrl = uploadResult.url;
        workerLog('document-upload', `File stored (${storage.provider}): ${fileUrl}`, {
          indexId,
          sourceId,
          size: req.file.size,
        });

        // FIX: BUG-5 - Clean up temp file after upload
        try {
          await fs.unlink(req.file.path);
          workerLog('document-upload', `Cleaned up temp file: ${req.file.path}`);
        } catch (cleanupError) {
          // Log but don't fail if temp file cleanup fails
          workerLog(
            'document-upload',
            `Failed to cleanup temp file (non-critical): ${req.file.path}`,
          );
        }

        // Create SearchDocument record
        workerLog('document-upload', `Creating SearchDocument record`);
        const document = await SearchDocument.create({
          tenantId,
          indexId,
          sourceId,
          connectorId,
          contentHash,
          name: req.file.originalname,
          originalReference: req.file.originalname,
          contentType: contentType,
          contentSizeBytes: req.file.size,
          sourceUrl: fileUrl,
          sourceMetadata,
          status: DocumentStatus.PENDING,
        });

        // Generate and store download URL for citations/external access
        try {
          const { resolvePermanentDownloadUrl } =
            await import('../services/ingestion/resolve-download-url.js');
          const downloadUrl = resolvePermanentDownloadUrl(document._id.toString(), tenantId);
          const publicBase =
            process.env.SEARCH_AI_PUBLIC_URL ||
            process.env.SEARCH_AI_URL ||
            'http://localhost:3005';
          const internalFileUrl = publicBase.includes('/api/search-ai')
            ? `${publicBase}/documents/${document._id}/internal-file`
            : `${publicBase}/api/documents/${document._id}/internal-file`;
          await SearchDocument.findOneAndUpdate(
            { _id: document._id, tenantId },
            { downloadUrl, internalFileUrl },
          );
        } catch {
          // Non-critical — document still processes without downloadUrl
        }

        // Increment document counts now that the record is committed
        await Promise.all([
          SearchIndex.findOneAndUpdate(
            applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
            { $inc: { documentCount: 1 } },
          ),
          KnowledgeBase.findOneAndUpdate(
            { searchIndexId: indexId, tenantId },
            { $inc: { documentCount: 1 } },
          ),
          SearchSource.findOneAndUpdate(
            { _id: sourceId, tenantId },
            { $inc: { documentCount: 1 } },
          ),
        ]);

        // ── Load pipeline stage configs (if active pipeline exists) ──────────
        let extractionStage: PipelineStageConfig | undefined;
        let chunkingStage: PipelineStageConfig | undefined;
        let enrichmentStage: PipelineStageConfig | undefined;
        let embeddingStage: PipelineStageConfig | undefined;

        try {
          const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
          if (kb) {
            // Prefer custom (non-default) active pipeline over the default
            const pipeline = await SearchPipelineDefinition.findOne(
              {
                knowledgeBaseId: kb._id,
                tenantId,
                status: 'active',
              },
              null,
              { sort: { isDefault: 1 } },
            ).lean();

            if (pipeline) {
              const flowService = new FlowSelectionService();
              const ext = req.file.originalname.split('.').pop() ?? '';
              const selResult = await flowService.selectFlow(pipeline.flows, {
                document: {
                  extension: ext,
                  mimeType: contentType,
                  size: req.file.size,
                  name: req.file.originalname,
                },
                source: { connector: '' },
              });

              if (selResult.success && selResult.flow) {
                const flow = selResult.flow;
                const pid = pipeline._id as string;
                const findStage = (type: string): PipelineStageConfig | undefined => {
                  const s = flow.stages.find((st: ISearchPipelineStage) => st.type === type);
                  if (!s) return undefined;
                  return {
                    pipelineId: pid,
                    flowId: flow.id,
                    provider: s.provider,
                    providerConfig: s.providerConfig as Record<string, unknown>,
                  };
                };
                extractionStage = findStage('extraction');
                chunkingStage = findStage('chunking');
                enrichmentStage = findStage('enrichment') ?? findStage('content-intelligence');
                embeddingStage = findStage('embedding');

                workerLog('document-upload', 'Pipeline stage configs resolved', {
                  flowId: flow.id,
                  flowName: flow.name,
                  chunkingProvider: chunkingStage?.provider,
                  chunkSize: chunkingStage?.providerConfig?.chunkSize,
                });
              }
            }
          }
        } catch (pipeErr) {
          workerLog('document-upload', 'Pipeline config lookup failed — using defaults', {
            error: pipeErr instanceof Error ? pipeErr.message : String(pipeErr),
          });
        }

        // Route document to appropriate extraction pipeline.
        // Pipeline extraction provider overrides the default MIME-type routing when set,
        // but NEVER for JSON or structured data (CSV/Excel) — these have dedicated
        // pipelines (field selection, ClickHouse ingestion) that must not be bypassed.
        let route = routeDocument(contentType);
        if (route !== 'json-chunking' && route !== 'structured') {
          if (extractionStage?.provider === 'llamaindex') {
            route = 'legacy';
          } else if (extractionStage?.provider === 'docling') {
            route = 'docling';
          } else if (extractionStage?.provider === 'http-webhook') {
            route = 'legacy';
          }
        }
        let finalStatus = document.status;

        try {
          if (route === 'json-chunking') {
            workerLog('document-upload', `Handling JSON record chunking`, {
              documentId: document._id,
              contentType,
              filename: req.file.originalname,
            });

            // Check if index has JSON field config
            // If not, pause the document — it will be processed after field selection
            // If yes but the new file has NEW fields not in the config, also pause
            const existingConfig = (index as any).jsonFieldConfig;
            const hasFieldConfig = !!existingConfig?.fields?.length;

            let hasNewFields = false;
            if (hasFieldConfig) {
              // Parse the uploaded JSON to extract its field paths
              // Compare against existing config — if new fields found, re-prompt
              try {
                const jsonText = fileBuffer.toString('utf-8');
                const jsonData = JSON.parse(jsonText);
                const records: Record<string, unknown>[] = Array.isArray(jsonData)
                  ? jsonData.slice(0, 5)
                  : typeof jsonData === 'object' &&
                      jsonData !== null &&
                      'data' in jsonData &&
                      Array.isArray(jsonData.data)
                    ? jsonData.data.slice(0, 5)
                    : typeof jsonData === 'object' &&
                        jsonData !== null &&
                        'records' in jsonData &&
                        Array.isArray(jsonData.records)
                      ? jsonData.records.slice(0, 5)
                      : typeof jsonData === 'object' && jsonData !== null
                        ? [jsonData]
                        : [];

                if (records.length > 0) {
                  const configPaths = new Set(
                    existingConfig.fields.map((f: { fieldPath: string }) => f.fieldPath),
                  );
                  const newPaths = extractLeafPaths(records[0]);
                  hasNewFields = newPaths.some((p) => !configPaths.has(p));
                }
              } catch {
                // If JSON parse fails here, let the worker handle the error later
              }
            }

            if (hasFieldConfig && !hasNewFields) {
              // Field config covers all fields → process immediately
              // Rebuild resolvedMappings from stored canonicalMapping values
              // so chunking worker applies them to canonical metadata
              const resolvedMappings = existingConfig.fields
                .filter(
                  (f: { selected: boolean; canonicalMapping?: string }) =>
                    f.selected && f.canonicalMapping,
                )
                .map(
                  (f: {
                    fieldPath: string;
                    fieldType: string;
                    canonicalMapping: string;
                    sampleValues?: string[];
                    maxLength?: number;
                  }) => {
                    // Alias = source field name (humanized) so filtering by
                    // original name works. Synonyms include canonical field name.
                    const alias = f.fieldPath
                      .replace(/([a-z])([A-Z])/g, '$1 $2')
                      .split(/[._-]/)
                      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ');
                    const synonyms: string[] = [];
                    if (f.fieldPath !== alias) synonyms.push(f.fieldPath);
                    if (
                      f.canonicalMapping !== f.fieldPath &&
                      f.canonicalMapping !== alias.toLowerCase()
                    ) {
                      synonyms.push(f.canonicalMapping);
                    }
                    const canonicalHumanized = f.canonicalMapping
                      .replace(/_/g, ' ')
                      .replace(/([a-z])([A-Z])/g, '$1 $2')
                      .split(/\s+/)
                      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ');
                    if (canonicalHumanized !== alias) synonyms.push(canonicalHumanized);

                    return {
                      sourceField: f.fieldPath,
                      canonicalField: f.canonicalMapping,
                      type:
                        f.fieldType === 'number'
                          ? 'number'
                          : f.fieldType === 'date'
                            ? 'date'
                            : 'keyword',
                      filterable: true,
                      sortable: f.fieldType === 'number' || f.fieldType === 'date',
                      aggregatable: f.fieldType === 'number',
                      alias,
                      synonyms,
                      description: `${f.fieldPath} → ${f.canonicalMapping}`,
                      sampleValues: f.sampleValues || [],
                    };
                  },
                );

              const QUEUE_JSON_RECORD_CHUNKING = 'json-record-chunking';
              const jsonQueue = createQueue(QUEUE_JSON_RECORD_CHUNKING);
              try {
                await jsonQueue.add(`json-chunk:${document._id}`, {
                  indexId,
                  documentId: document._id.toString(),
                  sourceUrl: fileUrl,
                  tenantId,
                  resolvedMappings: resolvedMappings.length > 0 ? resolvedMappings : undefined,
                });
                workerLog('document-upload', `Enqueued JSON record chunking job`, {
                  documentId: document._id,
                  resolvedMappingCount: resolvedMappings.length,
                });
              } finally {
                await jsonQueue.close();
              }
            } else if (!hasFieldConfig) {
              // No field config exists. Behavior depends on autoProcess flag:
              // - autoProcess=true (default for API) → auto-select all fields, process immediately
              // - autoProcess=false (UI sends this) → pause for field selection dialog
              const autoProcess = req.query.autoProcess !== 'false';

              if (!autoProcess) {
                // UI path: show field selection dialog
                await SearchDocument.findOneAndUpdate(
                  { _id: document._id, tenantId },
                  { $set: { status: 'pending_field_selection' } },
                );
                finalStatus = 'pending_field_selection';
                workerLog(
                  'document-upload',
                  'JSON document paused — waiting for field selection (autoProcess=false)',
                  {
                    documentId: document._id,
                  },
                );
              } else {
                // API path: auto-configure and process immediately
                workerLog('document-upload', 'Auto-configuring JSON fields (no prior config)', {
                  documentId: document._id,
                });

                try {
                  const jsonText = fileBuffer.toString('utf-8');
                  let jsonData: unknown;
                  try {
                    jsonData = JSON.parse(jsonText);
                  } catch {
                    throw new Error('Invalid JSON file');
                  }

                  const records: Record<string, unknown>[] = Array.isArray(jsonData)
                    ? jsonData
                    : typeof jsonData === 'object' &&
                        jsonData !== null &&
                        'data' in jsonData &&
                        Array.isArray((jsonData as any).data)
                      ? (jsonData as any).data
                      : typeof jsonData === 'object' &&
                          jsonData !== null &&
                          'records' in jsonData &&
                          Array.isArray((jsonData as any).records)
                        ? (jsonData as any).records
                        : typeof jsonData === 'object' && jsonData !== null
                          ? [jsonData as Record<string, unknown>]
                          : [];

                  if (records.length === 0) {
                    throw new Error('JSON file contains no records');
                  }

                  // Extract fields from sample records
                  const sampleRecords = records.slice(0, 10);
                  const fieldPaths = extractLeafPaths(sampleRecords[0]);

                  // Auto-select ALL fields, detect types
                  const autoFields = fieldPaths.map((fp) => {
                    const sampleValues: string[] = [];
                    for (const rec of sampleRecords.slice(0, 5)) {
                      const val = fp.split('.').reduce((obj: any, key) => obj?.[key], rec);
                      if (val != null) sampleValues.push(String(val).slice(0, 80));
                    }
                    const firstVal = sampleValues[0] || '';
                    const fieldType =
                      typeof fp
                        .split('.')
                        .reduce((obj: any, key) => obj?.[key], sampleRecords[0]) === 'number'
                        ? 'number'
                        : typeof fp
                              .split('.')
                              .reduce((obj: any, key) => obj?.[key], sampleRecords[0]) === 'boolean'
                          ? 'boolean'
                          : /^\d{4}-\d{2}-\d{2}/.test(firstVal)
                            ? 'date'
                            : 'string';

                    return {
                      fieldPath: fp,
                      fieldType,
                      selected: true,
                      sampleValues,
                      maxLength: Math.max(...sampleValues.map((v) => v.length), 0),
                    };
                  });

                  // Save auto-generated field config
                  await SearchIndex.findOneAndUpdate(
                    { _id: indexId, tenantId },
                    {
                      $set: {
                        jsonFieldConfig: {
                          version: 1,
                          fields: autoFields,
                          autoSuggestApplied: false,
                          updatedAt: new Date(),
                        },
                      },
                    },
                  );

                  // Enqueue chunking immediately (no resolved mappings — worker uses rules)
                  const QUEUE_JSON_RECORD_CHUNKING = 'json-record-chunking';
                  const jsonQueue = createQueue(QUEUE_JSON_RECORD_CHUNKING);
                  try {
                    await jsonQueue.add(`json-chunk:${document._id}`, {
                      indexId,
                      documentId: document._id.toString(),
                      sourceUrl: fileUrl,
                      tenantId,
                    });
                    workerLog('document-upload', 'Auto-configured and enqueued JSON chunking', {
                      documentId: document._id,
                      fieldCount: autoFields.length,
                    });
                  } finally {
                    await jsonQueue.close();
                  }
                } catch (autoErr) {
                  // Auto-config failed — fall back to pending_field_selection
                  workerLog('document-upload', 'Auto-config failed, falling back to pending', {
                    documentId: document._id,
                    error: autoErr instanceof Error ? autoErr.message : String(autoErr),
                  });
                  await SearchDocument.findOneAndUpdate(
                    { _id: document._id, tenantId },
                    { $set: { status: 'pending_field_selection' } },
                  );
                  finalStatus = 'pending_field_selection';
                }
              } // end autoProcess=true block
            } else {
              // Has field config but new fields detected → pause for field selection
              await SearchDocument.findOneAndUpdate(
                { _id: document._id, tenantId },
                { $set: { status: 'pending_field_selection' } },
              );
              finalStatus = 'pending_field_selection';
              workerLog(
                'document-upload',
                `JSON document paused — new fields detected, needs updated field selection`,
                { documentId: document._id },
              );
            }
          } else if (route === 'structured') {
            workerLog('document-upload', `Handling structured data (auto-analyze)`, {
              documentId: document._id,
              contentType,
              filename: req.file.originalname,
            });

            // Auto-analyze schema for direct upload
            const { StructuredDataSchemaAnalyzer } =
              await import('../services/structured-data/schema-analyzer.js');
            const { StructuredDataClickHouseClient } =
              await import('../services/structured-data/clickhouse-client.js');
            const { v4: uuidv4 } = await import('uuid');

            const analyzer = new StructuredDataSchemaAnalyzer();
            const analysis = await analyzer.analyze(fileBuffer, req.file.originalname, contentType);

            workerLog('document-upload', `Schema analysis complete`, {
              documentId: document._id,
              rowCount: analysis.schema.rowCount,
              columnCount: analysis.schema.columns.length,
            });

            // Generate table ID and create ClickHouse table
            const tableId = uuidv4();
            const chClient = new StructuredDataClickHouseClient();
            await chClient.initialize();
            await chClient.createDataTable(tenantId, indexId, tableId);

            workerLog('document-upload', `ClickHouse table created`, {
              documentId: document._id,
              tableId,
            });

            // Build complete IngestionJobData with auto-detected schema
            const jobData: import('../services/structured-data/ingestion-types.js').IngestionJobData =
              {
                tenantId,
                indexId,
                documentId: String(document._id),
                tableId,
                tableName: analysis.schema.tableName,
                displayName: analysis.schema.tableName,
                description: `Auto-uploaded ${req.file.originalname}`,
                columns: analysis.schema.columns.map((col) => ({
                  name: col.name,
                  type: col.type,
                  description: '',
                  isEmbeddable: col.isEmbeddable,
                  isFilterable: col.isFilterable,
                })),
                primaryKey: analysis.schema.primaryKey,
                fileBuffer: fileBuffer,
                originalFilename: req.file.originalname,
                mimeType: contentType,
                fileSize: req.file.size,
                metadata: {},
                createdAt: new Date(),
              };

            const QUEUE_STRUCTURED_INGESTION = 'structured-data-ingestion';
            const structuredQueue = createQueue(QUEUE_STRUCTURED_INGESTION);
            try {
              await structuredQueue.add(`structured-ingest:${tableId}`, jobData, {
                attempts: 3,
                backoff: {
                  type: 'exponential',
                  delay: 5000,
                },
              });
              workerLog('document-upload', `Enqueued structured data ingestion job`, {
                documentId: document._id,
                tableId,
              });
            } finally {
              await structuredQueue.close();
            }

            // Seed vocabulary for structured data uploads (CSV/JSON) too.
            // Non-blocking: fire-and-forget so upload isn't delayed.
            (async () => {
              try {
                await seedDocumentUploadVocabulary(tenantId, indexId);
                const vocabEntries = generateDocumentVocabularyEntries({
                  mime_type: contentType,
                  source_type: 'manual',
                });
                await upsertDocumentVocabulary(tenantId, indexId, vocabEntries);
                logger.info('Structured data vocabulary seeded', {
                  indexId,
                  entryCount: vocabEntries.length,
                });
              } catch (err: unknown) {
                logger.warn('Non-fatal: structured data vocabulary seeding failed', {
                  error: err instanceof Error ? err.message : String(err),
                  indexId,
                });
              }
            })();
          } else {
            // Docling or legacy extraction — real documents (PDF, DOCX, etc.)
            // Generate vocabulary entries dynamically based on user-filled metadata fields.
            // Non-blocking: fire-and-forget so upload isn't delayed.
            (async () => {
              try {
                // Seed base vocabulary first (idempotent — skips if already present)
                await seedDocumentUploadVocabulary(tenantId, indexId);

                // Add mime_type to metadata for vocabulary generation
                // mime_type is the canonical field for document format filtering
                // (PDF, CSV, JSON, etc.) — source_type is for the connector source
                const metadataForVocab = {
                  ...userMetadata,
                  mime_type: contentType,
                  source_type: 'manual',
                };

                // FIELDS FIRST: register in CanonicalSchema + FieldMappings
                const STATIC_FIELDS = ['created_date', 'mime_type', 'source_type'];
                const userFilledKeys = Object.keys(userMetadata).filter(
                  (k) => userMetadata[k] != null && userMetadata[k] !== '' && !k.startsWith('_'),
                );
                const allFieldNames = [...STATIC_FIELDS, ...userFilledKeys].filter(
                  (v, i, a) => a.indexOf(v) === i,
                );
                await registerDocumentFields(tenantId, indexId, allFieldNames);

                // VOCAB SECOND: derived from fields
                const vocabEntries = generateDocumentVocabularyEntries(metadataForVocab);
                await upsertDocumentVocabulary(tenantId, indexId, vocabEntries);

                // Register metadata fields in CanonicalSchema (Fields tab).
                // Always: 3 static fields (created_date, mime_type, source_type)
                // Plus: any user-filled fields from the upload form
                const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
                const STATIC_SCHEMA_FIELDS = ['created_date', 'mime_type', 'source_type'];
                const userFilledFields = Object.keys(userMetadata).filter(
                  (k) => userMetadata[k] != null && userMetadata[k] !== '' && !k.startsWith('_'),
                );
                const filledFieldNames = [...STATIC_SCHEMA_FIELDS, ...userFilledFields].filter(
                  (v, i, a) => a.indexOf(v) === i,
                );

                if (filledFieldNames.length > 0) {
                  const existingSchema = await CanonicalSchemaModel.findOne({
                    knowledgeBaseId: indexId,
                    tenantId,
                    status: 'active',
                  }).sort({ version: -1 });

                  const existingStorageFields = new Set(
                    (existingSchema?.fields || []).map((f: any) => f.storageField),
                  );

                  const newFields: any[] = [];
                  for (const fieldName of filledFieldNames) {
                    const availField = getAvailableField(fieldName);
                    if (availField && !existingStorageFields.has(availField.storageField)) {
                      newFields.push(toCanonicalField(availField));
                      existingStorageFields.add(availField.storageField);
                    }
                  }

                  if (newFields.length > 0) {
                    if (existingSchema) {
                      await CanonicalSchemaModel.findOneAndUpdate(
                        { _id: existingSchema._id, tenantId },
                        { $push: { fields: { $each: newFields } } },
                      );
                    } else {
                      await CanonicalSchemaModel.create({
                        tenantId,
                        knowledgeBaseId: indexId,
                        version: 1,
                        fields: newFields,
                        status: 'active',
                      });
                    }
                    // Also create FieldMappings so they appear in Fields tab
                    const FieldMappingModel = getLazyModel('FieldMapping');
                    const schemaId = existingSchema
                      ? existingSchema._id
                      : (
                          await CanonicalSchemaModel.findOne({
                            knowledgeBaseId: indexId,
                            tenantId,
                            status: 'active',
                          })
                        )?._id;

                    if (schemaId) {
                      const connectorId = `manual-upload:${indexId}`;
                      const mappingDocs = newFields.map((f: any) => ({
                        tenantId,
                        canonicalSchemaId: schemaId,
                        canonicalField: f.storageField,
                        connectorId,
                        sourcePath: f.storageField,
                        transform: { type: 'direct' },
                        confidence: 1.0,
                        status: 'active',
                        suggestedBy: 'system',
                        reviewedBy: 'system',
                        reviewedAt: new Date(),
                      }));
                      await FieldMappingModel.insertMany(mappingDocs, { ordered: false }).catch(
                        () => {},
                      );
                    }

                    logger.info('Registered metadata fields in CanonicalSchema + FieldMappings', {
                      indexId,
                      newFieldCount: newFields.length,
                      fields: newFields.map((f: any) => f.storageField),
                    });
                  }
                }

                logger.info('Document vocabulary generated and upserted', {
                  indexId,
                  entryCount: vocabEntries.length,
                  filledFields: Object.keys(userMetadata).length,
                });
              } catch (err: unknown) {
                logger.warn('Non-fatal: document vocabulary generation failed', {
                  error: err instanceof Error ? err.message : String(err),
                  indexId,
                });
              }
            })();

            const queueName = route === 'docling' ? QUEUE_DOCLING_EXTRACTION : QUEUE_EXTRACTION;

            workerLog('document-upload', `Creating queue: ${queueName}`);
            const extractionQueue = createQueue(queueName);
            try {
              const extractionJobData: DoclingExtractionJobData & Record<string, unknown> = {
                indexId,
                documentId: document._id.toString(),
                sourceUrl: fileUrl,
                tenantId,
                pipelineStage: extractionStage,
              };
              // Attach downstream stage configs for propagation through worker chain
              if (chunkingStage) extractionJobData._chunkingStage = chunkingStage;
              if (enrichmentStage) extractionJobData._enrichmentStage = enrichmentStage;
              if (embeddingStage) extractionJobData._embeddingStage = embeddingStage;

              await extractionQueue.add(`${route}-extract:${document._id}`, extractionJobData);

              workerLog('document-upload', `Enqueued ${route} extraction job`, {
                documentId: document._id,
                route,
                contentType: contentType,
              });
            } finally {
              await extractionQueue.close();
            }
          }
        } catch (queueError) {
          // FIX: UI-34 — job queue failed after document was created; delete the orphan to avoid
          // a 'pending' ghost document that will never be processed.
          workerLog(
            'document-upload',
            `Job queue failed — cleaning up orphaned document ${document._id}`,
          );
          await Promise.allSettled([
            SearchDocument.deleteOne({ _id: document._id, tenantId }),
            SearchIndex.findOneAndUpdate(
              applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
              { $inc: { documentCount: -1 } },
            ),
            KnowledgeBase.findOneAndUpdate(
              { searchIndexId: indexId, tenantId },
              { $inc: { documentCount: -1 } },
            ),
            SearchSource.findOneAndUpdate(
              { _id: sourceId, tenantId },
              { $inc: { documentCount: -1 } },
            ),
          ]);
          throw queueError;
        }

        // Update source status to active if it was pending
        if (source.status === SourceStatus.PENDING) {
          await SearchSource.findOneAndUpdate(
            { _id: sourceId, tenantId },
            { status: SourceStatus.ACTIVE },
          );
        }

        res.status(201).json({
          id: document._id,
          originalReference: document.originalReference,
          contentType: document.contentType,
          contentSizeBytes: document.contentSizeBytes,
          status: finalStatus,
          metadata: document.sourceMetadata,
          createdAt: document.createdAt,
        });
        // Update upload field hints on ConnectorConfig (sticky fields)
        if (connectorId) {
          const usedFields = Object.keys(userMetadata).filter(
            (key) => userMetadata[key] != null && userMetadata[key] !== '',
          );
          if (usedFields.length > 0) {
            const lastValues: Record<string, string> = {};
            for (const key of usedFields) {
              lastValues[key] = String(userMetadata[key]);
            }
            await ConnectorConfigModel.findOneAndUpdate(
              { _id: connectorId, tenantId },
              {
                $set: {
                  uploadFieldHints: {
                    recentFields: usedFields,
                    lastValues,
                    updatedAt: new Date(),
                  },
                },
              },
            );
          }
        }
      }); // End withTenantContext
    } catch (error) {
      // FIX: BUG-5 - Clean up temp file on error
      if (req.file?.path) {
        try {
          const fs = await import('fs/promises');
          await fs.unlink(req.file.path);
          workerLog('document-upload', `Cleaned up temp file on error: ${req.file.path}`);
        } catch (cleanupError) {
          workerLog('document-upload', `Failed to cleanup temp file on error: ${req.file.path}`);
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error('Upload failed', {
        error: errorMessage,
        stack: errorStack,
        indexId: req.params.indexId,
        sourceId: req.params.sourceId,
        tenantId: req.tenantContext?.tenantId,
        fileName: req.file?.originalname,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error)),
      });

      // Guard against double-response: if 201 was already sent (e.g., post-upload
      // async work like ConnectorConfig update failed), just log — don't crash.
      if (res.headersSent) {
        logger.error('Post-upload error (response already sent)', { error: errorMessage });
        return;
      }

      // Send more specific error message in development
      if (process.env.NODE_ENV === 'development') {
        res.status(500).json({
          error: 'Upload failed',
          message: errorMessage,
          details: errorStack?.split('\n').slice(0, 5).join('\n'),
        });
        return;
      }

      next(error);
    }
  },
);

/**
 * GET /:indexId/documents/status — Batch Document Status (public API)
 *
 * IMPORTANT: This route MUST be before /:indexId/documents/:documentId
 * to prevent Express from matching "status" as a documentId param.
 */
router.get('/:indexId/documents/status', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    const idsParam = req.query.ids as string;

    if (!idsParam) {
      res.status(400).json({
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'Query parameter "ids" is required (comma-separated document IDs)',
        },
      });
      return;
    }

    const ids = idsParam
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_BATCH_IDS);

    const documents = await SearchDocument.find(
      { _id: { $in: ids }, indexId, tenantId },
      {
        _id: 1,
        status: 1,
        pageCount: 1,
        chunkCount: 1,
        createdAt: 1,
        updatedAt: 1,
        sourceMetadata: 1,
      },
    ).lean();

    res.json({
      success: true,
      data: {
        documents: documents.map((doc: any) => ({
          documentId: doc._id,
          status: doc.status,
          progress: computeProgress(doc),
          pageCount: doc.pageCount ?? 0,
          chunkCount: doc.chunkCount ?? 0,
          error: null,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          completedAt: null,
        })),
      },
    });
  } catch (error) {
    logger.error('Batch status failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get batch status' },
    });
  }
});

// NOTE: GET /:indexId/documents/:documentId is served by documentsRouter (documents.ts)
// which provides a richer response with chunks + pagination. Do NOT duplicate here.

// =============================================================================
// PUBLIC INGESTION API — Source-Resolved Upload
// =============================================================================
//
// POST /:indexId/documents (no sourceId required)
//
// Unlike the internal route above which requires sourceId, this route resolves
// the source automatically:
// - If request includes `sourceName` → find or create source by that name
// - If not provided → use the first existing source on the index
// - If no sources exist → create one named "default"
//
// Additional features over internal route:
// - JSON body ingestion (no file required — pass `data` field)
// - Document ACL permissions (allowedUsers, allowedGroups, allowedDomains)
// - Webhook callback on completion (HMAC-SHA256 signed)
// - Scope enforcement: API keys need 'search.ingest' scope
// =============================================================================

// ─── Public API Constants ────────────────────────────────────────────────────

const DEFAULT_SOURCE_NAME = 'default';
const WEBHOOK_TTL_SECONDS = 86400; // 24 hours
const MAX_BATCH_IDS = 50;

// ─── Public API Types ────────────────────────────────────────────────────────

interface DocumentPermissions {
  allowedUsers?: string[];
  allowedGroups?: string[];
  allowedDomains?: string[];
  publicEverywhere?: boolean;
}

// ─── Public API Helpers ──────────────────────────────────────────────────────

/**
 * Check if API key caller has required scope. JWT users always have full access.
 */
function hasScope(req: Request, scope: string): boolean {
  const ctx = req.tenantContext;
  if (!ctx) return false;
  if (ctx.authType === 'user') return true;
  return ctx.permissions.includes(scope);
}

/**
 * Validate and parse permissions from request body or multipart field.
 */
function parsePermissions(raw: unknown): DocumentPermissions | null {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object') return null;

  const perms: DocumentPermissions = {};
  if (Array.isArray(parsed.allowedUsers)) {
    perms.allowedUsers = parsed.allowedUsers.filter(
      (u: unknown) => typeof u === 'string' && u.length > 0,
    );
  }
  if (Array.isArray(parsed.allowedGroups)) {
    perms.allowedGroups = parsed.allowedGroups.filter(
      (g: unknown) => typeof g === 'string' && g.length > 0,
    );
  }
  if (Array.isArray(parsed.allowedDomains)) {
    perms.allowedDomains = parsed.allowedDomains.filter(
      (d: unknown) => typeof d === 'string' && d.length > 0,
    );
  }
  if (typeof parsed.publicEverywhere === 'boolean') {
    perms.publicEverywhere = parsed.publicEverywhere;
  }
  return perms;
}

/**
 * Resolve the source for a document upload.
 *
 * If `sourceName` is provided, find or create a source with that name.
 * If not provided, use the first existing source on the index.
 * If no source exists at all, create one named "default".
 */
async function resolveUploadSource(
  tenantId: string,
  indexId: string,
  sourceName?: string,
): Promise<string> {
  const nameToUse = sourceName?.trim() || undefined;

  if (nameToUse) {
    const existing = await SearchSource.findOne({ tenantId, indexId, name: nameToUse }).lean();
    if (existing) return String(existing._id);

    const newSource = await SearchSource.create({
      tenantId,
      indexId,
      name: nameToUse,
      sourceType: 'manual',
      status: SourceStatus.ACTIVE,
      sourceConfig: { type: 'ingest-api' },
      documentCount: 0,
    });
    logger.info('Created source for ingestion', {
      tenantId,
      indexId,
      sourceId: newSource._id,
      sourceName: nameToUse,
    });
    return String(newSource._id);
  }

  // No source name — use the first existing source on the index
  const firstSource = await SearchSource.findOne({ tenantId, indexId })
    .sort({ createdAt: 1 })
    .lean();
  if (firstSource) return String(firstSource._id);

  // No sources exist — create a "default" source
  const defaultSource = await SearchSource.create({
    tenantId,
    indexId,
    name: DEFAULT_SOURCE_NAME,
    sourceType: 'manual',
    status: SourceStatus.ACTIVE,
    sourceConfig: { type: 'ingest-api' },
    documentCount: 0,
  });
  logger.info('Created default source for ingestion', {
    tenantId,
    indexId,
    sourceId: defaultSource._id,
  });
  return String(defaultSource._id);
}

/**
 * Set document permissions in acl_document_permissions collection.
 */
async function setDocumentPermissions(
  tenantId: string,
  documentId: string,
  permissions: DocumentPermissions,
): Promise<void> {
  const { MongoPermissionStore } = await import('@agent-platform/search-ai-internal/permissions');
  const store = MongoPermissionStore.getInstance();

  await store.upsertDocument({
    tenantId,
    documentId,
    sourceId: 'ingest-api',
    source: 'sharepoint' as any,
    publicInDomain: false,
    publicEverywhere: permissions.publicEverywhere ?? false,
  });

  if (permissions.allowedUsers?.length) {
    for (const email of permissions.allowedUsers) {
      await store.setPermission({
        tenantId,
        documentId,
        userEmail: email,
        role: 'read',
        source: 'sharepoint' as any,
      });
    }
  }

  if (permissions.allowedGroups?.length) {
    for (const groupId of permissions.allowedGroups) {
      await store.setPermission({
        tenantId,
        documentId,
        groupId,
        role: 'read',
        source: 'sharepoint' as any,
      });
    }
  }

  if (permissions.allowedDomains?.length) {
    for (const domain of permissions.allowedDomains) {
      await store.setPublicInDomain(tenantId, documentId, domain);
    }
  }

  logger.info('Document permissions set', {
    tenantId,
    documentId,
    userCount: permissions.allowedUsers?.length ?? 0,
    groupCount: permissions.allowedGroups?.length ?? 0,
    domainCount: permissions.allowedDomains?.length ?? 0,
    publicEverywhere: permissions.publicEverywhere ?? false,
  });
}

/**
 * Store webhook configuration in Redis (24h TTL).
 */
async function storeWebhookConfig(
  documentId: string,
  webhookUrl: string,
  webhookSecret?: string,
): Promise<void> {
  const { getSharedRedisClient } = await import('../workers/shared.js');
  const redis = getSharedRedisClient();
  if (!redis) {
    logger.warn('Redis not available — webhook will not be delivered', { documentId });
    return;
  }
  const config = JSON.stringify({
    url: webhookUrl,
    secret: webhookSecret ?? null,
    createdAt: new Date().toISOString(),
  });
  await redis.setex(`webhook:doc:${documentId}`, WEBHOOK_TTL_SECONDS, config);
  logger.info('Webhook config stored', { documentId, url: webhookUrl });
}

/**
 * Compute document processing progress from its status.
 */
function computeProgress(doc: any): { stage: string; percentage: number } {
  const statusMap: Record<string, { stage: string; percentage: number }> = {
    pending: { stage: 'queued', percentage: 0 },
    extracting: { stage: 'extraction', percentage: 20 },
    extracted: { stage: 'extraction', percentage: 40 },
    enriching: { stage: 'enrichment', percentage: 60 },
    enriched: { stage: 'enrichment', percentage: 70 },
    embedding: { stage: 'embedding', percentage: 80 },
    indexed: { stage: 'complete', percentage: 100 },
    error: { stage: 'error', percentage: 0 },
    pending_field_selection: { stage: 'awaiting_config', percentage: 5 },
  };
  return statusMap[doc.status] ?? { stage: 'unknown', percentage: 0 };
}

// ─── POST /:indexId/documents — Public File Upload or JSON Body Ingestion ────

router.post(
  '/:indexId/documents',
  upload.single('file') as any,
  handleMulterError,
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      // Scope check: API keys need 'search.ingest'
      if (!hasScope(req, 'search.ingest')) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Missing required scope: search.ingest' },
        });
        return;
      }

      const { indexId } = req.params;
      const tenantId = req.tenantContext.tenantId;

      await withTenantContext({ tenantId }, async () => {
        // Verify index exists and belongs to tenant
        const index = await SearchIndex.findOne(
          applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
        ).lean();

        if (!index) {
          res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Index not found' },
          });
          return;
        }

        // Resolve source: use provided sourceName, or fall back to existing/default
        const sourceId = await resolveUploadSource(tenantId, indexId, req.body?.sourceName);

        // Determine if this is a file upload or JSON body ingestion
        const isFileUpload = !!req.file;
        const isJsonBody = !isFileUpload && req.body?.data !== undefined;

        if (!isFileUpload && !isJsonBody) {
          res.status(400).json({
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'Either upload a file (multipart) or provide a JSON body with "data" field',
            },
          });
          return;
        }

        // Parse metadata
        let userMetadata: Record<string, unknown> = {};
        if (req.body?.metadata) {
          try {
            const metaRaw =
              typeof req.body.metadata === 'string'
                ? JSON.parse(req.body.metadata)
                : req.body.metadata;
            userMetadata = sanitizeMetadata(metaRaw);
          } catch (parseErr) {
            res.status(400).json({
              success: false,
              error: { code: 'BAD_REQUEST', message: 'Invalid metadata JSON' },
            });
            return;
          }
        }

        // Parse permissions (optional)
        let permissions: DocumentPermissions | null = null;
        if (req.body?.permissions) {
          try {
            permissions = parsePermissions(req.body.permissions);
          } catch (parseErr) {
            res.status(400).json({
              success: false,
              error: { code: 'BAD_REQUEST', message: 'Invalid permissions JSON' },
            });
            return;
          }

          // API keys need additional scope for setting permissions
          if (permissions && req.tenantContext!.authType === 'api_key') {
            if (!hasScope(req, 'search.permission_write')) {
              res.status(403).json({
                success: false,
                error: {
                  code: 'FORBIDDEN',
                  message:
                    'API key requires search.permission_write scope to set document permissions',
                },
              });
              return;
            }
          }
        }

        // Parse webhook config (optional)
        const webhookUrl = req.body?.webhookUrl as string | undefined;
        const webhookSecret = req.body?.webhookSecret as string | undefined;
        if (webhookUrl) {
          try {
            new URL(webhookUrl);
          } catch {
            res.status(400).json({
              success: false,
              error: { code: 'BAD_REQUEST', message: 'Invalid webhookUrl — must be a valid URL' },
            });
            return;
          }
        }

        let fileBuffer: Buffer;
        let contentType: string;
        let originalFilename: string;
        let fileSize: number;

        if (isFileUpload) {
          const fsPromises = await import('fs/promises');
          fileBuffer = await fsPromises.readFile(req.file!.path);
          contentType = req.file!.mimetype;
          originalFilename = req.file!.originalname;
          fileSize = req.file!.size;

          if (contentType === 'application/octet-stream') {
            const detected = detectMimeTypeFromExtension(originalFilename);
            if (detected) contentType = detected;
          }
        } else {
          // JSON body ingestion
          const jsonData = req.body.data;
          const jsonString = typeof jsonData === 'string' ? jsonData : JSON.stringify(jsonData);
          fileBuffer = Buffer.from(jsonString, 'utf-8');
          contentType = (req.body.contentType as string) || 'application/json';
          originalFilename =
            (req.body.fileName as string) ||
            (userMetadata.title as string) ||
            `json-ingest-${Date.now()}.json`;
          fileSize = fileBuffer.length;
        }

        // Generate content hash
        const contentHash = crypto
          .createHash('sha256')
          .update(fileBuffer)
          .digest('hex')
          .slice(0, 32);

        // Check for duplicates
        const existingDoc = await SearchDocument.findOne({
          tenantId,
          indexId,
          contentHash,
        }).lean();

        const force = req.body?.force === true || req.body?.force === 'true';
        if (existingDoc && !force) {
          res.status(200).json({
            success: true,
            data: {
              documentId: existingDoc._id,
              status: existingDoc.status,
              message:
                'Document already exists (duplicate content hash). Use force=true to replace.',
              statusUrl: `/api/indexes/${indexId}/documents/${existingDoc._id}`,
            },
          });
          return;
        }

        // If force=true and exists, delete existing
        if (existingDoc && force) {
          logger.info('Force replacing existing document', {
            documentId: existingDoc._id,
            tenantId,
          });
          const { deleteDocumentsWithVectorCleanup } =
            await import('../services/document-cleanup.service.js');
          await deleteDocumentsWithVectorCleanup([String(existingDoc._id)], tenantId, indexId);
        }

        // Upload file to storage
        const config = getConfig();
        const storage = createFileStorage(config.storage);
        const storageKey = generateStorageKey(`documents/${tenantId}/${indexId}`, originalFilename);

        const uploadResult = await storage.upload(storageKey, fileBuffer, {
          contentType,
          metadata: { tenantId, indexId, sourceId, originalName: originalFilename },
        });

        const fileUrl = uploadResult.url;
        logger.info('File stored', { provider: storage.provider, url: fileUrl, size: fileSize });

        // Clean up temp file if file upload
        if (isFileUpload && req.file?.path) {
          try {
            const fsPromises = await import('fs/promises');
            await fsPromises.unlink(req.file.path);
          } catch (cleanupErr) {
            logger.warn('Failed to cleanup temp file', {
              path: req.file.path,
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
        }

        // Build sourceMetadata
        const sourceMetadata = {
          file_upload: {
            title: userMetadata.title ?? stripExtension(originalFilename),
            mimeType: contentType,
            size: fileSize,
            ...userMetadata,
          },
        };

        // Create SearchDocument record
        const document = await SearchDocument.create({
          tenantId,
          indexId,
          sourceId,
          contentHash,
          name: originalFilename,
          originalReference: originalFilename,
          contentType,
          contentSizeBytes: fileSize,
          sourceUrl: fileUrl,
          sourceMetadata,
          status: DocumentStatus.PENDING,
        });

        const documentId = String(document._id);

        // Increment document counts
        await Promise.all([
          SearchIndex.findOneAndUpdate(
            applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
            { $inc: { documentCount: 1 } },
          ),
          KnowledgeBase.findOneAndUpdate(
            { searchIndexId: indexId, tenantId },
            { $inc: { documentCount: 1 } },
          ),
          SearchSource.findOneAndUpdate(
            { _id: sourceId, tenantId },
            { $inc: { documentCount: 1 } },
          ),
        ]);

        // Set document permissions
        if (permissions) {
          await setDocumentPermissions(tenantId, documentId, permissions);
        } else {
          await setDocumentPermissions(tenantId, documentId, { publicEverywhere: true });
        }

        // Store webhook config
        if (webhookUrl) {
          await storeWebhookConfig(documentId, webhookUrl, webhookSecret);
        }

        // ── Pipeline stage config resolution ──────────────────────────────
        let extractionStage: PipelineStageConfig | undefined;
        let chunkingStage: PipelineStageConfig | undefined;
        let enrichmentStage: PipelineStageConfig | undefined;
        let embeddingStage: PipelineStageConfig | undefined;

        try {
          const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
          if (kb) {
            const pipeline = await SearchPipelineDefinition.findOne(
              { knowledgeBaseId: kb._id, tenantId, status: 'active' },
              null,
              { sort: { isDefault: 1 } },
            ).lean();

            if (pipeline) {
              const flowService = new FlowSelectionService();
              const ext = originalFilename.split('.').pop() ?? '';
              const selResult = await flowService.selectFlow(pipeline.flows, {
                document: {
                  extension: ext,
                  mimeType: contentType,
                  size: fileSize,
                  name: originalFilename,
                },
                source: { connector: '' },
              });

              if (selResult.success && selResult.flow) {
                const flow = selResult.flow;
                const pid = pipeline._id as string;
                const findStage = (type: string): PipelineStageConfig | undefined => {
                  const s = flow.stages.find((st: ISearchPipelineStage) => st.type === type);
                  if (!s) return undefined;
                  return {
                    pipelineId: pid,
                    flowId: flow.id,
                    provider: s.provider,
                    providerConfig: s.providerConfig as Record<string, unknown>,
                  };
                };
                extractionStage = findStage('extraction');
                chunkingStage = findStage('chunking');
                enrichmentStage = findStage('enrichment') ?? findStage('content-intelligence');
                embeddingStage = findStage('embedding');
              }
            }
          }
        } catch (pipeErr) {
          logger.warn('Pipeline config lookup failed — using defaults', {
            error: pipeErr instanceof Error ? pipeErr.message : String(pipeErr),
          });
        }

        // Route document to extraction pipeline
        let route = routeDocument(contentType);
        if (route !== 'json-chunking' && route !== 'structured') {
          if (extractionStage?.provider === 'llamaindex') route = 'legacy';
          else if (extractionStage?.provider === 'docling') route = 'docling';
        }

        // Enqueue extraction job
        try {
          if (route === 'json-chunking') {
            // ── Auto-extend field config: detect new fields in the uploaded JSON ──
            // Parse the file to extract field paths from the first few records,
            // compare against saved jsonFieldConfig, and auto-extend if new fields found.
            let existingConfig = (index as any).jsonFieldConfig;
            try {
              let parsedData: any;
              try {
                parsedData = JSON.parse(fileBuffer.toString('utf-8'));
              } catch {
                parsedData = null;
              }
              if (parsedData) {
                // Extract records array (same logic as chunking worker)
                let sampleRecords: Record<string, any>[] = [];
                if (Array.isArray(parsedData)) {
                  sampleRecords = parsedData.slice(0, 5);
                } else if (parsedData.data && Array.isArray(parsedData.data)) {
                  sampleRecords = parsedData.data.slice(0, 5);
                } else if (parsedData.records && Array.isArray(parsedData.records)) {
                  sampleRecords = parsedData.records.slice(0, 5);
                } else if (typeof parsedData === 'object') {
                  sampleRecords = [parsedData];
                }

                if (sampleRecords.length > 0) {
                  // Collect all unique field paths from sample records
                  const detectedFields = new Set<string>();
                  const collectFields = (obj: any, prefix = '') => {
                    for (const [key, val] of Object.entries(obj)) {
                      const path = prefix ? `${prefix}.${key}` : key;
                      if (val && typeof val === 'object' && !Array.isArray(val)) {
                        collectFields(val, path);
                      } else {
                        detectedFields.add(path);
                      }
                    }
                  };
                  for (const rec of sampleRecords) {
                    collectFields(rec);
                  }

                  // Compare against existing config
                  const existingPaths = new Set(
                    (existingConfig?.fields || []).map((f: any) => f.fieldPath),
                  );
                  const newFields = [...detectedFields].filter((fp) => !existingPaths.has(fp));

                  if (!existingConfig || existingConfig.fields.length === 0) {
                    // No config at all — run full autoSave via schema-preview logic
                    logger.info('No jsonFieldConfig — auto-configuring fields from uploaded JSON', {
                      indexId,
                      detectedFieldCount: detectedFields.size,
                    });
                    const { saveFieldConfigFromUpload } =
                      await import('./json-field-config-auto.js');
                    existingConfig = await saveFieldConfigFromUpload(
                      indexId,
                      tenantId,
                      sampleRecords,
                      req.tenantContext!,
                    );
                    // Re-read index to get updated config
                    if (existingConfig) {
                      (index as any).jsonFieldConfig = existingConfig;
                    }
                  } else if (newFields.length > 0) {
                    // Existing config but new fields detected — extend it
                    logger.info('New fields detected in upload — extending jsonFieldConfig', {
                      indexId,
                      newFields,
                      existingFieldCount: existingConfig.fields.length,
                    });
                    const { extendFieldConfig } = await import('./json-field-config-auto.js');
                    existingConfig = await extendFieldConfig(
                      indexId,
                      tenantId,
                      newFields,
                      sampleRecords,
                      existingConfig,
                      req.tenantContext!,
                    );
                    if (existingConfig) {
                      (index as any).jsonFieldConfig = existingConfig;
                    }
                  }
                }
              }
            } catch (autoExtendErr) {
              logger.warn('Auto-extend field config failed (non-fatal, using existing config)', {
                error:
                  autoExtendErr instanceof Error ? autoExtendErr.message : String(autoExtendErr),
              });
            }
            let resolvedMappings: any[] | undefined;
            if (existingConfig?.fields?.length) {
              resolvedMappings = existingConfig.fields
                .filter(
                  (f: { selected: boolean; canonicalMapping?: string }) =>
                    f.selected && f.canonicalMapping,
                )
                .map(
                  (f: {
                    fieldPath: string;
                    fieldType: string;
                    canonicalMapping: string;
                    sampleValues?: string[];
                  }) => {
                    const alias = f.fieldPath
                      .replace(/([a-z])([A-Z])/g, '$1 $2')
                      .split(/[._-]/)
                      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
                      .join(' ');
                    const synonyms: string[] = [];
                    if (f.fieldPath !== alias) synonyms.push(f.fieldPath);
                    if (
                      f.canonicalMapping !== f.fieldPath &&
                      f.canonicalMapping !== alias.toLowerCase()
                    ) {
                      synonyms.push(f.canonicalMapping);
                    }
                    return {
                      sourceField: f.fieldPath,
                      canonicalField: f.canonicalMapping,
                      type:
                        f.fieldType === 'number'
                          ? 'number'
                          : f.fieldType === 'date'
                            ? 'date'
                            : 'keyword',
                      filterable: true,
                      sortable: f.fieldType === 'number' || f.fieldType === 'date',
                      aggregatable: f.fieldType === 'number',
                      alias,
                      synonyms,
                      description: `${f.fieldPath} → ${f.canonicalMapping}`,
                      sampleValues: f.sampleValues || [],
                    };
                  },
                );
            }

            const QUEUE_JSON_RECORD_CHUNKING = 'json-record-chunking';
            const jsonQueue = createQueue(QUEUE_JSON_RECORD_CHUNKING);
            try {
              await jsonQueue.add(`json-chunk:${documentId}`, {
                indexId,
                documentId,
                sourceUrl: fileUrl,
                tenantId,
                resolvedMappings:
                  resolvedMappings && resolvedMappings.length > 0 ? resolvedMappings : undefined,
              });
            } finally {
              await jsonQueue.close();
            }
          } else if (route === 'structured') {
            const QUEUE_STRUCTURED_INGESTION = 'structured-data-ingestion';
            const structuredQueue = createQueue(QUEUE_STRUCTURED_INGESTION);
            try {
              await structuredQueue.add(`structured-ingest:${documentId}`, {
                tenantId,
                indexId,
                documentId,
                fileBuffer,
                originalFilename,
                mimeType: contentType,
                fileSize,
                metadata: userMetadata,
                createdAt: new Date(),
              });
            } finally {
              await structuredQueue.close();
            }
          } else {
            const queueName = route === 'docling' ? QUEUE_DOCLING_EXTRACTION : QUEUE_EXTRACTION;
            const extractionQueue = createQueue(queueName);
            try {
              const extractionJobData: DoclingExtractionJobData & Record<string, unknown> = {
                indexId,
                documentId,
                sourceUrl: fileUrl,
                tenantId,
                pipelineStage: extractionStage,
              };
              if (chunkingStage) extractionJobData._chunkingStage = chunkingStage;
              if (enrichmentStage) extractionJobData._enrichmentStage = enrichmentStage;
              if (embeddingStage) extractionJobData._embeddingStage = embeddingStage;

              await extractionQueue.add(`${route}-extract:${documentId}`, extractionJobData);
            } finally {
              await extractionQueue.close();
            }
          }

          logger.info('Document queued for processing', {
            documentId,
            route,
            contentType,
            tenantId,
          });
        } catch (queueError) {
          // Cleanup orphaned document on queue failure
          logger.error('Failed to enqueue extraction job — cleaning up', {
            documentId,
            error: queueError instanceof Error ? queueError.message : String(queueError),
          });
          await Promise.allSettled([
            SearchDocument.deleteOne({ _id: document._id, tenantId }),
            SearchIndex.findOneAndUpdate(
              applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
              { $inc: { documentCount: -1 } },
            ),
            KnowledgeBase.findOneAndUpdate(
              { searchIndexId: indexId, tenantId },
              { $inc: { documentCount: -1 } },
            ),
            SearchSource.findOneAndUpdate(
              { _id: sourceId, tenantId },
              { $inc: { documentCount: -1 } },
            ),
          ]);
          throw queueError;
        }

        res.status(201).json({
          success: true,
          data: {
            documentId,
            status: DocumentStatus.PENDING,
            statusUrl: `/api/indexes/${indexId}/documents/${documentId}`,
            streamUrl: `/api/indexes/${indexId}/documents/${documentId}/stream`,
            metadata: sourceMetadata,
            permissions: permissions ?? { publicEverywhere: true },
            webhookConfigured: !!webhookUrl,
          },
        });
      }); // end withTenantContext
    } catch (error) {
      if (req.file?.path) {
        try {
          const fsPromises = await import('fs/promises');
          await fsPromises.unlink(req.file.path);
        } catch (cleanupErr) {
          logger.warn('Failed to cleanup temp file on error', {
            path: req.file.path,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }

      logger.error('Ingestion failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        indexId: req.params.indexId,
        tenantId: req.tenantContext?.tenantId,
      });

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Ingestion failed' },
        });
      }
    }
  },
);

// =============================================================================
// GET /:indexId/documents/:documentId/stream — SSE Progress Stream
// =============================================================================

router.get('/:indexId/documents/:documentId/stream', async (req: Request, res: Response) => {
  if (!req.tenantContext) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return;
  }

  const { indexId, documentId } = req.params;
  const tenantId = req.tenantContext.tenantId;

  const document = await SearchDocument.findOne({ _id: documentId, indexId, tenantId }).lean();
  if (!document) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Document not found' },
    });
    return;
  }

  // If already terminal, send final event and close
  if (document.status === 'indexed' || document.status === 'error') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const finalEvent = {
      status: document.status,
      progress: computeProgress(document),
      pageCount: document.pageCount ?? 0,
      chunkCount: document.chunkCount ?? 0,
    };
    res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
    res.end();
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial status
  const initialEvent = {
    status: document.status,
    progress: computeProgress(document),
    pageCount: document.pageCount ?? 0,
    chunkCount: document.chunkCount ?? 0,
  };
  res.write(`data: ${JSON.stringify(initialEvent)}\n\n`);

  let subscriber: any = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pollInterval) clearInterval(pollInterval);
    if (subscriber) {
      subscriber.unsubscribe(`progress:${documentId}`).catch((err: unknown) => {
        logger.debug('Error unsubscribing from progress channel', {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      subscriber.quit().catch((err: unknown) => {
        logger.debug('Error closing subscriber', {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };

  // Poll database as fallback (every 5s)
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  pollInterval = setInterval(async () => {
    if (closed) return;
    try {
      const doc = await SearchDocument.findOne(
        { _id: documentId, indexId, tenantId },
        { status: 1, pageCount: 1, chunkCount: 1 },
      ).lean();

      if (!doc) {
        res.write(
          `data: ${JSON.stringify({ status: 'not_found', error: 'Document removed' })}\n\n`,
        );
        cleanup();
        res.end();
        return;
      }

      const event = {
        status: doc.status,
        progress: computeProgress(doc),
        pageCount: doc.pageCount ?? 0,
        chunkCount: doc.chunkCount ?? 0,
      };
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      if (doc.status === 'indexed' || doc.status === 'error') {
        cleanup();
        res.end();
      }
    } catch (pollErr) {
      logger.warn('SSE poll error', {
        documentId,
        error: pollErr instanceof Error ? pollErr.message : String(pollErr),
      });
    }
  }, 5000);

  // Try Redis pub/sub for real-time events
  try {
    const { getSharedRedisHandle } = await import('../workers/shared.js');
    const handle = getSharedRedisHandle();

    if (handle) {
      subscriber = handle.duplicate();
      await subscriber.subscribe(`progress:${documentId}`);

      subscriber.on('message', (_channel: string, message: string) => {
        if (closed) return;
        try {
          const progressEvent = JSON.parse(message);
          const sseData = {
            type: progressEvent.type,
            status:
              progressEvent.type === 'job_completed'
                ? 'indexed'
                : progressEvent.type === 'job_failed'
                  ? 'error'
                  : undefined,
            progress: progressEvent.data?.progress,
            timestamp: progressEvent.timestamp,
          };
          res.write(`data: ${JSON.stringify(sseData)}\n\n`);

          if (progressEvent.type === 'job_completed' || progressEvent.type === 'job_failed') {
            cleanup();
            res.end();
          }
        } catch (parseErr) {
          logger.debug('Failed to parse progress event', {
            documentId,
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
        }
      });
    }
  } catch (redisErr) {
    logger.warn('Redis subscription failed — relying on polling fallback', {
      documentId,
      error: redisErr instanceof Error ? redisErr.message : String(redisErr),
    });
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
});

export default router;
