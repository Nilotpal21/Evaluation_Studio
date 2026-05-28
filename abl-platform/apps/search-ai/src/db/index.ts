/**
 * SearchAI Database Layer
 *
 * Dual-database setup:
 * - Platform DB (abl_platform): Application config, KB metadata
 * - Content DB (search_ai): Search content, chunks, documents
 */

import { SearchAIDualConnection } from './dual-connection.js';
import { ModelRegistry, type MongoDBConfig } from '@agent-platform/database';
import { registerTenantContextProvider } from '@agent-platform/database/mongo';
import { getTenantContextData } from '@agent-platform/shared-auth';
import { configureIndexRegistryModels } from '@agent-platform/search-ai-internal';
import type { Model } from 'mongoose';
import { ensureSearchAIAuditTrailHandlerRegistered } from '../services/search-ai-audit-trail-handler.js';

let dualConnection: SearchAIDualConnection | null = null;
let boundModels: Record<string, Model<any>> = {};

/**
 * Initialize dual-database connections for SearchAI
 */
export async function initMongoBackend(config: {
  platformDb: MongoDBConfig;
  contentDb: MongoDBConfig;
}): Promise<void> {
  console.log('[SearchAI] Initializing dual-database connections...');

  // Register platform models that SearchAI needs
  // Must happen before binding to ensure ModelRegistry knows about them
  await Promise.all([
    // Auth models (User, TenantMember, Tenant) — needed by auth-repo for session resolution
    import('@agent-platform/database/models').then((mod) => {
      if (mod.User?.schema && !ModelRegistry.hasModel('User')) {
        ModelRegistry.registerModelDefinition('User', mod.User.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantMember?.schema && !ModelRegistry.hasModel('TenantMember')) {
        ModelRegistry.registerModelDefinition('TenantMember', mod.TenantMember.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.Tenant?.schema && !ModelRegistry.hasModel('Tenant')) {
        ModelRegistry.registerModelDefinition('Tenant', mod.Tenant.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.KnowledgeBase.schema && !ModelRegistry.hasModel('KnowledgeBase')) {
        ModelRegistry.registerModelDefinition(
          'KnowledgeBase',
          mod.KnowledgeBase.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.SearchIndex.schema && !ModelRegistry.hasModel('SearchIndex')) {
        ModelRegistry.registerModelDefinition('SearchIndex', mod.SearchIndex.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantLLMPolicy.schema && !ModelRegistry.hasModel('TenantLLMPolicy')) {
        ModelRegistry.registerModelDefinition(
          'TenantLLMPolicy',
          mod.TenantLLMPolicy.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.LLMCredential.schema && !ModelRegistry.hasModel('LLMCredential')) {
        ModelRegistry.registerModelDefinition(
          'LLMCredential',
          mod.LLMCredential.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantModel?.schema && !ModelRegistry.hasModel('TenantModel')) {
        ModelRegistry.registerModelDefinition('TenantModel', mod.TenantModel.schema, 'platform');
      }
    }),
    // Connector models
    import('@agent-platform/database/models').then((mod) => {
      if (mod.ConnectorConfig?.schema && !ModelRegistry.hasModel('ConnectorConfig')) {
        ModelRegistry.registerModelDefinition(
          'ConnectorConfig',
          mod.ConnectorConfig.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.ConnectorDiscovery?.schema && !ModelRegistry.hasModel('ConnectorDiscovery')) {
        ModelRegistry.registerModelDefinition(
          'ConnectorDiscovery',
          mod.ConnectorDiscovery.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (
        mod.ConnectorRecommendation?.schema &&
        !ModelRegistry.hasModel('ConnectorRecommendation')
      ) {
        ModelRegistry.registerModelDefinition(
          'ConnectorRecommendation',
          mod.ConnectorRecommendation.schema,
          'platform',
        );
      }
    }),
    // SearchSource self-registers as 'searchaicontent' in its model file — no manual registration needed
    import('@agent-platform/database/models').then((mod) => {
      if (mod.EndUserOAuthToken?.schema && !ModelRegistry.hasModel('EndUserOAuthToken')) {
        ModelRegistry.registerModelDefinition(
          'EndUserOAuthToken',
          mod.EndUserOAuthToken.schema,
          'platform',
        );
      }
    }),
    // Sync operational models (search-ai only — connector sync state)
    import('@agent-platform/database').then((mod) => {
      if (mod.SyncCheckpoint?.schema && !ModelRegistry.hasModel('SyncCheckpoint')) {
        ModelRegistry.registerModelDefinition(
          'SyncCheckpoint',
          mod.SyncCheckpoint.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database').then((mod) => {
      if (mod.DriveDeltaToken?.schema && !ModelRegistry.hasModel('DriveDeltaToken')) {
        ModelRegistry.registerModelDefinition(
          'DriveDeltaToken',
          mod.DriveDeltaToken.schema,
          'searchaicontent',
        );
      }
    }),
    // Content models used by search-ai-internal (vector store index management)
    import('@agent-platform/database').then((mod) => {
      if (mod.IndexRegistry?.schema && !ModelRegistry.hasModel('IndexRegistry')) {
        ModelRegistry.registerModelDefinition(
          'IndexRegistry',
          mod.IndexRegistry.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database').then((mod) => {
      if (mod.SharedIndexTracker?.schema && !ModelRegistry.hasModel('SharedIndexTracker')) {
        ModelRegistry.registerModelDefinition(
          'SharedIndexTracker',
          mod.SharedIndexTracker.schema,
          'searchaicontent',
        );
      }
    }),
    // Crawler models (search-ai only — crawl execution data)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.CrawlJob?.schema && !ModelRegistry.hasModel('CrawlJob')) {
        ModelRegistry.registerModelDefinition('CrawlJob', mod.CrawlJob.schema, 'searchaicontent');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.CrawlError?.schema && !ModelRegistry.hasModel('CrawlError')) {
        ModelRegistry.registerModelDefinition(
          'CrawlError',
          mod.CrawlError.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if ((mod as any).CrawlHistory?.schema && !ModelRegistry.hasModel('CrawlHistory')) {
        ModelRegistry.registerModelDefinition(
          'CrawlHistory',
          (mod as any).CrawlHistory.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.UserCrawlPreference?.schema && !ModelRegistry.hasModel('UserCrawlPreference')) {
        ModelRegistry.registerModelDefinition(
          'UserCrawlPreference',
          mod.UserCrawlPreference.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.CrawlPattern?.schema && !ModelRegistry.hasModel('CrawlPattern')) {
        ModelRegistry.registerModelDefinition(
          'CrawlPattern',
          mod.CrawlPattern.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.HandlerTemplate?.schema && !ModelRegistry.hasModel('HandlerTemplate')) {
        ModelRegistry.registerModelDefinition(
          'HandlerTemplate',
          mod.HandlerTemplate.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantCrawlPolicy?.schema && !ModelRegistry.hasModel('TenantCrawlPolicy')) {
        ModelRegistry.registerModelDefinition(
          'TenantCrawlPolicy',
          mod.TenantCrawlPolicy.schema,
          'platform',
        );
      }
    }),
    // Discovery models (site-level + tenant-level discovery data)
    import('@agent-platform/database/models').then((mod) => {
      if ((mod as any).SiteDiscovery?.schema && !ModelRegistry.hasModel('SiteDiscovery')) {
        ModelRegistry.registerModelDefinition(
          'SiteDiscovery',
          (mod as any).SiteDiscovery.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if ((mod as any).TenantDiscovery?.schema && !ModelRegistry.hasModel('TenantDiscovery')) {
        ModelRegistry.registerModelDefinition(
          'TenantDiscovery',
          (mod as any).TenantDiscovery.schema,
          'searchaicontent',
        );
      }
    }),
    // Pipeline configuration models (search-ai only)
    import('@agent-platform/database/models').then((mod) => {
      if (
        mod.SearchPipelineDefinition?.schema &&
        !ModelRegistry.hasModel('SearchPipelineDefinition')
      ) {
        ModelRegistry.registerModelDefinition(
          'SearchPipelineDefinition',
          mod.SearchPipelineDefinition.schema,
          'searchaicontent',
        );
      }
    }),
    // Content models used by workers (page-processing, embedding, question-synthesis)
    import('@agent-platform/database/models').then((mod) => {
      if ((mod as any).ChunkQuestion?.schema && !ModelRegistry.hasModel('ChunkQuestion')) {
        ModelRegistry.registerModelDefinition(
          'ChunkQuestion',
          (mod as any).ChunkQuestion.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if ((mod as any).DocumentPage?.schema && !ModelRegistry.hasModel('DocumentPage')) {
        ModelRegistry.registerModelDefinition(
          'DocumentPage',
          (mod as any).DocumentPage.schema,
          'searchaicontent',
        );
      }
    }),
    // Knowledge Graph Domain model
    import('@agent-platform/database/models').then((mod) => {
      if (
        (mod as any).KnowledgeGraphDomain?.schema &&
        !ModelRegistry.hasModel('KnowledgeGraphDomain')
      ) {
        ModelRegistry.registerModelDefinition(
          'KnowledgeGraphDomain',
          (mod as any).KnowledgeGraphDomain.schema,
          'searchaicontent',
        );
      }
    }),
    // Canonical mapping models (LLM-generated runtime data used by ingestion + query pipeline)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.ConnectorSchema?.schema && !ModelRegistry.hasModel('ConnectorSchema')) {
        ModelRegistry.registerModelDefinition(
          'ConnectorSchema',
          mod.ConnectorSchema.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.FieldMapping?.schema && !ModelRegistry.hasModel('FieldMapping')) {
        ModelRegistry.registerModelDefinition(
          'FieldMapping',
          mod.FieldMapping.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.CanonicalSchema?.schema && !ModelRegistry.hasModel('CanonicalSchema')) {
        ModelRegistry.registerModelDefinition(
          'CanonicalSchema',
          mod.CanonicalSchema.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.DomainVocabulary?.schema && !ModelRegistry.hasModel('DomainVocabulary')) {
        ModelRegistry.registerModelDefinition(
          'DomainVocabulary',
          mod.DomainVocabulary.schema,
          'searchaicontent',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (
        (mod as any).VocabularyCandidates?.schema &&
        !ModelRegistry.hasModel('VocabularyCandidates')
      ) {
        ModelRegistry.registerModelDefinition(
          'VocabularyCandidates',
          (mod as any).VocabularyCandidates.schema,
          'searchaicontent',
        );
      }
    }),
    // ProjectTool model (used by searchai-tool-registration to auto-register KB tools)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.ProjectTool?.schema && !ModelRegistry.hasModel('ProjectTool')) {
        ModelRegistry.registerModelDefinition('ProjectTool', mod.ProjectTool.schema, 'platform');
      }
    }),
  ]);

  console.log('[SearchAI] Platform models registered for dual-database binding');

  // Initialize dual connections
  dualConnection = await SearchAIDualConnection.initialize({
    platformDb: config.platformDb,
    contentDb: config.contentDb,
  });

  // Bridge shared-auth ALS → Mongoose tenant isolation plugin.
  // This makes the Mongoose plugin auto-inject tenantId from the same context
  // set by unified auth middleware, so REST route handlers don't need explicit
  // withTenantContext() calls. Workers still use withTenantContext() directly.
  registerTenantContextProvider(() => {
    const ctx = getTenantContextData();
    if (!ctx) return undefined;
    return { tenantId: ctx.tenantId, isSuperAdmin: ctx.isSuperAdmin };
  });

  // Bind all models to their appropriate connections
  boundModels = ModelRegistry.bindModelsForSearchAI(
    dualConnection.getPlatformConnection(),
    dualConnection.getContentConnection(),
  );

  ensureSearchAIAuditTrailHandlerRegistered();

  // Configure search-ai-internal's index-registry with bound models
  configureIndexRegistryModels({
    IndexRegistry: boundModels['IndexRegistry'],
    SharedIndexTracker: boundModels['SharedIndexTracker'],
  });

  const platformModelCount = ModelRegistry.getPlatformModels().length;
  const contentModelCount = ModelRegistry.getSearchAIContentModels().length;

  console.log('[SearchAI] Models bound to dual databases', {
    platformModels: platformModelCount,
    contentModels: contentModelCount,
    totalModels: Object.keys(boundModels).length,
  });

  // Debug: Log what models are on each connection
  const platformConn = dualConnection.getPlatformConnection();
  const contentConn = dualConnection.getContentConnection();
  console.log('[SearchAI] Platform connection models:', Object.keys(platformConn.models));
  console.log('[SearchAI] Content connection models:', Object.keys(contentConn.models));

  // Verify connections are ready by performing a test query
  try {
    const SearchIndex = boundModels['SearchIndex'];
    if (SearchIndex) {
      await SearchIndex.findOne({}).limit(1).maxTimeMS(5000).lean().exec();
      console.log('[SearchAI] Platform DB connection verified (SearchIndex query succeeded)');
    }
  } catch (err) {
    console.warn(
      '[SearchAI] Platform DB verification query failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const SearchDocument = boundModels['SearchDocument'];
    if (SearchDocument) {
      await SearchDocument.findOne({}).limit(1).maxTimeMS(5000).lean().exec();
      console.log('[SearchAI] Content DB connection verified (SearchDocument query succeeded)');
    }
  } catch (err) {
    console.warn(
      '[SearchAI] Content DB verification query failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  console.log('[SearchAI] Dual-database initialization complete');
}

/**
 * Get a model bound to the correct database
 *
 * Usage:
 *   const KnowledgeBase = getModel('KnowledgeBase'); // → abl_platform
 *   const SearchChunk = getModel('SearchChunk');     // → search_ai
 *
 * @throws Error if model not found in registry
 */
export function getModel<T = any>(modelName: string): Model<T> {
  const model = boundModels[modelName];

  if (!model) {
    const availableModels = Object.keys(boundModels).join(', ');
    console.error(`[getModel] Model "${modelName}" not found. Available:`, availableModels);
    console.error(`[getModel] boundModels keys:`, Object.keys(boundModels));
    console.error(`[getModel] ModelRegistry has model:`, ModelRegistry.hasModel(modelName));
    throw new Error(
      `Model "${modelName}" not found in registry. ` +
        `Available models: ${availableModels || 'none'}. ` +
        `Ensure the model is registered with ModelRegistry.`,
    );
  }

  return model;
}

/**
 * Get a lazy model accessor that defers model retrieval until first use.
 * Use this for module-scope model declarations to avoid initialization order issues.
 *
 * Usage:
 *   const SearchChunk = getLazyModel<ISearchChunk>('SearchChunk');
 *   // Model is retrieved on first method call, not at import time
 */
export function getLazyModel<T = any>(modelName: string): Model<T> {
  let cachedModel: Model<T> | null = null;

  return new Proxy({} as Model<T>, {
    get(_target, prop) {
      if (!cachedModel) {
        cachedModel = getModel<T>(modelName);
        console.log(
          `[getLazyModel] Retrieved model "${modelName}", connection state:`,
          cachedModel.db?.readyState,
        );
      }
      const value = (cachedModel as any)[prop];
      return typeof value === 'function' ? value.bind(cachedModel) : value;
    },
  });
}

/**
 * Check if databases are available
 */
export function isDatabaseAvailable(): boolean {
  return SearchAIDualConnection.isAvailable();
}

/**
 * Get health status for both databases
 */
export async function getDatabaseHealth(): Promise<{
  platform: boolean;
  content: boolean;
  ok: boolean;
}> {
  if (!dualConnection) {
    return { platform: false, content: false, ok: false };
  }
  return dualConnection.healthCheck();
}

/**
 * Disconnect both databases
 */
export async function disconnectDatabase(): Promise<void> {
  if (dualConnection) {
    console.log('[SearchAI] Disconnecting dual databases...');
    await dualConnection.disconnect();
    dualConnection = null;
    boundModels = {};
    console.log('[SearchAI] Dual databases disconnected');
  }
}

/**
 * Get dual connection instance (for advanced usage)
 */
export function getDualConnection(): SearchAIDualConnection {
  if (!dualConnection) {
    throw new Error('SearchAIDualConnection not initialized. Call initMongoBackend() first.');
  }
  return dualConnection;
}
