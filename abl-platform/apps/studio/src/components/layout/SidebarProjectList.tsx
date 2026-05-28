'use client';

import { useProjectStore } from '@/store/project-store';
import { useNavigationStore } from '@/store/navigation-store';
import { clsx } from 'clsx';

export function SidebarProjectList() {
  const { projects, currentProjectId } = useProjectStore();
  const { navigate } = useNavigationStore();

  if (projects.length === 0) {
    return <div className="px-3 py-4 text-xs text-muted-foreground">No projects yet</div>;
  }

  return (
    <div className="flex flex-col gap-0.5 px-2">
      {projects.map((project) => {
        const isActive = project.id === currentProjectId;
        return (
          <button
            key={project.id}
            onClick={() => navigate(`/projects/${project.id}`)}
            className={clsx(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              isActive
                ? 'bg-accent/15 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
            )}
          >
            <span className="truncate">{project.name}</span>
          </button>
        );
      })}
    </div>
  );
}
