'use client';

/**
 * VariableNamespaceTagPopover Component
 *
 * A popover showing variable namespace assignments for a variable as checkbox list.
 * Allows toggling namespace memberships and saving changes.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import * as RadixPopover from '@radix-ui/react-popover';
import { Tag, Loader2 } from 'lucide-react';
import { Checkbox } from '../ui/Checkbox';
import { Button } from '../ui/Button';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { resolveNamespaceColor } from '@agent-platform/design-tokens';
import {
  addMembersToVariableNamespace,
  removeMemberFromVariableNamespace,
  type VariableNamespace,
} from '../../api/variable-namespaces';

interface VariableNamespaceTagPopoverProps {
  projectId: string;
  variableId: string;
  variableType: 'env' | 'config';
  namespaces: VariableNamespace[];
  assignedVariableNamespaceIds: string[];
  onUpdated: () => void;
  className?: string;
}

export function VariableNamespaceTagPopover({
  projectId,
  variableId,
  variableType,
  namespaces,
  assignedVariableNamespaceIds,
  onUpdated,
  className,
}: VariableNamespaceTagPopoverProps) {
  const t = useTranslations('variables.namespace_tag');
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set(assignedVariableNamespaceIds));
  const [saving, setSaving] = useState(false);

  // Reset checked state when popover opens or assignments change
  useEffect(() => {
    if (open) {
      setChecked(new Set(assignedVariableNamespaceIds));
    }
  }, [open, assignedVariableNamespaceIds]);

  const sorted = [...namespaces].sort((a, b) => a.order - b.order);
  const assignedNs = sorted.filter((ns) => assignedVariableNamespaceIds.includes(ns.id));

  const hasChanges = useCallback(() => {
    const original = new Set(assignedVariableNamespaceIds);
    if (checked.size !== original.size) return true;
    for (const id of checked) {
      if (!original.has(id)) return true;
    }
    return false;
  }, [checked, assignedVariableNamespaceIds]);

  const handleToggle = (nsId: string, isChecked: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (isChecked) {
        next.add(nsId);
      } else {
        next.delete(nsId);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const original = new Set(assignedVariableNamespaceIds);
      const toAdd = [...checked].filter((id) => !original.has(id));
      const toRemove = [...original].filter((id) => !checked.has(id));

      // Add to new namespaces
      for (const nsId of toAdd) {
        await addMembersToVariableNamespace(projectId, nsId, [{ variableId, variableType }]);
      }

      // Remove from old namespaces
      for (const nsId of toRemove) {
        await removeMemberFromVariableNamespace(projectId, nsId, variableId, variableType);
      }

      toast.success(t('updated_success'));
      onUpdated();
      setOpen(false);
    } catch (err) {
      toast.error(sanitizeError(err, t('update_error')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          className={clsx(
            'inline-flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default',
            className,
          )}
          title={t('manage_title')}
        >
          {assignedNs.length > 0 ? (
            <span className="inline-flex items-center gap-1 flex-wrap">
              {assignedNs.slice(0, 2).map((ns) => (
                <span
                  key={ns.id}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-background-muted text-xs"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: resolveNamespaceColor(ns.color) ?? 'var(--color-muted)',
                    }}
                  />
                  <span className="truncate max-w-[60px]">{ns.displayName}</span>
                </span>
              ))}
              {assignedNs.length > 2 && (
                <span className="text-xs text-muted">+{assignedNs.length - 2}</span>
              )}
            </span>
          ) : (
            <Tag className="w-3 h-3" />
          )}
        </button>
      </RadixPopover.Trigger>

      <RadixPopover.Portal>
        <RadixPopover.Content
          align="start"
          sideOffset={4}
          className={clsx(
            'z-50 w-64 overflow-hidden rounded-xl',
            'bg-background-elevated border border-default shadow-xl',
            'p-3 animate-fade-in-scale bg-noise',
          )}
        >
          <div className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
            {t('heading')}
          </div>

          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {sorted.map((ns) => (
              <div key={ns.id} className="flex items-center gap-2">
                <Checkbox
                  checked={checked.has(ns.id)}
                  onChange={(isChecked) => handleToggle(ns.id, isChecked)}
                  disabled={saving}
                />
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: resolveNamespaceColor(ns.color) ?? 'var(--color-muted)',
                  }}
                />
                <span className="text-sm text-foreground truncate flex-1">{ns.displayName}</span>
              </div>
            ))}
          </div>

          {hasChanges() && (
            <div className="mt-3 pt-2 border-t border-default">
              <Button
                variant="primary"
                size="xs"
                onClick={handleSave}
                loading={saving}
                className="w-full"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : t('save')}
              </Button>
            </div>
          )}

          <RadixPopover.Arrow className="fill-border" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
