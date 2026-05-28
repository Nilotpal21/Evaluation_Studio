/**
 * Project Dashboard Component
 *
 * Landing page after login. Shows a grid of project cards.
 * Clicking a project navigates to /projects/:id (agent list with sidebar).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Folder, Plus, Loader2, Bot, Clock, X, Pin, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore, type Project } from '../../store/project-store';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore } from '../../store/navigation-store';
import { createAndAddProject, fetchProject, loadProjects } from '../../api/projects';
import { usePreferencesStore } from '../../store/preferences-store';
import { PageHeader } from '../ui/PageHeader';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { NewProjectDropdown } from '../creation/NewProjectDropdown';
import { ArchBar } from './ArchBar';
import { PinnedProjectsRow } from './PinnedProjectsRow';
import { getProjectColor } from '../../lib/project-colors';
import { GrainOverlay } from '../ui/GrainOverlay';
import { sanitizeError } from '../../lib/sanitize-error';
import { getProjectNameValidationError } from '../../lib/project-name-validation';

export function ProjectDashboard() {
  const t = useTranslations('projects');
  const projects = useProjectStore((s) => s.projects);
  const isLoading = useProjectStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const navigate = useNavigationStore((s) => s.navigate);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [checkingProjectId, setCheckingProjectId] = useState<string | null>(null);
  const togglePin = usePreferencesStore((s) => s.togglePin);
  const isPinned = usePreferencesStore((s) => s.isPinned);
  const loadPreferences = usePreferencesStore((s) => s.loadPreferences);
  const pinnedProjectIds = usePreferencesStore((s) => s.pinnedProjectIds);

  useEffect(() => {
    if (!isAuthenticated) return;
    void loadProjects();
  }, [isAuthenticated]);

  const handleStartWithArch = () => {
    navigate('/arch');
  };

  const handleFromTemplate = () => {
    // Marketplace is a separate Next.js route group outside the SPA shell,
    // so we need a full page navigation (not SPA routing via navigate()).
    window.location.href = '/marketplace';
  };

  const filtered = projects;

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
        // Transient server/network error — keep the card and let the user retry.
        toast.error(sanitizeError(error, "Couldn't open this project. Please try again."));
      }
    } finally {
      setCheckingProjectId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-full text-muted">
        <p>{t('sign_in_prompt')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-noise">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <PageHeader
          title={t('title')}
          actions={
            <NewProjectDropdown
              onStartWithArch={handleStartWithArch}
              onBlankProject={() => setShowCreateModal(true)}
              onFromTemplate={handleFromTemplate}
            />
          }
        />

        {/* Search */}
        <div className="mt-6 mb-6">
          <ArchBar onCreateFromScratch={() => setShowCreateModal(true)} />
        </div>

        <PinnedProjectsRow />

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-muted animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Folder className="w-6 h-6" />}
            title={t('no_projects_yet')}
            description={t('no_projects_description')}
            action={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreateModal(true)}>
                {t('create')}
              </Button>
            }
          />
        ) : (
          <>
            {pinnedProjectIds.length > 0 && filtered.length > 0 && (
              <h3 className="text-xs text-muted uppercase tracking-wider font-medium mb-3 mt-1">
                {t('title')} ({filtered.length})
              </h3>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 stagger-children">
              {filtered.map((project) => {
                const color = getProjectColor(project.id);
                const isChecking = checkingProjectId === project.id;
                return (
                  <div
                    key={project.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleSelectProject(project)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') void handleSelectProject(project);
                    }}
                    className={`group relative ${isChecking ? 'opacity-70 cursor-wait pointer-events-none' : ''}`}
                  >
                    <Card padding="lg" hoverable className="bg-noise h-full flex flex-col">
                      {/* Pin button — hover reveal */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(project.id);
                        }}
                        className={`absolute top-3 right-3 p-1.5 rounded-md transition-all duration-150 z-10
                          ${
                            isPinned(project.id)
                              ? 'opacity-100 text-accent'
                              : 'opacity-0 group-hover:opacity-100 text-muted hover:text-accent hover:bg-background-muted'
                          }`}
                        aria-label={isPinned(project.id) ? t('unpin_project') : t('pin_project')}
                      >
                        <Pin
                          className={`w-3.5 h-3.5 ${isPinned(project.id) ? 'fill-current' : ''}`}
                        />
                      </button>
                      <div className="flex items-start gap-3 flex-1">
                        <div
                          className={`relative w-10 h-10 rounded-lg ${color.bg} flex items-center justify-center shrink-0 overflow-hidden`}
                        >
                          <GrainOverlay opacity={0.07} blendMode="overlay" />
                          <Folder className={`relative z-10 w-5 h-5 ${color.text}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-foreground truncate">
                            {project.name}
                          </h3>
                          {project.description && (
                            <p className="text-xs text-muted mt-1 line-clamp-2">
                              {project.description}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mt-4 pt-3 border-t border-default">
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          <Bot className="w-3.5 h-3.5" />
                          {t('agent_count', { count: project.agentCount ?? 0 })}
                        </span>
                        <span className="flex items-center gap-1.5 text-xs text-muted">
                          <Clock className="w-3.5 h-3.5" />
                          {new Date(project.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </Card>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Create Project Modal */}
      {showCreateModal && <CreateProjectModal onClose={() => setShowCreateModal(false)} />}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const t = useTranslations('projects');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigationStore((s) => s.navigate);

  const nameError = getProjectNameValidationError(name) ? t('name_pattern_error') : null;

  const handleCreate = async () => {
    if (!name.trim() || nameError) return;
    setCreateError(null);
    setIsCreating(true);
    try {
      const project = await createAndAddProject({ name, description: description || undefined });
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setCreateError(sanitizeError(err, 'Failed to create project'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-overlay backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-modal-title"
        className="bg-background-elevated border border-default rounded-2xl p-6 w-full max-w-md shadow-xl"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 id="create-project-modal-title" className="text-lg font-semibold text-foreground">
            {t('create_modal_title')}
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('name_label')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setCreateError(null);
              }}
              placeholder={t('name_placeholder')}
              className="w-full px-3 py-2 bg-background border border-default rounded-lg text-sm text-foreground placeholder-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
              autoFocus
            />
            {nameError && <p className="text-xs text-error mt-1">{nameError}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('description_label')}{' '}
              <span className="text-muted font-normal">({t('description_optional')})</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('description_placeholder')}
              rows={3}
              className="w-full px-3 py-2 bg-background border border-default rounded-lg text-sm text-foreground placeholder-muted focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-none"
            />
          </div>
        </div>

        {createError && (
          <div className="mt-4 rounded-lg border border-error/30 bg-error-subtle p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <p className="text-sm text-error">{createError}</p>
            </div>
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || !!nameError || isCreating}
            className="flex-1"
          >
            {isCreating ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('creating')}
              </span>
            ) : (
              t('create')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ProjectDashboard;
