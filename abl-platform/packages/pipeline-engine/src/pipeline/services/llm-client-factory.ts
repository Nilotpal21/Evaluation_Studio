/**
 * Pipeline LLM Resolution — resolves which LLM to use for pipeline processing.
 *
 * This module ONLY identifies the right model. It does NOT make API calls.
 * Actual LLM invocation is handled by `@agent-platform/llm` (WorkerLLMClient).
 *
 * Resolution hierarchy (first match wins):
 *   1. Pipeline-level: explicit model in pipeline config → find matching TenantModel
 *   2. Project-level:  ModelConfig(tenantId, projectId, isDefault) → TenantModel → LLMCredential
 *   3. Tenant-level:   TenantModel(isDefault) → fallback to any active TenantModel
 *   4. FAIL: throw (no env var fallback)
 *
 * IMPORTANT: `as any` casts are used ONLY on Mongoose lean() results which
 * lose their interface types. All function signatures are fully typed.
 */
import { createLogger } from '@abl/compiler/platform';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import type { ITenantModel } from '@agent-platform/database/models';

const log = createLogger('pipeline-llm-resolver');

// ---------------------------------------------------------------------------
// Public interface — the resolved model tuple
// ---------------------------------------------------------------------------

export interface ResolvedPipelineLLM {
  /** Provider name as stored in DB (e.g. 'anthropic', 'openai', 'groq', 'mistral'). */
  provider: string;
  /** Full model ID (e.g. 'claude-haiku-4-5', 'gpt-4o-mini'). */
  modelId: string;
  /** Decrypted API key ready for use. */
  apiKey: string;
  /** Custom base URL if the credential specifies one. */
  baseUrl?: string;
  /** Provider-specific auth settings (for example Azure resourceName or deploymentId). */
  authConfig?: Record<string, unknown>;
  /** Where the model was resolved from — useful for logging/debugging. */
  source: 'pipeline' | 'project' | 'tenant';
}

export interface ResolvePipelineLLMOptions {
  /**
   * Preserve the historic pipeline fallback behavior by default: when an
   * explicit model id is unavailable, fall through to project/tenant defaults.
   * Eval judges opt out so a configured judge model cannot silently run on a
   * different model.
   */
  allowFallbackOnExplicitModel?: boolean;
}

export type PipelineLLMResolutionCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_INACTIVE'
  | 'INFERENCE_DISABLED'
  | 'KEY_INVALID'
  | 'NO_MODEL_ID'
  | 'NO_PROJECT_DEFAULT';

export interface PipelineLLMResolutionFailure {
  code: PipelineLLMResolutionCode;
  userMessage: string;
  logContext: Record<string, unknown>;
}

type ResolverResult = ResolverSuccess | ResolverFailure;

interface ResolverSuccess {
  ok: true;
  data: Omit<ResolvedPipelineLLM, 'source'>;
}

interface ResolverFailure {
  ok: false;
  failure: PipelineLLMResolutionFailure;
}

const FAILURE_PRIORITY: Record<PipelineLLMResolutionCode, number> = {
  KEY_INVALID: 100,
  INFERENCE_DISABLED: 90,
  MODEL_INACTIVE: 80,
  NO_MODEL_ID: 70,
  MODEL_NOT_FOUND: 60,
  PROVIDER_NOT_CONFIGURED: 30,
  NO_PROJECT_DEFAULT: 20,
};

export class PipelineLLMResolutionError extends Error {
  readonly code: PipelineLLMResolutionCode;
  readonly userMessage: string;
  declare readonly failures: readonly PipelineLLMResolutionFailure[];

  constructor(failures: readonly PipelineLLMResolutionFailure[]) {
    const primary = selectPrimaryFailure(failures);
    super(primary.userMessage);
    this.name = 'PipelineLLMResolutionError';
    this.code = primary.code;
    this.userMessage = primary.userMessage;
    Object.defineProperty(this, 'failures', {
      value: failures,
      enumerable: false,
    });
  }
}

export function isPipelineLLMResolutionError(error: unknown): error is PipelineLLMResolutionError {
  return error instanceof PipelineLLMResolutionError;
}

function selectPrimaryFailure(
  failures: readonly PipelineLLMResolutionFailure[],
): PipelineLLMResolutionFailure {
  return (
    failures.slice().sort((a, b) => FAILURE_PRIORITY[b.code] - FAILURE_PRIORITY[a.code])[0] ??
    failure('PROVIDER_NOT_CONFIGURED', 'No active inference model is configured.', {})
  );
}

