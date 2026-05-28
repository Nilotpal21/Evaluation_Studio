/**
 * computeExecutionEdges
 *
 * Maps execution step data to canvas edge IDs that should be highlighted.
 * Returns two sets: traversed (green) and active (animated particles).
 *
 * Design: when the backend provides pre-computed edge IDs, pass them via
 * `backendTraversedEdgeIds` / `backendActiveEdgeIds` and local computation
 * is skipped. Until then, we derive the execution path from step output.
 */

import type { Edge } from '@xyflow/react';
import type { ExecutionStepResult } from '../../../../api/workflows';
import type { WorkflowFlowNode } from '../../../../store/workflow-canvas-store';

// ─── Public types ────────────────────────────────────────────────────────────

export interface ExecutionEdges {
  /** Edge IDs along the completed execution path */
  traversed: Set<string>;
  /** Edge IDs currently carrying data (source done, target running/waiting) */
  active: Set<string>;
}

// ─── Status groups ───────────────────────────────────────────────────────────

/** Statuses where the node finished executing and took an outgoing handle */
const DONE_STATUSES = new Set(['completed', 'rejected', 'failed', 'skipped']);

/** Terminal statuses — the node will not change further */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected', 'cancelled', 'skipped']);

/** In-progress statuses — the node is still running or suspended */
const ACTIVE_STATUSES = new Set([
  'running',
  'waiting_approval',
  'waiting_human_task',
  'waiting_delay',
  'waiting_callback',
]);

// ─── Handle resolution ──────────────────────────────────────────────────────

/**
 * Determine which sourceHandle a step took based on its nodeType and outcome.
 * Returns undefined when the step hasn't finished or the handle is unknown.
 */
function getTakenHandle(step: ExecutionStepResult, canvasNodeType?: string): string | undefined {
  // Cast: the DB can store statuses (e.g. 'rejected') not yet in the TS union.
  const status = step.status as string;
  // The engine converts canvas NodeType to engine step types during
  // canvas-to-steps conversion (e.g. 'human' → 'human_task', 'data_entry' → 'human_task').
  // Use the canvas node type when available — it's the authoritative source for handle names
  // since both 'human' (approval) and 'data_entry' map to 'human_task' at engine level.
  const type = canvasNodeType ?? step.nodeType;

  switch (type) {
    case 'condition': {
      const output = step.output as { branchTaken?: string } | undefined;
      return output?.branchTaken;
    }
    case 'human':
    case 'human_task':
      // Approval nodes use on_approve / on_reject handles
      if (status === 'completed' || status === 'skipped' || status === 'approved')
        return 'on_approve';
      if (status === 'rejected') return 'on_reject';
      if (status === 'failed') return 'on_failure';
      return undefined;
    case 'data_entry':
      // Data Entry nodes use on_success / on_failure handles (no on_approve/on_reject)
      if (status === 'completed' || status === 'skipped') return 'on_success';
      if (status === 'failed') return 'on_failure';
      return undefined;
    case 'loop':
      if (status === 'completed') return 'on_complete';
      if (status === 'failed') return 'on_failure';
      return undefined;
    case 'start':
      return 'on_success';
    case 'end':
      return undefined; // End nodes have no outgoing edges
    default:
      if (status === 'completed' || status === 'skipped') return 'on_success';
      if (status === 'failed') return 'on_failure';
      return undefined;
  }
}

// ─── Main computation ────────────────────────────────────────────────────────

