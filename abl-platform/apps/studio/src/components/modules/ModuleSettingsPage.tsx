/**
 * ModuleSettingsPage Component
 *
 * Reachable settings page for reusable-module authoring. Composes the existing
 * settings panel, publish trigger, dialog, and release archive list.
 */

'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Package, Plus } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useModuleStore } from '../../store/module-store';
import { ListPageShell } from '../ui/ListPageShell';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { ModuleSettingsPanel } from './ModuleSettingsPanel';
import { PublishModuleDialog } from './PublishModuleDialog';
import { ArchiveReleaseButton } from './ArchiveReleaseButton';

export function ModuleSettingsPage() {
  const tSettings = useTranslations('modules.settings');
  const tPublish = useTranslations('modules.publish');
  const { projectId } = useNavigationStore();

  const releases = useModuleStore((s) => s.releases);
  const releasesLoading = useModuleStore((s) => s.releasesLoading);
  const setPublishDialogOpen = useModuleStore((s) => s.setPublishDialogOpen);
  const loadReleases = useModuleStore((s) => s.loadReleases);

  useEffect(() => {
    if (projectId) {
      void loadReleases(projectId);
    }
  }, [projectId, loadReleases]);

  if (!projectId) {
    return (
      <ListPageShell title={tSettings('title')}>
        <EmptyState
          icon={<Package className="w-6 h-6" />}
          title={tSettings('title')}
          description={tSettings('noProject')}
        />
      </ListPageShell>
    );
  }

  return (
    <>
      <ListPageShell
        title={tSettings('title')}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setPublishDialogOpen(true)}>
            {tPublish('submit', { defaultValue: 'Publish Release' })}
          </Button>
        }
      >
        <div className="space-y-6">
          <ModuleSettingsPanel />

          <Card hoverable={false}>
            <div className="flex items-center gap-2 mb-4">
              <Package className="w-4 h-4 text-foreground" />
              <h4 className="text-sm font-semibold text-foreground">
                {tPublish('published_releases')}
              </h4>
              <Badge variant="default" className="ml-auto text-xs">
                {releases.length}
              </Badge>
            </div>

            {releasesLoading ? (
              <div className="flex items-center justify-center py-6 text-muted">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : releases.length === 0 ? (
              <EmptyState
                className="py-10"
                icon={<Package className="w-5 h-5" />}
                title={tPublish('published_releases')}
                description={tPublish('no_releases')}
                action={
                  <Button
                    icon={<Plus className="w-4 h-4" />}
                    onClick={() => setPublishDialogOpen(true)}
                  >
                    {tPublish('submit', { defaultValue: 'Publish Release' })}
                  </Button>
                }
              />
            ) : (
              <div className="space-y-2">
                {releases.map((release) => (
                  <div
                    key={release.id}
                    className="flex items-start justify-between gap-4 rounded-lg border border-default p-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium font-mono text-foreground">
                          {release.version}
                        </p>
                        <Badge variant="accent" className="text-xs">
                          {tPublish('published')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted whitespace-pre-wrap">
                        {release.releaseNotes ?? tPublish('no_release_notes')}
                      </p>
                    </div>

                    <ArchiveReleaseButton
                      projectId={projectId}
                      releaseId={release.id}
                      version={release.version}
                      onArchived={() => void loadReleases(projectId)}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </ListPageShell>

      <PublishModuleDialog projectId={projectId} />
    </>
  );
}
