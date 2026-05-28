/**
 * Generic Git Provider — stub for HTTPS clone-based operations
 *
 * Works with any git host via HTTPS. In a full implementation this would
 * use isomorphic-git for clone-based operations. For now, provides the
 * interface skeleton with appropriate error messages.
 */

import type { GitProvider, ConnectionValidationResult } from './git-provider.js';
import type {
  GitFile,
  Committer,
  PushFilesOptions,
  PullResult,
  PushResult,
  GitBranch,
  PRParams,
  CreatePRResult,
  GitCommit,
} from '../types.js';

export interface GenericGitProviderConfig {
  repositoryUrl: string;
  username?: string;
  password?: string;
}

export class GenericGitProvider implements GitProvider {
  readonly providerName = 'generic';
  private readonly config: GenericGitProviderConfig;

  constructor(config: GenericGitProviderConfig) {
    this.config = config;
  }

  async validateConnection(): Promise<ConnectionValidationResult> {
    // Generic provider cannot easily validate — assume valid
    return { valid: true };
  }

  async listFiles(_branch: string, _path?: string): Promise<GitFile[]> {
    throw new Error(
      `Generic git provider requires isomorphic-git for clone-based operations. ` +
        `Repository: ${this.config.repositoryUrl}`,
    );
  }

  async getFile(_branch: string, _path: string): Promise<GitFile | null> {
    throw new Error('Generic git provider: getFile requires isomorphic-git');
  }

  async pullProject(_branch: string, _syncPath: string): Promise<PullResult> {
    throw new Error('Generic git provider: pullProject requires isomorphic-git');
  }

  async pushFiles(
    _branch: string,
    _files: GitFile[],
    _commitMessage: string,
    _committer: Committer,
    _options?: PushFilesOptions,
  ): Promise<PushResult> {
    throw new Error('Generic git provider: pushFiles requires isomorphic-git');
  }

  async createBranch(_name: string, _fromBranch: string): Promise<GitBranch> {
    throw new Error('Generic git provider: createBranch requires isomorphic-git');
  }

  async createPullRequest(_params: PRParams): Promise<CreatePRResult> {
    throw new Error(
      'Generic git provider does not support pull requests. Use a platform-specific provider.',
    );
  }

  async listCommits(_branch: string, _limit?: number): Promise<GitCommit[]> {
    throw new Error('Generic git provider: listCommits requires isomorphic-git');
  }

  async registerWebhook(_callbackUrl: string, _secret: string): Promise<string> {
    throw new Error('Generic git provider does not support webhooks. Configure manually.');
  }

  async removeWebhook(_webhookId: string): Promise<void> {
    throw new Error('Generic git provider does not support webhook management.');
  }

  async getDiff(_baseCommit: string, _headCommit: string): Promise<PullResult> {
    throw new Error('Generic git provider: getDiff requires isomorphic-git');
  }
}
