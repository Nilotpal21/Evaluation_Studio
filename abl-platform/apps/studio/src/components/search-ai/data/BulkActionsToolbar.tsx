/**
 * BulkActionsToolbar Component
 *
 * Floating toolbar shown when one or more sources are selected.
 * Provides bulk actions (Pause, Resume, Sync Now, Delete) with
 * SP-conditional actions (Re-auth, Apply Schedule, Export Configs).
 */

import { useTranslations } from 'next-intl';
import { Pause, Play, RefreshCw, Trash2, KeyRound, Calendar, Download, X } from 'lucide-react';
import { Button } from '../../ui/Button';

interface BulkActionsToolbarProps {
  selectedCount: number;
  allAreSP: boolean;
  onPause: () => void;
  onResume: () => void;
  onSyncNow: () => void;
  onDelete: () => void;
  onReAuth?: () => void;
  onApplySchedule?: () => void;
  onExportConfigs?: () => void;
  onClearSelection: () => void;
  loading?: boolean;
}

export function BulkActionsToolbar({
  selectedCount,
  allAreSP,
  onPause,
  onResume,
  onSyncNow,
  onDelete,
  onReAuth,
  onApplySchedule,
  onExportConfigs,
  onClearSelection,
  loading = false,
}: BulkActionsToolbarProps) {
  const t = useTranslations('search_ai.sources_table.bulk');

  return (
    <div className="sticky bottom-4 mx-auto w-fit z-20">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-background-elevated border border-default rounded-xl shadow-lg">
        <span className="text-sm font-medium text-foreground mr-2">
          {t('selected_count', { count: selectedCount })}
        </span>

        <div className="h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          icon={<Pause className="w-3.5 h-3.5" />}
          onClick={onPause}
          disabled={loading}
          aria-label={t('action_pause')}
        >
          {t('action_pause')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<Play className="w-3.5 h-3.5" />}
          onClick={onResume}
          disabled={loading}
          aria-label={t('action_resume')}
        >
          {t('action_resume')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          onClick={onSyncNow}
          disabled={loading}
          aria-label={t('action_sync_now')}
        >
          {t('action_sync_now')}
        </Button>

        {allAreSP && onReAuth && (
          <Button
            variant="ghost"
            size="sm"
            icon={<KeyRound className="w-3.5 h-3.5" />}
            onClick={onReAuth}
            disabled={loading}
            aria-label={t('action_re_auth')}
          >
            {t('action_re_auth')}
          </Button>
        )}

        {allAreSP && onApplySchedule && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Calendar className="w-3.5 h-3.5" />}
            onClick={onApplySchedule}
            disabled={loading}
            aria-label={t('action_apply_schedule')}
          >
            {t('action_apply_schedule')}
          </Button>
        )}

        {allAreSP && onExportConfigs && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            onClick={onExportConfigs}
            disabled={loading}
            aria-label={t('action_export_configs')}
          >
            {t('action_export_configs')}
          </Button>
        )}

        <div className="h-5 w-px bg-border" />

        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onClick={onDelete}
          disabled={loading}
          aria-label={t('action_delete')}
        >
          {t('action_delete')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<X className="w-3.5 h-3.5" />}
          onClick={onClearSelection}
          aria-label={t('clear_selection')}
        >
          {t('clear_selection')}
        </Button>
      </div>
    </div>
  );
}