export function computeExecutionEdges(params: {
  /**
   * Backend-authoritative edge pathState — supersedes local computation when present.
   * 'running' → active (animated); 'completed' → traversed (highlighted).
   */
  pathState?: Record<string, 'running' | 'completed'>;
  /** Pre-computed edge IDs from backend — skips local computation (legacy) */
  backendTraversedEdgeIds?: string[];
  backendActiveEdgeIds?: string[];
  /** Canvas edges and nodes for local computation */
  edges: Edge[];
  nodes: WorkflowFlowNode[];
  steps: ExecutionStepResult[];
}): ExecutionEdges {
  const { pathState, backendTraversedEdgeIds, backendActiveEdgeIds, edges, nodes, steps } = params;

  // ── Fast path: backend provides pathState directly ───────────────────────
  if (pathState) {
    const traversed = new Set<string>();
    const active = new Set<string>();
    for (const [edgeId, status] of Object.entries(pathState)) {
      if (status === 'completed') traversed.add(edgeId);
      else if (status === 'running') active.add(edgeId);
    }
    return { traversed, active };
  }

  // ── Legacy fast path: backend provides edge ID arrays ───────────────────
  if (backendTraversedEdgeIds || backendActiveEdgeIds) {
    return {
      traversed: new Set(backendTraversedEdgeIds ?? []),
      active: new Set(backendActiveEdgeIds ?? []),
    };
  }

  const empty: ExecutionEdges = { traversed: new Set(), active: new Set() };
  if (!steps.length || !edges.length) return empty;

  // ── Build lookups ────────────────────────────────────────────────────────
  const stepById = new Map<string, ExecutionStepResult>();
  for (const step of steps) {
    stepById.set(step.stepId, step);
  }

  const nodeById = new Map<string, WorkflowFlowNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  // Relay-race executions store the start/end steps with literal IDs ('start',
  // 'end') because canvas-to-steps skips those nodes. Alias them to their
  // canvas UUIDs so stepById lookups work correctly for edge classification
  // and canvas node status display.
  for (const node of nodes) {
    const nodeType = node.data.nodeType as string;
    if (nodeType === 'start' || nodeType === 'end') {
      const literalStep = stepById.get(nodeType);
      if (literalStep && !stepById.has(node.id)) {
        stepById.set(node.id, literalStep);
      }
    }
  }

  // source -> list of outgoing edges
  const edgesBySource = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) ?? [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }

  // ── Walk each executed step and classify its outgoing edges ──────────────
  const traversed = new Set<string>();
  const active = new Set<string>();

  // Start node may not appear in steps — treat it as completed when any
  // steps exist (execution must have passed through start).
  const startNode = nodes.find((n) => n.data.nodeType === 'start');
  if (startNode && !stepById.has(startNode.id)) {
    classifyOutgoingEdges(startNode.id, 'on_success');
  }

  for (const step of steps) {
    if (!DONE_STATUSES.has(step.status)) continue;
    const canvasNode = nodeById.get(step.stepId);
    const handle = getTakenHandle(step, canvasNode?.data.nodeType as string | undefined);
    if (!handle) continue;
    classifyOutgoingEdges(step.stepId, handle);
  }

  return { traversed, active };

  // ── Helper: classify edges from a node for a given handle ───────────────
  function classifyOutgoingEdges(nodeId: string, takenHandle: string) {
    const outEdges = edgesBySource.get(nodeId);
    if (!outEdges) return;

    for (const edge of outEdges) {
      if (edge.sourceHandle !== takenHandle) continue;

      const targetNode = nodeById.get(edge.target);
      const isTargetEnd = targetNode?.data.nodeType === 'end';

      if (isTargetEnd) {
        // End node reached — always mark traversed when the handle matches
        traversed.add(edge.id);
        continue;
      }

      // canvas-to-steps redirects edges targeting loop_start to the loop container
      // at compile time, but the canvas edge still points at loop_start — resolve it
      let targetStepId = edge.target;
      if (targetNode?.data.nodeType === 'loop_start' && targetNode.parentId) {
        targetStepId = targetNode.parentId;
      }
      const targetStep = stepById.get(targetStepId);
      if (!targetStep) continue;

      if (TERMINAL_STATUSES.has(targetStep.status)) {
        traversed.add(edge.id);
      } else if (ACTIVE_STATUSES.has(targetStep.status)) {
        active.add(edge.id);
      }
    }
  }
}
