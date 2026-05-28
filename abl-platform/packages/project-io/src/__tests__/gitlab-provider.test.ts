/**
 * Comprehensive tests for GitLabProvider — pagination, create vs update actions,
 * 404 handling, compare_timeout, auth headers, and all public methods.
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

import { GitLabProvider } from '../git/gitlab-provider.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

type MockFetch = ReturnType<typeof vi.fn>;
let mockFetch: MockFetch;

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, body = 'Internal error'): Response {
  return new Response(body, { status, statusText: 'Error' });
}

const config = { token: 'gl-test-token', projectId: '12345' };
const committer = { name: 'Test User', email: 'test@example.com' };

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  mockLog.warn.mockClear();
  mockLog.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── listFiles ──────────────────────────────────────────────────────────────

describe('GitLabProvider.listFiles', () => {
  it('should return files from a single page', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { path: 'agents/a.abl', type: 'blob', id: 'sha-a' },
        { path: 'agents/b.abl', type: 'blob', id: 'sha-b' },
        { path: 'agents/', type: 'tree', id: 'sha-dir' },
      ]),
    );

    const provider = new GitLabProvider(config);
    const files = await provider.listFiles('main');

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: 'agents/a.abl', content: '', sha: 'sha-a' });
    expect(files[1]).toEqual({ path: 'agents/b.abl', content: '', sha: 'sha-b' });

    // Verify recursive param is included in the URL
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('recursive=true');
  });

  it('should paginate using x-next-page header', async () => {
    // Page 1: has x-next-page: 2
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ path: 'agents/a.abl', type: 'blob', id: 'sha-1' }], 200, {
        'x-next-page': '2',
      }),
    );
    // Page 2: no x-next-page (last page)
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ path: 'agents/b.abl', type: 'blob', id: 'sha-2' }]),
    );

    const provider = new GitLabProvider(config);
    const files = await provider.listFiles('main');

    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('agents/a.abl');
    expect(files[1].path).toBe('agents/b.abl');

    // Verify page params
    const url1 = mockFetch.mock.calls[0][0] as string;
    expect(url1).toContain('page=1');
    const url2 = mockFetch.mock.calls[1][0] as string;
    expect(url2).toContain('page=2');
  });

  it('should stop pagination when x-next-page is empty string', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ path: 'a.abl', type: 'blob', id: 's1' }], 200, { 'x-next-page': '' }),
    );

    const provider = new GitLabProvider(config);
    const files = await provider.listFiles('main');

    expect(files).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should return empty array on 404 (GitLab 17.7+ behavior)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    const provider = new GitLabProvider(config);
    const files = await provider.listFiles('main', 'nonexistent/path');

    expect(files).toEqual([]);
  });

  it('should still throw on non-404 errors', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'Server error'));

    const provider = new GitLabProvider(config);
    await expect(provider.listFiles('main')).rejects.toThrow('GitLab API error: 500');
  });

  it('should pass path parameter when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main', 'agents/');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('path=agents%2F');
  });

  it('should encodeURIComponent the projectId in URL', async () => {
    const specialConfig = { token: 'gl-test-token', projectId: 'group/subgroup/project' };
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(specialConfig);
    await provider.listFiles('main');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(
      `/projects/${encodeURIComponent('group/subgroup/project')}/repository/tree`,
    );
    expect(url).not.toContain('group/subgroup/project/repository');
  });

  it('should filter out non-blob items', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { path: 'dir/', type: 'tree', id: 't1' },
        { path: 'file.abl', type: 'blob', id: 'b1' },
        { path: 'submodule', type: 'commit', id: 'c1' },
      ]),
    );

    const provider = new GitLabProvider(config);
    const files = await provider.listFiles('main');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('file.abl');
  });
});

// ─── getFile ────────────────────────────────────────────────────────────────

describe('GitLabProvider.getFile', () => {
  it('should decode base64 content', async () => {
    const original = 'AGENT: test\nGOAL: Help users';
    const encoded = Buffer.from(original).toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: encoded, blob_id: 'blob-1' }));

    const provider = new GitLabProvider(config);
    const file = await provider.getFile('main', 'agents/test.abl');

    expect(file).not.toBeNull();
    expect(file!.content).toBe(original);
    expect(file!.sha).toBe('blob-1');
    expect(file!.path).toBe('agents/test.abl');
  });

  it('should return null on 404', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    const provider = new GitLabProvider(config);
    const file = await provider.getFile('main', 'nonexistent.abl');

    expect(file).toBeNull();
  });

  it('should throw on non-404 errors', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

    const provider = new GitLabProvider(config);
    await expect(provider.getFile('main', 'test.abl')).rejects.toThrow('GitLab API error: 403');
  });

  it('should URL-encode path as single component', async () => {
    const content = Buffer.from('x').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'b1' }));

    const provider = new GitLabProvider(config);
    await provider.getFile('main', 'agents/sub dir/test.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent('agents/sub dir/test.abl'));
  });

  it('should URL-encode branch in ref param', async () => {
    const content = Buffer.from('x').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'b1' }));

    const provider = new GitLabProvider(config);
    await provider.getFile('feat/special branch', 'test.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('ref=' + encodeURIComponent('feat/special branch'));
  });
});

// ─── pushFiles ──────────────────────────────────────────────────────────────

describe('GitLabProvider.pushFiles', () => {
  it('should use create action for new files and update for existing', async () => {
    const provider = new GitLabProvider(config);

    // File existence checks: file1 exists (returns content), file2 does not (404)
    const existingContent = Buffer.from('existing').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: existingContent, blob_id: 'b1' }));
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    // Commit request
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'commit-sha-1' }));

    const result = await provider.pushFiles(
      'main',
      [
        { path: 'existing.abl', content: 'updated content' },
        { path: 'new-file.abl', content: 'new content' },
      ],
      'test commit',
      committer,
    );

    expect(result.commitSha).toBe('commit-sha-1');

    // Verify the commit request body
    const commitCall = mockFetch.mock.calls[2];
    const body = JSON.parse(commitCall[1].body as string);
    expect(body.actions).toHaveLength(2);
    expect(body.actions[0].action).toBe('update');
    expect(body.actions[0].file_path).toBe('existing.abl');
    expect(body.actions[1].action).toBe('create');
    expect(body.actions[1].file_path).toBe('new-file.abl');
  });

  it('should batch existence checks in groups of 10', async () => {
    const provider = new GitLabProvider(config);

    // Create 15 files — should result in 2 batches (10 + 5)
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `file-${i}.abl`,
      content: `content-${i}`,
    }));

    // All files are new (404 for each)
    for (let i = 0; i < 15; i++) {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    }

    // Commit response
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'commit-sha' }));

    await provider.pushFiles('main', files, 'batch test', committer);

    // 15 existence checks + 1 commit = 16 total calls
    expect(mockFetch).toHaveBeenCalledTimes(16);

    // Verify all actions are 'create'
    const commitCall = mockFetch.mock.calls[15];
    const body = JSON.parse(commitCall[1].body as string);
    expect(body.actions.every((a: { action: string }) => a.action === 'create')).toBe(true);
  });

  it('should include committer info in request', async () => {
    const provider = new GitLabProvider(config);

    // Single file, exists
    const content = Buffer.from('x').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'b1' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sha-1' }));

    await provider.pushFiles('main', [{ path: 'test.abl', content: 'hello' }], 'msg', committer);

    const commitCall = mockFetch.mock.calls[1];
    const body = JSON.parse(commitCall[1].body as string);
    expect(body.author_name).toBe('Test User');
    expect(body.author_email).toBe('test@example.com');
    expect(body.commit_message).toBe('msg');
    expect(body.branch).toBe('main');
  });

  it('should include delete actions when deletedPaths are provided', async () => {
    const provider = new GitLabProvider(config);

    const content = Buffer.from('x').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'b1' }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'sha-1' }));

    await provider.pushFiles('main', [{ path: 'test.abl', content: 'hello' }], 'msg', committer, {
      deletedPaths: ['old.abl'],
    });

    const commitCall = mockFetch.mock.calls[1];
    const body = JSON.parse(commitCall[1].body as string);
    expect(body.actions).toContainEqual({
      action: 'delete',
      file_path: 'old.abl',
    });
  });

  it('should return push result with commit URL', async () => {
    const provider = new GitLabProvider(config);

    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'abc123' }));

    const result = await provider.pushFiles(
      'develop',
      [{ path: 'new.abl', content: 'x' }],
      'msg',
      committer,
    );

    expect(result.commitSha).toBe('abc123');
    expect(result.branch).toBe('develop');
    expect(result.url).toContain('abc123');
  });
});

// ─── getDiff ────────────────────────────────────────────────────────────────

describe('GitLabProvider.getDiff', () => {
  it('should fetch diff and return files for non-deleted entries', async () => {
    // Compare response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        diffs: [
          { new_path: 'agents/a.abl', deleted_file: false },
          { new_path: 'agents/deleted.abl', deleted_file: true },
          { new_path: 'agents/b.abl', deleted_file: false },
        ],
      }),
    );
    // getFile for a.abl
    const contentA = Buffer.from('content-a').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: contentA, blob_id: 'ba' }));
    // getFile for b.abl
    const contentB = Buffer.from('content-b').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: contentB, blob_id: 'bb' }));

    const provider = new GitLabProvider(config);
    const result = await provider.getDiff('base-sha', 'head-sha');

    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('agents/a.abl');
    expect(result.files[0].content).toBe('content-a');
    expect(result.files[1].path).toBe('agents/b.abl');
    expect(result.files[1].content).toBe('content-b');
    expect(result.commitSha).toBe('head-sha');

    // Verify getFile calls use headCommit (not baseCommit) as the ref
    const fileCall1Url = mockFetch.mock.calls[1][0] as string;
    const fileCall2Url = mockFetch.mock.calls[2][0] as string;
    expect(fileCall1Url).toContain('ref=head-sha');
    expect(fileCall1Url).not.toContain('ref=base-sha');
    expect(fileCall2Url).toContain('ref=head-sha');
    expect(fileCall2Url).not.toContain('ref=base-sha');
  });

  it('should log a warning when compare_timeout is true', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        compare_timeout: true,
        diffs: [],
      }),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.getDiff('base', 'head');

    expect(result.files).toHaveLength(0);
    expect(result.commitSha).toBe('head');

    // Verify the warning was actually logged with relevant context
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('compare timed out'),
      expect.objectContaining({ baseCommit: 'base', headCommit: 'head' }),
    );
  });

  it('should not log a warning when compare_timeout is absent', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ diffs: [] }));

    const provider = new GitLabProvider(config);
    await provider.getDiff('base', 'head');

    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should handle empty diffs array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ diffs: [] }));

    const provider = new GitLabProvider(config);
    const result = await provider.getDiff('base', 'head');

    expect(result.files).toHaveLength(0);
  });

  it('should handle missing diffs field (null response)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const provider = new GitLabProvider(config);
    const result = await provider.getDiff('base', 'head');

    expect(result.files).toHaveLength(0);
  });

  it('should URL-encode from/to commits', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ diffs: [] }));

    const provider = new GitLabProvider(config);
    await provider.getDiff('abc 123', 'def/456');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('from=' + encodeURIComponent('abc 123'));
    expect(url).toContain('to=' + encodeURIComponent('def/456'));
  });
});

// ─── Auth and Headers ───────────────────────────────────────────────────────

describe('GitLabProvider auth headers', () => {
  it('should use PRIVATE-TOKEN header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('gl-test-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should pass AbortSignal to globalThis.fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.signal).toBeDefined();
  });
});

// ─── Error Handling ─────────────────────────────────────────────────────────

describe('GitLabProvider error handling', () => {
  it('should sanitize error messages (not leak response body)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'secret internal details'));

    const provider = new GitLabProvider(config);
    const err = await provider.listFiles('main').catch((e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('GitLab API error: 500');
    expect((err as Error).message).not.toContain('secret internal details');
  });

  it('should return undefined for 204 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const provider = new GitLabProvider(config);
    await expect(provider.removeWebhook('hook-1')).resolves.toBeUndefined();
  });
});

// ─── pullProject ────────────────────────────────────────────────────────────

describe('GitLabProvider.pullProject', () => {
  it('should list files and fetch each one', async () => {
    // listFiles (single page)
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { path: 'agents/a.abl', type: 'blob', id: 'sha-1' },
        { path: 'agents/b.abl', type: 'blob', id: 'sha-2' },
      ]),
    );
    // getFile calls
    for (const name of ['a', 'b']) {
      const content = Buffer.from(`content-${name}`).toString('base64');
      mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: `blob-${name}` }));
    }
    // listCommits
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'c1',
          message: 'msg',
          author_name: 'A',
          author_email: 'a@a',
          authored_date: '2024-01-01',
        },
      ]),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('agents/a.abl');
    expect(result.files[0].content).toBe('content-a');
    expect(result.files[1].path).toBe('agents/b.abl');
    expect(result.files[1].content).toBe('content-b');
    expect(result.commitSha).toBe('c1');
    expect(result.branch).toBe('main');
  });

  it('should fetch files in parallel batches', async () => {
    // 12 files → should be 2 batches (10 + 2)
    const fileEntries = Array.from({ length: 12 }, (_, i) => ({
      path: `agents/file-${i}.abl`,
      type: 'blob',
      id: `sha-${i}`,
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse(fileEntries));

    // getFile responses for all 12 files
    for (let i = 0; i < 12; i++) {
      const content = Buffer.from(`content-${i}`).toString('base64');
      mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: `blob-${i}` }));
    }

    // listCommits
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'c1',
          message: 'msg',
          author_name: 'A',
          author_email: 'a@a',
          authored_date: '2024-01-01',
        },
      ]),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(12);
    expect(result.files[0].content).toBe('content-0');
    expect(result.files[11].content).toBe('content-11');
    // 1 listFiles + 12 getFile + 1 listCommits = 14 total calls
    expect(mockFetch).toHaveBeenCalledTimes(14);
  });

  it('should handle empty file list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'c1',
          message: 'm',
          author_name: 'A',
          author_email: 'a@a',
          authored_date: 'd',
        },
      ]),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(0);
  });
});

// ─── createBranch ───────────────────────────────────────────────────────────

describe('GitLabProvider.createBranch', () => {
  it('should create a branch and return name and sha', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ commit: { id: 'branch-sha' } }));

    const provider = new GitLabProvider(config);
    const branch = await provider.createBranch('feature/new', 'main');

    expect(branch.name).toBe('feature/new');
    expect(branch.sha).toBe('branch-sha');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.branch).toBe('feature/new');
    expect(body.ref).toBe('main');
  });
});

// ─── createPullRequest ──────────────────────────────────────────────────────

describe('GitLabProvider.createPullRequest', () => {
  it('should create merge request and return result', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 42, web_url: 'https://gitlab.com/mr/42', iid: 7 }),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.createPullRequest({
      title: 'Test MR',
      description: 'Description',
      sourceBranch: 'feature',
      targetBranch: 'main',
    });

    expect(result.id).toBe(42);
    expect(result.url).toBe('https://gitlab.com/mr/42');
    expect(result.number).toBe(7);

    // Verify request body uses correct GitLab MR field names
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.source_branch).toBe('feature');
    expect(body.target_branch).toBe('main');
    expect(body.title).toBe('Test MR');
    expect(body.description).toBe('Description');
  });
});

// ─── listCommits ────────────────────────────────────────────────────────────

describe('GitLabProvider.listCommits', () => {
  it('should map GitLab commit format to GitCommit', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'sha-1',
          message: 'First commit',
          author_name: 'Author',
          author_email: 'author@test.com',
          authored_date: '2024-01-01T00:00:00Z',
        },
      ]),
    );

    const provider = new GitLabProvider(config);
    const commits = await provider.listCommits('main', 5);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({
      sha: 'sha-1',
      message: 'First commit',
      author: { name: 'Author', email: 'author@test.com' },
      date: '2024-01-01T00:00:00Z',
    });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('per_page=5');
  });
});

// ─── registerWebhook ────────────────────────────────────────────────────────

describe('GitLabProvider.registerWebhook', () => {
  it('should register webhook and return ID as string', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 99 }));

    const provider = new GitLabProvider(config);
    const id = await provider.registerWebhook('https://example.com/hook', 'secret');

    expect(id).toBe('99');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.url).toBe('https://example.com/hook');
    expect(body.token).toBe('secret');
    expect(body.push_events).toBe(true);
  });
});

// ─── removeWebhook ──────────────────────────────────────────────────────────

describe('GitLabProvider.removeWebhook', () => {
  it('should call DELETE on the webhook endpoint', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const provider = new GitLabProvider(config);
    await provider.removeWebhook('42');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/hooks/42');
    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
  });
});

// ─── Custom API base URL ────────────────────────────────────────────────────

describe('GitLabProvider custom API base', () => {
  it('should use custom apiBaseUrl when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const customConfig = {
      ...config,
      apiBaseUrl: 'https://gitlab.mycompany.com/api/v4',
    };
    const provider = new GitLabProvider(customConfig);
    await provider.listFiles('main');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://gitlab.mycompany.com/api/v4');
  });

  it('should default to gitlab.com API base', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://gitlab.com/api/v4');
  });
});
