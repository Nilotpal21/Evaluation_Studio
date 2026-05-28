/**
 * Unit tests for Embedding Provider Registry
 */

import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_PROVIDERS,
  getEmbeddingProvider,
  listEmbeddingProviders,
  getModelsForProvider,
  validateEmbeddingConfig,
} from '../embedding-providers.js';

describe('EMBEDDING_PROVIDERS', () => {
  it('has all 5 providers registered', () => {
    expect(Object.keys(EMBEDDING_PROVIDERS)).toHaveLength(5);
    expect(EMBEDDING_PROVIDERS['bge-m3']).toBeDefined();
    expect(EMBEDDING_PROVIDERS['openai']).toBeDefined();
    expect(EMBEDDING_PROVIDERS['cohere']).toBeDefined();
    expect(EMBEDDING_PROVIDERS['azure']).toBeDefined();
    expect(EMBEDDING_PROVIDERS['custom']).toBeDefined();
  });

  it('BGE-M3 is self-hosted and requires no credentials', () => {
    const bge = EMBEDDING_PROVIDERS['bge-m3'];
    expect(bge.selfHosted).toBe(true);
    expect(bge.requiresCredentials).toBe(false);
    expect(bge.models[0].dimensions).toEqual([1024]);
    expect(bge.models[0].costPer1MTokens).toBe(0);
  });

  it('OpenAI requires credentials and has 2 models', () => {
    const openai = EMBEDDING_PROVIDERS['openai'];
    expect(openai.selfHosted).toBe(false);
    expect(openai.requiresCredentials).toBe(true);
    expect(openai.models).toHaveLength(2);
  });

  it('Cohere requires credentials', () => {
    const cohere = EMBEDDING_PROVIDERS['cohere'];
    expect(cohere.requiresCredentials).toBe(true);
  });

  it('Custom has no predefined models', () => {
    const custom = EMBEDDING_PROVIDERS['custom'];
    expect(custom.models).toHaveLength(0);
    expect(custom.requiresCredentials).toBe(false);
  });
});

describe('getEmbeddingProvider', () => {
  it('returns provider metadata by id', () => {
    const provider = getEmbeddingProvider('bge-m3');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('bge-m3');
    expect(provider!.name).toBe('BGE-M3');
  });

  it('returns undefined for unknown provider', () => {
    const provider = getEmbeddingProvider('unknown' as any);
    expect(provider).toBeUndefined();
  });
});

describe('listEmbeddingProviders', () => {
  it('returns all providers', () => {
    const providers = listEmbeddingProviders();
    expect(providers).toHaveLength(5);
    const ids = providers.map((p) => p.id);
    expect(ids).toContain('bge-m3');
    expect(ids).toContain('openai');
    expect(ids).toContain('cohere');
    expect(ids).toContain('azure');
    expect(ids).toContain('custom');
  });
});

describe('getModelsForProvider', () => {
  it('returns models for OpenAI', () => {
    const models = getModelsForProvider('openai');
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('text-embedding-3-small');
    expect(models[1].id).toBe('text-embedding-3-large');
  });

  it('returns empty array for custom', () => {
    const models = getModelsForProvider('custom');
    expect(models).toHaveLength(0);
  });

  it('returns empty array for unknown provider', () => {
    const models = getModelsForProvider('unknown' as any);
    expect(models).toHaveLength(0);
  });
});

describe('validateEmbeddingConfig', () => {
  it('accepts valid BGE-M3 config', () => {
    const result = validateEmbeddingConfig('bge-m3', 'bge-m3', 1024);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts valid OpenAI config', () => {
    const result = validateEmbeddingConfig('openai', 'text-embedding-3-small', 1536);
    expect(result.valid).toBe(true);
  });

  it('accepts valid OpenAI config with non-default dimensions', () => {
    const result = validateEmbeddingConfig('openai', 'text-embedding-3-small', 512);
    expect(result.valid).toBe(true);
  });

  it('rejects unknown provider', () => {
    const result = validateEmbeddingConfig('unknown', 'model', 512);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown embedding provider');
  });

  it('rejects unknown model for known provider', () => {
    const result = validateEmbeddingConfig('openai', 'unknown-model', 1536);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found for provider');
  });

  it('rejects unsupported dimensions for model', () => {
    const result = validateEmbeddingConfig('openai', 'text-embedding-3-small', 3072);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not supported by model');
  });

  it('accepts any config for custom provider', () => {
    const result = validateEmbeddingConfig('custom', 'any-model', 768);
    expect(result.valid).toBe(true);
  });
});