function failure(
  code: PipelineLLMResolutionCode,
  userMessage: string,
  logContext: Record<string, unknown>,
): PipelineLLMResolutionFailure {
  return { code, userMessage, logContext };
}

function unavailableTenantModelFailure(
  tm: Pick<ITenantModel, '_id' | 'tenantId' | 'modelId' | 'isActive' | 'inferenceEnabled'>,
  level: string,
): PipelineLLMResolutionFailure | null {
  const logContext = {
    level,
    tenantId: tm.tenantId,
    tenantModelId: String(tm._id),
    modelId: tm.modelId,
    isActive: tm.isActive,
    inferenceEnabled: tm.inferenceEnabled,
  };

  if (tm.isActive === false) {
    return failure(
      'MODEL_INACTIVE',
      'Configured LLM model exists but is inactive. Activate it before running evals.',
      logContext,
    );
  }

  if (tm.inferenceEnabled === false) {
    return failure(
      'INFERENCE_DISABLED',
      'Configured LLM model exists but inference is disabled. Enable inference for the model before running evals.',
      logContext,
    );
  }

  return null;
}

function noConfiguredModelFailure(tenantId: string, level: string): PipelineLLMResolutionFailure {
  return failure(
    'PROVIDER_NOT_CONFIGURED',
    'No active inference model is configured. Configure a model in project settings or tenant admin.',
    { level, tenantId },
  );
}

// ---------------------------------------------------------------------------
// Resolution entry point
// ---------------------------------------------------------------------------

/**
 * Resolve which LLM to use for a pipeline run.
 *
 * @param tenantId  - Tenant scope
 * @param projectId - Project scope (optional, enables project-level resolution)
 * @param pipelineModelId - Model ID from pipeline config (optional, highest priority)
 */
export async function resolvePipelineLLM(
  tenantId: string,
  projectId?: string,
  pipelineModelId?: string,
  options: ResolvePipelineLLMOptions = {},
): Promise<ResolvedPipelineLLM> {
  const failures: PipelineLLMResolutionFailure[] = [];

  // 1. Pipeline-level: explicit model configured on the pipeline
  if (pipelineModelId) {
    const result = await resolveByModelId(tenantId, pipelineModelId);
    if (result.ok) {
      log.info('Pipeline LLM resolved from pipeline config', {
        tenantId,
        projectId,
        modelId: result.data.modelId,
        provider: result.data.provider,
      });
      return { ...result.data, source: 'pipeline' };
    }
    failures.push(result.failure);
    const allowFallback = options.allowFallbackOnExplicitModel ?? true;
    log.warn('Pipeline-configured model not found or inactive', {
      tenantId,
      pipelineModelId,
      allowFallback,
      reasonCode: result.failure.code,
      reasonContext: result.failure.logContext,
    });
    if (!allowFallback) {
      throw new PipelineLLMResolutionError(failures);
    }
  }

  // 2. Project-level: project's default ModelConfig → TenantModel → credential
  if (projectId) {
    const result = await resolveByProject(tenantId, projectId);
    if (result.ok) {
      log.info('Pipeline LLM resolved from project config', {
        tenantId,
        projectId,
        modelId: result.data.modelId,
        provider: result.data.provider,
      });
      return { ...result.data, source: 'project' };
    }
    failures.push(result.failure);
  }

  // 3. Tenant-level: default TenantModel, then fallback to any active model
  const result = await resolveByTenant(tenantId);
  if (result.ok) {
    log.info('Pipeline LLM resolved from tenant default', {
      tenantId,
      modelId: result.data.modelId,
      provider: result.data.provider,
    });
    return { ...result.data, source: 'tenant' };
  }
  failures.push(result.failure);

  log.warn('Pipeline LLM resolution failed', {
    tenantId,
    projectId,
    pipelineModelId,
    failures: failures.map((f) => ({ code: f.code, ...f.logContext })),
  });
  throw new PipelineLLMResolutionError(failures);
}

// ---------------------------------------------------------------------------
// Level 1: Pipeline-level — find TenantModel matching a specific modelId
// ---------------------------------------------------------------------------

