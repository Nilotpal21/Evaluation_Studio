/**
 * InsertableEdge — Custom React Flow edge with hover "+" button.
 *
 * When the user hovers over an edge between two stage nodes, a small "+"
 * circle fades in at the midpoint. Clicking it opens the AddStagePopover
 * to insert a new stage at that position (Make.com pattern — Screen 5).
 */

'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { AddStagePopover } from '../AddStagePopover';
import type { PipelineStage } from '../../../../../api/pipelines';
import { usePipelineStore } from '../../../../../store/pipeline-store';

export function InsertableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const draft = usePipelineStore((s) => s.draft);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const edgeData = data as
    | {
        flowId?: string;
        afterStageId?: string | null;
        beforeStageId?: string | null;
      }
    | undefined;

  const flowId = edgeData?.flowId ?? '';
  const afterStageId = edgeData?.afterStageId ?? null;
  const beforeStageId = edgeData?.beforeStageId ?? null;

  // Get existing stages for the flow
  const existingStages: PipelineStage[] = useMemo(() => {
    if (!draft || !flowId) return [];
    const flow = draft.flows.find((f) => f.id === flowId);
    return flow?.stages ?? [];
  }, [draft, flowId]);

  const handleClose = useCallback(() => {
    setShowPopover(false);
    setIsHovered(false);
  }, []);

  // Only show the "+" for flow-lane edges (has flowId)
  const canInsert = Boolean(flowId);

  return (
    <>
      {/* Invisible wider hit area for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={30}
        onMouseEnter={() => canInsert && setIsHovered(true)}
        onMouseLeave={() => !showPopover && setIsHovered(false)}
      />

      {/* Visible edge */}
      <BaseEdge id={id} path={edgePath} style={style} />

      {/* Hover "+" button — wider foreignObject so mouse doesn't leave before click */}
      {canInsert && (isHovered || showPopover) && (
        <foreignObject
          x={labelX - 20}
          y={labelY - 20}
          width={40}
          height={40}
          className="pointer-events-auto overflow-visible"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => !showPopover && setIsHovered(false)}
        >
          <div className="flex h-10 w-10 items-center justify-center">
            <button
              ref={triggerRef}
              onClick={(e) => {
                e.stopPropagation();
                setShowPopover(!showPopover);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-accent bg-background text-accent shadow-md transition-all hover:scale-110 hover:bg-accent hover:text-accent-foreground"
              aria-label="Add stage"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            {showPopover && (
              <AddStagePopover
                flowId={flowId}
                afterStageId={afterStageId}
                beforeStageId={beforeStageId}
                existingStages={existingStages}
                onClose={handleClose}
                anchorRef={triggerRef}
              />
            )}
          </div>
        </foreignObject>
      )}
    </>
  );
}
