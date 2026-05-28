import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  verifyWebhookSignature,
  parseWebhookPayload,
  hasRelevantChanges,
} from '../git/webhook-handler.js';

describe('verifyWebhookSignature', () => {
  it('should verify valid GitHub signature', () => {
    const payload = '{"test": true}';
    const secret = 'test-secret';
    const signature = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyWebhookSignature('github', payload, signature, secret)).toBe(true);
  });

  it('should reject invalid GitHub signature', () => {
    expect(verifyWebhookSignature('github', '{}', 'sha256=invalid', 'secret')).toBe(false);
  });

  it('should verify valid GitLab token', () => {
    expect(verifyWebhookSignature('gitlab', '', 'my-secret', 'my-secret')).toBe(true);
  });

  it('should reject invalid GitLab token', () => {
    expect(verifyWebhookSignature('gitlab', '', 'wrong', 'my-secret')).toBe(false);
  });

  it('should verify valid Bitbucket HMAC-SHA256 signature', () => {
    const payload = '{"push":{"changes":[]}}';
    const secret = 'bb-webhook-secret';
    const signature = createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyWebhookSignature('bitbucket', payload, signature, secret)).toBe(true);
  });

  it('should reject invalid Bitbucket HMAC-SHA256 signature', () => {
    const payload = '{"push":{"changes":[]}}';
    const secret = 'bb-webhook-secret';

    expect(verifyWebhookSignature('bitbucket', payload, 'invalid-hex-signature', secret)).toBe(
      false,
    );
  });

  it('should reject Bitbucket signature when payload is tampered', () => {
    const originalPayload = '{"push":{"changes":[]}}';
    const secret = 'bb-webhook-secret';
    const signature = createHmac('sha256', secret).update(originalPayload).digest('hex');

    const tamperedPayload = '{"push":{"changes":[{"new":{"name":"evil"}}]}}';
    expect(verifyWebhookSignature('bitbucket', tamperedPayload, signature, secret)).toBe(false);
  });
});

describe('parseWebhookPayload', () => {
  it('should parse GitHub push payload', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: { id: 'abc123', committer: { name: 'Test', email: 'test@test.com' } },
      commits: [
        { added: ['agents/new.agent.abl'], modified: [], removed: [] },
        { added: [], modified: ['agents/existing.agent.abl'], removed: [] },
      ],
    };

    const result = parseWebhookPayload('github', payload);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('github');
    expect(result!.branch).toBe('main');
    expect(result!.commitSha).toBe('abc123');
    expect(result!.changedFiles).toContain('agents/new.agent.abl');
    expect(result!.changedFiles).toContain('agents/existing.agent.abl');
    expect(result!.isRelevant).toBe(true);
  });

  it('should parse GitLab push payload', () => {
    const payload = {
      object_kind: 'push',
      ref: 'refs/heads/develop',
      checkout_sha: 'def456',
      commits: [
        {
          id: 'c1',
          added: ['config/models.json'],
          modified: [],
          removed: [],
          author: { name: 'Dev', email: 'dev@test.com' },
        },
      ],
    };

    const result = parseWebhookPayload('gitlab', payload);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('gitlab');
    expect(result!.branch).toBe('develop');
    expect(result!.isRelevant).toBe(true);
  });

  it('should return null for non-push GitLab events', () => {
    const payload = { object_kind: 'merge_request' };
    expect(parseWebhookPayload('gitlab', payload)).toBeNull();
  });
});

describe('hasRelevantChanges', () => {
  it('should detect .agent.abl files as relevant', () => {
    expect(hasRelevantChanges(['agents/test.agent.abl'])).toBe(true);
  });

  it('should detect .tools.abl files as relevant', () => {
    expect(hasRelevantChanges(['tools/api.tools.abl'])).toBe(true);
  });

  it('should detect project.json as relevant', () => {
    expect(hasRelevantChanges(['project.json'])).toBe(true);
  });

  it('should detect config/ files as relevant', () => {
    expect(hasRelevantChanges(['config/models.json'])).toBe(true);
  });

  it('should ignore unrelated files', () => {
    expect(hasRelevantChanges(['README.md', 'src/index.ts', '.gitignore'])).toBe(false);
  });
});

// ─── GitHub Null Safety Tests ───────────────────────────────────────────────

describe('parseWebhookPayload GitHub null safety', () => {
  it('should return ignored payload when head_commit is null', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: null,
      commits: [],
    };
    expect(parseWebhookPayload('github', payload)).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        changedFiles: [],
        isRelevant: false,
      }),
    );
  });

  it('should return ignored payload when head_commit is missing', () => {
    const payload = {
      ref: 'refs/heads/main',
      commits: [],
    };
    expect(parseWebhookPayload('github', payload)).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        changedFiles: [],
        isRelevant: false,
      }),
    );
  });

  it('should return ignored payload when head_commit.id is null', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: { id: null, committer: { name: 'X', email: 'x@x.com' } },
      commits: [],
    };
    expect(parseWebhookPayload('github', payload)).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        changedFiles: [],
        isRelevant: false,
      }),
    );
  });

  it('should return null when commits is non-array truthy value', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: { id: 'abc', committer: { name: 'X', email: 'x@x.com' } },
      commits: 'not-an-array',
    };
    expect(parseWebhookPayload('github', payload)).toBeNull();
  });

  it('should treat undefined commits as empty array', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: { id: 'abc123', committer: { name: 'Test', email: 't@t.com' } },
    };
    const result = parseWebhookPayload('github', payload);
    expect(result).not.toBeNull();
    expect(result!.changedFiles).toEqual([]);
    expect(result!.commitSha).toBe('abc123');
  });

  it('should use empty string fallback for missing committer', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: { id: 'abc123' },
      commits: [],
    };
    const result = parseWebhookPayload('github', payload);
    expect(result).not.toBeNull();
    expect(result!.committer.name).toBe('');
    expect(result!.committer.email).toBe('');
  });
});

