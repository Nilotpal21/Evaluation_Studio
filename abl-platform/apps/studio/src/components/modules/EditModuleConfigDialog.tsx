/**
 * EditModuleConfigDialog Component
 *
 * Dialog for editing module config overrides after import.
 * Shows required config keys from the contract snapshot and allows
 * adding additional key-value overrides.
 */

'use client';

import { useState, useEffect, useMemo } from 'react';
import { Settings, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { sanitizeError } from '../../lib/sanitize-error';
import type { ModuleDependency } from '../../api/modules';

interface EditModuleConfigDialogProps {
  open: boolean;
  onClose: () => void;
  dependency: ModuleDependency;
  onSave: (configOverrides: Record<string, string>) => Promise<void>;
}

export function EditModuleConfigDialog({
  open,
  onClose,
  dependency,
  onSave,
}: EditModuleConfigDialogProps) {
  const t = useTranslations('modules.dependencies');

  const [overrides, setOverrides] = useState<Array<{ key: string; value: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const existing = dependency.configOverrides ?? {};
      setOverrides(Object.entries(existing).map(([key, value]) => ({ key, value })));
    }
  }, [open, dependency]);

  const requiredKeys = useMemo(() => {
    const keys = dependency.contractSnapshot?.requiredConfigKeys;
    if (!keys) return [];
    return keys.map((entry) => entry.key);
  }, [dependency.contractSnapshot?.requiredConfigKeys]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const config: Record<string, string> = {};
      for (const { key, value } of overrides) {
        if (key.trim()) config[key.trim()] = value;
      }
      await onSave(config);
      toast.success(t('edit_config_success', { alias: dependency.alias }));
      onClose();
    } catch (err) {
      const message = sanitizeError(err, t('edit_config_error'));
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('edit_config_title')}
      maxWidth="lg"
      noBodyWrapper
    >
      <div className="px-6 py-2 text-xs text-muted border-b border-default">
        {t('edit_config_module_label', {
          name: dependency.moduleProjectName,
          alias: dependency.alias,
        })}
        {dependency.resolvedVersion &&
          ` · ${t('edit_config_version', { version: dependency.resolvedVersion })}`}
      </div>

      <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {requiredKeys.length > 0 && (
          <div>
            <div className="text-xs font-medium text-muted mb-2">
              {t('edit_config_required_keys')}
            </div>
            <div className="space-y-2">
              {requiredKeys.map((key) => {
                const idx = overrides.findIndex((o) => o.key === key);
                const value = idx >= 0 ? overrides[idx].value : '';
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="font-mono text-xs w-40 shrink-0">{key}</span>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => {
                        const newOverrides = [...overrides];
                        if (idx >= 0) {
                          newOverrides[idx] = { key, value: e.target.value };
                        } else {
                          newOverrides.push({ key, value: e.target.value });
                        }
                        setOverrides(newOverrides);
                      }}
                      className="flex-1 px-2 py-1 text-sm border border-default rounded bg-background focus:outline-none focus:ring-1 focus:ring-accent"
                      placeholder={t('edit_config_value_placeholder')}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted">
              {t('edit_config_additional_overrides')}
            </span>
            <button
              type="button"
              onClick={() => setOverrides([...overrides, { key: '', value: '' }])}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <Plus className="h-3 w-3" /> {t('edit_config_add')}
            </button>
          </div>
          <div className="space-y-2">
            {overrides
              .filter((o) => !requiredKeys.includes(o.key))
              .map((override, i) => {
                const actualIdx = overrides.indexOf(override);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={override.key}
                      onChange={(e) => {
                        const newOverrides = [...overrides];
                        newOverrides[actualIdx] = { ...override, key: e.target.value };
                        setOverrides(newOverrides);
                      }}
                      className="w-40 px-2 py-1 text-sm font-mono border border-default rounded bg-background focus:outline-none focus:ring-1 focus:ring-accent"
                      placeholder={t('edit_config_key_placeholder')}
                    />
                    <input
                      type="text"
                      value={override.value}
                      onChange={(e) => {
                        const newOverrides = [...overrides];
                        newOverrides[actualIdx] = { ...override, value: e.target.value };
                        setOverrides(newOverrides);
                      }}
                      className="flex-1 px-2 py-1 text-sm border border-default rounded bg-background focus:outline-none focus:ring-1 focus:ring-accent"
                      placeholder={t('edit_config_value_placeholder')}
                    />
                    <button
                      type="button"
                      onClick={() => setOverrides(overrides.filter((_, j) => j !== actualIdx))}
                      className="text-muted hover:text-error"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
          </div>
        </div>

        <div className="rounded border border-warning/30 bg-warning/5 p-2">
          <p className="text-xs text-warning">{t('edit_config_secrets_warning')}</p>
        </div>
      </div>

      <div className="flex justify-end gap-2 px-6 py-3 border-t border-default">
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t('edit_config_cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} loading={saving} disabled={saving}>
          {saving ? t('edit_config_saving') : t('edit_config_save')}
        </Button>
      </div>
    </Dialog>
  );
}
