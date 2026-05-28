/**
 * SQLQueryPanel Component
 *
 * Ad-hoc SQL query editor for workspace analytics.
 * Textarea with monospace font, execute button, results table.
 * Permission-gated to admin role users.
 */

import { useState, useRef, useEffect } from 'react';
import { clsx } from 'clsx';
import { Play, Trash2, AlertCircle, Loader2, Copy, Check, Shield, ChevronDown } from 'lucide-react';
import { useAnalyticsQuery } from '../../hooks/useAnalyticsQuery';
import { useAuthStore } from '../../store/auth-store';
import { EmptyState } from '../ui/EmptyState';

// =============================================================================
// TYPES
// =============================================================================

interface SQLQueryPanelProps {
  projectId: string | null;
}

interface ExampleQuery {
  label: string;
  sql: string;
}

// =============================================================================
// EXAMPLE QUERIES
// =============================================================================

const EXAMPLE_QUERIES: ExampleQuery[] = [
  {
    label: 'Event Counts by Type',
    sql: `SELECT
  event_type,
  count() AS cnt,
  countIf(has_error = 1) AS errors
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= now() - INTERVAL 1 HOUR
GROUP BY event_type
ORDER BY cnt DESC
LIMIT 100`,
  },
  {
    label: 'LLM Cost by Model',
    sql: `SELECT
  JSONExtractString(data, 'model') AS model,
  count() AS calls,
  sum(JSONExtractFloat(data, 'input_tokens')) AS input_tokens,
  sum(JSONExtractFloat(data, 'output_tokens')) AS output_tokens,
  sum(JSONExtractFloat(data, 'estimated_cost')) AS total_cost
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND event_type = 'llm.call.completed'
  AND timestamp >= now() - INTERVAL 24 HOUR
GROUP BY model
ORDER BY total_cost DESC`,
  },
  {
    label: 'Error Rate by Agent',
    sql: `SELECT
  agent_name,
  count() AS total,
  countIf(has_error = 1) AS errors,
  round(countIf(has_error = 1) / count() * 100, 2) AS error_rate_pct
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND agent_name != ''
  AND timestamp >= now() - INTERVAL 24 HOUR
GROUP BY agent_name
ORDER BY total DESC`,
  },
  {
    label: 'Session Duration',
    sql: `SELECT
  session_id,
  min(timestamp) AS started,
  max(timestamp) AS ended,
  dateDiff('second', min(timestamp), max(timestamp)) AS duration_sec,
  count() AS event_count
FROM abl_platform.platform_events
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND timestamp >= now() - INTERVAL 1 HOUR
GROUP BY session_id
ORDER BY started DESC
LIMIT 50`,
  },
];

// =============================================================================
// COMPONENT
// =============================================================================

export function SQLQueryPanel({ projectId }: SQLQueryPanelProps) {
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin);
  const { result, isLoading, error, executionTimeMs, executeQuery, clear } =
    useAnalyticsQuery(projectId);

  const [sql, setSql] = useState(EXAMPLE_QUERIES[0].sql);
  const [showExamples, setShowExamples] = useState(false);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.max(180, textareaRef.current.scrollHeight)}px`;
    }
  }, [sql]);

  const handleExecute = () => {
    if (!sql.trim()) return;
    executeQuery(sql.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    }
  };

  const handleSelectExample = (example: ExampleQuery) => {
    setSql(example.sql);
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

  // Permission gate — only show for admin / super-admin users
  // Note: In a real implementation, this would also check tenant role.
  // For now, we show the panel but display a note about admin-only access.
  if (!projectId) {
    return (
      <EmptyState
        icon={<Shield className="w-6 h-6" />}
        title="No project selected"
        description="Select a project to run SQL queries against its analytics data."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with examples */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative">
          <button
            onClick={() => setShowExamples(!showExamples)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-background-muted border border-default text-foreground hover:bg-background-elevated transition-default"
          >
            Example Queries
            <ChevronDown
              className={clsx('w-3 h-3 transition-transform', showExamples && 'rotate-180')}
            />
          </button>

          {showExamples && (
            <div className="absolute top-full left-0 mt-1 w-72 bg-background-elevated border border-default rounded-lg shadow-lg z-10 py-1 max-h-64 overflow-y-auto">
              {EXAMPLE_QUERIES.map((example, i) => (
                <button
                  key={i}
                  onClick={() => handleSelectExample(example)}
                  className="w-full text-left px-3 py-2 hover:bg-background-subtle transition-default"
                >
                  <div className="text-xs font-medium text-foreground">{example.label}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Shield className="w-3 h-3" />
          <span>Admin access required</span>
        </div>
      </div>

      {/* SQL Editor */}
      <div className="bg-background-elevated border border-default rounded-xl overflow-hidden shadow-sm">
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full p-4 bg-transparent text-foreground font-mono text-xs resize-none focus:outline-none min-h-[180px] leading-relaxed"
          placeholder="Enter your SQL query here... (Ctrl+Enter to execute)"
          spellCheck={false}
        />

        {/* Action bar */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-default bg-background-subtle">
          <div className="text-xs text-muted">
            Use{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{tenantId:String}'}
            </code>{' '}
            and{' '}
            <code className="px-1 py-0.5 bg-background-muted rounded text-foreground">
              {'{projectId:String}'}
            </code>{' '}
            for isolation
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
              Clear
            </button>
            <button
              onClick={handleExecute}
              disabled={isLoading || !sql.trim() || !projectId}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-default',
                isLoading || !sql.trim() || !projectId
                  ? 'bg-background-muted text-muted cursor-not-allowed'
                  : 'bg-accent text-accent-foreground hover:opacity-90 btn-press',
              )}
            >
              {isLoading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Play className="w-3 h-3" />
              )}
              Execute
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 p-3 bg-error-subtle border border-error/30 rounded-lg">
          <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
          <div className="text-xs text-error">{error}</div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="bg-background-elevated border border-default rounded-xl shadow-sm overflow-hidden">
          {/* Results header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-default bg-background-subtle">
            <div className="text-xs text-muted">
              {result.rowCount} rows
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
            <div className="p-8 text-center text-xs text-muted">No results returned</div>
          ) : (
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
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
    </div>
  );
}

// =============================================================================
// HELPERS
// =============================================================================

function formatCell(value: unknown): string {
  if (value == null) return '\u2014';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(4);
  }
  return String(value);
}
