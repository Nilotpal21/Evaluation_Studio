/**
 * StepsList Component
 *
 * Renders pipeline run steps with status icons, names, durations,
 * expandable output, and — for failed steps — an interpreted diagnosis
 * with "Open in editor" / "Re-drive" action buttons.
 */

'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { RunStatusIcon } from './RunStatusIcon';
import { JsonViewer } from '../../ui/JsonViewer';
import { interpretRunError } from '../../../lib/pipeline-run-error-interpreter';
import { apiFetch } from '../../../lib/api-client';
import type { RunStep } from './types';

interface StepsListProps {
  steps: RunStep[];
  failedStepId?: string;
  /** Required for action buttons. */
  runId?: string;
  pipelineId?: string;
  projectId?: string;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function extractError(output?: Record<string, unknown>): string | null {
  if (!output) return null;
  if (typeof output.error === 'string') return output.error;
  if (output.error && typeof (output.error as { message?: unknown }).message === 'string') {
    return (output.error as { message: string }).message;
  }
  return null;
}

export function StepsList({ steps, failedStepId, runId, pipelineId, projectId }: StepsListProps) {
  const t = useTranslations('pipelines');
  const router = useRouter();
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (failedStepId) initial.add(failedStepId);
    return initial;
  });
  const [redriving, setRedriving] = useState(false);
  const [redriveError, setRedriveError] = useState<string | null>(null);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const handleOpenInEditor = useCallback(
    (stepId: string) => {
      if (!pipelineId || !projectId) return;
      router.push(
        `/projects/${projectId}/pipelines/${pipelineId}?selectedNodeId=${encodeURIComponent(stepId)}`,
      );
    },
    [router, pipelineId, projectId],
  );

  const handleRedrive = useCallback(async () => {
    if (!runId) return;
    setRedriving(true);
    setRedriveError(null);
    try {
      const resp = await apiFetch(`/api/pipelines/runs/${encodeURIComponent(runId)}/redrive`, {
        method: 'POST',
      });
      if (!resp.ok) {
        const body = (await resp.json()) as { error?: string };
        setRedriveError(body.error ?? 'Re-drive failed');
      } else {
        const body = (await resp.json()) as { runId?: string };
        if (body.runId && pipelineId && projectId) {
          router.push(`/projects/${projectId}/pipelines`);
        }
      }
    } catch (err) {
      setRedriveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRedriving(false);
    }
  }, [runId, pipelineId, projectId, router]);

  if (!steps || steps.length === 0) {
    return <p className="text-sm text-muted py-4">{t('run_detail.no_steps')}</p>;
  }

  return (
    <div className="space-y-1">
      {redriveError && (
        <div className="text-xs text-error bg-error-subtle border border-error/20 rounded px-3 py-2 mb-1">
          {redriveError}
        </div>
      )}
      {steps.map((step, idx) => {
        const isExpanded = expandedSteps.has(step.id);
        const hasOutput = step.output && Object.keys(step.output).length > 0;
        const iconStatus =
          step.status === 'skipped'
            ? ('cancelled' as const)
            : (step.status as 'pending' | 'running' | 'completed' | 'failed' | 'cancelled');
        const isFailed = step.status === 'failed';
        const errorText = isFailed ? extractError(step.output) : null;
        const interpretation = errorText ? interpretRunError(errorText) : null;

        return (
          <div key={step.id} className="border border-default rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggleStep(step.id)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-default',
                'hover:bg-background-muted',
                step.id === failedStepId && 'bg-error-subtle/30',
              )}
            >
              <span className="text-xs text-muted w-5 text-right">{idx + 1}</span>
              <RunStatusIcon status={iconStatus} className="shrink-0" />
              <span className="flex-1 text-sm font-medium text-foreground truncate">
                {step.name}
              </span>
              <span className="text-xs text-muted">{formatDuration(step.durationMs)}</span>
              {hasOutput &&
                (isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-muted" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-muted" />
                ))}
            </button>

            {isExpanded && (
              <div className="px-3 pb-3 pt-1 border-t border-default bg-background-subtle space-y-2">
                {/* Interpreted diagnosis for failed steps */}
                {interpretation && (
                  <div className="bg-warning-subtle border-l-2 border-warning rounded-sm px-3 py-2 text-xs text-foreground space-y-2">
                    <p>{interpretation.diagnosis}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {interpretation.action === 'open-in-editor' && pipelineId && (
                        <button
                          type="button"
                          onClick={() => handleOpenInEditor(step.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-background border border-default hover:bg-background-muted transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {interpretation.actionLabel ?? 'Open in editor'}
                        </button>
                      )}
                      {(interpretation.action === 'redrive' ||
                        interpretation.action === 'open-in-editor') &&
                        runId && (
                          <button
                            type="button"
                            onClick={handleRedrive}
                            disabled={redriving}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-background border border-default hover:bg-background-muted transition-colors disabled:opacity-50"
                          >
                            <RefreshCw className={clsx('w-3 h-3', redriving && 'animate-spin')} />
                            {redriving ? 'Re-driving…' : 'Re-drive with same input'}
                          </button>
                        )}
                    </div>
                  </div>
                )}

                {/* Raw output JSON viewer */}
                {hasOutput && <JsonViewer data={step.output} copyable />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
