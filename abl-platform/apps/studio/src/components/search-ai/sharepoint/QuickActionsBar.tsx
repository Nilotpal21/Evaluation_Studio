'use client';

/**
 * QuickActionsBar
 *
 * Action buttons for connector quick actions: Sync Now, Pause/Resume,
 * Edit Configuration, Re-auth, Health Check, Search Documents, Configure Alerts.
 */

import { useTranslations } from 'next-intl';
import { RefreshCw, Pause, Play, Settings, KeyRound, HeartPulse, Search, Bell } from 'lucide-react';
import { Button } from '../../ui/Button';

interface QuickActionsBarProps {
  connectorId: string;
  indexId: string;
  isPaused: boolean;
  syncInProgress: boolean;
  onSyncNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onEditConfig: () => void;
  onReAuth: () => void;
  onHealthCheck: () => void;
  onSearchDocuments: () => void;
}

export function QuickActionsBar({
  isPaused,
  syncInProgress,
  onSyncNow,
  onPause,
  onResume,
  onEditConfig,
  onReAuth,
  onHealthCheck,
  onSearchDocuments,
}: QuickActionsBarProps) {
  const t = useTranslations('search_ai.sharepoint.overview');

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{t('quick_actions_title')}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw className="w-3.5 h-3.5" />}
          disabled={syncInProgress}
          onClick={onSyncNow}
        >
          {t('sync_now')}
        </Button>

        {isPaused ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Play className="w-3.5 h-3.5" />}
            onClick={onResume}
          >
            {t('btn_resume')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            icon={<Pause className="w-3.5 h-3.5" />}
            disabled={!syncInProgress}
            onClick={onPause}
          >
            {t('btn_pause')}
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          icon={<Settings className="w-3.5 h-3.5" />}
          onClick={onEditConfig}
        >
          {t('edit_config')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<KeyRound className="w-3.5 h-3.5" />}
          onClick={onReAuth}
        >
          {t('btn_reauth')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<HeartPulse className="w-3.5 h-3.5" />}
          onClick={onHealthCheck}
        >
          {t('btn_health_check')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          icon={<Search className="w-3.5 h-3.5" />}
          onClick={onSearchDocuments}
        >
          {t('btn_search_docs')}
        </Button>

        <Button variant="ghost" size="sm" icon={<Bell className="w-3.5 h-3.5" />} disabled>
          {t('btn_configure_alerts')}
        </Button>
      </div>
    </div>
  );
}
