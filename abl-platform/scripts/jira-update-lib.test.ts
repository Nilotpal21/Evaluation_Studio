import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  parseLabelList,
  parseSectionSpec,
  parseSelectedDotEnvKeys,
} from './jira-update-lib.js';

describe('parseSelectedDotEnvKeys', () => {
  it('loads only jira-related keys and skips pre-set env vars', () => {
    const parsed = parseSelectedDotEnvKeys(
      [
        'JIRA_BASE_URL=https://koreteam.atlassian.net',
        'JIRA_EMAIL=dev@example.com',
        'ATLASSIAN_API_KEY=secret-token',
        'IGNORED_KEY=nope',
      ].join('\n'),
      undefined,
      { JIRA_EMAIL: 'already@set.local' },
    );

    expect(parsed).toEqual({
      JIRA_BASE_URL: 'https://koreteam.atlassian.net',
      ATLASSIAN_API_KEY: 'secret-token',
    });
  });
});

describe('parseSectionSpec', () => {
  it('splits heading and content', () => {
    expect(parseSectionSpec('Validation::Build passed and tests updated')).toEqual({
      heading: 'Validation',
      content: 'Build passed and tests updated',
    });
  });

  it('normalizes escaped newline sequences from CLI arguments', () => {
    expect(parseSectionSpec('QA Note::Root cause:\\nMissing state update')).toEqual({
      heading: 'QA Note',
      content: 'Root cause:\nMissing state update',
    });
  });

  it('rejects invalid section syntax', () => {
    expect(() => parseSectionSpec('No separator here')).toThrow(/Invalid section/);
  });
});

describe('parseLabelList', () => {
  it('normalizes comma separated labels', () => {
    expect(parseLabelList('ci, runtime,  fast-tests ')).toEqual(['ci', 'runtime', 'fast-tests']);
  });
});

describe('parseArgs', () => {
  it('accepts positional ticket and mixed update sources', () => {
    const parsed = parseArgs([
      'ABLP-252',
      '--comment',
      'Build is green',
      '--comment-section',
      'Validation::Runtime and SearchAI suites pass',
      '--description-file',
      'notes.md',
      '--labels',
      'ci,fast-tests',
      '--dry-run',
    ]);

    expect(parsed.ticket).toBe('ABLP-252');
    expect(parsed.commentText).toEqual(['Build is green']);
    expect(parsed.commentSections).toEqual([
      { heading: 'Validation', content: 'Runtime and SearchAI suites pass' },
    ]);
    expect(parsed.descriptionFiles).toEqual(['notes.md']);
    expect(parsed.transition).toBeNull();
    expect(parsed.setLabels).toEqual(['ci', 'fast-tests']);
    expect(parsed.dryRun).toBe(true);
  });

  it('supports dedicated QA comment sections', () => {
    const parsed = parseArgs([
      'ABLP-327',
      '--qa-shipped',
      'Centralized workspace permissions',
      '--qa-verification-file',
      'verification.md',
      '--qa-follow-up',
      'Inventory remaining Studio admin routes',
    ]);

    expect(parsed.ticket).toBe('ABLP-327');
    expect(parsed.qaShippedText).toEqual(['Centralized workspace permissions']);
    expect(parsed.qaVerificationFiles).toEqual(['verification.md']);
    expect(parsed.qaFollowUpText).toEqual(['Inventory remaining Studio admin routes']);
  });

  it('supports explicit ticket flag', () => {
    const parsed = parseArgs(['--ticket', 'ABLP-250', '--comment', 'Done']);
    expect(parsed.ticket).toBe('ABLP-250');
  });

  it('accepts transition-only updates', () => {
    const parsed = parseArgs(['ABLP-250', '--transition', 'In Progress']);
    expect(parsed.ticket).toBe('ABLP-250');
    expect(parsed.transition).toBe('In Progress');
  });

  it('accepts target-status transitions, preferred paths, and assignee lookup', () => {
    const parsed = parseArgs([
      'ABLP-581',
      '--transition-to-status',
      'Development Completed',
      '--transition-path',
      'WIP,In Review,Review Completed',
      '--assignee',
      'Prakash Rochkari',
      '--attachment',
      '.codex-artifacts/studio-video-evidence/manifest.json',
    ]);

    expect(parsed.ticket).toBe('ABLP-581');
    expect(parsed.transitionToStatus).toBe('Development Completed');
    expect(parsed.transitionPath).toEqual(['WIP', 'In Review', 'Review Completed']);
    expect(parsed.assignee).toBe('Prakash Rochkari');
    expect(parsed.attachments).toEqual(['.codex-artifacts/studio-video-evidence/manifest.json']);
  });

  it('accepts direct accountId assignment', () => {
    const parsed = parseArgs(['ABLP-581', '--assignee-account-id', 'abc123']);
    expect(parsed.assigneeAccountId).toBe('abc123');
  });

  it('ignores the pnpm forwarding sentinel', () => {
    const parsed = parseArgs(['--', 'ABLP-252', '--comment', 'Done']);
    expect(parsed.ticket).toBe('ABLP-252');
    expect(parsed.commentText).toEqual(['Done']);
  });

  it('rejects missing ticket', () => {
    expect(() => parseArgs(['--comment', 'hello'])).toThrow(/ticket key is required/i);
  });

  it('rejects empty updates', () => {
    expect(() => parseArgs(['ABLP-252'])).toThrow(/No updates requested/);
  });

  it('rejects conflicting transition modes', () => {
    expect(() =>
      parseArgs(['ABLP-252', '--transition', 'WIP', '--transition-to-status', 'Done']),
    ).toThrow(/Use either --transition or --transition-to-status/);
  });

  it('rejects transition paths without a target status', () => {
    expect(() => parseArgs(['ABLP-252', '--transition-path', 'WIP,In Review'])).toThrow(
      /requires --transition-to-status/,
    );
  });

  it('rejects conflicting assignee modes', () => {
    expect(() =>
      parseArgs(['ABLP-252', '--assignee', 'Prakash Rochkari', '--assignee-account-id', 'abc123']),
    ).toThrow(/Use either --assignee or --assignee-account-id/);
  });
});
