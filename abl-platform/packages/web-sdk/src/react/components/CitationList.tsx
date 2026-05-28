import React from 'react';
import type { CitationRef } from '../../core/types.js';

interface CitationListProps {
  citations: CitationRef[];
}

const citationStyles = {
  container: {
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid var(--sdk-border-color, #e5e7eb)',
    fontSize: '13px',
  } as React.CSSProperties,
  header: {
    fontWeight: 600,
    color: 'var(--sdk-citation-text, #6b7280)',
    marginBottom: '4px',
    fontSize: '12px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties,
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
  } as React.CSSProperties,
  item: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 8px',
    borderRadius: '4px',
    backgroundColor: 'var(--sdk-citation-bg, #f3f4f6)',
    color: 'var(--sdk-citation-text, #374151)',
    textDecoration: 'none',
    fontSize: '12px',
    lineHeight: '1.5',
    transition: 'background-color 0.15s ease',
  } as React.CSSProperties,
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '18px',
    height: '18px',
    borderRadius: '9px',
    backgroundColor: 'var(--sdk-citation-badge-bg, #e5e7eb)',
    color: 'var(--sdk-citation-badge-text, #6b7280)',
    fontSize: '11px',
    fontWeight: 600,
  } as React.CSSProperties,
};

/**
 * Build the display label for a citation.
 * If pageNumber is available, append " (p. N)" to help users navigate.
 */
function citationLabel(citation: CitationRef): string {
  if (citation.pageNumber && citation.pageNumber > 0) {
    return `${citation.title} (p. ${citation.pageNumber})`;
  }
  return citation.title;
}

export function CitationList({ citations }: CitationListProps): React.ReactElement | null {
  // Validate and filter citations
  const valid = citations.filter(
    (c) => typeof c.index === 'number' && typeof c.url === 'string' && c.url.length > 0,
  );
  if (valid.length === 0) return null;

  return React.createElement(
    'div',
    { style: citationStyles.container, 'data-testid': 'citation-list' },
    React.createElement('div', { style: citationStyles.header }, 'Sources'),
    React.createElement(
      'ul',
      { style: citationStyles.list, role: 'list', 'aria-label': 'Citation sources' },
      ...valid.map((citation) =>
        React.createElement(
          'li',
          { key: citation.index },
          React.createElement(
            'a',
            {
              href: citation.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: citationStyles.item,
              'aria-label': `Open source: ${citationLabel(citation)}`,
              onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => {
                e.currentTarget.style.backgroundColor = 'var(--sdk-citation-hover, #e5e7eb)';
              },
              onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => {
                e.currentTarget.style.backgroundColor = 'var(--sdk-citation-bg, #f3f4f6)';
              },
            },
            React.createElement('span', { style: citationStyles.badge }, String(citation.index)),
            citationLabel(citation),
          ),
        ),
      ),
    ),
  );
}
