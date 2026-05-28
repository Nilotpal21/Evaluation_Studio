/**
 * TracesExplorerTab Component
 *
 * Split-pane trace explorer with two sub-tabs: Traces and Generations.
 * Traces view: session list on the left, trace detail on the right
 *   with Timeline and Waterfall sub-views.
 * Generations view: flat table of all LLM generation calls with
 *   model, tokens, latency, cost.
 */

import { useState, useMemo, useCallback, memo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  Activity,
  Zap,
  Wrench,
  GitBranch,
  ArrowRightLeft,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Bot,
  LogIn,
  LogOut,
  MessageSquare,
  Play,
  Square,
  SlidersHorizontal,
  Columns,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { useSessionTraces, type SessionTrace } from '../../hooks/useSessionTraces';
import {
  useAnalyticsGenerations,
  useAnalyticsSessions,
  type AnalyticsGenerationItem,
  type TimeRange,
} from '../../hooks/useAnalytics';
import type { ExtendedTraceEvent, ExtendedTraceEventType, SessionListItem } from '../../types';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import {
  AnalyticsSkeleton,
  formatDuration,
  formatTokens,
  formatCost,
  formatNumber,
  formatTimestamp,
} from './shared';
import {
  EVENT_CARD_COLORS,
  DEFAULT_EVENT_COLORS,
  EVENT_DOT_COLORS,
  type EventColorConfig,
} from '../observatory/event-colors';
import { VirtualList } from '../shared/VirtualList';
import { SearchInput } from '../shared/SearchInput';
import {
  AdvancedFilterPanel,
  applyAdvancedFilters,
  type FilterColumn,
  type FilterRow,
} from '../shared/AdvancedFilterPanel';
import { ActiveFiltersStrip } from '../shared/ActiveFiltersStrip';
import { ColumnCustomizer, useColumnConfig, type ColumnConfig } from '../shared/ColumnCustomizer';
import { CsvExport } from '../shared/CsvExport';
import { ResetFiltersButton } from '../shared/ResetFiltersButton';
import { WaterfallPanel, type SpanSummary } from '../observatory/WaterfallPanel';
import { TraceCausalChips } from '../trace/TraceCausality';
import {
  buildSpanSummariesFromEvents,
  buildSpanSummaryTimeline,
  findSpanSummaryTimelineNode,
  flattenVisibleSpanSummaryTimelineNodes,
  type SpanSummaryTimelineNode,
} from '../../features/observatory/selectors';
import { usePersistedSurfaceFilters } from '../../hooks/usePersistedSurfaceFilters';
import { attachTraceCausalFieldsToData, getTraceCausalFields } from '../../utils/trace-causality';

// =============================================================================
// TYPES
// =============================================================================

interface TracesExplorerTabProps {
  projectId: string | null;
  timeRange: TimeRange;
  initialSessionId?: string | null;
}

type ExplorerSubTab = 'traces' | 'generations';

type TraceTypeFilter =
  | 'all'
  | 'llm_call'
  | 'tool_call'
  | 'decision'
  | 'handoff'
  | 'error'
  | 'agent';

const TRACE_TYPE_FILTERS: TraceTypeFilter[] = [
  'all',
  'llm_call',
  'tool_call',
  'decision',
  'handoff',
  'error',
  'agent',
];

type DetailView = 'timeline' | 'waterfall';
const ANALYTICS_SESSION_FETCH_LIMIT = 1_000;
const ANALYTICS_GENERATION_FETCH_LIMIT = 1_000;

// =============================================================================
// FILTER COLUMNS
// =============================================================================

const TRACE_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'trace_id', label: 'Trace ID', type: 'string' },
  { key: 'session_id', label: 'Session ID', type: 'string' },
  {
    key: 'event_type',
    label: 'Event Type',
    type: 'multi_select',
    options: [
      { label: 'LLM Call', value: 'llm_call' },
      { label: 'Tool Call', value: 'tool_call' },
      { label: 'Decision', value: 'decision' },
      { label: 'Handoff', value: 'handoff' },
      { label: 'Agent Enter', value: 'agent_enter' },
    ],
  },
  { key: 'latency', label: 'Latency (ms)', type: 'number' },
  { key: 'cost', label: 'Cost ($)', type: 'number' },
  { key: 'tokens', label: 'Tokens', type: 'number' },
  { key: 'timestamp', label: 'Timestamp', type: 'datetime' },
  { key: 'agent_name', label: 'Agent', type: 'string' },
  {
    key: 'has_error',
    label: 'Has Error',
    type: 'multi_select',
    options: [
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ],
  },
];

const GENERATION_FILTER_COLUMNS: FilterColumn[] = [
  { key: 'model', label: 'Model', type: 'string' },
  { key: 'name', label: 'Name', type: 'string' },
  { key: 'tokensIn', label: 'Input Tokens', type: 'number' },
  { key: 'tokensOut', label: 'Output Tokens', type: 'number' },
  { key: 'latencyMs', label: 'Latency (ms)', type: 'number' },
  { key: 'cost', label: 'Cost ($)', type: 'number' },
  { key: 'timestamp', label: 'Start Time', type: 'datetime' },
  { key: 'sessionId', label: 'Session', type: 'string' },
];

// =============================================================================
// GENERATION COLUMN CONFIG
// =============================================================================

const DEFAULT_GENERATION_COLUMNS: ColumnConfig[] = [
  { key: 'model', label: 'Model', visible: true, pinned: true, order: 0 },
  { key: 'name', label: 'Name', visible: true, order: 1 },
  { key: 'tokensIn', label: 'Input Tokens', visible: true, order: 2 },
  { key: 'tokensOut', label: 'Output Tokens', visible: true, order: 3 },
  { key: 'latencyMs', label: 'Latency', visible: true, order: 4 },
  { key: 'cost', label: 'Cost', visible: true, order: 5 },
  { key: 'timestamp', label: 'Start Time', visible: true, order: 6 },
  { key: 'sessionId', label: 'Session', visible: false, order: 7 },
];

// =============================================================================
// GENERATION TYPES
// =============================================================================

type GenerationRecord = AnalyticsGenerationItem;

// =============================================================================
// EVENT ICONS
// =============================================================================

function getEventIcon(eventType: string) {
  switch (eventType) {
    case 'llm_call':
      return Zap;
    case 'tool_call':
      return Wrench;
    case 'decision':
      return GitBranch;
    case 'handoff':
      return ArrowRightLeft;
    case 'escalation':
      return AlertCircle;
    case 'error':
      return AlertCircle;
    case 'agent_enter':
      return LogIn;
    case 'agent_exit':
      return LogOut;
    case 'delegate_start':
    case 'delegate_complete':
      return Bot;
    case 'flow_step_enter':
      return Play;
    case 'flow_step_exit':
      return Square;
    case 'flow_transition':
      return ArrowRightLeft;
    case 'user_message':
      return MessageSquare;
    default:
      return Activity;
  }
}

function getEventColors(eventType: string): EventColorConfig {
  return EVENT_CARD_COLORS[eventType] ?? DEFAULT_EVENT_COLORS;
}

