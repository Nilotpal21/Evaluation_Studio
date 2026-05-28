/**
 * Tests for Table Discovery Service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TableDiscoveryService } from '../../services/structured-data/table-discovery.js';
import type { TableMetadata } from '../../services/structured-data/types.js';
import type { StructuredDataClickHouseClient } from '../../services/structured-data/clickhouse-client.js';

// Mock SearchChunk model via getLazyModel (dual-DB routing)
const { mockSearchChunk } = vi.hoisted(() => ({
  mockSearchChunk: {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'SearchChunk') return mockSearchChunk;
    return {};
  },
}));

// Mock ClickHouse client
class MockClickHouseClient {
  private mockTables: TableMetadata[] = [];

  setMockTables(tables: TableMetadata[]) {
    this.mockTables = tables;
  }

  async getTableMetadata(
    tenantId: string,
    indexId: string,
    tableName?: string,
  ): Promise<TableMetadata[]> {
    if (tableName) {
      return this.mockTables.filter((t) => t.table_name === tableName);
    }
    return this.mockTables;
  }

  async initialize() {}
}

describe('TableDiscoveryService', () => {
  let service: TableDiscoveryService;
  let mockCHClient: MockClickHouseClient;

  beforeEach(() => {
    mockCHClient = new MockClickHouseClient();
    service = new TableDiscoveryService(mockCHClient as any as StructuredDataClickHouseClient);
  });

  // ==========================================================================
  // HELPER: Create mock table metadata
  // ==========================================================================

  function createMockTable(
    tableName: string,
    displayName: string,
    description: string,
    columns: string[],
  ): TableMetadata {
    return {
      table_id: `table-${tableName}`,
      table_name: tableName,
      display_name: displayName,
      tenant_id: 'tenant-123',
      index_id: 'index-123',
      columns: JSON.stringify(columns),
      column_types: JSON.stringify(columns.map(() => 'string')),
      primary_key: 'id',
      row_count: 100,
      table_description: description,
      column_descriptions: JSON.stringify({}),
      statistics: '{}',
      sample_rows: '[]',
      foreign_keys: '[]',
      searchable_text: `${tableName} ${displayName} ${description} ${columns.join(' ')}`,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  // ==========================================================================
  // SINGLE TABLE DISCOVERY
  // ==========================================================================

  describe('Single Table Discovery', () => {
    it('should discover exact table name match', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
        createMockTable('orders', 'Orders', 'Customer orders', ['id', 'customer', 'total']),
      ]);

      const result = await service.discoverTables({
        query: 'products',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].metadata.table_name).toBe('products');
      expect(result.tables[0].relevanceScore).toBeGreaterThan(0.9);
      expect(result.queryAnalysis.intent).toBe('single_table');
    });

    it('should discover table by description keywords', async () => {
      mockCHClient.setMockTables([
        createMockTable('inventory', 'Inventory', 'Product stock levels', [
          'id',
          'product',
          'quantity',
        ]),
        createMockTable('orders', 'Orders', 'Customer orders', ['id', 'customer', 'total']),
      ]);

      const result = await service.discoverTables({
        query: 'stock levels',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].metadata.table_name).toBe('inventory');
      expect(result.tables[0].relevanceScore).toBeGreaterThan(0.3);
    });

    it('should discover table by column names', async () => {
      mockCHClient.setMockTables([
        createMockTable('customers', 'Customers', 'Customer data', ['id', 'email', 'phone']),
      ]);

      const result = await service.discoverTables({
        query: 'customer email',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].metadata.table_name).toBe('customers');
      expect(result.tables[0].relevanceScore).toBeGreaterThan(0.3);
    });

    it('should return empty result when no tables match', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
      ]);

      const result = await service.discoverTables({
        query: 'nonexistent_table',
        tenantId: 'tenant-123',
        indexId: 'index-123',
        minRelevanceScore: 0.5,
      });

      expect(result.tables).toHaveLength(0);
      expect(result.totalAvailable).toBe(1);
    });
  });

  // ==========================================================================
  // MULTI-TABLE DISCOVERY
  // ==========================================================================

  describe('Multi-Table Discovery', () => {
    it('should discover multiple relevant tables', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
        createMockTable('product_reviews', 'Reviews', 'Product reviews', [
          'id',
          'product_id',
          'rating',
        ]),
        createMockTable('customers', 'Customers', 'Customer data', ['id', 'name', 'email']),
      ]);

      const result = await service.discoverTables({
        query: 'products',
        tenantId: 'tenant-123',
        indexId: 'index-123',
        maxTables: 10,
      });

      expect(result.tables.length).toBeGreaterThan(1);
      expect(result.tables[0].metadata.table_name).toBe('products'); // Exact match first
      expect(result.tables[1].metadata.table_name).toBe('product_reviews'); // Partial match second
    });

    it('should detect multi-table join intent', async () => {
      mockCHClient.setMockTables([
        createMockTable('orders', 'Orders', 'Customer orders', ['id', 'customer_id', 'total']),
        createMockTable('customers', 'Customers', 'Customer data', ['id', 'name', 'email']),
      ]);

      const result = await service.discoverTables({
        query: 'join orders and customers',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.tables.length).toBeGreaterThan(1);
      expect(result.queryAnalysis.intent).toBe('multi_table');
    });

    it('should respect maxTables limit', async () => {
      const tables = Array.from({ length: 10 }, (_, i) =>
        createMockTable(`table_${i}`, `Table ${i}`, `Description for table ${i}`, ['id', 'data']),
      );
      mockCHClient.setMockTables(tables);

      const result = await service.discoverTables({
        query: 'table',
        tenantId: 'tenant-123',
        indexId: 'index-123',
        maxTables: 3,
      });

      expect(result.tables).toHaveLength(3);
      expect(result.totalAvailable).toBe(10);
    });

    it('should rank tables by relevance', async () => {
      mockCHClient.setMockTables([
        createMockTable('customer_orders', 'Customer Orders', 'Orders placed by customers', ['id']),
        createMockTable('orders', 'Orders', 'Order records', ['id', 'customer_id']),
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
      ]);

      const result = await service.discoverTables({
        query: 'orders',
        tenantId: 'tenant-123',
        indexId: 'index-123',
        maxTables: 3,
      });

      // Exact match 'orders' should be first
      expect(result.tables[0].metadata.table_name).toBe('orders');
      expect(result.tables[0].relevanceScore).toBeGreaterThan(result.tables[1].relevanceScore);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle empty index', async () => {
      mockCHClient.setMockTables([]);

      const result = await service.discoverTables({
        query: 'products',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.tables).toHaveLength(0);
      expect(result.totalAvailable).toBe(0);
      expect(result.queryAnalysis.intent).toBe('ambiguous');
    });

    it('should handle very short query', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
      ]);

      const result = await service.discoverTables({
        query: 'p',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      // Short query should still work but may have lower scores
      expect(result.tables.length).toBeGreaterThanOrEqual(0);
    });

    it('should filter by minRelevanceScore', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
        createMockTable('orders', 'Orders', 'Order records', ['id', 'customer']),
      ]);

      const result = await service.discoverTables({
        query: 'products',
        tenantId: 'tenant-123',
        indexId: 'index-123',
        minRelevanceScore: 0.9, // Very high threshold
      });

      // Only exact match should pass
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].metadata.table_name).toBe('products');
    });

    it('should handle SQL-like queries', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
      ]);

      const result = await service.discoverTables({
        query: 'SELECT * FROM products WHERE price > 100',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      // Should extract 'products' keyword and ignore SQL syntax
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].metadata.table_name).toBe('products');
    });

    it('should handle natural language queries', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
        createMockTable('orders', 'Orders', 'Customer orders', ['id', 'product_id']),
      ]);

      const result = await service.discoverTables({
        query: 'show me all the products with price greater than 50',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      // Should find 'products' table
      expect(result.tables[0].metadata.table_name).toBe('products');
    });
  });

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  describe('Utility Methods', () => {
    it('should list all tables', async () => {
      const tables = [
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
        createMockTable('orders', 'Orders', 'Order records', ['id', 'customer']),
      ];
      mockCHClient.setMockTables(tables);

      const result = await service.listTables('tenant-123', 'index-123');

      expect(result).toHaveLength(2);
      expect(result.map((t) => t.table_name)).toEqual(['products', 'orders']);
    });

    it('should get specific table by name', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
        createMockTable('orders', 'Orders', 'Order records', ['id', 'customer']),
      ]);

      const result = await service.getTableByName('tenant-123', 'index-123', 'products');

      expect(result).not.toBeNull();
      expect(result?.table_name).toBe('products');
    });

    it('should return null for nonexistent table', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name']),
      ]);

      const result = await service.getTableByName('tenant-123', 'index-123', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // KEYWORD EXTRACTION
  // ==========================================================================

  describe('Keyword Extraction', () => {
    it('should extract meaningful keywords', async () => {
      mockCHClient.setMockTables([
        createMockTable('products', 'Products', 'Product catalog', ['id', 'name', 'price']),
      ]);

      const result = await service.discoverTables({
        query: 'find all products with price greater than 100',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      // Should extract 'products', 'price', 'greater', etc. (excluding stopwords)
      expect(result.queryAnalysis.keywords.length).toBeGreaterThan(0);
      expect(result.queryAnalysis.keywords).toContain('products');
      expect(result.queryAnalysis.keywords).toContain('price');
      // Stopwords should be filtered
      expect(result.queryAnalysis.keywords).not.toContain('all');
      expect(result.queryAnalysis.keywords).not.toContain('the');
    });
  });
});
