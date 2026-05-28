/**
 * HomeSection Component
 *
 * Adaptive home section with 3-state machine:
 * - setup: KB with 0 documents → SetupGuide (inline file drop zone + source cards)
 * - progress: KB is indexing/creating/rebuilding/error → ProgressView
 * - operations: KB with documents → OperationsDashboard
 *
 * The FileUploadDialog is rendered here (not inside SetupGuide)
 * so it survives state transitions. When SetupGuide creates a source and opens
 * the dialog, the home state might change, which would unmount SetupGuide and its dialog.
 * Lifting it here prevents that race condition.
 */

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { isUploadableSource } from '@/lib/upload-constants';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';
import { addSource } from '../../../api/search-ai';
import { SetupGuide } from './SetupGuide';
import { PipelineProgressTracker } from './PipelineProgressTracker';
import { OperationsDashboard } from './OperationsDashboard';
import { FileUploadDialog } from '../data/FileUploadDialog';

type HomeState = 'setup' | 'progress' | 'operations';

interface HomeSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources: SearchAISource[];
  onRefreshSources: () => void;
  onNavigate?: (tab: string, subSection?: string) => void;
}

interface UploadDialogState {
  open: boolean;
  sourceId: string;
  sourceName: string;
  initialFiles: File[];
}

const CLOSED_DIALOG: UploadDialogState = {
  open: false,
  sourceId: '',
  sourceName: '',
  initialFiles: [],
};

function resolveHomeState(kb: KnowledgeBaseDetail, sources: SearchAISource[]): HomeState {
  // Status-based states take priority (creating/indexing/rebuilding/error)
  if (kb.status === 'creating' || kb.status === 'indexing' || kb.status === 'rebuilding')
    return 'progress';
  if (kb.status === 'error') return 'progress';

  // No documents → always show setup guide (whether sources exist or not)
  // If user created a source but didn't upload, show empty state again
  if (kb.documentCount === 0) return 'setup';

  return 'operations';
}

export function HomeSection({
  knowledgeBase,
  indexId,
  sources,
  onRefreshSources,
  onNavigate,
}: HomeSectionProps) {
  const t = useTranslations('search_ai.setup');
  const state = resolveHomeState(knowledgeBase, sources);

  // ── Upload dialog state (lifted from SetupGuide/WaitingForContent) ──────
  const [uploadState, setUploadState] = useState<UploadDialogState>(CLOSED_DIALOG);
  const [creatingSource, setCreatingSource] = useState(false);

  /**
   * Handle files selected from FileDropZone (SetupGuide) or upload button (WaitingForContent).
   * Finds or auto-creates a manual source, then opens the upload dialog.
   */
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const manualSource = sources.find((s) => isUploadableSource(s.sourceType));

      if (manualSource) {
        setUploadState({
          open: true,
          sourceId: manualSource._id,
          sourceName: manualSource.name,
          initialFiles: files,
        });
        return;
      }

      // Auto-create a manual source
      setCreatingSource(true);
      try {
        const { source } = await addSource(indexId, {
          name: 'File Directory',
          sourceType: 'manual',
        });
        setUploadState({
          open: true,
          sourceId: source._id,
          sourceName: source.name,
          initialFiles: files,
        });
      } catch (err: unknown) {
        toast.error(sanitizeError(err, t('error_create_source')));
      } finally {
        setCreatingSource(false);
      }
    },
    [indexId, sources, t],
  );

  /** Open the upload dialog for an existing manual source (no files pre-selected). */
  const handleOpenUpload = useCallback(() => {
    const manualSource = sources.find((s) => isUploadableSource(s.sourceType));
    if (manualSource) {
      setUploadState({
        open: true,
        sourceId: manualSource._id,
        sourceName: manualSource.name,
        initialFiles: [],
      });
    }
  }, [sources]);

  const handleUploadComplete = useCallback(() => {
    setUploadState(CLOSED_DIALOG);
    onRefreshSources();
  }, [onRefreshSources]);

  return (
    <>
      {state === 'setup' && (
        <SetupGuide
          knowledgeBase={knowledgeBase}
          indexId={indexId}
          sources={sources}
          onRefreshSources={onRefreshSources}
          onNavigate={onNavigate}
          onFilesSelected={handleFilesSelected}
          creatingSource={creatingSource}
        />
      )}
      {state === 'progress' && (
        <PipelineProgressTracker
          knowledgeBase={knowledgeBase}
          indexId={indexId}
          sources={sources}
          onNavigate={onNavigate}
        />
      )}
      {state === 'operations' && (
        <OperationsDashboard
          knowledgeBase={knowledgeBase}
          indexId={indexId}
          sources={sources}
          onNavigate={onNavigate}
          onOpenUpload={handleOpenUpload}
          onRefreshSources={onRefreshSources}
        />
      )}

      {/* Upload dialog — rendered at HomeSection level to survive state transitions */}
      <FileUploadDialog
        open={uploadState.open}
        onClose={handleUploadComplete}
        indexId={indexId}
        sourceId={uploadState.sourceId}
        sourceName={uploadState.sourceName}
        initialFiles={uploadState.initialFiles}
        sources={sources}
      />
    </>
  );
}
