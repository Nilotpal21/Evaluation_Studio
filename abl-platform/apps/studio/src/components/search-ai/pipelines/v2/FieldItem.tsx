/**
 * FieldItem — Individual field row in the Embedding Fields drawer.
 *
 * Shows a checkbox toggle, field name, category badge, override indicator,
 * and expandable per-source toggles.
 */

'use client';

import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import type { BadgeVariant } from '../../../ui/Badge';

// =============================================================================
// TYPES
// =============================================================================

export interface FieldSource {
  name: string;
  confidence: number;
  enabled: boolean;
}

export interface EmbeddingField {
  name: string;
  category: 'core' | 'common' | 'custom';
  embeddable: boolean;
  sources: FieldSource[];
}

export interface FieldItemProps {
  field: EmbeddingField;
  isOverridden: boolean;
  onToggle: (embeddable: boolean) => void;
  onSourceToggle: (sourceName: string, enabled: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: string, values?: any) => string;
}

// =============================================================================
// HELPERS
// =============================================================================

const CATEGORY_BADGE_VARIANT: Record<string, BadgeVariant> = {
  core: 'info',
  common: 'accent',
  custom: 'purple',
};

// =============================================================================
// COMPONENT
// =============================================================================

export function FieldItem({ field, isOverridden, onToggle, onSourceToggle, t }: FieldItemProps) {
  const [expanded, setExpanded] = useState(false);

  const hasSources = field.sources.length > 0;

  const handleToggleExpand = useCallback(() => {
    if (hasSources) {
      setExpanded((prev) => !prev);
    }
  }, [hasSources]);

  const handleCheckboxChange = useCallback(() => {
    onToggle(!field.embeddable);
  }, [field.embeddable, onToggle]);

  return (
    <div className="border-b border-default last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={field.embeddable}
          onChange={handleCheckboxChange}
          className="h-3.5 w-3.5 shrink-0 rounded border-default accent-accent"
          aria-label={field.name}
        />

        {/* Expand toggle */}
        {hasSources ? (
          <button
            type="button"
            onClick={handleToggleExpand}
            className="shrink-0 p-0.5 rounded hover:bg-background-muted transition-default"
            aria-label={field.name}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-foreground-muted" />
            ) : (
              <ChevronRight className="h-3 w-3 text-foreground-muted" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        {/* Field name */}
        <span className="text-xs font-medium text-foreground truncate flex-1">{field.name}</span>

        {/* Category badge */}
        <Badge
          variant={CATEGORY_BADGE_VARIANT[field.category] ?? 'default'}
          className="text-[10px]"
        >
          {field.category}
        </Badge>

        {/* Override indicator */}
        <span
          className={`text-[10px] shrink-0 ${isOverridden ? 'text-accent font-medium' : 'text-foreground-muted'}`}
        >
          {isOverridden ? `\u270E ${t('v2_ef_pipeline')}` : `\u25CF ${t('v2_ef_global')}`}
        </span>
      </div>

      {/* Expanded source toggles */}
      {expanded && hasSources && (
        <div className="pl-10 pr-3 pb-2 space-y-1">
          {field.sources.map((source) => (
            <div
              key={source.name}
              className="flex items-center justify-between rounded-md bg-background-muted px-2 py-1.5"
            >
              <div className="flex flex-col">
                <span className="text-[11px] font-medium text-foreground">{source.name}</span>
                <span className="text-[10px] text-foreground-muted">
                  {t('v2_ef_confidence', { value: source.confidence })}
                </span>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  onChange={() => onSourceToggle(source.name, !source.enabled)}
                  className="peer sr-only"
                  aria-label={source.name}
                />
                <div className="peer h-4 w-7 rounded-full bg-background-elevated border border-default after:absolute after:left-[2px] after:top-[2px] after:h-3 after:w-3 after:rounded-full after:bg-foreground-muted after:transition-all peer-checked:bg-accent peer-checked:after:translate-x-3 peer-checked:after:bg-accent-foreground" />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
