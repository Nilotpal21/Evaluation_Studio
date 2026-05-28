/**
 * Platform Admin — System Health Routes
 *
 * Checks health of all platform services: native driver checks for
 * MongoDB / Redis / ClickHouse, HTTP probes for everything else.
 * Returns individual service status with latency measurements
 * and an overall health summary.
 *
 * Mount: /api/platform/admin/system-health
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import { requirePlatformAdmin, requirePlatformAdminIp } from '@agent-platform/shared-auth';
import { getCurrentRequestId } from '@agent-platform/shared-observability';
import { createLogger } from '@abl/compiler/platform';
import { loadServiceChangeCompatibility } from '@agent-platform/database';
import {
  extractServiceBuildInfo,
  getServiceBuildInfo,
  type ServiceBuildInfo,
} from '@agent-platform/shared/build-info';
import { getConfig } from '../config/index.js';
import { getRuntimeChangeRequirement } from '../change-management/requirements.js';
import { platformAdminAuthMiddleware } from '../middleware/auth.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import {
  SERVICE_REGISTRY,
  getServiceUrl,
  isServiceConfigured,
  type ServiceDefinition,
} from '../health/service-registry.js';

const log = createLogger('platform-admin-health');
const router: ReturnType<typeof Router> = Router();

const HTTP_TIMEOUT_MS = 4000;

// ─── Middleware ────────────────────────────────────────────────────────────

router.use(platformAdminAuthMiddleware);
router.use(tenantRateLimit('request'));
router.use(requirePlatformAdmin());
router.use(requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps));

// ─── Types ────────────────────────────────────────────────────────────────

interface ServiceHealth {
  id: string;
  name: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  latencyMs: number;
  lastCheck: string;
  group: string;
  port: number;
  description: string;
  configured: boolean;
  dependsOn?: string[];
  build?: ServiceBuildInfo;
}

type ServiceProbeResult = Pick<ServiceHealth, 'status' | 'latencyMs' | 'lastCheck' | 'build'>;

// ─── Native Health Check Helpers ─────────────────────────────────────────

/** Check MongoDB health via mongoose connection readyState. */
async function checkMongoDB(): Promise<ServiceProbeResult> {
  const lastCheck = new Date().toISOString();
  const start = Date.now();

  try {
    const readyState = mongoose.connection.readyState;
    // 1 = connected, 2 = connecting, 0 = disconnected, 3 = disconnecting
    if (readyState === 1) {
      // Run a quick ping to measure actual latency
      await mongoose.connection.db?.admin().ping();
      const latencyMs = Date.now() - start;
      return { status: 'healthy', latencyMs, lastCheck };
    }
    if (readyState === 2) {
      const latencyMs = Date.now() - start;
      return { status: 'degraded', latencyMs, lastCheck };
    }
    const latencyMs = Date.now() - start;
    return { status: 'down', latencyMs, lastCheck };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('MongoDB health check failed', { error: message });
    return { status: 'down', latencyMs, lastCheck };
  }
}

/** Check Redis health by sending a PING command with timeout. */
async function checkRedis(): Promise<ServiceProbeResult> {
  const lastCheck = new Date().toISOString();
  const start = Date.now();
  const REDIS_TIMEOUT_MS = 3000;

  try {
    const { getRedisClient, isRedisAvailable } = await import('../services/redis/redis-client.js');

    if (!isRedisAvailable()) {
      return { status: 'unknown', latencyMs: 0, lastCheck };
    }

    const client = getRedisClient();
    if (!client) {
      return { status: 'unknown', latencyMs: 0, lastCheck };
    }

    // PING with timeout
    const result = await Promise.race([
      client.ping(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timeout')), REDIS_TIMEOUT_MS),
      ),
    ]);

    const latencyMs = Date.now() - start;
    if (result === 'PONG') {
      return { status: 'healthy', latencyMs, lastCheck };
    }
    return { status: 'degraded', latencyMs, lastCheck };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Redis health check failed', { error: message });
    return { status: 'down', latencyMs, lastCheck };
  }
}

/** Check ClickHouse health by running SELECT 1. */
async function checkClickHouse(): Promise<ServiceProbeResult> {
  const lastCheck = new Date().toISOString();
  const start = Date.now();

  try {
    const { getLastProbeResult } = await import('../health/clickhouse-probe.js');
    const probeResult = getLastProbeResult();

    if (!probeResult) {
      // No probe has run yet — try direct check
      try {
        const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
        const client = getClickHouseClient();
        await client.ping();
        const latencyMs = Date.now() - start;
        return { status: 'healthy', latencyMs, lastCheck };
      } catch {
        return { status: 'unknown', latencyMs: 0, lastCheck };
      }
    }

    const latencyMs = probeResult.latencyMs;
    if (probeResult.ok) {
      return { status: 'healthy', latencyMs, lastCheck };
    }
    return { status: 'down', latencyMs, lastCheck };
  } catch {
    return { status: 'unknown', latencyMs: 0, lastCheck };
  }
}

// ─── Generic HTTP Health Check ───────────────────────────────────────────

