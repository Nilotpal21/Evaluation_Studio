'use client';

/**
 * GuardrailsEditor
 *
 * Section editor for agent guardrails. Each guardrail has a name,
 * an optional kind (input/output/both), a check expression, and an
 * action (block, warn, redact, escalate, fix, reask).
 */

import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, Shield } from 'lucide-react';
import clsx from 'clsx';
import { Select } from '../../ui/Select';
import type { SectionEditorProps, GuardrailData } from '../types';
import { SectionHeader } from './SectionHeader';

// =============================================================================
// CONSTANTS
// =============================================================================

const ACTION_OPTIONS = [
  { value: 'block', label: 'block' },
  { value: 'warn', label: 'warn' },
  { value: 'redact', label: 'redact' },
  { value: 'escalate', label: 'escalate' },
  { value: 'fix', label: 'fix' },
  { value: 'reask', label: 'reask' },
] as const;

const ACTION_BADGE_COLORS: Record<string, string> = {
  block: 'bg-error-subtle text-error',
  warn: 'bg-warning-subtle text-warning',
  redact: 'bg-background-muted text-foreground-muted',
  escalate: 'bg-purple-subtle text-purple',
  fix: 'bg-success-subtle text-success',
  reask: 'bg-info-subtle text-info',
};

const KIND_BADGE_COLORS: Record<string, string> = {
  input: 'bg-info-subtle text-info',
  output: 'bg-warning-subtle text-warning',
  both: 'bg-purple-subtle text-purple',
};

// =============================================================================
// STYLE CONSTANTS
// =============================================================================

const INPUT_CLASSES = clsx(
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default',
  'text-foreground placeholder:text-foreground-subtle',
  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus',
  'transition-default',
);

const CARD_CLASSES =
  'rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm';

const ADD_BUTTON_CLASSES = clsx(
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium',
  'text-accent hover:bg-accent-subtle border border-accent/30 transition-default',
);

const REMOVE_BUTTON_CLASSES = clsx(
  'p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default',
);

// =============================================================================
// FIELD GROUP
// =============================================================================

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-default/50">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// =============================================================================
// GUARDRAIL CARD
// =============================================================================

/** Extended guardrail data type to handle optional `kind` field not in the base type */
type GuardrailDataWithKind = GuardrailData & { kind?: string };

function GuardrailCard({
  guardrail,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  readOnly,
}: {
  guardrail: GuardrailDataWithKind;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: GuardrailData) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const actionColor = ACTION_BADGE_COLORS[guardrail.action.type] ?? ACTION_BADGE_COLORS.block;
  const kind = guardrail.kind ?? 'both';
  const kindColor = KIND_BADGE_COLORS[kind] ?? KIND_BADGE_COLORS.both;

  return (
    <div className={CARD_CLASSES}>
      {/* Collapsed header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-subtle/50 transition-default"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        )}

        <span className="flex-1 min-w-0">
          <span className="text-xs font-medium text-foreground truncate block">
            {guardrail.name || `Guardrail ${index + 1}`}
          </span>
        </span>

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', kindColor)}>
          {kind}
        </span>

        {guardrail.check && (
          <span className="text-xs font-mono text-foreground-muted truncate max-w-[160px]">
            {guardrail.check}
          </span>
        )}

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', actionColor)}>
          {guardrail.action.type}
        </span>
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="Name">
            <input
              type="text"
              value={guardrail.name}
              onChange={(e) => onChange({ ...guardrail, name: e.target.value })}
              placeholder="e.g. pii_filter"
              readOnly={readOnly}
              className={INPUT_CLASSES}
            />
          </FieldGroup>

          <FieldGroup label="Description">
            <textarea
              value={guardrail.description}
              onChange={(e) => onChange({ ...guardrail, description: e.target.value })}
              placeholder="What this guardrail protects against"
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'resize-y')}
            />
          </FieldGroup>

          <FieldGroup label="Check Expression">
            <textarea
              value={guardrail.check}
              onChange={(e) => onChange({ ...guardrail, check: e.target.value })}
              placeholder="e.g. output must not contain PII"
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono resize-y')}
            />
          </FieldGroup>

          <div className="grid grid-cols-2 gap-2">
            <FieldGroup label="Action">
              <Select
                options={ACTION_OPTIONS as unknown as { value: string; label: string }[]}
                value={guardrail.action.type}
                onChange={(v) =>
                  onChange({
                    ...guardrail,
                    action: { ...guardrail.action, type: v },
                  })
                }
                disabled={readOnly}
              />
            </FieldGroup>

            <FieldGroup label="Action Message">
              <input
                type="text"
                value={guardrail.action.message ?? ''}
                onChange={(e) =>
                  onChange({
                    ...guardrail,
                    action: { ...guardrail.action, message: e.target.value },
                  })
                }
                placeholder="Optional message"
                readOnly={readOnly}
                className={INPUT_CLASSES}
              />
            </FieldGroup>
          </div>

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove guardrail"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function GuardrailsEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'guardrails'>) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const handleToggle = useCallback(
    (index: number) => {
      setExpandedIndex(expandedIndex === index ? null : index);
    },
    [expandedIndex],
  );

  const handleChange = useCallback(
    (index: number, updated: GuardrailData) => {
      const next = [...data];
      next[index] = updated;
      onChange(next);
    },
    [data, onChange],
  );

  const handleRemove = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
      if (expandedIndex === index) {
        setExpandedIndex(null);
      }
    },
    [data, onChange, expandedIndex],
  );

  const handleAdd = useCallback(() => {
    onChange([...data, { name: '', description: '', check: '', action: { type: 'block' } }]);
    setExpandedIndex(data.length);
  }, [data, onChange]);

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      {/* Guardrail list */}
      {data.length > 0 ? (
        <>
          {/* Count header */}
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
              {data.length} guardrail{data.length !== 1 ? 's' : ''}
            </h3>
            {!readOnly && (
              <button type="button" onClick={handleAdd} className={ADD_BUTTON_CLASSES}>
                <Plus className="w-3 h-3" />
                Add
              </button>
            )}
          </div>
          <div className="space-y-2 stagger-children">
            {data.map((guardrail, index) => (
              <GuardrailCard
                key={index}
                guardrail={guardrail}
                index={index}
                isExpanded={expandedIndex === index}
                onToggle={() => handleToggle(index)}
                onChange={(updated) => handleChange(index, updated)}
                onRemove={() => handleRemove(index)}
                readOnly={readOnly}
              />
            ))}
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Shield className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm font-medium text-foreground-muted">No guardrails defined</p>
          <p className="text-xs text-foreground-subtle mt-1">
            Guardrails validate input and output to enforce safety policies
          </p>
          {!readOnly && (
            <button
              type="button"
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Guardrail
            </button>
          )}
        </div>
      )}
    </div>
  );
}
