/**
 * SourceCard Component
 *
 * Displays a source card with document count
 */

import { Upload } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import type { SearchAISource, KnowledgeBaseDetail } from '../../../api/search-ai';

interface SourceCardProps {
  source: SearchAISource;
  knowledgeBase: KnowledgeBaseDetail;
  onUploadMore?: () => void;
  onManage?: () => void;
}

export function SourceCard({ source, knowledgeBase, onUploadMore, onManage }: SourceCardProps) {
  const isManual = source.sourceType === 'manual';
  const icon = isManual ? '📁' : '🔌';
  const typeName = isManual
    ? 'Manual Upload'
    : `${source.sourceType.charAt(0).toUpperCase()}${source.sourceType.slice(1)} Connector`;

  const documentCount = source.documentCount;

  const formatTime = (dateStr: string | null): string => {
    if (!dateStr) return 'Never';
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);

      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  return (
    <Card padding="md" hoverable={false} className="mb-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{icon}</span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{source.name}</h3>
            <p className="text-xs text-muted">{typeName}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {isManual && onUploadMore && (
            <Button size="sm" variant="secondary" onClick={onUploadMore}>
              <Upload className="w-3 h-3" />
              Upload More
            </Button>
          )}
          {!isManual && onManage && (
            <Button size="sm" variant="secondary" onClick={onManage}>
              ⚙️ Configure
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onManage}>
            ⋯
          </Button>
        </div>
      </div>
      <div className="text-xs text-muted space-y-1">
        <div>
          <span>
            ├─ {documentCount} document{documentCount !== 1 ? 's' : ''}
          </span>
          {source.lastSyncAt && (
            <>
              <span className="mx-2">•</span>
              <span>Last updated: {formatTime(source.lastSyncAt)}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${source.status === 'syncing' ? 'bg-primary animate-pulse' : 'bg-success'}`}
          ></span>
          <span>Status: {source.status === 'syncing' ? 'Syncing...' : 'Active'}</span>
        </div>
      </div>
    </Card>
  );
}
