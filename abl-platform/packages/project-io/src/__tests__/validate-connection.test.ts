/**
 * Tests for validateConnection() across all git providers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => mockLog,
}));

import { GitHubProvider } from '../git/github-provider.js';
import { GitLabProvider } from '../git/gitlab-provider.js';
import { BitbucketProvider } from '../git/bitbucket-provider.js';
import { GenericGitProvider } from '../git/generic-git-provider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type MockFetch = ReturnType<typeof vi.fn>;
let mockFetch: MockFetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  vi.clearAllMocks();
});

// ─── GitHub ──────────────────────────────────────────────────────────────────

describe('GitHubProvider.validateConnection', () => {
  const provider = new GitHubProvider({ token: 'gh-token', owner: 'org', repo: 'repo' });

  it('returns valid when API responds 200', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1, full_name: 'org/repo' }));
    const result = await provider.validateConnection();
    expect(result).toEqual({ valid: true });
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://api.github.com/repos/org/repo');
  });

  it('returns invalid on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns invalid on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('404');
  });

  it('returns invalid on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network unreachable'));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Network unreachable');
  });
});

// ─── GitLab ──────────────────────────────────────────────────────────────────

describe('GitLabProvider.validateConnection', () => {
  const provider = new GitLabProvider({ token: 'gl-token', projectId: 'group/project' });

  it('returns valid when API responds 200', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 42 }));
    const result = await provider.validateConnection();
    expect(result).toEqual({ valid: true });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://gitlab.com/api/v4/projects/group%2Fproject');
  });

  it('returns invalid on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns invalid on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});

// ─── Bitbucket ───────────────────────────────────────────────────────────────

describe('BitbucketProvider.validateConnection', () => {
  const provider = new BitbucketProvider({
    authMode: 'token',
    token: 'bb-token',
    workspace: 'ws',
    repoSlug: 'repo',
  });

  it('returns valid when API responds 200', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ slug: 'repo' }));
    const result = await provider.validateConnection();
    expect(result).toEqual({ valid: true });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/ws/repo');
  });

  it('returns invalid on 403', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('403');
  });

  it('returns invalid on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toBe('timeout');
  });
});

// ─── Generic ─────────────────────────────────────────────────────────────────

describe('GenericGitProvider.validateConnection', () => {
  const provider = new GenericGitProvider({
    repositoryUrl: 'https://git.example.com/repo.git',
  });

  it('always returns valid', async () => {
    const result = await provider.validateConnection();
    expect(result).toEqual({ valid: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
