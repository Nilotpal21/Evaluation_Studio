/**
 * End-to-end drift-sync test: runs the real `concerns-audit` pipeline stage
 * against seeded source files and concern YAMLs, then feeds the resulting
 * session findings into `runDriftSync` with a fake JIRA client.
 *
 * Distinct from `drift-sync-command.test.ts` — that suite unit-tests the
 * command with manually constructed Finding objects. This suite exercises
 * the full chain: detector → Finding.source → drift batching → JIRA
 * adapter → session ledger → finding.jiraKey backfill. It catches wiring
 * breaks between the audit stage and the sync command that unit tests
 * cannot (e.g., Finding.source not populated, detector id missing, path
 * → packageName mapping drifting).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeDriftKey,
  driftKeyLabel,
  type DriftCreateTicketParams,
  type DriftJiraClient,
  type DriftUpdateTicketParams,
  type JiraIssueSummary,
} from '../integrations/drift-jira-adapter.js';
import { runDriftSync, type DriftSyncIo } from '../integrations/drift-sync-command.js';
import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import { driftAuditPipeline } from '../pipeline/templates/index.js';
import { SessionManager } from '../session/session-manager.js';
import type { HelixConfig, ProgressEvent, ProgressReporter, WorkItem } from '../types.js';

const BLOCKING_CONCERN = `
id: e2e-drift
title: E2E Drift
enforcement: blocking
severity_default: high
rubric_concern: 7
scope:
  globs:
    - src/**/*.ts
detectors:
  - id: marker-leak
    kind: grep
    severity: high
    pattern: 'E2E_MARKER'
    message: 'e2e marker leaked'
    fix_hint: 'remove marker'
