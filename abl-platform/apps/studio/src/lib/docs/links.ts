const DOCS_ORIGIN = 'https://docs.local';

const ABSOLUTE_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export interface DocLinkContext {
  section: string;
  slug: string;
}

export function resolveDocHref(href: string, context?: DocLinkContext): string {
  if (
    href.startsWith('/') ||
    href.startsWith('#') ||
    ABSOLUTE_SCHEME_PATTERN.test(href) ||
    !context
  ) {
    return href;
  }

  const basePath =
    context.slug === 'index'
      ? `/docs/${context.section}/`
      : `/docs/${context.section}/${context.slug}`;

  const resolved = new URL(href, `${DOCS_ORIGIN}${basePath}`);
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
