'use client';

/**
 * UnifiedInboxPage Component
 *
 * Unified human-in-the-loop inbox with two-tier filtering:
 * - SegmentedControl toggle for mailbox (Workflow / Agent)
 * - Pill sub-filters for task types within each mailbox
 *
 * Uses ListPageShell for consistent layout with Sessions, Deployments, etc.
 * 5s polling for live updates via useHumanTasks hook.
 */

import { useState, useCallback, useMemo } from 'react';
import clsx from 'clsx';
import {
  Inbox,
  CheckCircle,
  FileText,
  Eye,
  GitBranch,
  AlertTriangle,
  Loader2,
  Bot,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useHumanTasks, type UseHumanTasksParams } from '../../hooks/useHumanTasks';
import type { HumanTaskType, HumanTaskMailbox, HumanTaskStatus } from '../../api/human-tasks';
import { ListPageShell } from '../ui/ListPageShell';
import { SegmentedControl } from '../ui/SegmentedControl';
import { EmptyState } from '../ui/EmptyState';
import { TaskCard } from './TaskCard';

// =============================================================================
// FILTER CONFIG
// =============================================================================

interface FilterTab {
  key: HumanTaskType | 'all';
  label: string;
  icon: React.ReactNode;
}

const MAILBOX_OPTIONS = [
  { id: 'workflow', label: 'Workflow', icon: <GitBranch className="w-3.5 h-3.5" /> },
  { id: 'agent', label: 'Agent', icon: <Bot className="w-3.5 h-3.5" /> },
];

