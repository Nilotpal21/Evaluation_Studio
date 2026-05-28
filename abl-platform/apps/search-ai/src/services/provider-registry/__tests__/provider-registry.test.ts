import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderRegistry } from '../provider-registry.js';
import { type PipelineStageProvider, type JSONSchema, ProviderNotFoundError } from '../types.js';

// ─── Mock Providers ──────────────────────────────────────────────────────

class MockExtractionProvider implements PipelineStageProvider {
  id = 'mock-extraction';
  name = 'Mock Extraction Provider';
  type = 'extraction' as const;
  version = '1.0.0';
  description = 'Mock provider for testing';

  async execute(input: unknown, config: unknown): Promise<unknown> {
    return { text: 'extracted text' };
  }

  validateConfig(config: unknown): config is unknown {
    return typeof config === 'object';
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        model: { type: 'string' },
      },
    };
  }
}

class MockEmbeddingProvider implements PipelineStageProvider {
  id = 'mock-embedding';
  name = 'Mock Embedding Provider';
  type = 'embedding' as const;
  version = '2.0.0';

  async execute(input: unknown, config: unknown): Promise<unknown> {
    return { embeddings: [[0.1, 0.2, 0.3]] };
  }

  validateConfig(config: unknown): config is unknown {
    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {},
    };
  }
}

class MockChunkingProvider implements PipelineStageProvider {
  id = 'mock-chunking';
  name = 'Mock Chunking Provider';
  type = 'chunking' as const;
  version = '1.5.0';

  async execute(input: unknown, config: unknown): Promise<unknown> {
    return { chunks: ['chunk1', 'chunk2'] };
  }

