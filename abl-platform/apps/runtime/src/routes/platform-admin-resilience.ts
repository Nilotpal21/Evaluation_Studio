/**
 * Platform Admin — Resilience Routes
 *
 * Operational API for inspecting and resetting circuit breakers.
 * Targets both in-process breakers (HybridCircuitBreakerRegistry) and
 * Redis-backed hierarchical breakers (CircuitBreakerRegistry from @agent-platform/circuit-breaker).
 *
 * Key rules:
 * - All routes require `requirePlatformAdmin()` + IP allow-list
 * - Every mutation writes an audit log with `platform-admin:` prefix
 *
 * Mount: /api/platform/admin/resilience
 */

import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../config/index.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { writeAuditLog } from '../repos/auth-repo.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import {
  getCircuitBreakerRegistry,
  type HybridCircuitBreakerRegistry,
} from '../services/resilience/hybrid-cb-registry.js';

const log = createLogger('platform-admin-resilience');
const router: ReturnType<typeof Router> = Router();

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Validation ───────────────────────────────────────────────────────────

const forceResetSchema = z.object({
  targetState: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']).default('CLOSED'),
});

// ─── Lazy Redis Registry Singleton ────────────────────────────────────────

let redisRegistry: import('@agent-platform/circuit-breaker').CircuitBreakerRegistry | null = null;

async function getRedisRegistry(): Promise<
  import('@agent-platform/circuit-breaker').CircuitBreakerRegistry | null
> {
  if (redisRegistry) return redisRegistry;
  try {
    const { isRedisAvailable, getRedisClient } = await import('../services/redis/redis-client.js');
    if (!isRedisAvailable()) return null;
    const redis = getRedisClient();
    if (!redis) return null;
    const { CircuitBreakerRegistry } = await import('@agent-platform/circuit-breaker');
    redisRegistry = new CircuitBreakerRegistry(redis);
    return redisRegistry;
  } catch {
    return null;
  }
}

// ─── GET /circuit-breakers — List all in-process CB states ────────────────

router.get('/circuit-breakers', async (_req, res) => {
  try {
    const hybridRegistry = getCircuitBreakerRegistry();
    const inProcessStates = hybridRegistry.getRegistry().getAllStates();

    const breakers = Object.entries(inProcessStates).map(([name, info]) => ({
      name,
      state: info.state,
      failures: info.failures,
    }));

    res.json({
      success: true,
      data: {
        backend: hybridRegistry.isUsingRedis() ? 'redis' : 'memory',
        breakers,
      },
    });
  } catch (err) {
    log.error('Failed to list circuit breakers', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list circuit breakers' },
    });
  }
});

// ─── GET /tenants/:tenantId/health — Tenant health across all breaker levels

router.get('/tenants/:tenantId/health', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const registry = await getRedisRegistry();

    if (!registry) {
      res.status(503).json({
        success: false,
        error: {
          code: 'REDIS_UNAVAILABLE',
          message: 'Redis-backed breaker registry not available',
        },
      });
      return;
    }

    const health = await registry.getTenantHealth(tenantId);

    res.json({
      success: true,
      data: {
        tenantId,
        healthy: !health.hasOpenCircuits,
        tenant: health.tenant,
        apps: health.apps,
        llmProviders: health.llmProviders,
        toolServices: health.toolServices,
      },
    });
  } catch (err) {
    log.error('Failed to get tenant health', {
      error: err instanceof Error ? err.message : String(err),
      tenantId: req.params.tenantId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get tenant health' },
    });
  }
});

// ─── POST /tenants/:tenantId/force-reset — Emergency force-reset all breakers

router.post('/tenants/:tenantId/force-reset', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const parsed = forceResetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request' },
        details: parsed.error.issues,
      });
      return;
    }

    const { targetState } = parsed.data;
    const registry = await getRedisRegistry();

    if (!registry) {
      res.status(503).json({
        success: false,
        error: {
          code: 'REDIS_UNAVAILABLE',
          message: 'Redis-backed breaker registry not available',
        },
      });
      return;
    }

    await registry.forceResetTenant(tenantId, targetState);

    // Also reset matching in-process breakers
    const hybridRegistry = getCircuitBreakerRegistry();
    const inProcessStates = hybridRegistry.getRegistry().getAllStates();
    for (const name of Object.keys(inProcessStates)) {
      if (name.includes(tenantId)) {
        const breaker = hybridRegistry.getBreaker(name);
        await breaker.reset();
      }
    }

    const adminUserId = req.tenantContext!.userId;
    log.info('Force-reset tenant breakers', { tenantId, targetState, adminUserId });
    writeAuditLog({
      action: 'platform-admin:force-reset-tenant-breakers',
      userId: adminUserId,
      tenantId,
      metadata: { targetState },
    });

    res.json({
      success: true,
      data: { tenantId, targetState, message: 'All breakers reset' },
    });
  } catch (err) {
    log.error('Failed to force-reset tenant breakers', {
      error: err instanceof Error ? err.message : String(err),
      tenantId: req.params.tenantId,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to force-reset tenant breakers' },
    });
  }
});

// ─── POST /circuit-breakers/:breakerName/reset — Reset single in-process breaker

router.post('/circuit-breakers/:breakerName/reset', async (req, res) => {
  try {
    const { breakerName } = req.params;
    const hybridRegistry = getCircuitBreakerRegistry();
    const allStates = hybridRegistry.getRegistry().getAllStates();

    if (!(breakerName in allStates)) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Circuit breaker '${breakerName}' not found` },
      });
      return;
    }

    const previousState = allStates[breakerName].state;
    const breaker = hybridRegistry.getBreaker(breakerName);
    await breaker.reset();

    const adminUserId = req.tenantContext!.userId;
    log.info('Reset circuit breaker', { breakerName, previousState, adminUserId });
    writeAuditLog({
      action: 'platform-admin:reset-circuit-breaker',
      userId: adminUserId,
      tenantId: req.tenantContext!.tenantId,
      metadata: { breakerName, previousState },
    });

    res.json({
      success: true,
      data: { breakerName, previousState, newState: 'closed' },
    });
  } catch (err) {
    log.error('Failed to reset circuit breaker', {
      error: err instanceof Error ? err.message : String(err),
      breakerName: req.params.breakerName,
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reset circuit breaker' },
    });
  }
});

export default router;
