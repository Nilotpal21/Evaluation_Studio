/**
 * JSON Record Chunking Worker
 *
 * Treats each JSON record as an individual chunk (unstructured approach).
 * Best for:
 * - JSON with rich text content
 * - Small to medium datasets (< 100K records)
 * - Semantic search use cases
 * - Variable schemas (many unique fields)
 *
 * Flow: Parse JSON → Create chunk per record → Embed → Index
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_EMBEDDING, ChunkStatus } from '@agent-platform/search-ai-sdk';
import { withTenantContext } from '@agent-platform/database/mongo';
import type { Model } from 'mongoose';
import { getDualConnection, getLazyModel } from '../db/index.js';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';
import type { EmbeddingJobData } from './shared.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { countTokens } from '@agent-platform/search-ai-internal/tokenizer';
import { resolveEnhancedIndexLLMConfig } from '../services/llm-config/resolver.js';
import {
  analyzeJsonSchemaWithLlm,
  buildCanonicalMetadataFromMapping,
  type FieldMapping,
  type JsonSchemaMappingResult,
} from '../services/json-schema-mapping/json-schema-llm-mapper.js';
import type {
  ICanonicalSchema,
  IDomainVocabulary,
  IVocabularyEntry,
} from '@agent-platform/database';
import { uuidv7 } from '@agent-platform/database/mongo';
// Note: DOCUMENT_UPLOAD_VOCABULARY is NOT imported here — JSON record KBs
// only get vocabulary entries derived from the user's selected fields, not
// document-level defaults (author, page_count, etc.) meant for PDF/DOCX.

function getModels() {
  const dualConn = getDualConnection();
  const platformConn = dualConn.getPlatformConnection();
  const contentConn = dualConn.getContentConnection();

  return {
    SearchIndex: platformConn.models.SearchIndex as Model<any>,
    SearchDocument: contentConn.models.SearchDocument as Model<any>,
    SearchChunk: contentConn.models.SearchChunk as Model<any>,
  };
}

// =============================================================================
// CONSTANTS
// =============================================================================

const QUEUE_NAME = 'json-record-chunking';
const MAX_CHUNK_TOKENS = 8000; // BGE-M3 supports 8192 tokens max

// =============================================================================
// TYPES
// =============================================================================

interface JSONChunkingJobData {
  indexId: string;
  documentId: string;
  sourceUrl: string;
  tenantId: string;
  /**
   * Pre-resolved field mappings from the save endpoint.
   * When present, the worker uses these directly — NO additional LLM call.
   * This carries the user's mapping overrides from the JSON Field Selection dialog.
   */
  resolvedMappings?: FieldMapping[];
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert JSON record to readable text for embedding.
 *
 * When selectedFields is provided, ONLY those fields are included in the
 * embedding text. Number/date/boolean fields are skipped for embedding
 * (they don't embed well semantically) but still stored in canonicalMetadata.
 *
 * When selectedFields is null/undefined, ALL fields are included (legacy behavior).
 */
function recordToText(
  record: Record<string, any>,
  options: { maxDepth?: number; selectedFields?: Set<string> | null } = {},
): string {
  const maxDepth = options.maxDepth ?? 3;
  const selectedFields = options.selectedFields ?? null;
  const lines: string[] = [];

  function processValue(key: string, value: any, depth: number, prefix: string = ''): void {
    if (depth > maxDepth) return;

    const fullKey = prefix ? `${prefix}.${key}` : key;

    // For objects and arrays-of-objects, always recurse — a child like
    // "address.city" may be selected even when "address" itself isn't.
    // The leaf-level check below handles actual inclusion/exclusion.
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.entries(value).forEach(([k, v]) => {
        processValue(k, v, depth + 1, fullKey);
      });
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        if (!selectedFields || selectedFields.has(fullKey) || selectedFields.has(key)) {
          lines.push(`${fullKey}: []`);
        }
      } else if (typeof value[0] === 'object' && value[0] !== null) {
        // Array of objects — recurse into each item
        value.forEach((item, idx) => {
          if (typeof item === 'object') {
            Object.entries(item).forEach(([k, v]) => {
              processValue(k, v, depth + 1, `${fullKey}[${idx}]`);
            });
          }
        });
      } else {
        // Array of primitives — apply field filter at this level
        if (!selectedFields || selectedFields.has(fullKey) || selectedFields.has(key)) {
          lines.push(`${fullKey}: ${value.join(', ')}`);
        }
      }
      return;
    }

    // Leaf value — apply field selection filter
    if (selectedFields && !selectedFields.has(fullKey) && !selectedFields.has(key)) {
      return;
    }

    if (value === null || value === undefined) {
      lines.push(`${fullKey}: [empty]`);
    } else if (typeof value === 'string') {
      lines.push(`${fullKey}: ${value}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${fullKey}: ${value}`);
    } else {
      lines.push(`${fullKey}: ${String(value)}`);
    }
  }

  Object.entries(record).forEach(([key, value]) => {
    processValue(key, value, 0);
  });

  return lines.join('\n');
}

