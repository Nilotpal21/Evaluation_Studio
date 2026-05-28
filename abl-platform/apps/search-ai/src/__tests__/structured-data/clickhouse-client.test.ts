/**
 * Tests for StructuredDataClickHouseClient
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StructuredDataClickHouseClient } from '../../services/structured-data/clickhouse-client.js';
import type { TableMetadata } from '../../services/structured-data/types.js';

describe('StructuredDataClickHouseClient', () => {
  let client: StructuredDataClickHouseClient;
  let mockClickHouse: any;

  const testTenantId = 'test-tenant';
  const testIndexId = 'test-index';
  const testTableId = 'table_123';

  beforeEach(() => {
    // Mock ClickHouse client
    mockClickHouse = {
      exec: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue([]),
      }),
    };

    client = new StructuredDataClickHouseClient(mockClickHouse);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should create table_metadata table', async () => {
      await client.initialize();

      expect(mockClickHouse.exec).toHaveBeenCalledTimes(1);
      expect(mockClickHouse.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
      });
      expect(mockClickHouse.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('table_metadata'),
      });
    });
  });

  describe('createDataTable', () => {
    it('should create data table with correct name', async () => {
      await client.createDataTable(testTenantId, testIndexId, testTableId);

      expect(mockClickHouse.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('structured_data_table_123'),
      });
    });

    it('should include tenant and index isolation columns', async () => {
      await client.createDataTable(testTenantId, testIndexId, testTableId);

      const query = mockClickHouse.exec.mock.calls[0][0].query;
      expect(query).toContain('tenant_id String');
      expect(query).toContain('index_id String');
      expect(query).toContain('ORDER BY (tenant_id, index_id, row_number)');
    });
  });

  describe('insertMetadata', () => {
    it('should insert table metadata', async () => {
      const now = new Date();
      const metadata: TableMetadata = {
        table_id: testTableId,
        table_name: 'customers',
        display_name: 'Customers',
        tenant_id: testTenantId,
        index_id: testIndexId,
        columns: JSON.stringify(['id', 'name', 'email']),
        column_types: JSON.stringify(['integer', 'string', 'string']),
        primary_key: 'id',
        row_count: 100,
        table_description: 'Customer records',
        column_descriptions: JSON.stringify({}),
        statistics: JSON.stringify({}),
        sample_rows: JSON.stringify([]),
        foreign_keys: JSON.stringify([]),
        searchable_text: 'customers',
        created_at: now,
        updated_at: now,
      };

      await client.insertMetadata(metadata);

      // Expect formatted ClickHouse DateTime strings (YYYY-MM-DD HH:MM:SS)
      const insertedValues = mockClickHouse.insert.mock.calls[0][0].values[0];
      expect(insertedValues.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(insertedValues.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(insertedValues.table_id).toBe(testTableId);
      expect(insertedValues.table_name).toBe('customers');
    });
  });

  describe('insertRows', () => {
    it('should insert rows successfully', async () => {
      const rows = [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
      ];

      const result = await client.insertRows(testTenantId, testIndexId, testTableId, rows);

      expect(result.success).toBe(true);
      expect(result.rowsIngested).toBe(2);
      expect(mockClickHouse.insert).toHaveBeenCalledWith({
        table: 'abl_platform.structured_data_table_123',
        values: expect.arrayContaining([
          expect.objectContaining({
            tenant_id: testTenantId,
            index_id: testIndexId,
            table_id: testTableId,
            row_data: expect.any(String),
            row_number: expect.any(Number),
          }),
        ]),
        format: 'JSONEachRow',
      });
    });

    it('should serialize row data as JSON', async () => {
      const rows = [{ id: 1, name: 'Alice' }];

      await client.insertRows(testTenantId, testIndexId, testTableId, rows);

      const insertedValues = mockClickHouse.insert.mock.calls[0][0].values;
      expect(JSON.parse(insertedValues[0].row_data)).toEqual({ id: 1, name: 'Alice' });
    });

    it('should assign sequential row numbers', async () => {
      const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

      await client.insertRows(testTenantId, testIndexId, testTableId, rows);

      const insertedValues = mockClickHouse.insert.mock.calls[0][0].values;
      expect(insertedValues[0].row_number).toBe(0);
      expect(insertedValues[1].row_number).toBe(1);
      expect(insertedValues[2].row_number).toBe(2);
    });

    it('should return error on insertion failure', async () => {
      mockClickHouse.insert.mockRejectedValueOnce(new Error('Insertion failed'));

      const result = await client.insertRows(testTenantId, testIndexId, testTableId, [{ id: 1 }]);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INSERTION_FAILED');
    });
  });

  describe('getTableMetadata', () => {
    it('should query metadata with tenant and index isolation', async () => {
      await client.getTableMetadata(testTenantId, testIndexId);

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining('WHERE tenant_id'),
        query_params: { tenantId: testTenantId, indexId: testIndexId },
        format: 'JSONEachRow',
      });
    });

    it('should filter by table name if provided', async () => {
      await client.getTableMetadata(testTenantId, testIndexId, 'customers');

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining('AND table_name'),
        query_params: {
          tenantId: testTenantId,
          indexId: testIndexId,
          tableName: 'customers',
        },
        format: 'JSONEachRow',
      });
    });
  });

  describe('queryRows', () => {
    beforeEach(() => {
      mockClickHouse.query.mockResolvedValue({
        json: vi
          .fn()
          .mockResolvedValue([
            { row_data: JSON.stringify({ id: 1, name: 'Alice' }) },
            { row_data: JSON.stringify({ id: 2, name: 'Bob' }) },
          ]),
      });
    });

    it('should query rows with tenant/index isolation', async () => {
      await client.queryRows(testTenantId, testIndexId, testTableId);

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining('WHERE tenant_id'),
        query_params: expect.objectContaining({
          tenantId: testTenantId,
          indexId: testIndexId,
        }),
        format: 'JSONEachRow',
      });
    });

    it('should parse row data from JSON', async () => {
      const rows = await client.queryRows(testTenantId, testIndexId, testTableId);

      expect(rows).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);
    });

    it('should apply limit and offset', async () => {
      await client.queryRows(testTenantId, testIndexId, testTableId, {
        limit: 10,
        offset: 20,
      });

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining('LIMIT'),
        query_params: expect.objectContaining({
          limit: 10,
          offset: 20,
        }),
        format: 'JSONEachRow',
      });
    });

    it('should apply additional where clause', async () => {
      await client.queryRows(testTenantId, testIndexId, testTableId, {
        where: "JSON_EXTRACT_STRING(row_data, 'status') = 'active'",
      });

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining("JSON_EXTRACT_STRING(row_data, 'status')"),
        query_params: expect.any(Object),
        format: 'JSONEachRow',
      });
    });
  });

  describe('executeQuery', () => {
    it('should execute custom SQL with tenant/index filters', async () => {
      const sql = `
        SELECT * FROM table
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
      `;

      await client.executeQuery(testTenantId, testIndexId, sql);

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: sql,
        query_params: { tenantId: testTenantId, indexId: testIndexId },
        format: 'JSONEachRow',
      });
    });

    it('should reject SQL without tenant_id filter', async () => {
      const sql = 'SELECT * FROM table WHERE index_id = {indexId:String}';

      await expect(client.executeQuery(testTenantId, testIndexId, sql)).rejects.toThrow(
        'SECURITY_VIOLATION',
      );
    });

    it('should reject SQL without index_id filter', async () => {
      const sql = 'SELECT * FROM table WHERE tenant_id = {tenantId:String}';

      await expect(client.executeQuery(testTenantId, testIndexId, sql)).rejects.toThrow(
        'SECURITY_VIOLATION',
      );
    });
  });

  describe('deleteTable', () => {
    it('should delete metadata and drop data table', async () => {
      await client.deleteTable(testTenantId, testIndexId, testTableId);

      expect(mockClickHouse.exec).toHaveBeenCalledTimes(2);
      expect(mockClickHouse.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('DELETE FROM'),
        query_params: { tenantId: testTenantId, indexId: testIndexId, tableId: testTableId },
      });
      expect(mockClickHouse.exec).toHaveBeenCalledWith({
        query: expect.stringContaining('DROP TABLE'),
      });
    });
  });

  describe('getTableStats', () => {
    beforeEach(() => {
      mockClickHouse.query.mockResolvedValue({
        json: vi.fn().mockResolvedValue([{ row_count: '100', size_bytes: '5000' }]),
      });
    });

    it('should return row count and size', async () => {
      const stats = await client.getTableStats(testTenantId, testIndexId, testTableId);

      expect(stats).toEqual({
        rowCount: 100,
        sizeBytes: 5000,
      });
    });

    it('should query with tenant/index isolation', async () => {
      await client.getTableStats(testTenantId, testIndexId, testTableId);

      expect(mockClickHouse.query).toHaveBeenCalledWith({
        query: expect.stringContaining('WHERE tenant_id'),
        query_params: { tenantId: testTenantId, indexId: testIndexId },
        format: 'JSONEachRow',
      });
    });
  });

  describe('tenant/index isolation', () => {
    it('should never query across tenants', async () => {
      await client.queryRows('tenant-a', testIndexId, testTableId);
      await client.queryRows('tenant-b', testIndexId, testTableId);

      const calls = mockClickHouse.query.mock.calls;
      expect(calls[0][0].query_params.tenantId).toBe('tenant-a');
      expect(calls[1][0].query_params.tenantId).toBe('tenant-b');
    });

    it('should never query across indexes', async () => {
      await client.queryRows(testTenantId, 'index-a', testTableId);
      await client.queryRows(testTenantId, 'index-b', testTableId);

      const calls = mockClickHouse.query.mock.calls;
      expect(calls[0][0].query_params.indexId).toBe('index-a');
      expect(calls[1][0].query_params.indexId).toBe('index-b');
    });
  });
});
