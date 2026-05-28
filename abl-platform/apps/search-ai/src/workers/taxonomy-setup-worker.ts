/**
 * Taxonomy Setup Worker
 *
 * Handles one-time taxonomy setup for an index. Loads domain definitions from
 * system, parses customer organization profile (markdown with LLM), merges,
 * validates, stores in MongoDB, and creates Neo4j graph structure.
 *
 * Queue: taxonomy-setup
 * Job data: TaxonomySetupJobData
 *
 * Workflow:
 * 1. Load domain definition files (pre-defined JSON in system)
 * 2. Load organization profile (customer-provided markdown)
 * 3. Parse organization profile with LLM (Sonnet, ~$0.01 per setup)
 * 4. Merge domain definitions with organization context
 * 5. Validate taxonomy structure
 * 6. Store in MongoDB (knowledge_graph_taxonomy collection)
 * 7. Create Neo4j graph structure (domain → categories → products)
 */

import { Worker, type Job } from 'bullmq';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  type TaxonomySetupJobData,
} from './shared.js';
import { TaxonomyLoaderService } from '../services/taxonomy-loader.service.js';
import { TaxonomyGraphService } from '../services/knowledge-graph/taxonomy-graph.service.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import { resolveIndexLLMConfig } from '../services/llm-config/resolver.js';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getConfig } from '../config/index.js';

const WORKER_NAME = 'taxonomy-setup';

/**
 * Process taxonomy setup job
 */
