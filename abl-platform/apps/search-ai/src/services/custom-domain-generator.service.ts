/**
 * Custom Domain Generator Service
 *
 * Generates custom Knowledge Graph domain definitions from organization profiles using LLMs.
 * Part of RFC-001 Phase 3: Domain Auto-Generation.
 *
 * **Usage:**
 * ```typescript
 * const generator = new CustomDomainGenerator({ tenantId, apiKey });
 * const domain = await generator.generateFromOrgProfile(orgProfile);
 * ```
 *
 * **Features:**
 * - LLM-powered domain generation from org profile
 * - Intelligent product/category extraction from key terms
 * - Attribute generation with extraction patterns
 * - Department boundary mapping
 * - Zod validation for LLM outputs
 * - Circuit breaker for error handling
 */

import { WorkerLLMClient } from '@agent-platform/llm';
import {
  DomainDefinitionSchema,
  type DomainDefinition,
} from '../schemas/domain-definition.schema.js';
import type { OrgProfile } from '../schemas/org-profile.schema.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('custom-domain-generator');

/**
 * Configuration for CustomDomainGenerator
 */
export interface CustomDomainGeneratorConfig {
  tenantId: string;
  provider: string; // LLM provider: 'anthropic', 'openai', 'gemini'
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
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
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
 * Custom Domain Generator
 *
 * Generates complete KG domain definitions from organization profiles using Claude.
 */
export class CustomDomainGenerator {
  private readonly config: Required<Omit<CustomDomainGeneratorConfig, 'endpointUrl'>> &
    Pick<CustomDomainGeneratorConfig, 'endpointUrl'>;
  private readonly llmClient: WorkerLLMClient;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(config: CustomDomainGeneratorConfig) {
    this.config = {
      maxRetries: 2,
      circuitBreakerThreshold: 0.5,
      circuitBreakerResetTimeout: 30000,
      ...config,
    };

    this.llmClient = new WorkerLLMClient(config.provider, config.apiKey, config.model, {
      baseUrl: config.endpointUrl || undefined,
    });
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetTimeout,
    );
  }

  /**
   * Generate custom domain from organization profile
   */
  public async generateFromOrgProfile(orgProfile: OrgProfile): Promise<DomainDefinition> {
    logger.info('Generating custom domain from org profile', {
      organizationName: orgProfile.organizationName,
      industry: orgProfile.industry,
      keyTermsCount: orgProfile.keyTerms.length,
    });

    const prompt = this.buildDomainGenerationPrompt(orgProfile);
    const responseText = await this.callLLM(prompt);
    const domain = this.parseAndValidateDomain(responseText, orgProfile);

    logger.info('Custom domain generated successfully', {
      domainName: domain.name,
      categoriesCount: domain.categories.length,
      productsCount: domain.products.length,
      attributesCount: domain.attributes.length,
    });

    return domain;
  }

