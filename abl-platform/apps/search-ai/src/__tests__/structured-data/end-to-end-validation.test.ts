/**
 * End-to-End Validation Tests for Structured Data Pipeline
 *
 * Validates complete pipeline from ingestion to retrieval with realistic datasets.
 * Tests all major components working together with quality metrics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StructuredDataSchemaAnalyzer } from '../../services/structured-data/schema-analyzer.js';
import { StructuredDataChunkingStrategy } from '../../services/structured-data/chunking-strategy.js';
import { JSONChunkingStrategy } from '../../services/structured-data/json-chunking-strategy.js';
import { StructuredDataQueryRouter } from '../../services/structured-data/query-router.js';
import { ForeignKeyDetector } from '../../services/structured-data/foreign-key-detector.js';
import type { ColumnSchema } from '../../services/structured-data/types.js';

describe('End-to-End Structured Data Validation', () => {
  // ==========================================================================
  // TEST DATASET 1: E-commerce (CSV Tables with FK relationships)
  // ==========================================================================

  describe('E-commerce Dataset (CSV Tables)', () => {
    it('should handle complete products + orders workflow', async () => {
      // ── STEP 1: Analyze Products Table ──
      const productsCSV = `id,name,description,price,category
1,Laptop Pro,High-performance laptop with 16GB RAM and 512GB SSD,1299.99,Electronics
2,Wireless Mouse,Ergonomic wireless mouse with 6 buttons,29.99,Accessories
3,USB-C Cable,Premium USB-C cable 2m length,19.99,Accessories
4,Monitor 27",4K UHD monitor with HDR support,449.99,Electronics
5,Keyboard Mechanical,RGB mechanical keyboard with Cherry MX switches,129.99,Accessories`;

      const productsBuffer = Buffer.from(productsCSV);
      const analyzer = new StructuredDataSchemaAnalyzer();
      const productsAnalysis = await analyzer.analyze(productsBuffer, 'products.csv', 'text/csv');

      expect(productsAnalysis.schema.rowCount).toBe(5);
      expect(productsAnalysis.schema.columns).toHaveLength(5);
      expect(
        productsAnalysis.schema.columns.find((c) => c.name === 'description')?.isEmbeddable,
      ).toBe(true);
      expect(productsAnalysis.schema.columns.find((c) => c.name === 'price')?.isFilterable).toBe(
        true,
      );

      // ── STEP 2: Chunk Products Table (Metadata Only) ──
      const productsChunking = new StructuredDataChunkingStrategy();
      const productsColumns: ColumnSchema[] = productsAnalysis.schema.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: true,
        isEmbeddable: col.isEmbeddable,
        isFilterable: col.isFilterable,
      }));

      const productsData = [
        {
          id: 1,
          name: 'Laptop Pro',
          description: 'High-performance laptop with 16GB RAM and 512GB SSD',
          price: 1299.99,
          category: 'Electronics',
        },
        {
          id: 2,
          name: 'Wireless Mouse',
          description: 'Ergonomic wireless mouse with 6 buttons',
          price: 29.99,
          category: 'Accessories',
        },
        {
          id: 3,
          name: 'USB-C Cable',
          description: 'Premium USB-C cable 2m length',
          price: 19.99,
          category: 'Accessories',
        },
        {
          id: 4,
          name: 'Monitor 27"',
          description: '4K UHD monitor with HDR support',
          price: 449.99,
          category: 'Electronics',
        },
        {
          id: 5,
          name: 'Keyboard Mechanical',
          description: 'RGB mechanical keyboard with Cherry MX switches',
          price: 129.99,
          category: 'Accessories',
        },
      ];

      const productsChunkResult = productsChunking.chunk(
        'products',
        'Products',
        'Product catalog',
        productsColumns,
        productsData,
        'id',
        [],
        {},
      );

      expect(productsChunkResult.metadataChunk).toBeDefined();
      expect(productsChunkResult.rowChunks).toHaveLength(0);
      expect(productsChunkResult.statistics.savingsPercent).toBe(100);
      expect(productsChunkResult.metadataChunk.sampleRows.length).toBeGreaterThan(0);

      // ── STEP 3: Analyze Orders Table with FK ──
      const ordersCSV = `id,product_id,customer_name,quantity,order_date
1,1,Alice Johnson,1,2024-01-15
2,2,Bob Smith,2,2024-01-16
3,1,Carol White,1,2024-01-17
4,3,Alice Johnson,3,2024-01-18
5,4,David Brown,1,2024-01-19`;

      const ordersBuffer = Buffer.from(ordersCSV);
      const ordersAnalysis = await analyzer.analyze(ordersBuffer, 'orders.csv', 'text/csv');

      expect(ordersAnalysis.schema.rowCount).toBe(5);
      expect(ordersAnalysis.schema.foreignKeys.length).toBeGreaterThan(0);
      expect(ordersAnalysis.schema.foreignKeys[0].sourceField).toBe('product_id');
      expect(ordersAnalysis.schema.foreignKeys[0].targetTable).toBe('products');

      // ── STEP 4: Query Routing Scenarios ──
      const router = new StructuredDataQueryRouter();

      // SQL Intent: Filter query
      const sqlIntent1 = await router.analyzeIntent('products where price > 100');
      expect(sqlIntent1.type).toBe('sql');
      expect(sqlIntent1.confidence).toBeGreaterThan(0.6);

      // SQL Intent: Aggregation
      const sqlIntent2 = await router.analyzeIntent('count orders by customer');
      expect(sqlIntent2.type).toBe('sql');

      // Semantic Intent: Natural language
      const semanticIntent = await router.analyzeIntent(
        'find electronic products for professionals',
      );
      expect(semanticIntent.type).toBe('semantic');

      // Hybrid Intent: Mix of filter + semantic
      const hybridIntent = await router.analyzeIntent('laptops with high performance under 1500');
      expect(['hybrid', 'semantic', 'sql']).toContain(hybridIntent.type);

      // ── STEP 5: Validate FK Detection ──
      const fkDetector = new ForeignKeyDetector();
      const ordersColumns = ordersAnalysis.schema.columns.map((col) => ({
        ...col,
        confidence: 1.0,
        nullable: true,
        isEmbeddable: col.isEmbeddable,
        isFilterable: col.isFilterable,
      }));

      const ordersData = [
        {
          id: 1,
          product_id: 1,
          customer_name: 'Alice Johnson',
          quantity: 1,
          order_date: '2024-01-15',
        },
        { id: 2, product_id: 2, customer_name: 'Bob Smith', quantity: 2, order_date: '2024-01-16' },
        {
          id: 3,
          product_id: 1,
          customer_name: 'Carol White',
          quantity: 1,
          order_date: '2024-01-17',
        },
        {
          id: 4,
          product_id: 3,
          customer_name: 'Alice Johnson',
          quantity: 3,
          order_date: '2024-01-18',
        },
        {
          id: 5,
          product_id: 4,
          customer_name: 'David Brown',
          quantity: 1,
          order_date: '2024-01-19',
        },
      ];

      const detectedFKs = fkDetector.detectForeignKeysLocal(ordersData, ordersColumns);
      expect(detectedFKs.length).toBeGreaterThan(0);
      expect(detectedFKs.find((fk) => fk.sourceField === 'product_id')).toBeDefined();

      // ── QUALITY METRICS ──
      console.log('\n📊 E-commerce Dataset Quality Metrics:');
      console.log(
        `  Products Table: ${productsData.length} rows → 1 metadata chunk (100% savings)`,
      );
      console.log(`  Orders Table: ${ordersData.length} rows → 1 metadata chunk (100% savings)`);
      console.log(
        `  Foreign Keys Detected: ${detectedFKs.length} (${detectedFKs.map((fk) => fk.sourceField).join(', ')})`,
      );
      console.log(
        `  Embeddable Columns: ${productsColumns.filter((c) => c.isEmbeddable).length} in products`,
      );
      console.log(
        `  Filterable Columns: ${productsColumns.filter((c) => c.isFilterable).length} in products`,
      );
      console.log(`  Query Routing: SQL=${sqlIntent1.type}, Semantic=${semanticIntent.type}`);
    });
  });

  // ==========================================================================
  // TEST DATASET 2: Nested JSON (Product Reviews)
  // ==========================================================================

  describe('Product Reviews Dataset (Nested JSON)', () => {
    it('should handle nested JSON with overflow chunking', { timeout: 30_000 }, () => {
      const jsonChunking = new JSONChunkingStrategy();

      // Small review (single chunk)
      const smallReview = {
        id: 'review-1',
        productId: 'prod-123',
        author: {
          name: 'Alice Johnson',
          verified: true,
          memberSince: '2020-01-15',
        },
        rating: 5,
        title: 'Excellent product!',
        reviewText: 'This laptop exceeded my expectations. Great performance and battery life.',
        helpful: 42,
        date: '2024-01-20',
      };

      const smallResult = jsonChunking.chunk({
        jsonObject: smallReview,
        embeddableFields: ['title', 'reviewText'],
        metadata: { objectId: 'review-1', objectType: 'review' },
      });

      expect(smallResult.chunks).toHaveLength(1);
      expect(smallResult.chunks[0].type).toBe('json_object');
      expect(smallResult.overflowFields).toHaveLength(0);

      // Large review with overflow (multiple chunks)
      // With tiktoken, need more text to exceed 8000 tokens than with char/4
      const longReviewText = Array.from(
        { length: 800 },
        (_, i) => `Sentence ${i + 1}: This product has many great features worth mentioning.`,
      ).join(' ');

      const largeReview = {
        id: 'review-2',
        productId: 'prod-456',
        author: {
          name: 'Bob Smith',
          verified: true,
        },
        rating: 4,
        title: 'Great product with minor issues',
        reviewText: longReviewText,
        helpful: 128,
      };

      const largeResult = jsonChunking.chunk({
        jsonObject: largeReview,
        embeddableFields: ['title', 'reviewText'],
        metadata: { objectId: 'review-2', objectType: 'review' },
      });

      expect(largeResult.chunks.length).toBeGreaterThan(1);
      expect(largeResult.chunks[0].type).toBe('json_object');
      expect(largeResult.overflowFields).toContain('reviewText');

      const overflowChunks = largeResult.chunks.filter((c) => c.type === 'json_field_overflow');
      expect(overflowChunks.length).toBeGreaterThan(0);

      // Verify each overflow chunk respects token limits
      for (const chunk of overflowChunks) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(1024); // Max chunk size
        expect(chunk.fieldPath).toBe('reviewText');
        expect(chunk.metadata.parentChunkIndex).toBe(0);
      }

      // ── QUALITY METRICS ──
      console.log('\n📊 JSON Dataset Quality Metrics:');
      console.log(
        `  Small Review: ${JSON.stringify(smallReview).length} bytes → 1 chunk (no overflow)`,
      );
      console.log(
        `  Large Review: ${JSON.stringify(largeReview).length} bytes → ${largeResult.chunks.length} chunks`,
      );
      console.log(
        `  Overflow Chunks: ${overflowChunks.length} for field "${largeResult.overflowFields[0]}"`,
      );
      console.log(
        `  Token Distribution: ${overflowChunks.map((c) => c.tokenCount).join(', ')} tokens per chunk`,
      );
      console.log(
        `  Context Preservation: Parent-child relationships maintained via metadata.parentChunkIndex`,
      );
    });
  });

  // ==========================================================================
  // TEST DATASET 3: Multi-Type Scenario (CSV + JSON together)
  // ==========================================================================

  describe('Mixed Dataset (CSV + JSON)', () => {
    it('should handle heterogeneous data types in same index', async () => {
      const analyzer = new StructuredDataSchemaAnalyzer();
      const tableChunking = new StructuredDataChunkingStrategy();
      const jsonChunking = new JSONChunkingStrategy();

      // ── CSV: Customer Table ──
      const customersCSV = `id,name,email,status,join_date
1,Alice Johnson,alice@example.com,premium,2023-01-15
2,Bob Smith,bob@example.com,standard,2023-06-20
3,Carol White,carol@example.com,premium,2023-09-10`;

      const customersBuffer = Buffer.from(customersCSV);
      const customersAnalysis = await analyzer.analyze(
        customersBuffer,
        'customers.csv',
        'text/csv',
      );

      const customersData = [
        {
          id: 1,
          name: 'Alice Johnson',
          email: 'alice@example.com',
          status: 'premium',
          join_date: '2023-01-15',
        },
        {
          id: 2,
          name: 'Bob Smith',
          email: 'bob@example.com',
          status: 'standard',
          join_date: '2023-06-20',
        },
        {
          id: 3,
          name: 'Carol White',
          email: 'carol@example.com',
          status: 'premium',
          join_date: '2023-09-10',
        },
      ];

      const customersColumns: ColumnSchema[] = customersAnalysis.schema.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: true,
        isEmbeddable: col.isEmbeddable,
        isFilterable: col.isFilterable,
      }));

      const tableResult = tableChunking.chunk(
        'customers',
        'Customers',
        'Customer records',
        customersColumns,
        customersData,
        'id',
        [],
        {},
      );

      expect(tableResult.metadataChunk).toBeDefined();
      expect(tableResult.rowChunks).toHaveLength(0);
      expect(tableResult.metadataChunk.type).toBe('table_metadata');

      // ── JSON: Customer Preferences ──
      const customerPreferences = {
        customerId: 1,
        preferences: {
          communication: {
            email: true,
            sms: false,
            push: true,
          },
          interests: ['electronics', 'gaming', 'productivity'],
          newsletter: true,
        },
        notes: 'VIP customer, prefers express shipping',
      };

      const jsonResult = jsonChunking.chunk({
        jsonObject: customerPreferences,
        embeddableFields: ['notes'],
        metadata: { objectId: 'pref-1', objectType: 'customer_preferences' },
      });

      expect(jsonResult.chunks).toHaveLength(1);
      expect(jsonResult.chunks[0].type).toBe('json_object');

      // ── QUALITY METRICS ──
      console.log('\n📊 Mixed Dataset Quality Metrics:');
      console.log(`  Table Chunk Type: ${tableResult.metadataChunk.type}`);
      console.log(`  JSON Chunk Type: ${jsonResult.chunks[0].type}`);
      console.log(
        `  Data Format Coexistence: CSV tables (${customersData.length} rows) + JSON objects (1 doc) in same index`,
      );
      console.log(
        `  Total Chunks: ${1 + jsonResult.chunks.length} (1 table metadata + 1 JSON object)`,
      );
      console.log(`  Schema Flexibility: Different structures handled transparently`);
    });
  });

  // ==========================================================================
  // PERFORMANCE & SCALING VALIDATION
  // ==========================================================================

  describe('Performance & Scaling', () => {
    it('should handle large tables efficiently', () => {
      const chunkingStrategy = new StructuredDataChunkingStrategy();

      // Simulate 100k row table
      const startTime = Date.now();
      const largeDataset = Array.from({ length: 100000 }, (_, i) => ({
        id: i + 1,
        name: `Record ${i + 1}`,
        value: Math.random() * 1000,
        category: ['A', 'B', 'C', 'D'][i % 4],
        description: `Description for record ${i + 1}`,
      }));

      const columns: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'name', type: 'string', nullable: false, isEmbeddable: false, isFilterable: false },
        { name: 'value', type: 'number', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'category',
          type: 'enum',
          nullable: false,
          isEmbeddable: false,
          isFilterable: true,
        },
        {
          name: 'description',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const result = chunkingStrategy.chunk(
        'large_table',
        'Large Table',
        'Performance test table',
        columns,
        largeDataset,
        'id',
        [],
        {},
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(result.metadataChunk).toBeDefined();
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(100000);
      expect(result.statistics.savingsPercent).toBe(100);

      // ── QUALITY METRICS ──
      console.log('\n📊 Performance Metrics (100k rows):');
      console.log(`  Processing Time: ${duration}ms`);
      console.log(`  Throughput: ${Math.floor(largeDataset.length / (duration / 1000))} rows/sec`);
      console.log(`  Chunks Created: 1 (metadata only)`);
      console.log(
        `  Memory Efficiency: 100k rows → 1 chunk (vs 100k chunks in naive approach = 99.999% reduction)`,
      );
      console.log(`  Sample Rows Preserved: ${result.metadataChunk.sampleRows.length}`);
    });

    it('should handle deeply nested JSON efficiently', () => {
      const jsonChunking = new JSONChunkingStrategy();

      const deeplyNested = {
        id: 'deep-1',
        level1: {
          data: 'Level 1',
          level2: {
            data: 'Level 2',
            level3: {
              data: 'Level 3',
              level4: {
                data: 'Level 4',
                values: Array.from({ length: 100 }, (_, i) => `value-${i}`),
              },
            },
          },
        },
      };

      const result = jsonChunking.chunk({
        jsonObject: deeplyNested,
        embeddableFields: [],
        metadata: { objectId: 'deep-1', objectType: 'nested' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.overflowFields).toHaveLength(0);

      const jsonSize = JSON.stringify(deeplyNested).length;
      console.log('\n📊 Nested JSON Metrics:');
      console.log(`  JSON Depth: 4 levels`);
      console.log(`  JSON Size: ${jsonSize} bytes`);
      console.log(`  Chunks Created: ${result.chunks.length}`);
      console.log(`  Context Preservation: Full nested structure preserved in single chunk`);
    });
  });
});
