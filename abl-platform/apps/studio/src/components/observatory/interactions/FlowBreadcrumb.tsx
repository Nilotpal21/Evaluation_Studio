/**
 * FlowBreadcrumb — Horizontal breadcrumb bar showing flow step states.
 *
 * Design spec Section 10.2.1. Appears at the top of each interaction
 * for scripted agents. Shows:
 * [greeting ✓] → [collect_issue ✓] → ●[lookup_order] → [process_refund] → [confirm]
 */

import { useMemo } from 'react';
import clsx from 'clsx';
import type { InteractionStep } from './types';

export type FlowStepState = 'visited' | 'active' | 'upcoming' | 'error';

export interface FlowStep {
  name: string;
  state: FlowStepState;
}

interface FlowBreadcrumbProps {
  steps: InteractionStep[];
}

/**
 * Extract flow steps from interaction steps for breadcrumb visualization.
 *
 * Scans interaction steps for flow_transition events and builds an ordered
 * list of flow steps with their visited/active/error states.
 *
 * @param steps - Array of interaction steps to analyze
 * @returns Ordered array of flow steps with state information
 *
 * @remarks
 * - Only extracts from flow_transition step types
 * - Marks last step as "active" if no error
 * - Marks step as "error" if interaction has error status
 * - Pure function - no side effects, suitable for unit testing
 *
 * @example
 * ```ts
 * const flowSteps = extractFlowSteps(interaction.steps);
 * // Returns: [
 * //   { name: 'greeting', state: 'visited' },
 * //   { name: 'collect', state: 'active' }
 * // ]
 * ```
 */
export function extractFlowSteps(steps: InteractionStep[]): FlowStep[] {
  const flowSteps: FlowStep[] = [];
  const visitedSteps = new Set<string>();
  let currentStep: string | null = null;
  const errorSteps = new Set<string>();

  for (const step of steps) {
    if (step.type === 'flow_transition') {
      for (const event of step.events) {
        const from = String(event.data.fromStep ?? event.data.previousStep ?? '');
        const to = String(event.data.toStep ?? event.data.nextStep ?? event.data.step ?? '');

        if (from) visitedSteps.add(from);
        if (to) currentStep = to;
      }
    }

    if (step.type === 'error') {
      // Mark the current step as errored
      if (currentStep) errorSteps.add(currentStep);
    }
  }

  // L6: Use Set instead of Array.includes for O(1) lookups instead of O(n²)
  // Build the breadcrumb from visited + current
  // Add all visited steps first (in order encountered)
  const allStepNamesSet = new Set<string>();
  for (const step of steps) {
    if (step.type === 'flow_transition') {
      for (const event of step.events) {
        const from = String(event.data.fromStep ?? event.data.previousStep ?? '');
        const to = String(event.data.toStep ?? event.data.nextStep ?? event.data.step ?? '');
        if (from) allStepNamesSet.add(from);
        if (to) allStepNamesSet.add(to);
      }
    }
  }

  // Also check for step names in the flow definition if available
  for (const step of steps) {
    if (step.type === 'flow_transition' || step.type === 'flow_graph') {
      const flowDef = step.data.flowSteps as string[] | undefined;
      if (flowDef) {
        for (const name of flowDef) {
          allStepNamesSet.add(name);
        }
      }
    }
  }

  const allStepNames = Array.from(allStepNamesSet);
  for (const name of allStepNames) {
    let state: FlowStepState;
    if (errorSteps.has(name)) {
      state = 'error';
    } else if (name === currentStep) {
      state = 'active';
    } else if (visitedSteps.has(name)) {
      state = 'visited';
    } else {
      state = 'upcoming';
    }
    flowSteps.push({ name, state });
  }

  return flowSteps;
}

export function FlowBreadcrumb({ steps }: FlowBreadcrumbProps) {
  const flowSteps = useMemo(() => extractFlowSteps(steps), [steps]);

  if (flowSteps.length === 0) return null;

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto">
      {flowSteps.map((step, i) => (
        <div key={step.name} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span className="text-foreground-subtle text-[9px]">→</span>}
          <FlowStepNode step={step} />
        </div>
      ))}
    </div>
  );
}

function FlowStepNode({ step }: { step: FlowStep }) {
  const config = STATE_CONFIG[step.state];

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] leading-none',
        config.border,
        config.bg,
      )}
    >
      {step.state === 'active' && (
        <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
      )}
      <span className={config.text}>{step.name}</span>
      {step.state === 'visited' && <span className="text-success">✓</span>}
      {step.state === 'error' && <span className="text-error">✗</span>}
    </div>
  );
}

const STATE_CONFIG: Record<FlowStepState, { border: string; bg: string; text: string }> = {
  visited: {
    border: 'border border-success/30',
    bg: 'bg-success/[0.06]',
    text: 'text-foreground-muted',
  },
  active: {
    border: 'border border-warning',
    bg: 'bg-warning/[0.08]',
    text: 'text-foreground font-medium',
  },
  upcoming: {
    border: 'border border-dashed border-border-muted',
    bg: '',
    text: 'text-foreground-subtle',
  },
  error: {
    border: 'border border-error/30',
    bg: 'bg-error/[0.06]',
    text: 'text-error',
  },
};
