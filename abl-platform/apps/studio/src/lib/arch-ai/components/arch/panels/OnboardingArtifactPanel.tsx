'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import {
  MessageSquare,
  LayoutTemplate,
  Rocket,
  FileText,
  Network,
  BookOpen,
  Sparkles,
  FileCode,
  CheckCircle2,
  CircleDashed,
  Download,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { ArtifactTab, ArtifactTabType } from '@/lib/arch-ai/store/arch-ai-store';
import type {
  BlueprintDocumentArtifact,
  BlueprintDocumentTopologyAgent,
} from '@/lib/arch-ai/blueprint-document';
import { ArchMarkdown } from '@/lib/arch-ai/components/arch/chat/ArchMarkdown';

import { TopologyGraph } from './TopologyGraph';
import { JournalPanel } from './JournalPanel';
import { SpecDocumentPanel } from './SpecDocumentPanel';
import { ArchDSLViewer } from './ArchDSLViewer';

/** Artifact tabs that persist across phases — not closeable */
const ARTIFACT_TAB_TYPES: ArtifactTabType[] = [
  'spec-document',
  'blueprint-document',
  'topology',
  'journal',
  'summary',
];

/** Icons for each artifact tab type */
const TAB_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'spec-document': FileText,
  'blueprint-document': FileText,
  topology: Network,
  journal: BookOpen,
  summary: Sparkles,
};

/** Display labels for artifact tab types */
const TAB_LABELS: Record<string, string> = {
  'spec-document': 'Spec',
  'blueprint-document': 'Blueprint',
  topology: 'Topology',
  journal: 'Journal',
  summary: 'Summary',
};

interface OnboardingArtifactPanelProps {
  session: {
    id: string;
    metadata: Record<string, unknown>;
  } | null;
  onSpecUpdate: (field: string, value: unknown) => void;
  phase?: string | null;
  disabled?: boolean;
  /** When true, always render the empty state regardless of loaded tabs. */
  forceEmpty?: boolean;
  /** Optimistic spec values applied after the user picks a project name from the AI widget. */
  specOverride?: { projectName?: string; description?: string } | null;
}

const EMPTY_STATE_STEPS: Array<{
  Icon: ComponentType<{ className?: string }>;
  number: string;
  title: string;
  subtitle: string;
}> = [
  {
    Icon: MessageSquare,
    number: '1',
    title: 'Describe',
    subtitle: 'Tell me about your project in plain language',
  },
  {
    Icon: LayoutTemplate,
    number: '2',
    title: 'Design',
    subtitle: "I'll create the agent architecture and code",
  },
  {
    Icon: Rocket,
    number: '3',
    title: 'Deploy',
    subtitle: 'Launch your agents as a working project',
  },
];

/**
 * OnboardingArtifactPanel — sidebar nav layout.
 * Left sidebar with progressive nav items; content area on the right.
 * Items appear as data arrives: Spec always first, Blueprint/Topology when ready,
 * Agent files during BUILD, Summary at CREATE. Journal pinned at bottom.
 */
