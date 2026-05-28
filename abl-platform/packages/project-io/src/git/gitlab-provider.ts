/**
 * GitLab Provider — implements GitProvider using GitLab REST API
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
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('gitlab-provider');

export interface GitLabProviderConfig {
  token: string;
  projectId: string;
  apiBaseUrl?: string;
}

// ─── GitLab API response shapes ─────────────────────────────────────────

interface GitLabCommitEntry {
  id: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_date: string;
}

interface GitLabFileResponse {
  content: string;
  blob_id: string;
}

interface GitLabCommitResponse {
  id: string;
}

interface GitLabBranchResponse {
  commit: { id: string };
}

interface GitLabMRResponse {
  id: number;
  web_url: string;
  iid: number;
}

interface GitLabWebhookResponse {
  id: number;
}

interface GitLabCompareResponse {
  compare_timeout?: boolean;
  diffs?: Array<{ deleted_file: boolean; new_path: string }>;
}

const DEFAULT_API_BASE = 'https://gitlab.com/api/v4';
const GIT_API_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 10_000;
const FILE_FETCH_BATCH_SIZE = 10;
const EXISTENCE_CHECK_BATCH_SIZE = 10;

export class GitLabProvider implements GitProvider {
  readonly providerName = 'gitlab';
  private readonly config: GitLabProviderConfig;
  private readonly apiBase: string;

  constructor(config: GitLabProviderConfig) {
    this.config = config;
    this.apiBase = config.apiBaseUrl ?? DEFAULT_API_BASE;
  }

  async validateConnection(): Promise<ConnectionValidationResult> {
    const encodedProject = encodeURIComponent(this.config.projectId);
    const url = `${this.apiBase}/projects/${encodedProject}`;
    try {
      const response = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        headers: {
          'PRIVATE-TOKEN': this.config.token,
        },
      });
      if (response.ok) return { valid: true };
      const body = await response.text();
      log.debug('validateConnection failed', { status: response.status, body });
      return { valid: false, error: `GitLab API returned ${response.status}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: message };
    }
  }

  async listFiles(branch: string, path?: string): Promise<GitFile[]> {
    const allItems: GitFile[] = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        ref: branch,
        recursive: 'true',
        per_page: '100',
        page: String(page),
      });
      if (path) params.set('path', path);
      const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/tree?${params}`;

      let response: Response;
      try {
        response = await this.fetchRaw(url);
      } catch (error: unknown) {
        // GitLab 17.7+: 404 for non-existent paths — return empty array
        if (error instanceof Error && error.message.includes('404')) {
          return [];
        }
        throw error;
      }

      const data = (await response.json()) as Array<Record<string, string>>;

      const files = data
        .filter((item) => item.type === 'blob')
        .map((item) => ({
          path: item.path,
          content: '',
          sha: item.id,
        }));

      allItems.push(...files);

      const nextPage = response.headers.get('x-next-page');
      if (!nextPage || nextPage === '') {
        break;
      }
      page = Number(nextPage);
    }

    return allItems;
  }

  async getFile(branch: string, path: string): Promise<GitFile | null> {
    const encodedPath = encodeURIComponent(path);
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/files/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    try {
      const response = await this.fetch<GitLabFileResponse>(url);
      const content = Buffer.from(response.content, 'base64').toString('utf-8');
      return { path, content, sha: response.blob_id };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('404')) return null;
      throw error;
    }
  }

  async pullProject(branch: string, syncPath?: string): Promise<PullResult> {
    const files = await this.listFiles(branch, syncPath || undefined);
    const fullFiles: GitFile[] = [];

    // Fetch files in parallel batches
    for (let i = 0; i < files.length; i += FILE_FETCH_BATCH_SIZE) {
      const batch = files.slice(i, i + FILE_FETCH_BATCH_SIZE);
      const results = await Promise.all(batch.map((f) => this.getFile(branch, f.path)));
      for (const full of results) {
        if (full) fullFiles.push(full);
      }
    }

    const commits = await this.listCommits(branch, 1);
    return { files: fullFiles, commitSha: commits[0]?.sha ?? '', branch };
  }

  async pushFiles(
    branch: string,
    files: GitFile[],
    commitMessage: string,
    committer: Committer,
    options?: PushFilesOptions,
  ): Promise<PushResult> {
    // Determine create vs update for each file by checking existence in batches
    const fileActions = await this.resolveFileActions(branch, files);

    const actions: Array<{
      action: 'create' | 'update' | 'delete';
      file_path: string;
      content?: string;
    }> = files.map((f, i) => ({
      action: fileActions[i],
      file_path: f.path,
      content: f.content,
    }));
    for (const deletedPath of options?.deletedPaths ?? []) {
      actions.push({
        action: 'delete',
        file_path: deletedPath,
      });
    }

    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/commits`;
    const response = await this.fetch<GitLabCommitResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        branch,
        commit_message: commitMessage,
        actions,
        author_name: committer.name,
        author_email: committer.email,
      }),
    });

    return {
      commitSha: response.id,
      branch,
      url: `${this.apiBase.replace('/api/v4', '')}/${this.config.projectId}/-/commit/${response.id}`,
    };
  }

  async createBranch(name: string, fromBranch: string): Promise<GitBranch> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/branches`;
    const response = await this.fetch<GitLabBranchResponse>(url, {
      method: 'POST',
      body: JSON.stringify({ branch: name, ref: fromBranch }),
    });
    return { name, sha: response.commit.id };
  }

  async createPullRequest(params: PRParams): Promise<CreatePRResult> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/merge_requests`;
    const response = await this.fetch<GitLabMRResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        description: params.description,
        source_branch: params.sourceBranch,
        target_branch: params.targetBranch,
      }),
    });
    return { id: response.id, url: response.web_url, number: response.iid };
  }

  async listCommits(branch: string, limit: number = 10): Promise<GitCommit[]> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`;
    const response = await this.fetch<GitLabCommitEntry[]>(url);
    return response.map((c) => ({
      sha: c.id,
      message: c.message,
      author: { name: c.author_name, email: c.author_email },
      date: c.authored_date,
    }));
  }

  async registerWebhook(callbackUrl: string, secret: string): Promise<string> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/hooks`;
    const response = await this.fetch<GitLabWebhookResponse>(url, {
      method: 'POST',
      body: JSON.stringify({ url: callbackUrl, token: secret, push_events: true }),
    });
    return String(response.id);
  }

  async removeWebhook(webhookId: string): Promise<void> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/hooks/${webhookId}`;
    await this.fetch<void>(url, { method: 'DELETE' });
  }

  async getDiff(baseCommit: string, headCommit: string): Promise<PullResult> {
    const url = `${this.apiBase}/projects/${encodeURIComponent(this.config.projectId)}/repository/compare?from=${encodeURIComponent(baseCommit)}&to=${encodeURIComponent(headCommit)}`;
    const response = await this.fetch<GitLabCompareResponse>(url);

    if (response.compare_timeout) {
      log.warn('GitLab compare timed out — diffs may be incomplete', {
        baseCommit,
        headCommit,
      });
    }

    const files: GitFile[] = [];
    for (const diff of response.diffs ?? []) {
      if (diff.deleted_file) continue;
      const full = await this.getFile(headCommit, diff.new_path);
      if (full) files.push(full);
    }

    return { files, commitSha: headCommit, branch: '' };
  }

  /**
   * Resolve whether each file needs a 'create' or 'update' action.
   * Checks file existence in parallel batches.
   */
  private async resolveFileActions(
    branch: string,
    files: GitFile[],
  ): Promise<Array<'create' | 'update'>> {
    const actions: Array<'create' | 'update'> = new Array(files.length);

    for (let i = 0; i < files.length; i += EXISTENCE_CHECK_BATCH_SIZE) {
      const batch = files.slice(i, i + EXISTENCE_CHECK_BATCH_SIZE);
      const results = await Promise.all(batch.map((f) => this.getFile(branch, f.path)));
      for (let j = 0; j < results.length; j++) {
        actions[i + j] = results[j] === null ? 'create' : 'update';
      }
    }

    return actions;
  }

  /**
   * Fetch and return raw Response object (for pagination header access).
   */
  private async fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
      headers: {
        'PRIVATE-TOKEN': this.config.token,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      log.error('API error', { status: response.status, body });
      throw new Error(`GitLab API error: ${response.status}`);
    }
    return response;
  }

  private async fetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchRaw(url, init);
    if (response.status === 204) return undefined as unknown as T;
    return response.json() as Promise<T>;
  }
}
