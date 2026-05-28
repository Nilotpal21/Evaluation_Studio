'use client';

/**
 * RulesSection -- collapsible section for constraints and guardrails.
 *
 * Collapsed: shows total rule count badge and summary text with constraint/guardrail counts.
 * Expanded: two sub-sections -- Constraints (condition + on_fail action) and
 * Guardrails (name, description, check, action) -- each fully editable with "Add" buttons.
 */

import React, { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldAlert, Plus, AlertTriangle, X } from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import type {
  RulesSectionData,
  ConstraintData,
  GuardrailData,
  SaveStatus,
} from '@/store/agent-detail-store';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Badge variant mapping for constraint on_fail action types */
const ONFAIL_BADGE_VARIANTS: Record<string, 'warning' | 'error' | 'info' | 'purple'> = {
  respond: 'warning',
  block: 'error',
  handoff: 'info',
  escalate: 'purple',
};

/** Badge variant mapping for guardrail action types */
const ACTION_BADGE_VARIANTS: Record<string, 'warning' | 'error' | 'info' | 'purple'> = {
  respond: 'warning',
  block: 'error',
  handoff: 'info',
  escalate: 'purple',
};

/** Available action type options for selects */
const ACTION_TYPE_OPTIONS = ['respond', 'block', 'handoff', 'escalate'] as const;

// =============================================================================
// STYLE CONSTANTS
// =============================================================================

import { INLINE_INPUT_CLASSES, INLINE_SELECT_CLASSES } from './inline-input-classes';

// =============================================================================
// PROPS
// =============================================================================

export interface RulesSectionProps {
  data: RulesSectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: RulesSectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Single constraint card (fully editable) */
function ConstraintCard({
  constraint,
  onChange,
  onRemove,
}: {
  constraint: ConstraintData;
  onChange: (constraint: ConstraintData) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('agents.rules');
  const handleConditionChange = useCallback(
    (value: string) => {
      onChange({ ...constraint, condition: value });
    },
    [constraint, onChange],
  );

  const handleOnFailTypeChange = useCallback(
    (value: string) => {
      onChange({ ...constraint, onFail: { ...constraint.onFail, type: value } });
    },
    [constraint, onChange],
  );

  const handleOnFailMessageChange = useCallback(
    (value: string) => {
      onChange({ ...constraint, onFail: { ...constraint.onFail, message: value } });
    },
    [constraint, onChange],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border border-default bg-background-subtle p-3 space-y-2',
        'transition-fast hover:border-accent/30',
      )}
    >
      {/* Header: icon + remove button */}
      <div className="flex items-center justify-between">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <button
          type="button"
          onClick={onRemove}
          className="text-muted hover:text-error transition-fast"
          aria-label="Remove constraint"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Condition textarea */}
      <textarea
        value={constraint.condition}
        onChange={(e) => handleConditionChange(e.target.value)}
        placeholder={t('constraint_placeholder')}
        rows={2}
        className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
      />

