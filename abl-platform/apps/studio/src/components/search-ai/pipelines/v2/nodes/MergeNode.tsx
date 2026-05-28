/**
 * Merge Node
 *
 * Merge point where multiple flows converge back into the shared pipeline.
 * Non-interactive with muted styling.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

function MergeNodeInner(_props: NodeProps) {
  return (
    <div className="relative h-3 w-3">
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-transparent"
      />
      <div className="absolute inset-0 rounded-full bg-foreground-muted/30" />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-transparent"
      />
    </div>
  );
}

export const MergeNode = memo(MergeNodeInner);
