'use client';

import { useMemo } from 'react';
import type { ExecutionStepResult } from '../../../../api/workflows';
import { StepLogItem } from './StepLogItem';

// =============================================================================
// Props
// =============================================================================

interface DebugFlowLogProps {
  steps: ExecutionStepResult[];
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the step-by-step flow log.
 *
 * The engine now emits first-class Start and End step records with full
 * lifecycle (pending → running → completed|failed, timed, with per-mapping
 * error detail). This component renders whatever is in `execution.steps[]`
 * verbatim — no client-side fabrication. See LLD Phase 7 and the HLD
 * "first-class-start-end" cleanup inventory.
 */
export function DebugFlowLog({ steps }: DebugFlowLogProps) {
  const orderedSteps = useMemo(() => {
    // Only show traversed steps — filter out records that were created
    // as `pending` at workflow start but never transitioned (e.g., steps
    // past a failure point).
    const traversed = steps.filter((s) => s.status !== 'pending');

    // Sort by execution order: Start node first, then by startedAt timestamp.
    // Start and the next step often share a timestamp to millisecond precision,
    // so the explicit Start-first comparator keeps Start at the head.
    const sorted = [...traversed].sort((a, b) => {
      const aIsStart = a.nodeType === 'start' || a.stepName.toLowerCase() === 'start';
      const bIsStart = b.nodeType === 'start' || b.stepName.toLowerCase() === 'start';
      const aIsEnd = a.nodeType === 'end' || a.stepName.toLowerCase() === 'end';
      const bIsEnd = b.nodeType === 'end' || b.stepName.toLowerCase() === 'end';
      if (aIsStart && !bIsStart) return -1;
      if (!aIsStart && bIsStart) return 1;
      if (aIsEnd && !bIsEnd) return 1;
      if (!aIsEnd && bIsEnd) return -1;
      if (!a.startedAt && !b.startedAt) return 0;
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
    });

    return sorted;
  }, [steps]);

  if (orderedSteps.length === 0) {
    return <p className="text-sm text-muted py-4 text-center">No step execution data yet.</p>;
  }

  return (
    <div className="space-y-2">
      {orderedSteps.map((step) => (
        <StepLogItem key={step.stepId} step={step} />
      ))}
    </div>
  );
}
