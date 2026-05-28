'use client';

import { useState, useMemo } from 'react';
import { X, Code, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { contextStepsToResults } from '../../../../api/workflows';
import type { WorkflowExecution } from '../../../../api/workflows';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { useUserNames } from '../../../../hooks/useUserNames';
import { DebugFlowLog } from './DebugFlowLog';
import { JsonViewer } from '../../../ui/JsonViewer';
import { CollapsibleSection } from '../../../ui/JsonViewer';

// =============================================================================
// Types
// =============================================================================

interface WorkflowDebugPanelProps {
  execution: WorkflowExecution | null;
  mode: 'canvas' | 'monitor';
  /** Called to close the panel (monitor mode uses its own close) */
  onClose?: () => void;
  /** Called when the raw JSON toggle changes (monitor mode uses this to resize its SlidePanel) */
  onRawJsonToggle?: (open: boolean) => void;
}

// =============================================================================
// Helpers
// =============================================================================

type ExecStatus = WorkflowExecution['status'];

const STATUS_BADGE: Record<ExecStatus, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-accent/10 text-accent' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success' },
  failed: { label: 'Failed', className: 'bg-error/10 text-error' },
  waiting_approval: { label: 'Awaiting Approval', className: 'bg-warning/10 text-warning' },
  waiting_human: { label: 'Awaiting Human', className: 'bg-warning/10 text-warning' },
  waiting_callback: { label: 'Awaiting Callback', className: 'bg-warning/10 text-warning' },
  cancelled: { label: 'Cancelled', className: 'bg-muted/10 text-muted' },
  rejected: { label: 'Rejected', className: 'bg-error/10 text-error' },
};

const ERROR_CODE_LABELS: Record<string, string> = {
  NO_STEPS: 'Incomplete workflow',
  INPUT_VALIDATION_FAILED: 'Input validation failed',
  WORKFLOW_FAILED: 'Workflow failed',
  WORKFLOW_CANCELLED: 'Workflow cancelled',
  MEMORY_PROJECTION_FAILED: 'Memory load failed',
};

function formatElapsed(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '\u2014';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const USER_ID_KEYS = new Set([
  'respondedBy',
  'triggeredBy',
  'decidedBy',
  'assignedTo',
  'claimedBy',
]);

/** Recursively extract user-ID-looking values from known fields */
function extractUserIds(obj: unknown): string[] {
  const ids = new Set<string>();
  function walk(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (USER_ID_KEYS.has(k) && typeof v === 'string' && v.length > 0) ids.add(v);
      if (typeof v === 'object') walk(v);
    }
  }
  walk(obj);
  return Array.from(ids);
}

/** Fields that should be omitted from display when null/undefined */
const OMIT_WHEN_NULL = new Set(['assignedTo', 'assignTo', 'claimedBy', 'assignedToTeam']);

/** Deep-transform any data: resolve userId fields, format ISO dates, strip null optional fields */
function transformValues(value: unknown, userNames: Record<string, string>, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (key && USER_ID_KEYS.has(key) && userNames[value]) return userNames[value];
    if (ISO_DATE_RE.test(value)) return formatDateTime(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => transformValues(v, userNames));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip null/undefined for optional fields that clutter the display
      if ((v === null || v === undefined) && OMIT_WHEN_NULL.has(k)) continue;
      result[k] = transformValues(v, userNames, k);
    }
    return result;
  }
  return value;
}

/** Enrich arbitrary data (output, finalOutput) with resolved names & formatted dates */
function enrichData(data: unknown, userNames: Record<string, string>): unknown {
  return transformValues(data, userNames);
}

/**
 * Enrich execution context for display:
 * - Replace userId fields with resolved names
 * - Format ISO timestamps as browser-local dates
 * - Add synthetic end step if terminal and missing
 */
