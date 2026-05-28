/**
 * Subprocess E2E tests for `helix audit ABLP-XX` and friends.
 *
 * Each test spawns the real Helix CLI as a child process via `pnpm exec tsx`,
 * targets it at the in-process Jira fake (random port), waits for the session
 * to be created on disk, then sends SIGINT to abort the pipeline before any
 * model executor is invoked. The contract under test is bootstrap behavior —
 * which writes `session.json` BEFORE the pipeline stage loop starts.
 *
 * No platform-package mocking, no nock, no fetch global mocking. The Jira
 * boundary is the in-process node:http fake at fixtures/jira-fake.ts.
 *
 * Covers: E2E-1, E2E-2, E2E-5, E2E-6, E2E-7, SEC-3.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  adfFromText,
  applyJiraFakeEnv,
  clearJiraCreds,
  startJiraFake,
  type JiraFake,
} from './fixtures/jira-fake.js';

// Path to the helix package root and its CLI entry.
const HELIX_ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = resolve(HELIX_ROOT, 'src', 'cli.ts');
// Resolve `tsx` via the monorepo root .bin so the subprocess can run from a
// tempdir cwd without `pnpm`'s workspace resolution failing.
const REPO_ROOT = resolve(HELIX_ROOT, '..', '..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const TEST_TIMEOUT_MS = 60_000;
const SESSION_POLL_TIMEOUT_MS = 30_000;
const SESSION_POLL_INTERVAL_MS = 100;

interface SubprocessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  sessionId: string | null;
  sessionJson: SessionJsonShape | null;
}

interface SessionJsonShape {
  id: string;
  workItem: {
    title: string;
    description: string;
    scope: string[];
    jiraKey?: string;
  };
  bootstrapMeta?: {
    jiraKey?: string;
    jiraFetchSuccess: boolean;
    jiraFetchLatencyMs?: number;
    scopeInferenceMethod: 'deterministic' | 'explicit' | 'empty';
    inferredScope: string[];
    fallbackReason?: string;
  };
}

/**
 * Spawn `helix audit/fix/...` as a subprocess against the temp work dir.
 * Polls for the session.json file to appear (which means SessionManager.create
 * finished and persisted), then SIGINTs the process. Returns the captured
 * session shape + exit details.
 */
async function spawnAndSnapshot(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SubprocessResult> {
  const cliArgs = args.some((arg) => arg === '--in-place' || arg.startsWith('--worktree'))
    ? args
    : [...args, '--in-place'];
  const child: ChildProcessWithoutNullStreams = spawn(TSX_BIN, [CLI_ENTRY, ...cliArgs], {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );

  // Poll for session.json to appear. The sessions live under
  // `<workDir>/.helix/sessions/<id>/session.json`.
  const sessionsRoot = join(cwd, '.helix', 'sessions');
  let foundSession: { id: string; payload: SessionJsonShape } | null = null;
  const deadline = Date.now() + SESSION_POLL_TIMEOUT_MS;
  while (Date.now() < deadline && foundSession === null && child.exitCode === null) {
    foundSession = await tryReadFreshestSession(sessionsRoot);
    if (foundSession) break;
    await sleep(SESSION_POLL_INTERVAL_MS);
  }

  // Whether or not we captured a session, ask the process to exit.
  if (child.exitCode === null) {
    child.kill('SIGINT');
    // Give it a moment to flush, then SIGKILL.
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2_000);
  }

  const { exitCode, signal } = await exitPromise;

  return {
    exitCode,
    signal,
    stdout,
    stderr,
    sessionId: foundSession?.id ?? null,
    sessionJson: foundSession?.payload ?? null,
  };
}

async function tryReadFreshestSession(
  sessionsRoot: string,
): Promise<{ id: string; payload: SessionJsonShape } | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return null;
  }

  let freshest: { id: string; mtime: number; payload: SessionJsonShape } | null = null;
  for (const entry of entries) {
    const sessionFile = join(sessionsRoot, entry, 'session.json');
    let info;
    try {
      info = await stat(sessionFile);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    let parsed: SessionJsonShape;
    try {
      const raw = await readFile(sessionFile, 'utf-8');
      parsed = JSON.parse(raw) as SessionJsonShape;
    } catch {
      continue;
    }
    if (freshest === null || info.mtimeMs > freshest.mtime) {
      freshest = { id: entry, mtime: info.mtimeMs, payload: parsed };
    }
  }
  return freshest ? { id: freshest.id, payload: freshest.payload } : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirror the fixture workspace into the test's temp working directory. */
async function seedFixtureWorkspace(workDir: string): Promise<void> {
  // pnpm-workspace.yaml
  await writeFile(
    join(workDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
    'utf-8',
  );
  for (const dir of [
    'apps/runtime',
    'apps/admin',
    'apps/studio',
    'packages/database',
    'packages/execution',
    'packages/compiler',
  ]) {
    const target = join(workDir, dir);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ name: `@fixture/${dir.split('/').pop()}`, version: '0.0.0' }),
      'utf-8',
    );
  }
}

