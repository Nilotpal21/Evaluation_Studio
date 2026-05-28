/**
 * SourceCard Component
 *
 * Individual source card for card view. Shows type icon, name,
 * status badge, secondary info line, and action menu.
 */

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Upload, Trash2, MoreHorizontal } from 'lucide-react';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { DropdownMenu, DropdownMenuItem } from '../../ui/DropdownMenu';
import { Button } from '../../ui/Button';
import { getSourceDisplayName } from '@/lib/upload-constants';
import type { SearchAISource, KnowledgeBaseDetail } from '../../../api/search-ai';

const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  awaiting_auth: 'warning',
  draft: 'default',
  pending: 'default',
  syncing: 'info',
  crawling: 'info',
  partial: 'warning',
  disabled: 'default',
  error: 'error',
  auth_failed: 'error',
};

interface SourceCardProps {
  source: SearchAISource;
  connectorId: string | null;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onViewDocuments: () => void;
  onUploadToSource?: () => void;
  knowledgeBase?: KnowledgeBaseDetail;
  /** Override status for display (e.g. derived 'crawling' from active CrawlJobs) */
  effectiveStatus?: string;
}

export function SourceCard({
  source,
  connectorId,
  onClick,
  onDelete,
  onViewDocuments,
  onUploadToSource,
  knowledgeBase,
  effectiveStatus: effectiveStatusProp,
}: SourceCardProps) {
  const t = useTranslations('search_ai.sources_table');
  const displayStatus = effectiveStatusProp ?? source.status;

  const getDocumentCount = () => {
    return source.documentCount;
  };

  // Guard against Radix DropdownMenu closing and firing a pointer event
  // back onto the card, which would trigger navigation after a menu action.
  const menuActionRef = useRef(false);
  const handleCardClick = () => {
    if (menuActionRef.current) {
      menuActionRef.current = false;
      return;
    }
    onClick();
  };
  const guardMenuAction = () => {
    menuActionRef.current = true;
    // Reset after a tick so normal clicks still work
    setTimeout(() => {
      menuActionRef.current = false;
    }, 100);
  };

  return (
    <div
      onClick={handleCardClick}
      className="relative flex flex-col gap-2 p-4 rounded-xl border border-default bg-background-elevated hover:border-info/50 cursor-pointer transition-all"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="font-medium text-foreground truncate text-sm">
            {getSourceDisplayName(source.name)}
          </h3>
          <Badge
            variant={statusVariant[displayStatus] ?? 'default'}
            dot
            pulse={displayStatus === 'crawling' || displayStatus === 'syncing'}
          >
            {displayStatus}
          </Badge>
        </div>
        <DropdownMenu
          trigger={
            <Button
              variant="ghost"
              size="sm"
              icon={<MoreHorizontal className="w-4 h-4" />}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('col_actions')}
            />
          }
        >
          <DropdownMenuItem
            onSelect={() => {
              guardMenuAction();
              onViewDocuments();
            }}
            icon={<Eye className="w-4 h-4" />}
          >
            {t('action_view_docs')}
          </DropdownMenuItem>
          {onUploadToSource && (
            <DropdownMenuItem
              onSelect={() => {
                guardMenuAction();
                onUploadToSource();
              }}
              icon={<Upload className="w-4 h-4" />}
            >
              {t('action_upload')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              guardMenuAction();
              const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
              onDelete(syntheticEvent);
            }}
            variant="danger"
            icon={<Trash2 className="w-4 h-4" />}
          >
            {t('action_delete')}
          </DropdownMenuItem>
        </DropdownMenu>
      </div>

      <div className="text-xs text-muted">
        <span>
          {getDocumentCount().toLocaleString()} {t('col_docs').toLowerCase()}
        </span>
        {connectorId && source.sourceType === 'sharepoint' && (
          <span className="ml-2">{t('type_sharepoint')}</span>
        )}
      </div>
    </div>
  );
}
