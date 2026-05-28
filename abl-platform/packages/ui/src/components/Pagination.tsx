/**
 * Pagination Component
 *
 * Reusable pagination controls for list views.
 * Follows design system: text-sm text-muted, bg-background-muted buttons, rounded-md.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Show page size selector (default: false) */
  showPageSize?: boolean;
  pageSizeOptions?: number[];
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
}

/** Max pages to show without ellipsis */
const MAX_VISIBLE_PAGES = 7;
/** Number of sibling pages to show around the current page */
const SIBLING_DISTANCE = 1;
/** Distance from edge before showing ellipsis */
const EDGE_THRESHOLD = 3;

export function Pagination({
  page,
  totalPages,
  onPageChange,
  showPageSize = false,
  pageSizeOptions = [10, 20, 50],
  pageSize,
  onPageSizeChange,
}: PaginationProps) {
  if (totalPages <= 1 && !showPageSize) return null;

  const canPrev = page > 1;
  const canNext = page < totalPages;

  /** Generate visible page numbers with ellipsis */
  const getPageNumbers = (): (number | 'ellipsis')[] => {
    if (totalPages <= MAX_VISIBLE_PAGES) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages: (number | 'ellipsis')[] = [1];

    if (page > EDGE_THRESHOLD) pages.push('ellipsis');

    const start = Math.max(2, page - SIBLING_DISTANCE);
    const end = Math.min(totalPages - 1, page + SIBLING_DISTANCE);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (page < totalPages - EDGE_THRESHOLD + 1) pages.push('ellipsis');

    pages.push(totalPages);
    return pages;
  };

  return (
    <div className="flex items-center justify-between gap-4 pt-3">
      {showPageSize && onPageSizeChange ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1 text-xs rounded-md border border-default bg-background text-foreground focus:outline-none focus:border-accent"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div />
      )}

      <div className="flex items-center gap-1">
        <button
          onClick={() => canPrev && onPageChange(page - 1)}
          disabled={!canPrev}
          className={clsx(
            'p-1.5 rounded-md transition-default',
            canPrev
              ? 'text-foreground hover:bg-background-muted'
              : 'text-muted cursor-not-allowed opacity-40',
          )}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {getPageNumbers().map((item, idx) =>
          item === 'ellipsis' ? (
            <span key={`ellipsis-${idx}`} className="px-1 text-xs text-muted">
              ...
            </span>
          ) : (
            <button
              key={item}
              onClick={() => onPageChange(item)}
              className={clsx(
                'min-w-[28px] h-7 px-1.5 rounded-md text-xs font-medium transition-default',
                item === page
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:bg-background-muted hover:text-foreground',
              )}
            >
              {item}
            </button>
          ),
        )}

        <button
          onClick={() => canNext && onPageChange(page + 1)}
          disabled={!canNext}
          className={clsx(
            'p-1.5 rounded-md transition-default',
            canNext
              ? 'text-foreground hover:bg-background-muted'
              : 'text-muted cursor-not-allowed opacity-40',
          )}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
