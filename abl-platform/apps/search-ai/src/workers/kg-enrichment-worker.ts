/**
 * Knowledge Graph Enrichment Worker
 *
 * Document-level classification and entity extraction worker for Phase 3 KG implementation.
 * Processes entire indexes (not individual documents) in batches.
 *
 * Key Features:
 * - Document-level classification using EXISTING summaries (zero extra cost)
 * - Haiku primary ($0.0002/doc), Sonnet escalation if confidence < 0.8
 * - Scoped entity extraction (only attributes applicable to document's product type)
 * - Hybrid extraction: Regex primary (fast, free), LLM fallback (accurate, costly)
 * - Updates MongoDB, Neo4j, and Vector DB
 *
 * Flow: Replaces old knowledge-graph-worker.ts with taxonomy-driven approach
 *
 * Cost Optimization:
 * - 10x cost reduction: 1 LLM call per document (vs 10 per document for chunk-level)
 * - Reuses existing summaries generated during ingestion (no additional cost)
 * - Regex-first entity extraction (~$0.00001/chunk vs ~$0.0002/chunk for LLM)
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import pLimit from 'p-limit';
import { WorkerLLMClient } from '@agent-platform/llm';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import {
  createVectorStore,
  resolveIndexForWrite,
  type VectorStoreProvider,
} from '@agent-platform/search-ai-internal';
import { getLazyModel } from '../db/index.js';
import type {
  ISearchDocument,
  ISearchChunk,
  ISearchIndex,
  IKnowledgeGraphTaxonomy,
} from '@agent-platform/database/models';

// Models bound to correct databases (platform vs content)
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument'); // → search_ai
const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk'); // → search_ai
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex'); // → abl_platform
const KnowledgeGraphTaxonomy = getLazyModel<IKnowledgeGraphTaxonomy>('KnowledgeGraphTaxonomy'); // → search_ai

import { withTenantContext } from '@agent-platform/database/mongo';
import { getConfig } from '../config/index.js';
import { TaxonomyLoaderService } from '../services/taxonomy-loader.service.js';
import { DocumentClassifierService } from '../services/document-classifier.service.js';
import {
  EntityExtractorService,
  type NovelCandidate,
} from '../services/entity-extractor.service.js';
import { TaxonomyGraphService } from '../services/knowledge-graph/taxonomy-graph.service.js';
import { ClickHouseEntityStore } from '../services/knowledge-graph/clickhouse-entity-store.js';
import { createWorkerOptions, workerLog, workerError } from './shared.js';
import type { KGEnrichmentJobData } from './shared.js';

// =============================================================================
// PROVIDER SINGLETONS (lazy) — only for non-LLM services
// =============================================================================

let _vectorStore: VectorStoreProvider | null = null;

function getVectorStore(): VectorStoreProvider {
  if (!_vectorStore) {
    _vectorStore = createVectorStore({
      provider:
        (process.env.VECTOR_STORE_PROVIDER as 'opensearch' | 'qdrant' | 'pinecone' | 'pgvector') ||
        'opensearch',
      url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
      apiKey: process.env.VECTOR_STORE_API_KEY,
      timeoutMs: process.env.VECTOR_STORE_TIMEOUT_MS
        ? parseInt(process.env.VECTOR_STORE_TIMEOUT_MS, 10)
        : undefined,
    });
  }
  return _vectorStore;
}

let _clickHouseEntityStore: ClickHouseEntityStore | null = null;
function getClickHouseEntityStore(): ClickHouseEntityStore {
  if (!_clickHouseEntityStore) {
    _clickHouseEntityStore = new ClickHouseEntityStore();
  }
  return _clickHouseEntityStore;
}

/**
 * Create LLM-dependent services with a per-index resolved LLM client.
 * This ensures tenant isolation — no shared singletons holding credentials.
 */