// ─── Bitbucket Null Safety Tests ────────────────────────────────────────────

describe('parseWebhookPayload Bitbucket null safety', () => {
  it('should return null when push object is missing', () => {
    expect(parseWebhookPayload('bitbucket', {})).toBeNull();
  });

  it('should return null when push.changes is not an array', () => {
    const payload = { push: { changes: 'not-array' } };
    expect(parseWebhookPayload('bitbucket', payload)).toBeNull();
  });

  it('should return null when push.changes is an empty array', () => {
    const payload = { push: { changes: [] } };
    expect(parseWebhookPayload('bitbucket', payload)).toBeNull();
  });

  it('should return null when first change entry is null', () => {
    const payload = { push: { changes: [null] } };
    expect(parseWebhookPayload('bitbucket', payload)).toBeNull();
  });

  it('should use empty string defaults when change.new is missing', () => {
    const payload = {
      push: {
        changes: [{ old: { name: 'main' } }],
      },
    };
    const result = parseWebhookPayload('bitbucket', payload);
    expect(result).not.toBeNull();
    expect(result!.branch).toBe('');
    expect(result!.commitSha).toBe('');
  });

  it('should correctly extract valid full Bitbucket push payload', () => {
    const payload = {
      push: {
        changes: [
          {
            new: {
              name: 'develop',
              target: {
                hash: 'bb123abc',
                author: { raw: 'Dev User' },
              },
            },
          },
        ],
      },
    };
    const result = parseWebhookPayload('bitbucket', payload);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('bitbucket');
    expect(result!.branch).toBe('develop');
    expect(result!.commitSha).toBe('bb123abc');
    expect(result!.committer.name).toBe('Dev User');
    expect(result!.isRelevant).toBe(true); // Bitbucket always returns isRelevant: true
  });
});

// ─── v2 File Pattern Detection ──────────────────────────────────────────────

describe('hasRelevantChanges — v2 file patterns', () => {
  it('should detect .agent.yaml files as relevant', () => {
    expect(hasRelevantChanges(['agents/booking.agent.yaml'])).toBe(true);
  });

  it('should detect connections/ files as relevant', () => {
    expect(hasRelevantChanges(['connections/salesforce.connection.json'])).toBe(true);
  });

  it('should detect connections/ subdirectory files as relevant', () => {
    expect(hasRelevantChanges(['connections/connectors/stripe.json'])).toBe(true);
  });

  it('should detect guardrails/ files as relevant', () => {
    expect(hasRelevantChanges(['guardrails/pii-filter.guardrail.json'])).toBe(true);
  });

  it('should detect workflows/ files as relevant', () => {
    expect(hasRelevantChanges(['workflows/onboarding.workflow.json'])).toBe(true);
  });

  it('should detect search/ files as relevant', () => {
    expect(hasRelevantChanges(['search/indexes/products.index.json'])).toBe(true);
  });

  it('should detect channels/ files as relevant', () => {
    expect(hasRelevantChanges(['channels/slack.channel.json'])).toBe(true);
  });

  it('should detect vocabulary/ files as relevant', () => {
    expect(hasRelevantChanges(['vocabulary/lookup-tables/countries.lookup.json'])).toBe(true);
  });

  it('should detect evals/ files as relevant', () => {
    expect(hasRelevantChanges(['evals/accuracy/eval-set.json'])).toBe(true);
  });

  it('should detect deployments/ files as relevant', () => {
    expect(hasRelevantChanges(['deployments/production.deployment.json'])).toBe(true);
  });

  it('should detect mixed v1 and v2 files as relevant', () => {
    expect(hasRelevantChanges(['README.md', 'src/utils.ts', 'guardrails/policy.json'])).toBe(true);
  });

  it('should not detect random top-level files as relevant', () => {
    expect(
      hasRelevantChanges([
        'package.json',
        'tsconfig.json',
        '.gitignore',
        'src/index.ts',
        'docs/README.md',
      ]),
    ).toBe(false);
  });

  it('should handle a single v2 pattern file among irrelevant files', () => {
    expect(
      hasRelevantChanges([
        'node_modules/foo/bar.js',
        '.env',
        'workflows/flow.json',
        'dist/main.js',
      ]),
    ).toBe(true);
  });
});

describe('verifyWebhookSignature edge cases', () => {
  it('should reject unknown provider type', () => {
    const result = verifyWebhookSignature('unknown' as any, 'payload', 'sig', 'secret');
    expect(result).toBe(false);
  });

  it('should reject empty payload for github', () => {
    const result = verifyWebhookSignature('github', '', 'sha256=abc', 'secret');
    expect(result).toBe(false);
  });
});

describe('parseWebhookPayload edge cases', () => {
  it('should return ignored payload for GitHub payload with null head_commit', () => {
    const payload = {
      ref: 'refs/heads/main',
      head_commit: null,
      commits: [],
      repository: { full_name: 'org/repo' },
    };
    const result = parseWebhookPayload('github', payload);
    expect(result).toEqual(
      expect.objectContaining({
        branch: 'main',
        commitSha: '',
        changedFiles: [],
        isRelevant: false,
      }),
    );
  });
});
