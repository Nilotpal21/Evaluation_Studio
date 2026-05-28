'use client';

/**
 * DslEditorOverlay -- full-viewport overlay for DSL code editing.
 *
 * Wraps ABLEditor (Monaco-based) in a modal overlay. Seeds the editor store
 * with the current DSL on open and saves back via the DSL API endpoint.
 */

import React, { useEffect, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Code2, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { springs, transitions } from '@/lib/animation';
import { OVERLAY_BACKDROP } from '@agent-platform/design-tokens';

// Lazy-load Monaco-based editor (~50KB gzipped)
const ABLEditor = dynamic(
  () => import('@/components/abl/ABLEditor').then((m) => ({ default: m.ABLEditor })),
  {
    ssr: false,
    loading: () => <div className="flex-1 animate-pulse bg-background-muted rounded" />,
  },
);
import { useEditorStore } from '@/store/editor-store';
import { apiFetch } from '@/lib/api-client';
import { sanitizeError } from '@/lib/sanitize-error';

// =============================================================================
// PROPS
// =============================================================================

export interface DslEditorOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean;
  /** Callback to close the overlay */
  onClose: () => void;
  /** Project identifier */
  projectId: string;
  /** Agent name */
  agentName: string;
  /** Current DSL content */
  dsl: string;
  /** Trigger reload after save */
  onSaved: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function DslEditorOverlay({
  isOpen,
  onClose,
  projectId,
  agentName,
  dsl,
  onSaved,
}: DslEditorOverlayProps) {
  const t = useTranslations('agents.dsl_editor');
  const setOriginalContent = useEditorStore((s) => s.setOriginalContent);
  const dslContent = useEditorStore((s) => s.dslContent);
  const isDirty = useEditorStore((s) => s.isDirty);
  const saveError = useEditorStore((s) => s.saveError);
  const compileErrors = useEditorStore((s) => s.compileErrors);
  const [saving, setSaving] = useState(false);

  // Fetch fresh DSL from the DB when the overlay opens to avoid stale content
  // after visual editor saves that haven't propagated through SWR yet.
  useEffect(() => {
    if (!isOpen) return;

    // Clear error state and set initial content immediately (don't wait for async fetch)
    useEditorStore.getState().setSaveError(null);
    useEditorStore.getState().setCompileErrors([]);
    if (dsl != null) {
      setOriginalContent(dsl);
    }

    let cancelled = false;
    apiFetch(`/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const freshDsl = data?.agent?.dslContent;
        if (typeof freshDsl === 'string') {
          setOriginalContent(freshDsl);
        }
      })
      .catch(() => {
        // Already set initial content above, no need to do anything on error
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, agentName, dsl, setOriginalContent]);

  const handleSave = useCallback(async () => {
    const content = useEditorStore.getState().dslContent;
    setSaving(true);
    try {
      // Save DSL content
      const saveRes = await apiFetch(`/api/projects/${projectId}/agents/${agentName}/dsl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dslContent: content }),
      });

      // Check save response status (409 = name mismatch, other errors)
      if (!saveRes.ok) {
        const errorData = await saveRes.json();
        const errorMsg = errorData.error || 'Failed to save DSL';
        useEditorStore.getState().setSaveError(errorMsg);
        toast.error(errorMsg);
        return;
      }

      // Check compile status to validate against the full project
      const compileRes = await apiFetch(
        `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/compile`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const compileData = await compileRes.json();

      if (!compileData.success && compileData.errors?.length > 0) {
        // Compilation failed. Show error and keep editor open.
        const errorMsg = compileData.errors[0];
        useEditorStore.getState().setSaveError(errorMsg);
        toast.error(errorMsg);
        return;
      }

      // Both save and compile successful, mark as saved and close
      useEditorStore.getState().markSaved();
      onSaved();
      onClose();
    } catch (err) {
      // Client component — can't use createLogger here (server-only module)
      console.error(
        '[dsl-editor-overlay] DSL save failed:',
        err instanceof Error ? err.message : String(err),
      );
      useEditorStore.getState().setSaveError(sanitizeError(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }, [projectId, agentName, onSaved, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="dsl-backdrop"
            data-testid="dsl-backdrop"
            className={OVERLAY_BACKDROP}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transitions.backdrop}
            onClick={onClose}
          />

          {/* Full-viewport overlay */}
          <motion.div
            key="dsl-overlay"
            className={clsx(
              'fixed inset-4 z-50',
              'bg-background-elevated border border-default rounded-xl shadow-xl',
              'flex flex-col overflow-hidden',
            )}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={springs.default}
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-default shrink-0">
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
                <span className="text-xs text-muted">{agentName}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !isDirty || saveError !== null || compileErrors.length > 0}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg',
                    'bg-success text-success-foreground hover:opacity-90 transition-fast btn-press',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  )}
                >
                  {saving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  {t('save')}
                </button>
                <button
                  type="button"
                  aria-label="Close ABL editor"
                  onClick={onClose}
                  className={clsx(
                    'p-1.5 rounded-md transition-fast',
                    'text-muted hover:text-foreground hover:bg-background-muted',
                  )}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Monaco editor */}
            <ABLEditor
              className="flex-1"
              onSave={handleSave}
              projectId={projectId}
              agentName={agentName}
            />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
