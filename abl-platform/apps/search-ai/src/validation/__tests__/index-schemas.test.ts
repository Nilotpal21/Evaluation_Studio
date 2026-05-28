/**
 * Tests for SearchIndex validation schemas
 */

import { describe, test, expect } from 'vitest';
import {
  VectorStoreSchema,
  SearchDefaultsSchema,
  CreateIndexSchema,
  UpdateIndexSchema,
  validateEmbeddingDimensions,
} from '../index-schemas.js';

describe('VectorStoreSchema', () => {
  test('validates correct vector store config', () => {
    const valid = {
      provider: 'qdrant',
      collectionName: 'test-collection',
    };
    expect(VectorStoreSchema.parse(valid)).toEqual(valid);
  });

  test('rejects invalid provider', () => {
    const invalid = {
      provider: 'invalid',
      collectionName: 'test',
    };
    expect(() => VectorStoreSchema.parse(invalid)).toThrow();
  });

  test('rejects invalid collectionName with special chars', () => {
    const invalid = {
      provider: 'qdrant',
      collectionName: 'test collection!',
    };
    expect(() => VectorStoreSchema.parse(invalid)).toThrow(
      'collectionName must only contain letters, numbers, hyphens, and underscores',
    );
  });

  test('allows connectionConfig', () => {
    const valid = {
      provider: 'qdrant',
      collectionName: 'test',
      connectionConfig: { url: 'http://localhost:6333' },
    };
    expect(VectorStoreSchema.parse(valid)).toEqual(valid);
  });
});

describe('SearchDefaultsSchema', () => {
  test('validates correct search defaults', () => {
    const valid = {
      topK: 10,
      similarityThreshold: 0.7,
      includeMetadata: true,
      includeContent: true,
    };
    expect(SearchDefaultsSchema.parse(valid)).toEqual(valid);
  });

  test('rejects topK too large', () => {
    const invalid = {
      topK: 500,
      similarityThreshold: 0.7,
      includeMetadata: true,
      includeContent: true,
    };
    expect(() => SearchDefaultsSchema.parse(invalid)).toThrow('topK cannot exceed 100');
  });

  test('rejects similarityThreshold out of range', () => {
    const invalid = {
      topK: 10,
      similarityThreshold: 1.5,
      includeMetadata: true,
      includeContent: true,
    };
    expect(() => SearchDefaultsSchema.parse(invalid)).toThrow(
      'similarityThreshold must be between 0 and 1',
    );
  });

  test('allows optional reranker', () => {
    const valid = {
      topK: 10,
      similarityThreshold: 0.7,
      includeMetadata: true,
      includeContent: true,
      reranker: {
        provider: 'cohere',
        model: 'rerank-english-v2.0',
        topN: 5,
      },
    };
    expect(SearchDefaultsSchema.parse(valid)).toEqual(valid);
  });
});

describe('CreateIndexSchema', () => {
  test('validates minimal create request', () => {
    const valid = {
      projectId: 'proj_123',
      slug: 'test-index',
      name: 'Test Index',
    };
    expect(CreateIndexSchema.parse(valid)).toEqual(valid);
  });

  test('validates full create request', () => {
    const valid = {
      projectId: 'proj_123',
      slug: 'test-index',
      name: 'Test Index',
      description: 'A test index',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      vectorStore: {
        provider: 'qdrant',
        collectionName: 'test-index',
      },
      searchDefaults: {
        topK: 10,
        similarityThreshold: 0.7,
        includeMetadata: true,
        includeContent: true,
      },
    };
    expect(CreateIndexSchema.parse(valid)).toEqual(valid);
  });

  test('rejects invalid slug with uppercase', () => {
    const invalid = {
      projectId: 'proj_123',
      slug: 'Test-Index',
      name: 'Test Index',
    };
    expect(() => CreateIndexSchema.parse(invalid)).toThrow(
      'slug must only contain lowercase letters, numbers, and hyphens',
    );
  });

  test('rejects missing required fields', () => {
    const invalid = {
      slug: 'test-index',
    };
    expect(() => CreateIndexSchema.parse(invalid)).toThrow();
  });
});

describe('UpdateIndexSchema', () => {
  test('validates update request', () => {
    const valid = {
      name: 'Updated Name',
      description: 'Updated description',
    };
    expect(UpdateIndexSchema.parse(valid)).toEqual(valid);
  });

  test('validates status update', () => {
    const valid = {
      status: 'active',
    };
    expect(UpdateIndexSchema.parse(valid)).toEqual(valid);
  });

  test('rejects invalid status', () => {
    const invalid = {
      status: 'invalid',
    };
    expect(() => UpdateIndexSchema.parse(invalid)).toThrow();
  });
});

describe('validateEmbeddingDimensions', () => {
  test('validates OpenAI text-embedding-3-small dimensions', () => {
    expect(validateEmbeddingDimensions('text-embedding-3-small', 1536)).toEqual({ valid: true });
    expect(validateEmbeddingDimensions('text-embedding-3-small', 512)).toEqual({ valid: true });
  });

  test('rejects invalid OpenAI dimensions', () => {
    const result = validateEmbeddingDimensions('text-embedding-3-small', 768);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('supports dimensions: 512, 1536');
  });

  test('validates OpenAI text-embedding-3-large dimensions', () => {
    expect(validateEmbeddingDimensions('text-embedding-3-large', 3072)).toEqual({ valid: true });
    expect(validateEmbeddingDimensions('text-embedding-3-large', 1024)).toEqual({ valid: true });
    expect(validateEmbeddingDimensions('text-embedding-3-large', 256)).toEqual({ valid: true });
  });

  test('validates Cohere dimensions', () => {
    expect(validateEmbeddingDimensions('embed-english-v3.0', 1024)).toEqual({ valid: true });
  });

  test('validates BGE-M3 dimensions', () => {
    expect(validateEmbeddingDimensions('bge-m3', 1024)).toEqual({ valid: true });
  });

  test('allows any dimension for unknown models', () => {
    expect(validateEmbeddingDimensions('custom-model', 768)).toEqual({ valid: true });
  });

  test('rejects invalid Cohere dimensions', () => {
    const result = validateEmbeddingDimensions('embed-english-v3.0', 1536);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('supports dimensions: 1024');
  });
});
