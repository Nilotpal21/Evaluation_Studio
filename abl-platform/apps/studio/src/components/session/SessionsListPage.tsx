/**
 * SessionsListPage
 *
 * Full-page sessions table with date filters, sorting, and pagination.
 * Rendered when currentView === 'sessions'.
 */

'use client';

import { useEffect, useState, useMemo, memo } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { useSessionList } from '../../hooks/useSessionList';
import { useNavigationStore } from '../../store/navigation-store';
import { TracesPage } from '../traces/TracesPage';
import { ListPageShell } from '../ui/ListPageShell';
import { Tabs } from '../ui/Tabs';
import { Badge } from '../ui/Badge';
import { formatCost } from '../../utils/llm-cost';
import { formatAgentName } from '../../lib/format/agent-name';
import type { SessionListItem } from '../../types';
import { SessionIdDisplay } from './SessionIdDisplay';
import {
  FilterToolbar,
  MultiSelectFilter,
  SearchFilter,
  TimePresetFilter,
  columnHighlight,
  uniqueOptions,
} from './ExplorerFilterControls';

type SortField = 'id' | 'agentName' | 'createdAt' | 'traceEventCount' | 'messageCount';
type SortDir = 'asc' | 'desc';
type DatePreset =
  | 'last-24h'
  | 'last-48h'
  | 'this-week'
  | 'last-7d'
  | 'this-month'
  | 'last-30d'
  | 'all';

const DATE_PRESET_KEYS: { value: DatePreset; key: string }[] = [
  { value: 'last-24h', key: 'last_24h' },
  { value: 'last-48h', key: 'last_48h' },
  { value: 'this-week', key: 'this_week' },
  { value: 'last-7d', key: 'last_7d' },
  { value: 'this-month', key: 'this_month' },
  { value: 'last-30d', key: 'last_30d' },
  { value: 'all', key: 'all' },
];

const PAGE_SIZE = 20;
const SESSION_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'abandoned', label: 'Abandoned' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'ended', label: 'Ended' },
  { value: 'idle', label: 'Idle' },
  { value: 'archived', label: 'Archived' },
];

