/**
 * Invitation Helper Tests
 *
 * Tests for maskEmail (public token lookup) and emailMatchesMask (invite page).
 */

import { describe, test, expect } from 'vitest';

// ---------------------------------------------------------------------------
// maskEmail — extracted from apps/studio/src/app/api/invitations/[token]/route.ts
// We re-implement it here to test the logic in isolation.
// ---------------------------------------------------------------------------

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${local[1]}***@${domain}`;
}

describe('maskEmail', () => {
  test('masks standard email preserving first 2 chars', () => {
    expect(maskEmail('testuser@example.com')).toBe('te***@example.com');
  });

  test('masks short local part (2 chars)', () => {
    expect(maskEmail('ab@example.com')).toBe('a***@example.com');
  });

  test('masks single char local part', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  test('returns *** for invalid email without @', () => {
    expect(maskEmail('noemail')).toBe('***');
  });

  test('returns *** for empty string', () => {
    expect(maskEmail('')).toBe('***');
  });

  test('preserves full domain', () => {
    expect(maskEmail('john.doe@company.co.uk')).toBe('jo***@company.co.uk');
  });
});

// ---------------------------------------------------------------------------
// emailMatchesMask — extracted from apps/studio/src/app/invite/[token]/page.tsx
// ---------------------------------------------------------------------------

function emailMatchesMask(fullEmail: string, maskedEmail: string): boolean {
  if (!maskedEmail.includes('***')) return fullEmail.toLowerCase() === maskedEmail.toLowerCase();
  const [maskedLocal, maskedDomain] = maskedEmail.split('@');
  const [fullLocal, fullDomain] = fullEmail.toLowerCase().split('@');
  if (!maskedLocal || !maskedDomain || !fullLocal || !fullDomain) return false;
  if (maskedDomain.toLowerCase() !== fullDomain) return false;
  const visiblePrefix = maskedLocal.replace('***', '');
  return fullLocal.startsWith(visiblePrefix.toLowerCase());
}

describe('emailMatchesMask', () => {
  test('matches correct email against masked version', () => {
    expect(emailMatchesMask('testuser@example.com', 'te***@example.com')).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(emailMatchesMask('TestUser@Example.COM', 'te***@example.com')).toBe(true);
  });

  test('rejects different domain', () => {
    expect(emailMatchesMask('testuser@other.com', 'te***@example.com')).toBe(false);
  });

  test('rejects wrong prefix', () => {
    expect(emailMatchesMask('admin@example.com', 'te***@example.com')).toBe(false);
  });

  test('handles unmasked email (exact match)', () => {
    expect(emailMatchesMask('test@example.com', 'test@example.com')).toBe(true);
    expect(emailMatchesMask('test@example.com', 'other@example.com')).toBe(false);
  });

  test('handles short masked prefix', () => {
    expect(emailMatchesMask('ab@example.com', 'a***@example.com')).toBe(true);
    expect(emailMatchesMask('zb@example.com', 'a***@example.com')).toBe(false);
  });

  test('returns false for invalid inputs', () => {
    expect(emailMatchesMask('noemail', 'te***@example.com')).toBe(false);
    expect(emailMatchesMask('test@example.com', 'noemail')).toBe(false);
  });
});
