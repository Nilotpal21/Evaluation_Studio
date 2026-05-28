/**
 * WorkflowCard Component
 *
 * Rich card for the workflows grid showing name, status badge,
 * description, step count, trigger type, and last run time.
 */

import { clsx } from 'clsx';
import { GitBranch, Clock, Webhook, Zap, Play, Layers, Trash2, Bot } from 'lucide-react';
import type { WorkflowSummary } from '../../api/workflows';

// =============================================================================
// TYPES
// =============================================================================

interface WorkflowCardProps {
  workflow: WorkflowSummary;
  versionCount?: number;
  onOpen: () => void;
  onDelete?: () => void;
  className?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

const MAX_DESCRIPTION_LENGTH = 120;

// =============================================================================
// TRIGGER CONFIG
// =============================================================================

interface TriggerConfig {
  label: string;
  icon: React.ReactNode;
}

const triggerStyles: Record<string, TriggerConfig> = {
  webhook: { label: 'Webhook', icon: <Webhook className="w-3.5 h-3.5" /> },
  cron: { label: 'Cron', icon: <Clock className="w-3.5 h-3.5" /> },
  event: { label: 'Event', icon: <Zap className="w-3.5 h-3.5" /> },
  studio: { label: 'Studio', icon: <Play className="w-3.5 h-3.5" /> },
  agent: { label: 'Agent', icon: <Bot className="w-3.5 h-3.5" /> },
};

const defaultTrigger: TriggerConfig = {
  label: 'Studio',
  icon: <Play className="w-3.5 h-3.5" />,
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format an ISO date string as a relative time string.
 * Returns "just now", "5m ago", "2h ago", "3d ago", or a locale date for older dates.
 */
function formatRelativeTime(isoDate: string | undefined | null): string {
  if (!isoDate) return '—';
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return '—';
  const now = Date.now();
  const diffSeconds = Math.floor((now - date.getTime()) / 1000);

  if (diffSeconds < SECONDS_PER_MINUTE) {
    return 'Just now';
  }
  if (diffSeconds < SECONDS_PER_HOUR) {
    const mins = Math.floor(diffSeconds / SECONDS_PER_MINUTE);
    return `${mins}m ago`;
  }
  if (diffSeconds < SECONDS_PER_DAY) {
    const hours = Math.floor(diffSeconds / SECONDS_PER_HOUR);
    return `${hours}h ago`;
  }
  if (diffSeconds < SECONDS_PER_WEEK) {
    const days = Math.floor(diffSeconds / SECONDS_PER_DAY);
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

/**
 * Truncate a description string to MAX_DESCRIPTION_LENGTH with ellipsis.
 */
function truncateDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;
  return text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd() + '...';
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowCard({
  workflow,
  versionCount,
  onOpen,
  onDelete,
  className,
}: WorkflowCardProps) {
  const displayName = workflow.name;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={clsx(
        'rounded-xl border border-default bg-background-elevated p-5 cursor-pointer card-hover group focus-ring',
        className,
      )}
    >
      {/* Header: Icon + Name + Status Badge */}
      <div className="flex items-start gap-3">
        {/* Workflow icon */}
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-accent-subtle text-accent">
          <GitBranch className="w-5 h-5" />
        </div>

        {/* Name + status */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate">{displayName}</h3>
            {versionCount !== undefined && versionCount > 0 && (
              <span className="ml-auto shrink-0 flex items-center gap-1 text-xs text-muted">
                <GitBranch className="w-3.5 h-3.5" />
                {versionCount} {versionCount === 1 ? 'version' : 'versions'}
              </span>
            )}
            {onDelete && (
              <button
                type="button"
                data-testid="workflow-delete-btn"
                aria-label="Delete workflow"
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-error-subtle hover:text-error text-muted transition-all"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-muted my-3" />

      {/* Description */}
      <div className="mb-3">
        {workflow.description ? (
          <p className="line-clamp-2 text-sm text-muted">
            {truncateDescription(workflow.description)}
          </p>
        ) : (
          <p className="text-sm text-subtle italic">No description</p>
        )}
      </div>

      {/* Metadata row: steps, triggers count, agents/tools count */}
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Layers className="w-3.5 h-3.5" />
          {workflow.stepCount} {workflow.stepCount === 1 ? 'step' : 'steps'}
        </span>
        <span className="flex items-center gap-1">
          <Webhook className="w-3.5 h-3.5" />
          {workflow.triggerCount ?? 0} {(workflow.triggerCount ?? 0) === 1 ? 'trigger' : 'triggers'}
        </span>
        {workflow.toolCount !== undefined && workflow.toolCount > 0 && (
          <span
            className="flex items-center gap-1"
            title="Used by agents via a workflow tool binding"
          >
            <Bot className="w-3.5 h-3.5" />
            {workflow.toolCount} {workflow.toolCount === 1 ? 'agent' : 'agents'}
          </span>
        )}
      </div>

      {/* Footer: last run + updated */}
      <div className="flex items-center gap-3 mt-2 text-xs text-subtle">
        {workflow.lastRunAt && (
          <span className="flex items-center gap-1">
            <Play className="w-3 h-3" />
            Last run {formatRelativeTime(workflow.lastRunAt)}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Modified {formatRelativeTime(workflow.updatedAt)}
        </span>
      </div>
    </div>
  );
}
