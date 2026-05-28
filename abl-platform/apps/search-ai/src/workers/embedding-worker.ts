/**
 * Embedding Worker
 *
 * Terminal stage of the ingestion pipeline. Picks up EmbeddingJobData
 * from QUEUE_EMBEDDING, generates vector embeddings for each chunk via
 * an EmbeddingProvider, upserts the vectors into a VectorStore, and
 * marks documents/chunks as indexed.
 *
 * Flow: ingest --> extract --> canonical-map --> enrich --> embed
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUE_EMBEDDING, DocumentStatus, ChunkStatus } from '@agent-platform/search-ai-sdk';
import {
  createVectorStore,
  createEmbeddingProvider,
  resolveIndexForWrite,
  EmbeddingProviderResolver,
  type VectorStoreProvider,
  type EmbeddingProvider,
  type VectorRecord,
  type VectorStoreFactoryConfig,
  type EmbeddingFactoryConfig,
} from '@agent-platform/search-ai-internal';
import type {
  ISearchDocument,
  ISearchChunk,
  ISearchIndex,
  IChunkQuestion,
  ICrawlJob,
  IKnowledgeBase,
  IConnectorConfig,
  ITenantModel,
} from '@agent-platform/database/models';
import type { Model } from 'mongoose';
import { getDualConnection, getLazyModel } from '../db/index.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import { publishProgressEvent } from '../routes/progress.js';

function getModels() {
  const dualConn = getDualConnection();
  const platformConn = dualConn.getPlatformConnection();
  const contentConn = dualConn.getContentConnection();

  return {
    SearchDocument: contentConn.models.SearchDocument as Model<ISearchDocument>,
    SearchChunk: contentConn.models.SearchChunk as Model<ISearchChunk>,
    SearchIndex: platformConn.models.SearchIndex as Model<ISearchIndex>,
    ChunkQuestion: contentConn.models.ChunkQuestion as Model<IChunkQuestion>,
    CrawlJob: contentConn.models.CrawlJob as Model<ICrawlJob>,
    KnowledgeBase: platformConn.models.KnowledgeBase as Model<IKnowledgeBase>,
    ConnectorConfig: platformConn.models.ConnectorConfig as Model<IConnectorConfig>,
  };
}
import { getConfig } from '../config/index.js';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { createWorkerOptions, workerLog, workerError } from './shared.js';
import type { EmbeddingJobData } from './shared.js';
import { logStatusTransition, logJobPickup, logJobCompletion } from './status-logger.js';
import { getDocumentPermissionResolver } from '../services/document-permissions/document-permission-resolver.js';

// =============================================================================
// PROVIDER SINGLETONS (lazy)
// =============================================================================

let _vectorStore: VectorStoreProvider | null = null;
let _embeddingProvider: EmbeddingProvider | null = null;

function getVectorStore(): VectorStoreProvider {
  if (!_vectorStore) {
    const config: VectorStoreFactoryConfig = {
      provider:
        (process.env.VECTOR_STORE_PROVIDER as 'opensearch' | 'qdrant' | 'pinecone' | 'pgvector') ||
        'opensearch',
      url: process.env.VECTOR_STORE_URL || 'http://localhost:9200',
      apiKey: process.env.VECTOR_STORE_API_KEY,
      timeoutMs: process.env.VECTOR_STORE_TIMEOUT_MS
        ? parseInt(process.env.VECTOR_STORE_TIMEOUT_MS, 10)
        : undefined,
    };
    _vectorStore = createVectorStore(config);
  }
  return _vectorStore;
}

/**
 * Resolve baseUrl for self-hosted embedding providers (bge-m3, custom).
 * For cloud providers (openai, cohere), returns undefined so they use their defaults.
 *
 * @param provider - Embedding provider type
 * @param userBaseUrl - User-provided baseUrl from providerConfig (takes priority)
 * @returns Resolved baseUrl or undefined
 */
function resolveEmbeddingBaseUrl(
  provider: string,
  userBaseUrl?: string,
  tenantModelEndpoint?: string,
): string | undefined {
  // User-provided baseUrl always takes priority (from pipeline providerConfig)
  if (userBaseUrl) return userBaseUrl;

  // TenantModel endpointUrl — for custom/self-hosted models added via Admin → Models
  if (tenantModelEndpoint) return tenantModelEndpoint;

  // For cloud providers, return undefined → they use their built-in defaults
  if (provider !== 'bge-m3' && provider !== 'custom') {
    return undefined;
  }

  // For bge-m3/custom: try env vars, fallback to localhost
  // Note: Helm configmap should set EMBEDDING_BASE_URL when bgeM3.enabled=true
  // This fallback chain ensures we fail gracefully if env vars are not set
  return (
    process.env.EMBEDDING_API_URL || process.env.EMBEDDING_BASE_URL || 'http://localhost:8000' // Last resort - will fail in K8s but clear in logs
  );
}

function getEmbeddingProvider(): EmbeddingProvider {
  if (!_embeddingProvider) {
    const provider =
      (process.env.EMBEDDING_PROVIDER as 'openai' | 'cohere' | 'bge-m3' | 'azure' | 'custom') ||
      'openai';

    const config: EmbeddingFactoryConfig = {
      provider,
      apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      dimensions: process.env.EMBEDDING_DIMENSIONS
        ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
        : undefined,
      baseUrl: resolveEmbeddingBaseUrl(provider),
      maxBatchSize: process.env.EMBEDDING_MAX_BATCH_SIZE
        ? parseInt(process.env.EMBEDDING_MAX_BATCH_SIZE, 10)
        : undefined,
      timeoutMs: process.env.EMBEDDING_TIMEOUT_MS
        ? parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10)
        : undefined,
    };

    workerLog(
      'embedding',
      `Initializing global embedding provider: ${config.provider} (model: ${config.model}, baseUrl: ${config.baseUrl || 'default'})`,
    );

    _embeddingProvider = createEmbeddingProvider(config);
  }
  return _embeddingProvider;
}