function enrichContext(
  context: Record<string, unknown>,
  userNames: Record<string, string>,
  execution: WorkflowExecution,
): Record<string, unknown> {
  const enriched = transformValues(context, userNames) as Record<string, unknown>;

  // Add synthetic end step when execution is terminal but context.steps has no end
  const isTerminal =
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'rejected' ||
    execution.status === 'cancelled';
  if (isTerminal && enriched.steps && typeof enriched.steps === 'object') {
    const steps = enriched.steps as Record<string, unknown>;
    if (!steps.end && !steps.End) {
      steps.end = {
        status: execution.status,
        completedAt: execution.completedAt
          ? formatDateTime(execution.completedAt)
          : formatDateTime(new Date().toISOString()),
        output: execution.output ?? {
          status:
            execution.status === 'completed'
              ? 'Workflow completed'
              : execution.status === 'cancelled'
                ? 'Workflow cancelled'
                : execution.status === 'rejected'
                  ? 'Workflow rejected'
                  : 'Workflow failed',
        },
      };
    }
  }

  return enriched;
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowDebugPanel({
  execution,
  mode,
  onClose,
  onRawJsonToggle,
}: WorkflowDebugPanelProps) {
  const t = useTranslations('workflows.canvas');
  const setDebugPanelOpen = useWorkflowCanvasStore((s) => s.setDebugPanelOpen);
  const setCurrentExecutionId = useWorkflowCanvasStore((s) => s.setCurrentExecutionId);
  const [showRawJson, setShowRawJson] = useState(false);

  const toggleRawJson = (next: boolean) => {
    setShowRawJson(next);
    onRawJsonToggle?.(next);
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    } else {
      setDebugPanelOpen(false);
      setCurrentExecutionId(null);
    }
  };

  // Derive flow log steps from context.steps — no dependency on execution.steps[]
  const contextFlowSteps = useMemo(() => {
    const raw = execution?.context as Record<string, unknown> | undefined;
    const contextSteps = raw?.steps;
    if (!contextSteps || typeof contextSteps !== 'object') return [];
    return contextStepsToResults(contextSteps as Record<string, unknown>);
  }, [execution?.context]);

  // The engine keeps execution.status === 'running' even while a step is
  // suspended on a human task / approval / callback — it really hasn't
  // terminated. Derive an effective status from the step contexts so the badge
  // honestly reflects "paused on user action" instead of "actively executing".
  // This piggybacks on the live `workflow_step_status` WS events that already
  // arrive instantly, so the badge updates in real time without any extra
  // engine plumbing.
  //
  // human_task spans multiple taskTypes (approval / data_entry / review /
  // decision); approval taskType is surfaced as waiting_approval so the badge
  // reads "Awaiting Approval", everything else as waiting_human.
  //
  // For parallel branches with multiple concurrent waits, an explicit
  // precedence is enforced — approval > human > callback — so the badge is
  // stable across renders and across UI instances, not dependent on the
  // engine's step-emission order. waiting_delay is intentionally NOT surfaced
  // at the top — the step row still shows "Waiting · Delay" and the canvas
  // node pulses, but the top badge stays "Running" so short delays don't
  // trigger an alarming flash.
  const effectiveStatus = useMemo<ExecStatus | null>(() => {
    if (!execution?.status) return null;
    if (execution.status !== 'running') return execution.status;
    let hasApproval = false;
    let hasHuman = false;
    let hasCallback = false;
    for (const s of contextFlowSteps) {
      if (s.status === 'waiting_approval') {
        hasApproval = true;
      } else if (s.status === 'waiting_callback') {
        hasCallback = true;
      } else if (s.status === 'waiting_human_task') {
        const input = s.input as Record<string, unknown> | null | undefined;
        const taskType = typeof input?.taskType === 'string' ? input.taskType : undefined;
        if (taskType === 'approval') hasApproval = true;
        else hasHuman = true;
      }
    }
    if (hasApproval) return 'waiting_approval';
    if (hasHuman) return 'waiting_human';
    if (hasCallback) return 'waiting_callback';
    return execution.status;
  }, [execution?.status, contextFlowSteps]);

  const statusBadge = effectiveStatus
    ? (STATUS_BADGE[effectiveStatus] ?? STATUS_BADGE.running)
    : null;

  const elapsed = execution ? formatElapsed(execution.startedAt, execution.completedAt) : null;

  const isRunning = execution?.status === 'running' && effectiveStatus === 'running';
  const isWaiting =
    effectiveStatus === 'waiting_human' ||
    effectiveStatus === 'waiting_approval' ||
    effectiveStatus === 'waiting_callback';

  // Compute final output from context steps
  const finalOutput = useMemo(() => {
    const completedOutputs = contextFlowSteps
      .filter((s) => s.status === 'completed' && s.output != null)
      .map((s) => ({ node: s.stepName, output: s.output }));
    return completedOutputs.length > 0 ? completedOutputs : null;
  }, [contextFlowSteps]);

  // Extract userIds from context, output, and finalOutput for batch resolution
  const allUserIds = useMemo(() => {
    const ids: string[] = [];
    if (execution?.context) ids.push(...extractUserIds(execution.context));
    if (execution?.output) ids.push(...extractUserIds(execution.output));
    if (finalOutput) ids.push(...extractUserIds(finalOutput));
    return Array.from(new Set(ids));
  }, [execution?.context, execution?.output, finalOutput]);

  const userNames = useUserNames(allUserIds);

  // Enrich execution context: resolve userIds, format dates, add end step
  const enrichedContext = useMemo(() => {
    if (!execution?.context || typeof execution.context !== 'object') return undefined;
    const ctx = execution.context as Record<string, unknown>;
    const { memory: _, ...ctxWithoutMemory } = ctx;
    return enrichContext(ctxWithoutMemory, userNames, execution);
  }, [execution?.context, userNames, execution]);

  const enrichedMemory = useMemo(() => {
    if (!execution?.context || typeof execution.context !== 'object') return undefined;
    const ctx = execution.context as Record<string, unknown>;
    if (!ctx.memory || typeof ctx.memory !== 'object') return undefined;
    return enrichData(ctx.memory as Record<string, unknown>, userNames);
  }, [execution?.context, userNames]);

  // Enrich execution output and finalOutput with resolved names & formatted dates
  const enrichedOutput = useMemo(() => {
    if (!execution?.output || typeof execution.output !== 'object') return undefined;
    return enrichData(execution.output as Record<string, unknown>, userNames);
  }, [execution?.output, userNames]);

  const enrichedFinalOutput = useMemo(() => {
    if (!finalOutput) return null;
    return enrichData(finalOutput, userNames);
  }, [finalOutput, userNames]);

  return (
    <div className="flex h-full shrink-0" data-testid="execution-debug-panel">
      {/* JSON viewer panel — shown side by side when code toggle is on.
          Canvas mode shares horizontal space with the editor itself, so the
          raw-JSON column uses a narrower width there to keep the canvas
          usable on laptop-sized screens. */}
      {showRawJson && execution && (
        <div
          className={clsx(
            'border-l border-default bg-background-elevated flex flex-col h-full animate-slide-in-right',
            mode === 'canvas' ? 'w-[320px]' : 'w-[380px]',
          )}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-default shrink-0">
            <h3 className="text-sm font-semibold text-foreground">Raw JSON</h3>
            <button
              type="button"
              onClick={() => toggleRawJson(false)}
              className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-md transition-colors"
              aria-label="Close JSON view"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
            {isRunning ? (
              <div className="flex flex-col items-center justify-center gap-3 h-32 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-xs">{t('debug_panel_waiting')}</span>
              </div>
            ) : (
              <div className="rounded-md border border-default bg-background p-2 overflow-hidden">
                <JsonViewer data={execution.context ?? execution} copyable defaultExpanded />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main debug panel */}
      <div
        className={clsx(
          'bg-background flex flex-col h-full',
          mode === 'monitor'
            ? 'flex-1 min-w-0'
            : 'w-[380px] border-l border-default animate-slide-in-right',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Execution</h3>
            {statusBadge && (
              <span
                className={clsx(
                  'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                  statusBadge.className,
                )}
              >
                {statusBadge.label}
              </span>
            )}
            {elapsed && (
              <span
                className={clsx(
                  'text-xs font-mono px-1.5 py-0.5 rounded shrink-0',
                  isWaiting
                    ? 'bg-warning/10 text-warning'
                    : isRunning
                      ? 'bg-accent/10 text-accent animate-pulse'
                      : execution?.status === 'cancelled'
                        ? 'bg-muted/10 text-muted'
                        : execution?.status === 'failed'
                          ? 'bg-error/10 text-error'
                          : 'bg-success/10 text-success',
                )}
              >
                {elapsed}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* Code toggle */}
            <button
              type="button"
              onClick={() => toggleRawJson(!showRawJson)}
              className={clsx(
                'p-1.5 rounded-md transition-colors',
                showRawJson
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-foreground hover:bg-background-muted',
              )}
              aria-label="Toggle raw JSON view"
              data-testid="debug-code-toggle"
            >
              <Code className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-md transition-colors"
              aria-label="Close debug panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Raw JSON inline view (monitor mode) — shows clean context.steps, not nodeExecutions */}
          {showRawJson && execution && mode === 'monitor' ? (
            <div className="p-4">
              <div className="rounded-md border border-default bg-background p-2">
                <JsonViewer data={execution} copyable defaultExpanded />
              </div>
            </div>
          ) : !execution ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2">
              <Loader2 className="w-5 h-5 text-accent animate-spin" />
              <span className="text-sm text-muted">Starting execution...</span>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {/* Input accordion */}
              <CollapsibleSection title="Input" defaultOpen>
                {execution.input != null &&
                typeof execution.input === 'object' &&
                Object.keys(execution.input).length > 0 ? (
                  <div className="rounded-md border border-default bg-background p-2">
                    <JsonViewer data={execution.input} copyable />
                  </div>
                ) : (
                  <p className="text-xs text-muted">No input data.</p>
                )}
              </CollapsibleSection>

              {/* Flow Log accordion */}
              <CollapsibleSection title="Flow Log" defaultOpen>
                <DebugFlowLog steps={contextFlowSteps} />
              </CollapsibleSection>

              {/* Memory accordion */}
              {enrichedMemory != null && (
                <CollapsibleSection title="Memory" defaultOpen={false}>
                  <div className="rounded-md border border-default bg-background p-2 max-h-[300px] overflow-y-auto">
                    <JsonViewer data={enrichedMemory} copyable />
                  </div>
                </CollapsibleSection>
              )}

              {/* Context accordion — enriched with resolved names & formatted dates */}
              {enrichedContext != null && (
                <CollapsibleSection title="Context" defaultOpen={false}>
                  <div className="rounded-md border border-default bg-background p-2 max-h-[300px] overflow-y-auto">
                    <JsonViewer data={enrichedContext} copyable />
                  </div>
                </CollapsibleSection>
              )}

              {/* Output accordion */}
              <CollapsibleSection title="Output" defaultOpen>
                {execution.status === 'failed' && execution.error ? (
                  <div className="px-3 py-2 rounded-md bg-error/5 border border-error/20">
                    <p className="text-xs font-medium text-error">
                      {ERROR_CODE_LABELS[execution.error.code] ?? execution.error.code}
                    </p>
                    <p className="text-xs text-error/80 mt-0.5">{execution.error.message}</p>
                  </div>
                ) : enrichedOutput &&
                  typeof enrichedOutput === 'object' &&
                  Object.keys(enrichedOutput).length > 0 ? (
                  <div className="rounded-md border border-default bg-background p-2 max-h-[300px] overflow-y-auto">
                    <JsonViewer data={enrichedOutput} copyable />
                  </div>
                ) : enrichedFinalOutput ? (
                  <div className="rounded-md border border-default bg-background p-2 max-h-[300px] overflow-y-auto">
                    <JsonViewer data={enrichedFinalOutput} copyable />
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    {execution.status === 'running'
                      ? contextFlowSteps.some(
                          (s) =>
                            s.status === 'waiting_human_task' || s.status === 'waiting_approval',
                        )
                        ? 'Waiting for human response...'
                        : 'Execution in progress...'
                      : 'No output available.'}
                  </p>
                )}
              </CollapsibleSection>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
