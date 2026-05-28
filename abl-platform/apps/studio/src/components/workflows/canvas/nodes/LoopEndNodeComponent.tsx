'use client';

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { LOOP_RIGHT_RECT_W, LOOP_RIGHT_RECT_H } from '../../../../store/workflow-canvas-store';
import type { WorkflowNodeData } from '../../../../store/workflow-canvas-store';

type LoopEndNodeXYType = Node<WorkflowNodeData, 'loop-end-node'>;

function LoopEndNodeComponentInner({ id }: NodeProps<LoopEndNodeXYType>) {
  return (
    <div
      className="overflow-visible nodrag nopan pointer-events-none"
      style={{ width: LOOP_RIGHT_RECT_W, height: LOOP_RIGHT_RECT_H }}
      data-testid={`workflow-node-${id}`}
      data-node-type="loop_end"
    >
      {/* Invisible card matching rectangle size; only the handle socket is interactive */}
      <Handle
        type="target"
        position={Position.Left}
        id="loop_body_end"
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3 !pointer-events-auto"
      />
    </div>
  );
}

export const LoopEndNodeComponent = memo(LoopEndNodeComponentInner);
