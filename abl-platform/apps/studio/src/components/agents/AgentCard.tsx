/**
 * AgentCard Component
 *
 * Rich card for the agents grid showing name, type badges, description,
 * metadata (domain, tools, fields), and version/time info.
 */

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import {
  Bot,
  Sparkles,
  Network,
  Play,
  Tag,
  Clock,
  Wrench,
  FormInput,
  ArrowRightLeft,
} from 'lucide-react';
import { parseActiveVersions, type RuntimeAgent } from '../../api/runtime-agents';
import { formatAgentName } from '../../lib/format/agent-name';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { MiniSparkline } from '../ui/MiniSparkline';

// =============================================================================
// TYPES
// =============================================================================

export interface AgentSummary {
  toolsCount: number;
  gatherFieldsCount: number;
  executionMode: string;
  goal: string | null;
  description: string | null;
}

interface AgentCardProps {
  agent: RuntimeAgent;
  summary?: AgentSummary | null;
  isStart: boolean;
  supervisor: boolean;
  onOpen: () => void;
  onChat: () => void;
  className?: string;
  status?: 'live' | 'draft' | 'error';
  sessionActivity?: number[]; // last 7 days
  sessionCount?: number;
  handoffCount?: number;
}

// =============================================================================
// HELPERS
// =============================================================================

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

/**
 * Format an ISO date string as a relative time string.
 * Returns "just now", "5m ago", "2h ago", "3d ago", or a locale date for older dates.
 */
interface RelativeTimeResult {
  key?: string;
  params?: Record<string, number>;
  fallbackDate?: string;
}

function getRelativeTimeKey(isoDate: string): RelativeTimeResult {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return { key: 'time_unknown' };
  const now = Date.now();
  const diffSeconds = Math.floor((now - date.getTime()) / 1000);

  if (diffSeconds < SECONDS_PER_MINUTE) {
    return { key: 'time_just_now' };
  }
  if (diffSeconds < SECONDS_PER_HOUR) {
    return {
      key: 'time_minutes_ago',
      params: { count: Math.floor(diffSeconds / SECONDS_PER_MINUTE) },
    };
  }
  if (diffSeconds < SECONDS_PER_DAY) {
    return { key: 'time_hours_ago', params: { count: Math.floor(diffSeconds / SECONDS_PER_HOUR) } };
  }
  if (diffSeconds < SECONDS_PER_WEEK) {
    return { key: 'time_days_ago', params: { count: Math.floor(diffSeconds / SECONDS_PER_DAY) } };
  }
  return { key: 'time_older', fallbackDate: date.toLocaleDateString() };
}

// =============================================================================
// VISUAL DIFFERENTIATION
// =============================================================================

function getCardBorderStyles(isStart: boolean, supervisor: boolean): string {
  if (isStart && supervisor) {
    return 'border-accent/30 ring-1 ring-accent/10';
  }
  if (isStart) {
    return 'border-accent/30';
  }
  if (supervisor) {
    return 'border-accent/30 border-l-2 border-l-accent';
  }
  return 'border-default';
}

function getIconContainerStyles(isStart: boolean, supervisor: boolean): string {
  if (isStart) {
    return 'bg-accent text-accent-foreground';
  }
  if (supervisor) {
    return 'bg-accent-subtle text-accent';
  }
  return 'bg-accent-subtle text-accent';
}