/** Type sub-filters shown within each mailbox */
const MAILBOX_TYPE_FILTERS: Record<HumanTaskMailbox, FilterTab[]> = {
  workflow: [
    { key: 'all', label: 'All', icon: <Inbox className="w-3.5 h-3.5" /> },
    { key: 'approval', label: 'Approvals', icon: <CheckCircle className="w-3.5 h-3.5" /> },
    { key: 'data_entry', label: 'Data Entry', icon: <FileText className="w-3.5 h-3.5" /> },
    // { key: 'review', label: 'Reviews', icon: <Eye className="w-3.5 h-3.5" /> },
    // { key: 'decision', label: 'Decisions', icon: <GitBranch className="w-3.5 h-3.5" /> },
  ],
  agent: [
    { key: 'all', label: 'All', icon: <Inbox className="w-3.5 h-3.5" /> },
    { key: 'escalation', label: 'Escalations', icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  ],
};

// =============================================================================
// SKELETON
// =============================================================================

function TaskSkeleton() {
  return (
    <div className="rounded-xl border border-default bg-background-elevated p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <div className="h-4 w-48 rounded skeleton" />
          <div className="flex items-center gap-2">
            <div className="h-5 w-16 rounded skeleton" />
            <div className="h-5 w-14 rounded skeleton" />
            <div className="h-3 w-12 rounded skeleton" />
          </div>
        </div>
        <div className="h-4 w-4 rounded skeleton shrink-0 mt-0.5" />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

const PAGE_SIZE = 25;

/**
 * Active inbox statuses. Used when the user unchecks "Include completed";
 * by default the inbox includes completed/cancelled/rejected/expired rows.
 */
const ACTIVE_STATUSES: HumanTaskStatus[] = ['pending', 'assigned', 'in_progress'];

export function UnifiedInboxPage() {
  const projectId = useNavigationStore((s) => s.projectId);
  const [activeMailbox, setActiveMailbox] = useState<HumanTaskMailbox>('workflow');
  const [activeTypeFilter, setActiveTypeFilter] = useState<HumanTaskType | 'all'>('all');
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [includeCompleted, setIncludeCompleted] = useState(true);

  const params: UseHumanTasksParams = useMemo(() => {
    const p: UseHumanTasksParams = { mailbox: activeMailbox, limit: pageSize };
    if (activeTypeFilter !== 'all') {
      p.type = activeTypeFilter;
    }
    if (!includeCompleted) {
      p.status = ACTIVE_STATUSES;
    }
    return p;
  }, [activeMailbox, activeTypeFilter, pageSize, includeCompleted]);

  const { tasks, total, countsByType, countsByMailbox, isLoading, error, refresh } = useHumanTasks(
    projectId,
    params,
  );

  const handleResolved = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleMailboxChange = useCallback((id: string) => {
    setActiveMailbox(id as HumanTaskMailbox);
    setActiveTypeFilter('all');
    setPageSize(PAGE_SIZE);
  }, []);

  const handleLoadMore = useCallback(() => {
    setPageSize((prev) => prev + PAGE_SIZE);
  }, []);

  const totalActive = (countsByMailbox.workflow ?? 0) + (countsByMailbox.agent ?? 0);
  const typeFilters = MAILBOX_TYPE_FILTERS[activeMailbox];
  const typeTotal = Object.values(countsByType).reduce((sum, c) => sum + c, 0);

  // Build mailbox options with live counts as badges
  const mailboxOptionsWithCounts = MAILBOX_OPTIONS.map((opt) => {
    const count = countsByMailbox[opt.id] ?? 0;
    return { ...opt, badge: count > 0 ? count : undefined };
  });

  // Filter bar: SegmentedControl + type pill filters + "Include completed" toggle
  const filterBarContent = (
    <div
      className="flex items-center gap-4 w-full"
      data-testid="unified-inbox-filter-bar"
      data-active-mailbox={activeMailbox}
      data-active-type={activeTypeFilter}
    >
      <SegmentedControl
        options={mailboxOptionsWithCounts}
        value={activeMailbox}
        onChange={handleMailboxChange}
        size="sm"
        ariaLabel="Mailbox selector"
        className="border border-default"
      />
      <div className="h-5 w-px bg-border shrink-0" />
      <div className="flex gap-1 overflow-x-auto">
        {typeFilters.map((tab) => {
          const count = tab.key === 'all' ? typeTotal : (countsByType[tab.key] ?? 0);
          return (
            <button
              key={tab.key}
              data-testid={`inbox-type-filter-${tab.key}`}
              data-active={activeTypeFilter === tab.key ? 'true' : 'false'}
              onClick={() => setActiveTypeFilter(tab.key)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-default whitespace-nowrap',
                activeTypeFilter === tab.key
                  ? 'bg-accent-subtle text-accent border border-accent/30'
                  : 'text-muted hover:text-foreground hover:bg-background-muted border border-transparent',
              )}
            >
              {tab.icon}
              {tab.label}
              {count > 0 && (
                <span
                  className={clsx(
                    'ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full',
                    activeTypeFilter === tab.key
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-muted text-muted',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-1" />
      <label
        className="flex items-center gap-2 text-xs font-medium text-muted hover:text-foreground cursor-pointer whitespace-nowrap"
        data-testid="inbox-include-completed-toggle"
      >
        <input
          type="checkbox"
          checked={includeCompleted}
          onChange={(e) => setIncludeCompleted(e.target.checked)}
          className="rounded border-default text-accent focus:ring-accent/30"
        />
        Include completed
      </label>
    </div>
  );

  return (
    <ListPageShell
      title="Inbox"
      description="Human-in-the-loop tasks requiring your attention"
      secondaryActions={
        totalActive > 0 ? (
          <span
            className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
            data-testid="unified-inbox-total-active"
          >
            {totalActive} active
          </span>
        ) : undefined
      }
      filterBar={filterBarContent}
    >
      <div data-testid="unified-inbox-page">
        {/* Error state */}
        {error && (
          <div
            className="rounded-lg border border-error/30 bg-error/5 p-4 mb-4"
            data-testid="unified-inbox-error"
          >
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* Loading state */}
        {isLoading && tasks.length === 0 && (
          <div className="space-y-3" data-testid="unified-inbox-loading">
            {Array.from({ length: 4 }, (_, i) => (
              <TaskSkeleton key={i} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!isLoading && tasks.length === 0 && !error && (
          <div data-testid="unified-inbox-empty">
            <EmptyState
              icon={<Inbox className="w-6 h-6" />}
              title="No tasks"
              description={
                activeTypeFilter === 'all'
                  ? activeMailbox === 'workflow'
                    ? 'No pending workflow tasks. Tasks will appear here when workflow steps require human input.'
                    : 'No pending agent tasks. Tasks will appear here when agents escalate issues.'
                  : `No ${activeTypeFilter.replace('_', ' ')} tasks pending.`
              }
            />
          </div>
        )}

        {/* Task list */}
        {tasks.length > 0 && projectId && (
          <div className="space-y-3" data-testid="unified-inbox-list">
            {tasks.map((task) => (
              <TaskCard
                key={task._id}
                task={task}
                projectId={projectId}
                onResolved={handleResolved}
              />
            ))}
            {/* Load more */}
            {tasks.length < total && (
              <div className="flex justify-center pt-2">
                <button
                  data-testid="unified-inbox-load-more"
                  onClick={handleLoadMore}
                  className="text-xs font-medium text-accent hover:text-accent/80 transition-default"
                >
                  Load more ({tasks.length} of {total})
                </button>
              </div>
            )}
          </div>
        )}

        {/* Load indicator for polling */}
        {isLoading && tasks.length > 0 && (
          <div className="flex justify-center py-3">
            <Loader2 className="w-4 h-4 animate-spin text-muted" />
          </div>
        )}
      </div>
    </ListPageShell>
  );
}
