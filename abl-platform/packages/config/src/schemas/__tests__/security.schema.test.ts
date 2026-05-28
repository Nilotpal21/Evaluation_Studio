import { describe, it, expect } from 'vitest';
import { SecurityConfigSchema } from '../security.schema.js';

describe('SecurityConfigSchema — stringOrArray fields', () => {
  const field = 'oauthAllowedRedirectOrigins';

  it('passes through an array unchanged', () => {
    const result = SecurityConfigSchema.parse({
      [field]: ['https://a.com', 'https://b.com'],
    });
    expect(result[field]).toEqual(['https://a.com', 'https://b.com']);
  });

  it('splits a comma-separated string into an array', () => {
    const result = SecurityConfigSchema.parse({
      [field]: 'https://a.com, https://b.com',
    });
    expect(result[field]).toEqual(['https://a.com', 'https://b.com']);
  });

  it('wraps a single string (no comma) into a one-element array', () => {
    const result = SecurityConfigSchema.parse({
      [field]: 'https://only.com',
    });
    expect(result[field]).toEqual(['https://only.com']);
  });

  it('produces an empty array from an empty string', () => {
    const result = SecurityConfigSchema.parse({
      [field]: '',
    });
    expect(result[field]).toEqual([]);
  });

  it('trims whitespace around values', () => {
    const result = SecurityConfigSchema.parse({
      [field]: '  https://a.com ,  https://b.com  ',
    });
    expect(result[field]).toEqual(['https://a.com', 'https://b.com']);
  });

  it('defaults to an empty array when omitted', () => {
    const result = SecurityConfigSchema.parse({});
    expect(result[field]).toEqual([]);
  });

  it('applies the same parsing to superAdminUserIds', () => {
    const result = SecurityConfigSchema.parse({
      superAdminUserIds: 'user1, user2',
    });
    expect(result.superAdminUserIds).toEqual(['user1', 'user2']);
  });

  it('applies the same parsing to platformAdminAllowedIps', () => {
    const result = SecurityConfigSchema.parse({
      platformAdminAllowedIps: '10.0.0.1',
    });
    expect(result.platformAdminAllowedIps).toEqual(['10.0.0.1']);
  });
});