  /**
   * Build LLM prompt for domain generation
   */
  private buildDomainGenerationPrompt(orgProfile: OrgProfile): string {
    const keyTermsList = orgProfile.keyTerms.join(', ');
    const acronymsList = Object.entries(orgProfile.acronyms)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    const departmentBoundariesList = orgProfile.departmentBoundaries
      .map((b) => `${b.product1} vs ${b.product2}: ${b.reasoning}`)
      .join('\n');
    const productSpecificNames = JSON.stringify(orgProfile.productSpecificNames, null, 2);

    return `You are a Knowledge Graph domain architect. Generate a complete, production-ready domain definition for ${orgProfile.organizationName} in the ${orgProfile.industry} industry.

**Organization Profile:**
- Name: ${orgProfile.organizationName}
- Industry: ${orgProfile.industry}
- Key Terms: ${keyTermsList}
- Acronyms: ${acronymsList}
- Department Boundaries:
${departmentBoundariesList}
- Product-Specific Names: ${productSpecificNames}

**Task:** Generate a domain definition with:

1. **Domain Metadata:**
   - name: Descriptive kebab-case name (e.g., "b2b-saas-hr-compliance")
   - version: "1.0.0"
   - industry: ${orgProfile.industry}

2. **Categories (5-10):**
   Group key terms into logical product categories. Each category has:
   - id: kebab-case (e.g., "employee-benefits")
   - name: Human-readable (e.g., "Employee Benefits")
   - department: Department name (e.g., "Human Resources")

3. **Products (15-30):**
   Extract products from key terms. Each product has:
   - id: kebab-case derived from key term
   - name: Human-readable name
   - categoryId: Reference to category
   - department: Department name
   - subDepartment: More specific department
   - disambiguationKeywords: 3-7 keywords from key terms
   - organizationSpecificNames: Use productSpecificNames when available

4. **Attributes (20-50):**
   Create extractable attributes from acronyms and domain knowledge. Each attribute has:
   - id: kebab-case (e.g., "interest-rate")
   - name: Human-readable (e.g., "Interest Rate")
   - dataType: One of: percentage, currency, date, duration, identifier, string, number
   - applicableTo: Array of product IDs (empty = all products)
   - extraction: { method: "regex" | "llm" | "hybrid", patterns: [...], keywords: [...] }
   - Use acronyms to inform attribute creation

5. **Department Boundaries (2-10):**
   Map the provided department boundaries to product pairs:
${orgProfile.departmentBoundaries.map((b) => `   - product1: ${b.product1} → product2: ${b.product2}`).join('\n')}

**Output Format:**
Return ONLY a valid JSON object matching this schema (no markdown, no explanation):

\`\`\`json
{
  "name": "domain-name-kebab-case",
  "version": "1.0.0",
  "industry": "${orgProfile.industry}",
  "categories": [
    {
      "id": "category-id",
      "name": "Category Name",
      "department": "Department"
    }
  ],
  "products": [
    {
      "id": "product-id",
      "name": "Product Name",
      "categoryId": "category-id",
      "department": "Department",
      "subDepartment": "Sub-Department",
      "disambiguationKeywords": ["keyword1", "keyword2"],
      "organizationSpecificNames": ["Org-Specific Name"]
    }
  ],
  "attributes": [
    {
      "id": "attribute-id",
      "name": "Attribute Name",
      "dataType": "percentage",
      "applicableTo": ["product-id"],
      "extraction": {
        "method": "regex",
        "patterns": ["\\\\d+%", "rate of \\\\d+%"],
        "keywords": ["rate", "percentage"]
      }
    }
  ],
  "departmentBoundaries": [
    {
      "product1": "product-id-1",
      "product2": "product-id-2",
      "reasoning": "Explanation of why these products are confusable"
    }
  ]
}
\`\`\`

**Guidelines:**
- Use kebab-case for all IDs
- Ensure categoryId references exist in categories array
- Create realistic extraction patterns (valid regex)
- Use organization-specific knowledge from key terms
- Department boundaries should reflect actual product confusion
- Attributes should be extractable from documents
- Aim for 20-30 products, 30-50 attributes for production quality
`;
  }

  /**
   * Call LLM for domain generation (provider-agnostic via WorkerLLMClient)
   */
  private async callLLM(prompt: string): Promise<string> {
    return this.circuitBreaker.execute(async () => {
      const response = await this.llmClient.chat(
        'You are a Knowledge Graph domain architect. Generate production-ready domain definitions.',
        [{ role: 'user', content: prompt }],
        { maxTokens: 8192 },
      );

      return response;
    });
  }

  /**
   * Parse and validate domain definition from LLM response
   */
  private parseAndValidateDomain(responseText: string, orgProfile: OrgProfile): DomainDefinition {
    // Extract JSON from response (may be wrapped in markdown code block)
    let jsonStr = responseText.trim();

    // Remove markdown code block if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*\n/, '').replace(/\n```\s*$/, '');
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
    }

