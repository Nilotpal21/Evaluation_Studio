export interface ProjectSelectionStateSnapshot {
  currentProject: unknown;
  isLoading: boolean;
}

export interface SyncProjectSelectionArgs {
  projectId: string | null;
  projectRefetchedRef: { current: string | null };
  setCurrentProjectId: (projectId: string | null) => void;
  getProjectState: () => ProjectSelectionStateSnapshot;
  loadProjects: () => void;
}

export function syncProjectSelectionFromNavigation({
  projectId,
  projectRefetchedRef,
  setCurrentProjectId,
  getProjectState,
  loadProjects,
}: SyncProjectSelectionArgs): void {
  setCurrentProjectId(projectId);

  if (!projectId) {
    projectRefetchedRef.current = null;
    return;
  }

  const { currentProject, isLoading } = getProjectState();
  if (!currentProject && !isLoading && projectRefetchedRef.current !== projectId) {
    projectRefetchedRef.current = projectId;
    loadProjects();
  }
}
