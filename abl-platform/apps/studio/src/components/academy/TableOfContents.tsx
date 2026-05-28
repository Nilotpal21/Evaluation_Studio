'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

interface Heading {
  id: string;
  text: string;
  level: number;
}

interface TableOfContentsProps {
  headings: Heading[];
}

export function TableOfContents({ headings }: TableOfContentsProps) {
  const t = useTranslations('academy');
  const [activeId, setActiveId] = useState<string>('');
  const observerRef = useRef<IntersectionObserver | null>(null);

  const handleClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  }, []);

  useEffect(() => {
    if (headings.length === 0) return;

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const headingElements = headings
      .map((h) => document.getElementById(h.id))
      .filter(Boolean) as HTMLElement[];

    if (headingElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the first heading that is intersecting
        const visibleEntries = entries.filter((entry) => entry.isIntersecting);
        if (visibleEntries.length > 0) {
          setActiveId(visibleEntries[0].target.id);
        }
      },
      {
        rootMargin: '0px 0px -80% 0px',
        threshold: 0,
      },
    );

    headingElements.forEach((el) => observer.observe(el));
    observerRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [headings]);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="sticky top-0 flex max-h-screen flex-col overflow-y-auto py-2">
      <h4 className="mb-3 px-2 text-xs font-semibold uppercase tracking-wider text-foreground-muted">
        {t('on_this_page')}
      </h4>
      <nav className="flex flex-col gap-0.5">
        {headings.map((heading) => {
          const isActive = activeId === heading.id;
          const indent = heading.level >= 3 ? 'pl-5' : 'pl-2';

          return (
            <a
              key={heading.id}
              href={`#${heading.id}`}
              onClick={(e) => handleClick(e, heading.id)}
              className={`block truncate rounded-md py-1 pr-2 text-xs transition-colors ${
                isActive
                  ? `border-l-2 border-accent ${indent} font-medium text-accent`
                  : `${indent} text-foreground-muted hover:text-foreground`
              }`}
            >
              {heading.text}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
