/**
 * QueryCompare Component
 *
 * Side-by-side comparison of two selected queries.
 * Shows query text, type, latency breakdown, result count, and timestamp.
 * Highlights metrics that differ by more than 20%.
 */

'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '../../ui/Badge';
import type { QueryHistoryItem } from '../../../api/search-ai';

interface QueryCompareProps {
  queries: QueryHistoryItem[];
}

/** Returns true if two numbers differ by more than 20% relative to their max. */
function diffSignificant(a: number, b: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return false;
  return Math.abs(a - b) / max > 0.2;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface MetricRowProps {
  label: string;
  a: string | number;
  b: string | number;
  highlight?: boolean;
}

function MetricRow({ label, a, b, highlight }: MetricRowProps) {
  const cellClass = highlight ? 'text-warning font-medium' : 'text-foreground';
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-default last:border-b-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-xs text-right ${cellClass}`}>{a}</span>
      <span className={`text-xs text-right ${cellClass}`}>{b}</span>
    </div>
  );
}

/** Bar showing relative latency proportions. */
function LatencyBar({
  query,
  maxMs,
  labels,
}: {
  query: QueryHistoryItem;
  maxMs: number;
  labels: { vocab: string; search: string; rerank: string };
}) {
  const total = query.totalLatencyMs || 1;
  const segments = [
    { label: labels.vocab, ms: query.vocabularyResolveMs, color: 'bg-info' },
    { label: labels.search, ms: query.vectorSearchMs, color: 'bg-accent' },
    { label: labels.rerank, ms: query.rerankMs, color: 'bg-purple' },
  ];
  const widthPct = maxMs > 0 ? (total / maxMs) * 100 : 100;

  return (
    <div className="space-y-1">
      <div
        className="h-3 rounded-full bg-background-muted overflow-hidden"
        style={{ width: `${widthPct}%` }}
      >
        <div className="h-full flex">
          {segments.map((seg) => {
            const pct = total > 0 ? (seg.ms / total) * 100 : 0;
            if (pct === 0) return null;
            return (
              <div
                key={seg.label}
                className={`${seg.color} h-full`}
                style={{ width: `${pct}%` }}
                title={`${seg.label}: ${seg.ms}ms`}
              />
            );
          })}
        </div>
      </div>
      <div className="flex gap-3 text-[10px] text-muted">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded-sm ${seg.color}`} />
            {seg.label}: {seg.ms}ms
          </span>
        ))}
      </div>
    </div>
  );
}

export function QueryCompare({ queries }: QueryCompareProps) {
  const t = useTranslations('search_ai.query_history');

  if (queries.length < 2) {
    return <div className="text-sm text-muted py-6 text-center">{t('compare_placeholder')}</div>;
  }

  const [a, b] = queries;
  const maxMs = Math.max(a.totalLatencyMs, b.totalLatencyMs);
  const latencyLabels = {
    vocab: t('latency_vocab'),
    search: t('latency_search'),
    rerank: t('latency_rerank'),
  };

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-foreground">{t('compare_title')}</h4>

      {/* Column headers */}
      <div className="grid grid-cols-3 gap-2 pb-1 border-b border-default">
        <span className="text-xs text-muted" />
        <span className="text-xs font-medium text-foreground text-right">
          {t('compare_query')} A
        </span>
        <span className="text-xs font-medium text-foreground text-right">
          {t('compare_query')} B
        </span>
      </div>

      {/* Query texts */}
      <MetricRow label={t('compare_query')} a={a.queryText} b={b.queryText} />
      <MetricRow
        label={t('compare_type')}
        a={a.queryType}
        b={b.queryType}
        highlight={a.queryType !== b.queryType}
      />
      <MetricRow
        label={t('compare_results')}
        a={a.resultCount}
        b={b.resultCount}
        highlight={diffSignificant(a.resultCount, b.resultCount)}
      />
      <MetricRow
        label={t('compare_latency')}
        a={`${a.totalLatencyMs}ms`}
        b={`${b.totalLatencyMs}ms`}
        highlight={diffSignificant(a.totalLatencyMs, b.totalLatencyMs)}
      />
      <MetricRow
        label={t('compare_vocab_ms')}
        a={`${a.vocabularyResolveMs}ms`}
        b={`${b.vocabularyResolveMs}ms`}
        highlight={diffSignificant(a.vocabularyResolveMs, b.vocabularyResolveMs)}
      />
      <MetricRow
        label={t('compare_search_ms')}
        a={`${a.vectorSearchMs}ms`}
        b={`${b.vectorSearchMs}ms`}
        highlight={diffSignificant(a.vectorSearchMs, b.vectorSearchMs)}
      />
      <MetricRow
        label={t('compare_rerank_ms')}
        a={`${a.rerankMs}ms`}
        b={`${b.rerankMs}ms`}
        highlight={diffSignificant(a.rerankMs, b.rerankMs)}
      />
      <MetricRow
        label={t('compare_timestamp')}
        a={formatTimestamp(a.timestamp)}
        b={formatTimestamp(b.timestamp)}
      />

      {/* Latency bars */}
      <div className="space-y-3 pt-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted">{t('compare_query')} A</span>
            <Badge variant="default">{a.totalLatencyMs}ms</Badge>
          </div>
          <LatencyBar query={a} maxMs={maxMs} labels={latencyLabels} />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs text-muted">{t('compare_query')} B</span>
            <Badge variant="default">{b.totalLatencyMs}ms</Badge>
          </div>
          <LatencyBar query={b} maxMs={maxMs} labels={latencyLabels} />
        </div>
      </div>
    </div>
  );
}
