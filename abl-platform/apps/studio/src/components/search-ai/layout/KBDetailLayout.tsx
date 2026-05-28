/**
 * KBDetailLayout Component
 *
 * Composes KBHeader + KBSectionNav + content area for the knowledge base detail page.
 * Routes section content based on the active tab from navigation store.
 *
 * Sections:
 * - home: Adaptive 3-state (setup / progress / operations)
 * - data: Source filter + document table with pagination
 * - intelligence: Hub + 5 drill-down sub-routes
 * - search: Query playground + diagnostic sidebar
 *
 * Settings panel slides in from right via SlidePanel.
 */

import { useCallback, useEffect, useState, useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';
import { useNavigationStore } from '../../../store/navigation-store';
import { KBHeader } from './KBHeader';
import { KBSectionNav } from './KBSectionNav';
import { HomeSection } from '../home';
import { DataSection } from '../data';
import { IntelligenceSection } from '../intelligence';
import { SearchTestSection } from '../search';
import { SettingsPanel } from '../settings';
import { SharePointDetailPanel } from '../sharepoint/SharePointDetailPanel';
import { TooltipProvider } from '../../ui/Tooltip';
import { useKBShortcuts } from '../hooks/useKBShortcuts';
import { useSearchTabStore } from '../../../store/search-tab-store';
const VALID_SECTIONS = new Set(['home', 'data', 'intelligence', 'search']);
const INDEX_REQUIRED_SECTIONS = new Set(['data', 'intelligence', 'search']);

interface KBDetailLayoutProps {
  knowledgeBase: KnowledgeBaseDetail;
  sources: SearchAISource[];
  isLoading: boolean;
  onRefresh: () => void;
  onRefreshSources: () => void;
}

export function KBDetailLayout({
  knowledgeBase,
  sources,
  isLoading,
  onRefresh,
  onRefreshSources,
}: KBDetailLayoutProps) {
  const projectId = useNavigationStore((s) => s.projectId);
  const kbId = useNavigationStore((s) => s.subPage);
  const tab = useNavigationStore((s) => s.tab);
  const navigate = useNavigationStore((s) => s.navigate);
  const setTab = useNavigationStore((s) => s.setTab);
  const setTabAndSubSection = useNavigationStore((s) => s.setTabAndSubSection);
  const setSubPageLabel = useNavigationStore((s) => s.setSubPageLabel);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handleNavigateToSource = useCallback(
    (sourceId: string) => {
      if (!projectId || !kbId) return;
      navigate(`/projects/${projectId}/search-ai/${kbId}/sources/${sourceId}`);
    },
    [projectId, kbId, navigate],
  );

  const toggleSettings = useCallback(() => setSettingsOpen((prev) => !prev), []);
  useKBShortcuts(toggleSettings);

  const indexId = knowledgeBase.searchIndexId ?? null;
  const activeSection = tab && VALID_SECTIONS.has(tab) ? tab : 'home';

  // Redirect unknown tabs to home via effect (not during render)
  useEffect(() => {
    if (tab && !VALID_SECTIONS.has(tab)) {
      setTab(null);
    }
  }, [tab, setTab]);

  // Reset search tab state when navigating to a different KB
  const resetSearchTab = useSearchTabStore((s) => s.reset);
  const [prevKbId, setPrevKbId] = useState(kbId);
  if (kbId !== prevKbId) {
    setPrevKbId(kbId);
    resetSearchTab();
  }

  useEffect(() => {
    setSubPageLabel(knowledgeBase.name);
    return () => setSubPageLabel(null);
  }, [knowledgeBase.name, setSubPageLabel]);

  // After an upload, sources AND KB documentCount both need refreshing
  const handleRefreshSources = useCallback(() => {
    onRefreshSources();
    onRefresh();
  }, [onRefreshSources, onRefresh]);

  const handleBack = () => {
    navigate(`/projects/${projectId}/search-ai`);
  };

  const handleSectionChange = (section: string) => {
    setTab(section === 'home' ? null : section);
  };

  const handleNavigate = useCallback(
    (targetTab: string, subSection?: string) => {
      if (subSection) {
        setTabAndSubSection(targetTab, subSection);
      } else {
        setTab(targetTab);
      }
    },
    [setTab, setTabAndSubSection],
  );

  const tLayout = useTranslations('search_ai.layout');

  const renderContent = () => {
    // Guard: sections that require an index show a placeholder when indexId is not ready
    if (!indexId && INDEX_REQUIRED_SECTIONS.has(activeSection)) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-background-muted flex items-center justify-center mb-4 text-muted">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h3 className="text-base font-medium text-foreground mb-1">
            {tLayout('index_not_ready_title')}
          </h3>
          <p className="text-sm text-muted max-w-sm">{tLayout('index_not_ready_description')}</p>
        </div>
      );
    }

    switch (activeSection) {
      case 'home':
        return (
          <HomeSection
            knowledgeBase={knowledgeBase}
            indexId={indexId ?? ''}
            sources={sources}
            onRefreshSources={handleRefreshSources}
            onNavigate={handleNavigate}
          />
        );
      case 'data':
        return (
          <DataSection
            indexId={indexId ?? ''}
            sources={sources}
            onRefreshSources={handleRefreshSources}
            onRefreshKnowledgeBase={onRefresh}
            knowledgeBase={knowledgeBase}
            onNavigateToSource={handleNavigateToSource}
          />
        );
      case 'intelligence':
        return (
          <IntelligenceSection
            indexId={indexId ?? ''}
            projectId={projectId ?? ''}
            knowledgeBaseId={kbId ?? ''}
            knowledgeBaseName={knowledgeBase.name}
            sources={sources}
          />
        );
      case 'search':
        return <SearchTestSection indexId={indexId ?? ''} knowledgeBaseId={kbId ?? ''} />;
      default:
        return (
          <HomeSection
            knowledgeBase={knowledgeBase}
            indexId={indexId ?? ''}
            sources={sources}
            onRefreshSources={handleRefreshSources}
            onNavigate={handleNavigate}
          />
        );
    }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <KBHeader
        knowledgeBase={knowledgeBase}
        onBack={handleBack}
        onOpenSettings={() => setSettingsOpen(true)}
        onNavigate={handleNavigate}
      />
      <KBSectionNav activeSection={activeSection} onSectionChange={handleSectionChange} />
      <div className="flex-1 overflow-y-auto px-6 py-6">{renderContent()}</div>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        knowledgeBase={knowledgeBase}
        onRefresh={onRefresh}
      />

      {/* SharePoint connector panel — mounted at layout level so it's accessible from any section (Home, Data, etc.) */}
      {indexId && (
        <TooltipProvider>
          <SharePointDetailPanel indexId={indexId} onRefresh={handleRefreshSources} />
        </TooltipProvider>
      )}
    </div>
  );
}
