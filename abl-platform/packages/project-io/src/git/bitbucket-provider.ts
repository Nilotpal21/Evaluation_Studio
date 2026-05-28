/**
 * Bitbucket Provider — implements GitProvider using Bitbucket Cloud REST API
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

const log = createLogger('bitbucket-provider');

interface BitbucketProviderConfigBase {
  workspace: string;
  repoSlug: string;
  apiBaseUrl?: string;
}

interface BitbucketTokenAuth extends BitbucketProviderConfigBase {
  authMode: 'token';
  token: string;
}

interface BitbucketBasicAuth extends BitbucketProviderConfigBase {
  authMode?: 'basic';
  username: string;
  appPassword: string;
}

interface BitbucketApiTokenAuth extends BitbucketProviderConfigBase {
  authMode: 'api_token';
  email: string;
  apiToken: string;
}

export type BitbucketProviderConfig =
  | BitbucketTokenAuth
  | BitbucketBasicAuth
  | BitbucketApiTokenAuth;

const DEFAULT_API_BASE = 'https://api.bitbucket.org/2.0';
const GIT_API_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 10_000;
const FILE_FETCH_BATCH_SIZE = 10;

// ─── Bitbucket API response shapes ─────────────────────────────────────────

interface BitbucketPaginated<T> {
  values: T[];
  next?: string;
}

interface BitbucketSrcEntry {
  type: string;
  path: string;
  commit?: { hash: string };
}

interface BitbucketCommitEntry {
  hash: string;
  message: string;
  author: { raw: string };
  date: string;
}

interface BitbucketBranchResponse {
  name: string;
  target: { hash: string };
}

interface BitbucketPRResponse {
  id: number;
  links: { html: { href: string } };
}

interface BitbucketWebhookResponse {
  uuid: string;
}

interface BitbucketDiffstatEntry {
  status: string;
  old?: { path: string };
  new?: { path: string };
}

/**
 * Parse Bitbucket author raw string "Name <email>" into separate name and email.
 * Handles cases where email is missing (returns raw as name, empty email).
 */
export function parseBitbucketAuthor(raw: string): { name: string; email: string } {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: raw.trim(), email: '' };
}

export class BitbucketProvider implements GitProvider {
  readonly providerName = 'bitbucket';
  private readonly config: BitbucketProviderConfig;
  private readonly apiBase: string;

  constructor(config: BitbucketProviderConfig) {
    this.config = config;
    this.apiBase = config.apiBaseUrl ?? DEFAULT_API_BASE;

    // Warn once at construction time instead of on every request via authHeader getter
    if (!config.authMode || config.authMode === 'basic') {
      log.warn(
        'Bitbucket app passwords are deprecated and will stop working June 2026 — migrate to API tokens',
      );
    }
  }

  private get repoPath(): string {
    return `${this.config.workspace}/${this.config.repoSlug}`;
  }