/**
 * Convert a record to per-field text lines (key: value pairs).
 * Same logic as recordToText but returns individual lines instead of joined string.
 */
function recordToFieldLines(
  record: Record<string, any>,
  options: { selectedFields?: Set<string> | null } = {},
): Array<{ key: string; text: string }> {
  const selectedFields = options.selectedFields ?? null;
  const result: Array<{ key: string; text: string }> = [];

  for (const [key, value] of Object.entries(record)) {
    if (selectedFields && !selectedFields.has(key)) continue;
    if (value === null || value === undefined) continue;

    const text =
      typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);

    result.push({ key, text: `${key}: ${text}` });
  }

  return result;
}

/**
 * Split record into chunks when total tokens exceed MAX_CHUNK_TOKENS.
 *
 * All decisions are tokenizer-based — no character or letter counting.
 *
 * Strategy:
 * 1. Find the largest field by token count
 * 2. Split its value at word boundaries (never mid-word)
 * 3. Every chunk gets ALL small fields + one slice of the large field
 * 4. ~50 token overlap between adjacent chunks for semantic continuity
 *
 * Example: { productname: "Shirt", price: "1050", content: "...large text..." }
 * → Chunk 1: productname + price + content[words 0..N]
 * → Chunk 2: productname + price + content[words N-overlap..M]
 * → Chunk 3: productname + price + content[words M-overlap..end]
 */
const OVERLAP_TOKENS = 50;

function splitRecordIntoChunks(fieldLines: Array<{ key: string; text: string }>): string[] {
  const fullContent = fieldLines.map((f) => f.text).join('\n');

  if (countTokens(fullContent) <= MAX_CHUNK_TOKENS) {
    return [fullContent];
  }

  // Find the largest field by TOKEN count (not characters)
  let largestIdx = 0;
  let largestTokens = 0;
  for (let i = 0; i < fieldLines.length; i++) {
    const tokens = countTokens(fieldLines[i].text);
    if (tokens > largestTokens) {
      largestTokens = tokens;
      largestIdx = i;
    }
  }

  // Context = all fields except the largest (repeated in every chunk)
  const contextLines = fieldLines.filter((_, i) => i !== largestIdx);
  const contextText = contextLines.map((f) => f.text).join('\n');
  const contextTokens = countTokens(contextText);

  const largeField = fieldLines[largestIdx];
  const keyPrefix = `${largeField.key}: `;
  const prefixTokens = countTokens(keyPrefix);
  const largeValue = largeField.text.slice(keyPrefix.length);

  // Tokens available for the large field value per chunk
  const tokensForValue = Math.max(MAX_CHUNK_TOKENS - contextTokens - prefixTokens - 1, 500);

  // Split the large value by WORDS (never break mid-word)
  const words = largeValue.split(/(\s+)/);
  const chunks: string[] = [];
  let wordIdx = 0;

  while (wordIdx < words.length) {
    let accumulated = '';
    const startWordIdx = wordIdx;

    // Accumulate words until we hit the token budget
    while (wordIdx < words.length) {
      const candidate = accumulated + words[wordIdx];
      if (accumulated.length > 0 && countTokens(candidate) > tokensForValue) {
        break;
      }
      accumulated += words[wordIdx];
      wordIdx++;
    }

    chunks.push(contextText + '\n' + keyPrefix + accumulated.trim());

    // Overlap: step back ~50 tokens worth of words for semantic continuity
    if (wordIdx < words.length) {
      let overlapTokens = 0;
      let stepBack = 0;
      for (let k = wordIdx - 1; k > startWordIdx; k--) {
        overlapTokens += countTokens(words[k]);
        stepBack++;
        if (overlapTokens >= OVERLAP_TOKENS) break;
      }
      wordIdx = Math.max(wordIdx - stepBack, startWordIdx + 1);
    }
  }

  return chunks;
}

