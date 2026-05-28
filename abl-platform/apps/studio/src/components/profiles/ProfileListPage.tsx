/**
 * ProfileListPage Component
 *
 * Grid of behavior profile cards with search, loading, and empty states.
 * Entry point for the /projects/:id/profiles route.
 */

import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Layers, Plus, Search } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useProfileStore } from '../../store/profile-store';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProfileCard } from './ProfileCard';
import { listBehaviorProfiles } from '../../api/behavior-profiles';
import { NEW_BEHAVIOR_PROFILE_ROUTE_SEGMENT } from './constants';

// =============================================================================
// SKELETON
// =============================================================================

function ProfileCardSkeleton() {
  return (
    <div className="p-4 rounded-xl border border-default bg-background-muted animate-pulse">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="h-5 w-32 bg-background-elevated rounded" />
        <div className="h-5 w-10 bg-background-elevated rounded-full" />
      </div>
      <div className="h-4 w-full bg-background-elevated rounded mb-2" />
      <div className="h-4 w-2/3 bg-background-elevated rounded mb-3" />
      <div className="flex gap-1.5 mb-3">
        <div className="h-4 w-16 bg-background-elevated rounded-full" />
        <div className="h-4 w-14 bg-background-elevated rounded-full" />
      </div>
      <div className="flex justify-between pt-2 border-t border-default/50">
        <div className="h-3 w-20 bg-background-elevated rounded" />
        <div className="h-3 w-16 bg-background-elevated rounded" />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ProfileListPage() {
  const { projectId, navigate } = useNavigationStore();
  const profiles = useProfileStore((state) => state.profiles);
  const loading = useProfileStore((state) => state.loading);
  const error = useProfileStore((state) => state.error);
  const setProfiles = useProfileStore((state) => state.setProfiles);
  const setLoading = useProfileStore((state) => state.setLoading);
  const setError = useProfileStore((state) => state.setError);
  const [searchQuery, setSearchQuery] = useState('');

  const loadProfiles = useCallback(async () => {
    if (!projectId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nextProfiles = await listBehaviorProfiles(projectId);
      setProfiles(nextProfiles);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load behavior profiles');
    } finally {
      setLoading(false);
    }
  }, [projectId, setError, setLoading, setProfiles]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const filtered = profiles
    .filter((p) => {
      const q = searchQuery.toLowerCase();
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.whenExpression.toLowerCase().includes(q) ||
        p.overrideCategories.some((cat) => cat.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => a.priority - b.priority);

  const handleOpenProfile = (name: string) => {
    navigate(`/projects/${projectId}/profiles/${encodeURIComponent(name)}`);
  };

  const handleNewProfile = () => {
    navigate(`/projects/${projectId}/profiles/${NEW_BEHAVIOR_PROFILE_ROUTE_SEGMENT}`);
  };

  const isEmptyStateShown = !loading && !error && filtered.length === 0;

  return (
    <ListPageShell
      title="Behavior Profiles"
      description={`${profiles.length} profile${profiles.length !== 1 ? 's' : ''} defined`}
      hidePrimaryAction={isEmptyStateShown}
      primaryAction={
        <Button
          variant="primary"
          size="md"
          icon={<Plus className="w-4 h-4" />}
          onClick={handleNewProfile}
        >
          New Profile
        </Button>
      }
      searchPlaceholder="Search profiles..."
      searchValue={searchQuery}
      onSearchChange={setSearchQuery}
    >
      {loading ? (
        <div className={clsx('grid gap-4', 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
          {Array.from({ length: 6 }).map((_, i) => (
            <ProfileCardSkeleton key={i} />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={<Layers className="w-6 h-6" />}
          title="Failed to load profiles"
          description={error}
        />
      ) : filtered.length === 0 ? (
        searchQuery ? (
          <EmptyState
            icon={<Search className="w-6 h-6" />}
            title="No matching profiles"
            description={`No profiles match "${searchQuery}"`}
          />
        ) : (
          <EmptyState
            icon={<Layers className="w-6 h-6" />}
            title="No behavior profiles yet"
            description="Behavior profiles let you change how an agent talks, listens, and reasons in specific contexts — for example, switching tone on voice calls or shortening answers for SMS."
            action={
              <Button
                variant="primary"
                icon={<Plus className="w-4 h-4" />}
                onClick={handleNewProfile}
              >
                Create Profile
              </Button>
            }
          />
        )
      ) : (
        <div className={clsx('grid gap-4', 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
          {filtered.map((profile) => (
            <ProfileCard
              key={profile.name}
              profile={profile}
              onClick={() => handleOpenProfile(profile.name)}
            />
          ))}
        </div>
      )}
    </ListPageShell>
  );
}
