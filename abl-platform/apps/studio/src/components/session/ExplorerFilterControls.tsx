import { Calendar, ChevronDown, Search, X } from 'lucide-react';
import type React from 'react';
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu';

export type FilterOption = {
  value: string;
  label: string;
};

export function FilterToolbar({
  children,
  resultCount,
  resultLabel,
}: {
  children: React.ReactNode;
  resultCount: number;
  resultLabel: string;
}) {
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-default bg-background-elevated/70 p-2">
      {children}
      <span className="ml-auto whitespace-nowrap px-1 text-xs text-muted">
        {resultCount} {resultLabel}
      </span>
    </div>
  );
}

export function SearchFilter({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-[240px] flex-1 sm:max-w-[340px]">
      <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-default bg-background-subtle py-1.5 pl-8 pr-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-border-focus"
      />
    </div>
  );
}

export function MultiSelectFilter({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: FilterOption[];
  onChange: (values: string[]) => void;
}) {
  const selected = new Set(values);
  const display =
    values.length === 0
      ? label
      : values.length === 1
        ? options.find((option) => option.value === values[0])?.label || values[0]
        : `${label}: ${values.length}`;
  const active = values.length > 0;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onChange([...next]);
  };

  return (
    <details className="group relative">
      <summary
        className={`flex h-9 min-w-[150px] cursor-pointer list-none items-center justify-between gap-2 rounded-lg border px-2.5 text-sm outline-none transition-default [&::-webkit-details-marker]:hidden ${
          active
            ? 'border-info/50 bg-info/10 text-info'
            : 'border-default bg-background-subtle text-foreground hover:bg-background-muted'
        }`}
      >
        <span className="max-w-[160px] truncate">{display}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-10 z-30 w-64 rounded-lg border border-default bg-background-elevated p-2 shadow-lg">
        <div className="mb-1 flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-muted">{label}</span>
          {values.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-muted hover:bg-background-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
        <div className="max-h-56 overflow-auto">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted">No options</div>
          ) : (
            options.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-background-muted"
              >
                <input
                  type="checkbox"
                  aria-label={`${label}: ${option.label}`}
                  checked={selected.has(option.value)}
                  onChange={() => toggle(option.value)}
                  className="h-3.5 w-3.5 accent-current"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}

export function TimePresetFilter<TValue extends string>({
  value,
  options,
  onChange,
}: {
  value: TValue;
  options: Array<{ value: TValue; label: string }>;
  onChange: (value: TValue) => void;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? 'Time range';
  return (
    <DropdownMenu
      trigger={
        <button className="flex h-9 items-center gap-1.5 rounded-lg border border-default bg-background-subtle px-2.5 text-sm font-medium text-foreground transition-default hover:bg-background-muted">
          <Calendar className="h-4 w-4 text-muted" />
          {selectedLabel}
          <ChevronDown className="h-3 w-3 text-muted" />
        </button>
      }
      align="start"
    >
      {options.map((option) => (
        <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)}>
          {option.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenu>
  );
}

export function columnHighlight(active: boolean, align: 'left' | 'right' = 'left'): string {
  const alignment = align === 'right' ? 'text-right' : '';
  return active ? `${alignment} bg-info/5 text-info` : `${alignment} text-muted`;
}

export function uniqueOptions(values: Array<string | null | undefined>, selected: string[] = []) {
  const unique = new Set<string>();
  for (const value of [...selected, ...values]) {
    const normalized = value?.trim();
    if (normalized) unique.add(normalized);
  }
  return [...unique].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
}
