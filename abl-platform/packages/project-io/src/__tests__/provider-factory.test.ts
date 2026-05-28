/**
 * Tests for Git Provider Factory — URL parsing and provider creation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createGitProvider,
  parseGitHubUrl,
  parseGitLabUrl,
  parseBitbucketUrl,
} from '../git/provider-factory.js';
import * as GitHubModule from '../git/github-provider.js';
import * as GitLabModule from '../git/gitlab-provider.js';
import * as BitbucketModule from '../git/bitbucket-provider.js';
import * as GenericModule from '../git/generic-git-provider.js';

// ─── URL Parsing ────────────────────────────────────────────────────────────

describe('parseGitHubUrl', () => {
  it('parses HTTPS URL', () => {
    expect(parseGitHubUrl('https://github.com/acme/my-repo')).toEqual({
      owner: 'acme',
      repo: 'my-repo',
    });
  });

  it('strips .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/acme/my-repo.git')).toEqual({
      owner: 'acme',
      repo: 'my-repo',
    });
  });

  it('parses SSH-style URL', () => {
    expect(parseGitHubUrl('git@github.com:acme/my-repo.git')).toEqual({
      owner: 'acme',
      repo: 'my-repo',
    });
  });

  it('throws on invalid URL', () => {
    expect(() => parseGitHubUrl('https://example.com/foo')).toThrow('Cannot parse GitHub');
  });
});

describe('parseGitLabUrl', () => {
  it('parses simple project URL', () => {
    expect(parseGitLabUrl('https://gitlab.com/acme/my-project')).toEqual({
      projectPath: 'acme/my-project',
    });
  });

  it('parses nested group URL', () => {
    expect(parseGitLabUrl('https://gitlab.com/acme/subgroup/project.git')).toEqual({
      projectPath: 'acme/subgroup/project',
    });
  });

  it('throws on invalid URL', () => {
    expect(() => parseGitLabUrl('https://github.com/acme/foo')).toThrow('Cannot parse GitLab');
  });
});

describe('parseBitbucketUrl', () => {
  it('parses HTTPS URL', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/workspace/my-repo')).toEqual({
      workspace: 'workspace',
      repoSlug: 'my-repo',
    });
  });

  it('strips .git suffix', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo.git')).toEqual({
      workspace: 'ws',
      repoSlug: 'repo',
    });
  });

  it('throws on invalid URL', () => {
    expect(() => parseBitbucketUrl('https://example.com/foo')).toThrow('Cannot parse Bitbucket');
  });
});

// ─── Factory ────────────────────────────────────────────────────────────────

describe('createGitProvider', () => {
  it('creates GitHub provider from URL', () => {
    const spy = vi.spyOn(GitHubModule, 'GitHubProvider');
    const provider = createGitProvider(
      { provider: 'github', repositoryUrl: 'https://github.com/acme/repo' },
      { token: 'ghp_test123' },
    );
    expect(provider.providerName).toBe('github');
    expect(spy).toHaveBeenCalledWith({ token: 'ghp_test123', owner: 'acme', repo: 'repo' });
    spy.mockRestore();
  });

  it('creates GitLab provider from URL', () => {
    const spy = vi.spyOn(GitLabModule, 'GitLabProvider');
    const provider = createGitProvider(
      { provider: 'gitlab', repositoryUrl: 'https://gitlab.com/acme/project' },
      { token: 'glpat-test123' },
    );
    expect(provider.providerName).toBe('gitlab');
    expect(spy).toHaveBeenCalledWith({ token: 'glpat-test123', projectId: 'acme/project' });
    spy.mockRestore();
  });

  it('creates generic provider from URL', () => {
    const spy = vi.spyOn(GenericModule, 'GenericGitProvider');
    const provider = createGitProvider(
      { provider: 'generic', repositoryUrl: 'https://git.internal.com/repo.git' },
      { token: 'secret' },
    );
    expect(provider.providerName).toBe('generic');
    expect(spy).toHaveBeenCalledWith({
      repositoryUrl: 'https://git.internal.com/repo.git',
      username: undefined,
      password: 'secret',
    });
    spy.mockRestore();
  });

  it('creates Bitbucket provider with token auth (no username)', () => {
    const spy = vi.spyOn(BitbucketModule, 'BitbucketProvider');
    const provider = createGitProvider(
      { provider: 'bitbucket', repositoryUrl: 'https://bitbucket.org/ws/repo' },
      { token: 'bb_api_token_123' },
    );
    expect(provider.providerName).toBe('bitbucket');
    expect(spy).toHaveBeenCalledWith({
      authMode: 'token',
      token: 'bb_api_token_123',
      workspace: 'ws',
      repoSlug: 'repo',
    });
    spy.mockRestore();
  });

  it('creates Bitbucket provider with legacy app-password auth', () => {
    const spy = vi.spyOn(BitbucketModule, 'BitbucketProvider');
    const provider = createGitProvider(
      { provider: 'bitbucket', repositoryUrl: 'https://bitbucket.org/ws/repo' },
      { token: 'app-password', username: 'user' },
    );
    expect(provider.providerName).toBe('bitbucket');
    expect(spy).toHaveBeenCalledWith({
      authMode: 'basic',
      username: 'user',
      appPassword: 'app-password',
      workspace: 'ws',
      repoSlug: 'repo',
    });
    spy.mockRestore();
  });

  it('creates Bitbucket provider with API token auth (email)', () => {
    const spy = vi.spyOn(BitbucketModule, 'BitbucketProvider');
    const provider = createGitProvider(
      { provider: 'bitbucket', repositoryUrl: 'https://bitbucket.org/ws/repo' },
      { token: 'api-token-value', email: 'user@example.com' },
    );
    expect(provider.providerName).toBe('bitbucket');
    expect(spy).toHaveBeenCalledWith({
      authMode: 'api_token',
      email: 'user@example.com',
      apiToken: 'api-token-value',
      workspace: 'ws',
      repoSlug: 'repo',
    });
    spy.mockRestore();
  });

  it('prefers API token auth over legacy app-password when both email and username provided', () => {
    const spy = vi.spyOn(BitbucketModule, 'BitbucketProvider');
    const provider = createGitProvider(
      { provider: 'bitbucket', repositoryUrl: 'https://bitbucket.org/ws/repo' },
      { token: 'token', email: 'user@example.com', username: 'user' },
    );
    expect(provider.providerName).toBe('bitbucket');
    expect(spy).toHaveBeenCalledWith({
      authMode: 'api_token',
      email: 'user@example.com',
      apiToken: 'token',
      workspace: 'ws',
      repoSlug: 'repo',
    });
    spy.mockRestore();
  });

  it('throws for invalid GitHub URL', () => {
    expect(() =>
      createGitProvider(
        { provider: 'github', repositoryUrl: 'https://example.com/bad' },
        { token: 'test' },
      ),
    ).toThrow('Cannot parse GitHub');
  });
});