// =============================================================================
// PIPELINE-AWARE EMBEDDING PROVIDER RESOLUTION
// =============================================================================

import { resolveEmbeddingCredentials } from '../services/llm-config/embedding-credentials.js';
import type { ISearchPipelineDefinition } from '@agent-platform/database';

/**
 * Resolve embedding provider from pipeline's activeEmbeddingConfig.
 *
 * Resolution order:
 * 1. Pipeline config + tenant credentials (auth profile → LLMCredential → env var)
 * 2. Pipeline config + env-var credentials only (same provider type, safe fallback)
 * 3. Global singleton ONLY if provider type and dimensions match (prevents index corruption)
 * 4. Throw — better to fail the job than embed with wrong provider/dimensions
 *
 * CRITICAL: Never silently swap providers. A pipeline configured for openai/3072
 * must never fall back to bge-m3/1024 — that corrupts the vector index.
 */
async function resolveEmbeddingProviderForJob(
  tenantId: string,
  knowledgeBaseId?: string,
): Promise<EmbeddingProvider> {
  if (!knowledgeBaseId) {
    return getEmbeddingProvider(); // No KB context — use global singleton
  }

  // Step 1: Load pipeline config
  let pipelineConfig: {
    provider: string;
    model: string;
    dimensions?: number;
    providerConfig?: Record<string, unknown>;
  } | null = null;

  try {
    const dualConn = getDualConnection();
    const contentConn = dualConn.getContentConnection();
    const SearchPipelineDefinition = contentConn.models
      .SearchPipelineDefinition as Model<ISearchPipelineDefinition>;

    const pipeline = await SearchPipelineDefinition.findOne({
      tenantId,
      knowledgeBaseId,
      status: 'active',
    }).lean();

    if (!pipeline?.activeEmbeddingConfig) {
      workerLog('embedding', 'No activeEmbeddingConfig found, using global provider', {
        knowledgeBaseId,
      });
      return getEmbeddingProvider();
    }

    pipelineConfig = pipeline.activeEmbeddingConfig;
  } catch (dbError) {
    workerLog(
      'embedding',
      `Failed to load pipeline config: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
      { knowledgeBaseId },
    );
    // DB error — no pipeline config loaded, fall through to global singleton
    return getEmbeddingProvider();
  }

  const { provider, model, dimensions, providerConfig } = pipelineConfig;

  // Step 1.5: For custom/self-hosted providers, look up TenantModel endpoint URL
  // This enables models added via Admin → Models with a custom endpoint
  let tenantModelEndpoint: string | undefined;
  if ((provider === 'custom' || !providerConfig?.baseUrl) && model) {
    try {
      const TenantModel = getLazyModel<ITenantModel>('TenantModel');
      const tenantModel = await TenantModel.findOne({
        tenantId,
        modelId: model,
        isActive: true,
      }).lean();
      if (tenantModel?.endpointUrl) {
        tenantModelEndpoint = tenantModel.endpointUrl;
      }
    } catch {
      // Non-critical — falls through to other resolution paths
    }
  }

  // Step 2: Try tenant credential resolution (auth profile → LLMCredential → env var)
  try {
    const credentials = await resolveEmbeddingCredentials(provider, tenantId, model);

    // Merge Azure-specific fields: pipeline providerConfig takes priority,
    // then credential authConfig (stored on LLMCredential), then fallback empty.
    // This ensures Azure embedding works even if the UI didn't explicitly pass
    // resourceName/deploymentId/apiVersion — they're read from the credential.
    const authConfig = credentials.authConfig || {};
    const effectiveResourceName =
      (providerConfig?.resourceName as string | undefined) ||
      (authConfig.resourceName as string | undefined);

    // Resolve deploymentId with safety: if the resolved ID doesn't look like an
    // embedding model (e.g. "gpt-5.4-mini" from a chat credential), use the pipeline's
    // model name instead. Azure deployments for embedding are named after the model.
    let effectiveDeploymentId =
      (providerConfig?.deploymentId as string | undefined) ||
      (authConfig.deploymentId as string | undefined) ||
      model; // fallback: use model name as deployment ID

    // Safety check: if model is an embedding model but deploymentId is clearly a chat model,
    // override to prevent "embeddings operation does not work with model X" errors.
    if (
      provider === 'azure' &&
      model.toLowerCase().includes('embed') &&
      effectiveDeploymentId &&
      !effectiveDeploymentId.toLowerCase().includes('embed')
    ) {
      workerLog(
        'embedding',
        `Overriding non-embedding deploymentId "${effectiveDeploymentId}" with model name "${model}"`,
        { knowledgeBaseId },
      );
      effectiveDeploymentId = model;
    }
    const effectiveApiVersion =
      (providerConfig?.apiVersion as string | undefined) ||
      (authConfig.apiVersion as string | undefined);

    const config: EmbeddingFactoryConfig = {
      provider: provider as EmbeddingFactoryConfig['provider'],
      model,
      dimensions,
      apiKey: credentials.apiKey || undefined,
      baseUrl: resolveEmbeddingBaseUrl(
        provider,
        providerConfig?.baseUrl as string | undefined,
        tenantModelEndpoint,
      ),
      maxBatchSize: providerConfig?.maxBatchSize as number | undefined,
      // Use pipeline config timeout, falling back to env var, then provider default
      timeoutMs:
        (providerConfig?.timeoutMs as number | undefined) ||
        (process.env.EMBEDDING_TIMEOUT_MS
          ? parseInt(process.env.EMBEDDING_TIMEOUT_MS, 10)
          : undefined),
      // Azure-specific fields (ignored by non-azure providers)
      resourceName: effectiveResourceName,
      deploymentId: effectiveDeploymentId,
      apiVersion: effectiveApiVersion,
    };

    workerLog('embedding', `Using pipeline embedding provider: ${provider}/${model}`, {
      knowledgeBaseId,
      dimensions,
      credentialSource: credentials.source,
      hasAuthConfig: Object.keys(authConfig).length > 0,
      resourceName: effectiveResourceName || '(none)',
      deploymentId: effectiveDeploymentId || '(none)',
    });

    return createEmbeddingProvider(config);
  } catch (credError) {
    workerLog(
      'embedding',
      `Credential resolution failed for ${provider}, trying env-var fallback: ${credError instanceof Error ? credError.message : String(credError)}`,
      { knowledgeBaseId, provider },
    );
  }

  // Step 3: Env-var fallback — same provider type, no providerConfig.baseUrl
  // This ensures openai always hits api.openai.com, not the BGE-M3 base URL
  const ENV_KEY_MAP: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    cohere: 'COHERE_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
  };
  const envKey = ENV_KEY_MAP[provider];
  const envApiKey = envKey ? process.env[envKey] : undefined;

  if (envApiKey || provider === 'bge-m3' || provider === 'custom') {
    try {
      const fallbackConfig: EmbeddingFactoryConfig = {
        provider: provider as EmbeddingFactoryConfig['provider'],
        model,
        dimensions,
        apiKey: envApiKey || undefined,
        baseUrl: resolveEmbeddingBaseUrl(
          provider,
          providerConfig?.baseUrl as string | undefined,
          tenantModelEndpoint,
        ),
        maxBatchSize: providerConfig?.maxBatchSize as number | undefined,
        timeoutMs: providerConfig?.timeoutMs as number | undefined,
        // Azure-specific fields
        resourceName: providerConfig?.resourceName as string | undefined,
        deploymentId: providerConfig?.deploymentId as string | undefined,
        apiVersion: providerConfig?.apiVersion as string | undefined,
      };

      workerLog('embedding', `Using env-var fallback for pipeline provider: ${provider}/${model}`, {
        knowledgeBaseId,
        dimensions,
        hasApiKey: !!envApiKey,
      });

      return createEmbeddingProvider(fallbackConfig);
    } catch (fallbackError) {
      workerLog(
        'embedding',
        `Env-var fallback also failed for ${provider}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        { knowledgeBaseId },
      );
    }
  }

  // Step 4: Check if global singleton is compatible (same provider + same dimensions)
  const globalProvider = getEmbeddingProvider();
  const globalDims = globalProvider.dimensions;
  const globalName = globalProvider.name;

  if (globalName === provider && (!dimensions || globalDims === dimensions)) {
    workerLog(
      'embedding',
      `Falling back to compatible global singleton: ${globalName}/${globalDims}d`,
      { knowledgeBaseId, pipelineProvider: provider, pipelineDimensions: dimensions },
    );
    return globalProvider;
  }

  // Step 5: Incompatible — fail the job rather than corrupt the index
  const errorMsg =
    `Cannot resolve embedding provider for pipeline config (${provider}/${model}/${dimensions}d). ` +
    `Global singleton is ${globalName}/${globalDims}d — incompatible. ` +
    `Ensure ${provider} credentials are configured (auth profile, LLMCredential, or env var).`;

  workerLog('embedding', errorMsg, { knowledgeBaseId, tenantId });
  throw new Error(errorMsg);
}