    // Parse JSON
    let data: any;
    try {
      data = JSON.parse(jsonStr);
    } catch (error) {
      logger.error('Failed to parse LLM response as JSON', {
        responsePreview: responseText.substring(0, 200),
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `LLM generated invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Sanitize LLM output before Zod validation.
    // LLMs sometimes return dataType values outside the allowed enum
    // (e.g., "time", "boolean", "url"). Map to closest valid value.
    this.sanitizeLLMDomainOutput(data);

    // Validate with Zod schema
    const validationResult = DomainDefinitionSchema.safeParse(data);

    if (!validationResult.success) {
      logger.error('LLM generated invalid domain definition', {
        errors: validationResult.error.errors,
        organizationName: orgProfile.organizationName,
      });
      throw new Error(
        `LLM generated invalid domain definition: ${validationResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
      );
    }

    // Additional validation: ensure category references are valid
    const categoryIds = new Set(validationResult.data.categories.map((c) => c.id));
    const invalidProducts = validationResult.data.products.filter(
      (p) => !categoryIds.has(p.categoryId),
    );

    if (invalidProducts.length > 0) {
      logger.error('Products reference invalid category IDs', {
        invalidProducts: invalidProducts.map((p) => ({ id: p.id, categoryId: p.categoryId })),
      });
      throw new Error(
        `Products reference invalid category IDs: ${invalidProducts.map((p) => p.id).join(', ')}`,
      );
    }

    // Additional validation: ensure attribute applicableTo references valid products
    const productIds = new Set(validationResult.data.products.map((p) => p.id));
    for (const attr of validationResult.data.attributes) {
      const invalidRefs = attr.applicableTo?.filter((pid) => !productIds.has(pid)) || [];
      if (invalidRefs.length > 0) {
        logger.warn('Attribute references invalid product IDs', {
          attributeId: attr.id,
          invalidRefs,
        });
        // Remove invalid references instead of failing
        attr.applicableTo = attr.applicableTo?.filter((pid) => productIds.has(pid));
      }
    }

    return validationResult.data;
  }

  /**
   * Sanitize LLM-generated domain output before Zod validation.
   *
   * LLMs produce non-deterministic outputs that may use variant field names,
   * unknown enum values, or invalid regex patterns. This method normalizes
   * the output to pass strict Zod validation without losing data.
   */
  private sanitizeLLMDomainOutput(data: any): void {
    // Valid dataType values as a lookup object (no Set — avoids unbounded collection lint)
    const VALID_DATA_TYPES: Record<string, true> = {
      percentage: true,
      currency: true,
      date: true,
      duration: true,
      identifier: true,
      string: true,
      number: true,
    };
    // Common LLM variants mapped to valid enum values
    const DATA_TYPE_ALIASES: Record<string, string> = {
      time: 'duration',
      datetime: 'date',
      timestamp: 'date',
      boolean: 'string',
      bool: 'string',
      url: 'string',
      uri: 'string',
      email: 'string',
      text: 'string',
      integer: 'number',
      int: 'number',
      float: 'number',
      decimal: 'number',
      money: 'currency',
      price: 'currency',
      percent: 'percentage',
      ratio: 'percentage',
      id: 'identifier',
      uuid: 'identifier',
      code: 'identifier',
    };

    // Sanitize attribute dataTypes
    if (Array.isArray(data.attributes)) {
      for (const attr of data.attributes) {
        if (attr && typeof attr.dataType === 'string' && !VALID_DATA_TYPES[attr.dataType]) {
          const mapped = DATA_TYPE_ALIASES[attr.dataType.toLowerCase()] || 'string';
          logger.debug('Sanitizing attribute dataType', {
            attributeId: attr.id,
            original: attr.dataType,
            mapped,
          });
          attr.dataType = mapped;
        }

        // Drop invalid regex patterns rather than failing entire domain
        if (attr?.extraction && Array.isArray(attr.extraction.patterns)) {
          attr.extraction.patterns = attr.extraction.patterns.filter((p: unknown) => {
            if (typeof p !== 'string' || p.length === 0 || p.length > 200) return false;
            try {
              new RegExp(p);
              return true;
            } catch {
              logger.debug('Dropping invalid regex pattern', {
                attributeId: attr.id,
                pattern: p,
              });
              return false;
            }
          });
        }
      }
    }

    // Sanitize departmentBoundaries: drop malformed entries
    if (Array.isArray(data.departmentBoundaries)) {
      data.departmentBoundaries = data.departmentBoundaries.filter(
        (b: any) => typeof b?.product1 === 'string' && typeof b?.product2 === 'string',
      );
    }
  }

  /**
   * Get circuit breaker status
   */
  public getCircuitBreakerState(): CircuitState {
    return this.circuitBreaker.getState();
  }
}

/**
 * Factory function to create CustomDomainGenerator with resolved credentials
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
 * @returns CustomDomainGenerator instance or null if no credentials available
 */
export async function createCustomDomainGenerator(
  tenantId: string,
  indexId: string,
): Promise<CustomDomainGenerator | null> {
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

    logger.info('Creating CustomDomainGenerator with resolved credentials', {
      tenantId,
      indexId,
      provider: kgConfig.provider,
      model: kgConfig.model.modelId,
      resolution: kgConfig.resolution,
    });

    return new CustomDomainGenerator({
      tenantId,
      provider: kgConfig.provider,
      apiKey: kgConfig.apiKey,
      model: kgConfig.model.modelId,
      endpointUrl: kgConfig.endpointUrl,
      maxRetries: 2,
    });
  } catch (error) {
    logger.error('Failed to resolve LLM credentials for custom domain generation', {
      tenantId,
      indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
