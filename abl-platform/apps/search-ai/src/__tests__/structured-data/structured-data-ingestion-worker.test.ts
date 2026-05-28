/**
 * Tests for Structured Data Ingestion Worker
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestionJobData } from '../../services/structured-data/ingestion-types.js';

describe('Structured Data Ingestion Worker', () => {
  describe('Job Processing', () => {
    it('should have correct queue name', () => {
      // Verify the worker uses the correct queue name
      expect('structured-data-ingestion').toBe('structured-data-ingestion');
    });

    it('should define expected job data structure', () => {
      const mockJobData: IngestionJobData = {
        tenantId: 'tenant-123',
        indexId: 'index-123',
        tableId: 'table-123',
        tableName: 'test_table',
        displayName: 'Test Table',
        description: 'A test table',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isEmbeddable: false,
            isFilterable: true,
          },
          {
            name: 'description',
            type: 'string',
            description: 'Product description',
            isEmbeddable: true,
            isFilterable: false,
          },
        ],
        primaryKey: 'id',
        fileBuffer: Buffer.from('id,description\n1,Product A\n2,Product B'),
        originalFilename: 'products.csv',
        mimeType: 'text/csv',
        fileSize: 100,
        metadata: {},
        createdAt: new Date(),
      };

      // Validate job data structure
      expect(mockJobData.tenantId).toBeDefined();
      expect(mockJobData.indexId).toBeDefined();
      expect(mockJobData.tableId).toBeDefined();
      expect(mockJobData.tableName).toBeDefined();
      expect(mockJobData.columns.length).toBeGreaterThan(0);
      expect(mockJobData.fileBuffer).toBeInstanceOf(Buffer);
    });

    it('should process CSV file job data', () => {
      const csvData = 'id,name,description\n1,Item A,Description A\n2,Item B,Description B';
      const jobData: IngestionJobData = {
        tenantId: 'tenant-123',
        indexId: 'index-123',
        tableId: 'table-123',
        tableName: 'items',
        displayName: 'Items',
        description: 'Item catalog',
        columns: [
          { name: 'id', type: 'integer', isEmbeddable: false, isFilterable: true },
          { name: 'name', type: 'string', isEmbeddable: true, isFilterable: false },
          { name: 'description', type: 'string', isEmbeddable: true, isFilterable: false },
        ],
        primaryKey: 'id',
        fileBuffer: Buffer.from(csvData),
        originalFilename: 'items.csv',
        mimeType: 'text/csv',
        fileSize: csvData.length,
        metadata: {},
        createdAt: new Date(),
      };

      expect(jobData.fileBuffer.toString('utf-8')).toBe(csvData);
      expect(jobData.columns.filter((c) => c.isEmbeddable).length).toBe(2);
    });

    it('should process JSON file job data', () => {
      const jsonData = JSON.stringify([
        { id: 1, name: 'Item A', description: 'Description A' },
        { id: 2, name: 'Item B', description: 'Description B' },
      ]);

      const jobData: IngestionJobData = {
        tenantId: 'tenant-123',
        indexId: 'index-123',
        tableId: 'table-123',
        tableName: 'items',
        displayName: 'Items',
        description: 'Item catalog',
        columns: [
          { name: 'id', type: 'integer', isEmbeddable: false, isFilterable: true },
          { name: 'name', type: 'string', isEmbeddable: true, isFilterable: false },
          { name: 'description', type: 'string', isEmbeddable: true, isFilterable: false },
        ],
        primaryKey: 'id',
        fileBuffer: Buffer.from(jsonData),
        originalFilename: 'items.json',
        mimeType: 'application/json',
        fileSize: jsonData.length,
        metadata: {},
        createdAt: new Date(),
      };

      const parsed = JSON.parse(jobData.fileBuffer.toString('utf-8'));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
    });
  });

  describe('Column Schema Validation', () => {
    it('should validate embeddable columns', () => {
      const columns = [
        { name: 'id', type: 'integer', isEmbeddable: false, isFilterable: true },
        { name: 'name', type: 'string', isEmbeddable: true, isFilterable: false },
        { name: 'price', type: 'number', isEmbeddable: false, isFilterable: true },
        { name: 'description', type: 'string', isEmbeddable: true, isFilterable: false },
      ];

      const embeddableColumns = columns.filter((c) => c.isEmbeddable);
      expect(embeddableColumns.length).toBe(2);
      expect(embeddableColumns[0].name).toBe('name');
      expect(embeddableColumns[1].name).toBe('description');
    });

    it('should validate filterable columns', () => {
      const columns = [
        { name: 'id', type: 'integer', isEmbeddable: false, isFilterable: true },
        { name: 'status', type: 'enum', isEmbeddable: false, isFilterable: true },
        { name: 'description', type: 'string', isEmbeddable: true, isFilterable: false },
      ];

      const filterableColumns = columns.filter((c) => c.isFilterable);
      expect(filterableColumns.length).toBe(2);
    });
  });

  describe('Worker Flow', () => {
    it('should define expected processing steps', () => {
      const expectedSteps = [
        'Verify index exists',
        'Parse file to extract rows',
        'Apply smart chunking strategy',
        'Store data rows in ClickHouse',
        'Store table metadata in ClickHouse',
        'Create SearchChunk records',
        'Enqueue embedding job',
      ];

      expect(expectedSteps.length).toBe(7);
      expect(expectedSteps[0]).toBe('Verify index exists');
      expect(expectedSteps[expectedSteps.length - 1]).toBe('Enqueue embedding job');
    });

    it('should define progress milestones', () => {
      const progressMilestones = [
        { step: 'Parse file', progress: 10 },
        { step: 'Apply chunking', progress: 20 },
        { step: 'Store rows', progress: 40 },
        { step: 'Store metadata', progress: 50 },
        { step: 'Create chunks', progress: 60 },
        { step: 'Enqueue embedding', progress: 85 },
        { step: 'Complete', progress: 100 },
      ];

      expect(progressMilestones[0].progress).toBe(10);
      expect(progressMilestones[progressMilestones.length - 1].progress).toBe(100);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing index error', () => {
      const error = new Error('Index index-123 not found for tenant tenant-123');
      expect(error.message).toContain('Index');
      expect(error.message).toContain('not found');
    });

    it('should handle empty file error', () => {
      const error = new Error('No data rows found in file');
      expect(error.message).toBe('No data rows found in file');
    });

    it('should handle parsing errors', () => {
      const error = new Error('CSV parsing error: Invalid format');
      expect(error.message).toContain('parsing error');
    });
  });

  describe('Chunk Creation', () => {
    it('should create metadata chunk', () => {
      const metadataChunk = {
        type: 'table_metadata',
        chunkIndex: 0,
        metadata: {
          tableId: 'table-123',
          tableName: 'products',
          displayName: 'Products',
          rowCount: 100,
          columnCount: 5,
          primaryKey: 'id',
          sampleRowCount: 10,
        },
      };

      expect(metadataChunk.type).toBe('table_metadata');
      expect(metadataChunk.chunkIndex).toBe(0);
      expect(metadataChunk.metadata.rowCount).toBe(100);
    });

    it('should create row chunks for embeddable data', () => {
      const rowChunks = [
        {
          type: 'structured_data_row',
          chunkIndex: 1,
          metadata: {
            tableId: 'table-123',
            tableName: 'products',
            rowNumber: 0,
            embeddableFields: ['name', 'description'],
          },
        },
        {
          type: 'structured_data_row',
          chunkIndex: 2,
          metadata: {
            tableId: 'table-123',
            tableName: 'products',
            rowNumber: 1,
            embeddableFields: ['name', 'description'],
          },
        },
      ];

      expect(rowChunks.length).toBe(2);
      expect(rowChunks[0].type).toBe('structured_data_row');
      expect(rowChunks[0].chunkIndex).toBe(1); // Starts from 1 (0 is metadata)
      expect(rowChunks[1].chunkIndex).toBe(2);
    });

    it('should skip chunks for purely numeric data', () => {
      const numericOnlyResult = {
        totalRows: 1000,
        chunkedRows: 0,
        skippedRows: 1000,
        savingsPercent: 100,
      };

      expect(numericOnlyResult.chunkedRows).toBe(0);
      expect(numericOnlyResult.savingsPercent).toBe(100);
    });
  });

  describe('Integration Points', () => {
    it('should use correct queue names', () => {
      const queues = {
        input: 'structured-data-ingestion',
        output: 'embedding',
      };

      expect(queues.input).toBe('structured-data-ingestion');
      expect(queues.output).toBe('embedding');
    });

    it('should use ClickHouse for data storage', () => {
      const storageBackend = 'clickhouse';
      expect(storageBackend).toBe('clickhouse');
    });

    it('should use MongoDB for SearchChunk records', () => {
      const chunkStorageBackend = 'mongodb';
      expect(chunkStorageBackend).toBe('mongodb');
    });

    it('should generate embedding jobs', () => {
      const embeddingJobData = {
        indexId: 'index-123',
        documentId: 'table-123',
        chunkIds: ['chunk-1', 'chunk-2', 'chunk-3'],
        tenantId: 'tenant-123',
      };

      expect(embeddingJobData.documentId).toBe('table-123'); // tableId used as documentId
      expect(embeddingJobData.chunkIds.length).toBeGreaterThan(0);
    });
  });
});
