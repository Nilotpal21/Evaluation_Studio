/**
 * TracesPage
 *
 * Span/execution-unit explorer for project traces.
 */

import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useTraceExplorer } from '../../hooks/useTraceExplorer';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { formatCost } from '../../utils/llm-cost';
import { formatAgentName } from '../../lib/format/agent-name';
import type { TraceExplorerRow } from '../../types';
import {
  FilterToolbar,
  MultiSelectFilter,
  SearchFilter,
  TimePresetFilter,
  columnHighlight,
  uniqueOptions,
} from '../session/ExplorerFilterControls';

type TraceDatePreset = 'last-24h' | 'last-7d' | 'last-30d' | 'all';

const PAGE_SIZE = 50;
const TRACE_DATE_PRESETS: Array<{ value: TraceDatePreset; label: string }> = [
  { value: 'last-24h', label: 'Last 24 hours' },
  { value: 'last-7d', label: 'Last 7 days' },
  { value: 'last-30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];
const TRACE_TYPE_OPTIONS = [
  { value: 'llm_call', label: 'LLM calls' },
  { value: 'tool_call', label: 'Tool calls' },
  { value: 'agent', label: 'Agents' },
  { value: 'session', label: 'Sessions' },
  { value: 'error', label: 'Errors' },
  { value: 'span', label: 'Spans' },
];
const TRACE_STATUS_OPTIONS = [
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Errors' },
];
const REASONING_FALLBACK_TOOLTIP =
  "Rule didn't match; LLM made this routing decision. This usually means the WHEN condition is broken or under-specified. See validation diagnostics.";

export function TracesPage() {
  const { projectId, navigate } = useNavigationStore();
  const [search, setSearch] = useState('');
  const [agentFilters, setAgentFilters] = useState<string[]>([]);
  const [environmentFilters, setEnvironmentFilters] = useState<string[]>([]);
  const [channelFilters, setChannelFilters] = useState<string[]>([]);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<Array<'ok' | 'error'>>([]);
  const [datePreset, setDatePreset] = useState<TraceDatePreset>('last-7d');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSearch(params.get('q') ?? '');
    setAgentFilters(parseUrlList(params.get('agentName')));
    setEnvironmentFilters(parseUrlList(params.get('environment')));
    setChannelFilters(parseUrlList(params.get('channel')));
    setTypeFilters(parseUrlList(params.get('type')));
    setStatusFilters(
      parseUrlList(params.get('status')).filter((value): value is 'ok' | 'error' =>
        ['ok', 'error'].includes(value),
      ),
    );
    setDatePreset(parseTraceDatePreset(params.get('range')));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (agentFilters.length > 0) params.set('agentName', agentFilters.join(','));
    if (environmentFilters.length > 0) params.set('environment', environmentFilters.join(','));
    if (channelFilters.length > 0) params.set('channel', channelFilters.join(','));
    if (typeFilters.length > 0) params.set('type', typeFilters.join(','));
    if (statusFilters.length > 0) params.set('status', statusFilters.join(','));
    if (datePreset !== 'all') params.set('range', datePreset);
    const suffix = params.toString();
    window.history.replaceState(null, '', suffix ? `?${suffix}` : window.location.pathname);
  }, [
    agentFilters,
    channelFilters,
    datePreset,
    environmentFilters,
    search,
    statusFilters,
    typeFilters,
  ]);

  const filters = useMemo(
    () => ({
      q: search || undefined,
      agentName: agentFilters,
      environment: environmentFilters,
      channel: channelFilters,
      type: typeFilters,
      status: statusFilters,
      range: traceDatePresetToRange(datePreset),
      sortBy: 'startedAt',
      sortDir: 'desc' as const,
      limit: PAGE_SIZE,
      offset: 0,
    }),
    [
      agentFilters,
      channelFilters,
      datePreset,
      environmentFilters,
      search,
      statusFilters,
      typeFilters,
    ],
  );

  const { traces, total, isLoading, error } = useTraceExplorer(projectId, filters);
  const agentOptions = useMemo(
    () =>
      uniqueOptions(
        traces.map((trace) => trace.agentName),
        agentFilters,
      ),
    [agentFilters, traces],
  );
  const environmentOptions = useMemo(
    () =>
      uniqueOptions(
        traces.map((trace) => trace.environment),
        environmentFilters,
      ),
    [environmentFilters, traces],
  );
  const channelOptions = useMemo(
    () =>
      uniqueOptions(
        traces.map((trace) => trace.channel),
        channelFilters,
      ),
    [channelFilters, traces],
  );

  const handleRowClick = (trace: TraceExplorerRow) => {
    navigate(
      `/projects/${projectId}/sessions/${encodeURIComponent(trace.sessionId)}/traces/${encodeURIComponent(trace.spanId)}`,
    );
  };

  return (
    <div className="space-y-4 bg-noise">
      <h2 className="text-base font-semibold text-foreground">Traces</h2>
      <FilterToolbar resultCount={total} resultLabel="spans">
        <SearchFilter
          value={search}
          onChange={setSearch}
          placeholder="Search trace, span, session"
        />
        <MultiSelectFilter
          label="Agent"
          values={agentFilters}
          options={agentOptions}
          onChange={setAgentFilters}
        />
        <MultiSelectFilter
          label="Environment"
          values={environmentFilters}
          options={environmentOptions}
          onChange={setEnvironmentFilters}
        />
        <MultiSelectFilter
          label="Channel"
          values={channelFilters}
          options={channelOptions}
          onChange={setChannelFilters}
        />
        <MultiSelectFilter
          label="Type"
          values={typeFilters}
          options={TRACE_TYPE_OPTIONS}
          onChange={setTypeFilters}
        />
        <MultiSelectFilter
          label="Status"
          values={statusFilters}
          options={TRACE_STATUS_OPTIONS}
          onChange={(values) =>
            setStatusFilters(
              values.filter((value): value is 'ok' | 'error' => ['ok', 'error'].includes(value)),
            )
          }
        />
        <TimePresetFilter
          value={datePreset}
          options={TRACE_DATE_PRESETS}
          onChange={setDatePreset}
        />
      </FilterToolbar>

      <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px]">
            <thead>
              <tr className="border-b border-default bg-background-muted/40 text-left text-xs text-muted">
                <th className="px-3 py-3 font-medium">Span</th>
                <th className="px-3 py-3 font-medium">Session</th>
                <th
                  className={`px-3 py-3 font-medium ${agentFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                >
                  Agent
                </th>
                <th
                  className={`px-3 py-3 font-medium ${typeFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                >
                  Type
                </th>
                <th
                  className={`px-3 py-3 font-medium ${statusFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                >
                  Status
                </th>
                <th
                  className={`px-3 py-3 font-medium ${environmentFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                >
                  Environment
                </th>
                <th
                  className={`px-3 py-3 font-medium ${channelFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                >
                  Channel
                </th>
                <th className="px-3 py-3 font-medium text-right">Latency</th>
                <th className="px-3 py-3 font-medium text-right">Tokens</th>
                <th className="px-3 py-3 font-medium text-right">Cost</th>
                <th className="px-3 py-3 font-medium text-right">Events</th>
                <th className="px-3 py-3 font-medium">Preview</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && traces.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-sm text-muted">
                    Loading traces...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-sm text-error">
                    Failed to load traces.
                  </td>
                </tr>
              ) : traces.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10">
                    <EmptyState
                      icon={<Activity className="h-7 w-7" />}
                      title="No traces found"
                      description="Adjust your filters or run a session to capture trace spans."
                    />
                  </td>
                </tr>
              ) : (
                traces.map((trace) => (
                  <TraceRow
                    key={`${trace.traceId}:${trace.spanId}`}
                    trace={trace}
                    activeColumns={{
                      agent: agentFilters.length > 0,
                      type: typeFilters.length > 0,
                      status: statusFilters.length > 0,
                      environment: environmentFilters.length > 0,
                      channel: channelFilters.length > 0,
                    }}
                    onClick={handleRowClick}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TraceRow({
  trace,
  activeColumns,
  onClick,
}: {
  trace: TraceExplorerRow;
  activeColumns: {
    agent: boolean;
    type: boolean;
    status: boolean;
    environment: boolean;
    channel: boolean;
  };
  onClick: (trace: TraceExplorerRow) => void;
}) {
  return (
    <tr
      onClick={() => onClick(trace)}
      className="cursor-pointer border-b border-muted transition-default hover:bg-background-muted"
    >
      <td className="px-3 py-3 font-mono text-xs text-accent">{shortId(trace.spanId)}</td>
      <td className="px-3 py-3 font-mono text-xs text-muted">{shortId(trace.sessionId)}</td>
      <td className={`px-3 py-3 text-sm text-foreground ${activeColumns.agent ? 'bg-info/5' : ''}`}>
        {trace.agentName ? formatAgentName(trace.agentName) : 'Unknown'}
      </td>
      <td className={`px-3 py-3 ${activeColumns.type ? 'bg-info/5' : ''}`}>
        <Badge variant={trace.status === 'error' ? 'error' : 'default'}>{trace.type}</Badge>
      </td>
      <td className={`px-3 py-3 text-sm ${columnHighlight(activeColumns.status)}`}>
        <div className="flex flex-col gap-1">
          <span>{trace.status}</span>
          {trace.warnings
            ?.filter((warning) => warning.code === 'REASONING_FALLBACK')
            .map((warning) => (
              <span key={warning.code} title={formatTraceWarningTitle(warning)} className="w-fit">
                <Badge
                  variant="warning"
                  appearance="outlined"
                  className="w-fit"
                  testid="trace-reasoning-fallback-warning"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Reasoning fallback
                </Badge>
              </span>
            ))}
          {trace.warnings
            ?.filter((warning) => warning.code === 'OPENAI_RESPONSES_REASONING_ITEM_MISSING')
            .map((warning) => (
              <span key={warning.code} title={formatTraceWarningTitle(warning)} className="w-fit">
                <Badge
                  variant="warning"
                  appearance="outlined"
                  className="w-fit"
                  testid="trace-llm-operator-diagnostic-warning"
                >
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Model diagnostic
                </Badge>
              </span>
            ))}
          {trace.operatorDiagnostics?.map((diagnostic) => (
            <span
              key={`${diagnostic.code}:${diagnostic.traceId}`}
              title={formatOperatorDiagnosticTitle(diagnostic)}
              className="flex max-w-[220px] flex-col gap-0.5"
            >
              <Badge
                variant={diagnostic.severity === 'error' ? 'error' : 'warning'}
                appearance="outlined"
                className="w-fit"
                testid="trace-runtime-error-envelope"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Diagnostic
              </Badge>
              <span className="truncate font-mono text-[11px] leading-4 text-muted">
                {diagnostic.code}
              </span>
            </span>
          ))}
        </div>
      </td>
      <td className={`px-3 py-3 text-sm ${columnHighlight(activeColumns.environment)}`}>
        {trace.environment ?? '-'}
      </td>
      <td className={`px-3 py-3 text-sm ${columnHighlight(activeColumns.channel)}`}>
        {trace.channel ?? '-'}
      </td>
      <td className="px-3 py-3 text-right text-sm text-muted">
        {trace.durationMs == null ? '-' : formatDuration(trace.durationMs)}
      </td>
      <td className="px-3 py-3 text-right text-sm text-muted">{trace.totalTokens || '-'}</td>
      <td className="px-3 py-3 text-right text-sm text-muted tabular-nums">
        {trace.estimatedCost ? formatCost(trace.estimatedCost) : '-'}
      </td>
      <td className="px-3 py-3 text-right text-sm text-muted">
        {trace.eventCount}
        {trace.errorCount > 0 ? ` / ${trace.errorCount} err` : ''}
      </td>
      <td className="max-w-[280px] truncate px-3 py-3 text-sm text-muted">{trace.preview}</td>
    </tr>
  );
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function traceDatePresetToRange(preset: TraceDatePreset): string | undefined {
  switch (preset) {
    case 'last-24h':
      return '1d';
    case 'last-7d':
      return '7d';
    case 'last-30d':
      return '30d';
    default:
      return undefined;
  }
}

function parseUrlList(value: string | null): string[] {
  return value
    ? [
        ...new Set(
          value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

function parseTraceDatePreset(value: string | null): TraceDatePreset {
  switch (value) {
    case '1d':
    case 'last-24h':
      return 'last-24h';
    case '7d':
    case 'last-7d':
      return 'last-7d';
    case '30d':
    case 'last-30d':
      return 'last-30d';
    case 'all':
      return 'all';
    default:
      return 'last-7d';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatOperatorDiagnosticTitle(
  diagnostic: NonNullable<TraceExplorerRow['operatorDiagnostics']>[number],
): string {
  const target = [diagnostic.agentName, diagnostic.toolName].filter(Boolean).join(' / ');
  const action = diagnostic.recommendedAction ? ` Action: ${diagnostic.recommendedAction}` : '';
  const targetText = target ? ` Target: ${target}.` : '';
  return `${diagnostic.code}: ${diagnostic.operatorHint}${targetText}${action}`;
}

function formatTraceWarningTitle(
  warning: NonNullable<TraceExplorerRow['warnings']>[number],
): string {
  if (warning.code === 'REASONING_FALLBACK') {
    return REASONING_FALLBACK_TOOLTIP;
  }
  return warning.message;
}
