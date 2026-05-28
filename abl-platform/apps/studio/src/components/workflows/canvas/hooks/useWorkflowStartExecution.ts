import { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { cancelExecution, executeWorkflow } from '../../../../api/workflows';
import { sanitizeError } from '../../../../lib/sanitize-error';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../../store/navigation-store';

export function useWorkflowStartExecution() {
  const t = useTranslations('workflows.canvas');
  const projectId = useNavigationStore((s) => s.projectId);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const setCurrentExecutionId = useWorkflowCanvasStore((s) => s.setCurrentExecutionId);
  const setExecutionStatus = useWorkflowCanvasStore((s) => s.setExecutionStatus);
  const setDebugPanelOpen = useWorkflowCanvasStore((s) => s.setDebugPanelOpen);
  const setExecuteAbortController = useWorkflowCanvasStore((s) => s.setExecuteAbortController);

  const startExecution = useCallback(
    async (input?: Record<string, unknown>) => {
      if (!projectId || !workflowId) {
        toast.error(t('missing_project_or_workflow'));
        return;
      }

      const controller = new AbortController();
      setExecuteAbortController(controller);
      setExecutionStatus(null);
      setCurrentExecutionId('__starting__');
      setDebugPanelOpen(true);

      try {
        const execution = await executeWorkflow(projectId, workflowId, input, controller.signal);
        // Cancel may have fired AFTER the request reached the engine but BEFORE
        // the response landed here. If so, the engine has scheduled an
        // execution we now own the ID of — send a cancel so it doesn't run
        // orphaned, and don't overwrite the cleared currentExecutionId.
        if (controller.signal.aborted) {
          void cancelExecution(projectId, workflowId, execution.id).catch((cancelErr) => {
            console.warn('Failed to cancel orphan execution after abort', {
              executionId: execution.id,
              error: sanitizeError(cancelErr, 'cancel failed'),
            });
          });
          return;
        }
        // The user may have navigated to a different workflow between the
        // fetch dispatch and the response landing. setCurrentExecutionId
        // writes to whichever workflow the store is bound to NOW, so writing
        // here would mis-attribute A's execution to B (and persist it under
        // B's sessionStorage key). Bail out if the store moved on.
        const currentStoreWorkflowId = useWorkflowCanvasStore.getState().workflowId;
        if (currentStoreWorkflowId !== workflowId) {
          void cancelExecution(projectId, workflowId, execution.id).catch((cancelErr) => {
            console.warn('Failed to cancel execution after workflow switch', {
              executionId: execution.id,
              error: sanitizeError(cancelErr, 'cancel failed'),
            });
          });
          return;
        }
        toast.success(t('execution_starting_toast'));
        setCurrentExecutionId(execution.id);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        toast.error(sanitizeError(err, t('execution_start_failed')));
        setCurrentExecutionId(null);
        setDebugPanelOpen(false);
      } finally {
        setExecuteAbortController(null);
      }
    },
    [
      t,
      projectId,
      workflowId,
      setCurrentExecutionId,
      setExecutionStatus,
      setDebugPanelOpen,
      setExecuteAbortController,
    ],
  );

  return { startExecution };
}