async function processTaxonomySetupJob(job: Job<TaxonomySetupJobData>): Promise<{
  success: boolean;
  taxonomyId?: string;
  version?: string;
  domains?: string[];
  productsCount?: number;
  attributesCount?: number;
  error?: string;
}> {
  const {
    indexId,
    tenantId,
    domainDefinitionPaths,
    organizationProfilePath,
    organizationProfile,
    version,
  } = job.data;

  workerLog(WORKER_NAME, 'Processing taxonomy setup job', {
    jobId: job.id,
    indexId,
    tenantId,
    domainDefinitionPaths,
    organizationProfilePath,
  });

  try {
    // Run in tenant context for database isolation
    return await withTenantContext({ tenantId }, async () => {
      // Update progress: Starting
      await job.updateProgress(0);

      // Initialize services with per-index resolved LLM credentials
      const llmConfig = await resolveIndexLLMConfig(tenantId, indexId);
      const kgConfig = llmConfig.useCases.knowledgeGraph;
      const llmClient = new WorkerLLMClient(kgConfig.provider, kgConfig.apiKey, kgConfig.model);

      const taxonomyLoader = new TaxonomyLoaderService(llmClient);

      const config = getConfig();
      const taxonomyGraph = new TaxonomyGraphService(config.knowledgeGraph);

      // Connect to Neo4j
      await taxonomyGraph.connect();

      try {
        // Update progress: Loading taxonomy
        await job.updateProgress(20);

        // Bridge OrgProfile (LLM-generated) to OrganizationProfile format if needed
        let resolvedOrgProfile = organizationProfile;
        if (organizationProfile) {
          const { safeValidateOrgProfile } = await import('../schemas/org-profile.schema.js');
          const parsed = safeValidateOrgProfile(organizationProfile);
          if (parsed.success) {
            const { bridgeOrgProfileToContext } = await import('../services/org-profile-bridge.js');
            const domainDefs = await taxonomyLoader.loadDomainDefinitions(
              domainDefinitionPaths,
              tenantId,
            );
            resolvedOrgProfile = bridgeOrgProfileToContext(parsed.data, domainDefs);
          }
        }

        // Load taxonomy from domain definitions + organization profile
        // This includes LLM parsing of markdown organization profile
        const taxonomyDoc = await taxonomyLoader.loadTaxonomy({
          tenantId,
          indexId,
          domainDefinitionPaths,
          organizationProfilePath,
          organizationProfile: resolvedOrgProfile,
          version,
        });

        workerLog(WORKER_NAME, 'Taxonomy loaded and validated', {
          jobId: job.id,
          indexId,
          version: taxonomyDoc.version,
          domains: taxonomyDoc.domains,
          productsCount: taxonomyDoc.taxonomy.products.length,
          attributesCount: taxonomyDoc.taxonomy.attributes.length,
        });

        // Update progress: Saving to MongoDB
        await job.updateProgress(50);

        // Save taxonomy to MongoDB (upsert)
        const taxonomyId = await taxonomyLoader.saveTaxonomy(taxonomyDoc);

        workerLog(WORKER_NAME, 'Taxonomy saved to MongoDB', {
          jobId: job.id,
          taxonomyId,
        });

        // Step: Seed AttributeRegistry with permanent attributes
        // This ensures the registry is the single source of truth for all tiers.
        // Reconciliation (Sprint 5) matches novel candidates against permanent attrs.
        const { AttributeRegistry } = await import('@agent-platform/database/models');

        const seedOps = [];
        // All product IDs for seeding universal attributes (applicableTo=[])
        const allProductIds = taxonomyDoc.taxonomy.products.map((p: { id: string }) => p.id);
        for (const attr of taxonomyDoc.taxonomy.attributes) {
          // Expand product-qualified entries: one per applicableTo product (Amendment #1)
          // Empty applicableTo means "all products" per domain-definition schema
          const targetProducts = attr.applicableTo.length > 0 ? attr.applicableTo : allProductIds;
          for (const product of targetProducts) {
            seedOps.push(
              AttributeRegistry.findOneAndUpdate(
                {
                  tenantId,
                  indexId,
                  attributeId: attr.id,
                  productScope: product,
                },
                {
                  $setOnInsert: {
                    tier: 'permanent',
                    displayName: attr.name,
                    dataType: attr.dataType,
                    discoverySource: 'domain_definition',
                    firstSeenAt: new Date(),
                  },
                  $set: {
                    aliases: attr.extraction?.keywords || [],
                    extractionPatterns: attr.extraction?.patterns || [],
                    typicalRange: attr.organizationContext?.typicalRange,
                    lastSeenAt: new Date(),
                  },
                },
                { upsert: true },
              ),
            );
          }
        }

        await Promise.all(seedOps);
        workerLog(WORKER_NAME, 'AttributeRegistry seeded with permanent attributes', {
          attributeCount: taxonomyDoc.taxonomy.attributes.length,
          totalEntries: seedOps.length,
        });

        // Update progress: Creating Neo4j graph
        await job.updateProgress(70);

        // Create taxonomy graph in Neo4j
        // This creates: Domain → Category → Product nodes + relationships
        await taxonomyGraph.createTaxonomyGraph(tenantId, indexId, taxonomyDoc.taxonomy);

        workerLog(WORKER_NAME, 'Taxonomy graph created in Neo4j', {
          jobId: job.id,
          categoriesCount: taxonomyDoc.taxonomy.categories.length,
          productsCount: taxonomyDoc.taxonomy.products.length,
        });

        // Write taxonomy to Redis cache for runtime reads
        try {
          const { getTaxonomyCacheWriter } = await import('../services/taxonomy-cache-writer.js');
          const cacheWriter = getTaxonomyCacheWriter();
          const savedTaxonomy = await taxonomyLoader.getTaxonomy(tenantId, indexId);
          if (savedTaxonomy) {
            await cacheWriter.writeTaxonomy(tenantId, indexId, savedTaxonomy);
          }
        } catch (cacheError) {
          workerLog(
            WORKER_NAME,
            'Failed to write taxonomy cache — runtime will fall back to MongoDB',
            {
              error: cacheError instanceof Error ? cacheError.message : String(cacheError),
            },
          );
        }

        // Update progress: Complete
        await job.updateProgress(100);

        return {
          success: true,
          taxonomyId,
          version: taxonomyDoc.version,
          domains: taxonomyDoc.domains,
          productsCount: taxonomyDoc.taxonomy.products.length,
          attributesCount: taxonomyDoc.taxonomy.attributes.length,
        };
      } finally {
        // Cleanup Neo4j connection
        await taxonomyGraph.close();
      }
    });
  } catch (error) {
    workerError(WORKER_NAME, 'Taxonomy setup failed', error);

    // Return error result
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create and start taxonomy setup worker
 */
export default function createTaxonomySetupWorker(concurrency = 1): Worker {
  const worker = new Worker(
    'taxonomy-setup',
    async (job: Job<TaxonomySetupJobData>) => {
      return await processTaxonomySetupJob(job);
    },
    {
      ...createWorkerOptions(concurrency),
      // Taxonomy setup is CPU/LLM-intensive — limit concurrency
      concurrency,
    },
  );

  // Event listeners for monitoring
  worker.on('completed', (job) => {
    workerLog(WORKER_NAME, 'Job completed', {
      jobId: job.id,
      returnvalue: job.returnvalue,
    });
  });

  worker.on('failed', (job, err) => {
    workerError(
      WORKER_NAME,
      `Job failed: ${job?.id || 'unknown'}`,
      err instanceof Error ? err : new Error(String(err)),
    );
  });

  worker.on('error', (err) => {
    workerError(WORKER_NAME, 'Worker error', err);
  });

  workerLog(WORKER_NAME, `Worker started with concurrency=${concurrency}`);

  return worker;
}
