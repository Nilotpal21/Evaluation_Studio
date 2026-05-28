/**
 * AgentMiniTopology Component
 *
 * Compact SVG mini-map showing agent relationships as pill-shaped nodes
 * connected by bezier edges. Horizontal BFS layout: entry agent at the
 * left, children fanning out to the right. Purpose-built for the agents
 * page — NOT reusing the full TopologyCanvas (which has zoom/pan/drag).
 */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../../lib/animation';

// =============================================================================
// TYPES
// =============================================================================

export interface MiniTopologyData {
  nodes: Array<{
    id: string;
    name: string;
    type: 'supervisor' | 'agent';
    isEntry: boolean;
    executionMode: 'reasoning' | 'scripted' | 'hybrid';
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: 'handoff' | 'delegate';
    label?: string;
    condition?: string;
    returns?: boolean;
    experienceMode?:
      | 'shared_voice_handoff'
      | 'visible_handoff'
      | 'silent_delegate'
      | 'human_escalation';
  }>;
}

interface AgentMiniTopologyProps {
  topology: MiniTopologyData;
  onSelectAgent?: (agentName: string) => void;
  className?: string;
}

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

const NW = 100; // Node width
const NH = 32; // Node height
const LEVEL_GAP = 60; // Horizontal gap between columns
const NODE_GAP = 12; // Vertical gap between nodes in same column
const PADDING = 24; // Canvas padding
const MAX_VISIBLE_NODES = 8;
const MAX_NAME_LENGTH = 12;
const ENTRY_DOT_RADIUS = 3;
const ENTRY_DOT_CX = 10;

// Animation timing
const NODE_STAGGER_MS = 100; // Stagger per node (seconds = /1000)
const EDGE_STAGGER_MS = 80; // Stagger per edge
const EDGE_DELAY_MS = 300; // Initial delay before edges draw
const OVERFLOW_DELAY_MS = 800;

// =============================================================================
// LAYOUT ALGORITHM - Horizontal BFS
// =============================================================================

interface LayoutNode {
  id: string;
  name: string;
  type: 'supervisor' | 'agent';
  isEntry: boolean;
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  x: number;
  y: number;
  column: number;
}

interface LayoutResult {
  nodes: LayoutNode[];
  edges: Array<{
    from: string;
    to: string;
    type: 'handoff' | 'delegate';
    label?: string;
  }>;
  width: number;
  height: number;
  overflowCount: number;
}

