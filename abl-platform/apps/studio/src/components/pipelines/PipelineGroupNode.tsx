/**
 * PipelineGroupNode
 *
 * Custom React Flow node for the pipeline graph editor that renders
 * a dashed-border group container for node-group pipeline nodes.
 * Child nodes are positioned inside by React Flow via `parentId` —
 * this component only provides the visual container, header, and
 * connection handles.
 *
 * Pattern: follows PipelineNodeComponent.tsx from the pipeline components.
 */

'use client';

import { memo, useMemo } from 'react';
import { Handle, Position, useNodes } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { Layers } from 'lucide-react';
import { clsx } from 'clsx';

// =============================================================================
// Types
// =============================================================================

export interface PipelineGroupNodeData extends Record<string, unknown> {
  label: string;
  timeout?: number;
  retries?: number;
  onFailure?: 'stop' | 'skip' | 'continue';
}

type PipelineGroupNodeType = Node<PipelineGroupNodeData, 'pipeline-group'>;

// =============================================================================
// Constants
// =============================================================================

export const GROUP_HEADER_HEIGHT = 44;
export const GROUP_PADDING_X = 20;
export const GROUP_PADDING_TOP = GROUP_HEADER_HEIGHT + 12; // 56
export const GROUP_PADDING_BOTTOM = 20;
export const CHILD_GAP = 20;

// =============================================================================
// Component
// =============================================================================

function PipelineGroupNodeComponent({ id, data, selected }: NodeProps<PipelineGroupNodeType>) {
  const allNodes = useNodes();

  const childCount = useMemo(
    () => allNodes.filter((n) => n.parentId === id).length,
    [allNodes, id],
  );

  return (
    <div
      className={clsx(
        'rounded-xl border-2 border-dashed',
        'transition-all duration-200 ease-out',
        selected ? 'border-info bg-info-subtle shadow-md' : 'border-info/40 bg-info-subtle/20',
      )}
      style={{ width: '100%', height: '100%' }}
      role="group"
      aria-label={`Pipeline group: ${data.label}`}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-info !border-2 !border-background !w-2.5 !h-2.5"
      />

      {/* Header row */}
      <div className="flex items-center gap-2 px-3 h-[44px]">
        <Layers className="w-4 h-4 text-info shrink-0" />
        <span className="text-sm font-semibold text-foreground truncate" title={data.label}>
          {data.label}
        </span>
        <span className="ml-auto inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-info-subtle text-info border border-info shrink-0">
          {childCount}
        </span>
      </div>

      {/* Body: empty — child nodes render via React Flow parentId */}

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-info !border-2 !border-background !w-2.5 !h-2.5"
      />
    </div>
  );
}

export const PipelineGroupNode = memo(PipelineGroupNodeComponent);
