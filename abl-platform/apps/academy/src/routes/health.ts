/**
 * Health Check Routes (Academy Service)
 *
 * GET /health — simple 200 OK with service info
 * GET /ready  — readiness probe that verifies DB connection
 */

import { Router, type IRouter } from 'express';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import { isDatabaseAvailable } from '../lib/db.js';

const router: IRouter = Router();

/**
 * GET /health — Liveness probe.
 * Returns 200 as long as the process is running.
 */
router.get('/health', async (_req, res) => {
  try {
    if (isDatabaseAvailable()) {
      const { MongoConnectionManager } = await import('@agent-platform/database/mongo');
      const health = await MongoConnectionManager.getInstance().healthCheck();
      if (!health.ok) {
        throw new AppError('MongoDB health check failed', { ...ErrorCodes.SERVICE_UNAVAILABLE });
      }
    }

    const dbLabel = isDatabaseAvailable() ? 'connected (mongo)' : 'not configured';
    const mem = process.memoryUsage();

    res.json({
      status: 'healthy',
      service: 'academy-service',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbLabel,
      metrics: {
        memoryUsageMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
      },
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      service: 'academy-service',
      error: 'Database connection failed',
    });
  }
});

/**
 * GET /ready — Readiness probe.
 * Returns 200 only when DB is connected and healthy.
 */
router.get('/ready', async (_req, res) => {
  // Check MongoDB connection
  if (isDatabaseAvailable()) {
    try {
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState !== 1) {
        res.status(503).json({ status: 'not_ready', reason: 'mongodb_unavailable' });
        return;
      }
    } catch {
      res.status(503).json({ status: 'not_ready', reason: 'mongodb_check_failed' });
      return;
    }
  } else {
    res.status(503).json({ status: 'not_ready', reason: 'mongodb_not_configured' });
    return;
  }

  res.json({ status: 'ready' });
});

export default router;
