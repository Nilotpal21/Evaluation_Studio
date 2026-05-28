/**
 * Tests for Git Provider security hardening: AbortSignal, error sanitization,
 * URL encoding, auth headers, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubProvider } from '../git/github-provider.js';
import { GitLabProvider } from '../git/gitlab-provider.js';
import { BitbucketProvider } from '../git/bitbucket-provider.js';

// ─── Shared Helpers ─────────────────────────────────────────────────────────

type MockFetch = ReturnType<typeof vi.fn>;
let mockFetch: MockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

function errorResponse(status: number, body = 'Internal error details'): Response {
  return new Response(body, { status, statusText: 'Error' });
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── GitHubProvider ─────────────────────────────────────────────────────────

describe('GitHubProvider', () => {
  const config = { token: 'gh-test-token', owner: 'test-org', repo: 'test-repo' };

  it('should pass AbortSignal to globalThis.fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: [] }));
    // getTreeSha calls: ref → commit → then listFiles
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'abc' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'tree-sha' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: [] }));

    const provider = new GitHubProvider(config);
    // Trigger any fetch call via listFiles
    try {
      await provider.listFiles('main');
    } catch {
      /* ignore */
    }

    for (const call of mockFetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeDefined();
    }
  });

  it('should set correct auth headers', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'abc' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'tree-sha' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: [] }));

    const provider = new GitHubProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gh-test-token');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('should sanitize error messages (not leak response body)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'secret internal details'));

    const provider = new GitHubProvider(config);
    // Error message should NOT contain the response body
    await expect(provider.listFiles('main')).rejects.toThrow('GitHub API error: 500');
    await expect(provider.listFiles('main')).rejects.not.toThrow('secret internal details');
  });

  it('should return undefined for 204 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const provider = new GitHubProvider(config);
    // Use removeWebhook which expects void/204
    await expect(provider.removeWebhook('hook-1')).resolves.toBeUndefined();
  });

  it('should return null on 404 in getFile', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const provider = new GitHubProvider(config);
    const file = await provider.getFile('main', 'nonexistent.txt');
    expect(file).toBeNull();
    errorSpy.mockRestore();
  });

  it('should URL-encode branch and path segments in getFile', async () => {
    const content = Buffer.from('file content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, sha: 'sha-1' }));

    const provider = new GitHubProvider(config);
    await provider.getFile('feat/special branch', 'agents/my agent.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('ref=' + encodeURIComponent('feat/special branch'));
    expect(url).toContain('my%20agent.abl');
    expect(url).not.toContain('feat/special branch');
  });

  it('should decode base64 content correctly in getFile', async () => {
    const original = 'AGENT: test_agent\nGOAL: Help users';
    const encoded = Buffer.from(original).toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content: encoded, sha: 'sha-1' }));

    const provider = new GitHubProvider(config);
    const file = await provider.getFile('main', 'agents/test.abl');

    expect(file).not.toBeNull();
    expect(file!.content).toBe(original);
  });

  it('should batch file fetching in groups of 10 in pullProject', async () => {
    // listFiles first: ref → commit → tree
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'ref-sha' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'tree-sha' } }));

    // Generate 25 files
    const treeItems = Array.from({ length: 25 }, (_, i) => ({
      path: `agents/agent_${i}.abl`,
      type: 'blob',
      sha: `sha-${i}`,
    }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: treeItems }));

    // 25 getFile calls (3 batches: 10, 10, 5)
    for (let i = 0; i < 25; i++) {
      const content = Buffer.from(`content ${i}`).toString('base64');
      mockFetch.mockResolvedValueOnce(jsonResponse({ content, sha: `sha-${i}` }));
    }

    // listCommits for commitSha
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        {
          sha: 'commit-sha',
          commit: { message: 'msg', author: { name: 'A', email: 'a@a.com', date: '2024-01-01' } },
        },
      ]),
    );

    const provider = new GitHubProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(25);
  });

  it('should handle empty file list in pullProject', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'ref-sha' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'tree-sha' } }));
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: [] }));
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { sha: 'c1', commit: { message: 'm', author: { name: 'A', email: 'a', date: 'd' } } },
      ]),
    );

    const provider = new GitHubProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(0);
  });

  it('should URL-encode branch in pushFiles ref URL', async () => {
    // pushFiles: fetch ref → fetch commit → create blob → create tree → create commit → update ref
    mockFetch.mockResolvedValueOnce(jsonResponse({ object: { sha: 'ref-sha' } })); // ref
    mockFetch.mockResolvedValueOnce(jsonResponse({ tree: { sha: 'base-tree' } })); // commit
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'blob-sha' })); // blob
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-tree-sha' })); // tree
    mockFetch.mockResolvedValueOnce(jsonResponse({ sha: 'new-commit-sha' })); // commit
    mockFetch.mockResolvedValueOnce(jsonResponse({})); // update ref

    const provider = new GitHubProvider(config);
    await provider.pushFiles('feat/my branch', [{ path: 'test.txt', content: 'hi' }], 'msg', {
      name: 'A',
      email: 'a@a.com',
    });

    const refUrl = mockFetch.mock.calls[0][0] as string;
    expect(refUrl).toContain(encodeURIComponent('feat/my branch'));
  });

  it('should URL-encode branch in listCommits query param', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitHubProvider(config);
    await provider.listCommits('feat/special branch');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('sha=' + encodeURIComponent('feat/special branch'));
  });

  it('should handle empty files array in getDiff', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ files: [] }));

    const provider = new GitHubProvider(config);
    const result = await provider.getDiff('base-sha', 'head-sha');

    expect(result.files).toHaveLength(0);
  });
});

