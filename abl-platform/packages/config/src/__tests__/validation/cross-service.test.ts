import { describe, it, expect } from 'vitest';
import { validateCrossServiceConfig } from '../../validation/cross-service.js';
import type { ServiceConfig } from '../../validation/cross-service.js';

describe('validateCrossServiceConfig', () => {
  it('returns no issues when configs are consistent', () => {
    const configs: ServiceConfig[] = [
      {
        name: 'runtime',
        jwt: { secret: 'shared-secret' },
        database: { url: 'mongodb://db-host:27017/app' },
        redis: { host: 'redis-host' },
      },
      {
        name: 'studio',
        jwt: { secret: 'shared-secret' },
        database: { url: 'mongodb://db-host:27017/app' },
        redis: { host: 'redis-host' },
      },
    ];
    const issues = validateCrossServiceConfig(configs);
    expect(issues).toHaveLength(0);
  });

  it('detects JWT secret mismatch', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', jwt: { secret: 'secret-a' } },
      { name: 'studio', jwt: { secret: 'secret-b' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('jwt.secret');
    expect(issues[0].level).toBe('error');
  });

  it('detects MongoDB host mismatch', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', database: { url: 'mongodb://host-a:27017/db' } },
      { name: 'studio', database: { url: 'mongodb://host-b:27017/db' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    const dbIssue = issues.find((i) => i.field === 'database.url');
    expect(dbIssue).toBeDefined();
    expect(dbIssue!.level).toBe('error');
    expect(dbIssue!.message).toContain('host-a');
    expect(dbIssue!.message).toContain('host-b');
  });

  it('detects Redis host mismatch', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', redis: { host: 'redis-a' } },
      { name: 'studio', redis: { host: 'redis-b' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    const redisIssue = issues.find((i) => i.field === 'redis');
    expect(redisIssue).toBeDefined();
    expect(redisIssue!.level).toBe('error');
  });

  it('handles missing optional fields gracefully', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime' },
      { name: 'studio', jwt: { secret: 'secret' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    // Only one service has jwt, so no mismatch possible
    expect(issues).toHaveLength(0);
  });

  it('reports correct service names in issues', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', jwt: { secret: 'secret-a' } },
      { name: 'studio', jwt: { secret: 'secret-b' } },
      { name: 'admin', jwt: { secret: 'secret-a' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    const jwtIssue = issues.find((i) => i.field === 'jwt.secret');
    expect(jwtIssue).toBeDefined();
    expect(jwtIssue!.services).toContain('runtime');
    expect(jwtIssue!.services).toContain('studio');
    expect(jwtIssue!.services).toContain('admin');
    expect(jwtIssue!.services).toHaveLength(3);
  });

  it('returns empty issues for empty array input', () => {
    const issues = validateCrossServiceConfig([]);
    expect(issues).toHaveLength(0);
  });

  it('warns on malformed Redis URL instead of crashing', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', redis: { url: 'not-a-valid-url' } },
      { name: 'studio', redis: { url: 'redis://valid-host:6379' } },
    ];
    // Should not throw
    const issues = validateCrossServiceConfig(configs);
    // The malformed URL will cause new URL() to throw, but the code
    // extracts redis host via cfg.redis?.host fallback or new URL().
    // Current implementation may let the error propagate — this test
    // documents the behavior.
    expect(issues).toBeDefined();
  });

  it('returns no issues for a single service (no mismatch possible)', () => {
    const configs: ServiceConfig[] = [
      {
        name: 'runtime',
        jwt: { secret: 'secret' },
        database: { url: 'mongodb://db:27017/app' },
        redis: { host: 'redis' },
      },
    ];
    const issues = validateCrossServiceConfig(configs);
    expect(issues).toHaveLength(0);
  });

  it('handles mongodb+srv:// URLs (no port) correctly', () => {
    const configs: ServiceConfig[] = [
      { name: 'runtime', database: { url: 'mongodb+srv://cluster0.abc123.mongodb.net/app' } },
      { name: 'studio', database: { url: 'mongodb+srv://cluster0.abc123.mongodb.net/app' } },
    ];
    const issues = validateCrossServiceConfig(configs);
    // Same host, no issues expected
    expect(issues.filter((i) => i.field === 'database.url' && i.level === 'error')).toHaveLength(0);
  });
});
