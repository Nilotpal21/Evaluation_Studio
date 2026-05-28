'use client';

/**
 * ErrorHandlingEditor -- section editor for agent error handling configuration.
 *
 * Renders a list of error handler cards with error type, respond message,
 * and then/retry action. No accordion wrapper.
 */

import React, { useCallback } from 'react';
import { X, Plus, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { Select } from '../../ui/Select';
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
// THEN ACTION OPTIONS
// =============================================================================

const THEN_OPTIONS = [
  { value: 'continue', label: 'Continue' },
  { value: 'escalate', label: 'Escalate' },
  { value: 'handoff', label: 'Handoff' },
  { value: 'complete', label: 'Complete' },
  { value: 'backtrack', label: 'Backtrack' },
  { value: 'retry_step', label: 'Retry Step' },
] as const;

// =============================================================================
// COMPONENT
// =============================================================================

export function ErrorHandlingEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'errorHandling'>) {
  const addHandler = useCallback(() => {
    onChange([...data, { type: '', respond: '', then: 'continue' }]);
  }, [data, onChange]);

  const updateHandler = useCallback(
    (index: number, field: 'type' | 'respond' | 'then', value: string) => {
      const updated = data.map((h, i) => (i === index ? { ...h, [field]: value } : h));
      onChange(updated);
    },
    [data, onChange],
  );

  const removeHandler = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      <SubSectionHeader title="Error Handlers" />
      <div className="space-y-2 stagger-children">
        {data.map((handler, index) => (
          <div key={index} className={clsx(cardClasses, 'p-3')}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
                  <input
                    type="text"
                    value={handler.type}
                    onChange={(e) => updateHandler(index, 'type', e.target.value)}
                    readOnly={readOnly}
                    placeholder="Error type (e.g. tool_timeout, llm_error)"
                    className={clsx(inputClasses, 'font-mono')}
                  />
                </div>
                <textarea
                  value={handler.respond ?? ''}
                  onChange={(e) => updateHandler(index, 'respond', e.target.value)}
                  readOnly={readOnly}
                  rows={2}
                  placeholder="Response message (optional)"
                  className={textareaClasses}
                />
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-foreground-muted uppercase tracking-wider shrink-0">
                    Then
                  </label>
                  <div className="flex-1">
                    <Select
                      options={THEN_OPTIONS as unknown as { value: string; label: string }[]}
                      value={handler.then}
                      onChange={(v) => updateHandler(index, 'then', v)}
                      disabled={readOnly}
                    />
                  </div>
                </div>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  aria-label="Remove handler"
                  onClick={() => removeHandler(index)}
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
            <AlertTriangle className="w-5 h-5 text-foreground-muted/40 mb-2" />
            <p className="text-xs text-foreground-subtle">No error handlers defined</p>
            <p className="text-xs text-foreground-subtle mt-0.5">
              Handlers that respond to specific error types during execution
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={addHandler}
                className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Handler
              </button>
            )}
          </div>
        ) : (
          !readOnly && (
            <button type="button" onClick={addHandler} className={addBtnClasses}>
              <Plus className="w-3 h-3" />
              Add Handler
            </button>
          )
        )}
      </div>
    </div>
  );
}
