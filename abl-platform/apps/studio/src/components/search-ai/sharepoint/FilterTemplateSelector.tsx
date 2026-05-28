'use client';

/**
 * FilterTemplateSelector
 *
 * Row of toggle-style buttons for filter template presets.
 */

import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';

interface FilterTemplateSelectorProps {
  selected: string;
  onSelect: (templateId: string) => void;
  templates?: Array<{ id: string; label: string }>;
}

const DEFAULT_TEMPLATES = [
  { id: 'documents-only', labelKey: 'template_documents_only' },
  { id: 'tech-docs', labelKey: 'template_tech_docs' },
  { id: 'everything', labelKey: 'template_everything' },
  { id: 'custom', labelKey: 'template_custom' },
];

export function FilterTemplateSelector({
  selected,
  onSelect,
  templates,
}: FilterTemplateSelectorProps) {
  const t = useTranslations('search_ai.sharepoint.scopeFilters');

  const items = templates ?? DEFAULT_TEMPLATES.map((dt) => ({ id: dt.id, label: t(dt.labelKey) }));

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          onClick={() => onSelect(tpl.id)}
          className={clsx(
            'px-3 py-1.5 rounded-lg text-xs border transition-default',
            selected === tpl.id
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-default bg-background-subtle text-muted hover:text-foreground',
          )}
        >
          {tpl.label}
        </button>
      ))}
    </div>
  );
}
