/**
 * Tenant Isolation Integration Tests
 *
 * CRITICAL: These tests verify that tenant isolation is enforced across all
 * new models and services introduced in RFC-001.
 *
 * Security Requirements:
 * 1. All queries must include { tenantId } filter
 * 2. Cross-tenant access returns 404 (not 403)
 * 3. No findById() calls (must use findOne({ _id, tenantId }))
 * 4. Data never leaks across tenant boundaries
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getLazyModel, initMongoBackend } from '../../db/index.js';
import type { IKnowledgeGraphDomain, ITaxonomyHealthCache } from '@agent-platform/database';
import { withTenantContext } from '@agent-platform/database/mongo';

describe('Tenant Isolation - RFC-001 Models', () => {
  const TENANT_A = 'tenant-a-test';
  const TENANT_B = 'tenant-b-test';
  const USER_A = 'user-a-test';
  const USER_B = 'user-b-test';

  beforeAll(async () => {
    // Initialize dual-database connection (binds models to registry)
    await initMongoBackend({
      platformDb: {
        uri: process.env.MONGODB_URL || 'mongodb://localhost:27018/abl_platform',
        connectionOptions: {},
      },
      contentDb: {
        uri: process.env.MONGODB_URL || 'mongodb://localhost:27018/search_ai',
        connectionOptions: {},
      },
    });

    // Ensure test database is clean
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');
    const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

    await Promise.all([
      KnowledgeGraphDomain.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } }),
      TaxonomyHealthCache.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } }),
    ]);
  });

  afterAll(async () => {
    // Clean up test data
    const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');
    const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

    await Promise.all([
      KnowledgeGraphDomain.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } }),
      TaxonomyHealthCache.deleteMany({ tenantId: { $in: [TENANT_A, TENANT_B] } }),
    ]);
  });

  describe('KnowledgeGraphDomain Isolation', () => {
    let domainIdA: string;
    let domainIdB: string;

    beforeEach(async () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

      // Create domain for tenant A
      const domainA = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await KnowledgeGraphDomain.create({
          tenantId: TENANT_A,
          name: 'test-domain-a',
          version: '1.0.0',
          industry: 'Test A',
          categories: [{ id: 'cat-a', name: 'Category A', department: 'Dept A' }],
          products: [
            {
              id: 'prod-a',
              name: 'Product A',
              categoryId: 'cat-a',
              department: 'Dept A',
              subDepartment: 'Sub A',
              disambiguationKeywords: [],
              organizationSpecificNames: [],
            },
          ],
          attributes: [
            {
              id: 'attr-a',
              name: 'Attribute A',
              dataType: 'string',
              applicableTo: [],
              notApplicableTo: [],
              extraction: { method: 'llm', keywords: ['test'] },
            },
          ],
          departmentBoundaries: [],
          createdBy: USER_A,
        });
      });
      domainIdA = domainA._id;

      // Create domain for tenant B
      const domainB = await withTenantContext({ tenantId: TENANT_B }, async () => {
        return await KnowledgeGraphDomain.create({
          tenantId: TENANT_B,
          name: 'test-domain-b',
          version: '1.0.0',
          industry: 'Test B',
          categories: [{ id: 'cat-b', name: 'Category B', department: 'Dept B' }],
          products: [
            {
              id: 'prod-b',
              name: 'Product B',
              categoryId: 'cat-b',
              department: 'Dept B',
              subDepartment: 'Sub B',
              disambiguationKeywords: [],
              organizationSpecificNames: [],
            },
          ],
          attributes: [
            {
              id: 'attr-b',
              name: 'Attribute B',
              dataType: 'string',
              applicableTo: [],
              notApplicableTo: [],
              extraction: { method: 'llm', keywords: ['test'] },
            },
          ],
          departmentBoundaries: [],
          createdBy: USER_B,
        });
      });
      domainIdB = domainB._id;
    });

    it('lists only domains for the correct tenant', async () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

      // Tenant A should see only their domain
      const domainsA = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await KnowledgeGraphDomain.find({ tenantId: TENANT_A }).exec();
      });

      expect(domainsA).toHaveLength(1);
      expect(domainsA[0]._id).toBe(domainIdA);
      expect(domainsA[0].name).toBe('test-domain-a');

      // Tenant B should see only their domain
      const domainsB = await withTenantContext({ tenantId: TENANT_B }, async () => {
        return await KnowledgeGraphDomain.find({ tenantId: TENANT_B }).exec();
      });

      expect(domainsB).toHaveLength(1);
      expect(domainsB[0]._id).toBe(domainIdB);
      expect(domainsB[0].name).toBe('test-domain-b');
    });

    it('returns null when tenant A tries to access tenant B domain by ID', async () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

      // Tenant A tries to access Tenant B's domain
      const domain = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await KnowledgeGraphDomain.findOne({ _id: domainIdB, tenantId: TENANT_A }).exec();
      });

      // Should return null (not found), not throw 403
      expect(domain).toBeNull();
    });

    it('enforces unique domain name per tenant (not globally)', async () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');

      // Both tenants can have a domain with the same name
      await expect(
        withTenantContext({ tenantId: TENANT_A }, async () => {
          return await KnowledgeGraphDomain.create({
            tenantId: TENANT_A,
            name: 'shared-name',
            version: '1.0.0',
            industry: 'Test',
            categories: [{ id: 'cat', name: 'Cat', department: 'Dept' }],
            products: [
              {
                id: 'prod',
                name: 'Prod',
                categoryId: 'cat',
                department: 'Dept',
                subDepartment: 'Sub',
                disambiguationKeywords: [],
                organizationSpecificNames: [],
              },
            ],
            attributes: [
              {
                id: 'attr',
                name: 'Attr',
                dataType: 'string',
                applicableTo: [],
                notApplicableTo: [],
                extraction: { method: 'llm', keywords: ['test'] },
              },
            ],
            departmentBoundaries: [],
            createdBy: USER_A,
          });
        }),
      ).resolves.toBeDefined();

      await expect(
        withTenantContext({ tenantId: TENANT_B }, async () => {
          return await KnowledgeGraphDomain.create({
            tenantId: TENANT_B,
            name: 'shared-name',
            version: '1.0.0',
            industry: 'Test',
            categories: [{ id: 'cat', name: 'Cat', department: 'Dept' }],
            products: [
              {
                id: 'prod',
                name: 'Prod',
                categoryId: 'cat',
                department: 'Dept',
                subDepartment: 'Sub',
                disambiguationKeywords: [],
                organizationSpecificNames: [],
              },
            ],
            attributes: [
              {
                id: 'attr',
                name: 'Attr',
                dataType: 'string',
                applicableTo: [],
                notApplicableTo: [],
                extraction: { method: 'llm', keywords: ['test'] },
              },
            ],
            departmentBoundaries: [],
            createdBy: USER_B,
          });
        }),
      ).resolves.toBeDefined();

      // But same tenant cannot have duplicate name
      await expect(
        withTenantContext({ tenantId: TENANT_A }, async () => {
          return await KnowledgeGraphDomain.create({
            tenantId: TENANT_A,
            name: 'shared-name',
            version: '1.0.0',
            industry: 'Test',
            categories: [{ id: 'cat', name: 'Cat', department: 'Dept' }],
            products: [
              {
                id: 'prod',
                name: 'Prod',
                categoryId: 'cat',
                department: 'Dept',
                subDepartment: 'Sub',
                disambiguationKeywords: [],
                organizationSpecificNames: [],
              },
            ],
            attributes: [
              {
                id: 'attr',
                name: 'Attr',
                dataType: 'string',
                applicableTo: [],
                notApplicableTo: [],
                extraction: { method: 'llm', keywords: ['test'] },
              },
            ],
            departmentBoundaries: [],
            createdBy: USER_A,
          });
        }),
      ).rejects.toThrow(); // Unique constraint violation
    });
  });

  describe('TaxonomyHealthCache Isolation', () => {
    let indexIdA: string;
    let indexIdB: string;

    beforeEach(async () => {
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      indexIdA = 'index-a-test';
      indexIdB = 'index-b-test';

      // Create cache for tenant A
      await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await TaxonomyHealthCache.create({
          tenantId: TENANT_A,
          indexId: indexIdA,
          signals: {
            totalDocuments: 100,
            classifiedDocuments: 80,
            unclassifiedDocuments: 20,
            lowConfidenceDocuments: 10,
            productDistribution: { 'prod-a': 50, 'prod-b': 30 },
            avgConfidenceByProduct: { 'prod-a': 0.85, 'prod-b': 0.75 },
            topUnclassifiedTerms: [{ term: 'term-a', frequency: 15 }],
            suspiciousPatterns: [{ pattern: 'pattern-a', count: 5 }],
          },
          computedAt: new Date(),
        });
      });

      // Create cache for tenant B
      await withTenantContext({ tenantId: TENANT_B }, async () => {
        return await TaxonomyHealthCache.create({
          tenantId: TENANT_B,
          indexId: indexIdB,
          signals: {
            totalDocuments: 200,
            classifiedDocuments: 180,
            unclassifiedDocuments: 20,
            lowConfidenceDocuments: 5,
            productDistribution: { 'prod-c': 100, 'prod-d': 80 },
            avgConfidenceByProduct: { 'prod-c': 0.9, 'prod-d': 0.88 },
            topUnclassifiedTerms: [{ term: 'term-b', frequency: 10 }],
            suspiciousPatterns: [{ pattern: 'pattern-b', count: 2 }],
          },
          computedAt: new Date(),
        });
      });
    });

    it('returns cache only for correct tenant and index', async () => {
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      // Tenant A retrieves their cache
      const cacheA = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await TaxonomyHealthCache.findOne({ tenantId: TENANT_A, indexId: indexIdA }).exec();
      });

      expect(cacheA).toBeDefined();
      expect(cacheA!.signals.totalDocuments).toBe(100);

      // Tenant B retrieves their cache
      const cacheB = await withTenantContext({ tenantId: TENANT_B }, async () => {
        return await TaxonomyHealthCache.findOne({ tenantId: TENANT_B, indexId: indexIdB }).exec();
      });

      expect(cacheB).toBeDefined();
      expect(cacheB!.signals.totalDocuments).toBe(200);
    });

    it('returns null when tenant A tries to access tenant B cache', async () => {
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      const cache = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await TaxonomyHealthCache.findOne({ tenantId: TENANT_A, indexId: indexIdB }).exec();
      });

      expect(cache).toBeNull();
    });

    it('quality signals do not leak across tenants', async () => {
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      // Get all caches for tenant A
      const cachesA = await withTenantContext({ tenantId: TENANT_A }, async () => {
        return await TaxonomyHealthCache.find({ tenantId: TENANT_A }).exec();
      });

      // Should only see tenant A's data
      expect(cachesA).toHaveLength(1);
      expect(cachesA[0].signals.productDistribution).toHaveProperty('prod-a');
      expect(cachesA[0].signals.productDistribution).not.toHaveProperty('prod-c');
    });
  });

  describe('Code Quality - No findById() Usage', () => {
    it('verifies no findById() calls in new model files', async () => {
      const { execSync } = await import('child_process');

      // Grep for findById in new model files
      const files = [
        'packages/database/src/models/knowledge-graph-domain.model.ts',
        'packages/database/src/models/taxonomy-health-cache.model.ts',
        'apps/search-ai/src/services/audit-logger.ts',
      ];

      for (const file of files) {
        try {
          const output = execSync(`grep -n "findById" ${file}`, { encoding: 'utf-8' });
          // If grep finds matches, fail the test
          expect(output).toBe(''); // Should be empty
        } catch (error: any) {
          // grep returns exit code 1 when no matches found (expected)
          if (error.status !== 1) {
            throw error;
          }
          // Status 1 means no matches, which is what we want
          expect(error.status).toBe(1);
        }
      }
    });
  });

  describe('Cross-Cutting Concerns', () => {
    it('all new models have tenantId field', () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      // Check schema paths include tenantId
      expect(KnowledgeGraphDomain.schema.paths).toHaveProperty('tenantId');
      expect(TaxonomyHealthCache.schema.paths).toHaveProperty('tenantId');
    });

    it('all new models have tenant-scoped indexes', () => {
      const KnowledgeGraphDomain = getLazyModel<IKnowledgeGraphDomain>('KnowledgeGraphDomain');
      const TaxonomyHealthCache = getLazyModel<ITaxonomyHealthCache>('TaxonomyHealthCache');

      // Check indexes include tenantId
      const domainIndexes = KnowledgeGraphDomain.schema.indexes();
      const cacheIndexes = TaxonomyHealthCache.schema.indexes();

      // All should have at least one index with tenantId
      expect(domainIndexes.some((idx) => idx[0].tenantId)).toBe(true);
      expect(cacheIndexes.some((idx) => idx[0].tenantId)).toBe(true);
    });
  });
});
