/**
 * Unit tests for Embedding Async Validation
 */

import { describe, it, expect, vi } from 'vitest';
import { validateEmbeddingConfigAsync } from '../embedding-validation.js';
import type { IActiveEmbeddingConfig } from '@agent-platform/database';

// Mock credential resolution
vi.mock('../../llm-config/embedding-credentials.js', () => ({
  hasEmbeddingCredentials: vi.fn(),
}));

import { hasEmbeddingCredentials } from '../../llm-config/embedding-credentials.js';

const mockHasCredentials = vi.mocked(hasEmbeddingCredentials);

describe('validateEmbeddingConfigAsync', () => {
  it('passes for valid BGE-M3 config (no credentials needed)', async () => {
    mockHasCredentials.mockResolvedValue(true);

    const config: IActiveEmbeddingConfig = {
      provider: 'bge-m3',
      model: 'bge-m3',
      dimensions: 1024,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors).toHaveLength(0);
  });

  it('passes for valid OpenAI config with credentials', async () => {
    mockHasCredentials.mockResolvedValue(true);

    const config: IActiveEmbeddingConfig = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors).toHaveLength(0);
  });

  it('errors when OpenAI credentials are missing', async () => {
    mockHasCredentials.mockResolvedValue(false);

    const config: IActiveEmbeddingConfig = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('EMBEDDING_CREDENTIALS_UNAVAILABLE');
    expect(errors[0].message).toContain('no API key found');
    expect(errors[0].message).toContain('Settings > LLM Providers');
  });

  it('errors for invalid model', async () => {
    mockHasCredentials.mockResolvedValue(true);

    const config: IActiveEmbeddingConfig = {
      provider: 'openai',
      model: 'nonexistent-model',
      dimensions: 1536,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors.some((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH')).toBe(true);
  });

  it('errors for invalid dimensions', async () => {
    mockHasCredentials.mockResolvedValue(true);

    const config: IActiveEmbeddingConfig = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 9999,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors.some((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH')).toBe(true);
  });

  it('passes for custom provider (no registry validation)', async () => {
    mockHasCredentials.mockResolvedValue(true);

    const config: IActiveEmbeddingConfig = {
      provider: 'custom',
      model: 'any-model',
      dimensions: 768,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors).toHaveLength(0);
  });

  it('can return both registry and credential errors', async () => {
    mockHasCredentials.mockResolvedValue(false);

    const config: IActiveEmbeddingConfig = {
      provider: 'openai',
      model: 'nonexistent-model',
      dimensions: 1536,
    };

    const errors = await validateEmbeddingConfigAsync(config, 'tenant-1');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.code === 'EMBEDDING_CONFIG_MISMATCH')).toBe(true);
    expect(errors.some((e) => e.code === 'EMBEDDING_CREDENTIALS_UNAVAILABLE')).toBe(true);
  });
});