async function resolveByModelId(tenantId: string, modelId: string): Promise<ResolverResult> {
  const { TenantModel } = await import('@agent-platform/database/models');

  let tm = await TenantModel.findOne({
    tenantId,
    modelId,
    isActive: true,
    inferenceEnabled: true,
  });

  if (!tm) {
    const configured = await TenantModel.findOne({ tenantId, modelId });
    if (configured) {
      const unavailable = unavailableTenantModelFailure(configured, 'pipeline');
      if (unavailable) {
        return { ok: false, failure: unavailable };
      }
    }
  }

  // 2. Dated suffix fallback — handles short names like "claude-sonnet-4-6"
  //    matching "claude-sonnet-4-6-20260217" without treating distinct
  //    variants like "gpt-4o-mini" as aliases for "gpt-4o".
  if (!tm) {
    // Escape regex special characters to prevent injection
    const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const datedSuffixPattern = `^${escaped}-(?:\\d{8}|\\d{4}-\\d{2}-\\d{2})$`;
    tm = await TenantModel.findOne({
      tenantId,
      modelId: { $regex: datedSuffixPattern },
      isActive: true,
      inferenceEnabled: true,
    })
      .sort({ modelId: -1 }) // Prefer latest dated version if multiple match
      .exec();

    if (tm) {
      log.info('Pipeline LLM resolved via prefix match', {
        tenantId,
        requestedModelId: modelId,
        resolvedModelId: tm.modelId,
      });
    }

    if (!tm) {
      const configured = await TenantModel.findOne({
        tenantId,
        modelId: { $regex: datedSuffixPattern },
      })
        .sort({ modelId: -1 })
        .exec();
      if (configured) {
        const unavailable = unavailableTenantModelFailure(configured, 'pipeline');
        if (unavailable) {
          return { ok: false, failure: unavailable };
        }
      }
    }
  }

  if (!tm) {
    return {
      ok: false,
      failure: failure(
        'MODEL_NOT_FOUND',
        'Configured LLM model was not found. Select an active model with configured credentials.',
        { level: 'pipeline', tenantId, modelId },
      ),
    };
  }
  return resolveCredential(tm, tenantId);
}

// ---------------------------------------------------------------------------
// Level 2: Project-level — ModelConfig → TenantModel → credential
// ---------------------------------------------------------------------------

async function resolveByProject(tenantId: string, projectId: string): Promise<ResolverResult> {
  const { ModelConfig } = await import('@agent-platform/database/models');

  const mc = await ModelConfig.findOne({ tenantId, projectId, isDefault: true }).lean();
  if (!mc?.tenantModelId) {
    return {
      ok: false,
      failure: failure(
        'NO_PROJECT_DEFAULT',
        'No default LLM model is configured for this project.',
        {
          level: 'project',
          tenantId,
          projectId,
        },
      ),
    };
  }

  const { TenantModel } = await import('@agent-platform/database/models');
  const tm = await TenantModel.findOne({
    _id: mc.tenantModelId,
    tenantId,
  });

  if (!tm) {
    return {
      ok: false,
      failure: failure(
        'MODEL_NOT_FOUND',
        'Project default LLM model was not found. Select an active model with configured credentials.',
        { level: 'project', tenantId, projectId, tenantModelId: mc.tenantModelId },
      ),
    };
  }

  const unavailable = unavailableTenantModelFailure(tm, 'project');
  if (unavailable) {
    return { ok: false, failure: unavailable };
  }

  return resolveCredential(tm, tenantId);
}

// ---------------------------------------------------------------------------
// Level 3: Tenant-level — default TenantModel, fallback to any active
// ---------------------------------------------------------------------------

async function resolveByTenant(tenantId: string): Promise<ResolverResult> {
  const { TenantModel } = await import('@agent-platform/database/models');

  // Prefer the tenant's default inference model
  let tm = await TenantModel.findOne({
    tenantId,
    isDefault: true,
    isActive: true,
    inferenceEnabled: true,
  });

  // Fallback: any active inference-enabled model
  if (!tm) {
    tm = await TenantModel.findOne({
      tenantId,
      isActive: true,
      inferenceEnabled: true,
    });
  }

  if (!tm) {
    const configuredDefault = await TenantModel.findOne({
      tenantId,
      isDefault: true,
    });
    if (configuredDefault) {
      const unavailable = unavailableTenantModelFailure(configuredDefault, 'tenant');
      if (unavailable) {
        return { ok: false, failure: unavailable };
      }
    }

    const configuredAny = await TenantModel.findOne({ tenantId });
    if (configuredAny) {
      const unavailable = unavailableTenantModelFailure(configuredAny, 'tenant');
      if (unavailable) {
        return { ok: false, failure: unavailable };
      }
    }

    return { ok: false, failure: noConfiguredModelFailure(tenantId, 'tenant') };
  }
  return resolveCredential(tm, tenantId);
}

