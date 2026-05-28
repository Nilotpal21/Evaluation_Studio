'use client';

/**
 * GatherSection — collapsible section for gather field definitions.
 *
 * Collapsed: shows field count badge and name pills (filled=required, outlined=optional).
 * Expanded: shows an editable card per field with name, type, required, prompt, default value,
 * plus an "Add Field" button at the bottom.
 */

import React, { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { List, Plus, Check, Minus, X } from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import type { GatherFieldData, SaveStatus } from '@/store/agent-detail-store';

// =============================================================================
// CONSTANTS
// =============================================================================

const TYPE_BADGE_VARIANTS: Record<string, 'accent' | 'info' | 'warning' | 'success'> = {
  string: 'accent',
  number: 'info',
  boolean: 'warning',
  date: 'success',
  enum: 'info',
};

const FIELD_TYPE_OPTIONS = ['string', 'number', 'boolean', 'date', 'enum'] as const;

// Shared inline input classes — see ./inline-input-classes.ts
import { INLINE_INPUT_CLASSES } from './inline-input-classes';

// =============================================================================
// PROPS
// =============================================================================

export interface GatherSectionProps {
  data: GatherFieldData[];
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: GatherFieldData[]) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Collapsed pill showing field name — filled for required, outlined for optional */
function FieldPill({ field }: { field: GatherFieldData }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs',
        field.required ? 'bg-accent-subtle text-accent' : 'border border-default text-muted',
      )}
    >
      {field.name}
    </span>
  );
}

// =============================================================================
// EDITABLE FIELD CARD
// =============================================================================

interface FieldCardProps {
  field: GatherFieldData;
  index: number;
  onChangeField: (index: number, field: GatherFieldData) => void;
  onRemoveField: (index: number) => void;
}

function FieldCard({ field, index, onChangeField, onRemoveField }: FieldCardProps) {
  const t = useTranslations('agents.gather');
  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChangeField(index, { ...field, name: e.target.value });
    },
    [index, field, onChangeField],
  );

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChangeField(index, { ...field, type: e.target.value });
    },
    [index, field, onChangeField],
  );

  const handleRequiredChange = useCallback(
    (checked: boolean) => {
      onChangeField(index, { ...field, required: checked });
    },
    [index, field, onChangeField],
  );

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChangeField(index, { ...field, prompt: e.target.value });
    },
    [index, field, onChangeField],
  );

  const handleDefaultValueChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      onChangeField(index, {
        ...field,
        defaultValue: value === '' ? undefined : value,
      });
    },
    [index, field, onChangeField],
  );

  return (
    <div className="rounded-lg border border-default bg-background-subtle p-4 space-y-3">
      {/* Row 1: name + type + required + remove */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={field.name}
          onChange={handleNameChange}
          placeholder={t('field_name_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        <select
          value={field.type}
          onChange={handleTypeChange}
          className={clsx(INLINE_INPUT_CLASSES, '!w-28 shrink-0')}
        >
          {FIELD_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Checkbox
          checked={field.required}
          onChange={handleRequiredChange}
          label={t('required_label')}
          className="shrink-0"
        />
        <button
          type="button"
          aria-label={`Remove field ${field.name}`}
          onClick={() => onRemoveField(index)}
          className="p-1 rounded hover:bg-error/10 hover:text-error transition-fast shrink-0"
        >
          <X className="w-4 h-4 text-muted hover:text-error" />
        </button>
      </div>

      {/* Row 2: prompt */}
      <textarea
        value={field.prompt}
        onChange={handlePromptChange}
        placeholder={t('prompt_placeholder')}
        rows={2}
        className={clsx(INLINE_INPUT_CLASSES, 'resize-y')}
      />

      {/* Row 3: default value (optional) */}
      <input
        type="text"
        value={field.defaultValue !== undefined ? String(field.defaultValue) : ''}
        onChange={handleDefaultValueChange}
        placeholder={t('default_value_placeholder')}
        className={INLINE_INPUT_CLASSES}
      />
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function GatherSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: GatherSectionProps) {
  const t = useTranslations('agents.gather');
  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleFieldChange = useCallback(
    (index: number, field: GatherFieldData) => {
      const updated = [...data];
      updated[index] = field;
      onChange(updated);
    },
    [data, onChange],
  );

  const handleRemoveField = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  const handleAddField = useCallback(() => {
    onChange([...data, { name: '', prompt: '', type: 'string', required: false }]);
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Collapsed summary: field name pills with required/optional styling
  // ---------------------------------------------------------------------------

  const summaryContent =
    data.length > 0 ? (
      <span className="flex items-center gap-1.5 flex-wrap">
        {data.map((field, idx) => (
          <FieldPill key={`${field.name}-${idx}`} field={field} />
        ))}
      </span>
    ) : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="GATHER"
      count={data.length}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
      isEmpty={data.length === 0}
    >
      <div className="space-y-3">
        {/* Field cards */}
        {data.map((field, index) => (
          <FieldCard
            key={index}
            field={field}
            index={index}
            onChangeField={handleFieldChange}
            onRemoveField={handleRemoveField}
          />
        ))}

        {data.length === 0 && <p className="text-xs text-muted italic py-2">{t('empty_fields')}</p>}

        {/* Add Field button */}
        <button
          type="button"
          aria-label="Add Field"
          onClick={handleAddField}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
            'border border-dashed border-default text-muted',
            'hover:border-accent hover:text-accent transition-fast',
            'text-sm font-medium btn-press',
          )}
        >
          <Plus className="w-4 h-4" />
          {t('add_field')}
        </button>
      </div>
    </SectionCard>
  );
}
