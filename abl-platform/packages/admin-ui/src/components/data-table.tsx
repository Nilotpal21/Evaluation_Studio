import { useState, useMemo, useCallback, type ReactNode, type KeyboardEvent } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { Skeleton } from './skeleton';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  sortFn?: (a: T, b: T) => number;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  className?: string;
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  columnKey: string;
  direction: SortDirection;
}

const DEFAULT_PAGE_SIZE = 10;
const SKELETON_ROW_COUNT = 5;

export function DataTable<T>({
  columns,
  data,
  rowKey,
  loading = false,
  emptyMessage = 'No data found',
  onRowClick,
  pageSize = DEFAULT_PAGE_SIZE,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [currentPage, setCurrentPage] = useState(0);

  const handleSort = useCallback((column: Column<T>) => {
    if (!column.sortable || !column.sortFn) return;
    setSort((prev) => {
      if (prev?.columnKey === column.key) {
        return prev.direction === 'asc' ? { columnKey: column.key, direction: 'desc' } : null;
      }
      return { columnKey: column.key, direction: 'asc' };
    });
    setCurrentPage(0);
  }, []);

  const sortedData = useMemo(() => {
    if (!sort) return data;
    const column = columns.find((c) => c.key === sort.columnKey);
    if (!column?.sortFn) return data;

    const sorted = [...data].sort(column.sortFn);
    return sort.direction === 'desc' ? sorted.reverse() : sorted;
  }, [data, sort, columns]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, Math.max(0, totalPages - 1));
  const paginatedData = sortedData.slice(
    safeCurrentPage * pageSize,
    (safeCurrentPage + 1) * pageSize,
  );

  const startItem = sortedData.length === 0 ? 0 : safeCurrentPage * pageSize + 1;
  const endItem = Math.min((safeCurrentPage + 1) * pageSize, sortedData.length);

  const getAriaSortValue = (column: Column<T>): 'ascending' | 'descending' | 'none' | undefined => {
    if (!column.sortable) return undefined;
    if (sort?.columnKey !== column.key) return 'none';
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  const getSortIcon = (column: Column<T>) => {
    if (!column.sortable) return null;
    if (sort?.columnKey !== column.key) {
      return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 opacity-40" />;
    }
    return sort.direction === 'asc' ? (
      <ArrowUp className="ml-1 inline h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="ml-1 inline h-3.5 w-3.5" />
    );
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border',
        'bg-background-subtle',
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'px-4 py-3 text-left text-xs font-medium uppercase tracking-wider',
                    'text-foreground-muted',
                    column.sortable && 'cursor-pointer select-none hover:text-foreground',
                  )}
                  style={column.width ? { width: column.width } : undefined}
                  onClick={() => handleSort(column)}
                  {...(column.sortable
                    ? {
                        tabIndex: 0,
                        role: 'button' as const,
                        'aria-sort': getAriaSortValue(column),
                        onKeyDown: (e: KeyboardEvent<HTMLTableCellElement>) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSort(column);
                          }
                        },
                      }
                    : {})}
                >
                  {column.header}
                  {getSortIcon(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-border last:border-b-0">
                  {columns.map((column) => (
                    <td key={column.key} className="px-4 py-3">
                      <Skeleton className="h-4 w-3/4" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && paginatedData.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-sm text-foreground-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
            {!loading &&
              paginatedData.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-border last:border-b-0',
                    'transition-colors duration-150',
                    onRowClick && 'cursor-pointer hover:bg-background-elevated',
                    !onRowClick && 'hover:bg-background-muted',
                  )}
                >
                  {columns.map((column) => (
                    <td key={column.key} className="px-4 py-3 text-sm text-foreground">
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      {!loading && sortedData.length > 0 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <span className="text-sm text-foreground-muted">
            Showing {startItem}-{endItem} of {sortedData.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={safeCurrentPage === 0}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm',
                'text-foreground-muted',
                'hover:bg-background-muted hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safeCurrentPage >= totalPages - 1}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm',
                'text-foreground-muted',
                'hover:bg-background-muted hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
