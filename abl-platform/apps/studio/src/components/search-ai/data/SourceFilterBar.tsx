/**
 * SourceFilterBar Component
 *
 * Horizontal bar with source-type filter badges and upload shortcut.
 */

import { useMemo } from 'react';
import { Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { isUploadableSource, getSourceDisplayName } from '@/lib/upload-constants';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import type { SearchAISource, KnowledgeBaseDetail } from '../../../api/search-ai';

/** Max number of sources to show as individual chips instead of type grouping */
const INDIVIDUAL_SOURCE_THRESHOLD = 8;

interface SourceFilterBarProps {
  sources: SearchAISource[];
  activeFilter: string | null;
  onFilterChange: (sourceType: string | null) => void;
  onUploadToSource?: (sourceId: string, sourceName: string) => void;
  /** When a specific source is selected (e.g., from "View Documents") */
  activeSourceId?: string | null;
  activeSourceName?: string | null;
  onClearSourceId?: () => void;
  /** Select a specific source by ID */
  onSelectSource?: (sourceId: string) => void;
  knowledgeBase?: KnowledgeBaseDetail;
}

export function SourceFilterBar({
  sources,
  activeFilter,
  onFilterChange,
  onUploadToSource,
  activeSourceId,
  activeSourceName,
  onClearSourceId,
  onSelectSource,
  knowledgeBase,
}: SourceFilterBarProps) {
  const t = useTranslations('search_ai.source_filter');

  const getDocumentCount = (source: SearchAISource) => {
    return source.documentCount;
  };

  const groupedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const source of sources) {
      counts[source.sourceType] = (counts[source.sourceType] || 0) + 1;
    }
    return counts;
  }, [sources]);

  const sourceTypes = useMemo(() => Object.keys(groupedCounts).sort(), [groupedCounts]);

  // Show upload shortcut ONLY when activeFilter is 'manual' (or 'file')
  // AND exactly ONE source matches. If multiple sources match, hide shortcut.
  const filteredSources = activeFilter ? sources.filter((s) => s.sourceType === activeFilter) : [];
  const showUploadShortcut =
    onUploadToSource &&
    activeFilter !== null &&
    isUploadableSource(activeFilter) &&
    filteredSources.length === 1;

  // "All" should be highlighted only when no sourceType AND no sourceId is active
  const isAllActive = activeFilter === null && !activeSourceId;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Active source badge — shown in type-grouping mode when a specific source is filtered */}
      {activeSourceId && activeSourceName && sources.length > INDIVIDUAL_SOURCE_THRESHOLD && (
        <button
          onClick={() => onClearSourceId?.()}
          aria-label={t('aria_clear_source', { name: activeSourceName })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-subtle text-accent ring-1 ring-accent/30 transition-default focus-ring"
        >
          {activeSourceName}
          <X className="w-3 h-3" />
        </button>
      )}

      {/* All filter */}
      <button
        onClick={() => {
          onFilterChange(null);
          onClearSourceId?.();
        }}
        aria-label={t('aria_show_all')}
        aria-pressed={isAllActive}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-default focus-ring ${
          isAllActive
            ? 'bg-accent-subtle text-accent ring-1 ring-accent/30'
            : 'bg-background-muted text-muted hover:text-foreground hover:bg-background-elevated'
        }`}
      >
        {t('all')}
        <Badge variant={isAllActive ? 'accent' : 'default'} className="ml-0.5">
          {sources.length}
        </Badge>
      </button>

      {/* Individual source chips (<=8 sources) or per-sourceType filters (>8) */}
      {sources.length <= INDIVIDUAL_SOURCE_THRESHOLD
        ? sources.map((source) => {
            const isActive = activeSourceId === source._id;
            return (
              <button
                key={source._id}
                onClick={() => {
                  if (isActive) {
                    onClearSourceId?.();
                  } else {
                    onFilterChange(null);
                    onSelectSource?.(source._id);
                  }
                }}
                aria-label={t('aria_filter_source', { name: getSourceDisplayName(source.name) })}
                aria-pressed={isActive}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-default focus-ring ${
                  isActive
                    ? 'bg-accent-subtle text-accent ring-1 ring-accent/30'
                    : 'bg-background-muted text-muted hover:text-foreground hover:bg-background-elevated'
                }`}
              >
                {getSourceDisplayName(source.name)}
                <Badge variant={isActive ? 'accent' : 'default'} className="ml-0.5">
                  {getDocumentCount(source)}
                </Badge>
              </button>
            );
          })
        : sourceTypes.map((sourceType) => (
            <button
              key={sourceType}
              onClick={() => {
                onFilterChange(sourceType === activeFilter ? null : sourceType);
                onClearSourceId?.();
              }}
              aria-label={t('aria_filter_by', { type: sourceType })}
              aria-pressed={activeFilter === sourceType}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-default focus-ring ${
                activeFilter === sourceType
                  ? 'bg-accent-subtle text-accent ring-1 ring-accent/30'
                  : 'bg-background-muted text-muted hover:text-foreground hover:bg-background-elevated'
              }`}
            >
              {t.has('type_' + sourceType) ? t('type_' + sourceType) : sourceType}
              <Badge
                variant={activeFilter === sourceType ? 'accent' : 'default'}
                className="ml-0.5"
              >
                {groupedCounts[sourceType]}
              </Badge>
            </button>
          ))}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Upload shortcut for manual/file sources */}
      {showUploadShortcut && (
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload className="w-3.5 h-3.5" />}
          onClick={() => onUploadToSource?.(filteredSources[0]._id, filteredSources[0].name)}
        >
          {t('upload_files')}
        </Button>
      )}
    </div>
  );
}
