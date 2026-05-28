/**
 * AttributeBulkBar
 *
 * Sticky action bar that appears above the attribute table when 1+ checkboxes
 * are selected. Provides bulk approve, discard, and change-tier actions
 * with confirmation dialogs.
 */

'use client';

import { useState } from 'react';
import { CheckCircle, Trash2, X, Layers } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import type { AttributeTier } from '../../../api/search-ai';

interface AttributeBulkBarProps {
  selectedCount: number;
  onApprove: () => void;
  onDiscard: () => void;
  onChangeTier: (tier: AttributeTier) => void;
  onClearSelection: () => void;
}

type ConfirmAction = 'approve' | 'discard' | 'changeTier';

export function AttributeBulkBar({
  selectedCount,
  onApprove,
  onDiscard,
  onChangeTier,
  onClearSelection,
}: AttributeBulkBarProps) {
  const t = useTranslations('search_ai.kg');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [pendingTier, setPendingTier] = useState<AttributeTier | null>(null);

  const TIER_OPTIONS = [
    { value: 'permanent', label: t('attr_tier_permanent') },
    { value: 'approved', label: t('attr_tier_approved') },
    { value: 'beta', label: t('attr_tier_beta') },
    { value: 'novel', label: t('attr_tier_novel') },
    { value: 'discarded', label: t('attr_tier_discarded') },
  ];

  const handleTierSelect = (value: string) => {
    setPendingTier(value as AttributeTier);
    setConfirmAction('changeTier');
  };

  const handleConfirm = () => {
    if (confirmAction === 'approve') {
      onApprove();
    } else if (confirmAction === 'discard') {
      onDiscard();
    } else if (confirmAction === 'changeTier' && pendingTier) {
      onChangeTier(pendingTier);
    }
    setConfirmAction(null);
    setPendingTier(null);
  };

  const handleCancelConfirm = () => {
    setConfirmAction(null);
    setPendingTier(null);
  };

  const confirmTitle =
    confirmAction === 'approve'
      ? t('attr_bulk_approve_title')
      : confirmAction === 'discard'
        ? t('attr_bulk_discard_title')
        : t('attr_bulk_change_tier_title', {
            tier: pendingTier ? pendingTier.charAt(0).toUpperCase() + pendingTier.slice(1) : '',
          });

  const confirmDescription =
    confirmAction === 'approve'
      ? t('attr_bulk_approve_description', { count: selectedCount })
      : confirmAction === 'discard'
        ? t('attr_bulk_discard_description', { count: selectedCount })
        : t('attr_bulk_change_tier_description', { count: selectedCount, tier: pendingTier ?? '' });

  return (
    <>
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 rounded-lg border border-accent bg-accent-subtle">
        <span className="text-sm font-medium">
          {t('attr_selected_count', { count: selectedCount })}
        </span>

        <button
          onClick={onClearSelection}
          className="p-1 rounded hover:bg-accent/10 transition-default"
          aria-label={t('attr_clear_selection')}
        >
          <X className="w-3.5 h-3.5" />
        </button>

        <div className="h-4 w-px bg-border mx-1" />

        <Button variant="primary" size="sm" onClick={() => setConfirmAction('approve')}>
          <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
          {t('attr_bulk_approve_button')}
        </Button>

        <Button variant="danger" size="sm" onClick={() => setConfirmAction('discard')}>
          <Trash2 className="w-3.5 h-3.5 mr-1.5" />
          {t('attr_bulk_discard_button')}
        </Button>

        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-muted" />
          <Select
            options={TIER_OPTIONS}
            onChange={handleTierSelect}
            placeholder={t('attr_bulk_change_tier_placeholder')}
            className="w-40"
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={handleCancelConfirm}
        onConfirm={handleConfirm}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={
          confirmAction === 'approve'
            ? t('attr_approve')
            : confirmAction === 'discard'
              ? t('attr_discard')
              : t('attr_change_tier')
        }
        variant={confirmAction === 'discard' ? 'danger' : 'primary'}
      />
    </>
  );
}
