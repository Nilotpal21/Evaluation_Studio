import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  DriftCreateTicketParams,
  DriftJiraClient,
  DriftUpdateTicketParams,
  JiraIssueSummary,
} from '../integrations/drift-jira-adapter.js';
import { runDriftSync, type DriftSyncIo } from '../integrations/drift-sync-command.js';
import { SessionManager } from '../session/session-manager.js';
import type { Finding, HelixConfig, Session } from '../types.js';

// ─── Test doubles ─────────────────────────────────────────────────────────

class FakeJiraClient implements DriftJiraClient {
  readonly searches: Array<{ label: string; projectKey?: string }> = [];
  readonly creates: DriftCreateTicketParams[] = [];
  readonly updates: Array<{ key: string; params: DriftUpdateTicketParams }> = [];
  readonly byLabel = new Map<string, JiraIssueSummary[]>();
  createCounter = 0;
  createShouldFail = false;

  prime(label: string, issues: JiraIssueSummary[]): void {
    this.byLabel.set(label, issues);
  }

  async searchByLabel(label: string, projectKey?: string): Promise<JiraIssueSummary[]> {
    this.searches.push({ label, projectKey });
    return this.byLabel.get(label) ?? [];
  }

  async createTicket(params: DriftCreateTicketParams): Promise<JiraIssueSummary> {
    if (this.createShouldFail) {
      throw new Error('JIRA create ticket failed: boom');
    }
    this.creates.push(params);
    this.createCounter += 1;
    return {
      key: `ABLP-${1000 + this.createCounter}`,
      summary: params.summary,
      status: 'To Do',
      labels: [...params.labels],
    };
  }

  async updateTicket(key: string, params: DriftUpdateTicketParams): Promise<void> {
    this.updates.push({ key, params });
  }
}

class FakeIo implements DriftSyncIo {
  readonly outLines: string[] = [];
  readonly errLines: string[] = [];
  readonly prompts: string[] = [];
  promptReply = 'n';
  private readonly clock: Date;

  constructor(clock: Date = new Date('2026-04-18T12:00:00Z')) {
    this.clock = clock;
  }

  out(line: string): void {
    this.outLines.push(line);
  }
  err(line: string): void {
    this.errLines.push(line);
  }
  async promptYesNo(question: string): Promise<string> {
    this.prompts.push(question);
    return this.promptReply;
  }
  now(): Date {
    return new Date(this.clock.getTime());
  }
}

// ─── Session fixtures ─────────────────────────────────────────────────────

function buildFinding(overrides: {
  id: string;
  file: string;
  concernId?: string;
  concernTitle?: string;
}): Finding {
  const concernId = overrides.concernId ?? 'tenant-isolation';
  const concernTitle = overrides.concernTitle ?? 'Tenant Isolation';
  return {
    id: overrides.id,
    category: 'concern-drift',
    severity: 'high',
    status: 'open',
    title: `${concernTitle}: detector`,
    description: 'details',
    files: [{ path: overrides.file, lines: [10, 10] }],
    discoveredBy: 'drift-audit-stage',
    source: { concernId, concernTitle, detectorId: 'det' },
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
  };
}

async function initGitRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'README.md'), '# drift-sync-test\n', 'utf-8');
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'helix@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'HELIX Test'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

function buildConfig(workDir: string): HelixConfig {
  return {
    workDir,
    sessionDir: join(workDir, 'sessions'),
    journalDir: join(workDir, 'journals'),
    defaultModel: { engine: 'codex-cli', model: 'gpt-5.5', effort: 'medium', maxTurns: 20 },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 2,
    maxSliceRetries: 2,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
  };
}

