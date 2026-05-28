/**
 * AdvancedSettingsTab Component
 *
 * Project-level advanced execution settings: Enable Thinking toggle,
 * Thinking Budget, Thought Description, LLM Task Prompts, Messages,
 * Escalation Templates, and settings version management.
 * Loads/saves via /api/projects/:id/settings (proxied to runtime).
 * Uses prompt defaults returned by the project settings API for Reset to Default.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Brain,
  Loader2,
  Check,
  Plus,
  ChevronRight,
  RotateCcw,
  FileText,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { motion, AnimatePresence } from 'framer-motion';
import { springs } from '../../lib/animation';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { toast } from 'sonner';
import { deleteAndRemoveProject } from '../../api/projects';

interface SettingsVersion {
  _id: string;
  version: string;
  status: string;
  sourceHash: string;
  changelog: string | null;
  createdBy: string;
  createdAt: string;
  promotedAt: string | null;
}

const THINKING_BUDGET_MIN = 128;
const THINKING_BUDGET_MAX = 32768;
const THINKING_BUDGET_DEFAULT = 1024;

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-background-elevated text-muted',
  testing: 'bg-warning-subtle text-warning',
  staged: 'bg-info-subtle text-info',
  active: 'bg-success-subtle text-success',
  deprecated: 'bg-error-subtle text-error',
};

/** LLM prompt override keys with their i18n label and hint keys */
const LLM_PROMPT_FIELDS = [
  {
    key: 'llm_prompt.entity_extraction',
    label: 'entity_extraction',
    hint: 'entity_extraction_hint',
  },
  {
    key: 'llm_prompt.correction_detection',
    label: 'correction_detection',
    hint: 'correction_detection_hint',
  },
  { key: 'llm_prompt.field_validation', label: 'field_validation', hint: 'field_validation_hint' },
  { key: 'llm_prompt.field_inference', label: 'field_inference', hint: 'field_inference_hint' },
] as const;

/** Escalation template override keys with their i18n label and hint keys */
const ESCALATION_FIELDS = [
  { key: 'escalation.digital', label: 'escalation_digital', hint: 'escalation_digital_hint' },
  { key: 'escalation.voice', label: 'escalation_voice', hint: 'escalation_voice_hint' },
  { key: 'escalation.plain', label: 'escalation_plain', hint: 'escalation_plain_hint' },
] as const;

/** Thought description as a single-item field for accordion reuse */
const THOUGHT_FIELD = [
  {
    key: 'tool_description.shared.thought',
    label: 'thought_description',
    hint: 'thought_description_hint',
  },
] as const;

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