  validateConfig(config: unknown): config is unknown {
    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {},
    };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    // Reset singleton for each test
    ProviderRegistry._resetForTesting();
    registry = ProviderRegistry.getInstance();
  });

  afterEach(() => {
    ProviderRegistry._resetForTesting();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ProviderRegistry.getInstance();
      const instance2 = ProviderRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('register', () => {
    it('should register a provider successfully', () => {
      const provider = new MockExtractionProvider();

      expect(() => registry.register(provider)).not.toThrow();
      expect(registry.has('extraction', 'mock-extraction')).toBe(true);
    });

    it('should throw error if provider is missing required fields', () => {
      const invalidProvider = {
        execute: async () => ({}),
        validateConfig: () => true,
        getSchema: () => ({ type: 'object' as const, properties: {} }),
      } as unknown as PipelineStageProvider;

      expect(() => registry.register(invalidProvider)).toThrow(
        /Provider must have id, name, and type/,
      );
    });

    it('should allow registering multiple providers for same stage type', () => {
      const provider1 = new MockExtractionProvider();
      const provider2: any = {
        ...provider1,
        id: 'mock-extraction-2',
        name: 'Mock Extraction Provider 2',
      };

      registry.register(provider1);
      registry.register(provider2);

      expect(registry.has('extraction', 'mock-extraction')).toBe(true);
      expect(registry.has('extraction', 'mock-extraction-2')).toBe(true);
    });

    it('should allow registering providers for different stage types', () => {
      const extractionProvider = new MockExtractionProvider();
      const embeddingProvider = new MockEmbeddingProvider();

      registry.register(extractionProvider);
      registry.register(embeddingProvider);

      expect(registry.has('extraction', 'mock-extraction')).toBe(true);
      expect(registry.has('embedding', 'mock-embedding')).toBe(true);
    });

    it('should overwrite existing provider with same ID', () => {
      const provider1 = new MockExtractionProvider();
      const provider2: any = {
        ...provider1,
        name: 'Updated Provider Name',
      };

      registry.register(provider1);
      registry.register(provider2);

      const retrieved = registry.get('extraction', 'mock-extraction');
      expect(retrieved.name).toBe('Updated Provider Name');
    });
  });

  describe('get', () => {
    it('should retrieve registered provider', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      const retrieved = registry.get('extraction', 'mock-extraction');

      expect(retrieved).toBe(provider);
      expect(retrieved.id).toBe('mock-extraction');
    });

    it('should throw ProviderNotFoundError if stage type not found', () => {
      expect(() => registry.get('extraction', 'nonexistent')).toThrow(ProviderNotFoundError);
    });

    it('should throw ProviderNotFoundError if provider ID not found', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      expect(() => registry.get('extraction', 'nonexistent')).toThrow(ProviderNotFoundError);
    });
  });

  describe('listByStageType', () => {
    it('should return empty array if no providers registered for stage type', () => {
      const providers = registry.listByStageType('extraction');

      expect(providers).toEqual([]);
    });

    it('should list all providers for a stage type', () => {
      const provider1 = new MockExtractionProvider();
      const provider2 = new MockExtractionProvider();
      provider2.id = 'mock-extraction-2';
      provider2.name = 'Mock Extraction Provider 2';

      registry.register(provider1);
      registry.register(provider2);

      const providers = registry.listByStageType('extraction');

      expect(providers).toHaveLength(2);
      expect(providers.map((p: { id: string }) => p.id)).toEqual([
        'mock-extraction',
        'mock-extraction-2',
      ]);
    });

    it('should return provider metadata with schema', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      const providers = registry.listByStageType('extraction');

      expect(providers[0]).toEqual({
        id: 'mock-extraction',
        name: 'Mock Extraction Provider',
        type: 'extraction',
        version: '1.0.0',
        description: 'Mock provider for testing',
        schema: {
          type: 'object',
          properties: {
            model: { type: 'string' },
          },
        },
      });
    });

    it('should not include providers from other stage types', () => {
      const extractionProvider = new MockExtractionProvider();
      const embeddingProvider = new MockEmbeddingProvider();

      registry.register(extractionProvider);
      registry.register(embeddingProvider);

      const extractionProviders = registry.listByStageType('extraction');

      expect(extractionProviders).toHaveLength(1);
      expect(extractionProviders[0].id).toBe('mock-extraction');
    });
  });

  describe('listAll', () => {
    it('should return empty array if no providers registered', () => {
      const providers = registry.listAll();

      expect(providers).toEqual([]);
    });

    it('should list all providers across all stage types', () => {
      const extractionProvider = new MockExtractionProvider();
      const embeddingProvider = new MockEmbeddingProvider();
      const chunkingProvider = new MockChunkingProvider();

      registry.register(extractionProvider);
      registry.register(embeddingProvider);
      registry.register(chunkingProvider);

      const providers = registry.listAll();

      expect(providers).toHaveLength(3);
      expect(providers.map((p: { id: string }) => p.id).sort()).toEqual([
        'mock-chunking',
        'mock-embedding',
        'mock-extraction',
      ]);
    });
  });

  describe('has', () => {
    it('should return true if provider is registered', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      expect(registry.has('extraction', 'mock-extraction')).toBe(true);
    });

    it('should return false if stage type not found', () => {
      expect(registry.has('extraction', 'nonexistent')).toBe(false);
    });

    it('should return false if provider ID not found', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      expect(registry.has('extraction', 'nonexistent')).toBe(false);
    });

    it('should return false if wrong stage type', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      expect(registry.has('embedding', 'mock-extraction')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('should remove registered provider', () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      const removed = registry.unregister('extraction', 'mock-extraction');

      expect(removed).toBe(true);
      expect(registry.has('extraction', 'mock-extraction')).toBe(false);
    });

    it('should return false if provider not found', () => {
      const removed = registry.unregister('extraction', 'nonexistent');

      expect(removed).toBe(false);
    });

    it('should not affect other providers', () => {
      const provider1 = new MockExtractionProvider();
      const provider2: any = {
        ...provider1,
        id: 'mock-extraction-2',
        name: 'Mock Extraction Provider 2',
      };

      registry.register(provider1);
      registry.register(provider2);

      registry.unregister('extraction', 'mock-extraction');

      expect(registry.has('extraction', 'mock-extraction')).toBe(false);
      expect(registry.has('extraction', 'mock-extraction-2')).toBe(true);
    });
  });

  describe('getProviderCounts', () => {
    it('should return empty map if no providers registered', () => {
      const counts = registry.getProviderCounts();

      expect(counts.size).toBe(0);
    });

    it('should return correct counts by stage type', () => {
      const extractionProvider1 = new MockExtractionProvider();
      const extractionProvider2: any = {
        ...extractionProvider1,
        id: 'mock-extraction-2',
      };
      const embeddingProvider = new MockEmbeddingProvider();

      registry.register(extractionProvider1);
      registry.register(extractionProvider2);
      registry.register(embeddingProvider);

      const counts = registry.getProviderCounts();

      expect(counts.get('extraction')).toBe(2);
      expect(counts.get('embedding')).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all registered providers', () => {
      const extractionProvider = new MockExtractionProvider();
      const embeddingProvider = new MockEmbeddingProvider();

      registry.register(extractionProvider);
      registry.register(embeddingProvider);

      registry.clear();

      expect(registry.listAll()).toEqual([]);
      expect(registry.has('extraction', 'mock-extraction')).toBe(false);
      expect(registry.has('embedding', 'mock-embedding')).toBe(false);
    });
  });

  describe('provider execution', () => {
    it('should allow executing registered provider', async () => {
      const provider = new MockExtractionProvider();
      registry.register(provider);

      const retrieved = registry.get('extraction', 'mock-extraction');
      const result = await retrieved.execute({ data: 'test' }, { model: 'v1' });

      expect(result).toEqual({ text: 'extracted text' });
    });
  });
});
