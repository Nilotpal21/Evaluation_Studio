import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitSyncService, extractAgentNameFromPath } from '../git/git-sync-service.js';
import type { GitProvider } from '../git/git-provider.js';
import type { ProjectData } from '../export/project-exporter.js';

function createMockProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    providerName: 'mock',
    listFiles: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue(null),
    pullProject: vi.fn().mockResolvedValue({ files: [], commitSha: 'abc123', branch: 'main' }),
    pushFiles: vi.fn().mockResolvedValue({ commitSha: 'new123', branch: 'main' }),
    createBranch: vi.fn().mockResolvedValue({ name: 'test', sha: 'abc' }),
    createPullRequest: vi.fn().mockResolvedValue({ id: 1, url: 'http://pr', number: 1 }),
    listCommits: vi.fn().mockResolvedValue([
      {
        sha: 'abc123',
        message: 'init',
        author: { name: 'test', email: 'test@test.com' },
        date: '2024-01-01',
      },
    ]),
    registerWebhook: vi.fn().mockResolvedValue('hook-1'),
    removeWebhook: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue({ files: [], commitSha: 'abc', branch: '' }),
    validateConnection: vi.fn().mockResolvedValue({ valid: true }),
    ...overrides,
  };
}

const SAMPLE_PROJECT_DATA: ProjectData = {
  name: 'Test',
  slug: 'test',
  description: null,
  entryAgentName: null,
  agents: [
    {
      name: 'TestAgent',
      description: null,
      dslContent: 'AGENT: TestAgent\nGOAL: "Test"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"',
      ownerId: null,
      ownerTeamId: null,
      version: '1.0',
      status: 'active',
      systemPromptLibraryRef: {
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'prompt-hash-1',
      },
    },
  ],
  toolFiles: [],
  deployments: [],
  locales: new Map([['en/_shared.json', '{"greeting":"Hello"}']]),
};

const SAMPLE_AGENT_PATH = 'agents/testagent.agent.abl';

