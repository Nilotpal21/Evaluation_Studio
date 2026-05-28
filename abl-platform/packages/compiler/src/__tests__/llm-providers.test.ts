/**
 * LLM Provider Utility Tests
 *
 * Tests error sanitization and deprecated function behavior.
 *
 * Note: Individual provider implementation tests (Anthropic, OpenAI, LiteLLM, Gemini)
 * were removed as part of the Vercel AI SDK migration. Provider instantiation now
 * happens in the runtime layer via SessionLLMClient.
 */

import { describe, test, expect } from 'vitest';
import {
  sanitizeErrorMessage,
  createProvider,
  registerProvider,
  getProviderFactory,
  setDefaultProvider,
  getDefaultProvider,
  getApiKey,
  validateProviderConfig,
  getDefaultModel,
  DEFAULT_MODEL_MAPPINGS,
} from '../platform/llm/provider.js';

// =============================================================================
// ERROR SANITIZATION
// =============================================================================

describe('sanitizeErrorMessage', () => {
  test('redacts Anthropic-style API keys', () => {
    const msg = 'Error with key sk-ant-api03-abcdefghijklmnop';
    expect(sanitizeErrorMessage(msg)).not.toContain('sk-ant-api03');
    expect(sanitizeErrorMessage(msg)).toContain('sk-***');
  });

  test('redacts OpenAI-style API keys', () => {
    const msg = 'Invalid key: sk-proj-abcdefghijklmnop';
    expect(sanitizeErrorMessage(msg)).not.toContain('sk-proj-abcdefghijklmnop');
    expect(sanitizeErrorMessage(msg)).toContain('sk-***');
  });

  test('redacts Bearer tokens', () => {
    const msg = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    expect(sanitizeErrorMessage(msg)).toContain('Bearer ***');
    expect(sanitizeErrorMessage(msg)).not.toContain('eyJhbGciOiJ');
  });

  test('redacts Gemini URL key params', () => {
    const msg = 'Request to https://api.google.com/v1?key=AIzaSyBabcdefghijklmnop failed';
    expect(sanitizeErrorMessage(msg)).toContain('?key=***');
    expect(sanitizeErrorMessage(msg)).not.toContain('AIzaSyB');
  });

  test('preserves normal error text', () => {
    const msg = 'Connection refused: ECONNREFUSED 127.0.0.1:4000';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  test('redacts x-api-key header values', () => {
    const msg = 'x-api-key: sk-ant-long-secret-key-here-abcdef';
    const sanitized = sanitizeErrorMessage(msg);
    // The sk- prefix pattern fires first, but the key material is still stripped
    expect(sanitized).not.toContain('long-secret-key-here-abcdef');
    expect(sanitized).toContain('***');
  });
});

// =============================================================================
// DEPRECATED PROVIDER FUNCTIONS
// =============================================================================

describe('Deprecated provider functions', () => {
  test('createProvider() throws deprecation error', () => {
    expect(() => createProvider({ provider: 'anthropic', apiKey: 'test' })).toThrow(
      'createProvider() is deprecated',
    );
  });

  test('registerProvider() does not throw (no-op warning)', () => {
    expect(() => registerProvider('anthropic', () => {})).not.toThrow();
  });

  test('getProviderFactory() throws deprecation error', () => {
    expect(() => getProviderFactory('anthropic')).toThrow('deprecated');
  });

  test('setDefaultProvider() does not throw (no-op warning)', () => {
    expect(() => setDefaultProvider({ provider: 'anthropic', apiKey: 'test' })).not.toThrow();
  });

  test('getDefaultProvider() throws deprecation error', () => {
    expect(() => getDefaultProvider()).toThrow('deprecated');
  });
});

// =============================================================================
// CONFIGURATION HELPERS
// =============================================================================

describe('getApiKey', () => {
  test('returns apiKey from config', () => {
    expect(getApiKey({ apiKey: 'my-key' })).toBe('my-key');
  });

  test('throws when no key or env var provided', () => {
    expect(() => getApiKey({})).toThrow('No API key provided');
  });

  test('throws when env var is not set', () => {
    expect(() => getApiKey({ apiKeyEnvVar: 'NONEXISTENT_KEY_VAR_12345' })).toThrow(
      'API key not found in environment variable',
    );
  });
});

describe('validateProviderConfig', () => {
  test('throws when provider is missing', () => {
    expect(() => validateProviderConfig({} as any)).toThrow('Provider type is required');
  });

  test('throws when no apiKey or apiKeyEnvVar', () => {
    expect(() => validateProviderConfig({ provider: 'anthropic' } as any)).toThrow(
      'API key or API key environment variable is required',
    );
  });

  test('passes with valid config', () => {
    expect(() => validateProviderConfig({ provider: 'anthropic', apiKey: 'test' })).not.toThrow();
  });
});

// =============================================================================
// DEFAULT MODEL MAPPINGS
// =============================================================================

describe('DEFAULT_MODEL_MAPPINGS', () => {
  test('has entries for all major providers', () => {
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('anthropic');
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('openai');
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('google');
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('azure');
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('cohere');
    expect(DEFAULT_MODEL_MAPPINGS).toHaveProperty('vertex');
  });

  test('each provider has fast, balanced, powerful tiers', () => {
    for (const [provider, models] of Object.entries(DEFAULT_MODEL_MAPPINGS)) {
      expect(models).toHaveProperty('fast', expect.any(String));
      expect(models).toHaveProperty('balanced', expect.any(String));
      expect(models).toHaveProperty('powerful', expect.any(String));
    }
  });
});

describe('getDefaultModel', () => {
  test('returns model for valid provider and tier', () => {
    const model = getDefaultModel('anthropic', 'fast');
    expect(model).toBeDefined();
    expect(typeof model).toBe('string');
  });

  test('defaults to balanced tier', () => {
    const model = getDefaultModel('openai');
    expect(model).toBe(DEFAULT_MODEL_MAPPINGS.openai.balanced);
  });

  test('throws for unknown provider', () => {
    expect(() => getDefaultModel('nonexistent')).toThrow('Unknown provider');
  });

  test('throws for unknown tier', () => {
    expect(() => getDefaultModel('anthropic', 'extreme')).toThrow('Unknown tier');
  });
});
