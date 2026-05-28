/**
 * Tests for Foreign Key Detection Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ForeignKeyDetector } from '../../services/structured-data/foreign-key-detector.js';
import type { DetectedColumn } from '../../services/structured-data/ingestion-types.js';
import type { TableMetadata } from '../../services/structured-data/types.js';

describe('ForeignKeyDetector', () => {
  let detector: ForeignKeyDetector;

  beforeEach(() => {
    detector = new ForeignKeyDetector();
  });

  // ==========================================================================
  // LOCAL DETECTION (Naming Convention Only)
  // ==========================================================================

  describe('detectForeignKeysLocal', () => {
    it('should detect FK by naming convention (user_id)', () => {
      const columns: DetectedColumn[] = [
        {
          name: 'id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'user_id',
          type: 'integer',
          confidence: 1.0,
          nullable: true,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'name',
          type: 'string',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const rows = [
        { id: 1, user_id: 100, name: 'Order 1' },
        { id: 2, user_id: 101, name: 'Order 2' },
      ];

      const fks = detector.detectForeignKeysLocal(rows, columns);

      expect(fks).toHaveLength(1);
      expect(fks[0].sourceField).toBe('user_id');
      expect(fks[0].targetTable).toBe('users');
      expect(fks[0].targetField).toBe('id');
      expect(fks[0].detectionMethod).toBe('naming_convention');
      expect(fks[0].confidence).toBe(0.7);
    });

    it('should detect multiple FKs', () => {
      const columns: DetectedColumn[] = [
        {
          name: 'id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'customer_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'product_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const rows = [{ id: 1, customer_id: 10, product_id: 50 }];

      const fks = detector.detectForeignKeysLocal(rows, columns);

      expect(fks).toHaveLength(2);
      expect(fks.map((fk) => fk.sourceField)).toContain('customer_id');
      expect(fks.map((fk) => fk.sourceField)).toContain('product_id');
      expect(fks.map((fk) => fk.targetTable)).toContain('customers');
      expect(fks.map((fk) => fk.targetTable)).toContain('products');
    });

    it('should not detect FK if column is not integer type', () => {
      const columns: DetectedColumn[] = [
        {
          name: 'user_id',
          type: 'string',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: false,
        },
      ];

      const rows = [{ user_id: 'user-123' }];

      const fks = detector.detectForeignKeysLocal(rows, columns);

      expect(fks).toHaveLength(0);
    });

    it('should handle irregular plurals', () => {
      const columns: DetectedColumn[] = [
        {
          name: 'person_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const rows = [{ person_id: 1 }];

      const fks = detector.detectForeignKeysLocal(rows, columns);

      expect(fks).toHaveLength(1);
      expect(fks[0].targetTable).toBe('people');
    });
  });

  // ==========================================================================
  // CROSS-TABLE VALIDATION
  // ==========================================================================

  describe('detectAndValidateForeignKeys', () => {
    it('should validate FK with 100% match rate', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'customer_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [
        { id: 1, customer_id: 100 },
        { id: 2, customer_id: 101 },
        { id: 3, customer_id: 100 }, // Duplicate FK value is fine
      ];

      const availableTables: TableMetadata[] = [
        {
          table_id: 'table-customers',
          table_name: 'customers',
          display_name: 'Customers',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'name']),
          column_types: JSON.stringify(['integer', 'string']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 100,
          table_description: 'Customer records',
          statistics: '{}',
          sample_rows: JSON.stringify([
            { id: 100, name: 'Alice' },
            { id: 101, name: 'Bob' },
          ]),
          foreign_keys: '[]',
          searchable_text: 'customers',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const fks = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );

      expect(fks).toHaveLength(1);
      expect(fks[0].sourceField).toBe('customer_id');
      expect(fks[0].targetTable).toBe('customers');
      expect(fks[0].valid).toBe(true);
      expect(fks[0].validationDetails.matchRate).toBe(1.0);
      expect(fks[0].validationDetails.validReferences).toBe(3); // All 3 rows have valid customer_ids (100, 101, 100)
      expect(fks[0].validationDetails.totalReferences).toBe(3);
      expect(fks[0].confidence).toBeGreaterThan(0.9);
    });

    it('should mark FK as invalid if match rate < threshold', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'customer_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [
        { customer_id: 100 },
        { customer_id: 999 }, // This ID doesn't exist in target table
      ];

      const availableTables: TableMetadata[] = [
        {
          table_id: 'table-customers',
          table_name: 'customers',
          display_name: 'Customers',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id']),
          column_types: JSON.stringify(['integer']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 1,
          table_description: '',
          statistics: '{}',
          sample_rows: JSON.stringify([{ id: 100 }]),
          foreign_keys: '[]',
          searchable_text: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const fks = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );

      expect(fks).toHaveLength(1);
      expect(fks[0].valid).toBe(false);
      expect(fks[0].validationDetails.matchRate).toBe(0.5); // 1 out of 2
      expect(fks[0].confidence).toBeLessThan(0.7);
    });

    it('should handle NULL FK values correctly', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'customer_id',
          type: 'integer',
          confidence: 1.0,
          nullable: true,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [{ customer_id: 100 }, { customer_id: null }, { customer_id: null }];

      const availableTables: TableMetadata[] = [
        {
          table_id: 'table-customers',
          table_name: 'customers',
          display_name: 'Customers',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id']),
          column_types: JSON.stringify(['integer']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 1,
          table_description: '',
          statistics: '{}',
          sample_rows: JSON.stringify([{ id: 100 }]),
          foreign_keys: '[]',
          searchable_text: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const fks = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );

      expect(fks).toHaveLength(1);
      expect(fks[0].validationDetails.nullReferences).toBe(2);
      expect(fks[0].validationDetails.validReferences).toBe(1);
      expect(fks[0].validationDetails.matchRate).toBe(1.0); // 1/1 non-null reference is valid
    });

    it('should not detect FK if target table does not exist', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'nonexistent_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [{ nonexistent_id: 1 }];

      const availableTables: TableMetadata[] = []; // No tables available

      const fks = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );

      expect(fks).toHaveLength(0);
    });

    it('should handle multiple tables and choose best match', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'user_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [{ user_id: 1 }, { user_id: 2 }];

      const availableTables: TableMetadata[] = [
        {
          table_id: 'table-users',
          table_name: 'users',
          display_name: 'Users',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'name']),
          column_types: JSON.stringify(['integer', 'string']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 10,
          table_description: '',
          statistics: '{}',
          sample_rows: JSON.stringify([
            { id: 1, name: 'User 1' },
            { id: 2, name: 'User 2' },
          ]),
          foreign_keys: '[]',
          searchable_text: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          table_id: 'table-products',
          table_name: 'products',
          display_name: 'Products',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'name']),
          column_types: JSON.stringify(['integer', 'string']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 5,
          table_description: '',
          statistics: '{}',
          sample_rows: JSON.stringify([]),
          foreign_keys: '[]',
          searchable_text: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const fks = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );

      expect(fks).toHaveLength(1);
      expect(fks[0].targetTable).toBe('users'); // Should match users table by naming convention
    });
  });

  // ==========================================================================
  // CONFIG OPTIONS
  // ==========================================================================

  describe('Configuration', () => {
    it('should respect minMatchRate config', async () => {
      const sourceColumns: DetectedColumn[] = [
        {
          name: 'customer_id',
          type: 'integer',
          confidence: 1.0,
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
      ];

      const sourceRows = [
        { customer_id: 100 },
        { customer_id: 999 }, // Invalid
      ];

      const availableTables: TableMetadata[] = [
        {
          table_id: 'table-customers',
          table_name: 'customers',
          display_name: 'Customers',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id']),
          column_types: JSON.stringify(['integer']),
          column_descriptions: '{}',
          primary_key: 'id',
          row_count: 1,
          table_description: '',
          statistics: '{}',
          sample_rows: JSON.stringify([{ id: 100 }]),
          foreign_keys: '[]',
          searchable_text: '',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      // With default threshold (0.9), should fail
      const fksDefault = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
      );
      expect(fksDefault[0].valid).toBe(false);

      // With lower threshold (0.4), should pass
      const fksLowThreshold = await detector.detectAndValidateForeignKeys(
        sourceRows,
        sourceColumns,
        availableTables,
        { minMatchRate: 0.4 },
      );
      expect(fksLowThreshold[0].valid).toBe(true);
    });
  });
});
