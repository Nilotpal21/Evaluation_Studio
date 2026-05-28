'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import type { SectionWithPages } from '../../lib/docs/content';

// Sections that link directly to a dynamic page instead of expanding a tree
const DIRECT_LINK_SECTIONS: Record<string, string> = {
  features: '/docs/features',
  testing: '/docs/testing',
};

interface DocsSidebarProps {
  sections: SectionWithPages[];
}

export function DocsSidebar({ sections }: DocsSidebarProps) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // Auto-expand the section that contains the current page
    const result: Record<string, boolean> = {};
    for (const section of sections) {
      const isActive = pathname.startsWith(`/docs/${section.slug}`);
      result[section.slug] = isActive;
    }
    return result;
  });

  const toggleSection = (slug: string) => {
    setExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  return (
    <nav className="sticky top-0 h-screen w-64 shrink-0 overflow-y-auto border-r border-default bg-background-elevated p-4">
      <div className="mb-6">
        <Link
          href="/docs"
          className="text-lg font-semibold text-foreground transition-default hover:text-accent"
        >
          Internal Docs
        </Link>
      </div>
      <div className="space-y-1">
        {sections.map((section) => {
          // Sections with dynamic pages — render as direct links
          const directLink = DIRECT_LINK_SECTIONS[section.slug];
          if (directLink) {
            const isActive = pathname.startsWith(directLink);
            return (
              <div key={section.slug}>
                <Link
                  href={directLink}
                  className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-default ${
                    isActive
                      ? 'bg-accent-subtle text-accent'
                      : 'text-muted hover:bg-background-muted hover:text-foreground'
                  }`}
                >
                  <span>{section.title}</span>
                </Link>
              </div>
            );
          }

          return (
            <div key={section.slug}>
              <button
                onClick={() => toggleSection(section.slug)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted transition-default hover:bg-background-muted hover:text-foreground"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                    expanded[section.slug] ? 'rotate-90' : ''
                  }`}
                />
                <span>{section.title}</span>
              </button>
              {expanded[section.slug] && section.pages.length > 0 && (
                <div className="ml-4 mt-0.5 space-y-0.5">
                  {section.pages.map((page) => {
                    const href = `/docs/${section.slug}${page.slug === 'index' ? '' : `/${page.slug}`}`;
                    const isActive =
                      pathname === href || pathname === `/docs/${section.slug}/${page.slug}`;
                    return (
                      <Link
                        key={page.slug}
                        href={href}
                        className={`block rounded-md px-2 py-1 text-sm transition-default ${
                          isActive
                            ? 'bg-accent-subtle font-medium text-accent'
                            : 'text-muted hover:bg-background-muted hover:text-foreground'
                        }`}
                      >
                        {page.title}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
