/**
 * Tests for Branch Manager
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BranchManager } from '../git/branch-manager.js';
import type { GitProvider } from '../git/git-provider.js';

// ─── Mock Provider ──────────────────────────────────────────────────────

function createMockProvider(): GitProvider {
  return {
    providerName: 'github',
    listFiles: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue(null),
    pullProject: vi.fn().mockResolvedValue({ files: [], commitSha: 'abc', branch: 'main' }),
    pushFiles: vi.fn().mockResolvedValue({ commitSha: 'new-sha', branch: 'main' }),
    createBranch: vi.fn().mockResolvedValue({ name: 'staging', sha: 'abc123' }),
    createPullRequest: vi
      .fn()
      .mockResolvedValue({ id: 1, url: 'https://github.com/pr/1', number: 1 }),
    listCommits: vi.fn().mockResolvedValue([
      {
        sha: 'abc123',
        message: 'Initial commit',
        author: { name: 'Test', email: 'test@test.com' },
        date: '2026-03-07T10:00:00Z',
      },
    ]),
    registerWebhook: vi.fn().mockResolvedValue('hook-1'),
    removeWebhook: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue({ files: [], commitSha: 'abc', branch: '' }),
    validateConnection: vi.fn().mockResolvedValue({ valid: true }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('BranchManager', () => {
  let provider: GitProvider;
  let manager: BranchManager;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    manager = new BranchManager(provider);
  });

  describe('createEnvironmentBranch', () => {
    it('should create a branch from main', async () => {
      const result = await manager.createEnvironmentBranch('staging');

      expect(provider.createBranch).toHaveBeenCalledWith('staging', 'main');
      expect(result.name).toBe('staging');
      expect(result.sha).toBe('abc123');
    });

    it('should create a branch from custom source', async () => {
      await manager.createEnvironmentBranch('production', 'staging');

      expect(provider.createBranch).toHaveBeenCalledWith('production', 'staging');
    });

    it('should return existing branch if already exists', async () => {
      (provider.createBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GitHub API error: 422'),
      );
      (provider.listCommits as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sha: 'existing-branch-sha',
          message: 'Latest on staging',
          author: { name: 'Test', email: 'test@test.com' },
          date: '2026-03-07T12:00:00Z',
        },
      ]);

      const result = await manager.createEnvironmentBranch('staging');

      expect(provider.listCommits).toHaveBeenCalledWith('staging', 1);
      expect(result.name).toBe('staging');
      expect(result.sha).toBe('existing-branch-sha');
    });
  });

  describe('promoteBranch', () => {
    it('should create a PR for promotion', async () => {
      const result = await manager.promoteBranch('main', 'staging');

      expect(result.success).toBe(true);
      expect(provider.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceBranch: 'main',
          targetBranch: 'staging',
        }),
      );
    });

    it('should return error on failure', async () => {
      (provider.createPullRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Merge conflict'),
      );

      const result = await manager.promoteBranch('main', 'staging');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROMOTION_FAILED');
    });

    it('should include branch names in the error message', async () => {
      (provider.createPullRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No commits between branches'),
      );

      const result = await manager.promoteBranch('staging', 'production');

      expect(result.success).toBe(false);
      expect(result.fromBranch).toBe('staging');
      expect(result.toBranch).toBe('production');
      expect(result.error?.message).toContain('staging');
      expect(result.error?.message).toContain('production');
    });

    it('should set commitSha to null since PR needs separate merge', async () => {
      const result = await manager.promoteBranch('main', 'staging');

      expect(result.success).toBe(true);
      expect(result.commitSha).toBeNull();
      expect(result.fromBranch).toBe('main');
      expect(result.toBranch).toBe('staging');
    });
  });

  describe('getBranchStatus error resilience', () => {
    it('should default aheadBy/behindBy to 0 when getDiff throws', async () => {
      (provider.listCommits as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          sha: 'abc',
          message: 'test',
          author: { name: 'u', email: 'u@test.com' },
          date: new Date().toISOString(),
        },
      ]);
      (provider.getDiff as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('comparison failed'),
      );

      const status = await manager.getBranchStatus('staging');
      expect(status.exists).toBe(true);
      expect(status.aheadBy).toBe(0);
      expect(status.behindBy).toBe(0);
    });

    it('should rethrow non-404 errors from listCommits', async () => {
      (provider.listCommits as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('500 Internal Server Error'),
      );
      await expect(manager.getBranchStatus('staging')).rejects.toThrow('500 Internal Server Error');
    });
  });

  describe('getBranchStatus', () => {
    it('should return branch status with last commit', async () => {
      const status = await manager.getBranchStatus('main');

      expect(status.exists).toBe(true);
      expect(status.headSha).toBe('abc123');
      expect(status.lastCommit?.message).toBe('Initial commit');
    });

    it('should return exists: false for nonexistent branches', async () => {
      (provider.listCommits as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('GitHub API error: 404'),
      );

      const status = await manager.getBranchStatus('nonexistent');

      expect(status.exists).toBe(false);
      expect(status.headSha).toBeNull();
    });

    it('should compare non-main branches with main', async () => {
      (provider.getDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
        files: [{ path: 'agents/a.agent.abl', content: '...' }],
        commitSha: 'abc',
        branch: '',
      });

      const status = await manager.getBranchStatus('staging');

      expect(provider.getDiff).toHaveBeenCalledWith('main', 'staging');
      expect(status.aheadBy).toBe(1);
    });

    it('should not call getDiff for main branch', async () => {
      const status = await manager.getBranchStatus('main');

      expect(status.exists).toBe(true);
      expect(status.aheadBy).toBe(0);
      expect(status.behindBy).toBe(0);
      expect(provider.getDiff).not.toHaveBeenCalled();
    });

    it('should return exists true with null headSha when branch has no commits', async () => {
      (provider.listCommits as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const status = await manager.getBranchStatus('staging');

      expect(status.exists).toBe(true);
      expect(status.headSha).toBeNull();
      expect(status.lastCommit).toBeNull();
      expect(status.aheadBy).toBe(0);
      expect(status.behindBy).toBe(0);
    });

    it('should use commit counts from getDiff when available', async () => {
      (provider.getDiff as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          files: [{ path: 'a.abl', content: '' }],
          commitSha: 'abc',
          branch: '',
          commits: [{ sha: 'c1' }, { sha: 'c2' }, { sha: 'c3' }],
        })
        .mockResolvedValueOnce({
          files: [{ path: 'b.abl', content: '' }],
          commitSha: 'abc',
          branch: '',
          commits: [{ sha: 'c4' }],
        });

      const status = await manager.getBranchStatus('staging');

      expect(status.aheadBy).toBe(3);
      expect(status.behindBy).toBe(1);
    });

    it('should handle getDiff failure gracefully with zero ahead/behind', async () => {
      (provider.getDiff as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('No common ancestor'),
      );

      const status = await manager.getBranchStatus('staging');

      expect(status.exists).toBe(true);
      expect(status.aheadBy).toBe(0);
      expect(status.behindBy).toBe(0);
    });

    it('should rethrow non-404 errors from listCommits', async () => {
      (provider.listCommits as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Internal server error 500'),
      );

      await expect(manager.getBranchStatus('staging')).rejects.toThrow('Internal server error 500');
    });
  });

  describe('listBranches', () => {
    it('should list environment branches that exist', async () => {
      const result = await manager.listBranches();

      expect(result.branches.length).toBe(3);
      expect(result.branches.every((b) => b.isEnvironment)).toBe(true);
      expect(result.branches.map((b) => b.name)).toContain('main');
      expect(result.branches.map((b) => b.name)).toContain('staging');
      expect(result.branches.map((b) => b.name)).toContain('production');
    });

    it('should skip branches that do not exist', async () => {
      let callCount = 0;
      (provider.listCommits as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error('404'));
        return Promise.resolve([
          { sha: 'abc', message: 'test', author: { name: 'T', email: 'e' }, date: '' },
        ]);
      });

      const result = await manager.listBranches();

      // One of the 3 environment branches failed
      expect(result.branches.length).toBe(2);
    });
  });
});
