/**
 * CrawlPreferences Component
 *
 * Displays and manages the user's saved crawl preferences.
 * Shows domain patterns, strategies, and usage statistics.
 */

import useSWRMutation from 'swr/mutation';
import { mutate } from 'swr';
import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bookmark, Trash2, Pencil } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Alert } from '@/components/ui/Alert';
import { useCrawlPreferences } from '@/hooks/useCrawlPreferences';
import { deleteCrawlPreference } from '@/api/crawl';
import type { UserCrawlPreference } from '@/api/crawl';

const STRATEGY_BADGE_VARIANT: Record<string, 'info' | 'success' | 'accent'> = {
  browser: 'info',
  bulk: 'success',
  hybrid: 'accent',
};

function PreferenceRow({
  pref,
  onEdit,
  t,
}: {
  pref: UserCrawlPreference;
  onEdit?: (pref: UserCrawlPreference) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const strategyLabels = useMemo(
    () => ({
      hybrid: t('strategy_hybrid'),
      bulk: t('strategy_bulk'),
      browser: t('strategy_browser'),
    }),
    [t],
  );

  const { trigger: triggerDelete, isMutating } = useSWRMutation(
    `delete-crawl-preference-${pref._id}`,
    async () => deleteCrawlPreference(pref._id),
    {
      onSuccess: () => {
        mutate('crawl-preferences');
      },
    },
  );

  return (
    <Card padding="md" hoverable={false} className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{pref.domainPattern}</p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <Badge variant={STRATEGY_BADGE_VARIANT[pref.strategy] ?? 'default'}>
            {strategyLabels[pref.strategy as keyof typeof strategyLabels] ?? pref.strategy}
          </Badge>
          {pref.autoDecide && (
            <Badge variant="success" dot>
              {t('auto_decide')}
            </Badge>
          )}
          <span className="text-xs text-muted">{t('used_count', { count: pref.useCount })}</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onEdit && (
          <Button
            variant="ghost"
            size="xs"
            icon={<Pencil className="w-3.5 h-3.5" />}
            onClick={() => onEdit(pref)}
            aria-label={t('edit_preference_aria', { domain: pref.domainPattern })}
          />
        )}
        <Button
          variant="ghost"
          size="xs"
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onClick={() => triggerDelete()}
          loading={isMutating}
          aria-label={t('delete_preference_aria', { domain: pref.domainPattern })}
        />
      </div>
    </Card>
  );
}

export function CrawlPreferences() {
  const t = useTranslations('search_ai.crawl_prefs');
  const { preferences, isLoading } = useCrawlPreferences(null);
  const [editingPref, setEditingPref] = useState<UserCrawlPreference | null>(null);

  if (isLoading) {
    return <div className="text-center py-8 text-sm text-muted">{t('loading')}</div>;
  }

  if (preferences.length === 0) {
    return (
      <EmptyState
        icon={<Bookmark className="w-6 h-6" />}
        title={t('empty_title')}
        description={t('empty_description')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Alert variant="info">{t('info_message')}</Alert>

      <div className="space-y-2">
        {preferences.map((pref) => (
          <PreferenceRow key={pref._id} pref={pref} onEdit={setEditingPref} t={t} />
        ))}
      </div>

      {/* Edit preference: delete old + create new with same pattern */}
      {editingPref && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
          <Card padding="lg" className="w-full max-w-md">
            <h3 className="text-base font-semibold text-foreground mb-4">{t('edit_title')}</h3>
            <p className="text-sm text-muted mb-4">
              {t('edit_description', { domain: editingPref.domainPattern })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditingPref(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={async () => {
                  await deleteCrawlPreference(editingPref._id);
                  mutate('crawl-preferences');
                  setEditingPref(null);
                  // User can now create a new preference from the form
                }}
              >
                {t('delete_and_recreate')}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
