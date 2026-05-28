'use client';

import { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { EdgeLabelRenderer } from '@xyflow/react';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

interface EdgeDeleteButtonProps {
  edgeId: string;
  labelX: number;
  labelY: number;
}

export function EdgeDeleteButton({ edgeId, labelX, labelY }: EdgeDeleteButtonProps) {
  const removeEdge = useWorkflowCanvasStore((s) => s.removeEdge);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeEdge(edgeId);
    },
    [removeEdge, edgeId],
  );

  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan"
        style={{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          pointerEvents: 'all',
          zIndex: 1001,
        }}
      >
        <button
          type="button"
          className="w-7 h-7 rounded-full bg-background-elevated border border-error/50 text-error flex items-center justify-center hover:bg-error-subtle hover:border-error shadow-md transition-colors animate-fade-scale-in"
          onClick={handleDelete}
          data-testid={`edge-delete-${edgeId}`}
          aria-label="Delete edge"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </EdgeLabelRenderer>
  );
}
