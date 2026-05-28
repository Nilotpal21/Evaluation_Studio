/**
 * EnvVarsPage Component
 *
 * Workspace-level admin page for managing environment variables.
 * Uses per-environment tabs with direct runtime API for full CRUD,
 * value reveal, inline edit, namespace tagging, and bulk import.
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Variable,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  Upload,
  Download,
  RefreshCw,
  Settings2,
  Search,
  Eye,
  EyeOff,
  ArrowLeftRight,
  Layers,
  Info,
} from 'lucide-react';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { toast } from 'sonner';
import { useProjectStore } from '../../store/project-store';
import { VariableNamespaceDropdown } from '../variables/VariableNamespaceDropdown';
import { VariableNamespaceTagPopover } from '../variables/VariableNamespaceTagPopover';
import { ManageVariableNamespacesPanel } from '../variables/ManageVariableNamespacesPanel';
import {
  fetchEnvironmentVariables,
  createEnvironmentVariable,
  getEnvironmentVariableValue,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  exportEnvironmentVariables,
  importEnvironmentVariables,
  diffEnvironmentVariables,
  type EnvironmentVariable,
  type ExportedVariable,
} from '../../api/environment-variables';
import { fetchVariableNamespaces, type VariableNamespace } from '../../api/variable-namespaces';

// =============================================================================
// CONSTANTS
// =============================================================================

const ENV_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENVIRONMENTS = ['dev', 'staging', 'production'] as const;
type ActiveTab = 'global' | 'dev' | 'staging' | 'production';

function validateKey(key: string): string | null {
  if (!key.trim()) return 'Key is required';
  if (!ENV_KEY_PATTERN.test(key)) {
    return 'Must start with a letter and contain only letters, numbers, and underscores';
  }
  return null;
}

// =============================================================================
// CREATE DIALOG
// =============================================================================

interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  environment: string;
  onCreated: () => void;
  /** Pre-filled key when overriding a global variable */
  overrideKey?: string | null;
}

