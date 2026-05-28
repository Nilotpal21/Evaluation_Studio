import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { parseWebhookPayload, verifyWebhookSignature } from '../git/webhook-handler.js';

describe('Git webhook hidden path scenarios', () => {
  it('accepts Bitbucket sha256-prefixed signatures from provider headers', () => {
    const payload = JSON.stringify({ push: { changes: [] } });
    const secret = 'webhook-secret';
    const digest = createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyWebhookSignature('bitbucket', payload, `sha256=${digest}`, secret)).toBe(true);
  });

  it('selects the matching Bitbucket branch change instead of only the first change', () => {
    const payload = parseWebhookPayload('bitbucket', {
      push: {
        changes: [
          {
            new: {
              name: 'feature/not-synced',
              target: { hash: 'feature-commit' },
            },
          },
          {
            new: {
              name: 'develop',
              target: { hash: 'develop-commit' },
            },
          },
        ],
      },
    });

    expect(payload).toEqual(
      expect.objectContaining({
        branch: 'develop',
        commitSha: 'develop-commit',
        isRelevant: true,
      }),
    );
  });

  it('returns an ignored payload for GitHub tag pushes instead of treating tag names as branches', () => {
    const payload = parseWebhookPayload('github', {
      ref: 'refs/tags/v1.0.0',
      head_commit: {
        id: 'tag-commit',
        committer: { name: 'GitHub User', email: 'user@example.com' },
      },
      commits: [{ added: ['agents/support.agent.abl'] }],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        branch: '',
        commitSha: 'tag-commit',
        isRelevant: false,
      }),
    );
  });

  it('returns an ignored payload for branch delete events instead of parse failure', () => {
    const payload = parseWebhookPayload('github', {
      ref: 'refs/heads/main',
      head_commit: null,
      commits: [],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        isRelevant: false,
      }),
    );
  });

  it('returns an ignored payload for GitLab tag push events', () => {
    const payload = parseWebhookPayload('gitlab', {
      object_kind: 'tag_push',
      ref: 'refs/tags/v1.0.0',
      checkout_sha: 'tag-sha',
      commits: [{ added: ['agents/support.agent.abl'], modified: [], removed: [] }],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        branch: '',
        commitSha: 'tag-sha',
        isRelevant: false,
      }),
    );
  });

  it('returns an ignored payload for GitLab branch delete events', () => {
    const payload = parseWebhookPayload('gitlab', {
      object_kind: 'push',
      ref: 'refs/heads/main',
      checkout_sha: null,
      commits: [],
    });

    expect(payload).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        isRelevant: false,
      }),
    );
  });
});
