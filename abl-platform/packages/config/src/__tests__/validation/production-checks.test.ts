import { describe, it, expect } from 'vitest';
import { validateProductionConfig } from '../../validation/production-checks.js';
import { BaseAppConfigSchema } from '../../schemas/base-app.schema.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return BaseAppConfigSchema.parse({
    env: 'production',
    jwt: { secret: 'a'.repeat(64) },
    database: { url: 'postgresql://localhost/test' },
    server: { apiUrl: 'https://api.example.com', frontendUrl: 'https://app.example.com' },
    llm: { anthropicApiKey: 'sk-test' },
    encryption: {
      masterKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    },
    oauth: { google: { clientId: 'id', clientSecret: 'secret' } },
    redis: { enabled: true, url: 'redis://localhost:6379' },
    cors: { origins: ['https://app.example.com'] },
    observability: { enabled: true },
    ...overrides,
  });
}

describe('validateProductionConfig', () => {
  it('should return no issues for fully configured prod', () => {
    const config = makeConfig();
    const issues = validateProductionConfig(config);
    expect(issues).toHaveLength(0);
  });

  it('should skip checks for non-production environments', () => {
    const config = BaseAppConfigSchema.parse({
      env: 'development',
      jwt: { secret: 'development-secret-change-in-production' },
    });
    const issues = validateProductionConfig(config);
    expect(issues).toHaveLength(0);
  });

  it('should flag default JWT secret', () => {
    const config = makeConfig({
      jwt: { secret: 'development-secret-change-in-production' },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'jwt.secret' && i.level === 'error')).toBe(true);
  });

  it('should flag missing database URL', () => {
    const config = makeConfig({ database: {} });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'database.url')).toBe(true);
  });

  it('should flag disabled redis in prod', () => {
    const config = makeConfig({ redis: { enabled: false } });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'redis.enabled')).toBe(true);
  });

  it('should flag disabled observability in prod', () => {
    const config = makeConfig({ observability: { enabled: false } });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'observability.enabled')).toBe(true);
  });

  it('should flag all-zero encryption key', () => {
    const config = makeConfig({
      encryption: { masterKey: '0'.repeat(64) },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'encryption.masterKey' && i.level === 'error')).toBe(
      true,
    );
  });

  it('should flag wildcard CORS origins', () => {
    const config = makeConfig({
      cors: { origins: ['*'] },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'cors.origins' && i.level === 'error')).toBe(true);
  });

  it('should flag localhost CORS origins in production', () => {
    const config = makeConfig({
      cors: { origins: ['http://localhost:3000'] },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'cors.origins' && i.level === 'warning')).toBe(true);
  });

  it('should flag Redis enabled without URL', () => {
    const config = makeConfig({
      redis: { enabled: true },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'redis.url' && i.level === 'error')).toBe(true);
  });

  it('should not flag valid encryption key', () => {
    const config = makeConfig({
      encryption: {
        masterKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
      },
    });
    const issues = validateProductionConfig(config);
    expect(issues.some((i) => i.field === 'encryption.masterKey' && i.level === 'error')).toBe(
      false,
    );
  });
});
