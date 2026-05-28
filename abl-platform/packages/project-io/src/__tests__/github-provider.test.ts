/**
 * Comprehensive tests for GitHubProvider — covers all methods,
 * error handling, pagination, truncation warnings, and parallel batching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => mockLog,
}));
vi.mock('@abl/compiler/platform/logger.js', () => ({
  createLogger: () => mockLog,
}));

import { GitHubProvider } from '../git/github-provider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type MockFetch = ReturnType<typeof vi.fn>;
let mockFetch: MockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

const CONFIG = { token: 'gh-test-token', owner: 'test-org', repo: 'test-repo' };

/** Mock the two-call sequence for getTreeSha (ref → commit) */
function mockTreeSha(treeSha = 'tree-sha-123', commitSha = 'commit-abc') {
  mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: commitSha } }));
  mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: treeSha } }));
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── listFiles ────────────────────────────────────────────────────────────────

describe('GitHubProvider.listFiles', () => {
  it('should return blob entries from tree', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        truncated: false,
        tree: [
          { path: 'src/index.ts', type: 'blob', sha: 'blob-1' },
          { path: 'src', type: 'tree', sha: 'tree-1' },
          { path: 'src/utils.ts', type: 'blob', sha: 'blob-2' },
        ],
      }),
    );

    const provider = new GitHubProvider(CONFIG);
    const files = await provider.listFiles('main');

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: 'src/index.ts', content: '', sha: 'blob-1' });
    expect(files[1]).toEqual({ path: 'src/utils.ts', content: '', sha: 'blob-2' });
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should filter by path prefix', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        truncated: false,
        tree: [
          { path: 'src/index.ts', type: 'blob', sha: 'blob-1' },
          { path: 'docs/readme.md', type: 'blob', sha: 'blob-2' },
        ],
      }),
    );

    const provider = new GitHubProvider(CONFIG);
    const files = await provider.listFiles('main', 'src/');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/index.ts');
  });

  it('should log warning when tree response is truncated', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        truncated: true,
        tree: [{ path: 'a.ts', type: 'blob', sha: 'b1' }],
      }),
    );

    const provider = new GitHubProvider(CONFIG);
    await provider.listFiles('main');

    expect(mockLog.warn).toHaveBeenCalledWith(
      'Tree response truncated — repo may have >100k entries',
      { branch: 'main' },
    );
  });

  it('should not log warning when truncated is false', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const provider = new GitHubProvider(CONFIG);
    await provider.listFiles('main');

    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});

// ─── getFile ──────────────────────────────────────────────────────────────────

describe('GitHubProvider.getFile', () => {
  it('should decode base64 content', async () => {
    const b64 = Buffer.from('hello world').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64, sha: 'file-sha' }));

    const provider = new GitHubProvider(CONFIG);
    const file = await provider.getFile('main', 'src/index.ts');

    expect(file).toEqual({ path: 'src/index.ts', content: 'hello world', sha: 'file-sha' });
  });

  it('should return null on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    const provider = new GitHubProvider(CONFIG);
    const file = await provider.getFile('main', 'nonexistent.ts');

    expect(file).toBeNull();
  });

  it('should throw on non-404 errors', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Server error', { status: 500 }));

    const provider = new GitHubProvider(CONFIG);
    await expect(provider.getFile('main', 'file.ts')).rejects.toThrow('GitHub API error: 500');
  });

  it('should URL-encode path segments', async () => {
    const b64 = Buffer.from('content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64, sha: 'sha' }));

    const provider = new GitHubProvider(CONFIG);
    await provider.getFile('main', 'path/with spaces/file.ts');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('path/with%20spaces/file.ts');
  });
});

// ─── pullProject ──────────────────────────────────────────────────────────────

