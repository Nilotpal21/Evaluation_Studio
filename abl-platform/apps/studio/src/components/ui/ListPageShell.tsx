'use client';

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { Pagination } from './Pagination';
import { FilterSelect } from './FilterSelect';
import { Input } from './Input';
import { useRegisterPageHeader } from '../../contexts/PageHeaderContext';
import type { PageCrumb } from './PageBreadcrumb';

interface FilterDef {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

interface ListPageShellProps {
  title: string;
  description?: string;
  breadcrumbs?: PageCrumb[];
  primaryAction?: ReactNode;
  hidePrimaryAction?: boolean;
  secondaryActions?: ReactNode;
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filters?: FilterDef[];
  filterBar?: ReactNode;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
  };
  /** When true, the content area becomes flex-col overflow-hidden with no padding — for full-bleed children like a canvas */
  fullBleedContent?: boolean;
  className?: string;
  children: ReactNode;
}

const ListPageShellPrimaryActionVisibilityContext = createContext<
  ((hidden: boolean) => void) | null
>(null);

export function useListPageShellPrimaryActionHidden(hidden: boolean) {
  const setHidden = useContext(ListPageShellPrimaryActionVisibilityContext);

  useLayoutEffect(() => {
    if (!setHidden) return;
    setHidden(hidden);
    return () => setHidden(false);
  }, [hidden, setHidden]);
}

export function ListPageShell({
  title,
  description,
  breadcrumbs,
  primaryAction,
  hidePrimaryAction = false,
  secondaryActions,
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  filters,
  filterBar,
  pagination,
  fullBleedContent = false,
  className,
  children,
}: ListPageShellProps) {
  const [contentHidesPrimaryAction, setContentHidesPrimaryAction] = useState(false);
  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 0;
  const shouldHidePrimaryAction = hidePrimaryAction || contentHidesPrimaryAction;
  const visiblePrimaryAction = shouldHidePrimaryAction ? null : primaryAction;

  const headerActions = useMemo(
    () =>
      secondaryActions || visiblePrimaryAction ? (
        <div className="flex items-center gap-2">
          {secondaryActions}
          {visiblePrimaryAction}
        </div>
      ) : undefined,
    [secondaryActions, visiblePrimaryAction],
  );

  // Hoist title, description, breadcrumbs, and CTAs into the AppShell header bar
  useRegisterPageHeader(title, headerActions, description, breadcrumbs);

  return (
    <ListPageShellPrimaryActionVisibilityContext.Provider value={setContentHidesPrimaryAction}>
      <div className={clsx('h-full flex flex-col overflow-hidden', className)}>
        {/* Search & Filter Bar */}
        {(onSearchChange || filters || filterBar) && (
          <div className="shrink-0 px-6 py-3 overflow-visible border-b border-default">
            <div className="flex items-center gap-3 flex-wrap">
              {onSearchChange && (
                <div className="w-72">
                  <Input
                    type="text"
                    value={searchValue || ''}
                    onChange={(e) => onSearchChange(e.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    icon={<Search className="w-4 h-4" />}
                  />
                </div>
              )}
              {filters?.map((filter) => (
                <FilterSelect
                  key={filter.id}
                  value={filter.value}
                  onChange={filter.onChange}
                  options={filter.options}
                />
              ))}
              {filterBar}
            </div>
          </div>
        )}

        {/* Content */}
        <div
          className={clsx(
            'flex-1 min-h-0',
            fullBleedContent ? 'overflow-hidden flex flex-col' : 'overflow-auto px-6 py-6',
          )}
        >
          {children}
        </div>

        {/* Pagination */}
        {pagination && totalPages > 1 && (
          <div className="shrink-0 px-6 py-3 border-t border-default">
            <Pagination
              page={pagination.page}
              totalPages={totalPages}
              onPageChange={pagination.onPageChange}
            />
          </div>
        )}
      </div>
    </ListPageShellPrimaryActionVisibilityContext.Provider>
  );
}
