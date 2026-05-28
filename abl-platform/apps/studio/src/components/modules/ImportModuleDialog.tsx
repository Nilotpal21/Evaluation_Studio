/**
 * ImportModuleDialog Component
 *
 * Two-step dialog for importing a reusable module into a consumer project.
 * Step 1: Select module from catalog, choose version/environment, set alias, preview.
 * Step 2: Review mounted symbols, prerequisites, collisions, set config overrides, confirm.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Package,
  Bot,
  Wrench,
  Plus,
  Trash2,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  listCatalog,
  getModuleDetail,
  previewImport,
  confirmImport,
  type CatalogEntry,
  type CatalogDetail,
  type ImportPreview,
} from '../../api/modules';
import { useModuleStore } from '../../store/module-store';

// =============================================================================
// TYPES
// =============================================================================

interface ImportModuleDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onImported?: () => void;
}

type Step = 'select' | 'review';
type SelectorType = 'version' | 'environment';

const ALIAS_REGEX = /^[a-z][a-z0-9_]{1,24}$/;

// =============================================================================
// COMPONENT
// =============================================================================

export function ImportModuleDialog({
  open,
  onClose,
  projectId,
  onImported,
}: ImportModuleDialogProps) {
  const t = useTranslations('modules.import');

  // Step 1 state
  const [step, setStep] = useState<Step>('select');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedModuleId, setSelectedModuleId] = useState('');
  const [moduleDetail, setModuleDetail] = useState<CatalogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectorType, setSelectorType] = useState<SelectorType>('version');
  const [selectorValue, setSelectorValue] = useState('');
  const [alias, setAlias] = useState('');
  const [aliasTouched, setAliasTouched] = useState(false);

  // Step 2 state
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [configOverrides, setConfigOverrides] = useState<Array<{ key: string; value: string }>>([]);
  const [importLoading, setImportLoading] = useState(false);

  const { setImportDialogOpen, setImportPreview } = useModuleStore();

  // Derived
  const aliasError =
    aliasTouched && alias.length > 0 && !ALIAS_REGEX.test(alias) ? t('aliasHelp') : undefined;
  const hasBlockingPrereqs = (preview?.prerequisites.blocking.length ?? 0) > 0;

  // Load catalog when dialog opens
  useEffect(() => {
    if (!open) return;
    setCatalogLoading(true);
    listCatalog(projectId)
      .then((res) => {
        if (res.success) setCatalog(res.data);
      })
      .catch(() => {
        toast.error(t('loadError'));
      })
      .finally(() => setCatalogLoading(false));
  }, [open, projectId]);

  // Load module detail when selection changes
  useEffect(() => {
    if (!selectedModuleId) {
      setModuleDetail(null);
      return;
    }
    setDetailLoading(true);
    getModuleDetail(projectId, selectedModuleId)
      .then((res) => {
        if (res.success) {
          setModuleDetail(res.data);
          // Auto-select latest version if available
          if (res.data.releases.length > 0) {
            setSelectorType('version');
            setSelectorValue(res.data.releases[0].version);
          } else if (res.data.environments.length > 0) {
            setSelectorType('environment');
            setSelectorValue(res.data.environments[0].environment);
          }
        }
      })
      .catch(() => {
        toast.error(t('detailError'));
      })
      .finally(() => setDetailLoading(false));
  }, [projectId, selectedModuleId]);

  const reset = useCallback(() => {
    setStep('select');
    setSelectedModuleId('');
    setModuleDetail(null);
    setSelectorType('version');
    setSelectorValue('');
    setAlias('');
    setAliasTouched(false);
    setPreview(null);
    setConfigOverrides([]);
    setPreviewLoading(false);
    setImportLoading(false);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
    setImportDialogOpen(false);
  };

  const handlePreview = async () => {
    if (!selectedModuleId || !selectorValue || !alias || aliasError) return;
    setPreviewLoading(true);
    try {
      const res = await previewImport(projectId, {
        moduleProjectId: selectedModuleId,
        selector: { type: selectorType, value: selectorValue },
        alias,
      });
      if (res.success) {
        setPreview(res.data);
        setImportPreview(res.data as never);
        // Initialize config override rows from required non-secret keys
        const contract = moduleDetail?.releases.find(
          (r) => r.id === res.data.resolvedReleaseId,
        )?.contract;
        if (contract?.requiredConfigKeys) {
          setConfigOverrides(
            contract.requiredConfigKeys
              .filter((k) => !k.isSecret)
              .map((k) => ({ key: k.key, value: '' })),
          );
        }
        setStep('review');
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('previewError')));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleImport = async () => {
    if (!preview || hasBlockingPrereqs) return;
    setImportLoading(true);
    try {
      const overridesMap: Record<string, string> = {};
      for (const entry of configOverrides) {
        if (entry.key && entry.value) {
          overridesMap[entry.key] = entry.value;
        }
      }
      const res = await confirmImport(projectId, {
        moduleProjectId: selectedModuleId,
        selector: { type: selectorType, value: selectorValue },
        alias,
        resolvedReleaseId: preview.resolvedReleaseId,
        configOverrides: Object.keys(overridesMap).length > 0 ? overridesMap : undefined,
      });
      if (res.success) {
        toast.success(t('importSuccess', { alias }));
        setImportPreview(null);
        handleClose();
        onImported?.();
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('importError')));
    } finally {
      setImportLoading(false);
    }
  };

  const canPreview =
    !!selectedModuleId && !!selectorValue && !!alias && ALIAS_REGEX.test(alias) && !previewLoading;

  // Available versions and environments from detail
  const versions = moduleDetail?.releases.map((r) => r.version) ?? [];
  const environments =
    moduleDetail?.environments.filter((e) => e.moduleReleaseId).map((e) => e.environment) ?? [];

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} maxWidth="lg">
      {/* Step 1: Select module, version, alias */}
      {step === 'select' && (
        <div className="space-y-4">
          {/* Module selector */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">{t('selectModule')}</label>
            {catalogLoading ? (
              <div className="flex items-center gap-2 p-3 text-sm text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('loadingCatalog')}
              </div>
            ) : (
              <Select
                value={selectedModuleId}
                onChange={(val) => {
                  setSelectedModuleId(val);
                  setSelectorValue('');
                }}
                placeholder={t('selectModulePlaceholder')}
                options={catalog.map((entry) => ({
                  value: entry.moduleProjectId,
                  label: entry.name + (entry.latestVersion ? ` (v${entry.latestVersion})` : ''),
                }))}
              />
            )}
          </div>

          {/* Version / Environment selector */}
          {selectedModuleId && !detailLoading && moduleDetail && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-foreground">
                {t('selectVersion')}
              </label>
              {/* Type toggle */}
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectorType('version');
                    setSelectorValue(versions[0] ?? '');
                  }}
                  className={clsx(
                    'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                    selectorType === 'version'
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-default bg-background-subtle text-muted hover:border-muted',
                  )}
                >
                  {t('selectorVersion')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectorType('environment');
                    setSelectorValue(environments[0] ?? '');
                  }}
                  className={clsx(
                    'px-3 py-1.5 text-xs font-medium rounded-lg border transition-default',
                    selectorType === 'environment'
                      ? 'border-accent bg-accent-subtle text-accent'
                      : 'border-default bg-background-subtle text-muted hover:border-muted',
                  )}
                >
                  {t('selectorEnvironment')}
                </button>
              </div>
              {/* Value dropdown */}
              <Select
                value={selectorValue}
                onChange={(val) => setSelectorValue(val)}
                placeholder={
                  selectorType === 'version'
                    ? t('selectVersionPlaceholder')
                    : t('selectEnvironmentPlaceholder')
                }
                options={(selectorType === 'version' ? versions : environments).map((val) => ({
                  value: val,
                  label: selectorType === 'version' ? `v${val}` : val,
                }))}
              />
            </div>
          )}

          {/* Loading detail */}
          {selectedModuleId && detailLoading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('loadingDetails')}
            </div>
          )}

          {/* Alias input */}
          <Input
            label={t('alias')}
            value={alias}
            onChange={(e) => {
              setAlias(e.target.value);
              setAliasTouched(true);
            }}
            placeholder={t('aliasPlaceholder')}
            error={aliasError}
          />
          <p className="text-xs text-muted -mt-2">{t('aliasHelp')}</p>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={handleClose}>
              {t('cancel')}
            </Button>
            <Button
              icon={<Package className="w-4 h-4" />}
              loading={previewLoading}
              disabled={!canPreview}
              onClick={handlePreview}
            >
              {t('preview')}
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Review preview and confirm import */}
      {step === 'review' && preview && (
        <div className="space-y-5">
          {/* Resolved version badge */}
          <div className="flex items-center gap-2">
            <Badge variant="info">v{preview.resolvedVersion}</Badge>
            <span className="text-sm text-muted">{t('resolvedAs', { alias })}</span>
          </div>

          {/* Mounted symbols */}
          <div>
            <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
              {t('mountedSymbols')}
            </h3>
            <div className="space-y-1">
              {preview.mountedSymbols.agents.map((name) => (
                <div
                  key={`agent-${name}`}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                >
                  <Bot className="w-3.5 h-3.5 text-accent" />
                  <span className="text-sm text-foreground">{name}</span>
                  <Badge variant="accent">{t('badgeAgent')}</Badge>
                </div>
              ))}
              {preview.mountedSymbols.tools.map((name) => (
                <div
                  key={`tool-${name}`}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-muted"
                >
                  <Wrench className="w-3.5 h-3.5 text-info" />
                  <span className="text-sm text-foreground">{name}</span>
                  <Badge variant="info">{t('badgeTool')}</Badge>
                </div>
              ))}
              {preview.mountedSymbols.agents.length === 0 &&
                preview.mountedSymbols.tools.length === 0 && (
                  <p className="text-sm text-muted">{t('noExportedSymbols')}</p>
                )}
            </div>
          </div>

          {/* Prerequisites */}
          {(preview.prerequisites.blocking.length > 0 ||
            preview.prerequisites.warnings.length > 0) && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('prerequisites')}
              </h3>
              {preview.prerequisites.blocking.length > 0 && (
                <div className="rounded-lg border border-error/30 bg-error-subtle/30 p-3 mb-2">
                  <div className="flex items-center gap-2 mb-1.5">
                    <AlertTriangle className="w-4 h-4 text-error" />
                    <span className="text-xs font-medium text-error">
                      {t('missingPrerequisites')}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {preview.prerequisites.blocking.map((msg, i) => (
                      <li key={i} className="text-xs text-error">
                        {msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.prerequisites.warnings.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
                  <ul className="space-y-0.5">
                    {preview.prerequisites.warnings.map((msg, i) => (
                      <li key={i} className="text-xs text-warning">
                        {msg}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Collisions */}
          {preview.collisions.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('collisions')}
              </h3>
              <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  <span className="text-xs font-medium text-warning">{t('collisionWarning')}</span>
                </div>
                <ul className="space-y-0.5">
                  {preview.collisions.map((c, i) => (
                    <li key={i} className="text-xs text-muted">
                      {t('collisionItem', {
                        mounted: c.mountedName,
                        conflicts: c.conflictsWith,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Config overrides */}
          {configOverrides.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-subtle uppercase tracking-wider mb-2">
                {t('configOverrides')}
              </h3>
              <div className="space-y-2">
                {configOverrides.map((entry, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={entry.key}
                      onChange={(e) => {
                        const updated = [...configOverrides];
                        updated[i] = { ...entry, key: e.target.value };
                        setConfigOverrides(updated);
                      }}
                      placeholder={t('configKeyPlaceholder')}
                      className="flex-1"
                    />
                    <Input
                      value={entry.value}
                      onChange={(e) => {
                        const updated = [...configOverrides];
                        updated[i] = { ...entry, value: e.target.value };
                        setConfigOverrides(updated);
                      }}
                      placeholder={t('configValuePlaceholder')}
                      className="flex-1"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setConfigOverrides(configOverrides.filter((_, idx) => idx !== i))
                      }
                      className="p-1.5 text-muted hover:text-error transition-default"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setConfigOverrides([...configOverrides, { key: '', value: '' }])}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-default"
                >
                  <Plus className="w-3 h-3" />
                  {t('addOverride')}
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-between pt-2">
            <Button
              variant="ghost"
              onClick={() => {
                setStep('select');
                setPreview(null);
                setImportPreview(null);
              }}
            >
              {t('back')}
            </Button>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={handleClose}>
                {t('cancel')}
              </Button>
              <Button
                icon={<CheckCircle2 className="w-4 h-4" />}
                loading={importLoading}
                disabled={hasBlockingPrereqs}
                onClick={handleImport}
              >
                {t('importButton')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
