'use client';

/**
 * IdentityEditor — Goal, Persona, Limitations, Mode, System Prompt Source.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Plus, X, Pencil, Check, Library } from 'lucide-react';
import clsx from 'clsx';
import type { SectionEditorProps } from '../types';
import { SectionHeader } from './SectionHeader';
import { SubSection, Field, textareaClasses } from './FieldPrimitives';
import { useAgentEditorStore } from '../hooks/useAgentEditorStore';
import { apiFetch, handleResponse } from '../../../lib/api-client';
import { PromptPickerModal, type PickerSelection } from '../../prompt-library/PromptPickerModal';

interface LibraryRef {
  promptId: string;
  versionId: string;
  promptName?: string;
  versionNumber?: number;
  resolvedHash?: string;
  [key: string]: unknown;
}

interface AgentDetailResponse {
  agent?: {
    systemPromptLibraryRef?: LibraryRef | null;
  };
}

interface AgentPatchResponse {
  systemPromptLibraryRef?: LibraryRef | null;
}

export function extractPromptRefCompanionFields(ref: LibraryRef | null): Record<string, unknown> {
  if (!ref) {
    return {};
  }

  const {
    promptId: _promptId,
    versionId: _versionId,
    promptName: _promptName,
    versionNumber: _versionNumber,
    ...rest
  } = ref;

  return rest;
}

export function buildPromptRefPayload(
  selection: PickerSelection | null,
  current: LibraryRef | null,
): LibraryRef | null {
  if (!selection) {
    return null;
  }

  const preservedCompanionFields =
    current && current.promptId === selection.promptId && current.versionId === selection.versionId
      ? extractPromptRefCompanionFields(current)
      : {};

  return {
    promptId: selection.promptId,
    versionId: selection.versionId,
    ...preservedCompanionFields,
  };
}

export function mergePromptRefPresentation(
  persisted: LibraryRef | null | undefined,
  selection: PickerSelection | null,
  current: LibraryRef | null,
): LibraryRef | null {
  if (!persisted) {
    return null;
  }

  const selectionPresentation =
    selection &&
    persisted.promptId === selection.promptId &&
    persisted.versionId === selection.versionId
      ? {
          promptName: selection.promptName,
          versionNumber: selection.versionNumber,
        }
      : {};

  const currentPresentation =
    current && persisted.promptId === current.promptId && persisted.versionId === current.versionId
      ? {
          ...(typeof current.promptName === 'string' ? { promptName: current.promptName } : {}),
          ...(typeof current.versionNumber === 'number'
            ? { versionNumber: current.versionNumber }
            : {}),
        }
      : {};

  return {
    ...persisted,
    ...currentPresentation,
    ...selectionPresentation,
  };
}

export function IdentityEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'identity'>) {
  const [newLimitation, setNewLimitation] = useState('');
  const [editingLimitationIndex, setEditingLimitationIndex] = useState<number | null>(null);
  const limitationInputRef = useRef<HTMLInputElement>(null);

  const [libraryRef, setLibraryRef] = useState<LibraryRef | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [savingRef, setSavingRef] = useState(false);

  const projectId = useAgentEditorStore((s) => s.projectId);
  const agentName = useAgentEditorStore((s) => s.agentName);
  const t = useTranslations('agent_editor.identity');

  useEffect(() => {
    if (!projectId || !agentName) return;
    const load = async () => {
      try {
        const res = await apiFetch(
          `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
        );
        const body = await handleResponse<AgentDetailResponse>(res);
        setLibraryRef(body.agent?.systemPromptLibraryRef ?? null);
      } catch (err) {
        void err;
        toast.error(t('error_load_failed'));
      }
    };
    void load();
  }, [projectId, agentName, t]);

  const saveLibraryRef = useCallback(
    async (selection: PickerSelection | null) => {
      if (!projectId || !agentName) return;
      setSavingRef(true);
      try {
        const nextRef = buildPromptRefPayload(selection, libraryRef);
        const res = await apiFetch(
          `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemPromptLibraryRef: nextRef,
            }),
          },
        );
        const updatedAgent = await handleResponse<AgentPatchResponse>(res);
        setLibraryRef(
          mergePromptRefPresentation(
            updatedAgent.systemPromptLibraryRef ?? nextRef,
            selection,
            libraryRef,
          ),
        );
      } catch (err) {
        void err;
        toast.error(t('error_save_failed'));
      } finally {
        setSavingRef(false);
      }
    },
    [projectId, agentName, libraryRef, t],
  );

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

  const resetLimitationDraft = useCallback(() => {
    setNewLimitation('');
    setEditingLimitationIndex(null);
  }, []);

  const handleCommitLimitation = useCallback(() => {
    const trimmed = newLimitation.trim();
    if (!trimmed) return;

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

      onChange({
        ...data,
        limitations: data.limitations.map((limitation, index) =>
          index === editingLimitationIndex ? trimmed : limitation,
        ),
      });
      resetLimitationDraft();
      return;
    }

    if (!data.limitations.includes(trimmed)) {
      onChange({ ...data, limitations: [...data.limitations, trimmed] });
      resetLimitationDraft();
    }
  }, [data, editingLimitationIndex, newLimitation, onChange, resetLimitationDraft]);

  const handleEditLimitation = useCallback(
    (index: number) => {
      setNewLimitation(data.limitations[index] ?? '');
      setEditingLimitationIndex(index);
    },
    [data.limitations],
  );

  const handleRemoveLimitation = useCallback(
    (index: number) => {
      onChange({ ...data, limitations: data.limitations.filter((_, i) => i !== index) });

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

  return (
    <div className="p-5 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />

      <SubSection title={t('section_title')} first>
        <Field label={t('field_goal')}>
          <textarea
            value={data.goal}
            onChange={(e) => onChange({ ...data, goal: e.target.value })}
            placeholder={t('placeholder_goal')}
            rows={3}
            className={textareaClasses}
            readOnly={readOnly}
          />
        </Field>

        <Field label={t('field_persona')}>
          <textarea
            value={data.persona}
            onChange={(e) => onChange({ ...data, persona: e.target.value })}
            placeholder={t('placeholder_persona')}
            rows={4}
            className={textareaClasses}
            readOnly={readOnly}
          />
        </Field>

        <Field label={t('field_limitations')} last>
          <p className="text-xs text-foreground-muted mb-2 max-w-prose">{t('limitations_hint')}</p>
          {data.limitations.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {data.limitations.map((lim, i) => (
                <span
                  key={i}
                  className={clsx(
                    'inline-flex max-w-full items-center gap-1 text-xs px-2 py-1 rounded-md',
                    'bg-background-muted border border-default text-foreground',
                    editingLimitationIndex === i && 'border-accent/40 bg-accent-subtle text-accent',
                  )}
                >
                  {readOnly ? (
                    <span className="truncate">{lim}</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={t('edit_limitation', { lim })}
                      aria-pressed={editingLimitationIndex === i}
                      title={t('edit_limitation', { lim })}
                      onClick={() => handleEditLimitation(i)}
                      className={clsx(
                        'inline-flex min-w-0 items-center gap-1 rounded-sm text-left transition-default',
                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus',
                        editingLimitationIndex === i ? 'text-accent' : 'hover:text-accent',
                      )}
                    >
                      <Pencil aria-hidden="true" className="w-3 h-3 shrink-0" />
                      <span className="truncate">{lim}</span>
                    </button>
                  )}
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={t('remove_limitation', { lim })}
                      onClick={() => handleRemoveLimitation(i)}
                      className="text-foreground-muted hover:text-error transition-default"
                      title={t('remove_limitation', { lim })}
                    >
                      <X aria-hidden="true" className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-foreground-muted italic mb-2">{t('no_limitations')}</p>
          )}
          {!readOnly && (
            <div className="flex gap-2">
              <input
                ref={limitationInputRef}
                type="text"
                aria-label={t('field_limitations')}
                value={newLimitation}
                onChange={(e) => setNewLimitation(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCommitLimitation();
                    return;
                  }

                  if (e.key === 'Escape' && editingLimitationIndex !== null) {
                    e.preventDefault();
                    resetLimitationDraft();
                  }
                }}
                placeholder={t('placeholder_limitation')}
                className={clsx(
                  'flex-1 text-xs bg-background border border-default rounded-md px-2.5 py-1.5',
                  'placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus transition-default',
                  isEditingLimitation && 'border-accent/40 ring-2 ring-border-focus/20',
                )}
              />
              <button
                type="button"
                aria-label={t(isEditingLimitation ? 'action_save' : 'action_add')}
                onClick={handleCommitLimitation}
                disabled={!trimmedLimitation || hasDuplicateLimitation}
                className={clsx(
                  'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-default',
                  trimmedLimitation && !hasDuplicateLimitation
                    ? 'text-accent hover:bg-accent-subtle'
                    : 'text-foreground-muted cursor-not-allowed',
                )}
              >
                {isEditingLimitation ? (
                  <Check aria-hidden="true" className="w-3 h-3" />
                ) : (
                  <Plus aria-hidden="true" className="w-3 h-3" />
                )}
                {t(isEditingLimitation ? 'action_save' : 'action_add')}
              </button>
              {isEditingLimitation && (
                <button
                  type="button"
                  aria-label={t('action_cancel')}
                  onClick={resetLimitationDraft}
                  className="px-2.5 py-1.5 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  {t('action_cancel')}
                </button>
              )}
            </div>
          )}
        </Field>
      </SubSection>

      <SubSection title={t('system_prompt_source_title')} last>
        {libraryRef ? (
          <div className="flex items-center gap-3">
            <Library className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            <span className="flex-1 text-sm text-foreground truncate">
              {libraryRef.promptName ?? libraryRef.promptId}
              {libraryRef.versionNumber !== undefined && (
                <span className="ml-1.5 text-xs text-foreground-muted">
                  {t('version_badge', { n: libraryRef.versionNumber })}
                </span>
              )}
            </span>
            {!readOnly && (
              <>
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  disabled={savingRef}
                  className="text-xs text-accent hover:underline disabled:opacity-40"
                >
                  {t('action_change')}
                </button>
                <button
                  type="button"
                  onClick={() => void saveLibraryRef(null)}
                  disabled={savingRef}
                  className="text-xs text-foreground-muted hover:text-status-error disabled:opacity-40"
                >
                  {t('action_clear')}
                </button>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={readOnly || savingRef}
            onClick={() => setShowPicker(true)}
            className="flex items-center gap-1.5 text-sm text-accent hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Library className="h-3.5 w-3.5" aria-hidden="true" />
            {t('action_select_from_library')}
          </button>
        )}

        {showPicker && projectId && (
          <PromptPickerModal
            projectId={projectId}
            onConfirm={(selection) => {
              void saveLibraryRef(selection);
              setShowPicker(false);
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </SubSection>
    </div>
  );
}