/**
 * Extract ID field from record (if exists)
 */
function extractRecordId(record: Record<string, any>): string | null {
  // Look for common ID field patterns
  const idPatterns = ['id', '_id', 'ID', 'Id', 'uuid', 'guid'];

  for (const pattern of idPatterns) {
    if (pattern in record && record[pattern]) {
      return String(record[pattern]);
    }
  }

  // Look for fields ending with _id
  for (const key of Object.keys(record)) {
    if (key.endsWith('_id') || key.endsWith('Id')) {
      return String(record[key]);
    }
  }

  return null;
}

/**
 * Generate chunk preview (first 200 chars)
 */
function generatePreview(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Build a deterministic document summary from JSON records.
 *
 * The KG enrichment worker requires metadata.documentSummary to be present
 * on the SearchDocument — it filters by `{ 'metadata.documentSummary': { $ne: null } }`.
 * The classifier uses this summary to determine the product scope (e.g.,
 * "Clothing > Shirts", "Electronics > Phones") for entity extraction.
 *
 * For JSON documents we synthesise a summary from the structure and sample
 * values — no LLM call needed. The classifier only needs enough context to
 * classify the *domain*, not a literary summary.
 */
function buildJsonDocumentSummary(
  records: Record<string, unknown>[],
  fieldMappings: FieldMapping[],
  document: Record<string, unknown>,
): string {
  const parts: string[] = [];

  // Title / source file reference
  const title = (document.title || document.originalReference || 'Untitled JSON file') as string;
  parts.push(`JSON dataset: ${title}`);
  parts.push(`Contains ${records.length} record${records.length === 1 ? '' : 's'}.`);

  // Field overview
  if (records.length > 0) {
    const fieldNames = Object.keys(records[0]);
    parts.push(
      `Fields: ${fieldNames.slice(0, 15).join(', ')}${fieldNames.length > 15 ? ` (and ${fieldNames.length - 15} more)` : ''}.`,
    );
  }

  // Mapped field aliases (tells the classifier what domain this data belongs to)
  if (fieldMappings.length > 0) {
    const aliases = fieldMappings
      .filter((m) => m.alias)
      .map((m) => m.alias)
      .slice(0, 10);
    if (aliases.length > 0) {
      parts.push(`Key attributes: ${aliases.join(', ')}.`);
    }
  }

  // Sample values from first record to hint at domain (e.g., "Nike", "Clothing", "$49.99")
  if (records.length > 0) {
    const sample = records[0];
    const sampleParts: string[] = [];
    const keyFields = ['title', 'name', 'category', 'type', 'brand', 'department', 'description'];
    for (const key of keyFields) {
      // Check case-insensitive
      const match = Object.keys(sample).find((k) => k.toLowerCase() === key);
      if (match && sample[match] != null) {
        const val = String(sample[match]);
        sampleParts.push(`${match}: ${val.length > 80 ? val.slice(0, 80) + '...' : val}`);
      }
    }
    if (sampleParts.length > 0) {
      parts.push(`Sample record: ${sampleParts.join('; ')}.`);
    }
  }

  return parts.join(' ');
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

async function processJSONRecordChunking(job: Job<JSONChunkingJobData>): Promise<void> {
  const { indexId, documentId, sourceUrl, tenantId } = job.data;
  const { SearchIndex, SearchDocument, SearchChunk } = getModels();

  workerLog('json-record-chunking', `Processing JSON file for document ${documentId}`, {
    indexId,
    tenantId,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      // ── 1. Verify index exists ──────────────────────────────────────────
      const index = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
      if (!index) {
        throw new Error(`Index ${indexId} not found for tenant ${tenantId}`);
      }

      // ── 2. Verify document exists ──────────────────────────────────────
      const document = await SearchDocument.findOne({ _id: documentId, tenantId }).lean();
      if (!document) {
        throw new Error(`Document ${documentId} not found`);
      }

      await job.updateProgress(10);

      // ── 3. Read and parse JSON file ────────────────────────────────────
      workerLog('json-record-chunking', `Reading JSON file from ${sourceUrl}`, { documentId });

      const { readFileFromStorage } = await import('../storage/storage-factory.js');
      const fileBuffer = await readFileFromStorage(sourceUrl);
      const jsonText = fileBuffer.toString('utf-8');

      let data: any;
      try {
        data = JSON.parse(jsonText);
      } catch (error) {
        throw new Error(
          `Invalid JSON format: ${error instanceof Error ? error.message : 'Parse error'}`,
        );
      }

      await job.updateProgress(20);

      // ── 4. Extract records array ────────────────────────────────────────
      // Support: array directly, {data: []}, {records: []}, or single object
      let records: Record<string, any>[];

      if (Array.isArray(data)) {
        records = data;
      } else if (data.data && Array.isArray(data.data)) {
        records = data.data;
      } else if (data.records && Array.isArray(data.records)) {
        records = data.records;
      } else if (typeof data === 'object' && data !== null) {
        // Single object - wrap in array
        records = [data];
        workerLog('json-record-chunking', 'Detected single JSON object, wrapping in array', {
          documentId,
        });
      } else {
        throw new Error(
          'JSON must be an array, contain "data" or "records" field with array, or be a single object',
        );
      }

      if (records.length === 0) {
        throw new Error('JSON file contains no records');
      }

      workerLog('json-record-chunking', `Found ${records.length} records in JSON`, { documentId });

      await job.updateProgress(20);

      // ── 4a. Read user's field selection config ────────────────────────
      // If the user selected fields via the JSON Field Selection dialog,
      // use ONLY those fields for embedding text. Otherwise fall back to
      // LLM-based schema analysis (legacy path).
      const fieldConfig = (index as any).jsonFieldConfig as {
        fields: Array<{ fieldPath: string; fieldType: string; selected: boolean }>;
      } | null;

      const selectedFields: Set<string> | null = fieldConfig?.fields?.length
        ? new Set(fieldConfig.fields.filter((f) => f.selected).map((f) => f.fieldPath))
        : null;

      // Build a set of fields suitable for vocabulary/filtering (short strings,
      // numbers, booleans, dates, arrays). Long text fields are for embedding
      // only — they don't make sense as filterable vocabulary entries.
      const vocabEligibleFields: Set<string> | null = fieldConfig?.fields?.length
        ? new Set(
            fieldConfig.fields
              .filter((f) => {
                if (!f.selected) return false;
                // Long text strings (fieldType 'string' with long samples) are
                // already excluded by the schema extractor which sets fieldType.
                // But the user might still select them. Include only types that
                // make sense for vocabulary: number, boolean, date, array, and
                // short strings. We distinguish by checking sample value lengths.
                if (
                  f.fieldType === 'number' ||
                  f.fieldType === 'boolean' ||
                  f.fieldType === 'date'
                ) {
                  return true;
                }
                if (f.fieldType === 'array') return true;
                if (f.fieldType === 'string') {
                  // Use maxLength (un-truncated) for reliable long text detection.
                  // Sample values are truncated to ~80 chars by the preview API,
                  // making avgLen unreliable. Threshold 200 matches the frontend.
                  const maxLength = (f as any).maxLength ?? 0;
                  if (maxLength > 200) return false;
                  // Fallback for old configs without maxLength: check sample values
                  if (maxLength === 0) {
                    const sampleValues = (f as any).sampleValues as string[] | undefined;
                    if (!sampleValues || sampleValues.length === 0) return true;
                    const avgLen =
                      sampleValues.reduce((sum, v) => sum + v.length, 0) / sampleValues.length;
                    return avgLen <= 100;
                  }
                  return true;
                }
                return false;
              })
              .map((f) => f.fieldPath),
          )
        : null;

      if (selectedFields) {
        workerLog('json-record-chunking', `Using user field config`, {
          documentId,
          selectedCount: selectedFields.size,
          totalFields: fieldConfig!.fields.length,
        });
      }

      // ── 4b. Resolve field mappings ─────────────────────────────────────
      // Priority 1: Pre-resolved mappings from the save endpoint (user's
      //             confirmed/overridden selections — no extra LLM call).
      // Priority 2: LLM-based schema analysis (legacy path / no config).
      //
      // `allFieldMappings` = full set for canonical metadata on chunks.
      // `fieldMappings`    = vocab-eligible subset for schema + vocabulary.
      let allFieldMappings: FieldMapping[] = [];
      let fieldMappings: FieldMapping[] = [];
      let schemaMappingResult: JsonSchemaMappingResult | null = null;

      if (job.data.resolvedMappings && job.data.resolvedMappings.length > 0) {
        // ── Pre-resolved from save endpoint — zero LLM calls ────────────
        allFieldMappings = job.data.resolvedMappings;
        fieldMappings = vocabEligibleFields
          ? allFieldMappings.filter((m) => vocabEligibleFields.has(m.sourceField))
          : allFieldMappings;

        workerLog('json-record-chunking', `Using pre-resolved mappings from save endpoint`, {
          documentId,
          totalMappings: allFieldMappings.length,
          vocabEligible: fieldMappings.length,
        });

        if (fieldMappings.length > 0) {
          await persistCanonicalSchema(tenantId, indexId, fieldMappings);
          workerLog('json-record-chunking', `Persisted canonical schema`, {
            documentId,
            fieldCount: fieldMappings.length,
          });

          await persistDirectVocabulary(tenantId, indexId, fieldMappings);
          workerLog('json-record-chunking', `Persisted direct vocabulary`, {
            documentId,
            entryCount: fieldMappings.length,
          });
        }
      } else {
        // ── Fallback: LLM-based schema analysis ─────────────────────────
        try {
          const llmConfig = await resolveEnhancedIndexLLMConfig(tenantId, indexId);
          const schemaAnalysisConfig =
            llmConfig.useCases.questionSynthesis ??
            llmConfig.useCases.progressiveSummarization ??
            llmConfig.useCases.scopeClassification;

          if (
            schemaAnalysisConfig?.enabled &&
            schemaAnalysisConfig.provider &&
            schemaAnalysisConfig.apiKey &&
            schemaAnalysisConfig.model
          ) {
            const llmClient = new WorkerLLMClient(
              schemaAnalysisConfig.provider,
              schemaAnalysisConfig.apiKey,
              schemaAnalysisConfig.model.modelId,
            );

            const sampleRecords = records.slice(0, 5);
            schemaMappingResult = await analyzeJsonSchemaWithLlm(sampleRecords, llmClient);
            allFieldMappings = schemaMappingResult.mappings;
            fieldMappings = vocabEligibleFields
              ? allFieldMappings.filter((m) => vocabEligibleFields.has(m.sourceField))
              : allFieldMappings;

            workerLog('json-record-chunking', `LLM schema analysis complete`, {
              documentId,
              totalMappings: allFieldMappings.length,
              vocabEligible: fieldMappings.length,
              skippedFields: schemaMappingResult.skippedFields.length,
              generatedByLlm: schemaMappingResult.generatedByLlm,
            });

            if (fieldMappings.length > 0) {
              await persistCanonicalSchema(tenantId, indexId, fieldMappings);
              workerLog('json-record-chunking', `Persisted canonical schema`, {
                documentId,
                fieldCount: fieldMappings.length,
              });

              await persistDirectVocabulary(tenantId, indexId, fieldMappings);
              workerLog('json-record-chunking', `Persisted direct vocabulary`, {
                documentId,
                entryCount: fieldMappings.length,
              });
            }
          } else {
            workerLog('json-record-chunking', `No LLM config available, skipping schema analysis`, {
              documentId,
            });
          }
        } catch (error) {
          workerError(
            'json-record-chunking',
            `Schema analysis failed, continuing without mapping`,
            error,
          );
        }
      }

      await job.updateProgress(30);

      // ── 5. Create chunks (one per record) ──────────────────────────────
      const chunks: any[] = [];
      const batchSize = 100;
      let processedCount = 0;

      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const batchChunks = [];

        for (let j = 0; j < batch.length; j++) {
          const record = batch[j];
          const chunkIndex = i + j;

          // Convert record to per-field text lines
          const fieldLines = recordToFieldLines(record, { selectedFields });
          const recordId = extractRecordId(record);

          // Build canonical metadata (same for all chunks of this record)
          const mappedMetadata =
            allFieldMappings.length > 0
              ? buildCanonicalMetadataFromMapping(record, allFieldMappings)
              : {};
          const canonicalMetadata: Record<string, unknown> = {
            source_type: 'json',
            mime_type: 'application/json',
            // source_url: use external download URL for citations (never expose internal storage paths)
            ...((document as any).downloadUrl ? { source_url: (document as any).downloadUrl } : {}),
            title: (document as any).name || (document as any).originalReference || undefined,
            ...mappedMetadata,
          };

          // Split large records into multiple chunks:
          // - Keep all short fields in every chunk (context)
          // - Split the largest field across chunks
          const contentChunks = splitRecordIntoChunks(fieldLines);

          for (let ci = 0; ci < contentChunks.length; ci++) {
            const finalContent = contentChunks[ci];
            const actualChunkIndex = chunkIndex * 100 + ci;
            const preview = generatePreview(finalContent);

            const chunk = await SearchChunk.create({
              tenantId,
              indexId,
              documentId,
              sourceId: (document as any).sourceId,
              chunkIndex: actualChunkIndex,
              chunkType: 'json_record',
              content: finalContent,
              tokenCount: countTokens(finalContent),
              contentPreview: preview,
              status: ChunkStatus.PENDING,
              canonicalMetadata,
              metadata: {
                recordIndex: chunkIndex,
                recordId: recordId,
                originalRecord: ci === 0 ? record : undefined,
                fieldCount: Object.keys(record).length,
                chunkPart: contentChunks.length > 1 ? ci + 1 : undefined,
                chunkPartsTotal: contentChunks.length > 1 ? contentChunks.length : undefined,
                contentLength: finalContent.length,
                isMultiPart: contentChunks.length > 1,
              },
            });

            batchChunks.push(chunk);
          }
        }

        chunks.push(...batchChunks);
        processedCount += batch.length;

        // Update progress
        const progress = 30 + Math.floor((processedCount / records.length) * 50);
        await job.updateProgress(progress);

        workerLog('json-record-chunking', `Created ${processedCount}/${records.length} chunks`, {
          documentId,
          batchNumber: Math.floor(i / batchSize) + 1,
        });
      }

      await job.updateProgress(80);

      // ── 6. Update document status + generate document summary ─────────
      // KG enrichment filters documents by metadata.documentSummary != null.
      // Without a summary, JSON documents are silently skipped by the KG
      // worker and the Knowledge Graph tab shows "0 docs" for all entities.
      // We build a deterministic summary from the JSON structure (no LLM cost).
      const documentSummary = buildJsonDocumentSummary(
        records,
        allFieldMappings,
        document as unknown as Record<string, unknown>,
      );
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          $set: {
            status: 'extracted',
            chunkCount: chunks.length,
            pageCount: 0, // JSON doesn't have pages
            'metadata.documentSummary': documentSummary,
          },
        },
      );

      workerLog('json-record-chunking', `Document updated: ${chunks.length} chunks created`, {
        documentId,
      });

      await job.updateProgress(85);

      // ── 7. Enqueue embedding job ───────────────────────────────────────
      const embeddingQueue = createQueue(QUEUE_EMBEDDING);
      try {
        const embeddingJobData: EmbeddingJobData = {
          indexId,
          documentId,
          chunkIds: chunks.map((c) => String(c._id)),
          tenantId,
        };

        await embeddingQueue.add(`embed-json-${documentId}`, embeddingJobData, {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        });

        workerLog('json-record-chunking', `Embedding job enqueued for ${chunks.length} chunks`, {
          documentId,
        });
      } finally {
        await embeddingQueue.close();
      }

      await job.updateProgress(90);

      // ── 8. Enqueue KG enrichment job ────────────────────────────────
      // The kg-enrichment worker runs document-level classification and
      // entity extraction using the taxonomy. For JSON chunks it uses the
      // structured path (extractFromStructuredRecord) which reads field
      // values directly from metadata.originalRecord instead of regex/LLM.
      // Without this step, the Knowledge Graph tab shows "0 docs" everywhere.
      try {
        const kgQueue = createQueue('kg-enrichment');
        try {
          await kgQueue.add(
            `kg-enrich-json:${indexId}:${documentId}`,
            {
              indexId,
              tenantId,
              filter: { status: ['NOT_ENRICHED'] },
              options: { batchSize: 50 },
            },
            {
              jobId: `kg-json-${indexId}-${documentId}-${Date.now()}`,
              attempts: 2,
              backoff: { type: 'exponential', delay: 10_000 },
            },
          );
          workerLog('json-record-chunking', `KG enrichment job enqueued`, {
            documentId,
            indexId,
          });
        } finally {
          await kgQueue.close();
        }
      } catch (kgErr) {
        // Non-fatal — KG enrichment is best-effort, document is still indexed
        workerLog(
          'json-record-chunking',
          `KG enrichment enqueue failed (non-fatal): ${kgErr instanceof Error ? kgErr.message : String(kgErr)}`,
          { documentId },
        );
      }

      await job.updateProgress(100);

      workerLog('json-record-chunking', `JSON record chunking complete`, {
        documentId,
        recordCount: records.length,
        chunkCount: chunks.length,
      });
    } catch (error) {
      workerError('json-record-chunking', `JSON chunking failed for document ${documentId}`, error);

      // Mark document as error
      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          $set: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        },
      );

      throw error; // Re-throw to mark job as failed
    }
  });
}

