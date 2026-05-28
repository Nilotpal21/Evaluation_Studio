/**
 * AuthProfileImpactModal
 *
 * Single shared confirmation modal for the three destructive auth-profile
 * actions: Disable, Revoke, Delete. Loads the consumer list on open and
 * renders a compact impact block grouped by consumer type so the operator
 * understands what breaks before confirming.
 *
 * Behavioral notes:
 *  - Reversibility framing is mode-driven (disable = reversible info; revoke
 *    = irreversible warning; delete = terminal danger).
 *  - Workspace delete additionally requires the operator to type the profile
 *    name (case- and accent-insensitive) before the confirm button enables.
 *  - When the consumer list is empty the impact block is omitted and the
 *    modal collapses to a single-line confirmation — matches the design.
 *  - For V1 we render a flat consumer list. Project-grouped breakdown for
 *    workspace scope is a V1.1 follow-up (requires backend aggregator
 *    changes to return per-project consumer counts).
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Ban, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  fetchAuthProfileConsumers,
  fetchWorkspaceAuthProfileConsumers,
  type AuthProfileConsumer,
} from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

export type ImpactAction = 'disable' | 'revoke' | 'delete';

interface AuthProfileImpactModalProps {
  open: boolean;
  action: ImpactAction;
  profileId: string;
  profileName: string;
  /** Real projectId for project scope, null for workspace scope. */
  projectId: string | null;
  onClose: () => void;
  /** Caller performs the action; modal handles confirm friction + loading. */
  onConfirm: () => Promise<void>;
}

interface GroupedConsumer {
  type: string;
  label: string;
  items: AuthProfileConsumer[];
}

const PREVIEW_NAMES_PER_GROUP = 5;

function groupConsumers(consumers: AuthProfileConsumer[]): GroupedConsumer[] {
  const map = new Map<string, GroupedConsumer>();
  for (const c of consumers) {
    const existing = map.get(c.type);
    if (existing) {
      existing.items.push(c);
    } else {
      map.set(c.type, { type: c.type, label: c.label || c.type, items: [c] });
    }
  }
  // Stable ordering by count desc, then label.
  return Array.from(map.values()).sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.label.localeCompare(b.label);
  });
}

/** Case- and accent-insensitive compare for the type-to-confirm gate. */
function namesMatch(typed: string, target: string): boolean {
  try {
    const c = new Intl.Collator(undefined, { sensitivity: 'base' });
    return c.compare(typed.trim(), target.trim()) === 0;
  } catch {
    return typed.trim().toLowerCase() === target.trim().toLowerCase();
  }
}

