'use client';

import { createContext, useContext } from 'react';
import type { WorkflowPreviousStep, TriggerOption } from '../hooks/useWorkflowExpressionContext';

interface NodeExpressionContextValue {
  triggers: TriggerOption[];
  previousSteps: WorkflowPreviousStep[];
  executionContext: Record<string, unknown> | null;
  /** Update a trigger's payload in-place after a successful test run */
  refreshTrigger: (triggerId: string, payload: Record<string, unknown>) => void;
  /** Test a connector trigger — fetches live sample data and refreshes context */
  onTestTrigger?: (triggerId: string) => Promise<void>;
}

export const NodeExpressionContext = createContext<NodeExpressionContextValue>({
  triggers: [],
  previousSteps: [],
  executionContext: null,
  refreshTrigger: () => {},
});

export function useNodeExpressionContext() {
  return useContext(NodeExpressionContext);
}
