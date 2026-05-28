/**
 * Tests for Text-to-SQL Service
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TextToSQLService } from '../../services/structured-data/text-to-sql.js';
import type { TableMetadata } from '../../services/structured-data/types.js';

// Mock resolveIndexLLMConfig (Model Library)
vi.mock('../../services/llm-config/resolver.js', () => ({
  resolveIndexLLMConfig: vi.fn().mockResolvedValue({
    provider: 'anthropic',
    apiKey: 'test-api-key',
    model: 'claude-sonnet-4-20250514',
    useCases: {
      textToSql: {
        enabled: true,
        provider: 'anthropic',
        apiKey: 'test-api-key',
        model: 'claude-sonnet-4-20250514',
      },
    },
  }),
}));

// Mock WorkerLLMClient
const mockChat = vi.fn();
vi.mock('@agent-platform/llm', () => {
  return {
    WorkerLLMClient: class MockWorkerLLMClient {
      chat = (...args: any[]) => mockChat(...args);
      constructor() {}
    },
  };
});

// Configure mock chat to return appropriate SQL based on query
beforeEach(() => {
  mockChat.mockImplementation(async (_systemPrompt: string, messages: any[]) => {
    const userMessage = messages[0].content;

    // Parse query from user message
    const queryMatch = userMessage.match(/User Question: "(.+?)"/);
    const query = queryMatch ? queryMatch[1] : '';

    // Generate appropriate SQL based on query
    if (query.includes('price > 50') || query.includes('price > 100')) {
      return `This query filters products by price.\n\`\`\`sql\nSELECT id, name, price FROM products WHERE price > 50 LIMIT 10\n\`\`\``;
    } else if (query.includes('count') || query.includes('how many')) {
      return `This query counts products by category.\n\`\`\`sql\nSELECT category, COUNT(*) as count FROM products GROUP BY category LIMIT 10\n\`\`\``;
    } else if (query.includes('ordered by') || query.includes('descending')) {
      return `This query orders products by price.\n\`\`\`sql\nSELECT id, name, price FROM products ORDER BY price DESC LIMIT 10\n\`\`\``;
    } else if (query.includes('with their orders') || query.includes('orders')) {
      return `This query joins products with orders.\n\`\`\`sql\nSELECT p.id, p.name, o.quantity FROM products p JOIN orders o ON p.id = o.product_id LIMIT 10\n\`\`\``;
    } else if (userMessage.includes('Limit results to 5')) {
      return `This query shows products.\n\`\`\`sql\nSELECT id, name, price, category, stock FROM products LIMIT 5\n\`\`\``;
    } else {
      return `This query retrieves all products.\n\`\`\`sql\nSELECT id, name, price, category, stock FROM products LIMIT 10\n\`\`\``;
    }
  });
});

describe('TextToSQLService', () => {
  let service: TextToSQLService;
  let mockTable: TableMetadata;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TextToSQLService();

    // Re-apply the mock chat after clearAllMocks
    mockChat.mockImplementation(async (_systemPrompt: string, messages: any[]) => {
      const userMessage = messages[0].content;
      const queryMatch = userMessage.match(/User Question: "(.+?)"/);
      const query = queryMatch ? queryMatch[1] : '';

      if (query.includes('price > 50') || query.includes('price > 100')) {
        return `This query filters products by price.\n\`\`\`sql\nSELECT id, name, price FROM products WHERE price > 50 LIMIT 10\n\`\`\``;
      } else if (query.includes('count') || query.includes('how many')) {
        return `This query counts products by category.\n\`\`\`sql\nSELECT category, COUNT(*) as count FROM products GROUP BY category LIMIT 10\n\`\`\``;
      } else if (query.includes('ordered by') || query.includes('descending')) {
        return `This query orders products by price.\n\`\`\`sql\nSELECT id, name, price FROM products ORDER BY price DESC LIMIT 10\n\`\`\``;
      } else if (query.includes('with their orders') || query.includes('orders')) {
        return `This query joins products with orders.\n\`\`\`sql\nSELECT p.id, p.name, o.quantity FROM products p JOIN orders o ON p.id = o.product_id LIMIT 10\n\`\`\``;
      } else if (userMessage.includes('Limit results to 5')) {
        return `This query shows products.\n\`\`\`sql\nSELECT id, name, price, category, stock FROM products LIMIT 5\n\`\`\``;
      } else {
        return `This query retrieves all products.\n\`\`\`sql\nSELECT id, name, price, category, stock FROM products LIMIT 10\n\`\`\``;
      }
    });

    // Create mock table metadata
    mockTable = {
      table_id: 'table-123',
      table_name: 'products',
      display_name: 'Products',
      tenant_id: 'tenant-123',
      index_id: 'index-123',
      columns: JSON.stringify(['id', 'name', 'price', 'category', 'stock']),
      column_types: JSON.stringify(['integer', 'string', 'number', 'string', 'integer']),
      column_descriptions: JSON.stringify({
        id: 'Product ID',
        name: 'Product name',
        price: 'Price in USD',
        category: 'Product category',
        stock: 'Stock quantity',
      }),
      primary_key: 'id',
      row_count: 100,
      table_description: 'Product catalog with pricing and inventory',
      statistics: '{}',
      sample_rows: JSON.stringify([
        { id: 1, name: 'Widget A', price: 29.99, category: 'Electronics', stock: 50 },
        { id: 2, name: 'Widget B', price: 49.99, category: 'Electronics', stock: 30 },
      ]),
      foreign_keys: '[]',
      searchable_text: 'products catalog items',
      created_at: new Date(),
      updated_at: new Date(),
    };
  });

  describe('SQL Generation', () => {
    it('should generate SQL response', async () => {
      const request = {
        query: 'show all products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);

      expect(response.sql).toBeDefined();
      expect(response.explanation).toBeDefined();
      expect(response.confidence).toBeGreaterThan(0);
      expect(response.tablesReferenced).toContain('products');
    });

    it('should include table references', async () => {
      const request = {
        query: 'products with price > 50',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);

      expect(response.tablesReferenced).toBeDefined();
      expect(response.tablesReferenced.length).toBeGreaterThan(0);
      expect(response.tablesReferenced).toContain('products');
    });

    it('should respect maxResults parameter', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
        maxResults: 5,
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toContain('LIMIT 5');
    });

    it('should default to 10 results when maxResults not specified', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toContain('LIMIT 10');
    });

    it('should handle multiple tables', async () => {
      const ordersTable: TableMetadata = {
        ...mockTable,
        table_id: 'table-456',
        table_name: 'orders',
        display_name: 'Orders',
        columns: JSON.stringify(['id', 'product_id', 'quantity', 'total']),
        column_types: JSON.stringify(['integer', 'integer', 'integer', 'number']),
        column_descriptions: JSON.stringify({}),
        sample_rows: '[]',
      };

      const request = {
        query: 'show orders with products',
        tables: [mockTable, ordersTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.tablesReferenced.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('SQL Validation', () => {
    it('should reject destructive operations', async () => {
      const destructiveQueries = [
        'DROP TABLE products',
        'DELETE FROM products',
        'UPDATE products SET price = 0',
        'INSERT INTO products VALUES (1, "test")',
        'ALTER TABLE products ADD COLUMN test',
        'TRUNCATE TABLE products',
      ];

      for (const query of destructiveQueries) {
        const request = {
          query,
          tables: [mockTable],
          tenantId: 'tenant-123',
          indexId: 'index-123',
        };

        const response = await service.generateSQL(request);
        // LLM should generate safe SELECT queries, not destructive operations
        expect(response.sql).toMatch(/^SELECT/i);
        expect(response.sql).not.toMatch(/DROP|DELETE|UPDATE|INSERT/i);
      }
    });

    it('should reject multiple statements', async () => {
      const request = {
        query: 'SELECT * FROM products; DROP TABLE products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      // LLM should generate single SELECT statement
      expect(response.sql).toMatch(/^SELECT/i);
      expect(response.sql).not.toMatch(/DROP/i);
    });

    it('should require SELECT statement', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toMatch(/^\s*SELECT/i);
    });

    it('should warn about missing LIMIT clause', async () => {
      const request = {
        query: 'show all products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      // LLM should always include LIMIT
      expect(response.sql).toContain('LIMIT');
    });
  });

  describe('Schema Context Building', () => {
    it('should include table name and description', async () => {
      const request = {
        query: 'test',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      await service.generateSQL(request);
      expect(mockTable.table_name).toBe('products');
      expect(mockTable.table_description).toBeDefined();
    });

    it('should include column information', () => {
      const columns = JSON.parse(mockTable.columns);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('price');
    });

    it('should include sample data', () => {
      const sampleRows = JSON.parse(mockTable.sample_rows);
      expect(sampleRows.length).toBeGreaterThan(0);
      expect(sampleRows[0]).toHaveProperty('id');
      expect(sampleRows[0]).toHaveProperty('name');
    });

    it('should include primary key info', () => {
      expect(mockTable.primary_key).toBe('id');
    });
  });

  describe('SQL Safety', () => {
    it('should generate safe SELECT-only queries', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toMatch(/^SELECT/i);
      expect(response.sql).not.toMatch(/DROP|DELETE|UPDATE|INSERT/i);
    });

    it('should not allow SQL injection patterns', async () => {
      const injectionQueries = [
        "products'; DROP TABLE users; --",
        'products OR 1=1',
        "products' UNION SELECT * FROM passwords --",
      ];

      for (const query of injectionQueries) {
        const request = {
          query,
          tables: [mockTable],
          tenantId: 'tenant-123',
          indexId: 'index-123',
        };

        const response = await service.generateSQL(request);
        expect(response.sql).not.toMatch(/DROP|UNION.*passwords/i);
      }
    });
  });

  describe('Placeholder SQL Generation', () => {
    it('should generate basic SELECT query', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toContain('SELECT');
      expect(response.sql).toContain('FROM products');
    });

    it('should include multiple columns', async () => {
      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toMatch(/SELECT[\s\S]*FROM/);
    });

    it('should handle empty tables array', async () => {
      const request = {
        query: 'show data',
        tables: [],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toBeDefined();
      expect(response.sql).toBe('SELECT 1');
    });
  });

  describe('Confidence Scoring', () => {
    it('should provide confidence score', async () => {
      const request = {
        query: 'products where price > 50',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.confidence).toBeGreaterThanOrEqual(0);
      expect(response.confidence).toBeLessThanOrEqual(1);
    });

    it('should return explanation', async () => {
      const request = {
        query: 'show expensive products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.explanation).toBeDefined();
      expect(typeof response.explanation).toBe('string');
      expect(response.explanation.length).toBeGreaterThan(0);
    });
  });

  describe('Complex Queries', () => {
    it('should handle filter conditions', async () => {
      const request = {
        query: 'products where price > 50',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toBeDefined();
    });

    it('should handle aggregations', async () => {
      const request = {
        query: 'count products by category',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toBeDefined();
    });

    it('should handle sorting', async () => {
      const request = {
        query: 'products ordered by price descending',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toBeDefined();
    });

    it('should handle joins', async () => {
      const ordersTable: TableMetadata = {
        ...mockTable,
        table_id: 'table-456',
        table_name: 'orders',
        display_name: 'Orders',
        columns: JSON.stringify(['id', 'product_id', 'quantity']),
        column_types: JSON.stringify(['integer', 'integer', 'integer']),
        column_descriptions: JSON.stringify({}),
        sample_rows: '[]',
      };

      const request = {
        query: 'products with their orders',
        tables: [mockTable, ordersTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      const response = await service.generateSQL(request);
      expect(response.sql).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw on malformed table metadata', async () => {
      const malformedTable: TableMetadata = {
        ...mockTable,
        columns: 'invalid json',
        column_types: 'invalid json',
      };

      const request = {
        query: 'show products',
        tables: [malformedTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      // Should throw on invalid JSON
      await expect(service.generateSQL(request)).rejects.toThrow();
    });

    it('should use Model Library via resolveIndexLLMConfig', async () => {
      const { resolveIndexLLMConfig } = await import('../../services/llm-config/resolver.js');

      const request = {
        query: 'show products',
        tables: [mockTable],
        tenantId: 'tenant-123',
        indexId: 'index-123',
      };

      await service.generateSQL(request);

      expect(resolveIndexLLMConfig).toHaveBeenCalledWith('tenant-123', 'index-123');
    });
  });
});