function getIcon(isStart: boolean, supervisor: boolean) {
  if (isStart) {
    return <Sparkles className="w-5 h-5" />;
  }
  if (supervisor) {
    return <Network className="w-5 h-5" />;
  }
  return <Bot className="w-5 h-5" />;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AgentCard({
  agent,
  summary,
  isStart,
  supervisor,
  onOpen,
  onChat,
  className,
  status,
  sessionActivity,
  sessionCount,
  handoffCount,
}: AgentCardProps) {
  const t = useTranslations('agents.card');
  const versions = parseActiveVersions(agent.activeVersions);
  const activeEnv = versions.production ? 'production' : versions.staging ? 'staging' : null;
  const activeVersion = activeEnv ? versions[activeEnv] : null;

  const displayName = formatAgentName(agent.name);
  const description = summary?.description ?? summary?.goal ?? agent.description;

  const relativeTime = getRelativeTimeKey(agent.updatedAt);
  const timeString = relativeTime.fallbackDate
    ? relativeTime.fallbackDate
    : t(relativeTime.key as any, relativeTime.params);

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
        'rounded-xl border bg-background-elevated p-5 cursor-pointer card-hover group focus-ring hover:border-gradient-brand',
        getCardBorderStyles(isStart, supervisor),
        className,
      )}
    >
      {/* Header: Icon + Name + Badges + Chat Button */}
      <div className="flex items-start gap-3">
        {/* Agent icon */}
        <div
          className={clsx(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            getIconContainerStyles(isStart, supervisor),
          )}
        >
          {getIcon(isStart, supervisor)}
        </div>

        {/* Name + badges row */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground truncate">{displayName}</h3>
            {/* Chat button - visible on hover */}
            <div className="ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-default">
              <Button
                variant="ghost"
                size="sm"
                icon={<Play className="w-3.5 h-3.5" />}
                onClick={(e) => {
                  e.stopPropagation();
                  onChat();
                }}
              >
                {t('chat')}
              </Button>
            </div>
          </div>

          {/* Badge row */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {supervisor && <Badge variant="accent">{t('supervisor')}</Badge>}
            {summary?.executionMode && (
              <Badge
                variant={
                  summary.executionMode === 'reasoning'
                    ? 'info'
                    : summary.executionMode === 'hybrid'
                      ? 'accent'
                      : 'default'
                }
              >
                {summary.executionMode === 'reasoning'
                  ? t('reasoning')
                  : summary.executionMode === 'hybrid'
                    ? 'Mixed'
                    : 'Flow'}
              </Badge>
            )}
            {activeVersion && (
              <Badge variant="success" dot>
                {t('active')}
              </Badge>
            )}
            {isStart && <Badge variant="accent">{t('start')}</Badge>}
          </div>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={clsx(
              'w-2 h-2 rounded-full',
              status === 'live' && 'bg-success',
              status === 'error' && 'bg-error animate-pulse-soft',
              (!status || status === 'draft') && 'bg-foreground-subtle/30',
            )}
          />
          <span
            className={clsx(
              'text-xs',
              status === 'live' && 'text-success',
              status === 'error' && 'text-error',
              (!status || status === 'draft') && 'text-subtle',
            )}
          >
            {status === 'live'
              ? t('status_live')
              : status === 'error'
                ? t('status_error')
                : t('status_draft')}
          </span>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-muted my-3" />

      {/* Description — fixed height for consistent card sizing */}
      <div className="mb-3 min-h-[2.625rem]">
        {description ? (
          <p className="line-clamp-2 text-sm text-muted leading-snug">{description}</p>
        ) : (
          <p className="text-sm text-subtle italic leading-snug">{t('no_description')}</p>
        )}
      </div>

      {/* Footer: sparkline + sessions + metadata */}
      <div className="flex items-center justify-between pt-3 border-t border-muted">
        <div className="flex items-center gap-2">
          <MiniSparkline data={sessionActivity ?? [0, 0, 0, 0, 0, 0, 0]} maxHeight={14} />
          <span className="text-xs text-muted">
            {sessionCount ?? 0} {t('sessions')}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-subtle">
          {summary != null && summary.toolsCount > 0 && (
            <span className="flex items-center gap-1">
              <Wrench className="w-3 h-3" /> {summary.toolsCount}
            </span>
          )}
          {handoffCount != null && handoffCount > 0 && (
            <span className="flex items-center gap-1">
              <ArrowRightLeft className="w-3 h-3" /> {handoffCount}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> {timeString}
          </span>
        </div>
      </div>
    </div>
  );
}
