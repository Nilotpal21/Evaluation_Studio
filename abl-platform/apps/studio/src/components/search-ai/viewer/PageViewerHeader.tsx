'use client';

import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface PageViewerHeaderProps {
  title: string;
  url: string;
  status: string;
  qualityScore: number | null;
  crawledAt: string;
  onClose: () => void;
}

export function PageViewerHeader({
  title,
  url,
  status,
  qualityScore,
  crawledAt,
  onClose,
}: PageViewerHeaderProps) {
  const t = useTranslations('search_ai.viewer');
  return (
    <div className="flex items-center gap-4 px-5 py-3 border-b border-default shrink-0">
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-medium text-foreground truncate">{title}</h2>
        <p className="text-xs text-muted truncate">{url}</p>
      </div>

      <span className="text-xs px-2 py-0.5 rounded-full bg-surface-elevated text-muted capitalize">
        {status}
      </span>

      {qualityScore !== null && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-elevated text-muted">
          {t('quality_score', { score: Math.round(qualityScore * 100) })}
        </span>
      )}

      <span className="text-xs text-muted">{new Date(crawledAt).toLocaleDateString()}</span>

      <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('close_viewer')}>
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}
