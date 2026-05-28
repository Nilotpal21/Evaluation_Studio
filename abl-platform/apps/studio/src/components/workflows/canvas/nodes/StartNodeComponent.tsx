'use client';

import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { clsx } from 'clsx';
import { Flag } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { HandlePlusMenu } from './HandlePlusMenu';

// =============================================================================
// Types
// =============================================================================

interface StartNodeData extends Record<string, unknown> {
  label?: string;
}

type StartNodeXYType = Node<StartNodeData, 'start-node'>;

// =============================================================================
// Component
// =============================================================================

function StartNodeComponentInner({ id, data }: NodeProps<StartNodeXYType>) {
  const executionOverlay = useWorkflowCanvasStore((s) => s.executionOverlay);
  const edges = useWorkflowCanvasStore((s) => s.edges);
  const nodeStatus = executionOverlay?.[id];
  const isConnected = edges.some((e) => e.source === id && e.sourceHandle === 'on_success');
  const label = data.label || 'Start';

  return (
    <div
      className={clsx(
        'group relative flex items-center gap-1.5 px-3 py-2.5 rounded-lg border-2 border-default bg-background-elevated',
        'shadow-sm hover:shadow-md transition-all duration-200 animate-node-appear w-[120px]',
        nodeStatus === 'running' && 'animate-pulse-ring ring-2 ring-accent',
        nodeStatus === 'completed' && 'animate-completion-flash ring-2 ring-success',
        nodeStatus === 'failed' && 'animate-error-shake ring-2 ring-error',
        nodeStatus === 'cancelled' && 'ring-2 ring-error',
      )}
      data-testid="workflow-node-start"
      data-node-name={label}
    >
      <Flag className="w-5 h-5 shrink-0 text-success" />
      {/* Vertical divider mirrors the End/Delay node layout so all boundary
          and action nodes have the same icon | label rhythm. */}
      <div className="w-px h-7 bg-foreground-muted/25 shrink-0" />
      <div className="flex-1 min-w-0 leading-none">
        <span
          className="text-xs font-bold text-foreground truncate block leading-none"
          title={label}
        >
          {label}
        </span>
      </div>

      {/* Output handle */}
      <HandlePlusMenu
        nodeId={id}
        handleId="on_success"
        isFailure={false}
        isConnected={isConnected}
      />
    </div>
  );
}

export const StartNodeComponent = memo(StartNodeComponentInner);