function CreateEnvVarDialog({
  open,
  onClose,
  projectId,
  environment,
  onCreated,
  overrideKey,
}: CreateDialogProps) {
  const t = useTranslations('admin');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [applyToAll, setApplyToAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(true);

  const isOverride = !!overrideKey;

  useEffect(() => {
    if (open) {
      setKey(overrideKey || '');
      setValue('');
      setDescription('');
      setIsSecret(false);
      setApplyToAll(false);
      setKeyError(null);
      setShowValue(true);
    }
  }, [open, overrideKey]);

  const handleSubmit = async () => {
    const err = validateKey(key);
    if (err) {
      setKeyError(err);
      return;
    }
    if (!value.trim()) {
      toast.error('Value is required');
      return;
    }
    setKeyError(null);
    setSaving(true);
    try {
      const envs: string[] = applyToAll ? [...ENVIRONMENTS] : [environment];
      let created = 0;
      const errors: string[] = [];

      for (const env of envs) {
        try {
          await createEnvironmentVariable(projectId, {
            environment: env,
            key: key.trim().toUpperCase(),
            value: value,
            isSecret,
            description: description.trim() || undefined,
          });
          created++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes('409') && !msg.includes('already exists')) {
            errors.push(`${env}: ${msg}`);
          }
        }
      }

      if (created > 0) {
        toast.success(
          applyToAll
            ? `Created in ${created} environment${created > 1 ? 's' : ''}`
            : t('env_vars.deleted').replace('deleted', 'created'),
        );
        onCreated();
        onClose();
      } else if (errors.length > 0) {
        toast.error(errors[0]);
      } else {
        toast.error('Variable already exists in selected environments');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('env_vars.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm">
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            {isOverride ? `Override ${overrideKey}` : t('env_vars.create_title')}
          </h3>
          <p className="text-xs text-muted mt-1">
            {isOverride ? (
              <>
                Provide a <Badge variant="info">{environment}</Badge>-specific value for{' '}
                <code className="text-xs font-mono bg-background-muted px-1 py-0.5 rounded">
                  {overrideKey}
                </code>
                . This will take priority over the global value in this environment.
              </>
            ) : environment === 'global' ? (
              <>
                Creating a <Badge variant="info">Global</Badge> variable — it will be available in
                all environments unless overridden.
              </>
            ) : (
              <>
                Creating for <Badge variant="info">{environment}</Badge> — this value applies only
                to this environment.
              </>
            )}
          </p>
        </div>

        <div className="space-y-4">
          <Input
            label={t('env_vars.key_label')}
            placeholder={t('env_vars.key_placeholder')}
            value={key}
            onChange={(e) => {
              if (!isOverride) {
                setKey(e.target.value.toUpperCase());
                setKeyError(null);
              }
            }}
            error={keyError || undefined}
            disabled={isOverride}
          />

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">
              {t('env_vars.value_label')}
            </label>
            <div className="relative">
              <input
                type={showValue && !isSecret ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t('env_vars.value_placeholder')}
                className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 pr-10 font-mono transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
              <button
                type="button"
                onClick={() => setShowValue(!showValue)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground transition-default"
              >
                {showValue && !isSecret ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <Input
            label={t('env_vars.description_label')}
            placeholder={t('env_vars.description_placeholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isSecret}
                onChange={(e) => setIsSecret(e.target.checked)}
                className="rounded border-default text-accent focus:ring-border-focus"
              />
              <span className="text-sm text-foreground">{t('env_vars.encrypt_value')}</span>
            </label>

            {environment !== 'global' && !isOverride && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                  className="rounded border-default text-accent focus:ring-border-focus"
                />
                <span className="text-sm text-foreground">{t('env_vars.create_all_envs')}</span>
              </label>
            )}
          </div>
        </div>

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('env_vars.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={!key.trim() || !value.trim()}
            className="flex-1"
          >
            {t('env_vars.create')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// EDIT DIALOG
// =============================================================================

interface EditDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  variable: EnvironmentVariable;
  onUpdated: () => void;
}

function EditEnvVarDialog({ open, onClose, projectId, variable, onUpdated }: EditDialogProps) {
  const t = useTranslations('admin');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState(variable.description || '');
  const [isSecret, setIsSecret] = useState(variable.isSecret);
  const [saving, setSaving] = useState(false);
  const [loadingValue, setLoadingValue] = useState(true);
  const [showValue, setShowValue] = useState(false);

  useEffect(() => {
    if (open) {
      setDescription(variable.description || '');
      setIsSecret(variable.isSecret);
      setShowValue(false);
      setLoadingValue(true);
      // Load the current decrypted value
      getEnvironmentVariableValue(projectId, variable.id)
        .then((data) => {
          setValue(data.variable.value);
          setLoadingValue(false);
        })
        .catch(() => {
          setValue('');
          setLoadingValue(false);
          toast.error('Could not load current value');
        });
    }
  }, [open, variable.id, projectId]);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (value) updates.value = value;
      if (description !== (variable.description || '')) updates.description = description || null;
      if (isSecret !== variable.isSecret) updates.isSecret = isSecret;

      await updateEnvironmentVariable(projectId, variable.id, updates);
      toast.success(t('env_vars_extra.refresh_title').replace('Refresh', 'Variable updated'));
      onUpdated();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('env_vars.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm">
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{t('env_vars.edit_title')}</h3>
          <div className="flex items-center gap-2 mt-1">
            <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded font-mono text-foreground">
              {variable.key}
            </code>
            <Badge variant="info">{variable.environment}</Badge>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-foreground">
              {t('env_vars.value_label')}
            </label>
            {loadingValue ? (
              <div className="flex items-center gap-2 py-2 text-sm text-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('env_vars.loading_value')}
              </div>
            ) : (
              <div className="relative">
                <input
                  type={showValue ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t('env_vars.new_value_placeholder')}
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm py-2 px-3 pr-10 font-mono transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                />
                <button
                  type="button"
                  onClick={() => setShowValue(!showValue)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-foreground transition-default"
                >
                  {showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>

          <Input
            label={t('env_vars.description_label')}
            placeholder={t('env_vars.description_placeholder')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isSecret}
              onChange={(e) => setIsSecret(e.target.checked)}
              className="rounded border-default text-accent focus:ring-border-focus"
            />
            <span className="text-sm text-foreground">{t('env_vars.encrypt_value')}</span>
          </label>
        </div>

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('env_vars.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={loadingValue}
            className="flex-1"
          >
            {t('env_vars.update')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// EXPORT DIALOG
// =============================================================================

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  environment: string;
}

function ExportEnvVarsDialog({ open, onClose, projectId, environment }: ExportDialogProps) {
  const [exported, setExported] = useState<ExportedVariable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [format, setFormat] = useState<'json' | 'dotenv'>('json');

  useEffect(() => {
    if (open) {
      setLoading(true);
      setExported(null);
      exportEnvironmentVariables(projectId, environment)
        .then((data) => setExported(data.variables))
        .catch(() => toast.error('Failed to export variables'))
        .finally(() => setLoading(false));
    }
  }, [open, projectId, environment]);

  const exportText = useMemo(() => {
    if (!exported) return '';
    if (format === 'json') return JSON.stringify(exported, null, 2);
    return exported.map((v) => `${v.key}=${v.value}`).join('\n');
  }, [exported, format]);

  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(exportText).then(() => toast.success('Copied to clipboard'));
  };

  const handleDownload = () => {
    const ext = format === 'json' ? 'json' : 'env';
    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${environment}-variables.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${environment}-variables.${ext}`);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Export Variables</h3>
          <p className="text-sm text-muted mt-1">
            Exporting from <Badge variant="info">{environment}</Badge>
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setFormat('json')}
            className={`px-3 py-1 text-xs rounded-md border transition-default ${format === 'json' ? 'border-accent text-accent bg-accent-subtle' : 'border-default text-muted hover:text-foreground'}`}
          >
            JSON
          </button>
          <button
            onClick={() => setFormat('dotenv')}
            className={`px-3 py-1 text-xs rounded-md border transition-default ${format === 'dotenv' ? 'border-accent text-accent bg-accent-subtle' : 'border-default text-muted hover:text-foreground'}`}
          >
            .env
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        ) : (
          <textarea
            readOnly
            value={exportText}
            rows={12}
            className="w-full rounded-lg border border-default bg-background-muted text-foreground text-xs py-2 px-3 font-mono resize-none"
          />
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted">{exported?.length ?? 0} variables</span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopyToClipboard}
              disabled={!exported}
            >
              Copy to Clipboard
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleDownload}
              disabled={!exported}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              Download
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// JSON IMPORT DIALOG
// =============================================================================

interface JsonImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  environment: string;
  onImported: () => void;
}

function JsonImportDialog({
  open,
  onClose,
  projectId,
  environment,
  onImported,
}: JsonImportDialogProps) {
  const [text, setText] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setOverwrite(false);
      setParseError(null);
    }
  }, [open]);

  const handleImport = () => {
    let variables: Array<{ key: string; value: string; isSecret?: boolean; description?: string }>;
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        setParseError('Expected a JSON array of variables');
        return;
      }
      variables = parsed;
      for (const v of variables) {
        if (!v.key || typeof v.key !== 'string') {
          setParseError(`Missing or invalid "key" in entry: ${JSON.stringify(v)}`);
          return;
        }
        if (v.value === undefined || v.value === null) {
          setParseError(`Missing "value" for key "${v.key}"`);
          return;
        }
      }
    } catch {
      setParseError('Invalid JSON. Paste a JSON array like: [{"key":"MY_VAR","value":"..."}]');
      return;
    }

    setParseError(null);
    setImporting(true);
    importEnvironmentVariables(projectId, {
      environment,
      variables,
      overwrite,
    })
      .then((result) => {
        toast.success(
          `Imported ${result.imported}, skipped ${result.skipped}${result.errors.length > 0 ? `, ${result.errors.length} errors` : ''}`,
        );
        onImported();
        onClose();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Import failed'))
      .finally(() => setImporting(false));
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Import Variables (JSON)</h3>
          <p className="text-sm text-muted mt-1">
            Import into <Badge variant="info">{environment}</Badge>. Paste a JSON array exported
            from another environment.
          </p>
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setParseError(null);
          }}
          placeholder={`[\n  {"key": "API_KEY", "value": "sk-xxx", "isSecret": true},\n  {"key": "DB_URL", "value": "postgres://..."}\n]`}
          rows={10}
          className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-2 px-3 font-mono resize-none transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
        />
        {parseError && <p className="text-xs text-error">{parseError}</p>}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="rounded border-default text-accent focus:ring-border-focus"
          />
          <span className="text-sm text-foreground">Overwrite existing variables</span>
        </label>

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            loading={importing}
            disabled={!text.trim()}
            icon={<Upload className="w-3.5 h-3.5" />}
            className="flex-1"
          >
            Import
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// DIFF DIALOG
// =============================================================================

interface DiffDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

const DIFF_ENV_OPTIONS = [
  { value: 'global', label: 'Global' },
  { value: 'dev', label: 'Dev' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

function DiffEnvVarsDialog({ open, onClose, projectId }: DiffDialogProps) {
  const [source, setSource] = useState<string>('dev');
  const [target, setTarget] = useState<string>('staging');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    added: string[];
    removed: string[];
    changed: string[];
    unchanged: string[];
  } | null>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
    }
  }, [open]);

  const handleCompare = () => {
    if (source === target) {
      toast.error('Source and target must be different');
      return;
    }
    setLoading(true);
    setResult(null);
    diffEnvironmentVariables(projectId, source, target)
      .then((data) => setResult(data.diff))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Diff failed'))
      .finally(() => setLoading(false));
  };

  const envLabel = (val: string) => DIFF_ENV_OPTIONS.find((o) => o.value === val)?.label ?? val;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-foreground">Compare Environments</h3>

        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted mb-1">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-default bg-background-subtle text-foreground focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
            >
              {DIFF_ENV_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <ArrowLeftRight className="w-4 h-4 text-muted mt-4" />
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted mb-1">Target</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-default bg-background-subtle text-foreground focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
            >
              {DIFF_ENV_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleCompare}
            loading={loading}
            className="mt-4"
          >
            Compare
          </Button>
        </div>

        {result && (
          <div className="space-y-3 pt-2">
            {result.added.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-success mb-1">
                  + Added in {envLabel(target)} ({result.added.length})
                </h4>
                <div className="flex flex-wrap gap-1">
                  {result.added.map((k) => (
                    <code
                      key={k}
                      className="text-xs bg-success/10 text-success px-1.5 py-0.5 rounded font-mono"
                    >
                      {k}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {result.removed.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-error mb-1">
                  − Removed from {envLabel(target)} ({result.removed.length})
                </h4>
                <div className="flex flex-wrap gap-1">
                  {result.removed.map((k) => (
                    <code
                      key={k}
                      className="text-xs bg-error/10 text-error px-1.5 py-0.5 rounded font-mono"
                    >
                      {k}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {result.changed.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-warning mb-1">
                  ~ Changed ({result.changed.length})
                </h4>
                <div className="flex flex-wrap gap-1">
                  {result.changed.map((k) => (
                    <code
                      key={k}
                      className="text-xs bg-warning/10 text-warning px-1.5 py-0.5 rounded font-mono"
                    >
                      {k}
                    </code>
                  ))}
                </div>
              </div>
            )}
            {result.added.length === 0 &&
              result.removed.length === 0 &&
              result.changed.length === 0 && (
                <p className="text-sm text-muted text-center py-4">
                  Environments are identical ({result.unchanged.length} variables)
                </p>
              )}
            {(result.added.length > 0 || result.removed.length > 0 || result.changed.length > 0) &&
              result.unchanged.length > 0 && (
                <p className="text-xs text-muted">
                  {result.unchanged.length} unchanged variable
                  {result.unchanged.length !== 1 ? 's' : ''}
                </p>
              )}
          </div>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// VARIABLE ROW
// =============================================================================

interface VariableRowProps {
  variable: EnvironmentVariable;
  projectId: string;
  namespaces: VariableNamespace[];
  onEdit: (v: EnvironmentVariable) => void;
  onDelete: (v: EnvironmentVariable) => void;
  onNamespacesChanged: () => void;
  /** True when this row is a global variable shown in an env-specific tab */
  inherited?: boolean;
  /** Called when user wants to override an inherited global variable */
  onOverride?: (v: EnvironmentVariable) => void;
}

function VariableRow({
  variable,
  projectId,
  namespaces,
  onEdit,
  onDelete,
  onNamespacesChanged,
  inherited,
  onOverride,
}: VariableRowProps) {
  const [revealed, setRevealed] = useState(false);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  const handleReveal = async () => {
    if (revealed) {
      setRevealed(false);
      setRevealedValue(null);
      return;
    }
    setRevealing(true);
    try {
      const data = await getEnvironmentVariableValue(projectId, variable.id);
      setRevealedValue(data.variable.value);
      setRevealed(true);
    } catch {
      toast.error('Failed to reveal value');
    } finally {
      setRevealing(false);
    }
  };

  return (
    <tr className={`hover:bg-background-muted transition-default ${inherited ? 'opacity-60' : ''}`}>
      {/* Key */}
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded text-foreground font-mono">
            {variable.key}
          </code>
        </div>
      </td>

      {/* Value */}
      <td className="px-4 py-2.5 max-w-[240px]">
        {revealed && revealedValue !== null ? (
          <code className="text-xs font-mono text-foreground break-all line-clamp-2">
            {revealedValue}
          </code>
        ) : (
          <span className="text-xs text-muted font-mono">{'••••••••'}</span>
        )}
      </td>

      {/* Namespace */}
      <td className="px-4 py-2.5">
        {namespaces.length > 0 && (
          <VariableNamespaceTagPopover
            projectId={projectId}
            variableId={variable.id}
            variableType="env"
            namespaces={namespaces}
            assignedVariableNamespaceIds={variable.variableNamespaceIds || []}
            onUpdated={onNamespacesChanged}
          />
        )}
      </td>

      {/* Description */}
      <td className="px-4 py-2.5 text-muted text-xs max-w-[160px] truncate">
        {variable.description || '--'}
      </td>

      {/* Actions */}
      <td className="px-4 py-2.5">
        <div className="flex items-center justify-end gap-0.5">
          <button
            onClick={handleReveal}
            disabled={revealing}
            className="p-1.5 text-muted hover:text-foreground rounded transition-default"
            title={revealed ? 'Hide value' : 'Reveal value'}
          >
            {revealing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : revealed ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </button>
          {inherited ? (
            <button
              onClick={() => onOverride?.(variable)}
              className="p-1.5 text-muted hover:text-accent rounded transition-default"
              title="Override for this environment"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          ) : (
            <>
              <button
                onClick={() => onEdit(variable)}
                className="p-1.5 text-muted hover:text-accent rounded transition-default"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onDelete(variable)}
                className="p-1.5 text-muted hover:text-error rounded transition-default"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

const TAB_META: { key: ActiveTab; label: string; env: string; icon?: boolean }[] = [
  { key: 'global', label: 'Global', env: 'global', icon: true },
  { key: 'dev', label: 'Dev', env: 'dev' },
  { key: 'staging', label: 'Staging', env: 'staging' },
  { key: 'production', label: 'Production', env: 'production' },
];

export function EnvVarsPage() {
  const t = useTranslations('admin');
  const projects = useProjectStore((s) => s.projects);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projects[0]?.id || null,
  );
  const [activeTab, setActiveTab] = useState<ActiveTab>('global');

  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  // Data
  const [globalVars, setGlobalVars] = useState<EnvironmentVariable[]>([]);
  const [envVars, setEnvVars] = useState<Record<string, EnvironmentVariable[]>>({
    dev: [],
    staging: [],
    production: [],
  });
  const [isLoading, setIsLoading] = useState(false);

  // Namespace
  const [namespaces, setNamespaces] = useState<VariableNamespace[]>([]);
  const [selectedNamespaceId, setSelectedNamespaceId] = useState<string | null>(null);
  const [showManageNamespaces, setShowManageNamespaces] = useState(false);

  // Dialogs
  const [showCreate, setShowCreate] = useState(false);
  const [createEnv, setCreateEnv] = useState<string>('global');
  const [editTarget, setEditTarget] = useState<EnvironmentVariable | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EnvironmentVariable | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportEnv, setExportEnv] = useState<string>('global');
  const [showJsonImport, setShowJsonImport] = useState(false);
  const [importEnv, setImportEnv] = useState<string>('global');
  const [showDiff, setShowDiff] = useState(false);
  const [overrideKey, setOverrideKey] = useState<string | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  const loadAll = useCallback(async () => {
    if (!selectedProjectId) return;
    setIsLoading(true);
    try {
      const nsOpts = { namespaceId: selectedNamespaceId || undefined };
      const [baseData, devData, stagingData, prodData] = await Promise.all([
        fetchEnvironmentVariables(selectedProjectId, 'global', nsOpts),
        fetchEnvironmentVariables(selectedProjectId, 'dev', nsOpts),
        fetchEnvironmentVariables(selectedProjectId, 'staging', nsOpts),
        fetchEnvironmentVariables(selectedProjectId, 'production', nsOpts),
      ]);
      setGlobalVars(baseData.variables);
      setEnvVars({
        dev: devData.variables,
        staging: stagingData.variables,
        production: prodData.variables,
      });
    } catch {
      toast.error('Failed to load environment variables');
    } finally {
      setIsLoading(false);
    }
  }, [selectedProjectId, selectedNamespaceId]);

  const loadNamespaces = useCallback((pid: string) => {
    fetchVariableNamespaces(pid)
      .then((data) => setNamespaces(data.namespaces || []))
      .catch(() => setNamespaces([]));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setGlobalVars([]);
      setEnvVars({ dev: [], staging: [], production: [] });
      setNamespaces([]);
      setSelectedNamespaceId(null);
      return;
    }
    loadAll();
    loadNamespaces(selectedProjectId);
  }, [selectedProjectId, selectedNamespaceId]);

  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name || p.id })),
    [projects],
  );

  const filterFn = useCallback(
    (v: EnvironmentVariable) => {
      const q = searchQuery.trim().toLowerCase();
      return (
        !q ||
        v.key.toLowerCase().includes(q) ||
        (v.description && v.description.toLowerCase().includes(q))
      );
    },
    [searchQuery],
  );

  const filteredGlobal = useMemo(() => globalVars.filter(filterFn), [globalVars, filterFn]);
  const filteredEnvVars = useMemo(
    () => ({
      dev: envVars.dev.filter(filterFn),
      staging: envVars.staging.filter(filterFn),
      production: envVars.production.filter(filterFn),
    }),
    [envVars, filterFn],
  );

  // For env tabs: compute inherited globals (globals not overridden in that env)
  const inheritedGlobals = useMemo(() => {
    const result: Record<string, EnvironmentVariable[]> = {};
    for (const env of ENVIRONMENTS) {
      const overriddenKeys = new Set(envVars[env].map((v) => v.key));
      result[env] = globalVars.filter((g) => !overriddenKeys.has(g.key) && filterFn(g));
    }
    return result;
  }, [globalVars, envVars, filterFn]);

  const handleDelete = async () => {
    if (!deleteTarget || !selectedProjectId) return;
    setIsDeleting(true);
    try {
      await deleteEnvironmentVariable(selectedProjectId, deleteTarget.id);
      toast.success(t('env_vars.deleted'));
      setDeleteTarget(null);
      loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('env_vars.delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRefresh = () => {
    loadAll();
    if (selectedProjectId) loadNamespaces(selectedProjectId);
  };

  const openCreate = (env: string, prefillKey?: string) => {
    setCreateEnv(env);
    setOverrideKey(prefillKey || null);
    setShowCreate(true);
  };

  // Tab count helper
  const tabCount = (tab: ActiveTab): number => {
    if (tab === 'global') return globalVars.length;
    return envVars[tab].length;
  };

  // Column count for section divider rows
  const colCount = 4 + (namespaces.length > 0 ? 1 : 0);

  // Shared table renderer — renders own vars + optional inherited globals in one table
  const renderTable = (
    ownVars: EnvironmentVariable[],
    inherited?: {
      vars: EnvironmentVariable[];
      onOverride: (v: EnvironmentVariable) => void;
    },
  ) => (
    <div className="rounded-xl border border-default overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-background-muted border-b border-default">
            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider">
              Key
            </th>
            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider">
              Value
            </th>
            {namespaces.length > 0 && (
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider">
                Namespace
              </th>
            )}
            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider">
              Description
            </th>
            <th className="text-right px-4 py-2.5 text-xs font-medium text-muted uppercase tracking-wider w-[120px]">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {ownVars.map((v) => (
            <VariableRow
              key={v.id}
              variable={v}
              projectId={selectedProjectId!}
              namespaces={namespaces}
              onEdit={setEditTarget}
              onDelete={setDeleteTarget}
              onNamespacesChanged={handleRefresh}
            />
          ))}
          {inherited && inherited.vars.length > 0 && (
            <>
              <tr className="bg-background-muted/60">
                <td colSpan={colCount} className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <Layers className="w-3 h-3 text-muted" />
                    <span className="text-xs font-medium text-muted">
                      Inherited from Global ({inherited.vars.length})
                    </span>
                  </div>
                </td>
              </tr>
              {inherited.vars.map((v) => (
                <VariableRow
                  key={v.id}
                  variable={v}
                  projectId={selectedProjectId!}
                  namespaces={namespaces}
                  onEdit={setEditTarget}
                  onDelete={setDeleteTarget}
                  onNamespacesChanged={handleRefresh}
                  inherited
                  onOverride={inherited.onOverride}
                />
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );

  // Render content for an environment tab (dev/staging/production)
  const renderEnvTab = (env: 'dev' | 'staging' | 'production') => {
    const ownVars = filteredEnvVars[env];
    const inherited = inheritedGlobals[env];
    const totalResolved = ownVars.length + inherited.length;

    return (
      <div className="space-y-4">
        {/* Hint */}
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-background-muted/50 border border-default/50">
          <Info className="w-3.5 h-3.5 text-muted mt-0.5 shrink-0" />
          <p className="text-xs text-muted">
            Showing variables resolved for{' '}
            <span className="font-medium text-foreground">{env}</span>. Environment-specific values
            override globals with the same key.
          </p>
        </div>

        {/* Actions row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground bg-background-muted px-2.5 py-1 rounded-md border border-default">
              {env.charAt(0).toUpperCase() + env.slice(1)}
              <span className="text-accent font-semibold">{ownVars.length}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted bg-background-muted/50 px-2.5 py-1 rounded-md border border-default/50">
              Inherited
              <span className="font-semibold">{inherited.length}</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setExportEnv(env);
                setShowExport(true);
              }}
              icon={<Upload className="w-3.5 h-3.5" />}
            >
              Export
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setImportEnv(env);
                setShowJsonImport(true);
              }}
              icon={<Download className="w-3.5 h-3.5" />}
            >
              Import
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => openCreate(env)}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              Add Variable
            </Button>
          </div>
        </div>

        {totalResolved === 0 ? (
          <EmptyState
            icon={<Variable className="w-6 h-6" />}
            title={`No variables for ${env}`}
            description={
              searchQuery.trim()
                ? `No variables match "${searchQuery}"`
                : `No variables defined for ${env} yet. Add one or create a global variable.`
            }
            action={
              !searchQuery.trim() ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={() => openCreate(env)}
                >
                  Add Variable
                </Button>
              ) : undefined
            }
          />
        ) : (
          renderTable(ownVars, {
            vars: inherited,
            onOverride: (v) => openCreate(env, v.key),
          })
        )}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader title={t('env_vars.title')} description={t('env_vars.description')} />

        {/* Project selector */}
        <div className="mt-6 max-w-xs">
          {projectOptions.length > 0 ? (
            <Select
              label={t('env_vars.project_label')}
              options={projectOptions}
              value={selectedProjectId || ''}
              onChange={(value) => setSelectedProjectId(value)}
            />
          ) : (
            <p className="text-sm text-muted">{t('env_vars.no_projects')}</p>
          )}
        </div>

        {selectedProjectId && (
          <>
            {/* ── Tabs ── */}
            <div className="mt-6 flex items-center gap-1 border-b border-default">
              {TAB_META.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    setActiveTab(tab.key);
                    setSearchQuery('');
                  }}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-default flex items-center gap-2 ${
                    activeTab === tab.key
                      ? 'border-accent text-accent'
                      : 'border-transparent text-muted hover:text-foreground hover:border-default'
                  }`}
                >
                  {tab.icon && <Layers className="w-3.5 h-3.5" />}
                  {tab.label}
                  <Badge variant="default">{tabCount(tab.key)}</Badge>
                </button>
              ))}
            </div>

            {/* ── Toolbar ── */}
            <div className="flex items-center gap-2 mt-4">
              {/* Left group: Search, Refresh, Diff */}
              <div className="relative max-w-[220px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter keys..."
                  className="w-full pl-8 pr-2.5 py-1.5 text-xs rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                />
              </div>
              <button
                onClick={handleRefresh}
                className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowDiff(true)}
                icon={<ArrowLeftRight className="w-3.5 h-3.5" />}
              >
                Diff
              </Button>

              <div className="flex-1" />

              {/* Right group: Manage Namespaces, Namespace filter */}
              <button
                onClick={() => setShowManageNamespaces(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-default bg-background-subtle hover:text-foreground hover:border-border-hover hover:bg-background-muted transition-default"
              >
                <Settings2 className="w-3.5 h-3.5" />
                Namespaces
              </button>
              {namespaces.length > 0 && (
                <VariableNamespaceDropdown
                  namespaces={namespaces}
                  selected={selectedNamespaceId}
                  onSelect={setSelectedNamespaceId}
                  totalCount={
                    globalVars.length +
                    envVars.dev.length +
                    envVars.staging.length +
                    envVars.production.length
                  }
                />
              )}
            </div>

            {/* ── Content ── */}
            <div className="mt-4">
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 text-muted animate-spin" />
                </div>
              ) : activeTab === 'global' ? (
                /* ── GLOBAL TAB ── */
                <div className="space-y-4">
                  {/* Hint */}
                  <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-background-muted/50 border border-default/50">
                    <Info className="w-3.5 h-3.5 text-muted mt-0.5 shrink-0" />
                    <p className="text-xs text-muted">
                      Global variables are available in{' '}
                      <span className="font-medium text-foreground">all environments</span>.
                      Environment-specific variables with the same key take priority.
                    </p>
                  </div>

                  {/* Actions row */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted">
                      {searchQuery.trim()
                        ? `${filteredGlobal.length} of ${globalVars.length} variables`
                        : `${globalVars.length} variable${globalVars.length !== 1 ? 's' : ''}`}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setExportEnv('global');
                          setShowExport(true);
                        }}
                        icon={<Upload className="w-3.5 h-3.5" />}
                      >
                        Export
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setImportEnv('global');
                          setShowJsonImport(true);
                        }}
                        icon={<Download className="w-3.5 h-3.5" />}
                      >
                        Import
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => openCreate('global')}
                        icon={<Plus className="w-3.5 h-3.5" />}
                      >
                        Add Variable
                      </Button>
                    </div>
                  </div>

                  {filteredGlobal.length === 0 ? (
                    <EmptyState
                      icon={<Variable className="w-6 h-6" />}
                      title="No global variables"
                      description={
                        searchQuery.trim()
                          ? `No variables match "${searchQuery}"`
                          : 'Global variables are shared across all environments. Add one to get started.'
                      }
                      action={
                        !searchQuery.trim() ? (
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<Plus className="w-3.5 h-3.5" />}
                            onClick={() => openCreate('global')}
                          >
                            Add Variable
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    renderTable(filteredGlobal)
                  )}
                </div>
              ) : (
                /* ── ENVIRONMENT TAB (dev / staging / production) ── */
                renderEnvTab(activeTab)
              )}
            </div>
          </>
        )}

        {/* ── Dialogs ── */}

        {showCreate && selectedProjectId && (
          <CreateEnvVarDialog
            open={showCreate}
            onClose={() => {
              setShowCreate(false);
              setOverrideKey(null);
            }}
            projectId={selectedProjectId}
            environment={createEnv}
            onCreated={loadAll}
            overrideKey={overrideKey}
          />
        )}

        {editTarget && selectedProjectId && (
          <EditEnvVarDialog
            open={!!editTarget}
            onClose={() => setEditTarget(null)}
            projectId={selectedProjectId}
            variable={editTarget}
            onUpdated={loadAll}
          />
        )}

        <ConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
          title={t('env_vars.delete_title')}
          description={t('env_vars.delete_description', { key: deleteTarget?.key ?? '' })}
          confirmLabel={t('env_vars.delete_confirm')}
          variant="danger"
          loading={isDeleting}
        />

        {showExport && selectedProjectId && (
          <ExportEnvVarsDialog
            open={showExport}
            onClose={() => setShowExport(false)}
            projectId={selectedProjectId}
            environment={exportEnv}
          />
        )}

        {showJsonImport && selectedProjectId && (
          <JsonImportDialog
            open={showJsonImport}
            onClose={() => setShowJsonImport(false)}
            projectId={selectedProjectId}
            environment={importEnv}
            onImported={loadAll}
          />
        )}

        {showDiff && selectedProjectId && (
          <DiffEnvVarsDialog
            open={showDiff}
            onClose={() => setShowDiff(false)}
            projectId={selectedProjectId}
          />
        )}

        {selectedProjectId && (
          <ManageVariableNamespacesPanel
            open={showManageNamespaces}
            onClose={() => setShowManageNamespaces(false)}
            projectId={selectedProjectId}
            onNamespacesChanged={handleRefresh}
          />
        )}
      </div>
    </div>
  );
}