export function OnboardingArtifactPanel({
  session,
  onSpecUpdate,
  phase,
  disabled = false,
  forceEmpty = false,
  specOverride,
}: OnboardingArtifactPanelProps) {
  const tabs = useArchAIStore((s) => s.artifactTabs);
  const activeTabId = useArchAIStore((s) => s.activeTabId);
  const setActiveTab = useArchAIStore((s) => s.setActiveTab);
  const removeTab = useArchAIStore((s) => s.removeTab);
  const prevTabCount = useRef(tabs.length);

  // Track which tabs the user has viewed (for highlight dots / "New" badges)
  const [viewedTabIds, setViewedTabIds] = useState<Set<string>>(new Set());

  // Track version sum to detect tab updates (not just additions)
  const prevVersionSum = useRef(0);
  const initializedRef = useRef(false);
  const focusedPhaseRef = useRef<string | null>(null);

  // Auto-switch to newest tab when one is added (skip initial batch)
  useEffect(() => {
    const versionSum = tabs.reduce((sum, t) => sum + t.version, 0);

    if (!initializedRef.current) {
      // Skip auto-switch on initial mount — page.tsx sets the default tab
      if (tabs.length > 0) initializedRef.current = true;
    } else if (tabs.length > prevTabCount.current && tabs.length > 0) {
      // New tab added after init — auto-switch for artifact tabs only.
      // File tabs (agent_code) don't steal focus — they show a "New" badge.
      // Don't auto-switch to journal — keep specification visible when it exists.
      const newTab = tabs[tabs.length - 1];
      if (ARTIFACT_TAB_TYPES.includes(newTab.type) && newTab.type !== 'journal') {
        setActiveTab(newTab.id);
      }
    } else if (versionSum > prevVersionSum.current && tabs.length > 0) {
      // Existing tab updated — find the changed tab and clear its viewed state
      const changedTab = tabs.find((t) => !ARTIFACT_TAB_TYPES.includes(t.type) && t.version > 1);
      if (changedTab) {
        setViewedTabIds((prev) => {
          const next = new Set(prev);
          next.delete(changedTab.id);
          return next;
        });
      }
    }

    prevTabCount.current = tabs.length;
    prevVersionSum.current = versionSum;
  }, [tabs, setActiveTab]);

  const handleNavClick = useCallback(
    (tabId: string) => {
      setActiveTab(tabId);
      setViewedTabIds((prev) => new Set(prev).add(tabId));
    },
    [setActiveTab],
  );

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  // Separate artifact tabs from file tabs
  const artifactTabs = tabs
    .filter((t) => ARTIFACT_TAB_TYPES.includes(t.type))
    .sort((a, b) => ARTIFACT_TAB_TYPES.indexOf(a.type) - ARTIFACT_TAB_TYPES.indexOf(b.type));
  const fileTabs = tabs.filter((t) => !ARTIFACT_TAB_TYPES.includes(t.type));

  // Split artifact tabs: journal pinned at top of sidebar, rest below
  const journalTab = artifactTabs.find((t) => t.type === 'journal');
  const topNavTabs = artifactTabs.filter((t) => t.type !== 'journal');

  useEffect(() => {
    if (phase !== 'INTERVIEW') return;
    if (focusedPhaseRef.current === phase) return;
    const specTab = tabs.find((tab) => tab.type === 'spec-document');
    if (specTab && activeTabId !== specTab.id) {
      setActiveTab(specTab.id);
    }
    if (specTab) {
      focusedPhaseRef.current = phase;
    }
  }, [activeTabId, phase, setActiveTab, tabs]);

  return (
    <div className="relative flex h-full overflow-hidden bg-background">
      <AnimatePresence mode="wait" initial={false}>
        {tabs.length === 0 || forceEmpty ? (
          /* ── Empty state with animated 3-step onboarding flow ── */
          <motion.div
            key="empty"
            className="relative flex flex-1 flex-col items-center justify-center overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Dot grid background */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle, hsl(var(--foreground) / 0.06) 1px, transparent 1px), radial-gradient(circle, hsl(var(--foreground) / 0.06) 1px, transparent 1px)',
                backgroundSize: '16px 16px',
                backgroundPosition: '0 0, 8px 8px',
              }}
            />
            <div className="relative flex flex-col items-center gap-0">
              {EMPTY_STATE_STEPS.map((step, idx) => (
                <div key={step.number} className="flex flex-col items-center">
                  {idx > 0 && <div className="my-3 h-5 w-px bg-border/50" />}
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, delay: idx * 0.1 }}
                    className="flex flex-col items-center gap-1"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/60 bg-background-elevated">
                      <step.Icon className="h-3.5 w-3.5 text-foreground-muted" />
                    </div>
                    <span className="mt-1 text-sm font-semibold text-foreground">{step.title}</span>
                    <span className="max-w-[160px] text-center text-xs text-foreground-muted">
                      {step.subtitle}
                    </span>
                  </motion.div>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          /* ── Sidebar nav + content area ── */
          <motion.div
            key="nav-content"
            className="flex flex-1 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Left sidebar nav (176px) */}
            <nav className="flex w-[176px] flex-shrink-0 flex-col border-r border-border/40 bg-background-elevated">
              {/* Sidebar header */}
              <div className="flex-shrink-0 border-b border-border/40 px-4 py-3">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-foreground-subtle">
                  Navigation
                </p>
              </div>

              {/* Nav items */}
              <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
                {/* Journal — pinned at top */}
                {journalTab && (
                  <NavItem
                    icon={<BookOpen className="h-3.5 w-3.5 shrink-0" />}
                    label="Journal"
                    isActive={activeTab?.id === journalTab.id}
                    onClick={() => handleNavClick(journalTab.id)}
                  />
                )}

                {/* Spec, blueprint, topology, summary */}
                {topNavTabs.map((tab) => {
                  const isActive = activeTab?.id === tab.id;
                  const Icon = TAB_ICONS[tab.type] ?? FileText;
                  return (
                    <NavItem
                      key={tab.id}
                      icon={<Icon className="h-3.5 w-3.5 shrink-0" />}
                      label={TAB_LABELS[tab.type] ?? tab.label}
                      isActive={isActive}
                      onClick={() => handleNavClick(tab.id)}
                    />
                  );
                })}

                {/* Agent files — appear during BUILD with "New" badge and compile status dots */}
                {fileTabs.length > 0 && (
                  <>
                    <div className="mx-1 my-2 h-px bg-border/40" />
                    <p className="mb-1 px-2 text-[9px] font-semibold uppercase tracking-widest text-foreground-subtle">
                      Agents
                    </p>
                    {fileTabs.map((tab) => {
                      const isActive = activeTab?.id === tab.id;
                      const isNew = !viewedTabIds.has(tab.id) && !isActive;
                      const fileData = tab.data as { compileStatus?: string } | undefined;
                      return (
                        <NavItem
                          key={tab.id}
                          icon={<FileCode className="h-3.5 w-3.5 shrink-0" />}
                          label={tab.label}
                          isActive={isActive}
                          onClick={() => handleNavClick(tab.id)}
                          suffix={
                            isNew ? (
                              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
                            ) : (
                              <FileStatusDot status={fileData?.compileStatus} />
                            )
                          }
                        />
                      );
                    })}
                  </>
                )}
              </div>
            </nav>

            {/* Content area */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {activeTab?.type === 'agent_code' ? (
                /* Agent file: dot-grid + white card, Monaco needs overflow-hidden h-full chain */
                <div
                  className="flex-1 overflow-hidden p-5"
                  style={{
                    backgroundColor: 'hsl(var(--background-subtle))',
                    backgroundImage:
                      'radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px), radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px)',
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 8px 8px',
                  }}
                >
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={activeTab.id}
                      className="flex h-full flex-col overflow-hidden rounded-xl border border-border/40 bg-background-elevated shadow-sm"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.12 }}
                    >
                      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/40 px-5 py-3">
                        <FileCode className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />
                        <h2 className="flex-1 text-sm font-semibold text-foreground">
                          {activeTab.label}
                        </h2>
                        <button
                          onClick={() => {
                            removeTab(activeTab.id);
                            const returnTab = topNavTabs[0] ?? journalTab ?? null;
                            if (returnTab) setActiveTab(returnTab.id);
                          }}
                          className="text-xs text-foreground-muted/70 transition-colors hover:text-destructive"
                        >
                          Discard
                        </button>
                        <button
                          onClick={() => {
                            const returnTab = topNavTabs[0] ?? journalTab ?? null;
                            if (returnTab) setActiveTab(returnTab.id);
                          }}
                          className="rounded-md bg-foreground/5 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-foreground/10"
                        >
                          Keep
                        </button>
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <TabContent
                          tab={activeTab}
                          session={session}
                          onSpecUpdate={onSpecUpdate}
                          specOverride={specOverride}
                          phase={phase}
                        />
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              ) : (
                /* Other tabs: dot-grid bg with full-height white card + internal scroll */
                <div
                  className="flex-1 overflow-hidden p-5"
                  style={{
                    backgroundColor: 'hsl(var(--background-subtle))',
                    backgroundImage:
                      'radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px), radial-gradient(circle, hsl(var(--foreground) / 0.07) 1px, transparent 1px)',
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 8px 8px',
                  }}
                >
                  <AnimatePresence mode="wait">
                    {activeTab && (
                      <motion.div
                        key={activeTab.id}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.12 }}
                        className="flex h-full flex-col overflow-hidden rounded-xl border border-border/40 bg-background-elevated shadow-sm"
                      >
                        {/* Card title bar */}
                        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/40 px-5 py-3">
                          {(() => {
                            const Icon = TAB_ICONS[activeTab.type] ?? FileText;
                            return <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-muted" />;
                          })()}
                          <h2 className="flex-1 text-sm font-semibold text-foreground">
                            {TAB_LABELS[activeTab.type] ?? activeTab.label}
                          </h2>
                          {activeTab.type === 'blueprint-document' ? (
                            <BlueprintHeaderStatus tab={activeTab} />
                          ) : null}
                          {activeTab.type === 'topology' ? (
                            <TopologyHeaderStatus tab={activeTab} />
                          ) : null}
                        </div>
                        {/* Card body — scrolls internally */}
                        <div className="flex-1 overflow-y-auto">
                          <TabContent
                            tab={activeTab}
                            session={session}
                            onSpecUpdate={onSpecUpdate}
                            specOverride={specOverride}
                            phase={phase}
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Nav Item ─────────────────────────────────────────────────────────────

function NavItem({
  icon,
  label,
  isActive,
  onClick,
  suffix,
}: {
  icon: ReactNode;
  label: string;
  isActive: boolean;
  onClick: () => void;
  suffix?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
        isActive
          ? 'bg-accent/10 text-accent'
          : 'text-foreground-muted hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {suffix}
    </button>
  );
}

// ─── File Status Dot ──────────────────────────────────────────────────────

function FileStatusDot({ status, className }: { status?: string; className?: string }) {
  const base = clsx('h-1.5 w-1.5 rounded-full flex-shrink-0', className);
  if (status === 'success') return <span className={clsx(base, 'bg-success')} />;
  if (status === 'warning') return <span className={clsx(base, 'bg-warning')} />;
  if (status === 'error') return <span className={clsx(base, 'bg-error')} />;
  if (status === 'compiling') return <span className={clsx(base, 'bg-accent animate-pulse')} />;
  if (status === 'fixing') return <span className={clsx(base, 'bg-warning animate-pulse')} />;
  return null;
}

// ─── Topology Skeleton Loader ────────────────────────────────────────────

function TopologySkeletonLoader({ stage }: { stage?: string }) {
  const title =
    stage === 'concept_ready'
      ? 'Blueprint concept ready'
      : stage === 'revising'
        ? 'Revising blueprint'
        : 'Designing architecture';
  const subtitle =
    stage === 'concept_ready'
      ? 'Refine the architecture in chat, then generate a draft blueprint when you are ready.'
      : stage === 'revising'
        ? 'Updating the draft blueprint with your latest design changes...'
        : 'Analyzing your spec and building the agent topology...';
  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      {/* Animated topology wireframe */}
      <div className="relative mb-6">
        <svg width="240" height="160" viewBox="0 0 240 160" className="animate-pulse-soft">
          {/* Entry node (top) */}
          <rect
            x="80"
            y="10"
            width="80"
            height="36"
            rx="8"
            className="fill-accent/10 stroke-accent/30 stroke-[1.5]"
          />
          <rect x="100" y="22" width="40" height="4" rx="2" className="fill-accent/20" />
          <circle cx="120" cy="36" r="2" className="fill-accent/30 animate-ping" />

          {/* Edges to children */}
          <line
            x1="100"
            y1="46"
            x2="50"
            y2="80"
            className="stroke-foreground/10 stroke-[1.5]"
            strokeDasharray="4 4"
          />
          <line
            x1="140"
            y1="46"
            x2="190"
            y2="80"
            className="stroke-foreground/10 stroke-[1.5]"
            strokeDasharray="4 4"
          />

          {/* Left child */}
          <rect
            x="10"
            y="80"
            width="80"
            height="36"
            rx="8"
            className="fill-foreground/5 stroke-foreground/10 stroke-1"
          />
          <rect x="26" y="92" width="48" height="4" rx="2" className="fill-foreground/8" />

          {/* Right child */}
          <rect
            x="150"
            y="80"
            width="80"
            height="36"
            rx="8"
            className="fill-foreground/5 stroke-foreground/10 stroke-1"
          />
          <rect x="166" y="92" width="48" height="4" rx="2" className="fill-foreground/8" />

          {/* Edge from left child down */}
          <line
            x1="50"
            y1="116"
            x2="120"
            y2="140"
            className="stroke-foreground/10 stroke-[1.5]"
            strokeDasharray="4 4"
          />
          <line
            x1="190"
            y1="116"
            x2="120"
            y2="140"
            className="stroke-foreground/10 stroke-[1.5]"
            strokeDasharray="4 4"
          />

          {/* Bottom node */}
          <rect
            x="80"
            y="134"
            width="80"
            height="20"
            rx="6"
            className="fill-foreground/5 stroke-foreground/10 stroke-1"
          />
        </svg>

        {/* Rotating accent ring behind the wireframe */}
        <div
          className="absolute inset-0 -m-4 rounded-full border-2 border-dashed border-accent/10 animate-spin"
          style={{ animationDuration: '8s' }}
        />
      </div>

      <div className="text-center space-y-1.5">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-foreground-muted">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <p className="max-w-md text-center text-sm text-foreground-muted">{message}</p>
    </div>
  );
}

// ─── Tab Content Renderer ─────────────────────────────────────────────────

function TabContent({
  tab,
  session,
  onSpecUpdate,
  specOverride,
  phase,
}: {
  tab: ArtifactTab;
  session: { id: string; metadata: Record<string, unknown> } | null;
  onSpecUpdate: (field: string, value: unknown) => void;
  specOverride?: { projectName?: string; description?: string } | null;
  phase?: string | null;
}) {
  switch (tab.type) {
    case 'spec-document':
      return session ? (
        <SpecDocumentPanel
          sessionId={session.id}
          disabled={true}
          specFallback={
            (session.metadata.specification as Record<string, unknown> | undefined) ?? undefined
          }
          specOverride={specOverride}
        />
      ) : (
        <EmptyState message="Your project details will appear here as we chat" />
      );

    case 'topology': {
      const data = tab.data as Record<string, unknown>;
      const hasAgents = Array.isArray(data?.agents) && data.agents.length > 0;
      return hasAgents ? (
        <TopologyTabContent data={data} />
      ) : (
        <TopologySkeletonLoader stage={typeof data?.stage === 'string' ? data.stage : undefined} />
      );
    }

    case 'blueprint-document':
      return <BlueprintDocumentTabContent data={tab.data as BlueprintDocumentArtifact} />;

    case 'summary':
      return <SummaryTabContent data={tab.data as Record<string, unknown>} />;

    case 'journal':
      return session ? (
        <JournalPanel sessionId={session.id} />
      ) : (
        <EmptyState message="All design decisions are recorded here" />
      );

    case 'agent_code': {
      const fileData = tab.data as { name: string; content: string; isMock?: boolean };
      return <FileTabContent data={fileData} />;
    }

    default:
      return <div className="p-4 text-sm text-foreground-muted">{tab.label}</div>;
  }
}

function BlueprintHeaderStatus({ tab }: { tab: ArtifactTab }) {
  const data = tab.data as BlueprintDocumentArtifact | undefined;
  if (!data) return null;
  return (
    <span className="text-xs text-foreground-muted">
      {data.sectionCount} sections · {data.agentCount} agents · {data.status}
    </span>
  );
}

function BlueprintDocumentTabContent({ data }: { data: BlueprintDocumentArtifact }) {
  const markdown = data.markdown || '# Blueprint\n\nNo blueprint content is available yet.\n';
  const isDrafting = data.status === 'concept' || data.stage === 'revising';
  const document = parseBlueprintMarkdown(markdown);
  const openItems = document.sections
    .filter((section) => section.state === 'pending')
    .map(toBlueprintOpenItem);
  const readySections = document.sections.filter((section) => section.state === 'ready');

  if (document.sections.length === 0) {
    return (
      <div className="mx-auto max-w-5xl px-7 py-6">
        {isDrafting ? <BlueprintDraftingStatus data={data} /> : null}
        <ArchMarkdown
          content={markdown}
          className="text-[14px] leading-6 [&_h1]:mb-2 [&_h2]:mt-8 [&_h2]:border-t [&_h2]:border-border/60 [&_h2]:pt-5 [&_table]:text-xs"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-7 py-6">
      {isDrafting ? <BlueprintDraftingStatus data={data} /> : null}
      <BlueprintChunkOverview data={data} document={document} openItemCount={openItems.length} />
      <BlueprintSourceCoverage data={data} />
      <BlueprintAgentDetails data={data} />
      <BlueprintVisualPlan data={data} />
      <BlueprintMarkdownDocument sections={readySections} />
      {openItems.length > 0 ? <BlueprintOpenItems items={openItems} /> : null}
    </div>
  );
}

interface BlueprintMarkdownSection {
  id: string;
  number: number;
  title: string;
  content: string;
  state: 'ready' | 'pending';
}

interface BlueprintOpenItem {
  id: string;
  title: string;
  reason: string;
  sectionTitle: string;
}

interface ParsedBlueprintMarkdown {
  title: string;
  statusLine: string | null;
  sections: BlueprintMarkdownSection[];
}

function parseBlueprintMarkdown(markdown: string): ParsedBlueprintMarkdown {
  const lines = markdown.split('\n');
  const title =
    lines
      .find((line) => line.startsWith('# '))
      ?.replace(/^#\s+/, '')
      .trim() || 'Blueprint';
  const statusLine =
    lines.find((line) => line.toLowerCase().startsWith('status:'))?.replace(/^status:\s*/i, '') ??
    null;
  const sections: BlueprintMarkdownSection[] = [];
  let current: {
    number: number;
    title: string;
    lines: string[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    const content = current.lines.join('\n').trim();
    const id = `blueprint-section-${current.number}`;
    sections.push({
      id,
      number: current.number,
      title: current.title,
      content,
      state: isBlueprintSectionPending(content) ? 'pending' : 'ready',
    });
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(\d+)\.\s+(.+)$/);
    if (match) {
      flush();
      current = {
        number: Number(match[1]),
        title: match[2]?.trim() ?? `Section ${match[1]}`,
        lines: [],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }

  flush();
  return { title, statusLine, sections };
}

function isBlueprintSectionPending(content: string): boolean {
  const normalized = content.toLowerCase();
  return [
    'not captured',
    'pending',
    'to be decided',
    'will appear',
    'has not been captured',
    'no project tools',
    'no knowledge sources',
    'no agent topology',
  ].some((marker) => normalized.includes(marker));
}

function toBlueprintOpenItem(section: BlueprintMarkdownSection): BlueprintOpenItem {
  return {
    id: `${section.id}-open-item`,
    title: getBlueprintOpenItemTitle(section.title),
    reason: getBlueprintOpenItemReason(section),
    sectionTitle: section.title,
  };
}

function getBlueprintOpenItemTitle(sectionTitle: string): string {
  const normalized = sectionTitle.toLowerCase();
  if (normalized.includes('tools')) return 'Confirm required tools and integrations';
  if (normalized.includes('knowledge')) return 'Attach policy, help, or source-of-truth content';
  if (normalized.includes('memory')) return 'Confirm what session context should be retained';
  if (normalized.includes('guardrails')) return 'Confirm safety and compliance boundaries';
  if (normalized.includes('error')) return 'Confirm fallback and failure behavior';
  if (normalized.includes('eval')) return 'Confirm launch-quality test scenarios';
  if (normalized.includes('decision')) return 'Confirm routing and condition logic';
  return `Complete ${sectionTitle}`;
}

function getBlueprintOpenItemReason(section: BlueprintMarkdownSection): string {
  const content = section.content.toLowerCase();
  if (content.includes('not captured')) {
    return 'The interview has not captured enough project-specific detail for this section yet.';
  }
  if (content.includes('pending') || content.includes('will appear')) {
    return 'This section depends on the generated topology or build details before it can be specific.';
  }
  if (content.includes('no project tools')) {
    return 'No concrete system action or lookup dependency has been identified for the blueprint yet.';
  }
  return 'The blueprint intentionally keeps this item open instead of filling it with generic text.';
}

function buildMermaidGraph(data: BlueprintDocumentArtifact): string {
  const topology = data.topology;
  const edges = topology?.edges ?? [];
  const agents = topology?.agents ?? [];
  const lines = ['flowchart TD'];

  if (edges.length > 0) {
    for (const edge of edges) {
      const from = sanitizeMermaidId(edge.from || 'Unknown');
      const to = sanitizeMermaidId(edge.to || 'Unknown');
      const label = edge.type ? `|${edge.type}|` : '';
      lines.push(
        `  ${from}["${escapeMermaidLabel(edge.from || 'Unknown')}"] -->${label} ${to}["${escapeMermaidLabel(edge.to || 'Unknown')}"]`,
      );
    }
  } else if (agents.length > 0) {
    for (const agent of agents) {
      const id = sanitizeMermaidId(agent.name);
      lines.push(`  ${id}["${escapeMermaidLabel(agent.name)}"]`);
    }
  } else {
    lines.push('  Pending["Topology pending"]');
  }

  return lines.join('\n');
}

function sanitizeMermaidId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return cleaned.length > 0 ? cleaned : 'Node';
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}

function buildBlueprintExportMarkdown(
  data: BlueprintDocumentArtifact,
  document: ParsedBlueprintMarkdown,
): string {
  const openItems = document.sections
    .filter((section) => section.state === 'pending')
    .map(toBlueprintOpenItem);
  const sections = document.sections.filter((section) => section.state === 'ready');

  const lines: string[] = [
    `# ${document.title}`,
    '',
    `Status: ${document.statusLine ?? data.status}`,
    `Agents: ${data.agentCount}`,
    `Handoffs: ${data.handoffCount}`,
    '',
    '## Architecture Map',
    '',
    '```mermaid',
    buildMermaidGraph(data),
    '```',
    '',
  ];

  if (openItems.length > 0) {
    lines.push('## Open Items', '');
    for (const item of openItems) {
      lines.push(`- **${item.title}** (${item.sectionTitle}): ${item.reason}`);
    }
    lines.push('');
  }

  for (const section of sections) {
    lines.push(`## ${section.number}. ${section.title}`, '', section.content, '');
  }

  return `${lines.join('\n').trim()}\n`;
}

function downloadTextFile(fileName: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function BlueprintSourceCoverage({ data }: { data: BlueprintDocumentArtifact }) {
  const contract = data.sourceArchitectureContract;
  if (!contract || contract.declaredAgents.length === 0) {
    return null;
  }

  const topologyNames = new Set((data.topology?.agents ?? []).map((agent) => agent.name));
  const captured = contract.declaredAgents.filter((agent) => topologyNames.has(agent.name));
  const missing = contract.declaredAgents.filter((agent) => !topologyNames.has(agent.name));
  const toolCount = contract.tools.length;

  return (
    <section className="rounded-lg border border-border/50 bg-background-elevated/70 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Source coverage</h4>
          <p className="mt-1 text-xs text-foreground-muted">
            Architecture details extracted from uploaded documents and enforced during blueprint
            generation.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <span className="rounded-full border border-border/60 bg-background px-2 py-0.5 font-medium text-foreground-muted">
            {captured.length}/{contract.declaredAgents.length} agents captured
          </span>
          <span className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-foreground-muted">
            {toolCount} tool{toolCount === 1 ? '' : 's'}
          </span>
          {contract.entryAgent ? (
            <span className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-foreground-muted">
              entry: {contract.entryAgent}
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-border/40 bg-background/70 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
            Declared agents
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {contract.declaredAgents.map((agent) => (
              <span
                key={agent.name}
                className={clsx(
                  'rounded-full border px-1.5 py-0.5 text-[10px]',
                  topologyNames.has(agent.name)
                    ? 'border-border/60 bg-background text-foreground-muted'
                    : 'border-warning/30 bg-warning/5 text-warning',
                )}
              >
                {agent.name}
              </span>
            ))}
          </div>
          {missing.length > 0 ? (
            <p className="mt-2 text-xs text-warning">
              Missing from draft: {missing.map((agent) => agent.name).join(', ')}
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-border/40 bg-background/70 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
            Source details
          </p>
          <ul className="mt-2 space-y-1 text-xs text-foreground-muted">
            <li>Files: {contract.sourceFiles.join(', ') || 'uploaded document'}</li>
            <li>
              Shared memory:{' '}
              {contract.sharedMemoryVariables.length > 0
                ? contract.sharedMemoryVariables.join(', ')
                : 'none declared'}
            </li>
            <li>
              MCP/tools:{' '}
              {contract.requiredMcpServers.length > 0
                ? contract.requiredMcpServers.join(', ')
                : 'not declared'}
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function BlueprintChunkOverview({
  data,
  document,
  openItemCount,
}: {
  data: BlueprintDocumentArtifact;
  document: ParsedBlueprintMarkdown;
  openItemCount: number;
}) {
  const readyCount = document.sections.filter((section) => section.state === 'ready').length;
  const exportBaseName = document.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (
    <div className="rounded-lg border border-border/50 bg-background-elevated/80 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-foreground-subtle">
            Blueprint artifact
          </p>
          <h3 className="mt-1 text-lg font-semibold text-foreground">{document.title}</h3>
          <p className="mt-1 text-sm text-foreground-muted">
            Reviewable chunks for this session. Details update as the agent design changes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-foreground-muted">
            {readyCount}/{document.sections.length} sections populated
          </span>
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-foreground-muted">
            {openItemCount} open items
          </span>
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-foreground-muted">
            {data.agentCount} agents
          </span>
          <span className="rounded-full border border-border/60 px-2.5 py-1 text-foreground-muted">
            {data.handoffCount} handoffs
          </span>
          <span className="rounded-full border border-accent/25 bg-accent/5 px-2.5 py-1 font-medium text-accent">
            {document.statusLine ?? data.status}
          </span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            downloadTextFile(
              `${exportBaseName || 'blueprint'}.md`,
              buildBlueprintExportMarkdown(data, document),
              'text/markdown;charset=utf-8',
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/40 hover:text-accent"
        >
          <Download className="h-3.5 w-3.5" />
          Markdown
        </button>
        <button
          type="button"
          onClick={() =>
            downloadTextFile(
              `${exportBaseName || 'blueprint'}.json`,
              JSON.stringify({ document, artifact: data }, null, 2),
              'application/json;charset=utf-8',
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:border-accent/40 hover:text-accent"
        >
          <Download className="h-3.5 w-3.5" />
          JSON
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {document.sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={clsx(
              'group flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors',
              section.state === 'ready'
                ? 'border-border/60 bg-background hover:border-success/30'
                : 'border-border/40 bg-background-muted/20 hover:border-accent/25',
            )}
          >
            {section.state === 'ready' ? (
              <CheckCircle2 className="h-3 w-3 shrink-0 text-success/80" />
            ) : (
              <CircleDashed className="h-3 w-3 shrink-0 text-foreground-subtle" />
            )}
            <span className="min-w-0 truncate text-[11px] leading-4">
              <span className="mr-1 font-mono text-[10px] text-foreground-subtle">
                {section.number}
              </span>
              <span className="font-medium text-foreground-muted group-hover:text-foreground">
                {section.title}
              </span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function BlueprintAgentDetails({ data }: { data: BlueprintDocumentArtifact }) {
  const topology = data.topology;
  const agents = topology?.agents ?? [];

  if (agents.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-border/50 bg-background-elevated px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Agent details</h4>
          <p className="mt-1 text-xs text-foreground-muted">
            Runtime shape, responsibilities, inputs, and tool intent for each generated agent.
          </p>
        </div>
        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs text-foreground-muted">
          {agents.length} agent{agents.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <article
            key={agent.name}
            className="rounded-md border border-border/60 bg-background-muted/30 px-3 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h5 className="break-words text-sm font-semibold text-foreground">{agent.name}</h5>
                <p className="mt-1 text-xs text-foreground-muted">
                  {agent.role || agent.executionMode || 'Agent'}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-accent/5 px-2 py-0.5 text-[10px] font-medium text-accent">
                {agent.executionMode || 'reasoning'}
              </span>
            </div>
            <p className="mt-3 text-xs leading-5 text-foreground-muted">
              {agent.description || 'Responsibility will be refined as the blueprint matures.'}
            </p>
            <BlueprintMiniList
              label="Inputs"
              items={agent.gatherFields}
              fallback="No required fields yet"
            />
            <BlueprintMiniList label="Tools" items={agent.tools} fallback="No tools declared yet" />
            <BlueprintMiniList
              label="Constructs"
              items={agent.suggestedConstructs}
              fallback={
                (agent.flowStepSeeds ?? []).length > 0
                  ? (agent.flowStepSeeds ?? []).join(' -> ')
                  : 'Reasoning response'
              }
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function BlueprintMiniList({
  label,
  items,
  fallback,
}: {
  label: string;
  items?: readonly string[];
  fallback: string;
}) {
  const values = items && items.length > 0 ? items : [fallback];
  return (
    <div className="mt-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
        {label}
      </p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {values.map((item) => (
          <span
            key={`${label}-${item}`}
            className="rounded border border-border/50 bg-background px-1.5 py-0.5 text-[10px] text-foreground-muted"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function BlueprintVisualPlan({ data }: { data: BlueprintDocumentArtifact }) {
  const topology = data.topology;
  const agents = topology?.agents ?? [];
  const edges = topology?.edges ?? [];
  const entryPoint = topology?.entryPoint || agents[0]?.name || 'Entry agent';
  const entryAgent = agents.find((agent) => agent.name === entryPoint);
  const nonEntryAgents = agents.filter((agent) => agent.name !== entryPoint);

  return (
    <section className="rounded-lg border border-border/50 bg-background-elevated px-4 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-accent" />
          <h4 className="text-sm font-semibold text-foreground">Architecture map</h4>
        </div>
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-foreground-muted">
          {agents.length} agent{agents.length === 1 ? '' : 's'} · {edges.length} route
          {edges.length === 1 ? '' : 's'}
        </span>
      </div>
      {agents.length > 0 ? (
        <div className="space-y-4">
          <div className="rounded-md border border-border/50 bg-background-muted/20 px-3 py-3">
            <div className="flex flex-wrap items-stretch gap-3">
              <BlueprintAgentNode agent={entryAgent} name={entryPoint} label="Entry" tone="entry" />
              {nonEntryAgents.slice(0, 10).map((agent) => (
                <div key={agent.name} className="flex min-w-0 items-center gap-3">
                  <div className="hidden h-px w-8 border-t border-dashed border-border sm:block" />
                  <BlueprintAgentNode
                    agent={agent}
                    name={agent.name}
                    label={agent.executionMode || agent.role || 'Agent'}
                    tone="agent"
                  />
                </div>
              ))}
            </div>
          </div>
          {edges.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {edges.map((edge, index) => (
                <div
                  key={`${edge.from}-${edge.to}-${index}`}
                  className="rounded-md border border-border/50 bg-background-muted/30 px-3 py-2 text-xs"
                >
                  <p className="break-words font-medium text-foreground">
                    {edge.from || 'Unknown'} {'->'} {edge.to || 'Unknown'}
                  </p>
                  <p className="mt-1 break-words text-foreground-muted">
                    {edge.type || 'delegate'} · {edge.condition || 'true'}
                    {edge.returnsControl === true ? ' · returns' : ''}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
          {nonEntryAgents.length > 10 ? (
            <p className="text-xs text-foreground-subtle">
              Showing entry plus first 10 specialists. Full roster is listed in Agent details.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-foreground-muted">The agent graph will appear once drafted.</p>
      )}
    </section>
  );
}

function BlueprintAgentNode({
  agent,
  name,
  label,
  tone,
}: {
  agent?: BlueprintDocumentTopologyAgent;
  name: string;
  label: string;
  tone: 'entry' | 'agent';
}) {
  return (
    <div
      className={clsx(
        'min-h-24 w-56 rounded-md border px-3 py-2',
        tone === 'entry'
          ? 'border-border/70 bg-background'
          : 'border-border/60 bg-background-muted/30',
      )}
    >
      <p className="break-words text-xs font-semibold text-foreground">{name}</p>
      <p className="mt-0.5 text-[10px] text-foreground-subtle">{label}</p>
      {agent?.description ? (
        <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-foreground-muted">
          {agent.description}
        </p>
      ) : null}
    </div>
  );
}

function BlueprintOpenItems({ items }: { items: BlueprintOpenItem[] }) {
  return (
    <div className="rounded-lg border border-warning/25 bg-warning/5 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Open items</h4>
          <p className="mt-1 text-xs text-foreground-muted">
            These are intentionally not filled with boilerplate. Add details in chat when they
            matter for this project.
          </p>
        </div>
        <span className="rounded-full bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
          {items.length} pending
        </span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-warning/20 bg-background/60 px-3 py-2"
          >
            <p className="text-xs font-semibold text-foreground">{item.title}</p>
            <p className="mt-1 text-xs leading-5 text-foreground-muted">{item.reason}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BlueprintMarkdownDocument({ sections }: { sections: BlueprintMarkdownSection[] }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-border/50 bg-background-elevated px-5 py-5">
      <div className="mb-4">
        <h4 className="text-sm font-semibold text-foreground">Blueprint document</h4>
        <p className="mt-1 text-xs text-foreground-muted">
          Markdown-rendered blueprint content. This is the review surface users should read before
          locking the build.
        </p>
      </div>
      <div className="space-y-6">
        {sections.map((section) => (
          <BlueprintSectionChunk key={section.id} section={section} />
        ))}
      </div>
    </section>
  );
}

function BlueprintSectionChunk({ section }: { section: BlueprintMarkdownSection }) {
  return (
    <section
      id={section.id}
      className={clsx(
        'scroll-mt-5 border-t border-border/50 pt-5 first:border-t-0 first:pt-0',
        section.state !== 'ready' && 'opacity-80',
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <div
          className={clsx(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold',
            section.state === 'ready'
              ? 'border-success/25 bg-success/5 text-success'
              : 'border-border/60 bg-background-muted text-foreground-muted',
          )}
        >
          {section.number}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{section.title}</h4>
            <span
              className={clsx(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                section.state === 'ready'
                  ? 'bg-success/10 text-success'
                  : 'bg-foreground/5 text-foreground-subtle',
              )}
            >
              {section.state === 'ready' ? 'Populated' : 'Pending detail'}
            </span>
          </div>
        </div>
      </div>
      <ArchMarkdown
        content={section.content || 'Pending blueprint detail.'}
        className="text-[13px] leading-6 text-foreground-muted [&_li]:my-1 [&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_table]:table-fixed [&_table]:text-xs [&_td:first-child]:w-36 [&_td:first-child]:font-medium [&_td]:border-t [&_td]:border-border/40 [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-top [&_th:first-child]:w-36 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_thead]:text-foreground-subtle [&_ul]:my-2"
      />
    </section>
  );
}

function BlueprintDraftingStatus({ data }: { data: BlueprintDocumentArtifact }) {
  const revising = data.stage === 'revising';
  return (
    <div className="mb-5 rounded-lg border border-accent/20 bg-accent/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
        <p className="text-sm font-medium text-foreground">
          {revising ? 'Revising blueprint artifact' : 'Preparing blueprint artifact'}
        </p>
      </div>
      <p className="mt-1 text-xs leading-5 text-foreground-muted">
        {revising
          ? 'The draft will refresh here as soon as the revised agent graph is available.'
          : 'The interview spec is being translated into a reviewable blueprint document and agent graph.'}
      </p>
    </div>
  );
}

// ─── File Tab Content ─────────────────────────────────────────────────────

function FileTabContent({
  data,
}: {
  data: { name: string; content: string; isMock?: boolean; generating?: boolean };
}) {
  if (!data.content && data.generating !== false) {
    return <CodeSkeletonLoader agentName={data.name} />;
  }
  return (
    <div className="flex h-full flex-col">
      {data.generating && data.content && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-background-elevated px-4 py-1.5 flex-shrink-0">
          <div className="h-2.5 w-2.5 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
          <span className="text-[11px] text-foreground-muted">
            Generating <span className="font-medium text-foreground">{data.name}</span>
            .abl.yaml
          </span>
          <span className="ml-auto text-[10px] tabular-nums text-foreground-subtle">
            {data.content.split('\n').length} lines
          </span>
        </div>
      )}
      <ArchDSLViewer
        content={data.content}
        fileName={data.name}
        isMock={data.isMock}
        className="h-full"
        streaming={data.generating}
      />
    </div>
  );
}

/** Animated skeleton that mimics ABL code being generated line by line */
function CodeSkeletonLoader({ agentName }: { agentName: string }) {
  // Simulate ABL structure with varying line widths
  const skeletonLines = [
    { width: '35%', indent: 0, delay: 0 }, // AGENT: Name
    { width: '60%', indent: 0, delay: 0.1 }, // GOAL: "..."
    { width: '20%', indent: 0, delay: 0.2 }, // PERSONA: |
    { width: '75%', indent: 1, delay: 0.3 }, //   description line
    { width: '55%', indent: 1, delay: 0.4 }, //   description line
    { width: '0%', indent: 0, delay: 0 }, // blank
    { width: '25%', indent: 0, delay: 0.5 }, // TOOLS:
    { width: '65%', indent: 1, delay: 0.6 }, //   tool_name(...) -> {...}
    { width: '45%', indent: 2, delay: 0.7 }, //     description
    { width: '60%', indent: 1, delay: 0.8 }, //   tool_name(...) -> {...}
    { width: '40%', indent: 2, delay: 0.9 }, //     description
    { width: '0%', indent: 0, delay: 0 }, // blank
    { width: '30%', indent: 0, delay: 1.0 }, // GUARDRAILS:
    { width: '50%', indent: 1, delay: 1.1 }, //   content_safety:
    { width: '35%', indent: 2, delay: 1.2 }, //     kind: input
    { width: '72%', indent: 2, delay: 1.3 }, //     llm_check: "Does this request violate policy?"
    { width: '0%', indent: 0, delay: 0 }, // blank
    { width: '22%', indent: 0, delay: 1.4 }, // MEMORY:
    { width: '40%', indent: 1, delay: 1.5 }, //   session:
    { width: '55%', indent: 2, delay: 1.6 }, //     - name: current_topic
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
        <div className="h-3 w-3 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />
        <span className="text-xs text-foreground-muted">
          Generating <span className="font-medium text-foreground">{agentName}</span>.abl.yaml
        </span>
      </div>

      {/* Code skeleton with line numbers */}
      <div className="flex-1 overflow-hidden p-4 font-mono text-xs">
        <div className="space-y-[6px]">
          {skeletonLines.map((line, i) => (
            <div key={i} className="flex items-center gap-3">
              {/* Line number */}
              <span className="w-5 text-right text-[10px] text-foreground-subtle/40 select-none">
                {line.width === '0%' ? '' : i + 1}
              </span>
              {/* Code line skeleton */}
              {line.width !== '0%' ? (
                <div
                  className="h-[14px] rounded-sm bg-gradient-shimmer animate-shimmer"
                  style={{
                    width: line.width,
                    marginLeft: `${line.indent * 16}px`,
                    animationDelay: `${line.delay}s`,
                    backgroundSize: '200% 100%',
                  }}
                />
              ) : (
                <div className="h-[14px]" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* CSS for shimmer animation */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .animate-shimmer {
          animation: shimmer 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

// ─── Topology Header Status (reads buildState) ──────────────────────────

function TopologyHeaderStatus({ tab }: { tab: ArtifactTab }) {
  const buildAgents = useArchAIStore((s) => s.buildState.agents);
  const d = tab.data as Record<string, unknown>;
  const agentCount = Array.isArray(d?.agents) ? d.agents.length : 0;
  const edgeCount = Array.isArray(d?.edges) ? d.edges.length : 0;
  const approved = d?.approved as boolean | undefined;
  const locked = d?.locked as boolean | undefined;
  const stage = typeof d?.stage === 'string' ? d.stage : undefined;

  const agentValues = Object.values(buildAgents);
  const compiledCount = agentValues.filter(
    (a) => a.status === 'compiled' || a.status === 'warning' || a.status === 'validated',
  ).length;
  const isBuildActive = agentValues.length > 0;

  if (!agentCount) {
    if (stage === 'concept_ready') {
      return <span className="text-xs text-foreground-muted">Concept ready</span>;
    }
    if (stage === 'revising' || stage === 'draft_generating') {
      return <span className="text-xs text-foreground-muted">Drafting topology…</span>;
    }
    return null;
  }
  return (
    <span className="text-xs text-foreground-muted">
      {agentCount} agents · {edgeCount} handoffs
      {isBuildActive
        ? ` · ${compiledCount}/${agentCount} compiled`
        : locked || approved
          ? ' · locked'
          : ' · draft'}
    </span>
  );
}

// ─── Topology Tab ─────────────────────────────────────────────────────────

function TopologyTabContent({ data }: { data: Record<string, unknown> }) {
  const buildAgents = useArchAIStore((s) => s.buildState.agents);

  const agents = (data?.agents ?? []) as Array<{
    name: string;
    role: string;
    executionMode: string;
    suggestedConstructs?: string[];
  }>;
  const edges = (data?.edges ?? []) as Array<{
    from: string;
    to: string;
    type: string;
    condition: string;
    returnsControl?: boolean;
  }>;
  const entryPoint = (data?.entryPoint as string) ?? '';
  const pattern = (data?.pattern as string) ?? '';
  const reasoning = (data?.reasoning as string) ?? '';

  // Compute build progress from buildState.agents
  const buildAgentValues = Object.values(buildAgents);
  const compiledCount = buildAgentValues.filter(
    (a) => a.status === 'compiled' || a.status === 'warning' || a.status === 'validated',
  ).length;
  const isBuildActive = buildAgentValues.length > 0;

  // Derive buildStatus record for TopologyGraph (it expects Record<string, string>)
  const buildStatus: Record<string, string> | undefined = isBuildActive
    ? Object.fromEntries(Object.entries(buildAgents).map(([name, a]) => [name, a.status]))
    : undefined;

  const handleAgentClick = useCallback((agentName: string) => {
    const store = useArchAIStore.getState();
    const files = store.filePanelFiles;
    const content = files[agentName]?.content || files[agentName]?.streamingContent || '';
    if (!content) return;

    const existingTab = store.artifactTabs.find(
      (t) => t.type === 'agent_code' && t.label === agentName,
    );
    if (existingTab) {
      store.setActiveTab(existingTab.id);
    } else {
      store.addTab({
        type: 'agent_code',
        label: agentName,
        data: {
          name: agentName,
          content,
          generating: Boolean(files[agentName]?.streamingContent && !files[agentName]?.content),
          compileStatus: files[agentName]?.compileStatus,
        },
        toolCallId: `topology-click-${agentName}`,
      });
    }
  }, []);

  return (
    <div className="flex h-full flex-col p-4 gap-3">
      {pattern && (
        <div className="rounded-md bg-background-muted p-2 flex-shrink-0">
          <div className="text-xs font-medium text-foreground">
            {pattern.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
          </div>
          {reasoning && <div className="mt-1 text-xs text-foreground-muted">{reasoning}</div>}
        </div>
      )}

      {/* Build progress bar — shown when buildStatus data exists */}
      {isBuildActive && (
        <div className="mb-0 h-1 rounded-full bg-border/30 overflow-hidden flex-shrink-0">
          <div
            className="h-full bg-accent transition-all duration-500 ease-out"
            style={{
              width: `${agents.length > 0 ? Math.round((compiledCount / agents.length) * 100) : 0}%`,
            }}
          />
        </div>
      )}

      <div className="min-h-0 flex-1">
        <TopologyGraph
          agents={agents}
          edges={edges}
          entryPoint={entryPoint}
          pattern={pattern}
          buildStatus={buildStatus}
          reasoning={reasoning}
          onAgentClick={handleAgentClick}
        />
      </div>
    </div>
  );
}

// ─── Summary Tab ──────────────────────────────────────────────────────────

function SummaryTabContent({ data }: { data: Record<string, unknown> }) {
  const spec = (data.specification ?? {}) as Record<string, unknown>;
  const topology = (data.topology ?? {}) as Record<string, unknown>;
  const files = (data.files ?? {}) as Record<string, unknown>;
  const mockServer = data.mockServer as {
    projectName: string;
    endpointCount: number;
  } | null;
  const agentNames = Object.keys(files);
  const topologyAgents = ((topology?.agents ?? []) as Array<{ name: string }>).map((a) => a.name);

  return (
    <div className="p-6">
      <div className="mb-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">Ready to Create</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Your project is designed, compiled, and ready for deployment.
        </p>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between border-b border-border/50 py-2">
          <span className="text-foreground-muted">Project Name</span>
          <span className="font-medium">{(spec.projectName as string) ?? 'Unnamed'}</span>
        </div>
        <div className="flex justify-between border-b border-border/50 py-2">
          <span className="text-foreground-muted">Agents</span>
          <span className="font-medium">{agentNames.length}</span>
        </div>
        <div className="flex justify-between border-b border-border/50 py-2">
          <span className="text-foreground-muted">Topology</span>
          <span className="font-medium">
            {topologyAgents.length} agents, entry: {(topology?.entryPoint as string) ?? '-'}
          </span>
        </div>
        {mockServer && mockServer.endpointCount > 0 && (
          <div className="flex justify-between border-b border-border/50 py-2">
            <span className="text-foreground-muted">Mock API Server</span>
            <span className="font-medium">
              {mockServer.endpointCount} endpoint{mockServer.endpointCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        {agentNames.length > 0 && (
          <div className="py-2">
            <span className="text-xs text-foreground-muted">Agents:</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {agentNames.map((name) => (
                <span key={name} className="rounded-md bg-background-muted px-2 py-0.5 text-xs">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
