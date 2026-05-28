/**
 * Unit tests for Pipeline Zod Validation Schemas
 */

import { describe, it, expect } from 'vitest';
import {
  ActiveEmbeddingConfigSchema,
  CreatePipelineDefinitionSchema,
  UpdatePipelineDefinitionSchema,
  UpdateEmbeddingConfigSchema,
} from '../schemas.js';

// ─── ActiveEmbeddingConfigSchema ─────────────────────────────────────────

describe('ActiveEmbeddingConfigSchema', () => {
  it('accepts valid BGE-M3 config', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid OpenAI config', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid provider types', () => {
    for (const provider of ['openai', 'cohere', 'bge-m3', 'custom']) {
      const result = ActiveEmbeddingConfigSchema.safeParse({
        provider,
        model: 'test-model',
        dimensions: 512,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid provider type', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'invalid',
      model: 'test',
      dimensions: 512,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty model', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'bge-m3',
      model: '',
      dimensions: 1024,
    });
    expect(result.success).toBe(false);
  });

  it('rejects zero dimensions', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative dimensions', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer dimensions', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024.5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional providerConfig', () => {
    const result = ActiveEmbeddingConfigSchema.safeParse({
      provider: 'custom',
      model: 'my-model',
      dimensions: 768,
      providerConfig: { baseUrl: 'http://my-service:8000' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.providerConfig).toEqual({ baseUrl: 'http://my-service:8000' });
    }
  });
});

// ─── CreatePipelineDefinitionSchema ──────────────────────────────────────

describe('CreatePipelineDefinitionSchema', () => {
  const validCreate = () => ({
    knowledgeBaseId: 'kb-1',
    name: 'Test Pipeline',
    flows: [
      {
        id: 'flow-1',
        name: 'Default',
        enabled: true,
        priority: 10,
        stages: [
          {
            id: 'stage-1',
            name: 'Extract',
            type: 'extraction' as const,
            provider: 'docling',
          },
        ],
      },
    ],
  });

  it('accepts valid pipeline with default embedding config', () => {
    const result = CreatePipelineDefinitionSchema.safeParse(validCreate());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeEmbeddingConfig.provider).toBe('bge-m3');
      expect(result.data.activeEmbeddingConfig.model).toBe('bge-m3');
      expect(result.data.activeEmbeddingConfig.dimensions).toBe(1024);
    }
  });

  it('accepts custom embedding config', () => {
    const result = CreatePipelineDefinitionSchema.safeParse({
      ...validCreate(),
      activeEmbeddingConfig: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeEmbeddingConfig.provider).toBe('openai');
    }
  });

  it('rejects invalid embedding config in create', () => {
    const result = CreatePipelineDefinitionSchema.safeParse({
      ...validCreate(),
      activeEmbeddingConfig: {
        provider: 'invalid',
        model: 'test',
        dimensions: 0,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ─── UpdatePipelineDefinitionSchema ──────────────────────────────────────

describe('UpdatePipelineDefinitionSchema', () => {
  it('accepts partial update with just name', () => {
    const result = UpdatePipelineDefinitionSchema.safeParse({
      name: 'Updated Pipeline',
    });
    expect(result.success).toBe(true);
  });

  it('accepts embedding config update', () => {
    const result = UpdatePipelineDefinitionSchema.safeParse({
      activeEmbeddingConfig: {
        provider: 'cohere',
        model: 'embed-english-v3.0',
        dimensions: 1024,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid embedding config in update', () => {
    const result = UpdatePipelineDefinitionSchema.safeParse({
      activeEmbeddingConfig: {
        provider: 'invalid',
        model: '',
        dimensions: -1,
      },
    });
    expect(result.success).toBe(false);
  });
});

// ─── UpdateEmbeddingConfigSchema ─────────────────────────────────────────

describe('UpdateEmbeddingConfigSchema', () => {
  it('accepts valid config with confirm: true', () => {
    const result = UpdateEmbeddingConfigSchema.safeParse({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      confirm: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects without confirm flag', () => {
    const result = UpdateEmbeddingConfigSchema.safeParse({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
    expect(result.success).toBe(false);
  });

  it('rejects with confirm: false', () => {
    const result = UpdateEmbeddingConfigSchema.safeParse({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      confirm: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid provider', () => {
    const result = UpdateEmbeddingConfigSchema.safeParse({
      provider: 'invalid',
      model: 'test',
      dimensions: 512,
      confirm: true,
    });
    expect(result.success).toBe(false);
  });
});
