/**
 * Tests for StructuredDataChunkingStrategy
 *
 * Design:
 * - Tables (CSV/Excel): Create ONLY 1 metadata chunk per table
 * - NO individual row chunks (all rows go to ClickHouse only)
 * - Metadata chunk is for table-level semantic search
 * - Query routing: SQL → ClickHouse, Semantic → metadata chunk → ClickHouse
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredDataChunkingStrategy } from '../../services/structured-data/chunking-strategy.js';
import type { ColumnSchema } from '../../services/structured-data/types.js';

describe('StructuredDataChunkingStrategy', () => {
  let strategy: StructuredDataChunkingStrategy;

  beforeEach(() => {
    strategy = new StructuredDataChunkingStrategy();
  });

  describe('Table chunking design', () => {
    it('should always create table metadata chunk', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'value', type: 'number', nullable: false, isEmbeddable: false, isFilterable: true },
      ];

      const rows = [
        { id: 1, value: 100 },
        { id: 2, value: 200 },
      ];

      const result = strategy.chunk(
        'test_table',
        'Test Table',
        'A test table',
        columns,
        rows,
        'id',
        [],
        {},
      );

      expect(result.metadataChunk).toBeDefined();
      expect(result.metadataChunk.type).toBe('table_metadata');
      expect(result.metadataChunk.tableName).toBe('test_table');
      expect(result.metadataChunk.rowCount).toBe(2);
    });

    it('should NOT create individual row chunks for tables', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'description',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const rows = [
        {
          id: 1,
          description:
            'This is a long description with more than 100 characters of text content. All data goes to ClickHouse.',
        },
        {
          id: 2,
          description:
            'Another lengthy description exceeding any threshold. We do not create row chunks for tables.',
        },
      ];

      const result = strategy.chunk('products', 'Products', '', columns, rows, 'id', [], {});

      // NO row chunks - all rows go to ClickHouse
      expect(result.rowChunks).toHaveLength(0);
      expect(result.metadataChunk).toBeDefined();
    });

    it('should NOT chunk rows even with text-heavy content', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'content',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        content: `This is a very long text content with more than 100 characters for row ${i + 1}. Even with text-heavy content, we do not create row chunks.`,
      }));

      const result = strategy.chunk('articles', 'Articles', '', columns, rows, 'id', [], {});

      // All rows go to ClickHouse, no row chunks
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(100);
      expect(result.statistics.chunkedRows).toBe(0);
      expect(result.statistics.skippedRows).toBe(100);
      expect(result.statistics.savingsPercent).toBe(100);
    });

    it('should show 100% savings for all tables', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'value', type: 'number', nullable: false, isEmbeddable: false, isFilterable: true },
      ];

      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, value: i * 10 }));

      const result = strategy.chunk('metrics', 'Metrics', '', columns, rows, 'id', [], {});

      // 100% savings - no row chunks ever
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(1000);
      expect(result.statistics.chunkedRows).toBe(0);
      expect(result.statistics.skippedRows).toBe(1000);
      expect(result.statistics.savingsPercent).toBe(100);
    });
  });

  describe('Table metadata generation', () => {
    it('should include complete schema information', () => {
      const columns: ColumnSchema[] = [
        {
          name: 'id',
          type: 'integer',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
          description: 'Unique identifier',
        },
        {
          name: 'name',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
          description: 'User name',
        },
      ];

      const rows = [{ id: 1, name: 'Alice' }];

      const result = strategy.chunk('users', 'Users', 'User records', columns, rows, 'id', [], {});

      expect(result.metadataChunk.columns).toHaveLength(2);
      expect(result.metadataChunk.columns[0].name).toBe('id');
      expect(result.metadataChunk.columns[0].type).toBe('integer');
      expect(result.metadataChunk.columns[0].description).toBe('Unique identifier');
      expect(result.metadataChunk.primaryKey).toBe('id');
    });

    it('should include sample rows (10-20 representative rows)', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'value', type: 'number', nullable: false, isEmbeddable: false, isFilterable: true },
      ];

      const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, value: (i + 1) * 10 }));

      const result = strategy.chunk('data', 'Data', '', columns, rows, 'id', [], {});

      expect(result.metadataChunk.sampleRows.length).toBeGreaterThan(0);
      expect(result.metadataChunk.sampleRows.length).toBeLessThanOrEqual(20);
    });

    it('should auto-generate description if not provided', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'name', type: 'string', nullable: false, isEmbeddable: true, isFilterable: false },
      ];

      const rows = [{ id: 1, name: 'Test' }];

      const result = strategy.chunk('test_table', 'Test Table', '', columns, rows, 'id', [], {});

      expect(result.metadataChunk.description).toBeDefined();
      expect(result.metadataChunk.description).toContain('test_table');
      expect(result.metadataChunk.description).toContain('1 rows');
      expect(result.metadataChunk.description).toContain('2 columns');
    });

    it('should include foreign keys', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'user_id',
          type: 'integer',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const foreignKeys = [
        {
          sourceField: 'user_id',
          targetTable: 'users',
          targetField: 'id',
          confidence: 0.9,
          detectionMethod: 'naming_convention' as const,
        },
      ];

      const rows = [{ id: 1, user_id: 10 }];

      const result = strategy.chunk('orders', 'Orders', '', columns, rows, 'id', foreignKeys, {});

      expect(result.metadataChunk.foreignKeys).toHaveLength(1);
      expect(result.metadataChunk.foreignKeys[0].sourceField).toBe('user_id');
      expect(result.metadataChunk.foreignKeys[0].targetTable).toBe('users');
    });

    it('should include column statistics', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'category',
          type: 'enum',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const rows = [
        { id: 1, category: 'A' },
        { id: 2, category: 'B' },
        { id: 3, category: 'A' },
      ];

      const statistics = {
        category: {
          distinct_values: 2,
          top_values: { A: 2, B: 1 },
        },
      };

      const result = strategy.chunk('data', 'Data', '', columns, rows, 'id', [], statistics);

      expect(result.metadataChunk.statistics).toBeDefined();
      expect(result.metadataChunk.statistics.category).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty table', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
      ];

      const rows: Record<string, any>[] = [];

      const result = strategy.chunk('empty', 'Empty', '', columns, rows, 'id', [], {});

      expect(result.metadataChunk).toBeDefined();
      expect(result.metadataChunk.rowCount).toBe(0);
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(0);
      expect(result.statistics.savingsPercent).toBe(100);
    });

    it('should handle table with no embeddable columns', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'count',
          type: 'integer',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const rows = [
        { id: 1, count: 10 },
        { id: 2, count: 20 },
      ];

      const result = strategy.chunk('counters', 'Counters', '', columns, rows, 'id', [], {});

      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.savingsPercent).toBe(100);
    });

    it('should handle single row table', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'text',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const rows = [
        {
          id: 1,
          text: 'This is a single row with text content. Even single rows do not get chunked individually.',
        },
      ];

      const result = strategy.chunk('single', 'Single', '', columns, rows, 'id', [], {});

      expect(result.metadataChunk.rowCount).toBe(1);
      expect(result.rowChunks).toHaveLength(0); // NO row chunks
      expect(result.statistics.savingsPercent).toBe(100);
    });

    it('should handle very large tables efficiently', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'description',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      // Simulate 100k row table
      const rows = Array.from({ length: 100000 }, (_, i) => ({
        id: i + 1,
        description: `Row ${i + 1} with some text content`,
      }));

      const result = strategy.chunk('large_table', 'Large Table', '', columns, rows, 'id', [], {});

      // Only 1 metadata chunk for 100k rows
      expect(result.metadataChunk).toBeDefined();
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(100000);
      expect(result.statistics.chunkedRows).toBe(0);
      expect(result.statistics.savingsPercent).toBe(100);
    });
  });

  describe('Metadata chunk searchability', () => {
    it('should include searchable text in metadata chunk', () => {
      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'product_name',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
          description: 'Name of the product',
        },
        {
          name: 'category',
          type: 'enum',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
          description: 'Product category',
        },
      ];

      const rows = [
        { id: 1, product_name: 'Laptop', category: 'Electronics' },
        { id: 2, product_name: 'Mouse', category: 'Electronics' },
      ];

      const result = strategy.chunk(
        'products',
        'Products',
        'Product inventory table',
        columns,
        rows,
        'id',
        [],
        {},
      );

      // Metadata chunk should be searchable for table discovery
      expect(result.metadataChunk.tableName).toBe('products');
      expect(result.metadataChunk.displayName).toBe('Products');
      expect(result.metadataChunk.description).toContain('Product inventory table');
      expect(result.metadataChunk.columns.some((c) => c.name === 'product_name')).toBe(true);
    });
  });
});
