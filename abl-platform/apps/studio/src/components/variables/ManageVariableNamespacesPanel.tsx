'use client';

/**
 * ManageVariableNamespacesPanel Component
 *
 * Slide-over panel for managing variable namespaces: list, create, edit, delete.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { Plus, Pencil, Trash2, GripVertical, Check, X } from 'lucide-react';
import { SlidePanel } from '../ui/SlidePanel';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Badge } from '../ui/Badge';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  fetchVariableNamespaces,
  createVariableNamespace,
  updateVariableNamespace,
  deleteVariableNamespace,
  type VariableNamespace,
  type CreateVariableNamespaceInput,
} from '../../api/variable-namespaces';
import {
  NAMESPACE_COLOR_TOKENS,
  resolveNamespaceColor,
  type NamespaceColorToken,
} from '@agent-platform/design-tokens';

/** Valid namespace name pattern: lowercase letters, digits, hyphens; starts with letter */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Color choices persisted as semantic tokens; resolved to CSS at render time so
 * the swatch follows the active theme.
 */
const PRESET_COLOR_TOKENS = NAMESPACE_COLOR_TOKENS;

interface ManageVariableNamespacesPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onNamespacesChanged: () => void;
}

export function ManageVariableNamespacesPanel({
  open,
  onClose,
  projectId,
  onNamespacesChanged,
}: ManageVariableNamespacesPanelProps) {
  const t = useTranslations('variables.namespaces');
  const [namespaces, setNamespaces] = useState<VariableNamespace[]>([]);
  const [loading, setLoading] = useState(false);

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newColor, setNewColor] = useState<NamespaceColorToken>(PRESET_COLOR_TOKENS[0]);
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editColor, setEditColor] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<VariableNamespace | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchVariableNamespaces(projectId);
      setNamespaces([...(data.namespaces || [])].sort((a, b) => a.order - b.order));
    } catch {
      toast.error(t('load_error'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      load();
    }
  }, [open, load]);

  const handleAdd = async () => {
    const trimmedName = newName.trim().toLowerCase();
    const trimmedDisplay = newDisplayName.trim();

    if (!trimmedName || !trimmedDisplay) {
      toast.error(t('name_required'));
      return;
    }
    if (!NAME_PATTERN.test(trimmedName)) {
      toast.error(t('name_pattern_error'));
      return;
    }

    setAdding(true);
    try {
      const input: CreateVariableNamespaceInput = {
        name: trimmedName,
        displayName: trimmedDisplay,
        description: newDescription.trim() || undefined,
        color: newColor || undefined,
      };
      await createVariableNamespace(projectId, input);
      toast.success(t('created_success', { name: trimmedDisplay }));
      resetAddForm();
      await load();
      onNamespacesChanged();
    } catch (err) {
      toast.error(sanitizeError(err, t('create_error')));
    } finally {
      setAdding(false);
    }
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setNewName('');
    setNewDisplayName('');
    setNewDescription('');
    setNewColor(PRESET_COLOR_TOKENS[0]);
  };

  const startEdit = (ns: VariableNamespace) => {
    setEditingId(ns.id);
    setEditDisplayName(ns.displayName);
    setEditDescription(ns.description || '');
    setEditColor(ns.color || PRESET_COLOR_TOKENS[0]);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const trimmedDisplay = editDisplayName.trim();
    if (!trimmedDisplay) {
      toast.error(t('display_name_required'));
      return;
    }

    setSaving(true);
    try {
      await updateVariableNamespace(projectId, editingId, {
        displayName: trimmedDisplay,
        description: editDescription.trim() || null,
        color: editColor || null,
      });
      toast.success(t('updated_success'));
      setEditingId(null);
      await load();
      onNamespacesChanged();
    } catch (err) {
      toast.error(sanitizeError(err, t('update_error')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteVariableNamespace(projectId, deleteTarget.id);
      toast.success(
        t('deleted_success', { name: deleteTarget.displayName }) +
          (result.movedToDefault > 0
            ? t('deleted_moved_suffix', { count: result.movedToDefault })
            : ''),
      );
      setDeleteTarget(null);
      await load();
      onNamespacesChanged();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_error')));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <SlidePanel
        open={open}
        onClose={onClose}
        title={t('title')}
        description={t('description')}
        width="md"
      >
        <div className="space-y-4">
          {/* Add button */}
          {!showAddForm && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowAddForm(true)}
            >
              {t('add_button')}
            </Button>
          )}

          {/* Add form */}
          {showAddForm && (
            <div className="border border-default rounded-lg p-4 space-y-3 bg-background-muted/20">
              <Input
                label={t('label_name')}
                value={newName}
                onChange={(e) =>
                  setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
                placeholder={t('placeholder_name')}
                error={
                  newName.length > 0 && !NAME_PATTERN.test(newName)
                    ? t('name_validation_hint')
                    : undefined
                }
              />
              <Input
                label={t('label_display_name')}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder={t('placeholder_display_name')}
              />
              <Input
                label={t('label_description')}
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t('placeholder_description')}
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-foreground">
                  {t('label_color')}
                </label>
                <div className="flex gap-2">
                  {PRESET_COLOR_TOKENS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      onClick={() => setNewColor(token)}
                      className={clsx(
                        'w-6 h-6 rounded-full border-2 transition-default',
                        newColor === token ? 'border-foreground scale-110' : 'border-transparent',
                      )}
                      style={{ backgroundColor: resolveNamespaceColor(token) ?? undefined }}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAdd}
                  loading={adding}
                  disabled={
                    !newName.trim() ||
                    !newDisplayName.trim() ||
                    (newName.length > 0 && !NAME_PATTERN.test(newName))
                  }
                >
                  {t('create')}
                </Button>
                <Button variant="ghost" size="sm" onClick={resetAddForm}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}

          {/* Namespace list */}
          {loading ? (
            <div className="py-8 text-center text-sm text-muted">{t('loading')}</div>
          ) : namespaces.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">{t('empty')}</div>
          ) : (
            <div className="space-y-2">
              {namespaces.map((ns) => (
                <div
                  key={ns.id}
                  className="border border-default rounded-lg p-3 bg-background-subtle hover:bg-background-muted/30 transition-default"
                >
                  {editingId === ns.id ? (
                    /* Edit mode */
                    <div className="space-y-3">
                      <Input
                        label={t('label_display_name')}
                        value={editDisplayName}
                        onChange={(e) => setEditDisplayName(e.target.value)}
                      />
                      <Input
                        label={t('label_description')}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        placeholder={t('placeholder_description')}
                      />
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium text-foreground">
                          {t('label_color')}
                        </label>
                        <div className="flex gap-2">
                          {PRESET_COLOR_TOKENS.map((token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() => setEditColor(token)}
                              className={clsx(
                                'w-6 h-6 rounded-full border-2 transition-default',
                                editColor === token
                                  ? 'border-foreground scale-110'
                                  : 'border-transparent',
                              )}
                              style={{ backgroundColor: resolveNamespaceColor(token) ?? undefined }}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={handleSaveEdit}
                          disabled={saving}
                          className="p-1 text-success hover:bg-success/10 rounded"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="p-1 text-muted hover:bg-background-muted rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View mode */
                    <div className="flex items-center gap-3">
                      <GripVertical className="w-4 h-4 text-subtle shrink-0" />
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{
                          backgroundColor: resolveNamespaceColor(ns.color) ?? 'var(--color-muted)',
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">
                            {ns.displayName}
                          </span>
                          {ns.isDefault && <Badge variant="accent">default</Badge>}
                          <Badge variant="default">
                            {ns.memberCounts.env + ns.memberCounts.config}
                          </Badge>
                        </div>
                        {ns.description && (
                          <p className="text-xs text-muted mt-0.5 truncate">{ns.description}</p>
                        )}
                        <p className="text-xs text-subtle mt-0.5 font-mono">{ns.name}</p>
                      </div>
                      {!ns.isDefault && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => startEdit(ns)}
                            className="p-1 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
                            title={t('edit_title')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(ns)}
                            className="p-1 text-muted hover:text-error hover:bg-error/10 rounded transition-default"
                            title={t('delete_title')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </SlidePanel>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_description', {
          name: deleteTarget?.displayName ?? '',
        })}
        confirmLabel={t('delete_confirm_label')}
        variant="danger"
        loading={deleting}
      />
    </>
  );
}
