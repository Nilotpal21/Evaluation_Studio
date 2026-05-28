/**
 * Health Check Route
 *
 * GET /health — Returns service health status.
 */

import { Router, type Router as RouterType } from 'express';
import { isDatabaseAvailable } from '../db/index.js';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';

const router: RouterType = Router();

router.get('/', (_req, res) => {
  try {
    res.json({
      status: 'ok',
      service: 'search-ai-runtime',
      build: getServiceBuildInfo(),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: isDatabaseAvailable() ? 'connected' : 'not configured',
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      service: 'search-ai-runtime',
      error: 'Health check failed',
    });
  }
});

export default router;
