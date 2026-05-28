/**
 * AttributeTierBadge
 *
 * Colored badge per attribute tier level.
 * permanent → green/success, approved → cyan/info, beta → purple,
 * novel → amber/warning, discarded → muted/default
 */

import { useTranslations } from 'next-intl';
import type { AttributeTier } from '../../../api/search-ai';
import { Badge, type BadgeVariant } from '../../ui/Badge';

interface AttributeTierBadgeProps {
  tier: AttributeTier;
  className?: string;
}

const TIER_VARIANT: Record<AttributeTier, BadgeVariant> = {
  permanent: 'success',
  approved: 'info',
  beta: 'purple',
  novel: 'warning',
  discarded: 'default',
};

const TIER_KEY: Record<AttributeTier, string> = {
  permanent: 'attr_tier_permanent',
  approved: 'attr_tier_approved',
  beta: 'attr_tier_beta',
  novel: 'attr_tier_novel',
  discarded: 'attr_tier_discarded',
};

export function AttributeTierBadge({ tier, className }: AttributeTierBadgeProps) {
  const t = useTranslations('search_ai.kg');
  return (
    <Badge variant={TIER_VARIANT[tier] ?? 'default'} className={className}>
      {t(TIER_KEY[tier] ?? tier)}
    </Badge>
  );
}
