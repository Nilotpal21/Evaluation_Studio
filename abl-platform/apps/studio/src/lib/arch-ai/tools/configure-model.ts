/**
 * configure-model — Pure helpers + API-calling functions for the
 * configure_model tool.
 *
 * Pure helpers (Task 3): hasActiveOverride, classifyAgentConfig,
 * buildInspectResult, mergeConfigPayload.
 *
 * API callers (Task 4): fetchAgentConfig, fetchTenantModelsLive,
 * fetchProjectModelConfigs, createProjectModelConfig,
 * writeAgentModelConfig, ensureProjectModelConfig.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { areLlmProvidersPolicyEquivalent } from '@agent-platform/shared-kernel/llm-provider-identity';
import { buildModelRecommendationInputFromAgent } from '@/lib/arch-ai/helpers/model-recommendation-input';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Shape returned by the agent-model-config API */
export interface AgentModelConfigResponse {
  defaultModel: string | null;
  operationModels: Record<string, string> | null;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
}

/** Structured output of inspect_model_config */
export interface InspectResult {
  agentName: string;
  status: 'configured' | 'inherited';
  llmSelection?: {
    defaultModel: string | null;
    temperature: number | null;
    maxTokens: number | null;
    operationModels: Record<string, string> | null;
  };
  execution?: {
    hyperParameters: Record<string, unknown> | null;
    useResponsesApi: boolean | null;
    useStreaming: boolean | null;
  };
  message?: string;
}

/** Fields the configure_model tool is allowed to set */
export interface ConfigOverlay {
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  operationModels?: Record<string, string>;
}

/** Full payload sent to the PATCH endpoint after merging */
export interface MergedConfigPayload {
  defaultModel: string | null;
  operationModels: Record<string, string> | null;
  temperature: number | null;
  maxTokens: number | null;
  hyperParameters: Record<string, unknown> | null;
  useResponsesApi: boolean | null;
  useStreaming: boolean | null;
}

/* ------------------------------------------------------------------ */
/*  hasActiveOverride                                                  */
/* ------------------------------------------------------------------ */

/**
 * Determines whether an agent has ANY non-default model configuration.
 *
 * - Scalar fields (defaultModel, temperature, maxTokens, useResponsesApi,
 *   useStreaming): non-null means active.
 * - Object fields (operationModels, hyperParameters): must be non-null AND
 *   have at least one key.
 */
