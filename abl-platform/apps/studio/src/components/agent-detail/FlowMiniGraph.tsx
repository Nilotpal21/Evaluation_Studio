'use client';

/**
 * FlowMiniGraph -- lightweight SVG-based flow graph for scripted agents.
 *
 * Renders step nodes (rectangles) connected by edges (lines with arrows)
 * in a simple left-to-right layout. Supports compact mode for collapsed
 * summaries and full mode for expanded views.
 *
 * This is READ-ONLY -- no drag/drop, no editing. Click on a node to
 * trigger the onStepClick callback for future scroll-to-step wiring.
 */

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import type { FlowSectionData, FlowStepData } from '@/store/agent-detail-store';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Layout constants for full mode */
const FULL_NODE_WIDTH = 180; // Increased from 140 to fit longer names
const FULL_NODE_HEIGHT = 40; // Increased from 36 for better vertical spacing
const FULL_NODE_GAP = 50; // Increased from 40 for better horizontal spacing
const FULL_NODE_PADDING_X = 20;
const FULL_NODE_PADDING_Y = 20; // Increased from 16
const FULL_NODE_RADIUS = 6;

/** Layout constants for compact mode */
const COMPACT_NODE_WIDTH = 120; // Increased from 90
const COMPACT_NODE_HEIGHT = 28; // Increased from 24
const COMPACT_NODE_GAP = 30; // Increased from 24
const COMPACT_NODE_PADDING_X = 12;
const COMPACT_NODE_PADDING_Y = 10; // Increased from 8
const COMPACT_NODE_RADIUS = 4;

/** Arrow marker size */
const ARROW_SIZE = 6;

// =============================================================================
// TYPES
// =============================================================================

interface NodeLayout {
  step: FlowStepData;
  x: number;
  y: number;
  width: number;
  height: number;
  isEntry: boolean;
}

