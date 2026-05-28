'use client';

import { useEffect, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Search, FolderOpen } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import {
  useMarketplaceStore,
  selectUserProjects,
  selectUserProjectsLoading,
} from '@/store/marketplace-store';

interface AgentInstallProjectSelectorProps {
  open: boolean;
  onClose: () => void;
  onProjectSelected: (projectId: string, projectName: string) => void;
}

export function AgentInstallProjectSelector({
  open,
  onClose,
  onProjectSelected,
}: AgentInstallProjectSelectorProps) {
  const t = useTranslations('marketplace');
  const [searchQuery, setSearchQuery] = useState('');

  const projects = useMarketplaceStore(selectUserProjects);
  const loading = useMarketplaceStore(selectUserProjectsLoading);
  const fetchUserProjects = useMarketplaceStore((s) => s.fetchUserProjects);

  useEffect(() => {
    if (open) {
      fetchUserProjects();
    }
  }, [open, fetchUserProjects]);

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (p) => p.name.toLowerCase().includes(query) || p.slug.toLowerCase().includes(query),
    );
  }, [projects, searchQuery]);

  return (
    <Dialog open={open} onClose={onClose} title={t('install.selectProject')} maxWidth="md">
      <div className="space-y-4">
        <Input
          placeholder={t('install.searchProjects')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          icon={<Search className="w-4 h-4" />}
        />

        {loading && (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            <p className="text-xs text-muted">{t('install.loadingProjects')}</p>
          </div>
        )}

        {!loading && filteredProjects.length === 0 && (
          <div className="text-center py-8">
            <FolderOpen className="w-8 h-8 text-muted mx-auto mb-2" />
            <p className="text-sm text-muted">{t('install.noProjects')}</p>
          </div>
        )}

        {!loading && filteredProjects.length > 0 && (
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => onProjectSelected(project.id, project.name)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left hover:bg-background-muted transition-default group"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{project.name}</p>
                  <p className="text-xs text-muted">
                    {project.agentCount} {project.agentCount === 1 ? 'agent' : 'agents'}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  className="opacity-0 group-hover:opacity-100 transition-default"
                  tabIndex={-1}
                >
                  {t('install.confirm')}
                </Button>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('install.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
