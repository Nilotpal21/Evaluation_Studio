/**
 * Model Catalog Service
 *
 * Hybrid model catalog combining:
 * 1. Built-in curated models (valid provider model IDs with date suffixes)
 * 2. LiteLLM model data (bundled JSON with pricing/capabilities)
 * 3. Gateway discovery (per-tenant LiteLLM proxy /model/info)
 *
 * Provides a unified view of available models for tenant model configuration.
 */

import { createLogger } from '@abl/compiler/platform';
import { getBuiltInCatalog } from '@abl/compiler/platform/llm/model-registry.js';
import { areLlmProvidersPolicyEquivalent } from '@agent-platform/shared-kernel/llm-provider-identity';

const log = createLogger('model-catalog');

// =============================================================================
// TYPES
// =============================================================================

export interface CatalogModel {
  modelId: string;
  provider: string;
  displayName: string;
  source: 'litellm_data' | 'platform' | 'gateway';
  capabilities: {
    supportsTools: boolean;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsRealtimeVoice?: boolean;
    contextWindow: number;
  };
  pricing?: {
    inputCostPer1k: number;
    outputCostPer1k: number;
  };
}

/** Shape of entries in the LiteLLM model_prices_and_context_window.json */
interface LiteLLMModelEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_streaming?: boolean;
  source?: string;
}

// =============================================================================
// SSRF PROTECTION
// =============================================================================

/**
 * Validate a gateway URL to prevent SSRF attacks.
 * Blocks internal/private IP ranges, non-HTTPS, and suspicious hosts.
 */
function isAllowedGatewayUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);

    // Must be HTTPS in production
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost / loopback
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
      return false;

    // Block metadata endpoints (AWS, GCP, Azure)
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return false;

    // Block private IP ranges (RFC 1918 + link-local)
    if (/^10\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false;
    if (/^0\./.test(hostname)) return false;

    // Block common internal hostnames
    if (
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localhost')
    )
      return false;

    return true;
  } catch {
    return false;
  }
}

export { isAllowedGatewayUrl as _isAllowedGatewayUrl }; // Exported for testing

// Built-in model data is now derived from the single model registry.
// See packages/compiler/src/platform/llm/model-registry.ts

// =============================================================================
// SERVICE
// =============================================================================

export class ModelCatalogService {
  private catalog: Map<string, CatalogModel> = new Map();
  private litellmData: Record<string, LiteLLMModelEntry> | null = null;
  private lastRefresh: number = 0;
  private static CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.initCatalog();
  }

  /**
   * Initialize catalog from the single model registry.
   * All 147 models are available as built-in catalog entries.
   */
  private initCatalog(): void {
    for (const model of getBuiltInCatalog()) {
      this.catalog.set(model.modelId, { ...model, source: 'platform' });
    }
    this.lastRefresh = Date.now();
  }

  /**
   * List all available models, optionally filtered by provider.
   */
  listModels(filter?: { provider?: string }): CatalogModel[] {
    let models = Array.from(this.catalog.values());

    if (filter?.provider) {
      models = models.filter((m) => areLlmProvidersPolicyEquivalent(filter.provider!, m.provider));
    }

    return models.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Get a specific model's details from the catalog.
   */
  getModel(modelId: string): CatalogModel | undefined {
    return this.catalog.get(modelId);
  }

  /**
   * Load LiteLLM model data from a bundled JSON file.
   * Merges into the catalog, with platform overrides taking precedence.
   */
  loadLiteLLMData(data: Record<string, LiteLLMModelEntry>): void {
    this.litellmData = data;
    let added = 0;

    for (const [modelId, entry] of Object.entries(data)) {
      // Skip sample_spec and non-model entries
      if (modelId === 'sample_spec' || !entry.litellm_provider) continue;
      // Skip non-chat models
      if (entry.mode && entry.mode !== 'chat' && entry.mode !== 'completion') continue;

      // Don't overwrite platform overrides
      if (this.catalog.has(modelId)) continue;

      const provider = entry.litellm_provider;
      const displayName = modelId
        .replace(/\//g, ' ')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());

      this.catalog.set(modelId, {
        modelId,
        provider,
        displayName,
        source: 'litellm_data',
        capabilities: {
          supportsTools: entry.supports_function_calling ?? false,
          supportsVision: entry.supports_vision ?? false,
          supportsStreaming: entry.supports_streaming ?? true,
          contextWindow: entry.max_input_tokens || entry.max_tokens || 4096,
        },
        pricing:
          entry.input_cost_per_token != null && entry.output_cost_per_token != null
            ? {
                inputCostPer1k: entry.input_cost_per_token * 1000,
                outputCostPer1k: entry.output_cost_per_token * 1000,
              }
            : undefined,
      });
      added++;
    }

    log.info('LiteLLM data loaded', { totalEntries: Object.keys(data).length, modelsAdded: added });
    this.lastRefresh = Date.now();
  }

  /**
   * Query a LiteLLM gateway's /model/info endpoint to discover available models.
   * Used for enterprise tenants with their own LiteLLM proxy.
   *
   * SECURITY: The gatewayUrl is validated to prevent SSRF attacks.
   */
  async listGatewayModels(gatewayUrl: string): Promise<CatalogModel[]> {
    // Validate URL to prevent SSRF
    if (!isAllowedGatewayUrl(gatewayUrl)) {
      log.warn('Gateway URL rejected by SSRF validation', { gatewayUrl });
      return [];
    }

    try {
      const url = `${gatewayUrl.replace(/\/$/, '')}/model/info`;
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        log.warn('Gateway model info request failed', { url, status: response.status });
        return [];
      }

      const data = (await response.json()) as {
        data?: Array<{ model_name?: string; model_info?: Record<string, unknown> }>;
      };
      if (!data.data || !Array.isArray(data.data)) return [];

      return data.data
        .filter((m: any) => m.model_name)
        .map((m: any) => ({
          modelId: m.model_name,
          provider: m.model_info?.litellm_provider || 'gateway',
          displayName: m.model_name
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c: string) => c.toUpperCase()),
          source: 'gateway' as const,
          capabilities: {
            supportsTools: m.model_info?.supports_function_calling ?? true,
            supportsVision: m.model_info?.supports_vision ?? false,
            supportsStreaming: true,
            contextWindow: m.model_info?.max_input_tokens || m.model_info?.max_tokens || 128000,
          },
          pricing:
            m.model_info?.input_cost_per_token != null
              ? {
                  inputCostPer1k: (m.model_info.input_cost_per_token as number) * 1000,
                  outputCostPer1k: (m.model_info.output_cost_per_token as number) * 1000,
                }
              : undefined,
        }));
    } catch (err) {
      log.warn('Gateway discovery failed', {
        gatewayUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Refresh catalog from LiteLLM remote data.
   */
  async refreshCatalog(): Promise<void> {
    try {
      const url =
        'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

      if (!response.ok) {
        log.warn('Failed to fetch LiteLLM model data', { status: response.status });
        return;
      }

      const data = (await response.json()) as Record<string, LiteLLMModelEntry>;
      this.loadLiteLLMData(data);
    } catch (err) {
      log.warn('LiteLLM catalog refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Check if catalog needs refreshing.
   */
  needsRefresh(): boolean {
    return Date.now() - this.lastRefresh > ModelCatalogService.CACHE_TTL_MS;
  }
}

// Singleton
let catalogInstance: ModelCatalogService | null = null;

export function getModelCatalog(): ModelCatalogService {
  if (!catalogInstance) {
    catalogInstance = new ModelCatalogService();
  }
  return catalogInstance;
}
