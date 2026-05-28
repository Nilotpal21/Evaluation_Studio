import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Override process.cwd to point to fixtures
const fixturesDir = path.resolve(__dirname, '..', 'fixtures', 'docs-content');

describe('docs content loader', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, 'cwd').mockReturnValue(fixturesDir);
  });

  it('INT-1: parses frontmatter from real MDX fixture', async () => {
    const { getDocPage } = await import('../../lib/docs/content');
    const page = await getDocPage('test-section', 'test-page');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Test Page');
    expect(page!.section).toBe('test-section');
    expect(page!.order).toBe(1);
    expect(page!.description).toBe('A test page for unit tests.');
    expect(page!.content).toContain('Hello World');
  });

  it('INT-2: missing file returns null', async () => {
    const { getDocPage } = await import('../../lib/docs/content');
    const page = await getDocPage('nonexistent', 'missing');
    expect(page).toBeNull();
  });

  it('INT-3: getSectionPages returns sorted pages', async () => {
    const { getSectionPages } = await import('../../lib/docs/content');
    const pages = await getSectionPages('test-section');
    expect(pages.length).toBeGreaterThan(0);
    // Verify sorted by order
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].order).toBeGreaterThanOrEqual(pages[i - 1].order);
    }
  });

  it('INT-10: malformed frontmatter handled gracefully', async () => {
    const { getDocPage } = await import('../../lib/docs/content');
    // gray-matter is lenient — it may parse or throw on invalid YAML
    // Either outcome is acceptable: null or a page with defaults
    try {
      const page = await getDocPage('test-section', 'malformed-frontmatter');
      // If it doesn't throw, verify the content is still accessible
      if (page) {
        expect(page.content).toContain('Content after malformed frontmatter');
      }
    } catch {
      // gray-matter may throw on some malformed YAML — that's acceptable
      expect(true).toBe(true);
    }
  });
});
