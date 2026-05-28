'use client';

/**
 * TaskCard Component
 *
 * Renders a human task card with type-appropriate action panel:
 * - approval: Approve/Reject buttons
 * - data_entry: Dynamic form from task.fields[]
 * - review: Transcript + notes + approve/reject
 * - decision: Radio buttons from field options + notes
 * - escalation: EscalationPanel with quick resolve
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';
import {
  CheckCircle,
  XCircle,
  Clock,
  User,
  ChevronDown,
  ChevronUp,
  Hand,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import type { HumanTask, HumanTaskPriority } from '../../api/human-tasks';
import { resolveTask, claimTask } from '../../api/human-tasks';
import { useAuthStore } from '../../store/auth-store';
import { useUserName } from '../../hooks/useUserName';
import { sanitizeError } from '../../lib/sanitize-error';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RadioGroup } from '../ui/RadioGroup';
import { DynamicForm } from './DynamicForm';
import { EscalationPanel } from './EscalationPanel';
import { TaskDescription } from './TaskDescription';

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
// CONSTANTS
// =============================================================================

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

const TYPE_CONFIG: Record<string, { label: string; variant: BadgeVariant }> = {
  approval: { label: 'Approval', variant: 'accent' },
  data_entry: { label: 'Data Entry', variant: 'info' },
  review: { label: 'Review', variant: 'warning' },
  decision: { label: 'Decision', variant: 'default' },
  escalation: { label: 'Escalation', variant: 'error' },
};

const PRIORITY_CONFIG: Record<HumanTaskPriority, { label: string; variant: BadgeVariant }> = {
  low: { label: 'Low', variant: 'default' },
  medium: { label: 'Medium', variant: 'info' },
  high: { label: 'High', variant: 'warning' },
  critical: { label: 'Critical', variant: 'error' },
};

// =============================================================================
// HELPERS
// =============================================================================

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return 'Unknown';
  const diffSeconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSeconds < SECONDS_PER_MINUTE) return 'Just now';
  if (diffSeconds < SECONDS_PER_HOUR) return `${Math.floor(diffSeconds / SECONDS_PER_MINUTE)}m ago`;
  if (diffSeconds < SECONDS_PER_DAY) return `${Math.floor(diffSeconds / SECONDS_PER_HOUR)}h ago`;
  return `${Math.floor(diffSeconds / SECONDS_PER_DAY)}d ago`;
}

/** Countdown timer showing time remaining until dueAt */
function formatCountdown(dueAt: string | undefined): string | null {
  if (!dueAt) return null;
  const remainingMs = new Date(dueAt).getTime() - Date.now();
  if (remainingMs <= 0) return 'Overdue';
  const totalSeconds = Math.floor(remainingMs / 1000);
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s left`;
  if (totalSeconds < SECONDS_PER_HOUR) {
    const m = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
    const s = totalSeconds % SECONDS_PER_MINUTE;
    return `${m}m ${s}s left`;
  }
  if (totalSeconds < SECONDS_PER_DAY) {
    const h = Math.floor(totalSeconds / SECONDS_PER_HOUR);
    const m = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return `${h}h ${m}m left`;
  }
  const d = Math.floor(totalSeconds / SECONDS_PER_DAY);
  const h = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  return `${d}d ${h}h left`;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function ClaimedByDisplay({ userId }: { userId: string }) {
  const name = useUserName(userId);
  return (
    <span className="flex items-center gap-1">
      <User className="w-3 h-3" />
      {name ?? userId}
    </span>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

interface TaskCardProps {
  task: HumanTask;
  projectId: string;
  onResolved: () => void;
}

export function TaskCard({ task, projectId, onResolved }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState<string | false>(false);
  const [claiming, setClaiming] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [selectedDecision, setSelectedDecision] = useState('');
  const respondedByName = useUserName(task.response?.respondedBy);
  const currentUser = useAuthStore((s) => s.user);
  const currentUserId = currentUser?.id;

  // Live countdown ticker — updates every second when task has a deadline
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActive =
    task.status === 'pending' || task.status === 'assigned' || task.status === 'in_progress';
  const hasDueAt = !!task.dueAt;
  useEffect(() => {
    if (isActive && hasDueAt) {
      tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
      return () => {
        if (tickRef.current) clearInterval(tickRef.current);
      };
    }
    return undefined;
  }, [isActive, hasDueAt]);

  const typeConfig = TYPE_CONFIG[task.type] ?? {
    label: task.type,
    variant: 'default' as BadgeVariant,
  };
  const priorityConfig = PRIORITY_CONFIG[task.priority];
  const countdownText = formatCountdown(task.dueAt);
  const isCompleted =
    task.status === 'completed' || task.status === 'expired' || task.status === 'cancelled';

  // Claim logic.
  //   - `assignedTo` empty/absent       → open pool, needs claim
  //   - `assignedTo` length 1 & is me   → direct assignment, no claim needed
  //   - `assignedTo` length ≥ 2 & has me → scoped pool, I still need to claim
  // `canAct` flips true once I either hold the direct assignment or have claimed it.
  const assignedList = task.assignedTo ?? [];
  const isDirectlyAssigned = assignedList.length === 1 && assignedList[0] === currentUserId;
  const isClaimedByMe = task.claimedBy === currentUserId;
  const needsClaim = !isCompleted && !isDirectlyAssigned && !isClaimedByMe;
  const canAct = !isCompleted && (isDirectlyAssigned || isClaimedByMe);

  const handleResolve = useCallback(
    async (
      data: { fields?: Record<string, unknown>; notes?: string; decision?: string },
      action = 'resolve',
    ) => {
      setResolving(action);
      try {
        await resolveTask(projectId, task._id, data);
        toast.success(`Resolved: ${task.title}`);
        onResolved();
      } catch (err) {
        toast.error(`Failed: ${sanitizeError(err, 'Resolution failed')}`);
      } finally {
        setResolving(false);
      }
    },
    [projectId, task._id, task.title, onResolved],
  );

  const handleClaim = useCallback(async () => {
    setClaiming(true);
    try {
      await claimTask(projectId, task._id);
      toast.success(`Claimed: ${task.title}`);
      onResolved(); // refresh to get updated task state
    } catch (err) {
      toast.error(`Failed to claim: ${sanitizeError(err, 'Claim failed')}`);
    } finally {
      setClaiming(false);
    }
  }, [projectId, task._id, task.title, onResolved]);

  const handleApproval = useCallback(
    (approved: boolean) => {
      handleResolve(
        {
          decision: approved ? 'approved' : 'rejected',
          notes: decisionNotes || undefined,
        },
        approved ? 'approve' : 'reject',
      );
    },
    [handleResolve, decisionNotes],
  );

  const handleFormSubmit = useCallback(
    (values: Record<string, unknown>) => {
      handleResolve({ fields: values });
    },
    [handleResolve],
  );

  const handleDecisionSubmit = useCallback(() => {
    if (!selectedDecision) return;
    handleResolve({ decision: selectedDecision, notes: decisionNotes || undefined });
  }, [handleResolve, selectedDecision, decisionNotes]);

  const handleEscalationResolve = useCallback(
    (notes: string) => {
      handleResolve({ notes, decision: 'resolved' });
    },
    [handleResolve],
  );

  // Derive decision label and badge variant for completed tasks
  const responseDecision = task.response?.decision;
  const decisionDisplay = isCompleted
    ? responseDecision === 'approved'
      ? { label: 'Approved', variant: 'success' as BadgeVariant }
      : responseDecision === 'rejected'
        ? { label: 'Rejected', variant: 'error' as BadgeVariant }
        : responseDecision === 'resolved'
          ? { label: 'Resolved', variant: 'info' as BadgeVariant }
          : responseDecision === 'expired'
            ? { label: 'Expired', variant: 'warning' as BadgeVariant }
            : task.status === 'expired'
              ? { label: 'Expired', variant: 'warning' as BadgeVariant }
              : task.status === 'cancelled'
                ? { label: 'Cancelled', variant: 'default' as BadgeVariant }
                : responseDecision
                  ? {
                      label: responseDecision.charAt(0).toUpperCase() + responseDecision.slice(1),
                      variant: 'info' as BadgeVariant,
                    }
                  : { label: 'Completed', variant: 'success' as BadgeVariant }
    : null;

  // Show priority badge only for agent escalation tasks
  const showPriority = task.type === 'escalation';

  return (
    <div
      data-testid="human-task-card"
      data-task-id={task._id}
      data-task-type={task.type}
      data-task-status={task.status}
      className={clsx(
        'rounded-xl border bg-background-elevated transition-default',
        isCompleted
          ? 'border-default opacity-60'
          : 'border-default hover:border-accent/30 hover:shadow-sm',
        task.slaBreachedAt && !isCompleted && 'border-error/40',
      )}
    >
      {/* Header — collapsed view */}
      <button
        data-testid="human-task-card-toggle"
        className="w-full p-4 text-left flex items-start gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground truncate">{task.title}</h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant={typeConfig.variant}>{typeConfig.label}</Badge>
            {showPriority && <Badge variant={priorityConfig.variant}>{priorityConfig.label}</Badge>}
            {countdownText && !isCompleted && (
              <Badge variant={countdownText === 'Overdue' ? 'error' : 'warning'}>
                <Clock className="w-3 h-3 mr-0.5 inline" />
                {countdownText}
                {task.onTimeout === 'skip'
                  ? ' · skip on timeout'
                  : task.onTimeout === 'terminate'
                    ? ' · fails on timeout'
                    : ''}
              </Badge>
            )}
            <span className="text-xs text-muted">{formatRelativeTime(task.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-start gap-2 shrink-0 mt-0.5">
          {decisionDisplay && (
            <Badge variant={decisionDisplay.variant}>{decisionDisplay.label}</Badge>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted mt-0.5" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted mt-0.5" />
          )}
        </div>
      </button>

      {/* Expanded action panel */}
      {expanded && !isCompleted && (
        <div className="px-4 pb-4 border-t border-default pt-3">
          {/* Description — only show if meaningfully different from title */}
          {task.description &&
            task.description.trim().toLowerCase() !== task.title.trim().toLowerCase() && (
              <TaskDescription content={task.description} className="mb-3" />
            )}

          {/* Linked ITSM ticket (set by connector action) */}
          {task.connectorTicketUrl && (
            <a
              href={task.connectorTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline mb-3"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View ticket{task.connectorTicketId ? ` ${task.connectorTicketId}` : ''}
            </a>
          )}

          {/* Claim button for pool tasks */}
          {needsClaim && (
            <div className="flex flex-col items-center gap-2 py-3">
              <p className="text-xs text-muted">This task is available for anyone to pick up.</p>
              <Button
                variant="primary"
                size="sm"
                icon={<Hand className="w-4 h-4" />}
                onClick={handleClaim}
                loading={claiming}
              >
                Claim Task
              </Button>
            </div>
          )}

          {/* Approval actions */}
          {canAct && task.type === 'approval' && (
            <div className="space-y-3" data-testid="human-task-approval-panel">
              <textarea
                data-testid="human-task-notes"
                value={decisionNotes}
                onChange={(e) => setDecisionNotes(e.target.value)}
                rows={2}
                placeholder="Optional notes..."
                className={clsx(
                  'w-full px-3 py-2 text-sm rounded-lg border border-default',
                  'bg-background-muted text-foreground placeholder:text-muted',
                  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 resize-none',
                )}
              />
              <div className="flex gap-2">
                <Button
                  data-testid="human-task-approve"
                  variant="primary"
                  size="sm"
                  icon={<CheckCircle className="w-4 h-4" />}
                  onClick={() => handleApproval(true)}
                  loading={resolving === 'approve'}
                  disabled={!!resolving}
                >
                  Approve
                </Button>
                <Button
                  data-testid="human-task-reject"
                  variant="secondary"
                  size="sm"
                  icon={<XCircle className="w-4 h-4" />}
                  onClick={() => handleApproval(false)}
                  loading={resolving === 'reject'}
                  disabled={!!resolving}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}

          {/* Data entry form */}
          {canAct && task.type === 'data_entry' && (
            <DynamicForm
              fields={task.fields}
              onSubmit={handleFormSubmit}
              submitting={!!resolving}
              submitLabel="Submit Data"
            />
          )}

          {/* Review actions */}
          {canAct && task.type === 'review' && (
            <div className="space-y-3">
              {/* Context display */}
              {task.context && Object.keys(task.context).length > 0 && (
                <div className="rounded-lg border border-default bg-background-muted p-3 max-h-32 overflow-y-auto">
                  <p className="text-xs font-medium text-muted mb-1">Context</p>
                  <pre className="text-xs text-foreground whitespace-pre-wrap">
                    {JSON.stringify(task.context, null, 2)}
                  </pre>
                </div>
              )}
              <textarea
                value={decisionNotes}
                onChange={(e) => setDecisionNotes(e.target.value)}
                rows={3}
                placeholder="Review notes..."
                className={clsx(
                  'w-full px-3 py-2 text-sm rounded-lg border border-default',
                  'bg-background-muted text-foreground placeholder:text-muted',
                  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 resize-none',
                )}
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<CheckCircle className="w-4 h-4" />}
                  onClick={() => handleApproval(true)}
                  loading={resolving === 'approve'}
                  disabled={!!resolving}
                >
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<XCircle className="w-4 h-4" />}
                  onClick={() => handleApproval(false)}
                  loading={resolving === 'reject'}
                  disabled={!!resolving}
                >
                  Reject
                </Button>
              </div>
            </div>
          )}

          {/* Decision actions */}
          {canAct && task.type === 'decision' && (
            <div className="space-y-3">
              {/* Radio options from first select field */}
              {task.fields
                .filter((f) => f.type === 'select' && f.options)
                .slice(0, 1)
                .map((field) => (
                  <RadioGroup
                    key={field.name}
                    label={field.label}
                    options={(field.options ?? []).map((opt) =>
                      typeof opt === 'string' ? { value: opt, label: opt } : opt,
                    )}
                    value={selectedDecision}
                    onChange={(v) => setSelectedDecision(v)}
                    name={`decision-${task._id}`}
                  />
                ))}
              <textarea
                value={decisionNotes}
                onChange={(e) => setDecisionNotes(e.target.value)}
                rows={2}
                placeholder="Decision notes..."
                className={clsx(
                  'w-full px-3 py-2 text-sm rounded-lg border border-default',
                  'bg-background-muted text-foreground placeholder:text-muted',
                  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 resize-none',
                )}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleDecisionSubmit}
                loading={!!resolving}
                disabled={!selectedDecision || !!resolving}
              >
                Submit Decision
              </Button>
            </div>
          )}

          {/* Escalation panel */}
          {canAct && task.type === 'escalation' && (
            <EscalationPanel
              task={task}
              onResolve={handleEscalationResolve}
              resolving={!!resolving}
            />
          )}
        </div>
      )}

      {/* Read-only resolution detail for completed tasks */}
      {expanded && isCompleted && (
        <div className="px-4 pb-4 border-t border-default pt-3 space-y-2">
          {task.description &&
            task.description.trim().toLowerCase() !== task.title.trim().toLowerCase() && (
              <TaskDescription content={task.description} />
            )}

          {/* Linked ITSM ticket (set by connector action) */}
          {task.connectorTicketUrl && (
            <a
              href={task.connectorTicketUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View ticket{task.connectorTicketId ? ` ${task.connectorTicketId}` : ''}
            </a>
          )}

          {/* Reason — inline on same line */}
          {task.response?.notes && (
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs font-medium text-muted shrink-0">Reason:</span>
              <span className="text-sm text-foreground-muted">{task.response.notes}</span>
            </div>
          )}

          {/* Form fields (for data_entry / decision types) */}
          {task.response?.fields && Object.keys(task.response.fields).length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted">Response:</span>
              <div className="mt-1 rounded-lg border border-default bg-background-muted p-3 max-h-40 overflow-y-auto space-y-1.5">
                {Object.entries(task.response.fields).map(([key, value]) => {
                  const fieldDef = task.fields?.find((f) => f.name === key);
                  const label = fieldDef?.label ?? key;
                  // Resolve select option labels
                  let displayValue: string;
                  if (fieldDef?.type === 'select' && fieldDef.options) {
                    const opt = fieldDef.options.find(
                      (o) => (typeof o === 'string' ? o : o.value) === value,
                    );
                    displayValue = opt
                      ? typeof opt === 'string'
                        ? opt
                        : opt.label
                      : String(value ?? '');
                  } else if (typeof value === 'boolean') {
                    displayValue = value ? 'Yes' : 'No';
                  } else {
                    displayValue = String(value ?? '');
                  }
                  return (
                    <div key={key} className="flex items-baseline gap-1.5">
                      <span className="text-xs font-medium text-muted shrink-0">{label}:</span>
                      <span className="text-sm text-foreground-muted">{displayValue}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Approved/Rejected by + time */}
          {task.response?.respondedBy && (
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span className="font-medium">
                {task.response.decision === 'approved'
                  ? 'Approved by:'
                  : task.response.decision === 'rejected'
                    ? 'Rejected by:'
                    : task.response.decision === 'cancelled'
                      ? 'Cancelled by:'
                      : 'Resolved by:'}
              </span>
              <span className="flex items-center gap-1">
                <User className="w-3 h-3" />
                {respondedByName ?? task.response.respondedBy}
              </span>
              {task.response.respondedAt && (
                <span className="text-muted/70">
                  at {formatDateTime(task.response.respondedAt)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Claimed by info for active tasks (shown when task is claimed but not yet resolved) */}
      {expanded && !isCompleted && task.claimedBy && (
        <div className="px-4 pb-3 flex items-center gap-1.5 text-xs text-muted">
          <span className="font-medium">Claimed by:</span>
          <ClaimedByDisplay userId={task.claimedBy} />
          {task.claimedAt && (
            <span className="text-muted/70">at {formatDateTime(task.claimedAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}
