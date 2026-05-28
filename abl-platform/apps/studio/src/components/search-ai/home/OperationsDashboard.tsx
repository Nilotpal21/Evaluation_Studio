/**
 * OperationsDashboard Component
 *
 * Dashboard shell for mature knowledge bases.
 * Shows quick stats and document status summary.
 */

import { FileText, Layers, Database } from 'lucide-react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Card } from '../../ui/Card';
import { SkeletonText } from '../../ui/Skeleton';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';
import { fetchDocumentStatusSummary, type DocumentStatusSummary } from '../../../api/search-ai';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';
import { NeedsAttentionCard } from './NeedsAttentionCard';
import { ActivityFeed } from './ActivityFeed';
import { SourceCard } from './SourceCard';

interface OperationsDashboardProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources?: SearchAISource[];
  onNavigate?: (tab: string, subSection?: string) => void;
  onOpenUpload?: () => void;
  onRefreshSources?: () => void;
}

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  onClick?: () => void;
  breakdown?: { label: string; value: string | number }[];
}

function StatCard({ label, value, icon, onClick, breakdown }: StatCardProps) {
  return (
    <Card hoverable={!!onClick} onClick={onClick} padding="md">
      <div className="flex items-center gap-3 mb-3">
        <div className="rounded-lg bg-background-muted p-2 text-muted">{icon}</div>
        <div>
          <p className="text-xs text-muted uppercase tracking-wide">{label}</p>
          <p className="text-xl font-semibold text-foreground font-mono">{value}</p>
        </div>
      </div>
      {breakdown && breakdown.length > 0 && (
        <div className="pt-2 border-t border-default space-y-1">
          {breakdown.map((item, idx) => (
            <div key={idx} className="flex justify-between text-xs">
              <span className="text-muted">{item.label}:</span>
              <span className="text-foreground font-medium font-mono">{item.value}</span>
            </div>
          ))}
        </div>
      )}
      {onClick && <div className="mt-2 text-xs text-primary hover:underline">View All →</div>}
    </Card>
  );
}

export function OperationsDashboard({
  knowledgeBase,
  indexId,
  sources = [],
  onNavigate,
  onOpenUpload,
  onRefreshSources,
}: OperationsDashboardProps) {
  const t = useTranslations('search_ai.operations');
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);
  const index = knowledgeBase.index;

  const {
    data: statusData,
    error: statusError,
    isLoading: statusLoading,
  } = useSWR<DocumentStatusSummary>(
    indexId ? `/api/search-ai/indexes/${indexId}/documents/status-summary` : null,
    () => fetchDocumentStatusSummary(indexId),
  );

  // Calculate source breakdown
  const manualSourcesCount = sources.filter((s) => s.sourceType === 'manual').length;
  const connectorSourcesCount = sources.length - manualSourcesCount;

  // Calculate document status breakdown — aggregate ALL statuses into three buckets.
  // Backend returns per-status counts; anything that isn't 'indexed' or an error/fail
  // state is considered "in progress" (pending, extracting, extracted, enriching, etc.).
  const statusCounts = statusData?.documentStatuses ?? [];
  const getCount = (id: string) => statusCounts.find((s) => id === s._id)?.count || 0;

  const indexedCount = getCount('indexed');
  const failedCount = getCount('error') + getCount('failed');
  const processingCount =
    getCount('pending') +
    getCount('extracting') +
    getCount('extracted') +
    getCount('enriching') +
    getCount('enriched') +
    getCount('embedding') +
    getCount('processing') +
    getCount('pending_field_selection');

  // Limit sources display to 5
  const MAX_SOURCES_DISPLAY = 5;
  const sourcesToShow = sources.slice(0, MAX_SOURCES_DISPLAY);
  const hasMoreSources = sources.length > MAX_SOURCES_DISPLAY;

  // Format last indexed time for chunks
  const formatLastIndexed = (dateStr: string | null): string => {
    if (!dateStr) return 'Never';
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return '1 day ago';
      if (diffDays < 7) return `${diffDays} days ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  return (
    <div className="space-y-6">
      {/* Stats Section */}
      <div>
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-3 flex items-center gap-2">
          📊 Knowledge Base Stats
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard
            label={t('label_sources')}
            value={index?.sourceCount ?? knowledgeBase.connectorCount}
            icon={<Database className="w-4 h-4" />}
            onClick={() => {
              setPendingFilter({ view: 'sources' });
              onNavigate?.('data');
            }}
            breakdown={[
              { label: 'Manual', value: manualSourcesCount },
              { label: 'Connectors', value: connectorSourcesCount },
            ]}
          />
          <StatCard
            label={t('label_documents')}
            value={index?.documentCount ?? knowledgeBase.documentCount}
            icon={<FileText className="w-4 h-4" />}
            onClick={() => {
              setPendingFilter({ view: 'documents' });
              onNavigate?.('data');
            }}
            breakdown={[
              { label: 'Indexed', value: indexedCount },
              { label: 'Processing', value: processingCount },
              { label: 'Failed', value: failedCount },
            ]}
          />
          <StatCard
            label={t('label_chunks')}
            value={index?.chunkCount ?? 0}
            icon={<Layers className="w-4 h-4" />}
            onClick={() => {
              setPendingFilter({ view: 'chunks' });
              onNavigate?.('data');
            }}
            breakdown={[
              { label: 'Coverage', value: '100%' },
              { label: 'Last', value: formatLastIndexed(knowledgeBase.lastIndexedAt) },
            ]}
          />
        </div>
      </div>

      {/* Bottom Grid: Needs Attention + Activity */}
      <div className="grid grid-cols-2 gap-4">
        <NeedsAttentionCard kbId={knowledgeBase._id} />
        <ActivityFeed kbId={knowledgeBase._id} />
      </div>

      {/* Your Sources Section with Quick Actions */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide flex items-center gap-2">
            🗂️ Your Sources
          </h2>
          {hasMoreSources && (
            <button
              onClick={() => {
                setPendingFilter({ view: 'sources' });
                onNavigate?.('data');
              }}
              className="text-xs text-primary hover:underline"
            >
              View All {sources.length} Sources →
            </button>
          )}
        </div>

        {/* Source Cards */}
        {sources.length > 0 && (
          <div>
            {sourcesToShow.map((source) => (
              <SourceCard
                key={source._id}
                source={source}
                knowledgeBase={knowledgeBase}
                onUploadMore={source.sourceType === 'manual' ? onOpenUpload : undefined}
                onManage={() => {
                  setPendingFilter({ view: 'sources' });
                  onNavigate?.('data');
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
