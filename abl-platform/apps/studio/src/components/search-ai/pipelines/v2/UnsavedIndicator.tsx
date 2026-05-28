/**
 * UnsavedIndicator — Shows when there are unsaved pipeline changes.
 *
 * Displays a warning dot + label when the pipeline has been modified.
 */

'use client';

import { useTranslations } from 'next-intl';
import type { SaveStatus } from '../../../../store/pipeline-store';

export interface UnsavedIndicatorProps {
  isDirty: boolean;
  saveStatus: SaveStatus;
}

export function UnsavedIndicator({ isDirty, saveStatus }: UnsavedIndicatorProps) {
  const t = useTranslations('search_ai.pipeline');

  if (!isDirty && saveStatus !== 'saving') return null;

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-warning">
      <span className="w-2 h-2 rounded-full bg-warning shrink-0" />
      <span>{t('v2_unsaved_changes')}</span>
    </div>
  );
}
