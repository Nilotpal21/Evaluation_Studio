/**
 * WaitingForContent Component
 *
 * Shown when sources exist but no documents have been ingested yet.
 * Displays a mini source table + quick action buttons.
 * Replaces the dead-end SetupGuide checklist that showed "Add content ✓"
 * but gave the user nothing useful to do (#73).
 */

import { useCallback } from 'react';
import { Upload, Plus, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { isUploadableSource } from '@/lib/upload-constants';
import { Card } from '../../ui/Card';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import type { KnowledgeBaseDetail, SearchAISource } from '../../../api/search-ai';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

interface WaitingForContentProps {
  knowledgeBase: KnowledgeBaseDetail;
  indexId: string;
  sources: SearchAISource[];
  onRefreshSources: () => void;
  onNavigate?: (tab: string, subSection?: string) => void;
  /** Called when user clicks Upload — parent opens FileUploadDialog */
  onUploadFiles?: () => void;
}

const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  pending: 'default',
  syncing: 'info',
  disabled: 'default',
  error: 'error',
};

export function WaitingForContent({
  knowledgeBase,
  indexId,
  sources,
  onRefreshSources,
  onNavigate,
  onUploadFiles,
}: WaitingForContentProps) {
  const t = useTranslations('search_ai.waiting');
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);
  const manualSource = sources.find((s) => isUploadableSource(s.sourceType));

  const handleUploadFiles = useCallback(() => {
    if (manualSource && onUploadFiles) {
      onUploadFiles();
    } else {
      // No manual source — navigate to Data tab to add one
      setPendingFilter({ view: 'documents', autoOpenAddSource: true });
      onNavigate?.('data');
    }
  }, [manualSource, onUploadFiles, setPendingFilter, onNavigate]);

  const handleAddSource = useCallback(() => {
    setPendingFilter({ autoOpenAddSource: true });
    onNavigate?.('data');
  }, [setPendingFilter, onNavigate]);

  return (
    <>
      <div className="space-y-6">
        {/* Title */}
        <div>
          <h3 className="text-base font-semibold text-foreground">{t('title')}</h3>
          <p className="text-sm text-muted mt-1">{t('description')}</p>
        </div>

        {/* Source mini-table */}
        <Card hoverable={false} padding="lg">
          <h4 className="text-sm font-semibold text-foreground mb-3">{t('sources_title')}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-default">
                  <th className="pb-2 font-medium">{t('col_name')}</th>
                  <th className="pb-2 font-medium">{t('col_type')}</th>
                  <th className="pb-2 font-medium">{t('col_status')}</th>
                  <th className="pb-2 font-medium text-right">{t('col_docs')}</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source._id} className="border-b border-default last:border-0">
                    <td className="py-2.5 font-medium text-foreground">{source.name}</td>
                    <td className="py-2.5">
                      <Badge variant="info">{source.sourceType}</Badge>
                    </td>
                    <td className="py-2.5">
                      <Badge variant={statusVariant[source.status] ?? 'default'} dot>
                        {source.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-right text-muted">{source.documentCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Quick actions */}
        <Card hoverable={false} padding="md">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload className="w-3.5 h-3.5" />}
              onClick={handleUploadFiles}
            >
              {t('action_upload')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={handleAddSource}
            >
              {t('action_add_source')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Settings className="w-3.5 h-3.5" />}
              onClick={() => onNavigate?.('intelligence')}
            >
              {t('action_configure')}
            </Button>
          </div>
        </Card>

        {/* Hint */}
        <p className="text-xs text-muted text-center">{t('hint')}</p>
      </div>
    </>
  );
}
