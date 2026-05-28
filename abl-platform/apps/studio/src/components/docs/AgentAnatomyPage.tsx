/**
 * Agent Anatomy Documentation Page
 *
 * Browsable reference for all ABL DSL constructs. Renders static HTML pages
 * in an iframe with sidebar navigation and query-param-based routing.
 *
 * Route: /docs/agent-anatomy?page=tools
 * Static files served from: /agent-anatomy/*.html
 */

'use client';

import { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  BookOpen,
  ChevronRight,
  Wrench,
  GitBranch,
  Shield,
  FormInput,
  FileText,
  Brain,
  Users,
  RotateCcw,
  MessageSquare,
  Cpu,
  Blocks,
  Workflow,
  PenTool,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Page definitions
// ---------------------------------------------------------------------------

interface PageDef {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: React.ElementType;
  file: string;
}

const PAGES: PageDef[] = [
  // Deep Dives
  {
    id: 'tools',
    title: 'Tools',
    description: '5 binding types, params, auth',
    category: 'Constructs',
    icon: Wrench,
    file: 'tools.html',
  },
  {
    id: 'flow',
    title: 'Flow',
    description: 'Steps, reasoning, branching',
    category: 'Constructs',
    icon: GitBranch,
    file: 'flow.html',
  },
  {
    id: 'guardrails',
    title: 'Guardrails',
    description: '3 tiers, 7 actions, 5 built-in',
    category: 'Constructs',
    icon: Shield,
    file: 'guardrails.html',
  },
  {
    id: 'gather',
    title: 'Gather',
    description: '8 types, validation, inference',
    category: 'Constructs',
    icon: FormInput,
    file: 'gather.html',
  },
  {
    id: 'templates',
    title: 'Templates',
    description: '7 channels, rich markdown, voice',
    category: 'Constructs',
    icon: FileText,
    file: 'templates.html',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Session, persistent, remember, recall',
    category: 'Constructs',
    icon: Brain,
    file: 'memory.html',
  },
  {
    id: 'coordination',
    title: 'Coordination',
    description: 'Handoff, delegate, escalate',
    category: 'Constructs',
    icon: Users,
    file: 'coordination.html',
  },
  {
    id: 'lifecycle',
    title: 'Lifecycle',
    description: 'ON_START, COMPLETE, ON_ERROR, HOOKS',
    category: 'Constructs',
    icon: RotateCcw,
    file: 'lifecycle.html',
  },
  {
    id: 'output',
    title: 'Output',
    description: 'Templates, messages, system prompt',
    category: 'Constructs',
    icon: MessageSquare,
    file: 'output.html',
  },
  {
    id: 'execution',
    title: 'Execution',
    description: 'Model, temperature, thinking',
    category: 'Constructs',
    icon: Cpu,
    file: 'execution.html',
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description: 'NLU, behavior profiles, lookups',
    category: 'Constructs',
    icon: Blocks,
    file: 'advanced.html',
  },
  // Patterns
  {
    id: 'workflows',
    title: 'Agent Workflows',
    description: 'Simple to expert patterns',
    category: 'Patterns',
    icon: Workflow,
    file: 'workflows.html',
  },
  {
    id: 'editor-wireframe',
    title: 'Editor Wireframe',
    description: 'Monaco slash commands, pickers',
    category: 'Patterns',
    icon: PenTool,
    file: 'monaco-editor-wireframe.html',
  },
];

const DEFAULT_PAGE = 'index';

// ---------------------------------------------------------------------------
// Inner component (needs Suspense for useSearchParams)
// ---------------------------------------------------------------------------

function AgentAnatomyContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pageParam = searchParams.get('page') || DEFAULT_PAGE;
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const activePage = PAGES.find((p) => p.id === pageParam);
  const activeFile = activePage?.file || 'index.html';

  const selectPage = useCallback(
    (pageId: string) => {
      setIframeLoaded(false);
      router.push(`/docs/agent-anatomy?page=${pageId}`, { scroll: false });
    },
    [router],
  );

  const goToOverview = useCallback(() => {
    setIframeLoaded(false);
    router.push('/docs/agent-anatomy', { scroll: false });
  }, [router]);

  // Reset loaded state when page changes
  useEffect(() => {
    setIframeLoaded(false);
  }, [pageParam]);

  // Group pages by category
  const grouped: Record<string, PageDef[]> = {};
  for (const page of PAGES) {
    if (!grouped[page.category]) grouped[page.category] = [];
    grouped[page.category].push(page);
  }

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar */}
      <div className="w-[240px] flex-shrink-0 border-r border-default bg-background-subtle flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-default">
          <button
            onClick={goToOverview}
            className="flex items-center gap-2 text-sm font-semibold text-foreground hover:text-accent transition-default"
          >
            <BookOpen className="w-4 h-4 text-accent" />
            Agent Anatomy
          </button>
          <p className="text-xs text-subtle mt-0.5">ABL Reference</p>
        </div>

        {/* Overview link */}
        <div className="px-2 py-2 border-b border-default">
          <button
            onClick={goToOverview}
            className={clsx(
              'w-full text-left px-3 py-1.5 text-xs rounded-md transition-default flex items-center gap-2',
              pageParam === DEFAULT_PAGE
                ? 'text-accent bg-accent-subtle font-medium'
                : 'text-muted hover:text-foreground hover:bg-background-muted',
            )}
          >
            <BookOpen className="w-3 h-3 flex-shrink-0" />
            Overview
          </button>
        </div>

        {/* Page list */}
        <div className="flex-1 overflow-y-auto py-2">
          {Object.entries(grouped).map(([category, categoryPages]) => (
            <div key={category} className="mb-3">
              <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wider text-subtle">
                {category}
              </div>
              {categoryPages.map((page) => {
                const Icon = page.icon;
                return (
                  <button
                    key={page.id}
                    onClick={() => selectPage(page.id)}
                    className={clsx(
                      'w-full text-left px-3 py-1.5 text-xs transition-default flex items-center gap-2 mx-1 rounded-md',
                      pageParam === page.id
                        ? 'text-accent bg-accent-subtle font-medium'
                        : 'text-muted hover:text-foreground hover:bg-background-muted',
                    )}
                  >
                    <Icon className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{page.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Content — iframe */}
      <div className="flex-1 relative">
        {!iframeLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-background z-10">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
            <span className="ml-2 text-muted text-sm">Loading...</span>
          </div>
        )}
        <iframe
          key={pageParam}
          src={`/agent-anatomy/${activeFile}`}
          className="w-full h-full border-none"
          onLoad={() => setIframeLoaded(true)}
          title={activePage?.title || 'Agent Anatomy Overview'}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public export with Suspense boundary
// ---------------------------------------------------------------------------

export function AgentAnatomyPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full bg-background">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
          <span className="ml-2 text-muted text-sm">Loading documentation...</span>
        </div>
      }
    >
      <AgentAnatomyContent />
    </Suspense>
  );
}