async function makeHarness(findings: Finding[]): Promise<{
  sessionManager: SessionManager;
  sessionId: string;
  loadBack(): Promise<Session>;
  cleanup(): Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'helix-drift-sync-'));
  await initGitRepo(workDir);

  const sessionManager = new SessionManager(buildConfig(workDir));
  const session = await sessionManager.create(
    {
      id: 'work-1',
      type: 'drift-audit',
      title: 'Drift audit: packages/helix',
      description: 'test',
      scope: ['packages/helix'],
      targetBranch: 'current',
      createdAt: '2026-04-18T00:00:00Z',
    },
    {
      name: 'drift-audit',
      version: 1,
      description: 'test',
      stages: [],
      applicableTo: ['drift-audit'],
    } as never,
  );

  session.findings = findings;
  await sessionManager.persist(session);

  return {
    sessionManager,
    sessionId: session.id,
    loadBack: () => sessionManager.load(session.id),
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('runDriftSync', () => {
  let harness: Awaited<ReturnType<typeof makeHarness>> | undefined;

  it('reports "no drift findings" when session has nothing to sync', async () => {
    harness = await makeHarness([]);
    const io = new FakeIo();
    const jira = new FakeJiraClient();
    const { reason, result } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: false,
        dryRun: false,
      },
    });
    expect(reason).toBe('no-drift-findings');
    expect(result.outcomes).toHaveLength(0);
    expect(io.outLines.some((l) => l.includes('No drift-sourced findings'))).toBe(true);
    await harness.cleanup();
  });

  it('prints preview and stops when --dry-run is set', async () => {
    harness = await makeHarness([
      buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' }),
      buildFinding({ id: 'f2', file: 'packages/helix/src/b.ts' }),
    ]);
    const io = new FakeIo();
    const jira = new FakeJiraClient();
    const { reason } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: false,
        dryRun: true,
      },
    });
    expect(reason).toBe('dry-run');
    expect(jira.creates).toHaveLength(0);
    expect(jira.updates).toHaveLength(0);
    expect(io.outLines.some((l) => l.includes('--dry-run'))).toBe(true);
    const reloaded = await harness.loadBack();
    expect(reloaded.jiraTickets ?? []).toHaveLength(0);
    await harness.cleanup();
  });

  it('aborts cleanly if the user declines the prompt', async () => {
    harness = await makeHarness([buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' })]);
    const io = new FakeIo();
    io.promptReply = 'n';
    const jira = new FakeJiraClient();
    const { reason } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: false,
        dryRun: false,
      },
    });
    expect(reason).toBe('user-aborted');
    expect(jira.creates).toHaveLength(0);
    expect(io.prompts).toHaveLength(1);
    const reloaded = await harness.loadBack();
    expect(reloaded.jiraTickets ?? []).toHaveLength(0);
    await harness.cleanup();
  });

  it('applies create + update and persists ledger entries on --auto-approve', async () => {
    harness = await makeHarness([
      buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' }), // CREATE path
      buildFinding({
        id: 'f2',
        file: 'apps/runtime/src/x.ts',
        concernId: 'centralized-auth',
        concernTitle: 'Centralized Auth',
      }), // UPDATE path
    ]);

    const io = new FakeIo(new Date('2026-04-18T12:00:00Z'));
    const jira = new FakeJiraClient();
    // Prime an open ticket for the runtime/centralized-auth batch by
    // computing the drift label the adapter will search for.
    const { computeDriftKey, driftKeyLabel } =
      await import('../integrations/drift-jira-adapter.js');
    const runtimeLabel = driftKeyLabel(computeDriftKey('apps/runtime', 'centralized-auth'));
    jira.prime(runtimeLabel, [
      {
        key: 'ABLP-500',
        summary: 'Prior centralized-auth',
        status: 'In Progress',
        labels: [runtimeLabel],
      },
    ]);

    const { reason, result } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });

    expect(reason).toBe('applied');
    expect(result.createdCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(jira.creates).toHaveLength(1);
    expect(jira.updates).toHaveLength(1);
    expect(jira.updates[0].key).toBe('ABLP-500');

    const reloaded = await harness.loadBack();
    expect(reloaded.jiraTickets).toHaveLength(2);
    const created = reloaded.jiraTickets!.find((e) => e.action === 'created');
    expect(created?.ticketKey).toBe('ABLP-1001');
    expect(created?.syncedAt).toBe('2026-04-18T12:00:00.000Z');
    const updated = reloaded.jiraTickets!.find((e) => e.action === 'updated');
    expect(updated?.ticketKey).toBe('ABLP-500');

    // Findings got jiraKey backfilled
    expect(reloaded.findings.find((f) => f.id === 'f1')?.jiraKey).toBe('ABLP-1001');
    expect(reloaded.findings.find((f) => f.id === 'f2')?.jiraKey).toBe('ABLP-500');

    await harness.cleanup();
  });

  it('skips batches whose matching ticket is closed (no reopen)', async () => {
    harness = await makeHarness([buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' })]);
    const io = new FakeIo();
    const jira = new FakeJiraClient();
    const { computeDriftKey, driftKeyLabel } =
      await import('../integrations/drift-jira-adapter.js');
    const label = driftKeyLabel(computeDriftKey('packages/helix', 'tenant-isolation'));
    jira.prime(label, [{ key: 'ABLP-9', summary: 'Old', status: 'Done', labels: [label] }]);

    const { reason, result } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });

    expect(reason).toBe('nothing-to-apply');
    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(jira.creates).toHaveLength(0);
    expect(jira.updates).toHaveLength(0);
    const reloaded = await harness.loadBack();
    // skip rows don't produce outcomes in nothing-to-apply path, so ledger
    // remains empty — matches the command's explicit short-circuit.
    expect(reloaded.jiraTickets ?? []).toHaveLength(0);
    expect(reloaded.findings[0].jiraKey).toBeUndefined();

    await harness.cleanup();
  });

  it('is idempotent across reruns: second sync attaches update, not duplicate create', async () => {
    harness = await makeHarness([buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' })]);
    const io1 = new FakeIo();
    const jira = new FakeJiraClient();

    const first = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io: io1,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });
    expect(first.reason).toBe('applied');
    const createdKey = jira.creates.length === 1 ? `ABLP-${1000 + jira.createCounter}` : '';
    expect(createdKey).toBeTruthy();

    // Prime the drift label so the second run classifies as UPDATE.
    const { computeDriftKey, driftKeyLabel } =
      await import('../integrations/drift-jira-adapter.js');
    const label = driftKeyLabel(computeDriftKey('packages/helix', 'tenant-isolation'));
    jira.prime(label, [
      { key: createdKey, summary: 'First ticket', status: 'To Do', labels: [label] },
    ]);

    const io2 = new FakeIo();
    const second = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io: io2,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });

    expect(second.reason).toBe('applied');
    expect(second.result.createdCount).toBe(0);
    expect(second.result.updatedCount).toBe(1);
    expect(jira.creates).toHaveLength(1); // no duplicate create
    expect(jira.updates).toHaveLength(1);

    const reloaded = await harness.loadBack();
    expect(reloaded.jiraTickets).toHaveLength(2);
    expect(reloaded.jiraTickets![0].action).toBe('created');
    expect(reloaded.jiraTickets![1].action).toBe('updated');

    await harness.cleanup();
  });

  it('records no jiraKey on findings when the create call throws', async () => {
    harness = await makeHarness([buildFinding({ id: 'f1', file: 'packages/helix/src/a.ts' })]);
    const io = new FakeIo();
    const jira = new FakeJiraClient();
    jira.createShouldFail = true;

    const { reason, result } = await runDriftSync({
      sessionManager: harness.sessionManager,
      jira,
      io,
      options: {
        sessionId: harness.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });
    expect(reason).toBe('applied');
    expect(result.createdCount).toBe(0);
    expect(io.errLines.some((l) => l.includes('FAILED to create ticket'))).toBe(true);

    const reloaded = await harness.loadBack();
    // Outcome recorded as 'created' with no ticketKey; finding stays unkeyed.
    expect(reloaded.jiraTickets).toHaveLength(1);
    expect(reloaded.jiraTickets![0].action).toBe('created');
    expect(reloaded.jiraTickets![0].ticketKey).toBeUndefined();
    expect(reloaded.findings[0].jiraKey).toBeUndefined();

    await harness.cleanup();
  });
});