describe('GitHubProvider.pullProject', () => {
  it('should fetch files in batches and return pull result', async () => {
    // listFiles: getTreeSha (2 calls) + tree response
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        truncated: false,
        tree: [
          { path: 'a.ts', type: 'blob', sha: 's1' },
          { path: 'b.ts', type: 'blob', sha: 's2' },
        ],
      }),
    );

    // getFile for a.ts and b.ts (parallel batch)
    const b64a = Buffer.from('file-a').toString('base64');
    const b64b = Buffer.from('file-b').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64a, sha: 's1' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64b, sha: 's2' }));

    // listCommits
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          sha: 'latest-sha',
          commit: { message: 'msg', author: { name: 'A', email: 'a@b.c', date: '2026-01-01' } },
        },
      ]),
    );

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({ path: 'a.ts', content: 'file-a', sha: 's1' });
    expect(result.files[1]).toEqual({ path: 'b.ts', content: 'file-b', sha: 's2' });
    expect(result.commitSha).toBe('latest-sha');
    expect(result.branch).toBe('main');
  });
});

// ─── pushFiles ────────────────────────────────────────────────────────────────

describe('GitHubProvider.pushFiles', () => {
  it('should create blobs in parallel batches', async () => {
    // ref
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'base-commit' } }));
    // commit
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'base-tree' } }));

    // 12 files → should be 2 batches (10 + 2)
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: `content-${i}`,
      sha: '',
    }));

    // Blob responses: 12 total
    for (let i = 0; i < 12; i++) {
      mockFetch.mockResolvedValueOnce(jsonResponse({ sha: `blob-sha-${i}` }));
    }

    // Create tree
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-tree-sha' }));
    // Create commit
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-commit-sha' }));
    // Update ref
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'new-commit-sha' } }));

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.pushFiles('main', files, 'test commit', {
      name: 'Test',
      email: 'test@test.com',
    });

    expect(result.commitSha).toBe('new-commit-sha');
    expect(result.branch).toBe('main');
    expect(result.url).toContain('new-commit-sha');

    // Verify blob creation calls used POST
    // calls: ref(GET), commit(GET), 12 blobs(POST), tree(POST), commit(POST), ref(PATCH)
    const blobCalls = mockFetch.mock.calls.slice(2, 14);
    for (const call of blobCalls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(call[0]).toContain('/git/blobs');
    }

    // Verify tree creation request includes correct file paths and blob SHAs
    const treeCall = mockFetch.mock.calls[14]; // tree creation call
    expect(treeCall[0]).toContain('/git/trees');
    const treeBody = JSON.parse(treeCall[1].body as string);
    expect(treeBody.base_tree).toBe('base-tree');
    expect(treeBody.tree).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      expect(treeBody.tree[i]).toEqual({
        path: `file-${i}.ts`,
        mode: '100644',
        type: 'blob',
        sha: `blob-sha-${i}`,
      });
    }
  });

  it('should handle single file push', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'base-commit' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'base-tree' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'blob-sha' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-tree' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-commit' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'new-commit' } }));

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.pushFiles(
      'main',
      [{ path: 'file.ts', content: 'hello', sha: '' }],
      'msg',
      { name: 'A', email: 'a@b.c' },
    );

    expect(result.commitSha).toBe('new-commit');
  });

  it('should include delete entries when deletedPaths are provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'base-commit' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'base-tree' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'blob-sha' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-tree' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-commit' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'new-commit' } }));

    const provider = new GitHubProvider(CONFIG);
    await provider.pushFiles(
      'main',
      [{ path: 'file.ts', content: 'hello', sha: '' }],
      'msg',
      { name: 'A', email: 'a@b.c' },
      { deletedPaths: ['old.ts'] },
    );

    const treeBody = JSON.parse(mockFetch.mock.calls[3][1].body as string);
    expect(treeBody.tree).toContainEqual({
      path: 'old.ts',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
  });
});

// ─── createBranch ─────────────────────────────────────────────────────────────

describe('GitHubProvider.createBranch', () => {
  it('should return the SHA resolved from the source branch ref', async () => {
    // The ref lookup returns the source branch SHA
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'source-sha' } }));
    // The ref creation response returns a different object — provider should use source ref SHA
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ref: 'refs/heads/feature', object: { sha: 'created-ref-sha' } }),
    );

    const provider = new GitHubProvider(CONFIG);
    const branch = await provider.createBranch('feature', 'main');

    // The provider returns the SHA from the source ref lookup, not the creation response
    expect(branch).toEqual({ name: 'feature', sha: 'source-sha' });

    const createCall = mockFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body as string);
    expect(body.ref).toBe('refs/heads/feature');
    expect(body.sha).toBe('source-sha');
  });
});

