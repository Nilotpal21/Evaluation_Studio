/**
 * PipelineEdgeComponent
 *
 * Custom React Flow edge for the pipeline graph editor.
 * Animated smooth-step path with optional condition label
 * and an inline delete button on hover/selected.
 *
 * Pattern: follows RelationshipEdge.tsx from the canvas components.
 */

'use client';

import { memo, useState, useCallback } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';

import { usePipelineEditorStore } from '../../store/pipeline-editor-store';

// =============================================================================
// Types
// =============================================================================

export interface PipelineEdgeData {
  condition?: string;
  label?: string;
  [key: string]: unknown;
}

// =============================================================================
// Component
// =============================================================================

function PipelineEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = data as PipelineEdgeData | undefined;
  const conditionLabel = edgeData?.condition ?? edgeData?.label;

  const removeEdge = usePipelineEditorStore((s) => s.removeEdge);

  const [hovered, setHovered] = useState(false);

  const active = selected || hovered;
  const showDelete = active;
  const strokeColor = selected ? 'hsl(var(--accent))' : 'hsl(var(--border))';
  const strokeWidth = selected ? 3 : hovered ? 2.5 : 2;
  const opacity = 1.0; // Always fully visible

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 20,
    offset: 25,
  });

  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);

  const handleDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      removeEdge(id);
    },
    [id, removeEdge],
  );

  return (
    <>
      {/* Invisible wider path for easier hover targeting */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="pointer-events-auto"
      />

      {/* Visible edge */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          opacity,
          strokeDasharray: 'none', // Solid lines always for better visibility
          transition: 'stroke 200ms ease, stroke-width 200ms ease, opacity 200ms ease',
          pointerEvents: 'none',
        }}
      />

      <EdgeLabelRenderer>
        {/* Delete button */}
        {showDelete && (
          <button
            className="nodrag nopan pointer-events-auto"
            onClick={handleDelete}
            title="Remove connection"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY - (conditionLabel ? 20 : 0)}px)`,
              zIndex: 1001,
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: '1px solid hsl(var(--destructive) / 0.4)',
              backgroundColor: 'hsl(var(--background))',
              color: 'hsl(var(--destructive))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
              fontSize: 12,
              transition: 'background-color 150ms ease, border-color 150ms ease',
            }}
            onMouseOver={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                'hsl(var(--destructive))';
              (e.currentTarget as HTMLButtonElement).style.color = 'white';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'hsl(var(--destructive))';
            }}
            onMouseOut={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor =
                'hsl(var(--background))';
              (e.currentTarget as HTMLButtonElement).style.color = 'hsl(var(--destructive))';
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                'hsl(var(--destructive) / 0.4)';
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <X size={12} strokeWidth={2.5} />
          </button>
        )}

        {/* Condition label */}
        {conditionLabel && (
          <div
            className="nodrag nopan pointer-events-none"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY + (showDelete ? 6 : 0)}px)`,
              zIndex: 1000,
            }}
          >
            <span
              className="text-xs px-2 py-1 rounded-md font-medium shadow-sm whitespace-nowrap border"
              style={{
                backgroundColor: 'var(--background-elevated)',
                borderColor: active ? 'hsl(var(--accent) / 0.3)' : 'var(--border)',
                color: active ? 'hsl(var(--accent))' : 'var(--foreground-muted)',
              }}
            >
              {conditionLabel}
            </span>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const PipelineEdge = memo(PipelineEdgeComponent);
