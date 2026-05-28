/**
 * Queue Monitoring API
 *
 * Endpoints for monitoring BullMQ queue health and performance.
 * Includes Bull Board UI for visual queue inspection.
 */

import { Router, type Router as RouterType } from 'express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getAllQueueStats, getAllQueueHealth, monitorQueues } from '../workers/queue-monitor.js';
import {
  getIngestionQueue,
  getExtractionQueue,
  getDoclingExtractionQueue,
  getPageProcessingQueue,
  getCanonicalMapQueue,
  getQuestionSynthesisQueue,
  getVisualEnrichmentQueue,
  getEnrichmentQueue,
  getEmbeddingQueue,
  getTreeBuildingQueue,
  getMultimodalQueue,
  getScopeClassificationQueue,
  getCleanupQueue,
} from '../queues/index.js';

const router: RouterType = Router();

// =============================================================================
// BULL BOARD UI (lazy initialization)
// =============================================================================

let bullBoardInitialized = false;
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/api/admin/queues/ui');

function ensureBullBoard(): void {
  if (bullBoardInitialized) return;
  bullBoardInitialized = true;

  const allQueues = [
    getIngestionQueue(),
    getExtractionQueue(),
    getDoclingExtractionQueue(),
    getPageProcessingQueue(),
    getCanonicalMapQueue(),
    getQuestionSynthesisQueue(),
    getVisualEnrichmentQueue(),
    getEnrichmentQueue(),
    getEmbeddingQueue(),
    getTreeBuildingQueue(),
    getMultimodalQueue(),
    getScopeClassificationQueue(),
    getCleanupQueue(),
  ].filter((q) => q !== null);

  createBullBoard({
    queues: allQueues.map((q) => new BullMQAdapter(q as any)),
    serverAdapter,
  });
}

// Mount Bull Board UI at /api/admin/queues/ui (initializes on first request)
router.use('/ui', (req, res, next) => {
  ensureBullBoard();
  serverAdapter.getRouter()(req, res, next);
});

// =============================================================================
// STATS & HEALTH ENDPOINTS
// =============================================================================

/**
 * GET /api/admin/queues/stats
 *
 * Get current stats for all monitored queues
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getAllQueueStats();

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      queues: stats,
    });
  } catch (error) {
    console.error('[queue-monitoring] Failed to get queue stats:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'STATS_FETCH_FAILED',
        message: error instanceof Error ? error.message : 'Failed to fetch queue stats',
      },
    });
  }
});

/**
 * GET /api/admin/queues/health
 *
 * Get health assessment for all monitored queues
 */
router.get('/health', async (req, res) => {
  try {
    const health = await getAllQueueHealth();

    const critical = health.filter((h) => h.status === 'critical');
    const degraded = health.filter((h) => h.status === 'degraded');
    const healthy = health.filter((h) => h.status === 'healthy');

    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        total: health.length,
        healthy: healthy.length,
        degraded: degraded.length,
        critical: critical.length,
        overallStatus:
          critical.length > 0 ? 'critical' : degraded.length > 0 ? 'degraded' : 'healthy',
      },
      queues: health,
    });
  } catch (error) {
    console.error('[queue-monitoring] Failed to get queue health:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'HEALTH_CHECK_FAILED',
        message: error instanceof Error ? error.message : 'Failed to check queue health',
      },
    });
  }
});

/**
 * POST /api/admin/queues/monitor
 *
 * Trigger on-demand monitoring (logs stats + health to console)
 */
router.post('/monitor', async (req, res) => {
  try {
    await monitorQueues();

    res.status(200).json({
      success: true,
      message: 'Queue monitoring logged to console',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[queue-monitoring] Failed to run monitoring:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'MONITORING_FAILED',
        message: error instanceof Error ? error.message : 'Failed to run monitoring',
      },
    });
  }
});

export default router;