`;

// ─── Fakes (reused shape from drift-sync-command.test.ts) ────────────────

class FakeJiraClient implements DriftJiraClient {
  readonly creates: DriftCreateTicketParams[] = [];
  readonly updates: Array<{ key: string; params: DriftUpdateTicketParams }> = [];
  private readonly byLabel = new Map<string, JiraIssueSummary[]>();
  createCounter = 0;

  prime(label: string, issues: JiraIssueSummary[]): void {
    this.byLabel.set(label, issues);
  }
  async searchByLabel(label: string): Promise<JiraIssueSummary[]> {
    return this.byLabel.get(label) ?? [];
  }
  async createTicket(params: DriftCreateTicketParams): Promise<JiraIssueSummary> {
    this.creates.push(params);
    this.createCounter += 1;
    return {
      key: `ABLP-${2000 + this.createCounter}`,
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
  promptReply = 'y';
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
  async promptYesNo(): Promise<string> {
    return this.promptReply;
  }
  now(): Date {
    return new Date(this.clock.getTime());
  }
}

// ─── Fixture helpers (mirrors drift-audit.test.ts) ───────────────────────

async function seedFile(rootDir: string, relPath: string, body: string): Promise<void> {
  const abs = join(rootDir, relPath);
  const lastSep = abs.lastIndexOf('/');
  if (lastSep > 0) {
    await mkdir(abs.slice(0, lastSep), { recursive: true });
  }
  await writeFile(abs, body, 'utf8');
}

async function seedConcern(
  rootDir: string,
  tier: 'enforced' | 'advisory',
  filename: string,
  body: string,
): Promise<void> {
  const dir = join(rootDir, '.helix/concerns', tier);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body, 'utf8');
}

function createConfig(workDir: string): HelixConfig {
  return {
    workDir,
    invocationDir: workDir,
    sessionDir: join(workDir, '.helix', 'sessions'),
    journalDir: join(workDir, '.helix', 'journal'),
    defaultModel: { engine: 'codex-cli', model: 'gpt-5.5' },
    codexPath: 'codex',
    claudePath: 'claude',
    maxConcurrentOracles: 1,
    maxSliceRetries: 1,
    autoCommit: false,
    autoApprove: true,
    budgetLimitUsd: 25,
    verbose: false,
  };
}

function createReporter(): ProgressReporter {
  const events: ProgressEvent[] = [];
  return {
    emit(event: ProgressEvent): void {
      events.push(event);
    },
    async onQuestion(): Promise<string> {
      return 'no';
    },
    async onCheckpoint(): Promise<boolean> {
      return true;
    },
  };
}

function createDriftWorkItem(idSuffix: string): WorkItem {
  return {
    id: `e2e-work-${idSuffix}`,
    type: 'drift-audit',
    title: 'E2E drift audit',
    description: 'integration',
    scope: ['src'],
    targetBranch: 'current',
    createdAt: '2026-04-18T00:00:00.000Z',
  };
}

async function runAudit(
  config: HelixConfig,
  idSuffix: string,
): Promise<{ sessionManager: SessionManager; sessionId: string }> {
  const sessionManager = new SessionManager(config);
  const engine = new PipelineEngine(config, createReporter());
  const seeded = await sessionManager.create(createDriftWorkItem(idSuffix), driftAuditPipeline);
  const afterAudit = await engine.run(seeded, driftAuditPipeline);
  return { sessionManager, sessionId: afterAudit.id };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('drift-sync E2E: concerns-audit → JIRA dispatch', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-drift-sync-e2e-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('preview reflects findings produced by the real concerns-audit pipeline', async () => {
    await seedConcern(tempDir, 'enforced', 'e2e-drift.yaml', BLOCKING_CONCERN);
    await seedFile(tempDir, 'src/a.ts', 'export const boom = "E2E_MARKER";\n');

    const config = createConfig(tempDir);
    const { sessionManager, sessionId } = await runAudit(config, 'preview');

    const reloaded = await sessionManager.load(sessionId);
    expect(reloaded.findings.length).toBeGreaterThanOrEqual(1);
    expect(reloaded.findings[0].source).toEqual({
      concernId: 'e2e-drift',
      concernTitle: 'E2E Drift',
      detectorId: 'marker-leak',
    });

    const io = new FakeIo();
    const jira = new FakeJiraClient();
    const { reason, result } = await runDriftSync({
      sessionManager,
      jira,
      io,
      options: { sessionId, projectKey: 'ABLP', autoApprove: false, dryRun: true },
    });

    expect(reason).toBe('dry-run');
    expect(jira.creates).toHaveLength(0);
    expect(result.preview.length).toBeGreaterThanOrEqual(1);
    const [row] = result.preview;
    expect(row.action).toBe('create');
    expect(row.batch.concernId).toBe('e2e-drift');
    expect(row.batch.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('full cycle: audit → sync → ledger persisted → finding.jiraKey backfilled', async () => {
    await seedConcern(tempDir, 'enforced', 'e2e-drift.yaml', BLOCKING_CONCERN);
    await seedFile(tempDir, 'src/full.ts', 'export const x = "E2E_MARKER";\n');

    const config = createConfig(tempDir);
    const { sessionManager, sessionId } = await runAudit(config, 'full');

    const preSync = await sessionManager.load(sessionId);
    const findingId = preSync.findings[0].id;

    const io = new FakeIo();
    const jira = new FakeJiraClient();
    const { reason, result } = await runDriftSync({
      sessionManager,
      jira,
      io,
      options: { sessionId, projectKey: 'ABLP', autoApprove: true, dryRun: false },
    });

    expect(reason).toBe('applied');
    expect(result.createdCount).toBe(1);
    expect(jira.creates).toHaveLength(1);
    expect(jira.creates[0].labels).toContain('helix-drift');
    expect(jira.creates[0].labels).toContain('concern-e2e-drift');

    const postSync = await sessionManager.load(sessionId);
    expect(postSync.jiraTickets).toHaveLength(1);
    const [ledger] = postSync.jiraTickets!;
    expect(ledger.action).toBe('created');
    expect(ledger.concernId).toBe('e2e-drift');
    expect(ledger.findingIds).toContain(findingId);
    expect(ledger.ticketKey).toMatch(/^ABLP-\d+$/);
    expect(ledger.syncedAt).toBe('2026-04-18T12:00:00.000Z');

    expect(postSync.findings.find((f) => f.id === findingId)?.jiraKey).toBe(ledger.ticketKey);
  });

  it('rerun is idempotent end-to-end: second sync updates, does not duplicate create', async () => {
    await seedConcern(tempDir, 'enforced', 'e2e-drift.yaml', BLOCKING_CONCERN);
    await seedFile(tempDir, 'src/idem.ts', 'export const x = "E2E_MARKER";\n');

    const config = createConfig(tempDir);
    const jira = new FakeJiraClient();

    // First run: audit → sync creates ticket
    const first = await runAudit(config, 'first');
    const firstSync = await runDriftSync({
      sessionManager: first.sessionManager,
      jira,
      io: new FakeIo(),
      options: {
        sessionId: first.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });
    expect(firstSync.reason).toBe('applied');
    expect(firstSync.result.createdCount).toBe(1);
    const createdKey = jira.creates.length === 1 ? `ABLP-${2000 + jira.createCounter}` : '';
    expect(createdKey).toBeTruthy();

    // Prime the drift label so the second sync sees the open ticket and
    // classifies it as UPDATE rather than creating a duplicate.
    const label = driftKeyLabel(computeDriftKey('root', 'e2e-drift'));
    jira.prime(label, [{ key: createdKey, summary: 'Prior', status: 'To Do', labels: [label] }]);

    // Second run: fresh session, same fixture → same finding ids
    const second = await runAudit(config, 'second');
    const secondSync = await runDriftSync({
      sessionManager: second.sessionManager,
      jira,
      io: new FakeIo(),
      options: {
        sessionId: second.sessionId,
        projectKey: 'ABLP',
        autoApprove: true,
        dryRun: false,
      },
    });

    expect(secondSync.reason).toBe('applied');
    expect(secondSync.result.createdCount).toBe(0);
    expect(secondSync.result.updatedCount).toBe(1);
    expect(jira.creates).toHaveLength(1); // no duplicate create across reruns
    expect(jira.updates).toHaveLength(1);
    expect(jira.updates[0].key).toBe(createdKey);

    // Second session's ledger records the update
    const secondReloaded = await second.sessionManager.load(second.sessionId);
    expect(secondReloaded.jiraTickets).toHaveLength(1);
    expect(secondReloaded.jiraTickets![0].action).toBe('updated');
    expect(secondReloaded.jiraTickets![0].ticketKey).toBe(createdKey);
  });
});
