'use client';

/**
 * ActivitySteps — borderless, free-flowing activity feed for Arch chat.
 *
 * B05: Live Thinking Visibility
 * Design: docs/arch/design/2026-04-05-live-thinking-visibility-design.md §5
 * Wireframe: .claude/wireframes/b05-live-thinking.html
 *
 * Pattern: Claude-style thinking steps above response text.
 * No borders, no containers — just indented lines with status icons.
 */

import { memo, useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import type { ActivityGroup, ActivityStep } from '@/lib/arch-ai/ui/hook';

interface ActivityStepsProps {
  groups: ActivityGroup[];
  isStreaming: boolean;
}

export const TOOL_LABELS: Record<string, string> = {
  read_agent: 'Reading agent configuration',
  compile_abl: 'Compiling ABL code',
  health_check: 'Running health checks',
  propose_modification: 'Preparing changes',
  apply_modification: 'Applying changes',
  session_ops: 'Reading sessions',
  trace_diagnosis: 'Diagnosing sessions and traces',
  query_traces: 'Analyzing execution traces',
  read_topology: 'Loading project topology',
  run_test: 'Running test scenarios',
  recommend_model: 'Analyzing model options',
  configure_model: 'Configuring model',
  analyze_constraints: 'Reviewing constraints',
  generate_agent: 'Generating agent code',
  read_journal: 'Reading session journal',
  generate_topology: 'Designing agent topology',
  generate_agents: 'Generating agent definitions',
  create_project: 'Creating project',
  ask_user: 'Waiting for your response',
  collect_file: 'Processing uploaded file',
  agent_ops: 'Updating agent configuration',
  topology_ops: 'Modifying topology',
  tools_ops: 'Configuring tools',
  mcp_server_ops: 'Configuring MCP server',
  testing_ops: 'Running tests',
  deployment_ops: 'Preparing deployment',
  knowledge_ops: 'Managing knowledge base',
  analytics_ops: 'Processing analytics',
  project_config: 'Updating project configuration',
  update_specification: 'Updating specification',
  read_insights: 'Reading performance insights',
  suggest_guardrails: 'Suggesting guardrails',
  kb_manage: 'Managing knowledge base',
  kb_ingest: 'Ingesting content',
  kb_search: 'Searching knowledge base',
  kb_health: 'Checking KB health',
  kb_connector: 'Managing connector',
  kb_documents: 'Managing documents',
};

/**
 * Extract a human-readable label for an activity step.
 * Activity step IDs follow the format `tool-{toolName}-{timestamp}`.
 * Try to extract the tool name from the ID and look up in TOOL_LABELS.
 * Falls back to the raw label if no match found.
 */
export function getStepLabel(step: { id: string; label: string }): string {
  // Try to extract tool name from step ID (format: tool-{name}-{timestamp})
  const toolMatch = step.id.match(/^tool-(.+)-(\d+)$/);
  if (toolMatch) {
    const toolName = toolMatch[1];
    if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  }
  // Also try direct label lookup (for any steps with bare tool names)
  return TOOL_LABELS[step.label] ?? step.label;
}

export function ElapsedTime({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = new Date(startTime).getTime();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 100) / 10);
    }, 100);
    return () => clearInterval(interval);
  }, [startTime]);
  return <span className="text-xs text-foreground-muted ml-1">({elapsed.toFixed(1)}s)</span>;
}

