/**
 * PipelineCard Component
 *
 * Renders a card for either a builtin or custom pipeline.
 * Uses a discriminated union for the two card types.
 *
 * Builtin card: name, description, enabled badge, trigger count, last processed time
 * Custom card: name, description, status badge, node count, created by, last modified, three-dot menu
 */

'use client';

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { MoreVertical, Copy, Archive, Trash2 } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';

// =============================================================================
// RELATIVE TIME HELPER
// =============================================================================

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_WEEK = 604800;

interface RelativeTimeResult {
  key?: string;
  params?: Record<string, number>;
  fallbackDate?: string;
}

function getRelativeTimeKey(isoDate: string): RelativeTimeResult {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return { key: 'time_just_now' };
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
    return {
      key: 'time_hours_ago',
      params: { count: Math.floor(diffSeconds / SECONDS_PER_HOUR) },
    };
  }
  if (diffSeconds < SECONDS_PER_WEEK) {
    return {
      key: 'time_days_ago',
      params: { count: Math.floor(diffSeconds / SECONDS_PER_DAY) },
    };
  }
  return { fallbackDate: date.toLocaleDateString() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TranslationFn = ReturnType<typeof useTranslations<any>>;

function formatRelativeTime(isoDate: string | null | undefined, t: TranslationFn): string | null {
  if (!isoDate) return null;
  const result = getRelativeTimeKey(isoDate);
  if (result.fallbackDate) return result.fallbackDate;
  if (result.key) return (t as any)(result.key, result.params);
  return null;
}

// =============================================================================
// TYPES
// =============================================================================

/** Summary returned by the runtime pipeline-config list-all endpoint */
export interface BuiltinPipelineSummary {
  pipelineType: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  activeTriggers: string[];
  lastProcessedAt: string | null;
}

/** Custom pipeline definition from the Studio pipelines API */
export interface CustomPipelineDefinition {
  _id: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'archived';
  nodes?: unknown[];
  steps?: unknown[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Health summary slice for a single pipeline (from byPipeline array) */
export interface PipelineHealth {
  total: number;
  failed: number;
  successRate: number;
}

type BuiltinCardProps = {
  kind: 'builtin';
  pipeline: BuiltinPipelineSummary;
  onClick: () => void;
  health?: PipelineHealth | null;
};

type CustomCardProps = {
  kind: 'custom';
  pipeline: CustomPipelineDefinition;
  onClick: () => void;
  onClone: () => void;
  onArchive: () => void;
  onDelete: () => void;
  health?: PipelineHealth | null;
};

export type PipelineCardProps = BuiltinCardProps | CustomCardProps;

// =============================================================================
// HEALTH DOT
// =============================================================================

const HEALTH_RATE_GREEN = 0.95;
const HEALTH_RATE_AMBER = 0.5;

type HealthColor = 'success' | 'warning' | 'error' | 'muted';

function getHealthColor(health: PipelineHealth | null | undefined): HealthColor {
  if (!health || health.total === 0) return 'muted';
  if (health.successRate > HEALTH_RATE_GREEN) return 'success';
  if (health.successRate >= HEALTH_RATE_AMBER) return 'warning';
  return 'error';
}

const HEALTH_DOT_CLASSES: Record<HealthColor, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  muted: 'bg-foreground-subtle/30',
};

const HEALTH_LABEL_KEYS: Record<HealthColor, string> = {
  success: 'health_dot_healthy',
  warning: 'health_dot_degraded',
  error: 'health_dot_unhealthy',
  muted: 'health_dot_no_runs',
};

function HealthDot({ health, t }: { health: PipelineHealth | null | undefined; t: TranslationFn }) {
  const color = getHealthColor(health);
  return (
    <span
      className={clsx('w-2 h-2 rounded-full shrink-0', HEALTH_DOT_CLASSES[color])}
      title={(t as ReturnType<typeof useTranslations>)(HEALTH_LABEL_KEYS[color])}
    />
  );
}

// =============================================================================
// STATUS BADGE HELPERS
// =============================================================================

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  draft: 'default',
  active: 'success',
  archived: 'warning',
};

const STATUS_KEYS: Record<string, string> = {
  draft: 'card_status_draft',
  active: 'card_status_active',
  archived: 'card_status_archived',
};

// =============================================================================
// COMPONENT
// =============================================================================

export function PipelineCard(props: PipelineCardProps) {
  if (props.kind === 'builtin') {
    return <BuiltinCard pipeline={props.pipeline} onClick={props.onClick} health={props.health} />;
  }

  return (
    <CustomCard
      pipeline={props.pipeline}
      onClick={props.onClick}
      onClone={props.onClone}
      onArchive={props.onArchive}
      onDelete={props.onDelete}
      health={props.health}
    />
  );
}

// =============================================================================
// BUILTIN CARD
// =============================================================================

function BuiltinCard({
  pipeline,
  onClick,
  health,
}: {
  pipeline: BuiltinPipelineSummary;
  onClick: () => void;
  health?: PipelineHealth | null;
}) {
  const t = useTranslations('pipelines');
  const lastProcessedStr = formatRelativeTime(pipeline.lastProcessedAt, t);

  return (
    <Card padding="none" hoverable={false} className="group relative">
      {/* Clickable area */}
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-4 cursor-pointer card-hover rounded-xl"
      >
        {/* Header: Name + Enabled badge + Health dot */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-foreground truncate">{pipeline.name}</h3>
          <div className="flex items-center gap-2 shrink-0">
            <HealthDot health={health} t={t} />
            <Badge variant={pipeline.enabled ? 'success' : 'default'} dot>
              {pipeline.enabled ? t('card_enabled') : t('card_disabled')}
            </Badge>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted line-clamp-2 mb-3">{pipeline.description}</p>

        {/* Footer: Triggers + Last processed */}
        <div className="flex items-center justify-between pt-3 border-t border-default">
          <span className="text-xs text-muted">
            {t('card_triggers', { count: pipeline.activeTriggers.length })}
          </span>
          <span className="text-xs text-subtle">
            {lastProcessedStr
              ? t('card_last_processed', { time: lastProcessedStr })
              : t('card_never_processed')}
          </span>
        </div>
      </button>
    </Card>
  );
}

// =============================================================================
// CUSTOM CARD
// =============================================================================

function CustomCard({
  pipeline,
  onClick,
  onClone,
  onArchive,
  onDelete,
  health,
}: {
  pipeline: CustomPipelineDefinition;
  onClick: () => void;
  onClone: () => void;
  onArchive: () => void;
  onDelete: () => void;
  health?: PipelineHealth | null;
}) {
  const t = useTranslations('pipelines');
  const nodeCount = pipeline.nodes?.length ?? pipeline.steps?.length ?? 0;
  const modifiedStr = formatRelativeTime(pipeline.updatedAt, t);

  const statusVariant = STATUS_VARIANTS[pipeline.status] ?? 'default';
  const statusKey = STATUS_KEYS[pipeline.status] ?? 'card_status_draft';

  return (
    <Card padding="none" hoverable={false}>
      {/* Clickable area */}
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-4 pb-0 cursor-pointer card-hover rounded-t-xl"
      >
        {/* Header: Name + Status badge + Health dot */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-foreground truncate">{pipeline.name}</h3>
          <div className="flex items-center gap-2 shrink-0">
            <HealthDot health={health} t={t} />
            <Badge variant={statusVariant} dot>
              {(t as any)(statusKey)}
            </Badge>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted line-clamp-2 mb-3">{pipeline.description || '\u00A0'}</p>

        {/* Metadata row: Nodes + Created by */}
        <div className="flex items-center gap-3 text-xs text-muted mb-3">
          <span>{t('card_nodes', { count: nodeCount })}</span>
          <span className="text-subtle">{t('card_created_by', { name: pipeline.createdBy })}</span>
        </div>
      </button>

      {/* Footer with menu */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-default">
        <span className="text-xs text-subtle">
          {modifiedStr ? t('card_last_modified', { time: modifiedStr }) : '\u00A0'}
        </span>

        {/* Three-dot menu */}
        <DropdownMenu
          trigger={
            <button
              type="button"
              className={clsx(
                'p-1 rounded-md text-muted hover:text-foreground',
                'hover:bg-background-muted transition-default',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="w-4 h-4" />
            </button>
          }
        >
          <DropdownMenuItem icon={<Copy className="w-4 h-4" />} onSelect={onClone}>
            {t('action_clone')}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Archive className="w-4 h-4" />} onSelect={onArchive}>
            {t('action_archive')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Trash2 className="w-4 h-4" />}
            onSelect={onDelete}
            variant="danger"
          >
            {t('action_delete')}
          </DropdownMenuItem>
        </DropdownMenu>
      </div>
    </Card>
  );
}
