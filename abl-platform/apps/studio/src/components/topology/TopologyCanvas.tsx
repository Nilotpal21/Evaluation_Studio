/**
 * TopologyCanvas Component
 *
 * SVG-based hierarchical graph visualization showing agent topology.
 * Renders supervisor at the top, agents below, with connecting edges.
 * Supports click-to-select, hover effects, and animated node entrance.
 */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { springs } from '../../lib/animation';
import type { TopologyData, TopologyNode, TopologyEdge } from '../../types/arch';

interface TopologyCanvasProps {
  topology: TopologyData;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  className?: string;
  /** Compact mode for smaller displays */
  compact?: boolean;
}

// =============================================================================
// LAYOUT CONSTANTS
// =============================================================================

const NODE_WIDTH = 140;
const NODE_HEIGHT = 48;
const NODE_WIDTH_COMPACT = 110;
const NODE_HEIGHT_COMPACT = 36;
const LEVEL_GAP = 80;
const NODE_GAP = 24;
const PADDING = 40;

interface EdgeExperienceStyle {
  label: string;
  stroke: string;
  textFill: string;
  backgroundFill: string;
  strokeDasharray?: string;
}

function getEdgeExperienceStyle(edge: TopologyEdge): EdgeExperienceStyle | null {
  switch (edge.experienceMode) {
    case 'shared_voice_handoff':
      return {
        label: 'Shared voice',
        stroke: 'hsl(var(--success))',
        textFill: 'hsl(var(--success))',
        backgroundFill: 'hsl(var(--success) / 0.12)',
      };
    case 'visible_handoff':
      return {
        label: 'Visible handoff',
        stroke: 'hsl(var(--accent))',
        textFill: 'hsl(var(--accent))',
        backgroundFill: 'hsl(var(--accent-subtle))',
        strokeDasharray: '5 3',
      };
    case 'silent_delegate':
      return {
        label: 'Silent delegate',
        stroke: 'hsl(var(--foreground-muted))',
        textFill: 'hsl(var(--foreground-muted))',
        backgroundFill: 'hsl(var(--background-muted))',
        strokeDasharray: '2 4',
      };
    case 'human_escalation':
      return {
        label: 'Human escalation',
        stroke: 'hsl(var(--warning))',
        textFill: 'hsl(var(--warning))',
        backgroundFill: 'hsl(var(--warning) / 0.12)',
        strokeDasharray: '6 3',
      };
    default:
      if (edge.type === 'delegate') {
        return {
          label: 'Delegate',
          stroke: 'hsl(var(--foreground-muted))',
          textFill: 'hsl(var(--foreground-muted))',
          backgroundFill: 'hsl(var(--background-muted))',
          strokeDasharray: '2 4',
        };
      }
      return null;
  }
}

// =============================================================================
// LAYOUT ALGORITHM — Simple hierarchical BFS
// =============================================================================

interface LayoutNode {
  node: TopologyNode;
  x: number;
  y: number;
  level: number;
}

