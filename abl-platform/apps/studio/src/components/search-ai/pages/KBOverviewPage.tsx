'use client';

/**
 * KBOverviewPage
 *
 * Overview dashboard for a knowledge base. Replaces the old HomeSection 3-state
 * machine with a single page that conditionally shows:
 * - SetupGuide (0 documents)
 * - PipelineProgressTracker (creating/indexing/rebuilding/error)
 * - Stats + NeedsAttention + ActivityFeed (normal operations)
 *
 * Uses DetailPageShell with maxWidth="lg" and MetricCard for stats.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Database, FileText, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { isUploadableSource } from '@/lib/upload-constants';
import { DetailPageShell } from '../../ui/DetailPageShell';
import { MetricCard } from '../../ui/MetricCard';
import { Button } from '../../ui/Button';
import { useKBDetail } from '../context/KBDetailContext';
import { SetupGuide } from '../home/SetupGuide';
import { PipelineProgressTracker } from '../home/PipelineProgressTracker';
import { NeedsAttentionCard } from '../home/NeedsAttentionCard';
import { ActivityFeed } from '../home/ActivityFeed';
import { FileUploadDialog } from '../data/FileUploadDialog';
import { addSource } from '../../../api/search-ai';
import { useNavigationStore } from '../../../store/navigation-store';

/** Progress-related statuses that trigger the PipelineProgressTracker display. */
const PROGRESS_STATUSES = new Set(['creating', 'indexing', 'rebuilding', 'error']);

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

export function KBOverviewPage() {
  const t = useTranslations('search_ai.kb_pages');
  const tSetup = useTranslations('search_ai.setup');
  const { knowledgeBase, sources, sourceCount, refreshSources } = useKBDetail();
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);

  const indexId = knowledgeBase.searchIndexId ?? '';
  const index = knowledgeBase.index;

  // Upload dialog state (lifted from SetupGuide pattern in HomeSection)
  const [uploadState, setUploadState] = useState<UploadDialogState>(CLOSED_DIALOG);
  const [creatingSource, setCreatingSource] = useState(false);

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
        toast.error(sanitizeError(err, tSetup('error_create_source')));
      } finally {
        setCreatingSource(false);
      }
    },
    [indexId, sources, tSetup],
  );

  const handleUploadComplete = useCallback(() => {
    setUploadState(CLOSED_DIALOG);
    refreshSources();
  }, [refreshSources]);

  // Determine view state
  const isProgressState = PROGRESS_STATUSES.has(knowledgeBase.status);
  const isSetupState = knowledgeBase.documentCount === 0 && !isProgressState;
  const isOperationsState = !isSetupState && !isProgressState;

  // Stat values
  const sourcesValue = index?.sourceCount ?? sourceCount;
  const documentsValue = index?.documentCount ?? knowledgeBase.documentCount;
  const chunksValue = index?.chunkCount ?? 0;

  // Navigation helper for old-style tab navigation used by sub-components
  const handleNavigate = useCallback(
    (tab: string, subSection?: string) => {
      if (!projectId) return;
      const kbId = knowledgeBase._id;
      const segmentMap: Record<string, string> = {
        data: 'sources',
        intelligence: 'pipeline',
        search: 'search-test',
        settings: 'settings',
      };
      const segment = segmentMap[tab] ?? tab;
      navigate(`/projects/${projectId}/search-ai/${kbId}/${segment}`);
    },
    [projectId, knowledgeBase._id, navigate],
  );

  // Title actions — only show when in operations state
  const actions = useMemo(() => {
    if (!isOperationsState) return undefined;
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          if (projectId) {
            navigate(`/projects/${projectId}/search-ai/${knowledgeBase._id}/sources`);
          }
        }}
      >
        {t('view_all_sources')}
      </Button>
    );
  }, [isOperationsState, projectId, knowledgeBase._id, navigate, t]);

  // Note: Loading and error states are handled by KBDetailProvider.
  // By the time this component renders, knowledgeBase is always available.

  return (
    <DetailPageShell title={knowledgeBase.name} actions={actions} maxWidth="lg">
      {/* Setup Guide — shown when 0 documents */}
      {isSetupState && (
        <SetupGuide
          knowledgeBase={knowledgeBase}
          indexId={indexId}
          sources={sources}
          onRefreshSources={refreshSources}
          onNavigate={handleNavigate}
          onFilesSelected={handleFilesSelected}
          creatingSource={creatingSource}
        />
      )}

      {/* Pipeline Progress — shown during indexing/creating/rebuilding/error */}
      {isProgressState && (
        <PipelineProgressTracker
          knowledgeBase={knowledgeBase}
          indexId={indexId}
          sources={sources}
          onNavigate={handleNavigate}
        />
      )}

      {/* Operations Dashboard — normal state with data */}
      {isOperationsState && (
        <div className="space-y-6">
          {/* Metric Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricCard
              label={t('stat_sources')}
              value={sourcesValue}
              icon={<Database className="w-4 h-4" />}
            />
            <MetricCard
              label={t('stat_documents')}
              value={documentsValue}
              icon={<FileText className="w-4 h-4" />}
            />
            <MetricCard
              label={t('stat_chunks')}
              value={chunksValue}
              icon={<Layers className="w-4 h-4" />}
            />
          </div>

          {/* 2-column grid: Needs Attention + Activity Feed */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <NeedsAttentionCard kbId={knowledgeBase._id} />
            <ActivityFeed kbId={knowledgeBase._id} />
          </div>
        </div>
      )}

      {/* File upload dialog — rendered at page level to survive state transitions */}
      <FileUploadDialog
        open={uploadState.open}
        onClose={handleUploadComplete}
        indexId={indexId}
        sourceId={uploadState.sourceId}
        sourceName={uploadState.sourceName}
        initialFiles={uploadState.initialFiles}
        sources={sources}
      />
    </DetailPageShell>
  );
}
