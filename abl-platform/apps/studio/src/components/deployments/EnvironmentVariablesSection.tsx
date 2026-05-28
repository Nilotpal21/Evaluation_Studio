/**
 * EnvironmentVariablesSection Component
 *
 * Collapsible section showing per-environment key-value variables.
 * Supports add, edit (inline), delete, copy between environments,
 * namespace filtering/assignment, and search.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Copy,
  Trash2,
  Eye,
  EyeOff,
  Pencil,
  Check,
  X,
  Lock,
  Search,
  Settings2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Checkbox } from '../ui/Checkbox';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { CopyVariablesDialog } from './CopyVariablesDialog';
import { VariableNamespaceDropdown } from '../variables/VariableNamespaceDropdown';
import { VariableNamespaceTagPopover } from '../variables/VariableNamespaceTagPopover';
import { ManageVariableNamespacesPanel } from '../variables/ManageVariableNamespacesPanel';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  fetchEnvironmentVariables,
  createEnvironmentVariable,
  getEnvironmentVariableValue,
  updateEnvironmentVariable,
  deleteEnvironmentVariable,
  type EnvironmentVariable,
} from '../../api/environment-variables';
import { fetchVariableNamespaces, type VariableNamespace } from '../../api/variable-namespaces';

/** Must start with a letter, then letters/digits/underscores only */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

interface EnvironmentVariablesSectionProps {
  projectId: string;
  environment: string;
}