// ---------------------------------------------------------------------------
// Shared: TenantModel → credential extraction
// ---------------------------------------------------------------------------

/**
 * Extract provider, modelId, apiKey, and baseUrl from a TenantModel.
 *
 * IMPORTANT: The credential query must NOT use lean() so the Mongoose
 * encryption plugin can decrypt encryptedApiKey in the post-find hook.
 * Legacy failures may still leave ciphertext behind, so callers must
 * resolve a safe plaintext value before returning credentials.
 */
function normalizeCredentialAuthConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : undefined;
    } catch {
      return undefined;
    }
  }

  return typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

async function resolveCredential(tm: ITenantModel, tenantId: string): Promise<ResolverResult> {
  const { LLMCredential } = await import('@agent-platform/database/models');

  // Prefer primary active connection, fall back to any active connection
  const conn =
    tm.connections?.find(
      (c: { isActive: boolean; isPrimary: boolean }) => c.isActive && c.isPrimary,
    ) ?? tm.connections?.find((c: { isActive: boolean }) => c.isActive);

  if (!conn?.credentialId) {
    log.warn('TenantModel has no active connection with credential', {
      tenantModelId: String(tm._id),
      tenantId,
    });
    return {
      ok: false,
      failure: failure(
        'KEY_INVALID',
        'Configured LLM model has no active credential connection. Add or activate a credential connection.',
        { tenantModelId: String(tm._id), tenantId, modelId: tm.modelId },
      ),
    };
  }

  // No lean() — encryption plugin usually auto-decrypts encryptedApiKey
  const cred = await LLMCredential.findOne({ _id: conn.credentialId, tenantId });
  if (!cred?.encryptedApiKey) {
    log.warn('LLMCredential not found or missing API key', {
      credentialId: String(conn.credentialId),
      tenantId,
    });
    return {
      ok: false,
      failure: failure(
        'KEY_INVALID',
        'Configured LLM credential is missing or has no API key. Reconnect the provider credential.',
        {
          tenantModelId: String(tm._id),
          tenantId,
          modelId: tm.modelId,
          credentialId: String(conn.credentialId),
        },
      ),
    };
  }

  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  try {
    apiKey = await resolveTenantPlaintextValue(cred.encryptedApiKey, tenantId, {
      decryptionFailed: Boolean((cred as { _decryptionFailed?: boolean })._decryptionFailed),
    });
    baseUrl = await resolveTenantPlaintextValue(cred.encryptedEndpoint ?? null, tenantId);
  } catch (error) {
    log.warn('LLMCredential unavailable after decryption', {
      credentialId: String(conn.credentialId),
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      failure: failure(
        'KEY_INVALID',
        'Configured LLM credential could not be read. Reconnect the provider credential or contact an administrator.',
        {
          tenantModelId: String(tm._id),
          tenantId,
          modelId: tm.modelId,
          credentialId: String(conn.credentialId),
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    };
  }

  if (!apiKey) {
    log.warn('LLMCredential not found or missing API key', {
      credentialId: String(conn.credentialId),
      tenantId,
    });
    return {
      ok: false,
      failure: failure(
        'KEY_INVALID',
        'Configured LLM credential resolved to an empty API key. Reconnect the provider credential.',
        {
          tenantModelId: String(tm._id),
          tenantId,
          modelId: tm.modelId,
          credentialId: String(conn.credentialId),
        },
      ),
    };
  }

  const provider = cred.provider ?? tm.provider ?? 'openai';
  const modelId = tm.modelId;
  if (!modelId) {
    log.warn('TenantModel has no modelId', { tenantModelId: String(tm._id), tenantId });
    return {
      ok: false,
      failure: failure(
        'NO_MODEL_ID',
        'Configured LLM model is missing a model ID. Select a valid model before running evals.',
        { tenantModelId: String(tm._id), tenantId },
      ),
    };
  }

  return {
    ok: true,
    data: {
      provider,
      modelId,
      apiKey,
      baseUrl: baseUrl ?? undefined,
      authConfig: normalizeCredentialAuthConfig(cred.authConfig),
    },
  };
}