export function hasActiveOverride(config: AgentModelConfigResponse): boolean {
  // Scalar non-null checks
  if (config.defaultModel !== null) return true;
  if (config.temperature !== null) return true;
  if (config.maxTokens !== null) return true;
  if (config.useResponsesApi !== null) return true;
  if (config.useStreaming !== null) return true;

  // Object checks: non-null AND non-empty
  if (config.operationModels !== null && Object.keys(config.operationModels).length > 0) {
    return true;
  }
  if (config.hyperParameters !== null && Object.keys(config.hyperParameters).length > 0) {
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/*  classifyAgentConfig                                                */
/* ------------------------------------------------------------------ */

/**
 * Classify whether the agent has its own model config or inherits defaults.
 */
export function classifyAgentConfig(config: AgentModelConfigResponse): 'configured' | 'inherited' {
  return hasActiveOverride(config) ? 'configured' : 'inherited';
}

/* ------------------------------------------------------------------ */
/*  buildInspectResult                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build a structured inspect result grouping config fields into
 * llmSelection and execution sections. Inherited agents get a
 * descriptive message instead of field groups.
 */
export function buildInspectResult(
  agentName: string,
  config: AgentModelConfigResponse,
): InspectResult {
  const status = classifyAgentConfig(config);

  if (status === 'inherited') {
    return {
      agentName,
      status,
      message: `${agentName} has no overrides — all settings are inherited from the project or platform defaults.`,
    };
  }

  return {
    agentName,
    status,
    llmSelection: {
      defaultModel: config.defaultModel,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      operationModels: config.operationModels,
    },
    execution: {
      hyperParameters: config.hyperParameters,
      useResponsesApi: config.useResponsesApi,
      useStreaming: config.useStreaming,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  mergeConfigPayload                                                 */
/* ------------------------------------------------------------------ */

/**
 * Merge a partial overlay onto the current config to produce the full
 * PATCH payload. The overlay can set managed fields (defaultModel,
 * temperature, maxTokens, operationModels). Unmanaged fields
 * (hyperParameters, useResponsesApi, useStreaming) are always
 * preserved from current.
 */
export function mergeConfigPayload(
  current: AgentModelConfigResponse,
  overlay: ConfigOverlay,
): MergedConfigPayload {
  return {
    defaultModel: overlay.defaultModel !== undefined ? overlay.defaultModel : current.defaultModel,
    temperature: overlay.temperature !== undefined ? overlay.temperature : current.temperature,
    maxTokens: overlay.maxTokens !== undefined ? overlay.maxTokens : current.maxTokens,
    operationModels:
      overlay.operationModels !== undefined ? overlay.operationModels : current.operationModels,
    // Unmanaged — always carried from current
    hyperParameters: current.hyperParameters,
    useResponsesApi: current.useResponsesApi,
    useStreaming: current.useStreaming,
  };
}

/* ================================================================== */
/*  Task 4 — API-Calling Functions                                     */
/* ================================================================== */

const log = createLogger('arch-ai:configure-model');

/* ------------------------------------------------------------------ */
/*  Shared types & helpers                                             */
/* ------------------------------------------------------------------ */

/** Context required by every API call in this module. */
export interface FetchContext {
  projectId: string;
  tenantId: string;
  authToken: string;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function studioHeaders(ctx: FetchContext): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.authToken}`,
    'X-Tenant-Id': ctx.tenantId,
  };
}

/** Standard timeout applied to every fetch in this module. */
const FETCH_TIMEOUT_MS = 10_000;

/** Safely parse a JSON response body, returning null on failure. */
async function safeJsonParse(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch (_parseErr: unknown) {
    // Response body was not valid JSON — caller handles null
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  fetchAgentConfig                                                   */
/* ------------------------------------------------------------------ */

/**
 * GET the per-agent model-config from the runtime (proxied via Studio).
 * Returns the raw AgentModelConfigResponse on success or a descriptive
 * error string on failure. 404 is handled as "agent not found".
 */
export async function fetchAgentConfig(
  ctx: FetchContext,
  agentName: string,
): Promise<
  { success: true; config: AgentModelConfigResponse } | { success: false; error: string }
> {
  const url = `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(ctx.projectId)}/agents/${encodeURIComponent(agentName)}/model-config`;
  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return { success: false, error: `Agent '${agentName}' not found in project.` };
    }

    if (!res.ok) {
      return {
        success: false,
        error: `Failed to fetch agent model config: HTTP ${res.status}`,
      };
    }

    const body = await res.json();
    return { success: true, config: body as AgentModelConfigResponse };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('fetchAgentConfig failed', { agentName, projectId: ctx.projectId, error: message });
    return { success: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  fetchTenantModelsLive                                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/tenant-models — live call that bypasses caches.
 * Handles 403 with a specific INSUFFICIENT_PERMISSIONS code.
 */
export async function fetchTenantModelsLive(
  ctx: FetchContext,
): Promise<
  | { success: true; models: unknown[] }
  | { success: false; error: { code: string; message: string } }
> {
  const url = `${getStudioBaseUrl()}/api/tenant-models`;
  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 403) {
      return {
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message:
            'Model configuration requires credential:read permission to enumerate available models.',
        },
      };
    }

    if (!res.ok) {
      return {
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: `Failed to fetch tenant models: HTTP ${res.status}`,
        },
      };
    }

    const body = await res.json();
    const models: unknown[] = body.data ?? body.models ?? body;
    return { success: true, models };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('fetchTenantModelsLive failed', { tenantId: ctx.tenantId, error: message });
    return { success: false, error: { code: 'NETWORK_ERROR', message } };
  }
}

/* ------------------------------------------------------------------ */
/*  fetchProjectModelConfigs                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/models?projectId=<id> — list project-level ModelConfig entries.
 */
export async function fetchProjectModelConfigs(
  ctx: FetchContext,
): Promise<{ success: true; models: unknown[] } | { success: false; error: string }> {
  const url = `${getStudioBaseUrl()}/api/models?projectId=${encodeURIComponent(ctx.projectId)}`;
  try {
    const res = await fetch(url, {
      headers: studioHeaders(ctx),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Failed to fetch project model configs: HTTP ${res.status}`,
      };
    }

    const body = await res.json();
    const models: unknown[] = body.models ?? body.data ?? body;
    return { success: true, models };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('fetchProjectModelConfigs failed', { projectId: ctx.projectId, error: message });
    return { success: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  createProjectModelConfig                                           */
/* ------------------------------------------------------------------ */

interface CreateModelConfigParams {
  modelId: string;
  provider: string;
  tenantModelId: string;
  tier?: string;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
}

/**
 * POST /api/models — create a new project-level ModelConfig.
 * Populates sensible defaults for tier, temperature, etc.
 */
export async function createProjectModelConfig(
  ctx: FetchContext,
  params: CreateModelConfigParams,
): Promise<{ success: true; config: unknown } | { success: false; error: string }> {
  const url = `${getStudioBaseUrl()}/api/models`;
  const body = {
    projectId: ctx.projectId,
    name: params.modelId,
    modelId: params.modelId,
    provider: params.provider,
    tenantModelId: params.tenantModelId,
    supportsTools: params.supportsTools,
    supportsVision: params.supportsVision,
    supportsStreaming: params.supportsStreaming,
    contextWindow: params.contextWindow,
    tier: params.tier ?? 'balanced',
    isDefault: false,
    priority: 0,
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1.0,
    frequencyPenalty: 0,
    presencePenalty: 0,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: studioHeaders(ctx),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await safeJsonParse(res);
      const detail = (errBody as Record<string, unknown> | null)?.error ?? `HTTP ${res.status}`;
      return { success: false, error: `Failed to create project model config: ${detail}` };
    }

    const config = await res.json();
    return { success: true, config };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('createProjectModelConfig failed', {
      projectId: ctx.projectId,
      modelId: params.modelId,
      error: message,
    });
    return { success: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  writeAgentModelConfig                                              */
/* ------------------------------------------------------------------ */

/**
 * PUT /api/projects/:projectId/agents/:agentName/model-config
 * Writes the full MergedConfigPayload to the runtime.
 */
export async function writeAgentModelConfig(
  ctx: FetchContext,
  agentName: string,
  payload: MergedConfigPayload,
): Promise<{ success: true } | { success: false; error: string }> {
  const url = `${getStudioBaseUrl()}/api/projects/${encodeURIComponent(ctx.projectId)}/agents/${encodeURIComponent(agentName)}/model-config`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: studioHeaders(ctx),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errBody = await safeJsonParse(res);
      const detail = (errBody as Record<string, unknown> | null)?.error ?? `HTTP ${res.status}`;
      return { success: false, error: `Failed to write agent model config: ${detail}` };
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('writeAgentModelConfig failed', {
      agentName,
      projectId: ctx.projectId,
      error: message,
    });
    return { success: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/*  ensureProjectModelConfig                                           */
/* ------------------------------------------------------------------ */

/** Error codes emitted by ensureProjectModelConfig */
export type EnsureModelErrorCode =
  | 'MODEL_PROVIDER_CONFLICT'
  | 'MODEL_NOT_AVAILABLE'
  | 'AMBIGUOUS_TENANT_MODEL'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'FETCH_ERROR';

/**
 * Ensure the project has a ModelConfig entry for the given modelId.
 *
 * Validation flow:
 * 1. Fetch existing project ModelConfigs, filter by modelId.
 * 2. If a match exists with the same provider → success (no-op).
 * 3. If a match exists with a different provider → MODEL_PROVIDER_CONFLICT.
 * 4. If no match → fetch live tenant models, filter to usable
 *    (isActive, inferenceEnabled, has connections) for modelId + provider.
 * 5. Zero usable → MODEL_NOT_AVAILABLE.
 * 6. Multiple usable → AMBIGUOUS_TENANT_MODEL.
 * 7. Exactly one → create project ModelConfig from it.
 */
export async function ensureProjectModelConfig(
  ctx: FetchContext,
  modelId: string,
  provider: string,
): Promise<
  { success: true } | { success: false; error: { code: EnsureModelErrorCode; message: string } }
> {
  /* Step 1 — Check existing project ModelConfigs */
  const projectResult = await fetchProjectModelConfigs(ctx);
  if (!projectResult.success) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: projectResult.error },
    };
  }

  const existingConfigs = projectResult.models as Array<
    Record<string, unknown> & { modelId?: string; provider?: string }
  >;
  const matches = existingConfigs.filter((m) => m.modelId === modelId);

  /* Step 2 — Exact match (same provider) → already resolved */
  if (
    matches.some(
      (m) =>
        typeof m.provider === 'string' && areLlmProvidersPolicyEquivalent(m.provider, provider),
    )
  ) {
    return { success: true };
  }

  /* Step 3 — Match with different provider → conflict */
  if (matches.length > 0) {
    const existingProvider = matches[0]?.provider ?? 'unknown';
    return {
      success: false,
      error: {
        code: 'MODEL_PROVIDER_CONFLICT',
        message: `Model '${modelId}' already exists in the project with provider '${existingProvider}'. Cannot add with provider '${provider}'.`,
      },
    };
  }

  /* Step 4 — No match: live tenant model lookup */
  const tenantResult = await fetchTenantModelsLive(ctx);
  if (!tenantResult.success) {
    const tenantErr = tenantResult.error;
    return {
      success: false,
      error: {
        code: tenantErr.code as EnsureModelErrorCode,
        message: tenantErr.message,
      },
    };
  }

  const tenantModels = tenantResult.models as Array<Record<string, unknown>>;

  /** A tenant model is usable when it is active, inference-enabled, and has
   *  at least one connection (credential). */
  const usable = tenantModels.filter((tm) => {
    if (tm.modelId !== modelId) return false;
    if (
      typeof tm.provider !== 'string' ||
      !areLlmProvidersPolicyEquivalent(tm.provider, provider)
    ) {
      return false;
    }
    if (!tm.isActive) return false;
    if (tm.inferenceEnabled === false) return false;
    // connections can be an array or a count — treat missing as zero
    const conns = tm.connections;
    if (Array.isArray(conns) && conns.length === 0) return false;
    if (typeof conns === 'number' && conns === 0) return false;
    return true;
  });

  /* Step 5 — Zero usable */
  if (usable.length === 0) {
    return {
      success: false,
      error: {
        code: 'MODEL_NOT_AVAILABLE',
        message: `No usable tenant model found for '${modelId}' (provider: ${provider}). Ensure the model is active, inference-enabled, and has at least one connection.`,
      },
    };
  }

  /* Step 6 — Ambiguous (multiple usable) */
  if (usable.length > 1) {
    return {
      success: false,
      error: {
        code: 'AMBIGUOUS_TENANT_MODEL',
        message: `Multiple usable tenant models found for '${modelId}' (provider: ${provider}). Cannot auto-select — please resolve manually.`,
      },
    };
  }

  /* Step 7 — Exactly one: create project ModelConfig */
  const tm = usable[0] as Record<string, unknown>;
  const createResult = await createProjectModelConfig(ctx, {
    modelId,
    provider,
    tenantModelId: String(tm.id ?? ''),
    tier: typeof tm.tier === 'string' ? tm.tier : 'balanced',
    supportsTools: Boolean(tm.supportsTools ?? true),
    supportsVision: Boolean(tm.supportsVision ?? false),
    supportsStreaming: Boolean(tm.supportsStreaming ?? true),
    contextWindow: Number(tm.contextWindow ?? 128_000),
  });

  if (!createResult.success) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: createResult.error },
    };
  }

  log.info('Created project ModelConfig from tenant model', {
    projectId: ctx.projectId,
    modelId,
    provider,
    tenantModelId: String(tm.id ?? ''),
  });

  return { success: true };
}

/* ================================================================== */
/*  Task 5 — Execute Layer                                             */
/* ================================================================== */

import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import type { ModelRecommendation } from '../types';

/* ------------------------------------------------------------------ */
/*  Input / Output Types                                               */
/* ------------------------------------------------------------------ */

export interface ConfigureModelInput {
  action: 'inspect' | 'diff' | 'apply';
  agentName: string;
  source?: 'recommendation' | 'manual';
  modelId?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  operationModels?: Record<string, string>;
  confirmed?: boolean;
}

export interface ConfigureModelResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string; availableModels?: string[] };
  needsConfirmation?: boolean;
  warning?: string;
  cancelled?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** Build the FetchContext from the execute-layer's ctx + projectId. */
