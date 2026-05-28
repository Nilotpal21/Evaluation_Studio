export interface DocsSearchPage {
  slug: string;
  title: string;
  description?: string;
}

export interface DocsSearchSection {
  slug: string;
  title: string;
  pages: DocsSearchPage[];
}

export interface DocsSearchResult {
  href: string;
  sectionTitle: string;
  title: string;
  description: string;
}

export function buildDocsSearchIndex(sections: DocsSearchSection[]): DocsSearchResult[] {
  return sections.flatMap((section) =>
    section.pages.map((page) => ({
      href: `/docs/${section.slug}/${page.slug}`,
      sectionTitle: section.title,
      title: page.title,
      description: page.description ?? '',
    })),
  );
}

export function filterDocsSearchIndex(
  searchIndex: DocsSearchResult[],
  query: string,
): DocsSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  return searchIndex.filter((result) =>
    [result.title, result.description, result.sectionTitle].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    ),
  );
}