// ─── createPullRequest ────────────────────────────────────────────────────────

describe('GitHubProvider.createPullRequest', () => {
  it('should create a PR and return result', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 42, html_url: 'https://github.com/pulls/42', number: 42 }),
    );

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.createPullRequest({
      title: 'Test PR',
      description: 'Description',
      sourceBranch: 'feature',
      targetBranch: 'main',
    });

    expect(result).toEqual({ id: 42, url: 'https://github.com/pulls/42', number: 42 });

    // Verify the request body uses correct GitHub API field names
    const createCall = mockFetch.mock.calls[0];
    const body = JSON.parse(createCall[1].body as string);
    expect(body).toEqual({
      title: 'Test PR',
      body: 'Description',
      head: 'feature',
      base: 'main',
    });
  });
});

// ─── listCommits ──────────────────────────────────────────────────────────────

describe('GitHubProvider.listCommits', () => {
  it('should return mapped commits', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          sha: 'c1',
          commit: { message: 'first', author: { name: 'A', email: 'a@b.c', date: '2026-01-01' } },
        },
        {
          sha: 'c2',
          commit: { message: 'second', author: { name: 'B', email: 'b@c.d', date: '2026-01-02' } },
        },
      ]),
    );

    const provider = new GitHubProvider(CONFIG);
    const commits = await provider.listCommits('main', 10);

    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe('c1');
    expect(commits[1].author.name).toBe('B');
  });

  it('should clamp limit > 100 and log warning', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitHubProvider(CONFIG);
    await provider.listCommits('main', 200);

    expect(mockLog.warn).toHaveBeenCalledWith(
      'listCommits limit exceeds GitHub maximum of 100, clamping',
      { requested: 200 },
    );

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('per_page=100');
    expect(calledUrl).not.toContain('per_page=200');
  });

  it('should not clamp limit <= 100', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitHubProvider(CONFIG);
    await provider.listCommits('main', 50);

    expect(mockLog.warn).not.toHaveBeenCalled();
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('per_page=50');
  });
});

// ─── registerWebhook / removeWebhook ──────────────────────────────────────────

describe('GitHubProvider.registerWebhook', () => {
  it('should register and return webhook id', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 999 }));

    const provider = new GitHubProvider(CONFIG);
    const id = await provider.registerWebhook('https://example.com/hook', 'secret123');

    expect(id).toBe('999');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.config.url).toBe('https://example.com/hook');
    expect(body.config.secret).toBe('secret123');
    expect(body.events).toEqual(['push']);
  });
});

describe('GitHubProvider.removeWebhook', () => {
  it('should call DELETE on webhook endpoint', async () => {
    mockFetch.mockResolvedValueOnce(noContentResponse());

    const provider = new GitHubProvider(CONFIG);
    await provider.removeWebhook('999');

    expect(mockFetch.mock.calls[0][0]).toContain('/hooks/999');
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  });
});

// ─── getDiff ──────────────────────────────────────────────────────────────────

