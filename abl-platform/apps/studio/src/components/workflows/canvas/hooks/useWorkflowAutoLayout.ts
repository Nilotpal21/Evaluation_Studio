/**
 * useWorkflowAutoLayout
 *
 * One-shot auto-layout for the workflow canvas. Triggered by the user
 * (toolbar button or keyboard shortcut) — not a continuous recompute.
 *
 * Uses ELK.js 'layered' algorithm in RIGHT direction to produce a clean
 * left-to-right flow (Start → … → End). Matches the pattern used by
 * `usePipelineAutoLayout` so Studio has one auto-layout engine (ELK).
 */

import { useCallback, useRef, useState } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { getLoopStartPosition } from '../../../../store/workflow-canvas-store';

// =============================================================================
// Node dimensions (fallbacks when a node has no explicit width/height)
// =============================================================================

/** Start-node pill is narrow: icon + "Start" label. */
const START_NODE_WIDTH = 120;
const START_NODE_HEIGHT = 48;

/** End-node card (post-redesign): matches w-[200px] + content padding. */
const END_NODE_WIDTH = 220;
const END_NODE_HEIGHT = 72;

/** Workflow / Integration / Function / Agent card default. */
const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 80;
const LOOP_NODE_MIN_WIDTH = 400;
const LOOP_NODE_MIN_HEIGHT = 180;
const LOOP_NODE_RIGHT_HANDLE_AREA = 130;
const LOOP_BODY_PAD = 40;
const LOOP_TOP_PAD = 60;
const LOOP_START_WIDTH = 40;
const LOOP_START_HEIGHT = 40;

function getNodeSize(node: Node): { width: number; height: number } {
  // Prefer measured size if React Flow has observed the DOM node.
  const measuredWidth = (node.measured?.width as number | undefined) ?? undefined;
  const measuredHeight = (node.measured?.height as number | undefined) ?? undefined;
  if (measuredWidth && measuredHeight) return { width: measuredWidth, height: measuredHeight };

  const explicitWidth = getNumericNodeDimension(node, 'width');
  const explicitHeight = getNumericNodeDimension(node, 'height');
  if (explicitWidth && explicitHeight) return { width: explicitWidth, height: explicitHeight };

  if (node.type === 'startNode') return { width: START_NODE_WIDTH, height: START_NODE_HEIGHT };
  if (node.type === 'endNode') return { width: END_NODE_WIDTH, height: END_NODE_HEIGHT };
  if (node.type === 'loopStartNode') return { width: LOOP_START_WIDTH, height: LOOP_START_HEIGHT };
  return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
}

// =============================================================================
// ELK graph shapes
// =============================================================================

interface ElkNodeInput {
  id: string;
  width: number;
  height: number;
  ports?: Array<{
    id: string;
    properties?: Record<string, string>;
  }>;
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
  children?: ElkNodeOutput[];
}

type ELKInstance = {
  layout(
    graph: Record<string, unknown>,
    args?: { layoutOptions?: Record<string, string> },
  ): Promise<ElkLayoutResult>;
};

// =============================================================================
// ELK config — left-to-right, orthogonal routing, generous spacing
// =============================================================================

const WORKFLOW_LAYOUT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '140',
  'elk.spacing.nodeNode': '80',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  // Encourage stable branch ordering for multi-handle nodes (Condition/Human/etc.).
  // This reduces edge crossings caused by ELK choosing an arbitrary vertical order.
  'elk.portConstraints': 'FIXED_ORDER',
  'elk.edgeRouting': 'SPLINES',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '120',
};

