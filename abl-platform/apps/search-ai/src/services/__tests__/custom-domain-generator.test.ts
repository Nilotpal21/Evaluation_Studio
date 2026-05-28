import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomDomainGenerator } from '../custom-domain-generator.service.js';
import type { OrgProfile } from '../../schemas/org-profile.schema.js';
import type { DomainDefinition } from '../../schemas/domain-definition.schema.js';
import { WorkerLLMClient } from '@agent-platform/llm';

// Mock WorkerLLMClient with constructor support
const mockChat = vi.fn();
const mockConstructorCalls: any[][] = [];
vi.mock('@agent-platform/llm', () => {
  return {
    WorkerLLMClient: class MockWorkerLLMClient {
      chat = (...args: any[]) => mockChat(...args);
      constructor(...args: any[]) {
        mockConstructorCalls.push(args);
      }
    },
  };
});

describe('CustomDomainGenerator', () => {
  let generator: CustomDomainGenerator;

  const mockOrgProfile: OrgProfile = {
    organizationName: 'Vanguard',
    industry: 'Financial Services',
    keyTerms: [
      'index fund',
      'ETF',
      'mutual fund',
      'retirement planning',
      'brokerage account',
      'asset allocation',
      'expense ratio',
    ],
    acronyms: {
      ETF: 'Exchange-Traded Fund',
      NAV: 'Net Asset Value',
      AUM: 'Assets Under Management',
    },
    departmentBoundaries: [
      {
        product1: 'index-funds',
        product2: 'etfs',
        reasoning: 'Both are passive investment vehicles with different trading mechanisms',
      },
    ],
    productSpecificNames: {
      'index-funds': ['Admiral Shares', 'Investor Shares'],
    },
  };

  const mockDomainDefinition: DomainDefinition = {
    name: 'vanguard-investment-products',
    version: '1.0.0',
    industry: 'Financial Services',
    categories: [
      {
        id: 'investment-products',
        name: 'Investment Products',
        department: 'Wealth Management',
      },
    ],
    products: [
      {
        id: 'index-funds',
        name: 'Index Funds',
        categoryId: 'investment-products',
        department: 'Wealth Management',
        subDepartment: 'Passive Investments',
        disambiguationKeywords: ['index fund', 'low-cost', 'passive'],
        organizationSpecificNames: ['Admiral Shares', 'Investor Shares'],
      },
      {
        id: 'etfs',
        name: 'ETFs',
        categoryId: 'investment-products',
        department: 'Wealth Management',
        subDepartment: 'Passive Investments',
        disambiguationKeywords: ['ETF', 'exchange-traded', 'intraday trading'],
        organizationSpecificNames: [],
      },
    ],
    attributes: [
      {
        id: 'expense-ratio',
        name: 'Expense Ratio',
        dataType: 'percentage',
        applicableTo: ['index-funds', 'etfs'],
        notApplicableTo: [],
        extraction: {
          method: 'regex',
          patterns: ['\\d+\\.\\d+%', 'expense ratio of \\d+\\.\\d+%'],
          keywords: ['expense ratio', 'fees', 'cost'],
        },
      },
    ],
    departmentBoundaries: [
      {
        product1: 'index-funds',
        product2: 'etfs',
        reasoning: 'Both are passive investment vehicles with different trading mechanisms',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock chat to return valid domain definition
    mockChat.mockResolvedValue(JSON.stringify(mockDomainDefinition));

    generator = new CustomDomainGenerator({
      tenantId: 'test-tenant',
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-4.5',
    });
  });

  describe('generateFromOrgProfile', () => {
    it('generates valid domain definition from org profile', async () => {
      const result = await generator.generateFromOrgProfile(mockOrgProfile);

      expect(result).toEqual(mockDomainDefinition);
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('includes org profile data in prompt', async () => {
      await generator.generateFromOrgProfile(mockOrgProfile);

      const userMessage = mockChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain('Vanguard');
      expect(userMessage).toContain('Financial Services');
      expect(userMessage).toContain('index fund');
      expect(userMessage).toContain('ETF: Exchange-Traded Fund');
      expect(userMessage).toContain('index-funds vs etfs');
    });

    it('handles JSON wrapped in markdown code block', async () => {
      mockChat.mockResolvedValue(`\`\`\`json\n${JSON.stringify(mockDomainDefinition)}\n\`\`\``);

      const result = await generator.generateFromOrgProfile(mockOrgProfile);

      expect(result).toEqual(mockDomainDefinition);
    });

    it('throws error for invalid JSON', async () => {
      mockChat.mockResolvedValue('not valid JSON');

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'LLM generated invalid JSON',
      );
    });

    it('throws error for invalid domain schema', async () => {
      const invalidDomain = {
        name: 'test',
        // Missing required fields
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidDomain));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'LLM generated invalid domain definition',
      );
    });

    it('throws error when product references invalid category', async () => {
      const invalidDomain = {
        ...mockDomainDefinition,
        products: [
          {
            ...mockDomainDefinition.products[0],
            categoryId: 'non-existent-category',
          },
        ],
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidDomain));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'Products reference invalid category IDs',
      );
    });

    it('filters out invalid product references in attributes', async () => {
      const domainWithInvalidRefs = {
        ...mockDomainDefinition,
        attributes: [
          {
            ...mockDomainDefinition.attributes[0],
            applicableTo: ['index-funds', 'invalid-product-id'],
          },
        ],
      };

      mockChat.mockResolvedValue(JSON.stringify(domainWithInvalidRefs));

      const result = await generator.generateFromOrgProfile(mockOrgProfile);

      // Should filter out invalid product ID
      expect(result.attributes[0].applicableTo).toEqual(['index-funds']);
    });

    it('passes system prompt and user message to LLM', async () => {
      await generator.generateFromOrgProfile(mockOrgProfile);

      // WorkerLLMClient.chat(systemPrompt, messages, options)
      expect(mockChat).toHaveBeenCalledWith(
        expect.any(String), // system prompt
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.any(String),
          }),
        ]),
        expect.objectContaining({
          maxTokens: 8192,
        }),
      );
    });
  });

  describe('Circuit Breaker', () => {
    it('opens circuit after repeated failures', async () => {
      mockChat.mockRejectedValue(new Error('API error'));

      // Fail multiple times
      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow();
      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow();

      expect(generator.getCircuitBreakerState()).toBe('OPEN');
    });

    it('rejects requests when circuit is open', async () => {
      mockChat.mockRejectedValue(new Error('API error'));

      // Open circuit
      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow();
      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow();

      // Should fail immediately without calling LLM
      const callCountBefore = mockChat.mock.calls.length;
      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'Circuit breaker is OPEN',
      );
      expect(mockChat.mock.calls.length).toBe(callCountBefore);
    });
  });

  describe('Error Handling', () => {
    it('handles API timeout errors', async () => {
      mockChat.mockRejectedValue(new Error('Request timeout'));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'Request timeout',
      );
    });

    it('handles API rate limit errors', async () => {
      mockChat.mockRejectedValue(new Error('Rate limit exceeded'));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'Rate limit exceeded',
      );
    });
  });

  describe('Provider Configuration', () => {
    it('creates WorkerLLMClient with provided config', () => {
      mockConstructorCalls.length = 0;
      new CustomDomainGenerator({
        tenantId: 'test-tenant',
        provider: 'openai',
        apiKey: 'sk-openai-key',
        model: 'gpt-4o',
      });

      const lastCall = mockConstructorCalls[mockConstructorCalls.length - 1];
      expect(lastCall).toEqual(['openai', 'sk-openai-key', 'gpt-4o', { baseUrl: undefined }]);
    });
  });

  describe('Domain Validation', () => {
    it('validates kebab-case IDs', async () => {
      const invalidDomain = {
        ...mockDomainDefinition,
        categories: [
          {
            id: 'Invalid Category', // Not kebab-case
            name: 'Invalid Category',
            department: 'Test',
          },
        ],
        products: [],
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidDomain));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'must be kebab-case',
      );
    });

    it('validates version format', async () => {
      const invalidDomain = {
        ...mockDomainDefinition,
        version: 'invalid', // Not semver
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidDomain));

      await expect(generator.generateFromOrgProfile(mockOrgProfile)).rejects.toThrow(
        'must be semver format',
      );
    });

    it('sanitizes invalid attribute data types to valid values', async () => {
      const domainWithInvalidType = {
        ...mockDomainDefinition,
        attributes: [
          {
            ...mockDomainDefinition.attributes[0],
            dataType: 'invalid-type', // Not a valid data type — sanitized to 'string'
          },
        ],
      };

      mockChat.mockResolvedValue(JSON.stringify(domainWithInvalidType));

      // Sanitization now maps unknown types to 'string' instead of rejecting
      const result = await generator.generateFromOrgProfile(mockOrgProfile);
      expect(result.attributes[0].dataType).toBe('string');
    });
  });
});
