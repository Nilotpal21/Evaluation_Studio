/**
 * Model Resolution Service
 *
 * 5-level model resolution chain:
 * 0. Deployment model override (highest priority)
 * 1. Agent IR (DSL-defined model / operation_models)
 * 2. Agent DB (AgentModelConfig per-agent overrides)
 * 3. Project DB (default ModelConfig; explicit operation-tier routing can opt into tier lookup)
 * 4. Tenant Model (default TenantModel; explicit operation-tier routing can opt into tier lookup)
 *    DSL tail. When Level 1 pinned a modelId and no earlier level resolved it,
 *    try project ModelConfig binding, then tenant TenantModel binding (iterate
 *    until a usable candidate is found). Misses fall through to provider
 *    inference unchanged.
 * 5. FAIL (throw — no implicit env-var fallback)
 *
 * Default behavior: one model for everything. Whatever the tenant configures,
 * use it for all operations. Per-operation model splitting is an advanced
 * project-level opt-in, not the default.
 *
 * Also enforces tenant-level provider allowlists and credential policies.
 */

import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { decryptForTenantAuto } from '@agent-platform/shared/encryption';
import { createLogger } from '@abl/compiler/platform';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';
import {
  getDefaultOperationTier,
  isOperationTierCompatible,
  isModelRoutingTier,
  type ModelRoutingOperation,
} from '@agent-platform/shared-kernel/model-routing';
import { isLlmProviderAllowed } from '@agent-platform/shared-kernel/llm-provider-identity';
import { isConfigLoaded, getConfig } from '../../config/index.js';
import { resolveAuthProfileCredentials } from '../auth-profile-resolver.js';
import {
  checkAndRecordBudget,
  ESTIMATED_TOKENS_PER_CALL,
  type BudgetReservation,
} from './budget-enforcement.js';
import {
  findAgentModelConfig,
  findAgentModelConfigByDslName,
  findModelConfigByModelId,
  findModelConfigForTier,
  findAnyModelConfig,
  findTenantModelByIdWithPrimaryConnection,
  findDefaultTenantModelForTier,
  findAnyDefaultTenantModel,
  findTenantModelByProvider,
  findTenantLLMPolicy,
  findDefaultUserCredential,
  findDefaultTenantCredential,
  findDefaultTenantModelForVoice,
  findCredentialById,
  findProjectOperationTierOverrides,
  findProjectEnableThinking,
} from '../../repos/llm-resolution-repo.js';
import type { HyperParameter } from '@abl/compiler/platform/llm/model-registry.js';
import {
  buildModelResolutionCacheKey,
  buildReasoningSettingsCacheKey,
} from './model-resolution-versioning.js';
import {
  getModelCapabilities,
  getModelRegistryEntry,
  inferModelProviderFromId,
} from '@abl/compiler/platform/llm/model-capabilities.js';
import {
  createModelResolutionConfigurationError,
  MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE,
} from './model-resolution-errors.js';
import { parseJsonField } from './utils.js';

const log = createLogger('model-resolution');

function summarizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

// =============================================================================
// TYPES
// =============================================================================

export type OperationType = ModelRoutingOperation;

export interface RealtimeModelConfig {
  audioFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  voices?: string[];
  vadConfig?: {
    type?: 'server_vad' | 'none';
    threshold?: number;
    silenceDurationMs?: number;
  };
  maxSessionDurationMs?: number;
  connectionType?: 'http' | 'websocket';
}

export interface ResolvedModel {
  /** LiteLLM-format model ID, e.g. "anthropic/claude-3-sonnet" */
  modelId: string;
  /** Provider name, e.g. "anthropic" */
  provider: string;
  /** Where the model was resolved from */
  source: 'agent_ir' | 'agent_db' | 'project_db' | 'tenant_model' | 'system_default';
  /** Decrypted credential for the API call */
  credential: ResolvedCredential;
  /** Model parameters */
  parameters: ResolvedModelParameters;
  /** Runtime capability overrides from tenant/project model configuration */
  capabilities?: ResolvedModelCapabilities;
  /** Project-specific pricing metadata for cost attribution */
  pricing?: ResolvedModelPricing;
  /** Custom endpoint (gateway/proxy URL) */
  customEndpoint?: string;
  /** API integration details */
  apiIntegration?: {
    providerStructure: string;
    requestTemplate?: string;
    responseMapping?: string;
    customHeaders?: Record<string, string>;
  };
  /** Realtime voice configuration (present when resolving realtime_voice operation) */
  realtimeConfig?: RealtimeModelConfig;
  /** OpenAI only: override for Responses API vs Chat Completions */
  useResponsesApi?: boolean;
  /** Override for streaming vs non-streaming LLM calls */
  useStreaming?: boolean;
  /** Per-call budget reservation used for post-call token reconciliation. */
  budgetReservation?: BudgetReservation;
}

export interface ResolvedCredential {
  apiKey: string;
  endpoint?: string;
  authType: string;
  authConfig?: unknown;
  customHeaders?: Record<string, string>;
}

interface CachedCredentialEntry {
  credential: ResolvedCredential;
  tenantId?: string;
  cachedAt: number;
}

interface ProjectCredentialOverride {
  authProfileId?: string;
  credentialId?: string;
  modelConfigId?: string;
}

type TenantEncryptionReadiness =
  | boolean
  | null
  | (() => boolean)
  | {
      decryptForTenant?: unknown;
    };

export interface DeploymentModelOverride {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ResolvedReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | (string & {});

export interface ResolvedModelParameters {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stopSequences?: string[];
  reasoningEffort?: ResolvedReasoningEffort;
  enableThinking?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string;
  thoughtDescription?: string;
  compactionThreshold?: number;
  contextWindow?: number;
}

type ResolvedModelParameterKey = keyof ResolvedModelParameters;

const PROVIDER_PARAMETER_SUPPORT: Record<string, ReadonlySet<ResolvedModelParameterKey>> = {
  openai: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'stopSequences',
  ]),
  azure: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'stopSequences',
  ]),
  anthropic: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  microsoft_foundry_anthropic: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'topK',
    'stopSequences',
  ]),
  bedrock: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  google: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  gemini: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  groq: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'stopSequences',
  ]),
  fireworks: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'topK',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'stopSequences',
  ]),
  together_ai: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  together: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  deepseek: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'stopSequences',
  ]),
  xai: new Set([
    'temperature',
    'maxTokens',
    'topP',
    'frequencyPenalty',
    'presencePenalty',
    'seed',
    'stopSequences',
  ]),
  perplexity: new Set(['temperature', 'maxTokens', 'topP', 'frequencyPenalty', 'stopSequences']),
  mistral: new Set(['temperature', 'maxTokens', 'topP', 'seed', 'stopSequences']),
  cohere: new Set(['temperature', 'maxTokens', 'topP', 'stopSequences']),
  meta: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
  qwen: new Set(['temperature', 'maxTokens', 'topP', 'topK', 'stopSequences']),
};

const PROVIDER_PARAMETER_KEYS: ResolvedModelParameterKey[] = [
  'temperature',
  'topP',
  'topK',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'stopSequences',
  'reasoningEffort',
  'enableThinking',
  'thinkingBudget',
  'thinkingLevel',
];

export interface ResolvedModelCapabilities {
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  contextWindow?: number;
}

export interface ResolvedModelPricing {
  inputCostPer1k: number | null;
  outputCostPer1k: number | null;
}

export interface ResolutionContext {
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  agentIR?: AgentIR;
  operationType: OperationType;
  userId?: string;
  /** Deployment-level model override for this agent (highest priority). */
  deploymentModelOverride?: DeploymentModelOverride;
  /** Pinned settings version ID from deployment (for enableThinking/thinkingBudget resolution). */
  settingsVersionId?: string;
}

/**
 * Settings-only reasoning resolution context.
 *
 * This is intentionally narrower than `ResolutionContext`: it excludes
 * `userId` and always resolves the `reasoning` operation snapshot. Use this
 * when prompt-builder or session wiring only needs the merged reasoning
 * settings and reasoning model identity, not credential-bearing access.
 */
export interface ReasoningSettingsContext {
  tenantId?: string;
  projectId?: string;
  agentName?: string;
  agentIR?: AgentIR;
  deploymentModelOverride?: DeploymentModelOverride;
  settingsVersionId?: string;
}

export interface ResolvedReasoningSettings {
  modelId: string;
  parameters: Pick<
    ResolvedModelParameters,
    'enableThinking' | 'thinkingBudget' | 'thoughtDescription' | 'compactionThreshold'
  >;
}

// =============================================================================
// SHARED UTILITY — provider inference from model ID
// =============================================================================

/**
 * Infer provider name from a LiteLLM-format or bare model ID.
 *
 * "anthropic/claude-3-sonnet" → "anthropic"
 * "claude-3-sonnet" → "anthropic" (bare Anthropic model name)
 *
 * Returns null when the model ID doesn't match any known provider prefix.
 * Callers must handle null — never silently default to a specific provider.
 */
