import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { isSafeDocsPathSegment } from '../lib/content';
import { buildDocsSearchIndex, filterDocsSearchIndex } from '../lib/docs-search';

const shellSourceFiles = [
  new URL('../app/layout.tsx', import.meta.url),
  new URL('../components/Header.tsx', import.meta.url),
  new URL('../components/Sidebar.tsx', import.meta.url),
  new URL('../components/SearchDocs.tsx', import.meta.url),
];

const searchSections = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    pages: [
      {
        slug: 'quickstart',
        title: 'Quickstart',
        description: 'Build your first agent',
      },
    ],
  },
  {
    slug: 'runtime',
    title: 'Runtime',
    pages: [
      {
        slug: 'index',
        title: 'Runtime Overview',
        description: 'Execution model and operations',
      },
    ],
  },
];

describe('docs search affordance', () => {
  it('exposes an accessible search option in the authenticated docs shell', async () => {
    const shellSource = (
      await Promise.all(shellSourceFiles.map((fileUrl) => readFile(fileUrl, 'utf8')))
    ).join('\n');

    expect(shellSource).toMatch(
      /(?:type=["']search["']|role=["']search["']|aria-label=["']Search docs["'])/,
    );
  });

  it('builds searchable links from existing docs navigation metadata', () => {
    expect(buildDocsSearchIndex(searchSections)).toEqual([
      {
        href: '/docs/getting-started/quickstart',
        sectionTitle: 'Getting Started',
        title: 'Quickstart',
        description: 'Build your first agent',
      },
      {
        href: '/docs/runtime/index',
        sectionTitle: 'Runtime',
        title: 'Runtime Overview',
        description: 'Execution model and operations',
      },
    ]);
  });

  it('filters by title, description, and section while hiding empty or unmatched searches', () => {
    const searchIndex = buildDocsSearchIndex(searchSections);

    expect(filterDocsSearchIndex(searchIndex, 'agent')).toHaveLength(1);
    expect(filterDocsSearchIndex(searchIndex, 'runtime')).toHaveLength(1);
    expect(filterDocsSearchIndex(searchIndex, '   ')).toEqual([]);
    expect(filterDocsSearchIndex(searchIndex, 'missing docs term')).toEqual([]);
  });

  it('rejects unsafe docs route path segments before filesystem resolution', () => {
    expect(isSafeDocsPathSegment('getting-started')).toBe(true);
    expect(isSafeDocsPathSegment('../secrets')).toBe(false);
    expect(isSafeDocsPathSegment('..')).toBe(false);
    expect(isSafeDocsPathSegment('https:evil')).toBe(false);
    expect(isSafeDocsPathSegment('api/reference')).toBe(false);
  });
});
