/**
 * Projects API Client
 *
 * Functions for project-related API calls.
 */

import { useProjectStore, type Project, type ProjectAgent } from '../store/project-store';
import { apiFetch, handleResponse } from '../lib/api-client';
import { sanitizeError } from '../lib/sanitize-error';

// =============================================================================
// PROJECT API
// =============================================================================

/**
 * Fetch all projects for current user
 */
export async function fetchProjects(): Promise<Project[]> {
  const response = await apiFetch('/api/projects', { cache: 'no-store' });

  const data = await handleResponse<{ success: boolean; projects: Project[] }>(response);
  return data.projects;
}

/**
 * Fetch a single project by ID
 */
export async function fetchProject(id: string): Promise<Project> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(id)}`);

  const data = await handleResponse<{ success: boolean; project: Project }>(response);
  return data.project;
}

/**
 * Create a new project
 */
export async function createProject(data: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<Project> {
  const response = await apiFetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const result = await handleResponse<{ success: boolean; project: Project }>(response);
  return result.project;
}

/**
 * Update a project
 */
export async function updateProject(
  id: string,
  data: { name?: string; description?: string; entryAgentName?: string | null },
): Promise<Project> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const result = await handleResponse<{ success: boolean; project: Project }>(response);
  return result.project;
}

/**
 * Delete a project
 */
export async function deleteProject(id: string): Promise<void> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  await handleResponse<{ success: boolean }>(response);
}

// =============================================================================
// PROJECT AGENT API
// =============================================================================

/**
 * Fetch agents in a project
 */
export async function fetchProjectAgents(projectId: string): Promise<ProjectAgent[]> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents`);

  const data = await handleResponse<{ agents: ProjectAgent[] }>(response);
  return data.agents;
}

/**
 * Add an agent to a project
 */
export async function addAgentToProject(
  projectId: string,
  data: { name: string; description?: string },
): Promise<ProjectAgent> {
  const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const agent = await handleResponse<ProjectAgent>(response);
  await loadProjects();
  return agent;
}

/**
 * Remove an agent from a project
 */
export async function removeAgentFromProject(projectId: string, agentId: string): Promise<void> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
    { method: 'DELETE' },
  );

  await handleResponse<{ success: boolean }>(response);
  await loadProjects();
}

/**
 * Update project agent metadata
 */
export async function updateProjectAgent(
  projectId: string,
  agentId: string,
  data: { name?: string; description?: string },
): Promise<ProjectAgent> {
  const response = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );

  return handleResponse<ProjectAgent>(response);
}

// =============================================================================
// STORE ACTIONS
// =============================================================================

/** In-flight promise so duplicate loadProjects() calls share one refresh chain */
let loadProjectsPromise: Promise<void> | null = null;
/** If a refresh is requested while a fetch is already running, rerun once after it completes. */
let loadProjectsQueued = false;

/**
 * Load projects and update store.
 * Concurrent or duplicate calls reuse the same in-flight request.
 */
export async function loadProjects(): Promise<void> {
  if (loadProjectsPromise) {
    loadProjectsQueued = true;
    return loadProjectsPromise;
  }

  loadProjectsPromise = (async () => {
    const { setProjects, setLoading, setError } = useProjectStore.getState();

    do {
      loadProjectsQueued = false;
      setLoading(true);
      setError(null);

      try {
        const projects = await fetchProjects();
        setProjects(projects);
      } catch (error) {
        setError(sanitizeError(error, 'Failed to load projects'));
      } finally {
        setLoading(false);
      }
    } while (loadProjectsQueued);
  })();

  try {
    await loadProjectsPromise;
  } finally {
    loadProjectsPromise = null;
  }
}

/**
 * Create project and update store
 */
export async function createAndAddProject(data: {
  name: string;
  slug?: string;
  description?: string;
}): Promise<Project> {
  const { addProject } = useProjectStore.getState();

  const project = await createProject(data);
  addProject({
    ...project,
    agentCount: 0,
    sessionCount: 0,
  });

  return project;
}

/**
 * Delete project and update store
 */
export async function deleteAndRemoveProject(id: string): Promise<void> {
  const { removeProject } = useProjectStore.getState();

  await deleteProject(id);
  removeProject(id);
}
