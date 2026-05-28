/**
 * BullMQ Job ID Patterns
 *
 * Standardized job ID generation for deduplication and idempotency.
 * Job IDs prevent duplicate processing when the same job is enqueued multiple times.
 *
 * Pattern: `{stage}:{scope}:{timestamp}`
 * - stage: worker/queue name (e.g., 'taxonomy-setup', 'kg-reclassify')
 * - scope: unique identifier for the work unit (indexId, documentId, etc.)
 * - timestamp: milliseconds since epoch (ensures uniqueness across retries)
 */

/**
 * Generates a job ID for taxonomy setup
 * Scope: indexId (one taxonomy per index)
 */
export function taxonomySetupJobId(indexId: string): string {
  return `taxonomy-setup:${indexId}:${Date.now()}`;
}

/**
 * Generates a job ID for taxonomy refinement
 * Scope: indexId (one refinement operation at a time per index)
 */
export function taxonomyRefinementJobId(indexId: string, refinementAction: string): string {
  // Include action to allow concurrent different refinement types
  return `taxonomy-refinement:${indexId}:${refinementAction}:${Date.now()}`;
}

/**
 * Generates a job ID for knowledge graph re-classification
 * Scope: indexId + documentId (one re-classification per document per index)
 */
export function kgReclassifyJobId(indexId: string, documentId: string): string {
  return `kg-reclassify:${indexId}:${documentId}:${Date.now()}`;
}

/**
 * Generates a job ID for knowledge graph enrichment
 * Scope: indexId + documentId (one enrichment per document per index)
 */
export function kgEnrichmentJobId(indexId: string, documentId: string): string {
  return `kg-enrichment:${indexId}:${documentId}:${Date.now()}`;
}

/**
 * Generates a job ID for page processing
 * Scope: documentId + pageNumber (one processing job per page)
 */
export function pageProcessingJobId(documentId: string, pageNumber: number): string {
  return `page-processing:${documentId}:${pageNumber}:${Date.now()}`;
}

/**
 * Generates a job ID for embedding
 * Scope: chunkId (one embedding job per chunk)
 */
export function embeddingJobId(chunkId: string): string {
  return `embedding:${chunkId}:${Date.now()}`;
}

/**
 * Generates a job ID for custom domain generation
 * Scope: tenantId + industrySlug (one generation per industry per tenant)
 */
export function customDomainGenerationJobId(tenantId: string, industrySlug: string): string {
  return `custom-domain-gen:${tenantId}:${industrySlug}:${Date.now()}`;
}

/**
 * Generates a job ID for organization profile generation
 * Scope: tenantId + indexId (one profile generation per index)
 */
export function orgProfileGenerationJobId(tenantId: string, indexId: string): string {
  return `org-profile-gen:${tenantId}:${indexId}:${Date.now()}`;
}

/**
 * Standard BullMQ job options with retry configuration
 */
export const STANDARD_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5_000, // 5 seconds initial delay, exponential backoff
  },
  removeOnComplete: {
    age: 86400, // Keep completed jobs for 24 hours
    count: 1000, // Keep last 1000 completed jobs
  },
  removeOnFail: {
    age: 604800, // Keep failed jobs for 7 days
  },
};

/**
 * Helper to enqueue a job with standardized options
 *
 * @example
 * ```typescript
 * await enqueueJob(
 *   queue,
 *   'Process document',
 *   { documentId: '123', tenantId: 'abc' },
 *   kgReclassifyJobId('index-1', 'doc-123')
 * );
 * ```
 */
export async function enqueueJob<T>(
  queue: any, // BullMQ Queue instance
  jobName: string,
  jobData: T,
  jobId: string,
  customOptions: Record<string, any> = {},
): Promise<void> {
  try {
    await queue.add(jobName, jobData, {
      jobId,
      ...STANDARD_JOB_OPTIONS,
      ...customOptions,
    });
  } finally {
    // Always close queue connection in finally block
    await queue.close();
  }
}