function getStatusVariant(status: string): BadgeVariant {
  switch (status.toLowerCase()) {
    case 'active':
    case 'processing':
      return 'accent';
    case 'completed':
    case 'ended':
      return 'success';
    case 'escalated':
      return 'warning';
    case 'failed':
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

// =============================================================================
// EVENT SUMMARY HELPERS
// =============================================================================

function getEventSummary(trace: SessionTrace): string {
  const d = trace.data;
  switch (trace.event_type) {
    case 'llm_call': {
      const model = d.model || 'unknown';
      const tokensIn = d.input_tokens ?? d.tokensIn ?? 0;
      const tokensOut = d.output_tokens ?? d.tokensOut ?? 0;
      return `${model} \u2014 ${tokensIn}/${tokensOut} tok`;
    }
    case 'tool_call':
      return String(d.toolName || d.tool_name || 'unknown');
    case 'attachment_process': {
      const stage = d.stage === 'download' ? 'fetch' : String(d.stage || 'fetch');
      const filename = String(d.filename || d.externalAttachmentId || 'attachment');
      return `${stage} — ${filename}`;
    }
    case 'attachment_upload': {
      const filename = String(d.filename || d.attachmentId || 'attachment');
      return `ingest — ${filename}`;
    }
    case 'attachment_preprocess': {
      const summary = String(d.attachmentSummary || `${d.attachmentCount || 0} attachments`);
      const blocks =
        typeof d.contentBlockCount === 'number' ? ` — ${d.contentBlockCount} blocks` : '';
      return `${summary}${blocks}`;
    }
    case 'decision':
      return String(d.decisionKind || d.decision || 'routing');
    case 'handoff':
      return `${d.fromAgent || d.from_agent || '?'} \u2192 ${d.toAgent || d.to_agent || '?'}`;
    case 'escalation':
      return String(d.reason || 'escalated');
    case 'agent_enter':
      return `entered ${trace.agent_name || ''}`;
    case 'agent_exit':
      return `exited ${trace.agent_name || ''}`;
    case 'error':
      return String(d.message || d.error || 'error');
    case 'delegate_start':
    case 'delegate_complete':
      return `${d.fromAgent || d.from_agent || '?'} \u2192 ${d.targetAgent || d.to_agent || '?'}`;
    case 'flow_step_enter':
    case 'flow_step_exit':
      return String(d.stepName || d.step_name || 'unknown');
    case 'flow_transition':
      return `${d.fromStep || d.from_step || '?'} \u2192 ${d.toStep || d.to_step || '?'}`;
    default:
      return trace.event_type;
  }
}

const TRACE_TYPE_LABELS: Record<string, string> = {
  agent_enter: 'Agent Enter',
  agent_exit: 'Agent Exit',
  attachment_preprocess: 'Attachment Preprocess',
  attachment_process: 'Attachment Fetch',
  attachment_upload: 'Attachment Ingest',
  decision: 'Decision',
  delegate_complete: 'Delegate Complete',
  delegate_start: 'Delegate Start',
  error: 'Error',
  escalation: 'Escalation',
  flow_step_enter: 'Flow Step Enter',
  flow_step_exit: 'Flow Step Exit',
  flow_transition: 'Flow Transition',
  handoff: 'Handoff',
  llm_call: 'LLM Call',
  tool_call: 'Tool Call',
  user_message: 'User Message',
};

const UPPERCASE_TRACE_TOKENS = new Set(['asr', 'dsl', 'llm', 'stt', 'tts']);

function formatTraceTypeLabel(eventType: string): string {
  const directLabel = TRACE_TYPE_LABELS[eventType];
  if (directLabel) {
    return directLabel;
  }

  return eventType
    .split(/[_\.]/g)
    .filter(Boolean)
    .map((segment) =>
      UPPERCASE_TRACE_TOKENS.has(segment)
        ? segment.toUpperCase()
        : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(' ');
}

function buildExplorerTraceEvent(trace: SessionTrace, sessionId: string): ExtendedTraceEvent {
  const spanId = trace.span_id ?? trace.id;
  const startTime = new Date(trace.timestamp);
  const durationMs = trace.duration_ms ?? 0;
  const summaryText = getEventSummary(trace);
  const causalFields = getTraceCausalFields(trace);
  const data = attachTraceCausalFieldsToData(
    {
      ...(trace.data ?? {}),
      eventType: trace.event_type,
      hasError: trace.has_error ?? false,
      spanName: formatTraceTypeLabel(trace.event_type),
      summary: summaryText === trace.event_type ? undefined : summaryText,
    },
    causalFields,
  );

  return {
    id: trace.id,
    type: trace.event_type as ExtendedTraceEventType,
    timestamp: startTime,
    durationMs,
    traceId: trace.id,
    spanId,
    parentSpanId: trace.parent_span_id,
    sessionId,
    agentName: trace.agent_name ?? '',
    ...causalFields,
    data,
  };
}

function getSummaryEventType(summary: SpanSummary): string {
  return typeof summary.span.attributes.eventType === 'string'
    ? summary.span.attributes.eventType
    : summary.span.name;
}

function getSummarySubtitle(summary: SpanSummary): string {
  const agentName = summary.span.agentName.trim() || 'Unknown agent';
  const summaryText =
    typeof summary.span.attributes.summary === 'string'
      ? summary.span.attributes.summary.trim()
      : '';

  return summaryText ? `${agentName} • ${summaryText}` : agentName;
}

function hasTimelineDescendant(node: SpanSummaryTimelineNode, targetSpanId: string): boolean {
  return node.children.some(
    (child) =>
      child.summary.span.spanId === targetSpanId || hasTimelineDescendant(child, targetSpanId),
  );
}

function collectTimelineSpanIds(nodes: ReadonlyArray<SpanSummaryTimelineNode>): Set<string> {
  const spanIds = new Set<string>();

  const walk = (timelineNodes: ReadonlyArray<SpanSummaryTimelineNode>) => {
    for (const node of timelineNodes) {
      spanIds.add(node.summary.span.spanId);
      walk(node.children);
    }
  };

  walk(nodes);
  return spanIds;
}

// =============================================================================
// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function TracesExplorerTab({
  projectId,
  timeRange,
  initialSessionId,
}: TracesExplorerTabProps) {
  const t = useTranslations('analytics');
  const { sessions, isLoading: sessionsLoading } = useAnalyticsSessions(projectId, timeRange, {
    limit: ANALYTICS_SESSION_FETCH_LIMIT,
  });
  const {
    state: persistedTracesFilters,
    updateState: updateTracesFilters,
    reset: resetTracesFilters,
    nonDefaultCount: tracesNonDefaultCount,
    pageChips: tracesPageChips,
    clearPageChip: clearTracesPageChip,
  } = usePersistedSurfaceFilters('analyticsTraces', projectId);

  const activeSubTab = persistedTracesFilters.activeSubTab;
  const lastHandledInitialSessionIdRef = useRef<string | null>(null);

  // Traces view state
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const typeFilter = persistedTracesFilters.typeFilter;
  const [detailView, setDetailView] = useState<DetailView>('timeline');

  // Shared toolbar state
  const searchQuery = persistedTracesFilters.searchQuery;
  const filterRows = persistedTracesFilters.filterRows as FilterRow[];
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  useEffect(() => {
    if (!initialSessionId || lastHandledInitialSessionIdRef.current === initialSessionId) {
      return;
    }

    lastHandledInitialSessionIdRef.current = initialSessionId;
    setSelectedSessionId(initialSessionId);
    updateTracesFilters({ activeSubTab: 'traces' });
  }, [initialSessionId, updateTracesFilters]);

  // Time-range scoping already happens server-side in the ClickHouse-backed hook.
  const filteredSessions = sessions;

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    const hasSelectedSession = filteredSessions.some((session) => session.id === selectedSessionId);
    if (!hasSelectedSession) {
      setSelectedSessionId(null);
    }
  }, [filteredSessions, selectedSessionId]);

  // Fetch traces for selected session
  const { traces, isLoading: tracesLoading } = useSessionTraces(selectedSessionId, projectId, {
    limit: 500,
  });

  // Filter traces by type, search, and advanced filters
  const filteredTraces = useMemo(() => {
    let result = traces;
    if (typeFilter !== 'all') {
      if (typeFilter === 'agent') {
        result = result.filter(
          (tr) => tr.event_type === 'agent_enter' || tr.event_type === 'agent_exit',
        );
      } else if (typeFilter === 'error') {
        result = result.filter(
          (tr) => tr.has_error || tr.event_type === 'error' || tr.event_type === 'escalation',
        );
      } else {
        result = result.filter((tr) => tr.event_type === typeFilter);
      }
    }
    // Apply search filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (tr) =>
          tr.event_type.toLowerCase().includes(q) ||
          (tr.agent_name && tr.agent_name.toLowerCase().includes(q)) ||
          tr.id.toLowerCase().includes(q) ||
          getEventSummary(tr).toLowerCase().includes(q),
      );
    }
    // Apply advanced filters
    if (filterRows.length > 0) {
      result = applyAdvancedFilters(
        result as unknown as Record<string, unknown>[],
        filterRows,
        TRACE_FILTER_COLUMNS,
      ) as unknown as SessionTrace[];
    }
    return result;
  }, [traces, typeFilter, searchQuery, filterRows]);

  // Build waterfall spans from traces
  const waterfallSpans = useMemo<SpanSummary[]>(() => {
    const sessionId = selectedSessionId ?? '';
    return buildSpanSummariesFromEvents(
      filteredTraces.map((trace) => buildExplorerTraceEvent(trace, sessionId)),
    );
  }, [filteredTraces, selectedSessionId]);

  // CSV export handler for traces
  const handleTracesCsvExport = useCallback(async () => {
    const rows = filteredTraces.map((tr) => ({
      id: tr.id,
      event_type: tr.event_type,
      agent_name: tr.agent_name ?? '',
      duration_ms: tr.duration_ms ?? '',
      has_error: tr.has_error ? 'true' : 'false',
      timestamp: tr.timestamp,
    }));
    const header = Object.keys(rows[0] ?? {}).join(',');
    const body = rows
      .map((r) =>
        Object.values(r)
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\n');
    return new Blob([header + '\n' + body], { type: 'text/csv' });
  }, [filteredTraces]);

  if (sessionsLoading) return <AnalyticsSkeleton />;

  if (filteredSessions.length === 0 && activeSubTab === 'traces') {
    return (
      <div className="space-y-4">
        {/* Sub-tab bar */}
        <SubTabBar
          activeSubTab={activeSubTab}
          onSubTabChange={(tab) => updateTracesFilters({ activeSubTab: tab })}
        />
        <EmptyState
          icon={<Activity className="w-8 h-8" />}
          title={t('traces_explorer.empty_title')}
          description={t('traces_explorer.empty_description')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <SubTabBar
        activeSubTab={activeSubTab}
        onSubTabChange={(tab) => updateTracesFilters({ activeSubTab: tab })}
      />

      {/* Traces sub-tab */}
      {activeSubTab === 'traces' && (
        <>
          {/* Toolbar */}
          <div className="rounded-xl border border-default bg-background-elevated/70 p-3 shadow-sm space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput
                value={searchQuery}
                onChange={(value) => updateTracesFilters({ searchQuery: value })}
                placeholder="Search traces..."
                className="w-full sm:w-72"
              />

              <div className="ml-auto flex items-center gap-2">
                <ResetFiltersButton count={tracesNonDefaultCount} onClick={resetTracesFilters} />

                <button
                  onClick={() => setFilterPanelOpen(true)}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150',
                    'border-default text-muted bg-background-subtle hover:text-foreground hover:bg-background-muted',
                    'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
                    filterRows.length > 0 && 'text-accent border-accent bg-accent-subtle',
                  )}
                  aria-label="Open filters"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Filters
                  {filterRows.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground text-xs">
                      {filterRows.length}
                    </span>
                  )}
                </button>

                <CsvExport
                  onExport={handleTracesCsvExport}
                  filename="traces-export.csv"
                  disabled={filteredTraces.length === 0}
                />
              </div>
            </div>

            {/* Type filter pills */}
            <div className="flex items-center gap-1 flex-wrap">
              {TRACE_TYPE_FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => updateTracesFilters({ typeFilter: f })}
                  className={clsx(
                    'px-3 py-1.5 rounded-full text-xs font-medium transition-default',
                    typeFilter === f
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-background-muted text-muted hover:text-foreground',
                  )}
                >
                  {t(`traces_explorer.filter_${f}`)}
                </button>
              ))}
            </div>
          </div>

          <ActiveFiltersStrip
            pageChips={tracesPageChips}
            onRemovePageChip={clearTracesPageChip}
            advancedFilters={filterRows}
            advancedColumns={TRACE_FILTER_COLUMNS}
            onRemoveAdvancedFilter={(filterId) =>
              updateTracesFilters({
                filterRows: filterRows.filter((filter) => filter.id !== filterId),
              })
            }
            onClearAll={resetTracesFilters}
          />

          {/* Split pane */}
          <div className="flex gap-4 min-h-[600px]">
            {/* Left panel — Session list */}
            <div className="w-[340px] shrink-0 bg-background-elevated border border-default rounded-xl overflow-hidden flex flex-col">
              <div className="px-4 py-3 border-b border-default">
                <h3 className="text-sm font-medium text-foreground">
                  {t('traces_explorer.sessions_title')}
                </h3>
                <p className="text-xs text-muted">
                  {filteredSessions.length} {t('traces_explorer.sessions_count')}
                </p>
              </div>
              <div className="overflow-y-auto flex-1">
                {filteredSessions.map((session) => (
                  <SessionListEntry
                    key={session.id}
                    session={session}
                    isSelected={session.id === selectedSessionId}
                    onClick={() => setSelectedSessionId(session.id)}
                  />
                ))}
              </div>
            </div>

            {/* Right panel — Trace detail */}
            <div className="flex-1 bg-background-elevated border border-default rounded-xl overflow-hidden flex flex-col">
              {selectedSessionId ? (
                <>
                  {/* Detail sub-tabs */}
                  <div className="flex items-center gap-1 px-4 py-2 border-b border-default">
                    {(['timeline', 'waterfall'] as DetailView[]).map((view) => (
                      <button
                        key={view}
                        onClick={() => setDetailView(view)}
                        className={clsx(
                          'px-3 py-1.5 rounded-md text-xs font-medium transition-default',
                          detailView === view
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted hover:text-foreground',
                        )}
                      >
                        {view === 'timeline' ? 'Timeline' : 'Waterfall'}
                      </button>
                    ))}
                    <span className="ml-auto text-xs text-muted">
                      {filteredTraces.length} {t('traces_explorer.events_count')}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="flex-1 overflow-y-auto p-4">
                    {tracesLoading ? (
                      <div className="space-y-3 animate-pulse">
                        {Array.from({ length: 6 }).map((_, i) => (
                          <div key={i} className="skeleton h-12 w-full rounded-lg" />
                        ))}
                      </div>
                    ) : filteredTraces.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-muted text-sm">
                        {t('traces_explorer.no_traces')}
                      </div>
                    ) : detailView === 'timeline' ? (
                      <TraceTimeline traces={filteredTraces} t={t} />
                    ) : (
                      <WaterfallPanel spans={waterfallSpans} mode="historical">
                        <ExplorerWaterfallList spans={waterfallSpans} />
                      </WaterfallPanel>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted text-sm">
                  {t('traces_explorer.select_session')}
                </div>
              )}
            </div>
          </div>

          {/* Advanced filter slideout */}
          <AdvancedFilterPanel
            open={filterPanelOpen}
            onClose={() => setFilterPanelOpen(false)}
            columns={TRACE_FILTER_COLUMNS}
            filters={filterRows}
            onChange={(nextFilters) => updateTracesFilters({ filterRows: nextFilters })}
          />
        </>
      )}

      {/* Generations sub-tab */}
      {activeSubTab === 'generations' && (
        <GenerationsTab projectId={projectId} timeRange={timeRange} />
      )}
    </div>
  );
}

