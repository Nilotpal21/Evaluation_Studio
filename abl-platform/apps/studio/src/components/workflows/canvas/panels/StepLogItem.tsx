'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { ExecutionStepResult } from '../../../../api/workflows';
import { useUserName } from '../../../../hooks/useUserName';
import { useUserNames } from '../../../../hooks/useUserNames';
import { JsonViewer } from '../../../ui/JsonViewer';
import { HttpStepDetail } from './HttpStepDetail';
import { ConditionStepDetail } from './ConditionStepDetail';

// =============================================================================
// Parallel step types (mirrored from workflow-engine parallel-executor)
// =============================================================================

interface BranchResult {
  name: string;
  status: 'completed' | 'failed';
  output?: unknown;
  error?: { code: string; message: string };
}

interface ParallelResult {
  branches: BranchResult[];
  allSucceeded: boolean;
}

/** Format an ISO date to "2 Jan 2026, 11:30:45 AM" in browser timezone */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

// =============================================================================
// Helpers
// =============================================================================

function StepStatusIcon({ status }: { status: ExecutionStepResult['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-accent animate-spin" />;
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-success" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-error" />;
    case 'skipped':
      return <MinusCircle className="w-4 h-4 text-muted" />;
    case 'cancelled':
      return <XCircle className="w-4 h-4 text-muted" />;
    case 'waiting_human_task':
    case 'waiting_approval':
    case 'waiting_delay':
    case 'waiting_callback':
      return <Clock className="w-4 h-4 text-warning animate-pulse" />;
    case 'rejected':
      return <XCircle className="w-4 h-4 text-error" />;
    case 'approved':
      return <CheckCircle2 className="w-4 h-4 text-success" />;
    case 'pending':
    default:
      return <Clock className="w-4 h-4 text-muted" />;
  }
}

const STEP_STATUS_KEYS: Record<string, string> = {
  running: 'step_status.running',
  completed: 'step_status.completed',
  failed: 'step_status.failed',
  skipped: 'step_status.skipped',
  cancelled: 'step_status.cancelled',
  waiting_human_task: 'step_status.waiting_human_task',
  waiting_approval: 'step_status.waiting_approval',
  waiting_delay: 'step_status.waiting_delay',
  waiting_callback: 'step_status.waiting_callback',
  pending: 'step_status.pending',
};

function getStepStatusBadge(status: ExecutionStepResult['status']): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'running':
      return { label: 'Running', className: 'bg-accent/10 text-accent' };
    case 'completed':
      return { label: 'Completed', className: 'bg-success/10 text-success' };
    case 'failed':
      return { label: 'Failed', className: 'bg-error/10 text-error' };
    case 'skipped':
      return { label: 'Skipped', className: 'bg-muted/10 text-muted' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-muted/10 text-muted' };
    case 'waiting_human_task':
      return { label: 'Awaiting Human', className: 'bg-warning/10 text-warning' };
    case 'waiting_approval':
      return { label: 'Awaiting Approval', className: 'bg-warning/10 text-warning' };
    case 'waiting_delay':
      return { label: 'Waiting Delay', className: 'bg-warning/10 text-warning' };
    case 'waiting_callback':
      return { label: 'Awaiting Callback', className: 'bg-warning/10 text-warning' };
    case 'rejected':
      return { label: 'Rejected', className: 'bg-error/10 text-error' };
    case 'approved':
      return { label: 'Approved', className: 'bg-success/10 text-success' };
    case 'pending':
    default:
      return { label: 'Pending', className: 'bg-muted/10 text-muted' };
  }
}

/**
 * Render the engine's `_status` / `_reason` convention.
 *
 * The workflow-handler emits step/execution outputs with `_status` (0 = success,
 * non-zero = failure/reject/timeout) and `_reason` (human-readable explanation).
 * See `apps/workflow-engine/src/handlers/workflow-handler.ts:buildFailureOutput`.
 */
