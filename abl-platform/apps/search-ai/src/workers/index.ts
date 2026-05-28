/**
 * Worker Orchestrator
 *
 * Initializes and starts all ingestion pipeline workers.
 * Call startWorkers() at server startup, stopWorkers() on shutdown.
 *
 * Pipeline: ingest --> extract --> canonical-map --> enrich --> embed
 */

import type { Worker } from 'bullmq';
import createIngestionWorker from './ingestion-worker.js';
import createExtractionWorker from './extraction-worker.js';
import createDoclingExtractionWorker from './docling-extraction-worker.js';
import createPageProcessingWorker from './page-processing-worker.js';
import createCanonicalMapperWorker from './canonical-mapper-worker.js';
import createEnrichmentWorker from './enrichment-worker.js';
import createEmbeddingWorker, { closeEmbeddingProviders } from './embedding-worker.js';
import createKGEnrichmentWorker from './kg-enrichment-worker.js';
import createTaxonomySetupWorker from './taxonomy-setup-worker.js';
import createMultiModalWorker from './multimodal-worker.js';
import { createTreeBuildingWorker } from './tree-building-worker.js';
import { createQuestionSynthesisWorker } from './question-synthesis-worker.js';
import { createScopeClassificationWorker } from './scope-classification-worker.js';
import { createVisualEnrichmentWorker } from './visual-enrichment-worker.js';
import { createStructuredDataIngestionWorker } from './structured-data-ingestion-worker.js';
import { createJSONRecordChunkingWorker } from './json-record-chunking-worker.js';
import createSchemaSyncWorker from './schema-sync-worker.js';
import createAzureADUserSyncWorker from './azuread-user-sync-worker.js';
import createAzureADGroupSyncWorker from './azuread-group-sync-worker.js';
import createOktaUserSyncWorker from './okta-user-sync-worker.js';
import createOktaGroupSyncWorker from './okta-group-sync-worker.js';
import createGoogleUserSyncWorker from './google-user-sync-worker.js';
import createGoogleGroupSyncWorker from './google-group-sync-worker.js';
import {
  startScheduler as startIdPSyncScheduler,
  stopScheduler as stopIdPSyncScheduler,
} from './idp-sync-scheduler.js';
import { connectorDiscoveryWorker } from './connector-discovery-worker.js';
import { connectorSyncWorker } from './connector-sync-worker.js';
import {
  startCrawlerIngestionWorker,
  getWorker as getCrawlerIngestionWorker,
} from './crawler-ingestion-worker.js';
import { createIntelligenceCrawlWorker } from './intelligence-crawl-worker.js';
import { workerLog } from './shared.js';
import { createVocabularyGenerationWorker } from './vocabulary-generation-worker.js';
import createSchemaDiscoveryWorker, {
  setDiscoveryServiceFactory,
} from './schema-discovery-worker.js';
import { createDiscoveryServiceFactory } from './schema-discovery-factory.js';
import createFieldMappingSuggestionWorker from './field-mapping-suggestion-worker.js';

// =============================================================================
// STATE
// =============================================================================

interface WorkerEntry {
  name: string;
  worker: Worker | { close: () => Promise<void>; isRunning: () => boolean };
}

let workers: WorkerEntry[] = [];

/**
 * Build worker entries for the two-queue Docling topology
 * (`search-docling-extraction` for ingestion + `workflow-docling-extraction`
 * for the workflow path). The workflow worker is constructed unconditionally
 * but only registered with the lifecycle layer when
 * `WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED=true` (LLD Phase 1 Task 1.9
 * and D-3 layer c — Phase 2 wiring).
 */