// ─── Test Suite ──────────────────────────────────────────────────

describe('CLI bootstrap E2E (subprocess)', () => {
  let fake: JiraFake;
  let workDir: string;

  beforeAll(async () => {
    fake = await startJiraFake();
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-e2e-bootstrap-'));
    await seedFixtureWorkspace(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // ─── E2E-1: bare Jira-key invocation ──────────────────────────

  it(
    'E2E-1: bare Jira-key invocation produces a complete session',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      fake.setIssueResponse('ABLP-9001', {
        status: 200,
        payload: {
          key: 'ABLP-9001',
          summary: 'Audit runtime session lifecycle',
          description: adfFromText(
            'Audit apps/runtime/src/sessions and packages/execution for races.',
          ),
        },
      });

      const restore = applyJiraFakeEnv(fake.urlBase);
      try {
        const result = await spawnAndSnapshot(['audit', 'ABLP-9001'], workDir, {});

        expect(result.sessionJson).not.toBeNull();
        const session = result.sessionJson!;

        expect(session.workItem.title).toBe('Audit runtime session lifecycle');
        expect(session.workItem.jiraKey).toBe('ABLP-9001');
        expect(session.workItem.scope).toContain('apps/runtime');
        expect(session.workItem.scope).toContain('packages/execution');

        expect(session.bootstrapMeta).toBeDefined();
        expect(session.bootstrapMeta!.jiraFetchSuccess).toBe(true);
        expect(session.bootstrapMeta!.scopeInferenceMethod).toBe('deterministic');
        expect(session.bootstrapMeta!.inferredScope).toEqual([
          'apps/runtime',
          'packages/execution',
        ]);
        expect(session.bootstrapMeta!.jiraFetchLatencyMs).toBeGreaterThanOrEqual(0);

        expect(result.stderr).toMatch(/\[helix:jira\] fetched ABLP-9001/);
      } finally {
        restore();
      }
    },
  );

  // ─── E2E-2: Jira unreachable falls back gracefully ────────────

  it(
    'E2E-2: Jira unreachable falls back to key-as-title',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const restore = clearJiraCreds();
      try {
        const result = await spawnAndSnapshot(['audit', 'ABLP-9001'], workDir, {});

        expect(result.sessionJson).not.toBeNull();
        const session = result.sessionJson!;

        expect(session.workItem.title).toBe('ABLP-9001');
        expect(session.workItem.description).toBe('ABLP-9001');
        expect(session.workItem.scope).toEqual([]);

        expect(session.bootstrapMeta!.jiraFetchSuccess).toBe(false);
        expect(['credentials-missing', 'auth-failed', 'not-found', 'network-error']).toContain(
          session.bootstrapMeta!.fallbackReason,
        );

        expect(result.stderr).toMatch(/\[helix:jira\] ABLP-9001/);
      } finally {
        restore();
      }
    },
  );

  // ─── E2E-5: helix resume preserves snapshot ───────────────────

  it(
    'E2E-5: resume does not re-fetch Jira; WorkItem snapshot preserved',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      fake.setIssueResponse('ABLP-9003', {
        status: 200,
        payload: {
          key: 'ABLP-9003',
          summary: 'Original summary',
          description: adfFromText('Touches apps/runtime.'),
        },
      });
      const restore = applyJiraFakeEnv(fake.urlBase);
      try {
        const initial = await spawnAndSnapshot(['audit', 'ABLP-9003'], workDir, {});
        expect(initial.sessionJson).not.toBeNull();
        const sessionId = initial.sessionId!;
        const originalTitle = initial.sessionJson!.workItem.title;
        expect(originalTitle).toBe('Original summary');
        const originalRequestCount = fake.requestCount();

        // Mutate the fake to a different summary; resume MUST NOT pick it up.
        fake.setIssueResponse('ABLP-9003', {
          status: 200,
          payload: {
            key: 'ABLP-9003',
            summary: 'Mutated summary',
            description: adfFromText('Touches apps/admin.'),
          },
        });

        const resumed = await spawnAndSnapshot(['resume', sessionId], workDir, {});
        expect(resumed.sessionJson).not.toBeNull();
        expect(resumed.sessionJson!.workItem.title).toBe(originalTitle);

        // Resume should NOT have made any new Jira requests for this key.
        // (other test keys may still have pending state; we assert no growth.)
        expect(fake.requestCount()).toBe(originalRequestCount);
        expect(resumed.stderr).not.toMatch(/\[helix:jira\] fetched ABLP-9003/);
      } finally {
        restore();
      }
    },
  );

  // ─── E2E-6: CLI title precedence ──────────────────────────────

  it(
    'E2E-6: CLI title via positional wins; --jira flag still bootstraps Jira fields',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      fake.setIssueResponse('ABLP-9004', {
        status: 200,
        payload: {
          key: 'ABLP-9004',
          summary: 'Jira summary',
          description: adfFromText('Touches apps/admin.'),
        },
      });
      const restore = applyJiraFakeEnv(fake.urlBase);
      try {
        const result = await spawnAndSnapshot(
          ['audit', 'Manual title from CLI', '--jira', 'ABLP-9004'],
          workDir,
          {},
        );

        expect(result.sessionJson).not.toBeNull();
        const session = result.sessionJson!;
        expect(session.workItem.title).toBe('Manual title from CLI');
        expect(session.workItem.description).toBe('Touches apps/admin.');
        expect(session.workItem.jiraKey).toBe('ABLP-9004');
        expect(session.bootstrapMeta!.jiraFetchSuccess).toBe(true);
      } finally {
        restore();
      }
    },
  );

  // ─── E2E-7: --scope override ──────────────────────────────────

  it(
    'E2E-7: --scope override locks inferredScope to [] and method to "explicit"',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      fake.setIssueResponse('ABLP-9005', {
        status: 200,
        payload: {
          key: 'ABLP-9005',
          summary: 'Should be inferred but overridden',
          description: adfFromText('Mentions apps/runtime and packages/execution.'),
        },
      });
      const restore = applyJiraFakeEnv(fake.urlBase);
      try {
        const result = await spawnAndSnapshot(
          ['audit', 'ABLP-9005', '--scope', 'apps/admin,apps/studio'],
          workDir,
          {},
        );

        expect(result.sessionJson).not.toBeNull();
        const session = result.sessionJson!;
        expect(session.workItem.scope).toEqual(['apps/admin', 'apps/studio']);
        expect(session.bootstrapMeta!.scopeInferenceMethod).toBe('explicit');
        expect(session.bootstrapMeta!.inferredScope).toEqual([]);
      } finally {
        restore();
      }
    },
  );

  // ─── SEC-3: path-traversal in Jira description ────────────────

  it(
    'SEC-3: path-traversal tokens in Jira description never appear in scope',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      fake.setIssueResponse('ABLP-9091', {
        status: 200,
        payload: {
          key: 'ABLP-9091',
          summary: 'Adversarial scope',
          description: adfFromText(
            'Audit ../../../etc/passwd and ../../node_modules but also ./apps/runtime/src/sessions.',
          ),
        },
      });
      const restore = applyJiraFakeEnv(fake.urlBase);
      try {
        const result = await spawnAndSnapshot(['audit', 'ABLP-9091'], workDir, {});

        expect(result.sessionJson).not.toBeNull();
        const session = result.sessionJson!;
        // The load-bearing security assertion: path-traversal tokens NEVER
        // appear in scope/inferredScope. The original Jira description text
        // is preserved verbatim in workItem.description (input prose is not
        // sanitized — only scope inference rejects traversal).
        expect(session.workItem.scope).toEqual(['apps/runtime']);
        expect(session.bootstrapMeta!.inferredScope).toEqual(['apps/runtime']);

        for (const entry of session.workItem.scope) {
          expect(entry).not.toMatch(/\.\./);
          expect(entry.startsWith('/')).toBe(false);
        }
        for (const entry of session.bootstrapMeta!.inferredScope) {
          expect(entry).not.toMatch(/\.\./);
        }
      } finally {
        restore();
      }
    },
  );
});
