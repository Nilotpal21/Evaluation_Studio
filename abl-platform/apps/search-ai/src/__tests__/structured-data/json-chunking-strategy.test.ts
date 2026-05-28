/**
 * Tests for JSON Object Chunking Strategy
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { JSONChunkingStrategy } from '../../services/structured-data/json-chunking-strategy.js';

describe('JSONChunkingStrategy', () => {
  let strategy: JSONChunkingStrategy;

  beforeEach(() => {
    strategy = new JSONChunkingStrategy();
  });

  describe('Single chunk scenarios (under token limit)', () => {
    it('should create single chunk for small JSON object', () => {
      const jsonObject = {
        id: '123',
        title: 'Test Product',
        description: 'A simple product description with moderate length text',
        price: 29.99,
        category: 'Electronics',
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['title', 'description'],
        metadata: { objectId: '123', objectType: 'product' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].type).toBe('json_object');
      expect(result.chunks[0].chunkIndex).toBe(0);
      expect(result.overflowFields).toHaveLength(0);
      expect(result.statistics.objectChunks).toBe(1);
      expect(result.statistics.overflowChunks).toBe(0);
    });

    it('should handle object with no embeddable fields', () => {
      const jsonObject = {
        id: '123',
        count: 100,
        value: 50.5,
        active: true,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: [],
        metadata: { objectId: '123' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].type).toBe('json_object');
      expect(result.overflowFields).toHaveLength(0);
    });

    it('should handle object with null/undefined embeddable fields', () => {
      const jsonObject = {
        id: '123',
        title: null,
        description: undefined,
        notes: '',
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['title', 'description', 'notes'],
        metadata: { objectId: '123' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.overflowFields).toHaveLength(0);
    });

    it('should include full JSON content in chunk', () => {
      const jsonObject = {
        id: '123',
        title: 'Product',
        price: 99.99,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['title'],
        metadata: { objectId: '123' },
      });

      const parsedContent = JSON.parse(result.chunks[0].content);
      expect(parsedContent).toEqual(jsonObject);
    });
  });

  describe('Overflow scenarios (exceeding token limit)', { timeout: 30_000 }, () => {
    it('should split large description field into multiple chunks', { timeout: 120_000 }, () => {
      // Create a large description that exceeds 8000 tokens
      // With tiktoken, need more text to reach 8000+ tokens than with char/4
      const largeDescription = 'This is a very long description. '.repeat(2000); // ~12k tokens with tiktoken

      const jsonObject = {
        id: '456',
        title: 'Large Product',
        description: largeDescription,
        price: 99.99,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['title', 'description'],
        metadata: { objectId: '456', objectType: 'product' },
      });

      // Should have metadata chunk + overflow chunks
      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks[0].type).toBe('json_object'); // Metadata chunk
      expect(result.chunks[0].content).toContain('[Large field - see separate chunks]');

      // Overflow chunks
      const overflowChunks = result.chunks.filter((c) => c.type === 'json_field_overflow');
      expect(overflowChunks.length).toBeGreaterThan(0);
      expect(overflowChunks[0].fieldPath).toBe('description');

      expect(result.overflowFields).toContain('description');
      expect(result.statistics.objectChunks).toBe(1);
      expect(result.statistics.overflowChunks).toBeGreaterThan(0);
    });

    it('should handle multiple overflow fields', () => {
      // Need >32k characters to exceed 8000 tokens (4 chars per token)
      const largeText1 = 'Large content for field 1. '.repeat(1500); // ~40k chars
      const largeText2 = 'Large content for field 2. '.repeat(1500); // ~40k chars

      const jsonObject = {
        id: '789',
        field1: largeText1,
        field2: largeText2,
        smallField: 'Small content',
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['field1', 'field2', 'smallField'],
        metadata: { objectId: '789' },
      });

      expect(result.chunks.length).toBeGreaterThan(2); // Metadata + field1 chunks + field2 chunks
      expect(result.overflowFields).toContain('field1');
      expect(result.overflowFields).toContain('field2');
      expect(result.overflowFields).not.toContain('smallField');
    });

    it('should respect sentence boundaries in overflow chunks', () => {
      const sentences = Array.from(
        { length: 500 },
        (_, i) => `This is sentence number ${i + 1} with some content to make it longer.`,
      );
      const largeDescription = sentences.join(' ');

      const jsonObject = {
        id: 'sent-test',
        description: largeDescription,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['description'],
        metadata: { objectId: 'sent-test' },
      });

      const overflowChunks = result.chunks.filter((c) => c.type === 'json_field_overflow');

      // Each overflow chunk should contain complete sentences
      for (const chunk of overflowChunks) {
        expect(chunk.content).toMatch(/\.\s*$/); // Should end with sentence terminator
      }
    });

    it('should maintain parent-child relationships via metadata', () => {
      const largeDescription = 'Large text content. '.repeat(1000);

      const jsonObject = {
        id: 'parent-test',
        description: largeDescription,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['description'],
        metadata: { objectId: 'parent-test' },
      });

      const metadataChunk = result.chunks[0];
      const overflowChunks = result.chunks.filter((c) => c.type === 'json_field_overflow');

      for (const chunk of overflowChunks) {
        expect(chunk.metadata.parentChunkIndex).toBe(0); // References metadata chunk
        expect(chunk.metadata.fieldPath).toBe('description');
        expect(chunk.objectId).toBe(metadataChunk.objectId);
      }
    });
  });

  describe('Token counting and limits', () => {
    it('should respect maxTokensPerChunk config', () => {
      const largeDescription = 'Some text. '.repeat(500);

      const jsonObject = {
        id: 'config-test',
        description: largeDescription,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['description'],
        metadata: { objectId: 'config-test' },
        config: {
          maxTokensPerChunk: 500, // Very small limit
        },
      });

      // With small limit, should split into multiple chunks
      expect(result.chunks.length).toBeGreaterThan(1);

      // Each chunk should respect the limit (within sentence alignment constraints)
      for (const chunk of result.chunks) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(1024); // maxChunkSize from sentence alignment
      }
    });

    it('should accurately track total token count', () => {
      const jsonObject = {
        id: 'token-test',
        field1: 'Some text here',
        field2: 'More text content',
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['field1', 'field2'],
        metadata: { objectId: 'token-test' },
      });

      const summedTokens = result.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
      expect(result.totalTokens).toBe(summedTokens);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty JSON object', () => {
      const result = strategy.chunk({
        jsonObject: {},
        embeddableFields: [],
        metadata: { objectId: 'empty' },
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0].type).toBe('json_object');
    });

    it('should handle deeply nested JSON', () => {
      const jsonObject = {
        id: 'nested',
        data: {
          level1: {
            level2: {
              value: 'Deeply nested value',
            },
          },
        },
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: [], // No embeddable fields
        metadata: { objectId: 'nested' },
      });

      expect(result.chunks).toHaveLength(1);
      const parsedContent = JSON.parse(result.chunks[0].content);
      expect(parsedContent).toEqual(jsonObject);
    });

    it('should handle non-string embeddable fields', () => {
      const jsonObject = {
        id: 'mixed-types',
        textField: 'Text content',
        numberField: 12345,
        objectField: { nested: 'value' },
        arrayField: ['item1', 'item2'],
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['textField', 'numberField', 'objectField', 'arrayField'],
        metadata: { objectId: 'mixed-types' },
      });

      // Non-string fields should be stringified
      expect(result.chunks).toHaveLength(1);
      expect(result.overflowFields).toHaveLength(0);
    });

    it('should handle single very long sentence', () => {
      // Single sentence that exceeds maxChunkSize
      const veryLongSentence =
        'This is an extremely long sentence without any periods or breaks that goes on and on '.repeat(
          200,
        ) + '.';

      const jsonObject = {
        id: 'long-sentence',
        description: veryLongSentence,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['description'],
        metadata: { objectId: 'long-sentence' },
      });

      // Should still chunk it (sentence aligner handles this)
      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Metadata preservation', () => {
    it('should preserve custom metadata in all chunks', () => {
      const largeDescription = 'Large text. '.repeat(1000);

      const jsonObject = {
        id: 'meta-test',
        description: largeDescription,
      };

      const customMetadata = {
        objectId: 'meta-test',
        objectType: 'article',
        author: 'Test Author',
        category: 'Technology',
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['description'],
        metadata: customMetadata,
      });

      for (const chunk of result.chunks) {
        expect(chunk.metadata.objectType).toBe('article');
        expect(chunk.metadata.author).toBe('Test Author');
        expect(chunk.metadata.category).toBe('Technology');
      }
    });

    it('should include chunkingStrategy in metadata', { timeout: 30_000 }, () => {
      const smallObject = {
        id: 'strategy-test',
        title: 'Small',
      };

      const result = strategy.chunk({
        jsonObject: smallObject,
        embeddableFields: ['title'],
        metadata: { objectId: 'strategy-test' },
      });

      expect(result.chunks[0].metadata.chunkingStrategy).toBe('single');

      const largeObject = {
        id: 'strategy-test-2',
        // Each sentence has unique words to avoid degenerate tokenizer/aligner behavior.
        // ~55 chars × 700 = ~38.5k chars ≈ 9600 tokens > 8000 maxTokensPerChunk.
        description: Array.from(
          { length: 700 },
          (_, i) => `Sentence number ${i} describes feature ${i * 3} of the product catalog.`,
        ).join(' '),
      };

      const result2 = strategy.chunk({
        jsonObject: largeObject,
        embeddableFields: ['description'],
        metadata: { objectId: 'strategy-test-2' },
      });

      expect(result2.chunks[0].metadata.chunkingStrategy).toBe('overflow');
      expect(result2.chunks[0].metadata.overflowFields).toBeDefined();
    });
  });

  describe('Statistics validation', () => {
    it('should provide accurate chunk statistics', () => {
      const largeText = 'Content. '.repeat(1000);

      const jsonObject = {
        id: 'stats-test',
        field: largeText,
      };

      const result = strategy.chunk({
        jsonObject,
        embeddableFields: ['field'],
        metadata: { objectId: 'stats-test' },
      });

      expect(result.statistics.totalChunks).toBe(result.chunks.length);
      expect(result.statistics.objectChunks).toBe(1); // Always 1 metadata chunk
      expect(result.statistics.overflowChunks).toBe(
        result.chunks.filter((c) => c.type === 'json_field_overflow').length,
      );
      expect(result.statistics.totalChunks).toBe(
        result.statistics.objectChunks + result.statistics.overflowChunks,
      );
    });
  });
});
