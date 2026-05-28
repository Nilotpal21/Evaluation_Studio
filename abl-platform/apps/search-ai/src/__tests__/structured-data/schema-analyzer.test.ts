/**
 * Tests for StructuredDataSchemaAnalyzer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredDataSchemaAnalyzer } from '../../services/structured-data/schema-analyzer.js';

describe('StructuredDataSchemaAnalyzer', () => {
  let analyzer: StructuredDataSchemaAnalyzer;

  beforeEach(() => {
    analyzer = new StructuredDataSchemaAnalyzer();
  });

  describe('CSV parsing', () => {
    it('should parse valid CSV file', async () => {
      const csvContent = `id,name,email,age
1,Alice,alice@example.com,30
2,Bob,bob@example.com,25
3,Charlie,charlie@example.com,35`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'users.csv', 'text/csv');

      expect(result.schema.tableName).toBe('users');
      expect(result.schema.rowCount).toBe(3);
      expect(result.schema.columns).toHaveLength(4);
      expect(result.schema.columns.map((c) => c.name)).toEqual(['id', 'name', 'email', 'age']);
    });

    it('should detect column types correctly', async () => {
      const csvContent = `id,name,active,created_at,score
1,Alice,true,2024-01-15,95.5
2,Bob,false,2024-02-20,87.3
3,Charlie,true,2024-03-10,91.2`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      const columns = result.schema.columns;
      expect(columns.find((c) => c.name === 'id')?.type).toBe('integer');
      expect(columns.find((c) => c.name === 'name')?.type).toBe('string');
      expect(columns.find((c) => c.name === 'active')?.type).toBe('boolean');
      expect(columns.find((c) => c.name === 'created_at')?.type).toBe('date');
      expect(columns.find((c) => c.name === 'score')?.type).toBe('number');
    });

    it('should detect enum columns with low cardinality', async () => {
      const csvContent = `id,status
1,active
2,inactive
3,active
4,pending
5,active`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      const statusColumn = result.schema.columns.find((c) => c.name === 'status');
      expect(statusColumn?.type).toBe('enum');
      expect(statusColumn?.enumValues).toEqual(
        expect.arrayContaining(['active', 'inactive', 'pending']),
      );
      expect(statusColumn?.uniqueCount).toBe(3);
    });

    it('should handle nullable columns', async () => {
      const csvContent = `id,name,email
1,Alice,alice@example.com
2,Bob,
3,Charlie,charlie@example.com`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      const emailColumn = result.schema.columns.find((c) => c.name === 'email');
      expect(emailColumn?.nullable).toBe(true);
      expect(emailColumn?.nullCount).toBe(1);
    });
  });

  describe('JSON parsing', () => {
    it('should parse JSON array', async () => {
      const jsonContent = JSON.stringify([
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 3, name: 'Charlie', active: true },
      ]);

      const buffer = Buffer.from(jsonContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'users.json', 'application/json');

      expect(result.schema.tableName).toBe('users');
      expect(result.schema.rowCount).toBe(3);
      expect(result.schema.columns).toHaveLength(3);
    });

    it('should parse JSON with data wrapper', async () => {
      const jsonContent = JSON.stringify({
        data: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
      });

      const buffer = Buffer.from(jsonContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.json', 'application/json');

      expect(result.schema.rowCount).toBe(2);
    });
  });

  describe('Primary key detection', () => {
    it('should detect id column as primary key', async () => {
      const csvContent = `id,name,email
1,Alice,alice@example.com
2,Bob,bob@example.com
3,Charlie,charlie@example.com`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'users.csv', 'text/csv');

      expect(result.schema.primaryKey).toBe('id');
    });

    it('should detect unique _id columns as primary key', async () => {
      const csvContent = `user_id,name,email
1,Alice,alice@example.com
2,Bob,bob@example.com
3,Charlie,charlie@example.com`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'users.csv', 'text/csv');

      expect(result.schema.primaryKey).toBe('user_id');
    });

    it('should return null if no unique id column found', async () => {
      const csvContent = `name,email
Alice,alice@example.com
Bob,bob@example.com`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'users.csv', 'text/csv');

      expect(result.schema.primaryKey).toBeNull();
    });

    it('should not detect id as primary key if not unique', async () => {
      const csvContent = `id,name
1,Alice
1,Bob`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.schema.primaryKey).toBeNull();
    });
  });

  describe('Foreign key detection', () => {
    it('should detect foreign keys by naming convention', async () => {
      const csvContent = `id,user_id,order_id
1,10,100
2,11,101`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'orders.csv', 'text/csv');

      expect(result.schema.foreignKeys).toHaveLength(2);
      expect(result.schema.foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceField: 'user_id',
            targetTable: 'users',
            targetField: 'id',
            detectionMethod: 'naming_convention',
          }),
          expect.objectContaining({
            sourceField: 'order_id',
            targetTable: 'orders',
            targetField: 'id',
            detectionMethod: 'naming_convention',
          }),
        ]),
      );
    });
  });

  describe('Embeddability detection', () => {
    it('should mark text columns as embeddable', async () => {
      const csvContent = `id,title,description
1,Product 1,This is a detailed product description
2,Product 2,Another product with detailed information`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'products.csv', 'text/csv');

      const descColumn = result.schema.columns.find((c) => c.name === 'description');
      expect(descColumn?.isEmbeddable).toBe(true);
    });

    it('should not mark id columns as embeddable', async () => {
      const csvContent = `id,user_id,name
1,10,Alice
2,11,Bob`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.schema.columns.find((c) => c.name === 'id')?.isEmbeddable).toBe(false);
      expect(result.schema.columns.find((c) => c.name === 'user_id')?.isEmbeddable).toBe(false);
    });

    it('should not mark short text as embeddable', async () => {
      const csvContent = `id,code,name
1,A1,Alice
2,B2,Bob`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      const codeColumn = result.schema.columns.find((c) => c.name === 'code');
      expect(codeColumn?.isEmbeddable).toBe(false);
    });
  });

  describe('Filterability detection', () => {
    it('should mark numeric columns as filterable', async () => {
      const csvContent = `id,age,score
1,30,95.5
2,25,87.3`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.schema.columns.find((c) => c.name === 'age')?.isFilterable).toBe(true);
      expect(result.schema.columns.find((c) => c.name === 'score')?.isFilterable).toBe(true);
    });

    it('should mark enum columns as filterable', async () => {
      const csvContent = `id,status
1,active
2,inactive
3,active`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      const statusColumn = result.schema.columns.find((c) => c.name === 'status');
      expect(statusColumn?.isFilterable).toBe(true);
    });
  });

  describe('Cost estimates', () => {
    it('should calculate embedding tokens', async () => {
      const csvContent = `id,description
1,This is a product description with several words
2,Another detailed product description here`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'products.csv', 'text/csv');

      expect(result.estimates.embeddingTokens).toBeGreaterThan(0);
      expect(result.estimates.embeddingCost).toBeGreaterThan(0);
    });

    it('should calculate storage bytes', async () => {
      const csvContent = `id,name
1,Alice
2,Bob`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.estimates.storageBytes).toBeGreaterThan(0);
    });

    it('should estimate chunk count', async () => {
      const csvContent = `id,description
1,Product A
2,Product B
3,Product C`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.estimates.chunkCount).toBeGreaterThan(0);
    });
  });

  describe('Quality assessment', () => {
    it('should calculate overall confidence', async () => {
      const csvContent = `id,name,age
1,Alice,30
2,Bob,25`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.quality.overallConfidence).toBeGreaterThan(0);
      expect(result.quality.overallConfidence).toBeLessThanOrEqual(1);
    });

    it('should warn about high null rates', async () => {
      const csvContent = `id,name,optional
1,Alice,
2,Bob,
3,Charlie,`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.quality.warnings.some((w) => w.includes('null'))).toBe(true);
    });

    it('should warn when no embeddable columns found', async () => {
      const csvContent = `id,code
1,A1
2,B2`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.quality.warnings.some((w) => w.includes('embeddable'))).toBe(true);
    });
  });

  describe('Analysis metadata', () => {
    it('should generate analysisId and expiresAt', async () => {
      const csvContent = `id,name
1,Alice`;

      const buffer = Buffer.from(csvContent, 'utf-8');
      const result = await analyzer.analyze(buffer, 'data.csv', 'text/csv');

      expect(result.analysisId).toBeDefined();
      expect(result.analysisId.length).toBeGreaterThan(0);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('Error handling', () => {
    it('should throw on invalid CSV', async () => {
      const buffer = Buffer.from('invalid csv content', 'utf-8');
      await expect(analyzer.analyze(buffer, 'data.csv', 'text/csv')).rejects.toThrow();
    });

    it('should throw on invalid JSON', async () => {
      const buffer = Buffer.from('{ invalid json', 'utf-8');
      await expect(analyzer.analyze(buffer, 'data.json', 'application/json')).rejects.toThrow();
    });

    it('should throw on unsupported MIME type', async () => {
      const buffer = Buffer.from('data', 'utf-8');
      await expect(analyzer.analyze(buffer, 'data.txt', 'text/plain')).rejects.toThrow(
        'Unsupported file type',
      );
    });
  });
});
