/**
 * GitHub Provider — implements GitProvider using GitHub REST API
 *
 * Uses the Trees API for multi-file commits.
 * Requires OAuth app token or PAT with repo scope.
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

const log = createLogger('github-provider');

export interface GitHubProviderConfig {
  token: string;
  owner: string;
  repo: string;
  apiBaseUrl?: string;
}

// ─── GitHub API response shapes ─────────────────────────────────────────

interface GitHubCommitEntry {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
  };
}

interface GitHubRef {
  object: { sha: string };
}

interface GitHubCommitObject {
  sha: string;
  tree: { sha: string };
}

interface GitHubTreeResponse {
  sha: string;
  tree: Array<{ path: string; type: string; sha: string }>;
  truncated?: boolean;
}

interface GitHubBlob {
  sha: string;
}

interface GitHubFileContent {
  content: string;
  sha: string;
}

interface GitHubPRResponse {
  id: number;
  html_url: string;
  number: number;
}

interface GitHubWebhookResponse {
  id: number;
}

interface GitHubCompareResponse {
  files?: Array<{ filename: string; status: string }>;
}

const DEFAULT_API_BASE = 'https://api.github.com';
const GIT_API_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 10_000;
const FILE_FETCH_BATCH_SIZE = 10;

export class GitHubProvider implements GitProvider {
  readonly providerName = 'github';
  private readonly config: GitHubProviderConfig;
  private readonly apiBase: string;

  constructor(config: GitHubProviderConfig) {
    this.config = config;
    this.apiBase = config.apiBaseUrl ?? DEFAULT_API_BASE;
  }

  async validateConnection(): Promise<ConnectionValidationResult> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}`;
    try {
      const response = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.ok) return { valid: true };
      const body = await response.text();
      log.debug('validateConnection failed', { status: response.status, body });
      return { valid: false, error: `GitHub API returned ${response.status}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: message };
    }
  }

  async listFiles(branch: string, path?: string): Promise<GitFile[]> {
    const treeSha = await this.getTreeSha(branch);
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/trees/${treeSha}?recursive=1`;
    const response = await this.fetch<GitHubTreeResponse>(url);

    if (response.truncated) {
      log.warn('Tree response truncated — repo may have >100k entries', { branch });
    }

    const files: GitFile[] = [];
    for (const item of response.tree) {
      if (item.type !== 'blob') continue;
      if (path && !item.path.startsWith(path)) continue;

      files.push({
        path: item.path,
        content: '', // content loaded lazily
        sha: item.sha,
      });
    }
    return files;
  }

  async getFile(branch: string, path: string): Promise<GitFile | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
    try {
      const response = await this.fetch<GitHubFileContent>(url);
      const content = Buffer.from(response.content, 'base64').toString('utf-8');
      return { path, content, sha: response.sha };
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
    const commitSha = commits[0]?.sha ?? '';

    return { files: fullFiles, commitSha, branch };
  }

  async pushFiles(
    branch: string,
    files: GitFile[],
    commitMessage: string,
    committer: Committer,
    options?: PushFilesOptions,
  ): Promise<PushResult> {
    // Get current commit and tree
    const refUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/ref/heads/${encodeURIComponent(branch)}`;
    const ref = await this.fetch<GitHubRef>(refUrl);
    const baseCommitSha = ref.object.sha;

    const commitUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/commits/${baseCommitSha}`;
    const baseCommit = await this.fetch<GitHubCommitObject>(commitUrl);
    const baseTreeSha = baseCommit.tree.sha;

    // Create blobs in parallel batches
    const treeItems: { path: string; mode: string; type: string; sha: string | null }[] = [];
    const blobUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/blobs`;
    for (let i = 0; i < files.length; i += FILE_FETCH_BATCH_SIZE) {
      const batch = files.slice(i, i + FILE_FETCH_BATCH_SIZE);
      const blobs = await Promise.all(
        batch.map((file) =>
          this.fetch<GitHubBlob>(blobUrl, {
            method: 'POST',
            body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
          }),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        treeItems.push({
          path: batch[j].path,
          mode: '100644',
          type: 'blob',
          sha: blobs[j].sha,
        });
      }
    }
    for (const deletedPath of options?.deletedPaths ?? []) {
      treeItems.push({
        path: deletedPath,
        mode: '100644',
        type: 'blob',
        sha: null,
      });
    }

    // Create new tree
    const treeUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/trees`;
    const newTree = await this.fetch<GitHubTreeResponse>(treeUrl, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
    });

    // Create commit
    const newCommitUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/commits`;
    const newCommit = await this.fetch<GitHubCommitObject>(newCommitUrl, {
      method: 'POST',
      body: JSON.stringify({
        message: commitMessage,
        tree: newTree.sha,
        parents: [baseCommitSha],
        author: { name: committer.name, email: committer.email },
      }),
    });

    // Update ref
    await this.fetch<GitHubRef>(refUrl, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.sha }),
    });

    return {
      commitSha: newCommit.sha,
      branch,
      url: `https://github.com/${this.config.owner}/${this.config.repo}/commit/${newCommit.sha}`,
    };
  }

  async createBranch(name: string, fromBranch: string): Promise<GitBranch> {
    const refUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`;
    const ref = await this.fetch<GitHubRef>(refUrl);

    const createUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/refs`;
    await this.fetch<GitHubRef>(createUrl, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha: ref.object.sha }),
    });

    return { name, sha: ref.object.sha };
  }

  async createPullRequest(params: PRParams): Promise<CreatePRResult> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/pulls`;
    const response = await this.fetch<GitHubPRResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        body: params.description,
        head: params.sourceBranch,
        base: params.targetBranch,
      }),
    });

    return {
      id: response.id,
      url: response.html_url,
      number: response.number,
    };
  }

  async listCommits(branch: string, limit: number = 10): Promise<GitCommit[]> {
    const MAX_PER_PAGE = 100;
    if (limit > MAX_PER_PAGE) {
      log.warn('listCommits limit exceeds GitHub maximum of 100, clamping', { requested: limit });
      limit = MAX_PER_PAGE;
    }
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`;
    const response = await this.fetch<GitHubCommitEntry[]>(url);

    return response.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: {
        name: c.commit.author?.name ?? '',
        email: c.commit.author?.email ?? '',
      },
      date: c.commit.author?.date ?? '',
    }));
  }

  async registerWebhook(callbackUrl: string, secret: string): Promise<string> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/hooks`;
    const response = await this.fetch<GitHubWebhookResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        config: { url: callbackUrl, content_type: 'json', secret },
        events: ['push'],
        active: true,
      }),
    });
    return String(response.id);
  }

  async removeWebhook(webhookId: string): Promise<void> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/hooks/${webhookId}`;
    await this.fetch<void>(url, { method: 'DELETE' });
  }

  async getDiff(baseCommit: string, headCommit: string): Promise<PullResult> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/compare/${baseCommit}...${headCommit}?per_page=100`;
    const response = await this.fetch<GitHubCompareResponse>(url);

    const COMPARE_TRUNCATION_THRESHOLD = 300;
    const compareFiles: Array<{ filename: string; status: string }> = response.files ?? [];

    if (compareFiles.length >= COMPARE_TRUNCATION_THRESHOLD) {
      log.warn('Compare API truncated at 300 files — falling back to Trees API', {
        baseCommit,
        headCommit,
        fileCount: compareFiles.length,
      });
      return this.getDiffViaTrees(baseCommit, headCommit);
    }

    const files: GitFile[] = [];
    for (const file of compareFiles) {
      if (file.status === 'removed') continue;
      const full = await this.getFile(headCommit, file.filename);
      if (full) files.push(full);
    }

    return { files, commitSha: headCommit, branch: '' };
  }

  /**
   * Fallback diff via Trees API when compare endpoint truncates at 300 files.
   * Fetches the full recursive tree at both commits and diffs them.
   */
  private async getDiffViaTrees(baseCommit: string, headCommit: string): Promise<PullResult> {
    const repoPrefix = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}`;

    const [baseTreeResp, headTreeResp] = await Promise.all([
      this.fetch<GitHubTreeResponse>(`${repoPrefix}/git/trees/${baseCommit}?recursive=1`),
      this.fetch<GitHubTreeResponse>(`${repoPrefix}/git/trees/${headCommit}?recursive=1`),
    ]);

    // Build a map of path → sha for the base tree
    const baseMap = new Map<string, string>();
    for (const item of baseTreeResp.tree ?? []) {
      if (item.type === 'blob') {
        baseMap.set(item.path, item.sha);
      }
    }

    // Find files that are new or changed (different SHA) in the head tree
    const changedPaths: string[] = [];
    for (const item of headTreeResp.tree ?? []) {
      if (item.type !== 'blob') continue;
      const baseSha = baseMap.get(item.path);
      if (!baseSha || baseSha !== item.sha) {
        changedPaths.push(item.path);
      }
    }

    // Fetch changed files in parallel batches
    const files: GitFile[] = [];
    for (let i = 0; i < changedPaths.length; i += FILE_FETCH_BATCH_SIZE) {
      const batch = changedPaths.slice(i, i + FILE_FETCH_BATCH_SIZE);
      const results = await Promise.all(batch.map((p) => this.getFile(headCommit, p)));
      for (const full of results) {
        if (full) files.push(full);
      }
    }

    return { files, commitSha: headCommit, branch: '' };
  }

  private async getTreeSha(branch: string): Promise<string> {
    const url = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/ref/heads/${encodeURIComponent(branch)}`;
    const ref = await this.fetch<GitHubRef>(url);
    const commitUrl = `${this.apiBase}/repos/${this.config.owner}/${this.config.repo}/git/commits/${ref.object.sha}`;
    const commit = await this.fetch<GitHubCommitObject>(commitUrl);
    return commit.tree.sha;
  }

  private async fetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      log.error('API error', { status: response.status, body });
      throw new Error(`GitHub API error: ${response.status}`);
    }

    if (response.status === 204) return undefined as unknown as T;
    return response.json() as Promise<T>;
  }
}
