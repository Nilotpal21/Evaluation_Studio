/**
 * Health Check Route
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { isDatabaseAvailable, getDatabaseHealth } from '../db/index.js';
import axios from 'axios';
import { getServiceBuildInfo } from '@agent-platform/shared/build-info';

const router: RouterType = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    if (isDatabaseAvailable()) {
      const health = await getDatabaseHealth();
      if (!health.ok) throw new Error('Dual-database health check failed');
    }

    res.json({
      status: 'ok',
      service: 'search-ai',
      build: getServiceBuildInfo(),
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: isDatabaseAvailable() ? 'connected (dual-mongo)' : 'not configured',
      crawler: {
        queue: 'bulk-crawl',
        status: 'available',
      },
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      service: 'search-ai',
      error: 'Database connection failed',
    });
  }
});

/**
 * Diagnostic endpoint to check Docling service connectivity
 * GET /health/docling
 */
router.get('/docling', async (_req: Request, res: Response) => {
  const doclingServiceUrl = process.env.DOCLING_SERVICE_URL || 'http://localhost:8080';

  try {
    const startTime = Date.now();
    const response = await axios.get(`${doclingServiceUrl}/health`, {
      timeout: 5000,
    });
    const latency = Date.now() - startTime;

    res.json({
      status: 'ok',
      service: 'docling',
      url: doclingServiceUrl,
      latency: `${latency}ms`,
      response: response.data,
    });
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      // Connection error (service unreachable)
      if (!error.response) {
        const errorCode = (error as any).code || 'UNKNOWN';
        const errorMessage = error.message || 'Unknown error';

        return res.status(503).json({
          status: 'unreachable',
          service: 'docling',
          url: doclingServiceUrl,
          error: `${errorCode}: ${errorMessage}`,
          suggestion: 'Check that DOCLING_SERVICE_URL is set correctly and the service is running',
        });
      }

      // HTTP error (service responded with error)
      return res.status(503).json({
        status: 'error',
        service: 'docling',
        url: doclingServiceUrl,
        httpStatus: error.response.status,
        error: error.response.statusText,
      });
    }

    return res.status(503).json({
      status: 'error',
      service: 'docling',
      url: doclingServiceUrl,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