function buildFetchCtx(
  ctx: ToolPermissionContext & { authToken: string },
  projectId: string,
): FetchContext {
  return {
    projectId,
    tenantId: ctx.user.tenantId,
    authToken: ctx.authToken,
  };
}

/* ------------------------------------------------------------------ */
/*  executeInspect                                                      */
/* ------------------------------------------------------------------ */

async function executeInspect(
  fetchCtx: FetchContext,
  agentName: string,
  projectId: string,
  tenantId: string,
): Promise<ConfigureModelResult> {
  if (agentName === 'all') {
    const { ProjectAgent } = await import('@agent-platform/database/models');
    const agents = await ProjectAgent.find({ projectId, tenantId });

    if (agents.length === 0) {
      return {
        success: true,
        data: { agents: [], message: 'No agents found in project.' },
      };
    }

    const results: InspectResult[] = [];
    const errors: Array<{ agentName: string; error: string }> = [];

    for (const agent of agents) {
      const name = (agent as Record<string, unknown>).name as string;
      const configResult = await fetchAgentConfig(fetchCtx, name);
      if (configResult.success) {
        results.push(buildInspectResult(name, configResult.config));
      } else {
        errors.push({ agentName: name, error: configResult.error });
      }
    }

    return {
      success: true,
      data: {
        agents: results,
        ...(errors.length > 0 ? { errors } : {}),
        total: agents.length,
      },
    };
  }

  // Single agent
  const configResult = await fetchAgentConfig(fetchCtx, agentName);
  if (!configResult.success) {
    return {
      success: false,
      error: { code: 'FETCH_ERROR', message: configResult.error },
    };
  }

  return {
    success: true,
    data: buildInspectResult(agentName, configResult.config),
  };
}

