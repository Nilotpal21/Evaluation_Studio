/**
 * Eval Preflight Validation
 *
 * Validates all integration points before an eval run starts.
 * Each check runs independently with its own timeout so a single
 * slow/broken dependency doesn't block the entire validation.
 *
 * System-level preflight (tenantId = '_system_') skips tenant-specific
 * checks (LLM credentials, provider/key match).
 */
import crypto from 'crypto';
import { createLogger } from '@abl/compiler/platform';
import { createServiceToken } from './eval-auth.js';

const log = createLogger('eval-preflight');

// ── Types ────────────────────────────────────────────────────────────

export type PreflightCheckStatus = 'pass' | 'fail' | 'warn' | 'not_checked';
export type PreflightOverallStatus = 'pass' | 'fail' | 'warn';

export interface PreflightCheck {
  name: string;
  status: PreflightCheckStatus;
  code?: string;
  message: string;
  durationMs: number;
}

export interface PreflightResult {
  overall: PreflightOverallStatus;
  checks: PreflightCheck[];
  timestamp: string;
}

// ── Constants ────────────────────────────────────────────────────────

const RUNTIME_URL = process.env['RUNTIME_URL'] ?? 'http://localhost:3112';
const HEALTH_TIMEOUT_MS = 5_000;

// ── Utilities ────────────────────────────────────────────────────────

type PipelineLLMResolutionErrorPredicate = (error: unknown) => error is {
  code: string;
  userMessage: string;
};

function describeLLMResolutionError(
  err: unknown,
  isResolutionError: PipelineLLMResolutionErrorPredicate,
): { code: string; message: string } {
  if (isResolutionError(err)) {
    return { code: err.code, message: err.userMessage };
  }

  return {
    code: 'LLM_RESOLUTION_FAILED',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Races a promise against a deadline. Clears the timer when the operation
 * wins so no dangling setTimeout is left in the event loop.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derives the overall preflight status from an array of individual check results.
 * fail > warn > pass.
 */
export function computeOverallStatus(checks: PreflightCheck[]): PreflightOverallStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => isPreflightWarningStatus(c.status))) return 'warn';
  return 'pass';
}

export function isPreflightWarningStatus(status: PreflightCheckStatus): boolean {
  return status === 'warn' || status === 'not_checked';
}

// ── Individual Checks ────────────────────────────────────────────────

