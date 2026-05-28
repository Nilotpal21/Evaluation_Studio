/**
 * useExecutionPolling
 *
 * Polls execution status from the API and updates the canvas store
 * with per-node execution overlay.
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../store/navigation-store';
import { getExecution, contextStepsToResults } from '../../../api/workflows';
import type { WorkflowExecution } from '../../../api/workflows';
import { computeExecutionEdges } from './edges/computeExecutionEdges';

/** Polling interval for live debug updates (2s balances responsiveness vs server load) */
const POLL_INTERVAL_MS = 2_000;
const INITIAL_DELAY_MS = 300;
/** Stop polling after 5 minutes to prevent runaway requests */
const MAX_POLL_DURATION_MS = 5 * 60 * 1000;
/** Max consecutive errors before giving up */
const MAX_ERROR_RETRIES = 10;
/** Maximum backoff delay on errors (30 seconds) */
const MAX_BACKOFF_MS = 30_000;

/** Terminal statuses that mean execution is done */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);

export function useExecutionPolling(executionId: string | null): WorkflowExecution | null {
  const projectId = useNavigationStore((s) => s.projectId);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const setExecutionOverlay = useWorkflowCanvasStore((s) => s.setExecutionOverlay);
  const setExecutionEdges = useWorkflowCanvasStore((s) => s.setExecutionEdges);
  const setExecutionContext = useWorkflowCanvasStore((s) => s.setExecutionContext);
  const setExecutionStatus = useWorkflowCanvasStore((s) => s.setExecutionStatus);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  /** Track whether we've already applied the final overlay to avoid redundant re-renders */
  const terminalOverlayApplied = useRef(false);

  useEffect(() => {
    if (!executionId || executionId === '__starting__' || !projectId || !workflowId) {
      setExecution(null);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let errorCount = 0;
    const startTime = Date.now();
    terminalOverlayApplied.current = false;

    const poll = async () => {
      if (cancelled) return;

      // Safety: stop if we've been polling too long
      if (Date.now() - startTime > MAX_POLL_DURATION_MS) {
        return;
      }

      // Pause polling when the tab is not visible to reduce server load
      if (typeof document !== 'undefined' && document.hidden) {
        timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      try {
        const data = await getExecution(projectId, workflowId, executionId);
        if (cancelled) return;
        errorCount = 0; // Reset on success

        // Derive steps array from context.steps (the single source of truth)
        const rawCtx = (data.context as Record<string, unknown> | undefined) ?? {};
        const rawCtxSteps = (rawCtx.steps ?? {}) as Record<string, unknown>;
        const derivedSteps = contextStepsToResults(rawCtxSteps);

        setExecution(data);
        setExecutionStatus(data.status);

        // Build overlay map from step results — skip if we already applied terminal overlay
        if (derivedSteps.length > 0 && !terminalOverlayApplied.current) {
          const overlay: Record<string, string> = {};
          for (const step of derivedSteps) {
            overlay[step.stepId] = step.status;
          }
          setExecutionOverlay(overlay);
          setExecutionContext(rawCtx);

          // Compute which edges to highlight based on the execution path
          const { nodes, edges } = useWorkflowCanvasStore.getState();
          setExecutionEdges(computeExecutionEdges({ edges, nodes, steps: derivedSteps }));
        }

        // Continue polling while execution is non-terminal (running or any
        // waiting_* state); stop on terminal status but keep currentExecutionId
        // so the debug panel stays open.
        if (!TERMINAL_STATUSES.has(data.status)) {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
        } else {
          // Mark terminal overlay applied — keep the overlay visible so the
          // user can see the traversed path (nodes + edges) until the next
          // run or closing the debug panel.
          terminalOverlayApplied.current = true;
        }
      } catch {
        errorCount++;
        // Retry on error with exponential backoff, capped at MAX_BACKOFF_MS
        if (!cancelled && errorCount < MAX_ERROR_RETRIES) {
          const backoff = Math.min(POLL_INTERVAL_MS * Math.pow(2, errorCount - 1), MAX_BACKOFF_MS);
          timeoutId = setTimeout(poll, backoff);
        }
      }
    };

    // Initial delay to let execution be created in DB
    timeoutId = setTimeout(poll, INITIAL_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      setExecutionOverlay(null);
      setExecutionEdges(null);
    };
  }, [
    executionId,
    projectId,
    workflowId,
    setExecutionOverlay,
    setExecutionEdges,
    setExecutionStatus,
  ]);

  return execution;
}