// =============================================================================
// EMBEDDING TEXT BUILDER
// =============================================================================

/**
 * Build the text to embed for a chunk.
 *
 * Injects image descriptions INLINE at their actual positions in the text,
 * rather than appending them at the end. This preserves the spatial context
 * of where diagrams/charts appear relative to the surrounding narrative.
 *
 * Combines the base chunk content with LLM-generated enrichments:
 *
 * 1. **Visual Enrichment Worker** enrichments (metadata.visualAnalysis)
 *    — Page-level image descriptions injected inline at top/middle/bottom positions
 * 2. **Multimodal Worker** enrichments (metadata.imageDescriptions, metadata.tableSummaries)
 *    — LLM vision descriptions of images/tables found inside the chunk
 *
 * This ensures vision-derived semantics AND table understanding are
 * captured in the vector embedding, making documents searchable by
 * visual + tabular content — not just raw OCR text or markdown.
 */
function buildEmbeddingText(chunk: any): string {
  const metadata = chunk.metadata;
  if (!metadata) return chunk.content || '';

  // Start with raw content (NOT enriched summary - we want all the OCR text including diagram labels)
  let text = chunk.content || '';

  // ── Inject Visual Analysis descriptions inline ─────────────────────────
  const visualAnalysis = metadata.visualAnalysis;
  if (visualAnalysis?.processed && visualAnalysis.imageDescriptions?.length > 0) {
    const imageDescs = visualAnalysis.imageDescriptions;

    // Group images by position
    const topImages: any[] = [];
    const middleImages: any[] = [];
    const bottomImages: any[] = [];
    const unpositionedImages: any[] = [];

    imageDescs.forEach((img: any) => {
      const pos = img.position?.pageRelative;
      if (pos === 'top') topImages.push(img);
      else if (pos === 'middle') middleImages.push(img);
      else if (pos === 'bottom') bottomImages.push(img);
      else unpositionedImages.push(img);
    });

    // Split text into lines for injection
    const lines = text.split('\n').filter((line: string) => line.trim().length > 0);
    const result: string[] = [];

    // Inject top images at beginning
    if (topImages.length > 0) {
      topImages.forEach((img: any) => {
        result.push(`[IMAGE: ${img.description}]`);
      });
      result.push('');
    }

    // Calculate injection points for middle/bottom
    const thirdPoint = Math.floor(lines.length / 3);
    const twoThirdPoint = Math.floor((lines.length * 2) / 3);

    // Inject images at appropriate positions
    lines.forEach((line: string, idx: number) => {
      result.push(line);

      // Inject middle images after first third
      if (idx === thirdPoint && middleImages.length > 0) {
        result.push('');
        middleImages.forEach((img: any) => {
          result.push(`[IMAGE: ${img.description}]`);
        });
        result.push('');
      }

      // Inject bottom images after two thirds
      if (idx === twoThirdPoint && bottomImages.length > 0) {
        result.push('');
        bottomImages.forEach((img: any) => {
          result.push(`[IMAGE: ${img.description}]`);
        });
        result.push('');
      }
    });

    // Unpositioned images go at end
    if (unpositionedImages.length > 0) {
      result.push('');
      unpositionedImages.forEach((img: any) => {
        result.push(`[IMAGE: ${img.description}]`);
      });
    }

    text = result.join('\n');
  }

  // ── Multimodal Worker enrichments (appended) ───────────────────────────
  // Image descriptions from LLM vision (stored by multimodal-worker)
  const mmImageDescs: Array<{ description?: string }> = metadata.imageDescriptions || [];
  const mmImages = mmImageDescs
    .map((img: { description?: string }) => img.description)
    .filter(Boolean);

  if (mmImages.length > 0) {
    text += '\n\n[Additional Image Context]\n' + mmImages.join('\n');
  }

  // Table summaries from LLM (stored by multimodal-worker)
  const mmTableSummaries: Array<{ summary?: string }> = metadata.tableSummaries || [];
  const mmTables = mmTableSummaries.map((t: { summary?: string }) => t.summary).filter(Boolean);

  if (mmTables.length > 0) {
    text += '\n\n[Table Summaries]\n' + mmTables.join('\n');
  }

  // ── Visual context (appended) ──────────────────────────────────────────
  if (visualAnalysis?.visualContext) {
    text += '\n\n[Visual Context]\n' + visualAnalysis.visualContext;
  }

  // Screenshot layout analysis
  if (visualAnalysis?.screenshotAnalysis) {
    text += '\n\n[Visual Layout]\n' + visualAnalysis.screenshotAnalysis;
  }

  return text;
}

