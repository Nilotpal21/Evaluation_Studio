/**
 * Organization Profile Generator Service
 *
 * Generates organization profiles from multiple input sources using LLMs.
 * Part of RFC-001 Phase 2: LLM-Assisted Org Profile Generation.
 *
 * **Usage:**
 * ```typescript
 * const generator = new OrgProfileGenerator({ tenantId, apiKey });
 * const profile = await generator.generateFromURL('https://vanguard.com/about');
 * ```
 *
 * **Features:**
 * - SSRF-protected URL fetching
 * - Zod validation for LLM outputs
 * - Circuit breaker for error handling
 * - Fallback to manual flow on persistent failures
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import { validateAndFetchURL } from '../utils/ssrf-protection.js';
import {
  validateOrgProfile,
  safeValidateOrgProfile,
  type OrgProfile,
} from '../schemas/org-profile.schema.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('org-profile-generator');

/**
 * Configuration for OrgProfileGenerator
 */
export interface OrgProfileGeneratorConfig {
  tenantId: string;
  provider: string; // LLM provider: 'anthropic', 'openai', 'gemini', 'azure'
  apiKey: string; // Provider API key (from Model Library)
  model: string; // Model ID (resolved from Model Library tier)
  /** Azure endpoint URL or custom base URL (e.g., https://myresource.openai.azure.com) */
  endpointUrl?: string | null;
  maxRetries?: number; // Default: 2
  circuitBreakerThreshold?: number; // Default: 0.5 (50% error rate)
  circuitBreakerResetTimeout?: number; // Default: 30000ms (30s)
}

/**
 * Circuit breaker state
 */
enum CircuitState {
  CLOSED = 'CLOSED', // Normal operation
  OPEN = 'OPEN', // Blocking requests
  HALF_OPEN = 'HALF_OPEN', // Testing if service recovered
}

/**
 * Circuit breaker for LLM API calls
 */
class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  private readonly threshold: number;
  private readonly resetTimeout: number;

  constructor(threshold = 0.5, resetTimeout = 30000) {
    this.threshold = threshold;
    this.resetTimeout = resetTimeout;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (this.lastFailureTime && now - this.lastFailureTime >= this.resetTimeout) {
        logger.info('Circuit breaker entering HALF_OPEN state');
        this.state = CircuitState.HALF_OPEN;
        this.failureCount = 0;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN. Service temporarily unavailable.');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    if (this.state === CircuitState.HALF_OPEN) {
      logger.info('Circuit breaker closing after successful recovery');
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    const totalRequests = this.failureCount + this.successCount;
    const errorRate = this.failureCount / totalRequests;

    if (errorRate >= this.threshold && this.state === CircuitState.CLOSED) {
      logger.error(`Circuit breaker opening (error rate: ${errorRate.toFixed(2)})`);
      this.state = CircuitState.OPEN;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      logger.warn('Circuit breaker reopening after failed recovery attempt');
      this.state = CircuitState.OPEN;
    }
  }

  public getState(): CircuitState {
    return this.state;
  }
}

/**
 * Organization Profile Generator Service
 *
 * Generates organization profiles from:
 * 1. Company website URL
 * 2. Organization name and industry
 * 3. Paragraph description
 *
 * Uses Claude Sonnet for high-quality generation with validation.
 */
export class OrgProfileGenerator {
  private readonly tenantId: string;
  private readonly llmClient: WorkerLLMClient;
  private readonly maxRetries: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(config: OrgProfileGeneratorConfig) {
    this.tenantId = config.tenantId;
    this.llmClient = new WorkerLLMClient(config.provider, config.apiKey, config.model, {
      baseUrl: config.endpointUrl || undefined,
    });
    this.maxRetries = config.maxRetries ?? 2;
    this.circuitBreaker = new CircuitBreaker(
      config.circuitBreakerThreshold ?? 0.5,
      config.circuitBreakerResetTimeout ?? 30000,
    );
  }

