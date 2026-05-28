/**
 * PIIProtectionTab Component
 *
 * Project settings tab for PII pattern management.
 * Shows global toggles, built-in patterns (read-only detection, configurable
 * redaction/consumer access), and custom user-created patterns.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { useTranslations } from 'next-intl';
import {
  Shield,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Settings2,
  Info,
  Mail,
  Phone,
  CreditCard,
  Globe,
  Hash,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button } from '../ui/Button';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { PIIPatternFormDialog, type IPIIPattern } from './PIIPatternFormDialog';

// ─── Constants ──────────────────────────────────────────────────────────────

const BUILTIN_PATTERNS: Array<{
  nameKey: string;
  piiType: string;
  icon: React.ReactNode;
  descriptionKey: string;
}> = [
  {
    nameKey: 'builtin_email_name',
    piiType: 'email',
    icon: <Mail className="w-4 h-4" />,
    descriptionKey: 'builtin_email_description',
  },
  {
    nameKey: 'builtin_phone_name',
    piiType: 'phone',
    icon: <Phone className="w-4 h-4" />,
    descriptionKey: 'builtin_phone_description',
  },
  {
    nameKey: 'builtin_ssn_name',
    piiType: 'ssn',
    icon: <Hash className="w-4 h-4" />,
    descriptionKey: 'builtin_ssn_description',
  },
  {
    nameKey: 'builtin_credit_card_name',
    piiType: 'credit_card',
    icon: <CreditCard className="w-4 h-4" />,
    descriptionKey: 'builtin_credit_card_description',
  },
  {
    nameKey: 'builtin_ip_name',
    piiType: 'ip_address',
    icon: <Globe className="w-4 h-4" />,
    descriptionKey: 'builtin_ip_description',
  },
];

const PII_TYPE_LABEL_KEYS: Record<string, string> = {
  email: 'type_email',
  phone: 'type_phone',
  ssn: 'type_ssn',
  credit_card: 'type_credit_card',
  ip_address: 'type_ip_address',
  custom: 'type_custom',
};

// ─── Type Badge ─────────────────────────────────────────────────────────────

function TypeBadge({ piiType, t }: { piiType: string; t: (key: string) => string }) {
  const labelKey = PII_TYPE_LABEL_KEYS[piiType];
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full bg-accent-subtle text-accent">
      {labelKey ? t(labelKey) : piiType}
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PIIProtectionTab() {
  const t = useTranslations('settings.pii_protection');
  const { projectId } = useNavigationStore();
  const [patterns, setPatterns] = useState<IPIIPattern[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [piiDetectionEnabled, setPiiDetectionEnabled] = useState(true);
  const [piiOutputRedactionEnabled, setPiiOutputRedactionEnabled] = useState(false);

  // Dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [editPattern, setEditPattern] = useState<IPIIPattern | undefined>(undefined);
  const [builtinOverride, setBuiltinOverride] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<IPIIPattern | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // ── Data fetching ──

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/pii-patterns`);
      const data = await res.json();
      if (data.success) {
        setPatterns(data.data || []);
      }
    } catch {
      toast.error(t('load_failed'));
    } finally {
      setIsLoading(false);
    }

    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`);
      if (!res.ok) return;
      const data = await res.json();
      const pii = data?.data?.pii_redaction;
      if (!pii || typeof pii !== 'object') return;
      const piiEnabled = pii.enabled !== false;
      setPiiDetectionEnabled(piiEnabled && pii.redact_input !== false);
      setPiiOutputRedactionEnabled(piiEnabled && pii.redact_output === true);
    } catch {
      // Runtime config is additive to pattern management. If it is temporarily
      // unavailable, leave the local defaults visible and keep pattern editing usable.
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Handlers ──

  const persistPIIRuntimeConfig = async (
    nextDetectionEnabled: boolean,
    nextOutputEnabled: boolean,
  ) => {
    if (!projectId) return;
    const res = await apiFetch(`/api/projects/${projectId}/runtime-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pii_redaction: {
          enabled: nextDetectionEnabled || nextOutputEnabled,
          redact_input: nextDetectionEnabled,
          redact_output: nextOutputEnabled,
        },
      }),
    });
    if (!res.ok) {
      throw new Error('PII runtime config update failed');
    }
  };

  const handleToggleDetection = async (nextEnabled: boolean) => {
    const previousDetection = piiDetectionEnabled;
    const previousOutput = piiOutputRedactionEnabled;
    setPiiDetectionEnabled(nextEnabled);
    try {
      await persistPIIRuntimeConfig(nextEnabled, previousOutput);
    } catch {
      setPiiDetectionEnabled(previousDetection);
      setPiiOutputRedactionEnabled(previousOutput);
      toast.error(t('runtime_config_update_failed'));
    }
  };

  const handleToggleOutputRedaction = async (nextEnabled: boolean) => {
    const previousDetection = piiDetectionEnabled;
    const previousOutput = piiOutputRedactionEnabled;
    setPiiOutputRedactionEnabled(nextEnabled);
    try {
      await persistPIIRuntimeConfig(previousDetection, nextEnabled);
    } catch {
      setPiiDetectionEnabled(previousDetection);
      setPiiOutputRedactionEnabled(previousOutput);
      toast.error(t('runtime_config_update_failed'));
    }
  };

  const handleToggleEnabled = async (pattern: IPIIPattern) => {
    const newEnabled = !pattern.enabled;
    // Optimistic update
    setPatterns((prev) =>
      prev.map((p) => (p._id === pattern._id ? { ...p, enabled: newEnabled } : p)),
    );
    try {
      const res = await apiFetch(`/api/projects/${projectId}/pii-patterns/${pattern._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pattern, enabled: newEnabled }),
      });
      if (!res.ok) {
        // Revert on failure
        setPatterns((prev) =>
          prev.map((p) => (p._id === pattern._id ? { ...p, enabled: !newEnabled } : p)),
        );
        toast.error(t('update_failed'));
      }
    } catch {
      setPatterns((prev) =>
        prev.map((p) => (p._id === pattern._id ? { ...p, enabled: !newEnabled } : p)),
      );
      toast.error(t('update_failed'));
    }
  };

  const handleOpenCreate = () => {
    setEditPattern(undefined);
    setBuiltinOverride(false);
    setFormOpen(true);
  };

  const handleOpenEdit = (pattern: IPIIPattern) => {
    setEditPattern(pattern);
    setBuiltinOverride(pattern.builtinOverride);
    setFormOpen(true);
  };

  const handleOpenBuiltinConfigure = (builtinType: string) => {
    // Find existing override for this built-in type
    const existing = patterns.find((p) => p.builtinOverride && p.piiType === builtinType);
    if (existing) {
      setEditPattern(existing);
    } else {
      // Create a template for new built-in override
      const builtin = BUILTIN_PATTERNS.find((b) => b.piiType === builtinType);
      setEditPattern({
        _id: '',
        name: builtin ? t(builtin.nameKey) : builtinType,
        piiType: builtinType,
        redaction: { type: 'predefined', label: `[REDACTED_${builtinType.toUpperCase()}]` },
        consumerAccess: [],
        defaultRenderMode: 'redacted',
        enabled: true,
        builtinOverride: true,
      } as IPIIPattern);
    }
    setBuiltinOverride(true);
    setFormOpen(true);
  };

  const handleFormClose = () => {
    setFormOpen(false);
    setEditPattern(undefined);
    setBuiltinOverride(false);
  };

  const handleFormSave = () => {
    handleFormClose();
    load();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/api/projects/${projectId}/pii-patterns/${deleteTarget._id}`, {
        method: 'DELETE',
      });
      setPatterns((prev) => prev.filter((p) => p._id !== deleteTarget._id));
      toast.success(t('deleted', { name: deleteTarget.name }));
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setDeleteLoading(false);
      setDeleteTarget(null);
    }
  };

  // ── Derived data ──

  const customPatterns = patterns.filter((p) => !p.builtinOverride);
  const builtinOverrides = patterns.filter((p) => p.builtinOverride);

  const getBuiltinOverride = (piiType: string) =>
    builtinOverrides.find((p) => p.piiType === piiType);

  // ── Render ──

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted mt-1">{t('description')}</p>
      </div>

      {/* ── Global Toggles ── */}
      <section className="rounded-lg border border-default bg-background-muted p-4 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">{t('global_settings')}</h3>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('pii_detection')}</p>
            <p className="text-xs text-muted mt-0.5">{t('pii_detection_description')}</p>
          </div>
          <Toggle checked={piiDetectionEnabled} onChange={handleToggleDetection} />
        </div>

        <div className="border-t border-default" />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('pii_output_redaction')}</p>
            <p className="text-xs text-muted mt-0.5">{t('pii_output_redaction_description')}</p>
          </div>
          <Toggle checked={piiOutputRedactionEnabled} onChange={handleToggleOutputRedaction} />
        </div>

        <div className="flex items-start gap-2 rounded-md border border-info/20 bg-info-subtle/50 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <p className="text-xs text-muted">{t('baseline_secret_scrubbing_notice')}</p>
        </div>
      </section>

      {/* ── Built-in Patterns ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t('builtin_patterns')}</h3>
          <span className="text-xs text-muted">{t('builtin_always_active')}</span>
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg bg-info-subtle/50 border border-info/20">
          <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
          <p className="text-xs text-muted">{t('builtin_info')}</p>
        </div>

        <div className="grid gap-3">
          {BUILTIN_PATTERNS.map((builtin) => {
            const override = getBuiltinOverride(builtin.piiType);
            return (
              <div
                key={builtin.piiType}
                data-testid={`pii-builtin-card-${builtin.piiType}`}
                className="flex items-center justify-between gap-4 rounded-lg border border-default bg-background p-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center text-accent shrink-0">
                    {builtin.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {t(builtin.nameKey)}
                      </span>
                      <TypeBadge piiType={builtin.piiType} t={t} />
                      {override && (
                        <span
                          className="text-xs text-success font-medium"
                          data-testid={`pii-builtin-customized-${builtin.piiType}`}
                        >
                          {t('customized')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted mt-0.5">{t(builtin.descriptionKey)}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleOpenBuiltinConfigure(builtin.piiType)}
                  data-testid={`pii-builtin-configure-${builtin.piiType}`}
                  className={clsx(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-default',
                    'border border-default bg-background text-foreground hover:bg-background-muted',
                  )}
                >
                  <Settings2 className="w-3.5 h-3.5" />
                  {t('configure')}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Custom Patterns ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{t('custom_patterns')}</h3>
          <Button onClick={handleOpenCreate} size="sm" icon={<Plus className="w-3.5 h-3.5" />}>
            {t('add_pattern')}
          </Button>
        </div>

        {customPatterns.length === 0 ? (
          <EmptyState
            icon={<Shield className="w-6 h-6" />}
            title={t('empty_title')}
            description={t('empty_description')}
            action={
              <Button
                onClick={handleOpenCreate}
                variant="primary"
                icon={<Plus className="w-3.5 h-3.5" />}
              >
                {t('add_pattern')}
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {customPatterns.map((pattern) => (
              <div
                key={pattern._id}
                className="flex items-center justify-between gap-4 rounded-lg border border-default bg-background p-4"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{pattern.name}</span>
                      <TypeBadge piiType={pattern.piiType} t={t} />
                    </div>
                    {pattern.regex && (
                      <p
                        className="text-xs font-mono text-muted mt-1 truncate max-w-md"
                        title={pattern.regex}
                      >
                        {pattern.regex}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Toggle checked={pattern.enabled} onChange={() => handleToggleEnabled(pattern)} />
                  <button
                    onClick={() => handleOpenEdit(pattern)}
                    className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                    title={t('edit')}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(pattern)}
                    className="p-1.5 text-muted hover:text-error rounded transition-default"
                    title={t('delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Form Dialog ── */}
      {formOpen && projectId && (
        <PIIPatternFormDialog
          open={formOpen}
          onClose={handleFormClose}
          onSave={handleFormSave}
          projectId={projectId}
          pattern={editPattern}
          builtinOverride={builtinOverride}
        />
      )}

      {/* ── Delete Confirmation ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title={t('delete_confirm_title', { name: deleteTarget?.name || '' })}
        description={t('delete_confirm_description')}
        confirmLabel={t('delete')}
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
