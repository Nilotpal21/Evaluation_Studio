import { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { AppError } from '@agent-platform/shared/errors';
import { cancelExecution, getExecution } from '../../../../api/workflows';
import { sanitizeError } from '../../../../lib/sanitize-error';
import { useWorkflowCanvasStore } from '../../../../store/workflow-canvas-store';

export function useWorkflowCancelExecution(
  projectId: string | undefined,
  workflowId: string | undefined,
) {
  const t = useTranslations('workflows.canvas');
  const currentExecutionId = useWorkflowCanvasStore((s) => s.currentExecutionId);
  const executeAbortController = useWorkflowCanvasStore((s) => s.executeAbortController);
  const setExecuteAbortController = useWorkflowCanvasStore((s) => s.setExecuteAbortController);
  const setIsCancelling = useWorkflowCanvasStore((s) => s.setIsCancelling);
  const setExecutionStatus = useWorkflowCanvasStore((s) => s.setExecutionStatus);
  const setCurrentExecutionId = useWorkflowCanvasStore((s) => s.setCurrentExecutionId);
  const setDebugPanelOpen = useWorkflowCanvasStore((s) => s.setDebugPanelOpen);
  const handleStop = useCallback(async () => {
    if (!currentExecutionId || !projectId || !workflowId) return;

    if (currentExecutionId === '__starting__') {
      executeAbortController?.abort();
      setExecuteAbortController(null);
      setCurrentExecutionId(null);
      setExecutionStatus(null);
      setDebugPanelOpen(false);
      toast.info(t('execution_cancelled_toast'));
      return;
    }

    setIsCancelling(true);
    try {
      await cancelExecution(projectId, workflowId, currentExecutionId);
      setExecutionStatus('cancelled');
      toast.success(t('execution_cancelled_toast'));
    } catch (err) {
      if (
        err instanceof AppError &&
        err.statusCode === 409 &&
        err.code === 'EXECUTION_NOT_CANCELLABLE'
      ) {
        try {
          const exec = await getExecution(projectId, workflowId, currentExecutionId);
          if (exec.status) setExecutionStatus(exec.status);
        } catch {}
        return;
      }
      toast.error(sanitizeError(err, t('execution_cancel_failed')));
    } finally {
      setIsCancelling(false);
    }
  }, [
    t,
    projectId,
    workflowId,
    currentExecutionId,
    executeAbortController,
    setExecuteAbortController,
    setIsCancelling,
    setExecutionStatus,
    setCurrentExecutionId,
    setDebugPanelOpen,
  ]);

  return { handleStop };
}
