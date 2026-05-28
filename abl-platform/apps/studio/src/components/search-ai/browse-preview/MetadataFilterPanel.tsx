/**
 * MetadataFilterPanel
 *
 * Sidebar panel for filtering search results by canonical metadata fields.
 * Fetches available filter fields from the discovery API and renders
 * checkboxes for enum values + text inputs for free-form fields.
 */

'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, Filter, X, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { Checkbox } from '../../ui/Checkbox';
import { Badge } from '../../ui/Badge';
import type { DiscoveryFilterField } from '../../../api/search-ai';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ActiveFilter {
  field: string;
  operator: string;
  value: unknown;
}

interface MetadataFilterPanelProps {
  /** Available filter fields from discovery API */
  filterFields: DiscoveryFilterField[];
  /** Currently active filters */
  activeFilters: ActiveFilter[];
  /** Callback when filters change */
  onFiltersChange: (filters: ActiveFilter[]) => void;
  /** Loading state */
  isLoading?: boolean;
}

// ─── Filter Field Section ───────────────────────────────────────────────

function FilterFieldSection({
  field,
  activeFilters,
  onToggleValue,
}: {
  field: DiscoveryFilterField;
  activeFilters: ActiveFilter[];
  onToggleValue: (fieldName: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const MAX_VISIBLE = 5;

  // Get active values for this field
  const activeValues = new Set(
    activeFilters
      .filter((f) => f.field === `canonical.${field.name}`)
      .flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]))
      .map(String),
  );

  const hasValues = field.values.length > 0;
  if (!hasValues) return null;

  const visibleValues = showAll ? field.values : field.values.slice(0, MAX_VISIBLE);

  return (
    <div className="py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold text-muted uppercase tracking-wider hover:text-foreground transition-default"
      >
        <span className="flex items-center gap-1.5">
          {field.label || field.name.replace(/_/g, ' ')}
          {activeValues.size > 0 && (
            <Badge variant="accent" className="text-[9px] px-1">
              {activeValues.size}
            </Badge>
          )}
        </span>
        <ChevronRight className={clsx('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5">
          {visibleValues.map((value) => (
            <div key={value} className="flex items-center justify-between px-2 py-0.5">
              <Checkbox
                checked={activeValues.has(value)}
                onChange={() => onToggleValue(field.name, value)}
                label={formatFilterValue(field.name, value)}
              />
            </div>
          ))}
          {field.values.length > MAX_VISIBLE && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="px-2 py-1 text-xs text-accent hover:underline"
            >
              {showAll ? 'Show less' : `+${field.values.length - MAX_VISIBLE} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Format a filter value for display (e.g., shorten MIME types) */
function formatFilterValue(fieldName: string, value: string): string {
  if (fieldName === 'mime_type') {
    // Shorten MIME types: "application/pdf" → "pdf"
    const parts = value.split('/');
    return parts[parts.length - 1];
  }
  return value;
}

// ─── Main Component ─────────────────────────────────────────────────────

export function MetadataFilterPanel({
  filterFields,
  activeFilters,
  onFiltersChange,
  isLoading = false,
}: MetadataFilterPanelProps) {
  // Only show fields that have enum values
  const fieldsWithValues = filterFields.filter((f) => f.values.length > 0);

  const handleToggleValue = useCallback(
    (fieldName: string, value: string) => {
      const canonicalField = `canonical.${fieldName}`;
      const existing = activeFilters.find((f) => f.field === canonicalField);

      if (existing) {
        const currentValues = Array.isArray(existing.value) ? existing.value : [existing.value];
        const valueSet = new Set(currentValues.map(String));

        if (valueSet.has(value)) {
          // Remove this value
          valueSet.delete(value);
          if (valueSet.size === 0) {
            // Remove the entire filter
            onFiltersChange(activeFilters.filter((f) => f.field !== canonicalField));
          } else if (valueSet.size === 1) {
            // Single value — use "eq" operator
            onFiltersChange(
              activeFilters.map((f) =>
                f.field === canonicalField
                  ? { field: canonicalField, operator: 'eq', value: [...valueSet][0] }
                  : f,
              ),
            );
          } else {
            // Multiple values — use "in" operator
            onFiltersChange(
              activeFilters.map((f) =>
                f.field === canonicalField
                  ? { field: canonicalField, operator: 'in', value: [...valueSet] }
                  : f,
              ),
            );
          }
        } else {
          // Add this value
          valueSet.add(value);
          if (valueSet.size === 1) {
            onFiltersChange(
              activeFilters.map((f) =>
                f.field === canonicalField
                  ? { field: canonicalField, operator: 'eq', value: [...valueSet][0] }
                  : f,
              ),
            );
          } else {
            onFiltersChange(
              activeFilters.map((f) =>
                f.field === canonicalField
                  ? { field: canonicalField, operator: 'in', value: [...valueSet] }
                  : f,
              ),
            );
          }
        }
      } else {
        // New filter with single value
        onFiltersChange([...activeFilters, { field: canonicalField, operator: 'eq', value }]);
      }
    },
    [activeFilters, onFiltersChange],
  );

  const handleClearAll = useCallback(() => {
    onFiltersChange([]);
  }, [onFiltersChange]);

  if (isLoading) {
    return (
      <div className="p-3">
        <h3 className="px-2 mb-2 text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
          <Filter className="w-3 h-3" />
          Metadata Filters
        </h3>
        <div className="flex items-center justify-center py-4">
          <Loader2 className="w-4 h-4 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  if (fieldsWithValues.length === 0) return null;

  return (
    <div className="p-3">
      <div className="flex items-center justify-between px-2 mb-2">
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
          <Filter className="w-3 h-3" />
          Metadata Filters
        </h3>
        {activeFilters.length > 0 && (
          <button
            onClick={handleClearAll}
            className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover transition-default"
          >
            <X className="w-3 h-3" />
            Clear all
          </button>
        )}
      </div>

      {fieldsWithValues.map((field) => (
        <FilterFieldSection
          key={field.name}
          field={field}
          activeFilters={activeFilters}
          onToggleValue={handleToggleValue}
        />
      ))}
    </div>
  );
}