export function inferProviderFromModelId(modelId: string): string | null {
  const provider = inferModelProviderFromId(modelId);
  if (provider) return provider;

  log.warn('Could not infer provider from model ID', { modelId });
  return null;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if a value is in the encrypted format (iv:authTag:ciphertext, all hex).
 * Used to detect whether a stored "encryptedApiKey" is actually encrypted
 * or stored as plaintext (common in dev/seed scenarios).
 */
function isEncryptedFormat(value: string): boolean {
  // v3 hex 3-part: ivHex:authTagHex:ciphertextHex
  const parts = value.split(':');
  if (parts.length === 3) {
    return parts.every((p) => /^[0-9a-f]+$/i.test(p) && p.length >= 16);
  }
  // Compressed format: Z1|N0 prefix + 3 base64 parts
  if (parts.length === 4 && /^[ZN][01]$/.test(parts[0])) {
    return parts.slice(1).every((p) => /^[A-Za-z0-9+/=]+$/.test(p));
  }
  // DEK envelope base64 with DEK ID header: decode and check structure
  // Matches canonical isDEKEnvelopeFormat() from shared-encryption
  if (/^[A-Za-z0-9+/]+=*$/.test(value) && value.length >= 40) {
    try {
      const buf = Buffer.from(value, 'base64');
      const idLen = buf[0];
      if (idLen !== undefined && idLen >= 5 && idLen <= 50 && buf.length >= 1 + idLen + 29) {
        const firstChar = buf[1];
        // DEK ID must start with printable ASCII (0x20-0x7E) — covers opaque nanoid, "active", time-based IDs
        if (firstChar !== undefined && firstChar >= 0x20 && firstChar <= 0x7e) return true;
      }
    } catch {
      // not DEK envelope format
    }
  }
  return false;
}

interface StoredCredentialRecord {
  encryptedApiKey?: string | null;
  encryptedEndpoint?: string | null;
  authType?: string | null;
  authConfig?: unknown;
  customHeaders?: unknown;
  _decryptionFailed?: boolean;
}

async function resolveStoredCredential(
  credential: StoredCredentialRecord,
  tenantId: string,
  logMessage: string,
  logContext: Record<string, unknown>,
): Promise<ResolvedCredential | null> {
  if (!credential.encryptedApiKey) {
    log.warn(logMessage, logContext);
    return null;
  }

  try {
    const apiKey = await resolveTenantPlaintextValue(credential.encryptedApiKey, tenantId, {
      decryptionFailed: Boolean(credential._decryptionFailed),
    });
    if (!apiKey) {
      log.warn(logMessage, logContext);
      return null;
    }

    const endpoint = await resolveTenantPlaintextValue(
      credential.encryptedEndpoint ?? null,
      tenantId,
    );

    return {
      apiKey,
      endpoint: endpoint ?? undefined,
      authType: credential.authType || 'api_key',
      authConfig: parseJsonField(credential.authConfig),
      customHeaders:
        (parseJsonField(credential.customHeaders) as Record<string, string> | null) || undefined,
    };
  } catch (err) {
    log.warn(logMessage, {
      ...logContext,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// =============================================================================
// MODEL RESOLUTION SERVICE
// =============================================================================

/**
 * Cached tenant LLM policy.
 *
 * `allowedProviders` is a native `string[]` from Mongoose `.lean()` via
 * `findTenantLLMPolicy()` in llm-resolution-repo.ts. Empty array means
 * all providers are allowed.
 *
 * `maxRequestsPerMinute` is enforced by the rate limiter middleware via
 * `getTenantRateLimits()` in rate-limiter.ts — it takes the minimum of
 * plan-based limits and this policy value.
 *
 * Budget enforcement (daily/monthly token limits) is enforced via `enforceBudget()`.
 */
interface TenantLLMPolicyRow {
  tenantId: string;
  allowedProviders: string[];
  credentialPolicy: string;
  allowProjectCredentials: boolean;
  dailyTokenBudget: number;
  monthlyTokenBudget: number;
  maxRequestsPerMinute: number;
  defaultModel: string | null;
  defaultFastModel: string | null;
  defaultVoiceModel: string | null;
}

/**
 * Cached resolution metadata — intentionally excludes decrypted credentials
 * so the long-lived metadata cache never stores plaintext API keys.
 */
interface CachedResolution {
  modelId: string;
  provider: string;
  source: ResolvedModel['source'];
  parameters: ResolvedModelParameters;
  capabilities?: ResolvedModelCapabilities;
  pricing?: ResolvedModelPricing;
  customEndpoint?: string;
  apiIntegration?: ResolvedModel['apiIntegration'];
  realtimeConfig?: RealtimeModelConfig;
  useResponsesApi?: boolean;
  useStreaming?: boolean;
  /** If resolved from a TenantModel, store its ID + connection for re-decryption. */
  tenantModelId?: string;
  connectionId?: string;
  /** Non-secret project credential override metadata for credential rehydration. */
  projectCredentialOverride?: ProjectCredentialOverride;
  tenantId?: string;
  /** Credential source for non-TenantModel resolution (levels 1-2) */
  credentialSource?: { type: 'user' | 'tenant' | 'tenant_model'; provider: string };
  cachedAt: number;
}

class ProjectCredentialOverrideError extends AppError {
  constructor(cause?: unknown) {
    super(MODEL_PROVIDER_CONFIGURATION_INVALID_MESSAGE, {
      ...ErrorCodes.MODEL_NOT_CONFIGURED,
      cause,
    });
  }
}

interface UncachedResolutionResult {
  cached: CachedResolution;
  /**
   * Present only for the credential-bearing `resolve()` path. Settings-only
   * reasoning resolution intentionally leaves this undefined.
   */
  credential?: ResolvedCredential;
}

export class ModelResolutionService {
  private metadataCache: Map<string, CachedResolution> = new Map();
  private credentialCache: Map<string, CachedCredentialEntry> = new Map();
  private tenantPolicyCache: Map<string, { policy: TenantLLMPolicyRow | null; cachedAt: number }> =
    new Map();
  /**
   * In-flight resolution promises keyed by cache key — prevents duplicate DB
   * work for concurrent cold starts. The result stores cacheable metadata and,
   * for full `resolve()` only, the transient credential needed by callers
   * waiting on the shared promise.
   */
  private inflightResolutions: Map<string, Promise<UncachedResolutionResult>> = new Map();
  /**
   * Monotonic generation counter — bumped on every clearCache() call.
   * _resolveUncached captures the generation at start and skips the cache write
   * if it changed (i.e. a credential mutation invalidated the cache mid-flight).
   */
  private cacheGeneration = 0;
  private static DEFAULT_CACHE_TTL_MS = 5 * 60_000;
  private static DEFAULT_CREDENTIAL_CACHE_TTL_MS = 5_000;
  private static DEFAULT_TENANT_POLICY_CACHE_TTL_MS = 5_000;
  private static MAX_CACHE_SIZE = 10_000;

  private _cacheTtlMs: number | null = null;

  private getCacheTtlMs(): number {
    if (this._cacheTtlMs != null) return this._cacheTtlMs;
    try {
      if (isConfigLoaded()) {
        this._cacheTtlMs = getConfig().llmCache.resolutionCacheTtlSeconds * 1000;
        return this._cacheTtlMs;
      }
    } catch {
      /* config not available */
    }
    return ModelResolutionService.DEFAULT_CACHE_TTL_MS;
  }

  constructor(
    private dbAvailable: boolean,
    private tenantEncryptionReadiness: TenantEncryptionReadiness,
  ) {}

  private isTenantEncryptionReady(): boolean {
    if (typeof this.tenantEncryptionReadiness === 'function') {
      return this.tenantEncryptionReadiness();
    }
    return !!this.tenantEncryptionReadiness;
  }

  private buildCacheKey(context: ResolutionContext): string {
    return buildModelResolutionCacheKey({
      tenantId: context.tenantId,
      projectId: context.projectId,
      agentName: context.agentName,
      agentIR: context.agentIR,
      operationType: context.operationType,
      userId: context.userId,
      settingsVersionId: context.settingsVersionId,
      deploymentModelOverride: context.deploymentModelOverride,
    });
  }

  private buildReasoningSettingsCacheKey(context: ReasoningSettingsContext): string {
    return buildReasoningSettingsCacheKey({
      tenantId: context.tenantId,
      projectId: context.projectId,
      agentName: context.agentName,
      agentIR: context.agentIR,
      settingsVersionId: context.settingsVersionId,
      deploymentModelOverride: context.deploymentModelOverride,
    });
  }

  private getCachedResolution(cacheKey: string): CachedResolution | null {
    const cached = this.metadataCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt < this.getCacheTtlMs()) {
      return cached;
    }
    this.metadataCache.delete(cacheKey);
    return null;
  }

  private getCredentialCacheTtlMs(): number {
    return Math.min(this.getCacheTtlMs(), ModelResolutionService.DEFAULT_CREDENTIAL_CACHE_TTL_MS);
  }

  private getTenantPolicyCacheTtlMs(): number {
    return Math.min(
      this.getCacheTtlMs(),
      ModelResolutionService.DEFAULT_TENANT_POLICY_CACHE_TTL_MS,
    );
  }

  private cloneAuthConfig(authConfig: unknown): unknown {
    if (authConfig === undefined || authConfig === null || typeof authConfig !== 'object') {
      return authConfig;
    }

    try {
      return structuredClone(authConfig);
    } catch {
      return authConfig;
    }
  }

  private cloneResolvedCredential(credential: ResolvedCredential): ResolvedCredential {
    return {
      apiKey: credential.apiKey,
      endpoint: credential.endpoint,
      authType: credential.authType,
      authConfig: this.cloneAuthConfig(credential.authConfig),
      customHeaders: credential.customHeaders ? { ...credential.customHeaders } : undefined,
    };
  }

  private getCachedCredential(cacheKey: string): ResolvedCredential | null {
    const cached = this.credentialCache.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt < this.getCredentialCacheTtlMs()) {
      return this.cloneResolvedCredential(cached.credential);
    }
    this.credentialCache.delete(cacheKey);
    return null;
  }

  private setCachedCredential(
    cacheKey: string,
    tenantId: string | undefined,
    credential: ResolvedCredential,
  ): void {
    if (this.credentialCache.size >= ModelResolutionService.MAX_CACHE_SIZE) {
      const firstKey = this.credentialCache.keys().next().value;
      if (firstKey) this.credentialCache.delete(firstKey);
    }

    this.credentialCache.set(cacheKey, {
      credential: this.cloneResolvedCredential(credential),
      tenantId,
      cachedAt: Date.now(),
    });
  }

  private getCachedTenantPolicy(tenantId: string): TenantLLMPolicyRow | null | undefined {
    const cached = this.tenantPolicyCache.get(tenantId);
    if (!cached) return undefined;
    if (Date.now() - cached.cachedAt < this.getTenantPolicyCacheTtlMs()) {
      return cached.policy;
    }
    this.tenantPolicyCache.delete(tenantId);
    return undefined;
  }

  private setCachedTenantPolicy(tenantId: string, policy: TenantLLMPolicyRow | null): void {
    if (this.tenantPolicyCache.size >= ModelResolutionService.MAX_CACHE_SIZE) {
      const firstKey = this.tenantPolicyCache.keys().next().value;
      if (firstKey) this.tenantPolicyCache.delete(firstKey);
    }

    this.tenantPolicyCache.set(tenantId, {
      policy,
      cachedAt: Date.now(),
    });
  }

  private extractProjectCredentialOverride(
    modelConfig: unknown,
  ): ProjectCredentialOverride | undefined {
    const record = modelConfig as Record<string, unknown>;
    const authProfileId =
      typeof record.authProfileId === 'string' && record.authProfileId.trim().length > 0
        ? record.authProfileId.trim()
        : undefined;
    const credentialId =
      !authProfileId &&
      typeof record.credentialId === 'string' &&
      record.credentialId.trim().length > 0
        ? record.credentialId.trim()
        : undefined;

    if (!authProfileId && !credentialId) {
      return undefined;
    }

    const modelConfigId =
      typeof record.id === 'string'
        ? record.id
        : typeof record._id === 'string'
          ? record._id
          : undefined;

    return { authProfileId, credentialId, modelConfigId };
  }

  private readFiniteNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private mapHyperParameterNameToResolvedKey(name: string): ResolvedModelParameterKey | undefined {
    switch (name) {
      case 'temperature':
        return 'temperature';
      case 'maxTokens':
      case 'max_tokens':
      case 'maxOutputTokens':
      case 'max_completion_tokens':
        return 'maxTokens';
      case 'topP':
      case 'top_p':
        return 'topP';
      case 'topK':
      case 'top_k':
        return 'topK';
      case 'frequencyPenalty':
      case 'frequency_penalty':
        return 'frequencyPenalty';
      case 'presencePenalty':
      case 'presence_penalty':
        return 'presencePenalty';
      case 'seed':
        return 'seed';
      case 'stop':
      case 'stopSequences':
      case 'stop_sequences':
        return 'stopSequences';
      case 'reasoningEffort':
      case 'reasoning_effort':
      case 'effort':
        return 'reasoningEffort';
      case 'enableThinking':
      case 'enable_thinking':
      case 'thinking.enabled':
        return 'enableThinking';
      case 'thinkingBudget':
      case 'thinking_budget':
      case 'budget_tokens':
      case 'budgetTokens':
      case 'thinking.budget_tokens':
      case 'reasoningConfig.budgetTokens':
        return 'thinkingBudget';
      case 'thinkingLevel':
      case 'thinking_level':
        return 'thinkingLevel';
      case 'thoughtDescription':
      case 'thought_description':
        return 'thoughtDescription';
      case 'compactionThreshold':
      case 'compaction_threshold':
        return 'compactionThreshold';
      case 'contextWindow':
      case 'context_window':
        return 'contextWindow';
      default:
        return undefined;
    }
  }

  private collectAdvertisedHyperParameterKeys(
    hyperParameters: HyperParameter[] | undefined,
    keys = new Set<ResolvedModelParameterKey>(),
  ): Set<ResolvedModelParameterKey> {
    for (const param of hyperParameters ?? []) {
      const nameKey = this.mapHyperParameterNameToResolvedKey(param.name);
      if (nameKey) keys.add(nameKey);
      const unifiedKey = param.unifiedParam
        ? this.mapHyperParameterNameToResolvedKey(param.unifiedParam)
        : undefined;
      if (unifiedKey) keys.add(unifiedKey);
      this.collectAdvertisedHyperParameterKeys(param.hyperParameters, keys);
      const options = (param as { options?: unknown }).options;
      if (Array.isArray(options)) {
        this.collectAdvertisedHyperParameterKeys(options as HyperParameter[], keys);
      }
    }
    return keys;
  }

  private getAdvertisedHyperParameterKeys(
    modelId: string,
  ): Set<ResolvedModelParameterKey> | undefined {
    const entry = getModelRegistryEntry(modelId);
    return entry ? this.collectAdvertisedHyperParameterKeys(entry.hyperParameters) : undefined;
  }

  private getSupportedResolvedParameterKeys(
    modelId: string,
    provider: string,
  ): ReadonlySet<ResolvedModelParameterKey> {
    const advertised = this.getAdvertisedHyperParameterKeys(modelId);
    if (advertised) {
      return advertised;
    }

    return (
      PROVIDER_PARAMETER_SUPPORT[provider.toLowerCase()] ??
      new Set<ResolvedModelParameterKey>(['maxTokens'])
    );
  }

  private readValueFromPath(record: Record<string, unknown>, key: string): unknown {
    if (!key.includes('.')) {
      return record[key];
    }

    let cursor: unknown = record;
    for (const segment of key.split('.')) {
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return undefined;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor;
  }

  private readFiniteNumberFromKeys(
    record: Record<string, unknown>,
    keys: string[],
  ): number | undefined {
    for (const key of keys) {
      const value = this.readValueFromPath(record, key);
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private readBooleanFromKeys(
    record: Record<string, unknown>,
    keys: string[],
  ): boolean | undefined {
    for (const key of keys) {
      const value = this.readValueFromPath(record, key);
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
      }
    }
    return undefined;
  }

  private readStringFromKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.readValueFromPath(record, key);
      if (typeof value === 'string' && value.trim() !== '') {
        return value;
      }
    }
    return undefined;
  }

  private readStopSequences(record: Record<string, unknown>): string[] | undefined {
    const value =
      this.readValueFromPath(record, 'stopSequences') ??
      this.readValueFromPath(record, 'stop_sequences') ??
      this.readValueFromPath(record, 'stop');
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item !== '');
      return items.length > 0 ? items : undefined;
    }
    if (typeof value === 'string') {
      const items = value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return items.length > 0 ? items : undefined;
    }
    return undefined;
  }

  private extractHyperParameterValues(hyperParameters: unknown): Partial<ResolvedModelParameters> {
    const record = parseJsonField(hyperParameters) || {};
    const params: Partial<ResolvedModelParameters> = {};

    const temperature = this.readFiniteNumberFromKeys(record, ['temperature']);
    if (temperature != null) params.temperature = temperature;
    const maxTokens = this.readFiniteNumberFromKeys(record, [
      'maxTokens',
      'max_tokens',
      'maxOutputTokens',
      'max_completion_tokens',
    ]);
    if (maxTokens != null) params.maxTokens = maxTokens;
    const topP = this.readFiniteNumberFromKeys(record, ['topP', 'top_p']);
    if (topP != null) params.topP = topP;
    const topK = this.readFiniteNumberFromKeys(record, ['topK', 'top_k']);
    if (topK != null) params.topK = topK;
    const frequencyPenalty = this.readFiniteNumberFromKeys(record, [
      'frequencyPenalty',
      'frequency_penalty',
    ]);
    if (frequencyPenalty != null) params.frequencyPenalty = frequencyPenalty;
    const presencePenalty = this.readFiniteNumberFromKeys(record, [
      'presencePenalty',
      'presence_penalty',
    ]);
    if (presencePenalty != null) params.presencePenalty = presencePenalty;
    const seed = this.readFiniteNumberFromKeys(record, ['seed']);
    if (seed != null) params.seed = Math.trunc(seed);

    const reasoningEffort = this.readStringFromKeys(record, [
      'reasoningEffort',
      'reasoning_effort',
      'effort',
    ]);
    if (reasoningEffort) params.reasoningEffort = reasoningEffort as ResolvedReasoningEffort;
    const enableThinking = this.readBooleanFromKeys(record, [
      'enableThinking',
      'enable_thinking',
      'thinking.enabled',
    ]);
    if (enableThinking != null) params.enableThinking = enableThinking;
    const thinkingBudget = this.readFiniteNumberFromKeys(record, [
      'thinkingBudget',
      'thinking_budget',
      'budget_tokens',
      'budgetTokens',
      'thinking.budget_tokens',
      'reasoningConfig.budgetTokens',
    ]);
    if (thinkingBudget != null) params.thinkingBudget = thinkingBudget;
    const thinkingLevel = this.readStringFromKeys(record, ['thinkingLevel', 'thinking_level']);
    if (thinkingLevel) params.thinkingLevel = thinkingLevel;
    const thoughtDescription = this.readStringFromKeys(record, [
      'thoughtDescription',
      'thought_description',
    ]);
    if (thoughtDescription) params.thoughtDescription = thoughtDescription;
    const compactionThreshold = this.readFiniteNumberFromKeys(record, [
      'compactionThreshold',
      'compaction_threshold',
    ]);
    if (compactionThreshold != null) params.compactionThreshold = compactionThreshold;

    const stopSequences = this.readStopSequences(record);
    if (stopSequences) params.stopSequences = stopSequences;

    return params;
  }

  private hasStoredHyperParameters(hyperParameters: unknown): boolean {
    const record = parseJsonField(hyperParameters);
    return Boolean(record && Object.keys(record).length > 0);
  }

  private modelConfigHasDynamicHyperParameterBag(modelConfig: unknown): boolean {
    const record = modelConfig as Record<string, unknown>;
    return this.hasStoredHyperParameters(record.hyperParameters);
  }

  private suppressTenantLegacySamplingForDynamicProjectConfig(
    modelConfig: unknown,
    tenantModel: TenantModelResolution,
  ): void {
    if (!this.modelConfigHasDynamicHyperParameterBag(modelConfig)) return;
    tenantModel.temperature = undefined;
  }

  private applyResolvedParameters(
    params: Partial<ResolvedModelParameters>,
    mode: 'fill' | 'override',
    setters: {
      temperature: (value: number) => void;
      maxTokens: (value: number) => void;
      topP: (value: number) => void;
      topK: (value: number) => void;
      frequencyPenalty: (value: number) => void;
      presencePenalty: (value: number) => void;
      seed: (value: number) => void;
      stopSequences: (value: string[]) => void;
      reasoningEffort: (value: ResolvedReasoningEffort) => void;
      enableThinking: (value: boolean) => void;
      thinkingBudget: (value: number) => void;
      thinkingLevel: (value: string) => void;
      thoughtDescription: (value: string) => void;
      compactionThreshold: (value: number) => void;
      contextWindow: (value: number) => void;
    },
    current: ResolvedModelParameters,
  ): void {
    const shouldSet = (value: unknown) => mode === 'override' || value == null;

    if (params.temperature != null && shouldSet(current.temperature))
      setters.temperature(params.temperature);
    if (params.maxTokens != null && shouldSet(current.maxTokens))
      setters.maxTokens(params.maxTokens);
    if (params.topP != null && shouldSet(current.topP)) setters.topP(params.topP);
    if (params.topK != null && shouldSet(current.topK)) setters.topK(params.topK);
    if (params.frequencyPenalty != null && shouldSet(current.frequencyPenalty)) {
      setters.frequencyPenalty(params.frequencyPenalty);
    }
    if (params.presencePenalty != null && shouldSet(current.presencePenalty)) {
      setters.presencePenalty(params.presencePenalty);
    }
    if (params.seed != null && shouldSet(current.seed)) setters.seed(params.seed);
    if (params.stopSequences != null && shouldSet(current.stopSequences)) {
      setters.stopSequences(params.stopSequences);
    }
    if (params.reasoningEffort != null && shouldSet(current.reasoningEffort)) {
      setters.reasoningEffort(params.reasoningEffort);
    }
    if (params.enableThinking != null && shouldSet(current.enableThinking)) {
      setters.enableThinking(params.enableThinking);
    }
    if (params.thinkingBudget != null && shouldSet(current.thinkingBudget)) {
      setters.thinkingBudget(params.thinkingBudget);
    }
    if (params.thinkingLevel != null && shouldSet(current.thinkingLevel)) {
      setters.thinkingLevel(params.thinkingLevel);
    }
    if (params.thoughtDescription != null && shouldSet(current.thoughtDescription)) {
      setters.thoughtDescription(params.thoughtDescription);
    }
    if (params.compactionThreshold != null && shouldSet(current.compactionThreshold)) {
      setters.compactionThreshold(params.compactionThreshold);
    }
    if (params.contextWindow != null && shouldSet(current.contextWindow)) {
      setters.contextWindow(params.contextWindow);
    }
  }

  private extractModelConfigParameters(modelConfig: unknown): Partial<ResolvedModelParameters> {
    const record = modelConfig as Record<string, unknown>;
    const hyperParameters = this.extractHyperParameterValues(record.hyperParameters);
    const hasHyperParameterBag = this.hasStoredHyperParameters(record.hyperParameters);
    const params: Partial<ResolvedModelParameters> = {
      ...hyperParameters,
      contextWindow: this.readFiniteNumber(record, 'contextWindow'),
    };

    // Legacy sampling fields are required on ModelConfig for compatibility. Once
    // a dynamic hyperparameter bag exists, only treat advertised/stored sampling
    // keys as intent; otherwise old DB defaults like temperature=0.7 leak into
    // models whose registry metadata intentionally omitted sampling controls.
    if (!hasHyperParameterBag || hyperParameters.temperature !== undefined) {
      params.temperature =
        hyperParameters.temperature ?? this.readFiniteNumber(record, 'temperature');
    }
    params.maxTokens = hyperParameters.maxTokens ?? this.readFiniteNumber(record, 'maxTokens');
    if (!hasHyperParameterBag || hyperParameters.topP !== undefined) {
      params.topP = hyperParameters.topP ?? this.readFiniteNumber(record, 'topP');
    }
    if (!hasHyperParameterBag || hyperParameters.frequencyPenalty !== undefined) {
      params.frequencyPenalty =
        hyperParameters.frequencyPenalty ?? this.readFiniteNumber(record, 'frequencyPenalty');
    }
    if (!hasHyperParameterBag || hyperParameters.presencePenalty !== undefined) {
      params.presencePenalty =
        hyperParameters.presencePenalty ?? this.readFiniteNumber(record, 'presencePenalty');
    }

    return params;
  }

  private extractModelCapabilities(modelConfig: unknown): ResolvedModelCapabilities | undefined {
    const record = modelConfig as Record<string, unknown>;
    const capabilities: ResolvedModelCapabilities = {};
    if (typeof record.supportsTools === 'boolean')
      capabilities.supportsTools = record.supportsTools;
    if (typeof record.supportsVision === 'boolean')
      capabilities.supportsVision = record.supportsVision;
    if (typeof record.supportsStreaming === 'boolean')
      capabilities.supportsStreaming = record.supportsStreaming;
    const contextWindow = this.readFiniteNumber(record, 'contextWindow');
    if (contextWindow != null) capabilities.contextWindow = contextWindow;

    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  }

  private extractModelPricing(modelConfig: unknown): ResolvedModelPricing | undefined {
    const record = modelConfig as Record<string, unknown>;
    const hasInput = typeof record.inputCostPer1k === 'number' || record.inputCostPer1k === null;
    const hasOutput = typeof record.outputCostPer1k === 'number' || record.outputCostPer1k === null;
    if (!hasInput && !hasOutput) {
      return undefined;
    }

    return {
      inputCostPer1k: typeof record.inputCostPer1k === 'number' ? record.inputCostPer1k : null,
      outputCostPer1k: typeof record.outputCostPer1k === 'number' ? record.outputCostPer1k : null,
    };
  }

  private extractStreamingOverride(modelConfig: unknown): boolean | undefined {
    const record = modelConfig as Record<string, unknown>;
    if (typeof record.useStreaming === 'boolean') {
      return record.useStreaming;
    }
    if (record.supportsStreaming === false) {
      return false;
    }
    return undefined;
  }

  private buildResolvedModelFromCacheEntry(
    cached: CachedResolution,
    credential: ResolvedCredential,
    budgetReservation?: BudgetReservation,
  ): ResolvedModel {
    return {
      modelId: cached.modelId,
      provider: cached.provider,
      source: cached.source,
      credential,
      parameters: cached.parameters,
      capabilities: cached.capabilities,
      pricing: cached.pricing,
      customEndpoint: cached.customEndpoint,
      apiIntegration: cached.apiIntegration,
      realtimeConfig: cached.realtimeConfig,
      useResponsesApi: cached.useResponsesApi,
      useStreaming: cached.useStreaming,
      budgetReservation,
    };
  }

  private buildReasoningSettingsFromCacheEntry(
    cached: CachedResolution,
  ): ResolvedReasoningSettings {
    return {
      modelId: cached.modelId,
      parameters: {
        enableThinking: cached.parameters.enableThinking,
        thinkingBudget: cached.parameters.thinkingBudget,
        thoughtDescription: cached.parameters.thoughtDescription,
        compactionThreshold: cached.parameters.compactionThreshold,
      },
    };
  }

  private async getOrResolveUncached(
    context: ResolutionContext,
    cacheKey: string,
    options: { includeCredential: boolean },
  ): Promise<UncachedResolutionResult> {
    const inflight = this.inflightResolutions.get(cacheKey);
    if (inflight) {
      log.debug('Singleflight: joining in-flight resolution', {
        cacheKey,
        tenantId: context.tenantId,
        agentName: context.agentName,
      });
      return await inflight;
    }

    const resolutionPromise = this._resolveUncached(context, cacheKey, options).catch((err) => {
      this.inflightResolutions.delete(cacheKey);
      throw err;
    });
    this.inflightResolutions.set(cacheKey, resolutionPromise);
    try {
      return await resolutionPromise;
    } finally {
      this.inflightResolutions.delete(cacheKey);
    }
  }

  /**
   * Clear resolution cache entries for a tenant (call after credential mutations).
   */
  clearCache(tenantId?: string): void {
    this.cacheGeneration++;
    if (!tenantId) {
      this.metadataCache.clear();
      this.credentialCache.clear();
      this.tenantPolicyCache.clear();
      this.inflightResolutions.clear();
      return;
    }
    for (const [key, entry] of this.metadataCache) {
      if (key.startsWith(`${tenantId}::`) || entry.tenantId === tenantId) {
        this.metadataCache.delete(key);
      }
    }
    for (const [key, entry] of this.credentialCache) {
      if (key.startsWith(`${tenantId}::`) || entry.tenantId === tenantId) {
        this.credentialCache.delete(key);
      }
    }
    this.tenantPolicyCache.delete(tenantId);
    // Remove in-flight entries so new requests don't join a stale resolution.
    // This does NOT cancel the running promise — the generation guard in
    // _resolveUncached() prevents the completed promise from writing stale
    // data back into metadataCache.
    for (const key of this.inflightResolutions.keys()) {
      if (key.startsWith(`${tenantId}::`)) {
        this.inflightResolutions.delete(key);
      }
    }
  }

  /**
   * Re-decrypt credential from cached resolution metadata.
   * Metadata cache entries stay credential-free; a separate short-lived
   * credential cache handles repeat hot-path lookups between invalidations.
   */
  private async rehydrateCredential(
    cached: CachedResolution,
    context: ResolutionContext,
  ): Promise<ResolvedCredential | null> {
    if (cached.projectCredentialOverride) {
      try {
        return await this.resolveProjectCredentialOverride(
          cached.projectCredentialOverride,
          cached.tenantId || context.tenantId,
          cached.tenantModelId,
        );
      } catch (error) {
        log.warn('rehydrateCredential: project credential override failed', {
          tenantId: cached.tenantId || context.tenantId,
          tenantModelId: cached.tenantModelId,
          provider: cached.provider,
          modelId: cached.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    // If the cached resolution was backed by a TenantModel (has tenantModelId),
    // re-resolve via the exact tenant model to re-decrypt the credential.
    // Key off tenantModelId presence — NOT source name — because some sources
    // (e.g. agent_db) can cache with or without a tenantModelId depending on
    // whether the agent config resolved through a TenantModel or fell back to
    // a bare modelId string. Using the source name would incorrectly route
    // bare-modelId entries into the TenantModel path, bypassing credential policy.
    //
    // If the exact ID lookup fails (TenantModel deleted, deactivated, connection
    // removed), return null to signal the caller to evict and re-resolve from
    // scratch. Do NOT fall back to findTenantModelByProvider() — that can return
    // a different TenantModel with different credentials/endpoints, silently
    // mismatching the cached modelId and customEndpoint metadata.
    if (cached.tenantModelId) {
      const tenantId = cached.tenantId || context.tenantId;
      if (tenantId && this.dbAvailable && this.isTenantEncryptionReady()) {
        const tm = await findTenantModelByIdWithPrimaryConnection(cached.tenantModelId, tenantId);
        if (tm) {
          const resolution = await this.buildTenantModelResolution(tm);
          if (resolution?.credential) return resolution.credential;
        }
      }
      // Exact lookup failed — signal caller to evict and re-resolve.
      log.warn('rehydrateCredential: exact TenantModel lookup failed — cache entry is stale', {
        tenantModelId: cached.tenantModelId,
        tenantId: cached.tenantId || context.tenantId,
        provider: cached.provider,
        modelId: cached.modelId,
      });
      return null;
    }

    // No tenantModelId — resolve credential through the standard policy chain
    // (user_first, user_only, org_first, etc.)
    const tenantPolicy =
      context.tenantId && this.dbAvailable
        ? await this.safeFetchTenantPolicy(context.tenantId)
        : null;
    return this.resolveCredential(context, cached.provider, tenantPolicy);
  }

  /**
   * Resolve the best model for the given context.
   *
   * Resolution chain (first match wins):
   * 0. Deployment model override (highest priority)
   * 1. Agent IR — operation_models[op] → execution.model
   * 2. Agent DB — AgentModelConfig.operationModels[op] → defaultModel
   * 3. Project DB — ModelConfig (tier-specific → any) → linked TenantModel
   * 3b. Voice-specific (realtime_voice only)
   * 4. Tenant Model — tier-specific → ANY default TenantModel
   * 5. FAIL — throw Error("No model configured for this tenant")
   */
  async resolve(context: ResolutionContext): Promise<ResolvedModel> {
    const cacheKey = this.buildCacheKey(context);
    const cached = this.getCachedResolution(cacheKey);
    if (cached) {
      const credential =
        this.getCachedCredential(cacheKey) ?? (await this.rehydrateCredential(cached, context));
      if (credential) {
        this.setCachedCredential(cacheKey, cached.tenantId ?? context.tenantId, credential);
        const tenantPolicy =
          context.tenantId && this.dbAvailable
            ? await this.safeFetchTenantPolicy(context.tenantId)
            : null;
        let budgetReservation: BudgetReservation | undefined;
        if (tenantPolicy) {
          this.enforceProviderAllowlist(tenantPolicy, cached.provider, cached.modelId);
          budgetReservation = await this.enforceBudget(tenantPolicy, context.tenantId);
        }

        return this.buildResolvedModelFromCacheEntry(cached, credential, budgetReservation);
      }
      log.warn(
        'Model resolution cache entry could not rehydrate credential; evicting cache entry',
        {
          tenantId: context.tenantId,
          userId: context.userId,
          projectId: context.projectId,
          operationType: context.operationType,
          source: cached.source,
          provider: cached.provider,
          modelId: cached.modelId,
          tenantModelId: summarizeIdentifier(cached.tenantModelId),
        },
      );
      this.credentialCache.delete(cacheKey);
      this.metadataCache.delete(cacheKey);
    }

    const uncached = await this.getOrResolveUncached(context, cacheKey, {
      includeCredential: true,
    });
    const credential =
      uncached.credential ?? (await this.rehydrateCredential(uncached.cached, context));
    if (!credential) {
      throw new AppError('Model credential became unavailable during resolution.', {
        ...ErrorCodes.SERVICE_UNAVAILABLE,
      });
    }
    this.setCachedCredential(cacheKey, uncached.cached.tenantId ?? context.tenantId, credential);
    const tenantPolicy =
      context.tenantId && this.dbAvailable
        ? await this.safeFetchTenantPolicy(context.tenantId)
        : null;
    if (tenantPolicy) {
      this.enforceProviderAllowlist(
        tenantPolicy,
        uncached.cached.provider,
        uncached.cached.modelId,
      );
      return this.buildResolvedModelFromCacheEntry(
        uncached.cached,
        credential,
        await this.enforceBudget(tenantPolicy, context.tenantId),
      );
    }

    return this.buildResolvedModelFromCacheEntry(uncached.cached, credential);
  }

  /**
   * Resolve only the reasoning model identity and merged thinking parameters.
   *
   * This is the settings-only contract used by prompt-builder and the thinking
   * pre-resolution cache. It intentionally excludes `userId`, user-scoped
   * credential policy, and per-call budget reservation so the result is keyed
   * purely by the reasoning snapshot for a tenant/project/agent.
   */
  async resolveReasoningSettings(
    context: ReasoningSettingsContext,
  ): Promise<ResolvedReasoningSettings> {
    const reasoningContext: ResolutionContext = {
      tenantId: context.tenantId,
      projectId: context.projectId,
      agentName: context.agentName,
      agentIR: context.agentIR,
      operationType: 'reasoning',
      deploymentModelOverride: context.deploymentModelOverride,
      settingsVersionId: context.settingsVersionId,
    };

    const cacheKey = this.buildReasoningSettingsCacheKey(context);
    const cached = this.getCachedResolution(cacheKey);
    if (cached) {
      return this.buildReasoningSettingsFromCacheEntry(cached);
    }

    const uncached = await this.getOrResolveUncached(reasoningContext, cacheKey, {
      includeCredential: false,
    });
    return this.buildReasoningSettingsFromCacheEntry(uncached.cached);
  }

  /**
   * DB-backed snapshot resolution after a cache miss.
   *
   * When `includeCredential` is true, this also resolves the credential needed
   * by full `resolve()` callers waiting on the shared singleflight promise.
   * Settings-only reasoning resolution uses the same snapshot pipeline but
   * intentionally skips user-scoped credential resolution.
   */
  private async _resolveUncached(
    context: ResolutionContext,
    cacheKey: string,
    options: { includeCredential: boolean },
  ): Promise<UncachedResolutionResult> {
    // Snapshot generation so we can detect mid-flight invalidation before caching.
    const startGeneration = this.cacheGeneration;

    const resolutionErrors: string[] = [];
    let modelId: string | undefined;
    let dslPinnedModelId: string | undefined;
    let source: ResolvedModel['source'] = 'system_default';
    let temperature: number | undefined;
    let maxTokens: number | undefined;
    let topP: number | undefined;
    let topK: number | undefined;
    let frequencyPenalty: number | undefined;
    let presencePenalty: number | undefined;
    let seed: number | undefined;
    let stopSequences: string[] | undefined;
    let contextWindow: number | undefined;
    let reasoningEffort: ResolvedReasoningEffort | undefined;
    let enableThinking: boolean | undefined;
    let thinkingBudget: number | undefined;
    let thinkingLevel: string | undefined;
    let thoughtDescription: string | undefined;
    let compactionThreshold: number | undefined;
    let useResponsesApiOverride: boolean | undefined;
    let useStreamingOverride: boolean | undefined;
    let capabilities: ResolvedModelCapabilities | undefined;
    let pricing: ResolvedModelPricing | undefined;
    let tenantModelResult: TenantModelResolution | null = null;
    let projectCredentialOverride: ProjectCredentialOverride | undefined;

    const applyModelConfigRuntimeMetadata = (
      modelConfig: unknown,
      mode: 'fill' | 'override' = 'fill',
    ) => {
      const shouldSet = (value: unknown) => mode === 'override' || value == null;
      const parameters = this.extractModelConfigParameters(modelConfig);
      this.applyResolvedParameters(
        parameters,
        mode,
        {
          temperature: (value) => {
            temperature = value;
          },
          maxTokens: (value) => {
            maxTokens = value;
          },
          topP: (value) => {
            topP = value;
          },
          topK: (value) => {
            topK = value;
          },
          frequencyPenalty: (value) => {
            frequencyPenalty = value;
          },
          presencePenalty: (value) => {
            presencePenalty = value;
          },
          seed: (value) => {
            seed = value;
          },
          stopSequences: (value) => {
            stopSequences = value;
          },
          reasoningEffort: (value) => {
            reasoningEffort = value;
          },
          enableThinking: (value) => {
            enableThinking = value;
          },
          thinkingBudget: (value) => {
            thinkingBudget = value;
          },
          thinkingLevel: (value) => {
            thinkingLevel = value;
          },
          thoughtDescription: (value) => {
            thoughtDescription = value;
          },
          compactionThreshold: (value) => {
            compactionThreshold = value;
          },
          contextWindow: (value) => {
            contextWindow = value;
          },
        },
        {
          temperature,
          maxTokens,
          topP,
          topK,
          frequencyPenalty,
          presencePenalty,
          seed,
          stopSequences,
          reasoningEffort,
          enableThinking,
          thinkingBudget,
          thinkingLevel,
          thoughtDescription,
          compactionThreshold,
          contextWindow,
        },
      );

      const modelCapabilities = this.extractModelCapabilities(modelConfig);
      if (modelCapabilities && (mode === 'override' || !capabilities)) {
        capabilities = { ...capabilities, ...modelCapabilities };
      }

      const modelPricing = this.extractModelPricing(modelConfig);
      if (modelPricing && (mode === 'override' || !pricing)) {
        pricing = modelPricing;
      }

      const streamingOverride = this.extractStreamingOverride(modelConfig);
      if (streamingOverride != null && shouldSet(useStreamingOverride)) {
        useStreamingOverride = streamingOverride;
      }
    };

    const applyHyperParameterOverrides = (hyperParams: unknown) => {
      applyModelConfigRuntimeMetadata({ hyperParameters: hyperParams }, 'override');
    };

    // --- Pre-fetch tenant policy, project tier overrides, and project enableThinking ---
    const [tenantPolicy, projectTierOverrides, projectEnableThinking] = await Promise.all([
      context.tenantId && this.dbAvailable ? this.safeFetchTenantPolicy(context.tenantId) : null,
      context.tenantId && context.projectId && this.dbAvailable
        ? this.safeFetchProjectTierOverrides(context.tenantId, context.projectId)
        : null,
      context.projectId && this.dbAvailable
        ? this.safeFetchProjectEnableThinking(
            context.projectId,
            context.settingsVersionId,
            context.tenantId,
          )
        : undefined,
    ]);

    // --- Level 0: Deployment model override (highest priority) ---
    if (context.deploymentModelOverride) {
      const dmo = context.deploymentModelOverride;
      if (dmo.model) {
        let resolvedViaProjectConfig = false;
        if (this.dbAvailable && context.projectId) {
          try {
            const projectModel = await findModelConfigByModelId(
              context.projectId,
              dmo.model,
              context.tenantId,
            );

            if (projectModel) {
              resolvedViaProjectConfig = true;
              const credentialOverride = this.extractProjectCredentialOverride(projectModel);
              if (credentialOverride) {
                projectCredentialOverride = credentialOverride;
              }
              if (projectModel.tenantModelId) {
                tenantModelResult = await this.resolveTenantModelById(
                  projectModel.tenantModelId,
                  context.tenantId,
                  credentialOverride,
                );

                if (!tenantModelResult) {
                  log.warn('Deployment model override TenantModel resolution returned null', {
                    projectId: context.projectId,
                    modelId: dmo.model,
                    tenantModelId: projectModel.tenantModelId,
                    tenantId: context.tenantId,
                  });
                  throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
                }

                if (tenantModelResult) {
                  this.suppressTenantLegacySamplingForDynamicProjectConfig(
                    projectModel,
                    tenantModelResult,
                  );
                  modelId = tenantModelResult.modelId;
                  source = 'project_db';
                  if ((projectModel as any).useResponsesApi != null) {
                    tenantModelResult.useResponsesApi = (projectModel as any).useResponsesApi;
                  }
                  if ((projectModel as any).useStreaming != null) {
                    tenantModelResult.useStreaming = (projectModel as any).useStreaming;
                  }
                }
              }

              if (!modelId) {
                modelId = projectModel.modelId;
                source = 'project_db';
              }
              applyModelConfigRuntimeMetadata(projectModel);
            }
          } catch (err) {
            if (err instanceof ProjectCredentialOverrideError) {
              throw err;
            }
            if (err instanceof AppError && err.code === ErrorCodes.MODEL_NOT_CONFIGURED.code) {
              throw err;
            }
            resolutionErrors.push(
              `Deployment model override project lookup: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            log.warn('Deployment model override project lookup failed', {
              error: err instanceof Error ? err.message : String(err),
              projectId: context.projectId,
              modelId: dmo.model,
            });
          }
        }

        if (!resolvedViaProjectConfig) {
          modelId = dmo.model;
          source = 'agent_ir'; // Treat as snapshot-level source
        }
      }
      if (dmo.temperature != null) temperature = dmo.temperature;
      if (dmo.maxTokens != null) maxTokens = dmo.maxTokens;
    }

    // --- Level 1: Agent IR (DSL-defined) ---
    if (context.agentIR) {
      const exec = context.agentIR.execution;
      const opModel = exec.operation_models?.[context.operationType];
      if (opModel) {
        modelId = opModel;
        dslPinnedModelId = opModel;
        source = 'agent_ir';
      }
      if (!modelId && exec.model) {
        modelId = exec.model;
        dslPinnedModelId = exec.model;
        source = 'agent_ir';
      }
      temperature = exec.temperature;
      maxTokens = exec.max_tokens;
      // Reasoning model parameters from DSL
      if (exec.reasoning_effort) reasoningEffort = exec.reasoning_effort;
      if (exec.enable_thinking != null) enableThinking = exec.enable_thinking;
      if (exec.thinking_budget != null) thinkingBudget = exec.thinking_budget;
      if ((exec as any).thought_description) thoughtDescription = (exec as any).thought_description;
      if (exec.compaction_threshold != null) compactionThreshold = exec.compaction_threshold;
    }

    // --- Level 2: Agent DB (per-agent config in database) ---
    if (!modelId && this.dbAvailable && context.projectId && context.agentName) {
      try {
        // Try exact match first, then fallback to DSL name → slug mapping
        let agentConfig = await findAgentModelConfig(
          context.projectId,
          context.agentName,
          context.tenantId,
        );
        if (!agentConfig) {
          agentConfig = await findAgentModelConfigByDslName(
            context.projectId,
            context.agentName,
            context.tenantId,
          );
        }

        if (!agentConfig) {
          log.warn('Level 2: no AgentModelConfig found', {
            projectId: context.projectId,
            agentName: context.agentName,
            tenantId: context.tenantId,
          });
        }

        if (agentConfig) {
          const opModels = parseJsonField(agentConfig.operationModels) || {};
          const opModel = opModels[context.operationType];
          let agentDefaultModel = opModel || agentConfig.defaultModel || null;

          log.debug('Level 2: AgentModelConfig found', {
            agentName: context.agentName,
            defaultModel: agentDefaultModel,
            operationType: context.operationType,
            tenantId: context.tenantId,
          });

          // Resolve through project model_configs to find the TenantModel + correct provider.
          // The agent config stores a modelId (e.g., 'GPT-4o') which may be ambiguous —
          // the model_config links it to the correct TenantModel with credentials.
          if (agentDefaultModel && context.projectId) {
            const matchingModelConfig = await findModelConfigByModelId(
              context.projectId,
              agentDefaultModel,
              context.tenantId,
            );

            if (!matchingModelConfig) {
              log.warn('Level 2: no ModelConfig found for modelId', {
                projectId: context.projectId,
                modelId: agentDefaultModel,
                tenantId: context.tenantId,
              });
            } else if (!matchingModelConfig.tenantModelId) {
              log.warn('Level 2: ModelConfig found but no tenantModelId', {
                projectId: context.projectId,
                modelId: agentDefaultModel,
                modelConfigId: (matchingModelConfig as any)._id || (matchingModelConfig as any).id,
                tenantId: context.tenantId,
              });
            }

            const credentialOverride = matchingModelConfig
              ? this.extractProjectCredentialOverride(matchingModelConfig)
              : undefined;
            if (credentialOverride) {
              projectCredentialOverride = credentialOverride;
            }
            if (matchingModelConfig) {
              applyModelConfigRuntimeMetadata(matchingModelConfig);
            }

            if (matchingModelConfig) {
              if (matchingModelConfig.tenantModelId) {
                tenantModelResult = await this.resolveTenantModelById(
                  matchingModelConfig.tenantModelId,
                  context.tenantId,
                  credentialOverride,
                );

                if (!tenantModelResult) {
                  log.warn('Level 2: TenantModel resolution returned null', {
                    tenantModelId: matchingModelConfig.tenantModelId,
                    projectId: context.projectId,
                    modelId: agentDefaultModel,
                    tenantId: context.tenantId,
                  });
                  throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
                }

                if (tenantModelResult) {
                  this.suppressTenantLegacySamplingForDynamicProjectConfig(
                    matchingModelConfig,
                    tenantModelResult,
                  );
                  modelId = tenantModelResult.modelId;
                  source = 'agent_db';
                  // Agent-level useResponsesApi overrides model config level
                  if ((agentConfig as any).useResponsesApi != null) {
                    tenantModelResult.useResponsesApi = (agentConfig as any).useResponsesApi;
                  } else if ((matchingModelConfig as any).useResponsesApi != null) {
                    tenantModelResult.useResponsesApi = (
                      matchingModelConfig as any
                    ).useResponsesApi;
                  }
                  // Agent-level useStreaming overrides model config level
                  if ((agentConfig as any).useStreaming != null) {
                    tenantModelResult.useStreaming = (agentConfig as any).useStreaming;
                  } else {
                    const matchingStreaming = this.extractStreamingOverride(matchingModelConfig);
                    if (matchingStreaming != null) {
                      tenantModelResult.useStreaming = matchingStreaming;
                    }
                  }
                }
              }
              if (!modelId) {
                modelId = matchingModelConfig.modelId;
                source = 'agent_db';
              }
            }
          }

          const agentHyperParameters = this.extractHyperParameterValues(
            agentConfig.hyperParameters,
          );
          const agentHasHyperParameterBag = this.hasStoredHyperParameters(
            agentConfig.hyperParameters,
          );
          if (
            agentConfig.temperature != null &&
            (!agentHasHyperParameterBag || agentHyperParameters.temperature !== undefined)
          ) {
            temperature = agentConfig.temperature;
          }
          if (agentConfig.maxTokens != null) maxTokens = agentConfig.maxTokens;
          applyHyperParameterOverrides(agentConfig.hyperParameters);
          if ((agentConfig as any).useResponsesApi != null) {
            useResponsesApiOverride = (agentConfig as any).useResponsesApi;
          }
          if ((agentConfig as any).useStreaming != null) {
            useStreamingOverride = (agentConfig as any).useStreaming;
          }
        }
      } catch (err) {
        if (err instanceof ProjectCredentialOverrideError) {
          throw err;
        }
        if (err instanceof AppError && err.code === ErrorCodes.MODEL_NOT_CONFIGURED.code) {
          throw err;
        }
        resolutionErrors.push(`Agent DB: ${err instanceof Error ? err.message : String(err)}`);
        log.warn('Level 2 (agent DB) resolution failed', {
          error: err instanceof Error ? err.message : String(err),
          projectId: context.projectId,
          agentName: context.agentName,
        });
      }
    }

    // --- Level 3: Project DB (default model config → TenantModel) ---
    if (!modelId && this.dbAvailable && context.projectId) {
      try {
        const hasProjectTierLookup = this.shouldUseProjectTierLookup(
          context.operationType,
          projectTierOverrides,
        );
        const tier = hasProjectTierLookup
          ? this.operationToTier(context.operationType, projectTierOverrides)
          : null;
        const projectModel = tier
          ? await findModelConfigForTier(context.projectId, tier, context.tenantId)
          : null;

        log.debug('Level 3: project model lookup', {
          projectId: context.projectId,
          tier,
          operationTierRoutingEnabled: hasProjectTierLookup,
          found: !!projectModel,
          tenantModelId: projectModel?.tenantModelId,
          tenantId: context.tenantId,
        });

        if (projectModel) {
          applyModelConfigRuntimeMetadata(projectModel);
          const credentialOverride = this.extractProjectCredentialOverride(projectModel);
          if (credentialOverride) {
            projectCredentialOverride = credentialOverride;
          }
          // If linked to a TenantModel, use that for credentials
          if (projectModel.tenantModelId) {
            tenantModelResult = await this.resolveTenantModelById(
              projectModel.tenantModelId,
              context.tenantId,
              credentialOverride,
            );

            if (!tenantModelResult) {
              log.warn('Level 3: TenantModel resolution returned null', {
                tenantModelId: projectModel.tenantModelId,
                projectId: context.projectId,
                tier,
                tenantId: context.tenantId,
              });
              throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
            }

            if (tenantModelResult) {
              this.suppressTenantLegacySamplingForDynamicProjectConfig(
                projectModel,
                tenantModelResult,
              );
              modelId = tenantModelResult.modelId;
              source = 'project_db';
              // Project-level useResponsesApi overrides tenant-level
              if ((projectModel as any).useResponsesApi != null) {
                tenantModelResult.useResponsesApi = (projectModel as any).useResponsesApi;
              }
              // Project-level useStreaming overrides tenant-level
              const projectStreaming = this.extractStreamingOverride(projectModel);
              if (projectStreaming != null) {
                tenantModelResult.useStreaming = projectStreaming;
              }
            }
          }
          if (!modelId) {
            modelId = projectModel.modelId;
            source = 'project_db';
          }
        } else if (context.operationType !== 'realtime_voice' && tier !== 'voice') {
          // Fall back to any project model
          const anyModel = await findAnyModelConfig(context.projectId, context.tenantId);
          if (anyModel) {
            applyModelConfigRuntimeMetadata(anyModel);
            const credentialOverride = this.extractProjectCredentialOverride(anyModel);
            if (credentialOverride) {
              projectCredentialOverride = credentialOverride;
            }
            if (anyModel.tenantModelId) {
              tenantModelResult = await this.resolveTenantModelById(
                anyModel.tenantModelId,
                context.tenantId,
                credentialOverride,
              );
              if (!tenantModelResult) {
                log.warn('Level 3: fallback TenantModel resolution returned null', {
                  tenantModelId: anyModel.tenantModelId,
                  projectId: context.projectId,
                  tenantId: context.tenantId,
                });
                throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
              }
              if (tenantModelResult) {
                this.suppressTenantLegacySamplingForDynamicProjectConfig(
                  anyModel,
                  tenantModelResult,
                );
                modelId = tenantModelResult.modelId;
                source = 'project_db';
                // Project-level useResponsesApi overrides tenant-level
                if ((anyModel as any).useResponsesApi != null) {
                  tenantModelResult.useResponsesApi = (anyModel as any).useResponsesApi;
                }
                // Project-level useStreaming overrides tenant-level
                const anyModelStreaming = this.extractStreamingOverride(anyModel);
                if (anyModelStreaming != null) {
                  tenantModelResult.useStreaming = anyModelStreaming;
                }
              }
            }
            if (!modelId) {
              modelId = anyModel.modelId;
              source = 'project_db';
            }
          }
        }
      } catch (err) {
        if (err instanceof ProjectCredentialOverrideError) {
          throw err;
        }
        if (err instanceof AppError && err.code === ErrorCodes.MODEL_NOT_CONFIGURED.code) {
          throw err;
        }
        resolutionErrors.push(`Project DB: ${err instanceof Error ? err.message : String(err)}`);
        log.warn('Level 3 (project DB) resolution failed', {
          error: err instanceof Error ? err.message : String(err),
          projectId: context.projectId,
        });
      }
    }

    // --- Level 3 fallback: Project-level enableThinking/thinkingBudget/thoughtDescription default ---
    if (projectEnableThinking != null) {
      if (enableThinking == null && projectEnableThinking.enableThinking != null) {
        enableThinking = projectEnableThinking.enableThinking;
      }
      if (thinkingBudget == null && projectEnableThinking.thinkingBudget != null) {
        thinkingBudget = projectEnableThinking.thinkingBudget;
      }
      if (thoughtDescription == null && projectEnableThinking.thoughtDescription != null) {
        thoughtDescription = projectEnableThinking.thoughtDescription;
      }
      if (compactionThreshold == null && projectEnableThinking.compactionThreshold != null) {
        compactionThreshold = projectEnableThinking.compactionThreshold;
      }
    }

    // --- Level 3b: Voice-specific resolution (capability-based) ---
    if (
      !modelId &&
      context.operationType === 'realtime_voice' &&
      this.dbAvailable &&
      context.tenantId
    ) {
      try {
        const voiceTm = await findDefaultTenantModelForVoice(context.tenantId);
        if (voiceTm) {
          tenantModelResult = await this.buildTenantModelResolution(voiceTm);
          if (tenantModelResult) {
            modelId = tenantModelResult.modelId;
            source = 'tenant_model';
            if (temperature == null) temperature = tenantModelResult.temperature;
            if (maxTokens == null) maxTokens = tenantModelResult.maxTokens;
          }
        }
      } catch (err) {
        resolutionErrors.push(`Voice model: ${err instanceof Error ? err.message : String(err)}`);
        log.warn('Voice model resolution failed', {
          error: err instanceof Error ? err.message : String(err),
          tenantId: context.tenantId,
        });
      }
    }

    // --- Level 4: Tenant Model ---
    if (
      !modelId &&
      context.operationType !== 'realtime_voice' &&
      this.dbAvailable &&
      context.tenantId
    ) {
      const shouldUseTierDefault =
        !context.projectId ||
        this.shouldUseProjectTierLookup(context.operationType, projectTierOverrides);
      const tier = shouldUseTierDefault
        ? this.operationToTier(context.operationType, projectTierOverrides)
        : null;
      tenantModelResult = tier
        ? await this.resolveTenantModelDefault(context.tenantId, tier)
        : null;

      // 4b: Fallback to the tenant default model (one-model-for-everything default)
      if (!tenantModelResult) {
        tenantModelResult = await this.resolveAnyTenantModel(context.tenantId);
      }

      if (tenantModelResult) {
        modelId = tenantModelResult.modelId;
        source = 'tenant_model';
        if (temperature == null) temperature = tenantModelResult.temperature;
        if (maxTokens == null) maxTokens = tenantModelResult.maxTokens;
      }
    }

    // --- Pinned DSL modelId tail: project ModelConfig, then tenant TenantModel fallback ---
    if (dslPinnedModelId && !tenantModelResult && this.dbAvailable) {
      const dslModelId = dslPinnedModelId;

      // Phase A — project ModelConfig: if the project pinned a binding for
      // this modelId, follow it to its TenantModel + credential override.
      if (context.projectId) {
        try {
          const projectModel = await findModelConfigByModelId(
            context.projectId,
            dslModelId,
            context.tenantId,
          );

          if (projectModel) {
            if (projectModel.tenantModelId) {
              applyModelConfigRuntimeMetadata(projectModel);
              const credentialOverride = this.extractProjectCredentialOverride(projectModel);
              if (credentialOverride) {
                projectCredentialOverride = credentialOverride;
              }

              tenantModelResult = await this.resolveTenantModelById(
                projectModel.tenantModelId,
                context.tenantId,
                credentialOverride,
              );

              if (!tenantModelResult) {
                log.warn('DSL tail (project): TenantModel resolution returned null', {
                  tenantModelId: projectModel.tenantModelId,
                  projectId: context.projectId,
                  dslModelId,
                  tenantId: context.tenantId,
                });
                throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
              }

              this.suppressTenantLegacySamplingForDynamicProjectConfig(
                projectModel,
                tenantModelResult,
              );
              modelId = tenantModelResult.modelId;
              source = 'project_db';

              if ((projectModel as any).useResponsesApi != null) {
                tenantModelResult.useResponsesApi = (projectModel as any).useResponsesApi;
              }
              const projectStreaming = this.extractStreamingOverride(projectModel);
              if (projectStreaming != null) {
                tenantModelResult.useStreaming = projectStreaming;
              }

              log.debug('DSL tail (project): resolved DSL modelId via project registry', {
                projectId: context.projectId,
                dslModelId,
                resolvedModelId: modelId,
                provider: tenantModelResult.provider,
                tenantModelId: projectModel.tenantModelId,
                tenantId: context.tenantId,
              });
            } else {
              log.warn('DSL tail (project): ModelConfig found but no tenantModelId; continuing', {
                projectId: context.projectId,
                dslModelId,
                modelConfigId: (projectModel as any)._id || (projectModel as any).id,
                tenantId: context.tenantId,
              });
            }
          } else {
            log.debug('DSL tail (project): no project ModelConfig for DSL modelId', {
              projectId: context.projectId,
              dslModelId,
              tenantId: context.tenantId,
            });
          }
        } catch (err) {
          if (err instanceof ProjectCredentialOverrideError) {
            throw err;
          }
          if (err instanceof AppError && err.code === ErrorCodes.MODEL_NOT_CONFIGURED.code) {
            throw err;
          }
          resolutionErrors.push(
            `DSL tail (project): ${err instanceof Error ? err.message : String(err)}`,
          );
          log.warn('DSL tail (project) failed', {
            error: err instanceof Error ? err.message : String(err),
            projectId: context.projectId,
            dslModelId,
          });
        }
      }

      // Phase B — tenant TenantModel: workspace-level custom-model fallback.
      if (!tenantModelResult && context.tenantId) {
        try {
          const { TenantModel } = await import('@agent-platform/database/models');
          const candidates = await TenantModel.find({
            tenantId: context.tenantId,
            modelId: dslModelId,
            isActive: true,
            inferenceEnabled: true,
          })
            .sort({ isDefault: -1 })
            .select({ _id: 1, isDefault: 1 })
            .lean();

          if (candidates.length === 0) {
            log.debug('DSL tail (tenant): no tenant TenantModel for DSL modelId', {
              tenantId: context.tenantId,
              dslModelId,
            });
          } else {
            let built: TenantModelResolution | null = null;
            let chosenTenantModelId: unknown = null;
            let chosenIsDefault = false;
            const skipped: Array<{ tenantModelId: string; isDefault: boolean }> = [];

            for (const candidate of candidates) {
              const attempt = await this.resolveTenantModelById(candidate._id, context.tenantId);
              if (attempt) {
                built = attempt;
                chosenTenantModelId = candidate._id;
                chosenIsDefault = !!candidate.isDefault;
                break;
              }
              skipped.push({
                tenantModelId: String(candidate._id),
                isDefault: !!candidate.isDefault,
              });
            }

            if (built) {
              tenantModelResult = built;
              modelId = built.modelId;
              source = 'tenant_model';
              if (temperature == null) temperature = built.temperature;
              if (maxTokens == null) maxTokens = built.maxTokens;
              log.debug('DSL tail (tenant): resolved DSL modelId via tenant model registry', {
                tenantId: context.tenantId,
                projectId: context.projectId,
                dslModelId,
                resolvedModelId: modelId,
                provider: built.provider,
                tenantModelId: chosenTenantModelId,
                isDefault: chosenIsDefault,
                candidateCount: candidates.length,
                skippedUnusable: skipped,
              });
            } else {
              log.warn('DSL tail (tenant): all matching TenantModels unusable', {
                tenantId: context.tenantId,
                projectId: context.projectId,
                dslModelId,
                candidateCount: candidates.length,
                skippedUnusable: skipped,
              });
              throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
            }
          }
        } catch (err) {
          if (err instanceof AppError && err.code === ErrorCodes.MODEL_NOT_CONFIGURED.code) {
            throw err;
          }
          resolutionErrors.push(
            `DSL tail (tenant): ${err instanceof Error ? err.message : String(err)}`,
          );
          log.warn('DSL tail (tenant) failed', {
            error: err instanceof Error ? err.message : String(err),
            tenantId: context.tenantId,
            dslModelId,
          });
        }
      }
    }

    if (tenantModelResult) {
      applyModelConfigRuntimeMetadata(
        {
          temperature: tenantModelResult.temperature,
          maxTokens: tenantModelResult.maxTokens,
          hyperParameters: tenantModelResult.parameters,
        },
        'fill',
      );
    }

    // --- Level 5: FAIL ---
    if (!modelId) {
      log.error('Model resolution FAILED — no model configured', {
        tenantId: context.tenantId,
        projectId: context.projectId,
        agentName: context.agentName,
        operationType: context.operationType,
        resolutionErrors,
        dbAvailable: this.dbAvailable,
      });
      throw createModelResolutionConfigurationError('LLM_MODEL_NOT_CONFIGURED');
    }

    // Extract provider — prefer the TenantModel's explicit provider (handles Azure, Bedrock,
    // etc. where model names don't indicate the provider) over inference from model ID.
    const inferredProvider = tenantModelResult?.provider || inferProviderFromModelId(modelId);

    // When the model comes from agent DSL (Level 0/1) and the provider can't be inferred,
    // try to fall back to the tenant's default TenantModel. If the tenant has a working
    // model configured, use that instead of failing on an unrecognized model name.
    // This handles: agent says `model: qwen35-a3b-35b` but no Qwen credentials exist —
    // the tenant default (e.g. Claude, GPT-4o) takes over gracefully.
    if (!inferredProvider && !tenantModelResult && this.dbAvailable && context.tenantId) {
      log.warn('Cannot infer provider from model ID — falling back to tenant default model', {
        modelId,
        source,
        tenantId: context.tenantId,
      });
      const fallbackTm = await findAnyDefaultTenantModel(context.tenantId);
      if (fallbackTm) {
        const fallbackResolution = await this.buildTenantModelResolution(fallbackTm);
        if (fallbackResolution) {
          tenantModelResult = fallbackResolution;
          modelId = (fallbackTm as any).modelId || modelId;
          source = 'tenant_model';
        }
      }
    }

    const resolvedProvider = tenantModelResult?.provider || inferredProvider;

    if (!resolvedProvider) {
      log.error('Model resolution FAILED — no provider resolved', {
        modelId,
        source,
        inferredProvider,
        hasTenantModelResult: !!tenantModelResult,
        tenantId: context.tenantId,
        projectId: context.projectId,
        agentName: context.agentName,
        resolutionErrors,
        dbAvailable: this.dbAvailable,
        tenantEncryptionReady: this.isTenantEncryptionReady(),
      });
      throw createModelResolutionConfigurationError('LLM_PROVIDER_CONFIGURATION_INVALID');
    }

    // Narrowed to non-null after guard checks above
    const provider: string = resolvedProvider;
    const resolvedModelId: string = modelId!;

    const modelCapabilities = getModelCapabilities(resolvedModelId);
    if (modelCapabilities.temperatureDisabled) {
      temperature = undefined;
    }
    if (modelCapabilities.topPDisabled) {
      topP = undefined;
    }
    if (!modelCapabilities.supportsReasoningEffort) {
      reasoningEffort = undefined;
    }
    if (!modelCapabilities.supportsThinking && !modelCapabilities.supportsThinkingBudget) {
      enableThinking = undefined;
      thinkingBudget = undefined;
      thinkingLevel = undefined;
    }
    const supportedParameters = this.getSupportedResolvedParameterKeys(resolvedModelId, provider);
    for (const parameterKey of PROVIDER_PARAMETER_KEYS) {
      if (supportedParameters.has(parameterKey)) {
        continue;
      }
      switch (parameterKey) {
        case 'temperature':
          temperature = undefined;
          break;
        case 'topP':
          topP = undefined;
          break;
        case 'topK':
          topK = undefined;
          break;
        case 'frequencyPenalty':
          frequencyPenalty = undefined;
          break;
        case 'presencePenalty':
          presencePenalty = undefined;
          break;
        case 'seed':
          seed = undefined;
          break;
        case 'stopSequences':
          stopSequences = undefined;
          break;
        case 'reasoningEffort':
          reasoningEffort = undefined;
          break;
        case 'enableThinking':
          enableThinking = undefined;
          break;
        case 'thinkingBudget':
          thinkingBudget = undefined;
          break;
        case 'thinkingLevel':
          thinkingLevel = undefined;
          break;
      }
    }

    // --- Enforce provider allowlist ---
    if (tenantPolicy) {
      this.enforceProviderAllowlist(tenantPolicy, provider, resolvedModelId);
    }

    // Budget enforcement is intentionally NOT here — it's per-caller, not
    // per-resolution. Singleflight shares this result across concurrent
    // callers, so enforceBudget() runs in resolve() after awaiting the
    // shared promise. This ensures each caller gets its own reservation.

    const cached: CachedResolution = {
      modelId: resolvedModelId,
      provider,
      source,
      parameters: {
        temperature,
        maxTokens,
        topP,
        topK,
        frequencyPenalty,
        presencePenalty,
        seed,
        stopSequences,
        reasoningEffort,
        enableThinking,
        thinkingBudget,
        thinkingLevel,
        thoughtDescription,
        compactionThreshold,
        contextWindow,
      },
      capabilities: capabilities ?? tenantModelResult?.capabilities,
      pricing,
      customEndpoint: tenantModelResult?.customEndpoint,
      apiIntegration: tenantModelResult?.apiIntegration,
      realtimeConfig: tenantModelResult?.realtimeConfig,
      useResponsesApi: useResponsesApiOverride ?? tenantModelResult?.useResponsesApi,
      useStreaming: useStreamingOverride ?? tenantModelResult?.useStreaming,
      tenantModelId: tenantModelResult?.tenantModelId,
      connectionId: undefined,
      projectCredentialOverride,
      tenantId: context.tenantId,
      credentialSource:
        tenantModelResult || projectCredentialOverride
          ? undefined
          : { type: context.userId ? 'user' : 'tenant', provider },
      cachedAt: Date.now(),
    };

    // Cache metadata only — never cache decrypted credentials.
    // Skip if a clearCache() was called mid-flight (generation mismatch)
    // to avoid re-populating the cache with potentially stale data.
    if (this.cacheGeneration === startGeneration) {
      // Evict oldest if at capacity
      if (this.metadataCache.size >= ModelResolutionService.MAX_CACHE_SIZE) {
        const firstKey = this.metadataCache.keys().next().value;
        if (firstKey) this.metadataCache.delete(firstKey);
      }
      this.metadataCache.set(cacheKey, cached);
    } else {
      log.debug('Skipping cache write — generation changed mid-resolution', {
        cacheKey,
        startGeneration,
        currentGeneration: this.cacheGeneration,
      });
    }

    if (!options.includeCredential) {
      log.debug('Resolved reasoning settings snapshot', {
        modelId: resolvedModelId,
        provider,
        source,
        tenantId: context.tenantId,
        projectId: context.projectId,
        agentName: context.agentName,
        dbAvailable: this.dbAvailable,
        tenantEncryptionReady: this.isTenantEncryptionReady(),
      });
      return { cached };
    }

    return {
      cached,
      credential: tenantModelResult
        ? tenantModelResult.credential
        : projectCredentialOverride
          ? await this.resolveProjectCredentialOverride(projectCredentialOverride, context.tenantId)
          : await this.resolveCredential(context, provider, tenantPolicy),
    };
  }

  // ===========================================================================
  // TENANT MODEL RESOLUTION
  // ===========================================================================

  /**
   * Resolve a specific TenantModel by ID, loading its primary connection.
   */
  private async resolveTenantModelById(
    tenantModelId: string,
    tenantId: string | undefined,
    credentialOverride?: ProjectCredentialOverride,
  ): Promise<TenantModelResolution | null> {
    if (!this.dbAvailable || !this.isTenantEncryptionReady()) return null;
    if (!tenantId) {
      log.warn('resolveTenantModelById called without tenantId — cannot resolve securely', {
        tenantModelId,
      });
      return null;
    }

    try {
      const tm = await findTenantModelByIdWithPrimaryConnection(tenantModelId, tenantId);

      if (!tm) {
        log.warn('resolveTenantModelById: DB returned null', {
          tenantModelId,
          tenantId,
        });
        return null;
      }
      if (!tm.isActive || !tm.inferenceEnabled) {
        log.warn('resolveTenantModelById: TenantModel inactive or inference disabled', {
          tenantModelId,
          tenantId,
          isActive: tm.isActive,
          inferenceEnabled: tm.inferenceEnabled,
          provider: tm.provider,
          modelId: tm.modelId,
        });
        return null;
      }

      const resolution = await this.buildTenantModelResolution(tm, credentialOverride);
      if (!resolution) {
        log.warn('resolveTenantModelById: buildTenantModelResolution returned null', {
          tenantModelId,
          tenantId,
          provider: tm.provider,
          modelId: tm.modelId,
          hasConnections: !!(tm as any).connections?.length,
        });
      }
      return resolution;
    } catch (err) {
      if (err instanceof ProjectCredentialOverrideError) {
        throw err;
      }
      log.warn('TenantModel resolution by ID failed', {
        tenantModelId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve the default TenantModel for a tenant + tier.
   */
  private async resolveTenantModelDefault(
    tenantId: string,
    tier: string,
  ): Promise<TenantModelResolution | null> {
    if (!this.dbAvailable || !this.isTenantEncryptionReady()) return null;

    try {
      const tm = await findDefaultTenantModelForTier(tenantId, tier);
      if (!tm) return null;
      return await this.buildTenantModelResolution(tm);
    } catch (err) {
      log.warn('TenantModel default resolution failed', {
        tenantId,
        tier,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve any default TenantModel for a tenant, regardless of tier.
   * Used as the tier-agnostic fallback (one-model-for-everything default).
   */
  private async resolveAnyTenantModel(tenantId: string): Promise<TenantModelResolution | null> {
    if (!this.dbAvailable || !this.isTenantEncryptionReady()) return null;

    try {
      const tm = await findAnyDefaultTenantModel(tenantId);
      if (!tm) return null;
      return await this.buildTenantModelResolution(tm);
    } catch (err) {
      log.warn('TenantModel tier-agnostic resolution failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Build a TenantModelResolution from a TenantModel + its primary connection.
   */
  private async buildTenantModelResolution(
    tm: any,
    credentialOverride?: ProjectCredentialOverride,
  ): Promise<TenantModelResolution | null> {
    const connection = tm.connections?.[0];
    if (!connection && tm.integrationType !== 'api' && !credentialOverride) {
      log.warn('TenantModel has no active primary connection', {
        tenantModelId: tm.id || tm._id,
        allConnections: (tm.connections || []).length,
        integrationType: tm.integrationType,
      });
      return null;
    }

    let credential: ResolvedCredential | null | undefined;

    if (credentialOverride) {
      credential = await this.resolveProjectCredentialOverride(
        credentialOverride,
        tm.tenantId,
        tm.id || tm._id,
      );
    }

    // ── Auth Profile dual-read ──────────────────────────────────────
    // When authProfileId is present, resolve via auth profile.
    // Errors propagate — we do NOT silently fall back to legacy.
    // See packages/shared-auth-profile/src/dual-read.ts for design principle.
    if (credential) {
      // Credential already resolved via a project-level override.
    } else if (connection?.authProfileId) {
      try {
        credential = await this.resolveViaAuthProfile(connection.authProfileId, tm.tenantId);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error('Auth profile resolution failed — not falling back to legacy', {
          authProfileId: connection.authProfileId,
          tenantModelId: tm.id || tm._id,
          tenantId: tm.tenantId,
          error: errMsg,
        });
        throw new AppError(
          `Auth profile resolution failed for connection (authProfileId=${connection.authProfileId}): ${errMsg}`,
          { code: ErrorCodes.INTERNAL_ERROR.code, statusCode: 500 },
        );
      }

      // Auth profile was found but returned no usable credential
      if (!credential) {
        log.error('Auth profile resolved but returned no credential — not falling back to legacy', {
          authProfileId: connection.authProfileId,
          tenantModelId: tm.id || tm._id,
          tenantId: tm.tenantId,
        });
        throw new AppError(
          `Auth profile (${connection.authProfileId}) returned no usable credential (not found, inactive, or missing API key)`,
          { code: ErrorCodes.INTERNAL_ERROR.code, statusCode: 500 },
        );
      }
    }

    // ── Legacy credential resolution ────────────────────────────────
    if (credential) {
      // Credential already resolved via project override or auth profile — skip legacy paths
    } else if (connection?.credentialId && this.isTenantEncryptionReady()) {
      try {
        const cred = await findCredentialById(connection.credentialId, tm.tenantId);
        if (!cred) {
          log.warn('Credential not found for connection', {
            credentialId: connection.credentialId,
            tenantModelId: tm.id || tm._id,
          });
          return null;
        }

        credential = await resolveStoredCredential(
          cred,
          tm.tenantId,
          'Credential API key unavailable after decryption',
          {
            credentialId: connection.credentialId,
            tenantModelId: tm.id || tm._id,
            ire: cred.ire,
            hasIv: !!cred.iv,
            hasCek: !!cred.cek,
            decryptionFailed: !!cred._decryptionFailed,
          },
        );
        if (!credential) {
          return null;
        }
      } catch (decryptErr) {
        log.warn('Failed to load credential', {
          credentialId: connection.credentialId,
          tenantModelId: tm.id || tm._id,
          error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
        });
        return null;
      }
    } else if (connection?.encryptedApiKey && this.isTenantEncryptionReady()) {
      // Direct encrypted API key on the connection (no separate credential record)
      try {
        const rawKey = connection.encryptedApiKey;
        const decryptionKey = tm.tenantId || '';
        const apiKey = isEncryptedFormat(rawKey)
          ? await decryptForTenantAuto(rawKey, decryptionKey)
          : rawKey;

        credential = {
          apiKey,
          endpoint: connection.encryptedEndpoint
            ? isEncryptedFormat(connection.encryptedEndpoint)
              ? await decryptForTenantAuto(connection.encryptedEndpoint, decryptionKey)
              : connection.encryptedEndpoint
            : undefined,
          authType: connection.authType || 'api_key',
          authConfig: parseJsonField(connection.authConfig),
        };
      } catch (decryptErr) {
        log.warn('Failed to decrypt connection API key', {
          tenantModelId: tm.id || tm._id,
          error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
        });
        return null;
      }
    } else if (tm.integrationType === 'api') {
      // API integration without explicit credentials (IAM/header auth)
      credential = {
        apiKey: '',
        endpoint: '',
        authType: 'none',
        authConfig: undefined,
      };
    } else if (!connection) {
      log.warn('TenantModel has no active primary connection', { tenantModelId: tm.id || tm._id });
      return null;
    } else {
      return null;
    }

    if (!credential) {
      return null;
    }

    const customEndpoint = tm.customEndpoint || tm.endpointUrl || undefined;
    if (customEndpoint && !credential.endpoint) {
      credential.endpoint = customEndpoint;
    }

    const resolvedModelId = tm.modelId || tm.displayName;
    if (!tm.modelId && tm.integrationType !== 'api') {
      log.warn('TenantModel has null modelId — falling back to displayName as model identifier', {
        tenantModelId: tm.id || tm._id,
        displayName: tm.displayName,
        integrationType: tm.integrationType,
      });
    }

    const parameters = this.extractHyperParameterValues(tm.hyperParameters);
    const hasHyperParameterBag = this.hasStoredHyperParameters(tm.hyperParameters);
    const result: TenantModelResolution = {
      tenantModelId: tm.id || tm._id,
      modelId: resolvedModelId,
      provider: tm.provider || inferProviderFromModelId(resolvedModelId) || 'unknown',
      credential,
      temperature:
        !hasHyperParameterBag || parameters.temperature !== undefined
          ? (parameters.temperature ?? tm.temperature)
          : undefined,
      maxTokens: parameters.maxTokens ?? tm.maxTokens,
      parameters,
      capabilities: {
        supportsTools: tm.supportsTools,
        supportsVision: tm.supportsVision,
        supportsStreaming: tm.supportsStreaming,
      },
      customEndpoint,
      useResponsesApi: tm.useResponsesApi ?? undefined,
      useStreaming: tm.useStreaming ?? (tm.supportsStreaming === false ? false : undefined),
    };

    if (tm.integrationType === 'api') {
      result.apiIntegration = {
        providerStructure: tm.providerStructure || 'custom',
        requestTemplate: parseJsonField(tm.requestTemplate) || undefined,
        responseMapping: parseJsonField(tm.responseMapping) || undefined,
        customHeaders: parseJsonField(tm.customHeaders) || undefined,
      };
    }

    // Attach realtime voice config if present
    const realtimeConfig = parseJsonField(tm.realtimeConfig);
    if (realtimeConfig) {
      result.realtimeConfig = realtimeConfig;
    }

    return result;
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  private async resolveProjectCredentialOverride(
    override: ProjectCredentialOverride,
    tenantId: string | undefined,
    tenantModelId?: string,
  ): Promise<ResolvedCredential> {
    if (!tenantId) {
      log.error('Project model credential override requires tenantId', {
        modelConfigId: override.modelConfigId,
        tenantModelId,
      });
      throw new ProjectCredentialOverrideError();
    }

    if (override.authProfileId) {
      try {
        const credential = await this.resolveViaAuthProfile(override.authProfileId, tenantId);
        if (credential) {
          return credential;
        }
      } catch (error) {
        log.error('Project model auth profile override failed', {
          authProfileId: override.authProfileId,
          modelConfigId: override.modelConfigId,
          tenantModelId,
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new ProjectCredentialOverrideError(error);
      }

      log.error('Project model auth profile override returned no credential', {
        authProfileId: override.authProfileId,
        modelConfigId: override.modelConfigId,
        tenantModelId,
        tenantId,
      });
      throw new ProjectCredentialOverrideError();
    }

    if (override.credentialId) {
      if (!this.isTenantEncryptionReady()) {
        log.error('Project model credential override requires tenant encryption', {
          credentialId: override.credentialId,
          modelConfigId: override.modelConfigId,
          tenantModelId,
          tenantId,
        });
        throw new ProjectCredentialOverrideError();
      }

      const credentialRecord = await findCredentialById(override.credentialId, tenantId);
      if (!credentialRecord) {
        log.error('Project model credential override record not found', {
          credentialId: override.credentialId,
          modelConfigId: override.modelConfigId,
          tenantModelId,
          tenantId,
        });
        throw new ProjectCredentialOverrideError();
      }

      const credential = await resolveStoredCredential(
        credentialRecord,
        tenantId,
        'Project model credential override unavailable after decryption',
        {
          credentialId: override.credentialId,
          modelConfigId: override.modelConfigId,
          tenantModelId,
          tenantId,
          ire: credentialRecord.ire,
          hasIv: !!credentialRecord.iv,
          hasCek: !!credentialRecord.cek,
          decryptionFailed: !!credentialRecord._decryptionFailed,
        },
      );
      if (credential) {
        return credential;
      }

      throw new ProjectCredentialOverrideError();
    }

    throw new ProjectCredentialOverrideError();
  }

  /**
   * Resolve credential from Auth Profile by authProfileId.
   *
   * Contract:
   * - Not found / inactive / expired / no API key: returns null (with warn log)
   * - System error (DB failure, decryption failure): throws (propagated to caller)
   */
  private async resolveViaAuthProfile(
    authProfileId: string,
    tenantId: string,
  ): Promise<ResolvedCredential | null> {
    const profile = await resolveAuthProfileCredentials(authProfileId, tenantId);

    if (!profile) {
      return null;
    }

    const secretCandidate = profile.secrets.apiKey ?? profile.secrets.accessToken;
    const apiKey = typeof secretCandidate === 'string' ? secretCandidate : '';
    if (!apiKey) {
      log.warn('Auth profile has no API key or access token', { authProfileId, tenantId });
      return null;
    }

    return {
      apiKey,
      endpoint: typeof profile.config.endpoint === 'string' ? profile.config.endpoint : undefined,
      authType: profile.authType,
      authConfig: profile.config,
    };
  }

  private async safeFetchTenantPolicy(tenantId: string): Promise<TenantLLMPolicyRow | null> {
    if (!this.dbAvailable) return null;
    const cachedPolicy = this.getCachedTenantPolicy(tenantId);
    if (cachedPolicy !== undefined) {
      return cachedPolicy;
    }

    try {
      const policy = (await findTenantLLMPolicy(tenantId)) as TenantLLMPolicyRow | null;
      this.setCachedTenantPolicy(tenantId, policy);
      return policy;
    } catch (err) {
      log.warn('Failed to fetch tenant LLM policy', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
      });
      return null;
    }
  }

  private async safeFetchProjectEnableThinking(
    projectId: string,
    settingsVersionId?: string,
    tenantId?: string,
  ): Promise<
    | {
        enableThinking?: boolean;
        thinkingBudget?: number | null;
        thoughtDescription?: string | null;
        compactionThreshold?: number | null;
      }
    | undefined
  > {
    if (!this.dbAvailable) return undefined;
    try {
      return await findProjectEnableThinking(projectId, settingsVersionId, tenantId);
    } catch (err) {
      log.warn('Failed to fetch project enableThinking', {
        error: err instanceof Error ? err.message : String(err),
        projectId,
      });
      return undefined;
    }
  }

  private async safeFetchProjectTierOverrides(
    tenantId: string,
    projectId: string,
  ): Promise<Record<string, string> | Map<string, string> | null> {
    if (!this.dbAvailable) return null;
    try {
      return await findProjectOperationTierOverrides(tenantId, projectId);
    } catch (err) {
      log.warn('Failed to fetch project tier overrides', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        projectId,
      });
      return null;
    }
  }

  private operationToTier(
    op: OperationType,
    projectOverrides?: Record<string, string> | Map<string, string> | null,
  ): string {
    // Check project-level overrides
    if (projectOverrides) {
      const value =
        projectOverrides instanceof Map ? projectOverrides.get(op) : projectOverrides[op];
      if (value && isModelRoutingTier(value) && isOperationTierCompatible(op, value)) return value;
      if (value) {
        log.warn('Ignoring invalid project operation tier override', {
          operationType: op,
          tier: value,
        });
      }
    }

    return getDefaultOperationTier(op);
  }

  private hasExplicitOperationTierOverride(
    op: OperationType,
    projectOverrides?: Record<string, string> | Map<string, string> | null,
  ): boolean {
    if (!projectOverrides) return false;
    const value = projectOverrides instanceof Map ? projectOverrides.get(op) : projectOverrides[op];
    return (
      typeof value === 'string' && isModelRoutingTier(value) && isOperationTierCompatible(op, value)
    );
  }

  private shouldUseProjectTierLookup(
    op: OperationType,
    projectOverrides?: Record<string, string> | Map<string, string> | null,
  ): boolean {
    const value =
      projectOverrides instanceof Map ? projectOverrides.get(op) : projectOverrides?.[op];
    if (value != null) {
      return this.hasExplicitOperationTierOverride(op, projectOverrides);
    }

    return getDefaultOperationTier(op) === 'balanced';
  }

  private enforceProviderAllowlist(
    tenantPolicy: TenantLLMPolicyRow,
    provider: string,
    modelId: string,
  ): void {
    const allowed = tenantPolicy.allowedProviders;
    if (!Array.isArray(allowed) || allowed.length === 0) return;

    if (!isLlmProviderAllowed(allowed, provider)) {
      throw new AppError(
        `Provider '${provider}' (model: ${modelId}) is not allowed for this tenant. ` +
          `Allowed providers: ${allowed.join(', ')}`,
        { ...ErrorCodes.FORBIDDEN },
      );
    }
  }

  /**
   * Enforce daily/monthly token budgets from the tenant's LLM policy.
   * Uses Redis-backed counters with in-memory fallback for cross-pod accuracy.
   * Feature-flagged via enableLlmBudgetEnforcement. Fail-open if unavailable.
   */
  private async enforceBudget(
    tenantPolicy: TenantLLMPolicyRow,
    tenantId: string | undefined,
  ): Promise<BudgetReservation | undefined> {
    if (!tenantId) return undefined;

    try {
      if (!isConfigLoaded() || !getConfig().features.enableLlmBudgetEnforcement) {
        return undefined;
      }
    } catch (configErr) {
      log.debug('Config not loaded, skipping budget enforcement', {
        error: configErr instanceof Error ? configErr.message : String(configErr),
      });
      return undefined;
    }

    const dailyBudget = tenantPolicy.dailyTokenBudget ?? 0;
    const monthlyBudget = tenantPolicy.monthlyTokenBudget ?? 0;

    const result = await checkAndRecordBudget(
      tenantId,
      ESTIMATED_TOKENS_PER_CALL,
      dailyBudget,
      monthlyBudget,
    );

    if (!result.allowed) {
      throw new AppError(result.reason || 'Token budget exceeded', {
        ...ErrorCodes.TOO_MANY_REQUESTS,
      });
    }

    return result.reservation;
  }

  /**
   * Resolve credential based on tenant's credential policy.
   * Used for Levels 1-2 where the model comes from DSL/agent config without a TenantModel.
   *
   * Resolution order:
   * 1. LLMCredential lookup per credential policy (user_only, org_first, etc.)
   * 2. TenantModel-by-provider fallback — if the tenant has a TenantModel for
   *    this provider with an active connection, use that connection's credential.
   *    This handles the common case where the model ID came from a project's
   *    ModelConfig (Level 3) but the TenantModel resolution failed earlier
   *    (e.g. no primary connection, decryption error).
   */
  private async resolveCredential(
    context: ResolutionContext,
    provider: string,
    tenantPolicy: TenantLLMPolicyRow | null,
  ): Promise<ResolvedCredential> {
    const policy = tenantPolicy?.credentialPolicy || 'user_only';
    const diagnostics: string[] = [];

    diagnostics.push(
      `policy=${policy}, db=${this.dbAvailable}, tenantEncryption=${this.isTenantEncryptionReady()}`,
    );

    if (this.dbAvailable && this.isTenantEncryptionReady()) {
      const tryUser = policy === 'user_first' || policy === 'user_only';
      const tryOrg = policy === 'org_first' || policy === 'org_only';
      const tryUserFallback = policy === 'org_first';
      const tryOrgFallback = policy === 'user_first';

      // First attempt
      if (tryUser && context.userId) {
        const cred = await this.findUserCredential(context.userId, provider);
        if (cred) return cred;
        diagnostics.push(`user_cred(${context.userId})=null`);
      } else if (tryOrg && context.tenantId) {
        const cred = await this.findTenantCredential(context.tenantId, provider);
        if (cred) return cred;
        diagnostics.push(`tenant_cred(${context.tenantId},${provider})=null`);
      }

      // Fallback attempt
      if (tryOrgFallback && context.tenantId) {
        const cred = await this.findTenantCredential(context.tenantId, provider);
        if (cred) return cred;
        diagnostics.push(`tenant_cred_fallback=null`);
      } else if (tryUserFallback && context.userId) {
        const cred = await this.findUserCredential(context.userId, provider);
        if (cred) return cred;
        diagnostics.push(`user_cred_fallback=null`);
      }

      // Last-resort: look for a TenantModel with an active connection for this provider.
      // This covers the case where the model came from project config (Level 3) or
      // agent IR (Level 1) but no standalone LLMCredential exists — the credential
      // is only reachable through the TenantModel's connection.
      if (context.tenantId) {
        const tm = await findTenantModelByProvider(context.tenantId, provider);
        if (tm) {
          diagnostics.push(
            `tm_by_provider=${tm.id || tm._id}, conns=${tm.connections?.length ?? 0}`,
          );
          const resolution = await this.buildTenantModelResolution(tm);
          if (resolution?.credential) {
            log.debug('Resolved credential via TenantModel-by-provider fallback', {
              tenantId: context.tenantId,
              provider,
              tenantModelId: tm.id || tm._id,
            });
            return resolution.credential;
          }
          diagnostics.push(`tm_resolution=null`);
        } else {
          diagnostics.push(`tm_by_provider(${context.tenantId},${provider})=not_found`);
        }
      }
    }

    log.error('Credential resolution failed — all paths exhausted', {
      provider,
      tenantId: context.tenantId,
      userId: context.userId,
      diagnostics: diagnostics.join('; '),
    });

    // Diagnostics are logged above — keep the client-facing message clean
    // to avoid leaking internal state (policy names, user IDs, model IDs).
    throw new AppError(
      `No credential found for provider '${provider}'. ` +
        `Configure a TenantModel with a connection or add an LLMCredential.`,
      { ...ErrorCodes.SERVICE_UNAVAILABLE },
    );
  }

  private async findUserCredential(
    userId: string,
    provider: string,
  ): Promise<ResolvedCredential | null> {
    if (!this.dbAvailable || !this.isTenantEncryptionReady()) return null;

    try {
      const cred = await findDefaultUserCredential(userId, provider);

      if (!cred) return null;
      if (!cred.tenantId) {
        log.warn('User credential missing tenantId for decryption', {
          userId,
          provider,
          credentialId: cred._id,
        });
        return null;
      }

      return await resolveStoredCredential(
        cred,
        cred.tenantId,
        'User credential unavailable after decryption',
        {
          userId,
          provider,
          credentialId: cred._id,
          decryptionFailed: Boolean(cred._decryptionFailed),
        },
      );
    } catch (err) {
      log.warn('User credential resolution failed', {
        error: err instanceof Error ? err.message : String(err),
        userId,
        provider,
      });
      return null;
    }
  }

  private async findTenantCredential(
    tenantId: string,
    provider: string,
  ): Promise<ResolvedCredential | null> {
    if (!this.dbAvailable || !this.isTenantEncryptionReady()) return null;

    try {
      const cred = await findDefaultTenantCredential(tenantId, provider);

      if (!cred) return null;

      return await resolveStoredCredential(
        cred,
        tenantId,
        'Tenant credential unavailable after decryption',
        {
          tenantId,
          provider,
          credentialId: cred._id,
          decryptionFailed: Boolean(cred._decryptionFailed),
        },
      );
    } catch (err) {
      log.warn('Tenant credential resolution failed', {
        error: err instanceof Error ? err.message : String(err),
        tenantId,
        provider,
      });
      return null;
    }
  }
}

// =============================================================================
// INTERNAL TYPE
// =============================================================================

interface TenantModelResolution {
  /** The TenantModel._id — needed for cache rehydration by exact ID */
  tenantModelId: string;
  modelId: string;
  /** Provider from the TenantModel DB record (authoritative — not inferred from model ID) */
  provider: string;
  credential: ResolvedCredential;
  temperature?: number;
  maxTokens?: number;
  parameters?: Partial<ResolvedModelParameters>;
  capabilities?: ResolvedModelCapabilities;
  customEndpoint?: string;
  apiIntegration?: {
    providerStructure: string;
    requestTemplate?: string;
    responseMapping?: string;
    customHeaders?: Record<string, string>;
  };
  realtimeConfig?: RealtimeModelConfig;
  /** OpenAI only: override for Responses API vs Chat Completions */
  useResponsesApi?: boolean;
  /** Override for streaming vs non-streaming LLM calls */
  useStreaming?: boolean;
}
