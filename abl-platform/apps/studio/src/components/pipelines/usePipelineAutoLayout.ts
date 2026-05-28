/**
 * usePipelineAutoLayout
 *
 * ELK auto-layout hook for the pipeline graph editor.
 * Uses 'layered' algorithm with direction 'DOWN'.
 *
 * Pattern: follows useAutoLayout.ts from the canvas/hooks.
 */

import { useCallback, useRef, useState, useMemo, startTransition } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { PIPELINE_NODE_WIDTH, PIPELINE_NODE_HEIGHT } from './PipelineNodeComponent';
import { TRIGGER_NODE_ID, TRIGGER_POSITION_OFFSET_Y } from './pipeline-trigger-constants';

// =============================================================================
// Types
// =============================================================================

interface ElkNodeInput {
  id: string;
  width: number;
  height: number;
}

interface ElkEdgeInput {
  id: string;
  sources: string[];
  targets: string[];
}

interface ElkGraphInput {
  id: string;
  children: ElkNodeInput[];
  edges: ElkEdgeInput[];
}

interface ElkNodeOutput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElkLayoutResult {
  id: string;
  children: ElkNodeOutput[];
}

type ELKInstance = {
  layout(
    graph: Record<string, unknown>,
    args?: { layoutOptions?: Record<string, string> },
  ): Promise<ElkLayoutResult>;
};

export interface UsePipelineAutoLayoutResult {
  /** Run auto-layout and return positioned nodes */
  autoLayout: (nodes: Node[], edges: Edge[]) => Promise<Node[]>;
  /** Whether layout is currently computing */
  isComputing: boolean;
}

// =============================================================================
// ELK Layout Config
// =============================================================================

const PIPELINE_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.spacing.nodeNode': '80',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '120',
};

// =============================================================================
// ELK Singleton
// =============================================================================

let elkInstance: ELKInstance | null = null;

async function getElk(): Promise<ELKInstance> {
  if (!elkInstance) {
    const mod = await import('elkjs/lib/elk.bundled.js');
    const ELK = mod.default;
    elkInstance = new ELK() as unknown as ELKInstance;
  }
  return elkInstance;
}

// =============================================================================
// Helpers
// =============================================================================

function nodesToElkGraph(nodes: Node[], edges: Edge[]): ElkGraphInput {
  // Only include top-level nodes in the ELK layout
  const topLevelNodes = nodes.filter((n) => !n.parentId && n.id !== TRIGGER_NODE_ID);

  // Edges: only between top-level nodes
  const topLevelIds = new Set(topLevelNodes.map((n) => n.id));

  return {
    id: 'root',
    children: topLevelNodes.map((node) => ({
      id: node.id,
      width: (node.style?.width as number) ?? PIPELINE_NODE_WIDTH,
      height: (node.style?.height as number) ?? PIPELINE_NODE_HEIGHT,
    })),
    edges: edges
      .filter((e) => topLevelIds.has(e.source) && topLevelIds.has(e.target))
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  };
}

function applyElkPositions(nodes: Node[], layout: ElkLayoutResult): Node[] {
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const child of layout.children ?? []) {
    positionMap.set(child.id, { x: child.x, y: child.y });
  }

  return nodes.map((node) => {
    const pos = positionMap.get(node.id);
    if (!pos) return node;
    return {
      ...node,
      position: { x: pos.x, y: pos.y },
    };
  });
}

/**
 * After ELK layout, reposition the trigger node above the entry node.
 */
function repositionTriggerNode(nodes: Node[], edges: Edge[]): Node[] {
  const triggerEdge = edges.find((e) => e.source === TRIGGER_NODE_ID);
  if (!triggerEdge) return nodes;

  const entryNode = nodes.find((n) => n.id === triggerEdge.target);
  if (!entryNode) return nodes;

  return nodes.map((n) =>
    n.id === TRIGGER_NODE_ID
      ? {
          ...n,
          position: {
            x: entryNode.position.x,
            y: entryNode.position.y + TRIGGER_POSITION_OFFSET_Y,
          },
        }
      : n,
  );
}

// =============================================================================
// Hook
// =============================================================================

export function usePipelineAutoLayout(): UsePipelineAutoLayoutResult {
  const [isComputing, setIsComputing] = useState(false);
  const computeIdRef = useRef(0);

  const autoLayout = useCallback(async (nodes: Node[], edges: Edge[]): Promise<Node[]> => {
    if (nodes.length === 0) return nodes;

    const computeId = ++computeIdRef.current;
    setIsComputing(true);

    try {
      const elk = await getElk();
      const graph = nodesToElkGraph(nodes, edges);
      const result = await elk.layout(graph as unknown as Record<string, unknown>, {
        layoutOptions: PIPELINE_LAYOUT_OPTIONS,
      });

      // Stale check — another layout was requested
      if (computeId !== computeIdRef.current) return nodes;

      const positioned = applyElkPositions(nodes, result);
      const withTrigger = repositionTriggerNode(positioned, edges);

      startTransition(() => {
        setIsComputing(false);
      });

      return withTrigger;
    } catch (err) {
      if (computeId !== computeIdRef.current) return nodes;

      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('Pipeline ELK layout failed:', message);

      setIsComputing(false);
      return nodes;
    }
  }, []);

  return useMemo(() => ({ autoLayout, isComputing }), [autoLayout, isComputing]);
}
