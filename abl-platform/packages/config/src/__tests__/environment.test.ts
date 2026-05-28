import { describe, it, expect } from 'vitest';
import {
  normalizeEnvironment,
  isProduction,
  isDevelopment,
  VALID_ENVIRONMENTS,
} from '../environment.js';

describe('VALID_ENVIRONMENTS', () => {
  it('should contain exactly dev, staging, production', () => {
    expect(VALID_ENVIRONMENTS).toEqual(['dev', 'staging', 'production']);
  });
});

describe('normalizeEnvironment', () => {
  it('should map "development" to "dev"', () => {
    expect(normalizeEnvironment('development')).toBe('dev');
  });

  it('should map "prod" to "production"', () => {
    expect(normalizeEnvironment('prod')).toBe('production');
  });

  it('should map "production" to "production"', () => {
    expect(normalizeEnvironment('production')).toBe('production');
  });

  it('should pass through canonical values', () => {
    expect(normalizeEnvironment('dev')).toBe('dev');
    expect(normalizeEnvironment('staging')).toBe('staging');
    expect(normalizeEnvironment('production')).toBe('production');
  });

  it('should handle aliases', () => {
    expect(normalizeEnvironment('stg')).toBe('staging');
  });

  it('should be case-insensitive', () => {
    expect(normalizeEnvironment('PRODUCTION')).toBe('production');
    expect(normalizeEnvironment('Development')).toBe('dev');
  });

  it('should default to "dev" for undefined', () => {
    expect(normalizeEnvironment(undefined)).toBe('dev');
  });

  it('should throw for unknown values', () => {
    expect(() => normalizeEnvironment('invalid')).toThrow('Unknown environment');
    expect(() => normalizeEnvironment('test')).toThrow('Unknown environment');
  });
});

describe('isProduction', () => {
  it('should return true for production', () => {
    expect(isProduction('production')).toBe(true);
  });

  it('should return false for other envs', () => {
    expect(isProduction('dev')).toBe(false);
    expect(isProduction('staging')).toBe(false);
  });
});

describe('isDevelopment', () => {
  it('should return true for dev only', () => {
    expect(isDevelopment('dev')).toBe(true);
  });

  it('should return false for staging and production', () => {
    expect(isDevelopment('staging')).toBe(false);
    expect(isDevelopment('production')).toBe(false);
  });
});
