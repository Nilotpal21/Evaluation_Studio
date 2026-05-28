/**
 * useWorkflowSave
 *
 * Hook for saving the current workflow canvas state to the API.
 */

import { useCallback, useRef } from 'react';
import { useWorkflowCanvasStore } from '../../../store/workflow-canvas-store';
import { useNavigationStore } from '../../../store/navigation-store';
import { saveWorkflowVersionDraft } from '../../../api/workflows';
import {
  deriveWorkflowInputSchema,
  deriveWorkflowOutputSchema,
} from '../../../lib/variables-to-json-schema';
import { toast } from 'sonner';

export function useWorkflowSave(): { save: () => Promise<void> } {
  const savingRef = useRef(false);

  const save = useCallback(async () => {
    if (savingRef.current) return;

    const store = useWorkflowCanvasStore.getState();
    const { projectId } = useNavigationStore.getState();

    if (!projectId || !store.workflowId) {
      toast.error('Cannot save: missing project or workflow ID');
      return;
    }

    savingRef.current = true;
    store.setIsSaving(true);
    const changeVersionAtSaveStart = store.changeVersion;

    try {
      const nodes = store.toWorkflowNodes();
      const edges = store.toWorkflowEdges();

      // Derive workflow-level schemas from the canvas's Start/End node
      // authoring surfaces. Canvas authoring is the single source of truth —
      // when inputVariables / outputMapping exist, the derived schema wins
      // over any previously-stored schema so the two representations can
      // never drift. `store.inputSchema` / `outputSchema` only survive as a
      // fallback for workflows imported from a spec or set via API without
      // using the canvas (derivation returns null in that case).
      const derivedInputSchema = deriveWorkflowInputSchema(nodes);
      const derivedOutputSchema = deriveWorkflowOutputSchema(nodes);

      await saveWorkflowVersionDraft(projectId, store.workflowId, {
        name: store.workflowName,
        description: store.workflowDescription || undefined,
        nodes,
        edges,
        envVars: store.envVars,
        inputSchema: derivedInputSchema ?? store.inputSchema ?? undefined,
        outputSchema: derivedOutputSchema ?? store.outputSchema ?? undefined,
      });

      store.markSavedIfUnchanged(changeVersionAtSaveStart);
      toast.success('Workflow saved');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save workflow: ${message}`);
      store.setIsSaving(false);
    } finally {
      savingRef.current = false;
    }
  }, []);

  return { save };
}
