import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileText, Filter, Loader2, RefreshCw, Search, Shield, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { apiFetch } from '../../../lib/api-client';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';
import { EmptyState } from '../../ui/EmptyState';
import { Input } from '../../ui/Input';
import {
  AUDIT_EXPLORER_CATEGORY_DEFINITIONS,
  getAuditExplorerCategoryLabel,
  resolveAuditExplorerCategory,
} from '../../../lib/audit/audit-explorer-catalog';

const DEFAULT_LIMIT = 50;
const DATE_PRESETS = [
  { id: '1h', label: '1h', hours: 1 },
  { id: '24h', label: '24h', hours: 24 },
  { id: '7d', label: '7d', hours: 24 * 7 },
  { id: '30d', label: '30d', hours: 24 * 30 },
] as const;

interface AuditLogRow {
  id: string;
  userId: string | null;
  tenantId: string | null;
  projectId?: string | null;
  eventType?: string;
  category?: string;
  categoryLabel?: string;
  action: string;
  actorType?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  environment?: string | null;
  traceId?: string | null;
  source?: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditLogsResponse {
  logs: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
  scope: 'personal' | 'workspace';
  nextCursor?: string;
}

interface AuditFilters {
  q: string;
  from: string;
  to: string;
  categories: string[];
  actions: string;
  actor: string;
  actorTypes: string[];
  projectId: string;
  resourceTypes: string;
  resourceId: string;
  traceId: string;
  sources: string;
  environments: string[];
  success: '' | 'success' | 'failure';
  ipAddress: string;
  metadataKey: string;
  metadataValue: string;
}

const EMPTY_FILTERS: AuditFilters = {
  q: '',
  from: '',
  to: '',
  categories: [],
  actions: '',
  actor: '',
  actorTypes: [],
  projectId: '',
  resourceTypes: '',
  resourceId: '',
  traceId: '',
  sources: '',
  environments: [],
  success: '',
  ipAddress: '',
  metadataKey: '',
  metadataValue: '',
};
const AUDIT_CATEGORY_IDS: ReadonlySet<string> = new Set(
  AUDIT_EXPLORER_CATEGORY_DEFINITIONS.map((category) => category.id),
);
const LEGACY_AUDIT_CATEGORY_ALIASES: Record<string, string> = {
  project_agent_lifecycle: 'project_agent_configuration',
  connectors_crawl: 'connector_configuration',
};

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

const AUDIT_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLocalInputDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hours = padDatePart(date.getHours());
  const minutes = padDatePart(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toLocalInputValue(date: Date): string {
  return Number.isNaN(date.getTime()) ? '' : formatLocalInputDateTime(date);
}

function toIsoFromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : AUDIT_TIMESTAMP_FORMATTER.format(date);
}

function compactList(value: string): string | undefined {
  const normalized = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .join(',');
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeCategoryFilters(value: string | null): string[] {
  if (!value) return [];
  const categories = new Set<string>();
  for (const rawCategory of value.split(',')) {
    const category = rawCategory.trim();
    const normalized = LEGACY_AUDIT_CATEGORY_ALIASES[category] ?? category;
    if (AUDIT_CATEGORY_IDS.has(normalized)) {
      categories.add(normalized);
    }
  }
  return [...categories];
}

function addOptionalParam(params: URLSearchParams, key: string, value?: string | null) {
  if (value && value.length > 0) {
    params.set(key, value);
  }
}

function buildParams(filters: AuditFilters, offset: number): URLSearchParams {
  const params = new URLSearchParams();
  params.set('scope', 'workspace');
  params.set('limit', String(DEFAULT_LIMIT));
  params.set('offset', String(offset));
  addOptionalParam(params, 'from', toIsoFromLocalInput(filters.from));
  addOptionalParam(params, 'to', toIsoFromLocalInput(filters.to));
  addOptionalParam(params, 'q', filters.q.trim());
  addOptionalParam(params, 'categories', filters.categories.join(','));
  addOptionalParam(params, 'actions', compactList(filters.actions));
  addOptionalParam(params, 'actor', filters.actor.trim());
  addOptionalParam(params, 'actorTypes', filters.actorTypes.join(','));
  addOptionalParam(params, 'projectId', filters.projectId.trim());
  addOptionalParam(params, 'resourceTypes', compactList(filters.resourceTypes));
  addOptionalParam(params, 'resourceId', filters.resourceId.trim());
  addOptionalParam(params, 'traceId', filters.traceId.trim());
  addOptionalParam(params, 'sources', compactList(filters.sources));
  addOptionalParam(params, 'environments', filters.environments.join(','));
  addOptionalParam(params, 'success', filters.success);
  addOptionalParam(params, 'ipAddress', filters.ipAddress.trim());
  addOptionalParam(params, 'metadataKey', filters.metadataKey.trim());
  addOptionalParam(params, 'metadataValue', filters.metadataValue.trim());
  return params;
}

function filtersFromUrl(): AuditFilters {
  if (typeof window === 'undefined') return EMPTY_FILTERS;
  const params = new URLSearchParams(window.location.search);
  return {
    ...EMPTY_FILTERS,
    q: params.get('q') ?? '',
    from: params.get('from') ? toLocalInputValue(new Date(params.get('from') as string)) : '',
    to: params.get('to') ? toLocalInputValue(new Date(params.get('to') as string)) : '',
    categories: normalizeCategoryFilters(params.get('categories')),
    actions: params.get('actions') ?? params.get('action') ?? '',
    actor: params.get('actor') ?? '',
    actorTypes: params.get('actorTypes')?.split(',').filter(Boolean) ?? [],
    projectId: params.get('projectId') ?? '',
    resourceTypes: params.get('resourceTypes') ?? '',
    resourceId: params.get('resourceId') ?? '',
    traceId: params.get('traceId') ?? '',
    sources: params.get('sources') ?? '',
    environments: params.get('environments')?.split(',').filter(Boolean) ?? [],
    success: (params.get('success') as AuditFilters['success']) ?? '',
    ipAddress: params.get('ipAddress') ?? '',
    metadataKey: params.get('metadataKey') ?? '',
    metadataValue: params.get('metadataValue') ?? '',
  };
}

function encodeCsvCell(value: unknown): string {
  const rawText = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const text = /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadText(filename: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function resolveCategoryLabel(log: AuditLogRow): string {
  if (log.categoryLabel) return log.categoryLabel;
  if (log.category) return getAuditExplorerCategoryLabel(log.category);
  return getAuditExplorerCategoryLabel(resolveAuditExplorerCategory(log.action, log.eventType));
}

function ToggleGroup({
  values,
  selected,
  onChange,
}: {
  values: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => {
        const active = selected.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(active ? selected.filter((item) => item !== value) : [...selected, value])
            }
            className={`px-2 py-1 text-xs rounded-md border transition-default ${
              active
                ? 'border-accent bg-accent-subtle text-accent'
                : 'border-default text-muted hover:text-foreground hover:bg-background-muted'
            }`}
          >
            {value}
          </button>
        );
      })}
    </div>
  );
}