// =============================================================================
// PERSISTENCE HELPERS
// =============================================================================

/**
 * Create or update CanonicalSchema in MongoDB with the LLM-derived field mappings.
 * This enables the DynamicVocabularyResolver to inject these fields into the LLM
 * prompt at query time.
 */
async function persistCanonicalSchema(
  tenantId: string,
  indexId: string,
  mappings: FieldMapping[],
): Promise<void> {
  const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');

  const fields = mappings.map((m) => ({
    name: m.alias,
    label: m.alias.charAt(0).toUpperCase() + m.alias.slice(1),
    type: m.type === 'keyword' ? 'string' : m.type,
    description: m.description,
    storageField: m.canonicalField,
    indexed: true,
    filterable: m.filterable,
    aggregatable: m.aggregatable,
    sortable: m.sortable,
    enumValues: m.sampleValues ? Object.fromEntries(m.sampleValues.map((v) => [v, v])) : undefined,
    sourceConnectorField: m.sourceField,
  }));

  // Upsert: merge new fields with existing ones (other uploads may have added fields).
  // CRITICAL: sort by version:-1 to target the LATEST version. Without this, MongoDB
  // picks the first match (version 1), and $inc tries to create a version that already
  // exists → E11000 duplicate key error on (knowledgeBaseId, version) unique index.
  const existing = await CanonicalSchemaModel.findOne({
    knowledgeBaseId: indexId,
    tenantId,
    status: 'active',
  })
    .sort({ version: -1 })
    .lean();

  if (existing) {
    // Build merged fields array in JS to avoid MongoDB $set/$push conflict.
    // Previously, mixing positional $set (fields.N.xxx) with $push on fields
    // caused "Updating the path 'fields.0.sourceConnectorField' would create
    // a conflict at 'fields'" when new fields were also being appended.
    const existingSlotMap = new Map(
      (existing.fields || []).map((f: any, idx: number) => [f.storageField, idx]),
    );

    // Clone existing fields and update matched slots in-place
    const mergedFields = (existing.fields || []).map((f: any) => ({ ...f }));

    for (const field of fields) {
      const idx = existingSlotMap.get(field.storageField);
      if (idx !== undefined) {
        // Enrich the existing field with JSON source info
        mergedFields[idx] = {
          ...mergedFields[idx],
          sourceConnectorField: field.sourceConnectorField,
          description: field.description,
          filterable: field.filterable,
          aggregatable: field.aggregatable,
          sortable: field.sortable,
          ...(field.enumValues ? { enumValues: field.enumValues } : {}),
        };
      } else {
        // Truly new field — append
        mergedFields.push(field);
      }
    }

    // Update the latest active schema in-place (no version bump to avoid
    // duplicate key collisions when concurrent workers both $inc).
    await CanonicalSchemaModel.findOneAndUpdate(
      { _id: existing._id, tenantId },
      { $set: { status: 'active', fields: mergedFields } },
    );
  } else {
    await CanonicalSchemaModel.create({
      tenantId,
      knowledgeBaseId: indexId,
      version: 1,
      fields,
      status: 'active',
    });
  }
}

