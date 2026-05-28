/**
 * ConfigVariablesTab Component
 *
 * Project-level config variables: list, add, edit inline, delete.
 * Config variables are resolved at compile time via {{config.KEY}} syntax.
 * Values are plaintext (not secrets).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Variable,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  AlertTriangle,
  Info,
  Settings2,
  Search,
} from 'lucide-react';
import clsx from 'clsx';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Button } from '../ui/Button';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { VariableNamespaceDropdown } from '../variables/VariableNamespaceDropdown';
import { VariableNamespaceTagPopover } from '../variables/VariableNamespaceTagPopover';
import { ManageVariableNamespacesPanel } from '../variables/ManageVariableNamespacesPanel';
import { fetchVariableNamespaces, type VariableNamespace } from '../../api/variable-namespaces';

interface ConfigVariable {
  id: string;
  key: string;
  value: string;
  description: string | null;
  variableNamespaceIds?: string[];
  createdAt: string;
  updatedAt: string;
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function ConfigVariablesTab() {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { projectId } = useNavigationStore();
  const [variables, setVariables] = useState<ConfigVariable[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConfigVariable | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Add form state
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [addError, setAddError] = useState('');

  // Edit form state
  const [editValue, setEditValue] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  // Namespace state
  const [namespaces, setNamespaces] = useState<VariableNamespace[]>([]);
  const [selectedVariableNamespaceId, setSelectedVariableNamespaceId] = useState<string | null>(
    null,
  );
  const [showManageVariableNamespaces, setShowManageVariableNamespaces] = useState(false);

  const loadVariableNamespaces = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await fetchVariableNamespaces(projectId);
      setNamespaces(data.namespaces || []);
    } catch {
      // Namespace loading is optional
    }
  }, [projectId]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const nsParam = selectedVariableNamespaceId
        ? `?namespaceId=${selectedVariableNamespaceId}`
        : '';
      const res = await apiFetch(`/api/projects/${projectId}/config-variables${nsParam}`);
      const data = await res.json();
      setVariables(data.variables || []);
    } catch {
      toast.error(t('config_variables.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, selectedVariableNamespaceId]);

  useEffect(() => {
    load();
    loadVariableNamespaces();
  }, [load, loadVariableNamespaces]);

  // Reload when namespace filter changes
  useEffect(() => {
    if (!isLoading) load();
  }, [selectedVariableNamespaceId]);

  // Client-side search filter
  const filteredVariables = useMemo(() => {
    if (!searchQuery.trim()) return variables;
    const q = searchQuery.trim().toLowerCase();
    return variables.filter(
      (v) =>
        v.key.toLowerCase().includes(q) ||
        (v.description && v.description.toLowerCase().includes(q)),
    );
  }, [variables, searchQuery]);

  const handleStartAdd = () => {
    setIsAdding(true);
    setNewKey('');
    setNewValue('');
    setNewDescription('');
    setAddError('');
  };

  const handleCancelAdd = () => {
    setIsAdding(false);
    setAddError('');
  };

  const handleConfirmAdd = async () => {
    const key = newKey.trim().toUpperCase();
    if (!key) {
      setAddError(t('config_variables.key_required'));
      return;
    }
    if (!KEY_PATTERN.test(key)) {
      setAddError(t('config_variables.key_format_error'));
      return;
    }
    if (variables.some((v) => v.key === key)) {
      setAddError(t('config_variables.key_duplicate', { key }));
      return;
    }

    try {
      const res = await apiFetch(`/api/projects/${projectId}/config-variables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          value: newValue,
          description: newDescription || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || t('config_variables.create_failed'));
        return;
      }
      setVariables((prev) => [...prev, data.variable].sort((a, b) => a.key.localeCompare(b.key)));
      setIsAdding(false);
      toast.success(t('config_variables.created', { key }));
    } catch (err) {
      setAddError(sanitizeError(err, t('config_variables.create_failed')));
    }
  };

  const handleStartEdit = (variable: ConfigVariable) => {
    setEditingId(variable.id);
    setEditValue(variable.value);
    setEditDescription(variable.description || '');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  const handleConfirmEdit = async (id: string) => {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/config-variables/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: editValue,
          description: editDescription || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('config_variables.update_failed'));
        return;
      }
      setVariables((prev) => prev.map((v) => (v.id === id ? data.variable : v)));
      setEditingId(null);
      toast.success(t('config_variables.updated'));
    } catch (err) {
      toast.error(sanitizeError(err, t('config_variables.update_failed')));
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/api/projects/${projectId}/config-variables/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      setVariables((prev) => prev.filter((v) => v.id !== deleteTarget.id));
      toast.success(t('config_variables.deleted', { key: deleteTarget.key }));
    } catch (err) {
      toast.error(sanitizeError(err, t('config_variables.delete_failed')));
    } finally {
      setDeleteLoading(false);
      setDeleteTarget(null);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  const isEmptyStateShown = filteredVariables.length === 0 && !isAdding;

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('config_variables.page_title')}
        </h2>
        <p className="text-sm text-muted mt-1">{t('config_variables.page_description')}</p>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-3 rounded-lg bg-info-subtle border border-info/20">
        <Info className="w-4 h-4 text-info mt-0.5 shrink-0" />
        <p className="text-sm text-foreground">
          {t.rich('config_variables.info_text', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}{' '}
          <code className="px-1 py-0.5 rounded bg-background-muted font-mono text-xs">
            {t('config_variables.info_syntax')}
          </code>{' '}
        </p>
      </div>

      {/* Namespace + Search toolbar */}
      <div className="flex items-center gap-2">
        {namespaces.length > 0 && (
          <VariableNamespaceDropdown
            namespaces={namespaces}
            selected={selectedVariableNamespaceId}
            onSelect={setSelectedVariableNamespaceId}
            totalCount={variables.length}
          />
        )}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('config_vars.filter_placeholder')}
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
          />
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowManageVariableNamespaces(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-default bg-background-subtle hover:text-foreground hover:border-border-hover hover:bg-background-muted transition-default"
        >
          <Settings2 className="w-3.5 h-3.5" />
          Namespaces
        </button>
      </div>

      {/* Header with count and add button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {searchQuery.trim()
            ? `${filteredVariables.length} of ${variables.length} variables`
            : t('config_variables.count', { count: variables.length })}
        </p>
        {!isEmptyStateShown && (
          <Button
            onClick={handleStartAdd}
            disabled={isAdding}
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            {t('config_variables.add_variable')}
          </Button>
        )}
      </div>

      {isEmptyStateShown ? (
        <EmptyState
          icon={<Variable className="w-6 h-6" />}
          title={searchQuery.trim() ? 'No matching variables' : t('config_variables.empty')}
          description={
            searchQuery.trim()
              ? 'Try a different search term'
              : t('config_variables.empty_description')
          }
          action={
            !searchQuery.trim() ? (
              <Button
                onClick={handleStartAdd}
                variant="primary"
                icon={<Plus className="w-3.5 h-3.5" />}
              >
                {t('config_variables.add_variable')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="border border-default rounded-lg overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[160px_1fr_140px_1fr_80px] gap-4 px-4 py-2.5 bg-background-muted border-b border-default">
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('config_variables.key_header')}
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('config_variables.value_header')}
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              Namespaces
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('config_variables.description_header')}
            </span>
            <span className="text-xs font-medium text-muted uppercase tracking-wide text-right">
              {t('config_variables.actions_header')}
            </span>
          </div>

          {/* Variable rows */}
          {filteredVariables.map((variable) => (
            <div
              key={variable.id}
              className="grid grid-cols-[160px_1fr_140px_1fr_80px] gap-4 px-4 py-3 border-b border-default last:border-b-0 items-center"
            >
              <span className="text-sm font-mono text-foreground truncate" title={variable.key}>
                {variable.key}
              </span>

              {editingId === variable.id ? (
                <>
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full rounded border border-default bg-background-subtle text-foreground text-sm font-mono px-2 py-1 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    autoFocus
                  />
                  <div />
                  <input
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder={t('config_variables.description_placeholder')}
                    className="w-full rounded border border-default bg-background-subtle text-foreground text-sm px-2 py-1 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                  />
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleConfirmEdit(variable.id)}
                      className="p-1.5 text-success hover:bg-success-subtle rounded transition-default"
                      title={tCommon('save')}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                      title={tCommon('cancel')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span
                    className="text-sm font-mono text-foreground truncate"
                    title={variable.value}
                  >
                    {variable.value}
                  </span>
                  <div className="min-w-0">
                    {namespaces.length > 0 && projectId ? (
                      <VariableNamespaceTagPopover
                        projectId={projectId}
                        variableId={variable.id}
                        variableType="config"
                        namespaces={namespaces}
                        assignedVariableNamespaceIds={variable.variableNamespaceIds || []}
                        onUpdated={() => {
                          load();
                          loadVariableNamespaces();
                        }}
                      />
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </div>
                  <span className="text-xs text-muted truncate" title={variable.description || ''}>
                    {variable.description || '—'}
                  </span>
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleStartEdit(variable)}
                      className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                      title={tCommon('edit')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(variable)}
                      className="p-1.5 text-muted hover:text-error rounded transition-default"
                      title={tCommon('delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}

          {/* Inline add row */}
          {isAdding && (
            <div className="grid grid-cols-[160px_1fr_140px_1fr_80px] gap-4 px-4 py-3 border-t border-default bg-background-subtle">
              <div>
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => {
                    setNewKey(e.target.value.toUpperCase());
                    setAddError('');
                  }}
                  placeholder={t('config_variables.key_placeholder')}
                  className={clsx(
                    'w-full rounded border bg-background text-foreground text-sm font-mono px-2 py-1 focus:outline-none focus:ring-1',
                    addError
                      ? 'border-error focus:border-error focus:ring-error'
                      : 'border-default focus:border-border-focus focus:ring-border-focus',
                  )}
                  autoFocus
                />
                {addError && (
                  <p className="text-xs text-error mt-1 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {addError}
                  </p>
                )}
              </div>
              <input
                type="text"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={t('config_variables.value_label')}
                className="w-full rounded border border-default bg-background text-foreground text-sm font-mono px-2 py-1 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
              <div className="text-xs text-muted">{t('config_vars.type_auto')}</div>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t('config_variables.description_placeholder')}
                className="w-full rounded border border-default bg-background text-foreground text-sm px-2 py-1 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
              />
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={handleConfirmAdd}
                  className="p-1.5 text-success hover:bg-success-subtle rounded transition-default"
                  title={tCommon('add')}
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleCancelAdd}
                  className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                  title={tCommon('cancel')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title={t('config_variables.delete_title', { key: deleteTarget?.key || '' })}
        description={t('config_variables.delete_description', { key: deleteTarget?.key || '' })}
        confirmLabel={tCommon('delete')}
        variant="danger"
        loading={deleteLoading}
      />

      {/* Manage variable namespaces panel */}
      {projectId && (
        <ManageVariableNamespacesPanel
          open={showManageVariableNamespaces}
          onClose={() => setShowManageVariableNamespaces(false)}
          projectId={projectId}
          onNamespacesChanged={() => {
            loadVariableNamespaces();
            load();
          }}
        />
      )}
    </div>
  );
}
