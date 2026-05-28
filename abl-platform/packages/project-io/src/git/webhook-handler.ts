/**
 * Webhook Handler — verifies and parses incoming git push events
 *
 * Supports GitHub, GitLab, and Bitbucket webhook signatures.
 * Filters for ABL-relevant file changes.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { GitProviderType } from '../types.js';

// ─── Provider-specific payload interfaces ────────────────────────────────

export interface GitHubWebhookBody {
  ref?: string;
  head_commit?: {
    id?: string | null;
    message?: string;
    author?: { name?: string; email?: string };
    committer?: { name?: string; email?: string };
  } | null;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

export interface GitLabWebhookBody {
  object_kind?: string;
  ref?: string;
  checkout_sha?: string;
  commits?: Array<{
    id?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
    author?: { name?: string; email?: string };
  }>;
}

export interface BitbucketWebhookBody {
  push?: {
    changes?: Array<{
      new?: {
        name?: string;
        target?: {
          hash?: string;
          author?: { raw?: string };
        };
      };
      old?: { name?: string };
    } | null>;
  };
}

export type ProviderWebhookBody = GitHubWebhookBody | GitLabWebhookBody | BitbucketWebhookBody;

export interface WebhookPayload {
  provider: GitProviderType;
  branch: string;
  commitSha: string;
  committer: { name: string; email: string };
  changedFiles: string[];
  isRelevant: boolean;
}

const ABL_RELEVANT_PATTERNS = [
  /\.agent\.abl$/,
  /\.agent\.yaml$/,
  /\.tools\.abl$/,
  /^project\.json$/,
  /^config\//,
  /^deployments\//,
  /^connections\//,
  /^guardrails\//,
  /^workflows\//,
  /^evals\//,
  /^search\//,
  /^channels\//,
  /^vocabulary\//,
];

/**
 * Verify webhook signature for a given provider.
 */
export function verifyWebhookSignature(
  provider: GitProviderType,
  payload: string,
  signature: string,
  secret: string,
): boolean {
  switch (provider) {
    case 'github':
      return verifyGitHubSignature(payload, signature, secret);
    case 'gitlab':
      return verifyGitLabToken(signature, secret);
    case 'bitbucket':
      // Bitbucket Cloud uses HMAC-SHA256 for webhook secrets
      return verifyBitbucketSignature(payload, signature, secret);
    default:
      return false;
  }
}

/**
 * Parse a webhook payload from any supported provider.
 */
export function parseWebhookPayload(
  provider: GitProviderType,
  body: ProviderWebhookBody,
): WebhookPayload | null {
  switch (provider) {
    case 'github':
      return parseGitHubPayload(body as GitHubWebhookBody);
    case 'gitlab':
      return parseGitLabPayload(body as GitLabWebhookBody);
    case 'bitbucket':
      return parseBitbucketPayload(body as BitbucketWebhookBody);
    default:
      return null;
  }
}

/**
 * Check if any of the changed files are ABL-relevant.
 */
export function hasRelevantChanges(changedFiles: string[]): boolean {
  return changedFiles.some((file) => ABL_RELEVANT_PATTERNS.some((pattern) => pattern.test(file)));
}

// ─── GitHub ─────────────────────────────────────────────────────────────

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  return constantTimeEqual(signature, expected);
}

function parseGitHubPayload(body: GitHubWebhookBody): WebhookPayload | null {
  if (!body.ref) return null;
  if (!Array.isArray(body.commits) && body.commits != null) return null;

  if (body.ref.startsWith('refs/tags/')) {
    return {
      provider: 'github',
      branch: '',
      commitSha: body.head_commit?.id ?? '',
      committer: {
        name: body.head_commit?.committer?.name ?? '',
        email: body.head_commit?.committer?.email ?? '',
      },
      changedFiles: [],
      isRelevant: false,
    };
  }

  const branch = body.ref.replace('refs/heads/', '');
  if (!body.head_commit || !body.head_commit.id) {
    return {
      provider: 'github',
      branch,
      commitSha: '',
      committer: { name: '', email: '' },
      changedFiles: [],
      isRelevant: false,
    };
  }
  const changedFiles: string[] = [];
  for (const commit of body.commits ?? []) {
    changedFiles.push(
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    );
  }

  const uniqueFiles = [...new Set(changedFiles)];

  return {
    provider: 'github',
    branch,
    commitSha: body.head_commit.id,
    committer: {
      name: body.head_commit.committer?.name ?? '',
      email: body.head_commit.committer?.email ?? '',
    },
    changedFiles: uniqueFiles,
    isRelevant: hasRelevantChanges(uniqueFiles),
  };
}

// ─── GitLab ─────────────────────────────────────────────────────────────

function verifyGitLabToken(token: string, secret: string): boolean {
  return constantTimeEqual(token, secret);
}

function parseGitLabPayload(body: GitLabWebhookBody): WebhookPayload | null {
  if (body.object_kind === 'tag_push') {
    return {
      provider: 'gitlab',
      branch: '',
      commitSha: body.checkout_sha ?? '',
      committer: { name: '', email: '' },
      changedFiles: [],
      isRelevant: false,
    };
  }
  if (body.object_kind !== 'push') return null;

  const branch = (body.ref ?? '').replace('refs/heads/', '');
  if (!body.checkout_sha && (body.commits?.length ?? 0) === 0) {
    return {
      provider: 'gitlab',
      branch,
      commitSha: '',
      committer: { name: '', email: '' },
      changedFiles: [],
      isRelevant: false,
    };
  }
  const changedFiles: string[] = [];
  for (const commit of body.commits ?? []) {
    changedFiles.push(
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    );
  }

  const uniqueFiles = [...new Set(changedFiles)];
  const lastCommit = body.commits?.[body.commits.length - 1];

  return {
    provider: 'gitlab',
    branch,
    commitSha: body.checkout_sha ?? lastCommit?.id ?? '',
    committer: {
      name: lastCommit?.author?.name ?? '',
      email: lastCommit?.author?.email ?? '',
    },
    changedFiles: uniqueFiles,
    isRelevant: hasRelevantChanges(uniqueFiles),
  };
}

// ─── Bitbucket ──────────────────────────────────────────────────────────

function verifyBitbucketSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const normalizedSignature = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  return constantTimeEqual(normalizedSignature, expected);
}

/**
 * Constant-time string comparison that does not leak length information.
 * Pads both buffers to the same length before calling timingSafeEqual,
 * avoiding the early-return length check that would leak timing info.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLen = Math.max(bufA.length, bufB.length);

  // Pad both buffers to the same length so timingSafeEqual can be called safely
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);

  // Compare padded buffers, then also check lengths match.
  // The length check is after timingSafeEqual so both paths take constant time.
  return timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

function parseBitbucketPayload(body: BitbucketWebhookBody): WebhookPayload | null {
  const push = body.push;
  if (!push || !Array.isArray(push.changes) || push.changes.length === 0) return null;

  const change =
    push.changes.find((candidate) => candidate?.new?.name === 'develop') ??
    push.changes.find((candidate) => candidate?.new?.name === 'main') ??
    push.changes.find((candidate) => candidate?.new?.name === 'master') ??
    push.changes[0];
  if (!change) return null;
  const branch = change.new?.name ?? '';
  const commitSha = change.new?.target?.hash ?? '';
  const committer = {
    name: change.new?.target?.author?.raw ?? '',
    email: '',
  };

  // Bitbucket push payloads don't always include file lists
  // We treat all pushes as potentially relevant
  return {
    provider: 'bitbucket',
    branch,
    commitSha,
    committer,
    changedFiles: [],
    isRelevant: true,
  };
}
