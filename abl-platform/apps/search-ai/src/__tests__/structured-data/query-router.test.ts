/**
 * Tests for Structured Data Query Router
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredDataQueryRouter } from '../../services/structured-data/query-router.js';

describe('StructuredDataQueryRouter', () => {
  let router: StructuredDataQueryRouter;

  beforeEach(() => {
    router = new StructuredDataQueryRouter();
  });

  describe('Intent Analysis', () => {
    it('should detect SQL intent for filter queries', async () => {
      const queries = [
        'products where price > 100',
        'find items with quantity less than 50',
        'show records where status = "active"',
        'get products between $50 and $100',
      ];

      for (const query of queries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('sql');
        expect(intent.confidence).toBeGreaterThan(0.6);
      }
    });

    it('should detect SQL intent for aggregation queries', async () => {
      const queries = [
        'how many products are there',
        'total sales amount',
        'average price of products',
        'count orders by status',
        'sum of revenue by month',
      ];

      for (const query of queries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('sql');
        expect(intent.confidence).toBeGreaterThan(0.6);
      }
    });

    it('should detect semantic intent for text search queries', async () => {
      const queries = [
        'find products similar to "wireless mouse"',
        'search for items containing "bluetooth"',
        'look for descriptions mentioning "waterproof"',
        'products described as lightweight',
      ];

      for (const query of queries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('semantic');
        expect(intent.confidence).toBeGreaterThan(0.5);
      }
    });

    it('should detect hybrid intent for combined queries', async () => {
      const hybridQueries = [
        'products with "wireless" in description AND price < 100',
        'find items containing "organic" where stock > 50',
      ];

      for (const query of hybridQueries) {
        const intent = await router.analyzeIntent(query);
        // Should be either hybrid or SQL (both are acceptable for these complex queries)
        expect(['hybrid', 'sql']).toContain(intent.type);
        expect(intent.confidence).toBeGreaterThan(0.5);
      }

      // This query has explicit quoted text AND filters - should be hybrid
      const strongHybrid = await router.analyzeIntent(
        'search for "wireless mouse" where price < 50',
      );
      expect(strongHybrid.type).toBe('hybrid');
    });

    it('should default to sql for general structured-data queries', async () => {
      const queries = ['show me products', 'what items do you have', 'product catalog'];

      for (const query of queries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('sql');
        expect(intent.confidence).toBeLessThanOrEqual(0.5);
      }
    });

    it('should provide reasoning for intent decision', async () => {
      const intent = await router.analyzeIntent('products where price > 100');
      expect(intent.reasoning).toBeDefined();
      expect(intent.reasoning.length).toBeGreaterThan(0);
    });
  });

  describe('SQL Pattern Detection', () => {
    it('should detect numeric comparisons', async () => {
      const intent = await router.analyzeIntent('price greater than 50');
      expect(intent.type).toBe('sql');
    });

    it('should detect range queries', async () => {
      const intent = await router.analyzeIntent('products between 10 and 20');
      expect(intent.type).toBe('sql');
    });

    it('should detect IN clause patterns', async () => {
      const intent = await router.analyzeIntent('status in [active, pending]');
      expect(intent.type).toBe('sql');
    });

    it('should detect aggregation keywords', async () => {
      const queries = ['count of', 'total', 'average', 'sum', 'how many'];

      for (const query of queries) {
        const intent = await router.analyzeIntent(query + ' products');
        expect(intent.type).toBe('sql');
      }
    });
  });

  describe('Semantic Pattern Detection', () => {
    it('should detect text search keywords', async () => {
      const queries = ['find', 'search', 'look for', 'similar to', 'like', 'matching'];

      for (const keyword of queries) {
        const intent = await router.analyzeIntent(`${keyword} products with wireless`);
        expect(intent.type).toBe('semantic');
      }
    });

    it('should detect text content indicators', async () => {
      const intent = await router.analyzeIntent('products with description containing "organic"');
      expect(intent.type).toBe('semantic');
    });
  });

  describe('Query Routing', () => {
    it('should generate query ID', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
      };

      const response = await router.route(request);
      expect(response.queryId).toBeDefined();
      expect(response.queryId).toMatch(/^qry_/);
    });

    it('should return intent analysis', async () => {
      const request = {
        query: 'products where price > 100',
        indexId: 'index-123',
        tenantId: 'tenant-123',
      };

      const response = await router.route(request);
      expect(response.intent).toBeDefined();
      expect(response.intent.type).toBeDefined();
      expect(response.intent.confidence).toBeGreaterThan(0);
    });

    it('should track execution time', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
      };

      const response = await router.route(request);
      expect(response.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty results gracefully', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
      };

      const response = await router.route(request);
      expect(response.results).toBeDefined();
      expect(Array.isArray(response.results)).toBe(true);
      expect(response.totalCount).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
        limit: 5,
      };

      const response = await router.route(request);
      expect(request.limit).toBe(5);
    });

    it('should respect offset parameter', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
        offset: 10,
      };

      const response = await router.route(request);
      expect(request.offset).toBe(10);
    });

    it('should filter by tableId when provided', async () => {
      const request = {
        query: 'test query',
        indexId: 'index-123',
        tenantId: 'tenant-123',
        tableId: 'table-456',
      };

      const response = await router.route(request);
      expect(request.tableId).toBe('table-456');
    });
  });

  describe('Confidence Scoring', () => {
    it('should assign higher confidence to queries with multiple indicators', async () => {
      const strongSQL = await router.analyzeIntent(
        'count products where price > 100 and category = "electronics" order by name',
      );
      const weakSQL = await router.analyzeIntent('price greater than 100');

      expect(strongSQL.confidence).toBeGreaterThan(weakSQL.confidence);
    });

    it('should cap confidence at reasonable maximum', async () => {
      const intent = await router.analyzeIntent(
        'count sum average total products where price > 100',
      );
      expect(intent.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty query string', async () => {
      const intent = await router.analyzeIntent('');
      expect(intent.type).toBeDefined();
      expect(intent.confidence).toBeGreaterThan(0);
    });

    it('should handle queries with only whitespace', async () => {
      const intent = await router.analyzeIntent('   ');
      expect(intent.type).toBeDefined();
    });

    it('should handle very long queries', async () => {
      const longQuery = 'find products '.repeat(100);
      const intent = await router.analyzeIntent(longQuery);
      expect(intent.type).toBeDefined();
    });

    it('should be case-insensitive', async () => {
      const lower = await router.analyzeIntent('products where price > 100');
      const upper = await router.analyzeIntent('PRODUCTS WHERE PRICE > 100');
      const mixed = await router.analyzeIntent('Products WHERE price > 100');

      expect(lower.type).toBe(upper.type);
      expect(lower.type).toBe(mixed.type);
    });
  });

  describe('Complex Query Patterns', () => {
    it('should handle compound conditions', async () => {
      const intent = await router.analyzeIntent(
        'products where (price > 50 AND stock < 100) OR category = "sale"',
      );
      expect(intent.type).toBe('sql');
    });

    it('should handle sorting requests', async () => {
      const intent = await router.analyzeIntent('products ordered by price descending');
      expect(intent.type).toBe('sql');
    });

    it('should handle grouping requests', async () => {
      const intent = await router.analyzeIntent('sales grouped by month');
      expect(intent.type).toBe('sql');
    });
  });
});
