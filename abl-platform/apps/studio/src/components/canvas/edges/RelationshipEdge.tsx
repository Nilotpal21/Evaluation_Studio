'use client';

import { memo, useState, useCallback } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { EdgePopover } from './EdgePopover';

export type RelationshipType = 'handoff' | 'delegate' | 'escalate';

export interface RelationshipEdgeData {
  relationshipType: RelationshipType;
  label?: string;
  condition?: string;
  returns?: boolean;
  [key: string]: unknown;
}

export const EDGE_COLORS: Record<RelationshipType, string> = {
  handoff: 'hsl(var(--edge-handoff))',
  delegate: 'hsl(var(--edge-delegate))',
  escalate: 'hsl(var(--edge-escalate))',
};

export const EDGE_COLORS_HOVER: Record<RelationshipType, string> = {
  handoff: 'hsl(var(--edge-handoff-hover))',
  delegate: 'hsl(var(--edge-delegate-hover))',
  escalate: 'hsl(var(--edge-escalate-hover))',
};

export const EDGE_LABELS: Record<RelationshipType, string> = {
  handoff: 'Handoff',
  delegate: 'Delegate',
  escalate: 'Escalate',
};

const MARKER_MAP: Record<RelationshipType, string> = {
  handoff: 'url(#agent-arrow-handoff)',
  delegate: 'url(#agent-arrow-delegate)',
  escalate: 'url(#agent-arrow-escalate)',
};

const MARKER_MAP_ACTIVE: Record<RelationshipType, string> = {
  handoff: 'url(#agent-arrow-handoff-active)',
  delegate: 'url(#agent-arrow-delegate-active)',
  escalate: 'url(#agent-arrow-escalate-active)',
};

const DASH_MAP: Record<RelationshipType, string> = {
  handoff: 'none',
  delegate: '8 5',
  escalate: '2 4',
};

const DEFAULT_OPACITY: Record<RelationshipType, number> = {
  handoff: 0.3,
  delegate: 0.45,
  escalate: 0.3,
};

export const RelationshipEdge = memo(function RelationshipEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const edgeData = data as RelationshipEdgeData | undefined;
  const relType = edgeData?.relationshipType ?? 'handoff';
  const subtleColor = EDGE_COLORS[relType];
  const hoverColor = EDGE_COLORS_HOVER[relType];
  const dashArray = DASH_MAP[relType];

  const [hovered, setHovered] = useState(false);
  const active = selected || hovered;
  const color = active ? hoverColor : subtleColor;
  const markerEnd = active ? MARKER_MAP_ACTIVE[relType] : MARKER_MAP[relType];

  const opacity = selected ? 1.0 : hovered ? 0.85 : DEFAULT_OPACITY[relType];
  const strokeWidth = selected ? 2.5 : hovered ? 2 : 1.5;
  const filter = selected
    ? `drop-shadow(0 0 6px ${hoverColor}60)`
    : hovered
      ? `drop-shadow(0 0 4px ${hoverColor}50)`
      : undefined;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 28,
    offset: 30,
  });

  const tooltipText = edgeData?.label
    ? `${EDGE_LABELS[relType]}: ${edgeData.label}`
    : EDGE_LABELS[relType];

  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);

  const handleDelete = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('canvas-edge-delete', {
        detail: { edgeId: id, source, target, relationshipType: relType },
      }),
    );
  }, [id, source, target, relType]);

  const handleEdit = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('canvas-edge-edit', {
        detail: { edgeId: id, source, target, relationshipType: relType },
      }),
    );
  }, [id, source, target, relType]);

  const handleChangeType = useCallback(
    (newType: RelationshipType) => {
      window.dispatchEvent(
        new CustomEvent('canvas-edge-change-type', {
          detail: { edgeId: id, source, target, oldType: relType, newType },
        }),
      );
    },
    [id, source, target, relType],
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
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth,
          strokeDasharray: dashArray,
          opacity,
          filter,
          transition:
            'stroke 250ms ease, stroke-width 250ms ease, opacity 250ms ease, filter 250ms ease',
          pointerEvents: 'none',
        }}
        markerEnd={markerEnd}
      />
      {hovered && !selected && (
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
              className="text-xs px-2 py-1 rounded-md font-medium shadow-md whitespace-nowrap"
              style={{
                backgroundColor: 'var(--background-elevated, #1e1e2e)',
                border: `1px solid color-mix(in srgb, ${hoverColor} 30%, var(--border, #333))`,
                color: hoverColor,
              }}
            >
              {tooltipText}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
      {selected && (
        <EdgeLabelRenderer>
          <EdgePopover
            source={source}
            target={target}
            relationshipType={relType}
            condition={edgeData?.condition ?? edgeData?.label}
            labelX={labelX}
            labelY={labelY}
            onEdit={handleEdit}
            onChangeType={handleChangeType}
            onDelete={handleDelete}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
});
