'use client';

/**
 * CompletionEditor -- section editor for agent completion conditions.
 *
 * Renders a list of completion condition cards with when expression
 * and optional respond text. No accordion wrapper.
 */

import React, { useCallback } from 'react';
import { X, Plus, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import type { SectionEditorProps } from '../types';
import { SectionHeader } from './SectionHeader';

// =============================================================================
// SHARED STYLES
// =============================================================================

const inputClasses =
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default';

const textareaClasses = clsx(inputClasses, 'resize-y');

const addBtnClasses =
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-accent-subtle border border-accent/30 transition-default';

const removeBtnClasses =
  'p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default';

const cardClasses =
  'rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm';

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function SubSectionHeader({ title }: { title: string }) {
  return (
    <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
      {title}
    </h4>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CompletionEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'completion'>) {
  const addCondition = useCallback(() => {
    onChange([...data, { when: '', respond: '' }]);
  }, [data, onChange]);

  const updateCondition = useCallback(
    (index: number, field: 'when' | 'respond', value: string) => {
      const updated = data.map((c, i) => (i === index ? { ...c, [field]: value } : c));
      onChange(updated);
    },
    [data, onChange],
  );

  const removeCondition = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      <SubSectionHeader title="Completion Conditions" />
      <div className="space-y-2 stagger-children">
        {data.map((condition, index) => (
          <div key={index} className={clsx(cardClasses, 'p-3')}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                  <input
                    type="text"
                    value={condition.when}
                    onChange={(e) => updateCondition(index, 'when', e.target.value)}
                    readOnly={readOnly}
                    placeholder="When expression (e.g. all_fields_gathered)"
                    className={inputClasses}
                  />
                </div>
                <textarea
                  value={condition.respond ?? ''}
                  onChange={(e) => updateCondition(index, 'respond', e.target.value)}
                  readOnly={readOnly}
                  rows={2}
                  placeholder="Response message (optional)"
                  className={textareaClasses}
                />
              </div>
              {!readOnly && (
                <button
                  type="button"
                  aria-label="Remove condition"
                  onClick={() => removeCondition(index)}
                  className={removeBtnClasses}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}

        {data.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle2 className="w-5 h-5 text-foreground-muted/40 mb-2" />
            <p className="text-xs text-foreground-subtle">No completion conditions defined</p>
            <p className="text-xs text-foreground-subtle mt-0.5">
              Conditions that determine when the agent has finished its task
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={addCondition}
                className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Condition
              </button>
            )}
          </div>
        ) : (
          !readOnly && (
            <button type="button" onClick={addCondition} className={addBtnClasses}>
              <Plus className="w-3 h-3" />
              Add Condition
            </button>
          )
        )}
      </div>
    </div>
  );
}
