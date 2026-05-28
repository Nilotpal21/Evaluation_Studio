/**
 * Git Provider Factory — creates the right GitProvider based on integration config
 *
 * Takes an IGitIntegration-shaped config + a resolved access token and returns
 * the appropriate provider instance. The caller is responsible for resolving
 * the configured auth profile to a provider token before calling this factory.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import type { GitProvider } from './git-provider.js';
import { GitHubProvider } from './github-provider.js';
import { GitLabProvider } from './gitlab-provider.js';
import { BitbucketProvider } from './bitbucket-provider.js';
import { GenericGitProvider } from './generic-git-provider.js';

const log = createLogger('git-provider-factory');

// ─── Types ──────────────────────────────────────────────────────────────

export interface GitIntegrationConfig {
  provider: 'github' | 'gitlab' | 'bitbucket' | 'generic';
  repositoryUrl: string;
}

export interface ResolvedCredentials {
  token: string;
  /** Bitbucket-only: username for legacy app-password auth (deprecated June 2026) */
  username?: string;
  /** Bitbucket-only: email for API token auth (replaces app passwords) */
  email?: string;
}

interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

interface ParsedGitLabRepo {
  projectPath: string;
}

interface ParsedBitbucketRepo {
  workspace: string;
  repoSlug: string;
}

// ─── URL Parsers ────────────────────────────────────────────────────────

/**
 * Parse a GitHub repository URL into owner and repo.
 * Supports: https://github.com/owner/repo(.git)
 */
export function parseGitHubUrl(repositoryUrl: string): ParsedGitHubRepo {
  const url = repositoryUrl.replace(/\.git$/, '');
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error(`Cannot parse GitHub repository URL: ${repositoryUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Parse a GitLab repository URL into a project path.
 * Supports: https://gitlab.com/group/subgroup/project(.git)
 */
export function parseGitLabUrl(repositoryUrl: string): ParsedGitLabRepo {
  const url = repositoryUrl.replace(/\.git$/, '');
  const match = url.match(/gitlab\.com[/:](.+)/);
  if (!match) {
    throw new Error(`Cannot parse GitLab repository URL: ${repositoryUrl}`);
  }
  return { projectPath: match[1] };
}

/**
 * Parse a Bitbucket repository URL into workspace and repo slug.
 * Supports: https://bitbucket.org/workspace/repo(.git)
 */
export function parseBitbucketUrl(repositoryUrl: string): ParsedBitbucketRepo {
  const url = repositoryUrl.replace(/\.git$/, '');
  const match = url.match(/bitbucket\.org[/:]([^/]+)\/([^/]+)/);
  if (!match) {
    throw new Error(`Cannot parse Bitbucket repository URL: ${repositoryUrl}`);
  }
  return { workspace: match[1], repoSlug: match[2] };
}

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Create a GitProvider instance from an integration config and resolved credentials.
 *
 * @param integration - The git integration config (provider type + repository URL)
 * @param credentials - The resolved credentials (token, optional username for Bitbucket)
 * @returns A GitProvider instance ready to use
 */
export function createGitProvider(
  integration: GitIntegrationConfig,
  credentials: ResolvedCredentials,
): GitProvider {
  const { provider, repositoryUrl } = integration;

  log.info('Creating git provider', { provider });

  switch (provider) {
    case 'github': {
      const { owner, repo } = parseGitHubUrl(repositoryUrl);
      return new GitHubProvider({ token: credentials.token, owner, repo });
    }

    case 'gitlab': {
      const { projectPath } = parseGitLabUrl(repositoryUrl);
      return new GitLabProvider({ token: credentials.token, projectId: projectPath });
    }

    case 'bitbucket': {
      const { workspace, repoSlug } = parseBitbucketUrl(repositoryUrl);
      if (credentials.email) {
        // Atlassian API token auth (replaces app passwords)
        return new BitbucketProvider({
          authMode: 'api_token',
          email: credentials.email,
          apiToken: credentials.token,
          workspace,
          repoSlug,
        });
      }
      if (credentials.username) {
        // Legacy app-password auth (deprecated — removal June 2026)
        return new BitbucketProvider({
          authMode: 'basic',
          username: credentials.username,
          appPassword: credentials.token,
          workspace,
          repoSlug,
        });
      }
      // Repository/Workspace Access Token (Bearer auth)
      return new BitbucketProvider({
        authMode: 'token',
        token: credentials.token,
        workspace,
        repoSlug,
      });
    }

    case 'generic': {
      return new GenericGitProvider({
        repositoryUrl,
        username: credentials.username,
        password: credentials.token,
      });
    }

    default: {
      const exhaustive: never = provider;
      throw new Error(`Unsupported git provider: ${exhaustive}`);
    }
  }
}
