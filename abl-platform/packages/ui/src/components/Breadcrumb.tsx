/**
 * Breadcrumb Component
 *
 * Navigation breadcrumb trail. Presentational: accepts items + onNavigate as props.
 */

import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

export interface BreadcrumbItem {
  label: string;
  path: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  onNavigate?: (path: string) => void;
  className?: string;
}

export function Breadcrumb({ items, onNavigate, className }: BreadcrumbProps) {
  if (items.length <= 1) return null;

  return (
    <nav className={clsx('flex items-center gap-1 text-sm', className)}>
      {items.map((crumb, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={crumb.path} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-subtle" />}
            {isLast ? (
              <span className="text-foreground font-medium">{crumb.label}</span>
            ) : (
              <button
                onClick={() => onNavigate?.(crumb.path)}
                className="text-muted hover:text-foreground transition-default"
              >
                {crumb.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
