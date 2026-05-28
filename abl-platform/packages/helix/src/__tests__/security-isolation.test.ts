/**
 * Security & isolation tests for the work-item bootstrap path. Phase 1 covers
 * SEC-6 only; Phase 2 will add SEC-1, SEC-2, SEC-5.
 *
 * SEC-6 — secret-logging guard: the Jira API token from the environment
 * MUST never appear in stderr produced by the bootstrap helper or the CLI.
 *
 * Implementation note: this is a focused subprocess assertion. We set a
 * recognizable token, spawn the CLI against the in-process Jira fake, and
 * grep the captured stderr for any occurrence of the token. The CLI's
 * jira-client uses the token only to build the Authorization header — it
 * should never round-trip to logs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { adfFromText, startJiraFake, type JiraFake } from './fixtures/jira-fake.js';

const HELIX_ROOT = resolve(__dirname, '..', '..');
const CLI_ENTRY = resolve(HELIX_ROOT, 'src', 'cli.ts');
const REPO_ROOT = resolve(HELIX_ROOT, '..', '..');
const TSX_BIN = resolve(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const SECRET_TOKEN = 'helix-secret-token-9KJaQ7vRm5p2eXz4F8T0hG3wB1nL6sCdYuIo';

async function runHelix(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
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

  const exit = new Promise<void>((res) => child.once('exit', () => res()));
  // Give the CLI ~6 seconds to do its bootstrap pass before SIGINT'ing.
  await new Promise((r) => setTimeout(r, 6_000));
  if (child.exitCode === null) child.kill('SIGINT');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 2_000);
  await exit;

  return { stdout, stderr };
}

async function seedFixtureWorkspace(workDir: string): Promise<void> {
  await writeFile(
    join(workDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n  - 'apps/*'\n",
    'utf-8',
  );
  for (const dir of ['apps/runtime', 'packages/database']) {
    const target = join(workDir, dir);
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, 'package.json'),
      JSON.stringify({ name: `@fixture/${dir.split('/').pop()}`, version: '0.0.0' }),
      'utf-8',
    );
  }
}

describe('Security isolation', () => {
  let fake: JiraFake;
  let workDir: string;

  beforeAll(async () => {
    fake = await startJiraFake();
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'helix-sec-'));
    await seedFixtureWorkspace(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    'SEC-6: Jira API token never appears in stderr produced by the CLI',
    { timeout: 60_000 },
    async () => {
      fake.setIssueResponse('ABLP-9999', {
        status: 200,
        payload: {
          key: 'ABLP-9999',
          summary: 'SEC-6 sentinel',
          description: adfFromText('Touches apps/runtime.'),
        },
      });

      const { stdout, stderr } = await runHelix(['audit', 'ABLP-9999'], workDir, {
        JIRA_BASE_URL: fake.urlBase,
        JIRA_EMAIL: 'sec-test@example.com',
        JIRA_API_TOKEN: SECRET_TOKEN,
      });

      // Load-bearing assertion: token never logged anywhere.
      expect(stderr).not.toContain(SECRET_TOKEN);
      expect(stdout).not.toContain(SECRET_TOKEN);

      // Sanity: the bootstrap line WAS produced (otherwise we're testing
      // nothing).
      expect(stderr).toMatch(/\[helix:jira\] fetched ABLP-9999/);
    },
  );
});
