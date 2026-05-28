/**
 * CurrentlyEmbeddingSection — Pinned summary of all selected embedding fields.
 *
 * Shows all embeddable=true fields with name, category badge,
 * and a remove button. Displays count header "N fields + full text".
 */

'use client';

import { X } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import type { BadgeVariant } from '../../../ui/Badge';

// =============================================================================
// TYPES
// =============================================================================

export interface CurrentlyEmbeddingSectionProps {
  fields: Array<{ name: string; category: string }>;
  onRemove: (fieldName: string) => void;
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

export function CurrentlyEmbeddingSection({ fields, onRemove, t }: CurrentlyEmbeddingSectionProps) {
  return (
    <div className="border-b border-default px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-foreground">
          {t('v2_ef_currently_embedding')}
        </span>
        <span className="text-[10px] text-foreground-muted">
          {t('v2_ef_field_count', { count: fields.length })}
        </span>
      </div>

      {fields.length === 0 ? (
        <div className="text-xs text-foreground-muted italic py-1">
          {t('v2_ef_field_count', { count: 0 })}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {fields.map((field) => (
            <span
              key={field.name}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-background-muted px-2 py-1 text-[11px]"
            >
              <Badge
                variant={CATEGORY_BADGE_VARIANT[field.category] ?? 'default'}
                className="text-[9px] px-1 py-0"
              >
                {field.category}
              </Badge>
              <span className="font-medium text-foreground">{field.name}</span>
              <button
                type="button"
                onClick={() => onRemove(field.name)}
                className="ml-0.5 rounded p-0.5 hover:bg-background-elevated transition-default"
                aria-label={`${t('v2_ef_cancel')} ${field.name}`}
              >
                <X className="h-2.5 w-2.5 text-foreground-muted" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