function computeLayout(topology: MiniTopologyData): LayoutResult {
  if (topology.nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, overflowCount: 0 };
  }

  // Find entry node
  const entryNode = topology.nodes.find((n) => n.isEntry) ?? topology.nodes[0];

  // Build adjacency (from -> [to])
  const children = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }

  // BFS to assign columns (levels)
  const visited = new Set<string>();
  const columnMap = new Map<string, number>();
  const queue: Array<{ id: string; column: number }> = [{ id: entryNode.id, column: 0 }];
  visited.add(entryNode.id);
  columnMap.set(entryNode.id, 0);

  while (queue.length > 0) {
    const { id, column } = queue.shift()!;
    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      if (!visited.has(kid)) {
        visited.add(kid);
        columnMap.set(kid, column + 1);
        queue.push({ id: kid, column: column + 1 });
      }
    }
  }

  // Add unvisited nodes at column 1
  for (const node of topology.nodes) {
    if (!columnMap.has(node.id)) {
      columnMap.set(node.id, 1);
    }
  }

  // Group by column
  const columns = new Map<number, typeof topology.nodes>();
  for (const node of topology.nodes) {
    const col = columnMap.get(node.id) ?? 1;
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col)!.push(node);
  }

  // Determine visible nodes — cap at MAX_VISIBLE_NODES
  const allNodes = topology.nodes;
  const totalNodes = allNodes.length;
  const overflowCount = Math.max(0, totalNodes - MAX_VISIBLE_NODES);

  // Collect visible node IDs (BFS order, capped)
  const bfsOrder: string[] = [];
  const bfsVisited = new Set<string>();
  const bfsQueue: string[] = [entryNode.id];
  bfsVisited.add(entryNode.id);

  while (bfsQueue.length > 0 && bfsOrder.length < MAX_VISIBLE_NODES) {
    const id = bfsQueue.shift()!;
    bfsOrder.push(id);
    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      if (!bfsVisited.has(kid)) {
        bfsVisited.add(kid);
        bfsQueue.push(kid);
      }
    }
  }

  // Add remaining unvisited nodes up to the cap
  for (const node of allNodes) {
    if (bfsOrder.length >= MAX_VISIBLE_NODES) break;
    if (!bfsOrder.includes(node.id)) {
      bfsOrder.push(node.id);
    }
  }

  const visibleIds = new Set(bfsOrder);

  // Rebuild columns for visible nodes only
  const visibleColumns = new Map<number, typeof topology.nodes>();
  for (const node of allNodes) {
    if (!visibleIds.has(node.id)) continue;
    const col = columnMap.get(node.id) ?? 1;
    if (!visibleColumns.has(col)) visibleColumns.set(col, []);
    visibleColumns.get(col)!.push(node);
  }

  // Position nodes — horizontal BFS
  const maxColumn = Math.max(0, ...Array.from(visibleColumns.keys()));
  const layoutNodes: LayoutNode[] = [];

  // Find max column height for centering
  let maxColumnHeight = 0;
  for (let col = 0; col <= maxColumn; col++) {
    const nodesInCol = visibleColumns.get(col) ?? [];
    const colHeight = nodesInCol.length * NH + (nodesInCol.length - 1) * NODE_GAP;
    maxColumnHeight = Math.max(maxColumnHeight, colHeight);
  }

  for (let col = 0; col <= maxColumn; col++) {
    const nodesInCol = visibleColumns.get(col) ?? [];
    const colHeight = nodesInCol.length * NH + (nodesInCol.length - 1) * NODE_GAP;
    const x = PADDING + col * (NW + LEVEL_GAP);
    const startY = PADDING + (maxColumnHeight - colHeight) / 2;

    for (let i = 0; i < nodesInCol.length; i++) {
      const node = nodesInCol[i];
      layoutNodes.push({
        ...node,
        x,
        y: startY + i * (NH + NODE_GAP),
        column: col,
      });
    }
  }

  // Filter edges to visible nodes only
  const visibleEdges = topology.edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  // Account for overflow pill in width
  const overflowExtra = overflowCount > 0 ? NW + LEVEL_GAP : 0;
  const canvasWidth = PADDING * 2 + (maxColumn + 1) * NW + maxColumn * LEVEL_GAP + overflowExtra;
  const canvasHeight = PADDING * 2 + maxColumnHeight;

  return {
    nodes: layoutNodes,
    edges: visibleEdges,
    width: Math.max(canvasWidth, NW + PADDING * 2),
    height: Math.max(canvasHeight, NH + PADDING * 2),
    overflowCount,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function truncateName(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) return name;
  return name.slice(0, MAX_NAME_LENGTH - 1) + '\u2026';
}

function buildBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

function getEdgeStrokeDash(type: 'handoff' | 'delegate'): string | undefined {
  if (type === 'delegate') return '6 3';
  return undefined;
}

