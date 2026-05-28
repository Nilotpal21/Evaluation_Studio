/**
 * MiniFlowGraph — Visual flow graph with node states.
 *
 * Design spec Section 10.2.2. Shows a miniature representation
 * of the agent's flow with node states (visited/active/upcoming/error).
 * Rendered inline within the flow_graph step.
 */

import { useMemo } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import clsx from 'clsx';
import { extractFlowSteps, type FlowStep, type FlowStepState } from './FlowBreadcrumb';
import type { InteractionStep } from './types';

interface MiniFlowGraphProps {
  step: InteractionStep;
  /** All steps from the parent interaction (for context) */
  allSteps: InteractionStep[];
}

export function MiniFlowGraph({ step, allSteps }: MiniFlowGraphProps) {
  const styles = getIntentStyles('warning');
  const flowSteps = useMemo(() => extractFlowSteps(allSteps), [allSteps]);

  const agentName = step.agentName;
  const currentIndex = flowSteps.findIndex((s) => s.state === 'active');
  const totalSteps = flowSteps.length;

  if (flowSteps.length === 0) {
    return (
      <div className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}>
        <span className="text-foreground-muted">No flow data available</span>
      </div>
    );
  }

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-muted">
        <span className={clsx('font-medium', styles.text)}>{agentName} Flow</span>
        {currentIndex >= 0 && (
          <span className="text-foreground-subtle">
            — Step {currentIndex + 1} of {totalSteps}
          </span>
        )}
      </div>

      {/* Graph nodes */}
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {flowSteps.map((flowStep, i) => (
            <div key={flowStep.name} className="flex items-center gap-1">
              {i > 0 && <Edge fromState={flowSteps[i - 1].state} toState={flowStep.state} />}
              <GraphNode step={flowStep} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GraphNode({ step }: { step: FlowStep }) {
  const config = NODE_CONFIG[step.state];

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1 rounded-md px-2 py-1',
        config.border,
        config.bg,
        step.state === 'active' && 'shadow-sm shadow-warning/20',
      )}
    >
      {step.state === 'active' && (
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
      )}
      <span className={clsx('text-[10px] font-medium', config.text)}>{step.name}</span>
      {step.state === 'visited' && <span className="text-success text-[10px]">✓</span>}
      {step.state === 'error' && <span className="text-error text-[10px]">✗</span>}
    </div>
  );
}

function Edge({ fromState, toState }: { fromState: FlowStepState; toState: FlowStepState }) {
  const isVisited = fromState === 'visited' && (toState === 'visited' || toState === 'active');
  const isActive = fromState === 'active' || toState === 'active';

  return (
    <div
      className={clsx(
        'w-4 h-px',
        isVisited ? 'bg-success' : isActive ? 'bg-warning' : 'bg-border-muted',
      )}
    />
  );
}

const NODE_CONFIG: Record<FlowStepState, { border: string; bg: string; text: string }> = {
  visited: {
    border: 'border border-success/40',
    bg: 'bg-success/[0.06]',
    text: 'text-foreground-muted',
  },
  active: {
    border: 'border border-warning',
    bg: 'bg-warning/[0.08]',
    text: 'text-foreground',
  },
  upcoming: {
    border: 'border border-dashed border-border-muted',
    bg: '',
    text: 'text-foreground-subtle',
  },
  error: {
    border: 'border border-error/40',
    bg: 'bg-error/[0.06]',
    text: 'text-error',
  },
};