// =============================================================================
// WORKER PROCESSOR
// =============================================================================

/** Default number of chunks to embed in a single API call */
const EMBEDDING_BATCH_SIZE = parseInt(process.env.INGESTION_EMBEDDING_BATCH_SIZE || '50', 10);

async function processEmbeddingJob(job: Job<EmbeddingJobData>): Promise<void> {
  const jobStartMs = Date.now();
  const { indexId, documentId, tenantId, pipelineId, knowledgeBaseId, mode, batchId } = job.data;
  let { chunkIds } = job.data;
  const {
    SearchDocument,
    SearchChunk,
    SearchIndex,
    ChunkQuestion,
    KnowledgeBase,
    ConnectorConfig,
  } = getModels();

  logJobPickup({
    worker: 'embedding',
    jobId: job.id || 'unknown',
    documentId,
    queueName: QUEUE_EMBEDDING,
    timestamp: new Date(),
  });

  // If chunkIds not provided (e.g., enqueued by page-processing without enrichment),
  // resolve all chunks for this document from the database
  if (!chunkIds || chunkIds.length === 0) {
    const allChunks = await SearchChunk.find({ documentId, tenantId, indexId }, { _id: 1 }).lean();
    chunkIds = allChunks.map((c: { _id: string }) => c._id);
    workerLog('embedding', `Resolved ${chunkIds.length} chunkIds from DB (not in job data)`, {
      documentId,
      indexId,
    });
  }

  workerLog('embedding', `Embedding document ${documentId} (${chunkIds.length} chunks)`, {
    indexId,
  });

  await withTenantContext({ tenantId }, async () => {
    // ── 1. Load index and document ────────────────────────────────────────
    const [index, document] = await Promise.all([
      SearchIndex.findOne({ _id: indexId, tenantId }).lean(),
      SearchDocument.findOne({ _id: documentId, indexId, tenantId }),
    ]);

    if (!index) {
      throw new Error(`Index ${indexId} not found`);
    }
    if (!document) {
      throw new Error(`Document ${documentId} not found in index ${indexId}`);
    }

    // Check if document was already indexed BEFORE changing status
    const wasAlreadyIndexed = document.status === DocumentStatus.INDEXED;

    // Mark document as embedding
    await SearchDocument.findOneAndUpdate(
      { _id: documentId, tenantId },
      {
        status: DocumentStatus.EMBEDDING,
        processingError: null,
      },
    );

    try {
      // ── 2. Load chunks ──────────────────────────────────────────────────
      const chunks = await SearchChunk.find({
        _id: { $in: chunkIds },
        tenantId,
        indexId,
      }).sort({ chunkIndex: 1 });

      if (chunks.length === 0) {
        workerLog('embedding', `No chunks found for document ${documentId}, skipping`);
        await SearchDocument.findOneAndUpdate(
          { _id: documentId, tenantId },
          {
            status: DocumentStatus.ERROR,
            processingError: 'No chunks found for embedding',
          },
        );
        return;
      }

      // ── 2.5. Resolve knowledge base ID ──────────────────────────────────
      // Job data may not include knowledgeBaseId (legacy jobs), so query KnowledgeBase by searchIndexId
      let resolvedKnowledgeBaseId = knowledgeBaseId;
      if (!resolvedKnowledgeBaseId) {
        const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
        if (kb) {
          resolvedKnowledgeBaseId = kb._id;
          workerLog(
            'embedding',
            `Resolved knowledgeBaseId from SearchIndex: ${resolvedKnowledgeBaseId}`,
            { indexId },
          );
        }
      }

      // T11: Resolve embedding provider from pipeline config (falls back to global)
      const embeddingProvider = await resolveEmbeddingProviderForJob(
        tenantId,
        resolvedKnowledgeBaseId,
      );
      const vectorStore = getVectorStore();

      // ── 3. Resolve vector store index name ──────────────
      // For SearchAI with knowledge bases: Use activeVectorIndex from SearchIndex (versioned per dimension change)
      // For legacy/connectors: Fall back to IndexRegistry system
      let vectorIndexName: string;
      if (index.activeVectorIndex) {
        vectorIndexName = index.activeVectorIndex;
        workerLog('embedding', `Using per-KB vector index from SearchIndex: ${vectorIndexName}`, {
          indexId,
        });
      } else {
        // Legacy: Use IndexRegistry system (shared/per-app/per-connector)
        vectorIndexName = await resolveIndexForWrite(
          vectorStore,
          tenantId,
          indexId, // appId
          document.sourceId, // connectorId
        );
        workerLog('embedding', `Using vector store index from IndexRegistry: ${vectorIndexName}`, {
          indexId,
        });

        // Back-fill activeVectorIndex on the SearchIndex so query pipeline can find it
        // without needing the IndexRegistry fallback. This is a one-time fix for KBs
        // created before activeVectorIndex was tracked on the SearchIndex.
        try {
          await SearchIndex.findOneAndUpdate(
            { _id: indexId, tenantId, activeVectorIndex: null },
            { $set: { activeVectorIndex: vectorIndexName } },
          );
          workerLog(
            'embedding',
            `Back-filled activeVectorIndex on SearchIndex: ${vectorIndexName}`,
            { indexId },
          );
        } catch (backfillErr) {
          // Non-critical: search still works via IndexRegistry fallback
          workerLog('embedding', 'Failed to back-fill activeVectorIndex (non-critical)', {
            indexId,
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
          });
        }
      }

      // ── 3.5. Resolve document permissions (once per document) ─────────────
      //
      // Permission resolution depends on the document source:
      //
      //   1. No connectorId (file upload, web crawl) → always public.
      //      These sources have no external permission model to honor.
      //
      //   2. Connector with permissionConfig.mode === 'disabled' → always public.
      //      Admin explicitly opted out of RACL for this connector.
      //
      //   3. Connector with permissionConfig.mode === 'enabled' → query
      //      AclDocumentPermissions via getFlattenedPermissions(). If no record
      //      found, fail-closed (publicEverywhere: false) — the permission crawl
      //      hasn't run yet, so we can't know the access level.
      //
      // This ensures:
      // - Existing non-RACL workflows (upload, crawl, RACL-disabled connectors) are unaffected
      // - RACL-enabled connectors get proper fail-closed behavior
      //
      let permissions = {
        publicEverywhere: false,
        publicInDomain: false,
        allowedUsers: [] as string[],
        allowedGroups: [] as string[],
        allowedDomains: [] as string[],
        source: 'default-restricted' as string,
      };

      // Determine if RACL is enabled for this document's source
      let raclEnabled = false;
      const connectorId = document.connectorId;

      if (connectorId) {
        // Document came from a connector — check permissionConfig.mode
        try {
          const connector = await ConnectorConfig.findOne(
            { _id: connectorId, tenantId },
            { 'permissionConfig.mode': 1 },
          ).lean();
          raclEnabled = connector?.permissionConfig?.mode === 'enabled';
        } catch (connErr) {
          // If we can't read the connector config, default to RACL disabled (public).
          // This is fail-open for permissions but fail-safe for user experience —
          // the alternative (fail-closed) would silently hide all connector docs
          // when the platform DB is temporarily unavailable.
          workerLog('embedding', 'Could not read connector permissionConfig, treating as public', {
            connectorId,
            documentId,
            error: connErr instanceof Error ? connErr.message : String(connErr),
          });
        }
      }
      // No connectorId → file upload or web crawl → always public

      if (!raclEnabled) {
        // Non-RACL source: stamp as public — no permission crawl needed
        permissions = {
          publicEverywhere: true,
          publicInDomain: false,
          allowedUsers: [],
          allowedGroups: [],
          allowedDomains: [],
          source: connectorId ? 'connector-racl-disabled' : 'upload-or-crawl',
        };
      } else {
        // RACL-enabled connector: query AclDocumentPermissions
        try {
          const permissionResolver = getDocumentPermissionResolver();
          permissions = await permissionResolver.getPermissions(tenantId, documentId);
        } catch (permErr) {
          // FAIL-CLOSED: Permission service unavailable — keep restricted defaults.
          // Private docs stay private until permission crawl succeeds.
          permissions.publicEverywhere = false;
          permissions.source = 'fallback-restricted';
          workerLog('embedding', 'Permission service unavailable, using fail-closed fallback', {
            documentId,
            publicEverywhere: permissions.publicEverywhere,
            error: permErr instanceof Error ? permErr.message : String(permErr),
          });
        }
      }

      workerLog('embedding', 'Document permissions resolved', {
        documentId,
        connectorId: connectorId ?? null,
        raclEnabled,
        publicEverywhere: permissions.publicEverywhere,
        allowedUserCount: permissions.allowedUsers.length,
        allowedGroupCount: permissions.allowedGroups.length,
        source: permissions.source,
      });

      // ── 3.7. Ensure vector store collection/index exists ──────────────────
      // FIX: Critical Bug #5 - Qdrant Collection Never Created
      // Vector stores (Qdrant/OpenSearch) require explicit collection/index creation
      // before upsert operations. Missing this causes silent failure where MongoDB
      // shows status='indexed' but vectors are never stored.
      try {
        workerLog('embedding', `Checking if vector store collection exists: ${vectorIndexName}`);

        const exists = await vectorStore.collectionExists(vectorIndexName);

        if (!exists) {
          workerLog('embedding', `Creating vector store collection: ${vectorIndexName}`);

          await vectorStore.createCollection({
            name: vectorIndexName,
            dimensions: index.embeddingDimensions || 1536,
            distance: 'cosine',
          });

          workerLog('embedding', `Vector store collection created: ${vectorIndexName}`);
        } else {
          workerLog('embedding', `Vector store collection already exists: ${vectorIndexName}`);
        }
      } catch (collectionError) {
        workerError(
          'embedding',
          `Failed to ensure vector store collection: ${vectorIndexName}`,
          collectionError,
        );
        throw new Error(
          `Vector store collection creation failed: ${collectionError instanceof Error ? collectionError.message : String(collectionError)}`,
        );
      }

      // ── 4. Process chunks in batches ────────────────────────────────────
      let processedCount = 0;

      for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
        const texts = batch.map((c) => buildEmbeddingText(c));

        // Generate embeddings
        const result = await embeddingProvider.embedBatch(texts);

        // Build vector records with structured metadata (sys, doc, canonical, permissions)
        const vectorRecords: VectorRecord[] = batch.map((chunk, batchIdx) => ({
          id: chunk._id,
          vector: result.embeddings[batchIdx],
          // Use the enriched text (with image descriptions) as stored content
          // so vector store content matches the embedded text
          metadata: {
            // System metadata (indexing concerns)
            sys: {
              tenantId,
              appId: indexId,
              connectorId: document.sourceId,
              documentId,
              chunkId: chunk._id,
              chunkIndex: chunk.chunkIndex,
            },
            // Document metadata (source information)
            doc: {
              name: document.name || document.originalReference || null,
              contentType: document.contentType || null,
              contentHash: document.contentHash,
              language: document.language || null,
              summary: (document.metadata?.documentSummary as string) || null,
            },
            // Canonical metadata (enrichment results)
            canonical: chunk.canonicalMetadata ?? {},
          },
          // Permissions metadata (document-level access control)
          permissions: {
            publicEverywhere: permissions.publicEverywhere,
            publicInDomain: permissions.publicInDomain,
            allowedUsers: permissions.allowedUsers,
            allowedGroups: permissions.allowedGroups,
            allowedDomains: permissions.allowedDomains,
            source: permissions.source,
            lastSyncedAt: new Date().toISOString(),
          },
          content: texts[batchIdx],
        }));

        // Upsert to vector store
        await vectorStore.upsert(vectorIndexName, vectorRecords);

        // Update chunk records with vectorId, status, and pipelineId (T12)
        const bulkOps = batch.map((chunk) => ({
          updateOne: {
            filter: { _id: chunk._id },
            update: {
              $set: {
                vectorId: chunk._id, // Using chunk ID as vector ID
                status: ChunkStatus.INDEXED,
                ...(pipelineId ? { pipelineId } : {}),
              },
            },
          },
        }));
        await SearchChunk.bulkWrite(bulkOps);

        processedCount += batch.length;

        // Report progress
        const progress = Math.round((processedCount / chunks.length) * 100);
        await job.updateProgress(progress);

        workerLog('embedding', `Embedded batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}`, {
          documentId,
          batchSize: batch.length,
          totalTokens: result.totalTokens,
        });

        // Publish progress event if this document is from a crawl job
        const crawlJobId = document.sourceMetadata?.crawlJobId;
        if (crawlJobId) {
          await publishProgressEvent({
            type: 'chunk_created',
            jobId: crawlJobId,
            timestamp: new Date().toISOString(),
            data: {
              url: document.originalReference || '',
              documentId,
              progress: {
                total: chunks.length,
                completed: processedCount,
                failed: 0,
                percentage: progress,
              },
            },
          });
        }
      }

      // ── 5. Embed questions (if enabled per-index and questions exist) ──────────────
      const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
      if (
        llmConfig.useCases.questionSynthesis.enabled &&
        llmConfig.useCases.questionSynthesis.enableEmbedding
      ) {
        try {
          // If this is a reindex (dimension change), mark all questions as pending for re-embedding
          if (mode === 'reindex') {
            const markedResult = await ChunkQuestion.updateMany(
              { documentId, indexId, tenantId, status: 'indexed' },
              { $set: { status: 'pending' } },
            );
            if (markedResult.modifiedCount > 0) {
              workerLog(
                'embedding',
                `Marked ${markedResult.modifiedCount} questions as pending for re-embedding (reindex mode)`,
                { documentId, batchId },
              );
            }
          }

          const questions = await ChunkQuestion.find({
            documentId,
            indexId,
            tenantId,
            status: 'pending',
          }).sort({ chunkId: 1, questionIndex: 1 });

          if (questions.length > 0) {
            workerLog(
              'embedding',
              `Embedding ${questions.length} questions for document ${documentId}`,
            );

            // Process questions in batches
            let questionProcessedCount = 0;

            for (let i = 0; i < questions.length; i += EMBEDDING_BATCH_SIZE) {
              const batch = questions.slice(i, i + EMBEDDING_BATCH_SIZE);
              const questionTexts = batch.map((q) => q.question);

              // Generate embeddings
              const result = await embeddingProvider.embedBatch(questionTexts);

              // Build vector records for questions
              const questionVectorRecords: VectorRecord[] = batch.map((question, batchIdx) => ({
                id: question._id,
                vector: result.embeddings[batchIdx],
                metadata: {
                  // System metadata
                  sys: {
                    tenantId,
                    appId: indexId,
                    connectorId: document.sourceId,
                    documentId,
                    chunkId: question.chunkId || null,
                    questionId: question._id,
                    questionScope: question.scope, // 'chunk' or 'document'
                  },
                  // Question metadata
                  question: {
                    type: question.questionType,
                    confidence: question.confidence,
                    scope: question.scope,
                  },
                  // Canonical metadata (for filtering)
                  canonical: {}, // Empty for now, could be populated from chunk
                },
                // Permissions metadata (same as parent document)
                permissions: {
                  publicEverywhere: permissions.publicEverywhere,
                  publicInDomain: permissions.publicInDomain,
                  allowedUsers: permissions.allowedUsers,
                  allowedGroups: permissions.allowedGroups,
                  allowedDomains: permissions.allowedDomains,
                  source: permissions.source,
                  lastSyncedAt: new Date().toISOString(),
                },
                content: question.question,
              }));

              // Upsert to vector store
              workerLog('embedding', `Upserting ${questionVectorRecords.length} question vectors`, {
                documentId,
                vectorIndexName,
                questionIds: questionVectorRecords.map((v) => v.id),
              });
              await vectorStore.upsert(vectorIndexName, questionVectorRecords);

              workerLog(
                'embedding',
                `Successfully upserted ${questionVectorRecords.length} question vectors`,
                {
                  documentId,
                },
              );

              // Update question records with vectorId and status
              const questionBulkOps = batch.map((question) => ({
                updateOne: {
                  filter: { _id: question._id },
                  update: {
                    $set: {
                      vectorId: question._id, // Using question ID as vector ID
                      status: 'indexed',
                    },
                  },
                },
              }));
              await ChunkQuestion.bulkWrite(questionBulkOps);

              questionProcessedCount += batch.length;

              workerLog(
                'embedding',
                `Embedded question batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}`,
                {
                  documentId,
                  batchSize: batch.length,
                  totalTokens: result.totalTokens,
                },
              );
            }

            workerLog('embedding', `Embedded ${questionProcessedCount} questions successfully`);
          }
        } catch (error) {
          workerError('embedding', `Failed to embed questions for document ${documentId}`, error);
          // Don't fail the job - questions are optional
        }
      }

      // ── 6. Mark document as indexed ─────────────────────────────────────
      logStatusTransition({
        documentId,
        indexId,
        tenantId,
        fromStatus: DocumentStatus.EMBEDDING,
        toStatus: DocumentStatus.INDEXED,
        worker: 'embedding',
        timestamp: new Date(),
        metadata: { chunkCount: chunks.length },
      });

      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.INDEXED,
          lastIndexedAt: new Date(),
        },
      );

      // ── 7. Update index stats ───────────────────────────────────────────
      // Only increment chunkCount if the document was not already indexed
      // (prevents double-counting on re-embedding)
      // wasAlreadyIndexed was captured earlier before status was changed to EMBEDDING
      const now = new Date();
      if (wasAlreadyIndexed) {
        await Promise.all([
          SearchIndex.findOneAndUpdate(
            { _id: indexId, tenantId },
            {
              lastIndexedAt: now,
            },
          ),
          KnowledgeBase.findOneAndUpdate(
            { searchIndexId: indexId, tenantId },
            {
              lastIndexedAt: now,
            },
          ),
        ]);
      } else {
        await Promise.all([
          SearchIndex.findOneAndUpdate(
            { _id: indexId, tenantId },
            {
              $inc: { chunkCount: chunks.length },
              lastIndexedAt: now,
            },
          ),
          KnowledgeBase.findOneAndUpdate(
            { searchIndexId: indexId, tenantId },
            {
              lastIndexedAt: now,
            },
          ),
        ]);
      }

      workerLog('embedding', `Document ${documentId} fully indexed`, {
        indexId,
        chunkCount: chunks.length,
      });

      // Publish per-document event so frontend receives instant real-time update
      await publishProgressEvent({
        type: 'document_processed',
        jobId: String(indexId),
        timestamp: new Date().toISOString(),
        data: {
          documentId: String(documentId),
        },
      });

      // Deliver webhook notification for public ingestion API consumers
      try {
        const { deliverDocumentWebhook } =
          await import('../services/ingestion/webhook-delivery.js');
        await deliverDocumentWebhook(String(documentId), {
          event: 'document.indexed',
          documentId: String(documentId),
          indexId: String(indexId),
          tenantId,
          status: 'indexed',
          pageCount: document.pageCount ?? 0,
          chunkCount: chunks.length,
          completedAt: new Date().toISOString(),
        });
      } catch (webhookErr) {
        workerLog('embedding', 'Webhook delivery failed (non-critical)', {
          documentId,
          error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
        });
      }

      // ── 8. Check if CrawlJob is complete ─────────────────────────────────
      const crawlJobId = document.sourceMetadata?.crawlJobId;
      if (crawlJobId) {
        const { CrawlJob } = getModels();

        // Atomically increment the indexed count and check completion
        const updatedJob = await CrawlJob.findOneAndUpdate(
          { _id: crawlJobId, tenantId },
          {
            $inc: { 'results.documentsIndexed': 1 },
          },
          { new: true },
        );

        if (updatedJob) {
          const totalDocs = (updatedJob as any).results?.documentsCreated || 0;
          const indexedDocs = (updatedJob as any).results?.documentsIndexed || 0;
          const failedDocs = (updatedJob as any).results?.documentsFailed || 0;

          // Check if all documents are now processed
          if (indexedDocs + failedDocs >= totalDocs && totalDocs > 0) {
            await CrawlJob.findOneAndUpdate(
              { _id: crawlJobId, tenantId, status: { $ne: 'completed' } },
              {
                $set: {
                  status: 'completed',
                  'timeline.completedAt': new Date(),
                },
              },
            );

            // Publish completion event
            await publishProgressEvent({
              type: 'job_completed',
              jobId: crawlJobId,
              timestamp: new Date().toISOString(),
              data: {
                progress: {
                  total: totalDocs,
                  completed: indexedDocs,
                  failed: failedDocs,
                  percentage: 100,
                },
              },
            });

            workerLog('embedding', `CrawlJob ${crawlJobId} marked as completed`, {
              documentsIndexed: indexedDocs,
              documentsCreated: totalDocs,
            });
          }
        }
      }

      // ── 9. Transition SearchIndex "rebuilding" → "active" when all docs done ─
      // After each document finishes, check if the index is in "rebuilding" state
      // and all documents have reached terminal status (indexed/error). If so,
      // atomically transition to "active" and publish a WebSocket event so the
      // frontend can stop polling immediately (event-driven, not timer-based).
      try {
        const currentIndex = await SearchIndex.findOne({ _id: indexId, tenantId }).lean();
        if (currentIndex && (currentIndex as any).status === 'rebuilding') {
          const pendingCount = await SearchDocument.countDocuments({
            indexId,
            tenantId,
            status: {
              $nin: [DocumentStatus.INDEXED, DocumentStatus.ERROR],
            },
          });

          if (pendingCount === 0) {
            await SearchIndex.findOneAndUpdate(
              { _id: indexId, tenantId, status: 'rebuilding' },
              { $set: { status: 'active' } },
            );

            // Publish event so frontend receives real-time notification
            await publishProgressEvent({
              type: 'job_completed',
              jobId: String(indexId),
              timestamp: new Date().toISOString(),
              data: {
                progress: {
                  total: await SearchDocument.countDocuments({ indexId, tenantId }),
                  completed: await SearchDocument.countDocuments({
                    indexId,
                    tenantId,
                    status: DocumentStatus.INDEXED,
                  }),
                  failed: await SearchDocument.countDocuments({
                    indexId,
                    tenantId,
                    status: DocumentStatus.ERROR,
                  }),
                  percentage: 100,
                },
              },
            });

            workerLog('embedding', `SearchIndex ${indexId} transitioned rebuilding → active`, {
              tenantId,
            });
          }
        }
      } catch (statusErr) {
        // Non-critical: status transition failure doesn't affect the indexing result
        workerError('embedding', 'Failed to check/transition index status', statusErr);
      }

      // Clear permission resolver cache after this document is fully embedded
      // to prevent unbounded memory growth across jobs (singleton resolver).
      try {
        const permissionResolver = getDocumentPermissionResolver();
        permissionResolver.clearCache();
      } catch {
        // Non-critical: cache clear failure doesn't affect indexing
      }

      logJobCompletion({
        worker: 'embedding',
        jobId: job.id || 'unknown',
        documentId,
        status: 'completed',
        durationMs: Date.now() - jobStartMs,
        timestamp: new Date(),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      logStatusTransition({
        documentId,
        indexId,
        tenantId,
        fromStatus: DocumentStatus.EMBEDDING,
        toStatus: DocumentStatus.ERROR,
        worker: 'embedding',
        timestamp: new Date(),
        metadata: { error: errMsg },
      });

      await SearchDocument.findOneAndUpdate(
        { _id: documentId, tenantId },
        {
          status: DocumentStatus.ERROR,
          processingError: `Embedding failed: ${errMsg}`,
        },
      );

      // Deliver webhook notification on error for public ingestion API consumers
      try {
        const { deliverDocumentWebhook } =
          await import('../services/ingestion/webhook-delivery.js');
        await deliverDocumentWebhook(String(documentId), {
          event: 'document.error',
          documentId: String(documentId),
          indexId: String(indexId),
          tenantId,
          status: 'error',
          error: `Embedding failed: ${errMsg}`,
          completedAt: new Date().toISOString(),
        });
      } catch (webhookErr) {
        workerLog('embedding', 'Webhook delivery on error failed (non-critical)', {
          documentId,
          error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
        });
      }

      // Update crawl job failure count if this document is from a crawl
      const document = await SearchDocument.findOne({ _id: documentId, tenantId });
      const crawlJobId = document?.sourceMetadata?.crawlJobId;
      if (crawlJobId) {
        try {
          const { CrawlJob } = getModels();
          await CrawlJob.findOneAndUpdate(
            { _id: crawlJobId, tenantId },
            {
              $inc: { 'results.documentsFailed': 1 },
            },
          );
        } catch (err) {
          workerError('embedding', 'Failed to update crawl job failure count', err);
        }
      }

      // Mark affected chunks as error
      await SearchChunk.updateMany(
        { _id: { $in: chunkIds }, indexId, status: { $ne: ChunkStatus.INDEXED } },
        { $set: { status: ChunkStatus.ERROR } },
      );

      logJobCompletion({
        worker: 'embedding',
        jobId: job.id || 'unknown',
        documentId,
        status: 'failed',
        durationMs: Date.now() - jobStartMs,
        timestamp: new Date(),
        error: errMsg,
      });

      throw error;
    }
  });
}

// =============================================================================
// WORKER FACTORY
// =============================================================================

/**
 * Create and return the embedding worker.
 *
 * @param concurrency — max parallel embedding jobs (default 3, limited by API rate)
 */
export default function createEmbeddingWorker(concurrency = 3): Worker<EmbeddingJobData> {
  const worker = new Worker<EmbeddingJobData>(
    QUEUE_EMBEDDING,
    processEmbeddingJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('embedding', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('embedding', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('embedding', 'Worker error', err);
  });

  workerLog('embedding', `Started with concurrency=${concurrency}`);
  return worker;
}

/**
 * Close singleton provider connections. Call on shutdown.
 */
export async function closeEmbeddingProviders(): Promise<void> {
  if (_vectorStore) {
    await _vectorStore.close();
    _vectorStore = null;
  }
  if (_embeddingProvider) {
    // Check if provider has close method
    if (typeof _embeddingProvider.close === 'function') {
      await _embeddingProvider.close();
    }
    _embeddingProvider = null;
  }
}
