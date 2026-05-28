/**
 * BrowseDocumentCard
 *
 * Individual document card for the Browse SDK preview.
 * Shows title, summary, source, attribute badges (with tier coloring), and timestamp.
 */

'use client';

import { ExternalLink, FileText } from 'lucide-react';
import type { AttributeTier } from '../../../api/search-ai';
import { Badge, type BadgeVariant } from '../../ui/Badge';

export interface DocumentAttribute {
  key: string;
  value: string;
  tier: AttributeTier;
}

export interface BrowseDocument {
  id: string;
  title: string;
  summary: string;
  source: string;
  attributes: DocumentAttribute[];
  updatedAt: string;
  sourceUrl?: string;
}

interface BrowseDocumentCardProps {
  document: BrowseDocument;
  includeBeta: boolean;
  onClick?: () => void;
}

const TIER_VARIANT: Record<AttributeTier, BadgeVariant> = {
  permanent: 'success',
  approved: 'info',
  beta: 'purple',
  novel: 'warning',
  discarded: 'default',
};

export function BrowseDocumentCard({ document, includeBeta, onClick }: BrowseDocumentCardProps) {
  const visibleAttributes = includeBeta
    ? document.attributes.filter((a) => a.tier !== 'discarded')
    : document.attributes.filter((a) => a.tier !== 'discarded' && a.tier !== 'beta');

  return (
    <div
      className="rounded-xl border border-default bg-background-elevated p-4 hover:border-accent/40 transition-default cursor-pointer"
      onClick={onClick}
      role="article"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-muted shrink-0" />
          <h3 className="text-sm font-medium text-foreground truncate">{document.title}</h3>
        </div>
        {document.sourceUrl && (
          <a
            href={document.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-muted hover:text-foreground transition-default shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>

      <p className="text-xs text-muted line-clamp-2 mb-3">{document.summary}</p>

      {visibleAttributes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {visibleAttributes.slice(0, 6).map((attr) => (
            <Badge key={`${attr.key}-${attr.value}`} variant={TIER_VARIANT[attr.tier] ?? 'default'}>
              {attr.key}: {attr.value}
            </Badge>
          ))}
          {visibleAttributes.length > 6 && (
            <Badge variant="default">+{visibleAttributes.length - 6}</Badge>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-subtle">
        <span>{document.source}</span>
        <span>{new Date(document.updatedAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
