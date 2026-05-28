'use client';

/**
 * PageBreadcrumb
 *
 * Breadcrumb trail for the AppShell content header bar.
 *
 * Truncation rules:
 *   ≤ 3 crumbs → show all
 *   4+ crumbs  → show [first] / ··· / [second-to-last] / [last]
 *   "···" is interactive: click to reveal hidden crumbs in a popover.
 *
 * The last crumb is always the current page (bold, non-navigable).
 * Earlier crumbs with an `href` are clickable buttons.
 */

import { useState, useRef, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { Tooltip, TooltipProvider } from './Tooltip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PageCrumb = { label: string; href?: string };

interface PageBreadcrumbProps {
  crumbs: PageCrumb[];
  description?: string;
  onNavigate: (href: string) => void;
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

type VisibleItem = PageCrumb | 'ellipsis';

function buildVisible(crumbs: PageCrumb[]): VisibleItem[] {
  if (crumbs.length <= 3) return crumbs;
  return [crumbs[0], 'ellipsis', crumbs.at(-2)!, crumbs.at(-1)!];
}

function buildHidden(crumbs: PageCrumb[]): PageCrumb[] {
  if (crumbs.length <= 3) return [];
  return crumbs.slice(1, -2);
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

function Sep() {
  return <ChevronRight className="w-3.5 h-3.5 text-subtle shrink-0" aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// PageBreadcrumb
// ---------------------------------------------------------------------------

export function PageBreadcrumb({ crumbs, description, onNavigate }: PageBreadcrumbProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const visible = buildVisible(crumbs);
  const hidden = buildHidden(crumbs);

  // Close popover on outside mousedown
  useEffect(() => {
    if (!popoverOpen) return;
    function handler(e: MouseEvent) {
      if (
        popoverRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      )
        return;
      setPopoverOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverOpen]);

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0">
      {visible.map((item, i) => {
        const isLast = i === visible.length - 1;

        return (
          <div key={i} className="flex items-center gap-1 min-w-0">
            {i > 0 && <Sep />}

            {item === 'ellipsis' ? (
              // ··· trigger — reveals hidden ancestors
              <div className="relative shrink-0">
                <button
                  ref={triggerRef}
                  onClick={() => setPopoverOpen((v) => !v)}
                  aria-expanded={popoverOpen}
                  aria-label="Show hidden breadcrumbs"
                  className="px-1 py-0.5 text-sm text-muted hover:text-foreground rounded transition-colors select-none leading-none"
                >
                  ···
                </button>

                {popoverOpen && hidden.length > 0 && (
                  <div
                    ref={popoverRef}
                    role="menu"
                    className="absolute left-0 top-full mt-1.5 z-50 min-w-[160px] bg-background border border-default rounded-lg shadow-md py-1 overflow-hidden"
                  >
                    {hidden.map((crumb, hi) =>
                      crumb.href ? (
                        <button
                          key={hi}
                          role="menuitem"
                          onClick={() => {
                            onNavigate(crumb.href!);
                            setPopoverOpen(false);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-background-muted transition-colors truncate"
                        >
                          {crumb.label}
                        </button>
                      ) : (
                        <span
                          key={hi}
                          role="menuitem"
                          className="block px-3 py-1.5 text-sm text-muted truncate cursor-default"
                        >
                          {crumb.label}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </div>
            ) : isLast ? (
              // Current page — bold; tooltip if description provided
              description ? (
                <TooltipProvider>
                  <Tooltip content={description} side="bottom">
                    <span
                      className="text-sm font-semibold text-foreground truncate max-w-[220px] cursor-default select-none"
                      aria-current="page"
                    >
                      {item.label}
                    </span>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <span
                  className="text-sm font-semibold text-foreground truncate max-w-[220px] select-none"
                  aria-current="page"
                >
                  {item.label}
                </span>
              )
            ) : item.href ? (
              // Ancestor with link
              <button
                onClick={() => onNavigate(item.href!)}
                className={clsx(
                  'text-sm text-muted hover:text-foreground transition-colors truncate max-w-[160px] select-none',
                )}
              >
                {item.label}
              </button>
            ) : (
              // Ancestor without link (non-interactive section label)
              <span className="text-sm text-muted truncate max-w-[160px] select-none">
                {item.label}
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
