import { describe, it, expect } from 'vitest';
import {
  DiscoveredUrlSet,
  normalizeDiscoveryUrl,
  extractLastSegment,
  normalizePattern,
  isSubsetOf,
  MAX_DISCOVERED_URLS,
} from '../url-set';

// ─── normalizeDiscoveryUrl ──────────────────────────────────────────

describe('normalizeDiscoveryUrl', () => {
  it('strips trailing slash from non-root paths', () => {
    expect(normalizeDiscoveryUrl('https://example.com/docs/')).toBe('https://example.com/docs');
  });

  it('preserves trailing slash for root path', () => {
    expect(normalizeDiscoveryUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('strips fragment (#hash)', () => {
    expect(normalizeDiscoveryUrl('https://example.com/page#section')).toBe(
      'https://example.com/page',
    );
  });

  it('strips tracking query parameters (utm_*, fbclid, gclid)', () => {
    const url = 'https://example.com/page?utm_source=google&utm_medium=cpc&fbclid=abc&real=keep';
    expect(normalizeDiscoveryUrl(url)).toBe('https://example.com/page?real=keep');
  });

  it('sorts remaining query parameters alphabetically', () => {
    const url = 'https://example.com/page?z=1&a=2&m=3';
    expect(normalizeDiscoveryUrl(url)).toBe('https://example.com/page?a=2&m=3&z=1');
  });

  it('lowercases hostname (origin)', () => {
    // URL constructor normalizes host to lowercase
    expect(normalizeDiscoveryUrl('https://EXAMPLE.COM/Page')).toBe('https://example.com/Page');
  });

  it('returns raw string for invalid URLs', () => {
    expect(normalizeDiscoveryUrl('not-a-url')).toBe('not-a-url');
  });

  it('strips all tracking params even when mixed case', () => {
    // TRACKING_PARAMS check lowercases the key
    const url = 'https://example.com/page?UTM_SOURCE=x&gclid=y';
    // UTM_SOURCE lowercased -> utm_source -> stripped; gclid -> stripped
    expect(normalizeDiscoveryUrl(url)).toBe('https://example.com/page');
  });
});

// ─── extractLastSegment ─────────────────────────────────────────────

describe('extractLastSegment', () => {
  it('returns the last path segment', () => {
    expect(extractLastSegment('https://example.com/docs/api/reference')).toBe('reference');
  });

  it('handles trailing slash by ignoring empty segment', () => {
    expect(extractLastSegment('https://example.com/docs/guide/')).toBe('guide');
  });

  it('returns empty string for root path', () => {
    expect(extractLastSegment('https://example.com/')).toBe('');
  });

  it('returns the raw string for invalid URLs', () => {
    expect(extractLastSegment('not-a-url')).toBe('not-a-url');
  });

  it('handles single segment path', () => {
    expect(extractLastSegment('https://example.com/about')).toBe('about');
  });
});

// ─── DiscoveredUrlSet ───────────────────────────────────────────────

describe('DiscoveredUrlSet', () => {
  function makeEntry(
    href: string,
    confidence: 'verified' | 'projected' | 'inferred' = 'verified',
    depth = 0,
  ) {
    return { href, text: `Page at ${href}`, confidence, depth };
  }

  describe('add', () => {
    it('adds a new entry and returns true', () => {
      const set = new DiscoveredUrlSet();
      expect(set.add(makeEntry('https://example.com/a'))).toBe(true);
      expect(set.size).toBe(1);
    });

    it('deduplicates normalized URLs and returns false', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a/'));
      const result = set.add(makeEntry('https://example.com/a'));
      expect(result).toBe(false);
      expect(set.size).toBe(1);
    });

    it('deduplicates URLs differing only by fragment', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/page#top'));
      expect(set.add(makeEntry('https://example.com/page#bottom'))).toBe(false);
      expect(set.size).toBe(1);
    });

    it('upgrades confidence from inferred to verified', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a', 'inferred'));
      set.add(makeEntry('https://example.com/a', 'verified'));
      const entry = set.get('https://example.com/a');
      expect(entry?.confidence).toBe('verified');
    });

    it('does not downgrade confidence from verified to inferred', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a', 'verified'));
      set.add(makeEntry('https://example.com/a', 'inferred'));
      const entry = set.get('https://example.com/a');
      expect(entry?.confidence).toBe('verified');
    });

    it('upgrades confidence from inferred to projected', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a', 'inferred'));
      set.add(makeEntry('https://example.com/a', 'projected'));
      const entry = set.get('https://example.com/a');
      expect(entry?.confidence).toBe('projected');
    });

    it('evicts lowest-confidence entry when at MAX_DISCOVERED_URLS', () => {
      const set = new DiscoveredUrlSet();
      // Fill to capacity with projected entries
      for (let i = 0; i < MAX_DISCOVERED_URLS; i++) {
        set.add(makeEntry(`https://example.com/p/${i}`, 'projected'));
      }
      expect(set.size).toBe(MAX_DISCOVERED_URLS);

      // Add one inferred entry that will be the lowest priority — but we're already full
      // so we first need to have at least one inferred entry to evict
      // Let's reset and use a mix
      const set2 = new DiscoveredUrlSet();
      // Add one inferred entry first
      set2.add(makeEntry('https://example.com/inferred-0', 'inferred'));
      // Fill the rest with verified
      for (let i = 1; i < MAX_DISCOVERED_URLS; i++) {
        set2.add(makeEntry(`https://example.com/v/${i}`, 'verified'));
      }
      expect(set2.size).toBe(MAX_DISCOVERED_URLS);

      // Adding one more should evict the inferred entry
      set2.add(makeEntry('https://example.com/new', 'verified'));
      expect(set2.size).toBe(MAX_DISCOVERED_URLS);
      expect(set2.has('https://example.com/inferred-0')).toBe(false);
      expect(set2.has('https://example.com/new')).toBe(true);
    });
  });

  describe('has', () => {
    it('returns true for an added URL', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/page'));
      expect(set.has('https://example.com/page')).toBe(true);
    });

    it('returns true for normalized variant of added URL', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/page/'));
      expect(set.has('https://example.com/page')).toBe(true);
    });

    it('returns false for URL not in set', () => {
      const set = new DiscoveredUrlSet();
      expect(set.has('https://example.com/missing')).toBe(false);
    });

    it('returns false after eviction of that entry', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/evict-me', 'inferred'));
      for (let i = 1; i < MAX_DISCOVERED_URLS; i++) {
        set.add(makeEntry(`https://example.com/fill/${i}`, 'verified'));
      }
      // Trigger eviction
      set.add(makeEntry('https://example.com/new-entry', 'verified'));
      expect(set.has('https://example.com/evict-me')).toBe(false);
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      const set = new DiscoveredUrlSet();
      expect(set.size).toBe(0);
    });

    it('increments on new entries', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a'));
      set.add(makeEntry('https://example.com/b'));
      expect(set.size).toBe(2);
    });

    it('does not increment on duplicate', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a'));
      set.add(makeEntry('https://example.com/a'));
      expect(set.size).toBe(1);
    });
  });

  describe('toArray', () => {
    it('returns all entries', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a'));
      set.add(makeEntry('https://example.com/b'));
      const arr = set.toArray();
      expect(arr).toHaveLength(2);
      expect(arr.map((e) => e.href)).toEqual(
        expect.arrayContaining(['https://example.com/a', 'https://example.com/b']),
      );
    });

    it('returns empty array for empty set', () => {
      const set = new DiscoveredUrlSet();
      expect(set.toArray()).toEqual([]);
    });

    it('returns a new array each call (not the internal map)', () => {
      const set = new DiscoveredUrlSet();
      set.add(makeEntry('https://example.com/a'));
      const arr1 = set.toArray();
      const arr2 = set.toArray();
      expect(arr1).not.toBe(arr2);
      expect(arr1).toEqual(arr2);
    });
  });

  describe('serialize', () => {
    it('returns entries with href, text, confidence, depth', () => {
      const set = new DiscoveredUrlSet();
      set.add({ href: 'https://example.com/a', text: 'Page A', confidence: 'verified', depth: 1 });
      const serialized = set.serialize();
      expect(serialized).toEqual([
        { href: 'https://example.com/a', text: 'Page A', confidence: 'verified', depth: 1 },
      ]);
    });

    it('strips the group field from serialized output', () => {
      const set = new DiscoveredUrlSet();
      set.add({
        href: 'https://example.com/b',
        text: 'Page B',
        confidence: 'projected',
        depth: 2,
        group: 'docs',
      });
      const serialized = set.serialize();
      expect(serialized[0]).not.toHaveProperty('group');
    });

    it('round-trips through deserialize', () => {
      const set = new DiscoveredUrlSet();
      set.add({ href: 'https://example.com/a', text: 'A', confidence: 'verified', depth: 0 });
      set.add({ href: 'https://example.com/b', text: 'B', confidence: 'inferred', depth: 1 });
      const serialized = set.serialize();
      const restored = DiscoveredUrlSet.deserialize(serialized);
      expect(restored.size).toBe(2);
      expect(restored.has('https://example.com/a')).toBe(true);
      expect(restored.has('https://example.com/b')).toBe(true);
    });
  });
});