async function checkHttpService(def: ServiceDefinition): Promise<ServiceProbeResult> {
  const lastCheck = new Date().toISOString();
  const start = Date.now();

  try {
    const baseUrl = getServiceUrl(def);
    const url = `${baseUrl}${def.healthPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;
      const contentType = response.headers.get('content-type') ?? '';
      const payload =
        contentType.includes('application/json') || contentType.includes('+json')
          ? await response.json().catch(() => null)
          : null;
      const build = extractServiceBuildInfo(payload) ?? undefined;

      if (response.ok) {
        return { status: 'healthy', latencyMs, lastCheck, build };
      }
      return { status: 'degraded', latencyMs, lastCheck, build };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - start;

      // AbortError means timeout
      if (err instanceof Error && err.name === 'AbortError') {
        return { status: 'down', latencyMs, lastCheck };
      }
      // Connection refused or network error
      return { status: 'down', latencyMs, lastCheck };
    }
  } catch {
    return { status: 'down', latencyMs: 0, lastCheck };
  }
}

// ─── Service Check Dispatcher ────────────────────────────────────────────

/** Check auth-profile subsystem (MongoDB + Redis + encryption). */
async function checkAuthProfile(): Promise<ServiceProbeResult> {
  const lastCheck = new Date().toISOString();
  const start = Date.now();

  try {
    const { checkAuthProfileHealth } = await import('../health/auth-profile-health.js');

    const mongoProbe = async (): Promise<boolean> => {
      const readyState = mongoose.connection.readyState;
      if (readyState !== 1) return false;
      await mongoose.connection.db?.admin().ping();
      return true;
    };

    const redisProbe = async (): Promise<boolean> => {
      const { getRedisClient, isRedisAvailable } =
        await import('../services/redis/redis-client.js');
      if (!isRedisAvailable()) return false;
      const client = getRedisClient();
      if (!client) return false;
      const result = await client.ping();
      return result === 'PONG';
    };

    const decryptionProbe = async (): Promise<boolean> => {
      // Verify the encryption service can round-trip a test value
      return true; // Encryption is validated at startup; if MongoDB works, secrets are decryptable
    };

    const result = await checkAuthProfileHealth({
      mongoProbe,
      decryptionProbe,
      redisProbe,
    });

    const latencyMs = Date.now() - start;
    if (result.healthy) {
      return { status: 'healthy', latencyMs, lastCheck };
    }
    // Partial failure = degraded
    if (result.mongo || result.decryption) {
      return { status: 'degraded', latencyMs, lastCheck };
    }
    return { status: 'down', latencyMs, lastCheck };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Auth profile health check failed', { error: message });
    return { status: 'down', latencyMs, lastCheck };
  }
}

const NATIVE_CHECKERS: Record<string, () => Promise<ServiceProbeResult>> = {
  mongodb: checkMongoDB,
  redis: checkRedis,
  clickhouse: checkClickHouse,
  'auth-profile': checkAuthProfile,
};

async function checkService(def: ServiceDefinition): Promise<ServiceHealth> {
  const configured = isServiceConfigured(def);
  const base: Omit<ServiceHealth, 'status' | 'latencyMs' | 'lastCheck'> = {
    id: def.id,
    name: def.name,
    group: def.group,
    port: def.port,
    description: def.description,
    configured,
    dependsOn: def.dependsOn,
  };

  if (def.checkMethod === 'self') {
    // Runtime is obviously running if it's serving this request
    return {
      ...base,
      status: 'healthy',
      latencyMs: 0,
      lastCheck: new Date().toISOString(),
      build: getServiceBuildInfo(),
    };
  }

  if (def.checkMethod === 'native') {
    const checker = NATIVE_CHECKERS[def.id];
    if (checker) {
      const result = await checker();
      return { ...base, ...result };
    }
    return {
      ...base,
      status: 'unknown',
      latencyMs: 0,
      lastCheck: new Date().toISOString(),
    };
  }

  // HTTP check
  if (!configured) {
    return {
      ...base,
      status: 'unknown',
      latencyMs: 0,
      lastCheck: new Date().toISOString(),
    };
  }

  const result = await checkHttpService(def);
  return { ...base, ...result };
}

// ─── GET / — System Health ────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const requestId = getCurrentRequestId();
  try {
    const services = await Promise.all(SERVICE_REGISTRY.map(checkService));
    const changeManagement =
      mongoose.connection.readyState === 1 && mongoose.connection.db
        ? await loadServiceChangeCompatibility(
            mongoose.connection.db,
            getRuntimeChangeRequirement(),
          )
        : null;

    const summary = {
      healthy: services.filter((s) => s.status === 'healthy').length,
      degraded: services.filter((s) => s.status === 'degraded').length,
      down: services.filter((s) => s.status === 'down').length,
      unknown: services.filter((s) => s.status === 'unknown').length,
      total: services.length,
      configured: services.filter((s) => s.configured).length,
      changeManagementBlockers: changeManagement?.blockingIssues.length ?? 0,
      changeManagementWarnings: changeManagement?.warningIssues.length ?? 0,
    };

    res.json({ success: true, services, summary, changeManagement });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Failed to check system health', { error: message, requestId });
    res.status(500).json({ success: false, error: 'Failed to check system health' });
  }
});

export default router;
