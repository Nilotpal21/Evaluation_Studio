'use client';

/**
 * ConstraintsEditor
 *
 * Section editor for agent constraints. Each constraint is a runtime check
 * with a condition and an on_fail action (respond, escalate, goto_step,
 * block, handoff) with an optional message/target.
 */

import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { Select } from '../../ui/Select';
import type { SectionEditorProps, ConstraintData } from '../types';
import { SectionHeader } from './SectionHeader';

// =============================================================================
// CONSTANTS
// =============================================================================

const ON_FAIL_OPTIONS = [
  { value: 'respond', label: 'respond' },
  { value: 'escalate', label: 'escalate' },
  { value: 'goto_step', label: 'goto_step' },
  { value: 'block', label: 'block' },
  { value: 'handoff', label: 'handoff' },
] as const;

const ON_FAIL_BADGE_COLORS: Record<string, string> = {
  respond: 'bg-warning/15 text-warning',
  escalate: 'bg-purple/15 text-purple',
  goto_step: 'bg-info/15 text-info',
  block: 'bg-error/15 text-error',
  handoff: 'bg-accent/15 text-accent',
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
// CONSTRAINT CARD
// =============================================================================

function ConstraintCard({
  constraint,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  readOnly,
}: {
  constraint: ConstraintData;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: ConstraintData) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const badgeColor = ON_FAIL_BADGE_COLORS[constraint.onFail.type] ?? ON_FAIL_BADGE_COLORS.respond;

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
          <span className="text-xs font-mono text-foreground truncate block">
            {constraint.condition || `Constraint ${index + 1}`}
          </span>
        </span>

        <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', badgeColor)}>
          {constraint.onFail.type}
        </span>

        {constraint.onFail.message && (
          <span className="text-xs text-foreground-muted truncate max-w-[180px]">
            {constraint.onFail.message}
          </span>
        )}
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="Condition">
            <textarea
              value={constraint.condition}
              onChange={(e) => onChange({ ...constraint, condition: e.target.value })}
              placeholder="e.g. user must be authenticated"
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono resize-y')}
            />
          </FieldGroup>

          <FieldGroup label="On Fail Action">
            <Select
              options={ON_FAIL_OPTIONS as unknown as { value: string; label: string }[]}
              value={constraint.onFail.type}
              onChange={(v) =>
                onChange({
                  ...constraint,
                  onFail: { ...constraint.onFail, type: v },
                })
              }
              disabled={readOnly}
            />
          </FieldGroup>

          <FieldGroup label="On Fail Message">
            <input
              type="text"
              value={constraint.onFail.message ?? ''}
              onChange={(e) =>
                onChange({
                  ...constraint,
                  onFail: { ...constraint.onFail, message: e.target.value },
                })
              }
              placeholder="Message to respond with on failure"
              readOnly={readOnly}
              className={INPUT_CLASSES}
            />
          </FieldGroup>

          {(constraint.onFail.type === 'goto_step' || constraint.onFail.type === 'handoff') && (
            <FieldGroup label="Target">
              <input
                type="text"
                value={constraint.onFail.target ?? ''}
                onChange={(e) =>
                  onChange({
                    ...constraint,
                    onFail: { ...constraint.onFail, target: e.target.value },
                  })
                }
                placeholder={
                  constraint.onFail.type === 'goto_step' ? 'Step name' : 'Target agent name'
                }
                readOnly={readOnly}
                className={INPUT_CLASSES}
              />
            </FieldGroup>
          )}

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove constraint"
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

export function ConstraintsEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'constraints'>) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const handleToggle = useCallback(
    (index: number) => {
      setExpandedIndex(expandedIndex === index ? null : index);
    },
    [expandedIndex],
  );

  const handleChange = useCallback(
    (index: number, updated: ConstraintData) => {
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
    onChange([...data, { condition: '', onFail: { type: 'respond' } }]);
    setExpandedIndex(data.length);
  }, [data, onChange]);

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      <p className="text-xs text-foreground-muted">
        Runtime checks over session state and checkpoints. Use them for rules that should respond,
        block, hand off, or escalate on failure.
      </p>
      {/* Constraint list */}
      {data.length > 0 ? (
        <>
          {/* Count header */}
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
              {data.length} constraint{data.length !== 1 ? 's' : ''}
            </h3>
            {!readOnly && (
              <button type="button" onClick={handleAdd} className={ADD_BUTTON_CLASSES}>
                <Plus className="w-3 h-3" />
                Add
              </button>
            )}
          </div>
          <div className="space-y-2 stagger-children">
            {data.map((constraint, index) => (
              <ConstraintCard
                key={index}
                constraint={constraint}
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
          <ShieldCheck className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm font-medium text-foreground-muted">No constraints defined</p>
          <p className="text-xs text-foreground-subtle mt-1">
            Add a runtime rule that responds, blocks, hands off, or escalates when it fails
          </p>
          {!readOnly && (
            <button
              type="button"
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Constraint
            </button>
          )}
        </div>
      )}
    </div>
  );
}
