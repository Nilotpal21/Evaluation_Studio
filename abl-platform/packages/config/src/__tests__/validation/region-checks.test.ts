import { describe, it, expect } from 'vitest';
import { validateRegionConfig } from '../../validation/region-checks.js';
import { BaseAppConfigSchema } from '../../schemas/base-app.schema.js';
import type { BaseAppConfig } from '../../schemas/base-app.schema.js';

/**
 * Helper to create a valid BaseAppConfig with overrides.
 * Uses BaseAppConfigSchema.parse to get proper defaults.
 */
function makeConfig(overrides: Record<string, unknown> = {}): BaseAppConfig {
  return BaseAppConfigSchema.parse({
    env: 'production',
    jwt: { secret: 'a'.repeat(64) },
    database: { url: 'mongodb://eu-west-1.db.example.com:27017/app' },
    server: { apiUrl: 'https://api.example.com', frontendUrl: 'https://app.example.com' },
    llm: { anthropicApiKey: 'sk-test' },
    encryption: {
      masterKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    },
    oauth: { google: { clientId: 'id', clientSecret: 'secret' } },
    redis: { enabled: true, url: 'redis://eu-west-1.redis.example.com:6379' },
    cors: { origins: ['https://app.example.com'] },
    observability: { enabled: true },
    ...overrides,
  });
}

describe('validateRegionConfig', () => {
  it('returns no issues for non-EU region without data residency', () => {
    const config = makeConfig({
      region: { current: 'us-east-1', isPrimary: true, dataResidency: false },
    });
    const issues = validateRegionConfig(config);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues for EU region with data residency and all EU endpoints', () => {
    const config = makeConfig({
      region: { current: 'eu-west-1', isPrimary: true, dataResidency: true },
      database: { url: 'mongodb://eu-west-1.db.example.com:27017/app' },
      redis: { enabled: true, url: 'redis://eu-west-1.cache.example.com:6379' },
    });
    const issues = validateRegionConfig(config);
    // Should have no issues since all endpoints contain EU region identifiers
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('flags issue when EU data residency is on but database URL is US-based', () => {
    const config = makeConfig({
      region: { current: 'eu-west-1', isPrimary: true, dataResidency: true },
      database: { url: 'mongodb://us-east-1.db.example.com:27017/app' },
      redis: { enabled: true, url: 'redis://eu-west-1.cache.example.com:6379' },
    });
    const issues = validateRegionConfig(config);
    const dbIssue = issues.find((i) => i.field === 'database.url');
    expect(dbIssue).toBeDefined();
    expect(dbIssue!.message).toContain('EU data residency');
  });

  it('handles unparseable URL gracefully', () => {
    const config = makeConfig({
      region: { current: 'eu-west-1', isPrimary: true, dataResidency: true },
      database: { url: 'not-a-valid-url' },
      redis: { enabled: false },
    });
    const issues = validateRegionConfig(config);
    const dbIssue = issues.find((i) => i.field === 'database.url');
    expect(dbIssue).toBeDefined();
    expect(dbIssue!.message).toContain('not a valid URL');
  });

  it('returns no issues for non-production config regardless of region', () => {
    const config = makeConfig({
      env: 'development',
      region: { current: 'eu-west-1', isPrimary: true, dataResidency: true },
      database: { url: 'mongodb://us-east-1.db.example.com:27017/app' },
    });
    const issues = validateRegionConfig(config);
    expect(issues).toHaveLength(0);
  });

  it('flags non-primary region without database URL', () => {
    const config = makeConfig({
      region: { current: 'ap-southeast-1', isPrimary: false, dataResidency: false },
      database: {},
    });
    const issues = validateRegionConfig(config);
    const dbIssue = issues.find((i) => i.field === 'database.url');
    expect(dbIssue).toBeDefined();
    expect(dbIssue!.message).toContain('Non-primary region');
  });
});
