/**
 * SourcesAggregateSummary Component
 *
 * Horizontal stat row showing totalDocs, totalSize (formatted bytes),
 * source count by type pills, and tokens-expiring warning.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '../../ui/Badge';

export interface SourceAggregates {
  totalDocs: number;
  totalSizeBytes: number;
  sourceCountByType: Record<string, number>;
  sourceCountByStatus: Record<string, number>;
  tokensExpiringCount: number;
}

interface SourcesAggregateSummaryProps {
  aggregates: SourceAggregates;
  sourceCount: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function SourcesAggregateSummary({ aggregates, sourceCount }: SourcesAggregateSummaryProps) {
  const t = useTranslations('search_ai.sources_table');

  return (
    <div
      className="flex flex-wrap items-center gap-3 text-xs text-muted px-1 mb-3"
      role="status"
      aria-label={t('aggregate_summary')}
    >
      <span className="font-medium">{t('aggregate_sources', { count: sourceCount })}</span>
      <span>{t('aggregate_docs', { count: aggregates.totalDocs.toLocaleString() })}</span>
      {aggregates.totalSizeBytes > 0 && <span>{formatBytes(aggregates.totalSizeBytes)}</span>}
      {Object.entries(aggregates.sourceCountByType).map(([type, count]) => (
        <Badge key={type} variant="info">
          {type}: {count}
        </Badge>
      ))}
      {aggregates.tokensExpiringCount > 0 && (
        <span className="flex items-center gap-1 text-warning">
          <AlertTriangle className="w-3 h-3" />
          {t('aggregate_tokens_expiring', { count: aggregates.tokensExpiringCount })}
        </span>
      )}
    </div>
  );
}
