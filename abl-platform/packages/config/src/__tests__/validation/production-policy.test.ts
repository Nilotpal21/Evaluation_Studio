import { describe, it, expect } from 'vitest';
import { validateProductionPolicy } from '../../validation/production-policy.js';

describe('validateProductionPolicy', () => {
  it('should return no issues for valid production config', () => {
    const config = {
      env: 'production',
      observability: { loggingLevel: 'warn', traceSamplingRate: 0.1 },
      features: { debugTracesEnabled: false },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(0);
  });

  it('should skip checks for non-production env', () => {
    const config = {
      env: 'dev',
      observability: { loggingLevel: 'debug', traceSamplingRate: 1.0 },
      features: { debugTracesEnabled: true },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(0);
  });

  it('should flag debug log level in production', () => {
    const config = {
      env: 'production',
      observability: { loggingLevel: 'debug' },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('observability.loggingLevel');
  });

  it('should flag info log level in production', () => {
    const config = {
      env: 'production',
      observability: { loggingLevel: 'info' },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(1);
  });

  it('should allow warn and error log levels', () => {
    expect(
      validateProductionPolicy({
        env: 'production',
        observability: { loggingLevel: 'warn' },
      }),
    ).toHaveLength(0);

    expect(
      validateProductionPolicy({
        env: 'production',
        observability: { loggingLevel: 'error' },
      }),
    ).toHaveLength(0);
  });

  it('should flag high trace sampling rate', () => {
    const config = {
      env: 'production',
      observability: { traceSamplingRate: 0.5 },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('observability.traceSamplingRate');
  });

  it('should allow sampling rate at boundary', () => {
    const config = {
      env: 'production',
      observability: { traceSamplingRate: 0.2 },
    };
    expect(validateProductionPolicy(config)).toHaveLength(0);
  });

  it('should flag debug traces enabled in production', () => {
    const config = {
      env: 'production',
      features: { debugTracesEnabled: true },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('features.debugTracesEnabled');
  });

  it('should flag multiple violations at once', () => {
    const config = {
      env: 'production',
      observability: { loggingLevel: 'debug', traceSamplingRate: 1.0 },
      features: { debugTracesEnabled: true },
    };
    const issues = validateProductionPolicy(config);
    expect(issues).toHaveLength(3);
  });
});