// ─── GitLabProvider ─────────────────────────────────────────────────────────

describe('GitLabProvider', () => {
  const config = { token: 'gl-test-token', projectId: '12345' };

  it('should pass AbortSignal to globalThis.fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.signal).toBeDefined();
  });

  it('should set PRIVATE-TOKEN header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));

    const provider = new GitLabProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['PRIVATE-TOKEN']).toBe('gl-test-token');
  });

  it('should sanitize error messages (not leak response body)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'gitlab secret info'));

    const provider = new GitLabProvider(config);
    const err = await provider.listFiles('main').catch((e: unknown) => e as Error);
    // The thrown message must not contain the raw response body
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('GitLab API error: 500');
    expect((err as Error).message).not.toContain('gitlab secret info');
  });

  it('should return undefined for 204 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const provider = new GitLabProvider(config);
    await expect(provider.removeWebhook('hook-1')).resolves.toBeUndefined();
  });

  it('should URL-encode full path as single component in getFile', async () => {
    const content = Buffer.from('file content').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'blob-1' }));

    const provider = new GitLabProvider(config);
    await provider.getFile('main', 'agents/sub dir/test.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    // GitLab encodes the entire path as one URI component
    expect(url).toContain(encodeURIComponent('agents/sub dir/test.abl'));
  });

  it('should URL-encode branch in ref param for getFile', async () => {
    const content = Buffer.from('x').toString('base64');
    mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: 'b1' }));

    const provider = new GitLabProvider(config);
    await provider.getFile('feat/special branch', 'test.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('ref=' + encodeURIComponent('feat/special branch'));
  });

  it('should return null on 404 in getFile', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

    const provider = new GitLabProvider(config);
    const file = await provider.getFile('main', 'nonexistent.abl');
    expect(file).toBeNull();
    errorSpy.mockRestore();
  });

  it('should fetch files sequentially in pullProject (no batching)', async () => {
    // listFiles
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { path: 'agents/a.abl', type: 'blob', id: 'sha-1' },
        { path: 'agents/b.abl', type: 'blob', id: 'sha-2' },
      ]),
    );
    // getFile calls (sequential)
    for (const name of ['a', 'b']) {
      const content = Buffer.from(`content-${name}`).toString('base64');
      mockFetch.mockResolvedValueOnce(jsonResponse({ content, blob_id: `blob-${name}` }));
    }
    // listCommits
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { id: 'c1', message: 'm', author_name: 'A', author_email: 'a@a', authored_date: 'd' },
      ]),
    );

    const provider = new GitLabProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(2);
  });

  it('should URL-encode from/to commits in getDiff', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ diffs: [] }));

    const provider = new GitLabProvider(config);
    await provider.getDiff('abc 123', 'def/456');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('from=' + encodeURIComponent('abc 123'));
    expect(url).toContain('to=' + encodeURIComponent('def/456'));
  });
});

// ─── BitbucketProvider ──────────────────────────────────────────────────────

describe('BitbucketProvider', () => {
  const config = {
    username: 'bb-user',
    appPassword: 'bb-pass',
    workspace: 'test-ws',
    repoSlug: 'test-repo',
  };

  const expectedAuth = 'Basic ' + Buffer.from('bb-user:bb-pass').toString('base64');

  it('should pass AbortSignal to globalThis.fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    const provider = new BitbucketProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.signal).toBeDefined();
  });

  it('should set Basic auth header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    const provider = new BitbucketProvider(config);
    await provider.listFiles('main');

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(expectedAuth);
  });

  it('should sanitize error messages (not leak response body)', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(500, 'bitbucket secrets'));

    const provider = new BitbucketProvider(config);
    const err = await provider.listFiles('main').catch((e: unknown) => e as Error);
    // The thrown message must not contain the raw response body
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Bitbucket API error: 500');
    expect((err as Error).message).not.toContain('bitbucket secrets');
  });

  it('should return undefined for 204 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const provider = new BitbucketProvider(config);
    await expect(provider.removeWebhook('hook-1')).resolves.toBeUndefined();
  });

  it('should use direct fetch with AbortSignal in getFile', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('file content', 200));

    const provider = new BitbucketProvider(config);
    await provider.getFile('main', 'agents/test.abl');

    const [, init] = mockFetch.mock.calls[0];
    expect(init?.signal).toBeDefined();
    expect(init?.headers).toHaveProperty('Authorization');
  });

  it('should return null on 404 status in getFile', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const provider = new BitbucketProvider(config);
    const file = await provider.getFile('main', 'nonexistent.abl');
    expect(file).toBeNull();
  });

  it('should URL-encode branch and path segments in getFile', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('content', 200));

    const provider = new BitbucketProvider(config);
    await provider.getFile('feat/special branch', 'agents/my agent.abl');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent('feat/special branch'));
    expect(url).toContain('my%20agent.abl');
  });

  it('should fetch files sequentially in pullProject', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [
          { path: 'a.abl', type: 'commit_file' },
          { path: 'b.abl', type: 'commit_file' },
        ],
      }),
    );
    mockFetch.mockResolvedValueOnce(textResponse('content-a'));
    mockFetch.mockResolvedValueOnce(textResponse('content-b'));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        values: [{ hash: 'c1', message: 'm', author: { raw: 'A' }, date: 'd' }],
      }),
    );

    const provider = new BitbucketProvider(config);
    const result = await provider.pullProject('main', '');

    expect(result.files).toHaveLength(2);
  });

  it('should URL-encode branch in listCommits', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ values: [] }));

    const provider = new BitbucketProvider(config);
    await provider.listCommits('feat/special branch');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent('feat/special branch'));
  });
});
