'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { EdgeDeleteButton } from './EdgeDeleteButton';
import {
  useWorkflowCanvasStore,
  type EdgeBatchBadge,
} from '../../../../store/workflow-canvas-store';

// =============================================================================
// Constants
// =============================================================================

const EDGE_DEFAULT_STROKE = 'hsl(var(--border, 220 4% 18%))';
const EDGE_FAILURE_STROKE = 'hsl(var(--error, 0 72.2% 50.6%))';
const EDGE_SELECTED_STROKE = 'hsl(var(--accent, 220 5% 93%))';
const EDGE_TRAVERSED_STROKE = 'hsl(var(--success, 142.1 76.2% 36.3%))';
const EDGE_ACTIVE_STROKE = 'hsl(var(--accent, 220 5% 93%))';
const EDGE_ACTIVE_GLOW = 'drop-shadow(0 0 4px rgba(59, 130, 246, 0.4))';
const EDGE_FAILURE_ACTIVE_GLOW = 'drop-shadow(0 0 4px rgba(220, 38, 38, 0.4))';

// =============================================================================
// Types
// =============================================================================

export interface WorkflowEdgeData {
  label?: string;
  /** Parallel iteration batch count badge — embedded by setEdgeBatchCounts */
  batchBadge?: EdgeBatchBadge | null;
  [key: string]: unknown;
}

// =============================================================================
// Component
// =============================================================================

function WorkflowEdgeComponentInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  source,
  target,
  data,
  selected,
  markerEnd,
}: EdgeProps) {
  const edgeData = data as WorkflowEdgeData | undefined;
  const label = edgeData?.label;
  const executionEdges = useWorkflowCanvasStore((s) => s.executionEdges);
  // Read batchBadge from edge.data (embedded by setEdgeBatchCounts) rather than
  // from a separate Zustand subscription. ReactFlow v12 doesn't re-render edge
  // components when external store updates fire; it does re-render when edge data
  // changes via the edges prop, which setEdgeBatchCounts now keeps in sync.
  const batchBadge = edgeData?.batchBadge ?? null;

  const isFailure = typeof sourceHandleId === 'string' && sourceHandleId.includes('failure');

  // Edge highlight state — computed centrally by computeExecutionEdges()
  // and stored in the Zustand store as pre-resolved edge ID sets.
  const isTraversed = executionEdges?.traversed.has(id) ?? false;
  const isActive = executionEdges?.active.has(id) ?? false;
  const hasExecutionOverlay = executionEdges !== null;
  const isExecutionHighlighted = isTraversed || isActive;
  const traversedStroke = isFailure ? EDGE_FAILURE_STROKE : EDGE_TRAVERSED_STROKE;
  const activeStroke = isFailure ? EDGE_FAILURE_STROKE : EDGE_ACTIVE_STROKE;
  const activeGlow = isFailure ? EDGE_FAILURE_ACTIVE_GLOW : EDGE_ACTIVE_GLOW;

  const strokeColor = selected
    ? EDGE_SELECTED_STROKE
    : isActive
      ? activeStroke
      : isTraversed
        ? traversedStroke
        : isFailure && !hasExecutionOverlay
          ? EDGE_FAILURE_STROKE
          : EDGE_DEFAULT_STROKE;

  const strokeWidth = selected ? 2.5 : isExecutionHighlighted ? 2 : 1.5;
  const strokeDasharray = isActive ? '6 4' : undefined;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  // Unique ID for the motion path
  const motionPathId = `motion-path-${id}`;

  return (
    <>
      {/* Traveling particle along active edges — feels like data flowing */}
      {isActive && (
        <>
          {/* Define the path for the particle to follow */}
          <path id={motionPathId} d={edgePath} fill="none" stroke="none" />
          {/* Primary particle */}
          <circle r="3" fill={activeStroke} opacity={0.9}>
            <animateMotion dur="6s" repeatCount="indefinite">
              <mpath href={`#${motionPathId}`} />
            </animateMotion>
          </circle>
          {/* Trailing glow particle */}
          <circle r="6" fill={activeStroke} opacity={0.15}>
            <animateMotion dur="6s" repeatCount="indefinite">
              <mpath href={`#${motionPathId}`} />
            </animateMotion>
          </circle>
          {/* Second particle offset for continuous flow feel */}
          <circle r="3" fill={activeStroke} opacity={0.9}>
            <animateMotion dur="6s" begin="3s" repeatCount="indefinite">
              <mpath href={`#${motionPathId}`} />
            </animateMotion>
          </circle>
          <circle r="6" fill={activeStroke} opacity={0.15}>
            <animateMotion dur="6s" begin="3s" repeatCount="indefinite">
              <mpath href={`#${motionPathId}`} />
            </animateMotion>
          </circle>
        </>
      )}
      {/* Glow layer for traversed edges */}
      {isTraversed && (
        <path
          d={edgePath}
          fill="none"
          stroke={traversedStroke}
          strokeWidth={4}
          opacity={0.15}
          strokeLinecap="round"
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          strokeDasharray,
          transition: 'stroke 300ms ease, stroke-width 300ms ease',
          filter: selected
            ? 'drop-shadow(0 0 3px rgba(59, 130, 246, 0.3))'
            : isActive
              ? activeGlow
              : undefined,
        }}
        markerEnd={markerEnd}
        data-testid={`workflow-edge-${id}`}
      />
      {selected && <EdgeDeleteButton edgeId={id} labelX={labelX} labelY={labelY} />}
      {/* Parallel batch count badge — live-only, shows concurrent branch count */}
      {batchBadge && batchBadge.count > 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              zIndex: 1000,
            }}
          >
            <span
              className="flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold text-white shadow-md"
              style={{
                backgroundColor: batchBadge.hasFailed
                  ? 'hsl(var(--error, 0 72.2% 50.6%))'
                  : 'hsl(var(--accent, 220 5% 93%))',
                color: batchBadge.hasFailed ? '#fff' : 'hsl(var(--background, 0 0% 0%))',
              }}
            >
              {batchBadge.count}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              zIndex: 1000,
            }}
          >
            <span
              className="text-xs px-2 py-1 rounded-md font-medium shadow-sm whitespace-nowrap border"
              style={{
                backgroundColor: 'var(--background-elevated, #1e1e2e)',
                borderColor: isExecutionHighlighted
                  ? strokeColor
                  : selected
                    ? 'rgba(59, 130, 246, 0.3)'
                    : 'var(--border, #333)',
                color: isExecutionHighlighted
                  ? strokeColor
                  : selected
                    ? EDGE_SELECTED_STROKE
                    : 'var(--foreground-muted, #999)',
              }}
            >
              {label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const WorkflowEdgeComponent = memo(WorkflowEdgeComponentInner);
