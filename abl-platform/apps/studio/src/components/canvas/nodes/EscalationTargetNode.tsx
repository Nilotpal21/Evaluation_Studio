'use client';

import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { User } from 'lucide-react';
import { clsx } from 'clsx';
import type { EscalationTargetNodeData } from '../types';

type EscalationTargetNodeType = Node<EscalationTargetNodeData, 'escalation-target'>;

function EscalationTargetNodeComponent({ data, selected }: NodeProps<EscalationTargetNodeType>) {
  return (
    <div
      className={clsx(
        'canvas-node w-[240px] min-h-[100px] rounded-xl',
        'bg-warning-subtle border-2 border-warning shadow-sm',
        'transition-all duration-200 ease-out',
        selected && 'shadow-[var(--shadow-glow-error)]',
        'hover:-translate-y-0.5 hover:shadow-lg',
        'ring-2 ring-inset ring-warning/20',
      )}
      style={{
        animationDelay: `${(data.rank ?? 0) * 80}ms`,
      }}
      data-entering="true"
      aria-label={`Escalation target: ${data.name}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2 !h-2 !bg-warning !border-warning/40 !opacity-0 hover:!opacity-100 transition-opacity"
      />

      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5">
        <User className="w-4 h-4 text-warning shrink-0" />
        <span className="text-sm font-semibold text-warning truncate">Human: {data.name}</span>
      </div>

      <div className="mx-3 border-t border-warning/20" />

      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <span className="text-xs text-warning font-medium">Priority: {data.priority}</span>
        {data.skills.length > 0 && (
          <span className="text-xs text-foreground-muted">Skills: {data.skills.join(', ')}</span>
        )}
      </div>
    </div>
  );
}

export const EscalationTargetNodeMemo = memo(EscalationTargetNodeComponent);