function StatusReasonBanner({ output }: { output: Record<string, unknown> }) {
  const rawStatus = output._status;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const reason = typeof output._reason === 'string' ? (output._reason as string) : undefined;
  if (status === undefined && !reason) return null;
  const isFailure = status !== undefined && status !== 0;
  return (
    <div
      className={clsx(
        'rounded-md border p-2 mb-2 flex items-start gap-2',
        isFailure
          ? 'border-error/30 bg-error/5 text-error'
          : 'border-success/30 bg-success/5 text-success',
      )}
    >
      {isFailure ? (
        <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
      ) : (
        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold">
          {isFailure ? `Status ${status ?? '?'}` : 'Success'}
        </div>
        {reason && <div className="text-xs mt-0.5 break-words">{reason}</div>}
      </div>
    </div>
  );
}

function HumanTaskOutput({ response }: { response: Record<string, unknown> }) {
  const decision = response.decision as string | undefined;
  const notes = response.notes as string | undefined;
  const respondedById = response.respondedBy as string | undefined;
  const respondedAt = response.respondedAt as string | undefined;
  const fields = response.fields as Record<string, unknown> | undefined;
  const isApproved = decision === 'approved';
  const isRejected = decision === 'rejected';
  const respondedByName = useUserName(respondedById);

  return (
    <div className="rounded-md border border-default bg-background p-3 space-y-2">
      {/* Decision badge */}
      {decision && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Approval:</span>
          <span
            className={clsx(
              'text-xs font-semibold px-2 py-0.5 rounded-full',
              isApproved && 'bg-success/10 text-success',
              isRejected && 'bg-error/10 text-error',
              !isApproved && !isRejected && 'bg-accent/10 text-accent',
            )}
          >
            {decision.charAt(0).toUpperCase() + decision.slice(1)}
          </span>
        </div>
      )}
      {/* Reason / Notes — inline */}
      {notes && (
        <div className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-muted shrink-0">Reason:</span>
          <span className="text-xs text-foreground-muted">{notes}</span>
        </div>
      )}
      {/* Form fields (if any) */}
      {fields && Object.keys(fields).length > 0 && (
        <div>
          <span className="text-xs font-medium text-muted">Fields:</span>
          <div className="mt-1">
            <JsonViewer data={fields} copyable />
          </div>
        </div>
      )}
      {/* Responded by / at */}
      {(respondedById || respondedAt) && (
        <div className="flex items-center gap-3 text-[10px] text-muted pt-1 border-t border-default">
          {respondedById && <span>By: {respondedByName ?? respondedById}</span>}
          {respondedAt && <span>At: {formatDateTime(respondedAt)}</span>}
        </div>
      )}
    </div>
  );
}

/** Fields that should show a friendly label instead of null */
const NULL_DISPLAY_MAP: Record<string, string> = {
  assignTo: 'Not assigned',
  assignedTo: 'Not assigned',
  claimedBy: 'Not claimed',
  assignedToTeam: 'Not assigned',
};

/** Fields whose string values are user IDs that should be resolved to names */
const USER_ID_FIELDS = new Set(['assignTo', 'assignedTo', 'claimedBy', 'respondedBy', 'decidedBy']);

/** Collect all user IDs from known fields in a data object */
function collectUserIds(data: unknown, ids: Set<string>): void {
  if (data === null || data === undefined) return;
  if (Array.isArray(data)) {
    for (const item of data) collectUserIds(item, ids);
    return;
  }
  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (USER_ID_FIELDS.has(k) && typeof v === 'string' && v.length > 0) {
        ids.add(v);
      }
      collectUserIds(v, ids);
    }
  }
}

/** Strip null/undefined optional fields, replace with friendly text, resolve user IDs */
function cleanForDisplay(data: unknown, userNames?: Record<string, string>): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map((v) => cleanForDisplay(v, userNames));
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if ((v === null || v === undefined) && k in NULL_DISPLAY_MAP) {
        result[k] = NULL_DISPLAY_MAP[k];
      } else if (Array.isArray(v) && v.length === 0 && k in NULL_DISPLAY_MAP) {
        result[k] = NULL_DISPLAY_MAP[k];
      } else if (USER_ID_FIELDS.has(k) && typeof v === 'string' && userNames?.[v]) {
        result[k] = userNames[v];
      } else {
        result[k] = cleanForDisplay(v, userNames);
      }
    }
    return result;
  }
  return data;
}

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '\u2014';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// =============================================================================
// Parallel detail components
// =============================================================================

