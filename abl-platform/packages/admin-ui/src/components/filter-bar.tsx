import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../lib/cn';

export interface FilterOption {
  label: string;
  value: string;
}

export interface SelectFilter {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}

interface FilterBarProps {
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  filters?: SelectFilter[];
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({ search, filters, actions, className }: FilterBarProps) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {search && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
          <input
            type="text"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search...'}
            className={cn(
              'h-9 w-64 rounded-md border border-border pl-9 pr-3 text-sm',
              'bg-background-subtle',
              'text-foreground',
              'placeholder:text-foreground-subtle',
              'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
            )}
          />
        </div>
      )}

      {filters?.map((filter) => (
        <select
          key={filter.id}
          value={filter.value}
          onChange={(e) => filter.onChange(e.target.value)}
          className={cn(
            'h-9 rounded-md border border-border px-3 text-sm',
            'bg-background-subtle',
            'text-foreground',
            'focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent',
          )}
          aria-label={filter.label}
        >
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ))}

      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