export function AuthProfileImpactModal({
  open,
  action,
  profileId,
  profileName,
  projectId,
  onClose,
  onConfirm,
}: AuthProfileImpactModalProps) {
  const t = useTranslations('auth_profiles.impact');
  const tShared = useTranslations('auth_profiles');

  const isWorkspace = projectId === null;
  const requiresTypeToConfirm = action === 'delete' && isWorkspace;

  const [consumers, setConsumers] = useState<AuthProfileConsumer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  // Reset transient state every time the modal opens so a previous typed
  // confirmation can't leak into a new invocation.
  useEffect(() => {
    if (!open) return;
    setConsumers(null);
    setLoadError(null);
    setSubmitting(false);
    setConfirmText('');
  }, [open, profileId, action]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = isWorkspace
          ? await fetchWorkspaceAuthProfileConsumers(profileId)
          : await fetchAuthProfileConsumers(projectId as string, profileId);
        if (cancelled) return;
        setConsumers(res.data ?? []);
      } catch (err) {
        if (cancelled) return;
        setLoadError(sanitizeError(err, t('load_error')));
        // Empty list is still a valid fallback so the user isn't blocked from
        // confirming if the preview itself errored (the action will run its
        // own server-side checks).
        setConsumers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isWorkspace, profileId, projectId, t]);

  const grouped = useMemo(() => (consumers ? groupConsumers(consumers) : []), [consumers]);
  const totalConsumers = consumers?.length ?? 0;
  const isLoading = consumers === null;

  const canConfirm =
    !submitting && !isLoading && (!requiresTypeToConfirm || namesMatch(confirmText, profileName));

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err) {
      // onConfirm is expected to surface its own toast/error path, but we
      // still guard the loading state so the modal can be retried.
      toast.error(sanitizeError(err, t('confirm_failed')));
    } finally {
      setSubmitting(false);
    }
  }, [canConfirm, onConfirm, t]);

  // ── Mode-driven copy + visuals ────────────────────────────────────────
  const mode = ACTION_MODES[action];
  const Icon = mode.icon;
  const title = t(`${action}_title`, { name: profileName });
  const reversibility = t(`${action}_reversibility`);
  const confirmLabel = t(`${action}_confirm`);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg">
      <div className="space-y-5">
        {/* Reversibility banner — color-coded by severity. */}
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${mode.bannerClass}`}
        >
          <Icon className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="leading-relaxed">{reversibility}</p>
        </div>

        {/* Impact block. Hidden when there are zero consumers — the design
            collapses to a plain confirm in that case. */}
        {isLoading && <p className="text-sm text-muted">{t('loading')}</p>}

        {!isLoading && loadError && <p className="text-xs text-error">{loadError}</p>}

        {!isLoading && totalConsumers === 0 && (
          <p className="text-sm text-muted">{t('no_consumers')}</p>
        )}

        {!isLoading && totalConsumers > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-foreground">
              {t('affected_summary', {
                count: totalConsumers,
                scope: isWorkspace ? t('scope_workspace') : t('scope_project'),
              })}
            </p>
            <div className="max-h-[40vh] overflow-auto rounded-md border border-default">
              <ul className="divide-y divide-default">
                {grouped.map((group) => {
                  const overflow = group.items.length - PREVIEW_NAMES_PER_GROUP;
                  return (
                    <li key={group.type} className="px-3 py-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-foreground">{group.label}</span>
                        <span className="text-muted">{group.items.length}</span>
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {group.items.slice(0, PREVIEW_NAMES_PER_GROUP).map((item) => (
                          <li
                            key={`${item.type}:${item.id}`}
                            className="truncate text-xs text-muted"
                            title={item.name}
                          >
                            • {item.name}
                          </li>
                        ))}
                        {overflow > 0 && (
                          <li className="text-xs text-subtle">
                            {t('and_more', { count: overflow })}
                          </li>
                        )}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {/* Workspace-delete extra friction — typed confirmation. */}
        {requiresTypeToConfirm && (
          <div className="space-y-1.5">
            <label className="text-xs text-foreground" htmlFor="impact-confirm-name">
              {t('type_to_confirm', { name: profileName })}
            </label>
            <Input
              id="impact-confirm-name"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={profileName}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {tShared('cancel')}
          </Button>
          <Button
            variant={mode.buttonVariant}
            size="sm"
            onClick={handleConfirm}
            loading={submitting}
            disabled={!canConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ── Mode table ────────────────────────────────────────────────────────────
// Centralises the per-action visual treatment so the JSX above stays linear.

interface ActionMode {
  icon: React.ElementType;
  bannerClass: string;
  buttonVariant: 'secondary' | 'danger';
}

const ACTION_MODES: Record<ImpactAction, ActionMode> = {
  disable: {
    icon: Info,
    bannerClass: 'border-info/30 bg-info-subtle text-info',
    buttonVariant: 'secondary',
  },
  revoke: {
    icon: AlertTriangle,
    bannerClass: 'border-warning/30 bg-warning-subtle text-warning',
    buttonVariant: 'danger',
  },
  delete: {
    icon: Ban,
    bannerClass: 'border-error/30 bg-error-subtle text-error',
    buttonVariant: 'danger',
  },
};
