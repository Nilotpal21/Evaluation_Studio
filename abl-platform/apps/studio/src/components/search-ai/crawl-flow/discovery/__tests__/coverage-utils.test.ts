import { describe, it, expect } from 'vitest';
import type { CrawlSection } from '../../types';
import { pickPreviewUrls, MAX_PREVIEW_URLS } from '../coverage-utils';

function makeSection(overrides: Partial<CrawlSection> & { pattern: string }): CrawlSection {
  return {
    pattern: overrides.pattern,
    name: overrides.name ?? overrides.pattern,
    pageCount: overrides.pageCount ?? 10,
    examples: overrides.examples ?? [],
    included: overrides.included ?? true,
    estimatedTime: overrides.estimatedTime ?? '10m',
    warnings: overrides.warnings ?? [],
    depth: overrides.depth ?? 0,
    source: overrides.source ?? 'explored',
    sectionId: overrides.sectionId ?? `sec-${overrides.pattern}`,
    pages: overrides.pages,
  };
}

describe('pickPreviewUrls', () => {
  it('returns empty array for empty sections', () => {
    expect(pickPreviewUrls([])).toEqual([]);
  });

  it('skips excluded sections', () => {
    const sections = [
      makeSection({
        pattern: '/docs',
        included: false,
        examples: ['https://e.com/docs/a'],
      }),
    ];
    expect(pickPreviewUrls(sections)).toEqual([]);
  });

  it('selects one URL per section', () => {
    const sections = [
      makeSection({
        pattern: '/docs',
        sectionId: 'sec-1',
        examples: ['https://e.com/docs/a', 'https://e.com/docs/b'],
      }),
      makeSection({
        pattern: '/support',
        sectionId: 'sec-2',
        examples: ['https://e.com/support/x'],
      }),
    ];
    const result = pickPreviewUrls(sections);
    expect(result).toHaveLength(2);
    expect(result[0].sectionId).toBe('sec-1');
    expect(result[1].sectionId).toBe('sec-2');
  });

  it('limits to MAX_PREVIEW_URLS', () => {
    const sections = Array.from({ length: 10 }, (_, i) =>
      makeSection({
        pattern: `/sec-${i}`,
        sectionId: `sec-${i}`,
        examples: [`https://e.com/sec-${i}/page`],
      }),
    );
    const result = pickPreviewUrls(sections);
    expect(result).toHaveLength(MAX_PREVIEW_URLS);
  });

  it('prefers deepest paths (most URL segments)', () => {
    const sections = [
      makeSection({
        pattern: '/docs',
        sectionId: 'sec-1',
        examples: [
          'https://e.com/docs',
          'https://e.com/docs/api/v2/auth',
          'https://e.com/docs/guides',
        ],
      }),
    ];
    const result = pickPreviewUrls(sections);
    expect(result[0].url).toBe('https://e.com/docs/api/v2/auth');
  });

  it('uses pages over examples when available', () => {
    const sections = [
      makeSection({
        pattern: '/docs',
        sectionId: 'sec-1',
        examples: ['https://e.com/docs/example'],
        pages: [{ url: 'https://e.com/docs/page-from-pages', title: 'Page' }],
      }),
    ];
    const result = pickPreviewUrls(sections);
    expect(result[0].url).toBe('https://e.com/docs/page-from-pages');
  });

  it('skips sections with no candidates', () => {
    const sections = [
      makeSection({ pattern: '/empty', sectionId: 'sec-1', examples: [] }),
      makeSection({
        pattern: '/has-data',
        sectionId: 'sec-2',
        examples: ['https://e.com/has-data/page'],
      }),
    ];
    const result = pickPreviewUrls(sections);
    expect(result).toHaveLength(1);
    expect(result[0].sectionId).toBe('sec-2');
  });
});
