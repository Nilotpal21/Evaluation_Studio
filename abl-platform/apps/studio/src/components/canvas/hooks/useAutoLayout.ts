import { useState, useEffect, useRef, useMemo, startTransition, useCallback } from 'react';
import type { Node, Edge, XYPosition } from '@xyflow/react';
import type { ElkGraphInput, ElkLayoutResult } from '../types';
import { PROJECT_NODE_DIMENSIONS } from '../types';

type NodeDimensionKey = keyof typeof PROJECT_NODE_DIMENSIONS;

function nodesToElkGraph(nodes: Node[], edges: Edge[]): ElkGraphInput {
  return {
    id: 'root',
    children: nodes.map((node) => {
      const dims =
        PROJECT_NODE_DIMENSIONS[(node.type as NodeDimensionKey) ?? 'agent'] ??
        PROJECT_NODE_DIMENSIONS.agent;
      const data = node.data as Record<string, unknown>;
      const isEntry = data?.isEntry === true || data?.agentType === 'supervisor';
      return {
        id: node.id,
        width: dims.width,
        height: dims.height,
        ...(isEntry ? { layoutOptions: { 'elk.layered.layerConstraint': 'FIRST' } } : {}),
      };
    }),
    edges: edges.map((edge) => ({
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

function mergeWithPersistedPositions(
  nodes: Node[],
  persisted: Record<string, XYPosition> | undefined,
): Node[] {
  if (!persisted) return nodes;
  return nodes.map((node) => {
    const saved = persisted[node.id];
    // Skip zero positions (stale/invalid) — let ELK position stand
    if (!saved || (saved.x === 0 && saved.y === 0)) return node;
    return { ...node, position: saved };
  });
}

interface UseAutoLayoutResult {
  layoutedNodes: Node[];
  layoutedEdges: Edge[];
  isComputing: boolean;
  layoutReady: boolean;
  recompute: () => void;
}

type ELKInstance = {
  layout(
    graph: Record<string, unknown>,
    args?: { layoutOptions?: Record<string, string> },
  ): Promise<ElkLayoutResult>;
};

let elkInstance: ELKInstance | null = null;

async function getElk(): Promise<ELKInstance> {
  if (!elkInstance) {
    const mod = await import('elkjs/lib/elk.bundled.js');
    const ELK = mod.default;
    elkInstance = new ELK() as unknown as ELKInstance;
  }
  return elkInstance;
}

export function useAutoLayout(
  nodes: Node[],
  edges: Edge[],
  options: Record<string, string>,
  persistedPositions?: Record<string, XYPosition>,
): UseAutoLayoutResult {
  const [layout, setLayout] = useState<ElkLayoutResult | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const computeIdRef = useRef(0);

  const doCompute = useCallback(async () => {
    if (nodes.length === 0) return;

    const computeId = ++computeIdRef.current;
    setIsComputing(true);

    try {
      const elk = await getElk();
      const graph = nodesToElkGraph(nodes, edges);
      const result = await elk.layout(graph as unknown as Record<string, unknown>, {
        layoutOptions: options,
      });

      if (computeId !== computeIdRef.current) return;

      startTransition(() => {
        setLayout(result);
        setIsComputing(false);
        setLayoutReady(true);
      });
    } catch (err) {
      if (computeId !== computeIdRef.current) return;
      console.error('ELK layout failed:', err instanceof Error ? err.message : String(err));
      setIsComputing(false);
    }
  }, [nodes, edges, options]);

  useEffect(() => {
    doCompute();
  }, [doCompute]);

  const layoutedNodes = useMemo(() => {
    if (!layout) return nodes;
    const positioned = applyElkPositions(nodes, layout);
    return mergeWithPersistedPositions(positioned, persistedPositions);
  }, [nodes, layout, persistedPositions]);

  return {
    layoutedNodes,
    layoutedEdges: edges,
    isComputing,
    layoutReady,
    recompute: () => {
      setLayoutReady(false);
      doCompute();
    },
  };
}
