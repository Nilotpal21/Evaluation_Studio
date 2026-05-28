/**
 * Git Provider Interface — abstract interface for git operations
 *
 * All provider implementations (GitHub, GitLab, Bitbucket, generic)
 * implement this interface.
 */

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

export interface ConnectionValidationResult {
  valid: boolean;
  error?: string;
}

export interface GitProvider {
  readonly providerName: string;

  /** Validate that the credentials and repository URL are correct. */
  validateConnection(): Promise<ConnectionValidationResult>;

  listFiles(branch: string, path?: string): Promise<GitFile[]>;

  getFile(branch: string, path: string): Promise<GitFile | null>;

  pullProject(branch: string, syncPath?: string): Promise<PullResult>;

  pushFiles(
    branch: string,
    files: GitFile[],
    commitMessage: string,
    committer: Committer,
    options?: PushFilesOptions,
  ): Promise<PushResult>;

  createBranch(name: string, fromBranch: string): Promise<GitBranch>;

  createPullRequest(params: PRParams): Promise<CreatePRResult>;

  listCommits(branch: string, limit?: number): Promise<GitCommit[]>;

  registerWebhook(callbackUrl: string, secret: string): Promise<string>;

  removeWebhook(webhookId: string): Promise<void>;

  getDiff(baseCommit: string, headCommit: string): Promise<PullResult>;
}
