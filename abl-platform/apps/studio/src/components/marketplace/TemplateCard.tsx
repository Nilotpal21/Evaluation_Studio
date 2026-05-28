'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Download, Star } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { TemplateTypeBadge } from './TemplateTypeBadge';
import type { MarketplaceTemplate } from '@/store/marketplace-store';

interface TemplateCardProps {
  template: MarketplaceTemplate;
}

function formatCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

export function TemplateCard({ template }: TemplateCardProps) {
  const t = useTranslations('marketplace');
  const router = useRouter();

  return (
    <Card
      onClick={() => router.push(`/marketplace/templates/${template.slug}`)}
      padding="md"
      hoverable
      className="animate-fade-in-up"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="w-10 h-10 rounded-xl bg-background-muted flex items-center justify-center flex-shrink-0">
          <span className="text-lg">{template.iconUrl ? '' : template.name.charAt(0)}</span>
        </div>
        <TemplateTypeBadge type={template.type} size="sm" />
      </div>

      <h3 className="text-sm font-medium text-foreground truncate mt-3">{template.name}</h3>
      <p className="text-xs text-muted line-clamp-2 mt-1">{template.shortDescription}</p>

      <div className="flex items-center gap-3 mt-3 text-xs text-subtle">
        <Badge variant="default" className="text-xs">
          {t(`categories.${template.category}` as any) ?? template.category}
        </Badge>
        {template.ratingAverage > 0 && (
          <span className="flex items-center gap-1">
            <Star className="w-3 h-3 text-warning fill-warning" />
            <span>{template.ratingAverage.toFixed(1)}</span>
          </span>
        )}
        <span className="flex items-center gap-1">
          <Download className="w-3 h-3" />
          <span>{formatCount(template.installCount)}</span>
        </span>
      </div>
    </Card>
  );
}
