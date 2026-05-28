import { describe, it, expect } from 'vitest';
import { BaseAppConfigSchema } from '../schemas/base-app.schema.js';
import { EnvironmentSchema } from '../schemas/environment.schema.js';
import { JWTConfigSchema } from '../schemas/jwt.schema.js';
import { LLMConfigSchema } from '../schemas/llm.schema.js';

describe('EnvironmentSchema', () => {
  it('should normalize "development" to "dev"', () => {
    expect(EnvironmentSchema.parse('development')).toBe('dev');
  });

  it('should normalize "production" to "production"', () => {
    expect(EnvironmentSchema.parse('production')).toBe('production');
  });

  it('should pass through canonical values', () => {
    expect(EnvironmentSchema.parse('dev')).toBe('dev');
    expect(EnvironmentSchema.parse('staging')).toBe('staging');
    expect(EnvironmentSchema.parse('production')).toBe('production');
  });

  it('should default to "dev"', () => {
    expect(EnvironmentSchema.parse(undefined)).toBe('dev');
  });

  it('should throw for unknown env', () => {
    expect(() => EnvironmentSchema.parse('invalid')).toThrow();
  });
});

describe('JWTConfigSchema', () => {
  it('should require a secret of at least 32 characters', () => {
    expect(() => JWTConfigSchema.parse({ secret: 'short' })).toThrow();
  });

  it('should accept a valid secret', () => {
    const result = JWTConfigSchema.parse({
      secret: 'a'.repeat(32),
    });
    expect(result.secret).toBe('a'.repeat(32));
    expect(result.accessExpiry).toBe('15m');
    expect(result.refreshExpiry).toBe('7d');
  });

  it('should validate expiry format', () => {
    expect(() =>
      JWTConfigSchema.parse({ secret: 'a'.repeat(32), accessExpiry: 'invalid' }),
    ).toThrow();
  });
});

describe('LLMConfigSchema', () => {
  it('should have sensible defaults', () => {
    const result = LLMConfigSchema.parse({});
    expect(result.defaultModel).toBe('claude-sonnet-4-20250514');
    expect(result.maxTokens).toBe(4096);
    expect(result.provider).toBe('anthropic');
    expect(result.temperature).toBe(0.7);
    expect(result.timeoutMs).toBe(30000);
  });

  it('should accept provider override', () => {
    const result = LLMConfigSchema.parse({ provider: 'openai' });
    expect(result.provider).toBe('openai');
  });

  it('should accept google as a provider override for google-labeled Gemini models', () => {
    const result = LLMConfigSchema.parse({ provider: 'google' });
    expect(result.provider).toBe('google');
  });
});

describe('BaseAppConfigSchema', () => {
  it('should parse minimal config with only JWT secret', () => {
    const result = BaseAppConfigSchema.parse({
      jwt: { secret: 'a'.repeat(32) },
    });

    expect(result.env).toBe('dev');
    expect(result.server.port).toBe(3112);
    expect(result.redis.enabled).toBe(false);
    expect(result.observability.enabled).toBe(false);
    expect(result.security.piiDetection).toBe(true);
    expect(result.region.current).toBe('us-east-1');
  });

  it('should enable Redis when redis.url is set without redis.enabled', () => {
    const result = BaseAppConfigSchema.parse({
      jwt: { secret: 'a'.repeat(32) },
      redis: { url: 'redis://127.0.0.1:6380/0' },
    });
    expect(result.redis.enabled).toBe(true);
  });

  it('should keep Redis disabled when redis.enabled is explicitly false', () => {
    const result = BaseAppConfigSchema.parse({
      jwt: { secret: 'a'.repeat(32) },
      redis: { url: 'redis://127.0.0.1:6380/0', enabled: false },
    });
    expect(result.redis.enabled).toBe(false);
  });

  it('should normalize environment in full config', () => {
    const result = BaseAppConfigSchema.parse({
      env: 'production',
      jwt: { secret: 'a'.repeat(32) },
    });

    expect(result.env).toBe('production');
  });
});
