'use client';

import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { FrameworkChecklist } from './FrameworkChecklist';
import type { FrameworksData, FrameworkItem } from '../../lib/governance-contracts';

interface FrameworksTabProps {
  frameworks: FrameworksData | null;
  isLoading: boolean;
}

export function FrameworksTab({ frameworks, isLoading }: FrameworksTabProps) {
  const t = useTranslations('governance');

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!frameworks || frameworks.frameworks.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck className="h-6 w-6" />}
        title={t('frameworks.empty_title')}
        description={t('frameworks.empty_description')}
      />
    );
  }

  return (
    <div className="space-y-3">
      {frameworks.frameworks.map((fw: FrameworkItem) => (
        <FrameworkChecklist key={fw.id} framework={fw} />
      ))}
    </div>
  );
}
