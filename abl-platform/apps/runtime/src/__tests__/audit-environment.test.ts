import { describe, expect, test } from 'vitest';
import { getRuntimeAuditEnvironment } from '../services/audit-environment.js';

describe('getRuntimeAuditEnvironment', () => {
  test('maps NODE_ENV=test to dev', () => {
    expect(getRuntimeAuditEnvironment({ NODE_ENV: 'test' })).toBe('dev');
  });

  test('prefers deployment-specific environment variables when present', () => {
    expect(
      getRuntimeAuditEnvironment({
        DEPLOYMENT_ENVIRONMENT: 'staging',
        NODE_ENV: 'production',
      }),
    ).toBe('staging');
  });

  test('maps production aliases to the canonical production label', () => {
    expect(getRuntimeAuditEnvironment({ NODE_ENV: 'prod' })).toBe('production');
  });

  test('falls back to dev for unknown environments', () => {
    expect(getRuntimeAuditEnvironment({ NODE_ENV: 'qa' })).toBe('dev');
  });
});
