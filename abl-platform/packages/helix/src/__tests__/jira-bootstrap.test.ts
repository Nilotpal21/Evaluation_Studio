/**
 * Pure-function unit tests for `integrations/jira-bootstrap.ts`.
 *
 * Covers UT-1..UT-9 from the test spec at
 * `docs/testing/sub-features/helix-work-item-bootstrap.md` §4. Follows the
 * project's "no platform mock" rule — every test calls real exported
 * functions with hand-crafted in-memory inputs. No `vi.mock`, no fake fs.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { JiraAssignedIssue } from '../integrations/jira-client.js';
import {
  __resetWorkspacePackagesCacheForTests,
  enumerateWorkspacePackages,
  extractAcceptanceCriteria,
  inferScopeFromText,
  isRealJiraKey,
  mapJiraIssueToWorkItem,
  MAX_INFERRED_SCOPE,
} from '../integrations/jira-bootstrap.js';

// ─── Shared workspace fixture for inferScopeFromText tests ────────

const FIXTURE_PACKAGES = [
  'apps/admin',
  'apps/runtime',
  'apps/studio',
  'packages/compiler',
  'packages/database',
  'packages/execution',
  'packages/helix',
];

// ─── isRealJiraKey ────────────────────────────────────────────────

describe('isRealJiraKey (UT-1, UT-2)', () => {
  it('UT-1: matches valid Jira-key shapes', () => {
    expect(isRealJiraKey('ABLP-51')).toBe(true);
    expect(isRealJiraKey('ABLP-1')).toBe(true);
    expect(isRealJiraKey('ABLP-999999')).toBe(true);
  });

  it('UT-1: rejects non-keys', () => {
    expect(isRealJiraKey('abc-1')).toBe(false);
    expect(isRealJiraKey('123-1')).toBe(false);
    expect(isRealJiraKey('ABLP')).toBe(false);
    expect(isRealJiraKey('')).toBe(false);
    expect(isRealJiraKey(undefined)).toBe(false);
    expect(isRealJiraKey('ABLP-')).toBe(false);
    expect(isRealJiraKey('ABLP-abc')).toBe(false);
    expect(isRealJiraKey('-ABLP-1')).toBe(false);
    expect(isRealJiraKey(' ABLP-1')).toBe(false);
    expect(isRealJiraKey('ABLP-1 ')).toBe(false);
  });

  it('UT-2: allows digit after the first letter (regression guard against naive regex)', () => {
    // Regression guard: a naive `^[A-Z]+-\d+$` would reject `AB1-9` and `A1-9`.
    // The canonical regex `^[A-Z][A-Z0-9]+-\d+$` accepts both — first char must
    // be a letter, subsequent chars before `-` may be letters or digits.
    expect(isRealJiraKey('AB1-9')).toBe(true);
    expect(isRealJiraKey('A1-9')).toBe(true);
    expect(isRealJiraKey('AB12-345')).toBe(true);
    // But a single-char prefix is rejected — `[A-Z0-9]+` requires ≥1 more char.
    expect(isRealJiraKey('A-9')).toBe(false);
  });

  it('UT-2: still requires uppercase first letter', () => {
    expect(isRealJiraKey('aB1-9')).toBe(false);
    expect(isRealJiraKey('1B1-9')).toBe(false);
  });
});

// ─── inferScopeFromText (UT-4, UT-5, UT-6) ────────────────────────

describe('inferScopeFromText (UT-4, UT-5, UT-6)', () => {
  it('UT-4: matches multiple workspace mentions', () => {
    const text = 'Audit apps/runtime/src/sessions and packages/execution for the bug.';
    expect(inferScopeFromText(text, FIXTURE_PACKAGES)).toEqual([
      'apps/runtime',
      'packages/execution',
    ]);
  });

  it('UT-4: matches a workspace path that appears as the whole token', () => {
    expect(inferScopeFromText('Touches apps/runtime exclusively.', FIXTURE_PACKAGES)).toEqual([
      'apps/runtime',
    ]);
  });

  it('UT-4: returns empty for unrelated prose', () => {
    expect(inferScopeFromText('Bug in studio UI', FIXTURE_PACKAGES)).toEqual([]);
  });

  it('UT-4: returns empty for empty input', () => {
    expect(inferScopeFromText('', FIXTURE_PACKAGES)).toEqual([]);
  });

  it('UT-5: dedupes repeated mentions', () => {
    const text = 'apps/runtime apps/runtime/src/sessions apps/runtime/src/db';
    expect(inferScopeFromText(text, FIXTURE_PACKAGES)).toEqual(['apps/runtime']);
  });

  it('UT-5: caps at MAX_INFERRED_SCOPE entries in description order', () => {
    const text = [
      'apps/runtime',
      'apps/admin',
      'apps/studio',
      'packages/compiler',
      'packages/database',
      'packages/execution', // 6th — must be dropped
      'packages/helix', // 7th — must be dropped
    ].join(' ');
    const result = inferScopeFromText(text, FIXTURE_PACKAGES);
    expect(result).toHaveLength(MAX_INFERRED_SCOPE);
    expect(result).toEqual([
      'apps/runtime',
      'apps/admin',
      'apps/studio',
      'packages/compiler',
      'packages/database',
    ]);
  });

  it('UT-6: ignores path-traversal tokens (security negative)', () => {
    const text = 'Audit ../../../etc/passwd and ../.env, but also ./apps/runtime/src/sessions.';
    expect(inferScopeFromText(text, FIXTURE_PACKAGES)).toEqual(['apps/runtime']);
  });

  it('UT-6: rejects packages embedded inside a parent that begins with `..`', () => {
    const text = 'Look at ../../apps/runtime for the symlink target.';
    expect(inferScopeFromText(text, FIXTURE_PACKAGES)).toEqual([]);
  });

  it('UT-6: does not match a longer package path as a shorter prefix sibling', () => {
    // "apps/runtime-extras" should NOT match the "apps/runtime" workspace package.
    const result = inferScopeFromText('Touches apps/runtime-extras only.', FIXTURE_PACKAGES);
    expect(result).toEqual([]);
  });

  it('UT-4: matches a leading "./" prefix as the same workspace package', () => {
    expect(inferScopeFromText('./apps/runtime/src/sessions', FIXTURE_PACKAGES)).toEqual([
      'apps/runtime',
    ]);
  });
});

// ─── mapJiraIssueToWorkItem (UT-3, UT-7, UT-8, UT-9) ──────────────

const HAPPY_ISSUE: JiraAssignedIssue = {
  key: 'ABLP-FAKE-1',
  summary: 'Audit runtime session lifecycle',
  status: 'In Progress',
  description: '<adf-json>',
  descriptionText: 'Audit apps/runtime/src/sessions and packages/execution for races.',
  labels: ['helix'],
  issueType: 'Task',
};

describe('mapJiraIssueToWorkItem (UT-3, UT-7, UT-8, UT-9)', () => {
  it('UT-3: happy path with empty CLI overrides populates from Jira', () => {
    const result = mapJiraIssueToWorkItem(HAPPY_ISSUE, 'ABLP-FAKE-1', {}, FIXTURE_PACKAGES, 287);

    expect(result.partialWorkItem.title).toBe('Audit runtime session lifecycle');
    expect(result.partialWorkItem.description).toBe(HAPPY_ISSUE.descriptionText);
    expect(result.partialWorkItem.scope).toEqual(['apps/runtime', 'packages/execution']);
    expect(result.partialWorkItem.jiraKey).toBe('ABLP-FAKE-1');

    expect(result.bootstrapMeta.jiraKey).toBe('ABLP-FAKE-1');
    expect(result.bootstrapMeta.jiraFetchSuccess).toBe(true);
    expect(result.bootstrapMeta.jiraFetchLatencyMs).toBe(287);
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('deterministic');
    expect(result.bootstrapMeta.inferredScope).toEqual(['apps/runtime', 'packages/execution']);
    expect(result.bootstrapMeta.fallbackReason).toBeUndefined();
  });

  it('UT-3: when Jira description is empty, scope inference yields empty + scopeInferenceMethod=empty', () => {
    const issue: JiraAssignedIssue = { ...HAPPY_ISSUE, descriptionText: '' };
    const result = mapJiraIssueToWorkItem(issue, 'ABLP-FAKE-1', {}, FIXTURE_PACKAGES);

    expect(result.partialWorkItem.scope).toEqual([]);
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('empty');
    expect(result.bootstrapMeta.inferredScope).toEqual([]);
    expect(result.partialWorkItem.description).toBe('ABLP-FAKE-1'); // falls back to key
  });

  it('UT-7: --title CLI override wins over Jira summary', () => {
    const result = mapJiraIssueToWorkItem(
      HAPPY_ISSUE,
      'ABLP-FAKE-1',
      { title: 'Manual title from CLI' },
      FIXTURE_PACKAGES,
    );

    expect(result.partialWorkItem.title).toBe('Manual title from CLI');
    // Jira description still fills since CLI did not override it
    expect(result.partialWorkItem.description).toBe(HAPPY_ISSUE.descriptionText);
    // Inference still runs — only --scope short-circuits inference
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('deterministic');
  });

  it('UT-7: --description CLI override wins over Jira description', () => {
    const result = mapJiraIssueToWorkItem(
      HAPPY_ISSUE,
      'ABLP-FAKE-1',
      { description: 'Override description text' },
      FIXTURE_PACKAGES,
    );

    expect(result.partialWorkItem.description).toBe('Override description text');
    expect(result.partialWorkItem.title).toBe(HAPPY_ISSUE.summary);
  });

  it('UT-7: --scope CLI override locks scopeInferenceMethod to "explicit" and inferredScope to []', () => {
    // LOCKED CONTRACT (test spec E2E-7 + LLD task 1.2): when --scope is supplied,
    // the inference branch is short-circuited; inferredScope === [].
    const result = mapJiraIssueToWorkItem(
      HAPPY_ISSUE,
      'ABLP-FAKE-1',
      { scope: ['apps/admin', 'apps/studio'] },
      FIXTURE_PACKAGES,
    );

    expect(result.partialWorkItem.scope).toEqual(['apps/admin', 'apps/studio']);
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('explicit');
    expect(result.bootstrapMeta.inferredScope).toEqual([]);
  });

  it('UT-8: null issue (Jira fetch failed) falls back to key-as-title and records fallbackReason', () => {
    const result = mapJiraIssueToWorkItem(
      null,
      'ABLP-99',
      {},
      FIXTURE_PACKAGES,
      undefined,
      'not-found',
    );

    expect(result.partialWorkItem.title).toBe('ABLP-99');
    expect(result.partialWorkItem.description).toBe('ABLP-99');
    expect(result.partialWorkItem.scope).toEqual([]);
    expect(result.partialWorkItem.jiraKey).toBe('ABLP-99');

    expect(result.bootstrapMeta.jiraFetchSuccess).toBe(false);
    expect(result.bootstrapMeta.fallbackReason).toBe('not-found');
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('empty');
    expect(result.bootstrapMeta.inferredScope).toEqual([]);
  });

  it('UT-8: null issue with --scope override still respects explicit scope', () => {
    const result = mapJiraIssueToWorkItem(
      null,
      'ABLP-99',
      { scope: ['apps/admin'] },
      FIXTURE_PACKAGES,
      undefined,
      'auth-failed',
    );

    expect(result.partialWorkItem.scope).toEqual(['apps/admin']);
    expect(result.bootstrapMeta.scopeInferenceMethod).toBe('explicit');
    expect(result.bootstrapMeta.fallbackReason).toBe('auth-failed');
  });

  it('UT-9: BootstrapMeta shape conforms to interface (ISO timestamps absent — set by caller)', () => {
    const result = mapJiraIssueToWorkItem(HAPPY_ISSUE, 'ABLP-FAKE-1', {}, FIXTURE_PACKAGES, 150);

    const meta = result.bootstrapMeta;
    expect(typeof meta.jiraFetchSuccess).toBe('boolean');
    expect(typeof meta.jiraFetchLatencyMs).toBe('number');
    expect(meta.jiraFetchLatencyMs).toBeGreaterThanOrEqual(0);
    expect(['deterministic', 'explicit', 'empty']).toContain(meta.scopeInferenceMethod);
    expect(Array.isArray(meta.inferredScope)).toBe(true);
  });
});

// ─── enumerateWorkspacePackages — pure-function flavor with real fs ──

// Uses a real temporary workspace tree because the function reads the
// filesystem; this is fine — the boundary is filesystem, not network or any
// platform package.
describe('enumerateWorkspacePackages', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-bootstrap-ws-'));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    __resetWorkspacePackagesCacheForTests();
  });

  afterEach(async () => {
    // Clean any files we wrote so each test starts with a known dir state.
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
  });

  it('reads pnpm-workspace.yaml and resolves wildcards', async () => {
    await writeFile(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
      'utf-8',
    );
    await mkdir(join(tempDir, 'apps', 'runtime'), { recursive: true });
    await writeFile(join(tempDir, 'apps', 'runtime', 'package.json'), '{}', 'utf-8');
    await mkdir(join(tempDir, 'apps', 'studio'), { recursive: true });
    await writeFile(join(tempDir, 'apps', 'studio', 'package.json'), '{}', 'utf-8');
    await mkdir(join(tempDir, 'packages', 'database'), { recursive: true });
    await writeFile(join(tempDir, 'packages', 'database', 'package.json'), '{}', 'utf-8');

    const packages = await enumerateWorkspacePackages(tempDir);
    expect(packages).toEqual(['apps/runtime', 'apps/studio', 'packages/database']);
  });

  it('falls back to apps/+packages/ enumeration when pnpm-workspace.yaml is absent', async () => {
    await mkdir(join(tempDir, 'apps', 'runtime'), { recursive: true });
    await writeFile(join(tempDir, 'apps', 'runtime', 'package.json'), '{}', 'utf-8');
    await mkdir(join(tempDir, 'packages', 'foo'), { recursive: true });
    await writeFile(join(tempDir, 'packages', 'foo', 'package.json'), '{}', 'utf-8');

    const packages = await enumerateWorkspacePackages(tempDir);
    expect(packages).toEqual(['apps/runtime', 'packages/foo']);
  });

  it('skips entries without a package.json', async () => {
    await mkdir(join(tempDir, 'apps', 'has-package'), { recursive: true });
    await writeFile(join(tempDir, 'apps', 'has-package', 'package.json'), '{}', 'utf-8');
    await mkdir(join(tempDir, 'apps', 'no-package'), { recursive: true });
    // intentionally no package.json

    const packages = await enumerateWorkspacePackages(tempDir);
    expect(packages).toEqual(['apps/has-package']);
  });

  it('ignores exclusion patterns (v1: patterns starting with `!` are skipped)', async () => {
    await writeFile(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "!packages/excluded"\n',
      'utf-8',
    );
    await mkdir(join(tempDir, 'packages', 'kept'), { recursive: true });
    await writeFile(join(tempDir, 'packages', 'kept', 'package.json'), '{}', 'utf-8');
    await mkdir(join(tempDir, 'packages', 'excluded'), { recursive: true });
    await writeFile(join(tempDir, 'packages', 'excluded', 'package.json'), '{}', 'utf-8');

    // v1 deliberately ignores the `!` exclusion; "excluded" is included.
    const packages = await enumerateWorkspacePackages(tempDir);
    expect(packages).toEqual(['packages/excluded', 'packages/kept']);
  });

  it('returns empty list when neither yaml nor default roots exist', async () => {
    const packages = await enumerateWorkspacePackages(tempDir);
    expect(packages).toEqual([]);
  });
});

// ─── extractAcceptanceCriteria (Slice 4 — acceptance-criteria extractor) ──────

describe('extractAcceptanceCriteria', () => {
  it('returns empty array for empty input', () => {
    expect(extractAcceptanceCriteria('')).toEqual([]);
    expect(extractAcceptanceCriteria('   ')).toEqual([]);
  });

  it('extracts bullet-list items under "Acceptance Criteria" heading', () => {
    const text = [
      'Some preamble text here.',
      '',
      '## Acceptance Criteria',
      '- User can log in with valid credentials',
      '- Invalid credentials show an error message',
      '- Session expires after 30 minutes',
    ].join('\n');
    expect(extractAcceptanceCriteria(text)).toEqual([
      'User can log in with valid credentials',
      'Invalid credentials show an error message',
      'Session expires after 30 minutes',
    ]);
  });

  it('extracts items under "AC:" heading (short form)', () => {
    const text = ['AC:', '- Item one', '- Item two'].join('\n');
    expect(extractAcceptanceCriteria(text)).toEqual(['Item one', 'Item two']);
  });

  it('extracts numbered-list AC items', () => {
    const text = ['## Acceptance Criteria', '1. First criterion', '2. Second criterion'].join('\n');
    expect(extractAcceptanceCriteria(text)).toEqual(['First criterion', 'Second criterion']);
  });

  it('stops at the next heading section', () => {
    const text = [
      '## Acceptance Criteria',
      '- AC item one',
      '- AC item two',
      '',
      '## Implementation Notes',
      '- This should NOT be included',
    ].join('\n');
    expect(extractAcceptanceCriteria(text)).toEqual(['AC item one', 'AC item two']);
  });

  it('returns empty when no AC section is found', () => {
    const text = 'This is a description without any acceptance criteria section. Just prose.';
    expect(extractAcceptanceCriteria(text)).toEqual([]);
  });

  it('is case-insensitive for the heading', () => {
    const text = ['acceptance criteria', '- lowercase heading item'].join('\n');
    expect(extractAcceptanceCriteria(text)).toEqual(['lowercase heading item']);
  });
});

// ─── mapJiraIssueToWorkItem — acceptanceCriteria propagation (Slice 4) ────────

describe('mapJiraIssueToWorkItem acceptanceCriteria propagation', () => {
  const FIXTURE_PACKAGES = ['apps/runtime', 'packages/execution'];

  it('populates bootstrapMeta.acceptanceCriteria when description has AC section', () => {
    const issue: JiraAssignedIssue = {
      key: 'ABLP-42',
      summary: 'Feature with AC',
      status: 'In Progress',
      description: '<adf>',
      descriptionText: [
        'Implement the feature.',
        '',
        '## Acceptance Criteria',
        '- The endpoint returns 200 on success',
        '- Invalid input returns 400 with details',
      ].join('\n'),
      labels: [],
      issueType: 'Story',
    };

    const result = mapJiraIssueToWorkItem(issue, 'ABLP-42', {}, FIXTURE_PACKAGES);
    expect(result.bootstrapMeta.acceptanceCriteria).toEqual([
      'The endpoint returns 200 on success',
      'Invalid input returns 400 with details',
    ]);
  });

  it('omits bootstrapMeta.acceptanceCriteria when description has no AC section', () => {
    const issue: JiraAssignedIssue = {
      key: 'ABLP-43',
      summary: 'Feature without AC',
      status: 'In Progress',
      description: '<adf>',
      descriptionText: 'Just a description with no acceptance criteria section.',
      labels: [],
      issueType: 'Task',
    };

    const result = mapJiraIssueToWorkItem(issue, 'ABLP-43', {}, FIXTURE_PACKAGES);
    expect(result.bootstrapMeta.acceptanceCriteria).toBeUndefined();
  });

  it('null issue (fetch failed) produces no acceptanceCriteria', () => {
    const result = mapJiraIssueToWorkItem(
      null,
      'ABLP-99',
      {},
      FIXTURE_PACKAGES,
      undefined,
      'not-found',
    );
    expect(result.bootstrapMeta.acceptanceCriteria).toBeUndefined();
  });
});
