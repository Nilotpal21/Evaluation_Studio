/**
 * Integration Tests for Structured Data Pipeline
 *
 * Tests the complete flow:
 * 1. Schema analysis
 * 2. Table chunking (metadata only)
 * 3. JSON chunking (with overflow)
 * 4. Query routing (SQL vs Semantic)
 * 5. Text-to-SQL generation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StructuredDataSchemaAnalyzer } from '../../services/structured-data/schema-analyzer.js';
import { StructuredDataChunkingStrategy } from '../../services/structured-data/chunking-strategy.js';
import { JSONChunkingStrategy } from '../../services/structured-data/json-chunking-strategy.js';
import { StructuredDataQueryRouter } from '../../services/structured-data/query-router.js';
import { TextToSQLService } from '../../services/structured-data/text-to-sql.js';
import type { ColumnSchema } from '../../services/structured-data/types.js';

// Mock LLM dependencies
vi.mock('@agent-platform/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database')>();
  return {
    ...actual,
    LLMCredential: {
      findOne: vi.fn().mockResolvedValue({
        provider: 'anthropic',
        encryptedApiKey: 'test-api-key',
      }),
    },
  };
});

// Mock db/index.js for the current dual-DB adapter contract.
// Table discovery reads SearchChunk via getLazyModel(), while TextToSQLService
// now resolves LLMCredential through getModel().
vi.mock('../../db/index.js', () => {
  const lazySearchChunkModel = {
    find: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  const llmCredentialModel = {
    findOne: vi.fn().mockResolvedValue({
      provider: 'anthropic',
      encryptedApiKey: 'test-api-key',
    }),
  };

  return {
    getLazyModel: (name: string) => {
      if (name === 'SearchChunk') {
        return lazySearchChunkModel;
      }

      return {};
    },
    getModel: (name: string) => {
      if (name === 'LLMCredential') {
        return llmCredentialModel;
      }

      return {};
    },
  };
});

vi.mock('@abl/compiler/platform/llm', () => ({
  LLMClient: class {
    chat = vi
      .fn()
      .mockResolvedValue(
        'This query retrieves products.\n```sql\nSELECT id, name, price FROM products WHERE price > 50 LIMIT 10\n```',
      );
  },
}));

describe('Structured Data Integration Tests', () => {
  describe('CSV/Table Pipeline', () => {
    it('should process CSV data through complete pipeline', async () => {
      // Step 1: Schema analysis
      const analyzer = new StructuredDataSchemaAnalyzer();
      const csvData = `id,name,price,category
1,Widget A,29.99,Electronics
2,Widget B,49.99,Electronics
3,Gadget C,19.99,Home`;

      const buffer = Buffer.from(csvData);
      const analysis = await analyzer.analyze(buffer, 'products.csv', 'text/csv');

      expect(analysis.schema.tableName).toBe('products');
      expect(analysis.schema.columns).toHaveLength(4);
      expect(analysis.schema.rowCount).toBe(3);

      // Step 2: Table chunking (metadata only, no row chunks)
      const chunkingStrategy = new StructuredDataChunkingStrategy();
      const columnSchemas: ColumnSchema[] = analysis.schema.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: true,
        isEmbeddable: col.isEmbeddable,
        isFilterable: col.isFilterable,
      }));

      const rows = [
        { id: 1, name: 'Widget A', price: 29.99, category: 'Electronics' },
        { id: 2, name: 'Widget B', price: 49.99, category: 'Electronics' },
        { id: 3, name: 'Gadget C', price: 19.99, category: 'Home' },
      ];

      const chunkingResult = chunkingStrategy.chunk(
        'products',
        'Products',
        'Product catalog',
        columnSchemas,
        rows,
        'id',
        [],
        {},
      );

      // Should create ONLY metadata chunk, no row chunks
      expect(chunkingResult.metadataChunk).toBeDefined();
      expect(chunkingResult.rowChunks).toHaveLength(0);
      expect(chunkingResult.statistics.savingsPercent).toBe(100);

      // Step 3: Query routing
      const queryRouter = new StructuredDataQueryRouter();

      // SQL intent for filter query
      const sqlIntent = await queryRouter.analyzeIntent('products where price > 40');
      expect(sqlIntent.type).toBe('sql');
      expect(sqlIntent.confidence).toBeGreaterThan(0.6);

      // Semantic intent for text search
      const semanticIntent = await queryRouter.analyzeIntent('find electronics products');
      expect(semanticIntent.type).toBe('semantic');
    });

    it('should handle large CSV tables efficiently', async () => {
      // Simulate 10k row table
      const rows = Array.from({ length: 10000 }, (_, i) => ({
        id: i + 1,
        name: `Product ${i + 1}`,
        price: Math.random() * 100,
        description: `Description for product ${i + 1}`,
      }));

      const columnSchemas: ColumnSchema[] = [
        { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
        { name: 'name', type: 'string', nullable: false, isEmbeddable: true, isFilterable: false },
        { name: 'price', type: 'number', nullable: false, isEmbeddable: false, isFilterable: true },
        {
          name: 'description',
          type: 'string',
          nullable: false,
          isEmbeddable: true,
          isFilterable: false,
        },
      ];

      const chunkingStrategy = new StructuredDataChunkingStrategy();
      const result = chunkingStrategy.chunk(
        'large_products',
        'Large Products',
        'Large product catalog',
        columnSchemas,
        rows,
        'id',
        [],
        {},
      );

      // Only 1 metadata chunk for 10k rows
      expect(result.metadataChunk).toBeDefined();
      expect(result.rowChunks).toHaveLength(0);
      expect(result.statistics.totalRows).toBe(10000);
      expect(result.statistics.chunkedRows).toBe(0);
      expect(result.statistics.savingsPercent).toBe(100);

      // Metadata chunk should have sample rows
      expect(result.metadataChunk.sampleRows.length).toBeGreaterThan(0);
      expect(result.metadataChunk.sampleRows.length).toBeLessThanOrEqual(20);
    });
  });

  describe('JSON Object Pipeline', () => {
    it('should process small JSON objects as single chunk', () => {
      const jsonChunking = new JSONChunkingStrategy();

      const jsonObject = {
        id: 'prod-123',
        title: 'Premium Wireless Headphones',
        description: 'High-quality wireless headphones with noise cancellation',
        price: 299.99,
        brand: 'AudioTech',
        category: 'Electronics',
        features: ['Bluetooth 5.0', 'Active Noise Cancellation', '30h Battery Life'],
      };

      const result = jsonChunking.chunk({
        jsonObject,
        embeddableFields: ['title', 'description'],
        metadata: { objectId: 'prod-123', objectType: 'product' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].type).toBe('json_object');
      expect(result.overflowFields).toHaveLength(0);
      expect(result.statistics.objectChunks).toBe(1);
      expect(result.statistics.overflowChunks).toBe(0);
    });

    it(
      'should handle JSON with overflow fields using sentence alignment',
      { timeout: 30_000 },
      () => {
        const jsonChunking = new JSONChunkingStrategy();

        // Create a review with very long text (>8k tokens)
        const longReviewText = Array.from(
          { length: 500 },
          (_, i) =>
            `This is review sentence ${i + 1} describing the product in great detail with specific observations and user experience.`,
        ).join(' ');

        const jsonObject = {
          id: 'review-456',
          productId: 'prod-123',
          author: 'John Doe',
          rating: 5,
          reviewText: longReviewText, // Large field
          helpful: 42,
          date: '2024-01-15',
        };

        const result = jsonChunking.chunk({
          jsonObject,
          embeddableFields: ['reviewText'],
          metadata: { objectId: 'review-456', objectType: 'review' },
        });

        // Should have metadata chunk + multiple text chunks
        expect(result.chunks.length).toBeGreaterThan(1);
        expect(result.chunks[0].type).toBe('json_object');
        expect(result.chunks[0].content).toContain('[Large field - see separate chunks]');

        const overflowChunks = result.chunks.filter((c) => c.type === 'json_field_overflow');
        expect(overflowChunks.length).toBeGreaterThan(0);
        expect(result.overflowFields).toContain('reviewText');
        expect(result.statistics.overflowChunks).toBeGreaterThan(0);

        // Each overflow chunk should be reasonably sized
        for (const chunk of overflowChunks) {
          expect(chunk.tokenCount).toBeLessThanOrEqual(1024); // Max chunk size
          expect(chunk.fieldPath).toBe('reviewText');
          expect(chunk.metadata.parentChunkIndex).toBe(0);
        }
      },
    );

    it('should handle array of JSON objects', () => {
      const jsonChunking = new JSONChunkingStrategy();

      const products = [
        {
          id: 'p1',
          name: 'Product 1',
          description: 'First product description',
          price: 10.99,
        },
        {
          id: 'p2',
          name: 'Product 2',
          description: 'Second product description',
          price: 20.99,
        },
        {
          id: 'p3',
          name: 'Product 3',
          description: 'Third product description',
          price: 30.99,
        },
      ];

      // Chunk each object separately
      const results = products.map((product) =>
        jsonChunking.chunk({
          jsonObject: product,
          embeddableFields: ['name', 'description'],
          metadata: { objectId: product.id, objectType: 'product' },
        }),
      );

      // Each product should be 1 chunk
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.chunks).toHaveLength(1);
        expect(result.overflowFields).toHaveLength(0);
      });
    });
  });

  describe('Query Routing Integration', () => {
    it('should route SQL queries correctly', async () => {
      const router = new StructuredDataQueryRouter();

      const sqlQueries = [
        'products where price > 100',
        'count products by category',
        'average price of electronics',
        'orders between 2024-01-01 and 2024-12-31',
        'sum of revenue by month',
      ];

      for (const query of sqlQueries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('sql');
        expect(intent.confidence).toBeGreaterThan(0.5);
      }
    });

    it('should route semantic queries correctly', async () => {
      const router = new StructuredDataQueryRouter();

      const semanticQueries = [
        'find products similar to wireless mouse',
        'search for items described as waterproof',
        'look for electronics with bluetooth',
        'products like noise cancelling headphones',
      ];

      for (const query of semanticQueries) {
        const intent = await router.analyzeIntent(query);
        expect(intent.type).toBe('semantic');
        expect(intent.confidence).toBeGreaterThan(0.5);
      }
    });

    it('should detect hybrid queries', async () => {
      const router = new StructuredDataQueryRouter();

      const hybridQueries = [
        'find "wireless" products where price < 100',
        'search for "bluetooth" items with rating > 4',
      ];

      for (const query of hybridQueries) {
        const intent = await router.analyzeIntent(query);
        expect(['hybrid', 'sql']).toContain(intent.type);
        expect(intent.reasoning).toBeDefined();
      }
    });
  });

  describe('Text-to-SQL Integration', () => {
    it('should generate SQL from natural language', async () => {
      const textToSQL = new TextToSQLService();

      const mockTable = {
        table_id: 'table-123',
        table_name: 'products',
        display_name: 'Products',
        tenant_id: 'tenant-123',
        index_id: 'index-123',
        columns: JSON.stringify(['id', 'name', 'price', 'category']),
        column_types: JSON.stringify(['integer', 'string', 'number', 'string']),
        column_descriptions: JSON.stringify({
          id: 'Product ID',
          name: 'Product name',
          price: 'Price in USD',
          category: 'Product category',
        }),
        primary_key: 'id',
        row_count: 100,
        table_description: 'Product catalog',
        statistics: '{}',
        sample_rows: JSON.stringify([
          { id: 1, name: 'Widget A', price: 29.99, category: 'Electronics' },
        ]),
        foreign_keys: '[]',
        searchable_text: 'products catalog',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const result = await textToSQL.generateSQL({
        query: 'products where price > 50',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.sql).toBeDefined();
      expect(result.sql).toMatch(/SELECT/i);
      expect(result.sql).toContain('LIMIT');
      expect(result.explanation).toBeDefined();
      expect(result.tablesReferenced).toContain('products');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should handle complex queries with joins and aggregations', async () => {
      const textToSQL = new TextToSQLService();

      const productsTable = {
        table_id: 'table-1',
        table_name: 'products',
        display_name: 'Products',
        tenant_id: 'tenant-123',
        index_id: 'index-123',
        columns: JSON.stringify(['id', 'name', 'price', 'category_id']),
        column_types: JSON.stringify(['integer', 'string', 'number', 'integer']),
        column_descriptions: JSON.stringify({}),
        primary_key: 'id',
        row_count: 100,
        table_description: 'Product catalog',
        statistics: '{}',
        sample_rows: '[]',
        foreign_keys: '[]',
        searchable_text: 'products',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const categoriesTable = {
        table_id: 'table-2',
        table_name: 'categories',
        display_name: 'Categories',
        tenant_id: 'tenant-123',
        index_id: 'index-123',
        columns: JSON.stringify(['id', 'name']),
        column_types: JSON.stringify(['integer', 'string']),
        column_descriptions: JSON.stringify({}),
        primary_key: 'id',
        row_count: 10,
        table_description: 'Product categories',
        statistics: '{}',
        sample_rows: '[]',
        foreign_keys: '[]',
        searchable_text: 'categories',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const result = await textToSQL.generateSQL({
        query: 'count products by category',
        tables: [productsTable, categoriesTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(result.sql).toBeDefined();
      expect(result.sql).toMatch(/SELECT/i);
      expect(result.sql).not.toMatch(/DROP|DELETE|UPDATE|INSERT/i);
      expect(result.warnings).toBeDefined();
    });
  });

  describe('Table Discovery Integration', () => {
    it('should discover tables and route to text-to-SQL', async () => {
      // Mock table discovery setup
      const mockTables = [
        {
          table_id: 'table-products',
          table_name: 'products',
          display_name: 'Products',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'name', 'price']),
          column_types: JSON.stringify(['integer', 'string', 'number']),
          column_descriptions: JSON.stringify({
            id: 'Product ID',
            name: 'Product name',
            price: 'Price in USD',
          }),
          primary_key: 'id',
          row_count: 100,
          table_description: 'Product catalog',
          statistics: '{}',
          sample_rows: JSON.stringify([{ id: 1, name: 'Widget A', price: 29.99 }]),
          foreign_keys: '[]',
          searchable_text: 'products catalog name price',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      // Mock ClickHouse client
      const mockCHClient = {
        getTableMetadata: vi.fn().mockResolvedValue(mockTables),
        initialize: vi.fn(),
      };

      const { TableDiscoveryService } =
        await import('../../services/structured-data/table-discovery.js');
      const discovery = new TableDiscoveryService(mockCHClient as any);

      // Step 1: Discover tables for query
      const discoveryResult = await discovery.discoverTables({
        query: 'products with price greater than 50',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(discoveryResult.tables.length).toBeGreaterThan(0);
      expect(discoveryResult.tables[0].metadata.table_name).toBe('products');

      // Step 2: Route query
      const queryRouter = new StructuredDataQueryRouter();
      const intent = await queryRouter.analyzeIntent('products with price greater than 50');

      expect(intent.type).toBe('sql');

      // Step 3: Generate SQL using discovered tables
      const textToSQL = new TextToSQLService();
      const sqlResult = await textToSQL.generateSQL({
        query: 'products with price greater than 50',
        tables: discoveryResult.tables.map((t) => t.metadata),
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(sqlResult.sql).toBeDefined();
      expect(sqlResult.sql).toMatch(/SELECT/i);
      expect(sqlResult.tablesReferenced).toContain('products');
    });

    it('should handle multi-table discovery for join queries', async () => {
      const mockTables = [
        {
          table_id: 'table-orders',
          table_name: 'orders',
          display_name: 'Orders',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'customer_id', 'total']),
          column_types: JSON.stringify(['integer', 'integer', 'number']),
          column_descriptions: JSON.stringify({}),
          primary_key: 'id',
          row_count: 500,
          table_description: 'Customer orders',
          statistics: '{}',
          sample_rows: '[]',
          foreign_keys: '[]',
          searchable_text: 'orders customer total',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          table_id: 'table-customers',
          table_name: 'customers',
          display_name: 'Customers',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'name', 'email']),
          column_types: JSON.stringify(['integer', 'string', 'string']),
          column_descriptions: JSON.stringify({}),
          primary_key: 'id',
          row_count: 200,
          table_description: 'Customer records',
          statistics: '{}',
          sample_rows: '[]',
          foreign_keys: '[]',
          searchable_text: 'customers name email',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const mockCHClient = {
        getTableMetadata: vi.fn().mockResolvedValue(mockTables),
        initialize: vi.fn(),
      };

      const { TableDiscoveryService } =
        await import('../../services/structured-data/table-discovery.js');
      const discovery = new TableDiscoveryService(mockCHClient as any);

      const discoveryResult = await discovery.discoverTables({
        query: 'join orders and customers',
        tenantId: 'tenant-123',
        indexId: 'index-123',
      });

      expect(discoveryResult.tables.length).toBe(2);
      expect(discoveryResult.queryAnalysis.intent).toBe('multi_table');
      expect(discoveryResult.tables.map((t) => t.metadata.table_name)).toContain('orders');
      expect(discoveryResult.tables.map((t) => t.metadata.table_name)).toContain('customers');
    });
  });

  describe('End-to-End Scenarios', () => {
    it('should handle complete CSV ingestion and query flow', async () => {
      // 1. Analyze CSV
      const analyzer = new StructuredDataSchemaAnalyzer();
      const csvData = `id,product,price,stock
1,Laptop,999.99,10
2,Mouse,29.99,50
3,Keyboard,79.99,30`;

      const buffer = Buffer.from(csvData);
      const analysis = await analyzer.analyze(buffer, 'inventory.csv', 'text/csv');

      expect(analysis.schema.tableName).toBe('inventory');
      expect(analysis.schema.rowCount).toBe(3);

      // 2. Create chunks (metadata only)
      const chunkingStrategy = new StructuredDataChunkingStrategy();
      const columnSchemas: ColumnSchema[] = analysis.schema.columns.map((col) => ({
        name: col.name,
        type: col.type,
        nullable: true,
        isEmbeddable: col.isEmbeddable,
        isFilterable: col.isFilterable,
      }));

      const chunkingResult = chunkingStrategy.chunk(
        'inventory',
        'Inventory',
        'Product inventory',
        columnSchemas,
        [
          { id: 1, product: 'Laptop', price: 999.99, stock: 10 },
          { id: 2, product: 'Mouse', price: 29.99, stock: 50 },
          { id: 3, product: 'Keyboard', price: 79.99, stock: 30 },
        ],
        'id',
        [],
        {},
      );

      expect(chunkingResult.rowChunks).toHaveLength(0);
      expect(chunkingResult.metadataChunk).toBeDefined();

      // 3. Route query
      const router = new StructuredDataQueryRouter();
      const intent = await router.analyzeIntent('products with low stock');

      // Could be semantic or SQL depending on interpretation
      expect(['semantic', 'sql']).toContain(intent.type);

      // 4. If SQL, generate query
      if (intent.type === 'sql') {
        const textToSQL = new TextToSQLService();
        const mockTable = {
          table_id: 'table-inv',
          table_name: 'inventory',
          display_name: 'Inventory',
          tenant_id: 'tenant-123',
          index_id: 'index-123',
          columns: JSON.stringify(['id', 'product', 'price', 'stock']),
          column_types: JSON.stringify(['integer', 'string', 'number', 'integer']),
          column_descriptions: JSON.stringify({}),
          primary_key: 'id',
          row_count: 3,
          table_description: 'Product inventory',
          statistics: '{}',
          sample_rows: JSON.stringify(chunkingResult.metadataChunk.sampleRows),
          foreign_keys: '[]',
          searchable_text: 'inventory products',
          created_at: new Date(),
          updated_at: new Date(),
        };

        const sqlResult = await textToSQL.generateSQL({
          query: 'products with low stock',
          tables: [mockTable],
          tenantId: 'tenant-123',
          indexId: 'index-123',
        });

        expect(sqlResult.sql).toBeDefined();
        expect(sqlResult.sql).toMatch(/SELECT/i);
      }
    });

    it('should handle mixed structured data types in same index', () => {
      // Scenario: Index with both CSV tables and JSON objects
      const tableChunking = new StructuredDataChunkingStrategy();
      const jsonChunking = new JSONChunkingStrategy();

      // CSV table
      const tableResult = tableChunking.chunk(
        'orders',
        'Orders',
        'Order records',
        [
          { name: 'id', type: 'integer', nullable: false, isEmbeddable: false, isFilterable: true },
          {
            name: 'customer',
            type: 'string',
            nullable: false,
            isEmbeddable: true,
            isFilterable: false,
          },
        ],
        [
          { id: 1, customer: 'Alice' },
          { id: 2, customer: 'Bob' },
        ],
        'id',
        [],
        {},
      );

      // JSON object
      const jsonResult = jsonChunking.chunk({
        jsonObject: {
          id: 'cust-1',
          name: 'Alice',
          email: 'alice@example.com',
          preferences: { newsletter: true, notifications: true },
        },
        embeddableFields: ['name'],
        metadata: { objectId: 'cust-1', objectType: 'customer' },
      });

      // Both should produce chunks
      expect(tableResult.metadataChunk).toBeDefined();
      expect(tableResult.rowChunks).toHaveLength(0);
      expect(jsonResult.chunks).toHaveLength(1);

      // Different chunk types
      expect(tableResult.metadataChunk.type).toBe('table_metadata');
      expect(jsonResult.chunks[0].type).toBe('json_object');
    });
  });
});
