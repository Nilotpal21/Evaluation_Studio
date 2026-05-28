'use client';

import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { clsx } from 'clsx';
import { StopCircle } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { NodeDeleteButton } from './NodeDeleteButton';

// =============================================================================
// Types
// =============================================================================

interface EndNodeData extends Record<string, unknown> {
  label?: string;
}

type EndNodeXYType = Node<EndNodeData, 'end-node'>;

// =============================================================================
// Component
// =============================================================================

function EndNodeComponentInner({ id, data }: NodeProps<EndNodeXYType>) {
  const label = data.label || 'End';
  const executionOverlay = useWorkflowCanvasStore((s) => s.executionOverlay);
  const nodeStatus = executionOverlay?.[id];

  return (
    <div
      className={clsx(
        'group relative bg-background-elevated border border-default rounded-lg',
        'transition-all duration-200 ease-out animate-node-appear',
        'w-[120px] shadow-sm hover:shadow-md',
        nodeStatus === 'running' && 'animate-pulse-ring ring-2 ring-accent',
        nodeStatus === 'completed' && 'animate-completion-flash ring-2 ring-success',
        nodeStatus === 'failed' && 'animate-error-shake ring-2 ring-error',
        nodeStatus === 'cancelled' && 'ring-2 ring-error',
        nodeStatus === 'pending' && 'opacity-50',
      )}
      data-testid="workflow-node-end"
      data-node-name={label}
    >
      {/* Delete button — top-right outside node, shown on hover */}
      <NodeDeleteButton nodeId={id} />

      {/* Input handle on left */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-3 !h-3"
      />

      <div className="px-3 py-2.5 flex items-center gap-1.5">
        <StopCircle className="w-5 h-5 shrink-0 text-error" />
        <div className="w-px h-7 bg-foreground-muted/25 shrink-0" />
        <div className="flex-1 min-w-0 leading-none">
          <span
            className="text-xs font-bold text-foreground truncate block leading-none"
            title={label}
          >
            {label}
          </span>
          <span className="text-[10px] text-foreground-muted capitalize leading-none mt-1 block">
            End
          </span>
        </div>
      </div>
    </div>
  );
}

export const EndNodeComponent = memo(EndNodeComponentInner);
