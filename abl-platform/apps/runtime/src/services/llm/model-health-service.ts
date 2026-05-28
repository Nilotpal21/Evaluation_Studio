/**
 * Model Health Service
 *
 * Provides connection health checking (single + automated periodic) for
 * tenant model connections. Extracted from the inline route handler in
 * tenant-models.ts to enable both manual validation and automated health
 * check jobs.
 *
 * The automated job runs on setInterval (matching all other periodic jobs
 * in the codebase: KMS rotation, session cleanup, auth profile rotation)
 * with DistributedLockManager to ensure only one pod runs checks per cycle.
 * Feature-gated via enableHealthChecks config flag.
 */

import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { createLogger } from '@agent-platform/shared-observability';
import { DistributedLockManager, type Lock } from '@agent-platform/shared';

const log = createLogger('model-health-service');

// ─── Types ──────────────────────────────────────────────────────────────

export type ConnectionHealthStatus = 'healthy' | 'unhealthy' | 'unknown' | 'unchecked';

export interface HealthCheckResult {
  valid: boolean | null;
  message: string;
  status: ConnectionHealthStatus;
}

export interface ConnectionHealthInput {
  provider: string;
  apiKey: string;
  endpoint?: string;
  modelId: string;
  authConfig?: Record<string, unknown>;
}

export interface StoredConnectionHealthCredential {
  encryptedApiKey?: string | null;
  encryptedEndpoint?: string | null;
  authType?: string | null;
  authConfig?: Record<string, unknown> | string | null;
  customHeaders?: Record<string, string> | string | null;
  _decryptionFailed?: boolean;
}

/** Dependency-injected Redis client for distributed locking. */
export interface HealthCheckRedisClient {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

// ─── Constants ──────────────────────────────────────────────────────────

const LOCK_KEY_PREFIX = 'model-health-check';
const CREDENTIAL_DECRYPTION_FAILED_MESSAGE = 'Credential could not be decrypted';

// ─── State ──────────────────────────────────────────────────────────────

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let lockManager: DistributedLockManager | null = null;

function parseStringRecord(value: Record<string, string> | string | null | undefined) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }
  return value;
}

// ─── Core Health Check ──────────────────────────────────────────────────

/**
 * Check a single connection's health by making a minimal inference request.
 *
 * Uses the Vercel AI SDK generateText with maxOutputTokens: 16 to keep
 * cost negligible. Non-auth errors (rate limit, model not found) result
 * in 'unknown' status — the key may be valid but something else is wrong.
 */
export async function checkConnectionHealth(
  input: ConnectionHealthInput,
): Promise<HealthCheckResult> {
  try {
    const { generateText, embed } = await import('ai');
    const { MODEL_REGISTRY } = await import('@abl/compiler/platform/llm/model-registry.js');

    // Dispatch on registry capability so embedding-only deployments are tested
    // with /embeddings instead of /chat/completions. Unknown models fall
    // through to the chat path (existing behavior).
    const registryEntry = MODEL_REGISTRY[input.modelId];
    const isEmbedding = registryEntry?.capabilities.includes('textToEmbedding') ?? false;

    if (isEmbedding) {
      const { createVercelEmbeddingProvider } = await import('@agent-platform/llm');
      const embeddingModel = createVercelEmbeddingProvider(
        input.provider,
        input.apiKey,
        input.endpoint,
        input.modelId,
        input.authConfig,
      );
      await embed({
        model: embeddingModel,
        value: 'hi',
        maxRetries: 0,
      });
    } else {
      const { createVercelProviderForValidation } = await import('./session-llm-client.js');
      const providerInstance = createVercelProviderForValidation(
        input.provider,
        input.apiKey,
        input.endpoint,
        input.modelId,
        input.authConfig,
      );
      await generateText({
        model: providerInstance,
        prompt: 'hi',
        maxOutputTokens: 16,
        maxRetries: 0,
      });
    }

    return {
      valid: true,
      message: 'Credential is valid — inference test passed',
      status: 'healthy',
    };
  } catch (err: unknown) {
    const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
    const status = errObj.status || errObj.statusCode;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (status === 401 || status === 403) {
      return {
        valid: false,
        message: 'Invalid API key (authentication failed)',
        status: 'unhealthy',
      };
    }

    if (
      errMsg.includes('API key') ||
      errMsg.includes('authentication') ||
      errMsg.includes('Unauthorized')
    ) {
      // Log raw error server-side; return sanitized message to client
      // to avoid leaking provider endpoint URLs or partial API keys.
      log.warn('Health check authentication failure', { error: errMsg });
      return {
        valid: false,
        message: 'Authentication failed — check API key configuration',
        status: 'unhealthy',
      };
    }

    // Non-auth error — key may be valid but something else is wrong.
    // Log raw error server-side; return generic message to client.
    log.warn('Health check inference failure', { error: errMsg });
    return {
      valid: null,
      message:
        'Inference check failed — credential may be valid but the provider returned an error',
      status: 'unknown',
    };
  }
}

