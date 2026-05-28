'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { buildWebDebugWSProtocols } from '@agent-platform/shared/websocket-auth';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import type {
  LoopIterationEntry,
  EdgeBatchBadge,
  IterationPathStateMap,
} from '../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../store/navigation-store';
import { getExecution, contextStepsToResults } from '../../../api/workflows';
import type { WorkflowExecution } from '../../../api/workflows';
import { useRuntimeConfig } from '../../../contexts/RuntimeConfigContext';
import { useAuthStore } from '../../../store/auth-store';
import { computeExecutionEdges } from './edges/computeExecutionEdges';
import { applySnapshot, mergeStepDelta, mergeExecutionDelta } from './execution-merge';
import type { SnapshotMsg, StepDeltaMsg, ExecutionDeltaMsg } from './execution-merge';

/** How long to wait for WS connect before falling back to polling */
const WS_CONNECT_TIMEOUT_MS = 1_500;
/** How long to attempt reconnect before giving up and falling back */
const WS_RECONNECT_GIVE_UP_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;
const INITIAL_DELAY_MS = 300;
const MAX_POLL_DURATION_MS = 5 * 60 * 1000;
const MAX_ERROR_RETRIES = 10;
const MAX_BACKOFF_MS = 30_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const ACTIVE_STEP_STATUSES = new Set([
  'running',
  'waiting_approval',
  'waiting_delay',
  'waiting_callback',
  'waiting_human_task',
]);

/**
 * Step statuses that mean "still running" — if the execution reaches a terminal
 * state these steps never got a final status written, so we normalize them to
 * the execution's terminal status for the canvas overlay.
 */
const IN_FLIGHT_STEP_STATUSES = new Set([
  'running',
  'waiting_delay',
  'waiting_callback',
  'waiting_approval',
  'waiting_human',
  'waiting_human_task',
]);

/**
 * Drop-in replacement for useExecutionPolling.
 * Connects a WebSocket to workflow-engine when executionId becomes available,
 * subscribes to the execution, and merges snapshot + deltas.
 * Falls back to HTTP polling if WS is unavailable.
 */
