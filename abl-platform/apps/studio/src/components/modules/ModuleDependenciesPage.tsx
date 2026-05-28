/**
 * ModuleDependenciesPage Component
 *
 * Reachable resource page for importing and managing reusable module
 * dependencies in consumer projects.
 */

'use client';

import { useTranslations } from 'next-intl';
import { Package, Plus } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { useModuleStore } from '../../store/module-store';
import { ListPageShell } from '../ui/ListPageShell';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { ModuleDependencyList } from './ModuleDependencyList';
import { ImportModuleDialog } from './ImportModuleDialog';

export function ModuleDependenciesPage() {
  const tDependencies = useTranslations('modules.dependencies');
  const tImport = useTranslations('modules.import');
  const { projectId } = useNavigationStore();

  const importDialogOpen = useModuleStore((s) => s.importDialogOpen);
  const setImportDialogOpen = useModuleStore((s) => s.setImportDialogOpen);
  const loadDependencies = useModuleStore((s) => s.loadDependencies);

  if (!projectId) {
    return (
      <ListPageShell title={tDependencies('title')}>
        <EmptyState
          icon={<Package className="w-6 h-6" />}
          title={tDependencies('title')}
          description={tDependencies('empty_help')}
        />
      </ListPageShell>
    );
  }

  return (
    <>
      <ListPageShell
        title={tDependencies('title')}
        description={tDependencies('empty_help')}
        primaryAction={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setImportDialogOpen(true)}>
            {tImport('title', { defaultValue: 'Import Module' })}
          </Button>
        }
      >
        <ModuleDependencyList projectId={projectId} />
      </ListPageShell>

      <ImportModuleDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
        projectId={projectId}
        onImported={() => void loadDependencies(projectId)}
      />
    </>
  );
}