export function StepIcon({ status }: { status: ActivityStep['status'] }) {
  switch (status) {
    case 'active':
      return (
        <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
        </span>
      );
    case 'done':
      return (
        <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-success">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      );
    case 'error':
      return (
        <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-error">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M3 3L9 9M9 3L3 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case 'warning':
      return (
        <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-warning">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M6 3V7M6 9V8.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case 'info':
    default:
      return (
        <span className="mt-1.5 flex h-4 w-4 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground-muted/50" />
        </span>
      );
  }
}

export function StepRow({ step }: { step: ActivityStep }) {
  return (
    <div
      className={clsx(
        'flex items-start gap-2 py-0.5 text-sm animate-in fade-in slide-in-from-bottom-1 duration-200',
        step.status === 'active' && 'text-foreground',
        step.status === 'done' && 'text-foreground-muted',
        step.status === 'error' && 'text-error',
        step.status === 'warning' && 'text-warning',
        step.status === 'info' && 'text-foreground-muted/70',
      )}
    >
      <StepIcon status={step.status} />
      <span className="min-w-0 flex-1">
        {getStepLabel(step)}
        {step.status === 'active' && step.timestamp && <ElapsedTime startTime={step.timestamp} />}
      </span>
    </div>
  );
}

function GroupView({
  group,
  isStreaming,
  isMultiGroup,
  isLastGroup,
}: {
  group: ActivityGroup;
  isStreaming: boolean;
  isMultiGroup: boolean;
  isLastGroup: boolean;
}) {
  const isGroupDone = group.status === 'done' || group.status === 'error';
  const [expanded, setExpanded] = useState(!isGroupDone);

  // Auto-collapse logic:
  // - Intermediate groups (not last): collapse 1.5s after they finish, regardless of streaming
  // - Last group: collapse 3s after streaming ends AND group is done
  useEffect(() => {
    if (!isGroupDone) return;
    if (isLastGroup && isStreaming) return; // last group waits for streaming to stop

    const delay = isLastGroup ? 3000 : 1500;
    const timer = setTimeout(() => setExpanded(false), delay);
    return () => clearTimeout(timer);
  }, [isGroupDone, isStreaming, isLastGroup]);

  const shouldShowSteps = isStreaming && isLastGroup ? true : expanded;

  const toggleExpand = useCallback(() => setExpanded((e) => !e), []);

  // Pending group (Build queue) — dimmed label only
  if (group.status === 'pending') {
    return (
      <div className="flex items-center gap-2 py-0.5 text-sm text-foreground-muted/30">
        <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground-muted/20" />
        </span>
        <span>{group.label}</span>
      </div>
    );
  }

  // Collapsed summary
  if (isGroupDone && !shouldShowSteps) {
    const duration =
      group.endTime && group.startTime
        ? `${((new Date(group.endTime).getTime() - new Date(group.startTime).getTime()) / 1000).toFixed(1)}s`
        : null;

    return (
      <button
        type="button"
        onClick={toggleExpand}
        className="flex w-full items-center gap-2 py-0.5 text-left text-sm text-foreground-muted/70 transition-colors hover:text-foreground-muted"
        aria-expanded={false}
        aria-label={`Expand activity: ${group.summary ?? group.label}`}
      >
        <span className="text-[10px]">{'\u25B8'}</span>
        <span className="flex h-4 w-4 items-center justify-center text-success">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="flex-1">{group.summary ?? group.label}</span>
        {duration && <span className="text-xs text-foreground-muted/50">{duration}</span>}
      </button>
    );
  }

  return (
    <div>
      {/* Collapsible header — shown when done (any group) or always for multi-group */}
      {(isGroupDone || isMultiGroup) && (
        <button
          type="button"
          onClick={isGroupDone ? toggleExpand : undefined}
          className={clsx(
            'flex w-full items-center gap-2 py-0.5 text-left text-sm',
            isGroupDone
              ? 'cursor-pointer text-foreground-muted/70 hover:text-foreground-muted'
              : 'font-medium text-foreground',
          )}
          aria-expanded={shouldShowSteps}
        >
          <span className="text-[10px] text-foreground-muted">
            {shouldShowSteps ? '\u25BE' : '\u25B8'}
          </span>
          <StepIcon
            status={
              group.status === 'active' ? 'active' : group.status === 'error' ? 'error' : 'done'
            }
          />
          <span>{group.label}</span>
        </button>
      )}

      {/* Steps — animated height on expand/collapse */}
      <AnimatePresence initial={false}>
        {shouldShowSteps && (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
            className={clsx((isMultiGroup || isGroupDone) && 'pl-5')}
            aria-live="polite"
            aria-atomic={false}
          >
            {group.steps.map((step) => (
              <StepRow key={step.id} step={step} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export const ActivitySteps = memo(function ActivitySteps({
  groups,
  isStreaming,
}: ActivityStepsProps) {
  if (groups.length === 0) return null;

  const isMultiGroup = groups.length > 1 || (groups[0] && groups[0].id !== '__default__');

  return (
    <div className="mb-2 space-y-0.5">
      {groups.map((group, idx) => (
        <GroupView
          key={group.id}
          group={group}
          isStreaming={isStreaming}
          isMultiGroup={isMultiGroup}
          isLastGroup={idx === groups.length - 1}
        />
      ))}
    </div>
  );
});