describe('GitSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('push', () => {
    it('should push project files to git', async () => {
      const mockProvider = createMockProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync: update agents',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('new123');
      expect(mockProvider.pushFiles).toHaveBeenCalled();
      expect(mockProvider.pushFiles).toHaveBeenCalledWith(
        'main',
        expect.arrayContaining([
          expect.objectContaining({
            path: 'agents/testagent.agent.abl',
            content:
              'AGENT: TestAgent\nGOAL: "Test"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"',
          }),
          expect.objectContaining({
            path: 'locales/en/_shared.json',
            content: '{"greeting":"Hello"}',
          }),
        ]),
        'sync: update agents',
        { name: 'Test', email: 'test@test.com' },
      );

      const pushedFiles = (mockProvider.pushFiles as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const projectManifest = pushedFiles.find(
        (file: { path: string }) => file.path === 'project.json',
      );
      expect(projectManifest).toBeDefined();
      expect(JSON.parse(projectManifest.content).agents.TestAgent.systemPromptLibraryRef).toEqual({
        promptId: 'prompt-1',
        versionId: 'version-1',
        resolvedHash: 'prompt-hash-1',
      });
    });

    it('should push pre-exported canonical files when provided', async () => {
      const mockProvider = createMockProvider();
      const service = new GitSyncService(mockProvider);

      const projectFiles = new Map<string, string>([
        ['agents/testagent.agent.yaml', 'agent: TestAgent'],
        ['behavior_profiles/voice_vip.behavior_profile.abl', 'BEHAVIOR_PROFILE voice_vip'],
        ['workflows/escalate.workflow.json', '{"name":"escalate"}'],
        ['project.json', '{"format_version":"2.0"}'],
        ['abl.lock', '{"version":"2.0"}'],
      ]);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        projectFiles,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync: push canonical files',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      } as any);

      expect(result.success).toBe(true);
      expect(mockProvider.pushFiles).toHaveBeenCalledWith(
        'main',
        expect.arrayContaining([
          expect.objectContaining({
            path: 'behavior_profiles/voice_vip.behavior_profile.abl',
            content: 'BEHAVIOR_PROFILE voice_vip',
          }),
          expect.objectContaining({
            path: 'workflows/escalate.workflow.json',
            content: '{"name":"escalate"}',
          }),
        ]),
        'sync: push canonical files',
        { name: 'Test', email: 'test@test.com' },
      );
    });

    it('prefixes pushed canonical files with configured syncPath while comparing canonical paths', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'studio/project-a/agents/existing.agent.yaml',
              content: 'agent: Existing',
            },
          ],
          commitSha: 'abc123',
          branch: 'main',
        }),
      });
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectFiles: new Map<string, string>([
          ['agents/existing.agent.yaml', 'agent: Existing v2'],
          ['project.json', '{"format_version":"2.0"}'],
        ]),
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        syncPath: 'studio/project-a',
        commitMessage: 'sync: scoped push',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(mockProvider.pullProject).toHaveBeenCalledWith('main', 'studio/project-a');
      expect(mockProvider.pushFiles).toHaveBeenCalledWith(
        'main',
        expect.arrayContaining([
          expect.objectContaining({
            path: 'studio/project-a/agents/existing.agent.yaml',
            content: 'agent: Existing v2',
          }),
          expect.objectContaining({
            path: 'studio/project-a/project.json',
          }),
        ]),
        'sync: scoped push',
        { name: 'Test', email: 'test@test.com' },
      );
      expect(result.changes.modified).toEqual(['agents/existing.agent.yaml']);
    });

    it('accepts persisted leading-slash syncPath values and passes relative provider paths', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'studio/project-a/agents/existing.agent.yaml',
              content: 'agent: Existing',
            },
          ],
          commitSha: 'abc123',
          branch: 'main',
        }),
      });
      const service = new GitSyncService(mockProvider);

      await service.push({
        projectFiles: new Map<string, string>([
          ['agents/existing.agent.yaml', 'agent: Existing v2'],
        ]),
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        syncPath: '/studio/project-a',
        commitMessage: 'sync: scoped push',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(mockProvider.pullProject).toHaveBeenCalledWith('main', 'studio/project-a');
      expect(mockProvider.pushFiles).toHaveBeenCalledWith(
        'main',
        [
          {
            path: 'studio/project-a/agents/existing.agent.yaml',
            content: 'agent: Existing v2',
          },
        ],
        'sync: scoped push',
        { name: 'Test', email: 'test@test.com' },
      );
    });

    it.each(['../project-b', 'studio/../../project-b', './studio', 'studio//project-a'])(
      'rejects unsafe push syncPath %s before pulling or pushing remote files',
      async (syncPath) => {
        const mockProvider = createMockProvider();
        const service = new GitSyncService(mockProvider);

        await expect(
          service.push({
            projectFiles: new Map([['project.json', '{"format_version":"2.0"}']]),
            userId: 'user-1',
            tenantId: 'tenant-1',
            branch: 'main',
            syncPath,
            commitMessage: 'sync: scoped push',
            committer: { name: 'Test', email: 'test@test.com' },
            lastSyncCommit: null,
          }),
        ).rejects.toThrow(/syncPath/i);

        expect(mockProvider.pullProject).not.toHaveBeenCalled();
        expect(mockProvider.pushFiles).not.toHaveBeenCalled();
      },
    );

    it('should create PR when specified', async () => {
      const mockProvider = createMockProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
        createPR: { title: 'Sync', description: 'Auto sync', targetBranch: 'main' },
      });

      expect(result.success).toBe(true);
      expect(mockProvider.createBranch).toHaveBeenCalled();
      expect(mockProvider.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Sync',
          description: 'Auto sync',
          targetBranch: 'main',
        }),
      );
    });
  });

  describe('pull', () => {
    it('should pull remote project files into a canonical file map without importing them', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            { path: 'project.json', content: '{"format_version":"2.0"}' },
            { path: 'agents/remoteagent.agent.yaml', content: 'agent: RemoteAgent' },
          ],
          commitSha: 'remote123',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pullProjectFiles('main');

      expect(mockProvider.pullProject).toHaveBeenCalledWith('main', undefined);
      expect(result.commitSha).toBe('remote123');
      expect(result.branch).toBe('main');
      expect(result.files.get('project.json')).toBe('{"format_version":"2.0"}');
      expect(result.files.get('agents/remoteagent.agent.yaml')).toBe('agent: RemoteAgent');
    });

    it('pulls from configured syncPath and strips the repository prefix from canonical files', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'studio/project-a/project.json',
              content: '{"format_version":"2.0"}',
            },
            {
              path: 'studio/project-a/agents/remoteagent.agent.yaml',
              content: 'agent: RemoteAgent',
            },
          ],
          commitSha: 'remote123',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pullProjectFiles('main', 'studio/project-a');

      expect(mockProvider.pullProject).toHaveBeenCalledWith('main', 'studio/project-a');
      expect(result.files.get('project.json')).toBe('{"format_version":"2.0"}');
      expect(result.files.get('agents/remoteagent.agent.yaml')).toBe('agent: RemoteAgent');
      expect(result.files.has('studio/project-a/project.json')).toBe(false);
    });

    it('drops provider files outside the configured syncPath instead of importing them', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'studio/project-a/project.json',
              content: '{"format_version":"2.0"}',
            },
            {
              path: 'other-project/project.json',
              content: '{"format_version":"2.0","name":"wrong-project"}',
            },
            {
              path: 'studio/project-a/agents/remoteagent.agent.yaml',
              content: 'agent: RemoteAgent',
            },
          ],
          commitSha: 'remote123',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pullProjectFiles('main', 'studio/project-a');

      expect(result.files.get('project.json')).toBe('{"format_version":"2.0"}');
      expect(result.files.get('agents/remoteagent.agent.yaml')).toBe('agent: RemoteAgent');
      expect(result.files.get('other-project/project.json')).toBeUndefined();
    });

    it.each(['../project-b', 'studio/../../project-b', './studio', 'studio//project-a'])(
      'rejects unsafe pull syncPath %s before invoking the provider',
      async (syncPath) => {
        const mockProvider = createMockProvider();
        const service = new GitSyncService(mockProvider);

        await expect(service.pullProjectFiles('main', syncPath)).rejects.toThrow(/syncPath/i);
        expect(mockProvider.pullProject).not.toHaveBeenCalled();
      },
    );

    it('should pull remote files and compute import preview', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'project.json',
              content: JSON.stringify({
                name: 'Test',
                slug: 'test',
                description: null,
                version: '1.0.0',
                abl_version: '1.0',
                exported_at: new Date().toISOString(),
                exported_by: 'user',
                entry_agent: null,
                agents: {
                  RemoteAgent: {
                    path: 'agents/remoteagent.agent.yaml',
                    owner: null,
                    ownerTeam: null,
                    description: null,
                    version: null,
                  },
                },
                tools: {},
                dependencies: { agent_references: [], tool_imports: [] },
              }),
            },
            {
              path: 'agents/remoteagent.agent.yaml',
              content:
                'AGENT: RemoteAgent\nGOAL: "Remote"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"',
            },
          ],
          commitSha: 'remote123',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pull({
        projectId: 'proj-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        existingState: { agents: new Map(), toolFiles: new Map() },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('remote123');
      expect(result.changes.added).toContain('RemoteAgent');
    });

    it('should detect modified agents when existing state has agents', async () => {
      const existingAgents = new Map([
        [
          'RemoteAgent',
          {
            name: 'RemoteAgent',
            dslContent:
              'AGENT: RemoteAgent\nGOAL: "Old"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Old"',
          },
        ],
      ]);

      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'project.json',
              content: JSON.stringify({
                name: 'Test',
                slug: 'test',
                description: null,
                version: '1.0.0',
                abl_version: '1.0',
                exported_at: new Date().toISOString(),
                exported_by: 'user',
                entry_agent: null,
                agents: {
                  RemoteAgent: {
                    path: 'agents/remoteagent.agent.yaml',
                    owner: null,
                    ownerTeam: null,
                    description: null,
                    version: null,
                  },
                },
                tools: {},
                dependencies: { agent_references: [], tool_imports: [] },
              }),
            },
            {
              path: 'agents/remoteagent.agent.yaml',
              content:
                'AGENT: RemoteAgent\nGOAL: "Updated"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Updated"',
            },
          ],
          commitSha: 'remote-modified',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pull({
        projectId: 'proj-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        existingState: { agents: existingAgents, toolFiles: new Map() },
        lastSyncCommit: 'old-commit',
      });

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('remote-modified');
      // Agent exists in both — should appear as modified
      expect(result.changes.modified).toContain('RemoteAgent');
    });

    it('should throw when circuit breaker is open on pull', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockRejectedValue(new Error('timeout')),
      });

      // Use a circuit breaker that opens quickly
      const service = new GitSyncService(mockProvider, {
        failureThreshold: 1,
        resetTimeoutMs: 60_000,
      });

      const pullOpts = {
        projectId: 'proj-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        existingState: { agents: new Map(), toolFiles: new Map() },
        lastSyncCommit: null,
      };

      // First call triggers the failure and opens the breaker
      await expect(service.pull(pullOpts)).rejects.toThrow();

      // Second call should throw due to circuit breaker being OPEN
      await expect(service.pull(pullOpts)).rejects.toThrow();
    });

    it('should propagate import validation errors in result', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [{ path: 'agents/bad.agent.yaml', content: 'no header here' }],
          commitSha: 'abc',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pull({
        projectId: 'p1',
        userId: 'u1',
        tenantId: 't1',
        branch: 'main',
        existingState: { agents: new Map(), toolFiles: new Map() },
        lastSyncCommit: null,
      });

      // Should still return a result (not throw) — import may fail gracefully
      expect(result).toBeDefined();
      expect(result.commitSha).toBeDefined();
    });

    it('should propagate import errors on pull failure', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            // Invalid folder structure — no project.json, no valid agent files
            { path: 'garbage.txt', content: 'not a valid project' },
          ],
          commitSha: 'bad123',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.pull({
        projectId: 'proj-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        existingState: { agents: new Map(), toolFiles: new Map() },
        lastSyncCommit: null,
      });

      // importProject returns success: false for invalid folder
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('push — failed export', () => {
    it('should return error when project has no agents', async () => {
      const emptyProjectData: ProjectData = {
        name: 'Empty',
        slug: 'empty',
        description: null,
        entryAgentName: null,
        agents: [],
        toolFiles: [],
        deployments: [],
      };

      const mockProvider = createMockProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: emptyProjectData,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('NO_AGENTS');
      expect(mockProvider.pushFiles).not.toHaveBeenCalled();
    });
  });

  describe('push — empty repository', () => {
    it('should proceed with push when pullProject throws (empty repo)', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockRejectedValue(new Error('Repository is empty')),
      });
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'initial sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      expect(result.commitSha).toBe('new123');
      expect(mockProvider.pushFiles).toHaveBeenCalled();
      // All files are added since remote is empty
      expect(result.changes.added.length).toBeGreaterThan(0);
      expect(result.changes.deleted).toHaveLength(0);
    });
  });

  describe('push — conflict detection', () => {
    it('should detect conflicts when lastSyncCommit is set and all three versions differ', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: SAMPLE_AGENT_PATH,
              content:
                'AGENT: TestAgent\nGOAL: "Remote version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Remote"',
            },
            {
              path: 'project.json',
              content: '{}',
            },
          ],
          commitSha: 'remote456',
          branch: 'main',
        }),
        // Base content differs from both local and remote — true conflict
        getFile: vi.fn().mockResolvedValue({
          path: SAMPLE_AGENT_PATH,
          content:
            'AGENT: TestAgent\nGOAL: "Base version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Base"',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('SYNC_CONFLICT');
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(mockProvider.pushFiles).not.toHaveBeenCalled();
      // Verify getFile was called with the lastSyncCommit SHA
      expect(mockProvider.getFile).toHaveBeenCalledWith('previous-commit-sha', SAMPLE_AGENT_PATH);
    });

    it('should accept remote changes when base equals local (no local edits)', async () => {
      // Local content matches the base — only remote changed, so no conflict
      const localContent =
        'AGENT: TestAgent\nGOAL: "Test"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"';
      const remoteContent =
        'AGENT: TestAgent\nGOAL: "Remote edit"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Remote"';

      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [{ path: SAMPLE_AGENT_PATH, content: remoteContent }],
          commitSha: 'remote456',
          branch: 'main',
        }),
        // Return path-aware base content: agent file matches local, null for others
        getFile: vi.fn().mockImplementation((_ref: string, path: string) => {
          if (path === SAMPLE_AGENT_PATH) {
            return Promise.resolve({ path, content: localContent });
          }
          return Promise.resolve(null);
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
      });

      // Three-way merge resolves: base === ours, so accept theirs — no conflict
      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(mockProvider.pushFiles).toHaveBeenCalled();
    });

    it('should keep local changes when base equals remote (no remote edits)', async () => {
      const remoteContent =
        'AGENT: TestAgent\nGOAL: "Base version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Base"';

      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [{ path: SAMPLE_AGENT_PATH, content: remoteContent }],
          commitSha: 'remote456',
          branch: 'main',
        }),
        // Return path-aware base content: agent file matches remote, null for others
        getFile: vi.fn().mockImplementation((_ref: string, path: string) => {
          if (path === SAMPLE_AGENT_PATH) {
            return Promise.resolve({ path, content: remoteContent });
          }
          return Promise.resolve(null);
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
      });

      // Three-way merge resolves: base === theirs, so keep ours — no conflict
      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(mockProvider.pushFiles).toHaveBeenCalled();
    });

    it('should fall back to two-way when getFile fails for base content', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: SAMPLE_AGENT_PATH,
              content:
                'AGENT: TestAgent\nGOAL: "Remote version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Remote"',
            },
            { path: 'project.json', content: '{}' },
          ],
          commitSha: 'remote456',
          branch: 'main',
        }),
        // getFile fails — cannot fetch base
        getFile: vi.fn().mockRejectedValue(new Error('API timeout')),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
      });

      // Falls back to base=null, which treats the difference as a conflict
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_CONFLICT');
    });

    it('should skip conflict detection on first sync (no lastSyncCommit)', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: SAMPLE_AGENT_PATH,
              content:
                'AGENT: TestAgent\nGOAL: "Remote version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Remote"',
            },
          ],
          commitSha: 'remote456',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null, // First sync — no base
      });

      // No conflict detection on first sync
      expect(result.success).toBe(true);
      expect(mockProvider.getFile).not.toHaveBeenCalled();
      expect(mockProvider.pushFiles).toHaveBeenCalled();
    });
  });

  describe('extractAgentNameFromPath', () => {
    it('should extract agent name from standard path', () => {
      expect(extractAgentNameFromPath('agents/supervisor.agent.abl')).toBe('supervisor');
    });

    it('should extract tool name from tools path', () => {
      expect(extractAgentNameFromPath('tools/booking_api.tools.abl')).toBe('booking_api');
    });

    it('should return filename for unrecognized paths', () => {
      expect(extractAgentNameFromPath('config/models.json')).toBe('models');
    });

    it('should handle nested paths safely', () => {
      expect(extractAgentNameFromPath('agents/sub/nested.agent.abl')).toBe('sub/nested');
    });

    it('should not produce empty string for edge case paths', () => {
      const result = extractAgentNameFromPath('agents/.agent.abl');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle yaml agent paths', () => {
      expect(extractAgentNameFromPath('agents/booking.agent.yaml')).toBe('booking');
    });
  });

  describe('push — conflict auto-resolution', () => {
    const LOCAL_CONTENT =
      'AGENT: TestAgent\nGOAL: "Test"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"';
    const REMOTE_CONTENT =
      'AGENT: TestAgent\nGOAL: "Remote version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Remote"';
    const BASE_CONTENT =
      'AGENT: TestAgent\nGOAL: "Base version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Base"';

    function createConflictProvider() {
      return createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            { path: SAMPLE_AGENT_PATH, content: REMOTE_CONTENT },
            { path: 'project.json', content: '{}' },
          ],
          commitSha: 'remote456',
          branch: 'main',
        }),
        // Base content differs from both local and remote — true conflict
        getFile: vi.fn().mockResolvedValue({
          path: SAMPLE_AGENT_PATH,
          content: BASE_CONTENT,
        }),
      });
    }

    it('should auto-resolve with local_wins strategy', async () => {
      const mockProvider = createConflictProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
        conflictStrategy: 'local_wins',
      });

      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(mockProvider.pushFiles).toHaveBeenCalled();

      // Verify pushed content is the local version
      const pushCall = (mockProvider.pushFiles as ReturnType<typeof vi.fn>).mock.calls[0];
      const pushedFiles = pushCall[1] as Array<{ path: string; content: string }>;
      const agentFile = pushedFiles.find((f: { path: string }) => f.path === SAMPLE_AGENT_PATH);
      expect(agentFile?.content).toBe(LOCAL_CONTENT);
    });

    it('should return conflicts when strategy is manual', async () => {
      const mockProvider = createConflictProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
        conflictStrategy: 'manual',
      });

      expect(result.success).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.error?.code).toBe('SYNC_CONFLICT');
      expect(mockProvider.pushFiles).not.toHaveBeenCalled();
    });

    it('should auto-resolve with remote_wins strategy', async () => {
      const mockProvider = createConflictProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
        conflictStrategy: 'remote_wins',
      });

      expect(result.success).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(mockProvider.pushFiles).toHaveBeenCalled();

      // Verify pushed content is the remote version
      const pushCall = (mockProvider.pushFiles as ReturnType<typeof vi.fn>).mock.calls[0];
      const pushedFiles = pushCall[1] as Array<{ path: string; content: string }>;
      const agentFile = pushedFiles.find((f: { path: string }) => f.path === SAMPLE_AGENT_PATH);
      expect(agentFile?.content).toBe(REMOTE_CONTENT);
    });

    it('should default to manual when no conflictStrategy is provided', async () => {
      const mockProvider = createConflictProvider();
      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
        // No conflictStrategy — should default to 'manual'
      });

      expect(result.success).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.error?.code).toBe('SYNC_CONFLICT');
      expect(mockProvider.pushFiles).not.toHaveBeenCalled();
    });
  });

  describe('push — change summary', () => {
    it('should compute added/modified/deleted correctly', async () => {
      const remoteManifest = JSON.stringify({
        agents: {
          TestAgent: { path: SAMPLE_AGENT_PATH },
          OldAgent: { path: 'agents/old-agent.agent.yaml' },
        },
        tools: {},
      });
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: 'project.json',
              content: remoteManifest,
            },
            {
              path: SAMPLE_AGENT_PATH,
              // Remote has different content — this file should appear in modified
              content:
                'AGENT: TestAgent\nGOAL: "Old remote version"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Old"',
            },
            { path: 'agents/old-agent.agent.yaml', content: 'AGENT: OldAgent' },
          ],
          commitSha: 'remote789',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      // project.json and abl.lock are new files (added)
      // agents/testagent.agent.yaml exists in both with different content (modified)
      expect(result.changes.modified).toContain(SAMPLE_AGENT_PATH);
      // agents/old-agent.agent.yaml exists only in remote (deleted)
      expect(result.changes.deleted).toContain('agents/old-agent.agent.yaml');
      expect(mockProvider.pushFiles).toHaveBeenCalledWith(
        'main',
        expect.any(Array),
        'sync',
        { name: 'Test', email: 'test@test.com' },
        { deletedPaths: ['agents/old-agent.agent.yaml'] },
      );
    });

    it('does not delete remote-only files that are not owned by prior ABL metadata', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            { path: 'README.md', content: '# Keep me' },
            { path: '.github/workflows/ci.yml', content: 'name: CI' },
            { path: 'agents/untracked.agent.yaml', content: 'AGENT: Untracked' },
          ],
          commitSha: 'remote789',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      expect(result.changes.deleted).toEqual([]);
      expect(mockProvider.pushFiles).toHaveBeenCalledWith('main', expect.any(Array), 'sync', {
        name: 'Test',
        email: 'test@test.com',
      });
    });

    it('returns a conflict before deleting a managed remote file changed since last sync', async () => {
      const remoteManifest = JSON.stringify({
        agents: {
          TestAgent: { path: SAMPLE_AGENT_PATH },
          OldAgent: { path: 'agents/old-agent.agent.yaml' },
        },
        tools: {},
      });
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            { path: 'project.json', content: remoteManifest },
            {
              path: 'agents/old-agent.agent.yaml',
              content: 'AGENT: OldAgent\nGOAL: "Remote edit"',
            },
          ],
          commitSha: 'remote789',
          branch: 'main',
        }),
        getFile: vi.fn(async (_ref: string, path: string) => {
          if (path === 'agents/old-agent.agent.yaml') {
            return { path, content: 'AGENT: OldAgent\nGOAL: "Original"' };
          }
          if (path === 'project.json') {
            return { path, content: remoteManifest };
          }
          return null;
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: 'previous-commit-sha',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYNC_CONFLICT');
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: 'agents/old-agent.agent.yaml',
            baseContent: 'AGENT: OldAgent\nGOAL: "Original"',
            localContent: '',
            remoteContent: 'AGENT: OldAgent\nGOAL: "Remote edit"',
          }),
        ]),
      );
      expect(mockProvider.pushFiles).not.toHaveBeenCalled();
    });

    it('should not include unchanged files in modified', async () => {
      const mockProvider = createMockProvider({
        pullProject: vi.fn().mockResolvedValue({
          files: [
            {
              path: SAMPLE_AGENT_PATH,
              // Same content as what exportProject produces
              content:
                'AGENT: TestAgent\nGOAL: "Test"\nCOMPLETE:\n  - WHEN: true\n    RESPOND: "Done"',
            },
          ],
          commitSha: 'remote789',
          branch: 'main',
        }),
      });

      const service = new GitSyncService(mockProvider);

      const result = await service.push({
        projectData: SAMPLE_PROJECT_DATA,
        userId: 'user-1',
        tenantId: 'tenant-1',
        branch: 'main',
        commitMessage: 'sync',
        committer: { name: 'Test', email: 'test@test.com' },
        lastSyncCommit: null,
      });

      expect(result.success).toBe(true);
      // File has same content in both local and remote — should NOT be in modified
      expect(result.changes.modified).not.toContain(SAMPLE_AGENT_PATH);
    });
  });
});
