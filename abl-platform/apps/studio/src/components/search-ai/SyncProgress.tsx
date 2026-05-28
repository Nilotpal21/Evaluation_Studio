/**
 * SyncProgress Component
 *
 * Real-time sync progress display with WebSocket streaming.
 * Features:
 * - Live progress bar with percentage
 * - Current document being processed
 * - Processing rate (docs/min)
 * - Estimated time to completion (ETA)
 * - Stop button
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, StopCircle, AlertCircle, CheckCircle2, FileText, Gauge } from 'lucide-react';
import { Button } from '../ui/Button';
import { Progress } from '../ui/Progress';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import {
  connectToSyncProgress,
  stopConnectorSync,
  type SyncProgressEvent,
} from '../../api/connector-extensions';

// =============================================================================
// TYPES
// =============================================================================

interface SyncProgressProps {
  connectorId: string;
  jobId: string;
  onComplete?: () => void;
  onStop?: () => void;
}

interface ProgressState {
  percentage: number;
  total: number;
  completed: number;
  failed: number;
  currentDocument: string;
  rate: number; // docs per minute
  eta?: string;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function formatETAWithTranslation(
  isoString: string,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  const now = new Date();
  const eta = new Date(isoString);
  const diffMs = eta.getTime() - now.getTime();

  if (diffMs < 0) return t('eta_calculating');

  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMin / 60);
  const remainingMin = diffMin % 60;

  if (diffHours > 0) {
    return t('eta_hours_minutes', { hours: diffHours, minutes: remainingMin });
  }
  return t('eta_minutes', { minutes: diffMin });
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SyncProgress({ connectorId, jobId, onComplete, onStop }: SyncProgressProps) {
  const t = useTranslations('search_ai.sync_progress');
  const [progress, setProgress] = useState<ProgressState>({
    percentage: 0,
    total: 0,
    completed: 0,
    failed: 0,
    currentDocument: '',
    rate: 0,
  });

  const [status, setStatus] = useState<
    'connecting' | 'syncing' | 'completed' | 'stopped' | 'error'
  >('connecting');
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle progress updates from WebSocket
  const handleProgressUpdate = useCallback(
    (event: SyncProgressEvent) => {
      setStatus('syncing');
      setProgress({
        percentage: event.data.progress.percentage,
        total: event.data.progress.total,
        completed: event.data.progress.completed,
        failed: event.data.progress.failed,
        currentDocument: event.data.currentDocument,
        rate: event.data.rate,
        eta: event.data.eta,
      });

      // Check if sync is complete
      if (
        event.data.progress.percentage >= 100 ||
        (event.data.progress.total > 0 &&
          event.data.progress.completed >= event.data.progress.total)
      ) {
        setStatus('completed');
        if (onComplete) {
          onComplete();
        }
      }
    },
    [onComplete],
  );

  // WebSocket error handler
  const handleWebSocketError = useCallback(
    (event: Event) => {
      console.error('[SyncProgress] WebSocket error:', event);
      setError(t('connection_lost'));
    },
    [t],
  );

  // WebSocket close handler
  const handleWebSocketClose = useCallback(
    (event: CloseEvent) => {
      console.log('[SyncProgress] WebSocket closed:', event.code, event.reason);

      // Don't reconnect if sync is completed or stopped
      if (status === 'completed' || status === 'stopped') {
        return;
      }

      // Attempt to reconnect after 3 seconds
      if (event.code !== 1000) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[SyncProgress] Attempting to reconnect...');
          connectWebSocket();
        }, 3000);
      }
    },
    [status],
  );

  // Connect to WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    try {
      const ws = connectToSyncProgress(
        jobId,
        handleProgressUpdate,
        handleWebSocketError,
        handleWebSocketClose,
      );
      wsRef.current = ws;
    } catch (err) {
      console.error('[SyncProgress] Failed to connect WebSocket:', err);
      setError(t('connection_failed'));
      setStatus('error');
    }
  }, [jobId, handleProgressUpdate, handleWebSocketError, handleWebSocketClose, t]);

  // Initialize WebSocket connection
  useEffect(() => {
    connectWebSocket();

    return () => {
      // Cleanup on unmount
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
        wsRef.current = null;
      }
    };
  }, [connectWebSocket]);

  // Handle stop button
  const handleStop = async () => {
    setStopping(true);
    try {
      await stopConnectorSync(connectorId, 'User requested stop');
      setStatus('stopped');
      toast.success(t('sync_stopped_toast'));

      if (onStop) {
        onStop();
      }
    } catch (err) {
      const message = sanitizeError(err, t('stop_sync_fallback'));
      toast.error(t('stop_sync_error', { message }));
    } finally {
      setStopping(false);
    }
  };

  // Render connecting state
  if (status === 'connecting') {
    return (
      <div className="rounded-lg border bg-background-elevated p-6">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-info" />
          <span className="text-sm text-foreground-subtle">{t('connecting')}</span>
        </div>
      </div>
    );
  }

  // Render error state
  if (status === 'error') {
    return (
      <div className="rounded-lg border border-error bg-error-subtle p-6">
        <div className="flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-error" />
          <div>
            <p className="font-medium text-foreground">{t('connection_error_title')}</p>
            <p className="mt-1 text-sm text-error">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // Render completed state
  if (status === 'completed') {
    return (
      <div className="rounded-lg border border-success bg-success-subtle p-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div>
            <p className="font-medium text-foreground">{t('sync_completed')}</p>
            <p className="mt-1 text-sm text-success">
              {t('processed_documents', { count: progress.completed })}
              {progress.failed > 0 && ` (${t('failed_count', { count: progress.failed })})`}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Render stopped state
  if (status === 'stopped') {
    return (
      <div className="rounded-lg border border-warning bg-warning-subtle p-6">
        <div className="flex items-center gap-3">
          <StopCircle className="h-5 w-5 text-warning" />
          <div>
            <p className="font-medium text-foreground">{t('sync_stopped')}</p>
            <p className="mt-1 text-sm text-warning">
              {t('sync_stopped_description', { count: progress.completed })}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Render active sync progress
  return (
    <div className="rounded-lg border bg-background-elevated p-6 shadow-sm">
      {/* Progress bar */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground-subtle">
            {progress.total > 0
              ? t('syncing_documents_progress', {
                  completed: progress.completed,
                  total: progress.total,
                })
              : t('syncing_documents')}
          </span>
          <span className="text-sm font-semibold text-info">{progress.percentage}%</span>
        </div>
        <Progress value={progress.percentage} className="h-2" />
      </div>

      {/* Current document */}
      <div className="mb-4 flex items-start gap-2 rounded-md bg-background-muted p-3">
        <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-foreground-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-foreground-muted">{t('currently_processing')}</p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">
            {progress.currentDocument || t('starting_sync')}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div className="flex items-center gap-2 rounded-md bg-info-subtle p-3">
          <Gauge className="h-4 w-4 text-info" />
          <div>
            <p className="text-xs text-info">{t('processing_rate')}</p>
            <p className="mt-0.5 text-sm font-semibold text-foreground">
              {t('docs_per_min', { rate: progress.rate.toFixed(1) })}
            </p>
          </div>
        </div>

        {progress.eta && (
          <div className="flex items-center gap-2 rounded-md bg-purple-subtle p-3">
            <Loader2 className="h-4 w-4 text-purple" />
            <div>
              <p className="text-xs text-purple">{t('estimated_time')}</p>
              <p className="mt-0.5 text-sm font-semibold text-foreground">
                {formatETAWithTranslation(progress.eta, t)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Stop button */}
      <div className="flex items-center justify-end gap-3">
        {error && (
          <span className="text-xs text-warning">
            <AlertCircle className="mr-1 inline h-3 w-3" />
            {error}
          </span>
        )}
        <Button onClick={handleStop} disabled={stopping} variant="secondary" size="sm">
          {stopping ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('stopping')}
            </>
          ) : (
            <>
              <StopCircle className="mr-2 h-4 w-4" />
              {t('stop_sync')}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
