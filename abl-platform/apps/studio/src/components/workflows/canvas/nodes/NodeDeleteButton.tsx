'use client';

import { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

interface NodeDeleteButtonProps {
  nodeId: string;
}

export function NodeDeleteButton({ nodeId }: NodeDeleteButtonProps) {
  const removeNode = useWorkflowCanvasStore((s) => s.removeNode);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeNode(nodeId);
    },
    [removeNode, nodeId],
  );

  return (
    <button
      type="button"
      className="absolute -top-2.5 -right-2.5 w-5 h-5 flex items-center justify-center rounded-full bg-error text-white opacity-0 group-hover:opacity-100 transition-opacity duration-150 hover:bg-error/90 shadow-sm z-10"
      onClick={handleDelete}
      data-testid={`node-delete-${nodeId}`}
      aria-label="Delete node"
    >
      <Trash2 className="w-3 h-3" />
    </button>
  );
}
