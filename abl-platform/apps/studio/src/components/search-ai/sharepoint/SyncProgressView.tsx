'use client';

/**
 * SyncProgressView
 *
 * Real-time sync progress view shown when a sync is active.
 * Displays overall progress, current document, per-site bars, and action buttons.
 * Polls at 3s intervals for faster updates during active sync.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Progress } from '../../ui/Progress';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Badge } from '../../ui/Badge';
import { PerSiteProgressBar } from './PerSiteProgressBar';
import { useConnectorSync } from '../../../hooks/useConnectorSync';
import { pauseConnectorSync, stopConnectorSync } from '../../../api/search-ai';

interface SyncProgressViewProps {
  indexId: string;
  connectorId: string;
  connectorName: string;
  onPause: () => void;
  onStop: () => void;
  onSyncComplete: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

export function SyncProgressView({
  connectorId,
  connectorName,
  onSyncComplete,
}: SyncProgressViewProps) {
  const t = useTranslations('search_ai.sharepoint.sync_progress');
  const { syncStatus } = useConnectorSync(connectorId, { pollInterval: 3000 });

  const [showPauseDialog, setShowPauseDialog] = useState(false);
  const [showStopDialog, setShowStopDialog] = useState(false);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [stopLoading, setStopLoading] = useState(false);
  const [syncCompleted, setSyncCompleted] = useState(false);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const progress = syncStatus?.progress;
  const percentage = progress?.percentage ?? 0;
  const syncType = syncStatus?.syncType ?? 'full';

  // Sync completion detection
  useEffect(() => {
    if (percentage >= 100 && !syncCompleted) {
      setSyncCompleted(true);
      completionTimerRef.current = setTimeout(() => {
        onSyncComplete();
      }, 3000);
    }

    return () => {
      if (completionTimerRef.current) {
        clearTimeout(completionTimerRef.current);
      }
    };
  }, [percentage, syncCompleted, onSyncComplete]);

  const handlePauseConfirm = useCallback(async () => {
    setPauseLoading(true);
    try {
      await pauseConnectorSync(connectorId, 'User requested pause');
    } finally {
      setPauseLoading(false);
      setShowPauseDialog(false);
    }
  }, [connectorId]);

  const handleStopConfirm = useCallback(async () => {
    setStopLoading(true);
    try {
      await stopConnectorSync(connectorId, 'User requested stop');
    } finally {
      setStopLoading(false);
      setShowStopDialog(false);
    }
  }, [connectorId]);

  const showEstimating =
    percentage < 10 || progress?.etaSeconds === null || progress?.etaSeconds === undefined;

  if (syncCompleted) {
    return (
      <div className="p-6 flex flex-col items-center justify-center py-16">
        <Badge variant="success" dot pulse>
          {t('sync_complete')}
        </Badge>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Sync type header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {syncType === 'full' ? t('full_sync_title') : t('delta_sync_title')}
        </h3>
        <Badge variant="accent" dot pulse>
          {percentage.toFixed(0)}%
        </Badge>
      </div>

      {/* Overall progress bar */}
      <div className="space-y-2">
        <Progress value={percentage} />
        <div className="flex items-center justify-between text-xs text-muted">
          <span>
            {t('docs_progress', {
              processed: progress?.docsProcessed ?? 0,
              total: progress?.docsTotal ?? 0,
            })}
          </span>
          {progress?.sizeProcessed !== undefined && progress?.sizeTotal !== undefined && (
            <span>
              {t('size_progress', {
                processedSize: formatSize(progress.sizeProcessed),
                totalSize: formatSize(progress.sizeTotal),
              })}
            </span>
          )}
        </div>
      </div>

      {/* ETA */}
      <div className="text-xs text-muted">
        {showEstimating
          ? t('eta_estimating')
          : t('eta', { time: formatEta(progress?.etaSeconds ?? 0) })}
      </div>

      {/* Current document */}
      {progress?.currentDocument && (
        <div className="text-xs text-muted p-2 rounded bg-background-subtle border border-default">
          {t('current_doc', {
            name: progress.currentDocument.name,
            site: progress.currentDocument.sourceSite,
          })}
        </div>
      )}

      {/* Per-site progress */}
      {syncStatus?.perSiteProgress && syncStatus.perSiteProgress.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs text-muted font-medium uppercase tracking-wider">
            {t('per_site_title')}
          </h4>
          <div className="space-y-2">
            {syncStatus.perSiteProgress.map((site) => (
              <PerSiteProgressBar
                key={site.siteName}
                siteName={site.siteName}
                percentage={site.percentage}
                docsProcessed={site.docsProcessed}
                docsTotal={site.docsTotal}
                isComplete={site.percentage >= 100}
              />
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button variant="secondary" size="sm" onClick={() => setShowPauseDialog(true)}>
          {t('btn_pause_sync')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setShowStopDialog(true)}>
          {t('btn_stop_sync')}
        </Button>
      </div>

      {/* Pause confirmation */}
      <ConfirmDialog
        open={showPauseDialog}
        onClose={() => setShowPauseDialog(false)}
        onConfirm={handlePauseConfirm}
        title={t('pause_confirm_title')}
        description={t('pause_confirm_description')}
        variant="primary"
        loading={pauseLoading}
      />

      {/* Stop confirmation */}
      <ConfirmDialog
        open={showStopDialog}
        onClose={() => setShowStopDialog(false)}
        onConfirm={handleStopConfirm}
        title={t('stop_confirm_title')}
        description={t('stop_confirm_description')}
        variant="danger"
        loading={stopLoading}
      />
    </div>
  );
}