export function SessionsListPage() {
  const projectId = useNavigationStore((s) => s.projectId);
  const navigate = useNavigationStore((s) => s.navigate);
  const tab = useNavigationStore((s) => s.tab);
  const setTab = useNavigationStore((s) => s.setTab);
  const t = useTranslations('sessions');
  const [activeTab, setActiveTab] = useState<'conversations' | 'traces'>(
    tab === 'traces' ? 'traces' : 'conversations',
  );
  const [datePreset, setDatePreset] = useState<DatePreset>('last-7d');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [agentFilters, setAgentFilters] = useState<string[]>([]);
  const [environmentFilters, setEnvironmentFilters] = useState<string[]>([]);
  const [channelFilters, setChannelFilters] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSearch(params.get('q') ?? '');
    setAgentFilters(parseUrlList(params.get('agentName')));
    setEnvironmentFilters(parseUrlList(params.get('environment')));
    setChannelFilters(parseUrlList(params.get('channel')));
    setStatusFilters(parseUrlList(params.get('status')));
    setDatePreset(parseSessionDatePreset(params.get('range')));
    setSortField((params.get('sortBy') as SortField) || 'createdAt');
    setSortDir(params.get('sortDir') === 'asc' ? 'asc' : 'desc');
  }, []);

  const datePresets = useMemo(
    () => DATE_PRESET_KEYS.map((p) => ({ value: p.value, label: t(`date_preset.${p.key}`) })),
    [t],
  );

  const sessionFilters = useMemo(
    () => ({
      q: search || undefined,
      agentName: agentFilters,
      environment: environmentFilters,
      channel: channelFilters,
      status: statusFilters,
      range: datePreset === 'all' ? undefined : datePresetToRange(datePreset),
      sortBy: sortField,
      sortDir,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [
      agentFilters,
      channelFilters,
      datePreset,
      environmentFilters,
      page,
      search,
      sortDir,
      sortField,
      statusFilters,
    ],
  );
  const {
    sessions,
    total: sessionTotal = sessions.length,
    isLoading,
    error,
  } = useSessionList(projectId, sessionFilters);

  useEffect(() => {
    if (activeTab !== 'conversations') return;
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (agentFilters.length > 0) params.set('agentName', agentFilters.join(','));
    if (environmentFilters.length > 0) params.set('environment', environmentFilters.join(','));
    if (channelFilters.length > 0) params.set('channel', channelFilters.join(','));
    if (statusFilters.length > 0) params.set('status', statusFilters.join(','));
    if (datePreset !== 'all') params.set('range', datePreset);
    params.set('sortBy', sortField);
    params.set('sortDir', sortDir);
    const suffix = params.toString();
    window.history.replaceState(null, '', suffix ? `?${suffix}` : window.location.pathname);
  }, [
    activeTab,
    agentFilters,
    channelFilters,
    datePreset,
    environmentFilters,
    search,
    sortDir,
    sortField,
    statusFilters,
  ]);

  // Sort
  const sorted = useMemo(() => {
    const arr = [...sessions];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'id':
          cmp = a.id.localeCompare(b.id);
          break;
        case 'agentName':
          cmp = (a.agentName || '').localeCompare(b.agentName || '');
          break;
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'traceEventCount':
          cmp = a.traceEventCount - b.traceEventCount;
          break;
        case 'messageCount':
          cmp = a.messageCount - b.messageCount;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [sessions, sortField, sortDir]);

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sessionTotal / PAGE_SIZE));
  const paginated = sorted;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(1);
  };

  const handleRowClick = (session: SessionListItem) => {
    navigate(`/projects/${projectId}/sessions/${session.id}`);
  };

  const handlePresetSelect = (preset: DatePreset) => {
    setDatePreset(preset);
    setPage(1);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3 inline ml-0.5" />
    ) : (
      <ChevronDown className="w-3 h-3 inline ml-0.5" />
    );
  };

  const isConversations = activeTab === 'conversations';

  const agentOptions = useMemo(
    () =>
      uniqueOptions(
        sessions.map((session) => session.agentName),
        agentFilters,
      ),
    [agentFilters, sessions],
  );
  const environmentOptions = useMemo(
    () =>
      uniqueOptions(
        sessions.map((session) => session.environment),
        environmentFilters,
      ),
    [environmentFilters, sessions],
  );
  const channelOptions = useMemo(
    () =>
      uniqueOptions(
        sessions.map((session) => session.channel),
        channelFilters,
      ),
    [channelFilters, sessions],
  );
  const statusOptions = useMemo(() => {
    const options = new Map(SESSION_STATUS_OPTIONS.map((option) => [option.value, option]));
    for (const option of uniqueOptions(
      sessions.map((session) => session.status),
      statusFilters,
    )) {
      if (!options.has(option.value)) {
        options.set(option.value, option);
      }
    }
    return [...options.values()];
  }, [sessions, statusFilters]);

  const conversationsFilterBar = (
    <FilterToolbar
      resultCount={sessionTotal}
      resultLabel={sessionTotal === 1 ? 'session' : 'sessions'}
    >
      <SearchFilter
        value={search}
        onChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="Search session or agent"
      />
      <MultiSelectFilter
        label="Agent"
        values={agentFilters}
        options={agentOptions}
        onChange={(value) => {
          setAgentFilters(value);
          setPage(1);
        }}
      />
      <MultiSelectFilter
        label="Environment"
        values={environmentFilters}
        options={environmentOptions}
        onChange={(value) => {
          setEnvironmentFilters(value);
          setPage(1);
        }}
      />
      <MultiSelectFilter
        label="Channel"
        values={channelFilters}
        options={channelOptions}
        onChange={(value) => {
          setChannelFilters(value);
          setPage(1);
        }}
      />
      <MultiSelectFilter
        label="Status"
        values={statusFilters}
        options={statusOptions}
        onChange={(value) => {
          setStatusFilters(value);
          setPage(1);
        }}
      />
      <TimePresetFilter value={datePreset} options={datePresets} onChange={handlePresetSelect} />
    </FilterToolbar>
  );

  return (
    <ListPageShell
      title={t('title')}
      description={t('subtitle')}
      filterBar={undefined}
      pagination={
        isConversations
          ? {
              page,
              pageSize: PAGE_SIZE,
              total: sessionTotal,
              onPageChange: setPage,
            }
          : undefined
      }
      className="bg-background bg-noise"
    >
      {/* Tab switcher */}
      <div className="pb-4">
        <Tabs
          tabs={[
            { id: 'conversations', label: t('tab.conversations') },
            { id: 'traces', label: t('tab.traces') },
          ]}
          activeTab={activeTab}
          onTabChange={(id) => {
            setActiveTab(id as 'conversations' | 'traces');
            setTab(id === 'traces' ? 'traces' : null);
          }}
          layoutId="sessions-tabs"
        />
      </div>

      {isConversations ? (
        <div className="space-y-4">
          {conversationsFilterBar}
          <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[980px]">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-default text-left text-xs text-muted bg-background-muted/40">
                      <th
                        className="py-3 px-3 font-medium cursor-pointer hover:text-foreground transition-default"
                        onClick={() => handleSort('id')}
                      >
                        {t('column.session_id')} <SortIcon field="id" />
                      </th>
                      <th
                        className={`py-3 px-3 font-medium cursor-pointer transition-default hover:text-foreground ${agentFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                        onClick={() => handleSort('agentName')}
                      >
                        {t('column.agent')} <SortIcon field="agentName" />
                      </th>
                      <th
                        className={`py-3 px-3 font-medium ${statusFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                      >
                        Status
                      </th>
                      <th
                        className={`py-3 px-3 font-medium ${environmentFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                      >
                        Environment
                      </th>
                      <th
                        className={`py-3 px-3 font-medium ${channelFilters.length > 0 ? 'bg-info/5 text-info' : ''}`}
                      >
                        Channel
                      </th>
                      <th
                        className="py-3 px-3 font-medium cursor-pointer hover:text-foreground transition-default"
                        onClick={() => handleSort('createdAt')}
                      >
                        {t('column.created_at')} <SortIcon field="createdAt" />
                      </th>
                      <th
                        className="py-3 px-3 font-medium cursor-pointer hover:text-foreground transition-default text-right"
                        onClick={() => handleSort('traceEventCount')}
                      >
                        Trace Events <SortIcon field="traceEventCount" />
                      </th>
                      <th className="py-3 px-3 font-medium text-right">{t('column.duration')}</th>
                      <th
                        className="py-3 px-3 font-medium cursor-pointer hover:text-foreground transition-default text-right"
                        onClick={() => handleSort('messageCount')}
                      >
                        {t('column.messages')} <SortIcon field="messageCount" />
                      </th>
                      <th className="py-3 px-3 font-medium text-right">{t('column.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading && paginated.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center text-muted text-sm">
                          {t('loading')}
                        </td>
                      </tr>
                    ) : error ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center text-error text-sm">
                          {t('load_failed')}
                        </td>
                      </tr>
                    ) : paginated.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center text-muted text-sm">
                          {t('list_empty_range')}
                        </td>
                      </tr>
                    ) : (
                      paginated.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          activeColumns={{
                            agent: agentFilters.length > 0,
                            status: statusFilters.length > 0,
                            environment: environmentFilters.length > 0,
                            channel: channelFilters.length > 0,
                          }}
                          onClick={() => handleRowClick(session)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <TracesPage />
      )}
    </ListPageShell>
  );
}

// -- Session Row --------------------------------------------------------------

const SessionRow = memo(function SessionRow({
  session,
  activeColumns,
  onClick,
}: {
  session: SessionListItem;
  activeColumns: {
    agent: boolean;
    status: boolean;
    environment: boolean;
    channel: boolean;
  };
  onClick: () => void;
}) {
  const t = useTranslations('sessions');
  const locale = useLocale();
  const createdDate = new Date(session.createdAt);
  // Use server-computed durationMs (accounts for endedAt, callDuration, etc.)
  const durationMs = session.durationMs || 0;
  const durationStr = formatDuration(durationMs);

  return (
    <tr
      onClick={onClick}
      className="border-b border-muted hover:bg-background-muted cursor-pointer transition-default group"
    >
      <td className="py-3 px-3">
        <SessionIdDisplay
          sessionId={session.id}
          copyLabel={t('copy_id')}
          copyable={false}
          className="max-w-[280px]"
          valueClassName="text-sm text-accent"
        />
      </td>
      <td className={`py-3 px-3 ${activeColumns.agent ? 'bg-info/5' : ''}`}>
        <Badge variant="accent">
          {session.agentName ? formatAgentName(session.agentName) : t('unknown_agent')}
        </Badge>
      </td>
      <td className={`py-3 px-3 text-sm ${columnHighlight(activeColumns.status)}`}>
        {session.status || '\u2014'}
      </td>
      <td className={`py-3 px-3 text-sm ${columnHighlight(activeColumns.environment)}`}>
        {session.environment || '\u2014'}
      </td>
      <td className={`py-3 px-3 text-sm ${columnHighlight(activeColumns.channel)}`}>
        {session.channel || '\u2014'}
      </td>
      <td className="py-3 px-3 text-sm text-muted">{formatDate(createdDate, locale)}</td>
      <td className="py-3 px-3 text-sm text-muted text-right">{session.traceEventCount}</td>
      <td className="py-3 px-3 text-sm text-muted text-right">{durationStr}</td>
      <td className="py-3 px-3 text-sm text-muted text-right">{session.messageCount}</td>
      <td className="py-3 px-3 text-sm text-muted text-right tabular-nums">
        {session.estimatedCost != null ? formatCost(session.estimatedCost) : '\u2014'}
      </td>
    </tr>
  );
});

// -- Helpers ------------------------------------------------------------------

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

function datePresetToRange(preset: DatePreset): string | undefined {
  switch (preset) {
    case 'last-24h':
      return '1d';
    case 'last-48h':
      return '2d';
    case 'last-7d':
    case 'this-week':
      return '7d';
    case 'last-30d':
    case 'this-month':
      return '30d';
    default:
      return undefined;
  }
}

function parseSessionDatePreset(value: string | null): DatePreset {
  switch (value) {
    case '1d':
    case 'last-24h':
      return 'last-24h';
    case '2d':
    case 'last-48h':
      return 'last-48h';
    case '7d':
    case 'this-week':
    case 'last-7d':
      return 'last-7d';
    case '30d':
    case 'this-month':
    case 'last-30d':
      return 'last-30d';
    case 'all':
      return 'all';
    default:
      return 'last-7d';
  }
}

function formatDate(date: Date, locale?: string): string {
  return (
    date.toLocaleDateString(locale, {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }) +
    ', ' +
    date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}
