/**
 * PipelinesListPage Component
 *
 * Main page for the Pipelines section. Shows:
 * - Header with title and description
 * - Tab switcher between Builtin, Custom, Recent Runs, and Data tabs
 * - Search input (hidden on runs/data tabs)
 * - Content based on active tab
 *
 * For custom tab: includes a "Create Pipeline" primary action button.
 * For runs/data tabs: hides the primary action and search.
 */

'use client';

import { useMemo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { ListPageShell } from '../ui/ListPageShell';
import { Tabs } from '../ui/Tabs';
import { Button } from '../ui/Button';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { usePipelineListStore, type PipelineListTab } from '../../store/pipeline-list-store';
import { BuiltinPipelinesList } from './BuiltinPipelinesList';
import { CustomPipelinesList } from './CustomPipelinesList';
import { RecentRunsPanel } from './runs/RecentRunsPanel';
import { PipelineDataPanel } from './data/PipelineDataPanel';
import { TemplatePicker } from './TemplatePicker';

export function PipelinesListPage() {
  const t = useTranslations('pipelines');
  const activeTab = usePipelineListStore((s) => s.activeTab);
  const setActiveTab = usePipelineListStore((s) => s.setActiveTab);
  const searchQuery = usePipelineListStore((s) => s.searchQuery);
  const setSearchQuery = usePipelineListStore((s) => s.setSearchQuery);
  const routeProjectId = useNavigationStore((s) => s.projectId);
  const projectId = useProjectStore((s) => s.currentProject?.id) ?? routeProjectId;
  const navigate = useNavigationStore((s) => s.navigate);
  const [isTemplatePicker, setIsTemplatePicker] = useState(false);
  const tabs = useMemo(
    () => [
      { id: 'builtin', label: t('tab_builtin') },
      { id: 'custom', label: t('tab_custom') },
      { id: 'runs', label: t('tab_recent_runs') },
      { id: 'data', label: t('tab_data') },
    ],
    [t],
  );

  const handleTabChange = useCallback(
    (tabId: string) => {
      setActiveTab(tabId as PipelineListTab);
    },
    [setActiveTab],
  );

  const handleCreate = useCallback(() => {
    if (!projectId) return;
    setIsTemplatePicker(true);
  }, [projectId]);

  const showPrimaryAction = activeTab === 'custom';
  // Only show search on builtin/custom tabs
  const showSearch = activeTab === 'builtin' || activeTab === 'custom';

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={t('description')}
        searchPlaceholder={showSearch ? t('search_placeholder') : undefined}
        searchValue={showSearch ? searchQuery : undefined}
        onSearchChange={showSearch ? setSearchQuery : undefined}
        primaryAction={
          showPrimaryAction ? (
            <Button icon={<Plus className="w-4 h-4" />} onClick={handleCreate}>
              {t('create_pipeline')}
            </Button>
          ) : undefined
        }
        className="bg-noise"
      >
        {/* Tabs */}
        <div className="mb-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={handleTabChange}
            layoutId="pipelines-tabs"
          />
        </div>

        {/* Content */}
        {activeTab === 'builtin' && <BuiltinPipelinesList />}
        {activeTab === 'custom' && <CustomPipelinesList onCreatePipeline={handleCreate} />}
        {activeTab === 'runs' && projectId && <RecentRunsPanel projectId={projectId} />}
        {activeTab === 'data' && projectId && <PipelineDataPanel projectId={projectId} />}
      </ListPageShell>

      {projectId && (
        <TemplatePicker
          open={isTemplatePicker}
          onClose={() => setIsTemplatePicker(false)}
          projectId={projectId}
          onNavigate={navigate}
        />
      )}
    </>
  );
}