function layoutTopology(
  topology: TopologyData,
  compact: boolean,
): { nodes: LayoutNode[]; width: number; height: number } {
  const nw = compact ? NODE_WIDTH_COMPACT : NODE_WIDTH;
  const nh = compact ? NODE_HEIGHT_COMPACT : NODE_HEIGHT;
  const gap = compact ? NODE_GAP * 0.7 : NODE_GAP;

  if (topology.nodes.length === 0) {
    return { nodes: [], width: 200, height: 100 };
  }

  // Find entry node (supervisor)
  const entryNode = topology.nodes.find((n) => n.isEntry) ?? topology.nodes[0];

  // Build adjacency for layout
  const children = new Map<string, string[]>();
  for (const edge of topology.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }

  // BFS to assign levels
  const visited = new Set<string>();
  const levelMap = new Map<string, number>();
  const queue: { id: string; level: number }[] = [{ id: entryNode.id, level: 0 }];
  visited.add(entryNode.id);
  levelMap.set(entryNode.id, 0);

  while (queue.length > 0) {
    const { id, level } = queue.shift()!;
    const kids = children.get(id) ?? [];
    for (const kid of kids) {
      if (!visited.has(kid)) {
        visited.add(kid);
        levelMap.set(kid, level + 1);
        queue.push({ id: kid, level: level + 1 });
      }
    }
  }

  // Add any unvisited nodes at level 1
  for (const node of topology.nodes) {
    if (!levelMap.has(node.id)) {
      levelMap.set(node.id, 1);
    }
  }

  // Group by level
  const levels = new Map<number, TopologyNode[]>();
  for (const node of topology.nodes) {
    const lvl = levelMap.get(node.id) ?? 1;
    if (!levels.has(lvl)) levels.set(lvl, []);
    levels.get(lvl)!.push(node);
  }

  // Position nodes
  const maxLevel = Math.max(...Array.from(levels.keys()));
  const layoutNodes: LayoutNode[] = [];
  let maxWidth = 0;

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const nodesAtLevel = levels.get(lvl) ?? [];
    const totalWidth = nodesAtLevel.length * nw + (nodesAtLevel.length - 1) * gap;
    maxWidth = Math.max(maxWidth, totalWidth);
  }

  const canvasWidth = maxWidth + PADDING * 2;

  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const nodesAtLevel = levels.get(lvl) ?? [];
    const totalWidth = nodesAtLevel.length * nw + (nodesAtLevel.length - 1) * gap;
    const startX = (canvasWidth - totalWidth) / 2;
    const y = PADDING + lvl * (nh + LEVEL_GAP);

    for (let i = 0; i < nodesAtLevel.length; i++) {
      layoutNodes.push({
        node: nodesAtLevel[i],
        x: startX + i * (nw + gap),
        y,
        level: lvl,
      });
    }
  }

  const canvasHeight = PADDING * 2 + (maxLevel + 1) * nh + maxLevel * LEVEL_GAP;

  return { nodes: layoutNodes, width: canvasWidth, height: canvasHeight };
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TopologyCanvas({
  topology,
  selectedNodeId,
  onSelectNode,
  className,
  compact,
}: TopologyCanvasProps) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const nw = compact ? NODE_WIDTH_COMPACT : NODE_WIDTH;
  const nh = compact ? NODE_HEIGHT_COMPACT : NODE_HEIGHT;

  const layout = useMemo(() => layoutTopology(topology, !!compact), [topology, compact]);

  if (topology.nodes.length === 0) {
    return (
      <div
        className={clsx('flex items-center justify-center h-full text-sm text-subtle', className)}
      >
        No agents yet
      </div>
    );
  }

  // Build position lookup
  const posMap = new Map<string, { x: number; y: number }>();
  for (const ln of layout.nodes) {
    posMap.set(ln.node.id, { x: ln.x + nw / 2, y: ln.y + nh / 2 });
  }

  return (
    <div className={clsx('overflow-auto gradient-glow-ambient', className)}>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block mx-auto"
      >
        {/* Edges */}
        {topology.edges.map((edge, i) => {
          const from = posMap.get(edge.from);
          const to = posMap.get(edge.to);
          if (!from || !to) return null;

          const experienceStyle = getEdgeExperienceStyle(edge);
          const isEscalation = edge.type === 'escalation';
          const isActive =
            hoveredNodeId === edge.from ||
            hoveredNodeId === edge.to ||
            selectedNodeId === edge.from ||
            selectedNodeId === edge.to;
          const stroke = isActive
            ? 'hsl(var(--accent))'
            : (experienceStyle?.stroke ?? 'hsl(var(--border))');
          const labelX = (from.x + to.x) / 2;
          const labelY = (from.y + nh / 2 + to.y - nh / 2) / 2;
          const labelWidth = experienceStyle ? Math.max(82, experienceStyle.label.length * 6.5) : 0;

          return (
            <motion.g
              key={`edge-${i}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 + i * 0.1, duration: 0.4 }}
            >
              <line
                x1={from.x}
                y1={from.y + nh / 2}
                x2={to.x}
                y2={to.y - nh / 2}
                stroke={stroke}
                strokeWidth={isActive ? 2 : 1.5}
                strokeDasharray={
                  experienceStyle?.strokeDasharray ?? (isEscalation ? '6 3' : undefined)
                }
                opacity={isActive ? 1 : 0.72}
              />
              {experienceStyle && !compact && (
                <g data-testid={`topology-edge-experience-${edge.from}-${edge.to}`}>
                  <rect
                    x={labelX - labelWidth / 2}
                    y={labelY - 10}
                    width={labelWidth}
                    height={20}
                    rx={6}
                    fill={experienceStyle.backgroundFill}
                    stroke={experienceStyle.stroke}
                    strokeWidth={0.8}
                  />
                  <text
                    x={labelX}
                    y={labelY + 3}
                    fontSize="9"
                    fontWeight="600"
                    fill={experienceStyle.textFill}
                    textAnchor="middle"
                    fontFamily="var(--font-sans)"
                  >
                    {experienceStyle.label}
                  </text>
                </g>
              )}
            </motion.g>
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((ln, i) => {
          const isSelected = selectedNodeId === ln.node.id;
          const isHovered = hoveredNodeId === ln.node.id;
          const isSupervisor = ln.node.type === 'supervisor';

          return (
            <motion.g
              key={ln.node.id}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.15, ...springs.soft }}
              style={{ cursor: onSelectNode ? 'pointer' : 'default' }}
              onClick={() => onSelectNode?.(isSelected ? null : ln.node.id)}
              onMouseEnter={() => setHoveredNodeId(ln.node.id)}
              onMouseLeave={() => setHoveredNodeId(null)}
            >
              {/* Node background */}
              <rect
                x={ln.x}
                y={ln.y}
                width={nw}
                height={nh}
                rx={compact ? 8 : 10}
                fill={
                  isSelected
                    ? 'hsl(var(--accent-subtle))'
                    : isHovered
                      ? 'hsl(var(--background-muted))'
                      : isSupervisor
                        ? 'hsl(var(--accent-subtle))'
                        : 'hsl(var(--background-elevated))'
                }
                stroke={
                  isSelected
                    ? 'hsl(var(--accent))'
                    : isHovered
                      ? 'hsl(var(--accent) / 0.4)'
                      : 'hsl(var(--border))'
                }
                strokeWidth={isSelected ? 2 : 1}
              />

              {/* Entry marker */}
              {ln.node.isEntry && (
                <text
                  x={ln.x + nw - 8}
                  y={ln.y + 10}
                  fontSize="8"
                  fill="hsl(var(--accent))"
                  textAnchor="end"
                  fontFamily="var(--font-mono)"
                >
                  entry
                </text>
              )}

              {/* Agent name */}
              <text
                x={ln.x + nw / 2}
                y={ln.y + nh / 2 - (compact ? 1 : 3)}
                fontSize={compact ? 10 : 11}
                fontWeight="600"
                fill={isSupervisor ? 'hsl(var(--accent))' : 'hsl(var(--foreground))'}
                textAnchor="middle"
                fontFamily="var(--font-sans)"
              >
                {truncateName(ln.node.name, compact ? 12 : 16)}
              </text>

              {/* Type label */}
              <text
                x={ln.x + nw / 2}
                y={ln.y + nh / 2 + (compact ? 10 : 13)}
                fontSize={compact ? 8 : 9}
                fill="hsl(var(--foreground-muted))"
                textAnchor="middle"
                fontFamily="var(--font-mono)"
              >
                {ln.node.executionMode}
              </text>

              {/* Health dot */}
              <circle
                cx={ln.x + 10}
                cy={ln.y + nh / 2}
                r={3}
                fill={
                  ln.node.healthStatus === 'healthy'
                    ? 'hsl(var(--success))'
                    : ln.node.healthStatus === 'warning'
                      ? 'hsl(var(--warning))'
                      : 'hsl(var(--error))'
                }
              />
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '\u2026';
}
