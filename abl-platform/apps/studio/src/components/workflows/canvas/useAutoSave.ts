/**
 * useAutoSave
 *
 * Debounced auto-save hook that watches isDirty and triggers save.
 */

import { useEffect, useRef } from 'react';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';

const AUTO_SAVE_DELAY_MS = 2000;

export function useAutoSave(save: () => Promise<void>) {
  const isDirty = useWorkflowCanvasStore((s) => s.isDirty);
  const isSaving = useWorkflowCanvasStore((s) => s.isSaving);
  const workflowId = useWorkflowCanvasStore((s) => s.workflowId);
  const changeVersion = useWorkflowCanvasStore((s) => s.changeVersion);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!isDirty || isSaving || !workflowId) return;

    timerRef.current = setTimeout(() => {
      save();
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      clearTimeout(timerRef.current);
    };
  }, [isDirty, isSaving, workflowId, changeVersion, save]);
}
