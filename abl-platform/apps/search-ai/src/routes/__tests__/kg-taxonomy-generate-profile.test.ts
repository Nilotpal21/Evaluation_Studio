import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import kgTaxonomyRouter from '../kg-taxonomy.js';
import { getLazyModel } from '../../db/index.js';
import type { ISearchIndex } from '@agent-platform/database';
import * as orgProfileGeneratorModule from '../../services/org-profile-generator.service.js';

// Mock dependencies
vi.mock('../../services/org-profile-generator.service.js');
vi.mock('../../db/index.js');

describe('POST /:indexId/kg-taxonomy/generate-profile', () => {
  let app: Express;
  const mockTenantId = 'tenant-test-123';
  const mockIndexId = 'index-test-456';

  const mockOrgProfile = {
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
        reasoning:
          'Both are passive investment vehicles; index funds trade at NAV once daily while ETFs trade intraday like stocks',
      },
    ],
    productSpecificNames: {
      'index-funds': ['Admiral Shares', 'Investor Shares'],
    },
  };

  beforeAll(() => {
    // Setup express app with routes
    app = express();
    app.use(express.json());

    // Mock tenant context middleware
    app.use((req, res, next) => {
      req.tenantContext = { tenantId: mockTenantId, userId: 'user-123' } as any;
      next();
    });

    app.use('/api/indexes', kgTaxonomyRouter);
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock SearchIndex model
    const mockSearchIndex = {
      findOne: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: mockIndexId,
          tenantId: mockTenantId,
          name: 'Test Index',
        }),
      }),
    };

    vi.mocked(getLazyModel).mockReturnValue(mockSearchIndex as any);

    // Mock OrgProfileGenerator
    const mockGenerator = {
      generateFromURL: vi.fn().mockResolvedValue(mockOrgProfile),
      generateFromNameAndIndustry: vi.fn().mockResolvedValue(mockOrgProfile),
      generateFromParagraph: vi.fn().mockResolvedValue(mockOrgProfile),
      getCircuitBreakerState: vi.fn().mockReturnValue('CLOSED'),
    };

    vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(
      mockGenerator as any,
    );
  });

  describe('Mode: url', () => {
    it('generates org profile from URL', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://vanguard.com/about',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.profile).toEqual(mockOrgProfile);
      expect(response.body.data.generatedBy).toBe('llm');
      expect(response.body.data.cost).toBeGreaterThan(0);
      expect(response.body.data.metadata.mode).toBe('url');
    });

    it('returns 400 if URL is missing', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required field');
    });

    it('returns 400 on SSRF violation', async () => {
      const mockGenerator = {
        generateFromURL: vi.fn().mockRejectedValue(new Error('Private IP address blocked')),
        getCircuitBreakerState: vi.fn().mockReturnValue('CLOSED'),
      };

      vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(
        mockGenerator as any,
      );

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://192.168.1.1/internal',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('SSRF protection triggered');
      expect(response.body.suggestedAction).toBe('use-public-url');
    });
  });

  describe('Mode: name-industry', () => {
    it('generates org profile from name and industry', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'name-industry',
          input: {
            name: 'Vanguard',
            industry: 'Financial Services',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.profile).toEqual(mockOrgProfile);
      expect(response.body.data.metadata.mode).toBe('name-industry');
    });

    it('returns 400 if name or industry is missing', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'name-industry',
          input: {
            name: 'Vanguard',
            // Missing industry
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required fields');
    });
  });

  describe('Mode: paragraph', () => {
    it('generates org profile from paragraph description', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'paragraph',
          input: {
            description: 'Vanguard is a leading investment management company...',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.profile).toEqual(mockOrgProfile);
      expect(response.body.data.metadata.mode).toBe('paragraph');
    });

    it('returns 400 if description is missing', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'paragraph',
          input: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing required field');
    });
  });

  describe('Validation', () => {
    it('returns 400 if mode is invalid', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'invalid-mode',
          input: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid or missing mode');
    });

    it('returns 400 if input is missing', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing or invalid input');
    });

    it('returns 400 if LLM generates invalid profile', async () => {
      const mockGenerator = {
        generateFromURL: vi.fn().mockRejectedValue(new Error('LLM generated invalid org profile')),
        getCircuitBreakerState: vi.fn().mockReturnValue('CLOSED'),
      };

      vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(
        mockGenerator as any,
      );

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://example.com',
          },
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('LLM generated invalid profile');
      expect(response.body.suggestedAction).toBe('retry-or-manual');
    });
  });

  describe('Circuit Breaker', () => {
    it('returns 503 if circuit breaker is OPEN', async () => {
      const mockGenerator = {
        getCircuitBreakerState: vi.fn().mockReturnValue('OPEN'),
        generateFromURL: vi.fn(),
      };

      vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(
        mockGenerator as any,
      );

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://example.com',
          },
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('LLM service temporarily unavailable');
      expect(response.body.suggestedAction).toBe('manual');
      expect(response.body.retryAfter).toBe(30);
    });

    it('returns 503 if LLM timeout occurs', async () => {
      const mockGenerator = {
        generateFromURL: vi.fn().mockRejectedValue(new Error('LLM API timeout')),
        getCircuitBreakerState: vi.fn().mockReturnValue('CLOSED'),
      };

      vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(
        mockGenerator as any,
      );

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://example.com',
          },
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('LLM service temporarily unavailable');
      expect(response.body.suggestedAction).toBe('manual');
    });
  });

  describe('No LLM Credentials', () => {
    it('returns 503 if no LLM credentials configured', async () => {
      vi.mocked(orgProfileGeneratorModule.createOrgProfileGenerator).mockResolvedValue(null);

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://example.com',
          },
        });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('LLM service unavailable');
      expect(response.body.suggestedAction).toBe('manual');
    });
  });

  describe('Tenant Isolation', () => {
    it('returns 404 if index does not belong to tenant', async () => {
      const mockSearchIndex = {
        findOne: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(null), // Index not found
        }),
      };

      vi.mocked(getLazyModel).mockReturnValue(mockSearchIndex as any);

      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://example.com',
          },
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Index not found');
    });
  });

  describe('Cost Calculation', () => {
    it('includes cost in response', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://vanguard.com/about',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.cost).toBeDefined();
      expect(typeof response.body.data.cost).toBe('number');
      expect(response.body.data.cost).toBeGreaterThan(0);
      expect(response.body.data.cost).toBeLessThan(0.02); // Should be < 2 cents (Claude Sonnet pricing)
    });
  });

  describe('Metadata', () => {
    it('includes metadata in response', async () => {
      const response = await request(app)
        .post(`/api/indexes/${mockIndexId}/kg-taxonomy/generate-profile`)
        .send({
          mode: 'url',
          input: {
            url: 'https://vanguard.com/about',
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.metadata).toBeDefined();
      expect(response.body.data.metadata.mode).toBe('url');
      expect(response.body.data.metadata.durationMs).toBeGreaterThanOrEqual(0); // Can be 0 in tests
      expect(response.body.data.metadata.circuitBreakerState).toBe('CLOSED');
    });
  });
});
