/**
 * PipelineTriggerNode
 *
 * Visual-only React Flow node representing the pipeline trigger.
 * Always present on canvas, non-deletable.
 * Shows trigger summary and configured count badge.
 *
 * Pattern: follows PipelineNodeComponent.tsx
 */

'use client';

import { memo, type CSSProperties } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Zap } from 'lucide-react';
import { clsx } from 'clsx';
import {
  TRIGGER_NODE_WIDTH,
  TRIGGER_NODE_HEIGHT,
  type TriggerNodeData,
} from './pipeline-trigger-constants';

type TriggerNodeType = Node<TriggerNodeData, 'pipelineTriggerNode'>;

function PipelineTriggerNodeComponent({ data, selected }: NodeProps<TriggerNodeType>) {
  const containerStyle: CSSProperties = {
    width: TRIGGER_NODE_WIDTH,
    height: TRIGGER_NODE_HEIGHT,
  };

  return (
    <div
      className={clsx(
        'group/node bg-background-elevated border shadow-sm rounded-lg flex flex-col overflow-hidden',
        'transition-shadow duration-200 ease-out',
        'hover:shadow-md',
        'border-l-[3px] border-l-warning',
        !selected && 'border-default',
        selected && 'ring-2 ring-accent border-accent',
      )}
      style={containerStyle}
      role="button"
      aria-label="Pipeline trigger"
    >
      {/* Header: icon + label (no delete button) */}
      <div className="px-3 pt-2.5 pb-1.5 border-b border-default/40 flex items-center gap-1.5">
        <Zap className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="text-sm font-semibold text-foreground truncate flex-1">{data.label}</span>
      </div>

      {/* Body: trigger summary + configured indicator */}
      <div className="px-3 py-2 flex-1 flex flex-col gap-1 min-h-0">
        <span
          className={clsx(
            'text-[11px] truncate',
            data.triggerCount > 0 ? 'text-foreground-muted' : 'text-foreground-muted/60',
          )}
        >
          {data.triggerSummary}
        </span>

        {data.triggerCount > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-bold">
              {data.triggerCount}
            </span>
            <span className="text-[10px] text-foreground-muted">configured</span>
          </div>
        )}
      </div>

      {/* Source handle only (bottom) — no target handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-foreground-subtle !border-2 !border-background-elevated !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const PipelineTriggerNode = memo(PipelineTriggerNodeComponent);
