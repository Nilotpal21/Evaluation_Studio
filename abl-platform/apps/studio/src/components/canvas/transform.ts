import type { Edge, XYPosition } from '@xyflow/react';
import type { TopologyData, TopologyNode, TopologyEdge } from '../../types/arch';
import type { Node } from '@xyflow/react';
import type { AgentNodeData } from './types';
import type { RelationshipEdgeData, RelationshipType } from './edges/RelationshipEdge';
import type { TopologyPattern } from '../../store/canvas-store';
import {
  PROJECT_LAYOUT_CONFIG,
  MESH_LAYOUT_CONFIG,
  CHAIN_LAYOUT_CONFIG,
  PROJECT_NODE_DIMENSIONS,
} from './types';

export type CanvasEdge = Edge<RelationshipEdgeData>;

// =============================================================================
// Pattern Detection
// =============================================================================

function countBidirectionalPairs(edges: TopologyEdge[]): number {
  const pairSet = new Set<string>();
  let count = 0;

  for (const edge of edges) {
    const forward = `${edge.from}->${edge.to}`;
    const reverse = `${edge.to}->${edge.from}`;

    if (pairSet.has(reverse)) {
      count++;
    }
    pairSet.add(forward);
  }

  return count;
}

export function detectTopologyPattern(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
): TopologyPattern {
  const supervisorCount = nodes.filter((n) => n.type === 'supervisor').length;

  if (supervisorCount > 0) return 'tree';

  const bidirectionalPairs = countBidirectionalPairs(edges);
  if (edges.length > 0 && bidirectionalPairs / edges.length > 0.3) return 'mesh';

  return 'chain';
}

export function getLayoutConfigForPattern(pattern: TopologyPattern): Record<string, string> {
  switch (pattern) {
    case 'mesh':
      return MESH_LAYOUT_CONFIG;
    case 'chain':
      return CHAIN_LAYOUT_CONFIG;
    default:
      return PROJECT_LAYOUT_CONFIG;
  }
}

// =============================================================================
// Node Rank Assignment (for stagger animation)
// =============================================================================

function assignRanks(nodes: TopologyNode[], edges: TopologyEdge[]): Map<string, number> {
  const rankMap = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }

  const entryNode = nodes.find((n) => n.isEntry) ?? nodes[0];
  if (!entryNode) return rankMap;

  const visited = new Set<string>();
  const queue: { id: string; rank: number }[] = [{ id: entryNode.id, rank: 0 }];
  visited.add(entryNode.id);
  rankMap.set(entryNode.id, 0);

  while (queue.length > 0) {
    const { id, rank } = queue.shift()!;
    for (const kid of children.get(id) ?? []) {
      if (!visited.has(kid)) {
        visited.add(kid);
        rankMap.set(kid, rank + 1);
        queue.push({ id: kid, rank: rank + 1 });
      }
    }
  }

  for (const node of nodes) {
    if (!rankMap.has(node.id)) {
      rankMap.set(node.id, 1);
    }
  }

  return rankMap;
}

// =============================================================================
// Topology → ReactFlow Nodes
// =============================================================================

export type CanvasNode = Node<AgentNodeData, 'agent-node'>;

export function topologyToReactFlowNodes(
  topology: TopologyData,
  agentSummaries?: Map<string, { goal?: string; model?: string; lastUpdated?: string }>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const ranks = assignRanks(topology.nodes, topology.edges);

  const nodes: CanvasNode[] = topology.nodes.map((tNode) => {
    const summary = agentSummaries?.get(tNode.id);
    const rank = ranks.get(tNode.id) ?? 0;

    const data: AgentNodeData = {
      name: tNode.name,
      agentType: tNode.type === 'supervisor' ? 'supervisor' : 'agent',
      executionMode: tNode.executionMode,
      isEntry: tNode.isEntry,
      goal: tNode.description ?? summary?.goal ?? '',
      toolCount: tNode.tools.length,
      stepCount: tNode.flowStepCount ?? 0,
      gatherFieldsCount: tNode.gatherFields?.length ?? 0,
      hasEscalation: false,
      hasErrors: false,
      errorCount: 0,
      model: summary?.model,
      healthStatus: tNode.healthStatus,
      rank,
    };

    return {
      id: tNode.id,
      type: 'agent-node' as const,
      position: { x: 0, y: 0 },
      data,
    };
  });

  const nodeIds = new Set(topology.nodes.map((n) => n.id));
  const validEdges = topology.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  const TOPO_TO_REL: Record<string, RelationshipType> = {
    handoff: 'handoff',
    routing: 'delegate',
    escalation: 'escalate',
  };

  const edges: CanvasEdge[] = validEdges.map((tEdge, i) => {
    const relType = TOPO_TO_REL[tEdge.type] ?? 'handoff';
    return {
      id: `e-${tEdge.from}-${tEdge.to}-${relType}-${i}`,
      source: tEdge.from,
      target: tEdge.to,
      type: 'relationship',
      data: {
        relationshipType: relType,
        label: tEdge.condition,
      } satisfies RelationshipEdgeData,
    };
  });

  return { nodes, edges };
}

// =============================================================================
// Smart Node Positioning — find collision-free position for a new node
// =============================================================================

/**
 * Find an available position for a new node that avoids overlapping existing nodes.
 * Strategy: place below the bounding box of all existing nodes,
 * then shift right if that spot collides.
 */
export function findAvailablePosition(
  existingNodes: Array<{ position: XYPosition; width?: number; height?: number }>,
): XYPosition {
  const nodeDims = PROJECT_NODE_DIMENSIONS['agent-node'];
  const GAP = 60;

  if (existingNodes.length === 0) {
    return { x: 0, y: 0 };
  }

  let maxX = -Infinity;
  let maxY = -Infinity;
  let minX = Infinity;

  for (const node of existingNodes) {
    const w = node.width ?? nodeDims.width;
    const h = node.height ?? nodeDims.height;
    const right = node.position.x + w;
    const bottom = node.position.y + h;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
    if (node.position.x < minX) minX = node.position.x;
  }

  let candidate: XYPosition = { x: minX, y: maxY + GAP };

  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const hasCollision = existingNodes.some((node) => {
      const w = node.width ?? nodeDims.width;
      const h = node.height ?? nodeDims.height;
      return (
        candidate.x < node.position.x + w + GAP / 2 &&
        candidate.x + nodeDims.width + GAP / 2 > node.position.x &&
        candidate.y < node.position.y + h + GAP / 2 &&
        candidate.y + nodeDims.height + GAP / 2 > node.position.y
      );
    });

    if (!hasCollision) break;
    candidate = { x: candidate.x + nodeDims.width + GAP, y: candidate.y };
  }

  return candidate;
}