  /**
   * Generate organization profile from company website URL
   *
   * @param url - Company website URL (e.g., https://vanguard.com/about)
   * @returns Validated organization profile
   * @throws Error if URL is invalid, unreachable, or LLM generation fails
   */
  public async generateFromURL(url: string): Promise<OrgProfile> {
    logger.info('Generating org profile from URL', { tenantId: this.tenantId, url });

    try {
      // Step 1: Fetch URL content with SSRF protection
      const content = await validateAndFetchURL(url);
      logger.debug('Fetched URL content', {
        url,
        contentLength: content.length,
      });

      // Step 2: Extract organization profile via LLM
      const rawProfile = await this.circuitBreaker.execute(() =>
        this.extractProfileFromText(content, `website content from ${url}`),
      );

      logger.info('Generated org profile from URL', {
        tenantId: this.tenantId,
        url,
        organizationName: rawProfile.organizationName,
      });

      return rawProfile;
    } catch (error) {
      logger.error('Failed to generate org profile from URL', {
        tenantId: this.tenantId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate organization profile from name and industry
   *
   * @param name - Organization name (e.g., "Vanguard")
   * @param industry - Industry (e.g., "Financial Services")
   * @returns Validated organization profile
   * @throws Error if LLM generation fails
   */
  public async generateFromNameAndIndustry(name: string, industry: string): Promise<OrgProfile> {
    logger.info('Generating org profile from name and industry', {
      tenantId: this.tenantId,
      name,
      industry,
    });

    try {
      // Generate profile via LLM with name + industry context
      const rawProfile = await this.circuitBreaker.execute(() =>
        this.generateFromNameAndIndustryImpl(name, industry),
      );

      logger.info('Generated org profile from name and industry', {
        tenantId: this.tenantId,
        organizationName: rawProfile.organizationName,
      });

      return rawProfile;
    } catch (error) {
      logger.error('Failed to generate org profile from name and industry', {
        tenantId: this.tenantId,
        name,
        industry,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate organization profile from paragraph description
   *
   * @param description - Paragraph describing the organization
   * @returns Validated organization profile
   * @throws Error if LLM generation fails
   */
  public async generateFromParagraph(description: string): Promise<OrgProfile> {
    logger.info('Generating org profile from paragraph', {
      tenantId: this.tenantId,
      descriptionLength: description.length,
    });

    try {
      // Generate profile via LLM from paragraph
      const rawProfile = await this.circuitBreaker.execute(() =>
        this.extractProfileFromText(description, 'provided paragraph description'),
      );

      logger.info('Generated org profile from paragraph', {
        tenantId: this.tenantId,
        organizationName: rawProfile.organizationName,
      });

      return rawProfile;
    } catch (error) {
      logger.error('Failed to generate org profile from paragraph', {
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Extract organization profile from text content using LLM
   *
   * @param text - Source text (URL content or paragraph)
   * @param source - Human-readable source description (for prompt context)
   * @returns Validated organization profile
   */
  private async extractProfileFromText(text: string, source: string): Promise<OrgProfile> {
    // Truncate to ~100K chars (~25K tokens) to stay within context window.
    // The LLM only needs enough text to identify org name, industry, key terms.
    // Large websites (e.g., airline homepages) can be 200K+ chars raw HTML.
    const MAX_INPUT_CHARS = 100_000;
    const truncatedText =
      text.length > MAX_INPUT_CHARS
        ? text.slice(0, MAX_INPUT_CHARS) + '\n\n[Content truncated for analysis]'
        : text;

    const prompt = `You are an expert at analyzing organizations and extracting structured profiles.

**Task:** Analyze the following ${source} and generate a comprehensive organization profile.

**Input:**
${truncatedText}

**Required Output Format (JSON):**
{
  "organizationName": "Full organization name",
  "industry": "Primary industry",
  "keyTerms": ["term1", "term2", ...],  // 10-15 domain-specific terms
  "acronyms": {
    "TERM": "Expansion",  // 5-8 acronyms used by this org
    ...
  },
  "departmentBoundaries": [
    {
      "product1": "product-id-1",
      "product2": "product-id-2",
      "reasoning": "Why these products are often confused (10-500 chars)"
    },
    ...
  ],  // 2-3 boundaries
  "productSpecificNames": {
    "product-category": ["Org-specific name 1", "Org-specific name 2"],
    ...
  }
}

**Guidelines:**
- **organizationName:** Official name (max 200 chars)
- **industry:** Primary industry (max 100 chars)
- **keyTerms:** 10-15 terms specific to this org/industry (max 50 chars each)
- **acronyms:** 5-8 acronyms used by this org (acronym max 10 chars, expansion max 100 chars)
- **departmentBoundaries:** 2-3 product pairs often confused by users (reasoning 10-500 chars)
- **productSpecificNames:** Organization-specific terminology for products (max 10 names per product, max 100 products)

**Respond ONLY with valid JSON. No markdown fences, no explanations.**`;

    const responseText = await this.llmClient.chat(
      'You are an expert at analyzing organizations and extracting structured profiles.',
      [{ role: 'user', content: prompt }],
      { maxTokens: 4096 },
    );

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM response does not contain valid JSON');
    }

    const rawProfile = JSON.parse(jsonMatch[0]);

    // Sanitize LLM output: drop malformed departmentBoundaries entries
    // rather than failing the entire profile. LLMs sometimes use variant
    // field names (e.g., "productA"/"productB" instead of "product1"/"product2").
    if (Array.isArray(rawProfile.departmentBoundaries)) {
      rawProfile.departmentBoundaries = rawProfile.departmentBoundaries.filter(
        (b: any) => typeof b?.product1 === 'string' && typeof b?.product2 === 'string',
      );
    }

    // Validate with Zod schema
    const validationResult = safeValidateOrgProfile(rawProfile);
    if (!validationResult.success) {
      logger.error('LLM generated invalid org profile', {
        errors: validationResult.error.issues,
      });
      throw new Error(
        `LLM generated invalid org profile: ${validationResult.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    return validationResult.data;
  }

  /**
   * Generate organization profile from name and industry (specialized prompt)
   */
  private async generateFromNameAndIndustryImpl(
    name: string,
    industry: string,
  ): Promise<OrgProfile> {
    const prompt = `You are an expert at analyzing organizations and generating comprehensive profiles.

**Task:** Generate a detailed organization profile for the following organization based on your knowledge.

**Input:**
- Organization Name: ${name}
- Industry: ${industry}

**Required Output Format (JSON):**
{
  "organizationName": "${name}",
  "industry": "${industry}",
  "keyTerms": ["term1", "term2", ...],  // 10-15 domain-specific terms
  "acronyms": {
    "TERM": "Expansion",  // 5-8 acronyms used by this org
    ...
  },
  "departmentBoundaries": [
    {
      "product1": "product-id-1",
      "product2": "product-id-2",
      "reasoning": "Why these products are often confused (10-500 chars)"
    },
    ...
  ],  // 2-3 boundaries
  "productSpecificNames": {
    "product-category": ["Org-specific name 1", "Org-specific name 2"],
    ...
  }
}

**Guidelines:**
- **keyTerms:** 10-15 terms specific to ${name} and ${industry} (max 50 chars each)
- **acronyms:** 5-8 acronyms commonly used by ${name} (acronym max 10 chars, expansion max 100 chars)
- **departmentBoundaries:** 2-3 product pairs often confused by users in ${industry} (reasoning 10-500 chars)
- **productSpecificNames:** Organization-specific terminology used by ${name} (max 10 names per product, max 100 products)

**Use your knowledge of ${name} to provide accurate, realistic information.**

**Respond ONLY with valid JSON. No markdown fences, no explanations.**`;

    const responseText = await this.llmClient.chat(
      'You are an expert at analyzing organizations and generating comprehensive profiles.',
      [{ role: 'user', content: prompt }],
      { maxTokens: 4096 },
    );

    // Extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM response does not contain valid JSON');
    }

    const rawProfile = JSON.parse(jsonMatch[0]);

    // Sanitize: drop malformed departmentBoundaries entries
    if (Array.isArray(rawProfile.departmentBoundaries)) {
      rawProfile.departmentBoundaries = rawProfile.departmentBoundaries.filter(
        (b: any) => typeof b?.product1 === 'string' && typeof b?.product2 === 'string',
      );
    }

    // Validate with Zod schema
    const validationResult = safeValidateOrgProfile(rawProfile);
    if (!validationResult.success) {
      logger.error('LLM generated invalid org profile', {
        name,
        industry,
        errors: validationResult.error.issues,
      });
      throw new Error(
        `LLM generated invalid org profile: ${validationResult.error.issues.map((i) => i.message).join(', ')}`,
      );
    }

    return validationResult.data;
  }

  /**
   * Get circuit breaker status
   */
  public getCircuitBreakerState(): CircuitState {
    return this.circuitBreaker.getState();
  }
}

/**
 * Factory function to create OrgProfileGenerator with resolved credentials
 *
 * Uses 6-level LLM credential resolution hierarchy:
 * 1. SearchIndex.llmConfig.useCases.knowledgeGraph (per-index KG config)
 * 2. KnowledgeBase.llmConfig (knowledge base-level config)
 * 3. TenantLLMPolicy (tenant-level budgets and rate limits)
 * 4. TenantModel → LLMCredential (tenant model credentials)
 * 5. Standalone LLMCredential (tenant credentials)
 * 6. Environment variables (dev/test fallback)
 *
 * @param tenantId - Tenant ID
 * @param indexId - Search index ID (for credential resolution)
 * @returns OrgProfileGenerator instance or null if no credentials available
 */
export async function createOrgProfileGenerator(
  tenantId: string,
  indexId: string,
): Promise<OrgProfileGenerator | null> {
  // Import resolver dynamically to avoid circular dependencies
  const { resolveEnhancedIndexLLMConfig } = await import('../services/llm-config/resolver.js');

  try {
    // Resolve LLM configuration using 6-level hierarchy
    const llmConfig = await resolveEnhancedIndexLLMConfig(tenantId, indexId);

    // Extract Knowledge Graph use case configuration
    const kgConfig = llmConfig.useCases.knowledgeGraph;

    // Check if Knowledge Graph LLM is configured and usable
    if (!kgConfig.enabled) {
      logger.info('Knowledge Graph LLM not enabled for this index', {
        tenantId,
        indexId,
      });
      return null;
    }

    // Check if feature is usable (status: 'active' or 'fallback')
    const isUsable = kgConfig.status === 'active' || kgConfig.status === 'fallback';
    if (!isUsable) {
      logger.warn('Knowledge Graph LLM not usable', {
        tenantId,
        indexId,
        status: kgConfig.status,
        resolution: kgConfig.resolution,
      });
      return null;
    }

    // Extract credentials and model info
    if (!kgConfig.provider || !kgConfig.apiKey || !kgConfig.model?.modelId) {
      logger.warn('Knowledge Graph LLM configuration incomplete', {
        tenantId,
        indexId,
        hasProvider: !!kgConfig.provider,
        hasApiKey: !!kgConfig.apiKey,
        hasModel: !!kgConfig.model?.modelId,
      });
      return null;
    }

    logger.info('Creating OrgProfileGenerator with resolved credentials', {
      tenantId,
      indexId,
      provider: kgConfig.provider,
      model: kgConfig.model.modelId,
      resolution: kgConfig.resolution,
    });

    return new OrgProfileGenerator({
      tenantId,
      provider: kgConfig.provider,
      apiKey: kgConfig.apiKey,
      model: kgConfig.model.modelId,
      endpointUrl: kgConfig.endpointUrl,
      maxRetries: 2,
    });
  } catch (error) {
    logger.error('Failed to resolve LLM credentials for org profile generation', {
      tenantId,
      indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