// ─── normalizePattern ─────────────────────────────────────────────────

describe('normalizePattern', () => {
  it('lowercases the pattern', () => {
    expect(normalizePattern('/Docs/API')).toBe('docs/api');
  });

  it('strips leading slash', () => {
    expect(normalizePattern('/support')).toBe('support');
  });

  it('strips trailing slash', () => {
    expect(normalizePattern('support/')).toBe('support');
  });

  it('strips both leading and trailing slashes', () => {
    expect(normalizePattern('/docs/guides/')).toBe('docs/guides');
  });

  it('handles empty string', () => {
    expect(normalizePattern('')).toBe('');
  });

  it('handles string with only slashes', () => {
    expect(normalizePattern('///')).toBe('');
  });
});

// ─── isSubsetOf ───────────────────────────────────────────────────────

describe('isSubsetOf', () => {
  it('child is subset of parent', () => {
    expect(isSubsetOf('/support/printers', '/support')).toBe(true);
  });

  it('same path is not a subset', () => {
    expect(isSubsetOf('/support', '/support')).toBe(false);
  });

  it('unrelated paths are not subsets', () => {
    expect(isSubsetOf('/docs/api', '/support')).toBe(false);
  });

  it('handles case-insensitive comparison', () => {
    expect(isSubsetOf('/Support/Printers', '/support')).toBe(true);
  });

  it('parent with trailing slash still works', () => {
    expect(isSubsetOf('/docs/guides/', '/docs/')).toBe(true);
  });

  it('partial prefix match does not count (support vs sup)', () => {
    expect(isSubsetOf('/supportive', '/support')).toBe(false);
  });
});
