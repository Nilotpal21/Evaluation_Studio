/**
 * PipelineEditorV2 — Main container for the V2 pipeline editor.
 *
 * Layout: Toolbar → Canvas (flex-1) + DetailPanel (420px).
 * No FlowsSidebar — canvas swim lanes are the navigation.
 * ConfigSidePanel remains as overlay for complex providers only.
 *
 * Handles: loading/error/empty states, keyboard shortcuts (Cmd+S),
 * and unsaved changes warning (beforeunload).
 */

'use client';

import { useEffect, useCallback, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '../../../ui/Button';
import { ErrorBoundary } from '../../../ui/ErrorBoundary';
import { TooltipProvider } from '../../../ui/Tooltip';
import { usePipelineStore } from '../../../../store/pipeline-store';

import { PipelineSkeleton } from './PipelineSkeleton';
import { EmptyPipelineState } from './EmptyPipelineState';
import { PipelineSelector } from './PipelineSelector';
import { UnsavedIndicator } from './UnsavedIndicator';
import { PipelineToolbar } from './PipelineToolbar';
import { PipelineCanvasV2 } from './PipelineCanvasV2';
import { DetailPanel } from './DetailPanel';
import { ConfigSidePanel } from './ConfigSidePanel';
import { EmbeddingFieldsDrawer } from './EmbeddingFieldsDrawer';
import { RuleBuilderPanel } from '../RuleBuilderPanel';

// Modal imports — will be wired when Task 1.7 is complete
// import { DeployConfirmModal } from './DeployConfirmModal';
// import { EmbeddingChangeModal } from './EmbeddingChangeModal';

export interface PipelineEditorV2Props {
  projectId: string;
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
}

export function PipelineEditorV2({ projectId, knowledgeBaseId }: PipelineEditorV2Props) {
  const t = useTranslations('search_ai.pipeline');

  const isLoading = usePipelineStore((s) => s.isLoading);
  const error = usePipelineStore((s) => s.error);
  const draft = usePipelineStore((s) => s.draft);
  const isDirty = usePipelineStore((s) => s.isDirty);
  const saveStatus = usePipelineStore((s) => s.saveStatus);
  const activePanelType = usePipelineStore((s) => s.activePanelType);
  const ruleBuilderOpen = usePipelineStore((s) => s.ruleBuilderOpen);
  const deploySuccessMessage = usePipelineStore((s) => s.deploySuccessMessage);
  const loadPipeline = usePipelineStore((s) => s.loadPipeline);
  const createPipelineAction = usePipelineStore((s) => s.createPipeline);
  const saveDraft = usePipelineStore((s) => s.saveDraft);
  const reset = usePipelineStore((s) => s.reset);

  // Track creating state locally to avoid re-reading isLoading which serves double duty
  const isCreatingRef = useRef(false);

  // Load pipeline on mount
  useEffect(() => {
    loadPipeline(projectId, knowledgeBaseId);
    return () => reset();
  }, [projectId, knowledgeBaseId, loadPipeline, reset]);

  // Keyboard shortcuts (Cmd/Ctrl+S → save)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Guard: don't fire shortcuts when a modal is open
      if (document.querySelector('[role="dialog"]')) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) {
          saveDraft().then(
            () => {
              toast.success(t('v2_toast_saved'));
            },
            (err: unknown) => {
              toast.error(err instanceof Error ? err.message : t('v2_toast_save_error'));
            },
          );
        }
      }
    },
    [isDirty, saveDraft, t],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Unsaved changes warning
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Handle create pipeline
  const handleCreatePipeline = useCallback(() => {
    isCreatingRef.current = true;
    createPipelineAction(projectId, knowledgeBaseId).then(
      () => {
        isCreatingRef.current = false;
        toast.success(t('v2_toast_created'));
      },
      (err: unknown) => {
        isCreatingRef.current = false;
        toast.error(err instanceof Error ? err.message : t('v2_toast_save_error'));
      },
    );
  }, [createPipelineAction, projectId, knowledgeBaseId, t]);

  // ── Loading state ──────────────────────────────────────────────────────
  if (isLoading && !draft) {
    return <PipelineSkeleton />;
  }

  // ── Error state ────────────────────────────────────────────────────────
  if (error && !draft) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <AlertCircle className="h-8 w-8 text-error" />
        <p className="text-sm text-error">{error}</p>
        <Button variant="secondary" onClick={() => loadPipeline(projectId, knowledgeBaseId)}>
          {t('v2_editor_retry')}
        </Button>
      </div>
    );
  }

  // ── Empty state — no pipeline configured ───────────────────────────────
  if (!draft) {
    return <EmptyPipelineState onCreatePipeline={handleCreatePipeline} isCreating={isLoading} />;
  }

  // ── Full editor layout ─────────────────────────────────────────────────
  return (
    <ErrorBoundary>
      <TooltipProvider>
        <div className="flex h-full flex-col">
          {/* Top bar: PipelineSelector + UnsavedIndicator + PipelineToolbar */}
          <div className="flex items-center gap-3 border-b border-default px-4 py-2">
            <PipelineSelector
              definition={draft}
              isLoading={isLoading}
              projectId={projectId}
              knowledgeBaseId={knowledgeBaseId}
            />
            <UnsavedIndicator isDirty={isDirty} saveStatus={saveStatus} />
            <div className="ml-auto">
              <PipelineToolbar definition={draft} />
            </div>
          </div>

          {/* Deploy success banner (shown after publish with no reindex needed) */}
          {deploySuccessMessage && (
            <div className="flex items-center justify-between border-b border-success/20 bg-success/5 px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-success">&#x2713;</span>
                <span className="text-sm text-foreground">{deploySuccessMessage}</span>
              </div>
              <button
                onClick={() => usePipelineStore.setState({ deploySuccessMessage: null })}
                className="text-xs text-foreground-muted hover:text-foreground"
              >
                &#x2715;
              </button>
            </div>
          )}

          {/* Body: Canvas (flex-1) + DetailPanel (420px) */}
          <div className="relative flex flex-1 overflow-hidden">
            {/* Canvas area — flex-1 */}
            <div className="relative flex flex-1 flex-col overflow-hidden">
              <PipelineCanvasV2 definition={draft} />
            </div>

            {/* Persistent right detail panel — 420px */}
            <DetailPanel />

            {/* Overlay panel — for complex providers (http-webhook) */}
            {activePanelType === 'config' && <ConfigSidePanel />}
          </div>

          {/* Rule Builder — slide-over for editing flow selection rules */}
          {ruleBuilderOpen && <RuleBuilderPanel />}

          {/* Embedding Fields drawer — slides from right when node clicked */}
          <EmbeddingFieldsDrawer />
        </div>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
