import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConcernsAudit } from '../concerns/audit.js';
import { HelixControlPlaneService } from '../mcp/control-plane-service.js';
import { PipelineEngine } from '../pipeline/pipeline-engine.js';
import { driftAuditPipeline, selectPipeline } from '../pipeline/templates/index.js';
import { SessionManager } from '../session/session-manager.js';
import type { HelixConfig, ProgressEvent, ProgressReporter, Session, WorkItem } from '../types.js';

const BLOCKING_CONCERN = `
id: drift-test-blocking
title: Drift Test Blocking
enforcement: blocking
severity_default: high
rubric_concern: 7
scope:
  globs:
    - src/**/*.ts
detectors:
  - id: bad-pattern
    kind: grep
    severity: high
    pattern: 'DRIFT_MARKER'
    message: 'marker literal leaked into source'
    fix_hint: 'remove the marker'
`;

const ADVISORY_CONCERN = `
id: drift-test-advisory
title: Drift Test Advisory
enforcement: advisory
severity_default: low
rubric_concern: 7
scope:
  globs:
    - src/**/*.ts
detectors:
  - id: soft-pattern
    kind: grep
    severity: low
    pattern: 'SOFT_MARKER'
    message: 'soft marker present'
`;

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

function createDriftWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'drift-1',
    type: 'drift-audit',
    title: 'Drift audit integration',
    description: 'integration test',
    scope: ['src'],
    targetBranch: 'current',
    createdAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('drift-audit pipeline end-to-end', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-drift-audit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fixture sanity — runConcernsAudit alone produces expected findings', async () => {
    await seedConcern(tempDir, 'enforced', 'drift-test-blocking.yaml', BLOCKING_CONCERN);
    await seedFile(
      tempDir,
      'src/one.ts',
      ['export const banner = "hello";', 'export const leak = "DRIFT_MARKER";', ''].join('\n'),
    );
    const result = await runConcernsAudit({ repoRoot: tempDir, write: false });
    if (result.loadErrors.length > 0) {
      throw new Error(
        `load errors: ${result.loadErrors.map((e) => `${e.sourcePath}: ${e.message}`).join(' | ')}`,
      );
    }
    expect({
      findings: result.summary.findings,
      blocking: result.summary.blockingFindings,
      concernsScanned: result.summary.concernsScanned,
    }).toEqual({ findings: 1, blocking: 1, concernsScanned: 1 });
  });

  it('lands blocking findings on the session and marks the stage failed', async () => {
    await seedConcern(tempDir, 'enforced', 'drift-test-blocking.yaml', BLOCKING_CONCERN);
    await seedFile(
      tempDir,
      'src/one.ts',
      ['export const banner = "hello";', 'export const leak = "DRIFT_MARKER";', ''].join('\n'),
    );

    const config = createConfig(tempDir);
    const engine = new PipelineEngine(config, createReporter());
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createDriftWorkItem(), driftAuditPipeline);

    const result: Session = await engine.run(session, driftAuditPipeline);

    expect(result.stageHistory).toHaveLength(1);
    const [stage] = result.stageHistory;
    expect(stage.stageName).toBe('Concerns Audit');
    expect(stage.stageType).toBe('concerns-audit');
    expect(stage.status).toBe('failed');
    expect(stage.error).toContain('blocking finding');
    expect(stage.output).toContain('concerns-audit summary');

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const [finding] = result.findings;
    expect(finding.title).toBe('Drift Test Blocking: bad-pattern');
    expect(finding.severity).toBe('high');
    expect(finding.status).toBe('open');
    expect(finding.category).toBe('concern-drift');
    expect(finding.files).toHaveLength(1);
    expect(finding.files[0].path).toBe('src/one.ts');
    expect(finding.files[0].lines).toEqual([2, 2]);
    expect(finding.suggestedFix).toBe('remove the marker');
    expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
    expect(finding.source).toEqual({
      concernId: 'drift-test-blocking',
      concernTitle: 'Drift Test Blocking',
      detectorId: 'bad-pattern',
    });

    expect(result.journal.some((entry) => entry.type === 'stage-complete')).toBe(true);
  });

  it('keeps the stage passed when only advisory findings are produced', async () => {
    await seedConcern(tempDir, 'advisory', 'drift-test-advisory.yaml', ADVISORY_CONCERN);
    await seedFile(
      tempDir,
      'src/two.ts',
      ['export const banner = "hi";', 'export const note = "SOFT_MARKER";', ''].join('\n'),
    );

    const config = createConfig(tempDir);
    const engine = new PipelineEngine(config, createReporter());
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createDriftWorkItem(), driftAuditPipeline);

    const result: Session = await engine.run(session, driftAuditPipeline);

    expect(result.stageHistory).toHaveLength(1);
    expect(result.stageHistory[0].status).toBe('passed');
    expect(result.stageHistory[0].error).toBeUndefined();
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0].severity).toBe('low');
  });

  it('passes cleanly when the concerns registry is empty', async () => {
    await mkdir(join(tempDir, '.helix/concerns/enforced'), { recursive: true });
    await mkdir(join(tempDir, '.helix/concerns/advisory'), { recursive: true });
    await seedFile(tempDir, 'src/empty.ts', 'export const x = 1;\n');

    const config = createConfig(tempDir);
    const engine = new PipelineEngine(config, createReporter());
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createDriftWorkItem(), driftAuditPipeline);

    const result: Session = await engine.run(session, driftAuditPipeline);

    expect(result.stageHistory[0].status).toBe('passed');
    expect(result.findings).toHaveLength(0);
  });

  it('produces stable finding ids across reruns on the same fixture', async () => {
    await seedConcern(tempDir, 'enforced', 'drift-test-blocking.yaml', BLOCKING_CONCERN);
    await seedFile(
      tempDir,
      'src/stable.ts',
      ['export const a = "DRIFT_MARKER";', 'export const b = "DRIFT_MARKER";', ''].join('\n'),
    );

    const config = createConfig(tempDir);

    const run = async (): Promise<Session> => {
      const engine = new PipelineEngine(config, createReporter());
      const sessionManager = new SessionManager(config);
      const session = await sessionManager.create(createDriftWorkItem(), driftAuditPipeline);
      return engine.run(session, driftAuditPipeline);
    };

    const first = await run();
    const second = await run();

    const firstIds = first.findings.map((f) => f.id).sort();
    const secondIds = second.findings.map((f) => f.id).sort();
    expect(firstIds).toEqual(secondIds);
    expect(firstIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('drift-audit findings surface via MCP search_findings', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'helix-drift-mcp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('makes drift-audit findings discoverable through the control-plane search', async () => {
    await seedConcern(tempDir, 'enforced', 'drift-test-blocking.yaml', BLOCKING_CONCERN);
    await seedFile(tempDir, 'src/mcp.ts', ['export const marker = "DRIFT_MARKER";', ''].join('\n'));

    const config = createConfig(tempDir);
    const engine = new PipelineEngine(config, createReporter());
    const sessionManager = new SessionManager(config);
    const session = await sessionManager.create(createDriftWorkItem(), driftAuditPipeline);
    const result = await engine.run(session, driftAuditPipeline);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);

    const service = new HelixControlPlaneService({ workDir: tempDir });
    const matches = await service.searchFindings('bad-pattern', result.id);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]).toMatchObject({
      sessionId: result.id,
      findingId: result.findings[0].id,
      title: 'Drift Test Blocking: bad-pattern',
      severity: 'high',
      status: 'open',
      files: ['src/mcp.ts'],
    });
  });
});

describe('drift-audit template registration', () => {
  it('routes drift-audit work items to the Drift Audit pipeline', () => {
    const pipeline = selectPipeline('drift-audit');
    expect(pipeline.name).toBe('Drift Audit');
    expect(pipeline.stages).toHaveLength(1);
    expect(pipeline.stages[0].type).toBe('concerns-audit');
    expect(pipeline.applicableTo).toEqual(['drift-audit']);
  });
});