export function AuditLogsPage() {
  const t = useTranslations('admin.audit_explorer');
  const [filters, setFilters] = useState<AuditFilters>(() => filtersFromUrl());
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditLogRow | null>(null);

  const activeFilterCount = useMemo(() => {
    return Object.entries(filters).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value.length > 0,
    ).length;
  }, [filters]);

  const loadLogs = useCallback(
    async (nextOffset = offset, nextFilters = filters) => {
      setLoading(true);
      setError(null);
      try {
        const params = buildParams(nextFilters, nextOffset);
        const res = await apiFetch(`/api/audit?${params.toString()}`);
        if (!res.ok) {
          setError(t('load_failed'));
          return;
        }
        const data: AuditLogsResponse = await res.json();
        setLogs(data.logs);
        setTotal(data.total);
        setOffset(data.offset);
        const urlParams = buildParams(nextFilters, data.offset);
        window.history.replaceState({}, '', `/admin/audit-logs?${urlParams.toString()}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('load_failed'));
      } finally {
        setLoading(false);
      }
    },
    [filters, offset, t],
  );

  useEffect(() => {
    if (!filters.from || !filters.to) {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const nextFilters = {
        ...filters,
        from: filters.from || toLocalInputValue(start),
        to: filters.to || toLocalInputValue(now),
      };
      setFilters(nextFilters);
      void loadLogs(0, nextFilters);
      return;
    }
    void loadLogs(0, filters);
    // Run once on mount; filter changes apply through explicit Apply/Refresh controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyPreset = (hours: number) => {
    const now = new Date();
    const nextFilters = {
      ...filters,
      from: toLocalInputValue(new Date(now.getTime() - hours * 60 * 60 * 1000)),
      to: toLocalInputValue(now),
    };
    setFilters(nextFilters);
    void loadLogs(0, nextFilters);
  };

  const refreshLogs = () => {
    const now = new Date();
    const nextFilters = {
      ...filters,
      from: filters.from || toLocalInputValue(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      to: toLocalInputValue(now),
    };
    setFilters(nextFilters);
    void loadLogs(0, nextFilters);
  };

  const resetFilters = () => {
    const now = new Date();
    const nextFilters = {
      ...EMPTY_FILTERS,
      from: toLocalInputValue(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      to: toLocalInputValue(now),
    };
    setFilters(nextFilters);
    void loadLogs(0, nextFilters);
  };

  const exportCurrentPage = (format: 'csv' | 'json' | 'ndjson') => {
    const baseName = `audit-logs-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'json') {
      downloadText(`${baseName}.json`, JSON.stringify(logs, null, 2), 'application/json');
      return;
    }
    if (format === 'ndjson') {
      downloadText(
        `${baseName}.ndjson`,
        logs.map((log) => JSON.stringify(log)).join('\n'),
        'application/x-ndjson',
      );
      return;
    }
    const headers = [
      'timestamp',
      'category',
      'action',
      'eventType',
      'actor',
      'actorType',
      'resourceType',
      'resourceId',
      'projectId',
      'source',
      'environment',
      'ip',
      'traceId',
    ];
    const rows = logs.map((log) =>
      [
        log.createdAt,
        resolveCategoryLabel(log),
        log.action,
        log.eventType,
        log.userId,
        log.actorType,
        log.resourceType,
        log.resourceId,
        log.projectId,
        log.source,
        log.environment,
        log.ip,
        log.traceId,
      ]
        .map(encodeCsvCell)
        .join(','),
    );
    downloadText(`${baseName}.csv`, [headers.join(','), ...rows].join('\n'), 'text/csv');
  };

  const exportFiltered = async (format: 'csv' | 'json' | 'ndjson') => {
    const params = buildParams(filters, 0);
    params.set('format', format);
    const res = await apiFetch(`/api/audit/export?${params.toString()}`);
    if (!res.ok) {
      setError(t('export_failed'));
      return;
    }
    const text = await res.text();
    const contentType =
      format === 'csv'
        ? 'text/csv'
        : format === 'ndjson'
          ? 'application/x-ndjson'
          : 'application/json';
    downloadText(`audit-logs-filtered.${format}`, text, contentType);
  };

  const updateFilter = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_LIMIT));
  const currentPage = Math.floor(offset / DEFAULT_LIMIT) + 1;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-6 py-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-accent" />
              <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
              <Badge variant="accent" appearance="outlined">
                {t('workspace_scope')}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted">{t('description')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="w-4 h-4" />}
              onClick={refreshLogs}
            >
              {t('refresh')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              onClick={() => void exportFiltered('csv')}
              disabled={logs.length === 0}
            >
              {t('export_csv')}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="border border-default bg-background-subtle rounded-lg px-3 py-2">
            <p className="text-xs text-muted">{t('summary_total')}</p>
            <p className="text-xl font-semibold text-foreground">{total.toLocaleString()}</p>
          </div>
          <div className="border border-default bg-background-subtle rounded-lg px-3 py-2">
            <p className="text-xs text-muted">{t('summary_failed')}</p>
            <p className="text-xl font-semibold text-foreground">
              {logs.filter((log) => String(log.metadata?.success ?? '').toLowerCase() === 'false')
                .length || '-'}
            </p>
          </div>
          <div className="border border-default bg-background-subtle rounded-lg px-3 py-2">
            <p className="text-xs text-muted">{t('summary_actors')}</p>
            <p className="text-xl font-semibold text-foreground">
              {new Set(logs.map((log) => log.userId).filter(Boolean)).size}
            </p>
          </div>
          <div className="border border-default bg-background-subtle rounded-lg px-3 py-2">
            <p className="text-xs text-muted">{t('summary_filters')}</p>
            <p className="text-xl font-semibold text-foreground">{activeFilterCount}</p>
          </div>
          <div className="border border-default bg-background-subtle rounded-lg px-3 py-2">
            <p className="text-xs text-muted">{t('summary_last')}</p>
            <p className="text-sm font-medium text-foreground truncate">
              {logs[0] ? formatTimestamp(logs[0].createdAt) : '-'}
            </p>
          </div>
        </div>

        <div className="border border-default bg-background-subtle rounded-lg p-3 space-y-3">
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(160px,1fr))_auto]">
            <Input
              label={t('search')}
              value={filters.q}
              onChange={(event) => updateFilter('q', event.target.value)}
              placeholder={t('search_placeholder')}
              icon={<Search className="w-4 h-4" />}
            />
            <Input
              label={t('from')}
              type="datetime-local"
              value={filters.from}
              onChange={(event) => updateFilter('from', event.target.value)}
            />
            <Input
              label={t('to')}
              type="datetime-local"
              value={filters.to}
              onChange={(event) => updateFilter('to', event.target.value)}
            />
            <Input
              label={t('actions')}
              value={filters.actions}
              onChange={(event) => updateFilter('actions', event.target.value)}
              placeholder={t('actions_placeholder')}
            />
            <div className="flex items-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<Filter className="w-4 h-4" />}
                onClick={() => setShowAdvanced((value) => !value)}
              >
                {t('more_filters')}
              </Button>
              <Button size="sm" onClick={() => loadLogs(0, filters)}>
                {t('apply')}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {DATE_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                variant="ghost"
                size="xs"
                onClick={() => applyPreset(preset.hours)}
              >
                {preset.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="xs"
              icon={<X className="w-3 h-3" />}
              onClick={resetFilters}
            >
              {t('reset')}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted uppercase">{t('categories')}</p>
            <div className="flex flex-wrap gap-1.5">
              {AUDIT_EXPLORER_CATEGORY_DEFINITIONS.map((category) => {
                const active = filters.categories.includes(category.id);
                return (
                  <button
                    key={category.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      updateFilter(
                        'categories',
                        active
                          ? filters.categories.filter((item) => item !== category.id)
                          : [...filters.categories, category.id],
                      )
                    }
                    className={`px-2.5 py-1.5 text-xs rounded-md border transition-default ${
                      active
                        ? 'border-accent bg-accent-subtle text-accent'
                        : 'border-default text-muted hover:text-foreground hover:bg-background-muted'
                    }`}
                  >
                    {category.label}
                  </button>
                );
              })}
            </div>
          </div>

          {showAdvanced && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 border-t border-default pt-3">
              <Input
                label={t('actor')}
                value={filters.actor}
                onChange={(event) => updateFilter('actor', event.target.value)}
              />
              <Input
                label={t('project_id')}
                value={filters.projectId}
                onChange={(event) => updateFilter('projectId', event.target.value)}
              />
              <Input
                label={t('resource_types')}
                value={filters.resourceTypes}
                onChange={(event) => updateFilter('resourceTypes', event.target.value)}
                placeholder={t('comma_placeholder')}
              />
              <Input
                label={t('resource_id')}
                value={filters.resourceId}
                onChange={(event) => updateFilter('resourceId', event.target.value)}
              />
              <Input
                label={t('trace_id')}
                value={filters.traceId}
                onChange={(event) => updateFilter('traceId', event.target.value)}
              />
              <Input
                label={t('sources')}
                value={filters.sources}
                onChange={(event) => updateFilter('sources', event.target.value)}
                placeholder={t('sources_placeholder')}
              />
              <Input
                label={t('ip_address')}
                value={filters.ipAddress}
                onChange={(event) => updateFilter('ipAddress', event.target.value)}
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-foreground" htmlFor="audit-result">
                  {t('result')}
                </label>
                <select
                  id="audit-result"
                  value={filters.success}
                  onChange={(event) =>
                    updateFilter('success', event.target.value as AuditFilters['success'])
                  }
                  className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground"
                >
                  <option value="">{t('result_all')}</option>
                  <option value="success">{t('result_success')}</option>
                  <option value="failure">{t('result_failure')}</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">{t('actor_types')}</p>
                <ToggleGroup
                  values={['user', 'admin', 'agent', 'system', 'unknown']}
                  selected={filters.actorTypes}
                  onChange={(next) => updateFilter('actorTypes', next)}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">{t('environments')}</p>
                <ToggleGroup
                  values={['dev', 'staging', 'production']}
                  selected={filters.environments}
                  onChange={(next) => updateFilter('environments', next)}
                />
              </div>
              <Input
                label={t('metadata_key')}
                value={filters.metadataKey}
                onChange={(event) => updateFilter('metadataKey', event.target.value)}
              />
              <Input
                label={t('metadata_value')}
                value={filters.metadataValue}
                onChange={(event) => updateFilter('metadataValue', event.target.value)}
              />
            </div>
          )}
        </div>

        {error && (
          <div className="border border-error bg-error-subtle text-error rounded-lg px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <div className="border border-default rounded-lg overflow-hidden bg-background-subtle">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-5 h-5 text-muted animate-spin" />
            </div>
          ) : logs.length === 0 ? (
            <EmptyState
              icon={<FileText className="w-6 h-6" />}
              title={t('empty_title')}
              description={t('empty_description')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1160px] text-sm">
                <thead className="bg-background-muted border-b border-default">
                  <tr>
                    {[
                      t('timestamp'),
                      t('category'),
                      t('action_header'),
                      t('actor_header'),
                      t('target_header'),
                      t('project_header'),
                      t('source_header'),
                      t('ip_header'),
                      t('trace_header'),
                    ].map((header) => (
                      <th
                        key={header}
                        className="text-left px-3 py-2 text-xs font-medium text-muted uppercase"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {logs.map((log) => (
                    <tr
                      key={log.id}
                      className="hover:bg-background-muted transition-default cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedLog(log)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedLog(log);
                        }
                      }}
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-muted">
                        {formatTimestamp(log.createdAt)}
                      </td>
                      <td className="px-3 py-2 max-w-[190px] align-top">
                        <Badge
                          variant="info"
                          appearance="outlined"
                          className="max-w-[180px] rounded-md px-2 py-1 text-left leading-tight whitespace-normal break-words"
                          testid={`audit-log-category-${log.id}`}
                        >
                          <span>{resolveCategoryLabel(log)}</span>
                        </Badge>
                      </td>
                      <td className="px-3 py-2 max-w-[220px] truncate font-medium text-foreground">
                        {log.action}
                      </td>
                      <td className="px-3 py-2 max-w-[180px] truncate text-muted">
                        {log.userId ?? '-'}
                      </td>
                      <td className="px-3 py-2 max-w-[220px] truncate text-muted">
                        {[log.resourceType, log.resourceId].filter(Boolean).join(': ') || '-'}
                      </td>
                      <td className="px-3 py-2 max-w-[160px] truncate text-muted">
                        {log.projectId ?? '-'}
                      </td>
                      <td className="px-3 py-2 text-muted">{log.source ?? '-'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">{log.ip ?? '-'}</td>
                      <td className="px-3 py-2 max-w-[180px] truncate text-muted">
                        {log.traceId ?? '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {t('page_info', { current: currentPage, total: totalPages })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => loadLogs(Math.max(0, offset - DEFAULT_LIMIT), filters)}
            >
              {t('previous')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={offset + DEFAULT_LIMIT >= total}
              onClick={() => loadLogs(offset + DEFAULT_LIMIT, filters)}
            >
              {t('next')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={logs.length === 0}
              onClick={() => void exportFiltered('json')}
            >
              JSON
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={logs.length === 0}
              onClick={() => void exportFiltered('ndjson')}
            >
              NDJSON
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={logs.length === 0}
              onClick={() => exportCurrentPage('csv')}
            >
              {t('current_page_csv')}
            </Button>
          </div>
        </div>
      </div>

      {selectedLog && (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-xl border-l border-default bg-background shadow-xl overflow-y-auto">
          <div className="sticky top-0 bg-background border-b border-default px-5 py-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">{selectedLog.action}</h2>
              <p className="text-xs text-muted">{selectedLog.id}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<X className="w-4 h-4" />}
              onClick={() => setSelectedLog(null)}
            >
              {t('close')}
            </Button>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                [t('timestamp'), formatTimestamp(selectedLog.createdAt)],
                [t('event_type'), selectedLog.eventType ?? '-'],
                [t('actor_header'), selectedLog.userId ?? '-'],
                [t('actor_type'), selectedLog.actorType ?? '-'],
                [t('target_header'), selectedLog.resourceId ?? '-'],
                [t('resource_type'), selectedLog.resourceType ?? '-'],
                [t('project_header'), selectedLog.projectId ?? '-'],
                [t('source_header'), selectedLog.source ?? '-'],
                [t('environment'), selectedLog.environment ?? '-'],
                [t('ip_header'), selectedLog.ip ?? '-'],
                [t('trace_header'), selectedLog.traceId ?? '-'],
              ].map(([label, value]) => (
                <div key={label} className="border border-default rounded-lg p-2 min-w-0">
                  <p className="text-xs text-muted">{label}</p>
                  <p className="text-sm text-foreground truncate">{value}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground mb-2">{t('metadata')}</p>
              <pre className="text-xs bg-background-muted border border-default rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(selectedLog.metadata ?? {}, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