// =============================================================================
// ELK singleton — the bundled build is ~500KB, load it once.
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
  const nodeIds = new Set(nodes.map((n) => n.id));

  const outputHandlesByNode = new Map<string, string[]>();
  const outgoingHandlesUsed = new Map<string, Set<string>>();

  for (const node of nodes) {
    const handles = Array.isArray((node.data as Record<string, unknown> | undefined)?.outputHandles)
      ? (((node.data as Record<string, unknown>).outputHandles as unknown[])?.filter(
          (h): h is string => typeof h === 'string' && h.length > 0,
        ) ?? [])
      : [];
    outputHandlesByNode.set(node.id, handles);
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source)) continue;
    const handle =
      typeof e.sourceHandle === 'string' && e.sourceHandle.length > 0
        ? e.sourceHandle
        : '__default';
    const set = outgoingHandlesUsed.get(e.source) ?? new Set<string>();
    set.add(handle);
    outgoingHandlesUsed.set(e.source, set);
  }

  const portIdForOut = (nodeId: string, handleId: string) => `${nodeId}::out::${handleId}`;
  const portIdForIn = (nodeId: string) => `${nodeId}::in`;

  return {
    id: 'root',
    children: nodes.map((node) => {
      const { width, height } = getNodeSize(node);

      const baseHandles = outputHandlesByNode.get(node.id) ?? [];
      const usedHandles = outgoingHandlesUsed.get(node.id) ?? new Set<string>();
      const handleOrder = [
        ...baseHandles,
        ...Array.from(usedHandles).filter((h) => !baseHandles.includes(h)),
      ];

      const ports: ElkNodeInput['ports'] = [
        { id: portIdForIn(node.id), properties: { 'elk.port.side': 'WEST' } },
        ...handleOrder.map((h) => ({
          id: portIdForOut(node.id, h),
          properties: { 'elk.port.side': 'EAST' },
        })),
      ];

      return { id: node.id, width, height, ports };
    }),
    // Drop dangling edges so ELK doesn't complain.
    edges: edges
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((edge) => ({
        id: edge.id,
        sources: [
          portIdForOut(
            edge.source,
            typeof edge.sourceHandle === 'string' && edge.sourceHandle.length > 0
              ? edge.sourceHandle
              : '__default',
          ),
        ],
        targets: [portIdForIn(edge.target)],
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
    return { ...node, position: { x: pos.x, y: pos.y } };
  });
}

function getNumericNodeDimension(node: Node, dimension: 'width' | 'height'): number | undefined {
  const direct = node[dimension];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  const styleValue = node.style?.[dimension];
  if (typeof styleValue === 'number' && Number.isFinite(styleValue)) return styleValue;
  if (typeof styleValue === 'string') {
    const parsed = Number.parseFloat(styleValue);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

function computeLoopContainerSize(children: Node[]): { width: number; height: number } {
  let maxRight = 0;
  let maxBottom = 0;

  for (const child of children) {
    const { width, height } = getNodeSize(child);
    maxRight = Math.max(maxRight, child.position.x + width);
    maxBottom = Math.max(maxBottom, child.position.y + height);
  }

  return {
    width: Math.max(LOOP_NODE_MIN_WIDTH, maxRight + LOOP_BODY_PAD + LOOP_NODE_RIGHT_HANDLE_AREA),
    height: Math.max(LOOP_NODE_MIN_HEIGHT, maxBottom + LOOP_BODY_PAD),
  };
}

function toParentLayoutEdges(nodes: Node[], edges: Edge[]): Edge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const topLevelIds = new Set(nodes.filter((node) => !node.parentId).map((node) => node.id));
  const edgeByPair = new Map<string, Edge>();

  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const source = sourceNode.parentId ?? sourceNode.id;
    const target = targetNode.parentId ?? targetNode.id;
    if (source === target || !topLevelIds.has(source) || !topLevelIds.has(target)) continue;

    const key = `${source}->${target}`;
    if (!edgeByPair.has(key)) {
      edgeByPair.set(key, { ...edge, id: key, source, target });
    }
  }

  return [...edgeByPair.values()];
}

async function layoutLoopChildren<TNode extends Node>(
  elk: ELKInstance,
  loopNode: TNode,
  nodes: TNode[],
  edges: Edge[],
): Promise<{ children: TNode[]; size: { width: number; height: number } }> {
  const children = nodes.filter((node) => node.parentId === loopNode.id);
  if (children.length === 0) {
    return { children, size: { width: LOOP_NODE_MIN_WIDTH, height: LOOP_NODE_MIN_HEIGHT } };
  }

  const loopStartNode = children.find((child) => child.type === 'loopStartNode');
  const bodyChildren = children.filter((child) => child.type !== 'loopStartNode');
  if (bodyChildren.length === 0) {
    const size = { width: LOOP_NODE_MIN_WIDTH, height: LOOP_NODE_MIN_HEIGHT };
    return {
      children: loopStartNode
        ? ([{ ...loopStartNode, position: getLoopStartPosition(size.height) }] as TNode[])
        : [],
      size,
    };
  }

  const childIds = new Set(bodyChildren.map((node) => node.id));
  const childEdges = edges.filter((edge) => childIds.has(edge.source) && childIds.has(edge.target));
  const graph = nodesToElkGraph(bodyChildren, childEdges);
  const layout = await elk.layout(graph as unknown as Record<string, unknown>, {
    layoutOptions: WORKFLOW_LAYOUT_OPTIONS,
  });

  const layoutById = new Map((layout.children ?? []).map((child) => [child.id, child]));
  let minX = Infinity;
  let minY = Infinity;
  for (const child of bodyChildren) {
    const layoutNode = layoutById.get(child.id);
    const x = layoutNode?.x ?? child.position.x;
    const y = layoutNode?.y ?? child.position.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  }

  const offsetX = LOOP_BODY_PAD - (Number.isFinite(minX) ? minX : LOOP_BODY_PAD);
  const offsetY = LOOP_TOP_PAD - (Number.isFinite(minY) ? minY : LOOP_TOP_PAD);
  const positionedChildren = bodyChildren.map((child) => {
    const layoutNode = layoutById.get(child.id);
    if (!layoutNode) return child;
    return {
      ...child,
      position: {
        x: layoutNode.x + offsetX,
        y: layoutNode.y + offsetY,
      },
    };
  }) as TNode[];

  const size = computeLoopContainerSize(positionedChildren);
  const anchoredLoopStart = loopStartNode
    ? ({ ...loopStartNode, position: getLoopStartPosition(size.height) } as TNode)
    : null;

  return {
    children: anchoredLoopStart ? [...positionedChildren, anchoredLoopStart] : positionedChildren,
    size,
  };
}

// =============================================================================
// Hook
// =============================================================================

export interface UseWorkflowAutoLayoutResult {
  /**
   * Run auto-layout and return repositioned nodes. Preserves the caller's node
   * shape (generic `TNode extends Node`). Original input is returned on failure.
   */
  autoLayout: <TNode extends Node>(nodes: TNode[], edges: Edge[]) => Promise<TNode[]>;
  isComputing: boolean;
}

export function useWorkflowAutoLayout(): UseWorkflowAutoLayoutResult {
  const [isComputing, setIsComputing] = useState(false);
  const computeIdRef = useRef(0);

  const autoLayout = useCallback(
    async <TNode extends Node>(nodes: TNode[], edges: Edge[]): Promise<TNode[]> => {
      if (nodes.length === 0) return nodes;

      const computeId = ++computeIdRef.current;
      setIsComputing(true);

      try {
        const elk = await getElk();
        const loopChildPositions = new Map<string, TNode>();
        const loopSizes = new Map<string, { width: number; height: number }>();

        for (const loopNode of nodes.filter((node) => node.type === 'loopNode')) {
          const { children, size } = await layoutLoopChildren(elk, loopNode, nodes, edges);
          loopSizes.set(loopNode.id, size);
          for (const child of children) {
            loopChildPositions.set(child.id, child);
          }
        }

        const topLevelNodes = nodes
          .filter((node) => !node.parentId)
          .map((node) => {
            const loopSize = loopSizes.get(node.id);
            if (!loopSize) return node;
            return {
              ...node,
              width: loopSize.width,
              height: loopSize.height,
              style: { ...node.style, width: loopSize.width, height: loopSize.height },
            };
          }) as TNode[];
        const graph = nodesToElkGraph(topLevelNodes, toParentLayoutEdges(nodes, edges));
        const result = await elk.layout(graph as unknown as Record<string, unknown>, {
          layoutOptions: WORKFLOW_LAYOUT_OPTIONS,
        });

        // Stale check — another request came in while we were computing.
        if (computeId !== computeIdRef.current) return nodes;

        const positionedTopLevel = applyElkPositions(topLevelNodes, result) as TNode[];
        const positionedTopLevelById = new Map(positionedTopLevel.map((node) => [node.id, node]));
        const positioned = nodes.map((node) => {
          const loopChild = loopChildPositions.get(node.id);
          if (loopChild) return loopChild;

          const topLevel = positionedTopLevelById.get(node.id);
          if (topLevel) return topLevel;

          return node;
        }) as TNode[];
        setIsComputing(false);
        return positioned;
      } catch {
        if (computeId === computeIdRef.current) setIsComputing(false);
        return nodes;
      }
    },
    [],
  );

  return { autoLayout, isComputing };
}
