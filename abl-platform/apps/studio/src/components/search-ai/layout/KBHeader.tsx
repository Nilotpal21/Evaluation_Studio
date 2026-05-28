/**
 * KBHeader Component
 *
 * Persistent header for knowledge base detail page.
 * Shows back navigation, KB name, inline metrics, status badge, and settings button.
 */

import { useTranslations } from 'next-intl';
import { ArrowLeft, Eye, ExternalLink, Settings } from 'lucide-react';
import type { KnowledgeBaseDetail } from '../../../api/search-ai';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { useDataTabFilterStore } from '../../../store/data-tab-filter-store';

interface KBHeaderProps {
  knowledgeBase: KnowledgeBaseDetail;
  onBack: () => void;
  onOpenSettings: () => void;
  onNavigate?: (tab: string, subSection?: string) => void;
}

const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  ready: 'success',
  creating: 'info',
  indexing: 'info',
  rebuilding: 'warning',
  error: 'error',
};

export function KBHeader({ knowledgeBase, onBack, onOpenSettings, onNavigate }: KBHeaderProps) {
  const t = useTranslations('search_ai.header');
  const index = knowledgeBase.index;
  const setPendingFilter = useDataTabFilterStore((s) => s.setPendingFilter);

  const statusLabels: Record<string, string> = {
    creating: t('status_creating'),
    active: t('status_active'),
    ready: t('status_ready'),
    indexing: t('status_indexing'),
    rebuilding: t('status_rebuilding'),
    error: t('status_error'),
  };

  const metrics = [
    {
      label: t('label_sources'),
      value: index?.sourceCount ?? knowledgeBase.connectorCount ?? 0,
      onClick: () => {
        setPendingFilter({ view: 'sources' });
        onNavigate?.('data');
      },
      ariaLabel: t('aria_go_to_sources'),
    },
    {
      label: t('label_documents'),
      value: index?.documentCount ?? knowledgeBase.documentCount ?? 0,
      onClick: () => {
        setPendingFilter({ view: 'documents' });
        onNavigate?.('data');
      },
      ariaLabel: t('aria_go_to_documents'),
    },
    {
      label: t('label_chunks'),
      value: index?.chunkCount ?? 0,
      onClick: () => {
        setPendingFilter({ view: 'chunks' });
        onNavigate?.('data');
      },
      ariaLabel: t('aria_go_to_chunks'),
    },
  ];

  const lastIndexed = index?.lastIndexedAt ?? knowledgeBase.lastIndexedAt;

  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-default bg-background">
      <button
        onClick={onBack}
        className="p-1.5 rounded-md hover:bg-background-muted transition-default text-muted hover:text-foreground"
        aria-label={t('aria_back')}
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      <h1 className="text-lg font-semibold text-foreground truncate">{knowledgeBase.name}</h1>

      <div className="flex items-center gap-3 ml-4 text-xs text-muted">
        {metrics.map((m) => (
          <button
            key={m.label}
            onClick={m.onClick}
            className="flex items-center gap-1 text-muted hover:text-foreground hover:underline cursor-pointer transition-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded"
            aria-label={m.ariaLabel}
          >
            <span className="font-medium text-foreground">{m.value.toLocaleString()}</span>
            {m.label}
          </button>
        ))}
        {lastIndexed && (
          <span className="flex items-center gap-1">
            {t('last_indexed')}{' '}
            <span className="font-medium text-foreground">
              {new Date(lastIndexed).toLocaleString()}
            </span>
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Badge variant={statusVariant[knowledgeBase.status] ?? 'default'} dot>
          {statusLabels[knowledgeBase.status] ?? knowledgeBase.status}
        </Badge>

        <a
          href={`/projects/${knowledgeBase.projectId}/search-ai/${knowledgeBase._id}/browse-preview`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-background-muted border border-default hover:bg-background-elevated transition-default"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>{t('preview_sdk')}</span>
          <ExternalLink className="w-3 h-3 opacity-60" />
        </a>

        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded-md hover:bg-background-muted transition-default text-muted hover:text-foreground"
          aria-label={t('aria_settings')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