      {/* On-fail row: type select + message input */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted shrink-0">{t('on_fail_label')}</span>
        <select
          value={constraint.onFail.type}
          onChange={(e) => handleOnFailTypeChange(e.target.value)}
          className={clsx(INLINE_SELECT_CLASSES, 'w-28')}
        >
          {ACTION_TYPE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={constraint.onFail.message ?? ''}
          onChange={(e) => handleOnFailMessageChange(e.target.value)}
          placeholder={t('on_fail_message_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1')}
        />
      </div>
    </div>
  );
}

/** Single guardrail card (fully editable) */
function GuardrailCard({
  guardrail,
  onChange,
  onRemove,
}: {
  guardrail: GuardrailData;
  onChange: (guardrail: GuardrailData) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('agents.rules');
  const handleFieldChange = useCallback(
    (field: keyof GuardrailData, value: string) => {
      onChange({ ...guardrail, [field]: value });
    },
    [guardrail, onChange],
  );

  const handleActionTypeChange = useCallback(
    (value: string) => {
      onChange({ ...guardrail, action: { ...guardrail.action, type: value } });
    },
    [guardrail, onChange],
  );

  const handleActionMessageChange = useCallback(
    (value: string) => {
      onChange({ ...guardrail, action: { ...guardrail.action, message: value } });
    },
    [guardrail, onChange],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border border-default bg-background-subtle p-3 space-y-2',
        'transition-fast hover:border-accent/30',
      )}
    >
      {/* Header: icon + name input + remove button */}
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-purple shrink-0" />
        <input
          type="text"
          value={guardrail.name}
          onChange={(e) => handleFieldChange('name', e.target.value)}
          placeholder={t('guardrail_name_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        <button
          type="button"
          onClick={onRemove}
          className="text-muted hover:text-error transition-fast shrink-0"
          aria-label="Remove guardrail"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Description textarea */}
      <div className="space-y-1">
        <label className="text-xs text-muted">{t('description_label')}</label>
        <textarea
          value={guardrail.description}
          onChange={(e) => handleFieldChange('description', e.target.value)}
          placeholder={t('description_placeholder')}
          rows={2}
          className={INLINE_INPUT_CLASSES}
        />
      </div>

      {/* Check textarea */}
      <div className="space-y-1">
        <label className="text-xs text-muted">{t('check_label')}</label>
        <textarea
          value={guardrail.check}
          onChange={(e) => handleFieldChange('check', e.target.value)}
          placeholder={t('check_placeholder')}
          rows={2}
          className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
        />
      </div>

      {/* Action row: type select + message input */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted shrink-0">{t('action_label')}</span>
        <select
          value={guardrail.action.type}
          onChange={(e) => handleActionTypeChange(e.target.value)}
          className={clsx(INLINE_SELECT_CLASSES, 'w-28')}
        >
          {ACTION_TYPE_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={guardrail.action.message ?? ''}
          onChange={(e) => handleActionMessageChange(e.target.value)}
          placeholder={t('action_message_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1')}
        />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function RulesSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: RulesSectionProps) {
  const t = useTranslations('agents.rules');
  const constraintCount = data.constraints.length;
  const guardrailCount = data.guardrails.length;
  const totalCount = constraintCount + guardrailCount;

  // ---------------------------------------------------------------------------
  // Constraint handlers
  // ---------------------------------------------------------------------------

  const handleConstraintChange = useCallback(
    (index: number, constraint: ConstraintData) => {
      const updated = [...data.constraints];
      updated[index] = constraint;
      onChange({ ...data, constraints: updated });
    },
    [data, onChange],
  );

  const handleRemoveConstraint = useCallback(
    (index: number) => {
      onChange({ ...data, constraints: data.constraints.filter((_, i) => i !== index) });
    },
    [data, onChange],
  );

  const handleAddConstraint = useCallback(() => {
    onChange({
      ...data,
      constraints: [...data.constraints, { condition: '', onFail: { type: 'respond' } }],
    });
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Guardrail handlers
  // ---------------------------------------------------------------------------

  const handleGuardrailChange = useCallback(
    (index: number, guardrail: GuardrailData) => {
      const updated = [...data.guardrails];
      updated[index] = guardrail;
      onChange({ ...data, guardrails: updated });
    },
    [data, onChange],
  );

  const handleRemoveGuardrail = useCallback(
    (index: number) => {
      onChange({ ...data, guardrails: data.guardrails.filter((_, i) => i !== index) });
    },
    [data, onChange],
  );

  const handleAddGuardrail = useCallback(() => {
    onChange({
      ...data,
      guardrails: [
        ...data.guardrails,
        { name: '', description: '', check: '', action: { type: 'block' } },
      ],
    });
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Collapsed summary: constraint count + guardrail count text
  // ---------------------------------------------------------------------------

  const summaryContent =
    totalCount > 0 ? (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Shield className="w-3 h-3" />
        {t('summary', { constraintCount, guardrailCount })}
      </span>
    ) : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="RULES"
      count={totalCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
      isEmpty={totalCount === 0}
    >
      <div className="space-y-6">
        {/* Constraints sub-section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h4 className="text-sm font-semibold text-foreground">{t('constraints_title')}</h4>
            {constraintCount > 0 && <span className="text-xs text-muted">({constraintCount})</span>}
          </div>
          <p className="text-xs text-muted pl-6">{t('constraints_help')}</p>

          {constraintCount > 0 ? (
            <div className="space-y-2">
              {data.constraints.map((constraint, index) => (
                <ConstraintCard
                  key={`constraint-${index}`}
                  constraint={constraint}
                  onChange={(updated) => handleConstraintChange(index, updated)}
                  onRemove={() => handleRemoveConstraint(index)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted italic pl-6">{t('no_constraints')}</p>
          )}

          {/* Add Constraint button */}
          <button
            type="button"
            aria-label="Add Constraint"
            onClick={handleAddConstraint}
            className={clsx(
              'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
              'border border-dashed border-default text-muted',
              'hover:border-accent hover:text-accent transition-fast',
              'text-sm font-medium btn-press',
            )}
          >
            <Plus className="w-4 h-4" />
            {t('add_constraint')}
          </button>
        </div>

        {/* Guardrails sub-section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-purple" />
            <h4 className="text-sm font-semibold text-foreground">{t('guardrails_title')}</h4>
            {guardrailCount > 0 && <span className="text-xs text-muted">({guardrailCount})</span>}
          </div>

          {guardrailCount > 0 ? (
            <div className="space-y-2">
              {data.guardrails.map((guardrail, index) => (
                <GuardrailCard
                  key={`guardrail-${index}`}
                  guardrail={guardrail}
                  onChange={(updated) => handleGuardrailChange(index, updated)}
                  onRemove={() => handleRemoveGuardrail(index)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted italic pl-6">{t('no_guardrails')}</p>
          )}

          {/* Add Guardrail button */}
          <button
            type="button"
            aria-label="Add Guardrail"
            onClick={handleAddGuardrail}
            className={clsx(
              'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
              'border border-dashed border-default text-muted',
              'hover:border-accent hover:text-accent transition-fast',
              'text-sm font-medium btn-press',
            )}
          >
            <Plus className="w-4 h-4" />
            {t('add_guardrail')}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}
