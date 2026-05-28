import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Mock Dependencies ──────────────────────────────────────────────────

const { mockTaxonomyModel, mockAttributeRegistryModel, mockGetTaxonomy } = vi.hoisted(() => ({
  mockTaxonomyModel: { findOne: vi.fn() },
  mockAttributeRegistryModel: { find: vi.fn() },
  mockGetTaxonomy: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'KnowledgeGraphTaxonomy') return mockTaxonomyModel;
    if (name === 'AttributeRegistry') return mockAttributeRegistryModel;
    return {};
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant_123', userId: 'user_456' };
    next();
  },
}));

vi.mock('../../middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../services/taxonomy/taxonomy-cache-reader.js', () => ({
  getTaxonomyCacheReader: () => ({
    getTaxonomy: mockGetTaxonomy,
  }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock ClickHouse for FacetQueryService (imported by browse router)
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: vi.fn(),
  }),
}));

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Browse Router', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { createBrowseRouter } = await import('../browse.js');
    app = express();
    app.use(express.json());
    app.use(createBrowseRouter());

    // Default: cache miss, MongoDB returns null
    mockGetTaxonomy.mockResolvedValue(null);
    mockTaxonomyModel.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mockAttributeRegistryModel.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });
  });

  describe('GET /:indexId/browse/taxonomy', () => {
    it('returns taxonomy tree structure with expected shape', async () => {
      const taxonomy = {
        tenantId: 'tenant_123',
        indexId: 'idx_123',
        taxonomy: {
          domain: 'engineering',
          categories: [{ name: 'Issues', id: 'cat_1' }],
          products: [{ name: 'Jira', id: 'prod_1' }],
          attributes: [{ name: 'priority', id: 'attr_1' }],
        },
      };

      mockGetTaxonomy.mockResolvedValueOnce(taxonomy);

      const res = await request(app).get('/idx_123/browse/taxonomy').expect(200);

      expect(res.body.taxonomy).toBeDefined();
      expect(res.body.taxonomy.domain).toBe('engineering');
      expect(res.body.taxonomy.categories).toHaveLength(1);
      expect(res.body.taxonomy.products).toHaveLength(1);
      expect(res.body.taxonomy.attributes).toHaveLength(1);
      expect(res.body.attributeMetadata).toBeDefined();
    });

    it('returns empty taxonomy when no data exists', async () => {
      const res = await request(app).get('/idx_123/browse/taxonomy').expect(200);

      expect(res.body.taxonomy).toEqual({
        domain: null,
        categories: [],
        products: [],
        attributes: [],
      });
    });

    it('falls back to MongoDB when cache misses', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(null);
      mockTaxonomyModel.findOne.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue({
          taxonomy: {
            domain: 'support',
            categories: [],
            products: [],
            attributes: [],
          },
        }),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy').expect(200);

      expect(res.body.taxonomy.domain).toBe('support');
      expect(mockTaxonomyModel.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        indexId: 'idx_123',
      });
    });

    it('overlays attribute metadata from AttributeRegistry', async () => {
      const taxonomy = {
        taxonomy: {
          domain: 'eng',
          categories: [],
          products: [],
          attributes: [{ name: 'priority', id: 'attr_1' }],
        },
      };
      mockGetTaxonomy.mockResolvedValueOnce(taxonomy);
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([
          {
            attributeId: 'priority',
            productScope: 'jira_issue',
            displayName: 'Issue Priority',
            tier: 'permanent',
            aliases: ['pri'],
            dataType: 'string',
          },
        ]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy').expect(200);

      const attr = res.body.taxonomy.attributes[0];
      expect(attr.displayName).toBe('Issue Priority');
      expect(attr.tier).toBe('permanent');
      expect(res.body.attributeMetadata['jira_issue:priority']).toBeDefined();
    });
  });

  describe('beta tier filtering', () => {
    const taxonomyWithBetaAttr = {
      taxonomy: {
        domain: 'eng',
        categories: [],
        products: [],
        attributes: [
          { name: 'priority', id: 'attr_1' },
          { name: 'confidence', id: 'attr_2' },
        ],
      },
    };

    const permanentAttr = {
      attributeId: 'priority',
      productScope: 'jira_issue',
      displayName: 'Issue Priority',
      tier: 'permanent',
      aliases: ['pri'],
      dataType: 'string',
    };

    const betaAttr = {
      attributeId: 'confidence',
      productScope: 'jira_issue',
      displayName: 'Confidence Score',
      tier: 'beta',
      aliases: [],
      dataType: 'number',
    };

    const novelAttr = {
      attributeId: 'confidence',
      productScope: 'jira_issue',
      displayName: 'Confidence (novel)',
      tier: 'novel',
      aliases: [],
      dataType: 'number',
    };

    const discardedAttr = {
      attributeId: 'priority',
      productScope: 'slack_message',
      displayName: 'Discarded Priority',
      tier: 'discarded',
      aliases: [],
      dataType: 'string',
    };

    it('excludes beta-tier attributes by default (no param)', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      // The DB query should only get permanent+approved, so beta won't be returned
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy').expect(200);

      // Verify the query used only permanent+approved tiers
      expect(mockAttributeRegistryModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: { $in: ['permanent', 'approved'] },
        }),
      );
      // Only permanent attr in metadata
      expect(res.body.attributeMetadata['jira_issue:priority']).toBeDefined();
      expect(res.body.attributeMetadata['jira_issue:priority'].isBeta).toBe(false);
      expect(res.body.attributeMetadata['jira_issue:confidence']).toBeUndefined();
    });

    it('includes beta-tier attributes when include_beta=true', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr, betaAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy?include_beta=true').expect(200);

      // Verify the query included beta tier
      expect(mockAttributeRegistryModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: { $in: ['permanent', 'approved', 'beta'] },
        }),
      );
      // Both attrs present
      expect(res.body.attributeMetadata['jira_issue:priority']).toBeDefined();
      expect(res.body.attributeMetadata['jira_issue:confidence']).toBeDefined();
    });

    it('marks beta attributes with isBeta: true in metadata', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr, betaAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy?include_beta=true').expect(200);

      expect(res.body.attributeMetadata['jira_issue:priority'].isBeta).toBe(false);
      expect(res.body.attributeMetadata['jira_issue:confidence'].isBeta).toBe(true);
    });

    it('explicitly excludes beta when include_beta=false (regression for z.coerce.boolean bug)', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy?include_beta=false').expect(200);

      // With z.coerce.boolean(), 'false' was truthy. With z.enum transform, it's correctly false.
      expect(mockAttributeRegistryModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: { $in: ['permanent', 'approved'] },
        }),
      );
      expect(res.body.attributeMetadata['jira_issue:confidence']).toBeUndefined();
    });

    it('includes beta when include_beta=1 (alternate truthy value)', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr, betaAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy?include_beta=1').expect(200);

      expect(mockAttributeRegistryModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: { $in: ['permanent', 'approved', 'beta'] },
        }),
      );
      expect(res.body.attributeMetadata['jira_issue:confidence']).toBeDefined();
      expect(res.body.attributeMetadata['jira_issue:confidence'].isBeta).toBe(true);
    });

    it('excludes novel and discarded attributes even with include_beta=true', async () => {
      mockGetTaxonomy.mockResolvedValueOnce(taxonomyWithBetaAttr);
      // Simulate DB returning only allowed tiers (novel/discarded filtered by query)
      mockAttributeRegistryModel.find.mockReturnValueOnce({
        lean: vi.fn().mockResolvedValue([permanentAttr, betaAttr]),
      });

      const res = await request(app).get('/idx_123/browse/taxonomy?include_beta=true').expect(200);

      // Verify query did NOT include novel or discarded
      const findCall = mockAttributeRegistryModel.find.mock.calls[0][0];
      expect(findCall.tier.$in).not.toContain('novel');
      expect(findCall.tier.$in).not.toContain('discarded');

      // Only permanent + beta in metadata, no novel or discarded
      const metaKeys = Object.keys(res.body.attributeMetadata);
      expect(metaKeys).toHaveLength(2);
    });
  });

  describe('auth enforcement', () => {
    it('with valid auth, requests succeed with 200', async () => {
      const res = await request(app).get('/idx_123/browse/taxonomy');
      expect(res.status).toBe(200);
    });
  });
});