describe('GitHubProvider.getDiff', () => {
  it('should fetch changed files and skip removed ones', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        files: [
          { filename: 'added.ts', status: 'added' },
          { filename: 'removed.ts', status: 'removed' },
          { filename: 'modified.ts', status: 'modified' },
        ],
      }),
    );

    // getFile for added.ts
    const b64a = Buffer.from('added-content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64a, sha: 'sa' }));
    // getFile for modified.ts
    const b64m = Buffer.from('modified-content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64m, sha: 'sm' }));

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.getDiff('base-sha', 'head-sha');

    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('added.ts');
    expect(result.files[1].path).toBe('modified.ts');
    expect(result.commitSha).toBe('head-sha');

    // Verify getFile calls use headCommit (head-sha), not baseCommit (base-sha)
    const getFileCalls = mockFetch.mock.calls.slice(1); // skip the compare call
    for (const call of getFileCalls) {
      const url = call[0] as string;
      expect(url).toContain('ref=head-sha');
      expect(url).not.toContain('ref=base-sha');
    }
  });

  it('should include per_page=100 in URL', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const provider = new GitHubProvider(CONFIG);
    await provider.getDiff('a', 'b');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('per_page=100');
  });

  it('should fall back to Trees API when 300+ files returned (truncation)', async () => {
    const manyFiles = Array.from({ length: 300 }, (_, i) => ({
      filename: `file-${i}.ts`,
      status: 'modified',
    }));
    // Compare endpoint returns 300 files (truncated)
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: manyFiles }));

    // Trees API fallback: base tree and head tree fetched in parallel
    const baseTree = [
      { path: 'unchanged.ts', type: 'blob', sha: 'same-sha' },
      { path: 'modified.ts', type: 'blob', sha: 'old-sha' },
      { path: 'deleted.ts', type: 'blob', sha: 'del-sha' },
    ];
    const headTree = [
      { path: 'unchanged.ts', type: 'blob', sha: 'same-sha' },
      { path: 'modified.ts', type: 'blob', sha: 'new-sha' },
      { path: 'added.ts', type: 'blob', sha: 'add-sha' },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: baseTree, truncated: false }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: headTree, truncated: false }));

    // getFile for modified.ts and added.ts (changed files)
    const b64m = Buffer.from('modified-content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64m, sha: 'new-sha' }));
    const b64a = Buffer.from('added-content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64a, sha: 'add-sha' }));

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.getDiff('base', 'head');

    expect(mockLog.warn).toHaveBeenCalledWith(
      'Compare API truncated at 300 files — falling back to Trees API',
      expect.objectContaining({ fileCount: 300 }),
    );

    // Should return only changed/added files, not unchanged or deleted
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.path).sort()).toEqual(['added.ts', 'modified.ts']);
    expect(result.commitSha).toBe('head');
  });

  it('should not log warning when fewer than 300 files', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ files: [{ filename: 'a.ts', status: 'added' }] }),
    );
    const b64 = Buffer.from('c').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: b64, sha: 's' }));

    const provider = new GitHubProvider(CONFIG);
    await provider.getDiff('base', 'head');

    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should handle empty files array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const provider = new GitHubProvider(CONFIG);
    const result = await provider.getDiff('a', 'b');

    expect(result.files).toHaveLength(0);
  });
});

// ─── Auth & Headers ───────────────────────────────────────────────────────────

describe('GitHubProvider auth and headers', () => {
  it('should set Bearer token authorization', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const provider = new GitHubProvider(CONFIG);
    await provider.listFiles('main');

    for (const call of mockFetch.mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer gh-test-token');
    }
  });

  it('should set X-GitHub-Api-Version header', async () => {
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const provider = new GitHubProvider(CONFIG);
    await provider.listFiles('main');

    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('should use custom apiBaseUrl when provided', async () => {
    const customConfig = { ...CONFIG, apiBaseUrl: 'https://github.example.com/api/v3' };
    mockTreeSha();
    mockFetch.mockResolvedValueOnce(jsonResponse({ truncated: false, tree: [] }));

    const provider = new GitHubProvider(customConfig);
    await provider.listFiles('main');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl.startsWith('https://github.example.com/api/v3')).toBe(true);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('GitHubProvider error handling', () => {
  it('should log error via createLogger on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad request body', { status: 400 }));

    const provider = new GitHubProvider(CONFIG);
    await expect(provider.listFiles('main')).rejects.toThrow('GitHub API error: 400');

    expect(mockLog.error).toHaveBeenCalledWith('API error', {
      status: 400,
      body: 'Bad request body',
    });
  });

  it('should not use console.error', async () => {
    const consoleSpy = vi.spyOn(console, 'error');
    mockFetch.mockResolvedValueOnce(new Response('err', { status: 500 }));

    const provider = new GitHubProvider(CONFIG);
    await expect(provider.listFiles('main')).rejects.toThrow();

    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should handle 204 responses returning undefined', async () => {
    mockFetch.mockResolvedValueOnce(noContentResponse());

    const provider = new GitHubProvider(CONFIG);
    await provider.removeWebhook('123');
    // Should not throw — 204 is handled gracefully
  });
});

// ─── providerName ─────────────────────────────────────────────────────────────

describe('GitHubProvider.providerName', () => {
  it('should be "github"', () => {
    const provider = new GitHubProvider(CONFIG);
    expect(provider.providerName).toBe('github');
  });
});