/**
 * Create direct 1:1 vocabulary entries for JSON-mapped fields.
 * Each entry maps the JSON field name to its canonical OS field.
 * No aliases or synonyms — keeps the vocabulary clean for JSON uploads.
 * Replaces any previous auto-generated entries to avoid stale mappings.
 */
async function persistDirectVocabulary(
  tenantId: string,
  indexId: string,
  mappings: FieldMapping[],
): Promise<void> {
  const DomainVocabularyModel = getLazyModel<IDomainVocabulary>('DomainVocabulary');

  const newEntries: IVocabularyEntry[] = mappings
    .filter((m) => m.filterable || m.sortable || m.aggregatable)
    .map((m) => ({
      id: uuidv7(),
      term: m.alias || m.sourceField,
      aliases: m.synonyms.length > 0 ? m.synonyms : [],
      description: m.description || `${m.sourceField} → ${m.canonicalField}`,
      fieldRef: m.canonicalField,
      capabilities: {
        canFilter: m.filterable,
        canDisplay: true,
        canAggregate: m.aggregatable,
        canSort: m.sortable,
      },
      relatedFields: {
        displayWith: [],
        aggregateWith: [],
      },
      enabled: true,
      confidence: 1.0,
      generatedBy: 'auto' as const,
    }));

  if (newEntries.length === 0) return;

  // .lean() — return a plain object so Mongoose does NOT track __v for OCC.
  // Without this, concurrent chunking workers from the same upload batch all
  // .save() against the same per-KB doc and stampede each other with VersionError.
  const existing = await DomainVocabularyModel.findOne({
    projectKnowledgeBaseId: indexId,
    tenantId,
  }).lean();

  if (existing) {
    // Keep manual entries AND auto entries from non-JSON sources (e.g., PDF vocab).
    // Only replace auto entries whose fieldRef overlaps with the new JSON mappings.
    // Do NOT add document-level defaults (author, page_count, etc.) — they're
    // irrelevant for JSON record KBs. Only the user's selected fields matter.
    const newFieldRefs = new Set(newEntries.map((e) => e.fieldRef));
    const keptEntries = (existing.entries || []).filter(
      (e: IVocabularyEntry) =>
        e.generatedBy === 'manual' || (e.generatedBy === 'auto' && !newFieldRefs.has(e.fieldRef)),
    );
    const mergedEntries = [...keptEntries, ...newEntries];

    // TEMPORARY: findOneAndUpdate (no .save()) so there's no __v filter to
    // collide on. Within a single upload batch every worker computes identical
    // mergedEntries from the same resolvedMappings, so last-write-wins is safe.
    // Cross-batch / mid-stream-manual-edit races are NOT addressed here — the
    // proper fix (move per-KB persistence out of the per-record worker) is
    // tracked in ABLP-836.
    await DomainVocabularyModel.findOneAndUpdate(
      { _id: existing._id, tenantId },
      { $set: { entries: mergedEntries, status: 'active' } },
    );
  } else {
    // New vocabulary — JSON fields only, no document-level defaults.
    // Document defaults (author, language, page_count, etc.) are for PDF/DOCX
    // uploads and don't apply to JSON record KBs.
    await DomainVocabularyModel.create({
      tenantId,
      projectKnowledgeBaseId: indexId,
      version: 1,
      status: 'active',
      entries: [...newEntries],
    });
  }
}

// =============================================================================
// WORKER INSTANCE
// =============================================================================

export function createJSONRecordChunkingWorker() {
  return new Worker(QUEUE_NAME, processJSONRecordChunking, createWorkerOptions());
}
