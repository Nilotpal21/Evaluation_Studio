'use client';

import { memo, useCallback } from 'react';
import {
  ArrowLeft,
  Play,
  Square,
  AlertTriangle,
  Check,
  Maximize2,
  Minimize2,
  Loader2,
} from 'lucide-react';
import { Button } from '../../../ui/Button';
import { useNavigationStore } from '../../../../store/navigation-store';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { ACTIVE_EXEC_STATUSES } from '../constants/workflow';
import { useWorkflowCancelExecution } from '../hooks/useWorkflowCancelExecution';
import { useWorkflowStartExecution } from '../hooks/useWorkflowStartExecution';
import { useWorkflowSave } from '../useWorkflowSave';

// =============================================================================
// Helpers
// =============================================================================

/** Extract input variables from the Start node config */
function getWorkflowInputVariables(
  nodes: ReturnType<typeof useWorkflowCanvasStore.getState>['nodes'],
): Array<{ name: string; type: string; required: boolean }> {
  const startNode = nodes.find((n) => n.data.nodeType === 'start');
  return (
    (startNode?.data.config?.inputVariables as Array<{
      name: string;
      type: string;
      required: boolean;
    }>) || []
  );
}

// =============================================================================
// Props
// =============================================================================

interface CanvasToolbarProps {
  onSave: () => void;
  embedded?: boolean;
}

// =============================================================================
// Component
// =============================================================================

function CanvasToolbarInner({ onSave, embedded }: CanvasToolbarProps) {
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);

  const workflowName = useWorkflowCanvasStore((s) => s.workflowName);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const nodes = useWorkflowCanvasStore((s) => s.nodes);
  const validationIssues = useWorkflowCanvasStore((s) => s.validationIssues);
  const isDirty = useWorkflowCanvasStore((s) => s.isDirty);
  const isSaving = useWorkflowCanvasStore((s) => s.isSaving);
  const canvasExpanded = useWorkflowCanvasStore((s) => s.canvasExpanded);
  const currentExecutionId = useWorkflowCanvasStore((s) => s.currentExecutionId);
  const executionStatus = useWorkflowCanvasStore((s) => s.executionStatus);
  const isCancelling = useWorkflowCanvasStore((s) => s.isCancelling);
  const debugPanelOpen = useWorkflowCanvasStore((s) => s.debugPanelOpen);
  const setRunDialogOpen = useWorkflowCanvasStore((s) => s.setRunDialogOpen);
  const setValidationPanelOpen = useWorkflowCanvasStore((s) => s.setValidationPanelOpen);
  const setCanvasExpanded = useWorkflowCanvasStore((s) => s.setCanvasExpanded);

  const errorCount = validationIssues.filter((i) => i.severity === 'error').length;
  const warningCount = validationIssues.length - errorCount;
  const issueCount = validationIssues.length;

  // Show Stop only when the debug panel is open and the execution is still active
  const isExecuting =
    debugPanelOpen &&
    currentExecutionId !== null &&
    (executionStatus === null || ACTIVE_EXEC_STATUSES.has(executionStatus));

  const handleBack = () => {
    const basePath = projectId ? `/projects/${projectId}/workflows` : '/';
    navigate(basePath);
  };

  const { handleStop } = useWorkflowCancelExecution(
    projectId ?? undefined,
    workflowId ?? undefined,
  );

  const { startExecution } = useWorkflowStartExecution();
  const { save } = useWorkflowSave();

  const handleRun = useCallback(async () => {
    // Always force-save before executing so the engine runs the current canvas
    // state. We call save() unconditionally — it guards against concurrent
    // saves internally via savingRef. After save() resolves we wait for any
    // concurrent in-flight auto-save to drain before proceeding.
    await save();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const s = useWorkflowCanvasStore.getState();
      if (!s.isSaving && !s.isDirty) break;
      await new Promise<void>((r) => setTimeout(r, 80));
    }

    const inputVars = getWorkflowInputVariables(nodes);
    if (inputVars.length > 0) {
      setRunDialogOpen(true);
      return;
    }
    await startExecution();
  }, [save, nodes, setRunDialogOpen, startExecution]);

  // Derive save status from existing state
  const saveStatusText = isSaving ? 'Saving...' : !isDirty ? 'Saved' : null;

  return (
    <div
      className="flex items-center justify-between h-12 px-3 bg-background border-b border-default"
      data-testid="canvas-toolbar"
    >
      {/* Left section: Back + Name + Badge */}
      <div className="flex items-center gap-2 min-w-0">
        {!embedded && (
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft className="w-4 h-4" />}
            onClick={handleBack}
            data-testid="toolbar-back-btn"
          />
        )}
        <span
          className="text-sm font-semibold text-foreground truncate max-w-[240px]"
          data-testid="toolbar-workflow-name"
          title={workflowName}
        >
          {workflowName || 'Untitled Workflow'}
        </span>
        {issueCount > 0 && (
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
            onClick={() => setValidationPanelOpen(true)}
            data-testid="toolbar-validation-badge"
            title={`${errorCount} error(s), ${warningCount} warning(s)`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            {issueCount}
          </button>
        )}
      </div>

      {/* Right section: Save status + Run/Stop + Expand */}
      <div className="flex items-center gap-2">
        {saveStatusText && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground transition-opacity duration-300">
            {isSaving ? (
              <span className="animate-pulse">{saveStatusText}</span>
            ) : (
              <>
                <Check className="w-3 h-3 text-success" />
                {saveStatusText}
              </>
            )}
          </span>
        )}
        {isExecuting ? (
          <Button
            variant="danger"
            size="sm"
            icon={
              isCancelling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Square className="w-3.5 h-3.5" />
              )
            }
            onClick={() => void handleStop()}
            disabled={isCancelling}
            title="Cancel this execution"
            data-testid="toolbar-stop-btn"
          >
            <span className="flex items-center gap-1.5">
              {isCancelling ? 'Stopping…' : 'Stop'}
              {!isCancelling && (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-error" />
                </span>
              )}
            </span>
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="w-4 h-4" />}
            onClick={handleRun}
            title="Run this workflow"
            data-testid="toolbar-run-btn"
          >
            Run
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          icon={
            canvasExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />
          }
          onClick={() => setCanvasExpanded(!canvasExpanded)}
          aria-label={canvasExpanded ? 'Collapse canvas' : 'Expand canvas'}
          data-testid="toolbar-expand-btn"
        />
      </div>
    </div>
  );
}

export const CanvasToolbar = memo(CanvasToolbarInner);