/* ------------------------------------------------------------------ */
/*  executeDiff                                                         */
/* ------------------------------------------------------------------ */

interface DiffEntry {
  agentName: string;
  current: {
    defaultModel: string | null;
    temperature: number | null;
    maxTokens: number | null;
  };
  recommended: {
    model: string;
    provider: string;
    temperature: number;
    maxTokens: number;
  };
  reason: string;
  changed: boolean;
}

async function executeDiff(
  fetchCtx: FetchContext,
  agentName: string,
  projectId: string,
  tenantId: string,
): Promise<ConfigureModelResult> {
  const { getModelRecommendation } = await import('@/lib/arch-ai/helpers/get-model-recommendation');
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const buildDiff = async (
    name: string,
    agent: Record<string, unknown>,
  ): Promise<DiffEntry | { agentName: string; error: string }> => {
    const configResult = await fetchAgentConfig(fetchCtx, name);
    if (!configResult.success) {
      return { agentName: name, error: configResult.error };
    }

    const rec: ModelRecommendation = getModelRecommendation(
      buildModelRecommendationInputFromAgent(agent),
    );

    const current = configResult.config;
    const changed =
      current.defaultModel !== rec.primary.model ||
      current.temperature !== rec.executionConfig.temperature ||
      current.maxTokens !== rec.executionConfig.maxTokens;

    return {
      agentName: name,
      current: {
        defaultModel: current.defaultModel,
        temperature: current.temperature,
        maxTokens: current.maxTokens,
      },
      recommended: {
        model: rec.primary.model,
        provider: rec.primary.provider,
        temperature: rec.executionConfig.temperature,
        maxTokens: rec.executionConfig.maxTokens,
      },
      reason: rec.primary.reason,
      changed,
    };
  };

  if (agentName === 'all') {
    const agents = await ProjectAgent.find({ projectId, tenantId });
    if (agents.length === 0) {
      return {
        success: true,
        data: { diffs: [], message: 'No agents found in project.' },
      };
    }

    const diffs: Array<DiffEntry | { agentName: string; error: string }> = [];
    for (const agent of agents) {
      const doc = agent as unknown as Record<string, unknown>;
      const name = doc.name as string;
      diffs.push(await buildDiff(name, doc));
    }

    return { success: true, data: { diffs, total: agents.length } };
  }

  // Single agent
  const agent = await ProjectAgent.findOne({ projectId, tenantId, name: agentName });
  if (!agent) {
    return {
      success: false,
      error: { code: 'AGENT_NOT_FOUND', message: `Agent '${agentName}' not found.` },
    };
  }

  const diff = await buildDiff(agentName, agent as unknown as Record<string, unknown>);
  return { success: true, data: diff };
}

