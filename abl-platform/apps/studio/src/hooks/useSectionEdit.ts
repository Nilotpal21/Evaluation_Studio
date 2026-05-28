/**
 * useSectionEdit Hook
 *
 * Debounces section form changes (500ms) and sends them
 * to the surgical edit API. Updates save status via a caller-provided
 * callback (defaults to agent-detail-store for backward compatibility).
 *
 * Supports batching: multiple editSection calls within the debounce
 * window are merged into a single API request.
 *
 * `saveEditsNow` flushes immediately (no debounce) for explicit Save
 * button clicks. Returns a promise so the caller can await completion.
 */

import { useCallback, useRef } from 'react';
import { apiFetch, handleResponse } from '@/lib/api-client';
import { useAgentDetailStore } from '@/store/agent-detail-store';
import { sanitizeError } from '@/lib/sanitize-error';
import type { SectionEdit } from '@/lib/abl-serializers';

const DEBOUNCE_MS = 500;

interface EditResponse {
  success?: boolean;
  dslContent: string;
  diff: unknown;
}

type StatusCallback = (status: 'saving' | 'saved' | 'error', error?: string) => void;

function mergePendingEdits(existing: SectionEdit[], incoming: SectionEdit[]): SectionEdit[] {
  const merged = [...existing];

  for (const edit of incoming) {
    const idx = merged.findIndex((entry) => entry.section === edit.section);
    if (idx >= 0) {
      merged[idx] = edit;
    } else {
      merged.push(edit);
    }
  }

  return merged;
}

export function useSectionEdit(
  projectId: string | null,
  agentName: string | null,
  onSaved?: () => void,
  statusCallback?: StatusCallback,
) {
  const detailStoreSaveStatus = useAgentDetailStore((s) => s.setSaveStatus);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditsRef = useRef<SectionEdit[]>([]);

  const setSaveStatus: StatusCallback = statusCallback ?? detailStoreSaveStatus;

  const flush = useCallback(async (): Promise<boolean> => {
    if (!projectId || !agentName || pendingEditsRef.current.length === 0) return false;

    // Snapshot and clear pending edits
    const edits = [...pendingEditsRef.current];
    pendingEditsRef.current = [];

    setSaveStatus('saving');
    try {
      const res = await apiFetch(`/api/projects/${projectId}/agents/${agentName}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits }),
      });
      await handleResponse<EditResponse>(res);
      setSaveStatus('saved');
      onSaved?.();
      return true;
    } catch (err) {
      pendingEditsRef.current = mergePendingEdits(pendingEditsRef.current, edits);
      setSaveStatus('error', sanitizeError(err, 'Save failed'));
      return false;
    }
  }, [projectId, agentName, setSaveStatus, onSaved]);

  const editSection = useCallback(
    (section: string, content: string | null) => {
      pendingEditsRef.current = mergePendingEdits(pendingEditsRef.current, [{ section, content }]);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  /**
   * Submit multiple section edits at once.
   * Edits are merged into the pending batch and flushed on the debounce timer.
   */
  const editSections = useCallback(
    (edits: SectionEdit[]) => {
      pendingEditsRef.current = mergePendingEdits(pendingEditsRef.current, edits);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  /**
   * Flush pending edits immediately (no debounce).
   * Use for explicit Save button clicks where the user expects instant feedback.
   * Accepts optional edits to queue before flushing.
   * Returns true when the save succeeds.
   */
  const saveEditsNow = useCallback(
    async (edits?: SectionEdit[]) => {
      // Cancel any pending debounce
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // Queue edits if provided
      if (edits) {
        pendingEditsRef.current = mergePendingEdits(pendingEditsRef.current, edits);
      }

      return flush();
    },
    [flush],
  );

  return { editSection, editSections, saveEditsNow };
}
