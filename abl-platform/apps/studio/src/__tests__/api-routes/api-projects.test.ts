/**
 * Tests for Projects API Client (apps/studio/src/api/projects.ts)
 *
 * Covers: fetchProjects, fetchProject, createProject, updateProject,
 * deleteProject, fetchProjectAgents, addAgentToProject,
 * updateProjectAgent, removeAgentFromProject, loadProjects,
 * createAndAddProject, deleteAndRemoveProject.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { expectRejectedMessage } from '../helpers/expect-rejected-message';
import {
  PROJECT_NAME_ERROR_MESSAGE,
  PROJECT_NAME_PATTERN,
} from '../../lib/project-name-validation';

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// ---------------------------------------------------------------------------

const mockSetProjects = vi.fn();
const mockSetLoading = vi.fn();
const mockSetError = vi.fn();
const mockAddProject = vi.fn();
const mockRemoveProject = vi.fn();

vi.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'test-access-token',
      tenantId: 'test-tenant-id',
    }),
  },
}));

vi.mock('../../store/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      setProjects: mockSetProjects,
      setLoading: mockSetLoading,
      setError: mockSetError,
      addProject: mockAddProject,
      removeProject: mockRemoveProject,
    }),
  },
}));

vi.mock('../../lib/sanitize-error', () => ({
  sanitizeError: (_error: unknown, fallback: string) => fallback,
  sanitizeServerError: (message: string | undefined, fallback: string) => message || fallback,
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import {
  fetchProjects,
  fetchProject,
  createProject,
  updateProject,
  deleteProject,
  fetchProjectAgents,
  addAgentToProject,
  updateProjectAgent,
  removeAgentFromProject,
  loadProjects,
  createAndAddProject,
  deleteAndRemoveProject,
} from '../../api/projects';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockSetProjects.mockReset();
  mockSetLoading.mockReset();
  mockSetError.mockReset();
  mockAddProject.mockReset();
  mockRemoveProject.mockReset();
  global.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchProjects', () => {
  it('should call the correct URL with auth headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects: [] }),
    });

    await fetchProjects();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(opts.headers).toHaveProperty('Authorization', 'Bearer test-access-token');
  });

  it('should bypass cached project-list responses so import refreshes receive new agent counts', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects: [] }),
    });

    await fetchProjects();

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.cache).toBe('no-store');
  });

  it('should return the projects array from the response', async () => {
    const projects = [{ id: 'p1', name: 'Project 1' }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects }),
    });

    const result = await fetchProjects();

    expect(result).toEqual(projects);
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    await expect(fetchProjects()).rejects.toThrow();
  });

  it('should throw with fallback message on non-ok response with no parseable body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.reject(new Error('invalid json')),
    });

    await expectRejectedMessage(fetchProjects(), 'Request failed');
  });
});

describe('fetchProject', () => {
  it('should call the correct URL with project ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, project: { id: 'proj-123', name: 'My Project' } }),
    });

    await fetchProject('proj-123');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-123');
  });

  it('should return the project from the response', async () => {
    const project = { id: 'proj-123', name: 'My Project', slug: 'my-project' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project }),
    });

    const result = await fetchProject('proj-123');

    expect(result).toEqual(project);
  });

  it('should throw on 404', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Project not found' }),
    });

    await expect(fetchProject('nonexistent')).rejects.toThrow();
  });
});

describe('createProject', () => {
  it('should POST to the correct URL with the body', async () => {
    const newProject = { name: 'New Project', description: 'A test project' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project: { id: 'new-123', ...newProject } }),
    });

    await createProject(newProject);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(newProject);
  });

  it('should include optional slug in the body', async () => {
    const data = { name: 'Slugged', slug: 'my-slug' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project: { id: 'sl-1', ...data } }),
    });

    await createProject(data);

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('should return the created project', async () => {
    const created = { id: 'new-123', name: 'New', slug: 'new' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project: created }),
    });

    const result = await createProject({ name: 'New' });

    expect(result).toEqual(created);
  });

  it('should throw on server error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Validation error' }),
    });

    await expect(createProject({ name: '' })).rejects.toThrow();
  });
});

describe('updateProject', () => {
  it('should PATCH to the correct URL with body', async () => {
    const updates = { name: 'Updated Name' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project: { id: 'proj-1', ...updates } }),
    });

    await updateProject('proj-1', updates);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual(updates);
  });

  it('should support setting entryAgentName to null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, project: { id: 'proj-1', entryAgentName: null } }),
    });

    await updateProject('proj-1', { entryAgentName: null });

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ entryAgentName: null });
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    await expect(updateProject('bad-id', { name: 'x' })).rejects.toThrow();
  });
});

describe('deleteProject', () => {
  it('should DELETE to the correct URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await deleteProject('proj-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1');
    expect(opts.method).toBe('DELETE');
  });

  it('should not return a value', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    const result = await deleteProject('proj-1');

    expect(result).toBeUndefined();
  });

  it('should throw on error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    });

    await expect(deleteProject('proj-1')).rejects.toThrow();
  });
});

describe('fetchProjectAgents', () => {
  it('should call the correct URL with project ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });

    await fetchProjectAgents('proj-1');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1/agents');
  });

  it('should return the agents array', async () => {
    const agents = [{ id: 'a1', name: 'Agent 1', agentPath: 'domain/agent1' }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents }),
    });

    const result = await fetchProjectAgents('proj-1');

    expect(result).toEqual(agents);
  });

  it('should return empty array when no agents', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });

    const result = await fetchProjectAgents('proj-1');

    expect(result).toEqual([]);
  });

  it('should throw on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    await expect(fetchProjectAgents('bad')).rejects.toThrow();
  });
});

describe('addAgentToProject', () => {
  it('should POST to the correct URL with agent data', async () => {
    const agentData = { name: 'booking', description: 'Books hotels' };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'agent-1', agentPath: 'proj-1/booking', ...agentData }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [] }),
      });

    await addAgentToProject('proj-1', agentData);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1/agents');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(agentData);
  });

  it('should return the created agent', async () => {
    const agent = { id: 'agent-1', name: 'booking', agentPath: 'hotel/booking' };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(agent),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [] }),
      });

    const result = await addAgentToProject('proj-1', {
      name: 'booking',
    });

    expect(result).toEqual(agent);
  });

  it('refreshes the project store from GET /api/projects after creating an agent', async () => {
    const agent = { id: 'agent-1', name: 'booking', agentPath: 'hotel/booking' };
    const projects = [{ id: 'proj-1', name: 'Project 1', agentCount: 1 }];
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(agent),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects }),
      });

    await addAgentToProject('proj-1', {
      name: 'booking',
    });

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/projects',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(mockSetProjects).toHaveBeenCalledWith(projects);
  });

  it('does not refresh the project store when creating an agent fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Create failed' }),
    });

    await expectRejectedMessage(addAgentToProject('proj-1', { name: 'booking' }), 'Create failed');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSetProjects).not.toHaveBeenCalled();
  });
});

describe('updateProjectAgent', () => {
  it('should PATCH the correct URL with agent metadata', async () => {
    const updates = {
      description: 'Updated booking specialist',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 'agent-1',
          projectId: 'proj-1',
          name: 'booking_agent',
          ...updates,
        }),
    });

    await updateProjectAgent('proj-1', 'booking_agent', updates);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1/agents/booking_agent');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual(updates);
  });

  it('should return the updated agent', async () => {
    const agent = {
      id: 'agent-1',
      projectId: 'proj-1',
      name: 'booking_agent',
      agentPath: 'proj-1/default/booking_agent',
      description: 'Updated description',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(agent),
    });

    const result = await updateProjectAgent('proj-1', 'booking_agent', {
      description: 'Updated description',
    });

    expect(result).toEqual(agent);
  });
});

describe('removeAgentFromProject', () => {
  it('should DELETE to the correct URL', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [] }),
      });

    await removeAgentFromProject('proj-1', 'agent-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj-1/agents/agent-1');
    expect(opts.method).toBe('DELETE');
  });

  it('should not return a value', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [] }),
      });

    const result = await removeAgentFromProject('proj-1', 'agent-1');

    expect(result).toBeUndefined();
  });

  it('refreshes the project store from GET /api/projects after removing an agent', async () => {
    const projects = [{ id: 'proj-1', name: 'Project 1', agentCount: 0 }];
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects }),
      });

    await removeAgentFromProject('proj-1', 'agent-1');

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      '/api/projects',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(mockSetProjects).toHaveBeenCalledWith(projects);
  });

  it('does not refresh the project store when removing an agent fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Delete failed' }),
    });

    await expectRejectedMessage(removeAgentFromProject('proj-1', 'agent-1'), 'Delete failed');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSetProjects).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Store action tests
// ---------------------------------------------------------------------------

describe('loadProjects', () => {
  it('should set loading state and call setProjects on success', async () => {
    const projects = [{ id: 'p1', name: 'P1' }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects }),
    });

    await loadProjects();

    expect(mockSetLoading).toHaveBeenCalledWith(true);
    expect(mockSetError).toHaveBeenCalledWith(null);
    expect(mockSetProjects).toHaveBeenCalledWith(projects);
    expect(mockSetLoading).toHaveBeenCalledWith(false);
  });

  it('should refetch after an in-flight load when import refresh needs newer agent counts', async () => {
    let resolveFirstFetch:
      | ((value: {
          ok: boolean;
          json: () => Promise<{ projects: Array<{ id: string; agentCount: number }> }>;
        }) => void)
      | null = null;

    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstFetch = resolve as typeof resolveFirstFetch;
        }),
    );
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [{ id: 'p1', agentCount: 2 }] }),
    });

    const initialLoad = loadProjects();
    const importRefreshLoad = loadProjects();

    resolveFirstFetch?.({
      ok: true,
      json: () => Promise.resolve({ projects: [{ id: 'p1', agentCount: 0 }] }),
    });

    await initialLoad;
    await importRefreshLoad;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockSetProjects).toHaveBeenLastCalledWith([{ id: 'p1', agentCount: 2 }]);
  });

  it('should set error state on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    await loadProjects();

    expect(mockSetLoading).toHaveBeenCalledWith(true);
    expect(mockSetError).toHaveBeenCalledWith('Failed to load projects');
    expect(mockSetLoading).toHaveBeenCalledWith(false);
  });

  it('should set loading to false even if fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await loadProjects();

    expect(mockSetLoading).toHaveBeenCalledWith(false);
    expect(mockSetError).toHaveBeenCalled();
  });
});

describe('createAndAddProject', () => {
  it('should create a project and add it to the store', async () => {
    const project = { id: 'new-1', name: 'New Project' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, project }),
    });

    const result = await createAndAddProject({ name: 'New Project' });

    expect(result).toEqual(project);
    expect(mockAddProject).toHaveBeenCalledWith({
      ...project,
      agentCount: 0,
      sessionCount: 0,
    });
  });

  it('should throw if project creation fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Duplicate' }),
    });

    await expect(createAndAddProject({ name: 'Dup' })).rejects.toThrow();
    expect(mockAddProject).not.toHaveBeenCalled();
  });
});

describe('deleteAndRemoveProject', () => {
  it('should delete a project and remove it from the store', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    await deleteAndRemoveProject('proj-1');

    expect(mockRemoveProject).toHaveBeenCalledWith('proj-1');
  });

  it('should not remove from store if delete fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    await expect(deleteAndRemoveProject('bad')).rejects.toThrow();
    expect(mockRemoveProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests (mirrors route.ts createProjectSchema)
// ---------------------------------------------------------------------------

const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Project name is required')
    .max(100, 'Project name must be 100 characters or less')
    .regex(PROJECT_NAME_PATTERN, PROJECT_NAME_ERROR_MESSAGE),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().trim().max(500, 'Description must be 500 characters or less').optional(),
});

describe('createProjectSchema validation', () => {
  describe('name field', () => {
    it('should accept valid project names', () => {
      const validNames = [
        'My Project',
        'project-1',
        'Test_Project.v2',
        'A',
        '1',
        'Project 123',
        'my-project_v1.0',
        'CamelCaseProject',
      ];

      for (const name of validNames) {
        const result = createProjectSchema.safeParse({ name });
        expect(result.success, `Expected "${name}" to be valid`).toBe(true);
      }
    });

    it('should trim leading and trailing whitespace', () => {
      const result = createProjectSchema.safeParse({ name: '  My Project  ' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Project');
      }
    });

    it('should reject empty name after trim', () => {
      const result = createProjectSchema.safeParse({ name: '   ' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Project name is required');
      }
    });

    it('should reject names with special characters', () => {
      const invalidNames = ['Test@Project!', 'Project#1', 'My$Project', 'Test%Name', 'Project&Co'];

      for (const name of invalidNames) {
        const result = createProjectSchema.safeParse({ name });
        expect(result.success, `Expected "${name}" to be invalid`).toBe(false);
      }
    });

    it('should reject names starting or ending with special characters', () => {
      const invalidNames = ['-project', 'project-', '.project', 'project.', '_project', 'project_'];

      for (const name of invalidNames) {
        const result = createProjectSchema.safeParse({ name });
        expect(result.success, `Expected "${name}" to be invalid`).toBe(false);
      }
    });

    it('should reject names exceeding 100 characters', () => {
      const longName = 'a'.repeat(101);
      const result = createProjectSchema.safeParse({ name: longName });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Project name must be 100 characters or less');
      }
    });

    it('should accept names at exactly 100 characters', () => {
      const maxName = 'a'.repeat(100);
      const result = createProjectSchema.safeParse({ name: maxName });
      expect(result.success).toBe(true);
    });
  });

  describe('description field', () => {
    it('should accept valid descriptions', () => {
      const result = createProjectSchema.safeParse({
        name: 'Test',
        description: 'This is a valid project description.',
      });
      expect(result.success).toBe(true);
    });

    it('should trim description whitespace', () => {
      const result = createProjectSchema.safeParse({
        name: 'Test',
        description: '  Trimmed description  ',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.description).toBe('Trimmed description');
      }
    });

    it('should allow empty description (optional)', () => {
      const result = createProjectSchema.safeParse({ name: 'Test' });
      expect(result.success).toBe(true);
    });

    it('should reject descriptions exceeding 500 characters', () => {
      const longDescription = 'a'.repeat(501);
      const result = createProjectSchema.safeParse({
        name: 'Test',
        description: longDescription,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Description must be 500 characters or less');
      }
    });

    it('should accept descriptions at exactly 500 characters', () => {
      const maxDescription = 'a'.repeat(500);
      const result = createProjectSchema.safeParse({
        name: 'Test',
        description: maxDescription,
      });
      expect(result.success).toBe(true);
    });
  });
});