async function checkEncryptionMasterKey(): Promise<PreflightCheck> {
  const start = Date.now();
  const key = process.env['ENCRYPTION_MASTER_KEY'];

  if (!key) {
    return {
      name: 'encryption_master_key',
      status: 'fail',
      message: 'ENCRYPTION_MASTER_KEY is not set',
      durationMs: Date.now() - start,
    };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    return {
      name: 'encryption_master_key',
      status: 'fail',
      message: `ENCRYPTION_MASTER_KEY must be 64 hex chars (got ${key.length} chars, hex=${/^[0-9a-fA-F]+$/.test(key)})`,
      durationMs: Date.now() - start,
    };
  }

  // AES-256-GCM round-trip test
  try {
    const testData = 'preflight-test';
    const iv = crypto.randomBytes(12);
    const keyBuf = Buffer.from(key, 'hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    const encrypted = Buffer.concat([cipher.update(testData, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv, {
      authTagLength: 16,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
      'utf8',
    );

    if (decrypted !== testData) {
      return {
        name: 'encryption_master_key',
        status: 'fail',
        message: 'AES-256-GCM round-trip failed: decrypted data does not match',
        durationMs: Date.now() - start,
      };
    }

    return {
      name: 'encryption_master_key',
      status: 'pass',
      message: 'ENCRYPTION_MASTER_KEY valid (64 hex, AES-256-GCM round-trip OK)',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: 'encryption_master_key',
      status: 'fail',
      message: `AES-256-GCM round-trip error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

function checkRequiredEnvVars(): PreflightCheck {
  const start = Date.now();
  const required = ['JWT_SECRET', 'ENCRYPTION_MASTER_KEY'];
  const optional = ['EVAL_SERVICE_USER_ID'];
  const missing = required.filter((v) => !process.env[v]);
  const missingOptional = optional.filter((v) => !process.env[v]);

  if (missing.length > 0) {
    return {
      name: 'required_env_vars',
      status: 'fail',
      message: `Missing required env vars: ${missing.join(', ')}`,
      durationMs: Date.now() - start,
    };
  }

  if (missingOptional.length > 0) {
    return {
      name: 'required_env_vars',
      status: 'warn',
      message: `Optional env vars not set (using defaults): ${missingOptional.join(', ')}`,
      durationMs: Date.now() - start,
    };
  }

  return {
    name: 'required_env_vars',
    status: 'pass',
    message: 'All required env vars set',
    durationMs: Date.now() - start,
  };
}

async function checkLLMCredentialsAndProviderMatch(
  tenantId: string,
  projectId?: string,
): Promise<{ credCheck: PreflightCheck; providerCheck: PreflightCheck }> {
  const credStart = Date.now();
  let resolved: { apiKey: string; provider: string };
  let isResolutionError: PipelineLLMResolutionErrorPredicate = (
    _error: unknown,
  ): _error is {
    code: string;
    userMessage: string;
  } => false;

  try {
    const resolver = await import('../llm-client-factory.js');
    isResolutionError = resolver.isPipelineLLMResolutionError;
    resolved = await withTimeout(
      resolver.resolvePipelineLLM(tenantId, projectId),
      HEALTH_TIMEOUT_MS,
      'LLM credential resolution timed out',
    );
  } catch (err) {
    const { code, message } = describeLLMResolutionError(err, isResolutionError);
    const elapsed = Date.now() - credStart;
    return {
      credCheck: {
        name: 'llm_credentials',
        status: 'fail',
        code,
        message: `LLM credential resolution failed: ${message}`,
        durationMs: elapsed,
      },
      providerCheck: {
        name: 'provider_key_match',
        status: 'not_checked',
        code: 'NOT_CHECKED',
        message: `Provider/key match was not checked because LLM credentials could not be resolved: ${message}`,
        durationMs: elapsed,
      },
    };
  }

  const credCheck: PreflightCheck = {
    name: 'llm_credentials',
    status: 'pass',
    message: 'LLM credentials resolved successfully',
    durationMs: Date.now() - credStart,
  };

  // Provider/key heuristic
  const providerStart = Date.now();
  const { apiKey: key, provider } = resolved;

  if (provider === 'anthropic' && key.startsWith('sk-') && !key.startsWith('sk-ant-')) {
    return {
      credCheck,
      providerCheck: {
        name: 'provider_key_match',
        status: 'warn',
        message:
          'Provider is "anthropic" but API key starts with "sk-" (looks like OpenAI). Check credentials.',
        durationMs: Date.now() - providerStart,
      },
    };
  }
  if (provider === 'openai' && key.startsWith('sk-ant-')) {
    return {
      credCheck,
      providerCheck: {
        name: 'provider_key_match',
        status: 'warn',
        message:
          'Provider is "openai" but API key starts with "sk-ant-" (looks like Anthropic). Check credentials.',
        durationMs: Date.now() - providerStart,
      },
    };
  }

  return {
    credCheck,
    providerCheck: {
      name: 'provider_key_match',
      status: 'pass',
      message: `Provider "${provider}" and API key prefix are consistent`,
      durationMs: Date.now() - providerStart,
    },
  };
}

async function checkRuntimeReachable(): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${RUNTIME_URL}/health`, {
        signal: controller.signal,
      });
      if (res.ok) {
        return {
          name: 'runtime_reachable',
          status: 'pass',
          message: `Runtime at ${RUNTIME_URL} is healthy`,
          durationMs: Date.now() - start,
        };
      }
      return {
        name: 'runtime_reachable',
        status: 'fail',
        message: `Runtime health check returned ${res.status}: ${res.statusText}`,
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Runtime reachability check failed', { runtimeUrl: RUNTIME_URL, error: msg });
    return {
      name: 'runtime_reachable',
      status: 'fail',
      message: `Cannot reach Runtime at ${RUNTIME_URL}: ${msg}`,
      durationMs: Date.now() - start,
    };
  }
}

async function checkRuntimeAuth(tenantId: string): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    const token = createServiceToken(tenantId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${RUNTIME_URL}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        log.error('Runtime auth check failed — service JWT rejected', {
          status: res.status,
          runtimeUrl: RUNTIME_URL,
        });
        return {
          name: 'runtime_auth',
          status: 'fail',
          message: `Runtime rejected service JWT with ${res.status}. Check JWT_SECRET matches between pipeline-engine and runtime.`,
          durationMs: Date.now() - start,
        };
      }
      return {
        name: 'runtime_auth',
        status: 'pass',
        message: 'Service JWT accepted by Runtime',
        durationMs: Date.now() - start,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      name: 'runtime_auth',
      status: 'warn',
      message: `Could not verify Runtime auth: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

async function checkClickHouse(): Promise<PreflightCheck> {
  const start = Date.now();
  try {
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient() as unknown as {
      query(params: {
        query: string;
        format: 'JSONEachRow';
      }): Promise<{ json(): Promise<unknown[]> }>;
    };
    await withTimeout(
      client.query({
        query:
          'SELECT 1 FROM abl_platform.eval_conversations LIMIT 0 SETTINGS max_execution_time = 5',
        format: 'JSONEachRow',
      }),
      HEALTH_TIMEOUT_MS,
      'ClickHouse connection timed out',
    );
    return {
      name: 'clickhouse',
      status: 'pass',
      message: 'ClickHouse eval_conversations table accessible',
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('ClickHouse preflight check failed', { error: msg });
    return {
      name: 'clickhouse',
      status: 'warn',
      message: `ClickHouse check failed: ${msg}`,
      durationMs: Date.now() - start,
    };
  }
}

// ── Evaluator Model Checks ───────────────────────────────────────────

async function checkEvaluatorModels(
  tenantId: string,
  projectId: string | undefined,
  evaluatorModels: string[],
): Promise<PreflightCheck[]> {
  const uniqueModels = evaluatorModels.filter(
    (model, idx) => evaluatorModels.indexOf(model) === idx,
  );
  if (uniqueModels.length === 0) return [];

  const { resolvePipelineLLM, isPipelineLLMResolutionError } =
    await import('../llm-client-factory.js');

  const checks: PreflightCheck[] = [];
  for (const [index, modelId] of uniqueModels.entries()) {
    const start = Date.now();
    const checkName = `evaluator_model_${index + 1}`;
    try {
      await withTimeout(
        resolvePipelineLLM(tenantId, projectId, modelId, {
          allowFallbackOnExplicitModel: false,
        }),
        HEALTH_TIMEOUT_MS,
        'LLM credential resolution timed out',
      );
      checks.push({
        name: checkName,
        status: 'pass',
        message: 'Evaluator model resolved successfully',
        durationMs: Date.now() - start,
      });
    } catch (err) {
      log.warn('Evaluator model failed preflight resolution', {
        tenantId,
        projectId,
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      const { code, message } = describeLLMResolutionError(err, isPipelineLLMResolutionError);
      checks.push({
        name: checkName,
        status: 'fail',
        code,
        message: `Evaluator model resolution failed: ${message}`,
        durationMs: Date.now() - start,
      });
    }
  }
  return checks;
}

// ── Main Preflight Runner ────────────────────────────────────────────

export async function runEvalPreflight(
  tenantId: string,
  projectId?: string,
  options?: { evaluatorModels?: string[] },
): Promise<PreflightResult> {
  const isSystem = tenantId === '_system_';
  log.info('Eval preflight started', {
    tenantId,
    projectId,
    isSystem,
    evaluatorModelCount: options?.evaluatorModels?.length ?? 0,
  });

  // System-level checks (always run)
  const systemChecks = [
    checkEncryptionMasterKey(),
    Promise.resolve(checkRequiredEnvVars()),
    checkRuntimeReachable(),
    checkClickHouse(),
  ];

  // Tenant-specific checks (skip for system-level preflight)
  let tenantChecks: PreflightCheck[] = [];
  if (!isSystem) {
    const [credResults, runtimeAuth] = await Promise.all([
      checkLLMCredentialsAndProviderMatch(tenantId, projectId),
      checkRuntimeAuth(tenantId),
    ]);
    tenantChecks = [credResults.credCheck, credResults.providerCheck, runtimeAuth];
  }

  // Evaluator-specific model checks (when provided)
  let evaluatorModelChecks: PreflightCheck[] = [];
  if (!isSystem && options?.evaluatorModels?.length) {
    evaluatorModelChecks = await checkEvaluatorModels(tenantId, projectId, options.evaluatorModels);
  }

  const checks = [...(await Promise.all(systemChecks)), ...tenantChecks, ...evaluatorModelChecks];

  for (const check of checks) {
    if (check.status === 'fail') {
      log.error('Preflight check failed', {
        tenantId,
        projectId,
        check: check.name,
        message: check.message,
        durationMs: check.durationMs,
      });
    } else if (isPreflightWarningStatus(check.status)) {
      log.warn('Preflight check warned', {
        tenantId,
        projectId,
        check: check.name,
        message: check.message,
        durationMs: check.durationMs,
      });
    }
  }

  const overall = computeOverallStatus(checks);

  const result: PreflightResult = {
    overall,
    checks,
    timestamp: new Date().toISOString(),
  };

  log.info('Eval preflight completed', {
    tenantId,
    projectId,
    overall,
    checks: checks.map((c) => ({ name: c.name, status: c.status, durationMs: c.durationMs })),
  });

  return result;
}
