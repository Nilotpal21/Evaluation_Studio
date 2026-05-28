/**
 * ExecutionDebugPanel
 *
 * Right-side panel showing workflow execution status,
 * per-node progress, and output/error details.
 */

'use client';

import { useState, useCallback } from 'react';
import {
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
} from 'lucide-react';
import { clsx } from 'clsx';
import { contextStepsToResults } from '../../../../api/workflows';
import type { WorkflowExecution, ExecutionStepResult } from '../../../../api/workflows';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

// =============================================================================
// Props
// =============================================================================

interface ExecutionDebugPanelProps {
  execution: WorkflowExecution | null;
}

// =============================================================================
// Status helpers
// =============================================================================

type ExecStatus = WorkflowExecution['status'];
type StepStatus = ExecutionStepResult['status'];

const STATUS_BADGE: Record<ExecStatus, { label: string; className: string }> = {
  running: {
    label: 'Running',
    className: 'bg-info-subtle text-info',
  },
  completed: {
    label: 'Completed',
    className: 'bg-success-subtle text-success',
  },
  failed: { label: 'Failed', className: 'bg-error-subtle text-error' },
  waiting_human: {
    label: 'Waiting',
    className: 'bg-warning-subtle text-warning',
  },
  waiting_approval: {
    label: 'Awaiting Approval',
    className: 'bg-warning/10 text-warning',
  },
  waiting_callback: {
    label: 'Awaiting Callback',
    className: 'bg-warning/10 text-warning',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-background-muted text-foreground-muted',
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-error-subtle text-error',
  },
};

function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-info animate-spin" />;
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-success" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-error" />;
    case 'skipped':
      return <MinusCircle className="w-4 h-4 text-foreground-muted" />;
    case 'cancelled':
      return <XCircle className="w-4 h-4 text-foreground-muted" />;
    case 'waiting_human_task':
    case 'waiting_approval':
    case 'waiting_delay':
    case 'waiting_callback':
      return <Clock className="w-4 h-4 text-warning animate-pulse" />;
    case 'pending':
    default:
      return <Clock className="w-4 h-4 text-foreground-muted" />;
  }
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
// Step Item
// =============================================================================