function buildDoclingWorkerEntries(_concurrency: number): WorkerEntry[] {
  const docling = createDoclingExtractionWorker();
  const entries: WorkerEntry[] = [{ name: 'docling-extraction', worker: docling.ingestion }];
  if (process.env.WORKFLOW_DOC_EXTRACTION_INTEGRATIONS_ENABLED === 'true') {
    entries.push({ name: 'docling-extraction-workflow', worker: docling.workflow });
  } else {
    // Flag off: close the workflow worker so its Redis subscription does not
    // leak. Failures during teardown are surfaced via workerError; not
    // re-thrown because this is a best-effort cleanup of a never-registered
    // worker at startup.
    docling.workflow.close().catch((err: unknown) => {
      workerLog('docling-extraction', 'Workflow Worker close (flag off) failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return entries;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialize and start all pipeline workers.
 *
 * @param concurrency — base concurrency for each worker.
 *   Ingestion and embedding use a lower concurrency by default since they are
 *   either I/O-bound (ingestion scans sources) or rate-limited (embedding APIs).
 *   Extraction, canonical-mapping, and enrichment use the full concurrency value.
 *   Knowledge graph, multi-modal, and embedding run in parallel after enrichment.
 */
export async function startWorkers(concurrency = 5): Promise<void> {
  if (workers.length > 0) {
    console.warn('[workers] Workers are already running — call stopWorkers() first');
    return;
  }

  console.log(`[workers] Starting ingestion pipeline workers (concurrency=${concurrency})`);

  // Wire schema discovery service factory before workers start processing jobs
  setDiscoveryServiceFactory(createDiscoveryServiceFactory());

  workers = [
    {
      name: 'ingestion',
      worker: createIngestionWorker(Math.max(Math.floor(concurrency * 0.6), 1)),
    },
    { name: 'extraction', worker: createExtractionWorker(concurrency) },
    ...buildDoclingWorkerEntries(concurrency),
    {
      name: 'page-processing',
      worker: createPageProcessingWorker(Math.max(Math.floor(concurrency * 0.8), 1)),
    },
    { name: 'canonical-mapper', worker: createCanonicalMapperWorker(concurrency) },
    {
      name: 'visual-enrichment',
      worker: createVisualEnrichmentWorker(Math.max(Math.floor(concurrency * 0.6), 1)),
    },
    { name: 'enrichment', worker: createEnrichmentWorker(concurrency) },
    {
      name: 'kg-enrichment',
      worker: createKGEnrichmentWorker(Math.max(Math.floor(concurrency * 0.5), 1)),
    },
    {
      name: 'taxonomy-setup',
      worker: createTaxonomySetupWorker(1), // Low concurrency — LLM + validation intensive
    },
    {
      name: 'multimodal',
      worker: createMultiModalWorker(Math.max(Math.floor(concurrency * 0.4), 1)),
    },
    {
      name: 'embedding',
      worker: createEmbeddingWorker(Math.max(Math.floor(concurrency * 0.6), 1)),
    },
    {
      name: 'structured-data-ingestion',
      worker: createStructuredDataIngestionWorker(),
    },
    {
      name: 'json-record-chunking',
      worker: createJSONRecordChunkingWorker(),
    },
    {
      name: 'schema-sync',
      worker: createSchemaSyncWorker(2), // Low concurrency — API calls to external systems
    },
    // Connector discovery worker
    {
      name: 'connector-discovery',
      worker: connectorDiscoveryWorker,
    },
    // Connector sync worker — processes document ingestion from enterprise connectors
    {
      name: 'connector-sync',
      worker: connectorSyncWorker,
    },
    // Vocabulary generation worker — generates domain vocabulary from critical fields
    {
      name: 'vocabulary-generation',
      worker: createVocabularyGenerationWorker(),
    },
    // Schema discovery worker — enriched discovery pipeline (Stories 1.1-1.7)
    {
      name: 'schema-discovery',
      worker: createSchemaDiscoveryWorker(2), // Low concurrency — API calls to external systems
    },
    // Field mapping suggestion worker — orchestrates rule-based + LLM mapping (Epic 2)
    {
      name: 'field-mapping-suggestion',
      worker: createFieldMappingSuggestionWorker(2), // Low concurrency — LLM-intensive
    },
  ];

  // Optional workers (gracefully skip if disabled or missing API keys)
  try {
    workers.push({ name: 'tree-building', worker: createTreeBuildingWorker() });
  } catch (error) {
    console.log(
      '[workers] Tree-building worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'question-synthesis', worker: createQuestionSynthesisWorker() });
  } catch (error) {
    console.log(
      '[workers] Question-synthesis worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'scope-classification', worker: createScopeClassificationWorker() });
  } catch (error) {
    console.log(
      '[workers] Scope-classification worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // IdP sync workers (Phase 2B: IdP Authentication)
  try {
    workers.push({ name: 'azuread-user-sync', worker: createAzureADUserSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Azure AD user sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'azuread-group-sync', worker: createAzureADGroupSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Azure AD group sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'okta-user-sync', worker: createOktaUserSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Okta user sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'okta-group-sync', worker: createOktaGroupSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Okta group sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'google-user-sync', worker: createGoogleUserSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Google user sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    workers.push({ name: 'google-group-sync', worker: createGoogleGroupSyncWorker(1) });
  } catch (error) {
    console.log(
      '[workers] Google group sync worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  console.log(`[workers] All ${workers.length} pipeline workers started`);

  // Start crawler ingestion worker (consumes from content-processing queue)
  try {
    await startCrawlerIngestionWorker(Math.max(Math.floor(concurrency * 0.6), 1));
    const crawlerWorker = getCrawlerIngestionWorker();
    if (crawlerWorker) {
      workers.push({ name: 'crawler-ingestion', worker: crawlerWorker });
    }
  } catch (error) {
    console.log(
      '[workers] Crawler ingestion worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Start intelligence crawl worker (multi-page intelligence crawl jobs)
  try {
    const intelligenceCrawlWorker = createIntelligenceCrawlWorker();
    workers.push({ name: 'intelligence-crawl', worker: intelligenceCrawlWorker });
  } catch (error) {
    console.log(
      '[workers] Intelligence crawl worker disabled:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Start bulk crawl worker (high-throughput section-aware crawling)
  try {
    const { createBulkCrawlWorker } = await import('./bulk-crawl-worker.js');
    const bulkCrawlWorkerInstance = createBulkCrawlWorker();
    workers.push({ name: 'bulk-crawl', worker: bulkCrawlWorkerInstance });
  } catch (error) {
    workerLog(
      'bulk-crawl',
      `Worker disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Start IdP sync scheduler for automatic daily syncs (non-blocking with timeout)
  let schedulerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const schedulerTimeout = new Promise<void>((_, reject) => {
      schedulerTimer = setTimeout(() => reject(new Error('Scheduler startup timeout')), 5000);
    });
    await Promise.race([startIdPSyncScheduler(), schedulerTimeout]);
  } catch (error) {
    console.log(
      '[workers] IdP sync scheduler disabled or timeout:',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(schedulerTimer);
  }
}

/**
 * Gracefully close all workers and their Redis connections.
 * Waits for currently-running jobs to finish before closing.
 */
export async function stopWorkers(): Promise<void> {
  if (workers.length === 0) {
    return;
  }

  console.log('[workers] Stopping all pipeline workers...');

  // Stop IdP sync scheduler
  try {
    await stopIdPSyncScheduler();
  } catch (error) {
    console.error(
      '[workers] Error stopping IdP sync scheduler:',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Close all workers in parallel
  await Promise.allSettled(
    workers.map(async ({ name, worker }) => {
      try {
        await worker.close();
        console.log(`[workers] ${name} worker stopped`);
      } catch (error) {
        console.error(
          `[workers] Error stopping ${name} worker:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );

  // Close embedding provider singletons
  await closeEmbeddingProviders();

  // Close pooled queue connections
  const { closeQueuePool } = await import('./shared.js');
  await closeQueuePool();

  workers = [];
  console.log('[workers] All pipeline workers stopped');
}

/**
 * Return the status of each worker for health-check / monitoring purposes.
 */
export function getWorkerStatus(): Array<{
  name: string;
  running: boolean;
  closed: boolean;
}> {
  return workers.map(({ name, worker }) => ({
    name,
    running: worker.isRunning(),
    closed: !worker.isRunning(),
  }));
}

/**
 * Get the current number of active workers
 */
export function getWorkerCount(): number {
  return workers.length;
}

// Re-export types for convenience
export type {
  IngestionJobData,
  ExtractionJobData,
  DoclingExtractionJobData,
  PageProcessingJobData,
  CanonicalMapJobData,
  EnrichmentJobData,
  EmbeddingJobData,
  KGEnrichmentJobData,
  TaxonomySetupJobData,
  MultiModalJobData,
  TreeBuildingJobData,
  QuestionSynthesisJobData,
  ScopeClassificationJobData,
  VisualEnrichmentJobData,
  DocumentVisualEnrichmentJobData,
  ConnectorDiscoveryJobData,
  WebhookNotificationJobData,
  WebhookNotificationBatchJobData,
} from './shared.js';

export { createQueue } from './shared.js';
export type { IntelligenceCrawlJobData } from './shared.js';
export type { BulkCrawlJobData, BulkCrawlSectionMapping } from './shared.js';
export { QUEUE_BULK_CRAWL } from './shared.js';
export type { VocabularyGenerationJobData } from './vocabulary-generation-worker.js';
export type { SchemaDiscoveryJobData } from './schema-discovery-worker.js';
export type { FieldMappingSuggestionJobData } from './field-mapping-suggestion-worker.js';