/* ------------------------------------------------------------------ */
/*  executeApply                                                        */
/* ------------------------------------------------------------------ */

async function executeApply(
  fetchCtx: FetchContext,
  input: ConfigureModelInput,
  projectId: string,
  tenantId: string,
): Promise<ConfigureModelResult> {
  // --- Confirmation gate for dangerous action ---
  if (isDangerousAction('configure_model', 'apply') && !input.confirmed) {
    // Build a preview diff so the user knows what will change
    const diffResult = await executeDiff(fetchCtx, input.agentName, projectId, tenantId);
    return {
      needsConfirmation: true,
      warning: `Applying model configuration changes is a dangerous action. Please confirm to proceed.`,
      data: { diff: diffResult.data },
    };
  }

  if (input.source === 'recommendation') {
    return applyRecommendation(fetchCtx, input, projectId, tenantId);
  }

  if (input.source === 'manual') {
    return applyManual(fetchCtx, input, projectId, tenantId);
  }

  return {
    success: false,
    error: {
      code: 'INVALID_SOURCE',
      message: `source must be 'recommendation' or 'manual', got '${input.source ?? 'undefined'}'.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  applyRecommendation                                                 */
/* ------------------------------------------------------------------ */

async function applyRecommendation(
  fetchCtx: FetchContext,
  input: ConfigureModelInput,
  projectId: string,
  tenantId: string,
): Promise<ConfigureModelResult> {
  const { getModelRecommendation } = await import('@/lib/arch-ai/helpers/get-model-recommendation');
  const { ProjectAgent } = await import('@agent-platform/database/models');

  const applyToAgent = async (
    name: string,
    agent: Record<string, unknown>,
  ): Promise<{ agentName: string; status: 'applied' | 'skipped' | 'error'; detail?: string }> => {
    const rec: ModelRecommendation = getModelRecommendation(
      buildModelRecommendationInputFromAgent(agent),
    );

    if (rec.tenantFilterUnavailable) {
      return {
        agentName: name,
        status: 'skipped',
        detail: `Recommended model '${rec.primary.model}' is not available in tenant. Skipping.`,
      };
    }

    // Ensure the project has a ModelConfig entry for the recommended model
    const ensureResult = await ensureProjectModelConfig(
      fetchCtx,
      rec.primary.model,
      rec.primary.provider,
    );
    if (!ensureResult.success) {
      return {
        agentName: name,
        status: 'error',
        detail: ensureResult.error.message,
      };
    }

    // Read current config, merge overlay, write back
    const currentResult = await fetchAgentConfig(fetchCtx, name);
    if (!currentResult.success) {
      return { agentName: name, status: 'error', detail: currentResult.error };
    }

    const overlay: ConfigOverlay = {
      defaultModel: rec.primary.model,
      temperature: rec.executionConfig.temperature,
      maxTokens: rec.executionConfig.maxTokens,
      ...(rec.perOperation
        ? {
            operationModels: Object.fromEntries(
              Object.entries(rec.perOperation).map(([op, sm]) => [op, sm.model]),
            ),
          }
        : {}),
    };

    const merged = mergeConfigPayload(currentResult.config, overlay);
    const writeResult = await writeAgentModelConfig(fetchCtx, name, merged);
    if (!writeResult.success) {
      return { agentName: name, status: 'error', detail: writeResult.error };
    }

    log.info('Applied recommended model config', {
      agentName: name,
      model: rec.primary.model,
      provider: rec.primary.provider,
      projectId,
    });

    return { agentName: name, status: 'applied' };
  };

  if (input.agentName === 'all') {
    const agents = await ProjectAgent.find({ projectId, tenantId });
    if (agents.length === 0) {
      return {
        success: true,
        data: { results: [], message: 'No agents found in project.' },
      };
    }

    const results: Array<{
      agentName: string;
      status: 'applied' | 'skipped' | 'error';
      detail?: string;
    }> = [];
    for (const agent of agents) {
      const doc = agent as unknown as Record<string, unknown>;
      const name = doc.name as string;
      results.push(await applyToAgent(name, doc));
    }

    const applied = results.filter((r) => r.status === 'applied').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const errored = results.filter((r) => r.status === 'error').length;

    return {
      success: errored === 0,
      data: { results, stats: { total: agents.length, applied, skipped, errors: errored } },
    };
  }

  // Single agent
  const agent = await ProjectAgent.findOne({ projectId, tenantId, name: input.agentName });
  if (!agent) {
    return {
      success: false,
      error: { code: 'AGENT_NOT_FOUND', message: `Agent '${input.agentName}' not found.` },
    };
  }

  const result = await applyToAgent(input.agentName, agent as unknown as Record<string, unknown>);
  return {
    success: result.status === 'applied',
    data: result,
    ...(result.status === 'error' && result.detail
      ? { error: { code: 'APPLY_FAILED', message: result.detail } }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  applyManual                                                         */
/* ------------------------------------------------------------------ */

async function applyManual(
  fetchCtx: FetchContext,
  input: ConfigureModelInput,
  projectId: string,
  tenantId: string,
): Promise<ConfigureModelResult> {
  if (!input.modelId || !input.provider) {
    return {
      success: false,
      error: {
        code: 'MISSING_FIELDS',
        message: `Manual apply requires both 'modelId' and 'provider'.`,
      },
    };
  }

  const { ProjectAgent } = await import('@agent-platform/database/models');

  const applyToAgent = async (
    name: string,
  ): Promise<{ agentName: string; status: 'applied' | 'error'; detail?: string }> => {
    // Ensure project has a ModelConfig entry for the specified model
    const ensureResult = await ensureProjectModelConfig(fetchCtx, input.modelId!, input.provider!);
    if (!ensureResult.success) {
      return { agentName: name, status: 'error', detail: ensureResult.error.message };
    }

    // Read current, merge, write
    const currentResult = await fetchAgentConfig(fetchCtx, name);
    if (!currentResult.success) {
      return { agentName: name, status: 'error', detail: currentResult.error };
    }

    const overlay: ConfigOverlay = {
      defaultModel: input.modelId,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.operationModels !== undefined ? { operationModels: input.operationModels } : {}),
    };

    const merged = mergeConfigPayload(currentResult.config, overlay);
    const writeResult = await writeAgentModelConfig(fetchCtx, name, merged);
    if (!writeResult.success) {
      return { agentName: name, status: 'error', detail: writeResult.error };
    }

    log.info('Applied manual model config', {
      agentName: name,
      model: input.modelId,
      provider: input.provider,
      projectId,
    });

    return { agentName: name, status: 'applied' };
  };

  if (input.agentName === 'all') {
    const agents = await ProjectAgent.find({ projectId, tenantId });
    if (agents.length === 0) {
      return {
        success: true,
        data: { results: [], message: 'No agents found in project.' },
      };
    }

    const results: Array<{
      agentName: string;
      status: 'applied' | 'error';
      detail?: string;
    }> = [];
    for (const agent of agents) {
      const name = (agent as unknown as Record<string, unknown>).name as string;
      results.push(await applyToAgent(name));
    }

    const applied = results.filter((r) => r.status === 'applied').length;
    const errored = results.filter((r) => r.status === 'error').length;

    return {
      success: errored === 0,
      data: { results, stats: { total: agents.length, applied, errors: errored } },
    };
  }

  // Single agent
  const agentExists = await ProjectAgent.findOne({ projectId, tenantId, name: input.agentName });
  if (!agentExists) {
    return {
      success: false,
      error: { code: 'AGENT_NOT_FOUND', message: `Agent '${input.agentName}' not found.` },
    };
  }

  const result = await applyToAgent(input.agentName);
  return {
    success: result.status === 'applied',
    data: result,
    ...(result.status === 'error' && result.detail
      ? { error: { code: 'APPLY_FAILED', message: result.detail } }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  executeConfigureModel — Main entry point                            */
/* ------------------------------------------------------------------ */

/**
 * Execute the configure_model tool.
 *
 * Actions:
 * - inspect: Show current model config for one or all agents.
 * - diff: Compare current config against recommendations.
 * - apply: Write model config (from recommendation or manual input).
 */
export async function executeConfigureModel(
  input: ConfigureModelInput,
  ctx: ToolPermissionContext & { authToken: string },
  projectId: string,
): Promise<ConfigureModelResult> {
  // --- Permission check ---
  const permCheck = await checkToolPermission('configure_model', input.action, ctx);
  if (!permCheck.allowed) {
    return {
      success: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: permCheck.error ?? 'Permission denied',
      },
    };
  }

  const fetchCtx = buildFetchCtx(ctx, projectId);
  const tenantId = ctx.user.tenantId;

  switch (input.action) {
    case 'inspect':
      return executeInspect(fetchCtx, input.agentName, projectId, tenantId);

    case 'diff':
      return executeDiff(fetchCtx, input.agentName, projectId, tenantId);

    case 'apply':
      return executeApply(fetchCtx, input, projectId, tenantId);

    default: {
      const exhaustive: never = input.action;
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action '${exhaustive}'.`,
        },
      };
    }
  }
}
