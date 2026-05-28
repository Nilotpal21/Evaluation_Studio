/**
 * LLM Configuration Types
 *
 * Enhanced types for LLM feature resolution with status tracking,
 * resolution metadata, and actionable guidance for UI.
 */

// ─── Feature Status ──────────────────────────────────────────────────────────

/**
 * Runtime status of an LLM feature
 */
export type FeatureStatus =
  | 'active' // Feature enabled + model configured + credential valid
  | 'pending' // Feature enabled + no model or credential configured yet
  | 'disabled' // Feature explicitly disabled by user
  | 'fallback' // Using different tier than requested (graceful degradation)
  | 'degraded'; // Feature active but experiencing failures

// ─── Resolution Metadata ─────────────────────────────────────────────────────

/**
 * Explanation of why a particular model was selected (or why resolution failed)
 */
export interface FeatureResolution {
  /** Why this model was selected */
  reason:
    | 'default_tier' // Requested tier found and used
    | 'user_override' // User explicitly configured this model
    | 'fallback' // Requested tier unavailable, using fallback
    | 'no_model_available' // No model configured for any tier
    | 'no_credential' // Model exists but no credential linked
    | 'invalid_credential' // Credential exists but is invalid/expired
    | 'user_disabled'; // Feature explicitly disabled by user

  /** Tier that was requested (may differ from actual if fallback) */
  attemptedTier: string;

  /** Fallback tiers that were tried (if reason = 'fallback') */
  fallbackChain?: string[];

  /** Human-readable explanation for UI display */
  message: string;
}

// ─── Action Required ─────────────────────────────────────────────────────────

/**
 * Actionable guidance for user when feature is in pending state
 */
export interface ActionRequired {
  /** Type of action needed */
  action: 'configure_model' | 'add_credential' | 'enable_feature';

  /** Explanation of what needs to be done */
  message: string;

  /** Button text for CTA */
  ctaText: string;

  /** Link to page where user can take action */
  ctaLink: string;
}

// ─── Model Information ───────────────────────────────────────────────────────

/**
 * Information about the resolved model
 */
export interface ResolvedModelInfo {
  /** LiteLLM-format model ID (e.g., "gpt-4o", "claude-sonnet-4-20250514") */
  modelId: string;

  /** Provider name (e.g., "openai", "anthropic") */
  provider: string;

  /** Tier assignment (fast/balanced/powerful) */
  tier: 'fast' | 'balanced' | 'powerful';

  /** Display name for UI (e.g., "GPT-4o", "Claude Sonnet 4") */
  displayName: string;
}

// ─── Cost Estimate ───────────────────────────────────────────────────────────

/**
 * Cost estimate for this feature
 */
export interface CostEstimate {
  /** Estimated cost per document processed */
  perDocument: number;

  /** Estimated monthly cost (assuming typical usage) */
  perMonth: number;

  /** Currency (always USD for now) */
  currency: 'USD';
}

// ─── Enhanced Use Case Config ────────────────────────────────────────────────

/**
 * Extended version of ResolvedUseCaseConfig with status tracking and metadata
 */
export interface EnhancedResolvedUseCaseConfig {
  /** Use case identifier */
  useCase: string;

  /** Runtime status */
  status: FeatureStatus;

  /** Whether feature is enabled (user toggle) */
  enabled: boolean;

  /** Model tier (fast/balanced/powerful) */
  modelTier: 'fast' | 'balanced' | 'powerful';

  /** Resolved model information (only present if status is active/fallback) */
  model?: ResolvedModelInfo;

  /** Provider name (for LLM client creation) */
  provider?: string;

  /** Decrypted API key (for LLM client creation) */
  apiKey?: string;

  /** Resolution metadata (always present) */
  resolution: FeatureResolution;

  /** Action required for user (only present if status is pending) */
  actionRequired?: ActionRequired;

  /** Cost estimate (only present if status is active/fallback) */
  estimatedCost?: CostEstimate;

  /** Use-case specific parameters (merged from defaults + index overrides) */
  [key: string]: any;
}

// ─── Enhanced Index Config ───────────────────────────────────────────────────

/**
 * Complete resolved LLM configuration for an index with enhanced metadata
 */
export interface EnhancedResolvedIndexLLMConfig {
  /** Tenant ID */
  tenantId: string;

  /** Index ID */
  indexId: string;

  /** Global LLM features toggle */
  enabled: boolean;

  /** Embedding configuration */
  embeddingModel: string;
  embeddingDimensions: number;

  /** Resolved use cases with enhanced metadata */
  useCases: Record<string, EnhancedResolvedUseCaseConfig>;

  /** Tenant-level policy (budgets, rate limits) */
  policy?: {
    monthlyTokenBudget: number;
    dailyTokenBudget: number;
    maxRequestsPerMinute: number;
    allowedProviders: string[];
  };

  /** Resolution error (if config resolution failed completely) */
  error?: string;
}

// ─── Resolved Tenant Model ───────────────────────────────────────────────────

/**
 * Result of resolving a tenant model by tier
 */
export interface ResolvedTenantModel {
  modelId: string;
  provider: string;
  displayName: string;
  tier: 'fast' | 'balanced' | 'powerful';
  apiKey: string; // Decrypted
  /** Azure endpoint URL or custom base URL (e.g., https://myresource.openai.azure.com) */
  endpointUrl?: string | null;
  temperature?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
}