export function EnvironmentVariablesSection({
  projectId,
  environment,
}: EnvironmentVariablesSectionProps) {
  const t = useTranslations('deployments.env_vars');
  const [expanded, setExpanded] = useState(false);
  const [variables, setVariables] = useState<EnvironmentVariable[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Add row state
  const [showAddRow, setShowAddRow] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newIsSecret, setNewIsSecret] = useState(false);
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Reveal state
  const [revealedValues, setRevealedValues] = useState<Map<string, string>>(new Map());
  const [revealingId, setRevealingId] = useState<string | null>(null);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<EnvironmentVariable | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Copy dialog
  const [showCopyDialog, setShowCopyDialog] = useState(false);

  // Namespace state
  const [namespaces, setNamespaces] = useState<VariableNamespace[]>([]);
  const [selectedNamespaceId, setSelectedNamespaceId] = useState<string | null>(null);
  const [showManageNamespaces, setShowManageNamespaces] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  const loadNamespaces = useCallback(async () => {
    try {
      const data = await fetchVariableNamespaces(projectId);
      setNamespaces(data.namespaces || []);
    } catch {
      // Namespaces are optional
    }
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchEnvironmentVariables(projectId, environment, {
        namespaceId: selectedNamespaceId || undefined,
      });
      setVariables(data.variables);
      setRevealedValues(new Map());
      setLoaded(true);
    } catch {
      toast.error(t('load_failed'));
    } finally {
      setLoading(false);
    }
  }, [projectId, environment, selectedNamespaceId]);

  useEffect(() => {
    if (expanded && !loaded) {
      load();
      loadNamespaces();
    }
  }, [expanded, loaded, load, loadNamespaces]);

  // Reload when namespace filter changes
  useEffect(() => {
    if (expanded && loaded) {
      load();
    }
  }, [selectedNamespaceId]);

  // Client-side search filter
  const filteredVariables = useMemo(() => {
    if (!searchQuery.trim()) return variables;
    const q = searchQuery.trim().toLowerCase();
    return variables.filter((v) => v.key.toLowerCase().includes(q));
  }, [variables, searchQuery]);

  const handleAdd = async () => {
    const trimmedKey = newKey.trim().toUpperCase();
    if (!trimmedKey || !newValue.trim()) return;
    if (!KEY_PATTERN.test(trimmedKey)) {
      toast.error(t('key_validation_error'));
      return;
    }
    setAdding(true);
    try {
      await createEnvironmentVariable(projectId, {
        environment,
        key: trimmedKey,
        value: newValue,
        isSecret: newIsSecret,
      });
      toast.success(t('variable_created', { key: newKey }));
      setNewKey('');
      setNewValue('');
      setNewIsSecret(false);
      setShowAddRow(false);
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('create_failed')));
    } finally {
      setAdding(false);
    }
  };

  const handleReveal = async (variable: EnvironmentVariable) => {
    if (revealedValues.has(variable.id)) {
      setRevealedValues((prev) => {
        const next = new Map(prev);
        next.delete(variable.id);
        return next;
      });
      return;
    }

    setRevealingId(variable.id);
    try {
      const data = await getEnvironmentVariableValue(projectId, variable.id);
      setRevealedValues((prev) => new Map(prev).set(variable.id, data.variable.value));
    } catch {
      toast.error(t('reveal_failed'));
    } finally {
      setRevealingId(null);
    }
  };

  const startEdit = async (variable: EnvironmentVariable) => {
    setEditingId(variable.id);
    // Load current value if not revealed
    if (revealedValues.has(variable.id)) {
      setEditValue(revealedValues.get(variable.id) || '');
    } else {
      try {
        const data = await getEnvironmentVariableValue(projectId, variable.id);
        setEditValue(data.variable.value);
      } catch {
        toast.error(t('edit_load_failed'));
        setEditingId(null);
      }
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await updateEnvironmentVariable(projectId, editingId, { value: editValue });
      toast.success(t('variable_updated'));
      setEditingId(null);
      setEditValue('');
      // Clear revealed value for this var since it changed
      setRevealedValues((prev) => {
        const next = new Map(prev);
        next.delete(editingId);
        return next;
      });
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('update_failed')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteEnvironmentVariable(projectId, deleteTarget.id);
      toast.success(t('variable_deleted', { key: deleteTarget.key }));
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mt-3">
      {/* Header toggle */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        className="flex items-center gap-2 text-sm text-muted hover:text-foreground transition-default w-full cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <span className="font-medium">{t('variables_label')}</span>
        {loaded && <Badge variant="default">{variables.length}</Badge>}
        <div className="flex-1" />
        {expanded && (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy className="w-3.5 h-3.5" />}
              onClick={() => setShowCopyDialog(true)}
            >
              {t('copy_from')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowAddRow(true)}
            >
              {t('add')}
            </Button>
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2">
          {/* Namespace + Search toolbar */}
          <div className="flex items-center gap-2 mb-2">
            {namespaces.length > 0 && (
              <VariableNamespaceDropdown
                namespaces={namespaces}
                selected={selectedNamespaceId}
                onSelect={setSelectedNamespaceId}
                totalCount={variables.length}
              />
            )}
            <div className="relative flex-1 max-w-[200px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter keys..."
                className="w-full pl-7 pr-2 py-1 text-xs rounded-md border border-default bg-background-subtle text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
              />
            </div>
            <div className="flex-1" />
            <button
              onClick={() => setShowManageNamespaces(true)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium text-muted border border-default bg-background-subtle hover:text-foreground hover:border-border-hover hover:bg-background-muted transition-default"
            >
              <Settings2 className="w-3 h-3" />
              Namespaces
            </button>
          </div>

          {loading && !loaded ? (
            <div className="py-4 text-center text-muted text-sm">{t('loading')}</div>
          ) : filteredVariables.length === 0 && !showAddRow ? (
            <div className="py-4 text-center text-muted text-sm">
              {searchQuery.trim() ? 'No matching variables' : t('no_variables')}
            </div>
          ) : (
            <div className="border border-default rounded-lg overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_2fr_auto] gap-3 px-4 py-2 bg-background-muted border-b border-default text-xs font-medium text-muted uppercase tracking-wider">
                <span>{t('key_column')}</span>
                <span>{t('value_column')}</span>
                <span className="w-24 text-right">{t('actions_column')}</span>
              </div>

              {/* Variable rows */}
              {filteredVariables.map((v) => (
                <div
                  key={v.id}
                  className="grid grid-cols-[1fr_2fr_auto] gap-3 items-center px-4 py-2.5 border-b border-default last:border-0 hover:bg-background-muted/30 transition-default"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-mono text-foreground truncate">{v.key}</span>
                    {v.isSecret && <Lock className="w-3 h-3 text-muted shrink-0" />}
                    {namespaces.length > 0 && (
                      <VariableNamespaceTagPopover
                        projectId={projectId}
                        variableId={v.id}
                        variableType="env"
                        namespaces={namespaces}
                        assignedVariableNamespaceIds={v.variableNamespaceIds || []}
                        onUpdated={() => {
                          load();
                          loadNamespaces();
                        }}
                      />
                    )}
                  </div>

                  {editingId === v.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="flex-1 text-sm font-mono bg-background-subtle border border-default rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-border-focus focus:border-border-focus"
                        autoFocus
                      />
                      <button
                        onClick={handleSaveEdit}
                        disabled={saving}
                        className="p-1 text-success hover:bg-success/10 rounded"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(null);
                          setEditValue('');
                        }}
                        className="p-1 text-muted hover:bg-background-muted rounded"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm font-mono text-muted truncate">
                      {revealedValues.has(v.id) ? revealedValues.get(v.id) : '••••••••'}
                    </span>
                  )}

                  <div className="flex items-center gap-1 w-24 justify-end">
                    <button
                      onClick={() => handleReveal(v)}
                      disabled={revealingId === v.id}
                      className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
                      title={revealedValues.has(v.id) ? t('hide_value') : t('reveal_value')}
                    >
                      {revealedValues.has(v.id) ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => startEdit(v)}
                      className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
                      title={t('edit_value')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(v)}
                      className="p-1 text-muted hover:text-error hover:bg-error/10 rounded transition-default"
                      title={t('delete_variable')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}

              {/* Add row */}
              {showAddRow &&
                (() => {
                  const keyInvalid = newKey.length > 0 && !KEY_PATTERN.test(newKey.trim());
                  return (
                    <div className="border-t border-default bg-background-muted/20">
                      <div className="grid grid-cols-[1fr_2fr_auto] gap-3 items-center px-4 py-2.5">
                        <input
                          type="text"
                          value={newKey}
                          onChange={(e) =>
                            setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
                          }
                          placeholder="KEY_NAME"
                          className={`text-sm font-mono bg-background-subtle border rounded px-2 py-1 text-foreground placeholder:text-subtle focus:outline-none focus:ring-1 ${keyInvalid ? 'border-error focus:border-error focus:ring-error' : 'border-default focus:ring-border-focus focus:border-border-focus'}`}
                          autoFocus
                        />
                        <div className="flex items-center gap-2">
                          <input
                            type={newIsSecret ? 'password' : 'text'}
                            value={newValue}
                            onChange={(e) => setNewValue(e.target.value)}
                            placeholder="value"
                            className="flex-1 text-sm font-mono bg-background-subtle border border-default rounded px-2 py-1 text-foreground placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-border-focus focus:border-border-focus"
                          />
                          <Checkbox
                            checked={newIsSecret}
                            onChange={setNewIsSecret}
                            label={t('secret_label')}
                          />
                        </div>
                        <div className="flex items-center gap-1 w-24 justify-end">
                          <button
                            onClick={handleAdd}
                            disabled={adding || !newKey.trim() || !newValue.trim() || keyInvalid}
                            className="p-1 text-success hover:bg-success/10 rounded disabled:opacity-50"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              setShowAddRow(false);
                              setNewKey('');
                              setNewValue('');
                              setNewIsSecret(false);
                            }}
                            className="p-1 text-muted hover:bg-background-muted rounded"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {keyInvalid && (
                        <div className="px-4 pb-2 text-xs text-error">{t('key_format_hint')}</div>
                      )}
                    </div>
                  );
                })()}
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('delete_dialog_title')}
        description={t('delete_dialog_description', {
          key: deleteTarget?.key ?? '',
          environment: environment,
        })}
        confirmLabel={t('delete_dialog_title')}
        variant="danger"
        loading={deleting}
      />

      {/* Copy dialog */}
      <CopyVariablesDialog
        open={showCopyDialog}
        onClose={() => setShowCopyDialog(false)}
        projectId={projectId}
        targetEnvironment={environment}
        onCopied={load}
      />

      {/* Manage variable namespaces panel */}
      <ManageVariableNamespacesPanel
        open={showManageNamespaces}
        onClose={() => setShowManageNamespaces(false)}
        projectId={projectId}
        onNamespacesChanged={() => {
          loadNamespaces();
          load();
        }}
      />
    </div>
  );
}
