'use client';

import { ChevronRight, FileText, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';

interface SidebarSection {
  slug: string;
  title: string;
  pages: Array<{ slug: string; title: string }>;
}

interface SidebarProps {
  sections: SidebarSection[];
  currentPath?: string;
}

export default function Sidebar({ sections, currentPath }: SidebarProps) {
  const pathname = usePathname() || currentPath || '';
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        type="button"
        className="fixed left-4 top-[58px] z-40 rounded-md bg-white p-2 shadow-sm ring-1 ring-[hsl(220,3%,90%)] lg:hidden"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? 'Close sidebar' : 'Open sidebar'}
      >
        {mobileOpen ? (
          <X className="h-4 w-4 text-[hsl(220,3%,36%)]" />
        ) : (
          <Menu className="h-4 w-4 text-[hsl(220,3%,36%)]" />
        )}
      </button>

      {/* Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'h-full w-64 shrink-0 overflow-y-auto border-r border-[hsl(220,3%,90%)] bg-[hsl(220,5%,96%)] p-4',
          'fixed left-0 top-[49px] z-30 transition-transform lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <nav className="space-y-6">
          {sections.map((section) => (
            <div key={section.slug}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[hsl(220,3%,44%)]">
                {section.title}
              </h3>
              <ul className="space-y-0.5">
                {section.pages.map((page) => {
                  const href = `/docs/${section.slug}/${page.slug}`;
                  const isActive =
                    pathname === href ||
                    (pathname === `/docs/${section.slug}` && page.slug === 'index');

                  return (
                    <li key={page.slug}>
                      <Link
                        href={href}
                        onClick={() => setMobileOpen(false)}
                        className={clsx(
                          'flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors',
                          isActive
                            ? 'border-l-2 border-[hsl(220,5%,13%)] bg-[hsl(220,3%,94%)] font-medium text-[hsl(220,3%,9%)]'
                            : 'text-[hsl(220,3%,36%)] hover:bg-[hsl(220,3%,94%)] hover:text-[hsl(220,3%,9%)]',
                        )}
                      >
                        {isActive ? (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                        )}
                        {page.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
