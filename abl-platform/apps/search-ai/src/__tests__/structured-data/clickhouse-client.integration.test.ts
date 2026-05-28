/**
 * Integration Tests for StructuredDataClickHouseClient
 *
 * These tests require a running ClickHouse instance.
 * Run with: CLICKHOUSE_URL=http://localhost:8123 pnpm test clickhouse-client.integration
 *
 * Skip if ClickHouse is not available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { StructuredDataClickHouseClient } from '../../services/structured-data/clickhouse-client.js';
import type { TableMetadata } from '../../services/structured-data/types.js';
import { getClickHouseClient, closeClickHouseClient } from '@agent-platform/database';

// Skip these tests unless a ClickHouse endpoint is explicitly configured.
// CI may be true in environments that do not actually provision ClickHouse.
const skipIntegration = !process.env.CLICKHOUSE_URL && !process.env.CLICKHOUSE_HOST;

describe.skipIf(skipIntegration)('StructuredDataClickHouseClient (Integration)', () => {
  let client: StructuredDataClickHouseClient;

  const testTenantId = `test-tenant-${Date.now()}`;
  const testIndexId = `test-index-${Date.now()}`;
  const testTableId = `table_${Date.now()}`;

  beforeAll(async () => {
    const clickhouse = getClickHouseClient();
    client = new StructuredDataClickHouseClient(clickhouse);

    // Initialize tables
    await client.initialize();
  });

  afterAll(async () => {
    // Cleanup: Delete test table
    try {
      await client.deleteTable(testTenantId, testIndexId, testTableId);
    } catch (error) {
      // Ignore cleanup errors
    }

    await closeClickHouseClient();
  });

  describe('end-to-end workflow', () => {
    it('should complete full ingestion workflow', async () => {
      // Step 1: Create data table
      await client.createDataTable(testTenantId, testIndexId, testTableId);

      // Step 2: Insert metadata
      const metadata: TableMetadata = {
        table_id: testTableId,
        table_name: 'customers',
        display_name: 'Customers',
        tenant_id: testTenantId,
        index_id: testIndexId,
        columns: JSON.stringify(['id', 'name', 'email', 'status']),
        column_types: JSON.stringify(['integer', 'string', 'string', 'enum']),
        primary_key: 'id',
        row_count: 3,
        table_description: 'Customer records for integration testing',
        column_descriptions: JSON.stringify({
          id: 'Unique identifier',
          name: 'Customer name',
          email: 'Email address',
          status: 'Account status',
        }),
        statistics: JSON.stringify({
          status: {
            type: 'categorical',
            uniqueValues: ['active', 'inactive'],
            cardinality: 2,
            distribution: { active: 66.67, inactive: 33.33 },
          },
        }),
        sample_rows: JSON.stringify([
          { id: 1, name: 'Alice', email: 'alice@example.com', status: 'active' },
          { id: 2, name: 'Bob', email: 'bob@example.com', status: 'active' },
        ]),
        foreign_keys: JSON.stringify([]),
        searchable_text: 'customers customer records',
        created_at: new Date(),
        updated_at: new Date(),
      };

      await client.insertMetadata(metadata);

      // Step 3: Insert rows
      const rows = [
        { id: 1, name: 'Alice', email: 'alice@example.com', status: 'active' },
        { id: 2, name: 'Bob', email: 'bob@example.com', status: 'active' },
        { id: 3, name: 'Charlie', email: 'charlie@example.com', status: 'inactive' },
      ];

      const insertResult = await client.insertRows(testTenantId, testIndexId, testTableId, rows);
      expect(insertResult.success).toBe(true);
      expect(insertResult.rowsIngested).toBe(3);

      // Step 4: Query metadata
      const metadataResults = await client.getTableMetadata(testTenantId, testIndexId, 'customers');
      expect(metadataResults).toHaveLength(1);
      expect(metadataResults[0].table_name).toBe('customers');
      expect(metadataResults[0].row_count).toBe(3);

      // Step 5: Query rows
      const rowResults = await client.queryRows(testTenantId, testIndexId, testTableId);
      expect(rowResults).toHaveLength(3);
      expect(rowResults[0]).toEqual({
        id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        status: 'active',
      });

      // Step 6: Query with limit/offset
      const limitedResults = await client.queryRows(testTenantId, testIndexId, testTableId, {
        limit: 2,
        offset: 1,
      });
      expect(limitedResults).toHaveLength(2);
      expect(limitedResults[0].id).toBe(2);

      // Step 7: Get table stats
      const stats = await client.getTableStats(testTenantId, testIndexId, testTableId);
      expect(stats.rowCount).toBe(3);
      expect(stats.sizeBytes).toBeGreaterThan(0);
    });

    it('should enforce tenant isolation', async () => {
      const tenant1 = `tenant-1-${Date.now()}`;
      const tenant2 = `tenant-2-${Date.now()}`;
      const tableId1 = `table-1-${Date.now()}`;
      const tableId2 = `table-2-${Date.now()}`;

      // Create tables for two tenants
      await client.createDataTable(tenant1, testIndexId, tableId1);
      await client.createDataTable(tenant2, testIndexId, tableId2);

      // Insert data for tenant 1
      await client.insertRows(tenant1, testIndexId, tableId1, [{ id: 1, tenant: 'tenant-1' }]);

      // Insert data for tenant 2
      await client.insertRows(tenant2, testIndexId, tableId2, [{ id: 2, tenant: 'tenant-2' }]);

      // Query tenant 1 - should only see tenant 1 data
      const tenant1Rows = await client.queryRows(tenant1, testIndexId, tableId1);
      expect(tenant1Rows).toHaveLength(1);
      expect(tenant1Rows[0].tenant).toBe('tenant-1');

      // Query tenant 2 - should only see tenant 2 data
      const tenant2Rows = await client.queryRows(tenant2, testIndexId, tableId2);
      expect(tenant2Rows).toHaveLength(1);
      expect(tenant2Rows[0].tenant).toBe('tenant-2');

      // Cleanup
      await client.deleteTable(tenant1, testIndexId, tableId1);
      await client.deleteTable(tenant2, testIndexId, tableId2);
    });

    it('should enforce index isolation', async () => {
      const index1 = `index-1-${Date.now()}`;
      const index2 = `index-2-${Date.now()}`;
      const tableId = `table-${Date.now()}`;

      // Create tables for two indexes
      await client.createDataTable(testTenantId, index1, tableId);
      await client.createDataTable(testTenantId, index2, tableId);

      // Insert data for index 1
      await client.insertRows(testTenantId, index1, tableId, [{ id: 1, index: 'index-1' }]);

      // Insert data for index 2
      await client.insertRows(testTenantId, index2, tableId, [{ id: 2, index: 'index-2' }]);

      // Query index 1 - should only see index 1 data
      const index1Rows = await client.queryRows(testTenantId, index1, tableId);
      expect(index1Rows).toHaveLength(1);
      expect(index1Rows[0].index).toBe('index-1');

      // Query index 2 - should only see index 2 data
      const index2Rows = await client.queryRows(testTenantId, index2, tableId);
      expect(index2Rows).toHaveLength(1);
      expect(index2Rows[0].index).toBe('index-2');

      // Cleanup
      await client.deleteTable(testTenantId, index1, tableId);
      await client.deleteTable(testTenantId, index2, tableId);
    });

    it('should handle large datasets efficiently', async () => {
      const largeTableId = `large-table-${Date.now()}`;
      await client.createDataTable(testTenantId, testIndexId, largeTableId);

      // Insert 10,000 rows
      const largeRowSet = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        name: `User ${i}`,
        email: `user${i}@example.com`,
        value: Math.random() * 1000,
      }));

      const startTime = Date.now();
      const result = await client.insertRows(testTenantId, testIndexId, largeTableId, largeRowSet);
      const insertDuration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(result.rowsIngested).toBe(10000);

      // Verify insertion was reasonably fast (< 5 seconds)
      expect(insertDuration).toBeLessThan(5000);

      // Query with pagination
      const page1 = await client.queryRows(testTenantId, testIndexId, largeTableId, {
        limit: 100,
        offset: 0,
      });
      expect(page1).toHaveLength(100);

      const page2 = await client.queryRows(testTenantId, testIndexId, largeTableId, {
        limit: 100,
        offset: 100,
      });
      expect(page2).toHaveLength(100);
      expect(page2[0].id).toBe(100);

      // Get stats
      const stats = await client.getTableStats(testTenantId, testIndexId, largeTableId);
      expect(stats.rowCount).toBe(10000);

      // Cleanup
      await client.deleteTable(testTenantId, testIndexId, largeTableId);
    });

    it('should reject SQL without tenant/index filters', async () => {
      const unsafeSql = 'SELECT * FROM abl_platform.structured_data_table_123';

      await expect(client.executeQuery(testTenantId, testIndexId, unsafeSql)).rejects.toThrow(
        'SECURITY_VIOLATION',
      );
    });

    it('should allow safe custom SQL queries', async () => {
      const tableId = `query-test-${Date.now()}`;
      await client.createDataTable(testTenantId, testIndexId, tableId);

      await client.insertRows(testTenantId, testIndexId, tableId, [
        { id: 1, status: 'active', value: 100 },
        { id: 2, status: 'active', value: 200 },
        { id: 3, status: 'inactive', value: 50 },
      ]);

      const tableName = `structured_data_${tableId}`;
      const safeSql = `
        SELECT
          JSON_EXTRACT_STRING(row_data, 'status') as status,
          COUNT(*) as count
        FROM abl_platform.${tableName}
        WHERE tenant_id = {tenantId:String}
          AND index_id = {indexId:String}
        GROUP BY status
        ORDER BY status
      `;

      const results = await client.executeQuery(testTenantId, testIndexId, safeSql);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('active');
      expect(parseInt(results[0].count, 10)).toBe(2);

      // Cleanup
      await client.deleteTable(testTenantId, testIndexId, tableId);
    });
  });
});
