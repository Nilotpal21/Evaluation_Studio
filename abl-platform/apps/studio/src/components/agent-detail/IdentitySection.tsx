'use client';

/**
 * IdentitySection — always-visible section for agent identity configuration.
 *
 * Displays a collapsed summary (mode badge + model + goal preview) and
 * an expanded form for editing goal, persona, limitations, and execution mode.
 * Model selection and hyperparameters live in the dedicated model card so the
 * controls can be driven by runtime capability metadata.
 */

import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { X, Plus, Pencil, Check } from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import type { IdentitySectionData, SaveStatus } from '@/store/agent-detail-store';

// =============================================================================
// CONSTANTS
// =============================================================================

const MODE_OPTIONS = [
  { value: 'reasoning', label: 'Reasoning' },
  { value: 'scripted', label: 'Scripted' },
];

const MODE_BADGE_VARIANT: Record<string, 'accent' | 'info'> = {
  reasoning: 'accent',
  scripted: 'info',
};

// =============================================================================
// PROPS
// =============================================================================

export interface IdentitySectionProps {
  data: IdentitySectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: IdentitySectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface LimitationTagProps {
  text: string;
  isEditing?: boolean;
  editAriaLabel: string;
  removeAriaLabel: string;
  onEdit: () => void;
  onRemove: () => void;
}

function LimitationTag({
  text,
  isEditing = false,
  editAriaLabel,
  removeAriaLabel,
  onEdit,
  onRemove,
}: LimitationTagProps) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-full items-center gap-1 px-2 py-1 rounded-md text-xs',
        'bg-background-muted text-foreground border border-default',
        isEditing && 'border-accent/40 bg-accent-subtle text-accent',
      )}
    >
      <button
        type="button"
        aria-label={editAriaLabel}
        aria-pressed={isEditing}
        title={editAriaLabel}
        onClick={onEdit}
        className={clsx(
          'inline-flex min-w-0 items-center gap-1 rounded-sm text-left transition-fast',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus',
          isEditing ? 'text-accent' : 'hover:text-accent',
        )}
      >
        <Pencil aria-hidden="true" className="w-3 h-3 shrink-0" />
        <span className="truncate">{text}</span>
      </button>
      <button
        type="button"
        aria-label={removeAriaLabel}
        title={removeAriaLabel}
        onClick={onRemove}
        className="p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast"
      >
        <X aria-hidden="true" className="w-3 h-3" />
      </button>
    </span>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function IdentitySection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: IdentitySectionProps) {
  const t = useTranslations('agents.identity');
  const [newLimitation, setNewLimitation] = useState('');
  const [editingLimitationIndex, setEditingLimitationIndex] = useState<number | null>(null);
  const limitationInputRef = useRef<HTMLInputElement>(null);

  const trimmedLimitation = newLimitation.trim();
  const isEditingLimitation = editingLimitationIndex !== null;
  const hasDuplicateLimitation =
    trimmedLimitation.length > 0 &&
    data.limitations.some(
      (limitation, index) => limitation === trimmedLimitation && index !== editingLimitationIndex,
    );

  useEffect(() => {
    if (editingLimitationIndex === null) {
      return;
    }

    limitationInputRef.current?.focus();
    limitationInputRef.current?.select();
  }, [editingLimitationIndex]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleFieldChange = useCallback(
    <K extends keyof IdentitySectionData>(field: K, value: IdentitySectionData[K]) => {
      onChange({ ...data, [field]: value });
    },
    [data, onChange],
  );

  const handleGoalChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      handleFieldChange('goal', e.target.value);
    },
    [handleFieldChange],
  );

  const handlePersonaChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      handleFieldChange('persona', e.target.value);
    },
    [handleFieldChange],
  );

  const handleModeChange = useCallback(
    (value: string) => {
      handleFieldChange('mode', value as 'reasoning' | 'scripted');
    },
    [handleFieldChange],
  );

  const resetLimitationDraft = useCallback(() => {
    setNewLimitation('');
    setEditingLimitationIndex(null);
  }, []);

  const handleCommitLimitation = useCallback(() => {
    const trimmed = newLimitation.trim();
    if (!trimmed) {
      return;
    }

    if (editingLimitationIndex !== null) {
      const currentLimitation = data.limitations[editingLimitationIndex];
      if (currentLimitation === undefined) {
        resetLimitationDraft();
        return;
      }

      const hasConflict = data.limitations.some(
        (limitation, index) => limitation === trimmed && index !== editingLimitationIndex,
      );
      if (hasConflict) {
        return;
      }

      if (currentLimitation === trimmed) {
        resetLimitationDraft();
        return;
      }

      const updated = data.limitations.map((limitation, index) =>
        index === editingLimitationIndex ? trimmed : limitation,
      );
      onChange({ ...data, limitations: updated });
      resetLimitationDraft();
      return;
    }

    if (!data.limitations.includes(trimmed)) {
      onChange({ ...data, limitations: [...data.limitations, trimmed] });
      resetLimitationDraft();
    }
  }, [newLimitation, editingLimitationIndex, data, onChange, resetLimitationDraft]);

  const handleEditLimitation = useCallback(
    (index: number) => {
      setNewLimitation(data.limitations[index] ?? '');
      setEditingLimitationIndex(index);
    },
    [data.limitations],
  );

  const handleLimitationKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCommitLimitation();
        return;
      }

      if (e.key === 'Escape' && editingLimitationIndex !== null) {
        e.preventDefault();
        resetLimitationDraft();
      }
    },
    [editingLimitationIndex, handleCommitLimitation, resetLimitationDraft],
  );

  const handleRemoveLimitation = useCallback(
    (index: number) => {
      const updated = data.limitations.filter((_, i) => i !== index);
      onChange({ ...data, limitations: updated });

      if (editingLimitationIndex === null) {
        return;
      }

      if (editingLimitationIndex === index) {
        resetLimitationDraft();
        return;
      }

      if (editingLimitationIndex > index) {
        setEditingLimitationIndex(editingLimitationIndex - 1);
      }
    },
    [data, editingLimitationIndex, onChange, resetLimitationDraft],
  );

  // ---------------------------------------------------------------------------
  // Collapsed summary
  // ---------------------------------------------------------------------------

  const goalPreview = data.goal ? data.goal.split('\n')[0] : '';
  const modelLabel = data.model ?? '';

  const summaryContent = (
    <span className="flex items-center gap-2 min-w-0">
      <Badge variant={data.mode ? (MODE_BADGE_VARIANT[data.mode] ?? 'accent') : 'accent'}>
        {data.mode ?? 'reasoning'}
      </Badge>
      {modelLabel && <span className="text-xs text-muted truncate">{modelLabel}</span>}
      {goalPreview && (
        <span className="text-xs text-subtle truncate hidden sm:inline">{goalPreview}</span>
      )}
    </span>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="IDENTITY"
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
    >
      <div className="space-y-5">
        {/* Execution mode */}
        <div className="max-w-sm">
          <Select
            label={t('execution_mode_label')}
            options={MODE_OPTIONS}
            value={data.mode}
            onChange={handleModeChange}
          />
        </div>

        {/* Goal */}
        <Textarea
          label={t('goal_label')}
          value={data.goal}
          onChange={handleGoalChange}
          rows={3}
          placeholder={t('goal_placeholder')}
        />

        {/* Persona */}
        <Textarea
          label={t('persona_label')}
          value={data.persona}
          onChange={handlePersonaChange}
          rows={4}
          placeholder={t('persona_placeholder')}
        />

        {/* Limitations */}
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {t('limitations_label')}
          </label>
          <p className="text-xs text-muted">{t('limitations_help')}</p>

          {data.limitations.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {data.limitations.map((limitation, index) => (
                <LimitationTag
                  key={`${limitation}-${index}`}
                  text={limitation}
                  isEditing={editingLimitationIndex === index}
                  editAriaLabel={t('edit_limitation_aria', { text: limitation })}
                  removeAriaLabel={t('remove_limitation_aria', { text: limitation })}
                  onEdit={() => handleEditLimitation(index)}
                  onRemove={() => handleRemoveLimitation(index)}
                />
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              ref={limitationInputRef}
              type="text"
              value={newLimitation}
              onChange={(e) => setNewLimitation(e.target.value)}
              onKeyDown={handleLimitationKeyDown}
              placeholder={t('limitation_placeholder')}
              aria-label={t('limitations_label')}
              className={clsx(
                'flex-1 rounded-lg border bg-background-subtle px-3 py-1.5',
                'text-sm text-foreground placeholder:text-subtle',
                'focus:border-border-focus focus:ring-1 focus:ring-border-focus focus:outline-none',
                'transition-default border-default',
                isEditingLimitation && 'border-accent/40 ring-1 ring-accent/20',
              )}
            />
            <button
              type="button"
              aria-label={isEditingLimitation ? t('save_button') : t('add_button')}
              onClick={handleCommitLimitation}
              disabled={!trimmedLimitation || hasDuplicateLimitation}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium',
                'transition-fast btn-press',
                trimmedLimitation && !hasDuplicateLimitation
                  ? 'bg-accent text-accent-foreground hover:opacity-90'
                  : 'bg-background-muted text-muted cursor-not-allowed',
              )}
            >
              {isEditingLimitation ? (
                <Check aria-hidden="true" className="w-3.5 h-3.5" />
              ) : (
                <Plus aria-hidden="true" className="w-3.5 h-3.5" />
              )}
              {isEditingLimitation ? t('save_button') : t('add_button')}
            </button>
            {isEditingLimitation && (
              <button
                type="button"
                aria-label={t('cancel_button')}
                onClick={resetLimitationDraft}
                className={clsx(
                  'px-2.5 py-1.5 rounded-lg text-xs font-medium',
                  'text-muted hover:text-foreground hover:bg-background-muted transition-fast',
                )}
              >
                {t('cancel_button')}
              </button>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
