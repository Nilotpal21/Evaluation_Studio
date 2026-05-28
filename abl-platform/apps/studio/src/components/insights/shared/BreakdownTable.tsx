'use client';

import { useState } from 'react';
import { clsx } from 'clsx';
import { ChevronUp, ChevronDown, Info } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { SEMANTIC_CHART_COLORS } from '@agent-platform/design-tokens';
import { Tooltip, TooltipProvider } from '../../ui/Tooltip';

interface BreakdownRow {
  dimension: string;
  conversations: number;
  confidence: number;
  qualityScore: number;
  avgSentiment: number;
  trend: number[];
}

interface BreakdownTableProps {
  data: BreakdownRow[];
  onRowClick?: (dimension: string) => void;
}

type SortKey = 'dimension' | 'conversations' | 'confidence' | 'qualityScore' | 'avgSentiment';

function InlineSparkline({ data, color }: { data: number[]; color: string }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <div className="w-16 h-6">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function scoreColor(value: number, max: number, min = 0): string {
  const ratio = (value - min) / (max - min);
  if (ratio >= 0.75) return 'text-success';
  if (ratio >= 0.5) return 'text-foreground';
  if (ratio >= 0.25) return 'text-warning';
  return 'text-error';
}

export function BreakdownTable({ data, onRowClick }: BreakdownTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('conversations');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sorted = [...data].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === 'asc'
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  const SortIcon = sortDir === 'asc' ? ChevronUp : ChevronDown;

  const columns: { key: SortKey; label: string; align: string; tooltip?: string }[] = [
    { key: 'dimension', label: 'Agent', align: 'text-left' },
    {
      key: 'conversations',
      label: 'Volume',
      align: 'text-right',
      tooltip: 'Total conversations handled by this agent in the selected period',
    },
    {
      key: 'confidence',
      label: 'Confidence',
      align: 'text-right',
      tooltip:
        'Average intent classification confidence (0-100%). How certain the AI is about detected intents',
    },
    {
      key: 'qualityScore',
      label: 'Quality',
      align: 'text-right',
      tooltip:
        'Average quality score (0-5) from LLM evaluation pipeline. Dash means no evaluations ran for this agent',
    },
    {
      key: 'avgSentiment',
      label: 'Sentiment',
      align: 'text-right',
      tooltip:
        'Average customer sentiment score (-1 to +1) from sentiment analysis. Dash means no analysis ran for this agent',
    },
  ];

  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-xs text-muted border-b border-default">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={clsx(
                    'px-4 py-3 font-medium cursor-pointer hover:text-foreground transition-default select-none',
                    col.align,
                  )}
                  onClick={() => handleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.tooltip && (
                      <Tooltip content={col.tooltip} side="top">
                        <button
                          type="button"
                          className="text-subtle hover:text-muted transition-default"
                          aria-label={`About ${col.label}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Info className="w-3 h-3" />
                        </button>
                      </Tooltip>
                    )}
                    {sortKey === col.key && <SortIcon className="w-3 h-3" />}
                  </span>
                </th>
              ))}
              <th className="px-4 py-3 font-medium text-right text-xs text-muted">
                <span className="inline-flex items-center gap-1 justify-end">
                  Trend
                  <Tooltip
                    content="Quality trend sparkline over the selected period. Shows when enough daily data points exist"
                    side="top"
                  >
                    <button
                      type="button"
                      className="text-subtle hover:text-muted transition-default"
                      aria-label="About Trend"
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  </Tooltip>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.dimension}
                onClick={() => onRowClick?.(row.dimension)}
                className={clsx(
                  'border-b border-muted transition-default',
                  onRowClick && 'cursor-pointer hover:bg-background-muted',
                )}
              >
                <td className="px-4 py-3 text-sm font-medium text-foreground">{row.dimension}</td>
                <td className="px-4 py-3 text-sm text-muted text-right">
                  {row.conversations.toLocaleString()}
                </td>
                <td
                  className={clsx(
                    'px-4 py-3 text-sm text-right font-medium',
                    scoreColor(row.confidence, 100),
                  )}
                >
                  {row.confidence.toFixed(1)}%
                </td>
                <td
                  className={clsx(
                    'px-4 py-3 text-sm text-right font-medium',
                    row.qualityScore === 0 ? 'text-subtle' : scoreColor(row.qualityScore, 5),
                  )}
                >
                  {row.qualityScore === 0 ? '—' : row.qualityScore.toFixed(1)}
                </td>
                <td
                  className={clsx(
                    'px-4 py-3 text-sm text-right font-medium',
                    row.avgSentiment === 0 && row.qualityScore === 0
                      ? 'text-subtle'
                      : scoreColor(row.avgSentiment, 1, -1),
                  )}
                >
                  {row.avgSentiment === 0 && row.qualityScore === 0
                    ? '—'
                    : row.avgSentiment.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex justify-end">
                    {row.trend.length > 0 ? (
                      <InlineSparkline
                        data={row.trend}
                        color={
                          row.qualityScore >= 3.5
                            ? SEMANTIC_CHART_COLORS.success
                            : row.qualityScore >= 2.0
                              ? SEMANTIC_CHART_COLORS.warning
                              : SEMANTIC_CHART_COLORS.error
                        }
                      />
                    ) : (
                      <span className="text-subtle text-xs">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
