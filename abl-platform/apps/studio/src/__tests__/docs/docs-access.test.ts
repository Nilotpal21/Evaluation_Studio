import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkDomainAllowed, getAllowedDomains } from '../../lib/docs/access';

describe('checkDomainAllowed', () => {
  it('returns true for allowed domain (kore.ai)', () => {
    expect(checkDomainAllowed('user@kore.ai', ['kore.ai', 'kore.com'])).toBe(true);
  });

  it('returns false for non-allowed domain', () => {
    expect(checkDomainAllowed('user@gmail.com', ['kore.ai', 'kore.com'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(checkDomainAllowed('user@KORE.AI', ['kore.ai'])).toBe(true);
    expect(checkDomainAllowed('user@Kore.Ai', ['kore.ai'])).toBe(true);
  });

  it('rejects subdomains (no wildcard)', () => {
    expect(checkDomainAllowed('user@sub.kore.ai', ['kore.ai'])).toBe(false);
  });

  it('handles missing @ symbol', () => {
    expect(checkDomainAllowed('noemail', ['kore.ai'])).toBe(false);
  });

  it('handles empty email', () => {
    expect(checkDomainAllowed('', ['kore.ai'])).toBe(false);
  });

  it('handles empty allowed domains', () => {
    expect(checkDomainAllowed('user@kore.ai', [])).toBe(false);
  });

  it('uses lastIndexOf for emails with multiple @ symbols', () => {
    expect(checkDomainAllowed('user@name@kore.ai', ['kore.ai'])).toBe(true);
  });
});

describe('getAllowedDomains', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default domains when env var is missing', () => {
    delete process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS;
    expect(getAllowedDomains()).toEqual(['kore.ai', 'kore.com']);
  });

  it('returns default domains when env var is empty', () => {
    process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS = '';
    expect(getAllowedDomains()).toEqual(['kore.ai', 'kore.com']);
  });

  it('returns default domains when env var is whitespace-only', () => {
    process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS = '   ';
    expect(getAllowedDomains()).toEqual(['kore.ai', 'kore.com']);
  });

  it('parses comma-separated domains', () => {
    process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS = 'example.com,test.org';
    expect(getAllowedDomains()).toEqual(['example.com', 'test.org']);
  });

  it('trims whitespace around domains', () => {
    process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS = ' kore.ai , kore.com ';
    expect(getAllowedDomains()).toEqual(['kore.ai', 'kore.com']);
  });

  it('filters out empty entries from trailing commas', () => {
    process.env.NEXT_PUBLIC_DOCS_ALLOWED_DOMAINS = 'kore.ai,,kore.com,';
    expect(getAllowedDomains()).toEqual(['kore.ai', 'kore.com']);
  });
});
