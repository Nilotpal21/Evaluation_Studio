/**
 * PinnedProjectsRow Component
 *
 * Compact horizontal row of pinned projects shown on the home page.
 * Returns null if no pinned projects exist.
 *
 * Each card shows a color-accented left border, project name, and agent count.
 * Hover reveals an unpin button at top-right.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { Folder, Pin, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore, type Project } from '../../store/project-store';
import { usePreferencesStore } from '../../store/preferences-store';
import { useNavigationStore } from '../../store/navigation-store';
import { fetchProject } from '../../api/projects';
import { STAGGER_DELAY } from '../../lib/animation';
import { getProjectColor } from '../../lib/project-colors';
import { sanitizeError } from '../../lib/sanitize-error';

export function PinnedProjectsRow() {
  const t = useTranslations('projects');
  const projects = useProjectStore((s) => s.projects);
  const pinnedProjectIds = usePreferencesStore((s) => s.pinnedProjectIds);
  const unpinProject = usePreferencesStore((s) => s.unpinProject);
  const navigate = useNavigationStore((s) => s.navigate);
  const [checkingProjectId, setCheckingProjectId] = useState<string | null>(null);

  const handleSelectProject = async (project: Project) => {
    if (checkingProjectId) return;
    setCheckingProjectId(project.id);
    try {
      await fetchProject(project.id);
      navigate(`/projects/${project.id}`);
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 403 || status === 404) {
        toast.error("You don't have access to this project. Contact a workspace admin.");
        useProjectStore.getState().removeProject(project.id);
      } else {
        toast.error(sanitizeError(error, "Couldn't open this project. Please try again."));
      }
    } finally {
      setCheckingProjectId(null);
    }
  };

  // Resolve pinned IDs to actual projects, filtering out stale pins (deleted projects)
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const pinnedProjects: Project[] = pinnedProjectIds
    .map((id) => projectMap.get(id))
    .filter((p): p is Project => p !== undefined);

  // Return null if no pinned projects
  if (pinnedProjects.length === 0) return null;

  return (
    <section className="mb-6">
      {/* Section heading */}
      <h3 className="text-xs text-muted uppercase tracking-wider font-medium mb-2.5">
        {t('pinned_count', { count: pinnedProjects.length })}
      </h3>

      {/* Horizontal scrollable row */}
      <div className="flex overflow-x-auto gap-3 pb-2">
        {pinnedProjects.map((project, index) => {
          const color = getProjectColor(project.id);
          const isChecking = checkingProjectId === project.id;

          return (
            <motion.div
              key={project.id}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * STAGGER_DELAY }}
              onClick={() => void handleSelectProject(project)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') void handleSelectProject(project);
              }}
              className={`relative group min-w-[200px] max-w-[260px] shrink-0 flex items-center gap-3 px-4 py-3.5 rounded-xl bg-background-elevated border border-border-muted border-l-2 ${color.border} hover:border-accent/30 transition-colors text-left ${isChecking ? 'opacity-70 cursor-wait pointer-events-none' : 'cursor-pointer'}`}
            >
              {/* Folder icon with project color */}
              <div className={`shrink-0 ${color.text}`}>
                <Folder className="w-4 h-4" />
              </div>

              {/* Project info */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">{project.name}</div>
                <div className="flex items-center gap-1 text-xs text-subtle mt-0.5">
                  <Bot className="w-3 h-3" />
                  <span>{project.agentCount}</span>
                </div>
              </div>

              {/* Unpin button — visible on hover */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  unpinProject(project.id);
                }}
                className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-background-muted transition-opacity"
                aria-label={t('unpin_project')}
              >
                <Pin className="w-3 h-3 text-muted fill-current" />
              </button>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
