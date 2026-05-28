/**
 * Breadcrumb Component
 *
 * Navigation breadcrumb trail, auto-generated from route.
 */

import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import {
  useNavigationStore,
  type Breadcrumb as BreadcrumbItem,
} from '../../store/navigation-store';

interface BreadcrumbProps {
  items?: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
  const navigate = useNavigationStore((s) => s.navigate);
  const storeBreadcrumbs = useNavigationStore((s) => s.breadcrumbs);
  const crumbs = items || storeBreadcrumbs;

  if (crumbs.length <= 1) return null;

  return (
    <nav aria-label="Breadcrumb" className={clsx('text-sm', className)}>
      <ol className="flex items-center gap-1">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={crumb.path} className="flex items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden="true" className="w-3.5 h-3.5 text-subtle" />}
              {isLast ? (
                <span aria-current="page" className="text-foreground font-medium">
                  {crumb.label}
                </span>
              ) : (
                <button
                  onClick={() => navigate(crumb.path)}
                  className="text-muted hover:text-foreground transition-default"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