export async function resolveConnectionHealthInputFromCredential(
  credential: StoredConnectionHealthCredential | null | undefined,
  tenantId: string,
  provider: string,
  modelId: string,
): Promise<ConnectionHealthInput | null> {
  if (!credential?.encryptedApiKey) {
    return null;
  }

  const apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
    decryptionFailed: Boolean(credential._decryptionFailed),
  });
  if (!apiKey) {
    return null;
  }

  const endpoint = await resolveTenantPlaintextValue(
    credential.encryptedEndpoint ?? null,
    tenantId,
  );
  const authConfig = credential.authConfig
    ? typeof credential.authConfig === 'string'
      ? JSON.parse(credential.authConfig)
      : credential.authConfig
    : undefined;
  const customHeaders = parseStringRecord(credential.customHeaders);
  const mergedAuthConfig = {
    ...(authConfig ?? {}),
    ...(credential.authType ? { authType: credential.authType } : {}),
    ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
  };

  return {
    provider,
    apiKey,
    endpoint: endpoint ?? undefined,
    modelId,
    authConfig: Object.keys(mergedAuthConfig).length > 0 ? mergedAuthConfig : undefined,
  };
}

// ─── DB Persistence ─────────────────────────────────────────────────────

/**
 * Update the health status on a connection subdocument.
 */
export async function updateConnectionHealthStatus(
  modelId: string,
  connectionId: string,
  tenantId: string,
  result: HealthCheckResult,
): Promise<void> {
  try {
    const { TenantModel } = await import('@agent-platform/database/models');
    const update = {
      $set: {
        'connections.$.lastHealthCheck': new Date(),
        'connections.$.healthStatus': result.status,
        'connections.$.healthMessage': result.message,
      },
    };

    const primaryResult = await TenantModel.updateOne(
      { _id: modelId, tenantId, 'connections.id': connectionId },
      update,
    );
    if (getMatchedCount(primaryResult) > 0) {
      return;
    }

    const legacyResult = await TenantModel.updateOne(
      { _id: modelId, tenantId, 'connections._id': connectionId },
      update,
    );
    if (getMatchedCount(legacyResult) > 0) {
      return;
    }

    log.warn('No matching connection found while persisting health status', {
      modelId,
      connectionId,
      tenantId,
      status: result.status,
    });
  } catch (err) {
    log.error('Failed to persist health status', {
      error: err instanceof Error ? err.message : String(err),
      modelId,
      connectionId,
      tenantId,
    });
  }
}

function getMatchedCount(result: unknown): number {
  if (!result || typeof result !== 'object') {
    return 0;
  }

  const matchedCount = (result as { matchedCount?: unknown }).matchedCount;
  return typeof matchedCount === 'number' ? matchedCount : 0;
}

// ─── Automated Health Check Job ─────────────────────────────────────────

/**
 * Start the periodic health check job. Uses setInterval (matches all
 * other periodic jobs: KMS rotation, session cleanup, auth profile rotation)
 * with distributed locking to ensure only one pod runs checks per cycle.
 *
 * @param intervalMs Interval between runs in milliseconds
 * @param redis      Optional Redis client for distributed locking. Without it,
 *                   health checks run on every pod (backward-compatible).
 */
