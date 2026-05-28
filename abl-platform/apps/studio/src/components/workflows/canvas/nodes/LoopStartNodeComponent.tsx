'use client';

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Flag } from 'lucide-react';
import { clsx } from 'clsx';
import type { WorkflowNodeData } from '../../../../store/workflow-canvas-store';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { HandlePlusMenu } from './HandlePlusMenu';

type LoopStartNodeXYType = Node<WorkflowNodeData, 'loop-start-node'>;

function LoopStartNodeComponentInner({ id }: NodeProps<LoopStartNodeXYType>) {
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const isConnected = edges.some((e) => e.source === id && e.sourceHandle === 'loop_body');

  return (
    <div
      className="relative h-10 w-10 overflow-visible nodrag nopan z-10 pointer-events-none"
      data-testid={`workflow-node-${id}`}
      data-node-type="loop_start"
    >
      <div className="absolute inset-0">
        <Handle
          type="target"
          position={Position.Left}
          className="!absolute !left-0 !top-1/2 !h-3 !w-3 !-translate-x-1/2 !-translate-y-1/2 !rounded-full !bg-foreground-subtle !border-2 !border-background-elevated !pointer-events-auto"
        />

        <div
          className={clsx(
            'relative h-10 w-10 rounded-md border-2 border-default bg-background-elevated shadow-sm pointer-events-none flex items-center justify-center',
            isConnected && 'ring-2 ring-accent/20',
          )}
        >
          <Flag className="w-4 h-4 text-success" />
        </div>

        <div className="absolute right-0 top-1/2 h-3.5 w-3.5 translate-x-1/2 -translate-y-1/2 pointer-events-auto">
          <HandlePlusMenu
            nodeId={id}
            handleId="loop_body"
            isFailure={false}
            isConnected={isConnected}
            blockedTypes={['loop', 'start', 'end']}
            wrapperClassName="h-full w-full"
            handleClassName="!absolute !left-1/2 !top-1/2 !-translate-x-1/2 !-translate-y-1/2"
            useNativeHandlePositioning
          />
        </div>
      </div>
    </div>
  );
}

export const LoopStartNodeComponent = memo(LoopStartNodeComponentInner);
