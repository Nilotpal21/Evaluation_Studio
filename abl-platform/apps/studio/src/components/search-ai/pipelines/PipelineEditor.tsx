/**
 * Pipeline Editor Container
 *
 * Main container for pipeline configuration. Renders:
 * - Pipeline header (name, status, publish button)
 * - Flows sidebar (25% width)
 * - Flow detail panel (75% width)
 * - Stage configuration slide-over (conditional)
 * - Rule builder slide-over (conditional)
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { Skeleton, SkeletonText } from '../../ui/Skeleton';
import { PipelineHeader } from './PipelineHeader';
import { EmbeddingConfigSection } from './EmbeddingConfigSection';
import { FlowsList } from './FlowsList';
import { FlowDetail } from './FlowDetail';
import { StageConfigPanel } from './StageConfigPanel';
import { RuleBuilderPanel } from './RuleBuilderPanel';
import { TestSelectionModal } from './TestSelectionModal';
import { ReindexConfirmDialog } from './ReindexConfirmDialog';

interface PipelineEditorProps {
  projectId: string;
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
}

export function PipelineEditor({
  projectId,
  knowledgeBaseId,
  knowledgeBaseName,
}: PipelineEditorProps) {
  const t = useTranslations('search_ai.pipeline');
  const {
    draft,
    isLoading,
    error,
    isDirty,
    selectedFlowId,
    stageConfigOpen,
    ruleBuilderOpen,
    testSelectionOpen,
    loadPipeline,
    createPipeline,
    saveDraft,
    reset,
  } = usePipelineStore();

  // Load pipeline on mount
  useEffect(() => {
    loadPipeline(projectId, knowledgeBaseId);
    return () => reset();
  }, [projectId, knowledgeBaseId, loadPipeline, reset]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty) saveDraft();
      }
    },
    [isDirty, saveDraft],
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

  // Loading state — skeleton mimics the real editor layout
  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        {/* Header skeleton */}
        <div className="px-6 py-4 border-b border-default flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
        </div>

        {/* Embedding config skeleton */}
        <div className="px-6 py-3 border-b border-default flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>

        {/* Main content skeleton */}
        <div className="flex flex-1 overflow-hidden">
          {/* Flows sidebar skeleton */}
          <div className="w-1/4 min-w-[240px] max-w-[320px] border-r border-default">
            <div className="px-4 py-3 border-b border-default">
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-3 w-full" />
            </div>
            <div className="p-2 space-y-1">
              {[1, 2, 3].map((i) => (
                <div key={i} className="p-3 rounded-md border border-transparent">
                  <div className="flex items-center justify-between mb-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-8" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Flow detail skeleton */}
          <div className="flex-1 p-6">
            <Skeleton className="h-6 w-48 mb-4" />
            <SkeletonText lines={2} className="mb-6" />
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-4 rounded-lg border border-default bg-background-muted">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-32 mb-1" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-6 w-12 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-foreground font-medium mb-2">{t('editor_load_error')}</p>
          <p className="text-muted text-sm">{error}</p>
          <button
            className="mt-4 px-4 py-2 bg-background-elevated border border-default rounded-md text-sm hover:bg-background-muted"
            onClick={() => loadPipeline(projectId, knowledgeBaseId)}
          >
            {t('editor_retry')}
          </button>
        </div>
      </div>
    );
  }

  // Empty state - no pipeline configured yet
  if (!draft) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <p className="text-foreground font-medium mb-2">{t('editor_no_pipeline')}</p>
          <p className="text-muted text-sm mb-6">{t('editor_no_pipeline_description')}</p>
          <button
            className="px-4 py-2 bg-interactive-enabled text-interactive-foreground rounded-lg hover:bg-interactive-hover transition-colors font-medium"
            onClick={() => createPipeline(projectId, knowledgeBaseId)}
            disabled={isLoading}
          >
            {isLoading ? t('editor_creating') : t('editor_create_pipeline')}
          </button>
        </div>
      </div>
    );
  }

  const selectedFlow = draft.flows.find((f) => f.id === selectedFlowId) ?? null;

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-full">
        {/* Header */}
        <PipelineHeader knowledgeBaseName={knowledgeBaseName} />

        {/* Embedding Configuration */}
        <EmbeddingConfigSection />

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Flows sidebar */}
          <div className="w-1/4 min-w-[240px] max-w-[320px] border-r border-default overflow-y-auto">
            <FlowsList />
          </div>

          {/* Flow detail */}
          <div className="flex-1 overflow-y-auto">
            {selectedFlow ? (
              <FlowDetail flow={selectedFlow} />
            ) : (
              <div className="flex items-center justify-center h-full text-muted">
                {t('editor_select_flow')}
              </div>
            )}
          </div>
        </div>

        {/* Stage configuration slide-over */}
        {stageConfigOpen && <StageConfigPanel />}

        {/* Rule builder slide-over */}
        {ruleBuilderOpen && <RuleBuilderPanel />}

        {/* Test selection modal */}
        {testSelectionOpen && <TestSelectionModal />}

        {/* Reindex confirmation dialog (shown after publish with changes) */}
        <ReindexConfirmDialog />
      </div>
    </ErrorBoundary>
  );
}