export function startModelHealthJob(intervalMs: number, redis?: HealthCheckRedisClient): void {
  if (healthCheckTimer) {
    log.warn('Model health job already running — skipping start');
    return;
  }

  if (redis) {
    // DistributedLockManager expects ioredis Redis type, but only uses set/get/eval/pttl
    // which our HealthCheckRedisClient interface covers. Cast through unknown at the DI boundary.
    lockManager = new DistributedLockManager(
      redis as unknown as ConstructorParameters<typeof DistributedLockManager>[0],
    );
    log.info('Starting automated model health check job with distributed locking', {
      intervalMs,
      intervalHours: Math.round(intervalMs / 3_600_000),
    });
  } else {
    log.info('Starting automated model health check job (no distributed locking)', {
      intervalMs,
      intervalHours: Math.round(intervalMs / 3_600_000),
    });
  }

  healthCheckTimer = setInterval(() => {
    runHealthCheckCycleWithLock(intervalMs).catch((err) => {
      log.error('Health check cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  // Don't keep the process alive just for health checks
  if (healthCheckTimer.unref) {
    healthCheckTimer.unref();
  }
}

/**
 * Stop the periodic health check job. Call during graceful shutdown.
 */
export function stopModelHealthJob(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    lockManager = null;
    log.info('Stopped automated model health check job');
  }
}

/**
 * Run a health check cycle with distributed lock coordination.
 * If another pod holds the lock, this pod skips the cycle.
 * If Redis/locking is unavailable, runs locally (fail-open).
 */
async function runHealthCheckCycleWithLock(intervalMs: number): Promise<void> {
  await executeWithDistributedLock(lockManager, intervalMs, runHealthCheckCycle);
}

/**
 * Execute a function under a distributed lock. Exported for testability —
 * allows testing the lock orchestration without DB-dependent health check logic.
 *
 * @param lm         Lock manager (null = run directly)
 * @param intervalMs Lock TTL in ms
 * @param cycleFn    Function to execute under the lock
 * @returns 'executed' if cycleFn ran, 'skipped' if lock was held, 'fallback' if lock unavailable
 */
export async function executeWithDistributedLock(
  lm: DistributedLockManager | null,
  intervalMs: number,
  cycleFn: () => Promise<void>,
): Promise<'executed' | 'skipped' | 'fallback'> {
  if (!lm) {
    await cycleFn();
    return 'executed';
  }

  // Phase 1: Acquire lock (fail-open on Redis errors)
  let lock: Lock | null = null;
  let lockFailed = false;
  try {
    lock = await lm.acquire('global', {
      keyPrefix: LOCK_KEY_PREFIX,
      ttlMs: intervalMs,
      retryAttempts: 0,
    });
  } catch (err) {
    log.warn('Distributed lock unavailable, running health checks locally', {
      error: err instanceof Error ? err.message : String(err),
    });
    lockFailed = true;
  }

  if (!lockFailed && !lock) {
    log.debug('Health check cycle skipped — another pod holds the lock');
    return 'skipped';
  }

  // Phase 2: Execute cycle (errors propagate to caller)
  try {
    await cycleFn();
    return lockFailed ? 'fallback' : 'executed';
  } finally {
    if (lock && lm) {
      try {
        await lm.release(lock);
      } catch (releaseErr) {
        log.warn('Failed to release health check lock (will auto-expire)', {
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
    }
  }
}

/**
 * Run a single health check cycle across all active connections.
 * Processes connections sequentially to avoid overwhelming LLM providers.
 */
async function runHealthCheckCycle(): Promise<void> {
  log.info('Starting health check cycle');

  try {
    const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

    // Find all active models with active connections
    const models = await TenantModel.find({
      isActive: true,
      inferenceEnabled: true,
      'connections.isActive': true,
    })
      .select('_id tenantId provider modelId connections')
      .lean();

    let checked = 0;
    let healthy = 0;
    let unhealthy = 0;

    for (const model of models) {
      const activeConnections = (model.connections || []).filter(
        (c: Record<string, unknown>) => c.isActive,
      );

      for (const conn of activeConnections) {
        try {
          // No .lean() — the encryption plugin decrypts encryptedApiKey/encryptedEndpoint
          // in a post-find hook. .lean() skips hooks, returning raw encrypted blobs.
          const credential = await LLMCredential.findOne({
            _id: conn.credentialId,
            tenantId: model.tenantId,
          });

          if (!credential?.encryptedApiKey) {
            await updateConnectionHealthStatus(model._id, conn.id || conn._id, model.tenantId, {
              valid: false,
              message: 'No API key configured',
              status: 'unhealthy',
            });
            unhealthy++;
            checked++;
            continue;
          }

          let healthInput: ConnectionHealthInput | null = null;
          try {
            healthInput = await resolveConnectionHealthInputFromCredential(
              credential,
              model.tenantId,
              model.provider || 'unknown',
              model.modelId || 'test',
            );
          } catch (credentialErr) {
            log.warn('Health check credential unavailable after decryption', {
              modelId: model._id,
              connectionId: conn.id || conn._id,
              tenantId: model.tenantId,
              error: credentialErr instanceof Error ? credentialErr.message : String(credentialErr),
            });
            await updateConnectionHealthStatus(model._id, conn.id || conn._id, model.tenantId, {
              valid: false,
              message: CREDENTIAL_DECRYPTION_FAILED_MESSAGE,
              status: 'unhealthy',
            });
            unhealthy++;
            checked++;
            continue;
          }

          if (!healthInput) {
            await updateConnectionHealthStatus(model._id, conn.id || conn._id, model.tenantId, {
              valid: false,
              message: 'No API key configured',
              status: 'unhealthy',
            });
            unhealthy++;
            checked++;
            continue;
          }

          const result = await checkConnectionHealth(healthInput);

          await updateConnectionHealthStatus(
            model._id,
            conn.id || conn._id,
            model.tenantId,
            result,
          );

          if (result.status === 'healthy') healthy++;
          if (result.status === 'unhealthy') unhealthy++;
          checked++;
        } catch (connErr) {
          log.warn('Health check failed for connection', {
            modelId: model._id,
            connectionId: conn.id || conn._id,
            error: connErr instanceof Error ? connErr.message : String(connErr),
          });
        }
      }
    }

    log.info('Health check cycle complete', { checked, healthy, unhealthy });
  } catch (err) {
    log.error('Failed to run health check cycle', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