function ParallelBranchRow({ branch }: { branch: BranchResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = branch.output != null || branch.error != null;

  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        className={clsx(
          'w-full flex items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-background-muted',
          expanded && 'bg-background-muted/50',
        )}
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
      >
        {branch.status === 'completed' ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-error shrink-0" />
        )}
        <span className="flex-1 text-xs font-medium text-foreground">{branch.name}</span>
        {hasDetail &&
          (expanded ? (
            <ChevronDown className="w-3 h-3 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted shrink-0" />
          ))}
      </button>

      {expanded && hasDetail && (
        <div className="border-t border-default px-2.5 py-2 space-y-2">
          {branch.error && (
            <div className="px-2 py-1.5 rounded bg-error/5 border border-error/20">
              <p className="text-xs font-medium text-error">{branch.error.code}</p>
              <p className="text-xs text-error/80 mt-0.5">{branch.error.message}</p>
            </div>
          )}
          {branch.output != null && (
            <div className="rounded border border-default bg-background p-2 max-h-[150px] overflow-y-auto">
              {typeof branch.output === 'object' ? (
                <JsonViewer data={branch.output as Record<string, unknown>} copyable />
              ) : (
                <pre className="text-xs text-foreground-muted whitespace-pre-wrap break-all">
                  {String(branch.output)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ParallelStepDetail({ output }: { output: unknown }) {
  const result = output != null && typeof output === 'object' ? (output as ParallelResult) : null;
  const branches = Array.isArray(result?.branches) ? result.branches : null;

  if (!branches?.length) {
    return (
      <div className="rounded-md border border-default bg-background p-2 max-h-[200px] overflow-y-auto">
        <JsonViewer data={output as Record<string, unknown>} copyable />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {branches.map((branch) => (
        <ParallelBranchRow key={branch.name} branch={branch} />
      ))}
    </div>
  );
}

// =============================================================================
// Props
// =============================================================================

interface StepLogItemProps {
  step: ExecutionStepResult;
  defaultExpanded?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function StepLogItem({ step, defaultExpanded = false }: StepLogItemProps) {
  const t = useTranslations('workflows.monitor');
  const isRunning = step.status === 'running';
  const isWaiting = step.status === 'waiting_human_task' || step.status === 'waiting_approval';
  const isFailed = step.status === 'failed';
  const isWaitingCallback = step.status === 'waiting_callback';
  const [expanded, setExpanded] = useState(defaultExpanded || isRunning || isWaiting);

  // When a step transitions from active (running/waiting) → terminal, auto-collapse
  // completed steps and auto-expand failed steps so errors are immediately visible.
  const wasActiveRef = useRef(isRunning || isWaiting);
  useEffect(() => {
    const isActive = isRunning || isWaiting;
    if (wasActiveRef.current && !isActive) {
      setExpanded(isFailed);
    }
    wasActiveRef.current = isActive;
  }, [isRunning, isWaiting, isFailed]);
  // Running/waiting steps always have detail, plus completed/failed steps with data
  const hasDetail =
    isRunning || isWaiting || step.input != null || step.output != null || step.error != null;
  const duration = formatDuration(step.startedAt, step.completedAt);

  // Collect user IDs from step input for name resolution
  const inputUserIds = useMemo(() => {
    const ids = new Set<string>();
    if (step.input && typeof step.input === 'object') {
      collectUserIds(step.input, ids);
    }
    return Array.from(ids);
  }, [step.input]);
  const inputUserNames = useUserNames(inputUserIds);

  // HTTP status code for the header badge
  const httpStatus =
    step.nodeType === 'http'
      ? (((step.output as Record<string, unknown> | null)?.statusCode as number | undefined) ??
        step.error?.httpStatus)
      : undefined;
  const statusBadge = getStepStatusBadge(step.status);
  const badgeFallback = statusBadge.label;
  const stepStatusLabel = useMemo(() => {
    const key = STEP_STATUS_KEYS[step.status];
    const base = key ? t(key) : badgeFallback;
    if (step.status !== 'waiting_human_task') return base;
    const input = step.input as Record<string, unknown> | null | undefined;
    const taskType = typeof input?.taskType === 'string' ? input.taskType : undefined;
    switch (taskType) {
      case 'approval':
        return t('step_status.waiting_approval');
      case 'data_entry':
        return t('step_status.waiting_data_entry');
      case 'review':
        return t('step_status.waiting_review');
      case 'decision':
        return t('step_status.waiting_decision');
      default:
        return base;
    }
  }, [step.status, step.input, t, badgeFallback]);

  return (
    <div className="border border-default rounded-lg overflow-hidden bg-background-elevated">
      {/* Header row */}
      <button
        type="button"
        className={clsx(
          'w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors',
          'hover:bg-background-muted',
          expanded && 'bg-background-muted/50',
        )}
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
      >
        <StepStatusIcon status={step.status} />
        <span className="flex-1 text-sm font-medium text-foreground truncate">{step.stepName}</span>
        {/* Step status pill — shows current step state. For waiting_human_task,
            stepStatusLabel above refines the generic "Awaiting Human" into the
            configured taskType (Approval / Data Entry / Review / Decision). */}
        <span
          className={clsx(
            'text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0',
            statusBadge.className,
          )}
        >
          {stepStatusLabel}
        </span>
        {/* HTTP status badge */}
        {httpStatus != null && (
          <span
            className={clsx(
              'text-[10px] font-mono px-1 py-0.5 rounded shrink-0',
              httpStatus < 300
                ? 'bg-success/10 text-success'
                : httpStatus < 400
                  ? 'bg-warning/10 text-warning'
                  : 'bg-error/10 text-error',
            )}
          >
            {httpStatus}
          </span>
        )}
        <span className="text-xs font-mono text-muted shrink-0">{duration}</span>
        {hasDetail &&
          (expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
          ))}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-default px-3 py-3 space-y-3">
          {/* Input section — shown for all node types (with loader while running) */}
          {step.nodeType !== 'http' &&
            step.nodeType !== 'condition' &&
            step.nodeType !== 'parallel' && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                  Input
                </p>
                {step.input != null ? (
                  <div className="rounded-md border border-default bg-background p-2 max-h-[200px] overflow-y-auto">
                    {typeof step.input === 'object' ? (
                      <JsonViewer
                        data={
                          cleanForDisplay(step.input, inputUserNames) as Record<string, unknown>
                        }
                        copyable
                      />
                    ) : (
                      <pre className="text-xs text-foreground-muted whitespace-pre-wrap break-all">
                        {String(step.input)}
                      </pre>
                    )}
                  </div>
                ) : isRunning ? (
                  <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-default bg-background">
                    <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
                    <span className="text-xs text-muted">Preparing input data...</span>
                  </div>
                ) : null}
              </div>
            )}

          {/* Type-aware detail sections */}
          {step.nodeType === 'http' ? (
            <HttpStepDetail
              request={step.input as Record<string, unknown> | undefined}
              response={step.output as Record<string, unknown> | undefined}
              error={step.error}
              metrics={step.metrics}
              isRunning={isRunning}
            />
          ) : step.nodeType === 'condition' ? (
            isRunning && !step.output ? (
              <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-default bg-background">
                <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
                <span className="text-xs text-muted">Evaluating condition...</span>
              </div>
            ) : (
              <ConditionStepDetail output={step.output as Record<string, unknown> | undefined} />
            )
          ) : step.nodeType === 'parallel' ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                Branches
              </p>
              {step.output != null ? (
                <ParallelStepDetail output={step.output} />
              ) : isRunning ? (
                <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-default bg-background">
                  <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
                  <span className="text-xs text-muted">Running parallel branches...</span>
                </div>
              ) : null}
            </div>
          ) : (
            <>
              {/* Generic Output */}
              {step.output != null ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                    Output
                  </p>
                  {/* Human task response: show approval/rejection summary */}
                  {step.nodeType === 'human_task' &&
                  typeof step.output === 'object' &&
                  (step.output as Record<string, unknown>)?.humanTaskResponse ? (
                    <HumanTaskOutput
                      response={
                        (step.output as Record<string, unknown>).humanTaskResponse as Record<
                          string,
                          unknown
                        >
                      }
                    />
                  ) : (
                    <>
                      {isWaitingCallback && (
                        <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-warning/20 bg-warning/5 mb-2">
                          <Clock className="w-3 h-3 text-warning shrink-0" />
                          <span className="text-xs text-warning">
                            Awaiting callback. Current output is the initial handoff response, not
                            the final tool result.
                          </span>
                        </div>
                      )}
                      {typeof step.output === 'object' && step.output !== null && (
                        <StatusReasonBanner output={step.output as Record<string, unknown>} />
                      )}
                      <div className="rounded-md border border-default bg-background p-2 max-h-[200px] overflow-y-auto">
                        {typeof step.output === 'object' ? (
                          <JsonViewer data={step.output} copyable />
                        ) : (
                          <pre className="text-xs text-foreground-muted whitespace-pre-wrap break-all">
                            {String(step.output)}
                          </pre>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : isWaiting ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                    Output
                  </p>
                  <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-warning/20 bg-warning/5">
                    <Clock className="w-3 h-3 text-warning shrink-0" />
                    <span className="text-xs text-warning">Waiting for human response...</span>
                  </div>
                </div>
              ) : isRunning && step.nodeType !== 'delay' && step.nodeType !== 'async_webhook' ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                    Output
                  </p>
                  <div className="flex items-center gap-2 py-2 px-3 rounded-md border border-default bg-background">
                    <Loader2 className="w-3 h-3 text-accent animate-spin shrink-0" />
                    <span className="text-xs text-muted">Processing...</span>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {/* Error display (all step types) */}
          {step.error && (
            <div className="px-3 py-2 rounded-md bg-error/5 border border-error/20">
              <p className="text-xs font-medium text-error break-words">{step.error.code}</p>
              <p className="text-xs text-error/80 mt-0.5 break-words">{step.error.message}</p>
            </div>
          )}

          {/* Metrics (all step types) */}
          {step.startedAt && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
                Metrics
              </p>
              <div className="flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted w-16 shrink-0">Initiated</span>
                  <span className="font-mono text-foreground-muted">
                    {formatDateTime(step.startedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted w-16 shrink-0">Completed</span>
                  <span className="font-mono text-foreground-muted">
                    {step.completedAt ? formatDateTime(step.completedAt) : '\u2014'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted w-16 shrink-0">Duration</span>
                  <span className="font-mono text-foreground-muted">{duration}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
