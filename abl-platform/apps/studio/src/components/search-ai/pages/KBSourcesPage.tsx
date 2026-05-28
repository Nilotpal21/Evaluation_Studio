'use client';

/**
 * KBSourcesPage
 *
 * Standalone sources page using ListPageShell. Wraps the existing SourcesTable
 * component and adds the AddSourceButton as the primary action.
 * Also mounts the FileUploadDialog at page level for upload flows.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Database } from 'lucide-react';
import { ListPageShell } from '../../ui/ListPageShell';
import { EmptyState } from '../../ui/EmptyState';
import { useKBDetail } from '../context/KBDetailContext';
import { SourcesTable } from '../data/SourcesTable';
import { AddSourceButton } from '../data/AddSourceButton';
import { FileUploadDialog } from '../data/FileUploadDialog';
import { useNavigationStore } from '../../../store/navigation-store';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

export function KBSourcesPage() {
  const t = useTranslations('search_ai.kb_pages');
  const { knowledgeBase, sources, refreshSources } = useKBDetail();
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);

  const indexId = knowledgeBase.searchIndexId ?? '';

  // Upload dialog state
  const [uploadTarget, setUploadTarget] = useState<{
    sourceId: string;
    sourceName: string;
  } | null>(null);

  // Source resume: when user clicks a configuring source card
  const [resumeSourceId, setResumeSourceId] = useState<string | null>(null);

  const handleSourceAdded = useCallback(
    (source?: { _id: string; name: string; sourceType: string }) => {
      refreshSources();
      if (source && (source.sourceType === 'manual' || source.sourceType === 'file')) {
        setUploadTarget({ sourceId: source._id, sourceName: source.name });
      } else if (!source) {
        setUploadTarget({ sourceId: '', sourceName: '' });
      }
    },
    [refreshSources],
  );

  const handleUploadToSource = useCallback((sourceId: string, sourceName: string) => {
    setUploadTarget({ sourceId, sourceName });
  }, []);

  const handleNavigateToSource = useCallback(
    (sourceId: string) => {
      if (!projectId) return;
      navigate(`/projects/${projectId}/search-ai/${knowledgeBase._id}/sources/${sourceId}`);
    },
    [projectId, knowledgeBase._id, navigate],
  );

  const handleViewDocuments = useCallback(
    (sourceId: string, _sourceName: string) => {
      if (!projectId) return;
      const setPendingFilter = useDataTabFilterStore.getState().setPendingFilter;
      setPendingFilter({ view: 'documents', sourceId });
      navigate(`/projects/${projectId}/search-ai/${knowledgeBase._id}/documents`);
    },
    [projectId, knowledgeBase._id, navigate],
  );

  return (
    <ListPageShell
      title={t('sources_title')}
      primaryAction={
        <AddSourceButton
          indexId={indexId}
          onSourceAdded={handleSourceAdded}
          resumeSourceId={resumeSourceId}
          onResumeSourceConsumed={() => setResumeSourceId(null)}
        />
      }
    >
      {sources.length === 0 ? (
        <EmptyState
          icon={<Database className="w-6 h-6" />}
          title={t('sources_empty_title')}
          description={t('sources_empty_description')}
          action={<AddSourceButton indexId={indexId} onSourceAdded={handleSourceAdded} />}
        />
      ) : (
        <SourcesTable
          indexId={indexId}
          sources={sources}
          onRefresh={refreshSources}
          onViewDocuments={handleViewDocuments}
          onUploadToSource={handleUploadToSource}
          onResumeSource={setResumeSourceId}
          onNavigateToSource={handleNavigateToSource}
          knowledgeBase={knowledgeBase}
        />
      )}

      {/* File upload dialog */}
      <FileUploadDialog
        open={!!uploadTarget}
        onClose={() => setUploadTarget(null)}
        indexId={indexId}
        sourceId={uploadTarget?.sourceId}
        sourceName={uploadTarget?.sourceName}
        sources={sources}
        onUploadComplete={() => {
          setUploadTarget(null);
          refreshSources();
        }}
      />
    </ListPageShell>
  );
}
