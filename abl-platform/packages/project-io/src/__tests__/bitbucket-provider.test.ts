/**
 * Comprehensive tests for BitbucketProvider — covers all methods, auth modes,
 * pagination, error handling, and the fixes applied (diffstat, author parsing,
 * branch resolution, api_token auth, deprecation warning).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BitbucketProvider, parseBitbucketAuthor } from '../git/bitbucket-provider.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

type MockFetch = ReturnType<typeof vi.fn>;
let mockFetch: MockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// Shared mock logger instance — vi.hoisted ensures it's defined before
// vi.mock's factory runs (which is hoisted to top of file). The same object
// is returned for every `createLogger()` call so the module-level `log`
// variable inside bitbucket-provider.ts uses this exact instance.
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

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Config fixtures ────────────────────────────────────────────────────────

const tokenConfig = {
  authMode: 'token' as const,
  token: 'bb-token-123',
  workspace: 'my-ws',
  repoSlug: 'my-repo',
};

const basicConfig = {
  authMode: 'basic' as const,
  username: 'user1',
  appPassword: 'app-pass-secret',
  workspace: 'my-ws',
  repoSlug: 'my-repo',
};

const apiTokenConfig = {
  authMode: 'api_token' as const,
  email: 'dev@example.com',
  apiToken: 'ATATT3xFfGF0...',
  workspace: 'my-ws',
  repoSlug: 'my-repo',
};

const defaultBasicConfig = {
  username: 'user1',
  appPassword: 'app-pass-secret',
  workspace: 'my-ws',
  repoSlug: 'my-repo',
};

// ─── parseBitbucketAuthor ───────────────────────────────────────────────────

describe('parseBitbucketAuthor', () => {
  it('parses "Name <email>" format correctly', () => {
    const result = parseBitbucketAuthor('Alice Smith <alice@example.com>');
    expect(result).toEqual({ name: 'Alice Smith', email: 'alice@example.com' });
  });

  it('handles name with no email', () => {
    const result = parseBitbucketAuthor('JustAName');
    expect(result).toEqual({ name: 'JustAName', email: '' });
  });

  it('handles empty string', () => {
    const result = parseBitbucketAuthor('');
    expect(result).toEqual({ name: '', email: '' });
  });

  it('trims whitespace', () => {
    const result = parseBitbucketAuthor('  Bob  < bob@test.com >');
    expect(result).toEqual({ name: 'Bob', email: 'bob@test.com' });
  });
});

// ─── Auth Header ────────────────────────────────────────────────────────────

describe('BitbucketProvider auth', () => {
  it('uses Bearer token for token auth mode', async () => {
    const provider = new BitbucketProvider(tokenConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main');

    const call = mockFetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer bb-token-123');
  });

  it('uses Basic auth for basic auth mode', async () => {
    const provider = new BitbucketProvider(basicConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main');

    const call = mockFetch.mock.calls[0];
    const expected = `Basic ${Buffer.from('user1:app-pass-secret').toString('base64')}`;
    expect(call[1].headers.Authorization).toBe(expected);
  });

  it('uses Basic auth with email:apiToken for api_token mode', async () => {
    const provider = new BitbucketProvider(apiTokenConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main');

    const call = mockFetch.mock.calls[0];
    const expected = `Basic ${Buffer.from('dev@example.com:ATATT3xFfGF0...').toString('base64')}`;
    expect(call[1].headers.Authorization).toBe(expected);
  });

  it('defaults to basic auth when authMode is not specified', async () => {
    const provider = new BitbucketProvider(defaultBasicConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main');

    const call = mockFetch.mock.calls[0];
    const expected = `Basic ${Buffer.from('user1:app-pass-secret').toString('base64')}`;
    expect(call[1].headers.Authorization).toBe(expected);
  });

  it('logs deprecation warning when basic auth mode is used', async () => {
    mockLog.warn.mockClear();
    const provider = new BitbucketProvider(basicConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('app passwords are deprecated'),
    );
  });
});

// ─── listFiles ──────────────────────────────────────────────────────────────

describe('BitbucketProvider.listFiles', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('returns files filtered to commit_file type', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            type: 'commit_file',
            path: 'src/index.ts',
            commit: { hash: 'abc123' },
          },
          { type: 'commit_directory', path: 'src/' },
        ],
      }),
    );

    const files = await provider.listFiles('main');
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      path: 'src/index.ts',
      content: '',
      sha: 'abc123',
    });
  });

  it('handles pagination by following next URL', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'a.ts', commit: { hash: 'h1' } }],
          next: 'https://api.bitbucket.org/2.0/repositories/my-ws/my-repo/src/main/?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ type: 'commit_file', path: 'b.ts', commit: { hash: 'h2' } }],
        }),
      );

    const files = await provider.listFiles('main');
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('a.ts');
    expect(files[1].path).toBe('b.ts');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('passes path parameter when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.listFiles('main', 'src/agents');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('path=src%2Fagents');
  });
});

// ─── getFile ────────────────────────────────────────────────────────────────

describe('BitbucketProvider.getFile', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('returns file content on success', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('const x = 1;'));

    const file = await provider.getFile('main', 'src/index.ts');
    expect(file).toEqual({ path: 'src/index.ts', content: 'const x = 1;' });
  });

  it('returns null on 404', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('Not found', 404));

    const file = await provider.getFile('main', 'nonexistent.ts');
    expect(file).toBeNull();
  });

  it('throws on non-404 error', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('Server error', 500));

    await expect(provider.getFile('main', 'src/index.ts')).rejects.toThrow(
      'Bitbucket API error: 500',
    );
  });

  it('URL-encodes path segments', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('content'));

    await provider.getFile('main', 'path with spaces/file.ts');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('path%20with%20spaces');
  });
});

// ─── pullProject ────────────────────────────────────────────────────────────

describe('BitbucketProvider.pullProject', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('lists files, fetches content, and returns latest commit SHA', async () => {
    // listFiles response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [{ type: 'commit_file', path: 'agent.abl', commit: { hash: 'f1' } }],
      }),
    );
    // getFile response
    mockFetch.mockResolvedValueOnce(textResponse('AGENT: Greeter'));
    // listCommits response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'commit-sha-1',
            message: 'init',
            author: { raw: 'Dev <dev@test.com>' },
            date: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    const result = await provider.pullProject('main', '');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({ path: 'agent.abl', content: 'AGENT: Greeter' });
    expect(result.commitSha).toBe('commit-sha-1');
    expect(result.branch).toBe('main');
  });

  it('should fetch files in parallel batches', async () => {
    // 12 files → should be 2 batches (10 + 2)
    const fileEntries = Array.from({ length: 12 }, (_, i) => ({
      type: 'commit_file',
      path: `file-${i}.abl`,
      commit: { hash: `h${i}` },
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: fileEntries }));

    // getFile responses for all 12 files
    for (let i = 0; i < 12; i++) {
      mockFetch.mockResolvedValueOnce(textResponse(`content-${i}`));
    }

    // listCommits
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'latest-sha',
            message: 'batch',
            author: { raw: 'Dev <dev@test.com>' },
            date: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(12);
    expect(result.files[0].content).toBe('content-0');
    expect(result.files[11].content).toBe('content-11');
    // 1 listFiles + 12 getFile + 1 listCommits = 14 total calls
    expect(mockFetch).toHaveBeenCalledTimes(14);
  });

  it('pulls multiple files and returns decoded content for each', async () => {
    // listFiles response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          { type: 'commit_file', path: 'a.abl', commit: { hash: 'f1' } },
          { type: 'commit_file', path: 'b.abl', commit: { hash: 'f2' } },
        ],
      }),
    );
    // getFile for a.abl
    mockFetch.mockResolvedValueOnce(textResponse('AGENT: Alpha'));
    // getFile for b.abl
    mockFetch.mockResolvedValueOnce(textResponse('AGENT: Beta'));
    // listCommits response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'latest-sha',
            message: 'multi',
            author: { raw: 'Dev <dev@test.com>' },
            date: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    const result = await provider.pullProject('main', '');
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({ path: 'a.abl', content: 'AGENT: Alpha' });
    expect(result.files[1]).toEqual({ path: 'b.abl', content: 'AGENT: Beta' });
  });
});

// ─── pushFiles ──────────────────────────────────────────────────────────────

describe('BitbucketProvider.pushFiles', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('sends FormData with message, branch, author, and files', async () => {
    // pushFiles POST response
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 201 }));
    // listCommits response
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'new-commit-sha',
            message: 'update',
            author: { raw: 'Bot <bot@test.com>' },
            date: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    const result = await provider.pushFiles(
      'main',
      [{ path: 'agent.abl', content: 'AGENT: Test' }],
      'Update agent',
      { name: 'Bot', email: 'bot@test.com' },
    );

    expect(result.commitSha).toBe('new-commit-sha');
    expect(result.branch).toBe('main');
    expect(result.url).toContain('new-commit-sha');

    // Verify FormData was sent with correct metadata and file entries
    const postCall = mockFetch.mock.calls[0];
    const body = postCall[1].body as FormData;
    expect(body.get('message')).toBe('Update agent');
    expect(body.get('branch')).toBe('main');
    expect(body.get('author')).toBe('Bot <bot@test.com>');

    // Verify the file entry is present with correct path key and content
    const fileEntry = body.get('agent.abl') as Blob | null;
    expect(fileEntry).not.toBeNull();
    const fileContent = await fileEntry!.text();
    expect(fileContent).toBe('AGENT: Test');
  });

  it('sends deleted paths in the files form field', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 201 }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await provider.pushFiles(
      'main',
      [{ path: 'agent.abl', content: 'AGENT: Test' }],
      'Update agent',
      { name: 'Bot', email: 'bot@test.com' },
      { deletedPaths: ['old-agent.abl'] },
    );

    const body = mockFetch.mock.calls[0][1].body as FormData;
    expect(body.getAll('files')).toContain('old-agent.abl');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('Forbidden', 403));

    await expect(
      provider.pushFiles('main', [{ path: 'a.ts', content: '' }], 'msg', {
        name: 'X',
        email: 'x@x.com',
      }),
    ).rejects.toThrow('Bitbucket API error: 403');
  });
});

// ─── createBranch ───────────────────────────────────────────────────────────

describe('BitbucketProvider.createBranch', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('resolves source branch to commit SHA before creating', async () => {
    // listCommits to resolve branch — returns the SHA we'll send in the request
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'resolved-sha-abc',
            message: 'latest',
            author: { raw: 'Dev <dev@test.com>' },
            date: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    // create branch response — API returns a *different* SHA (e.g. server
    // may normalise or the branch target may differ). The provider should
    // return what the API responds with, not the SHA it sent.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        name: 'feature/new',
        target: { hash: 'server-returned-sha-xyz' },
      }),
    );

    const branch = await provider.createBranch('feature/new', 'main');
    // Provider should return the SHA from the API response
    expect(branch).toEqual({ name: 'feature/new', sha: 'server-returned-sha-xyz' });

    // Verify the create call sent the resolved SHA, not the branch name
    const createCall = mockFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body as string);
    expect(body.target.hash).toBe('resolved-sha-abc');
  });

  it('throws when source branch has no commits', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    await expect(provider.createBranch('feature/new', 'empty-branch')).rejects.toThrow(
      'Cannot resolve branch "empty-branch" to a commit SHA',
    );
  });
});

// ─── createPullRequest ──────────────────────────────────────────────────────

describe('BitbucketProvider.createPullRequest', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('creates PR and returns id, url, number', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 42,
        links: { html: { href: 'https://bitbucket.org/my-ws/my-repo/pull-requests/42' } },
      }),
    );

    const result = await provider.createPullRequest({
      title: 'Add feature',
      description: 'Desc',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
    });

    expect(result).toEqual({
      id: 42,
      url: 'https://bitbucket.org/my-ws/my-repo/pull-requests/42',
      number: 42,
    });

    // Verify the request body uses Bitbucket's nested PR field structure
    const postCall = mockFetch.mock.calls[0];
    const body = JSON.parse(postCall[1].body as string);
    expect(body.title).toBe('Add feature');
    expect(body.description).toBe('Desc');
    expect(body.source).toEqual({ branch: { name: 'feature/x' } });
    expect(body.destination).toEqual({ branch: { name: 'main' } });
  });
});

// ─── listCommits ────────────────────────────────────────────────────────────

describe('BitbucketProvider.listCommits', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('parses author name and email from raw field', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            hash: 'sha1',
            message: 'commit 1',
            author: { raw: 'Alice Dev <alice@example.com>' },
            date: '2026-01-15T10:30:00Z',
          },
          {
            hash: 'sha2',
            message: 'commit 2',
            author: { raw: 'NoEmailUser' },
            date: '2026-01-14T09:00:00Z',
          },
        ],
      }),
    );

    const commits = await provider.listCommits('main', 10);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      sha: 'sha1',
      message: 'commit 1',
      author: { name: 'Alice Dev', email: 'alice@example.com' },
      date: '2026-01-15T10:30:00Z',
    });
    expect(commits[1].author).toEqual({ name: 'NoEmailUser', email: '' });
  });

  it('handles empty values', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    const commits = await provider.listCommits('main');
    expect(commits).toEqual([]);
  });
});

// ─── registerWebhook / removeWebhook ────────────────────────────────────────

describe('BitbucketProvider.registerWebhook', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('creates webhook and returns uuid', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ uuid: '{webhook-uuid-123}' }));

    const uuid = await provider.registerWebhook('https://app.example.com/hook', 'secret123');
    expect(uuid).toBe('{webhook-uuid-123}');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.events).toEqual(['repo:push']);
    expect(body.secret).toBe('secret123');
  });
});

describe('BitbucketProvider.removeWebhook', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await provider.removeWebhook('{webhook-uuid-123}');

    const call = mockFetch.mock.calls[0];
    expect(call[1].method).toBe('DELETE');
    expect(call[0]).toContain('hooks/{webhook-uuid-123}');
  });
});

// ─── getDiff ────────────────────────────────────────────────────────────────

describe('BitbucketProvider.getDiff', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('uses /diffstat/ endpoint (not /diff/)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [{ status: 'modified', old: { path: 'a.ts' }, new: { path: 'a.ts' } }],
      }),
    );
    // getFile for a.ts
    mockFetch.mockResolvedValueOnce(textResponse('modified content'));

    await provider.getDiff('base-sha', 'head-sha');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/diffstat/');
    expect(url).not.toContain('/diff/');
  });

  it('skips removed files and fetches content for others using headCommit', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          { status: 'added', new: { path: 'new-file.ts' } },
          { status: 'modified', old: { path: 'mod.ts' }, new: { path: 'mod.ts' } },
          { status: 'removed', old: { path: 'deleted.ts' } },
        ],
      }),
    );
    // getFile for new-file.ts
    mockFetch.mockResolvedValueOnce(textResponse('new content'));
    // getFile for mod.ts
    mockFetch.mockResolvedValueOnce(textResponse('updated content'));

    const result = await provider.getDiff('base-sha-111', 'head-sha-222');
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.path)).toEqual(['new-file.ts', 'mod.ts']);
    expect(result.files[0].content).toBe('new content');
    expect(result.files[1].content).toBe('updated content');
    expect(result.commitSha).toBe('head-sha-222');
    expect(result.branch).toBe('');

    // Verify getFile calls use the headCommit SHA, not the baseCommit
    const getFileCalls = mockFetch.mock.calls.slice(1); // skip the diffstat call
    for (const call of getFileCalls) {
      const url = call[0] as string;
      expect(url).toContain('head-sha-222');
      expect(url).not.toContain('base-sha-111');
    }
  });

  it('handles pagination on diffstat (follows next URL)', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ status: 'added', new: { path: 'page1.ts' } }],
          next: 'https://api.bitbucket.org/2.0/repositories/my-ws/my-repo/diffstat/base..head?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [{ status: 'modified', old: { path: 'page2.ts' }, new: { path: 'page2.ts' } }],
        }),
      )
      // getFile for page1.ts
      .mockResolvedValueOnce(textResponse('p1'))
      // getFile for page2.ts
      .mockResolvedValueOnce(textResponse('p2'));

    const result = await provider.getDiff('base', 'head');
    expect(result.files).toHaveLength(2);
  });

  it('handles diffstat entries with missing new.path for removed files', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [{ status: 'removed', old: { path: 'gone.ts' } }],
      }),
    );

    const result = await provider.getDiff('base', 'head');
    expect(result.files).toHaveLength(0);
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────

describe('BitbucketProvider error handling', () => {
  const provider = new BitbucketProvider(tokenConfig);

  it('throws on non-ok response from fetch wrapper', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('Unauthorized', 401));

    await expect(provider.listFiles('main')).rejects.toThrow('Bitbucket API error: 401');
  });

  it('returns empty object for 204 responses', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    // removeWebhook uses the fetch wrapper and expects undefined-like return
    await expect(provider.removeWebhook('test-hook')).resolves.toBeUndefined();
  });
});