export function AdvancedSettingsTab() {
  const t = useTranslations('settings.advanced');
  const { projectId } = useNavigationStore();
  const [enableThinking, setEnableThinking] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState<string>('');
  const [thoughtDescription, setThoughtDescription] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Prompt overrides state — values the user has customized
  const [promptOverrides, setPromptOverrides] = useState<Record<string, string>>({});
  // Prompt defaults returned by the project settings API
  const [promptDefaults, setPromptDefaults] = useState<Record<string, string>>({});

  // Version state
  const [versions, setVersions] = useState<SettingsVersion[]>([]);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const settingsRes = await apiFetch(`/api/projects/${projectId}/settings`);

      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setEnableThinking(data.settings?.enableThinking ?? false);
        setThinkingBudget(
          data.settings?.thinkingBudget != null ? String(data.settings.thinkingBudget) : '',
        );
        setThoughtDescription(data.settings?.thoughtDescription ?? '');
        setPromptOverrides(data.settings?.promptOverrides ?? {});
        if (data.promptDefaults) {
          const defaults: Record<string, string> = {};
          for (const [key, value] of Object.entries(data.promptDefaults)) {
            if (typeof value === 'string') {
              defaults[key] = value;
            }
          }
          setPromptDefaults(defaults);
        }
      }
    } catch {
      // Silent — use defaults
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const loadVersions = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingVersions(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings/versions?limit=20`);
      if (!res.ok) return;
      const data = await res.json();
      setVersions(data.versions ?? []);
    } catch {
      // Silent
    } finally {
      setIsLoadingVersions(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    loadVersions();
  }, [load, loadVersions]);

  /** Get the effective value for a prompt override key (override → platform default) */
  const getEffectiveValue = (key: string): string => {
    return promptOverrides[key] ?? promptDefaults[key] ?? '';
  };

  /** Check if a key has a custom override (different from default) */
  const hasOverride = (key: string): boolean => {
    return (
      key in promptOverrides &&
      promptOverrides[key] !== '' &&
      promptOverrides[key] !== promptDefaults[key]
    );
  };

  /** Update a prompt override value */
  const setOverride = (key: string, value: string) => {
    setPromptOverrides((prev) => {
      const next = { ...prev };
      if (value.trim() === '' || value === promptDefaults[key]) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setIsDirty(true);
  };

  /** Reset a prompt override to the platform default */
  const resetOverride = (key: string) => {
    setPromptOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setIsDirty(true);
  };

  const handleSave = async () => {
    if (!projectId) return;
    setIsSaving(true);
    try {
      const body: Record<string, unknown> = { enableThinking };
      const budgetNum = thinkingBudget.trim() ? Number(thinkingBudget) : null;
      if (thinkingBudget.trim() && isNaN(budgetNum as number)) {
        toast.error('Thinking budget must be a number');
        setIsSaving(false);
        return;
      }
      if (enableThinking && (budgetNum == null || budgetNum <= 0)) {
        toast.error(
          `Thinking budget is required when thinking is enabled (${THINKING_BUDGET_MIN}–${THINKING_BUDGET_MAX})`,
        );
        setIsSaving(false);
        return;
      }
      if (
        budgetNum != null &&
        (budgetNum < THINKING_BUDGET_MIN || budgetNum > THINKING_BUDGET_MAX)
      ) {
        toast.error(
          `Thinking budget must be between ${THINKING_BUDGET_MIN} and ${THINKING_BUDGET_MAX}`,
        );
        setIsSaving(false);
        return;
      }
      body.thinkingBudget = budgetNum;
      body.thoughtDescription = thoughtDescription.trim() || null;

      // Build clean prompt overrides — only keys with non-empty values different from defaults
      const cleanOverrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(promptOverrides)) {
        if (typeof value === 'string' && value.trim() !== '' && value !== promptDefaults[key]) {
          cleanOverrides[key] = value;
        }
      }
      body.promptOverrides = cleanOverrides;

      const res = await apiFetch(`/api/projects/${projectId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      setIsDirty(false);
      toast.success('Settings saved');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save';
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateVersion = async () => {
    if (!projectId) return;
    setIsCreatingVersion(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/settings/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create version');
      }
      const data = await res.json();
      if (data.version?.deduplicated) {
        toast.info('No changes since last version');
      } else {
        toast.success(t('version_created'));
      }
      await loadVersions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create version';
      toast.error(message);
    } finally {
      setIsCreatingVersion(false);
    }
  };

  const handlePromote = async (version: string, targetStatus: string) => {
    if (!projectId) return;
    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/settings/versions/${version}/promote`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetStatus }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to promote');
      }
      toast.success(t('version_promoted'));
      await loadVersions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to promote';
      toast.error(message);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-md bg-purple-subtle">
            <Brain className="w-4 h-4 text-purple" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">{t('thinking_section_title')}</h3>
        </div>

        <Field label={t('enable_thinking')} description={t('enable_thinking_description')}>
          <Toggle
            checked={enableThinking}
            onChange={(val) => {
              setEnableThinking(val);
              if (val && !thinkingBudget.trim()) {
                setThinkingBudget(String(THINKING_BUDGET_DEFAULT));
              }
              setIsDirty(true);
            }}
            ariaLabel={t('enable_thinking')}
          />
        </Field>

        {enableThinking && (
          <div className="space-y-4">
            <Field label={t('thinking_budget')} description={t('thinking_budget_description')}>
              <Input
                id="thinking-budget-input"
                type="number"
                min={THINKING_BUDGET_MIN}
                max={THINKING_BUDGET_MAX}
                step="128"
                placeholder={String(THINKING_BUDGET_DEFAULT)}
                value={thinkingBudget}
                onChange={(e) => {
                  setThinkingBudget(e.target.value);
                  setIsDirty(true);
                }}
                className="w-40"
              />
            </Field>

            <PromptAccordionSection
              icon={null}
              iconBg=""
              title=""
              description=""
              fields={THOUGHT_FIELD}
              t={t}
              getEffectiveValue={(key) => getEffectiveValue(key) || thoughtDescription}
              hasOverride={(key) => hasOverride(key) || !!thoughtDescription.trim()}
              setOverride={(key, val) => {
                setThoughtDescription(val);
                setOverride(key, val);
              }}
              resetOverride={(key) => {
                setThoughtDescription('');
                resetOverride(key);
              }}
              inline
            />
          </div>
        )}
      </div>

      <div className="space-y-6">
        <PromptAccordionSection
          icon={<FileText className="w-4 h-4 text-accent" />}
          iconBg="bg-accent-subtle"
          title={t('llm_prompts_title')}
          description={t('llm_prompts_description')}
          fields={LLM_PROMPT_FIELDS}
          t={t}
          getEffectiveValue={getEffectiveValue}
          hasOverride={hasOverride}
          setOverride={setOverride}
          resetOverride={resetOverride}
        />

        <PromptAccordionSection
          icon={<AlertTriangle className="w-4 h-4 text-warning" />}
          iconBg="bg-warning-subtle"
          title={t('escalation_title')}
          description={t('escalation_description')}
          fields={ESCALATION_FIELDS}
          t={t}
          getEffectiveValue={getEffectiveValue}
          hasOverride={hasOverride}
          setOverride={setOverride}
          resetOverride={resetOverride}
        />
      </div>

      {isDirty && (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <Check className="w-4 h-4 mr-1.5" />
            )}
            Save
          </Button>
        </div>
      )}

      {/* Danger Zone */}
      <DangerZone projectId={projectId} />

      {/* Settings Versions */}
      <div className="border-t border-default pt-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">{t('versions_title')}</h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCreateVersion}
            disabled={isCreatingVersion || isDirty}
          >
            {isCreatingVersion ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <Plus className="w-4 h-4 mr-1.5" />
            )}
            {t('create_version')}
          </Button>
        </div>

        {isLoadingVersions ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-muted" />
          </div>
        ) : versions.length === 0 ? (
          <p className="text-xs text-muted py-4 text-center">
            No versions yet. Save settings and create a version to enable deployment pinning.
          </p>
        ) : (
          <div className="space-y-2">
            {versions.map((v) => (
              <VersionRow key={v._id} version={v} onPromote={handlePromote} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// DANGER ZONE
// =============================================================================

function DangerZone({ projectId }: { projectId: string | null }) {
  const t = useTranslations('projects');
  const { navigate } = useNavigationStore();
  const [confirmText, setConfirmText] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!projectId || confirmText !== 'delete') return;
    setIsDeleting(true);
    try {
      await deleteAndRemoveProject(projectId);
      toast.success(t('delete_success'));
      navigate('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete';
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="border-t border-error/30 pt-6">
      <div className="rounded-lg border border-error/30 bg-error-subtle/10 p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-md bg-error-subtle">
            <Trash2 className="w-4 h-4 text-error" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-error">Danger Zone</h3>
            <p className="text-xs text-muted mt-0.5">{t('delete_confirm_description')}</p>
          </div>
        </div>

        {!showConfirm ? (
          <Button variant="danger" size="sm" onClick={() => setShowConfirm(true)}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            Delete Project
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-foreground">{t('delete_confirm')}</p>
            <p className="text-xs text-muted">
              Type <span className="font-mono font-semibold text-error">delete</span> to confirm.
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="delete"
              className={clsx(
                'w-48 px-3 py-1.5 text-sm rounded-md border border-default',
                'bg-background text-foreground placeholder:text-foreground-subtle',
                'focus-ring',
              )}
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                disabled={confirmText !== 'delete' || isDeleting}
              >
                {isDeleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                )}
                Permanently Delete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowConfirm(false);
                  setConfirmText('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// PROMPT ACCORDION SECTION
// =============================================================================

function PromptAccordionSection({
  icon,
  iconBg,
  title,
  description,
  fields,
  t,
  getEffectiveValue,
  hasOverride,
  setOverride,
  resetOverride,
  inline,
}: {
  icon: React.ReactNode | null;
  iconBg: string;
  title: string;
  description: string;
  fields: ReadonlyArray<{ key: string; label: string; hint?: string }>;
  t: (key: string) => string;
  getEffectiveValue: (key: string) => string;
  hasOverride: (key: string) => boolean;
  setOverride: (key: string, value: string) => void;
  resetOverride: (key: string) => void;
  inline?: boolean;
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const overrideCount = fields.filter((f) => hasOverride(f.key)).length;

  const rows = (
    <div className="space-y-px">
      {fields.map(({ key, label, hint }) => (
        <AccordionPromptRow
          key={key}
          label={t(label)}
          hint={hint ? t(hint) : undefined}
          value={getEffectiveValue(key)}
          isOverridden={hasOverride(key)}
          isExpanded={expandedKey === key}
          onToggle={() => setExpandedKey(expandedKey === key ? null : key)}
          onChange={(val) => setOverride(key, val)}
          onReset={() => resetOverride(key)}
          resetLabel={t('reset_to_default')}
          deprecated={key === 'llm_prompt.entity_extraction'}
        />
      ))}
    </div>
  );

  if (inline) {
    return <div className="space-y-4">{rows}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {icon && <div className={clsx('p-1.5 rounded-md', iconBg)}>{icon}</div>}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {overrideCount > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-accent-subtle text-accent">
                {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
              </span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5">{description}</p>
        </div>
      </div>
      <div className="space-y-4">{rows}</div>
    </div>
  );
}

// =============================================================================
// ACCORDION PROMPT ROW
// =============================================================================

function AccordionPromptRow({
  label,
  hint,
  value,
  isOverridden,
  isExpanded,
  onToggle,
  onChange,
  onReset,
  resetLabel,
  deprecated,
}: {
  label: string;
  hint?: string;
  value: string;
  isOverridden: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
  onReset: () => void;
  resetLabel: string;
  deprecated?: boolean;
}) {
  const flat = value.replace(/\s+/g, ' ').trim();
  const preview = flat.length > 120 ? flat.slice(0, 120) + '...' : flat;

  return (
    <Field label={label} description={hint}>
      <div
        className={clsx(
          'rounded-md border transition-default',
          isExpanded ? 'border-accent/30 bg-background' : 'border-default hover:bg-background/50',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
        >
          <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.15 }}>
            <ChevronRight className="w-3.5 h-3.5 text-foreground-subtle shrink-0" />
          </motion.div>

          {deprecated && (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-warning-subtle text-warning shrink-0">
              deprecated with inline gather
            </span>
          )}

          {isOverridden && (
            <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-accent-subtle text-accent shrink-0">
              customized
            </span>
          )}

          <span className="text-xs text-foreground-subtle truncate">
            {preview || (isOverridden ? 'Custom override' : 'Platform default')}
          </span>
        </button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={springs.gentle}
              className="overflow-hidden"
            >
              <div className="px-3 pb-3 pt-0">
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={clsx(
                      'text-xs px-1.5 py-0.5 rounded-full font-medium',
                      isOverridden
                        ? 'bg-accent-subtle text-accent'
                        : 'bg-background-elevated text-foreground-subtle',
                    )}
                  >
                    {isOverridden ? 'Custom override' : 'Platform default'}
                  </span>
                  {isOverridden && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReset();
                      }}
                      className="flex items-center gap-1 text-xs text-info hover:text-info/80 transition-default"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {resetLabel}
                    </button>
                  )}
                </div>
                <Textarea
                  rows={6}
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  className={clsx(
                    'resize-y font-mono leading-relaxed',
                    isOverridden && 'border-accent/40',
                  )}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Field>
  );
}

// =============================================================================
// VERSION ROW
// =============================================================================

function VersionRow({
  version,
  onPromote,
}: {
  version: SettingsVersion;
  onPromote: (version: string, targetStatus: string) => void;
}) {
  const nextStatus = getNextPromotionStatus(version.status);

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-default bg-background p-3">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-sm font-mono font-medium text-foreground">{version.version}</span>
        <span
          className={clsx(
            'px-2 py-0.5 rounded-full text-xs font-medium',
            STATUS_COLORS[version.status] ?? 'bg-background-elevated text-muted',
          )}
        >
          {version.status}
        </span>
        <span className="text-xs text-muted truncate">
          {new Date(version.createdAt).toLocaleDateString()}
        </span>
      </div>
      {nextStatus && (
        <button
          onClick={() => onPromote(version.version, nextStatus)}
          className="flex items-center gap-1 text-xs text-info hover:text-info/80 transition-default"
        >
          {nextStatus}
          <ChevronRight className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function getNextPromotionStatus(current: string): string | null {
  switch (current) {
    case 'draft':
      return 'testing';
    case 'testing':
      return 'staged';
    case 'staged':
      return 'active';
    default:
      return null;
  }
}
