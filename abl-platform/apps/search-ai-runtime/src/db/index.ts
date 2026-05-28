/**
 * SearchAI Runtime Database Layer
 *
 * Dual-database setup:
 * - Platform DB (abl_platform): SearchIndex, TenantModel, LLMCredential
 * - Content DB (search_ai): SearchChunk, CanonicalSchema, DomainVocabulary, CapabilityRegistry
 */

import { SearchAIDualConnection } from './dual-connection.js';
import { ModelRegistry, type MongoDBConfig } from '@agent-platform/database';
import type { Model } from 'mongoose';

let dualConnection: SearchAIDualConnection | null = null;
let boundModels: Record<string, Model<any>> = {};

/**
 * Initialize dual-database connections for SearchAI Runtime
 */
export async function initMongoBackend(config: {
  platformDb: MongoDBConfig;
  contentDb: MongoDBConfig;
}): Promise<void> {
  // Register platform models (abl_platform)
  await Promise.all([
    import('@agent-platform/database/models').then((mod) => {
      if (mod.SearchIndex?.schema && !ModelRegistry.hasModel('SearchIndex')) {
        ModelRegistry.registerModelDefinition('SearchIndex', mod.SearchIndex.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantModel?.schema && !ModelRegistry.hasModel('TenantModel')) {
        ModelRegistry.registerModelDefinition('TenantModel', mod.TenantModel.schema, 'platform');
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.LLMCredential?.schema && !ModelRegistry.hasModel('LLMCredential')) {
        ModelRegistry.registerModelDefinition(
          'LLMCredential',
          mod.LLMCredential.schema,
          'platform',
        );
      }
    }),
    import('@agent-platform/database/models').then((mod) => {
      if (mod.TenantLLMPolicy?.schema && !ModelRegistry.hasModel('TenantLLMPolicy')) {
        ModelRegistry.registerModelDefinition(
          'TenantLLMPolicy',
          mod.TenantLLMPolicy.schema,
          'platform',
        );
      }
    }),
    // Content models (search_ai)
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
      if (mod.CapabilityRegistry?.schema && !ModelRegistry.hasModel('CapabilityRegistry')) {
        ModelRegistry.registerModelDefinition(
          'CapabilityRegistry',
          mod.CapabilityRegistry.schema,
          'searchaicontent',
        );
      }
    }),
    // IndexRegistry for resolving indexId → OpenSearch index name
    import('@agent-platform/database').then((mod) => {
      if (mod.IndexRegistry?.schema && !ModelRegistry.hasModel('IndexRegistry')) {
        ModelRegistry.registerModelDefinition(
          'IndexRegistry',
          mod.IndexRegistry.schema,
          'searchaicontent',
        );
      }
    }),
    // AttributeRegistry for Browse SDK attribute metadata (platform DB — data written to abl_platform)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.AttributeRegistry?.schema && !ModelRegistry.hasModel('AttributeRegistry')) {
        ModelRegistry.registerModelDefinition(
          'AttributeRegistry',
          mod.AttributeRegistry.schema,
          'platform',
        );
      }
    }),
    // KnowledgeGraphTaxonomy for Browse SDK taxonomy fallback
    import('@agent-platform/database/models').then((mod) => {
      if (mod.KnowledgeGraphTaxonomy?.schema && !ModelRegistry.hasModel('KnowledgeGraphTaxonomy')) {
        ModelRegistry.registerModelDefinition(
          'KnowledgeGraphTaxonomy',
          mod.KnowledgeGraphTaxonomy.schema,
          'searchaicontent',
        );
      }
    }),
    // KnowledgeBase for embedding provider resolution (platform DB)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.KnowledgeBase?.schema && !ModelRegistry.hasModel('KnowledgeBase')) {
        ModelRegistry.registerModelDefinition(
          'KnowledgeBase',
          mod.KnowledgeBase.schema,
          'platform',
        );
      }
    }),
    // ProjectSettings for end-user auth configuration (platform DB)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.ProjectSettings?.schema && !ModelRegistry.hasModel('ProjectSettings')) {
        ModelRegistry.registerModelDefinition(
          'ProjectSettings',
          mod.ProjectSettings.schema,
          'platform',
        );
      }
    }),
    // AuthProfile for IdP OIDC configuration lookup (platform DB)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.AuthProfile?.schema && !ModelRegistry.hasModel('AuthProfile')) {
        ModelRegistry.registerModelDefinition('AuthProfile', mod.AuthProfile.schema, 'platform');
      }
    }),
    // Contact for end-user identity tracking (platform DB)
    import('@agent-platform/database/models').then((mod) => {
      if (mod.Contact?.schema && !ModelRegistry.hasModel('Contact')) {
        ModelRegistry.registerModelDefinition('Contact', mod.Contact.schema, 'platform');
      }
    }),
    // SearchPipelineDefinition for embedding provider resolution (content DB)
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
    // SearchChunk and SearchDocument self-register as 'searchaicontent' in their model files
    // SearchSource self-registers as 'searchaicontent' in its model file
  ]);

  // Initialize dual connections
  dualConnection = await SearchAIDualConnection.initialize({
    platformDb: config.platformDb,
    contentDb: config.contentDb,
  });

  // Bind all models to their appropriate connections
  boundModels = ModelRegistry.bindModelsForSearchAI(
    dualConnection.getPlatformConnection(),
    dualConnection.getContentConnection(),
  );
}

/**
 * Get a model bound to the correct database
 */
export function getModel<T = any>(modelName: string): Model<T> {
  const model = boundModels[modelName];
  if (!model) {
    const availableModels = Object.keys(boundModels).join(', ');
    throw new Error(
      `Model "${modelName}" not found in registry. Available models: ${availableModels || 'none'}.`,
    );
  }
  return model;
}

/**
 * Get a lazy model accessor that defers model retrieval until first use.
 * Use this for module-scope model declarations to avoid initialization order issues.
 */
export function getLazyModel<T = any>(modelName: string): Model<T> {
  let cachedModel: Model<T> | null = null;

  return new Proxy({} as Model<T>, {
    get(_target, prop) {
      if (!cachedModel) {
        cachedModel = getModel<T>(modelName);
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
 * Disconnect both databases
 */
export async function disconnectDatabase(): Promise<void> {
  if (dualConnection) {
    await dualConnection.disconnect();
    dualConnection = null;
    boundModels = {};
  }
}