  async validateConnection(): Promise<ConnectionValidationResult> {
    const url = `${this.apiBase}/repositories/${this.repoPath}`;
    try {
      const response = await globalThis.fetch(url, {
        signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
        headers: {
          Authorization: this.authHeader,
        },
      });
      if (response.ok) return { valid: true };
      const body = await response.text();
      log.debug('validateConnection failed', { status: response.status, body });
      return { valid: false, error: `Bitbucket API returned ${response.status}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, error: message };
    }
  }

  async listFiles(branch: string, path?: string): Promise<GitFile[]> {
    const params = new URLSearchParams({ max_depth: '10', pagelen: '100' });
    if (path) params.set('path', path);
    let url: string | null =
      `${this.apiBase}/repositories/${this.repoPath}/src/${encodeURIComponent(branch)}/?${params}`;
    const allFiles: GitFile[] = [];

    while (url) {
      const response: BitbucketPaginated<BitbucketSrcEntry> = await this.fetch(url);
      const files = (response.values ?? [])
        .filter((item: BitbucketSrcEntry) => item.type === 'commit_file')
        .map((item: BitbucketSrcEntry) => ({
          path: item.path,
          content: '',
          sha: item.commit?.hash,
        }));
      allFiles.push(...files);
      url = response.next ?? null;
    }

    return allFiles;
  }

  async getFile(branch: string, path: string): Promise<GitFile | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `${this.apiBase}/repositories/${this.repoPath}/src/${encodeURIComponent(branch)}/${encodedPath}`;
    try {
      const response = await this.fetchRaw(url);
      const content = await response.text();
      return { path, content };
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
    // Bitbucket uses form-data for multi-file commits
    const formData = new FormData();
    formData.append('message', commitMessage);
    formData.append('branch', branch);
    formData.append('author', `${committer.name} <${committer.email}>`);

    for (const file of files) {
      formData.append(file.path, new Blob([file.content], { type: 'text/plain' }), file.path);
    }
    for (const deletedPath of options?.deletedPaths ?? []) {
      formData.append('files', deletedPath);
    }

    const url = `${this.apiBase}/repositories/${this.repoPath}/src`;
    const response = await globalThis.fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
      headers: { Authorization: this.authHeader },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      log.error('API error', { status: response.status, body });
      throw new Error(`Bitbucket API error: ${response.status}`);
    }

    // Get the latest commit to return its SHA
    const commits = await this.listCommits(branch, 1);
    const sha = commits[0]?.sha ?? '';
    return {
      commitSha: sha,
      branch,
      url: sha ? `https://bitbucket.org/${this.repoPath}/commits/${sha}` : undefined,
    };
  }

  async createBranch(name: string, fromBranch: string): Promise<GitBranch> {
    // Resolve branch name to commit SHA first
    const commits = await this.listCommits(fromBranch, 1);
    const sourceSha = commits[0]?.sha;
    if (!sourceSha) {
      throw new Error(`Cannot resolve branch "${fromBranch}" to a commit SHA`);
    }

    const url = `${this.apiBase}/repositories/${this.repoPath}/refs/branches`;
    const response = await this.fetch<BitbucketBranchResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        name,
        target: { hash: sourceSha },
      }),
    });
    return { name, sha: response.target.hash };
  }

  async createPullRequest(params: PRParams): Promise<CreatePRResult> {
    const url = `${this.apiBase}/repositories/${this.repoPath}/pullrequests`;
    const response = await this.fetch<BitbucketPRResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        description: params.description,
        source: { branch: { name: params.sourceBranch } },
        destination: { branch: { name: params.targetBranch } },
      }),
    });
    return { id: response.id, url: response.links.html.href, number: response.id };
  }

  async listCommits(branch: string, limit: number = 10): Promise<GitCommit[]> {
    const url = `${this.apiBase}/repositories/${this.repoPath}/commits/${encodeURIComponent(branch)}?pagelen=${limit}`;
    const response = await this.fetch<BitbucketPaginated<BitbucketCommitEntry>>(url);
    return (response.values ?? []).map((c) => ({
      sha: c.hash,
      message: c.message,
      author: parseBitbucketAuthor(c.author?.raw ?? ''),
      date: c.date,
    }));
  }

  async registerWebhook(callbackUrl: string, secret: string): Promise<string> {
    const url = `${this.apiBase}/repositories/${this.repoPath}/hooks`;
    const response = await this.fetch<BitbucketWebhookResponse>(url, {
      method: 'POST',
      body: JSON.stringify({
        description: 'ABL Platform sync',
        url: callbackUrl,
        active: true,
        secret,
        events: ['repo:push'],
      }),
    });
    return response.uuid;
  }

  async removeWebhook(webhookId: string): Promise<void> {
    const url = `${this.apiBase}/repositories/${this.repoPath}/hooks/${webhookId}`;
    await this.fetch<Record<string, never>>(url, { method: 'DELETE' });
  }

  async getDiff(baseCommit: string, headCommit: string): Promise<PullResult> {
    // Use /diffstat/ endpoint which returns JSON (not /diff/ which returns plain text)
    const allDiffs: BitbucketDiffstatEntry[] = [];
    let url: string | null =
      `${this.apiBase}/repositories/${this.repoPath}/diffstat/${encodeURIComponent(baseCommit)}..${encodeURIComponent(headCommit)}?pagelen=500`;

    while (url) {
      const response: BitbucketPaginated<BitbucketDiffstatEntry> = await this.fetch(url);
      allDiffs.push(...(response.values ?? []));
      url = response.next ?? null;
    }

    const files: GitFile[] = [];
    for (const diff of allDiffs) {
      if (diff.status === 'removed') continue;
      const filePath = diff.new?.path;
      if (!filePath) continue;
      const full = await this.getFile(headCommit, filePath);
      if (full) files.push(full);
    }

    return { files, commitSha: headCommit, branch: '' };
  }

  private get authHeader(): string {
    if (this.config.authMode === 'token') {
      return `Bearer ${this.config.token}`;
    }
    if (this.config.authMode === 'api_token') {
      const credentials = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString(
        'base64',
      );
      return `Basic ${credentials}`;
    }
    // basic (default) — app passwords (deprecation warning emitted in constructor)
    const credentials = Buffer.from(`${this.config.username}:${this.config.appPassword}`).toString(
      'base64',
    );
    return `Basic ${credentials}`;
  }

  /**
   * Fetch and return raw Response object (for cases needing text content, not JSON).
   */
  private async fetchRaw(url: string, init?: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
      headers: {
        Authorization: this.authHeader,
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Bitbucket API error: 404`);
      }
      const body = await response.text();
      log.error('API error', { status: response.status, body });
      throw new Error(`Bitbucket API error: ${response.status}`);
    }
    return response;
  }

  private async fetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(GIT_API_TIMEOUT_MS),
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text();
      log.error('API error', { status: response.status, body });
      throw new Error(`Bitbucket API error: ${response.status}`);
    }
    if (response.status === 204) return undefined as unknown as T;
    return response.json() as Promise<T>;
  }
}
