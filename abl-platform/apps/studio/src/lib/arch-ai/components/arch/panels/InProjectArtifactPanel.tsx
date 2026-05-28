'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { Pin, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { ArtifactTab, ArtifactTabType } from '@/lib/arch-ai/store/arch-ai-store';
import { JournalPanel } from './JournalPanel';
import { SpecDocumentPanel } from './SpecDocumentPanel';
import { InProjectDiffCard } from './InProjectDiffCard';
import { HealthReportCard } from './HealthReportCard';
import { SearchArtifactPanel } from './SearchArtifactPanel';
import { TopologyGraph } from './TopologyGraph';
import { ArchDSLViewer } from './ArchDSLViewer';
import { IntegrationArtifactView } from './IntegrationArtifactView';
import { PlanPanel } from './PlanPanel';
import { ImpactPanel } from './ImpactPanel';
import type { ModificationProposal, HealthCheckReport } from '@/lib/arch-ai/types/arch';

/** Non-closeable tab types — these are core panel tabs */
const NON_CLOSEABLE_TAB_TYPES: ArtifactTabType[] = [
  'diff',
  'plan',
  'topology',
  'search-ai',
  'health',
  'journal',
  'spec-document',
];

/**
 * Delay before auto-dismissing the diff tab after a terminal status.
 * Gives the user brief visual confirmation before the tab clears.
 */
const DIFF_TAB_AUTO_DISMISS_MS = 2500;

interface InProjectArtifactPanelProps {
  sessionId: string | null;
  projectId?: string;
}

/**
 * InProjectArtifactPanel — tabbed artifact panel for in-project mode.
 * Shows persistent tabs (Changes, Topology, Search AI, Health, Journal) plus
 * dynamic file tabs that are closeable.
 *
 * Diff panel is read-only — confirmation flows through ask_user
 * Confirmation widget in the chat panel, not through buttons here.
 */