function ExplorerWaterfallList({ spans }: { spans: ReadonlyArray<SpanSummary> }) {
  const timeline = useMemo(() => buildSpanSummaryTimeline(spans), [spans]);
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<Set<string>>(() => new Set());
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const allSpanIds = useMemo(() => collectTimelineSpanIds(timeline.roots), [timeline.roots]);
  const visibleNodes = useMemo(
    () => flattenVisibleSpanSummaryTimelineNodes(timeline.roots, collapsedSpanIds),
    [timeline.roots, collapsedSpanIds],
  );
  const selectedNode = useMemo(
    () => (selectedSpanId ? findSpanSummaryTimelineNode(timeline.roots, selectedSpanId) : null),
    [timeline.roots, selectedSpanId],
  );

  useEffect(() => {
    setCollapsedSpanIds((current) => {
      let changed = false;
      const next = new Set<string>();

      for (const spanId of current) {
        if (allSpanIds.has(spanId)) {
          next.add(spanId);
        } else {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [allSpanIds]);

  useEffect(() => {
    setSelectedSpanId((current) => {
      if (!current || allSpanIds.has(current)) {
        return current;
      }
      return null;
    });
  }, [allSpanIds]);

  const handleSelect = useCallback((spanId: string) => {
    setSelectedSpanId((current) => (current === spanId ? null : spanId));
  }, []);

  const handleToggleCollapse = useCallback(
    (node: SpanSummaryTimelineNode) => {
      const spanId = node.summary.span.spanId;
      const isCollapsed = collapsedSpanIds.has(spanId);

      if (
        !isCollapsed &&
        selectedSpanId &&
        selectedSpanId !== spanId &&
        hasTimelineDescendant(node, selectedSpanId)
      ) {
        setSelectedSpanId(spanId);
      }

      setCollapsedSpanIds((current) => {
        const next = new Set(current);
        if (next.has(spanId)) {
          next.delete(spanId);
        } else {
          next.add(spanId);
        }
        return next;
      });
    },
    [collapsedSpanIds, selectedSpanId],
  );

  if (timeline.roots.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No waterfall spans available.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(250px,320px)_minmax(0,1fr)] gap-3 border-b border-default bg-background-elevated/95 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted backdrop-blur supports-[backdrop-filter]:bg-background-elevated/85">
        <span>Span Lane</span>
        <div className="flex items-center justify-between gap-3">
          <span>{timeline.startTime ? formatTimestamp(timeline.startTime) : '--'}</span>
          <span>{formatDuration(timeline.totalDurationMs)}</span>
          <span>{timeline.endTime ? formatTimestamp(timeline.endTime) : '--'}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-2 p-3">
          {visibleNodes.map((node) => (
            <ExplorerWaterfallRow
              key={node.summary.span.spanId}
              node={node}
              isCollapsed={collapsedSpanIds.has(node.summary.span.spanId)}
              isSelected={selectedSpanId === node.summary.span.spanId}
              onSelect={handleSelect}
              onToggleCollapse={handleToggleCollapse}
            />
          ))}
        </div>
      </div>

      {selectedNode ? (
        <ExplorerWaterfallDetail node={selectedNode} />
      ) : (
        <div className="border-t border-default bg-background-subtle px-4 py-3 text-xs text-muted">
          Select a span to inspect its timing, hierarchy, and shared Observatory metrics.
        </div>
      )}
    </div>
  );
}

function ExplorerWaterfallRow({
  node,
  isCollapsed,
  isSelected,
  onSelect,
  onToggleCollapse,
}: {
  node: SpanSummaryTimelineNode;
  isCollapsed: boolean;
  isSelected: boolean;
  onSelect: (spanId: string) => void;
  onToggleCollapse: (node: SpanSummaryTimelineNode) => void;
}) {
  const { summary, children, depth } = node;
  const { span } = summary;
  const hasChildren = children.length > 0;
  const StatusIcon = span.status === 'error' ? XCircle : CheckCircle2;
  const eventType = getSummaryEventType(summary);
  const eventTypeLabel = formatTraceTypeLabel(eventType);
  const eventColors = getEventColors(eventType);
  const timelineBarClass =
    span.status === 'error'
      ? 'border-error/40 bg-error-subtle text-error'
      : clsx('border-default', eventColors.bgColor, eventColors.textColor);
  const dotColor =
    span.status === 'error' ? 'bg-error' : (EVENT_DOT_COLORS[eventType] ?? 'bg-background-muted');
  const barWidthPct = node.widthPct === 100 ? 100 : Math.max(node.widthPct, 1.5);
  const offsetLabel = node.offsetMs > 0 ? `+${formatDuration(node.offsetMs)}` : '0ms';

  return (
    <div
      className={clsx(
        'grid grid-cols-[minmax(250px,320px)_minmax(0,1fr)] gap-3 rounded-2xl border transition-colors',
        isSelected
          ? 'border-accent bg-accent-subtle/30 shadow-sm'
          : 'border-default bg-background-subtle hover:bg-background-muted',
      )}
    >
      <div className="flex min-w-0 items-start gap-2 px-3 py-3">
        <div
          className="flex shrink-0 items-center gap-1"
          style={{ paddingLeft: `${depth * 18}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => onToggleCollapse(node)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-background hover:text-foreground"
              aria-label={isCollapsed ? 'Expand span children' : 'Collapse span children'}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          ) : (
            <span className="h-7 w-7 shrink-0" />
          )}
        </div>

        <button
          type="button"
          onClick={() => onSelect(span.spanId)}
          className="min-w-0 flex-1 text-left"
          aria-pressed={isSelected}
        >
          <div className="flex items-start gap-2">
            <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', dotColor)} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{span.name}</span>
                {eventTypeLabel !== span.name && (
                  <span
                    className={clsx(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                      eventColors.bgColor,
                      eventColors.textColor,
                    )}
                  >
                    {eventTypeLabel}
                  </span>
                )}
                <StatusIcon
                  className={clsx(
                    'h-4 w-4 shrink-0',
                    span.status === 'error' ? 'text-error' : 'text-success',
                  )}
                />
              </div>

              <div className="truncate text-xs text-muted">
                {getSummarySubtitle(summary)}
                {hasChildren
                  ? ` • ${children.length} child span${children.length === 1 ? '' : 's'}`
                  : ''}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <ExplorerWaterfallMetricChip value={formatDuration(node.durationMs)} />
                {summary.totalTokens !== undefined && (
                  <ExplorerWaterfallMetricChip value={formatTokens(summary.totalTokens)} />
                )}
                {summary.cost !== undefined && (
                  <ExplorerWaterfallMetricChip value={formatCost(summary.cost)} />
                )}
              </div>
            </div>
          </div>
        </button>
      </div>

      <button
        type="button"
        onClick={() => onSelect(span.spanId)}
        className="px-3 py-3 text-left"
        aria-pressed={isSelected}
      >
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted">
            <span>{offsetLabel}</span>
            <span className="truncate">{formatTimestamp(span.startTime)}</span>
          </div>

          <div className="relative h-8 overflow-hidden rounded-full border border-default bg-background">
            <div
              className="absolute inset-y-0 left-0 bg-background-muted/60"
              style={{ width: `${node.offsetPct}%` }}
            />
            <div
              className={clsx('absolute inset-y-0 rounded-full border shadow-sm', timelineBarClass)}
              style={{
                left: `${node.offsetPct}%`,
                width: `${barWidthPct}%`,
                minWidth: barWidthPct > 0 && barWidthPct < 100 ? '12px' : undefined,
              }}
            />
            <div
              className={clsx(
                'absolute inset-y-0 flex items-center px-3 text-[11px] font-medium',
                span.status === 'error' ? 'text-error' : eventColors.textColor,
              )}
              style={{
                left: `${node.offsetPct}%`,
                width: `${barWidthPct}%`,
                minWidth: barWidthPct > 0 && barWidthPct < 100 ? '12px' : undefined,
              }}
            >
              {barWidthPct >= 12 ? formatDuration(node.durationMs) : ''}
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}

function ExplorerWaterfallDetail({ node }: { node: SpanSummaryTimelineNode }) {
  const { summary, durationMs, offsetMs } = node;
  const { span } = summary;
  const eventType = getSummaryEventType(summary);
  const eventTypeLabel = formatTraceTypeLabel(eventType);
  const eventColors = getEventColors(eventType);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-t border-default bg-background-subtle px-4 py-3">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-start justify-between gap-4 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-foreground">{span.name}</h4>
            {eventTypeLabel !== span.name && (
              <span
                className={clsx(
                  'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  eventColors.bgColor,
                  eventColors.textColor,
                )}
              >
                {eventTypeLabel}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{getSummarySubtitle(summary)}</span>
            <span className="font-mono">{span.spanId}</span>
            <span>{formatDuration(durationMs)}</span>
            {summary.totalTokens !== undefined && <span>{formatTokens(summary.totalTokens)}</span>}
            {summary.cost !== undefined && <span>{formatCost(summary.cost)}</span>}
          </div>
        </div>

        <span className="shrink-0 text-xs font-medium text-accent">
          {expanded ? 'Hide details' : 'Show details'}
        </span>
      </button>

      {expanded ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <ExplorerWaterfallDetailField label="Started" value={formatTimestamp(span.startTime)} />
          <ExplorerWaterfallDetailField
            label="Ended"
            value={span.endTime ? formatTimestamp(span.endTime) : 'In progress'}
          />
          <ExplorerWaterfallDetailField label="Offset" value={formatDuration(offsetMs)} />
          <ExplorerWaterfallDetailField label="Status" value={formatTraceTypeLabel(span.status)} />
          <ExplorerWaterfallDetailField label="Span ID" value={span.spanId} mono />
          <ExplorerWaterfallDetailField label="Trace ID" value={span.traceId} mono />
          <ExplorerWaterfallDetailField
            label="Parent Span"
            value={span.parentSpanId ?? 'Root'}
            mono
          />
          <ExplorerWaterfallDetailField
            label="Children"
            value={formatNumber(node.children.length)}
          />
        </div>
      ) : null}
    </div>
  );
}

function ExplorerWaterfallMetricChip({ value }: { value: string }) {
  return (
    <span className="rounded-full border border-default bg-background px-2 py-0.5 text-[11px] font-medium text-muted">
      {value}
    </span>
  );
}

function ExplorerWaterfallDetailField({
  label,
  mono = false,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-default bg-background px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
        {label}
      </div>
      <div className={clsx('mt-1 text-xs text-foreground', mono && 'font-mono break-all')}>
        {value}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-TAB BAR
// =============================================================================

function SubTabBar({
  activeSubTab,
  onSubTabChange,
}: {
  activeSubTab: ExplorerSubTab;
  onSubTabChange: (tab: ExplorerSubTab) => void;
}) {
  const tabs: { id: ExplorerSubTab; label: string }[] = [
    { id: 'traces', label: 'Traces' },
    { id: 'generations', label: 'Generations' },
  ];

  return (
    <div className="flex items-center gap-0 border-b border-default">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSubTabChange(tab.id)}
          className={clsx(
            'relative px-4 py-2 text-sm font-medium transition-default',
            activeSubTab === tab.id ? 'text-foreground' : 'text-muted hover:text-foreground',
          )}
        >
          {tab.label}
          {activeSubTab === tab.id && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-t" />
          )}
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// GENERATIONS TAB
// =============================================================================

function GenerationsTab({
  projectId,
  timeRange,
}: {
  projectId: string | null;
  timeRange: TimeRange;
}) {
  const { columns, setColumns, visibleColumns, reset } = useColumnConfig(
    'generations-table-cols',
    DEFAULT_GENERATION_COLUMNS,
  );
  const {
    state: persistedGenerationFilters,
    updateState,
    reset: resetGenerationFilters,
    nonDefaultCount,
    pageChips,
    clearPageChip,
  } = usePersistedSurfaceFilters('analyticsGenerations', projectId);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const searchQuery = persistedGenerationFilters.searchQuery;
  const filterRows = persistedGenerationFilters.filterRows as FilterRow[];

  const { generations, isLoading } = useAnalyticsGenerations(projectId, timeRange, {
    limit: ANALYTICS_GENERATION_FETCH_LIMIT,
  });

  // Apply search and advanced filters
  const filteredGenerations = useMemo(() => {
    let result = generations;

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (generation) =>
          generation.model.toLowerCase().includes(q) ||
          generation.name.toLowerCase().includes(q) ||
          generation.provider.toLowerCase().includes(q) ||
          generation.sessionId.toLowerCase().includes(q),
      );
    }

    if (filterRows.length > 0) {
      result = applyAdvancedFilters(
        result as unknown as Record<string, unknown>[],
        filterRows,
        GENERATION_FILTER_COLUMNS,
      ) as unknown as GenerationRecord[];
    }

    return result;
  }, [filterRows, generations, searchQuery]);

  // CSV export handler
  const handleCsvExport = useCallback(async () => {
    const header = visibleColumns.map((c) => c.label).join(',');
    const body = filteredGenerations
      .map((g) =>
        visibleColumns
          .map((c) => {
            const val = g[c.key as keyof GenerationRecord];
            return `"${String(val ?? '').replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\n');
    return new Blob([header + '\n' + body], { type: 'text/csv' });
  }, [filteredGenerations, visibleColumns]);

  // Render cell value
  const renderCellValue = useCallback((col: ColumnConfig, gen: GenerationRecord) => {
    switch (col.key) {
      case 'latencyMs':
        return formatDuration(gen.latencyMs);
      case 'cost':
        return formatCost(gen.cost);
      case 'tokensIn':
      case 'tokensOut':
        return (gen[col.key as keyof GenerationRecord] as number).toLocaleString();
      case 'timestamp':
        return formatTimestamp(gen.timestamp);
      default:
        return String(gen[col.key as keyof GenerationRecord] ?? '');
    }
  }, []);

  if (isLoading) return <AnalyticsSkeleton />;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="rounded-xl border border-default bg-background-elevated/70 p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={searchQuery}
            onChange={(value) => updateState({ searchQuery: value })}
            placeholder="Search generations..."
            className="w-full sm:w-72"
          />

          <div className="ml-auto flex items-center gap-2">
            <ResetFiltersButton count={nonDefaultCount} onClick={resetGenerationFilters} />

            <button
              onClick={() => setFilterPanelOpen(true)}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150',
                'border-default text-muted bg-background-subtle hover:text-foreground hover:bg-background-muted',
                'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
                filterRows.length > 0 && 'text-accent border-accent bg-accent-subtle',
              )}
              aria-label="Open generation filters"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filters
              {filterRows.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground text-xs">
                  {filterRows.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setColumnPanelOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-default bg-background-subtle px-3 py-2 text-xs font-medium text-muted transition-colors duration-150 hover:text-foreground hover:bg-background-muted focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none"
              aria-label="Customize generation columns"
            >
              <Columns className="w-3.5 h-3.5" />
              Columns
            </button>

            <CsvExport
              onExport={handleCsvExport}
              filename="generations-export.csv"
              disabled={filteredGenerations.length === 0}
            />
          </div>
        </div>
      </div>

      <ActiveFiltersStrip
        pageChips={pageChips}
        onRemovePageChip={clearPageChip}
        advancedFilters={filterRows}
        advancedColumns={GENERATION_FILTER_COLUMNS}
        onRemoveAdvancedFilter={(filterId) =>
          updateState({
            filterRows: filterRows.filter((filter) => filter.id !== filterId),
          })
        }
        onClearAll={resetGenerationFilters}
      />

      {/* Table */}
      {filteredGenerations.length === 0 ? (
        <EmptyState
          icon={<Zap className="w-8 h-8" />}
          title="No generations"
          description="No LLM generation calls found for the selected time range."
        />
      ) : (
        <div className="bg-background-elevated border border-default rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default bg-background-subtle">
                  {visibleColumns.map((col) => (
                    <th
                      key={col.key}
                      className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {filteredGenerations.map((gen) => (
                  <tr
                    key={gen.id}
                    className="hover:bg-background-subtle transition-colors duration-150"
                  >
                    {visibleColumns.map((col) => (
                      <td key={col.key} className="px-4 py-3 text-foreground text-xs">
                        {renderCellValue(col, gen)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2 border-t border-default bg-background-subtle">
            <span className="text-xs text-muted">
              {filteredGenerations.length} generation{filteredGenerations.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      )}

      {/* Slideout panels */}
      <AdvancedFilterPanel
        open={filterPanelOpen}
        onClose={() => setFilterPanelOpen(false)}
        columns={GENERATION_FILTER_COLUMNS}
        filters={filterRows}
        onChange={(nextFilters) => updateState({ filterRows: nextFilters })}
      />

      <ColumnCustomizer
        open={columnPanelOpen}
        onClose={() => setColumnPanelOpen(false)}
        columns={columns}
        onChange={setColumns}
        onReset={reset}
      />
    </div>
  );
}

// =============================================================================
// SESSION LIST ENTRY
// =============================================================================

const SessionListEntry = memo(function SessionListEntry({
  session,
  isSelected,
  onClick,
}: {
  session: SessionListItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  const statusVariant = getStatusVariant(session.status);

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left px-4 py-3 border-b border-default transition-colors duration-150',
        'focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-1 outline-none',
        isSelected ? 'bg-accent-subtle' : 'hover:bg-background-subtle',
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-sm font-medium text-foreground truncate max-w-[150px]"
          title={session.agentName}
        >
          {session.agentName}
        </span>
        <Badge variant={statusVariant} dot={session.status.toLowerCase() === 'active'}>
          {session.status}
        </Badge>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>{session.traceEventCount} spans</span>
        <span>{session.messageCount} turns</span>
        <span>{formatDuration(session.durationMs)}</span>
      </div>
      <div
        className="text-xs text-muted mt-0.5 font-mono truncate max-w-[200px]"
        title={session.id}
      >
        {session.id.slice(0, 12)}...
      </div>
    </button>
  );
});

// =============================================================================
// TRACE TIMELINE
// =============================================================================

/** Threshold below which we skip virtualization overhead. */
const TRACE_VIRTUALIZATION_THRESHOLD = 50;

function TraceTimeline({
  traces,
  t,
}: {
  traces: SessionTrace[];
  t: ReturnType<typeof useTranslations>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const renderTraceItem = useCallback(
    (trace: SessionTrace) => {
      const colors = getEventColors(trace.event_type);
      const Icon = getEventIcon(trace.event_type);
      const isExpanded = expandedId === trace.id;
      const summary = getEventSummary(trace);

      return (
        <div key={trace.id}>
          <button
            onClick={() => setExpandedId(isExpanded ? null : trace.id)}
            className={clsx(
              'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-default',
              isExpanded ? colors.bgColor : 'hover:bg-background-subtle',
            )}
          >
            {/* Icon */}
            <div
              className={clsx(
                'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
                colors.bgColor,
              )}
            >
              <Icon className={clsx('w-3.5 h-3.5', colors.iconColor)} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={clsx('text-xs font-medium', colors.textColor)}>
                  {trace.event_type}
                </span>
                {trace.agent_name && <span className="text-xs text-muted">{trace.agent_name}</span>}
              </div>
              <div className="text-xs text-muted truncate">{summary}</div>
              <TraceCausalChips event={trace} compact className="mt-1 flex flex-wrap gap-1" />
            </div>

            {/* Duration */}
            {trace.duration_ms != null && trace.duration_ms > 0 && (
              <span className="text-xs text-muted shrink-0">
                {formatDuration(trace.duration_ms)}
              </span>
            )}

            {/* Error badge */}
            {trace.has_error && <Badge variant="error">error</Badge>}

            {/* Expand indicator */}
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-muted shrink-0" />
            )}
          </button>

          {/* Detail panel */}
          {isExpanded && <TraceDetailPanel trace={trace} t={t} />}
        </div>
      );
    },
    [expandedId, t],
  );

  // For small lists, render directly without virtualization overhead
  if (traces.length < TRACE_VIRTUALIZATION_THRESHOLD) {
    return <div className="space-y-1">{traces.map((trace) => renderTraceItem(trace))}</div>;
  }

  // For large trace lists (1000+), virtualize for constant-time rendering
  return (
    <VirtualList
      items={traces}
      estimateSize={52}
      overscan={10}
      className="h-full"
      renderItem={renderTraceItem}
    />
  );
}

// =============================================================================
// TRACE DETAIL PANEL
// =============================================================================

function TraceDetailPanel({
  trace,
  t,
}: {
  trace: SessionTrace;
  t: ReturnType<typeof useTranslations>;
}) {
  const [showRawData, setShowRawData] = useState(false);
  const colors = getEventColors(trace.event_type);
  const data = trace.data;

  return (
    <div className="ml-4 mb-2 p-3 bg-background-subtle border border-default rounded-lg text-xs space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={getEventTypeBadgeVariant(trace.event_type)}>{trace.event_type}</Badge>
        {trace.agent_name && <span className="text-muted">{trace.agent_name}</span>}
        {trace.duration_ms != null && trace.duration_ms > 0 && (
          <span className="text-muted">{formatDuration(trace.duration_ms)}</span>
        )}
        <span className="text-muted">{formatTimestamp(trace.timestamp)}</span>
        <TraceCausalChips event={trace} compact className="ml-auto flex flex-wrap gap-1" />
      </div>

      {/* Type-specific fields */}
      {trace.event_type === 'llm_call' && <LLMCallDetail data={data} />}
      {trace.event_type === 'tool_call' && <ToolCallDetail data={data} />}
      {(trace.event_type === 'handoff' || trace.event_type === 'escalation') && (
        <HandoffDetail data={data} />
      )}
      {trace.event_type === 'error' && <ErrorDetail data={data} />}
      {(trace.event_type === 'agent_enter' || trace.event_type === 'agent_exit') && (
        <AgentDetail data={data} eventType={trace.event_type} />
      )}
      {(trace.event_type === 'user_message' || trace.event_type === 'agent_response') && (
        <MessageDetail data={data} />
      )}
      {trace.event_type === 'session_created' && <SessionStartDetail data={data} />}
      {trace.event_type === 'decision' && <DecisionDetail data={data} />}
      {(trace.event_type === 'flow_step_enter' || trace.event_type === 'flow_step_exit') && (
        <FlowStepDetail data={data} />
      )}
      {trace.event_type === 'flow_transition' && <FlowTransitionDetail data={data} />}
      {trace.event_type === 'constraint_check' && <ConstraintDetail data={data} />}
      {trace.event_type === 'delegate_start' && <DelegateDetail data={data} />}
      {trace.event_type === 'session_updated' && <SessionUpdatedDetail data={data} />}
      {trace.event_type === 'session_ended' && <SessionEndedDetail data={data} />}

      {/* Raw data toggle */}
      <button
        onClick={() => setShowRawData(!showRawData)}
        className="text-info hover:underline text-xs"
      >
        {showRawData ? t('traces_explorer.hide_raw') : t('traces_explorer.show_raw')}
      </button>
      {showRawData && (
        <pre className="p-2 bg-background-muted rounded text-xs overflow-x-auto max-h-64 font-mono text-foreground">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function getEventTypeBadgeVariant(eventType: string): BadgeVariant {
  switch (eventType) {
    case 'llm_call':
      return 'purple';
    case 'tool_call':
      return 'warning';
    case 'decision':
      return 'purple';
    case 'handoff':
      return 'info';
    case 'escalation':
      return 'warning';
    case 'error':
      return 'error';
    case 'agent_enter':
    case 'agent_exit':
      return 'success';
    default:
      return 'default';
  }
}

// =============================================================================
// TYPE-SPECIFIC DETAIL VIEWS
// =============================================================================

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className="text-foreground font-medium">{value}</div>
    </div>
  );
}

function DetailBool({ label, value }: { label: string; value: boolean }) {
  return (
    <div>
      <div className="text-muted">{label}</div>
      <div className={clsx('font-medium', value ? 'text-success' : 'text-muted')}>
        {value ? 'Yes' : 'No'}
      </div>
    </div>
  );
}

function CollapsibleSection({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="col-span-full">
      <button
        onClick={() => setOpen(!open)}
        className="text-info hover:underline text-xs flex items-center gap-1"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {label}
      </button>
      {open && children}
    </div>
  );
}

function CollapsibleJSON({ label, data }: { label: string; data: unknown }) {
  if (data == null) return null;
  return (
    <CollapsibleSection label={label}>
      <pre className="mt-1 p-2 bg-background-muted rounded text-xs overflow-x-auto max-h-64 font-mono text-foreground">
        {typeof data === 'string' ? data : JSON.stringify(data, null, 2)}
      </pre>
    </CollapsibleSection>
  );
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  system: { bg: 'bg-background-muted', text: 'text-muted' },
  user: { bg: 'bg-info-subtle', text: 'text-info' },
  assistant: { bg: 'bg-purple-subtle', text: 'text-purple' },
  tool: { bg: 'bg-warning-subtle', text: 'text-warning' },
};

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          if (block.type === 'tool_use')
            return `[tool_use: ${block.name ?? 'unknown'}(${JSON.stringify(block.input ?? {})})]`;
          if (block.type === 'tool_result')
            return `[tool_result: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')}]`;
          return JSON.stringify(block);
        }
        return String(block);
      })
      .join('\n');
  }
  if (content != null && typeof content === 'object') return JSON.stringify(content, null, 2);
  return content != null ? String(content) : '';
}

function LLMMessagesView({ messages }: { messages: Array<{ role: string; content: unknown }> }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  if (!messages?.length) return null;

  return (
    <CollapsibleSection label={`Messages (${messages.length})`}>
      <div className="mt-1 space-y-1.5 max-h-80 overflow-y-auto">
        {messages.map((msg, i) => {
          const roleStyle = ROLE_COLORS[msg.role] || ROLE_COLORS.user;
          const isExpanded = expandedIdx === i;
          const content = normalizeContent(msg.content);
          const isTruncated = content.length > 300 && !isExpanded;

          return (
            <div key={i} className="p-2 bg-background-muted rounded text-xs">
              <span
                className={clsx(
                  'inline-block px-1.5 py-0.5 rounded text-xs font-medium mr-2',
                  roleStyle.bg,
                  roleStyle.text,
                )}
              >
                {msg.role}
              </span>
              <span className="text-foreground whitespace-pre-wrap break-words">
                {isTruncated ? content.slice(0, 300) + '...' : content}
              </span>
              {content.length > 300 && (
                <button
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  className="ml-1 text-info hover:underline text-xs"
                >
                  {isExpanded ? 'less' : 'more'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function LLMResponseView({ response }: { response: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!response) return null;
  const isTruncated = response.length > 500 && !expanded;

  return (
    <CollapsibleSection label="Response">
      <div className="mt-1 p-2 bg-background-muted rounded text-xs text-foreground whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
        {isTruncated ? response.slice(0, 500) + '...' : response}
        {response.length > 500 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-1 text-info hover:underline text-xs"
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </div>
    </CollapsibleSection>
  );
}

function LLMCallDetail({ data }: { data: Record<string, unknown> }) {
  const usage =
    typeof data.usage === 'object' && data.usage !== null
      ? (data.usage as Record<string, unknown>)
      : null;
  const inputTokens = Number(data.input_tokens ?? data.tokensIn ?? usage?.inputTokens ?? 0);
  const outputTokens = Number(data.output_tokens ?? data.tokensOut ?? usage?.outputTokens ?? 0);
  const totalTokens = Number(data.total_tokens ?? usage?.totalTokens ?? inputTokens + outputTokens);
  const cost = Number(data.estimated_cost ?? data.cost ?? 0);
  const latency = Number(data.latency_ms ?? data.duration_ms ?? data.latencyMs ?? 0);
  const ttft = Number(data.time_to_first_token_ms ?? 0);
  const cacheCreation = Number(data.cache_creation_tokens ?? usage?.cacheCreationInputTokens ?? 0);
  const cacheRead = Number(data.cache_read_tokens ?? usage?.cacheReadInputTokens ?? 0);
  const streaming = data.streaming_used ?? data.streaming;
  const toolCallCount = Number(data.tool_call_count ?? 0);

  // Full payload fields from TraceStore (logLLMCall stores messages + response)
  const messages = Array.isArray(data.messages)
    ? (data.messages as Array<{ role: string; content: string }>)
    : null;
  const response = typeof data.response === 'string' ? data.response : null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <DetailField label="Model" value={String(data.model || 'unknown')} />
        <DetailField label="Provider" value={String(data.provider || 'unknown')} />
        <DetailField label="Input Tokens" value={formatTokens(inputTokens)} />
        <DetailField label="Output Tokens" value={formatTokens(outputTokens)} />
        <DetailField label="Total Tokens" value={formatTokens(totalTokens)} />
        {cost > 0 && <DetailField label="Cost" value={formatCost(cost)} />}
        {latency > 0 && <DetailField label="Latency" value={formatDuration(latency)} />}
        {ttft > 0 && <DetailField label="Time to First Token" value={formatDuration(ttft)} />}
        {streaming != null && <DetailBool label="Streaming" value={Boolean(streaming)} />}
        {cacheCreation > 0 && (
          <DetailField label="Cache Creation Tokens" value={formatTokens(cacheCreation)} />
        )}
        {cacheRead > 0 && <DetailField label="Cache Read Tokens" value={formatTokens(cacheRead)} />}
        {toolCallCount > 0 && <DetailField label="Tool Calls" value={String(toolCallCount)} />}
        {data.finish_reason != null && (
          <DetailField label="Finish Reason" value={String(data.finish_reason)} />
        )}
        {data.stop_reason != null && (
          <DetailField label="Stop Reason" value={String(data.stop_reason)} />
        )}
      </div>

      {/* Full request/response from TraceStore */}
      {messages && <LLMMessagesView messages={messages} />}
      {response && <LLMResponseView response={response} />}
    </div>
  );
}

function ToolCallDetail({ data }: { data: Record<string, unknown> }) {
  const latency = Number(data.latency_ms ?? data.duration_ms ?? data.latencyMs ?? 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <DetailField label="Tool" value={String(data.toolName || data.tool_name || 'unknown')} />
        {data.tool_type != null && <DetailField label="Type" value={String(data.tool_type)} />}
        {latency > 0 && <DetailField label="Latency" value={formatDuration(latency)} />}
        {data.success != null && <DetailBool label="Success" value={Boolean(data.success)} />}
        {data.success === false && data.error_type != null && (
          <DetailField label="Error Type" value={String(data.error_type)} />
        )}
        {data.success === false &&
          (data.error || data.errorMessage || data.error_message) != null && (
            <div className="col-span-full text-error text-xs">
              {String(data.error || data.errorMessage || data.error_message)}
            </div>
          )}
      </div>

      {/* Full input/output from TraceStore (logToolCall stores input + output) */}
      <CollapsibleJSON label="Input" data={data.input} />
      <CollapsibleJSON label="Output" data={data.output} />
    </div>
  );
}

function HandoffDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <DetailField label="From" value={String(data.fromAgent || data.from_agent || '?')} />
      <DetailField
        label="To"
        value={String(data.toAgent || data.to_agent || data.targetAgent || '?')}
      />
      {data.reason != null && <DetailField label="Reason" value={String(data.reason)} />}
      {data.priority != null && <DetailField label="Priority" value={String(data.priority)} />}
      {data.return_expected != null && (
        <DetailBool label="Return Expected" value={Boolean(data.return_expected)} />
      )}
    </div>
  );
}

function ErrorDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      {data.error_type != null && (
        <div className="text-error font-medium">{String(data.error_type)}</div>
      )}
      <div className="text-error">
        {String(data.message || data.error || data.error_message || 'Unknown error')}
      </div>
      {data.stack != null && (
        <pre className="p-2 bg-background-muted rounded text-xs overflow-x-auto max-h-32 font-mono text-muted">
          {String(data.stack)}
        </pre>
      )}
    </div>
  );
}

function AgentDetail({ data, eventType }: { data: Record<string, unknown>; eventType: string }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.mode != null && <DetailField label="Mode" value={String(data.mode)} />}
      {data.trigger != null && <DetailField label="Trigger" value={String(data.trigger)} />}
      {eventType === 'agent_exit' && data.result != null && (
        <DetailField label="Result" value={String(data.result)} />
      )}
      {data.duration_ms != null && Number(data.duration_ms) > 0 && (
        <DetailField label="Duration" value={formatDuration(Number(data.duration_ms))} />
      )}
      {data.execution_mode != null && (
        <DetailField label="Execution Mode" value={String(data.execution_mode)} />
      )}
    </div>
  );
}

function MessageDetail({ data }: { data: Record<string, unknown> }) {
  const contentLength = Number(data.content_length ?? 0);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.channel != null && <DetailField label="Channel" value={String(data.channel)} />}
      {contentLength > 0 && (
        <DetailField label="Content Length" value={formatNumber(contentLength)} />
      )}
      {data.has_attachments != null && (
        <DetailBool label="Attachments" value={Boolean(data.has_attachments)} />
      )}
      {Number(data.attachment_count ?? 0) > 0 && (
        <DetailField label="Attachment Count" value={String(data.attachment_count)} />
      )}
      {data.has_rich_content != null && (
        <DetailBool label="Rich Content" value={Boolean(data.has_rich_content)} />
      )}
      {data.duration_ms != null && Number(data.duration_ms) > 0 && (
        <DetailField label="Duration" value={formatDuration(Number(data.duration_ms))} />
      )}
    </div>
  );
}

function SessionStartDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.channel != null && <DetailField label="Channel" value={String(data.channel)} />}
      {data.agent_name != null && <DetailField label="Agent" value={String(data.agent_name)} />}
      {data.deployment_id != null && (
        <DetailField label="Deployment" value={String(data.deployment_id)} />
      )}
      {data.resolution_method != null && (
        <DetailField label="Resolution" value={String(data.resolution_method)} />
      )}
      {data.caller_identity_tier != null && (
        <DetailField label="Identity Tier" value={String(data.caller_identity_tier)} />
      )}
      {data.project_id != null && <DetailField label="Project" value={String(data.project_id)} />}
    </div>
  );
}

function DecisionDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {data.decisionKind != null && (
          <DetailField label="Type" value={String(data.decisionKind)} />
        )}
        {data.decision != null && <DetailField label="Decision" value={String(data.decision)} />}
      </div>
      {data.reasoning != null && (
        <div>
          <div className="text-muted mb-0.5">Reasoning</div>
          <div className="text-foreground text-xs bg-background-muted rounded p-2">
            {String(data.reasoning)}
          </div>
        </div>
      )}
      <CollapsibleJSON
        label="Context Snapshot"
        data={data.contextSnapshot || data.context_snapshot}
      />
    </div>
  );
}

function FlowStepDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.step_name != null && <DetailField label="Step" value={String(data.step_name)} />}
      {data.step_type != null && <DetailField label="Type" value={String(data.step_type)} />}
      {data.duration_ms != null && Number(data.duration_ms) > 0 && (
        <DetailField label="Duration" value={formatDuration(Number(data.duration_ms))} />
      )}
    </div>
  );
}

function FlowTransitionDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <DetailField label="From Step" value={String(data.from_step || data.fromStep || '?')} />
      <DetailField label="To Step" value={String(data.to_step || data.toStep || '?')} />
      {data.condition != null && <DetailField label="Condition" value={String(data.condition)} />}
    </div>
  );
}

function ConstraintDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.constraint_name != null && (
        <DetailField label="Constraint" value={String(data.constraint_name)} />
      )}
      {data.passed != null && <DetailBool label="Passed" value={Boolean(data.passed)} />}
      {data.violation_type != null && (
        <DetailField label="Violation Type" value={String(data.violation_type)} />
      )}
      {data.handler_action != null && (
        <DetailField label="Handler Action" value={String(data.handler_action)} />
      )}
    </div>
  );
}

function DelegateDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <DetailField label="From Agent" value={String(data.from_agent || data.fromAgent || '?')} />
      <DetailField label="To Agent" value={String(data.to_agent || data.targetAgent || '?')} />
      {data.task_summary != null && <DetailField label="Task" value={String(data.task_summary)} />}
      {data.success != null && <DetailBool label="Success" value={Boolean(data.success)} />}
      {data.duration_ms != null && Number(data.duration_ms) > 0 && (
        <DetailField label="Duration" value={formatDuration(Number(data.duration_ms))} />
      )}
    </div>
  );
}

function SessionUpdatedDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.update_source != null && (
        <DetailField label="Source" value={String(data.update_source)} />
      )}
      {data.update_count != null && (
        <DetailField label="Updates" value={String(data.update_count)} />
      )}
      {data.keys_updated != null && (
        <DetailField
          label="Keys Updated"
          value={
            Array.isArray(data.keys_updated)
              ? (data.keys_updated as string[]).join(', ')
              : String(data.keys_updated)
          }
        />
      )}
    </div>
  );
}

function SessionEndedDetail({ data }: { data: Record<string, unknown> }) {
  const totalDuration = Number(data.total_duration_ms ?? 0);
  const totalTokens = Number(data.total_tokens ?? 0);
  const totalCost = Number(data.estimated_cost ?? data.total_cost ?? 0);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {data.reason != null && <DetailField label="Reason" value={String(data.reason)} />}
      {totalDuration > 0 && (
        <DetailField label="Total Duration" value={formatDuration(totalDuration)} />
      )}
      {data.total_turns != null && <DetailField label="Turns" value={String(data.total_turns)} />}
      {data.total_llm_calls != null && (
        <DetailField label="LLM Calls" value={String(data.total_llm_calls)} />
      )}
      {data.total_tool_calls != null && (
        <DetailField label="Tool Calls" value={String(data.total_tool_calls)} />
      )}
      {totalTokens > 0 && <DetailField label="Total Tokens" value={formatTokens(totalTokens)} />}
      {totalCost > 0 && <DetailField label="Total Cost" value={formatCost(totalCost)} />}
      {data.message_count != null && (
        <DetailField label="Messages" value={String(data.message_count)} />
      )}
    </div>
  );
}
