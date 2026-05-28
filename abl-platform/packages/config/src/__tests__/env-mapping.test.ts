import { describe, it, expect } from 'vitest';
import { mapEnvToConfig, mergeEnvMappings, BASE_ENV_MAPPING } from '../env-mapping.js';

describe('mapEnvToConfig', () => {
  describe('type coercion', () => {
    it('should coerce "true" to boolean true', () => {
      const result = mapEnvToConfig({ OTEL_ENABLED: 'true' }, { OTEL_ENABLED: 'otel.enabled' });
      expect(result.otel).toEqual({ enabled: true });
    });

    it('should coerce "false" to boolean false', () => {
      const result = mapEnvToConfig({ OTEL_ENABLED: 'false' }, { OTEL_ENABLED: 'otel.enabled' });
      expect(result.otel).toEqual({ enabled: false });
    });

    it('should keep numeric strings as strings (Zod handles coercion)', () => {
      const result = mapEnvToConfig({ PORT: '3001' }, { PORT: 'server.port' });
      expect(result.server).toEqual({ port: '3001' });
    });

    it('should split comma-separated values into arrays', () => {
      const result = mapEnvToConfig(
        { CORS_ORIGINS: 'http://a.com,http://b.com' },
        { CORS_ORIGINS: 'cors.origins' },
      );
      expect(result.cors).toEqual({ origins: ['http://a.com', 'http://b.com'] });
    });

    it('should trim whitespace in comma-separated values', () => {
      const result = mapEnvToConfig(
        { CORS_ORIGINS: 'http://a.com , http://b.com' },
        { CORS_ORIGINS: 'cors.origins' },
      );
      expect(result.cors).toEqual({ origins: ['http://a.com', 'http://b.com'] });
    });

    it('should not split values starting with { (JSON objects)', () => {
      const result = mapEnvToConfig({ DATA: '{"a":1,"b":2}' }, { DATA: 'data' });
      expect(result.data).toBe('{"a":1,"b":2}');
    });

    it('should keep plain strings as-is', () => {
      const result = mapEnvToConfig(
        { JWT_SECRET: 'my-secret-value' },
        { JWT_SECRET: 'jwt.secret' },
      );
      expect(result.jwt).toEqual({ secret: 'my-secret-value' });
    });

    it('should handle empty string values', () => {
      const result = mapEnvToConfig({ API_KEY: '' }, { API_KEY: 'api.key' });
      expect(result.api).toEqual({ key: '' });
    });
  });

  describe('nested path mapping', () => {
    it('should create deeply nested config from dot paths', () => {
      const result = mapEnvToConfig({ VAR: 'value' }, { VAR: 'a.b.c.d' });
      expect(result).toEqual({ a: { b: { c: { d: 'value' } } } });
    });

    it('should merge multiple vars into same parent', () => {
      const result = mapEnvToConfig({ A: 'val1', B: 'val2' }, { A: 'parent.a', B: 'parent.b' });
      expect(result).toEqual({ parent: { a: 'val1', b: 'val2' } });
    });

    it('should skip undefined env vars', () => {
      const result = mapEnvToConfig({}, { MISSING: 'path' });
      expect(result).toEqual({});
    });
  });

  describe('BASE_ENV_MAPPING coverage', () => {
    it('should map NODE_ENV to env', () => {
      const result = mapEnvToConfig({ NODE_ENV: 'production' }, BASE_ENV_MAPPING);
      expect(result.env).toBe('production');
    });

    it('should map DATABASE_URL to database.url', () => {
      const result = mapEnvToConfig(
        { DATABASE_URL: 'postgresql://localhost/db' },
        BASE_ENV_MAPPING,
      );
      expect((result.database as Record<string, unknown>).url).toBe('postgresql://localhost/db');
    });

    it('should map REDIS_ENABLED to redis.enabled as boolean', () => {
      const result = mapEnvToConfig({ REDIS_ENABLED: 'true' }, BASE_ENV_MAPPING);
      expect((result.redis as Record<string, unknown>).enabled).toBe(true);
    });

    it('should map REDIS_PASSWORD to redis.password', () => {
      const result = mapEnvToConfig({ REDIS_PASSWORD: 'secret' }, BASE_ENV_MAPPING);
      expect((result.redis as Record<string, unknown>).password).toBe('secret');
    });

    it('should map REDIS_TLS_ENABLED to redis.tls as boolean', () => {
      const result = mapEnvToConfig({ REDIS_TLS_ENABLED: 'true' }, BASE_ENV_MAPPING);
      expect((result.redis as Record<string, unknown>).tls).toBe(true);
    });

    it('should map REDIS_CLUSTER to redis.cluster as boolean', () => {
      const result = mapEnvToConfig({ REDIS_CLUSTER: 'true' }, BASE_ENV_MAPPING);
      expect((result.redis as Record<string, unknown>).cluster).toBe(true);
    });

    it('preserves comma-separated REDIS_URL as a single string (cluster seed list)', () => {
      // Regression: cluster-mode REDIS_URL is a comma-separated host:port seed
      // list, NOT a string[]. The Zod redis schema rejects arrays, so the
      // generic comma-split coercion would fail config validation at startup.
      const seedList = 'redis://h1:6379,redis://h2:6379,redis://h3:6379';
      const result = mapEnvToConfig({ REDIS_URL: seedList }, BASE_ENV_MAPPING);
      expect((result.redis as Record<string, unknown>).url).toBe(seedList);
    });

    it('preserves comma-separated MONGODB_URI as a single string (replica-set list)', () => {
      // Same shape: a Mongo replica-set URI is one string with comma-separated
      // hosts, not an array.
      const uri = 'mongodb://h1:27017,h2:27017,h3:27017/abl?replicaSet=rs0';
      const result = mapEnvToConfig({ MONGODB_URI: uri }, BASE_ENV_MAPPING);
      // BASE_ENV_MAPPING does not map MONGODB_URI by default, so just verify
      // coerceValue did not split it when called via a custom mapping.
      const customResult = mapEnvToConfig({ MONGODB_URI: uri }, { MONGODB_URI: 'mongodb.uri' });
      expect((customResult.mongodb as Record<string, unknown>).uri).toBe(uri);
      expect(result).toBeDefined();
    });
  });
});

describe('mergeEnvMappings', () => {
  it('should merge custom mapping with base', () => {
    const custom = { CUSTOM_VAR: 'custom.path' };
    const merged = mergeEnvMappings(custom);
    expect(merged.CUSTOM_VAR).toBe('custom.path');
    expect(merged.NODE_ENV).toBe('env');
  });

  it('should allow custom to override base', () => {
    const custom = { NODE_ENV: 'custom.env' };
    const merged = mergeEnvMappings(custom);
    expect(merged.NODE_ENV).toBe('custom.env');
  });

  it('should merge multiple custom mappings', () => {
    const merged = mergeEnvMappings({ A: 'a' }, { B: 'b' });
    expect(merged.A).toBe('a');
    expect(merged.B).toBe('b');
  });
});
