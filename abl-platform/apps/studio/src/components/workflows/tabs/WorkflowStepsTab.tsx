'use client';

/**
 * WorkflowStepsTab Component
 *
 * Embeds the visual node-based workflow canvas inside the Steps tab.
 * Fullscreen mode shows a dedicated header with save status, Run, and close.
 */

import { useCallback, useEffect } from 'react';
import { Play, Check, X, Maximize2 } from 'lucide-react';
import { WorkflowCanvasPage } from '../canvas/WorkflowCanvasPage';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import { Button } from '../../ui/Button';
import type { WorkflowDetail } from '../../../api/workflows';

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowStepsTabProps {
  workflow: WorkflowDetail;
  onChange?: (workflow: WorkflowDetail) => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowStepsTab({ workflow }: WorkflowStepsTabProps) {
  const canvasExpanded = useWorkflowCanvasStore((s) => s.canvasExpanded);
  const setCanvasExpanded = useWorkflowCanvasStore((s) => s.setCanvasExpanded);
  const isDirty = useWorkflowCanvasStore((s) => s.isDirty);
  const isSaving = useWorkflowCanvasStore((s) => s.isSaving);
  const setRunDialogOpen = useWorkflowCanvasStore((s) => s.setRunDialogOpen);
  const handleClose = useCallback(() => {
    setCanvasExpanded(false);
  }, [setCanvasExpanded]);

  const handleRun = useCallback(() => {
    setRunDialogOpen(true);
  }, [setRunDialogOpen]);

  // Escape key closes fullscreen
  useEffect(() => {
    if (!canvasExpanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCanvasExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canvasExpanded, setCanvasExpanded]);

  if (canvasExpanded) {
    return (
      <div
        className="fixed inset-0 bg-background z-50 flex flex-col"
        data-testid="canvas-fullscreen"
      >
        {/* Fullscreen header */}
        <div className="flex items-center justify-between h-11 px-4 border-b border-default shrink-0">
          <span className="text-sm font-semibold text-foreground truncate" title={workflow.name}>
            {workflow.name}
          </span>
          <div className="flex items-center gap-2">
            {isSaving ? (
              <span className="text-xs text-muted animate-pulse">Saving...</span>
            ) : (
              !isDirty && (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Check className="w-3 h-3 text-success" />
                  Saved
                </span>
              )
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleRun}
              icon={<Play className="w-4 h-4" />}
            >
              Run
            </Button>
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-colors"
              title="Exit fullscreen (Esc)"
              data-testid="canvas-fullscreen-close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-h-0">
          <WorkflowCanvasPage />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <WorkflowCanvasPage
        expandButton={
          <button
            onClick={() => setCanvasExpanded(true)}
            className="p-2 rounded-lg bg-background/80 backdrop-blur text-muted hover:text-foreground hover:bg-background-muted transition-colors"
            title="Expand to fullscreen"
            data-testid="canvas-fullscreen-toggle"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        }
      />
    </div>
  );
}
