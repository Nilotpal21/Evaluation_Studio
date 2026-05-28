/**
 * Project Switcher Component
 *
 * Dropdown to select and manage projects.
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, Folder, Settings, Check, Loader2, Rocket } from 'lucide-react';
import { useProjectStore } from '../../store/project-store';
import { useAuthStore } from '../../store/auth-store';
import { createAndAddProject } from '../../api/projects';

export function ProjectSwitcher() {
  const t = useTranslations('projects.switcher');
  const projects = useProjectStore((s) => s.projects);
  const currentProject = useProjectStore((s) => s.currentProject);
  const setCurrentProjectId = useProjectStore((s) => s.setCurrentProjectId);
  const isLoading = useProjectStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [isOpen, setIsOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Projects are loaded once by AppShell on mount; no need to load here

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setShowCreate(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!isAuthenticated) {
    return null;
  }

  const handleSelectProject = (projectId: string) => {
    setCurrentProjectId(projectId);
    setIsOpen(false);
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;

    setIsCreating(true);
    try {
      const project = await createAndAddProject({ name: newProjectName.trim() });
      setCurrentProjectId(project.id);
      setNewProjectName('');
      setShowCreate(false);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to create project:', error);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-background-muted transition-colors text-sm"
      >
        <Folder className="w-4 h-4 text-muted" />
        <span className="text-foreground max-w-[150px] truncate">
          {currentProject?.name || t('select_project')}
        </span>
        {isLoading ? (
          <Loader2 className="w-3 h-3 text-muted animate-spin" />
        ) : (
          <ChevronDown className="w-3 h-3 text-muted" />
        )}
      </button>

      {isOpen && (
        <div className="absolute left-0 mt-2 w-64 bg-background-subtle border border-default rounded-lg shadow-lg py-1 z-50">
          {/* Project list */}
          <div className="max-h-64 overflow-y-auto">
            {projects.length === 0 && !isLoading && (
              <p className="px-4 py-3 text-sm text-subtle">{t('no_projects')}</p>
            )}

            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => handleSelectProject(project.id)}
                className="flex items-center justify-between w-full px-4 py-2 text-sm text-muted hover:bg-background-muted"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Folder className="w-4 h-4 text-subtle flex-shrink-0" />
                  <span className="truncate">{project.name}</span>
                </div>
                {currentProject?.id === project.id && (
                  <Check className="w-4 h-4 text-accent flex-shrink-0" />
                )}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="border-t border-default py-1">
            {showCreate ? (
              <div className="px-3 py-2">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder={t('project_name_placeholder')}
                  className="w-full px-3 py-1.5 bg-background-elevated border border-default rounded-lg text-sm text-foreground placeholder:text-subtle focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateProject();
                    if (e.key === 'Escape') {
                      setShowCreate(false);
                      setNewProjectName('');
                    }
                  }}
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    onClick={() => {
                      setShowCreate(false);
                      setNewProjectName('');
                    }}
                    className="px-2 py-1 text-xs text-muted hover:text-foreground"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    onClick={handleCreateProject}
                    disabled={!newProjectName.trim() || isCreating}
                    className="px-2 py-1 text-xs bg-accent text-accent-foreground rounded hover:bg-accent/90 disabled:opacity-50"
                  >
                    {isCreating ? t('creating') : t('create')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted hover:bg-background-muted"
                >
                  <Plus className="w-4 h-4" />
                  {t('new_project')}
                </button>
                {currentProject && (
                  <>
                    <a
                      href={`/deploy?projectId=${currentProject.id}`}
                      onClick={() => setIsOpen(false)}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted hover:bg-background-muted"
                    >
                      <Rocket className="w-4 h-4" />
                      {t('deploy')}
                    </a>
                    <button
                      onClick={() => {
                        // Could open project settings modal
                        setIsOpen(false);
                      }}
                      className="flex items-center gap-2 w-full px-4 py-2 text-sm text-muted hover:bg-background-muted"
                    >
                      <Settings className="w-4 h-4" />
                      {t('project_settings')}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
