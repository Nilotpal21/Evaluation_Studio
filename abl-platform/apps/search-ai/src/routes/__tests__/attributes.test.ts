/**
 * Attribute Admin API — Unit Tests
 *
 * Tests 7 route handlers with mocked DB/ClickHouse.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Hoisted Mocks ─────────────────────────────────────────────────────────

const { mockAttributeRegistry, mockAttributeMergeEvent, mockClickHouse, mockSearchIndex } =
  vi.hoisted(() => {
    const chainable = () => {
      const chain: Record<string, any> = {};
      chain.sort = vi.fn().mockReturnValue(chain);
      chain.skip = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.lean = vi.fn().mockResolvedValue([]);
      return chain;
    };

    return {
      mockAttributeRegistry: {
        find: vi.fn().mockImplementation(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.skip = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        }),
        findOne: vi.fn().mockImplementation(() => ({
          lean: vi.fn().mockResolvedValue(null),
        })),
        findOneAndUpdate: vi.fn().mockImplementation(() => ({
          lean: vi.fn().mockResolvedValue(null),
        })),
        countDocuments: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
        aggregate: vi.fn().mockResolvedValue([]),
      },
      mockAttributeMergeEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
      mockClickHouse: {
        command: vi.fn().mockResolvedValue({}),
      },
      mockSearchIndex: {
        findOne: vi.fn().mockImplementation(() => ({
          lean: vi.fn().mockResolvedValue({
            _id: 'index-1',
            tenantId: 'tenant-1',
            projectId: 'project-allowed',
          }),
        })),
      },
    };
  });

// ─── Module Mocks ───────────────────────────────────────────────────────────

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'AttributeRegistry') return mockAttributeRegistry;
    if (name === 'AttributeMergeEvent') return mockAttributeMergeEvent;
    if (name === 'SearchIndex') return mockSearchIndex;
    return {};
  },
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => mockClickHouse,
}));

vi.mock('../../services/reconciliation/types.js', () => ({
  DEFAULT_RECONCILIATION_CONFIG: {
    promotionDocCountMin: 50,
    promotionConfidenceMin: 0.8,
    interactionWindowDays: 14,
  },
}));

vi.mock('../../services/reconciliation/interaction-aggregator.js', () => ({
  InteractionAggregator: class MockInteractionAggregator {
    aggregateInteractions() {
      return Promise.resolve(new Map());
    }
  },
}));

import createAttributesRouter from '../attributes.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

const TENANT_ID = 'tenant-1';
const INDEX_ID = 'index-1';

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: TENANT_ID, projectScope: ['project-allowed'] };
    next();
  });
  app.use(createAttributesRouter());
  return app;
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('Attribute Admin API', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchIndex.findOne.mockImplementation(() => ({
      lean: vi.fn().mockResolvedValue({
        _id: INDEX_ID,
        tenantId: TENANT_ID,
        projectId: 'project-allowed',
      }),
    }));
    app = createApp();
  });

  // ── GET /:indexId/attributes ──────────────────────────────────────────

  describe('GET /:indexId/attributes', () => {
    test('rejects cross-project index access before attribute queries', async () => {
      mockSearchIndex.findOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });

      const res = await request(app).get(`/${INDEX_ID}/attributes`).expect(404);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(mockSearchIndex.findOne).toHaveBeenCalledWith({
        _id: INDEX_ID,
        tenantId: TENANT_ID,
        projectId: { $in: ['project-allowed'] },
      });
      expect(mockAttributeRegistry.find).not.toHaveBeenCalled();
    });

    test('returns paginated list with defaults', async () => {
      const mockData = [
        {
          _id: 'attr-1',
          attributeId: 'interest_rate',
          tier: 'novel',
          tenantId: TENANT_ID,
          indexId: INDEX_ID,
        },
      ];
      mockAttributeRegistry.find.mockImplementationOnce(() => {
        const chain: Record<string, any> = {};
        chain.sort = vi.fn().mockReturnValue(chain);
        chain.skip = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockReturnValue(chain);
        chain.lean = vi.fn().mockResolvedValue(mockData);
        return chain;
      });
      mockAttributeRegistry.countDocuments.mockResolvedValueOnce(1);

      const res = await request(app).get(`/${INDEX_ID}/attributes`).expect(200);

      expect(res.body).toEqual({ data: mockData, total: 1, page: 1, limit: 20 });
    });

    test('filters by tier', async () => {
      mockAttributeRegistry.find.mockImplementationOnce(() => {
        const chain: Record<string, any> = {};
        chain.sort = vi.fn().mockReturnValue(chain);
        chain.skip = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockReturnValue(chain);
        chain.lean = vi.fn().mockResolvedValue([]);
        return chain;
      });
      mockAttributeRegistry.countDocuments.mockResolvedValueOnce(0);

      await request(app).get(`/${INDEX_ID}/attributes?tier=novel`).expect(200);

      // First call should include tier in filter
      const filterArg = mockAttributeRegistry.find.mock.calls[0][0];
      expect(filterArg).toMatchObject({ tenantId: TENANT_ID, indexId: INDEX_ID, tier: 'novel' });
    });

    test('applies search filter with $or', async () => {
      mockAttributeRegistry.find.mockImplementationOnce(() => {
        const chain: Record<string, any> = {};
        chain.sort = vi.fn().mockReturnValue(chain);
        chain.skip = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockReturnValue(chain);
        chain.lean = vi.fn().mockResolvedValue([]);
        return chain;
      });
      mockAttributeRegistry.countDocuments.mockResolvedValueOnce(0);

      await request(app).get(`/${INDEX_ID}/attributes?search=rate`).expect(200);

      const filterArg = mockAttributeRegistry.find.mock.calls[0][0];
      expect(filterArg.$or).toBeDefined();
      expect(filterArg.$or).toHaveLength(3);
    });

    test('rejects invalid tier', async () => {
      const res = await request(app).get(`/${INDEX_ID}/attributes?tier=invalid`).expect(400);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /:indexId/attributes/review-queue ─────────────────────────────

  describe('GET /:indexId/attributes/review-queue', () => {
    test('returns review queue structure', async () => {
      // First call: placementReview, Second call: allAttrs
      mockAttributeRegistry.find
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        })
        .mockImplementationOnce(() => ({
          lean: vi.fn().mockResolvedValue([]),
        }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/review-queue`).expect(200);

      expect(res.body).toHaveProperty('mergeConflicts');
      expect(res.body).toHaveProperty('placementReview');
      expect(res.body).toHaveProperty('typeConflicts');
      expect(res.body).toHaveProperty('total');
    });

    test('detects merge conflicts', async () => {
      mockAttributeRegistry.find
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        })
        .mockImplementationOnce(() => ({
          lean: vi.fn().mockResolvedValue([
            {
              attributeId: 'rate',
              displayName: 'Interest Rate',
              dataType: 'percentage',
              productScope: 'credit_card',
            },
            {
              attributeId: 'rate',
              displayName: 'Rate of Return',
              dataType: 'percentage',
              productScope: 'savings',
            },
          ]),
        }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/review-queue`).expect(200);

      expect(res.body.mergeConflicts).toHaveLength(1);
      expect(res.body.mergeConflicts[0].attributeId).toBe('rate');
    });
  });

  // ── GET /:indexId/attributes/stats ────────────────────────────────────

  describe('GET /:indexId/attributes/stats', () => {
    test('returns tier distribution', async () => {
      mockAttributeRegistry.aggregate.mockResolvedValueOnce([
        { _id: 'novel', count: 5 },
        { _id: 'approved', count: 10 },
      ]);
      mockAttributeRegistry.find
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        });

      const res = await request(app).get(`/${INDEX_ID}/attributes/stats`).expect(200);

      expect(res.body.byTier).toEqual({ novel: 5, approved: 10 });
      expect(res.body).toHaveProperty('recentPromotions');
      expect(res.body).toHaveProperty('recentDemotions');
      expect(res.body).toHaveProperty('interactionStats');
    });
  });

  // ── GET /:indexId/attributes/:id ──────────────────────────────────────

  describe('GET /:indexId/attributes/:id', () => {
    test('returns single attribute', async () => {
      const mockAttr = {
        _id: 'attr-1',
        attributeId: 'interest_rate',
        tier: 'novel',
        tenantId: TENANT_ID,
        indexId: INDEX_ID,
      };
      mockAttributeRegistry.findOne.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(mockAttr),
      }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/attr-1`).expect(200);

      expect(res.body.data).toEqual(mockAttr);
    });

    test('returns 404 for non-existent attribute', async () => {
      mockAttributeRegistry.findOne.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(null),
      }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/nonexistent`).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('cross-tenant access returns 404', async () => {
      // findOne with wrong tenantId in query will return null
      mockAttributeRegistry.findOne.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(null),
      }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/attr-1`).expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
      // Verify the query included tenantId
      const findCall = mockAttributeRegistry.findOne.mock.calls[0][0];
      expect(findCall.tenantId).toBe(TENANT_ID);
    });
  });

  // ── PATCH /:indexId/attributes/:id ────────────────────────────────────

  describe('PATCH /:indexId/attributes/:id', () => {
    test('updates tier and sets discoverySource to admin_manual', async () => {
      const updatedAttr = {
        _id: 'attr-1',
        tier: 'approved',
        discoverySource: 'admin_manual',
      };
      mockAttributeRegistry.findOneAndUpdate.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(updatedAttr),
      }));

      const res = await request(app)
        .patch(`/${INDEX_ID}/attributes/attr-1`)
        .send({ tier: 'approved' })
        .expect(200);

      expect(res.body.data.tier).toBe('approved');
      // Verify the $set includes discoverySource
      const updateCall = mockAttributeRegistry.findOneAndUpdate.mock.calls[0];
      expect(updateCall[1].$set.discoverySource).toBe('admin_manual');
    });

    test('updates displayName without setting discoverySource', async () => {
      const updatedAttr = { _id: 'attr-1', displayName: 'New Name' };
      mockAttributeRegistry.findOneAndUpdate.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(updatedAttr),
      }));

      const res = await request(app)
        .patch(`/${INDEX_ID}/attributes/attr-1`)
        .send({ displayName: 'New Name' })
        .expect(200);

      expect(res.body.data.displayName).toBe('New Name');
      const updateCall = mockAttributeRegistry.findOneAndUpdate.mock.calls[0];
      expect(updateCall[1].$set.discoverySource).toBeUndefined();
    });

    test('returns 404 for non-existent attribute', async () => {
      mockAttributeRegistry.findOneAndUpdate.mockImplementationOnce(() => ({
        lean: vi.fn().mockResolvedValue(null),
      }));

      await request(app)
        .patch(`/${INDEX_ID}/attributes/nonexistent`)
        .send({ tier: 'approved' })
        .expect(404);
    });

    test('rejects invalid body', async () => {
      const res = await request(app)
        .patch(`/${INDEX_ID}/attributes/attr-1`)
        .send({ tier: 'invalid_tier' })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── POST /:indexId/attributes/bulk ────────────────────────────────────

  describe('POST /:indexId/attributes/bulk', () => {
    test('bulk approve sets tier=approved', async () => {
      mockAttributeRegistry.updateMany.mockResolvedValueOnce({ modifiedCount: 3 });

      const res = await request(app)
        .post(`/${INDEX_ID}/attributes/bulk`)
        .send({ action: 'approve', attributeIds: ['a1', 'a2', 'a3'] })
        .expect(200);

      expect(res.body.updated).toBe(3);
      const updateCall = mockAttributeRegistry.updateMany.mock.calls[0];
      expect(updateCall[1].$set.tier).toBe('approved');
      expect(updateCall[1].$set.discoverySource).toBe('admin_manual');
    });

    test('bulk discard sets tier=discarded', async () => {
      mockAttributeRegistry.updateMany.mockResolvedValueOnce({ modifiedCount: 2 });

      const res = await request(app)
        .post(`/${INDEX_ID}/attributes/bulk`)
        .send({ action: 'discard', attributeIds: ['a1', 'a2'] })
        .expect(200);

      expect(res.body.updated).toBe(2);
      const updateCall = mockAttributeRegistry.updateMany.mock.calls[0];
      expect(updateCall[1].$set.tier).toBe('discarded');
    });

    test('changeTier requires targetTier', async () => {
      const res = await request(app)
        .post(`/${INDEX_ID}/attributes/bulk`)
        .send({ action: 'changeTier', attributeIds: ['a1'] })
        .expect(400);

      expect(res.body.error.code).toBe('MISSING_TARGET_TIER');
    });

    test('changeTier with targetTier succeeds', async () => {
      mockAttributeRegistry.updateMany.mockResolvedValueOnce({ modifiedCount: 1 });

      const res = await request(app)
        .post(`/${INDEX_ID}/attributes/bulk`)
        .send({ action: 'changeTier', attributeIds: ['a1'], targetTier: 'beta' })
        .expect(200);

      expect(res.body.updated).toBe(1);
      const updateCall = mockAttributeRegistry.updateMany.mock.calls[0];
      expect(updateCall[1].$set.tier).toBe('beta');
    });
  });

  // ── POST /:indexId/attributes/merge ───────────────────────────────────

  describe('POST /:indexId/attributes/merge', () => {
    test('merges two attributes successfully', async () => {
      const source = {
        _id: 'src-1',
        attributeId: 'rate',
        productScope: 'credit_card',
        aliases: ['apr'],
        documentCount: 10,
        tenantId: TENANT_ID,
        indexId: INDEX_ID,
      };
      const target = {
        _id: 'tgt-1',
        attributeId: 'interest_rate',
        productScope: 'credit_card',
        aliases: [],
        documentCount: 20,
        tenantId: TENANT_ID,
        indexId: INDEX_ID,
      };
      const merged = { ...target, aliases: ['rate'], documentCount: 30 };

      mockAttributeRegistry.findOne
        .mockImplementationOnce(() => ({ lean: vi.fn().mockResolvedValue(source) }))
        .mockImplementationOnce(() => ({ lean: vi.fn().mockResolvedValue(target) }))
        .mockImplementationOnce(() => ({ lean: vi.fn().mockResolvedValue(merged) }));

      const res = await request(app)
        .post(`/${INDEX_ID}/attributes/merge`)
        .send({ sourceId: 'src-1', targetId: 'tgt-1', primaryId: 'tgt-1' })
        .expect(200);

      expect(res.body.data).toEqual(merged);
      expect(res.body.meta.clickhouseMutationPending).toBe(true);

      // Verify secondary was discarded
      const discardCall = mockAttributeRegistry.updateOne.mock.calls.find(
        (c: any[]) => c[0]._id === 'src-1',
      );
      expect(discardCall?.[1].$set.tier).toBe('discarded');

      // Verify merge event was created
      expect(mockAttributeMergeEvent.create).toHaveBeenCalledOnce();
    });

    test('returns 404 when source not found', async () => {
      mockAttributeRegistry.findOne
        .mockImplementationOnce(() => ({ lean: vi.fn().mockResolvedValue(null) }))
        .mockImplementationOnce(() => ({
          lean: vi.fn().mockResolvedValue({ _id: 'tgt-1' }),
        }));

      await request(app)
        .post(`/${INDEX_ID}/attributes/merge`)
        .send({ sourceId: 'bad', targetId: 'tgt-1', primaryId: 'tgt-1' })
        .expect(404);
    });
  });

  // ── Static routes are not captured by /:id ────────────────────────────

  describe('Route ordering', () => {
    test('review-queue is not captured by /:id', async () => {
      mockAttributeRegistry.find
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        })
        .mockImplementationOnce(() => ({
          lean: vi.fn().mockResolvedValue([]),
        }));

      const res = await request(app).get(`/${INDEX_ID}/attributes/review-queue`).expect(200);

      // Should return review queue structure, not a 404 from handleGetOne
      expect(res.body).toHaveProperty('mergeConflicts');
    });

    test('stats is not captured by /:id', async () => {
      mockAttributeRegistry.aggregate.mockResolvedValueOnce([]);
      mockAttributeRegistry.find
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: Record<string, any> = {};
          chain.sort = vi.fn().mockReturnValue(chain);
          chain.limit = vi.fn().mockReturnValue(chain);
          chain.lean = vi.fn().mockResolvedValue([]);
          return chain;
        });

      const res = await request(app).get(`/${INDEX_ID}/attributes/stats`).expect(200);

      expect(res.body).toHaveProperty('byTier');
    });
  });
});

// ─── Auto-Promoter Guard Tests ──────────────────────────────────────────────

describe('Auto-Promoter admin_manual guard', () => {
  test('returns keep for admin_manual discoverySource', async () => {
    // Import the real evaluatePromotion (not mocked)
    const { evaluatePromotion } = await import('../../services/reconciliation/auto-promoter.js');
    const { DEFAULT_RECONCILIATION_CONFIG } =
      await import('../../services/reconciliation/types.js');

    const attr = {
      _id: 'attr-1',
      tenantId: TENANT_ID,
      indexId: INDEX_ID,
      attributeId: 'test_attr',
      productScope: 'product-1',
      tier: 'novel' as const,
      displayName: 'Test',
      dataType: 'string',
      aliases: [],
      extractionPatterns: [],
      discoverySource: 'admin_manual' as const,
      documentCount: 100,
      confidence: 0.95,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const decision = evaluatePromotion(attr, DEFAULT_RECONCILIATION_CONFIG);
    expect(decision.action).toBe('keep');
    expect(decision.reason).toContain('admin_manual');
  });
});
