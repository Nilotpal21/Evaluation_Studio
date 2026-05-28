/**
 * AttachmentSettingsTab Component
 *
 * Project settings tab for managing per-project attachment configuration.
 * Shows 5 editable fields (enabled, maxFileSizeBytes, allowedMimeTypes,
 * piiPolicy, defaultProcessingMode) and 1 read-only field (maxFilesPerSession).
 * Supports override/inherited indicators and reset-to-default.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip, Loader2, Check, X, Plus, RotateCcw } from 'lucide-react';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { toast } from 'sonner';

// ─── Constants ──────────────────────────────────────────────────────────────

const BYTES_PER_MB = 1024 * 1024;
const MIME_PATTERN = /^[a-z]+\/([\w.+-]+|\*)$/;
const MAX_MIME_ENTRIES = 50;

// ─── Types ──────────────────────────────────────────────────────────────────

interface AttachmentFormState {
  enabled: boolean;
  maxFileSizeBytes: number;
  maxFilesPerSession: number;
  allowedMimeTypes: string[];
  piiPolicy: 'redact' | 'block' | 'allow';
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip';
}

interface ProjectOverrides {
  enabled: boolean | null;
  maxFileSizeBytes: number | null;
  allowedMimeTypes: string[] | null;
  piiPolicy: 'redact' | 'block' | 'allow' | null;
  defaultProcessingMode: 'full' | 'metadata_only' | 'skip' | null;
}

type OverrideField = keyof ProjectOverrides;

type PendingNulls = Set<OverrideField>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function mapResponseToFormState(resolved: AttachmentFormState): AttachmentFormState {
  return {
    enabled: resolved.enabled,
    maxFileSizeBytes: resolved.maxFileSizeBytes,
    maxFilesPerSession: resolved.maxFilesPerSession,
    allowedMimeTypes: resolved.allowedMimeTypes,
    piiPolicy: resolved.piiPolicy,
    defaultProcessingMode: resolved.defaultProcessingMode,
  };
}

function computeDiff(
  initial: AttachmentFormState,
  current: AttachmentFormState,
  pendingNulls: PendingNulls,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};

  for (const field of pendingNulls) {
    diff[field] = null;
  }

  const editableFields: OverrideField[] = [
    'enabled',
    'maxFileSizeBytes',
    'allowedMimeTypes',
    'piiPolicy',
    'defaultProcessingMode',
  ];

  for (const field of editableFields) {
    if (pendingNulls.has(field)) continue;
    const initialVal = initial[field as keyof AttachmentFormState];
    const currentVal = current[field as keyof AttachmentFormState];
    if (JSON.stringify(initialVal) !== JSON.stringify(currentVal)) {
      diff[field] = currentVal;
    }
  }

  return diff;
}

function isFieldOverridden(overrides: ProjectOverrides | null, field: OverrideField): boolean {
  if (!overrides) return false;
  return overrides[field] !== null && overrides[field] !== undefined;
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 items-start">
      <div>
        <label className="text-sm font-medium text-foreground">{label}</label>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AttachmentSettingsTab() {
  const t = useTranslations('settings.attachments');
  const projectId = useNavigationStore((s) => s.projectId);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [formState, setFormState] = useState<AttachmentFormState>({
    enabled: true,
    maxFileSizeBytes: 20 * BYTES_PER_MB,
    maxFilesPerSession: 100,
    allowedMimeTypes: [],
    piiPolicy: 'redact',
    defaultProcessingMode: 'full',
  });
  const [initialState, setInitialState] = useState<AttachmentFormState>(formState);
  const [overrides, setOverrides] = useState<ProjectOverrides | null>(null);
  const [pendingNulls, setPendingNulls] = useState<PendingNulls>(new Set());
  const [mimeInputValue, setMimeInputValue] = useState('');
  const [mimeInputError, setMimeInputError] = useState<string | null>(null);
  const mimeInputRef = useRef<HTMLInputElement>(null);

  // ─── Load ───────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/attachment-config`);
      if (res.ok) {
        const { data } = await res.json();
        const state = mapResponseToFormState(data.resolved);
        setFormState(state);
        setInitialState(state);
        setOverrides(data.projectOverrides);
        setIsDirty(false);
        setPendingNulls(new Set());
      } else {
        toast.error(t('load_failed'));
      }
    } catch {
      toast.error(t('load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]); // t is stable in next-intl, matches existing tabs

  useEffect(() => {
    load();
  }, [load]);

  // ─── Save ───────────────────────────────────────────────────────────────

  const save = async () => {
    if (!projectId || !isDirty || isSaving) return;
    setIsSaving(true);
    try {
      const body = computeDiff(initialState, formState, pendingNulls);
      const res = await apiFetch(`/api/projects/${projectId}/attachment-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const { data } = await res.json();
        const state = mapResponseToFormState(data.resolved);
        setFormState(state);
        setInitialState(state);
        setOverrides(data.projectOverrides);
        setIsDirty(false);
        setPendingNulls(new Set());
        toast.success(t('saved'));
      } else {
        toast.error(t('save_failed'));
      }
    } catch {
      toast.error(t('save_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Field Updates ──────────────────────────────────────────────────────

  const updateField = <K extends keyof AttachmentFormState>(
    key: K,
    value: AttachmentFormState[K],
  ) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
    // Remove from pendingNulls since user is actively editing
    setPendingNulls((prev) => {
      const next = new Set(prev);
      next.delete(key as OverrideField);
      return next;
    });
    setIsDirty(true);
  };

  const resetField = (field: OverrideField) => {
    setPendingNulls((prev) => new Set(prev).add(field));
    // Set the display value to what the resolved default would be (initialState where override was null)
    setFormState((prev) => ({
      ...prev,
      [field]: initialState[field as keyof AttachmentFormState],
    }));
    setIsDirty(true);
  };

  // ─── MIME Management ────────────────────────────────────────────────────

  const addMimeType = () => {
    const mime = mimeInputValue.trim().toLowerCase();
    if (!mime) {
      mimeInputRef.current?.focus();
      return;
    }

    if (!MIME_PATTERN.test(mime)) {
      setMimeInputError(t('validation_mime_format'));
      return;
    }
    if (formState.allowedMimeTypes.includes(mime)) {
      setMimeInputError(t('validation_mime_duplicate'));
      return;
    }
    if (formState.allowedMimeTypes.length >= MAX_MIME_ENTRIES) {
      setMimeInputError(t('validation_mime_cap'));
      return;
    }

    updateField('allowedMimeTypes', [...formState.allowedMimeTypes, mime]);
    setMimeInputValue('');
    setMimeInputError(null);
  };

  const removeMimeType = (mime: string) => {
    updateField(
      'allowedMimeTypes',
      formState.allowedMimeTypes.filter((m) => m !== mime),
    );
  };

  const handleMimeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addMimeType();
    }
  };

  // ─── Render Helpers ─────────────────────────────────────────────────────

  const renderOverrideIndicator = (field: OverrideField) => {
    const overridden = isFieldOverridden(overrides, field);
    return (
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'text-[10px] px-1.5 py-0.5 rounded-full',
            overridden ? 'bg-accent-subtle text-accent-primary' : 'bg-background-muted text-muted',
          )}
        >
          {overridden ? t('indicator_override') : t('indicator_inherited')}
        </span>
        {overridden && (
          <button
            onClick={() => resetField(field)}
            className="text-muted hover:text-foreground transition-default"
            aria-label={t('aria_reset_field', { field })}
            title={t('reset_to_default')}
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  // ─── Loading State ──────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      </div>
    );
  }

  // ─── Main Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Paperclip className="w-5 h-5 text-accent-primary mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p className="text-xs text-muted mt-1">{t('description')}</p>
        </div>
        <Button onClick={save} disabled={!isDirty || isSaving} size="sm" variant="primary">
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {t('save')}
        </Button>
      </div>

      {/* Section: General */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
          {t('section_general')}
        </h4>

        <Field label={t('field_enabled')} description={t('field_enabled_description')}>
          <div className="flex items-center gap-3">
            {renderOverrideIndicator('enabled')}
            <Toggle
              checked={formState.enabled}
              onChange={(val) => updateField('enabled', val)}
              ariaLabel={t('aria_toggle_enabled')}
            />
          </div>
        </Field>
      </div>

      {/* Section: Upload Limits */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
          {t('section_upload_limits')}
        </h4>

        <div className="space-y-4">
          <Field
            label={t('field_max_file_size')}
            description={t('field_max_file_size_description')}
          >
            <div className="mb-2">{renderOverrideIndicator('maxFileSizeBytes')}</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                step="1"
                value={Math.round((formState.maxFileSizeBytes / BYTES_PER_MB) * 100) / 100}
                onChange={(e) => {
                  const mb = parseFloat(e.target.value) || 0;
                  if (mb < 0) return;
                  updateField('maxFileSizeBytes', Math.round(mb * BYTES_PER_MB));
                }}
                aria-label={t('field_max_file_size')}
                className="w-24 px-3 py-1.5 text-sm rounded-lg border border-default bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary"
              />
              <span className="text-xs text-muted">{t('field_max_file_size_unit')}</span>
            </div>
          </Field>

          <Field
            label={t('field_allowed_mime_types')}
            description={t('field_allowed_mime_types_description')}
          >
            <div className="mb-2">{renderOverrideIndicator('allowedMimeTypes')}</div>
            <div className="flex gap-2">
              <input
                ref={mimeInputRef}
                type="text"
                value={mimeInputValue}
                onChange={(e) => {
                  setMimeInputValue(e.target.value);
                  setMimeInputError(null);
                }}
                onKeyDown={handleMimeKeyDown}
                placeholder={t('field_allowed_mime_types_add')}
                aria-label={t('aria_add_mime')}
                className={clsx(
                  'flex-1 px-3 py-1.5 text-sm rounded-lg border bg-background',
                  'text-foreground placeholder:text-muted',
                  'focus:outline-none focus:ring-2 focus:ring-border-focus-primary/30 focus:border-border-focus-primary',
                  mimeInputError ? 'border-error' : 'border-default',
                )}
              />
              <Button onClick={addMimeType} size="sm" variant="secondary">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            {mimeInputError && <p className="text-xs text-error">{mimeInputError}</p>}

            {formState.allowedMimeTypes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {formState.allowedMimeTypes.map((mime) => (
                  <span
                    key={mime}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-md bg-background-elevated text-foreground border border-default"
                  >
                    {mime}
                    <button
                      onClick={() => removeMimeType(mime)}
                      className="text-muted hover:text-error transition-default"
                      aria-label={t('aria_remove_mime', { type: mime })}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <p className="text-xs text-muted">
              {t('mime_count', { count: formState.allowedMimeTypes.length, max: MAX_MIME_ENTRIES })}
            </p>
          </Field>
        </div>
      </div>

      {/* Section: Processing */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
          {t('section_processing')}
        </h4>

        <div className="space-y-4">
          <Field label={t('field_pii_policy')} description={t('field_pii_policy_description')}>
            <div className="mb-2">{renderOverrideIndicator('piiPolicy')}</div>
            <Select
              value={formState.piiPolicy}
              onChange={(value) => updateField('piiPolicy', value as 'redact' | 'block' | 'allow')}
              className="w-48"
              options={[
                { value: 'redact', label: t('pii_redact') },
                { value: 'block', label: t('pii_block') },
                { value: 'allow', label: t('pii_allow') },
              ]}
            />
          </Field>

          <Field
            label={t('field_processing_mode')}
            description={t('field_processing_mode_description')}
          >
            <div className="mb-2">{renderOverrideIndicator('defaultProcessingMode')}</div>
            <Select
              value={formState.defaultProcessingMode}
              onChange={(value) =>
                updateField('defaultProcessingMode', value as 'full' | 'metadata_only' | 'skip')
              }
              className="w-48"
              options={[
                { value: 'full', label: t('processing_full') },
                { value: 'metadata_only', label: t('processing_metadata_only') },
                { value: 'skip', label: t('processing_skip') },
              ]}
            />
          </Field>
        </div>
      </div>

      {/* Section: Info */}
      <div className="space-y-4">
        <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">
          {t('section_info')}
        </h4>

        <Field
          label={t('field_max_files_per_session')}
          description={t('field_max_files_per_session_description')}
        >
          <div className="flex items-center gap-3">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-background-muted text-muted">
              {t('indicator_inherited')}
            </span>
            <span className="text-sm font-mono text-foreground">
              {formState.maxFilesPerSession}
            </span>
          </div>
        </Field>
      </div>
    </div>
  );
}
