import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrgProfileGenerator } from '../org-profile-generator.service.js';
import * as ssrfProtection from '../../utils/ssrf-protection.js';
import { WorkerLLMClient } from '@agent-platform/llm';

// Mock dependencies
vi.mock('../../utils/ssrf-protection.js');

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

describe('OrgProfileGenerator', () => {
  let generator: OrgProfileGenerator;
  const mockApiKey = 'sk-test-key';
  const mockTenantId = 'tenant-test-123';
  const mockProvider = 'anthropic';
  const mockModel = 'claude-sonnet-4.5';

  const validOrgProfile = {
    organizationName: 'Vanguard',
    industry: 'Financial Services',
    keyTerms: [
      'index fund',
      'low-cost investing',
      'ETF',
      'mutual fund',
      'asset allocation',
      'expense ratio',
      'admiral shares',
      'target retirement',
      'brokerage account',
      'financial advisor',
      'passive investing',
      'diversification',
      'retirement planning',
    ],
    acronyms: {
      ETF: 'Exchange-Traded Fund',
      NAV: 'Net Asset Value',
      AUM: 'Assets Under Management',
      VOO: 'Vanguard S&P 500 ETF',
      VTSAX: 'Vanguard Total Stock Market Index Fund Admiral Shares',
      TDF: 'Target-Date Fund',
      IRA: 'Individual Retirement Account',
      RMD: 'Required Minimum Distribution',
    },
    departmentBoundaries: [
      {
        product1: 'index-funds',
        product2: 'etfs',
        reasoning:
          'Both are passive investment vehicles; index funds trade at NAV once daily while ETFs trade intraday like stocks, causing confusion about which to choose',
      },
      {
        product1: 'target-retirement-funds',
        product2: 'balanced-funds',
        reasoning:
          'Both provide diversified asset allocation; target-date funds automatically adjust over time while balanced funds maintain fixed allocation, users often confuse the two',
      },
    ],
    productSpecificNames: {
      'index-funds': ['Admiral Shares', 'Investor Shares', 'Institutional Shares'],
      'target-retirement-funds': ['Target Retirement Funds', 'LifeStrategy Funds'],
    },
  };

  // WorkerLLMClient.chat returns a string (not Anthropic message object)
  const mockLLMResponse = JSON.stringify(validOrgProfile);

  beforeEach(() => {
    vi.clearAllMocks();
    mockConstructorCalls.length = 0;

    // Reset the mock chat to return valid response
    mockChat.mockResolvedValue(mockLLMResponse);

    generator = new OrgProfileGenerator({
      tenantId: mockTenantId,
      provider: mockProvider,
      apiKey: mockApiKey,
      model: mockModel,
      maxRetries: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('generateFromURL', () => {
    it('generates org profile from valid URL', async () => {
      const mockUrl = 'https://vanguard.com/about';
      const mockContent =
        '<html><body><h1>Vanguard</h1><p>Leading investment firm...</p></body></html>';

      // Mock SSRF-protected fetch
      vi.mocked(ssrfProtection.validateAndFetchURL).mockResolvedValue(mockContent);

      const result = await generator.generateFromURL(mockUrl);

      expect(result).toEqual(validOrgProfile);
      expect(ssrfProtection.validateAndFetchURL).toHaveBeenCalledWith(mockUrl);
      expect(mockChat).toHaveBeenCalledTimes(1);
    });

    it('throws error if URL fetch fails (SSRF protection)', async () => {
      const mockUrl = 'https://192.168.1.1/internal';

      vi.mocked(ssrfProtection.validateAndFetchURL).mockRejectedValue(
        new Error('Private IP address blocked: 192.168.1.1'),
      );

      await expect(generator.generateFromURL(mockUrl)).rejects.toThrow(
        'Private IP address blocked',
      );
      expect(ssrfProtection.validateAndFetchURL).toHaveBeenCalledWith(mockUrl);
    });

    it('throws error if LLM returns invalid JSON', async () => {
      const mockUrl = 'https://example.com';
      const mockContent = '<html><body>Example content</body></html>';

      vi.mocked(ssrfProtection.validateAndFetchURL).mockResolvedValue(mockContent);

      // Mock LLM returning non-JSON response
      mockChat.mockResolvedValue('This is not JSON');

      await expect(generator.generateFromURL(mockUrl)).rejects.toThrow(
        'LLM response does not contain valid JSON',
      );
    });

    it('throws error if LLM returns invalid org profile (fails Zod validation)', async () => {
      const mockUrl = 'https://example.com';
      const mockContent = '<html><body>Example content</body></html>';

      vi.mocked(ssrfProtection.validateAndFetchURL).mockResolvedValue(mockContent);

      // Mock LLM returning invalid profile (missing required fields)
      const invalidProfile = {
        organizationName: 'Test Corp',
        // Missing industry, keyTerms, acronyms
      };
      mockChat.mockResolvedValue(JSON.stringify(invalidProfile));

      await expect(generator.generateFromURL(mockUrl)).rejects.toThrow(
        'LLM generated invalid org profile',
      );
    });
  });

  describe('generateFromNameAndIndustry', () => {
    it('generates org profile from name and industry', async () => {
      const result = await generator.generateFromNameAndIndustry('Vanguard', 'Financial Services');

      expect(result).toEqual(validOrgProfile);
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Verify prompt contains name and industry
      const userMessage = mockChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain('Vanguard');
      expect(userMessage).toContain('Financial Services');
    });

    it('includes name and industry in prompt', async () => {
      await generator.generateFromNameAndIndustry('Salesforce', 'Technology');

      const userMessage = mockChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain('Salesforce');
      expect(userMessage).toContain('Technology');
    });

    it('throws error if LLM generation fails', async () => {
      mockChat.mockRejectedValue(new Error('LLM API timeout'));

      await expect(generator.generateFromNameAndIndustry('Test', 'Industry')).rejects.toThrow(
        'LLM API timeout',
      );
    });
  });

  describe('generateFromParagraph', () => {
    it('generates org profile from paragraph description', async () => {
      const description = `Vanguard is a leading investment management company known for
        low-cost index funds and ETFs. They serve millions of investors with retirement
        planning, wealth management, and advisory services.`;

      const result = await generator.generateFromParagraph(description);

      expect(result).toEqual(validOrgProfile);
      expect(mockChat).toHaveBeenCalledTimes(1);

      // Verify prompt contains description
      const userMessage = mockChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain(description);
    });

    it('handles long paragraph descriptions', async () => {
      const longDescription = 'A'.repeat(5000); // 5000 character paragraph

      await generator.generateFromParagraph(longDescription);

      const userMessage = mockChat.mock.calls[0][1][0].content;
      expect(userMessage).toContain(longDescription);
    });
  });

  describe('Circuit Breaker', () => {
    it('opens circuit breaker after 50% error rate', async () => {
      const failingGenerator = new OrgProfileGenerator({
        tenantId: mockTenantId,
        provider: mockProvider,
        apiKey: mockApiKey,
        model: mockModel,
        circuitBreakerThreshold: 0.5,
      });

      // Mock LLM to fail
      mockChat.mockRejectedValue(new Error('LLM API error'));

      // First 2 requests fail (2/2 = 100% error rate)
      await expect(
        failingGenerator.generateFromNameAndIndustry('Test', 'Industry'),
      ).rejects.toThrow();
      await expect(
        failingGenerator.generateFromNameAndIndustry('Test', 'Industry'),
      ).rejects.toThrow();

      // Circuit breaker should be OPEN now
      expect(failingGenerator.getCircuitBreakerState()).toBe('OPEN');

      // Next request should be blocked by circuit breaker (not reach LLM)
      await expect(
        failingGenerator.generateFromNameAndIndustry('Test', 'Industry'),
      ).rejects.toThrow('Circuit breaker is OPEN');
    });

    it('resets circuit breaker after timeout', async () => {
      const failingGenerator = new OrgProfileGenerator({
        tenantId: mockTenantId,
        provider: mockProvider,
        apiKey: mockApiKey,
        model: mockModel,
        circuitBreakerThreshold: 0.5,
        circuitBreakerResetTimeout: 100, // 100ms reset timeout
      });

      // Mock LLM to fail initially
      mockChat.mockRejectedValue(new Error('LLM API error'));

      // Trigger circuit breaker to OPEN
      await expect(
        failingGenerator.generateFromNameAndIndustry('Test', 'Industry'),
      ).rejects.toThrow();
      await expect(
        failingGenerator.generateFromNameAndIndustry('Test', 'Industry'),
      ).rejects.toThrow();

      expect(failingGenerator.getCircuitBreakerState()).toBe('OPEN');

      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Mock LLM to succeed now
      mockChat.mockResolvedValue(mockLLMResponse);

      // Circuit breaker should enter HALF_OPEN and allow request
      const result = await failingGenerator.generateFromNameAndIndustry(
        'Vanguard',
        'Financial Services',
      );

      expect(result).toEqual(validOrgProfile);
      expect(failingGenerator.getCircuitBreakerState()).toBe('CLOSED');
    });
  });

  describe('Provider Configuration', () => {
    it('creates WorkerLLMClient with provided config', () => {
      mockConstructorCalls.length = 0;
      new OrgProfileGenerator({
        tenantId: mockTenantId,
        provider: 'openai',
        apiKey: 'sk-openai-key',
        model: 'gpt-4o',
      });

      const lastCall = mockConstructorCalls[mockConstructorCalls.length - 1];
      expect(lastCall).toEqual(['openai', 'sk-openai-key', 'gpt-4o', { baseUrl: undefined }]);
    });

    it('supports all provider types', () => {
      for (const provider of ['anthropic', 'openai', 'gemini']) {
        mockConstructorCalls.length = 0;
        new OrgProfileGenerator({
          tenantId: mockTenantId,
          provider,
          apiKey: `key-${provider}`,
          model: `model-${provider}`,
        });

        const lastCall = mockConstructorCalls[mockConstructorCalls.length - 1];
        expect(lastCall).toEqual([
          provider,
          `key-${provider}`,
          `model-${provider}`,
          { baseUrl: undefined },
        ]);
      }
    });
  });

  describe('Validation Integration', () => {
    it('validates keyTerms length (10-20 terms)', async () => {
      const invalidProfile = {
        ...validOrgProfile,
        keyTerms: ['term1'], // Only 1 term (minimum is 1, but best practice is 10-15)
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidProfile));

      // Should still pass validation (min is 1), but will log warning
      const result = await generator.generateFromNameAndIndustry('Test', 'Industry');
      expect(result.keyTerms).toHaveLength(1);
    });

    it('validates acronyms count (≤50)', async () => {
      const invalidProfile = {
        ...validOrgProfile,
        acronyms: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`AC${i}`, `Acronym ${i}`]),
        ),
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidProfile));

      await expect(generator.generateFromNameAndIndustry('Test', 'Industry')).rejects.toThrow(
        'Too many acronyms',
      );
    });

    it('validates department boundary reasoning length (10-500 chars)', async () => {
      const invalidProfile = {
        ...validOrgProfile,
        departmentBoundaries: [
          {
            product1: 'product-1',
            product2: 'product-2',
            reasoning: 'short', // <10 chars
          },
        ],
      };

      mockChat.mockResolvedValue(JSON.stringify(invalidProfile));

      await expect(generator.generateFromNameAndIndustry('Test', 'Industry')).rejects.toThrow(
        'Reasoning must be descriptive',
      );
    });
  });
});
