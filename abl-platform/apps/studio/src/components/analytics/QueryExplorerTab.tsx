/**
 * QueryExplorerTab Component
 *
 * Developer SQL query editor for running ClickHouse queries against analytics tables.
 * Includes example queries, results table, and custom attributes guide.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';
import {
  Play,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  BookOpen,
  Loader2,
  Copy,
  Check,
  Table as TableIcon,
} from 'lucide-react';
import {
  useAnalyticsQuery,
  useAnalyticsTables,
  type AnalyticsTableDescriptor,
} from '../../hooks/useAnalyticsQuery';
import type { TimeRange } from '../../hooks/useAnalytics';
import { EmptyState } from '../ui/EmptyState';

// =============================================================================
// TYPES
// =============================================================================

interface QueryExplorerTabProps {
  projectId: string | null;
  timeRange: TimeRange;
}

interface ExampleQuery {
  label: string;
  description: string;
  sql: string;
}

// =============================================================================
// EXAMPLE QUERIES
// =============================================================================

// Starters grouped by table. Picking a table from the picker loads the first
// starter as the editor content; the "Examples" menu shows every starter
// across every table with the table name annotated. Every starter must include
// tenant_id + project_id filters (the runtime rejects anything else).
export const EXAMPLE_QUERIES_BY_TABLE: Record<string, ExampleQuery[]> = {
  'abl_platform.platform_events': [
    {
      label: 'Event Counts by Type',
      description: 'Count events grouped by event type',
      sql: `SELECT
  event_type,
  count() AS cnt,
  countIf(has_error = 1) AS errors
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY event_type
ORDER BY cnt DESC
LIMIT 100`,
    },
    {
      label: 'LLM Cost by Model (from platform_events)',
      description: 'Total cost and tokens per model, extracted from event data',
      sql: `SELECT
  JSONExtractString(data, 'model') AS model,
  JSONExtractString(data, 'provider') AS provider,
  count() AS calls,
  sum(JSONExtractFloat(data, 'input_tokens')) AS input_tokens,
  sum(JSONExtractFloat(data, 'output_tokens')) AS output_tokens,
  sum(JSONExtractFloat(data, 'estimated_cost')) AS total_cost
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type = 'llm.call.completed'
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY model, provider
ORDER BY total_cost DESC`,
    },
    {
      label: 'Tool Call Latency',
      description: 'Average and P95 latency per tool',
      sql: `SELECT
  JSONExtractString(data, 'tool_name') AS tool,
  count() AS calls,
  round(avg(duration_ms), 1) AS avg_ms,
  round(quantile(0.95)(duration_ms), 1) AS p95_ms,
  countIf(has_error = 1) AS errors
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type IN ('tool.call.completed', 'tool.call.failed')
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY tool
ORDER BY calls DESC`,
    },
    {
      label: 'Error Rate by Agent',
      description: 'Error rate and error count per agent',
      sql: `SELECT
  agent_name,
  count() AS total,
  countIf(has_error = 1) AS errors,
  round(countIf(has_error = 1) / count() * 100, 2) AS error_rate_pct
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND agent_name != ''
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY agent_name
ORDER BY total DESC`,
    },
    {
      label: 'Custom Attribute Query',
      description: 'Aggregate custom attributes emitted via logCustom()',
      sql: `SELECT
  JSONExtractString(data, 'category') AS category,
  round(avg(JSONExtractFloat(data, 'score')), 3) AS avg_score,
  count() AS cnt
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND JSONHas(data, 'score')
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY category
ORDER BY cnt DESC`,
    },
  ],

  'abl_platform.platform_events_by_session': [
    {
      label: 'Session Duration',
      description: 'Duration and event count per session (session-ordered table)',
      sql: `SELECT
  session_id,
  min(timestamp) AS started,
  max(timestamp) AS ended,
  dateDiff('second', min(timestamp), max(timestamp)) AS duration_sec,
  count() AS event_count,
  countIf(event_type LIKE 'llm.%') AS llm_calls
FROM abl_platform.platform_events_by_session
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY session_id
ORDER BY started DESC
LIMIT 50`,
    },
  ],

  'abl_platform.llm_metrics': [
    {
      label: 'Token Usage by Model',
      description: 'Per-call LLM metrics aggregated by model + provider',
      sql: `SELECT
  model_id,
  provider,
  count() AS calls,
  sum(input_tokens) AS input_tokens,
  sum(output_tokens) AS output_tokens,
  round(sum(estimated_cost), 4) AS total_cost,
  round(avg(latency_ms), 1) AS avg_latency_ms
FROM abl_platform.llm_metrics
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
GROUP BY model_id, provider
ORDER BY total_cost DESC
LIMIT 100`,
    },
  ],

  'abl_platform.llm_metrics_hourly_dest': [
    {
      label: 'LLM Spend — Hourly',
      description: 'Cost and call volume, hour-by-hour',
      sql: `SELECT
  hour,
  model_id,
  provider,
  sum(call_count) AS calls,
  round(sum(total_cost), 4) AS cost
FROM abl_platform.llm_metrics_hourly_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND hour >= {from:DateTime64(3)}
  AND hour <= {to:DateTime64(3)}
GROUP BY hour, model_id, provider
ORDER BY hour DESC
LIMIT 200`,
    },
  ],

  'abl_platform.llm_metrics_daily_dest': [
    {
      label: 'LLM Spend — Daily',
      description: 'Cost and call volume rolled up by day',
      sql: `SELECT
  day,
  model_id,
  provider,
  sum(call_count) AS calls,
  round(sum(total_cost), 4) AS cost
FROM abl_platform.llm_metrics_daily_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND day >= toDate({from:DateTime64(3)})
  AND day <= toDate({to:DateTime64(3)})
GROUP BY day, model_id, provider
ORDER BY day DESC
LIMIT 200`,
    },
  ],

  'abl_platform.platform_events_agent_hourly_dest': [
    {
      label: 'Agent Volume — Hourly',
      description: 'Hourly call volume and errors by agent',
      sql: `SELECT
  hour,
  agent_name,
  sum(invocation_count) AS calls,
  sum(error_count) AS errors
FROM abl_platform.platform_events_agent_hourly_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND hour >= {from:DateTime64(3)}
  AND hour <= {to:DateTime64(3)}
GROUP BY hour, agent_name
ORDER BY hour DESC, calls DESC
LIMIT 200`,
    },
  ],

  'abl_platform.platform_events_tool_daily_dest': [
    {
      label: 'Tool Usage — Daily',
      description: 'Daily call volume, errors, and latency by tool',
      sql: `SELECT
  day,
  tool_name,
  sum(call_count) AS calls,
  sum(error_count) AS errors
FROM abl_platform.platform_events_tool_daily_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND day >= toDate({from:DateTime64(3)})
  AND day <= toDate({to:DateTime64(3)})
GROUP BY day, tool_name
ORDER BY day DESC, calls DESC
LIMIT 200`,
    },
  ],

  'abl_platform.platform_events_error_hourly_dest': [
    {
      label: 'Error Mix — Hourly',
      description: 'Errors grouped by event_type and error_type',
      sql: `SELECT
  hour,
  event_type,
  error_type,
  sum(error_count) AS errors
FROM abl_platform.platform_events_error_hourly_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND hour >= {from:DateTime64(3)}
  AND hour <= {to:DateTime64(3)}
GROUP BY hour, event_type, error_type
ORDER BY hour DESC, errors DESC
LIMIT 200`,
    },
  ],

  'abl_platform.platform_events_voice_hourly_dest': [
    {
      label: 'Voice Turns — Hourly',
      description: 'Hourly voice turn volume',
      sql: `SELECT
  hour,
  sum(total_turns) AS turns
FROM abl_platform.platform_events_voice_hourly_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND hour >= {from:DateTime64(3)}
  AND hour <= {to:DateTime64(3)}
GROUP BY hour
ORDER BY hour DESC
LIMIT 200`,
    },
  ],

  'abl_platform.audit_events': [
    {
      label: 'Recent Audit Actions',
      description: 'Latest audit trail events for this project',
      sql: `SELECT
  timestamp,
  action,
  actor_id,
  resource_type,
  session_id
FROM abl_platform.audit_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
ORDER BY timestamp DESC
LIMIT 100`,
    },
  ],

  'abl_platform.search_queries': [
    {
      label: 'Search — Slowest Queries',
      description: 'Latency distribution of recent search queries',
      sql: `SELECT
  timestamp,
  index_id,
  query_text,
  result_count,
  total_latency_ms
FROM abl_platform.search_queries
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp <= {to:DateTime64(3)}
ORDER BY total_latency_ms DESC
LIMIT 100`,
    },
  ],

  'abl_platform.spatial_trace_records': [
    {
      label: 'Trace Records by STI Path',
      description: 'Spatial trace records grouped by sti_path',
      sql: `SELECT
  sti_path,
  agent_name,
  model_id,
  count() AS records,
  countIf(tool_name != '') AS tool_calls
FROM abl_platform.spatial_trace_records
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND started_at >= {from:DateTime64(3)}
  AND started_at <= {to:DateTime64(3)}
GROUP BY sti_path, agent_name, model_id
ORDER BY records DESC
LIMIT 100`,
    },
  ],

  'abl_platform.insight_results': [
    {
      label: 'Insight Scores',
      description: 'Recent pipeline insight evaluations and scores',
      sql: `SELECT
  evaluated_at,
  insight_type,
  status,
  score
FROM abl_platform.insight_results
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND evaluated_at >= {from:DateTime64(3)}
  AND evaluated_at <= {to:DateTime64(3)}
ORDER BY evaluated_at DESC
LIMIT 100`,
    },
  ],

  'abl_platform.messages': [
    {
      label: 'Messages by Session',
      description:
        'All messages for a session — paste a session ID in the field that appears below',
      sql: `SELECT
  created_at,
  role,
  channel,
  content,
  has_pii,
  scrubbed
FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_id = {sessionId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
ORDER BY created_at ASC
LIMIT 100`,
    },
    {
      label: 'Recent Messages',
      description: 'Most recent messages across all sessions in the project',
      sql: `SELECT
  created_at,
  session_id,
  role,
  channel,
  left(content, 200) AS content_preview
FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
ORDER BY created_at DESC
LIMIT 100`,
    },
    {
      label: 'Message Volume by Role & Channel',
      description: 'Daily message counts broken down by role (user/assistant) and channel',
      sql: `SELECT
  toDate(created_at) AS day,
  role,
  channel,
  count() AS messages,
  countIf(has_pii = 1) AS pii_messages
FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
GROUP BY day, role, channel
ORDER BY day DESC, messages DESC
LIMIT 200`,
    },
  ],

  'abl_platform.custom_pipeline_results': [
    {
      label: 'Pipeline Run Results',
      description: 'Recent custom pipeline run outputs and scores',
      sql: `SELECT
  created_at,
  pipeline_name,
  run_id,
  score_name,
  score_value,
  source_step_status,
  execution_mode
FROM abl_platform.custom_pipeline_results
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
ORDER BY created_at DESC
LIMIT 100`,
    },
    {
      label: 'Score Distribution by Pipeline',
      description: 'Average, min, and max scores grouped by pipeline and score name',
      sql: `SELECT
  pipeline_name,
  score_name,
  count() AS runs,
  round(avg(score_value), 4) AS avg_score,
  round(min(score_value), 4) AS min_score,
  round(max(score_value), 4) AS max_score
FROM abl_platform.custom_pipeline_results
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
  AND score_value IS NOT NULL
GROUP BY pipeline_name, score_name
ORDER BY pipeline_name, score_name`,
    },
    {
      label: 'Run Volume by Pipeline',
      description: 'Daily run counts and step status breakdown per pipeline',
      sql: `SELECT
  toDate(created_at) AS day,
  pipeline_name,
  count() AS total_runs,
  countIf(source_step_status = 'success') AS succeeded,
  countIf(source_step_status = 'failure') AS failed
FROM abl_platform.custom_pipeline_results
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND created_at >= {from:DateTime64(3)}
  AND created_at <= {to:DateTime64(3)}
GROUP BY day, pipeline_name
ORDER BY day DESC, total_runs DESC
LIMIT 200`,
    },
  ],
};

const FALLBACK_TEMPLATE = (table: string) =>
  `SELECT *
FROM ${table}
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
LIMIT 100`;

function getStarterSqlForTable(table: string): string {
  const starters = EXAMPLE_QUERIES_BY_TABLE[table];
  return starters?.[0]?.sql ?? FALLBACK_TEMPLATE(table);
}

function getAllExampleQueries(): Array<ExampleQuery & { table: string }> {
  return Object.entries(EXAMPLE_QUERIES_BY_TABLE).flatMap(([table, queries]) =>
    queries.map((q) => ({ ...q, table })),
  );
}

const DEFAULT_TABLE = 'abl_platform.platform_events';

// =============================================================================
// COMPONENT
// =============================================================================

export function QueryExplorerTab({ projectId, timeRange }: QueryExplorerTabProps) {
  const t = useTranslations('analytics');
  const [sessionId, setSessionId] = useState('');
  const { result, isLoading, error, executionTimeMs, executeQuery, clear } = useAnalyticsQuery(
    projectId,
    timeRange,
    { sessionId: sessionId.trim() || undefined },
  );
  const { tables: serverTables, maxRows, error: tablesError } = useAnalyticsTables(projectId);

  const [selectedTable, setSelectedTable] = useState<string>(DEFAULT_TABLE);
  const [sql, setSql] = useState(getStarterSqlForTable(DEFAULT_TABLE));
  const [showTables, setShowTables] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const usesSessionParam = useMemo(() => /\{sessionId:String\}/i.test(sql), [sql]);
  const sessionIdMissing = usesSessionParam && !sessionId.trim();

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.max(200, textareaRef.current.scrollHeight)}px`;
    }
  }, [sql]);

  // Prefer the server's allowlist once it loads. Fall back to the tables we
  // have starters for so the picker still renders while /tables is in flight
  // or returns nothing (e.g. unauthenticated preview environments).
  const availableTables = useMemo<AnalyticsTableDescriptor[]>(() => {
    if (serverTables.length > 0) return serverTables;
    return Object.keys(EXAMPLE_QUERIES_BY_TABLE).map((name) => ({ name, description: '' }));
  }, [serverTables]);

  const allExamples = useMemo(() => getAllExampleQueries(), []);
  const rowCap = maxRows ?? 1000;

  const handleExecute = () => {
    if (!sql.trim()) return;
    executeQuery(sql.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd + Enter to execute
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    }
  };

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName);
    setSql(getStarterSqlForTable(tableName));
    setShowTables(false);
    clear();
  };

  const handleSelectExample = (example: ExampleQuery & { table?: string }) => {
    setSql(example.sql);
    if (example.table) setSelectedTable(example.table);
    setShowExamples(false);
    clear();
  };

  const handleCopyResults = () => {
    if (!result) return;
    const header = result.columns.join('\t');
    const rows = result.rows.map((row) => row.map((v) => String(v ?? '')).join('\t')).join('\n');
    navigator.clipboard.writeText(`${header}\n${rows}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4">
      {/* Header: table picker + example queries + guide toggle */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          {/* Table picker */}
          <div className="relative">
            <button
              onClick={() => {
                setShowTables(!showTables);
                setShowExamples(false);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-background-muted border border-default text-foreground hover:bg-background-elevated transition-default"
            >
              <TableIcon className="w-3 h-3" />
              <span className="font-mono">{selectedTable}</span>
              <ChevronDown
                className={clsx('w-3 h-3 transition-transform', showTables && 'rotate-180')}
              />
            </button>

            {showTables && (
              <div className="absolute top-full left-0 mt-1 w-96 bg-background-elevated border border-default rounded-lg shadow-lg z-10 py-1 max-h-96 overflow-y-auto">
                {availableTables.map((table) => (
                  <button
                    key={table.name}
                    onClick={() => handleSelectTable(table.name)}
                    className={clsx(
                      'w-full text-left px-3 py-2 hover:bg-background-subtle transition-default',
                      table.name === selectedTable && 'bg-background-subtle',
                    )}
                  >
                    <div className="text-xs font-mono font-medium text-foreground">
                      {table.name}
                    </div>
                    {table.description && (
                      <div className="text-xs text-muted mt-0.5">{table.description}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Example queries (flattened across all tables) */}
          <div className="relative">
            <button
              onClick={() => {
                setShowExamples(!showExamples);
                setShowTables(false);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-background-muted border border-default text-foreground hover:bg-background-elevated transition-default"
            >
              {t('query_explorer.examples')}
              <ChevronDown
                className={clsx('w-3 h-3 transition-transform', showExamples && 'rotate-180')}
              />
            </button>

            {showExamples && (
              <div className="absolute top-full left-0 mt-1 w-96 bg-background-elevated border border-default rounded-lg shadow-lg z-10 py-1 max-h-96 overflow-y-auto">
                {allExamples.map((example, i) => (
                  <button
                    key={`${example.table}-${i}`}
                    onClick={() => handleSelectExample(example)}
                    className="w-full text-left px-3 py-2 hover:bg-background-subtle transition-default"
                  >
                    <div className="text-xs font-medium text-foreground">{example.label}</div>
                    <div className="text-xs text-muted">{example.description}</div>
                    <div className="text-[10px] text-muted font-mono mt-0.5 opacity-70">
                      {example.table}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-default',
              showGuide ? 'bg-accent text-accent-foreground' : 'text-muted hover:text-foreground',
            )}
          >
            <BookOpen className="w-3 h-3" />
            {t('query_explorer.guide')}
          </button>
        </div>
      </div>

      {/* Session ID input — appears only when the query uses {sessionId:String} */}
      {usesSessionParam && (
        <div className="flex items-center gap-2">
          <label
            className={clsx(
              'text-xs whitespace-nowrap font-mono',
              sessionIdMissing ? 'text-warning' : 'text-muted',
            )}
          >
            {'{sessionId:String}'}
            {sessionIdMissing && <span className="ml-1 text-warning">*</span>}
          </label>
          <input
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Required — paste a session ID to run this query"
            className={clsx(
              'flex-1 px-3 py-1.5 text-xs font-mono bg-background-elevated rounded-md text-foreground placeholder:text-muted focus:outline-none transition-default',
              sessionIdMissing
                ? 'border border-warning focus:border-warning'
                : 'border border-default focus:border-accent',
            )}
          />
          {sessionIdMissing && (
            <span className="text-[11px] text-warning whitespace-nowrap">Required to execute</span>
          )}
        </div>
      )}

      {tablesError && (
        <div className="flex items-start gap-2 p-2 bg-warning-subtle border border-warning/30 rounded-md">
          <AlertCircle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <div className="text-[11px] text-warning">
            Couldn't load the live table list — showing built-in defaults.
          </div>
        </div>
      )}

      {/* SQL Editor */}
      <div className="bg-background-elevated border border-default rounded-xl overflow-hidden shadow-sm">
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full p-4 bg-transparent text-foreground font-mono text-xs resize-none focus:outline-none min-h-[200px] leading-relaxed"
          placeholder="Enter your SQL query here... (Ctrl+Enter to execute)"
          spellCheck={false}
        />

        {/* Action bar */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-default bg-background-subtle gap-3">
          <div className="text-xs text-muted">
            Use{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{tenantId:String}'}
            </code>{' '}
            and{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{projectId:String}'}
            </code>{' '}
            for tenant/project isolation —{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{sessionId:String}'}
            </code>{' '}
            optional — results capped at {rowCap.toLocaleString()} rows
            <span className="hidden lg:inline">
              {' '}
              using the selected time range via{' '}
              <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
                {'{from:DateTime64(3)}'}
              </code>{' '}
              and{' '}
              <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
                {'{to:DateTime64(3)}'}
              </code>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSql('');
                clear();
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted hover:text-foreground transition-default"
            >
              <Trash2 className="w-3 h-3" />
              {t('query_explorer.clear')}
            </button>
            <button
              onClick={handleExecute}
              disabled={isLoading || !sql.trim() || !projectId || sessionIdMissing}
              title={sessionIdMissing ? 'Paste a session ID above to execute' : undefined}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-default',
                isLoading || !sql.trim() || !projectId || sessionIdMissing
                  ? 'bg-background-muted text-muted cursor-not-allowed'
                  : 'bg-accent text-accent-foreground hover:opacity-90 btn-press',
              )}
            >
              {isLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Play className="w-3 h-3" />
              )}
              {t('query_explorer.execute')}
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && <QueryError error={error} />}

      {/* Results */}
      {result && (
        <div className="bg-background-elevated border border-default rounded-xl shadow-sm overflow-hidden">
          {/* Results header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-default bg-background-subtle">
            <div className="text-xs text-muted">
              {t('query_explorer.results')} — {result.rowCount} rows
              {executionTimeMs != null && ` (${executionTimeMs}ms)`}
            </div>
            <button
              onClick={handleCopyResults}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-foreground transition-default"
            >
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          {/* Results table */}
          {result.rowCount === 0 ? (
            <div className="p-8 text-center text-xs text-muted">
              {t('query_explorer.no_results')}
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background-subtle">
                  <tr className="border-b border-default">
                    {result.columns.map((col, i) => (
                      <th
                        key={i}
                        className="text-left py-2 px-3 text-xs text-muted font-medium uppercase tracking-wider whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, rowIdx) => (
                    <tr
                      key={rowIdx}
                      className="border-b border-default last:border-0 hover:bg-background-subtle"
                    >
                      {row.map((cell, colIdx) => (
                        <td
                          key={colIdx}
                          className="py-1.5 px-3 text-foreground whitespace-nowrap max-w-xs truncate"
                        >
                          {formatCell(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Custom Attributes Guide */}
      {showGuide && <CustomAttributesGuide tables={availableTables} maxRows={rowCap} />}
    </div>
  );
}

// =============================================================================
// QUERY ERROR
// =============================================================================

interface ErrorHint {
  title: string;
  fix: string;
}

function classifyError(error: string): ErrorHint | null {
  const msg = error.toLowerCase();

  if (msg.includes('unknown expression') || msg.includes('unknown identifier')) {
    return {
      title: 'Unknown column or identifier',
      fix: 'Check that column names exist in this table. If filtering by a string value, use single quotes — not double quotes or backticks. Example: session_id = \'abc-123\' (not "abc-123" or `abc-123`). Also verify the column exists in this table using the Guide.',
    };
  }
  if (msg.includes('tenant_id') && msg.includes('filter')) {
    return {
      title: 'Tenant isolation filter required',
      fix: 'Add WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} to your query — these are automatically injected for security.',
    };
  }
  if (msg.includes('project_id') && msg.includes('filter')) {
    return {
      title: 'Project isolation filter required',
      fix: 'Add AND project_id = {projectId:String} to your WHERE clause.',
    };
  }
  if (
    msg.includes('not in allowlist') ||
    msg.includes('single analytics table') ||
    msg.includes('allowed')
  ) {
    return {
      title: 'Table not available for querying',
      fix: 'Select a table from the table picker above — only the listed tables are queryable.',
    };
  }
  if (
    msg.includes('join') ||
    msg.includes('union') ||
    msg.includes('cte') ||
    msg.includes('with ')
  ) {
    return {
      title: 'JOINs, UNIONs and CTEs are not supported',
      fix: 'Query one table at a time. Use separate queries for each table and combine results manually.',
    };
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('time limit')) {
    return {
      title: 'Query timed out',
      fix: 'Add tighter time filters (e.g. AND timestamp >= now() - INTERVAL 1 HOUR) or reduce the LIMIT to make the query faster.',
    };
  }
  if (msg.includes('syntax error') || msg.includes('failed at position')) {
    return {
      title: 'SQL syntax error',
      fix: 'Check your query for typos, mismatched parentheses, or unsupported keywords. Use the Example Queries dropdown for valid templates.',
    };
  }
  if (msg.includes('no project selected')) {
    return {
      title: 'No project selected',
      fix: 'Select a project from the project picker before running a query.',
    };
  }
  if (msg.includes('or conditions') || /\bor\b/.test(msg)) {
    return {
      title: 'OR conditions are not supported',
      fix: 'Break your query into multiple separate queries instead of using OR in the WHERE clause.',
    };
  }
  return null;
}

function QueryError({ error }: { error: string }) {
  const hint = classifyError(error);
  return (
    <div className="flex items-start gap-2 p-3 bg-error-subtle border border-error/30 rounded-lg">
      <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
      <div className="space-y-1 min-w-0">
        <div className="text-xs text-error break-words">{error}</div>
        {hint && (
          <div className="mt-1.5 p-2 bg-background-elevated rounded-md border border-default space-y-0.5">
            <div className="text-[11px] font-medium text-foreground">{hint.title}</div>
            <div className="text-[11px] text-muted">{hint.fix}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function formatCell(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(4);
  }
  return String(value);
}

// =============================================================================
// CUSTOM ATTRIBUTES GUIDE
// =============================================================================

interface CustomAttributesGuideProps {
  tables: AnalyticsTableDescriptor[];
  maxRows: number;
}

function CustomAttributesGuide({ tables, maxRows }: CustomAttributesGuideProps) {
  return (
    <div className="bg-background-elevated border border-default rounded-xl p-4 shadow-sm space-y-4">
      <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-accent" />
        Custom Attributes Guide
      </h3>

      <div className="space-y-3 text-xs">
        {/* Emitting */}
        <div>
          <h4 className="font-medium text-foreground mb-1">Emitting Custom Events</h4>
          <p className="text-muted mb-2">
            Use{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded">
              traceEmitter.logCustom()
            </code>{' '}
            to emit custom events with arbitrary attributes:
          </p>
          <pre className="p-3 bg-background-muted rounded-lg font-mono text-xs text-foreground overflow-x-auto">
            {`// Emit a custom event with attributes
traceEmitter.logCustom('custom_event', {
  score: 0.95,
  category: 'feedback',
  user_rating: 5,
  intent: 'booking_complete'
});

// These attributes are stored in the 'data' JSON column
// in the platform_events ClickHouse table`}
          </pre>
        </div>

        {/* Querying */}
        <div>
          <h4 className="font-medium text-foreground mb-1">Querying Custom Attributes</h4>
          <p className="text-muted mb-2">
            Use ClickHouse JSON functions to extract and filter on custom attributes:
          </p>
          <pre className="p-3 bg-background-muted rounded-lg font-mono text-xs text-foreground overflow-x-auto">
            {`-- Extract string attribute
JSONExtractString(data, 'category')

-- Extract numeric attribute
JSONExtractFloat(data, 'score')

-- Check if attribute exists
JSONHas(data, 'score')

-- Filter on attribute value
WHERE JSONExtractFloat(data, 'score') > 0.8

-- Full query example
SELECT
  JSONExtractString(data, 'category') AS category,
  avg(JSONExtractFloat(data, 'score')) AS avg_score,
  count() AS cnt
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND JSONHas(data, 'score')
GROUP BY category`}
          </pre>
        </div>

        {/* Available tables — live list from /api/.../analytics/tables */}
        <div>
          <h4 className="font-medium text-foreground mb-1">Available Tables</h4>
          {tables.length === 0 ? (
            <p className="text-muted">Loading table list…</p>
          ) : (
            <div className="space-y-1 text-muted">
              {tables.map((table) => (
                <p key={table.name}>
                  <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
                    {table.name}
                  </code>
                  {table.description ? ` — ${table.description}` : null}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* Parameterized queries */}
        <div>
          <h4 className="font-medium text-foreground mb-1">Parameterized Queries</h4>
          <p className="text-muted">
            Use{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{tenantId:String}'}
            </code>{' '}
            and{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{projectId:String}'}
            </code>{' '}
            — these are automatically injected with your current tenant and project IDs for security
            isolation. Every query must include both filters in the WHERE clause, and results are
            capped at {maxRows.toLocaleString()} rows per query.
          </p>
        </div>
      </div>
    </div>
  );
}
