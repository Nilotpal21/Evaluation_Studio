'use client';

/**
 * WorkflowErrorTab Component
 *
 * Retry policy configuration (max retries, backoff, delay),
 * error alerting threshold settings, and a list of recent
 * errors from failed executions.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Check,
  RefreshCw,
  AlertTriangle,
  XCircle,
  Clock,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';
import clsx from 'clsx';
import type { WorkflowDetail } from '../../../api/workflows';
import { updateWorkflow } from '../../../api/workflows';
import { useWorkflowExecutions } from '../../../hooks/useWorkflowDetail';
import { sanitizeError } from '../../../lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

// =============================================================================
// HELPERS
// =============================================================================

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowErrorTabProps {
  workflow: WorkflowDetail;
  projectId: string;
  onSaved: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowErrorTab({ workflow, projectId, onSaved }: WorkflowErrorTabProps) {
  const retryPolicy = workflow.retryPolicy;

  const [maxRetries, setMaxRetries] = useState(retryPolicy?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const [backoffMs, setBackoffMs] = useState(retryPolicy?.backoffMs ?? DEFAULT_BACKOFF_MS);
  const [backoffMultiplier, setBackoffMultiplier] = useState(
    retryPolicy?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fetch executions to extract recent errors
  const { executions } = useWorkflowExecutions(projectId, workflow.id);

  const failedExecutions = useMemo(
    () => executions.filter((e) => e.status === 'failed' && e.error),
    [executions],
  );

  const failedSteps = useMemo(() => {
    const steps: Array<{
      executionId: string;
      stepName: string;
      errorCode: string;
      errorMessage: string;
      timestamp: string;
    }> = [];

    for (const exec of executions) {
      const ctxSteps = ((exec.context as Record<string, unknown> | undefined)?.steps ??
        {}) as Record<string, Record<string, unknown>>;
      for (const [stepName, s] of Object.entries(ctxSteps)) {
        if (s.status === 'failed' && s.error) {
          const err = s.error as { code: string; message: string };
          steps.push({
            executionId: exec.id,
            stepName,
            errorCode: err.code,
            errorMessage: err.message,
            timestamp: (s.completedAt as string | undefined) ?? exec.startedAt,
          });
        }
      }
    }

    return steps.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [executions]);

  const isDirty =
    maxRetries !== (retryPolicy?.maxRetries ?? DEFAULT_MAX_RETRIES) ||
    backoffMs !== (retryPolicy?.backoffMs ?? DEFAULT_BACKOFF_MS) ||
    backoffMultiplier !== (retryPolicy?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER);

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateWorkflow(projectId, workflow.id, {
        retryPolicy: { maxRetries, backoffMs, backoffMultiplier },
      });
      onSaved();
    } catch (err) {
      const message = sanitizeError(err, 'Failed to save retry policy');
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  }, [projectId, workflow.id, maxRetries, backoffMs, backoffMultiplier, isDirty, onSaved]);

  return (
    <div className="space-y-6">
      {/* Retry policy configuration */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <RefreshCw className="w-4 h-4 text-muted" />
          <h2 className="text-lg font-semibold text-foreground">Retry Policy</h2>
        </div>

        <div className="grid grid-cols-3 gap-4">
          {/* Max retries */}
          <div>
            <label
              htmlFor="max-retries"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Max Retries
            </label>
            <input
              id="max-retries"
              type="number"
              min={0}
              max={10}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Number(e.target.value))}
              className={clsx(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-background border border-default text-foreground',
                'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/30',
                'transition-default',
              )}
            />
            <p className="mt-1 text-xs text-muted">
              Number of retry attempts before marking as failed.
            </p>
          </div>

          {/* Backoff delay */}
          <div>
            <label
              htmlFor="backoff-delay"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Initial Delay (ms)
            </label>
            <input
              id="backoff-delay"
              type="number"
              min={100}
              step={100}
              value={backoffMs}
              onChange={(e) => setBackoffMs(Number(e.target.value))}
              className={clsx(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-background border border-default text-foreground',
                'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/30',
                'transition-default',
              )}
            />
            <p className="mt-1 text-xs text-muted">Delay before the first retry attempt.</p>
          </div>

          {/* Backoff multiplier */}
          <div>
            <label
              htmlFor="backoff-multiplier"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Backoff Multiplier
            </label>
            <input
              id="backoff-multiplier"
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={backoffMultiplier}
              onChange={(e) => setBackoffMultiplier(Number(e.target.value))}
              className={clsx(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-background border border-default text-foreground',
                'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/30',
                'transition-default',
              )}
            />
            <p className="mt-1 text-xs text-muted">Delay multiplier for exponential backoff.</p>
          </div>
        </div>

        {/* Preview */}
        <div className="mt-4 px-3 py-2 rounded-lg bg-background-muted border border-default">
          <p className="text-xs text-muted">
            <Clock className="w-3 h-3 inline-block mr-1" />
            Retry schedule:{' '}
            {Array.from({ length: maxRetries })
              .map((_, i) => {
                const delay = backoffMs * Math.pow(backoffMultiplier, i);
                return delay >= 1000 ? `${(delay / 1000).toFixed(1)}s` : `${delay}ms`;
              })
              .join(' -> ')}
            {maxRetries === 0 && 'No retries configured'}
          </p>
        </div>

        {/* Save button */}
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty}
            loading={isSaving}
            icon={<Check className="w-3.5 h-3.5" />}
          >
            Save Policy
          </Button>
          {saveError && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-error-subtle border border-error/20">
              <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0" />
              <span className="text-sm text-error">{saveError}</span>
            </div>
          )}
        </div>
      </div>

      {/* Error alerting threshold */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="w-4 h-4 text-muted" />
          <h2 className="text-lg font-semibold text-foreground">Error Alerting</h2>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted border border-default">
            <div>
              <p className="text-sm font-medium text-foreground">Consecutive failures threshold</p>
              <p className="text-xs text-muted">Alert after N consecutive failed executions</p>
            </div>
            <input
              type="number"
              min={1}
              max={100}
              defaultValue={3}
              disabled
              className={clsx(
                'w-16 px-2 py-1 rounded-md text-sm text-center',
                'bg-background border border-default text-foreground',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </div>

          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted border border-default">
            <div>
              <p className="text-sm font-medium text-foreground">Error rate threshold (%)</p>
              <p className="text-xs text-muted">
                Alert when failure rate exceeds percentage in last hour
              </p>
            </div>
            <input
              type="number"
              min={1}
              max={100}
              defaultValue={50}
              disabled
              className={clsx(
                'w-16 px-2 py-1 rounded-md text-sm text-center',
                'bg-background border border-default text-foreground',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            />
          </div>

          <p className="text-xs text-muted">
            Alert configuration will be available in a future release.
          </p>
        </div>
      </div>

      {/* Recent errors list */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <AlertTriangle className="w-4 h-4 text-error" />
          <h2 className="text-lg font-semibold text-foreground">Recent Errors</h2>
          {failedExecutions.length > 0 && <Badge variant="error">{failedExecutions.length}</Badge>}
        </div>

        {failedSteps.length > 0 || failedExecutions.length > 0 ? (
          <div className="space-y-2">
            {/* Workflow-level errors */}
            {failedExecutions.map((exec) => (
              <div
                key={exec.id}
                className="px-3 py-2.5 rounded-lg bg-error-subtle border border-error/20"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <XCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-error">
                        {exec.error?.code ?? 'UNKNOWN_ERROR'}
                      </p>
                      <p className="text-xs text-error/80 mt-0.5 truncate">
                        {exec.error?.message ?? 'An unknown error occurred'}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-muted">{formatTimestamp(exec.startedAt)}</p>
                    <span className="text-xs font-mono text-muted">{exec.id.slice(0, 8)}</span>
                  </div>
                </div>
              </div>
            ))}

            {/* Step-level errors */}
            {failedSteps.map((step, index) => (
              <div
                key={`${step.executionId}-${step.stepName}-${index}`}
                className="px-3 py-2.5 rounded-lg bg-background-muted border border-default"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">Step: {step.stepName}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {step.errorCode}: {step.errorMessage}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-muted shrink-0">
                    {formatTimestamp(step.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            title="No recent errors"
            description="All recent executions completed successfully."
            className="py-8"
          />
        )}
      </div>
    </div>
  );
}
