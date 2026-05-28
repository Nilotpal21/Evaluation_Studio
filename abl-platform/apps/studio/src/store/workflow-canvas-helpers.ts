/**
 * Pure helpers for the workflow canvas — cycle detection and connection
 * validity. Kept separate from workflow-canvas-store.ts so they can be unit
 * tested without pulling in Zustand.
 *
 * Rules enforced:
 *  - No self-loops (`source === target`).
 *  - No cycles (adding the edge must not close a cycle in the existing graph).
 *  - Loop body nodes use ReactFlow parentId (child nodes), not canvas back-edges,
 *    so loop nodes receive the same cycle detection as every other node type.
 */

import type { Connection, Edge, Node } from '@xyflow/react';
import type { NodeType } from '@agent-platform/shared-kernel/types';

interface NodeTypeLookup {
  get(id: string): NodeType | undefined;
}

interface ParentLookup {
  get(id: string): string | undefined;
}

function buildNodeTypeLookup(nodes: Node<{ nodeType: NodeType }>[]): NodeTypeLookup {
  const map = new Map<string, NodeType>();
  for (const n of nodes) map.set(n.id, n.data.nodeType);
  return map;
}

function buildParentLookup(nodes: Node<{ nodeType: NodeType }>[]): ParentLookup {
  const map = new Map<string, string | undefined>();
  for (const n of nodes) map.set(n.id, n.parentId);
  return map;
}

/**
 * Returns true iff adding the edge `source -> target` would create a cycle
 * in the existing edge set. Self-loops always return true.
 */
export function wouldCreateCycle(
  edges: Edge[],
  source: string,
  target: string,
  nodeTypeOf: NodeTypeLookup,
  parentOf?: ParentLookup,
): boolean {
  const normalizeTarget = (id: string): string => {
    if (nodeTypeOf.get(id) === 'loop_start') {
      return parentOf?.get(id) ?? id;
    }
    return id;
  };

  const effectiveTarget = normalizeTarget(target);
  if (source === effectiveTarget) return true;

  // Build adjacency list from all existing edges. Edges entering loop_start are
  // executed as edges entering the loop container, so cycle detection must use
  // that effective graph instead of the raw React Flow node IDs.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    const effectiveExistingTarget = normalizeTarget(e.target);
    if (list) list.push(effectiveExistingTarget);
    else adj.set(e.source, [effectiveExistingTarget]);
  }

  // DFS from target — if we can reach source, adding source->target closes a cycle.
  const stack = [effectiveTarget];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === source) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    const next = adj.get(n);
    if (next) stack.push(...next);
  }
  return false;
}

/**
 * Validates a connection during a React Flow drag. Runs on every mouse move
 * so it must stay O(V+E) — which DFS above is.
 */
export function isValidWorkflowConnection(
  edges: Edge[],
  nodes: Node<{ nodeType: NodeType }>[],
  connection: Connection | Edge,
): boolean {
  if (!connection.source || !connection.target) return false;
  const lookup = buildNodeTypeLookup(nodes);
  const parentLookup = buildParentLookup(nodes);
  const sourceType = lookup.get(connection.source);
  const targetType = lookup.get(connection.target);
  const sourceParentId = parentLookup.get(connection.source);
  const targetParentId = parentLookup.get(connection.target);

  // Outer nodes may connect directly to a loop_start node (the loop's visual
  // entry socket). loop_start lives inside the loop container (has parentId),
  // but this is the intended way to wire a preceding step into a loop.
  const isOuterToLoopStart = targetType === 'loop_start' && !sourceParentId;

  if (!isOuterToLoopStart) {
    // Nodes in different loop scopes (or one outer, one inner) must not connect.
    // loop_end is a sibling child inside the loop body — same-scope check passes naturally.
    if (targetParentId !== sourceParentId) {
      return false;
    }

    if (sourceType === 'loop_start') {
      if (!sourceParentId || targetType === 'loop_start') {
        return false;
      }
    }

    if (targetType === 'loop_start') {
      return false;
    }

    // loop_end is a terminal — nothing should connect out of it
    if (sourceType === 'loop_end') {
      return false;
    }
  }

  return !wouldCreateCycle(edges, connection.source, connection.target, lookup, parentLookup);
}

/**
 * Returns the set of existing nodes that a source handle can legally connect
 * to. The picker in HandlePlusMenu uses this to show only candidates that
 * `onConnect` would accept — picker UX and store predicate must never drift.
 *
 * Eligibility composes the three sequential guards `onConnect` applies (see
 * workflow-canvas-store.ts:790-822):
 *   (a) duplicate-edge check — no existing edge with the same
 *       (source, sourceHandle, target)
 *   (b) fan-out cap — source handle has fewer than `maxFanOut` outgoing edges
 *   (c) `isValidWorkflowConnection` — scope (parentId / Loop boundary) and
 *       cycle detection
 *
 * Plus the trivial self-exclusion (candidate.id === sourceNodeId).
 */
export function getEligibleConnectTargets<TData extends { nodeType: NodeType }>(
  nodes: Node<TData>[],
  edges: Edge[],
  sourceNodeId: string,
  sourceHandle: string,
  maxFanOut: number,
): Node<TData>[] {
  const fanOutCount = edges.filter(
    (e) => e.source === sourceNodeId && e.sourceHandle === sourceHandle,
  ).length;
  if (fanOutCount >= maxFanOut) return [];

  return nodes.filter((candidate) => {
    if (candidate.id === sourceNodeId) return false;

    // Start nodes are the workflow's entry point — they never accept
    // incoming edges. Excluded unconditionally so the picker never
    // surfaces them, even if isValidWorkflowConnection would technically
    // allow it.
    if (candidate.data.nodeType === 'start') return false;

    // loop_start / loop_end are implementation-detail sockets inside a
    // loop container. Users should pick the loop CONTAINER (which the
    // picker remaps to loop_start at click time); these inner sockets
    // must not appear as picker rows.
    if (candidate.data.nodeType === 'loop_start') return false;
    if (candidate.data.nodeType === 'loop_end') return false;

    const isDuplicate = edges.some(
      (e) =>
        e.source === sourceNodeId && e.sourceHandle === sourceHandle && e.target === candidate.id,
    );
    if (isDuplicate) return false;

    return isValidWorkflowConnection(edges, nodes, {
      source: sourceNodeId,
      sourceHandle,
      target: candidate.id,
      targetHandle: null,
    });
  });
}