interface EdgeLayout {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

// =============================================================================
// TEXT UTILITIES
// =============================================================================

/**
 * Truncate text to fit within a given width (approximate char-based).
 * Adds ellipsis if truncated.
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

/**
 * Get max characters that fit in a node based on width and font size.
 * Rough approximation: monospace font is ~0.6em per character.
 */
function getMaxChars(nodeWidth: number, fontSize: number, padding = 16): number {
  const availableWidth = nodeWidth - padding;
  const charWidth = fontSize * 0.6; // Approximate monospace width
  return Math.floor(availableWidth / charWidth);
}

// =============================================================================
// LAYOUT COMPUTATION
// =============================================================================

/**
 * Compute a simple left-to-right layout for the flow graph.
 * Start with the entry point and follow `then` transitions.
 * Any steps not reachable via `then` are appended at the end.
 */
function computeLayout(
  data: FlowSectionData,
  compact: boolean,
): { nodes: NodeLayout[]; edges: EdgeLayout[]; width: number; height: number } {
  const nodeWidth = compact ? COMPACT_NODE_WIDTH : FULL_NODE_WIDTH;
  const nodeHeight = compact ? COMPACT_NODE_HEIGHT : FULL_NODE_HEIGHT;
  const gap = compact ? COMPACT_NODE_GAP : FULL_NODE_GAP;
  const paddingX = compact ? COMPACT_NODE_PADDING_X : FULL_NODE_PADDING_X;
  const paddingY = compact ? COMPACT_NODE_PADDING_Y : FULL_NODE_PADDING_Y;

  if (data.steps.length === 0) {
    return { nodes: [], edges: [], width: paddingX * 2, height: paddingY * 2 };
  }

  // Build ordered step list starting from entry point, following `then` chains
  const stepsByName = new Map<string, FlowStepData>();
  for (const step of data.steps) {
    stepsByName.set(step.name, step);
  }

  const ordered: FlowStepData[] = [];
  const visited = new Set<string>();

  // Follow the entry point chain
  let current = data.entryPoint;
  while (current && stepsByName.has(current) && !visited.has(current)) {
    const step = stepsByName.get(current)!;
    ordered.push(step);
    visited.add(current);
    current = step.then ?? '';
  }

  // Append any unreachable steps
  for (const step of data.steps) {
    if (!visited.has(step.name)) {
      ordered.push(step);
      visited.add(step.name);
    }
  }

  // Compute node positions
  const nodes: NodeLayout[] = ordered.map((step, index) => ({
    step,
    x: paddingX + index * (nodeWidth + gap),
    y: paddingY,
    width: nodeWidth,
    height: nodeHeight,
    isEntry: step.name === data.entryPoint,
  }));

  // Build name-to-node lookup for edge computation
  const nodeByName = new Map<string, NodeLayout>();
  for (const node of nodes) {
    nodeByName.set(node.step.name, node);
  }

  // Compute edges based on `then` transitions
  const edges: EdgeLayout[] = [];
  for (const node of nodes) {
    if (node.step.then && nodeByName.has(node.step.then)) {
      const target = nodeByName.get(node.step.then)!;
      edges.push({
        fromX: node.x + node.width,
        fromY: node.y + node.height / 2,
        toX: target.x,
        toY: target.y + target.height / 2,
      });
    }
  }

  // Compute total SVG dimensions
  const lastNode = nodes[nodes.length - 1];
  const totalWidth = lastNode.x + lastNode.width + paddingX;
  const totalHeight = nodeHeight + paddingY * 2;

  return { nodes, edges, width: totalWidth, height: totalHeight };
}

// =============================================================================
// COLORS (using CSS custom property values for inline SVG)
// =============================================================================

const COLORS = {
  nodeFill: 'hsl(var(--background-elevated))', // Changed from background-muted for better contrast
  nodeStroke: 'hsl(var(--border))',
  nodeText: 'hsl(var(--foreground))',
  entryStroke: 'hsl(var(--accent))',
  edgeStroke: 'hsl(var(--foreground-subtle))', // More visible edge lines
  arrowFill: 'hsl(var(--foreground-muted))',
  gatherDot: 'hsl(var(--info))',
  branchDot: 'hsl(var(--warning))',
} as const;

// =============================================================================
// PROPS
// =============================================================================

export interface FlowMiniGraphProps {
  data: FlowSectionData;
  /** Compact mode for collapsed view (smaller nodes, less padding) */
  compact: boolean;
  /** Callback when a step node is clicked */
  onStepClick?: (stepName: string) => void;
  /** Additional className for the wrapper */
  className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function FlowMiniGraph({ data, compact, onStepClick, className }: FlowMiniGraphProps) {
  const t = useTranslations('agents.flow_mini_graph');
  const { nodes, edges, width, height } = useMemo(
    () => computeLayout(data, compact),
    [data, compact],
  );

  const nodeRadius = compact ? COMPACT_NODE_RADIUS : FULL_NODE_RADIUS;
  const fontSize = compact ? 10 : 13; // Slightly larger for readability
  const indicatorSize = compact ? 4 : 6;
  const nodeWidth = compact ? COMPACT_NODE_WIDTH : FULL_NODE_WIDTH;

  // Calculate max characters that fit in a node
  const maxChars = getMaxChars(nodeWidth, fontSize, 16);

  return (
    <div className={clsx('overflow-x-auto overflow-y-hidden pb-2 px-1', className)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block min-w-full"
        role="img"
        aria-label={t('flow_graph_label')}
        style={{ minWidth: width }}
      >
        {/* Arrow marker definition */}
        <defs>
          <marker
            id="arrowhead"
            markerWidth={ARROW_SIZE}
            markerHeight={ARROW_SIZE}
            refX={ARROW_SIZE}
            refY={ARROW_SIZE / 2}
            orient="auto"
          >
            <polygon
              points={`0 0, ${ARROW_SIZE} ${ARROW_SIZE / 2}, 0 ${ARROW_SIZE}`}
              fill={COLORS.arrowFill}
            />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, i) => (
          <line
            key={`edge-${i}`}
            x1={edge.fromX}
            y1={edge.fromY}
            x2={edge.toX}
            y2={edge.toY}
            stroke={COLORS.edgeStroke}
            strokeWidth={1.5}
            markerEnd="url(#arrowhead)"
          />
        ))}

        {/* Nodes */}
        {nodes.map((node) => {
          const displayName = truncateText(node.step.name, maxChars);
          const isTruncated = displayName !== node.step.name;

          return (
            <g
              key={node.step.name}
              className={clsx('cursor-pointer', onStepClick && 'hover:opacity-80')}
              onClick={() => onStepClick?.(node.step.name)}
            >
              {/* Tooltip title for full name */}
              {isTruncated && <title>{node.step.name}</title>}

              {/* Node rectangle */}
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={nodeRadius}
                ry={nodeRadius}
                fill={COLORS.nodeFill}
                stroke={node.isEntry ? COLORS.entryStroke : COLORS.nodeStroke}
                strokeWidth={node.isEntry ? 2 : 1}
                data-entry={node.isEntry ? 'true' : undefined}
              />

              {/* Step name label (truncated if needed) */}
              <text
                x={node.x + node.width / 2}
                y={node.y + node.height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill={COLORS.nodeText}
                fontSize={fontSize}
                fontFamily="var(--font-mono), monospace"
                fontWeight={node.isEntry ? 600 : 400}
              >
                {displayName}
              </text>

              {/* Indicator dots for gather/branching */}
              {node.step.hasGather && (
                <circle
                  cx={node.x + node.width - indicatorSize - 4}
                  cy={node.y + indicatorSize + 4}
                  r={indicatorSize / 2}
                  fill={COLORS.gatherDot}
                />
              )}
              {node.step.hasBranching && (
                <circle
                  cx={node.x + node.width - indicatorSize - 4}
                  cy={node.y + node.height - indicatorSize - 2}
                  r={indicatorSize / 2}
                  fill={COLORS.branchDot}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