function StartInputItem({ input }: { input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <CheckCircle2 className="w-4 h-4 text-success" />
        <span className="flex-1 text-sm font-medium text-foreground truncate">Start</span>
        <span className="text-xs text-muted-foreground">input</span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-default bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">Input:</span>
          <pre className="text-xs text-foreground-muted mt-1 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}

function StepItem({ step }: { step: ExecutionStepResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = step.output != null || step.error != null;

  return (
    <div className="border border-default rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
      >
        <StepStatusIcon status={step.status} />
        <span className="flex-1 text-sm font-medium text-foreground truncate">{step.stepName}</span>
        <span className="text-xs text-muted-foreground">
          {formatDuration(step.startedAt, step.completedAt)}
        </span>
        {hasDetail &&
          (expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          ))}
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-default bg-muted/30">
          {step.error && (
            <div className="mb-2">
              <span className="text-xs font-medium text-error">Error:</span>
              <pre className="text-xs text-error mt-1 whitespace-pre-wrap break-all">
                {step.error.message}
              </pre>
            </div>
          )}
          {step.output != null && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Output:</span>
              <pre className="text-xs text-foreground-muted mt-1 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
                {typeof step.output === 'string'
                  ? step.output
                  : JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Copy Button
// =============================================================================

function CopyButton({
  text,
  title,
  size = 'sm',
}: {
  text: string;
  title?: string;
  size?: 'sm' | 'md';
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
    [text],
  );

  const iconClass = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title ?? 'Copy'}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
    >
      {copied ? (
        <ClipboardCheck className={clsx(iconClass, 'text-success')} />
      ) : (
        <Clipboard className={iconClass} />
      )}
    </button>
  );
}

// =============================================================================
// Context Variable Row
// =============================================================================

function ContextVarRow({ name, value, path }: { name: string; value: unknown; path: string }) {
  const isObject = value !== null && typeof value === 'object';
  const [expanded, setExpanded] = useState(false);
  const displayValue = isObject ? JSON.stringify(value, null, 2) : String(value ?? '');

  return (
    <div className="border border-default rounded-md overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/50">
        {isObject ? (
          <button type="button" className="p-0" onClick={() => setExpanded(!expanded)}>
            {expanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className="text-xs font-mono font-medium text-accent">{name}</span>
        {!isObject && (
          <span className="flex-1 text-xs text-foreground-muted truncate ml-1">
            = {displayValue}
          </span>
        )}
        {isObject && !expanded && (
          <span className="flex-1 text-xs text-muted-foreground truncate ml-1">
            {Array.isArray(value)
              ? `Array(${value.length})`
              : `{${Object.keys(value).length} keys}`}
          </span>
        )}
        <CopyButton text={path} title={`Copy: ${path}`} />
      </div>
      {isObject && expanded && (
        <div className="px-2.5 py-2 border-t border-default bg-muted/30">
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">
            {displayValue}
          </pre>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Context Section (collapsible with copy)
// =============================================================================

function ContextSection({
  title,
  data,
  pathPrefix,
  defaultExpanded,
}: {
  title: string;
  data: Record<string, unknown>;
  pathPrefix: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true);
  const entries = Object.entries(data);

  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40">
        <button
          type="button"
          className="flex items-center gap-1.5 flex-1 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
          <span className="text-xs font-semibold text-foreground">{title}</span>
          <span className="text-[10px] text-muted-foreground">({entries.length})</span>
        </button>
        <CopyButton
          text={JSON.stringify(data, null, 2)}
          title={`Copy all ${title.toLowerCase()}`}
        />
      </div>
      {expanded && (
        <div className="p-2 space-y-1.5">
          {entries.length > 0 ? (
            entries.map(([key, val]) => (
              <ContextVarRow key={key} name={key} value={val} path={`{{${pathPrefix}.${key}}}`} />
            ))
          ) : (
            <p className="text-xs text-muted-foreground px-2 py-1">No entries</p>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Context Tab Content
// =============================================================================

function ContextTabContent({ execution }: { execution: WorkflowExecution }) {
  const [viewMode, setViewMode] = useState<'tree' | 'raw'>('tree');

  const ctx = execution.context as Record<string, unknown> | undefined;
  const hasContext =
    ctx &&
    typeof ctx === 'object' &&
    (ctx.steps || ctx.trigger || ctx.workflow || ctx.tenant || Object.keys(ctx).length > 0);

  if (!hasContext) {
    return (
      <p className="text-sm text-muted-foreground">
        {execution.status === 'running'
          ? 'Context will appear as steps complete...'
          : 'No context available.'}
      </p>
    );
  }

  const trigger = (ctx.trigger as Record<string, unknown>) ?? {};
  const workflow = (ctx.workflow as Record<string, unknown>) ?? {};
  const tenant = (ctx.tenant as Record<string, unknown>) ?? {};
  const steps = (ctx.steps as Record<string, unknown>) ?? {};
  const variables = Object.fromEntries(
    Object.entries(ctx).filter(
      ([key]) => !['trigger', 'workflow', 'tenant', 'steps', 'vars'].includes(key),
    ),
  );

  // Build user-facing context: all top-level sections available for expressions
  const userFacingContext: Record<string, unknown> = {
    ...(Object.keys(trigger).length > 0 ? { trigger } : {}),
    ...(Object.keys(workflow).length > 0 ? { workflow } : {}),
    ...(Object.keys(tenant).length > 0 ? { tenant } : {}),
    ...variables,
    ...(Object.keys(steps).length > 0 ? { steps } : {}),
  };
  const userFacingJson = JSON.stringify(userFacingContext, null, 2);

  return (
    <div className="space-y-3">
      {/* Toolbar: view toggle + copy all */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5 bg-muted/50 rounded-md p-0.5">
          <button
            type="button"
            className={clsx(
              'px-2.5 py-1 text-[11px] font-medium rounded transition-colors',
              viewMode === 'tree'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setViewMode('tree')}
          >
            Tree
          </button>
          <button
            type="button"
            className={clsx(
              'px-2.5 py-1 text-[11px] font-medium rounded transition-colors',
              viewMode === 'raw'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setViewMode('raw')}
          >
            JSON
          </button>
        </div>
        <CopyButton text={userFacingJson} title="Copy full context" size="md" />
      </div>

      {viewMode === 'tree' ? (
        <>
          {/* All paths use the `context.` prefix — the runtime resolver strips
              it (see apps/workflow-engine/src/context/expression-resolver.ts)
              so `{{context.trigger.payload.X}}` ≡ `{{trigger.payload.X}}`. */}
          {/* Trigger — {{context.trigger.payload.X}} */}
          {Object.keys(trigger).length > 0 && (
            <ContextSection title="Trigger" data={trigger} pathPrefix="context.trigger" />
          )}
          {/* Workflow — {{context.workflow.id}}, {{context.workflow.name}} */}
          {Object.keys(workflow).length > 0 && (
            <ContextSection title="Workflow" data={workflow} pathPrefix="context.workflow" />
          )}
          {/* Tenant — {{context.tenant.tenantId}}, {{context.tenant.projectId}} */}
          {Object.keys(tenant).length > 0 && (
            <ContextSection title="Tenant" data={tenant} pathPrefix="context.tenant" />
          )}
          {/* Variables — {{context.varName}} */}
          {Object.keys(variables).length > 0 && (
            <ContextSection
              title="Variables"
              data={variables}
              pathPrefix="context"
              defaultExpanded
            />
          )}
          {/* Steps — {{context.steps.StepName.output.X}} */}
          {Object.keys(steps).length > 0 && (
            <ContextSection title="Steps" data={steps} pathPrefix="context.steps" defaultExpanded />
          )}
        </>
      ) : (
        <div className="relative border border-default rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-default">
            <span className="text-[11px] font-medium text-muted-foreground">context</span>
            <CopyButton text={userFacingJson} title="Copy JSON" />
          </div>
          <pre className="text-xs text-foreground whitespace-pre-wrap break-all max-h-[500px] overflow-y-auto p-3">
            {userFacingJson}
          </pre>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Tabs
// =============================================================================

type TabId = 'nodes' | 'context' | 'output';

// =============================================================================
// Component
// =============================================================================

export function ExecutionDebugPanel({ execution }: ExecutionDebugPanelProps) {
  const setDebugPanelOpen = useWorkflowCanvasStore((s) => s.setDebugPanelOpen);
  const setCurrentExecutionId = useWorkflowCanvasStore((s) => s.setCurrentExecutionId);
  const [activeTab, setActiveTab] = useState<TabId>('nodes');

  const derivedSteps: ExecutionStepResult[] = execution
    ? contextStepsToResults(
        ((execution.context as Record<string, unknown> | undefined)?.steps ?? {}) as Record<
          string,
          unknown
        >,
      )
    : [];

  const handleClose = () => {
    setDebugPanelOpen(false);
    setCurrentExecutionId(null);
  };

  const statusBadge = execution?.status
    ? (STATUS_BADGE[execution.status] ?? STATUS_BADGE.running)
    : null;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'nodes', label: 'Nodes' },
    { id: 'context', label: 'Context' },
    { id: 'output', label: 'Output' },
  ];

  return (
    <div
      className="w-[380px] border-l border-default bg-background flex flex-col h-full"
      data-testid="execution-debug-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-default">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Execution</h3>
          {statusBadge && (
            <span
              className={clsx(
                'text-xs font-medium px-2 py-0.5 rounded-full',
                statusBadge.className,
              )}
            >
              {statusBadge.label}
            </span>
          )}
        </div>
        <button
          onClick={handleClose}
          className="p-1 hover:bg-muted rounded"
          aria-label="Close debug panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-default">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={clsx(
              'flex-1 px-4 py-2 text-xs font-medium transition-colors',
              activeTab === tab.id
                ? 'text-accent border-b-2 border-accent'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!execution ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            <span className="ml-2 text-sm text-muted-foreground">
              Waiting for execution data...
            </span>
          </div>
        ) : activeTab === 'nodes' ? (
          <div className="space-y-2">
            {/* Show Start node with input if available */}
            {execution.input && Object.keys(execution.input).length > 0 && (
              <div className="border border-default rounded-md overflow-hidden">
                <StartInputItem input={execution.input} />
              </div>
            )}
            {derivedSteps.length > 0 ? (
              derivedSteps.map((step) => <StepItem key={step.stepId} step={step} />)
            ) : (
              <p className="text-sm text-muted-foreground">No node execution data yet.</p>
            )}
          </div>
        ) : activeTab === 'context' ? (
          <ContextTabContent execution={execution} />
        ) : (
          <div>
            {execution.status === 'completed' ? (
              <div className="space-y-3">
                {/* Timing */}
                {(execution.startedAt || execution.completedAt) && (
                  <div className="space-y-1">
                    {execution.startedAt && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Start Time</span>
                        <span className="text-foreground">{execution.startedAt}</span>
                      </div>
                    )}
                    {execution.completedAt && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">End Time</span>
                        <span className="text-foreground">{execution.completedAt}</span>
                      </div>
                    )}
                  </div>
                )}
                {/* Resolved output variables */}
                {execution.output && Object.keys(execution.output).length > 0 ? (
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Output:</span>
                    <pre className="text-xs text-foreground mt-1 whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto">
                      {JSON.stringify(execution.output, null, 2)}
                    </pre>
                  </div>
                ) : derivedSteps.length > 0 ? (
                  <pre className="text-xs text-foreground whitespace-pre-wrap break-all">
                    {JSON.stringify(
                      derivedSteps
                        .filter((s) => s.status === 'completed' && s.output != null)
                        .map((s) => ({ node: s.stepName, output: s.output })),
                      null,
                      2,
                    )}
                  </pre>
                ) : null}
              </div>
            ) : execution.status === 'failed' && execution.error ? (
              <div>
                <span className="text-xs font-medium text-error">Execution Error:</span>
                <pre className="text-xs text-error mt-2 whitespace-pre-wrap break-all">
                  {execution.error.message}
                </pre>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {execution.status === 'running'
                  ? 'Execution in progress...'
                  : 'No output available.'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