function getEdgeColor(type: 'handoff' | 'delegate'): string {
  if (type === 'delegate') return 'hsl(var(--purple))';
  return 'hsl(var(--accent))';
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentMiniTopology({ topology, onSelectAgent, className }: AgentMiniTopologyProps) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const layout = useMemo(() => computeLayout(topology), [topology]);

  // Build position lookup for edge endpoints
  const posMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const node of layout.nodes) {
      map.set(node.id, { x: node.x, y: node.y });
    }
    return map;
  }, [layout.nodes]);

  // Hide condition: return null if 1 or fewer nodes with 0 edges
  if (layout.nodes.length <= 1 && topology.edges.length === 0) {
    return null;
  }

  return (
    <div
      className={clsx('rounded-xl border-0 bg-gradient-surface-sidebar overflow-auto', className)}
      style={{
        backgroundImage: 'radial-gradient(circle, hsl(var(--border) / 0.4) 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block mx-auto"
      >
        {/* Edges — rendered beneath nodes */}
        {layout.edges.map((edge, i) => {
          const fromPos = posMap.get(edge.from);
          const toPos = posMap.get(edge.to);
          if (!fromPos || !toPos) return null;

          // Connect from right edge of source to left edge of target
          const x1 = fromPos.x + NW;
          const y1 = fromPos.y + NH / 2;
          const x2 = toPos.x;
          const y2 = toPos.y + NH / 2;

          const isActive =
            hoveredNodeId !== null && (edge.from === hoveredNodeId || edge.to === hoveredNodeId);
          const isDimmed = hoveredNodeId !== null && !isActive;

          const path = buildBezierPath(x1, y1, x2, y2);
          const strokeColor = getEdgeColor(edge.type);
          const dashArray = getEdgeStrokeDash(edge.type);

          return (
            <motion.path
              key={`edge-${edge.from}-${edge.to}-${i}`}
              d={path}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isActive ? 2 : 1.5}
              strokeDasharray={dashArray}
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{
                pathLength: 1,
                opacity: isDimmed ? 0.25 : isActive ? 1 : 0.6,
              }}
              transition={{
                pathLength: {
                  delay: (EDGE_DELAY_MS + i * EDGE_STAGGER_MS) / 1000,
                  duration: 0.4,
                },
                opacity: {
                  delay: (EDGE_DELAY_MS + i * EDGE_STAGGER_MS) / 1000,
                  duration: 0.2,
                },
              }}
            />
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((node, i) => {
          const isSupervisor = node.type === 'supervisor';
          const isHovered = hoveredNodeId === node.id;

          // Node fill
          const fill = isHovered
            ? 'hsl(var(--background-muted))'
            : isSupervisor
              ? 'hsl(var(--accent-subtle))'
              : 'hsl(var(--background-elevated))';

          // Node stroke
          const stroke = isHovered
            ? 'hsl(var(--accent) / 0.5)'
            : isSupervisor
              ? 'hsl(var(--accent) / 0.5)'
              : 'hsl(var(--border))';

          // Text fill
          const textFill = isSupervisor ? 'hsl(var(--accent))' : 'hsl(var(--foreground))';

          const textWeight = isSupervisor ? 600 : 400;

          return (
            <motion.g
              key={node.id}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                delay: (i * NODE_STAGGER_MS) / 1000,
                ...springs.soft,
              }}
              style={{ cursor: onSelectAgent ? 'pointer' : 'default' }}
              onClick={() => onSelectAgent?.(node.name)}
              onMouseEnter={() => setHoveredNodeId(node.id)}
              onMouseLeave={() => setHoveredNodeId(null)}
            >
              {/* Accent ring for supervisor nodes */}
              {isSupervisor && (
                <rect
                  x={node.x - 3}
                  y={node.y - 3}
                  width={NW + 6}
                  height={NH + 6}
                  rx={(NH + 6) / 2}
                  fill="none"
                  stroke="hsl(var(--accent) / 0.3)"
                  strokeWidth={1.5}
                />
              )}

              {/* Pill-shaped node */}
              <rect
                x={node.x}
                y={node.y}
                width={NW}
                height={NH}
                rx={NH / 2}
                fill={fill}
                stroke={stroke}
                strokeWidth={isSupervisor ? 1.5 : isHovered ? 1.5 : 1}
              />

              {/* Entry indicator dot */}
              {node.isEntry && (
                <circle
                  cx={node.x + ENTRY_DOT_CX}
                  cy={node.y + NH / 2}
                  r={ENTRY_DOT_RADIUS}
                  fill="hsl(var(--accent))"
                />
              )}

              {/* Agent name */}
              <text
                x={node.x + NW / 2}
                y={node.y + NH / 2}
                dy="0.35em"
                fontSize={11}
                fontWeight={textWeight}
                fill={textFill}
                textAnchor="middle"
                fontFamily="var(--font-sans)"
              >
                {truncateName(node.name)}
              </text>
            </motion.g>
          );
        })}

        {/* Overflow pill */}
        {layout.overflowCount > 0 && (
          <motion.g
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: OVERFLOW_DELAY_MS / 1000, duration: 0.3 }}
          >
            <rect
              x={layout.width - PADDING - NW}
              y={(layout.height - NH) / 2}
              width={NW}
              height={NH}
              rx={NH / 2}
              fill="hsl(var(--background-muted))"
              stroke="hsl(var(--border))"
              strokeWidth={1}
            />
            <text
              x={layout.width - PADDING - NW / 2}
              y={layout.height / 2}
              dy="0.35em"
              fontSize={11}
              fontWeight={500}
              fill="hsl(var(--foreground-muted))"
              textAnchor="middle"
              fontFamily="var(--font-sans)"
            >
              +{layout.overflowCount}
            </text>
          </motion.g>
        )}
      </svg>
    </div>
  );
}
