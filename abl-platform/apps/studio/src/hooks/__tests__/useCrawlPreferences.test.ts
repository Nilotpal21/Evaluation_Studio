/**
 * useCrawlPreferences Hook Tests
 *
 * Tests domain pattern matching and preference auto-selection logic.
 */

import { describe, test, expect } from 'vitest';

// ---------------------------------------------------------------------------
// We test the pure pattern-matching logic directly rather than going through
// React hooks, which keeps the tests fast and independent of react-query.
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob domain pattern to a RegExp.
 * (Duplicated from the hook for isolated unit testing.)
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

interface MockPreference {
  domainPattern: string;
  strategy: string;
  autoDecide: boolean;
  useCount: number;
}

function findMatch(url: string, preferences: MockPreference[]): MockPreference | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  let best: MockPreference | null = null;
  let bestSpecificity = -1;

  for (const pref of preferences) {
    const regex = patternToRegExp(pref.domainPattern);
    if (!regex.test(hostname)) continue;

    const specificity = pref.domainPattern.includes('*') ? pref.domainPattern.length : 1000;

    if (specificity > bestSpecificity) {
      best = pref;
      bestSpecificity = specificity;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useCrawlPreferences - pattern matching', () => {
  const preferences: MockPreference[] = [
    {
      domainPattern: '*.example.com',
      strategy: 'bulk',
      autoDecide: true,
      useCount: 5,
    },
    {
      domainPattern: '*.docs.anthropic.com',
      strategy: 'hybrid',
      autoDecide: true,
      useCount: 12,
    },
    {
      domainPattern: 'docs.anthropic.com',
      strategy: 'browser',
      autoDecide: false,
      useCount: 3,
    },
    {
      domainPattern: '*.github.com',
      strategy: 'bulk',
      autoDecide: false,
      useCount: 1,
    },
  ];

  test('should match exact domain preference', () => {
    const result = findMatch('https://docs.anthropic.com/guide', preferences);
    // Exact match (specificity 1000) beats wildcard
    expect(result?.domainPattern).toBe('docs.anthropic.com');
    expect(result?.strategy).toBe('browser');
  });

  test('should match wildcard preference', () => {
    const result = findMatch('https://sub.example.com/page', preferences);
    expect(result?.domainPattern).toBe('*.example.com');
    expect(result?.strategy).toBe('bulk');
  });

  test('should prefer more specific wildcard', () => {
    // '*.docs.anthropic.com' (24 chars) > '*.anthropic.com' (would be 16)
    const result = findMatch('https://api.docs.anthropic.com/ref', preferences);
    expect(result?.domainPattern).toBe('*.docs.anthropic.com');
  });

  test('should match github wildcard', () => {
    const result = findMatch('https://myrepo.github.com/wiki', preferences);
    expect(result?.domainPattern).toBe('*.github.com');
  });

  test('should return null for non-matching URL', () => {
    const result = findMatch('https://unknown-site.org', preferences);
    expect(result).toBeNull();
  });

  test('should return null for invalid URL', () => {
    const result = findMatch('not-a-url', preferences);
    expect(result).toBeNull();
  });

  test('should return null for empty preferences', () => {
    const result = findMatch('https://example.com', []);
    expect(result).toBeNull();
  });

  test('should be case-insensitive', () => {
    const result = findMatch('https://SUB.EXAMPLE.COM/page', preferences);
    expect(result?.domainPattern).toBe('*.example.com');
  });
});
