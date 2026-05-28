/**
 * Reconciliation Job Processor (shared)
 *
 * Single source of truth for the reconciliation job processing logic.
 * Used by both the dedicated reconciliation worker and the scheduler.
 *
 * Contains safety fixes:
 * - H8: BGE-M3 baseUrl resolved from EMBEDDING_BASE_URL env
 * - H9: $limit 1000 cap on full-sweep aggregation
 * - H10: trim validation on tenantId/indexId to prevent unscoped sweeps
 */

import type { Job } from 'bullmq';
import { withTenantContext } from '@agent-platform/database/mongo';
import type { ReconciliationJobData } from './shared.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('worker:reconciliation');

export async function processReconciliationJob(job: Job<ReconciliationJobData>): Promise<unknown> {
  const { tenantId, indexId } = job.data;

  // H10 fix: Validate job data — empty strings are functionally equivalent to
  // undefined but bypass the truthiness check, triggering an unscoped full sweep.
  const validTenantId = tenantId && tenantId.trim().length > 0 ? tenantId.trim() : undefined;
  const validIndexId = indexId && indexId.trim().length > 0 ? indexId.trim() : undefined;

  // If one is provided without the other, that's invalid
  if ((validTenantId && !validIndexId) || (!validTenantId && validIndexId)) {
    throw new Error(
      `Invalid reconciliation job data: both tenantId and indexId must be provided together (got tenantId=${tenantId}, indexId=${indexId})`,
    );
  }

  log.info('Processing reconciliation job', {
    jobId: job.id,
    tenantId: validTenantId,
    indexId: validIndexId,
    mode: validTenantId ? 'targeted' : 'full-sweep',
  });

  try {
    // Lazy imports to avoid startup overhead
    const { ReconciliationService } =
      await import('../services/reconciliation/reconciliation.service.js');
    const { BGEm3EmbeddingProvider } = await import('@agent-platform/search-ai-internal/embedding');

    // H8 fix: Resolve BGE-M3 base URL from environment. The apiKey is optional
    // for self-hosted deployments — BGEm3EmbeddingProvider skips the Authorization
    // header when apiKey is falsy (see bge-m3.ts L87-89).
    const embeddingProvider = new BGEm3EmbeddingProvider({
      apiKey: process.env.EMBEDDING_API_KEY || '',
      model: 'bge-m3',
      baseUrl: process.env.EMBEDDING_BASE_URL || 'http://localhost:8000',
    });
    const reconciliationService = new ReconciliationService(embeddingProvider);

    if (validTenantId && validIndexId) {
      // Targeted reconciliation — wrap in tenant context for isolation plugin
      const results = await withTenantContext({ tenantId: validTenantId }, () =>
        reconciliationService.reconcileIndex(validTenantId, validIndexId),
      );
      log.info('Targeted reconciliation complete', {
        tenantId: validTenantId,
        indexId: validIndexId,
        scopes: results.length,
      });
      return { success: true, results };
    }

    // Full sweep: find all indexes with novel candidates
    const { AttributeRegistry } = await import('@agent-platform/database/models');

    // H9 fix: Get distinct (tenantId, indexId) pairs with novel candidates.
    // The aggregation is inherently scoped — it groups BY tenantId, so each
    // reconcileIndex call receives a specific (tenantId, indexId) pair.
    // Added $limit to prevent unbounded result sets in large deployments.
    const pipeline = [
      { $match: { tier: 'novel' } },
      { $group: { _id: { tenantId: '$tenantId', indexId: '$indexId' } } },
      { $limit: 1000 }, // Safety cap: process max 1000 indexes per sweep
    ];
    const pairs = await AttributeRegistry.aggregate(pipeline);

    const allResults = [];
    for (const pair of pairs) {
      try {
        // Wrap each index reconciliation in its own tenant context
        const results = await withTenantContext({ tenantId: pair._id.tenantId }, () =>
          reconciliationService.reconcileIndex(pair._id.tenantId, pair._id.indexId),
        );
        allResults.push(...results);
      } catch (error) {
        log.error('Reconciliation failed for index', {
          tenantId: pair._id.tenantId,
          indexId: pair._id.indexId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.info('Full reconciliation sweep complete', {
      indexCount: pairs.length,
      totalScopes: allResults.length,
    });

    return { success: true, indexCount: pairs.length, results: allResults };
  } catch (error) {
    // Re-throw so BullMQ can retry with backoff per queue config
    log.error('Reconciliation job failed', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
