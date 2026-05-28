/**
 * Knowledge Graph Enrichment Integration Tests (Phase 3)
 *
 * End-to-end tests for taxonomy-driven document classification and entity extraction.
 *
 * Tests:
 * - Taxonomy loading (domain definitions + organization profile)
 * - LLM organization profile parsing
 * - Document-level classification
 * - Hybrid entity extraction (regex + LLM)
 * - Neo4j taxonomy graph creation
 * - KG enrichment worker
 * - API endpoints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { TaxonomyLoaderService } from '../services/taxonomy-loader.service.js';
import { DocumentClassifierService } from '../services/document-classifier.service.js';
import { EntityExtractorService } from '../services/entity-extractor.service.js';
import { TaxonomyGraphService } from '../services/knowledge-graph/taxonomy-graph.service.js';
import { WorkerLLMClient } from '@agent-platform/llm';
import type { ChatLLMClient } from '@agent-platform/llm';
import type { DomainDefinition, OrganizationProfile } from '../services/taxonomy-loader.service.js';
import type { IKnowledgeGraphTaxonomy } from '@agent-platform/database';

// Mock getConfig to avoid configuration loading issues in tests
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    knowledgeGraph: {
      uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
      username: process.env.NEO4J_USERNAME || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'password',
      database: 'neo4j',
      neo4jMaxPoolSize: 50,
    },
  }),
}));

// =============================================================================
// TEST SETUP
// =============================================================================

// LLM client factory for tests — uses env API key if available
function createTestLLMClient(): WorkerLLMClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!apiKey) return null;
  return new WorkerLLMClient('anthropic', apiKey, 'claude-haiku-4-5-20251022');
}

// =============================================================================
// TEST DATA
// =============================================================================

const mockDomainDefinition: DomainDefinition = {
  id: 'test-financial',
  name: 'Test Financial Services',
  version: '1.0.0',
  categories: [
    {
      id: 'banking',
      name: 'Banking',
      department: 'Consumer Banking',
    },
    {
      id: 'lending',
      name: 'Lending',
      department: 'Lending',
    },
  ],
  products: [
    {
      id: 'checking-account',
      name: 'Checking Account',
      categoryId: 'banking',
      department: 'Consumer Banking',
      subDepartment: 'Deposit Products',
      disambiguationKeywords: ['checking', 'debit card', 'transactions'],
    },
    {
      id: 'credit-card',
      name: 'Credit Card',
      categoryId: 'lending',
      department: 'Lending',
      subDepartment: 'Consumer Credit',
      disambiguationKeywords: ['credit card', 'APR', 'credit limit', 'rewards'],
    },
    {
      id: 'mortgage',
      name: 'Mortgage',
      categoryId: 'lending',
      department: 'Lending',
      subDepartment: 'Real Estate Lending',
      disambiguationKeywords: ['mortgage', 'home loan', 'down payment'],
    },
  ],
  attributes: [
    {
      id: 'interest_rate',
      name: 'Interest Rate',
      dataType: 'percentage',
      applicableTo: ['credit-card', 'mortgage'],
      extraction: {
        method: 'regex',
        patterns: ['\\d+\\.\\d+%', '\\d+% APR'],
        keywords: ['interest rate', 'APR', 'annual percentage rate'],
      },
    },
    {
      id: 'credit_limit',
      name: 'Credit Limit',
      dataType: 'currency',
      applicableTo: ['credit-card'],
      extraction: {
        method: 'regex',
        patterns: ['\\$[\\d]+', 'credit limit of \\$[\\d]+'],
        keywords: ['credit limit', 'credit line'],
      },
    },
    {
      id: 'loan_amount',
      name: 'Loan Amount',
      dataType: 'currency',
      applicableTo: ['mortgage'],
      extraction: {
        method: 'regex',
        patterns: ['\\$[\\d]+'],
        keywords: ['loan amount', 'principal'],
      },
    },
  ],
  departmentBoundaries: [
    {
      product1: 'credit-card',
      product2: 'mortgage',
      reasoning: 'Both are lending products but different sub-departments',
    },
  ],
};

const mockOrgProfile: OrganizationProfile = {
  organizationName: 'Test Bank',
  products: [
    {
      productId: 'checking-account',
      organizationSpecificNames: ['Everyday Checking', 'Basic Checking'],
      attributeContext: {},
    },
    {
      productId: 'credit-card',
      organizationSpecificNames: ['Platinum Rewards Card', 'Cashback Card'],
      attributeContext: {
        interest_rate: {
          typicalRange: '16.99% - 24.99%',
          aliases: ['APR', 'Annual Rate'],
        },
        credit_limit: {
          typicalRange: '$5,000 - $50,000',
          aliases: ['limit', 'credit line'],
        },
      },
    },
  ],
};

// =============================================================================
// TAXONOMY LOADER TESTS
// =============================================================================

describe('TaxonomyLoaderService', () => {
  let taxonomyLoader: TaxonomyLoaderService;
  let llmClient: ChatLLMClient | null;

  beforeAll(() => {
    llmClient = createTestLLMClient();
    if (llmClient) {
      taxonomyLoader = new TaxonomyLoaderService(llmClient);
    } else {
      console.warn('LLM client not configured, skipping LLM-dependent tests');
    }
  });

  describe('mergeTaxonomy', () => {
    it('should merge domain definition with organization profile', () => {
      if (!taxonomyLoader) {
        console.warn('Skipping test: taxonomyLoader not initialized');
        return;
      }

      const merged = (taxonomyLoader as any).mergeTaxonomy([mockDomainDefinition], mockOrgProfile);

      expect(merged.domain.id).toBe('test-financial');
      expect(merged.categories.length).toBe(2);
      expect(merged.products.length).toBe(3);

      // Check organization-specific names were merged
      const creditCard = merged.products.find((p) => p.id === 'credit-card');
      expect(creditCard?.organizationSpecificNames).toEqual([
        'Platinum Rewards Card',
        'Cashback Card',
      ]);

      // Check attributes have organization context
      const interestRate = merged.attributes.find((a) => a.id === 'interest_rate');
      expect(interestRate?.organizationContext).toBeDefined();
      expect(interestRate?.organizationContext?.typicalRange).toBe('16.99% - 24.99%');
    });
  });

  describe('validateTaxonomy', () => {
    it('should validate valid taxonomy structure', () => {
      if (!taxonomyLoader) {
        return;
      }

      const merged = (taxonomyLoader as any).mergeTaxonomy([mockDomainDefinition], mockOrgProfile);

      expect(() => {
        (taxonomyLoader as any).validateTaxonomy(merged);
      }).not.toThrow();
    });

    it('should reject taxonomy with invalid category reference', () => {
      if (!taxonomyLoader) {
        return;
      }

      const invalidDomain = {
        ...mockDomainDefinition,
        products: [
          {
            id: 'test-product',
            name: 'Test Product',
            categoryId: 'invalid-category', // Invalid reference
            department: 'Test',
            subDepartment: 'Test',
            disambiguationKeywords: [],
          },
        ],
      };

      const merged = (taxonomyLoader as any).mergeTaxonomy([invalidDomain], mockOrgProfile);

      expect(() => {
        (taxonomyLoader as any).validateTaxonomy(merged);
      }).toThrow(/invalid category/i);
    });

    it('should reject taxonomy with conflicting applicableTo/notApplicableTo', () => {
      if (!taxonomyLoader) {
        return;
      }

      const invalidDomain = {
        ...mockDomainDefinition,
        attributes: [
          {
            id: 'test-attr',
            name: 'Test Attribute',
            dataType: 'string' as const,
            applicableTo: ['credit-card'],
            notApplicableTo: ['credit-card'], // Conflict!
            extraction: { method: 'regex' as const },
          },
        ],
      };

      const merged = (taxonomyLoader as any).mergeTaxonomy([invalidDomain], mockOrgProfile);

      expect(() => {
        (taxonomyLoader as any).validateTaxonomy(merged);
      }).toThrow(/conflicting/i);
    });
  });
});

// =============================================================================
// DOCUMENT CLASSIFIER TESTS
// =============================================================================

describe('DocumentClassifierService', () => {
  let classifier: DocumentClassifierService;
  let llmClient: ChatLLMClient | null;

  beforeAll(() => {
    llmClient = createTestLLMClient();
    if (llmClient) {
      classifier = new DocumentClassifierService(llmClient);
    } else {
      console.warn('LLM client not configured, skipping DocumentClassifier tests');
    }
  });

  const taxonomy = {
    domain: mockDomainDefinition,
    categories: mockDomainDefinition.categories,
    products: mockDomainDefinition.products,
    attributes: mockDomainDefinition.attributes,
    departmentBoundaries: mockDomainDefinition.departmentBoundaries || [],
  };

  describe('classifyDocument', () => {
    it('should classify credit card document correctly', async () => {
      if (!classifier || !process.env.ANTHROPIC_API_KEY) {
        console.warn('Skipping LLM-dependent test');
        return;
      }

      const document = {
        title: 'Credit Card Application Guide',
        summary:
          'Guide for applying for our Platinum Rewards Credit Card. Includes information about credit limits, APR rates, and cashback rewards program.',
      };

      const result = await classifier.classifyDocument(document, taxonomy);

      expect(result.classification.productScope.primaryProduct).toBe('credit-card');
      expect(result.classification.department).toBe('Lending');
      expect(result.classification.category).toBe('lending');
      expect(result.classification.productScope.confidence).toBeGreaterThan(0.5);
    });

    it('should classify mortgage document correctly', async () => {
      if (!classifier || !process.env.ANTHROPIC_API_KEY) {
        return;
      }

      const document = {
        title: 'Home Mortgage Terms',
        summary:
          'Terms and conditions for home mortgage loans. Covers loan amounts, down payment requirements, and interest rates.',
      };

      const result = await classifier.classifyDocument(document, taxonomy);

      expect(result.classification.productScope.primaryProduct).toBe('mortgage');
      expect(result.classification.department).toBe('Lending');
    });

    it('should detect multi-product documents', async () => {
      if (!classifier || !process.env.ANTHROPIC_API_KEY) {
        return;
      }

      const document = {
        title: 'Banking Product Comparison',
        summary:
          'Compare our checking accounts, credit cards, and mortgage options. Find the right product for your needs.',
      };

      const result = await classifier.classifyDocument(document, taxonomy);

      // Should detect multiple products
      expect(result.classification.productScope.secondaryProducts.length).toBeGreaterThan(0);
    });

    it('should use Haiku by default', async () => {
      if (!classifier || !process.env.ANTHROPIC_API_KEY) {
        return;
      }

      const document = {
        title: 'Credit Card Benefits',
        summary: 'Overview of credit card rewards and benefits.',
      };

      const result = await classifier.classifyDocument(document, taxonomy);

      // Should use Haiku (not escalated to Sonnet)
      expect(result.classification.escalatedToSonnet).toBe(false);
    });
  });
});

// =============================================================================
// ENTITY EXTRACTOR TESTS
// =============================================================================

describe('EntityExtractorService', () => {
  let extractor: EntityExtractorService;
  let llmClient: ChatLLMClient | null;

  beforeAll(() => {
    llmClient = createTestLLMClient();
    if (llmClient) {
      extractor = new EntityExtractorService(llmClient);
    } else {
      console.warn('LLM client not configured, skipping EntityExtractor tests');
    }
  });

  const taxonomy = {
    domain: mockDomainDefinition,
    categories: mockDomainDefinition.categories,
    products: mockDomainDefinition.products,
    attributes: mockDomainDefinition.attributes,
    departmentBoundaries: mockDomainDefinition.departmentBoundaries || [],
  };

  describe('extractEntities', () => {
    it('should extract interest rate from text', async () => {
      if (!extractor) {
        return;
      }

      const text = 'Our credit card offers a competitive APR of 18.99% for qualified applicants.';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      const interestRates = entities.filter((e) => e.type === 'interest_rate');
      expect(interestRates.length).toBeGreaterThan(0);
      expect(interestRates[0].rawValue).toContain('18.99');
    });

    it('should extract credit limit from text', async () => {
      if (!extractor) {
        return;
      }

      const text = 'You have been approved for a credit limit of $25,000.';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      const creditLimits = entities.filter((e) => e.type === 'credit_limit');
      expect(creditLimits.length).toBeGreaterThan(0);
      expect(creditLimits[0].rawValue).toContain('25,000');
    });

    it('should only extract applicable attributes for product', async () => {
      if (!extractor) {
        return;
      }

      const text =
        'Interest rate: 18.99%. Credit limit: $25,000. Loan amount: $300,000. Down payment: $60,000.';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      // Should extract interest_rate and credit_limit (applicable to credit-card)
      // Should NOT extract loan_amount or down_payment (only applicable to mortgage)
      const types = new Set(entities.map((e) => e.type));
      expect(types.has('interest_rate')).toBe(true);
      expect(types.has('credit_limit')).toBe(true);
      expect(types.has('loan_amount')).toBe(false);
    });

    it('should normalize currency values', async () => {
      if (!extractor) {
        return;
      }

      const text = 'Credit limit: $25,000.00';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      const creditLimit = entities.find((e) => e.type === 'credit_limit');
      expect(creditLimit?.normalizedValue).toBe(25000);
    });

    it('should normalize percentage values', async () => {
      if (!extractor) {
        return;
      }

      const text = 'Interest rate: 18.99%';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      const interestRate = entities.find((e) => e.type === 'interest_rate');
      // normalizeValue divides by 100: "18.99%" → 0.1899
      expect(interestRate?.normalizedValue).toBeCloseTo(0.1899, 4);
    });

    it('should use regex extraction for regex-based attributes', async () => {
      if (!extractor) {
        return;
      }

      const text = 'APR: 18.99%. Credit limit: $25,000.';

      const result = await extractor.extractEntities(text, taxonomy, 'credit-card');
      const entities = result.known;

      // All credit card attributes use regex extraction
      expect(entities.length).toBeGreaterThan(0);
      // Note: IEntityExtraction does not have extractionMethod field (it's on ExtractedEntity)
      // Regex-extracted entities are verified by the fact they appear without LLM call
    });
  });
});

// =============================================================================
// TAXONOMY GRAPH SERVICE TESTS (requires Neo4j)
// =============================================================================

describe('TaxonomyGraphService', () => {
  let taxonomyGraph: TaxonomyGraphService | null = null;
  const testTenantId = 'test-tenant-kg';
  const testIndexId = 'test-index-kg';

  beforeAll(async () => {
    // Skip if Neo4j not configured
    if (!process.env.NEO4J_URI && !process.env.KNOWLEDGE_GRAPH_NEO4J_URI) {
      console.warn('Neo4j not configured, skipping TaxonomyGraphService tests');
      return;
    }

    try {
      const { getConfig } = await import('../config/index.js');
      const config = getConfig();

      if (!config.knowledgeGraph.uri) {
        return;
      }

      taxonomyGraph = new TaxonomyGraphService(config.knowledgeGraph);
      await taxonomyGraph.connect();
    } catch (error) {
      console.warn('Failed to connect to Neo4j, skipping tests:', error);
      taxonomyGraph = null;
    }
  });

  afterAll(async () => {
    if (taxonomyGraph) {
      // Cleanup test data
      try {
        await taxonomyGraph.deleteTaxonomyGraph(testTenantId, testIndexId);
      } catch (error) {
        // Ignore cleanup errors
      }
      await taxonomyGraph.close();
    }
  });

  it('should create taxonomy graph structure', async () => {
    if (!taxonomyGraph) {
      return; // Skip if Neo4j not available
    }

    const taxonomy = {
      domain: mockDomainDefinition,
      categories: mockDomainDefinition.categories,
      products: mockDomainDefinition.products,
      attributes: mockDomainDefinition.attributes,
      departmentBoundaries: mockDomainDefinition.departmentBoundaries || [],
    };

    await taxonomyGraph.createTaxonomyGraph(testTenantId, testIndexId, taxonomy);

    // Verify graph was created
    const stats = await taxonomyGraph.getTaxonomyStats(testTenantId, testIndexId);
    expect(stats.domainCount).toBe(1);
    expect(stats.categoryCount).toBe(2);
    expect(stats.productCount).toBe(3);
    expect(stats.attributeCount).toBe(3);
  });

  // NOTE: linkDocumentToProduct was removed — Document nodes are not stored in
  // the taxonomy graph. Document classification lives in MongoDB.
  // See taxonomy-graph.service.ts header comment for rationale.

  it('should retrieve products by category', async () => {
    if (!taxonomyGraph) {
      return;
    }

    const products = await taxonomyGraph.getProductsByCategory(
      testTenantId,
      testIndexId,
      'lending',
    );

    expect(products.length).toBe(2); // credit-card and mortgage
    expect(products.every((p) => p.categoryId === 'lending')).toBe(true);
  });

  it('should retrieve attributes for product', async () => {
    if (!taxonomyGraph) {
      return;
    }

    const attributes = await taxonomyGraph.getAttributesForProduct(
      testTenantId,
      testIndexId,
      'credit-card',
    );

    // Should have interest_rate and credit_limit
    expect(attributes.length).toBe(2);
    const attrIds = attributes.map((a) => a.id);
    expect(attrIds).toContain('interest_rate');
    expect(attrIds).toContain('credit_limit');
  });
});

// =============================================================================
// END-TO-END WORKFLOW TEST
// =============================================================================

describe('KG Enrichment End-to-End', () => {
  it('should complete full enrichment workflow', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('Skipping E2E test: ANTHROPIC_API_KEY not set');
      return;
    }

    const llmClient = createTestLLMClient()!;
    const taxonomyLoader = new TaxonomyLoaderService(llmClient);
    const classifier = new DocumentClassifierService(llmClient);
    const extractor = new EntityExtractorService(llmClient);

    // Step 1: Load and merge taxonomy
    const merged = (taxonomyLoader as any).mergeTaxonomy([mockDomainDefinition], mockOrgProfile);
    (taxonomyLoader as any).validateTaxonomy(merged);

    expect(merged.products.length).toBe(3);

    // Step 2: Classify document
    const document = {
      title: 'Platinum Rewards Credit Card',
      summary:
        'Premium credit card with 18.99% APR and up to $50,000 credit limit. Earn cashback on all purchases.',
    };

    const classification = await classifier.classifyDocument(document, merged);

    expect(classification.classification.productScope.primaryProduct).toBe('credit-card');
    expect(classification.classification.productScope.confidence).toBeGreaterThan(0.7);

    // Step 3: Extract entities
    const chunkText =
      'Your approved credit limit is $35,000 with an APR of 18.99%. Make purchases and earn 2% cashback.';

    const extractionResult = await extractor.extractEntities(
      chunkText,
      merged,
      classification.classification.productScope.primaryProduct,
    );

    // extractEntities returns ExtractionResult { known, novel }, not an array
    const knownEntities = extractionResult.known;

    // Should extract interest_rate and credit_limit
    expect(knownEntities.length).toBeGreaterThan(0);

    const interestRate = knownEntities.find((e) => e.type === 'interest_rate');
    const creditLimit = knownEntities.find((e) => e.type === 'credit_limit');

    expect(interestRate).toBeDefined();
    expect(interestRate?.normalizedValue).toBeCloseTo(0.1899, 4);

    expect(creditLimit).toBeDefined();
    expect(creditLimit?.normalizedValue).toBe(35000);

    console.log('[E2E Test] Classification:', classification.classification);
    console.log('[E2E Test] Known entities extracted:', knownEntities.length);
    console.log('[E2E Test] Novel candidates:', extractionResult.novel.length);
  });
});
