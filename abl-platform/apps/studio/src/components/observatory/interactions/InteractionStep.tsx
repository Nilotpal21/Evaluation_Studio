/**
 * InteractionStep — Renders a single step in the interaction timeline.
 *
 * Shows: vertical timeline dot → StepBadge → timestamp → step-specific content.
 */

import { useMemo, useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { StepBadge } from './StepBadge';
import { TokenGrid } from './TokenGrid';
import { GuardrailPanel } from './GuardrailPanel';
import { GuardrailCompact } from './GuardrailCompact';
import { MemoryDiff } from './MemoryDiff';
import { truncate } from './format-utils';
import { SwimLaneTimeline } from './SwimLaneTimeline';
import { RetryBadge } from './RetryBadge';
import { MiniFlowGraph } from './MiniFlowGraph';
import { VariableResolution } from './VariableResolution';
import { TransitionEvaluation } from './TransitionEvaluation';
import { GatherConfidence } from './GatherConfidence';
import { DecisionContent } from './DecisionContent';
import { FlowStepContextLine } from './FlowStepContextLine';
import { ToolCallContent } from './ToolCallContent';
import { RawEventBlock } from './RawEventBlock';
import { STEP_CONFIG } from './constants';
import { formatDuration } from './format-utils';
import type { InteractionStep as InteractionStepData } from './types';

interface InteractionStepProps {
  step: InteractionStepData;
  /** Whether this is the last step (hides the timeline connector line) */
  isLast: boolean;
  /** All steps in the parent interaction — needed by flow components */
  allSteps?: InteractionStepData[];
}

/** Step types that manage their own expandable details (don't add duplicate raw events) */
const SELF_EXPANDING_STEPS = new Set(['decision', 'tool_call', 'llm_call']);

export function InteractionStep({ step, isLast, allSteps }: InteractionStepProps) {
  const config = STEP_CONFIG[step.type];
  const styles = getIntentStyles(config.intent);
  const [rawExpanded, setRawExpanded] = useState(false);

  const timeStr = useMemo(
    () =>
      step.timestamp.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    [step.timestamp],
  );

  const showRawToggle = !SELF_EXPANDING_STEPS.has(step.type) && step.events.length > 0;

  return (
    <div className="flex gap-3 relative">
      {/* Timeline column: dot + connector line */}
      <div className="flex flex-col items-center shrink-0 w-4">
        <div className={clsx('w-2.5 h-2.5 rounded-full mt-1.5 shrink-0', styles.bg)} />
        {!isLast && <div className="w-px flex-1 bg-border-muted mt-1" />}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 pb-4">
        {/* Header row: badge + timestamp + duration */}
        <div className="flex items-center gap-2 mb-1.5">
          <StepBadge type={step.type} />
          <span className="text-[9px] text-foreground-subtle font-mono">{timeStr}</span>
          {step.durationMs != null && step.durationMs > 0 && (
            <span className="text-[9px] text-foreground-subtle font-mono">
              {formatDuration(step.durationMs)}
            </span>
          )}
          {/* Raw events toggle — only for steps that don't self-expand */}
          {showRawToggle && (
            <>
              <div className="flex-1" />
              <button
                onClick={() => setRawExpanded(!rawExpanded)}
                className="flex items-center gap-1 text-foreground-muted hover:text-foreground transition-colors"
              >
                <span className="text-[9px]">
                  {rawExpanded
                    ? 'Hide'
                    : `${step.events.length} event${step.events.length !== 1 ? 's' : ''}`}
                </span>
                {rawExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
            </>
          )}
        </div>

        {/* Step content */}
        <StepContent step={step} styles={styles} allSteps={allSteps} />

        {/* Universal raw events panel */}
        {rawExpanded && <RawEventsPanel events={step.events} />}
      </div>
    </div>
  );
}

function RawEventsPanel({ events }: { events: InteractionStepData['events'] }) {
  return (
    <div className="mt-1.5 space-y-1.5 border-t border-border-muted pt-1.5">
      {events.map((evt) => (
        <RawEventBlock
          key={evt.id}
          type={evt.type}
          agent={evt.agentName}
          durationMs={evt.durationMs}
          data={evt.data}
        />
      ))}
    </div>
  );
}

// =============================================================================
// STEP CONTENT
// =============================================================================

interface StepContentProps {
  step: InteractionStepData;
  styles: ReturnType<typeof getIntentStyles>;
  allSteps?: InteractionStepData[];
}

function StepContent({ step, styles, allSteps }: StepContentProps) {
  switch (step.type) {
    case 'user_input':
      return (
        <div
          className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}
        >
          <span className="text-foreground break-words whitespace-pre-wrap">
            {truncate(String(step.data.content ?? ''), 500)}
          </span>
        </div>
      );

    case 'llm_call':
      return <TokenGrid step={step} />;

    case 'tool_call':
      return <ToolCallContent step={step} styles={styles} />;

    case 'agent_response':
      return (
        <div
          className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}
        >
          <FlowStepContextLine step={step} className="mb-1.5" />
          <div className="text-foreground break-words markdown-content overflow-x-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {String(step.data.content ?? '')}
            </ReactMarkdown>
          </div>
        </div>
      );

    case 'decision':
      return <DecisionContent step={step} styles={styles} />;

    case 'error': {
      const isWarning = step.data.severity === 'warning';
      return (
        <div
          className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}
        >
          <FlowStepContextLine step={step} className="mb-1.5" />
          <div className={clsx('font-medium', isWarning ? 'text-warning' : 'text-error')}>
            {isWarning && (
              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-warning/10 text-warning mr-1.5">
                WARNING
              </span>
            )}
            {String(step.data.message ?? 'Error')}
          </div>
          {step.data.code ? (
            <div className="text-foreground-subtle font-mono text-[10px] mt-0.5">
              {String(step.data.code)}
            </div>
          ) : null}
        </div>
      );
    }

    case 'input_guard': {
      const inputAllPassed = step.events.every(
        (e) =>
          e.data.result === 'pass' ||
          e.data.result === 'clean' ||
          e.data.result === 'Clean' ||
          e.data.passed === true,
      );
      return inputAllPassed && step.events.length > 0 ? (
        <GuardrailCompact step={step} variant="input" />
      ) : (
        <GuardrailPanel step={step} variant="input" />
      );
    }

    case 'output_guard': {
      const outputAllPassed = step.events.every(
        (e) =>
          e.data.result === 'pass' ||
          e.data.result === 'clean' ||
          e.data.result === 'Clean' ||
          e.data.passed === true,
      );
      return outputAllPassed && step.events.length > 0 ? (
        <GuardrailCompact step={step} variant="output" />
      ) : (
        <GuardrailPanel step={step} variant="output" />
      );
    }

    case 'gather':
      return <GatherConfidence step={step} />;

    case 'flow_transition': {
      const from = (step.data.fromStep ?? step.data.previousStep) as string | undefined;
      const to = (step.data.toStep ?? step.data.nextStep ?? step.data.step) as string | undefined;
      const cond = step.data.condition as string | undefined;
      return (
        <div className="space-y-2">
          <TransitionEvaluation step={step} />
          <VariableResolution step={step} />
          {/* Fallback: simple from → to when no structured conditions/variables */}
          {from || to ? (
            <div
              className={clsx(
                'rounded-md border px-3 py-1.5 text-xs',
                styles.border,
                styles.bgSubtle,
              )}
            >
              <FlowStepContextLine step={step} className="mb-1" />
              <div className="flex items-center gap-2">
                {from && <span className="font-mono text-foreground">{String(from)}</span>}
                {from && to && <span className="text-foreground-muted">→</span>}
                {to && <span className="font-mono text-foreground">{String(to)}</span>}
              </div>
              {cond != null && (
                <div className="text-[9px] text-foreground-subtle mt-0.5 font-mono">
                  {String(cond)}
                </div>
              )}
            </div>
          ) : null}
        </div>
      );
    }

    case 'flow_graph':
      return <MiniFlowGraph step={step} allSteps={allSteps ?? []} />;

    case 'memory_diff':
      return <MemoryDiff step={step} />;

    case 'parallel_tools':
      return <SwimLaneTimeline step={step} />;

    case 'retry':
      return <RetryBadge step={step} />;

    default:
      return (
        <div className="rounded-md border border-border-muted bg-background-subtle px-3 py-2 text-xs text-foreground-muted">
          {step.events.length} event{step.events.length !== 1 ? 's' : ''}
        </div>
      );
  }
}

// =============================================================================
// UTILS
// =============================================================================
// H3: truncate() moved to format-utils.ts to consolidate duplicates
