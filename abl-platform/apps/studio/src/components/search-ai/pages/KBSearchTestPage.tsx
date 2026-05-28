'use client';

/**
 * KBSearchTestPage
 *
 * Standalone search & test page using DetailPageShell with maxWidth="xl".
 * Wraps the existing SearchTestSection component which handles its own
 * loading, error, and empty states internally.
 */

import { useTranslations } from 'next-intl';
import { DetailPageShell } from '../../ui/DetailPageShell';
import { useKBDetail } from '../context/KBDetailContext';
import { SearchTestSection } from '../search/SearchTestSection';

export function KBSearchTestPage() {
  const t = useTranslations('search_ai.kb_pages');
  const { knowledgeBase } = useKBDetail();

  const indexId = knowledgeBase.searchIndexId ?? '';

  return (
    <DetailPageShell title={t('search_test_title')} maxWidth="xl">
      <SearchTestSection indexId={indexId} knowledgeBaseId={knowledgeBase._id} />
    </DetailPageShell>
  );
}