function createLLMServices(llmClient: WorkerLLMClient, kgConfig?: Record<string, unknown>) {
  return {
    taxonomyLoader: new TaxonomyLoaderService(llmClient),
    documentClassifier: new DocumentClassifierService(llmClient),
    entityExtractor: new EntityExtractorService(llmClient, {
      maxTokens: typeof kgConfig?.maxTokens === 'number' ? kgConfig.maxTokens : undefined,
    }),
  };
}

function createTaxonomyGraph(): TaxonomyGraphService {
  const config = getConfig();
  return new TaxonomyGraphService(config.knowledgeGraph);
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

interface ProcessingStats {
  documentsClassified: number;
  chunksEnriched: number;
  entitiesExtracted: number;
  entityInstancesUpserted: number;
  llmCallsMade: number;
  llmEscalations: number;
  vectorDbUpdates: number;
}

async function processKGEnrichmentJob(
  job: Job<KGEnrichmentJobData>,
): Promise<Record<string, unknown>> {
  const { indexId, tenantId, filter, options } = job.data;
  const batchSize = options?.batchSize || 50;

  workerLog('kg-enrichment', `Starting KG enrichment for index ${indexId}`, {
    tenantId,
    batchSize,
    filter,
  });

  return await withTenantContext({ tenantId }, async () => {
    // Resolve per-index LLM configuration (tenant-isolated)
    const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
    const kgConfig = llmConfig.useCases.knowledgeGraph;
    const llmClient = new WorkerLLMClient(kgConfig.provider, kgConfig.apiKey, kgConfig.model);
    const { taxonomyLoader, documentClassifier, entityExtractor } = createLLMServices(
      llmClient,
      kgConfig,
    );

    // Step 1: Load taxonomy
    const taxonomyDoc = await KnowledgeGraphTaxonomy.findOne({ tenantId, indexId });

    if (!taxonomyDoc) {
      // Mark all documents as SKIPPED
      await SearchDocument.updateMany(
        {
          tenantId,
          indexId,
          $or: [
            { 'metadata.kgState.status': { $in: ['NOT_ENRICHED', null] } },
            { 'metadata.kgState': { $exists: false } },
          ],
        },
        {
          $set: {
            'metadata.kgState': {
              status: 'SKIPPED',
              skippedReason: 'NO_TAXONOMY',
              needsReclassification: false,
            },
          },
        },
      );

      workerLog('kg-enrichment', 'No taxonomy found, all documents marked as SKIPPED', {
        indexId,
      });

      return {
        status: 'SKIPPED',
        reason: 'NO_TAXONOMY',
        message: 'Taxonomy not configured for this index. Run taxonomy setup first.',
      };
    }

    // Initialize non-LLM services
    const taxonomyGraph = createTaxonomyGraph();
    const vectorStore = getVectorStore();

    await taxonomyGraph.connect();

    // Step 2: Build query filter for DOCUMENTS (not chunks!)
    // KG classification requires an LLM-generated summary (metadata.documentSummary).
    // Documents without an LLM summary are skipped — raw text would produce poor classifications.
    const docQuery: Record<string, unknown> = { tenantId, indexId };

    const summaryFilter = { 'metadata.documentSummary': { $ne: null } };

    // Filter by KG state (unless forceReclassify is true)
    if (!options?.forceReclassify) {
      const statusFilter: string[] = ['NOT_ENRICHED'];
      if (options?.retrySkipped) {
        statusFilter.push('SKIPPED');
      }

      docQuery.$and = [
        summaryFilter,
        {
          $or: [
            { 'metadata.kgState.status': { $in: statusFilter } },
            { 'metadata.kgState': { $exists: false } },
          ],
        },
      ];
    } else {
      // forceReclassify: process ALL documents with LLM summaries (no status filter)
      docQuery.$and = [summaryFilter];
    }

    // Optional: filter by upload date
    if (filter?.uploadedAfter) {
      docQuery.createdAt = { $gte: new Date(filter.uploadedAfter) };
    }

    // Step 3: Count and process DOCUMENTS
    const totalDocuments = await SearchDocument.countDocuments(docQuery);

    workerLog('kg-enrichment', `Found ${totalDocuments} documents to process`, {
      indexId,
      batchSize,
    });

    if (totalDocuments === 0) {
      return {
        status: 'COMPLETED',
        documentsProcessed: 0,
        message: 'No documents to process',
      };
    }

    let processed = 0;
    const stats: ProcessingStats = {
      documentsClassified: 0,
      chunksEnriched: 0,
      entitiesExtracted: 0,
      entityInstancesUpserted: 0,
      llmCallsMade: 0,
      llmEscalations: 0,
      vectorDbUpdates: 0,
    };

    // Step 4: Process DOCUMENTS using cursor (memory efficient)
    const cursor = SearchDocument.find(docQuery).cursor();
    let batch: ISearchDocument[] = [];

    for await (const document of cursor) {
      batch.push(document);

      if (batch.length === batchSize) {
        await processDocumentBatch(
          batch,
          taxonomyDoc,
          documentClassifier,
          entityExtractor,
          taxonomyGraph,
          vectorStore,
          stats,
        );
        processed += batch.length;
        batch = [];

        // Update job progress
        const progress = Math.round((processed / totalDocuments) * 100);
        await job.updateProgress(progress);

        workerLog('kg-enrichment', `Progress: ${processed}/${totalDocuments} (${progress}%)`, {
          stats,
        });
      }
    }

    // Process remaining documents
    if (batch.length > 0) {
      await processDocumentBatch(
        batch,
        taxonomyDoc,
        documentClassifier,
        entityExtractor,
        taxonomyGraph,
        vectorStore,
        stats,
      );
      processed += batch.length;
      await job.updateProgress(100);
    }

    // Flush remaining ClickHouse entity instances
    if (_clickHouseEntityStore) {
      await _clickHouseEntityStore.flush();
    }

    // Refresh taxonomy in Redis cache
    try {
      const { getTaxonomyCacheWriter } = await import('../services/taxonomy-cache-writer.js');
      const cacheWriter = getTaxonomyCacheWriter();
      await cacheWriter.writeTaxonomy(tenantId, indexId, taxonomyDoc);
    } catch (cacheError) {
      workerLog('kg-enrichment', 'Failed to refresh taxonomy cache', {
        error: cacheError instanceof Error ? cacheError.message : String(cacheError),
      });
    }

    workerLog('kg-enrichment', 'KG enrichment completed', {
      indexId,
      documentsProcessed: processed,
      stats,
    });

    return {
      status: 'COMPLETED',
      documentsProcessed: processed,
      stats,
    };
  });
}

/**
 * Process a batch of documents:
 * Per chunk:
 *   1. Classify document using existing summary
 *   2. Extract entities from chunk text (scoped by document's product classification)
 *   4. Update vector DB with classification metadata (per chunk)
 *   5. Deduplicate entities into entityInstancesMap
 * Per document (after all chunks):
 *   5.5. Validate and store novel attribute candidates
 *   6.   Upsert deduplicated entity instances to Neo4j
 *   6.5. Write entity instances to ClickHouse (DELETE-before-INSERT)
 *   7.   Update MongoDB document with classification + entityInstances + kgState
 */
async function processDocumentBatch(
  batch: ISearchDocument[],
  taxonomy: IKnowledgeGraphTaxonomy,
  documentClassifier: DocumentClassifierService,
  entityExtractor: EntityExtractorService,
  taxonomyGraph: TaxonomyGraphService,
  vectorStore: VectorStoreProvider,
  stats: ProcessingStats,
): Promise<void> {
  /** Max concurrent document processing within a batch */
  const BATCH_CONCURRENCY = 5;
  const limit = pLimit(BATCH_CONCURRENCY);

  // H1 fix: Hoist approved attr query to batch level (was N+1 per document).
  // All docs in batch share (tenantId, indexId) so the result is the same for all.
  // Note: Only 'approved' tier is excluded (not 'discarded'). Discarded attributes
  // may have been incorrectly rejected and should be re-discoverable if they appear
  // again with higher confidence.
  const { AttributeRegistry } = await import('@agent-platform/database/models');
  const sampleDoc = batch[0];
  const approvedAttrIds = new Set<string>();
  if (sampleDoc) {
    const approvedAttrs = await AttributeRegistry.find(
      {
        tenantId: sampleDoc.tenantId,
        indexId: sampleDoc.indexId,
        tier: 'approved',
      },
      { attributeId: 1 },
    ).lean();
    for (const attr of approvedAttrs) {
      approvedAttrIds.add(attr.attributeId);
    }
  }

  await Promise.all(
    batch.map((document) =>
      limit(async () => {
        try {
          // Step 1: Classify document using LLM summary (zero extra cost!)
          const documentSummary = (document.metadata?.documentSummary as string) || '';
          const classificationResult = await documentClassifier.classifyDocument(
            {
              title: document.originalReference || 'Untitled',
              summary: documentSummary,
              metadata: document.sourceMetadata,
            },
            taxonomy,
          );

          stats.llmCallsMade++;
          stats.documentsClassified++;

          if (classificationResult.classification.escalatedToSonnet) {
            stats.llmEscalations++;
          }

          workerLog('kg-enrichment', `Classified document ${document._id}`, {
            documentId: document._id.toString(),
            productScope: classificationResult.classification.productScope.primaryProduct,
            confidence: classificationResult.classification.productScope.confidence,
            escalated: classificationResult.classification.escalatedToSonnet,
          });

          // Step 2: Extract entities from document's chunks (scoped by document classification)
          // NOTE: Document nodes are NOT stored in Neo4j taxonomy graph. Document
          // classification data lives in MongoDB (updated in Step 7). The taxonomy
          // graph only stores Domain → Category → Product → Attribute → EntityInstance.
          const documentChunks = await SearchChunk.find({
            tenantId: document.tenantId,
            indexId: document.indexId,
            documentId: document._id,
          });

          // Resolve vector store index name
          const vectorIndexName = await resolveIndexForWrite(
            vectorStore,
            document.tenantId,
            document.indexId,
            document.sourceId,
          );

          // Collect novel candidates across all chunks for this document
          // Validated and stored in Step 5.5 (AttributeRegistry + ClickHouse)
          const allNovelCandidates: NovelCandidate[] = [];

          // Collect deduplicated entity instances for this document
          // Bounded: one entry per unique "type:normalizedValue" per document, typically <500
          const entityInstancesMap = new Map<
            string,
            {
              entityInstanceId: string;
              type: string;
              rawValue: string;
              normalizedValue: string | number | boolean;
              dataType?: string;
              chunkIds: string[];
            }
          >();

          for (const chunk of documentChunks) {
            // Detect structured JSON chunks: if metadata.originalRecord.content
            // is a JSON string, parse and extract fields directly (100% coverage).
            // Falls back to regex+LLM for unstructured text (PDFs, HTML, etc.)
            const originalRecord = chunk.metadata?.originalRecord as
              | Record<string, unknown>
              | undefined;
            const originalContent =
              originalRecord?.content && typeof originalRecord.content === 'string'
                ? originalRecord.content
                : null;

            let entities: import('../services/entity-extractor.service.js').ExtractionResult['known'];
            let novelCandidates: import('../services/entity-extractor.service.js').NovelCandidate[];

            if (originalContent) {
              // Structured JSON path — direct field extraction (no regex/LLM needed)
              try {
                const parsedRecord = JSON.parse(originalContent) as Record<string, unknown>;
                const structuredResult = entityExtractor.extractFromStructuredRecord(
                  parsedRecord,
                  taxonomy,
                  classificationResult.classification.productScope.primaryProduct,
                );
                entities = structuredResult.known;
                novelCandidates = structuredResult.novel;
              } catch (parseError) {
                // JSON parse failed — fall back to text extraction
                workerLog('kg-enrichment', 'JSON parse failed, falling back to text extraction', {
                  chunkId: chunk._id?.toString(),
                  error: parseError instanceof Error ? parseError.message : String(parseError),
                });
                const extractionInput =
                  (chunk.metadata?.progressiveSummary as string) || chunk.content;
                const textResult = await entityExtractor.extractEntities(
                  extractionInput,
                  taxonomy,
                  classificationResult.classification.productScope.primaryProduct,
                );
                entities = textResult.known;
                novelCandidates = textResult.novel;
              }
            } else {
              // Unstructured text path — regex primary, LLM fallback
              const extractionInput =
                (chunk.metadata?.progressiveSummary as string) || chunk.content;
              const textResult = await entityExtractor.extractEntities(
                extractionInput,
                taxonomy,
                classificationResult.classification.productScope.primaryProduct,
              );
              entities = textResult.known;
              novelCandidates = textResult.novel;
            }

            allNovelCandidates.push(...novelCandidates);
            stats.entitiesExtracted += entities.length;
            stats.chunksEnriched++;

            // Note: Entity extraction uses hybrid approach (regex primary, LLM fallback)
            // LLM calls are tracked within EntityExtractorService

            // Update chunk metadata with entities
            await SearchChunk.updateOne(
              { _id: chunk._id, tenantId: chunk.tenantId, indexId: chunk.indexId },
              {
                $set: {
                  'metadata.entities': entities,
                  'metadata.kgState': {
                    status: 'ENRICHED',
                    enrichedAt: new Date(),
                    taxonomyVersion: taxonomy.version,
                  },
                },
              },
            );

            // Step 4: Update Vector DB with DOCUMENT classification (propagate to all chunks)
            // Fetch existing record to preserve the original embedding vector
            const existingRecords = await vectorStore.getByIds(vectorIndexName, [
              chunk._id.toString(),
            ]);
            const existingVector = existingRecords[0]?.vector;

            if (existingVector && existingVector.length > 0) {
              // Deep-merge to preserve existing nested structure (sys, doc, canonical).
              // Classification data goes under canonical.custom.kg (enabled:false —
              // stored in _source but not indexed). ClickHouse is the query-time
              // facet store; this is for display/debugging only.
              // Vector store metadata is untyped (varies by provider) — Record<string, any> is intentional
              const existingMeta = (existingRecords[0]?.metadata || {}) as Record<string, any>;
              const existingCanonical = (existingMeta.canonical || {}) as Record<string, any>;
              const existingCustom = (existingCanonical.custom || {}) as Record<string, any>;

              await vectorStore.upsert(vectorIndexName, [
                {
                  id: chunk._id.toString(),
                  vector: existingVector, // Preserve original embedding
                  metadata: {
                    ...existingMeta,
                    canonical: {
                      ...existingCanonical,
                      custom: {
                        ...existingCustom,
                        kg: {
                          primaryProduct:
                            classificationResult.classification.productScope.primaryProduct,
                          secondaryProducts:
                            classificationResult.classification.productScope.secondaryProducts,
                          confidence: classificationResult.classification.productScope.confidence,
                          department: classificationResult.classification.department,
                          category: classificationResult.classification.category,
                          kgEnriched: true,
                          kgEnrichedAt: new Date().toISOString(),
                        },
                      },
                    },
                  },
                },
              ]);
              stats.vectorDbUpdates++;
            } else {
              workerLog(
                'kg-enrichment',
                `Skipping vector DB update for chunk ${chunk._id} — no existing vector found`,
                { documentId: document._id.toString() },
              );
            }

            // Step 5: Deduplicate entity instances within this document
            for (const entity of entities) {
              // Generate deduplicated entity instance ID
              const entityInstanceId = `${entity.type}:${entity.normalizedValue}`;

              if (entityInstancesMap.has(entityInstanceId)) {
                // Add chunk ID to existing entity instance
                entityInstancesMap.get(entityInstanceId)!.chunkIds.push(chunk._id.toString());
              } else {
                // Create new entity instance entry
                entityInstancesMap.set(entityInstanceId, {
                  entityInstanceId,
                  type: entity.type,
                  rawValue: entity.rawValue,
                  normalizedValue: entity.normalizedValue,
                  chunkIds: [chunk._id.toString()],
                });
              }
            }
          }

          // Step 5.5: Validate and store novel candidates in AttributeRegistry
          // H3 fix: Wrapped in try/catch — novel storage is optional enhancement.
          // A transient failure here must NOT discard enrichment work from Steps 1-5.
          try {
            if (allNovelCandidates.length > 0) {
              const { validateNovelCandidate } =
                await import('../services/novel-candidate-validator.js');

              // Build set of known attribute IDs for validation.
              // Includes permanent (taxonomy) + approved/discarded (hoisted batch query H1 fix)
              const knownAttributeIds = new Set(
                taxonomy.taxonomy.attributes.map((a: { id: string }) => a.id),
              );
              for (const id of approvedAttrIds) {
                knownAttributeIds.add(id);
              }

              // Validate once, reuse filtered list for both AR upsert and ClickHouse write
              const validCandidates = allNovelCandidates.filter((c) =>
                validateNovelCandidate(c, knownAttributeIds),
              );

              // Dedup by name: keep highest confidence per attribute name.
              // Same attr discovered in 50 chunks → 1 AR upsert instead of 50.
              const candidateMap = new Map<string, NovelCandidate>();
              for (const c of validCandidates) {
                const existing = candidateMap.get(c.name);
                if (!existing || c.confidence > existing.confidence) {
                  candidateMap.set(c.name, c);
                }
              }
              const dedupedCandidates = [...candidateMap.values()];

              let storedCount = 0;
              for (const candidate of dedupedCandidates) {
                try {
                  // Two-phase upsert: (1) ensure record exists, (2) conditionally update
                  // definition only when confidence improves (fixes H2 race condition
                  // where $set + $max are independent operators).
                  await AttributeRegistry.findOneAndUpdate(
                    {
                      tenantId: document.tenantId,
                      indexId: document.indexId,
                      attributeId: candidate.name,
                      productScope: classificationResult.classification.productScope.primaryProduct,
                    },
                    {
                      $setOnInsert: {
                        tier: 'novel',
                        displayName: candidate.name.replace(/_/g, ' '),
                        dataType: candidate.dataType,
                        definition: candidate.definition,
                        aliases: [],
                        extractionPatterns: [],
                        discoverySource: 'llm_extraction',
                        firstSeenAt: new Date(),
                      },
                      $set: {
                        lastSeenAt: new Date(),
                      },
                      $inc: {
                        documentCount: 1,
                      },
                    },
                    { upsert: true },
                  );

                  // Phase 2: Conditionally update definition + confidence only when
                  // the new confidence exceeds the stored value. This prevents a
                  // low-confidence extraction from overwriting a high-quality definition.
                  if (candidate.definition && candidate.confidence > 0) {
                    await AttributeRegistry.updateOne(
                      {
                        tenantId: document.tenantId,
                        indexId: document.indexId,
                        attributeId: candidate.name,
                        productScope:
                          classificationResult.classification.productScope.primaryProduct,
                        $or: [
                          { confidence: { $exists: false } },
                          { confidence: { $lt: candidate.confidence } },
                        ],
                      },
                      {
                        $set: {
                          confidence: candidate.confidence,
                          definition: candidate.definition,
                        },
                      },
                    );
                  }
                  storedCount++;
                } catch (error) {
                  // Fail-open: don't let novel storage failures block enrichment
                  workerError(
                    'kg-enrichment',
                    `Failed to store novel candidate ${candidate.name}`,
                    error,
                  );
                }
              }

              // Add validated novel entities to entityInstancesMap for ClickHouse write
              // Store dataType from the candidate (taxonomy lookup won't find novel attrs)
              for (const candidate of validCandidates) {
                const entityInstanceId = `${candidate.name}:${candidate.normalizedValue}`;
                if (!entityInstancesMap.has(entityInstanceId)) {
                  entityInstancesMap.set(entityInstanceId, {
                    entityInstanceId,
                    type: candidate.name,
                    rawValue: candidate.rawValue,
                    normalizedValue: String(candidate.normalizedValue),
                    dataType: candidate.dataType, // C1 fix: preserve novel candidate dataType
                    chunkIds: [], // Novel candidates don't track specific chunks
                  });
                }
              }

              if (storedCount > 0) {
                workerLog('kg-enrichment', `Stored ${storedCount} novel candidates`, {
                  documentId: document._id.toString(),
                  total: allNovelCandidates.length,
                  stored: storedCount,
                });
              }
            }
          } catch (novelError) {
            // Fail-open: novel candidate storage failures must not block enrichment
            workerError(
              'kg-enrichment',
              'Step 5.5 novel candidate processing failed — continuing enrichment',
              novelError,
            );
          }

          // Step 6: Batch upsert all entity instances to Neo4j (1 session per document, not per entity)
          const entitiesToUpsert = Array.from(entityInstancesMap.values()).map((e) => ({
            id: e.entityInstanceId,
            attributeId: e.type,
            rawValue: e.rawValue,
            normalizedValue: e.normalizedValue,
            productId: classificationResult.classification.productScope.primaryProduct,
          }));

          if (entitiesToUpsert.length > 0) {
            await taxonomyGraph.batchUpsertEntityInstances({
              tenantId: document.tenantId,
              indexId: document.indexId,
              entities: entitiesToUpsert,
            });
            stats.entityInstancesUpserted += entitiesToUpsert.length;
          }

          // Step 6.5: Write entity instances to ClickHouse for facet queries
          // Always DELETE before INSERT — handles re-enrichment (Amendment #8) AND
          // crash-retry safety (if prior run wrote CH but crashed before MongoDB update,
          // the document stays NOT_ENRICHED; DELETE is a no-op if no rows exist).
          const clickHouseEntityStore = getClickHouseEntityStore();
          await clickHouseEntityStore.deleteDocumentInstances(
            document.tenantId,
            document.indexId,
            document._id,
          );
          clickHouseEntityStore.writeEntityInstances({
            tenantId: document.tenantId,
            indexId: document.indexId,
            documentId: document._id,
            productType: classificationResult.classification.productScope.primaryProduct,
            taxonomyVersion: taxonomy.version,
            entityInstances: Array.from(entityInstancesMap.values()).map((e) => ({
              ...e,
              // C1 fix: use stored dataType (from novel candidate) as fallback
              // when taxonomy lookup returns undefined (novel attrs aren't in taxonomy)
              dataType:
                taxonomy.taxonomy.attributes.find((a: { id: string }) => a.id === e.type)
                  ?.dataType || (e as { dataType?: string }).dataType,
            })),
          });

          // Step 7: Update MongoDB document with classification + entity instances
          await SearchDocument.updateOne(
            { _id: document._id, tenantId: document.tenantId, indexId: document.indexId },
            {
              $set: {
                classification: classificationResult.classification,
                entityInstances: Array.from(entityInstancesMap.values()),
                'metadata.kgState': {
                  status: 'ENRICHED',
                  enrichedAt: new Date(),
                  taxonomyVersion: taxonomy.version,
                  needsReclassification: false,
                },
              },
            },
          );
        } catch (error) {
          workerError('kg-enrichment', `Failed to process document ${document._id}`, error);

          // Mark document as error
          await SearchDocument.updateOne(
            { _id: document._id, tenantId: document.tenantId, indexId: document.indexId },
            {
              $set: {
                'metadata.kgState': {
                  status: 'NOT_ENRICHED',
                  lastError: error instanceof Error ? error.message : String(error),
                  lastErrorAt: new Date(),
                },
              },
            },
          );
        }
      }),
    ),
  );
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the KG enrichment worker.
 *
 * @param concurrency — max parallel enrichment jobs (default 3)
 */
export default function createKGEnrichmentWorker(concurrency = 3): Worker<KGEnrichmentJobData> {
  const worker = new Worker<KGEnrichmentJobData>(
    'kg-enrichment',
    processKGEnrichmentJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('kg-enrichment', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('kg-enrichment', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('kg-enrichment', 'Worker error', err);
  });

  workerLog('kg-enrichment', `Started with concurrency=${concurrency}`);
  return worker;
}