export function InProjectArtifactPanel({ sessionId, projectId }: InProjectArtifactPanelProps) {
  const t = useTranslations('arch_in_project');
  const tabs = useArchAIStore((s) => s.artifactTabs);
  const activeTabId = useArchAIStore((s) => s.activeTabId);
  const setActiveTab = useArchAIStore((s) => s.setActiveTab);
  const removeTab = useArchAIStore((s) => s.removeTab);

  // Auto-dismiss rejected proposals after a brief confirmation.
  // Applied proposals are cleared by the event dispatcher together with their approved plan.
  useEffect(() => {
    const diffTab = tabs.find((tab) => tab.type === 'diff');
    if (!diffTab) return;
    const proposal = diffTab.data as ModificationProposal | undefined;
    const status = proposal?.reviewStatus;
    if (status !== 'rejected') return;
    const timerId = window.setTimeout(() => {
      removeTab(diffTab.id);
    }, DIFF_TAB_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timerId);
  }, [tabs, removeTab]);

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(tabId);
      // Clear isNew highlight when user clicks the tab
      const store = useArchAIStore.getState();
      const tab = store.artifactTabs.find((t) => t.id === tabId);
      if (tab?.isNew) {
        useArchAIStore.setState((state) => ({
          artifactTabs: state.artifactTabs.map((t) =>
            t.id === tabId ? { ...t, isNew: false } : t,
          ),
        }));
      }
    },
    [setActiveTab],
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  // Separate core tabs from file tabs — only show tabs that exist in the store
  const coreTabs = tabs.filter((tab) => NON_CLOSEABLE_TAB_TYPES.includes(tab.type));
  const fileTabs = tabs.filter((tab) => !NON_CLOSEABLE_TAB_TYPES.includes(tab.type));

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <svg
          width="28"
          height="28"
          viewBox="0 0 18 18"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-foreground/10"
          aria-hidden="true"
        >
          <path
            d="M9 2L16 16H2L9 2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M6 11.5H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <p className="text-xs text-foreground-subtle">{t('no_data_yet')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="flex-shrink-0 border-b border-border px-2 pt-2">
        <div className="flex gap-1 overflow-x-auto">
          {/* Core tabs (not closeable) — only rendered when they exist in the store */}
          {coreTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              className={clsx(
                'relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 py-2 text-xs font-medium transition-colors',
                activeTab?.id === tab.id
                  ? 'bg-background text-foreground border border-border border-b-background -mb-px'
                  : 'text-foreground-muted hover:text-foreground hover:bg-background-muted/50',
              )}
            >
              {tab.type === 'journal' && (
                <Pin className="h-2.5 w-2.5 opacity-60" aria-hidden="true" />
              )}
              {tab.label}
              {tab.isNew && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" />
              )}
            </button>
          ))}

          {/* Divider between core and file tabs */}
          {fileTabs.length > 0 && <div className="flex-shrink-0 mx-1 my-1.5 w-px bg-border" />}

          {/* File tabs (closeable) */}
          {fileTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              className={clsx(
                'relative flex items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 py-2 text-xs font-medium transition-colors',
                activeTab?.id === tab.id
                  ? 'bg-background text-foreground border border-border border-b-background -mb-px'
                  : 'text-foreground-muted hover:text-foreground hover:bg-background-muted/50',
              )}
            >
              {tab.label}
              {tab.isNew && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent animate-pulse" />
              )}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
                className="ml-1 rounded p-0.5 text-foreground-muted/50 transition-colors hover:bg-background-elevated hover:text-foreground-muted cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab content with fade animation on switch */}
      <AnimatePresence mode="wait">
        {activeTab && (
          <motion.div
            key={activeTab.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex-1 overflow-y-auto"
          >
            <TabContent tab={activeTab} sessionId={sessionId} projectId={projectId} t={t} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Tab Content Renderer ─────────────────────────────────────────────────

function TabContent({
  tab,
  sessionId,
  projectId,
  t,
}: {
  tab: ArtifactTab;
  sessionId: string | null;
  projectId?: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const [diffViewKey, setDiffViewKey] = useState<string | null>(null);

  switch (tab.type) {
    case 'journal':
      return <JournalPanel sessionId={sessionId} projectId={projectId} />;

    case 'spec-document':
      return <SpecDocumentPanel sessionId={sessionId ?? ''} projectId={projectId} />;

    case 'diff': {
      const proposal = tab.data as ModificationProposal | undefined;
      const hasChanges = (proposal?.changes?.length ?? 0) > 0;
      const isBlocked = proposal?.reviewStatus === 'blocked';
      const proposalKey = proposal
        ? `${proposal.agentName}:${proposal.change ?? ''}:${proposal.linesChanged ?? ''}:${proposal.proposedCode?.length ?? ''}`
        : '';
      const shouldShowImpact =
        proposal?.reviewStatus === 'pending' && proposal.impact && diffViewKey !== proposalKey;
      if (!proposal || (!hasChanges && !isBlocked)) {
        return (
          <div className="flex h-full items-center justify-center p-4 text-sm text-foreground-muted">
            {t('no_changes_yet')}
          </div>
        );
      }
      if (shouldShowImpact) {
        return <ImpactPanel proposal={proposal} onViewDiff={() => setDiffViewKey(proposalKey)} />;
      }
      return (
        <div className="flex h-full flex-col overflow-y-auto p-4">
          {proposal.reviewStatus === 'pending' && proposal.impact && (
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setDiffViewKey(null)}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/50 hover:text-foreground"
              >
                Impact
              </button>
            </div>
          )}
          <InProjectDiffCard
            changes={proposal.changes}
            status={proposal.reviewStatus ?? 'pending'}
            validation={proposal.validation}
            projectId={projectId}
            proposal={proposal}
          />
        </div>
      );
    }

    case 'plan':
      return <PlanPanel data={tab.data} />;

    case 'health': {
      const report = tab.data as HealthCheckReport | undefined;
      if (!report?.agents?.length) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
            <svg
              width="28"
              height="28"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-foreground/10"
              aria-hidden="true"
            >
              <path
                d="M9 2L16 16H2L9 2Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M6 11.5H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="text-xs text-foreground-subtle">{t('run_health_check')}</p>
          </div>
        );
      }
      return (
        <div className="h-full overflow-y-auto p-4">
          <HealthReportCard report={report} />
        </div>
      );
    }

    case 'search-ai':
      return <SearchArtifactPanel data={tab.data} emptyMessage={t('no_data_yet')} />;

    case 'integration':
      return <IntegrationArtifactView sessionId={sessionId} projectId={projectId} />;

    case 'topology': {
      if (!tab.data) {
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
            <svg
              width="28"
              height="28"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-foreground/10"
              aria-hidden="true"
            >
              <path
                d="M9 2L16 16H2L9 2Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M6 11.5H12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="text-xs text-foreground-subtle">{t('topology_no_data')}</p>
          </div>
        );
      }
      // Map in-project topology data to the onboarding TopologyGraph shape
      const topoData = tab.data as {
        agents: Array<{
          name: string;
          description?: string | null;
          mode?: string;
          isEntryPoint?: boolean;
        }>;
        edges: Array<{ from: string; to: string; type: string }>;
      };
      const topoAgents = (topoData.agents ?? []).map((a) => ({
        name: a.name,
        role: a.description ?? '',
        executionMode: a.mode ?? 'reasoning',
      }));
      const topoEdges = (topoData.edges ?? []).map((e) => ({
        from: e.from,
        to: e.to,
        type: e.type,
        condition: '',
      }));
      const topoEntry =
        topoData.agents?.find((a) => a.isEntryPoint)?.name ?? topoAgents[0]?.name ?? '';
      return <TopologyGraph agents={topoAgents} edges={topoEdges} entryPoint={topoEntry} />;
    }

    default: {
      // File tabs — render via Monaco ABL viewer
      const fileData = tab.data as { content?: string } | undefined;
      const content = fileData?.content ?? JSON.stringify(tab.data, null, 2);
      return <ArchDSLViewer content={content} fileName={tab.label} />;
    }
  }
}
