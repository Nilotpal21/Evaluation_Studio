/**
 * ModuleDependencyList Component
 *
 * Lists imported module dependencies with alias, module name, pinned version,
 * config overrides, remove action with confirmation, and update-available
 * indicators that open the UpgradeModuleDialog.
 */

'use client';

import { useEffect, useCallback, useState } from 'react';
import { clsx } from 'clsx';
import { Package, Trash2, Loader2, Settings, Settings2, ArrowUpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { useModuleStore, type ModuleDependency } from '../../store/module-store';
import { EditModuleConfigDialog } from './EditModuleConfigDialog';
import { UpgradeModuleDialog } from './UpgradeModuleDialog';

interface ModuleDependencyListProps {
  projectId: string;
  className?: string;
}

interface UpgradeTarget {
  dependencyId: string;
  targetReleaseId: string;
  targetVersion: string;
  currentVersion: string;
}

export function ModuleDependencyList({ projectId, className }: ModuleDependencyListProps) {
  const t = useTranslations('modules.dependencies');

  const dependencies = useModuleStore((s) => s.dependencies);
  const dependenciesLoading = useModuleStore((s) => s.dependenciesLoading);
  const loadDependencies = useModuleStore((s) => s.loadDependencies);
  const removeDependency = useModuleStore((s) => s.removeDependency);

  const [removingId, setRemovingId] = useState<string | null>(null);
  const [upgradeTarget, setUpgradeTarget] = useState<UpgradeTarget | null>(null);
  const [editingDep, setEditingDep] = useState<ModuleDependency | null>(null);

  useEffect(() => {
    loadDependencies(projectId);
  }, [projectId, loadDependencies]);

  const handleRemove = useCallback(
    async (dependencyId: string, alias: string) => {
      if (!confirm(t('remove_confirm', { alias }))) {
        return;
      }

      setRemovingId(dependencyId);
      try {
        await removeDependency(projectId, dependencyId);
        toast.success(t('removed', { alias }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message);
      } finally {
        setRemovingId(null);
      }
    },
    [projectId, removeDependency, t],
  );

  const handleUpgradeComplete = useCallback(() => {
    setUpgradeTarget(null);
    loadDependencies(projectId);
  }, [projectId, loadDependencies]);

  if (dependenciesLoading) {
    return (
      <Card hoverable={false} className={clsx('flex items-center justify-center', className)}>
        <Loader2 className="w-5 h-5 animate-spin text-muted" />
      </Card>
    );
  }

  if (dependencies.length === 0) {
    return (
      <Card hoverable={false} className={clsx('text-center', className)} padding="lg">
        <Package className="w-8 h-8 text-muted mx-auto mb-2" />
        <p className="text-sm text-muted">{t('empty')}</p>
        <p className="text-xs text-muted mt-1">{t('empty_help')}</p>
      </Card>
    );
  }

  return (
    <>
      <Card hoverable={false} className={className}>
        <div className="flex items-center gap-2 mb-4">
          <Package className="w-4 h-4 text-foreground" />
          <h4 className="text-sm font-semibold">{t('title')}</h4>
          <Badge variant="default" className="ml-auto text-xs">
            {dependencies.length}
          </Badge>
        </div>

        <div className="space-y-2">
          {dependencies.map((dep) => {
            const overrideKeys = dep.configOverrides ? Object.keys(dep.configOverrides) : [];
            const update = dep.updateAvailable;

            return (
              <div
                key={dep.id}
                className="p-3 rounded-lg border border-default hover:bg-background-muted transition-default"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-sm font-medium font-mono truncate">{dep.alias}</p>
                      {dep.resolvedVersion && (
                        <Badge variant="accent" className="text-xs shrink-0">
                          v{dep.resolvedVersion}
                        </Badge>
                      )}
                    </div>

                    <p className="text-xs text-muted truncate">{dep.moduleProjectName}</p>

                    <div className="flex items-center gap-3 mt-1.5 text-xs text-muted">
                      <Badge variant="default" className="text-xs">
                        {dep.selector?.type === 'version'
                          ? t('selector_pin', { value: dep.selector.value })
                          : dep.selector?.type === 'environment'
                            ? t('selector_env', { value: dep.selector.value })
                            : dep.resolvedVersion
                              ? `v${dep.resolvedVersion}`
                              : t('selector_pin', { value: '?' })}
                      </Badge>

                      {overrideKeys.length > 0 && (
                        <div className="flex items-center gap-1" title={overrideKeys.join(', ')}>
                          <Settings2 className="w-3 h-3" />
                          <span>{t('config_overrides', { count: overrideKeys.length })}</span>
                        </div>
                      )}
                    </div>

                    {/* Update available badge */}
                    {update && (
                      <button
                        type="button"
                        onClick={() =>
                          setUpgradeTarget({
                            dependencyId: dep.id,
                            targetReleaseId: update.latestReleaseId,
                            targetVersion: update.latestVersion,
                            currentVersion: dep.resolvedVersion,
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium bg-accent-subtle text-accent hover:bg-accent/20 transition-default"
                      >
                        <ArrowUpCircle className="w-3 h-3" />
                        {t('updateAvailable', { version: update.latestVersion })}
                      </button>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditingDep(dep)}
                      className="p-2 rounded-md hover:bg-background-muted transition-default"
                      title={t('edit_config')}
                    >
                      <Settings className="w-4 h-4 text-muted hover:text-foreground" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(dep.id, dep.alias)}
                      disabled={removingId === dep.id}
                      className="p-2 rounded-md hover:bg-error/10 transition-default disabled:opacity-50"
                      title={t('remove')}
                    >
                      {removingId === dep.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-error" />
                      ) : (
                        <Trash2 className="w-4 h-4 text-muted hover:text-error" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Edit config dialog */}
      {editingDep && (
        <EditModuleConfigDialog
          open={!!editingDep}
          onClose={() => setEditingDep(null)}
          dependency={editingDep}
          onSave={async (configOverrides) => {
            // Re-use the PATCH dependency endpoint with the current release to update config only
            const { upgradeDependency } = await import('../../api/modules');
            await upgradeDependency(projectId, editingDep.id, {
              targetReleaseId: editingDep.resolvedReleaseId,
              configOverrides,
            });
            await loadDependencies(projectId);
          }}
        />
      )}

      {/* Upgrade dialog */}
      {upgradeTarget && (
        <UpgradeModuleDialog
          open={true}
          onClose={() => setUpgradeTarget(null)}
          projectId={projectId}
          dependencyId={upgradeTarget.dependencyId}
          targetReleaseId={upgradeTarget.targetReleaseId}
          targetVersion={upgradeTarget.targetVersion}
          currentVersion={upgradeTarget.currentVersion}
          onUpgradeComplete={handleUpgradeComplete}
        />
      )}
    </>
  );
}
