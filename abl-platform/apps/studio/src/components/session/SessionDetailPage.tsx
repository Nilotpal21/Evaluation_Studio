/**
 * SessionDetailPage
 *
 * Full-page two-panel session detail view.
 * Left (~35%): Agent execution tree
 * Right (~65%): MetricsBar + DebugTabs
 *
 * Rendered when currentView === 'session-detail'.
 */

'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { ArrowLeft, Activity, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useNavigationStore } from '../../store/navigation-store';
import {
  useSessionDetail,
  type TraceLoadStatus,
  type TraceResponseMeta,
} from '../../hooks/useSessionDetail';
import { useObservatoryStore } from '../../store/observatory-store';
import { AgentExecutionTree } from './AgentExecutionTree';
import { MetricsBar } from './MetricsBar';
import { DebugTabs } from '../observatory/DebugTabs';
import { Button } from '../ui/Button';
import { SessionIdDisplay } from './SessionIdDisplay';
import type { TreeNode } from '../../hooks/useSessionDetail';

const MIN_LEFT_WIDTH = 250;
const MAX_LEFT_PERCENT = 60;
const DEFAULT_LEFT_PERCENT = 35;

interface SessionDetailPageProps {
  sessionId?: string | null;
  spanId?: string | null;
}

export function SessionDetailPage({
  sessionId: sessionIdFromRoute,
  spanId: spanIdFromRoute,
}: SessionDetailPageProps = {}) {
  const projectId = useNavigationStore((s) => s.projectId);
  const selectedSessionIdFromStore = useNavigationStore((s) => s.subPage);
  const selectedSessionId =
    sessionIdFromRoute || selectedSessionIdFromStore || getSessionIdFromCurrentPath();
  const navigate = useNavigationStore((s) => s.navigate);
  const t = useTranslations('sessions.detail');
  const tSessions = useTranslations('sessions');
  const tSummary = useTranslations('sessions.summary');

  // Arch v0.3 — context is auto-detected via buildPageContext() from nav store.

  const { session, loading, error, refresh, tree, metrics } = useSessionDetail(
    selectedSessionId,
    projectId,
  );

  const selectedExecutionNodeId = useObservatoryStore((s) => s.selection.executionNodeId);
  const selectExecutionNode = useObservatoryStore((s) => s.selectExecutionNode);
  const selectSpan = useObservatoryStore((s) => s.selectSpan);
  const setDebugPanelTab = useObservatoryStore((s) => s.setDebugPanelTab);

  const [leftPercent, setLeftPercent] = useState(DEFAULT_LEFT_PERCENT);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleBack = () => {
    if (projectId) {
      navigate(`/projects/${projectId}/sessions`);
    }
  };

  useEffect(() => {
    if (!spanIdFromRoute) return;
    setDebugPanelTab('traces');
    selectSpan(spanIdFromRoute);
    const matchingNode = findTreeNodeBySpanId(tree, spanIdFromRoute);
    if (matchingNode) {
      selectExecutionNode(matchingNode.id);
    }
  }, [selectExecutionNode, selectSpan, setDebugPanelTab, spanIdFromRoute, tree]);

  // Horizontal drag resize (left/right columns)
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.clientWidth;
      const startX = e.clientX;
      const startPercent = leftPercent;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        const dxPercent = (dx / containerWidth) * 100;
        const newPercent = startPercent + dxPercent;

        const minPercent = (MIN_LEFT_WIDTH / containerWidth) * 100;
        if (newPercent >= minPercent && newPercent <= MAX_LEFT_PERCENT) {
          setLeftPercent(newPercent);
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [leftPercent],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="shrink-0 border-b border-default bg-background-elevated/95 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div className="min-w-0 flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft className="h-4 w-4" />}
              onClick={handleBack}
              className="shrink-0"
              title={t('back_to_sessions')}
              aria-label={t('back_to_sessions')}
            >
              <span className="hidden sm:inline">{t('back_to_sessions')}</span>
            </Button>
            <div className="min-w-0">
              <h1 className="min-w-0 text-lg font-semibold text-foreground">
                <SessionIdDisplay
                  sessionId={selectedSessionId}
                  copyValue={selectedSessionId}
                  copyLabel={tSessions('copy_id')}
                  copiedLabel={tSummary('copied')}
                  valueClassName="text-lg font-semibold text-foreground"
                  copyButtonClassName="opacity-70 hover:opacity-100"
                  iconClassName="h-3.5 w-3.5"
                />
              </h1>
              <p className="truncate text-xs text-muted">{session?.agentName || '--'}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
            <TraceSourceBadge
              meta={session?.traceMeta}
              status={session?.traceLoadStatus}
              error={session?.traceLoadError}
            />
            <HeaderStat
              icon={<Activity className="h-3.5 w-3.5 text-info" />}
              label={t('traces_label')}
              value={session?.traceEvents.length || 0}
            />
            {metrics.totalTokens > 0 && (
              <HeaderStat label={t('tokens_label')} value={metrics.totalTokens.toLocaleString()} />
            )}
            <HeaderStat
              label={t('session_cost_label')}
              value={metrics.totalCost > 0 ? `$${metrics.totalCost.toFixed(6)}` : '—'}
            />
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 px-6 py-8">
          <div className="flex h-full items-center justify-center rounded-xl border border-default bg-background-elevated shadow-sm">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
            <span className="ml-3 text-sm font-medium text-muted">{t('loading_session')}</span>
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 px-6 py-8">
          <div className="flex h-full items-center justify-center rounded-xl border border-error/30 bg-background-elevated shadow-sm">
            <div className="text-center">
              <p className="mb-2 text-sm font-medium text-error">{error}</p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={refresh} className="text-sm font-medium text-info hover:underline">
                  {t('retry')}
                </button>
                <span className="text-subtle">|</span>
                <button
                  onClick={handleBack}
                  className="text-sm font-medium text-info hover:underline"
                >
                  {t('back_to_sessions')}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="flex min-h-0 flex-1 gap-3 overflow-hidden p-4">
          {/* Left column — Agent Execution Tree */}
          <div
            className="h-full overflow-hidden rounded-xl border border-default bg-background-elevated shadow-sm"
            style={{ width: `${leftPercent}%` }}
          >
            <div className="flex h-full flex-col">
              <div className="border-b border-default bg-background-subtle px-4 py-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                  {t('conversation_header')}
                </h3>
              </div>
              <div className="min-h-0 flex-1">
                <AgentExecutionTree
                  tree={tree}
                  selectedNodeId={selectedExecutionNodeId}
                  onSelectNode={selectExecutionNode}
                />
              </div>
            </div>
          </div>

          {/* Horizontal resize divider */}
          <div
            className="group relative flex w-3 cursor-col-resize items-center justify-center shrink-0"
            onMouseDown={startResize}
          >
            <div className="h-full w-px bg-border transition-colors group-hover:bg-accent/40" />
          </div>

          {/* Right column — MetricsBar + Debug Tabs */}
          <div
            className="h-full overflow-hidden rounded-xl border border-default bg-background-elevated shadow-sm"
            style={{ width: `${100 - leftPercent}%` }}
          >
            <div className="flex h-full flex-col overflow-hidden">
              {/* Persistent metrics strip */}
              <MetricsBar
                cost={metrics.totalCost}
                tokens={metrics.totalTokens}
                latencyMs={metrics.latencyMs}
                finishedAt={session?.lastActivityAt}
              />

              {/* Debug Tabs (includes Traces waterfall, Context, IR, etc.) */}
              <div className="min-h-0 flex-1 overflow-hidden">
                <DebugTabs
                  tracesMode="historical"
                  traceEvents={session?.traceEvents}
                  tree={tree}
                  sessionId={selectedSessionId || undefined}
                  projectId={projectId || undefined}
                  agentName={session?.agentName}
                  messageCount={session?.messageCount ?? session?.messages.length}
                  createdAt={session?.createdAt}
                  finishedAt={session?.lastActivityAt}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getSessionIdFromCurrentPath(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'projects' || parts[2] !== 'sessions') {
    return null;
  }

  return parts[3] ? decodeURIComponent(parts[3]) : null;
}

