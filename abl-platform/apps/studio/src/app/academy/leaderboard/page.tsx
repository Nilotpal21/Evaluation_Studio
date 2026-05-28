'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trophy } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { useAcademyStore, selectAcademyProgress } from '@/store/academy-store';
import { LeaderboardPodium } from '@/components/academy/LeaderboardPodium';
import { LeaderboardRow } from '@/components/academy/LeaderboardRow';
import type { LeaderboardEntry } from '@/components/academy/LeaderboardPodium';
import { EmptyState } from '@/components/ui/EmptyState';

const PAGE_SIZE = 20;

export default function LeaderboardPage() {
  const t = useTranslations('academy');
  const progress = useAcademyStore(selectAcademyProgress);

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const initialLoadRef = useRef(false);

  const fetchLeaderboard = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/academy/leaderboard?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = await res.json();
      const newEntries: LeaderboardEntry[] = data.data ?? [];

      if (offset === 0) {
        setEntries(newEntries);
      } else {
        setEntries((prev) => [...prev, ...newEntries]);
      }

      setHasMore(newEntries.length >= PAGE_SIZE);
      offsetRef.current = offset + newEntries.length;
    } catch (err: unknown) {
      // Network error — leave current entries intact, log for debugging.
      // eslint-disable-next-line no-console
      console.warn(
        '[academy-leaderboard] Failed to fetch:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    fetchLeaderboard(0);
  }, [fetchLeaderboard]);

  const handleLoadMore = () => {
    if (loading) return;
    fetchLeaderboard(offsetRef.current);
  };

  const currentUserId = progress?.userId ?? null;

  // Split entries: top 3 for podium, rest for rows
  const podiumEntries = entries.slice(0, 3);
  const rowEntries = entries.slice(3);

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-2">
        <Trophy className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold text-foreground">{t('leaderboard')}</h2>
      </div>

      {entries.length === 0 && !loading ? (
        <EmptyState icon={<Trophy className="h-6 w-6" />} title={t('leaderboard_empty')} />
      ) : (
        <>
          {/* Podium — top 3 */}
          <LeaderboardPodium entries={podiumEntries} />

          {/* Remaining entries as styled rows */}
          {rowEntries.length > 0 && (
            <div className="flex flex-col gap-2">
              {rowEntries.map((entry, index) => (
                <LeaderboardRow
                  key={entry.userId}
                  entry={entry}
                  rank={index + 4}
                  isCurrentUser={currentUserId === entry.userId}
                />
              ))}
            </div>
          )}
        </>
      )}

      {hasMore && entries.length > 0 && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loading}
            className="rounded-lg border border-border bg-background-elevated px-6 py-2.5 text-sm font-medium text-foreground transition-default btn-press focus-ring hover:bg-background-muted disabled:opacity-50"
          >
            {loading ? t('loading') : t('leaderboard_load_more')}
          </button>
        </div>
      )}
    </div>
  );
}