export function useExecutionWebSocket(executionId: string | null): WorkflowExecution | null {
  const projectId = useNavigationStore((s) => s.projectId);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const setExecutionOverlay = useWorkflowCanvasStore((s) => s.setExecutionOverlay);
  const setExecutionEdges = useWorkflowCanvasStore((s) => s.setExecutionEdges);
  const setBaseExecution = useWorkflowCanvasStore((s) => s.setBaseExecution);
  const setLoopData = useWorkflowCanvasStore((s) => s.setLoopData);
  const setSelectedLoopIteration = useWorkflowCanvasStore((s) => s.setSelectedLoopIteration);
  const setEdgeBatchCounts = useWorkflowCanvasStore((s) => s.setEdgeBatchCounts);
  const setExecutionContext = useWorkflowCanvasStore((s) => s.setExecutionContext);
  const setExecutionStatus = useWorkflowCanvasStore((s) => s.setExecutionStatus);
  const mergeIterationEdgePathState = useWorkflowCanvasStore((s) => s.mergeIterationEdgePathState);
  const setPersistedPathState = useWorkflowCanvasStore((s) => s.setPersistedPathState);
  const readStoredPathState = useWorkflowCanvasStore((s) => s.readStoredPathState);
  const { wsUrl } = useRuntimeConfig();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  // Mirror of execution state in a ref so WS handlers can compute the next
  // value without using a React setState updater (which runs during React's
  // reconciliation and must not trigger Zustand store updates).
  const latestExecutionRef = useRef<WorkflowExecution | null>(null);
  const terminalOverlayApplied = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const fallbackRef = useRef(false);
  // Tracks the active executionId and workflowId for readStoredPathState validation
  // and to detect workflow switches (setWorkflow already resets visual state).
  const currentExecutionIdRef = useRef<string | null>(null);
  const currentWorkflowIdRef = useRef<string | null>(null);
  // Accumulates the latest complete edge pathState from the engine.
  // The engine sends a full snapshot on every step event, so the latest value is always correct.
  const latestPathStateRef = useRef<Record<string, 'running' | 'completed'> | null>(null);
  // Accumulates merged iteration-level edge pathState (loop body edges).
  const latestIterationPathStateRef = useRef<IterationPathStateMap | null>(null);

  /** Apply canvas overlay whenever execution context.steps changes */
  const applyOverlay = useCallback(
    (exec: WorkflowExecution) => {
      if (terminalOverlayApplied.current) return;

      const rawCtx = (exec.context as Record<string, unknown> | undefined) ?? {};
      const rawCtxSteps = (rawCtx.steps ?? {}) as Record<string, unknown>;
      const derivedSteps = contextStepsToResults(rawCtxSteps);
      if (derivedSteps.length > 0) {
        setExecutionContext(rawCtx);
        const { nodes, edges } = useWorkflowCanvasStore.getState();

        // ── Build outer overlay (non-loop-body steps) ──────────────────────
        const isTerminalExec = TERMINAL_STATUSES.has(exec.status);
        const outerOverlay: Record<string, string> = {};
        for (const step of derivedSteps) {
          // If the execution reached a terminal state but the step never got
          // its final status written (e.g. cancelled mid-delay), normalize
          // its display status to match the execution outcome.
          const displayStatus =
            isTerminalExec && IN_FLIGHT_STEP_STATUSES.has(step.status) ? exec.status : step.status;
          outerOverlay[step.stepId] = displayStatus;
        }
        // Use backend pathState when available — avoids client-side inference issues
        // (condition node multi-branch, parallel loop body edges).
        const outerEdges = computeExecutionEdges({
          pathState: latestPathStateRef.current ?? undefined,
          edges,
          nodes,
          steps: derivedSteps.map((s) => ({
            ...s,
            status:
              isTerminalExec && IN_FLIGHT_STEP_STATUSES.has(s.status)
                ? (exec.status as typeof s.status)
                : s.status,
          })),
        });

        // ── Process loop nodes with loopContext ────────────────────────────
        const newEdgeBatchCounts: Record<string, EdgeBatchBadge> = {};
        let hasParallelBadges = false;

        for (const step of derivedSteps) {
          if (step.nodeType !== 'loop') continue;
          const rawStep = (rawCtxSteps as Record<string, unknown>)[step.stepName] as Record<
            string,
            unknown
          >;
          const loopContextRaw = rawStep?.loopContext as Array<Record<string, unknown>> | undefined;

          // Read mode early — needed for badge computation even when loopContext is absent.
          // Set by the engine at step start from loopStep.config.mode. Stable across page
          // refreshes; unlike loopCanvasNode?.data.config.mode which reflects the current
          // canvas state.
          const rawInput = rawStep?.input as Record<string, unknown> | undefined;
          const mode = (rawInput?.mode as string) ?? 'sequential';

          if (!loopContextRaw || loopContextRaw.length === 0) {
            // Body-step deltas don't update loopContext in the execution snapshot. Skip
            // iteration data update, but still compute parallel edge badges from the
            // persisted iterationEdgePathState so badges don't disappear between
            // loop-progress messages.
            if (mode === 'parallel' && !isTerminalExec && outerOverlay[step.stepId] === 'running') {
              const { iterationEdgePathState } = useWorkflowCanvasStore.getState();
              const loopIterPathState = iterationEdgePathState?.[step.stepId];
              if (loopIterPathState) {
                for (const edge of edges) {
                  const sourceNode = nodes.find((n) => n.id === edge.source);
                  const isBodyEdge =
                    (sourceNode?.data.nodeType === 'loop_start' &&
                      sourceNode.parentId === step.stepId) ||
                    sourceNode?.parentId === step.stepId;
                  if (!isBodyEdge) continue;
                  let count = 0;
                  for (const iterEdges of Object.values(loopIterPathState)) {
                    if (iterEdges[edge.id] === 'running') count++;
                  }
                  if (count > 0) {
                    newEdgeBatchCounts[edge.id] = { count, hasFailed: false };
                    hasParallelBadges = true;
                  }
                }
              }
            }
            continue;
          }

          // Parse iterations
          const iterations: LoopIterationEntry[] = loopContextRaw.map((iter) => {
            const rawIter = iter as Record<string, unknown>;
            const rawIterSteps = (rawIter.steps as Record<string, Record<string, unknown>>) ?? {};
            const steps: Record<string, { stepId: string; status: string }> = {};
            for (const [stepName, stepData] of Object.entries(rawIterSteps)) {
              steps[stepName] = {
                stepId: typeof stepData.stepId === 'string' ? stepData.stepId : '',
                status: typeof stepData.status === 'string' ? stepData.status : 'pending',
              };
            }
            return {
              currentIndex: typeof rawIter.currentIndex === 'number' ? rawIter.currentIndex : 0,
              currentItem: rawIter.currentItem,
              steps,
            };
          });

          // Store iteration data for dropdown
          setLoopData(step.stepId, iterations);

          if (mode === 'sequential') {
            // Always update selectedLoopIteration so executionEdges stays in sync
            setSelectedLoopIteration(step.stepId, iterations.length - 1);
          } else {
            // Parallel: default-select last iteration so edges get highlighted
            // (same as sequential — drives applyIterationToState in the store).
            setSelectedLoopIteration(step.stepId, iterations.length - 1);

            // Live badge counts for parallel loop execution.
            // Primary source: iterationEdgePathState from the store (set by loop-progress
            // WS messages, stable between body-step deltas so badges don't flicker).
            // Root cause of flicker: body-step deltas don't update loopContext in the
            // execution snapshot, so reading loopContext directly returned stale data
            // and cleared badges on every non-loop-progress delta.
            if (!isTerminalExec && outerOverlay[step.stepId] === 'running') {
              const { iterationEdgePathState } = useWorkflowCanvasStore.getState();
              const loopIterPathState = iterationEdgePathState?.[step.stepId];

              for (const edge of edges) {
                const sourceNode = nodes.find((n) => n.id === edge.source);
                const isBodyEdge =
                  (sourceNode?.data.nodeType === 'loop_start' &&
                    sourceNode.parentId === step.stepId) ||
                  sourceNode?.parentId === step.stepId;
                if (!isBodyEdge) continue;

                let count = 0;
                let hasFailed = false;

                if (loopIterPathState) {
                  // Stable: count iterations where this edge is currently active.
                  // iterationEdgePathState persists in the store across body-step deltas.
                  for (const iterEdges of Object.values(loopIterPathState)) {
                    if (iterEdges[edge.id] === 'running') count++;
                  }
                  // Failed iterations map to 'completed' in iterationEdgePathState;
                  // detect them from loopContext for the red-badge signal.
                  for (const iter of iterations) {
                    const targetStep = Object.values(iter.steps).find(
                      (s) => s.stepId === edge.target,
                    );
                    if (targetStep?.status === 'failed') {
                      count++;
                      hasFailed = true;
                    }
                  }
                } else {
                  // Fallback before first loop-progress message arrives.
                  for (const iter of iterations) {
                    const targetStep = Object.values(iter.steps).find(
                      (s) => s.stepId === edge.target,
                    );
                    if (!targetStep) continue;
                    if (targetStep.status === 'failed') {
                      count++;
                      hasFailed = true;
                    } else if (ACTIVE_STEP_STATUSES.has(targetStep.status)) {
                      count++;
                    }
                  }
                }

                if (count > 0) {
                  newEdgeBatchCounts[edge.id] = { count, hasFailed };
                  hasParallelBadges = true;
                }
              }
            }
          }
        }

        // Commit: set outer baseline and selected loop-iteration overlay.
        // setBaseExecution merges base outer status with selectedLoopIteration via
        // applyIterationToState. Do not overwrite it with an aggregate body overlay:
        // parallel loop bodies may execute different paths per iteration, and the
        // canvas must show the selected/default iteration path only.
        setBaseExecution(outerOverlay, outerEdges);

        if (hasParallelBadges) {
          setEdgeBatchCounts(newEdgeBatchCounts);
        } else {
          // Clear badges when no parallel loop is actively running — covers both
          // terminal execution and the case where the loop container transitions to
          // 'completed' while the outer execution is still running.
          setEdgeBatchCounts(null);
        }
      }

      if (TERMINAL_STATUSES.has(exec.status)) {
        terminalOverlayApplied.current = true;
        setEdgeBatchCounts(null);
        // wf_exec:<workflowId> stays intact so that if the user navigates away and
        // returns, readStoredPathState restores the final pathState and edge highlights
        // are exact without waiting for a new WS session.
      }
    },
    [
      setExecutionOverlay,
      setExecutionEdges,
      setBaseExecution,
      setLoopData,
      setSelectedLoopIteration,
      setEdgeBatchCounts,
      setExecutionContext,
    ],
  );

  // ── Polling fallback ─────────────────────────────────────────────────────
  const runPollingFallback = useCallback(
    (execId: string, proj: string, wfId: string) => {
      let cancelled = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      let errorCount = 0;
      const startTime = Date.now();

      const poll = async () => {
        if (cancelled) return;
        if (Date.now() - startTime > MAX_POLL_DURATION_MS) return;
        if (typeof document !== 'undefined' && document.hidden) {
          timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
          return;
        }
        try {
          const data = await getExecution(proj, wfId, execId);
          if (cancelled) return;
          errorCount = 0;
          latestExecutionRef.current = data;
          setExecution(data);
          setExecutionStatus(data.status);
          applyOverlay(data);
          if (!TERMINAL_STATUSES.has(data.status)) {
            timeoutId = setTimeout(poll, POLL_INTERVAL_MS);
          }
        } catch {
          errorCount++;
          if (!cancelled && errorCount < MAX_ERROR_RETRIES) {
            const backoff = Math.min(
              POLL_INTERVAL_MS * Math.pow(2, errorCount - 1),
              MAX_BACKOFF_MS,
            );
            timeoutId = setTimeout(poll, backoff);
          }
        }
      };

      timeoutId = setTimeout(poll, INITIAL_DELAY_MS);
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    },
    [applyOverlay, setExecutionStatus],
  );

  // ── Main effect ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!executionId || executionId === '__starting__' || !projectId || !workflowId) {
      setExecution(null);
      return;
    }

    terminalOverlayApplied.current = false;
    fallbackRef.current = false;

    // No explicit clear needed: setCurrentExecutionId already cleared pathState in
    // wf_exec:<workflowId> when the new execution id was set. Cross-workflow
    // navigation must not clear the old workflow's path — setWorkflow already
    // resets visual state and the user may return to that workflow.
    currentExecutionIdRef.current = executionId;
    currentWorkflowIdRef.current = workflowId ?? null;
    latestExecutionRef.current = null;
    latestPathStateRef.current = null;
    latestIterationPathStateRef.current = null;

    // Restore persisted edge pathState from wf_exec:<workflowId> so edge highlights
    // are available immediately on reconnect / polling fallback without waiting
    // for the first WS step delta. readStoredPathState validates that the stored
    // executionId matches the current one before returning data.
    const persisted = readStoredPathState();
    if (persisted?.pathState) {
      latestPathStateRef.current = persisted.pathState;
    }
    if (persisted?.iterationPathState) {
      latestIterationPathStateRef.current = persisted.iterationPathState;
      mergeIterationEdgePathState(persisted.iterationPathState);
    }

    // If no WS URL or no token, go straight to polling
    if (!wsUrl || !accessToken) {
      const stop = runPollingFallback(executionId, projectId, workflowId);
      return () => {
        stop();
        setExecutionOverlay(null);
        setExecutionEdges(null);
        setEdgeBatchCounts(null);
      };
    }

    let cancelled = false;
    let stopPolling: (() => void) | null = null;

    const switchToPolling = () => {
      if (fallbackRef.current || cancelled) return;
      fallbackRef.current = true;
      stopPolling = runPollingFallback(executionId, projectId!, workflowId!);
    };

    // Connect WS — upgrade ws:// → wss:// on HTTPS pages (mixed-content block).
    // Strip any trailing /ws or /ws/workflows suffix before appending the canonical path,
    // so RUNTIME_WS_URL=ws://host/ws and ws://host/ws/workflows both resolve correctly.
    const rawWsUrl = `${wsUrl.replace(/\/ws\/workflows$|\/ws$/, '')}/ws/workflows`;
    const resolvedWsUrl =
      typeof window !== 'undefined' &&
      window.location.protocol === 'https:' &&
      rawWsUrl.startsWith('ws://')
        ? rawWsUrl.replace(/^ws:\/\//, 'wss://')
        : rawWsUrl;
    let ws: WebSocket;
    try {
      ws = new WebSocket(resolvedWsUrl, buildWebDebugWSProtocols(accessToken));
    } catch {
      switchToPolling();
      return () => {
        stopPolling?.();
        setExecutionOverlay(null);
        setExecutionEdges(null);
        setEdgeBatchCounts(null);
      };
    }

    wsRef.current = ws;

    // Fallback if connection doesn't open in time
    const connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close();
        switchToPolling();
      }
    }, WS_CONNECT_TIMEOUT_MS);

    let reconnectFailTimer: ReturnType<typeof setTimeout> | null = null;

    ws.onopen = () => {
      clearTimeout(connectTimer);
      ws.send(
        JSON.stringify({
          type: 'subscribe_execution',
          projectId,
          workflowId,
          executionId,
        }),
      );
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (cancelled) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = msg.type as string;

      if (type === 'workflow_execution_snapshot') {
        const snap = msg as unknown as SnapshotMsg;
        const exec = applySnapshot(snap.execution);
        latestExecutionRef.current = exec;
        setExecution(exec);
        setExecutionStatus(exec.status);
        applyOverlay(exec);
      } else if (type === 'workflow_step_status') {
        const delta = msg as unknown as StepDeltaMsg;
        const prev = latestExecutionRef.current;
        if (!prev) return;

        // Update path state refs before applyOverlay reads them.
        if (delta.pathState && Object.keys(delta.pathState).length > 0) {
          latestPathStateRef.current = delta.pathState;
        }
        if (delta.iterationPathState && Object.keys(delta.iterationPathState).length > 0) {
          mergeIterationEdgePathState(delta.iterationPathState);
          latestIterationPathStateRef.current = {
            ...(latestIterationPathStateRef.current ?? {}),
            ...delta.iterationPathState,
          };
        }
        // Persist into wf_exec:<workflowId> so edge highlights survive WS reconnects
        // and polling fallback. Use the refs (not get()) so writes target the correct
        // storage key even if the store has already switched to a different workflow.
        if (delta.pathState || delta.iterationPathState) {
          const wfId = currentWorkflowIdRef.current;
          const execId = currentExecutionIdRef.current;
          if (wfId && execId) {
            setPersistedPathState(
              wfId,
              execId,
              latestPathStateRef.current,
              latestIterationPathStateRef.current,
            );
          }
        }

        // Compute next outside React's setState updater so Zustand setters
        // (setExecutionStatus, applyOverlay) are never called during reconciliation.
        const next = mergeStepDelta(prev, delta);
        latestExecutionRef.current = next;
        setExecution(next);
        setExecutionStatus(next.status);
        applyOverlay(next);
      } else if (type === 'workflow_execution_status') {
        const delta = msg as unknown as ExecutionDeltaMsg;
        const prev = latestExecutionRef.current;
        if (!prev) return;
        // Completed/failed execution outcome wins over a concurrent cancel:
        // if the execution actually ran to completion, don't let a late
        // 'cancelled' event (which arrived after the natural terminal state)
        // override the real outcome shown to the user.
        if (
          (prev.status === 'completed' || prev.status === 'failed') &&
          delta.status === 'cancelled'
        ) {
          return;
        }
        const next = mergeExecutionDelta(prev, delta);
        latestExecutionRef.current = next;
        if (delta.pathState && Object.keys(delta.pathState).length > 0) {
          latestPathStateRef.current = delta.pathState;
        }
        if (delta.iterationPathState && Object.keys(delta.iterationPathState).length > 0) {
          mergeIterationEdgePathState(delta.iterationPathState);
          latestIterationPathStateRef.current = {
            ...(latestIterationPathStateRef.current ?? {}),
            ...delta.iterationPathState,
          };
        }
        if (delta.pathState || delta.iterationPathState) {
          setPersistedPathState(
            workflowId,
            executionId,
            latestPathStateRef.current,
            latestIterationPathStateRef.current,
          );
        }
        setExecution(next);
        setExecutionStatus(next.status);
        applyOverlay(next);
        // workflow_execution_status deltas carry no step context data, so
        // applyOverlay above has nothing to color the canvas nodes. On terminal
        // status, refetch the full execution to get context.steps and re-apply.
        if (TERMINAL_STATUSES.has(delta.status) && projectId && workflowId) {
          void getExecution(projectId, workflowId, executionId)
            .then((full) => {
              if (cancelled) return;
              terminalOverlayApplied.current = false;
              latestExecutionRef.current = full;
              setExecution(full);
              applyOverlay(full);
            })
            .catch((err: unknown) => {
              console.warn('Terminal overlay refetch failed', {
                executionId,
                err: err instanceof Error ? err.message : String(err),
              });
            });
        }
      } else if (type === 'execution_not_found' || type === 'error') {
        switchToPolling();
      }
    };

    ws.onerror = () => {
      clearTimeout(connectTimer);
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (cancelled) return;
      if (!fallbackRef.current) {
        // Give a grace period to reconnect; if not, fall back to polling
        reconnectFailTimer = setTimeout(() => {
          if (!cancelled) switchToPolling();
        }, WS_RECONNECT_GIVE_UP_MS);
      }
    };

    return () => {
      cancelled = true;
      clearTimeout(connectTimer);
      if (reconnectFailTimer) clearTimeout(reconnectFailTimer);
      stopPolling?.();

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'unsubscribe_execution', executionId }));
        }
        ws.close();
      }
      wsRef.current = null;
      latestPathStateRef.current = null;
      latestIterationPathStateRef.current = null;

      setExecutionOverlay(null);
      setExecutionEdges(null);
      setEdgeBatchCounts(null);
      useWorkflowCanvasStore.setState({ iterationEdgePathState: null });
    };
  }, [
    executionId,
    projectId,
    workflowId,
    wsUrl,
    accessToken,
    applyOverlay,
    runPollingFallback,
    setExecutionOverlay,
    setExecutionEdges,
    setEdgeBatchCounts,
    setExecutionStatus,
    mergeIterationEdgePathState,
    setPersistedPathState,
    readStoredPathState,
  ]);

  return execution;
}