function findTreeNodeBySpanId(nodes: TreeNode[], spanId: string): TreeNode | null {
  for (const node of nodes) {
    if (node.spanId === spanId) {
      return node;
    }
    const childMatch = findTreeNodeBySpanId(node.children, spanId);
    if (childMatch) {
      return childMatch;
    }
  }
  return null;
}

function TraceSourceBadge({
  meta,
  status,
  error,
}: {
  meta?: TraceResponseMeta;
  status?: TraceLoadStatus;
  error?: string;
}) {
  if (!meta && (!status || status === 'idle')) {
    return null;
  }

  const warnings = Array.isArray(meta?.warnings) ? meta.warnings : [];
  const errors = Array.isArray(meta?.errors) ? meta.errors : [];
  const sourceChain = Array.isArray(meta?.source_chain) ? meta.source_chain : [];
  const hasDiagnostics = Boolean(error || meta?.is_truncated || warnings.length || errors.length);
  const sourceLabel = formatTraceSource(meta?.source);
  const statusLabel =
    status === 'failed'
      ? 'failed'
      : status === 'loading'
        ? 'loading'
        : hasDiagnostics
          ? 'partial'
          : 'complete';
  const titleParts = [
    sourceChain.length ? `sources: ${sourceChain.join(' -> ')}` : undefined,
    typeof meta?.loaded_count === 'number' ? `loaded: ${meta.loaded_count}` : undefined,
    typeof meta?.available_count === 'number' ? `available: ${meta.available_count}` : undefined,
    meta?.is_truncated ? 'truncated' : undefined,
    error ? `error: ${error}` : undefined,
    ...warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ...errors.map((traceError) => `${traceError.code}: ${traceError.message}`),
  ].filter(Boolean);

  return (
    <span
      className={[
        'inline-flex items-center rounded border px-2 py-1 text-xs font-medium',
        status === 'failed' || errors.length
          ? 'border-error/30 bg-error/10 text-error'
          : hasDiagnostics
            ? 'border-warning/30 bg-warning/10 text-warning'
            : 'border-success/30 bg-success/10 text-success',
      ].join(' ')}
      title={titleParts.join('\n')}
    >
      Trace: {sourceLabel} / {statusLabel}
    </span>
  );
}

function formatTraceSource(source?: string): string {
  if (source === 'memory') {
    return 'live';
  }
  if (source === 'clickhouse_platform_events') {
    return 'history';
  }
  return source || 'unknown';
}

function HeaderStat({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="text-foreground-subtle">{label}:</span>
      <span className="font-semibold text-foreground">{value}</span>
    </div>
  );
}
